// Справочники и правила DCL-кода. Общие для экрана ответа, статистики и экспорта.

export const CATEGORIES = [
  ['work', 'Работа'], ['study', 'Учёба'], ['food', 'Еда'], ['road', 'Дорога'], ['home', 'Дом, быт'],
  ['care', 'Забота о близких'], ['sport', 'Спорт, тело'], ['rest', 'Отдых'], ['screen', 'Телефон, экран'],
  ['talk', 'Общение'], ['other', 'Другое'],
];
export const CATEGORY_LABEL = Object.fromEntries(CATEGORIES);

export const PARTNERS = [
  ['partner', 'Партнёр'], ['child', 'Ребёнок'], ['parent', 'Родитель'],
  ['colleague', 'Коллега'], ['friend', 'Друг'], ['other', 'Другой'],
];
export const PARTNER_LABEL = Object.fromEntries(PARTNERS);
export const PARTNER_WITH = {
  partner: 'с партнёром', child: 'с ребёнком', parent: 'с родителем', colleague: 'с коллегой', friend: 'с другом', other: 'с другим человеком',
};

export const COMPANY_LABEL = { alone: 'Один', pair: 'Вдвоём', group: '3 и больше' };

// Порядок разрядов в коде: одиночное D C L, парное D1 C1 D2 C2 L (как в инструкции)
export function codeOf(a) {
  if (a.company === 'pair') return `${a.d1}${a.c1}${a.d2}${a.c2}${a.l}`;
  return `${a.d1}${a.c1}${a.l}`;
}

export const isFull = (code) => /^1+$/.test(code);
export const hasZero = (code) => code.includes('0');
export const hasUnknown = (code) => code.includes('x');

// Эустресс/дистресс по признаку из книги (гл. 11.4): начал сам по желанию и согласен = единицы в D и C
export const isEustress = (a) => a.d1 === 1 && a.c1 === 1;

export const BIT_NAMES = {
  d1: 'не хочу', c1: 'не согласен', l: 'нельзя', d2: 'второй не хочет', c2: 'второй не согласен',
};
export const BIT_SHORT = { d1: 'D', c1: 'C', l: 'L', d2: 'D₂', c2: 'C₂' };

/** Какие разряды равны нулю: ['d1','l', ...] */
export function zeroBits(a) {
  const z = [];
  if (a.d1 === 0) z.push('d1');
  if (a.c1 === 0) z.push('c1');
  if (a.company === 'pair') {
    if (String(a.d2) === '0') z.push('d2');
    if (String(a.c2) === '0') z.push('c2');
  }
  if (a.l === 0) z.push('l');
  return z;
}

const other = (v, yes, no) => (String(v) === '1' ? yes : String(v) === '0' ? no : 'не знаю');

/** Расшифровка кода человеческими словами */
export function decode(a) {
  const me = `${a.d1 ? 'Хочу' : 'Не хочу'}, ${a.c1 ? 'согласен' : 'не согласен'}`;
  const law = a.l ? 'можно' : 'нельзя';
  if (a.company === 'pair') {
    return `${me} · второй: ${other(a.d2, 'хочет', 'не хочет')}, ${other(a.c2, 'согласен', 'не согласен')} · ${law}`;
  }
  return `${me}, ${law}`;
}

/** Расшифровка «голого» кода (для списка частых кодов) */
export function decodeCode(code) {
  const b = code.split('');
  if (b.length === 5) {
    return decode({ company: 'pair', d1: +b[0], c1: +b[1], d2: b[2], c2: b[3], l: +b[4] });
  }
  return decode({ company: 'alone', d1: +b[0], c1: +b[1], l: +b[2] });
}

export function formatCode(code) {
  return code.length === 5 ? `${code.slice(0, 2)} ${code.slice(2, 4)} ${code[4]}` : code;
}

// ---------- мишени: где источник стресса ----------
// Каждое действие с нулями относится к одной мишени (порядок проверки важен).
export const TARGETS = {
  C: {
    name: 'Деньги и «надо»',
    desc: 'Не хочу, но согласен (код 011): действие держится на одном согласии — чаще всего ради денег.',
    advice: 'Мишень экономическая: доход, условия работы, цена вашего времени.',
  },
  L: {
    name: 'Окружение',
    desc: '«Нельзя» (L = 0): действие идёт вразрез с правилами среды.',
    advice: 'Возможно, это не ваше окружение: стоит менять сообщество, место или договорённости.',
  },
  D: {
    name: 'Желание',
    desc: 'Нет желания или оно спорит с разумом (коды 001 и 101).',
    advice: 'Поможет работа с благополучием (well-being) и job crafting: понять, чего вы хотите, и перестроить дела под это.',
  },
  P: {
    name: 'Другой участник',
    desc: 'Вы «за», а второй участник не хочет или не согласен.',
    advice: 'Спросите: «Хочешь?» — и дайте право сказать «нет».',
  },
};
export const TARGET_ORDER = ['C', 'L', 'D', 'P'];

export function targetOf(a) {
  if (a.l === 0) return 'L';
  if (a.d1 === 0 && a.c1 === 1) return 'C';
  if (a.d1 === 0 || a.c1 === 0) return 'D';
  if (a.company === 'pair' && (String(a.d2) === '0' || String(a.c2) === '0')) return 'P';
  return null;
}
