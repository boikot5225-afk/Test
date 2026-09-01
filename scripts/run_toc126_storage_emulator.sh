#!/usr/bin/env bash
set -euo pipefail
PKG=space.saintjust.reader.semanticstage1clean.formatfix.debug
ACT=space.saintjust.reader.stage1.MainActivity
APK="$(find android/app/build/outputs/apk/debug -name '*.apk' | head -1)"
test -f "$APK"
mkdir -p runtime-audit

adb shell wm size 1080x2340
adb shell wm density 420
adb install -r "$APK"

# First boot: enter real guest mode, then seed a legacy full localStorage library.
adb shell am force-stop "$PKG"
adb shell am start -W -n "${PKG}/${ACT}" | tee runtime-audit/toc126-launch-seed.txt
sleep 4
PID="$(adb shell pidof "$PKG" | tr -d '\r')"
test -n "$PID"
adb forward --remove tcp:9222 >/dev/null 2>&1 || true
adb forward tcp:9222 "localabstract:webview_devtools_remote_${PID}"
python3 scripts/prepare_toc126_legacy_storage.py | tee runtime-audit/toc126-legacy-seed.json

# Import through the same ACTION_VIEW/content hand-off used by Android users.
adb push runtime-audit/toc126-storage-audit.epub /data/local/tmp/toc126-storage-audit.epub
adb shell run-as "$PKG" cp /data/local/tmp/toc126-storage-audit.epub cache/toc126-storage-audit.epub
adb shell am force-stop "$PKG"
adb shell am start -W \
  -a android.intent.action.VIEW \
  -d "file:///data/user/0/${PKG}/cache/toc126-storage-audit.epub" \
  -t application/epub+zip \
  -n "${PKG}/${ACT}" | tee runtime-audit/toc126-launch-import.txt
sleep 7
PID="$(adb shell pidof "$PKG" | tr -d '\r')"
test -n "$PID"
adb forward --remove tcp:9222 >/dev/null 2>&1 || true
adb forward tcp:9222 "localabstract:webview_devtools_remote_${PID}"
adb exec-out screencap -p > runtime-audit/toc126-01-after-import.png
python3 scripts/audit_toc126_storage_import_live.py
adb shell dumpsys meminfo "$PKG" > runtime-audit/toc126-meminfo-after-import.txt || true

# Frozen Reader gesture still has to work after the storage/import rewrite.
python3 scripts/audit_toc125_frozen_swipe.py

# Real process restart: IDB must restore the full book and cursor from the small index.
adb shell am force-stop "$PKG"
adb shell am start -W -n "${PKG}/${ACT}" | tee runtime-audit/toc126-launch-restart.txt
sleep 5
PID="$(adb shell pidof "$PKG" | tr -d '\r')"
test -n "$PID"
adb forward --remove tcp:9222 >/dev/null 2>&1 || true
adb forward tcp:9222 "localabstract:webview_devtools_remote_${PID}"
python3 scripts/audit_toc126_storage_restart.py
adb exec-out screencap -p > runtime-audit/toc126-99-after-restart-delete.png
