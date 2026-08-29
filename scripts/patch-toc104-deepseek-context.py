from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    s = p.read_text()
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match in {path}, got {count}")
    p.write_text(s.replace(old, new, 1))


# 1) CC-CEDICT English is useful fallback metadata, but it is NOT a Russian
# translation. toc103 wrote it into `ru`, which prevented the intended
# "missing RU -> one DeepSeek request" path from ever firing.
replace_once(
    "js/reader/word-lookup.js",
    """  function chineseOfflineResult(entry) {
    if (!entry || typeof entry !== 'object') return entry || null;
    const ru = String(entry.ru || entry.translation_ru || entry.russian || entry.meaning_ru || '').trim();
    if (ru) return entry;
    const enRaw = entry.en || entry.english || entry.definition || entry.definitions || entry.gloss || '';
    const en = Array.isArray(enRaw) ? enRaw.join('; ') : String(enRaw || '').trim();
    if (!en) return entry;
    // Reader-app historically uses "has Russian meaning" as the signal for
    // whether it should automatically call DeepSeek after a local Chinese hit.
    // With DeepSeek optional/offline-first, an English CC-CEDICT answer is a
    // complete local result too. Put the fallback in the transient `ru` field so
    // that old caller stops there; the word-panel bridge clears the editable RU
    // input immediately, so English can never be accidentally saved as Russian.
    return {
      ...entry,
      ru: `EN: ${en}`,
      _source: 'offline-cedict-en',
      _offlineEnglishFallback: true,
    };
  }
""",
    """  function chineseOfflineResult(entry) {
    if (!entry || typeof entry !== 'object') return entry || null;
    const ru = String(entry.ru || entry.translation_ru || entry.russian || entry.meaning_ru || '').trim();
    if (ru) return entry;
    const enRaw = entry.en || entry.english || entry.definition || entry.definitions || entry.gloss || '';
    const en = Array.isArray(enRaw) ? enRaw.join('; ') : String(enRaw || '').trim();
    if (!en) return entry;
    // English remains a cheap offline hint, never a fake Russian translation.
    // reader-app therefore sees "no RU" and asks DeepSeek exactly once; the
    // resulting Russian value is cached and subsequent taps stay local.
    return {
      ...entry,
      en,
      english: entry.english || en,
      _source: entry._source || 'offline-cedict-en',
      _offlineEnglishFallback: true,
    };
  }
""",
    "CC-CEDICT RU fallback",
)


# 2) Context-specific DeepSeek values share the already durable, bounded
# lexical cache, but use a key that cannot collide with the normal word entry.
replace_once(
    "js/reader-app.js",
    """function readerPutCachedLexical(word, data, lang = null) {
  if (!word || !data) return;
  const cache = loadReaderLexicalCache();
  const l = readerCanonicalLang(lang || data.lang || readerCurrentLang());
  cache[readerLexicalCacheKey(word, l)] = { ...data, lang: l, cachedAt: new Date().toISOString() };
  saveReaderLexicalCache();
}
""",
    """function readerPutCachedLexical(word, data, lang = null) {
  if (!word || !data) return;
  const cache = loadReaderLexicalCache();
  const l = readerCanonicalLang(lang || data.lang || readerCurrentLang());
  cache[readerLexicalCacheKey(word, l)] = { ...data, lang: l, cachedAt: new Date().toISOString() };
  saveReaderLexicalCache();
}

function readerNormalizeLexicalContext(context) {
  return String(context || '').replace(/\\s+/g, ' ').trim();
}

function readerContextLexicalCacheKey(word, context, lang = null) {
  const cleanContext = readerNormalizeLexicalContext(context);
  if (!word || !cleanContext) return '';
  const base = readerLexicalCacheKey(word, lang);
  return `ctx|${base}|${readerHashString(cleanContext)}_${cleanContext.length}`;
}

function readerGetCachedContextLexical(word, context, lang = null) {
  const key = readerContextLexicalCacheKey(word, context, lang);
  return key ? loadReaderLexicalCache()[key] || null : null;
}

function readerPutCachedContextLexical(word, context, data, lang = null) {
  const key = readerContextLexicalCacheKey(word, context, lang);
  if (!key || !data) return;
  const cache = loadReaderLexicalCache();
  const l = readerCanonicalLang(lang || data.lang || readerCurrentLang());
  cache[key] = {
    ...data,
    lang: l,
    _contextual: true,
    context: readerNormalizeLexicalContext(context),
    cachedAt: new Date().toISOString(),
  };
  saveReaderLexicalCache();
}
""",
    "context lexical cache helpers",
)


# 3) Reopening the same word in the same sentence uses its contextual override
# immediately, with zero network request.
replace_once(
    "js/reader-app.js",
    """  readerRenderWordLoading('⏳ Проверяю словарь и формы...');

  try {
    const found = await readerLookupWord(readerSelectedWord);
""",
    """  readerRenderWordLoading('⏳ Проверяю словарь и формы...');

  try {
    const contextualCached = readerGetCachedContextLexical(readerSelectedWord, sentContext, activeLang);
    if (contextualCached && readerHasRussianMeaning(contextualCached)) {
      readerRenderWordAnalysis(contextualCached, 'context-cache');
      if (st) {
        st.style.display = 'block';
        st.style.color = 'var(--good)';
        st.textContent = '⚡ Контекстный перевод из локального кэша';
      }
      return;
    }

    const found = await readerLookupWord(readerSelectedWord);
""",
    "open-word context cache priority",
)


# 4) Compute context before any AI/cache decision and lock the manual button for
# the duration. The in-flight map below is a second line of defence.
replace_once(
    "js/reader-app.js",
    """  const st = panel.querySelector('#reader-word-status');
  const contextEl = panel.querySelector('#reader-word-context');

  try {
    if (!word) throw new Error('Слово не выбрано');

    if (force) {
""",
    """  const st = panel.querySelector('#reader-word-status');
  const contextEl = panel.querySelector('#reader-word-context');
  const aiBtn = panel.querySelector('button[onclick="readerTranslateWordAI(true)"]');
  let context = '';
  let aiButtonWasDisabled = false;

  try {
    if (!word) throw new Error('Слово не выбрано');
    context = readerNormalizeLexicalContext(
      contextEl?.value || readerSentenceContext(readerCurrentParagraphText(readerSelectedParagraphIndex), word, readerCurrentLang())
    );
    if (aiBtn) {
      aiButtonWasDisabled = !!aiBtn.disabled;
      aiBtn.disabled = true;
      aiBtn.textContent = '⏳ DeepSeek';
    }

    if (force) {
""",
    "AI button/context header",
)

replace_once(
    "js/reader-app.js",
    """    } else if (st) {
      st.style.display = 'block'; st.style.color = 'var(--accent)'; st.textContent = skipLocal ? '⏳ DeepSeek добирает русский смысл...' : '⏳ DeepSeek готовит разбор...';
    }

    if (!force && !skipLocal) {
""",
    """    } else if (st) {
      st.style.display = 'block'; st.style.color = 'var(--accent)'; st.textContent = skipLocal ? '⏳ DeepSeek добирает русский смысл...' : '⏳ DeepSeek готовит разбор...';
    }

    if (!force) {
      const contextualCached = readerGetCachedContextLexical(word, context, readerCurrentLang());
      if (contextualCached && readerHasRussianMeaning(contextualCached)) {
        readerRenderWordAnalysis(contextualCached, 'context-cache');
        if (st) { st.style.display = 'block'; st.style.color = 'var(--good)'; st.textContent = '⚡ Контекстный перевод из локального кэша'; }
        return contextualCached;
      }
    }

    if (!force && !skipLocal) {
""",
    "AI contextual cache hit",
)

replace_once(
    "js/reader-app.js",
    """    const context = contextEl?.value || readerSentenceContext(readerCurrentParagraphText(readerSelectedParagraphIndex), word, readerCurrentLang());
    const sourceLang = readerCurrentLang();
""",
    """    const sourceLang = readerCurrentLang();
""",
    "remove late context declaration",
)

replace_once(
    "js/reader-app.js",
    """    if (!force && readerLexicalInFlight.has(inFlightKey)) {
      data = await readerLexicalInFlight.get(inFlightKey);
""",
    """    if (readerLexicalInFlight.has(inFlightKey)) {
      data = await readerLexicalInFlight.get(inFlightKey);
""",
    "force in-flight reuse",
)

replace_once(
    "js/reader-app.js",
    """      if (!force) readerLexicalInFlight.set(inFlightKey, p);
""",
    """      readerLexicalInFlight.set(inFlightKey, p);
""",
    "force in-flight registration",
)

replace_once(
    "js/reader-app.js",
    """    readerPutCachedLexical(word, payload, readerCurrentLang());
    readerRenderWordAnalysis(payload, 'deepseek');
    // Re-render so the freshly learned pinyin/furigana appears over the token.
""",
    """    const hasContext = !!readerNormalizeLexicalContext(context);
    if (force && hasContext) {
      readerPutCachedContextLexical(word, context, payload, readerCurrentLang());
      readerRenderWordAnalysis(payload, 'deepseek-context');
    } else {
      readerPutCachedLexical(word, payload, readerCurrentLang());
      if (hasContext) readerPutCachedContextLexical(word, context, payload, readerCurrentLang());
      readerRenderWordAnalysis(payload, 'deepseek');
    }
    // Re-render so the freshly learned pinyin/furigana appears over the token.
""",
    "separate generic/context AI cache writes",
)

replace_once(
    "js/reader-app.js",
    """      st.textContent = pos === 'verb'
        ? `✅ Глагольная форма: ${payload.lemma}`
        : pos === 'noun'
          ? `✅ Существительное${payload.gender ? ', род: ' + payload.gender : ''}`
          : `✅ ${readerPosRu(pos)}`;
""",
    """      st.textContent = force && hasContext
        ? '✅ Новый перевод сохранён только для этого контекста'
        : pos === 'verb'
          ? `✅ Глагольная форма: ${payload.lemma}`
          : pos === 'noun'
            ? `✅ Существительное${payload.gender ? ', род: ' + payload.gender : ''}`
            : `✅ ${readerPosRu(pos)}`;
""",
    "context success status",
)

replace_once(
    "js/reader-app.js",
    """    const localFallback = skipLocal ? (readerLookupChineseWord(word) || readerLookupJapaneseWord(word)) : null;
    if (localFallback) readerRenderWordAnalysis(localFallback, 'local');
    else readerRenderWordError('DeepSeek не сработал: ' + msg);
""",
    """    const cachedFallback = readerGetCachedContextLexical(word, context, readerCurrentLang()) || readerGetCachedLexical(word, readerCurrentLang());
    const localFallback = cachedFallback || (skipLocal ? (readerLookupChineseWord(word) || readerLookupJapaneseWord(word)) : null);
    if (localFallback) readerRenderWordAnalysis(localFallback, cachedFallback ? 'context-cache' : 'local');
    else readerRenderWordError('DeepSeek не сработал: ' + msg);
""",
    "AI failure fallback",
)

replace_once(
    "js/reader-app.js",
    """    throw e;
  }
}


// ── Reader window exports ──
""",
    """    throw e;
  } finally {
    if (aiBtn) {
      aiBtn.disabled = aiButtonWasDisabled;
      aiBtn.textContent = '↻ DeepSeek';
    }
  }
}


// ── Reader window exports ──
""",
    "AI button finally",
)


# Cache-bust the changed reader modules.
replace_once(
    "js/reader-app.js",
    "import { createReaderWordLookup } from './reader/word-lookup.js?v=1';",
    "import { createReaderWordLookup } from './reader/word-lookup.js?v=2-deepseek-fallback';",
    "word lookup cache bust",
)
replace_once(
    "js/app.js",
    "} from './reader-app.js?v=77.32';",
    "} from './reader-app.js?v=77.33-deepseek-context';",
    "reader-app cache bust",
)
replace_once(
    "index.html",
    '<script type="module" src="js/app.js?v=77.31"></script>',
    '<script type="module" src="js/app.js?v=77.32-deepseek-context"></script>',
    "app cache bust",
)
replace_once(
    "index.html",
    "window.AN2_BUILD = 'v77.41-no-block';",
    "window.AN2_BUILD = 'v77.42-toc104-deepseek-context';",
    "build marker",
)


# 5) Context is an explicit lexical constraint in the server prompt.
replace_once(
    "functions/index.js",
    "Rules: pinyin must use tone marks; ru must be short and natural Russian; if the token is a name or place, mark proper_noun; do not invent grammar essays.",
    "Rules: pinyin must use tone marks; ru must be the short natural Russian meaning of TOKEN AS USED IN THIS SPECIFIC CONTEXT, not merely its most common dictionary sense. If TOKEN is part of a fixed expression, idiom, resultative/compound verb, or the surrounding words change its sense, translate that contextual sense and briefly name the expression in note. If CONTEXT is empty, use the most useful short dictionary meaning. If the token is a name or place, mark proper_noun; do not invent grammar essays.",
    "Chinese contextual prompt",
)

print("toc104 source patch applied")
