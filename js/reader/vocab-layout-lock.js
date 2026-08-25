// Keeps Migaku Known/Unknown from changing the physical Chinese text slot.
// Visibility may change; width, baseline and annotation lanes must not.
const STYLE_ID = 'reader-vocab-slot-lock-v1';

function installVocabularySlotLock() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-known),
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-unknown) {
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
      box-sizing:border-box !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-known) > .reader-word,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-unknown) > .reader-word {
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

    /* Keep actual hint text in the grid for BOTH states. visibility:hidden
       still participates in layout, unlike display:none/content:'', so toggling
       Known <-> Unknown cannot change the word footprint. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-known)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-known)::after,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-unknown)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-unknown)::after {
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
      visibility:hidden !important;
      transition:none !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-known)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-unknown)::before {
      grid-row:1 !important;
      align-self:end !important;
      content:attr(data-zh-gloss-pinyin) !important;
      font-size:.51em !important;
      font-weight:500 !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-known)::after,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-unknown)::after {
      grid-row:3 !important;
      align-self:start !important;
      content:attr(data-zh-gloss-ru-readable) !important;
      font-size:.46em !important;
      font-weight:400 !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-unknown)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-unknown)::after {
      visibility:visible !important;
    }
  `;
  document.head.appendChild(style);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installVocabularySlotLock, { once: true });
} else {
  installVocabularySlotLock();
}

export { installVocabularySlotLock };
