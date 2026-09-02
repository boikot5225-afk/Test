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

# localStorage.setItem() is synchronous to JavaScript, but Android WebView's
# backing LevelDB may still be flushing a multi-megabyte value when the process
# is killed. A test that force-stops immediately can therefore manufacture a
# fake migration loss before the next process even starts. Give WebView time to
# flush, then independently re-read the exact full legacy book before killing
# the process. If this check fails, ACTION_VIEW is never launched and the
# failure is correctly classified as a seed/harness failure.
sleep 3
python3 scripts/audit_toc126_legacy_seed_before_stop.py | tee runtime-audit/toc126-legacy-pre-stop.json

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

# Real process restart: IDB must restore the full book and cursor from the small index.
adb shell am force-stop "$PKG"
adb shell am start -W -n "${PKG}/${ACT}" | tee runtime-audit/toc126-launch-restart.txt
sleep 5
PID="$(adb shell pidof "$PKG" | tr -d '\r')"
test -n "$PID"
adb forward --remove tcp:9222 >/dev/null 2>&1 || true
adb forward tcp:9222 "localabstract:webview_devtools_remote_${PID}"
python3 scripts/audit_toc126_storage_restart.py

# Only after restart has proved the saved cursor may the physical gesture
# intentionally change it: page 0 -> 1 -> 0.
#
# GitHub's Android emulator can occasionally cancel an ADB-injected gesture
# while a system ANR/GPU overlay owns the surface. Retry the WHOLE physical
# swipe audit only for that delivery-class failure. A complete touch sequence
# that reaches Reader but fails to turn a page is a real Reader failure and is
# never retried here.
swipe_ok=0
for swipe_gate_attempt in 1 2 3; do
  rm -f runtime-audit/toc125-swipe-failure.json
  if python3 scripts/audit_toc125_frozen_swipe.py; then
    swipe_ok=1
    break
  fi

  swipe_phase="$(python3 - <<'PY'
import json, pathlib
p = pathlib.Path('runtime-audit/toc125-swipe-failure.json')
try:
    print(json.loads(p.read_text(encoding='utf-8')).get('phase', ''))
except Exception:
    print('')
PY
)"
  case "$swipe_phase" in
    left-touch-delivery|right-touch-delivery)
      echo "physical swipe delivery retry ${swipe_gate_attempt}/3 after ${swipe_phase}" >&2
      adb shell input keyevent 4 >/dev/null 2>&1 || true
      sleep 1
      adb shell am start -W -n "${PKG}/${ACT}" >/dev/null 2>&1 || true
      sleep 2
      PID="$(adb shell pidof "$PKG" | tr -d '\r')"
      test -n "$PID"
      adb forward --remove tcp:9222 >/dev/null 2>&1 || true
      adb forward tcp:9222 "localabstract:webview_devtools_remote_${PID}"
      ;;
    *)
      echo "physical swipe Reader failure is not retryable: ${swipe_phase:-unknown}" >&2
      exit 1
      ;;
  esac
done
test "$swipe_ok" -eq 1

# Ordinary per-book deletion must preserve the unrelated migrated book.
python3 scripts/audit_toc126_storage_delete.py
adb exec-out screencap -p > runtime-audit/toc126-99-after-restart-delete.png

# Concurrent independent library-store module instances must not clobber the
# shared IndexedDB index. This mirrors the real ?v=1/?v=2 coexistence.
python3 scripts/audit_toc132_idb_index_race.py | tee runtime-audit/toc132-idb-index-race.json

# Manual Library -> Add EPUB regression.
python3 scripts/audit_toc127_manual_import_ui.py
adb exec-out screencap -p > runtime-audit/toc127-100-after-manual-import.png

# Audio -> EPUB stale-state / latest selection regression.
python3 scripts/audit_toc128_audio_epub_reuse.py
adb exec-out screencap -p > runtime-audit/toc128-110-after-audio-epub-reuse.png

# toc131 decorative chapter-opening integrity.
python3 scripts/audit_toc131_epub_dropcap_live.py | tee runtime-audit/toc131-epub-dropcap-live.log

# toc130 mandatory French assets and live vocabulary.
python3 scripts/audit_toc130_french_assets_live.py | tee runtime-audit/toc130-french-assets-live.json
adb exec-out screencap -p > runtime-audit/toc130-120-french-vocabulary.png

# toc132: English keeps Migaku/WikDict first paint but gains French-style
# paragraph batching. This runs LAST: a new English feature is not allowed to
# mask import, EPUB integrity or French regressions above.
python3 scripts/audit_toc132_english_context_live.py | tee runtime-audit/toc132-english-context-live.json
adb exec-out screencap -p > runtime-audit/toc132-130-english-context.png
