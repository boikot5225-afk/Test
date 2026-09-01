#!/usr/bin/env bash
set -euo pipefail

cat > /tmp/toc125-core.sha256 <<'EOF'
b709451dec2849b8487b054fd8f52c57ef9fc91dc5f5818ed5720e00dda08ba6  js/reader/interactions.js
13ce9f42db4427e1c2442abad7c0e66343aad92d79a4e945376fb42afed8e7d9  js/reader/pages-mode.js
202e287af1158b8498e44ae3e9ce28cf43b1a0aaaba9f01b25bfdfa2fde47f04  js/reader-app.js
c10f3680fb122c4f04a730ddb298f88165c29d5b24978cc5868560531f752361  js/reader/chapter-render.js
896834e059da0a3c59b779e94705bb61187c9b4db31d6590d8c76cc4941770e7  js/reader/epub.js
d0ee752392b38822cfaeb0d557f7c359ca4aae166650b8844adfb9012bc38d8c  js/reader/toc-runtime.js
c4ad630e243b1d3707a05fa40a74d256ac1bc469ff30ae499fa0fa95262e5faa  js/reader/en-vocab-estimate.js
7d6d3933dc23c57280cbbaa2aa8d492130c715923cc0ccd89bbfeecce096e333  js/reader/en-unknown-gloss-v2.js
EOF
sha256sum -c /tmp/toc125-core.sha256

node --check js/reader/fr-reader-pipeline-v2.js
node --check js/reader/fr-context-batch-v5.js
node --check js/reader/fr-lexical-pipeline-v2.js
node --check js/reader/interactions-runtime.js
node --check functions/fr-context-task.js
python3 -m py_compile scripts/make_fr_context_batch_audit_epub_toc125.py scripts/audit_toc125_fr_context_batch_live.py scripts/audit_toc125_frozen_swipe.py scripts/bootstrap_toc123_french_reader_live.py

grep -q "fr-reader-pipeline-v2.js?v=1" js/reader/interactions-runtime.js
grep -q "fr-context-batch-v5.js?v=1" js/reader/interactions-runtime.js
! grep -q "^import './fr-context-refine-v2.js" js/reader/interactions-runtime.js
! grep -q "^import './fr-context-batch-v4.js" js/reader/interactions-runtime.js
! grep -q "^import './fr-context-batch-v3.js" js/reader/interactions-runtime.js
! grep -q "^import './fr-vocab-estimate.js" js/reader/interactions-runtime.js
! grep -q "^import './fr-unknown-gloss.js" js/reader/interactions-runtime.js
! grep -q "new MutationObserver" js/reader/fr-reader-pipeline-v2.js
! grep -q "new MutationObserver" js/reader/fr-context-batch-v5.js
! grep -q "node.textContent = 'перевод" js/reader/fr-context-batch-v5.js
! grep -q "signInAnonymously" js/reader/fr-context-batch-v5.js
! grep -q "auth.currentUser" js/reader/fr-context-batch-v5.js

grep -q "task: 'fr_context_batch'" js/reader/fr-context-batch-v5.js
grep -q "httpsCallable('readerAI')" js/reader/fr-context-batch-v5.js
grep -q "MAX_TARGETS = 24" js/reader/fr-context-batch-v5.js
grep -q "user la force" functions/fr-context-task.js
grep -q "NEVER \"износить\"" functions/fr-context-task.js
grep -q "t'ennuiera" functions/fr-context-task.js

rm -rf android/app/src/main/assets/frreader build/fr-toc125-cache /tmp/fr-toc125-selftest /tmp/fr-toc125-selftest-cache
mkdir -p android/app/src/main/assets/frreader
python3 scripts/build_fr_reader_resources.py --output-dir /tmp/fr-toc125-selftest --cache-dir /tmp/fr-toc125-selftest-cache --self-test
python3 scripts/build_fr_reader_resources.py --output-dir android/app/src/main/assets/frreader --cache-dir build/fr-toc125-cache

test -s android/app/src/main/assets/frreader/fr_vocab_frequency.tsv
test -s android/app/src/main/assets/frreader/fr_vocab_lemma.tsv
test -s android/app/src/main/assets/frreader/fr_ru_core.json
test -s android/app/src/main/assets/frreader/fr_ru_senses.json

python3 - <<'PY'
from pathlib import Path
import json,re
lemma={}
for line in Path('android/app/src/main/assets/frreader/fr_vocab_lemma.tsv').read_text(encoding='utf-8').splitlines():
    if '\t' in line:
        a,b=line.split('\t',1); lemma[a]=b
for w,e in {'est':'être','suis':'être','étaient':'être','ai':'avoir','avait':'avoir'}.items():
    assert lemma.get(w,w)==e,(w,lemma.get(w))
core=json.loads(Path('android/app/src/main/assets/frreader/fr_ru_core.json').read_text(encoding='utf-8'))
for word in ('elle','tendre','vouloir','user','ennuyer','préciser'):
    assert core.get(word,'').strip(), (word,core.get(word))
b=Path('android/app/build.gradle').read_text(encoding='utf-8')
assert re.search(r'versionCode\s+1018\b',b)
assert "versionName '77.42-toc125-fr-context-batch'" in b
print('toc125 frozen Reader + guest-safe paragraph context batch source PASS')
PY
