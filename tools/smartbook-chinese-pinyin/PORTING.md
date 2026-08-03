# Smart Book 3.6 insertion plan

Verified in `base.apk/classes6.dex`:

- `com.kursx.smartbook.reader.holder.ParagraphHolder` extends `ParagraphLayout`;
- `ParagraphHolder` owns the async text initialisation path and builds a `SpannableStringBuilder`;
- `ReaderSpan` extends `ClickableSpan`, so a separate `ReplacementSpan` can share the same ranges;
- `FontSpan` extends `MetricAffectingSpan`;
- the existing constructor already receives `WordsRepository` and shared reader state.

## Safe order inside ParagraphHolder

1. Obtain the original paragraph string.
2. Let Smart Book create its existing word/click/colour spans.
3. Resolve the learnt-word set from the same repository snapshot used by the paragraph.
4. For Chinese language codes (`zh`, `zh-CN`, `zh-TW`), call `PinyinPlanner.plan`.
5. Apply `PinyinSpan` last, on the exact token ranges.
6. Assign the finished `SpannableStringBuilder` to `ReaderText` once.

Do not insert pinyin characters or spaces into the paragraph string. That would invalidate ReaderSpan offsets, selection, notes and TTS positions.

## First binary build

The first APK should hard-code `UNKNOWN_ONLY`. A UI mode selector comes after the renderer is stable. The binary patch still requires an apktool/jadx workspace because Smart Book is closed-source and R8-obfuscated; this directory contains the tested logic that will be injected, not a claim that the APK has already been rebuilt.
