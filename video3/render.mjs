// Рендер ролика DCL-832 (ролик 3) из video3/index.html.
//   node video3/render.mjs --stills 14,31,48,76,95,116 --out video/out    -> PNG-кадры
//   node video3/render.mjs --video video/out/dcl832.mp4 --audio video/assets/mix.wav [--fps 30] [--from 0 --to 118.3]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright'); // глобально установленный Playwright
const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
await page.addInitScript(() => { window.__RENDERER__ = true; });
await page.goto(pathToFileURL(resolve(here, 'index.html')).href);
await page.evaluate((w) => window.setWords(w), JSON.parse(readFileSync(resolve(here, 'assets/words.json'), 'utf8')));
await page.evaluate(() => document.fonts.ready);
const END = await page.evaluate(() => window.TIMES.END);

if (arg('stills')) {
  const out = arg('out', resolve(here, 'out'));
  mkdirSync(out, { recursive: true });
  for (const t of arg('stills').split(',').map(Number)) {
    await page.evaluate((x) => window.render(x), t);
    if (process.argv.includes('--nocap')) await page.evaluate(() => { document.getElementById('cap').style.opacity = 0; });
    const file = `${out}/still-${String(t).replace('.', '_')}.png`;
    await page.screenshot({ path: file });
    console.log(file);
  }
} else if (arg('video')) {
  const fps = Number(arg('fps', 30));
  const from = Number(arg('from', 0)), to = Number(arg('to', END));
  const outFile = arg('video'); mkdirSync(dirname(outFile), { recursive: true });
  const audio = arg('audio');
  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    ...(audio ? ['-ss', String(from), '-t', String(to - from), '-i', audio] : []),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart',
    ...(audio ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : []), outFile], { stdio: ['pipe', 'inherit', 'inherit'] });
  const frames = Math.round((to - from) * fps);
  const t0 = Date.now();
  for (let i = 0; i < frames; i++) {
    await page.evaluate((x) => window.render(x), from + i / fps);
    const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 300 === 0) console.log(`frame ${i}/${frames} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  console.log('video:', outFile);
}
await browser.close();
