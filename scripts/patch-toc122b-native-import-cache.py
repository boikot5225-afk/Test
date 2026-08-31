#!/usr/bin/env python3
from pathlib import Path

p = Path('android/app/src/main/java/space/saintjust/reader/stage1/MainActivity.java')
s = p.read_text(encoding='utf-8')

def once(old, new, label):
    global s
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 anchor, got {count}')
    s = s.replace(old, new, 1)

once(
    'import java.io.FileInputStream;\nimport java.io.InputStream;',
    'import java.io.FileInputStream;\nimport java.io.FileOutputStream;\nimport java.io.InputStream;\nimport java.io.OutputStream;',
    'cache stream imports',
)
once(
    '    private Uri pendingImportUri;\n    private String pendingImportName = "";\n    private String pendingImportMime = "";\n    private long pendingImportToken = 0;',
    '    private Uri pendingImportUri;\n    private File pendingImportFile;\n    private String pendingImportError = "";\n    private String pendingImportName = "";\n    private String pendingImportMime = "";\n    private long pendingImportToken = 0;',
    'pending cached import fields',
)
old_capture = '''        pendingImportUri = uri;
        pendingImportName = displayName(uri);
        pendingImportMime = getContentResolver().getType(uri);
        if (pendingImportMime == null || pendingImportMime.isEmpty()) {
            pendingImportMime = mimeFromName(pendingImportName);
        }
        pendingImportToken = System.nanoTime();
        dispatchPendingImport();
    }
'''
new_capture = '''        pendingImportUri = uri;
        pendingImportFile = null;
        pendingImportError = "";
        pendingImportName = displayName(uri);
        try {
            pendingImportMime = getContentResolver().getType(uri);
        } catch (Exception ignored) {
            pendingImportMime = null;
        }
        if (pendingImportMime == null || pendingImportMime.isEmpty()) {
            pendingImportMime = mimeFromName(pendingImportName);
        }
        pendingImportToken = System.nanoTime();
        final long token = pendingImportToken;
        final Uri sourceUri = uri;

        // Do not keep a foreign content:// grant or file:// path alive until a
        // later WebView request. Copy the book into Reader AI's private cache as
        // soon as ACTION_VIEW/ACTION_SEND arrives. The WebView then reads only a
        // file owned by this app, so Android 15 scoped storage and URI grant
        // lifetime cannot turn a valid import into /android-import/current 500.
        new Thread(() -> cachePendingImport(sourceUri, token), "reader-import-cache").start();
    }

    private InputStream openExternalImportStream(Uri uri) throws Exception {
        if (uri == null) {
            throw new IllegalStateException("missing import uri");
        }
        if ("file".equalsIgnoreCase(uri.getScheme())) {
            String path = uri.getPath();
            if (path == null || path.trim().isEmpty()) {
                throw new IllegalStateException("empty file path");
            }
            return new FileInputStream(new File(path));
        }
        InputStream stream = getContentResolver().openInputStream(uri);
        if (stream == null) {
            throw new IllegalStateException("empty content stream");
        }
        return stream;
    }

    private void cachePendingImport(Uri sourceUri, long token) {
        File target = new File(getCacheDir(), "reader-android-import-" + token + ".bin");
        try (InputStream input = openExternalImportStream(sourceUri);
             OutputStream output = new FileOutputStream(target)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            output.flush();
            if (token != pendingImportToken) {
                // A newer ACTION_VIEW arrived while this copy was running.
                // Never let the old book replace the current request.
                target.delete();
                return;
            }
            pendingImportFile = target;
            pendingImportError = "";
        } catch (Exception error) {
            target.delete();
            if (token != pendingImportToken) {
                return;
            }
            pendingImportFile = null;
            pendingImportError = error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage());
        }
        runOnUiThread(this::dispatchPendingImport);
    }
'''
once(old_capture, new_capture, 'cache external intent immediately')
old_open = '''    private WebResourceResponse openPendingImportResponse() {
        Uri uri = pendingImportUri;
        if (uri == null) {
            return errorResponse(404, "Not Found", "");
        }
        try {
            InputStream stream;
            if ("file".equalsIgnoreCase(uri.getScheme())) {
                String path = uri.getPath();
                if (path == null || path.trim().isEmpty()) throw new IllegalStateException("empty file path");
                stream = new FileInputStream(new File(path));
            } else {
                stream = getContentResolver().openInputStream(uri);
            }
            if (stream == null) {
                throw new IllegalStateException("empty stream");
            }
            return new WebResourceResponse(
                    pendingImportMime == null ? FALLBACK_MIME : pendingImportMime, null, stream);
        } catch (Exception error) {
            return errorResponse(500, "Read failed", String.valueOf(error.getMessage()));
        }
    }
'''
new_open = '''    private WebResourceResponse openPendingImportResponse() {
        File cached = pendingImportFile;
        if (cached == null) {
            if (pendingImportError != null && !pendingImportError.isEmpty()) {
                return errorResponse(500, "Read failed", pendingImportError);
            }
            return errorResponse(503, "Import not ready", "Reader AI is still caching the external book");
        }
        try {
            return new WebResourceResponse(
                    pendingImportMime == null ? FALLBACK_MIME : pendingImportMime,
                    null,
                    new FileInputStream(cached));
        } catch (Exception error) {
            return errorResponse(500, "Read failed",
                    error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage()));
        }
    }
'''
once(old_open, new_open, 'serve private cached import')
once(
    '        if (!pageReady || webView == null || pendingImportUri == null) {\n            return;\n        }',
    '        if (!pageReady || webView == null || pendingImportUri == null) {\n            return;\n        }\n        if (pendingImportFile == null && (pendingImportError == null || pendingImportError.isEmpty())) {\n            return;\n        }',
    'dispatch only after cache completes',
)
once(
    '        if (webView != null) {\n            webView.loadUrl("about:blank");',
    '        if (pendingImportFile != null) {\n            pendingImportFile.delete();\n            pendingImportFile = null;\n        }\n        if (webView != null) {\n            webView.loadUrl("about:blank");',
    'delete cached import on destroy',
)

p.write_text(s, encoding='utf-8')
print('toc122b native ACTION_VIEW cache bridge applied')
