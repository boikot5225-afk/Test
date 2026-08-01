import fs from 'node:fs';
import path from 'node:path';

const readerPath = path.resolve(process.argv[2] || 'js/reader-app.js');
const readerDir = path.dirname(readerPath);
const contextPath = path.join(readerDir, 'reader', 'chinese-context.js');

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`Reader v0.10 patch failed: ${label} not found in ${readerPath}`);
  if (source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`Reader v0.10 patch failed: ${label} is ambiguous in ${readerPath}`);
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

function patchReader() {
  let source = fs.readFileSync(readerPath, 'utf8');
  if (source.includes('READER_A54_V10_PATCH')) {
    console.log(`[reader v0.10] already patched: ${readerPath}`);
    return;
  }

  source = replaceOnce(
    source,
    'const readerLexicalInFlight = new Map();',
    `const readerLexicalInFlight = new Map();
// READER_A54_V10_PATCH: caches below are render-session infrastructure only.
// They prevent rebuilding a 4k lexical + 6k word-state Set for every paragraph
// and avoid resolving identical contextual pinyin on every repaint.
const READER_A54_V10_PATCH = true;
let readerZhDynamicWordSet = null;
const readerZhInlinePinyinCache = new Map();
const READER_ZH_PINYIN_CACHE_MAX = 12000;`,
    'cache declarations',
  );

  source = replaceOnce(
    source,
    `function readerPutCachedLexical(word, data, lang = null) {
  if (!word || !data) return;
  const cache = loadReaderLexicalCache();
  const l = readerCanonicalLang(lang || data.lang || readerCurrentLang());
  cache[readerLexicalCacheKey(word, l)] = { ...data, lang: l, cachedAt: new Date().toISOString() };
  saveReaderLexicalCache();
}`,
    `function readerPutCachedLexical(word, data, lang = null) {
  if (!word || !data) return;
  const cache = loadReaderLexicalCache();
  const l = readerCanonicalLang(lang || data.lang || readerCurrentLang());
  cache[readerLexicalCacheKey(word, l)] = { ...data, lang: l, cachedAt: new Date().toISOString() };
  readerZhDynamicWordSet = null;
  readerZhInlinePinyinCache.clear();
  saveReaderLexicalCache();
}`,
    'lexical cache invalidation',
  );

  source = replaceOnce(
    source,
    `function readerBuildChineseWordSet() {
  // Dynamic/user words only. The full CC-CEDICT map can be 120k+ entries,
  // so we do NOT copy it into a Set on every paragraph render.
  if (!readerZhCoreJson && !readerZhCoreJsonPromise) readerEnsureZhCoreJsonLoaded({ rerender: false });
  const dict = new Set([...Object.keys(READER_ZH_CORE_LEXICON), ...Object.keys(READER_ZH_READING_LEXICON)]);
  const lex = loadReaderLexicalCache();
  Object.keys(lex || {}).forEach(k => {
    if (!k.startsWith('zh:')) return;
    const item = lex[k] || {};
    [item.word, item.surface, item.lemma].forEach(x => { const w = readerNormalizeWord(x, 'zh'); if (w) dict.add(w); });
  });
  const states = loadReaderWordState();
  Object.values(states || {}).forEach(st => {
    if (!st || readerCanonicalLang(st.lang) !== 'zh') return;
    const w = readerNormalizeWord(st.word, 'zh');
    if (w) dict.add(w);
  });
  return dict;
}`,
    `function readerBuildChineseWordSet() {
  // Building this Set used to scan all lexical-cache and word-state entries for
  // every paragraph in a chapter. On a real library that is millions of object
  // visits per paint. Keep one session copy and invalidate it only when one of
  // those stores actually changes.
  if (readerZhDynamicWordSet) return readerZhDynamicWordSet;
  if (!readerZhCoreJson && !readerZhCoreJsonPromise) readerEnsureZhCoreJsonLoaded({ rerender: false });
  const dict = new Set([...Object.keys(READER_ZH_CORE_LEXICON), ...Object.keys(READER_ZH_READING_LEXICON)]);
  const lex = loadReaderLexicalCache();
  Object.keys(lex || {}).forEach(k => {
    if (!k.startsWith('zh:')) return;
    const item = lex[k] || {};
    [item.word, item.surface, item.lemma].forEach(x => { const w = readerNormalizeWord(x, 'zh'); if (w) dict.add(w); });
  });
  const states = loadReaderWordState();
  Object.values(states || {}).forEach(st => {
    if (!st || readerCanonicalLang(st.lang) !== 'zh') return;
    const w = readerNormalizeWord(st.word, 'zh');
    if (w) dict.add(w);
  });
  readerZhDynamicWordSet = dict;
  return dict;
}`,
    'Chinese dynamic dictionary cache',
  );

  source = replaceOnce(
    source,
    `function saveReaderWordState() {
  const result = readerWordState.save();
  scheduleWordStateCloudSync();
  return result;
}`,
    `function saveReaderWordState() {
  const result = readerWordState.save();
  readerZhDynamicWordSet = null;
  scheduleWordStateCloudSync();
  return result;
}`,
    'word-state dictionary invalidation',
  );

  source = source.replaceAll(
    'readerTrackParagraphIndexSeen(Number(el.dataset.p), { refresh: true })',
    "readerTrackParagraphIndexSeen(Number(el.dataset.p), { refresh: readerCanonicalLang(readerCurrentLang()) !== 'zh' })",
  );
  source = source.replaceAll(
    'readerTrackParagraphIndexSeen(idx, { refresh: true });',
    "readerTrackParagraphIndexSeen(idx, { refresh: readerCanonicalLang(readerCurrentLang()) !== 'zh' });",
  );

  source = replaceOnce(
    source,
    `      span.classList.toggle('rw-pinyin-slot', hasSlot);
      span.classList.toggle('rw-pinyin-on', !!pinyin);
      span.innerHTML = readerRenderChineseTokenBody(surface, pinyin, lang);`,
    `      span.classList.toggle('rw-pinyin-slot', hasSlot);
      span.classList.toggle('rw-pinyin-on', !!pinyin);
      const previousPinyin = span.dataset.readerPinyin || '';
      const previousSlot = span.dataset.readerPinyinSlot === '1';
      if (previousPinyin !== pinyin || previousSlot !== hasSlot) {
        span.innerHTML = readerRenderChineseTokenBody(surface, pinyin, lang);
        span.dataset.readerPinyin = pinyin;
        span.dataset.readerPinyinSlot = hasSlot ? '1' : '0';
      }`,
    'non-destructive Chinese token refresh',
  );

  source = replaceOnce(
    source,
    `  if (mode === 'learning') return inWork;
  if (seenOnlyYellow) return false;

  // Default Chinese reading mode: show pinyin for new + in-work words, but not for yellow seen-only words.
  return true;`,
    `  if (mode === 'learning') return inWork;

  // The default button explicitly promises pinyin for every not-yet-learned
  // word. Passive encounter counters must never make ruby disappear while the
  // user is reading or after reopening the same page.
  void seenOnlyYellow;
  return true;`,
    'stable default pinyin policy',
  );

  source = replaceOnce(
    source,
    `function readerInlinePinyinForWord(word, lang = null, context = {}) {
  const l = readerCanonicalLang(lang || readerCurrentLang());
  if (l !== 'zh' || !readerShouldShowInlinePinyin(word, l)) return '';
  const local = readerLookupChineseLocalEntry(word);
  const cached = readerGetCachedLexical(word, l);
  const dictionaryPinyin = readerExtractPinyin(local || {}) || readerExtractPinyin(cached || {});
  return resolveChinesePinyin(word, {
    text: context.text || '',
    start: context.start,
    dictionaryPinyin,
  });
}`,
    `function readerInlinePinyinForWord(word, lang = null, context = {}) {
  const l = readerCanonicalLang(lang || readerCurrentLang());
  if (l !== 'zh' || !readerShouldShowInlinePinyin(word, l)) return '';
  const local = readerLookupChineseLocalEntry(word);
  const cached = readerGetCachedLexical(word, l);
  const dictionaryPinyin = readerExtractPinyin(local || {}) || readerExtractPinyin(cached || {});
  const text = String(context.text || '');
  const start = Number.isFinite(Number(context.start)) ? Number(context.start) : text.indexOf(word);
  const cacheKey = [readerZhPinyinMode(), readerTextHash(text), start, word, dictionaryPinyin].join('|');
  if (readerZhInlinePinyinCache.has(cacheKey)) return readerZhInlinePinyinCache.get(cacheKey);
  const result = resolveChinesePinyin(word, { text, start, dictionaryPinyin });
  if (readerZhInlinePinyinCache.size >= READER_ZH_PINYIN_CACHE_MAX) readerZhInlinePinyinCache.clear();
  readerZhInlinePinyinCache.set(cacheKey, result);
  return result;
}`,
    'contextual pinyin render cache',
  );

  source = replaceOnce(
    source,
    `data-reader-offset="\${tokenStart}" data-lang="\${readerEscape(lang)}"`,
    `data-reader-offset="\${tokenStart}" data-reader-pinyin="\${readerEscape(pinyin)}" data-reader-pinyin-slot="\${hasSlot ? '1' : '0'}" data-lang="\${readerEscape(lang)}"`,
    'initial token pinyin snapshot',
  );

  fs.writeFileSync(readerPath, source);
  console.log(`[reader v0.10] patched: ${readerPath}`);
}

function patchChineseContext() {
  if (!fs.existsSync(contextPath)) throw new Error(`Chinese context module missing: ${contextPath}`);
  let source = fs.readFileSync(contextPath, 'utf8');
  if (source.includes('READER_A54_V10_CONTEXT_RULES')) {
    console.log(`[reader v0.10] context rules already patched: ${contextPath}`);
    return;
  }

  source = replaceOnce(
    source,
    'const RULES = Object.freeze({',
    `// READER_A54_V10_CONTEXT_RULES — common novel/news polyphones that were
// previously left to a single dictionary fallback reading.
const RULES = Object.freeze({
  '觉': [
    { pinyin: 'jiào', phrases: ['睡觉','午觉','懒觉','一觉','补觉'] },
    { pinyin: 'jué', phrases: ['觉得','感觉','发觉','察觉','自觉','知觉','不知不觉','觉察','觉悟'] },
  ],
  '便': [
    { pinyin: 'pián', phrases: ['便宜','占便宜'] },
    { pinyin: 'biàn', phrases: ['方便','便利','随便','便是','便于','以便','不便'] },
  ],
  '当': [
    { pinyin: 'dàng', phrases: ['上当','恰当','适当','当作','当成','典当','当铺'] },
    { pinyin: 'dāng', phrases: ['当时','当然','当天','应当','担当','当家','当面','当中'] },
  ],
  '发': [
    { pinyin: 'fà', phrases: ['头发','理发','发型','长发','短发'] },
    { pinyin: 'fā', phrases: ['发生','发现','出发','发展','发表','发出','发明','发送'] },
  ],
  '看': [
    { pinyin: 'kān', phrases: ['看守','看门','看护','看管'] },
    { pinyin: 'kàn', phrases: ['看见','看到','看看','好看','难看','看着','看书'] },
  ],
  '给': [
    { pinyin: 'jǐ', phrases: ['给予','供给','补给','自给自足'] },
    { pinyin: 'gěi', phrases: ['给我','给你','给他','给她','还给','交给','送给','留给'] },
  ],
  '相': [
    { pinyin: 'xiàng', phrases: ['相片','照相','相貌','长相','宰相'] },
    { pinyin: 'xiāng', phrases: ['相信','相互','相同','相似','相处','互相'] },
  ],
  '处': [
    { pinyin: 'chù', phrases: ['到处','住处','出处','好处','坏处','深处','四处'] },
    { pinyin: 'chǔ', phrases: ['处理','相处','处于','处分','处置','独处'] },
  ],
  '干': [
    { pinyin: 'gān', phrases: ['干净','干燥','饼干','晒干'] },
    { pinyin: 'gàn', phrases: ['干活','能干','干事','干部','干什么'] },
  ],
  '教': [
    { pinyin: 'jiāo', phrases: ['教书','教课','教给','教会'] },
    { pinyin: 'jiào', phrases: ['教育','教师','教室','宗教','教训'] },
  ],
  '省': [
    { pinyin: 'xǐng', phrases: ['反省','省悟','不省人事'] },
    { pinyin: 'shěng', phrases: ['省钱','节省','省事','省城','省份'] },
  ],`,
    'expanded contextual pinyin rules',
  );

  source = replaceOnce(
    source,
    `const FALLBACKS = Object.freeze({
  '行':'xíng'`,
    `const FALLBACKS = Object.freeze({
  '觉':'jué','便':'biàn','当':'dāng','发':'fā','看':'kàn','给':'gěi','相':'xiāng','处':'chù','干':'gàn','教':'jiào','省':'shěng',
  '行':'xíng'`,
    'expanded contextual pinyin fallbacks',
  );

  fs.writeFileSync(contextPath, source);
  console.log(`[reader v0.10] patched context rules: ${contextPath}`);
}

patchReader();
patchChineseContext();
