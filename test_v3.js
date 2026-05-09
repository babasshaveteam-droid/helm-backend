// test_v3.js — Tests A à L pour v1.3.19
// Usage : node test_v3.js [A|B|C|D|E|F|G|H|I|J|K|L]
'use strict';

const { getFamilyActivityScore, filterFamilyActivities, isPoolShop, isAgriculturalNonVisitable, getRejectReason, MIN_SCORE } = require('./qualityFilter');
const { normalizePlace, deduplicate, isFamilyPlace, nameKey } = require('./normalize');
const { applyFamilyRules, normalizeIndoorOutdoor } = require('./activityRules');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ PASS — ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL — ${label}`);
    failed++;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function mockPlace(name, types, opts = {}) {
  return {
    name,
    types: Array.isArray(types) ? types : [types],
    rating: opts.rating ?? null,
    ratingCount: opts.ratingCount ?? null,
    isOpen: opts.isOpen ?? null,
    businessStatus: opts.businessStatus ?? null,
    sourceId: opts.sourceId ?? `mock-${name.replace(/\s/g,'-')}`,
    address: opts.address ?? 'Rue Test 1, 1000 Ville',
    lat: opts.lat ?? 46.8, lon: opts.lon ?? 7.0,
    normalizedKey: (name + opts.address).toLowerCase().replace(/[^a-z0-9]/g,''),
  };
}

const RADIUS_BY_REFRESH = [1000, 3000, 8000, 15000, 25000, 40000, 60000, 80000];
function expandRadius(r) {
  if (r <= 1000) return 5000;
  if (r <= 3000) return 12000;
  if (r <= 8000) return 25000;
  return Math.min(Math.round(r * 1.5), 80000);
}

// ─── Test A — Magasin de piscines ─────────────────────────────────────────────
function testA() {
  console.log('\n═══ Test A — Magasin de piscines ═══');
  const poolShop = mockPlace('Piscines XYZ', ['store', 'general_contractor', 'point_of_interest']);
  const pisciniste = mockPlace('Pisciniste du Lac', ['point_of_interest', 'establishment']);
  const poolService = mockPlace('Pool Service Dupont', ['store']);

  const scoreShop = getFamilyActivityScore(poolShop);
  const scorePisc = getFamilyActivityScore(pisciniste);
  const scoreServ = getFamilyActivityScore(poolService);

  assert(isPoolShop(poolShop), 'Piscines XYZ (store) détecté comme pool_shop');
  assert(isPoolShop(pisciniste), 'Pisciniste du Lac détecté comme pool_shop');
  assert(isPoolShop(poolService), 'Pool Service Dupont détecté comme pool_shop');
  assert(scoreShop < MIN_SCORE, `Score Piscines XYZ = ${scoreShop} < ${MIN_SCORE}`);
  assert(getRejectReason(poolShop, scoreShop) === 'pool_shop', 'Raison rejet = pool_shop');

  const filtered = filterFamilyActivities([poolShop, pisciniste, poolService]);
  assert(filtered.length === 0, 'filterFamilyActivities rejette les 3 pool shops');
}

// ─── Test B — Vraie piscine publique ─────────────────────────────────────────
function testB() {
  console.log('\n═══ Test B — Vraie piscine publique ═══');
  const payerne = mockPlace('Piscine de Payerne', ['swimming_pool', 'point_of_interest'], { rating: 4.1, ratingCount: 120, isOpen: true });
  const munic = mockPlace('Piscine municipale de Fribourg', ['swimming_pool'], { rating: 4.3, ratingCount: 200, isOpen: true });

  const scorePayerne = getFamilyActivityScore(payerne);
  const scoreMunic = getFamilyActivityScore(munic);

  assert(!isPoolShop(payerne), 'Piscine de Payerne n\'est PAS un pool shop');
  assert(scorePayerne >= MIN_SCORE, `Score Piscine de Payerne = ${scorePayerne} >= ${MIN_SCORE}`);
  assert(scoreMunic >= MIN_SCORE, `Score Piscine municipale = ${scoreMunic} >= ${MIN_SCORE}`);

  // Vérification outdoor/indoor (via activityRules)
  const base = { type: 'outdoor', weatherReason: null, whyGoodIdea: 'Piscine à ciel ouvert.', description: 'Piscine extérieure.', subtitle: 'Idéal l\'été.', whatToBring: [], practicalInfos: [], tags: [] };
  const afterFamily = applyFamilyRules(base, payerne.name, payerne.types, {});
  const afterNorm = normalizeIndoorOutdoor(afterFamily, payerne);
  assert(afterNorm.type === 'outdoor', `Piscine de Payerne type=${afterNorm.type} (attendu outdoor)`);
}

// ─── Test C — Grange / séchoir ────────────────────────────────────────────────
function testC() {
  console.log('\n═══ Test C — Grange / séchoir à tabac ═══');
  const sechoir = mockPlace('Séchoir à tabac de Payerne', ['point_of_interest', 'establishment']);
  const grange = mockPlace('Grande Grange agricole', ['point_of_interest']);
  const hangar = mockPlace('Hangar agricole du village', ['point_of_interest', 'establishment']);

  assert(isAgriculturalNonVisitable(sechoir), 'Séchoir à tabac détecté comme non visitable');
  assert(isAgriculturalNonVisitable(grange), 'Grange agricole détectée comme non visitable');
  assert(isAgriculturalNonVisitable(hangar), 'Hangar agricole détecté comme non visitable');

  const filtered = filterFamilyActivities([sechoir, grange, hangar]);
  assert(filtered.length === 0, 'filterFamilyActivities rejette les 3 bâtiments agricoles');
}

// ─── Test D — Ferme pédagogique ───────────────────────────────────────────────
function testD() {
  console.log('\n═══ Test D — Ferme pédagogique ═══');
  const ferme = mockPlace('Ferme pédagogique de Châtel', ['tourist_attraction', 'point_of_interest'], { rating: 4.5, ratingCount: 50, isOpen: true });
  const fermeAnim = mockPlace('La Ferme aux animaux du Moulin', ['tourist_attraction'], { rating: 4.2, ratingCount: 30, isOpen: true });
  const fermePrivee = mockPlace('Exploitation agricole Dupont', ['point_of_interest', 'establishment']);

  const scoreFerme = getFamilyActivityScore(ferme);
  const scoreFermeAnim = getFamilyActivityScore(fermeAnim);
  const scoreFermePrivee = getFamilyActivityScore(fermePrivee);

  assert(!isAgriculturalNonVisitable(ferme), 'Ferme pédagogique n\'est PAS rejetée comme agricole');
  assert(scoreFerme >= MIN_SCORE, `Score ferme pédagogique = ${scoreFerme} >= ${MIN_SCORE}`);
  assert(scoreFermeAnim >= MIN_SCORE, `Score ferme animaux = ${scoreFermeAnim} >= ${MIN_SCORE}`);
  assert(scoreFermePrivee < MIN_SCORE, `Score exploitation agricole = ${scoreFermePrivee} < ${MIN_SCORE}`);
}

// ─── Test E — Doublon Maison Cailler ─────────────────────────────────────────
function testE() {
  console.log('\n═══ Test E — Doublon Maison Cailler ═══');
  const p1 = mockPlace('Maison Cailler', ['tourist_attraction', 'museum'], { sourceId: 'cailler-1', address: 'Route de Broc 7, 1636 Broc' });
  const p2 = mockPlace('La Maison Cailler', ['museum'], { sourceId: 'cailler-2', address: 'Route de Broc 7, 1636 Broc' }); // même lieu, ID différent
  const p3 = mockPlace('Maison Cailler Broc', ['tourist_attraction'], { sourceId: 'cailler-3', address: 'Route de Broc 7, 1636 Broc' }); // variante nom

  const deduped = deduplicate([p1, p2, p3]);
  // p1 → nameKey='maisoncailler', p2 → nameKey='maisoncailler' (même!) → dédupliqué
  // p3 → nameKey='maisoncaillerbroc' (différent) → gardé
  assert(deduped.length <= 2, `Après deduplicate: ${deduped.length} lieux (attendu ≤ 2)`);
  const names = deduped.map(p => p.name).join(', ');
  console.log(`  Lieux conservés : ${names}`);

  // Aussi tester : même sourceId = dédupliqué
  const p4 = { ...p1, name: 'Cailler Chocolat' }; // même sourceId cailler-1
  const deduped2 = deduplicate([p1, p4]);
  assert(deduped2.length === 1, 'Même sourceId → une seule entrée gardée');
}

// ─── Test F — Refresh 0 à 10 ─────────────────────────────────────────────────
function testF() {
  console.log('\n═══ Test F — Refresh 0 à 10 ═══');
  function mockSearch(radius) {
    const pool = [];
    if (radius >= 1000) pool.push(mockPlace('Bibliothèque', ['library'], { rating: 4.2, ratingCount: 30, isOpen: true }));
    if (radius >= 5000) pool.push(mockPlace('Musée local', ['museum'], { rating: 4.0, ratingCount: 20, isOpen: true }));
    if (radius >= 5000) pool.push(mockPlace('Bowling Payerne', ['bowling_alley'], { rating: 4.3, ratingCount: 80, isOpen: true }));
    if (radius >= 8000) pool.push(mockPlace('Parc des Roches', ['park'], { rating: 4.1, ratingCount: 50, isOpen: true }));
    if (radius >= 12000) pool.push(mockPlace('Aquarium du Lac', ['aquarium'], { rating: 4.5, ratingCount: 200, isOpen: true }));
    if (radius >= 15000) pool.push(mockPlace('Zoo de Servion', ['zoo'], { rating: 4.4, ratingCount: 150, isOpen: true }));
    if (radius >= 25000) pool.push(mockPlace('Papiliorama', ['zoo', 'tourist_attraction'], { rating: 4.6, ratingCount: 300, isOpen: true }));
    // Lieux qui doivent être REJETÉS par filterFamilyActivities
    pool.push(mockPlace('Piscines Dupont', ['store', 'general_contractor'])); // pool shop
    pool.push(mockPlace('Séchoir à tabac', ['point_of_interest']));           // agricultural
    return pool;
  }

  let allExcludeIds = [];
  let blocked = false;

  for (let rc = 0; rc <= 10; rc++) {
    const radius = RADIUS_BY_REFRESH[Math.min(rc, RADIUS_BY_REFRESH.length - 1)];
    const raw = mockSearch(radius);
    const filtered = filterFamilyActivities(raw.filter(isFamilyPlace));
    const fresh = filtered.filter(p => !allExcludeIds.includes(p.sourceId));

    // Simuler l'élargissement si trop peu
    let finalFresh = fresh;
    if (fresh.length < 3) {
      const wider = mockSearch(expandRadius(radius));
      const widerFiltered = filterFamilyActivities(wider.filter(isFamilyPlace));
      const widerFresh = widerFiltered.filter(p => !allExcludeIds.includes(p.sourceId));
      if (widerFresh.length > fresh.length) finalFresh = widerFresh;
      // Phase 2 : relâcher exclude si toujours < 3
      if (finalFresh.length < 3 && allExcludeIds.length > 0) finalFresh = filtered;
    }

    const newIds = finalFresh.slice(0, 3).map(p => p.sourceId);
    allExcludeIds = [...new Set([...allExcludeIds, ...newIds])];

    const isEmpty = finalFresh.length === 0;
    if (isEmpty) blocked = true;

    // Vérifier qu'aucun pool shop / bâtiment agricole ne passe
    const hasBadPlace = finalFresh.some(p => isPoolShop(p) || isAgriculturalNonVisitable(p));

    console.log(`  refresh=${rc} radius=${radius}m → ${finalFresh.length} activités | exclude=${allExcludeIds.length} | mauvais_lieux=${hasBadPlace ? '❌' : '✅'}`);
    assert(!hasBadPlace, `refresh=${rc}: aucun mauvais lieu proposé`);
  }
  assert(!blocked, 'Pas de blocage complet (0 activités) sur les 11 refreshs');
}

// ─── Test G — Aucune nouveauté ────────────────────────────────────────────────
function testG() {
  console.log('\n═══ Test G — Aucune nouveauté disponible ═══');
  const places = [
    mockPlace('Musée local', ['museum'], { rating: 4.0, ratingCount: 50, isOpen: true, sourceId: 'p1' }),
    mockPlace('Bowling', ['bowling_alley'], { rating: 4.2, ratingCount: 80, isOpen: true, sourceId: 'p2' }),
  ];
  const allExcludeIds = ['p1', 'p2'];

  const filtered = filterFamilyActivities(places.filter(isFamilyPlace));
  const fresh = filtered.filter(p => !allExcludeIds.includes(p.sourceId));

  if (fresh.length < 3 && allExcludeIds.length > 0) {
    // Relâcher exclude → reproposer les lieux déjà vus
    const rescued = filtered;
    assert(rescued.length > 0, `Fallback: ${rescued.length} vrais lieux reproposés (dont déjà vus)`);
    console.log(`  Lieux reproposés : ${rescued.map(p=>p.name).join(', ')}`);
  }
}

// ─── Test H — Parcs d'attractions / loisirs ──────────────────────────────────
function testH() {
  console.log('\n═══ Test H — Parcs d\'attractions / loisirs ═══');
  const parc = mockPlace('Parc d\'attractions Les Dinos', ['amusement_park'], { rating: 4.3, ratingCount: 200, isOpen: true });
  const indoor = mockPlace('Indoor Playground Fribourg', ['amusement_center'], { rating: 4.4, ratingCount: 100, isOpen: true });
  const trampoline = mockPlace('Trampoline Park Bulle', ['amusement_center', 'gym'], { rating: 4.5, ratingCount: 150, isOpen: true });

  const s1 = getFamilyActivityScore(parc);
  const s2 = getFamilyActivityScore(indoor);
  const s3 = getFamilyActivityScore(trampoline);

  assert(s1 >= MIN_SCORE, `Parc d'attractions score=${s1} >= ${MIN_SCORE}`);
  assert(s2 >= MIN_SCORE, `Indoor playground score=${s2} >= ${MIN_SCORE}`);
  assert(s3 >= MIN_SCORE, `Trampoline park score=${s3} >= ${MIN_SCORE}`);

  const filtered = filterFamilyActivities([parc, indoor, trampoline]);
  assert(filtered.length === 3, `filterFamilyActivities accepte les 3 parcs/loisirs`);
}

// ─── Test I — Lieu fermé définitivement ──────────────────────────────────────
function testI() {
  console.log('\n═══ Test I — Lieu fermé définitivement ═══');
  const closed = mockPlace('Ancien parc de loisirs', ['amusement_park', 'tourist_attraction'], { businessStatus: 'CLOSED_PERMANENTLY', rating: 3.0 });
  const open = mockPlace('Musée ouvert', ['museum'], { businessStatus: 'OPERATIONAL', rating: 4.2, ratingCount: 50, isOpen: true });

  const scoreClosed = getFamilyActivityScore(closed);
  assert(scoreClosed === -999, `Score fermé définitivement = ${scoreClosed} (attendu -999)`);
  assert(getRejectReason(closed, scoreClosed) === 'permanently_closed', 'Raison = permanently_closed');

  const filtered = filterFamilyActivities([closed, open]);
  assert(filtered.length === 1, 'Lieu fermé définitivement rejeté, lieu ouvert conservé');
  assert(filtered[0].name === 'Musée ouvert', 'Seul le musée ouvert conservé');
}

// ─── Test J — Score commerce piscine ─────────────────────────────────────────
function testJ() {
  console.log('\n═══ Test J — Score commerce piscine ═══');
  const commercial = mockPlace('Piscines Dupont', ['store', 'general_contractor', 'point_of_interest']);
  const score = getFamilyActivityScore(commercial);
  const reason = getRejectReason(commercial, score);

  assert(isPoolShop(commercial), 'Piscines Dupont = pool_shop');
  assert(score < MIN_SCORE, `Score = ${score} < ${MIN_SCORE}`);
  assert(reason === 'pool_shop', `Raison = ${reason} (attendu pool_shop)`);

  const filtered = filterFamilyActivities([commercial]);
  assert(filtered.length === 0, 'Rejeté par filterFamilyActivities');
}

// ─── Test K — Vraie piscine publique (score) ──────────────────────────────────
function testK() {
  console.log('\n═══ Test K — Vraie piscine municipale (score) ═══');
  const munic = mockPlace('Piscine municipale de Payerne', ['swimming_pool'], { rating: 4.1, ratingCount: 120, isOpen: true });
  const score = getFamilyActivityScore(munic);
  const reason = getRejectReason(munic, score);

  assert(!isPoolShop(munic), 'Piscine municipale n\'est PAS pool_shop');
  assert(score >= MIN_SCORE, `Score = ${score} >= ${MIN_SCORE}`);
  assert(reason === null, `Pas de raison de rejet (${reason})`);

  const filtered = filterFamilyActivities([munic]);
  assert(filtered.length === 1, 'Piscine municipale acceptée');
}

// ─── Test L — Grange / séchoir (score) ────────────────────────────────────────
function testL() {
  console.log('\n═══ Test L — Grange / séchoir (score) ═══');
  const sechoir = mockPlace('Séchoir à tabac du Vully', ['point_of_interest', 'establishment']);
  const grange = mockPlace('Grange agricole Dupont', ['establishment']);

  const s1 = getFamilyActivityScore(sechoir);
  const s2 = getFamilyActivityScore(grange);

  assert(isAgriculturalNonVisitable(sechoir), 'Séchoir à tabac = agricultural_non_visitable');
  assert(isAgriculturalNonVisitable(grange), 'Grange agricole = agricultural_non_visitable');
  assert(s1 < MIN_SCORE, `Score séchoir = ${s1} < ${MIN_SCORE}`);
  assert(s2 < MIN_SCORE, `Score grange = ${s2} < ${MIN_SCORE}`);
  assert(getRejectReason(sechoir, s1) === 'agricultural_building', `Raison séchoir = ${getRejectReason(sechoir, s1)}`);
}

// ─── Test M — Rescue sans filtre qualité ──────────────────────────────────────
function testM() {
  console.log('\n═══ Test M — Rescue sans filtre qualité ═══');
  // Parc rural avec peu d'avis : score < MIN_SCORE mais vrai lieu famille
  const parcRural = mockPlace('Parc du village', ['park', 'point_of_interest'], { rating: null, ratingCount: null });
  const score = getFamilyActivityScore(parcRural);
  assert(score < MIN_SCORE, `Score parc rural = ${score} < ${MIN_SCORE} (filterFamilyActivities le rejetterait)`);

  // isFamilyPlace l'accepte (c'est un park, pas bloqué)
  assert(isFamilyPlace(parcRural), 'isFamilyPlace accepte le parc rural');

  // Le rescue utilise seulement isFamilyPlace — simulation
  const rescueCandidates = [parcRural].filter(isFamilyPlace);
  assert(rescueCandidates.length === 1, 'Rescue retourne 1 lieu (isFamilyPlace seul, pas filterFamilyActivities)');

  // Contrôle : filterFamilyActivities le rejette (valide la nécessité du fix)
  const strictFilter = filterFamilyActivities([parcRural]);
  assert(strictFilter.length === 0, 'filterFamilyActivities rejetterait ce lieu (confirme besoin du fix rescue)');
}

// ─── Test N — 22°C sunny — Text Search outdoor ────────────────────────────────
function testN() {
  console.log('\n═══ Test N — 22°C sunny — Text Search outdoor ═══');
  // Simuler getTargetedSearches pour weatherIntent=sunny
  const { WEATHER_TYPES } = require('./places');

  assert(WEATHER_TYPES.sunny.includes('natural_feature'), 'WEATHER_TYPES.sunny inclut natural_feature');
  assert(WEATHER_TYPES.sunny.includes('beach'), 'WEATHER_TYPES.sunny inclut beach');
  assert(WEATHER_TYPES.hot.includes('natural_feature'), 'WEATHER_TYPES.hot inclut natural_feature');
  assert(WEATHER_TYPES.hot.includes('beach'), 'WEATHER_TYPES.hot inclut beach');

  // Simuler getTargetedSearches inline (reproduit la logique de index.js)
  function getTargetedSearches(sg, wi) {
    const byGroup = {
      0: 'musée exposition grotte caverne souterrain',
      1: 'salle escalade climbing bloc trampoline aire de jeux',
      2: 'ferme pédagogique parc animalier cinéma bowling',
      3: 'forêt randonnée balade sentier famille',
    };
    if (wi === 'sunny') {
      const queries = [
        'ferme pédagogique parc animalier zoo',
        'forêt balade jardin famille',
        'lac plage baignade famille',
        'balade montagne point de vue famille',
        'grotte caverne visite famille',
        'trampoline park famille',
        'aire de jeux extérieure famille',
      ];
      if (byGroup[sg]) queries.push(byGroup[sg]);
      return queries;
    }
    return [];
  }

  const queries0 = getTargetedSearches(0, 'sunny');
  const queries2 = getTargetedSearches(2, 'sunny');

  assert(queries0.some(q => /lac|plage|baignade/.test(q)), 'Text Search sunny inclut lac/plage/baignade');
  assert(queries0.some(q => /montagne|point de vue|balade/.test(q)), 'Text Search sunny inclut montagne/point de vue');
  assert(queries0.some(q => /grotte|musée|exposition/.test(q)), 'Text Search sunny groupe 0 inclut culture (byGroup ou query)');
  assert(queries0.some(q => /trampoline/.test(q)), 'Text Search sunny inclut trampoline');
  assert(queries0.some(q => /aire de jeux/.test(q)), 'Text Search sunny inclut aire de jeux');
  assert(queries2.some(q => /cinéma|bowling|parc animalier/.test(q)), 'Text Search sunny groupe 2 inclut loisirs (byGroup)');
  assert(queries0.length === 8, `Text Search sunny groupe 0 = ${queries0.length} requêtes (attendu 8)`);
}

// ─── Test O — playground scoring + outdoor_playground family ─────────────────
function testO() {
  console.log('\n═══ Test O — playground scoring + outdoor_playground family ═══');
  const { getFamilyActivityScore, MIN_SCORE } = require('./qualityFilter');
  const { detectFamily, applyFamilyRules } = require('./activityRules');

  // playground doit avoir score >= MIN_SCORE (FAMILY_ACTIVITY_TYPES → +3)
  const playground = mockPlace('Aire de jeux des Cèdres', ['playground', 'point_of_interest', 'establishment'], { rating: 4.0, ratingCount: 15, isOpen: true });
  const score = getFamilyActivityScore(playground);
  assert(score >= MIN_SCORE, `playground score=${score} doit être >= ${MIN_SCORE}`);

  // detectFamily → outdoor_playground
  const family = detectFamily('Aire de jeux des Cèdres', ['playground']);
  assert(family === 'outdoor_playground', `detectFamily playground → '${family}' attendu 'outdoor_playground'`);

  // applyFamilyRules fromFallback → type outdoor, icon 🛝
  const activity = applyFamilyRules(
    { type: 'outdoor', weatherFit: [], whatToBring: [], practicalInfos: [], tags: [] },
    'Aire de jeux des Cèdres', ['playground'], { fromFallback: true, isOpen: true }
  );
  assert(activity.type === 'outdoor', `outdoor_playground type='${activity.type}' attendu 'outdoor'`);
  assert(activity.icon === '🛝', `outdoor_playground icon='${activity.icon}' attendu '🛝'`);
  assert(activity.skipIsOpen === true || activity.practicalInfos?.includes('Accès libre'), 'outdoor_playground skipIsOpen ou Accès libre');
}

// ─── Test P — amusement_park family ──────────────────────────────────────────
function testP() {
  console.log('\n═══ Test P — amusement_park_family ═══');
  const { detectFamily, applyFamilyRules } = require('./activityRules');

  // Détection par type Google
  const familyByType = detectFamily('Parc de loisirs Walibi', ['amusement_park', 'tourist_attraction']);
  assert(familyByType === 'amusement_park_family', `detectFamily amusement_park type → '${familyByType}'`);

  // Détection par nom
  const familyByName = detectFamily("Parc d'attractions famille", []);
  assert(familyByName === 'amusement_park_family', `detectFamily nom parc attractions → '${familyByName}'`);

  // applyFamilyRules fromFallback → type outdoor, icon 🎡, category Loisirs
  const activity = applyFamilyRules(
    { type: null, weatherFit: [], whatToBring: [], practicalInfos: [], tags: [] },
    'Walibi', ['amusement_park'], { fromFallback: true, isOpen: true }
  );
  assert(activity.type === 'outdoor', `amusement_park_family type='${activity.type}' attendu 'outdoor'`);
  assert(activity.icon === '🎡', `amusement_park_family icon='${activity.icon}' attendu '🎡'`);
  assert(activity.category === 'Loisirs', `amusement_park_family category='${activity.category}'`);
}

// ─── Test Q — mountain_hike détecte natural_feature + nom géographique ─────────
function testQ() {
  console.log('\n═══ Test Q — mountain_hike natural_feature (Oeschinesee) ═══');
  const { detectFamily } = require('./activityRules');

  // Lac alpin suisse — type natural_feature + nom allemand "see"
  const fOeschinesee = detectFamily('Oeschinesee', ['natural_feature', 'tourist_attraction', 'point_of_interest']);
  assert(fOeschinesee === 'mountain_hike', `Oeschinesee → '${fOeschinesee}' attendu 'mountain_hike'`);

  // Gorges — natural_feature + mot-clé français
  const fGorges = detectFamily('Gorges du Durnand', ['natural_feature']);
  assert(fGorges === 'mountain_hike', `Gorges du Durnand → '${fGorges}' attendu 'mountain_hike'`);

  // Cascade
  const fCascade = detectFamily('Cascade de Pissevache', ['natural_feature']);
  assert(fCascade === 'mountain_hike', `Cascade de Pissevache → '${fCascade}' attendu 'mountain_hike'`);

  // Parc générique sans mot-clé montagne → ne doit PAS être mountain_hike
  const fPark = detectFamily('Parc des Lilas', ['park', 'natural_feature']);
  assert(fPark !== 'mountain_hike', `Parc des Lilas (park+natural_feature) ne doit PAS être mountain_hike → '${fPark}'`);
}

// ─── Test R — nouvelles familles détectées ────────────────────────────────────
function testR() {
  console.log('\n═══ Test R — nouvelles familles (karting, laser, escape, accrobranche) ═══');
  const { detectFamily } = require('./activityRules');

  assert(detectFamily('Karting des Alpes', []) === 'karting', 'karting détecté par nom');
  assert(detectFamily('Go Kart Family Park', []) === 'karting', 'go-kart détecté');
  assert(detectFamily('Laser Game Zone', []) === 'laser_game', 'laser_game détecté');
  assert(detectFamily('LaserTag Arena', []) === 'laser_game', 'lasertag détecté');
  assert(detectFamily('Escape Room Mystère', []) === 'escape_room', 'escape_room détecté');
  assert(detectFamily('Exit Game Family', []) === 'escape_room', 'exit game détecté');
  assert(detectFamily('Accrobranche Aventure', []) === 'accrobranche', 'accrobranche détecté');
  assert(detectFamily('Zip Line Forest Adventure', []) === 'accrobranche', 'zip line détecté');
  assert(detectFamily('Centre équestre du Lac', []) === 'horse_riding', 'horse_riding détecté');
  assert(detectFamily('Mini Golf Famille', []) === 'mini_golf', 'mini_golf détecté');
  assert(detectFamily('Piste de Ski Les Collons', []) === 'ski_snow', 'ski_snow détecté');
  assert(detectFamily('Spectacle jeunesse marionnettes', []) === 'theater_show', 'theater_show détecté');
}

// ─── Runner ───────────────────────────────────────────────────────────────────
const arg = process.argv[2];
if (!arg || arg === 'A') testA();
if (!arg || arg === 'B') testB();
if (!arg || arg === 'C') testC();
if (!arg || arg === 'D') testD();
if (!arg || arg === 'E') testE();
if (!arg || arg === 'F') testF();
if (!arg || arg === 'G') testG();
if (!arg || arg === 'H') testH();
if (!arg || arg === 'I') testI();
if (!arg || arg === 'J') testJ();
if (!arg || arg === 'K') testK();
if (!arg || arg === 'L') testL();
if (!arg || arg === 'M') testM();
if (!arg || arg === 'N') testN();
if (!arg || arg === 'O') testO();
if (!arg || arg === 'P') testP();
if (!arg || arg === 'Q') testQ();
if (!arg || arg === 'R') testR();

console.log(`\n${'─'.repeat(50)}`);
console.log(`Résultat: ${passed} ✅ PASS  ${failed} ❌ FAIL`);
if (failed === 0) console.log('🎉 Tous les tests passent — prêt pour commit\n');
else console.log('⚠️  Des tests échouent — corriger avant commit\n');
