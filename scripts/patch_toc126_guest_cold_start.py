#!/usr/bin/env python3
from pathlib import Path
import re
import runpy

# Android's syncWebAssets deliberately excludes the legacy root app.js.
# The actual bundled entry point is js/app.js.
path = Path('js/app.js')
source = path.read_text(encoding='utf-8')

old_guest = re.search(
    r"export async function continueAsGuest\(\) \{.*?\n\}\n\n// Hide features a guest can't use",
    source,
    re.S,
)
if not old_guest:
    raise SystemExit('continueAsGuest block not found in js/app.js')

new_guest = r'''export async function continueAsGuest() {
  // toc126: guest startup is local-first. Reader/import must be usable with no
  // Firebase/network at all; cloud dictionaries are an optional background refresh.
  setIsGuest(true);
  localStorage.setItem('an2_guest', '1');
  currentProfile = 'guest';
  setCurrentProfile('guest');
  setSbUser(null);
  readerSwitchStorageOwner('guest');

  const brand = document.querySelector('.nav-brand');
  if (brand) brand.innerHTML = 'Reader AI <span style="font-size:0.65rem;opacity:0.6;font-style:normal;margin-left:6px">гость</span>';

  // Never block the Reader shell on a cloud dictionary. Use a local cache when
  // present; an empty trainer dictionary is still a valid state for reading EPUB.
  if (!restoreVerbsFromCache()) {
    VERBS.length = 0;
    VERBS_LOADED = true;
    saveCache(VERBS_CACHE_KEY, VERBS);
  }

  document.getElementById('screen-profile').style.display = 'none';
  document.getElementById('main-app').style.display = 'block';
  applyGuestRestrictions();
  hideLoading();
  try { resetTrainer(); } catch (e) { console.warn('[guest] resetTrainer skipped:', getErrorMessage(e)); }
  try { showScreen('home'); } catch (e) { console.warn('[guest] home render skipped:', getErrorMessage(e)); }
  startPhrasesBackgroundLoad();

  // Best-effort refresh only. It must never hold up cold start or Android file import.
  Promise.resolve().then(async () => {
    if (!isSupabaseReady()) return;
    const ok = await runOptional(
      'Глаголы (фон, гость)',
      () => loadVerbsFromCloud({ force: true }),
      CORE_LOAD_TIMEOUT_MS + 3000,
    );
    if (ok && document.getElementById('screen-home')?.classList.contains('active')) {
      try { renderHome(); } catch (_) {}
    }
  }).catch((e) => console.warn('[guest-bg] verbs refresh skipped:', getErrorMessage(e)));
  return true;
}

// Hide features a guest can't use'''
source = source[:old_guest.start()] + new_guest + source[old_guest.end():]

needle = '''  showLoading('Reader AI — запуск...');
  initSpeech();
  applyKbMode();
  initTTSEngineUI();

  // The Firebase SDK loads from a CDN and sometimes isn't ready when init runs'''
replacement = '''  showLoading('Reader AI — запуск...');
  initSpeech();
  applyKbMode();
  initTTSEngineUI();

  // toc126: a remembered guest session is fully local. Enter it before any
  // Firebase SDK/session work so ACTION_VIEW EPUB import also works offline.
  if (localStorage.getItem('an2_guest') === '1') {
    await continueAsGuest();
    return;
  }

  // The Firebase SDK loads from a CDN and sometimes isn't ready when init runs'''
if needle not in source:
    raise SystemExit('init Firebase preamble not found in js/app.js')
source = source.replace(needle, replacement, 1)

path.write_text(source, encoding='utf-8')
print('toc126 bundled guest cold-start patch: PASS')

# The same build-time materialization point owns the toc126 storage migration
# guard. Keeping both before the source gate guarantees the APK cannot be built
# with the cold-start fix but without the data-loss fix.
runpy.run_path('scripts/patch_toc126_storage_migration_guard.py', run_name='__main__')
