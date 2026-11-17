// Локальное хранилище на телефоне (IndexedDB). Та же схема используется в /sw.js.
const DB_NAME = 'dcl832';
const DB_VERSION = 1;

let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
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
  return dbp;
}

function tx(store, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
    t.onerror = () => reject(t.error);
  }));
}

export const kvGet = (k) => tx('kv', 'readonly', (s) => s.get(k));
export const kvSet = (k, v) => tx('kv', 'readwrite', (s) => { s.put(v, k); });
export const put = (store, v) => tx(store, 'readwrite', (s) => { s.put(v); });
export const get = (store, id) => tx(store, 'readonly', (s) => s.get(id));
export const all = (store) => tx(store, 'readonly', (s) => s.getAll());
export const clear = (store) => tx(store, 'readwrite', (s) => { s.clear(); });

export async function putMany(store, items) {
  if (!items.length) return;
  await tx(store, 'readwrite', (s) => { for (const v of items) s.put(v); });
}

/** Записи с t >= since, по возрастанию времени */
export const since = (store, ms) => tx(store, 'readonly', (s) => s.index('t').getAll(IDBKeyRange.lowerBound(ms)));
