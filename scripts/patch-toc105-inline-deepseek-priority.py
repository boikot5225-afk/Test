from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    s = p.read_text()
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match in {path}, got {count}')
    p.write_text(s.replace(old, new, 1))


# 1) The offline WikDict layer must never overwrite a context-aware result.
replace_once(
    'js/reader/en-unknown-gloss-v2.js',
    '''function setWrapperTranslation(wrap, word, value) {
  const ru = compactRussian(value);
  const node = glossNode(wrap);
  if (!node) return '';
  if (!ru) return String(node.textContent || '').trim();
  node.textContent = ru;
  wrap.dataset.enGlossRu = ru;
  wrap.style.setProperty('--en-gloss-font', glossFontSize(word, ru));
  return ru;
}
''',
    '''function contextProvider(wrap) {
  return String(wrap?.dataset?.enContextProvider || '').trim();
}
function hasContextOverride(wrap) {
  return !!contextProvider(wrap);
}
function setWrapperTranslation(wrap, word, value, options = {}) {
  const ru = compactRussian(value);
  const node = glossNode(wrap);
  if (!node) return '';
  if (!ru) return String(node.textContent || '').trim();
  // Context wins. Once a contextual rule/ML/DeepSeek result is on this exact
  // token, the lemma dictionary is only a fallback and may not paint over it.
  if (!options.force && hasContextOverride(wrap)) return String(node.textContent || '').trim();
  node.textContent = ru;
  wrap.dataset.enGlossRu = ru;
  wrap.style.setProperty('--en-gloss-font', glossFontSize(word, ru));
  return ru;
}
''',
    'guard dictionary against context override',
)

# 2) DeepSeek needs a direct route into the inline gloss for the clicked token.
replace_once(
    'js/reader/en-unknown-gloss-v2.js',
    '''function scheduleScan(delay = 35) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, Math.max(0, Number(delay) || 0));
}
''',
    '''function applyDeepSeekContextGloss(detail = {}) {
  if (currentLang() !== 'en') return 0;
  const root = document.getElementById('reader-chapter-text');
  const translation = compactRussian(detail.ru || detail.translation || detail.meaning || '');
  const targetKey = normalizedKey(detail.word || detail.surface || '');
  if (!root || !translation || !targetKey) return 0;

  const requestedParagraph = Number(detail.paragraphIndex);
  const scopes = Number.isFinite(requestedParagraph)
    ? Array.from(root.querySelectorAll('.reader-paragraph')).filter(p => Number(p.dataset.p) === requestedParagraph)
    : [root];
  let count = 0;
  for (const scope of scopes) {
    for (const el of scope.querySelectorAll('.reader-word[data-word]')) {
      if (!isEnglishWord(el) || knowledge(el) === 'known') continue;
      const surface = String(el.dataset.word || el.textContent || '').trim();
      const lemma = lemmaFor(surface);
      if (normalizedKey(surface) !== targetKey && normalizedKey(lemma) !== targetKey) continue;
      const wrap = ensureWrapper(el);
      const node = glossNode(wrap);
      if (!wrap || !node) continue;
      node.textContent = translation;
      wrap.dataset.enGlossRu = translation;
      wrap.dataset.enContextProvider = 'deepseek-context';
      wrap.dataset.enContextKey = legacyCacheKey(detail.word || surface, detail.context || '');
      wrap.dataset.enGlossVisible = knowledge(el) === 'unknown' ? '1' : '0';
      wrap.style.setProperty('--en-gloss-font', glossFontSize(surface, translation));
      count++;
    }
  }
  return count;
}

function scheduleScan(delay = 35) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, Math.max(0, Number(delay) || 0));
}
''',
    'install DeepSeek inline gloss bridge',
)

replace_once(
    'js/reader/en-unknown-gloss-v2.js',
    '''  window.readerPrepareEnStableSlots = prepareStableSlots;
  window.readerPrefetchEnUnknownGloss = scanNow;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once:true });
''',
    '''  window.readerPrepareEnStableSlots = prepareStableSlots;
  window.readerPrefetchEnUnknownGloss = scanNow;
  window.readerApplyEnglishDeepSeekGloss = applyDeepSeekContextGloss;
  window.addEventListener('reader:en-deepseek-gloss', event => applyDeepSeekContextGloss(event?.detail || {}));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once:true });
''',
    'expose DeepSeek inline gloss bridge',
)

# 3) High-confidence local context rules can refine WikDict, but never override
# a user-triggered DeepSeek result for that same token/context.
replace_once(
    'js/reader/en-context-fixes-v1.js',
    '''    const { wrap, node } = existingGloss(el);
    if (!wrap || !node) continue;
    const surface = String(el.dataset.word || el.textContent || '').trim();
''',
    '''    const { wrap, node } = existingGloss(el);
    if (!wrap || !node) continue;
    if (String(wrap.dataset.enContextProvider || '') === 'deepseek-context') continue;
    const surface = String(el.dataset.word || el.textContent || '').trim();
''',
    'protect DeepSeek from toc103 rule layer',
)

replace_once(
    'js/reader/en-context-gloss-v1.js',
    '''  const { wrap, node } = existingGloss(el);
  if (!wrap || !node) return false;
  const same = String(node.textContent || '').trim() === translated
''',
    '''  const { wrap, node } = existingGloss(el);
  if (!wrap || !node) return false;
  if (String(wrap.dataset.enContextProvider || '') === 'deepseek-context') return false;
  const same = String(node.textContent || '').trim() === translated
''',
    'protect DeepSeek from ML Kit context layer',
)

# 4) Reader word-card DeepSeek publishes both cached and fresh contextual RU to
# the inline layer. This is the missing connection in toc104.
replace_once(
    'js/reader-app.js',
    '''async function readerTranslateWordAI(forceOrOptions = true) {
''',
    '''function readerPublishEnglishContextGloss(word, context, ru) {
  if (readerCurrentLang() !== 'en') return;
  const translation = String(ru || '').trim();
  if (!translation) return;
  try {
    window.dispatchEvent(new CustomEvent('reader:en-deepseek-gloss', {
      detail: { word, context, ru: translation, paragraphIndex: readerSelectedParagraphIndex },
    }));
  } catch {}
}

async function readerTranslateWordAI(forceOrOptions = true) {
''',
    'publish English contextual gloss helper',
)

replace_once(
    'js/reader-app.js',
    '''        readerRenderWordAnalysis(contextualCached, 'context-cache');
        if (st) { st.style.display = 'block'; st.style.color = 'var(--good)'; st.textContent = '⚡ Контекстный перевод из локального кэша'; }
        return contextualCached;
''',
    '''        readerRenderWordAnalysis(contextualCached, 'context-cache');
        readerPublishEnglishContextGloss(
          word,
          context,
          contextualCached.ru || contextualCached.translation_ru || contextualCached.russian || contextualCached.meaning_ru || ''
        );
        if (st) { st.style.display = 'block'; st.style.color = 'var(--good)'; st.textContent = '⚡ Контекстный перевод из локального кэша'; }
        return contextualCached;
''',
    'publish cached context to inline gloss',
)

replace_once(
    'js/reader-app.js',
    '''      readerPutCachedLexical(word, payload, readerCurrentLang());
      if (hasContext) readerPutCachedContextLexical(word, context, payload, readerCurrentLang());
      readerRenderWordAnalysis(payload, 'deepseek');
    }
    // Re-render so the freshly learned pinyin/furigana appears over the token.
''',
    '''      readerPutCachedLexical(word, payload, readerCurrentLang());
      if (hasContext) readerPutCachedContextLexical(word, context, payload, readerCurrentLang());
      readerRenderWordAnalysis(payload, 'deepseek');
    }
    if (sourceLang === 'en' && hasContext) readerPublishEnglishContextGloss(word, context, payload.ru);
    // Re-render so the freshly learned pinyin/furigana appears over the token.
''',
    'publish fresh DeepSeek context to inline gloss',
)

# 5) Bust module caches so the APK/WebView cannot keep toc104 JS alive.
replace_once(
    'js/reader/interactions-runtime.js',
    "import './en-unknown-gloss-v2.js?v=4'; // toc103: no Instant/legacy cache input\n",
    "import './en-unknown-gloss-v2.js?v=5'; // toc105: context/DeepSeek overrides outrank WikDict\n",
    'bust English gloss module',
)
replace_once(
    'js/reader/interactions-runtime.js',
    "import './en-context-gloss-v1.js?v=1'; // toc102: refine ambiguous RU glosses from local context; text-only\n",
    "import './en-context-gloss-v1.js?v=2'; // toc105: never overwrite DeepSeek context; text-only\n",
    'bust context gloss module',
)
replace_once(
    'js/reader/interactions-runtime.js',
    "import './en-context-fixes-v1.js?v=1'; // toc103: high-confidence sense corrections; text-only\n",
    "import './en-context-fixes-v1.js?v=2'; // toc105: DeepSeek context has final priority; text-only\n",
    'bust context fixes module',
)
replace_once(
    'js/app.js',
    "} from './reader-app.js?v=77.33-deepseek-context';\n",
    "} from './reader-app.js?v=77.34-inline-deepseek';\n",
    'bust reader app module',
)
replace_once(
    'index.html',
    '<script type="module" src="js/app.js?v=77.32-deepseek-context"></script>',
    '<script type="module" src="js/app.js?v=77.33-inline-deepseek"></script>',
    'bust app entry module',
)

print('toc105 inline DeepSeek priority patch applied')
