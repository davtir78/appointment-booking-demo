// The "Behind the scenes" panel: shown only when the widget is talking to the real API. It is where the
// documents and the running system meet. For every request the widget makes and every event the server
// logs it says which part of the design is acting and links to the record that part implements:
//
//   SAD       the component, in the Solution Architecture Design's component catalog
//   ADR       the decision being carried out
//   ICR       the clause of the contract being met
//   pattern   the integration pattern from the library the interface is built on
//
// It also lists what the stand-in messaging provider "sent", and holds the controls for staging the
// awkward cases: a provider outage, a calendar change the sync won't hear about, time passing.

import { formatDay, formatSlot } from './time.js';

const DOCS = 'https://github.com/davtir78/architecture-records/blob/main/samples/appointment-booking/';
const SITE = 'https://www.itarchitecturepatterns.net';

const RECORDS = {
  'ADR-AB-0001': ['decisions/0001-embed-mechanism.md', 'Embed the widget in an iframe'],
  'ADR-AB-0002': ['decisions/0002-api-exposure.md', 'A public REST API behind a gateway'],
  'ADR-AB-0003': ['decisions/0003-availability-source-of-truth.md', 'Availability from a synchronised copy'],
  'ADR-AB-0004': ['decisions/0004-calendar-integration.md', 'Each provider’s own API and notifications'],
  'ADR-AB-0005': ['decisions/0005-multi-tenancy.md', 'Shared database, tenant isolation'],
  'ADR-AB-0006': ['decisions/0006-hosting-and-recovery.md', 'Containers in one region, recoverable into a second'],
  'ADR-AB-0007': ['decisions/0007-data-store.md', 'A managed PostgreSQL database'],
  'REQ-BOOKING': ['requirements/booking.md', 'Booking requirements'],
  'REQ-AVAILABILITY': ['requirements/availability.md', 'Availability requirements'],
  'REQ-NOTIFICATIONS': ['requirements/notifications.md', 'Notification requirements'],
  'ICR-AB-0001': ['contracts/ICR-AB-0001-booking-api.md', 'Booking API'],
  'ICR-AB-0002': ['contracts/ICR-AB-0002-calendar-sync.md', 'Calendar synchronisation'],
  'ICR-AB-0003': ['contracts/ICR-AB-0003-notifications.md', 'Notification delivery'],
};

// Which SAD component each part of the server is, and the library pattern it is built on.
const COMPONENTS = {
  gateway: { name: 'API gateway', adr: 'ADR-AB-0002', pattern: ['Integration API Management (External)', 'int-api-external'] },
  booking: { name: 'Booking service', adr: 'ADR-AB-0007', pattern: null },
  calendar: { name: 'Calendar connectors', adr: 'ADR-AB-0004', pattern: ['Integration Native Connectors (Cloud)', 'int-native-cloud'] },
  notifications: { name: 'Notification worker', adr: null, pattern: ['Integration Middleware Services (Cloud)', 'int-middleware-cloud'] },
  provider: { name: 'Stand-in provider', pattern: null },
  server: { name: 'Server', pattern: null },
};
const SAD = `${DOCS}sad.md#42-component-catalog`;

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

const link = (href, text, label) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': label ? `${text}, ${label}, opens in a new tab` : `${text}, opens in a new tab` }, text);

/** A record reference such as "ICR-AB-0001#error-handling" as a link to the clause. */
function refLink(ref) {
  const [id, anchor] = ref.split('#');
  const record = RECORDS[id];
  if (!record) return null;
  return link(`${DOCS}${record[0]}${anchor ? `#${anchor}` : ''}`, anchor ? `${id} · ${anchor.replace(/-/g, ' ')}` : id, record[1]);
}

const clockTime = (ms) => new Date(ms).toLocaleTimeString('en-AU', { hour12: false });
const detailText = (detail) => Object.entries(detail).map(([k, v]) => `${k} ${v}`).join(' · ');

export function createPanel(api, { announce }) {
  const state = { since: 0, events: [], inbox: [], data: null, timer: null };
  const statusLine = h('p', { class: 'panel-note', id: 'panel-result', role: 'status' });

  const requestsBody = h('tbody');
  const eventsList = h('ol', { class: 'events', reversed: true });
  const inboxList = h('ul', { class: 'inbox' });
  const controls = h('div', { class: 'panel-controls' });
  const connections = h('p', { class: 'panel-note' });

  async function demo(method, path, body) {
    const res = await fetch(`${api.base}/_demo/${path}`, { method, headers: { 'x-demo-control': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail ?? 'That did not work.');
    return json;
  }

  function renderRequests() {
    const rows = [...api.requests].reverse().slice(0, 12).map((r) => h('tr', {},
      h('td', { text: clockTime(r.at) }),
      h('td', {}, h('code', { text: r.route })),
      h('td', { class: r.status >= 400 || r.status === 0 ? 'bad' : 'ok', text: r.status ? String(r.status) : 'no answer' }),
      h('td', { text: r.ms !== null ? `${r.ms} ms` : '' }),
      h('td', { title: r.traceparent }, h('code', { text: r.traceparent.slice(3, 11) + '…' })),
      h('td', {}, r.idempotencyKey ? h('code', { text: r.idempotencyKey.slice(0, 8) + '…' }) : '', r.replayed ? ' replayed' : '', r.attempt > 1 ? ` (try ${r.attempt})` : '')));
    requestsBody.replaceChildren(...rows);
  }

  function renderEvents() {
    const items = [...state.events].reverse().slice(0, 40).map((e) => {
      const component = COMPONENTS[e.component] ?? { name: e.component, pattern: null };
      const ref = e.ref ? refLink(e.ref) : null;
      return h('li', { class: `event event-${e.level}` },
        h('span', { class: 'event-time', text: clockTime(e.at) }),
        ' ',
        h('strong', { text: component.name }),
        ' ',
        h('span', { text: e.event.replace(/_/g, ' ') }),
        e.level === 'alert' || e.level === 'warn' ? h('span', { class: 'event-flag', text: ` (${e.level})` }) : null,
        Object.keys(e.detail).length ? h('span', { class: 'meta', text: ` ${detailText(e.detail)}` }) : null,
        h('span', { class: 'event-links' },
          ' ', link(SAD, 'SAD', component.name),
          ref ? [' · ', ref] : null,
          component.adr && !String(e.ref ?? '').startsWith(component.adr) ? [' · ', refLink(component.adr)] : null,
          component.pattern ? [' · ', link(`${SITE}/patterns/${component.pattern[1]}`, 'pattern', component.pattern[0])] : null));
    });
    eventsList.replaceChildren(...items);
  }

  function renderInbox() {
    inboxList.replaceChildren(...(state.inbox.length ? state.inbox.slice().reverse().map((m) => h('li', {},
      h('strong', { text: `${m.channel.toUpperCase()} to ${m.to}` }), h('br'), m.subject)) : [h('li', { class: 'meta', text: 'Nothing has been sent yet.' })]));
  }

  function renderControls() {
    const d = state.data;
    if (!d) return;
    const button = (label, onclick, extra = {}) => h('button', { type: 'button', class: 'btn btn-small', onclick, ...extra, text: label });
    const run = (fn, say) => async () => {
      try { const out = await fn(); if (out?.serverTime) api.adoptServerTime(out.serverTime); announce?.(say); statusLine.textContent = say; } catch (e) { statusLine.textContent = e.message; announce?.(e.message); }
      await refresh();
    };
    const hint = d.hint;
    controls.replaceChildren(
      button(d.messagingDown ? 'Switch the messaging provider back on' : 'Switch the messaging provider off', run(() => demo('POST', 'messaging', { down: !d.messagingDown }), d.messagingDown ? 'The messaging provider is back. Queued messages will now be sent.' : 'The messaging provider is off. Bookings still succeed; messages wait in the outbox.'), { 'aria-pressed': String(d.messagingDown) }),
      button(d.calendarDown ? 'Switch the calendar provider back on' : 'Switch the calendar provider off', run(() => demo('POST', 'calendar', { down: !d.calendarDown }), d.calendarDown ? 'The calendar provider is back. The connector re-synchronises.' : 'The calendar provider is off. Bookings still succeed; the live check is skipped.'), { 'aria-pressed': String(d.calendarDown) }),
      button(hint ? `Add an event to Alex’s calendar that the sync won’t hear about (${formatSlot(hint.start, api.business.timeZone)})` : 'No free 10:00 follow-up with Alex to take', run(async () => { const r = await demo('POST', 'calendar/silent-event'); return r; }, 'Added to Alex’s calendar with no notification. The search still shows it free: try to book it.'), { disabled: !hint }),
      button('Move the clock forward 5 minutes', run(() => demo('POST', 'clock', { advanceMs: 5 * 60 * 1000 }), 'Moved the server clock forward five minutes.')),
      button('Move the clock forward 1 hour', run(() => demo('POST', 'clock', { advanceMs: 60 * 60 * 1000 }), 'Moved the server clock forward an hour.')),
      button('Move the clock forward 1 day', run(() => demo('POST', 'clock', { advanceMs: 24 * 60 * 60 * 1000 }), 'Moved the server clock forward a day.')),
      button('Run the scheduler now', run(() => demo('POST', 'tick'), 'Ran the connector, the worker and the housekeeping.')),
      button('Reset the demo', async () => { await demo('POST', 'reset'); announce?.('Reset. Reloading.'); location.reload(); }));
    const outbox = Object.entries(d.outbox).map(([k, n]) => `${n} ${k}`).join(', ') || 'empty';
    const sync = d.connections.map((c) => `${c.staffId}: ${c.busyIntervals} busy intervals${c.needsResync ? ' (needs re-sync)' : ''}`).join(' · ');
    connections.textContent = `Outbox: ${outbox}. Pending calendar writes: ${d.pendingCalendarWrites}. Calendar copy: ${sync}.`;
  }

  let refreshing = false;
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const [events, snapshot] = await Promise.all([demo('GET', `events?since=${state.since}`), demo('GET', 'state')]);
      state.events.push(...events.events);
      if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
      state.since = events.lastSeq;
      state.data = snapshot;
      state.inbox = snapshot.inbox;
      renderRequests(); renderEvents(); renderInbox(); renderControls();
    } catch { /* the server may be restarting; try again next time */ } finally { refreshing = false; }
  }

  const panel = h('aside', { class: 'panel', 'aria-labelledby': 'panel-title' },
    h('h2', { id: 'panel-title', text: 'Behind the scenes' }),
    h('p', { text: 'This widget is talking to a real API running on this computer. Below is what happens as you use it. Each line says which part of the design is acting and links to the record it implements.' }),
    h('p', { class: 'where' },
      h('strong', { text: 'Read the records: ' }),
      link(`${DOCS}sad.md`, 'Solution architecture design'), ' · ',
      link(`${DOCS}requirements/`, 'Requirements'), ' · ',
      link(`${DOCS}decisions/`, 'Decisions (ADRs)'), ' · ',
      link(`${DOCS}contracts/`, 'Contracts (ICRs)'), ' · ',
      link(`${SITE}/patterns/int-api-external`, 'Pattern: API management (external)')),
    h('details', { open: true },
      h('summary', { text: 'Requests the widget made' }),
      h('p', { class: 'meta' }, 'Implements ', refLink('ICR-AB-0001#interface-specification') ?? '', ' with the widget key, an idempotency key on each POST and a traceparent on every request.'),
      h('table', {}, h('caption', { class: 'visually-hidden', text: 'Requests the widget made, newest first' }),
        h('thead', {}, h('tr', {}, ['Time', 'Request', 'Status', 'Took', 'Trace', 'Idempotency key'].map((t) => h('th', { scope: 'col', text: t })))), requestsBody)),
    h('details', { open: true },
      h('summary', { text: 'What the server did' }),
      h('p', { class: 'meta', text: 'Newest first. “pattern” is the integration pattern from the library that this part is built on.' }), eventsList),
    h('details', { open: true },
      h('summary', { text: 'Messages the stand-in provider “sent”' }),
      h('p', { class: 'meta', text: 'Nothing leaves this computer. These are the messages the notification worker handed to the stand-in provider (ICR-AB-0003).' }), inboxList),
    h('details', { open: true },
      h('summary', { text: 'Stage something' }),
      statusLine, controls, connections));

  api.onActivity(() => { renderRequests(); window.setTimeout(refresh, 150); });
  state.timer = window.setInterval(() => { if (!document.hidden) refresh(); }, 2000);
  refresh();
  renderRequests();
  renderInbox();
  return panel;
}

export { formatDay };
