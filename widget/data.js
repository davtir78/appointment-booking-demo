// The fictional clinic the demo runs on. Nothing here is real: the business, the staff and their
// hours are invented for the demo, and no real person or product is meant by any of it.

export const BUSINESS = {
  id: 'example-clinic',
  name: 'Example Clinic (fictional)',
  // Working hours below are rules in this zone (ADR-AB-0006); bookings are stored as UTC instants.
  timeZone: 'Australia/Sydney',
};

export const SERVICES = [
  { id: 'initial', name: 'Initial consultation', minutes: 45 },
  { id: 'followup', name: 'Follow-up', minutes: 30 },
  { id: 'review', name: 'Quick review', minutes: 15 },
];

const WEEKDAYS = [1, 2, 3, 4, 5];
const days = (list, windows) => Object.fromEntries(list.map((d) => [d, windows]));

// `hours` maps a weekday (0 = Sunday) to working windows in the business's zone.
export const STAFF = [
  { id: 'sam', name: 'Sam', role: 'Physiotherapist', services: ['initial', 'followup', 'review'], hours: days(WEEKDAYS, [['09:00', '12:00'], ['13:00', '17:00']]) },
  { id: 'alex', name: 'Alex', role: 'Physiotherapist', services: ['initial', 'followup'], hours: days([1, 3, 5], [['08:00', '14:00']]) },
  { id: 'jo', name: 'Jo', role: 'Exercise physiologist', services: ['followup', 'review'], hours: days([2, 3, 4], [['09:00', '15:00']]) },
];

// Shown prefilled in the details form. They are invented; the page says nothing entered is kept.
export const FICTIONAL_CUSTOMER = {
  name: 'Sample Customer',
  email: 'sample.customer@example.com',
  phone: '0400 000 000',
};

// Time zones offered for "show times in", to show how one booking reads in different places.
export const DISPLAY_ZONES = [
  { id: 'browser', label: 'My device’s time zone' },
  { id: 'Australia/Sydney', label: 'Sydney (the clinic)' },
  { id: 'Australia/Perth', label: 'Perth' },
  { id: 'Pacific/Auckland', label: 'Auckland' },
  { id: 'Europe/London', label: 'London' },
  { id: 'America/Los_Angeles', label: 'Los Angeles' },
];
