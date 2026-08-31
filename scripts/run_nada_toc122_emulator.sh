#!/usr/bin/env bash
set -euo pipefail
PKG=space.saintjust.reader.semanticstage1clean.formatfix.debug
ACT=space.saintjust.reader.stage1.MainActivity
APK="$(find android/app/build/outputs/apk/debug -name '*.apk' | head -1)"
test -f "$APK"
adb install -r "$APK"

# Exercise the same model a real Android file picker uses: a content:// URI
# backed by DocumentsProvider plus FLAG_GRANT_READ_URI_PERMISSION. Raw file://
# under /sdcard is deliberately not used here because scoped-storage access for
# shell-created paths is not representative of the user's file-manager flow.
adb shell mkdir -p /sdcard/Download
adb push runtime-audit/nada-runtime.epub /sdcard/Download/nada-runtime.epub
DOC_URI='content://com.android.externalstorage.documents/document/primary%3ADownload%2Fnada-runtime.epub'
# Prove the provider sees the file before blaming Reader AI.
adb shell content read --uri "$DOC_URI" >/dev/null
adb shell am force-stop "$PKG"
adb shell am start -W \
  -a android.intent.action.VIEW \
  -d "$DOC_URI" \
  -t application/epub+zip \
  -f 0x00000001 \
  -n "${PKG}/${ACT}" | tee runtime-audit/launch.txt
sleep 5
adb exec-out screencap -p > runtime-audit/00-import.png
PID="$(adb shell pidof "$PKG" | tr -d '\r')"
test -n "$PID"
adb forward tcp:9222 "localabstract:webview_devtools_remote_${PID}"
python3 scripts/audit_nada_toc122_live.py
adb exec-out screencap -p > runtime-audit/01-after-audit.png
