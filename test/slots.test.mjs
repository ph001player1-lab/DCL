import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOKING_DEFAULTS, computeSlots, horizon, cleanBookingConfig } from '../src/slots.js';

const iso = (t) => new Date(t).toISOString().slice(0, 16);

test('окна на 3 дня: часы приёма, запас до начала, занятое время', () => {
  const now = Date.parse('2026-11-23T09:30:00Z'); // 12:30 по Москве
  const busy = [[Date.parse('2026-11-23T12:00:00Z'), Date.parse('2026-11-23T13:30:00Z')]]; // 15:00–16:30 МСК
  const s = computeSlots(BOOKING_DEFAULTS, busy, now);
  // сегодня: 14:30+ (запас 2 ч), 15:00 и 16:00 заняты → 17:00 и 18:00; завтра и послезавтра — по 9 окон 10:00–18:00
  assert.deepEqual(s.slice(0, 3).map((x) => iso(x.start)), ['2026-11-23T14:00', '2026-11-23T15:00', '2026-11-24T07:00']);
  assert.equal(s.length, 2 + 9 + 9);
  assert.equal(iso(s.at(-1).start), '2026-11-25T15:00');
  assert.ok(s.every((x) => x.end - x.start === 60 * 60_000));
  assert.equal(iso(horizon(BOOKING_DEFAULTS, now)), '2026-11-25T21:00');
});

test('только выбранные дни недели', () => {
  const now = Date.parse('2026-11-27T05:00:00Z'); // пятница, 08:00 МСК
  const s = computeSlots({ ...BOOKING_DEFAULTS, weekdays: [1, 2, 3, 4, 5] }, [], now);
  assert.ok(s.every((x) => new Date(x.start + 3 * 3600_000).getUTCDay() === 5)); // сб и вс пропущены
  assert.equal(s.length, 9);
});

test('переход на летнее время не сдвигает часы приёма', () => {
  const cfg = { ...BOOKING_DEFAULTS, tz: 'Europe/Berlin', days: 2, lead: 0 };
  const now = Date.parse('2026-03-28T06:00:00Z'); // сб; в ночь на вс Берлин переходит на UTC+2
  const s = computeSlots(cfg, [], now);
  assert.equal(iso(s.find((x) => x.start > Date.parse('2026-03-29T00:00:00Z')).start), '2026-03-29T08:00'); // 10:00 по Берлину = 08:00 UTC
  assert.equal(iso(s[0].start), '2026-03-28T09:00'); // 10:00 по Берлину = 09:00 UTC
});

test('проверка настроек записи', () => {
  const ok = cleanBookingConfig({ ...BOOKING_DEFAULTS, weekdays: [3, 1, 1] });
  assert.deepEqual(ok.weekdays, [1, 3]);
  assert.throws(() => cleanBookingConfig({ ...BOOKING_DEFAULTS, end: 500 }), /bad_end/);
  assert.throws(() => cleanBookingConfig({ ...BOOKING_DEFAULTS, tz: 'Mars/Base' }), /bad_tz/);
  assert.throws(() => cleanBookingConfig({ ...BOOKING_DEFAULTS, days: 0 }), /bad_days/);
});
