// Reader word-state engine.
// It owns the local reader trail: encounters, clicks, saved words and visual status.
// UI, DeepSeek and database calls remain outside this module.

export function createReaderWordState({
  getCache,
  setCache,
  storageKey,
  canonicalLang,
  currentLang,
  normalizeWord,
  normalizeImportKey,
  isCommonWord,
  seenAfter,
  fadeAfter,
  familiarAfter,
  getBookLang,
  tokenizeParagraph,
  findVerbByForm,
  log = console,
}) {
  function load() {
    const cached = getCache();
    if (cached) return cached;
    let state = {};
    try {
      state = JSON.parse(localStorage.getItem(storageKey()) || '{}') || {};
    } catch (_) {
      state = {};
    }
    setCache(state);
    return state;
  }

  function save() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(load()));
    } catch (error) {
      log.warn?.('[reader word state] save failed', error);
    }
  }

  function key(word, lang = null) {
    const language = canonicalLang(lang || currentLang());
    return `${language}:${normalizeImportKey(normalizeWord(word, language))}`;
  }

  function get(word, lang = null) {
    const language = canonicalLang(lang || currentLang());
    const stateKey = key(word, language);
    const state = load();
    if (!state[stateKey]) {
      state[stateKey] = {
        word: normalizeWord(word, language),
        lang: language,
        seen: 0,
        clicked: 0,
        saved: false,
        known: false,
        status: 'new',
        places: {},
        updatedAt: new Date().toISOString(),
      };
    }
    return state[stateKey];
  }

  function touch(word, lang = null) {
    const state = get(word, lang);
    state.updatedAt = new Date().toISOString();
    return state;
  }

  function trackParagraph(book, chapter, paragraphIndex, paragraphText) {
    if (!book || !chapter) return false;
    const language = getBookLang(book);
    const bookId = book.id || 'book';
    const chapterId = chapter.id || String(book.currentChapter || 0);
    const placeKey = `${bookId}:${chapterId}:${paragraphIndex}`;
    let changed = false;
    const words = new Set(
      tokenizeParagraph(paragraphText, language)
        .map(token => normalizeWord(token, language))
        .filter(Boolean),
    );

    words.forEach(word => {
      const state = get(word, language);
      state.places = state.places || {};
      const seenBefore = state.seen || 0;
      if (!state.places[placeKey]) {
        state.places[placeKey] = true;
        changed = true;
      }
      const nextSeen = Object.keys(state.places).length;
      if (state.seen !== nextSeen) {
        state.seen = nextSeen;
        changed = true;
      }
      if (changed || seenBefore !== nextSeen) state.updatedAt = new Date().toISOString();
      if (isCommonWord(word, language)) {
        if (!state.known || state.status !== 'known') changed = true;
        state.known = true;
        state.status = 'known';
      }
    });

    if (changed) save();
    return changed;
  }

  function markClicked(word, lang = null) {
    if (!word || isCommonWord(word, lang)) return;
    const state = touch(word, lang);
    state.clicked = (state.clicked || 0) + 1;
    if (!state.saved && !state.known) state.status = 'looked';
    save();
  }

  function markSaved(word, lemma = null, lang = null, ru = '') {
    const state = touch(lemma || word, lang);
    state.saved = true;
    state.known = false;
    state.status = state.seen >= familiarAfter ? 'familiar' : 'learning';
    state.updatedAt = new Date().toISOString();
    if (ru) state.ru = ru;

    if (word && lemma && key(word, lang) !== key(lemma, lang)) {
      const form = touch(word, lang);
      form.saved = true;
      form.linkedLemma = normalizeWord(lemma, lang);
      form.status = 'learning';
      if (ru) form.ru = ru;
    }
    save();
  }

  function markKnown(word, lang = null) {
    const state = touch(word, lang);
    state.known = true;
    state.status = 'known';
    state.autoKnown = false;
    save();
  }

  function visual(word, lang = null) {
    const language = canonicalLang(lang || currentLang());
    const normalized = normalizeWord(word, language);
    if (!normalized) return { cls: 'rw-known', title: 'служебное/частое слово' };

    const state = load()[key(normalized, language)];
    const seen = Number(state?.seen || 0);
    if (state?.known || state?.status === 'known') return { cls: 'rw-known', title: 'изучено' };
    if (state?.status === 'problem' || state?.status === 'hard') return { cls: 'rw-problem', title: 'проблемное слово' };
    if (state?.status === 'familiar') return { cls: 'rw-familiar', title: 'закрепляется' };
    if (state?.status === 'learning' || state?.saved) return { cls: 'rw-learning', title: 'изучаю' };
    if (state?.status === 'looked' || (state?.clicked || 0) > 0) return { cls: 'rw-looked', title: `просмотрено ${state?.clicked || 1} раз` };
    if (isCommonWord(normalized, language)) return { cls: 'rw-known', title: 'служебное/частое слово' };
    if (language === 'fr' && findVerbByForm(normalized)) return { cls: 'rw-known', title: 'форма известного глагола' };
    if (seen >= fadeAfter) return { cls: 'rw-faded', title: `встречалось ${seen} раз — подсветка скрыта` };
    if (seen >= seenAfter) return { cls: 'rw-seen', title: `часто встречалось: ${seen} абз.` };
    return { cls: 'rw-new', title: language === 'zh' ? 'новый китайский сегмент' : 'новое слово' };
  }

  function statusRu(state) {
    if (!state) return 'новое';
    const seen = Number(state.seen || 0);
    if (state.known || state.status === 'known') return 'изучено';
    if (state.status === 'problem' || state.status === 'hard') return 'проблемное';
    if (state.status === 'learning') return 'изучаю';
    if (state.status === 'familiar') return 'закрепляется';
    if (state.saved) return 'в словаре';
    if ((state.clicked || 0) > 0 || state.status === 'looked') return 'просмотрено';
    if (seen >= fadeAfter) return `видел ${seen} — подсветка скрыта`;
    if (seen >= seenAfter) return `часто встречалось: ${seen}`;
    if (seen > 0) return `видел ${seen}`;
    return 'новое';
  }

  return {
    load,
    save,
    key,
    get,
    touch,
    trackParagraph,
    markClicked,
    markSaved,
    markKnown,
    visual,
    statusRu,
  };
}
