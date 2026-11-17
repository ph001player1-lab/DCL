// Обращения к серверу. Приложение работает и без сети: ошибки сети не ломают интерфейс.
import { kvGet, kvSet } from './store.js';

export class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}

let creds = null;
export async function getCreds() {
  if (!creds) creds = (await kvGet('creds')) || null;
  return creds;
}
export async function setCreds(c) { creds = c; await kvSet('creds', c); }

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth) {
    const c = await getCreds();
    if (!c) throw new ApiError(0, 'not_registered');
    headers.authorization = `Bearer ${c.id}.${c.key}`;
  }
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || 'http_' + res.status);
  return data;
}
