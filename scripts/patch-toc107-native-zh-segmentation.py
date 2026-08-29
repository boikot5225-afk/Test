from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'anchor missing in {path}: {old[:90]!r}')
    if s.count(old) != 1:
        raise SystemExit(f'anchor not unique in {path}: {s.count(old)} occurrences')
    p.write_text(s.replace(old, new, 1))


# 1) Native SQLite bridge: weighted DP segmentation + conservative 3-char name fallback.
java = Path('android/app/src/main/java/space/saintjust/reader/stage1/ChineseResourceBridge.java')
s = java.read_text()
anchor = '    private static final int MAX_BATCH = 80;\n'
insert = '''    private static final int MAX_BATCH = 80;\n    private static final int SEGMENT_MAX_WORD = 8;\n    private static final double SEGMENT_MISS = -1.0e12;\n    private static final String COMMON_SURNAMES =\n            "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣邓郁单杭洪包诸左石崔吉龚程嵇邢裴陆荣翁荀羊甄曲封芮储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍郤璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公";\n    private static final String NAME_STOP_CHARS = "的了着过们是有在和与及并就也都很又而为被把将从到对起后前中上下来去这那其之";\n'''
if anchor not in s:
    raise SystemExit('MAX_BATCH anchor missing')
s = s.replace(anchor, insert, 1)

anchor = '    private final Map<String, String> sessionCache = new ConcurrentHashMap<>();\n'
insert = anchor + '    private final Map<String, Double> segmentationScoreCache = new ConcurrentHashMap<>();\n'
if anchor not in s:
    raise SystemExit('sessionCache anchor missing')
s = s.replace(anchor, insert, 1)

anchor = '    private List<String> parseWords(String wordsJson) {\n'
segment_code = r'''    @JavascriptInterface
    public void segmentText(String requestId, String text) {
        if (closed) {
            sendSegmentFailure(requestId, "Китайский сегментатор уже остановлен");
            return;
        }
        final String source = text == null ? "" : text;
        executor.execute(() -> {
            if (closed) return;
            try {
                SQLiteDatabase db = ensureDatabase();
                JSONArray tokens = segmentTextInternal(db, source);
                JSONObject payload = new JSONObject();
                payload.put("tokens", tokens);
                payload.put("provider", "native-sqlite-dp-v1");
                sendSegmentResult(requestId, true, payload);
            } catch (Exception error) {
                sendSegmentFailure(requestId, "Сегментация не сработала: " + safeMessage(error));
            }
        });
    }

    private JSONArray segmentTextInternal(SQLiteDatabase db, String text) throws Exception {
        JSONArray out = new JSONArray();
        int i = 0;
        while (i < text.length()) {
            if (isHan(text.charAt(i))) {
                int j = i + 1;
                while (j < text.length() && isHan(text.charAt(j))) j++;
                for (String token : segmentHanRun(db, text.substring(i, j))) out.put(token);
                i = j;
            } else {
                int j = i + 1;
                while (j < text.length() && !isHan(text.charAt(j))) j++;
                out.put(text.substring(i, j));
                i = j;
            }
        }
        return out;
    }

    private List<String> segmentHanRun(SQLiteDatabase db, String run) {
        int n = run.length();
        double[] best = new double[n + 1];
        int[] next = new int[n + 1];
        for (int i = 0; i <= n; i++) {
            best[i] = SEGMENT_MISS;
            next[i] = Math.min(n, i + 1);
        }
        best[n] = 0.0;
        next[n] = n;

        for (int i = n - 1; i >= 0; i--) {
            // Every Han character is a legal fallback. Keep its score tiny so a
            // real multi-character dictionary word always beats character soup.
            best[i] = 0.15 + best[i + 1];
            next[i] = i + 1;

            int max = Math.min(SEGMENT_MAX_WORD, n - i);
            for (int len = 2; len <= max; len++) {
                String word = run.substring(i, i + len);
                double score = dictionarySegmentScore(db, word);
                if (score <= SEGMENT_MISS / 2 && isLikelyThreeCharName(db, run, i, len)) {
                    score = 28.0;
                }
                if (score <= SEGMENT_MISS / 2) continue;
                double total = score + best[i + len];
                if (total > best[i]) {
                    best[i] = total;
                    next[i] = i + len;
                }
            }
        }

        List<String> out = new ArrayList<>();
        int i = 0;
        while (i < n) {
            int j = next[i];
            if (j <= i || j > n) j = i + 1;
            out.add(run.substring(i, j));
            i = j;
        }
        return out;
    }

    private double dictionarySegmentScore(SQLiteDatabase db, String word) {
        Double cached = segmentationScoreCache.get(word);
        if (cached != null) return cached;
        double score = SEGMENT_MISS;
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT blcu,subtlex,jieba FROM entries WHERE word=? LIMIT 1",
                    new String[]{word});
            if (cursor.moveToFirst()) {
                long rank = Long.MAX_VALUE;
                for (int index = 0; index < 3; index++) {
                    if (!cursor.isNull(index)) {
                        long value = cursor.getLong(index);
                        if (value > 0 && value < rank) rank = value;
                    }
                }
                int len = word.length();
                double frequencyBonus = rank == Long.MAX_VALUE
                        ? 0.0
                        : Math.max(0.0, 6.0 - Math.log10(rank + 1.0) * 1.15);
                // Convex length reward makes 国家中央军委 beat a chain of single
                // characters, while frequency only acts as a tie-breaker.
                score = (len * len * 3.0) + frequencyBonus;
            }
        } catch (Exception ignored) {
            score = SEGMENT_MISS;
        } finally {
            if (cursor != null) cursor.close();
        }
        segmentationScoreCache.put(word, score);
        return score;
    }

    private boolean isLikelyThreeCharName(SQLiteDatabase db, String run, int start, int len) {
        if (len != 3 || start + 3 > run.length()) return false;
        char surname = run.charAt(start);
        if (COMMON_SURNAMES.indexOf(surname) < 0) return false;
        char second = run.charAt(start + 1);
        char third = run.charAt(start + 2);
        if (NAME_STOP_CHARS.indexOf(second) >= 0 || NAME_STOP_CHARS.indexOf(third) >= 0) return false;
        // If the first two characters are already a normal dictionary word
        // (e.g. 张开), do not hallucinate a person's name such as 张开了.
        return dictionarySegmentScore(db, run.substring(start, start + 2)) <= SEGMENT_MISS / 2;
    }

    private boolean isHan(char ch) {
        return ch >= '\u3400' && ch <= '\u9fff';
    }

    private void sendSegmentResult(String requestId, boolean ok, JSONObject payload) {
        String script = "window.__readerChineseSegmentResolve&&window.__readerChineseSegmentResolve("
                + JSONObject.quote(requestId == null ? "" : requestId) + ","
                + (ok ? "true" : "false") + ","
                + JSONObject.quote(payload == null ? "{}" : payload.toString()) + ");";
        sendScript(script);
    }

    private void sendSegmentFailure(String requestId, String message) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("message", message == null ? "Китайская сегментация не сработала" : message);
            sendSegmentResult(requestId, false, payload);
        } catch (Exception ignored) {}
    }

'''
if anchor not in s:
    raise SystemExit('parseWords anchor missing')
s = s.replace(anchor, segment_code + anchor, 1)

anchor = '        sessionCache.clear();\n'
if anchor not in s:
    raise SystemExit('shutdown cache anchor missing')
s = s.replace(anchor, anchor + '        segmentationScoreCache.clear();\n', 1)
java.write_text(s)

# 2) JS core: load native gate, prefer native tokens, and delay active Chinese paint until ready.
reader = Path('js/reader-app.js')
s = reader.read_text()
old = "import { lexicalCacheIdbPut, lexicalCacheIdbGet } from './reader/lexical-cache-idb-store.js?v=1';\n"
new = old + "import './reader/zh-native-segmentation.js?v=1';\n"
if old not in s:
    raise SystemExit('reader import anchor missing')
s = s.replace(old, new, 1)

old = "function readerTokenizeChineseParagraph(text) {\n  const s = String(text || '');\n  if (!s) return [];\n"
new = "function readerTokenizeChineseParagraph(text) {\n  const s = String(text || '');\n  if (!s) return [];\n  const nativeTokens = globalThis.readerNativeChineseSegmentationSync?.(s);\n  if (Array.isArray(nativeTokens) && nativeTokens.length && nativeTokens.join('') === s) return nativeTokens;\n"
if old not in s:
    raise SystemExit('Chinese tokenizer anchor missing')
s = s.replace(old, new, 1)

old = "function renderReaderChapter() {\n  return readerChapterRenderer.render();\n}\n"
new = r'''let _readerNativeZhRenderGate = 0;

function readerZhActiveParagraphInfo() {
  const book = readerCurrentBook?.();
  if (!book || readerCanonicalLang(readerBookLang(book)) !== 'zh') return null;
  const chapters = book.chapters || [];
  const chapterIndex = Math.max(0, Math.min(book.currentChapter || 0, Math.max(0, chapters.length - 1)));
  const chapter = chapters[chapterIndex];
  const paragraphs = chapter?.paragraphs || [];
  const paragraphIndex = Math.max(0, Math.min(book.currentParagraph || 0, Math.max(0, paragraphs.length - 1)));
  const paragraph = paragraphs[paragraphIndex];
  if (typeof paragraph !== 'string' || !/[\u3400-\u9fff]/.test(paragraph)) return null;
  return { book, chapterIndex, paragraphIndex, paragraphs, text: paragraph };
}

function readerPrefetchZhSegmentationNeighbors(info) {
  if (!info) return;
  const nearby = [];
  for (const offset of [-2, -1, 1, 2]) {
    const value = info.paragraphs[info.paragraphIndex + offset];
    if (typeof value === 'string' && /[\u3400-\u9fff]/.test(value)) nearby.push(value);
  }
  globalThis.readerPrefetchNativeChineseSegmentation?.(nearby);
}

function renderReaderChapter() {
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
if old not in s:
    raise SystemExit('renderReaderChapter anchor missing')
s = s.replace(old, new, 1)
reader.write_text(s)

# 3) Cache bust entry points.
replace_once('js/app.js', "./reader-app.js?v=77.35-manual-known", "./reader-app.js?v=77.36-native-zh-seg")
replace_once('index.html', "js/app.js?v=77.34-manual-known", "js/app.js?v=77.35-native-zh-seg")
replace_once('index.html', "window.AN2_BUILD = 'v77.42-toc104-deepseek-context';", "window.AN2_BUILD = 'v77.42-toc107-native-zh-seg';")

print('toc107 native Chinese segmentation patch applied')
