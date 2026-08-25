// vocab-estimate-observer-pre.js wraps MutationObserver only long enough for
// vocab-estimate.js to construct its private observer. Restore the browser
// native immediately so the rest of Reader AI keeps normal DOM semantics.
if (globalThis.__readerVocabNativeMutationObserver) {
  globalThis.MutationObserver = globalThis.__readerVocabNativeMutationObserver;
  delete globalThis.__readerVocabNativeMutationObserver;
}
