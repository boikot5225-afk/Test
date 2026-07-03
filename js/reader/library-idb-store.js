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

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE_NAME);
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = () => reject(req.error);
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
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key || BLOB_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
