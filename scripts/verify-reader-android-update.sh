#!/usr/bin/env bash
set -euo pipefail

PACKAGE='space.saintjust.reader.semanticstage1clean.debug'
ACTIVITY='space.saintjust.reader.stage1.MainActivity'
BASELINE_APK='dist/Reader-AI-v77.31-Broken-Baseline.apk'
FIXED_APK='dist/Reader-AI-EPUB-Stage1-Clean.apk'
MARKER_VALUE='reader-update-data-preserved'

test -f "$BASELINE_APK"
test -f "$FIXED_APK"

adb install "$BASELINE_APK"
adb shell "run-as '$PACKAGE' sh -c 'mkdir -p files && printf %s \"$MARKER_VALUE\" > files/update-marker'"

adb install -r "$FIXED_APK"

installed_marker="$(
  adb shell "run-as '$PACKAGE' sh -c 'cat files/update-marker'" |
    tr -d '\r'
)"
test "$installed_marker" = "$MARKER_VALUE"

adb shell dumpsys package "$PACKAGE" | tee /tmp/reader-package.txt
grep -Eq 'versionCode=10([[:space:]]|$)' /tmp/reader-package.txt
grep -F 'versionName=semantic-v77.32' /tmp/reader-package.txt

adb logcat -c
adb shell am force-stop "$PACKAGE"
adb shell am start -n "$PACKAGE/$ACTIVITY"
sleep 45

adb shell uiautomator dump /data/local/tmp/reader-update-ui.xml
adb pull /data/local/tmp/reader-update-ui.xml dist/android-update-ui.xml
adb exec-out screencap -p > dist/android-update-screen.png
adb logcat -d > dist/android-update-logcat.txt

if grep -Fq 'Reader AI — запуск...' dist/android-update-ui.xml; then
  echo 'Reader AI is still stuck on the startup overlay.' >&2
  exit 1
fi

if grep -Fq 'Сбой запуска Reader AI' dist/android-update-ui.xml; then
  echo 'Reader AI reported a startup module failure.' >&2
  exit 1
fi

if ! grep -Eq 'v77\.32-startup-repair|Войти|Главная|Читать' dist/android-update-ui.xml; then
  echo 'Reader AI did not expose a usable post-startup screen.' >&2
  exit 1
fi

if grep -Eq 'FATAL EXCEPTION|SyntaxError:|Warning: truncated output' dist/android-update-logcat.txt; then
  echo 'Android or WebView logged a fatal startup error.' >&2
  exit 1
fi

echo 'Android update verification passed: package data survived and v77.32 reached a usable screen.'
