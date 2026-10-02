// Time zones for the booking logic (the availability requirements): every booking is a UTC instant, and working hours
// are rules in the business's zone. Everything here goes through the platform's time zone database
// (Intl), never a hand-written offset table, so daylight saving is handled by the database: a
// skipped hour has no local time, and a repeated hour is read as its first occurrence.

const MS_MIN = 60000;
const MS_DAY = 86400000;

const partsFormatter = new Map();
function formatterFor(timeZone) {
  if (!partsFormatter.has(timeZone)) {
    partsFormatter.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    }));
  }
  return partsFormatter.get(timeZone);
}

/** Wall-clock parts of an instant in a zone. */
export function zonedParts(ms, timeZone) {
  const out = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return { y: out.year, m: out.month, d: out.day, h: out.hour, mi: out.minute, s: out.second };
}

/** The zone's offset from UTC at an instant, in minutes (local minus UTC). */
export function offsetMinutes(ms, timeZone) {
  const whole = Math.floor(ms / 1000) * 1000;
  const p = zonedParts(whole, timeZone);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - whole) / MS_MIN);
}

/**
 * The UTC instant at which the wall clock in `timeZone` reads `dateStr` ("YYYY-MM-DD") `timeStr`
 * ("HH:MM"). Returns null when that local time does not exist (the hour skipped when clocks go
 * forward). When it happens twice (clocks go back) the first occurrence is returned.
 */
export function zonedTimeToUtc(dateStr, timeStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, h, mi);
  const offsets = new Set([offsetMinutes(naive - MS_DAY, timeZone), offsetMinutes(naive + MS_DAY, timeZone)]);
  const valid = [...offsets]
    .map((o) => naive - o * MS_MIN)
    .filter((utc) => offsetMinutes(utc, timeZone) === (naive - utc) / MS_MIN);
  return valid.length ? Math.min(...valid) : null;
}

/** "YYYY-MM-DD" of an instant as read in a zone. */
export function dateInZone(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Calendar arithmetic on date strings: no zone involved, so no daylight saving surprises. */
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

/** 0 (Sunday) to 6 (Saturday) for a date string. */
export function weekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** A time as a reader sees it, with the zone named: "Tue, 14 Oct, 10:00 am AEDT". */
export function formatSlot(ms, timeZone) {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  }).format(new Date(ms));
}

/** Just the clock time, with the zone: "10:00 am AEDT". */
export function formatClock(ms, timeZone) {
  return new Intl.DateTimeFormat('en-AU', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' }).format(new Date(ms));
}

/** A date string as a heading: "Tuesday 14 October". */
export function formatDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(Date.UTC(y, m - 1, d)));
}
