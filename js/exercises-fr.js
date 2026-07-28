// ════════════════════════════════════════════════
// exercises-fr.js — NOUNS, PREPS, PHRASES AI, STUDY tense
// ════════════════════════════════════════════════

import { todayStr, showToast, escapeAttr, normalizeImportKey } from './utils.js';
import { sb, fetchWithTimeout, LONG_REQUEST_TIMEOUT_MS, SUPABASE_URL, SUPABASE_KEY } from './supabase.js';
import { NOUNS, NOUNS_LOADED, setNounsLoaded } from './state.js';
import { loadStats, saveStats } from './storage.js';
import { speak } from './tts.js';
import { nextPhrase as phrasesNextPhrase, phSelectedVerbs } from './phrases.js';
import { getLearnVerb } from './study.js';

// Callbacks for VERBS/PHRASES — set by app.js to avoid circular dependency
let _getVerbs = () => [];
let _getPhrases = () => [];
export function initExercisesState(getVerbs, getPhrases) {
  _getVerbs = getVerbs;
  _getPhrases = getPhrases;
}

// ════════════════════════════════════════════════
// NOUNS — загрузка и тренажёр существительных
// ════════════════════════════════════════════════

const NOUNS_BUILTIN = [
  // corps
  {id:'n1',fr:'bras',ru:'рука (от плеча)',gender:'m',theme:'corps'},
  {id:'n2',fr:'jambe',ru:'нога',gender:'f',theme:'corps'},
  {id:'n3',fr:'tête',ru:'голова',gender:'f',theme:'corps'},
  {id:'n4',fr:'dos',ru:'спина',gender:'m',theme:'corps'},
  {id:'n5',fr:'ventre',ru:'живот',gender:'m',theme:'corps'},
  {id:'n6',fr:'main',ru:'рука (кисть)',gender:'f',theme:'corps'},
  {id:'n7',fr:'pied',ru:'стопа',gender:'m',theme:'corps'},
  {id:'n8',fr:'genou',ru:'колено',gender:'m',theme:'corps'},
  {id:'n9',fr:"l'épaule",ru:'плечо',gender:'f',theme:'corps'},
  {id:'n10',fr:'cœur',ru:'сердце',gender:'m',theme:'corps'},
  // famille
  {id:'n11',fr:'père',ru:'отец',gender:'m',theme:'famille'},
  {id:'n12',fr:'mère',ru:'мать',gender:'f',theme:'famille'},
  {id:'n13',fr:'frère',ru:'брат',gender:'m',theme:'famille'},
  {id:'n14',fr:'sœur',ru:'сестра',gender:'f',theme:'famille'},
  {id:'n15',fr:'fils',ru:'сын',gender:'m',theme:'famille'},
  {id:'n16',fr:'fille',ru:'дочь',gender:'f',theme:'famille'},
  {id:'n17',fr:'mari',ru:'муж',gender:'m',theme:'famille'},
  {id:'n18',fr:'femme',ru:'жена / женщина',gender:'f',theme:'famille'},
  {id:'n19',fr:'grand-père',ru:'дедушка',gender:'m',theme:'famille'},
  {id:'n20',fr:'grand-mère',ru:'бабушка',gender:'f',theme:'famille'},
  // maison
  {id:'n21',fr:'cuisine',ru:'кухня',gender:'f',theme:'maison'},
  {id:'n22',fr:'salon',ru:'гостиная',gender:'m',theme:'maison'},
  {id:'n23',fr:'chambre',ru:'спальня',gender:'f',theme:'maison'},
  {id:'n24',fr:'salle de bain',ru:'ванная',gender:'f',theme:'maison'},
  {id:'n25',fr:'jardin',ru:'сад',gender:'m',theme:'maison'},
  {id:'n26',fr:'fenêtre',ru:'окно',gender:'f',theme:'maison'},
  {id:'n27',fr:'porte',ru:'дверь',gender:'f',theme:'maison'},
  {id:'n28',fr:'sol',ru:'пол',gender:'m',theme:'maison'},
  {id:'n29',fr:'plafond',ru:'потолок',gender:'m',theme:'maison'},
  {id:'n30',fr:'mur',ru:'стена',gender:'m',theme:'maison'},
  // nourriture
  {id:'n31',fr:'pain',ru:'хлеб',gender:'m',theme:'nourriture'},
  {id:'n32',fr:'pomme',ru:'яблоко',gender:'f',theme:'nourriture'},
  {id:'n33',fr:'fromage',ru:'сыр',gender:'m',theme:'nourriture'},
  {id:'n34',fr:'viande',ru:'мясо',gender:'f',theme:'nourriture'},
  {id:'n35',fr:'poisson',ru:'рыба',gender:'m',theme:'nourriture'},
  {id:'n36',fr:'soupe',ru:'суп',gender:'f',theme:'nourriture'},
  {id:'n37',fr:'riz',ru:'рис',gender:'m',theme:'nourriture'},
  {id:'n38',fr:'salade',ru:'салат',gender:'f',theme:'nourriture'},
  {id:'n39',fr:'gâteau',ru:'торт / пирожное',gender:'m',theme:'nourriture'},
  {id:'n40',fr:'fraise',ru:'клубника',gender:'f',theme:'nourriture'},
  // ville
  {id:'n41',fr:'rue',ru:'улица',gender:'f',theme:'ville'},
  {id:'n42',fr:'quartier',ru:'район',gender:'m',theme:'ville'},
  {id:'n43',fr:'mairie',ru:'мэрия',gender:'f',theme:'ville'},
  {id:'n44',fr:'marché',ru:'рынок',gender:'m',theme:'ville'},
  {id:'n45',fr:'pharmacie',ru:'аптека',gender:'f',theme:'ville'},
  {id:'n46',fr:'musée',ru:'музей',gender:'m',theme:'ville'},
  {id:'n47',fr:'bibliothèque',ru:'библиотека',gender:'f',theme:'ville'},
  {id:'n48',fr:'pont',ru:'мост',gender:'m',theme:'ville'},
  {id:'n49',fr:'place',ru:'площадь',gender:'f',theme:'ville'},
  {id:'n50',fr:'cinéma',ru:'кинотеатр',gender:'m',theme:'ville'},
  // transport
  {id:'n51',fr:'train',ru:'поезд',gender:'m',theme:'transport'},
  {id:'n52',fr:'voiture',ru:'машина',gender:'f',theme:'transport'},
  {id:'n53',fr:'bus',ru:'автобус',gender:'m',theme:'transport'},
  {id:'n54',fr:'vélo',ru:'велосипед',gender:'m',theme:'transport'},
  {id:'n55',fr:'moto',ru:'мотоцикл',gender:'f',theme:'transport'},
  {id:'n56',fr:"l'avion",ru:'самолёт',gender:'m',theme:'transport'},
  {id:'n57',fr:'bateau',ru:'лодка / корабль',gender:'m',theme:'transport'},
  {id:'n58',fr:'gare',ru:'вокзал',gender:'f',theme:'transport'},
  {id:'n59',fr:'taxi',ru:'такси',gender:'m',theme:'transport'},
  {id:'n60',fr:'métro',ru:'метро',gender:'m',theme:'transport'},
  // nature
  {id:'n61',fr:'forêt',ru:'лес',gender:'f',theme:'nature'},
  {id:'n62',fr:'mer',ru:'море',gender:'f',theme:'nature'},
  {id:'n63',fr:'montagne',ru:'гора',gender:'f',theme:'nature'},
  {id:'n64',fr:'fleuve',ru:'река (большая)',gender:'m',theme:'nature'},
  {id:'n65',fr:'rivière',ru:'река (малая)',gender:'f',theme:'nature'},
  {id:'n66',fr:'lac',ru:'озеро',gender:'m',theme:'nature'},
  {id:'n67',fr:'plage',ru:'пляж',gender:'f',theme:'nature'},
  {id:'n68',fr:'soleil',ru:'солнце',gender:'m',theme:'nature'},
  {id:'n69',fr:'pluie',ru:'дождь',gender:'f',theme:'nature'},
  {id:'n70',fr:'vent',ru:'ветер',gender:'m',theme:'nature'},
  // travail
  {id:'n71',fr:'bureau',ru:'офис / стол',gender:'m',theme:'travail'},
  {id:'n72',fr:'réunion',ru:'встреча / собрание',gender:'f',theme:'travail'},
  {id:'n73',fr:'patron',ru:'начальник',gender:'m',theme:'travail'},
  {id:'n74',fr:'salaire',ru:'зарплата',gender:'m',theme:'travail'},
  {id:'n75',fr:'collègue',ru:'коллега (ж)',gender:'f',theme:'travail'},
  {id:'n76',fr:'projet',ru:'проект',gender:'m',theme:'travail'},
  {id:'n77',fr:'réunion',ru:'совещание',gender:'f',theme:'travail'},
  {id:'n78',fr:'rapport',ru:'отчёт',gender:'m',theme:'travail'},
  // temps
  {id:'n79',fr:'semaine',ru:'неделя',gender:'f',theme:'temps'},
  {id:'n80',fr:'mois',ru:'месяц',gender:'m',theme:'temps'},
  {id:'n81',fr:"l'année",ru:'год',gender:'f',theme:'temps'},
  {id:'n82',fr:'matin',ru:'утро',gender:'m',theme:'temps'},
  {id:'n83',fr:'soir',ru:'вечер',gender:'m',theme:'temps'},
  {id:'n84',fr:'nuit',ru:'ночь',gender:'f',theme:'temps'},
  {id:'n85',fr:'midi',ru:'полдень',gender:'m',theme:'temps'},
  {id:'n86',fr:'week-end',ru:'выходные',gender:'m',theme:'temps'},
  // vêtements
  {id:'n87',fr:'manteau',ru:'пальто',gender:'m',theme:'vêtements'},
  {id:'n88',fr:'robe',ru:'платье',gender:'f',theme:'vêtements'},
  {id:'n89',fr:'pantalon',ru:'брюки',gender:'m',theme:'vêtements'},
  {id:'n90',fr:'chemise',ru:'рубашка',gender:'f',theme:'vêtements'},
  {id:'n91',fr:'pull',ru:'свитер',gender:'m',theme:'vêtements'},
  {id:'n92',fr:'jupe',ru:'юбка',gender:'f',theme:'vêtements'},
  {id:'n93',fr:'chapeau',ru:'шляпа',gender:'m',theme:'vêtements'},
  {id:'n94',fr:'chaussure',ru:'туфля / ботинок',gender:'f',theme:'vêtements'},
  // animaux
  {id:'n95',fr:'chien',ru:'собака',gender:'m',theme:'animaux'},
  {id:'n96',fr:'chat',ru:'кошка',gender:'m',theme:'animaux'},
  {id:'n97',fr:'cheval',ru:'лошадь',gender:'m',theme:'animaux'},
  {id:'n98',fr:'vache',ru:'корова',gender:'f',theme:'animaux'},
  {id:'n99',fr:'lapin',ru:'кролик',gender:'m',theme:'animaux'},
  {id:'n100',fr:'poule',ru:'курица',gender:'f',theme:'animaux'},
  {id:'n101',fr:'poisson',ru:'рыба',gender:'m',theme:'animaux'},
  {id:'n102',fr:"l'oiseau",ru:'птица',gender:'m',theme:'animaux'},
  // divers
  {id:'n103',fr:'problème',ru:'проблема',gender:'m',theme:'divers'},
  {id:'n104',fr:'solution',ru:'решение',gender:'f',theme:'divers'},
  {id:'n105',fr:'monde',ru:'мир / свет',gender:'m',theme:'divers'},
  {id:'n106',fr:'question',ru:'вопрос',gender:'f',theme:'divers'},
  {id:'n107',fr:'temps',ru:'время / погода',gender:'m',theme:'divers'},
  {id:'n108',fr:'vie',ru:'жизнь',gender:'f',theme:'divers'},
  {id:'n109',fr:'pays',ru:'страна',gender:'m',theme:'divers'},
  {id:'n110',fr:'langue',ru:'язык',gender:'f',theme:'divers'},
];

export async function loadNounsFromCloud() {
  if (NOUNS_LOADED) return;
  NOUNS.length = 0;
  const byId = new Map();
  NOUNS_BUILTIN.forEach(n => byId.set(String(n.id), n));
  try {
    const { data } = await sb.from('nouns').select('*').order('fr', { ascending: true });
    (data || []).forEach(w => {
      const id = w.id || normalizeImportKey(w.fr || w.word || ('noun_' + Date.now()));
      byId.set(String(id), {
        id,
        fr: w.fr || w.word || '',
        ru: w.ru || w.translations || w.meaning || '',
        gender: w.gender || 'm',
        theme: w.theme || 'custom'
      });
    });
  } catch(e) {
    console.warn('[nouns] Firebase nouns load skipped:', e?.message || e);
  }
  byId.forEach(n => NOUNS.push(n));
  setNounsLoaded(true);
}

let currentNoun = null;
let nounWeakMode = false;
let nounGood = 0, nounBad = 0, nounStreak = 0;

window.nounWeakMode = false;

window.toggleNounWeak = function() {
  nounWeakMode = !nounWeakMode;
  window.nounWeakMode = nounWeakMode;
  const btn = document.getElementById('noun-weak-btn');
  if (btn) {
    btn.style.background = nounWeakMode ? 'var(--accent)' : '';
    btn.style.color = nounWeakMode ? '#f5ecd8' : '';
  }
  window.nounNextCard();
};

window.nounNextCard = async function() {
  if (!NOUNS_LOADED) await loadNounsFromCloud();
  const theme = document.getElementById('noun-theme')?.value || 'all';
  const stats = loadStats();

  let pool = NOUNS.filter(n => theme === 'all' || n.theme === theme);
  if (nounWeakMode) {
    pool = pool.filter(n => {
      const s = stats['noun_' + n.id];
      return s && s.total >= 2 && (s.correct / s.total) < 0.6;
    });
    if (!pool.length) {
      document.getElementById('noun-word').textContent = '—';
      document.getElementById('noun-meaning').textContent = 'Нет слабых слов в этой теме!';
      document.getElementById('noun-theme-label').textContent = '';
      document.getElementById('noun-feedback').innerHTML = '';
      document.getElementById('noun-count').textContent = '';
      return;
    }
  }
  if (!pool.length) {
    document.getElementById('noun-word').textContent = '—';
    document.getElementById('noun-meaning').textContent = 'Нет существительных в этой теме';
    return;
  }

  document.getElementById('noun-count').textContent = pool.length + ' слов';
  document.getElementById('noun-answer-area').style.display = 'grid';
  document.getElementById('noun-feedback').innerHTML = '';

  // Weighted random — show weak words more
  const weights = pool.map(n => {
    const s = stats['noun_' + n.id];
    if (!s) return 3;
    const pct = s.correct / s.total;
    return pct < 0.5 ? 5 : pct < 0.75 ? 2 : 1;
  });
  const totalW = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * totalW;
  let idx = 0;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) { idx = i; break; } }

  currentNoun = pool[idx];
  document.getElementById('noun-word').textContent = currentNoun.fr;
  document.getElementById('noun-meaning').textContent = currentNoun.ru;
  const themeLabels = {
    corps:'🫀 Тело', famille:'👨‍👩‍👧 Семья', maison:'🏠 Дом', nourriture:'🍎 Еда',
    ville:'🏙 Город', transport:'🚗 Транспорт', nature:'🌿 Природа',
    travail:'💼 Работа', temps:'⏰ Время', vêtements:'👕 Одежда',
    animaux:'🐾 Животные', divers:'📦 Разное'
  };
  document.getElementById('noun-theme-label').textContent = themeLabels[currentNoun.theme] || currentNoun.theme;

  // Update and reset answer buttons
  const btnM = document.querySelector('[onclick="checkNoun(\'m\')"]');
  const btnF = document.querySelector('[onclick="checkNoun(\'f\')"]');
  if (btnM) { btnM.style.borderColor=''; btnM.style.background=''; btnM.style.color=''; btnM.innerHTML=`<em>le</em> ${currentNoun.fr}`; }
  if (btnF) { btnF.style.borderColor=''; btnF.style.background=''; btnF.style.color=''; btnF.innerHTML=`<em>la</em> ${currentNoun.fr}`; }
};

window.checkNoun = async function(guess) {
  if (!currentNoun) return;
  const isCorrect = guess === currentNoun.gender;
  const stats = loadStats();
  const key = 'noun_' + currentNoun.id;
  if (!stats[key]) stats[key] = { total: 0, correct: 0 };
  stats[key].total++;
  stats[key].lastDate = todayStr(); // daily-task check relies on this
  if (isCorrect) { stats[key].correct++; nounGood++; nounStreak++; }
  else { nounBad++; nounStreak = 0; }
  await saveStats(stats);

  document.getElementById('nscore2-good').textContent = nounGood;
  document.getElementById('nscore2-bad').textContent = nounBad;
  document.getElementById('nscore2-streak').textContent = nounStreak;

  const correctArticle = currentNoun.gender === 'm' ? 'le' : 'la';
  const fullForm = correctArticle + ' ' + currentNoun.fr;
  const fb = document.getElementById('noun-feedback');

  // Highlight buttons
  ['m','f'].forEach(g => {
    const btn = document.querySelector(`[onclick="checkNoun('${g}')"]`);
    if (!btn) return;
    if (g === currentNoun.gender) { btn.style.borderColor = 'var(--good)'; btn.style.background = 'rgba(52,199,89,0.12)'; btn.style.color = 'var(--good)'; }
    else if (g === guess && !isCorrect) { btn.style.borderColor = 'var(--bad)'; btn.style.background = 'rgba(255,59,48,0.1)'; }
  });

  // Gender rule hint
  const fr = currentNoun.fr;
  let hint = '';
  if (!isCorrect) {
    if (fr.endsWith('tion') || fr.endsWith('sion') || fr.endsWith('ée') || fr.endsWith('té')) hint = `Слова на «${fr.slice(-3)}» обычно женского рода`;
    else if (fr.endsWith('ment') || fr.endsWith('age') || fr.endsWith('eur')) hint = `Слова на «${fr.slice(-3)}» обычно мужского рода`;
  }

  fb.innerHTML = isCorrect
    ? `<div style="color:var(--good);font-size:1rem;font-weight:600">✓ ${fullForm}</div>
       <button class="btn btn-primary" onclick="nounNextCard()" style="padding:8px 20px;font-size:0.85rem">Следующее →</button>`
    : `<div><div style="color:var(--bad);font-size:1rem;font-weight:600">✗ Правильно: ${fullForm}</div>
       ${hint ? `<div style="font-size:0.78rem;color:var(--text-muted);margin-top:4px">${hint}</div>` : ''}
       </div>
       <button class="btn btn-primary" onclick="nounNextCard()" style="padding:8px 20px;font-size:0.85rem">Следующее →</button>`;

  speak(fullForm);
};

// ════════════════════════════════════════════════
// PREPS — тренажёр предлогов
// ════════════════════════════════════════════════

export const PREPS_DATA = [
  // verbe + à + inf
  {id:'p1', verb:'commencer', ru:'начинать', prep:'à', example:'Il commence à travailler.', exru:'Он начинает работать.', group:'a_inf'},
  {id:'p2', verb:'apprendre', ru:'учиться', prep:'à', example:'Elle apprend à conduire.', exru:'Она учится водить.', group:'a_inf'},
  {id:'p3', verb:'réussir', ru:'удаваться', prep:'à', example:'Il réussit à finir.', exru:'Ему удаётся закончить.', group:'a_inf'},
  {id:'p4', verb:'aider', ru:'помогать', prep:'à', example:'Tu aides à préparer.', exru:'Ты помогаешь готовить.', group:'a_inf'},
  {id:'p5', verb:'hésiter', ru:'колебаться', prep:'à', example:'Elle hésite à partir.', exru:'Она колеблется уходить.', group:'a_inf'},
  {id:'p6', verb:'inviter', ru:'приглашать', prep:'à', example:'Il invite à entrer.', exru:'Он приглашает войти.', group:'a_inf'},
  // verbe + de + inf
  {id:'p7', verb:'arrêter', ru:'переставать', prep:'de', example:'Il arrête de fumer.', exru:'Он перестаёт курить.', group:'de_inf'},
  {id:'p8', verb:'essayer', ru:'пытаться', prep:'de', example:'Elle essaie de comprendre.', exru:'Она пытается понять.', group:'de_inf'},
  {id:'p9', verb:'décider', ru:'решать', prep:'de', example:'Nous décidons de partir.', exru:'Мы решаем уехать.', group:'de_inf'},
  {id:'p10', verb:'refuser', ru:'отказываться', prep:'de', example:'Il refuse de manger.', exru:'Он отказывается есть.', group:'de_inf'},
  {id:'p11', verb:'oublier', ru:'забывать', prep:'de', example:'Tu oublies de fermer.', exru:'Ты забываешь закрыть.', group:'de_inf'},
  {id:'p12', verb:'finir', ru:'заканчивать', prep:'de', example:'Elle finit de lire.', exru:'Она заканчивает читать.', group:'de_inf'},
  // verbe + à + nom
  {id:'p13', verb:'penser', ru:'думать (о)', prep:'à', example:'Je pense à toi.', exru:'Я думаю о тебе.', group:'a_nom'},
  {id:'p14', verb:'ressembler', ru:'быть похожим (на)', prep:'à', example:'Il ressemble à son père.', exru:'Он похож на отца.', group:'a_nom'},
  {id:'p15', verb:'s\'intéresser', ru:'интересоваться', prep:'à', example:'Elle s\'intéresse à l\'art.', exru:'Она интересуется искусством.', group:'a_nom'},
  {id:'p16', verb:'tenir', ru:'дорожить', prep:'à', example:'Je tiens à ma famille.', exru:'Я дорожу семьёй.', group:'a_nom'},
  // verbe + de + nom
  {id:'p17', verb:'parler', ru:'говорить (о)', prep:'de', example:'Nous parlons de lui.', exru:'Мы говорим о нём.', group:'de_nom'},
  {id:'p18', verb:'avoir besoin', ru:'нуждаться (в)', prep:'de', example:'J\'ai besoin de temps.', exru:'Мне нужно время.', group:'de_nom'},
  {id:'p19', verb:'se souvenir', ru:'помнить (о)', prep:'de', example:'Tu te souviens de lui.', exru:'Ты помнишь его.', group:'de_nom'},
  {id:'p20', verb:'manquer', ru:'не хватать', prep:'de', example:'Il manque de courage.', exru:'Ему не хватает смелости.', group:'de_nom'},
  // other
  {id:'p21', verb:'compter', ru:'рассчитывать (на)', prep:'sur', example:'Je compte sur toi.', exru:'Я рассчитываю на тебя.', group:'other'},
  {id:'p22', verb:'rêver', ru:'мечтать (о)', prep:'de', example:'Elle rêve de voyager.', exru:'Она мечтает путешествовать.', group:'other'},
  {id:'p23', verb:'remercier', ru:'благодарить (за)', prep:'pour', example:'Merci pour tout.', exru:'Спасибо за всё.', group:'other'},
  {id:'p24', verb:'se marier', ru:'жениться (на)', prep:'avec', example:'Il se marie avec elle.', exru:'Он женится на ней.', group:'other'},
];

let currentPrep = null;
let prepGood = 0, prepBad = 0, prepStreak = 0;
window.currentPrep = null;

window.prepNextCard = function() {
  const group = document.getElementById('prep-group')?.value || 'all';
  const stats = loadStats();
  let pool = group === 'all' ? PREPS_DATA : PREPS_DATA.filter(p => p.group === group);
  if (!pool.length) return;

  document.getElementById('prep-count').textContent = pool.length + ' конструкций';
  document.getElementById('prep-feedback').innerHTML = '';

  // Weighted pick
  const weights = pool.map(p => {
    const s = stats['prep_' + p.id];
    if (!s) return 3;
    return (s.correct / s.total) < 0.6 ? 5 : 1;
  });
  const totalW = weights.reduce((a,b)=>a+b,0);
  let r = Math.random() * totalW, idx = 0;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) { idx = i; break; } }

  currentPrep = pool[idx];
  window.currentPrep = currentPrep;

  document.getElementById('prep-verb').textContent = currentPrep.verb;
  document.getElementById('prep-ru').textContent = currentPrep.ru;
  document.getElementById('prep-example-blank').innerHTML = currentPrep.example.replace(currentPrep.prep, '<span style="color:var(--accent);font-weight:600">___</span>');
  document.getElementById('prep-exru').textContent = currentPrep.exru;

  // Build answer buttons — correct + 3 distractors
  const allPreps = ['à','de','sur','pour','avec','en','par','dans'];
  const distractors = allPreps.filter(p => p !== currentPrep.prep).sort(() => Math.random()-0.5).slice(0,3);
  const choices = [currentPrep.prep, ...distractors].sort(() => Math.random()-0.5);

  const area = document.getElementById('prep-answer-area');
  area.innerHTML = choices.map(p =>
    `<button onclick="checkPrep('${p}')" style="padding:12px 24px;font-family:'IBM Plex Mono',monospace;font-size:1.1rem;border:2px solid var(--border);border-radius:10px;background:var(--surface);color:var(--text);cursor:pointer;min-width:80px;transition:all 0.2s">${p}</button>`
  ).join('');
};

window.checkPrep = async function(guess) {
  if (!currentPrep) return;
  const isCorrect = guess === currentPrep.prep;
  const stats = loadStats();
  const key = 'prep_' + currentPrep.id;
  if (!stats[key]) stats[key] = { total: 0, correct: 0 };
  stats[key].total++;
  stats[key].lastDate = todayStr(); // daily-task check relies on this
  if (isCorrect) { stats[key].correct++; prepGood++; prepStreak++; }
  else { prepBad++; prepStreak = 0; }
  await saveStats(stats);

  document.getElementById('pscore-good').textContent = prepGood;
  document.getElementById('pscore-bad').textContent = prepBad;
  document.getElementById('pscore-streak').textContent = prepStreak;

  // Highlight buttons
  document.querySelectorAll('#prep-answer-area button').forEach(btn => {
    const p = btn.textContent.trim();
    if (p === currentPrep.prep) { btn.style.borderColor = 'var(--good)'; btn.style.background = 'rgba(52,199,89,0.12)'; btn.style.color = 'var(--good)'; }
    else if (p === guess && !isCorrect) { btn.style.borderColor = 'var(--bad)'; btn.style.background = 'rgba(255,59,48,0.1)'; }
    btn.disabled = true;
  });

  document.getElementById('prep-example-blank').innerHTML = currentPrep.example.replace(
    currentPrep.prep, `<strong style="color:var(--good)">${currentPrep.prep}</strong>`
  );

  const fb = document.getElementById('prep-feedback');
  fb.innerHTML = isCorrect
    ? `<div style="color:var(--good);font-weight:600">✓ ${currentPrep.verb} ${currentPrep.prep}</div>
       <button class="btn btn-primary" onclick="prepNextCard()" style="padding:8px 20px;font-size:0.85rem">Следующая →</button>`
    : `<div style="color:var(--bad);font-weight:600">✗ Правильно: ${currentPrep.verb} <strong>${currentPrep.prep}</strong></div>
       <button class="btn btn-primary" onclick="prepNextCard()" style="padding:8px 20px;font-size:0.85rem">Следующая →</button>`;

  if (isCorrect) speak(currentPrep.example);
};

// ════════════════════════════════════════════════
// PHRASES AI MODES — Перевод и Вопросы (Gemini)
// ════════════════════════════════════════════════

let phMode = 'fill'; // 'fill' | 'construct' | 'translate' | 'question'
window.phMode = phMode;
document.documentElement.dataset.phMode = phMode;
let phDifficulty = 'medium'; // 'easy' | 'medium' | 'hard'

const PH_DIFFICULTY = {
  easy:   { levels: ['A1'],             label: '🟢 Débutant' },
  medium: { levels: ['A1','A2'],        label: '🟡 Intermédiaire' },
  hard:   { levels: ['A1','A2','B1','B2'], label: '🔴 Avancé' },
};

window.setPhrasesMode = function(mode) {
  if (!['fill','construct'].includes(mode)) {
    showToast('ИИ-режимы фраз пока скрыты — сначала доводим ручную базу.');
    mode = 'fill';
  }
  phMode = mode;
  window.phMode = phMode;
  document.documentElement.dataset.phMode = phMode;
  try { localStorage.setItem('an2_phrase_mode', phMode); } catch {}

  // Update tab buttons
  ['fill','construct','translate','question'].forEach(m => {
    const btn = document.getElementById(`ph-mode-${m}-btn`);
    if (!btn) return;
    const active = m === mode;
    btn.style.background = active ? 'var(--accent)' : 'none';
    btn.style.color = active ? '#f5ecd8' : 'var(--text-muted)';
    btn.style.fontWeight = active ? '600' : '400';
  });

  // Show/hide filters vs difficulty
  const filtersRow = document.getElementById('ph-filters-row');
  const diffRow = document.getElementById('ph-difficulty-row');
  const fillAnswer = document.getElementById('ph-answer-fill');
  const aiAnswer = document.getElementById('ph-answer-ai');
  const aiFeedback = document.getElementById('ph-ai-feedback');

  if (mode === 'fill' || mode === 'construct') {
    if (filtersRow) filtersRow.style.display = 'flex';
    if (diffRow) diffRow.style.display = 'none';
    if (fillAnswer) fillAnswer.style.display = 'block';
    if (aiAnswer) aiAnswer.style.display = 'none';
    if (aiFeedback) aiFeedback.style.display = 'none';
    const inp = document.getElementById('ph-input');
    if (inp) {
      inp.placeholder = mode === 'construct' ? 'введи предложение полностью...' : 'введи пропущенную форму...';
      inp.rows = mode === 'construct' ? 3 : 1;
      inp.style.minHeight = mode === 'construct' ? '108px' : '54px';
      inp.style.fontSize = mode === 'construct' ? '1.02rem' : '';
      inp.style.textAlign = mode === 'construct' ? 'left' : '';
      inp.style.fontFamily = mode === 'construct' ? "'IBM Plex Sans', sans-serif" : "'IBM Plex Mono', monospace";
      inp.style.resize = mode === 'construct' ? 'vertical' : 'none';
    }
    window.nextPhrase?.();
    window.autoResizePhraseInput?.();
  } else {
    if (filtersRow) filtersRow.style.display = 'none';
    if (diffRow) diffRow.style.display = 'flex';
    if (fillAnswer) fillAnswer.style.display = 'none';
    if (aiAnswer) aiAnswer.style.display = 'block';
    if (aiFeedback) aiFeedback.style.display = 'none';
    const inp = document.getElementById('ph-ai-input');
    if (inp) inp.value = '';
    loadAIPhrase();
  }
};

window.autoResizePhraseInput = function() {
  const el = document.getElementById('ph-input');
  if (!el) return;
  if ((window.phMode || 'fill') === 'construct') {
    el.style.height = 'auto';
    el.style.height = Math.max(108, Math.min(el.scrollHeight + 4, 220)) + 'px';
  }
};

window.setPhDifficulty = function(level) {
  phDifficulty = level;

  ['easy','medium','hard'].forEach(l => {
    const btn = document.getElementById(`ph-diff-${l}`);
    if (!btn) return;
    const active = l === level;
    btn.style.borderColor = active ? 'var(--accent)' : 'var(--border)';
    btn.style.background = active ? 'rgba(212,175,55,0.12)' : 'none';
    btn.style.color = active ? 'var(--accent)' : 'var(--text-muted)';
  });

  loadAIPhrase();
};

let currentAIPhrase = null;

function getAIPhrasePool() {
  const diff = PH_DIFFICULTY[phDifficulty];
  return _getPhrases().filter(p => {
    if (phSelectedVerbs.size > 0 && !phSelectedVerbs.has(p.verbId)) return false;
    if (p.level && p.level !== 'A2') {
      return diff.levels.includes(p.level);
    }
    if (phDifficulty === 'easy') {
      const verb = _getVerbs().find(v => v.id === p.verbId);
      const basicVerbs = ['être','avoir','aller','faire','pouvoir','vouloir','venir','dire','voir','savoir'];
      return p.tense === 'present' && (verb?.group === 'er' || basicVerbs.includes(verb?.inf));
    }
    if (phDifficulty === 'medium') return ['present','passe','imparfait'].includes(p.tense);
    return true;
  });
}

function loadAIPhrase() {
  const pool = getAIPhrasePool();
  const aiFeedback = document.getElementById('ph-ai-feedback');
  const aiInput = document.getElementById('ph-ai-input');
  const card = document.getElementById('ph-card');
  const badge = document.getElementById('ph-badge');
  const sentence = document.getElementById('ph-sentence');
  const ruEl = document.getElementById('ph-ru');

  if (aiFeedback) aiFeedback.style.display = 'none';
  if (aiInput) { aiInput.value = ''; aiInput.disabled = false; }

  const checkBtn = document.getElementById('ph-ai-check-btn');
  if (checkBtn) { checkBtn.disabled = false; checkBtn.textContent = '✨ Проверить'; }

  if (!pool.length) {
    if (sentence) sentence.textContent = 'Нет фраз для этого уровня';
    return;
  }

  currentAIPhrase = pool[Math.floor(Math.random() * pool.length)];
  const verb = _getVerbs().find(v => v.id === currentAIPhrase.verbId);

  if (badge) {
    badge.textContent = verb ? `${verb.inf.toUpperCase()} · ${currentAIPhrase.tense.toUpperCase()}` : '—';
  }

  if (phMode === 'translate') {
    if (sentence) {
      sentence.style.fontStyle = 'normal';
      sentence.style.color = 'var(--text)';
      sentence.textContent = currentAIPhrase.ru || '—';
    }
    if (ruEl) ruEl.textContent = '';
    const inp = document.getElementById('ph-ai-input');
    if (inp) inp.placeholder = 'Переведи это предложение на французский...';
  } else {
    const fullFr = currentAIPhrase.fr.includes('___')
      ? currentAIPhrase.fr.replace('___', currentAIPhrase.answer || '___')
      : currentAIPhrase.fr;
    if (sentence) {
      sentence.style.fontStyle = 'italic';
      sentence.style.color = 'var(--text)';
      sentence.textContent = fullFr;
    }
    if (ruEl) ruEl.textContent = currentAIPhrase.ru || '';
    const inp = document.getElementById('ph-ai-input');
    if (inp) inp.placeholder = 'Задай вопрос к этому предложению по-французски...';
  }
}
window.loadAIPhrase = loadAIPhrase;

window.checkPhraseAI = async function() {
  if (window.guardGuest && window.guardGuest('AI-проверка')) return;
  if (!currentAIPhrase) return;
  const inp = document.getElementById('ph-ai-input');
  const userAnswer = inp?.value.trim();
  if (!userAnswer) { if (inp) inp.focus(); return; }

  const checkBtn = document.getElementById('ph-ai-check-btn');
  if (checkBtn) { checkBtn.disabled = true; checkBtn.textContent = '⏳ Проверяю...'; }

  const aiFeedback = document.getElementById('ph-ai-feedback');
  const aiResult = document.getElementById('ph-ai-result');

  if (aiFeedback) aiFeedback.style.display = 'none';

  const fullFr = currentAIPhrase.fr.includes('___')
    ? currentAIPhrase.fr.replace('___', currentAIPhrase.answer || '')
    : currentAIPhrase.fr;

  try {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetchWithTimeout(`${SUPABASE_URL}/functions/v1/check-phrase`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token || SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY,
      },
      body: JSON.stringify({
        mode: phMode,
        userAnswer,
        originalRu: currentAIPhrase.ru,
        correctFr: fullFr,
      })
    }, LONG_REQUEST_TIMEOUT_MS);

    if (!res.ok) throw new Error(`Ошибка сервера ${res.status}`);
    const data = await res.json();
    const text = data.feedback || 'Нет ответа';

    if (aiResult) {
      const isGood = /верно|правильно|отлично|хорошо|принято|корректно/i.test(text) &&
                     !/ошибк|неправильно|неверно|неточно/i.test(text);
      aiResult.innerHTML = `
        <div style="display:flex;align-items:flex-start;gap:10px;">
          <span style="font-size:1.3rem">${isGood ? '✅' : '💬'}</span>
          <div style="line-height:1.7;font-size:0.9rem">${text.replace(/\n/g, '<br>')}</div>
        </div>`;
    }

    if (aiFeedback) aiFeedback.style.display = 'block';
    if (inp) inp.disabled = true;

    setTimeout(() => aiFeedback?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);

  } catch(e) {
    if (aiResult) aiResult.innerHTML = `<span style="color:var(--bad)">⚠ Ошибка: ${e.message}</span>`;
    if (aiFeedback) aiFeedback.style.display = 'block';
    if (checkBtn) { checkBtn.disabled = false; checkBtn.textContent = '✨ Проверить'; }
  }
};

// ════════════════════════════════════════════════
// STUDY — Tense switcher
// ════════════════════════════════════════════════

function makeFrenchSubjectPhrase(pronoun, form) {
  const p = String(pronoun || '').trim();
  const f = String(form || '').trim();
  if (!p) return f;
  if (!f) return p;
  const spokenPronoun = p === 'il/elle' ? 'il' : (p === 'ils/elles' ? 'ils' : p);
  if (/^je$/i.test(spokenPronoun) && /^[aeiouhàâäéèêëîïôöùûü]/i.test(f)) return `j'${f}`;
  return `${spokenPronoun} ${f}`;
}

let learnCurrentTense = 'present';
window.learnCurrentTense = 'present';

window.setLearnTense = function(tense) {
  learnCurrentTense = tense;
  window.learnCurrentTense = tense;
  ['present','passe','imparfait','futur'].forEach(t => {
    const btn = document.getElementById('learn-tense-' + t);
    if (!btn) return;
    btn.style.background = t === tense ? 'var(--accent)' : 'none';
    btn.style.color = t === tense ? '#f5ecd8' : 'var(--text-muted)';
    btn.style.fontWeight = t === tense ? '600' : '400';
  });
  renderLearnTenseTable();
};

function renderLearnTenseTable() {
  const v = getLearnVerb();
  if (!v) return;
  const table = document.getElementById('learn-conj-table');
  const tenseLabel = document.getElementById('learn-tense-label');
  const auxInfo = document.getElementById('learn-aux-info');
  const exEl = document.getElementById('learn-example');
  const pronouns = ['je','tu','il/elle','nous','vous','ils/elles'];

  // Single source of truth for the current learning tense
  const learnCurrentTense = window.learnCurrentTense || 'present';

  if (learnCurrentTense === 'present') {
    const forms = v.conj?.present || [];
    if (tenseLabel) tenseLabel.textContent = "Présent de l'indicatif";
    if (auxInfo) auxInfo.style.display = 'none';
    if (table) table.innerHTML = pronouns.map((p, i) => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--surface2);border-radius:6px;">
        <span style="font-family:'IBM Plex Mono',monospace;font-size:0.78rem;color:var(--accent);min-width:52px">${p}</span>
        <span style="font-family:'Playfair Display',serif;font-style:italic;font-size:1rem">${forms[i] || '—'}</span>
        <button onclick="speakText(this)" data-speak="${escapeAttr(makeFrenchSubjectPhrase(p, forms[i] || ''))}" style="background:none;border:none;cursor:pointer;color:var(--text-dim);font-size:0.8rem;margin-left:auto;padding:2px 4px">🔊</button>
      </div>`).join('');
    if (exEl) exEl.textContent = v.ex?.present || '';
  } else if (learnCurrentTense === 'passe') {
    const pp = v.pp || (v.inf.endsWith('er') ? v.inf.slice(0,-2)+'é' : v.inf.endsWith('ir') ? v.inf.slice(0,-1) : v.inf);
    const aux = v.aux === 'être' ? 'être' : 'avoir';
    const etreConj = ['suis','es','est','sommes','êtes','sont'];
    const avoirConj = ['ai','as','a','avons','avez','ont'];
    const auxForms = aux === 'être' ? etreConj : avoirConj;
    const agreements = aux === 'être'
      ? [pp, pp, pp+'/'+pp+'e', pp+'s', pp+'s', pp+'s/'+pp+'es']
      : [pp, pp, pp, pp, pp, pp];
    if (tenseLabel) tenseLabel.textContent = 'Passé composé';
    if (auxInfo) {
      auxInfo.style.display = 'block';
      auxInfo.innerHTML = `Вспомогательный: <strong style="color:var(--accent)">${aux}</strong> + participe passé <strong style="color:var(--accent)">${pp}</strong>${aux === 'être' ? ' · согласование' : ''}`;
    }
    if (table) table.innerHTML = pronouns.map((p, i) => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--surface2);border-radius:6px;">
        <span style="font-family:'IBM Plex Mono',monospace;font-size:0.78rem;color:var(--accent);min-width:52px">${p}</span>
        <span style="font-family:'Playfair Display',serif;font-style:italic;font-size:0.9rem"><span style="color:var(--blue)">${auxForms[i]}</span> ${agreements[i]}</span>
        <button onclick="speakText(this)" data-speak="${escapeAttr(makeFrenchSubjectPhrase(p, auxForms[i] + ' ' + pp))}" style="background:none;border:none;cursor:pointer;color:var(--text-dim);font-size:0.8rem;margin-left:auto;padding:2px 4px">🔊</button>
      </div>`).join('');
    if (exEl) exEl.textContent = v.ex?.passe || `Il a ${pp}.`;
  } else if (learnCurrentTense === 'imparfait') {
    const forms = v.conj?.imparfait || [];
    if (tenseLabel) tenseLabel.textContent = 'Imparfait';
    if (auxInfo) auxInfo.style.display = 'none';
    const suffixes = ['ais','ais','ait','ions','iez','aient'];
    const stem = (v.conj?.present?.[3] || '').replace(/ons$/, '');
    if (table) table.innerHTML = pronouns.map((p, i) => {
      const form = forms.length ? (forms[i] || '—') : (stem + suffixes[i]);
      return `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--surface2);border-radius:6px;">
        <span style="font-family:'IBM Plex Mono',monospace;font-size:0.78rem;color:var(--accent);min-width:52px">${p}</span>
        <span style="font-family:'Playfair Display',serif;font-style:italic;font-size:1rem">${form}</span>
        <button onclick="speakText(this)" data-speak="${escapeAttr(makeFrenchSubjectPhrase(p, form))}" style="background:none;border:none;cursor:pointer;color:var(--text-dim);font-size:0.8rem;margin-left:auto;padding:2px 4px">🔊</button>
      </div>`;
    }).join('');
    if (exEl) exEl.textContent = v.ex?.imparfait || '';
  } else if (learnCurrentTense === 'futur') {
    let forms = v.conj?.futur || [];
    if (!forms.length) {
      let stem = v.inf; if (stem.endsWith('e')) stem = stem.slice(0, -1);
      const suf = ['ai','as','a','ons','ez','ont'];
      forms = suf.map(s => stem + s);
    }
    if (tenseLabel) tenseLabel.textContent = 'Futur simple';
    if (auxInfo) auxInfo.style.display = 'none';
    if (table) table.innerHTML = pronouns.map((p, i) => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--surface2);border-radius:6px;">
        <span style="font-family:'IBM Plex Mono',monospace;font-size:0.78rem;color:var(--accent);min-width:52px">${p}</span>
        <span style="font-family:'Playfair Display',serif;font-style:italic;font-size:1rem">${forms[i] || '—'}</span>
        <button onclick="speakText(this)" data-speak="${escapeAttr(makeFrenchSubjectPhrase(p, forms[i] || ''))}" style="background:none;border:none;cursor:pointer;color:var(--text-dim);font-size:0.8rem;margin-left:auto;padding:2px 4px">🔊</button>
      </div>`).join('');
    if (exEl) exEl.textContent = v.ex?.futur || '';
  }
}
window.renderLearnTenseTable = renderLearnTenseTable;

// ────────────────────────────────────────────────
// Deferred inits — call from app.js after window.nextPhrase
// and window.learnVerbStart are set (lines 360 and 389)
// ────────────────────────────────────────────────
export function initExercisesAfterLoad() {
  // Override nextPhrase to support AI modes
  window.nextPhrase = function() {
    if (phMode !== 'fill') window.loadAIPhrase();
    else phrasesNextPhrase(_getPhrases(), _getVerbs());
  };

  // Override learnVerbStart to reset tense to présent each time
  const _origLearnVerbStart = window.learnVerbStart;
  window.learnVerbStart = function(verbId) {
    learnCurrentTense = 'present';
    window.learnCurrentTense = 'present';
    _origLearnVerbStart?.(verbId);
  };
}
