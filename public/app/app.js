// DCL-832 — приложение. Без фреймворков: экраны рисуются строками, события — через data-act.
import { CATEGORIES, CATEGORY_LABEL, PARTNERS, PARTNER_LABEL, PARTNER_WITH, COMPANY_LABEL, codeOf, isFull, hasZero, decode,
  decodeCode, formatCode, BIT_NAMES, BIT_SHORT, zeroBits, L_KINDS, L_KIND_LABEL } from './dcl.js';
import { kvGet, kvSet, put, get, all, since, putMany, clear } from './store.js';
import { api, getCreds, setCreds, ApiError } from './api.js';
import { summarize, targets, zeroCodes, lKinds, axes, dayParts, daysList, DAY_PARTS } from './stats.js';
import { initContact, CONTACT_ROUTES, renderContact, contactAct, contactSubmit, refreshThreads, stopContactPoll,
  loadProfileLocal, applyProfile, onPushMessage } from './contact.js';

const $view = document.getElementById('view');
const $tabs = document.getElementById('tabs');
const $toast = document.getElementById('toast');

const DEVICE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow';
const DEFAULT_SETTINGS = { tz: DEVICE_TZ, wake_start: 480, wake_end: 1380, pings_per_day: 6, consent: false, paused_until: 0, has_push: false };

const S = {
  cfg: { vapidPublicKey: null, answerWindowMin: 30 },
  settings: { ...DEFAULT_SETTINGS },
  onboarded: false,
  customLabels: [],
  ob: null,        // состояние онбординга
  ans: null,       // состояние экрана ответа
  period: 7,
  busy: false,
  profile: null,   // профиль «Связи»: { name } или null (аноним)
};

// ---------- мелочи ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const minToHHMM = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const hhmmToMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const fmtTime = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: S.settings.tz });
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const pct = (x) => `${Math.round(x * 100)}%`;
const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || isIOS();

let installEvt = null; // событие установки PWA (Chrome на Android)
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; if (S.booted && !['answer', 'new'].includes(route().name)) render(); });
window.addEventListener('appinstalled', () => { installEvt = null; toast('Приложение установлено — открывайте его с экрана телефона'); });

function installNotice() {
  if (isStandalone()) return '';
  if (installEvt) return `<button class="notice install" data-act="install"><b>Установите DCL-832 на телефон.</b> Так сигналы приходят надёжнее, а приложение открывается одним касанием. <u>Установить</u></button>`;
  if (isIOS()) return `<div class="notice"><b>Установите DCL-832 на экран «Домой»:</b> «Поделиться» <span class="ico">⬆︎</span> → «На экран „Домой“». На iPhone сигналы приходят только в установленное приложение.</div>`;
  if (isMobile()) return `<div class="notice"><b>Установите DCL-832 на телефон:</b> меню браузера ⋮ → «Установить приложение» (или «Добавить на главный экран»).</div>`;
  return `<div class="notice"><b>DCL-832 рассчитан на телефон.</b> Откройте dcl832.click на смартфоне и установите приложение.</div>`;
}
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

function toast(text) {
  $toast.textContent = text;
  $toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $toast.classList.remove('show'), 2600);
}

function b64uToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
function localParts(t) {
  const p = {};
  const f = new Intl.DateTimeFormat('en-US', { timeZone: S.settings.tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short' });
  for (const { type, value } of f.formatToParts(new Date(t))) p[type] = value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, weekday: WD[p.weekday] };
}
const today = () => localParts(Date.now()).date;
function lastDates(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(localParts(Date.now() - i * 86400_000).date);
  return [...new Set(out)];
}

const PALM = `<svg class="palm" viewBox="0 0 100 100" aria-hidden="true">
  ${[[14, 42], [31, 22], [48, 12], [65, 20], [82, 36]].map(([x, y]) => `<rect x="${x - 6}" y="${y}" width="12" height="${88 - y}" rx="6"/>`).join('')}
</svg>`;

// ---------- сохранение настроек и синхронизация ----------

async function saveSettingsLocal() { await kvSet('settings', S.settings); }

function applyServerUser(u) {
  if (!u) return;
  for (const k of ['wake_start', 'wake_end', 'pings_per_day', 'consent', 'paused_until', 'has_push', 'tz']) if (k in u) S.settings[k] = u[k];
  saveSettingsLocal();
  if ('profile' in u) applyProfile(u.profile);
}

let registering = null;
async function ensureRegistered() {
  if (await getCreds()) return true;
  registering ||= (async () => {
    const { tz, wake_start, wake_end, pings_per_day, consent } = S.settings;
    const r = await api('/api/register', { method: 'POST', auth: false, body: { tz, wake_start, wake_end, pings_per_day, consent } });
    await setCreds({ id: r.id, key: r.key });
    applyServerUser(r.user);
    return true;
  })().finally(() => { registering = null; });
  return registering;
}

async function pushSettings(patch) {
  Object.assign(S.settings, patch);
  await saveSettingsLocal();
  try {
    await ensureRegistered();
    applyServerUser(await api('/api/settings', { method: 'PUT', body: patch }));
    await kvSet('settingsDirty', false);
  } catch (e) {
    await kvSet('settingsDirty', true);
    if (!(e instanceof ApiError) || e.status === 0) toast('Нет связи — настройки сохранятся на сервере позже');
  }
}

async function syncAll() {
  if (!navigator.onLine || !(await getCreds())) return;
  try {
    // анонимно: платформа и «установлено как приложение» — для общей статистики
    const platform = isIOS() ? 'ios' : /Android/i.test(navigator.userAgent) ? 'android' : isMobile() ? 'other' : 'desktop';
    await api('/api/heartbeat', { method: 'POST', body: { platform, standalone: isStandalone() ? 1 : 0 } });
    if (await kvGet('settingsDirty')) {
      const { tz, wake_start, wake_end, pings_per_day, consent } = S.settings;
      applyServerUser(await api('/api/settings', { method: 'PUT', body: { tz, wake_start, wake_end, pings_per_day, consent } }));
      await kvSet('settingsDirty', false);
    }
    // ответы: при согласии — полностью; без согласия — только отметка «сигнал отвечен»
    const answers = await all('answers');
    if (S.settings.consent) {
      const pending = answers.filter((a) => a.synced !== 1);
      for (let i = 0; i < pending.length; i += 100) {
        const chunk = pending.slice(i, i + 100);
        await api('/api/answers', { method: 'POST', body: { answers: chunk.map(({ synced, ...a }) => a) } });
        await putMany('answers', chunk.map((a) => ({ ...a, synced: 1 })));
      }
    } else {
      for (const a of answers.filter((x) => !x.synced && x.source === 'ping' && x.ping_id)) {
        await api(`/api/pings/${a.ping_id}/close`, { method: 'POST', body: { status: 'answered' } });
        await put('answers', { ...a, synced: 2 });
      }
    }
    const pings = await all('pings');
    for (const p of pings.filter((x) => x.status === 'skipped' && !x.closeSynced && !x.test)) {
      await api(`/api/pings/${p.id}/close`, { method: 'POST', body: { status: 'skipped' } });
      await put('pings', { ...p, closeSynced: true });
    }
    // сигналы с сервера (на случай, если уведомление не дошло до приложения)
    const r = await api(`/api/pings?since=${Date.now() - 14 * 86400_000}`);
    const local = new Map(pings.map((p) => [p.id, p]));
    const win = (r.answerWindowMin || S.cfg.answerWindowMin) * 60_000;
    await putMany('pings', r.pings.map((p) => {
      const l = local.get(p.id);
      const status = l && ['answered', 'skipped'].includes(l.status) ? l.status : p.status;
      return { ...l, id: p.id, t: p.t, exp: p.t + win, status };
    }));
    applyServerUser(await api('/api/me'));
    await refreshThreads();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      await setCreds(null); // сервер нас не знает (данные удалены) — зарегистрируемся заново
    }
    console.warn('sync', e);
  }
}

// ---------- push ----------

async function enablePush() {
  if (!pushSupported()) throw new Error('unsupported');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return false;
  if (!S.cfg.vapidPublicKey) S.cfg = await api('/api/config', { auth: false });
  const reg = await navigator.serviceWorker.ready;
  const key = b64uToBytes(S.cfg.vapidPublicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    const cur = sub.options?.applicationServerKey && new Uint8Array(sub.options.applicationServerKey);
    if (cur && cur.join() !== key.join()) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await ensureRegistered();
  applyServerUser(await api('/api/subscribe', { method: 'POST', body: sub.toJSON() }));
  return true;
}

async function pushState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = reg && await reg.pushManager.getSubscription();
  return sub && S.settings.has_push ? 'on' : 'off';
}

// ---------- маршрутизация ----------

function route() {
  const [name, query] = location.hash.replace(/^#/, '').split('?');
  return { name: name || 'today', q: new URLSearchParams(query || '') };
}
function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

async function render() {
  stopContactPoll();
  if (!S.onboarded) { renderOnboarding(); return; }
  const { name, q } = route();
  $tabs.hidden = name === 'answer' || name === 'new' || name === 'feedback';
  const tab = CONTACT_ROUTES.includes(name) ? 'chat' : name;
  for (const a of $tabs.querySelectorAll('a')) a.classList.toggle('on', a.dataset.tab === tab);
  if (CONTACT_ROUTES.includes(name)) return renderContact(name, q);
  if (name === 'answer') return renderAnswer(q);
  if (name === 'new') return renderAnswer(new URLSearchParams());
  if (name === 'stats') return renderStats();
  if (name === 'settings') return renderSettings();
  return renderToday();
}

// ---------- онбординг ----------

function renderOnboarding() {
  $tabs.hidden = true;
  const o = (S.ob ||= { step: 1, wake_start: S.settings.wake_start, wake_end: S.settings.wake_end, pings_per_day: S.settings.pings_per_day, consent: null });
  const dots = `<div class="dots">${[1, 2, 3, 4].map((i) => `<i class="${i === o.step ? 'on' : ''}"></i>`).join('')}</div>`;
  let html = '';
  if (o.step === 1) {
    html = `
      <div class="ob-hero">${PALM}</div>
      <h1 class="ob-title">Хочу · Согласен · Можно</h1>
      <p class="lead">Несколько раз в день, в случайный момент, придёт вопрос: <b>что вы сейчас делаете?</b> Ответ — пара нажатий.</p>
      <ul class="bitlist">
        <li><span class="bit">D</span><div><b>Хочу?</b><small>Желание. Чувства, тело.</small></div></li>
        <li><span class="bit">C</span><div><b>Согласен?</b><small>Разум «за», понимая последствия.</small></div></li>
        <li><span class="bit">L</span><div><b>Можно?</b><small>Правила, место, договорённости.</small></div></li>
      </ul>
      <p class="muted">Ноль в коде — возможный источник стресса. Код без нулей — <b>111</b> (или <b>11111</b> вдвоём) — это согласованное действие.</p>
      <button class="btn primary wide" data-act="ob-next">Начать</button>`;
  } else if (o.step === 2) {
    html = `
      <h1 class="ob-title">Когда спрашивать</h1>
      <p class="lead">Сигналы приходят только в часы бодрствования, в случайные моменты.</p>
      <div class="field-row">
        <label class="field"><span>Просыпаюсь</span><input type="time" id="ob-ws" value="${minToHHMM(o.wake_start)}"></label>
        <label class="field"><span>Ложусь</span><input type="time" id="ob-we" value="${minToHHMM(o.wake_end)}"></label>
      </div>
      <div class="field"><span>Сигналов в день</span>
        <div class="stepper"><button class="btn" data-act="ob-ppd" data-d="-1" aria-label="Меньше">−</button><b>${o.pings_per_day}</b><button class="btn" data-act="ob-ppd" data-d="1" aria-label="Больше">+</button></div>
        <small class="muted">От 3 до 20. 6–8 — хороший баланс: картина складывается примерно за неделю.</small>
      </div>
      <button class="btn primary wide" data-act="ob-next">Дальше</button>`;
  } else if (o.step === 3) {
    html = `
      <h1 class="ob-title">Ваши ответы</h1>
      <p class="lead">Все ответы хранятся на телефоне. Можно ещё и помочь исследованию метода DCL.</p>
      <button class="choice ${o.consent === true ? 'on' : ''}" data-act="ob-consent" data-v="1">
        <b>Передавать анонимно</b>
        <small>Без имени, почты и телефона — только случайный номер устройства. Ответы помогают найти частые паттерны стресса. Отключить и удалить можно в любой момент.</small>
      </button>
      <button class="choice ${o.consent === false ? 'on' : ''}" data-act="ob-consent" data-v="0">
        <b>Только на телефоне</b>
        <small>На сервер уходит лишь расписание сигналов.</small>
      </button>
      <button class="btn primary wide" data-act="ob-next" ${o.consent === null ? 'disabled' : ''}>Дальше</button>`;
  } else {
    const ios = isIOS(), standalone = isStandalone();
    if (ios && !standalone) {
      html = `
        <h1 class="ob-title">Добавьте на экран «Домой»</h1>
        <p class="lead">На iPhone сигналы работают только из установленного приложения.</p>
        <ol class="steps">
          <li>Нажмите <b>«Поделиться»</b> <span class="ico">⬆︎</span> внизу Safari.</li>
          <li>Выберите <b>«На экран „Домой“»</b>.</li>
          <li>Откройте DCL-832 с экрана «Домой» и включите сигналы.</li>
        </ol>
        <p class="muted">Нужен iOS 16.4 или новее.</p>
        <button class="btn ghost wide" data-act="ob-finish">Пока без сигналов</button>`;
    } else if (!pushSupported()) {
      html = `
        <h1 class="ob-title">Сигналы недоступны</h1>
        <p class="lead">Этот браузер не поддерживает push-уведомления. Откройте сайт в Chrome (Android) или Safari (iPhone), или записывайте действия вручную.</p>
        <button class="btn primary wide" data-act="ob-finish">Продолжить</button>`;
    } else {
      html = `
        <h1 class="ob-title">Включите сигналы</h1>
        <p class="lead">Телефон спросит разрешение на уведомления. Без него случайные замеры не придут.</p>
        ${!isStandalone() && installEvt ? '<button class="btn wide" data-act="install">Установить приложение на телефон</button>' : ''}
        <button class="btn primary wide" data-act="ob-push" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Подключаю…' : 'Включить сигналы'}</button>
        <button class="btn ghost wide" data-act="ob-finish">Позже</button>`;
    }
  }
  $view.innerHTML = `<div class="ob">${o.step > 1 ? '<button class="back" data-act="ob-back" aria-label="Назад">←</button>' : ''}${dots}${html}</div>`;
}

async function finishOnboarding() {
  S.onboarded = true;
  await kvSet('onboarded', true);
  S.ob = null;
  go('#today');
  syncAll().then(render);
}

// ---------- экран ответа ----------

function newAnswerState(q) {
  const pingId = q.get('p');
  const test = q.get('test') === '1';
  const t = Number(q.get('t')) || Date.now();
  const exp = Number(q.get('exp')) || (t + S.cfg.answerWindowMin * 60_000);
  return { pingId: test ? null : pingId, test, t, exp, source: pingId && !test ? 'ping' : 'manual',
    category: null, label: null, company: 'alone', partner: null, d1: null, c1: null, l: null, l_kind: null, d2: null, c2: null, adding: false };
}

/** Что ещё не выбрано на экране ответа: [подпись, id блока для прокрутки] */
function answerMissing(a) {
  const m = [];
  if (!a.category) m.push(['что вы делаете', 'blk-what']);
  if (a.company === 'pair' && !a.partner) m.push(['с кем', 'blk-who']);
  if (a.d1 === null) m.push(['«Я хочу?»', 'blk-qs']);
  if (a.c1 === null) m.push(['«Я согласен?»', 'blk-qs']);
  if (a.company === 'pair' && a.d2 === null) m.push(['«Второй хочет?»', 'blk-qs']);
  if (a.company === 'pair' && a.c2 === null) m.push(['«Второй согласен?»', 'blk-qs']);
  if (a.l === null) m.push(['«Можно?»', 'blk-qs']);
  if (a.l === 0 && !a.l_kind) m.push(['что нарушено', 'blk-qs']); // «нельзя» требует уточнения
  return m;
}
const answerComplete = (a) => answerMissing(a).length === 0;

async function renderAnswer(q) {
  const key = q.toString() || 'new';
  if (!S.ans || S.ans.key !== key) {
    S.ans = { ...newAnswerState(q), key };
    if (S.ans.pingId) {
      const existing = (await all('answers')).find((x) => x.ping_id === S.ans.pingId);
      const ping = await get('pings', S.ans.pingId);
      if (existing) S.ans.done = existing;
      else if (ping?.status === 'skipped') S.ans.skipped = true;
    }
  }
  const a = S.ans;
  const now = Date.now();
  const header = a.source === 'ping'
    ? `<div class="ans-time"><span class="pill">Сигнал ${fmtTime(a.t)}</span>${a.exp > now ? `<span class="muted">ещё ${Math.max(1, Math.ceil((a.exp - now) / 60000))} мин</span>` : ''}</div>`
    : `<div class="ans-time"><span class="pill ghost">${a.test ? 'Пробный сигнал' : 'Запись вручную'} · ${fmtTime(a.t)}</span></div>`;

  if (a.done || a.skipped || (a.source === 'ping' && a.exp < now)) {
    const msg = a.done ? `Уже отвечено: <b class="code">${formatCode(a.done.code)}</b>`
      : a.skipped ? 'Этот сигнал пропущен.'
        : `Время ответа вышло: сигнал ждёт ${S.cfg.answerWindowMin} минут, чтобы ответ был о моменте, а не по памяти.`;
    $view.innerHTML = `<div class="answer">${header}<p class="lead">${msg}</p>
      <button class="btn primary wide" data-act="go" data-h="#new">Записать текущее действие</button>
      <button class="btn ghost wide" data-act="go" data-h="#today">На главную</button></div>`;
    return;
  }

  const chips = (items, field, sel) => items.map(([k, label]) =>
    `<button class="chip ${sel === k ? 'on' : ''}" data-act="set" data-f="${field}" data-v="${esc(k)}">${esc(label)}</button>`).join('');
  const customChips = S.customLabels.map((l) =>
    `<button class="chip ${a.category === 'other' && a.label === l ? 'on' : ''}" data-act="label" data-v="${esc(l)}">${esc(l)}</button>`).join('');
  const yn = (field, title, hint, withX = false) => {
    const v = a[field];
    const btn = (val, text, cls) => `<button class="yn ${cls} ${String(v) === String(val) ? 'on' : ''}" data-act="set" data-f="${field}" data-v="${val}">${text}</button>`;
    return `<div class="q-row"><div class="q-text"><b>${title}</b><small>${hint}</small></div>
      <div class="yn-group">${btn(1, 'Да', 'yes')}${btn(0, 'Нет', 'no')}${withX ? btn('x', '?', 'unk') : ''}</div></div>`;
  };
  const code = answerComplete(a) ? codeOf(a) : null;
  const preview = (() => {
    const bits = a.company === 'pair' ? ['d1', 'c1', 'd2', 'c2', 'l'] : ['d1', 'c1', 'l'];
    const cells = bits.map((b, i) => {
      const v = a[b] === null ? '·' : String(a[b]);
      const cls = v === '1' ? 'b1' : v === '0' ? 'b0' : v === 'x' ? 'bx' : '';
      const gap = a.company === 'pair' && (i === 2 || i === 4) ? ' gap' : '';
      return `<span class="${cls}${gap}">${v}</span>`;
    }).join('');
    return `<div class="code-live" aria-live="polite">${cells}</div>
      <div class="decode">${code ? esc(decode(a)) : '&nbsp;'}</div>`;
  })();

  $view.innerHTML = `
    <div class="answer">
      <div class="ans-top">${header}<button class="x" data-act="ans-close" aria-label="Закрыть">✕</button></div>
      <h2 class="q-title" id="blk-what">${a.source === 'ping' ? `Что вы делали в ${fmtTime(a.t)}?` : 'Что вы сейчас делаете?'}</h2>
      <div class="chips">${chips(CATEGORIES, 'category', a.category === 'other' && a.label ? null : a.category)}${customChips}
        <button class="chip add ${a.adding ? 'on' : ''}" data-act="add-label">+ своё</button></div>
      ${a.adding ? `<form class="add-row" data-act="label-form"><input id="label-in" maxlength="40" placeholder="Например: готовлю ужин" autocomplete="off"><button class="btn primary">OK</button></form>` : ''}
      <h3 class="q-sub" id="blk-who">С кем</h3>
      <div class="seg">${Object.entries(COMPANY_LABEL).map(([k, l]) => `<button class="${a.company === k ? 'on' : ''}" data-act="set" data-f="company" data-v="${k}">${l}</button>`).join('')}</div>
      ${a.company === 'pair' ? `<div class="chips small">${chips(PARTNERS, 'partner', a.partner)}</div>` : ''}
      ${a.company === 'group' ? '<p class="muted small-note">В группе оцените только себя.</p>' : ''}
      <div class="qs" id="blk-qs">
        ${yn('d1', 'Я хочу?', 'желание, чувства')}
        ${yn('c1', 'Я согласен?', 'разум «за»')}
        ${a.company === 'pair' ? yn('d2', 'Второй хочет?', '«?» — не знаю', true) + yn('c2', 'Второй согласен?', '«?» — не знаю', true) : ''}
        ${yn('l', 'Можно?', 'закон, правила, нормы')}
        ${a.l === 0 ? `<div class="q-sub-row"><span>Что нарушено?</span><div class="chips small">${L_KINDS.map(([k, label]) =>
          `<button class="chip ${a.l_kind === k ? 'on' : ''}" data-act="set" data-f="l_kind" data-v="${k}">${label}</button>`).join('')}</div></div>` : ''}
      </div>
      ${preview}
      ${code ? '' : `<p class="missing">Осталось выбрать: ${answerMissing(a).map(([t]) => t).join(', ')}</p>`}
      <button class="btn primary wide big ${code ? '' : 'incomplete'}" data-act="save">Готово</button>
      ${a.source === 'ping' ? '<button class="btn ghost wide" data-act="skip">Пропустить сигнал</button>' : ''}
    </div>`;
  if (a.adding) document.getElementById('label-in')?.focus();
}

async function saveAnswer() {
  const a = S.ans;
  const typed = a.adding && document.getElementById('label-in')?.value.trim().slice(0, 40);
  if (typed) { // ввели своё действие, но не нажали OK
    S.customLabels = [typed, ...S.customLabels.filter((x) => x !== typed)].slice(0, 8);
    kvSet('customLabels', S.customLabels);
    Object.assign(a, { category: 'other', label: typed, adding: false });
  }
  const missing = answerMissing(a);
  if (missing.length) {
    toast(`Осталось выбрать: ${missing.map(([t]) => t).join(', ')}`);
    renderAnswer(route().q);
    document.getElementById(missing[0][1])?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const now = Date.now();
  const lp = localParts(a.t);
  const rec = {
    id: crypto.randomUUID(), ping_id: a.pingId, source: a.source, t: a.t, answered_at: now,
    local_date: lp.date, local_hour: lp.hour, weekday: lp.weekday,
    category: a.category, label: a.category === 'other' ? a.label : null,
    company: a.company, partner: a.company === 'pair' ? a.partner : null,
    d1: a.d1, c1: a.c1, l: a.l, l_kind: a.l === 0 ? a.l_kind : null,
    d2: a.company === 'pair' ? String(a.d2) : null, c2: a.company === 'pair' ? String(a.c2) : null,
    synced: 0,
  };
  rec.code = codeOf(rec);
  await put('answers', rec);
  if (a.pingId) {
    const p = (await get('pings', a.pingId)) || { id: a.pingId, t: a.t, exp: a.exp };
    await put('pings', { ...p, status: 'answered' });
  }
  S.ans = null;
  toast(`Сохранено · ${formatCode(rec.code)}`);
  go('#today');
  syncAll();
}

// ---------- «Сегодня» ----------

function loadBar(s) {
  if (!s.n) return '<div class="bar empty"></div>';
  return `<div class="bar" role="img" aria-label="Без нулей ${pct(s.fullShare)}, с нулями ${pct(s.zeroShare)}">
    <i class="b1" style="width:${s.fullShare * 100}%"></i><i class="bx" style="width:${s.unknownShare * 100}%"></i><i class="b0" style="width:${s.zeroShare * 100}%"></i></div>
    <div class="legend"><span><i class="dot b1"></i>без нулей — ${s.full}</span><span><i class="dot b0"></i>с нулями — ${s.zero}</span>${s.unknown ? `<span><i class="dot bx"></i>неясно — ${s.unknown}</span>` : ''}</div>`;
}

const ofActions = (n) => plural(n, 'действия', 'действий', 'действий');

function summaryCards(s, period) {
  return `
    <section class="card hero">
      <div class="label">Уровень свободы${period ? ' за период' : ' сегодня'}</div>
      <div class="big">${s.n ? pct(s.fullShare) : '—'}</div>
      <div class="sub">${s.n ? `${s.full} из ${s.n} ${ofActions(s.n)} без нулей (111 или 11111)` : 'Пока нет отмеченных действий'}</div>
      ${loadBar(s)}
    </section>
    <section class="grid2">
      <div class="card"><div class="label">Нагрузка</div><div class="mid">${s.load ?? '—'}<span>${s.load === null ? '' : '/100'}</span></div>
        <div class="sub">${s.n ? `${s.zero} из ${s.n} ${ofActions(s.n)} с нулями` : 'доля действий с нулями'}</div></div>
      <div class="card"><div class="label">Эустресс / дистресс</div><div class="mid">${s.n ? `${s.eustress}<span> / ${s.distress}</span>` : '—'}</div>
        <div class="sub">«хочу и согласен» / нет</div></div>
    </section>`;
}

async function renderToday() {
  const date = today();
  const start = Date.now() - 36 * 3600_000;
  const [answers, pings] = await Promise.all([since('answers', start), since('pings', start)]);
  const todays = answers.filter((a) => a.local_date === date);
  const todaysPings = pings.filter((p) => localParts(p.t).date === date);
  const s = summarize(todays, todaysPings, S.settings);
  const now = Date.now();
  const answeredIds = new Set(answers.map((a) => a.ping_id).filter(Boolean));
  const pending = pings.filter((p) => !p.test && p.status !== 'answered' && p.status !== 'skipped' && !answeredIds.has(p.id) && p.exp > now && p.t <= now);
  const missed = todaysPings.filter((p) => !p.test && !answeredIds.has(p.id) && (p.status === 'skipped' || p.status === 'expired' || p.exp <= now));

  const rows = [
    ...todays.map((a) => ({ t: a.t, html: `<li><time>${fmtTime(a.t)}</time><div><b>${esc(a.label || CATEGORY_LABEL[a.category])}</b>
      <small>${a.company === 'pair' ? esc(PARTNER_WITH[a.partner] || '') + ' · ' : a.company === 'group' ? 'в группе · ' : ''}${esc(decode(a))}${a.source === 'manual' ? ' · вручную' : ''}</small></div>
      <span class="code ${isFull(a.code) ? 'full' : hasZero(a.code) ? 'zero' : 'unk'}">${formatCode(a.code)}</span></li>` })),
    ...missed.map((p) => ({ t: p.t, html: `<li class="missed"><time>${fmtTime(p.t)}</time><div><b>Сигнал пропущен</b></div><span class="code">—</span></li>` })),
  ].sort((x, y) => y.t - x.t);

  const paused = S.settings.paused_until > now;
  const notice = !S.settings.has_push
    ? `<button class="notice" data-act="go" data-h="#settings"><b>Сигналы выключены.</b> Включите их в настройках, чтобы приходили случайные замеры.</button>`
    : paused ? `<button class="notice" data-act="resume"><b>Пауза до ${fmtTime(S.settings.paused_until)}.</b> Нажмите, чтобы возобновить.</button>` : '';

  $view.innerHTML = `
    <header class="top"><div class="brand">${PALM}<span>DCL-832</span></div><div class="muted">${new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: S.settings.tz })}</div></header>
    ${installNotice()}
    ${notice}
    ${pending.map((p) => `<button class="pending" data-act="go" data-h="#answer?p=${p.id}&t=${p.t}&exp=${p.exp}">
      <span><b>Сигнал ${fmtTime(p.t)} ждёт ответа</b><small>ещё ${Math.max(1, Math.ceil((p.exp - now) / 60000))} мин</small></span><span class="arrow">Ответить →</span></button>`).join('')}
    ${summaryCards(s, false)}
    <section class="card">
      <div class="card-head"><h2>День</h2><span class="muted">${(() => {
        const came = todaysPings.filter((p) => !p.test && p.t <= now).length;
        return came ? `отвечено сигналов: ${todays.filter((x) => x.source === 'ping').length} из ${came}` : '';
      })()}</span></div>
      ${rows.length ? `<ul class="timeline">${rows.map((r) => r.html).join('')}</ul>`
        : `<p class="muted">Первый сигнал придёт в случайный момент. Можно не ждать — запишите текущее действие кнопкой «+».</p>`}
    </section>
    <button class="fab" data-act="go" data-h="#new" aria-label="Записать действие">+</button>`;
}

// ---------- «Анализ» ----------

const capFirst = (x) => x.charAt(0).toUpperCase() + x.slice(1);
function dateLabel(d) {
  const [y, m, dd] = d.split('-').map(Number);
  return capFirst(new Date(Date.UTC(y, m - 1, dd, 12)).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' }));
}
/** Полоса «без нулей / неясно / с нулями» с зазорами 2px; подпись — всегда числами рядом */
function stack(full, unknown, zero, title) {
  const n = full + unknown + zero;
  if (!n) return '<div class="stack empty"></div>';
  const seg = (v, cls) => (v ? `<i class="${cls}" style="flex:${v}"></i>` : '');
  return `<div class="stack" role="img" aria-label="${esc(title)}" title="${esc(title)}">${seg(full, 'b1')}${seg(unknown, 'bx')}${seg(zero, 'b0')}</div>`;
}
/** Индикатор «k из n» */
function meter(k, n, cls, title) {
  return `<div class="meter" role="img" aria-label="${esc(title)}" title="${esc(title)}"><i class="${cls}" style="width:${n ? (k / n) * 100 : 0}%"></i></div>`;
}

async function renderStats() {
  const days = S.period || 3650;
  const startMs = Date.now() - days * 86400_000;
  const [answersAll, pings] = await Promise.all([since('answers', startMs), since('pings', startMs)]);
  const dates = S.period ? lastDates(S.period) : null;
  const answers = dates ? answersAll.filter((a) => a.local_date >= dates[0]) : answersAll;
  const s = summarize(answers, pings);
  const tg = targets(answers);
  const ax = axes(answers);
  const parts = dayParts(answers);
  const dayRows = daysList(answers);
  const n = s.n;

  const zc = zeroCodes(answers);
  const lk = lKinds(answers);
  const codesCard = !n ? '' : `<section class="card">
    <h2>Коды с нулями: разово или регулярно</h2>
    <p class="muted small-note">«Регулярно» — код встречался в двух и более разных днях за период.</p>
    ${zc.length ? `<ul class="zcodes">${zc.map((c) => `<li>
      <span class="code zero">${formatCode(c.code)}</span>
      <span class="zc-text"><b>${esc(decodeCode(c.code))}</b><small>${c.n} ${plural(c.n, 'раз', 'раза', 'раз')} · в ${c.days} ${plural(c.days, 'дне', 'днях', 'днях')}</small></span>
      <span class="badge ${c.regular ? 'reg' : ''}">${c.regular ? 'регулярно' : 'разово'}</span></li>`).join('')}</ul>`
      : '<p>Кодов с нулями нет: все отмеченные действия — 111 или 11111.</p>'}
  </section>`;

  const axisRows = [['d1', 'D', 'хочу'], ['c1', 'C', 'согласен'], ['l', 'L', 'можно']].map(([k, letter, name]) => `
    <li><span class="bit">${letter}</span><span class="name">${name}</span>${meter(ax[k], n, 'b1', `${name}: «да» в ${ax[k]} из ${n}`)}<b>${ax[k]} из ${n}</b></li>`).join('');

  const catRows = tg.byCategory.slice(0, 6).map((g) => `
    <li><div class="row-head"><b>${esc(g.label)}</b><span>${g.zero} из ${g.n} с нулями</span></div>
      ${stack(g.full, g.n - g.full - g.zero, g.zero, `${g.label}: без нулей ${g.full}, с нулями ${g.zero}`)}
      ${g.top ? `<small>чаще всего: <b>${BIT_NAMES[g.top]}</b> (${BIT_SHORT[g.top]}=0)</small>` : '<small>нулей нет</small>'}</li>`).join('');
  const partRows = tg.byPartner.map((g) => `
    <li><div class="row-head"><b>${esc(PARTNER_LABEL[g.key] || g.key)}</b><span>${g.n - g.full} из ${g.n} не 11111</span></div>
      ${stack(g.full, g.n - g.full - g.zero, g.zero, `${PARTNER_LABEL[g.key] || g.key}: 11111 — ${g.full}, с нулями — ${g.zero}`)}
      <small>${g.top ? `чаще всего: <b>${BIT_NAMES[g.top]}</b>` : 'нулей нет'}${g.unknown ? ` · не знаю о втором: ${g.unknown}` : ''}</small></li>`).join('');

  const partRowsTime = DAY_PARTS.filter(([k]) => parts[k].n).map(([k, name, hours]) => {
    const p = parts[k];
    return `<li><div class="row-head"><b>${name} <span class="muted">${hours}</span></b><span>${p.full} без нулей · ${p.zero} с нулями</span></div>
      ${stack(p.full, p.n - p.full - p.zero, p.zero, `${name}: без нулей ${p.full}, с нулями ${p.zero}`)}</li>`;
  }).join('');

  const dayList = dayRows.map((d) => `
    <li><div class="row-head"><b>${dateLabel(d.date)}</b><span>${d.full} из ${d.n} без нулей</span></div>
      ${stack(d.full, d.n - d.full - d.zero, d.zero, `${dateLabel(d.date)}: без нулей ${d.full}, с нулями ${d.zero}`)}</li>`).join('');

  $view.innerHTML = `
    <header class="top"><h1>Анализ</h1></header>
    <div class="seg period">${[[7, '7 дней'], [30, '30 дней'], [0, 'Всё время']].map(([v, l]) => `<button class="${S.period === v ? 'on' : ''}" data-act="period" data-v="${v}">${l}</button>`).join('')}</div>
    ${summaryCards(s, true)}
    ${s.delivered ? `<p class="muted center">Сигналов: ${s.delivered} · пропущено: ${s.missed}</p>` : ''}
    ${codesCard}
    ${n ? `<section class="card"><h2>Три оси</h2><p class="muted small-note">Сколько раз вы ответили «да» на каждый вопрос.</p><ul class="axes">${axisRows}</ul>
      ${ax.l < n ? `<p class="small-note lk">«Нельзя» (${n - ax.l}): закон — ${lk.law}, правила места или работы — ${lk.rules}, нормы круга — ${lk.norms}${lk.none ? `, не уточнено — ${lk.none}` : ''}</p>` : ''}</section>` : ''}
    <section class="card">
      <h2>Где нули</h2>
      ${catRows ? `<ul class="rows">${catRows}</ul>` : '<p class="muted">Появятся после первых ответов.</p>'}
    </section>
    ${tg.pairs ? `<section class="card"><h2>С кем</h2><ul class="rows">${partRows}</ul>
      ${tg.unknown ? `<p class="muted small-note">В ${tg.unknown} из ${tg.pairs} совместных действий ответ о втором участнике — «не знаю».</p>` : ''}</section>` : ''}
    ${partRowsTime ? `<section class="card"><h2>Когда нули</h2><ul class="rows">${partRowsTime}</ul>
      ${n < 10 ? '<p class="muted small-note">Картина станет надёжнее после 10–15 ответов.</p>' : ''}</section>` : ''}
    ${dayList ? `<section class="card"><h2>По дням</h2><ul class="rows">${dayList}</ul>
      <div class="legend"><span><i class="dot b1"></i>без нулей</span><span><i class="dot b0"></i>с нулями</span>${s.unknown ? '<span><i class="dot bx"></i>неясно</span>' : ''}</div></section>` : ''}
    ${tg.topCodes.length ? `<section class="card"><h2>Частые коды</h2><ul class="codes">${tg.topCodes.map((c) => `
      <li><span class="code ${isFull(c.code) ? 'full' : hasZero(c.code) ? 'zero' : 'unk'}">${formatCode(c.code)}</span><span>${esc(decodeCode(c.code))}</span><b>×${c.n}</b></li>`).join('')}</ul></section>` : ''}
    <section class="card"><h2>Разобраться в результатах</h2>
      <p class="muted small-note">Приложение показывает только факты. Что они значат для вас и что можно изменить — обсудите со специалистом.</p>
      <button class="btn primary wide" data-act="go" data-h="#book">Записаться на консультацию · бесплатно</button>
      <button class="btn wide" data-act="go" data-h="#chat?new=specialist">Задать вопрос специалисту</button>
      <a class="btn wide link" href="/books/potok-lyubvi.pdf" target="_blank" rel="noopener">Прочитать «Поток любви» — пособие по DCL (PDF)</a></section>
    <p class="muted small-note center">Цель DCL-терапии — заменить действия с нулями так, чтобы результат сохранился, а действия стали 111 или 11111.<br>Это инструмент самонаблюдения, не медицинская диагностика.</p>`;
}

// ---------- «Настройки» ----------

async function renderSettings() {
  const st = await pushState();
  const now = Date.now();
  const paused = S.settings.paused_until > now;
  const pushBlock = {
    on: `<p class="ok">● Сигналы включены</p><button class="btn wide" data-act="test-ping">Прислать пробный сигнал</button>`,
    off: isIOS() && !isStandalone()
      ? `<p class="muted">На iPhone сначала добавьте приложение на экран «Домой» (Поделиться → На экран «Домой»), затем откройте его оттуда.</p>`
      : `<button class="btn primary wide" data-act="enable-push" ${S.busy ? 'disabled' : ''}>${S.busy ? 'Подключаю…' : 'Включить сигналы'}</button>`,
    denied: `<p class="muted">Уведомления запрещены в настройках браузера или телефона. Разрешите их для dcl832.click и вернитесь сюда.</p>`,
    unsupported: `<p class="muted">Этот браузер не поддерживает push. Откройте сайт в Chrome (Android) или Safari (iPhone).</p>`,
  }[st];

  $view.innerHTML = `
    <header class="top"><h1>Настройки</h1></header>
    <section class="card"><h2>Сигналы</h2>${pushBlock}
      ${st === 'on' ? `<div class="pause">${paused ? `<p>Пауза до <b>${fmtTime(S.settings.paused_until)}</b></p><button class="btn" data-act="resume">Возобновить</button>`
        : `<span class="muted">Не беспокоить:</span><button class="btn" data-act="pause" data-m="120">2 часа</button><button class="btn" data-act="pause-morning">до утра</button>`}</div>` : ''}
    </section>
    <section class="card"><h2>Расписание</h2>
      <div class="field-row">
        <label class="field"><span>Просыпаюсь</span><input type="time" id="st-ws" value="${minToHHMM(S.settings.wake_start)}"></label>
        <label class="field"><span>Ложусь</span><input type="time" id="st-we" value="${minToHHMM(S.settings.wake_end)}"></label>
      </div>
      <div class="field"><span>Сигналов в день</span>
        <div class="stepper"><button class="btn" data-act="ppd" data-d="-1" aria-label="Меньше">−</button><b>${S.settings.pings_per_day}</b><button class="btn" data-act="ppd" data-d="1" aria-label="Больше">+</button></div></div>
      <p class="muted small-note">Часовой пояс: ${esc(S.settings.tz)}. Моменты сигналов случайны и заранее не показываются.</p>
    </section>
    <section class="card"><h2>Исследование</h2>
      <label class="switch"><input type="checkbox" id="st-consent" ${S.settings.consent ? 'checked' : ''}><span></span>
        <div><b>Передавать ответы анонимно</b><small>Без имени, почты и телефона. Помогает находить частые паттерны стресса.</small></div></label>
    </section>
    <section class="card"><h2>Данные</h2>
      <button class="btn wide" data-act="export">Скачать мои ответы (CSV)</button>
      <button class="btn danger wide" data-act="wipe">Удалить все данные</button>
    </section>
    <section class="card about"><h2>О методе</h2>
      <p><b>D</b> — желание, <b>C</b> — согласие, <b>L</b> — разрешение среды. Один — 3 знака, вдвоём — 5: D₁ C₁ D₂ C₂ L. Код с нулями — стресс в самом действии.</p>
      <p>Эустресс — действие, которое вы начали сами по желанию и с согласием (D=1, C=1). Связь кодов с аллостатической нагрузкой — гипотеза модели, а не медицинское измерение.</p>
      <p><a href="/" target="_blank">О диагностике</a> · <a href="/#books" target="_blank">Книги</a> · <a href="https://t.me/DCL832" target="_blank" rel="noopener">Канал</a> · <a href="#chat">Связь и консультация</a> · <a href="/privacy/" target="_blank">Конфиденциальность</a></p>
    </section>`;
}

async function exportCsv() {
  const rows = (await all('answers')).sort((a, b) => a.t - b.t);
  const cols = ['local_date', 'time', 'source', 'category', 'label', 'company', 'partner', 'd1', 'c1', 'd2', 'c2', 'l', 'code', 'decode'];
  const escCsv = (v) => (v == null ? '' : /[",;\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [cols.join(';'), ...rows.map((a) => [a.local_date, fmtTime(a.t), a.source, CATEGORY_LABEL[a.category], a.label, COMPANY_LABEL[a.company],
    a.partner ? PARTNER_LABEL[a.partner] : '', a.d1, a.c1, a.d2, a.c2, a.l, `'${a.code}`, decode(a)].map(escCsv).join(';'))];
  const file = new File(['﻿' + lines.join('\n')], `dcl832-${today()}.csv`, { type: 'text/csv' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'DCL-832' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const link = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function wipe() {
  if (!confirm('Удалить все ответы, переписку и профиль — с телефона и с сервера? Это нельзя отменить.')) return;
  try { if (await getCreds()) await api('/api/me', { method: 'DELETE' }); } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) { toast('Нет связи с сервером — попробуйте позже'); return; }
  }
  try { const reg = await navigator.serviceWorker.getRegistration('/'); const sub = await reg?.pushManager.getSubscription(); await sub?.unsubscribe(); } catch {}
  await Promise.all([clear('answers'), clear('pings'), clear('kv')]);
  location.replace('/app/');
}

// ---------- события ----------

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'FORM') return;
  const act = el.dataset.act;
  if (act.startsWith('c-') && await contactAct(act, el)) return;
  const o = S.ob, a = S.ans;
  switch (act) {
    case 'go': if (el.dataset.h === '#new') S.ans = null; go(el.dataset.h); break;
    case 'install':
      if (installEvt) { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; }
      render(); break;
    // онбординг
    case 'ob-back': o.step--; renderOnboarding(); break;
    case 'ob-next':
      if (o.step === 2) {
        o.wake_start = hhmmToMin(document.getElementById('ob-ws').value || '08:00');
        o.wake_end = hhmmToMin(document.getElementById('ob-we').value || '23:00');
      }
      if (o.step === 3) {
        Object.assign(S.settings, { wake_start: o.wake_start, wake_end: o.wake_end, pings_per_day: o.pings_per_day, consent: o.consent, tz: DEVICE_TZ });
        await saveSettingsLocal();
        ensureRegistered().catch(() => {});
      }
      o.step++; renderOnboarding(); break;
    case 'ob-ppd': o.pings_per_day = Math.max(3, Math.min(20, o.pings_per_day + Number(el.dataset.d))); renderOnboarding(); break;
    case 'ob-consent': o.consent = el.dataset.v === '1'; renderOnboarding(); break;
    case 'ob-push':
      S.busy = true; renderOnboarding();
      try {
        const ok = await enablePush();
        toast(ok ? 'Сигналы включены' : 'Без разрешения сигналы не придут — включите позже в настройках');
      } catch (err) { console.warn(err); toast('Не удалось подключить сигналы — попробуйте в настройках'); }
      S.busy = false; await finishOnboarding(); break;
    case 'ob-finish': await finishOnboarding(); break;
    // ответ
    case 'set': {
      const f = el.dataset.f;
      let v = el.dataset.v;
      if (['d1', 'c1', 'l'].includes(f)) v = Number(v);
      else if (['d2', 'c2'].includes(f)) v = v === 'x' ? 'x' : Number(v);
      a[f] = v;
      if (f === 'category') { a.label = null; a.adding = false; }
      if (f === 'company' && v !== 'pair') { a.partner = null; a.d2 = null; a.c2 = null; }
      if (f === 'l' && v === 1) a.l_kind = null;
      renderAnswer(route().q); break;
    }
    case 'label': a.category = 'other'; a.label = el.dataset.v; a.adding = false; renderAnswer(route().q); break;
    case 'add-label': a.adding = !a.adding; renderAnswer(route().q); break;
    case 'save': await saveAnswer(); break;
    case 'skip':
      if (a.pingId) {
        const p = (await get('pings', a.pingId)) || { id: a.pingId, t: a.t, exp: a.exp };
        await put('pings', { ...p, status: 'skipped' });
        syncAll();
      }
      S.ans = null; go('#today'); break;
    case 'ans-close': S.ans = null; go('#today'); break;
    // анализ
    case 'period': S.period = Number(el.dataset.v); renderStats(); break;
    // настройки
    case 'enable-push':
      S.busy = true; renderSettings();
      try { toast((await enablePush()) ? 'Сигналы включены' : 'Разрешение не получено'); } catch (err) { console.warn(err); toast('Не удалось подключить сигналы'); }
      S.busy = false; renderSettings(); break;
    case 'test-ping':
      try { const r = await api('/api/test-ping', { method: 'POST' }); toast(r.ok ? 'Пробный сигнал отправлен' : 'Push-сервис не принял сигнал'); } catch { toast('Нет связи с сервером'); }
      break;
    case 'pause': case 'pause-morning': case 'resume':
      try {
        const body = act === 'pause' ? { minutes: Number(el.dataset.m) } : act === 'pause-morning' ? { until_morning: true } : { minutes: 0 };
        applyServerUser(await api('/api/pause', { method: 'POST', body }));
      } catch { toast('Нет связи с сервером'); }
      render(); break;
    case 'ppd':
      await pushSettings({ pings_per_day: Math.max(3, Math.min(20, S.settings.pings_per_day + Number(el.dataset.d))) });
      renderSettings(); break;
    case 'export': exportCsv(); break;
    case 'wipe': wipe(); break;
  }
});

document.addEventListener('submit', (e) => {
  const cf = e.target.closest('form[data-act^="c-"]');
  if (cf) { e.preventDefault(); contactSubmit(cf); return; }
  const f = e.target.closest('[data-act="label-form"]');
  if (!f) return;
  e.preventDefault();
  const v = document.getElementById('label-in').value.trim().slice(0, 40);
  if (!v) return;
  S.customLabels = [v, ...S.customLabels.filter((x) => x !== v)].slice(0, 8);
  kvSet('customLabels', S.customLabels);
  Object.assign(S.ans, { category: 'other', label: v, adding: false });
  renderAnswer(route().q);
});

document.addEventListener('change', async (e) => {
  const id = e.target.id;
  if (id === 'ob-ws' || id === 'ob-we') return;
  if (id === 'st-ws' || id === 'st-we') {
    await pushSettings({ [id === 'st-ws' ? 'wake_start' : 'wake_end']: hhmmToMin(e.target.value) });
    toast('Расписание обновлено');
  }
  if (id === 'st-consent') {
    const on = e.target.checked;
    if (!on && confirm('Удалить с сервера уже переданные ответы?')) {
      try { await api('/api/answers', { method: 'DELETE' }); await putMany('answers', (await all('answers')).map((a) => ({ ...a, synced: 0 }))); } catch { toast('Нет связи — удалите позже'); }
    }
    await pushSettings({ consent: on });
    if (on) syncAll();
    renderSettings();
  }
});

window.addEventListener('hashchange', render);
window.addEventListener('online', () => syncAll().then(render));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.onboarded && !['answer', 'new'].includes(route().name)) syncAll().then(render);
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open') { S.ans = null; location.hash = e.data.hash; }
    if (e.data?.type === 'ping' && route().name === 'today') render();
    if (e.data?.type === 'msg') onPushMessage();
  });
}

// ---------- запуск ----------

initContact({ S, $view, esc, toast, go, route, render, ensureRegistered, lastDates, plural, pct, applyServerUser });

(async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e) => console.warn('sw', e));
  await loadProfileLocal();
  const [settings, onboarded, labels, cfg] = await Promise.all([kvGet('settings'), kvGet('onboarded'), kvGet('customLabels'), kvGet('cfg')]);
  if (settings) S.settings = { ...DEFAULT_SETTINGS, ...settings };
  S.onboarded = !!onboarded;
  S.customLabels = labels || [];
  if (cfg) S.cfg = cfg;
  S.booted = true;
  render();
  try { S.cfg = await api('/api/config', { auth: false }); kvSet('cfg', S.cfg); } catch {}
  if (S.onboarded) {
    if (S.settings.tz !== DEVICE_TZ) await pushSettings({ tz: DEVICE_TZ });
    if (!(await getCreds())) {
      try {
        await ensureRegistered();
        if (window.Notification?.permission === 'granted') await enablePush();
      } catch {}
    }
    await syncAll();
    if (!['answer', 'new'].includes(route().name)) render();
  }
})();
