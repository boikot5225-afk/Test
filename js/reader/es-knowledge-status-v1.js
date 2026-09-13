// toc137 — explicit current Known/Unknown state in the Spanish word card.
// This is display-only: the canonical Spanish vocabulary owner / reader word-state
// remains the single source of truth. The generic "✓ знаю" button is an action,
// not a status, so the card needs a separate read-only state marker.

const STYLE_ID = 'reader-es-knowledge-status-v1-style';
const STATUS_ID = 'reader-es-current-knowledge';

function normalize(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[’‘`´]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .trim()
    .toLocaleLowerCase('es-ES');
}

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang ||
    document.getElementById('reader-chapter-text')?.dataset?.lang || ''
  ).trim().toLowerCase();
  return raw === 'spanish' || raw === 'español' || raw === 'es' || raw.startsWith('es-') ? 'es' : raw;
}

function panelWord(detail = null) {
  const fromEvent = String(detail?.surface || '').trim();
  if (fromEvent) return fromEvent;
  const title = String(document.getElementById('reader-word-title')?.textContent || '').trim();
  return title === '—' ? '' : title;
}

function classificationFromOwner(word) {
  try {
    const info = globalThis.readerSpanishVocabularyKnowledgeFor?.(word);
    const value = String(info?.value || '').toLowerCase();
    if (value === 'known' || value === 'unknown') return { value, source: info?.source || 'vocab-owner' };
  } catch {}
  return null;
}

function classificationFromSelectedDom(word) {
  const root = document.getElementById('reader-chapter-text');
  if (!root) return null;
  const wanted = normalize(word);
  const candidates = [
    ...root.querySelectorAll('.reader-word.rw-sel[data-word], .reader-word[data-word][aria-current="true"]'),
    ...root.querySelectorAll('.reader-paragraph.active .reader-word[data-word]'),
  ];
  const node = candidates.find(el => normalize(el.dataset.word || el.textContent) === wanted)
    || [...root.querySelectorAll('.reader-word[data-word]')].find(el => normalize(el.dataset.word || el.textContent) === wanted);
  if (!node) return null;
  if (node.classList.contains('rw-migaku-known')) return { value: 'known', source: 'rendered-word' };
  if (node.classList.contains('rw-migaku-unknown')) return { value: 'unknown', source: 'rendered-word' };
  return null;
}

function classificationFromWordState(word) {
  let store = null;
  try { store = globalThis.an2ReaderWordStateSnapshot?.(); } catch {}
  if (!store || typeof store !== 'object') return null;

  const surface = normalize(word);
  let lemma = surface;
  try { lemma = normalize(globalThis.readerSpanishLemmaFor?.(surface) || surface); } catch {}
  const wanted = new Set([surface, lemma].filter(Boolean));
  let newest = null;
  let newestStamp = -1;

  for (const state of Object.values(store)) {
    if (!state || String(state.lang || '').toLowerCase() !== 'es') continue;
    const names = [state.word, state.lemma, state.linkedLemma].map(normalize).filter(Boolean);
    if (!names.some(name => wanted.has(name))) continue;
    const stamp = Date.parse(state.manualKnowledgeAt || state.updatedAt || '') || 0;
    if (!newest || stamp >= newestStamp) {
      newest = state;
      newestStamp = stamp;
    }
  }
  if (!newest) return null;
  const manual = String(newest.manualKnowledge || '').toLowerCase();
  if (manual === 'known' || manual === 'unknown') return { value: manual, source: 'word-state-manual' };
  if (newest.known === true || String(newest.status || '').toLowerCase() === 'known') return { value: 'known', source: 'word-state' };
  return { value: 'unknown', source: 'word-state' };
}

function resolveKnowledge(word) {
  return classificationFromOwner(word)
    || classificationFromSelectedDom(word)
    || classificationFromWordState(word)
    || { value: 'unknown', source: 'default-not-known' };
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
#${STATUS_ID}{display:inline-flex;align-items:center;gap:5px;margin-top:6px;padding:4px 8px;border:1px solid var(--border);border-radius:999px;background:var(--surface2);font-family:'IBM Plex Sans',sans-serif;font-size:.72rem;font-weight:700;line-height:1.1;letter-spacing:.02em;color:var(--text)}
#${STATUS_ID}[data-knowledge="known"]::before{content:'✓';font-weight:800}
#${STATUS_ID}[data-knowledge="unknown"]::before{content:'?';font-weight:800}
`;
  document.head.appendChild(style);
}

function ensureStatusNode() {
  const panel = document.getElementById('reader-word-panel');
  const source = panel?.querySelector('#reader-word-known');
  if (!panel || !source) return null;
  let node = panel.querySelector(`#${STATUS_ID}`);
  if (!node) {
    node = document.createElement('div');
    node.id = STATUS_ID;
    node.setAttribute('role', 'status');
    source.insertAdjacentElement('afterend', node);
  }
  return node;
}

function hide() {
  const node = document.getElementById(STATUS_ID);
  if (node) node.style.display = 'none';
}

function sync(detail = null) {
  injectStyles();
  if (currentLang() !== 'es' && String(detail?.lang || '').toLowerCase() !== 'es') {
    hide();
    return false;
  }
  const word = panelWord(detail);
  if (!word) {
    hide();
    return false;
  }
  const node = ensureStatusNode();
  if (!node) return false;
  const info = resolveKnowledge(word);
  const known = info.value === 'known';
  const text = known ? 'ЗНАЮ' : 'НЕ ЗНАЮ';
  node.dataset.knowledge = known ? 'known' : 'unknown';
  node.dataset.source = info.source || '';
  node.textContent = `СТАТУС: ${text}`;
  node.setAttribute('aria-label', `Текущий статус слова: ${text}`);
  node.style.display = 'inline-flex';
  return true;
}

function scheduleSync(detail = null) {
  queueMicrotask(() => sync(detail));
  setTimeout(() => sync(detail), 60);
  setTimeout(() => sync(detail), 220);
}

function boot() {
  injectStyles();
  if (currentLang() === 'es') scheduleSync();
}

if (typeof window !== 'undefined' && !window.__readerEsKnowledgeStatusV1) {
  window.__readerEsKnowledgeStatusV1 = true;
  globalThis.readerSpanishKnowledgeStatusSync = sync;
  globalThis.readerSpanishKnowledgeStatusFor = resolveKnowledge;
  document.addEventListener('reader-word-analysis-ready', event => scheduleSync(event.detail || null));
  window.addEventListener('reader:es-vocab-ready', () => scheduleSync());
  window.addEventListener('reader:word-state-changed', () => scheduleSync());
  window.addEventListener('reader:es-pipeline-v1-ready', () => scheduleSync());
  window.addEventListener('reader:pagechange', () => scheduleSync());
  window.addEventListener('an2:languagechange', () => scheduleSync());
  document.addEventListener('click', event => {
    if (event.target?.closest?.('#reader-chapter-text .reader-word,#reader-word-panel')) scheduleSync();
  }, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
  window.addEventListener('pageshow', boot);
}

export { resolveKnowledge, sync };
