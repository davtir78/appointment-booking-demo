// A stand-in for the staff calendar providers (Google Calendar, Microsoft 365) of ICR-AB-0002. It
// behaves the way the contract says the real ones do, awkward parts included:
//   - a change produces a notification that says only "something changed" (the consumer then asks
//     for the current state), and a notification can be lost;
//   - a change subscription expires and must be renewed before it lapses (the contract's open issue
//     for Microsoft 365, "a few days");
//   - access can be revoked, and the whole provider can be unavailable;
//   - events carry titles and attendees, which the consumer must not copy;
//   - writing an event is idempotent on an extended property holding the booking id.
// Nothing here talks to a network.

export class ProviderUnavailable extends Error { constructor() { super('The calendar provider is unavailable.'); this.name = 'ProviderUnavailable'; } }
export class SubscriptionLapsed extends Error { constructor() { super('The change subscription has lapsed.'); this.name = 'SubscriptionLapsed'; } }
export class AccessRevoked extends Error { constructor() { super('Access to the calendar was revoked.'); this.name = 'AccessRevoked'; } }

const DAY = 24 * 60 * 60 * 1000;

export function createCalendarProvider({ clock, subscriptionTtlMs = 3 * DAY }) {
  const calendars = new Map(); // staffId -> Map(eventId -> event)
  const tokens = new Map();    // token -> staffId
  const subscriptions = new Map(); // id -> { staffId, expiresAt, webhook }
  let down = false;
  let sequence = 0;
  const calls = [];

  const calendar = (staffId) => { if (!calendars.has(staffId)) calendars.set(staffId, new Map()); return calendars.get(staffId); };
  const record = (op, staffId) => calls.push({ op, staffId, at: clock.now() });
  function authorise(token, staffId) {
    if (down) throw new ProviderUnavailable();
    if (tokens.get(token) !== staffId) throw new AccessRevoked();
  }

  return {
    // ── what a staff member does in their own calendar ──
    /** The staff member adds an event in the provider's own app. `notify: false` loses the notification. */
    staffAdds(staffId, { start, end, title = 'Private appointment', attendees = [], notify = true }) {
      const event = { id: `evt_${++sequence}`, start, end, title, attendees, description: 'Added by the staff member', bookingId: null };
      calendar(staffId).set(event.id, event);
      record('staff-adds', staffId);
      if (notify) this.notify(staffId);
      return event;
    },
    staffRemoves(staffId, eventId, { notify = true } = {}) {
      calendar(staffId).delete(eventId);
      record('staff-removes', staffId);
      if (notify) this.notify(staffId);
    },
    /** Deliver "something changed" to the subscriber, if there is a live subscription and the provider is up. */
    notify(staffId) {
      if (down) return false;
      for (const [id, sub] of subscriptions) {
        if (sub.staffId === staffId && sub.expiresAt > clock.now()) { try { sub.webhook({ subscriptionId: id, staffId }); } catch { /* the provider does not care */ } return true; }
      }
      return false;
    },
    /** Put events in directly (setting the scene), with no notification. */
    seed(staffId, events) { for (const e of events) calendar(staffId).set(e.id ?? `evt_${++sequence}`, { title: 'Private appointment', attendees: [], description: '', bookingId: null, ...e, id: e.id ?? `evt_${sequence}` }); },

    // ── what the consumer calls ──
    grant(staffId) {
      const token = `tok_${staffId}_${++sequence}`;
      tokens.set(token, staffId);
      return token;
    },
    revoke(staffId) {
      for (const [token, id] of [...tokens]) if (id === staffId) tokens.delete(token);
      for (const [id, sub] of [...subscriptions]) if (sub.staffId === staffId) subscriptions.delete(id);
      record('revoke', staffId);
    },
    subscribe(token, staffId, webhook) {
      authorise(token, staffId);
      const id = `sub_${++sequence}`;
      subscriptions.set(id, { staffId, expiresAt: clock.now() + subscriptionTtlMs, webhook });
      record('subscribe', staffId);
      return { id, expiresAt: subscriptions.get(id).expiresAt };
    },
    renew(token, staffId, subscriptionId) {
      authorise(token, staffId);
      const sub = subscriptions.get(subscriptionId);
      if (!sub || sub.expiresAt <= clock.now()) throw new SubscriptionLapsed();
      sub.expiresAt = clock.now() + subscriptionTtlMs;
      record('renew', staffId);
      return { id: subscriptionId, expiresAt: sub.expiresAt };
    },
    /** The current state of a window: the answer to "something changed", and the live check at confirmation. */
    listEvents(token, staffId, from, to) {
      authorise(token, staffId);
      record('list', staffId);
      return [...calendar(staffId).values()].filter((e) => e.start < to && e.end > from).map((e) => ({ ...e }));
    },
    /** Idempotent on the booking id: writing the same booking twice updates, never duplicates. */
    upsertEvent(token, staffId, { bookingId, start, end, title }) {
      authorise(token, staffId);
      record('upsert', staffId);
      const existing = [...calendar(staffId).values()].find((e) => e.bookingId === bookingId);
      if (existing) { Object.assign(existing, { start, end, title }); return { ...existing }; }
      const event = { id: `evt_${++sequence}`, start, end, title, attendees: [], description: '', bookingId };
      calendar(staffId).set(event.id, event);
      return { ...event };
    },
    deleteEvent(token, staffId, bookingId) {
      authorise(token, staffId);
      record('delete', staffId);
      for (const [id, e] of calendar(staffId)) if (e.bookingId === bookingId) calendar(staffId).delete(id);
    },

    // ── for the demo and the tests ──
    setDown(value) { down = Boolean(value); },
    isDown: () => down,
    subscriptionFor(staffId) { for (const [id, s] of subscriptions) if (s.staffId === staffId) return { id, expiresAt: s.expiresAt }; return null; },
    expireSubscriptions(staffId) { for (const s of subscriptions.values()) if (!staffId || s.staffId === staffId) s.expiresAt = clock.now() - 1; },
    eventsFor: (staffId) => [...calendar(staffId).values()].map((e) => ({ ...e })),
    calls: () => [...calls],
    reset() { calendars.clear(); tokens.clear(); subscriptions.clear(); calls.length = 0; down = false; },
  };
}
