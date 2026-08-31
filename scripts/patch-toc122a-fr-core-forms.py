#!/usr/bin/env python3
from pathlib import Path
import runpy

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

# Keep the workflow patch chain linear: toc122a is already invoked immediately
# after the main toc122 patch, so refinements are chained here rather than
# duplicating the workflow for each one.
runpy.run_path('scripts/patch-toc122b-native-import-cache.py', run_name='__main__')
runpy.run_path('scripts/patch-toc122f-fr-live-quality.py', run_name='__main__')
runpy.run_path('scripts/patch-toc122h-audit-bootstrap.py', run_name='__main__')
runpy.run_path('scripts/patch-toc122i-native-offline-bootstrap.py', run_name='__main__')
runpy.run_path('scripts/patch-toc122j-webview-regex.py', run_name='__main__')
runpy.run_path('scripts/patch-toc122k-context-cache-scope.py', run_name='__main__')
runpy.run_path('scripts/patch-toc122l-fr-productive-morphology.py', run_name='__main__')
runpy.run_path('scripts/patch-toc122n-fr-contextual-participles.py', run_name='__main__')
runpy.run_path('scripts/patch-toc122o-build-label.py', run_name='__main__')
