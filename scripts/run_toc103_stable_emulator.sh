#!/usr/bin/env bash
set -euo pipefail
PKG=space.saintjust.reader.semanticstage1clean.formatfix.debug
ACT=space.saintjust.reader.stage1.MainActivity
PRE=test-out/Reader-AI-toc103-preinstall-vc1011.apk
FINAL=unique-out/Reader-AI-77.42-toc103-stable-install-vc1012.apk

test -f "$PRE"
test -f "$FINAL"
mkdir -p runtime-audit

# Reproduce the user's actual installer situation: a Reader AI package with
# versionCode 1011 is already installed. The stable recovery APK must install
# over it normally, with no uninstall and no adb downgrade flag.
adb install -r "$PRE" | tee runtime-audit/install-vc1011.txt
grep -q 'Success' runtime-audit/install-vc1011.txt
adb install -r "$FINAL" | tee runtime-audit/install-vc1012-over-1011.txt
grep -q 'Success' runtime-audit/install-vc1012-over-1011.txt

# Confirm Android really reports the new version before testing the reader.
adb shell dumpsys package "$PKG" | grep -E 'versionCode=|versionName=' | head -4 | tee runtime-audit/package-after-upgrade.txt
grep -q 'versionCode=1012' runtime-audit/package-after-upgrade.txt

adb shell am force-stop "$PKG"
adb shell am start -W -n "${PKG}/${ACT}" | tee runtime-audit/launch.txt
sleep 5
adb exec-out screencap -p > runtime-audit/00-start.png
PID="$(adb shell pidof "$PKG" | tr -d '\r')"
test -n "$PID"
adb forward tcp:9222 "localabstract:webview_devtools_remote_${PID}"
python3 scripts/audit_toc103_pagination_live.py
adb exec-out screencap -p > runtime-audit/01-after-pagination.png
