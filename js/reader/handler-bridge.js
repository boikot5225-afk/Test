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
let activeEpubImport = null;
const importIsolationStats = {
  epubStarts: 0,
  canonicalResets: 0,
  dedupedCalls: 0,
  blockedConcurrent: 0,
};
globalThis.__readerImportIsolationStats = importIsolationStats;

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

function importFile(event) {
  return event?.target?.files?.[0] || null;
}

function epubFingerprint(file) {
  return `${String(file?.name || '')}|${Number(file?.size || 0)}|${Number(file?.lastModified || 0)}`;
}

function setImportStatus(message) {
  const status = document.getElementById('reader-import-status');
  if (!status) return;
  status.style.display = 'block';
  status.style.color = 'var(--accent)';
  status.textContent = message;
}

function clearStaleImportUi() {
  for (const id of ['reader-import-title', 'reader-import-author', 'reader-import-text']) {
    const element = document.getElementById(id);
    if (element) element.value = '';
  }
  const audioStatus = document.getElementById('reader-import-audio-status');
  if (audioStatus) {
    audioStatus.style.display = 'none';
    audioStatus.textContent = '';
  }
  const stopBtn = document.getElementById('reader-audio-stop-btn');
  if (stopBtn) stopBtn.style.display = 'none';
}

// reader-app keeps the audio attachment/timestamp fields private. The canonical
// text-file import path already clears them synchronously at its start, so use a
// harmless in-memory text file only as a state reset before semantic EPUB takes
// ownership. Nothing is saved and the reset result is cleared before EPUB paint.
async function resetCanonicalPendingImport(canonicalImport) {
  const resetFile = new File([''], '__reader_import_state_reset__.txt', {
    type: 'text/plain',
    lastModified: 1,
  });
  try {
    await canonicalImport({
      target: { files: [resetFile], value: '' },
      __readerImportStateReset: true,
    });
  } catch (error) {
    console.warn('[reader import isolation] canonical state reset parser result', error);
  }
  importIsolationStats.canonicalResets += 1;
}

// Semantic EPUB bypasses reader-app's normal file-import entry point. That used
// to leave audio-pending state behind after transcription, and repeated file
// events could launch two ZIP parsers over the same EPUB. Keep semantic parsing
// single-flight and explicitly run the canonical reset before every new EPUB.
function installImportIsolationBridge() {
  const current = liveHandler('readerImportFromFile');
  if (!current) return false;
  if (current.__readerAudioEpubIsolationV1) {
    window.__real_readerImportFromFile = current;
    return true;
  }
  if (!current.__semanticStage1 || typeof current.__semanticOriginal !== 'function') return false;

  const semanticImport = current;
  const canonicalImport = current.__semanticOriginal;

  const wrapped = function readerImportAudioEpubIsolated(event, ...args) {
    const file = importFile(event);
    const isEpub = !!file && String(file.name || '').toLowerCase().endsWith('.epub');
    if (!isEpub) return semanticImport.call(this, event, ...args);

    const fingerprint = epubFingerprint(file);
    if (activeEpubImport) {
      if (activeEpubImport.fingerprint === fingerprint) {
        importIsolationStats.dedupedCalls += 1;
        return activeEpubImport.promise;
      }
      importIsolationStats.blockedConcurrent += 1;
      setImportStatus(`⏳ Уже разбираю ${activeEpubImport.name}. Дождись завершения перед выбором другого EPUB.`);
      return activeEpubImport.promise;
    }

    clearStaleImportUi();
    setImportStatus(`⏳ Открываю ${file.name}...`);

    let promise;
    promise = (async () => {
      await resetCanonicalPendingImport(canonicalImport);
      clearStaleImportUi();
      setImportStatus(`⏳ Открываю ${file.name}...`);
      importIsolationStats.epubStarts += 1;
      return semanticImport.call(this, event, ...args);
    })().finally(() => {
      if (activeEpubImport?.promise === promise) activeEpubImport = null;
    });

    activeEpubImport = {
      fingerprint,
      name: String(file.name || 'EPUB'),
      promise,
    };
    return promise;
  };

  wrapped.__readerAudioEpubIsolationV1 = true;
  wrapped.__semanticStage1 = true;
  wrapped.__semanticOriginal = canonicalImport;
  wrapped.__upgraded = semanticImport;
  window.readerImportFromFile = wrapped;
  window.__real_readerImportFromFile = wrapped;
  return true;
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
  installImportIsolationBridge();
  syncReal('saveReaderImport');
  if (deleteBridgeInstalled) syncReal('readerDeleteBook');
  if (tocBridgeInstalled) syncReal('readerOpenToc');
}

function scheduleSync() {
  for (const delay of [0, 50, 150, 400, 1000, 2500, 6000, 9000, 11000]) {
    setTimeout(syncUpgradedHandlers, delay);
  }
}

scheduleSync();
window.addEventListener('pageshow', syncUpgradedHandlers);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncUpgradedHandlers();
});
