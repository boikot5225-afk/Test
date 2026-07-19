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
  // Separate click contexts are the evidence used by the home-screen learning
  // candidates. Keep enough recent examples to rank a word and show snippets,
  // but never allow this history to grow without limit.
  const CLICK_CONTEXTS_CAP = 32;
  // A large multi-language vocabulary can still blow the ~5MB localStorage quota
  // even with places capped per word, once the total WORD COUNT itself grows
  // large — every "looked at" or "seen" word is tracked forever with no cap.
  // Evict oldest low-value entries (never saved/known/problem/familiar — pure
  // seen/looked churn) once the total is past this, so real learning progress
  // (saved words, known words, problem words) is never at risk.
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
    // The in-memory cache only runs pruneAll() once (at first load), so a long
    // session that keeps adding new words needs the overflow check re-run on
    // every save — otherwise the total count only gets capped again on reload.
    for (const item of Object.values(data)) pruneClickContexts(item);
    pruneOverflow(data);
    // localStorage is only the fast in-session cache now — IndexedDB below is
    // the durable store (no ~5MB ceiling) and cloud sync mirrors it. A quota
    // failure here alone doesn't endanger the data, so it's logged, not surfaced.
    let localOk = true;
    try {
      localStorage.setItem(storageKey(), JSON.stringify(data));
    } catch (e) {
      // quota hit: shed legacy places bloat and retry once before giving up
      pruneAll(data);
      try {
        localStorage.setItem(storageKey(), JSON.stringify(data));
      } catch (e2) {
        localOk = false;
        log.warn?.('[reader] word-state localStorage cache write failed (IndexedDB still holds the data)', e2);
      }
    }
    // The durable write. Only when BOTH this and localStorage fail is the data
    // actually at risk (in-memory + cloud only) — that's the case worth a toast.
    idbPut(storageKey(), data).catch(e => {
      log.warn?.('[reader] word-state IndexedDB save failed', e);
      if (!localOk) onSaveError?.(e);
    });
    // schedule cloud sync even when local writes failed — cloud works off the in-memory state
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
      if (isCommonWord(word, language)) { state.known = true; state.status = 'known'; }
      // Do NOT bump updatedAt here: this fires on every rendered paragraph for
      // every word in view, purely from passive "seen" tracking, not a real
      // interaction. The cloud merge picks whichever side has the newer
      // updatedAt — if merely opening a book on one device re-stamped every
      // visible word as "just changed now", it would always beat a genuine
      // save/click made on another device, silently discarding it on sync.
    });
    if (changed) save();
    return changed;
  };

  const activeClickContext = (word) => {
    if (typeof document === 'undefined') return null;
    const root = document.getElementById('reader-chapter-text');
    const active = root?.querySelector('.reader-paragraph.active') || root?.querySelector('.reader-paragraph');
    if (!active) return null;
    const paragraphIndex = Number(active.dataset?.p);
    const bookTitle = String(document.getElementById('reader-book-title')?.textContent || '').trim();
    const chapterTitle = String(document.getElementById('reader-chapter-title')?.textContent || '').trim();
    const clone = active.cloneNode(true);
    clone.querySelectorAll?.('.reader-translation,.reader-analysis-actions,.reader-footnote-ref,button').forEach(el => el.remove());
    const text = String(clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 320);
    const place = `${bookTitle || 'book'}::${chapterTitle || 'chapter'}::${Number.isFinite(paragraphIndex) ? paragraphIndex : active.dataset?.p || '0'}`;
    return {
      place,
      at: new Date().toISOString(),
      text,
      bookTitle,
      chapterTitle,
      paragraphIndex: Number.isFinite(paragraphIndex) ? paragraphIndex : null,
      form: normalizeWord(word, currentLang()),
    };
  };

  const markClicked = (word, lang = null) => {
    if (!word || isCommonWord(word, lang)) return false;
    const state = touch(word, lang);
    state.clickContexts ||= {};
    const context = activeClickContext(word);
    let counted = false;
    if (context?.place) {
      if (!state.clickContexts[context.place]) {
        state.clickContexts[context.place] = context;
        state.clicked = (state.clicked || 0) + 1;
        counted = true;
      } else {
        // Keep the latest snippet/date for diagnostics, but repeated taps in the
        // same paragraph are not new evidence that the word deserves learning.
        state.clickContexts[context.place] = { ...state.clickContexts[context.place], ...context };
      }
    } else {
      // Non-reader callers do not have a paragraph identity. Preserve the old
      // counter behaviour for compatibility, but home candidates only trust
      // distinct clickContexts, so these calls cannot game the ranking.
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
