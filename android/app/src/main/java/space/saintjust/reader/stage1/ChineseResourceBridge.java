package space.saintjust.reader.stage1;

import android.app.Activity;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Full offline Mandarin dictionary / frequency bridge.
 *
 * The source database is generated from Migaku's public Mandarin dictionary,
 * BLCU, SUBTLEX-CH, Jieba and HSK resources. It stays in SQLite and is queried
 * in small batches on a background thread; the WebView therefore never parses
 * the 500k-entry source dictionary into JavaScript memory.
 */
public final class ChineseResourceBridge {
    private static final String ASSET_PATH = "data/zh_migaku.sqlite3";
    private static final String LOCAL_NAME = "reader-zh-migaku-v1.sqlite3";
    private static final int MAX_BATCH = 80;
    private static final int SEGMENT_MAX_WORD = 8;
    private static final double SEGMENT_INF = 1.0e12;
    private static final String COMMON_SURNAMES =
            "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣邓郁单杭洪包诸左石崔吉龚程嵇邢裴陆荣翁荀羊甄曲封芮储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍郤璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公";
    private static final String NAME_STOP_SECOND = "的了着过们是有在和与及并就也都很而为被把将从到对起后前中上下来去这那其之";
    private static final String NAME_STOP_THIRD = "的了着过们是有在和与及并就也都很又而为被把将从到对起后前中上下来去这那其之";

    private final Activity activity;
    private final WeakReference<WebView> webViewRef;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Map<String, String> sessionCache = new ConcurrentHashMap<>();
    private final Map<String, Double> segmentationScoreCache = new ConcurrentHashMap<>();
    private final Object dbLock = new Object();

    private SQLiteDatabase database;
    private volatile boolean closed = false;

    ChineseResourceBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webViewRef = new WeakReference<>(webView);
    }

    @JavascriptInterface
    public void lookupBatch(String requestId, String wordsJson) {
        if (closed) {
            sendFailure(requestId, "Китайский словарь уже остановлен");
            return;
        }

        final List<String> words = parseWords(wordsJson);
        if (words.isEmpty()) {
            sendSuccess(requestId, new JSONObject());
            return;
        }

        executor.execute(() -> {
            if (closed) return;
            JSONObject entries = new JSONObject();
            try {
                SQLiteDatabase db = ensureDatabase();
                for (String word : words) {
                    if (closed) return;
                    String cached = sessionCache.get(word);
                    if (cached != null) {
                        try { entries.put(word, new JSONObject(cached)); } catch (Exception ignored) {}
                        continue;
                    }
                    JSONObject entry = lookup(db, word);
                    if (entry == null) continue;
                    String raw = entry.toString();
                    sessionCache.put(word, raw);
                    try { entries.put(word, entry); } catch (Exception ignored) {}
                }
                sendSuccess(requestId, entries);
            } catch (Exception error) {
                sendFailure(requestId, "Не удалось открыть китайский словарь: " + safeMessage(error));
            }
        });
    }

    @JavascriptInterface
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
            best[i] = SEGMENT_INF;
            next[i] = Math.min(n, i + 1);
        }
        best[n] = 0.0;
        next[n] = n;

        for (int i = n - 1; i >= 0; i--) {
            int max = Math.min(SEGMENT_MAX_WORD, n - i);
            for (int len = 1; len <= max; len++) {
                String word = run.substring(i, i + len);
                double cost = dictionarySegmentCost(db, word);
                if (cost >= SEGMENT_INF / 2 && isLikelyThreeCharName(db, run, i, len)) {
                    // A plausible surname + two-character given name should beat
                    // three unrelated characters, but normal dictionary words
                    // still win whenever they exist.
                    cost = 4.5;
                }
                if (cost >= SEGMENT_INF / 2) {
                    if (len == 1) cost = 14.0; // true OOV single-character fallback
                    else continue;
                }
                double total = cost + best[i + len];
                if (total < best[i]) {
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

    private double dictionarySegmentCost(SQLiteDatabase db, String word) {
        Double cached = segmentationScoreCache.get(word);
        if (cached != null) return cached;
        double cost = SEGMENT_INF;
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT blcu,subtlex,jieba FROM entries WHERE word=? LIMIT 1",
                    new String[]{word});
            if (cursor.moveToFirst()) {
                long rank = Long.MAX_VALUE;
                int coverage = 0;
                for (int index = 0; index < 3; index++) {
                    if (!cursor.isNull(index)) {
                        long value = cursor.getLong(index);
                        if (value > 0) {
                            coverage += 1;
                            if (value < rank) rank = value;
                        }
                    }
                }
                // The 500k dictionary contains useful definitions but also rare
                // phrase fragments. Require frequency evidence for segmentation;
                // definition-only entries remain available in the word panel.
                if (rank != Long.MAX_VALUE) {
                    cost = Math.log(rank + 1.0);
                    if (coverage == 1) cost += 0.75;
                    if (rank > 50_000L) cost += 3.0;
                    if (rank > 150_000L) cost += 3.0;
                }
            }
        } catch (Exception ignored) {
            cost = SEGMENT_INF;
        } finally {
            if (cursor != null) cursor.close();
        }
        segmentationScoreCache.put(word, cost);
        return cost;
    }

    private boolean isLikelyThreeCharName(SQLiteDatabase db, String run, int start, int len) {
        if (len != 3 || start + 3 > run.length()) return false;
        char surname = run.charAt(start);
        if (COMMON_SURNAMES.indexOf(surname) < 0) return false;
        char second = run.charAt(start + 1);
        char third = run.charAt(start + 2);
        // 又 is allowed in the middle (张又侠), while grammatical characters
        // such as 被/的/了 reject false names like 时被终 or 张开了.
        if (NAME_STOP_SECOND.indexOf(second) >= 0 || NAME_STOP_THIRD.indexOf(third) >= 0) return false;
        // Reject a fake name if either two-character half is already a normal
        // frequency-backed word: 纪违法 must become 违纪 + 违法, not a person.
        return dictionarySegmentCost(db, run.substring(start, start + 2)) >= SEGMENT_INF / 2
                && dictionarySegmentCost(db, run.substring(start + 1, start + 3)) >= SEGMENT_INF / 2;
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

    private List<String> parseWords(String wordsJson) {
        LinkedHashSet<String> unique = new LinkedHashSet<>();
        try {
            JSONArray array = new JSONArray(wordsJson == null ? "[]" : wordsJson);
            for (int i = 0; i < array.length() && unique.size() < MAX_BATCH; i++) {
                String word = normalize(array.optString(i, ""));
                if (!word.isEmpty()) unique.add(word);
            }
        } catch (Exception ignored) {}
        return new ArrayList<>(unique);
    }

    private SQLiteDatabase ensureDatabase() throws Exception {
        synchronized (dbLock) {
            if (database != null && database.isOpen()) return database;

            File dbFile = new File(activity.getFilesDir(), LOCAL_NAME);
            if (!dbFile.exists() || dbFile.length() < 5_000_000L) {
                File temp = new File(activity.getFilesDir(), LOCAL_NAME + ".tmp");
                if (temp.exists()) temp.delete();
                try (InputStream input = activity.getAssets().open(ASSET_PATH);
                     FileOutputStream output = new FileOutputStream(temp)) {
                    byte[] buffer = new byte[128 * 1024];
                    int read;
                    while ((read = input.read(buffer)) >= 0) {
                        if (closed) throw new IllegalStateException("bridge stopped");
                        if (read > 0) output.write(buffer, 0, read);
                    }
                    output.getFD().sync();
                }
                if (dbFile.exists() && !dbFile.delete()) {
                    throw new IllegalStateException("не удалось заменить локальную базу");
                }
                if (!temp.renameTo(dbFile)) {
                    throw new IllegalStateException("не удалось установить локальную базу");
                }
            }

            database = SQLiteDatabase.openDatabase(
                    dbFile.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
            return database;
        }
    }

    private JSONObject lookup(SQLiteDatabase db, String requestedWord) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT word,pinyin,en,alt,tags,blcu,subtlex,jieba,hsk,new_hsk " +
                            "FROM entries WHERE word=? LIMIT 1",
                    new String[]{requestedWord});
            if (cursor.moveToFirst()) return cursorToJson(cursor, requestedWord);
        } catch (Exception ignored) {
        } finally {
            if (cursor != null) cursor.close();
        }

        // Simplified books normally hit the primary key. The alternate-form
        // lookup is deliberately a second query so the hot path stays a single
        // primary-key seek.
        try {
            cursor = db.rawQuery(
                    "SELECT word,pinyin,en,alt,tags,blcu,subtlex,jieba,hsk,new_hsk " +
                            "FROM entries WHERE alt=? LIMIT 1",
                    new String[]{requestedWord});
            if (cursor.moveToFirst()) return cursorToJson(cursor, requestedWord);
        } catch (Exception ignored) {
        } finally {
            if (cursor != null) cursor.close();
        }
        return null;
    }

    private JSONObject cursorToJson(Cursor cursor, String requestedWord) throws Exception {
        JSONObject out = new JSONObject();
        out.put("word", cursor.getString(0));
        out.put("surface", requestedWord);
        putText(out, "pinyin", cursor.getString(1));
        putText(out, "en", cursor.getString(2));
        putText(out, "alt", cursor.getString(3));
        putText(out, "tags", cursor.getString(4));
        putLong(out, "blcuRank", cursor, 5);
        putLong(out, "subtlexRank", cursor, 6);
        putLong(out, "jiebaRank", cursor, 7);
        putText(out, "hsk", cursor.getString(8));
        putText(out, "newHsk", cursor.getString(9));
        out.put("_source", "migaku_sqlite_offline");
        out.put("_note", "дополнительный локальный словарь Migaku");
        return out;
    }

    private void putText(JSONObject out, String key, String value) throws Exception {
        String clean = value == null ? "" : value.trim();
        if (!clean.isEmpty()) out.put(key, clean);
    }

    private void putLong(JSONObject out, String key, Cursor cursor, int index) throws Exception {
        if (!cursor.isNull(index)) out.put(key, cursor.getLong(index));
    }

    private String normalize(String value) {
        return value == null ? "" : value.replace('\u00a0', ' ').trim();
    }

    private void sendSuccess(String requestId, JSONObject entries) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("entries", entries == null ? new JSONObject() : entries);
            payload.put("provider", "migaku_zh_sqlite_offline");
            sendToPage(requestId, true, payload);
        } catch (Exception error) {
            sendFailure(requestId, safeMessage(error));
        }
    }

    private void sendFailure(String requestId, String message) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("message", message == null ? "Китайский словарь не сработал" : message);
            sendToPage(requestId, false, payload);
        } catch (Exception ignored) {}
    }

    private void sendToPage(String requestId, boolean ok, JSONObject payload) {
        String script = "window.__readerChineseResourceResolve&&window.__readerChineseResourceResolve("
                + JSONObject.quote(requestId == null ? "" : requestId) + ","
                + (ok ? "true" : "false") + ","
                + JSONObject.quote(payload == null ? "{}" : payload.toString()) + ");";
        sendScript(script);
    }

    private void sendScript(String script) {
        WebView webView = webViewRef.get();
        if (closed || webView == null) return;
        activity.runOnUiThread(() -> {
            WebView current = webViewRef.get();
            if (!closed && current != null) {
                try { current.evaluateJavascript(script, null); } catch (Exception ignored) {}
            }
        });
    }

    private String safeMessage(Exception error) {
        if (error == null || error.getMessage() == null || error.getMessage().trim().isEmpty()) {
            return "неизвестная ошибка";
        }
        return error.getMessage().trim();
    }

    void shutdown() {
        closed = true;
        sessionCache.clear();
        segmentationScoreCache.clear();
        executor.shutdownNow();
        synchronized (dbLock) {
            if (database != null) {
                try { database.close(); } catch (Exception ignored) {}
                database = null;
            }
        }
    }
}
