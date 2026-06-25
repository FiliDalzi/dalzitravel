require("dotenv").config();
const express   = require("express");
const axios     = require("axios");
const cors      = require("cors");
const helmet    = require("helmet");
const rateLimit = require("express-rate-limit");
const path      = require("path");
const fs        = require("fs");
const crypto    = require("crypto");
const Groq      = require("groq-sdk");
const PDFDocument = require("pdfkit");

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");

// Assicura che la directory data esista
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Security & Middleware ────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'", "https://*.tile.openstreetmap.org", "https://unpkg.com"],
    },
  },
}));
app.use(cors());
app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: "Troppe richieste. Riprova tra qualche minuto." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Groq Client ─────────────────────────────────────────────────────────────
let groqClient = null;
function getGroqClient() {
  if (!groqClient) {
    if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY non impostata nel .env");
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return groqClient;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERSISTENZA UTENTI E CHAT (file JSON, no DB esterno)
// Struttura data/:
//   users.json              → lista utenti { id, name, pinHash, createdAt }
//   chats_<userId>.json     → array di chat { id, title, createdAt, messages[] }
// ═══════════════════════════════════════════════════════════════════════════════

const USERS_FILE = path.join(DATA_DIR, "users.json");

function readUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch { return []; }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function chatsFile(userId) {
  return path.join(DATA_DIR, `chats_${userId}.json`);
}

function readChats(userId) {
  try {
    const f = chatsFile(userId);
    if (!fs.existsSync(f)) return [];
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch { return []; }
}

function writeChats(userId, chats) {
  fs.writeFileSync(chatsFile(userId), JSON.stringify(chats, null, 2));
}

function hashPin(pin) {
  return crypto.createHash("sha256").update(pin + "dalzitravel_salt_2025").digest("hex");
}

function generateId() {
  return crypto.randomBytes(8).toString("hex");
}

// Genera nome avatar casuale stile "ViaggiatoreAzurro42"
function generateUsername() {
  const aggettivi = ["Curioso","Avventuroso","Audace","Sereno","Visionario","Nomade","Libero","Ardito","Vivace","Cosmopolita"];
  const nomi      = ["Viaggiatore","Esploratore","Globetrotter","Wanderer","Scopritore","Pellegrino"];
  const adj = aggettivi[Math.floor(Math.random() * aggettivi.length)];
  const noun = nomi[Math.floor(Math.random() * nomi.length)];
  const num  = Math.floor(Math.random() * 90) + 10;
  return `${adj}${noun}${num}`;
}

// Middleware: verifica sessione (token = userId:pinHash nel header X-Auth)
function requireAuth(req, res, next) {
  const token = req.headers["x-auth"] || "";
  const [userId, pinHash] = token.split(":");
  if (!userId || !pinHash) return res.status(401).json({ error: "Non autenticato." });

  const users = readUsers();
  const user  = users.find(u => u.id === userId && u.pinHash === pinHash);
  if (!user) return res.status(401).json({ error: "Sessione non valida." });

  req.user = user;
  next();
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLASSIFICATORE DI INTENT — decide come rispondere
// ═══════════════════════════════════════════════════════════════════════════════

// Parole chiave che indicano una richiesta di itinerario strutturato
const ITINERARY_SIGNALS = [
  /\b(\d+)\s*giorni?\b/i,
  /\b(\d+)\s*notti?\b/i,
  /\b(\d+)\s*settimane?\b/i,
  /\bitinerari[oa]\b/i,
  /\bpianifica\b/i,
  /\borgani[zs]za\b/i,
  /\bviaggio\s+(?:a|in|per|nei?)\b/i,
  /\bprogramma\s+(?:di\s+)?viaggio\b/i,
  /\bcosa\s+(?:fare|vedere|visitare)\s+(?:a|in)\b/i,
];

function classifyIntent(message, history) {
  // Se c'è già un itinerario in chat e la domanda è di follow-up → conversazione
  const hasItineraryInHistory = history.some(m => m.role === "assistant" && m.tipo === "itinerario");

  // Conta segnali di itinerario nel messaggio
  const signals = ITINERARY_SIGNALS.filter(r => r.test(message)).length;

  if (signals >= 2) return "itinerario";
  if (signals === 1 && !hasItineraryInHistory) return "itinerario";
  return "conversazione"; // domanda, consiglio, follow-up
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── CHAT SYSTEM PROMPT (Regole 5-6-7) ───────────────────────────────────────
const CHAT_SYSTEM_PROMPT = `Sei Dali, l'assistente AI ufficiale di DalziTravel — agenzia viaggi italiana premium.
Personalità: esperto, caldo, diretto. Parli come un consulente di viaggio senior, non come una guida turistica.

COMPETENZE:
Destinazioni, trasporti, visti, valute, clima, cultura, gastronomia, sicurezza, crociere,
zaino in spalla, lusso, budget, assicurazioni viaggio, documenti, salute in viaggio.

REGOLA 5 — PRECISIONE TECNICA, ZERO CLICHÉ:
Usa FATTI REALI del settore quando rispondi a domande tecniche (crociere, aerei, hotel, trasporti).
ESEMPIO — Mal di mare in crociera:
CORRETTO: Per il mal di mare conta la POSIZIONE nella nave: cabine centrali ai ponti bassi/medi oscillano meno.
Una suite di prua al ponte 14 è peggio di una cabina interna al ponte 5 al centro nave.
SBAGLIATO: consigliare la cabina esterna per l'aria fresca (non riduce il mal di mare).
Non dire mai "dipende dalle preferenze personali" senza spiegare esattamente SU COSA dipende.
Non usare frasi da depliant: "un'esperienza indimenticabile", "sogno che diventa realtà".

REGOLA 6 — DISTINZIONE NETTA DELLE CATEGORIE:
Quando esistono più categorie, MAPPALE TUTTE con differenze chiare e concrete.
ESEMPIO — 4 categorie reali di cabine crociera:
1. INTERNA: nessuna finestra, buio totale, più economica. Non adatta a claustrofobici.
2. ESTERNA CON OBLÒ: finestra fissa non apribile, luce naturale, nessun balcone. Prezzo medio.
3. BALCONE (Veranda): finestra + porta + spazio esterno privato. La più richiesta. Medio-alto.
4. SUITE: spazio extra, servizi premium, posizione privilegiata. Prezzo elevato.
NON confondere mai i vantaggi di una categoria con quelli di un'altra.

REGOLA 7 — CALL TO ACTION CONTESTUALE E DINAMICA:
NON chiudere mai con "contatta DalziTravel per saperne di più" o frasi simili generiche.
La CTA deve essere specifica alla domanda, spingere al passo successivo logico nell'app,
formulata come domanda aperta. Esempi:
- Dopo cabine crociera: "Soffri di mal di mare? Dimmi la durata della crociera e ti indico i ponti migliori da scegliere."
- Dopo consiglio destinazione: "Vuoi che costruisca l'itinerario completo con mappa interattiva?"
- Dopo clima/periodo: "Dimmi quanti giorni hai e da dove parti: ti faccio un piano con i transfer inclusi."

FORMATO: italiano sempre. Max 2 emoji. 150-280 parole (più se serve categorizzazione).
Non inventare prezzi o orari specifici. Usa dati Tavily se nel contesto.`;

// ─── ITINERARY SYSTEM PROMPT (Regole 1-2-3-4) ────────────────────────────────
const ITINERARY_SYSTEM_PROMPT = `Sei Dali, assistente AI di DalziTravel. Genera itinerari di viaggio in formato JSON puro.
OUTPUT: SOLO JSON valido. Zero testo fuori. Niente markdown, niente backtick, niente commenti.

Prima di scrivere il JSON esegui mentalmente 3 fasi:
FASE 1 - ANALISI GEOGRAFICA: identifica le macro-regioni e decidi quale parte visitare nei giorni disponibili.
FASE 2 - CATENA TEMPORALE: costruisci i giorni in sequenza geografica continua come una linea su mappa.
FASE 3 - VALIDAZIONE SLOT: ogni slot deve coprire 2-4 ore reali di attività.

REGOLA 1 - CATENA SEQUENZIALE CONTINUA (ZERO TELETRASPORTO):
La prima attività del Giorno X DEVE partire dall'area dove si e concluso il Giorno X-1.
Non esistono salti geografici notturni (non si dorme a Sogndal e ci si sveglia alle Lofoten).
Se lo spostamento tra due giorni supera 100 km, CREA attivita obbligatoria:
  titolo_attivita: "Viaggio di trasferimento verso [Citta]"
  slot_orario: "Mattina" (o Pomeriggio se necessario)
  tipo_attivita: "trasferimento"
  descrizione: "[X] km in [mezzo], circa [Y] ore. Sosta consigliata a [luogo intermedio]."
  km_dal_precedente e minuti_dal_precedente: valori reali incluse soste.

REGOLA 2 - GEO-FENCE GIORNALIERO (LIMITE KM REALE):
Itinerari URBANI/ISOLA (Lisbona, Gotland, Barcellona, citta singole):
  La somma di tutti km_dal_precedente in un giorno NON supera 30 km totali.
  Ogni tappa e a meno di 15 km dalla precedente.
Itinerari ON-THE-ROAD (Islanda, Norvegia, Scozia, road trip - riconoscibili da "in auto", fiordi, ring road):
  La somma dei km di guida giornalieri NON supera 250 km.
  Giorni di puro trasferimento vanno dichiarati esplicitamente (vedi Regola 1).
  Le soste lungo il percorso devono essere punti reali sulla strada, non deviazioni.
Se tipo non e chiaro, tratta come urbano (limite 30 km).

REGOLA 3 - CONTROLLO MACRO-REGIONI (VIETATO LO SHAKER):
Prima di costruire, valuta se le attrazioni appartengono a macro-regioni raggiungibili nei giorni disponibili.
Combinazioni VIETATE (esempi):
  Norvegia 10 giorni auto: Fiordi del Sud + Isole Lofoten (1800 km A/R - impossibile)
  Islanda 7 giorni: Ring Road completa + Fiordi dell'Ovest (troppo per 7 giorni)
  Giappone 5 giorni: Tokyo + Kyoto + Hiroshima + Osaka + Hakone senza Shinkansen esplicito
Se la richiesta e geograficamente impossibile:
  Scegli UNA macro-regione coerente (la piu richiesta o logistica).
  Aggiungi in consigli_dalzitravel: "Per visitare anche [altra regione] servono almeno X giorni in piu."

REGOLA 4 - BILANCIAMENTO DENSITA ORARIA (SLOT PIENI):
Ogni slot (Mattina, Pomeriggio, Sera) deve coprire 2-4 ORE REALI di attivita.
Se un POI richiede meno di 60 minuti (bar, foto panoramica, monumento piccolo):
  OBBLIGATORIO abbinarlo a 1-2 attrazioni entro 15 minuti a piedi/auto.
  durata_consigliata deve riflettere il totale dello slot (es. "2.5 ore").
  Struttura descrizione: "Visita [POI principale] (45 min) poi [POI secondario] (1 ora)."
Slot sera: cena + passeggiata/aperitivo. Minimo 1.5 ore totali.
VIETATO: slot con una sola attivita da 20-30 minuti.

REGOLE GENERALI:
- nome_viaggio termina con "con DalziTravel".
- Ogni giorno: esattamente 3 slot. Eccezione: giorni di puro trasferimento possono averne 2.
- descrizione: max 15 parole (conta le parole, non superare). suggerimento_insider: max 10 parole. Titoli: 3-5 parole.
- consigli_dalzitravel: max 3 voci, 10 parole ciascuna.
- km_dal_precedente e minuti_dal_precedente: obbligatori dalla seconda attivita in poi.
- Coordinate geografiche: reali e precise.
- Usa dati Tavily per URL, prezzi e orari quando disponibili.

REGOLE RISTORANTI (CRITICHE - applica sempre):
- PRANZO: deve trovarsi entro 1 km a piedi dall'attrazione visitata la mattina. Non spostare in altro quartiere.
- CENA: deve trovarsi entro 1.5 km dall'ultima attrazione del pomeriggio o nell'hotel/alloggio.
- TIPOLOGIA: verifica che il locale sia aperto nell'orario del pasto. Bar serali e club notturni (es. Damas a Lisbona)
  sono aperti solo dopo le 20 - non inserirli come pranzo. Usali solo per lo slot Sera se appropriato.
- NOME SPECIFICO: usa sempre il nome reale di un ristorante verificato nel quartiere corretto.
  Se non hai un nome verificato in quel preciso quartiere, usa ESATTAMENTE: "Pranzo libero a [Nome Quartiere]"
  o "Cena libera a [Nome Quartiere]". MAI "Ristorante locale tipico" o simili.
- SUPERMERCATI VIETATI: 10-11, Bonus, N1, Kronan (Islanda); Lidl, Aldi, Spar (Europa) non sono ristoranti.

COMPATTAZIONE TOKEN (fondamentale per itinerari 7+ giorni):
- Ogni campo testo e gia limitato sopra (15 parole max per descrizione).
- NON ripetere mai la destinazione o il nome del quartiere in ogni descrizione se gia nel titolo_giornata.
- suggerimento_insider: solo info UTILE e non ovvia. Se non hai nulla di specifico, scrivi stringa vuota "".
- Per i giorni di trasferimento, la descrizione puo essere ancora piu breve (8-10 parole).

REGOLA 8 - UNICITA DEI POI (ZERO LOOP RIPETITIVI):
Tieni mentalmente una lista di TUTTI i nomi di ristoranti, bar, attrazioni e attivita gia inseriti.
E TASSATIVAMENTE VIETATO inserire lo stesso nome (anche parziale) piu di UNA volta in tutto l'itinerario.
Prima di aggiungere un POI, verifica che il suo nome non sia gia apparso nei giorni precedenti.
Se non trovi alternative reali, usa descrizioni generiche ("Ristorante locale tipico", "Pub del centro").

VERIFICA NATURA COMMERCIALE DEL POI:
Prima di classificare un luogo come "ristorante" o "bar", verifica mentalmente che sia REALMENTE un locale di ristorazione.
VIETATO classificare come ristorante o bar: supermercati, minimarket, stazioni di servizio, negozi,
farmacie, banche, uffici postali, catene di distribuzione alimentare.
Esempi di errori da non commettere:
  SBAGLIATO: "10-11" come ristorante (e una catena di minimarket islandesi aperta 10-11 ore al giorno)
  SBAGLIATO: "Bonus" come ristorante (e un supermercato islandese low cost)
  SBAGLIATO: "N1" come ristorante (e una catena di stazioni di servizio islandesi)
Se non conosci la natura esatta di un POI, NON inserirlo e usa un'alternativa generica sicura.

REGOLA 9 - MAX 1 MACRO-ATTRAZIONE PER SLOT (ANTI IPER-COMPRESSIONE):
Una macro-attrazione e un sito che da solo richiede 2+ ore (es. Thingvellir, Geysir, Gullfoss,
Colosseo, Sagrada Familia, Louvre, Yellowstone, parchi nazionali, siti UNESCO, cascate famose).
Ogni slot (Mattina o Pomeriggio) puo contenere AL MASSIMO:
  - 1 macro-attrazione principale, OPPURE
  - 2 attrazioni minori molto vicine (entro 1 km a piedi)
VIETATO: inserire Thingvellir + Geysir + Gullfoss nello stesso slot (sono a 60+ km l'una dall'altra).
VIETATO: comprimere un parco nazionale + museo + spiaggia in 3 ore.
Se le macro-attrazioni di una giornata sono 3 (es. Circolo d'Oro), distribuiscile su 3 slot distinti.

REGOLA 10 - MICRO-GEOFENCING DI QUARTIERE (CONFINI PEDONALI):
Quando titolo_giornata o area_geografica indica un quartiere specifico (es. "Alfama", "Bairro Alto",
"Trastevere", "Le Marais", "Eixample"), TUTTE le attivita Mattina e Pomeriggio di quel giorno
devono trovarsi TASSATIVAMENTE entro 1.5 km dal centro di quel quartiere.
La Sera puo essere in un quartiere adiacente (massimo 3 km), es. aperitivo nel quartiere vicino.
VIETATO: inserire il Museo de Arte Antiga (Santos) in una giornata dedicata ad Alfama (distanza: 3.5 km+).
VIETATO: inserire attrazioni in taxi-distanza quando la giornata e dichiarata "a piedi nel quartiere".
Se vuoi includere un'attrazione fuori quartiere, CREA un giorno separato dedicato a quell'area.

SCHEMA JSON (tutti i campi obbligatori):
{"nome_viaggio":"str","destinazione":"str","durata_giorni":0,"tipo_itinerario":"urbano|on-the-road","budget_categoria":"Economico|Medio|Premium|Lusso","budget_stimato":{"minimo":0,"massimo":0,"nota":"str"},"consigli_dalzitravel":["str"],"itinerario":[{"giorno":1,"titolo_giornata":"str","area_geografica":"str","km_totali_giorno":0,"attivita":[{"slot_orario":"Mattina|Pomeriggio|Sera","tipo_attivita":"visita|pasto|trasferimento|attivita","titolo_attivita":"str","descrizione":"str","costo_stimato":{"valore":0,"tipo":"Gratuito|A pagamento|Variabile"},"durata_consigliata":"str","km_dal_precedente":0,"minuti_dal_precedente":0,"link_fonte_web":"str","coordinate_geografiche":{"lat":0.0,"lng":0.0},"suggerimento_insider":"str"}]}]}`;

// ═══════════════════════════════════════════════════════════════════════════════
// TAVILY SEARCH — adattivo per tipo di richiesta
// ═══════════════════════════════════════════════════════════════════════════════

async function searchWithTavily(query, destinazione, mode = "itinerary") {
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) return [];

  let queries;
  if (mode === "itinerary") {
    queries = [
      `${destinazione} attrazioni turistiche prezzi orari`,
      `${destinazione} ristoranti tipici consigliati`,
      `${destinazione} cosa fare sera`,
    ];
  } else {
    // Modalità conversazione: una query mirata alla domanda
    queries = [`${query}`];
  }

  const results = await Promise.allSettled(
    queries.map(q =>
      axios.post("https://api.tavily.com/search", {
        api_key: tavilyKey,
        query: mode === "itinerary" ? `${query} ${q}` : q,
        search_depth: "advanced",
        max_results: mode === "itinerary" ? 5 : 3,
        include_answer: false,
        include_raw_content: false,
      }, { timeout: 12000 })
    )
  );

  const seen = new Set();
  const combined = [];
  for (const r of results) {
    if (r.status === "fulfilled" && Array.isArray(r.value.data?.results)) {
      for (const item of r.value.data.results) {
        if (!seen.has(item.url)) {
          seen.add(item.url);
          combined.push({
            titolo:    item.title || "",
            url:       item.url || "",
            contenuto: (item.content || "").slice(0, 350),
          });
        }
      }
    }
  }
  return combined;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROQ — due modalità: chat libera e JSON strutturato
// ═══════════════════════════════════════════════════════════════════════════════

async function callGroqChat(systemPrompt, messages) {
  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  const client = getGroqClient();

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.7,    // più creativo per la chat
    max_tokens:  1024,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages,
    ],
  });

  const choice = completion.choices[0];
  console.log(`[Groq/chat] finish_reason: ${choice.finish_reason} | tokens: ${completion.usage?.completion_tokens ?? "?"}`);
  return choice.message.content;
}

async function callGroqSinglePart(systemPrompt, userMessage, model) {
  const client = getGroqClient();
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.3,
    max_tokens:  6000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userMessage },
    ],
  });
  const choice = completion.choices[0];
  const tokens = completion.usage?.completion_tokens ?? "?";
  console.log(`[Groq] finish_reason: ${choice.finish_reason} | tokens: ${tokens}`);
  if (choice.finish_reason === "length") {
    throw Object.assign(new Error("OUTPUT_TRUNCATED"), { isTruncated: true });
  }
  return choice.message.content;
}

// Chiama Groq con strategia split automatica per itinerari lunghi (>= 7 giorni)
async function callGroqItinerary(systemPrompt, userMessage, numGiorni = 0) {
  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  const giorni = parseInt(numGiorni) || 0;

  // Itinerari brevi (<= 6 giorni): chiamata singola normale
  if (giorni <= 6) {
    return callGroqSinglePart(systemPrompt, userMessage, model);
  }

  // Itinerari lunghi (7+ giorni): split in due parti
  // Parte 1: giorni 1 → metà
  const meta = Math.ceil(giorni / 2);
  const parte2start = meta + 1;

  const promptParte1 = userMessage +
    `\n\nCOMPITO SPLIT - PARTE 1/2: genera SOLO i giorni da 1 a ${meta} (totale ${meta} giorni).` +
    `\nNel JSON, il campo "durata_giorni" deve essere ${meta} e l'array "itinerario" deve contenere SOLO i giorni 1-${meta}.` +
    `\nIncludi tutti i campi header (nome_viaggio, destinazione, budget_stimato, ecc.) con valori definitivi.` +
    `\nNon aggiungere note su "parte 2" nel JSON.`;

  const promptParte2 = userMessage +
    `\n\nCOMPITO SPLIT - PARTE 2/2: genera SOLO i giorni da ${parte2start} a ${giorni} (${giorni - meta} giorni).` +
    `\nNel JSON, includi SOLO il campo "itinerario" con i giorni numerati da ${parte2start} a ${giorni}.` +
    `\nIl Giorno ${parte2start} deve iniziare geograficamente dove finiva il Giorno ${meta} della Parte 1.` +
    `\nOmetti nome_viaggio, budget_stimato e altri campi header — li forniamo già dalla Parte 1.`;

  console.log(`[Groq/split] Itinerario ${giorni} giorni → split ${meta}+${giorni - meta}`);

  // Esegui le due parti in parallelo per velocità
  const [rawParte1, rawParte2] = await Promise.all([
    callGroqSinglePart(systemPrompt, promptParte1, model),
    callGroqSinglePart(systemPrompt, promptParte2, model),
  ]);

  // Merge: prendi header da parte 1, giorni aggiuntivi da parte 2
  const p1 = JSON.parse(rawParte1);
  let p2;
  try {
    p2 = JSON.parse(rawParte2);
  } catch {
    // Se parte 2 non è parsabile, usa solo parte 1 con warning
    console.warn("[Groq/split] Parte 2 non parsabile, uso solo parte 1");
    p1.consigli_dalzitravel = p1.consigli_dalzitravel || [];
    p1.consigli_dalzitravel.push(`Itinerario generato per ${meta} giorni. Chiedi la seconda parte separatamente.`);
    return JSON.stringify(p1);
  }

  // Unisci gli itinerari: parte2 può avere un wrapper "itinerario" o essere direttamente l'array
  const giorni2 = Array.isArray(p2.itinerario) ? p2.itinerario :
                  Array.isArray(p2) ? p2 : [];

  p1.itinerario = [...(p1.itinerario || []), ...giorni2];
  p1.durata_giorni = giorni;

  console.log(`[Groq/split] Merge completato: ${p1.itinerario.length} giorni totali`);
  return JSON.stringify(p1);
}

function parseJsonFromLLM(raw) {
  let clean = raw.replace(/^[\s\S]*?```(?:json)?\s*/i, "").replace(/```[\s\S]*$/i, "").trim();
  if (!clean.startsWith("{")) clean = raw.trim();
  return JSON.parse(clean);
}

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDAZIONE POST-LLM — rete di sicurezza lato server
// Applica le regole 8-9-10 indipendentemente dal modello
// ═══════════════════════════════════════════════════════════════════════════════

// Lista nera di POI non-ristorativi per tipo (pattern case-insensitive)
const POI_BLACKLIST_PATTERNS = [
  // Catene islandesi
  /\b10[-\s]?11\b/i,
  /\bbonus\s*(supermarke[dt]|market)?\b/i,
  /\bn1\s*(statio[n]?|fuel)?\b/i,
  /\bkronans?\b/i, /\bsamkaup\b/i, /\bh[aá]gb[o]rg\b/i,
  // Supermercati internazionali comuni
  /\b(lidl|aldi|spar|intermarche|carrefour|continente|mercadona|rewe|edeka)\b/i,
  // Stazioni di servizio
  /\b(orkan|shell|esso|bp|total|repsol|agip|eni station)\b/i,
  // Terminali generici
  /\b(minimarke[dt]|supermarke[dt]|convenience store|stazione di servizio|distributore)\b/i,
];

function isBlacklistedPOI(nome) {
  return POI_BLACKLIST_PATTERNS.some(p => p.test(nome || ""));
}

// Pattern locali notturni/bar serali inadatti a pranzo
const NIGHTCLUB_PATTERNS = [
  /\b(club|discoteca|disco|nightclub|lounge bar|cocktail bar)\b/i,
  // Locali noti come bar serali (lista estensibile)
  /\bdamas\b/i,  // Lisbona — bar notturno, non ristorante da pranzo
  /\blux frágil\b/i, /\bpensao amor\b/i,
];

// Verifica se un locale è classificato come notturno e viene proposto a pranzo
function isNightclubAtPranzo(att) {
  if (att.slot_orario !== "Pomeriggio" && att.slot_orario !== "Mattina") return false;
  return NIGHTCLUB_PATTERNS.some(p => p.test(att.titolo_attivita || ""));
}

// Calcola distanza approssimativa in km tra due coordinate (formula Haversine semplificata)
function distanzaKm(lat1, lng1, lat2, lng2) {
  if (!lat1 || !lng1 || !lat2 || !lng2) return null;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function validateItinerario(itin) {
  if (!itin || !Array.isArray(itin.itinerario)) return itin;

  const warnings = [];
  const poiVisti = new Set();

  itin.itinerario.forEach((giorno, gi) => {
    if (!Array.isArray(giorno.attivita)) return;

    // Trova coordinate dell'attrazione principale del giorno (prima non-pasto, non-trasferimento)
    const mainAtt = giorno.attivita.find(a =>
      a.tipo_attivita !== "pasto" && a.tipo_attivita !== "trasferimento" &&
      a.coordinate_geografiche?.lat
    );
    const mainLat = mainAtt?.coordinate_geografiche?.lat;
    const mainLng = mainAtt?.coordinate_geografiche?.lng;
    const quartiere = giorno.area_geografica || "";

    giorno.attivita.forEach((att) => {
      const nome = (att.titolo_attivita || "").trim();
      const nomeKey = nome.toLowerCase().replace(/\s+/g, " ");

      // ── REGOLA 8a: Blacklist POI non-ristorativi ───────────────────────────
      if (isBlacklistedPOI(nome) && att.tipo_attivita === "pasto") {
        warnings.push(`G${gi+1}/${att.slot_orario}: blacklist "${nome}"`);
        att.titolo_attivita = `Pranzo libero a ${quartiere || "zona"}`;
        att.descrizione = `Esplora i ristoranti della zona — chiedi consiglio all'alloggio.`;
        att.link_fonte_web = "";
        att.suggerimento_insider = "Cerca 'ristorante' su Google Maps nella zona.";
        att.coordinate_geografiche = mainLat ? { lat: mainLat, lng: mainLng } : att.coordinate_geografiche;
      }

      // ── REGOLA 8b: Unicità POI (no loop ripetitivi) ────────────────────────
      if (poiVisti.has(nomeKey) && att.tipo_attivita !== "trasferimento") {
        warnings.push(`G${gi+1}/${att.slot_orario}: duplicato "${nome}"`);
        att.titolo_attivita = att.tipo_attivita === "pasto"
          ? `Pranzo libero a ${quartiere || "zona"}`
          : "Tempo libero ed esplorazione autonoma";
        att.descrizione = "Esplora liberamente il quartiere.";
        att.link_fonte_web = "";
      }

      // ── REGOLA FIX-3: Geo-fencing ristoranti (max 1 km dall'attrazione) ───
      if (att.tipo_attivita === "pasto" && mainLat && att.coordinate_geografiche?.lat) {
        const dist = distanzaKm(mainLat, mainLng,
          att.coordinate_geografiche.lat, att.coordinate_geografiche.lng);
        if (dist !== null && dist > 1.5) {
          warnings.push(`G${gi+1}/${att.slot_orario}: pasto "${nome}" a ${dist.toFixed(1)} km — spostato al quartiere`);
          att.titolo_attivita = `Pranzo libero a ${quartiere || "zona"}`;
          att.descrizione = `Diversi ristoranti nelle vicinanze — esplora le opzioni locali.`;
          att.link_fonte_web = "";
          att.coordinate_geografiche = { lat: mainLat, lng: mainLng };
        }
      }

      // ── REGOLA FIX-4: No locali notturni a pranzo ─────────────────────────
      if (isNightclubAtPranzo(att)) {
        warnings.push(`G${gi+1}/${att.slot_orario}: locale notturno a pranzo "${nome}" — sostituito`);
        att.titolo_attivita = `Pranzo libero a ${quartiere || "zona"}`;
        att.descrizione = `Esplora i ristoranti aperti a pranzo nella zona.`;
        att.link_fonte_web = "";
      }

      // ── Aggiungi al set ────────────────────────────────────────────────────
      const nomeKeyFinal = (att.titolo_attivita || "").toLowerCase().replace(/\s+/g, " ");
      if (!nomeKeyFinal.includes("tempo libero") && !nomeKeyFinal.includes("pranzo libero")) {
        poiVisti.add(nomeKeyFinal);
      }
    });
  });

  if (warnings.length > 0) {
    console.warn("[Validate]", warnings.join(" | "));
  }

  return itin;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ESTRAZIONE DESTINAZIONE (invariata)
// ═══════════════════════════════════════════════════════════════════════════════

function estraiDestinazione(testo) {
  const STOPWORDS = new Set([
    "giorni","giorno","notti","notte","settimane","settimana","mesi","mese",
    "budget","basso","medio","alto","lusso","economico","premium",
    "viaggio","vacanza","tour","gita","itinerario","weekend","escape",
    "romantico","romantica","avventura","cultura","culturale","mare","montagna",
    "relax","enogastronomia","gastronomia","natura","arte","storia","storico",
    "famiglia","coppia","amici","solo","low","cost","fast",
    "con","senza","e","di","da","su","tra","fra","ma","o",
    "un","una","uno","il","lo","la","i","gli","le","dei","delle","degli",
  ]);

  const pulito = testo
    .replace(/\b\d+\s*(?:giorni?|notti?|settimane?|mesi?)\b/gi, " ")
    .replace(/\s{2,}/g, " ").trim();

  const matchPrep = pulito.match(
    /\b(?:a|in|nei?|negli|alle?|ai|per)\s+([A-ZÀ-Úa-zà-ú][a-zA-ZÀ-ùà-ú](?:[a-zA-ZÀ-ùà-ú\s]{0,40}?)?)(?=\s*(?:$|,|budget|con|senza|cultura|culturale|mare|montagna|romantico|romantica|avventura|relax|natura|arte|storia|storico|famiglia|coppia|amici|gastronomia|enogastronomia))/i
  );
  if (matchPrep) {
    const startIdx = pulito.indexOf(matchPrep[0]) + matchPrep[0].indexOf(matchPrep[1]);
    const candidate = pulito.slice(startIdx).split(/\s+/)
      .filter(w => !STOPWORDS.has(w.toLowerCase()) && !/^\d+$/.test(w))
      .slice(0, 4).join(" ").trim();
    if (candidate.length >= 2) return candidate;
  }

  const parole = pulito.split(/\s+/).filter(w => !STOPWORDS.has(w.toLowerCase()) && !/^\d+$/.test(w));
  if (parole.length > 0) return parole.slice(0, 3).join(" ").trim();
  return testo.split(" ").slice(0, 3).join(" ");
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES — AUTENTICAZIONE
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/auth/register — crea nuovo account con PIN
app.post("/api/auth/register", (req, res) => {
  const { pin, name: reqName } = req.body;
  if (!pin || !/^\d{4,6}$/.test(String(pin))) {
    return res.status(400).json({ error: "Il PIN deve essere di 4-6 cifre numeriche." });
  }

  const users = readUsers();

  // Nome scelto dall'utente o generato casualmente
  let name = (reqName || "").trim().replace(/[^a-zA-ZÀ-ùà-ú0-9 ]/g, "").trim().slice(0, 24);
  if (name.length < 2) name = generateUsername();

  // Verifica unicità (case-insensitive)
  if (users.some(u => u.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: `Il nome "${name}" è già usato. Scegline un altro.` });
  }

  const id      = generateId();
  const pinHash = hashPin(String(pin));
  users.push({ id, name, pinHash, createdAt: new Date().toISOString() });
  writeUsers(users);

  const token = `${id}:${pinHash}`;
  console.log(`[Auth] Nuovo utente: ${name} (${id})`);
  res.json({ success: true, user: { id, name }, token });
});

// POST /api/auth/login — login con nome + PIN
app.post("/api/auth/login", (req, res) => {
  const { name, pin } = req.body;
  if (!name || !pin) return res.status(400).json({ error: "Nome e PIN obbligatori." });

  const users   = readUsers();
  const pinHash = hashPin(String(pin));
  const user    = users.find(u => u.name.toLowerCase() === name.toLowerCase() && u.pinHash === pinHash);

  if (!user) return res.status(401).json({ error: "Nome o PIN non corretti." });

  const token = `${user.id}:${pinHash}`;
  console.log(`[Auth] Login: ${user.name}`);
  res.json({ success: true, user: { id: user.id, name: user.name }, token });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES — CHAT
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/chats — lista chat dell'utente
app.get("/api/chats", requireAuth, (req, res) => {
  const chats = readChats(req.user.id);
  // Ritorna solo metadati (no messages) per la sidebar
  const summary = chats.map(c => ({
    id:        c.id,
    title:     c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    msgCount:  c.messages.length,
  }));
  res.json({ success: true, chats: summary });
});

// GET /api/chats/:chatId — singola chat con messaggi
app.get("/api/chats/:chatId", requireAuth, (req, res) => {
  const chats = readChats(req.user.id);
  const chat  = chats.find(c => c.id === req.params.chatId);
  if (!chat) return res.status(404).json({ error: "Chat non trovata." });
  res.json({ success: true, chat });
});

// POST /api/chats — crea nuova chat
app.post("/api/chats", requireAuth, (req, res) => {
  const chats = readChats(req.user.id);
  const newChat = {
    id:        generateId(),
    title:     req.body.title || "Nuova chat",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages:  [],
  };
  chats.unshift(newChat);
  writeChats(req.user.id, chats);
  res.json({ success: true, chat: newChat });
});

// DELETE /api/chats/:chatId — elimina chat
app.delete("/api/chats/:chatId", requireAuth, (req, res) => {
  let chats = readChats(req.user.id);
  chats = chats.filter(c => c.id !== req.params.chatId);
  writeChats(req.user.id, chats);
  res.json({ success: true });
});

// PATCH /api/chats/:chatId/title — rinomina chat
app.patch("/api/chats/:chatId/title", requireAuth, (req, res) => {
  const chats = readChats(req.user.id);
  const chat  = chats.find(c => c.id === req.params.chatId);
  if (!chat) return res.status(404).json({ error: "Chat non trovata." });
  chat.title     = req.body.title || chat.title;
  chat.updatedAt = new Date().toISOString();
  writeChats(req.user.id, chats);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE PRINCIPALE — POST /api/chats/:chatId/message
// Invia un messaggio nella chat, ottieni risposta AI, salva tutto
// ═══════════════════════════════════════════════════════════════════════════════

app.post("/api/chats/:chatId/message", requireAuth, aiLimiter, async (req, res) => {
  try {
    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: "GROQ_API_KEY non configurata." });
    }

    const { messaggio } = req.body;
    if (!messaggio || typeof messaggio !== "string") {
      return res.status(400).json({ error: "Campo 'messaggio' mancante." });
    }
    const messaggioClean = messaggio.trim().slice(0, 1000);
    if (messaggioClean.length < 2) return res.status(400).json({ error: "Messaggio troppo breve." });

    // Carica chat
    const chats = readChats(req.user.id);
    const chat  = chats.find(c => c.id === req.params.chatId);
    if (!chat) return res.status(404).json({ error: "Chat non trovata." });

    // Classifica intent
    const intent = classifyIntent(messaggioClean, chat.messages);
    console.log(`[Chat] user=${req.user.name} intent=${intent} msg="${messaggioClean.slice(0, 60)}"`);

    // Aggiungi messaggio utente alla chat
    const userMsg = {
      id:        generateId(),
      role:      "user",
      content:   messaggioClean,
      timestamp: new Date().toISOString(),
    };
    chat.messages.push(userMsg);

    let assistantMsg;

    // ── BRANCH A: ITINERARIO STRUTTURATO ─────────────────────────────────────
    if (intent === "itinerario") {
      const destinazione = estraiDestinazione(messaggioClean);
      console.log(`[Itinerario] destinazione="${destinazione}"`);

      // Ricerca Tavily
      let tavilyData = [];
      if (process.env.TAVILY_API_KEY) {
        try {
          tavilyData = await searchWithTavily(messaggioClean, destinazione, "itinerary");
          console.log(`[Tavily] ${tavilyData.length} risultati`);
        } catch (e) {
          console.warn("[Tavily] Fallito:", e.message);
        }
      }

      const webContext = tavilyData.length > 0
        ? `\n\n=== DATI WEB TAVILY ===\n${tavilyData.map((r, i) =>
            `[${i+1}] ${r.titolo}\nURL: ${r.url}\n${r.contenuto}`).join("\n\n")}\n=== FINE DATI WEB ===`
        : "\n\n[Nessun dato web. Usa la tua conoscenza geografica precisa.]";

      // Rileva tipo itinerario per applicare il geo-fence corretto (Regola 2)
      const isOnTheRoad = /\b(auto|macchina|road\s*trip|ring\s*road|fiordi|islanda|norvegia|scozia|patagonia|namibia|australia|canada)\b/i.test(messaggioClean);
      const tipoItinerario = isOnTheRoad ? "on-the-road" : "urbano";
      const numGiorni = messaggioClean.match(/\b(\d+)\s*giorni?\b/i)?.[1] || "?";

      const userMessage =
        `RICHIESTA: "${messaggioClean}"` +
        `\nDESTINAZIONE IDENTIFICATA: ${destinazione}` +
        `\nTIPO ITINERARIO: ${tipoItinerario} — geo-fence ${isOnTheRoad ? "max 250 km/giorno" : "max 30 km/giorno"}` +
        `\nDURATA: ${numGiorni} giorni` +
        webContext +
        `\n\nISTRUZIONI CRITICHE:` +
        `\n1. CATENA SEQUENZIALE: ogni giorno inizia ESATTAMENTE dove finisce il precedente.` +
        `\n2. Se spostamento tra giorni > 100 km: crea attivita "Viaggio di trasferimento verso X" nello slot Mattina.` +
        `\n3. MACRO-REGIONI: se la richiesta copre zone incompatibili con ${numGiorni} giorni, scegli UNA zona e segnalalo in consigli_dalzitravel.` +
        `\n4. SLOT PIENI: ogni slot = 2-4 ore reali. Se POI dura < 60 min, abbinalo a un secondo POI entro 15 min.` +
        `\n5. UNICITA: nessun nome di ristorante/attrazione si ripete in tutto l'itinerario.` +
        `\n6. NO SUPERMERCATI/STAZIONI come ristoranti. In Islanda: 10-11, Bonus, N1, Kronan sono vietati come POI pasto.` +
        `\n7. MAX 1 MACRO-ATTRAZIONE per slot. Circolo d'Oro = 3 slot (Thingvellir mattina, Geysir pomeriggio, Gullfoss sera).` +
        `\n8. MICRO-GEOFENCING: se la giornata e dedicata a un quartiere, tutti i POI mattina/pomeriggio entro 1.5 km dal centro.` +
        `\n9. RISTORANTI GEO-FENCED: pranzo entro 1 km dall'attrazione mattina. Non spostare l'utente in altro quartiere per mangiare.` +
        `\n10. TIPOLOGIA LOCALI: bar serali, club notturni, locali aperti solo dopo le 20 sono VIETATI per slot Mattina e Pomeriggio.` +
        `\n11. NO PLACEHOLDER GENERICI: mai "Ristorante locale tipico". Se no nome specifico verificato nel quartiere: scrivi "Pranzo libero a [Quartiere]".` +
        `\n12. Rispondi SOLO con il JSON.`;

      const llmRaw = await callGroqItinerary(ITINERARY_SYSTEM_PROMPT, userMessage, numGiorni);
      // Valida lato server — rete di sicurezza indipendente dal modello (Regole 8-9-10)
      const itinerarioRaw = parseJsonFromLLM(llmRaw);
      const itinerario    = validateItinerario(itinerarioRaw);

      // Auto-titolo chat se è il primo messaggio
      if (chat.messages.length === 1) {
        chat.title = itinerario.nome_viaggio?.replace(" con DalziTravel", "") || messaggioClean.slice(0, 40);
      }

      assistantMsg = {
        id:           generateId(),
        role:         "assistant",
        tipo:         "itinerario",
        content:      `Ecco il tuo itinerario per ${itinerario.destinazione}! 🗺️`,
        data:         itinerario,
        timestamp:    new Date().toISOString(),
      };

    // ── BRANCH B: CONVERSAZIONE LIBERA ───────────────────────────────────────
    } else {
      // Costruisci cronologia per il modello (max ultimi 10 messaggi per token budget)
      const historyForGroq = chat.messages
        .slice(-11, -1) // escludi l'ultimo (quello appena aggiunto)
        .filter(m => m.role === "user" || (m.role === "assistant" && m.tipo !== "itinerario"))
        .map(m => ({
          role:    m.role,
          content: m.role === "assistant" ? m.content : m.content,
        }));

      // Ricerca Tavily mirata se la domanda sembra richiedere info aggiornate
      const needsSearch = /\b(costo|prezzo|crocier|volo|hotel|meteo|clima|visto|documento|covid|moneta|valuta|migliore?\s+period|quando\s+andare)\b/i.test(messaggioClean);
      let tavilyContext = "";
      if (needsSearch && process.env.TAVILY_API_KEY) {
        try {
          const results = await searchWithTavily(messaggioClean, messaggioClean, "chat");
          if (results.length > 0) {
            tavilyContext = `\n\n[Dati web aggiornati]\n${results.map(r => `${r.titolo}: ${r.contenuto}`).join("\n")}`;
          }
        } catch (e) {
          console.warn("[Tavily/chat] Fallito:", e.message);
        }
      }

      const messagesForGroq = [
        ...historyForGroq,
        { role: "user", content: messaggioClean + tavilyContext },
      ];

      const risposta = await callGroqChat(CHAT_SYSTEM_PROMPT, messagesForGroq);

      // Auto-titolo chat al primo messaggio
      if (chat.messages.length === 1) {
        chat.title = messaggioClean.slice(0, 45) + (messaggioClean.length > 45 ? "…" : "");
      }

      assistantMsg = {
        id:        generateId(),
        role:      "assistant",
        tipo:      "testo",
        content:   risposta,
        timestamp: new Date().toISOString(),
      };
    }

    // Salva risposta AI e aggiorna chat
    chat.messages.push(assistantMsg);
    chat.updatedAt = new Date().toISOString();
    writeChats(req.user.id, chats);

    res.json({ success: true, message: assistantMsg, chatTitle: chat.title });

  } catch (err) {
    const status  = err.status || err.response?.status;
    const apiBody = JSON.stringify(err.error || err.response?.data || {}).slice(0, 300);
    console.error("[Server Error]", { message: err.message, httpStatus: status, apiResponse: apiBody });

    if (err.isTruncated) return res.status(422).json({ error: "Risposta troppo lunga. Prova con meno giorni o una destinazione più specifica." });
    if (status === 401) return res.status(500).json({ error: "Chiave Groq non valida. Controlla GROQ_API_KEY." });
    if (status === 429) return res.status(429).json({ error: "Rate limit Groq. Riprova tra qualche secondo." });
    if (err.code === "ECONNABORTED") return res.status(504).json({ error: "Timeout. Riprova." });

    res.status(500).json({
      error:  "Errore del server DalziTravel.",
      detail: process.env.NODE_ENV === "development" ? `${err.message} | ${apiBody}` : undefined,
    });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES — IMPOSTAZIONI ACCOUNT
// ═══════════════════════════════════════════════════════════════════════════════

// PATCH /api/settings/name — cambia nome utente
app.patch("/api/settings/name", requireAuth, (req, res) => {
  const { name: newName } = req.body;
  if (!newName) return res.status(400).json({ error: "Nome obbligatorio." });

  let name = newName.trim().replace(/[^a-zA-ZÀ-ùà-ú0-9 ]/g, "").trim().slice(0, 24);
  if (name.length < 2) return res.status(400).json({ error: "Nome troppo breve (min 2 caratteri)." });

  const users = readUsers();
  const idx   = users.findIndex(u => u.id === req.user.id);

  // Unicità
  if (users.some((u, i) => i !== idx && u.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: `Il nome "${name}" è già in uso.` });
  }

  users[idx].name = name;
  writeUsers(users);
  res.json({ success: true, name });
});

// PATCH /api/settings/pin — cambia PIN (richiede vecchio PIN)
app.patch("/api/settings/pin", requireAuth, (req, res) => {
  const { oldPin, newPin } = req.body;
  if (!oldPin || !newPin) return res.status(400).json({ error: "oldPin e newPin obbligatori." });
  if (!/^\d{4,6}$/.test(String(newPin))) return res.status(400).json({ error: "Il nuovo PIN deve essere 4-6 cifre." });

  const users   = readUsers();
  const idx     = users.findIndex(u => u.id === req.user.id);
  const oldHash = hashPin(String(oldPin));

  if (users[idx].pinHash !== oldHash) {
    return res.status(401).json({ error: "Vecchio PIN non corretto." });
  }

  const newHash     = hashPin(String(newPin));
  users[idx].pinHash = newHash;
  writeUsers(users);

  // Emetti nuovo token
  const token = `${req.user.id}:${newHash}`;
  res.json({ success: true, token });
});

// GET /api/settings/stats — statistiche account
app.get("/api/settings/stats", requireAuth, (req, res) => {
  const chats    = readChats(req.user.id);
  const msgCount = chats.reduce((acc, c) => acc + c.messages.length, 0);
  const itinCount = chats.reduce((acc, c) =>
    acc + c.messages.filter(m => m.tipo === "itinerario").length, 0);

  res.json({
    success:    true,
    username:   req.user.name,
    joinedAt:   req.user.createdAt,
    chatCount:  chats.length,
    msgCount,
    itinCount,
  });
});

// DELETE /api/settings/account — elimina account e tutti i dati
app.delete("/api/settings/account", requireAuth, (req, res) => {
  const users = readUsers().filter(u => u.id !== req.user.id);
  writeUsers(users);
  const f = chatsFile(req.user.id);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  console.log(`[Auth] Account eliminato: ${req.user.name}`);
  res.json({ success: true });
});


// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE: METEO — GET /api/weather?dest=Roma&days=5
// ═══════════════════════════════════════════════════════════════════════════════
app.get("/api/weather", requireAuth, async (req, res) => {
  const { dest, days } = req.query;
  if (!dest) return res.status(400).json({ error: "Parametro 'dest' obbligatorio." });

  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) return res.json({ success: false, reason: "no_key", message: "Chiave OpenWeather non configurata." });

  try {
    // Geocoding
    const geoRes = await axios.get("https://api.openweathermap.org/geo/1.0/direct", {
      params: { q: dest, limit: 1, appid: apiKey },
      timeout: 8000,
    });
    if (!geoRes.data?.length) return res.json({ success: false, reason: "not_found" });

    const { lat, lon, name, country } = geoRes.data[0];

    // Previsioni 5 giorni (ogni 3 ore → prendiamo le 12:00 di ogni giorno)
    const forecastRes = await axios.get("https://api.openweathermap.org/data/2.5/forecast", {
      params: { lat, lon, appid: apiKey, units: "metric", lang: "it", cnt: 40 },
      timeout: 8000,
    });

    const dayMap = {};
    forecastRes.data.list.forEach(item => {
      const date = item.dt_txt.slice(0, 10);
      const hour = item.dt_txt.slice(11, 13);
      if (!dayMap[date] || hour === "12") {
        dayMap[date] = {
          date,
          temp_min: Math.round(item.main.temp_min),
          temp_max: Math.round(item.main.temp_max),
          descrizione: item.weather[0].description,
          icona: item.weather[0].icon,
          pioggia: Math.round((item.pop || 0) * 100),
        };
      }
    });

    const maxDays = Math.min(parseInt(days) || 5, 7);
    const previsioni = Object.values(dayMap).slice(0, maxDays);

    res.json({ success: true, citta: `${name}, ${country}`, previsioni });
  } catch (e) {
    console.error("[Weather]", e.message);
    res.status(502).json({ success: false, reason: "api_error", message: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE: EXPORT PDF — POST /api/itinerario/pdf
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/api/itinerario/pdf", requireAuth, (req, res) => {
  const { itinerario: itin } = req.body;
  if (!itin || !Array.isArray(itin.itinerario)) {
    return res.status(400).json({ error: "Dati itinerario mancanti." });
  }

  try {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="dalzitravel-${(itin.destinazione || "itinerario").replace(/\s+/g, "-").toLowerCase()}.pdf"`);
    doc.pipe(res);

    // ── Header ────────────────────────────────────────────────────────────────
    doc.fontSize(24).fillColor("#0ea5e9").text("DalziTravel", { align: "center" });
    doc.fontSize(16).fillColor("#1e293b").text(itin.nome_viaggio || "Itinerario", { align: "center" });
    doc.moveDown(0.5);

    // ── Info generali ──────────────────────────────────────────────────────────
    doc.fontSize(10).fillColor("#64748b")
       .text(`Destinazione: ${itin.destinazione || "N/D"}  |  Durata: ${itin.durata_giorni || "?"} giorni  |  Budget: ${itin.budget_categoria || "N/D"}`, { align: "center" });

    if (itin.budget_stimato?.minimo) {
      doc.text(`Stima costi: €${itin.budget_stimato.minimo}–€${itin.budget_stimato.massimo} — ${itin.budget_stimato.nota || ""}`, { align: "center" });
    }

    doc.moveDown();
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#e2e8f0").stroke();
    doc.moveDown();

    // ── Consigli ───────────────────────────────────────────────────────────────
    if (itin.consigli_dalzitravel?.length) {
      doc.fontSize(11).fillColor("#0ea5e9").text("💡 Consigli DalziTravel");
      itin.consigli_dalzitravel.forEach(c => {
        doc.fontSize(9).fillColor("#475569").text(`→ ${c}`, { indent: 10 });
      });
      doc.moveDown();
    }

    // ── Giorni ────────────────────────────────────────────────────────────────
    const SLOT_COLORS = { Mattina: "#f59e0b", Pomeriggio: "#22c55e", Sera: "#8b5cf6" };
    const SLOT_ICONS  = { Mattina: "🌅", Pomeriggio: "☀️", Sera: "🌙" };

    (itin.itinerario || []).forEach((giorno) => {
      // Controlla spazio pagina
      if (doc.y > 700) doc.addPage();

      doc.fontSize(13).fillColor("#0f172a")
         .text(`Giorno ${giorno.giorno || ""} — ${giorno.titolo_giornata || ""}`, { underline: false });
      if (giorno.area_geografica) {
        doc.fontSize(9).fillColor("#94a3b8").text(`📍 ${giorno.area_geografica}`);
      }
      doc.moveDown(0.3);

      (giorno.attivita || []).forEach((att) => {
        if (doc.y > 720) doc.addPage();

        const icon  = SLOT_ICONS[att.slot_orario]  || "";
        const color = SLOT_COLORS[att.slot_orario] || "#334155";

        doc.fontSize(10).fillColor(color)
           .text(`${icon} ${att.slot_orario?.toUpperCase() || ""}`, { continued: true })
           .fillColor("#1e293b")
           .text(`  ${att.titolo_attivita || ""}`);

        doc.fontSize(8.5).fillColor("#475569")
           .text(att.descrizione || "", { indent: 16 });

        const info = [];
        if (att.durata_consigliata) info.push(`⏱ ${att.durata_consigliata}`);
        if (att.costo_stimato?.valore != null) info.push(`€${att.costo_stimato.valore} (${att.costo_stimato.tipo || ""})`);
        if (att.km_dal_precedente > 0) info.push(`🗺 ${att.km_dal_precedente} km · ${att.minuti_dal_precedente} min`);
        if (info.length) {
          doc.fontSize(8).fillColor("#94a3b8").text(info.join("   "), { indent: 16 });
        }
        if (att.suggerimento_insider) {
          doc.fontSize(8).fillColor("#7dd3fc").text(`💎 ${att.suggerimento_insider}`, { indent: 16 });
        }
        doc.moveDown(0.3);
      });

      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#f1f5f9").stroke();
      doc.moveDown(0.5);
    });

    // ── Footer ────────────────────────────────────────────────────────────────
    doc.fontSize(8).fillColor("#94a3b8").text(
      `Generato da DalziTravel con Groq AI · ${new Date().toLocaleDateString("it-IT")}`,
      { align: "center" }
    );

    doc.end();
  } catch (e) {
    console.error("[PDF]", e.message);
    if (!res.headersSent) res.status(500).json({ error: "Errore generazione PDF." });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE: CONDIVISIONE PUBBLICA — GET/POST /api/share
// ═══════════════════════════════════════════════════════════════════════════════

const SHARES_FILE = path.join(DATA_DIR, "shares.json");
function readShares() {
  try { return JSON.parse(fs.readFileSync(SHARES_FILE, "utf8")); } catch { return {}; }
}
function writeShares(s) { fs.writeFileSync(SHARES_FILE, JSON.stringify(s, null, 2)); }

// Crea link di condivisione
app.post("/api/share", requireAuth, (req, res) => {
  const { itinerario, chatId } = req.body;
  if (!itinerario) return res.status(400).json({ error: "itinerario obbligatorio." });

  const shares = readShares();
  const shareId = generateId();
  shares[shareId] = {
    itinerario,
    chatId: chatId || null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 giorni
    views: 0,
  };
  writeShares(shares);
  res.json({ success: true, shareId, url: `/share/${shareId}` });
});

// Leggi itinerario condiviso (pubblico, no auth)
app.get("/api/share/:shareId", (req, res) => {
  const shares = readShares();
  const share  = shares[req.params.shareId];
  if (!share) return res.status(404).json({ error: "Link non trovato o scaduto." });

  // Controlla scadenza
  if (new Date(share.expiresAt) < new Date()) {
    delete shares[req.params.shareId];
    writeShares(shares);
    return res.status(410).json({ error: "Link scaduto (30 giorni)." });
  }

  share.views++;
  writeShares(shares);
  res.json({ success: true, itinerario: share.itinerario, createdAt: share.createdAt });
});

// ─── Route: Debug ─────────────────────────────────────────────────────────────
app.get("/api/debug", (_req, res) => {
  const mask = v => v ? `${v.slice(0, 8)}…(${v.length} chars)` : "❌ MANCANTE";
  const users = readUsers();
  res.json({
    version:    "2.2.0",
    node_env:     process.env.NODE_ENV || "non impostato",
    groq_key:     mask(process.env.GROQ_API_KEY),
    groq_model:   process.env.GROQ_MODEL || "llama-3.3-70b-versatile (default)",
    tavily_key:   mask(process.env.TAVILY_API_KEY),
    utenti_totali: users.length,
    data_dir:     DATA_DIR,
  });
});

// ─── Route: Health ────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "DalziTravel API", version:    "2.2.0", timestamp: new Date().toISOString() });
});


// ─── Route: Config pubblica (no segreti) ─────────────────────────────────────
// Espone solo la chiave Maps (opzionale) — MAI GROQ o TAVILY key
app.get("/api/config", (_req, res) => {
  res.json({
    mapsKey: process.env.GOOGLE_MAPS_KEY || null,
  });
});

// ─── Catch-all SPA ───────────────────────────────────────────────────────────
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✈️  DalziTravel v2.2.0 — porta ${PORT}`);
  console.log(`   Groq key    : ${process.env.GROQ_API_KEY   ? "✓" : "✗ MANCANTE"}`);
  console.log(`   Tavily key  : ${process.env.TAVILY_API_KEY ? "✓" : "✗ MANCANTE"}`);
  console.log(`   Data dir    : ${DATA_DIR}`);
  console.log(`   Utenti      : ${readUsers().length} registrati\n`);
});
