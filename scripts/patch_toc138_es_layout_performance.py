#!/usr/bin/env python3
from pathlib import Path

APP = Path('js/reader-app.js')
GRADLE = Path('android/app/build.gradle')
SMOOTH = Path('js/reader/es-smooth-reader-v1.js')

old = """  // Paint only the paragraph containing the clicked word immediately (cheap),
  // then rebuild the full chapter on the next animation frame so every other
  // occurrence of the word also gets the updated color without blocking the UI.
  readerRefreshParagraphWordClasses(paragraphIndex);
  requestAnimationFrame(() => {
    try { renderReaderChapter(); }
    catch (e) {
      console.warn('[reader word repaint] chapter render failed; keeping direct refresh', e);
      try { readerRefreshParagraphWordClasses(paragraphIndex); } catch {}
    }
  });
"""
new = """  // Keep a word tap local. Rebuilding a complete Spanish chapter here used to
  // block WebView on every lookup even though the clicked paragraph was already
  // painted synchronously. Spanish owns its visible knowledge/gloss reconciliation
  // in es-smooth-reader-v1; a signature-stable refresh is enough on the next frame.
  readerRefreshParagraphWordClasses(paragraphIndex);
  if (activeLang === 'es') {
    requestAnimationFrame(() => {
      try { window.readerSpanishRefresh?.('word-tap-fast', false); } catch {}
    });
  } else {
    requestAnimationFrame(() => {
      try { renderReaderChapter(); }
      catch (e) {
        console.warn('[reader word repaint] chapter render failed; keeping direct refresh', e);
        try { readerRefreshParagraphWordClasses(paragraphIndex); } catch {}
      }
    });
  }
"""

text = APP.read_text(encoding='utf-8')
if new not in text:
    if text.count(old) != 1:
        raise SystemExit('toc138 readerOpenWordPanel hot-path anchor changed')
    text = text.replace(old, new, 1)
    APP.write_text(text, encoding='utf-8')

# The late layer is loaded after toc136. Its visibility override must only win in
# Unknown-gloss mode; otherwise it would accidentally re-enable hints in ordinary
# reading mode merely because the gloss node still contains text.
smooth = SMOOTH.read_text(encoding='utf-8')
old_gloss = '#reader-reading-view.rd-es-smooth-v1 .rw-es-v1-gloss:not(:empty){display:block!important}'
new_gloss = '#reader-reading-view.rd-es-smooth-v1.rd-es-unknown-gloss .rw-es-v1-gloss:not(:empty){display:block!important}'
if new_gloss not in smooth:
    if smooth.count(old_gloss) != 1:
        raise SystemExit('toc138 Spanish gloss visibility anchor changed')
    smooth = smooth.replace(old_gloss, new_gloss, 1)
    SMOOTH.write_text(smooth, encoding='utf-8')

text = GRADLE.read_text(encoding='utf-8')
old_code = 'versionCode 1030'
new_code = 'versionCode 1031'
old_name = "versionName '77.42-toc137-es-card-status'"
new_name = "versionName '77.42-toc138-es-layout-performance'"

if new_code not in text:
    if text.count(old_code) != 1:
        raise SystemExit('toc138 versionCode anchor changed')
    text = text.replace(old_code, new_code, 1)
if new_name not in text:
    if text.count(old_name) != 1:
        raise SystemExit('toc138 versionName anchor changed')
    text = text.replace(old_name, new_name, 1)
GRADLE.write_text(text, encoding='utf-8')

print('toc138 Spanish layout/performance + vc1031 patch: applied')
