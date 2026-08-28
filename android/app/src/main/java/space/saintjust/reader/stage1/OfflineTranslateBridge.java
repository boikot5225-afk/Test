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
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Bundled WikDict EN→RU bridge used only for English Unknown-word glosses.
 *
 * toc79 deliberately stops depending on ML Kit here. The compact dictionary is
 * generated at build time from WikDict's EN→RU SQLite database and packaged in
 * the APK. Lookups are therefore immediate, offline and deterministic: no model
 * download, no Accessibility window and no asynchronous inference lifecycle.
 */
public final class OfflineTranslateBridge {
    private static final String ASSET_PATH = "wikdict/en_ru_core.sqlite3";
    private static final String LOCAL_NAME = "wikdict-en-ru-core-2026-06-v1.sqlite3";

    private final Activity activity;
    private final WeakReference<WebView> webViewRef;
    private final Map<String, String> sessionCache = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Object dbLock = new Object();

    private SQLiteDatabase database;
    private volatile boolean closed = false;

    OfflineTranslateBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webViewRef = new WeakReference<>(webView);
    }

    @JavascriptInterface
    public void translateBatch(String requestId, String wordsJson) {
        if (closed) {
            sendFailure(requestId, "Офлайн-словарь уже остановлен");
            return;
        }

        final List<String> words = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(wordsJson == null ? "[]" : wordsJson);
            for (int i = 0; i < array.length() && words.size() < 40; i++) {
                String word = normalize(array.optString(i, ""));
                if (!word.isEmpty() && !words.contains(word)) words.add(word);
            }
        } catch (Exception error) {
            sendFailure(requestId, "Не удалось прочитать список английских слов");
            return;
        }

        if (words.isEmpty()) {
            sendSuccess(requestId, new JSONObject());
            return;
        }

        executor.execute(() -> {
            if (closed) return;
            JSONObject out = new JSONObject();
            try {
                SQLiteDatabase db = ensureDatabase();
                for (String word : words) {
                    if (closed) return;
                    String translated = sessionCache.get(word);
                    if (translated == null) {
                        translated = lookup(db, word);
                        if (translated != null && !translated.isEmpty()) {
                            sessionCache.put(word, translated);
                        }
                    }
                    if (translated == null || translated.isEmpty()) continue;
                    try { out.put(word, translated); } catch (Exception ignored) {}
                    sendProgress(requestId, word, translated);
                }
                sendSuccess(requestId, out);
            } catch (Exception error) {
                sendFailure(requestId, "Не удалось открыть встроенный EN→RU словарь: " + safeMessage(error));
            }
        });
    }

    private SQLiteDatabase ensureDatabase() throws Exception {
        synchronized (dbLock) {
            if (database != null && database.isOpen()) return database;

            File dbFile = new File(activity.getFilesDir(), LOCAL_NAME);
            if (!dbFile.exists() || dbFile.length() < 100_000L) {
                File temp = new File(activity.getFilesDir(), LOCAL_NAME + ".tmp");
                if (temp.exists()) temp.delete();
                try (InputStream input = activity.getAssets().open(ASSET_PATH);
                     FileOutputStream output = new FileOutputStream(temp)) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = input.read(buffer)) >= 0) {
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

    private String lookup(SQLiteDatabase db, String word) {
        Cursor cursor = null;
        try {
            cursor = db.rawQuery(
                    "SELECT ru FROM translations WHERE word = ? COLLATE NOCASE LIMIT 1",
                    new String[]{word});
            if (!cursor.moveToFirst()) return "";
            String value = cursor.getString(0);
            return value == null ? "" : value.trim();
        } catch (Exception ignored) {
            return "";
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    private String normalize(String value) {
        return (value == null ? "" : value)
                .replace('’', '\'')
                .replace('‘', '\'')
                .trim()
                .toLowerCase(java.util.Locale.US);
    }

    private void sendProgress(String requestId, String sourceWord, String translated) {
        String script = "window.__readerOfflineTranslateProgress&&window.__readerOfflineTranslateProgress("
                + JSONObject.quote(requestId == null ? "" : requestId) + ","
                + JSONObject.quote(sourceWord == null ? "" : sourceWord) + ","
                + JSONObject.quote(translated == null ? "" : translated) + ");";
        sendScript(script);
    }

    private void sendSuccess(String requestId, JSONObject translations) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("translations", translations == null ? new JSONObject() : translations);
            payload.put("dictionaryReady", true);
            payload.put("provider", "wikdict_en_ru_offline");
            sendToPage(requestId, true, payload);
        } catch (Exception error) {
            sendFailure(requestId, safeMessage(error));
        }
    }

    private void sendFailure(String requestId, String message) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("message", message == null ? "Офлайн-словарь не сработал" : message);
            sendToPage(requestId, false, payload);
        } catch (Exception ignored) {}
    }

    private void sendToPage(String requestId, boolean ok, JSONObject payload) {
        String script = "window.__readerOfflineTranslateResolve&&window.__readerOfflineTranslateResolve("
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
