// Compatibility layer between the Migaku-style Known/Unknown assessment and
// the already-stable Chinese pinyin/Russian annotation renderer.
//
// Vocabulary estimation must classify words, not physically dismantle the
// Chinese layout. vocab-estimate.js used a synthetic rw-known class because the
// old gloss module understood that class as "known"; the old module then
// unwrapped the word, which made Unknown annotations disappear and triggered a
// costly observer feedback loop. Keep rw-migaku-known / rw-migaku-unknown as the
// public visual state and strip only the synthetic legacy rw-known marker.

const STYLE_ID = 'reader-vocab-stability-style-v1';
let cleanupScheduled = false;
let rootObserver = null;

function cleanupWord(word) {
  if (!word?.classList?.contains('reader-word')) return;

  if (word.dataset?.readerVocabSyntheticKnown === '1') {
    word.classList.remove('rw-known');
    delete word.dataset.readerVocabSyntheticKnown;
  }

  const wrap = word.parentElement?.classList?.contains('rw-zh-gloss-wrap')
    ? word.parentElement
    : null;
  if (!wrap) return;

  if (word.classList.contains('rw-migaku-known')) {
    wrap.classList.remove('rw-migaku-gloss-active');
    wrap.style.removeProperty('--rw-migaku-annotation-width');
  } else if (word.classList.contains('rw-migaku-unknown')) {
    wrap.classList.add('rw-migaku-gloss-active');
  }
}

function cleanup(root = document.getElementById('reader-chapter-text')) {
  if (!root) return;
  root.querySelectorAll('.reader-word').forEach(cleanupWord);
}

function scheduleCleanup() {
  if (cleanupScheduled) return;
  cleanupScheduled = true;
  queueMicrotask(() => {
    cleanupScheduled = false;
    cleanup();
  });
}

function installStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    /* Restore the toc36 annotation geometry. The vocabulary layer may decide
       whether a hint is visible, but it must not replace the tested inline-grid
       layout with per-word measured inline blocks. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap.rw-migaku-gloss-active {
      display:inline-grid !important;
      grid-template-rows:.58em 1.08em .54em !important;
      grid-template-columns:max-content !important;
      align-items:center !important;
      justify-items:center !important;
      vertical-align:-.48em !important;
      line-height:1 !important;
      margin:0 .055em !important;
      padding:0 .025em !important;
      position:relative !important;
      overflow:visible !important;
      width:auto !important;
      min-width:0 !important;
      max-width:none !important;
      height:auto !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap.rw-migaku-gloss-active > .reader-word {
      grid-row:2 !important;
      grid-column:1 !important;
      align-self:center !important;
      justify-self:center !important;
      display:inline !important;
      position:static !important;
      vertical-align:baseline !important;
      margin:0 !important;
      padding:0 1px !important;
      line-height:1.08 !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap.rw-migaku-gloss-active::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap.rw-migaku-gloss-active::after {
      display:block !important;
      position:static !important;
      left:auto !important;
      top:auto !important;
      bottom:auto !important;
      transform:none !important;
      grid-column:1 !important;
      justify-self:center !important;
      width:max-content !important;
      min-width:100% !important;
      max-width:6.4em !important;
      height:auto !important;
      margin:0 !important;
      padding:0 !important;
      overflow:hidden !important;
      text-overflow:ellipsis !important;
      white-space:nowrap !important;
      text-align:center !important;
      pointer-events:none !important;
      line-height:1 !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap.rw-migaku-gloss-active::before {
      grid-row:1 !important;
      align-self:end !important;
      content:attr(data-zh-gloss-pinyin) !important;
      font-size:.51em !important;
      font-weight:500 !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap.rw-migaku-gloss-active::after {
      grid-row:3 !important;
      align-self:start !important;
      content:attr(data-zh-gloss-ru-readable) !important;
      font-size:.46em !important;
      font-weight:400 !important;
    }
  `;
  document.head.appendChild(style);
}

function installRootObserver() {
  if (rootObserver || typeof MutationObserver === 'undefined') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) {
    setTimeout(installRootObserver, 250);
    return;
  }

  // Narrow observer: only the synthetic marker that vocab-estimate itself
  // writes. No childList/subtree sweep, so Chinese wrapper mutations do not
  // feed back into vocabulary classification.
  rootObserver = new MutationObserver((records) => {
    for (const record of records) {
      const word = record.target;
      if (word?.dataset?.readerVocabSyntheticKnown === '1') cleanupWord(word);
    }
  });
  rootObserver.observe(root, {
    subtree: true,
    attributes: true,
    attributeFilter: ['data-reader-vocab-synthetic-known'],
  });
}

function wrapPublicApply() {
  const current = globalThis.readerApplyVocabularyEstimate;
  if (typeof current !== 'function' || current.__readerVocabStabilityWrapped) return;

  const wrapped = async (...args) => {
    try {
      return await current(...args);
    } finally {
      cleanup();
    }
  };
  wrapped.__readerVocabStabilityWrapped = true;
  globalThis.readerApplyVocabularyEstimate = wrapped;
}

function install() {
  installStyle();
  wrapPublicApply();
  installRootObserver();
  scheduleCleanup();
  requestAnimationFrame(scheduleCleanup);
  setTimeout(scheduleCleanup, 500);
  setTimeout(scheduleCleanup, 1500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', install, { once: true });
} else {
  install();
}
window.addEventListener('pageshow', install);
