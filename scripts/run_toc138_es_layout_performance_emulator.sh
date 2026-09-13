#!/usr/bin/env bash
set -euo pipefail

# Preserve every previously-green Spanish Android regression first.
bash scripts/run_toc137_es_card_status_emulator.sh

# Then verify the user-facing toc138 contract: justified book text, glosses outside
# horizontal line measurement, no chapter rebuild on word tap, and responsive
# Known/Unknown updates with the toc137 current-status card still intact.
python3 scripts/audit_toc138_es_layout_performance_live.py | tee runtime-audit/toc138-es-layout-performance-live.json
adb exec-out screencap -p > runtime-audit/toc138-es-layout-performance.png
