// toc103 — high-confidence contextual corrections for English inline glosses.
// This module never creates/moves Reader DOM and never changes Known/Unknown.
// It only replaces text in an already-existing Unknown gloss when the local
// English context makes the intended sense unambiguous.

let timer = null;
let observer = null;
let observedRoot = null;

function normalize(value) {
  return String(value || '')
    .replace(/[’‘]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang
    || document.getElementById('reader-chapter-text')?.dataset?.lang
    || '',
  ).trim().toLowerCase();
  return raw === 'english' || raw === 'en' || raw.startsWith('en-') ? 'en' : raw;
}

function paragraphContext(el) {
  const paragraph = el?.closest?.('.reader-paragraph');
  if (!paragraph) return normalize(el?.dataset?.word || '');
  const words = Array.from(paragraph.querySelectorAll('.reader-word[data-word]'))
    .map(node => String(node.dataset.word || node.textContent || '').trim())
    .filter(Boolean);
  return normalize(words.join(' '));
}

function contextualGloss(surfaceValue, contextValue) {
  const word = normalize(surfaceValue);
  const context = ` ${normalize(contextValue)} `;

  if (/^bolster(s|ed|ing)?$/.test(word)) {
    if (/\bbolster(?:s|ed|ing)?\s+(the\s+)?(contras?|allies|forces|government|regime|economy|confidence|support|morale|position|case)\b/.test(context)
        || /\bmission to bolster\b/.test(context)) {
      return 'поддерживать';
    }
  }

  if (word === 'contra' || word === 'contras') {
    if (/\bbolster(?:s|ed|ing)?\s+the\s+contras?\b|\bthe\s+contras?\b/.test(context)) {
      return 'контрас';
    }
  }

  if (/^(tread|treads|treading|trod|trodden)$/.test(word)) {
    if (/\b(tread|treads|treading|trod|trodden)\s+on\b/.test(context)) {
      return 'наступать';
    }
  }

  if (word === "other's" || word === "others'" || word === 'other') {
    if (/\beach\s+other's\b|\bone\s+another's\b/.test(context)) {
      return 'друг друга';
    }
  }

  return '';
}

function existingGloss(el) {
  const wrap = el?.parentElement?.classList?.contains('rw-en-gloss-wrap') ? el.parentElement : null;
  const node = wrap?.querySelector?.(':scope > .rw-en-gloss-text') || null;
  return { wrap, node };
}

function scan() {
  if (currentLang() !== 'en') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;

  for (const el of root.querySelectorAll('.reader-word.rw-migaku-unknown[data-word]')) {
    const { wrap, node } = existingGloss(el);
    if (!wrap || !node) continue;
    if (String(wrap.dataset.enContextProvider || '') === 'deepseek-context') continue;
    const surface = String(el.dataset.word || el.textContent || '').trim();
    const ru = contextualGloss(surface, paragraphContext(el));
    if (!ru || String(node.textContent || '').trim() === ru) continue;
    node.textContent = ru;
    wrap.dataset.enGlossRu = ru;
    wrap.dataset.enContextProvider = 'toc103-rule';
  }
}

function schedule(delay = 35) {
  clearTimeout(timer);
  timer = setTimeout(scan, Math.max(0, Number(delay) || 0));
}

function bind() {
  const root = document.getElementById('reader-chapter-text');
  if (root && root !== observedRoot && typeof MutationObserver === 'function') {
    observer?.disconnect();
    observedRoot = root;
    observer = new MutationObserver(() => schedule(45));
    observer.observe(root, { childList:true, subtree:true, characterData:true, attributes:true, attributeFilter:['class','data-word'] });
  }
  schedule(0);
}

if (typeof window !== 'undefined' && !window.__readerEnContextFixesV1) {
  window.__readerEnContextFixesV1 = true;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once:true });
  else bind();
  window.addEventListener('pageshow', bind);
  window.addEventListener('reader:en-vocab-ready', () => schedule(0));
  window.addEventListener('reader:en-morphology-augmented', () => schedule(0));
}

export { normalize, contextualGloss };
