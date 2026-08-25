// Cosmetic spacing pass for the optional Chinese unknown-word aid.
// Layout only: no vocabulary state, navigation, AI, rendering or click logic.

function injectSpacingStyle() {
  if (document.getElementById('rd-zh-unknown-gloss-spacing-style')) return;
  const style = document.createElement('style');
  style.id = 'rd-zh-unknown-gloss-spacing-style';
  style.textContent = `
    /* Keep a predictable vertical lane above/below every Chinese text line. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-paragraph-text {
      line-height: 2.18 !important;
    }

    /* Keep both annotations visually attached to their own Hanzi. The extra
       line-height above creates the breathing room toward neighbouring lines. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-looked)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-learning)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-familiar)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-problem)::before {
      bottom: calc(100% + .045em) !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-looked)::after,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-learning)::after,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-familiar)::after,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-problem)::after {
      top: calc(100% + .045em) !important;
    }
  `;
  document.head.appendChild(style);
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectSpacingStyle, { once: true });
  } else {
    injectSpacingStyle();
  }
}

export { injectSpacingStyle };
