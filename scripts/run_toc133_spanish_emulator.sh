#!/usr/bin/env bash
set -euo pipefail

# First prove the complete toc132 Android contract is still intact: storage,
# restart, physical swipes, manual/audio EPUB imports, drop caps, French and
# English context. Spanish is additive and runs last so it cannot mask a core
# regression.
bash scripts/run_toc126_storage_emulator.sh

PKG=space.saintjust.reader.semanticstage1clean.formatfix.debug
python3 scripts/audit_toc133_spanish_context_live.py | tee runtime-audit/toc133-spanish-context-live.json
adb exec-out screencap -p > runtime-audit/toc133-140-spanish-context.png
