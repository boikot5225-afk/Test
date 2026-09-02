// Import-only guard for the in-app "audio first -> choose EPUB" transition.
//
// This module intentionally has NO imports. In particular it must not import
// reader-app or IndexedDB during cold start: ACTION_VIEW has a carefully gated
// legacy-library migration path that must remain behaviorally identical.

let activeManualEpubImport = null;
let installedWrapper = null;
let resetQueue = Promise.resolve();
let manualSelectionGeneration = 0;

const importIsolationStats = globalThis.__readerImportIsolationStats || {
  epubStarts: 0,
  canonicalResets: 0,
  dedupedCalls: 0,
  blockedConcurrent: 0,
  supersededCalls: 0,
};
if (!Number.isFinite(Number(importIsolationStats.supersededCalls))) importIsolationStats.supersededCalls = 0;
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

function clearStaleImportUi() {
  const title = document.getElementById('reader-import-title');
  const author = document.getElementById('reader-import-author');
  const preview = document.getElementById('reader-import-text');
  const audioStatus = document.getElementById('reader-import-audio-status');
  const stopButton = document.getElementById('reader-audio-stop-btn');

  if (title) title.value = '';
  if (author) author.value = '';
  if (preview) preview.value = '';
  if (audioStatus) {
    audioStatus.style.display = 'none';
    audioStatus.textContent = '';
  }
  if (stopButton) stopButton.style.display = 'none';
}

// reader-app keeps the pending audio blob/timestamps private. Its normal file
// import entry resets those fields synchronously before it inspects the file
// extension. Use a tiny sentinel object that stops execution immediately after
// that reset point: no fake TXT is parsed and nothing is allowed to race the
// real EPUB UI afterwards.
async function resetCanonicalPendingAudio(canonicalImport) {
  const stop = new Error('reader import state reset complete');
  stop.name = 'ReaderImportResetComplete';
  const resetFile = {
    name: {
      toLowerCase() { throw stop; },
    },
  };
  try {
    await canonicalImport({
      target: { files: [resetFile], value: '' },
      __readerImportStateReset: true,
    });
  } catch (error) {
    if (error !== stop && error?.name !== 'ReaderImportResetComplete') {
      console.warn('[audio->epub] canonical reset result', error);
    }
  }
  importIsolationStats.canonicalResets += 1;
}

function semanticHandler() {
  const current = window.readerImportFromFile;
  if (typeof current !== 'function' || current.__isStub) return null;
  if (current.__readerAudioEpubIsolationV3) return current;
  if (!current.__semanticStage1 || typeof current.__semanticOriginal !== 'function') return null;
  return current;
}

function installIsolation() {
  const semanticImport = semanticHandler();
  if (!semanticImport) return false;
  if (semanticImport.__readerAudioEpubIsolationV3) {
    installedWrapper = semanticImport;
    window.__real_readerImportFromFile = semanticImport;
    return true;
  }

  const canonicalImport = semanticImport.__semanticOriginal;

  const wrapped = function readerImportAudioEpubIsolated(event, ...args) {
    // Android ACTION_VIEW must remain on the established semantic path. Do not
    // clear UI or touch canonical pending state here.
    if (event?.androidExternal === true) {
      return semanticImport.call(this, event, ...args);
    }

    const file = fileFromEvent(event);
    if (!isEpub(file)) return semanticImport.call(this, event, ...args);

    const key = fingerprint(file);
    if (activeManualEpubImport?.fingerprint === key) {
      importIsolationStats.dedupedCalls += 1;
      return activeManualEpubImport.promise;
    }

    const selectionGeneration = ++manualSelectionGeneration;
    if (activeManualEpubImport) {
      importIsolationStats.supersededCalls += 1;
      // Invalidate the old semantic generation NOW, before waiting even for the
      // tiny private-audio reset. This prevents a stale parser from repainting
      // progress/title in the gap between the user's second selection and the
      // second parser starting.
      try { semanticImport.call(this, { __readerSupersedeSemanticImport: true }); } catch {}
    }

    clearStaleImportUi();
    setStatus(`⏳ Открываю ${file.name}...`);

    const resetTask = resetQueue.then(() => resetCanonicalPendingAudio(canonicalImport));
    resetQueue = resetTask.catch(() => {});

    let promise;
    promise = (async () => {
      await resetTask;
      if (selectionGeneration !== manualSelectionGeneration) return null;
      clearStaleImportUi();
      setStatus(`⏳ Открываю ${file.name}...`);
      importIsolationStats.epubStarts += 1;
      return semanticImport.call(this, event, ...args);
    })().finally(() => {
      if (activeManualEpubImport?.promise === promise) activeManualEpubImport = null;
    });

    activeManualEpubImport = {
      generation: selectionGeneration,
      fingerprint: key,
      name: String(file.name || 'EPUB'),
      promise,
    };
    return promise;
  };

  wrapped.__readerAudioEpubIsolationV3 = true;
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

installIsolation();

export function readerAudioEpubIsolationInstalled() {
  return !!installedWrapper;
}
