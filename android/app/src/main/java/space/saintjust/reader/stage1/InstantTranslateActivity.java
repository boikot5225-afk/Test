package space.saintjust.reader.stage1;

import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;

/**
 * Keeps the stable Reader shell untouched and layers the experimental
 * Instant Translate AI compatibility bridge on top of it.
 */
public final class InstantTranslateActivity extends MainActivity {
    private static final String BRIDGE_SCRIPT =
            "https://appassets.androidplatform.net/assets/reader-instant-translate-bridge.js";

    private WebView readerWebView;
    private InstantTranslateBridge instantTranslateBridge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        readerWebView = findWebView(getWindow().getDecorView());
        if (readerWebView == null) return;

        instantTranslateBridge = new InstantTranslateBridge(this, readerWebView);
        readerWebView.addJavascriptInterface(instantTranslateBridge, "ReaderInstantTranslate");
        injectBridgeScriptWhenReady(0);
    }

    private void injectBridgeScriptWhenReady(int attempt) {
        WebView view = readerWebView;
        if (view == null || attempt > 160) return;
        String source = "(function(){"
                + "if(!document||!document.head)return 'wait';"
                + "if(window.__readerInstantTranslateLoaderAdded)return 'ok';"
                + "window.__readerInstantTranslateLoaderAdded=true;"
                + "var s=document.createElement('script');s.src='" + BRIDGE_SCRIPT + "';s.async=true;"
                + "s.onerror=function(){window.__readerInstantTranslateLoaderAdded=false;};"
                + "document.head.appendChild(s);return 'ok';"
                + "})();";
        try {
            view.evaluateJavascript(source, result -> {
                if (result == null || !result.contains("ok")) {
                    view.postDelayed(() -> injectBridgeScriptWhenReady(attempt + 1), 150);
                }
            });
        } catch (Exception ignored) {
            view.postDelayed(() -> injectBridgeScriptWhenReady(attempt + 1), 150);
        }
    }

    private WebView findWebView(View root) {
        if (root instanceof WebView) return (WebView) root;
        if (!(root instanceof ViewGroup)) return null;
        ViewGroup group = (ViewGroup) root;
        for (int i = 0; i < group.getChildCount(); i++) {
            WebView found = findWebView(group.getChildAt(i));
            if (found != null) return found;
        }
        return null;
    }

    @Override
    protected void onDestroy() {
        if (instantTranslateBridge != null) {
            instantTranslateBridge.shutdown();
            instantTranslateBridge = null;
        }
        readerWebView = null;
        super.onDestroy();
    }
}
