// Presentation-only companion for zh-unknown-gloss.js.
// It does not change Reader state, navigation, vocabulary state, AI requests,
// or the original Chinese word elements. It only gives the annotations enough
// room to be readable on a phone and shortens long Russian dictionary strings
// for the inline view.

let rootObserver = null;
let retryTimer = null;

function compactMeaning(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (raw === '…' || raw === '...') return '…';

  // Inline reading needs one quick cue, not a whole dictionary entry.
  // Prefer the first sense before common dictionary separators.
  let short = raw
    .split(/\s*(?:[;；]|[,，]|\/|\||·)\s*/)[0]
    .replace(/^(?:сущ\.?|гл\.?|прил\.?|нареч\.?|мест\.?|част\.?|предл\.?)\s*/i, '')
    .trim();

  if (!short) short = raw;
  if (short.length <= 16) return short;

  const clipped = short.slice(0, 16);
  const boundary = clipped.lastIndexOf(' ');
  if (boundary >= 8) short = clipped.slice(0, boundary);
  else short = clipped;
  return short.trimEnd() + '…';
}

function syncWrapper(wrap) {
  if (!wrap?.classList?.contains('rw-zh-gloss-wrap')) return;
  const raw = wrap.dataset.zhGlossRu || '';
  wrap.dataset.zhGlossRuReadable = compactMeaning(raw) || (raw ? '…' : '');
}

function scan(root = document.getElementById('reader-chapter-text')) {
  if (!root) return;
  root.querySelectorAll('.rw-zh-gloss-wrap').forEach(syncWrapper);
}

function injectStyles() {
  if (document.getElementById('rd-zh-unknown-gloss-readable-style')) return;
  const style = document.createElement('style');
  style.id = 'rd-zh-unknown-gloss-readable-style';
  style.textContent = `
    /* Readability override only for the optional Chinese unknown-word mode. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-paragraph-text {
      line-height: 2.18 !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap {
      grid-template-rows: .58em 1.08em .54em !important;
      grid-template-columns: max-content !important;
      vertical-align: -.48em !important;
      margin: 0 .055em !important;
      padding: 0 .025em !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap::after {
      width: max-content !important;
      min-width: 100% !important;
      max-width: 6.4em !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
      text-align: center !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap::before {
      font-size: .51em !important;
      font-weight: 500 !important;
      letter-spacing: .005em;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap::after {
      content: attr(data-zh-gloss-ru-readable) !important;
      font-size: .46em !important;
      font-weight: 400 !important;
      letter-spacing: 0;
      opacity: .94;
    }
  `;
  document.head.appendChild(style);
}

function install() {
  injectStyles();
  const root = document.getElementById('reader-chapter-text');
  if (!root) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(install, 250);
    return;
  }

  scan(root);
  if (rootObserver) return;

  rootObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        syncWrapper(mutation.target);
        continue;
      }
      mutation.addedNodes?.forEach((node) => {
        if (node?.nodeType !== 1) return;
        if (node.classList?.contains('rw-zh-gloss-wrap')) syncWrapper(node);
        node.querySelectorAll?.('.rw-zh-gloss-wrap').forEach(syncWrapper);
      });
    }
  });
  rootObserver.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-zh-gloss-ru'],
  });
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
  window.addEventListener('pageshow', () => {
    scan();
    install();
  });
}

export { compactMeaning };
