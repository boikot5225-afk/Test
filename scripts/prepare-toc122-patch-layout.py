#!/usr/bin/env python3
from pathlib import Path

p = Path('js/reader/fr-vocab-estimate.js')
s = p.read_text(encoding='utf-8')

# toc120/toc121 keep this module aggressively minified. toc122 replaces three
# whole functions structurally; stage tiny throwaway bodies so nested braces in
# the old one-line implementation cannot confuse the structural replacement.
# These stubs are immediately replaced by the next script and never ship.
old_find = "function findWordState(word,create=false){const raw=String(word||'').trim(),canonical=lemmaForWordSync(raw)||normalizeSurface(raw),store=wordStateStore();if(!canonical)return{store,key:'',state:null,canonical:''};const key=directStateKey(canonical);if(store[key])return{store,key,state:store[key],canonical};const rawKey=directStateKey(raw);if(store[rawKey])return{store,key:rawKey,state:store[rawKey],canonical};for(const[candidateKey,state]of Object.entries(store)){if(!state||canonicalLang(state.lang)!=='fr')continue;if(lemmaForWordSync(state.word)===canonical)return{store,key:candidateKey,state,canonical};}if(!create)return{store,key,state:null,canonical};store[key]={word:canonical,lang:'fr',seen:0,clicked:0,saved:false,known:false,status:'new',places:{},clickContexts:{},updatedAt:new Date().toISOString()};return{store,key,state:store[key],canonical};}"
old_manual = "function manualKnowledgeMapSnapshot(store=wordStateStore()){const latest=new Map();for(const state of Object.values(store||{})){if(!state||canonicalLang(state.lang)!=='fr')continue;const explicit=manualKnowledge(state);if(!explicit)continue;const canonical=lemmaForWordSync(state.word);if(!canonical)continue;const stamp=Date.parse(state.updatedAt||'')||0,prev=latest.get(canonical);if(!prev||stamp>=prev.stamp)latest.set(canonical,{value:explicit,stamp});}return new Map(Array.from(latest,([word,info])=>[word,info.value]));}"
old_apply = "function applyClassificationToElement(el,info){removeKnowledgeClasses(el);if(info?.value==='known')el.classList.add('rw-migaku-known');else if(info?.value==='unknown'){if(info.source!=='manual'&&el.classList.contains('rw-known')){el.classList.add('rw-migaku-known');return;}if(info.source==='manual')el.classList.remove('rw-known');el.classList.add('rw-migaku-unknown');}else return;if(info.source==='manual')el.dataset.readerManualKnowledge=info.value;else el.dataset.readerEstimatedKnowledge=info.value;const surface=normalizeSurface(el.dataset.word||el.textContent||''),lemmaText=info.lemma&&surface!==normalizeSurface(info.lemma)?` · ${info.lemma}`:'',rankText=Number.isInteger(info.rank)?` · частотность #${formatNumber(info.rank)}`:'';el.title=`${info.value==='known'?'Known':'Unknown'}${lemmaText}${rankText}`;}"
for label, old, new in [
    ('findWordState', old_find, 'function findWordState(word,create=false){return null;}'),
    ('manualKnowledgeMapSnapshot', old_manual, 'function manualKnowledgeMapSnapshot(store=wordStateStore()){return new Map();}'),
    ('applyClassificationToElement', old_apply, 'function applyClassificationToElement(el,info){}'),
]:
    if old not in s:
        raise SystemExit(f'missing toc122 staging anchor: {label}')
    s = s.replace(old, new, 1)
for old, new in {
    '}function classificationForSnapshot': '}\nfunction classificationForSnapshot',
    '}function applyClassificationBatch': '}\nfunction applyClassificationBatch',
}.items():
    if old not in s and new not in s:
        raise SystemExit(f'missing toc122 layout anchor: {old}')
    if old in s:
        s = s.replace(old, new, 1)
p.write_text(s, encoding='utf-8')

# The first toc122 patch revision wrote regexes with every backslash doubled.
# Only touch the three regex-bearing source lines, and collapse each doubled
# backslash pair once. This preserves quotes and all other Python source exactly.
patch = Path('scripts/patch-toc122-fr-reader-architecture.py')
lines = patch.read_text(encoding='utf-8').splitlines()
out = []
fixed = 0
for line in lines:
    if line.startswith('pattern = r"function findWordState') or \
       line.startswith('pattern = r"function applyClassificationToElement') or \
       're_once(s, r"async function markCurrentWord' in line:
        before = line
        line = line.replace('\\\\', '\\')
        if line == before:
            raise SystemExit('toc122 regex repair found target line but no doubled escapes')
        fixed += 1
    out.append(line)
if fixed != 3:
    raise SystemExit(f'toc122 regex repair: expected 3 source lines, fixed {fixed}')
patch.write_text('\n'.join(out) + '\n', encoding='utf-8')
print('toc122 patch state staging + doubled-escape collapse prepared')
