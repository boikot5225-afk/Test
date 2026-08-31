#!/usr/bin/env bash
set -euo pipefail
PKG=space.saintjust.reader.semanticstage1clean.formatfix.debug
ACT=space.saintjust.reader.stage1.MainActivity
APK="$(find android/app/build/outputs/apk/debug -name '*.apk' | head -1)"
test -f "$APK"

# Match Galaxy A54 logical device geometry while leaving the shipped Reader
# gesture code completely untouched.
adb shell wm size 1080x2340
adb shell wm density 420
adb shell wm size | tee runtime-audit/device-size.txt
adb shell wm density | tee runtime-audit/device-density.txt

adb install -r "$APK"
adb push runtime-audit/nada-toc123.epub /data/local/tmp/nada-toc123.epub
adb shell run-as "$PKG" cp /data/local/tmp/nada-toc123.epub cache/nada-toc123.epub
adb shell am force-stop "$PKG"
adb shell am start -W \
  -a android.intent.action.VIEW \
  -d "file:///data/user/0/${PKG}/cache/nada-toc123.epub" \
  -t application/epub+zip \
  -n "${PKG}/${ACT}" | tee runtime-audit/launch.txt
sleep 5
adb exec-out screencap -p > runtime-audit/toc123-00-import.png
PID="$(adb shell pidof "$PKG" | tr -d '\r')"
test -n "$PID"
adb forward tcp:9222 "localabstract:webview_devtools_remote_${PID}"
python3 scripts/bootstrap_toc123_french_reader_live.py
python3 scripts/audit_toc123_isolated_live.py
