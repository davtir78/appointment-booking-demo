// The booking widget: the page a business embeds in an iframe (ADR-AB-0001). It talks to a backend
// through widget/api.js: the in-browser Backend of domain.js on the public demo (no request leaves
// the page, nothing is kept), or the real Booking API of ICR-AB-0001 when opened with a widget key.
//
// Built for keyboard and screen-reader use: real fieldsets and radio buttons, focus moved to each
// step's heading, outcomes announced in a status region, and a hold the visitor can extend.

import { ApiError, groupByDay } from './domain.js';
import { DISPLAY_ZONES, FICTIONAL_CUSTOMER } from './data.js';
import { formatClock, formatDay, formatSlot } from './time.js';
import { createApi } from './api.js';
import { createPanel } from './panel.js';

let api = null;
let startupError = null;
try { api = await createApi(); } catch (e) { startupError = e; }
const BUSINESS = api?.business;

// ── tiny DOM helper ─────────────────────────────────────────────────────────────────────────────────

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

// ── state ───────────────────────────────────────────────────────────────────────────────────────────

const state = {
  step: 'service',
  serviceId: null,
  staffId: 'any',
  zone: 'browser',
  slot: null, // `${staffId}|${start}`
  slots: [], // the free times for the current choice, loaded before the times step is drawn
  busy: false, // a request is in flight; ignore a second click
  messages: [], // what a cancellation queued
  hold: null,
  booking: null,
  moving: false, // rescheduling an existing booking
  alert: null, // { text, tone } shown at the top of a step
  timer: null,
};

const viewZone = () => (state.zone === 'browser' ? Intl.DateTimeFormat().resolvedOptions().timeZone : state.zone);
const staffName = (id) => api.staffById(id).name;
const serviceName = (id) => api.serviceById(id).name;

const main = document.getElementById('main');
const statusEl = document.getElementById('status');

function announce(text) {
  statusEl.textContent = '';
  // A change of text is what a screen reader announces; clearing first makes repeats announce too.
  window.setTimeout(() => { statusEl.textContent = text; }, 30);
}

function stopTimer() {
  if (state.timer) window.clearInterval(state.timer);
  state.timer = null;
}

function go(step, { focus = true, say = null } = {}) {
  stopTimer();
  state.step = step;
  render();
  if (state.showDate) { showDay(state.showDate); state.showDate = null; }
  if (focus) main.querySelector('[data-step-heading]')?.focus();
  if (say) announce(say);
}

// ── shared pieces ───────────────────────────────────────────────────────────────────────────────────

const heading = (text) => h('h2', { tabindex: '-1', 'data-step-heading': true, text });

function alertBox() {
  if (!state.alert) return null;
  const { text, tone = 'warn' } = state.alert;
  return h('div', { class: `alert alert-${tone}`, role: tone === 'warn' ? 'alert' : 'status' }, h('p', { text }));
}

function backButton(label, onClick) {
  return h('button', { type: 'button', class: 'btn btn-quiet', onclick: onClick }, h('span', { 'aria-hidden': 'true', text: '← ' }), label);
}

function radio(name, value, label, checked, onChange, extra = {}) {
  const input = h('input', { type: 'radio', name, value, checked: checked || false, onchange: onChange, ...extra });
  return h('label', { class: 'choice' }, input, h('span', { class: 'choice-text' }, label));
}

function fieldset(legend, children, hint) {
  return h('fieldset', {}, h('legend', { text: legend }), hint ? h('p', { class: 'hint', text: hint }) : null, h('div', { class: 'choices' }, children));
}

const timeText = (slot) => `${formatClock(slot.start, viewZone())}`;
const when = (start) => formatSlot(start, viewZone());

// ── step 1: service ─────────────────────────────────────────────────────────────────────────────────

function renderService() {
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (!state.serviceId) {
        state.alert = { text: 'Choose a service to continue.' };
        render();
        main.querySelector('[data-step-heading]')?.focus();
        return;
      }
      state.alert = null;
      state.staffId = 'any';
      state.slot = null;
      await showTimes({ say: `${serviceName(state.serviceId)}. Choose who you’d like to see and a time.` });
    },
  },
  fieldset('Which service would you like?', api.services.map((s) =>
    radio('service', s.id, h('span', {}, h('strong', { text: s.name }), h('span', { class: 'meta', text: ` ${s.minutes} minutes` })), state.serviceId === s.id,
      () => { state.serviceId = s.id; state.alert = null; }, { required: true }))),
  h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn btn-primary', text: 'Continue' })));
  return [heading('Choose a service'), alertBox(), form];
}

// ── step 2: staff and time ──────────────────────────────────────────────────────────────────────────

/** Fetch the free times for the current choice. A failure is shown as an alert, with no times. */
async function loadSlots() {
  try {
    state.slots = await api.availability({ serviceId: state.serviceId, staffId: state.staffId === 'any' ? null : state.staffId, days: 14 });
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    state.slots = [];
    state.alert = { text: err.message };
  }
}

/** Load the times, then draw the step. */
async function showTimes(options) {
  await loadSlots();
  go('times', options);
}

function renderTimes() {
  const service = api.serviceById(state.serviceId);
  const byDay = groupByDay(state.slots, viewZone());
  const dates = [...byDay.keys()];

  const staffChoices = [
    radio('staff', 'any', 'Anyone available', state.staffId === 'any', () => { state.staffId = 'any'; state.slot = null; state.alert = null; rerenderTimes(); }),
    ...api.staff.filter((m) => m.services.includes(state.serviceId)).map((m) =>
      radio('staff', m.id, `${m.name}, ${m.role}`, state.staffId === m.id, () => { state.staffId = m.id; state.slot = null; state.alert = null; rerenderTimes(); })),
  ];

  const zoneSelect = h('div', { class: 'field' },
    h('label', { for: 'zone', text: 'Show times in' }),
    h('select', { id: 'zone', onchange: (e) => { state.zone = e.target.value; state.slot = null; state.alert = null; rerenderTimes(); announce(`Times now shown in ${e.target.selectedOptions[0].textContent}.`); } },
      DISPLAY_ZONES.map((z) => h('option', { value: z.id, selected: state.zone === z.id || false, text: z.id === 'browser' ? `${z.label} (${Intl.DateTimeFormat().resolvedOptions().timeZone})` : z.label }))));

  const form = h('form', { onsubmit: onHold },
    h('p', { class: 'summary' }, `${service.name}, ${service.minutes} minutes.`),
    fieldset('Who would you like to see?', staffChoices),
    zoneSelect,
    dates.length
      ? schedule(byDay)
      : h('p', { class: 'empty', text: 'There are no free times for this choice in the next two weeks. Try someone else.' }),
    h('div', { class: 'actions' },
      dates.length ? h('button', { type: 'submit', class: 'btn btn-primary', text: state.moving ? 'Hold this new time' : 'Hold this time and continue' }) : null,
      backButton(state.moving ? 'Keep my current time' : 'Change service', () => { state.alert = null; go(state.moving ? 'done' : 'service', { say: null }); })),
    demoControls());

  return [heading(state.moving ? 'Choose a new time' : 'Choose a time'), alertBox(), form];
}

/**
 * Every free day as a column of times, in one scrolling pane. All the times are one radio group, so
 * the keyboard has a single Tab stop: Up and Down move through a day, Left and Right to the same
 * row of the next or previous day. Each column is named for its day, and days with no free times
 * are left out.
 */
function schedule(byDay) {
  const columns = [...byDay.entries()].map(([date, daySlots]) => {
    const headId = `day-${date}`;
    return h('div', { class: 'day', role: 'group', 'aria-labelledby': headId, 'data-date': date },
      h('div', { class: 'day-head', id: headId },
        h('strong', { text: formatDay(date) }),
        ' ', // a real space, so the group's name reads "Friday 2 October 12 times"
        h('span', { class: 'meta', text: `${daySlots.length} ${daySlots.length === 1 ? 'time' : 'times'}` })),
      daySlots.map((slot) => {
        const key = `${slot.staffId}|${slot.start}`;
        return radio('slot', key,
          h('span', { class: 'slot-text' }, h('strong', { text: timeText(slot) }), h('span', { class: 'meta', text: `with ${staffName(slot.staffId)}` })),
          state.slot === key, () => { state.slot = key; state.alert = null; });
      }));
  });
  const pane = h('div', { class: 'schedule', onkeydown: scheduleKeys }, columns);
  return h('fieldset', {},
    h('legend', { text: 'Choose a day and time' }),
    h('p', { class: 'hint', text: 'Each column is a day. Scroll sideways for more days, or use the left and right arrow keys.' }),
    pane);
}

/** Left and Right move to the same row in the neighbouring day (Up and Down are native). */
function scheduleKeys(e) {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const input = e.target;
  if (!(input instanceof HTMLInputElement) || input.name !== 'slot') return;
  e.preventDefault();
  const column = input.closest('.day');
  const next = e.key === 'ArrowRight' ? column.nextElementSibling : column.previousElementSibling;
  if (!next) return;
  const row = [...column.querySelectorAll('input')].indexOf(input);
  const options = next.querySelectorAll('input');
  const target = options[Math.min(row, options.length - 1)];
  target.checked = true;
  target.dispatchEvent(new Event('change', { bubbles: true }));
  target.focus();
}

/** After a lost time, bring the next free day into view (a column's left edge to the pane's). */
function showDay(date) {
  const pane = main.querySelector('.schedule');
  const column = pane?.querySelector(`.day[data-date="${date}"]`);
  if (pane && column) pane.scrollLeft = column.offsetLeft - pane.offsetLeft;
}

async function rerenderTimes() {
  const active = document.activeElement?.name ? { name: document.activeElement.name, value: document.activeElement.value, id: document.activeElement.id } : null;
  await loadSlots();
  render();
  const again = active && (active.id ? document.getElementById(active.id) : main.querySelector(`input[name="${active.name}"][value="${CSS.escape(active.value)}"]`));
  again?.focus();
}

/** In the public demo these live here; with the API running they are in the “behind the scenes” panel. */
function demoControls() {
  if (!api.demo) return h('p', { class: 'hint demo-pointer', text: 'The “Behind the scenes” panel below has the demo controls: switch a provider off, add a calendar event the sync won’t hear about, or move the clock.' });
  const hint = api.demo.hint();
  return h('details', { class: 'demo-controls' },
    h('summary', { text: 'Demo controls' }),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: api.demo.race() || false, onchange: (e) => { api.demo.setRace(e.target.checked); } }),
      h('span', { text: 'Another customer takes the time I’m about to hold' })),
    h('p', { class: 'hint', text: 'Tick this, then hold a time: you’ll see the overlap rule reject the second request and offer other times (the booking requirements).' }),
    hint ? h('p', { class: 'hint', text: `Or try Alex on ${formatDay(hint.date)} at 10:00 am (a 30-minute follow-up). The synchronised calendar shows it free, but Alex’s live calendar has a new event, so the check at confirmation catches it (ADR-AB-0003).` }) : null);
}

async function onHold(e) {
  e.preventDefault();
  if (state.busy) return;
  if (!state.slot) {
    state.alert = { text: 'Choose a time to continue.' };
    render();
    main.querySelector('[data-step-heading]')?.focus();
    return;
  }
  const [staffId, start] = state.slot.split('|');
  state.busy = true;
  try {
    if (state.hold) { api.releaseHold(state.hold.id).catch(() => {}); state.hold = null; }
    state.hold = await api.createHold({ serviceId: state.serviceId, staffId, start: Number(start) });
    state.alert = null;
    go('details', { say: `Holding ${when(state.hold.start)} with ${staffName(staffId)} for five minutes.` });
  } catch (err) {
    await takenFallback(err, 'That time has just been taken.');
  } finally {
    state.busy = false;
  }
}

/** A slot lost to someone else: say so, and move to the next free time rather than an error page. */
async function takenFallback(err, message) {
  if (!(err instanceof ApiError)) throw err;
  state.hold = null;
  state.slot = null;
  let text = err.message;
  if (err.status === 409) {
    const next = err.alternatives?.[0];
    if (next) state.showDate = groupByDay([next], viewZone()).keys().next().value;
    const nextText = err.alternatives?.length ? ` The next free times start ${err.alternatives.map((a) => `${when(a.start)} with ${staffName(a.staffId)}`).join('; ')}.` : '';
    text = `${message}${nextText}`;
  }
  state.alert = { text };
  await loadSlots(); // the list is out of date: it still shows the time that was just lost
  go('times', { say: err.status === 409 ? `${message} Other times are shown.` : err.message });
}

// ── step 3: details (or confirm a move) ─────────────────────────────────────────────────────────────

function remainingMs() { return Math.max(0, state.hold.expiresAt - api.now()); }
const clockText = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

function renderDetails() {
  const hold = state.hold;
  const timerEl = h('span', { id: 'countdown', role: 'timer', 'aria-live': 'off', text: clockText(remainingMs()) });
  startTimer(timerEl);

  const summary = h('div', { class: 'card' },
    h('p', {}, h('strong', { text: serviceName(hold.serviceId) })),
    h('p', { text: `${when(hold.start)} with ${staffName(hold.staffId)}` }),
    state.zone !== BUSINESS.timeZone && viewZone() !== BUSINESS.timeZone
      ? h('p', { class: 'meta', text: `At the clinic that is ${formatSlot(hold.start, BUSINESS.timeZone)}.` }) : null);

  const holdBox = h('div', { class: 'hold' },
    h('p', {}, 'We’re holding this time for you: ', timerEl, ' left.'),
    h('button', { type: 'button', class: 'btn btn-quiet', onclick: extend, text: 'Keep holding for 5 more minutes' }));

  if (state.moving) {
    return [heading('Confirm your new time'), alertBox(), summary, holdBox,
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: confirmMove, text: 'Confirm new time' }),
        backButton('Choose a different time', toTimes))];
  }

  const field = (id, label, type, value, extra = {}) => h('div', { class: 'field' },
    h('label', { for: id, text: label }),
    h('input', { id, name: id, type, value, ...extra }));

  const form = h('form', { novalidate: true, onsubmit: confirm },
    h('p', { class: 'hint', text: 'These are invented details so you can try the form. Change them if you like: nothing you enter is sent or kept.' }),
    field('name', 'Your name (required)', 'text', FICTIONAL_CUSTOMER.name, { required: true, autocomplete: 'name' }),
    field('email', 'Email (required)', 'email', FICTIONAL_CUSTOMER.email, { required: true, autocomplete: 'email', spellcheck: 'false' }),
    field('phone', 'Phone (optional)', 'tel', FICTIONAL_CUSTOMER.phone, { autocomplete: 'tel' }),
    h('div', { class: 'actions' },
      h('button', { type: 'submit', class: 'btn btn-primary', text: 'Confirm booking' }),
      backButton('Choose a different time', toTimes)));
  return [heading('Your details'), alertBox(), summary, holdBox, form];
}

async function toTimes() {
  if (state.hold) { api.releaseHold(state.hold.id).catch(() => {}); state.hold = null; }
  state.alert = null;
  state.slot = null;
  await showTimes();
}

function startTimer(timerEl) {
  let warned = false;
  stopTimer();
  state.timer = window.setInterval(() => {
    if (!state.hold) return stopTimer();
    const left = remainingMs();
    timerEl.textContent = clockText(left);
    if (left <= 60000 && !warned) { warned = true; announce('One minute left on your held time. Choose “Keep holding” to extend it.'); }
    if (left <= 0) {
      state.hold = null;
      state.slot = null;
      state.alert = { text: 'Your hold on that time ended. Choose a time again.' };
      showTimes({ say: 'Your hold on that time ended.' });
    }
  }, 1000);
}

async function extend() {
  if (state.busy) return;
  state.busy = true;
  try {
    state.hold = await api.extendHold(state.hold.id);
    document.getElementById('countdown').textContent = clockText(remainingMs());
    announce('Holding this time for another five minutes.');
    startTimer(document.getElementById('countdown'));
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    state.hold = null;
    state.alert = { text: err.message };
    await showTimes({ say: err.message });
  } finally {
    state.busy = false;
  }
}

async function confirm(e) {
  e.preventDefault();
  if (state.busy) return;
  const form = e.currentTarget;
  const name = form.elements.name.value.trim();
  const email = form.elements.email.value.trim();
  const problems = [];
  if (!name) problems.push(['name', 'Enter your name.']);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) problems.push(['email', 'Enter an email address like name@example.com.']);
  form.querySelectorAll('.error').forEach((n) => n.remove());
  form.querySelectorAll('[aria-invalid]').forEach((n) => { n.removeAttribute('aria-invalid'); n.removeAttribute('aria-describedby'); });
  if (problems.length) {
    for (const [id, text] of problems) {
      const input = form.elements[id];
      const msg = h('p', { class: 'error', id: `${id}-error`, text });
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', `${id}-error`);
      input.parentElement.append(msg);
    }
    form.elements[problems[0][0]].focus();
    announce(`${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} to fix: ${problems.map((p) => p[1]).join(' ')}`);
    return;
  }
  state.busy = true;
  try {
    state.booking = await api.confirmHold(state.hold.id, { name, email, phone: form.elements.phone.value.trim() });
    state.hold = null;
    state.alert = null;
    state.moving = false;
    go('done', { say: `Booked. ${when(state.booking.start)} with ${staffName(state.booking.staffId)}.` });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'hold_expired') {
      state.hold = null;
      state.alert = { text: err.message };
      await showTimes({ say: err.message });
    } else {
      await takenFallback(err, 'That time is no longer free: the clinic’s calendar changed while you were choosing.');
    }
  } finally {
    state.busy = false;
  }
}

async function confirmMove() {
  if (state.busy) return;
  state.busy = true;
  try {
    state.booking = await api.reschedule(state.booking.id, state.booking.token, state.hold.id);
    state.hold = null;
    state.moving = false;
    state.alert = { tone: 'ok', text: 'Your booking has moved.' };
    go('done', { say: `Your booking has moved to ${when(state.booking.start)}.` });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'hold_expired') {
      state.hold = null;
      state.alert = { text: err.message };
      await showTimes({ say: err.message });
    } else {
      await takenFallback(err, 'That time is no longer free.');
    }
  } finally {
    state.busy = false;
  }
}

// ── step 4: booked ──────────────────────────────────────────────────────────────────────────────────

const OUTBOX_TEXT = {
  BookingConfirmed: () => 'A confirmation',
  ReminderDue: (m) => `A reminder${m.sendAt ? `, due ${formatSlot(m.sendAt, viewZone())}` : ''}`,
  BookingRescheduled: () => 'A “your booking has moved” message',
  BookingCancelled: () => 'A cancellation',
};

function outboxList(messages) {
  const real = api.mode === 'http';
  return h('details', { class: 'outbox' },
    h('summary', { text: 'What happens next' }),
    h('p', { text: real
      ? 'These were written to the outbox in the same transaction as the booking. The notification worker sends them through a stand-in provider, so a provider outage can’t stop a booking (ADR-AB-0006). Nothing leaves this computer: the panel below shows them being sent.'
      : 'A real system would now send these messages from a queue, so a provider outage can’t stop a booking (ADR-AB-0006). This demo only lists them: nothing is sent.' }),
    h('ul', {}, messages.map((m) => h('li', { text: `${(OUTBOX_TEXT[m.type]?.(m) ?? m.type)}${m.channel ? ` by ${m.channel}` : ''}, ${m.status === 'sent' ? 'sent' : 'queued'}.` }))));
}

function renderDone() {
  const b = state.booking;
  return [heading('You’re booked'), alertBox(),
    h('div', { class: 'card card-ok' },
      h('p', {}, h('strong', { text: serviceName(b.serviceId) })),
      h('p', { text: `${when(b.start)} with ${staffName(b.staffId)}` }),
      h('p', { class: 'meta', text: `At the clinic: ${formatSlot(b.start, BUSINESS.timeZone)}` }),
      h('p', { class: 'meta', text: `Booking reference ${b.id} (invented for the demo).` })),
    outboxList(b.messages ?? []),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn btn-primary', text: 'Change time', onclick: () => { state.moving = true; state.serviceId = b.serviceId; state.staffId = 'any'; state.slot = null; state.alert = null; showTimes({ say: 'Choose a new time.' }); } }),
      h('button', { type: 'button', class: 'btn', text: 'Cancel booking', onclick: () => { state.alert = null; go('cancel'); } }),
      h('button', { type: 'button', class: 'btn btn-quiet', text: 'Book another appointment', onclick: newBooking }))];
}

function newBooking() {
  Object.assign(state, { serviceId: null, staffId: 'any', slot: null, hold: null, booking: null, moving: false, alert: null });
  go('service', { say: 'Starting a new booking.' });
}

function renderCancel() {
  const b = state.booking;
  return [heading('Cancel this booking?'),
    h('p', { text: `${serviceName(b.serviceId)}, ${when(b.start)} with ${staffName(b.staffId)}.` }),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn btn-danger', text: 'Yes, cancel the booking', onclick: async () => {
        if (state.busy) return;
        state.busy = true;
        try { state.messages = await api.cancel(b.id, b.token); state.alert = null; go('cancelled', { say: 'Your booking is cancelled.' }); }
        catch (err) { if (!(err instanceof ApiError)) throw err; state.alert = { text: err.message }; go('done', { say: err.message }); }
        finally { state.busy = false; }
      } }),
      h('button', { type: 'button', class: 'btn btn-quiet', text: 'No, keep it', onclick: () => go('done') }))];
}

function renderCancelled() {
  return [heading('Your booking is cancelled'),
    h('p', { text: 'The time is free again for other customers.' }),
    outboxList(state.messages),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', text: 'Book another appointment', onclick: newBooking }))];
}

// ── shell ───────────────────────────────────────────────────────────────────────────────────────────

const STEPS = { service: renderService, times: renderTimes, details: renderDetails, done: renderDone, cancel: renderCancel, cancelled: renderCancelled };

function render() {
  main.replaceChildren(...[STEPS[state.step]()].flat().filter(Boolean));
}

// Brand colour from the embedding page (?brand=#rrggbb), used only if white text stays readable on it.
function applyBrand() {
  const raw = new URLSearchParams(location.search).get('brand') ?? '';
  const m = /^#?([0-9a-f]{6})$/i.exec(raw);
  if (!m) return;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (1.05 / (luminance + 0.05) >= 4.5) document.documentElement.style.setProperty('--brand', `#${m[1]}`);
}

// Tell the embedding page how tall the content is, so the iframe fits it. Nothing the visitor
// entered is in the message; the parent can't read inside this frame (ADR-AB-0001).
function reportHeight() {
  if (window.parent === window) return;
  // The body's own height, not the page's: the page is never shorter than the frame, so measuring
  // it would stop the frame from ever shrinking.
  const send = () => window.parent.postMessage({ source: 'appointment-booking-widget', type: 'resize', height: Math.ceil(document.body.getBoundingClientRect().height) }, '*');
  new ResizeObserver(send).observe(document.body);
  send();
}

/** The service could not be reached at all: say so, and offer another go. */
function renderFailure(err) {
  main.replaceChildren(
    h('h2', { tabindex: '-1', 'data-step-heading': true, text: 'Booking isn’t available just now' }),
    h('div', { class: 'alert alert-warn', role: 'alert' }, h('p', { text: err?.message ?? 'The booking service can’t be reached.' })),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', text: 'Try again', onclick: () => location.reload() })));
  main.querySelector('[data-step-heading]')?.focus();
}

applyBrand();
reportHeight();
if (!api) {
  renderFailure(startupError);
} else {
  render();
  if (api.mode === 'http') document.body.append(createPanel(api, { announce }));
}
