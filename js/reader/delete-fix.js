// Durable reader-book deletion for Reader AI 77.42.
//
// The library snapshot is intentionally written with a delay during normal
// reading, but readerDeleteBook() used to remove a book from memory and then
// immediately call renderReaderScreen(). That render calls load() again before
// the delayed localStorage commit, so the just-deleted book was read back from
// the stale snapshot and appeared to be impossible to delete. IndexedDB/cloud
// copies could resurrect it again for the same reason.
//
// Keep a tiny per-owner tombstone list and make deletion itself synchronous for
// localStorage + durable for IndexedDB before re-rendering. Cloud deletion is
// retried in the background and every successful retry re-applies tombstones to
// memory, so an in-flight cloud hydrate cannot bring an old book back.

import { libraryIdbPut } from './library-idb-store.js?v=1';
import { imgStoreDeleteBook } from './image-store.js?v=1';
import { audioStoreDelete } from './audio-store.js?v=1';
import { sb, sbGetCurrentUserId, isSupabaseReady } from '../supabase.js';
import { showToast } from '../utils.js';

const BOOKS_BASE_KEY = 'an2_reader_books_v1';
const TOMBSTONES_BASE_KEY = 'an2_reader_book_tombstones_v1';
const MAX_TOMBSTONES = 500;
let installStarted = false;
let moduleRef = null;
let reconcilePromise = null;

function scopedKey(base) {
  try {
    return typeof window.an2ReaderStorageKey === 'function'
      ? window.an2ReaderStorageKey(base)
      : base;
  } catch {
    return base;
  }
}

function readTombstones() {
  try {
    const raw = JSON.parse(localStorage.getItem(scopedKey(TOMBSTONES_BASE_KEY)) || '{}') || {};
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeTombstones(tombstones) {
  try {
    const entries = Object.entries(tombstones || {})
      .filter(([id]) => !!id)
      .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
      .slice(0, MAX_TOMBSTONES);
    localStorage.setItem(scopedKey(TOMBSTONES_BASE_KEY), JSON.stringify(Object.fromEntries(entries)));
  } catch (_) {}
}

function markDeleted(id) {
  const tombstones = readTombstones();
  tombstones[String(id)] = Date.now();
  writeTombstones(tombstones);
}

function removePosition(id) {
  const key = scopedKey(BOOKS_BASE_KEY) + '_pos';
  try {
    const positions = JSON.parse(localStorage.getItem(key) || '{}') || {};
    if (Object.prototype.hasOwnProperty.call(positions, id)) {
      delete positions[id];
      localStorage.setItem(key, JSON.stringify(positions));
    }
  } catch (_) {}
}

async function persistFilteredBooks(readerModule, { render = false } = {}) {
  const tombstones = readTombstones();
  const deletedIds = new Set(Object.keys(tombstones));
  if (!deletedIds.size) return false;

  const books = readerModule.loadReaderBooks();
  if (!Array.isArray(books)) return false;
  const kept = books.filter(book => !deletedIds.has(String(book?.id || '')));
  if (kept.length === books.length) return false;

  // loadReaderBooks() returns the reader's actual in-memory array. Mutate that
  // same array instead of replacing an inaccessible module-local variable.
  books.splice(0, books.length, ...kept);
  for (const id of deletedIds) removePosition(id);

  const storageKey = scopedKey(BOOKS_BASE_KEY);
  try { localStorage.setItem(storageKey, JSON.stringify(books)); } catch (_) {}
  try { await libraryIdbPut(storageKey, books); }
  catch (error) { console.warn('[reader delete] IndexedDB write failed', error); }

  // Keep the normal store's position/cloud machinery in sync. The expensive
  // snapshot it schedules later now sees the already-correct local + IDB state.
  try { readerModule.saveReaderBooks(); } catch (_) {}
  if (render) {
    try { await readerModule.renderReaderScreen(); } catch (_) {}
  }
  return true;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function deleteCloudBook(id) {
  const delays = [0, 700, 1800, 4500, 9000];
  let lastError = null;
  for (const delay of delays) {
    if (delay) await wait(delay);
    try {
      const userId = typeof sbGetCurrentUserId === 'function' ? sbGetCurrentUserId() : null;
      if (!userId || !isSupabaseReady?.()) continue;
      const { error } = await sb.from('reader_books')
        .delete()
        .eq('user_id', userId)
        .eq('id', id);
      if (error) throw error;
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) console.warn('[reader delete] cloud delete postponed', lastError);
  return false;
}

async function reconcileTombstones({ render = false, cloud = true } = {}) {
  if (!moduleRef) return false;
  if (reconcilePromise) return reconcilePromise;
  reconcilePromise = (async () => {
    const tombstones = readTombstones();
    const ids = Object.keys(tombstones);
    if (!ids.length) return false;

    let changed = await persistFilteredBooks(moduleRef, { render: false });
    if (cloud) {
      for (const id of ids) {
        const removed = await deleteCloudBook(id);
        if (removed) {
          // A cloud hydrate may have completed while the delete request was in
          // flight. Strip the tombstoned row from memory/local/IDB one more time.
          changed = (await persistFilteredBooks(moduleRef, { render: false })) || changed;
        }
      }
    }
    if (render && changed) {
      try { await moduleRef.renderReaderScreen(); } catch (_) {}
    }
    return changed;
  })().finally(() => { reconcilePromise = null; });
  return reconcilePromise;
}

async function installDeleteFix() {
  if (installStarted) return;
  installStarted = true;
  try {
    // Dynamic import avoids a static reader-app <-> chapter-render cycle. By the
    // time this timer runs the original module has finished evaluating.
    moduleRef = await import('../reader-app.js');
    const originalDelete = window.readerDeleteBook;
    if (originalDelete?.__readerDurableDeleteFix) return;

    const durableDelete = async function readerDeleteBookDurable(id) {
      const books = moduleRef.loadReaderBooks();
      const book = Array.isArray(books) ? books.find(item => item?.id === id) : null;
      if (!book) {
        // If a stale UI card survives one frame, tombstone it anyway and clean
        // every backing store instead of doing nothing.
        markDeleted(id);
        await reconcileTombstones({ render: true, cloud: true });
        return;
      }
      if (!confirm(`Удалить текст «${book.title || 'Без названия'}»?`)) return;

      markDeleted(id);
      const kept = books.filter(item => item?.id !== id);
      books.splice(0, books.length, ...kept);
      removePosition(id);

      const storageKey = scopedKey(BOOKS_BASE_KEY);
      try { localStorage.setItem(storageKey, JSON.stringify(books)); } catch (_) {}
      try { await libraryIdbPut(storageKey, books); }
      catch (error) { console.warn('[reader delete] immediate IndexedDB write failed', error); }
      try { moduleRef.saveReaderBooks(); } catch (_) {}

      imgStoreDeleteBook(id).catch(() => {});
      audioStoreDelete(id).catch(() => {});

      showToast('🗑 Текст удалён');
      try { await moduleRef.renderReaderScreen(); } catch (_) {}

      // Network work never blocks the UI. Tombstone remains locally even after
      // success, which is intentional: an old device/backup must not resurrect
      // a book the user explicitly deleted.
      deleteCloudBook(id)
        .then(() => persistFilteredBooks(moduleRef, { render: true }))
        .catch(() => {});
    };
    durableDelete.__readerDurableDeleteFix = true;
    durableDelete.__original = originalDelete;
    window.readerDeleteBook = durableDelete;

    // Clean up any book that was "deleted" by the broken 77.42 build but got
    // resurrected before this update. Existing tombstones are cheap to replay.
    reconcileTombstones({ render: true, cloud: true }).catch(() => {});
    window.addEventListener('online', () => reconcileTombstones({ render: true, cloud: true }).catch(() => {}));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reconcileTombstones({ render: true, cloud: true }).catch(() => {});
    });
  } catch (error) {
    installStarted = false;
    console.warn('[reader delete] fix install failed', error);
  }
}

setTimeout(() => { installDeleteFix(); }, 0);
