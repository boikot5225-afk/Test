import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const source = await fs.readFile(new URL('../js/reader/chinese-context.js', import.meta.url), 'utf8');
const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const { resolveChinesePinyin } = mod;

function check(text, word, expected, occurrence = 0, dictionaryPinyin = '') {
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = text.indexOf(word, start + 1);
  assert.notEqual(start, -1, `word ${word} not found in ${text}`);
  const actual = resolveChinesePinyin(word, { text, start, dictionaryPinyin });
  assert.equal(actual, expected, `${text} / ${word}: expected ${expected}, got ${actual}`);
}

const cases = [
  ['我去银行办事。','行','háng'], ['他每天步行上班。','行','xíng'],
  ['孩子慢慢长大。','长','zhǎng'], ['这条路很长。','长','cháng'],
  ['请重新开始。','重','chóng'], ['这个问题很重要。','重','zhòng'],
  ['这里还有一本书。','还','hái'], ['明天把钱还给他。','还','huán'],
  ['我喜欢听音乐。','乐','yuè'], ['孩子今天很快乐。','乐','lè'],
  ['他终于得到机会。','得','dé'], ['我得马上走。','得','děi'], ['他跑得很快。','得','de'],
  ['这个地方很安静。','地','dì'], ['她认真地学习。','地','de'],
  ['他看着窗外。','着','zhe'], ['孩子已经睡着了。','着','zháo'],
  ['我想了解情况。','了','liǎo'], ['事情结束了。','了','le'],
  ['他朝着门口走。','朝','cháo'], ['清晨的朝阳很美。','朝阳','zhāo yáng'],
  ['他写了一本传记。','传','zhuàn'], ['这个消息传播很快。','传','chuán'],
  ['需要调整计划。','调','tiáo'], ['警方正在调查。','调','diào'],
  ['请留一点空白。','空','kòng'], ['天空很蓝。','空','kōng'],
  ['她正在学习数学。','数','shù'], ['请数一数人数。','数','shǔ'],
  ['他的爱好很多。','好','hào'], ['这个菜很好吃。','好','hǎo'],
  ['那是一场灾难。','难','nàn'], ['这个问题很难。','难','nán'],
  ['为了工作他搬家了。','为','wèi'], ['我认为他说得对。','为','wéi'],
  ['你应该休息。','应','yīng'], ['他没有回应。','应','yìng'],
  ['他突然转身。','转','zhuǎn'], ['轮子不停转动。','转','zhuàn'],
  ['桌上有一只猫。','只','zhī'], ['我只有一本书。','只','zhǐ'],
  ['春天我们种花。','种','zhòng'], ['这些种子发芽了。','种','zhǒng'],
  ['他把书藏起来。','藏','cáng'], ['她准备去西藏。','藏','zàng'],
  ['他明天要出差。','差','chāi'], ['两者差别很大。','差','chā'], ['这个结果太差。','差','chà'],
  ['老师要求我们按时完成。','要','yāo'], ['我明天要去银行。','要','yào'],
  ['北京是中国的首都。','都','dū'], ['大家都已经来了。','都','dōu'],
  ['他住在北京朝阳区。','朝阳','cháoyáng'], ['清晨的朝阳很美。','朝阳','zhāo yáng'],

  // v0.10: common polyphones from fiction/news that previously fell through
  // to one dictionary reading regardless of the actual sentence.
  ['我不知不觉睡着了。','觉','jué',0], ['我不知不觉睡着了。','觉','jiào',1],
  ['这件衣服很便宜。','便','pián'], ['这样做比较方便。','便','biàn'],
  ['当时他把这件事当作玩笑。','当','dāng',0], ['当时他把这件事当作玩笑。','当','dàng',1],
  ['她的头发很长。','发','fà'], ['事情突然发生了。','发','fā'],
  ['保安正在看门。','看','kān'], ['我看见他了。','看','kàn'],
  ['请把书还给老师。','给','gěi'], ['前线需要补给。','给','jǐ'],
  ['他们互相信任。','相','xiāng'], ['照片上的长相很熟悉。','相','xiàng'],
  ['警方正在处理现场。','处','chǔ'], ['他跑得到处都是。','处','chù'],
  ['房间很干净。','干','gān'], ['他正在干活。','干','gàn'],
  ['老师在教书。','教','jiāo'], ['教育很重要。','教','jiào'],
  ['他需要认真反省。','省','xǐng'], ['这样可以省钱。','省','shěng'],
];

for (const args of cases) check(...args);
check('他还有一本书要还给老师。','还','hái',0,'Huán');
check('他还有一本书要还给老师。','还','huán',1,'Huán');
check('这本书很好。','书','shū',0,'Shū');

console.log(`Chinese contextual pinyin: ${cases.length + 3} cases passed`);
