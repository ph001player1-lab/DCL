import assert from 'node:assert/strict';
import { createECDH, createDecipheriv, hkdfSync } from 'node:crypto';
import { b64uToBytes } from '../src/webpush.js';

// Независимая расшифровка средствами Node (как это сделал бы браузер)
export function decrypt(body, uaPrivateB64u, authB64u) {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const idlen = buf[20];
  const asPublic = buf.subarray(21, 21 + idlen);
  const ct = buf.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(b64uToBytes(uaPrivateB64u)));
  const uaPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, Buffer.from(b64uToBytes(authB64u)), keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(pt[pt.length - 1], 2, 'last record delimiter');
  return pt.subarray(0, pt.length - 1).toString();
}
