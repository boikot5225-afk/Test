from pathlib import Path
import sys

root = Path(sys.argv[1])

def replace(path, old, new, count=1):
    p = root / path
    s = p.read_text(encoding='utf-8')
    actual = s.count(old)
    if actual != count:
        raise SystemExit(f'{path}: expected {count} occurrences, found {actual}: {old[:120]!r}')
    p.write_text(s.replace(old, new, count), encoding='utf-8')

word_state = root / 'js/reader/word-state.js'
s = word_state.read_text(encoding='utf-8')

old_save = """  const save = () => {
    const data = load();
    for (const item of Object.values(data)) pruneClickContexts(item);
    pruneOverflow(data);
    let localOk = true;
    try {
      localStorage.setItem(storageKey(), JSON.stringify(data));
    } catch (e) {
      pruneAll(data);
      try {
        localStorage.setItem(storageKey(), JSON.stringify(data));
      } catch (e2) {
        localOk = false;
        log.warn?.('[reader] word-state localStorage cache write failed (IndexedDB still holds the data)', e2);
      }
    }
    idbPut(storageKey(), data).catch(e => {
      log.warn?.('[reader] word-state IndexedDB save failed', e);
      if (!localOk) onSaveError?.(e);
    });
    onSaved?.();
  };
"""

new_save = """  // v77.31 EN performance: passive reading used to stringify and synchronously
  // write the entire word-state (up to 6000 entries) inside the scroll/page-turn
  // frame. Keep explicit actions durable immediately, but coalesce passive
  // tracking/tap writes and commit them when the WebView is idle.
  let scheduledSaveTimer = null;
  let scheduledIdleHandle = null;
  let scheduledSaveDueAt = 0;

  const persistNow = () => {
    if (scheduledSaveTimer) clearTimeout(scheduledSaveTimer);
    scheduledSaveTimer = null;
    scheduledSaveDueAt = 0;
    if (scheduledIdleHandle != null && typeof cancelIdleCallback === 'function') {
      try { cancelIdleCallback(scheduledIdleHandle); } catch {}
    }
    scheduledIdleHandle = null;

    const data = load();
    for (const item of Object.values(data)) pruneClickContexts(item);
    pruneOverflow(data);
    let localOk = true;
    try {
      localStorage.setItem(storageKey(), JSON.stringify(data));
    } catch (e) {
      pruneAll(data);
      try {
        localStorage.setItem(storageKey(), JSON.stringify(data));
      } catch (e2) {
        localOk = false;
        log.warn?.('[reader] word-state localStorage cache write failed (IndexedDB still holds the data)', e2);
      }
    }
    idbPut(storageKey(), data).catch(e => {
      log.warn?.('[reader] word-state IndexedDB save failed', e);
      if (!localOk) onSaveError?.(e);
    });
    onSaved?.();
    return data;
  };

  const scheduleSave = (delay = 700) => {
    const now = Date.now();
    const due = now + Math.max(0, delay);
    if (scheduledSaveTimer && scheduledSaveDueAt <= due) return;
    if (scheduledSaveTimer) clearTimeout(scheduledSaveTimer);
    scheduledSaveDueAt = due;
    scheduledSaveTimer = setTimeout(() => {
      scheduledSaveTimer = null;
      scheduledSaveDueAt = 0;
      if (typeof requestIdleCallback === 'function') {
        scheduledIdleHandle = requestIdleCallback(() => {
          scheduledIdleHandle = null;
          persistNow();
        }, { timeout: 1200 });
      } else {
        persistNow();
      }
    }, Math.max(0, due - now));
  };

  const flushScheduledSave = () => {
    if (scheduledSaveTimer || scheduledIdleHandle != null) persistNow();
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushScheduledSave();
    }, { passive: true });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushScheduledSave, { passive: true });
  }

  // Explicit user actions (Known / save to dictionary) keep the old immediate
  // persistence semantics.
  const save = () => persistNow();
"""

if s.count(old_save) != 1:
    raise SystemExit('word-state save anchor mismatch')
s = s.replace(old_save, new_save, 1)

old_track = """    if (changed) save();
    return changed;
  };

  const activeClickContext"""
new_track = """    // Tracking is passive UI work: update the in-memory state immediately,
    // but keep the 1.5 MB-class JSON write out of the page-turn/scroll frame.
    if (changed) scheduleSave(700);
    return changed;
  };

  const activeClickContext"""
if s.count(old_track) != 1:
    raise SystemExit('word-state trackParagraph anchor mismatch')
s = s.replace(old_track, new_track, 1)

old_click = """    if (!state.saved && !state.known) state.status = 'looked';
    save();
    return counted;
  };
  const markSaved"""
new_click = """    if (!state.saved && !state.known) state.status = 'looked';
    // The visible status changes from memory immediately; disk/cloud persistence
    // is deferred so opening the English word card does not hitch.
    scheduleSave(220);
    return counted;
  };
  const markSaved"""
if s.count(old_click) != 1:
    raise SystemExit('word-state markClicked anchor mismatch')
s = s.replace(old_click, new_click, 1)

word_state.write_text(s, encoding='utf-8')

replace('js/reader-app.js', "./reader/word-state.js?v=4", "./reader/word-state.js?v=5")
replace('js/app.js', "./reader-app.js?v=77.31", "./reader-app.js?v=77.31-enperf")
replace('index.html', "v77.31-footnotes-formatting-translation-test", "v77.31-footnotes-formatting-translation-enperf-test")
replace('index.html', "js/app.js?v=77.31", "js/app.js?v=77.31-enperf")
replace('sw.js', "v77.31-footnotes-formatting-translation-test", "v77.31-footnotes-formatting-translation-enperf-test")

print('patched v77.31 English performance', root)
