#!/usr/bin/env python3
from pathlib import Path

p = Path('.github/workflows/android-apk-toc123-fr-isolated.yml')
s = p.read_text(encoding='utf-8')

old = '''          # Force one visible French word into Unknown only for the audit; this
          # does not change page-mode or any Reader navigation state.
          ok=ev("(()=>{const el=[...document.querySelectorAll('#reader-chapter-text .reader-word[data-word]')].find(x=>/[A-Za-zÀ-ÿ]/.test(x.dataset.word||x.textContent||''));if(!el)return false;el.classList.remove('rw-migaku-known');el.classList.add('rw-migaku-unknown');window.dispatchEvent(new CustomEvent('reader:fr-vocab-ready'));return true})()")
          if not ok: raise RuntimeError('No French word for gloss audit')
          gloss=''
          for _ in range(80):
              gloss=ev("[...document.querySelectorAll('#reader-chapter-text .rw-fr-gloss-text')].map(x=>x.textContent.trim()).find(x=>/[А-Яа-яЁё]/.test(x))||''") or ''
              if gloss: break
              time.sleep(.25)
          if not gloss: raise RuntimeError('No bundled Russian Unknown gloss appeared')
'''

new = '''          # Use the real French vocabulary UI. The old audit cheated by adding
          # rw-migaku-unknown directly; reader:fr-vocab-ready then correctly
          # reclassified that fake class and the gloss test became meaningless.
          target=ev("(()=>[...document.querySelectorAll('#reader-chapter-text .reader-word[data-word]')].find(x=>String(x.dataset.word||x.textContent||'').trim().toLocaleLowerCase('fr-FR')==='elle')?.dataset.word||'')")
          if not target: raise RuntimeError('Deterministic French token Elle is missing from Nada fixture')
          ev("(()=>{const el=[...document.querySelectorAll('#reader-chapter-text .reader-word[data-word]')].find(x=>String(x.dataset.word||x.textContent||'').trim().toLocaleLowerCase('fr-FR')==='elle');el?.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));return !!el})()")
          panel_word=''
          for _ in range(40):
              panel_word=ev("document.getElementById('reader-word-title')?.textContent?.trim()||''") or ''
              if panel_word.lower()=='elle': break
              time.sleep(.1)
          if panel_word.lower()!='elle': raise RuntimeError('French word panel did not open for Elle: '+repr(panel_word))
          clicked=ev("(()=>{const b=document.getElementById('reader-fr-unknown-btn');if(!b)return false;b.click();return true})()")
          if not clicked: raise RuntimeError('Real French Не знаю button is missing')
          manual=False
          for _ in range(50):
              manual=bool(ev("(()=>{const el=[...document.querySelectorAll('#reader-chapter-text .reader-word[data-word]')].find(x=>String(x.dataset.word||x.textContent||'').trim().toLocaleLowerCase('fr-FR')==='elle');return !!el?.classList.contains('rw-migaku-unknown')&&el?.dataset.readerManualKnowledge==='unknown'})()"))
              if manual: break
              time.sleep(.1)
          if not manual: raise RuntimeError('Manual Unknown did not persist for Elle')
          gloss=''
          for _ in range(80):
              gloss=ev("(()=>{const el=[...document.querySelectorAll('#reader-chapter-text .reader-word[data-word]')].find(x=>String(x.dataset.word||x.textContent||'').trim().toLocaleLowerCase('fr-FR')==='elle');return el?.parentElement?.querySelector(':scope > .rw-fr-gloss-text')?.textContent?.trim()||''})()") or ''
              if gloss: break
              time.sleep(.25)
          if gloss.lower()!='она': raise RuntimeError('Expected bundled Elle → она gloss, got '+repr(gloss))
'''

count = s.count(old)
if count != 1:
    raise SystemExit(f'expected exactly one fake-Unknown audit block, got {count}')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('toc123 live audit now uses real manual Unknown')
