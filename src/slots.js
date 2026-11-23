// Свободные окна для записи на консультацию: часы приёма в поясе специалиста минус занятое время
// из его Google-календаря и уже сделанные записи. Чистые функции, без сети.
import { isValidTz, localDate, localToUtc, tzParts } from './schedule.js';
import { HttpError, int } from './util.js';

export const BOOKING_DEFAULTS = {
  tz: 'Europe/Moscow', // пояс специалиста
  start: 600,          // часы приёма: с 10:00
  end: 1140,           // до 19:00 (минуты от полуночи)
  duration: 60,        // длительность консультации, мин
  step: 60,            // шаг начала окон, мин
  lead: 120,           // записаться можно не позже чем за N минут до начала
  days: 3,             // на сколько календарных дней вперёд (включая сегодня)
  weekdays: [1, 2, 3, 4, 5, 6, 7], // 1 = пн … 7 = вс
};

export function cleanBookingConfig(b) {
  const bad = (f) => { throw new HttpError(400, `bad_${f}`); };
  const c = {};
  if (typeof b.tz !== 'string' || !isValidTz(b.tz)) bad('tz');
  c.tz = b.tz;
  if (!int(b.start, 0, 1439)) bad('start');
  if (!int(b.end, 1, 1440) || b.end <= b.start) bad('end');
  if (!int(b.duration, 15, 240)) bad('duration');
  if (!int(b.step, 15, 240)) bad('step');
  if (!int(b.lead, 0, 2880)) bad('lead');
  if (!int(b.days, 1, 7)) bad('days');
  if (!Array.isArray(b.weekdays) || !b.weekdays.length || !b.weekdays.every((d) => int(d, 1, 7))) bad('weekdays');
  Object.assign(c, { start: b.start, end: b.end, duration: b.duration, step: b.step, lead: b.lead, days: b.days });
  c.weekdays = [...new Set(b.weekdays)].sort();
  return c;
}

const nextDate = (date, tz) => localDate(localToUtc(date, 1440 + 720, tz), tz); // полдень следующего дня — без ошибок на переходе времени

/** Конец последнего дня окна записи (ms) */
export function horizon(cfg, now) {
  let date = localDate(now, cfg.tz);
  for (let i = 1; i < cfg.days; i++) date = nextDate(date, cfg.tz);
  return localToUtc(date, 1440, cfg.tz);
}

/**
 * Свободные окна на cfg.days календарных дней, начиная с сегодняшнего (в поясе специалиста).
 * busy — занятые интервалы [[startMs, endMs], ...].
 */
export function computeSlots(cfg, busy, now) {
  const out = [];
  let date = localDate(now, cfg.tz);
  for (let i = 0; i < cfg.days; i++) {
    const weekday = tzParts(localToUtc(date, 720, cfg.tz), cfg.tz).weekday;
    if (cfg.weekdays.includes(weekday)) {
      for (let m = cfg.start; m + cfg.duration <= cfg.end; m += cfg.step) {
        const start = localToUtc(date, m, cfg.tz);
        const end = start + cfg.duration * 60_000;
        if (start < now + cfg.lead * 60_000) continue;
        if (busy.some(([bs, be]) => bs < end && be > start)) continue;
        out.push({ start, end });
      }
    }
    date = nextDate(date, cfg.tz);
  }
  return out;
}
