// The API Gateway (SAD component "API gateway") and the wiring of everything behind it.
//
// ICR-AB-0001 is implemented here: the /v1/ operations; the public widget key that identifies one
// business; the registered-origin check; Idempotency-Key on POSTs; W3C traceparent returned on every
// response; RFC 9457 problem details; a per-business rate limit with Retry-After; and a log that
// never holds personal information. Everything behind the gateway is reached only through it.
//
// The server answers on the loopback address only and rejects any request whose Host is not a local
// name, which also defeats DNS-rebinding. Demo inspection and control endpoints live under /_demo/.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { createClock } from './clock.js';
import { createLog } from './log.js';
import { Store } from './store.js';
import { createCalendarProvider } from './providers/calendar.js';
import { createMessagingProvider } from './providers/messaging.js';
import { createCalendarConnector } from './calendar-connector.js';
import { createNotificationWorker } from './notification-worker.js';
import { createBookingService } from './booking-service.js';
import { HttpError, problem } from './errors.js';
import { seed, DEMO_BUSINESS } from './seed.js';
import { zonedParts } from '../widget/time.js';

const MAX_BODY_BYTES = 16 * 1024;
const RATE_CAPACITY = 50;           // ICR-AB-0001: 50 requests per second per business
const RATE_PER_SECOND = 50;
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_KEYS = new Set(['start', 'end', 'expiresAt', 'serverTime', 'generatedAt']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/** Every time in every response is an ISO 8601 instant (ICR-AB-0001 criterion 5). */
export function present(value) {
  if (Array.isArray(value)) return value.map(present);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, TIME_KEYS.has(k) && typeof v === 'number' ? new Date(v).toISOString() : present(v)]));
  }
  return value;
}

/**
 * @param {object} options
 * @param {ReturnType<typeof createClock>} [options.clock]
 * @param {string[]} [options.origins]   domains registered for the widget key
 * @param {string}   [options.staticRoot] the repository root, from which /widget/ is served
 * @param {boolean}  [options.demo]      serve the /_demo/ inspection and control endpoints
 */
export function createApp({ clock = createClock(), origins = [], staticRoot = process.cwd(), demo = true } = {}) {
  let registered = [...origins];
  let ctx = build();

  function build() {
    const log = createLog({ now: clock.now });
    const store = new Store({ clock });
    store.touchClock();
    const calendar = createCalendarProvider({ clock });
    const messaging = createMessagingProvider({ clock });
    const connector = createCalendarConnector({ store, provider: calendar, clock, log });
    const worker = createNotificationWorker({ store, provider: messaging, clock, log });
    const service = createBookingService({ store, connector, worker, clock, log });
    seed({ store, calendar, connector, clock, origins: registered });
    return { log, store, calendar, messaging, connector, worker, service, buckets: new Map() };
  }

  // ── cross-cutting rules ──

  /** A token bucket per business, on the injected clock: 50 requests a second, no more. */
  function takeToken(businessId) {
    const now = clock.now();
    const b = ctx.buckets.get(businessId) ?? { tokens: RATE_CAPACITY, at: now };
    b.tokens = Math.min(RATE_CAPACITY, b.tokens + ((now - b.at) / 1000) * RATE_PER_SECOND);
    b.at = now;
    ctx.buckets.set(businessId, b);
    if (b.tokens >= 1) { b.tokens -= 1; return 0; }
    return Math.max(1, Math.ceil((1 - b.tokens) / RATE_PER_SECOND));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      // Read it all but keep none past the limit, so the refusal reaches the caller instead of a dropped connection.
      req.on('data', (c) => { size += c.length; if (size <= MAX_BODY_BYTES) chunks.push(c); });
      req.on('end', () => (size > MAX_BODY_BYTES ? reject(new HttpError(413, 'payload_too_large', 'The request body is too large.')) : resolve(Buffer.concat(chunks).toString('utf8'))));
      req.on('error', reject);
    });
  }

  async function jsonBody(req) {
    const text = await readBody(req);
    if (!text) return {};
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Send application/json.');
    try { return JSON.parse(text); } catch { throw new HttpError(400, 'invalid_request', 'The body is not valid JSON.'); }
  }

  const idempotencyKey = (req) => {
    const key = req.headers['idempotency-key'];
    if (!key || !IDEMPOTENCY_KEY.test(String(key))) throw new HttpError(400, 'idempotency_key_required', 'POST requests need an Idempotency-Key header of 8 to 64 letters, digits, - or _.');
    return String(key);
  };

  // ── the /v1 API ──

  async function api(req, url, trace) {
    const key = req.headers['x-widget-key'];
    const business = key ? ctx.store.businessByKey(String(key)) : null;
    if (!business) throw new HttpError(401, 'unknown_key', 'The widget key is unknown or has been revoked.');
    const claimed = req.headers['x-embedding-origin'] ?? req.headers.origin;
    if (!claimed || !business.origins.includes(String(claimed))) throw new HttpError(403, 'origin_not_registered', 'This domain is not registered for that widget key.');
    trace.businessId = business.id;
    trace.origins = business.origins;
    const retry = takeToken(business.id);
    if (retry) throw new HttpError(429, 'rate_limited', 'Too many requests for this business.', { retryAfter: retry });

    const b = business.id;
    const svc = ctx.service;
    const token = req.headers['x-booking-token'] ? String(req.headers['x-booking-token']) : null;
    const method = req.method;
    let m;

    if ((m = /^\/v1\/businesses\/([\w-]+)\/(services|availability|holds)$/.exec(url.pathname))) {
      if (m[1] !== b) throw new HttpError(404, 'unknown_business', 'No such business.');
      if (m[2] === 'services' && method === 'GET') {
        trace.route = 'GET /v1/businesses/{id}/services';
        return { status: 200, body: { ...svc.catalog(b), serverTime: clock.now() } };
      }
      if (m[2] === 'availability' && method === 'GET') {
        trace.route = 'GET /v1/businesses/{id}/availability';
        const serviceId = url.searchParams.get('service');
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        if (!serviceId) throw new HttpError(400, 'invalid_request', 'service is required.');
        if ((from && !DATE.test(from)) || (to && !DATE.test(to))) throw new HttpError(400, 'invalid_request', 'from and to must be dates like 2026-10-05.');
        const days = from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 : 7;
        const slots = svc.search(b, { serviceId, fromDate: from ?? undefined, days: Number.isFinite(days) && days > 0 ? days : 7, staffId: url.searchParams.get('staff') });
        return { status: 200, body: { service: serviceId, timeZone: business.timeZone, slots, generatedAt: clock.now(), serverTime: clock.now() } };
      }
      if (m[2] === 'holds' && method === 'POST') {
        trace.route = 'POST /v1/businesses/{id}/holds';
        const body = await jsonBody(req);
        // Times travel as ISO 8601 instants (ICR-AB-0001); the service works in milliseconds.
        if (typeof body.start === 'string') body.start = Date.parse(body.start);
        const result = svc.createHold(b, body, idempotencyKey(req));
        return { ...result, body: { ...result.body, serverTime: clock.now() } };
      }
      throw new HttpError(404, 'unknown_route', 'No such operation.');
    }

    if ((m = /^\/v1\/holds\/([\w-]+)(?:\/(confirm|extend))?$/.exec(url.pathname))) {
      const holdId = m[1];
      if (m[2] === 'confirm' && method === 'POST') {
        trace.route = 'POST /v1/holds/{id}/confirm';
        const result = svc.confirm(b, holdId, await jsonBody(req), idempotencyKey(req));
        return { ...result, body: { ...result.body, serverTime: clock.now() } };
      }
      if (m[2] === 'extend' && method === 'POST') {
        trace.route = 'POST /v1/holds/{id}/extend';
        return { status: 200, body: { ...svc.extend(b, holdId), serverTime: clock.now() } };
      }
      if (!m[2] && method === 'DELETE') {
        trace.route = 'DELETE /v1/holds/{id}';
        svc.release(b, holdId);
        return { status: 204 };
      }
      throw new HttpError(404, 'unknown_route', 'No such operation.');
    }

    if ((m = /^\/v1\/bookings\/([\w-]+)$/.exec(url.pathname))) {
      const bookingId = m[1];
      if (method === 'GET') { trace.route = 'GET /v1/bookings/{id}'; return { status: 200, body: svc.getBooking(b, bookingId, token) }; }
      if (method === 'PATCH') {
        trace.route = 'PATCH /v1/bookings/{id}';
        const body = await jsonBody(req);
        if (typeof body.holdId !== 'string') throw new HttpError(400, 'invalid_request', 'holdId is required.');
        return { status: 200, body: { ...svc.reschedule(b, bookingId, token, body.holdId), serverTime: clock.now() } };
      }
      if (method === 'DELETE') { trace.route = 'DELETE /v1/bookings/{id}'; svc.cancel(b, bookingId, token); return { status: 204 }; }
    }
    throw new HttpError(404, 'unknown_route', 'No such operation.');
  }

  // ── the widget's own files, framed only by the domains the business registered ──

  async function widgetFile(url) {
    const name = decodeURIComponent(url.pathname.slice('/widget/'.length)) || 'index.html';
    const root = path.join(staticRoot, 'widget');
    const file = path.normalize(path.join(root, name));
    if (!file.startsWith(root + path.sep) || !MIME[path.extname(file)]) throw new HttpError(404, 'not_found', 'Not found.');
    let content = await readFile(file).catch(() => { throw new HttpError(404, 'not_found', 'Not found.'); });
    const headers = { 'content-type': MIME[path.extname(file)], 'cache-control': 'no-store' };
    if (path.basename(file) === 'index.html') {
      // This copy of the page talks to the API it came from; the repository's own copy talks to nothing.
      content = Buffer.from(content.toString('utf8').replace("connect-src 'none'", "connect-src 'self'"));
      // ADR-AB-0001 and ICR-AB-0001: only pages the business registered may frame the widget.
      const key = url.searchParams.get('key');
      const business = key ? ctx.store.businessByKey(key) : null;
      const ancestors = !key ? "'self'" : business && business.origins.length ? business.origins.join(' ') : "'none'";
      headers['content-security-policy'] = `frame-ancestors ${ancestors}`;
    }
    return { content, headers };
  }

  // ── demo inspection and control, never reachable from another machine ──

  function hint() {
    const business = ctx.store.scope(DEMO_BUSINESS).business();
    const slot = ctx.service.search(DEMO_BUSINESS, { serviceId: 'followup', days: 14, staffId: 'alex' }).find((s) => {
      const p = zonedParts(s.start, business.timeZone);
      return p.h === 10 && p.mi === 0;
    });
    return slot ? { staffId: 'alex', staff: 'Alex', serviceId: 'followup', start: slot.start, end: slot.end } : null;
  }

  async function demoRoute(req, url) {
    const { log, calendar, messaging, connector, worker, store } = ctx;
    const route = `${req.method} ${url.pathname}`;
    if (req.method !== 'GET' && req.headers['x-demo-control'] !== '1') throw new HttpError(403, 'forbidden', 'Demo controls need the X-Demo-Control header.');
    switch (route) {
      case 'GET /_demo/events': {
        const after = Number(url.searchParams.get('since') ?? 0) || 0;
        const events = log.since(after);
        return { status: 200, body: { events, lastSeq: events.length ? events[events.length - 1].seq : after, serverTime: clock.now() } };
      }
      case 'GET /_demo/state':
        return { status: 200, body: {
          serverTime: clock.now(), messagingDown: messaging.isDown(), calendarDown: calendar.isDown(), hint: hint(),
          inbox: messaging.inbox().map(({ id, channel, to, subject, body, at }) => ({ id, channel, to, subject, body, at })),
          outbox: store.scope(DEMO_BUSINESS).outboxStatusCounts(), connections: connector.status(DEMO_BUSINESS),
          pendingCalendarWrites: store.scope(DEMO_BUSINESS).calendarWriteCount('pending'),
        } };
      case 'POST /_demo/messaging': { const b = await jsonBody(req); messaging.setDown(b.down); log.write('provider', b.down ? 'messaging_down' : 'messaging_up', {}, { level: 'warn', ref: 'ICR-AB-0003#error-handling' }); return { status: 200, body: { down: messaging.isDown() } }; }
      case 'POST /_demo/calendar': { const b = await jsonBody(req); calendar.setDown(b.down); log.write('provider', b.down ? 'calendar_down' : 'calendar_up', {}, { level: 'warn', ref: 'ICR-AB-0002#error-handling' }); return { status: 200, body: { down: calendar.isDown() } }; }
      case 'POST /_demo/calendar/silent-event': {
        const h = hint();
        if (!h) throw new HttpError(409, 'nothing_to_stage', 'There is no free 10:00 follow-up with Alex to take.');
        calendar.staffAdds(h.staffId, { start: h.start, end: h.end, notify: false });
        log.write('provider', 'event_added_without_notification', { staffId: h.staffId }, { level: 'warn', ref: 'ADR-AB-0002' });
        return { status: 200, body: { staffId: h.staffId, start: h.start } };
      }
      case 'POST /_demo/clock': {
        const b = await jsonBody(req);
        clock.advance(Math.max(0, Math.min(Number(b.advanceMs) || 0, 7 * 24 * 3600 * 1000)));
        log.write('server', 'clock_advanced', { ms: Number(b.advanceMs) || 0 }, { ref: 'ADR-AB-0003' });
        app.tick();
        return { status: 200, body: { serverTime: clock.now() } };
      }
      case 'POST /_demo/tick': app.tick(); return { status: 200, body: { serverTime: clock.now() } };
      case 'POST /_demo/reset': ctx = build(); return { status: 200, body: { serverTime: clock.now() } };
      default: throw new HttpError(404, 'unknown_route', 'No such demo endpoint.');
    }
  }

  // ── the HTTP server ──

  async function handle(req, res) {
    const started = performance.now();
    const trace = { route: null, businessId: null };
    const inbound = TRACEPARENT.exec(String(req.headers.traceparent ?? ''));
    const traceId = inbound ? inbound[1] : randomBytes(16).toString('hex');
    const traceparent = `00-${traceId}-${randomBytes(8).toString('hex')}-01`;
    const origin = req.headers.origin ? String(req.headers.origin) : null;
    const url = new URL(req.url, 'http://local');
    const headers = { traceparent, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    let status = 500;
    let payload;
    let replayed = false;

    try {
      if (!LOCAL_HOST.test(String(req.headers.host ?? ''))) throw new HttpError(403, 'forbidden', 'This service answers on the local machine only.');

      if (url.pathname === '/healthz') {
        ({ status, payload } = { status: 200, payload: { status: 'ok' } });
      } else if (url.pathname.startsWith('/widget/') && req.method === 'GET') {
        const file = await widgetFile(url);
        res.writeHead(200, { ...headers, ...file.headers });
        res.end(file.content);
        status = 200;
        return;
      } else if (url.pathname.startsWith('/_demo/') && demo) {
        // Never answers a cross-site request: no CORS headers are sent, and POSTs need a custom header.
        const out = await demoRoute(req, url);
        ({ status, payload } = { status: out.status, payload: out.body });
      } else if (url.pathname.startsWith('/v1/')) {
        if (req.method === 'OPTIONS') {
          const allowed = origin && ctx.store.businessIds().some((id) => ctx.store.scope(id).business().origins.includes(origin));
          if (allowed) Object.assign(headers, cors(origin));
          res.writeHead(204, headers);
          res.end();
          status = 204;
          return;
        }
        const out = await api(req, url, trace);
        status = out.status;
        payload = out.body;
        replayed = Boolean(out.replayed);
        if (replayed) headers['idempotent-replayed'] = 'true';
      } else {
        throw new HttpError(404, 'not_found', 'Not found.');
      }
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, 'internal_error', 'Something went wrong on our side.');
      if (!(e instanceof HttpError)) ctx.log.write('gateway', 'internal_error', { route: trace.route ?? 'unknown', errorName: e?.name ?? 'Error' }, { level: 'error', traceId });
      status = err.status;
      if (err.code === 'rate_limited') headers['retry-after'] = String(err.extra.retryAfter);
      payload = problem(err, url.pathname.startsWith('/v1/') ? trace.route ?? undefined : undefined);
      if (err.code === 'rate_limited') delete payload.retryAfter;
      headers['content-type'] = 'application/problem+json';
    }
    // A registered page may read every answer, errors included: a 409 with alternatives is no use if the browser hides it.
    if (origin && trace.origins?.includes(origin)) Object.assign(headers, cors(origin));

    if (status === 204) { res.writeHead(204, headers); res.end(); } else {
      headers['content-type'] ??= 'application/json';
      headers['cache-control'] = 'no-store';
      res.writeHead(status, headers);
      res.end(JSON.stringify(present(payload)));
    }
    // The demo's own inspection calls (the panel polls every couple of seconds) are not part of the system being shown.
    if (!url.pathname.startsWith('/_demo/')) ctx.log.write('gateway', 'request', { route: trace.route ?? `${req.method} ${url.pathname.split('/').slice(0, 3).join('/')}`, status, ms: Math.round((performance.now() - started) * 10) / 10, ...(trace.businessId ? { businessId: trace.businessId } : {}), ...(replayed ? { replayed: true } : {}) },
      { traceId, ref: 'ICR-AB-0001#observability', level: status >= 500 ? 'error' : 'info' });
  }

  const cors = (origin) => ({
    'access-control-allow-origin': origin, vary: 'Origin',
    'access-control-allow-headers': 'content-type, idempotency-key, x-widget-key, x-booking-token, x-embedding-origin, traceparent',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-expose-headers': 'traceparent, retry-after, idempotent-replayed',
  });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { try { res.writeHead(500); res.end(); } catch { /* the connection is gone */ } ctx.log.write('gateway', 'unhandled', { errorName: e?.name ?? 'Error' }, { level: 'error' }); });
  });

  const app = {
    server,
    clock,
    get ctx() { return ctx; },
    /** The scheduler: connector, worker and housekeeping. Called every second when running, by hand in tests. */
    tick() { ctx.connector.tick(); ctx.worker.tick(); ctx.service.tick(); },
    setOrigins(list) { registered = [...list]; for (const id of ctx.store.businessIds()) ctx.store.setOrigins(id, registered); },
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
  return app;
}
