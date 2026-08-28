package space.saintjust.reader.stage1;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONException;
import org.json.JSONObject;

import java.lang.ref.WeakReference;

/**
 * Compatibility bridge that delegates translation to the user's installed
 * Instant Translate app. No copied OAuth/Firebase/RevenueCat state is used.
 *
 * toc68 takes a short-lived bitmap snapshot of Reader immediately before the
 * PROCESS_TEXT activity is launched. The enabled AccessibilityService displays
 * that snapshot as a non-interactive accessibility overlay, so Instant Translate
 * can render and translate underneath without visibly replacing Reader AI.
 */
final class InstantTranslateBridge {
    static final String TARGET_PACKAGE = "com.spaceship.screen.textcopy";
    static final String TARGET_ACTIVITY =
            "com.spaceship.screen.translate.ui.pages.translate.popup.TranslatePopupActivity";

    private static final long STALE_PENDING_MS = 75_000L;
    private static volatile WeakReference<InstantTranslateBridge> activeBridge =
            new WeakReference<>(null);

    private final Activity activity;
    private final WebView webView;

    private String pendingRequestId = "";
    private String pendingSourceText = "";
    private long pendingStartedAtMs = 0L;

    InstantTranslateBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        activeBridge = new WeakReference<>(this);
    }

    @JavascriptInterface
    public void translate(String requestId, String payloadJson) {
        final String safeId = requestId == null ? "" : requestId;
        final JSONObject payload;
        try {
            payload = new JSONObject(payloadJson == null ? "{}" : payloadJson);
        } catch (JSONException error) {
            deliverFailure(safeId, "bad_payload", "Некорректный запрос перевода");
            return;
        }

        final String text = payload.optString("text", "").trim();
        if (text.isEmpty()) {
            deliverFailure(safeId, "empty_text", "Пустой абзац");
            return;
        }

        activity.runOnUiThread(() -> {
            clearStalePendingIfNeeded();
            if (!pendingRequestId.isEmpty()) {
                deliverFailure(safeId, "instant_busy",
                        "Предыдущий перевод Instant Translate ещё не завершён");
                return;
            }

            if (!isCaptureServiceEnabled(activity)) {
                deliverFailure(safeId, "accessibility_required",
                        "Включи службу «Reader AI — Instant Translate» в Спец. возможностях и нажми перевод ещё раз");
                Toast.makeText(activity,
                        "Один раз включи Reader AI — Instant Translate в Спец. возможностях",
                        Toast.LENGTH_LONG).show();
                try {
                    activity.startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
                } catch (Exception ignored) {}
                return;
            }

            pendingRequestId = safeId;
            pendingSourceText = text;
            pendingStartedAtMs = System.currentTimeMillis();

            // Draw the current Reader frame synchronously before another package
            // gets a chance to paint. If the overlay cannot be created we simply
            // fall back to toc67's visible external-window behaviour.
            Bitmap readerSnapshot = captureReaderSnapshot();
            if (readerSnapshot != null) {
                InstantTranslateCaptureService.showReaderCover(readerSnapshot);
            }
            InstantTranslateCaptureService.arm(text);

            try {
                Intent intent = new Intent(Intent.ACTION_PROCESS_TEXT);
                intent.setComponent(new ComponentName(TARGET_PACKAGE, TARGET_ACTIVITY));
                intent.setType("text/plain");
                intent.putExtra(Intent.EXTRA_PROCESS_TEXT, text);
                intent.putExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, true);
                activity.startActivity(intent);
            } catch (Exception error) {
                clearPending();
                InstantTranslateCaptureService.hideReaderCover();
                deliverFailure(safeId, "instant_launch_failed",
                        "Не удалось открыть установленный Instant Translate: " + readable(error));
            }
        });
    }

    private Bitmap captureReaderSnapshot() {
        try {
            View root = activity.getWindow().getDecorView();
            int width = root.getWidth();
            int height = root.getHeight();
            if (width < 2 || height < 2) return null;
            Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            root.draw(canvas);
            return bitmap;
        } catch (Throwable error) {
            return null;
        }
    }

    @JavascriptInterface
    public void cancel(String requestId) {
        final String safeId = requestId == null ? "" : requestId;
        activity.runOnUiThread(() -> {
            if (!pendingRequestId.isEmpty() && pendingRequestId.equals(safeId)) {
                clearPending();
            }
        });
    }

    @JavascriptInterface
    public String status() {
        clearStalePendingIfNeeded();
        JSONObject out = new JSONObject();
        try {
            out.put("mode", "installed_app_hidden");
            out.put("accessibilityEnabled", isCaptureServiceEnabled(activity));
            out.put("pending", !pendingRequestId.isEmpty());
        } catch (JSONException ignored) {}
        return out.toString();
    }

    static void onTranslationCaptured(String translatedText) {
        InstantTranslateBridge bridge = activeBridge.get();
        if (bridge != null) bridge.receiveCapturedTranslation(translatedText);
    }

    static void onTranslationCaptureFailed(String message) {
        InstantTranslateBridge bridge = activeBridge.get();
        if (bridge != null) bridge.receiveCaptureFailure(message);
    }

    static String pendingSourceText() {
        InstantTranslateBridge bridge = activeBridge.get();
        return bridge == null ? "" : bridge.pendingSourceText;
    }

    private void receiveCapturedTranslation(String translatedText) {
        final String result = translatedText == null ? "" : translatedText.trim();
        final String requestId = pendingRequestId;
        if (requestId.isEmpty() || result.isEmpty()) return;

        clearPending();
        deliverSuccess(requestId, result);
    }

    private void receiveCaptureFailure(String message) {
        final String requestId = pendingRequestId;
        if (requestId.isEmpty()) return;
        clearPending();
        deliverFailure(requestId, "instant_visible_error",
                message == null || message.trim().isEmpty()
                        ? "Instant Translate показал ошибку перевода"
                        : message.trim());
    }

    private void clearStalePendingIfNeeded() {
        if (pendingRequestId.isEmpty()) return;
        if (pendingStartedAtMs <= 0L
                || System.currentTimeMillis() - pendingStartedAtMs > STALE_PENDING_MS) {
            clearPending();
            InstantTranslateCaptureService.hideReaderCover();
        }
    }

    private void clearPending() {
        pendingRequestId = "";
        pendingSourceText = "";
        pendingStartedAtMs = 0L;
        InstantTranslateCaptureService.disarm();
    }

    static boolean isCaptureServiceEnabled(Context context) {
        String enabled = Settings.Secure.getString(
                context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (TextUtils.isEmpty(enabled)) return false;
        ComponentName expected = new ComponentName(context, InstantTranslateCaptureService.class);
        TextUtils.SimpleStringSplitter splitter = new TextUtils.SimpleStringSplitter(':');
        splitter.setString(enabled);
        while (splitter.hasNext()) {
            ComponentName current = ComponentName.unflattenFromString(splitter.next());
            if (expected.equals(current)) return true;
        }
        return false;
    }

    private void deliverSuccess(String requestId, String translation) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("ru", translation);
            payload.put("provider", "instant_translate_installed_app");
        } catch (JSONException ignored) {}
        deliverJs(requestId, true, payload.toString());
    }

    private void deliverFailure(String requestId, String code, String message) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("code", code == null ? "instant_translate" : code);
            payload.put("message", message == null ? "Instant Translate не сработал" : message);
        } catch (JSONException ignored) {}
        deliverJs(requestId, false, payload.toString());
    }

    private void deliverJs(String requestId, boolean ok, String payloadJson) {
        if (webView == null) return;
        final String script = "window.__readerInstantTranslateResolve&&window.__readerInstantTranslateResolve("
                + JSONObject.quote(requestId == null ? "" : requestId) + ","
                + (ok ? "true" : "false") + ","
                + JSONObject.quote(payloadJson == null ? "{}" : payloadJson) + ");";
        webView.post(() -> {
            try {
                webView.evaluateJavascript(script, null);
            } catch (Exception ignored) {}
        });
    }

    private String readable(Throwable error) {
        if (error == null) return "unknown error";
        String message = error.getMessage();
        return (message == null || message.trim().isEmpty())
                ? error.getClass().getSimpleName() : message;
    }

    void shutdown() {
        if (activeBridge.get() == this) activeBridge = new WeakReference<>(null);
        clearPending();
        InstantTranslateCaptureService.hideReaderCover();
    }
}
