#!/usr/bin/env node
// Японский текст нельзя было читать из-за одной строчки в ja-readable-inline.js.
//
// Слой рисует русскую строку под словом и берёт её из трёх кэшей в
// localStorage. Эти кэши растут вместе с чтением: в них лежит каждое слово,
// которое читатель открывал, и каждый ответ разбора абзаца. Разбор всех трёх
// стоял внутри функции, которую проход вызывает на каждое слово главы, а
// проход запускается после каждой прокрутки и каждого перелистывания.
//
// Замер на настоящем модуле в jsdom, кэши 243/47/355 КБ, глава 1500 слов:
//
//   было:  21522 мс на проход, 9000 обращений к localStorage, 1.19 ГБ разбора
//   стало:   317 мс на проход,    3 обращения,                0.4 МБ разбора
//
// Нарисованные строки совпадают до единой. Эта проверка сторожит форму, из-за
// которой всё и случилось: разбор словарей не имеет права стоять на пути
// каждого слова.
import { readFileSync } from 'node:fs';

const PATH = 'js/reader/ja-readable-inline.js';
const source = readFileSync(PATH, 'utf8');
const problems = [];

function body(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (!depth) return source.slice(start, i + 1);
    }
  }
  return null;
}

const perWord = body('cachedRussian');
if (!perWord) problems.push(`в ${PATH} больше нет cachedRussian — проверка ослепла`);
else if (/readJson\s*\(/.test(perWord)) {
  problems.push('cachedRussian снова разбирает JSON — это путь каждого слова главы');
}

const pass = body('syncAll');
if (!pass) problems.push('в файле больше нет syncAll — проверка ослепла');
else if (!/invalidateCaches\s*\(\s*\)/.test(pass)) {
  problems.push('syncAll не сбрасывает разобранные словари — новый перевод не появится');
}

const shared = body('caches');
if (!shared) problems.push('нет общей функции caches() — разбор снова растворён по коду');
else {
  for (const key of ['LEXICAL_CACHE_KEY', 'INSTANT_CACHE_KEY', 'BATCH_CACHE_KEY']) {
    if (!shared.includes(key)) problems.push(`caches() больше не читает ${key}`);
  }
}

// Разбор должен быть ровно в одном месте: в caches(). Любое другое обращение к
// этим трём ключам — это снова разбор внутри прохода.
const readJsonCalls = (source.match(/(?<!function\s)readJson\s*\(/g) || []).length;
const inCaches = ((shared || '').match(/readJson\s*\(/g) || []).length;
if (readJsonCalls !== inCaches) {
  problems.push(`readJson вызывается вне caches(): ${readJsonCalls - inCaches} раз(а)`);
}

// Ленивость: для главы на другом языке японские словари не должны разбираться
// вовсе, поэтому caches() вызывается по требованию, а не в начале прохода.
if (pass && /\bcaches\s*\(\s*\)/.test(pass)) {
  problems.push('syncAll разбирает словари сам — французская глава платить за это не должна');
}

if (problems.length) {
  console.error('ja inline gloss cache contract FAILED:');
  for (const item of problems) console.error(`  - ${item}`);
  process.exit(1);
}
console.log('ja inline gloss cache contract: PASS');
