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

const PUSH_PATH = '/push/' + randomBytes(6).toString('hex'); // уникальный адрес этого прогона
const ADMIN_PUSH_PATH = '/push/admin-' + randomBytes(6).toString('hex');
const adminUa = createECDH('prime256v1'); adminUa.generateKeys();
const adminAuth = randomBytes(16).toString('base64url');
const adminReceived = [];
const server = http.createServer((req, res) => {
  if (req.url === ADMIN_PUSH_PATH) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { adminReceived.push(JSON.parse(decrypt(Buffer.concat(chunks), adminUa.getPrivateKey('base64url'), adminAuth))); res.writeHead(201).end(); });
    return;
  }
  if (req.url !== PUSH_PATH) { req.resume(); res.writeHead(201).end(); return; } // хвосты прошлых прогонов
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

// Поддельный Google: обмен кода, refresh-токен, свободное время и встречи календаря
const gEvents = new Map();
const gDeleted = [];
const gBusy = [];
const google = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
    if (req.url === '/token') {
      const f = new URLSearchParams(body);
      if (f.get('grant_type') === 'authorization_code') {
        const claims = { aud: f.get('client_id'), email: f.get('code') === 'intruder' ? 'someone@example.test' : 'Admin@Example.test', email_verified: true };
        const idToken = ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
        return send(200, { access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-1', id_token: idToken,
          scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events' });
      }
      if (f.get('grant_type') === 'refresh_token' && f.get('refresh_token') === 'rt-1') return send(200, { access_token: 'at-2', expires_in: 3600 });
      return send(400, { error: 'invalid_grant' });
    }
    if (req.headers.authorization !== 'Bearer at-2' && req.headers.authorization !== 'Bearer at-1') return send(401, { error: 'auth' });
    if (req.method === 'GET' && req.url.startsWith('/calendar/v3/calendars/primary/events?')) {
      return send(200, { items: [...gBusy.map((b) => ({ status: 'confirmed', start: { dateTime: b.start }, end: { dateTime: b.end } })),
        { status: 'confirmed', transparency: 'transparent', start: { date: '2020-01-01' }, end: { date: '2030-01-01' } }] }); // «свободно» не мешает
    }
    if (req.url.startsWith('/calendar/v3/calendars/primary/events') && req.method === 'POST') {
      const ev = JSON.parse(body); const id = 'ev' + (gEvents.size + 1);
      gEvents.set(id, ev);
      return send(200, { id, hangoutLink: 'https://meet.google.com/abc-defg-hij' });
    }
    const m = req.url.match(/^\/calendar\/v3\/calendars\/primary\/events\/([^?]+)/);
    if (m && req.method === 'DELETE') { gDeleted.push(m[1]); res.writeHead(204).end(); return; }
    send(404, { error: 'nf' });
  });
});
await new Promise((r) => google.listen(9998, r));

const api = async (path, opts = {}, token) => {
  const r = await fetch(BASE + path, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers } });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text() };
};
const sql = (q) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'dcl832', '--local', '--json', '--command', q], { encoding: 'utf8' }))[0].results;

// 0. Убрать хвосты прерванных прогонов (устройства с подпиской на этот поддельный push-сервис)
sql("DELETE FROM pings WHERE user_id IN (SELECT id FROM users WHERE push_endpoint LIKE 'http://127.0.0.1:9999/%')");
sql("DELETE FROM users WHERE push_endpoint LIKE 'http://127.0.0.1:9999/%'");

// 1. Регистрация
let r = await api('/api/register', { method: 'POST', body: JSON.stringify({ tz: 'Europe/Moscow', wake_start: 0, wake_end: 1439, pings_per_day: 8, consent: true }) });
assert.equal(r.status, 201);
const token = `${r.body.id}.${r.body.key}`;
const userId = r.body.id;
console.log('registered', userId);

assert.equal((await api('/api/me', {}, 'bad.tokentokentokentokentoken')).status, 401);

// 2. Подписка -> планирование сегодняшних сигналов
r = await api('/api/subscribe', { method: 'POST', body: JSON.stringify({ endpoint: `http://127.0.0.1:9999${PUSH_PATH}`, keys: { p256dh: ua.getPublicKey('base64url'), auth } }) }, token);
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
const answerL = { ...answer, id: 'ansL_' + randomBytes(6).toString('hex'), ping_id: null, source: 'manual', company: 'alone', l: 0, l_kind: 'rules' };
r = await api('/api/answers', { method: 'POST', body: JSON.stringify({ answers: [answerL] }) }, token);
assert.equal(r.status, 200);
const rowL = sql(`SELECT code, l_kind FROM answers WHERE id='${answerL.id}'`)[0];
assert.equal(rowL.code, '010'); assert.equal(rowL.l_kind, 'rules');

// 6b. Отметка присутствия
r = await api('/api/heartbeat', { method: 'POST', body: JSON.stringify({ platform: 'android', standalone: 1 }) }, token);
assert.equal(r.status, 200);
assert.equal(sql(`SELECT platform, standalone FROM users WHERE id='${userId}'`)[0].platform, 'android');

// 7. Настройки, пауза
r = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ pings_per_day: 3, wake_start: 600, wake_end: 1320 }) }, token);
assert.equal(r.body.pings_per_day, 3);
r = await api('/api/pause', { method: 'POST', body: JSON.stringify({ minutes: 120 }) }, token);
assert.ok(r.body.paused_until > now);

// 8. Админка
const adminToken = execFileSync('sh', ['-c', "grep ADMIN_TOKEN .dev.vars | cut -d= -f2"], { encoding: 'utf8' }).trim();
assert.equal((await api('/api/admin/summary', {}, 'wrong-token-wrong-token')).status, 401);
r = await api('/api/admin/summary', {}, adminToken);
assert.ok(r.body.answers.n >= 1, 'summary answers');
assert.ok(r.body.zero_codes.some((c) => c.code === '01x11'), 'zero code listed');
assert.ok(r.body.zero_bits.d0 >= 1, 'zero bits');
assert.ok(r.body.platforms.some((p) => p.platform === 'android'), 'platform android');
r = await api('/api/admin/devices', {}, adminToken);
const dev = r.body.devices.find((d) => userId.startsWith(d.id));
assert.ok(dev, 'device listed'); assert.equal(dev.standalone, 1); assert.equal(dev.answers, 2);
r = await api('/api/admin/answers.csv', {}, adminToken);
assert.ok(r.body.includes("'01x11"));

// 8б. «Связь»: профиль, переписка, ответ администратора, статус идеи, Google-вход, запись, push администратору
const tokenOf = (rb) => `${rb.id}.${rb.key}`;
const reg = async () => tokenOf((await api('/api/register', { method: 'POST', body: JSON.stringify({ tz: 'Europe/Moscow' }) })).body);
const tokenB = await reg(), tokenC = await reg();

// аноним C: вопрос в поддержку можно, свои данные — нельзя
r = await api('/api/threads', { method: 'POST', body: JSON.stringify({ topic: 'support', body: 'Не приходят сигналы' }) }, tokenC);
assert.equal(r.status, 201, JSON.stringify(r.body));
const supportThread = r.body.thread;
const report = { v: 1, days: 7, n: 12, full: 5, zero: 7, unknown: 0, zero_codes: [{ code: '011', n: 5, days: 3, regular: true }] };
r = await api('/api/threads', { method: 'POST', body: JSON.stringify({ topic: 'specialist', body: '', report }) }, tokenC);
assert.equal(r.status, 403); assert.equal(r.body.error, 'need_profile');
r = await api('/api/threads', { method: 'POST', body: JSON.stringify({ topic: 'specialist', body: 'Можно спросить анонимно?' }) }, tokenC);
assert.equal(r.status, 201);

// профиль на A: имя + код; вход по коду на B
r = await api('/api/threads', { method: 'POST', body: JSON.stringify({ topic: 'idea', body: 'Хочу свою категорию «Сад»' }) }, token);
const ideaThread = r.body.thread;
r = await api('/api/profile', { method: 'POST', body: JSON.stringify({ name: '  Николай  ' }) }, token);
assert.equal(r.status, 201); assert.equal(r.body.profile.name, 'Николай');
assert.match(r.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
const code = r.body.code;
const profileId = sql(`SELECT profile_id FROM users WHERE id = '${userId}'`)[0].profile_id;
assert.equal((await api('/api/me', {}, token)).body.profile.name, 'Николай');
r = await api('/api/profile/login', { method: 'POST', body: JSON.stringify({ code: 'AAAA-BBBB-CCCC' }) }, tokenB);
assert.equal(r.status, 404);
r = await api('/api/profile/login', { method: 'POST', body: JSON.stringify({ code: code.toLowerCase().replace(/-/g, ' ') }) }, tokenB);
assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.profile.name, 'Николай');
// идея, начатая анонимно на A, видна на B
r = await api('/api/threads', {}, tokenB);
assert.ok(r.body.threads.some((t) => t.id === ideaThread));
// вопрос специалисту со снимком недели — из профиля можно; вторая отправка идёт в ту же переписку
r = await api('/api/threads', { method: 'POST', body: JSON.stringify({ topic: 'specialist', body: '', report }) }, tokenB);
assert.equal(r.status, 201); const specThread = r.body.thread;
r = await api('/api/threads', { method: 'POST', body: JSON.stringify({ topic: 'specialist', body: 'Что значит 011?' }) }, token);
assert.equal(r.body.thread, specThread);
r = await api(`/api/threads/${specThread}`, {}, token);
assert.deepEqual(r.body.messages.map((m) => m.kind), ['report', 'text']);
assert.equal(r.body.messages[0].data.zero_codes[0].code, '011');
assert.equal((await api(`/api/threads/${specThread}`, {}, tokenC)).status, 404); // чужая переписка
// неверные коды: после 5 попыток — пауза
for (let i = 0; i < 5; i++) await api('/api/profile/login', { method: 'POST', body: JSON.stringify({ code: 'ZZZZ-ZZZZ-ZZZ' + (i + 2) }) }, tokenC);
assert.equal((await api('/api/profile/login', { method: 'POST', body: JSON.stringify({ code }) }, tokenC)).status, 429);

// администратор: вход через Google (поддельный), только с почтой из ADMIN_EMAIL
const raw = (path, opts = {}) => fetch(BASE + path, { redirect: 'manual', ...opts });
assert.equal((await (await raw('/api/admin/google/status')).json()).configured, true);
let g = await raw('/api/admin/google/start?mode=connect');
assert.equal(g.status, 302);
const state = new URL(g.headers.get('location')).searchParams.get('state');
assert.equal(new URL(g.headers.get('location')).searchParams.get('prompt'), 'consent');
const cookie = `dcl_oauth=${state}`;
g = await raw(`/api/admin/google/callback?code=intruder&state=${state}`, { headers: { cookie } });
assert.match(g.headers.get('location'), /#error=not_admin/);
g = await raw(`/api/admin/google/callback?code=ok&state=wrong`, { headers: { cookie } });
assert.match(g.headers.get('location'), /#error=state/);
g = await raw(`/api/admin/google/callback?code=ok&state=${state}&scope=x`, { headers: { cookie } });
const session = (g.headers.get('location').match(/#session=([\w-]+)/) || [])[1];
assert.ok(session, g.headers.get('location'));
assert.equal((await api('/api/admin/me', {}, session)).body.via, 'google');

// администратор видит переписки, отвечает — владельцу приходит push
r = await api('/api/admin/threads', {}, session);
assert.ok(r.body.threads.find((t) => t.id === specThread && t.name === 'Николай' && t.unread > 0));
r = await api(`/api/admin/threads/${specThread}`, {}, session);
assert.equal(r.body.owner.name, 'Николай'); assert.equal(r.body.owner.profile_devices, 2);
const before = received.length;
r = await api(`/api/admin/threads/${specThread}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Давайте разберём 011 на консультации.' }) }, session);
assert.equal(r.status, 201);
await new Promise((res) => setTimeout(res, 400));
assert.ok(received.slice(before).some((p) => p.type === 'msg' && p.thread === specThread && p.title === 'Ответ специалиста'));
assert.equal((await api('/api/threads', {}, tokenB)).body.unread, 1);
r = await api(`/api/admin/threads/${ideaThread}`, { method: 'PUT', body: JSON.stringify({ status: 'in_progress' }) }, session);
r = await api(`/api/threads/${ideaThread}`, {}, token);
assert.equal(r.body.thread.status, 'in_progress'); assert.equal(r.body.messages.at(-1).kind, 'status');

// push администратору
r = await api('/api/admin/push', { method: 'POST', body: JSON.stringify({ endpoint: `http://127.0.0.1:9999${ADMIN_PUSH_PATH}`, keys: { p256dh: adminUa.getPublicKey('base64url'), auth: adminAuth } }) }, session);
assert.equal(r.status, 200);
await api(`/api/threads/${supportThread}/messages`, { method: 'POST', body: JSON.stringify({ body: 'Уже пришли, спасибо' }) }, tokenC);
await new Promise((res) => setTimeout(res, 400));
assert.ok(adminReceived.some((p) => p.type === 'admin' && p.thread === supportThread), JSON.stringify(adminReceived));

// запись: окна из поддельного календаря, встреча с Meet, отмена
r = await api('/api/admin/booking', { method: 'PUT', body: JSON.stringify({ tz: 'Europe/Moscow', start: 0, end: 1440, duration: 60, step: 60, lead: 0, days: 3, weekdays: [1, 2, 3, 4, 5, 6, 7] }) }, session);
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal((await api('/api/admin/booking', {}, session)).body.google.connected, true);
assert.equal((await api('/api/slots', {}, tokenC)).body.available, true);
assert.equal((await api('/api/bookings', { method: 'POST', body: JSON.stringify({ start: 0 }) }, tokenC)).status, 403); // без профиля нельзя
r = await api('/api/slots', {}, tokenB);
assert.ok(r.body.slots.length > 24, String(r.body.slots?.length));
const slot = r.body.slots[1];
gBusy.push({ start: new Date(r.body.slots[0].start).toISOString(), end: new Date(r.body.slots[0].end).toISOString() });
assert.ok(!(await api('/api/slots', {}, tokenB)).body.slots.some((x) => x.start === r.body.slots[0].start), 'занятое время исключено');
r = await api('/api/bookings', { method: 'POST', body: JSON.stringify({ start: slot.start }) }, tokenB);
assert.equal(r.status, 201, JSON.stringify(r.body));
assert.equal(r.body.thread, specThread); assert.equal(r.body.booking.meet, 'https://meet.google.com/abc-defg-hij');
const booking = r.body.booking;
assert.match(gEvents.get('ev1').summary, /Николай/);
assert.equal(gEvents.get('ev1').conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
assert.equal((await api('/api/bookings', { method: 'POST', body: JSON.stringify({ start: slot.start }) }, token)).status, 409); // одна запись на профиль
assert.ok(!(await api('/api/slots', {}, tokenC)).body.slots.some((x) => x.start === slot.start), 'занятое записью окно скрыто');
assert.equal((await api('/api/slots', {}, token)).body.mine.id, booking.id);
r = await api(`/api/threads/${specThread}`, {}, token);
assert.equal(r.body.messages.at(-1).kind, 'booking');
assert.equal((await api('/api/admin/booking', {}, session)).body.upcoming[0].name, 'Николай');
r = await api(`/api/bookings/${booking.id}/cancel`, { method: 'POST' }, token);
assert.equal(r.status, 200); assert.deepEqual(gDeleted, ['ev1']);
assert.equal((await api(`/api/threads/${specThread}`, {}, token)).body.messages.at(-1).kind, 'booking_cancel');

// выход из профиля на B: переписка профиля больше не видна
await api('/api/profile/logout', { method: 'POST' }, tokenB);
assert.ok(!(await api('/api/threads', {}, tokenB)).body.threads.some((t) => t.id === specThread));
assert.equal((await api('/api/admin/logout', { method: 'POST' }, session)).status, 200);
assert.equal((await api('/api/admin/me', {}, session)).status, 401);
console.log('contact OK');

// 9. Отзыв согласия и удаление
r = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ consent: false }) }, token);
assert.equal((await api('/api/answers', { method: 'POST', body: JSON.stringify({ answers: [answer] }) }, token)).status, 403);
r = await api('/api/me', { method: 'DELETE' }, token);
assert.equal(r.body.ok, true);
assert.equal(sql(`SELECT COUNT(*) AS n FROM answers WHERE user_id='${userId}'`)[0].n, 0);
assert.equal((await api('/api/me', {}, token)).status, 401);
// удаление устройства с профилем удаляет профиль и его переписку
assert.equal(sql(`SELECT COUNT(*) AS n FROM threads WHERE id = '${specThread}'`)[0].n, 0);
assert.equal(sql(`SELECT COUNT(*) AS n FROM profiles WHERE id = '${profileId}'`)[0].n, 0);
assert.equal(sql(`SELECT COUNT(*) AS n FROM users WHERE profile_id = '${profileId}'`)[0].n, 0);
for (const t of [tokenB, tokenC]) await api('/api/me', { method: 'DELETE' }, t);

console.log('\nE2E OK');
server.close(); google.close();
