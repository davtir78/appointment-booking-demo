// The widget against the real API, in a real browser, across two origins: the clinic's own site and
// the vendor origin that serves the widget and the API (ADR-AB-0001). It checks the whole system
// through the interface a person uses, and the "Behind the scenes" panel that shows it working.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { createClock } from '../server/clock.js';
import { DEMO_KEY } from '../server/seed.js';
import { startServer } from '../tools/serve.mjs';
import { ROOT } from './helpers.mjs';

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

let app, apiOrigin, site, siteOrigin, stranger, strangerOrigin, browser;
before(async () => {
  app = createApp({ clock: createClock(), staticRoot: ROOT });
  const port = await app.listen(0);
  apiOrigin = `http://127.0.0.1:${port}`;
  site = await startServer(0, { frameSrc: apiOrigin });
  siteOrigin = `http://127.0.0.1:${site.address().port}`;
  stranger = await startServer(0, { frameSrc: apiOrigin }); // a different page, one the business never registered
  strangerOrigin = `http://127.0.0.1:${stranger.address().port}`;
  app.setOrigins([siteOrigin]);
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); site?.close(); stranger?.close(); await app?.close(); });

const demoPost = (path, body) => fetch(`${apiOrigin}/_demo/${path}`, { method: 'POST', headers: { 'x-demo-control': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const demoState = async () => (await fetch(`${apiOrigin}/_demo/state`)).json();

async function open({ bypassCSP = false, from = siteOrigin, viewport } = {}) {
  await demoPost('reset');
  const context = await browser.newContext({ bypassCSP, viewport: viewport ?? { width: 1100, height: 1000 }, timezoneId: 'Australia/Sydney', locale: 'en-AU' });
  const page = await context.newPage();
  const requests = [];
  page.on('request', (r) => requests.push({ url: r.url(), method: r.method(), headers: r.headers() }));
  const problems = [];
  page.on('pageerror', (e) => problems.push(String(e)));
  await page.goto(`${from}/?api=${encodeURIComponent(apiOrigin)}&key=${DEMO_KEY}`);
  const frame = page.frameLocator('iframe');
  await frame.getByRole('heading', { name: 'Choose a service' }).waitFor({ timeout: 8000 });
  return { context, page, frame, requests, problems };
}

async function chooseFollowUp(frame) {
  await frame.getByRole('radio', { name: /Follow-up/ }).check();
  await frame.getByRole('button', { name: 'Continue' }).click();
  await frame.getByRole('heading', { name: 'Choose a time' }).waitFor();
}

/** Wait for a condition on the panel, which refreshes itself every couple of seconds. */
async function eventually(fn, message, timeout = 8000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch { /* keep trying */ } await new Promise((r) => setTimeout(r, 150)); }
  assert.fail(message);
}

// ── the system, through the interface ───────────────────────────────────────────────────────────────

test('a booking made through the widget goes through the real API, and the panel shows each step', async () => {
  const { context, frame, problems } = await open();
  await chooseFollowUp(frame);
  await frame.locator('input[name="slot"]').first().check();
  await frame.getByRole('button', { name: /Hold this time/ }).click();
  await frame.getByRole('heading', { name: 'Your details' }).waitFor();
  await frame.getByLabel('Your name (required)').fill('Winifred Quarterstaff');
  await frame.getByLabel('Email (required)').fill('winifred.quarterstaff@example.com');
  await frame.getByRole('button', { name: 'Confirm booking' }).click();
  await frame.getByRole('heading', { name: 'You’re booked' }).waitFor();

  const requests = frame.locator('.panel table tbody tr');
  await eventually(async () => (await requests.allTextContents()).some((t) => /POST \/v1\/holds\/\{id\}\/confirm.*201/.test(t)), 'the confirm request appears in the panel');
  const rows = (await requests.allTextContents()).join('\n');
  assert.match(rows, /GET \/v1\/businesses\/\{id\}\/services.*200/);
  assert.match(rows, /GET \/v1\/businesses\/\{id\}\/availability.*200/);
  assert.match(rows, /POST \/v1\/businesses\/\{id\}\/holds.*201/);

  app.tick(); // the scheduler: the calendar connector writes the event, the worker sends the messages
  await eventually(async () => (await frame.locator('.panel .inbox li').count()) === 2, 'the stand-in provider “sent” an email and an SMS');
  const events = await frame.locator('.panel .events').textContent();
  assert.match(events, /Booking service booking confirmed/);
  assert.match(events, /Calendar connectors event written/);
  assert.match(events, /Notification worker queued/);
  assert.match(events, /Notification worker sent/);
  assert.ok(await frame.locator('.panel .events a[href*="ICR-AB-0001"]').count() > 0, 'linked to the contract');
  assert.ok(await frame.locator('.panel .events a[href*="requirements/notifications"], .panel .events a[href*="ICR-AB-0003"]').count() > 0, 'and to a decision or contract clause');
  assert.ok(await frame.locator('.panel .events a[href*="/patterns/int-"]').count() > 0, 'and to the library pattern');
  assert.ok(await frame.locator('.panel .events a[href*="sad.md"]').count() > 0, 'and to the SAD');
  assert.deepEqual(problems, []);
  await context.close();
});

test('every request carries the widget key, the registered page’s origin and a trace; every POST an idempotency key', async () => {
  const { context, frame, requests } = await open();
  await chooseFollowUp(frame);
  await frame.locator('input[name="slot"]').first().check();
  await frame.getByRole('button', { name: /Hold this time/ }).click();
  await frame.getByRole('heading', { name: 'Your details' }).waitFor();
  await frame.getByRole('button', { name: 'Confirm booking' }).click();
  await frame.getByRole('heading', { name: 'You’re booked' }).waitFor();

  const api = requests.filter((r) => r.url.startsWith(`${apiOrigin}/v1/`));
  assert.ok(api.length >= 4);
  for (const r of api) {
    assert.equal(r.headers['x-widget-key'], DEMO_KEY, r.url);
    assert.equal(r.headers['x-embedding-origin'], siteOrigin, `${r.url}: the origin comes from the browser-vouched handshake`);
    assert.match(r.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/, r.url);
    if (r.method === 'POST') assert.match(r.headers['idempotency-key'], /^[0-9a-f-]{36}$/, `${r.method} ${r.url}`);
  }
  const reachedOut = requests.filter((r) => !r.url.startsWith(siteOrigin) && !r.url.startsWith(apiOrigin) && !r.url.startsWith('data:'));
  assert.deepEqual(reachedOut.map((r) => r.url), [], 'and nothing reaches any other address');
  await context.close();
});

test('a page the business never registered cannot frame the widget', async () => {
  await demoPost('reset');
  const context = await browser.newContext();
  const page = await context.newPage();
  const apiRequests = async () => (await (await fetch(`${apiOrigin}/_demo/events?since=0`)).json()).events.filter((e) => e.event === 'request' && /\/v1\//.test(e.detail.route)).length;
  const before = await apiRequests();
  await page.goto(`${strangerOrigin}/?api=${encodeURIComponent(apiOrigin)}&key=${DEMO_KEY}`);
  await page.waitForTimeout(2500);
  const frame = page.frames().find((f) => f !== page.mainFrame());
  assert.ok(frame, 'the loader still made a frame');
  assert.ok(!frame.url().startsWith(apiOrigin) || /chrome-error/.test(frame.url()), `the browser refused it: ${frame.url()}`);
  assert.equal(await page.frameLocator('iframe').getByRole('heading', { name: 'Choose a service' }).count(), 0, 'no booking form appeared');
  assert.equal(await apiRequests(), before, 'and no API request was made');
  await context.close();
});

test('the API refuses the same key from an unregistered page, even when called directly', async () => {
  const r = await fetch(`${apiOrigin}/v1/businesses/example-clinic/services`, { headers: { 'x-widget-key': DEMO_KEY, 'x-embedding-origin': strangerOrigin } });
  assert.equal(r.status, 403);
});

// ── staging the awkward cases from the panel ────────────────────────────────────────────────────────

test('messaging outage: the booking still succeeds, messages wait in the outbox, and arrive once the provider returns', async () => {
  const { context, frame } = await open();
  await frame.getByRole('button', { name: 'Switch the messaging provider off' }).waitFor();
  await frame.getByRole('button', { name: 'Switch the messaging provider off' }).click();
  await frame.getByRole('button', { name: 'Switch the messaging provider back on' }).waitFor();

  await chooseFollowUp(frame);
  await frame.locator('input[name="slot"]').first().check();
  await frame.getByRole('button', { name: /Hold this time/ }).click();
  await frame.getByRole('heading', { name: 'Your details' }).waitFor();
  await frame.getByRole('button', { name: 'Confirm booking' }).click();
  await frame.getByRole('heading', { name: 'You’re booked' }).waitFor();

  app.tick();
  await eventually(async () => /retry scheduled/.test(await frame.locator('.panel .events').textContent()), 'the worker is retrying');
  assert.equal(await frame.locator('.panel .inbox li:not(.meta)').filter({ hasText: /EMAIL|SMS/ }).count(), 0, 'nothing sent');

  await frame.getByRole('button', { name: 'Switch the messaging provider back on' }).click();
  await frame.getByRole('button', { name: 'Move the clock forward 1 hour' }).click(); // past the retry back-off
  await eventually(async () => (await frame.locator('.panel .inbox li').filter({ hasText: /EMAIL|SMS/ }).count()) === 2, 'both messages arrive, once each');
  await context.close();
});

test('a calendar event the sync never heard about is caught when the booking is confirmed', async () => {
  const { context, frame } = await open();
  await frame.getByRole('button', { name: /Add an event to Alex/ }).waitFor();
  const { hint } = await demoState();
  assert.ok(hint, 'there is a time to stage');
  await frame.getByRole('button', { name: /Add an event to Alex/ }).click();
  await eventually(async () => /event added without notification/.test(await frame.locator('.panel .events').textContent()), 'the staging is logged');

  await chooseFollowUp(frame);
  await frame.getByRole('radio', { name: /^Alex, Physiotherapist/ }).check();
  const slot = frame.locator(`input[name="slot"][value="alex|${Date.parse(hint.start)}"]`);
  await slot.waitFor({ state: 'attached' });
  assert.equal(await slot.count(), 1, 'the copy still shows the time free');
  await slot.check();
  await frame.getByRole('button', { name: /Hold this time/ }).click();
  await frame.getByRole('heading', { name: 'Your details' }).waitFor();
  await frame.getByRole('button', { name: 'Confirm booking' }).click();
  await frame.getByRole('heading', { name: 'Choose a time' }).waitFor();
  const alert = await frame.locator('.alert').textContent();
  assert.match(alert, /no longer free/);
  assert.match(alert, /next free times/i);
  await eventually(async () => /live check failed/.test(await frame.locator('.panel .events').textContent()), 'the panel shows the failed live check');
  assert.ok(await frame.locator('.panel .events a[href*="ADR-AB-0003"], .panel .events a[href*="0003-availability"]').count() > 0, 'linked to the decision behind it');
  await context.close();
});

test('moving the server’s clock past a hold’s five minutes ends the hold on screen', async () => {
  const { context, frame } = await open();
  await chooseFollowUp(frame);
  await frame.locator('input[name="slot"]').first().check();
  await frame.getByRole('button', { name: /Hold this time/ }).click();
  await frame.getByRole('heading', { name: 'Your details' }).waitFor();
  assert.match(await frame.locator('#countdown').textContent(), /^[45]:\d\d$/);
  await frame.getByRole('button', { name: 'Move the clock forward 5 minutes' }).click();
  await frame.getByRole('heading', { name: 'Choose a time' }).waitFor({ timeout: 6000 });
  assert.match(await frame.locator('.alert').textContent(), /hold on that time ended/);
  await context.close();
});

test('keeping a hold works against the API (the proposed extend operation)', async () => {
  const { context, frame } = await open();
  await chooseFollowUp(frame);
  await frame.locator('input[name="slot"]').first().check();
  await frame.getByRole('button', { name: /Hold this time/ }).click();
  await frame.getByRole('heading', { name: 'Your details' }).waitFor();
  await demoPost('clock', { advanceMs: 3 * 60 * 1000 });
  await frame.getByRole('button', { name: 'Keep holding for 5 more minutes' }).click();
  await eventually(async () => /^[45]:\d\d$/.test(await frame.locator('#countdown').textContent()), 'back to about five minutes');
  const rows = (await frame.locator('.panel table tbody tr').allTextContents()).join('\n');
  assert.match(rows, /POST \/v1\/holds\/\{id\}\/extend.*200/);
  await context.close();
});

test('change the time and cancel against the API; the old time is freed', async () => {
  const { context, frame } = await open();
  await chooseFollowUp(frame);
  await frame.locator('input[name="slot"]').first().check();
  await frame.getByRole('button', { name: /Hold this time/ }).click();
  await frame.getByRole('heading', { name: 'Your details' }).waitFor();
  await frame.getByRole('button', { name: 'Confirm booking' }).click();
  await frame.getByRole('heading', { name: 'You’re booked' }).waitFor();

  await frame.getByRole('button', { name: 'Change time' }).click();
  await frame.getByRole('heading', { name: 'Choose a new time' }).waitFor();
  await frame.locator('input[name="slot"]').nth(3).check();
  await frame.getByRole('button', { name: /Hold this new time/ }).click();
  await frame.getByRole('button', { name: 'Confirm new time' }).click();
  await frame.getByRole('heading', { name: 'You’re booked' }).waitFor();
  assert.match(await frame.locator('.alert').textContent(), /has moved/);

  await frame.getByRole('button', { name: 'Cancel booking' }).click();
  await frame.getByRole('button', { name: 'Yes, cancel the booking' }).click();
  await frame.getByRole('heading', { name: 'Your booking is cancelled' }).waitFor();
  const rows = (await frame.locator('.panel table tbody tr').allTextContents()).join('\n');
  assert.match(rows, /PATCH \/v1\/bookings\/\{id\}.*200/);
  assert.match(rows, /DELETE \/v1\/bookings\/\{id\}.*204/);
  await context.close();
});

test('a customer’s details are in no server log line, however much the widget does', async () => {
  const { context, frame } = await open();
  await chooseFollowUp(frame);
  await frame.locator('input[name="slot"]').first().check();
  await frame.getByRole('button', { name: /Hold this time/ }).click();
  await frame.getByRole('heading', { name: 'Your details' }).waitFor();
  await frame.getByLabel('Your name (required)').fill('Bartholomew Plinkington');
  await frame.getByLabel('Email (required)').fill('bartholomew.plinkington@example.com');
  await frame.getByLabel('Phone (optional)').fill('0422 777 888');
  await frame.getByRole('button', { name: 'Confirm booking' }).click();
  await frame.getByRole('heading', { name: 'You’re booked' }).waitFor();
  app.tick();
  const log = JSON.stringify((await (await fetch(`${apiOrigin}/_demo/events?since=0`)).json()).events);
  assert.ok(log.length > 1000);
  for (const secret of ['Bartholomew', 'Plinkington', 'bartholomew.plinkington', '0422 777 888', 'you\'re booked for']) assert.ok(!log.includes(secret), secret);
  await context.close();
});

// ── accessibility, with the panel ───────────────────────────────────────────────────────────────────

test('no WCAG 2.2 AA violations in API mode, the panel included', async () => {
  const { context, page, frame } = await open({ bypassCSP: true });
  const found = [];
  const check = async (label) => {
    await frame.locator('body').evaluate((_, src) => { if (!window.axe) (0, eval)(src); }, AXE);
    const r = await frame.locator('body').evaluate((_, tags) => window.axe.run(document, { runOnly: { type: 'tag', values: tags } }), WCAG);
    found.push(...r.violations.map((v) => `${label}: ${v.id} (${v.impact}) ${v.help}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`));
  };
  await check('service');
  await chooseFollowUp(frame);
  await check('times');
  await frame.locator('input[name="slot"]').first().check();
  await frame.getByRole('button', { name: /Hold this time/ }).click();
  await frame.getByRole('heading', { name: 'Your details' }).waitFor();
  await check('details');
  await frame.getByRole('button', { name: 'Confirm booking' }).click();
  await frame.getByRole('heading', { name: 'You’re booked' }).waitFor();
  app.tick();
  await eventually(async () => (await frame.locator('.panel .inbox li').count()) === 2, 'messages in the panel');
  await frame.locator('details.outbox summary').click();
  await check('booked, with the panel full');
  await page.waitForTimeout(100);
  assert.deepEqual(found, []);
  await context.close();
});

test('the panel is usable at a phone width without sideways scrolling of the page', async () => {
  const { context, frame } = await open({ viewport: { width: 380, height: 900 } });
  await chooseFollowUp(frame);
  const overflow = await frame.locator('body').evaluate((b) => b.ownerDocument.documentElement.scrollWidth - b.ownerDocument.documentElement.clientWidth);
  assert.ok(overflow <= 0, `the widget page scrolls sideways by ${overflow}px`);
  await context.close();
});
