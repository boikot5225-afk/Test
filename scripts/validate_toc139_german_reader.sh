#!/usr/bin/env bash
set -euo pipefail

# toc139 — немецкий слой читалки. Наследует полностью зелёный гейт toc138,
# подменив номер сборки на ожидаемый им, и добавляет свои проверки.
GRADLE=android/app/build.gradle
BACKUP="$(mktemp)"
cp "$GRADLE" "$BACKUP"
restore() {
  cp "$BACKUP" "$GRADLE"
  rm -f "$BACKUP"
}
trap restore EXIT

python3 - <<'PY'
from pathlib import Path
p=Path('android/app/build.gradle')
s=p.read_text(encoding='utf-8')
assert s.count('versionCode 1045') == 1
s=s.replace('versionCode 1045','versionCode 1045',1)
p.write_text(s,encoding='utf-8')
PY
bash scripts/validate_toc138_fr_layout_performance.sh
restore
trap - EXIT

# Сборщик ресурсов проверяет сам себя на записанных ответах настоящих
# источников: регистр, ß, имена, составные слова.
python3 scripts/build_de_reader_resources.py --self-test

python3 scripts/materialize_de_vocab_module.py /tmp/toc139-de-vocab-estimate.js
node --check /tmp/toc139-de-vocab-estimate.js

for module in \
  js/reader/de-vocab-data-v1.js \
  js/reader/de-reader-pipeline-v1.js \
  js/reader/de-lexical-pipeline-v1.js \
  js/reader/de-context-batch-v1.js \
  js/reader/word-lookup.js \
  js/reader/interactions-runtime.js \
  js/tts.js \
  functions/index.js \
  functions/de-context-task.js
do
  node --check "$module"
done

# Немецкая логика на настоящих таблицах: ß, регистр, составные слова, имена.
node - <<'JS'
const { buildData, lemmaFor, mergedLemma, compoundParts, genderFor, isName } =
  await import('./js/reader/de-vocab-data-v1.js');
const { translationFor, looksProper } = await import('./js/reader/de-reader-pipeline-v1.js');

// Выжимка из настоящих файлов сборки: тех же строк, в том же формате.
const data = buildData({
  frequency: ['der\t', 'die\t', 'haus\tNOUN', 'tür\tNOUN', 'stunde\tNOUN', 'straße\tNOUN',
              'sonne\tNOUN', 'schein\tNOUN', 'lampe\tNOUN', 'gehen\t', 'haben\t', 'gut\t',
              'berlin\tNAME', 'bahnhof\tNOUN', 'aufgabe\tNOUN', 'strass\tNOUN'].join('\n'),
  general: ['habe\thaben', 'ging\tgehen', 'gute\tgut', 'strassen\tstrass'].join('\n'),
  noun: ['häuser\thaus', 'stunden\tstunde', 'lampen\tlampe', 'straßen\tstraße',
         'strassen\tstraße', 'strasse\tstraße', 'aufgaben\taufgabe', 'sonnen\tsonne'].join('\n'),
  gender: ['haus\tn', 'tür\tf', 'stunde\tf', 'straße\tf', 'lampe\tf', 'bahnhof\tm',
           'sonne\tf'].join('\n'),
});

const fails = [];
const check = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fails.push(`${label}: ${JSON.stringify(got)} вместо ${JSON.stringify(want)}`);
  }
};

// Регистр решает, какое это слово.
check('Stunden посреди предложения', lemmaFor(data, 'Stunden', { sentenceInitial: false }), 'stunde');
check('habe строчное', lemmaFor(data, 'habe', {}), 'haben');
check('gute строчное', lemmaFor(data, 'gute', {}), 'gut');
// ß: корпус знает только ss, страница показывает ß.
check('Straße', lemmaFor(data, 'Straße', { sentenceInitial: false }), 'straße');
check('Strasse по-швейцарски', lemmaFor(data, 'Strasse', { sentenceInitial: false }), 'straße');
// Регистр потерян — выбирает частотность.
check('strassen без регистра', mergedLemma(data, 'strassen'), 'straße');
// Составное слово.
check('Haustür', compoundParts(data, 'Haustür'), ['haus', 'tür']);
check('Bahnhofstraße', compoundParts(data, 'Bahnhofstraße'), ['bahnhof', 'straße']);
check('Hausaufgaben', compoundParts(data, 'Hausaufgaben'), ['haus', 'aufgabe']);
// Соединительное -n: Sonne + n + Schein. Викисловарь помечает солнце именем
// собственным, и стоит принять эту пометку всерьёз — Sonne выпадает из
// существительных, а слово раскладывается на глагол sonnen «загорать».
check('Sonnenschein', compoundParts(data, 'Sonnenschein'), ['sonne', 'schein']);
check('род Sonne', genderFor(data, 'sonne'), 'f');
check('Sonne именем не помечена', isName(data, 'sonne'), false);
// Артикль неотделим от существительного.
check('род Haus', genderFor(data, 'haus'), 'n');
check('род Straße', genderFor(data, 'straße'), 'f');
// Имя собственное — по пометке Викисловаря, а не по заглавной букве.
check('Berlin помечен именем', isName(data, 'berlin'), true);
check('Haus именем не помечен', isName(data, 'haus'), false);

const core = { haus: 'дом', tür: 'дверь', stunde: 'час', bahnhof: 'вокзал', straße: 'улица' };
check('перевод составного по частям', translationFor(core, data, 'Haustür', 'haustür'),
      { ru: 'дом + дверь', provider: 'compound' });
check('перевод из словаря', translationFor(core, data, 'Stunden', 'stunde'),
      { ru: 'час', provider: 'wikdict-immediate' });

function paragraph(words) {
  const nodes = words.map(text => ({ textContent: text, dataset: { word: text }, classList: { contains: () => false } }));
  const p = { querySelectorAll: () => nodes, querySelector: () => null };
  nodes.forEach(n => { n.closest = () => p; });
  return { p, nodes };
}
{
  const { p, nodes } = paragraph(['Die', 'Stunden', 'waren', 'gut']);
  // Заглавная посреди предложения — это существительное, а не имя.
  check('Stunden — не имя', looksProper(core, data, nodes[1], p), false);
}
{
  const { p, nodes } = paragraph(['Gestern', 'war', 'Berlin', 'leer']);
  check('Berlin — имя', looksProper(core, data, nodes[2], p), true);
}

if (fails.length) {
  console.error('toc139 German logic gate FAILED:\n  ' + fails.join('\n  '));
  process.exit(1);
}
console.log('toc139 German logic gate: PASS');
JS

python3 - <<'PY'
from pathlib import Path

gradle = Path('android/app/build.gradle').read_text(encoding='utf-8')
core = Path('js/reader-app.js').read_text(encoding='utf-8')
app = Path('js/app.js').read_text(encoding='utf-8')
html = Path('index.html').read_text(encoding='utf-8')
lookup = Path('js/reader/word-lookup.js').read_text(encoding='utf-8')
runtime = Path('js/reader/interactions-runtime.js').read_text(encoding='utf-8')
tts = Path('js/tts.js').read_text(encoding='utf-8')
functions = Path('functions/index.js').read_text(encoding='utf-8')
builder = Path('scripts/build_de_reader_resources.py').read_text(encoding='utf-8')
batch = Path('js/reader/de-context-batch-v1.js').read_text(encoding='utf-8')
data_layer = Path('js/reader/de-vocab-data-v1.js').read_text(encoding='utf-8')

# Сборка немецких ресурсов обязательна, как французская и испанская.
for probe in [
    "tasks.register('prepareGermanReaderResources')",
    "tasks.register('prepareGermanWebCode')",
    "dependsOn 'prepareGermanReaderResources'",
    "dependsOn 'prepareGermanWebCode'",
    'germanReaderAssets/dereader/de_vocab_frequency.tsv',
    'germanReaderAssets/dereader/de_noun_lemma.tsv',
    'germanReaderAssets/dereader/de_noun_gender.tsv',
    'germanReaderAssets/dereader/de_ru_core.json',
    "'--install-deps'",
    "'--self-test'",
]:
    assert probe in gradle, f'German build wiring missing: {probe}'

# Рельсы языка в ядре.
for probe in [
    "de: { code: 'de', label: 'Deutsch', short: 'DE', emoji: '🇩🇪', speech: 'de-DE' }",
    "raw === 'de' || raw.startsWith('de-') || raw === 'german' || raw === 'deutsch'",
    '<option value="de">🇩🇪 Deutsch</option>',
    "'fr', 'en', 'zh', 'es', 'ja', 'de'",
    'de|deu|ger|de-de|de-at|de-ch',
    "sourceLang === 'de'",
]:
    assert probe in core, f'German language rail missing in Reader core: {probe}'

# ß — буква, а не пунктуация. Без неё Fuß обрезается до fu. Набор букв в
# ядре встречается дважды (обрезка краёв слова и разбиение предложения на
# слова), и обе копии обязаны знать эту букву.
assert core.count("[^a-zà-öø-ÿœæß'-]") >= 3, 'ß снова выпала из набора букв ядра'
candidates = Path('js/reader/word-candidates.js').read_text(encoding='utf-8')
assert "[^a-zà-öø-ÿœæß'-]" in candidates, 'ß выпала из набора букв в word-candidates'
assert "raw === 'de' || raw.startsWith('de-')" in candidates, \
    'немецкий снова считается французским при разборе слова'

assert "const allowed = ['fr', 'zh', 'en', 'es', 'ja', 'de'];" in app
assert "id=\"hlb-de\"" in html and "setAppLang('de')" in html

# Немецкий не проваливается во французскую цепочку.
assert "if (lang === 'de') {" in lookup
assert 'readerGermanLexicalAnalysisFor' in lookup
german_branch = lookup.index("if (lang === 'de') {")
assert german_branch < lookup.index('const quick = quickLookup('), \
    'немецкая ветка должна стоять до французского запасного пути'

for probe in [
    "import './de-vocab-data-v1.js?v=1'",
    "import './de-reader-pipeline-v1.js?v=1'",
    "import './de-context-batch-v1.js?v=1'",
    "import './de-lexical-pipeline-v1.js?v=1'",
]:
    assert probe in runtime, f'German module not loaded: {probe}'

# Озвучка: немецкий идёт голосом устройства, а не английским Kokoro.
assert "if (lang === 'de') {" in tts
assert "n === 'de'" in tts and "'de-DE'" in tts
assert tts.index("if (lang === 'de') {") < tts.index('const voiceEngine = getTtsVoiceEngine();'), \
    'немецкий обязан уйти на устройство до облачного запроса'
assert "if (!engineConf.voices[lang]) {" in functions, \
    'сервер снова подставляет английский голос вместо отказа'
assert "de: 'alloy'" in functions

# Разбор слова и абзаца по-немецки.
assert "if (lang === 'de') {" in functions
assert "if (task === 'de_context_batch') {" in functions
assert "require('./de-context-task')" in functions
assert "task: 'de_context_batch'" in batch
assert 'parts: item.parts' in batch, 'разбор составного слова не уходит в запрос'
assert 'readerGermanCaseAwareLemmaFor' in batch, 'разбор абзаца потерял регистр слова'
# Словарный тест — копия французского владельца, и он публикует свою,
# слепую к регистру, лемму под именем readerGermanLemmaFor, причём грузится
# позже подсветки. Имена обязаны быть разными, иначе немецкий молча теряет
# регистр: Stunden перестаёт находиться.
vocab_module = Path('/tmp/toc139-de-vocab-estimate.js').read_text(encoding='utf-8')
assert 'globalThis.readerGermanLemmaFor=' in vocab_module
assert 'readerGermanCaseAwareLemmaFor' not in vocab_module
assert 'globalThis.readerGermanLemmaFor' not in data_layer, \
    'слой данных снова занял имя словарного теста'

# Два источника, а не один: регистр восстановить из частотного списка нельзя.
# Строки проверяются ровно в том виде, в каком их ищет проверка собранного
# APK: склеенный из кусков путь там не найдётся, и сборка упадёт после всей
# долгой работы.
for probe in ['dereader/de_noun_lemma.tsv', 'dereader/de_vocab_lemma.tsv',
              'dereader/de_noun_gender.tsv', 'dereader/de_vocab_frequency.tsv']:
    assert probe in data_layer, f'German data layer lost a table: {probe}'
assert 'MIN_PART = 3' in data_layer and "FUGEN = ['', 's', 'es', 'n', 'en', 'er', 'e']" in data_layer, \
    'разбор составных на устройстве разошёлся со сборщиком'

# Сборщик: закреплённые версии источников и пределы.
for probe in [
    'REQUIREMENTS = ("wordfreq==3.1.1", "simplemma==2.0.0", "german-nouns==1.2.5")',
    'VOCAB_LIMIT = 60_000',
    'NAME_TAGS = ("Vorname", "Nachname", "Toponym", "Straßenname", "Eigenname")',
    # Имя отличается от обычного слова пустой таблицей склонений, а не
    # пометкой: Sonne у Викисловаря — «Eigenname», и по пометке солнце уехало
    # бы в имена вместе со своим склонением.
    'if any(tag in pos for tag in NAME_TAGS) and not forms:',
    'def fold(value: str) -> str:',
]:
    assert probe in builder, f'German builder contract missing: {probe}'
assert 'MIN_PART = 3' in builder and 'FUGEN = ("", "s", "es", "n", "en", "er", "e")' in builder

print('toc139 German source gate: PASS')
PY

# Проверка собранного APK ищет в файлах точные строки, и найти их она может
# только если они там есть буквально. Одна такая строка уже стоила полной
# сборки: путь к словарю был склеен из двух кусков, и grep не нашёл ничего.
# Поэтому каждую её строку сверяем с исходником здесь, до сборки.
python3 - <<'PYPROBE'
import re
from pathlib import Path
import yaml

workflow = yaml.safe_load(
    Path('.github/workflows/android-apk-toc139-german-reader.yml').read_text(encoding='utf-8')
)
step = next(
    s['run'] for s in workflow['jobs']['german-reader-quality']['steps']
    if 'PYCHECK' in (s.get('run') or '')
)
sources = {
    'de-vocab-data-v1.js': 'js/reader/de-vocab-data-v1.js',
    'de-reader-pipeline-v1.js': 'js/reader/de-reader-pipeline-v1.js',
    'de-lexical-pipeline-v1.js': 'js/reader/de-lexical-pipeline-v1.js',
    'de-context-batch-v1.js': 'js/reader/de-context-batch-v1.js',
    'de-vocab-estimate.js': '/tmp/toc139-de-vocab-estimate.js',
    'interactions-runtime.js': 'js/reader/interactions-runtime.js',
    'word-lookup.js': 'js/reader/word-lookup.js',
    'app.js': 'js/reader-app.js',
    'tts.js': 'js/tts.js',
}
checked = 0
for line in step.split('\n'):
    match = re.match(r'grep -qF ("[^"]*"|\'[^\']*\') "\$WORK/([^"]+)"', line.strip())
    if not match:
        continue
    needle, name = match.group(1)[1:-1], match.group(2)
    if '$' in needle or '$' in name:
        continue  # строки с подстановкой проверяются ниже, уже раскрытыми
    assert name in sources, f'проверка APK смотрит в неизвестный файл: {name}'
    text = Path(sources[name]).read_text(encoding='utf-8')
    assert needle in text, f'проверка APK ищет в {name} строку, которой там нет: {needle}'
    checked += 1
for module in ['de-vocab-data-v1', 'de-reader-pipeline-v1', 'de-context-batch-v1', 'de-lexical-pipeline-v1']:
    runtime = Path('js/reader/interactions-runtime.js').read_text(encoding='utf-8')
    assert f"import './{module}.js?v=1';" in runtime, f'модуль не импортирован: {module}'
    checked += 1
assert checked >= 12, f'сверка с проверкой APK нашла подозрительно мало строк: {checked}'
print(f'toc139 APK probe contract: PASS ({checked} строк)')
PYPROBE

echo "toc139 German Reader gate: PASS"
