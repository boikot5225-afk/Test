#!/usr/bin/env bash
set -euo pipefail
PKG=space.saintjust.reader.semanticstage1clean.formatfix.debug
ACT=space.saintjust.reader.stage1.MainActivity
APK="$(find android/app/build/outputs/apk/debug -name '*.apk' | head -1)"
test -f "$APK"
adb install -r "$APK"
# Use the app's own external-files directory: this is readable on Android 15 and
# exercises MainActivity's ACTION_VIEW file:// path without broad storage grants.
adb shell mkdir -p "/sdcard/Android/data/${PKG}/files"
adb push runtime-audit/nada-runtime.epub "/sdcard/Android/data/${PKG}/files/nada-runtime.epub"
adb shell am force-stop "$PKG"
adb shell am start -W -a android.intent.action.VIEW -d "file:///sdcard/Android/data/${PKG}/files/nada-runtime.epub" -t application/epub+zip -n "${PKG}/${ACT}" | tee runtime-audit/launch.txt
sleep 5
adb exec-out screencap -p > runtime-audit/00-import.png
PID="$(adb shell pidof "$PKG" | tr -d '\r')"
test -n "$PID"
adb forward tcp:9222 "localabstract:webview_devtools_remote_${PID}"
python3 scripts/audit_nada_toc122_live.py
adb exec-out screencap -p > runtime-audit/01-after-audit.png
