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
    #${BAR_ID} .rd-stt-phase { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
    const share = job.total > 0
      ? clamp((job.index + 0.5) / job.total, 0, 1)
      : 0.5; // этап без счётчика (разбор записи) — тоже в работе, а не в нуле
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
    phaseEl.textContent = job.retrying
      ? `📶 Связь оборвалась, повторяю (${job.retrying})${counter}`
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
  tick = setInterval(() => { if (job?.state === 'running') render(); }, 1000);
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
function step(phase, { index = 0, total = 0 } = {}) {
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
  job.total = total;
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
const RETRY_DELAYS_MS = [2000, 5000, 12000, 30000];

function isTranscribeRequest(input) {
  try {
    const url = typeof input === 'string' ? input : input?.url || '';
    return url.includes('/transcribeAudio');
  } catch { return false; }
}

function installFetchRetry() {
  const original = globalThis.fetch;
  if (typeof original !== 'function' || original.__sttRetryV1) return;
  const wrapped = async function sttRetryingFetch(input, init) {
    if (!job || job.state !== 'running' || !isTranscribeRequest(input)) {
      return original.call(this, input, init);
    }
    let lastError = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const response = await original.call(this, input, init);
        if (job?.retrying) { job.retrying = 0; render(); }
        return response;
      } catch (error) {
        // Отмена пользователем — не сбой связи, повторять нечего.
        if (error?.name === 'AbortError' || init?.signal?.aborted) throw error;
        // HTTP-ответ сюда не попадает: fetch отвергает промис только на сетевом
        // уровне. Значит это именно обрыв, и он переживается повтором.
        lastError = error;
        if (attempt === RETRY_DELAYS_MS.length || !job || job.state !== 'running') break;
        job.retrying = attempt + 1;
        render();
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
      }
    }
    throw lastError;
  };
  wrapped.__sttRetryV1 = true;
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
