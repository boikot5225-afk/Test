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
 * Experimental bridge for Instant Translate's own AI Chat UI.
 *
 * This does not copy credentials or call the vendor backend directly. Reader AI
 * launches the user's installed, already-authorized Instant Translate app and an
 * AccessibilityService drives only its visible Chat UI while a frozen Reader
 * frame covers the external app.
 */
final class InstantTranslateChatBridge {
    static final String TARGET_PACKAGE = InstantTranslateBridge.TARGET_PACKAGE;

    private static final long STALE_PENDING_MS = 70_000L;
    private static volatile WeakReference<InstantTranslateChatBridge> activeBridge =
            new WeakReference<>(null);

    private final Activity activity;
    private final WebView webView;

    private String pendingRequestId = "";
    private String pendingSourceText = "";
    private long pendingStartedAtMs = 0L;

    InstantTranslateChatBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        activeBridge = new WeakReference<>(this);
    }

    @JavascriptInterface
    public void analyze(String requestId, String payloadJson) {
        final String safeId = requestId == null ? "" : requestId;
        final JSONObject payload;
        try {
            payload = new JSONObject(payloadJson == null ? "{}" : payloadJson);
        } catch (JSONException error) {
            deliverFailure(safeId, "bad_payload", "Некорректный запрос разбора");
            return;
        }

        final String sourceText = payload.optString("text", "").trim();
        final String prompt = payload.optString("prompt", "").trim();
        if (sourceText.isEmpty() || prompt.isEmpty()) {
            deliverFailure(safeId, "empty_text", "Пустой текст для грамматического разбора");
            return;
        }

        activity.runOnUiThread(() -> {
            clearStalePendingIfNeeded();
            if (!pendingRequestId.isEmpty()) {
                deliverFailure(safeId, "instant_chat_busy",
                        "Предыдущий запрос Instant AI ещё не завершён");
                return;
            }

            if (!isChatServiceEnabled(activity)) {
                deliverFailure(safeId, "chat_accessibility_required",
                        "Включи службу «Reader AI — Instant AI Chat» в Спец. возможностях и повтори разбор");
                Toast.makeText(activity,
                        "Один раз включи Reader AI — Instant AI Chat в Спец. возможностях",
                        Toast.LENGTH_LONG).show();
                try {
                    activity.startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
                } catch (Exception ignored) {}
                return;
            }

            Intent launchIntent;
            try {
                launchIntent = activity.getPackageManager().getLaunchIntentForPackage(TARGET_PACKAGE);
            } catch (Exception error) {
                launchIntent = null;
            }
            if (launchIntent == null) {
                deliverFailure(safeId, "instant_chat_not_installed",
                        "Не найден установленный Instant Translate");
                return;
            }

            pendingRequestId = safeId;
            pendingSourceText = sourceText;
            pendingStartedAtMs = System.currentTimeMillis();

            Bitmap snapshot = captureReaderSnapshot();
            if (snapshot != null) {
                InstantTranslateChatAccessibilityService.showReaderCover(snapshot);
            }
            InstantTranslateChatAccessibilityService.arm(prompt, sourceText);

            try {
                launchIntent.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
                activity.startActivity(launchIntent);
            } catch (Exception error) {
                clearPending();
                InstantTranslateChatAccessibilityService.hideReaderCover();
                deliverFailure(safeId, "instant_chat_launch_failed",
                        "Не удалось открыть Instant Translate: " + readable(error));
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
        } catch (Throwable ignored) {
            return null;
        }
    }

    @JavascriptInterface
    public void cancel(String requestId) {
        final String safeId = requestId == null ? "" : requestId;
        activity.runOnUiThread(() -> {
            if (!pendingRequestId.isEmpty() && pendingRequestId.equals(safeId)) {
                clearPending();
                InstantTranslateChatAccessibilityService.finishExternalWindowAndHide();
            }
        });
    }

    @JavascriptInterface
    public String status() {
        clearStalePendingIfNeeded();
        JSONObject out = new JSONObject();
        try {
            out.put("mode", "installed_app_chat_ui");
            out.put("accessibilityEnabled", isChatServiceEnabled(activity));
            out.put("pending", !pendingRequestId.isEmpty());
        } catch (JSONException ignored) {}
        return out.toString();
    }

    static void onChatCaptured(String responseText) {
        InstantTranslateChatBridge bridge = activeBridge.get();
        if (bridge != null) bridge.receiveChatResponse(responseText);
    }

    static void onChatCaptureFailed(String message) {
        InstantTranslateChatBridge bridge = activeBridge.get();
        if (bridge != null) bridge.receiveFailure(message);
    }

    private void receiveChatResponse(String responseText) {
        final String result = responseText == null ? "" : responseText.trim();
        final String requestId = pendingRequestId;
        if (requestId.isEmpty() || result.isEmpty()) return;
        clearPending();
        deliverSuccess(requestId, result);
    }

    private void receiveFailure(String message) {
        final String requestId = pendingRequestId;
        if (requestId.isEmpty()) return;
        clearPending();
        deliverFailure(requestId, "instant_chat_ui",
                message == null || message.trim().isEmpty()
                        ? "Instant AI Chat не вернул ответ"
                        : message.trim());
    }

    private void clearStalePendingIfNeeded() {
        if (pendingRequestId.isEmpty()) return;
        if (pendingStartedAtMs <= 0L
                || System.currentTimeMillis() - pendingStartedAtMs > STALE_PENDING_MS) {
            clearPending();
            InstantTranslateChatAccessibilityService.finishExternalWindowAndHide();
        }
    }

    private void clearPending() {
        pendingRequestId = "";
        pendingSourceText = "";
        pendingStartedAtMs = 0L;
        InstantTranslateChatAccessibilityService.disarm();
    }

    private static boolean isChatServiceEnabled(Context context) {
        String enabled = Settings.Secure.getString(
                context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (TextUtils.isEmpty(enabled)) return false;
        ComponentName expected = new ComponentName(context, InstantTranslateChatAccessibilityService.class);
        TextUtils.SimpleStringSplitter splitter = new TextUtils.SimpleStringSplitter(':');
        splitter.setString(enabled);
        while (splitter.hasNext()) {
            ComponentName current = ComponentName.unflattenFromString(splitter.next());
            if (expected.equals(current)) return true;
        }
        return false;
    }

    private void deliverSuccess(String requestId, String responseText) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("text", responseText);
            payload.put("provider", "instant_translate_chat_ui");
        } catch (JSONException ignored) {}
        deliverJs(requestId, true, payload.toString());
    }

    private void deliverFailure(String requestId, String code, String message) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("code", code == null ? "instant_chat" : code);
            payload.put("message", message == null ? "Instant AI Chat не сработал" : message);
        } catch (JSONException ignored) {}
        deliverJs(requestId, false, payload.toString());
    }

    private void deliverJs(String requestId, boolean ok, String payloadJson) {
        if (webView == null) return;
        final String script = "window.__readerInstantChatResolve&&window.__readerInstantChatResolve("
                + JSONObject.quote(requestId == null ? "" : requestId) + ","
                + (ok ? "true" : "false") + ","
                + JSONObject.quote(payloadJson == null ? "{}" : payloadJson) + ");";
        webView.post(() -> {
            try { webView.evaluateJavascript(script, null); }
            catch (Exception ignored) {}
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
        InstantTranslateChatAccessibilityService.hideReaderCover();
    }
}
