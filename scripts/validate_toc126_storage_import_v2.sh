#!/usr/bin/env bash
set -euo pipefail

python3 - <<'PY'
from pathlib import Path
import hashlib
import re

root = Path('.')

def text(path):
    return (root / path).read_text(encoding='utf-8')

def sha(path):
    return hashlib.sha256((root / path).read_bytes()).hexdigest()

# Reader core remains the user-known toc119 navigation/render core.
frozen = {
    'js/reader/interactions.js': 'b709451dec2849b8487b054fd8f52c57ef9fc91dc5f5818ed5720e00dda08ba6',
    'js/reader/pages-mode.js': '13ce9f42db4427e1c2442abad7c0e66343aad92d79a4e945376fb42afed8e7d9',
    'js/reader-app.js': '202e287af1158b8498e44ae3e9ce28cf43b1a0aaaba9f01b25bfdfa2fde47f04',
    'js/reader/chapter-render.js': 'c10f3680fb122c4f04a730ddb298f88165c29d5b24978cc5868560531f752361',
}
for path, expected in frozen.items():
    got = sha(path)
    assert got == expected, f'frozen Reader core changed: {path}: {got}'

app = text('js/app.js')
storage = text('js/reader/library-store.js')
idb = text('js/reader/library-idb-store.js')
bridge = text('js/reader/semantic-import-bridge.js')
semantic = text('js/reader/semantic-import-stage1.js')
epub = text('js/reader/epub.js')
epub_base = text('js/reader/epub-stage1.js')
epub_real = text('js/reader/epub-stage1-real.js')
external = text('js/reader/android-external-import.js')
handler = text('js/reader/handler-bridge.js')
audio_isolation = text('js/reader/audio-epub-import-isolation.js')
delete_fix = text('js/reader/delete-fix.js')
fr_vocab = text('js/reader/fr-vocab-estimate.js')
fr_builder = text('scripts/build_fr_reader_resources.py')
gradle = text('android/app/build.gradle')
runner = text('scripts/run_toc126_storage_emulator.sh')
audio_epub_audit = text('scripts/audit_toc128_audio_epub_reuse.py')
fr_audit = text('scripts/audit_toc130_french_assets_live.py')
dropcap_audit = text('scripts/audit_toc131_epub_dropcap_live.py')

assert "versionCode 1024" in gradle
assert "versionName '77.42-toc131-epub-integrity'" in gradle
assert "exclude { it.relativePath.toString() == 'app.js' }" in gradle

# toc130 French assets remain a mandatory Gradle input, never a validation-script side effect.
assert "def frenchReaderAssetDir = layout.buildDirectory.dir('generated/frenchReaderAssets')" in gradle
assert "def frenchReaderOutputDir = layout.buildDirectory.dir('generated/frenchReaderAssets/frreader')" in gradle
assert "tasks.register('prepareFrenchReaderResources')" in gradle
assert "scripts/build_fr_reader_resources.py" in gradle
assert "dependsOn 'prepareFrenchReaderResources'" in gradle
assert "frenchReaderAssetDir.get().asFile" in gradle
for name in ['fr_vocab_frequency.tsv', 'fr_vocab_lemma.tsv', 'fr_ru_core.json', 'fr_ru_senses.json']:
    assert name in gradle, f'French Gradle output missing: {name}'
assert "../../../frreader/fr_vocab_frequency.tsv?v=1" in fr_vocab
assert "../../../frreader/fr_vocab_lemma.tsv?v=1" in fr_vocab
assert 'MIN_EXPECTED_COUNT=50000' in fr_vocab
assert 'WORDHOARD_SHA256' in fr_builder
assert 'French core morphology probes failed' in fr_builder
assert 'scripts/audit_toc130_french_assets_live.py' in runner
assert 'readerLoadFrenchVocabularyData' in fr_audit
assert 'fr_ru_core.json' in fr_audit and 'fr_ru_senses.json' in fr_audit

# toc131: decorative opening initials are normalized in the real-world EPUB
# compatibility layer before the base semantic parser sees block structure.
# Do not globally relax the base parser's one-character boilerplate rule: the
# semantic repair is to rejoin a real drop-cap prefix with its continuation.
assert 'normalized.length <= 1' in epub_base
assert 'const DROP_CAP_PARENT_RE' in epub_real
assert 'const DROP_CAP_CHILD_RE' in epub_real
assert 'function normalizeDropCapWrappers(doc)' in epub_real
assert 'function trimInlineBoundaryWhitespace(node)' in epub_real
assert "const replacement = doc.createElement('span')" in epub_real
assert 'node.replaceWith(replacement)' in epub_real
assert 'prefix.length > 12' in epub_real
normalize_fn = epub_real.index('export function normalizeRealWorldEpubHtml')
dropcap_call = epub_real.index('normalizeDropCapWrappers(doc)', normalize_fn)
inline_call = epub_real.index('normalizeInlineStyles(doc)', normalize_fn)
figure_call = epub_real.index('normalizeFigureWrappers(doc)', normalize_fn)
assert dropcap_call < inline_call < figure_call, 'drop-cap repair must precede style/figure normalization'
assert 'scripts/audit_toc131_epub_dropcap_live.py' in runner
for probe in ['single-letter-accent', 'nested-emphasis', 'dialogue-prefix']:
    assert probe in dropcap_audit, f'drop-cap runtime probe missing: {probe}'
assert "expected:'Éclair avance sans coupure.'" in dropcap_audit
assert "expected:'Ma phrase reste entière.'" in dropcap_audit
assert "expected:'— C’est pourquoi le texte continue.'" in dropcap_audit
assert "result.get('control') != ['Alpha.', 'Beta.']" in dropcap_audit

# Guest cold start remains local-first.
init_pos = app.index('async function init()')
early_guest_pos = app.index("if (localStorage.getItem('an2_guest') === '1')", init_pos)
firebase_wait_pos = app.index('// The Firebase SDK loads from a CDN', init_pos)
assert early_guest_pos < firebase_wait_pos, 'guest auto-login still happens after Firebase wait'
guest_match = re.search(
    r'export async function continueAsGuest\(\) \{(.*?)\n\}\n\n// Hide features a guest can.t use',
    app,
    re.S,
)
assert guest_match, 'continueAsGuest block missing from bundled js/app.js'
guest_body = guest_match.group(1)
assert 'setIsGuest(true)' in guest_body
assert "document.getElementById('main-app').style.display = 'block'" in guest_body
assert 'restoreVerbsFromCache()' in guest_body
assert 'loadVerbsFromCloud({ force: true })' in guest_body
assert 'await withDeadline(() => loadVerbsFromCloud()' not in guest_body

# localStorage is index/positions only.
for forbidden in [
    'localStorage.setItem(storageKey(), JSON.stringify(books))',
    'localStorage.setItem(storageKey(), JSON.stringify(merged))',
    'saved slim library without AI caches',
    'localStorage переполнен',
]:
    assert forbidden not in storage + bridge, f'forbidden full localStorage path survived: {forbidden}'
assert '_libraryIndexV2' in storage and 'writeLocalIndex' in storage
assert 'writeLocalIndex(key, next)' in bridge
assert 'await libraryIdbPut(key, next)' in bridge
assert '__readerGuestLegacyLibrarySnapshot' in app
assert 'readGuestStartupSnapshot(key)' in bridge
assert 'const startupLocalLibrary = mergeBookLists(readGuestStartupSnapshot(key), readStoredBooks(key))' in bridge
assert 'mergeBookLists(pendingLocalLibrary, readStoredBooks(key))' in bridge

# IDB v2 preserves full records and legacy migration.
assert "const DB_VERSION = 2" in idb
assert "const BOOK_STORE = 'book-records'" in idb
assert "const INDEX_STORE = 'indexes'" in idb
assert 'const _bootLegacyLocal = new Map()' in idb
assert '_bootLegacyLocal.delete(libraryKey)' in idb
assert 'readLegacySnapshot' in idb
assert 'libraryIdbPutBook' in idb and 'libraryIdbDeleteBook' in idb
assert 'toc126 migration commit guard' in idb
assert 'await verifyFullRecords(libraryKey, source)' in idb
assert 'durable full-book verification failed' in idb
assert 'legacy migration incomplete' in idb
assert 'if (!full) continue;' in idb
assert 'refusing index-only book record' in idb

# One semantic parser owns EPUB text/images/TOC.
assert 'parsePackageToc(entries, packageInfo)' in semantic
assert 'savedImageKeys' in semantic
assert 'await imgStorePut(key' in semantic
assert 'const imageBlobs = new Map()' not in semantic
assert 'htmlDocuments.set(path, html)' not in semantic
assert 'toc,' in semantic and '_epubTocExact' in semantic
assert 'captureEpubTocFile' not in external and 'applyCapturedEpubToc' not in external
assert "toc-direct.js" not in external

# ZIP central-directory entries remain zero-copy views.
assert 'bytes.subarray(dataStart, dataStart + compressedSize)' in epub
assert 'bytes.slice(dataStart, dataStart + compressedSize)' not in epub

# The semantic bridge is intentionally the proven toc128 ACTION_VIEW path.
# Do not add generation/cancellation state here: that experiment regressed the
# legacy-library migration before the manual-import regression even ran.
assert "reader-app.js?v=77.42-zh-reader-quality" in app
assert "reader-app.js?v=77.42-zh-reader-quality" in handler
assert "reader-app.js?v=77.42-zh-reader-quality" in bridge
assert "reader-app.js?v=77.32" not in handler
assert "from './library-idb-store.js?v=2';" in bridge
assert "from './library-idb-store.js?v=1';" not in bridge
assert 'await app.hydrateReaderBooksFromIndexedDB?.()' in bridge
assert 'saved book ${String(target.id || \'\')} is absent from canonical readerBooks' in bridge
assert '__readerSemanticImportStats' not in bridge
assert 'activeSemanticImport' not in bridge
assert 'semanticImportGeneration' not in bridge
assert '__readerSupersedeSemanticImport' not in bridge
barrier = bridge.index('const startupDurableLibrary = await readDurableBooks(key)')
parse = bridge.index('const result = await parseSemanticEpubFile(file')
assert barrier < parse, 'ACTION_VIEW EPUB parse must wait for durable legacy migration'
assert 'libraryIdbDeleteBook(storageKey, wantedId)' in delete_fix
assert 'localStorage.setItem(storageKey, JSON.stringify(books))' not in delete_fix
assert "import { libraryIdbDeleteBook } from './library-idb-store.js?v=1';" in delete_fix

# toc129 manual-import isolation. ACTION_VIEW bypasses this behavior entirely.
# A different EPUB selected during a parse is queued rather than dropped or run
# concurrently. Only the newest queued generation proceeds after the active
# semantic parser settles. Duplicate delivery of the newest file shares one promise.
assert "import './audio-epub-import-isolation.js?v=1';" in handler
assert '__readerAudioEpubIsolationV1' not in handler
assert 'activeEpubImport' not in handler
assert '__readerAudioEpubIsolationV3' in audio_isolation
assert '__readerImportIsolationStats' in audio_isolation
assert 'let activeManualEpubImport = null' in audio_isolation
assert 'let resetQueue = Promise.resolve()' in audio_isolation
assert 'let manualSelectionGeneration = 0' in audio_isolation
assert 'event?.androidExternal === true' in audio_isolation
android_bypass = audio_isolation.index('if (event?.androidExternal === true)')
manual_file = audio_isolation.index('const file = fileFromEvent(event)')
previous_promise = audio_isolation.index('const previousPromise = activeManualEpubImport?.promise || Promise.resolve()', manual_file)
reset_call = audio_isolation.index('const resetTask = resetQueue.then(() => resetCanonicalPendingAudio(canonicalImport))', previous_promise)
assert android_bypass < manual_file < previous_promise < reset_call, 'ACTION_VIEW must bypass manual queue/reset before file work'
assert 'activeManualEpubImport?.fingerprint === key' in audio_isolation
assert 'return activeManualEpubImport.promise' in audio_isolation
assert 'importIsolationStats.supersededCalls += 1' in audio_isolation
assert 'try { await previousPromise; } catch {}' in audio_isolation
assert 'selectionGeneration !== manualSelectionGeneration' in audio_isolation
assert "Уже разбираю" not in audio_isolation
assert 'blockedConcurrent += 1' not in audio_isolation
assert '__readerSupersedeSemanticImport' not in audio_isolation
assert 'ReaderImportResetComplete' in audio_isolation
assert '__reader_import_state_reset__.txt' not in audio_isolation
assert "reader-import-title" in audio_isolation
assert "reader-import-author" in audio_isolation
assert "reader-import-text" in audio_isolation
assert "reader-import-audio-status" in audio_isolation
assert 'importIsolationStats.epubStarts += 1' in audio_isolation
assert 'importIsolationStats.dedupedCalls += 1' in audio_isolation

assert 'scripts/audit_toc128_audio_epub_reuse.py' in runner
assert '__readerAudioEpubIsolationV3' in audio_epub_audit
assert 'FIRST_TITLE' in audio_epub_audit and 'SECOND_TITLE' in audio_epub_audit
assert 'supersededCallsDelta' in audio_epub_audit
assert 'semanticSupersededDelta' not in audio_epub_audit
assert 'semanticCancelledDelta' not in audio_epub_audit
assert 'finalPreviewHasFirst' in audio_epub_audit
assert 'staleDurableMatches' in audio_epub_audit
assert 'openedHasOriginalAudio' in audio_epub_audit

for runtime_path in (root / 'js').rglob('*.js'):
    runtime_source = runtime_path.read_text(encoding='utf-8')
    assert 'reader-app.js?v=77.32' not in runtime_source, f'duplicate Reader module identity survived: {runtime_path}'

print('toc131 EPUB integrity + French + toc129 import/storage source gate: PASS')
PY

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for f in \
  js/app.js \
  js/reader/library-idb-store.js \
  js/reader/library-store.js \
  js/reader/semantic-import-bridge.js \
  js/reader/semantic-import-stage1.js \
  js/reader/epub.js \
  js/reader/epub-stage1-real.js \
  js/reader/android-external-import.js \
  js/reader/handler-bridge.js \
  js/reader/audio-epub-import-isolation.js \
  js/reader/delete-fix.js \
  js/reader/fr-vocab-estimate.js; do
  target="$TMP/$(echo "$f" | tr '/' '_').mjs"
  cp "$f" "$target"
  node --check "$target"
done

python3 -m py_compile \
  scripts/audit_toc128_audio_epub_reuse.py \
  scripts/audit_toc130_french_assets_live.py \
  scripts/audit_toc131_epub_dropcap_live.py \
  scripts/build_fr_reader_resources.py

echo 'toc131 JS/Python syntax: PASS'
