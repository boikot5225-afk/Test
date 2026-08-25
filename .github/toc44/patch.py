from pathlib import Path
import re

BASE = '9c223393820825472a3470f34cb04c10db6aad90'

# 1) Every Chinese token stays inside a gloss wrapper, including legacy rw-known.
p = Path('js/reader/zh-unknown-gloss.js')
t = p.read_text('utf-8')
old = "if (!isChineseWordElement(el) || isKnownElement(el)) return null;"
assert old in t
t = t.replace(old, "if (!isChineseWordElement(el)) return null;", 1)
old = "wrap.dataset.zhGlossRu = ru || '…';"
assert old in t
t = t.replace(old, "wrap.dataset.zhGlossRu = ru || '';", 1)
old = """    if (isKnownElement(el)) {\n      unwrapWord(el);\n      continue;\n    }\n\n"""
assert old in t
t = t.replace(old, '', 1)
p.write_text(t, 'utf-8')

# 2) Readable layer stops doing width snapshots / wrapper surgery. Missing RU = blank.
p = Path('js/reader/zh-unknown-gloss-readable.js')
t = p.read_text('utf-8')
old = "if (raw === '…' || raw === '...') return '…';"
assert old in t
t = t.replace(old, "if (raw === '…' || raw === '...') return '';", 1)
old = "wrap.dataset.zhGlossRuReadable = compactMeaning(raw) || (raw ? '…' : '');"
assert old in t
t = t.replace(old, "wrap.dataset.zhGlossRuReadable = compactMeaning(raw) || '';", 1)
pat = r"function syncWordState\(word\) \{.*?\n\}\n\nfunction scan"
repl = """function syncWordState(word) {\n  // toc44: word state must never dismantle or resize the Chinese annotation slot.\n  // Known/Unknown now changes only visibility; the wrapper remains in normal flow.\n  if (!word?.classList?.contains('reader-word')) return;\n}\n\nfunction scan"""
t, n = re.subn(pat, repl, t, count=1, flags=re.S)
assert n == 1, n
p.write_text(t, 'utf-8')

# 3) One authoritative, fixed-footprint layer. Hint text is absolutely positioned,
# so late pinyin/Russian updates cannot affect line wrapping or paragraph height.
stable = r'''// Fixed Chinese annotation geometry for toc44.
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
      content:attr(data-zh-gloss-ru-readable) !important;
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
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap[data-zh-gloss-ru-readable="…"]::after,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap[data-zh-gloss-ru-readable="..."]::after {
      content:'' !important;
    }
  `;
  document.head.appendChild(style);
}

function installObserver() {
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
  installStyles();
  prepareStableSlots();
  installObserver();
}

globalThis.readerPrepareZhStableSlots = prepareStableSlots;

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once:true });
else install();
window.addEventListener('pageshow', install);

export { prepareStableSlots, ensureWordSlot };
'''
Path('js/reader/zh-stable-slots.js').write_text(stable, 'utf-8')

# 4) Load the fixed-slot layer after the legacy gloss CSS and after vocab classes exist.
p = Path('js/reader/interactions-runtime.js')
t = p.read_text('utf-8')
old = "import './vocab-layout-lock.js?v=1';\n"
assert old in t
t = t.replace(old, "import './zh-stable-slots.js?v=1';\n", 1)
p.write_text(t, 'utf-8')

# Retire toc43's status-dependent slot CSS to avoid specificity fights.
old_lock = Path('js/reader/vocab-layout-lock.js')
if old_lock.exists(): old_lock.unlink()

# 5) Pagination: prepare geometry before measurement and freeze height-only viewport churn.
p = Path('js/reader/pages-mode.js')
t = p.read_text('utf-8')
old = """  let lastMeasuredWidth = 0;\n  let lastMeasuredHeight = 0;\n"""
new = """  let lastMeasuredWidth = 0;\n  let lastMeasuredHeight = 0;\n  // After a real chapter measurement, hint/data changes and Android system-bar\n  // height noise must not reshuffle paragraph boundaries. Explicit full renders\n  // and real width changes still invalidate the freeze.\n  let paginationFrozen = false;\n"""
assert old in t
t = t.replace(old, new, 1)
old = """    unwrap(chapterText);\n    if (!enabled) {\n"""
new = """    unwrap(chapterText);\n    // Chinese annotation slots must exist before getBoundingClientRect() is ever\n    // used for page grouping. Later hint text is out-of-flow and cannot resize it.\n    try { globalThis.readerPrepareZhStableSlots?.(chapterText); } catch (error) {\n      console.warn('[reader pages] stable Chinese slot preparation failed', error?.message || error);\n    }\n    if (!enabled) {\n"""
assert old in t
t = t.replace(old, new, 1)
old = """      pages = [];\n      currentPageIndex = 0;\n      animating = false;\n      return;\n"""
new = """      pages = [];\n      currentPageIndex = 0;\n      animating = false;\n      paginationFrozen = false;\n      return;\n"""
assert old in t
t = t.replace(old, new, 1)
old = """    animating = false;\n    showPageInstant(pageIndexForParagraph(getActiveParagraphIndex()));\n  }\n"""
new = """    animating = false;\n    paginationFrozen = true;\n    showPageInstant(pageIndexForParagraph(getActiveParagraphIndex()));\n  }\n"""
assert old in t
t = t.replace(old, new, 1)
old = """    if (!pages.length || livePages.length !== pages.length || cachedDisconnected || !currentConnected) {\n      rebuild();\n    }\n"""
new = """    if (!pages.length || livePages.length !== pages.length || cachedDisconnected || !currentConnected) {\n      paginationFrozen = false;\n      rebuild();\n    }\n"""
assert old in t
t = t.replace(old, new, 1)
old = """  function syncAfterRender({ full = false, queryOnly = false } = {}) {\n    if (queryOnly) return enabled;\n    if (full) rebuild();\n    else resync();\n    return enabled;\n  }\n"""
new = """  function syncAfterRender({ full = false, queryOnly = false } = {}) {\n    if (queryOnly) return enabled;\n    if (full) {\n      // A real chapter/font/layout render is allowed to establish a new frozen map.\n      paginationFrozen = false;\n      rebuild();\n    } else resync();\n    return enabled;\n  }\n"""
assert old in t
t = t.replace(old, new, 1)
old = """      const dw = Math.abs(scroller.clientWidth - lastMeasuredWidth);\n      const dh = Math.abs(scroller.clientHeight - lastMeasuredHeight);\n      if (lastMeasuredWidth && lastMeasuredHeight && dw < 8 && dh < 24) return;\n      if (animating) {\n        handleResize();\n        return;\n      }\n      rebuild();\n"""
new = """      const dw = Math.abs(scroller.clientWidth - lastMeasuredWidth);\n      const dh = Math.abs(scroller.clientHeight - lastMeasuredHeight);\n      if (lastMeasuredWidth && lastMeasuredHeight && dw < 8 && dh < 24) return;\n      // Android WebView frequently changes only viewport height when system/reader\n      // chrome settles. Keep the already measured page boundaries in that case.\n      if (paginationFrozen && lastMeasuredWidth && dw < 8) {\n        lastMeasuredHeight = scroller.clientHeight;\n        return;\n      }\n      if (animating) {\n        handleResize();\n        return;\n      }\n      paginationFrozen = false;\n      rebuild();\n"""
assert old in t
t = t.replace(old, new, 1)
p.write_text(t, 'utf-8')

# 6) Version bump.
p = Path('android/app/build.gradle')
t = p.read_text('utf-8')
assert 'versionCode 63' in t
assert "versionName '77.42-toc43'" in t
t = t.replace('versionCode 63', 'versionCode 64', 1)
t = t.replace("versionName '77.42-toc43'", "versionName '77.42-toc44'", 1)
p.write_text(t, 'utf-8')

# Source-level invariants.
assert "ru || '…'" not in Path('js/reader/zh-unknown-gloss.js').read_text('utf-8')
assert "unwrapWord(el);\n      continue;" not in Path('js/reader/zh-unknown-gloss.js').read_text('utf-8')
assert "readerPrepareZhStableSlots" in Path('js/reader/pages-mode.js').read_text('utf-8')
assert "paginationFrozen" in Path('js/reader/pages-mode.js').read_text('utf-8')
assert "position:absolute !important" in Path('js/reader/zh-stable-slots.js').read_text('utf-8')
assert "import './zh-stable-slots.js?v=1';" in Path('js/reader/interactions-runtime.js').read_text('utf-8')
