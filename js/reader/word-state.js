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
  const load = () => {
    const cached = cacheRead();
    if (cached) return publishLiveSnapshot(cached);
    let data = {};
    try { data = JSON.parse(localStorage.getItem(storageKey()) || '{}') || {}; } catch (_) {}
    if (pruneAll(data)) {
      try { localStorage.setItem(storageKey(), JSON.stringify(data)); } catch (_) {}
    }
    cacheWrite(data);
    return publishLiveSnapshot(data);
  };
  const save = () => {
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
    if (!changed) return false;
    cacheWrite(current);
    try { localStorage.setItem(storageKey(), JSON.stringify(current)); } catch (_) {}
    return true;
  };
  const key = (word, lang = null) => {
    const language = canonicalLang(lang || currentLang());
    return `${language}:${normalizeImportKey(normalizeWord(word, language))}`;
  };
  const get = (word, lang = null) => {
    const language = canonicalLang(lang || currentLang()), k = key(word, language), state = load();
    if (!state[k]) state[k] = { word: normalizeWord(word, language), lang: language, seen: 0, clicked: 0, saved: false, known: false, status: 'new', places: {}, clickContexts: {}, updatedAt: new Date().toISOString() };
    return state[k];
  };
  const touch = (word, lang = null) => { const state = get(word, lang); state.updatedAt = new Date().toISOString(); return state; };
  const trackParagraph = (book, chapter, index, text) => {
    if (!book || !chapter) return false;
    const language = getBookLang(book), place = `${book.id || 'book'}:${chapter.id || String(book.currentChapter || 0)}:${index}`;
    let changed = false;
    new Set(tokenizeParagraph(text, language).map(x => normalizeWord(x, language)).filter(Boolean)).forEach(word => {
      const state = get(word, language); state.places ||= {};
      if (!state.places[place] && Object.keys(state.places).length < PLACES_CAP) { state.places[place] = true; changed = true; }
      const seen = Math.max(state.seen || 0, Object.keys(state.places).length);
      if (state.seen !== seen) { state.seen = seen; changed = true; }
      if (isCommonWord(word, language)) {
        state.known = true;
        state.autoKnown = 'common';
        state.status = 'known';
      }
    });
    if (changed) save();
    return changed;
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
    const state = touch(lemma || word, lang); state.saved = true; state.known = false; state.status = state.seen >= familiarAfter ? 'familiar' : 'learning'; if (ru) state.ru = ru;
    if (word && lemma && key(word, lang) !== key(lemma, lang)) { const form = touch(word, lang); form.saved = true; form.linkedLemma = normalizeWord(lemma, lang); form.lemma = normalizeWord(lemma, lang); form.status = 'learning'; if (ru) form.ru = ru; }
    save();
  };
  const markKnown = (word, lang = null) => { const state = touch(word, lang); state.known = true; state.status = 'known'; state.autoKnown = false; save(); };
  const visual = (word, lang = null) => {
    const language = canonicalLang(lang || currentLang()), normalized = normalizeWord(word, language);
    if (!normalized) return { cls: 'rw-known', title: 'служебное/частое слово' };
    const state = load()[key(normalized, language)], seen = Number(state?.seen || 0);
    if (state?.known || state?.status === 'known') return { cls: 'rw-known', title: 'изучено' };
    if (state?.status === 'problem' || state?.status === 'hard') return { cls: 'rw-problem', title: 'проблемное слово' };
    if (state?.status === 'familiar') return { cls: 'rw-familiar', title: 'закрепляется' };
    if (state?.status === 'learning' || state?.saved) return { cls: 'rw-learning', title: 'изучаю' };
    if (state?.status === 'looked' || (state?.clicked || 0) > 0) return { cls: 'rw-looked', title: `просмотрено ${state?.clicked || 1} раз` };
    if (isCommonWord(normalized, language) || (language === 'fr' && findVerbByForm(normalized))) return { cls: 'rw-known', title: 'изучено' };
    if (seen >= fadeAfter) return { cls: 'rw-faded', title: `встречалось ${seen} раз — подсветка скрыта` };
    if (seen >= seenAfter) return { cls: 'rw-seen', title: `часто встречалось: ${seen} абз.` };
    return { cls: 'rw-new', title: language === 'zh' ? 'новый китайский сегмент' : 'новое слово' };
  };
  const statusRu = state => {
    if (!state) return 'новое'; const seen = Number(state.seen || 0);
    if (state.known || state.status === 'known') return 'изучено'; if (state.status === 'problem' || state.status === 'hard') return 'проблемное'; if (state.status === 'learning') return 'изучаю'; if (state.status === 'familiar') return 'закрепляется'; if (state.saved) return 'в словаре'; if ((state.clicked || 0) > 0 || state.status === 'looked') return 'просмотрено'; if (seen >= fadeAfter) return `видел ${seen} — подсветка скрыта`; if (seen >= seenAfter) return `часто встречалось: ${seen}`; return seen > 0 ? `видел ${seen}` : 'новое';
  };
  return { load, save, hydrateFromIndexedDB, key, get, touch, trackParagraph, markClicked, markSaved, markKnown, visual, statusRu };
}
