// Starts the booking API and the fictional clinic's web page, for trying the demo on your own computer.
//
//   node server/start.js
//
// Two origins, as in the real design (ADR-AB-0001): the clinic's own website, and the vendor's
// origin that serves the widget and the API. The widget may be framed only by the clinic's origin,
// and the API accepts only requests from it. Both listen on the loopback address only.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { DEMO_KEY } from './seed.js';
import { startServer } from '../tools/serve.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = Number(process.env.API_PORT ?? 8813);
const SITE_PORT = Number(process.env.SITE_PORT ?? 8812);

const siteOrigin = `http://127.0.0.1:${SITE_PORT}`;
const apiOrigin = `http://127.0.0.1:${API_PORT}`;

const app = createApp({ staticRoot: ROOT, origins: [siteOrigin, `http://localhost:${SITE_PORT}`] });
await app.listen(API_PORT);
await startServer(SITE_PORT, { frameSrc: apiOrigin });
setInterval(() => app.tick(), 1000).unref();

console.log(`
Appointment Booking demo, with the API running.

  Open:  ${siteOrigin}/?api=${encodeURIComponent(apiOrigin)}&key=${DEMO_KEY}
  API:   ${apiOrigin}/v1/   (the clinic's widget key is ${DEMO_KEY})

Everything is fictional, listens on this computer only, and sends nothing anywhere.
Press Ctrl+C to stop.`);
