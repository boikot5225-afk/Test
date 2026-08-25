// Presentation-only companion for zh-unknown-gloss.js.
// It does not change Reader navigation, vocabulary data, AI requests, or book state.
// It only controls how the optional Chinese unknown-word annotations are laid out.

let rootObserver = null;
let retryTimer = null;
let lastTappedWordSlot = null;
const pendingKnownSlots = new Map();
const PENDING_SLOT_TTL_MS = 2500;

function compactMeaning(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (raw === '…' || raw === '...') return '';

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
  wrap.dataset.zhGlossRuReadable = compactMeaning(raw) || '';
}

function stableKnownWrapperFor(word) {
  const parent = word?.parentElement;
  return parent?.classList?.contains('rw-zh-known-stable-wrap') ? parent : null;
}

function wordSlotKey(word) {
  if (!word?.classList?.contains('reader-word')) return '';
  const paragraph = word.closest?.('.reader-paragraph');
  const p = String(paragraph?.dataset?.p ?? '');
  const surface = String(word.dataset?.word || word.textContent || '').trim();
  if (!surface) return '';
  let occurrence = 0;
  if (paragraph) {
    const words = Array.from(paragraph.querySelectorAll('.reader-word'));
    for (const candidate of words) {
      if (candidate === word) break;
      if (String(candidate.dataset?.word || candidate.textContent || '').trim() === surface) occurrence++;
    }
  }
  return `${p}|${surface}|${occurrence}`;
}

function slotGeometry(word) {
  const wrap = word?.parentElement?.classList?.contains('rw-zh-gloss-wrap') ? word.parentElement : word;
  let width = 0;
  try { width = Number(wrap?.getBoundingClientRect?.().width || 0); } catch {}
  if (!(width > 0)) {
    try { width = Number(word?.getBoundingClientRect?.().width || 0); } catch {}
  }
  return { key: wordSlotKey(word), width, capturedAt: Date.now() };
}

function rememberTappedWord(word) {
  const root = document.getElementById('reader-chapter-text');
  if (!word || !root?.contains(word)) return;
  const slot = slotGeometry(word);
  if (slot.key) lastTappedWordSlot = slot;
}

function armKnownSlotFromLastTap() {
  const slot = lastTappedWordSlot;
  if (!slot?.key || Date.now() - Number(slot.capturedAt || 0) > 30000) return;
  pendingKnownSlots.set(slot.key, { width: slot.width, expiresAt: Date.now() + PENDING_SLOT_TTL_MS });
}

function prunePendingSlots() {
  const now = Date.now();
  for (const [key, slot] of pendingKnownSlots.entries()) {
    if (Number(slot?.expiresAt || 0) < now) pendingKnownSlots.delete(key);
  }
}

function wrapKnownWithWidth(word, width) {
  if (!word?.parentNode || stableKnownWrapperFor(word)) return false;
  const stable = document.createElement('span');
  stable.className = 'rw-zh-known-stable-wrap';
  stable.dataset.zhKnownStable = '1';
  if (Number(width) > 0) {
    const px = `${Math.ceil(Number(width) * 100) / 100}px`;
    stable.style.width = px;
    stable.style.minWidth = px;
    stable.style.maxWidth = px;
  }
  word.parentNode.insertBefore(stable, word);
  stable.appendChild(word);
  return true;
}

// Handles the in-place class change before a render when timing allows it.
function freezeKnownWordInPlace(word) {
  if (!word?.classList?.contains('reader-word') || !word.classList.contains('rw-known')) return false;
  const glossWrap = word.parentElement?.classList?.contains('rw-zh-gloss-wrap') ? word.parentElement : null;
  if (!glossWrap || !glossWrap.parentNode) return false;

  const slot = slotGeometry(word);
  if (slot.key) pendingKnownSlots.set(slot.key, { width: slot.width, expiresAt: Date.now() + PENDING_SLOT_TTL_MS });

  const stable = document.createElement('span');
  stable.className = 'rw-zh-known-stable-wrap';
  stable.dataset.zhKnownStable = '1';
  if (slot.width > 0) {
    const px = `${Math.ceil(slot.width * 100) / 100}px`;
    stable.style.width = px;
    stable.style.minWidth = px;
    stable.style.maxWidth = px;
  }
  glossWrap.parentNode.insertBefore(stable, glossWrap);
  stable.appendChild(word);
  glossWrap.remove();
  return true;
}

// readerMarkSelectedWordKnown() performs a synchronous full chapter render.
// The capture-phase click handler below arms the old slot before that happens;
// this function restores the same footprint to the fresh rw-known node.
function restorePendingKnownSlot(word) {
  if (!word?.classList?.contains('rw-known') || stableKnownWrapperFor(word)) return false;
  prunePendingSlots();
  const key = wordSlotKey(word);
  const slot = key ? pendingKnownSlots.get(key) : null;
  if (!slot) return false;
  pendingKnownSlots.delete(key);
  return wrapKnownWithWidth(word, slot.width);
}

function releaseKnownStableWrapper(word) {
  const stable = stableKnownWrapperFor(word);
  if (!stable || !stable.parentNode || word?.classList?.contains('rw-known')) return false;
  stable.parentNode.insertBefore(word, stable);
  stable.remove();
  return true;
}

function syncWordState(word) {
  // toc44: word state must never dismantle or resize the Chinese annotation slot.
  // Known/Unknown now changes only visibility; the wrapper remains in normal flow.
  if (!word?.classList?.contains('reader-word')) return;
}

function scan(root = document.getElementById('reader-chapter-text')) {
  if (!root) return;
  prunePendingSlots();
  root.querySelectorAll('.rw-zh-gloss-wrap').forEach(syncWrapper);
  root.querySelectorAll('.reader-word').forEach(syncWordState);
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

    /* In this mode the old global ruby layer must not leak through. Pinyin is
       provided only by our selected annotation wrappers below. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-word rt {
      display: none !important;
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

    /* Show annotations only for words that are actually in the user's working
       set. Untouched new and passive seen/faded tokens stay plain. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-new),
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-seen),
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-faded) {
      grid-template-rows: 1.08em !important;
      grid-template-columns: max-content !important;
      vertical-align: baseline !important;
      margin: 0 !important;
      padding: 0 !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-new)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-new)::after,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-seen)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-seen)::after,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-faded)::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-faded)::after {
      content: '' !important;
      display: none !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-new) > .reader-word,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-seen) > .reader-word,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap:has(> .rw-faded) > .reader-word {
      grid-row: 1 !important;
      grid-column: 1 !important;
    }

    /* Known-now wrapper: hints vanish immediately, footprint remains fixed so
       the word cannot jump. A later normal Reader render removes this shell. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-known-stable-wrap {
      display: inline-grid;
      grid-template-rows: .58em 1.08em .54em;
      grid-template-columns: 1fr;
      align-items: center;
      justify-items: center;
      vertical-align: -.48em;
      line-height: 1 !important;
      margin: 0 .055em;
      padding: 0 .025em;
      box-sizing: border-box;
      overflow: visible;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-known-stable-wrap > .reader-word {
      grid-row: 2;
      grid-column: 1;
      align-self: center;
      justify-self: center;
      display: inline !important;
      margin: 0 !important;
      padding: 0 1px !important;
      line-height: 1.08 !important;
    }
  `;
  document.head.appendChild(style);
}

function installCaptureHooks() {
  if (document.documentElement?.dataset?.zhGlossReadableCapture === '1') return;
  if (document.documentElement) document.documentElement.dataset.zhGlossReadableCapture = '1';
  document.addEventListener('click', (event) => {
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    const word = target?.closest?.('.reader-word');
    if (word) {
      rememberTappedWord(word);
      return;
    }
    const button = target?.closest?.('button');
    const onclick = String(button?.getAttribute?.('onclick') || '');
    if (onclick.includes('readerMarkSelectedWordKnown')) armKnownSlotFromLastTap();
  }, true);
}

function install() {
  injectStyles();
  installCaptureHooks();
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
        if (mutation.attributeName === 'class') syncWordState(mutation.target);
        else syncWrapper(mutation.target);
        continue;
      }
      mutation.addedNodes?.forEach((node) => {
        if (node?.nodeType !== 1) return;
        if (node.classList?.contains('rw-zh-gloss-wrap')) syncWrapper(node);
        if (node.classList?.contains('reader-word')) syncWordState(node);
        node.querySelectorAll?.('.rw-zh-gloss-wrap').forEach(syncWrapper);
        node.querySelectorAll?.('.reader-word').forEach(syncWordState);
      });
    }
  });
  rootObserver.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-zh-gloss-ru', 'class'],
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

export { compactMeaning, wordSlotKey, freezeKnownWordInPlace, restorePendingKnownSlot };
