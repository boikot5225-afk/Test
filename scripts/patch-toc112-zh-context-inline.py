from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    s = p.read_text()
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match in {path}, got {count}')
    p.write_text(s.replace(old, new, 1))


# 1) Chinese had no equivalent of the English word-card -> inline-context bridge.
# Publish the exact cached/fresh card result and expose a read-through helper so
# a chapter rebuild after Known/Unknown does not lose the contextual translation.
english_publisher = '''function readerPublishEnglishContextGloss(word, context, ru) {
  if (readerCurrentLang() !== 'en') return;
  const translation = String(ru || '').trim();
  if (!translation) return;
  try {
    window.dispatchEvent(new CustomEvent('reader:en-deepseek-gloss', {
      detail: { word, context, ru: translation, paragraphIndex: readerSelectedParagraphIndex },
    }));
  } catch {}
}
'''
chinese_bridge = english_publisher + '''
function readerPublishChineseContextGloss(word, context, ru) {
  if (readerCurrentLang() !== 'zh') return;
  const translation = String(ru || '').trim();
  if (!translation) return;
  try {
    window.dispatchEvent(new CustomEvent('reader:zh-context-gloss', {
      detail: { word, context, ru: translation, paragraphIndex: readerSelectedParagraphIndex },
    }));
  } catch {}
}

function readerGetCachedChineseContextRuForInline(word, paragraphIndex = readerSelectedParagraphIndex) {
  const surface = String(word || '').trim();
  if (!surface) return '';
  const numericIndex = Number(paragraphIndex);
  const index = Number.isFinite(numericIndex) ? numericIndex : readerSelectedParagraphIndex;
  const paragraph = readerCurrentParagraphText(index);
  const context = readerSentenceContext(paragraph, surface, 'zh');
  if (!context) return '';
  const cached = readerGetCachedContextLexical(surface, context, 'zh');
  return String(
    cached?.ru || cached?.translation_ru || cached?.russian || cached?.meaning_ru || cached?.translation || ''
  ).trim();
}
try { window.readerGetCachedChineseContextRuForInline = readerGetCachedChineseContextRuForInline; } catch {}
'''
replace_once('js/reader-app.js', english_publisher, chinese_bridge, 'add Chinese context publisher/read-through')

# Opening a word card may return from the context cache before readerTranslateWordAI
# runs. That exact path caused the screenshot: card changed, inline text did not.
old_open_cache = '''    if (contextualCached && readerHasRussianMeaning(contextualCached)) {
      readerRenderWordAnalysis(contextualCached, 'context-cache');
      if (st) {
        st.style.display = 'block';
        st.style.color = 'var(--good)';
        st.textContent = '⚡ Контекстный перевод из локального кэша';
      }
      return;
    }
'''
new_open_cache = '''    if (contextualCached && readerHasRussianMeaning(contextualCached)) {
      readerRenderWordAnalysis(contextualCached, 'context-cache');
      const inlineRu = contextualCached.ru || contextualCached.translation_ru || contextualCached.russian || contextualCached.meaning_ru || contextualCached.translation || '';
      readerPublishEnglishContextGloss(readerSelectedWord, sentContext, inlineRu);
      readerPublishChineseContextGloss(readerSelectedWord, sentContext, inlineRu);
      if (st) {
        st.style.display = 'block';
        st.style.color = 'var(--good)';
        st.textContent = '⚡ Контекстный перевод из локального кэша';
      }
      return;
    }
'''
replace_once('js/reader-app.js', old_open_cache, new_open_cache, 'publish panel-open cached context')

# The explicit DeepSeek/cache path already published English; make Chinese symmetric.
old_cached_publish = '''        readerPublishEnglishContextGloss(
          word,
          context,
          contextualCached.ru || contextualCached.translation_ru || contextualCached.russian || contextualCached.meaning_ru || ''
        );
        if (st) { st.style.display = 'block'; st.style.color = 'var(--good)'; st.textContent = '⚡ Контекстный перевод из локального кэша'; }
'''
new_cached_publish = '''        const inlineRu = contextualCached.ru || contextualCached.translation_ru || contextualCached.russian || contextualCached.meaning_ru || contextualCached.translation || '';
        readerPublishEnglishContextGloss(word, context, inlineRu);
        readerPublishChineseContextGloss(word, context, inlineRu);
        if (st) { st.style.display = 'block'; st.style.color = 'var(--good)'; st.textContent = '⚡ Контекстный перевод из локального кэша'; }
'''
replace_once('js/reader-app.js', old_cached_publish, new_cached_publish, 'publish translated cached Chinese context')

old_fresh_publish = "    if (sourceLang === 'en' && hasContext) readerPublishEnglishContextGloss(word, context, payload.ru);\n"
new_fresh_publish = old_fresh_publish + "    if (sourceLang === 'zh' && hasContext) readerPublishChineseContextGloss(word, context, payload.ru);\n"
replace_once('js/reader-app.js', old_fresh_publish, new_fresh_publish, 'publish fresh Chinese context')

# Make manual Unknown explicit instead of relying on the legacy problem/hard inference.
# This also eliminates a transient classifier race during the chapter repaint.
replace_once(
    'js/reader-app.js',
    "  st.status = 'problem';\n  st.updatedAt = new Date().toISOString();\n",
    "  st.status = 'problem';\n  st.manualKnowledge = 'unknown';\n  st.updatedAt = new Date().toISOString();\n  st.manualKnowledgeAt = st.updatedAt;\n",
    'explicit manual Unknown sentinel',
)

# 2) The readable Chinese inline layer now reads the same contextual cache as the
# card. context-ai from the dedicated paragraph batch remains highest priority;
# card context beats dictionary/ML Kit fallbacks.
old_local_ru = '''function localRussian(wrap, word) {
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
'''
new_local_ru = '''function cachedPanelContextRussian(wrap, word) {
  const stored = compactRussian(wrap?.dataset?.zhGlossContextRu || '');
  if (stored) return stored;
  const surface = clean(word?.dataset?.word || '');
  if (!surface) return '';
  const paragraphIndex = Number(word?.closest?.('.reader-paragraph')?.dataset?.p);
  try {
    const value = compactRussian(globalThis.readerGetCachedChineseContextRuForInline?.(surface, paragraphIndex) || '');
    if (!value) return '';
    wrap.dataset.zhGlossContextRu = value;
    if (String(wrap.dataset.zhGlossSource || '') !== 'context-ai') {
      wrap.dataset.zhGlossStickyRu = value;
      wrap.dataset.zhGlossSource = 'context-panel';
    }
    return value;
  } catch {
    return '';
  }
}

function localRussian(wrap, word) {
  // Dedicated paragraph context AI is the final authority when it has already
  // resolved this occurrence.
  if (String(wrap?.dataset?.zhGlossSource || '') === 'context-ai') {
    const contextual = compactRussian(wrap?.dataset?.zhGlossStickyRu || wrap?.dataset?.zhGlossRuReadable || wrap?.dataset?.zhGlossRu || '');
    if (contextual) return contextual;
  }

  const cardContext = cachedPanelContextRussian(wrap, word);
  if (cardContext) return cardContext;

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
'''
replace_once('js/reader/zh-readable-inline.js', old_local_ru, new_local_ru, 'prioritize word-card context in Chinese inline')

schedule_anchor = '''function schedule(delay = 0) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(syncAll, delay);
}
'''
apply_context = '''function applyPanelContextGloss(detail = {}) {
  if (!enabled()) return 0;
  const root = document.getElementById('reader-chapter-text');
  const target = clean(detail.word || detail.surface || '');
  const translation = compactRussian(detail.ru || detail.translation || detail.meaning || '');
  if (!root || !target || !translation) return 0;

  const requestedParagraph = Number(detail.paragraphIndex);
  const scopes = Number.isFinite(requestedParagraph)
    ? Array.from(root.querySelectorAll('.reader-paragraph')).filter(p => Number(p.dataset.p) === requestedParagraph)
    : [root];
  let changed = 0;
  for (const scope of scopes) {
    for (const word of scope.querySelectorAll('.reader-word[data-lang="zh"][data-word]')) {
      const surface = clean(word.dataset.word || word.textContent || '');
      if (surface !== target) continue;
      const wrap = word.parentElement?.classList?.contains('rw-zh-gloss-wrap') ? word.parentElement : null;
      if (!wrap) continue;
      // Never downgrade the dedicated paragraph-context engine. Otherwise the
      // card cache is the best known answer and must replace stale ML Kit text.
      if (String(wrap.dataset.zhGlossSource || '') !== 'context-ai') {
        wrap.dataset.zhGlossContextRu = translation;
        wrap.dataset.zhGlossStickyRu = translation;
        wrap.dataset.zhGlossSource = 'context-panel';
        if (wordState(word) === 'unknown') setLane(wrap, word, localPinyin(wrap, word), translation);
      }
      changed += 1;
    }
  }
  schedule(0);
  return changed;
}

'''
replace_once('js/reader/zh-readable-inline.js', schedule_anchor, apply_context + schedule_anchor, 'install Chinese panel-context receiver')

old_listeners = '''  window.addEventListener('reader-instant-word-translation', () => schedule(15));
  window.addEventListener('reader:chromechange', () => schedule(15));
'''
new_listeners = '''  window.addEventListener('reader-instant-word-translation', () => schedule(15));
  window.addEventListener('reader:zh-context-gloss', event => applyPanelContextGloss(event?.detail || {}));
  window.addEventListener('reader:chromechange', () => schedule(15));
'''
replace_once('js/reader/zh-readable-inline.js', old_listeners, new_listeners, 'listen for Chinese context card updates')

# 3) The raw Chinese->Russian ML Kit fallback used to overwrite any source except
# context-ai. It must also respect card context and the persistent context cache.
apply_anchor = '''function applyToWrap(wrap, ru) {
  if (!wrap?.isConnected) return false;
'''
context_guard = '''function contextOverrideRu(wrap) {
  const source = String(wrap?.dataset?.zhGlossSource || '');
  const explicit = compactRu(wrap?.dataset?.zhGlossContextRu || '');
  if (explicit) return explicit;
  if ((source === 'context-ai' || source === 'context-panel') && compactRu(wrap?.dataset?.zhGlossStickyRu)) {
    return compactRu(wrap.dataset.zhGlossStickyRu);
  }
  const word = wrap?.querySelector?.(':scope > .reader-word[data-word]');
  const surface = clean(word?.dataset?.word || word?.textContent || '', 32);
  const paragraphIndex = Number(word?.closest?.('.reader-paragraph')?.dataset?.p);
  if (!surface) return '';
  try {
    return compactRu(globalThis.readerGetCachedChineseContextRuForInline?.(surface, paragraphIndex) || '');
  } catch {
    return '';
  }
}

function hasContextOverride(wrap) {
  return !!contextOverrideRu(wrap);
}

'''
replace_once('js/reader/zh-direct-ru-fallback.js', apply_anchor, context_guard + apply_anchor, 'install ML Kit context guard')
replace_once(
    'js/reader/zh-direct-ru-fallback.js',
    "  if (wrap.dataset.zhGlossSource === 'context-ai' && compactRu(wrap.dataset.zhGlossStickyRu)) {\n    return false;\n  }\n",
    "  if (hasContextOverride(wrap)) return false;\n",
    'protect applyToWrap from context overwrite',
)
replace_once(
    'js/reader/zh-direct-ru-fallback.js',
    "    if (item.wrap.dataset.zhGlossSource === 'context-ai' && compactRu(item.wrap.dataset.zhGlossStickyRu)) continue;\n",
    "    if (hasContextOverride(item.wrap)) continue;\n",
    'protect queued ML Kit from context overwrite',
)

# 4) Cache bust every module in the path. Android WebView survives app upgrades
# aggressively enough that changing only the APK version is not sufficient.
replace_once(
    'js/reader/interactions-runtime.js',
    "import './zh-readable-inline.js?v=6';\n",
    "import './zh-readable-inline.js?v=7-context-card';\n",
    'bust Chinese readable inline module',
)
replace_once(
    'js/reader/interactions-runtime.js',
    "import './zh-direct-ru-fallback.js?v=1'; // toc100: direct on-device Chinese -> Russian for every visible Unknown\n",
    "import './zh-direct-ru-fallback.js?v=2-context-priority'; // context card/batch outrank raw ML Kit\n",
    'bust Chinese direct RU module',
)
replace_once(
    'js/app.js',
    "} from './reader-app.js?v=77.36-zh-segmentation';\n",
    "} from './reader-app.js?v=77.37-zh-context-inline';\n",
    'bust reader app module',
)
replace_once(
    'index.html',
    "window.AN2_BUILD = 'v77.42-toc107-zh-segmentation';",
    "window.AN2_BUILD = 'v77.42-toc112-zh-context-inline';",
    'bump build marker',
)
replace_once(
    'index.html',
    '<script type="module" src="js/app.js?v=77.35-zh-segmentation"></script>',
    '<script type="module" src="js/app.js?v=77.36-zh-context-inline"></script>',
    'bust app entry module',
)

print('toc112 Chinese context -> inline bridge applied')
