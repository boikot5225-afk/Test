#!/usr/bin/env bash
set -euo pipefail
PKG=space.saintjust.reader.semanticstage1clean.formatfix.debug
ACT=space.saintjust.reader.stage1.MainActivity
APK="$(find android/app/build/outputs/apk/debug -name '*.apk' | head -1)"
test -f "$APK"

# Match the Galaxy A54 viewport instead of accepting a Pixel-6-only gesture.
adb shell wm size 1080x2340
adb shell wm density 420
adb shell wm size | tee runtime-audit/device-wm-size.txt
adb shell wm density | tee runtime-audit/device-wm-density.txt

# Headless AOSP occasionally shows a launcher/Quickstep ANR over the foreground
# app. That system dialog consumed the first realistic 950 ms swipe and made the
# Reader look inert even though the gesture never reached WebView. Suppress such
# environment dialogs and fail explicitly later if one still appears.
adb shell settings put global hide_error_dialogs 1 || true
adb shell settings put global anr_show_background 0 || true
adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1 || true

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
# Quickstep is irrelevant once Reader AI owns the foreground. If this emulator
# image has it, stop the flaky launcher process so it cannot raise a late ANR.
if adb shell pm list packages | grep -q '^package:com.android.launcher3'; then
  adb shell am force-stop com.android.launcher3 || true
fi
adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1 || true
adb exec-out screencap -p > runtime-audit/00-import.png
PID="$(adb shell pidof "$PKG" | tr -d '\r')"
test -n "$PID"
adb forward tcp:9222 "localabstract:webview_devtools_remote_${PID}"

# Reach the real visible French Reader via the same guest/import path a clean
# install uses. Keep that setup separate from the actual swipe assertion.
python3 scripts/bootstrap_toc122_french_reader_live.py

# Hard stop against the previous false-positive path: if Android/WebView reports
# reduced motion, pages-mode.js completes flips immediately and we have not
# exercised the production animation race at all.
python3 scripts/assert_toc122_real_motion.py | tee runtime-audit/motion-gate.txt

# Real page-turn acceptance: production flip animation, human-duration swipes,
# stale-selection state, a same-chapter re-render during the flip, and repeated
# left/right turns. No JavaScript next()/prev() is used to perform the gesture.
python3 scripts/audit_toc122_pagination_live.py

# Then run the existing French lexical/context/layout regression suite.
python3 scripts/audit_nada_toc122_live.py
adb exec-out screencap -p > runtime-audit/06-after-french-audit.png
