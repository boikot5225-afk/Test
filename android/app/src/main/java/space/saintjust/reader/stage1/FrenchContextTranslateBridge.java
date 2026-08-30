package space.saintjust.reader.stage1;

import android.app.Activity;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.google.mlkit.common.model.DownloadConditions;
import com.google.mlkit.nl.translate.TranslateLanguage;
import com.google.mlkit.nl.translate.Translation;
import com.google.mlkit.nl.translate.Translator;
import com.google.mlkit.nl.translate.TranslatorOptions;

import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.util.ArrayDeque;
import java.util.Deque;

/** toc120: French -> Russian short-context bridge used only for sense refinement. */
public final class FrenchContextTranslateBridge {
    private static final int MAX_CONTEXT_CHARS = 640;
    private static final int MAX_QUEUE = 24;

    private final Activity activity;
    private final WeakReference<WebView> webViewRef;
    private final Translator translator;
    private final Deque<Request> queue = new ArrayDeque<>();
    private boolean preparing = false;
    private boolean modelReady = false;
    private boolean busy = false;
    private boolean closed = false;

    FrenchContextTranslateBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webViewRef = new WeakReference<>(webView);
        TranslatorOptions options = new TranslatorOptions.Builder()
                .setSourceLanguage(TranslateLanguage.FRENCH)
                .setTargetLanguage(TranslateLanguage.RUSSIAN)
                .build();
        translator = Translation.getClient(options);
    }

    @JavascriptInterface
    public void translate(String requestId, String sourceText) {
        final String source = cleanContext(sourceText);
        if (source.isEmpty()) {
            sendFailure(requestId, "Пустой французский контекст");
            return;
        }
        activity.runOnUiThread(() -> enqueue(new Request(requestId, source)));
    }

    private String cleanContext(String value) {
        String clean = (value == null ? "" : value).replaceAll("\\s+", " ").trim();
        if (clean.length() > MAX_CONTEXT_CHARS) clean = clean.substring(0, MAX_CONTEXT_CHARS).trim();
        return clean;
    }

    private void enqueue(Request request) {
        if (closed) { sendFailure(request.id, "FR→RU контекстный переводчик уже остановлен"); return; }
        if (queue.size() >= MAX_QUEUE) { sendFailure(request.id, "Очередь контекстного перевода переполнена"); return; }
        queue.addLast(request);
        ensureModelAndDrain();
    }

    private void ensureModelAndDrain() {
        if (closed) return;
        if (modelReady) { drain(); return; }
        if (preparing) return;
        preparing = true;
        translator.downloadModelIfNeeded(new DownloadConditions.Builder().build())
                .addOnSuccessListener(unused -> { preparing = false; modelReady = true; drain(); })
                .addOnFailureListener(error -> {
                    preparing = false;
                    String message = "Не удалось подготовить офлайн FR→RU модель: " + safeMessage(error);
                    while (!queue.isEmpty()) sendFailure(queue.removeFirst().id, message);
                });
    }

    private void drain() {
        if (closed || busy || !modelReady || queue.isEmpty()) return;
        Request request = queue.removeFirst();
        busy = true;
        translator.translate(request.source)
                .addOnSuccessListener(translated -> {
                    busy = false;
                    String value = translated == null ? "" : translated.trim();
                    if (value.isEmpty()) sendFailure(request.id, "Пустой результат FR→RU");
                    else sendSuccess(request.id, request.source, value);
                    drain();
                })
                .addOnFailureListener(error -> { busy = false; sendFailure(request.id, safeMessage(error)); drain(); });
    }

    private void sendSuccess(String requestId, String source, String translated) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("source", source);
            payload.put("translated", translated);
            payload.put("provider", "mlkit_fr_ru_context");
        } catch (Exception ignored) {}
        sendResolve(requestId, true, payload);
    }

    private void sendFailure(String requestId, String message) {
        JSONObject payload = new JSONObject();
        try { payload.put("message", message == null ? "FR→RU context failed" : message); }
        catch (Exception ignored) {}
        sendResolve(requestId, false, payload);
    }

    private void sendResolve(String requestId, boolean ok, JSONObject payload) {
        String script = "window.__readerFrContextTranslateResolve&&window.__readerFrContextTranslateResolve("
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
        if (error == null || error.getMessage() == null || error.getMessage().trim().isEmpty()) return "неизвестная ошибка";
        return error.getMessage().trim();
    }

    void shutdown() {
        closed = true;
        queue.clear();
        busy = false;
        preparing = false;
        try { translator.close(); } catch (Exception ignored) {}
    }

    private static final class Request {
        final String id;
        final String source;
        Request(String id, String source) { this.id = id == null ? "" : id; this.source = source; }
    }
}
