#!/usr/bin/env bash
set -euo pipefail

cat > /tmp/toc119-core.sha256 <<'EOF'
b709451dec2849b8487b054fd8f52c57ef9fc91dc5f5818ed5720e00dda08ba6  js/reader/interactions.js
13ce9f42db4427e1c2442abad7c0e66343aad92d79a4e945376fb42afed8e7d9  js/reader/pages-mode.js
202e287af1158b8498e44ae3e9ce28cf43b1a0aaaba9f01b25bfdfa2fde47f04  js/reader-app.js
c10f3680fb122c4f04a730ddb298f88165c29d5b24978cc5868560531f752361  js/reader/chapter-render.js
8e8f5f6d67929f6b745ec4bd3e1b83010a1460b438886233df8fae34d62bafc1  js/reader/chapter-render-next.js
825555b4553bb9d8f6e448fdbf58d2322e54e33cf07fa8ba5f84d888a531c537  js/reader/chapter-render-stage1.js
8ca5b6dfdbf03309fadc89339ff4cd12d010a84c56122f5c8ea807b9220f562f  js/reader/display.js
896834e059da0a3c59b779e94705bb61187c9b4db31d6590d8c76cc4941770e7  js/reader/epub.js
d0ee752392b38822cfaeb0d557f7c359ca4aae166650b8844adfb9012bc38d8c  js/reader/toc-runtime.js
c4ad630e243b1d3707a05fa40a74d256ac1bc469ff30ae499fa0fa95262e5faa  js/reader/en-vocab-estimate.js
7d6d3933dc23c57280cbbaa2aa8d492130c715923cc0ccd89bbfeecce096e333  js/reader/en-unknown-gloss-v2.js
EOF
sha256sum -c /tmp/toc119-core.sha256

cat > /tmp/toc122-fr-owned.sha256 <<'EOF'
563ca7f6e73f5f55f5033850572286887a19c02c6077db25c3f5ea7be25fd8a1  js/reader/fr-vocab-estimate.js
d1da657915239ecfabd75ef057a28635af16b81cfcd69f5deef10d972b18af79  js/reader/fr-lexical-pipeline-v2.js
1994a8c7d6b845930ef23df70dfe25d80df6666606137523e5af5aadfa7b161e  js/reader/fr-unknown-gloss.js
EOF
sha256sum -c /tmp/toc122-fr-owned.sha256

for f in js/reader/fr-vocab-estimate.js js/reader/fr-lexical-pipeline-v2.js js/reader/fr-unknown-gloss.js; do
  if grep -Eq 'readerNextParagraph|readerPrevParagraph|readerTogglePagesMode|pages-mode|__readerRanging' "$f"; then
    echo "French module illegally owns Reader navigation: $f" >&2
    exit 1
  fi
  node --check "$f"
done
node --check js/reader/interactions-runtime.js
! grep -q 'fr-context-gloss' js/reader/interactions-runtime.js
grep -q "fr-vocab-estimate.js?v=123-isolated" js/reader/interactions-runtime.js
grep -q "fr-lexical-pipeline-v2.js?v=123-isolated" js/reader/interactions-runtime.js
grep -q "fr-unknown-gloss.js?v=123-isolated" js/reader/interactions-runtime.js

rm -rf android/app/src/main/assets/frreader build/fr-toc123-cache /tmp/fr-selftest /tmp/fr-selftest-cache
mkdir -p android/app/src/main/assets/frreader
python3 scripts/build_fr_reader_resources.py --output-dir /tmp/fr-selftest --cache-dir /tmp/fr-selftest-cache --self-test
python3 scripts/build_fr_reader_resources.py --output-dir android/app/src/main/assets/frreader --cache-dir build/fr-toc123-cache
python3 - <<'PY'
from pathlib import Path
import json, re
lemma={}
for line in Path('android/app/src/main/assets/frreader/fr_vocab_lemma.tsv').read_text(encoding='utf-8').splitlines():
    if '\t' in line:
        a,b=line.split('\t',1); lemma[a]=b
for w,e in {'est':'être','suis':'être','étaient':'être','ai':'avoir','avait':'avoir'}.items():
    assert lemma.get(w,w)==e,(w,lemma.get(w))
for w in ('courant','personne','fini','fumant'):
    assert lemma.get(w,w)==w,(w,lemma.get(w))
d=json.loads(Path('android/app/src/main/assets/frreader/fr_ru_core.json').read_text(encoding='utf-8'))
assert d.get('elle','').strip().lower()=='она', d.get('elle')
assert re.search('[А-Яа-яЁё]',d.get('homme','')), d.get('homme')
b=Path('android/app/build.gradle').read_text(encoding='utf-8')
assert re.search(r'versionCode\s+1015\b',b)
assert "versionName '77.42-toc123-fr-isolated'" in b
print('toc123 source architecture + French assets PASS')
PY
