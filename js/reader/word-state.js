export function createReaderWordState(opts) {
  const {
    getCache, setCache, storageKey, canonicalLang, currentLang, normalizeWord,
    normalizeImportKey, isCommonWord, seenAfter, fadeAfter, familiarAfter,
    getBookLang, tokenizeParagraph, findVerbByForm, log = console,
    onSaveError = null,
    onSaved = null,
    // localStorage caps out around 5MB/origin — a large enough vocabulary across
    // languages/books can exceed it, and the write below then fails silently,
    // quietly discarding word marks made since the last snapshot that fit.
    // IndexedDB has a much larger practical quota, so it's used as the durable
    // backing store; idbGet/idbPut are optional so this module still works
    // (minus the durability) if they aren't wired up.
    idbGet = async () => null,
    idbPut = async () => {},
  } = opts;

  // places is only needed to count distinct paragraphs up to the fade threshold;
  // without a cap it grows unbounded and eventually blows the localStorage quota.
  const PLACES_CAP = 12;

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

  const pruneAll = (data) => {
    let pruned = false;
    for (const k of Object.keys(data)) pruned = prunePlaces(data[k]) || pruned;
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
  const load = () => {
    const cached = cacheRead();
    if (cached) return cached;
    let data = {};
    try { data = JSON.parse(localStorage.getItem(storageKey()) || '{}') || {}; } catch (_) {}
    if (pruneAll(data)) {
      try { localStorage.setItem(storageKey(), JSON.stringify(data)); } catch (_) {}
    }
    cacheWrite(data);
    return data;
  };
  const save = () => {
    const data = load();
    try {
      localStorage.setItem(storageKey(), JSON.stringify(data));
    } catch (e) {
      // quota hit: shed legacy places bloat and retry once before giving up
      pruneAll(data);
      try {
        localStorage.setItem(storageKey(), JSON.stringify(data));
      } catch (e2) {
        log.warn?.('[reader] state save', e2);
        onSaveError?.(e2);
      }
    }
    // Durable copy: fires regardless of whether the localStorage write above
    // succeeded, since IndexedDB doesn't share that 5MB-ish ceiling.
    idbPut(storageKey(), data).catch(e => log.warn?.('[reader] word-state IndexedDB backup failed', e));
    // schedule cloud sync even when localStorage failed — cloud works off the in-memory state
    onSaved?.();
  };

  // Call once when the reader UI opens to recover any word marks a past
  // localStorage quota failure silently dropped. Newer-wins merge by
  // updatedAt, same rule used for the Firebase cloud sync.
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
    if (!state[k]) state[k] = { word: normalizeWord(word, language), lang: language, seen: 0, clicked: 0, saved: false, known: false, status: 'new', places: {}, updatedAt: new Date().toISOString() };
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
      if (isCommonWord(word, language)) { state.known = true; state.status = 'known'; }
      state.updatedAt = new Date().toISOString();
    });
    if (changed) save();
    return changed;
  };
  const markClicked = (word, lang = null) => { if (!word || isCommonWord(word, lang)) return; const state = touch(word, lang); state.clicked = (state.clicked || 0) + 1; if (!state.saved && !state.known) state.status = 'looked'; save(); };
  const markSaved = (word, lemma = null, lang = null, ru = '') => {
    const state = touch(lemma || word, lang); state.saved = true; state.known = false; state.status = state.seen >= familiarAfter ? 'familiar' : 'learning'; if (ru) state.ru = ru;
    if (word && lemma && key(word, lang) !== key(lemma, lang)) { const form = touch(word, lang); form.saved = true; form.linkedLemma = normalizeWord(lemma, lang); form.status = 'learning'; if (ru) form.ru = ru; }
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
