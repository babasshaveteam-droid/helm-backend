// Rotate through different type groups on each refresh to surface varied places
const SEARCH_GROUPS = [
  ['park', 'museum', 'library', 'tourist_attraction', 'cafe'],
  ['park', 'art_gallery', 'museum', 'tourist_attraction', 'amusement_center'],
  ['museum', 'library', 'tourist_attraction', 'cafe', 'park'],
  ['zoo', 'park', 'tourist_attraction', 'museum', 'art_gallery'],
];

// Only request the fields we actually use — minimises cost and payload
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.types',
  'places.rating',
  'places.userRatingCount',
  'places.currentOpeningHours.openNow',
].join(',');

async function fetchNearbyPlaces(lat, lon, radiusMeters, apiKey, searchGroup = 0) {
  const types = SEARCH_GROUPS[searchGroup % SEARCH_GROUPS.length];
  const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({
      includedTypes: types,
      maxResultCount: 20,
      locationRestriction: {
        circle: {
          center: { latitude: lat, longitude: lon },
          radius: radiusMeters,
        },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Places ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  return data.places ?? [];
}

module.exports = { fetchNearbyPlaces };
