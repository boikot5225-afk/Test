from pathlib import Path

p = Path('js/reader/zh-unknown-gloss.js')
s = p.read_text('utf-8')

s = s.replace("const MAX_CACHE = 1200;\nconst MAX_CONCURRENT = 2;\nconst MAX_ENRICH_VISIBLE = 12;", "const MAX_CACHE = 2600;\nconst MAX_CONCURRENT = 4;\nconst MAX_ENRICH_CURRENT_PAGE = 28;\nconst MAX_ENRICH_PREFETCH = 56;\nconst PREFETCH_PAGE_COUNT = 2;\nconst MAX_QUEUE = 96;")
s = s.replace("const paragraphSourceText = new WeakMap();", "const paragraphSourceText = new WeakMap();\nconst liveWrappersByKey = new Map();")

needle = """function wrapperFor(el) {\n  const parent = el?.parentElement;\n  return parent?.classList?.contains('rw-zh-gloss-wrap') ? parent : null;\n}\n"""
replacement = needle + """\nfunction registerLiveWrapper(key, wrap) {\n  if (!key || !wrap) return;\n  let set = liveWrappersByKey.get(key);\n  if (!set) {\n    set = new Set();\n    liveWrappersByKey.set(key, set);\n  }\n  set.add(wrap);\n  wrap.dataset.zhGlossKey = key;\n}\n"""
if needle not in s:
    raise SystemExit('wrapperFor anchor not found')
s = s.replace(needle, replacement, 1)

start = s.index('function updateVisibleWord(')
end = s.index('\n\nasync function callReaderWord', start)
s = s[:start] + """function updateVisibleWord(word, context, data = {}) {\n  if (!enabled()) return;\n  const expectedKey = cacheKey(word, context);\n  const wraps = liveWrappersByKey.get(expectedKey);\n  if (!wraps?.size) return;\n  const pinyin = pinyinReading(data);\n  const ru = compactRussian(russianMeaning(data));\n  for (const wrap of [...wraps]) {\n    if (!wrap?.isConnected) {\n      wraps.delete(wrap);\n      continue;\n    }\n    if (pinyin) wrap.dataset.zhGlossPinyin = pinyin;\n    if (ru) wrap.dataset.zhGlossRu = ru;\n  }\n  if (!wraps.size) liveWrappersByKey.delete(expectedKey);\n}\n""" + s[end:]

start = s.index('function enqueueEnrichment(')
end = s.index('\n\nfunction pumpQueue()', start)
s = s[:start] + """function enqueueEnrichment(word, context, fallbackPinyin = '', lexicalEntry = null, priority = 1) {\n  if (!enabled() || !word || !context) return;\n  const key = cacheKey(word, context);\n  const own = loadOwnCache()[key];\n  if (own && russianMeaning(own)) return;\n  if (russianMeaning(lexicalEntry || existingLexical(word))) return;\n  if (queuedKeys.has(key)) return;\n  const failed = Number(failedAt.get(key) || 0);\n  if (failed && Date.now() - failed < RETRY_AFTER_MS) return;\n  if (queue.length >= MAX_QUEUE && priority > 0) return;\n\n  queuedKeys.add(key);\n  const job = { key, word, context, fallbackPinyin, priority };\n  const insertAt = queue.findIndex((item) => Number(item.priority || 0) > priority);\n  if (insertAt === -1) queue.push(job);\n  else queue.splice(insertAt, 0, job);\n  pumpQueue();\n}\n""" + s[end:]

scan_start = s.index('function scan() {')
scan_end = s.index('\n\nfunction installObservers()', scan_start)
new_scan = r'''function scan() {
  syncControl();
  if (!enabled()) return;
  const view = document.getElementById('reader-reading-view');
  const root = document.getElementById('reader-chapter-text');
  if (!view || !root || view.dataset.readerLang !== 'zh') return;

  root.querySelectorAll('.reader-paragraph').forEach((paragraph) => {
    if (!paragraphSourceText.has(paragraph)) {
      const source = String(paragraph.querySelector('.reader-paragraph-text')?.textContent || paragraph.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
      paragraphSourceText.set(paragraph, source);
    }
  });

  const ownCache = loadOwnCache();
  const lexicalCache = readJson(scopedKey('an2_reader_lexical_cache_v1'));
  const pages = Array.from(root.querySelectorAll(':scope > .rd-page'));
  let currentPageIndex = pages.findIndex((page) =>
    page.classList.contains('rd-page-current') || page.classList.contains('rd-page-show'));
  if (currentPageIndex < 0) currentPageIndex = 0;

  const pageMode = pages.length > 0;
  const scopes = pageMode
    ? pages.slice(currentPageIndex, currentPageIndex + PREFETCH_PAGE_COUNT + 1)
    : [root];

  let queuedCurrent = 0;
  let queuedPrefetch = 0;

  for (let scopeIndex = 0; scopeIndex < scopes.length; scopeIndex++) {
    const scope = scopes[scopeIndex];
    const words = Array.from(scope.querySelectorAll('.reader-word[data-lang="zh"]'));
    for (const el of words) {
      if (!isChineseWordElement(el)) continue;
      const word = String(el.dataset.word || '').trim();
      const context = getParagraphContext(el);
      const key = cacheKey(word, context);
      const existingRt = String(el.querySelector('rt')?.textContent || '').trim();
      const lexicalEntry = existingLexical(word, lexicalCache);
      const hint = bestCachedHint(word, context, existingRt, ownCache, lexicalCache);
      const wrap = ensureWrapper(el, hint);
      if (!wrap) continue;
      registerLiveWrapper(key, wrap);

      if (hint.pinyin) wrap.dataset.zhGlossPinyin = hint.pinyin;
      if (hint.ru) wrap.dataset.zhGlossRu = compactRussian(hint.fullRu || hint.ru);
      if (hint.ru) continue;

      if (pageMode) {
        if (scopeIndex === 0) {
          if (queuedCurrent >= MAX_ENRICH_CURRENT_PAGE) continue;
          queuedCurrent++;
          enqueueEnrichment(word, context, hint.pinyin || existingRt, lexicalEntry, 0);
        } else {
          if (queuedPrefetch >= MAX_ENRICH_PREFETCH) continue;
          queuedPrefetch++;
          enqueueEnrichment(word, context, hint.pinyin || existingRt, lexicalEntry, scopeIndex);
        }
      } else if (queuedCurrent < MAX_ENRICH_CURRENT_PAGE && isVisibleWord(el)) {
        queuedCurrent++;
        enqueueEnrichment(word, context, hint.pinyin || existingRt, lexicalEntry, 0);
      }
    }
  }
}
'''
s = s[:scan_start] + new_scan + s[scan_end:]
p.write_text(s, 'utf-8')

runtime = Path('js/reader/interactions-runtime.js')
r = runtime.read_text('utf-8')
if "import './zh-unknown-gloss.js?v=4';" not in r:
    raise SystemExit('runtime import anchor not found')
r = r.replace("import './zh-unknown-gloss.js?v=4';", "import './zh-unknown-gloss.js?v=5';")
runtime.write_text(r, 'utf-8')

gradle = Path('android/app/build.gradle')
g = gradle.read_text('utf-8')
if 'versionCode 66' not in g or "versionName '77.42-toc46'" not in g:
    raise SystemExit('version anchor not found')
g = g.replace('versionCode 66', 'versionCode 67').replace("versionName '77.42-toc46'", "versionName '77.42-toc47'")
gradle.write_text(g, 'utf-8')
