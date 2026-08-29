from pathlib import Path

# toc108: page mode renders/paginates the whole chapter in one synchronous pass.
# toc107 only gated the active paragraph, so every other paragraph on the page
# silently fell back to the legacy tokenizer. This patch warms every Chinese
# string paragraph before page-mode paint and adds a batched JS cache fan-out.

# 1) Native bridge: bulk-prime segmentation scores per Han run so chapter-wide
# preparation does not issue one SQLite point query for every 1..8-char candidate.
p = Path('android/app/src/main/java/space/saintjust/reader/stage1/ChineseResourceBridge.java')
s = p.read_text()
old = '    private static final int SEGMENT_MAX_WORD = 8;\n    private static final double SEGMENT_INF = 1.0e12;\n'
new = '    private static final int SEGMENT_MAX_WORD = 8;\n    private static final int SEGMENT_PREFETCH_CHUNK = 700;\n    private static final double SEGMENT_INF = 1.0e12;\n'
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = '    private List<String> segmentHanRun(SQLiteDatabase db, String run) {\n        int n = run.length();\n'
new = '    private List<String> segmentHanRun(SQLiteDatabase db, String run) {\n        primeSegmentationScores(db, run);\n        int n = run.length();\n'
assert s.count(old) == 1
s = s.replace(old, new, 1)

anchor = '    private double dictionarySegmentCost(SQLiteDatabase db, String word) {\n'
assert s.count(anchor) == 1
prime = r'''    private void primeSegmentationScores(SQLiteDatabase db, String run) {
        if (run == null || run.isEmpty()) return;
        LinkedHashSet<String> missing = new LinkedHashSet<>();
        int n = run.length();
        for (int i = 0; i < n; i++) {
            int max = Math.min(SEGMENT_MAX_WORD, n - i);
            for (int len = 1; len <= max; len++) {
                String word = run.substring(i, i + len);
                if (!segmentationScoreCache.containsKey(word)) missing.add(word);
            }
        }
        if (missing.isEmpty()) return;

        List<String> words = new ArrayList<>(missing);
        for (int start = 0; start < words.size(); start += SEGMENT_PREFETCH_CHUNK) {
            int end = Math.min(words.size(), start + SEGMENT_PREFETCH_CHUNK);
            StringBuilder placeholders = new StringBuilder();
            String[] args = new String[end - start];
            LinkedHashSet<String> unresolved = new LinkedHashSet<>();
            for (int i = start; i < end; i++) {
                if (i > start) placeholders.append(',');
                placeholders.append('?');
                String word = words.get(i);
                args[i - start] = word;
                unresolved.add(word);
            }

            Cursor cursor = null;
            try {
                cursor = db.rawQuery(
                        "SELECT word,blcu,subtlex,jieba FROM entries WHERE word IN (" + placeholders + ")",
                        args);
                while (cursor.moveToNext()) {
                    String word = cursor.getString(0);
                    long rank = Long.MAX_VALUE;
                    int coverage = 0;
                    for (int index = 1; index <= 3; index++) {
                        if (!cursor.isNull(index)) {
                            long value = cursor.getLong(index);
                            if (value > 0) {
                                coverage += 1;
                                if (value < rank) rank = value;
                            }
                        }
                    }
                    double cost = SEGMENT_INF;
                    if (rank != Long.MAX_VALUE) {
                        cost = Math.log(rank + 1.0);
                        if (coverage == 1) cost += 0.75;
                        if (rank > 50_000L) cost += 3.0;
                        if (rank > 150_000L) cost += 3.0;
                    }
                    segmentationScoreCache.put(word, cost);
                    unresolved.remove(word);
                }
            } catch (Exception ignored) {
                // Point-query fallback remains available in dictionarySegmentCost.
            } finally {
                if (cursor != null) cursor.close();
            }
            for (String word : unresolved) {
                segmentationScoreCache.putIfAbsent(word, SEGMENT_INF);
            }
        }
    }

'''
s = s.replace(anchor, prime + anchor, 1)
p.write_text(s)

# 2) JS native segmentation cache: one bridge request can prepare many
# paragraphs, then token boundaries are fanned back into per-paragraph cache.
p = Path('js/reader/zh-native-segmentation.js')
s = p.read_text()
assert s.count("const CACHE_MAX = 500;") == 1
s = s.replace("const CACHE_MAX = 500;", "const CACHE_MAX = 1400;", 1)

anchor = "function prefetch(texts) {\n  for (const text of Array.isArray(texts) ? texts : []) {\n    ensure(text).catch(() => null);\n  }\n}\n\n"
assert s.count(anchor) == 1
addition = r'''const MANY_BATCH_TEXTS = 32;
const MANY_BATCH_CHARS = 8000;

function paragraphBatchSeparator(texts) {
  let separator = '\uE000';
  while (texts.some(text => String(text || '').includes(separator))) separator += '\uE001';
  return separator;
}

async function ensureBatch(texts) {
  const batch = texts.filter(Boolean);
  if (!batch.length) return true;
  if (batch.length === 1) return !!(await ensure(batch[0]));

  const separator = paragraphBatchSeparator(batch);
  const joined = batch.join(separator);
  const joinedTokens = await ensure(joined);
  if (!validTokens(joined, joinedTokens)) return false;

  // Convert the joined token stream into absolute end offsets. Paragraph
  // boundaries are then forced explicitly, so even a punctuation token that
  // spans the private-use separator cannot leak into its neighbour.
  const tokenEnds = [];
  let offset = 0;
  for (const token of joinedTokens) {
    offset += token.length;
    tokenEnds.push(offset);
  }

  const c = loadCache();
  delete c[cacheKey(joined)]; // do not keep a duplicate chapter-sized cache row
  let rangeStart = 0;
  let endIndex = 0;
  for (const text of batch) {
    const rangeEnd = rangeStart + text.length;
    while (endIndex < tokenEnds.length && tokenEnds[endIndex] <= rangeStart) endIndex += 1;
    const parts = [];
    let partStart = rangeStart;
    let scan = endIndex;
    while (scan < tokenEnds.length && tokenEnds[scan] < rangeEnd) {
      const partEnd = tokenEnds[scan];
      if (partEnd > partStart) parts.push(joined.slice(partStart, partEnd));
      partStart = partEnd;
      scan += 1;
    }
    if (rangeEnd > partStart) parts.push(joined.slice(partStart, rangeEnd));
    if (validTokens(text, parts)) {
      c[cacheKey(text)] = { tokens: parts, t: Date.now(), provider: 'native-sqlite-dp-page-v2' };
    }
    rangeStart = rangeEnd + separator.length;
    endIndex = scan;
  }
  saveCache();
  return batch.every(text => !!getSync(text));
}

async function ensureMany(texts) {
  const unique = [];
  const seen = new Set();
  for (const raw of Array.isArray(texts) ? texts : []) {
    const text = String(raw || '');
    if (!text || !/[\u3400-\u9fff]/.test(text) || seen.has(text) || getSync(text)) continue;
    seen.add(text);
    unique.push(text);
  }
  if (!unique.length) return true;

  const batches = [];
  let current = [];
  let chars = 0;
  for (const text of unique) {
    if (current.length && (current.length >= MANY_BATCH_TEXTS || chars + text.length > MANY_BATCH_CHARS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(text);
    chars += text.length;
  }
  if (current.length) batches.push(current);

  for (const batch of batches) {
    const ok = await ensureBatch(batch);
    if (!ok) return false;
  }
  return unique.every(text => !!getSync(text));
}

'''
s = s.replace(anchor, anchor + addition, 1)

old = "globalThis.readerEnsureNativeChineseSegmentation = ensure;\nglobalThis.readerPrefetchNativeChineseSegmentation = prefetch;\n"
new = "globalThis.readerEnsureNativeChineseSegmentation = ensure;\nglobalThis.readerEnsureNativeChineseSegmentations = ensureMany;\nglobalThis.readerPrefetchNativeChineseSegmentation = prefetch;\n"
assert s.count(old) == 1
s = s.replace(old, new, 1)
old = "export { getSync, ensure, prefetch };"
new = "export { getSync, ensure, ensureMany, prefetch };"
assert s.count(old) == 1
s = s.replace(old, new, 1)
p.write_text(s)

# 3) Reader gate: page mode requires the whole string chapter to be ready
# because chapter-render-next materializes every paragraph before pagination.
p = Path('js/reader-app.js')
s = p.read_text()
old = "import './reader/zh-native-segmentation.js?v=1';"
assert s.count(old) == 1
s = s.replace(old, "import './reader/zh-native-segmentation.js?v=2-page';", 1)

old = r'''  const paragraph = paragraphs[paragraphIndex];
  if (typeof paragraph !== 'string' || !/[\u3400-\u9fff]/.test(paragraph)) return null;
  return { book, chapterIndex, paragraphIndex, paragraphs, text: paragraph };
}
'''
new = r'''  const paragraph = paragraphs[paragraphIndex];
  const activeText = typeof paragraph === 'string' && /[\u3400-\u9fff]/.test(paragraph) ? paragraph : '';
  const chineseTexts = paragraphs.filter(value => typeof value === 'string' && /[\u3400-\u9fff]/.test(value));
  if (!chineseTexts.length) return null;
  return { book, chapterIndex, paragraphIndex, paragraphs, text: activeText || chineseTexts[0], activeText, chineseTexts };
}
'''
assert s.count(old) == 1
s = s.replace(old, new, 1)

old = r'''function renderReaderChapter() {
  const info = readerZhActiveParagraphInfo();
  const ensureNative = globalThis.readerEnsureNativeChineseSegmentation;
  const nativeAvailable = !!globalThis.ReaderChineseResources?.segmentText;
  if (info && nativeAvailable && typeof ensureNative === 'function') {
    const cached = globalThis.readerNativeChineseSegmentationSync?.(info.text);
    if (!cached) {
      const gate = ++_readerNativeZhRenderGate;
      const chapterText = document.getElementById('reader-chapter-text');
      const renderedChapter = Number(chapterText?.dataset?.renderedChapter ?? -1);
      if (chapterText && renderedChapter !== info.chapterIndex) {
        chapterText.innerHTML = '<div class="reader-zh-seg-wait">Подготавливаю китайские слова…</div>';
      }
      ensureNative(info.text).then(() => {
        if (gate !== _readerNativeZhRenderGate) return;
        readerChapterRenderer.render();
        readerPrefetchZhSegmentationNeighbors(info);
        requestAnimationFrame(() => { try { readerScrollActiveParagraph(); } catch {} });
      }).catch(() => {
        if (gate !== _readerNativeZhRenderGate) return;
        readerChapterRenderer.render();
      });
      return;
    }
    readerPrefetchZhSegmentationNeighbors(info);
  }
  _readerNativeZhRenderGate += 1;
  return readerChapterRenderer.render();
}
'''
new = r'''function renderReaderChapter() {
  const info = readerZhActiveParagraphInfo();
  const ensureNative = globalThis.readerEnsureNativeChineseSegmentation;
  const ensureNativeMany = globalThis.readerEnsureNativeChineseSegmentations;
  const getNativeSync = globalThis.readerNativeChineseSegmentationSync;
  const nativeAvailable = !!globalThis.ReaderChineseResources?.segmentText;
  const pagesActive = readerPagesMode.isEnabled?.() === true;
  if (info && nativeAvailable && typeof ensureNative === 'function') {
    // Page mode renders the entire chapter before it measures pages. Every
    // Chinese string paragraph therefore has to be native-tokenized before
    // that single paint. Scroll mode keeps the cheaper active-paragraph gate.
    const requiredTexts = pagesActive ? info.chineseTexts : (info.activeText ? [info.activeText] : []);
    const missing = requiredTexts.filter(text => !getNativeSync?.(text));
    if (requiredTexts.length && missing.length) {
      const gate = ++_readerNativeZhRenderGate;
      const chapterText = document.getElementById('reader-chapter-text');
      const renderedChapter = Number(chapterText?.dataset?.renderedChapter ?? -1);
      if (chapterText && (pagesActive || renderedChapter !== info.chapterIndex)) {
        chapterText.innerHTML = `<div class="reader-zh-seg-wait">${pagesActive ? 'Подготавливаю китайские слова для страницы…' : 'Подготавливаю китайские слова…'}</div>`;
      }
      const prepare = pagesActive && typeof ensureNativeMany === 'function'
        ? ensureNativeMany(requiredTexts)
        : ensureNative(requiredTexts[0]);
      Promise.resolve(prepare).then(() => {
        if (gate !== _readerNativeZhRenderGate) return;
        const stillMissing = requiredTexts.filter(text => !getNativeSync?.(text));
        if (stillMissing.length) {
          console.warn('[reader zh segmentation] native preparation incomplete; using fallback for', stillMissing.length, 'paragraphs');
        }
        readerChapterRenderer.render();
        if (!pagesActive) readerPrefetchZhSegmentationNeighbors(info);
        requestAnimationFrame(() => { try { readerScrollActiveParagraph(); } catch {} });
      }).catch((error) => {
        if (gate !== _readerNativeZhRenderGate) return;
        console.warn('[reader zh segmentation] preparation failed', error);
        readerChapterRenderer.render();
      });
      return;
    }
    if (!pagesActive && info.activeText) readerPrefetchZhSegmentationNeighbors(info);
  }
  _readerNativeZhRenderGate += 1;
  return readerChapterRenderer.render();
}
'''
assert s.count(old) == 1
s = s.replace(old, new, 1)
p.write_text(s)

# Cache-bust the orchestrator chain so an installed update cannot reuse toc107 JS.
p = Path('js/app.js')
s = p.read_text()
old = 'reader-app.js?v=77.36-native-zh-seg'
assert s.count(old) == 1
s = s.replace(old, 'reader-app.js?v=77.37-page-zh-seg', 1)
p.write_text(s)

p = Path('index.html')
s = p.read_text()
old = 'js/app.js?v=77.35-native-zh-seg'
assert s.count(old) == 1
s = s.replace(old, 'js/app.js?v=77.36-page-zh-seg', 1)
p.write_text(s)

print('toc108 page-mode Chinese segmentation patch applied')
