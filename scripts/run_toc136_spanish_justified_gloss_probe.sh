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
adb shell am force-stop "$PKG"
adb shell am start -W -n "${PKG}/${ACT}" | tee runtime-audit/toc136-probe-launch.txt
sleep 5
PID="$(adb shell pidof "$PKG" | tr -d '\r')"
test -n "$PID"
adb forward --remove tcp:9222 >/dev/null 2>&1 || true
adb forward tcp:9222 "localabstract:webview_devtools_remote_${PID}"
set +e
python3 scripts/audit_toc136_spanish_justified_gloss_live.py | tee runtime-audit/toc136-spanish-justified-gloss-live.json
AUDIT_RC=${PIPESTATUS[0]}
adb exec-out screencap -p > runtime-audit/toc136-spanish-justified-gloss.png
set -e
exit "$AUDIT_RC"
