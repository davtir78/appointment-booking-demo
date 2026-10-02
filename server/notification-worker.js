// The Notification Worker (SAD component "Notification worker", ICR-AB-0003, ADR-AB-0006).
//
//   - Booking changes write their messages to the outbox in the same transaction as the change, so
//     a message exists if and only if the booking change does, and the provider's availability can
//     never affect a booking.
//   - Each message is keyed by event id and channel. Replaying an event adds nothing, and the
//     provider is given the same key, so a crash between sending and recording cannot send twice.
//   - A cancellation supersedes anything not yet sent for the booking, so a customer who cancels
//     before the confirmation went out gets a cancellation and no confirmation.
//   - A provider outage is ridden out with exponential backoff for up to 24 hours, then the message
//     goes to the dead-letter state and the booking shows "not delivered". A reminder whose window
//     passed during the outage is dropped, not sent late.
//   - Events are CloudEvents 1.0 envelopes. Message bodies are rendered at send time and never logged.

import { InvalidRecipient, ProviderUnavailable } from './providers/messaging.js';
import { formatSlot } from '../widget/time.js';

const HOUR = 60 * 60 * 1000;
export const REMINDER_LEAD_MS = 24 * HOUR;       // "a reminder the day before"
export const REMINDER_LATEST_MS = 2 * HOUR;      // a reminder less than two hours ahead is not worth sending
export const GIVE_UP_AFTER_MS = 24 * HOUR;       // retry for up to 24 hours, then dead-letter
const BACKOFF_CAP_MS = HOUR;

export const EVENT_TYPES = ['BookingConfirmed', 'BookingRescheduled', 'BookingCancelled', 'ReminderDue'];

/** A CloudEvents 1.0 envelope. */
function cloudEvent({ id, type, bookingId, time, data }) {
  return { specversion: '1.0', id, source: '/booking-service', type: `au.example.booking.${type}`, subject: bookingId, time: new Date(time).toISOString(), datacontenttype: 'application/json', data };
}

function render(eventType, d) {
  const when = formatSlot(d.start, d.timeZone);
  const hello = `Hi ${d.firstName},`;
  switch (eventType) {
    case 'BookingConfirmed': return { subject: `Booked: ${d.serviceName}, ${when}`, body: `${hello} you're booked for ${d.serviceName} with ${d.staffName} on ${when}. Manage your booking: ${d.manageUrl}` };
    case 'BookingRescheduled': return { subject: `Moved: ${d.serviceName}, ${when}`, body: `${hello} your ${d.serviceName} with ${d.staffName} is now ${when}. Manage your booking: ${d.manageUrl}` };
    case 'BookingCancelled': return { subject: `Cancelled: ${d.serviceName}`, body: `${hello} your ${d.serviceName} on ${when} is cancelled.` };
    case 'ReminderDue': return { subject: `Reminder: ${d.serviceName}, ${when}`, body: `${hello} a reminder of your ${d.serviceName} with ${d.staffName} on ${when}. Manage your booking: ${d.manageUrl}` };
    default: throw new Error(`unknown event type ${eventType}`);
  }
}

export function createNotificationWorker({ store, provider, clock, log }) {
  const REF = 'ICR-AB-0003';
  const backoff = (attempts) => Math.min(BACKOFF_CAP_MS, 1000 * 2 ** Math.min(attempts, 20));

  return {
    /**
     * Queue the messages for a booking event. Call inside the booking's transaction.
     * `booking` carries what the templates need; `customer` is who to tell.
     */
    enqueue(businessId, { type, bookingId, eventId, booking, customer, dueAt = clock.now(), windowEnd = null }) {
      const repo = store.scope(businessId);
      const envelope = cloudEvent({ id: eventId, type, bookingId, time: clock.now(), data: { ...booking, firstName: customer.name.trim().split(/\s+/)[0] } });
      const channels = [['email', customer.email], ...(customer.phone ? [['sms', customer.phone]] : [])];
      let added = 0;
      for (const [channel, recipient] of channels) {
        if (repo.outboxAdd({ id: `${eventId}:${channel}`, bookingId, eventId, eventType: type, channel, recipient, payload: envelope, dueAt, windowEnd })) added += 1;
      }
      log.write('notifications', added ? 'queued' : 'replay_ignored', { businessId, bookingId, eventType: type, messages: added }, { ref: 'ADR-AB-0006' });
      return added;
    },

    /** A change to a booking supersedes what has not been sent about it. */
    supersede(businessId, bookingId, types) {
      const n = store.scope(businessId).outboxSupersede(bookingId, types);
      if (n) log.write('notifications', 'superseded', { businessId, bookingId, messages: n }, { ref: `${REF}#interaction` });
      return n;
    },

    /** The worker's loop body: send what is due. */
    tick() {
      const now = clock.now();
      let sent = 0;
      for (const businessId of store.businessIds()) {
        const repo = store.scope(businessId);
        for (const m of repo.outboxDue(now)) {
          if (m.window_end_ms !== null && now >= m.window_end_ms) {
            repo.outboxMark(m.id, { status: 'dropped' });
            log.write('notifications', 'dropped_late', { businessId, bookingId: m.booking_id, eventType: m.event_type, channel: m.channel }, { ref: `${REF}#error-handling` });
            continue;
          }
          try {
            const { subject, body } = render(m.event_type, m.payload.data);
            const result = provider.send({ key: m.id, channel: m.channel, to: m.recipient, subject, body });
            repo.outboxMark(m.id, { status: 'sent', sent_ms: now, attempts: m.attempts + 1 });
            sent += 1;
            log.write('notifications', result.duplicate ? 'already_sent' : 'sent', { businessId, bookingId: m.booking_id, eventType: m.event_type, channel: m.channel }, { ref: `${REF}#error-handling` });
          } catch (e) {
            const attempts = m.attempts + 1;
            if (e instanceof InvalidRecipient) {
              repo.outboxMark(m.id, { status: 'dead', attempts, last_error: 'invalid_recipient' });
              log.write('notifications', 'dead_letter', { businessId, bookingId: m.booking_id, channel: m.channel, reason: 'invalid_recipient' }, { level: 'alert', ref: `${REF}#error-handling` });
            } else if (e instanceof ProviderUnavailable) {
              // Twenty-four hours of trying counts from when the message became due: a reminder queued days ahead has not started failing yet.
              if (now - Math.max(m.created_ms, m.due_ms) >= GIVE_UP_AFTER_MS) {
                repo.outboxMark(m.id, { status: 'dead', attempts, last_error: 'gave_up' });
                log.write('notifications', 'dead_letter', { businessId, bookingId: m.booking_id, channel: m.channel, reason: 'gave_up' }, { level: 'alert', ref: `${REF}#error-handling` });
              } else {
                repo.outboxMark(m.id, { attempts, next_attempt_ms: now + backoff(attempts), last_error: 'provider_unavailable' });
                log.write('notifications', 'retry_scheduled', { businessId, bookingId: m.booking_id, channel: m.channel, attempts }, { level: 'warn', ref: `${REF}#error-handling` });
              }
            } else throw e;
          }
        }
      }
      return sent;
    },

    /** What a business sees against a booking: delivered, waiting, or not delivered. */
    deliveryFor(businessId, bookingId) {
      const rows = store.scope(businessId).outboxForBooking(bookingId);
      const live = rows.filter((r) => r.status !== 'superseded' && r.status !== 'dropped');
      const status = live.some((r) => r.status === 'dead') ? 'not delivered' : live.every((r) => r.status === 'sent') && live.length ? 'delivered' : 'queued';
      return { status, messages: rows.map((r) => ({ type: r.event_type, channel: r.channel, status: r.status })) };
    },
  };
}
