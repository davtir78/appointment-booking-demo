// ICR-AB-0003 Notification delivery: its five acceptance criteria, then the behaviour around them
// (the transactional outbox described in the notification requirements, dead letters, channels, CloudEvents).
// Titles beginning "[ICR-AB-0003 #n]" are the criteria.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, CUSTOMER, DAY, DEMO_BUSINESS, HOUR, MIN } from './helpers.mjs';

const running = [];
const start = async (opts) => { const s = await boot(opts); running.push(s); return s; };
after(async () => { for (const s of running) await s.close(); });

const inbox = (s) => s.ctx().messaging.inbox();
const subjects = (s) => inbox(s).map((m) => m.subject);
const outbox = (s, bookingId) => s.ctx().store.scope(DEMO_BUSINESS).outboxForBooking(bookingId);
/** Let time pass in steps, running the scheduler as it would run. */
function pass(s, minutes, step = 1) { for (let m = 0; m < minutes; m += step) { s.clock.advance(step * MIN); s.app.tick(); } }
/** A booking far enough ahead to have a day-before reminder: the first slot on the day after tomorrow. */
async function farSlot(s, service = 'followup', staff = 'sam') {
  return (await s.slots(service, { from: '2026-09-30', to: '2026-09-30', staff }))[0];
}

test('[ICR-AB-0003 #1] with the provider unavailable bookings succeed, and when it returns every pending message is sent exactly once', async () => {
  const s = await start();
  s.ctx().messaging.setDown(true);
  const booked = [];
  for (let i = 0; i < 3; i++) booked.push(await s.book({ staff: 'sam', index: i * 3 }));
  assert.ok(booked.every((b) => b.booking.status === 'confirmed'), 'every booking succeeded during the outage');
  pass(s, 90, 5); // the worker keeps trying, backing off
  assert.equal(inbox(s).length, 0, 'nothing could be sent');
  assert.ok(s.ctx().messaging.attempts() > 0, 'but it tried');
  assert.ok(s.ctx().store.scope(DEMO_BUSINESS).outboxStatusCounts().pending >= 6);

  s.ctx().messaging.setDown(false);
  pass(s, 90, 5);
  const sent = inbox(s);
  assert.equal(sent.length, 6, 'one email and one SMS for each of three bookings');
  assert.equal(new Set(sent.map((m) => m.key)).size, 6, 'each exactly once');
  assert.deepEqual(s.ctx().store.scope(DEMO_BUSINESS).outboxStatusCounts(), { sent: 6 });
  pass(s, 30, 5);
  assert.equal(inbox(s).length, 6, 'and nothing more later');
});

test('[ICR-AB-0003 #2] a booking cancelled before its confirmation is sent produces a cancellation and no confirmation', async () => {
  const s = await start();
  s.ctx().messaging.setDown(true);
  const { booking } = await s.book({ staff: 'sam' });
  s.app.tick(); // the confirmation is attempted and fails: it is still waiting
  assert.equal((await s.api.cancel(booking.id, booking.token)).status, 204);
  s.ctx().messaging.setDown(false);
  pass(s, 30, 5);
  assert.ok(subjects(s).length > 0);
  assert.ok(subjects(s).every((x) => x.startsWith('Cancelled')), `only cancellations were sent: ${subjects(s).join(' | ')}`);
  const rows = outbox(s, booking.id);
  assert.ok(rows.filter((r) => r.event_type === 'BookingConfirmed').every((r) => r.status === 'superseded'), 'the confirmation was superseded');
  assert.ok(rows.filter((r) => r.event_type === 'BookingCancelled').every((r) => r.status === 'sent'));
});

test('[ICR-AB-0003 #3] a reminder whose window passed during an outage is not sent late', async () => {
  const s = await start();
  const slot = await farSlot(s);
  const hold = await s.api.hold(slot);
  const booking = (await s.api.confirm(hold.json.id)).json;
  s.app.tick();
  const reminderOf = () => outbox(s, booking.id).filter((r) => r.event_type === 'ReminderDue');
  assert.equal(reminderOf().length, 2, 'a day-before reminder is queued by email and SMS');

  s.ctx().messaging.setDown(true);
  const startMs = Date.parse(slot.start);
  while (s.clock.now() < startMs - 3 * HOUR) { s.clock.advance(30 * MIN); s.app.tick(); } // through the reminder’s due time, still down
  assert.ok(reminderOf().every((r) => r.status === 'pending'), 'still waiting');
  s.clock.advance(2 * HOUR); // now inside two hours of the appointment: too late to be useful
  s.ctx().messaging.setDown(false);
  s.app.tick();
  assert.ok(reminderOf().every((r) => r.status === 'dropped'), 'dropped, not sent late');
  assert.ok(!subjects(s).some((x) => x.startsWith('Reminder')), 'the inbox has no reminder');
});

test('a reminder is sent a day before when everything is up (the control for the case above)', async () => {
  const s = await start();
  const slot = await farSlot(s);
  const booking = (await s.api.confirm((await s.api.hold(slot)).json.id)).json;
  s.app.tick();
  assert.deepEqual(subjects(s).filter((x) => x.startsWith('Reminder')), [], 'not yet');
  while (s.clock.now() < Date.parse(slot.start) - 23 * HOUR) { s.clock.advance(HOUR); s.app.tick(); }
  const reminders = inbox(s).filter((m) => m.subject.startsWith('Reminder'));
  assert.deepEqual(reminders.map((m) => m.channel).sort(), ['email', 'sms']);
  assert.ok(booking.id);
});

test('[ICR-AB-0003 #4] replaying the same booking event sends nothing new', async () => {
  const s = await start();
  const { booking } = await s.book({ staff: 'sam' });
  s.app.tick();
  const before = inbox(s).length;
  assert.equal(before, 2);

  // The same event arrives again from the queue.
  const worker = s.ctx().worker;
  const added = worker.enqueue(DEMO_BUSINESS, { type: 'BookingConfirmed', bookingId: booking.id, eventId: `evt_${booking.id}_confirmed`, booking: { start: 0, timeZone: 'UTC', serviceName: 'x', staffName: 'y', manageUrl: 'z' }, customer: CUSTOMER });
  assert.equal(added, 0, 'the outbox ignores a replayed event');
  s.app.tick();
  assert.equal(inbox(s).length, before, 'and nothing is sent');

  // The worker crashes after sending but before recording it: the provider’s own idempotency catches the retry.
  const { db } = s.ctx().store;
  db.prepare("UPDATE outbox SET status = 'pending', sent_ms = NULL WHERE booking_id = ?").run(booking.id);
  s.app.tick();
  assert.equal(inbox(s).length, before, 'the provider recognises the key and sends nothing twice');
  assert.deepEqual(s.ctx().store.scope(DEMO_BUSINESS).outboxStatusCounts(), { sent: 2 }, 'and the worker records them as sent');
});

test('[ICR-AB-0003 #5] no log line contains a message body, an email address or a phone number', async () => {
  const s = await start();
  s.ctx().messaging.setDown(true);
  const { booking, slot } = await s.book({ staff: 'sam' });
  s.app.tick();
  s.ctx().messaging.setDown(false);
  const later = (await s.slots('followup', { staff: 'sam' })).find((x) => Date.parse(x.start) >= Date.parse(slot.end) + HOUR);
  await s.api.reschedule(booking.id, booking.token, (await s.api.hold(later)).json.id);
  pass(s, 20, 5);
  await s.api.cancel(booking.id, booking.token);
  pass(s, 20, 5);
  assert.ok(inbox(s).length >= 4, 'messages were sent, so there were bodies to leak');
  const bodies = inbox(s).map((m) => m.body);
  const log = s.ctx().log.lines().join('\n');
  assert.ok(log.length > 800);
  for (const secret of [CUSTOMER.email, CUSTOMER.phone, 'Zephyr', ...bodies.flatMap((b) => [b, b.slice(0, 25)]), 'Manage your booking', 'example.com/manage']) {
    assert.ok(!log.includes(secret), `the log must not contain “${secret.slice(0, 40)}”`);
  }
});

// ── the outbox, channels and failure paths ──────────────────────────────────────────────────────────

test('messages are written in the same transaction as the booking: if one fails, neither exists (notification requirements)', async () => {
  const s = await start();
  const slot = await s.pick('followup', { staff: 'sam' });
  const hold = (await s.api.hold(slot)).json;
  const original = s.ctx().worker.enqueue;
  s.ctx().worker.enqueue = () => { throw new Error('the outbox is broken'); };
  const failed = await s.api.confirm(hold.id);
  s.ctx().worker.enqueue = original;
  assert.equal(failed.status, 500);
  const rows = s.ctx().store.scope(DEMO_BUSINESS).allRows();
  assert.equal(rows.filter((r) => r.kind === 'booking').length, 0, 'no booking without its messages');
  assert.equal(rows.filter((r) => r.id === hold.id && r.kind === 'hold').length, 1, 'the customer still holds the time');
  assert.equal((await s.api.confirm(hold.id)).status, 201, 'and can try again');
});

test('a booking succeeds whatever the messaging provider does (a provider outage never stops a booking)', async () => {
  const s = await start();
  s.ctx().messaging.setDown(true);
  const { booking } = await s.book({ staff: 'sam' });
  assert.equal(booking.notifications.status, 'queued');
  assert.equal((await s.api.booking(booking.id, booking.token)).json.notifications.status, 'queued');
});

test('SMS goes only to a customer who gave a mobile number', async () => {
  const s = await start();
  await s.book({ staff: 'sam', customer: { name: 'Quentin Nofone', email: 'quentin.nofone@example.com' } });
  s.app.tick();
  assert.deepEqual(inbox(s).map((m) => m.channel), ['email']);
});

test('events are CloudEvents 1.0 envelopes keyed by event id and channel', async () => {
  const s = await start();
  const { booking } = await s.book({ staff: 'sam' });
  const row = s.ctx().store.db.prepare('SELECT * FROM outbox WHERE booking_id = ? AND channel = ?').get(booking.id, 'email');
  const event = JSON.parse(row.payload);
  assert.equal(event.specversion, '1.0');
  assert.equal(event.type, 'au.example.booking.BookingConfirmed');
  assert.equal(event.subject, booking.id);
  assert.equal(event.source, '/booking-service');
  assert.match(event.time, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(row.id, `${event.id}:email`, 'one message per event and channel');
});

test('a message to an address the provider refuses goes to the dead letters, and the booking shows “not delivered”', async () => {
  const s = await start();
  const { booking } = await s.book({ staff: 'sam', customer: { name: 'Ivy Invalidmail', email: 'ivy@invalid.example', phone: null } });
  s.app.tick();
  assert.equal(inbox(s).length, 0);
  const rows = outbox(s, booking.id);
  assert.ok(rows.every((r) => r.status === 'dead'));
  assert.equal((await s.api.booking(booking.id, booking.token)).json.notifications.status, 'not delivered');
  assert.ok(s.ctx().log.all().some((e) => e.event === 'dead_letter' && e.level === 'alert'));
});

test('after retrying for 24 hours a message goes to the dead letters', async () => {
  const s = await start();
  s.ctx().messaging.setDown(true);
  const { booking } = await s.book({ staff: 'sam' });
  pass(s, 25 * 60, 30);
  assert.ok(outbox(s, booking.id).every((r) => r.status === 'dead'));
  s.ctx().messaging.setDown(false);
  pass(s, 60, 30);
  assert.equal(inbox(s).length, 0, 'and it is not sent later');
});

test('rescheduling supersedes the unsent confirmation and says the booking has moved', async () => {
  const s = await start();
  s.ctx().messaging.setDown(true);
  const { booking, slot } = await s.book({ staff: 'sam' });
  const later = (await s.slots('followup', { staff: 'sam' })).find((x) => Date.parse(x.start) >= Date.parse(slot.end) + HOUR);
  await s.api.reschedule(booking.id, booking.token, (await s.api.hold(later)).json.id);
  s.ctx().messaging.setDown(false);
  pass(s, 30, 5);
  assert.ok(subjects(s).every((x) => x.startsWith('Moved')), subjects(s).join(' | '));
  assert.equal(inbox(s).length, 2);
});

test('an event carries its times as ISO 8601 instants, like every time on the wire, and its envelope names the booking', async () => {
  const s = await start();
  const { booking } = await s.book({ staff: 'sam', index: 2 });
  const rows = s.ctx().store.db.prepare('SELECT payload FROM outbox WHERE booking_id = ?').all(booking.id).map((r) => JSON.parse(r.payload));
  assert.ok(rows.length >= 1);
  for (const event of rows) {
    assert.equal(event.specversion, '1.0');
    assert.equal(event.subject, booking.id);
    assert.equal(event.data.start, booking.start, 'the same instant as the booking, in the same form');
    assert.equal(event.data.end, booking.end);
    assert.match(event.data.start, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
});
