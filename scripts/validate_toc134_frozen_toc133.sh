#!/usr/bin/env bash
set -euo pipefail

# toc134 is additive over the fully green toc133. Present toc133 release metadata
# only while its validator runs; no Reader invariant or old test is weakened.
GRADLE=android/app/build.gradle
BACKUP="$(mktemp)"
cp "$GRADLE" "$BACKUP"
restore() {
  cp "$BACKUP" "$GRADLE"
  rm -f "$BACKUP"
}
trap restore EXIT

python3 - <<'PY'
from pathlib import Path
p=Path('android/app/build.gradle')
s=p.read_text(encoding='utf-8')
old='versionCode 1027'
name="versionName '77.42-toc134-es-parity'"
if s.count(old)!=1 or s.count(name)!=1:
    raise SystemExit('toc134 Gradle metadata anchor changed')
s=s.replace(old,'versionCode 1026',1)
s=s.replace(name,"versionName '77.42-toc133-es-context-batch'",1)
p.write_text(s,encoding='utf-8')
PY

bash scripts/validate_toc133_frozen_toc132.sh
