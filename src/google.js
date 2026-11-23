// Google: вход администратора по его почте (OpenID Connect) и доступ к его календарю
// (свободное время и создание встреч с Google Meet). Без библиотек — обычные HTTPS-запросы.
import { b64uToBytes, bytesToB64u } from './webpush.js';
import { HttpError, json, randomId, sha256, getSetting, setSetting } from './util.js';
import { eventsToBusy } from './slots.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPES = 'openid email https://www.googleapis.com/auth/calendar.events';
// Адреса можно подменить для локальных тестов (поддельный Google в scripts/e2e-local.mjs)
const tokenUrl = (env) => env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const calBase = (env) => env.GOOGLE_CAL_BASE || 'https://www.googleapis.com/calendar/v3';

export const googleConfigured = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.ADMIN_EMAIL);
const redirectUri = (url) => `${url.origin}/api/admin/google/callback`;
const enc = new TextEncoder();

// ---------- refresh-токен хранится в D1 зашифрованным (ключ выводится из секрета клиента) ----------

async function aesKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`${env.GOOGLE_CLIENT_SECRET}:dcl832-refresh-token`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(text));
  return `${bytesToB64u(iv)}.${bytesToB64u(ct)}`;
}
async function unseal(env, s) {
  const [iv, ct] = s.split('.').map(b64uToBytes);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await aesKey(env), ct));
}

/** Состояние подключения календаря (без секретов) */
export async function googleState(env) {
  const g = await getSetting(env, 'google');
  if (!g) return { connected: false };
  return { connected: g.status === 'ok', status: g.status, email: g.email, connected_at: g.connected_at };
}

// ---------- доступ к календарю ----------

let cached = null; // { token, exp } — на время жизни экземпляра воркера

async function accessToken(env) {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const g = await getSetting(env, 'google');
  if (!g || g.status !== 'ok') throw new HttpError(503, 'calendar_not_connected');
  const r = await fetch(tokenUrl(env), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: await unseal(env, g.refresh), grant_type: 'refresh_token' }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.log('google refresh error', r.status, d.error);
    if (d.error === 'invalid_grant') await setSetting(env, 'google', { ...g, status: 'expired' }); // доступ отозван — нужно переподключить
    throw new HttpError(502, 'calendar_auth');
  }
  cached = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return cached.token;
}

async function cal(env, method, path, body) {
  const r = await fetch(calBase(env) + path, {
    method,
    headers: { authorization: `Bearer ${await accessToken(env)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (method === 'DELETE' && (r.status === 404 || r.status === 410)) return null; // уже удалено
  const d = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) {
    console.log('google calendar error', method, path, r.status, JSON.stringify(d?.error || d));
    if (r.status === 401) cached = null;
    throw new HttpError(502, 'calendar_error');
  }
  return d;
}

/**
 * Занятые интервалы основного календаря: [[startMs, endMs], ...].
 * Считаем по списку событий: для него хватает доступа calendar.events
 * (метод freeBusy требует отдельного разрешения).
 */
export async function freeBusy(env, timeMin, timeMax, tz) {
  const items = [];
  let page = '';
  for (let i = 0; i < 10; i++) {
    const q = new URLSearchParams({
      timeMin: new Date(timeMin).toISOString(), timeMax: new Date(timeMax).toISOString(), singleEvents: 'true', maxResults: '250', timeZone: tz,
      fields: 'items(status,transparency,eventType,start,end,attendees(self,responseStatus)),nextPageToken',
    });
    if (page) q.set('pageToken', page);
    const d = await cal(env, 'GET', `/calendars/primary/events?${q}`);
    items.push(...(d?.items || []));
    page = d?.nextPageToken;
    if (!page) break;
  }
  return eventsToBusy(items, tz);
}

/** Встреча в календаре специалиста со ссылкой Google Meet */
export async function createEvent(env, { start, end, tz, summary, description }) {
  const d = await cal(env, 'POST', '/calendars/primary/events?conferenceDataVersion=1', {
    summary, description,
    start: { dateTime: new Date(start).toISOString(), timeZone: tz },
    end: { dateTime: new Date(end).toISOString(), timeZone: tz },
    conferenceData: { createRequest: { requestId: randomId(12), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    reminders: { useDefault: true },
  });
  const meet = d.hangoutLink || d.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri || null;
  return { id: d.id, meet };
}

export async function deleteEvent(env, id) {
  if (id) await cal(env, 'DELETE', `/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=none`);
}

// ---------- вход администратора ----------

const SESSION_DAYS = 180;

export async function createAdminSession(env, via) {
  const token = randomId(32);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO admin_sessions (token_hash, created_at, expires_at, via) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), now, now + SESSION_DAYS * 86400_000, via).run();
  return token;
}

const redirect = (location, cookie) => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', ...(cookie ? { 'set-cookie': cookie } : {}) } });
const STATE_COOKIE = 'dcl_oauth';
const cookieOf = (request, name) => (request.headers.get('cookie') || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];

/** Публичные адреса входа: /api/admin/google/status | start | callback */
export async function handleGoogleAuth(request, env, url, path) {
  if (path === '/api/admin/google/status') return json({ configured: googleConfigured(env) });

  if (path === '/api/admin/google/start') {
    if (!googleConfigured(env)) return redirect('/admin/#error=not_configured');
    const state = randomId(18);
    const g = await getSetting(env, 'google');
    const consent = url.searchParams.get('mode') === 'connect' || !g || g.status !== 'ok'; // согласие нужно, чтобы получить доступ к календарю
    const p = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(url), response_type: 'code', scope: SCOPES,
      access_type: 'offline', include_granted_scopes: 'true', state, login_hint: env.ADMIN_EMAIL,
      prompt: consent ? 'consent' : 'select_account',
    });
    return redirect(`${AUTH_URL}?${p}`, `${STATE_COOKIE}=${state}; Path=/api/admin/google; Max-Age=600; HttpOnly; Secure; SameSite=Lax`);
  }

  if (path === '/api/admin/google/callback') {
    const clear = `${STATE_COOKIE}=; Path=/api/admin/google; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
    const fail = (code) => redirect(`/admin/#error=${code}`, clear);
    if (!googleConfigured(env)) return fail('not_configured');
    const state = url.searchParams.get('state');
    if (!state || state !== cookieOf(request, STATE_COOKIE)) return fail('state');
    if (url.searchParams.get('error') || !url.searchParams.get('code')) return fail('denied');
    const r = await fetch(tokenUrl(env), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: url.searchParams.get('code'), client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(url), grant_type: 'authorization_code' }),
    });
    const tok = await r.json().catch(() => ({}));
    if (!r.ok || !tok.id_token) { console.log('google token exchange', r.status, tok.error); return fail('token'); }
    // id_token получен напрямую от Google по HTTPS с секретом клиента — подпись можно не проверять (OIDC Core, 3.1.3.7)
    let claims;
    try { claims = JSON.parse(new TextDecoder().decode(b64uToBytes(tok.id_token.split('.')[1]))); } catch { return fail('token'); }
    const email = String(claims.email || '').toLowerCase();
    if (claims.aud !== env.GOOGLE_CLIENT_ID || !claims.email_verified || email !== env.ADMIN_EMAIL.trim().toLowerCase()) return fail('not_admin');
    const hasCalendar = String(tok.scope || '').includes('calendar.events');
    if (tok.refresh_token && hasCalendar) {
      await setSetting(env, 'google', { email, refresh: await seal(env, tok.refresh_token), connected_at: Date.now(), status: 'ok' });
      cached = null;
    } else if (url.searchParams.get('scope') && !hasCalendar) {
      const g = await getSetting(env, 'google');
      if (!g || g.status !== 'ok') await setSetting(env, 'google', { email, status: 'no_calendar_scope', connected_at: Date.now() });
    }
    const session = await createAdminSession(env, 'google');
    return redirect(`/admin/#session=${session}`, clear);
  }
  return null;
}
