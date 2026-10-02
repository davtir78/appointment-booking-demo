// ICR-AB-0001 Booking API: its six acceptance criteria, then the rest of the contract and the
// database rule of ADR-AB-0003. Titles that begin "[ICR-AB-0001 #n]" are the criteria; the README's
// conformance table names them, and tests/conformance.test.mjs fails if one goes missing.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { boot, CUSTOMER, DAY, DEMO_BUSINESS, DEMO_KEY, HOUR, idem, MIN, ORIGIN, OTHER_BUSINESS, OTHER_KEY, START } from './helpers.mjs';

const running = [];
const start = async (opts) => { const s = await boot(opts); running.push(s); return s; };
after(async () => { for (const s of running) await s.close(); });

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const TIME_KEYS = new Set(['start', 'end', 'expiresAt', 'serverTime', 'generatedAt']);
function timesIn(value, found = []) {
  if (Array.isArray(value)) value.forEach((v) => timesIn(v, found));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { if (TIME_KEYS.has(k)) found.push([k, v]); else timesIn(v, found); }
  return found;
}

// ── the six acceptance criteria ─────────────────────────────────────────────────────────────────────

test('[ICR-AB-0001 #1] a seven-day search returns in under 400 ms at p95', async () => {
  const s = await start();
  const times = [];
  for (let i = 0; i < 120; i++) {
    s.clock.advance(1000); // a second between requests keeps the rate limit out of a latency test
    const t = performance.now();
    const r = await s.api.availability('followup', { from: '2026-09-28', to: '2026-10-04' });
    times.push(performance.now() - t);
    assert.equal(r.status, 200);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  assert.ok(p95 < 400, `p95 was ${p95.toFixed(1)} ms`);
});

test('[ICR-AB-0001 #2] fifty simultaneous attempts at one slot give exactly one hold and 49 conflicts that list alternatives', async () => {
  const s = await start();
  const slot = await s.pick();
  s.clock.advance(2000); // refill the rate limit after set-up, so all fifty are admitted
  const results = await Promise.all(Array.from({ length: 50 }, () => s.api.hold(slot)));
  const ok = results.filter((r) => r.status === 201);
  const conflicts = results.filter((r) => r.status === 409);
  assert.equal(ok.length, 1);
  assert.equal(conflicts.length, 49);
  assert.ok(conflicts.every((r) => r.json.code === 'slot_taken' && r.json.alternatives.length > 0 && r.json.alternatives.length <= 3));
  assert.equal(s.ctx().store.scope(DEMO_BUSINESS).allRows().filter((r) => r.staffId === slot.staffId && r.start === Date.parse(slot.start)).length, 1, 'one row in the database');
});

test('[ICR-AB-0001 #2] fifty simultaneous confirmations of one hold give exactly one booking and 49 conflicts', async () => {
  const s = await start();
  const slot = await s.pick();
  const hold = (await s.api.hold(slot)).json;
  s.clock.advance(2000);
  const results = await Promise.all(Array.from({ length: 50 }, () => s.api.confirm(hold.id)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  const conflicts = results.filter((r) => r.status === 409);
  assert.equal(conflicts.length, 49);
  assert.ok(conflicts.every((r) => r.json.alternatives.length > 0));
  assert.equal(s.ctx().store.scope(DEMO_BUSINESS).allRows().filter((r) => r.kind === 'booking').length, 1);
});

test('[ICR-AB-0001 #3] a request from a domain not registered for the widget key receives 403', async () => {
  const s = await start();
  const url = `/v1/businesses/${DEMO_BUSINESS}/services`;
  assert.equal((await s.call('GET', url, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await s.call('GET', url, { origin: null, headers: { origin: 'https://evil.example' } })).status, 403, 'the browser’s own Origin header counts too');
  assert.equal((await s.call('GET', url, { origin: null })).status, 403, 'no origin at all is not a registered one');
  assert.equal((await s.call('GET', url)).status, 200, 'the registered domain is fine');
  const refused = await s.call('GET', url, { origin: 'https://evil.example' });
  assert.equal(refused.json.code, 'origin_not_registered');
  assert.match(refused.headers.get('content-type'), /application\/problem\+json/);
});

test('[ICR-AB-0001 #4] a repeated POST with the same idempotency key creates nothing new and returns the original result', async () => {
  const s = await start();
  const slot = (await s.slots())[0];
  const key = idem();
  const first = await s.api.hold(slot, { key });
  const again = await s.api.hold(slot, { key });
  assert.equal(first.status, 201);
  assert.equal(again.status, 201);
  assert.equal(again.json.id, first.json.id);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.equal(s.ctx().store.scope(DEMO_BUSINESS).allRows().length, 1);

  const confirmKey = idem();
  const booked = await s.api.confirm(first.json.id, CUSTOMER, { key: confirmKey });
  const rebooked = await s.api.confirm(first.json.id, CUSTOMER, { key: confirmKey });
  assert.equal(rebooked.json.id, booked.json.id);
  assert.equal(rebooked.json.token, booked.json.token);
  assert.equal(s.ctx().store.scope(DEMO_BUSINESS).allRows().filter((r) => r.kind === 'booking').length, 1);

  const reused = await s.api.hold({ ...slot, staffId: slot.staffId }, { key });
  assert.equal(reused.status, 201, 'the same request again is still the same answer');
  const different = await s.call('POST', `/v1/businesses/${DEMO_BUSINESS}/holds`, { body: { serviceId: 'followup', staffId: slot.staffId, start: Date.parse(slot.start) + 30 * MIN }, headers: { 'idempotency-key': key } });
  assert.equal(different.status, 422, 'the same key with a different request is refused, not guessed at');
});

test('[ICR-AB-0001 #5] every time in every response is an ISO 8601 instant with an offset', async () => {
  const s = await start();
  const seen = [];
  const note = (r) => { seen.push(...timesIn(r.json)); return r; };
  note(await s.api.services());
  const avail = note(await s.api.availability());
  const hold = note(await s.api.hold(avail.json.slots[0]));
  note(await s.api.extend(hold.json.id));
  const booked = note(await s.api.confirm(hold.json.id));
  note(await s.api.booking(booked.json.id, booked.json.token));
  const hold2 = note(await s.api.hold(avail.json.slots.find((x) => Date.parse(x.start) >= Date.parse(avail.json.slots[0].end) + HOUR)));
  note(await s.api.reschedule(booked.json.id, booked.json.token, hold2.json.id));
  const conflict = note(await s.api.hold(avail.json.slots[0]));
  assert.equal(conflict.status, 201, 'the old time was freed by rescheduling');
  note(await s.api.hold(avail.json.slots.find((x) => Date.parse(x.start) >= Date.parse(avail.json.slots[0].end) + HOUR)));
  const taken = note(await s.api.hold(avail.json.slots[0]));
  assert.equal(taken.status, 409);
  assert.ok(seen.length > 20, `checked ${seen.length} times`);
  for (const [key, value] of seen) assert.match(String(value), ISO, `${key} = ${value}`);
  assert.ok(seen.every(([, v]) => typeof v === 'string'), 'never a bare number');
});

test('[ICR-AB-0001 #6] no log line contains a customer’s name, email address or phone number', async () => {
  const s = await start();
  const { booking, slot } = await s.book();
  const later = (await s.slots()).find((x) => Date.parse(x.start) >= Date.parse(slot.end) + HOUR);
  const hold = await s.api.hold(later);
  await s.api.reschedule(booking.id, booking.token, hold.json.id);
  await s.api.confirm('hold_doesnotexist', CUSTOMER);
  await s.api.confirm(hold.json.id, { name: CUSTOMER.name, email: 'not-an-email' });
  await s.api.cancel(booking.id, booking.token);
  s.app.tick();
  const log = s.ctx().log.lines().join('\n');
  assert.ok(log.length > 500, 'there is a log to search');
  for (const secret of [CUSTOMER.name, 'Zephyr', 'Quillfeather', CUSTOMER.email, CUSTOMER.phone, '0411 999', 'example.com/manage']) {
    assert.ok(!log.includes(secret), `the log must not contain “${secret}”`);
  }
});

// ── the rest of the contract ────────────────────────────────────────────────────────────────────────

test('the operations of the contract exist under /v1 and return the shapes the widget needs', async () => {
  const s = await start();
  const services = await s.api.services();
  assert.equal(services.status, 200);
  assert.deepEqual(services.json.services.map((x) => x.id), ['initial', 'followup', 'review']);
  assert.equal(services.json.business.timeZone, 'Australia/Sydney');
  const slot = (await s.slots())[0];
  assert.ok(slot.staffId && slot.start && slot.end);
  const hold = await s.api.hold(slot);
  assert.equal(hold.status, 201);
  assert.equal(Date.parse(hold.json.expiresAt) - s.clock.now(), 5 * MIN, 'a hold lasts five minutes');
  const booked = await s.api.confirm(hold.json.id);
  assert.equal(booked.json.status, 'confirmed');
  assert.ok(booked.json.token.length >= 32);
  assert.equal((await s.api.booking(booked.json.id, booked.json.token)).json.id, booked.json.id);
});

test('error codes carry the meanings the contract gives them, as RFC 9457 problem details', async () => {
  const s = await start();
  const url = `/v1/businesses/${DEMO_BUSINESS}`;
  const cases = [
    [400, await s.call('GET', `${url}/availability`), 'a missing service'],
    [400, await s.call('GET', `${url}/availability?service=followup&from=tomorrow`), 'a bad date'],
    [401, await s.call('GET', `${url}/services`, { key: 'pk_unknown' }), 'an unknown key'],
    [401, await s.call('GET', `${url}/services`, { key: null }), 'no key'],
    [404, await s.call('GET', '/v1/bookings/bk_nothing', { headers: { 'x-booking-token': 'x' } }), 'an unknown booking'],
    [404, await s.call('GET', `${url}/nothing`), 'an unknown operation'],
    [404, await s.call('GET', `/v2/businesses/${DEMO_BUSINESS}/services`), 'a version that does not exist'],
    [400, await s.call('POST', `${url}/holds`, { body: { serviceId: 'followup' } }), 'a hold with no idempotency key'],
    [415, await s.call('POST', `${url}/holds`, { body: 'x', headers: { 'idempotency-key': idem(), 'content-type': 'text/plain' } }), 'the wrong media type'],
    [413, await s.call('POST', `${url}/holds`, { body: JSON.stringify({ pad: 'x'.repeat(20000) }), headers: { 'idempotency-key': idem() } }), 'a body over 16 KB'],
    [404, await s.api.confirm('hold_doesnotexist'), 'a hold that does not exist'],
  ];
  for (const [status, r, why] of cases) {
    assert.equal(r.status, status, why);
    assert.match(r.headers.get('content-type') ?? '', /application\/problem\+json/, why);
    assert.equal(r.json.status, status, why);
    assert.ok(r.json.code && r.json.title && r.json.detail && r.json.type, why);
  }
});

test('a hold expires after five minutes (410), and the time can then be held again', async () => {
  const s = await start();
  const slot = await s.pick();
  const hold = (await s.api.hold(slot)).json;
  s.clock.advance(5 * MIN + 1000);
  const late = await s.api.confirm(hold.id);
  assert.equal(late.status, 410);
  assert.equal(late.json.code, 'hold_expired');
  assert.equal((await s.api.hold(slot)).status, 201, 'the same time is free again');
});

test('429 with Retry-After beyond fifty requests a second, per business', async () => {
  const s = await start();
  const results = [];
  for (let i = 0; i < 60; i++) results.push(await s.api.services());
  assert.equal(results.filter((r) => r.status === 200).length, 50);
  const limited = results.filter((r) => r.status === 429);
  assert.equal(limited.length, 10);
  assert.ok(Number(limited[0].headers.get('retry-after')) >= 1);
  assert.equal(limited[0].json.code, 'rate_limited');
  s.clock.advance(1000);
  assert.equal((await s.api.services()).status, 200, 'and it recovers');
  // Another business has its own allowance.
  const other = await s.call('GET', `/v1/businesses/${OTHER_BUSINESS}/services`, { key: OTHER_KEY });
  assert.equal(other.status, 200);
});

test('traceparent is accepted, continued and returned on every response', async () => {
  const s = await start();
  const traceId = 'ab'.repeat(16);
  const r = await s.call('GET', `/v1/businesses/${DEMO_BUSINESS}/services`, { headers: { traceparent: `00-${traceId}-${'cd'.repeat(8)}-01` } });
  assert.match(r.headers.get('traceparent'), new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`), 'the caller’s trace continues');
  const fresh = await s.call('GET', `/v1/businesses/${DEMO_BUSINESS}/services`);
  assert.match(fresh.headers.get('traceparent'), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/, 'one is made when absent');
  const refused = await s.call('GET', `/v1/businesses/${DEMO_BUSINESS}/services`, { key: 'pk_unknown' });
  assert.ok(refused.headers.get('traceparent'), 'even a refusal carries one');
  assert.ok(s.ctx().log.all().some((e) => e.component === 'gateway' && e.traceId === traceId), 'and the log is findable by it');
});

test('a business sees only its own data: the other clinic’s key cannot read or touch it (ADR-AB-0004)', async () => {
  const s = await start();
  const { hold, booking } = await s.book();
  const asOther = (method, path, opts = {}) => s.call(method, path, { key: OTHER_KEY, ...opts });
  assert.equal((await asOther('GET', `/v1/businesses/${DEMO_BUSINESS}/services`)).status, 404, 'its key does not open another business’s path');
  assert.equal((await asOther('POST', `/v1/holds/${hold.id}/extend`)).status, 404);
  assert.equal((await asOther('POST', `/v1/holds/${hold.id}/confirm`, { body: { customer: CUSTOMER }, headers: { 'idempotency-key': idem() } })).status, 404);
  assert.equal((await asOther('GET', `/v1/bookings/${booking.id}`, { headers: { 'x-booking-token': booking.token } })).status, 404, 'even with the right token');
  assert.equal((await asOther('DELETE', `/v1/bookings/${booking.id}`, { headers: { 'x-booking-token': booking.token } })).status, 404);
  const own = await asOther('GET', `/v1/businesses/${OTHER_BUSINESS}/availability?service=consult`);
  assert.equal(own.status, 200);
  assert.deepEqual([...new Set(own.json.slots.map((x) => x.staffId))], ['kim']);
  assert.equal(s.ctx().store.scope(OTHER_BUSINESS).allRows().length, 0, 'nothing of the first clinic’s is in the second’s scope');
});

test('a booking is managed only with its own token, and not once the appointment has passed', async () => {
  const s = await start();
  const { booking } = await s.book();
  assert.equal((await s.api.booking(booking.id, 'wrong')).status, 403);
  assert.equal((await s.api.cancel(booking.id, '')).status, 403);
  assert.equal((await s.api.booking(booking.id, booking.token)).status, 200);
  s.clock.advance(3 * DAY);
  const gone = await s.api.booking(booking.id, booking.token);
  assert.equal(gone.status, 403);
  assert.equal(gone.json.code, 'token_expired');
});

test('rescheduling moves the booking and frees the old time; cancelling frees the time', async () => {
  const s = await start();
  const { slot, booking } = await s.book();
  const later = (await s.slots()).find((x) => Date.parse(x.start) >= Date.parse(slot.end) + HOUR);
  const hold = (await s.api.hold(later)).json;
  const moved = await s.api.reschedule(booking.id, booking.token, hold.id);
  assert.equal(moved.status, 200);
  assert.equal(moved.json.start, later.start);
  assert.ok((await s.slots()).some((x) => x.start === slot.start && x.staffId === slot.staffId), 'the old time is free');
  assert.equal((await s.api.cancel(booking.id, booking.token)).status, 204);
  assert.ok((await s.slots()).some((x) => x.start === later.start && x.staffId === later.staffId), 'and so is the new one');
  const review = await s.slots('review');
  const wrongService = (await s.api.hold(review[0], { service: 'review' })).json;
  const b2 = await s.book();
  assert.equal((await s.api.reschedule(b2.booking.id, b2.booking.token, wrongService.id)).status, 422, 'only to a time for the same service');
});

test('holds can be extended and released (proposed additions to the contract)', async () => {
  const s = await start();
  const slot = await s.pick();
  const hold = (await s.api.hold(slot)).json;
  s.clock.advance(4 * MIN);
  const extended = await s.api.extend(hold.id);
  assert.equal(Date.parse(extended.json.expiresAt), s.clock.now() + 5 * MIN);
  s.clock.advance(4 * MIN);
  assert.equal((await s.api.extend(hold.id)).status, 200, 'still held because it was extended');
  assert.equal((await s.api.release(hold.id)).status, 204);
  assert.equal((await s.api.hold(slot)).status, 201, 'released, so free at once');
  s.clock.advance(6 * MIN);
  assert.equal((await s.api.extend(hold.id)).status, 404, 'a released hold is gone');
});

test('the browser can read answers cross-origin only from a registered page, including refusals', async () => {
  const s = await start();
  const pre = await fetch(`${s.base}/v1/businesses/${DEMO_BUSINESS}/holds`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(pre.headers.get('access-control-allow-headers'), /idempotency-key/);
  const evil = await fetch(`${s.base}/v1/businesses/${DEMO_BUSINESS}/holds`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const slot = (await s.slots())[0];
  await s.api.hold(slot);
  const conflict = await fetch(`${s.base}/v1/businesses/${DEMO_BUSINESS}/holds`, {
    method: 'POST', headers: { origin: ORIGIN, 'x-widget-key': DEMO_KEY, 'content-type': 'application/json', 'idempotency-key': idem() },
    body: JSON.stringify({ serviceId: 'followup', staffId: slot.staffId, start: Date.parse(slot.start) }),
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.headers.get('access-control-allow-origin'), ORIGIN, 'a 409 must be readable by the page');
});

test('the server answers local names only, so a rebinding attack gets nothing', async () => {
  const s = await start();
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, path: '/healthz', headers: { host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
  assert.equal((await fetch(`${s.base}/healthz`)).status, 200);
  assert.equal(s.app.server.address().address, '127.0.0.1', 'and it listens on the loopback address only');
});

test('the demo controls refuse a cross-site POST', async () => {
  const s = await start();
  const forged = await fetch(`${s.base}/_demo/messaging`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"down":true}' });
  assert.equal(forged.status, 403);
  assert.equal(s.ctx().messaging.isDown(), false);
  const ok = await fetch(`${s.base}/_demo/messaging`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-control': '1' }, body: '{"down":true}' });
  assert.equal(ok.status, 200);
  assert.equal(s.ctx().messaging.isDown(), true);
});

test('the widget is framed only by the pages the business registered', async () => {
  const s = await start();
  const framed = async (query) => (await fetch(`${s.base}/widget/index.html${query}`)).headers.get('content-security-policy');
  assert.equal(await framed(`?key=${DEMO_KEY}`), `frame-ancestors ${ORIGIN}`);
  assert.equal(await framed('?key=pk_unknown'), "frame-ancestors 'none'");
  const page = await (await fetch(`${s.base}/widget/index.html?key=${DEMO_KEY}`)).text();
  assert.match(page, /connect-src 'self'/, 'this copy may talk to the API it came from');
  assert.equal((await fetch(`${s.base}/widget/../server/app.js`)).status, 404, 'and no other file is served');
});

// ── the database rule (ADR-AB-0003) ─────────────────────────────────────────────────────────────────

test('the database itself refuses an overlapping booking, whatever the application does (ADR-AB-0003)', async () => {
  const s = await start();
  const { slot } = await s.book();
  const { db } = s.ctx().store;
  s.ctx().store.touchClock();
  const startMs = Date.parse(slot.start);
  const insert = (id, offset, kind = 'booking', expires = null) => db.prepare(`INSERT INTO rows (id, business_id, staff_id, service_id, start_ms, end_ms, kind, expires_ms, created_ms)
      VALUES (?, ?, ?, 'followup', ?, ?, ?, ?, 0)`).run(id, DEMO_BUSINESS, slot.staffId, startMs + offset, startMs + offset + 30 * MIN, kind, expires);
  assert.throws(() => insert('direct_1', 0), /overlap/, 'the same time');
  assert.throws(() => insert('direct_2', 10 * MIN), /overlap/, 'part of the same time');
  assert.throws(() => insert('direct_3', -10 * MIN, 'hold', s.clock.now() + 5 * MIN), /overlap/, 'a hold over the booking’s start');
  assert.doesNotThrow(() => insert('direct_4', 30 * MIN), 'the next half hour is free');
  assert.throws(() => db.prepare('UPDATE rows SET start_ms = start_ms + 30 * 60000, end_ms = end_ms + 30 * 60000 WHERE id = ?').run(s.ctx().store.scope(DEMO_BUSINESS).allRows().find((r) => r.kind === 'booking' && r.start === startMs).id), /overlap/, 'and moving a booking onto another is refused too');
});

test('an expired hold does not block, and a hold on another person’s time never does', async () => {
  const s = await start();
  const slot = (await s.slots())[0];
  await s.api.hold(slot);
  const { db } = s.ctx().store;
  const insert = (id, staffId) => db.prepare(`INSERT INTO rows (id, business_id, staff_id, service_id, start_ms, end_ms, kind, expires_ms, created_ms)
      VALUES (?, ?, ?, 'followup', ?, ?, 'hold', ?, 0)`).run(id, DEMO_BUSINESS, staffId, Date.parse(slot.start), Date.parse(slot.end), s.clock.now() + 5 * MIN);
  s.ctx().store.touchClock();
  assert.throws(() => insert('x1', slot.staffId), /overlap/);
  assert.doesNotThrow(() => insert('x2', slot.staffId === 'sam' ? 'jo' : 'sam'), 'someone else’s calendar is not in the way');
  s.clock.advance(6 * MIN);
  s.ctx().store.touchClock();
  assert.doesNotThrow(() => insert('x3', slot.staffId), 'once the first hold has expired');
});

test('the constraint is real under the fifty-way race: the table never holds two overlapping rows', async () => {
  const s = await start();
  const slots = await s.slots();
  const target = await s.pick();
  s.clock.advance(2000);
  await Promise.all([...Array.from({ length: 25 }, () => s.api.hold(target)), ...Array.from({ length: 25 }, () => s.api.hold(slots.find((x) => x.staffId === target.staffId && Date.parse(x.start) === Date.parse(target.start) + 15 * MIN) ?? target))]);
  const rows = s.ctx().store.scope(DEMO_BUSINESS).allRows().filter((r) => r.staffId === target.staffId).sort((a, b) => a.start - b.start);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].start >= rows[i - 1].end, 'no overlap in the table');
});
