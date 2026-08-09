// IndexedDB-backed durable store for the reader book library.
// localStorage caps out at ~5MB/origin in most browsers, which the book
// library (transcripts, translations, analyses) can exceed after enough
// imports — writes then fail silently, silently rolling back to whatever
// snapshot last fit. IndexedDB has a much larger practical quota (hundreds
// of MB to low GB), so it's used here as the durable backing store; the
// existing localStorage-based code path keeps working as a fast in-session
// cache on top of the in-memory books array.

const DB_NAME = 'reader-library';
const STORE_NAME = 'books';
const BLOB_KEY = 'all-books';
let _db = null;
const IDB_READ_TIMEOUT_MS = 1200;

function timeoutError(op) {
  return new Error(`[reader] library IndexedDB ${op} timed out`);
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
    req.onblocked = () => reject(new Error('[reader] library IndexedDB open blocked'));
    req.onerror = () => reject(req.error || new Error('[reader] library IndexedDB open failed'));
  });
}

export async function libraryIdbPut(key, books) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(books, key || BLOB_KEY);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function libraryIdbGet(key) {
  const db = await openDB();
  return withDeadline((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key || BLOB_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || tx.error || new Error('[reader] library IndexedDB read failed'));
    tx.onabort = () => reject(tx.error || new Error('[reader] library IndexedDB read aborted'));
  });
}
