// The Calendar Connector (SAD component "Calendar connectors", ICR-AB-0002, ADR-AB-0004, ADR-AB-0003).
//
//   - keeps a synchronised copy of each staff member's busy times, driven by change notifications.
//     A notification only says "something changed": the connector asks for the current state, so a
//     lost or out-of-order notification does no harm, and a full re-synchronisation every 24 hours
//     is the safety net;
//   - answers the live check at confirmation, for the one slot that matters;
//   - writes each booking into the staff calendar, idempotently on the booking id, retrying through
//     an outage so nothing is lost;
//   - renews each change subscription well before it lapses, and treats a lapse as an alert. The
//     contract is still "proposed" because this schedule was not yet designed; this is a design for it.
//
// What it stores for a busy interval is a start, an end and a reference: no title, attendee or
// description (ICR-AB-0002 criterion 5). Tokens are sealed, standing in for the secrets manager.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AccessRevoked, ProviderUnavailable, SubscriptionLapsed } from './providers/calendar.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const SYNC_HORIZON_MS = 90 * DAY;
export const RENEW_BEFORE_MS = DAY;          // renew when less than a day is left
export const FULL_RESYNC_EVERY_MS = DAY;     // the safety net
const BACKOFF_CAP_MS = HOUR;                 // "up to 1 hour" (ICR-AB-0002)
const PROBE_EVERY_MS = 60 * 1000;            // while a provider is away, ask once a minute whether it is back

/** Seals tokens at rest, standing in for the secrets manager. A new key each run: restarting forgets them. */
function createVault() {
  const key = randomBytes(32);
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
    },
    unseal(sealed) {
      const [iv, tag, data] = sealed.split('.').map((s) => Buffer.from(s, 'base64'));
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    },
  };
}

export function createCalendarConnector({ store, provider, clock, log }) {
  const vault = createVault();
  const REF = 'ICR-AB-0002';
  const nextProbe = new Map(); // `${businessId}/${staffId}` -> when to next ask a provider that was unavailable

  function token(connection) { return vault.unseal(connection.token_sealed); }
  const backoff = (attempts) => Math.min(BACKOFF_CAP_MS, 1000 * 2 ** Math.min(attempts, 20));

  /** The current busy intervals for one staff member, replacing the stored copy. */
  function sync(businessId, staffId, { reason = 'notification' } = {}) {
    const repo = store.scope(businessId);
    const connection = repo.connection(staffId);
    if (!connection) return false;
    const now = clock.now();
    try {
      const events = provider.listEvents(token(connection), staffId, now - DAY, now + SYNC_HORIZON_MS);
      // Events the platform wrote itself are bookings already; copying them would block a slot twice.
      const intervals = events.filter((e) => !e.bookingId).map((e) => ({ ref: e.id, start: e.start, end: e.end }));
      repo.replaceBusy(staffId, intervals);
      repo.saveConnection({ staffId, tokenSealed: connection.token_sealed, subscriptionId: connection.subscription_id, subscriptionExpiresAt: connection.subscription_expires_ms, lastSyncedAt: now, needsResync: false });
      log.write('calendar', 'synced', { businessId, staffId, intervals: intervals.length, reason }, { ref: `${REF}#interaction` });
      return true;
    } catch (e) {
      return handleProviderError(businessId, staffId, connection, e, 'sync');
    }
  }

  function handleProviderError(businessId, staffId, connection, e, op) {
    const repo = store.scope(businessId);
    if (e instanceof AccessRevoked) {
      repo.deleteConnection(staffId);
      log.write('calendar', 'access_revoked', { businessId, staffId, op }, { level: 'warn', ref: `${REF}#security` });
      return false;
    }
    if (e instanceof ProviderUnavailable) {
      nextProbe.set(`${businessId}/${staffId}`, clock.now() + PROBE_EVERY_MS);
      repo.saveConnection({ staffId, tokenSealed: connection.token_sealed, subscriptionId: connection.subscription_id, subscriptionExpiresAt: connection.subscription_expires_ms, lastSyncedAt: connection.last_synced_ms, needsResync: true });
      log.write('calendar', 'provider_unavailable', { businessId, staffId, op }, { level: 'warn', ref: `${REF}#error-handling` });
      return false;
    }
    throw e;
  }

  return {
    /** Connect a staff member's calendar: grant, subscribe to changes, and take the first full copy. */
    connect(businessId, staffId) {
      const repo = store.scope(businessId);
      const tok = provider.grant(staffId);
      const sub = provider.subscribe(tok, staffId, (n) => this.onNotification(businessId, n));
      repo.saveConnection({ staffId, tokenSealed: vault.seal(tok), subscriptionId: sub.id, subscriptionExpiresAt: sub.expiresAt, lastSyncedAt: null, needsResync: true });
      log.write('calendar', 'connected', { businessId, staffId, subscription: sub.id }, { ref: `${REF}#security` });
      sync(businessId, staffId, { reason: 'initial' });
    },

    /** A change notification: "something changed". Ask for the current state. */
    onNotification(businessId, { staffId }) {
      log.write('calendar', 'notification', { businessId, staffId }, { ref: `${REF}#interaction` });
      sync(businessId, staffId, { reason: 'notification' });
    },

    /**
     * The live check of ADR-AB-0003, for the one slot being confirmed.
     * `checked: false` means it could not be done (provider down, or no calendar connected); the
     * booking then proceeds and the calendar is reconciled afterwards, because a provider outage
     * degrades the experience and never stops a booking.
     */
    liveCheck(businessId, staffId, start, end) {
      const connection = store.scope(businessId).connection(staffId);
      if (!connection) return { checked: false, conflict: false, reason: 'no_calendar' };
      try {
        const events = provider.listEvents(token(connection), staffId, start, end).filter((e) => !e.bookingId);
        const conflict = events.some((e) => e.start < end && e.end > start);
        log.write('calendar', 'live_check', { businessId, staffId, conflict }, { ref: 'ADR-AB-0003' });
        return { checked: true, conflict };
      } catch (e) {
        handleProviderError(businessId, staffId, connection, e, 'live_check');
        log.write('calendar', 'live_check_skipped', { businessId, staffId }, { level: 'warn', ref: 'ADR-AB-0003' });
        return { checked: false, conflict: false, reason: 'provider_unavailable' };
      }
    },

    /** Staff revoke access in the admin console: tokens are deleted and synchronisation stops (criterion 3). */
    revoke(businessId, staffId) {
      provider.revoke(staffId);
      store.scope(businessId).deleteConnection(staffId);
      log.write('calendar', 'revoked', { businessId, staffId }, { ref: `${REF}#security` });
    },

    /**
     * Called on a schedule, in this order:
     *  1. recovery: for a provider that was unavailable, ask once a minute; when it answers, re-synchronise
     *     and let pending writes go at once ("a full re-synchronisation runs when calls start succeeding again");
     *  2. drain pending writes to staff calendars, backing off while the provider is away;
     *  3. renew subscriptions well before they lapse, and re-synchronise daily as the safety net.
     */
    tick() {
      const now = clock.now();
      for (const businessId of store.businessIds()) {
        const repo = store.scope(businessId);

        for (const c of repo.connections()) {
          if (c.needs_resync !== 1 || now < (nextProbe.get(`${businessId}/${c.staff_id}`) ?? 0)) continue;
          if (sync(businessId, c.staff_id, { reason: 'recovery' })) {
            nextProbe.delete(`${businessId}/${c.staff_id}`);
            repo.calendarWritesRetryNow(c.staff_id);
            log.write('calendar', 'provider_recovered', { businessId, staffId: c.staff_id }, { ref: `${REF}#error-handling` });
          }
        }

        for (const w of repo.calendarWritesDue(now)) {
          const connection = repo.connection(w.staff_id);
          if (!connection) { repo.calendarWriteMark(w.id, { status: 'failed' }); continue; }
          try {
            if (w.op === 'upsert') provider.upsertEvent(token(connection), w.staff_id, { bookingId: w.booking_id, start: w.start_ms, end: w.end_ms, title: `${w.service_name}: ${w.first_name}` });
            else provider.deleteEvent(token(connection), w.staff_id, w.booking_id);
            repo.calendarWriteMark(w.id, { status: 'done', attempts: w.attempts + 1 });
            log.write('calendar', w.op === 'upsert' ? 'event_written' : 'event_deleted', { businessId, staffId: w.staff_id, bookingId: w.booking_id }, { ref: `${REF}#error-handling` });
          } catch (e) {
            const attempts = w.attempts + 1;
            if (e instanceof ProviderUnavailable) {
              repo.calendarWriteMark(w.id, { attempts, next_attempt_ms: now + backoff(attempts) });
              handleProviderError(businessId, w.staff_id, connection, e, 'write');
            } else if (e instanceof AccessRevoked) {
              repo.calendarWriteMark(w.id, { status: 'failed', attempts });
              handleProviderError(businessId, w.staff_id, connection, e, 'write');
            } else throw e;
          }
        }

        for (const c of repo.connections()) {
          if (c.subscription_expires_ms !== null && c.subscription_expires_ms - now < RENEW_BEFORE_MS) {
            try {
              const renewed = provider.renew(token(c), c.staff_id, c.subscription_id);
              repo.saveConnection({ staffId: c.staff_id, tokenSealed: c.token_sealed, subscriptionId: c.subscription_id, subscriptionExpiresAt: renewed.expiresAt, lastSyncedAt: c.last_synced_ms, needsResync: c.needs_resync === 1 });
              log.write('calendar', 'subscription_renewed', { businessId, staffId: c.staff_id }, { ref: `${REF}#open-issues` });
            } catch (e) {
              if (e instanceof SubscriptionLapsed) {
                // A missed renewal: say so loudly, subscribe again, and re-synchronise, because changes may have been missed.
                log.write('calendar', 'renewal_missed', { businessId, staffId: c.staff_id }, { level: 'alert', ref: `${REF}#open-issues` });
                try {
                  const sub = provider.subscribe(token(c), c.staff_id, (n) => this.onNotification(businessId, n));
                  repo.saveConnection({ staffId: c.staff_id, tokenSealed: c.token_sealed, subscriptionId: sub.id, subscriptionExpiresAt: sub.expiresAt, lastSyncedAt: c.last_synced_ms, needsResync: true });
                } catch (e2) { handleProviderError(businessId, c.staff_id, c, e2, 'resubscribe'); }
              } else handleProviderError(businessId, c.staff_id, c, e, 'renew');
            }
          }
          const fresh = repo.connection(c.staff_id);
          if (!fresh) continue;
          const stale = fresh.last_synced_ms === null || now - fresh.last_synced_ms >= FULL_RESYNC_EVERY_MS;
          const probeDue = fresh.needs_resync === 1 && now >= (nextProbe.get(`${businessId}/${c.staff_id}`) ?? 0);
          if (probeDue || stale) sync(businessId, c.staff_id, { reason: probeDue ? 'recovery' : 'daily' });
        }
      }
    },

    status(businessId) {
      const repo = store.scope(businessId);
      return repo.connections().map((c) => ({
        staffId: c.staff_id, subscriptionExpiresAt: c.subscription_expires_ms, lastSyncedAt: c.last_synced_ms,
        needsResync: c.needs_resync === 1, busyIntervals: repo.busyCount(c.staff_id),
      }));
    },
  };
}
