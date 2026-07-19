import { wordStateIdbPut } from './word-state-idb-store.js?v=1';

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_MIN_CONTEXTS = 2;
const DEFAULT_LIMIT = 10;

function canonicalLang(lang) {
  const raw = String(lang || '').trim().toLowerCase();
  if (raw === 'zh' || raw.startsWith('zh-') || raw === 'cn') return 'zh';
  if (raw === 'en' || raw.startsWith('en-')) return 'en';
  if (raw === 'es' || raw.startsWith('es-')) return 'es';
  return 'fr';
}

function normalizeWord(word, lang = 'fr') {
  const language = canonicalLang(lang);
  if (language === 'zh') {
    return String(word || '')
      .normalize('NFC')
      .replace(/^[\s，。！？；：、,.!?;:"“”‘’'《》〈〉（）()【】\[\]{}…—\-]+|[\s，。！？；：、,.!?;:"“”‘’'《》〈〉（）()【】\[\]{}…—\-]+$/g, '')
      .trim();
  }
  return String(word || '')
    .toLowerCase()
    .normalize('NFC')
    .replace(/^[^a-zà-öø-ÿœæ'-]+|[^a-zà-öø-ÿœæ'-]+$/gi, '')
    .replace(/[’`´]/g, "'")
    .trim();
}

function storageKey() {
  try {
    return globalThis.an2ReaderStorageKey?.('an2_reader_word_state_v1') || 'an2_reader_word_state_v1';
  } catch {
    return 'an2_reader_word_state_v1';
  }
}

function readState() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey()) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

async function persistState(state) {
  const key = storageKey();
  try { localStorage.setItem(key, JSON.stringify(state)); } catch {}
  try { await wordStateIdbPut(key, state); } catch {}
  try { globalThis.syncWordStateNow?.(); } catch {}
}

function isProperPos(pos) {
  return /(?:^|[_\s-])(?:proper(?:_noun)?|name|person|person_name|имя)(?:$|[_\s-])/i.test(String(pos || ''));
}

function stateCanonicalWord(state = {}, lang = null) {
  const language = canonicalLang(lang || state.lang);
  return normalizeWord(state.lemma || state.linkedLemma || state.word, language);
}

function contextTimestamp(value) {
  const stamp = new Date(value?.at || value?.updatedAt || 0).getTime();
  return Number.isFinite(stamp) ? stamp : 0;
}

export function mergeLemmaMetadata(store, detail = {}) {
  if (!store || typeof store !== 'object') return false;
  const lang = canonicalLang(detail.lang || 'fr');
  const surface = normalizeWord(detail.surface || detail.word, lang);
  const lemma = normalizeWord(detail.lemma || surface, lang);
  if (!surface || !lemma) return false;

  const sourceKey = `${lang}:${surface}`;
  const targetKey = `${lang}:${lemma}`;
  const source = store[sourceKey] || Object.values(store).find(item => item?.lang === lang && normalizeWord(item.word, lang) === surface);
  if (!source) return false;

  const now = new Date().toISOString();
  const target = store[targetKey] || (targetKey === sourceKey ? source : {
    word: lemma,
    lang,
    seen: 0,
    clicked: 0,
    saved: false,
    known: false,
    status: 'new',
    places: {},
    clickContexts: {},
    updatedAt: now,
  });

  const variants = new Set([
    ...(Array.isArray(target.variants) ? target.variants : []),
    ...(Array.isArray(source.variants) ? source.variants : []),
    surface,
    lemma,
  ].filter(Boolean));
  const contexts = { ...(target.clickContexts || {}), ...(source.clickContexts || {}) };

  target.word = lemma;
  target.lemma = lemma;
  target.lang = lang;
  target.pos = detail.pos || target.pos || source.pos || '';
  target.isProper = !!(detail.isProper || source.isProper || isProperPos(target.pos));
  target.variants = [...variants].slice(0, 16);
  target.clickContexts = contexts;
  target.clicked = Math.max(Number(target.clicked || 0), Object.keys(contexts).length, Number(source.clicked || 0));
  target.seen = Math.max(Number(target.seen || 0), Number(source.seen || 0));
  target.saved = !!(target.saved || source.saved);
  target.known = !!(target.known || source.known);
  if (target.known) target.status = 'known';
  else if (target.saved && !['problem', 'hard', 'familiar'].includes(target.status)) target.status = 'learning';
  target.updatedAt = now;
  store[targetKey] = target;

  source.lemma = lemma;
  source.linkedLemma = lemma;
  source.pos = detail.pos || source.pos || '';
  source.isProper = !!(detail.isProper || source.isProper || isProperPos(source.pos));
  source.variants = [...variants].slice(0, 16);
  source.updatedAt = now;
  store[sourceKey] = source;
  return true;
}

export function buildWordCandidates(states, {
  lang = 'fr',
  now = Date.now(),
  days = DEFAULT_WINDOW_DAYS,
  minContexts = DEFAULT_MIN_CONTEXTS,
  limit = DEFAULT_LIMIT,
} = {}) {
  const language = canonicalLang(lang);
  const cutoff = Number(now) - Math.max(1, Number(days) || DEFAULT_WINDOW_DAYS) * 86400000;
  const groups = new Map();

  for (const state of Object.values(states || {})) {
    if (!state || canonicalLang(state.lang) !== language) continue;
    const lemma = stateCanonicalWord(state, language);
    if (!lemma) continue;
    let group = groups.get(lemma);
    if (!group) {
      group = {
        lemma,
        lang: language,
        variants: new Set(),
        contexts: new Map(),
        saved: false,
        known: false,
        proper: false,
        lastOpenedAt: 0,
      };
      groups.set(lemma, group);
    }

    group.saved ||= !!state.saved;
    group.known ||= !!state.known || state.status === 'known';
    group.proper ||= !!state.isProper || isProperPos(state.pos);
    [state.word, state.lemma, state.linkedLemma, ...(Array.isArray(state.variants) ? state.variants : [])]
      .map(value => normalizeWord(value, language))
      .filter(Boolean)
      .forEach(value => group.variants.add(value));

    for (const [place, raw] of Object.entries(state.clickContexts || {})) {
      const at = contextTimestamp(raw);
      if (!at || at < cutoff) continue;
      const previous = group.contexts.get(place);
      if (!previous || at > contextTimestamp(previous)) {
        group.contexts.set(place, {
          place,
          at: raw.at || raw.updatedAt || new Date(at).toISOString(),
          text: String(raw.text || raw.context || '').replace(/\s+/g, ' ').trim().slice(0, 320),
          bookTitle: String(raw.bookTitle || '').trim(),
          chapterTitle: String(raw.chapterTitle || '').trim(),
          paragraphIndex: Number.isFinite(Number(raw.paragraphIndex)) ? Number(raw.paragraphIndex) : null,
          form: normalizeWord(raw.form || state.word, language),
        });
      }
      group.lastOpenedAt = Math.max(group.lastOpenedAt, at);
    }
  }

  return [...groups.values()]
    .map(group => {
      const contexts = [...group.contexts.values()].sort((a, b) => contextTimestamp(b) - contextTimestamp(a));
      return {
        lemma: group.lemma,
        lang: group.lang,
        variants: [...group.variants].filter(value => value !== group.lemma),
        contexts,
        contextCount: contexts.length,
        lastOpenedAt: group.lastOpenedAt,
        saved: group.saved,
        known: group.known,
        proper: group.proper,
        score: contexts.length * 10000000000000 + group.lastOpenedAt,
      };
    })
    .filter(item => !item.saved && !item.known && !item.proper && item.contextCount >= minContexts)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function groupMatches(state, candidate) {
  if (!state || canonicalLang(state.lang) !== canonicalLang(candidate.lang)) return false;
  return stateCanonicalWord(state, candidate.lang) === normalizeWord(candidate.lemma, candidate.lang);
}

export async function setCandidateStatus(candidate, status) {
  const state = readState();
  const now = new Date().toISOString();
  let changed = false;
  for (const item of Object.values(state)) {
    if (!groupMatches(item, candidate)) continue;
    if (status === 'known') {
      item.known = true;
      item.saved = false;
      item.status = 'known';
    } else if (status === 'learning') {
      item.known = false;
      item.saved = true;
      item.status = 'learning';
    }
    item.updatedAt = now;
    changed = true;
  }
  if (changed) await persistState(state);
  return changed;
}

function syncTappedParagraph(event) {
  const word = event?.target?.closest?.('.reader-word');
  const paragraph = word?.closest?.('.reader-paragraph');
  if (!word || !paragraph) return;
  const root = paragraph.closest('#reader-chapter-text') || paragraph.parentElement;
  root?.querySelectorAll?.('.reader-paragraph.active').forEach(item => {
    if (item !== paragraph) item.classList.remove('active');
  });
  paragraph.classList.add('active');
  paragraph.dataset.readerWordTappedAt = String(Date.now());

  const clone = paragraph.cloneNode(true);
  clone.querySelectorAll?.('.reader-translation,.reader-analysis-actions,.reader-footnote-ref,button').forEach(el => el.remove());
  const bookTitle = String(document.getElementById('reader-book-title')?.textContent || '').trim();
  const chapterTitle = String(document.getElementById('reader-chapter-title')?.textContent || '')
    .replace(/\s*·\s*абзац\s+\d+\s*\/\s*\d+.*$/i, '')
    .trim();
  const paragraphIndex = Number(paragraph.dataset?.p);
  const rawWord = String(word.dataset?.word || word.textContent || '').trim();
  const place = `${bookTitle || 'book'}::${chapterTitle || 'chapter'}::${Number.isFinite(paragraphIndex) ? paragraphIndex : paragraph.dataset?.p || '0'}`;
  globalThis.__readerCandidateTapContext = {
    word: rawWord,
    form: rawWord,
    paragraphIndex: Number.isFinite(paragraphIndex) ? paragraphIndex : null,
    text: String(clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 320),
    bookTitle,
    chapterTitle,
    place,
    at: new Date().toISOString(),
    capturedAt: Date.now(),
  };
}

function ensureEmptyCandidateHint() {
  const section = document.getElementById('home-top-clicked-section');
  const words = document.getElementById('home-top-clicked-words');
  if (!section || !words || section.dataset.candidateHintBusy === '1') return;
  if (section.style.display !== 'none') return;
  section.dataset.candidateHintBusy = '1';
  const label = section.querySelector('.home-section-label');
  if (label) label.textContent = '🔥 кандидаты на запоминание';
  words.innerHTML = '<div class="reader-candidate-empty" style="padding:12px 14px;border:1px dashed var(--border);border-radius:12px;color:var(--text-muted);font-size:.8rem;line-height:1.5">Пока нет кандидатов. Открой одно слово в двух разных абзацах — здесь появится карточка с контекстами.</div>';
  section.style.display = '';
  delete section.dataset.candidateHintBusy;
}

function bindEmptyCandidateHint() {
  const section = document.getElementById('home-top-clicked-section');
  if (!section || section.dataset.candidateHintBound === '1') {
    ensureEmptyCandidateHint();
    return;
  }
  section.dataset.candidateHintBound = '1';
  const observer = new MutationObserver(() => queueMicrotask(ensureEmptyCandidateHint));
  observer.observe(section, { attributes: true, attributeFilter: ['style'], childList: true, subtree: true });
  ensureEmptyCandidateHint();
}

let bridgeInstalled = false;
export function installWordCandidateBridge() {
  if (bridgeInstalled || typeof document === 'undefined') return;
  bridgeInstalled = true;
  document.addEventListener('click', syncTappedParagraph, true);
  document.addEventListener('reader-word-analysis-ready', async event => {
    const detail = event?.detail || {};
    const store = readState();
    if (!mergeLemmaMetadata(store, detail)) return;
    await persistState(store);
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindEmptyCandidateHint, { once: true });
  } else {
    bindEmptyCandidateHint();
  }
  setTimeout(bindEmptyCandidateHint, 0);
  setTimeout(bindEmptyCandidateHint, 500);
}

export { canonicalLang as candidateCanonicalLang, normalizeWord as candidateNormalizeWord };
