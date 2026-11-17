// Сквозная проверка на локальном `wrangler dev --test-scheduled`:
// поддельный push-сервис принимает сигнал, проверяет подпись VAPID и расшифровывает его.
//   npx wrangler dev --test-scheduled   (в другом окне)
//   node scripts/e2e-local.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createECDH, createPublicKey, verify, randomBytes } from 'node:crypto';
import { decrypt } from '../test/push-decrypt.mjs';
import { b64uToBytes } from '../src/webpush.js';

const BASE = process.env.BASE || 'http://localhost:8787';
const ua = createECDH('prime256v1');
ua.generateKeys();
const auth = randomBytes(16).toString('base64url');
const received = [];

const { vapidPublicKey } = await (await fetch(`${BASE}/api/config`)).json();

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const m = (req.headers.authorization || '').match(/^vapid t=([^,]+), k=(.+)$/);
    assert.ok(m, 'vapid header');
    assert.equal(m[2], vapidPublicKey);
    const [h, c, s] = m[1].split('.');
    const pub = b64uToBytes(vapidPublicKey);
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(pub.slice(1, 33)).toString('base64url'), y: Buffer.from(pub.slice(33)).toString('base64url') }, format: 'jwk' });
    assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(b64uToBytes(s))), 'jwt signature');
    assert.equal(req.headers['content-encoding'], 'aes128gcm');
    const payload = JSON.parse(decrypt(Buffer.concat(chunks), ua.getPrivateKey('base64url'), auth));
    received.push(payload);
    res.writeHead(201).end();
  });
});
await new Promise((r) => server.listen(9999, r));

const api = async (path, opts = {}, token) => {
  const r = await fetch(BASE + path, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers } });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
};
const sql = (q) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'dcl832', '--local', '--json', '--command', q], { encoding: 'utf8' }))[0].results;

// 1. Регистрация
let r = await api('/api/register', { method: 'POST', body: JSON.stringify({ tz: 'Europe/Moscow', wake_start: 0, wake_end: 1439, pings_per_day: 8, consent: true }) });
assert.equal(r.status, 201);
const token = `${r.body.id}.${r.body.key}`;
const userId = r.body.id;
console.log('registered', userId);

assert.equal((await api('/api/me', {}, 'bad.tokentokentokentokentoken')).status, 401);

// 2. Подписка -> планирование сегодняшних сигналов
r = await api('/api/subscribe', { method: 'POST', body: JSON.stringify({ endpoint: 'http://127.0.0.1:9999/push/1', keys: { p256dh: ua.getPublicKey('base64url'), auth } }) }, token);
assert.equal(r.status, 200);
assert.equal(r.body.has_push, true);
let pings = sql(`SELECT * FROM pings WHERE user_id='${userId}' AND status='scheduled' ORDER BY scheduled_at`);
console.log('planned pings today:', pings.length);
assert.ok(pings.length >= 1);

// 3. Пробный сигнал
r = await api('/api/test-ping', { method: 'POST' }, token);
assert.equal(r.body.ok, true);
assert.equal(received.at(-1).test, true);

// 4. Сдвигаем первый сигнал в прошлое и запускаем крон
sql(`UPDATE pings SET scheduled_at = ${Date.now() - 30_000} WHERE id = '${pings[0].id}'`);
await fetch(`${BASE}/__scheduled?cron=*+*+*+*+*`);
await new Promise((res) => setTimeout(res, 500));
const ping = received.at(-1);
assert.equal(ping.id, pings[0].id, 'cron delivered ping');
assert.equal(sql(`SELECT status FROM pings WHERE id='${ping.id}'`)[0].status, 'sent');
console.log('cron delivered ping', ping);

// 5. Список сигналов для приложения
r = await api(`/api/pings?since=${Date.now() - 86400_000}`, {}, token);
assert.ok(r.body.pings.some((p) => p.id === ping.id));

// 6. Ответ
const now = Date.now();
const answer = { id: 'ans_' + randomBytes(6).toString('hex'), ping_id: ping.id, source: 'ping', t: ping.t, answered_at: now,
  local_date: '2026-11-17', local_hour: 12, weekday: 2, category: 'work', company: 'pair', partner: 'colleague',
  d1: 0, c1: 1, d2: 'x', c2: '1', l: 1 };
r = await api('/api/answers', { method: 'POST', body: JSON.stringify({ answers: [answer] }) }, token);
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(sql(`SELECT code FROM answers WHERE id='${answer.id}'`)[0].code, '01x11');
assert.equal(sql(`SELECT status FROM pings WHERE id='${ping.id}'`)[0].status, 'answered');
r = await api('/api/answers', { method: 'POST', body: JSON.stringify({ answers: [{ ...answer, d1: 5 }] }) }, token);
assert.equal(r.status, 400);

// 7. Настройки, пауза
r = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ pings_per_day: 3, wake_start: 600, wake_end: 1320 }) }, token);
assert.equal(r.body.pings_per_day, 3);
r = await api('/api/pause', { method: 'POST', body: JSON.stringify({ minutes: 120 }) }, token);
assert.ok(r.body.paused_until > now);

// 8. Админка
const adminToken = execFileSync('sh', ['-c', "grep ADMIN_TOKEN .dev.vars | cut -d= -f2"], { encoding: 'utf8' }).trim();
assert.equal((await api('/api/admin/summary', {}, 'wrong-token-wrong-token')).status, 401);
r = await api('/api/admin/summary', {}, adminToken);
assert.ok(r.body.totals.n >= 1);
r = await api('/api/admin/answers.csv', {}, adminToken);
assert.ok(r.body.includes("'01x11"));

// 9. Отзыв согласия и удаление
r = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ consent: false }) }, token);
assert.equal((await api('/api/answers', { method: 'POST', body: JSON.stringify({ answers: [answer] }) }, token)).status, 403);
r = await api('/api/me', { method: 'DELETE' }, token);
assert.equal(r.body.ok, true);
assert.equal(sql(`SELECT COUNT(*) AS n FROM answers WHERE user_id='${userId}'`)[0].n, 0);
assert.equal((await api('/api/me', {}, token)).status, 401);

console.log('\nE2E OK');
server.close();
