// Règles officielles : docs/HELM_CORE_RULES.md
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
    isOpen: googlePlace.currentOpeningHours?.openNow
         ?? googlePlace.regularOpeningHours?.openNow
         ?? null,
    businessStatus: googlePlace.businessStatus ?? null,
    closingPeriods: googlePlace.currentOpeningHours?.periods
                 ?? googlePlace.regularOpeningHours?.periods
                 ?? null,
    normalizedKey: normalizeKey(name + '|' + address),
  };
}

function nameKey(name) {
  return (name || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(la|le|les|de|du|des|d|l)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

// Returns distance in metres between two WGS-84 points (Haversine)
function distMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// True if nameKey A is a prefix of B or vice-versa (min 6 chars)
function namePrefixMatch(nkA, nkB) {
  const len = Math.min(nkA.length, nkB.length);
  if (len < 6) return false;
  return nkA.startsWith(nkB.slice(0, len)) || nkB.startsWith(nkA.slice(0, len));
}

function deduplicate(places) {
  const seenIds       = new Set();
  const seenKeys      = new Set();
  const seenNameKeys  = new Set();
  const seenAddrKeys  = new Map(); // addrKey → nameKey du premier vu
  const seenCoords    = [];        // [{lat, lon, nk, addrKey}]

  return places.filter(p => {
    // 1. Same source ID
    if (seenIds.has(p.sourceId)) {
      console.log(`[dedupe] removed_duplicate reason=placeId name="${p.name}"`);
      return false;
    }
    // 2. Same normalizedKey (name+address)
    if (p.normalizedKey && seenKeys.has(p.normalizedKey)) {
      console.log(`[dedupe] removed_duplicate reason=normalizedKey name="${p.name}"`);
      return false;
    }
    const nk = nameKey(p.name);
    // 3. Same name (after article removal)
    if (nk.length >= 6 && seenNameKeys.has(nk)) {
      console.log(`[dedupe] removed_duplicate reason=name_similarity name="${p.name}"`);
      return false;
    }
    // 4. Same normalised address with name-prefix guard
    const addrKey = normalizeKey(p.address);
    if (addrKey.length >= 8 && addrKey !== 'adresseinconnue') {
      const existingNk = seenAddrKeys.get(addrKey);
      if (existingNk !== undefined && namePrefixMatch(existingNk, nk)) {
        console.log(`[dedupe] removed_duplicate reason=same_address name="${p.name}"`);
        return false;
      }
    }
    // 5. Nearby coordinates (~50 m) with secondary signal
    if (p.lat != null && p.lon != null) {
      for (const seen of seenCoords) {
        if (distMeters(p.lat, p.lon, seen.lat, seen.lon) < 50) {
          const nameMatch = namePrefixMatch(nk, seen.nk);
          const addrMatch = addrKey.length >= 8 && addrKey === seen.addrKey;
          if (nameMatch || addrMatch) {
            console.log(`[dedupe] removed_duplicate reason=nearby_coordinates name="${p.name}"`);
            return false;
          }
        }
      }
    }

    seenIds.add(p.sourceId);
    if (p.normalizedKey) seenKeys.add(p.normalizedKey);
    if (nk.length >= 6) seenNameKeys.add(nk);
    if (addrKey.length >= 8 && addrKey !== 'adresseinconnue') seenAddrKeys.set(addrKey, nk);
    if (p.lat != null && p.lon != null) seenCoords.push({ lat: p.lat, lon: p.lon, nk, addrKey });
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
  // Types commerciaux / services — aucun intérêt activité famille
  'store', 'hardware_store', 'home_goods_store', 'furniture_store',
  'electronics_store', 'clothing_store', 'shoe_store', 'jewelry_store',
  'book_store', 'florist', 'pet_store', 'bicycle_store',
  'general_contractor', 'electrician', 'plumber', 'painter',
  'roofing_contractor', 'moving_company', 'locksmith',
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
