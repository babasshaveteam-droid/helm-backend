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

function isFamilyPlace(place) {
  const n = place.name.toLowerCase();
  return !FAST_FOOD_BLACKLIST.some(f => n.includes(f));
}

module.exports = { normalizePlace, deduplicate, normalizeKey, isFamilyPlace };
