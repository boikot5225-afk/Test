package space.saintjust.reader.stage1;

import android.app.Activity;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.google.mlkit.common.model.DownloadConditions;
import com.google.mlkit.nl.translate.TranslateLanguage;
import com.google.mlkit.nl.translate.Translation;
import com.google.mlkit.nl.translate.Translator;
import com.google.mlkit.nl.translate.TranslatorOptions;

import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Direct Chinese -> Russian fallback for Reader Unknown-word hints.
 *
 * The translation model is the official on-device ML Kit model. It is downloaded
 * once by ML Kit and then works offline. This bridge never owns Reader layout or
 * Known/Unknown state; it only returns short translations to JavaScript. The
 * contextual DeepSeek batch may replace these fallback hints later.
 */
final class ChineseOfflineTranslateBridge {
    private static final int MAX_BATCH = 40;

    private final Activity activity;
    private final WeakReference<WebView> webViewRef;
    private final Translator translator;
    private final Map<String, String> sessionCache = new ConcurrentHashMap<>();
    private volatile boolean closed = false;

    ChineseOfflineTranslateBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webViewRef = new WeakReference<>(webView);
        TranslatorOptions options = new TranslatorOptions.Builder()
                .setSourceLanguage(TranslateLanguage.CHINESE)
                .setTargetLanguage(TranslateLanguage.RUSSIAN)
                .build();
        translator = Translation.getClient(options);
    }

    @JavascriptInterface
    public void translateBatch(String requestId, String wordsJson) {
        final String safeId = requestId == null ? "" : requestId;
        if (closed) {
            sendFailure(safeId, "Китайский офлайн-переводчик уже остановлен");
            return;
        }

        final List<String> words = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(wordsJson == null ? "[]" : wordsJson);
            for (int i = 0; i < array.length() && words.size() < MAX_BATCH; i++) {
                String word = normalize(array.optString(i, ""));
                if (!word.isEmpty() && !words.contains(word)) words.add(word);
            }
        } catch (Exception error) {
            sendFailure(safeId, "Не удалось прочитать китайские слова");
            return;
        }

        if (words.isEmpty()) {
            sendSuccess(safeId, new JSONObject(), true);
            return;
        }

        // downloadModelIfNeeded is cheap after the first successful download and
        // keeps the caller independent from whether the model was preinstalled.
        DownloadConditions conditions = new DownloadConditions.Builder().build();
        translator.downloadModelIfNeeded(conditions)
                .addOnSuccessListener(unused -> {
                    if (!closed) translateNext(safeId, words, 0, new JSONObject());
                })
                .addOnFailureListener(error -> {
                    if (!closed) sendFailure(safeId,
                            "Не удалось подготовить модель китайский→русский: " + readable(error));
                });
    }

    private void translateNext(String requestId, List<String> words, int index, JSONObject out) {
        if (closed) return;
        if (index >= words.size()) {
            sendSuccess(requestId, out, true);
            return;
        }

        String word = words.get(index);
        String cached = sessionCache.get(word);
        if (cached != null && !cached.isEmpty()) {
            try { out.put(word, cached); } catch (Exception ignored) {}
            sendProgress(requestId, word, cached);
            translateNext(requestId, words, index + 1, out);
            return;
        }

        translator.translate(word)
                .addOnSuccessListener(translated -> {
                    if (closed) return;
                    String value = translated == null ? "" : translated.trim();
                    if (!value.isEmpty()) {
                        sessionCache.put(word, value);
                        try { out.put(word, value); } catch (Exception ignored) {}
                        sendProgress(requestId, word, value);
                    }
                    translateNext(requestId, words, index + 1, out);
                })
                .addOnFailureListener(error -> {
                    if (closed) return;
                    // One odd token must not drop the whole visible-page batch.
                    translateNext(requestId, words, index + 1, out);
                });
    }

    private String normalize(String value) {
        return (value == null ? "" : value).replaceAll("\\s+", "").trim();
    }

    private void sendProgress(String requestId, String sourceWord, String translated) {
        String script = "window.__readerChineseTranslateProgress&&window.__readerChineseTranslateProgress("
                + JSONObject.quote(requestId == null ? "" : requestId) + ","
                + JSONObject.quote(sourceWord == null ? "" : sourceWord) + ","
                + JSONObject.quote(translated == null ? "" : translated) + ");";
        sendScript(script);
    }

    private void sendSuccess(String requestId, JSONObject translations, boolean modelReady) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("translations", translations == null ? new JSONObject() : translations);
            payload.put("modelReady", modelReady);
            payload.put("provider", "mlkit_zh_ru_offline");
            sendToPage(requestId, true, payload);
        } catch (Exception error) {
            sendFailure(requestId, readable(error));
        }
    }

    private void sendFailure(String requestId, String message) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("message", message == null ? "Китайский офлайн-перевод не сработал" : message);
            payload.put("provider", "mlkit_zh_ru_offline");
            sendToPage(requestId, false, payload);
        } catch (Exception ignored) {}
    }

    private void sendToPage(String requestId, boolean ok, JSONObject payload) {
        String script = "window.__readerChineseTranslateResolve&&window.__readerChineseTranslateResolve("
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

    private String readable(Exception error) {
        if (error == null || error.getMessage() == null || error.getMessage().trim().isEmpty()) {
            return "неизвестная ошибка";
        }
        return error.getMessage().trim();
    }

    void shutdown() {
        closed = true;
        sessionCache.clear();
        try { translator.close(); } catch (Exception ignored) {}
    }
}
