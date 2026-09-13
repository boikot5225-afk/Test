#!/usr/bin/env bash
set -euo pipefail

# Keep the complete toc136/toc133 regression suite intact, then exercise the
# new current-state marker against the production Spanish vocabulary owner.
bash scripts/run_toc136_spanish_release_emulator.sh
python3 scripts/audit_toc137_spanish_knowledge_status_live.py | tee runtime-audit/toc137-spanish-knowledge-status-live.json
adb exec-out screencap -p > runtime-audit/toc137-160-spanish-knowledge-status.png
