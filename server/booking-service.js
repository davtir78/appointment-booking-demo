// The Availability Service and Booking Service of the SAD, in one module (ICR-AB-0001, ADR-AB-0003,
// and the booking, availability and notification requirements). Every method takes the business the gateway resolved from
// the widget key and reaches data only through `store.scope(businessId)`.
//
// Times are UTC instants (milliseconds here; the gateway renders them as ISO 8601). Working hours
// are rules in the business's zone and are expanded by the same code the browser build uses.

import { createHash, randomBytes } from 'node:crypto';
import { addDays, dateInZone } from '../widget/time.js';
import { ruleSlots } from '../widget/domain.js';
import { OverlapError } from './store.js';
import { HttpError } from './errors.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
export const HOLD_MS = 5 * MIN;           // the booking requirements: a hold lasts five minutes
export const MAX_EXTENSIONS = 10;         // WCAG 2.2.1; a proposed addition to the contract
export const NOTICE_MS = HOUR;            // nothing bookable inside the next hour
export const MAX_SEARCH_DAYS = 21;
export const IDEMPOTENCY_TTL_MS = 24 * HOUR;
export const REMINDER_LEAD_MS = 24 * HOUR;
export const REMINDER_LATEST_MS = 2 * HOUR;

const id = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;
const fingerprintOf = (body) => createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9+()\- ]{6,20}$/;

export function createBookingService({ store, connector, worker, clock, log }) {
  const REF = 'ICR-AB-0001';

  const businessOrThrow = (businessId) => {
    const business = store.scope(businessId).business();
    if (!business) throw new HttpError(404, 'unknown_business', 'No such business.');
    return business;
  };

  /** Free slots from the synchronised copy, minus holds and bookings (GET .../availability). */
  function search(businessId, { serviceId, fromDate, days = 7, staffId = null }) {
    const repo = store.scope(businessId);
    const business = businessOrThrow(businessId);
    const service = repo.service(serviceId);
    if (!service) throw new HttpError(404, 'unknown_service', 'No such service.');
    const span = Math.max(1, Math.min(days, MAX_SEARCH_DAYS));
    const from = fromDate ?? dateInZone(clock.now(), business.timeZone);
    const earliest = clock.now() + NOTICE_MS;
    const slots = [];
    for (const member of repo.staff()) {
      if (!member.services.includes(serviceId) || (staffId && member.id !== staffId)) continue;
      const all = [];
      for (let n = 0; n < span; n += 1) all.push(...ruleSlots(member, service, addDays(from, n), business.timeZone));
      if (!all.length) continue;
      const lo = Math.min(...all.map((s) => s.start));
      const hi = Math.max(...all.map((s) => s.end));
      const busy = repo.busyIntervals(member.id, lo, hi);
      const taken = repo.activeRows(member.id, lo, hi);
      for (const s of all) {
        if (s.start < earliest) continue;
        if (busy.some((b) => b.start < s.end && b.end > s.start)) continue;
        if (taken.some((r) => r.start < s.end && r.end > s.start)) continue;
        slots.push({ staffId: s.staffId, start: s.start, end: s.end });
      }
    }
    return slots.sort((a, b) => a.start - b.start || a.staffId.localeCompare(b.staffId));
  }

  /** The next few free times, offered whenever a slot turns out to be taken (409 lists them). */
  function alternatives(businessId, { serviceId, staffId, after }) {
    const business = businessOrThrow(businessId);
    const free = search(businessId, { serviceId, fromDate: dateInZone(after, business.timeZone), days: 14 }).filter((s) => s.start > after);
    const same = free.filter((s) => s.staffId === staffId).slice(0, 2);
    const others = free.filter((s) => s.staffId !== staffId).slice(0, 2);
    return [...same, ...others].sort((a, b) => a.start - b.start).slice(0, 3);
  }

  const taken = (businessId, params, message = 'That time is no longer free.', code = 'slot_taken') =>
    new HttpError(409, code, message, { alternatives: alternatives(businessId, params) });

  /** Run a POST once per idempotency key (ICR-AB-0001: the original result is returned for 24 hours). */
  function once(businessId, scope, key, body, run) {
    const repo = store.scope(businessId);
    const fingerprint = fingerprintOf(body);
    const seen = repo.idemGet(scope, key);
    if (seen && clock.now() - seen.createdAt < IDEMPOTENCY_TTL_MS) {
      if (seen.fingerprint !== fingerprint) throw new HttpError(422, 'idempotency_key_reused', 'That Idempotency-Key was used with a different request.');
      log.write('booking', 'idempotent_replay', { businessId, scope }, { ref: `${REF}#error-handling` });
      return { ...seen, replayed: true };
    }
    const result = run();
    repo.idemPut(scope, key, fingerprint, result.status, result.body);
    return { ...result, replayed: false };
  }

  const holdView = (row) => ({ id: row.id, serviceId: row.serviceId, staffId: row.staffId, start: row.start, end: row.end, expiresAt: row.expiresAt });
  const bookingView = (row) => ({
    id: row.bookingId, holdId: row.id, status: 'confirmed', serviceId: row.serviceId, staffId: row.staffId, start: row.start, end: row.end,
    customer: row.customer ? { name: row.customer.name, email: row.customer.email, phone: row.customer.phone ?? null } : undefined,
  });

  function validStart(business, member, service, start) {
    if (!Number.isInteger(start)) throw new HttpError(400, 'invalid_request', 'start must be an instant.');
    const slot = ruleSlots(member, service, dateInZone(start, business.timeZone), business.timeZone).find((s) => s.start === start);
    if (!slot || start < clock.now() + NOTICE_MS) throw new HttpError(422, 'not_bookable', 'That is not a bookable time.');
    return slot;
  }

  function reminderFor(businessId, booking, customer, view) {
    const dueAt = booking.start - REMINDER_LEAD_MS;
    if (dueAt <= clock.now()) return; // booked inside the day: no day-before reminder to send
    worker.enqueue(businessId, {
      type: 'ReminderDue', bookingId: booking.bookingId, eventId: `evt_${booking.bookingId}_reminder_${booking.start}`,
      booking: view, customer, dueAt, windowEnd: booking.start - REMINDER_LATEST_MS,
    });
  }

  /** What the message templates need, none of it ever logged. */
  function messageData(businessId, business, row, token) {
    const repo = store.scope(businessId);
    return {
      serviceName: repo.service(row.serviceId).name, staffName: repo.staffMember(row.staffId).name, start: row.start, end: row.end,
      timeZone: business.timeZone, manageUrl: `https://example.com/manage/${row.bookingId}?t=${token}`,
    };
  }

  /** The booking, if the token is its own and the appointment has not passed. */
  function requireBooking(businessId, bookingId, token) {
    const repo = store.scope(businessId);
    const row = repo.bookingRow(bookingId);
    if (!row) throw new HttpError(404, 'unknown_booking', 'No such booking.');
    if (!token || token !== row.token) throw new HttpError(403, 'forbidden', 'That link does not manage this booking.');
    if (clock.now() > row.end) throw new HttpError(403, 'token_expired', 'This booking has passed, so it can no longer be changed.');
    return row;
  }

  return {
    catalog(businessId) {
      const repo = store.scope(businessId);
      const business = businessOrThrow(businessId);
      return {
        business: { id: business.id, name: business.name, timeZone: business.timeZone },
        services: repo.services(),
        staff: repo.staff().map((m) => ({ id: m.id, name: m.name, role: m.role, services: m.services })),
      };
    },

    search,

    /** POST .../holds */
    createHold(businessId, body, key) {
      return once(businessId, 'hold', key, body, () => {
        const repo = store.scope(businessId);
        const business = businessOrThrow(businessId);
        const service = repo.service(body?.serviceId);
        const member = repo.staffMember(body?.staffId);
        if (!service || !member || !member.services.includes(service.id)) throw new HttpError(422, 'invalid_request', 'That service is not offered by that person.');
        const slot = validStart(business, member, service, body.start);
        const params = { serviceId: service.id, staffId: member.id, after: slot.start };
        try {
          const row = store.tx(() => {
            const busy = repo.busyIntervals(member.id, slot.start, slot.end);
            if (busy.length) throw new OverlapError();
            const holdId = id('hold');
            repo.insertHold({ id: holdId, staffId: member.id, serviceId: service.id, start: slot.start, end: slot.end, expiresAt: clock.now() + HOLD_MS });
            return repo.row(holdId);
          });
          log.write('booking', 'hold_created', { businessId, holdId: row.id, staffId: member.id }, { ref: 'REQ-BOOKING' });
          return { status: 201, body: holdView(row) };
        } catch (e) {
          if (e instanceof OverlapError) {
            log.write('booking', 'overlap_refused', { businessId, staffId: member.id }, { level: 'warn', ref: 'REQ-BOOKING' });
            throw taken(businessId, params);
          }
          throw e;
        }
      });
    },

    /** Hold the same time for five more minutes. A proposed addition to the contract (WCAG 2.2.1). */
    extend(businessId, holdId) {
      const repo = store.scope(businessId);
      const row = repo.row(holdId);
      if (!row) throw new HttpError(404, 'unknown_hold', 'No such hold.');
      if (row.kind !== 'hold' || row.expiresAt <= clock.now()) throw new HttpError(410, 'hold_expired', 'Your hold on that time has ended.');
      if (row.extensions >= MAX_EXTENSIONS) throw new HttpError(409, 'too_many_extensions', 'This time can’t be held any longer.');
      store.tx(() => repo.extendHold(holdId, clock.now() + HOLD_MS));
      log.write('booking', 'hold_extended', { businessId, holdId }, { ref: 'REQ-BOOKING' });
      return holdView(repo.row(holdId));
    },

    /** Let go of a hold. A proposed addition to the contract. */
    release(businessId, holdId) {
      const repo = store.scope(businessId);
      const row = repo.row(holdId);
      if (!row) throw new HttpError(404, 'unknown_hold', 'No such hold.');
      if (row.kind !== 'hold') throw new HttpError(409, 'already_confirmed', 'That hold is already a booking.');
      store.tx(() => repo.deleteRow(holdId));
      log.write('booking', 'hold_released', { businessId, holdId }, { ref: 'REQ-BOOKING' });
    },

    /** POST /holds/{id}/confirm */
    confirm(businessId, holdId, body, key) {
      return once(businessId, 'confirm', key, { holdId, ...body }, () => {
        const repo = store.scope(businessId);
        const business = businessOrThrow(businessId);
        const row = repo.row(holdId);
        if (!row) throw new HttpError(404, 'unknown_hold', 'No such hold.');
        const params = { serviceId: row.serviceId, staffId: row.staffId, after: row.start };
        if (row.kind === 'booking') throw taken(businessId, params, 'That time has already been booked.');
        if (row.expiresAt <= clock.now()) throw new HttpError(410, 'hold_expired', 'Your hold on that time has ended.');

        const c = body?.customer;
        const name = typeof c?.name === 'string' ? c.name.trim() : '';
        if (!name || name.length > 100) throw new HttpError(400, 'invalid_request', 'A name is required.');
        if (typeof c?.email !== 'string' || !EMAIL.test(c.email.trim())) throw new HttpError(400, 'invalid_request', 'A valid email address is required.');
        if (c.phone && !PHONE.test(String(c.phone))) throw new HttpError(400, 'invalid_request', 'That phone number can’t be used.');
        const customer = { name, email: c.email.trim(), phone: c.phone ? String(c.phone).trim() : null };

        // ADR-AB-0003: the copy is only a copy. Ask the staff member's own calendar about this one slot.
        const live = connector.liveCheck(businessId, row.staffId, row.start, row.end);
        if (live.conflict) {
          store.tx(() => repo.deleteRow(holdId));
          log.write('booking', 'live_check_failed', { businessId, holdId }, { level: 'warn', ref: 'ADR-AB-0003' });
          throw taken(businessId, params, 'That time is no longer free in the calendar.', 'calendar_conflict');
        }

        const bookingId = id('bk');
        const token = randomBytes(16).toString('hex');
        const confirmed = store.tx(() => {
          repo.confirmHold(holdId, { bookingId, token, customer });
          const booked = repo.row(holdId);
          const data = messageData(businessId, business, booked, token);
          // The messages are written in the same transaction as the booking (the notification requirements' design note).
          worker.enqueue(businessId, { type: 'BookingConfirmed', bookingId, eventId: `evt_${bookingId}_confirmed`, booking: data, customer });
          reminderFor(businessId, booked, customer, data);
          repo.calendarWriteAdd({ staffId: booked.staffId, bookingId, op: 'upsert', start: booked.start, end: booked.end, firstName: name.split(/\s+/)[0], serviceName: data.serviceName });
          return booked;
        });
        log.write('booking', 'booking_confirmed', { businessId, bookingId, staffId: confirmed.staffId, liveChecked: live.checked }, { ref: REF });
        return { status: 201, body: { ...bookingView(confirmed), token, notifications: worker.deliveryFor(businessId, bookingId) } };
      });
    },

    getBooking(businessId, bookingId, token) {
      const row = requireBooking(businessId, bookingId, token);
      return { ...bookingView(row), notifications: worker.deliveryFor(businessId, bookingId) };
    },

    /** PATCH /bookings/{id}: move to a time already held. */
    reschedule(businessId, bookingId, token, holdId) {
      const repo = store.scope(businessId);
      const business = businessOrThrow(businessId);
      const booking = requireBooking(businessId, bookingId, token);
      const hold = repo.row(holdId);
      if (!hold || hold.kind !== 'hold') throw new HttpError(404, 'unknown_hold', 'No such hold.');
      if (hold.expiresAt <= clock.now()) throw new HttpError(410, 'hold_expired', 'Your hold on that time has ended.');
      if (hold.serviceId !== booking.serviceId) throw new HttpError(422, 'invalid_request', 'A booking can only move to a time for the same service.');
      const params = { serviceId: hold.serviceId, staffId: hold.staffId, after: hold.start };
      const live = connector.liveCheck(businessId, hold.staffId, hold.start, hold.end);
      if (live.conflict) {
        store.tx(() => repo.deleteRow(holdId));
        throw taken(businessId, params, 'That time is no longer free in the calendar.', 'calendar_conflict');
      }
      const moved = store.tx(() => {
        repo.deleteRow(holdId); // the hold has done its job; the booking row takes its place
        repo.moveBooking(booking.id, { staffId: hold.staffId, start: hold.start, end: hold.end });
        const row = repo.row(booking.id);
        const data = messageData(businessId, business, row, booking.token);
        worker.supersede(businessId, bookingId, ['BookingConfirmed', 'BookingRescheduled', 'ReminderDue']);
        worker.enqueue(businessId, { type: 'BookingRescheduled', bookingId, eventId: `evt_${bookingId}_rescheduled_${row.start}`, booking: data, customer: booking.customer });
        reminderFor(businessId, row, booking.customer, data);
        repo.calendarWriteAdd({ staffId: row.staffId, bookingId, op: 'upsert', start: row.start, end: row.end, firstName: booking.customer.name.split(/\s+/)[0], serviceName: data.serviceName });
        return row;
      });
      log.write('booking', 'booking_rescheduled', { businessId, bookingId }, { ref: REF });
      return { ...bookingView(moved), notifications: worker.deliveryFor(businessId, bookingId) };
    },

    /** DELETE /bookings/{id} */
    cancel(businessId, bookingId, token) {
      const repo = store.scope(businessId);
      const business = businessOrThrow(businessId);
      const booking = requireBooking(businessId, bookingId, token);
      store.tx(() => {
        const data = messageData(businessId, business, booking, booking.token);
        repo.deleteRow(booking.id);
        // Anything not yet sent about this booking is now untrue; the cancellation replaces it (ICR-AB-0003 criterion 2).
        worker.supersede(businessId, bookingId, ['BookingConfirmed', 'BookingRescheduled', 'ReminderDue']);
        worker.enqueue(businessId, { type: 'BookingCancelled', bookingId, eventId: `evt_${bookingId}_cancelled`, booking: data, customer: booking.customer });
        repo.calendarWriteAdd({ staffId: booking.staffId, bookingId, op: 'delete' });
      });
      log.write('booking', 'booking_cancelled', { businessId, bookingId }, { ref: REF });
    },

    /** Housekeeping the design runs on a schedule. */
    tick() {
      for (const businessId of store.businessIds()) {
        const repo = store.scope(businessId);
        const purged = store.tx(() => repo.purgeExpiredHolds() + repo.idemPurge(clock.now() - IDEMPOTENCY_TTL_MS));
        if (purged) log.write('booking', 'housekeeping', { businessId, purged }, { ref: 'REQ-BOOKING' });
      }
    },
  };
}
