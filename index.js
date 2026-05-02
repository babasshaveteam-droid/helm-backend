const express = require('express');
const cors = require('cors');
const { fetchNearbyPlaces } = require('./places');
const { normalizePlace, deduplicate, isFamilyPlace } = require('./normalize');
const { MOCK_ACTIVITIES } = require('./mock');

const app = express();
app.use(cors());
app.use(express.json());

const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

if (!OPENROUTER_KEY) throw new Error('OPENROUTER_KEY manquante');

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

const ALLOWED_PASTELS = new Set(['#E8F5E9', '#FFF3E0', '#E3F2FD', '#F3E5F5', '#F5F0FF']);

const CATEGORY_PASTEL_MAP = {
  Nature: '#E8F5E9', Culture: '#FFF3E0', Sport: '#E3F2FD',
  Gastronomie: '#FFF3E0', Loisirs: '#F5F0FF', Créatif: '#F3E5F5',
};

function safeColorTheme(hex, category) {
  if (hex && ALLOWED_PASTELS.has(hex)) return hex;
  return CATEGORY_PASTEL_MAP[category] ?? '#F5F0FF';
}

function guessCategory(types = []) {
  if (types.some(t => ['park','natural_feature','campground','rv_park','nature_reserve','botanical_garden','hiking_area'].includes(t))) return 'Nature';
  if (types.some(t => ['museum','art_gallery','library','historic_site','church','hindu_temple','mosque','castle','tourist_attraction'].includes(t))) return 'Culture';
  if (types.some(t => ['gym','sports_complex','stadium','swimming_pool','bowling_alley','ice_skating_rink'].includes(t))) return 'Sport';
  if (types.some(t => ['zoo','amusement_park','amusement_center','aquarium'].includes(t))) return 'Loisirs';
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
  Nature:  'Idéal pour prendre l\'air en famille et profiter d\'un moment dehors.',
  Culture: 'Idéal pour une sortie calme et éducative avec des enfants curieux.',
  Loisirs: 'Idéal pour une sortie simple et amusante avec les enfants.',
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
  tourist_attraction: '📍', cafe: '☕',
  amusement_park: '🎡', amusement_center: '🎮',
  swimming_pool: '🏊', castle: '🏰',
  historic_site: '🏛️', natural_feature: '🌿',
  nature_reserve: '🦋', zoo: '🦁',
  aquarium: '🐠', botanical_garden: '🌸',
};

function typeEmoji(types = []) {
  for (const t of types) if (TYPE_EMOJI[t]) return TYPE_EMOJI[t];
  return '📍';
}

// ─── Heritage / religious site helpers ───────────────────────────────────────

function isHeritageSite(name = '', types = []) {
  return /abbaye|abbey|monastère|monastery|cathédrale|cathedral|église|church|chapelle|chapel|basilique|basilica|monument|prieuré|priory/i.test(name) ||
    types.some(t => ['historic_site','church','hindu_temple','mosque','synagogue','castle'].includes(t));
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
  [/bowling/i, '🎳'],
  [/cin[ée]ma|cin[ée]plex/i, '🎬'],
  [/piscine|swimming/i, '🏊'],
  [/patinoire|skating/i, '⛸️'],
  [/boulangerie|pâtisserie|pastry/i, '🥐'],
  [/forêt|forest|bois\b/i, '🌲'],
  [/lac\b|lake|étang/i, '🌊'],
  [/jardin|garden|botanical/i, '🌸'],
  [/parc d['']attract|amusement park/i, '🎡'],
  [/bibliothèque|library/i, '📚'],
  [/galerie|gallery/i, '🎨'],
];

const TYPE_EMOJI_OVERRIDE = {
  castle: '🏰', church: '⛪', hindu_temple: '⛪', mosque: '⛪', museum: '🏛️',
  zoo: '🦁', aquarium: '🐠', botanical_garden: '🌸', amusement_park: '🎡',
  library: '📚', art_gallery: '🎨', natural_feature: '🌿', park: '🌳',
};

function getEmojiOverride(types = [], name = '') {
  for (const [pattern, emoji] of NAME_EMOJI_PATTERNS) {
    if (pattern.test(name)) return emoji;
  }
  for (const t of types) if (TYPE_EMOJI_OVERRIDE[t]) return TYPE_EMOJI_OVERRIDE[t];
  return null;
}

function determineCategoryOverride(types = [], name = '') {
  if (
    types.some(t => ['museum','art_gallery','historic_site','castle','church',
                     'hindu_temple','mosque','synagogue','library','tourist_attraction'].includes(t)) ||
    /château|castle|cathédrale|cathedral|musée|museum|abbaye|église|monument/i.test(name)
  ) return 'Culture';
  if (types.some(t => ['park','natural_feature','campground','nature_reserve','botanical_garden'].includes(t)))
    return 'Nature';
  if (types.some(t => ['zoo','amusement_park','amusement_center','aquarium'].includes(t)))
    return 'Loisirs';
  return null;
}

// ─── Fallback content by category ────────────────────────────────────────────

const HERITAGE_WHAT_TO_BRING = ['Appareil photo', 'Eau', 'Chaussures confortables', 'Petite veste'];

const WHAT_TO_BRING_DEFAULTS = {
  Nature:      ['Chaussures confortables', 'Bouteille d\'eau', 'Vêtements adaptés à la météo'],
  Culture:     ['Curiosité et questions des enfants', 'Appareil photo', 'Monnaie pour les entrées'],
  Sport:       ['Tenue de sport', 'Bouteille d\'eau', 'Chaussures adaptées'],
  Gastronomie: ['Appétit', 'Monnaie'],
  Loisirs:     ['Tenue confortable', 'Bonne humeur', 'Monnaie'],
};

const PRACTICAL_INFOS_DEFAULTS = {
  Nature:      ['Horaires à vérifier avant de partir', 'Accès en voiture conseillé'],
  Culture:     ['Horaires à vérifier avant de partir', 'Adresse disponible dans l\'itinéraire', 'Prix à vérifier'],
  Sport:       ['Horaires à vérifier avant de partir', 'Réservation parfois nécessaire'],
  Gastronomie: ['Horaires à vérifier avant de partir', 'Réservation recommandée le week-end'],
  Loisirs:     ['Horaires à vérifier avant de partir', 'Adapté aux enfants'],
};

// ─── Merge Claude output with real place data ─────────────────────────────────
// Any sourceId Claude returns that isn't in placesMap is silently discarded —
// this enforces the "no hallucinated places" rule at the data level.

function mergeWithPlaceData(claudeItem, placesMap, userLat, userLon) {
  const place = placesMap.get(claudeItem.sourceId);
  if (!place) {
    console.warn('[merge] unknown sourceId from Claude:', claudeItem.sourceId, '→ discarded');
    return null;
  }

  const km =
    place.lat != null && place.lon != null && userLat != null && userLon != null
      ? haversineKm(userLat, userLon, place.lat, place.lon)
      : null;

  // Fix 2: titre en français (remplace les titres anglais)
  const titre = correctTitle(claudeItem.titre, place.name);

  // Fix 3: catégorie déterministe (château → Culture, etc.) — avant emoji
  const category = determineCategoryOverride(place.types, place.name)
                   || claudeItem.category
                   || guessCategory(place.types)
                   || 'Loisirs';

  // Fix 4: emoji déterministe — jamais 🗺️/📍 pour un lieu culturel précis
  const emojiOverride = getEmojiOverride(place.types, place.name);
  const rawEmoji      = emojiOverride || claudeItem.emoji || typeEmoji(place.types);
  const emoji = (category === 'Culture' && (rawEmoji === '🗺️' || rawEmoji === '📍'))
    ? '🏛️'
    : rawEmoji;

  // Fix 5: couleur restreinte aux 5 pastels exacts
  const colorTheme = safeColorTheme(claudeItem.colorTheme, category);

  // Fix 6: fallback whatToBring — priorité aux items Claude, sinon patrimoine, sinon catégorie
  const rawWhatToBring = Array.isArray(claudeItem.whatToBring) ? claudeItem.whatToBring : [];
  const whatToBring = rawWhatToBring.length > 0
    ? rawWhatToBring
    : (isHeritageSite(place.name, place.types)
        ? HERITAGE_WHAT_TO_BRING
        : (WHAT_TO_BRING_DEFAULTS[category] ?? WHAT_TO_BRING_DEFAULTS.Loisirs));

  // Fix 6: fallback si Claude retourne practicalInfos vide
  const rawPractical = Array.isArray(claudeItem.practicalInfos) ? claudeItem.practicalInfos : [];
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

  // Fix 7: tags — nettoyer les tags techniques, fallback patrimoine si applicable
  const rawTags     = Array.isArray(claudeItem.tags) ? claudeItem.tags : [];
  const cleanedTags = filterTags(rawTags);
  const tags = cleanedTags.length > 0
    ? cleanedTags
    : (isHeritageSite(place.name, place.types) ? getHeritageTags(place.name) : cleanTags(place.types));

  // Fix 1: travelTimeLabel avec fallback haversine si Routes API a échoué
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

  return {
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
    type: claudeItem.type || 'indoor',
    minAgeLabel: claudeItem.minAgeLabel || 'À vérifier',
    category,
    mood: Array.isArray(claudeItem.mood) ? claudeItem.mood : [],
    weatherFit: Array.isArray(claudeItem.weatherFit) ? claudeItem.weatherFit : ['any'],
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
}

// ─── Fallback: Google places → minimal Activity (Claude unavailable) ───────────

function placesToFallback(places, userLat, userLon) {
  return places.slice(0, 6).map(p => {
    const km =
      p.lat != null && p.lon != null && userLat != null && userLon != null
        ? haversineKm(userLat, userLon, p.lat, p.lon)
        : null;
    const emoji = getEmojiOverride(p.types, p.name) || typeEmoji(p.types);
    const category = guessCategory(p.types);
    const subtitle = SUBTITLE_BY_CATEGORY[category] ?? 'Idéal pour une sortie en famille.';
    return {
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
      reservationRequired: false,
      icon: emoji,
      colorTheme: CATEGORY_PASTEL_MAP[category] ?? '#F5F0FF',
      benefit: 'Un lieu proche à découvrir en famille',
      whyGoodIdea: subtitle,
      whatToBring: [],
      practicalInfos:
        p.isOpen != null
          ? [p.isOpen ? 'Ouvert maintenant' : 'Horaires à vérifier avant de partir']
          : ['Horaires à vérifier avant de partir'],
      tags: cleanTags(p.types),
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
  for (const raw of infos) {
    const isHoraire = HORAIRE_NORMALIZE_RE.test(raw);
    const entry = isHoraire ? 'Horaires à vérifier avant de partir' : raw;
    const key = entry.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    if (isHoraire && horaireAdded) continue;
    if (isHoraire) horaireAdded = true;
    result.push(entry);
  }
  return result;
}

function normalizeActivityForDisplay(activity) {
  if (!activity) return null;
  let infos = (activity.practicalInfos ?? [])
    .map(normalizeInfoText)
    .filter(text => text.length > 0);
  if (activity.travelTimeLabel) {
    infos = infos.map(stripConflictingTravelTime).filter(Boolean);
  }
  return { ...activity, practicalInfos: semanticDedupInfos(infos) };
}

function sendActivities(res, activities) {
  if (res.headersSent) return;
  res.json(
    (Array.isArray(activities) ? activities : [activities])
      .map(normalizeActivityForDisplay)
      .filter(Boolean)
  );
}

// ─── Claude prompt ────────────────────────────────────────────────────────────

function buildClaudePrompt(places, { latitude, longitude, weather, filters, exclude }) {
  const excludeBlock =
    Array.isArray(exclude) && exclude.length > 0
      ? `🚫 LISTE NOIRE — Ne sélectionne JAMAIS ces lieux (ni rien de similaire) :\n${exclude.map(t => `  ❌ "${t}"`).join('\n')}\n\n`
      : '';

  const placesJson = JSON.stringify(
    places.map(p => ({
      sourceId: p.sourceId,
      name: p.name,
      address: p.address,
      types: p.types,
      rating: p.rating,
      ratingCount: p.ratingCount,
      isOpen: p.isOpen,
    })),
    null,
    2
  );

  return `Tu es l'assistant de l'application Helm — une app famille chaleureuse et bienveillante.

${excludeBlock}Voici ${places.length} lieux RÉELS proches (source : Google Places) :
${placesJson}

Contexte :
- Position : lat=${latitude}, lon=${longitude}
- Météo : ${weather || 'non renseignée'}
- Filtres famille : ${Array.isArray(filters) && filters.length ? filters.join(', ') : 'aucun'}

Règles STRICTES :
1. Sélectionne 3 à 8 lieux UNIQUEMENT parmi ceux listés ci-dessus
2. INTERDIT d'inventer ou d'ajouter un lieu absent de la liste
3. Si le prix est inconnu → "Prix à vérifier" pour priceLabel, null pour priceAmount
4. Si les horaires sont inconnus → "Horaires à vérifier avant de partir" dans practicalInfos
5. Écarte les lieux inadaptés aux enfants ou trop formels
6. Textes courts et chaleureux — style Helm (max 1 phrase par champ texte)
7. Retourne UNIQUEMENT un tableau JSON valide strict, sans markdown, sans texte avant ou après
8. N'invente AUCUNE information factuelle précise absente des données source : pas de nombre de marches, distances exactes, prix précis, horaires exacts, "parking proche", "365 marches", "accès WiFi". Si incertain → "à vérifier avant de partir"
9. effortLevel : évalue honnêtement selon le lieu — "Facile" (parc, bibliothèque, musée accessible, café), "Moyen" (cathédrale avec visite, grand musée, culture étendue), "Aventure" (randonnée, montagne, terrain difficile, plusieurs heures de marche). Ce champ est OBLIGATOIRE.
10. whyGoodIdea : 1 phrase concrète et utile pour un parent — ex: "Une belle sortie pour marcher et profiter d'un grand panorama en famille." Éviter les formules marketing comme "émerveillera toute la famille"
11. subtitle : expliquer pour quel type de famille c'est adapté, différent du whyGoodIdea — ex: "Idéal pour les familles qui aiment marcher et passer du temps en nature."
12. Ordre de priorité : (1) activités faciles à organiser et proches, (2) culturelles accessibles, (3) nature accessible, (4) aventure en dernier — si aventure, effortLevel="Aventure" obligatoire
13. Titres en français : utilise le nom français officiel du lieu quand il existe — ex: "Cathédrale Saint-Nicolas" et non "St-Nicolas Cathedral", "Musée d'art et d'histoire" et non "Museum of Art and History". Conserve le nom officiel s'il n'a pas d'équivalent français naturel.
14. practicalInfos : chaque entrée doit apporter une information DISTINCTE — ne répète jamais deux fois la même information (même reformulée). Maximum 3 infos pratiques utiles. INTERDIT : n'inclure JAMAIS de durée de trajet (ex: "30 min en voiture", "environ 20 min", "~15 min") — cette information est calculée automatiquement par le système.
15. emoji : choisis selon la nature réelle du lieu — 🏰 château/forteresse/palais, ⛪ église/chapelle/abbaye/cathédrale/prieuré, 🌉 pont, 🌲 forêt/réserve, 🏛️ musée/monument historique, ⛰️ randonnée/sommet/belvédère, 🦁 zoo, 🌊 lac/rivière/plage, 🌳 parc urbain, 🎡 UNIQUEMENT pour vrai parc d'attractions, 🦋 papiliorama/papillons, 🎳 bowling, 🎬 cinéma, 🏊 piscine, ⛸️ patinoire, 🥐 boulangerie/pâtisserie. Jamais 🎡 pour château, site naturel ou musée. Jamais 📍 ou 🗺️ pour un lieu culturel ou patrimonial.

Pour chaque lieu retenu, génère cet objet EXACTEMENT (ne supprime aucun champ) :
{
  "sourceId": "(sourceId exact du lieu, copié depuis la liste ci-dessus)",
  "emoji": "(1 emoji pertinent)",
  "titre": "(nom court du lieu)",
  "subtitle": "(pour quel type de famille — différent de whyGoodIdea, 1 phrase max)",
  "duree": "(durée suggérée, ex: 2h)",
  "priceLabel": "(Gratuit, Prix à vérifier, ou prix estimé)",
  "priceAmount": (0 si gratuit, null si inconnu, nombre si connu),
  "type": "(outdoor|indoor|cultural|food|sport)",
  "minAgeLabel": "(Dès X ans ou Tout âge)",
  "category": "(Nature|Culture|Sport|Gastronomie|Loisirs)",
  "mood": ["(1 à 3 parmi: calme, energique, creatif, social, aventure)"],
  "weatherFit": ["(sunny|cloudy|rainy|any)"],
  "reservationRequired": (true|false),
  "icon": "(même emoji que le champ emoji)",
  "colorTheme": "(UNIQUEMENT ces pastels: #E8F5E9 Nature, #FFF3E0 Culture, #E3F2FD Sport, #F3E5F5 Créatif, #F5F0FF Loisirs)",
  "benefit": "(bénéfice principal en 5 mots max)",
  "whyGoodIdea": "(phrase concrète et utile pour un parent — ex: 'Une sortie nature pour marcher et explorer un paysage spectaculaire.')",
  "effortLevel": "(Facile|Moyen|Aventure)",
  "whatToBring": ["(2 à 4 items pratiques)"],
  "practicalInfos": ["(2 à 3 infos pratiques — si isOpen connu utilise-le, sinon 'Horaires à vérifier avant de partir')"],
  "tags": ["(3 à 5 tags courts)"]
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
    filters,
    searchGroup = 0,
  } = req.body;

  console.log(`[backend] /generer-activites — lat=${latitude} lon=${longitude} radius=${radiusMeters} group=${searchGroup}`);

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
    console.warn('[backend] GOOGLE_PLACES_API_KEY absente — fallback mock');
    sendActivities(res, MOCK_ACTIVITIES); return;
  }

  // Outer scope so the safety timer can fall back to real places if Claude hangs
  let candidates = null;

  // Safety timeout: use real Google places if available, else mock
  const safetyTimer = setTimeout(() => {
    if (!res.headersSent) {
      if (candidates?.length) {
        console.warn('[backend] Timeout 25s — fallback lieux Google bruts');
        sendActivities(res, placesToFallback(candidates, latitude, longitude));
      } else {
        console.warn('[backend] Timeout 25s — fallback mock');
        sendActivities(res, MOCK_ACTIVITIES);
      }
    }
  }, 32000);

  try {
    // 3. Google Places Nearby Search
    let rawPlaces;
    try {
      rawPlaces = await fetchNearbyPlaces(latitude, longitude, radiusMeters, GOOGLE_PLACES_API_KEY, searchGroup);
      console.log(`[backend] Google Places: ${rawPlaces.length} lieux reçus (group ${searchGroup})`);
    } catch (placesErr) {
      console.error('[backend] Google Places échoue:', placesErr.message, '→ fallback mock');
      sendActivities(res, MOCK_ACTIVITIES); return;
    }

    if (!rawPlaces.length) {
      console.warn('[backend] Google Places: 0 résultats → fallback mock');
      sendActivities(res, MOCK_ACTIVITIES); return;
    }

    // 4. Normalize → deduplicate → filter family-appropriate → exclude already-seen
    const excludeSet = new Set(Array.isArray(exclude) ? exclude : []);
    const normalized = rawPlaces.map(normalizePlace);
    const deduped = deduplicate(normalized).filter(isFamilyPlace);
    let fresh = excludeSet.size > 0 ? deduped.filter(p => !excludeSet.has(p.sourceId)) : deduped;

    // If too few fresh results after filtering, retry with a wider radius
    if (fresh.length < 3 && excludeSet.size > 0) {
      console.log(`[backend] Seulement ${fresh.length} candidats après exclusion — rayon élargi`);
      try {
        const widerRadius = Math.min(Math.round(radiusMeters * 1.5), 40000);
        const rawPlaces2 = await fetchNearbyPlaces(latitude, longitude, widerRadius, GOOGLE_PLACES_API_KEY, (searchGroup + 1) % 4);
        const fresh2 = deduplicate(rawPlaces2.map(normalizePlace))
          .filter(isFamilyPlace)
          .filter(p => !excludeSet.has(p.sourceId));
        if (fresh2.length > fresh.length) {
          fresh = fresh2;
          console.log(`[backend] Rayon élargi (${widerRadius}m): ${fresh.length} nouveaux candidats`);
        }
      } catch (e) {
        console.warn('[backend] Retry rayon élargi échoue:', e.message);
      }
    }

    candidates = fresh.slice(0, 8);
    if (!candidates.length) {
      // All nearby places are excluded — serve raw fallback without exclusion
      candidates = deduped.slice(0, 6);
      console.warn('[backend] Tous les lieux exclus — fallback pool complet');
    }
    console.log(`[backend] ${candidates.length} lieux candidats (${excludeSet.size} exclus)`);

    // 4.5. Routes API — attach real driving times (non-blocking, 5s timeout)
    candidates = await fetchTravelTimes(latitude, longitude, candidates, GOOGLE_PLACES_API_KEY);

    // Map for O(1) lookup during merge (built after Routes API enrichment)
    const placesMap = new Map(candidates.map(p => [p.sourceId, p]));

    // 5. Claude / OpenRouter
    let enrichedActivities;
    try {
      const prompt = buildClaudePrompt(candidates, { latitude, longitude, weather, filters, exclude });
      console.log(`[backend] envoi Claude avec ${candidates.length} lieux réels`);

      const openRouterRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_KEY}`,
        },
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4-5',
          temperature: 0.3, // lower = more reliable JSON + less hallucination
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!openRouterRes.ok) {
        const body = await openRouterRes.text();
        throw new Error(`OpenRouter ${openRouterRes.status}: ${body.slice(0, 200)}`);
      }

      const openRouterData = await openRouterRes.json();
      const texte = openRouterData.choices?.[0]?.message?.content ?? '';
      console.log('[backend] Claude raw (200c):', texte.slice(0, 200));

      const claudeItems = extractJSON(texte);
      if (!Array.isArray(claudeItems)) throw new Error('Claude n\'a pas retourné un tableau');

      // 6. Merge: discard any item whose sourceId is not in placesMap (hallucination guard)
      enrichedActivities = claudeItems
        .map(item => mergeWithPlaceData(item, placesMap, latitude, longitude))
        .filter(Boolean);

      if (!enrichedActivities.length) throw new Error('Aucune activité valide après merge');
      console.log(`[backend] ✅ ${enrichedActivities.length} activités enrichies retournées`);

    } catch (claudeErr) {
      // Claude failed but we have real Places data → serve normalized Google places
      console.error('[backend] Claude échoue:', claudeErr.message, '→ fallback lieux Google bruts');
      enrichedActivities = placesToFallback(candidates, latitude, longitude);
    }

    sendActivities(res, enrichedActivities);

  } catch (e) {
    console.error('[backend] Erreur globale /generer-activites:', e.message);
    sendActivities(res, MOCK_ACTIVITIES);
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
