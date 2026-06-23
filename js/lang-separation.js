const AN2_LANGS = { fr: 'French', zh: 'Chinese' };
function activeLanguage() { return 'fr'; }
function renderBar() {
  const nav = document.querySelector('nav');
  if (!nav) return;
  let bar = document.getElementById('an2-langbar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'an2-langbar';
    nav.insertAdjacentElement('afterend', bar);
  }
  bar.innerHTML = '<button>French</button><button>Chinese</button>';
}
renderBar();
