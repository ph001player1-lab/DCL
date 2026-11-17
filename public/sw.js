// Service worker DCL-832: офлайн-работа, приём сигналов (push) и действия из уведомления.
const VERSION = 'v3';
const CACHE = `dcl832-${VERSION}`;
const SHELL = [
  '/', '/app/', '/app/app.css', '/app/app.js', '/app/dcl.js', '/app/store.js', '/app/api.js', '/app/stats.js',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/badge-96.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Сначала сеть (всегда свежая версия), при отсутствии сети — кэш
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/books/') || url.pathname.startsWith('/media/')) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    } catch {
      const cached = await caches.match(e.request, { ignoreSearch: true });
      if (cached) return cached;
      if (e.request.mode === 'navigate') return (await caches.match(url.pathname.startsWith('/app') ? '/app/' : '/')) || Response.error();
      return Response.error();
    }
  })());
});

// ---------- IndexedDB (та же схема, что в /app/store.js) ----------
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('dcl832', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('answers')) d.createObjectStore('answers', { keyPath: 'id' }).createIndex('t', 't');
      if (!d.objectStoreNames.contains('pings')) d.createObjectStore('pings', { keyPath: 'id' }).createIndex('t', 't');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbReq(store, mode, fn) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}
const getPing = (id) => idbReq('pings', 'readonly', (s) => s.get(id));
const putPing = (p) => idbReq('pings', 'readwrite', (s) => s.put(p));
const getCreds = () => idbReq('kv', 'readonly', (s) => s.get('creds'));

async function apiCall(path, body) {
  const c = await getCreds();
  if (!c) return;
  await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${c.id}.${c.key}` },
    body: JSON.stringify(body || {}),
  });
}

const timeStr = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const answerHash = (d) => `#answer?p=${encodeURIComponent(d.id)}&t=${d.t}&exp=${d.exp}${d.test ? '&test=1' : ''}`;

// ---------- сигнал ----------
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil((async () => {
    if (d.type === 'ping' && !d.test) {
      const existing = await getPing(d.id).catch(() => null);
      await putPing({ ...existing, id: d.id, t: d.t, exp: d.exp, status: existing?.status || 'sent' }).catch(() => {});
    }
    await self.registration.showNotification('Что вы сейчас делаете?', {
      body: d.test ? 'Пробный сигнал. Так будет выглядеть замер.' : `Сигнал ${timeStr(d.t || Date.now())}. Отметьте код — это 10 секунд.`,
      tag: 'dcl-ping',
      renotify: true,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      timestamp: d.t || Date.now(),
      data: d,
      actions: d.test ? [] : [
        { action: 'skip', title: 'Пропустить' },
        { action: 'snooze', title: 'Не беспокоить 2 ч' },
      ],
    });
    for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'ping' });
  })());
});

self.addEventListener('notificationclick', (e) => {
  const d = e.notification.data || {};
  e.notification.close();
  e.waitUntil((async () => {
    if (e.action === 'skip' && d.id) {
      const p = await getPing(d.id).catch(() => null);
      await putPing({ ...p, id: d.id, t: d.t, exp: d.exp, status: 'skipped', closeSynced: true });
      await apiCall(`/api/pings/${encodeURIComponent(d.id)}/close`, { status: 'skipped' }).catch(() => {});
      return;
    }
    if (e.action === 'snooze') {
      await apiCall('/api/pause', { minutes: 120 }).catch(() => {});
      return;
    }
    const hash = d.id ? answerHash(d) : '#today';
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = wins.find((w) => new URL(w.url).pathname.startsWith('/app'));
    if (app) {
      await app.focus();
      app.postMessage({ type: 'open', hash });
      return;
    }
    await self.clients.openWindow(`/app/${hash}`);
  })());
});

// Браузер сменил подписку — сообщаем серверу новую
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const sub = e.newSubscription || await self.registration.pushManager.subscribe(e.oldSubscription.options);
    await apiCall('/api/subscribe', sub.toJSON());
  })());
});
