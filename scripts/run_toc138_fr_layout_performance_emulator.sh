#!/usr/bin/env bash
set -euo pipefail

# Keep the complete green toc137/toc136 Android suite first.
bash scripts/run_toc137_es_card_status_emulator.sh

# Then exercise the exact French reader problems from the user's recording:
# justified source text with Russian hints that do not alter horizontal layout,
# and instant Known/Unknown interaction against a large rendered chapter.
python3 scripts/audit_toc138_fr_layout_performance_live.py | tee runtime-audit/toc138-fr-layout-performance-live.json
adb exec-out screencap -p > runtime-audit/toc138-fr-layout-performance.png
