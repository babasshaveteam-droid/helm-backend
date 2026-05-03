// Adapts the Places API (New) v1 response format.
// Fields: id, displayName.text, formattedAddress, location.{latitude,longitude},
//         types, rating, userRatingCount, currentOpeningHours.openNow

function normalizeKey(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function normalizePlace(googlePlace) {
  const name = googlePlace.displayName?.text ?? 'Lieu sans nom';
  const address = googlePlace.formattedAddress ?? 'Adresse inconnue';
  return {
    sourceId: googlePlace.id ?? `unknown-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name,
    address,
    lat: googlePlace.location?.latitude ?? null,
    lon: googlePlace.location?.longitude ?? null,
    types: googlePlace.types ?? [],
    rating: googlePlace.rating ?? null,
    ratingCount: googlePlace.userRatingCount ?? null,
    isOpen: googlePlace.currentOpeningHours?.openNow ?? null,
    normalizedKey: normalizeKey(name + '|' + address),
  };
}

function deduplicate(places) {
  const seenIds = new Set();
  const seenKeys = new Set();
  return places.filter(p => {
    if (seenIds.has(p.sourceId)) return false;
    if (p.normalizedKey && seenKeys.has(p.normalizedKey)) return false;
    seenIds.add(p.sourceId);
    if (p.normalizedKey) seenKeys.add(p.normalizedKey);
    return true;
  });
}

const FAST_FOOD_BLACKLIST = ['mcdonald', 'kfc', 'quick', 'burger king', 'subway', 'kebab', 'pizza hut', 'domino'];

const BLOCKED_TYPES = new Set([
  'pharmacy', 'drugstore', 'hospital', 'doctor', 'dentist', 'physiotherapist',
  'veterinary_care', 'health',
  'bank', 'atm', 'insurance_agency', 'accounting', 'finance', 'real_estate_agency',
  'lawyer', 'local_government_office', 'city_hall', 'post_office', 'police', 'fire_station',
  'gas_station', 'car_repair', 'car_dealer', 'car_wash', 'parking',
  'transit_station', 'bus_station', 'train_station', 'subway_station', 'taxi_stand', 'airport',
  'grocery_store', 'supermarket', 'convenience_store',
  'locality', 'neighborhood', 'sublocality', 'political',
  'administrative_area_level_1', 'administrative_area_level_2', 'administrative_area_level_3',
  'route', 'street_address', 'postal_code', 'premise', 'subpremise',
]);

const BLOCKED_NAME_PATTERNS = /\b(pharmacie|pharmacy|apotheke|banque|dentiste|cabinet\s+m[eé]dical|clinique|h[oô]pital|hospital|centre\s+m[eé]dical|gare\b|assurance|mairie|commune)\b/i;

// Specific activity types that justify keeping a "Centre" place
const VALID_CENTRE_TYPES = new Set([
  'shopping_mall','gym','sports_complex','amusement_center','museum','art_gallery',
  'bowling_alley','swimming_pool','ice_skating_rink','movie_theater','aquarium',
]);

function isFamilyPlace(place) {
  const types = Array.isArray(place.types) ? place.types : [];
  if (FAST_FOOD_BLACKLIST.some(f => place.name.toLowerCase().includes(f))) return false;
  if (types.some(t => BLOCKED_TYPES.has(t))) return false;
  if (BLOCKED_NAME_PATTERNS.test(place.name)) return false;
  // Block bare "XXX Centre / Center" names (city centres, generic locations)
  // unless Google confirms a real activity type (shopping_mall, gym, etc.)
  if (/\s+cent(re|er)\s*$/i.test(place.name) && !types.some(t => VALID_CENTRE_TYPES.has(t))) return false;
  return true;
}

module.exports = { normalizePlace, deduplicate, normalizeKey, isFamilyPlace };
