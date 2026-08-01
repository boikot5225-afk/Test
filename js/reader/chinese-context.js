// Deterministic contextual pinyin for common polyphonic Chinese words.
// The dictionary is word-based; these rules disambiguate the exact occurrence
// without polluting the global lexical cache with a context-only reading.

function normalizeWord(value) {
  return String(value || '').normalize('NFC').trim();
}

function normalizePinyin(value) {
  return String(value || '').trim().toLocaleLowerCase('en-US');
}

function matchesOccurrence(text, start, word, phrase) {
  if (!text || !phrase || !word) return false;
  let from = 0;
  while (from <= phrase.length) {
    const pos = phrase.indexOf(word, from);
    if (pos < 0) return false;
    const phraseStart = start - pos;
    if (phraseStart >= 0 && text.slice(phraseStart, phraseStart + phrase.length) === phrase) return true;
    from = pos + Math.max(1, word.length);
  }
  return false;
}

function occurrenceWindow(text, start, wordLength, radius = 7) {
  if (!text) return '';
  const safeStart = Number.isFinite(start) ? Math.max(0, start) : 0;
  return text.slice(Math.max(0, safeStart - radius), Math.min(text.length, safeStart + wordLength + radius));
}

const RULES = Object.freeze({
  '行': [
    { pinyin: 'háng', phrases: ['银行','行长','行业','同行','行家','行列','行号','排行','一行','两行','三行','几行','各行各业','道行'] },
    { pinyin: 'xíng', phrases: ['行走','行动','行为','进行','旅行','执行','举行','流行','可行','行驶','步行','自行','不行','行吗','行了','行不行'] },
  ],
  '长': [
    { pinyin: 'zhǎng', phrases: ['长大','成长','生长','校长','部长','队长','厂长','首长','家长','长辈','长子'] },
    { pinyin: 'cháng', phrases: ['很长','长短','长度','长江','长城','长时间','长久','长发','长途','长篇'] },
  ],
  '重': [
    { pinyin: 'chóng', phrases: ['重新','重复','重来','重做','重写','重读','重启','重建','重逢','重播'] },
    { pinyin: 'zhòng', phrases: ['重要','重量','严重','重视','尊重','沉重','重点','重伤','重病','重任'] },
  ],
  '还': [
    { pinyin: 'hái', phrases: ['还有','还是','还在','还没','还要','还会','还好','还可以','还不','还想','还说'] },
    { pinyin: 'huán', phrases: ['归还','偿还','还钱','还款','还债','还给','还书','退还','返还'] },
  ],
  '乐': [
    { pinyin: 'yuè', phrases: ['音乐','乐器','乐队','乐曲','乐谱','声乐','民乐','交响乐'] },
    { pinyin: 'lè', phrases: ['快乐','欢乐','乐意','乐观','乐趣','乐于','乐得'] },
  ],
  '得': [
    { pinyin: 'dé', phrases: ['得到','获得','取得','赢得','值得','得分','得病','心得','所得'] },
    { pinyin: 'děi', phrases: ['我得','你得','他得','她得','得去','得走','得做','得看','得想','得先','非得','总得','不得不'] },
    { pinyin: 'de', patterns: [/[跑走说写做学看听吃喝睡]+得(?:很|太|真|不|快|慢|好|差|多|少|清楚|明白)/] },
  ],
  '地': [
    { pinyin: 'dì', phrases: ['地方','土地','地面','地图','地下','地上','地区','地址','地点','地球','大地'] },
    { pinyin: 'de', patterns: [/地(?:说|看|走|跑|做|学习|工作|回答|问|笑|哭|想|写|读|听)/] },
  ],
  '着': [
    { pinyin: 'zháo', phrases: ['睡着','着火','着凉','着急','猜着','找着','碰着','够着'] },
    { pinyin: 'zhuó', phrases: ['着装','着陆','着手','着重','着眼','着实'] },
    { pinyin: 'zhe', phrases: ['看着','拿着','穿着','听着','说着','站着','坐着','放着','跟着','沿着','朝着','想着'] },
  ],
  '了': [
    { pinyin: 'liǎo', phrases: ['了解','了结','了不起','受不了','忘不了','吃不了','做不了'] },
    { pinyin: 'le', phrases: ['好了','来了','走了','说了','看了','结束了','开始了'] },
  ],
  '朝': [
    { pinyin: 'cháo', phrases: ['朝着','朝向','朝前','朝后','朝里','朝外','王朝','朝代','朝廷'] },
    { pinyin: 'zhāo', phrases: ['今朝','明朝','朝夕','朝阳','朝霞','朝露'] },
  ],
  '朝阳': [
    { pinyin: 'Cháoyáng', phrases: ['朝阳区','朝阳市','朝阳县'] },
    { pinyin: 'zhāo yáng', phrases: ['清晨的朝阳','早晨的朝阳','初升的朝阳','迎着朝阳','朝阳升起'] },
  ],
  '传': [
    { pinyin: 'zhuàn', phrases: ['传记','自传','列传','外传','正传'] },
    { pinyin: 'chuán', phrases: ['传播','传说','传达','传递','传统','宣传','流传','传染','传来'] },
  ],
  '调': [
    { pinyin: 'tiáo', phrases: ['调整','调节','调和','调味','调皮','协调','空调'] },
    { pinyin: 'diào', phrases: ['调查','调动','调任','调离','调兵','声调','曲调','语调'] },
  ],
  '空': [
    { pinyin: 'kòng', phrases: ['空白','空闲','空缺','空位','空出','抽空','有空','没空'] },
    { pinyin: 'kōng', phrases: ['天空','空气','空中','空虚','空旷','空想','空洞'] },
  ],
  '数': [
    { pinyin: 'shù', phrases: ['数学','数字','数量','数据','次数','人数','少数','多数'] },
    { pinyin: 'shǔ', phrases: ['数数','数一数','数清','数不清','倒数'] },
  ],
  '好': [
    { pinyin: 'hào', phrases: ['爱好','好学','好客','好奇','好胜','好动','好吃懒做'] },
    { pinyin: 'hǎo', phrases: ['很好','好吃','好看','好听','好人','好事','好像','好好'] },
  ],
  '难': [
    { pinyin: 'nàn', phrases: ['灾难','苦难','遇难','逃难','难民','患难'] },
    { pinyin: 'nán', phrases: ['困难','难过','难看','难听','难题','难道','为难'] },
  ],
  '要': [
    { pinyin: 'yāo', phrases: ['要求','要挟','要约'] },
    { pinyin: 'yào', phrases: ['想要','需要','还要','就要','快要','将要','不要','要去','要走','要做','要看','要说','要是','要命'] },
  ],
  '都': [
    { pinyin: 'dū', phrases: ['首都','都市','都城'] },
    { pinyin: 'dōu', phrases: ['都是','都有','都在','都不','都没','全都','大家都'] },
  ],
  '为': [
    { pinyin: 'wèi', phrases: ['为了','因为','为什么','为此','为谁'] },
    { pinyin: 'wéi', phrases: ['认为','以为','成为','作为','行为','为人','为难'] },
  ],
  '应': [
    { pinyin: 'yīng', phrases: ['应该','应当','应有','应届'] },
    { pinyin: 'yìng', phrases: ['回应','反应','适应','应用','答应','应付','应对'] },
  ],
  '转': [
    { pinyin: 'zhuǎn', phrases: ['转身','转弯','转变','转告','转移','转向','转学'] },
    { pinyin: 'zhuàn', phrases: ['转动','旋转','转圈','转盘','运转'] },
  ],
  '只': [
    { pinyin: 'zhī', phrases: ['一只','两只','三只','这只','那只','只身'] },
    { pinyin: 'zhǐ', phrases: ['只有','只是','只要','只好','只会','只想','只见'] },
  ],
  '种': [
    { pinyin: 'zhòng', phrases: ['种花','种树','种地','种田','种菜','播种'] },
    { pinyin: 'zhǒng', phrases: ['种子','种类','一种','两种','各种','品种'] },
  ],
  '藏': [
    { pinyin: 'zàng', phrases: ['西藏','藏族','宝藏','经藏','大藏经'] },
    { pinyin: 'cáng', phrases: ['收藏','隐藏','躲藏','藏起来','藏在','珍藏'] },
  ],
  '差': [
    { pinyin: 'chāi', phrases: ['出差','差事','差遣','邮差'] },
    { pinyin: 'chā', phrases: ['差别','差距','误差','温差','时差'] },
    { pinyin: 'chà', phrases: ['差不多','很差','太差','差点','差劲'] },
  ],
});

const FALLBACKS = Object.freeze({
  '行':'xíng','长':'cháng','重':'zhòng','还':'hái','乐':'lè','得':'de','地':'de','着':'zhe','了':'le',
  '朝':'cháo','传':'chuán','调':'diào','空':'kōng','数':'shù','好':'hǎo','难':'nán','为':'wèi','应':'yīng',
  '转':'zhuǎn','只':'zhǐ','种':'zhǒng','藏':'cáng','差':'chà','要':'yào','都':'dōu',
});

export function resolveChinesePinyin(word, context = {}) {
  const normalized = normalizeWord(word);
  const dictionaryPinyin = String(context.dictionaryPinyin || '').trim();
  if (!normalized) return dictionaryPinyin;

  const text = String(context.text || '');
  let start = Number(context.start);
  if (!Number.isFinite(start) || start < 0) start = text.indexOf(normalized);
  const windowText = occurrenceWindow(text, start, normalized.length);
  const rules = RULES[normalized] || [];

  for (const rule of rules) {
    if ((rule.phrases || []).some(phrase => matchesOccurrence(text, start, normalized, phrase))) return normalizePinyin(rule.pinyin);
    if ((rule.patterns || []).some(pattern => pattern.test(windowText))) return normalizePinyin(rule.pinyin);
  }

  return normalizePinyin(FALLBACKS[normalized] || dictionaryPinyin);
}

export function hasContextualPinyinRule(word) {
  return Object.prototype.hasOwnProperty.call(RULES, normalizeWord(word));
}
