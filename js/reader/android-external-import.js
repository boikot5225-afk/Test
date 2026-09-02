import {
  libraryIdbGet,
  libraryIdbPut,
} from './library-idb-store.js?v=2';

const SUPPORTED_EXTENSIONS = new Set(['epub', 'fb2', 'txt', 'text', 'md']);

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function currentHandler(name) {
  const live = window[name];
  if (typeof live === 'function' && !live.__isStub) return live;
  const real = window[`__real_${name}`];
  return typeof real === 'function' && !real.__isStub ? real : null;
}

function actionViewImportHandler(handler) {
  // toc128: the audio→EPUB reset/single-flight wrapper belongs only to a real
  // in-app file-picker transition. ACTION_VIEW already owns a cold-start legacy
  // migration barrier below; invoking the reset wrapper here can compact the
  // legacy localStorage snapshot before that migration is durably verified.
  // The wrapper exposes its semantic importer as __upgraded, so ACTION_VIEW
  // deliberately reuses the exact pre-toc128 semantic path.
  if (handler?.__readerAudioEpubIsolationV1 && typeof handler.__upgraded === 'function') {
    return handler.__upgraded;
  }
  return handler;
}

async function waitUntilReady(timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const main = document.getElementById('main-app');
    const importHandler = currentHandler('readerImportFromFile');
    const saveHandler = currentHandler('saveReaderImport');
    if (main?.style.display !== 'none'
      && typeof window.showReaderImportModal === 'function'
      && typeof importHandler === 'function'
      && typeof saveHandler === 'function') {
      return { importHandler, saveHandler };
    }
    await wait(120);
  }
  throw new Error('Reader AI не завершил вход. Войди в приложение или выбери гостевой режим.');
}

function safeFileName(value) {
  const name = String(value || 'book').split(/[\\/]/).pop()?.trim() || 'book';
  return name.slice(0, 240);
}

function extensionOf(name) {
  return safeFileName(name).split('.').pop()?.toLowerCase() || '';
}

function mimeFor(name, supplied) {
  if (supplied && supplied !== 'application/octet-stream') return supplied;
  const extension = extensionOf(name);
  if (extension === 'epub') return 'application/epub+zip';
  if (extension === 'fb2') return 'application/x-fictionbook+xml';
  return 'text/plain';
}

function setExternalStatus(message, kind = 'progress') {
  const status = document.getElementById('reader-import-status');
  if (!status) return;
  status.style.display = 'block';
  status.style.color = kind === 'error' ? 'var(--bad)' : kind === 'ok' ? 'var(--good)' : 'var(--accent)';
  status.textContent = message;
}

function externalLibraryKey() {
  try {
    return window.an2ReaderStorageKey?.('an2_reader_books_v1') || 'an2_reader_books_v1::guest';
  } catch {
    return 'an2_reader_books_v1::guest';
  }
}

function fullBooksFromRaw(raw) {
  try {
    const rows = JSON.parse(String(raw || '[]'));
    return Array.isArray(rows)
      ? rows.filter(book => book?.id && Array.isArray(book?.chapters) && book.chapters.length > 0)
      : [];
  } catch {
    return [];
  }
}

function mergeFullBooks(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const book of Array.isArray(list) ? list : []) {
      if (!book?.id || !Array.isArray(book?.chapters) || !book.chapters.length) continue;
      const id = String(book.id);
      const previous = byId.get(id);
      if (!previous || new Date(book.updatedAt || 0) >= new Date(previous.updatedAt || 0)) byId.set(id, book);
    }
  }
  return [...byId.values()];
}

// ACTION_VIEW starts on a fresh WebView. The normal Reader startup can compact
// a legacy full localStorage library while the Android file bridge is still
// fetching/constructing the incoming File. Do not let the new EPUB enter that
// race: this module is loaded statically before app init, so its ?v=2 IDB
// module has already captured the old local payload. Once guest startup has
// also published its synchronous snapshot, persist every full legacy book and
// prove it round-trips before handing the new file to semantic import.
async function ensureExternalLegacyMigrationBarrier() {
  const key = externalLibraryKey();
  let liveRaw = '';
  try { liveRaw = localStorage.getItem(key) || ''; } catch {}
  const snapshot = globalThis.__readerGuestLegacyLibrarySnapshot;
  const snapshotRaw = snapshot && String(snapshot.key || '') === String(key)
    ? String(snapshot.raw || '')
    : '';
  const legacyFull = mergeFullBooks(
    fullBooksFromRaw(snapshotRaw),
    fullBooksFromRaw(liveRaw),
  );

  // libraryIdbGet() still runs the IDB module's own boot-snapshot migration.
  // The explicit put below additionally covers the app-level guest snapshot,
  // so correctness no longer depends on which module instance won startup.
  let durable = await libraryIdbGet(key);
  durable = Array.isArray(durable) ? durable : [];
  if (legacyFull.length) {
    await libraryIdbPut(key, mergeFullBooks(durable, legacyFull));
    durable = await libraryIdbGet(key);
    durable = Array.isArray(durable) ? durable : [];
  }

  if (!legacyFull.length) return durable;
  const durableById = new Map(durable.filter(book => book?.id).map(book => [String(book.id), book]));
  const missing = legacyFull
    .filter(book => !Array.isArray(durableById.get(String(book.id))?.chapters)
      || !durableById.get(String(book.id)).chapters.length)
    .map(book => String(book.id));
  if (missing.length) {
    throw new Error(`Старая библиотека не перенеслась в IndexedDB: ${missing.join(', ')}`);
  }
  return durable;
}

export async function readerImportAndroidFile(payload = {}) {
  const name = safeFileName(payload.name);
  const extension = extensionOf(name);
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    window.showToast?.(`⚠️ Формат .${extension || '?'} пока не поддерживается`);
    return false;
  }

  try {
    const { importHandler, saveHandler } = await waitUntilReady();
    const actionViewHandler = actionViewImportHandler(importHandler);
    await ensureExternalLegacyMigrationBarrier();
    window.showScreen?.('reader');
    window.showReaderImportModal?.();

    for (const id of ['reader-import-title', 'reader-import-author', 'reader-import-text']) {
      const input = document.getElementById(id);
      if (input) input.value = '';
    }
    const lang = document.getElementById('reader-import-lang');
    if (lang && !lang.value) lang.value = globalThis.AN2_LANG || 'fr';
    setExternalStatus(`⏳ Открываю ${name}...`);

    const response = await fetch(String(payload.url || ''), { cache: 'no-store' });
    if (!response.ok) throw new Error(`Android не передал файл (${response.status})`);
    const blob = await response.blob();
    const file = new File([blob], name, {
      type: mimeFor(name, payload.mime || blob.type),
      lastModified: Number(payload.lastModified || Date.now()),
    });

    // EPUB now has one owner: semantic-import-stage1. It parses text, images and
    // exact NCX/nav.xhtml from the same ZIP entries. Do not run toc-direct over
    // this File a second time — that used to double peak memory on Android.
    await actionViewHandler({ target: { files: [file], value: '' }, androidExternal: true });
    const status = document.getElementById('reader-import-status');
    if (String(status?.textContent || '').trim().startsWith('❌')) return false;

    const selectedLang = document.getElementById('reader-import-lang');
    if (selectedLang && !selectedLang.value) selectedLang.value = globalThis.AN2_LANG || 'fr';

    await Promise.resolve(saveHandler());
    return true;
  } catch (error) {
    const message = String(error?.message || error);
    setExternalStatus(`❌ ${message}`, 'error');
    window.showToast?.(`⚠️ Не удалось открыть файл: ${message}`);
    return false;
  }
}

window.readerImportAndroidFile = readerImportAndroidFile;