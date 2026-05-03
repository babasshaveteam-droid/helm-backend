'use strict';

// ─── activityRules.js ─────────────────────────────────────────────────────────
// Central authority for per-family activity normalization.
// Applies to BOTH the Claude path (mergeWithPlaceData) and the fallback path
// (placesToFallback) — and to mock activities through normalizeActivityForDisplay.
//
// Design:
//  1. detectFamily(name, types) → identifies which family a place belongs to
//  2. FAMILIES[key]             → full rule: content, forbidden lists, overrides
//  3. applyFamilyRules(activity, name, types, opts) → single correction gate
//     • Always: sanitize whatToBring, practicalInfos, tags (global + family rules)
//     • fromFallback=true: also override type, weatherFit, subtitle, etc.
//     • fromFallback=false: override type/weatherFit only (respect Claude content)

// ─── Global forbidden items ───────────────────────────────────────────────────

// Items that must NEVER appear in whatToBring, regardless of family.
// Keys are lowercase normalized.
const GLOBAL_FORBIDDEN_BRING = {
  'bonne humeur':   null,           // remove
  'appétit':        null,           // remove (except bakery uses 'Petite faim')
  'monnaie':        'Porte-monnaie',// replace
  'monnaie pour les entrées': 'Porte-monnaie',
  'tenue confortable': null,        // remove
  'motivation':     null,
  'envie':          null,
  'sourire':        null,
  'enthousiasme':   null,
};

// practicalInfos patterns that must never appear without a real source.
const GLOBAL_FORBIDDEN_PRACTICAL = [
  /^réservation recommandée le week-end$/i,
  /parking gratuit/i,
];

// Tags that are never useful as primary display tags.
const GLOBAL_FORBIDDEN_TAGS = new Set([
  "lieu à découvrir", 'attraction', 'tourist_attraction',
  'point_of_interest', 'establishment',
]);

// ─── Family definitions ───────────────────────────────────────────────────────
// Each family:
//   detect(name, types) → boolean
//   category, type, icon, effortLevel, weatherFit  → always overridden when non-null
//   subtitle, whyGoodIdea, benefit                 → overridden from fallback only
//   whatToBring, practicalInfos, tags              → used as fallback or override
//   skipIsOpen: true                               → don't prepend isOpen line
//   forbiddenPracticalInfos                        → family-level forbidden patterns
//   forbiddenTags                                  → family-level forbidden tags

const FAMILIES = {

  bowling: {
    detect: (name, types) =>
      types.includes('bowling_alley') || /bowling|quilles/i.test(name),
    category:    'Loisirs',
    type:        'indoor',
    icon:        '🎳',
    effortLevel: 'Facile',
    weatherFit:  ['rainy', 'cold', 'unstable'],
    subtitle:    "Une activité couverte pour bouger et s'amuser en famille.",
    whyGoodIdea: "Le bowling permet aux enfants de se défouler tout en restant à l'abri.",
    benefit:     "Bouger à l'abri",
    whatToBring: ['Chaussettes', 'Eau', 'Petite veste'],
    practicalInfos: ['Activité couverte', 'Réservation à vérifier'],
    tags:        ['bowling', 'intérieur', 'loisirs', 'famille', 'pluie'],
    skipIsOpen:  false,
    forbiddenPracticalInfos: [/réservation recommandée/i],
    forbiddenTags: ["parc d'attractions", 'lieu à découvrir', 'attraction'],
  },

  water: {
    detect: (name, types) =>
      types.includes('beach') ||
      /plage|beach|baignade|piscine\s+naturelle|waterfront|bord\s+(du\s+lac|de\s+l['']eau)|rive\s+du\b|lac\s+(de|du)\b/i.test(name),
    category:    'Nature',
    type:        'outdoor',
    icon:        null, // determined by getEmojiOverride (🏖️ / 🌊)
    effortLevel: 'Facile',
    weatherFit:  ['sunny', 'hot', 'unstable'],
    subtitle:    "Une sortie simple au bord de l'eau pour prendre l'air en famille.",
    whyGoodIdea: "Un lieu agréable pour marcher, observer l'eau et profiter d'un moment dehors avec les enfants.",
    benefit:     "Prendre l'air au bord de l'eau",
    whatToBring: ['Eau', 'Casquette ou crème solaire', 'Vêtements adaptés'],
    practicalInfos: ["Accès au bord de l'eau", 'Baignade à vérifier selon la saison'],
    tags:        ['plage', 'eau', 'extérieur', 'famille', 'balade'],
    skipIsOpen:  true, // beaches are open-access, no opening hours
    forbiddenPracticalInfos: [/réservation recommandée/i],
    forbiddenTags: ['café'],
  },

  shopping_mall: {
    detect: (name, types) =>
      types.includes('shopping_mall') ||
      /centre\s+commercial|shopping\s+(center|centre|mall)|galerie\s+commerciale\b/i.test(name),
    category:    'Loisirs',
    type:        'indoor',
    icon:        '🏬',
    effortLevel: 'Facile',
    weatherFit:  ['rainy', 'cold', 'unstable', 'hot'],
    subtitle:    "Une option pratique pour se mettre à l'abri et faire une pause en famille.",
    whyGoodIdea: "Un lieu couvert pour marcher un peu, prendre un goûter ou occuper les enfants quand la météo est incertaine.",
    benefit:     "À l'abri et pratique avec les enfants",
    whatToBring: ['Porte-monnaie', 'Petite veste', 'Eau'],
    practicalInfos: ['Lieu couvert', 'Restauration possible sur place'],
    tags:        ['intérieur', 'abri', 'famille', 'shopping', 'pause'],
    skipIsOpen:  false,
    forbiddenPracticalInfos: [],
    forbiddenTags: ['lieu à découvrir'],
  },

  bakery_cafe: {
    detect: (name, types) =>
      types.some(t => ['bakery', 'cafe'].includes(t)) ||
      /boulangerie|pâtisserie|pastry|tea\s*room|coffee\s*shop/i.test(name),
    category:    'Pause famille',
    type:        'indoor',
    icon:        null, // 🥐 (boulangerie) or ☕ (café) determined by getEmojiOverride
    effortLevel: 'Facile',
    weatherFit:  ['rainy', 'cold', 'unstable'],
    subtitle:    "Une pause gourmande simple à partager en famille.",
    whyGoodIdea: "Un arrêt pratique pour prendre un goûter, se réchauffer ou faire une petite pause avec les enfants.",
    benefit:     "Pause gourmande au chaud",
    whatToBring: ['Porte-monnaie', 'Petite faim'],
    practicalInfos: ['Pause gourmande', "Possibilité d'emporter à vérifier"],
    tags:        ['goûter', 'pause', 'famille', 'intérieur'],
    skipIsOpen:  false,
    forbiddenPracticalInfos: [/réservation recommandée/i],
    forbiddenTags: [],
  },

  zoo_animals: {
    detect: (name, types) =>
      types.includes('zoo') ||
      /zoo|safari|parc\s+animalier|ferme\s*(animaux|animalière?|pédagog|d['']élevage|enfants?)/i.test(name),
    category:    'Loisirs',
    type:        'outdoor',
    icon:        '🦁',
    effortLevel: 'Facile',
    weatherFit:  ['sunny', 'unstable'],
    subtitle:    null,
    whyGoodIdea: null,
    benefit:     null,
    whatToBring: null,
    practicalInfos: null,
    tags:        null,
    skipIsOpen:  false,
    forbiddenPracticalInfos: [/réservation recommandée le week-end/i],
    forbiddenTags: ["parc d'attractions", 'lieu à découvrir'],
  },

  mountain_hike: {
    detect: (name, types) =>
      types.some(t => ['hiking_area'].includes(t)) ||
      /randonnée|sentier\s+balisé|sommet\b|belvédère|viewpoint|via\s*ferrata/i.test(name),
    category:    'Nature',
    type:        'outdoor',
    icon:        '⛰️',
    effortLevel: 'Aventure',
    weatherFit:  ['sunny', 'unstable'],
    subtitle:    null,
    whyGoodIdea: null,
    benefit:     null,
    whatToBring: ['Chaussures de marche', 'Eau', 'Petite veste', 'Collation'],
    practicalInfos: null,
    tags:        null,
    skipIsOpen:  false,
    forbiddenPracticalInfos: [/réservation recommandée/i],
    forbiddenTags: ['café', 'lieu à découvrir'],
  },

  culture: {
    // Lowest-priority culture catch — covers anything not already matched
    detect: (name, types) =>
      types.some(t => ['museum','art_gallery','historic_site','castle','church',
                       'hindu_temple','mosque','synagogue','library'].includes(t)) ||
      /château|castle|cathédrale|cathedral|mus[eé]e|museum|abbaye|église|monument|arch[eé]olog|patrimoine/i.test(name),
    category:    'Culture',
    type:        null, // varies: museum=indoor, château=outdoor — don't force
    icon:        null,
    effortLevel: null,
    weatherFit:  null,
    subtitle:    null,
    whyGoodIdea: null,
    benefit:     null,
    whatToBring: null, // handled by HERITAGE_WHAT_TO_BRING in index.js
    practicalInfos: null,
    tags:        null,
    skipIsOpen:  false,
    forbiddenPracticalInfos: [/réservation recommandée le week-end/i],
    forbiddenTags: ['lieu à découvrir', "parc d'attractions"],
  },

  park_nature: {
    detect: (name, types) =>
      types.some(t => ['park','natural_feature','botanical_garden','nature_reserve','campground'].includes(t)) &&
      !types.includes('beach'),
    category:    'Nature',
    type:        'outdoor',
    icon:        null,
    effortLevel: null,
    weatherFit:  null,
    subtitle:    null,
    whyGoodIdea: null,
    benefit:     null,
    whatToBring: null,
    practicalInfos: null,
    tags:        null,
    skipIsOpen:  false,
    forbiddenPracticalInfos: [/réservation recommandée le week-end/i],
    forbiddenTags: ['café', 'lieu à découvrir'],
  },
};

// ─── Detection ────────────────────────────────────────────────────────────────

// Returns the first matching family key, or null.
// Order matters: more specific families (bowling, water) before generic (park_nature, culture).
function detectFamily(name = '', types = []) {
  for (const [key, rule] of Object.entries(FAMILIES)) {
    if (rule.detect(name, types)) return key;
  }
  return null;
}

function getFamilyRule(key) {
  return FAMILIES[key] ?? null;
}

// ─── Item sanitization ────────────────────────────────────────────────────────

// Applies global forbidden list + replacements to whatToBring items.
// Returns a cleaned array. Empty → caller uses family defaults.
function sanitizeWhatToBring(items) {
  const result = [];
  for (const item of (items ?? [])) {
    const lc = item.toLowerCase().trim();
    if (lc in GLOBAL_FORBIDDEN_BRING) {
      const replacement = GLOBAL_FORBIDDEN_BRING[lc];
      if (replacement) result.push(replacement);
      // else: null → silently drop
    } else {
      result.push(item);
    }
  }
  // Dedup
  return [...new Map(result.map(i => [i.toLowerCase(), i])).values()];
}

// Removes forbidden practical info lines (global + family-specific).
function sanitizePracticalInfos(items, familyKey) {
  const rule = FAMILIES[familyKey];
  const patterns = [
    ...GLOBAL_FORBIDDEN_PRACTICAL,
    ...(rule?.forbiddenPracticalInfos ?? []),
  ];
  return (items ?? []).filter(item =>
    !patterns.some(p => p.test(item))
  );
}

// Removes forbidden tags (global + family-specific).
function sanitizeTags(tags, familyKey) {
  const rule = FAMILIES[familyKey];
  const forbidden = new Set([
    ...GLOBAL_FORBIDDEN_TAGS,
    ...(rule?.forbiddenTags ?? []),
  ]);
  return (tags ?? []).filter(t => !forbidden.has(t.toLowerCase().trim()));
}

// ─── Main correction gate ─────────────────────────────────────────────────────

/**
 * applyFamilyRules(activity, placeName, placeTypes, opts)
 *
 * opts.fromFallback — true when called from placesToFallback (no Claude output)
 * opts.isOpen       — boolean|null from Google Places (used to build practicalInfos)
 *
 * Always applied:
 *   • sanitizeWhatToBring   (global forbidden filter)
 *   • sanitizePracticalInfos (remove invented reservations etc.)
 *   • sanitizeTags           (remove weak tags)
 *   • type override          (bowling/mall/bakery → indoor)
 *   • weatherFit override    (if family has specific fit)
 *   • icon/emoji override    (if family has definitive icon AND fromFallback)
 *
 * Only in fromFallback mode:
 *   • subtitle, whyGoodIdea, benefit replaced with family text
 *   • whatToBring replaced with family defaults if empty after sanitization
 *   • practicalInfos rebuilt with family defaults
 *   • tags replaced with family defaults if empty after sanitization
 */
function applyFamilyRules(activity, placeName = '', placeTypes = [], opts = {}) {
  const { fromFallback = false, isOpen = null } = opts;
  const familyKey = detectFamily(placeName, placeTypes);
  const rule = familyKey ? FAMILIES[familyKey] : null;

  const a = { ...activity };

  // ── 1. Sanitize whatToBring (always) ────────────────────────────────────────
  let bring = sanitizeWhatToBring(a.whatToBring ?? []);
  if (bring.length === 0 && rule?.whatToBring) {
    bring = rule.whatToBring;
  } else if (bring.length === 0) {
    bring = a.whatToBring ?? [];
  }
  a.whatToBring = bring;

  // ── 2. Sanitize practicalInfos (always) ─────────────────────────────────────
  let practical = sanitizePracticalInfos(a.practicalInfos ?? [], familyKey);

  if (fromFallback && rule?.practicalInfos) {
    // Rebuild from family defaults, optionally prepending isOpen status
    const isOpenLine = isOpen === true ? 'Ouvert maintenant'
                     : isOpen === false ? 'Horaires à vérifier avant de partir'
                     : null;
    if (rule.skipIsOpen) {
      practical = rule.practicalInfos;
    } else {
      practical = [
        isOpenLine ?? 'Horaires à vérifier avant de partir',
        ...rule.practicalInfos,
      ];
    }
  } else if (practical.length === 0 && rule?.practicalInfos) {
    practical = rule.practicalInfos;
  }
  a.practicalInfos = practical;

  // ── 3. Sanitize tags (always) ───────────────────────────────────────────────
  let tags = sanitizeTags(a.tags ?? [], familyKey);
  if (fromFallback && rule?.tags) {
    tags = tags.length > 0 ? tags : rule.tags;
  } else if (tags.length === 0 && rule?.tags) {
    tags = rule.tags;
  }
  a.tags = tags;

  if (!rule) return a;

  // ── 4. Always override: type, weatherFit, category ─────────────────────────
  if (rule.type !== null) a.type = rule.type;
  if (rule.weatherFit !== null && (fromFallback || !a.weatherFit?.length)) {
    a.weatherFit = rule.weatherFit;
  }
  if (rule.category !== null && a.category !== rule.category) {
    a.category = rule.category;
    const PASTEL = {
      Nature: '#E8F5E9', Culture: '#FFF3E0', Sport: '#E3F2FD',
      Gastronomie: '#FFF3E0', Loisirs: '#F5F0FF', 'Pause famille': '#FFF3E0',
    };
    a.colorTheme = PASTEL[a.category] ?? a.colorTheme;
  }

  // ── 5. fromFallback-only: override text content + emoji ─────────────────────
  if (fromFallback) {
    if (rule.icon !== null) { a.emoji = rule.icon; a.icon = rule.icon; }
    if (rule.effortLevel !== null) a.effortLevel = rule.effortLevel;
    if (rule.subtitle)    { a.subtitle    = rule.subtitle;    a.description = rule.subtitle; }
    if (rule.whyGoodIdea) a.whyGoodIdea  = rule.whyGoodIdea;
    if (rule.benefit)     a.benefit      = rule.benefit;
    if (rule.whatToBring) a.whatToBring  = rule.whatToBring;
    if (rule.tags)        a.tags         = rule.tags;
  }

  return a;
}

module.exports = {
  detectFamily,
  getFamilyRule,
  sanitizeWhatToBring,
  sanitizePracticalInfos,
  sanitizeTags,
  applyFamilyRules,
};
