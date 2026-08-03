#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build"
rm -rf "$BUILD"
mkdir -p "$BUILD"
kotlinc \
  "$ROOT/src/main/kotlin/smartbook/pinyin/ChineseLexicon.kt" \
  "$ROOT/src/main/kotlin/smartbook/pinyin/ChineseSegmenter.kt" \
  "$ROOT/src/main/kotlin/smartbook/pinyin/ContextualPinyinResolver.kt" \
  "$ROOT/src/main/kotlin/smartbook/pinyin/PinyinPlanner.kt" \
  "$ROOT/src/main/kotlin/smartbook/pinyin/BookLanguage.kt" \
  "$ROOT/src/test/kotlin/smartbook/pinyin/SegmenterSpec.kt" \
  -include-runtime -d "$BUILD/smartbook-pinyin-tests.jar"
java -jar "$BUILD/smartbook-pinyin-tests.jar"
