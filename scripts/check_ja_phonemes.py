#!/usr/bin/env python3
"""Does the server's Japanese actually reach the model?

Kokoro is handed phoneme characters, and kokoro_onnx drops every character that
is not in the model's 114-symbol vocabulary, silently:

    "".join(filter(lambda p: p in vocab, phonemes))

espeak-ng in Japanese mode spells /a/ as "ä", which is not in that vocabulary,
so every /a/ is deleted on the way in and 「あさ」 reaches the model as "s".
That is why Japanese came out as mush, and it is invisible from the outside:
the request succeeds, the audio plays, the words are simply not there.

Checking that espeak "supports ja", or that it stopped naming kanji aloud, does
not catch this -- both were true while the vowels were being thrown away. The
only question worth asking is how much of the phoneme string survives the
vocabulary, so that is what this asks.

    pip install kokoro-onnx misaki[ja]
    python3 scripts/check_ja_phonemes.py
"""
import sys

SENTENCES = ['朝、六時に起きました。', 'あさ、ろくじにおきました。', 'わたしは会社員です。']
# espeak drops so much that a threshold is generous; misaki drops nothing.
MIN_SURVIVING = 0.95


def main():
    try:
        from kokoro_onnx.tokenizer import Tokenizer
    except ImportError as exc:
        sys.exit(f'{exc}. Run: pip install kokoro-onnx')
    vocab = Tokenizer().vocab

    def survival(phonemes):
        if not phonemes:
            return 0.0
        return sum(1 for p in phonemes if p in vocab) / len(phonemes)

    try:
        from misaki import ja
    except Exception as exc:
        sys.exit(
            f'misaki[ja] is not importable ({exc}).\n'
            'That is the failure this script exists to report: without it the\n'
            'server phonemizes Japanese with espeak-ng and the vowels are\n'
            'dropped before the model sees them. Install misaki[ja] on the\n'
            'server (selfhost/README.md) and run this again.'
        )

    g2p = ja.JAG2P()
    worst = 1.0
    for sentence in SENTENCES:
        phonemes, _ = g2p(sentence)
        rate = survival(phonemes)
        lost = sorted({p for p in phonemes if p not in vocab and p.strip()})
        worst = min(worst, rate)
        print(f'{sentence}\n  {phonemes}\n  survives Kokoro vocab: {rate:.0%}'
              + (f'  lost: {lost}' if lost else ''))

    if worst < MIN_SURVIVING:
        sys.exit(f'only {worst:.0%} of the phonemes reach the model; Japanese will be mush')
    print(f'\nOK: {worst:.0%} of every sentence reaches the model')


if __name__ == '__main__':
    main()
