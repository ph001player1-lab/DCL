// «Связь»: профиль (имя + код входа), переписка (техподдержка, идеи, вопрос специалисту),
// запись на консультацию по Google-календарю специалиста, уведомления в обе стороны.
import { sendPush } from './webpush.js';
import { HttpError, json, readJson, sha256, randomId, vapid, getSetting, setSetting } from './util.js';
import { BOOKING_DEFAULTS, cleanBookingConfig, computeSlots, horizon } from './slots.js';
import { googleConfigured, googleState, freeBusy, createEvent, deleteEvent } from './google.js';

export const TOPICS = ['support', 'idea', 'specialist'];
const STATUSES = {
  support: ['new', 'open', 'done'],
  idea: ['new', 'accepted', 'in_progress', 'done', 'declined'],
  specialist: ['new', 'open', 'done'],
};
const IDEA_STATUS = { accepted: 'принята', in_progress: 'в работе', done: 'сделана', declined: 'пока не в планах' };
const TOPIC_TITLE = { support: 'Техподдержка', idea: 'Идея', specialist: 'Вопрос специалисту' };
const MAX_BODY = 4000;
const MAX_REPORT = 24000;
const MSG_PER_HOUR = 30;

// ---------- код входа ----------

const ALPH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // без 0/O, 1/I/L — чтобы не путать при вводе
function newCode() {
  let s = '';
  while (s.length < 12) {
    for (const x of crypto.getRandomValues(new Uint8Array(16))) if (x < 248 && s.length < 12) s += ALPH[x % 31]; // без перекоса распределения
  }
  return s;
}
const normCode = (v) => { const c = String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return c.length === 12 && [...c].every((ch) => ALPH.includes(ch)) ? c : null; };
const fmtCode = (c) => `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
const codeHash = (c) => sha256(`dcl832-code:${c}`);
function cleanName(v) {
  const s = String(v ?? '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!s) throw new HttpError(400, 'bad_name');
  return s;
}
function cleanBody(v, required = true) {
  const s = String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim();
  if (s.length > MAX_BODY) throw new HttpError(400, 'too_long');
  if (required && !s) throw new HttpError(400, 'empty');
  return s;
}
function cleanReport(r) {
  if (r === undefined || r === null) return null;
  if (typeof r !== 'object' || Array.isArray(r) || r.v !== 1 || !Number.isFinite(r.n)) throw new HttpError(400, 'bad_report');
  const s = JSON.stringify(r);
  if (s.length > MAX_REPORT) throw new HttpError(413, 'report_too_large');
  return r;
}

// ---------- переписка: общие части ----------

// Переписка профиля видна на всех его устройствах (и только пока они в профиле); анонимная — только на своём устройстве
const OWNER = '((t.profile_id IS NULL AND t.user_id = ?1) OR (?2 IS NOT NULL AND t.profile_id = ?2))';
const ownerArgs = (user) => [user.id, user.profile_name ? user.profile_id : null];

async function ownThread(env, user, id) {
  const t = await env.DB.prepare(`SELECT * FROM threads t WHERE ${OWNER} AND t.id = ?3`).bind(...ownerArgs(user), id).first();
  if (!t) throw new HttpError(404, 'not_found');
  return t;
}
async function findSpecialistThread(env, user) {
  return env.DB.prepare(`SELECT * FROM threads t WHERE ${OWNER} AND t.topic = 'specialist' ORDER BY t.updated_at DESC LIMIT 1`)
    .bind(...ownerArgs(user)).first();
}

function msgStmt(env, { thread, user_id = null, author, kind = 'text', body = '', data = null, now }) {
  return env.DB.prepare('INSERT INTO messages (id, thread_id, user_id, author, kind, body, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(randomId(12), thread, user_id, author, kind, body, data ? JSON.stringify(data) : null, now);
}
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const publicMessage = (m) => ({ id: m.id, author: m.author, kind: m.kind, body: m.body, data: parse(m.data), created_at: m.created_at });
const publicThread = (t) => ({ id: t.id, topic: t.topic, status: t.status, created_at: t.created_at, updated_at: t.updated_at,
  unread: t.unread_user, last: parse(t.last) });
const publicBooking = (b) => b && { id: b.id, start: b.start_at, end: b.end_at, status: b.status, meet: b.meet_url, thread: b.thread_id };

async function rateLimit(env, user, now) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND created_at > ?').bind(user.id, now - 3600_000).first();
  if (r.n >= MSG_PER_HOUR) throw new HttpError(429, 'too_many_messages');
}

// ---------- уведомления ----------

/** Push владельцу переписки: на все устройства профиля или на устройство анонима */
async function notifyOwner(env, thread, payload) {
  const { results } = await env.DB.prepare(`SELECT id, push_endpoint, push_p256dh, push_auth FROM users
    WHERE push_endpoint IS NOT NULL AND ((?2 IS NULL AND id = ?1) OR profile_id = ?2)`).bind(thread.user_id, thread.profile_id ?? null).all();
  const v = vapid(env);
  await Promise.all(results.map(async (u) => {
    try {
      const r = await sendPush({ endpoint: u.push_endpoint, p256dh: u.push_p256dh, auth: u.push_auth }, { type: 'msg', thread: thread.id, topic: thread.topic, ...payload }, v);
      if (r.gone) await env.DB.prepare('UPDATE users SET push_endpoint = NULL, push_p256dh = NULL, push_auth = NULL WHERE id = ?').bind(u.id).run();
    } catch (e) { console.log('notify owner', String(e)); }
  }));
}

/** Push администратору на все его подписанные устройства */
export async function notifyAdmin(env, payload) {
  const { results } = await env.DB.prepare('SELECT * FROM admin_push').all();
  const v = vapid(env);
  await Promise.all(results.map(async (s) => {
    try {
      const r = await sendPush({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, { type: 'admin', ...payload }, v);
      if (r.gone) await env.DB.prepare('DELETE FROM admin_push WHERE endpoint = ?').bind(s.endpoint).run();
    } catch (e) { console.log('notify admin', String(e)); }
  }));
}
const later = (ctx, p) => (ctx?.waitUntil ? ctx.waitUntil(p.catch((e) => console.log('later', String(e)))) : p);

const ownerLabel = (user) => (user.profile_name ? user.profile_name : `аноним №${user.id.slice(0, 6)}`);

// ---------- запись на консультацию ----------

export async function bookingConfig(env) { return { ...BOOKING_DEFAULTS, ...(await getSetting(env, 'booking')) }; }

async function freeSlots(env, cfg, now) {
  const to = horizon(cfg, now);
  const busy = await freeBusy(env, now, to, cfg.tz);
  const { results } = await env.DB.prepare("SELECT start_at, end_at FROM bookings WHERE status = 'booked' AND end_at > ?").bind(now).all();
  return computeSlots(cfg, [...busy, ...results.map((b) => [b.start_at, b.end_at])], now);
}

async function upcomingBooking(env, profileId, now) {
  return env.DB.prepare("SELECT * FROM bookings WHERE profile_id = ? AND status = 'booked' AND end_at > ? ORDER BY start_at LIMIT 1").bind(profileId, now).first();
}

/** Отмена записи: встреча удаляется из календаря, в переписку — системное сообщение */
async function cancelBooking(env, ctx, b, by, now) {
  try { await deleteEvent(env, b.gcal_event_id); } catch (e) { console.log('cancel event', String(e)); }
  const stmts = [env.DB.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").bind(b.id)];
  if (b.thread_id) {
    stmts.push(msgStmt(env, { thread: b.thread_id, author: 'system', kind: 'booking_cancel', data: { booking: b.id, start: b.start_at, end: b.end_at, by }, now }));
    stmts.push(env.DB.prepare(`UPDATE threads SET updated_at = ?, last_from = 'system',
      unread_user = unread_user + ?, unread_admin = unread_admin + ? WHERE id = ?`).bind(now, by === 'admin' ? 1 : 0, by === 'user' ? 1 : 0, b.thread_id));
  }
  await env.DB.batch(stmts);
}

/** Удалить профиль целиком: записи (и встречи в календаре), переписку; устройства становятся анонимными */
export async function deleteProfile(env, profileId, now = Date.now()) {
  const { results: books } = await env.DB.prepare("SELECT * FROM bookings WHERE profile_id = ? AND status = 'booked' AND start_at > ?").bind(profileId, now).all();
  for (const b of books) { try { await deleteEvent(env, b.gcal_event_id); } catch (e) { console.log('delete event', String(e)); } }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE profile_id = ?)').bind(profileId),
    env.DB.prepare('DELETE FROM threads WHERE profile_id = ?').bind(profileId),
    env.DB.prepare('DELETE FROM bookings WHERE profile_id = ?').bind(profileId),
    env.DB.prepare('UPDATE users SET profile_id = NULL WHERE profile_id = ?').bind(profileId),
    env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(profileId),
  ]);
}

/** Удаление устройства («Удалить все данные»): его анонимная переписка, а если есть профиль — и профиль */
export async function deleteDeviceContact(env, user) {
  if (user.profile_name) await deleteProfile(env, user.profile_id);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE user_id = ? AND profile_id IS NULL)').bind(user.id),
    env.DB.prepare('DELETE FROM threads WHERE user_id = ? AND profile_id IS NULL').bind(user.id),
  ]);
}

// ---------- API пользователя ----------

export async function handleContact(request, env, ctx, user, path, method, url) {
  const now = Date.now();
  const DB = env.DB;
  const hasProfile = !!user.profile_name;

  // --- профиль ---
  if (path === '/api/profile' && method === 'POST') {
    if (hasProfile) throw new HttpError(409, 'has_profile');
    const name = cleanName((await readJson(request, 2048)).name);
    const code = newCode(), id = randomId(12);
    await DB.batch([
      DB.prepare('INSERT INTO profiles (id, name, code_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)').bind(id, name, await codeHash(code), now, now),
      DB.prepare('UPDATE users SET profile_id = ? WHERE id = ?').bind(id, user.id),
      DB.prepare('UPDATE threads SET profile_id = ? WHERE user_id = ? AND profile_id IS NULL').bind(id, user.id),
    ]);
    return json({ profile: { name }, code: fmtCode(code) }, 201);
  }
  if (path === '/api/profile/login' && method === 'POST') {
    if (user.login_block_until > now) throw new HttpError(429, 'try_later');
    const code = normCode((await readJson(request, 2048)).code);
    const p = code && await DB.prepare('SELECT * FROM profiles WHERE code_hash = ?').bind(await codeHash(code)).first();
    if (!p) {
      const fails = (user.login_fails || 0) + 1;
      await DB.prepare('UPDATE users SET login_fails = ?, login_block_until = ? WHERE id = ?')
        .bind(fails >= 5 ? 0 : fails, fails >= 5 ? now + 15 * 60_000 : 0, user.id).run();
      throw new HttpError(404, 'bad_code');
    }
    await DB.batch([
      DB.prepare('UPDATE users SET profile_id = ?, login_fails = 0, login_block_until = 0 WHERE id = ?').bind(p.id, user.id),
      DB.prepare('UPDATE threads SET profile_id = ? WHERE user_id = ? AND profile_id IS NULL').bind(p.id, user.id),
      DB.prepare('UPDATE profiles SET last_seen = ? WHERE id = ?').bind(now, p.id),
    ]);
    return json({ profile: { name: p.name } });
  }
  if (path === '/api/profile' && method === 'PUT') {
    if (!hasProfile) throw new HttpError(403, 'need_profile');
    const name = cleanName((await readJson(request, 2048)).name);
    await DB.prepare('UPDATE profiles SET name = ? WHERE id = ?').bind(name, user.profile_id).run();
    return json({ profile: { name } });
  }
  if (path === '/api/profile/code' && method === 'POST') { // новый код; старый перестаёт работать
    if (!hasProfile) throw new HttpError(403, 'need_profile');
    const code = newCode();
    await DB.prepare('UPDATE profiles SET code_hash = ? WHERE id = ?').bind(await codeHash(code), user.profile_id).run();
    return json({ code: fmtCode(code) });
  }
  if (path === '/api/profile/logout' && method === 'POST') {
    await DB.prepare('UPDATE users SET profile_id = NULL WHERE id = ?').bind(user.id).run();
    return json({ ok: true });
  }
  if (path === '/api/profile' && method === 'DELETE') {
    if (hasProfile) await deleteProfile(env, user.profile_id, now);
    return json({ ok: true });
  }

  // --- переписка ---
  if (path === '/api/threads' && method === 'GET') {
    const { results } = await DB.prepare(`SELECT t.*, (SELECT json_object('author', m.author, 'kind', m.kind, 'body', substr(m.body, 1, 140), 'created_at', m.created_at)
        FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last
      FROM threads t WHERE ${OWNER} ORDER BY t.updated_at DESC LIMIT 100`).bind(...ownerArgs(user)).all();
    return json({ threads: results.map(publicThread), unread: results.reduce((s, t) => s + t.unread_user, 0) });
  }

  const addMessage = async (thread, b) => {
    const report = cleanReport(b.report);
    if (report && !hasProfile) throw new HttpError(403, 'need_profile'); // свои данные — только из профиля
    if (report && thread.topic !== 'specialist') throw new HttpError(400, 'report_only_specialist');
    const body = cleanBody(b.body, !report);
    await rateLimit(env, user, now);
    const stmts = [msgStmt(env, { thread: thread.id, user_id: user.id, author: 'user', kind: report ? 'report' : 'text', body, data: report, now })];
    stmts.push(DB.prepare(`UPDATE threads SET updated_at = ?, last_from = 'user', unread_admin = unread_admin + 1,
      status = CASE WHEN topic != 'idea' AND status = 'done' THEN 'open' ELSE status END WHERE id = ?`).bind(now, thread.id));
    return stmts;
  };

  if (path === '/api/threads' && method === 'POST') {
    const b = await readJson(request, 64 * 1024);
    if (!TOPICS.includes(b.topic)) throw new HttpError(400, 'bad_topic');
    let thread = b.topic === 'specialist' ? await findSpecialistThread(env, user) : null; // со специалистом — одна переписка
    const stmts = [];
    if (!thread) {
      const r = await DB.prepare('SELECT COUNT(*) AS n FROM threads WHERE user_id = ? AND created_at > ?').bind(user.id, now - 86400_000).first();
      if (r.n >= 10) throw new HttpError(429, 'too_many_threads');
      thread = { id: randomId(12), user_id: user.id, profile_id: hasProfile ? user.profile_id : null, topic: b.topic, status: 'new' };
      stmts.push(DB.prepare('INSERT INTO threads (id, user_id, profile_id, topic, status, created_at, updated_at, last_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(thread.id, user.id, thread.profile_id, b.topic, 'new', now, now, 'user'));
    }
    stmts.push(...await addMessage(thread, b));
    await DB.batch(stmts);
    later(ctx, notifyAdmin(env, { thread: thread.id, title: `Новое сообщение · ${TOPIC_TITLE[b.topic]}`, body: ownerLabel(user) }));
    return json({ thread: thread.id }, 201);
  }

  let m = path.match(/^\/api\/threads\/([A-Za-z0-9_-]{8,32})$/);
  if (m && method === 'GET') {
    const t = await ownThread(env, user, m[1]);
    const { results } = await DB.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at LIMIT 500').bind(t.id).all();
    if (t.unread_user) await DB.prepare('UPDATE threads SET unread_user = 0 WHERE id = ?').bind(t.id).run();
    return json({ thread: publicThread({ ...t, unread_user: 0 }), messages: results.map(publicMessage) });
  }
  m = path.match(/^\/api\/threads\/([A-Za-z0-9_-]{8,32})\/messages$/);
  if (m && method === 'POST') {
    const t = await ownThread(env, user, m[1]);
    const b = await readJson(request, 64 * 1024);
    await DB.batch(await addMessage(t, b));
    later(ctx, notifyAdmin(env, { thread: t.id, title: `Сообщение · ${TOPIC_TITLE[t.topic]}`, body: ownerLabel(user) }));
    return json({ ok: true }, 201);
  }

  // --- запись на консультацию ---
  if (path === '/api/slots' && method === 'GET') {
    const cfg = await bookingConfig(env);
    const base = { tz: cfg.tz, duration: cfg.duration, days: cfg.days };
    const mine = hasProfile ? publicBooking(await upcomingBooking(env, user.profile_id, now)) : null;
    if (!googleConfigured(env) || !(await googleState(env)).connected) return json({ ...base, available: false, reason: 'not_connected', mine });
    try {
      return json({ ...base, available: true, slots: await freeSlots(env, cfg, now), mine });
    } catch (e) {
      console.log('slots', String(e));
      return json({ ...base, available: false, reason: 'calendar_error', mine });
    }
  }
  if (path === '/api/bookings' && method === 'POST') {
    if (!hasProfile) throw new HttpError(403, 'need_profile');
    const b = await readJson(request, 2048);
    if (await upcomingBooking(env, user.profile_id, now)) throw new HttpError(409, 'has_booking');
    const r = await DB.prepare('SELECT COUNT(*) AS n FROM bookings WHERE profile_id = ? AND created_at > ?').bind(user.profile_id, now - 86400_000).first();
    if (r.n >= 3) throw new HttpError(429, 'too_many_bookings');
    if (!googleConfigured(env) || !(await googleState(env)).connected) throw new HttpError(503, 'calendar_not_connected');
    const cfg = await bookingConfig(env);
    const slot = (await freeSlots(env, cfg, now)).find((s) => s.start === b.start);
    if (!slot) throw new HttpError(409, 'slot_taken');
    const id = randomId(12);
    try { // сначала занимаем окно в базе (уникальный индекс не даст записаться двоим), потом — встреча в календаре
      await DB.prepare('INSERT INTO bookings (id, profile_id, user_id, start_at, end_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, user.profile_id, user.id, slot.start, slot.end, now).run();
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) throw new HttpError(409, 'slot_taken');
      throw e;
    }
    let thread = await findSpecialistThread(env, user);
    const newThread = !thread;
    if (newThread) thread = { id: randomId(12), user_id: user.id, profile_id: user.profile_id, topic: 'specialist' };
    let ev;
    try {
      ev = await createEvent(env, {
        start: slot.start, end: slot.end, tz: cfg.tz,
        summary: `DCL-832: консультация — ${user.profile_name}`,
        description: `Запись из приложения DCL-832.\nИмя: ${user.profile_name}\nПереписка: ${url.origin}/admin/#t=${thread.id}`,
      });
    } catch (e) {
      await DB.prepare('DELETE FROM bookings WHERE id = ?').bind(id).run();
      throw e;
    }
    const stmts = [DB.prepare('UPDATE bookings SET gcal_event_id = ?, meet_url = ?, thread_id = ? WHERE id = ?').bind(ev.id, ev.meet, thread.id, id)];
    if (newThread) {
      stmts.push(DB.prepare('INSERT INTO threads (id, user_id, profile_id, topic, status, created_at, updated_at, last_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(thread.id, user.id, user.profile_id, 'specialist', 'new', now, now, 'system'));
    }
    stmts.push(msgStmt(env, { thread: thread.id, author: 'system', kind: 'booking', data: { booking: id, start: slot.start, end: slot.end, meet: ev.meet }, now }));
    stmts.push(DB.prepare("UPDATE threads SET updated_at = ?, last_from = 'system', unread_admin = unread_admin + 1 WHERE id = ?").bind(now, thread.id));
    await DB.batch(stmts);
    later(ctx, notifyAdmin(env, { thread: thread.id, title: 'Новая запись на консультацию', body: user.profile_name }));
    return json({ booking: { id, start: slot.start, end: slot.end, status: 'booked', meet: ev.meet, thread: thread.id }, thread: thread.id }, 201);
  }
  m = path.match(/^\/api\/bookings\/([A-Za-z0-9_-]{8,32})\/cancel$/);
  if (m && method === 'POST') {
    if (!hasProfile) throw new HttpError(403, 'need_profile');
    const bk = await DB.prepare("SELECT * FROM bookings WHERE id = ? AND profile_id = ? AND status = 'booked'").bind(m[1], user.profile_id).first();
    if (!bk) throw new HttpError(404, 'not_found');
    await cancelBooking(env, ctx, bk, 'user', now);
    later(ctx, notifyAdmin(env, { thread: bk.thread_id, title: 'Запись отменена', body: user.profile_name }));
    return json({ ok: true });
  }
  return null;
}

// ---------- API администратора ----------

export async function handleAdminContact(request, env, ctx, path, method, url) {
  const now = Date.now();
  const DB = env.DB;

  if (path === '/api/admin/threads' && method === 'GET') {
    const { results } = await DB.prepare(`SELECT t.*, p.name AS profile_name, u.platform,
        (SELECT json_object('author', m.author, 'kind', m.kind, 'body', substr(m.body, 1, 160), 'created_at', m.created_at)
          FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last
      FROM threads t LEFT JOIN profiles p ON p.id = t.profile_id LEFT JOIN users u ON u.id = t.user_id
      ORDER BY (t.unread_admin > 0) DESC, t.updated_at DESC LIMIT 300`).all();
    return json({ now, threads: results.map((t) => ({ id: t.id, topic: t.topic, status: t.status, updated_at: t.updated_at, created_at: t.created_at,
      unread: t.unread_admin, name: t.profile_name || null, device: t.user_id.slice(0, 6), platform: t.platform, last: parse(t.last) })),
      unread: results.reduce((s, t) => s + (t.unread_admin > 0 ? 1 : 0), 0) });
  }

  let m = path.match(/^\/api\/admin\/threads\/([A-Za-z0-9_-]{8,32})$/);
  if (m && method === 'GET') {
    const t = await DB.prepare(`SELECT t.*, p.name AS profile_name, p.created_at AS profile_created, u.platform, u.created_at AS device_created, u.standalone
      FROM threads t LEFT JOIN profiles p ON p.id = t.profile_id LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ?`).bind(m[1]).first();
    if (!t) throw new HttpError(404, 'not_found');
    const [msgs, devs, books] = await DB.batch([
      DB.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at LIMIT 1000').bind(t.id),
      DB.prepare('SELECT COUNT(*) AS n FROM users WHERE profile_id = ?').bind(t.profile_id),
      DB.prepare("SELECT * FROM bookings WHERE profile_id = ? AND status = 'booked' AND end_at > ? ORDER BY start_at").bind(t.profile_id, now),
    ]);
    if (t.unread_admin) await DB.prepare('UPDATE threads SET unread_admin = 0 WHERE id = ?').bind(t.id).run();
    return json({
      thread: { id: t.id, topic: t.topic, status: t.status, created_at: t.created_at, updated_at: t.updated_at },
      owner: { name: t.profile_name || null, profile_devices: t.profile_id ? devs.results[0].n : 0, device: t.user_id.slice(0, 6),
        platform: t.platform, standalone: t.standalone, device_created: t.device_created, profile_created: t.profile_created },
      messages: msgs.results.map(publicMessage), bookings: books.results.map(publicBooking),
    });
  }
  m = path.match(/^\/api\/admin\/threads\/([A-Za-z0-9_-]{8,32})\/messages$/);
  if (m && method === 'POST') {
    const t = await DB.prepare('SELECT * FROM threads WHERE id = ?').bind(m[1]).first();
    if (!t) throw new HttpError(404, 'not_found');
    const body = cleanBody((await readJson(request, 64 * 1024)).body);
    await DB.batch([
      msgStmt(env, { thread: t.id, author: 'admin', body, now }),
      DB.prepare(`UPDATE threads SET updated_at = ?, last_from = 'admin', unread_user = unread_user + 1, unread_admin = 0,
        status = CASE WHEN status = 'new' AND topic != 'idea' THEN 'open' ELSE status END WHERE id = ?`).bind(now, t.id),
    ]);
    const title = { specialist: 'Ответ специалиста', support: 'Ответ поддержки', idea: 'Ответ по вашей идее' }[t.topic];
    later(ctx, notifyOwner(env, t, { title, body: 'Откройте DCL-832, чтобы прочитать.' }));
    return json({ ok: true }, 201);
  }
  const mt = path.match(/^\/api\/admin\/threads\/([A-Za-z0-9_-]{8,32})$/);
  if (mt && method === 'PUT') { // смена статуса
    const t = await DB.prepare('SELECT * FROM threads WHERE id = ?').bind(mt[1]).first();
    if (!t) throw new HttpError(404, 'not_found');
    const status = (await readJson(request, 2048)).status;
    if (!STATUSES[t.topic].includes(status)) throw new HttpError(400, 'bad_status');
    if (status === t.status) return json({ ok: true });
    const stmts = [DB.prepare('UPDATE threads SET status = ?, updated_at = ? WHERE id = ?').bind(status, now, t.id)];
    if (t.topic === 'idea' && IDEA_STATUS[status]) { // автор идеи видит, что с ней происходит
      stmts.push(msgStmt(env, { thread: t.id, author: 'system', kind: 'status', data: { status }, now }));
      stmts.push(DB.prepare('UPDATE threads SET unread_user = unread_user + 1, last_from = ? WHERE id = ?').bind('system', t.id));
      later(ctx, notifyOwner(env, t, { title: `Ваша идея ${IDEA_STATUS[status]}`, body: 'Подробности — во вкладке «Связь».' }));
    }
    await DB.batch(stmts);
    return json({ ok: true });
  }
  m = path.match(/^\/api\/admin\/threads\/([A-Za-z0-9_-]{8,32})\/delete$/);
  if (m && method === 'POST') {
    await DB.batch([DB.prepare('DELETE FROM messages WHERE thread_id = ?').bind(m[1]), DB.prepare('DELETE FROM threads WHERE id = ?').bind(m[1])]);
    return json({ ok: true });
  }

  // --- запись: календарь, часы приёма, ближайшие записи ---
  if (path === '/api/admin/booking' && method === 'GET') {
    const { results } = await DB.prepare(`SELECT b.*, p.name FROM bookings b LEFT JOIN profiles p ON p.id = b.profile_id
      WHERE b.status = 'booked' AND b.end_at > ? ORDER BY b.start_at LIMIT 100`).bind(now).all();
    return json({ configured: googleConfigured(env), google: await googleState(env), config: await bookingConfig(env),
      upcoming: results.map((b) => ({ ...publicBooking(b), name: b.name })) });
  }
  if (path === '/api/admin/booking' && method === 'PUT') {
    const cfg = cleanBookingConfig(await readJson(request, 4096));
    await setSetting(env, 'booking', cfg);
    return json({ config: cfg });
  }
  if (path === '/api/admin/booking/preview' && method === 'GET') {
    const cfg = await bookingConfig(env);
    if (!(await googleState(env)).connected) return json({ available: false, reason: 'not_connected', tz: cfg.tz });
    return json({ available: true, tz: cfg.tz, slots: await freeSlots(env, cfg, now) });
  }
  m = path.match(/^\/api\/admin\/bookings\/([A-Za-z0-9_-]{8,32})\/cancel$/);
  if (m && method === 'POST') {
    const bk = await DB.prepare("SELECT * FROM bookings WHERE id = ? AND status = 'booked'").bind(m[1]).first();
    if (!bk) throw new HttpError(404, 'not_found');
    await cancelBooking(env, ctx, bk, 'admin', now);
    const t = bk.thread_id && await DB.prepare('SELECT * FROM threads WHERE id = ?').bind(bk.thread_id).first();
    if (t) later(ctx, notifyOwner(env, t, { title: 'Консультация отменена', body: 'Подробности — во вкладке «Связь».' }));
    return json({ ok: true });
  }
  if (path === '/api/admin/google/disconnect' && method === 'POST') {
    await setSetting(env, 'google', null);
    return json({ ok: true });
  }

  // --- push администратору ---
  if (path === '/api/admin/push' && method === 'POST') {
    const b = await readJson(request, 4096);
    if (typeof b.endpoint !== 'string' || !/^https:\/\//.test(b.endpoint) && !(env.ALLOW_HTTP_PUSH === '1' && /^http:\/\//.test(b.endpoint))) throw new HttpError(400, 'bad_endpoint');
    if (typeof b.keys?.p256dh !== 'string' || typeof b.keys?.auth !== 'string') throw new HttpError(400, 'bad_keys');
    await DB.prepare(`INSERT INTO admin_push (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`).bind(b.endpoint, b.keys.p256dh, b.keys.auth, now).run();
    return json({ ok: true });
  }
  if (path === '/api/admin/push/test' && method === 'POST') {
    await notifyAdmin(env, { title: 'Уведомления работают', body: 'Сюда будут приходить новые сообщения и записи.' });
    return json({ ok: true });
  }
  if (path === '/api/admin/push' && method === 'DELETE') {
    const b = await readJson(request, 4096);
    await DB.prepare('DELETE FROM admin_push WHERE endpoint = ?').bind(String(b.endpoint || '')).run();
    return json({ ok: true });
  }
  return null;
}

// ---------- крон: напоминание о консультации за час ----------

export async function remindBookings(env, now) {
  const { results } = await env.DB.prepare(`SELECT b.*, t.user_id AS t_user, t.profile_id AS t_profile, t.topic FROM bookings b
    JOIN threads t ON t.id = b.thread_id WHERE b.status = 'booked' AND b.reminded = 0 AND b.start_at > ? AND b.start_at <= ? LIMIT 20`)
    .bind(now, now + 60 * 60_000).all();
  for (const b of results) {
    await env.DB.prepare('UPDATE bookings SET reminded = 1 WHERE id = ?').bind(b.id).run();
    await notifyOwner(env, { id: b.thread_id, user_id: b.t_user, profile_id: b.t_profile, topic: b.topic },
      { title: 'Скоро консультация', body: 'Ссылка на видеовстречу — во вкладке «Связь».' });
  }
  return results.length;
}
