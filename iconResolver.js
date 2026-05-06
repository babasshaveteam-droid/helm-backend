'use strict';

// ─── Text normalization ──────────────────────────────────────────────────────
function normalizeText(text) {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip combining diacritics
    .replace(/[''`]/g, ' ')             // smart quotes → space
    .replace(/[^\w\s]/g, ' ')           // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Abstract item detection ─────────────────────────────────────────────────
// Only exact normalized stems qualify — "Petit carnet de curiosités" is NOT abstract
const ABSTRACT_STEMS = [
  /^patience$/,
  /^bonne humeur$/,
  /^motivation$/,
  /^envie$/,
  /^curiosite$/,
  /^appetit$/,
  /^temps$/,
  /^flexibilite$/,
  /^enthousiasme$/,
  /^sourire$/,
  /^bonne volonte$/,
];

function isAbstractItem(text) {
  const n = normalizeText(text);
  return ABSTRACT_STEMS.some(p => p.test(n));
}

// ─── Icon Intents ────────────────────────────────────────────────────────────
// ORDERING IS CRITICAL — first match wins.
// Optional resolve(text, normalized, activityCtx) → {icon, confidence} | null
// null = skip this intent and continue to next.

const ICON_INTENTS = [

  // ═══ PRACTICAL INFO ════════════════════════════════════════════════════════

  // 1. Patins location — AVANT food pour éviter "sur place" → 🍽️
  {
    id: 'skate_rental', icon: '⛸️',
    patterns: [/location\s+(?:de\s+)?patins?/, /patins?\s+sur\s+place/],
    contexts: ['practicalInfo'], confidence: 'high',
  },

  // 2. Sanitaires — priorité max ; "Toilettes accessibles" → 🚻 pas ♿
  {
    id: 'toilets', icon: '🚻',
    patterns: [/toilettes?/, /w\.?c\.?/, /sanitaires?/, /vestiaires?/, /\bdouches?\b/],
    contexts: ['practicalInfo'], confidence: 'high',
  },

  // 3. Accessibilité — après toilets
  {
    id: 'wheelchair', icon: '♿',
    patterns: [/fauteuil\s+roulant/, /\bpmr\b/, /mobilite\s+reduite/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'accessible', icon: '♿',
    patterns: [/accessible?\b/],
    contexts: ['practicalInfo'], confidence: 'medium',
  },
  {
    id: 'stroller', icon: '👶',
    patterns: [/poussette/],
    contexts: ['practicalInfo'], confidence: 'high',
  },

  // 4. Piste débutants — spécifique avant "piste" générique
  {
    id: 'beginner_slope', icon: '🟢',
    patterns: [/piste\b.*(?:debutants?|facile|adaptee?)/, /debutants?\s.*piste\b/],
    contexts: ['practicalInfo'], confidence: 'high',
  },

  // 5. Piste contextuelle — désambiguïsation sport/nature
  {
    id: 'piste_ctx', icon: null,
    patterns: [/\bpiste\b/],
    contexts: ['practicalInfo'], confidence: 'medium',
    resolve(text, n, ctx) {
      if (!ctx) return null;
      if (ctx.category === 'Sport' || ctx.type === 'indoor') return { icon: '⛸️', confidence: 'medium' };
      if (ctx.effortLevel === 'Aventure' || ctx.category === 'Nature') return { icon: '🥾', confidence: 'medium' };
      return null;
    },
  },

  // 6. Équipement
  {
    id: 'helmet', icon: '🪖',
    patterns: [/\bcasque\b/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'gloves', icon: '🧤',
    patterns: [/\bgants?\b/],
    contexts: ['practicalInfo'], confidence: 'high',
  },

  // 7. Horaires / ouverture
  {
    id: 'schedule', icon: '🕒',
    patterns: [/horaires?/, /ouvert(?:e)?\b/, /ferme(?:e)?\b/, /verif.*avant/, /permanence/],
    contexts: ['practicalInfo'], confidence: 'high',
  },

  // 8. Animaux
  {
    id: 'zoo_info', icon: '🦁',
    patterns: [/\bzoo\b/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'farm_info', icon: '🐐',
    patterns: [/animaliers?/, /\banimaux\b/, /\bferme\b/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'aquarium_info', icon: '🐠',
    patterns: [/aquarium/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'butterfly_info', icon: '🦋',
    patterns: [/papillons?/],
    contexts: ['practicalInfo'], confidence: 'high',
  },

  // 9. Jeux / enfants
  {
    id: 'playground', icon: '🛝',
    patterns: [/aire\s+de\s+jeux/, /structures?\s+de\s+jeux/, /trampoline/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'bouncy_castle', icon: '🏰',
    patterns: [/chateau\s+gonflable/, /chateaux\s+gonflables?/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'carousel', icon: '🎠',
    patterns: [/manege/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'children_space', icon: '👶',
    patterns: [/menu\s+enfants?/, /espaces?\s+enfants?/, /zones?\s+enfants?/, /adapte\s+aux\s+enfants?/],
    contexts: ['practicalInfo'], confidence: 'high',
  },

  // 10. Randonnée / nature / forêt
  {
    id: 'hike', icon: '🥾',
    patterns: [/randonnee/, /\bsentier\b/, /\btrek\b/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'stroll', icon: '🚶',
    patterns: [/\bbalade\b/, /promenade/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'forest', icon: '🌲',
    patterns: [/\bforet\b/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'mountain', icon: '⛰️',
    patterns: [/montagne/, /\bsommet\b/, /altitude/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'viewpoint', icon: '👀',
    patterns: [/point\s+de\s+vue/, /panorama/, /belvedere/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'bench', icon: '🪑',
    patterns: [/\bbancs?/, /zones?\s+de\s+repos/, /\brepos\b/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'shade', icon: '🌳',
    patterns: [/\ombre\b/, /ombrage/],
    contexts: ['practicalInfo'], confidence: 'medium',
  },

  // 11. Eau / piscine / plage
  {
    id: 'beach_info', icon: '🏖️',
    patterns: [/plage/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'swimming', icon: '🏊',
    patterns: [/baignade/, /\bnage\b/, /\bpiscine\b/, /\bbassin\b/],
    contexts: ['practicalInfo'], confidence: 'high',
    resolve(text, n, ctx) {
      // "bassin" alone dans un contexte musée/culture → skip
      if (/\bbassin\b/.test(n) && !(/baignade|nage|piscine/.test(n)) && ctx?.category === 'Culture') {
        return null;
      }
      return { icon: '🏊', confidence: 'high' };
    },
  },
  {
    id: 'lake_info', icon: '🌊',
    patterns: [/\blac\b/, /bord\s+du\s+lac/, /bord\s+de\s+l.eau/, /acces\s+direct/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'water_info', icon: '💧',
    patterns: [/\beau\b/],
    contexts: ['practicalInfo'], confidence: 'medium',
  },

  // 12. Restauration — SANS "sur place" seul (trop générique → ✨)
  {
    id: 'cafeteria', icon: '☕',
    patterns: [/cafeteria/, /\bcafe\b/, /\bboulangerie\b/, /\bpatisserie\b/, /\bgouter\b/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'restaurant', icon: '🍽️',
    patterns: [/\bsnack\b/, /\brestauration\b/, /\brestaurant\b/, /\bbuvette\b/, /fondue/, /\brepas\b/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'shop_info', icon: '🛍️',
    patterns: [/boutique/, /souvenir/, /emporter/],
    contexts: ['practicalInfo'], confidence: 'high',
  },

  // 13. Climatisation
  {
    id: 'air_conditioned', icon: '❄️',
    patterns: [/climatise/, /climatisation/, /air\s+conditionne/],
    contexts: ['practicalInfo'], confidence: 'high',
  },

  // 14. Culture / musée
  {
    id: 'exhibition', icon: '🖼️',
    patterns: [/vitrines?\s+interactives?/, /exposition/, /collection/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'workshop', icon: '🎨',
    patterns: [/\batelier\b/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'guided_tour', icon: '🎟️',
    patterns: [/visite\s+(?:libre|guidee?|gratuite?)/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'heritage', icon: '🏛️',
    patterns: [/historique/, /patrimoine/, /monument/, /cathedrale/, /abbaye/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'religious', icon: '⛪',
    patterns: [/religieux/, /\bculte\b/, /eglise/],
    contexts: ['practicalInfo'], confidence: 'medium',
  },

  // 15. Prix / billets
  {
    id: 'ticket', icon: '🎟️',
    patterns: [/billet/, /\bticket\b/, /reservation/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'free', icon: '💰',
    patterns: [/gratuit/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'price', icon: '💰',
    patterns: [/\bprix\b/, /tarif/, /\bentree\b/, /payant/],
    contexts: ['practicalInfo'], confidence: 'medium',
  },

  // 16. Accès / parking
  {
    id: 'parking', icon: '🅿️',
    patterns: [/parking/, /stationnement/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'stairs', icon: '🪜',
    patterns: [/escaliers?/, /\bmontee\b/],
    contexts: ['practicalInfo'], confidence: 'medium',
  },
  {
    id: 'bridge_info', icon: '🌉',
    patterns: [/\bpont\b/],
    contexts: ['practicalInfo'], confidence: 'medium',
  },
  {
    id: 'address', icon: '📍',
    patterns: [/adresse/, /centre.ville/, /\bsitue\b/, /\bacces\b/],
    contexts: ['practicalInfo'], confidence: 'medium',
  },

  // 17. Vêtements / chaussures
  {
    id: 'coat', icon: '🧥',
    patterns: [/vetements?/, /\bveste\b/, /\bchaud\b/, /imper/],
    contexts: ['practicalInfo'], confidence: 'medium',
  },
  {
    id: 'hiking_shoes', icon: '🥾',
    patterns: [/chaussures?\s+(?:de\s+)?(?:march|rand|bottes?|trek)/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'shoes', icon: '👟',
    patterns: [/chaussures?/, /baskets?/, /antiderap/],
    contexts: ['practicalInfo'], confidence: 'medium',
  },

  // 18. Famille / sécurité / météo
  {
    id: 'children', icon: '🧒',
    patterns: [/\benfants?\b/, /\bfamille\b/],
    contexts: ['practicalInfo'], confidence: 'medium',
  },
  {
    id: 'supervised', icon: '🛡️',
    patterns: [/surveill/, /encadre/, /supervision/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'safety', icon: '⚠️',
    patterns: [/securite/, /prudence/, /\battention\b/, /danger/],
    contexts: ['practicalInfo'], confidence: 'high',
  },
  {
    id: 'weather_info', icon: '🌤️',
    patterns: [/meteo/, /intemperies?/],
    contexts: ['practicalInfo'], confidence: 'high',
  },

  // ═══ BRING ITEM ════════════════════════════════════════════════════════════

  {
    id: 'wallet', icon: '👛',
    patterns: [/portefeuille/, /porte.?monnaie/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'swimsuit', icon: '🩱',
    patterns: [/maillot\s+de\s+bain/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'swim_cap', icon: '🧢',
    patterns: [/bonnet\s+de\s+bain/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'towel', icon: '🧺',
    patterns: [/serviette/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'gloves_bring', icon: '🧤',
    patterns: [/\bgants?\b/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'thick_socks', icon: '🧦',
    patterns: [/chaussettes?\s+(?:epaisses?|chaudes?)/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'socks', icon: '🧦',
    patterns: [/chaussettes?/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'camera', icon: '📸',
    patterns: [/appareil\s+photo/, /\bphoto\b/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'binoculars', icon: '🔭',
    patterns: [/jumelles?/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'sketchbook', icon: '📓',
    patterns: [/carnet\s+de\s+(?:croquis|dessin)/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'art_supply', icon: '🎨',
    patterns: [/peinture/, /crayons?\s+de\s+couleur/, /feutres?/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'pencil', icon: '✏️',
    patterns: [/\bcrayon\b/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'notepad', icon: '📓',
    patterns: [/\bcarnet\b/],
    contexts: ['bringItem'], confidence: 'medium',
  },
  {
    id: 'snack', icon: '🍎',
    patterns: [/en.cas/, /collation/, /\bgouter\b/, /\bsnack\b/, /petite\s+faim/, /sandwich/, /\bfruits?\b/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'guidebook', icon: '📘',
    patterns: [/petit\s+guide/, /guide\s+des\s+animaux/, /livret/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'book', icon: '📚',
    patterns: [/\blivre\b/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'library_card', icon: '💳',
    patterns: [/carte\s+de\s+biblioth/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'water_bring', icon: '💧',
    patterns: [/bouteille/, /gourde/, /\beau\b/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'sunscreen', icon: '🧴',
    patterns: [/creme\s+solaire/, /ecran\s+solaire/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'hat', icon: '🧢',
    patterns: [/\bbonnet\b/, /casquette/, /\bchapeau\b/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'rain_jacket', icon: '🧥',
    patterns: [/impermeable/, /veste\s+de\s+pluie/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'jacket', icon: '🧥',
    patterns: [/\bveste\b/, /\bmanteau\b/, /vetements?\s+chauds?/, /\bchaud\b/],
    contexts: ['bringItem'], confidence: 'medium',
  },
  {
    id: 'hiking_shoes_bring', icon: '🥾',
    patterns: [/chaussures?\s+de\s+(?:march|rand|trek|bottes)/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'shoes_bring', icon: '👟',
    patterns: [/chaussures?/, /baskets?/],
    contexts: ['bringItem'], confidence: 'medium',
  },
  {
    id: 'skates_bring', icon: '⛸️',
    patterns: [/patins?/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'helmet_bring', icon: '🪖',
    patterns: [/\bcasque\b/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'torch', icon: '🔦',
    patterns: [/lampe/, /torche/, /frontale/],
    contexts: ['bringItem'], confidence: 'high',
  },
  {
    id: 'cash', icon: '💶',
    patterns: [/\bmonnaie\b/, /\bcash\b/, /\bargent\b/],
    contexts: ['bringItem'], confidence: 'medium',
  },
  {
    id: 'bag', icon: '🎒',
    patterns: [/sac\s+a\s+dos/, /bagage/],
    contexts: ['bringItem'], confidence: 'medium',
  },
  {
    id: 'picnic', icon: '🧺',
    patterns: [/pique.nique/, /\bpanier\b/],
    contexts: ['bringItem'], confidence: 'high',
  },
];

// ─── Activity name patterns (from NAME_EMOJI_PATTERNS) ───────────────────────
const ACTIVITY_NAME_PATTERNS = [
  [/château|castle|fortress|forteresse|palais\b|palace/i, '🏰'],
  [/cathédrale|cathedral|église|church|chapelle|abbaye|abbey|basilique|basilica|prieuré/i, '⛪'],
  [/musée|museum/i, '🏛️'],
  [/pont\b|bridge/i, '🌉'],
  [/belvédère|belveder|viewpoint|panorama|vue\s+sur|sommet/i, '⛰️'],
  [/papiliorama|papillon|butterfly/i, '🦋'],
  [/zoo|safari|ferme\s*(animaux|animalière?|pédagog|d['']élevage|enfants?)/i, '🦁'],
  [/aquarium/i, '🐠'],
  [/indoor\s*play(?:ground)?|aire\s+de\s+jeux\b/i, '🛝'],
  [/bowling/i, '🎳'],
  [/cin[ée]ma|cin[ée]plex/i, '🎬'],
  [/piscine|swimming/i, '🏊'],
  [/patinoire|ice\s*skat/i, '⛸️'],
  [/escalade|climbing\s*(gym|wall|center)|bloc\b/i, '🧗'],
  [/mini.golf|minigolf/i, '⛳'],
  [/skatepark|pumptrack/i, '🛹'],
  [/boulangerie|pâtisserie|pastry/i, '🥐'],
  [/grotte|caverne|souterr/i, '🔦'],
  [/forêt|forest|bois\b/i, '🌲'],
  [/plage|beach|baignade/i, '🏖️'],
  [/\blac\b|lake|étang/i, '🌊'],
  [/jardin|garden|botanical/i, '🌸'],
  [/parc d['']attract|amusement park/i, '🎡'],
  [/bibliothèque|library/i, '📚'],
  [/ludothèque/i, '🧸'],
  [/galerie|gallery/i, '🎨'],
  [/centre\s+commercial|shopping\s+(center|centre|mall)|galerie\s+commerciale/i, '🏬'],
];

// Activity Google Place type → emoji
const ACTIVITY_TYPE_MAP = {
  castle: '🏰', church: '⛪', hindu_temple: '⛪', mosque: '⛪', synagogue: '⛪',
  museum: '🏛️', art_gallery: '🎨', zoo: '🦁', aquarium: '🐠',
  botanical_garden: '🌸', amusement_park: '🎡', amusement_center: '🛝',
  library: '📚', natural_feature: '🌲', nature_reserve: '🦋',
  park: '🌳', shopping_mall: '🏬', beach: '🏖️',
  ice_skating_rink: '⛸️', swimming_pool: '🏊',
  bowling_alley: '🎳', historic_site: '🏛️', tourist_attraction: '🗺️',
  cafe: '☕', restaurant: '🍽️',
};

// ─── resolveActivityEmoji ────────────────────────────────────────────────────
function resolveActivityEmoji(place) {
  const name = place.name ?? '';
  const types = place.types ?? [];

  for (const [pattern, icon] of ACTIVITY_NAME_PATTERNS) {
    if (pattern.test(name)) {
      console.log(`[icon] activity "${name}" -> ${icon} reason=name_pattern confidence=high`);
      return { icon, reason: 'name_pattern', confidence: 'high' };
    }
  }
  for (const t of types) {
    if (ACTIVITY_TYPE_MAP[t]) {
      console.log(`[icon] activity "${name}" -> ${ACTIVITY_TYPE_MAP[t]} reason=type:${t} confidence=high`);
      return { icon: ACTIVITY_TYPE_MAP[t], reason: `type:${t}`, confidence: 'high' };
    }
  }
  console.log(`[icon] activity "${name}" -> ✨ reason=no_match confidence=low`);
  return { icon: '✨', reason: 'no_match', confidence: 'low' };
}

// ─── resolveIcon ─────────────────────────────────────────────────────────────
function resolveIcon(text, context, activityCtx = {}) {
  const n = normalizeText(text);

  for (const intent of ICON_INTENTS) {
    if (!intent.contexts.includes(context)) continue;
    const matched = intent.patterns.some(p => p.test(n));
    if (!matched) continue;

    if (intent.resolve) {
      const r = intent.resolve(text, n, activityCtx);
      if (!r) continue;   // null = try next intent
      const result = { icon: r.icon, reason: intent.id, confidence: r.confidence ?? intent.confidence };
      console.log(`[icon] ${context} "${text}" -> ${result.icon} reason=${result.reason} confidence=${result.confidence}`);
      return result;
    }

    const result = { icon: intent.icon, reason: intent.id, confidence: intent.confidence };
    console.log(`[icon] ${context} "${text}" -> ${result.icon} reason=${result.reason} confidence=${result.confidence}`);
    return result;
  }

  console.log(`[icon] ${context} "${text}" -> ✨ reason=unknown confidence=low`);
  return { icon: '✨', reason: 'unknown', confidence: 'low' };
}

// ─── resolveAll ──────────────────────────────────────────────────────────────
// Applies the resolver to all icon fields of an activity.
// Input  activity: { emoji?, whatToBring: string[], practicalInfos: string[], ... }
// Output activity: { emoji, icon, whatToBring: {text,icon}[], practicalInfos: {text,icon}[] }
function resolveAll(activity, place) {
  const activityCtx = {
    category: activity.category,
    type: activity.type,
    effortLevel: activity.effortLevel,
    tags: activity.tags,
  };

  // 1. Main emoji — resolver wins if confident; keep existing if resolver has no match
  const emojiResult = resolveActivityEmoji(place ?? {});
  const useResolved = emojiResult.confidence !== 'low' || !activity.emoji || activity.emoji === '✨';
  const finalEmoji = useResolved ? emojiResult.icon : activity.emoji;

  // 2. whatToBring — filter abstracts, context-replace some, then resolve icons
  const rawBring = (activity.whatToBring ?? []).filter(item => typeof item === 'string');
  const filteredBring = rawBring.map(item => {
    if (isAbstractItem(item)) {
      const n = normalizeText(item);
      if (activityCtx.category === 'Culture' && /curiosite/.test(n)) return 'Petit carnet';
      console.log(`[icon] abstract item rejected: "${item}"`);
      return null;
    }
    return item;
  }).filter(Boolean);

  const whatToBring = filteredBring.map(item => ({
    text: item,
    icon: resolveIcon(item, 'bringItem', activityCtx).icon,
  }));

  // 3. practicalInfos — resolve icons
  const rawInfos = (activity.practicalInfos ?? []).filter(item => typeof item === 'string');
  const practicalInfos = rawInfos.map(item => ({
    text: item,
    icon: resolveIcon(item, 'practicalInfo', activityCtx).icon,
  }));

  return { ...activity, emoji: finalEmoji, icon: finalEmoji, whatToBring, practicalInfos };
}

module.exports = { normalizeText, isAbstractItem, resolveIcon, resolveActivityEmoji, resolveAll };
