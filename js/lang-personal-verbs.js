function ownerKey() {
  const owner = String((window.an2ReaderOwnerId && window.an2ReaderOwnerId()) || localStorage.getItem('an2_reader_active_owner_v1') || 'anon');
  return 'an2_personal_verbs_fr_v1::' + owner.replace(/[^a-zA-Z0-9_.-]/g, '_');
}
function currentLang() {
  return window.getAn2Language ? window.getAn2Language() : 'fr';
}
function openPersonalVerbs() {
  let items = [];
  try { items = JSON.parse(localStorage.getItem(ownerKey()) || '[]'); } catch (e) {}
  if (!Array.isArray(items) || !items.length) { alert('No personal French verbs from reading yet.'); return; }
  const text = items.map(function(item, index) {
    const meaning = item.ru ? ' - ' + item.ru : '';
    const context = item.context ? '\n  ' + item.context : '';
    return (index + 1) + '. ' + item.lemma + meaning + context;
  }).join('\n\n');
  alert('Personal French verbs from reading:\n\n' + text);
}
function addButton() {
  const bar = document.getElementById('an2-langbar');
  if (!bar) return;
  let button = document.getElementById('an2-personal-verbs-btn');
  if (!button) {
    button = document.createElement('button');
    button.id = 'an2-personal-verbs-btn';
    button.className = 'an2-langbtn';
    button.type = 'button';
    button.textContent = 'Reader verbs';
    button.addEventListener('click', openPersonalVerbs);
    bar.appendChild(button);
  }
  const next = currentLang() === 'fr' ? '' : 'none';
  if (button.style.display !== next) button.style.display = next;
}
window.addEventListener('an2:languagechange', function() { setTimeout(addButton, 0); });
setTimeout(addButton, 300);
window.showPersonalFrenchVerbs = openPersonalVerbs;
