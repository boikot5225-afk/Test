// toc128: isolate only the in-app "audio first -> choose EPUB" transition.
//
// This module intentionally has NO imports. In particular it must not import
// reader-app or IndexedDB during cold start: ACTION_VIEW has a carefully gated
// legacy-library migration path that must remain byte-for-byte behaviorally
// equivalent to the pre-toc128 build.

let activeManualEpubImport = null;
let installedWrapper = null;

const importIsolationStats = globalThis.__readerImportIsolationStats || {
  epubStarts: 0,
  canonicalResets: 0,
  dedupedCalls: 0,
  blockedConcurrent: 0,
};
globalThis.__readerImportIsolationStats = importIsolationStats;

function fileFromEvent(event) {
  return event?.target?.files?.[0] || null;
}

function isEpub(file) {
  return !!file && String(file.name || '').toLowerCase().endsWith('.epub');
}

function fingerprint(file) {
  return `${String(file?.name || '')}|${Number(file?.size || 0)}|${Number(file?.lastModified || 0)}`;
}

function setStatus(message) {
  const status = document.getElementById('reader-import-status');
  if (!status) return;
  status.style.display = 'block';
  status.style.color = 'var(--accent)';
  status.textContent = message;
}

function clearStaleAudioUi() {
  const audioStatus = document.getElementById('reader-import-audio-status');
  if (audioStatus) {
    audioStatus.style.display = 'none';
    audioStatus.textContent = '';
  }
  const stopButton = document.getElementById('reader-audio-stop-btn');
  if (stopButton) stopButton.style.display = 'none';
}

// reader-app keeps the pending audio blob/timestamps private. Its ordinary
// text-file import entry point already clears those private fields before it
// parses the selected file. Feed it a harmless empty in-memory text file only
// for that reset, then let semantic EPUB own the real EPUB exactly once.
async function resetCanonicalPendingAudio(canonicalImport) {
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
    // The reset happens synchronously at the beginning of reader-app's import
    // path. A later empty-text validation error is irrelevant and must not make
    // the real EPUB fail.
    console.warn('[audio->epub] canonical reset parser result', error);
  }
  importIsolationStats.canonicalResets += 1;
}

function semanticHandler() {
  const current = window.readerImportFromFile;
  if (typeof current !== 'function' || current.__isStub) return null;
  if (current.__readerAudioEpubIsolationV2) return current;
  if (!current.__semanticStage1 || typeof current.__semanticOriginal !== 'function') return null;
  return current;
}

function installIsolation() {
  const semanticImport = semanticHandler();
  if (!semanticImport) return false;
  if (semanticImport.__readerAudioEpubIsolationV2) {
    installedWrapper = semanticImport;
    window.__real_readerImportFromFile = semanticImport;
    return true;
  }

  const canonicalImport = semanticImport.__semanticOriginal;

  const wrapped = function readerImportAudioEpubIsolated(event, ...args) {
    // Android ACTION_VIEW must remain on the pre-toc128 semantic path. Do not
    // clear UI, touch canonical pending state, create a File, or start timers.
    if (event?.androidExternal === true) {
      return semanticImport.call(this, event, ...args);
    }

    const file = fileFromEvent(event);
    if (!isEpub(file)) return semanticImport.call(this, event, ...args);

    const key = fingerprint(file);
    if (activeManualEpubImport) {
      if (activeManualEpubImport.fingerprint === key) {
        importIsolationStats.dedupedCalls += 1;
        return activeManualEpubImport.promise;
      }
      importIsolationStats.blockedConcurrent += 1;
      setStatus(`⏳ Уже разбираю ${activeManualEpubImport.name}. Дождись завершения перед выбором другого EPUB.`);
      return activeManualEpubImport.promise;
    }

    clearStaleAudioUi();
    setStatus(`⏳ Открываю ${file.name}...`);

    let promise;
    promise = (async () => {
      await resetCanonicalPendingAudio(canonicalImport);
      clearStaleAudioUi();
      setStatus(`⏳ Открываю ${file.name}...`);
      importIsolationStats.epubStarts += 1;
      return semanticImport.call(this, event, ...args);
    })().finally(() => {
      if (activeManualEpubImport?.promise === promise) activeManualEpubImport = null;
    });

    activeManualEpubImport = {
      fingerprint: key,
      name: String(file.name || 'EPUB'),
      promise,
    };
    return promise;
  };

  // Preserve semantic markers so the existing bridge/handler synchronization
  // treats this as the same semantic route rather than installing another one.
  wrapped.__readerAudioEpubIsolationV2 = true;
  wrapped.__semanticStage1 = true;
  wrapped.__semanticOriginal = canonicalImport;
  wrapped.__upgraded = semanticImport;

  window.readerImportFromFile = wrapped;
  window.__real_readerImportFromFile = wrapped;
  installedWrapper = wrapped;
  return true;
}

let attempts = 0;
const timer = setInterval(() => {
  attempts += 1;
  if (installIsolation() || attempts >= 240) clearInterval(timer);
}, 50);

// Also try immediately for warm navigation where semantic import is already up.
installIsolation();

export function readerAudioEpubIsolationInstalled() {
  return !!installedWrapper;
}
