// A stand-in for the email and SMS delivery provider of ICR-AB-0003. It keeps what it "sent" in a
// list the demo's panel shows, because nothing leaves the machine. Like a real provider it:
//   - accepts an idempotency key and never sends the same key twice;
//   - can be unavailable, which the worker must ride out without losing a message;
//   - refuses a recipient it cannot use.

export class ProviderUnavailable extends Error { constructor() { super('The messaging provider is unavailable.'); this.name = 'ProviderUnavailable'; } }
export class InvalidRecipient extends Error { constructor() { super('The recipient cannot be used.'); this.name = 'InvalidRecipient'; } }

export function createMessagingProvider({ clock }) {
  const sent = [];
  const byKey = new Map();
  let down = false;
  let attempts = 0;
  let sequence = 0;

  return {
    send({ key, channel, to, subject, body }) {
      attempts += 1;
      if (down) throw new ProviderUnavailable();
      if (!to || /invalid/i.test(to)) throw new InvalidRecipient();
      if (byKey.has(key)) return { ...byKey.get(key), duplicate: true };
      const message = { id: `msg_${++sequence}`, key, channel, to, subject, body, at: clock.now() };
      sent.push(message);
      byKey.set(key, { id: message.id });
      return { id: message.id, duplicate: false };
    },
    setDown(value) { down = Boolean(value); },
    isDown: () => down,
    /** Everything "sent", for the panel. Fictional addresses only. */
    inbox: () => sent.map((m) => ({ ...m })),
    attempts: () => attempts,
    reset() { sent.length = 0; byKey.clear(); down = false; attempts = 0; },
  };
}
