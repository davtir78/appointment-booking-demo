// The booking widget: the page a business embeds in an iframe (ADR-AB-0001). It talks only to the
// in-memory Backend in domain.js, which stands in for the Booking API of ICR-AB-0001, so it
// never contacts a server and keeps nothing once the page closes.
//
// Built for keyboard and screen-reader use: real fieldsets and radio buttons, focus moved to each
// step's heading, outcomes announced in a status region, and a hold the visitor can extend.

import { Backend, ApiError, HOLD_MS, groupByDay } from './domain.js';
import { DISPLAY_ZONES, FICTIONAL_CUSTOMER } from './data.js';
import { formatClock, formatDay, formatSlot } from './time.js';

const backend = new Backend();
const BUSINESS = backend.business;

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
  date: null,
  slot: null, // `${staffId}|${start}`
  hold: null,
  booking: null,
  moving: false, // rescheduling an existing booking
  alert: null, // { text, tone } shown at the top of a step
  timer: null,
};

const viewZone = () => (state.zone === 'browser' ? Intl.DateTimeFormat().resolvedOptions().timeZone : state.zone);
const staffName = (id) => backend.staffById(id).name;
const serviceName = (id) => backend.serviceById(id).name;

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
    onsubmit: (e) => {
      e.preventDefault();
      if (!state.serviceId) {
        state.alert = { text: 'Choose a service to continue.' };
        render();
        main.querySelector('[data-step-heading]')?.focus();
        return;
      }
      state.alert = null;
      state.staffId = 'any';
      state.date = null;
      state.slot = null;
      go('times', { say: `${serviceName(state.serviceId)}. Choose who you’d like to see and a time.` });
    },
  },
  fieldset('Which service would you like?', backend.services.map((s) =>
    radio('service', s.id, h('span', {}, h('strong', { text: s.name }), h('span', { class: 'meta', text: ` ${s.minutes} minutes` })), state.serviceId === s.id,
      () => { state.serviceId = s.id; state.alert = null; }, { required: true }))),
  h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn btn-primary', text: 'Continue' })));
  return [heading('Choose a service'), alertBox(), form];
}

// ── step 2: staff and time ──────────────────────────────────────────────────────────────────────────

function currentSlots() {
  return backend.availability({
    serviceId: state.serviceId,
    staffId: state.staffId === 'any' ? null : state.staffId,
    days: 14,
  });
}

function renderTimes() {
  const service = backend.serviceById(state.serviceId);
  const slots = currentSlots();
  const byDay = groupByDay(slots, viewZone());
  const dates = [...byDay.keys()];
  if (!state.date || !byDay.has(state.date)) state.date = dates[0] ?? null;
  const daySlots = state.date ? byDay.get(state.date) : [];

  const staffChoices = [
    radio('staff', 'any', 'Anyone available', state.staffId === 'any', () => { state.staffId = 'any'; state.date = null; state.slot = null; state.alert = null; rerenderTimes(); }),
    ...backend.staff.filter((m) => m.services.includes(state.serviceId)).map((m) =>
      radio('staff', m.id, `${m.name}, ${m.role}`, state.staffId === m.id, () => { state.staffId = m.id; state.date = null; state.slot = null; state.alert = null; rerenderTimes(); })),
  ];

  const zoneSelect = h('div', { class: 'field' },
    h('label', { for: 'zone', text: 'Show times in' }),
    h('select', { id: 'zone', onchange: (e) => { state.zone = e.target.value; state.date = null; state.slot = null; state.alert = null; rerenderTimes(); announce(`Times now shown in ${e.target.selectedOptions[0].textContent}.`); } },
      DISPLAY_ZONES.map((z) => h('option', { value: z.id, selected: state.zone === z.id || false, text: z.id === 'browser' ? `${z.label} (${Intl.DateTimeFormat().resolvedOptions().timeZone})` : z.label }))));

  const dayChoices = dates.map((d) => radio('day', d, h('span', {}, h('strong', { text: formatDay(d) }), h('span', { class: 'meta', text: ` ${byDay.get(d).length} ${byDay.get(d).length === 1 ? 'time' : 'times'}` })),
    state.date === d, () => { state.date = d; state.slot = null; rerenderSlots(); announce(`${formatDay(d)}: ${byDay.get(d).length} times available.`); }));

  const form = h('form', { onsubmit: onHold },
    h('p', { class: 'summary' }, `${service.name}, ${service.minutes} minutes.`),
    fieldset('Who would you like to see?', staffChoices),
    zoneSelect,
    dates.length
      ? [fieldset('Choose a day', dayChoices, 'Days with no free times are left out.'), h('div', { id: 'slots' }, slotsFieldset(daySlots))]
      : h('p', { class: 'empty', text: 'There are no free times for this choice in the next two weeks. Try someone else.' }),
    h('div', { class: 'actions' },
      dates.length ? h('button', { type: 'submit', class: 'btn btn-primary', text: state.moving ? 'Hold this new time' : 'Hold this time and continue' }) : null,
      backButton(state.moving ? 'Keep my current time' : 'Change service', () => { state.alert = null; go(state.moving ? 'done' : 'service', { say: null }); })),
    demoControls());

  return [heading(state.moving ? 'Choose a new time' : 'Choose a time'), alertBox(), form];
}

function slotsFieldset(daySlots) {
  return fieldset(`Choose a time on ${formatDay(state.date)}`, daySlots.map((s) => {
    const key = `${s.staffId}|${s.start}`;
    return radio('slot', key, h('span', {}, h('strong', { text: timeText(s) }), h('span', { class: 'meta', text: ` with ${staffName(s.staffId)}` })), state.slot === key, () => { state.slot = key; state.alert = null; });
  }));
}

function rerenderSlots() {
  const slotsEl = document.getElementById('slots');
  const byDay = groupByDay(currentSlots(), viewZone());
  slotsEl.replaceChildren(slotsFieldset(byDay.get(state.date) ?? []));
}

function rerenderTimes() {
  const active = document.activeElement?.name ? { name: document.activeElement.name, value: document.activeElement.value, id: document.activeElement.id } : null;
  render();
  const again = active && (active.id ? document.getElementById(active.id) : main.querySelector(`input[name="${active.name}"][value="${CSS.escape(active.value)}"]`));
  again?.focus();
}

function demoControls() {
  const hint = backend.hints();
  return h('details', { class: 'demo-controls' },
    h('summary', { text: 'Demo controls' }),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: backend.raceNext || false, onchange: (e) => { backend.raceNext = e.target.checked; } }),
      h('span', { text: 'Another customer takes the time I’m about to hold' })),
    h('p', { class: 'hint', text: 'Tick this, then hold a time: you’ll see the overlap rule reject the second request and offer other times (ADR-AB-0003).' }),
    hint ? h('p', { class: 'hint', text: `Or try Alex on ${formatDay(hint.date)} at 10:00 am (a 30-minute follow-up). The synchronised calendar shows it free, but Alex’s live calendar has a new event, so the check at confirmation catches it (ADR-AB-0002).` }) : null);
}

function onHold(e) {
  e.preventDefault();
  if (!state.slot) {
    state.alert = { text: 'Choose a time to continue.' };
    render();
    main.querySelector('[data-step-heading]')?.focus();
    return;
  }
  const [staffId, start] = state.slot.split('|');
  if (state.hold) { backend.releaseHold(state.hold.id); state.hold = null; }
  try {
    state.hold = backend.createHold({ serviceId: state.serviceId, staffId, start: Number(start), idempotencyKey: `${staffId}-${start}-${Date.now()}` });
    state.alert = null;
    go('details', { say: `Holding ${when(state.hold.start)} with ${staffName(staffId)} for five minutes.` });
  } catch (err) {
    takenFallback(err, 'That time has just been taken.');
  }
}

/** A slot lost to someone else: say so, and move to the next free time rather than an error page. */
function takenFallback(err, message) {
  if (!(err instanceof ApiError)) throw err;
  state.hold = null;
  state.slot = null;
  const next = err.alternatives?.[0];
  if (next) { state.date = groupByDay([next], viewZone()).keys().next().value; }
  const nextText = err.alternatives?.length ? ` The next free times start ${err.alternatives.map((a) => `${when(a.start)} with ${staffName(a.staffId)}`).join('; ')}.` : '';
  state.alert = { text: `${message}${nextText}` };
  go('times', { say: `${message} Other times are shown.` });
}

// ── step 3: details (or confirm a move) ─────────────────────────────────────────────────────────────

function remainingMs() { return Math.max(0, state.hold.expiresAt - Date.now()); }
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

function toTimes() {
  if (state.hold) { backend.releaseHold(state.hold.id); state.hold = null; }
  state.alert = null;
  state.slot = null;
  go('times');
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
      go('times', { say: 'Your hold on that time ended.' });
    }
  }, 1000);
}

function extend() {
  try {
    state.hold = backend.extendHold(state.hold.id);
    document.getElementById('countdown').textContent = clockText(remainingMs());
    announce('Holding this time for another five minutes.');
    startTimer(document.getElementById('countdown'));
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    state.hold = null;
    state.alert = { text: err.message };
    go('times', { say: err.message });
  }
}

function confirm(e) {
  e.preventDefault();
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
  try {
    state.booking = backend.confirmHold(state.hold.id, { name, email, phone: form.elements.phone.value.trim() }, { idempotencyKey: `confirm-${state.hold.id}` });
    state.hold = null;
    state.alert = null;
    state.moving = false;
    go('done', { say: `Booked. ${when(state.booking.start)} with ${staffName(state.booking.staffId)}.` });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'hold_expired') {
      state.hold = null;
      state.alert = { text: err.message };
      return go('times', { say: err.message });
    }
    takenFallback(err, 'That time is no longer free: the clinic’s calendar changed while you were choosing.');
  }
}

function confirmMove() {
  try {
    state.booking = backend.reschedule(state.booking.id, state.booking.token, state.hold.id);
    state.hold = null;
    state.moving = false;
    state.alert = { tone: 'ok', text: 'Your booking has moved.' };
    go('done', { say: `Your booking has moved to ${when(state.booking.start)}.` });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'hold_expired') {
      state.hold = null;
      state.alert = { text: err.message };
      return go('times', { say: err.message });
    }
    takenFallback(err, 'That time is no longer free.');
  }
}

// ── step 4: booked ──────────────────────────────────────────────────────────────────────────────────

const OUTBOX_TEXT = {
  confirmation: () => 'A confirmation email, queued now.',
  reminder: (m) => `A reminder, queued for ${formatSlot(m.sendAt, viewZone())}.`,
  rescheduled: () => 'A “your booking has moved” email, queued now.',
  cancelled: () => 'A cancellation email, queued now.',
};

function outboxList() {
  const items = backend.outbox.filter((m) => backend.rows.some((r) => r.id === m.bookingId) || m.type === 'cancelled');
  return h('details', { class: 'outbox' },
    h('summary', { text: 'What happens next' }),
    h('p', { text: 'A real system would now send these messages from a queue, so a provider outage can’t stop a booking (ADR-AB-0005). This demo only lists them: nothing is sent.' }),
    h('ul', {}, items.map((m) => h('li', { text: OUTBOX_TEXT[m.type]?.(m) ?? m.type }))));
}

function renderDone() {
  const b = state.booking;
  return [heading('You’re booked'), alertBox(),
    h('div', { class: 'card card-ok' },
      h('p', {}, h('strong', { text: serviceName(b.serviceId) })),
      h('p', { text: `${when(b.start)} with ${staffName(b.staffId)}` }),
      h('p', { class: 'meta', text: `At the clinic: ${formatSlot(b.start, BUSINESS.timeZone)}` }),
      h('p', { class: 'meta', text: `Booking reference ${b.id} (invented for the demo).` })),
    outboxList(),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn btn-primary', text: 'Change time', onclick: () => { state.moving = true; state.serviceId = b.serviceId; state.staffId = 'any'; state.date = null; state.slot = null; state.alert = null; go('times', { say: 'Choose a new time.' }); } }),
      h('button', { type: 'button', class: 'btn', text: 'Cancel booking', onclick: () => { state.alert = null; go('cancel'); } }),
      h('button', { type: 'button', class: 'btn btn-quiet', text: 'Book another appointment', onclick: newBooking }))];
}

function newBooking() {
  Object.assign(state, { serviceId: null, staffId: 'any', date: null, slot: null, hold: null, booking: null, moving: false, alert: null });
  go('service', { say: 'Starting a new booking.' });
}

function renderCancel() {
  const b = state.booking;
  return [heading('Cancel this booking?'),
    h('p', { text: `${serviceName(b.serviceId)}, ${when(b.start)} with ${staffName(b.staffId)}.` }),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn btn-danger', text: 'Yes, cancel the booking', onclick: () => { backend.cancel(b.id, b.token); state.alert = null; go('cancelled', { say: 'Your booking is cancelled.' }); } }),
      h('button', { type: 'button', class: 'btn btn-quiet', text: 'No, keep it', onclick: () => go('done') }))];
}

function renderCancelled() {
  return [heading('Your booking is cancelled'),
    h('p', { text: 'The time is free again for other customers.' }),
    outboxList(),
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

applyBrand();
render();
reportHeight();
