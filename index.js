const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
if (!OPENROUTER_KEY) throw new Error('OPENROUTER_KEY manquante');

function extractJSON(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch {} }
  const arr = trimmed.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch {} }
  throw new Error('No valid JSON found in response: ' + trimmed.slice(0, 200));
}

app.post('/generer-activites', async (req, res) => {
  try {
    const { latitude, longitude, exclude = [] } = req.body;

    // Nonce unique à chaque appel pour casser tout cache côté OpenRouter/LLM
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Liste noire en tête de prompt, très visible, pour forcer le LLM à l'appliquer
    const excludeBlock = Array.isArray(exclude) && exclude.length > 0
      ? `🚫 LISTE NOIRE — Ces titres sont INTERDITS, ne les propose JAMAIS ni rien de similaire :\n${exclude.map(t => `  ❌ "${t}"`).join('\n')}\n\n`
      : '';

    // Catégories tirées aléatoirement pour varier les propositions à chaque appel
    const allCats = [
      'marché local', 'balade nature', 'musée', 'sport en famille', 'restaurant sympa',
      'atelier créatif', 'spectacle / concert', 'parc & jardin', 'brocante / vide-grenier',
      'piscine / baignade', 'sortie vélo', 'cinéma', 'escape game', 'ferme pédagogique',
      'bowling', 'laser game', 'zoo / aquarium', 'randonnée', 'patinoire',
    ];
    const cats = allCats.sort(() => Math.random() - 0.5).slice(0, 4).join(', ');

    const excludeListStr = Array.isArray(exclude) && exclude.length > 0
      ? exclude.join(', ')
      : null;

    const prompt = `[Requête #${nonce}]
${excludeBlock}${excludeListStr ? `Tu dois absolument proposer des activités DIFFÉRENTES de celles-ci : ${excludeListStr}\n\n` : ''}Propose 6 idées d'activités week-end ORIGINALES et VARIÉES pour une famille, autour de lat=${latitude ?? '?'}, lon=${longitude ?? '?'}.
Cette fois, oriente-toi vers ces catégories : ${cats}.
Chaque activité doit être différente des autres en type, ambiance et lieu.
Inclus des coordonnées GPS approximatives (latitude et longitude) pour chaque lieu — c'est OBLIGATOIRE.
Réponds UNIQUEMENT en JSON valide, sans markdown, sans texte avant ou après :
[{"id":"1","emoji":"🎡","titre":"Titre court","description":"Une phrase engageante","duree":"2h","budget":"Gratuit","latitude":46.12,"longitude":6.23},...]`;

    console.log('[backend] exclude reçu:', exclude);
    console.log('[backend] prompt envoyé à l\'IA:', prompt);

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        temperature: 0.9,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error('OpenRouter error:', response.status, body);
      return res.status(502).json({ erreur: `OpenRouter ${response.status}: ${body.slice(0, 200)}` });
    }
    const data = await response.json();
    const texte = data.choices?.[0]?.message?.content ?? '';
    console.log('[backend] raw response:', texte.slice(0, 400));
    const activites = extractJSON(texte);
    res.json(activites);

  } catch (e) {
    console.error('Erreur /generer-activites:', e);
    res.status(500).json({ erreur: String(e) });
  }
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend Helm démarré sur le port ${PORT}`);
});