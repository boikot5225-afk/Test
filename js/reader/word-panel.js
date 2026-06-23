// Reader word-panel UI.
// It owns DOM construction and presentation only.
// Lookup, saving, DeepSeek calls and word-state changes remain in app.js.

export function createReaderWordPanel({
  escape,
  canonicalLang,
  currentLang,
  extractPinyin,
  getSelectedWord,
}) {
  function ensure() {
    let panel = document.getElementById('reader-word-panel');
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'reader-word-panel';
    panel.className = 'reader-word-panel';
    panel.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:10px">
        <div><div id="reader-word-title" style="font-family:'Playfair Display',serif;font-size:1.35rem;font-style:italic;color:var(--accent)">—</div><div id="reader-word-known" style="font-size:.76rem;color:var(--text-muted)"></div></div>
        <button onclick="readerCloseWordPanel()" style="background:none;border:none;color:var(--text-muted);font-size:1.35rem;cursor:pointer">×</button>
      </div>
      <div id="reader-word-status" style="display:none;font-size:.78rem;margin-bottom:8px;padding:8px;border-radius:8px;background:var(--surface2)"></div>
      <div id="reader-word-analysis" class="reader-word-analysis"><div class="reader-word-loading">⏳ Разбираю слово...</div></div>
      <details class="reader-word-edit" style="margin:10px 0">
        <summary style="cursor:pointer;font-size:.78rem;color:var(--text-muted);user-select:none">ручная правка</summary>
        <div style="display:grid;grid-template-columns:1fr 104px 88px;gap:8px;margin:8px 0">
          <input id="reader-word-lemma" placeholder="словарная форма">
          <select id="reader-word-pos"><option value="noun">сущ.</option><option value="verb">глагол</option><option value="adjective">прил.</option><option value="adverb">нареч.</option><option value="preposition">предлог</option><option value="pronoun">мест.</option><option value="other">другое</option></select>
          <select id="reader-word-level"><option>A1</option><option selected>A2</option><option>B1</option><option>B2</option></select>
        </div>
        <div style="display:grid;grid-template-columns:1fr 88px;gap:8px;margin-bottom:8px">
          <input id="reader-word-ru" placeholder="перевод по-русски">
          <select id="reader-word-gender"><option value="m">m</option><option value="f">f</option><option value="">без рода</option></select>
        </div>
        <textarea id="reader-word-context" rows="2" placeholder="контекст-предложение" style="width:100%;box-sizing:border-box;padding:10px 11px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;color:var(--text);font-family:'IBM Plex Sans',sans-serif;resize:vertical;max-height:120px"></textarea>
      </details>
      <div class="reader-word-actions">
        <button onclick="readerSpeakSelectedWord()" class="btn btn-secondary">🔊 слово</button>
        <button onclick="readerSpeakSelectedContext()" class="btn btn-secondary">🔊 контекст</button>
        <button onclick="readerTranslateWordAI(true)" class="btn btn-secondary">↻ DeepSeek</button>
        <button id="reader-word-save-btn" onclick="readerSaveWord()" class="btn btn-primary">＋ Сохранить</button>
        <button onclick="readerMarkSelectedWordProblem()" class="btn btn-secondary">⚠ проблема</button>
        <button onclick="readerSendParagraphToPhrase(readerSelectedParagraphIndex)" class="btn btn-secondary">＋ фраза</button>
        <button onclick="readerMarkSelectedWordKnown()" class="btn btn-secondary">✓ знаю</button>
      </div>`;

    const root = document.getElementById('reader-reading-view') || document.body;
    root.appendChild(panel);
    return panel;
  }

  function simplifyPos(pos) {
    const value = String(pos || '').toLowerCase();
    if (['verb', 'verbe'].includes(value)) return 'verb';
    if (['noun', 'nom', 'substantive', 'substantif'].includes(value)) return 'noun';
    if (['adjective', 'adjectif', 'adj'].includes(value)) return 'adjective';
    if (['adverb', 'adverbe', 'adv'].includes(value)) return 'adverb';
    if (['preposition', 'préposition', 'prep'].includes(value)) return 'preposition';
    if (['pronoun', 'pronom'].includes(value)) return 'pronoun';
    return value || 'other';
  }

  function posRu(pos) {
    return {
      noun: 'существительное',
      verb: 'глагол',
      adjective: 'прилагательное',
      adverb: 'наречие',
      preposition: 'предлог',
      pronoun: 'местоимение',
      particle: 'частица',
      measure_word: 'счётное слово',
      classifier: 'счётное слово',
      proper_noun: 'имя собственное',
      name: 'имя собственное',
      other: 'другое',
    }[simplifyPos(pos)] || 'другое';
  }

  function setFields(data = {}) {
    const panel = ensure();
    const pos = simplifyPos(data.pos || data.type || (data.infinitive || data.inf ? 'verb' : 'noun'));
    const selectedWord = getSelectedWord?.() || '';
    const lemma = data.lemma || data.infinitive || data.inf || data.fr || data.word || selectedWord;
    const ru = data.ru || data.translations || data.meaning || data.translation || data.suggestion || '';
    const gender = pos === 'noun' ? (data.gender || '') : '';
    const level = data.level || 'A2';

    panel.querySelector('#reader-word-lemma').value = lemma || selectedWord;
    panel.querySelector('#reader-word-pos').value = ['noun', 'verb', 'adjective', 'adverb', 'preposition', 'pronoun'].includes(pos) ? pos : 'other';
    panel.querySelector('#reader-word-ru').value = ru;
    panel.querySelector('#reader-word-gender').value = gender;
    panel.querySelector('#reader-word-level').value = level;
    return { pos, lemma, ru, gender, level };
  }

  function renderAnalysis(data = {}, source = '') {
    const panel = ensure();
    const box = panel.querySelector('#reader-word-analysis');
    const known = panel.querySelector('#reader-word-known');
    const saveButton = panel.querySelector('#reader-word-save-btn');
    const filled = setFields(data);
    const selectedWord = getSelectedWord?.() || '';
    const form = selectedWord || data.surface || data.word || '';
    const lemma = filled.lemma || form;
    const ru = filled.ru || '—';
    const formInfo = data.form_note || data.form || data.tense || data.tense_hint || data.note || '';
    const person = data.person ? ` · ${data.person}` : '';
    const number = data.number ? ` · ${data.number}` : '';
    const lang = canonicalLang(data.lang || currentLang());
    const isChinese = lang === 'zh';
    const isVerb = filled.pos === 'verb';
    const isNoun = filled.pos === 'noun';
    const pinyin = isChinese ? (extractPinyin(data) || String(data.form_note || '').trim()) : '';
    const zhNote = isChinese ? String(data.note || data.form_note || '').trim() : '';

    if (known) {
      known.textContent = source === 'local'
        ? 'найдено в твоей базе'
        : source === 'deepseek'
          ? 'разобрано через DeepSeek'
          : 'готово';
    }
    if (saveButton) saveButton.textContent = isChinese ? '＋ В китайский словарь' : (isVerb ? '＋ Добавить глагол' : '＋ В словарь');
    if (!box) return;

    if (isChinese) {
      const lemmaLine = lemma && lemma !== form ? `<div class="reader-analysis-meta">словарная форма: ${escape(lemma)}</div>` : '';
      box.innerHTML = `
        <div class="reader-analysis-card zh">
          <div class="reader-analysis-kicker">${escape(posRu(filled.pos))} · китайский</div>
          <div class="reader-analysis-main zh-main"><b>${escape(form)}</b></div>
          ${pinyin ? `<div class="reader-analysis-pinyin">${escape(pinyin)}</div>` : `<div class="reader-analysis-pinyin muted">пиньинь не пришёл — нажми ↻ DeepSeek</div>`}
          <div class="reader-analysis-ru">${escape(ru)}</div>
          ${lemmaLine}
          <div class="reader-analysis-meta">${escape(filled.level)}${zhNote && zhNote !== pinyin ? ' · ' + escape(zhNote) : ''}</div>
        </div>`;
      return;
    }

    if (isVerb) {
      box.innerHTML = `
        <div class="reader-analysis-card verb">
          <div class="reader-analysis-kicker">глагольная форма</div>
          <div class="reader-analysis-main"><span>${escape(form)}</span> → <b>${escape(lemma)}</b></div>
          <div class="reader-analysis-ru">${escape(ru)}</div>
          <div class="reader-analysis-meta">${escape(formInfo || 'форма глагола')}${escape(person)}${escape(number)} · ${escape(filled.level)}</div>
        </div>`;
      return;
    }

    if (isNoun) {
      box.innerHTML = `
        <div class="reader-analysis-card noun">
          <div class="reader-analysis-kicker">существительное</div>
          <div class="reader-analysis-main"><b>${escape(lemma)}</b>${filled.gender ? ` <span class="reader-gender-chip">${escape(filled.gender)}</span>` : ''}</div>
          <div class="reader-analysis-ru">${escape(ru)}</div>
          <div class="reader-analysis-meta">${filled.gender ? `род: ${escape(filled.gender)} · ` : ''}${escape(filled.level)}</div>
        </div>`;
      return;
    }

    box.innerHTML = `
      <div class="reader-analysis-card other">
        <div class="reader-analysis-kicker">${escape(posRu(filled.pos))}</div>
        <div class="reader-analysis-main"><b>${escape(lemma)}</b></div>
        <div class="reader-analysis-ru">${escape(ru)}</div>
        <div class="reader-analysis-meta">${escape(filled.level)}${formInfo ? ' · ' + escape(formInfo) : ''}</div>
      </div>`;
  }

  function renderLoading(message = '⏳ DeepSeek разбирает слово...') {
    const box = ensure().querySelector('#reader-word-analysis');
    if (box) box.innerHTML = `<div class="reader-word-loading">${escape(message)}</div>`;
  }

  function renderError(message) {
    const box = ensure().querySelector('#reader-word-analysis');
    if (box) box.innerHTML = `<div class="reader-word-error">❌ ${escape(message)}</div>`;
  }

  return { ensure, simplifyPos, posRu, setFields, renderAnalysis, renderLoading, renderError };
}
