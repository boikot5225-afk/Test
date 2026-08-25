// Fixed Chinese annotation geometry for toc44.
// Every Chinese token reserves the same three-row slot BEFORE page measurement.
// Hint content is painted out-of-flow; Known/Unknown changes pixels, never geometry.
const STYLE_ID = 'reader-zh-stable-slots-v1';
let rootObserver = null;
let observedRoot = null;

function modeEnabled() {
  const view = document.getElementById('reader-reading-view');
  if (!view || view.dataset.readerLang !== 'zh') return false;
  try {
    if (typeof globalThis.readerGetZhUnknownGlossMode === 'function') {
      return globalThis.readerGetZhUnknownGlossMode() === 'unknown';
    }
  } catch {}
  return view.classList.contains('rd-zh-unknown-gloss');
}

function normalizePlaceholder(wrap) {
  if (!wrap) return;
  const raw = String(wrap.dataset.zhGlossRu || '').trim();
  const readable = String(wrap.dataset.zhGlossRuReadable || '').trim();
  if (raw === '…' || raw === '...') wrap.dataset.zhGlossRu = '';
  if (readable === '…' || readable === '...') wrap.dataset.zhGlossRuReadable = '';
}

function ensureWordSlot(word) {
  if (!word?.classList?.contains('reader-word')) return null;
  if (String(word.dataset.lang || '') !== 'zh') return null;
  if (!/[㐀-鿿]/.test(String(word.dataset.word || word.textContent || ''))) return null;

  let wrap = word.parentElement?.classList?.contains('rw-zh-gloss-wrap') ? word.parentElement : null;
  if (!wrap) {
    wrap = document.createElement('span');
    wrap.className = 'rw-zh-gloss-wrap rw-zh-fixed-slot';
    wrap.dataset.zhGloss = '1';
    const parent = word.parentNode;
    if (!parent) return null;
    parent.insertBefore(wrap, word);
    wrap.appendChild(word);
  } else {
    wrap.classList.add('rw-zh-fixed-slot');
  }

  const rt = String(word.querySelector?.('rt')?.textContent || '').trim();
  if (!wrap.dataset.zhGlossPinyin && rt) wrap.dataset.zhGlossPinyin = rt;
  if (!('zhGlossRu' in wrap.dataset)) wrap.dataset.zhGlossRu = '';
  if (!('zhGlossRuReadable' in wrap.dataset)) wrap.dataset.zhGlossRuReadable = '';
  normalizePlaceholder(wrap);
  return wrap;
}

function prepareStableSlots(root = document.getElementById('reader-chapter-text')) {
  if (!root || !modeEnabled()) return 0;
  let count = 0;
  root.querySelectorAll('.reader-word[data-lang="zh"]').forEach(word => {
    if (ensureWordSlot(word)) count += 1;
  });
  return count;
}

function prepareAddedNode(node) {
  if (!(node instanceof Element) || !modeEnabled()) return;
  if (node.classList.contains('reader-word')) ensureWordSlot(node);
  node.querySelectorAll?.('.reader-word[data-lang="zh"]').forEach(ensureWordSlot);
}

function installStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    /* One line metric for the whole Chinese page. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-paragraph-text {
      line-height:2.18 !important;
    }

    /* :has(> .reader-word) intentionally matches the specificity of the old
       rw-new/rw-seen/rw-faded collapse rules, but loads later and wins. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .reader-word) {
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

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .reader-word) > .reader-word {
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

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .reader-word) > .reader-word rt {
      display:none !important;
    }

    /* Pinyin/Russian are absolutely painted around the Hanzi-sized column.
       They therefore cannot widen a token when data arrives later. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .reader-word)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .reader-word)::after {
      display:block !important;
      position:absolute !important;
      left:50% !important;
      transform:translateX(-50%) !important;
      width:max-content !important;
      min-width:0 !important;
      max-width:6.4em !important;
      margin:0 !important;
      padding:0 !important;
      overflow:hidden !important;
      text-overflow:ellipsis !important;
      white-space:nowrap !important;
      text-align:center !important;
      pointer-events:none !important;
      line-height:1 !important;
      font-family:'IBM Plex Sans',system-ui,sans-serif !important;
      color:var(--text-muted) !important;
      z-index:1 !important;
      visibility:visible !important;
      transition:none !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .reader-word)::before {
      content:attr(data-zh-gloss-pinyin) !important;
      top:.02em !important;
      font-size:.51em !important;
      font-weight:500 !important;
      color:color-mix(in srgb,var(--text-muted) 86%,var(--accent)) !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .reader-word)::after {
      content:attr(data-zh-gloss-ru) !important;
      bottom:.015em !important;
      font-size:.46em !important;
      font-weight:400 !important;
    }

    /* Known keeps the exact same slot, but its hint pixels are invisible. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-known)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-known)::after,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-known)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-known)::after {
      visibility:hidden !important;
    }

    /* A loading placeholder is visually empty. Real ellipsis inside a genuine
       translation is untouched; only the exact placeholder values disappear. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap[data-zh-gloss-ru="…"]::after,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap[data-zh-gloss-ru="..."]::after {
      content:'' !important;
    }
  `;
  document.head.appendChild(style);
}

function installObserver() {
  if (typeof MutationObserver === 'undefined') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) { setTimeout(installObserver, 250); return; }
  if (rootObserver && observedRoot === root) return;
  rootObserver?.disconnect();
  observedRoot = root;
  rootObserver = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.addedNodes || []) prepareAddedNode(node);
      } else if (record.type === 'attributes') {
        const wrap = record.target?.classList?.contains('rw-zh-gloss-wrap') ? record.target : null;
        if (wrap) normalizePlaceholder(wrap);
      }
    }
  });
  rootObserver.observe(root, {
    childList:true,
    subtree:true,
    attributes:true,
    attributeFilter:['data-zh-gloss-ru','data-zh-gloss-ru-readable'],
  });
}

function install() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  installStyles();
  prepareStableSlots();
  installObserver();
}

globalThis.readerPrepareZhStableSlots = prepareStableSlots;

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once:true });
else install();
window.addEventListener('pageshow', install);

export { prepareStableSlots, ensureWordSlot };
