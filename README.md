# Appointment Booking demo

A clickable demo of the **Appointment Booking (sample)** widget: a booking form embedded in a fictional clinic's web page. It is the working half of the sample project documented on [IT Architecture Patterns](https://www.itarchitecturepatterns.net), where the [records](https://github.com/davtir78/itarchitecturepatterns/tree/main/docs/samples/appointment-booking) (design, decisions, contracts) describe the system and this demo shows it behaving.

> **Everything here is fictional.** The clinic, the staff and their hours are invented. The demo makes no real bookings, contacts no calendar, email or text service, makes **no network requests** while you use it, and **keeps nothing**: reloading discards it. Every screen says so.

## Try it

```bash
node tools/serve.mjs        # http://127.0.0.1:8812/
```

No build step and no dependencies to run it: plain HTML, CSS and JavaScript modules, like the [Strategy Modeler](https://github.com/davtir78/StrategyModeler).

The page suggests four things to try: book, change and cancel; lose a race for the same time; let a hold run out (or extend it); and read the same booking in another time zone.

## What it implements

| Behaviour | Record |
| :--- | :--- |
| The widget is an iframe on the business's page, sized by a small loader script (`js/embed.js`) that also passes the brand colour. The page can't read inside the frame and accepts only a height from it | [ADR-AB-0001](https://github.com/davtir78/itarchitecturepatterns/blob/main/docs/samples/appointment-booking/decisions/0001-embed-mechanism.md) |
| Search reads a synchronised copy of staff calendars; confirming runs a live check, so a change the copy hasn't seen is caught and other times are offered at once | [ADR-AB-0002](https://github.com/davtir78/itarchitecturepatterns/blob/main/docs/samples/appointment-booking/decisions/0002-availability-source-of-truth.md) |
| Choosing a time holds it for five minutes. Holds and bookings are rows in one table, and a row overlapping an active one for the same person is rejected | [ADR-AB-0003](https://github.com/davtir78/itarchitecturepatterns/blob/main/docs/samples/appointment-booking/decisions/0003-double-booking-prevention.md) |
| Each booking change queues a confirmation and a reminder; the demo lists them and sends nothing | [ADR-AB-0005](https://github.com/davtir78/itarchitecturepatterns/blob/main/docs/samples/appointment-booking/decisions/0005-notification-delivery.md) |
| Bookings are UTC instants; working hours are local rules; every time names its zone; the changeover hour is handled by the time zone database | [ADR-AB-0006](https://github.com/davtir78/itarchitecturepatterns/blob/main/docs/samples/appointment-booking/decisions/0006-time-zones.md) |
| The operations the widget calls (`services`, `availability`, `holds`, `confirm`, `PATCH`, `DELETE`) and its handling of `409`, idempotency keys and hold expiry | [ICR-AB-0001](https://github.com/davtir78/itarchitecturepatterns/blob/main/docs/samples/appointment-booking/contracts/ICR-AB-0001-booking-api.md) |

`widget/domain.js` is the booking logic with no page in it, and a stand-in for the Booking API; `widget/widget.js` is the interface.

## How the promises are enforced

- **No network use.** Both pages carry a content security policy with `connect-src 'none'` and `form-action 'none'`, so the browser itself refuses requests. A test records every request during a full book, change and cancel and expects none; another proves a script's attempt to send is blocked.
- **Nothing kept.** No `localStorage`, `sessionStorage`, cookies or IndexedDB, checked in the source and in a running browser.
- **Fictional contact details.** The form is prefilled with invented values, and says nothing entered is kept.

## Accessibility

The target is WCAG 2.2 AA. What is checked automatically (`npm run test:e2e`):

- the [axe](https://github.com/dequelabs/axe-core) checker, against the WCAG 2.0 to 2.2 A and AA rules, on every screen (service, times, details, details with errors, booked, cancel, cancelled) and on the host page: no violations;
- a complete booking, change of time and cancellation using only Tab, the arrow keys, Space and Enter, with focus moved to each step's heading and the outcome announced;
- a visible focus outline; no sideways scrolling at phone width.

Built in: real fieldsets and radio buttons, labelled fields with identified errors, a status region for announcements, targets of at least 44 px, reduced-motion and forced-colours support, and a **hold that can be extended** (a five-minute limit would otherwise fail WCAG 2.2.1).

**Not yet done:** a check with a real screen reader (NVDA, VoiceOver). Automated tools find roughly a third of accessibility problems, so this is still owed before the demo is called conformant.

## Findings for the records

Building the demo showed two places where the records are silent:

1. **ADR-AB-0003** says a hold lasts five minutes. WCAG 2.2.1 requires a way to extend a time limit, so the widget offers "Keep holding", up to ten times. The decision should say so.
2. **ICR-AB-0001** has no operation to release a hold. Without one, a customer who goes back to change a time blocks their own first choice for five minutes. The demo adds `releaseHold`; the contract needs a `DELETE /holds/{holdId}`.

## Serving it from another site

The demo follows the same contract as the Strategy Modeler. A site that serves it adds `tool-host` meta tags to `index.html` and `js/hostbar.js` draws a way home across the top. On its own there are no tags and no bar, so the demo stays domain-neutral:

```html
<meta name="tool-host-name" content="Site name">
<meta name="tool-host-href" content="/">
<meta name="tool-host-link" content="Label|/path">   <!-- optional, repeatable -->
```

To serve it from `/samples/appointment-booking/`, register it in the site's tool registry (`src/lib/tools.json`) with `index.html`, `css`, `js` and `widget` as its runtime files.

In this demo the page and the widget share an origin for simplicity. In the real design the widget is served from the vendor's own origin, which is what stops the host page reading it.

## Tests

```bash
npm test                 # the booking logic: 22 tests, no browser
npm install && npm run test:e2e   # a real browser: 15 tests
```

## Licence

Not yet chosen. Until the owner adds one, all rights are reserved.
