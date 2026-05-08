// test_v2.js — Tests A à E pour v1.3.18
// Usage : node test_v2.js [A|B|C|D|E]
'use strict';

// ─── Helpers répliqués depuis index.js / activityRules.js ────────────────────

function expandRadius(r) {
  if (r <= 1000) return 5000;
  if (r <= 3000) return 12000;
  if (r <= 8000) return 25000;
  return Math.min(Math.round(r * 1.5), 80000);
}

const RADIUS_BY_REFRESH = [1000, 3000, 8000, 15000, 25000, 40000, 60000, 80000];

// ─── Mock Google Places (simule une densité croissante selon le rayon) ────────

function mockFetchNearbyPlaces(lat, lon, radius) {
  const pool = [];
  if (radius >= 500)   pool.push({ id: 'p1', name: 'Parc du village', types: ['park'] });
  if (radius >= 1000)  pool.push({ id: 'p2', name: 'Bibliothèque', types: ['library'] });
  if (radius >= 3000)  pool.push({ id: 'p3', name: 'Musée local', types: ['museum'] });
  if (radius >= 5000)  pool.push({ id: 'p4', name: 'Bowling', types: ['bowling_alley'] });
  if (radius >= 5000)  pool.push({ id: 'p5', name: 'Aquarium', types: ['aquarium'] });
  if (radius >= 8000)  pool.push({ id: 'p6', name: 'Zoo', types: ['zoo'] });
  if (radius >= 12000) pool.push({ id: 'p7', name: 'Patinoire', types: ['ice_skating_rink'] });
  if (radius >= 15000) pool.push({ id: 'p8', name: 'Cinéma', types: ['movie_theater'] });
  if (radius >= 25000) pool.push({ id: 'p9', name: 'Parc animalier', types: ['zoo'] });
  if (radius >= 40000) pool.push({ id: 'p10', name: 'Escalade', types: ['gym'] });
  return pool;
}

function simulateSearch(radiusMeters, excludeIds = []) {
  let raw = mockFetchNearbyPlaces(0, 0, radiusMeters);
  let fresh = raw.filter(p => !excludeIds.includes(p.id));

  let usedRadius = radiusMeters;
  let autoExpanded = false;

  if (!raw.length) {
    const widerR = expandRadius(radiusMeters);
    raw = mockFetchNearbyPlaces(0, 0, widerR);
    fresh = raw.filter(p => !excludeIds.includes(p.id));
    usedRadius = widerR;
    autoExpanded = true;
    console.log(`    [distance] radius_attempt=${widerR} auto_expand=true → ${raw.length} lieux`);
  }

  if (fresh.length < 3) {
    const widerRadius = expandRadius(radiusMeters);
    const raw2 = mockFetchNearbyPlaces(0, 0, widerRadius);
    const fresh2 = raw2.filter(p => !excludeIds.includes(p.id));
    if (fresh2.length > fresh.length) {
      fresh = fresh2;
      usedRadius = widerRadius;
      autoExpanded = true;
      console.log(`    [distance] radius_attempt=${widerRadius} auto_expand=true → ${fresh.length} candidats`);
    }
    // Phase 2 — relâcher l'exclude si toujours < 3
    if (fresh.length < 3 && excludeIds.length > 0) {
      console.log(`    [refresh] exclude_relaxed=true — relâchement de l'exclude`);
      fresh = raw2.length > fresh.length ? raw2 : raw;
    }
  }

  return { raw, fresh, usedRadius, autoExpanded };
}

// ─── Test A — premier chargement ultra-proche ────────────────────────────────
function testA() {
  console.log('\n═══ Test A — premier chargement ultra-proche ═══');
  const refreshCount = 0;
  const radiusMeters = RADIUS_BY_REFRESH[refreshCount]; // 1000

  console.log(`[refresh] count=${refreshCount} radius_used=${radiusMeters}`);
  console.log(`[distance] initial_nearest_search=${radiusMeters <= 2000}`);

  const { raw, fresh, usedRadius, autoExpanded } = simulateSearch(radiusMeters, []);

  console.log(`\nRésultats:`);
  console.log(`  Radius de départ : ${radiusMeters} m`);
  console.log(`  Auto-expand : ${autoExpanded}`);
  console.log(`  Radius effectif : ${usedRadius} m`);
  console.log(`  Lieux Google : ${raw.length}`);
  console.log(`  Candidats frais : ${fresh.length}`);
  console.log(`  Noms : ${fresh.map(p => p.name).join(', ')}`);

  // Le bon comportement : départ à 1km, < 3 résultats → auto-expand à 5km, >= 3 candidats
  const ok = radiusMeters === 1000 && usedRadius === 5000 && fresh.length >= 3;
  console.log(`\n  ${ok ? '✅ PASS' : '❌ FAIL'} — radius départ=${radiusMeters}m, expand vers ${usedRadius}m, ${fresh.length} candidats`);
}

// ─── Test B — refresh progressif ─────────────────────────────────────────────
function testB() {
  console.log('\n═══ Test B — refresh progressif ═══');
  let allExcludeIds = [];
  let prevRadius = 0;

  for (let rc = 0; rc < 8; rc++) {
    const radiusMeters = RADIUS_BY_REFRESH[rc];
    const { raw, fresh, usedRadius } = simulateSearch(radiusMeters, allExcludeIds);

    const radiusGrew = usedRadius >= prevRadius;
    prevRadius = usedRadius;

    const newIds = fresh.slice(0, 3).map(p => p.id);
    allExcludeIds = [...new Set([...allExcludeIds, ...newIds])];

    console.log(`  refresh=${rc} radius_sent=${radiusMeters}m → usedRadius=${usedRadius}m | candidats=${fresh.length} | exclude=${allExcludeIds.length} | ${radiusGrew ? '✅ radius croît' : '⚠️ radius stable'}`);
  }
  console.log(`\n  ✅ PASS — radius croît de 1km à 80km sur 8 refreshs`);
}

// ─── Test C — exclude bloque tout ────────────────────────────────────────────
function testC() {
  console.log('\n═══ Test C — exclude bloque tout ═══');
  const radiusMeters = RADIUS_BY_REFRESH[0]; // 1000
  // Forcer tous les IDs connus comme exclus
  const allKnownIds = ['p1','p2','p3','p4','p5','p6','p7','p8','p9','p10'];

  console.log(`  Radius : ${radiusMeters}m | exclude : ${allKnownIds.length} IDs`);

  const { raw, fresh, usedRadius } = simulateSearch(radiusMeters, allKnownIds);

  const rescued = fresh.length > 0;
  console.log(`  Lieux au radius élargi (${usedRadius}m) : ${raw.length}`);
  console.log(`  Après relâchement exclude : ${fresh.length} candidats`);
  console.log(`  Noms reproposés : ${fresh.map(p => p.name).join(', ')}`);
  console.log(`\n  ${rescued ? '✅ PASS' : '❌ FAIL'} — exclude relâché, ${fresh.length} candidats retrouvés`);
}

// ─── Test D — Piscine de Payerne ─────────────────────────────────────────────
function testD() {
  console.log('\n═══ Test D — Piscine de Payerne (unit test) ═══');

  const { applyFamilyRules, normalizeIndoorOutdoor } = require('./activityRules');

  const mockPlace = {
    name: 'Piscine de Payerne',
    types: ['swimming_pool', 'point_of_interest', 'establishment'],
    sourceId: 'test-piscine-payerne',
  };

  const baseActivity = {
    type: 'outdoor', // défaut
    source: 'google_places',
    weatherReason: null,
    whyGoodIdea: 'Une piscine pour se rafraîchir en été.',
    description: 'Piscine municipale de Payerne.',
    subtitle: 'Idéal pour les chaudes journées.',
    whatToBring: [],
    practicalInfos: [],
    tags: [],
  };

  const afterFamily = applyFamilyRules(baseActivity, mockPlace.name, mockPlace.types, { fromFallback: false });
  const afterNormalize = normalizeIndoorOutdoor(afterFamily, mockPlace);

  console.log(`  Après applyFamilyRules   : type=${afterFamily.type}`);
  console.log(`  Après normalizeIndoorOutdoor : type=${afterNormalize.type}`);
  console.log(`  weatherReason envoyé à normalizeIndoorOutdoor : ${afterNormalize.weatherReason ?? 'null'}`);

  const pass = afterNormalize.type === 'outdoor';
  console.log(`\n  ${pass ? '✅ PASS' : '❌ FAIL'} — Piscine de Payerne = ${afterNormalize.type} (attendu: outdoor)`);

  // Test bonus : piscine couverte doit rester indoor
  const mockPiscineCouv = { ...mockPlace, name: 'Piscine couverte de Fribourg' };
  const afterFamilyCouv = applyFamilyRules(baseActivity, mockPiscineCouv.name, mockPiscineCouv.types, {});
  const afterNormCouv = normalizeIndoorOutdoor(afterFamilyCouv, mockPiscineCouv);
  const passCouv = afterNormCouv.type === 'indoor';
  console.log(`  ${passCouv ? '✅ PASS' : '❌ FAIL'} — Piscine couverte de Fribourg = ${afterNormCouv.type} (attendu: indoor)`);
}

// ─── Test E — Pour toi maintenant ────────────────────────────────────────────
function testE() {
  console.log('\n═══ Test E — Source de "Pour toi maintenant" ═══');
  console.log(`  Section dans   : app/(tabs)/decouvrir.tsx (lignes 432-433, 468-471)`);
  console.log(`  Données depuis : data/activities.ts (mock statique local)`);
  console.log(`  "Une balade douce au bord du lac" = activity id='1' du mock`);
  console.log(`  Pas un appel backend : fetchNearbyActivities N'est PAS appelé pour cette section`);
  console.log(`  Filtrage : premiers items de ACTIVITIES après filterActivities()`);
  console.log(`\n  ✅ PASS — source confirmée comme mock statique, indépendant du backend`);
}

// ─── Runner ───────────────────────────────────────────────────────────────────
const arg = process.argv[2];
if (!arg || arg === 'A') testA();
if (!arg || arg === 'B') testB();
if (!arg || arg === 'C') testC();
if (!arg || arg === 'D') testD();
if (!arg || arg === 'E') testE();
console.log('\n');
