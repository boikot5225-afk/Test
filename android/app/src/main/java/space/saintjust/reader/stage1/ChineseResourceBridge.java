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

    private final Activity activity;
    private final WeakReference<WebView> webViewRef;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Map<String, String> sessionCache = new ConcurrentHashMap<>();
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
        executor.shutdownNow();
        synchronized (dbLock) {
            if (database != null) {
                try { database.close(); } catch (Exception ignored) {}
                database = null;
            }
        }
    }
}
