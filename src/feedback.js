// Обратная связь от тех, кто перестал пользоваться: одно уведомление «помогите нам стать лучше»,
// короткий экран с причинами и быстрыми настройками, статистика для админки.
import { sendPush } from './webpush.js';
import { tzParts } from './schedule.js';
import { HttpError, json, readJson, randomId, vapid } from './util.js';
import { createFeedbackThread } from './contact.js';

export const FEEDBACK_REASONS = ['often', 'time', 'forget', 'unclear', 'hard', 'nouse', 'break', 'other'];
const ACTIONS = ['fewer', 'pause', 'off'];
const DAY = 86400_000;

/**
 * «Пропал»: с установки ≥ 3 дней, за 7 дней пришло ≥ 10 сигналов и отвечено < 10%,
 * приложение не открывали ≥ 3 дней, сигналы включены и паузы нет.
 */
const DROPPED = `u.push_endpoint IS NOT NULL AND u.created_at < ?1 - 3 * ${DAY} AND COALESCE(u.last_seen, u.created_at) < ?1 - 3 * ${DAY}
  AND u.paused_until < ?1
  AND (SELECT COUNT(*) FROM pings p WHERE p.user_id = u.id AND p.scheduled_at > ?1 - 7 * ${DAY} AND p.status IN ('sent', 'answered', 'skipped', 'expired')) >= 10
  AND (SELECT COUNT(*) FROM pings p WHERE p.user_id = u.id AND p.scheduled_at > ?1 - 7 * ${DAY} AND p.status = 'answered') * 10
    < (SELECT COUNT(*) FROM pings p WHERE p.user_id = u.id AND p.scheduled_at > ?1 - 7 * ${DAY} AND p.status IN ('sent', 'answered', 'skipped', 'expired'))`;

/** Сейчас бодрствует: не раньше чем через час после подъёма и не позже чем за час до сна */
function awake(u, now) {
  const p = tzParts(now, u.tz);
  const m = p.h * 60 + p.mi;
  let len = u.wake_end - u.wake_start; if (len <= 0) len += 1440;
  if (len <= 120) return true;
  const from = (u.wake_start + 60) % 1440;
  return ((m - from + 1440) % 1440) <= len - 120;
}

/** Крон: одно уведомление каждому «пропавшему» устройству (за всё время) */
export async function askDropped(env, now) {
  const { results } = await env.DB.prepare(`SELECT u.id, u.tz, u.wake_start, u.wake_end, u.push_endpoint, u.push_p256dh, u.push_auth
    FROM users u WHERE u.feedback_asked_at IS NULL AND ${DROPPED} LIMIT 25`).bind(now).all();
  const anyTime = env.FEEDBACK_ANY_TIME === '1'; // для локальных тестов
  let sent = 0;
  for (const u of results) {
    if (!anyTime && !awake(u, now)) continue;
    try {
      const r = await sendPush({ endpoint: u.push_endpoint, p256dh: u.push_p256dh, auth: u.push_auth }, {
        type: 'feedback', title: 'DCL-832: помогите нам стать лучше',
        body: 'Скажите, что улучшить в приложении, — это 10 секунд и поможет сделать сервис удобнее.',
      }, vapid(env));
      if (r.gone) {
        await env.DB.prepare('UPDATE users SET push_endpoint = NULL, push_p256dh = NULL, push_auth = NULL, push_gone_at = ? WHERE id = ?').bind(now, u.id).run();
      } else if (r.ok) {
        await env.DB.prepare('UPDATE users SET feedback_asked_at = ? WHERE id = ?').bind(now, u.id).run();
        sent++;
      }
    } catch (e) { console.log('feedback push', String(e)); }
  }
  return sent;
}

/** POST /api/feedback — причины, текст, быстрое решение (реже / пауза / выключить) */
export async function handleFeedback(request, env, ctx, user, now, { replanToday, publicUser }) {
  const b = await readJson(request, 8192);
  const reasons = [...new Set((Array.isArray(b.reasons) ? b.reasons : []).filter((r) => FEEDBACK_REASONS.includes(r)))];
  const text = String(b.text ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 2000);
  const action = ACTIONS.includes(b.action) ? b.action : null;
  if (!reasons.length && !text && !action) throw new HttpError(400, 'empty');
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback WHERE user_id = ? AND created_at > ?').bind(user.id, now - DAY).first();
  if (r.n >= 3) throw new HttpError(429, 'too_many');
  const stmts = [env.DB.prepare('INSERT INTO feedback (id, user_id, created_at, reasons, text, action, asked) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(randomId(12), user.id, now, reasons.join(','), text || null, action, user.feedback_asked_at ? 1 : 0)];
  let u = { ...user };
  if (action === 'fewer') { u.pings_per_day = 3; stmts.push(env.DB.prepare('UPDATE users SET pings_per_day = 3 WHERE id = ?').bind(user.id)); }
  if (action === 'pause') { u.paused_until = now + 7 * DAY; stmts.push(env.DB.prepare('UPDATE users SET paused_until = ? WHERE id = ?').bind(u.paused_until, user.id)); }
  if (action === 'off') {
    u.push_endpoint = null;
    stmts.push(env.DB.prepare('UPDATE users SET push_endpoint = NULL, push_p256dh = NULL, push_auth = NULL WHERE id = ?').bind(user.id));
    stmts.push(env.DB.prepare("UPDATE pings SET status = 'cancelled', closed_at = ? WHERE user_id = ? AND status = 'scheduled'").bind(now, user.id));
  }
  await env.DB.batch(stmts);
  if (action === 'fewer') await replanToday(env, u, now);
  if (text) await createFeedbackThread(env, ctx, user, { text, reasons, action, now }); // своими словами — в «Сообщения» с push
  return json({ ok: true, user: publicUser(u) });
}

/** Статистика для админки («Обзор») */
export async function feedbackStats(env, now) {
  const [rows, users, dropped] = await env.DB.batch([
    env.DB.prepare('SELECT reasons, action, asked, text IS NOT NULL AS has_text, user_id FROM feedback'),
    env.DB.prepare('SELECT SUM(feedback_asked_at IS NOT NULL) AS asked, SUM(push_gone_at IS NOT NULL AND push_endpoint IS NULL) AS gone FROM users'),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM users u WHERE ${DROPPED}`).bind(now),
  ]);
  const reasons = Object.fromEntries(FEEDBACK_REASONS.map((k) => [k, 0]));
  const actions = Object.fromEntries(ACTIONS.map((k) => [k, 0]));
  const responders = new Set(), askedResponders = new Set();
  let texts = 0;
  for (const f of rows.results) {
    for (const k of (f.reasons || '').split(',').filter(Boolean)) if (k in reasons) reasons[k]++;
    if (f.action in actions) actions[f.action]++;
    if (f.has_text) texts++;
    responders.add(f.user_id);
    if (f.asked) askedResponders.add(f.user_id);
  }
  return { dropped_now: dropped.results[0].n, asked: users.results[0].asked || 0, answered_after_ask: askedResponders.size,
    responders: responders.size, answers: rows.results.length, texts, gone: users.results[0].gone || 0, reasons, actions };
}
