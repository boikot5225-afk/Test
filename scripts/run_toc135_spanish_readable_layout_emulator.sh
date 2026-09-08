#!/usr/bin/env bash
set -euo pipefail

# Preserve every green toc134 behavior first, then reproduce the screenshot's
# justified EPUB paragraph and prove interlinear Spanish no longer stretches
# spaces while ordinary-text mode still restores the book's alignment.
bash scripts/run_toc134_spanish_parity_emulator.sh

python3 scripts/audit_toc135_spanish_readable_layout_live.py | tee runtime-audit/toc135-spanish-readable-layout-live.json
adb exec-out screencap -p > runtime-audit/toc135-150-spanish-readable-layout.png
