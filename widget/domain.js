// The booking logic, with no page in it, so it can be tested on its own and read beside the records
// it implements. Everything runs in memory: this is a stand-in for the Booking API of ICR-AB-0001,
// and it talks to nothing.
//
//   ADR-AB-0002  availability comes from a synchronised copy of staff calendars, and a live check
//                runs when a hold is confirmed, so a change the copy hasn't seen is still caught
//   ADR-AB-0003  choosing a slot creates a five-minute hold; holds and bookings are rows in one
//                table, and a row that overlaps an active one for the same staff member is rejected
//   ADR-AB-0005  every booking change queues messages; the demo shows them and sends none
//   ADR-AB-0006  rules are in the business's zone, bookings are UTC instants

import { BUSINESS, SERVICES, STAFF } from './data.js';
import { addDays, dateInZone, weekday, zonedTimeToUtc } from './time.js';

const MIN = 60000;
export const HOLD_MS = 5 * MIN;
export const NOTICE_MS = 60 * MIN;
export const HORIZON_DAYS = 21;
/** WCAG 2.2.1: a time limit must be extendable. Ten is the criterion's own floor. */
export const MAX_EXTENSIONS = 10;

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const stepMinutes = (service) => (service.minutes <= 15 ? 15 : 30);

function hash(text) {
  let h = 2166136261;
  for (const ch of text) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Every start the working-hour rules allow for one staff member, one service and one local date. */
export function ruleSlots(member, service, dateStr, timeZone) {
  const slots = [];
  for (const [from, to] of member.hours[weekday(dateStr)] ?? []) {
    const open = zonedTimeToUtc(dateStr, from, timeZone);
    const close = zonedTimeToUtc(dateStr, to, timeZone);
    if (open === null || close === null) continue;
    // Stepping in elapsed time keeps a skipped hour from producing slots that cannot exist.
    for (let start = open; start + service.minutes * MIN <= close; start += stepMinutes(service) * MIN) {
      slots.push({ staffId: member.id, serviceId: service.id, start, end: start + service.minutes * MIN });
    }
  }
  return slots;
}

/**
 * Busy time in the synchronised copy of a staff calendar: invented but repeatable (the same date
 * always gives the same blocks), so the demo has a believable week without a database.
 */
export function syncedBusy(member, dateStr, timeZone) {
  const windows = member.hours[weekday(dateStr)] ?? [];
  if (!windows.length) return [];
  const h = hash(`${member.id}/${dateStr}`);
  const blocks = [];
  for (let i = 0; i < h % 3; i++) {
    const [from, to] = windows[(h >>> (i + 2)) % windows.length];
    const open = zonedTimeToUtc(dateStr, from, timeZone);
    const close = zonedTimeToUtc(dateStr, to, timeZone);
    if (open === null || close === null) continue;
    const halfHours = Math.max(1, Math.floor((close - open) / (30 * MIN)) - 2);
    const start = open + ((h >>> (i + 5)) % halfHours) * 30 * MIN;
    blocks.push({ start, end: start + (((h >>> (i + 9)) & 1) ? 60 : 30) * MIN });
  }
  return blocks;
}

const randomToken = () => {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
};

export class Backend {
  constructor({ now = () => Date.now(), business = BUSINESS, services = SERVICES, staff = STAFF } = {}) {
    this.now = now;
    this.business = business;
    this.services = services;
    this.staff = staff;
    /** Holds and bookings share one table (ADR-AB-0003); `kind` tells them apart. */
    this.rows = [];
    /** Messages queued by booking changes (ADR-AB-0005). Nothing ever sends them. */
    this.outbox = [];
    this.seq = 0;
    this.idempotent = new Map();
    /** Demo control: the next hold loses a race to another customer. */
    this.raceNext = false;
    /** An event in a staff calendar that the synchronised copy has not caught up with yet. */
    this.liveOnly = this.#planLiveConflict();
  }

  serviceById(id) { return this.services.find((s) => s.id === id); }
  staffById(id) { return this.staff.find((s) => s.id === id); }

  /** The business's "today", read in its own zone. */
  today() { return dateInZone(this.now(), this.business.timeZone); }

  #planLiveConflict() {
    const alex = this.staffById('alex');
    const tz = this.business.timeZone;
    for (let n = 1; n <= 14; n++) {
      const date = addDays(this.today(), n);
      const start = zonedTimeToUtc(date, '10:00', tz);
      const slot = ruleSlots(alex, this.serviceById('followup'), date, tz).find((s) => s.start === start);
      if (slot && !syncedBusy(alex, date, tz).some((b) => overlaps(b, slot))) {
        return [{ staffId: 'alex', start, end: start + 30 * MIN, date }];
      }
    }
    return [];
  }

  /** What the demo tells the visitor to try: the slot whose live check will fail. */
  hints() {
    const c = this.liveOnly[0];
    return c ? { staff: this.staffById(c.staffId).name, start: c.start, date: c.date } : null;
  }

  #activeRows(staffId, ignoreId) {
    const now = this.now();
    return this.rows.filter((r) => r.staffId === staffId && r.id !== ignoreId && (r.kind === 'booking' || r.expiresAt > now));
  }

  /** The overlap constraint of ADR-AB-0003: true when the interval collides with an active row. */
  #collides(staffId, interval, ignoreId) {
    return this.#activeRows(staffId, ignoreId).some((r) => overlaps(r, interval));
  }

  #syncedBusyOverlaps(member, interval) {
    const tz = this.business.timeZone;
    return [dateInZone(interval.start, tz), dateInZone(interval.end - 1, tz)]
      .some((d) => syncedBusy(member, d, tz).some((b) => overlaps(b, interval)));
  }

  /** Free slots from the synchronised copy (GET .../availability). Times are UTC instants. */
  availability({ serviceId, from = this.today(), days = 14, staffId = null }) {
    const service = this.serviceById(serviceId);
    if (!service) throw new ApiError(404, 'unknown_service', 'No such service.');
    const tz = this.business.timeZone;
    const earliest = this.now() + NOTICE_MS;
    const slots = [];
    for (const member of this.staff) {
      if (!member.services.includes(serviceId) || (staffId && member.id !== staffId)) continue;
      for (let n = 0; n < Math.min(days, HORIZON_DAYS); n++) {
        const date = addDays(from, n);
        for (const slot of ruleSlots(member, service, date, tz)) {
          if (slot.start < earliest || this.#syncedBusyOverlaps(member, slot) || this.#collides(member.id, slot)) continue;
          slots.push(slot);
        }
      }
    }
    return slots.sort((a, b) => a.start - b.start || a.staffId.localeCompare(b.staffId));
  }

  /** The next few free slots after a given time, offered when the one chosen turns out to be taken. */
  #alternatives(serviceId, staffId, after) {
    const tz = this.business.timeZone;
    const free = this.availability({ serviceId, from: dateInZone(after, tz), days: 14 }).filter((s) => s.start > after);
    const sameStaff = free.filter((s) => s.staffId === staffId);
    return [...sameStaff.slice(0, 2), ...free.filter((s) => s.staffId !== staffId).slice(0, 2)]
      .sort((a, b) => a.start - b.start).slice(0, 3);
  }

  #once(key, scope, make) {
    if (!key) return make();
    const id = `${scope}:${key}`;
    if (!this.idempotent.has(id)) this.idempotent.set(id, make());
    return this.idempotent.get(id);
  }

  /** POST .../holds: hold a slot for five minutes. */
  createHold({ serviceId, staffId, start, idempotencyKey }) {
    return this.#once(idempotencyKey, 'hold', () => {
      const service = this.serviceById(serviceId);
      const member = this.staffById(staffId);
      if (!service || !member || !member.services.includes(serviceId)) throw new ApiError(422, 'invalid_request', 'That service is not offered by that person.');
      const tz = this.business.timeZone;
      const slot = ruleSlots(member, service, dateInZone(start, tz), tz).find((s) => s.start === start);
      if (!slot || start < this.now() + NOTICE_MS) throw new ApiError(422, 'not_bookable', 'That is not a bookable time.');

      if (this.raceNext) {
        this.raceNext = false;
        this.rows.push({ id: `hold-${++this.seq}`, kind: 'hold', staffId, serviceId, start: slot.start, end: slot.end, expiresAt: this.now() + HOLD_MS, other: true });
      }
      if (this.#syncedBusyOverlaps(member, slot) || this.#collides(staffId, slot)) {
        throw new ApiError(409, 'slot_taken', 'That time has just been taken.', { alternatives: this.#alternatives(serviceId, staffId, slot.start) });
      }
      const row = { id: `hold-${++this.seq}`, kind: 'hold', staffId, serviceId, start: slot.start, end: slot.end, expiresAt: this.now() + HOLD_MS, extensions: 0 };
      this.rows.push(row);
      return this.#view(row);
    });
  }

  #hold(holdId) {
    const row = this.rows.find((r) => r.id === holdId && r.kind === 'hold');
    if (!row || row.expiresAt <= this.now()) throw new ApiError(410, 'hold_expired', 'Your hold on that time has ended.');
    return row;
  }

  /** Keep holding the same slot for another five minutes (WCAG 2.2.1: time limits can be extended). */
  extendHold(holdId) {
    const row = this.#hold(holdId);
    if (row.extensions >= MAX_EXTENSIONS) throw new ApiError(409, 'too_many_extensions', 'This time can’t be held any longer.');
    row.extensions += 1;
    row.expiresAt = this.now() + HOLD_MS;
    return this.#view(row);
  }

  /**
   * Let go of a hold, so a customer who changes their mind doesn't block their own first choice.
   * A demo convenience: ICR-AB-0001 has no such operation, which is a finding for the contract.
   */
  releaseHold(holdId) {
    this.rows = this.rows.filter((r) => !(r.id === holdId && r.kind === 'hold'));
  }

  /** The live calendar check of ADR-AB-0002, run for the one slot at the moment it matters. */
  #liveCheck(row) {
    const clash = this.liveOnly.some((e) => e.staffId === row.staffId && overlaps(e, row));
    if (!clash) return;
    this.rows = this.rows.filter((r) => r !== row);
    throw new ApiError(409, 'calendar_conflict', 'That time is no longer free in the calendar.', {
      alternatives: this.#alternatives(row.serviceId, row.staffId, row.start),
    });
  }

  #queue(type, row, extra = {}) {
    this.outbox.push({ type, bookingId: row.id, at: this.now(), ...extra });
  }

  /** POST /holds/{id}/confirm: turn the hold into a booking, after the live check. */
  confirmHold(holdId, details, { idempotencyKey } = {}) {
    return this.#once(idempotencyKey, 'confirm', () => {
      const row = this.#hold(holdId);
      this.#liveCheck(row);
      delete row.expiresAt;
      delete row.extensions;
      Object.assign(row, { kind: 'booking', id: `booking-${++this.seq}`, customer: { ...details }, token: randomToken() });
      this.#queue('confirmation', row);
      this.#queue('reminder', row, { sendAt: row.start - 24 * 60 * MIN });
      return { ...this.#view(row), token: row.token };
    });
  }

  #booking(bookingId, token) {
    const row = this.rows.find((r) => r.id === bookingId && r.kind === 'booking');
    if (!row) throw new ApiError(404, 'not_found', 'No such booking.');
    if (row.token !== token) throw new ApiError(403, 'forbidden', 'That link does not manage this booking.');
    return row;
  }

  getBooking(bookingId, token) { return this.#view(this.#booking(bookingId, token)); }

  /** PATCH /bookings/{id}: move a booking to a new, already-held slot of the same service. */
  reschedule(bookingId, token, holdId) {
    const booking = this.#booking(bookingId, token);
    const hold = this.#hold(holdId);
    if (hold.serviceId !== booking.serviceId) throw new ApiError(422, 'invalid_request', 'A booking can only move to a time for the same service.');
    this.#liveCheck(hold);
    this.rows = this.rows.filter((r) => r !== hold);
    Object.assign(booking, { staffId: hold.staffId, start: hold.start, end: hold.end });
    this.#queue('rescheduled', booking);
    return { ...this.#view(booking), token: booking.token };
  }

  /** DELETE /bookings/{id}. */
  cancel(bookingId, token) {
    const booking = this.#booking(bookingId, token);
    this.rows = this.rows.filter((r) => r !== booking);
    this.#queue('cancelled', booking);
  }

  #view(row) {
    const { id, kind, staffId, serviceId, start, end, expiresAt, customer } = row;
    return { id, kind, staffId, serviceId, start, end, ...(expiresAt ? { expiresAt } : {}), ...(customer ? { customer: { ...customer } } : {}) };
  }
}

/** Groups slots by local date in a zone, for the day picker. */
export function groupByDay(slots, timeZone) {
  const days = new Map();
  for (const slot of slots) {
    const date = dateInZone(slot.start, timeZone);
    if (!days.has(date)) days.set(date, []);
    days.get(date).push(slot);
  }
  return days;
}
