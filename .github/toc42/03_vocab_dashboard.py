from pathlib import Path

p = Path('js/reader/vocab-estimate.js')
t = p.read_text('utf-8')
marker = 'async function openVocabularyEstimate() {'
assert marker in t

dashboard = r"""function currentVocabularyStats() {
  const root = document.getElementById('reader-chapter-text');
  const unique = new Set();
  root?.querySelectorAll('.reader-word[data-word]').forEach(el => {
    if (canonicalLang(el.dataset.lang || currentLang()) !== 'zh') return;
    const word = normalizeWord(el.dataset.word || el.textContent || '', 'zh');
    if (word) unique.add(word);
  });
  const profile = loadProfile();
  const manualMap = manualKnowledgeMapSnapshot();
  let known = 0;
  let unknown = 0;
  let unclassified = 0;
  for (const word of unique) {
    const info = classificationForSnapshot(word, profile, manualMap);
    if (info.value === 'known') known += 1;
    else if (info.value === 'unknown') unknown += 1;
    else unclassified += 1;
  }
  return { total: unique.size, known, unknown, unclassified };
}

async function openVocabularyDashboard() {
  installStyles();
  const modal = ensureModal();
  modal.innerHTML = modalShell('<div class="rve-copy">Загружаю словарь…</div>', { title: 'Китайский словарь' });
  bindModalChrome(modal);
  try { await loadFrequencyData(); }
  catch (error) {
    modal.innerHTML = modalShell(`<div class="rve-copy">Не удалось загрузить частотный список: ${String(error?.message || error)}</div>`, { title: 'Китайский словарь' });
    bindModalChrome(modal);
    return;
  }

  const profile = loadProfile();
  const stats = currentVocabularyStats();
  const knownPct = stats.total ? Math.round(stats.known * 100 / stats.total) : 0;
  const unknownPct = stats.total ? Math.round(stats.unknown * 100 / stats.total) : 0;
  modal.innerHTML = modalShell(`
    <div class="rve-dashboard">
      <div class="rve-result-kicker">Measure my level</div>
      <div class="rve-number">${profile ? `≈ ${formatNumber(profile.estimate)}` : '—'}</div>
      <div class="rve-result-label">${profile ? 'оценка китайского словаря' : 'уровень ещё не измерен'}</div>
      ${profile ? `<div class="rve-known-baseline"><b>${formatNumber(profile.conservativeKnownCount)}</b><span>автоматически Known</span></div>` : ''}
      <div class="rve-stat-grid">
        <div><b>${formatNumber(stats.total)}</b><span>уникальных слов<br>в текущей главе</span></div>
        <div><b>${formatNumber(stats.known)}</b><span>Known · ${knownPct}%</span></div>
        <div><b>${formatNumber(stats.unknown)}</b><span>Unknown · ${unknownPct}%</span></div>
      </div>
      ${stats.unclassified ? `<div class="rve-rule">${formatNumber(stats.unclassified)} слов пока без классификации.</div>` : ''}
      <button class="rve-primary" data-rve-measure type="button">${profile ? 'Пройти тест заново' : 'Оценить мой уровень'}</button>
      <button class="rve-secondary" data-rve-close type="button">Вернуться к чтению</button>
    </div>`, { title: 'Китайский словарь' });
  bindModalChrome(modal);
  modal.querySelector('[data-rve-measure]')?.addEventListener('click', openVocabularyEstimate);
  modal.querySelector('[data-rve-close]')?.addEventListener('click', closeVocabularyEstimate);
}

"""
t = t.replace(marker, dashboard + marker, 1)

old = "modal.querySelector('.rve-done')?.addEventListener('click', closeVocabularyEstimate);"
assert old in t
t = t.replace(old, "modal.querySelector('.rve-done')?.addEventListener('click', openVocabularyDashboard);", 1)

p.write_text(t, 'utf-8')
