// DCL-832: сервер (Cloudflare Worker). Хранит анонимные настройки, расписание сигналов
// и — только при согласии пользователя — ответы. Статика (лендинг, PWA) отдаётся из ./public.

import { sendPush } from './webpush.js';
import { isValidTz, localDate, nextLocalMidnight, planDay } from './schedule.js';
import { json, err, HttpError, sha256, randomId, readJson, int, vapid } from './util.js';
import { handleContact, handleAdminContact, handleProContact, deleteDeviceContact, remindBookings } from './contact.js';
import { handleGoogleAuth } from './google.js';
import { handleFeedback, askDropped, feedbackStats } from './feedback.js';
import STATIC from './static-files.js';

const ANSWER_WINDOW_MIN = 30;           // сколько минут сигнал ждёт ответа
const SEND_GRACE_MS = 10 * 60_000;             // опоздавший больше чем на 10 мин сигнал не отправляем
const CATEGORIES = ['work', 'study', 'food', 'road', 'home', 'care', 'sport', 'rest', 'screen', 'talk', 'other'];
const PARTNERS = ['partner', 'child', 'parent', 'colleague', 'friend', 'other'];
const L_KINDS = ['law', 'rules', 'norms']; // уточнение «нельзя»: закон, правила места или работы, нормы круга

const PLATFORMS = ['android', 'ios', 'desktop', 'other'];
function platformFromUA(ua = '') {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Windows|Macintosh|Linux|CrOS/i.test(ua)) return 'desktop';
  return 'other';
}

function cleanSettings(body, partial) {
  const s = {};
  if (body.tz !== undefined) { if (typeof body.tz !== 'string' || !isValidTz(body.tz)) throw new HttpError(400, 'bad_tz'); s.tz = body.tz; }
  if (body.wake_start !== undefined) { if (!int(body.wake_start, 0, 1439)) throw new HttpError(400, 'bad_wake_start'); s.wake_start = body.wake_start; }
  if (body.wake_end !== undefined) { if (!int(body.wake_end, 0, 1439)) throw new HttpError(400, 'bad_wake_end'); s.wake_end = body.wake_end; }
  if (body.pings_per_day !== undefined) { if (!int(body.pings_per_day, 1, 20)) throw new HttpError(400, 'bad_pings_per_day'); s.pings_per_day = body.pings_per_day; }
  if (body.consent !== undefined) s.consent = body.consent ? 1 : 0;
  if (!partial && s.tz === undefined) s.tz = 'Europe/Moscow';
  return s;
}

async function auth(request, env) {
  const h = request.headers.get('authorization') || '';
  const m = h.match(/^Bearer ([A-Za-z0-9_-]{10,64})\.([A-Za-z0-9_-]{20,128})$/);
  if (!m) throw new HttpError(401, 'unauthorized');
  const user = await env.DB.prepare('SELECT u.*, p.name AS profile_name FROM users u LEFT JOIN profiles p ON p.id = u.profile_id WHERE u.id = ?').bind(m[1]).first();
  if (!user || user.key_hash !== await sha256(m[2])) throw new HttpError(401, 'unauthorized');
  return user;
}

function publicUser(u) {
  return {
    id: u.id, tz: u.tz, wake_start: u.wake_start, wake_end: u.wake_end, pings_per_day: u.pings_per_day,
    consent: !!u.consent, paused_until: u.paused_until, has_push: !!u.push_endpoint,
    profile: u.profile_name ? { name: u.profile_name } : null,
  };
}

// Перепланировать оставшуюся часть сегодняшнего дня (после изменения настроек или подписки)
async function replanToday(env, user, now = Date.now()) {
  const stmts = [env.DB.prepare("UPDATE pings SET status = 'cancelled', closed_at = ? WHERE user_id = ? AND status = 'scheduled'").bind(now, user.id)];
  if (user.push_endpoint) {
    const date = localDate(now, user.tz);
    for (const t of planDay(user, date, now)) {
      stmts.push(env.DB.prepare('INSERT INTO pings (id, user_id, local_date, scheduled_at) VALUES (?, ?, ?, ?)').bind(randomId(12), user.id, date, t));
    }
    stmts.push(env.DB.prepare('UPDATE users SET plan_date = ?, plan_until = ? WHERE id = ?').bind(date, nextLocalMidnight(now, user.tz), user.id));
  }
  await env.DB.batch(stmts);
}

function validateAnswer(a, now) {
  const bad = (f) => { throw new HttpError(400, `bad_answer_${f}`); };
  if (typeof a.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(a.id)) bad('id');
  if (a.ping_id != null && (typeof a.ping_id !== 'string' || a.ping_id.length > 64)) bad('ping_id');
  if (!['ping', 'manual'].includes(a.source)) bad('source');
  const minT = now - 90 * 86400_000;
  if (!Number.isFinite(a.t) || a.t < minT || a.t > now + 600_000) bad('t');
  if (!Number.isFinite(a.answered_at) || a.answered_at < minT || a.answered_at > now + 600_000) bad('answered_at');
  if (typeof a.local_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a.local_date)) bad('local_date');
  if (!int(a.local_hour, 0, 23)) bad('local_hour');
  if (!int(a.weekday, 1, 7)) bad('weekday');
  if (!CATEGORIES.includes(a.category)) bad('category');
  const label = a.label == null ? null : String(a.label).trim().slice(0, 40) || null;
  if (!['alone', 'pair', 'group'].includes(a.company)) bad('company');
  for (const k of ['d1', 'c1', 'l']) if (a[k] !== 0 && a[k] !== 1) bad(k);
  let partner = null, d2 = null, c2 = null;
  if (a.company === 'pair') {
    partner = PARTNERS.includes(a.partner) ? a.partner : 'other';
    for (const k of ['d2', 'c2']) if (!['0', '1', 'x'].includes(String(a[k]))) bad(k);
    d2 = String(a.d2); c2 = String(a.c2);
  }
  const code = a.company === 'pair' ? `${a.d1}${a.c1}${d2}${c2}${a.l}` : `${a.d1}${a.c1}${a.l}`;
  const l_kind = a.l === 0 && L_KINDS.includes(a.l_kind) ? a.l_kind : null; // старые версии приложения не присылают уточнение
  return { ...a, label, partner, d2, c2, code, l_kind };
}

// ---------- API ----------

async function handleApi(request, env, url, ctx) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  const now = Date.now();

  if (path === '/api/config' && method === 'GET') {
    return json({ vapidPublicKey: env.VAPID_PUBLIC_KEY, answerWindowMin: ANSWER_WINDOW_MIN });
  }

  if (path === '/api/register' && method === 'POST') {
    const s = cleanSettings(await readJson(request), false);
    const id = randomId(12), key = randomId(24);
    await env.DB.prepare(`INSERT INTO users (id, key_hash, created_at, tz, wake_start, wake_end, pings_per_day, consent, last_seen, platform)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, await sha256(key), now, s.tz, s.wake_start ?? 480, s.wake_end ?? 1380,
      s.pings_per_day ?? 6, s.consent ?? 0, now, platformFromUA(request.headers.get('user-agent'))).run();
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    return json({ id, key, user: publicUser(user) }, 201);
  }

  if (path === '/api/pro-contact' && method === 'POST') return handleProContact(request, env, ctx); // форма на /specialists/

  if (path.startsWith('/api/admin/google/') && method === 'GET') { // вход администратора через Google — без пароля
    const r = await handleGoogleAuth(request, env, url, path);
    if (r) return r;
  }
  if (path.startsWith('/api/admin/')) return handleAdmin(request, env, path, url, ctx);

  const user = await auth(request, env);
  if (now - (user.last_seen || 0) > 3600_000) {
    await env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(now, user.id).run();
  }

  if (path === '/api/me' && method === 'GET') return json(publicUser(user));

  if (path === '/api/heartbeat' && method === 'POST') {
    const b = await readJson(request, 2048);
    const platform = PLATFORMS.includes(b.platform) ? b.platform : platformFromUA(request.headers.get('user-agent'));
    const standalone = b.standalone ? 1 : 0;
    if (platform !== user.platform || standalone !== user.standalone || now - (user.last_seen || 0) > 600_000) {
      await env.DB.prepare('UPDATE users SET platform = ?, standalone = ?, last_seen = ? WHERE id = ?').bind(platform, standalone, now, user.id).run();
    }
    return json({ ok: true });
  }

  if (path === '/api/me' && method === 'DELETE') {
    await deleteDeviceContact(env, user); // переписка, профиль и записи на консультацию
    await env.DB.batch([
      env.DB.prepare('DELETE FROM feedback WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM answers WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM pings WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
    ]);
    return json({ ok: true });
  }

  if (path === '/api/settings' && method === 'PUT') {
    const s = cleanSettings(await readJson(request), true);
    const keys = Object.keys(s);
    if (keys.length) {
      await env.DB.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...keys.map((k) => s[k]), user.id).run();
    }
    const updated = { ...user, ...s };
    if (['tz', 'wake_start', 'wake_end', 'pings_per_day'].some((k) => k in s)) await replanToday(env, updated, now);
    return json(publicUser(updated));
  }

  if (path === '/api/subscribe' && method === 'POST') {
    const b = await readJson(request);
    const endpoint = b.endpoint, p256dh = b.keys?.p256dh, authKey = b.keys?.auth;
    if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) && !(env.ALLOW_HTTP_PUSH === '1' && /^http:\/\//.test(endpoint))) throw new HttpError(400, 'bad_endpoint');
    if (typeof p256dh !== 'string' || typeof authKey !== 'string' || p256dh.length > 200 || authKey.length > 100) throw new HttpError(400, 'bad_keys');
    await env.DB.prepare('UPDATE users SET push_endpoint = ?, push_p256dh = ?, push_auth = ? WHERE id = ?').bind(endpoint, p256dh, authKey, user.id).run();
    const updated = { ...user, push_endpoint: endpoint, push_p256dh: p256dh, push_auth: authKey };
    if (!user.push_endpoint) await replanToday(env, updated, now);
    return json(publicUser(updated));
  }

  if (path === '/api/pause' && method === 'POST') {
    const b = await readJson(request);
    const minutes = Number(b.minutes) || 0;
    let until = 0;
    if (b.until_morning) until = nextLocalMidnight(now, user.tz) + user.wake_start * 60_000 - 60_000;
    else if (minutes > 0) until = now + Math.min(minutes, 7 * 1440) * 60_000;
    await env.DB.prepare('UPDATE users SET paused_until = ? WHERE id = ?').bind(until, user.id).run();
    return json(publicUser({ ...user, paused_until: until }));
  }

  if (path === '/api/test-ping' && method === 'POST') {
    if (!user.push_endpoint) throw new HttpError(409, 'no_push');
    const r = await sendPush({ endpoint: user.push_endpoint, p256dh: user.push_p256dh, auth: user.push_auth },
      { type: 'ping', test: true, id: `test-${randomId(6)}`, t: now, exp: now + ANSWER_WINDOW_MIN * 60_000 }, vapid(env));
    if (r.gone) await env.DB.prepare('UPDATE users SET push_endpoint = NULL, push_gone_at = ? WHERE id = ?').bind(now, user.id).run();
    return json({ ok: r.ok, status: r.status });
  }

  if (path === '/api/pings' && method === 'GET') {
    const since = Math.max(Number(url.searchParams.get('since')) || 0, now - 14 * 86400_000);
    const { results } = await env.DB.prepare(`SELECT id, scheduled_at AS t, status FROM pings
      WHERE user_id = ? AND scheduled_at >= ? AND scheduled_at <= ? AND status NOT IN ('scheduled', 'cancelled', 'failed')
      ORDER BY scheduled_at`).bind(user.id, since, now).all();
    return json({ pings: results, answerWindowMin: ANSWER_WINDOW_MIN });
  }

  let m = path.match(/^\/api\/pings\/([A-Za-z0-9_-]{4,64})\/close$/);
  if (m && method === 'POST') {
    const b = await readJson(request);
    const status = b.status === 'skipped' ? 'skipped' : 'answered';
    await env.DB.prepare("UPDATE pings SET status = ?, closed_at = ? WHERE id = ? AND user_id = ? AND status IN ('sent', 'expired')")
      .bind(status, now, m[1], user.id).run();
    return json({ ok: true });
  }

  if (path === '/api/answers' && method === 'POST') {
    if (!user.consent) throw new HttpError(403, 'no_consent');
    const b = await readJson(request);
    const list = Array.isArray(b.answers) ? b.answers : [];
    if (list.length > 200) throw new HttpError(413, 'too_many');
    const rows = list.map((a) => validateAnswer(a, now));
    const stmts = [];
    for (const a of rows) {
      stmts.push(env.DB.prepare(`INSERT INTO answers (id, user_id, ping_id, source, t, answered_at, local_date, local_hour, weekday,
          category, label, company, partner, d1, c1, l, d2, c2, code, l_kind, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET category = excluded.category, label = excluded.label, company = excluded.company,
          partner = excluded.partner, d1 = excluded.d1, c1 = excluded.c1, l = excluded.l, d2 = excluded.d2, c2 = excluded.c2,
          code = excluded.code, l_kind = excluded.l_kind WHERE answers.user_id = excluded.user_id`)
        .bind(a.id, user.id, a.ping_id ?? null, a.source, a.t, a.answered_at, a.local_date, a.local_hour, a.weekday,
          a.category, a.label, a.company, a.partner, a.d1, a.c1, a.l, a.d2, a.c2, a.code, a.l_kind, now));
      if (a.ping_id && a.source === 'ping') {
        stmts.push(env.DB.prepare("UPDATE pings SET status = 'answered', closed_at = ? WHERE id = ? AND user_id = ? AND status IN ('sent', 'expired')")
          .bind(now, a.ping_id, user.id));
      }
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, saved: rows.map((a) => a.id) });
  }

  if (path === '/api/answers' && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM answers WHERE user_id = ?').bind(user.id).run();
    return json({ ok: true });
  }

  if (path === '/api/feedback' && method === 'POST') return handleFeedback(request, env, ctx, user, now, { replanToday, publicUser });

  const r = await handleContact(request, env, ctx, user, path, method, url);
  if (r) return r;

  throw new HttpError(404, 'not_found');
}

// ---------- админка ----------

/** Вход администратора: пароль ADMIN_TOKEN или сессия после входа через Google */
async function adminAuth(request, env) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (env.ADMIN_TOKEN && token.length >= 16 && token === env.ADMIN_TOKEN) return { via: 'password' };
  if (/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
    const s = await env.DB.prepare('SELECT * FROM admin_sessions WHERE token_hash = ? AND expires_at > ?').bind(await sha256(token), Date.now()).first();
    if (s) return { via: s.via, hash: s.token_hash };
  }
  throw new HttpError(401, 'unauthorized');
}

async function handleAdmin(request, env, path, url, ctx) {
  const who = await adminAuth(request, env);
  const DB = env.DB;
  const method = request.method;

  if (path === '/api/admin/me' && method === 'GET') return json({ via: who.via });
  if (path === '/api/admin/logout' && method === 'POST') {
    if (who.hash) await DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(who.hash).run();
    return json({ ok: true });
  }
  const c = await handleAdminContact(request, env, ctx, path, method, url);
  if (c) return c;

  if (path === '/api/admin/summary') {
    const now = Date.now(), DAY = 86400_000, since30 = now - 30 * DAY;
    const MSK = 10800; // даты по Москве
    const r = await DB.batch([
      DB.prepare(`SELECT COUNT(*) AS total, SUM(push_endpoint IS NOT NULL) AS with_push, SUM(consent) AS consented,
        SUM(last_seen > ?1) AS active_1d, SUM(last_seen > ?2) AS active_7d, SUM(created_at > ?1) AS new_1d, SUM(created_at > ?2) AS new_7d,
        SUM(standalone = 1) AS installed, SUM(paused_until > ?3) AS paused FROM users`).bind(now - DAY, now - 7 * DAY, now),
      DB.prepare(`SELECT COALESCE(platform, 'unknown') AS platform, COUNT(*) AS n, SUM(standalone = 1) AS installed,
        SUM(last_seen > ?) AS active_7d FROM users GROUP BY 1 ORDER BY n DESC`).bind(now - 7 * DAY),
      DB.prepare(`SELECT COUNT(*) AS cohort, SUM(last_seen >= created_at + ?) AS retained FROM users WHERE created_at < ?`).bind(7 * DAY, now - 7 * DAY),
      DB.prepare(`SELECT date(created_at / 1000 + ${MSK}, 'unixepoch') AS d, COUNT(*) AS n FROM users WHERE created_at > ? GROUP BY d ORDER BY d`).bind(since30),
      DB.prepare(`SELECT date(scheduled_at / 1000 + ${MSK}, 'unixepoch') AS d, SUM(status IN ('sent', 'answered', 'skipped', 'expired')) AS delivered,
        SUM(status = 'answered') AS answered, COUNT(DISTINCT CASE WHEN status = 'answered' THEN user_id END) AS users
        FROM pings WHERE scheduled_at > ? AND scheduled_at <= ? GROUP BY d ORDER BY d`).bind(since30, now),
      DB.prepare(`SELECT status, COUNT(*) AS n FROM pings WHERE scheduled_at > ? AND scheduled_at <= ? GROUP BY status`).bind(since30, now),
      DB.prepare(`SELECT COUNT(*) AS n, SUM(source = 'manual') AS manual, SUM(code IN ('111', '11111')) AS full,
        SUM(d1 = 1 AND c1 = 1) AS eustress, COUNT(DISTINCT user_id) AS users FROM answers`),
      DB.prepare(`SELECT SUM(d1 = 0) AS d0, SUM(c1 = 0) AS c0, SUM(l = 0) AS l0, SUM(l = 0 AND l_kind = 'law') AS l_law,
        SUM(l = 0 AND l_kind = 'rules') AS l_rules, SUM(l = 0 AND l_kind = 'norms') AS l_norms, SUM(l = 0 AND l_kind IS NULL) AS l_unknown,
        SUM(d2 = '0') AS d2_0, SUM(c2 = '0') AS c2_0 FROM answers`),
      DB.prepare(`SELECT code, user_id, COUNT(*) AS n, COUNT(DISTINCT local_date) AS days FROM answers
        WHERE code LIKE '%0%' GROUP BY code, user_id`),
      DB.prepare(`SELECT AVG(lvl) AS avg_level, COUNT(*) AS users FROM (SELECT AVG(code IN ('111', '11111')) AS lvl FROM answers GROUP BY user_id HAVING COUNT(*) >= 3)`),
      DB.prepare(`SELECT code, COUNT(*) AS n FROM answers GROUP BY code ORDER BY n DESC LIMIT 12`),
      DB.prepare(`SELECT category, COUNT(*) AS n, SUM(code NOT IN ('111', '11111')) AS with_zero,
        SUM(d1 = 0) AS d0, SUM(c1 = 0) AS c0, SUM(l = 0) AS l0 FROM answers GROUP BY category ORDER BY n DESC`),
      DB.prepare(`SELECT company, COALESCE(partner, '') AS partner, COUNT(*) AS n, SUM(code NOT IN ('111', '11111')) AS not_full,
        SUM(d2 = '0') AS d2_0, SUM(c2 = '0') AS c2_0, SUM(d2 = 'x' OR c2 = 'x') AS unknown FROM answers GROUP BY company, partner ORDER BY n DESC`),
      DB.prepare(`SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM pings) AS pings, (SELECT COUNT(*) FROM answers) AS answers,
        (SELECT COUNT(*) FROM pings WHERE status = 'failed' AND scheduled_at > ?1) AS failed_1d,
        (SELECT COUNT(*) FROM pings WHERE status IN ('sent', 'answered', 'skipped', 'expired') AND scheduled_at > ?1) AS delivered_1d,
        (SELECT COUNT(*) FROM pings WHERE status = 'scheduled' AND scheduled_at < ?2) AS stuck,
        (SELECT MAX(sent_at) FROM pings) AS last_sent,
        (SELECT COUNT(*) FROM answers WHERE created_at > ?1) AS answers_1d,
        (SELECT COUNT(*) FROM users WHERE created_at > ?1) AS users_1d`).bind(now - DAY, now - 5 * 60_000),
    ]);
    const rows = (i) => r[i].results;
    // коды с нулями: сколько раз, у скольких устройств, у скольких регулярно (в 2+ разных днях)
    const byCode = new Map();
    for (const x of rows(8)) {
      const c = byCode.get(x.code) || { code: x.code, n: 0, users: 0, regular_users: 0 };
      c.n += x.n; c.users++; if (x.days >= 2) c.regular_users++;
      byCode.set(x.code, c);
    }
    const zeroCodes = [...byCode.values()].sort((a, b) => b.regular_users - a.regular_users || b.n - a.n);
    return json({
      now, users: rows(0)[0], platforms: rows(1), retention: rows(2)[0],
      daily: { installs: rows(3), pings: rows(4) }, pings_30d: rows(5),
      answers: rows(6)[0], zero_bits: rows(7)[0], zero_codes: zeroCodes, level: rows(9)[0],
      top_codes: rows(10), by_category: rows(11), by_company: rows(12),
      load: { ...rows(13)[0], db_bytes: r[13].meta?.size_after ?? null },
      feedback: await feedbackStats(env, now),
    });
  }

  if (path === '/api/admin/devices') {
    const now = Date.now(), week = now - 7 * 86400_000;
    const { results } = await DB.prepare(`SELECT u.id, u.created_at, u.last_seen, u.platform, u.standalone, u.consent, u.pings_per_day,
        (SELECT p.name FROM profiles p WHERE p.id = u.profile_id) AS profile_name,
        u.push_endpoint IS NOT NULL AS has_push, u.paused_until, u.tz, u.wake_start, u.wake_end,
        (SELECT COUNT(*) FROM pings p WHERE p.user_id = u.id AND p.scheduled_at > ?1 AND p.scheduled_at <= ?2
          AND p.status IN ('sent', 'answered', 'skipped', 'expired')) AS delivered_7d,
        (SELECT COUNT(*) FROM pings p WHERE p.user_id = u.id AND p.scheduled_at > ?1 AND p.status = 'answered') AS answered_7d,
        (SELECT COUNT(*) FROM answers a WHERE a.user_id = u.id) AS answers,
        (SELECT AVG(a.code IN ('111', '11111')) FROM answers a WHERE a.user_id = u.id) AS level,
        (SELECT MAX(a.t) FROM answers a WHERE a.user_id = u.id) AS last_answer
      FROM users u ORDER BY COALESCE(u.last_seen, u.created_at) DESC LIMIT 500`).bind(week, now).all();
    return json({ now, devices: results.map((d) => ({ ...d, id: d.id.slice(0, 6) })) });
  }

  if (path === '/api/admin/answers.csv') {
    const { results } = await DB.prepare(`SELECT user_id, source, t, answered_at, local_date, local_hour, weekday, category, label,
      company, partner, d1, c1, d2, c2, l, l_kind, code, ping_id FROM answers ORDER BY user_id, t`).all();
    const cols = ['user_id', 'source', 't_iso', 'answered_after_sec', 'local_date', 'local_hour', 'weekday', 'category', 'label',
      'company', 'partner', 'd1', 'c1', 'd2', 'c2', 'l', 'l_kind', 'code', 'ping_id'];
    const esc = (v) => (v == null ? '' : /[",\n;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = [cols.join(',')];
    for (const r of results) {
      lines.push([r.user_id, r.source, new Date(r.t).toISOString(), Math.round((r.answered_at - r.t) / 1000), r.local_date,
        r.local_hour, r.weekday, r.category, r.label, r.company, r.partner, r.d1, r.c1, r.d2, r.c2, r.l, r.l_kind, `'${r.code}`, r.ping_id].map(esc).join(','));
    }
    return new Response('﻿' + lines.join('\n'), {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="dcl832-answers.csv"', 'cache-control': 'no-store' },
    });
  }
  throw new HttpError(404, 'not_found');
}

// ---------- крон: планирование и рассылка сигналов ----------

async function runCron(env, now = Date.now()) {
  const DB = env.DB;
  const stats = { planned: 0, sent: 0, failed: 0, cancelled: 0, expired: 0 };

  // 1. Расписание на новый день для тех, у кого наступила локальная полночь
  const { results: toPlan } = await DB.prepare(
    'SELECT * FROM users WHERE plan_until <= ? AND push_endpoint IS NOT NULL LIMIT 100').bind(now).all();
  for (const u of toPlan) {
    const date = localDate(now, u.tz);
    const stmts = [];
    if (u.plan_date !== date) {
      for (const t of planDay(u, date, now)) {
        stmts.push(DB.prepare('INSERT INTO pings (id, user_id, local_date, scheduled_at) VALUES (?, ?, ?, ?)').bind(randomId(12), u.id, date, t));
        stats.planned++;
      }
    }
    stmts.push(DB.prepare('UPDATE users SET plan_date = ?, plan_until = ? WHERE id = ?').bind(date, nextLocalMidnight(now, u.tz), u.id));
    await DB.batch(stmts);
  }

  // 2. Отправка сигналов, время которых наступило
  const { results: due } = await DB.prepare(`SELECT p.id, p.scheduled_at, u.id AS user_id, u.paused_until,
      u.push_endpoint, u.push_p256dh, u.push_auth FROM pings p JOIN users u ON u.id = p.user_id
      WHERE p.status = 'scheduled' AND p.scheduled_at <= ? ORDER BY p.scheduled_at LIMIT 50`).bind(now).all();
  const updates = [];
  const v = vapid(env);
  await Promise.all(due.map(async (p) => {
    const close = (status) => { updates.push(DB.prepare('UPDATE pings SET status = ?, closed_at = ? WHERE id = ?').bind(status, now, p.id)); stats[status]++; };
    if (p.paused_until > p.scheduled_at) return close('cancelled');
    if (!p.push_endpoint || now - p.scheduled_at > SEND_GRACE_MS) return close('failed');
    try {
      const r = await sendPush({ endpoint: p.push_endpoint, p256dh: p.push_p256dh, auth: p.push_auth },
        { type: 'ping', id: p.id, t: p.scheduled_at, exp: p.scheduled_at + ANSWER_WINDOW_MIN * 60_000 }, v);
      if (r.ok) {
        updates.push(DB.prepare("UPDATE pings SET status = 'sent', sent_at = ? WHERE id = ?").bind(now, p.id));
        stats.sent++;
      } else if (r.gone) {
        updates.push(DB.prepare('UPDATE users SET push_endpoint = NULL, push_p256dh = NULL, push_auth = NULL, push_gone_at = ? WHERE id = ?').bind(now, p.user_id));
        close('failed');
      } else {
        console.log('push error', r.status, p.id); // повторим через минуту, пока не истечёт SEND_GRACE_MS
      }
    } catch (e) {
      console.log('push exception', String(e), p.id);
    }
  }));

  // 3. Неотвеченные сигналы после окна ответа становятся пропущенными
  updates.push(DB.prepare("UPDATE pings SET status = 'expired', closed_at = ? WHERE status = 'sent' AND scheduled_at < ?")
    .bind(now, now - ANSWER_WINDOW_MIN * 60_000));
  await DB.batch(updates);

  // 4. Напоминание о консультации за час
  try { stats.reminded = await remindBookings(env, now); } catch (e) { console.log('remind', String(e)); }

  // 5. Раз в сутки (09:17 UTC = 12:17 по Москве): одно уведомление «помогите нам стать лучше» тем, кто перестал пользоваться
  const d = new Date(now);
  if (env.FEEDBACK_ANY_TIME === '1' || (d.getUTCHours() === 9 && d.getUTCMinutes() === 17)) {
    try { stats.asked = await askDropped(env, now); } catch (e) { console.log('feedback', String(e)); }
  }
  return stats;
}

// ---------- книги (PDF лежат в Workers KV, привязка BOOKS) ----------

const BOOKS = {
  'potok-lyubvi.pdf': 'Поток любви — Н. В. Буленков.pdf',
  'vremya-po-lyubvi.pdf': 'Время по любви — повесть.pdf',
};

async function serveBook(request, env, url) {
  const key = url.pathname.slice('/books/'.length);
  const name = BOOKS[key];
  const obj = name && env.BOOKS ? await env.BOOKS.get(key, { type: 'stream', cacheTtl: 3600 }) : null;
  if (!obj) return new Response('Не найдено', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return new Response(request.method === 'HEAD' ? null : obj, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    },
  });
}

// ---------- видео (MP4 в том же KV; поддержка Range — нужна Safari для перемотки) ----------

const MEDIA = { 'dcl832.mp4': 'video/mp4', 'dcl832-1.mp4': 'video/mp4', 'dcl832-2.mp4': 'video/mp4', 'dcl832-3.mp4': 'video/mp4', 'dcl832-4.mp4': 'video/mp4' };

async function serveMedia(request, env, url) {
  const key = url.pathname.slice('/media/'.length);
  const type = MEDIA[key];
  const buf = type && env.BOOKS ? await env.BOOKS.get('media/' + key, { type: 'arrayBuffer', cacheTtl: 3600 }) : null;
  if (!buf) return new Response('Не найдено', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const size = buf.byteLength;
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
  if (m) {
    let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
    let end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (!(start >= 0 && start <= end && start < size)) {
      return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
    }
    headers['content-range'] = `bytes ${start}-${end}/${size}`;
    headers['content-length'] = String(end - start + 1);
    return new Response(request.method === 'HEAD' ? null : buf.slice(start, end + 1), { status: 206, headers });
  }
  headers['content-length'] = String(size);
  return new Response(request.method === 'HEAD' ? null : buf, { headers });
}

// ---------- статика (лендинг, приложение, иконки) ----------

const decoded = new Map();
const NO_CACHE = /\.(html|js|css|webmanifest)$/;

function serveStatic(request, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
  let path = decodeURIComponent(url.pathname);
  if (path === '/webinar' || path.startsWith('/webinar/')) return Response.redirect(`${url.origin}/specialists/`, 301); // вебинар заменён разделом для специалистов
  if (['/app', '/admin', '/privacy', '/terms', '/specialists'].includes(path)) return Response.redirect(`${url.origin}${path}/${url.search}`, 301);
  if (path.endsWith('/')) path += 'index.html';
  const f = STATIC[path];
  const headers = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' };
  if (!f) return new Response('Не найдено', { status: 404, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });
  headers['content-type'] = f.type;
  headers.etag = f.etag;
  headers['cache-control'] = NO_CACHE.test(path) ? 'no-cache' : 'public, max-age=86400';
  if (request.headers.get('if-none-match') === f.etag) return new Response(null, { status: 304, headers });
  let body = decoded.get(path);
  if (!body) {
    body = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
    decoded.set(path, body);
  }
  return new Response(request.method === 'HEAD' ? null : body, { headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url, ctx);
      } catch (e) {
        if (e instanceof HttpError) return err(e.status, e.message);
        console.log('api error', e?.stack || String(e));
        return err(500, 'server_error');
      }
    }
    if (url.pathname.startsWith('/books/')) return serveBook(request, env, url);
    if (url.pathname.startsWith('/media/')) return serveMedia(request, env, url);
    return serveStatic(request, url);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env, event.scheduledTime).then((s) => {
      if (s.planned || s.sent || s.failed || s.reminded || s.asked) console.log('cron', JSON.stringify(s));
    }));
  },
};
