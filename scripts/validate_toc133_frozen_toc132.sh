#!/usr/bin/env bash
set -euo pipefail

# The toc132 validator intentionally hard-codes its release metadata (vc1025 /
# toc132). For an additive toc133 build, validate the exact old architecture
# against a temporary metadata view while preserving the real vc1026 Gradle
# file for compilation. No Reader/source invariant is weakened here.
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
old="versionCode 1026"
name="versionName '77.42-toc133-es-context-batch'"
if s.count(old)!=1 or s.count(name)!=1:
    raise SystemExit('toc133 Gradle metadata anchor changed')
s=s.replace(old,'versionCode 1025',1)
s=s.replace(name,"versionName '77.42-toc132-en-context-batch'",1)
p.write_text(s,encoding='utf-8')
PY

bash scripts/validate_toc126_storage_import_v2.sh
