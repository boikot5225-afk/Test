// Authoritative durable reader-book deletion.
//
// The canonical reader-app delete path is still unsafe: it removes the book in
// memory, schedules the big library snapshot for later, and immediately renders.
// renderReaderScreen() calls load(), which can read the stale snapshot and put
// the just-deleted book back. Cloud/IndexedDB can do the same later. This module
// owns deletion until that legacy function is removed: tombstone first, write
// localStorage + IndexedDB immediately, then render. It also installs itself in
// BOTH window.readerDeleteBook and window.__real_readerDeleteBook because the
// startup buffering stubs may dispatch through either one.

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

async function persistFilteredBooks({ render = false } = {}) {
  if (!moduleRef) return false;
  const deleted = new Set(Object.keys(readTombstones()));
  if (!deleted.size) return false;

  const books = moduleRef.loadReaderBooks?.() || [];
  if (!Array.isArray(books)) return false;
  const kept = books.filter(book => !deleted.has(String(book?.id || '')));
  if (kept.length === books.length) return false;

  books.splice(0, books.length, ...kept);
  for (const id of deleted) removePosition(id);
  const storageKey = scopedKey(BOOKS_BASE_KEY);
  try { localStorage.setItem(storageKey, JSON.stringify(books)); } catch {}
  try { await libraryIdbPut(storageKey, books); }
  catch (error) { console.warn('[reader delete] IndexedDB write failed', error); }
  try { moduleRef.saveReaderBooks?.(); } catch {}
  if (render && document.getElementById('reader-reading-view')?.style.display !== 'flex') {
    try { await moduleRef.renderReaderScreen?.(); } catch {}
  }
  return true;
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function deleteCloudBook(id) {
  const delays = [0, 600, 1600, 4000, 9000];
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
  // Critical for the index.html buffering proxy. Old builds only replaced the
  // first property, leaving __real_readerDeleteBook pointing at the broken
  // delayed-save implementation.
  window.__real_readerDeleteBook = durableDelete;
}

async function installDeleteFix() {
  if (installPromise) return installPromise;
  installPromise = (async () => {
    moduleRef = await import('../reader-app.js?v=77.31');

    durableDelete = async function readerDeleteBookDurable(id) {
      const wantedId = String(id || '');
      if (!wantedId) return false;
      const books = moduleRef.loadReaderBooks?.() || [];
      const book = Array.isArray(books) ? books.find(item => String(item?.id || '') === wantedId) : null;
      if (book && !confirm(`Удалить текст «${book.title || 'Без названия'}»?`)) return false;

      // Even a stale card gets a tombstone. That makes deletion idempotent and
      // prevents a cloud/IDB copy from resurrecting it later.
      markDeleted(wantedId);
      if (Array.isArray(books)) {
        const kept = books.filter(item => String(item?.id || '') !== wantedId);
        books.splice(0, books.length, ...kept);
      }
      removePosition(wantedId);

      const storageKey = scopedKey(BOOKS_BASE_KEY);
      try { localStorage.setItem(storageKey, JSON.stringify(books)); } catch {}
      try { await libraryIdbPut(storageKey, books); }
      catch (error) { console.warn('[reader delete] immediate IndexedDB write failed', error); }
      try { moduleRef.saveReaderBooks?.(); } catch {}

      imgStoreDeleteBook(wantedId).catch(() => {});
      audioStoreDelete(wantedId).catch(() => {});

      try { await moduleRef.renderReaderScreen?.(); } catch {}
      showToast('🗑 Текст удалён');

      // Network never blocks the UI. The tombstone remains permanently, so an
      // offline device or stale backup cannot reintroduce an explicit deletion.
      deleteCloudBook(wantedId)
        .then(() => reconcileTombstones({ render: true }))
        .catch(() => {});
      return true;
    };
    durableDelete.__readerDurableDeleteFix = true;
    installHandler();

    // Capture the actual trash-button click too. This bypasses every historical
    // inline-handler/proxy race and makes the UI use exactly this function.
    if (!window.__readerDurableDeleteCapture) {
      window.__readerDurableDeleteCapture = true;
      document.addEventListener('click', event => {
        const target = event.target instanceof Element ? event.target : null;
        const button = target?.closest?.('.lib-action-btn.danger');
        if (!button) return;
        const inline = String(button.getAttribute('onclick') || '');
        const match = inline.match(/readerDeleteBook\(\s*(['"])(.*?)\1\s*\)/);
        if (!match) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        durableDelete(match[2]).catch(error => console.warn('[reader delete] click failed', error));
      }, true);
    }

    // Strip anything already tombstoned by previous failed builds.
    await reconcileTombstones({ render: true });
    deleteAllCloudTombstones().catch(() => {});

    // Reassert handler identity and strip a cloud resurrection. Cheap when no
    // tombstones exist; no large writes happen unless a deleted id reappears.
    guardTimer = setInterval(() => {
      installHandler();
      if (Object.keys(readTombstones()).length) reconcileTombstones({ render: true }).catch(() => {});
    }, 2500);

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
