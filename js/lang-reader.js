function shell() { return window.AN2LanguageShell; }
function currentLang() { return shell() ? shell().getLang() : 'fr'; }
function toast(message) { try { if (window.showToast) window.showToast(message); } catch (e) {} }

function filterBooks() {
  const library = document.getElementById('reader-library-list');
  if (!library) return;
  const selected = currentLang();
  let count = 0;
  library.querySelectorAll('.lib-book-card').forEach(function(card) {
    const icon = card.querySelector('.lib-book-icon');
    const text = icon ? icon.textContent : '';
    const lang = text.indexOf('\ud83c\udde8\ud83c\uddf3') >= 0 ? 'zh'
      : text.indexOf('\ud83c\uddef\ud83c\uddf5') >= 0 ? 'ja'
      : text.indexOf('\ud83c\uddec\ud83c\udde7') >= 0 ? 'en' : 'fr';
    const visible = lang === selected;
    if (card.classList.contains('an2-lang-hidden') !== !visible) card.classList.toggle('an2-lang-hidden', !visible);
    if (visible) count++;
  });
  const tab = library.querySelector('.lib-tab-btn');
  const label = 'Books (' + count + ')';
  if (tab && tab.textContent !== label) tab.textContent = label;
}

function scheduleFilter() {
  requestAnimationFrame(function() { setTimeout(filterBooks, 0); });
}

function patchReaderRender() {
  const original = window.renderReaderScreen;
  if (typeof original !== 'function' || original.__an2LangReader) return;
  const wrapped = function() {
    const result = original.apply(this, arguments);
    Promise.resolve(result).finally(scheduleFilter);
    return result;
  };
  wrapped.__an2LangReader = true;
  window.renderReaderScreen = wrapped;
}

function patchImport() {
  const original = window.showReaderImportModal;
  if (typeof original !== 'function' || original.__an2LangReader) return;
  const wrapped = function() {
    const result = original.apply(this, arguments);
    setTimeout(function() {
      const select = document.getElementById('reader-import-lang');
      if (select) select.value = currentLang();
    }, 0);
    return result;
  };
  wrapped.__an2LangReader = true;
  window.showReaderImportModal = wrapped;
}

function personalVerbKey() {
  const owner = String((window.an2ReaderOwnerId && window.an2ReaderOwnerId()) || localStorage.getItem('an2_reader_active_owner_v1') || 'anon');
  return 'an2_personal_verbs_fr_v1::' + owner.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\u2019/g, "'").trim();
}

async function saveFrenchVerb() {
  const panel = document.getElementById('reader-word-panel');
  const lemmaInput = panel ? panel.querySelector('#reader-word-lemma') : null;
  const ruInput = panel ? panel.querySelector('#reader-word-ru') : null;
  const contextInput = panel ? panel.querySelector('#reader-word-context') : null;
  const status = panel ? panel.querySelector('#reader-word-status') : null;
  const lemma = normalize(lemmaInput ? lemmaInput.value : '');
  if (!lemma) throw new Error('No infinitive found');

  const app = await import('./app.js');
  const verb = (app.VERBS || []).find(function(item) { return normalize(item.inf) === lemma; });
  if (verb) {
    const storage = await import('./storage.js');
    storage.addLearnLater(verb.id);
    if (status) { status.style.display = 'block'; status.style.color = 'var(--good)'; status.textContent = 'Saved to My plan: ' + verb.inf; }
    toast('Saved to My plan: ' + verb.inf);
    return;
  }

  let items = [];
  try { items = JSON.parse(localStorage.getItem(personalVerbKey()) || '[]'); } catch (e) {}
  if (!Array.isArray(items)) items = [];
  const record = { lemma: lemma, ru: ruInput ? ruInput.value.trim() : '', context: contextInput ? contextInput.value.trim() : '', source: 'reader', addedAt: new Date().toISOString() };
  const idx = items.findIndex(function(item) { return normalize(item.lemma) === lemma; });
  if (idx >= 0) items[idx] = Object.assign({}, items[idx], record); else items.unshift(record);
  localStorage.setItem(personalVerbKey(), JSON.stringify(items));
  if (status) { status.style.display = 'block'; status.style.color = 'var(--good)'; status.textContent = 'Saved as a personal French verb: ' + lemma; }
  toast('Saved from reading: ' + lemma);
}

function patchVerbSave() {
  const original = window.readerSaveWord;
  if (typeof original !== 'function' || original.__an2LangReader) return;
  const wrapped = async function() {
    const panel = document.getElementById('reader-word-panel');
    const posSelect = panel ? panel.querySelector('#reader-word-pos') : null;
    const view = document.getElementById('reader-reading-view');
    const readerLang = String((panel && panel.dataset.lang) || (view && view.dataset.readerLang) || currentLang()).slice(0, 2);
    if (readerLang === 'fr' && String(posSelect ? posSelect.value : '').toLowerCase() === 'verb') {
      try { await saveFrenchVerb(); } catch (error) { toast('Could not save this verb'); }
      return;
    }
    return original.apply(this, arguments);
  };
  wrapped.__an2LangReader = true;
  window.readerSaveWord = wrapped;
}

function install() {
  patchReaderRender();
  patchImport();
  patchVerbSave();
  scheduleFilter();
  window.addEventListener('an2:languagechange', scheduleFilter);
}
install();
