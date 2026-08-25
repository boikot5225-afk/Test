// Temporary MutationObserver wrapper used only while vocab-estimate.js installs.
// The vocabulary layer used to watch the whole document and reclassify every
// rendered word after any childList mutation. The Chinese gloss layer itself
// creates/removes wrappers, so those two observers could keep waking each other
// up and make long Chinese pages stutter or hang.
//
// Keep the narrow gloss-attribute observer, but deliberately suppress only the
// document-wide childList sweep. Chapter renders now request one explicit vocab
// pass instead.
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
      const isDocumentWideVocabSweep = !!options.childList
        && !!options.subtree
        && !options.attributes
        && (target === document.documentElement || target === document.body);
      if (isDocumentWideVocabSweep) return;
      this._inner.observe(target, { ...options, characterData: false });
    }

    disconnect() { this._inner.disconnect(); }
    takeRecords() { return this._inner.takeRecords(); }
  };
}
