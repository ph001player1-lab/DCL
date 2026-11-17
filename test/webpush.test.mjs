import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createPublicKey, verify } from 'node:crypto';
import { decrypt } from './push-decrypt.mjs';
import { encryptPayload, vapidAuthHeader, b64uToBytes, bytesToB64u } from '../src/webpush.js';

// Тестовый вектор из RFC 8291, Appendix A
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('RFC 8291 test vector', async () => {
  const body = await encryptPayload(V.plaintext, V.uaPublic, V.auth, { asPrivate: V.asPrivate, asPublic: V.asPublic, salt: V.salt });
  assert.equal(bytesToB64u(body), V.body);
});

test('random keys round-trip via independent Node decryption', async () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const p256dh = bytesToB64u(ua.getPublicKey());
  const auth = bytesToB64u(crypto.getRandomValues(new Uint8Array(16)));
  const msg = JSON.stringify({ pingId: 'abc', t: 123, text: 'Что вы сейчас делаете?' });
  const body = await encryptPayload(msg, p256dh, auth);
  assert.equal(decrypt(body, bytesToB64u(ua.getPrivateKey()), auth), msg);
});

test('VAPID JWT is a valid ES256 signature', async () => {
  const kp = createECDH('prime256v1');
  kp.generateKeys();
  const vapid = { publicKey: bytesToB64u(kp.getPublicKey()), privateKey: bytesToB64u(kp.getPrivateKey()), subject: 'https://dcl832.click' };
  const h = await vapidAuthHeader('https://fcm.googleapis.com/fcm/send/xyz', vapid);
  const m = h.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m);
  const [hdr, claims, sig] = m[1].split('.');
  const c = JSON.parse(Buffer.from(b64uToBytes(claims)).toString());
  assert.equal(c.aud, 'https://fcm.googleapis.com');
  assert.equal(c.sub, 'https://dcl832.click');
  const pub = b64uToBytes(vapid.publicKey);
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33)) }, format: 'jwk' });
  const ok = verify('sha256', Buffer.from(`${hdr}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(b64uToBytes(sig)));
  assert.ok(ok);
});
