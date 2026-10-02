// Errors that carry an HTTP status and a stable code, so the gateway can turn them into RFC 9457
// problem details (ICR-AB-0001: "400 invalid request; 401 unknown or revoked key; 403 origin not
// registered; 404 unknown resource; 409 slot no longer free; 410 hold expired; 429 rate limited;
// 503 temporarily unavailable").

export class HttpError extends Error {
  constructor(status, code, detail, extra = {}) {
    super(detail);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const TITLES = {
  400: 'Invalid request', 401: 'Unknown or revoked key', 403: 'Not allowed', 404: 'Not found', 409: 'Conflict',
  410: 'Gone', 413: 'Request too large', 415: 'Unsupported media type', 422: 'Unprocessable request', 429: 'Too many requests', 503: 'Temporarily unavailable',
};

/** An RFC 9457 problem document. `type` is a stable URI per code; nothing in it names a customer. */
export function problem(err, instance) {
  return {
    type: `https://www.itarchitecturepatterns.net/samples/appointment-booking/problems/${err.code}`,
    title: TITLES[err.status] ?? 'Error',
    status: err.status,
    code: err.code,
    detail: err.message,
    ...(instance ? { instance } : {}),
    ...err.extra,
  };
}
