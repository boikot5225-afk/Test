#!/usr/bin/env bash
set -euo pipefail

PKG=space.saintjust.reader.semanticstage1clean.formatfix.debug

stabilize_emulator_shell() {
  # The API-35 headless emulator can wedge its Launcher3/Quickstep process and
  # put a system "Quickstep isn't responding" dialog above Reader. That dialog
  # cancels ADB touch streams before Reader receives touchend; it is not a
  # Reader ANR. Keep the release gate focused on Reader by using three-button
  # navigation and restarting only the system launcher process.
  adb shell cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.threebutton >/dev/null 2>&1 || true
  adb shell settings put secure navigation_mode 0 >/dev/null 2>&1 || true
  adb shell am force-stop com.android.launcher3 >/dev/null 2>&1 || true
  adb shell input keyevent 4 >/dev/null 2>&1 || true
  sleep 1
}

quickstep_anr() {
  local xml last
  adb shell uiautomator dump /sdcard/toc138-window.xml >/dev/null 2>&1 || true
  xml="$(adb shell cat /sdcard/toc138-window.xml 2>/dev/null || true)"
  last="$(adb shell dumpsys activity lastanr 2>/dev/null || true)"
  printf '%s\n%s\n' "$xml" "$last" | grep -Eqi 'Quickstep|com\.android\.launcher3'
}

run_frozen_baseline() {
  bash scripts/run_toc137_es_card_status_emulator.sh
}

# Keep the complete green toc137/toc136 Android suite first. One retry is
# allowed only when Android itself reports Launcher3/Quickstep as the ANR owner.
# A Reader failure, delivered swipe failure, storage failure, etc. remains fatal.
stabilize_emulator_shell
if ! run_frozen_baseline; then
  if ! quickstep_anr; then
    echo 'toc138 frozen baseline failed without a Quickstep system ANR; not retrying' >&2
    exit 1
  fi
  echo 'toc138: recovered API-35 Quickstep system ANR; rerunning frozen baseline cleanly' >&2
  adb shell am force-stop com.android.launcher3 >/dev/null 2>&1 || true
  adb shell pm clear "$PKG" >/dev/null 2>&1 || true
  rm -f runtime-audit/toc125-swipe-failure.json runtime-audit/toc125-swipe-left-not-delivered.png runtime-audit/toc125-swipe-right-not-delivered.png
  stabilize_emulator_shell
  run_frozen_baseline
fi

# Then exercise the exact French reader problems from the user's recording:
# justified source text with Russian hints that do not alter horizontal layout,
# instant Known/Unknown interaction against a large rendered chapter, and the
# real readerOpenWordPanel path without its old next-frame full-chapter rebuild.
python3 scripts/audit_toc138_fr_layout_performance_live.py | tee runtime-audit/toc138-fr-layout-performance-live.json
python3 scripts/audit_toc138_fr_word_panel_jank_live.py | tee runtime-audit/toc138-fr-word-panel-jank-live.json
adb exec-out screencap -p > runtime-audit/toc138-fr-layout-performance.png
