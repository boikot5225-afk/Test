// toc92 Chinese reading aid.
//
// Layout contract:
//   - every Chinese token keeps the same Hanzi baseline;
//   - Reader's native ruby is the only pinyin renderer;
//   - only confirmed Unknown words receive one short Russian gloss below;
//   - no English text, dictionary articles or automatic online translation;
//   - the gloss may reserve a small bounded width, never a phone-sized column.

const STYLE_ID = 'reader-zh-readable-inline-v4';
const LEGACY_STYLE_IDS = [
  'reader-zh-readable-inline-v1',
  'reader-zh-readable-inline-v2',
  'reader-zh-readable-inline-v3',
  'reader-zh-stable-slots-v3',
  'reader-zh-unknown-interlinear-v1',
  'reader-zh-unknown-interlinear-v2',
  'rd-zh-unknown-gloss-spacing-style',
  'rd-zh-gloss-stability-v2-style',
  'reader-zh-toc88-inline-style',
];
const RETRY_MS = 20_000;
const MAX_BATCH = 32;

let observer = null;
let observedRoot = null;
let scanTimer = null;
let batchTimer = null;
let requestSequence = 0;
let bridgeBlockedUntil = 0;

const offlineRu = new Map();
const pendingEnglish = new Set();
const inFlightEnglish = new Set();
const requestWords = new Map();

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function hasRussian(value) {
  return /[\u0400-\u052f]/.test(String(value || ''));
}

function enabled() {
  if (typeof document === 'undefined') return false;
  const view = document.getElementById('reader-reading-view');
  if (!view || String(view.dataset.readerLang || '').toLowerCase() !== 'zh') return false;
  try { return globalThis.readerGetZhUnknownGlossMode?.() === 'unknown'; }
  catch { return view.classList.contains('rd-zh-unknown-gloss'); }
}

function firstSense(value) {
  let text = clean(value);
  if (!text) return '';
  text = text.split(/\s*(?:[;；/|·•]|[.!?。！？]|[,，])\s*/)[0] || text;
  return text
    .replace(/\s*[（(][^()（）]{0,100}[）)]/g, ' ')
    .replace(/\s*[（(].*$/, '')
    .replace(/^[—–-]\s*/, '')
    .replace(/[;；,.，。]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// A reading hint is a lexical equivalent, not a clipped definition. Rejecting
// prose is preferable to showing nonsense such as "Металл" for 铜.
function compactRussian(value) {
  const text = firstSense(value);
  if (!text || !hasRussian(text)) return '';
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 2 || text.length > 22) return '';
  if (/(?:также|используется|используют|химическ|обозначени|представляет|состоящ)/i.test(text)) return '';
  if (/^(?:металл|вещество|материал|элемент|предмет|объект|название|термин)$/i.test(text)) return '';
  return text;
}

function compactEnglish(value) {
  let text = clean(value)
    .replace(/\bCL:[^/;]+/gi, '')
    .replace(/^[—–-]\s*/, '');
  if (!text) return '';
  text = text.split(/\s*(?:[;；/|·•]|[.!?。！？]|[,，])\s*/)[0] || text;
  return clean(text
    .replace(/\s*[（(][^()（）]{0,100}[）)]/g, ' ')
    .replace(/\s*[（(].*$/, '')
    .replace(/^to\s+be\s+/i, '')
    .replace(/^to\s+/i, '')
    .replace(/^(?:a|an|the)\s+/i, '')
    .replace(/[;,.]+$/, ''));
}

function normalizeEnglish(value) {
  return clean(value)
    .replace(/[’‘]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .toLocaleLowerCase('en-US');
}

function englishCandidates(value) {
  const phrase = normalizeEnglish(compactEnglish(value));
  const out = [];
  const push = candidate => {
    const key = normalizeEnglish(candidate);
    if (key && !out.includes(key)) out.push(key);
  };
  push(phrase);
  push(phrase.replace(/-/g, ' '));
  // Phrase entries are not always present in the compact WikDict subset. The
  // lexical head still gives a useful short Russian hint instead of English.
  push(phrase.split(/\s+/)[0]);
  return out;
}

function wordState(word) {
  if (word?.classList?.contains('rw-migaku-unknown')) return 'unknown';
  if (word?.classList?.contains('rw-migaku-known') || word?.classList?.contains('rw-known')) return 'known';
  return '';
}

function wordForWrapper(wrap) {
  return wrap?.querySelector?.(':scope > .reader-word') || null;
}

function localRussian(wrap, word) {
  const raw = wrap?.dataset?.zhGlossSource === 'en' ? '' : (
    wrap?.dataset?.zhGlossStickyRu
    || wrap?.dataset?.zhGlossRuReadable
    || wrap?.dataset?.zhGlossRu
    || ''
  );
  const direct = compactRussian(raw);
  if (direct) return direct;

  const surface = clean(word?.dataset?.word || '');
  if (!surface) return '';
  try {
    const entry = globalThis.readerLookupChineseWord?.(surface) || null;
    return compactRussian(entry?.ru || entry?.russian || entry?.translation_ru || entry?.translation || '');
  } catch {
    return '';
  }
}

function localEnglish(word) {
  const surface = clean(word?.dataset?.word || '');
  if (!surface) return '';
  try {
    const entry = globalThis.readerLookupChineseWord?.(surface) || null;
    const raw = entry?.en || entry?.english || entry?.definition || entry?.definitions || entry?.gloss || '';
    return compactEnglish(Array.isArray(raw) ? raw.join('; ') : raw);
  } catch {
    return '';
  }
}

function translatedRussian(english) {
  for (const key of englishCandidates(english)) {
    const ru = compactRussian(offlineRu.get(key));
    if (ru) return ru;
  }
  return '';
}

function glossWidth(value) {
  const count = Array.from(clean(value)).length;
  if (!count) return '0em';
  return `${Math.min(2.65, Math.max(1, count * 0.19)).toFixed(2)}em`;
}

function ensureLane(word) {
  let lane = word?.parentElement?.querySelector?.(':scope > .rw-zh-readable-ru');
  if (!lane && word?.parentElement) {
    lane = document.createElement('span');
    lane.className = 'rw-zh-readable-ru';
    lane.setAttribute('aria-hidden', 'true');
    word.parentElement.appendChild(lane);
  }
  return lane;
}

function setLane(wrap, word, value) {
  const ru = compactRussian(value);
  const lane = ensureLane(word);
  if (!lane) return;
  if (clean(lane.textContent) !== ru) lane.textContent = ru;
  lane.hidden = !ru;
  wrap.style.setProperty('--rw-zh-readable-width', glossWidth(ru));
}

function clearLane(wrap) {
  wrap?.querySelector?.(':scope > .rw-zh-readable-ru')?.remove();
  wrap?.style?.removeProperty('--rw-zh-readable-width');
}

function queueEnglish(value) {
  for (const key of englishCandidates(value)) {
    if (!offlineRu.has(key) && !inFlightEnglish.has(key)) pendingEnglish.add(key);
  }
  clearTimeout(batchTimer);
  batchTimer = setTimeout(flushEnglish, 30);
}

function parsePayload(payloadJson) {
  try {
    const value = typeof payloadJson === 'string' ? JSON.parse(payloadJson) : payloadJson;
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function acceptTranslation(source, translated) {
  const key = normalizeEnglish(source);
  const ru = compactRussian(translated);
  if (!key) return;
  inFlightEnglish.delete(key);
  if (ru) offlineRu.set(key, ru);
}

if (typeof window !== 'undefined') {
  window.__readerOfflineTranslateProgress = (requestId, source, translated) => {
    acceptTranslation(source, translated);
    schedule(10);
  };

  window.__readerOfflineTranslateResolve = (requestId, ok, payloadJson) => {
    const id = String(requestId || '');
    const requested = requestWords.get(id) || [];
    requestWords.delete(id);
    requested.forEach(word => inFlightEnglish.delete(normalizeEnglish(word)));
    const payload = parsePayload(payloadJson);
    if (ok) {
      const translations = payload.translations && typeof payload.translations === 'object'
        ? payload.translations : {};
      Object.entries(translations).forEach(([source, translated]) => acceptTranslation(source, translated));
    } else {
      bridgeBlockedUntil = Date.now() + RETRY_MS;
      console.warn('[zh readable] встроенный EN→RU словарь недоступен:', payload.message || 'неизвестная ошибка');
    }
    schedule(20);
  };
}

function flushEnglish() {
  if (!enabled() || Date.now() < bridgeBlockedUntil) return;
  const bridge = globalThis.ReaderOfflineTranslate;
  if (!bridge || typeof bridge.translateBatch !== 'function') return;
  const words = Array.from(pendingEnglish).slice(0, MAX_BATCH);
  if (!words.length) return;
  words.forEach(word => {
    pendingEnglish.delete(word);
    inFlightEnglish.add(word);
  });
  const requestId = `zh-gloss-${Date.now().toString(36)}-${(++requestSequence).toString(36)}`;
  requestWords.set(requestId, words);
  try {
    bridge.translateBatch(requestId, JSON.stringify(words));
  } catch (error) {
    requestWords.delete(requestId);
    words.forEach(word => inFlightEnglish.delete(word));
    bridgeBlockedUntil = Date.now() + RETRY_MS;
    console.warn('[zh readable] не удалось запустить встроенный EN→RU словарь:', error?.message || error);
  }
}

function syncWrap(wrap) {
  const word = wordForWrapper(wrap);
  if (!word) return;
  wrap.querySelectorAll(':scope > .rw-zh-readable-pinyin,:scope > .rw-zh-t88-py,:scope > .rw-zh-t88-ru')
    .forEach(node => node.remove());

  if (!enabled() || wordState(word) !== 'unknown') {
    clearLane(wrap);
    return;
  }

  const ru = localRussian(wrap, word);
  if (ru) {
    setLane(wrap, word, ru);
    return;
  }

  const english = localEnglish(word);
  const translated = translatedRussian(english);
  setLane(wrap, word, translated);
  if (!translated && english) queueEnglish(english);
}

function purgeLegacyVisuals(root = document) {
  LEGACY_STYLE_IDS.forEach(id => document.getElementById(id)?.remove());
  root?.querySelectorAll?.('.rw-zh-readable-pinyin,.rw-zh-t88-py,.rw-zh-t88-ru')
    .forEach(node => node.remove());
}

function syncAll() {
  if (typeof document === 'undefined') return 0;
  const root = document.getElementById('reader-chapter-text');
  if (!root) return 0;
  purgeLegacyVisuals(root);
  const wrappers = root.querySelectorAll('.rw-zh-gloss-wrap');
  wrappers.forEach(syncWrap);
  flushEnglish();
  return wrappers.length;
}

function schedule(delay = 0) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(syncAll, delay);
}

function installStyle() {
  purgeLegacyVisuals();
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-paragraph-text {
      line-height: 2.04 !important;
    }

    /* Every word owns the same two rows. This is what keeps all Hanzi on one
       baseline instead of lifting only annotated words out of the sentence. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap {
      display: inline-grid !important;
      grid-template-rows: auto .52em !important;
      grid-template-columns: max-content !important;
      align-items: end !important;
      justify-items: center !important;
      vertical-align: baseline !important;
      line-height: 1 !important;
      margin: 0 .018em !important;
      padding: 0 !important;
      width: auto !important;
      min-width: 0 !important;
      max-width: none !important;
      height: auto !important;
      overflow: visible !important;
      box-sizing: border-box !important;
      break-inside: avoid !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .rw-zh-gloss-wrap > .reader-word {
      grid-row: 1 !important;
      grid-column: 1 !important;
      align-self: end !important;
      justify-self: center !important;
      position: static !important;
      margin: 0 !important;
      padding: 0 1px !important;
      line-height: 1.12 !important;
      white-space: nowrap !important;
      word-break: keep-all !important;
      overflow-wrap: normal !important;
      overflow: visible !important;
      text-overflow: clip !important;
    }

    /* Reader's native ruby is the single pinyin source. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .rw-zh-gloss-wrap > .reader-word ruby.reader-ruby {
      ruby-position: over !important;
      ruby-align: center !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .rw-zh-gloss-wrap > .reader-word rt {
      font-family: 'IBM Plex Sans', system-ui, sans-serif !important;
      font-size: .46em !important;
      font-weight: 400 !important;
      line-height: 1 !important;
      letter-spacing: 0 !important;
      white-space: nowrap !important;
      word-break: keep-all !important;
      overflow: visible !important;
      text-overflow: clip !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap::before,
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-gloss-wrap::after {
      content: none !important;
      display: none !important;
      visibility: hidden !important;
    }

    /* A complete short Russian equivalent. Its width contribution is capped;
       long prose is rejected by JS rather than wrapped into a vertical tower. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-readable-ru {
      grid-row: 2 !important;
      grid-column: 1 !important;
      align-self: start !important;
      justify-self: center !important;
      display: block !important;
      width: var(--rw-zh-readable-width, 0em) !important;
      min-width: 0 !important;
      max-width: var(--rw-zh-readable-width, 0em) !important;
      margin: .07em 0 0 !important;
      padding: 0 !important;
      white-space: nowrap !important;
      word-break: keep-all !important;
      overflow-wrap: normal !important;
      overflow: visible !important;
      text-overflow: clip !important;
      text-align: center !important;
      font-family: 'IBM Plex Sans', system-ui, sans-serif !important;
      font-size: .34em !important;
      font-weight: 400 !important;
      line-height: 1 !important;
      letter-spacing: 0 !important;
      color: var(--text-muted) !important;
      pointer-events: none !important;
      user-select: none !important;
    }

    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .rw-zh-readable-ru[hidden] {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

function bindObserver() {
  if (typeof MutationObserver === 'undefined' || typeof Element === 'undefined') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) {
    setTimeout(bindObserver, 180);
    return;
  }
  if (observer && observedRoot === root) return;
  observer?.disconnect();
  observedRoot = root;
  observer = new MutationObserver(records => {
    let relevant = false;
    for (const record of records) {
      if (record.type === 'attributes') {
        const el = record.target;
        if (el instanceof Element && (el.classList.contains('reader-word') || el.classList.contains('rw-zh-gloss-wrap'))) {
          relevant = true;
          break;
        }
      }
      for (const node of record.addedNodes || []) {
        if (!(node instanceof Element)) continue;
        if (node.classList.contains('rw-zh-readable-ru')) continue;
        if (node.matches?.('.reader-word,.rw-zh-gloss-wrap') || node.querySelector?.('.reader-word,.rw-zh-gloss-wrap')) {
          relevant = true;
          break;
        }
      }
      if (relevant) break;
    }
    if (relevant) schedule(20);
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'data-zh-gloss-ru', 'data-zh-gloss-sticky-ru', 'data-zh-gloss-source'],
  });
}

function install() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  installStyle();
  bindObserver();
  schedule(0);
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
  window.addEventListener('pageshow', () => { installStyle(); bindObserver(); schedule(20); });
  window.addEventListener('scroll', () => schedule(70), { passive: true });
  window.addEventListener('reader-instant-word-translation', () => schedule(15));
  window.addEventListener('reader:chromechange', () => schedule(15));
}

export {
  compactRussian,
  compactEnglish,
  englishCandidates,
  glossWidth,
  syncWrap,
  syncAll,
};
