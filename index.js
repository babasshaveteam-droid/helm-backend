// Règles officielles : docs/HELM_CORE_RULES.md
const express = require('express');
const cors = require('cors');
const { fetchNearbyPlaces, fetchTargetedSearch } = require('./places');
const { normalizePlace, deduplicate, isFamilyPlace } = require('./normalize');
const { MOCK_ACTIVITIES } = require('./mock');
const { applyFamilyRules, normalizeIndoorOutdoor } = require('./activityRules');
const { resolveActivityEmoji, resolveAll } = require('./iconResolver');
const { filterFamilyActivities } = require('./qualityFilter');

const app = express();
app.use(cors());
app.use(express.json());

const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const OPENROUTER_ENABLED = process.env.OPENROUTER_ENABLED !== 'false';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4-5';
const DAILY_BUDGET_USD = parseFloat(process.env.OPENROUTER_DAILY_BUDGET_USD || '0') || 0;

// Prix par million de tokens selon le modèle (OpenRouter, mai 2026)
const MODEL_PRICING = {
  'anthropic/claude-sonnet-4-5': { in: 3.0,  out: 15.0 },
  'anthropic/claude-haiku-4-5':  { in: 0.80, out: 4.0  },
  'anthropic/claude-opus-4-7':   { in: 15.0, out: 75.0 },
};
function estimateCost(inTok, outTok) {
  const p = MODEL_PRICING[OPENROUTER_MODEL] ?? MODEL_PRICING['anthropic/claude-sonnet-4-5'];
  return (inTok * p.in + outTok * p.out) / 1_000_000;
}

if (!OPENROUTER_KEY) throw new Error('OPENROUTER_KEY manquante');

// ─── Cache activités (in-memory, TTL 20 min) ─────────────────────────────────

const ACTIVITY_CACHE = new Map();
const CACHE_TTL_MS = 20 * 60 * 1000;

function getCacheKey(lat, lon, weatherIntent, radiusMeters, searchGroup, exclude, activityIntent) {
  const latR = Math.round(lat * 100) / 100;
  const lonR = Math.round(lon * 100) / 100;
  const excKey = exclude.length === 0 ? '' : '|' + [...exclude].sort().join(',');
  const intentKey = activityIntent ? `|intent:${activityIntent}` : '';
  return `${latR},${lonR}|${weatherIntent}|${radiusMeters}|${searchGroup}${intentKey}${excKey}`;
}

function getCached(key) {
  const entry = ACTIVITY_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { ACTIVITY_CACHE.delete(key); return null; }
  return entry.activities;
}

function setCache(key, activities) {
  ACTIVITY_CACHE.set(key, { activities, expiresAt: Date.now() + CACHE_TTL_MS });
  if (ACTIVITY_CACHE.size > 500) {
    const now = Date.now();
    for (const [k, v] of ACTIVITY_CACHE) { if (now > v.expiresAt) ACTIVITY_CACHE.delete(k); }
  }
}

// ─── Budget journalier OpenRouter (in-memory, reset à minuit) ────────────────

let dailySpendUSD = 0;
let dailySpendResetAt = Date.now() + 24 * 60 * 60 * 1000;

function trackSpend(costUSD) {
  if (Date.now() > dailySpendResetAt) {
    dailySpendUSD = 0;
    dailySpendResetAt = Date.now() + 24 * 60 * 60 * 1000;
    console.log('[cost] Budget journalier réinitialisé');
  }
  dailySpendUSD += costUSD;
  console.log(`[cost] Dépense journalière: $${dailySpendUSD.toFixed(4)}${DAILY_BUDGET_USD > 0 ? ' / $' + DAILY_BUDGET_USD : ''}`);
}

function isBudgetExceeded() {
  if (!DAILY_BUDGET_USD) return false;
  if (Date.now() > dailySpendResetAt) { dailySpendUSD = 0; dailySpendResetAt = Date.now() + 24 * 60 * 60 * 1000; }
  return dailySpendUSD >= DAILY_BUDGET_USD;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractJSON(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch {} }
  const arr = trimmed.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch {} }
  throw new Error('No valid JSON in Claude response: ' + trimmed.slice(0, 200));
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toDistanceLabel(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

function toDistanceMinutes(km) {
  const min = Math.round((km / 4) * 60); // walking at 4 km/h
  return min < 60 ? `${min} min à pied` : `${Math.round(min / 60)}h à pied`;
}

// ─── Color & quality helpers ──────────────────────────────────────────────────

const ALLOWED_PASTELS = new Set(['#E8F5E9', '#FFF3E0', '#E3F2FD', '#F3E5F5', '#F5F0FF', '#FFF8E1']);

const CATEGORY_PASTEL_MAP = {
  Nature: '#E8F5E9', Culture: '#FFF3E0', Sport: '#E3F2FD',
  Gastronomie: '#FFF3E0', Loisirs: '#F5F0FF', Créatif: '#F3E5F5',
  'Pause famille': '#FFF3E0', Animaux: '#FFF8E1', Calme: '#F3E5F5',
};

function safeColorTheme(hex, category) {
  if (hex && ALLOWED_PASTELS.has(hex)) return hex;
  return CATEGORY_PASTEL_MAP[category] ?? '#F5F0FF';
}

function guessCategory(types = []) {
  if (types.includes('aquarium') || types.includes('zoo')) return 'Animaux';
  if (types.includes('library')) return 'Calme';
  // Culture avant Nature — museum/art_gallery doit gagner sur natural_feature (ex: Laténium)
  if (types.some(t => ['museum','art_gallery','historic_site','church','hindu_temple','mosque','castle','tourist_attraction'].includes(t))) return 'Culture';
  if (types.some(t => ['park','natural_feature','campground','rv_park','nature_reserve','botanical_garden','hiking_area'].includes(t))) return 'Nature';
  if (types.some(t => ['gym','sports_complex','stadium','swimming_pool','bowling_alley','ice_skating_rink'].includes(t))) return 'Sport';
  if (types.some(t => ['amusement_park','amusement_center'].includes(t))) return 'Loisirs';
  if (types.some(t => ['restaurant','cafe','bakery'].includes(t))) return 'Gastronomie';
  return 'Loisirs';
}

const TYPE_LABELS_FR = {
  park: 'parc', museum: 'musée', library: 'bibliothèque', zoo: 'zoo',
  tourist_attraction: 'à découvrir', cafe: 'café', art_gallery: 'galerie',
  amusement_center: 'loisirs', amusement_park: 'parc d\'attractions',
  natural_feature: 'nature', point_of_interest: 'lieu à découvrir',
};

function cleanTags(types = []) {
  return types.map(t => TYPE_LABELS_FR[t]).filter(Boolean).slice(0, 3);
}

const FORBIDDEN_TAGS = new Set([
  'tourist_attraction','point_of_interest','establishment','premise',
  'geocode','locality','political','sublocality','neighborhood',
  'route','administrative_area_level_1','administrative_area_level_2',
]);

function filterTags(tags = []) {
  return tags
    .filter(t => typeof t === 'string' && !t.includes('_') && !FORBIDDEN_TAGS.has(t) && t.length > 0 && t.length <= 30)
    .slice(0, 5);
}

const SUBTITLE_BY_CATEGORY = {
  Nature:         "Idéal pour prendre l'air en famille et profiter d'un moment dehors.",
  Culture:        'Idéal pour une sortie calme et éducative avec des enfants curieux.',
  Loisirs:        'Idéal pour une sortie simple et amusante avec les enfants.',
  'Pause famille': "Une pause gourmande simple à partager avec les enfants.",
  Animaux:        "Une découverte du monde animal pour petits et grands.",
  Calme:          "Un endroit calme pour lire, jouer ou découvrir ensemble.",
};

function formatTravelTime(seconds) {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min en voiture`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h${String(m).padStart(2, '0')} en voiture` : `${h}h en voiture`;
}

function formatRouteDistance(meters) {
  return meters < 1000 ? `${meters} m` : `${(meters / 1000).toFixed(1)} km`;
}

async function fetchTravelTimes(userLat, userLon, places, apiKey) {
  const valid = places.filter(p => p.lat != null && p.lon != null);
  if (!valid.length) return places;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    console.log(`[routes] Envoi ${valid.length} destinations à computeRouteMatrix`);
    valid.forEach((p, i) => console.log(`[routes]   [${i}] ${p.sourceId} (${p.name}) → ${p.lat},${p.lon}`));
    const res = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': '*',
      },
      body: JSON.stringify({
        origins: [{ waypoint: { location: { latLng: { latitude: userLat, longitude: userLon } } } }],
        destinations: valid.map(p => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lon } } } })),
        travelMode: 'DRIVE',
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    console.log(`[routes] Réponse HTTP: ${res.status}`);
    if (!res.ok) {
      const errBody = await res.text();
      console.warn('[routes] Routes API erreur:', res.status, errBody.slice(0, 800));
      return places;
    }
    const elements = await res.json();
    // Routes API returns status as {} (empty object) for success, never the string "OK"
    const okCount = elements.filter(el => !!el.duration).length;
    console.log(`[routes] ${elements.length} trajets reçus, ${okCount} OK, ${elements.length - okCount} KO`);
    const travelMap = new Map();
    elements.forEach((el) => {
      const idx = typeof el.destinationIndex === 'number' ? el.destinationIndex : null;
      if (idx === null || !valid[idx]) return;
      if (el.duration) {
        const raw = typeof el.duration === 'string' ? el.duration : String(el.duration?.seconds ?? '0');
        const secs = parseInt(raw.replace('s', ''), 10);
        console.log(`[routes] [${idx}] ${valid[idx].name}: ${raw} → ${secs}s, ${el.distanceMeters ?? '?'}m`);
        travelMap.set(valid[idx].sourceId, {
          routeDurationSeconds: isNaN(secs) ? null : secs,
          routeDistanceMeters: el.distanceMeters ?? null,
        });
      } else {
        console.warn(`[routes] KO [${idx}] ${valid[idx].name}: pas de durée`);
      }
    });
    const enriched = places.map(p => ({ ...p, ...(travelMap.get(p.sourceId) ?? {}) }));
    const withTime = enriched.filter(p => p.routeDurationSeconds != null).length;
    console.log(`[routes] ${withTime}/${enriched.length} activités avec travelTimeLabel`);
    return enriched;
  } catch (e) {
    console.warn('[routes] fetchTravelTimes échoue:', e.message, '→ fallback distances vol d\'oiseau');
    return places;
  }
}

const TYPE_EMOJI = {
  park: '🌳', museum: '🏛️', library: '📚',
  tourist_attraction: '🗺️', cafe: '☕',
  amusement_park: '🎡', amusement_center: '🛝',
  swimming_pool: '🏊', ice_skating_rink: '⛸️', castle: '🏰',
  historic_site: '🏛️', natural_feature: '🌿',
  nature_reserve: '🦋', zoo: '🦁',
  aquarium: '🐠', botanical_garden: '🌸',
  shopping_mall: '🏬', beach: '🏖️',
  bowling_alley: '🎳',
};

function typeEmoji(types = []) {
  for (const t of types) if (TYPE_EMOJI[t]) return TYPE_EMOJI[t];
  return '✨';
}

// ─── Heritage / religious site helpers ───────────────────────────────────────

function isHeritageSite(name = '', types = []) {
  return /abbaye|abbey|monastère|monastery|cathédrale|cathedral|église|church|chapelle|chapel|basilique|basilica|monument|prieuré|priory|mus[eé]e|museum|arch[eé]olog|patrimoine/i.test(name) ||
    types.some(t => ['historic_site','church','hindu_temple','mosque','synagogue','castle','museum'].includes(t));
}

function getHeritageTags(name = '') {
  const n = name.toLowerCase();
  if (/abbaye|abbey|monastère|monastery|prieuré/.test(n))
    return ['patrimoine', 'architecture', 'histoire', 'calme', 'balade'];
  if (/cathédrale|cathedral|basilique|basilica/.test(n))
    return ['patrimoine', 'architecture', 'religieux', 'culture', 'calme'];
  if (/église|church|chapelle|chapel/.test(n))
    return ['patrimoine', 'religieux', 'calme', 'culture'];
  if (/château|castle/.test(n))
    return ['patrimoine', 'histoire', 'architecture', 'culture'];
  return ['patrimoine', 'culture', 'architecture', 'calme'];
}

// ─── Place-type helpers ───────────────────────────────────────────────────────

function isShoppingMall(name = '', types = []) {
  if (types.includes('shopping_mall')) return true;
  if (/centre\s+commercial|shopping\s+(center|centre|mall)|galerie\s+commerciale\b/i.test(name)) return true;
  return false;
}

function isWaterActivity(name = '', types = []) {
  if (types.includes('beach')) return true;
  if (/plage|beach|baignade|piscine\s+naturelle|waterfront|bord\s+(du\s+lac|de\s+l['']eau)|rive\s+du\b|lac\s+(de|du)\b/i.test(name)) return true;
  return false;
}

// ─── Title / emoji / category quality helpers ─────────────────────────────────

const ENGLISH_TITLE_MARKERS = /\b(castle|cathedral|museum|church|garden|tower|palace|bridge|lake|park|forest|abbey|hall|gate|square|market)\b/i;

function correctTitle(claudeTitle, placeName) {
  if (!claudeTitle) return placeName;
  if (ENGLISH_TITLE_MARKERS.test(claudeTitle) && placeName &&
      claudeTitle.trim().toLowerCase() !== placeName.trim().toLowerCase()) {
    return placeName;
  }
  return claudeTitle;
}

const NAME_EMOJI_PATTERNS = [
  [/château|castle|fortress|forteresse|palais\b|palace/i, '🏰'],
  [/cathédrale|cathedral|église|church|chapelle|abbaye|abbey|basilique|basilica|prieuré/i, '⛪'],
  [/musée|museum/i, '🏛️'],
  [/pont\b|bridge/i, '🌉'],
  [/belvédère|belveder|viewpoint|panorama|vue\s+sur|sommet|sommet/i, '⛰️'],
  [/papiliorama|papillon|butterfly/i, '🦋'],
  [/zoo|safari|ferme\s*(animaux|animalière?|pédagog|d['']élevage|enfants?)/i, '🦁'],
  [/aquarium/i, '🐠'],
  [/payerneland|laurapark|laura\s*park|indoor\s*play(?:ground)?|aire\s+de\s+jeux\b/i, '🛝'],
  [/bowling/i, '🎳'],
  [/cin[ée]ma|cin[ée]plex/i, '🎬'],
  [/piscine|swimming/i, '🏊'],
  [/patinoire|ice\s*skat/i, '⛸️'],
  [/escalade|climbing\s*(gym|wall|center)|bloc\b/i, '🧗'],
  [/mini.golf|minigolf/i, '⛳'],
  [/skatepark|pumptrack/i, '🛹'],
  [/boulangerie|pâtisserie|pastry/i, '🥐'],
  [/forêt|forest|bois\b/i, '🌲'],
  [/plage|beach|baignade/i, '🏖️'],
  [/lac\b|lake|étang/i, '🌊'],
  [/jardin|garden|botanical/i, '🌸'],
  [/parc d['']attract|amusement park/i, '🎡'],
  [/bibliothèque|library/i, '📚'],
  [/galerie|gallery/i, '🎨'],
  [/centre\s+commercial|shopping\s+(center|centre|mall)|galerie\s+commerciale/i, '🏬'],
];

const TYPE_EMOJI_OVERRIDE = {
  castle: '🏰', church: '⛪', hindu_temple: '⛪', mosque: '⛪', museum: '🏛️',
  zoo: '🦁', aquarium: '🐠', botanical_garden: '🌸', amusement_park: '🎡', amusement_center: '🛝',
  library: '📚', art_gallery: '🎨', natural_feature: '🌿', park: '🌳',
  shopping_mall: '🏬', beach: '🏖️', ice_skating_rink: '⛸️',
};

function getEmojiOverride(types = [], name = '') {
  for (const [pattern, emoji] of NAME_EMOJI_PATTERNS) {
    if (pattern.test(name)) return emoji;
  }
  for (const t of types) if (TYPE_EMOJI_OVERRIDE[t]) return TYPE_EMOJI_OVERRIDE[t];
  return null;
}

function determineCategoryOverride(types = [], name = '') {
  if (types.includes('aquarium') || types.includes('zoo') ||
      /zoo|aquarium|safari|parc\s+animalier|ferme\s*(animaux|animalière?|pédagog|d['']élevage|enfants?)|papiliorama/i.test(name))
    return 'Animaux';
  if (types.includes('library') || /bibliothèque|médiathèque|ludothèque/i.test(name))
    return 'Calme';
  if (
    types.some(t => ['museum','art_gallery','historic_site','castle','church',
                     'hindu_temple','mosque','synagogue','tourist_attraction'].includes(t)) ||
    /château|castle|cathédrale|cathedral|mus[eé]e|museum|abbaye|église|monument|arch[eé]olog|patrimoine/i.test(name)
  ) return 'Culture';
  // Water/beach — must be Nature, checked before generic natural_feature to be explicit
  if (isWaterActivity(name, types)) return 'Nature';
  if (types.some(t => ['park','natural_feature','campground','nature_reserve','botanical_garden','beach'].includes(t)))
    return 'Nature';
  if (types.some(t => ['amusement_park','amusement_center'].includes(t)))
    return 'Loisirs';
  return null;
}

// ─── Fallback content by category ────────────────────────────────────────────

const HERITAGE_WHAT_TO_BRING = ['Appareil photo', 'Eau', 'Chaussures confortables', 'Petite veste'];

const WHAT_TO_BRING_DEFAULTS = {
  Nature:         ['Chaussures confortables', "Bouteille d'eau", 'Vêtements adaptés à la météo'],
  Culture:        ['Appareil photo', 'Eau', 'Porte-monnaie'],
  Sport:          ['Tenue de sport', "Bouteille d'eau", 'Chaussures adaptées'],
  Gastronomie:    ['Porte-monnaie', 'Petite faim'],
  Loisirs:        ['Eau', 'Petite veste', 'Porte-monnaie'],
  'Pause famille': ['Porte-monnaie', 'Petite faim'],
  Animaux:        ['Eau', 'Porte-monnaie', 'Appareil photo', 'Vêtements adaptés'],
  Calme:          ['Carte de bibliothèque', 'Porte-monnaie'],
};

const PRACTICAL_INFOS_DEFAULTS = {
  Nature:         ['Horaires à vérifier avant de partir', 'Accès en voiture conseillé'],
  Culture:        ['Horaires à vérifier avant de partir', "Adresse disponible dans l'itinéraire", 'Prix à vérifier'],
  Sport:          ['Horaires à vérifier avant de partir', 'Réservation parfois nécessaire'],
  Gastronomie:    ['Horaires à vérifier avant de partir', 'Prix à vérifier'],
  Loisirs:        ['Horaires à vérifier avant de partir', 'Adapté aux enfants'],
  'Pause famille': ['Horaires à vérifier avant de partir', 'Prix à vérifier'],
  Animaux:        ['Activité adaptée aux enfants', 'Tarifs et horaires à vérifier'],
  Calme:          ['Entrée souvent gratuite', 'Horaires à vérifier avant de partir'],
};


// ─── Merge Claude output with real place data ─────────────────────────────────
// Any sourceId Claude returns that isn't in placesMap is silently discarded —
// this enforces the "no hallucinated places" rule at the data level.

function mergeWithPlaceData(claudeItem, placesMap, userLat, userLon, weatherIntent) {
  const place = placesMap.get(claudeItem.sourceId);
  if (!place) {
    console.warn('[merge] unknown sourceId from Claude:', claudeItem.sourceId, '→ discarded');
    return null;
  }

  const km =
    place.lat != null && place.lon != null && userLat != null && userLon != null
      ? haversineKm(userLat, userLon, place.lat, place.lon)
      : null;

  const titre = correctTitle(claudeItem.titre, place.name);

  const category = determineCategoryOverride(place.types, place.name)
                   || claudeItem.category
                   || guessCategory(place.types)
                   || 'Loisirs';

  const emoji = '✨';  // provisoire — écrasé par resolveAll après merge

  const colorTheme = safeColorTheme(claudeItem.colorTheme, category);

  const rawWhatToBring = Array.isArray(claudeItem.whatToBring) ? claudeItem.whatToBring : [];
  const rawPractical   = Array.isArray(claudeItem.practicalInfos) ? claudeItem.practicalInfos : [];
  const rawTags        = Array.isArray(claudeItem.tags) ? claudeItem.tags : [];
  const cleanedTags    = filterTags(rawTags);

  const travelTimeLabel = place.routeDurationSeconds != null
    ? formatTravelTime(place.routeDurationSeconds)
    : (km != null ? `~${Math.round((km / 50) * 60)} min en voiture` : null);
  if (travelTimeLabel) {
    console.log(`[merge] ${place.name}: travelTimeLabel="${travelTimeLabel}"`);
  } else {
    console.warn(`[merge] ${place.name}: travelTimeLabel NULL — routeDurationSeconds=${place.routeDurationSeconds}, km=${km?.toFixed(2) ?? 'null'}, lat=${place.lat}, lon=${place.lon}`);
  }

  const travelDistanceLabel = place.routeDistanceMeters != null
    ? formatRouteDistance(place.routeDistanceMeters)
    : (km != null ? `~${km.toFixed(1)} km` : null);

  const subtitle = claudeItem.subtitle || '';

  // Default whatToBring/practicalInfos/tags before family correction gate
  const whatToBring = rawWhatToBring.length > 0 ? rawWhatToBring
    : (isHeritageSite(place.name, place.types)
        ? HERITAGE_WHAT_TO_BRING
        : (WHAT_TO_BRING_DEFAULTS[category] ?? WHAT_TO_BRING_DEFAULTS.Loisirs));
  console.log(`[pipeline] clean_bring_items before=${rawWhatToBring.length} after=${whatToBring.length} place="${place.name}"`);

  let practicalInfos;
  if (rawPractical.length > 0) {
    practicalInfos = rawPractical;
  } else if (place.isOpen != null) {
    practicalInfos = [
      place.isOpen ? 'Ouvert maintenant' : 'Horaires à vérifier avant de partir',
      ...(PRACTICAL_INFOS_DEFAULTS[category] ?? []).slice(1),
    ];
  } else {
    practicalInfos = PRACTICAL_INFOS_DEFAULTS[category] ?? ['Horaires à vérifier avant de partir'];
  }

  const tags = cleanedTags.length > 0 ? cleanedTags
    : (isHeritageSite(place.name, place.types) ? getHeritageTags(place.name) : cleanTags(place.types));

  const result = {
    id: place.sourceId,
    emoji,
    titre,
    description: subtitle || claudeItem.whyGoodIdea || place.name,
    subtitle,
    locationName: place.name,
    address: place.address,
    latitude: place.lat,
    longitude: place.lon,
    distanceLabel: km != null ? toDistanceLabel(km) : 'À vérifier',
    distanceMinutes: km != null ? toDistanceMinutes(km) : 'À vérifier',
    duree: claudeItem.duree || 'À vérifier',
    durationLabel: claudeItem.duree ? `${claudeItem.duree} en famille` : 'À vérifier',
    budget: claudeItem.priceLabel || 'À vérifier',
    priceLabel: claudeItem.priceLabel || 'À vérifier',
    priceAmount: claudeItem.priceAmount ?? null,
    type: claudeItem.type || 'outdoor',
    minAgeLabel: claudeItem.minAgeLabel || 'À vérifier',
    category,
    mood: Array.isArray(claudeItem.mood) ? claudeItem.mood : [],
    weatherFit: Array.isArray(claudeItem.weatherFit) ? claudeItem.weatherFit : ['any'],
    weatherReason: claudeItem.weatherReason || null,
    weatherIntent: weatherIntent || null,
    reservationRequired: claudeItem.reservationRequired ?? false,
    icon: claudeItem.icon || emoji,
    colorTheme,
    benefit: claudeItem.benefit || '',
    whyGoodIdea: claudeItem.whyGoodIdea || '',
    whatToBring,
    practicalInfos,
    tags,
    effortLevel: claudeItem.effortLevel || null,
    travelTimeLabel,
    travelDistanceLabel,
    routeDurationSeconds: place.routeDurationSeconds ?? null,
    routeDistanceMeters: place.routeDistanceMeters ?? null,
    source: 'google_places',
    sourceId: place.sourceId,
  };

  const afterFamily = applyFamilyRules(result, place.name, place.types, { fromFallback: false, isOpen: place.isOpen });
  return normalizeIndoorOutdoor(afterFamily, place);
}

// ─── Fallback: Google places → minimal Activity (Claude unavailable) ───────────

function placesToFallback(places, userLat, userLon, weatherIntent) {
  return places.slice(0, 6).map(p => {
    const km =
      p.lat != null && p.lon != null && userLat != null && userLon != null
        ? haversineKm(userLat, userLon, p.lat, p.lon)
        : null;
    const emojiResult = resolveActivityEmoji(p);
    const emoji    = emojiResult.icon;
    const category = determineCategoryOverride(p.types, p.name) || guessCategory(p.types);
    const subtitle = SUBTITLE_BY_CATEGORY[category] ?? 'Idéal pour une sortie en famille.';

    const base = {
      id: p.sourceId,
      emoji,
      titre: p.name,
      description: subtitle,
      subtitle,
      locationName: p.name,
      address: p.address,
      latitude: p.lat,
      longitude: p.lon,
      distanceLabel: km != null ? toDistanceLabel(km) : 'À vérifier',
      distanceMinutes: km != null ? toDistanceMinutes(km) : 'À vérifier',
      duree: 'À vérifier',
      durationLabel: 'À vérifier',
      budget: 'Prix à vérifier',
      priceLabel: 'Prix à vérifier',
      priceAmount: null,
      type: 'outdoor',
      minAgeLabel: 'Tout âge',
      category,
      mood: [],
      weatherFit: ['any'],
      weatherReason: null,
      weatherIntent: weatherIntent || null,
      reservationRequired: false,
      icon: emoji,
      colorTheme: CATEGORY_PASTEL_MAP[category] ?? '#F5F0FF',
      benefit: 'Un lieu proche à découvrir',
      whyGoodIdea: subtitle,
      whatToBring: [],
      practicalInfos: [],
      tags: [],
      effortLevel: 'Facile',
      travelTimeLabel: p.routeDurationSeconds != null
        ? formatTravelTime(p.routeDurationSeconds)
        : (km != null ? `~${Math.round((km / 50) * 60)} min en voiture` : null),
      travelDistanceLabel: p.routeDistanceMeters != null
        ? formatRouteDistance(p.routeDistanceMeters)
        : (km != null ? `~${km.toFixed(1)} km` : null),
      routeDurationSeconds: p.routeDurationSeconds ?? null,
      routeDistanceMeters: p.routeDistanceMeters ?? null,
      source: 'google_places',
      sourceId: p.sourceId,
    };

    const afterRules = applyFamilyRules(base, p.name, p.types, { fromFallback: true, isOpen: p.isOpen });
    return resolveAll(afterRules, p);
  });
}

// ─── Final normalization — dernier passage obligatoire avant res.json ─────────

function normalizeInfoText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/\bpartires?\b/gi, 'partir')
    .replace(/vérifier les horaires avant la visite/gi, 'Horaires à vérifier avant de partir')
    .replace(/Actuellement fermé - vérifier horaires?/gi, 'Horaires à vérifier avant de partir')
    .replace(/Actuellement fermé/gi, 'Horaires à vérifier avant de partir')
    .replace(/Fermé actuellement/gi, 'Horaires à vérifier avant de partir')
    .replace(/Parking proche/gi, 'Stationnement à vérifier')
    .replace(/^À vérifier$/i, 'Horaires à vérifier avant de partir')
    .trim();
}

function stripConflictingTravelTime(text) {
  const stripped = text
    .replace(/,?\s*(à\s+)?(environ\s+)?~?\d+\s*(h\s*\d*\s*)?min(utes?)?(\s+(en\s+voiture|à\s+pied|de\s+route|de\s+trajet|de\s+bus))?/gi, '')
    .replace(/,?\s*(à\s+)?(environ\s+)?\d+\s*(heures?|h)\s+(en\s+voiture|à\s+pied|de\s+route|de\s+trajet)/gi, '')
    .replace(/\s*,\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length >= 4 ? stripped : null;
}

const HORAIRE_NORMALIZE_RE = /horaires?.*vérif|vérif.*horaires?|avant de partir|avant la visite|vérifier avant/i;

function semanticDedupInfos(infos) {
  let horaireAdded = false;
  const seen = new Set();
  const result = [];
  for (const item of infos) {
    const raw  = typeof item === 'string' ? item : item.text;
    const icon = typeof item === 'object' ? item.icon : '✨';
    const isHoraire = HORAIRE_NORMALIZE_RE.test(raw);
    const text = isHoraire ? 'Horaires à vérifier avant de partir' : raw;
    const key  = text.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    if (isHoraire && horaireAdded) continue;
    if (isHoraire) horaireAdded = true;
    result.push({ text, icon });
  }
  return result;
}

function normalizeActivityForDisplay(activity) {
  if (!activity) return null;
  let infos = (activity.practicalInfos ?? []).map(item => {
    const rawText = typeof item === 'string' ? item : item.text;
    const icon    = typeof item === 'object' ? item.icon : '✨';
    const normalized = normalizeInfoText(rawText);
    return normalized ? { text: normalized, icon } : null;
  }).filter(Boolean);
  if (activity.travelTimeLabel) {
    infos = infos.map(item => {
      const stripped = stripConflictingTravelTime(item.text);
      return stripped ? { ...item, text: stripped } : null;
    }).filter(Boolean);
  }
  return { ...activity, practicalInfos: semanticDedupInfos(infos) };
}

const GENERIC_TITLES = new Set([
  'Balade en nature', 'Visite culturelle', 'Pause gourmande', 'Sortie en famille',
  'Activité en famille', 'Promenade', 'Visite', 'Sortie',
]);

const HIGH_VALUE_LONG_DISTANCE = new Set([
  'zoo', 'aquarium', 'museum', 'art_gallery', 'amusement_center', 'amusement_park',
  'bowling_alley', 'swimming_pool', 'ice_skating_rink', 'library',
  'historic_site', 'castle', 'botanical_garden', 'tourist_attraction', 'natural_feature',
  'movie_theater',
  'park',
]);

function expandRadius(r) {
  if (r <= 1000) return 5000;
  if (r <= 3000) return 12000;
  if (r <= 8000) return 25000;
  return Math.min(Math.round(r * 1.5), 50000);
}

function sendActivities(res, activities) {
  if (res.headersSent) return;
  res.json(
    (Array.isArray(activities) ? activities : [activities])
      .map(normalizeActivityForDisplay)
      .filter(Boolean)
  );
}

function validateNearbyActivity(activity) {
  if (!activity) return false;
  if (activity.source === 'mock') {
    console.log('[quality] Rejeté mock source:', activity.title);
    return false;
  }
  if (typeof activity.sourceId === 'string' && activity.sourceId.startsWith('mock-')) {
    console.log('[quality] Rejeté mock sourceId:', activity.sourceId);
    return false;
  }
  if (GENERIC_TITLES.has(activity.title)) {
    console.log('[quality] Rejeté titre générique:', activity.title);
    return false;
  }
  const hasCoords = typeof activity.latitude === 'number' && typeof activity.longitude === 'number';
  const hasAddress = typeof activity.address === 'string' && activity.address.length > 3 && activity.address !== 'À vérifier';
  if (!hasCoords && !hasAddress) {
    console.log('[quality] Rejeté sans coords ni adresse:', activity.title);
    return false;
  }
  return true;
}

// ─── Weather validation finale — filtre les activités outdoor inadaptées ───────
// Chercher large (getTargetedSearches) → afficher intelligemment (ici).
function filterActivitiesByWeather(activities, weatherIntent, userLat, userLon) {
  if (!weatherIntent || weatherIntent === 'sunny' || weatherIntent === 'neutral') {
    return activities;
  }
  return activities.filter(a => {
    const type   = (a.type || 'outdoor').toLowerCase();
    const effort = a.effortLevel || 'Facile';
    const name   = a.titre || a.locationName || '?';
    const km     = (a.latitude != null && a.longitude != null && userLat != null && userLon != null)
      ? haversineKm(userLat, userLon, a.latitude, a.longitude)
      : null;

    // Indoor / mixed → toujours autorisé
    if (type === 'indoor' || type === 'mixed') return true;

    // outdoor depuis ici
    if (weatherIntent === 'rainy') {
      console.log(`[weather] rejected_outdoor reason=rainy name="${name}"`);
      return false;
    }
    if (weatherIntent === 'cold') {
      if (effort === 'Aventure') {
        console.log(`[weather] rejected_outdoor reason=cold effort=Aventure name="${name}"`);
        return false;
      }
      // "randonnée" Moyen ou Aventure → trop exposé par froid
      if (/\brandonnée\b/i.test(name) && effort !== 'Facile') {
        console.log(`[weather] rejected_outdoor reason=cold_hike name="${name}"`);
        return false;
      }
      console.log(`[weather] allowed_outdoor reason=short_near_easy name="${name}"`);
      return true;
    }
    if (weatherIntent === 'unstable') {
      if (effort === 'Aventure') {
        console.log(`[weather] rejected_outdoor reason=unstable effort=Aventure name="${name}"`);
        return false;
      }
      // "randonnée" Moyen → trop exposé par temps instable quelle que soit la distance
      if (/\brandonnée\b/i.test(name) && effort !== 'Facile') {
        console.log(`[weather] rejected_outdoor reason=unstable_hike name="${name}"`);
        return false;
      }
      if (effort === 'Moyen' && km !== null && km > 25) {
        console.log(`[weather] rejected_outdoor reason=unstable effort=Moyen km=${km.toFixed(1)} name="${name}"`);
        return false;
      }
      console.log(`[weather] allowed_outdoor reason=short_near_easy name="${name}"`);
      return true;
    }
    if (weatherIntent === 'hot') {
      const isWaterOrShade = /\b(lac|plage|piscine|baignade|for[eê]t|bois|ombre|aquatique)\b/i.test(
        `${a.titre || ''} ${a.category || ''} ${a.locationName || ''}`
      );
      if (isWaterOrShade) {
        console.log(`[weather] allowed_outdoor reason=water_or_shade name="${name}"`);
        return true;
      }
      if (effort === 'Aventure') {
        console.log(`[weather] rejected_outdoor reason=hot_exposed effort=Aventure name="${name}"`);
        return false;
      }
      return true;
    }
    return true;
  });
}

function sendNearbyActivities(res, activities) {
  if (res.headersSent) return;
  const list = Array.isArray(activities) ? activities : [activities];
  const validated = list
    .map(normalizeActivityForDisplay)
    .filter(Boolean)
    .filter(validateNearbyActivity);
  console.log(`[quality] ${validated.length}/${list.length} activités passent la validation`);
  res.json(validated);
}

// ─── Weather intent ───────────────────────────────────────────────────────────

function getWeatherIntent(weatherCondition, weatherTemp) {
  const main = (weatherCondition || '').toLowerCase();
  const temp = typeof weatherTemp === 'number' ? weatherTemp : null;
  if (['rain', 'drizzle', 'thunderstorm', 'snow'].some(k => main.includes(k))) return 'rainy';
  if (temp !== null && temp < 8) return 'cold';
  if (temp !== null && temp > 27) return 'hot';
  if (main === 'clear' && (temp === null || (temp >= 10 && temp <= 26))) return 'sunny';
  if (['clouds', 'mist', 'fog', 'haze', 'squall'].some(k => main.includes(k))) return 'unstable';
  return 'neutral';
}

// ─── Weather instruction builder ─────────────────────────────────────────────

const WEATHER_INSTRUCTIONS = {
  rainy:    'La météo est pluvieuse. Priorise les activités couvertes, proches, simples et adaptées aux enfants. Évite les randonnées, parcs et longues sorties extérieures.',
  sunny:    'La météo est agréable. Priorise les sorties extérieures, nature, animaux et balades faciles. Les activités en plein air sont idéales.',
  cold:     'Il fait froid. Priorise les activités intérieures ou au chaud. Tu peux aussi proposer une activité extérieure courte, proche, facile et familiale si la météo n\'est pas dangereuse. Évite les longues sorties dehors ou les lieux trop exposés.',
  hot:      'Il fait chaud. Priorise les lieux frais, ombragés, avec eau ou indoor. Évite les activités physiques longues.',
  unstable: 'La météo est instable. Priorise les activités flexibles, proches, couvertes ou faciles à écourter.',
};

function buildWeatherInstruction(weatherIntent) {
  const instruction = WEATHER_INSTRUCTIONS[weatherIntent];
  return instruction ? `\n⚠️ Consigne météo : ${instruction}` : '';
}

// ─── Claude prompt (compact) ─────────────────────────────────────────────────
// Champs non demandés à Claude (gérés localement) : emoji, titre, category,
// colorTheme, type, reservationRequired, icon, tags — tous overridés par le code.

function buildClaudePrompt(places, { weatherCondition, weatherTemp, weatherIntent }) {
  const placesJson = JSON.stringify(
    places.map(p => ({
      sourceId: p.sourceId,
      name: p.name,
      types: p.types,
      rating: p.rating ?? null,
      isOpen: p.isOpen ?? null,
    })),
    null, 2
  );

  const weatherNote = weatherIntent && weatherIntent !== 'neutral'
    ? `\nMétéo : ${weatherCondition || ''} ${weatherTemp != null ? weatherTemp + '°C' : ''} → ${WEATHER_INSTRUCTIONS[weatherIntent] ?? ''}`
    : '';

  return `Tu es l'assistant Helm (app famille). Sélectionne 3 à 8 lieux parmi la liste et génère un JSON enrichi pour chacun.${weatherNote}

Lieux disponibles (source Google Places) :
${placesJson}

Règles :
1. Sélectionne UNIQUEMENT des sourceId de la liste. N'invente aucun lieu.
2. N'invente pas de prix, horaires, parking, WiFi, réservation — si incertain : "à vérifier".
3. Textes courts et chaleureux, max 1 phrase par champ texte. Pas de marketing.
4. effortLevel : "Facile" (parc/musée/café), "Moyen" (grande visite culturelle), "Aventure" (randonnée/terrain difficile).
5. whyGoodIdea : phrase concrète utile pour un parent.
6. subtitle : pour quel type de famille, différent de whyGoodIdea.
7. weatherReason : ≤32 caractères avec emoji (ex: "☀️ Idéal avec ce soleil").
8. practicalInfos : 2-3 infos DISTINCTES. JAMAIS de durée de trajet.
9. whatToBring : items pratiques. Jamais "Bonne humeur" ni "Tenue confortable".
10. Retourne UNIQUEMENT un tableau JSON valide, sans texte avant ou après.

Format de chaque objet (tous ces champs obligatoires) :
{
  "sourceId": "...",
  "subtitle": "(pour quel type de famille, 1 phrase)",
  "whyGoodIdea": "(phrase concrète pour un parent)",
  "benefit": "(5 mots max)",
  "duree": "(ex: 2h)",
  "priceLabel": "(Gratuit | Prix à vérifier | prix estimé)",
  "priceAmount": (0 si gratuit, null si inconnu),
  "minAgeLabel": "(Dès X ans | Tout âge)",
  "effortLevel": "(Facile|Moyen|Aventure)",
  "mood": ["(calme|energique|creatif|social|aventure)"],
  "weatherFit": ["(sunny|cloudy|rainy|any)"],
  "weatherReason": "(≤32 chars avec emoji)",
  "whatToBring": ["(2-4 items pratiques)"],
  "practicalInfos": ["(2-3 infos distinctes, jamais de durée de trajet)"]
}`;
}

// ─── POST /generer-activites ──────────────────────────────────────────────────

app.post('/generer-activites', async (req, res) => {
  const {
    latitude,
    longitude,
    exclude = [],
    radiusMeters = 15000,
    weather,
    weatherCondition,
    weatherTemp,
    filters,
    searchGroup = 0,
    refreshCount = 0,
    activityIntent = null,
  } = req.body;

  const weatherIntent = getWeatherIntent(weatherCondition, weatherTemp);
  console.log(`[backend] /generer-activites — lat=${latitude} lon=${longitude} radius=${radiusMeters} group=${searchGroup} intent=${activityIntent ?? 'general'}`);
  console.log(`[weather] temp=${weatherTemp ?? 'n/a'}°C condition=${weatherCondition ?? 'n/a'} priority=${weatherIntent}`);

  // 1. Validate coordinates
  if (
    typeof latitude !== 'number' || typeof longitude !== 'number' ||
    isNaN(latitude) || isNaN(longitude) ||
    latitude < -90 || latitude > 90 ||
    longitude < -180 || longitude > 180
  ) {
    return res.status(400).json({ erreur: 'latitude et longitude invalides ou manquantes' });
  }

  // 2. Abort early if Google Places key is missing
  if (!GOOGLE_PLACES_API_KEY) {
    console.warn('[backend] GOOGLE_PLACES_API_KEY absente — réponse vide');
    if (!res.headersSent) res.json([]); return;
  }

  // 2b. Cache check — retourner immédiatement si même zone/météo/groupe déjà enrichi
  const excludeArr = Array.isArray(exclude) ? exclude : [];
  const cacheKey = getCacheKey(latitude, longitude, weatherIntent, radiusMeters, searchGroup, excludeArr, activityIntent);
  console.log(`[refresh] count=${refreshCount} radius_used=${radiusMeters} searchGroup=${searchGroup} excludeCount=${excludeArr.length}`);
  console.log(`[distance] initial_nearest_search=${radiusMeters <= 2000}`);
  const cachedResult = getCached(cacheKey);
  if (cachedResult) {
    console.log(`[cache] HIT (${cachedResult.length} activités) — ${cacheKey.substring(0, 40)}`);
    return res.json(cachedResult);
  }

  // Outer scope so the safety timer can fall back to real places if Claude hangs
  let candidates = null;

  // Safety timeout: use real Google places if available, else mock
  const safetyTimer = setTimeout(() => {
    if (!res.headersSent) {
      if (candidates?.length) {
        console.warn('[backend] Timeout 25s — fallback lieux Google bruts');
        sendActivities(res, placesToFallback(candidates, latitude, longitude, weatherIntent));
      } else {
        console.warn('[backend] Timeout 25s — réponse vide (pas de lieux réels disponibles)');
        res.json([]);
      }
    }
  }, 32000);

  try {
    // 3. Google Places Nearby Search
    let rawPlaces;
    try {
      rawPlaces = await fetchNearbyPlaces(latitude, longitude, radiusMeters, GOOGLE_PLACES_API_KEY, searchGroup, weatherIntent, activityIntent);
      console.log(`[places] nearbyResults=${rawPlaces.length} (group=${searchGroup} radius=${radiusMeters}m)`);
    } catch (placesErr) {
      console.error('[backend] Google Places échoue:', placesErr.message, '→ réponse vide');
      if (!res.headersSent) res.json([]); return;
    }

    if (!rawPlaces.length) {
      console.warn(`[places] nearbyResults=0 (group=${searchGroup} radius=${radiusMeters}m) → retry altGroup + rayon élargi`);
      try {
        const altGroup = (searchGroup + 2) % 4;
        const widerR = expandRadius(radiusMeters);
        rawPlaces = await fetchNearbyPlaces(latitude, longitude, widerR, GOOGLE_PLACES_API_KEY, altGroup, null);
        console.log(`[distance] radius_attempt=${widerR} auto_expand=true → ${rawPlaces.length} lieux`);
      } catch (retryErr) {
        console.warn('[places] retry échoue:', retryErr.message);
      }
      if (!rawPlaces.length) {
        console.warn('[empty] reason=google_0_results_even_after_retry');
        if (!res.headersSent) res.json([]); return;
      }
    }

    // 4. Normalize → deduplicate → filter family-appropriate → exclude already-seen
    const excludeSet = new Set(Array.isArray(exclude) ? exclude : []);
    const normalized = rawPlaces.map(normalizePlace);
    let deduped = filterFamilyActivities(deduplicate(normalized).filter(isFamilyPlace));

    // 4a. Recherches ciblées — intent d'envie ou météo-aware
    // Règle : chercher large, filtrer ensuite par filterActivitiesByWeather.
    function getTargetedSearches(sg, wi, intent) {
      const byGroup = {
        0: 'musée exposition grotte caverne souterrain',
        1: 'salle escalade climbing bloc trampoline aire de jeux',
        2: 'ferme pédagogique parc animalier cinéma bowling',
        3: 'forêt randonnée balade sentier famille ferme animaux poney',
      };

      // Intent d'envie prioritaire sur la météo
      if (intent === 'sport') {
        return [
          'piscine couverte trampoline park famille',
          'salle escalade climbing bloc famille',
          'bowling patinoire famille',
          'laser game famille enfants',
          'karting kart famille enfants',
          'accrobranche tyrolienne zip-line famille',
          'aire de jeux couverte intérieure famille',
        ];
      }
      if (intent === 'calme') {
        return [
          'bibliothèque médiathèque jeunesse enfants',
          'ludothèque jeux famille',
          'musée calme exposition famille',
          'café famille salon thé',
          'librairie jeunesse enfants',
          'planétarium astronomie famille',
        ];
      }
      if (intent === 'nature') {
        return [
          'forêt balade sentier famille',
          'lac plage baignade famille',
          'ferme pédagogique animaux enfants famille',
          'zoo parc animalier famille',
          'belvédère point de vue montagne famille',
          'parc jardin botanique famille',
          'randonnée nature famille enfants',
        ];
      }
      if (intent === 'culture') {
        return [
          'musée famille enfants',
          'aquarium visite famille',
          'château visite patrimoine famille',
          'grotte caverne visite famille',
          'exposition interactive famille',
          'ferme pédagogique éducative famille',
          'site historique patrimoine famille',
        ];
      }
      if (wi === 'rainy') {
        return [
          'ludothèque bibliothèque jeunesse enfants',
          'salle escalade climbing trampoline',
          'cinéma ciné film enfants famille',
          'grotte caverne visite famille',
          'laser game famille enfants',
          'escape room famille enfants',
        ];
      }
      if (wi === 'cold') {
        return [
          'ludothèque bibliothèque jeunesse enfants',
          'salle escalade climbing trampoline',
          'cinéma ciné film enfants famille',
          'grotte caverne visite famille',
          'ferme pédagogique animaux enfants famille',
          'forêt promenade courte famille',
          'balade montagne courte point de vue',
          'spectacle théâtre marionnettes enfants',
          'laser game famille enfants',
        ];
      }
      if (wi === 'sunny') {
        const queries = [
          'ferme pédagogique parc animalier zoo',
          'forêt balade jardin famille',
          'lac plage baignade famille',
          'balade montagne point de vue famille',
          'grotte caverne visite famille',
          'trampoline park famille',
          'aire de jeux extérieure famille',
          'mini golf famille',
          'accrobranche tyrolienne famille',
          'équitation poney promenade famille',
          'ferme animaux enfants visite',
          'lac montagne randonnée famille',
        ];
        if (byGroup[sg]) queries.push(byGroup[sg]);
        return queries;
      }
      if (wi === 'hot') {
        return [
          'piscine plage lac baignade aquarium',
          'balade ombre nature forêt parc famille',
          'ferme pédagogique animaux enfants',
          'aire de jeux extérieure famille',
          'mini golf famille',
        ];
      }
      if (wi === 'unstable') {
        return [
          'ludothèque bibliothèque jeunesse enfants',
          'bowling piscine couverte cinéma famille',
          'trampoline park famille',
          'grotte caverne visite famille',
          'laser game famille enfants',
          'ferme pédagogique animaux enfants famille',
          'forêt promenade courte famille',
          'balade montagne point de vue famille',
        ];
      }
      if (wi === 'neutral') {
        const queries = [
          'ferme pédagogique parc animalier zoo',
          'forêt balade sentier famille',
          'balade montagne point de vue famille',
          'équitation poney promenade famille',
          'lac randonnée balade famille',
          'grotte caverne visite famille',
          'trampoline park famille',
          'musée exposition famille',
        ];
        if (byGroup[sg]) queries.push(byGroup[sg]);
        return queries;
      }
      return byGroup[sg] ? [byGroup[sg]] : [];
    }
    const targetedSearches = getTargetedSearches(searchGroup, weatherIntent, activityIntent);
    for (const query of targetedSearches) {
      try {
        const targeted = await fetchTargetedSearch(
          latitude, longitude, radiusMeters,
          GOOGLE_PLACES_API_KEY, query, 8
        );
        console.log(`[targeted] "${query}": ${targeted.length} résultats`);
        const targetedNorm = filterFamilyActivities(targeted.map(normalizePlace).filter(isFamilyPlace));
        deduped = deduplicate([...deduped, ...targetedNorm]);
      } catch (e) {
        console.warn('[targeted] Recherche ciblée échoue:', e.message);
      }
    }

    console.log(`[places] pool total après targeted searches: ${deduped.length} lieux`);
    let fresh = excludeSet.size > 0 ? deduped.filter(p => !excludeSet.has(p.sourceId)) : deduped;

    // 4b. Filtre qualité à longue distance — éviter cafés/parcs génériques loin
    if (radiusMeters > 40000 && fresh.length >= 3) {
      const highValue = fresh.filter(p => p.types.some(t => HIGH_VALUE_LONG_DISTANCE.has(t)));
      if (highValue.length >= 3) {
        fresh = highValue;
        console.log(`[backend] Filtre qualité longue distance (${radiusMeters}m): ${fresh.length} lieux haute valeur`);
      }
    }

    // If too few fresh results after filtering, retry with a wider radius (2 phases)
    if (fresh.length < 3) {
      console.log(`[refresh] Seulement ${fresh.length} candidats (excludeCount=${excludeSet.size}) — rayon élargi`);
      try {
        const widerRadius = expandRadius(radiusMeters);
        const rawPlaces2 = await fetchNearbyPlaces(
          latitude, longitude, widerRadius, GOOGLE_PLACES_API_KEY, (searchGroup + 1) % 4, null
        );
        let fresh2 = deduplicate(rawPlaces2.map(normalizePlace))
          .filter(isFamilyPlace)
          .filter(p => !excludeSet.has(p.sourceId));
        if (widerRadius > 40000 && fresh2.length >= 3) {
          const hv2 = fresh2.filter(p => p.types.some(t => HIGH_VALUE_LONG_DISTANCE.has(t)));
          if (hv2.length >= 3) fresh2 = hv2;
        }
        if (fresh2.length > fresh.length) {
          fresh = fresh2;
          console.log(`[distance] radius_attempt=${widerRadius} auto_expand=true → ${fresh.length} candidats`);
        }
      } catch (e) {
        console.warn('[refresh] Retry rayon élargi échoue:', e.message);
      }

      // Phase 2 — si toujours < 3 après retry, relâcher l'exclude
      if (fresh.length < 3 && excludeSet.size > 0) {
        console.log('[refresh] exclude_relaxed=true — relâchement de l\'exclude');
        const freshNoExclude = deduped.filter(Boolean);
        if (freshNoExclude.length > fresh.length) {
          fresh = freshNoExclude;
          console.log(`[refresh] Exclude relâché: ${fresh.length} candidats (dont déjà vus)`);
        }
      }
    }

    // Trier par distance croissante — activités les plus proches en premier
    fresh.sort((a, b) => {
      const dA = (a.lat != null && a.lon != null) ? haversineKm(latitude, longitude, a.lat, a.lon) : 999;
      const dB = (b.lat != null && b.lon != null) ? haversineKm(latitude, longitude, b.lat, b.lon) : 999;
      return dA - dB;
    });
    console.log(`[proximity] Candidats triés: ${fresh.slice(0, 3).map(p => p.name + ' (' + (p.lat != null ? haversineKm(latitude, longitude, p.lat, p.lon).toFixed(1) : '?') + 'km)').join(', ')}`);

    console.log(`[refresh] count=${refreshCount} radius=${radiusMeters} searchGroup=${searchGroup} excludeCount=${excludeSet.size}`);
    candidates = fresh.slice(0, 8);
    if (!candidates.length) {
      // All nearby places are excluded — serve raw fallback without exclusion
      candidates = deduped.slice(0, 6);
      console.warn('[backend] Tous les lieux exclus — fallback pool complet');
    }
    console.log(`[quality] candidates=${candidates.length} excludeCount=${excludeSet.size}`);

    // Logs couverture familles
    const allTypes = candidates.flatMap(c => c.types ?? []);
    const allNames = candidates.map(c => c.name.toLowerCase()).join(' ');
    if (!allTypes.some(t => ['zoo', 'aquarium'].includes(t)) && !/ferme|animalier|papiliorama/.test(allNames))
      console.log('[coverage] ⚠️ Aucun zoo/aquarium/ferme dans les candidats');
    if (!allTypes.includes('library') && !/biblioth[eè]que|ludoth[eè]que/.test(allNames))
      console.log('[coverage] ⚠️ Aucune bibliothèque/ludothèque dans les candidats');
    if (!allTypes.some(t => ['park', 'natural_feature', 'botanical_garden', 'nature_reserve'].includes(t)) && !/for[eê]t|jardin/.test(allNames))
      console.log('[coverage] ⚠️ Aucun parc/forêt/nature dans les candidats');
    console.log(`[coverage] Types: ${[...new Set(allTypes)].join(', ')}`);

    // 4.5. Routes API — attach real driving times (non-blocking, 5s timeout)
    candidates = await fetchTravelTimes(latitude, longitude, candidates, GOOGLE_PLACES_API_KEY);

    // Map for O(1) lookup during merge (built after Routes API enrichment)
    const placesMap = new Map(candidates.map(p => [p.sourceId, p]));

    // 5. Claude / OpenRouter
    let enrichedActivities;
    const useOpenRouter = OPENROUTER_ENABLED && !isBudgetExceeded();
    if (!useOpenRouter) {
      console.log(`[backend] OpenRouter désactivé (ENABLED=${OPENROUTER_ENABLED}, budgetOK=${!isBudgetExceeded()}) — fallback local`);
      enrichedActivities = placesToFallback(candidates, latitude, longitude, weatherIntent);
    } else {
    try {
      const prompt = buildClaudePrompt(candidates, { weatherCondition, weatherTemp, weatherIntent });
      const promptTokensEst = Math.round(prompt.length / 4);
      console.log(`[cost] Appel OpenRouter — modèle=${OPENROUTER_MODEL} candidats=${candidates.length} prompt≈${promptTokensEst} tokens`);
      const t0 = Date.now();

      const openRouterRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_KEY}`,
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          temperature: 0.3,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!openRouterRes.ok) {
        const body = await openRouterRes.text();
        throw new Error(`OpenRouter ${openRouterRes.status}: ${body.slice(0, 200)}`);
      }

      const openRouterData = await openRouterRes.json();

      // Logs coût
      const usage = openRouterData.usage;
      if (usage) {
        const inTok = usage.prompt_tokens || 0;
        const outTok = usage.completion_tokens || 0;
        const costUSD = estimateCost(inTok, outTok);
        trackSpend(costUSD);
        console.log(`[cost] ${inTok} in + ${outTok} out tokens | ~$${costUSD.toFixed(5)} | ${Date.now() - t0}ms`);
      } else {
        console.log(`[cost] Réponse OpenRouter sans usage (${Date.now() - t0}ms)`);
      }

      const texte = openRouterData.choices?.[0]?.message?.content ?? '';
      console.log('[backend] Claude raw (200c):', texte.slice(0, 200));

      const claudeItems = extractJSON(texte);
      if (!Array.isArray(claudeItems)) throw new Error('Claude n\'a pas retourné un tableau');

      // 6. Merge: discard any item whose sourceId is not in placesMap (hallucination guard)
      enrichedActivities = claudeItems
        .map(item => {
          const merged = mergeWithPlaceData(item, placesMap, latitude, longitude, weatherIntent);
          if (!merged) return null;
          const place = placesMap.get(item.sourceId);
          return resolveAll(merged, place);
        })
        .filter(Boolean);

      if (!enrichedActivities.length) throw new Error('Aucune activité valide après merge');
      console.log(`[backend] ✅ ${enrichedActivities.length} activités enrichies retournées`);

    } catch (claudeErr) {
      // Claude failed but we have real Places data → serve normalized Google places
      console.error('[backend] Claude échoue:', claudeErr.message, '→ fallback lieux Google bruts');
      enrichedActivities = placesToFallback(candidates, latitude, longitude, weatherIntent);
    }
    } // end else (useOpenRouter)

    // Weather validation finale — rejette les outdoor inadaptés à la météo
    if (Array.isArray(enrichedActivities) && enrichedActivities.length) {
      const beforeWeather = enrichedActivities.length;
      enrichedActivities = filterActivitiesByWeather(enrichedActivities, weatherIntent, latitude, longitude);
      if (enrichedActivities.length < beforeWeather) {
        console.log(`[weather] filtered ${beforeWeather - enrichedActivities.length} activité(s) outdoor non adaptées (intent=${weatherIntent})`);
      }
    }

    // Normaliser, valider, mettre en cache et envoyer
    const seenFinalIds = new Set();
    const seenFinalCoords = new Set();
    const finalActivities = (Array.isArray(enrichedActivities) ? enrichedActivities : [])
      .map(normalizeActivityForDisplay)
      .filter(Boolean)
      .filter(validateNearbyActivity)
      .filter(a => {
        const id = a.sourceId;
        if (id && seenFinalIds.has(id)) {
          console.log(`[dedupe] removed_duplicate reason=final_sourceId name="${a.titre ?? '?'}"`);
          return false;
        }
        const coordKey = (a.latitude != null && a.longitude != null)
          ? `${Math.round(a.latitude * 10000)},${Math.round(a.longitude * 10000)}`
          : null;
        if (coordKey && seenFinalCoords.has(coordKey)) {
          console.log(`[dedupe] removed_duplicate reason=final_coordinates name="${a.titre ?? '?'}"`);
          return false;
        }
        if (id) seenFinalIds.add(id);
        if (coordKey) seenFinalCoords.add(coordKey);
        return true;
      });
    console.log(`[quality] rejectedCount=${(enrichedActivities?.length ?? 0) - finalActivities.length} finalCount=${finalActivities.length}`);

    if (finalActivities.length === 0) {
      console.log('[refresh] fallback_reused_seen_places=true — tentative recherche large sans exclude');
      let rescued = [];
      try {
        const rescueGroup = (searchGroup + 2) % 4;
        const rescueRaw = await fetchNearbyPlaces(
          latitude, longitude, 50000, GOOGLE_PLACES_API_KEY, rescueGroup, null
        );
        console.log(`[places] rescue: ${rescueRaw.length} lieux (radius=80km group=${rescueGroup})`);
        const rescuePlaces = deduplicate(rescueRaw.map(normalizePlace)).filter(isFamilyPlace);
        if (rescuePlaces.length > 0) {
          const rescueActivities = placesToFallback(rescuePlaces, latitude, longitude, weatherIntent);
          rescued = rescueActivities.map(normalizeActivityForDisplay).filter(Boolean).filter(validateNearbyActivity);
          console.log(`[refresh] fallback_reused_seen_places: ${rescued.length} activités reproposées`);
        }
      } catch (e) {
        console.warn('[refresh] rescue échoue:', e.message);
      }
      if (rescued.length > 0) {
        setCache(cacheKey, rescued);
        if (!res.headersSent) res.json(rescued);
      } else {
        console.log('[empty] reason=no_activities_after_all_fallbacks');
        setCache(cacheKey, []);
        if (!res.headersSent) res.json([]);
      }
    } else {
      setCache(cacheKey, finalActivities);
      if (!res.headersSent) res.json(finalActivities);
    }

  } catch (e) {
    console.error('[backend] Erreur globale /generer-activites:', e.message);
    if (!res.headersSent) {
      if (candidates?.length) {
        sendNearbyActivities(res, placesToFallback(candidates, latitude, longitude, weatherIntent));
      } else {
        res.json([]);
      }
    }
  } finally {
    clearTimeout(safetyTimer);
  }
});

// ─── POST /evenements-semaine (inchangé) ─────────────────────────────────────

app.post('/evenements-semaine', async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        messages: [
          {
            role: 'user',
            content: `Génère 4 événements ou activités culturelles pour cette semaine pour une famille, près des coordonnées ${latitude}, ${longitude}.
            Inclus des événements comme des marchés, expositions, cinéma, sports, concerts, musées, etc.
            Réponds UNIQUEMENT en JSON valide, sans texte avant ou après, avec ce format exact:
            [{"id":1,"emoji":"🎭","titre":"Titre","description":"Description courte","quand":"Samedi 14h","lieu":"Nom du lieu","budget":"Gratuit ou prix"},
             {"id":2,"emoji":"🎨","titre":"Titre","description":"Description courte","quand":"Dimanche 10h","lieu":"Nom du lieu","budget":"Gratuit ou prix"},
             {"id":3,"emoji":"🎵","titre":"Titre","description":"Description courte","quand":"Vendredi soir","lieu":"Nom du lieu","budget":"Gratuit ou prix"},
             {"id":4,"emoji":"🌿","titre":"Titre","description":"Description courte","quand":"Week-end","lieu":"Nom du lieu","budget":"Gratuit ou prix"}]`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error('OpenRouter error:', response.status, body);
      return res.status(502).json({ erreur: `OpenRouter ${response.status}: ${body.slice(0, 200)}` });
    }
    const data = await response.json();
    const texte = data.choices?.[0]?.message?.content ?? '';
    console.log('OpenRouter raw response:', texte.slice(0, 300));
    const evenements = extractJSON(texte);
    res.json(evenements);

  } catch (e) {
    console.error('Erreur /evenements-semaine:', e);
    res.status(500).json({ erreur: String(e) });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend Helm démarré sur le port ${PORT}`);
  if (!GOOGLE_PLACES_API_KEY) console.warn('⚠️  GOOGLE_PLACES_API_KEY manquante — mode mock actif');
});
