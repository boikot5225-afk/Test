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
const IDB_READ_TIMEOUT_MS = 700;

function timeoutError(op) {
  return new Error(`[reader] word-state IndexedDB ${op} timed out`);
}

function withDeadline(executor, timeoutMs = IDB_READ_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, timeoutError('request')), timeoutMs);
    try { executor(value => finish(resolve, value), error => finish(reject, error)); }
    catch (error) { finish(reject, error); }
  });
}

function openDB() {
  if (_db) return Promise.resolve(_db);
  return withDeadline((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = (e) => {
      const db = e.target.result;
      db.onversionchange = () => {
        try { db.close(); } catch {}
        if (_db === db) _db = null;
      };
      _db = db;
      resolve(db);
    };
    req.onblocked = () => reject(new Error('[reader] word-state IndexedDB open blocked'));
    req.onerror = () => reject(req.error || new Error('[reader] word-state IndexedDB open failed'));
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
  return withDeadline((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key || BLOB_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || tx.error || new Error('[reader] word-state IndexedDB read failed'));
    tx.onabort = () => reject(tx.error || new Error('[reader] word-state IndexedDB read aborted'));
  });
}
