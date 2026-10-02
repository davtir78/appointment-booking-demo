// The server's log and event stream. Every component writes here, and the demo's "behind the
// scenes" panel reads it. Two rules from the contracts are enforced in code, not by good intentions:
//   ICR-AB-0001: "no log line contains a customer's name, email address or phone number"
//   ICR-AB-0003: "no log line contains a message body, email address or phone number"
// A field that could hold personal information is refused outright, so a careless call fails in
// development instead of leaking in production. Ids, counts, statuses and timings are fine.

const FORBIDDEN_FIELDS = new Set(['name', 'email', 'phone', 'mobile', 'to', 'recipient', 'address', 'body', 'subject', 'customer', 'title', 'attendees']);

/**
 * @param {{ now: () => number, capacity?: number }} options
 */
export function createLog({ now, capacity = 1000 }) {
  let seq = 0;
  const entries = [];

  /**
   * @param {string} component  e.g. "gateway", "booking", "calendar", "notifications", "store"
   * @param {string} event      a short machine-readable name
   * @param {object} detail     ids, counts, statuses; never personal information
   * @param {{ ref?: string, traceId?: string, level?: string }} meta  ref names the record this implements
   */
  function write(component, event, detail = {}, { ref = null, traceId = null, level = 'info' } = {}) {
    for (const key of Object.keys(detail)) {
      if (FORBIDDEN_FIELDS.has(key.toLowerCase())) throw new Error(`log field "${key}" could hold personal information and may not be logged`);
    }
    const entry = { seq: ++seq, at: now(), component, event, level, ref, traceId, detail };
    entries.push(entry);
    if (entries.length > capacity) entries.shift();
    return entry;
  }

  return {
    write,
    /** Entries after a sequence number, for polling. */
    since: (after = 0) => entries.filter((e) => e.seq > after),
    all: () => [...entries],
    /** The log as text lines, as an operator would see them. */
    lines: () => entries.map((e) => JSON.stringify(e)),
    clear() { entries.length = 0; },
  };
}
