# Appointment Booking demo

A working demo of the **Appointment Booking (sample)** system: a booking widget embedded in a fictional clinic's web page, and, behind it, a real API with a calendar connector, a notification worker and a database. It is the running half of the sample project documented on [IT Architecture Patterns](https://www.itarchitecturepatterns.net), where the [records](https://github.com/davtir78/itarchitecturepatterns/tree/main/docs/samples/appointment-booking) (the solution architecture design, decisions, contracts) describe the system and this shows it behaving.

> **Everything here is fictional.** The clinic, the staff and their hours are invented. Nothing is ever sent anywhere, and no real calendar or messaging service is contacted.

## Two ways to run it

| | Public mode | With the real API |
| :--- | :--- | :--- |
| Command | `node tools/serve.mjs` | `npm run demo` |
| Where the booking logic runs | In the browser | In an HTTP service on your computer |
| Network requests while you use it | **None** (the page's content security policy forbids them) | To the local API only |
| Kept after a reload | Nothing | Nothing (the database is in memory) |
| The "Behind the scenes" panel | No | Yes |
| Used for | the version the site serves | presenting the templates against a working system |

Public mode needs nothing but Node. The API needs Node 22.13 or later (it uses the built-in `node:sqlite`).

`npm run demo` prints a link such as `http://127.0.0.1:8812/?api=http://127.0.0.1:8813&key=pk_demo_example_clinic`. There are two origins, as in the real design: the clinic's own site, and a separate origin that serves the widget and the API. Both listen on this computer only.

## What each template shows, against the running system

Open the **Behind the scenes** panel under the widget. For every request the widget makes and every event the server logs, it names the part of the design that is acting and links to the record it implements.

| Template | Record | What you can see running |
| :--- | :--- | :--- |
| **Solution architecture design** | [sad.md §4.2](https://github.com/davtir78/itarchitecturepatterns/blob/main/docs/samples/appointment-booking/sad.md#42-component-catalog) | Each component in the catalog is a module here (table below), and the panel labels every event with its component |
| **Decision record (MADR)** | [the six ADRs](https://github.com/davtir78/itarchitecturepatterns/tree/main/docs/samples/appointment-booking/decisions) | Each decision is a behaviour you can provoke: the lost race (ADR-3), the calendar change the sync missed (ADR-2), the messaging outage (ADR-5), times in another zone (ADR-6), the framed widget (ADR-1) |
| **Pattern** | [Integration API Management (External)](https://www.itarchitecturepatterns.net/patterns/int-api-external), [Native Connectors (Cloud)](https://www.itarchitecturepatterns.net/patterns/int-native-cloud), [Middleware Services (Cloud)](https://www.itarchitecturepatterns.net/patterns/int-middleware-cloud) | The gateway, the calendar connector and the notification worker are built on these three; the panel links each event to its pattern. (The architecture pattern *records* wait for the format in #12) |
| **Interface contract (ICR)** | [the three ICRs](https://github.com/davtir78/itarchitecturepatterns/tree/main/docs/samples/appointment-booking/contracts) | Their sixteen acceptance criteria are automated tests; see the conformance table |

### The SAD's components, and what stands in for them

| SAD component | In this demo | Status |
| :--- | :--- | :--- |
| Booking widget | `widget/` in an iframe, loaded by `js/embed.js` | built |
| API gateway | `server/app.js` | built |
| Availability service, Booking service | `server/booking-service.js` | built (one module) |
| Booking store | `server/store.js`, SQLite | built; differs from the design (below) |
| Calendar connectors | `server/calendar-connector.js` against `server/providers/calendar.js` | built, against a stand-in provider |
| Notification worker | `server/notification-worker.js` against `server/providers/messaging.js` | built, against a stand-in provider |
| Event stream | the in-process event log (`server/log.js`) | stand-in |
| Observability | the log, `traceparent`, and the panel | stand-in |
| Scheduler | `app.tick()`, run every second | stand-in |
| Secrets management | tokens sealed with AES-GCM under a key made at start-up | stand-in |
| Admin console, bot protection | not built | out of scope |

## Conformance to the contracts

Each numbered acceptance criterion of the three contracts is an automated test. `tests/conformance.test.mjs` fails if one loses its test or if this table stops naming it.

| Criterion | What it requires | Test file |
| :--- | :--- | :--- |
| ICR-AB-0001 #1 | A seven-day search returns in under 400 ms at p95 | `api.test.mjs` |
| ICR-AB-0001 #2 | Fifty simultaneous confirmations of one slot give exactly one booking and 49 `409`s listing alternatives | `api.test.mjs` (also fifty simultaneous holds) |
| ICR-AB-0001 #3 | A request from an unregistered domain receives `403` | `api.test.mjs` |
| ICR-AB-0001 #4 | A repeated `POST` with the same idempotency key creates nothing and returns the original | `api.test.mjs` |
| ICR-AB-0001 #5 | Every time in every response is an ISO 8601 instant with an offset | `api.test.mjs` |
| ICR-AB-0001 #6 | No log line contains a customer's name, email or phone | `api.test.mjs` (the logger also refuses such a field outright) |
| ICR-AB-0002 #1 | An appointment added to a staff calendar removes the overlapping slots within 60 seconds | `calendar.test.mjs` |
| ICR-AB-0002 #2 | Confirming creates exactly one calendar event; confirming again creates no second | `calendar.test.mjs` |
| ICR-AB-0002 #3 | Revoking access deletes stored tokens and stops synchronisation within a minute | `calendar.test.mjs` |
| ICR-AB-0002 #4 | After an hour's outage nothing is lost, and everything is consistent within ten minutes of the provider's return | `calendar.test.mjs` |
| ICR-AB-0002 #5 | No stored busy interval holds an event title, attendee or description | `calendar.test.mjs` |
| ICR-AB-0003 #1 | With the provider unavailable bookings succeed; when it returns every pending message is sent exactly once | `notifications.test.mjs` |
| ICR-AB-0003 #2 | A booking cancelled before its confirmation is sent produces a cancellation and no confirmation | `notifications.test.mjs` |
| ICR-AB-0003 #3 | A reminder whose window passed during an outage is not sent late | `notifications.test.mjs` |
| ICR-AB-0003 #4 | Replaying the same booking event sends nothing new | `notifications.test.mjs` |
| ICR-AB-0003 #5 | No log line contains a message body, email address or phone number | `notifications.test.mjs` |

Beyond the criteria, the tests check the rest of each contract: every error code and its meaning as a problem document, the rate limit with `Retry-After`, `traceparent`, tenant isolation, token expiry, CORS, and, for ADR-AB-0003, that **the database itself** refuses an overlapping booking when a row is inserted directly, bypassing the application.

## Where the demo differs from the design

| The design says | The demo does | Consequence |
| :--- | :--- | :--- |
| PostgreSQL with an exclusion constraint and row-level security | SQLite with an overlap **trigger**; every query goes through `store.scope(businessId)`, the only data path | The database does refuse overlaps. But tenant isolation here is by code, not by the database, which is weaker than row-level security, and the ADR-AB-0004 tests prove the code, not the database |
| Kafka or EventBridge between services | One process; an in-process event log | The events and their order are real; only the transport differs |
| Google Calendar and Microsoft 365 | A stand-in provider with change notifications, subscriptions that expire, outages and revocation | The connector's logic is the same shape; no consent flow or real API behaviour has been tried |
| An email and SMS provider | A stand-in whose "sent" messages are listed in the panel | Nothing is delivered. Delivery-status callbacks are not modelled |
| TLS and HSTS on the API domain | Plain HTTP on the loopback address | Right for a local demo, wrong for anything else |
| Bot protection on hold and confirm | Not built | The rate limit is the only defence |
| Search p95 under 400 ms "at typical load" | Measured against an empty server with no load | The test shows the algorithm is fast, not that production load is met |

## Findings for the records

Building the API found places where the records are silent or wrong. None has been changed in the records.

1. **ADR-AB-0003** says a hold lasts five minutes. WCAG 2.2.1 requires a way to extend a time limit, so the API has `POST /v1/holds/{id}/extend` (up to ten times). The decision should say so.
2. **ICR-AB-0001** has no way to release a hold, so a customer who goes back to change a time blocks their own first choice for five minutes. The API has `DELETE /v1/holds/{id}`. Both additions are marked as proposed.
3. **ICR-AB-0001** does not say what a *second* confirmation of the same hold with a *different* idempotency key returns. The demo says `409` with alternatives. Reusing a key with a different request is `422`.
4. **ICR-AB-0001** does not say what happens when the live calendar check cannot be made because the provider is down. The demo **confirms anyway**, skips the check, logs it, and reconciles the calendar afterwards, because the design principle is that a provider outage "never stops a booking". The cost is a possible double booking against a calendar event the sync hadn't seen. That is a business risk to accept deliberately, and the contract should say so.
5. **ICR-AB-0002 is "proposed" because its subscription-renewal schedule is not designed.** The connector implements one: renew when less than a day of a (three-day) subscription remains; on a lapse, raise an alert, subscribe again and re-synchronise. The test shows the missed-renewal path works. The contract could adopt it.
6. **ICR-AB-0003** says to retry for 24 hours then dead-letter. A reminder queued days ahead had its 24 hours counted from creation, so it could be dead-lettered before it was due. The worker now counts from when a message becomes due. The contract should say "from when it is due".
7. **ICR-AB-0002** says a full re-synchronisation runs "when calls start succeeding again". With a retry back-off capped at an hour, writes could wait an hour after the provider returned. The connector now probes a failing provider every minute and, when it answers, re-synchronises and retries pending writes at once.

## Safety

- **Local only.** The API listens on `127.0.0.1`, answers only requests whose `Host` is a local name (which also defeats DNS-rebinding), and its inspection and control endpoints under `/_demo/` need a custom header, so another site cannot trigger them.
- **Registered pages only.** The widget page carries `frame-ancestors` for the origins the business registered, so the browser refuses to show it in any other page. The API checks the embedding origin the widget reports (learned from a `postMessage`, whose origin the browser vouches for) and answers `403` for any other.
- **Fictional data, nothing kept.** The database is in memory and lost when the server stops. The log refuses a field that could hold personal information.
- **The public build cannot reach a network.** Its pages carry `connect-src 'none'`. Only the API's own copy of the widget page relaxes that, to its own origin.

## Accessibility

The target is WCAG 2.2 AA. Automatically checked (`npm run test:e2e`):

- the [axe](https://github.com/dequelabs/axe-core) checker, against the WCAG 2.0 to 2.2 A and AA rules, on every screen in both modes (the panel included) and on the host page: no violations;
- a complete booking, change and cancellation using only Tab, the arrow keys, Space and Enter, with focus moved to each step's heading and the outcome announced;
- one Tab stop for the whole day-and-time grid, with the arrow keys moving through it; a visible focus outline; no sideways scrolling of the page at phone width.

Built in: real fieldsets and radio buttons, labelled fields with identified errors, a status region for announcements, targets of at least 44 px, reduced-motion and forced-colours support, and a hold that can be extended (WCAG 2.2.1).

**Not yet done:** a check with a real screen reader (NVDA, VoiceOver). Automated tools find roughly a third of accessibility problems, so this is still owed before the demo is called conformant.

## Serving the public demo from another site

The public mode follows the same contract as the Strategy Modeler. A site that serves it adds `tool-host` meta tags to `index.html` and `js/hostbar.js` draws a way home across the top. On its own there are no tags and no bar.

```html
<meta name="tool-host-name" content="Site name">
<meta name="tool-host-href" content="/">
<meta name="tool-host-link" content="Label|/path">   <!-- optional, repeatable -->
```

To serve it from `/samples/appointment-booking/`, register it in the site's tool registry with `index.html`, `css`, `js` and `widget` as its runtime files. The API mode is for presenting locally and is not part of what the site serves.

## Tests

```bash
npm test             # logic, API, calendar connector, notification worker, conformance: no browser
npm install && npm run test:e2e    # a real browser: the public mode, and the real API across two origins
```

## Licence

Not yet chosen. Until the owner adds one, all rights are reserved.
