// Chinese annotation stability v2.
//
// English unknown-gloss v2 keeps the last confirmed visibility and resolved
// translation when classifier/network passes are transient. Chinese used to
// bind visibility directly to rw-migaku-* classes and allowed a later scan to
// overwrite resolved data-* values with an empty string. On Android that looks
// exactly like a flash: hint -> blank -> hint. This layer is intentionally
// presentation-only; it does not change segmentation, vocabulary state, or AI.

const STYLE_ID = 'rd-zh-gloss-stability-v2-style';
const stats = {
  wrappersSeen: 0,
  blankPinyinIgnored: 0,
  blankRuIgnored: 0,
  pendingVisibilityPreserved: 0,
  memoryHydrates: 0,
};

let observer = null;
let observedRoot = null;
const memoryByKey = new Map();

function clean(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text === '…' || text === '...' ? '' : text;
}

function wordForWrapper(wrap) {
  const child = wrap?.querySelector?.(':scope > .reader-word');
  return child?.classList?.contains('reader-word') ? child : null;
}

function confirmedKnowledge(word) {
  if (!word) return '';
  if (word.classList.contains('rw-migaku-unknown')) return 'unknown';
  if (word.classList.contains('rw-migaku-known') || word.classList.contains('rw-known')) return 'known';
  return '';
}

function memoFor(wrap) {
  const key = String(wrap?.dataset?.zhGlossKey || '').trim();
  if (!key) return { key: '', memo: null };
  let memo = memoryByKey.get(key);
  if (!memo) {
    memo = { pinyin: '', ru: '' };
    memoryByKey.set(key, memo);
  }
  return { key, memo };
}

function syncResolvedText(wrap) {
  const sourcePinyin = clean(wrap.dataset.zhGlossPinyin);
  const sourceRu = clean(wrap.dataset.zhGlossRuReadable || wrap.dataset.zhGlossRu);
  const stickyPinyin = clean(wrap.dataset.zhGlossStickyPinyin);
  const stickyRu = clean(wrap.dataset.zhGlossStickyRu);
  const { memo } = memoFor(wrap);

  if (sourcePinyin) {
    if (stickyPinyin !== sourcePinyin) wrap.dataset.zhGlossStickyPinyin = sourcePinyin;
    if (memo) memo.pinyin = sourcePinyin;
  } else if (!stickyPinyin && memo?.pinyin) {
    wrap.dataset.zhGlossStickyPinyin = memo.pinyin;
    stats.memoryHydrates += 1;
  } else if (stickyPinyin) {
    stats.blankPinyinIgnored += 1;
  }

  if (sourceRu) {
    if (stickyRu !== sourceRu) wrap.dataset.zhGlossStickyRu = sourceRu;
    if (memo) memo.ru = sourceRu;
  } else if (!stickyRu && memo?.ru) {
    wrap.dataset.zhGlossStickyRu = memo.ru;
    stats.memoryHydrates += 1;
  } else if (stickyRu) {
    stats.blankRuIgnored += 1;
  }
}

function syncVisibility(wrap) {
  const word = wordForWrapper(wrap);
  const state = confirmedKnowledge(word);
  if (state === 'unknown') {
    if (wrap.dataset.zhGlossVisible !== '1') wrap.dataset.zhGlossVisible = '1';
    return;
  }
  if (state === 'known') {
    if (wrap.dataset.zhGlossVisible !== '0') wrap.dataset.zhGlossVisible = '0';
    return;
  }

  // Missing both classes is a transient/pending classifier state. This is the
  // crucial English-v2 rule: pending never means "erase/hide". For a brand-new
  // wrapper default to hidden until classification is confirmed once.
  if (!Object.prototype.hasOwnProperty.call(wrap.dataset, 'zhGlossVisible')) {
    wrap.dataset.zhGlossVisible = '0';
  } else {
    stats.pendingVisibilityPreserved += 1;
  }
}

function syncWrapper(wrap) {
  if (!wrap?.classList?.contains('rw-zh-gloss-wrap')) return;
  stats.wrappersSeen += 1;
  syncResolvedText(wrap);
  syncVisibility(wrap);
}

function syncNode(node) {
  if (!(node instanceof Element)) return;
  if (node.classList.contains('rw-zh-gloss-wrap')) syncWrapper(node);
  if (node.classList.contains('reader-word')) {
    const wrap = node.parentElement?.classList?.contains('rw-zh-gloss-wrap') ? node.parentElement : null;
    if (wrap) syncWrapper(wrap);
  }
  node.querySelectorAll?.('.rw-zh-gloss-wrap').forEach(syncWrapper);
}

function syncAll() {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return 0;
  const wraps = root.querySelectorAll('.rw-zh-gloss-wrap');
  wraps.forEach(syncWrapper);
  return wraps.length;
}

function installStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    /* Last writer wins: render only sticky, non-empty values. Old Chinese scans
       may still write data-zh-gloss-ru=""; that must not erase visible pixels. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap::before {
      content:attr(data-zh-gloss-sticky-pinyin) !important;
      transition:none !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap::after {
      content:attr(data-zh-gloss-sticky-ru) !important;
      transition:none !important;
    }

    /* Visibility belongs to a sticky confirmed state, not directly to a class
       that classifier code can remove/re-add during one of its async passes. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap[data-zh-gloss-visible="0"]::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap[data-zh-gloss-visible="0"]::after {
      visibility:hidden !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap[data-zh-gloss-visible="1"]::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap[data-zh-gloss-visible="1"]::after {
      visibility:visible !important;
    }

    /* A confirmed Known state hides immediately even before the observer's
       microtask mirrors it to data-zh-gloss-visible=0. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-known)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-migaku-known)::after,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-known)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-known)::after {
      visibility:hidden !important;
    }

    /* Keep the legacy top 拼 control authoritative. */
    #reader-reading-view.rd-zh-unknown-gloss.rd-zh-gloss-pinyin-off[data-reader-lang="zh"] .rw-zh-gloss-wrap::before {
      content:'' !important;
      display:none !important;
    }
  `;
  document.head.appendChild(style);
}

function installObserver() {
  if (typeof MutationObserver === 'undefined' || typeof Element === 'undefined') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) {
    setTimeout(installObserver, 200);
    return;
  }
  if (observer && observedRoot === root) return;
  observer?.disconnect();
  observedRoot = root;
  observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.addedNodes || []) syncNode(node);
        continue;
      }
      const target = record.target;
      if (!(target instanceof Element)) continue;
      if (target.classList.contains('rw-zh-gloss-wrap')) syncWrapper(target);
      else if (target.classList.contains('reader-word')) {
        const wrap = target.parentElement?.classList?.contains('rw-zh-gloss-wrap') ? target.parentElement : null;
        if (wrap) syncWrapper(wrap);
      }
    }
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'class',
      'data-zh-gloss-key',
      'data-zh-gloss-pinyin',
      'data-zh-gloss-ru',
      'data-zh-gloss-ru-readable',
    ],
  });
  syncAll();
}

function install() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  installStyles();
  installObserver();
}

globalThis.readerSyncZhGlossStability = syncAll;
globalThis.readerZhGlossStabilityStats = () => ({ ...stats, rememberedKeys: memoryByKey.size });

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
  window.addEventListener('pageshow', () => { install(); syncAll(); });
}

export { syncWrapper, syncAll, confirmedKnowledge };
