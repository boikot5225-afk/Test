#!/usr/bin/env bash
set -euo pipefail
PKG=space.saintjust.reader.semanticstage1clean.formatfix.debug
ACT=space.saintjust.reader.stage1.MainActivity
APK="$(find android/app/build/outputs/apk/debug -name '*.apk' | head -1)"
test -f "$APK"
adb install -r "$APK"

# Put the fixture in Reader AI's own private cache. The debug package is
# debuggable, so run-as lets CI create exactly the file the Activity itself can
# read. This avoids Android 15 shell/scoped-storage restrictions while still
# exercising ACTION_VIEW -> native cache bridge -> /android-import/current ->
# EPUB parser -> actual French reader runtime.
adb push runtime-audit/nada-runtime.epub /data/local/tmp/nada-runtime.epub
adb shell run-as "$PKG" cp /data/local/tmp/nada-runtime.epub cache/nada-runtime.epub
adb shell run-as "$PKG" ls -l cache/nada-runtime.epub
PRIVATE_URI="file:///data/user/0/${PKG}/cache/nada-runtime.epub"
adb shell am force-stop "$PKG"
adb shell am start -W \
  -a android.intent.action.VIEW \
  -d "$PRIVATE_URI" \
  -t application/epub+zip \
  -n "${PKG}/${ACT}" | tee runtime-audit/launch.txt
sleep 5
adb exec-out screencap -p > runtime-audit/00-import.png
PID="$(adb shell pidof "$PKG" | tr -d '\r')"
test -n "$PID"
adb forward tcp:9222 "localabstract:webview_devtools_remote_${PID}"

# Reader acceptance comes first. This is a real Android touchscreen gesture on
# the visible French page, not a JavaScript next()/prev() call.
python3 scripts/audit_toc122_pagination_live.py

# Then run the existing French lexical/context/layout regression suite.
python3 scripts/audit_nada_toc122_live.py
adb exec-out screencap -p > runtime-audit/05-after-french-audit.png
