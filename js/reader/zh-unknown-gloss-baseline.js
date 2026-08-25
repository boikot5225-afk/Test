// Baseline-safe presentation layer for the optional Chinese unknown-word mode.
// It changes layout only: vocabulary state, AI, navigation and the original word
// nodes remain owned by the stable reader and zh-unknown-gloss.js.

let rootObserver = null;
let resizeTimer = null;
let measureCanvas = null;

const TARGET_CLASSES = ['rw-looked', 'rw-learning', 'rw-familiar', 'rw-problem'];

function isTargetWord(word) {
  return !!word && TARGET_CLASSES.some((cls) => word.classList?.contains(cls));
}

function directWord(wrap) {
  if (!wrap?.classList?.contains('rw-zh-gloss-wrap')) return null;
  for (const child of wrap.children || []) {
    if (child.classList?.contains('reader-word')) return child;
  }
  return null;
}

function context2d() {
  if (!measureCanvas) measureCanvas = document.createElement('canvas');
  return measureCanvas.getContext?.('2d') || null;
}

function measureLabel(text, px, weight = 400) {
  const value = String(text || '').trim();
  if (!value) return 0;
  const ctx = context2d();
  if (!ctx) return value.length * px * 0.56;
  ctx.font = `${weight} ${px}px "IBM Plex Sans", system-ui, sans-serif`;
  return Number(ctx.measureText(value)?.width || 0);
}

function syncWidth(wrap) {
  if (!wrap?.classList?.contains('rw-zh-gloss-wrap')) return;
  const word = directWord(wrap);
  if (!isTargetWord(word)) {
    wrap.style.removeProperty('--rw-zh-annotation-width');
    return;
  }

  let fontSize = 32;
  try { fontSize = parseFloat(getComputedStyle(word).fontSize) || fontSize; } catch {}

  let wordWidth = 0;
  try { wordWidth = Number(word.getBoundingClientRect?.().width || 0); } catch {}
  if (!(wordWidth > 0)) wordWidth = Math.max(1, String(word.dataset?.word || word.textContent || '').length) * fontSize;

  const pinyin = String(wrap.dataset.zhGlossPinyin || '').trim();
  const ru = String(wrap.dataset.zhGlossRuReadable || wrap.dataset.zhGlossRu || '').trim();
  const pinyinWidth = measureLabel(pinyin, fontSize * 0.47, 500);
  const ruWidth = measureLabel(ru, fontSize * 0.41, 400);

  // Give the labels enough real horizontal room, but never let one dictionary
  // hint consume half the phone. Longer text is ellipsized by CSS.
  const maxWidth = fontSize * 5.15;
  const desired = Math.min(maxWidth, Math.max(wordWidth + 4, pinyinWidth + 8, ruWidth + 8));
  wrap.style.setProperty('--rw-zh-annotation-width', `${Math.ceil(desired * 10) / 10}px`);
}

function scan(root = document.getElementById('reader-chapter-text')) {
  if (!root) return;
  root.querySelectorAll('.rw-zh-gloss-wrap').forEach(syncWidth);
}

function injectStyles() {
  if (document.getElementById('rd-zh-unknown-gloss-baseline-style')) return;
  const style = document.createElement('style');
  style.id = 'rd-zh-unknown-gloss-baseline-style';
  style.textContent = `
    /* Keep every Hanzi on the same baseline. Annotation lanes live outside the
       word box and the paragraph line-height reserves vertical breathing room. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-paragraph-text {
      line-height: 2.02 !important;
    }

    /* The old ruby/pinyin mode must never leak into this mode. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-word rt {
      display: none !important;
    }

    /* Plain/non-target words keep normal inline flow even if the data layer has
       already wrapped them. They must not create grid tracks or vertical steps. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap {
      display: inline !important;
      position: static !important;
      vertical-align: baseline !important;
      width: auto !important;
      min-width: 0 !important;
      max-width: none !important;
      margin: 0 !important;
      padding: 0 !important;
      line-height: inherit !important;
      overflow: visible !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap > .reader-word {
      display: inline !important;
      position: static !important;
      vertical-align: baseline !important;
      margin: 0 !important;
      padding: 0 !important;
      line-height: inherit !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap::after {
      content: '' !important;
      display: none !important;
    }

    /* Only words the user is actually working on receive the three-level aid. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-looked),
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-learning),
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-familiar),
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-problem) {
      display: inline-block !important;
      position: relative !important;
      vertical-align: baseline !important;
      width: var(--rw-zh-annotation-width, auto) !important;
      min-width: var(--rw-zh-annotation-width, 0) !important;
      max-width: var(--rw-zh-annotation-width, none) !important;
      height: auto !important;
      margin: 0 .035em !important;
      padding: 0 !important;
      line-height: 1.12 !important;
      text-align: center !important;
      overflow: visible !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-looked) > .reader-word,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-learning) > .reader-word,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-familiar) > .reader-word,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-problem) > .reader-word {
      display: inline-block !important;
      position: static !important;
      vertical-align: baseline !important;
      margin: 0 !important;
      padding: 0 1px !important;
      line-height: 1.12 !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-looked)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-learning)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-familiar)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-problem)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-looked)::after,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-learning)::after,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-familiar)::after,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-problem)::after {
      display: block !important;
      position: absolute !important;
      left: 50% !important;
      transform: translateX(-50%) !important;
      width: calc(var(--rw-zh-annotation-width, 100%) - 2px) !important;
      max-width: calc(var(--rw-zh-annotation-width, 100%) - 2px) !important;
      min-width: 0 !important;
      height: auto !important;
      margin: 0 !important;
      padding: 0 !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
      text-align: center !important;
      pointer-events: none !important;
      font-family: 'IBM Plex Sans', system-ui, sans-serif !important;
      line-height: 1.05 !important;
      z-index: 1;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-looked)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-learning)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-familiar)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-problem)::before {
      content: attr(data-zh-gloss-pinyin) !important;
      bottom: calc(100% + .10em) !important;
      font-size: .47em !important;
      font-weight: 500 !important;
      color: color-mix(in srgb, var(--text-muted) 86%, var(--accent)) !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-looked)::after,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-learning)::after,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-familiar)::after,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-problem)::after {
      content: attr(data-zh-gloss-ru-readable) !important;
      top: calc(100% + .10em) !important;
      font-size: .41em !important;
      font-weight: 400 !important;
      color: var(--text-muted) !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-problem)::after {
      color: var(--bad) !important;
    }

    /* A just-marked-known word keeps the same horizontal slot until the next
       normal Reader render, but its Hanzi stays on the normal baseline. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-known-stable-wrap {
      display: inline-block !important;
      position: relative !important;
      vertical-align: baseline !important;
      height: auto !important;
      line-height: 1.12 !important;
      margin: 0 .035em !important;
      padding: 0 !important;
      box-sizing: border-box !important;
      text-align: center !important;
      overflow: visible !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-known-stable-wrap > .reader-word {
      display: inline-block !important;
      vertical-align: baseline !important;
      line-height: 1.12 !important;
      margin: 0 !important;
      padding: 0 1px !important;
    }
  `;
  document.head.appendChild(style);
}

function install() {
  injectStyles();
  const root = document.getElementById('reader-chapter-text');
  if (!root) {
    setTimeout(install, 250);
    return;
  }

  scan(root);
  if (rootObserver) return;
  rootObserver = new MutationObserver((mutations) => {
    let fullScan = false;
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        const target = mutation.target;
        if (target?.classList?.contains('rw-zh-gloss-wrap')) syncWidth(target);
        else if (target?.classList?.contains('reader-word')) syncWidth(target.parentElement);
        continue;
      }
      if (mutation.addedNodes?.length) fullScan = true;
    }
    if (fullScan) scan(root);
  });
  rootObserver.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'data-zh-gloss-pinyin', 'data-zh-gloss-ru', 'data-zh-gloss-ru-readable'],
  });
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
  window.addEventListener('pageshow', () => { install(); scan(); });
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => scan(), 160);
  }, { passive: true });
}

export { isTargetWord, syncWidth };
