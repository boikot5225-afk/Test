// IndexedDB-backed durable store for the Reader library.
//
// v1 stored the whole library array in a single value. That made every small
// progress update clone/write every EPUB again and encouraged the app to keep a
// full localStorage mirror. v2 stores every book separately and keeps only a
// lightweight index per Reader owner. Normal writes are UPSERT-only: a partial
// runtime snapshot must never delete an unrelated book. Deletion is an explicit
// per-book operation through libraryIdbDeleteBook(). The legacy v1 store is kept
// for non-destructive migration.

const DB_NAME = 'reader-library';
const DB_VERSION = 2;
const LEGACY_STORE = 'books';
const BOOK_STORE = 'book-records';
const INDEX_STORE = 'indexes';
const LEGACY_BLOB_KEY = 'all-books';
const IDB_READ_TIMEOUT_MS = 5000;
let _db = null;
const _legacyMigrations = new Map();
const _localLegacyMigrated = new Set();

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

function cleanLibraryKey(key) {
  return String(key || LEGACY_BLOB_KEY);
}

function recordKey(libraryKey, bookId) {
  return `${cleanLibraryKey(libraryKey)}\u0000${String(bookId || '')}`;
}

function bookParagraphCount(book = {}) {
  return (book.chapters || []).reduce((sum, chapter) => sum + (chapter?.paragraphs?.length || 0), 0);
}

function indexEntry(book = {}) {
  return {
    id: String(book.id || ''),
    title: book.title || 'Без названия',
    author: book.author || '',
    lang: book.lang || '',
    sourceLang: book.sourceLang || '',
    level: book.level || '',
    format: book.format || 'text',
    source: book.source || '',
    importKey: book.importKey || '',
    schemaVersion: Number(book.schemaVersion || 0),
    coverKey: book.coverKey || '',
    coverPath: book.coverPath || '',
    createdAt: book.createdAt || '',
    updatedAt: book.updatedAt || '',
    currentChapter: Math.max(0, Number(book.currentChapter) || 0),
    currentParagraph: Math.max(0, Number(book.currentParagraph) || 0),
    chapterCount: Array.isArray(book.chapters) ? book.chapters.length : Number(book.chapterCount || 0),
    paragraphCount: Array.isArray(book.chapters) ? bookParagraphCount(book) : Number(book.paragraphCount || 0),
  };
}

function sameRevision(a, b) {
  if (!a || !b) return false;
  return String(a.updatedAt || '') === String(b.updatedAt || '')
    && String(a.importKey || '') === String(b.importKey || '')
    && Number(a.schemaVersion || 0) === Number(b.schemaVersion || 0)
    && Number(a.currentChapter || 0) === Number(b.currentChapter || 0)
    && Number(a.currentParagraph || 0) === Number(b.currentParagraph || 0)
    && Number(a.chapterCount || 0) === Number(b.chapterCount || 0)
    && Number(a.paragraphCount || 0) === Number(b.paragraphCount || 0);
}

function preferNewerIndex(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a.updatedAt || 0) >= new Date(b.updatedAt || 0) ? a : b;
}

function preferRicherBook(a, b) {
  if (!a) return b;
  if (!b) return a;
  const aFull = Array.isArray(a.chapters) && a.chapters.length > 0;
  const bFull = Array.isArray(b.chapters) && b.chapters.length > 0;
  if (aFull && !bFull) return a;
  if (bFull && !aFull) return b;
  return new Date(a.updatedAt || 0) >= new Date(b.updatedAt || 0) ? a : b;
}

function mergeIndexes(previous, incoming) {
  const byId = new Map();
  for (const item of Array.isArray(previous) ? previous : []) {
    if (item?.id) byId.set(String(item.id), item);
  }
  for (const item of Array.isArray(incoming) ? incoming : []) {
    if (!item?.id) continue;
    const id = String(item.id);
    byId.set(id, preferNewerIndex(item, byId.get(id)));
  }
  return [...byId.values()].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

function openDB() {
  if (_db) return Promise.resolve(_db);
  return withDeadline((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(LEGACY_STORE)) db.createObjectStore(LEGACY_STORE);
      if (!db.objectStoreNames.contains(BOOK_STORE)) {
        const books = db.createObjectStore(BOOK_STORE, { keyPath: 'key' });
        books.createIndex('libraryKey', 'libraryKey', { unique: false });
      }
      if (!db.objectStoreNames.contains(INDEX_STORE)) db.createObjectStore(INDEX_STORE);
    };
    req.onsuccess = (event) => {
      const db = event.target.result;
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

export async function libraryIdbGetIndex(key) {
  const db = await openDB();
  const libraryKey = cleanLibraryKey(key);
  return withDeadline((resolve, reject) => {
    const tx = db.transaction(INDEX_STORE, 'readonly');
    const req = tx.objectStore(INDEX_STORE).get(libraryKey);
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
    req.onerror = () => reject(req.error || tx.error || new Error('[reader] library index read failed'));
    tx.onabort = () => reject(tx.error || new Error('[reader] library index read aborted'));
  });
}

async function readBookRecords(key, ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const db = await openDB();
  const libraryKey = cleanLibraryKey(key);
  return withDeadline((resolve, reject) => {
    const tx = db.transaction(BOOK_STORE, 'readonly');
    const store = tx.objectStore(BOOK_STORE);
    const out = new Array(ids.length);
    let remaining = ids.length;
    let failed = false;
    ids.forEach((id, index) => {
      const req = store.get(recordKey(libraryKey, id));
      req.onsuccess = () => {
        if (failed) return;
        out[index] = req.result?.book || null;
        remaining -= 1;
        if (!remaining) resolve(out.filter(Boolean));
      };
      req.onerror = () => {
        if (failed) return;
        failed = true;
        reject(req.error || tx.error || new Error('[reader] library book read failed'));
      };
    });
    tx.onabort = () => {
      if (!failed) reject(tx.error || new Error('[reader] library book read aborted'));
    };
  }, Math.max(IDB_READ_TIMEOUT_MS, 1000 + ids.length * 60));
}

export async function libraryIdbGetBook(key, bookId) {
  const rows = await readBookRecords(key, [bookId]);
  return rows[0] || null;
}

async function readLegacySnapshot(key) {
  const db = await openDB();
  if (!db.objectStoreNames.contains(LEGACY_STORE)) return null;
  const libraryKey = cleanLibraryKey(key);
  return withDeadline((resolve, reject) => {
    const tx = db.transaction(LEGACY_STORE, 'readonly');
    const store = tx.objectStore(LEGACY_STORE);
    const req = store.get(libraryKey);
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : null);
    req.onerror = () => reject(req.error || tx.error || new Error('[reader] legacy library read failed'));
  }).catch(() => null);
}

function readLegacyLocalStorageSnapshot(key) {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(cleanLibraryKey(key)) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(book => book?.id && Array.isArray(book?.chapters) && book.chapters.length > 0);
  } catch {
    return [];
  }
}

export async function libraryIdbPut(key, books) {
  const libraryKey = cleanLibraryKey(key);
  const source = Array.isArray(books) ? books.filter(book => book?.id) : [];
  const incomingIndex = source.map(indexEntry);
  const previousIndex = await libraryIdbGetIndex(libraryKey).catch(() => []);
  const previousById = new Map(previousIndex.map(item => [String(item?.id || ''), item]));
  const mergedIndex = mergeIndexes(previousIndex, incomingIndex);
  const changedIds = new Set();
  for (const item of incomingIndex) {
    if (!sameRevision(previousById.get(item.id), item)) changedIds.add(item.id);
  }

  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([BOOK_STORE, INDEX_STORE], 'readwrite');
    const store = tx.objectStore(BOOK_STORE);
    const indexStore = tx.objectStore(INDEX_STORE);

    for (const book of source) {
      const id = String(book.id || '');
      if (!changedIds.has(id)) continue;
      store.put({ key: recordKey(libraryKey, id), libraryKey, bookId: id, book });
    }
    // IMPORTANT: no implicit deletes here. During startup, owner switching,
    // migration or async cloud merge, the caller may temporarily hold only a
    // subset of the library. Only libraryIdbDeleteBook() may remove records.
    indexStore.put(mergedIndex, libraryKey);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('[reader] library IndexedDB write failed'));
    tx.onabort = () => reject(tx.error || new Error('[reader] library IndexedDB write aborted'));
  });
  return mergedIndex;
}

export async function libraryIdbPutBook(key, book) {
  if (!book?.id) return false;
  const libraryKey = cleanLibraryKey(key);
  const current = await libraryIdbGetIndex(libraryKey).catch(() => []);
  const nextEntry = indexEntry(book);
  const nextIndex = mergeIndexes(current, [nextEntry]);
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([BOOK_STORE, INDEX_STORE], 'readwrite');
    tx.objectStore(BOOK_STORE).put({
      key: recordKey(libraryKey, nextEntry.id),
      libraryKey,
      bookId: nextEntry.id,
      book,
    });
    tx.objectStore(INDEX_STORE).put(nextIndex, libraryKey);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('[reader] single book write failed'));
    tx.onabort = () => reject(tx.error || new Error('[reader] single book write aborted'));
  });
  return true;
}

export async function libraryIdbDeleteBook(key, bookId) {
  const libraryKey = cleanLibraryKey(key);
  const id = String(bookId || '');
  if (!id) return false;
  const current = await libraryIdbGetIndex(libraryKey).catch(() => []);
  const next = current.filter(item => String(item?.id || '') !== id);
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([BOOK_STORE, INDEX_STORE], 'readwrite');
    tx.objectStore(BOOK_STORE).delete(recordKey(libraryKey, id));
    tx.objectStore(INDEX_STORE).put(next, libraryKey);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('[reader] single book delete failed'));
    tx.onabort = () => reject(tx.error || new Error('[reader] single book delete aborted'));
  });
  return true;
}

async function migrateLegacySources(key) {
  const libraryKey = cleanLibraryKey(key);
  if (_legacyMigrations.has(libraryKey)) {
    await _legacyMigrations.get(libraryKey);
    return;
  }

  const migration = (async () => {
    // Old IndexedDB v1 and the old full localStorage snapshot are both valid
    // migration sources. Crucially, they must still be considered when a v2
    // index already exists: a cold external import can create the first v2 book
    // before startup has finished migrating the old library.
    const legacyIdb = await readLegacySnapshot(libraryKey);
    if (Array.isArray(legacyIdb) && legacyIdb.length) {
      await libraryIdbPut(libraryKey, legacyIdb);
    }

    if (_localLegacyMigrated.has(libraryKey)) return;
    const legacyLocal = readLegacyLocalStorageSnapshot(libraryKey);
    if (!legacyLocal.length) return;

    for (const legacyBook of legacyLocal) {
      const existing = await libraryIdbGetBook(libraryKey, legacyBook.id).catch(() => null);
      const winner = preferRicherBook(existing, legacyBook);
      if (!existing || winner === legacyBook) {
        await libraryIdbPutBook(libraryKey, legacyBook);
      }
    }
    // Mark only after every legacy full record has committed. The caller may
    // now safely replace localStorage with the tiny v2 index.
    _localLegacyMigrated.add(libraryKey);
  })()
    .catch(error => {
      console.warn('[reader] legacy library migration deferred', error);
      throw error;
    })
    .finally(() => _legacyMigrations.delete(libraryKey));

  _legacyMigrations.set(libraryKey, migration);
  await migration;
}

export async function libraryIdbGet(key) {
  const libraryKey = cleanLibraryKey(key);

  // Do this BEFORE trusting an existing v2 index. A partial index is not proof
  // that migration completed; it may have been created by a new import racing
  // with startup migration.
  await migrateLegacySources(libraryKey).catch(() => {});

  let index = await libraryIdbGetIndex(libraryKey);
  if (index.length) return readBookRecords(libraryKey, index.map(item => item.id));

  // Last-resort compatibility if both migrations were temporarily unavailable.
  const legacy = await readLegacySnapshot(libraryKey);
  if (!Array.isArray(legacy) || !legacy.length) return null;
  await libraryIdbPut(libraryKey, legacy).catch(() => {});
  index = await libraryIdbGetIndex(libraryKey).catch(() => []);
  return index.length ? readBookRecords(libraryKey, index.map(item => item.id)) : legacy;
}
