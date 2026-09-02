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
    'js/reader/epub.js': None,
}
for path, expected in frozen.items():
    if expected is None:
        continue
    got = sha(path)
    assert got == expected, f'frozen Reader core changed: {path}: {got}'

app = text('js/app.js')
storage = text('js/reader/library-store.js')
idb = text('js/reader/library-idb-store.js')
bridge = text('js/reader/semantic-import-bridge.js')
semantic = text('js/reader/semantic-import-stage1.js')
epub = text('js/reader/epub.js')
external = text('js/reader/android-external-import.js')
handler = text('js/reader/handler-bridge.js')
audio_isolation = text('js/reader/audio-epub-import-isolation.js')
delete_fix = text('js/reader/delete-fix.js')
gradle = text('android/app/build.gradle')
runner = text('scripts/run_toc126_storage_emulator.sh')
audio_epub_audit = text('scripts/audit_toc128_audio_epub_reuse.py')

assert "versionCode 1022" in gradle
assert "versionName '77.42-toc129-import-supersede'" in gradle
assert "exclude { it.relativePath.toString() == 'app.js' }" in gradle

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

# Canonical reader refresh + migration barrier stay intact.
assert "reader-app.js?v=77.42-zh-reader-quality" in app
assert "reader-app.js?v=77.42-zh-reader-quality" in handler
assert "reader-app.js?v=77.42-zh-reader-quality" in bridge
assert "reader-app.js?v=77.32" not in handler
assert "from './library-idb-store.js?v=2';" in bridge
assert "from './library-idb-store.js?v=1';" not in bridge
assert 'await app.hydrateReaderBooksFromIndexedDB?.()' in bridge
assert 'saved book ${String(target.id || \'\')} is absent from canonical readerBooks' in bridge
barrier = bridge.index('const startupDurableLibrary = await readDurableBooks(key)')
parse = bridge.index('const result = await parseSemanticEpubFile(file')
assert barrier < parse, 'ACTION_VIEW EPUB parse must wait for durable legacy migration'
assert 'libraryIdbDeleteBook(storageKey, wantedId)' in delete_fix
assert 'localStorage.setItem(storageKey, JSON.stringify(books))' not in delete_fix
assert "import { libraryIdbDeleteBook } from './library-idb-store.js?v=1';" in delete_fix

# toc129 import transaction: ACTION_VIEW still bypasses the manual audio reset;
# manual EPUB uses V3 isolation. A second DIFFERENT EPUB is never blocked: it
# supersedes the active semantic generation, and stale progress callbacks throw
# before they can repaint title/progress/pendingImport.
assert "import './audio-epub-import-isolation.js?v=1';" in handler
assert '__readerAudioEpubIsolationV1' not in handler
assert 'activeEpubImport' not in handler
assert '__readerAudioEpubIsolationV3' in audio_isolation
assert '__readerImportIsolationStats' in audio_isolation
assert 'let activeManualEpubImport = null' in audio_isolation
assert 'let resetQueue = Promise.resolve()' in audio_isolation
assert 'event?.androidExternal === true' in audio_isolation
android_bypass = audio_isolation.index('if (event?.androidExternal === true)')
manual_file = audio_isolation.index('const file = fileFromEvent(event)')
reset_call = audio_isolation.index('const resetTask = resetQueue.then(() => resetCanonicalPendingAudio(canonicalImport))', manual_file)
assert android_bypass < manual_file < reset_call, 'ACTION_VIEW must bypass manual reset before file/reset work'
assert 'activeManualEpubImport?.fingerprint === key' in audio_isolation
assert 'return activeManualEpubImport.promise' in audio_isolation
assert 'importIsolationStats.supersededCalls += 1' in audio_isolation
assert "Уже разбираю" not in audio_isolation
assert 'blockedConcurrent += 1' not in audio_isolation
assert 'ReaderImportResetComplete' in audio_isolation
assert '__reader_import_state_reset__.txt' not in audio_isolation
assert "reader-import-title" in audio_isolation
assert "reader-import-author" in audio_isolation
assert "reader-import-text" in audio_isolation
assert "reader-import-audio-status" in audio_isolation
assert 'importIsolationStats.epubStarts += 1' in audio_isolation
assert 'importIsolationStats.dedupedCalls += 1' in audio_isolation

assert '__readerSemanticImportStats' in bridge
assert 'let activeSemanticImport = null' in bridge
assert 'let semanticImportGeneration = 0' in bridge
assert 'assertCurrentImport(generation)' in bridge
assert 'semanticImportStats.superseded += 1' in bridge
assert 'semanticImportStats.cancelled += 1' in bridge
assert 'activeSemanticImport?.fingerprint === fingerprint' in bridge
assert 'return activeSemanticImport.promise' in bridge
assert 'await imgStoreDeleteBook(bookId)' in bridge
assert 'pendingLocalLibrary = localLibrarySnapshot' in bridge
assert '__readerSupersedeSemanticImport' in bridge

assert 'scripts/audit_toc128_audio_epub_reuse.py' in runner
assert '__readerAudioEpubIsolationV3' in audio_epub_audit
assert 'FIRST_TITLE' in audio_epub_audit and 'SECOND_TITLE' in audio_epub_audit
assert 'supersededCallsDelta' in audio_epub_audit
assert 'semanticSupersededDelta' in audio_epub_audit
assert 'semanticCancelledDelta' in audio_epub_audit
assert 'finalPreviewHasFirst' in audio_epub_audit
assert 'staleDurableMatches' in audio_epub_audit
assert 'openedHasOriginalAudio' in audio_epub_audit

for runtime_path in (root / 'js').rglob('*.js'):
    runtime_source = runtime_path.read_text(encoding='utf-8')
    assert 'reader-app.js?v=77.32' not in runtime_source, f'duplicate Reader module identity survived: {runtime_path}'

print('toc129 import/storage source gate: PASS')
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
  js/reader/android-external-import.js \
  js/reader/handler-bridge.js \
  js/reader/audio-epub-import-isolation.js \
  js/reader/delete-fix.js; do
  target="$TMP/$(echo "$f" | tr '/' '_').mjs"
  cp "$f" "$target"
  node --check "$target"
done

python3 -m py_compile scripts/audit_toc128_audio_epub_reuse.py

echo 'toc129 JS/Python syntax: PASS'
