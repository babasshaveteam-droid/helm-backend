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

const TYPE_EMOJI = {
  park: '🌳', museum: '🏛️', library: '📚',
  tourist_attraction: '🎡', cafe: '☕',
  amusement_center: '🎮', swimming_pool: '🏊',
};

function typeEmoji(types = []) {
  for (const t of types) if (TYPE_EMOJI[t]) return TYPE_EMOJI[t];
  return '📍';
}

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

  const emoji = claudeItem.emoji || typeEmoji(place.types);
  const subtitle = claudeItem.subtitle || '';

  return {
    id: place.sourceId,
    emoji,
    titre: claudeItem.titre || place.name,
    description: subtitle || claudeItem.whyGoodIdea || place.name, // backward compat with weekend.tsx
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
    category: claudeItem.category || 'Loisirs',
    mood: Array.isArray(claudeItem.mood) ? claudeItem.mood : [],
    weatherFit: Array.isArray(claudeItem.weatherFit) ? claudeItem.weatherFit : ['any'],
    reservationRequired: claudeItem.reservationRequired ?? false,
    icon: claudeItem.icon || emoji,
    colorTheme: claudeItem.colorTheme || '#7A6D66',
    benefit: claudeItem.benefit || '',
    whyGoodIdea: claudeItem.whyGoodIdea || '',
    whatToBring: Array.isArray(claudeItem.whatToBring) ? claudeItem.whatToBring : [],
    practicalInfos: Array.isArray(claudeItem.practicalInfos)
      ? claudeItem.practicalInfos
      : place.isOpen != null
        ? [place.isOpen ? 'Ouvert maintenant' : 'Fermé actuellement']
        : [],
    tags: Array.isArray(claudeItem.tags) ? claudeItem.tags : [],
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
    const emoji = typeEmoji(p.types);
    return {
      id: p.sourceId,
      emoji,
      titre: p.name,
      description: p.address,
      subtitle: p.address,
      locationName: p.name,
      address: p.address,
      latitude: p.lat,
      longitude: p.lon,
      distanceLabel: km != null ? toDistanceLabel(km) : 'À vérifier',
      distanceMinutes: km != null ? toDistanceMinutes(km) : 'À vérifier',
      duree: 'À vérifier',
      durationLabel: 'À vérifier',
      budget: 'À vérifier',
      priceLabel: 'À vérifier',
      priceAmount: null,
      type: 'indoor',
      minAgeLabel: 'À vérifier',
      category: 'Loisirs',
      mood: [],
      weatherFit: ['any'],
      reservationRequired: false,
      icon: emoji,
      colorTheme: '#7A6D66',
      benefit: 'Un lieu proche à explorer',
      whyGoodIdea: 'Un endroit à découvrir en famille.',
      whatToBring: [],
      practicalInfos:
        p.isOpen != null
          ? [p.isOpen ? 'Ouvert maintenant' : 'Fermé actuellement']
          : ['Vérifier les horaires'],
      tags: p.types.slice(0, 3),
      source: 'google_places',
      sourceId: p.sourceId,
    };
  });
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
9. effortLevel : évalue honnêtement selon le lieu — "Facile" (parc, bibliothèque, musée accessible, café), "Moyen" (cathédrale avec visite, grand musée, culture étendue), "Aventure" (randonnée, montagne, terrain difficile, plusieurs heures de marche)
10. whyGoodIdea : 1 phrase concrète et utile pour un parent — ex: "Une belle sortie pour marcher et profiter d'un grand panorama en famille." Éviter les formules marketing comme "émerveillera toute la famille"
11. subtitle : expliquer pour quel type de famille c'est adapté, différent du whyGoodIdea — ex: "Idéal pour les familles qui aiment marcher et passer du temps en nature."
12. Ordre de priorité : (1) activités faciles à organiser et proches, (2) culturelles accessibles, (3) nature accessible, (4) aventure en dernier — si aventure, effortLevel="Aventure" obligatoire

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
  "colorTheme": "(couleur hex adaptée, ex: #4CAF7D pour Nature, #F0956A pour Culture)",
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
  } = req.body;

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
    return res.json(MOCK_ACTIVITIES);
  }

  // Outer scope so the safety timer can fall back to real places if Claude hangs
  let candidates = null;

  // Safety timeout: use real Google places if available, else mock
  const safetyTimer = setTimeout(() => {
    if (!res.headersSent) {
      if (candidates?.length) {
        console.warn('[backend] Timeout 25s — fallback lieux Google bruts');
        res.json(placesToFallback(candidates, latitude, longitude));
      } else {
        console.warn('[backend] Timeout 25s — fallback mock');
        res.json(MOCK_ACTIVITIES);
      }
    }
  }, 25000);

  try {
    // 3. Google Places Nearby Search
    let rawPlaces;
    try {
      rawPlaces = await fetchNearbyPlaces(latitude, longitude, radiusMeters, GOOGLE_PLACES_API_KEY);
      console.log(`[backend] Google Places: ${rawPlaces.length} lieux reçus`);
    } catch (placesErr) {
      console.error('[backend] Google Places échoue:', placesErr.message, '→ fallback mock');
      if (!res.headersSent) res.json(MOCK_ACTIVITIES);
      return;
    }

    if (!rawPlaces.length) {
      console.warn('[backend] Google Places: 0 résultats → fallback mock');
      if (!res.headersSent) res.json(MOCK_ACTIVITIES);
      return;
    }

    // 4. Normalize → deduplicate → filter fast-food → limit to 6
    const normalized = rawPlaces.map(normalizePlace);
    const deduped = deduplicate(normalized).filter(isFamilyPlace);
    candidates = deduped.slice(0, 6); // assigned to outer scope for timeout fallback
    console.log(`[backend] ${candidates.length} lieux candidats après déduplification`);

    // Map for O(1) lookup during merge
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

    if (!res.headersSent) res.json(enrichedActivities);

  } catch (e) {
    console.error('[backend] Erreur globale /generer-activites:', e.message);
    if (!res.headersSent) res.json(MOCK_ACTIVITIES);
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
