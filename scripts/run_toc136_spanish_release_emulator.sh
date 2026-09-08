#!/usr/bin/env bash
set -euo pipefail

# Preserve the complete green toc133 Android baseline first: storage/import,
# restart/ACTION_VIEW, physical swipes, audio/EPUB, FR, EN and ES context.
bash scripts/run_toc133_spanish_emulator.sh

# Then prove the toc134 Spanish lexical/manual-control behavior against toc136's
# evolved inline presentation, followed by a geometry audit that compares the
# exact Spanish word positions with glosses OFF vs ON.
python3 scripts/setup_toc134_spanish_parity_context.py
python3 scripts/audit_toc136_spanish_parity_live.py | tee runtime-audit/toc136-spanish-parity-live.json
python3 scripts/audit_toc136_spanish_justified_gloss_live.py | tee runtime-audit/toc136-spanish-justified-gloss-live.json
adb exec-out screencap -p > runtime-audit/toc136-150-spanish-justified-gloss.png
