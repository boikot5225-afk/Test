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
 * In-process ML Kit EN→RU bridge used only for English Unknown-word glosses.
 *
 * The model is downloaded once by ML Kit and then reused locally. A completed
 * word is streamed back to the page immediately instead of waiting for the
 * whole batch, which also makes the UI resilient to page-mode DOM rebuilds.
 */
public final class OfflineTranslateBridge {
    private final Activity activity;
    private final WeakReference<WebView> webViewRef;
    private final Map<String, String> sessionCache = new ConcurrentHashMap<>();
    private final Translator translator;
    private volatile boolean modelReady = false;
    private volatile boolean closed = false;

    OfflineTranslateBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webViewRef = new WeakReference<>(webView);
        TranslatorOptions options = new TranslatorOptions.Builder()
                .setSourceLanguage(TranslateLanguage.ENGLISH)
                .setTargetLanguage(TranslateLanguage.RUSSIAN)
                .build();
        translator = Translation.getClient(options);
    }

    @JavascriptInterface
    public void translateBatch(String requestId, String wordsJson) {
        if (closed) {
            sendFailure(requestId, "Офлайн-переводчик уже остановлен");
            return;
        }

        final List<String> words = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(wordsJson == null ? "[]" : wordsJson);
            for (int i = 0; i < array.length() && words.size() < 40; i++) {
                String word = array.optString(i, "").trim();
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

        activity.runOnUiThread(() -> {
            if (closed) return;
            if (modelReady) {
                translateNext(requestId, words, 0, new JSONObject());
                return;
            }

            DownloadConditions conditions = new DownloadConditions.Builder().build();
            translator.downloadModelIfNeeded(conditions)
                    .addOnSuccessListener(ignored -> {
                        modelReady = true;
                        translateNext(requestId, words, 0, new JSONObject());
                    })
                    .addOnFailureListener(error -> sendFailure(
                            requestId,
                            "Не удалось скачать EN→RU офлайн-модель: " + safeMessage(error)));
        });
    }

    private void translateNext(String requestId, List<String> words, int index, JSONObject out) {
        if (closed) return;
        if (index >= words.size()) {
            sendSuccess(requestId, out);
            return;
        }

        final String word = words.get(index);
        final String cached = sessionCache.get(word);
        if (cached != null && !cached.isEmpty()) {
            try { out.put(word, cached); } catch (Exception ignored) {}
            sendProgress(requestId, word, cached);
            translateNext(requestId, words, index + 1, out);
            return;
        }

        translator.translate(word)
                .addOnSuccessListener(result -> {
                    String translated = result == null ? "" : result.trim();
                    if (!translated.isEmpty()) {
                        sessionCache.put(word, translated);
                        try { out.put(word, translated); } catch (Exception ignored) {}
                        sendProgress(requestId, word, translated);
                    }
                    translateNext(requestId, words, index + 1, out);
                })
                .addOnFailureListener(error -> {
                    // One odd token must not discard every other useful gloss.
                    translateNext(requestId, words, index + 1, out);
                });
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
            payload.put("modelReady", true);
            sendToPage(requestId, true, payload);
        } catch (Exception error) {
            sendFailure(requestId, safeMessage(error));
        }
    }

    private void sendFailure(String requestId, String message) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("message", message == null ? "Офлайн-перевод не сработал" : message);
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
        modelReady = false;
        sessionCache.clear();
        try { translator.close(); } catch (Exception ignored) {}
    }
}
