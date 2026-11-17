// Web Push без внешних библиотек: VAPID (RFC 8292) + шифрование aes128gcm (RFC 8291 / RFC 8188).
// Работает и в Cloudflare Workers, и в Node 20+ (WebCrypto).

const enc = new TextEncoder();

export function b64uToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64u(bytes) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// Публичный ключ P-256 в несжатом виде (65 байт) -> JWK x/y
function pubToJwk(pub) {
  return { kty: 'EC', crv: 'P-256', x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)) };
}

/**
 * Шифрует payload для подписки (RFC 8291). opts.asPrivate/asPublic/salt — только для тестов.
 * @returns {Promise<Uint8Array>} тело запроса
 */
export async function encryptPayload(payload, p256dhB64u, authB64u, opts = {}) {
  const uaPublic = b64uToBytes(p256dhB64u);
  const authSecret = b64uToBytes(authB64u);
  const plaintext = typeof payload === 'string' ? enc.encode(payload) : payload;

  let asKeys;
  let asPublic;
  if (opts.asPrivate && opts.asPublic) {
    asPublic = b64uToBytes(opts.asPublic);
    const priv = await crypto.subtle.importKey(
      'jwk', { ...pubToJwk(asPublic), d: opts.asPrivate, ext: true },
      { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    asKeys = { privateKey: priv };
  } else {
    asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  }

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = opts.salt ? b64uToBytes(opts.salt) : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(plaintext, new Uint8Array([2])); // единственная (последняя) запись
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

// JWT кэшируется на ~12 часов для каждого push-сервиса (экономит CPU воркера).
const jwtCache = new Map();

export async function vapidAuthHeader(endpoint, vapid) {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const cached = jwtCache.get(aud);
  if (cached && cached.exp - now > 3600) return `vapid t=${cached.jwt}, k=${vapid.publicKey}`;

  const exp = now + 12 * 3600;
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64u(enc.encode(JSON.stringify({ aud, exp, sub: vapid.subject })));
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    'jwk', { ...pubToJwk(b64uToBytes(vapid.publicKey)), d: vapid.privateKey, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  const jwt = `${unsigned}.${bytesToB64u(sig)}`;
  jwtCache.set(aud, { jwt, exp });
  return `vapid t=${jwt}, k=${vapid.publicKey}`;
}

/**
 * Отправляет push. subscription = { endpoint, p256dh, auth }.
 * @returns {Promise<{ok:boolean,status:number,gone:boolean}>}
 */
export async function sendPush(subscription, payload, vapid, { ttl = 1800, urgency = 'high' } = {}) {
  const body = await encryptPayload(JSON.stringify(payload), subscription.p256dh, subscription.auth);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthHeader(subscription.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
  });
  return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
}
