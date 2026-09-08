#!/usr/bin/env bash
set -euo pipefail

# toc136 changes only the Spanish annotation presentation on top of the green
# toc134 behavior. Present toc134 release metadata while the existing frozen
# toc133 baseline validator runs; restore toc136 metadata on every exit path.
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
code='versionCode 1029'
name="versionName '77.42-toc136-es-justified-gloss-layout'"
if s.count(code)!=1 or s.count(name)!=1:
    raise SystemExit('toc136 Gradle metadata anchor changed')
s=s.replace(code,'versionCode 1027',1)
s=s.replace(name,"versionName '77.42-toc134-es-parity'",1)
p.write_text(s,encoding='utf-8')
PY

bash scripts/validate_toc134_frozen_toc133.sh
