const SUPPORTED_EXTENSIONS = new Set(['epub', 'fb2', 'txt', 'text', 'md']);

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function currentHandler(name) {
  // Reader upgrades (EPUB TOC, durable deletion) are installed after app.js
  // finalizes its buffering stubs. Prefer the live window handler so Android
  // external imports cannot bypass a newer wrapper via a stale __real_* copy.
  const live = window[name];
  if (typeof live === 'function' && !live.__isStub) return live;
  const real = window[`__real_${name}`];
  return typeof real === 'function' && !real.__isStub ? real : null;
}

async function waitUntilReady(timeoutMs = 60000, { requireEpubToc = false } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const main = document.getElementById('main-app');
    const importHandler = currentHandler('readerImportFromFile');
    const saveHandler = currentHandler('saveReaderImport');
    const tocReady = !requireEpubToc || typeof window.readerTocDiagnostics === 'function';
    if (main?.style.display !== 'none'
      && typeof window.showReaderImportModal === 'function'
      && typeof importHandler === 'function'
      && typeof saveHandler === 'function'
      && tocReady) {
      return { importHandler, saveHandler };
    }
    await wait(120);
  }
  throw new Error(requireEpubToc
    ? 'Reader AI не подготовил EPUB-оглавление. Перезапусти приложение и попробуй снова.'
    : 'Reader AI не завершил вход. Войди в приложение или выбери гостевой режим.');
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

export async function readerImportAndroidFile(payload = {}) {
  const name = safeFileName(payload.name);
  const extension = extensionOf(name);
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    window.showToast?.(`⚠️ Формат .${extension || '?'} пока не поддерживается`);
    return false;
  }

  try {
    // EPUB absolutely must go through the TOC wrapper. Previous builds grabbed
    // stale __real_readerImportFromFile/__real_saveReaderImport handlers here,
    // which silently skipped toc.ncx/nav.xhtml parsing on Android even though
    // the same parser worked in the normal browser file picker.
    const { importHandler, saveHandler } = await waitUntilReady(60000, {
      requireEpubToc: extension === 'epub',
    });
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

    await importHandler({ target: { files: [file], value: '' }, androidExternal: true });
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
