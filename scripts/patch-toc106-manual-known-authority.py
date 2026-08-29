from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match in {path}, got {count}')
    p.write_text(text.replace(old, new, 1))

# 1) Core manual Known must leave an explicit durable sentinel.  Language
# classifiers are not allowed to guess that this was merely an automatic Known.
replace_once(
    'js/reader/word-state.js',
    "  const markKnown = (word, lang = null) => { const state = touch(word, lang); delete state.autoRubyVisible; state.known = true; state.status = 'known'; state.autoKnown = false; save(); };\n",
    """  const markKnown = (word, lang = null) => {
    const language = canonicalLang(lang || currentLang());
    const state = touch(word, language);
    delete state.autoRubyVisible;
    state.known = true;
    state.status = 'known';
    state.autoKnown = false;
    // A user click is final authority.  Keep an explicit sentinel so every
    // language-specific classifier can distinguish it from estimated/common
    // Known during later async renders and cache/cloud hydration.
    state.manualKnowledge = 'known';
    state.manualKnowledgeAt = state.updatedAt || new Date().toISOString();
    save();
  };
""",
    'core markKnown manual sentinel',
)

# 2) Both vocabulary classifiers must understand legacy/core explicit Known even
# before the bridge has mirrored manualKnowledge.  This closes the render race.
old_manual = """function manualKnowledge(state) {
  const explicit = String(state?.manualKnowledge || '').toLowerCase();
  return explicit === 'known' || explicit === 'unknown' ? explicit : '';
}
"""
new_manual = """function manualKnowledge(state) {
  const explicit = String(state?.manualKnowledge || '').toLowerCase();
  if (explicit === 'known' || explicit === 'unknown') return explicit;
  const status = String(state?.status || '').trim().toLowerCase();
  // Core Reader manual Known predates manualKnowledge. autoKnown=false is the
  // discriminator: automatic/common words must not become sticky overrides.
  if (state?.known === true && status === 'known' && state?.autoKnown === false) return 'known';
  // Preserve the old explicit Problem/Hard user decision as manual Unknown.
  if (state?.known === false && state?.saved === true && (status === 'problem' || status === 'hard')) return 'unknown';
  return '';
}
"""
replace_once('js/reader/vocab-estimate.js', old_manual, new_manual, 'ZH manual knowledge inference')
replace_once('js/reader/en-vocab-estimate.js', old_manual, new_manual, 'EN manual knowledge inference')

# 3) Automatic assessment is advisory.  It may paint an unclassified word red,
# but it may NEVER remove an existing core Known marker.  Only a manual Unknown
# decision is allowed to reverse a manual Known decision.
old_zh_unknown = """  } else if (classification?.value === 'unknown') {
    // Only explicit Unknown may clear an old legacy Known marker. Automatic
    // Known never creates rw-known, so the stable Chinese gloss DOM is intact.
    el.classList.remove('rw-known');
    el.classList.add('rw-migaku-unknown');
  } else {
"""
new_zh_unknown = """  } else if (classification?.value === 'unknown') {
    // Manual Known outranks every automatic estimate.  A profile/frequency
    // refresh is advisory and is never allowed to resurrect red after the user
    // said "Знаю".  Only an explicit manual Unknown may clear rw-known.
    if (classification.source !== 'manual' && el.classList.contains('rw-known')) {
      el.classList.add('rw-migaku-known');
      return;
    }
    if (classification.source === 'manual') el.classList.remove('rw-known');
    el.classList.add('rw-migaku-unknown');
  } else {
"""
replace_once('js/reader/vocab-estimate.js', old_zh_unknown, new_zh_unknown, 'ZH automatic Unknown guard')

old_en_unknown = """  if (info?.value === 'known') el.classList.add('rw-migaku-known');
  else if (info?.value === 'unknown') {
    el.classList.remove('rw-known');
    el.classList.add('rw-migaku-unknown');
  } else return;
"""
new_en_unknown = """  if (info?.value === 'known') el.classList.add('rw-migaku-known');
  else if (info?.value === 'unknown') {
    // Same hard rule as Chinese: assessment/unranked classification cannot
    // revoke a core manual Known marker.  Only the user's explicit Unknown can.
    if (info.source !== 'manual' && el.classList.contains('rw-known')) {
      el.classList.add('rw-migaku-known');
      return;
    }
    if (info.source === 'manual') el.classList.remove('rw-known');
    el.classList.add('rw-migaku-unknown');
  } else return;
"""
replace_once('js/reader/en-vocab-estimate.js', old_en_unknown, new_en_unknown, 'EN automatic Unknown guard')

# 4) Bust every relevant module URL.  Android WebView cache survives app updates;
# keeping the same nested import query can otherwise keep the exact stale logic
# we just fixed even though a new APK was installed.
replace_once(
    'js/reader-app.js',
    "import { createReaderWordState } from './reader/word-state.js?v=4';",
    "import { createReaderWordState } from './reader/word-state.js?v=5-manual-known';",
    'word-state cache bust',
)
replace_once(
    'js/reader/interactions-runtime.js',
    "import './vocab-estimate.js?v=8';",
    "import './vocab-estimate.js?v=9-manual-known';",
    'ZH vocab cache bust',
)
replace_once(
    'js/reader/interactions-runtime.js',
    "import './en-vocab-estimate.js?v=1';",
    "import './en-vocab-estimate.js?v=2-manual-known';",
    'EN vocab cache bust',
)
replace_once(
    'js/reader/interactions-runtime.js',
    "import './en-manual-knowledge-bridge.js?v=2';",
    "import './en-manual-knowledge-bridge.js?v=3-manual-known';",
    'EN knowledge bridge cache bust',
)
replace_once(
    'js/app.js',
    "} from './reader-app.js?v=77.34-inline-deepseek';",
    "} from './reader-app.js?v=77.35-manual-known';",
    'reader-app cache bust',
)
replace_once(
    'index.html',
    "window.AN2_BUILD = 'v77.42-toc104-deepseek-context';",
    "window.AN2_BUILD = 'v77.42-toc106-manual-known';",
    'build marker',
)
replace_once(
    'index.html',
    '<script type="module" src="js/app.js?v=77.33-inline-deepseek"></script>',
    '<script type="module" src="js/app.js?v=77.34-manual-known"></script>',
    'app entry cache bust',
)

print('toc106 manual Known authority patch applied')
