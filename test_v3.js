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

console.log(`\n${'─'.repeat(50)}`);
console.log(`Résultat: ${passed} ✅ PASS  ${failed} ❌ FAIL`);
if (failed === 0) console.log('🎉 Tous les tests passent — prêt pour commit\n');
else console.log('⚠️  Des tests échouent — corriger avant commit\n');
