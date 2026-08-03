# Smart Book Chinese pinyin patch

Native, offline pinyin layer for Chinese books in Smart Book 3.6.

## Implemented

- dictionary-backed Chinese segmentation with exact UTF-16 ranges;
- contextual whole-word readings from Reader AI's CC-CEDICT asset;
- `OFF`, `UNKNOWN_ONLY`, and `ALL` modes;
- pinyin removed as soon as Smart Book marks a token learnt;
- Android `ReplacementSpan` that reserves vertical room and keeps existing click spans;
- conversion of the 120k-entry Reader AI JSON dictionary into a smaller gzip TSV asset;
- JVM regression tests for polyphonic words and the common `研究生命` greedy-split failure.

## Test

```bash
./scripts/test.sh
```

## Build the dictionary asset

```bash
python3 tools/build_lexicon.py ReaderAI.apk app/src/main/assets/zh_pinyin.tsv.gz
```

The source dictionary is CC-CEDICT and must retain its CC BY-SA attribution in the derivative app.
