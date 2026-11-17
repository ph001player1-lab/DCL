// Расписание случайных сигналов в часовом поясе пользователя.
// Окно бодрствования делится на N равных интервалов, в каждом — один случайный момент
// (стратифицированная случайная выборка). Отступ 15% от краёв интервала гарантирует
// паузу между сигналами не меньше 30% интервала (при 15 ч и 6 сигналах — от 45 мин).

const fmtCache = new Map();
function fmt(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTz(tz) {
  try { fmt(tz); return true; } catch { return false; }
}

const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function tzParts(ms, tz) {
  const p = {};
  for (const { type, value } of fmt(tz).formatToParts(new Date(ms))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, weekday: WD[p.weekday] };
}

export function tzOffsetMs(ms, tz) {
  const p = tzParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

export function localDate(ms, tz) {
  const p = tzParts(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Локальная дата + минуты от полуночи (можно > 1440) -> ms epoch UTC */
export function localToUtc(dateStr, minutes, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, Math.round(minutes));
  let t = guess - tzOffsetMs(guess, tz);
  const off2 = tzOffsetMs(t, tz);            // поправка на переход летнего времени
  if (guess - off2 !== t) t = guess - off2;
  return t;
}

export function nextLocalMidnight(ms, tz) {
  const today = localDate(ms, tz);
  return localToUtc(today, 1440, tz);
}

/** Моменты сигналов на дату dateStr, только будущие (после now). */
export function planDay({ tz, wake_start, wake_end, pings_per_day }, dateStr, now, rand = Math.random) {
  let start = wake_start;
  let end = wake_end;
  if (end <= start) end += 1440; // окно через полночь, например 10:00–02:00
  const n = Math.max(1, Math.min(12, pings_per_day | 0));
  const block = (end - start) / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    const minute = start + i * block + block * (0.15 + 0.7 * rand());
    const t = localToUtc(dateStr, minute, tz);
    if (t > now + 60_000) out.push(t);
  }
  return out;
}
