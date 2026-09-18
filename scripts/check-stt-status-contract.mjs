// Контракт между замороженным ядром и слоем фонового распознавания.
//
// reader-app.js заморожен по хешу, событий о ходе работы у него нет, и
// stt-background-v1.js берёт прогресс из строк, которые ядро пишет в
// #reader-import-audio-status. Связь держится на формулировках, а формулировки
// живут в чужом файле. Если однажды заморозку снимут и «Распознаю фрагмент
// 3/12» станет «Фрагмент 3 из 12», индикатор не сломается заметно — он просто
// перестанет двигаться, и никто не узнает до жалобы.
//
// Поэтому строки берутся из самого ядра (из вызовов setStatus внутри
// readerTranscribeBlob), прогоняются через настоящий readStatus слоя, и сборка
// падает, если хоть один обязательный этап перестал опознаваться.
//
//   node scripts/check-stt-status-contract.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readStatus } from '../js/reader/stt-background-v1.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(repo, 'js/reader-app.js'), 'utf-8');

const start = src.indexOf('async function readerTranscribeBlob');
const end = src.indexOf('window.readerTranscribeAudioFile = readerTranscribeAudioFile;');
if (start < 0 || end < 0 || end <= start) {
  console.error('не нашёл конвейер распознавания в js/reader-app.js — контракт проверить не на чем');
  process.exit(1);
}
const body = src.slice(start, end);

// Каждый этап опознаётся по своей строке; подставляем в шаблоны ядра числа.
const required = [
  { name: 'разбор записи', pattern: /Разбираю аудио/, fill: s => s, expect: r => r?.phase === 'decode' },
  { name: 'извлечение звука из видео', pattern: /Извлекаю звук/, fill: s => s, expect: r => r?.phase === 'decode' },
  {
    name: 'распознавание по фрагментам',
    pattern: /Распознаю фрагмент/,
    fill: s => s.replace('${i + 1}', '3').replace('${chunkCount}', '12'),
    expect: r => r?.phase === 'stt' && r.index === 2 && r.total === 12,
  },
  {
    name: 'чистка текста',
    pattern: /чистит текст/,
    fill: s => s.replace('${i + 1}', '2').replace('${groups.length}', '5'),
    expect: r => r?.phase === 'cleanup' && r.index === 1 && r.total === 5,
  },
];

// Литералы берём из всего тела функции, а не из разбора вызовов setStatus:
// скобка внутри самой строки («Разбираю аудио (браузер)...») обрывает любой
// разумный захват аргументов, а шаблоны ниже и так достаточно характерные.
const literals = [];
for (const [, tpl, str] of body.matchAll(/`([^`]*)`|'((?:[^'\\\n]|\\.)*)'/g)) {
  const text = tpl ?? str;
  if (text && text.trim()) literals.push(text);
}

let failed = 0;
for (const step of required) {
  const literal = literals.find(l => step.pattern.test(l));
  if (!literal) {
    console.error(`ПЛОХО  ${step.name}: в ядре больше нет строки ${step.pattern}`);
    failed++;
    continue;
  }
  const sample = step.fill(literal);
  const parsed = readStatus(sample);
  if (!step.expect(parsed)) {
    console.error(`ПЛОХО  ${step.name}: слой не разобрал «${sample}» -> ${JSON.stringify(parsed)}`);
    failed++;
    continue;
  }
  console.log(`OK     ${step.name}: «${sample.slice(0, 56)}»`);
}

// Итоги ядра: успех, отмена, ошибка.
for (const [name, sample, kind] of [
  ['успех', '✅ Готово: 9 фрагмент(ов) · аудио сохранено. Проверь текст перед сохранением.', 'done'],
  ['отмена', '⏹ Отменено', 'cancelled'],
  ['ошибка', '❌ Ошибка распознавания', 'fail'],
]) {
  const parsed = readStatus(sample);
  if (parsed?.kind !== kind) {
    console.error(`ПЛОХО  ${name}: «${sample}» -> ${JSON.stringify(parsed)}`);
    failed++;
  } else {
    console.log(`OK     ${name}`);
  }
}

if (failed) {
  console.error(`\nконтракт нарушен: ${failed} шаг(ов). Индикатор распознавания перестанет показывать прогресс.`);
  process.exit(1);
}
console.log('\nконтракт ядро -> индикатор цел');
