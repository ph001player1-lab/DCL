import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localToUtc, localDate, nextLocalMidnight, planDay, tzParts } from '../src/schedule.js';

test('localToUtc Moscow (UTC+3)', () => {
  assert.equal(localToUtc('2026-11-17', 8 * 60, 'Europe/Moscow'), Date.UTC(2026, 10, 17, 5, 0));
});

test('localToUtc handles DST (Berlin, summer +2 / winter +1)', () => {
  assert.equal(localToUtc('2026-07-01', 600, 'Europe/Berlin'), Date.UTC(2026, 6, 1, 8, 0));
  assert.equal(localToUtc('2026-12-01', 600, 'Europe/Berlin'), Date.UTC(2026, 11, 1, 9, 0));
});

test('next midnight and local date', () => {
  const now = Date.UTC(2026, 10, 17, 22, 30); // 01:30 18 ноября по Москве
  assert.equal(localDate(now, 'Europe/Moscow'), '2026-11-18');
  assert.equal(nextLocalMidnight(now, 'Europe/Moscow'), Date.UTC(2026, 10, 18, 21, 0));
});

test('planDay: N pings inside window with min gap', () => {
  const u = { tz: 'Asia/Yekaterinburg', wake_start: 480, wake_end: 1380, pings_per_day: 6 };
  for (let k = 0; k < 200; k++) {
    const ts = planDay(u, '2026-11-20', 0);
    assert.equal(ts.length, 6);
    for (let i = 0; i < ts.length; i++) {
      const p = tzParts(ts[i], u.tz);
      const min = p.h * 60 + p.mi;
      assert.ok(min >= 480 && min <= 1380, `inside window: ${min}`);
      if (i) assert.ok(ts[i] - ts[i - 1] >= 44 * 60_000, 'gap >= 45 min');
    }
  }
});

test('planDay: window across midnight and only future pings', () => {
  const u = { tz: 'Europe/Moscow', wake_start: 600, wake_end: 120, pings_per_day: 4 };
  const ts = planDay(u, '2026-11-20', 0, () => 0.5);
  assert.equal(ts.length, 4);
  assert.equal(localDate(ts[3], u.tz), '2026-11-21');
  const now = ts[1];
  assert.equal(planDay(u, '2026-11-20', now, () => 0.5).length, 2);
});

test('planDay: up to 20 pings, still ordered and inside window', () => {
  const u = { tz: 'Europe/Moscow', wake_start: 420, wake_end: 1380, pings_per_day: 20 };
  const ts = planDay(u, '2026-11-20', 0);
  assert.equal(ts.length, 20);
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= 14 * 60_000, 'gap >= 14 min');
});
