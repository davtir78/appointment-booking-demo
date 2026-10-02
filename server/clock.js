// One clock for the whole server, so time can be controlled: tests freeze it, and the demo's
// "move the clock" control makes a five-minute hold expire without a five-minute wait.

/** A real clock that can be moved forward (`fixed` null), or a frozen one that only moves when told. */
export function createClock({ fixed = null } = {}) {
  let frozen = fixed;
  let offset = 0;
  return {
    now: () => (frozen !== null ? frozen : Date.now() + offset),
    advance(ms) { if (frozen !== null) frozen += ms; else offset += ms; },
    isFrozen: () => frozen !== null,
  };
}
