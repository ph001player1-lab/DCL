// Генерирует ключи VAPID (для push-уведомлений) и пароль админки.
//   node scripts/setup-secrets.mjs --dev     -> пишет .dev.vars для локального запуска
//   node scripts/setup-secrets.mjs --deploy  -> загружает секреты в Cloudflare (wrangler secret bulk)
// ВАЖНО: ключи VAPID генерируются один раз. Если их сменить после запуска,
// все подписки пользователей перестанут работать (придётся заново включать уведомления).
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const mode = process.argv[2];
if (!['--dev', '--deploy'].includes(mode)) {
  console.log('Использование: node scripts/setup-secrets.mjs --dev | --deploy');
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({ format: 'jwk' });
const priv = privateKey.export({ format: 'jwk' });
const b = (s) => Buffer.from(s, 'base64url');
const secrets = {
  VAPID_PUBLIC_KEY: Buffer.concat([Buffer.from([4]), b(pub.x), b(pub.y)]).toString('base64url'),
  VAPID_PRIVATE_KEY: priv.d,
  ADMIN_TOKEN: randomBytes(24).toString('base64url'),
};

if (mode === '--dev') {
  if (existsSync('.dev.vars') && !process.argv.includes('--force')) {
    console.log('.dev.vars уже есть (добавьте --force, чтобы перезаписать)');
    process.exit(0);
  }
  writeFileSync('.dev.vars', Object.entries({ ...secrets, ALLOW_HTTP_PUSH: '1' }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  console.log('Записан .dev.vars. Пароль админки (локально):', secrets.ADMIN_TOKEN);
} else {
  if (!process.argv.includes('--yes')) {
    console.log('Это создаст НОВЫЕ ключи push. Делайте это один раз, до первых пользователей.');
    console.log('Повторите с флагом --yes:  node scripts/setup-secrets.mjs --deploy --yes');
    process.exit(0);
  }
  const dir = mkdtempSync(join(tmpdir(), 'dcl-'));
  const file = join(dir, 'secrets.json');
  writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  try {
    execFileSync('npx', ['wrangler', 'secret', 'bulk', file], { stdio: 'inherit' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('\nГотово. Сохраните пароль админки (страница /admin/):\n\n  ' + secrets.ADMIN_TOKEN + '\n');
}
