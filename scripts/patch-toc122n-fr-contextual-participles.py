#!/usr/bin/env python3
from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, got {count}')
    return text.replace(old, new, 1)


# ---------------------------------------------------------------------------
# 1) Keep the global lexical owner conservative, but expose a separate exact-
# context analysis.  This is deliberately NOT written back to the global lemma
# cache: fumant may be a genuine adjective elsewhere, while this exact usage can
# still be the present participle of fumer.
# ---------------------------------------------------------------------------
p = Path('js/reader/fr-lexical-pipeline-v2.js')
s = p.read_text(encoding='utf-8')
anchor = "function cachedOverride(surface, lemma) {"
helpers = r"""function contextParticipleLemma(surface, data) {
  const word = normalize(surface);
  if (!word || !word.endsWith('ant') || word.length <= 5 || !data?.rankFold?.get) return '';
  const stem = word.slice(0, -3);
  const ranked = [];
  for (const candidate of [stem + 'er', stem + 'ir', stem + 're']) {
    const hit = data.rankFold.get(normalize(candidate));
    if (Number.isInteger(hit?.index)) ranked.push({ lemma: hit.word || candidate, index: hit.index });
  }
  ranked.sort((a, b) => a.index - b.index);
  const best = ranked[0] || null;
  const surfaceHit = data.rankFold.get(word);
  if (!best || !Number.isInteger(surfaceHit?.index)) return '';
  // Context is the primary signal. Frequency is only a safety rail against
  // accidentally deriving a rare verb from a common lexical adjective/noun.
  const ceiling = Math.max(2200, Math.floor(surfaceHit.index * 0.65));
  return best.index < ceiling ? (best.lemma || '') : '';
}

function contextSuggestsParticiple(surface, context) {
  const word = normalize(surface);
  if (!word || !word.endsWith('ant')) return false;
  const source = normalize(context);
  if (!source) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // High-confidence written-French frames: a detached participial clause
  // (", fumant ...") or a gerund introduced by en.  We intentionally do not
  // treat every -ant token as verbal: "un plat fumant" stays adjectival.
  const pattern = new RegExp(`(?:^|[,;:]\\s*|\\ben\\s+)${escaped}(?=\\s|[,;:.!?]|$)`, 'iu');
  return pattern.test(source);
}

async function analyzeContext(surface, context = '') {
  if (currentLang() && currentLang() !== 'fr') return null;
  const normalized = normalize(surface);
  if (!normalized) return null;
  const base = await analyze(surface);
  if (!contextSuggestsParticiple(normalized, context)) return base;
  const data = await vocabularyData();
  const contextualLemma = contextParticipleLemma(normalized, data);
  if (!contextualLemma || contextualLemma === normalized) return base;
  const ranked = entryForLemma(data, contextualLemma);
  let dict = null;
  try { dict = await loadDictionary(); } catch {}
  const ru = sanitizeRussian(dict?.[contextualLemma] || base?.ru || '');
  return {
    ...(base || {}),
    pos: 'verb',
    lemma: contextualLemma,
    infinitive: contextualLemma,
    fr: contextualLemma,
    ru,
    meaning: ru,
    level: ranked?.cefr || base?.level || 'A2',
    rank: ranked?.rank || base?.rank || null,
    _source: 'fr-context-morphology',
    _note: `в этом контексте: ${normalized} → ${contextualLemma}`,
    context_pos: 'verb',
    usage_pos: 'verb',
    isProper: false,
  };
}

"""
s = replace_once(s, anchor, helpers + anchor, 'contextual morphology helpers')
s = replace_once(
    s,
    "  globalThis.readerFrenchLexicalAnalysisFor = analyze;\n",
    "  globalThis.readerFrenchLexicalAnalysisFor = analyze;\n  globalThis.readerFrenchContextualAnalysisFor = analyzeContext;\n",
    'contextual lexical global',
)
s = replace_once(
    s,
    "export { normalize, sanitizeRussian, mapPos, analyze, rememberAnalysis, lemmaFor, productiveLemma };",
    "export { normalize, sanitizeRussian, mapPos, analyze, analyzeContext, rememberAnalysis, lemmaFor, productiveLemma };",
    'contextual lexical export',
)
p.write_text(s, encoding='utf-8')


# ---------------------------------------------------------------------------
# 2) The word popup owns an exact sentence context already.  Ask the contextual
# French layer before painting the local card.  DeepSeek may still refine it,
# but guest/offline mode now gets the correct grammatical owner immediately.
# ---------------------------------------------------------------------------
p = Path('js/reader-app.js')
s = p.read_text(encoding='utf-8')
old = """    const found = await readerLookupWord(lookupWord);
    if (!lookupStillActive()) return;
    if (found) {
"""
new = """    let found = await readerLookupWord(lookupWord);
    if (activeLang === 'fr' && typeof globalThis.readerFrenchContextualAnalysisFor === 'function') {
      try {
        const contextual = await globalThis.readerFrenchContextualAnalysisFor(lookupWord, sentContext);
        if (contextual) found = contextual;
      } catch (error) {
        console.warn('[fr context morphology] popup fallback', error?.message || error);
      }
    }
    if (!lookupStillActive()) return;
    if (found) {
"""
s = replace_once(s, old, new, 'popup contextual French analysis')
p.write_text(s, encoding='utf-8')


# ---------------------------------------------------------------------------
# 3) Inline context glosses use the same exact-context lexical analysis.  Build
# source text from a cloned paragraph with gloss nodes removed so previously
# inserted Russian hints can never become morphology input.
# ---------------------------------------------------------------------------
p = Path('js/reader/fr-context-gloss-v3.js')
s = p.read_text(encoding='utf-8')
anchor = "function objectIsNumero(model) {"
helper = r"""function sourceContextForElement(element, fallback = '') {
  const paragraph = element?.closest?.('.reader-paragraph');
  if (!paragraph) return String(fallback || '');
  try {
    const clone = paragraph.cloneNode(true);
    clone.querySelectorAll?.('.rw-fr-gloss-text').forEach((node) => node.remove());
    return String(clone.textContent || fallback || '').replace(/\s+/g, ' ').trim();
  } catch { return String(fallback || ''); }
}

"""
s = replace_once(s, anchor, helper + anchor, 'clean source context helper')
old = """    const lemma = lemmaFor(surface);
    const model = contextModel(element);
    const contextKey = `${normalize(surface)}|${hashText(normalize(model.context))}`;
"""
new = """    let lemma = lemmaFor(surface);
    const model = contextModel(element);
    if (typeof globalThis.readerFrenchContextualAnalysisFor === 'function') {
      try {
        const contextual = await globalThis.readerFrenchContextualAnalysisFor(surface, sourceContextForElement(element, model.context));
        if (contextual?.lemma) lemma = normalize(contextual.lemma);
      } catch {}
    }
    const contextKey = `${normalize(surface)}|${hashText(normalize(model.context))}`;
"""
s = replace_once(s, old, new, 'inline contextual lemma')
p.write_text(s, encoding='utf-8')


# ---------------------------------------------------------------------------
# 4) Fix the live gate itself.  Global fumant MUST remain fumant; the exact
# sentence must resolve to fumer.  Also require the visible inline gloss "куря".
# ---------------------------------------------------------------------------
p = Path('scripts/audit_nada_toc122_live.py')
s = p.read_text(encoding='utf-8')
old = """if (lex.get('fumant') or {}).get('lemma') != 'fumer' or (lex.get('fumant') or {}).get('pos') != 'verb':
    audit['bugs'].append(f'fumant context morphology not recovered: {lex.get(\"fumant\")}')
if 'матрикс' in str((lex.get('mec') or {}).get('ru') or '').lower():
"""
new = """if (lex.get('fumant') or {}).get('lemma') != 'fumant':
    audit['bugs'].append(f'global fumant lexical owner changed unexpectedly: {lex.get(\"fumant\")}')
audit['contextual_fumant'] = ev(\"(async()=>await window.readerFrenchContextualAnalysisFor?.('fumant', 'Le jeudi, personne ne fit rien de spécial. Treuffais restait dans sa chambre, fumant sans arrêt; la pièce sentait mauvais.')||null)()\")
ctx_fumant = audit.get('contextual_fumant') or {}
if ctx_fumant.get('lemma') != 'fumer' or ctx_fumant.get('pos') != 'verb':
    audit['bugs'].append(f'fumant exact-context morphology not recovered: {ctx_fumant}')
if 'матрикс' in str((lex.get('mec') or {}).get('ru') or '').lower():
"""
s = replace_once(s, old, new, 'live global/context fumant split')
s = replace_once(
    s,
    "const ws=['arrêt','composer','former','raccrocha','mec','courant','rapportait','mauvais','rangeait','sentait'];",
    "const ws=['arrêt','composer','former','raccrocha','mec','courant','rapportait','mauvais','rangeait','sentait','fumant'];",
    'capture fumant context gloss',
)
s = replace_once(
    s,
    "    'sentait': (lambda g: ('пах' in g.lower()) and ('нюх' not in g.lower()), 'sentir mauvais still uses sniff sense'),\n}",
    "    'sentait': (lambda g: ('пах' in g.lower()) and ('нюх' not in g.lower()), 'sentir mauvais still uses sniff sense'),\n    'fumant': (lambda g: 'куря' in g.lower(), 'fumant detached participle did not get contextual «куря»'),\n}",
    'fumant inline semantic gate',
)
p.write_text(s, encoding='utf-8')

print('toc122n French exact-context participle split applied')
