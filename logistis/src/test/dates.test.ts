import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  addDays,
  addMonths,
  daysBetween,
  isBusinessDay,
  lastBusinessDayOfMonth,
  lastDayOfMonth,
  orthodoxEaster,
  rollForward,
} from '../rules/businessDays.js';
import type { HolidayPack } from '../types.js';

const greekHolidays: HolidayPack = {
  fixed: [
    { month: 1, day: 1, name: 'Πρωτοχρονιά' },
    { month: 1, day: 6, name: 'Θεοφάνεια' },
    { month: 3, day: 25, name: 'Ευαγγελισμός' },
    { month: 5, day: 1, name: 'Πρωτομαγιά' },
    { month: 8, day: 15, name: 'Κοίμηση' },
    { month: 10, day: 28, name: 'Όχι' },
    { month: 12, day: 25, name: 'Χριστούγεννα' },
    { month: 12, day: 26, name: 'Σύναξη' },
  ],
  movable: [
    { offset: -48, name: 'Καθαρά Δευτέρα' },
    { offset: -2, name: 'Μεγάλη Παρασκευή' },
    { offset: 1, name: 'Δευτέρα του Πάσχα' },
    { offset: 50, name: 'Αγίου Πνεύματος' },
  ],
};

test('orthodox easter matches known dates', () => {
  // Independently verifiable: Orthodox Easter Sunday.
  assert.equal(orthodoxEaster(2024), '2024-05-05');
  assert.equal(orthodoxEaster(2025), '2025-04-20');
  assert.equal(orthodoxEaster(2026), '2026-04-12');
  assert.equal(orthodoxEaster(2027), '2027-05-02');
});

test('date arithmetic does not drift across month and year boundaries', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29', 'leap year');
  assert.equal(daysBetween('2026-01-01', '2026-12-31'), 364);
  assert.equal(daysBetween('2026-08-10', '2026-08-01'), -9);
});

test('addMonths normalises across years', () => {
  assert.deepEqual(addMonths(2026, 12, 1), { y: 2027, m: 1 });
  assert.deepEqual(addMonths(2026, 1, -1), { y: 2025, m: 12 });
  assert.deepEqual(addMonths(2026, 6, 12), { y: 2027, m: 6 });
});

test('lastDayOfMonth handles february', () => {
  assert.equal(lastDayOfMonth(2026, 2), 28);
  assert.equal(lastDayOfMonth(2028, 2), 29);
  assert.equal(lastDayOfMonth(2026, 4), 30);
});

test('greek public holidays are not business days', () => {
  assert.equal(isBusinessDay('2026-03-25', greekHolidays), false, 'Independence Day');
  assert.equal(isBusinessDay('2026-04-13', greekHolidays), false, 'Easter Monday 2026');
  assert.equal(isBusinessDay('2026-02-23', greekHolidays), false, 'Clean Monday 2026');
  assert.equal(isBusinessDay('2026-08-04', greekHolidays), true, 'ordinary Tuesday');
});

test('last business day of month rolls back off weekends and holidays', () => {
  // 2026-05-31 is a Sunday, so the last working day is Friday the 29th.
  assert.equal(lastBusinessDayOfMonth(2026, 5, greekHolidays), '2026-05-29');
  // 2026-12-31 is a Thursday and not a holiday.
  assert.equal(lastBusinessDayOfMonth(2026, 12, greekHolidays), '2026-12-31');
  // 2026-01-31 is a Saturday -> Friday the 30th.
  assert.equal(lastBusinessDayOfMonth(2026, 1, greekHolidays), '2026-01-30');
});

test('rollForward skips a holiday landing mid-week', () => {
  // 26 Oct 2026 is a Monday; 28 Oct is a holiday, so a 28th deadline moves to the 29th.
  assert.equal(rollForward('2026-10-28', greekHolidays), '2026-10-29');
});
