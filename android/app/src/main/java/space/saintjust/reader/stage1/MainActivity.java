package space.saintjust.reader.stage1;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.ServiceWorkerClientCompat;
import androidx.webkit.ServiceWorkerControllerCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Locale;

/** Thin native shell around the bundled Reader AI web app. */
public class MainActivity extends Activity {

    private static final String ASSET_ORIGIN = "https://appassets.androidplatform.net/";
    private static final String APP_URL = ASSET_ORIGIN + "assets/www/index.html";
    private static final String IMPORT_PATH = "/android-import/current";
    private static final String FALLBACK_MIME = "application/octet-stream";
    private static final int FILE_CHOOSER_REQUEST = 2201;
    private static final String SHELL_PREFS = "reader_shell_runtime";
    private static final String WEB_ASSET_VERSION_KEY = "web_asset_version";

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private boolean serviceWorkerClientInstalled = false;
    private ChineseResourceBridge chineseResourceBridge;
    private ChineseOfflineTranslateBridge chineseOfflineTranslateBridge;
    private EnglishResidualTranslateBridge englishResidualTranslateBridge;
    private EnglishContextTranslateBridge englishContextTranslateBridge;

    private Uri pendingImportUri;
    private String pendingImportName = "";
    private String pendingImportMime = "";
    private long pendingImportToken = 0;
    private boolean pageReady = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)
                && WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_SHOULD_INTERCEPT_REQUEST)) {
            ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(new ServiceWorkerClientCompat() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                    Uri requestUri = request.getUrl();
                    WebResourceResponse startupBypass = interceptNativeStartupDependency(requestUri);
                    if (startupBypass != null) {
                        return startupBypass;
                    }
                    if (!WebViewAssetLoader.DEFAULT_DOMAIN.equals(requestUri.getHost())) {
                        return null;
                    }
                    if (IMPORT_PATH.equals(requestUri.getPath())) {
                        return openPendingImportResponse();
                    }
                    return assetLoader.shouldInterceptRequest(requestUri);
                }
            });
            serviceWorkerClientInstalled = true;
        }

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(17, 17, 17));
        setContentView(webView, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        SharedPreferences shellPrefs = getSharedPreferences(SHELL_PREFS, MODE_PRIVATE);
        int cachedAssetVersion = shellPrefs.getInt(WEB_ASSET_VERSION_KEY, -1);
        if (cachedAssetVersion != BuildConfig.VERSION_CODE) {
            try {
                webView.clearCache(true);
            } catch (Exception ignored) {
                // A provider-specific cache failure must never stop the reader.
            }
            shellPrefs.edit().putInt(WEB_ASSET_VERSION_KEY, BuildConfig.VERSION_CODE).apply();
        }

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        // The interface exposes only read-only bundled dictionary lookups. Heavy
        // SQLite work happens on ChineseResourceBridge's background executor.
        chineseResourceBridge = new ChineseResourceBridge(this, webView);
        webView.addJavascriptInterface(chineseResourceBridge, "ReaderChineseResources");

        chineseOfflineTranslateBridge = new ChineseOfflineTranslateBridge(this, webView);
        webView.addJavascriptInterface(chineseOfflineTranslateBridge, "ReaderChineseTranslate");
        englishResidualTranslateBridge = new EnglishResidualTranslateBridge(this, webView);
        webView.addJavascriptInterface(englishResidualTranslateBridge, "ReaderEnglishResidualTranslate");
        englishContextTranslateBridge = new EnglishContextTranslateBridge(this, webView);
        webView.addJavascriptInterface(englishContextTranslateBridge, "ReaderEnglishContextTranslate");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri requestUri = request.getUrl();

                // index.html used to synchronously wait for several remote CDN files
                // before the first BODY node existed. When gstatic/jsDelivr/Google
                // Fonts were slow or blocked, the only thing Android could paint was
                // this Activity's #111 background: the reported blank dark screen.
                // firebase-config.js is bundled and installs the REST-compatible
                // Firebase adapter before those tags, so the native shell can safely
                // short-circuit the optional compat SDK during first paint.
                WebResourceResponse startupBypass = interceptNativeStartupDependency(requestUri);
                if (startupBypass != null) {
                    return startupBypass;
                }

                if (WebViewAssetLoader.DEFAULT_DOMAIN.equals(requestUri.getHost())
                        && IMPORT_PATH.equals(requestUri.getPath())) {
                    return openPendingImportResponse();
                }
                return assetLoader.shouldInterceptRequest(requestUri);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (url != null && url.startsWith(ASSET_ORIGIN)) {
                    pageReady = true;
                    dispatchPendingImport();
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;

                Intent intent;
                try {
                    intent = params.createIntent();
                } catch (Exception ignored) {
                    intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.setType("*/*");
                }
                intent.addCategory(Intent.CATEGORY_OPENABLE);

                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, "Не найден системный выбор файлов",
                            Toast.LENGTH_LONG).show();
                    return false;
                }
            }
        });

        captureExternalIntent(getIntent());

        boolean restored = false;
        if (savedInstanceState != null) {
            try {
                restored = webView.restoreState(savedInstanceState) != null;
            } catch (Exception ignored) {
                restored = false;
            }
        }
        if (!restored) {
            webView.loadUrl(APP_URL);
        }
    }

    /**
     * Fail fast for resources that must never be allowed to hold Android's first
     * paint hostage. The actual app/auth code is bundled in the APK.
     */
    private WebResourceResponse interceptNativeStartupDependency(Uri requestUri) {
        if (requestUri == null) {
            return null;
        }
        String host = requestUri.getHost();
        String path = requestUri.getPath();
        if (host == null) {
            return null;
        }

        if ("fonts.googleapis.com".equalsIgnoreCase(host)) {
            return textResponse("text/css", "/* Reader AI native: system-font startup fallback. */");
        }

        if ("www.gstatic.com".equalsIgnoreCase(host)
                && path != null && path.startsWith("/firebasejs/")) {
            return textResponse("application/javascript",
                    "// Reader AI native uses the bundled Firebase REST adapter during startup.\n");
        }

        if ("cdn.jsdelivr.net".equalsIgnoreCase(host) && path != null) {
            if (path.contains("/npm/firebase@")) {
                return textResponse("application/javascript",
                        "// Reader AI native uses the bundled Firebase REST adapter during startup.\n");
            }

            // XLSX is useful only when the user actually imports a spreadsheet.
            // Replace the parser-blocking request with a tiny loader that retries
            // it asynchronously after the page is visible. The query marker keeps
            // the later request from being intercepted a second time.
            if (path.contains("/npm/xlsx@")
                    && requestUri.getQueryParameter("readerAsync") == null) {
                Uri laterUri = requestUri.buildUpon()
                        .appendQueryParameter("readerAsync", "1")
                        .build();
                String source = JSONObject.quote(laterUri.toString());
                String loader = "(function(){"
                        + "function loadXlsx(){if(window.XLSX)return;"
                        + "var s=document.createElement('script');s.async=true;s.src=" + source + ";"
                        + "document.head.appendChild(s);}"
                        + "if(document.readyState==='complete'){setTimeout(loadXlsx,0);}"
                        + "else{window.addEventListener('load',loadXlsx,{once:true});}"
                        + "})();";
                return textResponse("application/javascript", loader);
            }
        }

        return null;
    }

    private WebResourceResponse textResponse(String mimeType, String body) {
        return new WebResourceResponse(mimeType, "utf-8",
                new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
    }

    /** Picks up a book handed to us by another app and queues it for the page. */
    private void captureExternalIntent(Intent intent) {
        if (intent == null) {
            return;
        }

        Uri uri = null;
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(action)) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                uri = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
            } else {
                uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            }
        }
        if (uri == null) {
            return;
        }

        pendingImportUri = uri;
        pendingImportName = displayName(uri);
        pendingImportMime = getContentResolver().getType(uri);
        if (pendingImportMime == null || pendingImportMime.isEmpty()) {
            pendingImportMime = mimeFromName(pendingImportName);
        }
        pendingImportToken = System.nanoTime();
        dispatchPendingImport();
    }

    private String displayName(Uri uri) {
        if ("content".equalsIgnoreCase(uri.getScheme())) {
            try (Cursor cursor = getContentResolver().query(
                    uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (index >= 0) {
                        String value = cursor.getString(index);
                        if (value != null && !value.trim().isEmpty()) {
                            return value;
                        }
                    }
                }
            } catch (Exception ignored) {
                // fall through to the path segment
            }
        }
        String segment = uri.getLastPathSegment();
        return (segment == null || segment.trim().isEmpty()) ? "book" : segment;
    }

    private String mimeFromName(String name) {
        String clean = name == null ? "" : name.toLowerCase(Locale.ROOT);
        if (clean.endsWith(".epub")) {
            return "application/epub+zip";
        }
        if (clean.endsWith(".fb2")) {
            return "application/x-fictionbook+xml";
        }
        String extension = MimeTypeMap.getFileExtensionFromUrl(clean);
        String detected = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
        return detected == null ? FALLBACK_MIME : detected;
    }

    private WebResourceResponse openPendingImportResponse() {
        Uri uri = pendingImportUri;
        if (uri == null) {
            return errorResponse(404, "Not Found", "");
        }
        try {
            InputStream stream = getContentResolver().openInputStream(uri);
            if (stream == null) {
                throw new IllegalStateException("empty stream");
            }
            return new WebResourceResponse(
                    pendingImportMime == null ? FALLBACK_MIME : pendingImportMime, null, stream);
        } catch (Exception error) {
            return errorResponse(500, "Read failed", String.valueOf(error.getMessage()));
        }
    }

    private WebResourceResponse errorResponse(int status, String reason, String body) {
        return new WebResourceResponse("text/plain", "utf-8", status, reason,
                Collections.emptyMap(),
                new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
    }

    private void dispatchPendingImport() {
        if (!pageReady || webView == null || pendingImportUri == null) {
            return;
        }
        try {
            JSONObject payload = new JSONObject();
            payload.put("name", pendingImportName);
            payload.put("mime", pendingImportMime);
            payload.put("url", ASSET_ORIGIN + "android-import/current?t=" + pendingImportToken);

            String script = "(function retryReaderImport(n){"
                    + "if(typeof window.readerImportAndroidFile==='function'){"
                    + "window.readerImportAndroidFile(" + payload + ");return;}"
                    + "if(n<300)setTimeout(function(){retryReaderImport(n+1)},100);"
                    + "})(0);";
            webView.evaluateJavascript(script, null);
        } catch (Exception e) {
            Toast.makeText(this, "Не удалось передать книгу в Reader AI",
                    Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureExternalIntent(intent);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || fileCallback == null) {
            return;
        }
        fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        fileCallback = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) {
            webView.saveState(outState);
        }
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView == null || !webView.canGoBack()) {
            super.onBackPressed();
        } else {
            webView.goBack();
        }
    }

    @Override
    protected void onDestroy() {
        if (serviceWorkerClientInstalled
                && WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)) {
            try {
                ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(null);
            } catch (Exception ignored) {
                // WebView provider changed or is already gone; nothing left to clean up.
            }
            serviceWorkerClientInstalled = false;
        }
        if (chineseResourceBridge != null) {
            chineseResourceBridge.shutdown();
            chineseResourceBridge = null;
        }
        if (chineseOfflineTranslateBridge != null) {
            chineseOfflineTranslateBridge.shutdown();
            chineseOfflineTranslateBridge = null;
        }
        if (englishResidualTranslateBridge != null) {
            englishResidualTranslateBridge.shutdown();
            englishResidualTranslateBridge = null;
        }
        if (englishContextTranslateBridge != null) {
            englishContextTranslateBridge.shutdown();
            englishContextTranslateBridge = null;
        }
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
