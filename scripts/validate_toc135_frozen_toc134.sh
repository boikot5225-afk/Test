#!/usr/bin/env bash
set -euo pipefail

# toc135 changes only the Spanish presentation rule and release metadata. Run
# toc134's complete source gate against the exact green toc134 files, then put
# the toc135 files back before the new layout assertions run.
BASE=965e7124d0d48f858e8d2f44d6f7750f482425cf
TMP="$(mktemp -d)"
FILES=(
  android/app/build.gradle
  js/reader/interactions-runtime.js
  js/reader/es-parity-ui-v1.js
)
restore() {
  for path in "${FILES[@]}"; do
    cp "$TMP/$path" "$path"
  done
  rm -rf "$TMP"
}
trap restore EXIT

for path in "${FILES[@]}"; do
  mkdir -p "$TMP/$(dirname "$path")"
  cp "$path" "$TMP/$path"
  git show "$BASE:$path" > "$path"
done

bash scripts/validate_toc134_spanish_parity.sh
