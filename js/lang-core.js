const LANG = {
  fr: { label: 'French', title: 'An II - French', dict: 'reader' },
  zh: { label: 'Chinese', title: 'An II - Chinese', dict: 'zh' },
  en: { label: 'English', title: 'An II - English', dict: 'reader', disabled: true }
};
const FR_ONLY = new Set(['trainer', 'phrases', 'groups', 'study', 'grammar', 'numbers']);

function getLang() {
  const value = String(globalThis.AN2_LANG || localStorage.getItem('an2_lang') || 'fr').slice(0, 2).toLowerCase();
  return LANG[value] ? value : 'fr';
}
function toast(message) { try { if (window.showToast) window.showToast(message); } catch (e) {} }
function addStyle() {
  if (document.getElementById('an2-lang-style')) return;
  const style = document.createElement('style');
  style.id = 'an2-lang-style';
  style.textContent = '#an2-langbar{display:flex;gap:6px;align-items:center;padding:7px 14px;background:var(--surface);border-bottom:1px solid var(--border);overflow-x:auto;scrollbar-width:none}.an2-langbtn{border:1px solid var(--border);background:var(--surface2);color:var(--text-muted);border-radius:999px;padding:6px 10px;font:500 .76rem/1 sans-serif;cursor:pointer;white-space:nowrap}.an2-langbtn.active{background:var(--accent);border-color:var(--accent);color:#f5ecd8}.an2-langbtn:disabled{opacity:.42;cursor:not-allowed}.an2-lang-hidden{display:none!important}';
  document.head.appendChild(style);
}
function renderBar() {
  const nav = document.querySelector('#main-app nav, nav');
  if (!nav) return;
  let bar = document.getElementById('an2-langbar');
  if (!bar) { bar = document.createElement('div'); bar.id = 'an2-langbar'; nav.insertAdjacentElement('afterend', bar); }
  const current = getLang();
  bar.innerHTML = Object.entries(LANG).map(function(pair) {
    const key = pair[0], item = pair[1];
    return '<button class="an2-langbtn ' + (key === current ? 'active' : '') + '" data-lang="' + key + '" ' + (item.disabled ? 'disabled title="English is reserved for a later release"' : '') + '>' + item.label + '</button>';
  }).join('');
  bar.querySelectorAll('[data-lang]').forEach(function(button) { button.addEventListener('click', function() { setLang(button.dataset.lang); }); });
}
function applyBoundary() {
  const current = getLang();
  document.documentElement.dataset.an2Lang = current;
  document.title = LANG[current].title;
  document.querySelectorAll('[onclick]').forEach(function(el) {
    const code = String(el.getAttribute('onclick') || '');
    const frenchOnly = Array.from(FR_ONLY).some(function(screen) { return code.includes("showScreen('" + screen + "')"); });
    if (frenchOnly) el.classList.toggle('an2-lang-hidden', current !== 'fr');
  });
  const practice = document.getElementById('bn-practice');
  if (practice) practice.classList.toggle('an2-lang-hidden', current !== 'fr');
  const frTabs = document.getElementById('dict-tabs-fr');
  const zhTabs = document.getElementById('dict-tabs-zh');
  if (frTabs) frTabs.style.display = current === 'zh' ? 'none' : '';
  if (zhTabs) zhTabs.style.display = current === 'zh' ? 'block' : 'none';
}
function patchScreens() {
  const original = window.showScreen;
  if (typeof original !== 'function' || original.__an2LangShell) return;
  const wrapped = function(screen) {
    const args = Array.prototype.slice.call(arguments, 1);
    const current = getLang();
    const target = current !== 'fr' && FR_ONLY.has(screen) ? 'reader' : screen;
    if (target !== screen) toast('This tool belongs to the French workspace.');
    const result = original.apply(this, [target].concat(args));
    setTimeout(function() {
      if (target === 'dict' && window.setDictType) window.setDictType(LANG[current].dict);
      applyBoundary();
    }, 0);
    return result;
  };
  wrapped.__an2LangShell = true;
  window.showScreen = wrapped;
}
function setLang(next) {
  const value = String(next || '').slice(0, 2).toLowerCase();
  if (!LANG[value] || LANG[value].disabled) { toast('English will be added after French and Chinese are separated.'); return; }
  localStorage.setItem('an2_lang', value);
  globalThis.AN2_LANG = value;
  renderBar();
  applyBoundary();
  try { if (window.showScreen) window.showScreen('reader'); } catch (e) {}
  window.dispatchEvent(new CustomEvent('an2:languagechange', { detail: { lang: value } }));
}

addStyle();
renderBar();
applyBoundary();
patchScreens();
window.AN2LanguageShell = { getLang: getLang, setLang: setLang, apply: applyBoundary, patchScreens: patchScreens };
window.setAn2Language = setLang;
window.getAn2Language = getLang;
