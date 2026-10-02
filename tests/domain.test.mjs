import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Backend, ApiError, ruleSlots, HOLD_MS, MAX_EXTENSIONS, NOTICE_MS } from '../widget/domain.js';
import { addDays, dateInZone, zonedParts, zonedTimeToUtc } from '../widget/time.js';
import { STAFF, SERVICES } from '../widget/data.js';

const SYDNEY = 'Australia/Sydney';
const MIN = 60000;

/** A backend on a clock the test controls. Monday 28 Sep 2026, 10:00 in Sydney. */
function setup() {
  const clock = { t: Date.UTC(2026, 8, 28, 0, 0) };
  const backend = new Backend({ now: () => clock.t });
  return { clock, backend, firstSlot: (serviceId = 'followup', staffId = 'sam') => backend.availability({ serviceId, staffId })[0] };
}
const rejects = (fn, status, code) => assert.throws(fn, (e) => e instanceof ApiError && e.status === status && (!code || e.code === code));

// ── time zones (ADR-AB-0006) ────────────────────────────────────────────────────────────────────────

test('working hours are local: 9 am is 9 am before and after daylight saving starts', () => {
  assert.equal(zonedTimeToUtc('2026-10-02', '09:00', SYDNEY), Date.UTC(2026, 9, 1, 23, 0), 'AEST, UTC+10');
  assert.equal(zonedTimeToUtc('2026-10-05', '09:00', SYDNEY), Date.UTC(2026, 9, 4, 22, 0), 'AEDT, UTC+11');
  const sam = STAFF.find((s) => s.id === 'sam');
  const review = SERVICES.find((s) => s.id === 'review');
  for (const date of ['2026-10-02', '2026-10-05']) {
    assert.equal(zonedParts(ruleSlots(sam, review, date, SYDNEY)[0].start, SYDNEY).h, 9, date);
  }
});

test('the skipped hour does not exist, and the repeated hour is read as its first occurrence', () => {
  assert.equal(zonedTimeToUtc('2026-10-04', '02:30', SYDNEY), null, 'clocks go 2:00 -> 3:00');
  assert.equal(zonedTimeToUtc('2027-04-04', '02:30', SYDNEY), Date.UTC(2027, 3, 3, 15, 30), 'happens twice; the first is AEDT');
});

test('a window across the changeover produces no slot in the skipped hour', () => {
  const night = { id: 'night', hours: { 0: [['01:00', '04:00']] } };
  const slots = ruleSlots(night, { id: 'x', minutes: 30 }, '2026-10-04', SYDNEY);
  assert.equal(slots.length, 4, 'two real hours of 30-minute slots');
  assert.ok(slots.every((s) => zonedParts(s.start, SYDNEY).h !== 2));
});

test('calendar arithmetic on dates ignores daylight saving', () => {
  assert.equal(addDays('2026-10-03', 1), '2026-10-04');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(dateInZone(Date.UTC(2026, 8, 27, 23, 0), SYDNEY), '2026-09-28');
});

test('the pretend calendar never fails, whatever the date: every day for two years, every person', async () => {
  // A signed shift on an unsigned hash once made some days throw "undefined is not iterable".
  const { syncedBusy } = await import('../widget/domain.js');
  let blocks = 0;
  for (const member of STAFF) {
    for (let n = 0; n < 730; n++) {
      const date = addDays('2026-01-01', n);
      for (const b of syncedBusy(member, date, SYDNEY)) {
        blocks++;
        assert.ok(Number.isFinite(b.start) && b.end > b.start, `${member.id} ${date}`);
      }
    }
  }
  assert.ok(blocks > 500, 'and there is busy time to find');
});

// ── availability (ADR-AB-0002) ──────────────────────────────────────────────────────────────────────

test('availability respects notice, working hours and the synchronised calendar', () => {
  const { clock, backend } = setup();
  const slots = backend.availability({ serviceId: 'followup', staffId: 'sam', days: 7 });
  assert.ok(slots.length > 20);
  assert.ok(slots.every((s) => s.start >= clock.t + NOTICE_MS), 'at least an hour ahead');
  assert.ok(slots.every((s) => { const p = zonedParts(s.start, SYDNEY); return p.h >= 9 && p.h < 17; }));
  assert.ok(slots.every((s) => ![0, 6].includes(new Date(s.start + 11 * 60 * MIN).getUTCDay())), 'no weekends');
  assert.deepEqual(backend.availability({ serviceId: 'followup', staffId: 'sam', days: 7 }), slots, 'repeatable');
});

test('a service is only offered by the people who provide it', () => {
  const { backend } = setup();
  assert.ok(backend.availability({ serviceId: 'initial' }).every((s) => s.staffId !== 'jo'));
  rejects(() => backend.availability({ serviceId: 'nope' }), 404);
});

// ── holds and the overlap constraint (ADR-AB-0003) ──────────────────────────────────────────────────

test('choosing a slot holds it for five minutes, and it disappears from availability', () => {
  const { clock, backend } = setup();
  // A slot well beyond the notice window, so it is still bookable when the hold ends.
  const slot = backend.availability({ serviceId: 'followup', staffId: 'sam' }).find((s) => s.start > clock.t + 3 * 60 * MIN);
  const hold = backend.createHold({ serviceId: 'followup', staffId: 'sam', start: slot.start });
  assert.equal(hold.expiresAt, clock.t + HOLD_MS);
  assert.ok(!backend.availability({ serviceId: 'followup', staffId: 'sam' }).some((s) => s.start === slot.start));
  clock.t += HOLD_MS;
  assert.ok(backend.availability({ serviceId: 'followup', staffId: 'sam' }).some((s) => s.start === slot.start), 'an expired hold frees the slot');
});

test('two customers, one slot: the second is rejected and offered alternatives', () => {
  const { backend, firstSlot } = setup();
  const slot = firstSlot();
  backend.createHold({ serviceId: 'followup', staffId: 'sam', start: slot.start });
  assert.throws(() => backend.createHold({ serviceId: 'followup', staffId: 'sam', start: slot.start }), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.code, 'slot_taken');
    assert.ok(e.alternatives.length > 0 && e.alternatives.length <= 3);
    assert.ok(e.alternatives.every((a) => a.start > slot.start));
    return true;
  });
});

test('the constraint is about time, not service: an overlapping slot of another service is rejected', () => {
  const { backend } = setup();
  const initial = backend.availability({ serviceId: 'initial', staffId: 'sam' })[0];
  backend.createHold({ serviceId: 'initial', staffId: 'sam', start: initial.start });
  const review = backend.availability({ serviceId: 'review', staffId: 'sam' }).find((s) => s.start > initial.start);
  assert.ok(review.start >= initial.end, 'availability already excludes the overlap');
  rejects(() => backend.createHold({ serviceId: 'review', staffId: 'sam', start: initial.start + 30 * MIN }), 409);
});

test('different staff can be held at the same time', () => {
  const { backend } = setup();
  const both = backend.availability({ serviceId: 'followup', days: 7 }).find((s, i, all) => all.some((o) => o.start === s.start && o.staffId !== s.staffId));
  const other = backend.availability({ serviceId: 'followup', days: 7 }).find((o) => o.start === both.start && o.staffId !== both.staffId);
  backend.createHold({ serviceId: 'followup', staffId: both.staffId, start: both.start });
  assert.doesNotThrow(() => backend.createHold({ serviceId: 'followup', staffId: other.staffId, start: other.start }));
});

test('the demo’s “another customer” control makes the next hold lose a race', () => {
  const { backend, firstSlot } = setup();
  const slot = firstSlot();
  backend.raceNext = true;
  rejects(() => backend.createHold({ serviceId: 'followup', staffId: 'sam', start: slot.start }), 409, 'slot_taken');
  assert.ok(!backend.availability({ serviceId: 'followup', staffId: 'sam' }).some((s) => s.start === slot.start), 'the other customer holds it');
  assert.equal(backend.raceNext, false, 'the control is spent');
});

test('only bookable times can be held', () => {
  const { backend, firstSlot } = setup();
  rejects(() => backend.createHold({ serviceId: 'followup', staffId: 'sam', start: firstSlot().start + 7 * MIN }), 422, 'not_bookable');
  rejects(() => backend.createHold({ serviceId: 'initial', staffId: 'jo', start: firstSlot().start }), 422);
});

test('a repeated request with the same idempotency key returns the same hold', () => {
  const { backend, firstSlot } = setup();
  const slot = firstSlot();
  const a = backend.createHold({ serviceId: 'followup', staffId: 'sam', start: slot.start, idempotencyKey: 'k1' });
  const b = backend.createHold({ serviceId: 'followup', staffId: 'sam', start: slot.start, idempotencyKey: 'k1' });
  assert.equal(a.id, b.id);
  assert.equal(backend.rows.length, 1);
});

test('a hold can be extended, up to the limit, and then it cannot', () => {
  const { clock, backend, firstSlot } = setup();
  const hold = backend.createHold({ serviceId: 'followup', staffId: 'sam', start: firstSlot().start });
  clock.t += 4 * MIN;
  const again = backend.extendHold(hold.id);
  assert.equal(again.expiresAt, clock.t + HOLD_MS);
  clock.t += HOLD_MS - MIN;
  assert.doesNotThrow(() => backend.extendHold(hold.id), 'still held because it was extended');
  for (let i = 2; i < MAX_EXTENSIONS; i++) backend.extendHold(hold.id);
  rejects(() => backend.extendHold(hold.id), 409, 'too_many_extensions');
  clock.t += HOLD_MS;
  rejects(() => backend.extendHold(hold.id), 410, 'hold_expired');
});

test('releasing a hold frees the time at once, so a customer can re-choose it', () => {
  const { backend, firstSlot } = setup();
  const slot = firstSlot();
  const hold = backend.createHold({ serviceId: 'followup', staffId: 'sam', start: slot.start });
  backend.releaseHold(hold.id);
  assert.ok(backend.availability({ serviceId: 'followup', staffId: 'sam' }).some((s) => s.start === slot.start));
  assert.doesNotThrow(() => backend.createHold({ serviceId: 'followup', staffId: 'sam', start: slot.start }));
});

// ── confirming (ADR-AB-0002, ADR-AB-0005) ───────────────────────────────────────────────────────────

const CUSTOMER = { name: 'Sample Customer', email: 'sample.customer@example.com', phone: '0400 000 000' };

test('confirming turns the hold into a booking and queues a confirmation and a reminder, sending nothing', () => {
  const { backend, firstSlot } = setup();
  const slot = firstSlot();
  const hold = backend.createHold({ serviceId: 'followup', staffId: 'sam', start: slot.start });
  const booking = backend.confirmHold(hold.id, CUSTOMER);
  assert.equal(booking.kind, 'booking');
  assert.equal(booking.start, slot.start);
  assert.ok(booking.token.length >= 24);
  assert.deepEqual(backend.outbox.map((m) => m.type), ['confirmation', 'reminder']);
  assert.equal(backend.outbox[1].sendAt, slot.start - 24 * 60 * MIN);
  assert.ok(!backend.availability({ serviceId: 'followup', staffId: 'sam' }).some((s) => s.start === slot.start), 'the booking keeps the slot');
  rejects(() => backend.confirmHold(hold.id, CUSTOMER), 410, 'hold_expired');
});

test('confirming after the hold has ended is refused', () => {
  const { clock, backend, firstSlot } = setup();
  const hold = backend.createHold({ serviceId: 'followup', staffId: 'sam', start: firstSlot().start });
  clock.t += HOLD_MS;
  rejects(() => backend.confirmHold(hold.id, CUSTOMER), 410, 'hold_expired');
});

test('the live check catches a calendar change the synchronised copy has not seen', () => {
  const { backend } = setup();
  const hint = backend.hints();
  assert.equal(hint.staff, 'Alex');
  assert.ok(backend.availability({ serviceId: 'followup', staffId: 'alex', days: 14 }).some((s) => s.start === hint.start), 'the copy still shows it free');
  const hold = backend.createHold({ serviceId: 'followup', staffId: 'alex', start: hint.start });
  assert.throws(() => backend.confirmHold(hold.id, CUSTOMER), (e) => {
    assert.equal(e.status, 409);
    assert.equal(e.code, 'calendar_conflict');
    assert.ok(e.alternatives.length > 0, 'the next free times are offered at once, not an error');
    assert.ok(e.alternatives.every((a) => a.start > hint.start));
    return true;
  });
  assert.equal(backend.outbox.length, 0, 'nothing is queued for a booking that did not happen');
  assert.ok(!backend.rows.some((r) => r.id === hold.id), 'the failed hold is released');
});

// ── managing a booking ──────────────────────────────────────────────────────────────────────────────

function booked() {
  const ctx = setup();
  const slots = ctx.backend.availability({ serviceId: 'followup', staffId: 'sam', days: 7 });
  const booking = ctx.backend.confirmHold(ctx.backend.createHold({ serviceId: 'followup', staffId: 'sam', start: slots[0].start }).id, CUSTOMER);
  return { ...ctx, booking, next: slots.find((s) => s.start >= slots[0].end) };
}

test('rescheduling moves the booking, frees the old time and queues a message', () => {
  const { backend, booking, next } = booked();
  const hold = backend.createHold({ serviceId: 'followup', staffId: 'sam', start: next.start });
  const moved = backend.reschedule(booking.id, booking.token, hold.id);
  assert.equal(moved.start, next.start);
  assert.ok(backend.availability({ serviceId: 'followup', staffId: 'sam' }).some((s) => s.start === booking.start), 'the old time is free again');
  assert.equal(backend.outbox.at(-1).type, 'rescheduled');
  assert.equal(backend.rows.filter((r) => r.kind === 'booking').length, 1);
});

test('a booking can only be managed with its own token, and only moved to the same service', () => {
  const { backend, booking, next } = booked();
  rejects(() => backend.getBooking(booking.id, 'wrong'), 403, 'forbidden');
  rejects(() => backend.cancel(booking.id, 'wrong'), 403);
  const review = backend.availability({ serviceId: 'review', staffId: 'sam' })[0];
  const hold = backend.createHold({ serviceId: 'review', staffId: 'sam', start: review.start });
  rejects(() => backend.reschedule(booking.id, booking.token, hold.id), 422);
  assert.ok(next);
});

test('cancelling frees the time and queues a message', () => {
  const { backend, booking } = booked();
  backend.cancel(booking.id, booking.token);
  assert.ok(backend.availability({ serviceId: 'followup', staffId: 'sam' }).some((s) => s.start === booking.start));
  assert.equal(backend.outbox.at(-1).type, 'cancelled');
  rejects(() => backend.getBooking(booking.id, booking.token), 404);
});

// ── the demo's promises ─────────────────────────────────────────────────────────────────────────────

test('only the API-mode files can reach a network, and nothing anywhere keeps anything', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const sources = ['widget', 'js'].flatMap((dir) => readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ f: `${dir}/${f}`, text: readFileSync(join(root, dir, f), 'utf8') })));
  assert.ok(sources.length >= 8, `expected the widget and host scripts, found ${sources.map((s) => s.f).join(', ')}`);
  // widget/api.js and widget/panel.js are the API mode. On the public site their requests cannot happen:
  // that build's content security policy has connect-src 'none' (tested in the browser tests).
  const apiMode = new Set(['widget/api.js', 'widget/panel.js']);
  const strip = (text) => text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const { f, text } of sources) {
    const code = strip(text);
    if (!apiMode.has(f)) {
      for (const banned of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon']) assert.ok(!code.includes(banned), `${f} must not use ${banned}`);
    }
    for (const banned of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) assert.ok(!code.includes(banned), `${f} must not use ${banned}`);
  }
  for (const page of ['index.html', 'widget/index.html']) {
    assert.match(readFileSync(join(root, page), 'utf8'), /connect-src 'none'/, `${page} forbids all requests`);
  }
});
