// End-to-end tests in a real browser: a whole booking by keyboard alone, an accessibility check of
// every screen, the demo's safety promises (no requests, nothing stored) and its decision-driven
// behaviours (lost race, live calendar check, hold expiry and extension, time zones).
//
//   npm install && node --test tests/e2e.test.mjs

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { startServer } from '../tools/serve.mjs';

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

let server, browser, origin;
before(async () => {
  server = await startServer(0);
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────

async function open({ bypassCSP = false, clock = false, viewport } = {}) {
  const context = await browser.newContext({ bypassCSP, viewport: viewport ?? { width: 1000, height: 900 }, timezoneId: 'Australia/Sydney', locale: 'en-AU' });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
  if (clock) await page.clock.install({ time: new Date('2026-09-28T00:00:00Z') });
  await page.goto(`${origin}/`);
  const frame = page.frameLocator('iframe');
  await frame.getByRole('heading', { level: 2 }).waitFor();
  return { context, page, frame, problems };
}

const isFocused = (locator) => locator.evaluate((el) => el.ownerDocument.activeElement === el);

/** Press Tab until the element has focus: proof that the keyboard can reach it, in order. */
async function reach(page, locator, max = 150) {
  for (let i = 0; i < max; i++) {
    if (await isFocused(locator)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`could not reach ${locator} by Tab in ${max} presses`);
}

/**
 * Choose one radio button the way a keyboard visitor does: Tab to its group, then the arrow keys
 * (which move focus and select, natively). Radio groups are one Tab stop, so Tab alone never
 * lands on the second option.
 */
async function chooseRadio(page, target) {
  await reach(page, target.locator('xpath=ancestor::fieldset').locator('input[type="radio"]').first());
  for (let i = 0; i < 40 && !(await isFocused(target)); i++) await page.keyboard.press('ArrowDown');
  assert.ok(await isFocused(target), 'the arrow keys reach the option');
  if (!(await target.isChecked())) await page.keyboard.press('Space'); // Tab alone focuses the first option without choosing it
  assert.ok(await target.isChecked(), 'and the option ends up selected');
}

async function headingFocused(frame) {
  return isFocused(frame.getByRole('heading', { level: 2 }));
}

async function axeViolations(frame, label) {
  await frame.locator('body').evaluate((_, src) => { if (!window.axe) (0, eval)(src); }, AXE);
  const result = await frame.locator('body').evaluate((_, tags) => window.axe.run(document, { runOnly: { type: 'tag', values: tags } }), WCAG);
  return result.violations.map((v) => `${label}: ${v.id} (${v.impact}) ${v.help}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
}

/** Book a Follow-up for the first free time, using only Tab, Space and Enter. */
async function bookByKeyboard(page, frame) {
  await chooseRadio(page, frame.getByRole('radio', { name: /Follow-up/ }));
  await reach(page, frame.getByRole('button', { name: 'Continue' }));
  await page.keyboard.press('Enter');
  assert.ok(await headingFocused(frame), 'focus moves to the step heading');

  await chooseRadio(page, frame.locator('input[name="slot"]').first());
  await reach(page, frame.getByRole('button', { name: /Hold this time/ }));
  await page.keyboard.press('Enter');
  await frame.getByRole('heading', { name: 'Your details' }).waitFor();
  assert.ok(await headingFocused(frame));

  await reach(page, frame.getByRole('button', { name: 'Confirm booking' }));
  await page.keyboard.press('Enter');
  await frame.getByRole('heading', { name: 'You’re booked' }).waitFor();
}

// ── a whole booking, by keyboard alone ──────────────────────────────────────────────────────────────

test('book, change the time and cancel using only the keyboard', async () => {
  const { context, page, frame, problems } = await open();
  await bookByKeyboard(page, frame);
  assert.ok(await headingFocused(frame));
  await frame.locator('#status').filter({ hasText: /Booked\./ }).waitFor({ timeout: 2000 }); // announced, a moment after the page changes

  await reach(page, frame.getByRole('button', { name: 'Change time' }));
  await page.keyboard.press('Enter');
  await frame.getByRole('heading', { name: 'Choose a new time' }).waitFor();
  await chooseRadio(page, frame.locator('input[name="slot"]').nth(2));
  await reach(page, frame.getByRole('button', { name: /Hold this new time/ }));
  await page.keyboard.press('Enter');
  await reach(page, frame.getByRole('button', { name: 'Confirm new time' }));
  await page.keyboard.press('Enter');
  await frame.getByRole('heading', { name: 'You’re booked' }).waitFor();
  assert.match(await frame.locator('.alert').textContent(), /has moved/);

  await reach(page, frame.getByRole('button', { name: 'Cancel booking' }));
  await page.keyboard.press('Enter');
  await frame.getByRole('heading', { name: 'Cancel this booking?' }).waitFor();
  await reach(page, frame.getByRole('button', { name: 'Yes, cancel the booking' }));
  await page.keyboard.press('Enter');
  await frame.getByRole('heading', { name: 'Your booking is cancelled' }).waitFor();
  assert.deepEqual(problems, []);
  await context.close();
});

test('focus is always visible on the controls a keyboard visitor lands on', async () => {
  const { context, page, frame } = await open();
  await chooseRadio(page, frame.getByRole('radio', { name: /Follow-up/ }));
  for (const target of [frame.getByRole('radio', { name: /Follow-up/ }), frame.getByRole('button', { name: 'Continue' })]) {
    if (!(await isFocused(target))) await reach(page, target);
    const width = await target.evaluate((el) => {
      const own = parseFloat(getComputedStyle(el).outlineWidth);
      const label = el.closest('label');
      return Math.max(own || 0, label ? parseFloat(getComputedStyle(label).outlineWidth) || 0 : 0);
    });
    assert.ok(width >= 2, `outline ${width}px`);
  }
  await context.close();
});

// ── accessibility, every screen ─────────────────────────────────────────────────────────────────────

test('no WCAG 2.2 AA violations on any screen', async () => {
  const { context, page, frame } = await open({ bypassCSP: true });
  const found = [];
  found.push(...await axeViolations(frame, 'service'));

  await frame.getByRole('radio', { name: /Follow-up/ }).check();
  await frame.getByRole('button', { name: 'Continue' }).click();
  await frame.getByRole('heading', { name: 'Choose a time' }).waitFor();
  found.push(...await axeViolations(frame, 'times'));

  await frame.locator('input[name="slot"]').first().check();
  await frame.getByRole('button', { name: /Hold this time/ }).click();
  await frame.getByRole('heading', { name: 'Your details' }).waitFor();
  found.push(...await axeViolations(frame, 'details'));

  await frame.getByLabel('Your name (required)').fill('');
  await frame.getByRole('button', { name: 'Confirm booking' }).click();
  await frame.locator('.error').first().waitFor();
  found.push(...await axeViolations(frame, 'details with errors'));
  await frame.getByLabel('Your name (required)').fill('Sample Customer');
  await frame.getByRole('button', { name: 'Confirm booking' }).click();
  await frame.getByRole('heading', { name: 'You’re booked' }).waitFor();
  await frame.locator('details.outbox summary').click();
  found.push(...await axeViolations(frame, 'booked'));

  await frame.getByRole('button', { name: 'Cancel booking' }).click();
  found.push(...await axeViolations(frame, 'cancel'));
  await frame.getByRole('button', { name: 'Yes, cancel the booking' }).click();
  found.push(...await axeViolations(frame, 'cancelled'));

  // The host page, too.
  await page.evaluate((src) => (0, eval)(src), AXE);
  const hostResult = await page.evaluate((tags) => window.axe.run(document, { runOnly: { type: 'tag', values: tags } }), WCAG);
  found.push(...hostResult.violations.map((v) => `host page: ${v.id} ${v.help}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`));

  assert.deepEqual(found, []);
  await context.close();
});

test('it works at a phone width and at 200% zoom without sideways scrolling', async () => {
  for (const viewport of [{ width: 360, height: 800 }, { width: 640, height: 600 }]) {
    const { context, page, frame } = await open({ viewport });
    await frame.getByRole('radio', { name: /Follow-up/ }).check();
    await frame.getByRole('button', { name: 'Continue' }).click();
    await frame.getByRole('heading', { name: 'Choose a time' }).waitFor();
    const overflow = await frame.locator('body').evaluate((b) => b.ownerDocument.documentElement.scrollWidth - b.ownerDocument.documentElement.clientWidth);
    assert.ok(overflow <= 0, `${viewport.width}px wide scrolls sideways by ${overflow}px`);
    const hostOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(hostOverflow <= 0, `host page scrolls sideways by ${hostOverflow}px at ${viewport.width}px`);
    await context.close();
  }
});

// ── the demo's promises ─────────────────────────────────────────────────────────────────────────────

test('a whole booking makes no request and stores nothing', async () => {
  const { context, page, frame, problems } = await open();
  const requests = [];
  page.on('request', (r) => requests.push({ url: r.url(), method: r.method(), body: r.postData() }));

  await frame.getByRole('radio', { name: /Follow-up/ }).check();
  await frame.getByRole('button', { name: 'Continue' }).click();
  await frame.locator('input[name="slot"]').first().check();
  await frame.getByRole('button', { name: /Hold this time/ }).click();
  await frame.getByLabel('Your name (required)').fill('Typed Secret Name');
  await frame.getByLabel('Email (required)').fill('typed.secret@example.com');
  await frame.getByRole('button', { name: 'Confirm booking' }).click();
  await frame.getByRole('heading', { name: 'You’re booked' }).waitFor();
  await frame.getByRole('button', { name: 'Cancel booking' }).click();
  await frame.getByRole('button', { name: 'Yes, cancel the booking' }).click();
  await frame.getByRole('heading', { name: 'Your booking is cancelled' }).waitFor();

  assert.deepEqual(requests, [], 'no request of any kind while booking, changing and cancelling');
  const frameHandle = await page.locator('iframe').elementHandle();
  const inFrame = await (await frameHandle.contentFrame()).evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie }));
  const onPage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie }));
  assert.deepEqual(inFrame, { local: 0, session: 0, cookie: '' });
  assert.deepEqual(onPage, { local: 0, session: 0, cookie: '' });
  assert.deepEqual(problems, [], 'the content security policy blocked nothing the page tried');
  await context.close();
});

test('the page loads only its own files, and the policy forbids anything else', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const loaded = [];
  page.on('request', (r) => loaded.push(r.url()));
  await page.goto(`${origin}/`);
  await page.frameLocator('iframe').getByRole('heading', { level: 2 }).waitFor();
  assert.ok(loaded.every((u) => u.startsWith(origin)), loaded.filter((u) => !u.startsWith(origin)).join(', '));
  for (const url of [`${origin}/`, `${origin}/widget/index.html`]) {
    const html = await (await context.request.get(url)).text();
    assert.match(html, /connect-src 'none'/);
    assert.match(html, /form-action 'none'/);
  }
  // A page that tries to reach out is stopped by the policy, not by good manners.
  const blocked = await page.frameLocator('iframe').locator('body').evaluate(async () => {
    try { await fetch('https://example.com/'); return 'sent'; } catch { return 'blocked'; }
  });
  assert.equal(blocked, 'blocked');
  await context.close();
});

test('reloading discards the booking', async () => {
  const { context, page, frame } = await open();
  await bookByKeyboard(page, frame);
  await page.reload();
  const again = page.frameLocator('iframe');
  await again.getByRole('heading', { name: 'Choose a service' }).waitFor();
  assert.equal(await again.getByRole('radio', { name: /Follow-up/ }).isChecked(), false);
  await context.close();
});

test('every screen says it is a demo', async () => {
  const { context, frame } = await open();
  const banner = frame.locator('.demo-banner').first();
  for (const go of [
    async () => {},
    async () => { await frame.getByRole('radio', { name: /Follow-up/ }).check(); await frame.getByRole('button', { name: 'Continue' }).click(); },
    async () => { await frame.locator('input[name="slot"]').first().check(); await frame.getByRole('button', { name: /Hold this time/ }).click(); },
    async () => { await frame.getByRole('button', { name: 'Confirm booking' }).click(); await frame.getByRole('heading', { name: 'You’re booked' }).waitFor(); },
  ]) {
    await go();
    assert.match(await banner.textContent(), /Demo only/);
    assert.ok(await banner.isVisible());
  }
  await context.close();
});

// ── behaviours that come from the decisions ─────────────────────────────────────────────────────────

test('losing a race: the overlap rule rejects the hold and other times are offered (ADR-AB-0003)', async () => {
  const { context, frame } = await open();
  await frame.getByRole('radio', { name: /Follow-up/ }).check();
  await frame.getByRole('button', { name: 'Continue' }).click();
  await frame.locator('details.demo-controls summary').click();
  await frame.getByLabel('Another customer takes the time I’m about to hold').check();
  await frame.locator('input[name="slot"]').first().check();
  await frame.getByRole('button', { name: /Hold this time/ }).click();
  await frame.getByRole('heading', { name: 'Choose a time' }).waitFor();
  const alert = await frame.locator('.alert').textContent();
  assert.match(alert, /just been taken/);
  assert.match(alert, /next free times/i);
  assert.ok(await frame.locator('input[name="slot"]').count() > 0, 'the list still offers times');
  await context.close();
});

test('the live calendar check catches a change the synchronised copy has not seen (ADR-AB-0002)', async () => {
  const { context, frame } = await open();
  await frame.getByRole('radio', { name: /Follow-up/ }).check();
  await frame.getByRole('button', { name: 'Continue' }).click();
  await frame.locator('details.demo-controls summary').click();
  const hint = await frame.locator('details.demo-controls .hint').last().textContent();
  const day = /Alex on (.+?) at 10:00 am/.exec(hint)[1];
  await frame.getByRole('radio', { name: /^Alex, Physiotherapist/ }).check();
  await frame.getByRole('radio', { name: new RegExp(day) }).check();
  await frame.getByRole('radio', { name: /^10:00 am/ }).check();
  await frame.getByRole('button', { name: /Hold this time/ }).click();
  await frame.getByRole('heading', { name: 'Your details' }).waitFor();
  await frame.getByRole('button', { name: 'Confirm booking' }).click();
  await frame.getByRole('heading', { name: 'Choose a time' }).waitFor();
  const alert = await frame.locator('.alert').textContent();
  assert.match(alert, /no longer free/);
  assert.match(alert, /next free times/i, 'alternatives are offered at once, not a dead end');
  await context.close();
});

test('a hold can be extended, and ends if it is not (WCAG 2.2.1)', async () => {
  const { context, page, frame } = await open({ clock: true });
  await frame.getByRole('radio', { name: /Follow-up/ }).check();
  await frame.getByRole('button', { name: 'Continue' }).click();
  await frame.locator('input[name="slot"]').first().check();
  await frame.getByRole('button', { name: /Hold this time/ }).click();
  await frame.getByRole('heading', { name: 'Your details' }).waitFor();
  assert.equal(await frame.locator('#countdown').textContent(), '5:00');

  await page.clock.fastForward(4 * 60 * 1000);
  await frame.getByRole('button', { name: 'Keep holding for 5 more minutes' }).click();
  assert.equal(await frame.locator('#countdown').textContent(), '5:00');
  await page.clock.runFor(100); // the announcement is deferred a moment, on the page's own clock
  assert.match(await frame.locator('#status').textContent(), /another five minutes/);

  await page.clock.fastForward(4 * 60 * 1000 + 5000);
  await page.clock.runFor(100);
  assert.match(await frame.locator('#status').textContent(), /One minute left/, 'a warning is announced before the end');
  await page.clock.fastForward(60 * 1000);
  await frame.getByRole('heading', { name: 'Choose a time' }).waitFor();
  assert.match(await frame.locator('.alert').textContent(), /hold on that time ended/);
  await context.close();
});

test('times are shown in the chosen zone, with the zone named (ADR-AB-0006)', async () => {
  const { context, frame } = await open();
  await frame.getByRole('radio', { name: /Follow-up/ }).check();
  await frame.getByRole('button', { name: 'Continue' }).click();
  const sydney = await frame.locator('input[name="slot"]').first().evaluate((el) => el.closest('label').textContent);
  assert.match(sydney, /AE[SD]T|GMT\+1[01]/);
  await frame.getByLabel('Show times in').selectOption('America/Los_Angeles');
  const la = await frame.locator('input[name="slot"]').first().evaluate((el) => el.closest('label').textContent);
  assert.match(la, /P[SD]T|GMT-[78]/);
  assert.notEqual(sydney, la);
  await context.close();
});

test('the embedding page cannot read the widget, and only accepts a height from it', async () => {
  const { context, page, frame } = await open();
  await frame.getByLabel('Show times in').count();
  await frame.getByRole('radio', { name: /Follow-up/ }).check();
  await frame.getByRole('button', { name: 'Continue' }).click();
  // Same origin in this demo, so the real isolation comes from serving the widget from its own
  // origin; what the page is built to receive is checked here: a message from anywhere else is ignored.
  const before = await page.locator('iframe').evaluate((f) => f.style.height);
  await page.evaluate(() => window.postMessage({ source: 'appointment-booking-widget', type: 'resize', height: 3 }, '*'));
  const after = await page.locator('iframe').evaluate((f) => f.style.height);
  assert.equal(after, before, 'a resize message not sent by the widget frame is ignored');
  await context.close();
});

test('the brand colour is used only if white text stays readable on it', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const colour = async (brand) => {
    await page.goto(`${origin}/widget/index.html?brand=${encodeURIComponent(brand)}`);
    return page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand').trim());
  };
  assert.equal(await colour('#7a1f5c'), '#7a1f5c', 'dark enough');
  assert.equal(await colour('#ffd54f'), '#0b5c8e', 'a pale colour would fail contrast, so the default stays');
  assert.equal(await colour('red; background:url(x)'), '#0b5c8e', 'only a hex colour is accepted');
  await context.close();
});

test('the frame fits the widget: it grows for a long step and shrinks back', async () => {
  const { context, page, frame } = await open();
  const height = () => page.locator('iframe').evaluate((f) => f.getBoundingClientRect().height);
  const service = await height();
  await frame.getByRole('radio', { name: /Follow-up/ }).check();
  await frame.getByRole('button', { name: 'Continue' }).click();
  await frame.getByRole('heading', { name: 'Choose a time' }).waitFor();
  await page.waitForTimeout(300);
  const times = await height();
  assert.ok(times > service + 200, `the times step (${times}px) is taller than the service step (${service}px)`);
  await frame.getByRole('button', { name: 'Change service' }).click();
  await frame.getByRole('heading', { name: 'Choose a service' }).waitFor();
  await page.waitForTimeout(300);
  assert.ok(Math.abs((await height()) - service) <= 4, 'and it shrinks back to fit the shorter step');
  assert.ok(service < 480, `no empty space under the first step (${service}px)`);
  await context.close();
});
