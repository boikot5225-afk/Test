import {
  buildStableContextAnchor,
  normalizeContextText,
  paragraphTextOccurrence,
} from './context-anchor.js?v=1';

export function createReaderWordState(opts) {
  const {
    getCache, setCache, storageKey, canonicalLang, currentLang, normalizeWord,
    normalizeImportKey, isCommonWord, seenAfter, fadeAfter, familiarAfter,
    getBookLang, tokenizeParagraph, findVerbByForm, log = console,
    onSaveError = null,
    onSaved = null,
    idbGet = async () => null,
    idbPut = async () => {},
  } = opts;

  const PLACES_CAP = 12;
  const CLICK_CONTEXTS_CAP = 32;
  const TOTAL_CAP = 6000;

  // reader-app's legacy pinyin policy normalizes status before deciding whether
  // a passively seen CJK word may keep ruby, but it only treats exact lowercase
  // "known" as actually learned. This uppercase sentinel therefore keeps the
  // default ruby mode stable without lying to colours/SRS or erasing seen counts.
  // In the explicit "learning only" ruby mode it is still hidden, as intended.
  const PASSIVE_RUBY_SENTINEL = 'KNOWN';
  const isCjkLanguage = (lang) => ['zh', 'ja'].includes(canonicalLang(lang));
  const isPassiveRubySentinel = (state) => !!state
    && state.status === PASSIVE_RUBY_SENTINEL
    && state.autoRubyVisible === true
    && !state.known;
  const hasExplicitLearningStatus = (state) => {
    if (isPassiveRubySentinel(state)) return false;
    return ['learning', 'problem', 'hard', 'familiar', 'looked', 'known']
      .includes(String(state?.status || '').trim().toLowerCase());
  };
  const stabilizePassiveRuby = (state) => {
    if (!state || !isCjkLanguage(state.lang)) return false;

    const shouldPin = !state.known
      && !state.saved
      && Number(state.clicked || 0) <= 0
      && Number(state.seen || 0) >= seenAfter
      && !hasExplicitLearningStatus(state);

    if (shouldPin) {
      const changed = state.status !== PASSIVE_RUBY_SENTINEL || state.autoRubyVisible !== true;
      state.status = PASSIVE_RUBY_SENTINEL;
      state.autoRubyVisible = true;
      return changed;
    }

    if (isPassiveRubySentinel(state) && (state.known || state.saved || Number(state.clicked || 0) > 0)) {
      delete state.autoRubyVisible;
      state.status = state.known ? 'known' : state.saved ? 'learning' : 'looked';
      return true;
    }
    return false;
  };
  const stabilizeAllPassiveRuby = (data) => {
    let changed = false;
    for (const state of Object.values(data || {})) {
      changed = stabilizePassiveRuby(state) || changed;
    }
    return changed;
  };

  const isPrunable = (state) => !state?.saved && !state?.known
    && !['problem', 'hard', 'familiar'].includes(state?.status);

  const prunePlaces = (state) => {
    const places = state?.places;
    if (!places || typeof places !== 'object') return false;
    const keys = Object.keys(places);
    if (keys.length <= PLACES_CAP) return false;
    state.seen = Math.max(state.seen || 0, keys.length);
    state.places = {};
    for (const k of keys.slice(-PLACES_CAP)) state.places[k] = true;
    return true;
  };

  const pruneClickContexts = (state) => {
    const contexts = state?.clickContexts;
    if (!contexts || typeof contexts !== 'object') return false;
    const rows = Object.entries(contexts);
    if (rows.length <= CLICK_CONTEXTS_CAP) return false;
    rows.sort((a, b) => new Date(b[1]?.at || 0) - new Date(a[1]?.at || 0));
    state.clickContexts = Object.fromEntries(rows.slice(0, CLICK_CONTEXTS_CAP));
    return true;
  };

  const pruneOverflow = (data) => {
    const keys = Object.keys(data);
    if (keys.length <= TOTAL_CAP) return false;
    const candidates = keys.filter(k => isPrunable(data[k]))
      .sort((a, b) => new Date(data[a]?.updatedAt || 0) - new Date(data[b]?.updatedAt || 0));
    const over = keys.length - TOTAL_CAP;
    for (const k of candidates.slice(0, over)) delete data[k];
    return over > 0 && candidates.length > 0;
  };

  const pruneAll = (data) => {
    let pruned = false;
    for (const k of Object.keys(data)) {
      pruned = prunePlaces(data[k]) || pruned;
      pruned = pruneClickContexts(data[k]) || pruned;
    }
    pruned = pruneOverflow(data) || pruned;
    return pruned;
  };

  const cacheRead = () => {
    try { return getCache(); }
    catch (e) {
      if (e && e.name === 'ReferenceError') return null;
      throw e;
    }
  };
  const cacheWrite = (value) => {
    try { setCache(value); }
    catch (e) {
      if (!(e && e.name === 'ReferenceError')) throw e;
      log.warn?.('[reader] word-state cache delayed');
    }
  };
  const publishLiveSnapshot = (value) => {
    try { globalThis.an2ReaderWordStateSnapshot = () => value; } catch {}
    return value;
  };

  // HOT PATH: once the state is in memory, load() must be O(1). The old code
  // called stabilizeAllPassiveRuby(cached) here. visual() calls load() once for
  // every rendered word, so a 6000-word history multiplied by hundreds of words
  // in the chapter turned a simple paint into millions of iterations. Do the
  // full normalization once when data enters memory instead; individual state
  // mutations stabilize only the state they touched.
  const load = () => {
    const cached = cacheRead();
    if (cached) return publishLiveSnapshot(cached);
    let data = {};
    try { data = JSON.parse(localStorage.getItem(storageKey()) || '{}') || {}; } catch (_) {}
    let changed = pruneAll(data);
    changed = stabilizeAllPassiveRuby(data) || changed;
    if (changed) {
      try { localStorage.setItem(storageKey(), JSON.stringify(data)); } catch (_) {}
    }
    cacheWrite(data);
    return publishLiveSnapshot(data);
  };

  let scheduledSaveTimer = null;
  let scheduledIdleHandle = null;
  let scheduledSaveDueAt = 0;

  const persistNow = () => {
    if (scheduledSaveTimer) clearTimeout(scheduledSaveTimer);
    scheduledSaveTimer = null;
    scheduledSaveDueAt = 0;
    if (scheduledIdleHandle != null && typeof cancelIdleCallback === 'function') {
      try { cancelIdleCallback(scheduledIdleHandle); } catch {}
    }
    scheduledIdleHandle = null;

    const data = load();
    for (const item of Object.values(data)) pruneClickContexts(item);
    pruneOverflow(data);
    let localOk = true;
    try {
      localStorage.setItem(storageKey(), JSON.stringify(data));
    } catch (e) {
      pruneAll(data);
      try {
        localStorage.setItem(storageKey(), JSON.stringify(data));
      } catch (e2) {
        localOk = false;
        log.warn?.('[reader] word-state localStorage cache write failed (IndexedDB still holds the data)', e2);
      }
    }
    idbPut(storageKey(), data).catch(e => {
      log.warn?.('[reader] word-state IndexedDB save failed', e);
      if (!localOk) onSaveError?.(e);
    });
    onSaved?.();
    return data;
  };

  // Heavy JSON serialization is deliberately pushed out of the tap/scroll
  // frame. Explicit actions ask for a shorter delay, passive paragraph tracking
  // for a longer one; whichever is sooner wins. requestIdleCallback keeps the
  // commit away from active animation/scroll frames when WebView supports it.
  const scheduleSave = (delay = 900) => {
    const now = Date.now();
    const due = now + Math.max(0, delay);
    if (scheduledSaveTimer && scheduledSaveDueAt <= due) return;
    if (scheduledSaveTimer) clearTimeout(scheduledSaveTimer);
    scheduledSaveDueAt = due;
    scheduledSaveTimer = setTimeout(() => {
      scheduledSaveTimer = null;
      scheduledSaveDueAt = 0;
      if (typeof requestIdleCallback === 'function') {
        scheduledIdleHandle = requestIdleCallback(() => {
          scheduledIdleHandle = null;
          persistNow();
        }, { timeout: 1800 });
      } else {
        persistNow();
      }
    }, Math.max(0, due - now));
  };

  const save = () => {
    scheduleSave(350);
    return load();
  };

  const hydrateFromIndexedDB = async () => {
    let fromIdb;
    try { fromIdb = await idbGet(storageKey()); }
    catch (e) { log.warn?.('[reader] word-state IndexedDB hydrate failed', e); return false; }
    if (!fromIdb || typeof fromIdb !== 'object') return false;

    const current = load();
    let changed = false;
    for (const [k, v] of Object.entries(fromIdb)) {
      if (!v || !v.word) continue;
      const local = current[k];
      if (!local || new Date(v.updatedAt || 0) > new Date(local.updatedAt || 0)) {
        current[k] = v;
        changed = true;
      }
    }
    changed = stabilizeAllPassiveRuby(current) || changed;
    if (!changed) return false;
    cacheWrite(current);
    try { localStorage.setItem(storageKey(), JSON.stringify(current)); } catch (_) {}
    return true;
  };

  const key = (word, lang = null) => {
    const language = canonicalLang(lang || currentLang());
    return `${language}:${normalizeImportKey(normalizeWord(word, language))}`;
  };

  const stateKey = (word, language) => `${language}:${normalizeImportKey(normalizeWord(word, language))}`;
  const ensureIn = (state, word, language) => {
    const k = stateKey(word, language);
    if (!state[k]) state[k] = {
      word: normalizeWord(word, language), lang: language, seen: 0, clicked: 0,
      saved: false, known: false, status: 'new', places: {}, clickContexts: {},
      updatedAt: new Date().toISOString(),
    };
    return state[k];
  };

  const get = (word, lang = null) => {
    const language = canonicalLang(lang || currentLang());
    return ensureIn(load(), word, language);
  };
  const touch = (word, lang = null) => { const state = get(word, lang); state.updatedAt = new Date().toISOString(); return state; };

  const trackParagraph = (book, chapter, index, text) => {
    if (!book || !chapter) return false;
    const language = getBookLang(book);
    const place = `${book.id || 'book'}:${chapter.id || String(book.currentChapter || 0)}:${index}`;
    const store = load();
    let changed = false;
    const words = new Set(tokenizeParagraph(text, language).map(x => normalizeWord(x, language)).filter(Boolean));
    for (const word of words) {
      // Do NOT call get() here: get()->load() used to run a whole-store CJK
      // stabilization pass for every unique token in the paragraph.
      const state = ensureIn(store, word, language);
      state.places ||= {};
      if (!state.places[place] && Object.keys(state.places).length < PLACES_CAP) {
        state.places[place] = true;
        changed = true;
      }
      const seen = Math.max(state.seen || 0, Object.keys(state.places).length);
      if (state.seen !== seen) { state.seen = seen; changed = true; }
      if (isCommonWord(word, language)) {
        if (!state.known || state.status !== 'known') changed = true;
        state.known = true;
        state.autoKnown = 'common';
        state.status = 'known';
        delete state.autoRubyVisible;
      } else {
        changed = stabilizePassiveRuby(state) || changed;
      }
    }
    if (changed) scheduleSave(1000);
    // CJK word-state changes used to rebuild every ruby token 420 ms after it
    // entered the viewport. Keep tracking/syncing, but repaint colours/ruby only
    // on an actual navigation or explicit word action, not in the reader's face.
    return changed && !isCjkLanguage(language);
  };

  const activeClickContext = (word, explicitContext = null) => {
    if (typeof document === 'undefined') return explicitContext || null;
    const root = document.getElementById('reader-chapter-text');
    const language = currentLang();
    const normalizedWord = normalizeWord(word, language);
    const globalTap = globalThis.__readerCandidateTapContext;
    const freshGlobalTap = globalTap
      && Date.now() - Number(globalTap.capturedAt || 0) < 5000
      && normalizeWord(globalTap.word || '', language) === normalizedWord
      ? globalTap
      : null;
    const supplied = explicitContext || freshGlobalTap;
    const suppliedIndex = Number(supplied?.paragraphIndex);
    const exact = Number.isFinite(suppliedIndex)
      ? root?.querySelector(`.reader-paragraph[data-p="${suppliedIndex}"]`)
      : null;
    const active = exact || root?.querySelector('.reader-paragraph.active') || root?.querySelector('.reader-paragraph');
    if (!active && !supplied) return null;
    const paragraphIndex = Number.isFinite(suppliedIndex) ? suppliedIndex : Number(active?.dataset?.p);
    const bookTitle = String(supplied?.bookTitle || document.getElementById('reader-book-title')?.textContent || '').trim();
    const chapterTitle = String(supplied?.chapterTitle || document.getElementById('reader-chapter-title')?.textContent || '')
      .replace(/\s*·\s*абзац\s+\d+\s*\/\s*\d+.*$/i, '')
      .trim();
    let text = String(supplied?.text || '').replace(/\s+/g, ' ').trim().slice(0, 320);
    if (!text && active) {
      const clone = active.cloneNode(true);
      clone.querySelectorAll?.('.reader-translation,.reader-analysis-actions,.reader-footnote-ref,button').forEach(el => el.remove());
      text = String(clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 320);
    }
    const rootBookId = String(supplied?.bookId || root?.dataset?.readerBookId || bookTitle || 'book');
    const rootChapterKey = String(supplied?.chapterKey || root?.dataset?.readerChapterKey || chapterTitle || 'chapter');
    const occurrenceInfo = active
      ? paragraphTextOccurrence(root, active, text)
      : { occurrence: Number(supplied?.textOccurrence) || 0, count: Number(supplied?.textOccurrenceCount) || 1 };
    const anchor = supplied?.place
      ? {
          place: supplied.place,
          elementPath: supplied.elementPath || '',
          textFingerprint: supplied.textFingerprint || '',
          textOccurrence: Number(supplied.textOccurrence) || 0,
        }
      : buildStableContextAnchor({
          bookId: rootBookId,
          chapterKey: rootChapterKey,
          text,
          occurrence: occurrenceInfo.occurrence,
        });
    return {
      ...anchor,
      at: supplied?.at || new Date().toISOString(),
      text,
      bookTitle,
      chapterTitle,
      bookId: rootBookId,
      chapterKey: rootChapterKey,
      textOccurrenceCount: Number(supplied?.textOccurrenceCount) || occurrenceInfo.count,
      paragraphIndex: Number.isFinite(paragraphIndex) ? paragraphIndex : null,
      form: normalizeWord(supplied?.form || word, language),
    };
  };

  const equivalentLegacyContextKey = (contexts, next) => {
    const nextText = normalizeContextText(next?.text);
    if (!nextText) return '';
    for (const [place, previous] of Object.entries(contexts || {})) {
      if (place === next.place) return place;
      if (normalizeContextText(previous?.text) !== nextText) continue;
      if (previous?.bookTitle && next.bookTitle && previous.bookTitle !== next.bookTitle) continue;
      if (previous?.chapterTitle && next.chapterTitle && previous.chapterTitle !== next.chapterTitle) continue;
      const sameIndex = Number.isFinite(Number(previous?.paragraphIndex))
        && Number(previous.paragraphIndex) === Number(next.paragraphIndex);
      const uniqueText = Number(next.textOccurrenceCount || 1) === 1;
      if (sameIndex || uniqueText) return place;
    }
    return '';
  };

  const markClicked = (word, lang = null, explicitContext = null) => {
    if (!word || isCommonWord(word, lang)) return false;
    const state = touch(word, lang);
    delete state.autoRubyVisible;
    state.clickContexts ||= {};
    const context = activeClickContext(word, explicitContext);
    let counted = false;
    if (context?.place) {
      if (!state.clickContexts[context.place]) {
        const legacyKey = equivalentLegacyContextKey(state.clickContexts, context);
        if (legacyKey) {
          delete state.clickContexts[legacyKey];
          state.clickContexts[context.place] = context;
        } else {
          state.clickContexts[context.place] = context;
          state.clicked = (state.clicked || 0) + 1;
          counted = true;
        }
      } else {
        state.clickContexts[context.place] = { ...state.clickContexts[context.place], ...context };
      }
    } else {
      state.clicked = (state.clicked || 0) + 1;
      counted = true;
    }
    if (!state.saved && !state.known) state.status = 'looked';
    save();
    return counted;
  };
  const markSaved = (word, lemma = null, lang = null, ru = '') => {
    const state = touch(lemma || word, lang); delete state.autoRubyVisible; state.saved = true; state.known = false; state.status = state.seen >= familiarAfter ? 'familiar' : 'learning'; if (ru) state.ru = ru;
    if (word && lemma && key(word, lang) !== key(lemma, lang)) { const form = touch(word, lang); delete form.autoRubyVisible; form.saved = true; form.linkedLemma = normalizeWord(lemma, lang); form.lemma = normalizeWord(lemma, lang); form.status = 'learning'; if (ru) form.ru = ru; }
    save();
  };
  const markKnown = (word, lang = null) => {
    const language = canonicalLang(lang || currentLang());
    const state = touch(word, language);
    delete state.autoRubyVisible;
    state.known = true;
    state.status = 'known';
    state.autoKnown = false;
    // A user click is final authority.  Keep an explicit sentinel so every
    // language-specific classifier can distinguish it from estimated/common
    // Known during later async renders and cache/cloud hydration.
    state.manualKnowledge = 'known';
    state.manualKnowledgeAt = state.updatedAt || new Date().toISOString();
    save();
  };

  // French verb-form detection used to scan the whole verb table every time the
  // same token was painted. Memoize it for the lifetime of this reader store.
  const frenchKnownFormCache = new Map();
  const isFrenchKnownForm = (normalized, language) => {
    if (language !== 'fr') return false;
    if (frenchKnownFormCache.has(normalized)) return frenchKnownFormCache.get(normalized);
    const known = !!findVerbByForm(normalized);
    if (frenchKnownFormCache.size > 2500) frenchKnownFormCache.clear();
    frenchKnownFormCache.set(normalized, known);
    return known;
  };

  const visual = (word, lang = null) => {
    const language = canonicalLang(lang || currentLang());
    const normalized = normalizeWord(word, language);
    if (!normalized) return { cls: 'rw-known', title: 'служебное/частое слово' };
    const store = load();
    const state = store[stateKey(normalized, language)];
    const seen = Number(state?.seen || 0);
    if (state?.known || state?.status === 'known') return { cls: 'rw-known', title: 'изучено' };
    if (state?.status === 'problem' || state?.status === 'hard') return { cls: 'rw-problem', title: 'проблемное слово' };
    if (state?.status === 'familiar') return { cls: 'rw-familiar', title: 'закрепляется' };
    if (state?.status === 'learning' || state?.saved) return { cls: 'rw-learning', title: 'изучаю' };
    if (state?.status === 'looked' || (state?.clicked || 0) > 0) return { cls: 'rw-looked', title: `просмотрено ${state?.clicked || 1} раз` };
    if (isCommonWord(normalized, language) || isFrenchKnownForm(normalized, language)) return { cls: 'rw-known', title: 'изучено' };
    if (seen >= fadeAfter) return { cls: 'rw-faded', title: `встречалось ${seen} раз — подсветка скрыта` };
    if (seen >= seenAfter) return { cls: 'rw-seen', title: `часто встречалось: ${seen} абз.` };
    return { cls: 'rw-new', title: language === 'zh' ? 'новый китайский сегмент' : language === 'ja' ? 'новый японский сегмент' : 'новое слово' };
  };
  const statusRu = state => {
    if (!state) return 'новое'; const seen = Number(state.seen || 0);
    if (state.known || state.status === 'known') return 'изучено'; if (state.status === 'problem' || state.status === 'hard') return 'проблемное'; if (state.status === 'learning') return 'изучаю'; if (state.status === 'familiar') return 'закрепляется'; if (state.saved) return 'в словаре'; if ((state.clicked || 0) > 0 || state.status === 'looked') return 'просмотрено'; if (seen >= fadeAfter) return `видел ${seen} — подсветка скрыта`; if (seen >= seenAfter) return `часто встречалось: ${seen}`; return seen > 0 ? `видел ${seen}` : 'новое';
  };
  return { load, save, hydrateFromIndexedDB, key, get, touch, trackParagraph, markClicked, markSaved, markKnown, visual, statusRu };
}
