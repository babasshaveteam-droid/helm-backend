// Règles officielles : docs/HELM_CORE_RULES.md
// Rotate through different type groups on each refresh to surface varied places
const SEARCH_GROUPS = [
  ['park', 'museum', 'library', 'tourist_attraction', 'movie_theater', 'bowling_alley'], // groupe 0
  ['park', 'art_gallery', 'museum', 'tourist_attraction', 'amusement_center', 'movie_theater'], // groupe 1 — gym retiré, cinéma ajouté
  ['swimming_pool', 'ice_skating_rink', 'bowling_alley', 'museum', 'library'],     // groupe 2 — sport indoor
  ['zoo', 'aquarium', 'park', 'tourist_attraction', 'museum'],                      // groupe 3 — animaux
];

// Weather-intent-specific place types — override SEARCH_GROUPS when weatherIntent is set
const WEATHER_TYPES = {
  rainy:    ['museum', 'library', 'bowling_alley', 'movie_theater', 'aquarium', 'amusement_center', 'shopping_mall', 'swimming_pool', 'ice_skating_rink', 'gym'],
  cold: [
    // indoor / au chaud — priorité
    'museum', 'library', 'movie_theater', 'bowling_alley', 'aquarium',
    'cafe', 'swimming_pool', 'ice_skating_rink', 'gym',
    // outdoor court/familial autorisé par froid raisonnable
    'park', 'tourist_attraction', 'zoo',
  ],
  hot:      ['aquarium', 'museum', 'shopping_mall', 'park', 'zoo', 'swimming_pool', 'natural_feature', 'botanical_garden', 'beach'],
  unstable: ['museum', 'library', 'cafe', 'bowling_alley', 'shopping_mall', 'park', 'swimming_pool', 'ice_skating_rink', 'gym'],
  sunny:    ['park', 'zoo', 'aquarium', 'tourist_attraction', 'botanical_garden', 'amusement_park', 'natural_feature', 'beach'],
};

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
  'places.businessStatus',
].join(',');

async function fetchNearbyPlaces(lat, lon, radiusMeters, apiKey, searchGroup = 0, weatherIntent = null) {
  let types;
  if (weatherIntent === 'cold' && searchGroup >= 2) {
    const sgTypes = SEARCH_GROUPS[searchGroup % SEARCH_GROUPS.length];
    types = [...new Set([...WEATHER_TYPES.cold, ...sgTypes])];
    console.log(`[places] cold_merged searchGroup=${searchGroup} types(${types.length})=${types.join(',')}`);
  } else if (weatherIntent && WEATHER_TYPES[weatherIntent]) {
    types = WEATHER_TYPES[weatherIntent];
  } else {
    types = SEARCH_GROUPS[searchGroup % SEARCH_GROUPS.length];
  }
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

// Text Search for families with no dedicated Google Places type (escalade, ferme pédagogique...)
async function fetchTargetedSearch(lat, lon, radiusMeters, apiKey, textQuery, maxResults = 10) {
  const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery,
      maxResultCount: maxResults,
      locationBias: {
        circle: {
          center: { latitude: lat, longitude: lon },
          radius: radiusMeters,
        },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Text Search ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  return data.places ?? [];
}

module.exports = { fetchNearbyPlaces, fetchTargetedSearch, WEATHER_TYPES, SEARCH_GROUPS };
