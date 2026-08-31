#!/usr/bin/env bash
set -euo pipefail
APK="${1:-$(find android/app/build/outputs/apk/debug -name '*.apk' | head -1)}"
test -f "$APK"
rm -rf /tmp/toc123-apkcheck
mkdir -p /tmp/toc123-apkcheck
unzip -q "$APK" -d /tmp/toc123-apkcheck \
  assets/www/js/reader/interactions.js \
  assets/www/js/reader/pages-mode.js \
  assets/www/js/reader-app.js \
  assets/www/js/reader/epub.js \
  assets/www/js/reader/toc-runtime.js \
  assets/www/js/reader/fr-vocab-estimate.js \
  assets/www/js/reader/fr-lexical-pipeline-v2.js \
  assets/www/js/reader/fr-unknown-gloss.js \
  assets/www/js/reader/interactions-runtime.js \
  assets/frreader/fr_vocab_frequency.tsv \
  assets/frreader/fr_vocab_lemma.tsv \
  assets/frreader/fr_ru_core.json
cd /tmp/toc123-apkcheck
cat > /tmp/toc123-apk.sha256 <<'EOF'
b709451dec2849b8487b054fd8f52c57ef9fc91dc5f5818ed5720e00dda08ba6  assets/www/js/reader/interactions.js
13ce9f42db4427e1c2442abad7c0e66343aad92d79a4e945376fb42afed8e7d9  assets/www/js/reader/pages-mode.js
202e287af1158b8498e44ae3e9ce28cf43b1a0aaaba9f01b25bfdfa2fde47f04  assets/www/js/reader-app.js
896834e059da0a3c59b779e94705bb61187c9b4db31d6590d8c76cc4941770e7  assets/www/js/reader/epub.js
d0ee752392b38822cfaeb0d557f7c359ca4aae166650b8844adfb9012bc38d8c  assets/www/js/reader/toc-runtime.js
563ca7f6e73f5f55f5033850572286887a19c02c6077db25c3f5ea7be25fd8a1  assets/www/js/reader/fr-vocab-estimate.js
d1da657915239ecfabd75ef057a28635af16b81cfcd69f5deef10d972b18af79  assets/www/js/reader/fr-lexical-pipeline-v2.js
1994a8c7d6b845930ef23df70dfe25d80df6666606137523e5af5aadfa7b161e  assets/www/js/reader/fr-unknown-gloss.js
EOF
sha256sum -c /tmp/toc123-apk.sha256
test -s assets/frreader/fr_vocab_frequency.tsv
test -s assets/frreader/fr_vocab_lemma.tsv
test -s assets/frreader/fr_ru_core.json
! grep -q 'fr-context-gloss' assets/www/js/reader/interactions-runtime.js
python3 - <<'PY'
import json
from pathlib import Path
d=json.loads(Path('assets/frreader/fr_ru_core.json').read_text(encoding='utf-8'))
assert d.get('elle','').strip().lower()=='она', d.get('elle')
print('toc123 APK payload matches frozen Reader + isolated French layer')
PY
