// toc102 — contextual EN -> RU sense refinement for already-rendered Unknown glosses.
//
// This module owns NO Reader layout. The existing English gloss layer paints an
// immediate dictionary translation first. We only replace the text of that
// existing gloss when either (1) a high-confidence collocation rule matches or
// (2) ML Kit translates a short local context and exactly one bundled WikDict
// sense has a clear Russian lexical match. Otherwise the old gloss stays.

const SENSES_URL = new URL('../../../wikdict/en_ru_senses.json?v=1', import.meta.url).href;
const CACHE_BASE_KEY = 'an2_reader_en_context_gloss_v1';
const MAX_CACHE = 2400;
const MAX_ACTIVE = 5;
const CONTEXT_RADIUS = 8;

let senses = null;
let sensesPromise = null;
let timer = null;
let observer = null;
let observedRoot = null;
let requestSeq = 0;
let activeRequests = 0;

const pending = new Map();
const failedKeys = new Set();

function scopedKey(base) {
  try { return globalThis.an2ReaderStorageKey?.(base) || base; }
  catch { return base; }
}

function normalize(value) {
  return String(value || '')
    .replace(/[’‘]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .trim()
    .toLocaleLowerCase('en-US');
}

function normalizeRu(value) {
  return String(value || '')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[^а-я\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function currentLang() {
  const raw = String(
    document.getElementById('reader-reading-view')?.dataset?.readerLang
    || document.getElementById('reader-chapter-text')?.dataset?.lang
    || '',
  ).trim().toLowerCase();
  return raw === 'english' || raw === 'en' || raw.startsWith('en-') ? 'en' : raw;
}

function hashText(text) {
  const value = String(text || '');
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function readCache() {
  try {
    const value = JSON.parse(localStorage.getItem(scopedKey(CACHE_BASE_KEY)) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function saveCache(cache) {
  try {
    let entries = Object.entries(cache || {});
    if (entries.length > MAX_CACHE) {
      entries.sort((a, b) => Number(b[1]?.t || 0) - Number(a[1]?.t || 0));
      entries = entries.slice(0, MAX_CACHE);
    }
    localStorage.setItem(scopedKey(CACHE_BASE_KEY), JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

function compactRussian(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!/[\u0400-\u052f]/.test(text)) return '';
  if (text.length <= 32) return text;
  let out = '';
  for (const word of text.split(/\s+/)) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > 32) break;
    out = next;
  }
  return out || text.slice(0, 32).trim();
}

async function loadSenses() {
  if (senses) return senses;
  if (sensesPromise) return sensesPromise;
  sensesPromise = fetch(SENSES_URL, { cache:'force-cache' })
    .then(response => {
      if (!response.ok) throw new Error(`EN sense dictionary HTTP ${response.status}`);
      return response.json();
    })
    .then(data => {
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid EN sense dictionary');
      senses = data;
      return data;
    })
    .finally(() => { sensesPromise = null; });
  return sensesPromise;
}

function wordSurface(el) {
  return String(el?.dataset?.word || el?.textContent || '').trim();
}

function lemmaFor(surface) {
  try { return normalize(globalThis.readerEnglishLemmaFor?.(surface) || surface); }
  catch { return normalize(surface); }
}

function contextWords(el, radius = CONTEXT_RADIUS) {
  const paragraph = el?.closest?.('.reader-paragraph');
  if (!paragraph) return normalize(wordSurface(el));
  const words = Array.from(paragraph.querySelectorAll('.reader-word[data-word]'));
  const index = words.indexOf(el);
  if (index < 0) return normalize(wordSurface(el));
  const start = Math.max(0, index - radius);
  const end = Math.min(words.length, index + radius + 1);
  return words.slice(start, end)
    .map(word => String(word.dataset.word || word.textContent || '').trim())
    .filter(Boolean)
    .join(' ');
}

function directContextGloss(surfaceValue, contextValue) {
  const word = normalize(surfaceValue);
  const context = ` ${normalize(contextValue).replace(/[^a-z'-]+/g, ' ')} `;

  if (word === 'right' || word === 'rights') {
    if (/\bright now\b/.test(context)) return 'сейчас';
    if (/\bright away\b/.test(context)) return 'сразу';
    if (/\ball right\b/.test(context)) return 'ладно';
    if (/\bright (here|there)\b/.test(context)) return 'прямо';
    if (/\b(human|civil|legal|equal|property|voting|worker|workers|women|children) rights?\b|\bright to\b|\brights? of\b/.test(context)) return word === 'rights' ? 'права' : 'право';
    if (/\bright (side|hand|wing|eye|leg|corner)\b|\bon the right\b|\bto the right\b/.test(context)) return 'правый';
    if (/\bright (answer|choice|decision|word|number|person|way|thing)\b/.test(context)) return 'правильный';
  }

  if (/^charg(e|es|ed|ing)$/.test(word) || word === 'charge') {
    if (/\bfree of charge\b/.test(context)) return 'бесплатно';
    if (/\bin charge( of)?\b/.test(context)) return 'отвечать за';
    if (/\b(phone|battery|batteries|charger|device|devices|electric|electricity|power|usb)\b/.test(context)) return 'заряжать';
    if (/\bcharged? with\b|\b(criminal|murder|assault|fraud|police|prosecutor|court)\b/.test(context)) return 'обвинение';
    if (/\b(fee|fees|cost|price|payment|card|account|customer)\b/.test(context)) return 'плата';
    if (/\b(cavalry|attack|rush|battle)\b/.test(context)) return 'атака';
  }

  if (/^mean(s|t|ing)?$/.test(word)) {
    if (/\bmean to\b/.test(context)) return 'намереваться';
    if (/\bmean by\b|\bwhat .* mean\b|\bwhat does .* mean\b|\bmeans? that\b/.test(context)) return 'означать';
    if (/\b(arithmetic|average|mean value|statistical)\b/.test(context)) return 'среднее';
    if (/\b(cruel|nasty|unkind|mean person|mean man|mean woman)\b/.test(context)) return 'злой';
  }

  if (/^match(es|ed|ing)?$/.test(word)) {
    if (/\b(football|soccer|tennis|boxing|team|teams|league|tournament|game|games)\b/.test(context)) return 'матч';
    if (/\b(match|matches|matched|matching) (with|the)\b|\b(color|colors|colour|colours|outfit|pair|fit|fits)\b/.test(context)) return 'соответствовать';
    if (/\b(candle|cigarette|fire|matchbox|box of matches|strike a match|light a match)\b/.test(context)) return 'спичка';
  }

  if (word === 'left') {
    if (/\bleft (side|hand|wing|eye|leg|corner)\b|\bon the left\b|\bto the left\b/.test(context)) return 'левый';
    if (/\b(nothing|anything|something|time|money|days|hours|minutes) left\b/.test(context)) return 'осталось';
  }

  if (word === 'written') {
    if (/\bwritten (agreement|exam|test|language|statement|form|record|word|text|contract|notice)\b/.test(context)) return 'письменный';
  }

  if (word === 'better') {
    if (/\bhad better\b/.test(context)) return 'лучше бы';
    if (/\b(feel|feels|felt|get|gets|got|getting) better\b|\bbetter than\b/.test(context)) return 'лучше';
    if (/\bbetter (option|choice|way|idea|result|solution)\b/.test(context)) return 'лучший';
  }

  if (word === 'bank' || word === 'banks') {
    if (/\b(account|accounts|money|loan|loans|credit|debit|card|cards|deposit|financial|finance)\b/.test(context)) return 'банк';
    if (/\b(river|stream|shore|water|flood)\b/.test(context)) return 'берег';
  }

  if (word === 'date' || word === 'dates') {
    if (/\b(calendar|day|month|year|birthday|deadline|schedule)\b/.test(context)) return 'дата';
    if (/\b(dinner|romantic|boyfriend|girlfriend|dating|asked .* out)\b/.test(context)) return 'свидание';
    if (/\b(palm|fruit|dried fruit)\b/.test(context)) return 'финик';
  }

  if (word === 'fine' || word === 'fines') {
    if (/\b(pay|paid|penalty|ticket|court|parking|speeding)\b/.test(context)) return 'штраф';
    if (/\b(i am fine|i'm fine|feel fine|everything is fine|looks fine|sounds fine)\b/.test(context)) return 'нормально';
  }

  if (word === 'light' || word === 'lights') {
    if (/\b(turn on|turn off|lamp|lamps|dark|darkness|room|bulb|bulbs)\b/.test(context)) return 'свет';
    if (/\b(weight|weighs|heavy|bag|luggage)\b/.test(context)) return 'лёгкий';
    if (/\b(color|colour|shade|hair|skin|blue|green|brown)\b/.test(context)) return 'светлый';
  }

  if (word === 'case' || word === 'cases') {
    if (/\b(court|legal|lawyer|judge|trial|police|criminal|lawsuit)\b/.test(context)) return 'дело';
    if (/\b(phone|protective|suitcase|briefcase|cover)\b/.test(context)) return 'чехол';
    if (/\bin case\b/.test(context)) return 'случай';
  }

  if (word === 'issue' || word === 'issues') {
    if (/\b(magazine|newspaper|journal|latest issue|edition)\b/.test(context)) return 'выпуск';
    if (/\b(problem|problems|concern|concerns|difficulty|bug|bugs)\b/.test(context)) return 'проблема';
  }

  if (word === 'point' || word === 'points') {
    if (/\bpoint of view\b/.test(context)) return 'точка зрения';
    if (/\b(main|whole|important) point\b/.test(context)) return 'суть';
    if (/\b(score|scored|game|games|team|teams)\b/.test(context)) return 'очко';
  }

  if (/^run(s|ning)?$/.test(word) || word === 'ran') {
    if (/\b(company|business|organization|organisation|department|operation)\b/.test(context)) return 'управлять';
    if (/\b(program|app|application|software|code|script|command)\b/.test(context)) return 'запускать';
    if (/\b(election|office|president|mayor|candidate)\b/.test(context)) return 'баллотироваться';
    if (/\b(mile|miles|race|marathon|jog|jogging|fast|runner)\b/.test(context)) return 'бежать';
  }

  if (/^break(s|ing|broke|broken)?$/.test(word) || word === 'broke' || word === 'broken') {
    if (/\b(law|rule|rules|promise|agreement|contract)\b/.test(context)) return 'нарушить';
    if (/\b(glass|window|bone|bones|arm|leg|door|screen)\b/.test(context)) return 'сломать';
    if (/\b(lunch|coffee|short|take a break|rest)\b/.test(context)) return 'перерыв';
  }

  if (word === 'fair') {
    if (/\b(trial|treatment|chance|deal|decision|competition)\b/.test(context)) return 'справедливый';
    if (/\b(hair|skin|complexion)\b/.test(context)) return 'светлый';
    if (/\b(trade|book|job|science|county) fair\b/.test(context)) return 'ярмарка';
  }

  if (word === 'current') {
    if (/\b(electric|electrical|ampere|voltage|circuit|flow)\b/.test(context)) return 'ток';
    if (/\b(current|present) (situation|version|state|policy|price|year)\b/.test(context)) return 'текущий';
  }

  if (word === 'kind' || word === 'kinds') {
    if (/\b(what|this|that|some|any|different|same) kind of\b|\bkinds of\b/.test(context)) return 'вид';
    if (/\b(kind|nice|gentle) (person|man|woman|people|gesture|words)\b/.test(context)) return 'добрый';
  }

  if (word === 'spring' || word === 'springs') {
    if (/\b(march|april|may|season|winter|summer)\b/.test(context)) return 'весна';
    if (/\b(water|natural|hot spring|mineral)\b/.test(context)) return 'источник';
    if (/\b(coil|metal|mattress|mechanism)\b/.test(context)) return 'пружина';
  }

  if (word === 'board' || word === 'boards') {
    if (/\b(board of directors|board meeting|executive board|school board)\b/.test(context)) return 'совет';
    if (/\b(wood|wooden|plank|cut|nail)\b/.test(context)) return 'доска';
    if (/\bon board\b/.test(context)) return 'на борту';
  }

  return '';
}

const RU_STOP = new Set([
  'который','которая','которые','этого','этот','эта','это','быть','было','была','были',
  'имеет','иметь','делать','сделать','один','одна','одного','такой','такая','также','очень',
  'может','могут','после','перед','через','между','среди','если','чтобы','тогда','только',
]);

function russianRoots(value) {
  const out = new Set();
  for (const token of normalizeRu(value).split(/\s+/)) {
    if (token.length < 4 || RU_STOP.has(token)) continue;
    out.add(token.slice(0, 4));
  }
  return out;
}

function chooseSenseFromTranslation(candidates, translated) {
  const translationRoots = russianRoots(translated);
  if (!translationRoots.size) return '';
  const scored = [];
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    const sense = compactRussian(raw);
    if (!sense) continue;
    const roots = russianRoots(sense);
    let hits = 0;
    for (const root of roots) if (translationRoots.has(root)) hits += 1;
    scored.push({ sense, hits, roots:roots.size });
  }
  scored.sort((a, b) => b.hits - a.hits || a.roots - b.roots);
  const first = scored[0];
  const second = scored[1];
  if (!first || first.hits < 1) return '';
  if (second && second.hits === first.hits) return '';
  return first.sense;
}

function parsePayload(payloadJson) {
  try {
    const value = typeof payloadJson === 'string' ? JSON.parse(payloadJson) : payloadJson;
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}

function existingGloss(el) {
  const wrap = el?.parentElement?.classList?.contains('rw-en-gloss-wrap') ? el.parentElement : null;
  const node = wrap?.querySelector?.(':scope > .rw-en-gloss-text') || null;
  return { wrap, node };
}

function replaceGloss(el, ru, provider, contextKey = '') {
  if (!el?.classList?.contains('rw-migaku-unknown')) return false;
  const translated = compactRussian(ru);
  if (!translated) return false;
  const { wrap, node } = existingGloss(el);
  if (!wrap || !node) return false;
  const same = String(node.textContent || '').trim() === translated
    && wrap.dataset.enContextProvider === provider
    && (!contextKey || wrap.dataset.enContextKey === contextKey);
  if (same) return false;
  node.textContent = translated;
  wrap.dataset.enGlossRu = translated;
  wrap.dataset.enContextProvider = provider;
  if (contextKey) wrap.dataset.enContextKey = contextKey;
  return true;
}

function sensesFor(dict, surface, lemma) {
  const values = dict?.[normalize(lemma)] || dict?.[normalize(surface)] || [];
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const ru = compactRussian(value);
    const key = normalizeRu(ru);
    if (!ru || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(ru);
    if (out.length >= 12) break;
  }
  return out;
}

function requestContext(surface, context, candidates, contextKey) {
  const bridge = globalThis.ReaderEnglishContextTranslate;
  if (!bridge || typeof bridge.translate !== 'function') return false;
  if (activeRequests >= MAX_ACTIVE || pending.has(contextKey) || failedKeys.has(contextKey)) return false;
  const requestId = `enctx-${Date.now().toString(36)}-${(++requestSeq).toString(36)}`;
  pending.set(requestId, { surface, context, candidates, contextKey });
  pending.set(contextKey, requestId);
  activeRequests += 1;
  try {
    bridge.translate(requestId, context);
    return true;
  } catch (error) {
    pending.delete(requestId);
    pending.delete(contextKey);
    activeRequests = Math.max(0, activeRequests - 1);
    failedKeys.add(contextKey);
    console.warn('[en context gloss] bridge call failed', error?.message || error);
    return false;
  }
}

if (typeof window !== 'undefined') {
  window.__readerEnContextTranslateResolve = (requestId, ok, payloadJson) => {
    const item = pending.get(String(requestId || ''));
    if (!item || typeof item !== 'object') return;
    pending.delete(String(requestId || ''));
    pending.delete(item.contextKey);
    activeRequests = Math.max(0, activeRequests - 1);
    const payload = parsePayload(payloadJson);
    if (ok) {
      const selected = chooseSenseFromTranslation(item.candidates, payload.translated || '');
      if (selected) {
        const cache = readCache();
        cache[item.contextKey] = { ru:selected, t:Date.now(), provider:'mlkit-context' };
        saveCache(cache);
      } else failedKeys.add(item.contextKey);
    } else failedKeys.add(item.contextKey);
    schedule(0);
  };
}

async function scan() {
  if (currentLang() !== 'en') return;
  const root = document.getElementById('reader-chapter-text');
  if (!root) return;
  const unknown = Array.from(root.querySelectorAll('.reader-word.rw-migaku-unknown[data-word]'));
  if (!unknown.length) return;

  let dict = null;
  try { dict = await loadSenses(); }
  catch (error) {
    console.warn('[en context gloss] senses unavailable', error?.message || error);
    return;
  }
  const cache = readCache();

  for (const el of unknown) {
    const pair = existingGloss(el);
    if (!pair.wrap || !pair.node || !String(pair.node.textContent || '').trim()) continue;
    const surface = wordSurface(el);
    if (!surface) continue;
    const context = contextWords(el);

    const rule = directContextGloss(surface, context);
    if (rule) {
      replaceGloss(el, rule, 'rule-v1');
      continue;
    }

    const lemma = lemmaFor(surface);
    const candidates = sensesFor(dict, surface, lemma);
    if (candidates.length < 2) continue;
    const contextKey = `${normalize(lemma || surface)}|${hashText(normalize(context))}`;
    const cached = compactRussian(cache[contextKey]?.ru || '');
    if (cached) {
      replaceGloss(el, cached, 'mlkit-context-cache', contextKey);
      continue;
    }
    requestContext(surface, context, candidates, contextKey);
  }
}

function schedule(delay = 60) {
  clearTimeout(timer);
  timer = setTimeout(() => { void scan(); }, Math.max(0, Number(delay) || 0));
}

function bind() {
  const root = document.getElementById('reader-chapter-text');
  if (root && root !== observedRoot && typeof MutationObserver === 'function') {
    observer?.disconnect();
    observedRoot = root;
    observer = new MutationObserver(records => {
      if (currentLang() !== 'en') return;
      if (records.some(record => record.type === 'childList' || record.type === 'attributes')) schedule(80);
    });
    observer.observe(root, { childList:true, subtree:true, attributes:true, attributeFilter:['class','data-word'] });
  }
  schedule(0);
}

if (typeof window !== 'undefined' && !window.__readerEnContextGlossV1) {
  window.__readerEnContextGlossV1 = true;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once:true });
  else bind();
  window.addEventListener('pageshow', bind);
  window.addEventListener('reader:en-vocab-ready', () => schedule(20));
  window.addEventListener('reader:en-morphology-augmented', () => schedule(20));
}

export { normalize, directContextGloss, russianRoots, chooseSenseFromTranslation, contextWords };
