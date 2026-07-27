// IndexedDB-backed durable store for reader word-state (per-word colors/status).
// Same rationale as library-idb-store.js: localStorage caps out at ~5MB/origin,
// and a large vocabulary (many languages, many books) can exceed that, so the
// primary localStorage-based save silently fails once quota is hit. IndexedDB
// doesn't share that ceiling, so it backs up the same data as the durable copy;
// the existing localStorage path stays as the fast in-session cache.

// Highlight visibility is a device-local preference. A clean APK install can
// restore the actual word states from cloud while this key is absent, which made
// all restored highlights look as if they had been deleted. Default to visible;
// keep an explicit user choice of "0" untouched.
try {
  if (localStorage.getItem('an2_reader_marks_on') === null) {
    localStorage.setItem('an2_reader_marks_on', '1');
  }
} catch {}

const DB_NAME = 'reader-word-state';
const STORE_NAME = 'state';
const BLOB_KEY = 'all-words';
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

export async function wordStateIdbPut(key, state) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(state, key || BLOB_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function wordStateIdbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key || BLOB_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
