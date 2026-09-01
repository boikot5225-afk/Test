#!/usr/bin/env python3
from pathlib import Path
import re

path = Path('js/reader/library-idb-store.js')
source = path.read_text(encoding='utf-8')

if 'toc126 migration commit guard' in source:
    print('toc126 storage migration guard already materialized')
    raise SystemExit(0)

needle = '''function preferRicherBook(a, b) {
  if (!a) return b;
  if (!b) return a;
  const aFull = Array.isArray(a.chapters) && a.chapters.length > 0;
  const bFull = Array.isArray(b.chapters) && b.chapters.length > 0;
  if (aFull && !bFull) return a;
  if (bFull && !aFull) return b;
  return new Date(a.updatedAt || 0) >= new Date(b.updatedAt || 0) ? a : b;
}
'''
replacement = needle + '''
// toc126 migration commit guard: an index row is metadata, never proof that
// the corresponding full EPUB payload exists. Only a record with chapters is
// allowed to satisfy legacy migration before localStorage is compacted.
function isFullBook(book) {
  return !!(book?.id && Array.isArray(book?.chapters) && book.chapters.length > 0);
}
'''
if needle not in source:
    raise SystemExit('preferRicherBook anchor not found')
source = source.replace(needle, replacement, 1)

needle = '''async function readBookRecords(key, ids) {
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
'''
replacement = needle + '''
async function verifyFullRecords(key, books) {
  const expected = (Array.isArray(books) ? books : []).filter(isFullBook);
  if (!expected.length) return true;
  const rows = await readBookRecords(key, expected.map(book => String(book.id)));
  const byId = new Map(rows.filter(book => book?.id).map(book => [String(book.id), book]));
  const missing = expected
    .filter(book => !isFullBook(byId.get(String(book.id))))
    .map(book => String(book.id));
  if (missing.length) {
    throw new Error(`[reader] durable full-book verification failed: ${missing.join(',')}`);
  }
  return true;
}
'''
if needle not in source:
    raise SystemExit('readBookRecords anchor not found')
source = source.replace(needle, replacement, 1)

old_loop = '''    for (const book of source) {
      const id = String(book.id || '');
      if (!changedIds.has(id)) continue;
      store.put({ key: recordKey(libraryKey, id), libraryKey, bookId: id, book });
    }
'''
new_loop = '''    for (const book of source) {
      const id = String(book.id || '');
      const full = isFullBook(book);
      // A full payload must always refresh the record even when its lightweight
      // index revision happens to match. That exact state can occur when an
      // index-only write races legacy migration; skipping here creates a ghost
      // index with no chapters and loses the old book on compaction.
      if (!full) continue;
      store.put({ key: recordKey(libraryKey, id), libraryKey, bookId: id, book });
    }
'''
if old_loop not in source:
    raise SystemExit('libraryIdbPut record loop not found')
source = source.replace(old_loop, new_loop, 1)

old_return = '''  });
  return mergedIndex;
}

export async function libraryIdbPutBook(key, book) {'''
new_return = '''  });
  // Transaction completion alone is not enough for migration safety: prove
  // every full source book round-trips from book-records before any caller is
  // allowed to shrink localStorage to an index.
  await verifyFullRecords(libraryKey, source);
  return mergedIndex;
}

export async function libraryIdbPutBook(key, book) {'''
if old_return not in source:
    raise SystemExit('libraryIdbPut return anchor not found')
source = source.replace(old_return, new_return, 1)

book_func = re.search(
    r'''export async function libraryIdbPutBook\(key, book\) \{.*?\n\}\n\nexport async function libraryIdbDeleteBook''',
    source,
    re.S,
)
if not book_func:
    raise SystemExit('libraryIdbPutBook block not found')
new_book_func = '''export async function libraryIdbPutBook(key, book) {
  if (!book?.id) return false;
  const libraryKey = cleanLibraryKey(key);
  const existing = await libraryIdbGetBook(libraryKey, book.id).catch(() => null);
  const durableBook = preferRicherBook(existing, book);
  if (!isFullBook(durableBook)) {
    throw new Error(`[reader] refusing index-only book record: ${String(book.id)}`);
  }
  const current = await libraryIdbGetIndex(libraryKey).catch(() => []);
  const nextEntry = indexEntry(durableBook);
  const nextIndex = mergeIndexes(current, [nextEntry]);
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([BOOK_STORE, INDEX_STORE], 'readwrite');
    tx.objectStore(BOOK_STORE).put({
      key: recordKey(libraryKey, nextEntry.id),
      libraryKey,
      bookId: nextEntry.id,
      book: durableBook,
    });
    tx.objectStore(INDEX_STORE).put(nextIndex, libraryKey);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('[reader] single book write failed'));
    tx.onabort = () => reject(tx.error || new Error('[reader] single book write aborted'));
  });
  await verifyFullRecords(libraryKey, [durableBook]);
  return true;
}

export async function libraryIdbDeleteBook'''
source = source[:book_func.start()] + new_book_func + source[book_func.end():]

get_func = re.search(
    r'''export async function libraryIdbGet\(key\) \{.*?\n\}\s*$''',
    source,
    re.S,
)
if not get_func:
    raise SystemExit('libraryIdbGet block not found')
new_get = '''export async function libraryIdbGet(key) {
  const libraryKey = cleanLibraryKey(key);

  // Never report a migration source as durable until it has actually
  // round-tripped through book-records. Callers use successful idbGet() as the
  // signal that it is safe to compact the legacy localStorage snapshot.
  let migrationError = null;
  try {
    await migrateLegacySources(libraryKey);
  } catch (error) {
    migrationError = error;
  }

  let index = await libraryIdbGetIndex(libraryKey);
  let records = index.length
    ? await readBookRecords(libraryKey, index.map(item => item.id))
    : [];

  const legacyLocal = readLegacyLocalStorageSnapshot(libraryKey);
  if (legacyLocal.length) {
    const byId = new Map(records.filter(book => book?.id).map(book => [String(book.id), book]));
    const missing = legacyLocal
      .filter(book => !isFullBook(byId.get(String(book.id))))
      .map(book => String(book.id));
    if (missing.length) {
      throw migrationError || new Error(`[reader] legacy migration incomplete: ${missing.join(',')}`);
    }
  }

  if (migrationError) throw migrationError;
  if (index.length) return records;

  // Last-resort v1 IndexedDB compatibility. libraryIdbPut now verifies the
  // round-trip, so success here is safe for callers to treat as durable.
  const legacy = await readLegacySnapshot(libraryKey);
  if (!Array.isArray(legacy) || !legacy.length) return null;
  await libraryIdbPut(libraryKey, legacy);
  index = await libraryIdbGetIndex(libraryKey);
  records = index.length ? await readBookRecords(libraryKey, index.map(item => item.id)) : [];
  return records.length ? records : null;
}
'''
source = source[:get_func.start()] + new_get

path.write_text(source, encoding='utf-8')
print('toc126 storage migration commit guard: PASS')
