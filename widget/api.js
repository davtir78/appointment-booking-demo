// The widget talks to a backend through one interface, with two implementations:
//
//   LocalApi  the in-browser Backend of domain.js. This is the public demo: no request leaves the
//             page, and nothing is kept.
//   HttpApi   the real Booking API of ICR-AB-0001, over HTTP. Used only when the page is opened with a
//             widget key (?key=...), which the API's own copy of this page allows by its content
//             security policy. The repository's copy of the page cannot make a request at all.
//
// Both answer with the same shapes: times are milliseconds, errors are ApiError.

import { ApiError, Backend } from './domain.js';
import { addDays, dateInZone } from './time.js';

const TIME_KEYS = new Set(['start', 'end', 'expiresAt', 'serverTime', 'generatedAt']);
const TYPE_OF_LOCAL = { confirmation: 'BookingConfirmed', reminder: 'ReminderDue', rescheduled: 'BookingRescheduled', cancelled: 'BookingCancelled' };

/** ISO strings in a response become milliseconds, so the rest of the widget is mode-blind. */
function fromWire(value) {
  if (Array.isArray(value)) return value.map(fromWire);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, TIME_KEYS.has(k) && typeof v === 'string' ? Date.parse(v) : fromWire(v)]));
  }
  return value;
}

const hex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
/** W3C Trace Context, created by the widget and returned by every response (ICR-AB-0001: observability). */
const newTraceparent = () => `00-${hex(16)}-${hex(8)}-01`;

// ── the public demo: everything in the browser ──────────────────────────────────────────────────────

class LocalApi {
  mode = 'local';

  constructor() {
    this.backend = new Backend();
    this.business = this.backend.business;
    this.services = this.backend.services;
    this.staff = this.backend.staff;
    this.demo = {
      hint: () => this.backend.hints(),
      race: () => this.backend.raceNext,
      setRace: (value) => { this.backend.raceNext = value; },
    };
  }

  now() { return Date.now(); }
  serviceById(id) { return this.services.find((s) => s.id === id); }
  staffById(id) { return this.staff.find((s) => s.id === id); }

  #messages(bookingId) {
    return this.backend.outbox.filter((m) => m.bookingId === bookingId).map((m) => ({ type: TYPE_OF_LOCAL[m.type] ?? m.type, ...(m.sendAt ? { sendAt: m.sendAt } : {}), status: 'queued' }));
  }

  async availability({ serviceId, staffId, days }) { return this.backend.availability({ serviceId, staffId, days }); }
  async createHold({ serviceId, staffId, start }) { return this.backend.createHold({ serviceId, staffId, start }); }
  async extendHold(id) { return this.backend.extendHold(id); }
  async releaseHold(id) { this.backend.releaseHold(id); }
  async confirmHold(holdId, details) {
    const booking = this.backend.confirmHold(holdId, details, { idempotencyKey: `confirm-${holdId}` });
    return { ...booking, messages: this.#messages(booking.id) };
  }
  async reschedule(bookingId, token, holdId) {
    const booking = this.backend.reschedule(bookingId, token, holdId);
    return { ...booking, messages: this.#messages(booking.id) };
  }
  async cancel(bookingId, token) {
    this.backend.cancel(bookingId, token);
    return [{ type: 'BookingCancelled', status: 'queued' }];
  }
}

// ── the real API ────────────────────────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 10000;   // ICR-AB-0001: the widget waits 10 seconds, then shows a retry prompt
const MAX_RETRIES = 2;      // safe requests, and requests carrying an idempotency key, at most twice

const routeOf = (method, path) => `${method} ${path.replace(/\/businesses\/[\w-]+/, '/businesses/{id}').replace(/\/(holds|bookings)\/[\w-]+/, '/$1/{id}')}`.replace(/\?.*$/, '');

class HttpApi {
  mode = 'http';

  constructor({ base, key, embeddingOrigin, businessId }) {
    Object.assign(this, { base, key, embeddingOrigin, businessId });
    this.skew = 0;
    this.requests = [];
    this.listeners = new Set();
  }

  /** Learn the business's services and staff, and how far the server's clock is from ours. */
  async open() {
    const { json } = await this.#request('GET', `/v1/businesses/${this.businessId}/services`);
    this.business = json.business;
    this.services = json.services;
    this.staff = json.staff;
    return this;
  }

  now() { return Date.now() + this.skew; }
  /** The demo's clock control moved the server's clock: follow it, so countdowns stay true. */
  adoptServerTime(serverTime) {
    const ms = typeof serverTime === 'string' ? Date.parse(serverTime) : serverTime; // the wire carries ISO 8601
    if (Number.isFinite(ms)) this.skew = ms - Date.now();
  }
  serviceById(id) { return this.services.find((s) => s.id === id); }
  staffById(id) { return this.staff.find((s) => s.id === id); }
  onActivity(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  async #request(method, path, { body, idempotent = false, token = null } = {}) {
    const traceparent = newTraceparent();
    const idempotencyKey = idempotent ? crypto.randomUUID() : null;
    const retriable = method === 'GET' || idempotent;
    let lastError;
    for (let attempt = 0; attempt <= (retriable ? MAX_RETRIES : 0); attempt += 1) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * attempt * (0.5 + Math.random()))); // jittered backoff
      const started = performance.now();
      const entry = { at: Date.now(), method, route: routeOf(method, path), traceparent, idempotencyKey, attempt: attempt + 1, status: null, ms: null, code: null, replayed: false };
      this.requests.push(entry);
      if (this.requests.length > 200) this.requests.shift();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(`${this.base}${path}`, {
          method, signal: controller.signal, cache: 'no-store',
          headers: {
            'x-widget-key': this.key, 'x-embedding-origin': this.embeddingOrigin, traceparent,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
            ...(token ? { 'x-booking-token': token } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        const json = text ? JSON.parse(text) : null;
        Object.assign(entry, { status: res.status, ms: Math.round(performance.now() - started), code: json?.code ?? null, replayed: res.headers.get('idempotent-replayed') === 'true' });
        this.#notify();
        if (res.ok) {
          const wire = fromWire(json);
          if (wire?.serverTime) this.skew = wire.serverTime - Date.now();
          return { status: res.status, json: wire };
        }
        const problem = fromWire(json) ?? {};
        const error = new ApiError(res.status, problem.code ?? 'error', problem.detail ?? 'The request failed.', problem.alternatives ? { alternatives: problem.alternatives } : {});
        if (res.status !== 503) throw error; // a 409, 410 and the rest are answers, never retried
        lastError = error;
      } catch (e) {
        if (e instanceof ApiError) throw e;
        entry.status = 0;
        entry.code = e.name === 'AbortError' ? 'timeout' : 'unreachable';
        entry.ms = Math.round(performance.now() - started);
        this.#notify();
        lastError = new ApiError(0, entry.code, e.name === 'AbortError' ? 'The booking service took too long to answer.' : 'The booking service can’t be reached just now.');
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  #notify() { for (const fn of this.listeners) fn(); }

  #messages(notifications) { return (notifications?.messages ?? []).filter((m) => m.status !== 'superseded' && m.status !== 'dropped'); }

  async availability({ serviceId, staffId, days = 14 }) {
    const tz = this.business.timeZone;
    const from = dateInZone(this.now(), tz);
    const query = `service=${encodeURIComponent(serviceId)}&from=${from}&to=${addDays(from, Math.max(1, days) - 1)}${staffId ? `&staff=${encodeURIComponent(staffId)}` : ''}`;
    const { json } = await this.#request('GET', `/v1/businesses/${this.businessId}/availability?${query}`);
    return json.slots;
  }
  async createHold({ serviceId, staffId, start }) {
    const { json } = await this.#request('POST', `/v1/businesses/${this.businessId}/holds`, { body: { serviceId, staffId, start: new Date(start).toISOString() }, idempotent: true });
    return json;
  }
  async extendHold(id) { return (await this.#request('POST', `/v1/holds/${id}/extend`)).json; }
  async releaseHold(id) { await this.#request('DELETE', `/v1/holds/${id}`); }
  async confirmHold(holdId, details) {
    const { json } = await this.#request('POST', `/v1/holds/${holdId}/confirm`, { body: { customer: details }, idempotent: true });
    return { ...json, messages: this.#messages(json.notifications) };
  }
  async reschedule(bookingId, token, holdId) {
    const { json } = await this.#request('PATCH', `/v1/bookings/${bookingId}`, { body: { holdId }, token });
    return { ...json, token, messages: this.#messages(json.notifications) };
  }
  async cancel(bookingId, token) {
    await this.#request('DELETE', `/v1/bookings/${bookingId}`, { token });
    return [{ type: 'BookingCancelled', status: 'queued' }];
  }
}

// ── choosing the mode ───────────────────────────────────────────────────────────────────────────────

/**
 * The embedding page's origin, as the browser vouches for it. The loader answers a "ready" message,
 * and `event.origin` on that answer cannot be forged by the page's own scripts. Opened on its own
 * (not framed), the widget is its own embedder.
 */
function learnEmbeddingOrigin() {
  if (window.parent === window) return Promise.resolve(location.origin);
  return new Promise((resolve) => {
    const done = (origin) => { window.removeEventListener('message', onMessage); clearTimeout(timer); resolve(origin); };
    const onMessage = (event) => {
      if (event.source === window.parent && event.data?.source === 'appointment-booking-loader' && event.data.type === 'init') done(event.origin);
    };
    const timer = setTimeout(() => done(document.referrer ? new URL(document.referrer).origin : location.origin), 2000);
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ source: 'appointment-booking-widget', type: 'ready' }, '*');
  });
}

export async function createApi() {
  const params = new URLSearchParams(location.search);
  const key = params.get('key');
  if (!key) return new LocalApi();
  const api = new HttpApi({ base: location.origin, key, embeddingOrigin: await learnEmbeddingOrigin(), businessId: params.get('business') ?? 'example-clinic' });
  return api.open();
}

