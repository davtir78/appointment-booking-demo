// The Booking Store: SQLite standing in for the design's PostgreSQL.
//
//   Booking requirements and ADR-AB-0007: the no-overlap guarantee lives in the database. A trigger
//                refuses any hold or booking that overlaps an active one for the same staff member,
//                whatever the application does. An expired hold does not count, so the trigger reads
//                the clock from a one-row table the application sets in the same transaction.
//   ADR-AB-0005  tenant isolation. The design uses row-level security, which SQLite does not have.
//                Here every query goes through `store.scope(businessId)`, the only data path, and each
//                method puts the business in its WHERE clause. That is isolation by code, not by the
//                database, and is stated as a difference from the design.
//   Notification requirements: the transactional outbox is a table written in the same transaction as the booking.
//   ICR-AB-0002  busy intervals hold no titles, attendees or descriptions: the table has no column
//                that could.

import { DatabaseSync } from 'node:sqlite';

export class OverlapError extends Error {
  constructor() { super('That time overlaps an active hold or booking.'); this.name = 'OverlapError'; }
}

const SCHEMA = `
CREATE TABLE clock (id INTEGER PRIMARY KEY CHECK (id = 1), now_ms INTEGER NOT NULL);
INSERT INTO clock VALUES (1, 0);

CREATE TABLE businesses (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, time_zone TEXT NOT NULL,
  widget_key TEXT NOT NULL UNIQUE, origins TEXT NOT NULL
);
CREATE TABLE services (
  business_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, minutes INTEGER NOT NULL,
  PRIMARY KEY (business_id, id)
);
CREATE TABLE staff (
  business_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
  hours TEXT NOT NULL, services TEXT NOT NULL,
  PRIMARY KEY (business_id, id)
);

-- Holds and bookings share one table (the booking requirements). A hold is a row with kind 'hold' and an expiry.
CREATE TABLE rows (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL, staff_id TEXT NOT NULL, service_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('hold', 'booking')),
  expires_ms INTEGER, extensions INTEGER NOT NULL DEFAULT 0,
  booking_id TEXT UNIQUE, token TEXT, customer TEXT,
  created_ms INTEGER NOT NULL,
  CHECK (end_ms > start_ms),
  CHECK (kind = 'booking' OR expires_ms IS NOT NULL)
);
CREATE INDEX rows_by_staff ON rows (business_id, staff_id, start_ms);

CREATE TRIGGER rows_no_overlap_insert BEFORE INSERT ON rows
BEGIN
  SELECT RAISE(ABORT, 'overlap') WHERE EXISTS (
    SELECT 1 FROM rows r
    WHERE r.business_id = NEW.business_id AND r.staff_id = NEW.staff_id AND r.id <> NEW.id
      AND r.start_ms < NEW.end_ms AND NEW.start_ms < r.end_ms
      AND (r.kind = 'booking' OR r.expires_ms > (SELECT now_ms FROM clock)));
END;
CREATE TRIGGER rows_no_overlap_update BEFORE UPDATE OF staff_id, start_ms, end_ms, kind ON rows
BEGIN
  SELECT RAISE(ABORT, 'overlap') WHERE EXISTS (
    SELECT 1 FROM rows r
    WHERE r.business_id = NEW.business_id AND r.staff_id = NEW.staff_id AND r.id <> NEW.id
      AND r.start_ms < NEW.end_ms AND NEW.start_ms < r.end_ms
      AND (r.kind = 'booking' OR r.expires_ms > (SELECT now_ms FROM clock)));
END;

-- The synchronised copy of staff calendars: intervals and nothing else (ICR-AB-0002 criterion 5).
CREATE TABLE busy_times (
  business_id TEXT NOT NULL, staff_id TEXT NOT NULL, event_ref TEXT NOT NULL,
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  PRIMARY KEY (business_id, staff_id, event_ref)
);

CREATE TABLE calendar_connections (
  business_id TEXT NOT NULL, staff_id TEXT NOT NULL,
  token_sealed TEXT NOT NULL, subscription_id TEXT, subscription_expires_ms INTEGER,
  last_synced_ms INTEGER, needs_resync INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (business_id, staff_id)
);
-- Writes to staff calendars that have not succeeded yet, so a provider outage loses nothing.
CREATE TABLE calendar_writes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, business_id TEXT NOT NULL, staff_id TEXT NOT NULL,
  booking_id TEXT NOT NULL, op TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
  start_ms INTEGER, end_ms INTEGER, first_name TEXT, service_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER NOT NULL DEFAULT 0
);

-- The transactional outbox (the notification requirements): one row per message, keyed by event id and channel.
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL, booking_id TEXT NOT NULL,
  event_id TEXT NOT NULL, event_type TEXT NOT NULL, channel TEXT NOT NULL,
  recipient TEXT NOT NULL, payload TEXT NOT NULL,
  due_ms INTEGER NOT NULL, window_end_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'superseded', 'dropped', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER NOT NULL DEFAULT 0,
  created_ms INTEGER NOT NULL, sent_ms INTEGER, last_error TEXT
);

CREATE TABLE idempotency (
  business_id TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  status INTEGER NOT NULL, body TEXT NOT NULL, created_ms INTEGER NOT NULL,
  PRIMARY KEY (business_id, scope, key)
);
`;

const json = (s) => (s === null || s === undefined ? null : JSON.parse(s));

function toRow(r) {
  if (!r) return null;
  return {
    id: r.id, businessId: r.business_id, staffId: r.staff_id, serviceId: r.service_id,
    start: r.start_ms, end: r.end_ms, kind: r.kind, expiresAt: r.expires_ms, extensions: r.extensions,
    bookingId: r.booking_id, token: r.token, customer: json(r.customer), createdAt: r.created_ms,
  };
}

export class Store {
  constructor({ clock, file = ':memory:' }) {
    this.clock = clock;
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.depth = 0;
  }

  /** The overlap trigger reads "now" from the database, so set it first in every write transaction. */
  #syncClock() { this.db.prepare('UPDATE clock SET now_ms = ?').run(this.clock.now()); }

  /** Run `fn` in one transaction; anything it throws rolls the whole thing back. */
  tx(fn) {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      this.#syncClock();
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  /** Outside a transaction (for a single statement), keep the trigger's clock current. */
  touchClock() { if (this.depth === 0) this.#syncClock(); }

  businessIds() { return this.db.prepare('SELECT id FROM businesses ORDER BY id').all().map((r) => r.id); }

  /** The business a widget key belongs to, or null. The only lookup that does not start from a business. */
  businessByKey(key) {
    const r = this.db.prepare('SELECT * FROM businesses WHERE widget_key = ?').get(key);
    return r ? { id: r.id, name: r.name, timeZone: r.time_zone, widgetKey: r.widget_key, origins: JSON.parse(r.origins) } : null;
  }

  addBusiness({ id, name, timeZone, widgetKey, origins }) {
    this.db.prepare('INSERT INTO businesses VALUES (?, ?, ?, ?, ?)').run(id, name, timeZone, widgetKey, JSON.stringify(origins));
  }
  addService(businessId, s) { this.db.prepare('INSERT INTO services VALUES (?, ?, ?, ?)').run(businessId, s.id, s.name, s.minutes); }
  addStaff(businessId, m) {
    this.db.prepare('INSERT INTO staff VALUES (?, ?, ?, ?, ?, ?)').run(businessId, m.id, m.name, m.role, JSON.stringify(m.hours), JSON.stringify(m.services));
  }
  setOrigins(businessId, origins) { this.db.prepare('UPDATE businesses SET origins = ? WHERE id = ?').run(JSON.stringify(origins), businessId); }

  /** Every query for a business goes through here. */
  scope(businessId) { return new ScopedRepo(this, businessId); }
}

class ScopedRepo {
  constructor(store, businessId) { this.store = store; this.db = store.db; this.businessId = businessId; }

  business() {
    const r = this.db.prepare('SELECT * FROM businesses WHERE id = ?').get(this.businessId);
    return r ? { id: r.id, name: r.name, timeZone: r.time_zone, widgetKey: r.widget_key, origins: JSON.parse(r.origins) } : null;
  }
  services() { return this.db.prepare('SELECT * FROM services WHERE business_id = ? ORDER BY rowid').all(this.businessId).map((s) => ({ id: s.id, name: s.name, minutes: s.minutes })); }
  service(id) { return this.services().find((s) => s.id === id) ?? null; }
  staff() {
    return this.db.prepare('SELECT * FROM staff WHERE business_id = ? ORDER BY rowid').all(this.businessId)
      .map((m) => ({ id: m.id, name: m.name, role: m.role, hours: JSON.parse(m.hours), services: JSON.parse(m.services) }));
  }
  staffMember(id) { return this.staff().find((m) => m.id === id) ?? null; }

  // ── busy times (the synchronised calendar copy) ──
  busyIntervals(staffId, from, to) {
    return this.db.prepare('SELECT start_ms AS start, end_ms AS end FROM busy_times WHERE business_id = ? AND staff_id = ? AND start_ms < ? AND end_ms > ?')
      .all(this.businessId, staffId, to, from);
  }
  replaceBusy(staffId, intervals) {
    this.store.tx(() => {
      this.db.prepare('DELETE FROM busy_times WHERE business_id = ? AND staff_id = ?').run(this.businessId, staffId);
      const insert = this.db.prepare('INSERT INTO busy_times VALUES (?, ?, ?, ?, ?)');
      for (const i of intervals) insert.run(this.businessId, staffId, i.ref, i.start, i.end);
    });
  }
  busyCount(staffId) { return this.db.prepare('SELECT COUNT(*) AS n FROM busy_times WHERE business_id = ? AND staff_id = ?').get(this.businessId, staffId).n; }

  // ── holds and bookings ──
  /** Active rows overlapping a window: bookings, and holds that have not expired. */
  activeRows(staffId, from, to) {
    return this.db.prepare(`SELECT * FROM rows WHERE business_id = ? AND staff_id = ? AND start_ms < ? AND end_ms > ?
        AND (kind = 'booking' OR expires_ms > ?)`).all(this.businessId, staffId, to, from, this.store.clock.now()).map(toRow);
  }
  row(id) { return toRow(this.db.prepare('SELECT * FROM rows WHERE business_id = ? AND id = ?').get(this.businessId, id)); }
  bookingRow(bookingId) { return toRow(this.db.prepare('SELECT * FROM rows WHERE business_id = ? AND booking_id = ?').get(this.businessId, bookingId)); }
  allRows() { return this.db.prepare('SELECT * FROM rows WHERE business_id = ? ORDER BY start_ms').all(this.businessId).map(toRow); }

  #guard(fn) {
    try { return fn(); } catch (e) { if (/overlap/.test(String(e.message))) throw new OverlapError(); throw e; }
  }
  insertHold({ id, staffId, serviceId, start, end, expiresAt }) {
    this.#guard(() => this.db.prepare(`INSERT INTO rows (id, business_id, staff_id, service_id, start_ms, end_ms, kind, expires_ms, created_ms)
        VALUES (?, ?, ?, ?, ?, ?, 'hold', ?, ?)`).run(id, this.businessId, staffId, serviceId, start, end, expiresAt, this.store.clock.now()));
  }
  extendHold(id, expiresAt) { this.db.prepare("UPDATE rows SET expires_ms = ?, extensions = extensions + 1 WHERE business_id = ? AND id = ? AND kind = 'hold'").run(expiresAt, this.businessId, id); }
  confirmHold(id, { bookingId, token, customer }) {
    this.#guard(() => this.db.prepare("UPDATE rows SET kind = 'booking', expires_ms = NULL, booking_id = ?, token = ?, customer = ? WHERE business_id = ? AND id = ? AND kind = 'hold'")
      .run(bookingId, token, JSON.stringify(customer), this.businessId, id));
  }
  moveBooking(id, { staffId, start, end }) {
    this.#guard(() => this.db.prepare("UPDATE rows SET staff_id = ?, start_ms = ?, end_ms = ? WHERE business_id = ? AND id = ? AND kind = 'booking'").run(staffId, start, end, this.businessId, id));
  }
  deleteRow(id) { this.db.prepare('DELETE FROM rows WHERE business_id = ? AND id = ?').run(this.businessId, id); }
  /** Housekeeping the design runs hourly: the trigger already ignores expired holds, so this only tidies. */
  purgeExpiredHolds() { return this.db.prepare("DELETE FROM rows WHERE business_id = ? AND kind = 'hold' AND expires_ms <= ?").run(this.businessId, this.store.clock.now()).changes; }

  // ── idempotency ──
  idemGet(scope, key) {
    const r = this.db.prepare('SELECT * FROM idempotency WHERE business_id = ? AND scope = ? AND key = ?').get(this.businessId, scope, key);
    return r ? { fingerprint: r.fingerprint, status: r.status, body: JSON.parse(r.body), createdAt: r.created_ms } : null;
  }
  idemPut(scope, key, fingerprint, status, body) {
    this.db.prepare('INSERT OR IGNORE INTO idempotency VALUES (?, ?, ?, ?, ?, ?, ?)').run(this.businessId, scope, key, fingerprint, status, JSON.stringify(body), this.store.clock.now());
  }
  idemPurge(olderThanMs) { return this.db.prepare('DELETE FROM idempotency WHERE business_id = ? AND created_ms < ?').run(this.businessId, olderThanMs).changes; }

  // ── outbox ──
  /** Insert if absent: replaying an event id and channel adds nothing (ICR-AB-0003 criterion 4). Returns whether it was new. */
  outboxAdd(m) {
    const r = this.db.prepare(`INSERT OR IGNORE INTO outbox (id, business_id, booking_id, event_id, event_type, channel, recipient, payload, due_ms, window_end_ms, created_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(m.id, this.businessId, m.bookingId, m.eventId, m.eventType, m.channel, m.recipient, JSON.stringify(m.payload), m.dueAt, m.windowEnd ?? null, this.store.clock.now());
    return r.changes > 0;
  }
  outboxDue(now) {
    return this.db.prepare("SELECT * FROM outbox WHERE business_id = ? AND status = 'pending' AND due_ms <= ? AND next_attempt_ms <= ? ORDER BY created_ms, id").all(this.businessId, now, now)
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }
  outboxMark(id, fields) {
    const cols = Object.keys(fields);
    this.db.prepare(`UPDATE outbox SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE business_id = ? AND id = ?`).run(...cols.map((c) => fields[c]), this.businessId, id);
  }
  /** A cancellation supersedes anything not yet sent for the booking (ICR-AB-0003: ordering). */
  outboxSupersede(bookingId, eventTypes) {
    const marks = eventTypes.map(() => '?').join(', ');
    return this.db.prepare(`UPDATE outbox SET status = 'superseded' WHERE business_id = ? AND booking_id = ? AND status = 'pending' AND event_type IN (${marks})`).run(this.businessId, bookingId, ...eventTypes).changes;
  }
  outboxForBooking(bookingId) {
    return this.db.prepare('SELECT id, event_type, channel, status, attempts, due_ms, sent_ms FROM outbox WHERE business_id = ? AND booking_id = ? ORDER BY created_ms, id').all(this.businessId, bookingId);
  }
  outboxStatusCounts() {
    return Object.fromEntries(this.db.prepare('SELECT status, COUNT(*) AS n FROM outbox WHERE business_id = ? GROUP BY status').all(this.businessId).map((r) => [r.status, r.n]));
  }

  // ── calendar connections and pending writes ──
  connections() { return this.db.prepare('SELECT * FROM calendar_connections WHERE business_id = ?').all(this.businessId); }
  connection(staffId) { return this.db.prepare('SELECT * FROM calendar_connections WHERE business_id = ? AND staff_id = ?').get(this.businessId, staffId) ?? null; }
  saveConnection(c) {
    this.db.prepare(`INSERT INTO calendar_connections (business_id, staff_id, token_sealed, subscription_id, subscription_expires_ms, last_synced_ms, needs_resync)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (business_id, staff_id) DO UPDATE SET token_sealed = excluded.token_sealed,
        subscription_id = excluded.subscription_id, subscription_expires_ms = excluded.subscription_expires_ms,
        last_synced_ms = excluded.last_synced_ms, needs_resync = excluded.needs_resync`)
      .run(this.businessId, c.staffId, c.tokenSealed, c.subscriptionId ?? null, c.subscriptionExpiresAt ?? null, c.lastSyncedAt ?? null, c.needsResync ? 1 : 0);
  }
  deleteConnection(staffId) {
    this.db.prepare('DELETE FROM calendar_connections WHERE business_id = ? AND staff_id = ?').run(this.businessId, staffId);
    this.db.prepare('DELETE FROM busy_times WHERE business_id = ? AND staff_id = ?').run(this.businessId, staffId);
  }
  calendarWriteAdd(w) {
    this.db.prepare('INSERT INTO calendar_writes (business_id, staff_id, booking_id, op, start_ms, end_ms, first_name, service_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.businessId, w.staffId, w.bookingId, w.op, w.start ?? null, w.end ?? null, w.firstName ?? null, w.serviceName ?? null);
  }
  calendarWritesDue(now) {
    return this.db.prepare("SELECT * FROM calendar_writes WHERE business_id = ? AND status = 'pending' AND next_attempt_ms <= ? ORDER BY id").all(this.businessId, now);
  }
  calendarWriteMark(id, fields) {
    const cols = Object.keys(fields);
    this.db.prepare(`UPDATE calendar_writes SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE business_id = ? AND id = ?`).run(...cols.map((c) => fields[c]), this.businessId, id);
  }
  /** The provider is back: pending writes need not wait out their backoff. */
  calendarWritesRetryNow(staffId) { this.db.prepare("UPDATE calendar_writes SET next_attempt_ms = 0 WHERE business_id = ? AND staff_id = ? AND status = 'pending'").run(this.businessId, staffId); }
  calendarWriteCount(status) { return this.db.prepare('SELECT COUNT(*) AS n FROM calendar_writes WHERE business_id = ? AND status = ?').get(this.businessId, status).n; }
}
