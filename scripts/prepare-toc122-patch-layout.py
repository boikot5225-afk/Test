#!/usr/bin/env python3
from pathlib import Path
import re

p = Path('js/reader/fr-vocab-estimate.js')
s = p.read_text(encoding='utf-8')

# toc120/toc121 keep this module aggressively minified. toc122 replaces three
# whole functions structurally; stage tiny throwaway bodies so nested braces in
# the old one-line implementation cannot confuse the structural replacement.
# These stubs are immediately replaced by the next script and never ship.
old_find = "function findWordState(word,create=false){const raw=String(word||'').trim(),canonical=lemmaForWordSync(raw)||normalizeSurface(raw),store=wordStateStore();if(!canonical)return{store,key:'',state:null,canonical:''};const key=directStateKey(canonical);if(store[key])return{store,key,state:store[key],canonical};const rawKey=directStateKey(raw);if(store[rawKey])return{store,key:rawKey,state:store[rawKey],canonical};for(const[candidateKey,state]of Object.entries(store)){if(!state||canonicalLang(state.lang)!=='fr')continue;if(lemmaForWordSync(state.word)===canonical)return{store,key:candidateKey,state,canonical};}if(!create)return{store,key,state:null,canonical};store[key]={word:canonical,lang:'fr',seen:0,clicked:0,saved:false,known:false,status:'new',places:{},clickContexts:{},updatedAt:new Date().toISOString()};return{store,key,state:store[key],canonical};}"
old_manual = "function manualKnowledgeMapSnapshot(store=wordStateStore()){const latest=new Map();for(const state of Object.values(store||{})){if(!state||canonicalLang(state.lang)!=='fr')continue;const explicit=manualKnowledge(state);if(!explicit)continue;const canonical=lemmaForWordSync(state.word);if(!canonical)continue;const stamp=Date.parse(state.updatedAt||'')||0,prev=latest.get(canonical);if(!prev||stamp>=prev.stamp)latest.set(canonical,{value:explicit,stamp});}return new Map(Array.from(latest,([word,info])=>[word,info.value]));}"
old_apply = "function applyClassificationToElement(el,info){removeKnowledgeClasses(el);if(info?.value==='known')el.classList.add('rw-migaku-known');else if(info?.value==='unknown'){if(info.source!=='manual'&&el.classList.contains('rw-known')){el.classList.add('rw-migaku-known');return;}if(info.source==='manual')el.classList.remove('rw-known');el.classList.add('rw-migaku-unknown');}else return;if(info.source==='manual')el.dataset.readerManualKnowledge=info.value;else el.dataset.readerEstimatedKnowledge=info.value;const surface=normalizeSurface(el.dataset.word||el.textContent||''),lemmaText=info.lemma&&surface!==normalizeSurface(info.lemma)?` · ${info.lemma}`:'',rankText=Number.isInteger(info.rank)?` · частотность #${formatNumber(info.rank)}`:'';el.title=`${info.value==='known'?'Known':'Unknown'}${lemmaText}${rankText}`;}"
stub_find = 'function findWordState(word,create=false){return null;}'
stub_manual = 'function manualKnowledgeMapSnapshot(store=wordStateStore()){return new Map();}'
stub_apply = 'function applyClassificationToElement(el,info){}'
for label, old, new in [
    ('findWordState', old_find, stub_find),
    ('manualKnowledgeMapSnapshot', old_manual, stub_manual),
    ('applyClassificationToElement', old_apply, stub_apply),
]:
    if old not in s:
        raise SystemExit(f'missing toc122 staging anchor: {label}')
    s = s.replace(old, new, 1)

# Normalize whitespace exactly to what the structural patch expects. The source
# has formatting whitespace between otherwise minified function declarations.
s, n1 = re.subn(re.escape(stub_find) + r'\s*' + re.escape(stub_manual), stub_find + stub_manual, s, count=1)
s, n2 = re.subn(re.escape(stub_manual) + r'\s*function classificationForSnapshot', stub_manual + '\nfunction classificationForSnapshot', s, count=1)
s, n3 = re.subn(re.escape(stub_apply) + r'\s*function applyClassificationBatch', stub_apply + '\nfunction applyClassificationBatch', s, count=1)
if (n1, n2, n3) != (1, 1, 1):
    raise SystemExit(f'toc122 staging layout failed: find/manual={n1}, manual/classification={n2}, apply/batch={n3}')
p.write_text(s, encoding='utf-8')

# The same catch body occurs in paragraph analysis and readerTranslateWordAI.
# toc122 must add requestStillActive() only to the word request. Make every
# identical catch outside readerTranslateWordAI syntactically unique while
# preserving its behavior, leaving exactly one anchor for the structural patch.
app_path = Path('js/reader-app.js')
app = app_path.read_text(encoding='utf-8')
needle = "  } catch(e) {\n    const msg = e?.message || String(e);"
word_start = app.find('async function readerTranslateWordAI')
if word_start < 0:
    raise SystemExit('toc122 staging: readerTranslateWordAI not found')
target = app.find(needle, word_start)
if target < 0:
    raise SystemExit('toc122 staging: word AI catch anchor not found')
commented = "  } catch(e) {\n    /* toc122: unrelated async catch */\n    const msg = e?.message || String(e);"
app = app[:target].replace(needle, commented) + app[target:target + len(needle)] + app[target + len(needle):].replace(needle, commented)
if app.count(needle) != 1:
    raise SystemExit(f'toc122 staging: expected one scoped word AI catch, got {app.count(needle)}')
app_path.write_text(app, encoding='utf-8')

print('toc122 patch staging prepared: French state + scoped word AI catch')
