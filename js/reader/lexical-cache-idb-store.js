// IndexedDB-backed durable store for the reader's DeepSeek word-lookup cache
// (an2_reader_lexical_cache_v1). Same rationale as word-state-idb-store.js:
// localStorage caps out at ~5MB/origin and this cache has no size cap of its
// own, so a large vocabulary across languages/books can silently blow the
// quota. IndexedDB doesn't share that ceiling, so it backs up the same data
// as the durable copy; localStorage stays as the fast in-session cache.

const DB_NAME = 'reader-lexical-cache';
const STORE_NAME = 'cache';
const BLOB_KEY = 'all-entries';
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE_NAME);
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

export async function lexicalCacheIdbPut(key, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(data, key || BLOB_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function lexicalCacheIdbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key || BLOB_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
