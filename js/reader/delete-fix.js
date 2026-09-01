// Authoritative durable reader-book deletion.
//
// Deletion must win over every stale copy: memory, localStorage, IndexedDB and
// cloud hydration. Normal reader saves are deliberately deferred for speed, so
// this path does NOT call the normal delayed save after removing a book. It
// tombstones the id first, writes local + IDB immediately, removes the card from
// the DOM immediately, and repeatedly strips any stale rehydrate while the cloud
// delete is in flight.

import { libraryIdbPut } from './library-idb-store.js?v=1';
import { imgStoreDeleteBook } from './image-store.js?v=1';
import { audioStoreDelete } from './audio-store.js?v=1';
import { sb, sbGetCurrentUserId, isSupabaseReady } from '../supabase.js';
import { showToast } from '../utils.js';

const BOOKS_BASE_KEY = 'an2_reader_books_v1';
const TOMBSTONES_BASE_KEY = 'an2_reader_book_tombstones_v1';
const MAX_TOMBSTONES = 500;
let moduleRef = null;
let durableDelete = null;
let installPromise = null;
let reconcilePromise = null;
let guardTimer = null;

function scopedKey(base) {
  try {
    return typeof window.an2ReaderStorageKey === 'function'
      ? window.an2ReaderStorageKey(base)
      : base;
  } catch { return base; }
}

function readTombstones() {
  try {
    const raw = JSON.parse(localStorage.getItem(scopedKey(TOMBSTONES_BASE_KEY)) || '{}') || {};
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

function writeTombstones(value) {
  const compact = Object.entries(value || {})
    .filter(([id]) => !!id)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, MAX_TOMBSTONES);
  try { localStorage.setItem(scopedKey(TOMBSTONES_BASE_KEY), JSON.stringify(Object.fromEntries(compact))); } catch {}
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
  } catch {}
}

function stripDeletedFromArray(books) {
  if (!Array.isArray(books)) return [];
  const deleted = new Set(Object.keys(readTombstones()));
  if (!deleted.size) return books;
  const kept = books.filter(book => !deleted.has(String(book?.id || '')));
  if (kept.length !== books.length) books.splice(0, books.length, ...kept);
  return books;
}

async function persistFilteredBooks({ render = false } = {}) {
  if (!moduleRef) return false;
  const deleted = new Set(Object.keys(readTombstones()));
  if (!deleted.size) return false;

  const books = moduleRef.loadReaderBooks?.() || [];
  if (!Array.isArray(books)) return false;
  const before = books.length;
  stripDeletedFromArray(books);
  for (const id of deleted) removePosition(id);

  const storageKey = scopedKey(BOOKS_BASE_KEY);
  try { localStorage.setItem(storageKey, JSON.stringify(books)); } catch {}
  try { await libraryIdbPut(storageKey, books); }
  catch (error) { console.warn('[reader delete] IndexedDB write failed', error); }

  if (render && document.getElementById('reader-reading-view')?.style.display !== 'flex') {
    try { await moduleRef.renderReaderScreen?.(); } catch {}
  }
  return books.length !== before;
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function deleteCloudBook(id) {
  const delays = [0, 500, 1400, 3500, 8000];
  let lastError = null;
  for (const delay of delays) {
    if (delay) await wait(delay);
    try {
      const userId = typeof sbGetCurrentUserId === 'function' ? sbGetCurrentUserId() : null;
      if (!userId || !isSupabaseReady?.()) continue;
      const { error } = await sb.from('reader_books').delete().eq('user_id', userId).eq('id', id);
      if (error) throw error;
      return true;
    } catch (error) { lastError = error; }
  }
  if (lastError) console.warn('[reader delete] cloud delete postponed', id, lastError);
  return false;
}

async function deleteAllCloudTombstones() {
  const ids = Object.keys(readTombstones());
  for (const id of ids) {
    const ok = await deleteCloudBook(id);
    if (ok) await persistFilteredBooks({ render: true });
  }
}

async function reconcileTombstones({ render = false } = {}) {
  if (reconcilePromise) return reconcilePromise;
  reconcilePromise = persistFilteredBooks({ render })
    .finally(() => { reconcilePromise = null; });
  return reconcilePromise;
}

function installHandler() {
  if (!durableDelete) return;
  window.readerDeleteBook = durableDelete;
  window.__real_readerDeleteBook = durableDelete;
}

function scheduleDeleteGuards() {
  for (const delay of [0, 40, 120, 300, 700, 1400, 2800, 5000]) {
    setTimeout(() => reconcileTombstones({ render: true }).catch(() => {}), delay);
  }
}

async function installDeleteFix() {
  if (installPromise) return installPromise;
  installPromise = (async () => {
    moduleRef = await import('../reader-app.js?v=77.42-zh-reader-quality');

    durableDelete = async function readerDeleteBookDurable(id) {
      const wantedId = String(id || '');
      if (!wantedId) return false;
      const books = moduleRef.loadReaderBooks?.() || [];
      const book = Array.isArray(books) ? books.find(item => String(item?.id || '') === wantedId) : null;
      if (book && !confirm(`Удалить текст «${book.title || 'Без названия'}»?`)) return false;

      // Tombstone comes FIRST. Any async hydration that finishes from now on is
      // treated as stale and stripped again by the guards below.
      markDeleted(wantedId);
      stripDeletedFromArray(books);
      removePosition(wantedId);

      const storageKey = scopedKey(BOOKS_BASE_KEY);
      try { localStorage.setItem(storageKey, JSON.stringify(books)); } catch {}
      try { await libraryIdbPut(storageKey, books); }
      catch (error) { console.warn('[reader delete] immediate IndexedDB write failed', error); }

      // Do NOT call saveReaderBooks() here: its deferred cloud/local save is the
      // exact mechanism that used to race this explicit delete.
      imgStoreDeleteBook(wantedId).catch(() => {});
      audioStoreDelete(wantedId).catch(() => {});

      try { await moduleRef.renderReaderScreen?.(); } catch {}
      showToast('🗑 Текст удалён');
      scheduleDeleteGuards();

      deleteCloudBook(wantedId)
        .then(() => reconcileTombstones({ render: true }))
        .catch(() => {});
      return true;
    };
    durableDelete.__readerDurableDeleteFix = true;
    installHandler();

    // Capture trash clicks before inline handlers/proxy stubs. Accept both the
    // current CSS class and the explicit onclick signature so a small UI restyle
    // cannot silently disable deletion again.
    if (!window.__readerDurableDeleteCaptureV2) {
      window.__readerDurableDeleteCaptureV2 = true;
      document.addEventListener('click', event => {
        const target = event.target instanceof Element ? event.target : null;
        const button = target?.closest?.('[onclick*="readerDeleteBook"],.lib-action-btn.danger');
        if (!button) return;
        const inline = String(button.getAttribute('onclick') || '');
        const match = inline.match(/readerDeleteBook\(\s*(['"])(.*?)\1\s*\)/);
        if (!match) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        // Visual removal is immediate; durable state follows in the async call.
        try { button.closest('.lib-book-card,.lib-news-card')?.remove(); } catch {}
        durableDelete(match[2]).catch(error => console.warn('[reader delete] click failed', error));
      }, true);
    }

    await reconcileTombstones({ render: true });
    deleteAllCloudTombstones().catch(() => {});

    // Reassert handler identity and continuously reject stale IDB/cloud rows.
    guardTimer = setInterval(() => {
      installHandler();
      if (Object.keys(readTombstones()).length) reconcileTombstones({ render: true }).catch(() => {});
    }, 800);

    window.addEventListener('pageshow', () => {
      installHandler();
      reconcileTombstones({ render: true }).catch(() => {});
    });
    window.addEventListener('online', () => deleteAllCloudTombstones().catch(() => {}));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      installHandler();
      reconcileTombstones({ render: true }).catch(() => {});
      deleteAllCloudTombstones().catch(() => {});
    });
    window.addEventListener('pagehide', () => {
      if (guardTimer) clearInterval(guardTimer);
      guardTimer = null;
    });
    return true;
  })().catch(error => {
    installPromise = null;
    console.warn('[reader delete] authoritative install failed', error);
    return false;
  });
  return installPromise;
}

setTimeout(() => { installDeleteFix(); }, 0);
