// Расчёты для экранов «Сегодня» и «Анализ». Чистые функции, без DOM.
import { isFull, hasZero, isEustress, zeroBits, CATEGORY_LABEL, codeOf, targetOf, TARGET_ORDER } from './dcl.js';

/** Длина окна бодрствования в минутах */
export function windowMinutes(s) {
  let len = s.wake_end - s.wake_start;
  if (len <= 0) len += 1440;
  return len;
}

/**
 * Основные цифры за период — в штуках действий, время действий не учитывается.
 * Учитываются все отмеченные действия: ответы на сигналы и записи вручную.
 */
export function summarize(answers, pings) {
  const n = answers.length;
  let full = 0, zero = 0, eu = 0;
  for (const a of answers) {
    const c = a.code || codeOf(a);
    if (isFull(c)) full++;
    else if (hasZero(c)) zero++;
    if (isEustress(a)) eu++;
  }
  const unknown = n - full - zero;
  const delivered = pings.filter((p) => !p.test && ['sent', 'answered', 'skipped', 'expired'].includes(p.status));
  const now = Date.now();
  const missed = delivered.filter((p) => p.status === 'skipped' || p.status === 'expired' || (p.status === 'sent' && p.exp < now)).length;
  return {
    n, full, zero, unknown, eustress: eu, distress: n - eu,
    fullShare: n ? full / n : 0,          // доля согласованных действий (111 / 11111)
    zeroShare: n ? zero / n : 0,
    unknownShare: n ? unknown / n : 0,
    euShare: n ? eu / n : 0,
    load: n ? Math.round((zero / n) * 100) : null,   // «нагрузка» 0–100: доля действий с нулями
    delivered: delivered.length, missed,
  };
}

/** Главная мишень: сколько действий приходится на каждую (C, L, D, P) */
export function targetSummary(answers) {
  const counts = { C: 0, L: 0, D: 0, P: 0 };
  for (const a of answers) { const t = targetOf(a); if (t) counts[t]++; }
  const total = TARGET_ORDER.reduce((n, k) => n + counts[k], 0);
  let main = null;
  for (const k of TARGET_ORDER) if (counts[k] && (!main || counts[k] > counts[main])) main = k;
  return { counts, total, main };
}

/** Три оси: сколько раз ответ «да» по D, C, L */
export function axes(answers) {
  const r = { n: answers.length, d1: 0, c1: 0, l: 0 };
  for (const a of answers) { if (a.d1 === 1) r.d1++; if (a.c1 === 1) r.c1++; if (a.l === 1) r.l++; }
  return r;
}

export const DAY_PARTS = [
  ['morning', 'Утро', '5–12'], ['day', 'День', '12–17'], ['evening', 'Вечер', '17–23'], ['night', 'Ночь', '23–5'],
];
const partOf = (h) => (h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'day' : h >= 17 && h < 23 ? 'evening' : 'night');

/** Время суток: без нулей / с нулями */
export function dayParts(answers) {
  const m = Object.fromEntries(DAY_PARTS.map(([k]) => [k, { n: 0, full: 0, zero: 0 }]));
  for (const a of answers) {
    const r = m[partOf(a.local_hour)];
    r.n++;
    if (isFull(a.code)) r.full++; else if (hasZero(a.code)) r.zero++;
  }
  return m;
}

/** Дни с записями, новые сверху */
export function daysList(answers) {
  const m = new Map();
  for (const a of answers) {
    const r = m.get(a.local_date) || { date: a.local_date, n: 0, full: 0, zero: 0 };
    r.n++;
    if (isFull(a.code)) r.full++; else if (hasZero(a.code)) r.zero++;
    m.set(a.local_date, r);
  }
  return [...m.values()].sort((x, y) => (x.date < y.date ? 1 : -1));
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
  const use = answers;
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
