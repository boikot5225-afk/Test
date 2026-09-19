// Фоновое распознавание аудио и его индикатор.
//
// Сам конвейер (декодирование → Whisper по фрагментам → чистка DeepSeek) живёт
// в reader-app.js, который заморожен по хешу, так что этот слой не меняет его
// ни на строку: он оборачивает window.readerTranscribeAudioFile и читает ход
// работы из #reader-import-audio-status — того самого статуса, который ядро
// пишет туда само. Разбор чужой строки был бы плохой идеей, будь у ядра
// нормальное событие; событий у него нет, а DOM здесь и так общий интерфейс
// между ядром и слоями.
//
// Зачем это нужно. Статус лежал внутри окна импорта, и закрыть окно означало
// ослепнуть: работа продолжалась (промис никто не отменял), но узнать, идёт ли
// она ещё и сколько осталось, было неоткуда. А идёт она минутами — час записи
// это семь-восемь обращений к Whisper плюс чистка.
//
// Приложение, свёрнутое в Android, задачу не останавливает: MainActivity не
// переопределяет onPause и не зовёт webView.pauseTimers(), так что JS и сеть
// продолжают работать. Настоящий обрыв один — когда систему прижимает по
// памяти и процесс убивают; это переживает только отметка в localStorage, по
// которой следующий запуск честно скажет, что распознавание прервалось.

const BAR_ID = 'reader-stt-bar';
const STYLE_ID = 'reader-stt-bar-style';
const ACTIVE_KEY = 'an2_reader_stt_active_v1';

// Доли общего прогресса. Распознавание — самая долгая часть, декодирование
// быстрое, чистка где-то между. Точные значения не важны, важно чтобы полоска
// не стояла на месте полконвейера и не прыгала с 10% на 90%.
const WEIGHTS = { decode: 6, stt: 74, cleanup: 20 };

const PHASE_LABEL = {
  decode: 'Разбираю запись',
  stt: 'Распознаю речь',
  cleanup: 'Привожу текст в порядок',
};

let job = null;
let tick = null;

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function installStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${BAR_ID} {
      position: fixed; left: 12px; right: 12px; bottom: calc(12px + env(safe-area-inset-bottom, 0px));
      z-index: 1200; display: none; gap: 10px; align-items: center;
      padding: 10px 12px; border-radius: 12px;
      background: var(--surface, #1b1b1f); border: 1px solid var(--accent, #6b8afd);
      box-shadow: 0 6px 24px rgba(0,0,0,.35);
      font-size: .78rem; color: var(--text, #e8e8ea);
    }
    #${BAR_ID}[data-state="done"] { border-color: var(--good, #4caf50); cursor: pointer; }
    #${BAR_ID}[data-state="error"] { border-color: var(--bad, #e05c5c); }
    #${BAR_ID} .rd-stt-body { flex: 1; min-width: 0; }
    #${BAR_ID} .rd-stt-line {
      display: flex; justify-content: space-between; gap: 10px;
      margin-bottom: 6px; line-height: 1.3;
    }
    /* Не обрезаем: в этой строке живёт причина отказа, и ровно её и нужно
       прочитать. Обрезанное «серве…» одинаково подходит и к «сервер отвечает»,
       и к «сервер недоступен» — то есть не сообщает ничего. Разрешаем две
       строки; больше двух не нужно, тексты короткие. */
    #${BAR_ID} .rd-stt-phase {
      overflow: hidden; word-break: break-word;
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
    }
    #${BAR_ID} .rd-stt-eta { flex: none; }
    #${BAR_ID} .rd-stt-eta { color: var(--text-muted, #9a9aa2); white-space: nowrap; }
    #${BAR_ID} .rd-stt-track {
      height: 5px; border-radius: 3px; overflow: hidden;
      background: var(--surface2, #2a2a30);
    }
    #${BAR_ID} .rd-stt-fill {
      height: 100%; width: 0%; border-radius: 3px;
      background: var(--accent, #6b8afd); transition: width .3s ease;
    }
    #${BAR_ID}[data-state="done"] .rd-stt-fill { background: var(--good, #4caf50); }
    #${BAR_ID}[data-state="error"] .rd-stt-fill { background: var(--bad, #e05c5c); }
    #${BAR_ID} .rd-stt-stop {
      background: none; border: 1px solid var(--border, #3a3a42); border-radius: 8px;
      color: var(--text-muted, #9a9aa2); padding: 6px 10px; cursor: pointer; white-space: nowrap;
    }
  `;
  document.head.appendChild(style);
}

function ensureBar() {
  installStyle();
  let bar = document.getElementById(BAR_ID);
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = BAR_ID;
  bar.innerHTML = `
    <div class="rd-stt-body">
      <div class="rd-stt-line">
        <span class="rd-stt-phase"></span>
        <span class="rd-stt-eta"></span>
      </div>
      <div class="rd-stt-track"><div class="rd-stt-fill"></div></div>
    </div>
    <button type="button" class="rd-stt-stop"></button>`;
  document.body.appendChild(bar);
  bar.querySelector('.rd-stt-stop').addEventListener('click', event => {
    event.stopPropagation();
    if (!job || job.state === 'running') cancel();
    else hide();
  });
  bar.addEventListener('click', () => {
    if (job?.state !== 'done') return;
    // Снимаем обработчик до hide(): она обнуляет job, и читать его после уже
    // поздно — исключение ушло бы в catch, а окно импорта не открылось.
    const reopen = job.onReopen;
    hide();
    try { reopen?.(); } catch {}
  });
  return bar;
}

function humanTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  if (total < 60) return `${total} с`;
  const min = Math.floor(total / 60);
  const rest = total % 60;
  if (min < 60) return rest ? `${min} мин ${rest} с` : `${min} мин`;
  return `${Math.floor(min / 60)} ч ${min % 60} мин`;
}

// Сколько осталось — по замеренной скорости, а не по догадке. Пока в текущем
// этапе не закрыт ни один фрагмент, оценки нет, и мы честно ничего не пишем:
// придуманное число здесь хуже пустого места.
function remainingSeconds() {
  if (!job || job.state !== 'running') return null;
  const phase = job.phase;
  if (phase !== 'stt' && phase !== 'cleanup') return null;
  const stat = job.stats[phase];
  if (!stat.done || !stat.elapsed) return null;
  // stat.elapsed накоплен в миллисекундах — Date.now() разностями, а наружу
  // отсюда уходят секунды.
  const perUnitSeconds = stat.elapsed / stat.done / 1000;
  const left = Math.max(0, job.total - job.index);
  if (!left) return null;
  return perUnitSeconds * left;
}

// Доля выполненного. job.index — сколько единиц ЗАКРЫТО, поэтому та, что
// обрабатывается прямо сейчас, считается наполовину: иначе на записи короче
// восьми минут фрагмент всего один, и полоска стоит на месте всё распознавание
// — то есть почти всю работу, — а потом прыгает к концу. Середина единицы это
// не измерение, а честное «где-то посередине»: сколько сделано внутри одного
// обращения к Whisper, отсюда не видно вообще.
function progressPercent() {
  if (!job) return 0;
  if (job.state === 'done') return 100;
  let value = 0;
  for (const phase of ['decode', 'stt', 'cleanup']) {
    if (job.seen[phase] === 'complete') { value += WEIGHTS[phase]; continue; }
    if (job.phase !== phase) continue;
    // Общее число известно — считаем честно, засчитывая идущую единицу
    // наполовину. Неизвестно (статус до слоя не дошёл) — полоска всё равно
    // обязана двигаться с каждым фрагментом, но приближаться к концу только
    // асимптотически: обещать «почти готово», не зная, сколько осталось, хуже,
    // чем ползти.
    const share = job.total > 0
      ? clamp((job.index + 0.5) / job.total, 0, 1)
      : 1 - 1 / (job.index + 2);
    value += WEIGHTS[phase] * share;
  }
  return clamp(value, 0, 99);
}

function render() {
  const bar = ensureBar();
  if (!job) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.dataset.state = job.state;

  const phaseEl = bar.querySelector('.rd-stt-phase');
  const etaEl = bar.querySelector('.rd-stt-eta');
  const fill = bar.querySelector('.rd-stt-fill');
  const stop = bar.querySelector('.rd-stt-stop');

  if (job.state === 'running') {
    const label = PHASE_LABEL[job.phase] || 'Работаю';
    const counter = job.total > 1 ? ` · ${Math.min(job.index + 1, job.total)}/${job.total}` : '';
    // Молчаливая пауза на минуту выглядит как зависание, поэтому повтор виден.
    phaseEl.textContent = job.hidden
      ? '⏸ Приложение свёрнуто — продолжу при возврате'
      : job.offline
      ? '📵 Нет сети — жду соединения'
      : job.retrying
        ? `📶 Повтор ${job.retrying}${job.verdict ? ` · ${job.verdict}` : job.lastError ? ` · ${job.lastError}` : ''}`
        : `🎙 ${label}${counter}`;
    const eta = humanTime(remainingSeconds());
    const pct = Math.round(progressPercent());
    // Оценки может не быть вовсе: на одном фрагменте закрывать нечего, скорость
    // измерить не на чем. Тогда показываем прошедшее время — счётчик, который
    // идёт, отличает работу от зависания, а выдумывать остаток нельзя.
    // «идёт 0 с» в первые мгновения только мельтешит.
    const runningSec = (Date.now() - job.startedAt) / 1000;
    const elapsed = runningSec >= 3 ? humanTime(runningSec) : '';
    etaEl.textContent = eta
      ? `${pct}% · осталось ~${eta}`
      : (elapsed ? `${pct}% · идёт ${elapsed}` : `${pct}%`);
    fill.style.width = `${pct}%`;
    stop.textContent = '⏹';
    stop.title = 'Остановить распознавание';
  } else if (job.state === 'done') {
    phaseEl.textContent = `✅ ${job.message || 'Готово'}`;
    etaEl.textContent = 'нажми, чтобы открыть';
    fill.style.width = '100%';
    stop.textContent = '×';
  } else {
    phaseEl.textContent = job.state === 'cancelled'
      ? '⏹ Распознавание остановлено'
      : `❌ ${job.message || 'Ошибка распознавания'}`;
    etaEl.textContent = '';
    fill.style.width = '100%';
    stop.textContent = '×';
  }
}

function startTicking() {
  stopTicking();
  // Оценка времени должна сокращаться сама, а не только в момент, когда
  // закрывается очередной фрагмент: между ними проходят минуты.
  tick = setInterval(() => {
    if (job?.state !== 'running') return;
    // Наблюдатель за статусом подводил уже трижды: полоска оставалась на
    // «разбор записи» или теряла общее число фрагментов, хотя в статусе оно
    // было. Раз перерисовка и так идёт каждую секунду, пусть она перечитывает
    // статус сама — тогда пропущенное изменение стоит секунды, а не всего
    // показа. Читать текст дешевле, чем разбираться, почему MutationObserver
    // на устройстве иногда молчит.
    try { applyStatus(watchedStatusEl?.textContent); } catch {}
    // Сторож висящего запроса. Таймеры в свёрнутом приложении душатся, но тогда
    // сработает возврат к приложению; здесь мы ловим случай, когда человек
    // смотрит на экран, а запрос давно мёртв.
    abortIfStalled(currentAttempt, HARD_MS);
    render();
  }, 1000);
}

function stopTicking() { if (tick) { clearInterval(tick); tick = null; } }

function markActive(active) {
  try {
    if (active) localStorage.setItem(ACTIVE_KEY, String(Date.now()));
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {}
}

function start({ onCancel, onReopen } = {}) {
  job = {
    state: 'running',
    phase: 'decode',
    index: 0,
    total: 0,
    message: '',
    onCancel,
    onReopen,
    seen: {},
    retrying: 0,
    offline: false,
    hidden: false,
    lastError: '',
    verdict: '',
    startedAt: Date.now(),
    stats: { stt: { done: 0, elapsed: 0 }, cleanup: { done: 0, elapsed: 0 } },
    unitStartedAt: Date.now(),
  };
  markActive(true);
  startTicking();
  render();
}

// Конвейер зовёт это перед каждой единицей работы: фрагментом для Whisper,
// куском текста для DeepSeek. index — сколько уже закрыто, не номер текущего.
// total передаётся только тогда, когда он действительно известен — то есть из
// строки статуса. Вызовы, порождённые самими запросами, его не трогают, чтобы
// не затирать настоящее число фрагментов выдуманным.
function step(phase, { index = 0, total = null } = {}) {
  if (!job || job.state !== 'running') return;
  const now = Date.now();
  if (job.phase !== phase) {
    if (job.phase) job.seen[job.phase] = 'complete';
    job.phase = phase;
    job.unitStartedAt = now;
  } else if (index > job.index) {
    const stat = job.stats[phase];
    if (stat) {
      stat.elapsed += now - job.unitStartedAt;
      stat.done += index - job.index;
    }
    job.unitStartedAt = now;
  }
  job.index = index;
  if (total !== null) job.total = total;
  render();
}

function done(message) {
  if (!job) return;
  job.state = 'done';
  job.message = message || 'Готово';
  markActive(false);
  stopTicking();
  render();
}

function fail(message) {
  if (!job) return;
  job.state = 'error';
  job.message = message || 'Ошибка распознавания';
  markActive(false);
  stopTicking();
  render();
}

function cancel() {
  if (!job) return;
  try { job.onCancel?.(); } catch {}
  job.state = 'cancelled';
  markActive(false);
  stopTicking();
  render();
}

function hide() {
  job = null;
  markActive(false);
  stopTicking();
  const bar = document.getElementById(BAR_ID);
  if (bar) bar.style.display = 'none';
}

// Процесс могли убить по памяти, пока приложение было свёрнуто. Промис вместе с
// ним умер, и молчать об этом нельзя: человек ждёт текст, которого не будет.
function reportInterrupted() {
  let stamp = '';
  try { stamp = localStorage.getItem(ACTIVE_KEY) || ''; } catch {}
  if (!stamp) return;
  markActive(false);
  job = {
    state: 'error',
    phase: '',
    index: 0,
    total: 0,
    message: 'Распознавание прервалось — приложение закрыли. Запусти заново.',
    seen: {},
    stats: { stt: { done: 0, elapsed: 0 }, cleanup: { done: 0, elapsed: 0 } },
    unitStartedAt: Date.now(),
  };
  render();
}

// Ядро пишет в статус человеческие строки; других сигналов у него нет.
// Каждая ветка ниже — ровно одна строка из readerTranscribeBlob.
function readStatus(text) {
  const value = String(text || '');
  if (!value) return null;

  let m = value.match(/Распознаю фрагмент\s+(\d+)\s*\/\s*(\d+)/);
  if (m) return { kind: 'step', phase: 'stt', index: Number(m[1]) - 1, total: Number(m[2]) };

  m = value.match(/чистит текст\D+(\d+)\s*\/\s*(\d+)/);
  if (m) return { kind: 'step', phase: 'cleanup', index: Number(m[1]) - 1, total: Number(m[2]) };

  if (/Разбираю аудио|Извлекаю звук|Файл очень большой/.test(value)) {
    return { kind: 'step', phase: 'decode', index: 0, total: 0 };
  }
  if (value.startsWith('✅')) return { kind: 'done', message: 'Текст распознан' };
  if (value.startsWith('⏹')) return { kind: 'cancelled' };
  if (value.startsWith('❌')) return { kind: 'fail', message: value.replace(/^❌\s*/, '') };
  if (value.startsWith('⚠')) return null;
  return null;
}

function applyStatus(text) {
  const parsed = readStatus(text);
  if (!parsed || !job) return;
  if (parsed.kind === 'step') step(parsed.phase, { index: parsed.index, total: parsed.total });
  else if (parsed.kind === 'done') done(parsed.message);
  else if (parsed.kind === 'fail') fail(parsed.message);
  else if (parsed.kind === 'cancelled' && job.state === 'running') {
    job.state = 'cancelled';
    markActive(false);
    stopTicking();
    render();
  }
}

// Элемент статуса создаётся вместе с модалкой и переживает её закрытие, но к
// моменту загрузки модуля его ещё нет — поэтому наблюдаем за body и цепляемся,
// как только он появится.
let statusObserver = null;
let watchedStatusEl = null;

function watchStatus() {
  if (typeof MutationObserver === 'undefined') return;
  const el = document.getElementById('reader-import-audio-status');
  if (!el || el === watchedStatusEl) return;
  statusObserver?.disconnect();
  watchedStatusEl = el;
  statusObserver = new MutationObserver(() => applyStatus(el.textContent));
  statusObserver.observe(el, { childList: true, characterData: true, subtree: true });
  applyStatus(el.textContent);
}

function installStatusWatch() {
  if (typeof MutationObserver === 'undefined') return;
  watchStatus();
  new MutationObserver(watchStatus).observe(document.body, { childList: true, subtree: true });
}

// Свёрнутое приложение роняет запрос на полпути: Android переводит сеть, Wi-Fi
// уступает мобильной, сокет закрывается — и fetch падает с TypeError «Failed to
// fetch». Ядро считает это концом работы и теряет весь час распознавания из-за
// одной просевшей секунды. Для фонового режима это и есть главный дефект.
//
// Ядро заморожено, но fetch — наш. Повтор здесь узкий намеренно: только POST на
// transcribeAudio, только сетевой сбой (HTTP-ошибку ядро разбирает само и
// показывает осмысленно), и никогда после отмены. Запрос на распознавание
// фрагмента не имеет побочных эффектов, повторять его безопасно.
// Повтор слепым быть не должен. При сворачивании приложения Wi-Fi уступает
// мобильной сети, и какое-то время её нет вообще — фиксированные задержки в
// этот момент просто сгорают в пустоту, после чего слой сдаётся, хотя связь
// вот-вот вернётся. Поэтому: пока устройство сообщает, что сети нет, ждём
// события online и попытку не тратим.
//
// Потолок задержки, а не список: отдавать через минуту то, ради чего затевался
// фоновый режим, бессмысленно — у человека есть «Стоп». Ограничение на число
// попыток всё же есть: каждая заново заливает фрагмент целиком (ядро режет
// запись по восемь минут, это около 20 МБ base64 на кусок), и бесконечно
// жечь мобильный трафик нельзя.
const RETRY_DELAYS_MS = [2000, 5000, 12000, 30000, 30000, 30000, 60000, 60000];
const OFFLINE_WAIT_MS = 15 * 60 * 1000;

function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

// navigator.onLine в Android WebView почти всегда возвращает true, даже когда
// радио уже отдано другой сети. Опираться на него нельзя — и именно поэтому
// ожидание сети ни разу не срабатывало у пользователя: попытки сгорали в
// свёрнутом приложении против мёртвого соединения, по пятнадцать секунд каждая,
// и к возвращению человека бюджет повторов был исчерпан.
//
// Свёрнутость видна достоверно: document.hidden. Пока приложение свёрнуто,
// пробовать не перестаём — сеть может и работать, — но неудачи бюджета не
// тратят. Возврат к приложению повторяет немедленно, не досиживая паузу.
function isHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

// Пауза, которую прерывает возвращение к приложению.
function waitOrWake(ms) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      globalThis.removeEventListener?.('online', finish);
      resolve();
    };
    const onVisible = () => { if (!isHidden()) finish(); };
    const timer = setTimeout(finish, ms);
    document.addEventListener('visibilitychange', onVisible);
    globalThis.addEventListener?.('online', finish);
  });
}

// Ждём, пока устройство само скажет, что сеть вернулась. Потолок — чтобы
// зависший навсегда навигатор не оставил задачу висеть без единого признака.
function waitForNetwork() {
  return new Promise(resolve => {
    if (!isOffline()) { resolve(); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      globalThis.removeEventListener?.('online', finish);
      resolve();
    };
    const timer = setTimeout(finish, OFFLINE_WAIT_MS);
    globalThis.addEventListener?.('online', finish);
  });
}

function requestUrl(input) {
  try { return typeof input === 'string' ? input : input?.url || ''; }
  catch { return ''; }
}

function isTranscribeRequest(input) {
  return requestUrl(input).includes('/transcribeAudio');
}

// Этап берётся из самой работы, а не из строки статуса. Разбор чужого текста
// дважды подвёл на устройстве: полоска оставалась на «разбор записи», пока ядро
// уже распознавало. Запрос на transcribeAudio — это по определению распознавание
// очередного фрагмента, и видно его здесь напрямую, без посредника.
//
// Строка статуса всё ещё полезна: только из неё известно, сколько всего
// фрагментов («1/7»), и только она сообщает об успехе и ошибке. Но двигать
// полоску теперь её обязанность не единственная.
function noteRequestPhase(input) {
  if (!job || job.state !== 'running') return;
  if (!isTranscribeRequest(input)) return;
  // Сколько всего фрагментов, знает только строка статуса («1/7»); по запросам
  // это не восстановить, и выдумывать нельзя — один запрос из семи иначе даёт
  // 80%. Поэтому отсюда идут этап и номер, а общее число остаётся за статусом.
  step('stt', { index: job.phase === 'stt' ? job.index : 0 });
}

// Фрагмент ушёл целиком — можно засчитать его закрытым, не дожидаясь, пока
// ядро напишет про следующий.
function noteRequestDone(input) {
  if (!job || job.state !== 'running' || job.phase !== 'stt') return;
  if (!isTranscribeRequest(input)) return;
  step('stt', { index: job.index + 1 });
}

// Firebase ID token живёт час, а ядро берёт его один раз перед циклом по
// фрагментам (reader-app.js, getIdToken(false) до `for`) и подписывает им все
// запросы. Запись, которая обрабатывается дольше часа, на середине начинает
// получать 401 «Firebase ID token has expired» — и вся работа пропадает.
// Именно это и стояло за обрывами: пропуск протухал прямо посреди дела.
//
// Ядро трогать не нужно: подпись живёт в заголовке, а заголовок проходит через
// этот слой. На 401 берём свежий токен принудительно и повторяем тот же запрос.
const AUTH_RETRY_LIMIT = 2;

async function withFreshToken(init) {
  const user = globalThis.firebase?.auth?.()?.currentUser;
  if (!user?.getIdToken) return null;
  let token = '';
  try { token = await user.getIdToken(true); } catch { return null; }
  if (!token) return null;
  const next = { ...(init || {}) };
  // Заголовки могут прийти и объектом, и Headers — ядро шлёт объект, но
  // полагаться на это нельзя.
  if (init?.headers instanceof Headers) {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    next.headers = headers;
  } else {
    next.headers = { ...(init?.headers || {}), Authorization: `Bearer ${token}` };
  }
  return next;
}

// «Failed to fetch» не говорит ничего: так браузер сообщает и об оборванном
// сокете, и о запрете CORS, и об упавшем контейнере, и о запросе, который не
// приняли целиком. Поэтому когда попытки кончились, слой спрашивает сам:
// отправляет на тот же адрес с той же подписью заведомо крошечный запрос.
//
// Ответ разделяет пространство ошибок пополам. Маленький запрос проходит (пусть
// даже с осмысленной ошибкой в ответе) — значит адрес, сеть и пропуск в порядке,
// и не проходит именно объём. Маленький тоже падает — значит дело не в объёме, и
// чинить надо доступ к серверу. Без этого различения я снова буду угадывать.
async function probeEndpoint(input, init) {
  const url = requestUrl(input);
  if (!url) return '';
  try {
    const response = await globalThis.fetch.__sttOriginal.call(globalThis, url, {
      method: 'POST',
      headers: init?.headers instanceof Headers
        ? init.headers
        : { ...(init?.headers || {}) },
      // Тело заведомо негодное, но крошечное: нас интересует, доходит ли запрос
      // до сервера вообще, а не результат распознавания.
      body: JSON.stringify({ audioBase64: '', format: 'wav', lang: 'probe' }),
    });
    return `сервер отвечает (${response.status}) — не проходит объём`;
  } catch (error) {
    return `сервер недоступен: ${String(error?.message || error).slice(0, 40)}`;
  }
}

// Запрос, повисший на восемнадцать минут, — это не медленная сеть, это
// мёртвое соединение, о котором никто не сообщил. В ядре на этот случай есть
// свой обрыв по таймеру (85 секунд), но в свёрнутом приложении Chromium душит
// таймеры, и setTimeout на 85 секунд просто не срабатывает вовремя. Пока
// человек не вернётся, никто ничего не обрывает — и не вернётся ничего.
//
// Поэтому обрыв здесь привязан к событию, а не к таймеру: возвращение к
// приложению будит страницу гарантированно. Если к этому моменту попытка висит
// дольше STALL_MS, она мертва — обрываем и повторяем немедленно, уже на живой
// сети. Именно возврат человека и есть тот момент, когда повтор имеет смысл.
// Возврат к приложению: запрос, проживший больше минуты, почти наверняка умер
// вместе с той сетью, которую Android отдал при сворачивании. Перезалить кусок
// дешевле, чем ждать, пока система через восемнадцать минут признает сокет
// мёртвым.
const STALL_MS = 60000;
// Потолок для любого состояния. Функция на сервере сама отваливается по своему
// таймауту в 180 секунд, так что живой ответ после четырёх минут невозможен —
// это висящий сокет, о котором никто не сообщит. У самого запроса на
// распознавание никакого таймаута в ядре нет вовсе: единственный сигнал там —
// кнопка «Стоп». Отсюда и наблюдавшиеся 1088 секунд на одной попытке.
const HARD_MS = 240000;

let currentAttempt = null;

function abortIfStalled(state, limit = STALL_MS) {
  if (!state || !state.running || state.stalled) return;
  if (Date.now() - state.startedAt < limit) return;
  state.stalled = true;
  try { state.controller?.abort(); } catch {}
}

// Свой контроллер на попытку, сцепленный с отменой от ядра: различать «человек
// нажал Стоп» и «мы сами прибили зависший запрос» обязательно, иначе второе
// выглядит как первое и повтора не будет.
function attemptOptions(options, state) {
  if (typeof AbortController === 'undefined') return options;
  state.controller = new AbortController();
  const outer = options?.signal;
  if (outer) {
    if (outer.aborted) state.controller.abort();
    else outer.addEventListener('abort', () => { try { state.controller.abort(); } catch {} }, { once: true });
  }
  return { ...(options || {}), signal: state.controller.signal };
}

function installFetchRetry() {
  const original = globalThis.fetch;
  if (typeof original !== 'function' || original.__sttRetryV1) return;
  const wrapped = async function sttRetryingFetch(input, init) {
    if (!job || job.state !== 'running' || !isTranscribeRequest(input)) {
      return original.call(this, input, init);
    }
    noteRequestPhase(input);
    let lastError = null;
    let options = init;
    let authRetries = 0;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      // Сколько запрос продержался до отказа — это разные болезни: отлуп за
      // секунду (адрес, подпись, запрет) и обрыв на минуте (объём, канал)
      // выглядят одинаково как «Failed to fetch».
      const attemptStarted = Date.now();
      const state = { running: true, stalled: false, startedAt: attemptStarted, controller: null };
      currentAttempt = state;
      const wake = () => { if (!isHidden()) abortIfStalled(state); };
      document.addEventListener('visibilitychange', wake);
      const releaseWake = () => {
        state.running = false;
        if (currentAttempt === state) currentAttempt = null;
        document.removeEventListener('visibilitychange', wake);
      };
      try {
        const response = await original.call(this, input, attemptOptions(options, state));
        releaseWake();
        // Протухший пропуск — не отказ в доступе, а истёкший час. Обновляем и
        // повторяем, не тратя на это попытки, отведённые обрывам связи.
        if ((response.status === 401 || response.status === 403) && authRetries < AUTH_RETRY_LIMIT) {
          const refreshed = await withFreshToken(options);
          if (refreshed) {
            authRetries += 1;
            options = refreshed;
            if (job) { job.lastError = 'обновляю пропуск'; render(); }
            continue;
          }
        }
        if (job?.retrying) { job.retrying = 0; job.lastError = ''; render(); }
        noteRequestDone(input);
        return response;
      } catch (error) {
        releaseWake();
        // Мы сами прибили зависший запрос — это повод повторить немедленно.
        if (state.stalled && !init?.signal?.aborted) {
          lastError = new Error(`соединение зависло (${Math.round((Date.now() - attemptStarted) / 1000)} с)`);
          if (job?.state === 'running') {
            job.lastError = 'соединение зависло — обрываю и повторяю';
            job.verdict = '';
            job.retrying = Math.max(job.retrying, 1);
            render();
          }
          attempt -= 1;
          continue;
        }
        // Отмена пользователем — не сбой связи, повторять нечего.
        if (error?.name === 'AbortError' || init?.signal?.aborted) throw error;
        // HTTP-ответ сюда не попадает: fetch отвергает промис только на сетевом
        // уровне. Значит это именно обрыв, и он переживается повтором.
        lastError = error;
        // Неудача в свёрнутом приложении бюджета не тратит: почти наверняка это
        // Android забрал сеть, а не сервер отказал. Иначе одно сворачивание
        // съедает все попытки, и работа умирает к возвращению человека.
        if (isHidden() && job?.state === 'running') {
          job.hidden = true;
          job.retrying = Math.max(job.retrying, 1);
          render();
          await waitOrWake(20000);
          job.hidden = isHidden();
          render();
          attempt -= 1;
          continue;
        }
        job.hidden = false;
        if (attempt === RETRY_DELAYS_MS.length || !job || job.state !== 'running') break;
        job.retrying = attempt + 1;
        const heldSec = Math.round((Date.now() - attemptStarted) / 1000);
        job.lastError = `${String(error?.message || error || '').slice(0, 60)} (${heldSec} с)`;
        // Спрашиваем сервер сразу после второго отказа, а не в конце всех
        // повторов: ждать вердикта четыре минуты бессмысленно, а знать, в чём
        // дело, нужно с первых секунд — и человеку, и мне.
        if (attempt === 1 && !job.verdict) {
          job.verdict = await probeEndpoint(input, options);
          render();
        }
        if (isOffline()) {
          // Сети нет — ждём её, а не отсчитываем попытки в пустоту.
          job.offline = true;
          render();
          await waitForNetwork();
          job.offline = false;
          render();
          attempt -= 1; // ожидание сети попыткой не считается
          continue;
        }
        render();
        // Паузу прерывает возвращение к приложению: ждать полминуты, когда
        // человек уже смотрит на экран и сеть вернулась, незачем.
        await waitOrWake(RETRY_DELAYS_MS[attempt]);
        // Пока ждали, час мог истечь — идём дальше с обновлённым пропуском,
        // если он вообще доступен.
        const refreshed = await withFreshToken(options);
        if (refreshed) options = refreshed;
      }
    }
    // Попытки кончились. Ядро сейчас покажет свою ошибку в статусе, но она
    // теряется за закрытым окном импорта, а полоска без причины бесполезна.
    if (job?.state === 'running') {
      job.retrying = 0;
      const verdict = job.verdict || await probeEndpoint(input, options);
      fail(`${job.lastError || 'обрыв соединения'}${verdict ? ` · ${verdict}` : ''}`);
    }
    throw lastError;
  };
  wrapped.__sttRetryV1 = true;
  // Проба ходит мимо обёртки: повторять её бессмысленно, а рекурсия вредна.
  wrapped.__sttOriginal = original;
  globalThis.fetch = wrapped;
}

// Ядро экспортирует обработчик в window, поэтому начало и конец работы видно
// без единой правки в нём.
function installWrapper() {
  const original = globalThis.readerTranscribeAudioFile;
  if (typeof original !== 'function' || original.__sttBackgroundV1) return false;
  const wrapped = async function readerTranscribeAudioFileWithIndicator(event, ...rest) {
    // Язык не выбран — ядро откажется и напишет предупреждение, задачи нет.
    const langChosen = !!document.getElementById('reader-import-lang')?.value;
    const hasFile = !!event?.target?.files?.[0];
    if (hasFile && langChosen) {
      watchStatus();
      start({
        onCancel: () => { try { globalThis.readerCancelTranscription?.(); } catch {} },
        onReopen: () => { try { globalThis.showReaderImportModal?.(); } catch {} },
      });
    }
    try {
      return await original.call(this, event, ...rest);
    } finally {
      // Ядро уже написало в статус итог, и наблюдатель его разобрал. Здесь
      // только страховка на случай, если строка оказалась незнакомой: висящая
      // навсегда полоска «идёт распознавание» хуже, чем её отсутствие.
      if (job?.state === 'running') done('Текст распознан');
    }
  };
  wrapped.__sttBackgroundV1 = true;
  globalThis.readerTranscribeAudioFile = wrapped;
  return true;
}

function install() {
  installFetchRetry();
  installStatusWatch();
  if (installWrapper()) return;
  // reader-app.js мог ещё не успеть выставить обработчик в window.
  let attempts = 0;
  const timer = setInterval(() => {
    if (installWrapper() || ++attempts > 40) clearInterval(timer);
  }, 250);
}

if (typeof window !== 'undefined') {
  globalThis.readerSttJob = { start, step, done, fail, cancel, hide };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reportInterrupted, { once: true });
  } else {
    reportInterrupted();
  }
}

export { start, step, done, fail, cancel, hide, humanTime, readStatus, WEIGHTS };
