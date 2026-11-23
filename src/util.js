// Общие помощники сервера.
import { bytesToB64u } from './webpush.js';

export const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});
export const err = (status, error) => json({ error }, status);

export class HttpError extends Error { constructor(status, code) { super(code); this.status = status; } }

export async function sha256(s) {
  return bytesToB64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
export const randomId = (bytes = 16) => bytesToB64u(crypto.getRandomValues(new Uint8Array(bytes)));

export async function readJson(request, maxBytes = 256 * 1024) {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'too_large');
  try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'bad_json'); }
}

export const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

export function vapid(env) {
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || 'https://dcl832.click' };
}

export async function getSetting(env, key) {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return r ? JSON.parse(r.value) : null;
}
export async function setSetting(env, key, value) {
  if (value === null) return env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
  return env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, JSON.stringify(value)).run();
}
