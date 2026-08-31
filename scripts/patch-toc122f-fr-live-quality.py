#!/usr/bin/env python3
from pathlib import Path
import re


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, got {count}')
    return text.replace(old, new, 1)


def re_once(text, pattern, repl, label, flags=0):
    out, count = re.subn(pattern, lambda _m: repl, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 regex match, got {count}')
    return out

# ---------------------------------------------------------------------------
# 1) Lexical owner: keep the conservative homonym policy, but allow a very
# strong -ant -> verb analysis when the verb is dramatically more frequent.
# This recovers true participles such as fumant -> fumer without reviving the
# old courant -> courir / important -> importer class of bugs.
# ---------------------------------------------------------------------------
p = Path('js/reader/fr-lexical-pipeline-v2.js')
s = p.read_text(encoding='utf-8')
s = replace_once(
    s,
    "  // A standalone ranked headword is ambiguous by definition; do not invent a verb lemma.\n  if (data.rankFold.get(word)) return '';",
    "  // A standalone ranked headword is normally preserved.  Present participles\n  // are the exception only when Wordhoard also contains a dramatically more\n  // frequent productive verb candidate (fumant -> fumer).\n  const surfaceHit = data.rankFold.get(word);",
    'productive surface guard',
)
s = replace_once(
    s,
    "  ranked.sort((a, b) => a.index - b.index);\n  return ranked[0]?.lemma || '';",
    "  ranked.sort((a, b) => a.index - b.index);\n  const best = ranked[0] || null;\n  if (!best) return '';\n  if (Number.isInteger(surfaceHit?.index)) {\n    if (!word.endsWith('ant')) return '';\n    const strongThreshold = Math.max(1200, Math.floor(surfaceHit.index * 0.35));\n    if (best.index >= strongThreshold) return '';\n  }\n  return best.lemma || '';",
    'strong participle threshold',
)
# One high-frequency WikDict head is demonstrably corrupt in the generated
# first-sense column (mec -> матрикс).  Keep this as data, not branching logic.
s = replace_once(
    s,
    "const properLemmas = new Set();",
    "const properLemmas = new Set();\nconst SAFE_RU_OVERRIDES = new Map([['mec', 'парень']]);",
    'safe lexical override table',
)
s = replace_once(
    s,
    "    override?.ru ||\n    dict?.[lemma] ||",
    "    override?.ru ||\n    SAFE_RU_OVERRIDES.get(normalized) || SAFE_RU_OVERRIDES.get(lemma) ||\n    dict?.[lemma] ||",
    'safe lexical override use',
)
# The toc122 heuristic inspected data-word first; Reader stores a normalized
# value there, so every visible capital looked lowercase.  Use rendered text and
# a DOM Range to determine whether the occurrence is really mid-sentence.
pattern = r"function textBeforeElement\(element, max = 28\) \{.*?\n\}\n\nfunction chapterProperHeuristic\(surface\) \{.*?\n\}\n\nfunction isProper"
replacement = r"""function textBeforeElement(element, max = 80) {
  try {
    const paragraph = element?.closest?.('.reader-paragraph') || document.getElementById('reader-chapter-text');
    if (!paragraph || typeof document?.createRange !== 'function') return '';
    const range = document.createRange();
    range.setStart(paragraph, 0);
    range.setEndBefore(element);
    return String(range.toString() || '').slice(-max);
  } catch { return ''; }
}

function chapterProperHeuristic(surface) {
  const raw = String(surface || '').trim();
  if (!raw || typeof document === 'undefined') return false;
  const normalized = normalize(raw);
  const root = document.getElementById('reader-chapter-text');
  if (!root) return false;
  const matches = Array.from(root.querySelectorAll('.reader-word[data-word]')).filter((el) => normalize(el.dataset.word || el.textContent || '') === normalized);
  if (!matches.length) return false;
  let capitals = 0, lowers = 0, nonInitial = 0;
  for (const el of matches) {
    // data-word is normalized by the Reader; textContent preserves book casing.
    const shown = String(el.textContent || el.dataset.word || '').trim();
    if (startsWithFrenchUpper(shown)) capitals += 1; else lowers += 1;
    const before = textBeforeElement(el).trimEnd();
    const sentenceInitial = !before || /[.!?…][\s\"'»”)]*$/u.test(before);
    if (startsWithFrenchUpper(shown) && !sentenceInitial) nonInitial += 1;
  }
  // Requiring an actual mid-sentence capital avoids classifying ordinary first
  // words (Le, Personne, Il...) as names.  It also handles demonyms used as a
  // person label (Le Catalan) and dictionary homographs such as Épaulard.
  return capitals > 0 && lowers === 0 && nonInitial > 0;
}

function isProper"""
s = re_once(s, pattern, replacement, 'rendered proper-name heuristic', flags=re.S)
p.write_text(s, encoding='utf-8')

# ---------------------------------------------------------------------------
# 2) Inline base gloss: for context-sensitive heads, do not paint a known-wrong
# dictionary sense for a frame and then hope another layer replaces it.  Leave
# the slot empty until the context owner supplies a phrase/collocation result.
# ---------------------------------------------------------------------------
p = Path('js/reader/fr-unknown-gloss.js')
s = p.read_text(encoding='utf-8')
s = replace_once(
    s,
    "let scanTimer=null,rootObserver=null,rootObserved=null,viewObserver=null,viewObserved=null,dictionaryPromise=null,dictionary=null,lookupInFlight=false;",
    "let scanTimer=null,rootObserver=null,rootObserved=null,viewObserver=null,viewObserved=null,dictionaryPromise=null,dictionary=null,lookupInFlight=false;const CONTEXT_FIRST=new Set(['arrêt','courant','composer','former','raccrocher','rapporter','ranger','sentir','mauvais','mec']);",
    'context-first lexical set',
)
s = replace_once(
    s,
    "function bestHint(word,lemma,caches={}){const own=caches.own||{},direct=own[normalizedKey(lemma)]||own[normalizedKey(word)]||null;return compactRussian(typeof direct==='string'?direct:direct?.ru||'');}",
    "function bestHint(word,lemma,caches={}){if(CONTEXT_FIRST.has(normalizeSurface(word))||CONTEXT_FIRST.has(normalizeSurface(lemma)))return'';const own=caches.own||{},direct=own[normalizedKey(lemma)]||own[normalizedKey(word)]||null;return compactRussian(typeof direct==='string'?direct:direct?.ru||'');}",
    'hold ambiguous gloss for context',
)
p.write_text(s, encoding='utf-8')

# ---------------------------------------------------------------------------
# 3) Context owner.  v3's fuzzy search could select any Russian token in the
# translated sentence if it resembled a WikDict sense; this produced the real
# live bug arrêt -> «остались».  Add a deterministic collocation layer and a
# short-phrase translation plan, and never use fuzzy whole-sentence alignment.
# ---------------------------------------------------------------------------
p = Path('js/reader/fr-context-gloss-v3.js')
s = p.read_text(encoding='utf-8')
insert_anchor = "function requestContext(element, model, candidates, contextKey) {"
quality_helpers = r"""const FR_ARTICLES = new Set(['le','la','les','un','une','des','du','l']);

function modelWord(model, offset) {
  return normalize(model?.words?.[(model?.index || 0) + offset] || '');
}
function modelHas(model, values) {
  const wanted = new Set(values.map(normalize));
  return (model?.words || []).some((w) => wanted.has(normalize(w)));
}
function objectIsNumero(model) {
  return [1,2,3].some((off) => modelWord(model, off) === 'numéro');
}

// Small, high-confidence phrase layer.  These are lexical constructions, not
// screenshot coordinates: the same rule applies to every chapter/occurrence.
function deterministicContextGloss(surface, lemma, model) {
  const word = normalize(surface), base = normalize(lemma || word);
  const prev = modelWord(model, -1), next = modelWord(model, 1);
  if (word === 'arrêt' && prev === 'sans') return 'без остановки';
  if (word === 'courant' && prev === 'au') return 'в курсе';
  if ((base === 'composer' || base === 'former') && objectIsNumero(model)) return 'набрать номер';
  if (base === 'raccrocher' && modelHas(model, ['téléphone','appeler','appel','numéro'])) return 'повесить трубку';
  if (word === 'mec') return 'парень';
  if (word === 'mauvais' && (prev === 'sentait' || prev === 'sentir')) return 'плохо';
  if (base === 'sentir' && next === 'mauvais') return 'пахнуть';
  if (base === 'rapporter' && modelHas(model, ['ferme']) && modelHas(model, ['à','au','aux'])) return 'относить';
  if (base === 'ranger' && modelHas(model, ['provisions'])) return 'убирать';
  if (word === 'fumant' && base === 'fumer') return 'куря';
  if (word === 'pièce' && modelHas(model, ['chambre','tabac','puait','sentait'])) return 'комната';
  if ((word === 'foutu' || word === 'foutue') && prev === 'mal') return 'плохо устроенный';
  return '';
}

function translationPlan(model, lemma) {
  const word = normalize(model?.surface || ''), prev = modelWord(model, -1);
  const next = modelWord(model, 1), next2 = modelWord(model, 2);
  if (FR_PREPOSITIONAL.has(prev)) return { text: `${model.words[model.index - 1]} ${model.surface}`, whole: true };
  if (FR_ARTICLES.has(prev)) return { text: `${model.words[model.index - 1]} ${model.surface}`, whole: true };
  if (FR_ARTICLES.has(next) && next2) return { text: `${model.surface} ${model.words[model.index + 1]} ${model.words[model.index + 2]}`, whole: true };
  if (word.endsWith('ant') && normalize(lemma) !== word) return { text: `en ${model.surface}`, whole: true };
  return { text: model.marked, whole: false };
}

"""
s = replace_once(s, insert_anchor, quality_helpers + insert_anchor, 'context quality helpers')
s = replace_once(
    s,
    "function requestContext(element, model, candidates, contextKey) {",
    "function requestContext(element, model, lemma, candidates, contextKey) {",
    'context request signature',
)
s = replace_once(
    s,
    "  const requestId = `frctx3-${Date.now().toString(36)}-${(++requestSeq).toString(36)}`;\n  const item = { element, surface: model.surface, context: model.context, marked: model.marked, prev: model.prev, candidates, contextKey };\n  pending.set(requestId, item); pending.set(contextKey, requestId); activeRequests += 1;\n  try { bridge.translate(requestId, model.marked); return true; }",
    "  const requestId = `frctx3-${Date.now().toString(36)}-${(++requestSeq).toString(36)}`;\n  const plan = translationPlan(model, lemma);\n  const item = { element, surface: model.surface, context: model.context, marked: model.marked, prev: model.prev, candidates, contextKey, whole: !!plan.whole };\n  pending.set(requestId, item); pending.set(contextKey, requestId); activeRequests += 1;\n  try { bridge.translate(requestId, plan.text); return true; }",
    'short phrase request plan',
)
s = replace_once(
    s,
    "      const marked = extractMarkedGloss(translated, item.prev);\n      const fallback = marked || chooseContextToken(item.candidates, translated);\n      if (fallback) {\n        const cache = readCache();\n        cache[item.contextKey] = { ru: fallback, translated: sanitizeRussian(translated, 220), t: Date.now(), provider: marked ? 'mlkit-target-marked' : 'mlkit-target-fallback' };",
    "      const marked = extractMarkedGloss(translated, item.prev);\n      // Never fuzzy-match an arbitrary token from a whole sentence.  Either the\n      // target marker survived or this request intentionally translated a short\n      // phrase whose whole output is the target construction.\n      const fallback = marked || (item.whole ? sanitizeRussian(translated, 52) : '');\n      if (fallback) {\n        const cache = readCache();\n        cache[item.contextKey] = { ru: fallback, translated: sanitizeRussian(translated, 220), t: Date.now(), provider: marked ? 'mlkit-target-marked' : 'mlkit-short-phrase' };",
    'remove fuzzy whole-sentence fallback',
)
# Scan: high-confidence collocations win before cache/model translation.
s = replace_once(
    s,
    "    const contextKey = `${normalize(surface)}|${hashText(normalize(model.context))}`;\n    const cached = sanitizeRussian(cache[contextKey]?.ru || '');",
    "    const contextKey = `${normalize(surface)}|${hashText(normalize(model.context))}`;\n    const deterministic = sanitizeRussian(deterministicContextGloss(surface, lemma, model));\n    if (deterministic) {\n      cache[contextKey] = { ru: deterministic, t: Date.now(), provider: 'local-collocation' }; saveCache(cache);\n      replaceGloss(element, deterministic, 'local-collocation', contextKey);\n      continue;\n    }\n    const cached = sanitizeRussian(cache[contextKey]?.ru || '');",
    'collocation before context cache',
)
s = replace_once(
    s,
    "    requestContext(element, model, candidates, contextKey);",
    "    requestContext(element, model, lemma, candidates, contextKey);",
    'pass lemma to phrase planner',
)
p.write_text(s, encoding='utf-8')

# ---------------------------------------------------------------------------
# 4) Make the live gate enforce the bugs the user actually reported, not just
# the original toc122 assertions.
# ---------------------------------------------------------------------------
p = Path('scripts/audit_nada_toc122_live.py')
s = p.read_text(encoding='utf-8')
s = replace_once(
    s,
    "    if sum(1 for p in providers if p in ['mlkit-target-marked','mlkit-target-fallback','deepseek-context']) >= 6:",
    "    if sum(1 for p in providers if p in ['mlkit-target-marked','mlkit-short-phrase','local-collocation','deepseek-context']) >= 6:",
    'live provider wait list',
)
s = replace_once(
    s,
    "for word in ['arrêt','composer','former','raccrocha','mec','courant','rapportait','mauvais']:",
    "for word in ['arrêt','composer','former','raccrocha','mec','courant','rapportait','mauvais','rangeait','sentait']:",
    'expanded live unknown targets',
)
s = replace_once(
    s,
    "const ws=['arrêt','composer','former','raccrocha','mec','courant','rapportait','mauvais'];",
    "const ws=['arrêt','composer','former','raccrocha','mec','courant','rapportait','mauvais','rangeait','sentait'];",
    'expanded live context capture',
)
old_checks = """    'former': (lambda g: 'образовать' not in g.lower(), 'former le numéro still uses generic «образовать»'),
}"""
new_checks = """    'former': (lambda g: ('наб' in g.lower()) and ('образовать' not in g.lower()), 'former le numéro still uses generic «образовать»'),
    'raccrocha': (lambda g: ('труб' in g.lower()) and ('вешать' not in g.lower()), 'raccrocher still uses generic hanging sense'),
    'rapportait': (lambda g: 'рапорт' not in g.lower(), 'rapporter still uses military/report sense in farm context'),
    'mauvais': (lambda g: 'плохо' in g.lower(), 'sentir mauvais still uses adjective dictionary sense'),
    'rangeait': (lambda g: 'привести в порядок' not in g.lower(), 'ranger les provisions still uses generic dictionary phrase'),
    'sentait': (lambda g: ('пах' in g.lower()) and ('нюх' not in g.lower()), 'sentir mauvais still uses sniff sense'),
}"""
s = replace_once(s, old_checks, new_checks, 'stronger semantic live checks')
s = replace_once(
    s,
    "for word, expected in {'courant':'courant','personne':'personne'}.items():\n    if (lex.get(word) or {}).get('lemma') != expected:\n        audit['bugs'].append(f'lexical owner corrupted standalone {word}: {(lex.get(word) or {}).get(\"lemma\")}')",
    "for word, expected in {'courant':'courant','personne':'personne'}.items():\n    if (lex.get(word) or {}).get('lemma') != expected:\n        audit['bugs'].append(f'lexical owner corrupted standalone {word}: {(lex.get(word) or {}).get(\"lemma\")}')\nif (lex.get('fumant') or {}).get('lemma') != 'fumer' or (lex.get('fumant') or {}).get('pos') != 'verb':\n    audit['bugs'].append(f'fumant context morphology not recovered: {lex.get(\"fumant\")}')\nif 'матрикс' in str((lex.get('mec') or {}).get('ru') or '').lower():\n    audit['bugs'].append('mec lexical card still exposes «матрикс»')",
    'live lexical quality checks',
)
p.write_text(s, encoding='utf-8')

print('toc122f French live quality patch applied')
