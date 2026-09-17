#!/usr/bin/env python3
"""Builds data/ja_vocab_frequency.tsv - the frequency-ordered Japanese word list
the vocabulary test ranks against, the way data/zh_vocab_frequency.txt.gz and
data/en_vocab_frequency.tsv do for Chinese and English.

    pip install wordfreq msgpack
    python3 scripts/make_ja_freq.py

Why two sources rather than one.

JMdict alone cannot order this list. Its priority tags are the only frequency
signal it carries, and they are the wrong shape: ichi1 marks ~10000 core words
with no order among them, and nfXX is newspaper frequency in buckets of 500.
Ranking on them put 会社 at #33 while leaving 行く and 好き off the list
entirely and pushing 食べる to #11741 and 寒い to #18802 - a test that asks a
beginner about 委員会 before 食べる.

wordfreq alone cannot fill it either. Its Japanese data is tokenized into
morphemes, so the head of the list is grammar (の, に, て, は, が, た) and
single kana collide with rare homographs: て resolves to 手 "hand", し to 子
"child", ね to 根 "root". None of those is the word actually on the page.

So: wordfreq decides the order, JMdict decides what counts as a word. A token
survives only if the bundled dictionary knows it, which drops the morpheme
debris, and the grammar that survives that test is dropped by part of speech
and by the kana-length rule below. What is left is 人 #1, 好き #33, 今日 #78,
行く #97 - an order a learner is actually measured against.

The cost of the kana rule is a handful of real kana words two characters long
(する, いる, ある, こと). They are the first words anyone learns, so losing
them off the end of the test costs nothing; keeping them would mean keeping
です and ます beside them.
"""
import gzip
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DICT_PATH = REPO / 'data' / 'ja_dict_core.json'
OUT_PATH = REPO / 'data' / 'ja_vocab_frequency.tsv'

# Enough to measure anyone: the Chinese list is 40k and the English one 36k.
MAX_WORDS = 40000
# A smaller list than this means a source changed shape and the ranking is not
# what the test thinks it is; better to fail than to ship a silent regression.
MIN_WORDS = 30000

KANA_ONLY = re.compile(r'^[ぁ-ゖー]+$')
HAS_JAPANESE = re.compile(r'[一-鿿々〆ぁ-ゖァ-ヺー]')
# Particles, suffixes and prefixes are grammar, not vocabulary to be tested.
SKIP_POS = {'prt', 'suf', 'pref'}


def load_frequency_order():
    """wordfreq's Japanese list, most frequent first."""
    try:
        import msgpack
        import wordfreq
    except ImportError as exc:
        sys.exit(f'{exc}. Run: pip install wordfreq msgpack')

    data_path = Path(wordfreq.__file__).parent / 'data' / 'large_ja.msgpack.gz'
    if not data_path.exists():
        sys.exit(f'missing {data_path}')
    with gzip.open(data_path) as handle:
        payload = msgpack.load(handle, raw=False)
    # The file is a header followed by buckets of equal-frequency words, in
    # descending frequency order.
    order = []
    for bucket in payload[1:]:
        order.extend(bucket)
    return order


def main():
    if not DICT_PATH.exists():
        sys.exit(f'missing {DICT_PATH} - build it with scripts/make-ja-dict.mjs first')
    dictionary = json.loads(DICT_PATH.read_text(encoding='utf-8'))
    index, entries = dictionary['map'], dictionary['entries']

    rows, seen = [], set()
    for token in load_frequency_order():
        if len(rows) >= MAX_WORDS:
            break
        entry_id = index.get(token)
        if entry_id is None or token in seen:
            continue
        reading, pos, _gloss = entries[entry_id]
        if pos in SKIP_POS:
            continue
        if KANA_ONLY.match(token) and len(token) <= 2:
            continue
        if not HAS_JAPANESE.search(token):
            continue
        seen.add(token)
        # A kana spelling is its own reading; the reader indexes both columns at
        # the same rank so 意見 and いけん resolve alike.
        rows.append((token, token if KANA_ONLY.match(token) else (reading or token), pos or ''))

    if len(rows) < MIN_WORDS:
        sys.exit(f'only {len(rows)} words survived filtering, expected at least {MIN_WORDS}')

    OUT_PATH.write_text(''.join(f'{w}\t{r}\t{p}\n' for w, r, p in rows), encoding='utf-8')
    print(f'{OUT_PATH.relative_to(REPO)}: {len(rows)} words')
    print('first 12:', ' '.join(w for w, _, _ in rows[:12]))


if __name__ == '__main__':
    main()
