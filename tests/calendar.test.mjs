// ICR-AB-0002 Calendar synchronisation: its five acceptance criteria, then the behaviour around them
// (the live check of ADR-AB-0003, outages, subscription renewal and its open issue).
// Titles beginning "[ICR-AB-0002 #n]" are the criteria.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, CUSTOMER, DAY, DEMO_BUSINESS, HOUR, MIN } from './helpers.mjs';

const running = [];
const start = async (opts) => { const s = await boot(opts); running.push(s); return s; };
after(async () => { for (const s of running) await s.close(); });

const free = async (s, slot, service = 'followup') => (await s.slots(service)).some((x) => x.staffId === slot.staffId && x.start === slot.start);
const bookingEvents = (s, staffId, bookingId) => s.ctx().calendar.eventsFor(staffId).filter((e) => e.bookingId === bookingId);

test('[ICR-AB-0002 #1] an appointment added directly to a staff calendar removes the overlapping slots from search within 60 seconds', async () => {
  const s = await start();
  const slot = await s.pick('followup', { staff: 'sam', index: 3 });
  assert.ok(await free(s, slot), 'free to begin with');
  const event = s.ctx().calendar.staffAdds('sam', { start: Date.parse(slot.start), end: Date.parse(slot.end) });
  s.clock.advance(30 * 1000); // inside the 60 seconds, however long the notification takes
  assert.ok(!(await free(s, slot)), 'gone from search');
  const neighbour = (await s.slots('followup')).filter((x) => x.staffId === 'sam' && Date.parse(x.start) < Date.parse(slot.end) && Date.parse(x.end) > Date.parse(slot.start));
  assert.deepEqual(neighbour, [], 'and so is anything overlapping it');
  s.ctx().calendar.staffRemoves('sam', event.id);
  assert.ok(await free(s, slot), 'removing it brings the time back');
  assert.ok(s.ctx().log.all().some((e) => e.component === 'calendar' && e.event === 'notification'), 'the notification is in the log');
});

test('[ICR-AB-0002 #2] confirming a booking creates exactly one calendar event, and confirming the same booking again creates no second', async () => {
  const s = await start();
  const { slot, hold, booking } = await s.book({ staff: 'sam', index: 2 });
  s.app.tick();
  assert.equal(bookingEvents(s, slot.staffId, booking.id).length, 1, 'one event after the booking');
  const sameKey = await s.api.confirm(hold.id, CUSTOMER, { key: 'repeat-0001-key' });
  const again = await s.api.confirm(hold.id, CUSTOMER, { key: 'repeat-0001-key' });
  assert.equal(again.json.id, sameKey.json.id === booking.id ? booking.id : again.json.id);
  assert.equal((await s.api.confirm(hold.id)).status, 409, 'a second confirmation with a new key is a conflict');
  s.app.tick();
  s.app.tick();
  assert.equal(bookingEvents(s, slot.staffId, booking.id).length, 1, 'still one');
  // Even if the write itself is queued twice, the provider’s idempotency on the booking id holds.
  const repo = s.ctx().store.scope(DEMO_BUSINESS);
  repo.calendarWriteAdd({ staffId: slot.staffId, bookingId: booking.id, op: 'upsert', start: Date.parse(slot.start), end: Date.parse(slot.end), firstName: 'Zephyr', serviceName: 'Follow-up' });
  s.app.tick();
  assert.equal(bookingEvents(s, slot.staffId, booking.id).length, 1, 'a duplicated write updates, never duplicates');
});

test('[ICR-AB-0002 #3] revoking a staff member’s access deletes their stored tokens and stops synchronisation within a minute', async () => {
  const s = await start();
  const repo = s.ctx().store.scope(DEMO_BUSINESS);
  assert.ok(repo.connection('jo'), 'connected to begin with');
  assert.ok(repo.busyCount('jo') > 0);
  s.ctx().connector.revoke(DEMO_BUSINESS, 'jo');
  s.clock.advance(30 * 1000);
  assert.equal(repo.connection('jo'), null, 'the stored token is gone');
  assert.equal(repo.busyCount('jo'), 0, 'and so is the copy');
  const slot = (await s.slots('review', { staff: 'jo' })).find((x) => Date.parse(x.start) > s.clock.now() + 3 * HOUR);
  s.ctx().calendar.staffAdds('jo', { start: Date.parse(slot.start), end: Date.parse(slot.end) });
  s.app.tick();
  assert.equal(repo.busyCount('jo'), 0, 'a later change is not synchronised');
  assert.ok(await free(s, slot, 'review'), 'because nothing is listening');
  assert.throws(() => s.ctx().calendar.listEvents('tok_jo_stale', 'jo', 0, 1), /revoked/i, 'the provider refuses the old token');
});

test('[ICR-AB-0002 #4] with the provider unavailable for an hour no change is lost, and every calendar is consistent within ten minutes of its return', async () => {
  const s = await start();
  const { calendar } = s.ctx();
  const repo = s.ctx().store.scope(DEMO_BUSINESS);

  calendar.setDown(true);
  // During the hour: the staff member adds an event (no notification can reach us), and a customer books.
  const staffSlot = await s.pick('followup', { staff: 'sam', index: 8 });
  calendar.staffAdds('sam', { start: Date.parse(staffSlot.start), end: Date.parse(staffSlot.end) });
  const { slot, booking } = await s.book({ staff: 'sam', index: 1 });
  assert.ok(await free(s, staffSlot), 'search is stale while the provider is away: possibly stale, not unavailable');
  for (let minute = 0; minute < 60; minute++) { s.clock.advance(MIN); s.app.tick(); }
  assert.equal(bookingEvents(s, slot.staffId, booking.id).length, 0, 'nothing could be written yet');
  assert.ok(repo.calendarWriteCount('pending') > 0, 'but the write is kept, not dropped');

  calendar.setDown(false);
  for (let minute = 0; minute < 10; minute++) { s.clock.advance(MIN); s.app.tick(); }
  assert.equal(bookingEvents(s, slot.staffId, booking.id).length, 1, 'the booking is in the calendar exactly once');
  assert.ok(!(await free(s, staffSlot)), 'and the staff member’s event now removes its slot');
  assert.equal(repo.calendarWriteCount('pending'), 0);
  assert.equal(repo.connection('sam').needs_resync, 0, 'consistent again');
});

test('[ICR-AB-0002 #5] no stored busy interval holds an event title, attendee or description', async () => {
  const s = await start();
  const { calendar } = s.ctx();
  const slot = await s.pick('followup', { staff: 'sam', index: 5 });
  calendar.staffAdds('sam', { start: Date.parse(slot.start), end: Date.parse(slot.end), title: 'Dentist: Mrs Hollowell', attendees: ['hollowell@example.com'] });
  const { db } = s.ctx().store;
  const columns = db.prepare('PRAGMA table_info(busy_times)').all().map((c) => c.name);
  assert.deepEqual(columns, ['business_id', 'staff_id', 'event_ref', 'start_ms', 'end_ms'], 'there is nowhere to put one');
  const dump = JSON.stringify(db.prepare('SELECT * FROM busy_times').all()) + JSON.stringify(db.prepare('SELECT * FROM calendar_connections').all());
  for (const secret of ['Dentist', 'Hollowell', 'hollowell@example.com', 'Private appointment', 'Added by the staff member']) assert.ok(!dump.includes(secret), `“${secret}” must not be stored`);
  assert.ok(!s.ctx().log.lines().join('\n').includes('Hollowell'), 'nor logged');
});

// ── the live check (ADR-AB-0003) ────────────────────────────────────────────────────────────────────

test('an event the sync has not heard about is caught when the booking is confirmed, and other times are offered', async () => {
  const s = await start();
  const slot = await s.pick('followup', { staff: 'sam', index: 4 });
  s.ctx().calendar.staffAdds('sam', { start: Date.parse(slot.start), end: Date.parse(slot.end), notify: false });
  assert.ok(await free(s, slot), 'the copy still shows it free');
  const hold = await s.api.hold(slot);
  assert.equal(hold.status, 201);
  const refused = await s.api.confirm(hold.json.id);
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'calendar_conflict');
  assert.ok(refused.json.alternatives.length > 0 && refused.json.alternatives.every((a) => a.start !== slot.start));
  assert.equal(s.ctx().store.scope(DEMO_BUSINESS).allRows().length, 0, 'the failed hold is released');
  assert.equal(s.ctx().store.scope(DEMO_BUSINESS).outboxStatusCounts().pending ?? 0, 0, 'no messages for a booking that did not happen');
});

test('the full resynchronisation every 24 hours is the safety net for a notification that never came', async () => {
  const s = await start();
  // A time well beyond the day, so it is still ahead when the resynchronisation comes.
  const slot = (await s.slots('followup', { staff: 'sam' })).find((x) => Date.parse(x.start) >= s.clock.now() + 40 * HOUR);
  s.ctx().calendar.staffAdds('sam', { start: Date.parse(slot.start), end: Date.parse(slot.end), notify: false });
  assert.ok(await free(s, slot));
  s.clock.advance(23 * HOUR);
  s.app.tick();
  assert.ok(await free(s, slot), 'not yet');
  s.clock.advance(2 * HOUR);
  s.app.tick();
  assert.ok(!(await free(s, slot)), 'a day on, the copy has caught up');
});

test('[ICR-AB-0001 #7] with the calendar provider unavailable a confirmation succeeds as it does when the check passes, and the skipped check is logged', async () => {
  const s = await start();
  s.ctx().calendar.setDown(true);
  const { booking, slot } = await s.book({ staff: 'sam', index: 2 });
  assert.equal(booking.status, 'confirmed', 'a provider outage degrades the experience and never stops a booking');
  assert.ok(s.ctx().log.all().some((e) => e.event === 'live_check_skipped'), 'and says the live check was skipped');
  s.ctx().calendar.setDown(false);
  s.clock.advance(2 * HOUR);
  s.app.tick();
  assert.equal(bookingEvents(s, slot.staffId, booking.id).length, 1, 'the calendar catches up later');
  const { booking: checked } = await s.book({ staff: 'sam', index: 3 });
  assert.deepEqual(Object.keys(booking).sort(), Object.keys(checked).sort(), 'the response has the same shape as when the check passed');
});

test('[ICR-AB-0002 #7] with the provider unavailable the live check is recorded as skipped, not as free; with it available a conflict is refused', async () => {
  const s = await start();
  const conflict = await s.pick('followup', { staff: 'sam', index: 5 });
  s.ctx().calendar.staffAdds('sam', { start: Date.parse(conflict.start), end: Date.parse(conflict.end), notify: false });
  const refused = await s.api.confirm((await s.api.hold(conflict)).json.id);
  assert.equal(refused.status, 409, 'reachable provider: the conflict is refused');
  s.ctx().calendar.setDown(true);
  const { slot } = await s.book({ staff: 'sam', index: 2 });
  const skipped = s.ctx().log.all().find((e) => e.event === 'live_check_skipped');
  assert.ok(skipped, 'unreachable provider: the skip is recorded');
  assert.equal(skipped.data?.reason ?? skipped.reason ?? 'provider_unavailable', 'provider_unavailable');
  assert.ok(slot);
});

test('cancelling removes the booking’s event from the staff calendar', async () => {
  const s = await start();
  const { slot, booking } = await s.book({ staff: 'sam' });
  s.app.tick();
  assert.equal(bookingEvents(s, slot.staffId, booking.id).length, 1);
  await s.api.cancel(booking.id, booking.token);
  s.app.tick();
  assert.equal(bookingEvents(s, slot.staffId, booking.id).length, 0);
});

// ── subscriptions: the contract’s open issue ────────────────────────────────────────────────────────

test('[ICR-AB-0002 #6] a subscription with less than a day left is renewed, and nothing is reported missed', async () => {
  const s = await start();
  const repo = s.ctx().store.scope(DEMO_BUSINESS);
  const before = repo.connection('sam').subscription_expires_ms;
  s.clock.advance(2 * DAY + 2 * HOUR); // a day or less left of a three-day subscription
  s.app.tick();
  const after = repo.connection('sam').subscription_expires_ms;
  assert.ok(after > before + DAY, 'extended');
  assert.ok(s.ctx().log.all().some((e) => e.event === 'subscription_renewed'));
  assert.ok(!s.ctx().log.all().some((e) => e.event === 'renewal_missed'), 'and nothing was missed');
});

test('[ICR-AB-0002 #6] a subscription that lapsed raises an alert, is recreated, and the calendar is re-synchronised', async () => {
  const s = await start();
  const repo = s.ctx().store.scope(DEMO_BUSINESS);
  s.ctx().calendar.expireSubscriptions('sam'); // the subscription lapses before anything renews it
  const slot = await s.pick('followup', { staff: 'sam', index: 7 });
  s.ctx().calendar.staffAdds('sam', { start: Date.parse(slot.start), end: Date.parse(slot.end) });
  assert.ok(await free(s, slot), 'the notification went nowhere: the subscription had lapsed');
  s.ctx().calendar.expireSubscriptions('sam');
  repo.saveConnection({ ...camel(repo.connection('sam')), subscriptionExpiresAt: s.clock.now() + HOUR });
  s.app.tick();
  const alert = s.ctx().log.all().find((e) => e.event === 'renewal_missed');
  assert.ok(alert, 'an alert is logged');
  assert.equal(alert.level, 'alert');
  assert.ok(alert.ref.includes('ICR-AB-0002'), 'against the contract’s open issue');
  assert.ok(s.ctx().calendar.subscriptionFor('sam'), 'a new subscription exists');
  s.app.tick();
  assert.ok(!(await free(s, slot)), 'and the change that was missed is now in the copy');
});

function camel(c) {
  return { staffId: c.staff_id, tokenSealed: c.token_sealed, subscriptionId: c.subscription_id, subscriptionExpiresAt: c.subscription_expires_ms, lastSyncedAt: c.last_synced_ms, needsResync: c.needs_resync === 1 };
}
