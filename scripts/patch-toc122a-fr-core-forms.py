#!/usr/bin/env python3
from pathlib import Path

p = Path('scripts/build_fr_reader_resources.py')
s = p.read_text(encoding='utf-8')
old = """        if surface in options:
            lemma_map[surface] = surface
            ambiguous += 1
        elif best_rank <= 1000 and (second_rank >= best_rank * 4 or second_rank - best_rank >= 1500):
"""
new = """        # Some ultra-common grammatical forms collide with noisy lexical
        # headwords in subtitle-derived data. Prefer the grammatical analysis
        # only where the collision is effectively artificial in normal prose.
        core_form = {'ai': 'avoir'}.get(surface)
        if core_form and core_form in options:
            lemma_map[surface] = core_form
        elif surface in options:
            lemma_map[surface] = surface
            ambiguous += 1
        elif best_rank <= 1000 and (second_rank >= best_rank * 4 or second_rank - best_rank >= 1500):
"""
if s.count(old) != 1:
    raise SystemExit(f'toc122a core-form anchor count={s.count(old)}')
s = s.replace(old, new, 1)
p.write_text(s, encoding='utf-8')
print('toc122a French core auxiliary morphology applied')
