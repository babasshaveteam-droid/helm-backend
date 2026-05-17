// Règles officielles : docs/HELM_CORE_RULES.md
// Score de confiance activité familiale — filtre appliqué AVANT Claude

const FAMILY_ACTIVITY_TYPES = new Set([
  'zoo', 'aquarium', 'museum', 'amusement_park', 'bowling_alley',
  'ice_skating_rink', 'library', 'movie_theater', 'art_gallery',
  'amusement_center', 'playground',
]);

const ACTIVITY_TYPES_MEDIUM = new Set([
  'park', 'tourist_attraction', 'natural_feature', 'botanical_garden',
  'swimming_pool', 'shopping_mall', 'cafe', 'restaurant', 'beach',
  'gym', 'sports_complex', 'campground',
]);

const NEGATIVE_COMMERCIAL_TYPES = new Set([
  'store', 'hardware_store', 'home_goods_store', 'furniture_store',
  'electronics_store', 'clothing_store', 'shoe_store', 'jewelry_store',
  'book_store', 'florist', 'pet_store', 'bicycle_store', 'car_rental',
  'general_contractor', 'electrician', 'plumber', 'painter',
  'roofing_contractor', 'moving_company', 'locksmith',
]);

// Noms qui indiquent explicitement un magasin/service lié aux piscines
const POOL_SHOP_RE = /\b(pisciniste|piscinerie|piscin\s*shop|vendeur\s+de\s+piscin|constructeur\s+de\s+piscin|installateur\s+piscin|entretien\s+piscin|r[eé]paration\s+piscin|pool\s+(?:shop|service|supply|store|maintenance|construction|pro)|spa\s+showroom|spa\s*shop)\b/i;

// Vraie piscine publique / centre aquatique
const PUBLIC_POOL_RE = /piscine\s+(municipale|communale|publique|couverte|ext[eé]rieure|d[eé]couverte|plein\s+air|d['']été)|centre\s+aquatique|espace\s+aquatique|parc\s+aquatique|bains\s+publics/i;

// Espaces naturels publics — pas d'horaires Google → exempt de la pénalité isOpen=null
const OUTDOOR_PUBLIC_TYPES = new Set([
  'park', 'natural_feature', 'beach', 'campground',
]);

// Types qui doivent normalement avoir des horaires — règle prudente la nuit (21h-07h)
const NIGHT_MANAGED_TYPES = new Set([
  'library', 'museum', 'cafe', 'restaurant', 'movie_theater', 'bowling_alley',
  'ice_skating_rink', 'swimming_pool', 'aquarium', 'zoo', 'tourist_attraction',
  'art_gallery', 'amusement_park', 'amusement_center', 'gym', 'sports_complex',
  'castle', 'historic_site',
]);

// Lieux nature/outdoor librement accessibles — exempts de la règle nuit
const OUTDOOR_NATURE_NAME_RE = /belv[eé]d[eè]re|panorama|vue\s+sur|\bsentier\b|for[eê]t|\blac\b|alpage|gorge|cascade|chute|canyon|\bcol\b|glacier|\bsommet\b|(see|berg|alp|horn|pass|gletscher|schlucht)\b/i;

// Lieux gérés détectés par nom — soumis à la règle nuit même sans type Google explicite
const NIGHT_MANAGED_NAME_RE = /\bobservatoir[e]?\b|\bobservatory\b|ch[aâ]teau|castle|fortress|forteresse/i;

// Bâtiments agricoles non visitables
const AGRICULTURAL_NON_VISITABLE_RE = /\b(s[eé]choir|grange|hangar|entrepôt\s+agri|d[eé]p[oô]t\s+agri|bâtiment\s+agri)\b/i;

// Kiosques loterie / paris sportifs — inclut variantes suisses
const LOTTERY_KIOSK_RE = /\b(jeux?\s+(de\s+la\s+)?loterie|loterie\s+romande|loterie\s+nationale|\bloterie\b|\bloto\b|\blotto\b|\bpmu\b|tierc[eé]|fran[cç]aise\s+des\s+jeux|\bfdj\b|paris\s+sportifs?|grattage|swisslos|point\s+de\s+vente\s+loterie|kiosque\s+loterie)\b/i;

// Ferme qui EST une activité famille
const FARM_ACTIVITY_RE = /ferme\s+(p[eé]dagog|animaux?|aventure|ouverte|famille|enfants?)|parc\s+animalier|autocueillette|cueillette\s+famille/i;

// Entités business / sociétés / services techniques
const BUSINESS_ENTITY_RE = /\b(sarl|sas|sa\b|gmbh|s\.r\.l\.|soci[eé]t[eé]|construction|r[eé]novation|travaux|maçonnerie|couverture|menuiserie|charpente|isolation|vitrage|carrelage|peinture\s+(int|ext)|[eé]lectricit[eé]\s+s[a-z]{2,4}\b|plomberie\s+s[a-z]{2,4}\b|chauffage\s+s[a-z]{2,4}\b|ventilation\s+s[a-z]{2,4}\b|signalisation|transport\s+(sarl|sas|sa))\b/i;

// Catégories interdites par type Google — §31 : banque, pharmacie, garage, parking, admin
const FORBIDDEN_SERVICE_TYPES = new Set([
  'bank', 'atm', 'pharmacy', 'drugstore',
  'gas_station', 'parking',
  'local_government_office', 'city_hall', 'courthouse',
  'police', 'fire_station',
  'hospital', 'doctor', 'dentist',
  'real_estate_agency', 'insurance_agency', 'lawyer', 'accountant',
  'car_repair', 'car_dealer', 'car_wash',
]);

function isForbiddenService(place) {
  const types = Array.isArray(place.types) ? place.types : [];
  return types.some(t => FORBIDDEN_SERVICE_TYPES.has(t));
}

function isPoolShop(place) {
  const name = place.name ?? '';
  if (POOL_SHOP_RE.test(name)) return true;
  const types = Array.isArray(place.types) ? place.types : [];
  // "Piscines Dupont" (pluriel sans qualificatif public + type commercial)
  if (/\bpiscines\b/i.test(name) && !PUBLIC_POOL_RE.test(name) &&
      (types.includes('store') || types.includes('general_contractor'))) return true;
  return false;
}

function isAgriculturalNonVisitable(place) {
  const name = place.name ?? '';
  if (!AGRICULTURAL_NON_VISITABLE_RE.test(name)) return false;
  if (FARM_ACTIVITY_RE.test(name)) return false;
  return true;
}

// ─── Closing-time helpers (Europe/Zurich) ─────────────────────────────────────

function getZurichNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Zurich',
    weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const dayStr = parts.find(p => p.type === 'weekday')?.value ?? 'Monday';
  const hour   = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  const DAY = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
  return { day: DAY[dayStr] ?? 0, hour, minute };
}

// Returns minutes until the place closes, or null if not determinable.
// Handles same-day, overnight, and lunch-break periods correctly.
function computeMinutesUntilClose(closingPeriods) {
  if (!Array.isArray(closingPeriods) || closingPeriods.length === 0) return null;
  const { day, hour, minute } = getZurichNow();
  const nowMin = hour * 60 + minute;
  for (const period of closingPeriods) {
    if (!period.open || !period.close) continue; // 24/7 ou mal formé
    const openDay  = period.open.day;
    const openMin  = (period.open.hour  ?? 0) * 60 + (period.open.minute  ?? 0);
    const closeDay = period.close.day;
    const closeMin = (period.close.hour ?? 0) * 60 + (period.close.minute ?? 0);
    // Même journée (ex: 09h–18h)
    if (openDay === day && closeDay === day && nowMin >= openMin && nowMin < closeMin)
      return closeMin - nowMin;
    // Ouvre aujourd'hui, ferme demain (nuit : ex: 22h–02h)
    if (openDay === day && closeDay === (day + 1) % 7 && nowMin >= openMin)
      return (24 * 60 - nowMin) + closeMin;
    // Ouvert depuis hier, ferme aujourd'hui (continuation de nuit)
    if (openDay === (day + 6) % 7 && closeDay === day && nowMin < closeMin)
      return closeMin - nowMin;
  }
  return null;
}

// Returns true if Zurich time is between 21h00 and 06h59
function isNightHoursZurich() {
  const { hour } = getZurichNow();
  return hour >= 21 || hour < 7;
}

// Returns true if the place is expected to have known opening hours
// Outdoor public spaces (park, natural_feature, beach, campground) and
// nature-named places (sentier, lac, belvédère…) are always exempt.
function isManagedHoursPlace(place) {
  const types = Array.isArray(place.types) ? place.types : [];
  const name = place.name ?? '';
  if (types.some(t => OUTDOOR_PUBLIC_TYPES.has(t))) return false;
  if (OUTDOOR_NATURE_NAME_RE.test(name)) return false;
  if (types.some(t => NIGHT_MANAGED_TYPES.has(t))) return true;
  if (NIGHT_MANAGED_NAME_RE.test(name)) return true;
  return false;
}

function getFamilyActivityScore(place) {
  const name = place.name ?? '';
  const types = Array.isArray(place.types) ? place.types : [];
  const { rating, ratingCount, isOpen, businessStatus } = place;

  // Rejets immédiats — score non pertinent
  if (businessStatus === 'CLOSED_PERMANENTLY') return -999;
  if (businessStatus === 'CLOSED_TEMPORARILY') return -999;
  if (isOpen === false) return -999; // fermé maintenant → §30
  if (isForbiddenService(place)) return -999; // catégorie interdite → §31
  if (isPoolShop(place)) return -5;
  if (isAgriculturalNonVisitable(place)) return -5;
  if (BUSINESS_ENTITY_RE.test(name)) return -4;
  if (LOTTERY_KIOSK_RE.test(name)) return -5;

  let score = 0;

  // Types Google
  if (types.some(t => FAMILY_ACTIVITY_TYPES.has(t))) score += 3;
  else if (types.some(t => ACTIVITY_TYPES_MEDIUM.has(t))) score += 2;
  else if (types.includes('lodging') || types.includes('bar')) score += 1;

  // Nom d'activité famille claire
  if (/ferme\s+p[eé]dagog|parc\s+(de\s+loisirs?|animalier|d['']attract)|aire\s+de\s+jeux|ludoth[eè]que|piscine\s+(municipale|publique|communale)|centre\s+aquatique|trampoline\s+(park|zone|parc)/i.test(name)) score += 2;
  else if (/patinoire|bowling|escalade|trampoline|cin[eé]ma|biblioth[eè]que|mus[eé]e|zoo|aquarium|randonn[eé]e|sentier|grotte|caverne|belv[eé]d[eè]re|aire\s+de\s+jeux|laser[\s-]?game|escape\s*room|karting|kart\b|accrobranche|[eé]quitation|poneys?|mini[\s-]?golf|\bski\b|luge|spectacle\s+(jeunesse|enfants?)|marionnettes?|(see|berg|alp|horn|pass|gletscher|schlucht)\b|\blac\b|alpage|gorge|cascade|chute|canyon|\bcol\b|glacier|panorama|vue\s+sur/i.test(name)) score += 1;

  // Note correcte — §31 : >= 4.0
  if (rating != null && rating >= 4.0) score += 1;
  // Avis nombreux — §31 : >= 20
  if (ratingCount != null && ratingCount >= 20) score += 1;
  // Adresse / coordonnées fiables — §31
  if (place.address || (place.lat != null && place.lon != null)) score += 1;
  // Horaires : +1 si ouvert, -2 si inconnus (exempt pour espaces naturels publics sans horaires)
  const isOutdoorPublic = types.some(t => OUTDOOR_PUBLIC_TYPES.has(t));
  if (isOpen === true) score += 1;
  else if (isOpen === null && !isOutdoorPublic) score -= 2;

  // Pénalité : type commercial — §31 : -5
  if (types.some(t => NEGATIVE_COMMERCIAL_TYPES.has(t))) score -= 5;

  // Pénalité : seulement point_of_interest/establishment (trop générique)
  const meaningful = types.filter(t => !['point_of_interest', 'establishment'].includes(t));
  if (meaningful.length === 0 && types.length > 0) score -= 3;

  return score;
}

const MIN_SCORE = 3;

function getRejectReason(place, score) {
  if (place.businessStatus === 'CLOSED_PERMANENTLY') return 'closed_permanently';
  if (place.businessStatus === 'CLOSED_TEMPORARILY') return 'closed_temporarily';
  if (place.isOpen === false) return 'closed_now';
  if (isForbiddenService(place)) return 'forbidden_category';
  if (isPoolShop(place)) return 'pool_shop';
  if (isAgriculturalNonVisitable(place)) return 'agricultural_building';
  if (BUSINESS_ENTITY_RE.test(place.name ?? '')) return 'business_entity';
  if (LOTTERY_KIOSK_RE.test(place.name ?? '')) return 'lottery';
  if (score < MIN_SCORE) return 'low_family_activity_score';
  return null;
}

function filterFamilyActivities(places) {
  const accepted = [];
  for (const p of places) {
    const score = getFamilyActivityScore(p);
    const reason = getRejectReason(p, score);
    if (reason) {
      console.log(`[quality] rejected reason=${reason} score=${score} name="${p.name}"`);
      continue;
    }
    // Ferme bientôt (≤30 min)
    const minutesLeft = computeMinutesUntilClose(p.closingPeriods);
    if (minutesLeft !== null && minutesLeft <= 30) {
      console.log(`[quality] rejected reason=closing_soon minutesLeft=${minutesLeft} name="${p.name}"`);
      continue;
    }
    // Règle prudente nuit (21h-07h) : isOpen=null sur lieu normalement géré → rejeté
    if (p.isOpen === null && isNightHoursZurich() && isManagedHoursPlace(p)) {
      console.log(`[quality] rejected reason=unknown_hours_night name="${p.name}"`);
      continue;
    }
    console.log(`[quality] accepted score=${score} name="${p.name}"`);
    if (p.isOpen === null) {
      console.log(`[quality] warning reason=unknown_opening_hours name="${p.name}"`);
    }
    accepted.push(p);
  }
  return accepted;
}

module.exports = {
  getFamilyActivityScore,
  filterFamilyActivities,
  isPoolShop,
  isAgriculturalNonVisitable,
  getRejectReason,
  computeMinutesUntilClose,
  MIN_SCORE,
};
