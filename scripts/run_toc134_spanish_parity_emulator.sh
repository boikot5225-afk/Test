#!/usr/bin/env bash
set -euo pipefail

# Never trade a pretty Spanish screen for a broken Reader. Run the entire green
# toc133 Android suite first (storage/restart/swipes/imports/FR/EN/ES context),
# then prove toc134's missing-local-dictionary path deterministically and run the
# UI/word-card/manual-state parity audit.
bash scripts/run_toc133_spanish_emulator.sh

python3 scripts/setup_toc134_spanish_parity_context.py
python3 scripts/audit_toc134_spanish_parity_live.py | tee runtime-audit/toc134-spanish-parity-live.json
adb exec-out screencap -p > runtime-audit/toc134-150-spanish-parity.png
