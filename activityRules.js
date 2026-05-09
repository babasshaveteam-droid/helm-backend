// Règles officielles : docs/HELM_CORE_RULES.md
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
  'bonne humeur':              null,
  'appétit':                   null,
  'monnaie':                   'Porte-monnaie',
  'monnaie pour les entrées':  'Porte-monnaie',
  'tenue confortable':         null,
  'motivation':                null,
  'envie':                     null,
  'sourire':                   null,
  'enthousiasme':              null,
  // abstractions interdites
  'patience':                  null,
  'patience (service variable)': null,
  'patience (attente possible)': null,
  'temps':                     null,
  'flexibilité':               null,
  'flexibilite':               null,
  'organisation':              null,
  's\'organiser':              null,
  'réservation':               null,
  'reservation':               null,
  'horaires':                  null,
  'curiosité':                 null,
  'curiosite':                 null,
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

  trampoline_park: {
    detect: (name, types) =>
      /trampoline|jump\s*(park|zone|area|land)|air\s*park|fly\s*zone|saut\s*(libre|extrême)/i.test(name),
    category:    'Sport',
    type:        'indoor',
    icon:        '🤸',
    effortLevel: 'Modéré',
    weatherFit:  ['rainy', 'cold', 'unstable', 'sunny'],
    subtitle:    "Un parc de trampolines pour sauter, se défouler et rire en famille.",
    whyGoodIdea: "Les enfants adorent les parcs de trampolines — énergie dépensée, sourires garantis.",
    benefit:     "Défoulement et fun pour toute la famille",
    whatToBring: ['Chaussettes antidérapantes', 'Eau', 'Porte-monnaie'],
    practicalInfos: ['Réservation recommandée', 'Chaussettes obligatoires sur place', 'Tarifs à vérifier'],
    tags:        ['trampoline', 'saut', 'sport', 'famille', 'enfants', 'intérieur'],
    skipIsOpen:  false,
    forbiddenPracticalInfos: [],
    forbiddenTags: ['lieu à découvrir'],
  },

  amusement_park_family: {
    detect: (name, types) =>
      types.includes('amusement_park') ||
      /parc\s+(de\s+loisirs?|d['']attractions?|familial|aquatique)|fun\s*park|adventure\s*park/i.test(name),
    category:    'Loisirs',
    type:        'outdoor',
    icon:        '🎡',
    effortLevel: 'Facile',
    weatherFit:  ['sunny', 'unstable', 'hot'],
    subtitle:    "Un parc de loisirs pour une journée d'aventure et de sensations en famille.",
    whyGoodIdea: "Manèges, attractions et activités variées pour petits et grands — une journée inoubliable.",
    benefit:     "Aventure et sensations pour toute la famille",
    whatToBring: ['Porte-monnaie', 'Eau', 'Crème solaire', 'Snacks'],
    practicalInfos: ['Tarifs et horaires à vérifier', 'Réservation recommandée en haute saison'],
    tags:        ['attractions', 'loisirs', 'famille', 'enfants', 'parc'],
    skipIsOpen:  false,
    forbiddenPracticalInfos: [],
    forbiddenTags: ['lieu à découvrir'],
  },

  kids_play: {
    // Centre de loisirs / aire de jeux indoor — doit passer AVANT bowling
    // pour éviter qu'un amusement_center avec bowling_alley secondaire → faux bowling
    detect: (name, types) =>
      (types.includes('amusement_center') ||
       /payerneland|laurapark|laura\s*park|indoor\s*play(?:ground)?/i.test(name)) &&
      !types.includes('bowling_alley') &&
      !types.includes('playground') &&
      !/bowling|quilles/i.test(name),
    category:    'Loisirs',
    type:        'indoor',
    icon:        '🛝',
    effortLevel: 'Facile',
    weatherFit:  ['rainy', 'cold', 'unstable'],
    subtitle:    "Un centre de loisirs pour que les enfants jouent et se dépensent à l'abri.",
    whyGoodIdea: "Les enfants peuvent profiter de jeux, toboggans et petites attractions dans un cadre adapté.",
    benefit:     "Jeux et défoulement à l'abri",
    whatToBring: ['Chaussettes', 'Eau', 'Petite veste'],
    practicalInfos: ['Jeux et structures adaptés aux enfants', 'Réservation à vérifier'],
    tags:        ['jeux', 'enfants', 'intérieur', 'loisirs', 'amusement', 'famille'],
    skipIsOpen:  false,
    forbiddenPracticalInfos: [/réservation recommandée le week-end/i],
    forbiddenTags: ["parc d'attractions", 'lieu à découvrir'],
  },

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

  cinema: {
    detect: (name, types) =>
      types.includes('movie_theater') || /cin[ée]ma|cin[ée]plex/i.test(name),
    category:    'Loisirs',
    type:        'indoor',
    icon:        '🎬',
    effortLevel: 'Facile',
    weatherFit:  ['rainy', 'cold', 'unstable'],
    subtitle:    "Une séance de cinéma pour se détendre en famille à l'abri.",
    whyGoodIdea: "Le cinéma est idéal quand il fait mauvais — les enfants adorent le grand écran.",
    benefit:     "Divertissement à l'abri",
    whatToBring: ['Porte-monnaie'],
    practicalInfos: ['Séances à vérifier sur place ou en ligne', 'Tarifs réduits enfants souvent disponibles'],
    tags:        ['cinéma', 'film', 'intérieur', 'famille', 'pluie'],
    skipIsOpen:  false,
    forbiddenPracticalInfos: [/réservation recommandée le week-end/i],
    forbiddenTags: ['lieu à découvrir', 'attraction'],
  },

  outdoor_pool: {
    detect: (name, types) =>
      types.includes('swimming_pool') &&
      !/couverte?|couvert|indoor|int[eé]rieur/i.test(name),
    category:    'Sport',
    type:        'outdoor',
    icon:        '🏊',
    effortLevel: 'Facile',
    weatherFit:  ['sunny', 'hot'],
    subtitle:    "Une piscine publique en plein air pour se rafraîchir en famille.",
    whyGoodIdea: "Idéal par beau temps — les enfants peuvent barboter et nager dans un cadre sécurisé.",
    benefit:     "Baignade et fraîcheur en famille",
    whatToBring: ['Maillot de bain', 'Serviette', 'Crème solaire', 'Bonnet de bain', 'Porte-monnaie'],
    practicalInfos: ['Piscine publique', 'Tarifs et horaires à vérifier', 'Baignade surveillée'],
    tags:        ['piscine', 'baignade', 'eau', 'extérieur', 'famille', 'été'],
    skipIsOpen:  false,
    forbiddenPracticalInfos: [/réservation recommandée le week-end/i],
    forbiddenTags: ['lieu à découvrir'],
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

  sport_indoor: {
    detect: (name, types) =>
      types.includes('ice_skating_rink') ||
      (types.includes('swimming_pool') && /couverte?|couvert|indoor|int[eé]rieur/i.test(name)) ||
      /piscine\s+couverte?|patinoire|ice\s*skat|escalade|climbing\s*(gym|center|wall)|bloc\b/i.test(name),
    category:    'Sport',
    type:        'indoor',
    icon:        null, // 🏊 piscine / ⛸️ patinoire / 🧗 escalade via getEmojiOverride
    effortLevel: 'Modéré',
    weatherFit:  ['rainy', 'cold', 'unstable'],
    subtitle:    "Une activité sportive à l'abri pour se dépenser en famille.",
    whyGoodIdea: "Un endroit idéal pour bouger et se dépenser en intérieur, peu importe la météo.",
    benefit:     "Sport et dépense à l'abri",
    whatToBring: ['Tenue de sport', 'Serviette', 'Eau', 'Porte-monnaie'],
    practicalInfos: ['Activité couverte', 'Tarifs à vérifier avant de partir'],
    tags:        ['sport', 'intérieur', 'famille', 'pluie', 'dépense'],
    skipIsOpen:  false,
    forbiddenPracticalInfos: [/réservation recommandée le week-end/i],
    forbiddenTags: ['lieu à découvrir'],
  },

  zoo_animals: {
    detect: (name, types) =>
      types.includes('zoo') || types.includes('aquarium') ||
      /zoo|aquarium|safari|parc\s+animalier|ferme\s*(animaux|animalière?|pédagog|d['']élevage|enfants?)|papiliorama/i.test(name),
    category:    'Animaux',
    type:        'outdoor',
    icon:        null, // 🦁 zoo / 🐠 aquarium / 🦋 papiliorama via getEmojiOverride
    effortLevel: 'Facile',
    weatherFit:  ['sunny', 'unstable'],
    subtitle:    "Une découverte du monde animal pour petits et grands.",
    whyGoodIdea: "Les enfants adorent observer les animaux de près. Une sortie éducative et mémorable.",
    benefit:     "Découverte des animaux en famille",
    whatToBring: ['Eau', 'Porte-monnaie', 'Appareil photo', 'Vêtements adaptés'],
    practicalInfos: ['Activité adaptée aux enfants', 'Tarifs et horaires à vérifier'],
    tags:        ['animaux', 'famille', 'nature', 'éducatif', 'découverte'],
    skipIsOpen:  false,
    forbiddenPracticalInfos: [/réservation recommandée le week-end/i],
    forbiddenTags: ["parc d'attractions", 'lieu à découvrir'],
  },

  mountain_hike: {
    detect: (name, types) =>
      types.some(t => ['hiking_area'].includes(t)) ||
      /randonnée|sentier\s+(balisé|nature|familial)?|balade\s+(nature|famille|forêt|montagne)?|forêt\s+(parc|promenade)?|promenade\s+(forêt|nature|famille)|sommet\b|belvédère|viewpoint|via\s*ferrata|point\s+de\s+vue/i.test(name),
    category:    'Nature',
    type:        'outdoor',
    icon:        '🥾',
    effortLevel: 'Modéré',
    weatherFit:  ['sunny', 'unstable'],
    subtitle:    "Une balade en plein air pour se ressourcer et découvrir la nature en famille.",
    whyGoodIdea: "Marcher en famille dans la nature renforce les liens et offre de beaux paysages aux enfants.",
    benefit:     "Plein air et ressourcement en famille",
    whatToBring: ['Chaussures de marche', 'Eau', 'Collation', 'Petite veste', 'Crème solaire'],
    practicalInfos: ['Sentier accessible aux familles', 'Distance et dénivelé à vérifier', 'Prévenir en cas de météo changeante'],
    tags:        ['randonnée', 'nature', 'balade', 'extérieur', 'famille', 'montagne', 'forêt'],
    skipIsOpen:  true,
    forbiddenPracticalInfos: [/réservation recommandée/i],
    forbiddenTags: ['café', 'lieu à découvrir'],
  },

  library_quiet: {
    detect: (name, types) =>
      types.includes('library') ||
      /bibliothèque|médiathèque|ludothèque/i.test(name),
    category:    'Calme',
    type:        'indoor',
    icon:        '📚',
    effortLevel: 'Facile',
    weatherFit:  ['rainy', 'cold', 'unstable'],
    subtitle:    "Un endroit calme pour lire, jouer ou découvrir ensemble.",
    whyGoodIdea: "Une pause culturelle et apaisante, parfaite pour les enfants curieux.",
    benefit:     "Calme et culture à l'abri",
    whatToBring: ['Carte de bibliothèque', 'Porte-monnaie'],
    practicalInfos: ['Entrée souvent gratuite', 'Horaires à vérifier avant de partir'],
    tags:        ['lecture', 'calme', 'intérieur', 'famille', 'gratuit'],
    skipIsOpen:  false,
    forbiddenPracticalInfos: [/réservation recommandée/i],
    forbiddenTags: ['lieu à découvrir'],
  },

  cave_visit: {
    detect: (name, types) =>
      /grotte|caverne|gouffre|aven\b|stalactite|stalagmite|souterrain\s+(visite|guidé|famille)/i.test(name),
    category:    'Nature',
    type:        'indoor',
    icon:        '🦇',
    effortLevel: 'Modéré',
    weatherFit:  ['rainy', 'cold', 'unstable', 'sunny'],
    subtitle:    "Une visite souterraine fascinante pour découvrir un monde caché en famille.",
    whyGoodIdea: "Les grottes offrent un spectacle naturel impressionnant — stalactites, stalagmites et formations géologiques.",
    benefit:     "Découverte souterraine originale",
    whatToBring: ['Petite veste (fraîcheur)', 'Chaussures fermées', 'Porte-monnaie'],
    practicalInfos: ['Visite guidée souvent disponible', 'Tarifs à vérifier', "Température fraîche à l'intérieur"],
    tags:        ['grotte', 'nature', 'famille', 'découverte', 'géologie', 'souterrain'],
    skipIsOpen:  false,
    forbiddenPracticalInfos: [],
    forbiddenTags: ['lieu à découvrir'],
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

  outdoor_playground: {
    detect: (name, types) =>
      types.includes('playground') ||
      /aire\s+de\s+jeux\s*(extérieure?|en\s+plein\s+air|publique?)?|plaine\s+de\s+jeux|jeux\s+d['']enfants/i.test(name),
    category:    'Loisirs',
    type:        'outdoor',
    icon:        '🛝',
    effortLevel: 'Facile',
    weatherFit:  ['sunny', 'unstable'],
    subtitle:    "Une aire de jeux en plein air pour courir, grimper et se dépenser.",
    whyGoodIdea: "Les enfants adorent les structures de jeux extérieures — toboggans, balançoires et structures à grimper.",
    benefit:     "Jeux et défoulement en plein air",
    whatToBring: ['Eau', 'Collation', 'Vêtements adaptés'],
    practicalInfos: ['Accès libre', 'Adapté aux enfants', 'Espace extérieur'],
    tags:        ['jeux', 'enfants', 'extérieur', 'famille', 'plein air'],
    skipIsOpen:  true,
    forbiddenPracticalInfos: [/réservation recommandée/i],
    forbiddenTags: ['lieu à découvrir'],
  },

  park_nature: {
    detect: (name, types) =>
      types.some(t => ['park','natural_feature','botanical_garden','nature_reserve','campground'].includes(t)) &&
      !types.includes('beach'),
    category:    'Nature',
    type:        'outdoor',
    icon:        '🌿',
    effortLevel: 'Facile',
    weatherFit:  ['sunny', 'unstable'],
    subtitle:    "Un espace vert pour se promener et profiter de la nature en famille.",
    whyGoodIdea: "Un moment simple et gratuit au grand air — parfait pour les enfants qui ont besoin de bouger.",
    benefit:     "Grand air et nature en famille",
    whatToBring: ['Eau', 'Collation', 'Vêtements adaptés'],
    practicalInfos: ['Accès libre', 'Idéal pour pique-niquer', 'Prévoir vêtements adaptés à la météo'],
    tags:        ['nature', 'parc', 'extérieur', 'famille', 'plein air', 'promenade'],
    skipIsOpen:  true,
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
      Animaux: '#FFF8E1', Calme: '#F3E5F5',
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

// ─── Indoor / Outdoor normalization ─────────────────────────────────────────
// Called AFTER applyFamilyRules. Corrects type = 'outdoor' when semantic
// signals (weatherReason, Google types, name keywords) clearly indicate indoor.
// This is the single source of truth for the environment chip.

const INDOOR_GOOGLE_TYPES = new Set([
  'museum', 'aquarium', 'restaurant', 'cafe', 'shopping_mall', 'library',
  'bowling_alley', 'movie_theater', 'art_gallery', 'ice_skating_rink',
  'amusement_center', 'night_club', 'bar', 'food',
]);

const INDOOR_NAME_RE = /musée|museum|aquarium|vivarium|chocolaterie|bibliothèque|ludothèque|médiathèque|cinéma|bowling|patinoire|piscine\s+couverte|chaplin|cailler|café.{0,4}restaurant|hôtel.{0,20}café|restaurant|arena|bâtiment\s+historique|salle\s+de\s+(?:spectacle|concert|jeux|sport)/i;

const INDOOR_TEXT_RE = /couvert[e]?|à\s+l['']abri|à\s+l['']intérieur|visite\s+(?:guidée?\s+)?couverte|espace\s+(?:couvert|intérieur|chauffé)/i;

function normalizeIndoorOutdoor(activity, place) {
  if (activity.type === 'indoor') return activity; // déjà correct

  const a = { ...activity };
  let reason = null;

  // Priorité 1 — weatherReason contient "Intérieur"
  if (!reason && /int[eé]rieur/i.test(a.weatherReason)) {
    reason = 'weatherReason_interieur';
  }

  // Priorité 2 — types Google
  if (!reason && Array.isArray(place?.types) && place.types.some(t => INDOOR_GOOGLE_TYPES.has(t))) {
    reason = `google_type:${place.types.find(t => INDOOR_GOOGLE_TYPES.has(t))}`;
  }

  // Priorité 3 — nom du lieu
  if (!reason && INDOOR_NAME_RE.test(place?.name ?? '')) {
    reason = 'name_keyword';
  }

  // Priorité 4 — texte descriptif (whyGoodIdea, description, subtitle)
  if (!reason) {
    const text = [a.whyGoodIdea, a.description, a.subtitle].filter(Boolean).join(' ');
    if (INDOOR_TEXT_RE.test(text)) reason = 'description_text';
  }

  if (reason) {
    console.log(`[environment] corrected outdoor_to_indoor reason=${reason} place="${place?.name ?? '?'}"`);
    a.type = 'indoor';
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
  normalizeIndoorOutdoor,
};
