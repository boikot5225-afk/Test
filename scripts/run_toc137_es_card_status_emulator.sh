#!/usr/bin/env bash
set -euo pipefail

# Keep the complete green toc136 Android suite first.
bash scripts/run_toc136_spanish_release_emulator.sh

# Then reproduce the exact user-facing regression: French owns its panel hook,
# Spanish opens a lazy word card afterwards, and the current Known/Unknown
# status must still be visible and owned by Spanish.
python3 scripts/audit_toc137_es_card_status_live.py | tee runtime-audit/toc137-es-card-status-live.json
adb exec-out screencap -p > runtime-audit/toc137-160-es-card-status.png
