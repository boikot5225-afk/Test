// Runtime handler bridge for Reader AI 77.42.
//
// index.html installs buffering stubs and app.js later copies real handlers to
// window.__real_NAME. Reader TOC/delete upgrades are installed asynchronously,
// so the copied __real_* handlers can otherwise keep pointing at the pre-upgrade
// functions. Android external import also used __real_* preferentially.
//
// Keep both handler namespaces on the same implementation and make TOC opening
// recover the active book from the rendered DOM if an async owner/storage switch
// cleared readerCurrentBookId while the chapter is still visible.

const READER_APP_URL = '../reader-app.js?v=77.31';
let appPromise = null;
let tocBridgeInstalled = false;

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
  // readerTocDiagnostics is installed by toc-upgrade.js together with the
  // upgraded readerOpenToc handler. Wait for that marker so we never capture
  // the legacy flat handler by mistake.
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
  // TOC/import wrappers and the durable delete patch are asynchronous. Once
  // they are present, mirror them into __real_* so old stubs/native bridges do
  // not bypass the fixes.
  for (const name of ['readerImportFromFile', 'saveReaderImport', 'readerDeleteBook']) syncReal(name);
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
