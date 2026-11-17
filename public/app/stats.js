// Расчёты для экранов «Сегодня» и «Анализ». Чистые функции, без DOM.
import { isFull, hasZero, isEustress, zeroBits, CATEGORY_LABEL, codeOf } from './dcl.js';

/** Длина окна бодрствования в минутах */
export function windowMinutes(s) {
  let len = s.wake_end - s.wake_start;
  if (len <= 0) len += 1440;
  return len;
}

/**
 * Основные цифры за период.
 * Индекс считается по ответам на случайные сигналы: только они дают несмещённую оценку доли дня.
 * Если таких ответов нет, используются ручные записи (с пометкой manualOnly).
 */
export function summarize(answers, pings, settings) {
  const fromPings = answers.filter((a) => a.source === 'ping');
  const manualOnly = fromPings.length === 0 && answers.length > 0;
  const base = manualOnly ? answers : fromPings;
  const n = base.length;
  let full = 0, zero = 0, eu = 0;
  for (const a of base) {
    const c = a.code || codeOf(a);
    if (isFull(c)) full++;
    else if (hasZero(c)) zero++;
    if (isEustress(a)) eu++;
  }
  const unknown = n - full - zero;
  const days = new Set(base.map((a) => a.local_date)).size || 1;
  const win = windowMinutes(settings);
  const delivered = pings.filter((p) => !p.test && ['sent', 'answered', 'skipped', 'expired'].includes(p.status));
  const now = Date.now();
  const missed = delivered.filter((p) => p.status === 'skipped' || p.status === 'expired' || (p.status === 'sent' && p.exp < now)).length;
  return {
    n, full, zero, unknown, eustress: eu, distress: n - eu, manualOnly, days,
    fullShare: n ? full / n : 0,
    zeroShare: n ? zero / n : 0,
    unknownShare: n ? unknown / n : 0,
    euShare: n ? eu / n : 0,
    load: n ? Math.round((zero / n) * 100) : null,          // «нагрузка» 0–100
    openPalmMin: n ? Math.round((full / n) * win) : 0,       // минут в день с открытой ладонью (оценка)
    zeroMin: n ? Math.round((zero / n) * win) : 0,
    delivered: delivered.length, missed,
  };
}

export function byDay(answers, dates) {
  const map = new Map(dates.map((d) => [d, { date: d, n: 0, full: 0, zero: 0 }]));
  for (const a of answers) {
    const r = map.get(a.local_date);
    if (!r || a.source !== 'ping') continue;
    r.n++;
    if (isFull(a.code)) r.full++;
    else if (hasZero(a.code)) r.zero++;
  }
  return [...map.values()];
}

/** Тепловая карта: день недели (1..7) × трёхчасовой интервал (0..7) */
export function heatmap(answers) {
  const cells = {};
  for (const a of answers) {
    if (a.source !== 'ping') continue;
    const k = `${a.weekday}:${Math.floor(a.local_hour / 3)}`;
    const c = (cells[k] ||= { n: 0, zero: 0 });
    c.n++;
    if (hasZero(a.code)) c.zero++;
  }
  return cells;
}

function topBit(bits) {
  let best = null;
  for (const [k, v] of Object.entries(bits)) if (v > 0 && (!best || v > bits[best])) best = k;
  return best;
}

function group(list, keyFn, labelFn) {
  const m = new Map();
  for (const a of list) {
    const key = keyFn(a);
    const g = m.get(key) || { key, label: labelFn(a), n: 0, zero: 0, full: 0, unknown: 0, bits: { d1: 0, c1: 0, l: 0, d2: 0, c2: 0 } };
    g.n++;
    if (isFull(a.code)) g.full++;
    if (hasZero(a.code)) g.zero++;
    if (a.code.includes('x')) g.unknown++;
    for (const b of zeroBits(a)) g.bits[b]++;
    m.set(key, g);
  }
  return [...m.values()].map((g) => ({ ...g, top: topBit(g.bits) }))
    .sort((x, y) => y.zero - x.zero || y.n - x.n);
}

/** Мишени: где и в каком разряде копятся нули */
export function targets(answers) {
  const list = answers.filter((a) => a.source === 'ping');
  const use = list.length ? list : answers;
  const byCategory = group(use, (a) => (a.category === 'other' && a.label ? `other:${a.label}` : a.category),
    (a) => (a.category === 'other' && a.label ? a.label : CATEGORY_LABEL[a.category] || a.category));
  const byPartner = group(use.filter((a) => a.company === 'pair'), (a) => a.partner || 'other', (a) => a.partner || 'other');
  const bits = { d1: 0, c1: 0, l: 0, d2: 0, c2: 0 };
  let pairs = 0, unknown = 0;
  const codes = new Map();
  for (const a of use) {
    for (const b of zeroBits(a)) bits[b]++;
    if (a.company === 'pair') { pairs++; if (a.code.includes('x')) unknown++; }
    codes.set(a.code, (codes.get(a.code) || 0) + 1);
  }
  const topCodes = [...codes.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([code, n]) => ({ code, n }));
  return { n: use.length, byCategory, byPartner, bits, pairs, unknown, topCodes };
}

export function fmtDuration(min) {
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}
