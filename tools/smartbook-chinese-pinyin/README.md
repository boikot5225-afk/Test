# Smart Book Chinese pinyin patch

Native, offline pinyin layer for Chinese books in Smart Book 3.6.

## Current behaviour

- pinyin is drawn above Chinese words only;
- default mode is `UNKNOWN_ONLY`;
- Smart Book `Learnt` words lose pinyin immediately;
- `Saved` and unknown words keep pinyin;
- the original paragraph string is never changed, so click spans, notes, selection and TTS offsets remain intact;
- segmentation and readings work offline from a compact CC-CEDICT asset.

## Implemented

- dictionary-backed dynamic-programming segmentation with exact UTF-16 ranges;
- contextual whole-word readings imported from Reader AI;
- `OFF`, `UNKNOWN_ONLY`, and `ALL` planner modes;
- Android `ReplacementSpan` that reserves vertical room and coexists with Smart Book's `ReaderSpan`;
- a legacy Xposed/LSPosed module scoped only to `com.kursx.smartbook`;
- a rootless integrated APK pipeline using current NPatch;
- conversion of the 120,995-entry Reader AI JSON dictionary to a ~1 MB gzip TSV asset;
- regression tests for polyphonic words and the common `研究生命` greedy-split failure.

## Branch build outputs

- `Smart Book pinyin module`: standalone signed module APK for rooted LSPosed setups.
- `Smart Book Chinese pinyin APK`: rootless Smart Book 3.6 APK with the module embedded through NPatch.

The rootless workflow refuses to label another version as 3.6: it verifies both the original and patched package metadata before uploading an artifact.

## Test locally

```bash
./scripts/test.sh
```

## Build the dictionary asset

```bash
python3 tools/build_lexicon.py ReaderAI.apk xposed-module/src/main/assets/zh_pinyin.tsv.gz
```

## Installation warning

The patched APK has a different signing certificate. Android will not install it over the Play version. Back up Smart Book data and the library first, then uninstall the original application before installing the patched APK. Do not merge this branch into `main` until the APK has been tested on the Galaxy A54.

The dictionary derivative retains CC-CEDICT attribution and CC BY-SA 4.0 terms in `CC-CEDICT-NOTICE.txt` inside the module APK.
