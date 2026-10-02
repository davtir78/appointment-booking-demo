// Fictional data for the API: two clinics (the second exists so tenant isolation can be shown),
// their staff and services, and calendars with believable busy time. Nothing here is real.

import { SERVICES, STAFF } from '../widget/data.js';
import { syncedBusy } from '../widget/domain.js';
import { addDays, dateInZone } from '../widget/time.js';

export const DEMO_BUSINESS = 'example-clinic';
export const OTHER_BUSINESS = 'second-clinic';
export const DEMO_KEY = 'pk_demo_example_clinic';
export const OTHER_KEY = 'pk_demo_second_clinic';

const SECOND = {
  business: { id: OTHER_BUSINESS, name: 'Second Clinic (fictional)', timeZone: 'Australia/Perth', widgetKey: OTHER_KEY },
  services: [{ id: 'consult', name: 'Consultation', minutes: 30 }],
  staff: [{ id: 'kim', name: 'Kim', role: 'Podiatrist', services: ['consult'], hours: Object.fromEntries([1, 2, 3, 4, 5].map((d) => [d, [['09:00', '17:00']]])) }],
};

export function seed({ store, calendar, connector, clock, origins }) {
  store.addBusiness({ id: DEMO_BUSINESS, name: 'Example Clinic (fictional)', timeZone: 'Australia/Sydney', widgetKey: DEMO_KEY, origins });
  for (const s of SERVICES) store.addService(DEMO_BUSINESS, s);
  for (const m of STAFF) store.addStaff(DEMO_BUSINESS, m);

  store.addBusiness({ ...SECOND.business, origins });
  for (const s of SECOND.services) store.addService(OTHER_BUSINESS, s);
  for (const m of SECOND.staff) store.addStaff(OTHER_BUSINESS, m);

  // Each staff member's own calendar already holds some private appointments (the same believable
  // pattern the browser build uses). Connecting the calendar copies only their times.
  const groups = [[DEMO_BUSINESS, 'Australia/Sydney', STAFF], [OTHER_BUSINESS, 'Australia/Perth', SECOND.staff]];
  for (const [businessId, timeZone, staff] of groups) {
    for (const member of staff) {
      const today = dateInZone(clock.now(), timeZone);
      const events = [];
      for (let n = 0; n < 28; n += 1) {
        for (const b of syncedBusy(member, addDays(today, n), timeZone)) events.push({ start: b.start, end: b.end });
      }
      calendar.seed(member.id, events);
      connector.connect(businessId, member.id);
    }
  }
}
