// Temporary MutationObserver wrapper used only while vocab-estimate.js installs.
// The vocabulary layer watches chapter/panel DOM creation, but its own status
// labels also mutate the DOM. Filter those self-generated mutations and ignore
// characterData so the observer cannot schedule an endless repaint loop.
const NativeMutationObserver = globalThis.MutationObserver;

if (NativeMutationObserver && !globalThis.__readerVocabNativeMutationObserver) {
  globalThis.__readerVocabNativeMutationObserver = NativeMutationObserver;

  globalThis.MutationObserver = class ReaderVocabularyMutationObserver {
    constructor(callback) {
      this._inner = new NativeMutationObserver((records) => {
        const meaningful = records.filter((record) => {
          const target = record.target instanceof Element
            ? record.target
            : record.target?.parentElement;
          if (!target) return true;
          return !target.closest?.('.rwp-migaku-source, .rwp-vocab-estimate-btn');
        });
        if (meaningful.length) callback(meaningful, this);
      });
    }

    observe(target, options = {}) {
      this._inner.observe(target, { ...options, characterData: false });
    }

    disconnect() { this._inner.disconnect(); }
    takeRecords() { return this._inner.takeRecords(); }
  };
}
