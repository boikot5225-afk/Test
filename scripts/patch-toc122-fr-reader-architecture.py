#!/usr/bin/env python3
from pathlib import Path
import re


def read(path):
    return Path(path).read_text(encoding='utf-8')


def write(path, text):
    Path(path).write_text(text, encoding='utf-8')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    return text.replace(old, new, 1)


def re_once(text, pattern, repl, label, flags=0):
    out, count = re.subn(pattern, lambda _m: repl, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one regex match, got {count}')
    return out


# 1) Morphology: a real standalone headword must never be silently replaced by
# another lemma just because it also occurs as that lemma's inflected form.
# Context/DeepSeek may later resolve the ambiguity for the exact occurrence.
p = Path('scripts/build_fr_reader_resources.py')
s = read(p)
old = """        best_lemma, best_rank = ordered[0]
        # toc121: keep the best frequency-ranked candidate instead of dropping
        # the surface completely. Dropping ambiguous forms made the reader know
        # \"fumer\" but fail on perfectly normal \"fumant\". A wrong low-frequency
        # homograph is cheaper to correct with context than no morphology at all.
        lemma_map[surface] = best_lemma
        ambiguous += 1
"""
new = """        best_lemma, best_rank = ordered[0]
        second_rank = ordered[1][1]
        # toc122: if the surface is itself a ranked dictionary headword, keep it
        # as itself.  French has hundreds of collisions such as courant/courir,
        # part/partir, montre/montrer and fini/finir; forcing the most frequent
        # verb here corrupts POS, translation and Known/Unknown before context is
        # even considered.
        if surface in options:
            lemma_map[surface] = surface
            ambiguous += 1
        elif best_rank <= 1000 and (second_rank >= best_rank * 4 or second_rank - best_rank >= 1500):
            lemma_map[surface] = best_lemma
        else:
            ambiguous += 1
"""
s = replace_once(s, old, new, 'safe ambiguous morphology policy')
s = s.replace('"ambiguous_forms_resolved_by_frequency": ambiguous,\n        "ambiguous_forms_left_unmapped": 0,',
              '"ambiguous_forms_preserved_or_left_for_context": ambiguous,\n        "ambiguous_forms_left_unmapped": ambiguous,', 1)
s = replace_once(s, 'assert lemma_map["fumant"] == "fumer"', 'assert lemma_map["fumant"] == "fumant"', 'fumant self-test safe headword')
write(p, s)


# 2) Runtime import order: keep one lexical owner and replace target-token v2 by
# marker-aligned v3.  Old context module is not loaded at all.
p = Path('js/reader/interactions-runtime.js')
s = read(p)
s = replace_once(s,
    "import './fr-context-gloss-v2.js?v=2'; // toc121: target-aware ML Kit + DeepSeek context",
    "import './fr-context-gloss-v3.js?v=3'; // toc122: exact marked target + phrase-aware context",
    'French context v3 import')
write(p, s)


# 3) Lexical owner: conservative morphology for standalone forms and a chapter-
# aware proper-name heuristic.  A later explicit DeepSeek decision (including
# isProper:false) always overrides the heuristic.
p = Path('js/reader/fr-lexical-pipeline-v2.js')
s = read(p)
s = replace_once(
    s,
    "  const word = normalize(surface);\n  if (!word || !data?.rankFold?.get) return '';",
    "  const word = normalize(surface);\n  if (!word || !data?.rankFold?.get) return '';\n  // A standalone ranked headword is ambiguous by definition; do not invent a verb lemma.\n  if (data.rankFold.get(word)) return '';",
    'productive morphology standalone guard',
)
old_analyze = """  const data = await vocabularyData();
  let lemma = lemmaFor(normalized);
  if (lemma === normalized) {
    const productive = productiveLemma(normalized, data);
"""
new_analyze = """  const data = await vocabularyData();
  const heuristicProper = chapterProperHeuristic(surface);
  let lemma = heuristicProper ? normalized : lemmaFor(normalized);
  if (lemma === normalized && !heuristicProper) {
    const productive = productiveLemma(normalized, data);
"""
s = replace_once(s, old_analyze, new_analyze, 'proper before productive morphology')
s = replace_once(
    s,
    "  const proper = override?.isProper || properLemmas.has(lemma) || pos === 'proper_noun';",
    "  const proper = isProper(surface) || pos === 'proper_noun';",
    'shared proper decision',
)
s = replace_once(
    s,
    "  if (!ranked && !ru && !override) return null;",
    "  if (!ranked && !ru && !override && !proper) return null;",
    'allow proper card without dictionary garbage',
)
old_isproper = """function isProper(surface) {
  const normalized = normalize(surface);
  const lemma = overrideLemma(normalized) || lemmaFor(normalized);
  const direct = deepSeekOverrides.get(normalized);
  return !!direct?.isProper || properLemmas.has(lemma);
}
"""
new_isproper = r"""function startsWithFrenchUpper(value) {
  return /^[A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ]/u.test(String(value || '').trim());
}

function textBeforeElement(element, max = 28) {
  let node = element?.previousSibling || null;
  let out = '';
  while (node && out.length < max) {
    out = String(node.textContent || '') + out;
    node = node.previousSibling;
  }
  return out.slice(-max);
}

function chapterProperHeuristic(surface) {
  const raw = String(surface || '').trim();
  if (!raw || !startsWithFrenchUpper(raw) || typeof document === 'undefined') return false;
  const normalized = normalize(raw);
  const root = document.getElementById('reader-chapter-text');
  if (!root) return false;
  const matches = Array.from(root.querySelectorAll('.reader-word[data-word]')).filter((el) => normalize(el.dataset.word || el.textContent || '') === normalized);
  if (!matches.length) return false;
  let capitals = 0, lowers = 0, nonInitial = 0;
  for (const el of matches) {
    const shown = String(el.dataset.word || el.textContent || '').trim();
    if (startsWithFrenchUpper(shown)) capitals += 1; else lowers += 1;
    const before = textBeforeElement(el).trimEnd();
    const sentenceInitial = !before || /[.!?…]\s*$/u.test(before);
    if (startsWithFrenchUpper(shown) && !sentenceInitial) nonInitial += 1;
  }
  // French does not normally capitalize common adjectives/nouns mid-sentence.
  // One clear non-initial capital is enough for an otherwise consistently
  // capitalized token; repeated capitalization also covers paragraph starts.
  return lowers === 0 && capitals > 0 && (nonInitial > 0 || capitals >= 2);
}

function isProper(surface) {
  const normalized = normalize(surface);
  const direct = deepSeekOverrides.get(normalized);
  if (direct && Object.prototype.hasOwnProperty.call(direct, 'isProper')) return !!direct.isProper;
  const lemma = overrideLemma(normalized) || lemmaFor(normalized);
  return properLemmas.has(lemma) || chapterProperHeuristic(surface);
}
"""
s = replace_once(s, old_isproper, new_isproper, 'chapter proper-name heuristic')
write(p, s)


# 4) Vocabulary state: no whole-store lemma guessing.  Only the exact surface,
# its explicit linkedLemma, and the resolved canonical key are allowed to share a
# manual status.  Also repair pollution left by toc121 variants/clickContexts.
p = Path('js/reader/fr-vocab-estimate.js')
s = read(p)
pattern = r"function findWordState\(word,create=false\)\{.*?\}function manualKnowledgeMapSnapshot\(store=wordStateStore\(\)\)\{.*?\}\nfunction classificationForSnapshot"
replacement = r"""function explicitStateCanonical(state){return normalizeSurface(state?.linkedLemma||state?.lemma||state?.word||'');}
function repairFrenchStateStore(store){let changed=false;for(const state of Object.values(store||{})){if(!state||canonicalLang(state.lang)!=='fr')continue;if(Array.isArray(state.variants)){delete state.variants;changed=true;}const canonical=explicitStateCanonical(state);const contexts=state.clickContexts;if(contexts&&typeof contexts==='object'){for(const[key,ctx]of Object.entries(contexts)){const form=normalizeSurface(ctx?.form||'');if(!form||form===normalizeSurface(state.word)||form===canonical)continue;const alias=store[directStateKey(form)];if(!alias||explicitStateCanonical(alias)!==canonical){delete contexts[key];changed=true;}}}}return changed;}
function findWordState(word,create=false){const raw=normalizeSurface(word),canonical=lemmaForWordSync(raw)||raw,store=wordStateStore();if(!canonical)return{store,key:'',state:null,canonical:'',surface:raw};repairFrenchStateStore(store);const rawKey=directStateKey(raw),canonicalKey=directStateKey(canonical),rawState=store[rawKey];if(rawState){const linked=explicitStateCanonical(rawState);if(raw===canonical||linked===canonical||manualKnowledge(rawState))return{store,key:rawKey,state:rawState,canonical,surface:raw};}if(store[canonicalKey])return{store,key:canonicalKey,state:store[canonicalKey],canonical,surface:raw};if(!create)return{store,key:canonicalKey,state:null,canonical,surface:raw};store[canonicalKey]={word:canonical,lang:'fr',seen:0,clicked:0,saved:false,known:false,status:'new',places:{},clickContexts:{},updatedAt:new Date().toISOString()};return{store,key:canonicalKey,state:store[canonicalKey],canonical,surface:raw};}
function manualKnowledgeMapSnapshot(store=wordStateStore()){repairFrenchStateStore(store);const latest=new Map();for(const state of Object.values(store||{})){if(!state||canonicalLang(state.lang)!=='fr')continue;const explicit=manualKnowledge(state);if(!explicit)continue;const stamp=Date.parse(state.manualKnowledgeAt||state.updatedAt||'')||0;for(const canonical of new Set([normalizeSurface(state.word),explicitStateCanonical(state)])){if(!canonical)continue;const prev=latest.get(canonical);if(!prev||stamp>=prev.stamp)latest.set(canonical,{value:explicit,stamp});}}return new Map(Array.from(latest,([word,info])=>[word,info.value]));}
function classificationForSnapshot"""
s = re_once(s, pattern, replacement, 'strict French state linking', flags=re.S)
s = replace_once(
    s,
    "const manual=manualMap?.get(canonical)||'',index=rankIndexForWordSync(canonical)",
    "const manual=manualMap?.get(canonical)||manualMap?.get(normalizeSurface(word))||'',index=rankIndexForWordSync(canonical)",
    'surface manual fallback',
)
pattern = r"function applyClassificationToElement\(el,info\)\{.*?\}\nfunction applyClassificationBatch"
replacement = r"""function applyClassificationToElement(el,info){removeKnowledgeClasses(el);const base=['rw-new','rw-looked','rw-learning','rw-problem','rw-hard','rw-familiar','rw-seen','rw-faded'];if(info?.source==='proper'){for(const cls of base)el.classList.remove(cls);el.classList.add('rw-fr-proper');el.removeAttribute('title');return;}el.classList.remove('rw-fr-proper');if(info?.value==='known')el.classList.add('rw-migaku-known');else if(info?.value==='unknown'){if(info.source!=='manual'&&el.classList.contains('rw-known')){el.classList.add('rw-migaku-known');return;}if(info.source==='manual')el.classList.remove('rw-known');el.classList.add('rw-migaku-unknown');}else return;if(info.source==='manual')el.dataset.readerManualKnowledge=info.value;else el.dataset.readerEstimatedKnowledge=info.value;const surface=normalizeSurface(el.dataset.word||el.textContent||''),lemmaText=info.lemma&&surface!==normalizeSurface(info.lemma)?` · ${info.lemma}`:'',rankText=Number.isInteger(info.rank)?` · частотность #${formatNumber(info.rank)}`:'';el.title=`${info.value==='known'?'Known':'Unknown'}${lemmaText}${rankText}`;}
function applyClassificationBatch"""
s = re_once(s, pattern, replacement, 'proper neutral visual state', flags=re.S)
new_mark = r"""async function markCurrentWord(known){if(currentLang()!=='fr')return;const word=currentPanelWord();if(!word||word==='—')return;try{await loadFrenchData();}catch{}const found=findWordState(word,true),store=found.store,canonical=found.canonical,surface=normalizeSurface(word);if(!canonical)return;repairFrenchStateStore(store);const stamp=new Date().toISOString(),manual=known?'known':'unknown';const apply=(state,stateWord,linked='')=>{state.word=stateWord;state.lang='fr';if(linked&&linked!==stateWord){state.lemma=linked;state.linkedLemma=linked;}state.manualKnowledge=manual;state.manualKnowledgeAt=stamp;state.known=!!known;state.autoKnown=false;state.saved=!known;state.status=known?'known':'problem';state.updatedAt=stamp;delete state.variants;};let canonicalState=store[directStateKey(canonical)]||found.state;if(!canonicalState){canonicalState={word:canonical,lang:'fr',seen:0,clicked:0,saved:false,known:false,status:'new',places:{},clickContexts:{}};store[directStateKey(canonical)]=canonicalState;}apply(canonicalState,canonical);if(surface&&surface!==canonical){const surfaceKey=directStateKey(surface),alias=store[surfaceKey]||{word:surface,lang:'fr',seen:0,clicked:0,saved:false,known:false,status:'new',places:{},clickContexts:{}};store[surfaceKey]=alias;apply(alias,surface,canonical);}repairFrenchStateStore(store);persistWordState(store);const root=document.getElementById('reader-chapter-text');const profile=loadProfile(),manualMap=manualKnowledgeMapSnapshot(store);root?.querySelectorAll('.reader-word[data-word]').forEach(el=>{if(canonicalLang(el.dataset.lang||currentLang())!=='fr')return;applyClassificationToElement(el,classificationForSnapshot(el.dataset.word||'',profile,manualMap));});syncPanelKnowledge();try{window.dispatchEvent(new CustomEvent('reader:fr-vocab-ready'));}catch{}showToast(known?'✓ Знаю':'Не знаю');}"""
s = re_once(s, r"async function markCurrentWord\(known\)\{.*?\}\s*function randomNormal", new_mark + '\nfunction randomNormal', 'isolated manual status update', flags=re.S)
s = replace_once(
    s,
    "function boot(){installExtraStyles();ensureVocabularyButton();installPanelHook();installRenderObserver();installViewObserver();if(currentLang()==='fr')decorateWordPanel();warmFrenchDataWhenUseful();}",
    "function boot(){installExtraStyles();ensureVocabularyButton();installPanelHook();installRenderObserver();installViewObserver();const store=wordStateStore();if(repairFrenchStateStore(store))persistWordState(store);if(currentLang()==='fr')decorateWordPanel();warmFrenchDataWhenUseful();}",
    'repair old French state on boot',
)
s = s.replace("__readerFrenchVocabularyEstimateVersion===1", "__readerFrenchVocabularyEstimateVersion===3", 1).replace("__readerFrenchVocabularyEstimateVersion=1", "__readerFrenchVocabularyEstimateVersion=3", 1)
write(p, s)


# 5) Core French word clicks: stale async lookup/DeepSeek responses must never
# overwrite the panel for a newer word.  This is separate from lexical state and
# prevents the visible card from jumping back to the previous selection.
p = Path('js/reader-app.js')
s = read(p)
s = replace_once(
    s,
    "  const activeLang = readerCurrentLang();\n  readerMarkWordClicked(readerSelectedWord, activeLang);",
    "  const activeLang = readerCurrentLang();\n  const lookupWord = readerSelectedWord;\n  const lookupParagraphIndex = paragraphIndex;\n  const lookupStillActive = () => readerSelectedWord === lookupWord && readerSelectedParagraphIndex === lookupParagraphIndex;\n  readerMarkWordClicked(readerSelectedWord, activeLang);",
    'word panel request identity',
)
s = replace_once(
    s,
    "    const found = await readerLookupWord(readerSelectedWord);\n    if (found) {",
    "    const found = await readerLookupWord(lookupWord);\n    if (!lookupStillActive()) return;\n    if (found) {",
    'local lookup stale guard',
)
s = replace_once(
    s,
    "    await readerTranslateWordAI(false);",
    "    if (lookupStillActive()) await readerTranslateWordAI(false);",
    'AI start stale guard',
)
# readerTranslateWordAI captures the selected word.  Gate all panel mutations after
# asynchronous work; cache/event publication still uses the original word/context.
s = replace_once(
    s,
    "  const word = readerSelectedWord;\n  const st = panel.querySelector('#reader-word-status');",
    "  const word = readerSelectedWord;\n  const requestParagraphIndex = readerSelectedParagraphIndex;\n  const requestStillActive = () => readerSelectedWord === word && readerSelectedParagraphIndex === requestParagraphIndex;\n  const st = panel.querySelector('#reader-word-status');",
    'DeepSeek request identity',
)
s = replace_once(
    s,
    "      data = await readerLexicalInFlight.get(inFlightKey);",
    "      data = await readerLexicalInFlight.get(inFlightKey);\n      if (!requestStillActive()) return data?.data || data || null;",
    'shared in-flight stale guard',
)
s = replace_once(
    s,
    "      try { data = await p; }\n      finally { readerLexicalInFlight.delete(inFlightKey); }",
    "      try { data = await p; if (!requestStillActive()) return data?.data || data || null; }\n      finally { readerLexicalInFlight.delete(inFlightKey); }",
    'fresh AI stale guard',
)
# Error from an old request should not replace the newer panel either.
s = replace_once(
    s,
    "  } catch(e) {\n    const msg = e?.message || String(e);",
    "  } catch(e) {\n    if (!requestStillActive()) return null;\n    const msg = e?.message || String(e);",
    'stale AI error guard',
)
write(p, s)


# 6) Native Android import: content:// remains the normal path; readable file://
# URIs are handled explicitly instead of asking ContentResolver to interpret them.
p = Path('android/app/src/main/java/space/saintjust/reader/stage1/MainActivity.java')
s = read(p)
s = replace_once(s, 'import java.io.ByteArrayInputStream;\nimport java.io.InputStream;', 'import java.io.ByteArrayInputStream;\nimport java.io.File;\nimport java.io.FileInputStream;\nimport java.io.InputStream;', 'native file imports')
s = replace_once(
    s,
    "            InputStream stream = getContentResolver().openInputStream(uri);\n            if (stream == null) {",
    "            InputStream stream;\n            if (\"file\".equalsIgnoreCase(uri.getScheme())) {\n                String path = uri.getPath();\n                if (path == null || path.trim().isEmpty()) throw new IllegalStateException(\"empty file path\");\n                stream = new FileInputStream(new File(path));\n            } else {\n                stream = getContentResolver().openInputStream(uri);\n            }\n            if (stream == null) {",
    'native file/content import stream',
)
write(p, s)

print('toc122 French reader architecture patch applied')
