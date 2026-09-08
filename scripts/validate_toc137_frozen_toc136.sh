#!/usr/bin/env bash
set -euo pipefail

# toc137 changes only Spanish word-panel ownership/status decoration on top of
# the green toc136 Reader. Present toc136 metadata while its frozen validator
# runs, then restore toc137 metadata on every exit path.
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
code='versionCode 1030'
name="versionName '77.42-toc137-es-card-status'"
if s.count(code)!=1 or s.count(name)!=1:
    raise SystemExit('toc137 Gradle metadata anchor changed')
s=s.replace(code,'versionCode 1029',1)
s=s.replace(name,"versionName '77.42-toc136-es-justified-gloss-layout'",1)
p.write_text(s,encoding='utf-8')
PY

bash scripts/validate_toc136_spanish_justified_gloss.sh
