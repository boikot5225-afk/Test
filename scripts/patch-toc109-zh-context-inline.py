from pathlib import Path

# toc109: the word panel already reads ctx|zh:<word>|<sentence-hash> entries,
# but the interlinear Unknown-word layer only checked zh:<word>. That made a
# cached context translation such as 高层 -> "высшее руководство" lose to a
# stale generic lexical gloss such as "Высотных" on the reading page.

p = Path('js/reader/zh-unknown-gloss-v4.js')
s = p.read_text()

old = "const READER_APP_URL = '../reader-app.js?v=77.32';"
assert s.count(old) == 1
s = s.replace(old, "const READER_APP_URL = '../reader-app.js?v=77.38-zh-context-inline';", 1)

old = r'''function normalizeContext(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 260);
}
'''
new = r'''function normalizeParagraphContext(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeContext(value) {
  // Legacy zh-unknown-gloss cache keys intentionally keep the old 260-char
  // cap. The Reader lexical context cache below uses the exact sentence and
  // must not inherit that truncation.
  return normalizeParagraphContext(value).slice(0, 260);
}
'''
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = r'''function lexicalEntry(word, cache = null) {
  const source = cache || lexicalCache();
  return source[`zh:${normalizeImportKey(word)}`] || null;
}
'''
new = r'''function lexicalEntry(word, cache = null) {
  const source = cache || lexicalCache();
  return source[`zh:${normalizeImportKey(word)}`] || null;
}

function sentenceContext(paragraphText, word) {
  const clean = normalizeParagraphContext(paragraphText);
  if (!clean) return '';
  const sentences = clean.match(/[^.!?…。！？]+[.!?…。！？»”"]*|[^.!?…。！？]+$/g) || [clean];
  const normalizedWord = String(word || '').trim();
  const found = normalizedWord
    ? sentences.find(sentence => String(sentence || '').includes(normalizedWord))
    : null;
  return String(found || sentences[0] || clean).trim();
}

function contextLexicalKey(word, paragraphText) {
  const cleanContext = sentenceContext(paragraphText, word);
  const normalizedWord = normalizeImportKey(word);
  if (!normalizedWord || !cleanContext) return '';
  // Exact mirror of readerContextLexicalCacheKey() in reader-app.js for zh.
  return `ctx|zh:${normalizedWord}|${textHash(cleanContext)}_${cleanContext.length}`;
}

function contextLexicalEntry(word, paragraphText, cache = null) {
  const source = cache || lexicalCache();
  const key = contextLexicalKey(word, paragraphText);
  return key ? source[key] || null : null;
}
'''
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = "  source = normalizeContext(source);\n"
assert s.count(old) == 1
s = s.replace(old, "  source = normalizeParagraphContext(source);\n", 1)

old = r'''function bestHint(word, context, existingPinyin = '', own = null, lexical = null, instant = null) {
  const oldContextHit = (own || ownCache())[cacheKey(word, context)] || null;
  const lexHit = lexicalEntry(word, lexical);
  const instantHit = instantEntry(word, instant);
  const localHit = localDictionaryHint(word);

  const pinyin = pinyinReading(oldContextHit)
    || pinyinReading(lexHit)
    || pinyinReading(localHit)
    || existingPinyin
    || '';

  const ru = russianMeaning(instantHit)
    || russianMeaning(oldContextHit)
    || russianMeaning(lexHit)
    || russianMeaning(localHit)
    || '';

  const en = englishMeaning(localHit)
    || englishMeaning(lexHit)
    || englishMeaning(oldContextHit)
    || '';

  const gloss = ru;
  const source = ru ? 'ru' : '';
  return { pinyin, ru, en, gloss, source, local: localHit };
}
'''
new = r'''function bestHint(word, context, existingPinyin = '', own = null, lexical = null, instant = null) {
  const oldContextHit = (own || ownCache())[cacheKey(word, context)] || null;
  const contextLexHit = contextLexicalEntry(word, context, lexical);
  const lexHit = lexicalEntry(word, lexical);
  const instantHit = instantEntry(word, instant);
  const localHit = localDictionaryHint(word);

  // Context lexical entries are the same cached results the word sheet shows.
  // They outrank generic zh:<word> entries for both polyphonic pinyin and RU.
  const pinyin = pinyinReading(contextLexHit)
    || pinyinReading(oldContextHit)
    || pinyinReading(lexHit)
    || pinyinReading(localHit)
    || existingPinyin
    || '';

  const instantRu = russianMeaning(instantHit);
  const contextRu = russianMeaning(contextLexHit);
  const oldContextRu = russianMeaning(oldContextHit);
  const lexicalRu = russianMeaning(lexHit);
  const localRu = russianMeaning(localHit);
  const ru = instantRu || contextRu || oldContextRu || lexicalRu || localRu || '';

  const en = englishMeaning(contextLexHit)
    || englishMeaning(localHit)
    || englishMeaning(lexHit)
    || englishMeaning(oldContextHit)
    || '';

  const gloss = ru;
  const source = instantRu ? 'instant'
    : contextRu ? 'context-cache'
      : oldContextRu ? 'legacy-context-cache'
        : lexicalRu ? 'lexical-cache'
          : localRu ? 'local' : '';
  return { pinyin, ru, en, gloss, source, local: localHit, contextual: contextLexHit };
}
'''
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = "export { mode, enabled, compactGloss, cacheKey, knowledgeState };"
assert s.count(old) == 1
s = s.replace(old, "export { mode, enabled, compactGloss, cacheKey, knowledgeState, sentenceContext, contextLexicalKey, contextLexicalEntry, bestHint };", 1)
p.write_text(s)

# Cache-bust the module chain all the way to reader-app so the installed APK
# cannot keep toc108's already-cached annotation module alive.
replacements = [
    ('js/reader/interactions-runtime.js', "./zh-unknown-gloss-v4.js?v=3", "./zh-unknown-gloss-v4.js?v=4-context-lexical"),
    ('js/reader/chapter-render-next.js', "./interactions-runtime.js?v=2", "./interactions-runtime.js?v=3-zh-context-inline"),
    ('js/reader/chapter-render-stage1.js', "./chapter-render-next.js?v=14", "./chapter-render-next.js?v=15-zh-context-inline"),
    ('js/reader/chapter-render-dialogue.js', "./chapter-render-stage1.js?v=12", "./chapter-render-stage1.js?v=13-zh-context-inline"),
    ('js/reader/chapter-render.js', "./chapter-render-dialogue.js?v=10", "./chapter-render-dialogue.js?v=11-zh-context-inline"),
    ('js/reader-app.js', "./reader/chapter-render.js?v=12", "./reader/chapter-render.js?v=13-zh-context-inline"),
    ('js/app.js', 'reader-app.js?v=77.37-page-zh-seg', 'reader-app.js?v=77.38-zh-context-inline'),
    ('index.html', 'js/app.js?v=77.36-page-zh-seg', 'js/app.js?v=77.37-zh-context-inline'),
]
for path, old, new in replacements:
    p = Path(path)
    text = p.read_text()
    assert text.count(old) == 1, (path, old, text.count(old))
    p.write_text(text.replace(old, new, 1))

print('toc109 contextual Chinese inline gloss patch applied')
