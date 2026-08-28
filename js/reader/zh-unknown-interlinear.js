// Final presentation layer for Chinese Unknown annotations.
//
// toc86 solved clipping by letting the Russian gloss participate in intrinsic
// token width. On a phone that was the wrong trade-off: a long dictionary entry
// could turn one Hanzi into a skyscraper and push the sentence apart.
//
// toc87 keeps the useful part of that change — Hanzi and pinyin are NEVER cut —
// but makes the visible meaning a separate compact lane. The token is sized by
// the Hanzi/pinyin plus a small bounded floor for the gloss; Russian prose can no
// longer dictate page geometry.

const STYLE_ID = 'reader-zh-unknown-interlinear-v2';
const LEGACY_STYLE_ID = 'reader-zh-unknown-interlinear-v1';
const EN_RU_DICT_URL = new URL('../../../wikdict/en_ru_core.json?v=2', import.meta.url).href;

let observer = null;
let observedRoot = null;
let enRuDictionary = null;
let enRuPromise = null;
let enRuFailed = false;
let resyncTimer = null;

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function containsCyrillic(value) {
  return /[\u0400-\u052f]/.test(String(value || ''));
}

function firstTopLevel(value, separators) {
  const text = String(value || '');
  let depth = 0;
  const opening = new Set(['(', '[', '{', '（', '【']);
  const closing = new Set([')', ']', '}', '）', '】']);
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (opening.has(ch)) {
      depth += 1;
      continue;
    }
    if (closing.has(ch)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && separators.has(ch)) return text.slice(0, i);
  }
  return text;
}

function stripParentheticalExamples(value) {
  const source = clean(value);
  if (!source) return '';
  const stripped = source
    .replace(/\s*[（(][^()（）]{1,56}[）)]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || source;
}

function trimAtWordBoundary(value, max = 38) {
  const text = clean(value);
  if (text.length <= max) return text;
  let out = '';
  for (const part of text.split(/\s+/)) {
    const next = out ? `${out} ${part}` : part;
    if (next.length > max) break;
    out = next;
  }
  return out || text.slice(0, max).trim();
}

function compactRussianDisplay(value) {
  let text = clean(value)
    .replace(/\bCL:[^/;]+/gi, '')
    .replace(/^[—–-]\s*/, '')
    .trim();
  if (!text) return '';

  // One visible meaning, not a mini dictionary article. Separators inside
  // parentheses are ignored so "чистить (кожуру, скорлупу)" stays one sense.
  text = firstTopLevel(text, new Set([';', '；', '/', '|', '·', '•', '\n']));
  text = firstTopLevel(text, new Set(['.', '!', '?', '。', '！', '？']));
  text = firstTopLevel(text, new Set([',', '，']));
  text = stripParentheticalExamples(text)
    .replace(/\s*[:：]\s*$/, '')
    .replace(/[;,，；.。]+$/, '')
    .trim();

  return trimAtWordBoundary(text, 38);
}

function compactEnglishDisplay(value) {
  let text = clean(value)
    .replace(/\bCL:[^/;]+/gi, '')
    .replace(/^[—–-]\s*/, '')
    .trim();
  if (!text) return '';
  text = firstTopLevel(text, new Set([';', '；', '/', '|', '·', '•', '\n']));
  text = firstTopLevel(text, new Set([',', '，']));
  text = stripParentheticalExamples(text)
    .replace(/^to\s+be\s+/i, '')
    .replace(/^to\s+/i, '')
    .replace(/^(?:a|an|the)\s+/i, '')
    .replace(/[.;,]+$/, '')
    .trim();
  return trimAtWordBoundary(text, 34);
}

function compactDisplayGloss(value) {
  return containsCyrillic(value)
    ? compactRussianDisplay(value)
    : compactEnglishDisplay(value);
}

function russianLooksLikeArticle(value) {
  const text = clean(value);
  if (!containsCyrillic(text)) return false;
  if (text.length > 48) return true;
  return /(?:также|часто|используется|используют|химическ|элемент|обозначени|сплав|производств|состоящ|представляет собой)/i.test(text);
}

function wordForWrapper(wrap) {
  const word = wrap?.querySelector?.(':scope > .reader-word');
  return word?.classList?.contains('reader-word') ? word : null;
}

function englishFromEntry(entry) {
  const value = entry && typeof entry === 'object' ? entry : {};
  const raw = value.en || value.english || value.definition || value.definitions || value.gloss || '';
  const text = Array.isArray(raw) ? raw.join('; ') : String(raw || '');
  return compactEnglishDisplay(text);
}

function localEnglishForWord(word) {
  const surface = String(word?.dataset?.word || word?.textContent || '').trim();
  if (!surface) return '';
  try {
    const entry = globalThis.readerLookupChineseWord?.(surface) || null;
    const english = englishFromEntry(entry);
    if (english) return english;
  } catch {}
  return '';
}

function normalizeEnglishKey(value) {
  return clean(value)
    .replace(/[’‘]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .toLocaleLowerCase('en-US');
}

function englishCandidates(value) {
  const raw = normalizeEnglishKey(compactEnglishDisplay(value));
  const out = [];
  const push = candidate => {
    const key = normalizeEnglishKey(candidate);
    if (key && !out.includes(key)) out.push(key);
  };
  push(raw);
  push(raw.replace(/^to\s+be\s+/, ''));
  push(raw.replace(/^to\s+/, ''));
  push(raw.replace(/^(?:a|an|the)\s+/, ''));
  if (raw.includes('-')) {
    push(raw.replace(/-/g, ' '));
    push(raw.replace(/-/g, ''));
  }
  return out;
}

function russianFromEnglish(value) {
  if (!enRuDictionary) return '';
  for (const key of englishCandidates(value)) {
    const raw = enRuDictionary[key];
    const translated = compactRussianDisplay(raw);
    if (translated) return translated;
  }
  return '';
}

function scheduleResync(delay = 0) {
  clearTimeout(resyncTimer);
  resyncTimer = setTimeout(syncAll, delay);
}

function ensureEnRuDictionary() {
  if (enRuDictionary || enRuFailed || typeof fetch !== 'function') {
    return Promise.resolve(enRuDictionary);
  }
  if (enRuPromise) return enRuPromise;
  enRuPromise = fetch(EN_RU_DICT_URL, { cache: 'force-cache' })
    .then(response => {
      if (!response.ok) throw new Error(`EN→RU dictionary HTTP ${response.status}`);
      return response.json();
    })
    .then(data => {
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid EN→RU dictionary');
      enRuDictionary = data;
      scheduleResync(0);
      return data;
    })
    .catch(error => {
      enRuFailed = true;
      console.warn('[zh interlinear] compact EN→RU fallback unavailable:', error?.message || error);
      return null;
    })
    .finally(() => { enRuPromise = null; });
  return enRuPromise;
}

function glossFloor(display) {
  const length = Array.from(clean(display)).length;
  if (!length) return '0em';
  // Russian text is ~0.46em high, so 0.22em per character is enough to keep
  // short glosses from colliding. The cap prevents the toc86 giant-column bug.
  const em = Math.min(3.25, Math.max(1.05, length * 0.22));
  return `${em.toFixed(2)}em`;
}

function syncWrapper(wrap) {
  if (!wrap?.classList?.contains('rw-zh-gloss-wrap')) return;
  const word = wordForWrapper(wrap);
  if (!word) return;

  const source = clean(
    wrap.dataset.zhGlossStickyRu
    || wrap.dataset.zhGlossRuReadable
    || wrap.dataset.zhGlossRu,
  );

  let display = '';
  let english = '';

  if (containsCyrillic(source)) {
    display = compactRussianDisplay(source);
    if (russianLooksLikeArticle(source)) {
      english = localEnglishForWord(word);
      const translated = russianFromEnglish(english);
      if (translated) display = translated;
      else if (english) void ensureEnRuDictionary();
    }
  } else {
    english = compactEnglishDisplay(source) || localEnglishForWord(word);
    const translated = russianFromEnglish(english);
    display = translated || english;
    if (english && !translated) void ensureEnRuDictionary();
  }

  if (!display && source) display = compactDisplayGloss(source);
  if (wrap.dataset.zhGlossDisplayRu !== display) wrap.dataset.zhGlossDisplayRu = display;
  wrap.style.setProperty('--rw-zh-gloss-floor', glossFloor(display));
}

function syncNode(node) {
  if (!(node instanceof Element)) return;
  if (node.classList.contains('rw-zh-gloss-wrap')) syncWrapper(node);
  if (node.classList.contains('reader-word')) {
    const wrap = node.parentElement?.classList?.contains('rw-zh-gloss-wrap') ? node.parentElement : null;
    if (wrap) syncWrapper(wrap);
  }
  node.querySelectorAll?.('.rw-zh-gloss-wrap').forEach(syncWrapper);
}

function syncAll() {
  if (typeof document === 'undefined') return 0;
  const root = document.getElementById('reader-chapter-text');
  if (!root) return 0;
  const wrappers = root.querySelectorAll('.rw-zh-gloss-wrap');
  wrappers.forEach(syncWrapper);
  return wrappers.length;
}

function injectInterlinearStyle() {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  document.getElementById(LEGACY_STYLE_ID)?.remove();
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"] .reader-paragraph-text {
      line-height:2.24 !important;
    }

    /* Hanzi + pinyin own intrinsic width. The Russian line does not. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .rw-zh-gloss-wrap[data-zh-gloss-visible="1"]:has(> .reader-word.rw-migaku-unknown) {
      display:inline-grid !important;
      grid-template-rows:.58em 1.08em .58em !important;
      grid-template-columns:max-content !important;
      align-items:center !important;
      justify-items:center !important;
      vertical-align:-.48em !important;
      line-height:1 !important;
      margin:0 .09em !important;
      padding:0 .025em !important;
      position:relative !important;
      overflow:visible !important;
      width:auto !important;
      min-width:var(--rw-zh-gloss-floor, 0em) !important;
      max-width:none !important;
      height:auto !important;
      box-sizing:border-box !important;
      break-inside:avoid !important;
    }

    /* The Chinese lexical unit itself is never broken or ellipsized. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .rw-zh-gloss-wrap[data-zh-gloss-visible="1"]:has(> .reader-word.rw-migaku-unknown) > .reader-word {
      grid-row:2 !important;
      grid-column:1 !important;
      align-self:center !important;
      justify-self:center !important;
      display:inline !important;
      position:static !important;
      margin:0 !important;
      padding:0 1px !important;
      line-height:1.08 !important;
      white-space:nowrap !important;
      word-break:keep-all !important;
      overflow-wrap:normal !important;
      overflow:visible !important;
      text-overflow:clip !important;
    }

    /* Pinyin participates in width and therefore always stays complete. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .rw-zh-gloss-wrap[data-zh-gloss-visible="1"]:has(> .reader-word.rw-migaku-unknown)::before {
      display:block !important;
      position:static !important;
      grid-row:1 !important;
      grid-column:1 !important;
      align-self:center !important;
      justify-self:center !important;
      content:attr(data-zh-gloss-sticky-pinyin) !important;
      width:max-content !important;
      min-width:0 !important;
      max-width:none !important;
      height:auto !important;
      margin:0 !important;
      padding:0 .04em !important;
      box-sizing:border-box !important;
      overflow:visible !important;
      text-overflow:clip !important;
      white-space:nowrap !important;
      overflow-wrap:normal !important;
      text-align:center !important;
      pointer-events:none !important;
      font-family:'IBM Plex Sans',system-ui,sans-serif !important;
      font-size:.50em !important;
      font-weight:500 !important;
      line-height:1 !important;
      transition:none !important;
    }

    /* The visible meaning is one compact sense. It is painted in the reserved
       third row, absolutely, so even a bad source string cannot widen a token. */
    #reader-reading-view.rd-zh-unknown-gloss[data-reader-lang="zh"]
    .rw-zh-gloss-wrap[data-zh-gloss-visible="1"]:has(> .reader-word.rw-migaku-unknown)::after {
      display:block !important;
      position:absolute !important;
      left:50% !important;
      bottom:.015em !important;
      transform:translateX(-50%) !important;
      content:attr(data-zh-gloss-display-ru) !important;
      width:max-content !important;
      min-width:0 !important;
      max-width:none !important;
      height:auto !important;
      margin:0 !important;
      padding:0 .03em !important;
      box-sizing:border-box !important;
      overflow:visible !important;
      text-overflow:clip !important;
      white-space:nowrap !important;
      overflow-wrap:normal !important;
      word-break:keep-all !important;
      text-align:center !important;
      pointer-events:none !important;
      font-family:'IBM Plex Sans',system-ui,sans-serif !important;
      font-size:.46em !important;
      font-weight:400 !important;
      line-height:1 !important;
      opacity:.96 !important;
      transition:none !important;
    }

    /* The top 拼 control stays authoritative. Removing pinyin also removes its
       reserved row; Hanzi and the compact meaning remain untouched. */
    #reader-reading-view.rd-zh-unknown-gloss.rd-zh-gloss-pinyin-off[data-reader-lang="zh"]
    .rw-zh-gloss-wrap[data-zh-gloss-visible="1"]:has(> .reader-word.rw-migaku-unknown) {
      grid-template-rows:1.08em .58em !important;
      vertical-align:-.30em !important;
    }
    #reader-reading-view.rd-zh-unknown-gloss.rd-zh-gloss-pinyin-off[data-reader-lang="zh"]
    .rw-zh-gloss-wrap[data-zh-gloss-visible="1"]:has(> .reader-word.rw-migaku-unknown) > .reader-word {
      grid-row:1 !important;
    }
  `;
  document.head.appendChild(style);
}

function installObserver() {
  if (typeof MutationObserver === 'undefined' || typeof Element === 'undefined') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) {
    setTimeout(installObserver, 200);
    return;
  }
  if (observer && observedRoot === root) return;
  observer?.disconnect();
  observedRoot = root;
  observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.addedNodes || []) syncNode(node);
        continue;
      }
      const target = record.target;
      if (!(target instanceof Element)) continue;
      if (target.classList.contains('rw-zh-gloss-wrap')) syncWrapper(target);
      else if (target.classList.contains('reader-word')) {
        const wrap = target.parentElement?.classList?.contains('rw-zh-gloss-wrap') ? target.parentElement : null;
        if (wrap) syncWrapper(wrap);
      }
    }
  });
  observer.observe(root, {
    childList:true,
    subtree:true,
    attributes:true,
    attributeFilter:[
      'class',
      'data-zh-gloss-ru',
      'data-zh-gloss-ru-readable',
      'data-zh-gloss-sticky-ru',
      'data-zh-gloss-visible',
    ],
  });
  syncAll();
}

function install() {
  injectInterlinearStyle();
  installObserver();
  syncAll();
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once:true });
  else install();
  window.addEventListener('pageshow', install);
  window.addEventListener('reader:zh-core-ready', () => scheduleResync(0));
  window.readerSyncZhCompactInterlinear = syncAll;
}

export {
  injectInterlinearStyle,
  compactDisplayGloss,
  compactRussianDisplay,
  compactEnglishDisplay,
  syncAll,
};
