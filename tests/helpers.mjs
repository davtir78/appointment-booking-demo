// Shared set-up for the API tests: a server on a frozen clock, and small helpers for calling it.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { createClock } from '../server/clock.js';
import { DEMO_BUSINESS, DEMO_KEY, OTHER_BUSINESS, OTHER_KEY } from '../server/seed.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ORIGIN = 'http://clinic.test';
export { DEMO_BUSINESS, DEMO_KEY, OTHER_BUSINESS, OTHER_KEY };
export const MIN = 60000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** Monday 28 September 2026, 10:00 in Sydney. */
export const START = Date.UTC(2026, 8, 28, 0, 0);

/** Distinctive details, so a test can search every log line for them. */
export const CUSTOMER = { name: 'Zephyr Quillfeather', email: 'zephyr.quillfeather@example.com', phone: '0411 999 123' };

let counter = 0;
export const idem = () => `key-${String(++counter).padStart(8, '0')}-test`;

export async function boot({ now = START, origins = [ORIGIN] } = {}) {
  const clock = createClock({ fixed: now });
  const app = createApp({ clock, origins, staticRoot: ROOT });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;

  async function call(method, path, { body, headers = {}, key = DEMO_KEY, origin = ORIGIN, key_ = undefined } = {}) {
    const h = { ...(key ? { 'x-widget-key': key } : {}), ...(origin ? { 'x-embedding-origin': origin } : {}), ...headers };
    if (body !== undefined) h['content-type'] = h['content-type'] ?? 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, json, text };
  }

  const api = {
    services: () => call('GET', `/v1/businesses/${DEMO_BUSINESS}/services`),
    availability: (service = 'followup', { from, to, staff } = {}) =>
      call('GET', `/v1/businesses/${DEMO_BUSINESS}/availability?service=${service}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}${staff ? `&staff=${staff}` : ''}`),
    hold: (slot, { service = 'followup', key = idem(), ...opts } = {}) =>
      call('POST', `/v1/businesses/${DEMO_BUSINESS}/holds`, { body: { serviceId: service, staffId: slot.staffId, start: Date.parse(slot.start) }, headers: { 'idempotency-key': key }, ...opts }),
    confirm: (holdId, customer = CUSTOMER, { key = idem(), ...opts } = {}) =>
      call('POST', `/v1/holds/${holdId}/confirm`, { body: { customer }, headers: { 'idempotency-key': key }, ...opts }),
    extend: (holdId) => call('POST', `/v1/holds/${holdId}/extend`),
    release: (holdId) => call('DELETE', `/v1/holds/${holdId}`),
    booking: (id, token) => call('GET', `/v1/bookings/${id}`, { headers: { 'x-booking-token': token } }),
    reschedule: (id, token, holdId) => call('PATCH', `/v1/bookings/${id}`, { body: { holdId }, headers: { 'x-booking-token': token } }),
    cancel: (id, token) => call('DELETE', `/v1/bookings/${id}`, { headers: { 'x-booking-token': token } }),
  };

  /** Free slots, optionally for one person; fails the test loudly if the search itself is broken. */
  async function slots(service = 'followup', opts = {}) {
    const r = await api.availability(service, opts);
    if (r.status !== 200) throw new Error(`availability returned ${r.status}: ${r.text}`);
    return r.json.slots;
  }

  /** A free slot at least three hours away, so a test can move the clock a little without it becoming unbookable. */
  async function pick(service = 'followup', { index = 0, staff } = {}) {
    const later = (await slots(service, { staff })).filter((x) => Date.parse(x.start) >= clock.now() + 3 * HOUR);
    return later[index];
  }

  /** Hold and confirm the slot at `index`, returning the booking. */
  async function book({ index = 0, service = 'followup', customer = CUSTOMER, staff } = {}) {
    const slot = (await slots(service, { staff }))[index];
    const hold = await api.hold(slot, { service });
    if (hold.status !== 201) throw new Error(`hold returned ${hold.status}: ${hold.text}`);
    const booking = await api.confirm(hold.json.id, customer);
    if (booking.status !== 201) throw new Error(`confirm returned ${booking.status}: ${booking.text}`);
    return { slot, hold: hold.json, booking: booking.json };
  }

  return { app, clock, base, port, call, api, slots, pick, book, ctx: () => app.ctx, close: () => app.close() };
}
