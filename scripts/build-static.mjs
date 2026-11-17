// Собирает файлы из ./public в модуль src/static-files.js, который воркер отдаёт сам.
// Запускается автоматически перед `wrangler dev` и `wrangler deploy` (см. [build] в wrangler.toml).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = 'public';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = {};
for (const p of walk(ROOT).sort()) {
  const ext = extname(p);
  if (!TYPES[ext]) continue;
  const buf = readFileSync(p);
  const path = '/' + relative(ROOT, p).split('\\').join('/');
  const etag = '"' + createHash('sha256').update(buf).digest('base64url').slice(0, 16) + '"';
  files[path] = { type: TYPES[ext], etag, b64: buf.toString('base64') };
}

writeFileSync('src/static-files.js',
  '// Сгенерировано scripts/build-static.mjs — не редактировать вручную.\n' +
  `export default ${JSON.stringify(files)};\n`);
console.log(`static: ${Object.keys(files).length} files`);
