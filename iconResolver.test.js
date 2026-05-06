'use strict';

// Suppress [icon] logs during tests for clean output
const origLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('[icon]')) return;
  origLog(...args);
};

const assert = require('assert');
const { normalizeText, isAbstractItem, resolveIcon, resolveActivityEmoji } = require('./iconResolver');

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

// ─── normalizeText ───────────────────────────────────────────────────────────
test('normalizeText: accents removed', () =>
  assert.strictEqual(normalizeText('Chaussettes épaisses'), 'chaussettes epaisses'));
test('normalizeText: é è à ô', () =>
  assert.strictEqual(normalizeText('Réservation à vérifier'), 'reservation a verifier'));
test('normalizeText: smart quotes', () =>
  assert.strictEqual(normalizeText("Location de l'eau"), 'location de l eau'));
test('normalizeText: punctuation stripped', () =>
  assert.strictEqual(normalizeText('Café — sur place.'), 'cafe sur place'));
test('normalizeText: uppercase lowered', () =>
  assert.strictEqual(normalizeText('GANTS'), 'gants'));

// ─── isAbstractItem ──────────────────────────────────────────────────────────
test('isAbstractItem: Patience → true', () => assert.ok(isAbstractItem('Patience')));
test('isAbstractItem: Bonne humeur → true', () => assert.ok(isAbstractItem('Bonne humeur')));
test('isAbstractItem: Curiosité → true', () => assert.ok(isAbstractItem('Curiosité')));
test('isAbstractItem: Motivation → true', () => assert.ok(isAbstractItem('Motivation')));
test('isAbstractItem: Appétit → true', () => assert.ok(isAbstractItem('Appétit')));
test('isAbstractItem: Envie → true', () => assert.ok(isAbstractItem('Envie')));
test('isAbstractItem: Petit carnet → false', () => assert.ok(!isAbstractItem('Petit carnet')));
test('isAbstractItem: Petit guide des animaux → false', () => assert.ok(!isAbstractItem('Petit guide des animaux')));
test('isAbstractItem: Carnet de croquis → false', () => assert.ok(!isAbstractItem('Carnet de croquis')));
test('isAbstractItem: Gants → false', () => assert.ok(!isAbstractItem('Gants')));
test('isAbstractItem: Chaussettes épaisses → false', () => assert.ok(!isAbstractItem('Chaussettes épaisses')));

// ─── bringItem ───────────────────────────────────────────────────────────────
test('bringItem: Portefeuille → 👛', () =>
  assert.strictEqual(resolveIcon('Portefeuille', 'bringItem').icon, '👛'));
test('bringItem: Porte-monnaie → 👛', () =>
  assert.strictEqual(resolveIcon('Porte-monnaie', 'bringItem').icon, '👛'));
test('bringItem: Maillot de bain → 🩱', () =>
  assert.strictEqual(resolveIcon('Maillot de bain', 'bringItem').icon, '🩱'));
test('bringItem: Bonnet de bain → 🧢', () =>
  assert.strictEqual(resolveIcon('Bonnet de bain', 'bringItem').icon, '🧢'));
test('bringItem: Serviette → 🧺', () =>
  assert.strictEqual(resolveIcon('Serviette', 'bringItem').icon, '🧺'));
test('bringItem: Gants → 🧤', () =>
  assert.strictEqual(resolveIcon('Gants', 'bringItem').icon, '🧤'));
test('bringItem: Chaussettes épaisses → 🧦', () =>
  assert.strictEqual(resolveIcon('Chaussettes épaisses', 'bringItem').icon, '🧦'));
test('bringItem: Chaussettes → 🧦', () =>
  assert.strictEqual(resolveIcon('Chaussettes', 'bringItem').icon, '🧦'));
test('bringItem: Appareil photo → 📸', () =>
  assert.strictEqual(resolveIcon('Appareil photo', 'bringItem').icon, '📸'));
test('bringItem: Jumelles → 🔭', () =>
  assert.strictEqual(resolveIcon('Jumelles', 'bringItem').icon, '🔭'));
test('bringItem: Carnet de croquis → 📓 or 🎨', () => {
  const icon = resolveIcon('Carnet de croquis', 'bringItem').icon;
  assert.ok(['📓', '🎨'].includes(icon), `expected 📓 or 🎨, got ${icon}`);
});
test('bringItem: Crayon → ✏️', () =>
  assert.strictEqual(resolveIcon('Crayon', 'bringItem').icon, '✏️'));
test('bringItem: Petit en-cas → 🍎', () =>
  assert.strictEqual(resolveIcon('Petit en-cas', 'bringItem').icon, '🍎'));
test('bringItem: Collation → 🍎', () =>
  assert.strictEqual(resolveIcon('Collation', 'bringItem').icon, '🍎'));
test('bringItem: Petit guide des animaux → 📘', () =>
  assert.strictEqual(resolveIcon('Petit guide des animaux', 'bringItem').icon, '📘'));
test("bringItem: Bouteille d'eau → 💧", () =>
  assert.strictEqual(resolveIcon("Bouteille d'eau", 'bringItem').icon, '💧'));
test('bringItem: Crème solaire → 🧴', () =>
  assert.strictEqual(resolveIcon('Crème solaire', 'bringItem').icon, '🧴'));
test('bringItem: Patins → ⛸️', () =>
  assert.strictEqual(resolveIcon('Patins', 'bringItem').icon, '⛸️'));
test('bringItem: Casque → 🪖', () =>
  assert.strictEqual(resolveIcon('Casque', 'bringItem').icon, '🪖'));
test('bringItem: Carte de bibliothèque → 💳', () =>
  assert.strictEqual(resolveIcon('Carte de bibliothèque', 'bringItem').icon, '💳'));
test('bringItem: Sac à dos → 🎒', () =>
  assert.strictEqual(resolveIcon('Sac à dos', 'bringItem').icon, '🎒'));
test('bringItem: unknown → ✨ (pas 🎒 par défaut)', () =>
  assert.strictEqual(resolveIcon('Quelque chose de mystérieux', 'bringItem').icon, '✨'));
test('bringItem: Maillot → 🩱 (not 🧺 serviette)', () =>
  assert.strictEqual(resolveIcon('Maillot de bain', 'bringItem').icon, '🩱'));

// ─── practicalInfo ───────────────────────────────────────────────────────────
test('practicalInfo: Location de patins sur place → ⛸️', () =>
  assert.strictEqual(resolveIcon('Location de patins sur place', 'practicalInfo').icon, '⛸️'));
test('practicalInfo: Location de patins → ⛸️', () =>
  assert.strictEqual(resolveIcon('Location de patins', 'practicalInfo').icon, '⛸️'));
test('practicalInfo: Piste adaptée aux débutants → 🟢', () =>
  assert.strictEqual(resolveIcon('Piste adaptée aux débutants', 'practicalInfo').icon, '🟢'));
test('practicalInfo: Piste pour débutants → 🟢', () =>
  assert.strictEqual(resolveIcon('Piste pour débutants', 'practicalInfo').icon, '🟢'));
test('practicalInfo: Toilettes publiques à vérifier → 🚻', () =>
  assert.strictEqual(resolveIcon('Toilettes publiques à vérifier', 'practicalInfo').icon, '🚻'));
test('practicalInfo: Toilettes accessibles → 🚻 (pas ♿)', () =>
  assert.strictEqual(resolveIcon('Toilettes accessibles', 'practicalInfo').icon, '🚻'));
test('practicalInfo: WC disponibles → 🚻', () =>
  assert.strictEqual(resolveIcon('WC disponibles', 'practicalInfo').icon, '🚻'));
test('practicalInfo: Vestiaires et douches disponibles → 🚻', () =>
  assert.strictEqual(resolveIcon('Vestiaires et douches disponibles', 'practicalInfo').icon, '🚻'));
test('practicalInfo: Pause café au bar → ☕', () =>
  assert.strictEqual(resolveIcon('Pause café au bar', 'practicalInfo').icon, '☕'));
test('practicalInfo: Restaurant sur place → 🍽️', () =>
  assert.strictEqual(resolveIcon('Restaurant sur place', 'practicalInfo').icon, '🍽️'));
test('practicalInfo: Cafétéria sur place → ☕', () =>
  assert.strictEqual(resolveIcon('Cafétéria sur place', 'practicalInfo').icon, '☕'));
test('practicalInfo: Sur place seul → ✨ (pas 🍽️)', () =>
  assert.strictEqual(resolveIcon('Sur place', 'practicalInfo').icon, '✨'));
test('practicalInfo: Boutique souvenirs → 🛍️', () =>
  assert.strictEqual(resolveIcon('Boutique souvenirs', 'practicalInfo').icon, '🛍️'));
test('practicalInfo: Vitrines interactives → 🖼️', () =>
  assert.strictEqual(resolveIcon('Vitrines interactives', 'practicalInfo').icon, '🖼️'));
test('practicalInfo: Bancs et zones de repos → 🪑', () =>
  assert.strictEqual(resolveIcon('Bancs et zones de repos', 'practicalInfo').icon, '🪑'));
test('practicalInfo: Accès poussette → 👶', () =>
  assert.strictEqual(resolveIcon('Accès poussette', 'practicalInfo').icon, '👶'));
test('practicalInfo: Menu enfants → 👶', () =>
  assert.strictEqual(resolveIcon('Menu enfants', 'practicalInfo').icon, '👶'));
test('practicalInfo: Zones enfants → 👶', () =>
  assert.strictEqual(resolveIcon('Zones enfants', 'practicalInfo').icon, '👶'));
test('practicalInfo: Espaces climatisés → ❄️', () =>
  assert.strictEqual(resolveIcon('Espaces climatisés', 'practicalInfo').icon, '❄️'));
test('practicalInfo: Horaires à vérifier → 🕒', () =>
  assert.strictEqual(resolveIcon('Horaires à vérifier avant de partir', 'practicalInfo').icon, '🕒'));
test('practicalInfo: Ouvert maintenant → 🕒', () =>
  assert.strictEqual(resolveIcon('Ouvert maintenant', 'practicalInfo').icon, '🕒'));
test('practicalInfo: Parking disponible → 🅿️', () =>
  assert.strictEqual(resolveIcon('Parking disponible', 'practicalInfo').icon, '🅿️'));
test('practicalInfo: Entrée gratuite → 💰', () =>
  assert.strictEqual(resolveIcon('Entrée gratuite', 'practicalInfo').icon, '💰'));
test('practicalInfo: Surveillance active → 🛡️', () =>
  assert.strictEqual(resolveIcon('Surveillance active', 'practicalInfo').icon, '🛡️'));

// ─── Context disambiguation ───────────────────────────────────────────────────
test('context: Piste + sport indoor → ⛸️', () =>
  assert.strictEqual(
    resolveIcon('Piste disponible', 'practicalInfo', { category: 'Sport', type: 'indoor' }).icon, '⛸️'));
test('context: Piste + Aventure → 🥾', () =>
  assert.strictEqual(
    resolveIcon('Piste balisée', 'practicalInfo', { effortLevel: 'Aventure', category: 'Nature' }).icon, '🥾'));
test('context: Piste sans ctx → ✨', () =>
  assert.strictEqual(
    resolveIcon('Piste disponible', 'practicalInfo', {}).icon, '✨'));

// ─── Non-regression: anciens bugs corrigés ────────────────────────────────────
test('non-reg: "sur place" seul → ✨ (pas 🍽️)', () =>
  assert.strictEqual(resolveIcon('Sur place', 'practicalInfo').icon, '✨'));
test('non-reg: bringItem "Portefeuille" → 👛 (pas 🎒)', () =>
  assert.strictEqual(resolveIcon('Portefeuille', 'bringItem').icon, '👛'));
test('non-reg: bringItem "Maillot de bain" → 🩱 (pas 🎒)', () =>
  assert.strictEqual(resolveIcon('Maillot de bain', 'bringItem').icon, '🩱'));
test('non-reg: practicalInfo "Toilettes" → 🚻 (pas 🌿)', () =>
  assert.strictEqual(resolveIcon('Toilettes', 'practicalInfo').icon, '🚻'));

// ─── Activity emoji ────────────────────────────────────────────────────────────
test('activity: Patinoire de Lausanne → ⛸️', () =>
  assert.strictEqual(resolveActivityEmoji({ name: 'Patinoire de Lausanne', types: [] }).icon, '⛸️'));
test('activity: Aquatis Aquarium → 🐠 (name)', () =>
  assert.strictEqual(resolveActivityEmoji({ name: 'Aquatis Aquarium', types: [] }).icon, '🐠'));
test('activity: aquarium type → 🐠', () =>
  assert.strictEqual(resolveActivityEmoji({ name: 'AQUATIS', types: ['aquarium'] }).icon, '🐠'));
test('activity: Bibliothèque → 📚', () =>
  assert.strictEqual(resolveActivityEmoji({ name: 'Bibliothèque', types: ['library'] }).icon, '📚'));
test('activity: zoo type → 🦁', () =>
  assert.strictEqual(resolveActivityEmoji({ name: 'Parc animalier', types: ['zoo'] }).icon, '🦁'));
test('activity: Piscine de Marly → 🏊', () =>
  assert.strictEqual(resolveActivityEmoji({ name: 'Piscine de Marly', types: [] }).icon, '🏊'));
test('activity: Musée → 🏛️', () =>
  assert.strictEqual(resolveActivityEmoji({ name: "Musée d'histoire naturelle", types: [] }).icon, '🏛️'));
test('activity: unknown → ✨', () =>
  assert.strictEqual(resolveActivityEmoji({ name: 'Le Truc Mystérieux', types: [] }).icon, '✨'));

// ─── Summary ──────────────────────────────────────────────────────────────────
process.stdout.write('\n');
console.log = origLog;
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
