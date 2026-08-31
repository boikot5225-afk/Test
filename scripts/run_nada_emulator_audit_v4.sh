#!/usr/bin/env bash
set -euo pipefail
PKG='space.saintjust.reader.semanticstage1clean.formatfix.debug'
ACT='space.saintjust.reader.stage1.MainActivity'
APK="$(find android/app/build/outputs/apk/debug -name '*.apk' | head -1)"
test -f "$APK"
adb install -r "$APK"
adb shell mkdir -p "/sdcard/Android/data/${PKG}/files"
adb push runtime-audit/nada-runtime.epub "/sdcard/Android/data/${PKG}/files/nada-runtime.epub"
adb shell am force-stop "$PKG"
adb shell am start -W -a android.intent.action.VIEW -d "file:///sdcard/Android/data/${PKG}/files/nada-runtime.epub" -t application/epub+zip -n "${PKG}/${ACT}" | tee runtime-audit/launch-v4.txt
sleep 6
adb exec-out screencap -p > runtime-audit/00-auth-v4.png
PID="$(adb shell pidof "$PKG" | tr -d '\r')"; test -n "$PID"
adb forward tcp:9222 "localabstract:webview_devtools_remote_${PID}"
python3 scripts/audit_nada_live_webview_v4.py
adb exec-out screencap -p > runtime-audit/01-reader-v4.png
