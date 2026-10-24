package space.saintjust.reader.stage1;

import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Tiny proof-of-concept bridge from Reader AI to an OpenAI-compatible server
 * running on the same Android device (PocketLLM / llama.cpp).
 *
 * Keeping the HTTP call in native code avoids WebView CORS entirely. The JS
 * side sends an already-formed OpenAI request and receives the raw JSON body
 * through window.__readerLocalAiResolve(requestId, response, error).
 */
final class LocalAiBridge {
    private static final String ENDPOINT = "http://127.0.0.1:8080/v1/chat/completions";
    private static final int CONNECT_TIMEOUT_MS = 3000;
    private static final int READ_TIMEOUT_MS = 120000;

    private final WebView webView;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private volatile boolean closed = false;

    LocalAiBridge(WebView webView) {
        this.webView = webView;
    }

    @JavascriptInterface
    public void chat(String requestId, String payloadJson) {
        final String id = requestId == null ? "" : requestId;
        final String body = payloadJson == null ? "{}" : payloadJson;
        executor.execute(() -> {
            String response = null;
            String error = null;
            try {
                response = postJson(body);
            } catch (Exception e) {
                error = e.getMessage() == null ? e.toString() : e.getMessage();
            }
            final String result = response;
            final String failure = error;
            mainHandler.post(() -> {
                if (closed || webView == null) return;
                String js = "window.__readerLocalAiResolve && window.__readerLocalAiResolve("
                        + JSONObject.quote(id) + ","
                        + (result == null ? "null" : JSONObject.quote(result)) + ","
                        + (failure == null ? "null" : JSONObject.quote(failure))
                        + ");";
                webView.evaluateJavascript(js, null);
            });
        });
    }

    private static String postJson(String body) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(ENDPOINT).openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "application/json");

            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(bytes);
            }

            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 300
                    ? connection.getInputStream()
                    : connection.getErrorStream();
            String response = readAll(stream);
            if (status < 200 || status >= 300) {
                String detail = response == null || response.isBlank() ? "" : ": " + response;
                throw new IOException("Local AI HTTP " + status + detail);
            }
            if (response == null || response.isBlank()) {
                throw new IOException("Local AI returned an empty response");
            }
            return response;
        } finally {
            connection.disconnect();
        }
    }

    private static String readAll(InputStream input) throws IOException {
        if (input == null) return "";
        StringBuilder out = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                out.append(line).append('\n');
            }
        }
        return out.toString().trim();
    }

    void shutdown() {
        closed = true;
        executor.shutdownNow();
    }
}
