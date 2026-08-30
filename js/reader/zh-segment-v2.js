// Reader AI Chinese lexical pipeline v3 — deterministic offline segmentation.
//
// The local segmenter is now the stable first-paint authority. Remote
// segmentation may enrich the cache later, but unknown multi-Hanzi spans must
// never win merely because they are long. A six-character garbage token is not
// "better" than three real words just because it uses fewer boxes on screen.

const DEFAULT_RANK_URL = '../data/zh_jieba_top100k.txt';
const DEFAULT_UNKNOWN_RANK = 300_000;
const MAX_WORD_LENGTH = 8;
const TOKEN_PENALTY = 3.0;
const HAN_RE = /[\u3400-\u9fff]/;
const HAN_RUN_RE = /^[\u3400-\u9fff]+$/;

let rankMap = null;
let rankPromise = null;

const COMMON_SURNAMES = new Set(Array.from(
  '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏窦章云苏潘葛奚范彭郎鲁韦昌马苗方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯管卢莫经房裘缪解应宗丁宣邓郁单杭洪包诸左石崔吉钮龚程嵇邢裴陆荣翁荀羊惠甄曲家封芮储靳井段富巫乌焦巴牧山谷车侯全班秋仲伊宫宁仇栾甘厉祖武符刘景詹龙叶幸黎白怀从鄂索赖卓蔺屠蒙池乔谭贡劳姬申冉宰雍桑桂牛边燕浦尚农温庄柴阎连艾容向古易慎廖终居衡步都耿满弘匡国文寇广欧沃利越隆师巩聂晁敖融冷辛那简饶曾沙鞠丰关相查后游权益公晋楚闫'
));
// Names often stand directly before a verb/adverb, not only before 的 or punctuation.
// 洪秀全曾实行 must be 洪秀全 / 曾 / 实行, not 洪 / 秀 / 全 / 曾 / 实行.
const NAME_FOLLOW = new Set(Array.from(
  '的在任被与和及曾是将已又也会可曾说称为向从对把给让令赴到去来、，。；：！？）】》”’'
));

const PRODUCTIVE_SUFFIXES = new Set(['者']);

export function ranksFromText(text) {
  const map = new Map();
  const lines = String(text || '').split(/\r?\n/);
  let rank = 0;
  for (const raw of lines) {
    const word = String(raw || '').trim();
    if (!word || map.has(word)) continue;
    rank += 1;
    map.set(word, rank);
  }
  return map;
}

export function setZhSegmentRanksForTest(value) {
  rankMap = value instanceof Map ? value : new Map(Object.entries(value || {}));
  rankPromise = Promise.resolve(rankMap);
  return rankMap;
}

export function zhSegmentRanksReady() {
  return rankMap instanceof Map && rankMap.size > 0;
}

export async function ensureZhSegmentRanks(url = DEFAULT_RANK_URL) {
  if (zhSegmentRanksReady()) return rankMap;
  if (rankPromise) return rankPromise;
  rankPromise = fetch(url, { cache: 'force-cache' })
    .then(response => {
      if (!response.ok) throw new Error(`Jieba rank asset HTTP ${response.status}`);
      return response.text();
    })
    .then(text => {
      const parsed = ranksFromText(text);
      if (parsed.size < 50_000) throw new Error(`Jieba rank asset too small: ${parsed.size}`);
      rankMap = parsed;
      return rankMap;
    })
    .finally(() => { rankPromise = null; });
  return rankPromise;
}

function tokenCost(word, ranks, unknownRank = DEFAULT_UNKNOWN_RANK) {
  const rank = Number(ranks?.get?.(word) || unknownRank);
  return Math.log(Math.max(1, rank) + 10) + TOKEN_PENALTY;
}

function isUnlexicalizedProductiveForm(word, ranks, hasWord) {
  if (word.length < 3 || ranks?.has?.(word)) return false;
  const suffix = word.slice(-1);
  if (!PRODUCTIVE_SUFFIXES.has(suffix)) return false;
  const stem = word.slice(0, -1);
  if (stem.length < 2) return false;
  return !!ranks?.has?.(stem) || !!hasWord?.(stem);
}

function likelyPersonNameToken(word) {
  const value = String(word || '');
  return (value.length === 2 || value.length === 3)
    && COMMON_SURNAMES.has(value[0])
    && HAN_RUN_RE.test(value);
}

function probableName(run, index) {
  const first = run[index] || '';
  if (!COMMON_SURNAMES.has(first)) return '';
  for (const size of [3, 2]) {
    const value = run.slice(index, index + size);
    if (value.length !== size || !HAN_RUN_RE.test(value)) continue;
    const next = run[index + size] || '';
    if (!next || NAME_FOLLOW.has(next)) return value;
  }
  return '';
}

function segmentHanRun(run, { ranks, hasWord, maxWordLength = MAX_WORD_LENGTH } = {}) {
  const n = run.length;
  if (!n) return [];
  const costs = new Array(n + 1).fill(Number.POSITIVE_INFINITY);
  const next = new Array(n + 1).fill(null);
  costs[n] = 0;

  for (let i = n - 1; i >= 0; i -= 1) {
    const name = probableName(run, i);
    for (let size = 1; size <= Math.min(maxWordLength, n - i); size += 1) {
      const word = run.slice(i, i + size);
      const ranked = !!ranks?.has?.(word);
      const blockedProductive = isUnlexicalizedProductiveForm(word, ranks, hasWord);
      const lexical = !blockedProductive && (size === 1 || ranked || !!hasWord?.(word) || word === name);
      if (!lexical) continue;
      let own = tokenCost(word, ranks);
      if (word === name && !ranked && !hasWord?.(word)) own = Math.log(75_000) + TOKEN_PENALTY;
      const total = own + costs[i + size];
      if (total < costs[i]) {
        costs[i] = total;
        next[i] = { end: i + size, word };
      }
    }
  }

  const out = [];
  for (let i = 0; i < n;) {
    const step = next[i];
    if (!step) {
      out.push(run[i]);
      i += 1;
      continue;
    }
    out.push(step.word);
    i = step.end;
  }
  return out;
}

export function segmentChineseWeighted(text, {
  ranks = rankMap,
  hasWord = () => false,
  maxWordLength = MAX_WORD_LENGTH,
} = {}) {
  const source = String(text || '');
  if (!source) return [];
  const activeRanks = ranks instanceof Map ? ranks : new Map();
  const out = [];
  let i = 0;
  while (i < source.length) {
    if (HAN_RE.test(source[i])) {
      let j = i + 1;
      while (j < source.length && HAN_RE.test(source[j])) j += 1;
      out.push(...segmentHanRun(source.slice(i, j), { ranks: activeRanks, hasWord, maxWordLength }));
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < source.length && !HAN_RE.test(source[j])) j += 1;
    out.push(source.slice(i, j));
    i = j;
  }
  return out.filter(Boolean);
}

function unknownPenalty(token, { blockedProductive = false } = {}) {
  const len = Array.from(String(token || '')).length;
  if (blockedProductive) return 12 + Math.max(0, len - 2) * 4;
  if (len <= 1) return 5.5;
  if (likelyPersonNameToken(token)) return 6 + len * 1.5;
  // This is the key v3 change. Unknown multi-Hanzi spans are increasingly
  // suspicious as they get longer. The old fixed +5.5 let a garbage six-Hanzi
  // remote token beat several real dictionary words simply by reducing token count.
  return 8 + len * 6 + Math.max(0, len - 4) * 5;
}

export function scoreChineseSegmentation(tokens, { ranks = rankMap, hasWord = () => false } = {}) {
  const activeRanks = ranks instanceof Map ? ranks : new Map();
  let cost = 0;
  for (const token of Array.isArray(tokens) ? tokens : []) {
    if (!HAN_RUN_RE.test(token)) continue;
    const blockedProductive = isUnlexicalizedProductiveForm(token, activeRanks, hasWord);
    const known = !blockedProductive && (token.length === 1 || activeRanks.has(token) || !!hasWord(token));
    cost += tokenCost(token, activeRanks) + (known ? 0 : unknownPenalty(token, { blockedProductive }));
  }
  return cost;
}

export const ZH_SEGMENT_V2 = Object.freeze({
  version: 3,
  rankUrl: DEFAULT_RANK_URL,
  rankLimit: 100_000,
  maxWordLength: MAX_WORD_LENGTH,
  tokenPenalty: TOKEN_PENALTY,
  productiveSuffixes: [...PRODUCTIVE_SUFFIXES],
});
