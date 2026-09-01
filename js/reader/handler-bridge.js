// Runtime handler bridge for Reader AI 77.42.
// Every navigation/import handler must use the SAME reader-app module instance.
// A different query string creates a second ES-module instance with independent
// readerBooks/currentBook/import state, so keep this URL byte-for-byte aligned
// with app.js.

const READER_APP_URL = '../reader-app.js?v=77.42-zh-reader-quality';
const LIBRARY_IDB_URL = './library-idb-store.js?v=2';
let appPromise = null;
let tocBridgeInstalled = false;
let deleteBridgeInstalled = false;

function appModule() {
  if (!appPromise) appPromise = import(READER_APP_URL);
  return appPromise;
}

function liveHandler(name) {
  const fn = window[name];
  return typeof fn === 'function' && !fn.__isStub ? fn : null;
}

function syncReal(name) {
  const fn = liveHandler(name);
  if (fn) window[`__real_${name}`] = fn;
  return fn;
}

function currentLibraryKey() {
  try {
    return window.an2ReaderStorageKey?.('an2_reader_books_v1') || 'an2_reader_books_v1';
  } catch {
    return 'an2_reader_books_v1';
  }
}

function localIndexHasBook(key, id) {
  try {
    const rows = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(rows) && rows.some(book => String(book?.id || '') === String(id || ''));
  } catch {
    return false;
  }
}

async function recoverVisibleBook(app) {
  let book = app.readerCurrentBook?.();
  if (book?.chapters?.length) return book;

  let books = [];
  try { books = app.loadReaderBooks?.() || []; } catch {}
  if (!Array.isArray(books) || !books.length) return book || null;

  const root = document.getElementById('reader-chapter-text');
  const renderedId = String(root?.dataset?.readerBookId || '').trim();
  const renderedTitle = String(document.getElementById('reader-book-title')?.textContent || '').trim();
  let candidate = renderedId ? books.find(item => String(item?.id || '') === renderedId) : null;
  if (!candidate && renderedTitle) {
    const sameTitle = books.filter(item => String(item?.title || '').trim() === renderedTitle);
    if (sameTitle.length === 1) candidate = sameTitle[0];
  }
  if (!candidate?.id) return book || null;

  try { await app.readerOpenBook?.(candidate.id); } catch (error) {
    console.warn('[reader handlers] active book recovery failed', error);
  }
  return app.readerCurrentBook?.() || candidate;
}

function installTocBridge() {
  if (tocBridgeInstalled) return true;
  if (typeof window.readerTocDiagnostics !== 'function') return false;
  const upgraded = liveHandler('readerOpenToc');
  if (!upgraded) return false;
  if (upgraded.__readerTocRuntimeBridge) {
    tocBridgeInstalled = true;
    syncReal('readerOpenToc');
    return true;
  }

  const bridged = async function readerOpenTocRuntimeBridge(...args) {
    try {
      const app = await appModule();
      await recoverVisibleBook(app);
    } catch (error) {
      console.warn('[reader handlers] TOC preflight failed', error);
    }
    return upgraded.apply(this, args);
  };
  bridged.__readerTocRuntimeBridge = true;
  bridged.__upgraded = upgraded;
  window.readerOpenToc = bridged;
  window.__real_readerOpenToc = bridged;
  tocBridgeInstalled = true;
  return true;
}

// IDB v2 never infers deletion from a missing item in an arbitrary runtime
// snapshot. A startup/owner-switch snapshot can be partial. Therefore deletion
// becomes explicit: only after the existing UI handler really removed the id
// from the small local library index do we delete that exact IDB record.
function installDurableDeleteBridge() {
  const current = liveHandler('readerDeleteBook');
  if (!current) return false;
  if (current.__readerDurableDeleteV2) {
    deleteBridgeInstalled = true;
    window.__real_readerDeleteBook = current;
    return true;
  }

  const wrapped = function readerDeleteBookDurableV2(id, ...args) {
    const key = currentLibraryKey();
    const bookId = String(id || '');
    const existedBefore = !!bookId && localIndexHasBook(key, bookId);
    const result = current.call(this, id, ...args);

    // readerDeleteBook() schedules its lightweight index commit. If the user
    // cancelled confirm(), the id remains and nothing durable is removed.
    if (existedBefore) {
      setTimeout(async () => {
        try {
          if (localIndexHasBook(key, bookId)) return;
          const store = await import(LIBRARY_IDB_URL);
          await store.libraryIdbDeleteBook?.(key, bookId);
        } catch (error) {
          console.warn('[reader handlers] durable book delete deferred', error);
        }
      }, 1400);
    }
    return result;
  };
  wrapped.__readerDurableDeleteV2 = true;
  wrapped.__upgraded = current;
  window.readerDeleteBook = wrapped;
  window.__real_readerDeleteBook = wrapped;
  deleteBridgeInstalled = true;
  return true;
}

const CANONICAL_READER_HANDLER_NAMES = [
  'readerOpenBook', 'readerBackToLibrary',
  'readerNextParagraph', 'readerPrevParagraph',
  'readerNextChapter', 'readerPrevChapter',
  'readerSelectParagraph', 'readerGoToChapter',
  'renderReaderChapter',
];

function syncCanonicalReaderHandlers() {
  return appModule().then(app => {
    for (const name of CANONICAL_READER_HANDLER_NAMES) {
      const fn = app?.[name];
      if (typeof fn !== 'function') continue;
      window[name] = fn;
      window[`__real_${name}`] = fn;
    }
    globalThis.__readerCanonicalModuleUrl = READER_APP_URL;
    globalThis.__readerCanonicalHandlersBound = true;
    return app;
  });
}

function syncUpgradedHandlers() {
  syncCanonicalReaderHandlers().catch(error => console.warn('[reader handlers] canonical navigation bind failed', error));
  installTocBridge();
  installDurableDeleteBridge();
  for (const name of ['readerImportFromFile', 'saveReaderImport']) syncReal(name);
  if (deleteBridgeInstalled) syncReal('readerDeleteBook');
  if (tocBridgeInstalled) syncReal('readerOpenToc');
}

function scheduleSync() {
  for (const delay of [0, 50, 150, 400, 1000, 2500, 6000]) {
    setTimeout(syncUpgradedHandlers, delay);
  }
}

scheduleSync();
window.addEventListener('pageshow', syncUpgradedHandlers);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncUpgradedHandlers();
});
