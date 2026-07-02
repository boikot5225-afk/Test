// IndexedDB store for original podcast/audio recordings behind a transcribed book.
// Keys are bookId; values are the original Blob (kept as-is, not the resampled WAV chunks
// used for transcription) so playback quality matches the source file.

const DB_NAME = 'reader-audio';
const STORE_NAME = 'audio';
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

export async function audioStorePut(bookId, blob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(blob, bookId);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function audioStoreGet(bookId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(bookId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function audioStoreDelete(bookId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(bookId);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
