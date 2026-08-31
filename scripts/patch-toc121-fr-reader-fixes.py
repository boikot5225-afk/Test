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
    out, count = re.subn(pattern, lambda _match: repl, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one regex match, got {count}')
    return out


# 1) French resource builder: preserve ambiguous inflected forms with a
# deterministic frequency-ranked tie-breaker instead of dropping morphology.
p = Path('scripts/build_fr_reader_resources.py')
s = read(p)
old = """        best_lemma, best_rank = ordered[0]
        second_rank = ordered[1][1]
        if best_rank <= 1000 and (second_rank >= best_rank * 4 or second_rank - best_rank >= 1500):
            lemma_map[surface] = best_lemma
        elif surface == best_lemma:
            lemma_map[surface] = surface
        else:
            ambiguous += 1
"""
new = """        best_lemma, best_rank = ordered[0]
        # toc121: keep the best frequency-ranked candidate instead of dropping
        # the surface completely. Dropping ambiguous forms made the reader know
        # "fumer" but fail on perfectly normal "fumant". A wrong low-frequency
        # homograph is cheaper to correct with context than no morphology at all.
        lemma_map[surface] = best_lemma
        ambiguous += 1
"""
s = replace_once(s, old, new, 'builder ambiguity policy')
s = replace_once(
    s,
    '"ambiguous_forms_left_unmapped": ambiguous,',
    '"ambiguous_forms_resolved_by_frequency": ambiguous,\n        "ambiguous_forms_left_unmapped": 0,',
    'builder manifest ambiguity field',
)
s = replace_once(
    s,
    '{"lemma":"faire","pos":"VERB","rank":20,"count":50,"cefr":"A1","gender":"","forms":"fait:surface;faire:surface"},',
    '{"lemma":"faire","pos":"VERB","rank":20,"count":50,"cefr":"A1","gender":"","forms":"fait:surface;faire:surface"},\n'
    '            {"lemma":"fumer","pos":"VERB","rank":40,"count":40,"cefr":"A2","gender":"","forms":"fumant:part;fume:surface;fumer:surface"},\n'
    '            {"lemma":"fumant","pos":"ADJ","rank":2400,"count":4,"cefr":"B2","gender":"","forms":"fumant:surface"},',
    'builder fumant self-test data',
)
s = replace_once(
    s,
    'assert lemma_map["avait"] == "avoir"\n            assert meta["ranked_lemmas"] == 3',
    'assert lemma_map["avait"] == "avoir"\n'
    '            assert lemma_map["fumant"] == "fumer"\n'
    '            assert meta["ranked_lemmas"] == 5',
    'builder fumant self-test assertion',
)
write(p, s)

# 2) Runtime imports: lexical pipeline is evaluated after the vocabulary owner
# and before glosses. Retire the weak v1 context matcher.
p = Path('js/reader/interactions-runtime.js')
s = read(p)
s = replace_once(
    s,
    "import './fr-vocab-estimate.js?v=1'; // toc120: French frequency/lemma Known-Unknown parity\n"
    "import './fr-unknown-gloss.js?v=1'; // toc120: bundled WikDict FR->RU under Unknown\n"
    "import './fr-context-gloss.js?v=1'; // toc120: ML Kit context refines ambiguous FR senses",
    "import './fr-vocab-estimate.js?v=2-manual-authority'; // toc121: manual Known/Unknown survives every repaint\n"
    "import './fr-lexical-pipeline-v2.js?v=2'; // toc121: same lemma/POS/rank/dictionary for card + text\n"
    "import './fr-unknown-gloss.js?v=2-sanitize'; // toc121: clean bundled WikDict fallback\n"
    "import './fr-context-gloss-v2.js?v=2'; // toc121: target-aware ML Kit + DeepSeek context",
    'French runtime imports',
)
write(p, s)

# 3) French vocabulary module: external morphology corrections outrank raw
# Wordhoard surface, proper names are excluded, and manual decisions are mirrored
# onto rendered surface states so the core reader sees the same truth.
p = Path('js/reader/fr-vocab-estimate.js')
s = read(p)
s = replace_once(
    s,
    "function lemmaForWordSync(word){const raw=normalizeSurface(word);if(!raw)return'';if(!frenchData)return raw;",
    "function lemmaForWordSync(word){const raw=normalizeSurface(word);if(!raw)return'';"
    "try{const corrected=normalizeSurface(globalThis.readerFrenchLexicalOverrideLemmaFor?.(raw)||'');if(corrected)return corrected;}catch{}"
    "if(!frenchData)return raw;",
    'French lemma correction bridge',
)
s = replace_once(
    s,
    "function classificationForSnapshot(word,profile,manualMap){const canonical=lemmaForWordSync(word);if(!canonical)return{value:'',source:'',lemma:'',index:null,rank:null};",
    "function classificationForSnapshot(word,profile,manualMap){const canonical=lemmaForWordSync(word);if(!canonical)return{value:'',source:'',lemma:'',index:null,rank:null};"
    "try{if(globalThis.readerFrenchIsProperWord?.(word))return{value:'',source:'proper',lemma:canonical,index:null,rank:null};}catch{}",
    'French proper-name exclusion',
)
new_mark = """async function markCurrentWord(known){if(currentLang()!=='fr')return;const word=currentPanelWord();if(!word||word==='—')return;try{await loadFrenchData();}catch{}const found=findWordState(word,true),state=found.state;if(!state)return;const stamp=new Date().toISOString(),manual=known?'known':'unknown';state.word=found.canonical||state.word||word;state.lang='fr';state.manualKnowledge=manual;state.manualKnowledgeAt=stamp;state.known=!!known;state.autoKnown=false;state.saved=!known;state.status=known?'known':'problem';state.updatedAt=stamp;const root=document.getElementById('reader-chapter-text');root?.querySelectorAll('.reader-word[data-word]').forEach(el=>{if(canonicalLang(el.dataset.lang||currentLang())!=='fr')return;const surface=normalizeSurface(el.dataset.word||el.textContent||'');if(!surface||lemmaForWordSync(surface)!==found.canonical)return;const key=directStateKey(surface),alias=found.store[key]||(found.store[key]={word:surface,lang:'fr',seen:0,clicked:0,saved:false,known:false,status:'new',places:{},clickContexts:{},updatedAt:stamp});alias.word=surface;alias.lang='fr';alias.lemma=found.canonical;alias.linkedLemma=found.canonical;alias.manualKnowledge=manual;alias.manualKnowledgeAt=stamp;alias.known=!!known;alias.autoKnown=false;alias.saved=!known;alias.status=known?'known':'problem';alias.updatedAt=stamp;});persistWordState(found.store);root?.querySelectorAll('.reader-word[data-word]').forEach(el=>{if(canonicalLang(el.dataset.lang||currentLang())!=='fr')return;if(lemmaForWordSync(el.dataset.word||'')!==found.canonical)return;applyClassificationToElement(el,classificationFor(el.dataset.word||''));});syncPanelKnowledge();try{window.dispatchEvent(new CustomEvent('reader:fr-vocab-ready'));}catch{}showToast(known?'✓ Знаю':'Не знаю');}"""
s = re_once(
    s,
    r"async function markCurrentWord\(known\)\{.*?\}\s*function randomNormal",
    new_mark + '\nfunction randomNormal',
    'French manual authority function',
    flags=re.S,
)
write(p, s)

# 4) Core state: manual Knowledge is first-class and cannot be demoted by later
# clicks, common-word auto-state, pruning, or generic repaint.
p = Path('js/reader/word-state.js')
s = read(p)
s = replace_once(
    s,
    "  const isPrunable = (state) => !state?.saved && !state?.known\n    && !['problem', 'hard', 'familiar'].includes(state?.status);",
    "  const isPrunable = (state) => !state?.saved && !state?.known && !state?.manualKnowledge\n"
    "    && !['problem', 'hard', 'familiar'].includes(state?.status);",
    'word state prune manual',
)
s = replace_once(
    s,
    "      if (isCommonWord(word, language)) {",
    "      if (isCommonWord(word, language) && !state.manualKnowledge) {",
    'word state common manual authority',
)
s = replace_once(
    s,
    "    if (!state.saved && !state.known) state.status = 'looked';",
    "    if (!state.saved && !state.known && !state.manualKnowledge) state.status = 'looked';",
    'word state click manual authority',
)
s = replace_once(
    s,
    "    const seen = Number(state?.seen || 0);\n    if (state?.known || state?.status === 'known') return { cls: 'rw-known', title: 'изучено' };",
    "    const seen = Number(state?.seen || 0);\n"
    "    const manual = String(state?.manualKnowledge || '').trim().toLowerCase();\n"
    "    if (manual === 'unknown') return { cls: 'rw-problem', title: 'Не знаю · вручную' };\n"
    "    if (manual === 'known') return { cls: 'rw-known', title: 'Знаю · вручную' };\n"
    "    if (state?.known || state?.status === 'known') return { cls: 'rw-known', title: 'изучено' };",
    'word state visual manual authority',
)
write(p, s)

# 5) Local word lookup: French asks the shared Wordhoard/WikDict pipeline before
# legacy app verb/noun tables.
p = Path('js/reader/word-lookup.js')
s = read(p)
s = replace_once(
    s,
    "    if (lang === 'ja') return lookupJapaneseWord?.(normalized) || null;\n\n    const quick = quickLookup(normalized);",
    "    if (lang === 'ja') return lookupJapaneseWord?.(normalized) || null;\n\n"
    "    if (lang === 'fr' && typeof globalThis.readerFrenchLexicalAnalysisFor === 'function') {\n"
    "      const french = await globalThis.readerFrenchLexicalAnalysisFor(normalized);\n"
    "      if (french) return french;\n"
    "    }\n\n"
    "    const quick = quickLookup(normalized);",
    'word lookup French pipeline',
)
write(p, s)

# 6) Immediate bundled gloss: clean broken annotations and skip proper names.
p = Path('js/reader/fr-unknown-gloss.js')
s = read(p)
s = re_once(
    s,
    r"function compactRussian\(value\)\{.*?\}\s*function glossFontSize",
    """function compactRussian(value){let full=String(value||'').replace(/\\s+/g,' ').trim();if(!full||!containsCyrillic(full))return'';try{const shared=globalThis.readerFrenchSanitizeRussian?.(full,72);if(shared)full=shared;}catch{}full=full.replace(/\\[\\[([^\\]]+)\\]\\]/g,'$1').replace(/\\s*\\[[^\\]]*$/g,'').replace(/^[,;:|/\\s]+|[,;:|/\\s]+$/g,'').trim();const first=full.split(/\\s*\\|\\s*|\\s*[;；]\\s*|\\s*\\/\\s*/).filter(Boolean)[0]||full;if(first.length<=34)return first;const words=first.split(/\\s+/).filter(Boolean);let out='';for(const word of words){const next=out?`${out} ${word}`:word;if(next.length>34)break;out=next;}return out||first.slice(0,34).trim();}\nfunction glossFontSize""",
    'French gloss sanitizer',
    flags=re.S,
)
s = replace_once(
    s,
    "for(const el of root.querySelectorAll('.reader-word[data-word]')){if(!isFrenchWord(el))continue;",
    "for(const el of root.querySelectorAll('.reader-word[data-word]')){if(!isFrenchWord(el)||globalThis.readerFrenchIsProperWord?.(el.dataset.word||el.textContent||''))continue;",
    'French prepare proper skip',
)
s = replace_once(
    s,
    "for(const el of scope.root.querySelectorAll('.reader-word[data-word]')){if(!isFrenchWord(el)||knowledge(el)!=='unknown')continue;",
    "for(const el of scope.root.querySelectorAll('.reader-word[data-word]')){if(!isFrenchWord(el)||globalThis.readerFrenchIsProperWord?.(el.dataset.word||el.textContent||'')||knowledge(el)!=='unknown')continue;",
    'French scan proper skip',
)
write(p, s)

# 7) Reader orchestration: show local French card immediately, then make one exact
# context AI pass (cached per context). Context POS and Russian strings are the
# authoritative result and are broadcast back into the inline pipeline.
p = Path('js/reader-app.js')
s = read(p)
s = replace_once(
    s,
    "        } else if (activeLang === 'en' && !hasIpa) {\n"
    "          await readerTranslateWordAI({ force: true, skipLocal: true });\n"
    "        }",
    "        } else if (activeLang === 'en' && !hasIpa) {\n"
    "          await readerTranslateWordAI({ force: true, skipLocal: true });\n"
    "        } else if (activeLang === 'fr') {\n"
    "          // toc121: local Wordhoard/WikDict gives an instant card, then one\n"
    "          // exact-context AI pass resolves meaning and grammatical role.\n"
    "          await readerTranslateWordAI({ force: true, skipLocal: true });\n"
    "        }",
    'French exact-context followup',
)
old_instruction = ": 'Return JSON only: {pos:\"noun|verb|adjective|adverb|preposition|pronoun|other\", lemma, infinitive, ru, gender:\"m|f|\", level:\"A1|A2|B1|B2\", tense, person, number, form_note, note}. For French conjugated verb forms, lemma and infinitive must be the infinitive; explain the selected surface form in form_note. For nouns, give gender.'"
new_instruction = ": 'Return JSON only: {pos:\"noun|verb|adjective|adverb|preposition|pronoun|proper_noun|other\", context_pos, lemma, infinitive, ru, gender:\"m|f|\", level:\"A1|A2|B1|B2\", tense, person, number, form_note, note}. Analyze THIS exact context. ru must be the short Russian meaning in this sentence, not dictionary sense #1. pos/context_pos must describe the function in this sentence (for example an adjective used adverbially => adverb). For French verb forms, lemma/infinitive must be the infinitive. If this is a person/place/name, use proper_noun. Every user-visible string (ru, form_note, note) must be Russian; never write an English explanation. For nouns, give gender.'"
s = replace_once(s, old_instruction, new_instruction, 'French AI instruction')
s = replace_once(
    s,
    "    const d = data.data || data;\n    const pos = readerSimplifyPos(d.pos || d.type || (d.infinitive || d.inf ? 'verb' : 'noun'));\n    const payload = {\n      ...d,\n      lang: readerCurrentLang(),",
    "    const d = data.data || data;\n"
    "    const rawPos = sourceLang === 'fr' ? (d.context_pos || d.usage_pos || d.pos || d.type) : (d.pos || d.type);\n"
    "    const pos = readerSimplifyPos(rawPos || (d.infinitive || d.inf ? 'verb' : 'noun'));\n"
    "    const frNote = sourceLang === 'fr' ? String(d.note || '').trim() : '';\n"
    "    const frFormNote = sourceLang === 'fr' ? String(d.form_note || d.note || '').trim() : '';\n"
    "    const payload = {\n"
    "      ...d,\n"
    "      note: sourceLang === 'fr' && frNote && !/[\\u0400-\\u052f]/.test(frNote) ? '' : d.note,\n"
    "      lang: readerCurrentLang(),",
    'French contextual POS payload',
)
s = replace_once(
    s,
    "      form_note: d.form_note || d.pinyin || d.tense || d.note || localZhHint.note || localJaHint.form_note || ''\n    };",
    "      form_note: sourceLang === 'fr'\n"
    "        ? ((frFormNote && /[\\u0400-\\u052f]/.test(frFormNote)) ? frFormNote : '')\n"
    "        : (d.form_note || d.pinyin || d.tense || d.note || localZhHint.note || localJaHint.form_note || '')\n"
    "    };",
    'French Russian-only form note',
)
english_context_line = "    if (sourceLang === 'en' && hasContext) readerPublishEnglishContextGloss(word, context, payload.ru);"
french_event = """    if (sourceLang === 'fr' && hasContext) {
      try {
        document.dispatchEvent(new CustomEvent('reader:fr-analysis-ready', {
          detail: { surface: word, word, context, ...payload, context_pos: pos, usage_pos: pos, isProper: pos === 'proper_noun' },
        }));
      } catch {}
    }"""
s = replace_once(
    s,
    english_context_line,
    english_context_line + '\n' + french_event,
    'French analysis event',
)
s = replace_once(
    s,
    "    const localFallback = cachedFallback || (skipLocal ? (readerLookupChineseWord(word) || readerLookupJapaneseWord(word)) : null);",
    "    const fallbackLang = readerCurrentLang();\n"
    "    const localFallback = cachedFallback || (skipLocal\n"
    "      ? (fallbackLang === 'fr' ? await readerLookupWord(word) : (readerLookupChineseWord(word) || readerLookupJapaneseWord(word)))\n"
    "      : null);",
    'French AI fallback preserves local card',
)
write(p, s)

print('toc121 French reader fix patch applied')