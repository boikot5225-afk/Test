#!/usr/bin/env bash
set -euo pipefail

ROOT="$PWD"
APP="$ROOT/.reader-a54-v8-android"
BASE_APP="$ROOT/.stage1-android"
GENERATOR="/tmp/generate-reader-a54-base.sh"

rm -rf "$APP" "$BASE_APP"

python3 - <<'PY'
from pathlib import Path

source = Path('.github/workflows/reader-stage1-android-apk.yml').read_text()
marker = '      - name: Generate isolated WebView wrapper\n'
start = source.index(marker) + len(marker)
run_marker = '        run: |\n'
start = source.index(run_marker, start) + len(run_marker)
end = source.index('\n      - name: Build debug APK', start)
lines = source[start:end].splitlines()
script = '\n'.join(line[10:] if line.startswith('          ') else line for line in lines) + '\n'
Path('/tmp/generate-reader-a54-base.sh').write_text(script)
PY

bash "$GENERATOR"
mv "$BASE_APP" "$APP"

JAVA_FILE="$APP/app/src/main/java/space/saintjust/reader/stage1/MainActivity.java"
BUILD_FILE="$APP/app/build.gradle"
MANIFEST_FILE="$APP/app/src/main/AndroidManifest.xml"
ASSETS_ROOT="$APP/app/src/main/assets"
WWW="$ASSETS_ROOT/www"

sed -i 's#https://appassets.androidplatform.net/assets/index.html#https://appassets.androidplatform.net/assets/www/index.html?nativeInsets=1#' "$JAVA_FILE"
sed -i "s/applicationId 'space.saintjust.reader.stage1'/applicationId 'space.saintjust.reader.lingqa54'/" "$BUILD_FILE"
sed -i 's/versionCode 2/versionCode 13/' "$BUILD_FILE"
sed -i "s/versionName 'stage1-test'/versionName 'lingq-a54-v0.8.0'/" "$BUILD_FILE"
sed -i "/implementation 'androidx.annotation:annotation:1.9.1'/a\    implementation 'androidx.core:core:1.15.0'" "$BUILD_FILE"
sed -i 's/Reader AI Stage 1/Reader AI LingQ A54/' "$MANIFEST_FILE"

python3 - <<'PY'
from pathlib import Path
import re

java_file = Path('.reader-a54-v8-android/app/src/main/java/space/saintjust/reader/stage1/MainActivity.java')
source = java_file.read_text()

if 'import android.widget.FrameLayout;' not in source:
    source = source.replace(
        'import android.widget.Toast;\n',
        'import android.widget.FrameLayout;\nimport android.widget.Toast;\n',
        1,
    )

if 'import androidx.core.view.WindowInsetsCompat;' not in source:
    source = source.replace(
        'import androidx.annotation.Nullable;\n',
        'import androidx.annotation.Nullable;\n'
        'import androidx.core.graphics.Insets;\n'
        'import androidx.core.view.ViewCompat;\n'
        'import androidx.core.view.WindowInsetsCompat;\n',
        1,
    )

pattern = re.compile(
    r'(?P<indent>^[ \t]*)webView = new WebView\(this\);\n'
    r'^[ \t]*webView\.setBackgroundColor\(Color\.rgb\(17, 17, 17\)\);\n'
    r'^[ \t]*setContentView\(webView, new ViewGroup\.LayoutParams\(\n'
    r'^[ \t]*ViewGroup\.LayoutParams\.MATCH_PARENT,\n'
    r'^[ \t]*ViewGroup\.LayoutParams\.MATCH_PARENT\n'
    r'^[ \t]*\)\);',
    re.MULTILINE,
)
match = pattern.search(source)
if not match:
    marker = 'webView = new WebView(this);'
    pos = source.find(marker)
    context = source[max(0, pos - 180):pos + 420] if pos >= 0 else 'marker not found'
    raise SystemExit(f'MainActivity WebView root block not found. Context:\n{context}')

indent = match.group('indent')
lines = [
    'FrameLayout root = new FrameLayout(this);',
    'root.setBackgroundColor(Color.rgb(17, 17, 17));',
    '',
    'webView = new WebView(this);',
    'webView.setBackgroundColor(Color.rgb(17, 17, 17));',
    'root.addView(webView, new FrameLayout.LayoutParams(',
    '  ViewGroup.LayoutParams.MATCH_PARENT,',
    '  ViewGroup.LayoutParams.MATCH_PARENT',
    '));',
    '',
    'ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {',
    '  Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());',
    '  view.setPadding(bars.left, bars.top, bars.right, bars.bottom);',
    '  return WindowInsetsCompat.CONSUMED;',
    '});',
    'setContentView(root, new ViewGroup.LayoutParams(',
    '  ViewGroup.LayoutParams.MATCH_PARENT,',
    '  ViewGroup.LayoutParams.MATCH_PARENT',
    '));',
    'ViewCompat.requestApplyInsets(root);',
]
replacement = '\n'.join(indent + line if line else '' for line in lines)
source = pattern.sub(replacement, source, count=1)
java_file.write_text(source)
PY

# Build-time assertions. A mismatch must fail here, never on the phone.
test -f "$WWW/index.html"
test ! -f "$ASSETS_ROOT/index.html"
grep -F 'private static final String APP_URL = "https://appassets.androidplatform.net/assets/www/index.html?nativeInsets=1";' "$JAVA_FILE"
! grep -Fq 'private static final String APP_URL = "https://appassets.androidplatform.net/assets/index.html";' "$JAVA_FILE"
grep -F 'ViewCompat.setOnApplyWindowInsetsListener' "$JAVA_FILE"
grep -F 'WindowInsetsCompat.Type.systemBars()' "$JAVA_FILE"
grep -F "applicationId 'space.saintjust.reader.lingqa54'" "$BUILD_FILE"
grep -F 'versionCode 13' "$BUILD_FILE"
grep -F "versionName 'lingq-a54-v0.8.0'" "$BUILD_FILE"
grep -F "implementation 'androidx.core:core:1.15.0'" "$BUILD_FILE"

test -f "$WWW/js/lingq-reader-restore-v6.js"
test -f "$WWW/js/reader-mobile-galaxy-a54-v7.js"
test -f "$WWW/js/reader-mobile-galaxy-a54-search-v71.js"
test -f "$WWW/js/reader-mobile-galaxy-a54-reading-v8.js"
test -f "$WWW/js/reader/pages-mode.js"
test -f "$WWW/js/reader/display.js"

node --check "$WWW/js/lingq-reader-restore-v6.js"
node --check "$WWW/js/reader-mobile-galaxy-a54-v7.js"
node --check "$WWW/js/reader-mobile-galaxy-a54-search-v71.js"
node --check "$WWW/js/reader-mobile-galaxy-a54-reading-v8.js"

echo "Galaxy A54 v0.8 wrapper prepared successfully"
