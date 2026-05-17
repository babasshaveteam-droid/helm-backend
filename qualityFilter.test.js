'use strict';

// Suppress [quality] / [dedupe] logs during tests
const origLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && (args[0].startsWith('[quality]') || args[0].startsWith('[dedupe]'))) return;
  origLog(...args);
};

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  getFamilyActivityScore,
  getRejectReason,
  MIN_SCORE,
} = require('./qualityFilter');

const { INTENT_TYPES, SEARCH_GROUPS } = require('./places');

const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    passed++;
    process.stdout.write('.');
  } catch (e) {
    process.stdout.write('\n');
    console.error(`FAIL: ${label}\n  ${e.message}`);
    failed++;
  }
}

// ─── 1-4 : INTENT_TYPES.calme ────────────────────────────────────────────────

test('T1 — INTENT_TYPES.calme: pas de library', () =>
  assert.ok(!INTENT_TYPES.calme.includes('library'), 'library encore présent dans calme'));

test('T2 — INTENT_TYPES.calme: pas de cafe', () =>
  assert.ok(!INTENT_TYPES.calme.includes('cafe'), 'cafe encore présent dans calme'));

test('T3 — INTENT_TYPES.calme: ice_cream_shop présent', () =>
  assert.ok(INTENT_TYPES.calme.includes('ice_cream_shop'), 'ice_cream_shop absent de calme'));

test('T4 — INTENT_TYPES.calme: movie_theater conservé', () =>
  assert.ok(INTENT_TYPES.calme.includes('movie_theater'), 'movie_theater absent de calme'));

// ─── 5-6 : SEARCH_GROUPS ─────────────────────────────────────────────────────

test('T5 — SEARCH_GROUPS[0]: pas de library', () =>
  assert.ok(!SEARCH_GROUPS[0].includes('library'), 'library encore dans SEARCH_GROUPS[0]'));

test('T6 — SEARCH_GROUPS[2]: pas de library', () =>
  assert.ok(!SEARCH_GROUPS[2].includes('library'), 'library encore dans SEARCH_GROUPS[2]'));

// ─── 7-15 : queries getTargetedSearches branche calme ────────────────────────

// Extrait le bloc retourné pour intent=calme (entre 'calme') et le prochain if (intent ===
const calmeBlock = (() => {
  const m = indexSrc.match(/intent\s*===\s*['"]calme['"]\s*\)\s*\{([\s\S]*?)\n\s*\}/);
  return m ? m[1] : '';
})();

test("T7 — calme: pas de query 'bibliothèque'", () =>
  assert.ok(!calmeBlock.includes('biblioth'), "query bibliothèque encore présente dans calme"));

test("T8 — calme: pas de query 'ludothèque'", () =>
  assert.ok(!calmeBlock.includes('ludoth'), "query ludothèque encore présente dans calme"));

test("T9 — calme: pas de query 'café famille'", () =>
  assert.ok(!calmeBlock.includes('café famille') && !calmeBlock.includes('cafe famille'),
    "query café famille encore présente dans calme"));

test("T10 — calme: query 'glacier' présente", () =>
  assert.ok(calmeBlock.includes('glacier'), "query glacier absente de calme"));

test("T11 — calme: query 'crêperie' présente", () =>
  assert.ok(calmeBlock.includes('crêperie') || calmeBlock.includes('creperie'),
    "query crêperie absente de calme"));

test("T12 — calme: query 'pâtisserie' présente", () =>
  assert.ok(calmeBlock.includes('pâtisserie') || calmeBlock.includes('patisserie'),
    "query pâtisserie absente de calme"));

test("T13 — calme: query 'chocolaterie' présente", () =>
  assert.ok(calmeBlock.includes('chocolaterie'), "query chocolaterie absente de calme"));

test("T14 — calme: query 'cinéma' conservée", () =>
  assert.ok(calmeBlock.includes('cinéma') || calmeBlock.includes('cinema'),
    "query cinéma absente de calme"));

test("T15 — calme: query 'planétarium' conservée", () =>
  assert.ok(calmeBlock.includes('planétarium') || calmeBlock.includes('planetarium'),
    "query planétarium absente de calme"));

// ─── 16-20 : filtre adulte ────────────────────────────────────────────────────

function makePlace(name, opts = {}) {
  return {
    name,
    types: opts.types ?? ['restaurant', 'food', 'point_of_interest', 'establishment'],
    rating: opts.rating ?? 4.5,
    ratingCount: opts.ratingCount ?? 80,
    isOpen: 'isOpen' in opts ? opts.isOpen : true,
    businessStatus: opts.businessStatus ?? 'OPERATIONAL',
    address: 'Rue Test 1, Lausanne',
    lat: 46.52, lon: 6.63,
    closingPeriods: opts.closingPeriods ?? null,
  };
}

test('T16 — adulte: "Bar Chicha Lounge" → rejeté adult_venue', () => {
  const p = makePlace('Bar Chicha Lounge');
  const score = getFamilyActivityScore(p);
  const reason = getRejectReason(p, score);
  assert.strictEqual(reason, 'adult_venue', `reason=${reason} score=${score}`);
});

test('T17 — adulte: "Hookah Palace" → rejeté adult_venue', () => {
  const p = makePlace('Hookah Palace');
  const score = getFamilyActivityScore(p);
  const reason = getRejectReason(p, score);
  assert.strictEqual(reason, 'adult_venue', `reason=${reason} score=${score}`);
});

test('T18 — adulte: "Le Nightclub 54" → rejeté adult_venue', () => {
  const p = makePlace('Le Nightclub 54');
  const score = getFamilyActivityScore(p);
  const reason = getRejectReason(p, score);
  assert.strictEqual(reason, 'adult_venue', `reason=${reason} score=${score}`);
});

test('T19 — faux positif: "Bar à Glaces du Lac" → NON rejeté', () => {
  const p = makePlace('Bar à Glaces du Lac');
  const score = getFamilyActivityScore(p);
  const reason = getRejectReason(p, score);
  assert.ok(reason !== 'adult_venue', `faux positif adult_venue: score=${score}`);
});

test('T20 — faux positif: "Chocolat Bar Bruxelles" → NON rejeté', () => {
  const p = makePlace('Chocolat Bar Bruxelles');
  const score = getFamilyActivityScore(p);
  const reason = getRejectReason(p, score);
  assert.ok(reason !== 'adult_venue', `faux positif adult_venue: score=${score}`);
});

// ─── 21-26 : qualité gourmand ─────────────────────────────────────────────────

test('T21 — gourmand: crêperie ratingCount=15, isOpen=null → rejeté', () => {
  const p = makePlace('La Crêperie du Village', { ratingCount: 15, isOpen: null });
  const score = getFamilyActivityScore(p);
  assert.ok(score < MIN_SCORE, `score=${score} devrait être < ${MIN_SCORE}`);
});

test('T22 — gourmand: crêperie ratingCount=35, isOpen=true → accepté', () => {
  const p = makePlace('La Crêperie Bretonne', { ratingCount: 35, isOpen: true });
  const score = getFamilyActivityScore(p);
  const reason = getRejectReason(p, score);
  assert.ok(reason === null, `rejeté avec reason=${reason} score=${score}`);
});

test('T23 — gourmand: "Crêpes à Emporter" → rejeté (takeaway)', () => {
  const p = makePlace('Crêpes à Emporter', { ratingCount: 60, isOpen: true });
  const score = getFamilyActivityScore(p);
  assert.ok(score < MIN_SCORE, `score=${score} devrait être < ${MIN_SCORE} (takeaway)`);
});

test('T24 — gourmand: pâtisserie ratingCount=22, isOpen=null → rejeté', () => {
  const p = makePlace('Pâtisserie Martin', { ratingCount: 22, isOpen: null });
  const score = getFamilyActivityScore(p);
  assert.ok(score < MIN_SCORE, `score=${score} devrait être < ${MIN_SCORE}`);
});

test('T25 — gourmand: pâtisserie ratingCount=40, rating=4.5, isOpen=true → accepté', () => {
  const p = makePlace('Pâtisserie du Marché', { ratingCount: 40, rating: 4.5, isOpen: true });
  const score = getFamilyActivityScore(p);
  const reason = getRejectReason(p, score);
  assert.ok(reason === null, `rejeté avec reason=${reason} score=${score}`);
});

test('T26 — gourmand: chocolaterie ratingCount=55, rating=4.7, isOpen=true → accepté', () => {
  const p = makePlace('Chocolaterie Artisanale Dupont', { ratingCount: 55, rating: 4.7, isOpen: true });
  const score = getFamilyActivityScore(p);
  const reason = getRejectReason(p, score);
  assert.ok(reason === null, `rejeté avec reason=${reason} score=${score}`);
});

// ─── 27 : NIGHT_MANAGED_TYPES ice_cream_shop ─────────────────────────────────

test('T27 — NIGHT_MANAGED_TYPES: ice_cream_shop présent (règle nuit activée)', () => {
  // On vérifie la configuration directement via le fichier source
  const qfSrc = fs.readFileSync(path.join(__dirname, 'qualityFilter.js'), 'utf8');
  assert.ok(qfSrc.includes("'ice_cream_shop'"), "ice_cream_shop absent de NIGHT_MANAGED_TYPES");
});

// ─── Résultat ─────────────────────────────────────────────────────────────────

process.stdout.write('\n');
console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
