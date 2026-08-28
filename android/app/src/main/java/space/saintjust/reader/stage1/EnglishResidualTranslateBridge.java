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
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;

/**
 * Last-resort English → Russian translator for inline Unknown glosses.
 *
 * The page first uses the bundled 95k-entry WikDict. Only dictionary misses are
 * sent here, so ordinary reading remains instant/offline after the model exists.
 * This bridge intentionally has no dependency on Instant Translate or
 * Accessibility.
 */
public final class EnglishResidualTranslateBridge {
    private final Activity activity;
    private final WeakReference<WebView> webViewRef;
    private final Object lock = new Object();
    private final List<Request> waiting = new ArrayList<>();
    private final Translator translator;

    private boolean preparing = false;
    private boolean modelReady = false;
    private boolean closed = false;

    EnglishResidualTranslateBridge(Activity activity, WebView webView) {
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
        final List<String> words = parseWords(wordsJson);
        if (words.isEmpty()) {
            sendSuccess(requestId, new JSONObject());
            return;
        }
        activity.runOnUiThread(() -> enqueue(new Request(requestId, words)));
    }

    private List<String> parseWords(String wordsJson) {
        LinkedHashSet<String> unique = new LinkedHashSet<>();
        try {
            JSONArray array = new JSONArray(wordsJson == null ? "[]" : wordsJson);
            for (int i = 0; i < array.length() && unique.size() < 24; i++) {
                String value = normalize(array.optString(i, ""));
                if (!value.isEmpty()) unique.add(value);
            }
        } catch (Exception ignored) {}
        return new ArrayList<>(unique);
    }

    private String normalize(String value) {
        return (value == null ? "" : value)
                .replace('’', '\'')
                .replace('‘', '\'')
                .trim()
                .toLowerCase(Locale.US);
    }

    private void enqueue(Request request) {
        if (closed) {
            sendFailure(request.id, "EN→RU переводчик уже остановлен");
            return;
        }
        synchronized (lock) {
            if (modelReady) {
                runRequest(request);
                return;
            }
            waiting.add(request);
            if (preparing) return;
            preparing = true;
        }

        DownloadConditions conditions = new DownloadConditions.Builder().build();
        translator.downloadModelIfNeeded(conditions)
                .addOnSuccessListener(unused -> {
                    List<Request> pending;
                    synchronized (lock) {
                        preparing = false;
                        modelReady = true;
                        pending = new ArrayList<>(waiting);
                        waiting.clear();
                    }
                    for (Request item : pending) runRequest(item);
                })
                .addOnFailureListener(error -> {
                    List<Request> pending;
                    synchronized (lock) {
                        preparing = false;
                        pending = new ArrayList<>(waiting);
                        waiting.clear();
                    }
                    String message = "Не удалось подготовить офлайн EN→RU модель: " + safeMessage(error);
                    for (Request item : pending) sendFailure(item.id, message);
                });
    }

    private void runRequest(Request request) {
        if (closed) return;
        JSONObject result = new JSONObject();
        translateNext(request, 0, result);
    }

    private void translateNext(Request request, int index, JSONObject result) {
        if (closed) return;
        if (index >= request.words.size()) {
            sendSuccess(request.id, result);
            return;
        }
        String source = request.words.get(index);
        translator.translate(source)
                .addOnSuccessListener(translated -> {
                    String value = translated == null ? "" : translated.trim();
                    if (!value.isEmpty()) {
                        try { result.put(source, value); } catch (Exception ignored) {}
                        sendProgress(request.id, source, value);
                    }
                    translateNext(request, index + 1, result);
                })
                .addOnFailureListener(error -> {
                    // One exotic word must not poison the rest of the page.
                    translateNext(request, index + 1, result);
                });
    }

    private void sendProgress(String requestId, String source, String translated) {
        String script = "window.__readerEnResidualProgress&&window.__readerEnResidualProgress("
                + JSONObject.quote(requestId == null ? "" : requestId) + ","
                + JSONObject.quote(source == null ? "" : source) + ","
                + JSONObject.quote(translated == null ? "" : translated) + ");";
        sendScript(script);
    }

    private void sendSuccess(String requestId, JSONObject translations) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("translations", translations == null ? new JSONObject() : translations);
            payload.put("provider", "mlkit_en_ru_residual");
            payload.put("modelReady", true);
        } catch (Exception ignored) {}
        sendResolve(requestId, true, payload);
    }

    private void sendFailure(String requestId, String message) {
        JSONObject payload = new JSONObject();
        try { payload.put("message", message == null ? "EN→RU fallback failed" : message); }
        catch (Exception ignored) {}
        sendResolve(requestId, false, payload);
    }

    private void sendResolve(String requestId, boolean ok, JSONObject payload) {
        String script = "window.__readerEnResidualResolve&&window.__readerEnResidualResolve("
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
        synchronized (lock) {
            waiting.clear();
            preparing = false;
        }
        try { translator.close(); } catch (Exception ignored) {}
    }

    private static final class Request {
        final String id;
        final List<String> words;

        Request(String id, List<String> words) {
            this.id = id == null ? "" : id;
            this.words = words;
        }
    }
}
