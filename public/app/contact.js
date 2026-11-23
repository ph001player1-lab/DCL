// «Связь»: техподдержка, идеи «настроить под себя», вопрос специалисту, профиль (имя + код входа),
// «Приложить мою неделю» (только с профилем) и запись на бесплатную консультацию по календарю специалиста.
import { kvGet, kvSet, since } from './store.js';
import { api, ApiError, getCreds } from './api.js';
import { summarize, zeroCodes, lKinds, axes, dayParts, targets, DAY_PARTS } from './stats.js';
import { PARTNER_LABEL, BIT_NAMES, decodeCode, formatCode } from './dcl.js';

let C; // помощники приложения: S, $view, esc, toast, go, route, render, ensureRegistered, lastDates, plural, pct
export function initContact(ctx) { C = ctx; }
export const CONTACT_ROUTES = ['chat', 'report', 'book', 'profile', 'feedback'];

const TOPIC_TITLE = { support: 'Техподдержка', idea: 'Идея: настроить под себя', specialist: 'Вопрос специалисту', feedback: 'Отзыв: что улучшить' };
const TOPIC_SHORT = { support: 'Техподдержка', idea: 'Идея', specialist: 'Специалист', feedback: 'Отзыв' };
const ADMIN_NAME = { support: 'Поддержка', idea: 'Команда DCL-832', specialist: 'Специалист', feedback: 'Команда DCL-832' };
const STATUS_LABEL = {
  support: { new: 'отправлено', open: 'в работе', done: 'решено' },
  idea: { new: 'отправлена', accepted: 'принята', in_progress: 'в работе', done: 'сделана', declined: 'пока не в планах' },
  specialist: { new: 'отправлено', open: 'идёт разговор', done: 'завершено' },
  feedback: { new: 'отправлен', open: 'в работе', done: 'учтён' },
};
// «Помогите нам стать лучше» — для тех, кто перестал отвечать на сигналы
const FB_REASONS = [['often', 'Сигналы приходят слишком часто'], ['time', 'Приходят в неудобное время'], ['forget', 'Забываю или не замечаю уведомления'],
  ['unclear', 'Непонятно, что дают ответы'], ['hard', 'Отвечать долго или сложно'], ['nouse', 'Не увидел пользы для себя'],
  ['break', 'Просто перерыв — вернусь позже'], ['other', 'Другое']];
const FB_ACTIONS = [['fewer', 'Реже — 3 сигнала в день'], ['pause', 'Пауза на неделю'], ['off', 'Выключить сигналы']];
const NEW_TEXT = {
  idea: {
    lead: 'Чего не хватает? Своя категория, вопрос, вид отчёта, время сигналов — опишите, как вам было бы удобно. Лучшие идеи сделаем для всех, а часть настроим лично для вас.',
    ph: 'Например: хочу отмечать, где я нахожусь — дома, на работе, в дороге',
  },
  support: { lead: 'Опишите, что случилось и на каком телефоне. Ответ придёт сюда и уведомлением.', ph: 'Например: на iPhone не приходят сигналы' },
  specialist: { lead: 'Спросите, как понять ваши коды, и обсудите варианты решений. Можно анонимно.', ph: 'Например: что делать, если на работе часто 011?' },
};
const CRISIS = '<p class="hint">Это не экстренная помощь. Если вам очень тяжело прямо сейчас — звоните <a href="tel:112">112</a>.</p>';

// ---------- состояние ----------

const st = { threads: null, unread: 0, thread: null, slots: null, pick: null, newCode: null, reportDays: 7, sending: false, fb: { reasons: new Set(), action: null } };
let poll = null;
export function stopContactPoll() { if (poll) { clearInterval(poll); poll = null; } }

function setBadge() {
  const b = document.getElementById('chat-badge');
  if (!b) return;
  b.hidden = !st.unread;
  b.textContent = st.unread > 9 ? '9+' : String(st.unread || '');
}

/** Список переписок и непрочитанные — для значка на вкладке */
export async function refreshThreads() {
  if (!navigator.onLine || !(await getCreds())) return;
  try {
    const r = await api('/api/threads');
    st.threads = r.threads; st.unread = r.unread;
    setBadge();
  } catch (e) { console.warn('threads', e); }
}

export async function loadProfileLocal() { C.S.profile = (await kvGet('profile')) || null; }
export function applyProfile(p) {
  if (p === undefined) return;
  const changed = JSON.stringify(C.S.profile || null) !== JSON.stringify(p || null);
  C.S.profile = p || null;
  kvSet('profile', C.S.profile);
  if (!p) kvSet('profileCode', null);
  if (changed) st.threads = null;
}

// ---------- форматирование ----------

const tz = () => C.S.settings.tz;
const nl2br = (s) => C.esc(s).replace(/\n/g, '<br>');
const safeUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null);
function when(t, opts) { return new Date(t).toLocaleString('ru-RU', { timeZone: tz(), ...opts }); }
const dayLabel = (t) => { const s = when(t, { weekday: 'short', day: 'numeric', month: 'long' }); return s.charAt(0).toUpperCase() + s.slice(1); };
const hm = (t) => when(t, { hour: '2-digit', minute: '2-digit' });
const span = (a, b) => `${dayLabel(a)}, ${hm(a)}–${hm(b)}`;
function ago(t) {
  const d = Date.now() - t;
  if (d < 60_000) return 'только что';
  if (d < 3600_000) return `${Math.round(d / 60_000)} мин назад`;
  const today = new Date().toLocaleDateString('ru-RU', { timeZone: tz() });
  return new Date(t).toLocaleDateString('ru-RU', { timeZone: tz() }) === today ? hm(t) : when(t, { day: 'numeric', month: 'short' });
}
const back = (h) => `<div class="ans-top"><button class="x" data-act="go" data-h="${h}" aria-label="Назад">←</button></div>`;

/** Снимок «моя неделя»: только числа и коды, без отдельных записей и времени */
function buildReport(answers, days) {
  const s = summarize(answers, []);
  const tg = targets(answers);
  const dates = C.lastDates(days);
  return {
    v: 1, days, from: dates[0], to: dates.at(-1), n: s.n, full: s.full, zero: s.zero, unknown: s.unknown,
    zero_codes: zeroCodes(answers).slice(0, 12), l_kinds: lKinds(answers), axes: axes(answers),
    by_category: tg.byCategory.slice(0, 8).map((g) => ({ label: g.label, n: g.n, zero: g.zero, full: g.full, top: g.top })),
    by_partner: tg.byPartner.map((g) => ({ label: PARTNER_LABEL[g.key] || g.key, n: g.n, zero: g.zero, full: g.full, unknown: g.unknown })),
    day_parts: Object.fromEntries(DAY_PARTS.map(([k]) => [k, dayParts(answers)[k]])),
  };
}

/** Снимок недели в виде карточки (предпросмотр и сообщение в переписке) */
function reportHtml(r, full = false) {
  if (!r) return '';
  const pc = (k, n) => (n ? `${Math.round((k / n) * 100)}%` : '—');
  const codes = (r.zero_codes || []).map((c) => `<li><span class="code zero">${C.esc(formatCode(c.code))}</span><span>${c.n}× · ${c.regular ? 'регулярно' : 'разово'}</span></li>`).join('');
  const lk = r.l_kinds || {};
  const lkText = [['law', 'закон'], ['rules', 'правила места или работы'], ['norms', 'нормы круга']].filter(([k]) => lk[k]).map(([k, l]) => `${l} — ${lk[k]}`).join(', ');
  const cats = (r.by_category || []).filter((g) => g.zero).map((g) => `<li><b>${C.esc(g.label)}</b><span>${g.zero} из ${g.n} с нулями${g.top ? ` · чаще: ${BIT_NAMES[g.top] || ''}` : ''}</span></li>`).join('');
  const parts = (r.by_partner || []).map((g) => `<li><b>${C.esc(g.label)}</b><span>${g.n - g.full} из ${g.n} не 11111${g.unknown ? ` · «не знаю» ${g.unknown}` : ''}</span></li>`).join('');
  return `<div class="report">
    <b>Моя неделя · ${r.days} ${C.plural(r.days, 'день', 'дня', 'дней')}</b>
    <p>${r.n} ${C.plural(r.n, 'действие', 'действия', 'действий')} · без нулей ${r.full} (${pc(r.full, r.n)}) · с нулями ${r.zero}</p>
    ${codes ? `<small>Коды с нулями</small><ul class="rep-codes">${codes}</ul>` : ''}
    ${full && lkText ? `<small>«Нельзя»: ${lkText}</small>` : ''}
    ${full && cats ? `<small>Где нули</small><ul class="rep-rows">${cats}</ul>` : ''}
    ${full && parts ? `<small>С кем</small><ul class="rep-rows">${parts}</ul>` : ''}
  </div>`;
}

// ---------- экраны ----------

export async function renderContact(name, q) {
  stopContactPoll();
  if (name === 'report') return renderReport(q);
  if (name === 'book') return renderBook(q);
  if (name === 'profile') return renderProfile(q);
  if (name === 'feedback') return renderFeedback();
  if (q.get('t')) return renderThread(q.get('t'));
  if (q.get('new')) return renderNew(q.get('new'));
  return renderHome();
}

function profileCard(backTo = '#chat') {
  const p = C.S.profile;
  if (p) {
    return `<section class="card"><h2>Профиль: ${C.esc(p.name)}</h2>
      <p class="muted small-note">Переписка видна на всех телефонах, где вы вошли по коду.</p>
      <button class="btn wide" data-act="go" data-h="#profile">Профиль и код входа</button></section>`;
  }
  const b = encodeURIComponent(backTo);
  return `<section class="card"><h2>Профиль</h2>
    <p class="muted small-note">Сейчас вы анонимны. Профиль нужен, чтобы отправить специалисту свои данные и записаться на консультацию. Достаточно имени — почта и телефон не нужны.</p>
    <button class="btn wide" data-act="go" data-h="#profile?m=create&back=${b}">Создать профиль</button>
    <button class="btn ghost wide" data-act="go" data-h="#profile?m=login&back=${b}">У меня есть код входа</button></section>`;
}

async function renderHome() {
  const { $view, esc } = C;
  if (!st.threads) await refreshThreads();
  const threads = st.threads || [];
  const spec = threads.find((t) => t.topic === 'specialist');
  const topic = (t, title, sub) => `<button class="choice" data-act="go" data-h="${t === 'specialist' && spec ? `#chat?t=${spec.id}` : `#chat?new=${t}`}"><b>${title}</b><small>${sub}</small></button>`;
  const row = (t) => {
    const last = t.last ? (t.last.kind === 'report' ? 'Моя неделя' : t.last.kind === 'booking' ? 'Запись на консультацию' : t.last.kind === 'booking_cancel' ? 'Запись отменена'
      : t.last.kind === 'status' ? 'Статус обновлён' : t.last.body) : '';
    return `<li><button class="thread-row" data-act="go" data-h="#chat?t=${esc(t.id)}">
      <span class="t-head"><b>${TOPIC_SHORT[t.topic]}</b><span class="badge">${STATUS_LABEL[t.topic][t.status] || ''}</span>${t.unread ? `<i class="unread">${t.unread}</i>` : ''}</span>
      <span class="t-last">${t.last?.author === 'admin' ? `${ADMIN_NAME[t.topic]}: ` : ''}${esc(last)}</span>
      <time>${ago(t.updated_at)}</time></button></li>`;
  };
  $view.innerHTML = `
    <header class="top"><h1>Связь</h1></header>
    <section class="card intro"><h2>Приложение, которое подстраивается под вас</h2>
      <p>Не хватает своей категории, вопроса или отчёта? Напишите: лучшие идеи сделаем для всех, а часть настроим лично для вас.</p></section>
    <div class="topics">
      ${topic('idea', 'Идея: настроить под себя', 'Чего не хватает в приложении')}
      ${topic('support', 'Техподдержка', 'Что-то не работает или непонятно')}
      ${topic('specialist', 'Вопрос специалисту', spec ? 'Открыть переписку' : 'Разобраться в результатах и вариантах решений')}
    </div>
    ${threads.length ? `<section class="card"><h2>Мои обращения</h2><ul class="threads">${threads.map(row).join('')}</ul></section>` : ''}
    <section class="card"><h2>Разобраться в своих результатах</h2>
      <p class="muted small-note">Приложение не толкует коды — только показывает факты. Что они значат для вас и что можно изменить, обсудите со специалистом.</p>
      <button class="btn primary wide" data-act="go" data-h="#book">Записаться на консультацию · бесплатно</button>
      <button class="btn wide" data-act="go" data-h="${spec ? `#chat?t=${spec.id}` : '#chat?new=specialist'}">Задать вопрос специалисту</button>
      <a class="btn wide link" href="/books/potok-lyubvi.pdf" target="_blank" rel="noopener">Книга «Поток любви» — пособие по DCL (PDF)</a>
      <a class="btn wide link" href="/books/vremya-po-lyubvi.pdf" target="_blank" rel="noopener">Повесть «Время по любви» (PDF)</a>
    </section>
    ${profileCard()}`;
}

function renderNew(topic) {
  if (!TOPIC_TITLE[topic]) { C.go('#chat'); return; }
  const spec = topic === 'specialist' && (st.threads || []).find((t) => t.topic === 'specialist');
  if (spec) { C.go(`#chat?t=${spec.id}`); return; }
  const t = NEW_TEXT[topic];
  C.$view.innerHTML = `${back('#chat')}
    <h1>${TOPIC_TITLE[topic]}</h1>
    <p class="lead">${t.lead}</p>
    ${topic === 'specialist' ? CRISIS : ''}
    <form class="composer big" data-act="c-new" data-topic="${topic}">
      <textarea id="c-body" rows="6" maxlength="4000" placeholder="${C.esc(t.ph)}" required></textarea>
      <button class="btn primary wide" ${st.sending ? 'disabled' : ''}>Отправить</button>
    </form>
    ${topic === 'specialist' ? `<p class="muted small-note">Свои данные (снимок недели) можно приложить из профиля — после первого сообщения.</p>` : ''}`;
  document.getElementById('c-body')?.focus();
}

function msgHtml(m, topic, cancelled) {
  const { esc } = C;
  const time = `<time>${ago(m.created_at)}</time>`;
  if (m.kind === 'report') return `<li class="msg me">${reportHtml(m.data)}${time}</li>`;
  if (m.kind === 'booking') {
    const d = m.data || {};
    const active = !cancelled.has(d.booking) && d.end > Date.now();
    const meet = safeUrl(d.meet);
    return `<li class="msg sys booking"><b>Запись на консультацию</b><p>${esc(span(d.start, d.end))}</p>
      ${meet && active ? `<a class="btn small primary" href="${esc(meet)}" target="_blank" rel="noopener">Ссылка на видеовстречу</a>` : ''}
      ${!meet && active ? '<small>Ссылку на встречу специалист пришлёт здесь.</small>' : ''}
      ${active && C.S.profile ? `<button class="btn small ghost" data-act="c-cancel" data-b="${esc(d.booking)}">Отменить запись</button>` : ''}${time}</li>`;
  }
  if (m.kind === 'booking_cancel') {
    const d = m.data || {};
    return `<li class="msg sys"><p>Запись на ${esc(span(d.start, d.end))} отменена${d.by === 'admin' ? ' специалистом' : ''}.</p>${time}</li>`;
  }
  if (m.kind === 'status') return `<li class="msg sys"><p>Статус идеи: <b>${STATUS_LABEL.idea[m.data?.status] || ''}</b></p>${time}</li>`;
  if (m.author === 'admin') return `<li class="msg them"><b>${ADMIN_NAME[topic]}</b><p>${nl2br(m.body)}</p>${time}</li>`;
  const why = (m.data?.reasons || []).map((k) => FB_REASONS.find(([r]) => r === k)?.[1]).filter(Boolean);
  return `<li class="msg me">${why.length ? `<small>${C.esc(why.join(' · '))}</small>` : ''}<p>${nl2br(m.body)}</p>${time}</li>`;
}

function drawThread() {
  const { thread: t, messages } = st.thread;
  const cur = document.querySelector(`form[data-act="c-send"][data-t="${CSS.escape(t.id)}"] textarea`); // черновик только этой переписки
  const draft = cur?.value || '';
  const cancelled = new Set(messages.filter((m) => m.kind === 'booking_cancel').map((m) => m.data?.booking));
  C.$view.innerHTML = `${back('#chat')}
    <div class="thread-head"><h1>${TOPIC_TITLE[t.topic]}</h1><span class="badge">${STATUS_LABEL[t.topic][t.status] || ''}</span></div>
    ${t.topic === 'specialist' ? CRISIS : ''}
    <ul class="msgs">${messages.map((m) => msgHtml(m, t.topic, cancelled)).join('')}</ul>
    ${t.topic === 'specialist' ? `<div class="row2">
      <button class="btn" data-act="go" data-h="#report?t=${C.esc(t.id)}">Приложить мою неделю</button>
      <button class="btn" data-act="go" data-h="#book">Записаться</button></div>` : ''}
    <form class="composer" data-act="c-send" data-t="${C.esc(t.id)}">
      <textarea id="c-body" rows="3" maxlength="4000" placeholder="Сообщение" required>${C.esc(draft)}</textarea>
      <button class="btn primary" ${st.sending ? 'disabled' : ''}>Отправить</button>
    </form>`;
}

async function renderThread(id) {
  try {
    st.thread = await api(`/api/threads/${encodeURIComponent(id)}`);
  } catch (e) {
    C.$view.innerHTML = `${back('#chat')}<p class="lead">${e instanceof ApiError && e.status === 404 ? 'Переписка не найдена.' : 'Нет связи с сервером. Попробуйте позже.'}</p>`;
    return;
  }
  drawThread();
  document.querySelector('.msgs li:last-child')?.scrollIntoView({ block: 'end' });
  refreshThreads();
  poll = setInterval(async () => { // новые сообщения, пока переписка открыта
    if (document.visibilityState !== 'visible' || C.route().name !== 'chat' || C.route().q.get('t') !== id) return;
    try {
      const r = await api(`/api/threads/${encodeURIComponent(id)}`);
      const sig = (x) => `${x.messages.length}:${x.messages.at(-1)?.id}:${x.thread.status}`;
      if (sig(r) !== sig(st.thread)) {
        const focused = document.activeElement?.id === 'c-body';
        st.thread = r; drawThread();
        if (focused) document.getElementById('c-body')?.focus();
        document.querySelector('.msgs li:last-child')?.scrollIntoView({ block: 'end' });
      }
    } catch {}
  }, 15000);
}

async function renderReport(q) {
  const tid = q.get('t');
  if (!C.S.profile) {
    C.$view.innerHTML = `${back(tid ? `#chat?t=${tid}` : '#chat')}<h1>Моя неделя для специалиста</h1>
      <p class="lead">Отправить свои данные можно только из профиля — анонимно нельзя.</p>${profileCard(`#report${tid ? `?t=${tid}` : ''}`)}`;
    return;
  }
  const days = st.reportDays;
  const dates = C.lastDates(days);
  const answers = (await since('answers', Date.now() - (days + 1) * 86400_000)).filter((a) => a.local_date >= dates[0]);
  st.report = buildReport(answers, days);
  C.$view.innerHTML = `${back(tid ? `#chat?t=${tid}` : '#chat')}
    <h1>Моя неделя для специалиста</h1>
    <div class="seg">${[[7, '7 дней'], [30, '30 дней']].map(([v, l]) => `<button class="${days === v ? 'on' : ''}" data-act="c-rdays" data-v="${v}">${l}</button>`).join('')}</div>
    ${st.report.n ? `<section class="card">${reportHtml(st.report, true)}</section>
      <p class="muted small-note">Специалист увидит ровно то, что показано выше: числа и коды. Отдельные записи и время действий не отправляются.</p>
      <button class="btn primary wide" data-act="c-send-report" data-t="${C.esc(tid || '')}" ${st.sending ? 'disabled' : ''}>Отправить специалисту</button>`
      : '<p class="lead">За этот период нет отмеченных действий.</p>'}`;
}

async function renderBook() {
  const { $view, esc } = C;
  if (!C.S.profile) {
    $view.innerHTML = `${back('#chat')}<h1>Консультация</h1>
      <p class="lead">Бесплатно, онлайн по видеосвязи. Для записи нужен профиль — достаточно имени.</p>${profileCard('#book')}`;
    return;
  }
  $view.innerHTML = `${back('#chat')}<h1>Консультация</h1><p class="muted">Загружаю свободное время…</p>`;
  try { st.slots = await api('/api/slots'); } catch { $view.innerHTML = `${back('#chat')}<h1>Консультация</h1><p class="lead">Нет связи с сервером. Попробуйте позже.</p>`; return; }
  const s = st.slots;
  const intro = `<p class="lead">Бесплатно, онлайн по видеосвязи (Google Meet), ${s.duration} мин. Время на ближайшие ${s.days} ${C.plural(s.days, 'день', 'дня', 'дней')} — по календарю специалиста.</p>`;
  let body;
  if (s.mine) {
    const meet = safeUrl(s.mine.meet);
    body = `<section class="card"><h2>Вы записаны</h2><p class="big-when">${esc(span(s.mine.start, s.mine.end))}</p>
      ${meet ? `<a class="btn primary wide link" href="${esc(meet)}" target="_blank" rel="noopener">Ссылка на видеовстречу</a>` : '<p class="muted small-note">Ссылку на встречу специалист пришлёт в переписке.</p>'}
      <p class="muted small-note">За час до начала придёт напоминание.</p>
      ${s.mine.thread ? `<button class="btn wide" data-act="go" data-h="#chat?t=${esc(s.mine.thread)}">Открыть переписку</button>` : ''}
      <button class="btn ghost wide" data-act="c-cancel" data-b="${esc(s.mine.id)}">Отменить запись</button></section>`;
  } else if (!s.available) {
    body = `<section class="card"><p>Запись сейчас недоступна. Напишите специалисту — договоримся о времени в переписке.</p>
      <button class="btn wide" data-act="go" data-h="#chat?new=specialist">Написать специалисту</button></section>`;
  } else if (!s.slots.length) {
    body = `<section class="card"><p>На ближайшие дни свободного времени нет. Напишите специалисту — договоримся.</p>
      <button class="btn wide" data-act="go" data-h="#chat?new=specialist">Написать специалисту</button></section>`;
  } else {
    const days = new Map();
    for (const x of s.slots) { const k = dayLabel(x.start); if (!days.has(k)) days.set(k, []); days.get(k).push(x); }
    const pick = s.slots.find((x) => x.start === st.pick);
    body = [...days].map(([d, list]) => `<section class="card"><h2>${esc(d)}</h2><div class="chips">${list.map((x) =>
      `<button class="chip ${x.start === st.pick ? 'on' : ''}" data-act="c-pick" data-v="${x.start}">${hm(x.start)}</button>`).join('')}</div></section>`).join('')
      + (pick ? `<section class="card confirm"><p>Записаться на <b>${esc(span(pick.start, pick.end))}</b>?</p>
        <button class="btn primary wide" data-act="c-book" ${st.sending ? 'disabled' : ''}>Записаться</button></section>` : '')
      + `<p class="muted small-note">Время — по вашему часовому поясу (${esc(tz())}).</p>`;
  }
  $view.innerHTML = `${back('#chat')}<h1>Консультация</h1>${intro}${body}`;
  if (st.pick) document.querySelector('.confirm')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

async function renderProfile(q) {
  const { $view, esc } = C;
  const p = C.S.profile;
  const backTo = q.get('back') || '#chat';
  if (st.newCode) {
    $view.innerHTML = `<h1>Ваш код входа</h1>
      <div class="codebox">${esc(st.newCode)}</div>
      <p class="lead">Сохраните его: сделайте скриншот или запишите. По коду можно войти в профиль с другого телефона.</p>
      <p class="muted small-note">Мы храним не сам код, а его отпечаток, поэтому напомнить код не сможем. На этом телефоне он сохранён — его можно посмотреть в профиле.</p>
      <button class="btn wide" data-act="c-copy">Скопировать код</button>
      <button class="btn primary wide" data-act="c-code-done" data-back="${esc(backTo)}">Готово</button>`;
    return;
  }
  if (!p) {
    const login = q.get('m') === 'login';
    $view.innerHTML = `${back(backTo)}
      <h1>${login ? 'Вход по коду' : 'Профиль'}</h1>
      ${login ? `<p class="lead">Введите код входа из профиля на другом телефоне.</p>
        <form class="stack-form" data-act="c-login" data-back="${esc(backTo)}"><input id="c-code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX" maxlength="20" required>
        <button class="btn primary wide" ${st.sending ? 'disabled' : ''}>Войти</button></form>
        <button class="btn ghost wide" data-act="go" data-h="#profile?m=create&back=${encodeURIComponent(backTo)}">Создать новый профиль</button>`
      : `<p class="lead">Профиль нужен, чтобы отправить специалисту свои данные и записаться на консультацию. Достаточно имени — почта и телефон не нужны.</p>
        <form class="stack-form" data-act="c-create" data-back="${esc(backTo)}"><input id="c-name" maxlength="40" placeholder="Как к вам обращаться" autocomplete="nickname" required>
        <button class="btn primary wide" ${st.sending ? 'disabled' : ''}>Создать профиль</button></form>
        <p class="muted small-note">После создания покажем код входа — по нему можно войти с другого телефона.</p>
        <button class="btn ghost wide" data-act="go" data-h="#profile?m=login&back=${encodeURIComponent(backTo)}">У меня есть код входа</button>`}`;
    document.getElementById(login ? 'c-code' : 'c-name')?.focus();
    return;
  }
  const code = await kvGet('profileCode');
  $view.innerHTML = `${back('#chat')}
    <h1>Профиль</h1>
    <section class="card"><h2>Имя</h2>
      <form class="add-row" data-act="c-rename"><input id="c-name" maxlength="40" value="${esc(p.name)}" required><button class="btn">Сохранить</button></form></section>
    <section class="card"><h2>Код входа</h2>
      ${code ? `<div class="codebox small">${esc(code)}</div><button class="btn wide" data-act="c-copy" data-code="${esc(code)}">Скопировать код</button>`
        : '<p class="muted small-note">На этом телефоне код не сохранён.</p>'}
      <button class="btn ghost wide" data-act="c-rotate">Получить новый код</button>
      <p class="muted small-note">Новый код заменит старый: войти по старому будет нельзя. Уже вошедшие телефоны останутся в профиле.</p></section>
    <section class="card"><h2>Выход</h2>
      <button class="btn wide" data-act="c-logout">Выйти из профиля на этом телефоне</button>
      <button class="btn danger wide" data-act="c-delete">Удалить профиль и переписку</button></section>`;
}

function renderFeedback() {
  const f = st.fb;
  const text = document.getElementById('fb-text')?.value ?? f.text ?? '';
  C.$view.innerHTML = `<div class="ans-top"><span></span><button class="x" data-act="go" data-h="#today" aria-label="Закрыть">✕</button></div>
    <h1>Помогите нам стать лучше</h1>
    <p class="lead">Что улучшить в DCL-832? Отметьте, что мешает, — можно несколько.</p>
    <div class="fb-list">${FB_REASONS.map(([k, l]) => `<button class="fb-opt ${f.reasons.has(k) ? 'on' : ''}" data-act="c-fb-r" data-v="${k}"><i>✓</i>${l}</button>`).join('')}</div>
    <textarea id="fb-text" class="fb-text" rows="3" maxlength="2000" placeholder="Своими словами: что изменить (необязательно)">${C.esc(text)}</textarea>
    <h2>Настроить сигналы прямо сейчас</h2>
    <div class="chips">${FB_ACTIONS.map(([k, l]) => `<button class="chip ${f.action === k ? 'on' : ''}" data-act="c-fb-a" data-v="${k}">${l}</button>`).join('')}</div>
    <button class="btn primary wide" data-act="c-fb-send" ${st.sending ? 'disabled' : ''}>Отправить</button>
    <p class="muted small-note">Ответ анонимный. Если напишете своими словами — ответ команды придёт во вкладку «Связь».</p>`;
}

// ---------- действия ----------

async function withBusy(fn) {
  if (st.sending) return;
  st.sending = true;
  try { await fn(); } catch (e) {
    const code = e instanceof ApiError ? e.message : '';
    const msg = {
      need_profile: 'Для этого нужен профиль', bad_code: 'Неверный код', try_later: 'Слишком много попыток — подождите 15 минут',
      too_many_messages: 'Слишком много сообщений — попробуйте позже', has_booking: 'У вас уже есть запись', slot_taken: 'Это время только что заняли — выберите другое',
      calendar_error: 'Календарь специалиста не ответил — попробуйте позже', calendar_not_connected: 'Запись сейчас недоступна', too_long: 'Слишком длинное сообщение',
    }[code];
    C.toast(msg || (e instanceof ApiError && e.status ? 'Не получилось — попробуйте ещё раз' : 'Нет связи с сервером'));
    if (code === 'slot_taken') { st.pick = null; renderBook(); }
  } finally { st.sending = false; }
}

/** Обработка data-act вкладки «Связь». true — событие обработано */
export async function contactAct(act, el) {
  switch (act) {
    case 'c-rdays': st.reportDays = Number(el.dataset.v); renderReport(C.route().q); return true;
    case 'c-fb-r': { const k = el.dataset.v; st.fb.reasons.has(k) ? st.fb.reasons.delete(k) : st.fb.reasons.add(k); renderFeedback(); return true; }
    case 'c-fb-a': st.fb.action = st.fb.action === el.dataset.v ? null : el.dataset.v; renderFeedback(); return true;
    case 'c-fb-send': {
      const text = document.getElementById('fb-text')?.value.trim() || '';
      if (!st.fb.reasons.size && !text && !st.fb.action) { C.toast('Отметьте, что мешает, напишите или выберите настройку'); return true; }
      await withBusy(async () => {
        await C.ensureRegistered();
        const r = await api('/api/feedback', { method: 'POST', body: { reasons: [...st.fb.reasons], text, action: st.fb.action } });
        if (st.fb.action === 'off') {
          try { const reg = await navigator.serviceWorker.getRegistration('/'); await (await reg?.pushManager.getSubscription())?.unsubscribe(); } catch {}
        }
        C.applyServerUser(r.user);
        st.fb = { reasons: new Set(), action: null }; st.threads = null;
        C.toast('Спасибо! Это поможет сделать приложение лучше');
        C.go('#today');
      });
      return true;
    }
    case 'c-pick': st.pick = Number(el.dataset.v); renderBook(); return true;
    case 'c-copy': {
      const code = el.dataset.code || st.newCode;
      try { await navigator.clipboard.writeText(code); C.toast('Код скопирован'); } catch { C.toast(code); }
      return true;
    }
    case 'c-code-done': st.newCode = null; C.go(el.dataset.back || '#chat'); return true;
    case 'c-send-report':
      await withBusy(async () => {
        await C.ensureRegistered();
        const tid = el.dataset.t;
        let thread = tid;
        if (tid) await api(`/api/threads/${encodeURIComponent(tid)}/messages`, { method: 'POST', body: { body: '', report: st.report } });
        else thread = (await api('/api/threads', { method: 'POST', body: { topic: 'specialist', body: '', report: st.report } })).thread;
        C.toast('Отправлено специалисту');
        st.threads = null;
        C.go(`#chat?t=${thread}`);
      });
      return true;
    case 'c-book':
      await withBusy(async () => {
        const r = await api('/api/bookings', { method: 'POST', body: { start: st.pick } });
        st.pick = null; st.threads = null;
        C.toast('Вы записаны на консультацию');
        C.go(`#chat?t=${r.thread}`);
      });
      return true;
    case 'c-cancel':
      if (!confirm('Отменить запись на консультацию?')) return true;
      await withBusy(async () => {
        await api(`/api/bookings/${encodeURIComponent(el.dataset.b)}/cancel`, { method: 'POST' });
        C.toast('Запись отменена');
        C.render();
      });
      return true;
    case 'c-rotate':
      if (!confirm('Создать новый код? Старый перестанет работать.')) return true;
      await withBusy(async () => {
        const r = await api('/api/profile/code', { method: 'POST' });
        await kvSet('profileCode', r.code);
        st.newCode = r.code; C.render();
      });
      return true;
    case 'c-logout':
      if (!confirm('Выйти из профиля на этом телефоне? Переписку профиля здесь будет не видно, пока не войдёте по коду.')) return true;
      await withBusy(async () => {
        await api('/api/profile/logout', { method: 'POST' });
        applyProfile(null); st.threads = null;
        C.toast('Вы вышли из профиля'); C.go('#chat');
      });
      return true;
    case 'c-delete':
      if (!confirm('Удалить профиль, всю переписку и записи на консультацию? Это нельзя отменить.')) return true;
      await withBusy(async () => {
        await api('/api/profile', { method: 'DELETE' });
        applyProfile(null); st.threads = null;
        C.toast('Профиль удалён'); C.go('#chat');
      });
      return true;
  }
  return false;
}

/** Отправка форм вкладки «Связь». true — форма обработана */
export async function contactSubmit(form) {
  const act = form.dataset.act;
  if (!['c-new', 'c-send', 'c-create', 'c-login', 'c-rename'].includes(act)) return false;
  const val = (id) => document.getElementById(id)?.value.trim() || '';
  await withBusy(async () => {
    await C.ensureRegistered();
    if (act === 'c-new') {
      const r = await api('/api/threads', { method: 'POST', body: { topic: form.dataset.topic, body: val('c-body') } });
      st.threads = null;
      C.toast('Отправлено. Ответ придёт сюда и уведомлением');
      C.go(`#chat?t=${r.thread}`);
    } else if (act === 'c-send') {
      const tid = form.dataset.t;
      await api(`/api/threads/${encodeURIComponent(tid)}/messages`, { method: 'POST', body: { body: val('c-body') } });
      document.getElementById('c-body').value = '';
      st.thread = await api(`/api/threads/${encodeURIComponent(tid)}`);
      drawThread();
      document.querySelector('.msgs li:last-child')?.scrollIntoView({ block: 'end' });
    } else if (act === 'c-create') {
      const r = await api('/api/profile', { method: 'POST', body: { name: val('c-name') } });
      applyProfile(r.profile);
      await kvSet('profileCode', r.code);
      st.newCode = r.code; st.threads = null;
      C.render();
    } else if (act === 'c-login') {
      const r = await api('/api/profile/login', { method: 'POST', body: { code: val('c-code') } });
      applyProfile(r.profile);
      const c = val('c-code').toUpperCase().replace(/[^A-Z0-9]/g, '');
      await kvSet('profileCode', `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`);
      st.threads = null;
      C.toast(`Вы вошли как ${r.profile.name}`);
      C.go(form.dataset.back || '#chat');
    } else if (act === 'c-rename') {
      const r = await api('/api/profile', { method: 'PUT', body: { name: val('c-name') } });
      applyProfile(r.profile);
      C.toast('Имя сохранено');
    }
  });
  return true;
}

/** Push о новом сообщении: обновить значок и открытую переписку */
export async function onPushMessage() {
  await refreshThreads();
  const r = C.route();
  if (r.name === 'chat' && !r.q.get('t') && !r.q.get('new')) renderHome();
}
