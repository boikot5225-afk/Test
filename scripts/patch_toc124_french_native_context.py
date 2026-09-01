#!/usr/bin/env python3
from pathlib import Path


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding='utf-8')
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label} anchor count={count}')
    path.write_text(text.replace(old, new, 1), encoding='utf-8')


# Native offline FR->RU context bridge.
p = Path('android/app/src/main/java/space/saintjust/reader/stage1/MainActivity.java')
s = p.read_text(encoding='utf-8')

field = '    private FrenchContextTranslateBridge frenchContextTranslateBridge;\n'
if field not in s:
    anchor = '    private EnglishContextTranslateBridge englishContextTranslateBridge;\n'
    if s.count(anchor) != 1:
        raise SystemExit(f'French native field anchor count={s.count(anchor)}')
    s = s.replace(anchor, anchor + field, 1)

wire = '''        frenchContextTranslateBridge = new FrenchContextTranslateBridge(this, webView);\n        webView.addJavascriptInterface(frenchContextTranslateBridge, "ReaderFrenchContextTranslate");\n'''
if wire not in s:
    anchor = '''        englishContextTranslateBridge = new EnglishContextTranslateBridge(this, webView);\n        webView.addJavascriptInterface(englishContextTranslateBridge, "ReaderEnglishContextTranslate");\n'''
    if s.count(anchor) != 1:
        raise SystemExit(f'French native wire anchor count={s.count(anchor)}')
    s = s.replace(anchor, anchor + wire, 1)

shutdown = '''        if (frenchContextTranslateBridge != null) {\n            frenchContextTranslateBridge.shutdown();\n            frenchContextTranslateBridge = null;\n        }\n'''
if shutdown not in s:
    anchor = '''        if (englishContextTranslateBridge != null) {\n            englishContextTranslateBridge.shutdown();\n            englishContextTranslateBridge = null;\n        }\n'''
    if s.count(anchor) != 1:
        raise SystemExit(f'French native shutdown anchor count={s.count(anchor)}')
    s = s.replace(anchor, anchor + shutdown, 1)

p.write_text(s, encoding='utf-8')

# French lexical close-out: conservative irregular morphology + detached
# participles that have a valid infinitive even when the surface form itself is
# absent from the frequency list. This feeds both Known/Unknown and inline gloss
# through readerFrenchLexicalOverrideLemmaFor / readerFrenchContextualAnalysisFor.
lex = Path('js/reader/fr-lexical-pipeline-v2.js')
replace_once(
    lex,
    "const SAFE_RU_OVERRIDES = new Map([['mec', 'парень']]);\n",
    "const SAFE_RU_OVERRIDES = new Map([['mec', 'парень']]);\n"
    "const CONSERVATIVE_IRREGULAR_LEMMAS = new Map([\n"
    "  ['dit', 'dire'],\n"
    "]);\n",
    'French irregular lemma map',
)
replace_once(
    lex,
    "  if (!best || !Number.isInteger(surfaceHit?.index)) return '';\n"
    "  // Context is the primary signal. Frequency is only a safety rail against\n"
    "  // accidentally deriving a rare verb from a common lexical adjective/noun.\n"
    "  const ceiling = Math.max(2200, Math.floor(surfaceHit.index * 0.65));\n"
    "  return best.index < ceiling ? (best.lemma || '') : '';\n",
    "  if (!best) return '';\n"
    "  // contextSuggestsParticiple already proved a high-confidence detached\n"
    "  // participial/gerund frame (for example ', fumant' or 'en courant').\n"
    "  // Do not let the globally ranked adjective/headword identity suppress\n"
    "  // the contextual verb lemma here; ordinary 'un plat fumant' never enters\n"
    "  // this function through the context gate.\n"
    "  return best.lemma || '';\n",
    'French detached participle fallback',
)
replace_once(
    lex,
    "function overrideLemma(surface) {\n"
    "  const normalized = normalize(surface);\n"
    "  const direct = deepSeekOverrides.get(normalized);\n"
    "  return direct?.lemma || '';\n"
    "}\n",
    "function overrideLemma(surface) {\n"
    "  const normalized = normalize(surface);\n"
    "  const direct = deepSeekOverrides.get(normalized);\n"
    "  if (direct?.lemma) return direct.lemma;\n"
    "  return CONSERVATIVE_IRREGULAR_LEMMAS.get(normalized) || '';\n"
    "}\n",
    'French irregular override export',
)

# Primary first paint must reject unknown capitalized names before creating an
# empty gloss slot. Mid-sentence capitals keep the existing heuristic; at a
# sentence start we only suppress a token when it has no local Russian lexical
# evidence and no morphology to another lemma.
reader = Path('js/reader/fr-reader-pipeline-v2.js')
replace_once(
    reader,
    "function paragraphContext(paragraph) {\n"
    "  return Array.from(paragraph.querySelectorAll('.reader-word[data-word]'))\n"
    "    .map(wordSurface).filter(Boolean).join(' ');\n"
    "}\n",
    "function paragraphContext(paragraph) {\n"
    "  return Array.from(paragraph.querySelectorAll('.reader-word[data-word]'))\n"
    "    .map(wordSurface).filter(Boolean).join(' ');\n"
    "}\n\n"
    "function sourceParagraphContext(paragraph) {\n"
    "  if (!paragraph) return '';\n"
    "  try {\n"
    "    const clone = paragraph.cloneNode(true);\n"
    "    clone.querySelectorAll('.rw-fr-v2-gloss').forEach(node => node.remove());\n"
    "    const text = String(clone.textContent || '').replace(/\\s+/g, ' ').trim();\n"
    "    if (text) return text;\n"
    "  } catch {}\n"
    "  return paragraphContext(paragraph);\n"
    "}\n\n"
    "function contextualLemmaFromCore(surface, context, core) {\n"
    "  const word = normalize(surface);\n"
    "  if (!word || !word.endsWith('ant') || word.length <= 5) return '';\n"
    "  const source = normalize(context);\n"
    "  if (!source) return '';\n"
    "  const escaped = word.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');\n"
    "  const strong = new RegExp(`(?:^|[,;:]\\\\s*|\\\\ben\\\\s+)${escaped}(?=\\\\s|[,;:.!?]|$)`, 'iu');\n"
    "  if (!strong.test(source)) return '';\n"
    "  const stem = word.slice(0, -3);\n"
    "  for (const candidate of [stem + 'er', stem + 'ir', stem + 're']) {\n"
    "    if (compactRussian(core?.[candidate] || '')) return candidate;\n"
    "  }\n"
    "  return '';\n"
    "}\n",
    'French first-paint participle helpers',
)
replace_once(
    reader,
    "function isLikelyProper(el) {\n"
    "  const shown = String(el?.textContent || el?.dataset?.word || '').trim();\n"
    "  if (!/^[A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ]/u.test(shown)) return false;\n"
    "  const paragraph = el.closest?.('.reader-paragraph');\n"
    "  if (!paragraph) return false;\n"
    "  const words = Array.from(paragraph.querySelectorAll('.reader-word[data-word]'));\n"
    "  const index = words.indexOf(el);\n"
    "  if (index <= 0) return false;\n"
    "  const previous = String(words[index - 1]?.textContent || '').trim();\n"
    "  return !/[.!?…]$/u.test(previous);\n"
    "}\n",
    "function isLikelyProper(el, core) {\n"
    "  const shown = String(el?.textContent || el?.dataset?.word || '').trim();\n"
    "  if (!/^[A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ]/u.test(shown)) return false;\n"
    "  const paragraph = el.closest?.('.reader-paragraph');\n"
    "  if (!paragraph) return false;\n"
    "  const words = Array.from(paragraph.querySelectorAll('.reader-word[data-word]'));\n"
    "  const index = words.indexOf(el);\n"
    "  if (index > 0) {\n"
    "    const previous = String(words[index - 1]?.textContent || '').trim();\n"
    "    if (!/[.!?…]$/u.test(previous)) return true;\n"
    "  }\n"
    "  const raw = normalize(wordSurface(el));\n"
    "  const lemma = lemmaFor(raw);\n"
    "  if (!raw || raw.length < 4 || lemma !== raw) return false;\n"
    "  const lexical = compactRussian(core?.[raw] || core?.[lemma] || '');\n"
    "  return !lexical;\n"
    "}\n",
    'French proper-name first paint',
)
replace_once(
    reader,
    "    const context = paragraphContext(paragraph);\n"
    "    const overrides = phraseOverrides(paragraph);\n",
    "    const context = paragraphContext(paragraph);\n"
    "    const sourceContext = sourceParagraphContext(paragraph);\n"
    "    const overrides = phraseOverrides(paragraph);\n",
    'French source context first paint',
)
replace_once(
    reader,
    "      if (isLikelyProper(el)) {\n",
    "      if (isLikelyProper(el, data.core)) {\n",
    'French proper-name call',
)
replace_once(
    reader,
    "      const lemma = normalize(contextual?.lemma || lemmaFor(surface));\n"
    "      const immediate = directTranslation(surface, lemma, data.core);\n",
    "      const contextLemma = contextualLemmaFromCore(surface, sourceContext, data.core);\n"
    "      const lemma = normalize(contextual?.lemma || contextLemma || lemmaFor(surface));\n"
    "      const immediate = directTranslation(surface, lemma, data.core);\n",
    'French context lemma first paint',
)

print('toc124 native French context bridge + final lexical gaps wired')
