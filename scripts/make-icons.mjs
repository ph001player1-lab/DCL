// Рисует PNG-иконки из SVG (нужен Playwright/Chromium): node scripts/make-icons.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // глобально установленный Playwright
import { readFileSync } from 'node:fs';

const svg = readFileSync('public/icons/icon.svg', 'utf8');
const full = svg.replace('rx="112"', 'rx="0"');                       // для maskable и apple — без скругления
const badge = svg.replace(/<rect width="512"[^>]+\/>/, '').replace('#f6f4ef', '#ffffff'); // монохромный значок
const jobs = [
  ['icon-192.png', svg, 192], ['icon-512.png', svg, 512],
  ['maskable-512.png', full.replace('<g fill', '<g transform="translate(51 51) scale(.8)" fill'), 512],
  ['apple-touch-icon.png', full, 180], ['badge-96.png', badge, 96],
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, src, size] of jobs) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${src}`);
  await page.screenshot({ path: `public/icons/${name}`, omitBackground: true });
  console.log('icons/' + name);
}
await browser.close();
