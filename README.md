# ✈️ DalziTravel

> **Assistente AI conversazionale per la pianificazione di viaggi.**  
> Genera itinerari dettagliati con mappa interattiva, risponde a qualsiasi domanda di viaggio, supporta più utenti con chat persistenti.

![Version](https://img.shields.io/badge/versione-2.2.0-0ea5e9?style=for-the-badge)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Groq](https://img.shields.io/badge/LLM-Groq-f55036?style=for-the-badge)
![Railway](https://img.shields.io/badge/Deploy-Railway-6B00D7?style=for-the-badge&logo=railway&logoColor=white)

---

## 📋 Indice

1. [Panoramica](#-panoramica)
2. [Struttura del progetto](#-struttura-del-progetto)
3. [Stack tecnologico](#-stack-tecnologico)
4. [Installazione locale](#-installazione-locale)
5. [Variabili d'ambiente](#-variabili-dambiente)
6. [Deploy su Railway](#-deploy-su-railway)
7. [API Reference](#-api-reference)
8. [Funzionalità principali](#-funzionalità-principali)
9. [Sistema di mappe](#-sistema-di-mappe)
10. [Bug risolti](#-bug-risolti)
11. [Roadmap](#-roadmap)

---

## 🌍 Panoramica

DalziTravel è una **Progressive Web App (PWA)** mobile-first che combina un LLM veloce (Groq) con ricerca web in tempo reale (Tavily) per offrire:

- **Assistente conversazionale completo** — risponde a qualsiasi domanda di viaggio (crociere, visti, clima, valigia, confronto destinazioni…)
- **Generazione itinerari strutturati** — piani giornalieri con slot Mattina/Pomeriggio/Sera, geo-clustering anti yo-yo, distanze tra tappe
- **Mappa interattiva Leaflet** — visualizza il percorso giornaliero o l'intero itinerario, marker colorati per fascia oraria, link diretto a Google Maps
- **Multiutente con PIN** — ogni utente sceglie il proprio nome e un PIN cifrato SHA-256; chat persistenti su file JSON
- **Installabile come app** — manifest PWA, service worker, icone per tutte le dimensioni

---

## 📁 Struttura del progetto

```
dalzitravel/
│
├── server.js                   # Entry point Express — routing, auth, Groq, Tavily
├── package.json                # Dipendenze + script build/start
├── Procfile                    # web: npm run build && node server.js (Railway)
├── railway.json                # Build command + healthcheck Railway
├── .env.example                # Template variabili d'ambiente
├── .gitignore
├── README.md
│
├── src/
│   └── input.css               # Tailwind CSS v4 sorgente con token custom
│
├── scripts/
│   └── generate-icons.js       # Genera icone PNG (any + maskable) via sharp
│
└── public/                     # Root statica servita da Express
    ├── index.html              # SPA — chat UI, auth, mappa, impostazioni
    ├── manifest.json           # PWA manifest
    ├── sw.js                   # Service Worker (Cache First + Network Only per API)
    ├── css/
    │   └── styles.css          # Tailwind CSS compilato e minificato
    └── icons/                  # 8 icone PNG "any" + 8 "maskable" + 2 screenshot
```

---

## 🛠 Stack tecnologico

| Layer | Tecnologia | Dettaglio |
|---|---|---|
| Backend | Node.js 18+ + Express 4 | Server, auth, orchestrazione API |
| LLM | Groq `llama-3.3-70b-versatile` | Generazione itinerari JSON + chat libera |
| Ricerca web | Tavily Search API | Dati aggiornati su attrazioni, prezzi, orari |
| Mappe | Leaflet.js 1.9.4 + OpenStreetMap | Mappa interattiva gratuita, no key richiesta |
| Frontend | HTML5 + Tailwind CSS v4 (compilato) | UI responsive mobile-first |
| Persistenza | File JSON in `data/` | Nessun DB esterno |
| PWA | manifest.json + Service Worker | Installabile su iOS/Android/desktop |
| Deploy | Railway (Nixpacks) | Auto-deploy da Git |

---

## 💻 Installazione locale

### Prerequisiti

- Node.js v18+
- Chiave API **Groq** → [console.groq.com/keys](https://console.groq.com/keys) (gratuita)
- Chiave API **Tavily** → [app.tavily.com](https://app.tavily.com) (1000 ricerche/mese gratis)

### Passi

```bash
# 1. Entra nella cartella
cd dalzitravel

# 2. Installa dipendenze
npm install

# 3. Configura variabili d'ambiente
cp .env.example .env
# → Apri .env e compila GROQ_API_KEY e TAVILY_API_KEY

# 4. Build CSS + icone
npm run build

# 5. Avvia
npm start          # produzione
npm run dev        # sviluppo con auto-reload (nodemon)
```

App disponibile su `http://localhost:3000`

---

## 🔐 Variabili d'ambiente

| Variabile | Obbligatoria | Default | Descrizione |
|---|---|---|---|
| `GROQ_API_KEY` | ✅ Sì | — | Chiave API Groq |
| `GROQ_MODEL` | No | `llama-3.3-70b-versatile` | Modello Groq |
| `TAVILY_API_KEY` | ✅ Sì | — | Chiave Tavily Search |
| `GOOGLE_MAPS_KEY` | No | `null` | Key opzionale per link Google Maps embed |
| `PORT` | No | `3000` | Railway la imposta automaticamente |
| `NODE_ENV` | No | `development` | `production` nasconde i dettagli degli errori |

> **Sicurezza:** `GROQ_API_KEY` e `TAVILY_API_KEY` non vengono mai esposte al frontend. Solo `GOOGLE_MAPS_KEY` (opzionale) transita via `/api/config`.

---

## 🚀 Deploy su Railway

### 1. Crea il progetto

1. Vai su [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
2. Seleziona il repository `dalzitravel`
3. Railway rileva Node.js automaticamente via Nixpacks

### 2. Variabili d'ambiente su Railway

Tab **Variables** del servizio → aggiungi:

```
GROQ_API_KEY     = gsk_xxxxxxxxxxxxxxxxxxxxx
TAVILY_API_KEY   = tvly-xxxxxxxxxxxxxxxxxxxxx
GROQ_MODEL       = llama-3.3-70b-versatile
NODE_ENV         = production
```

> `PORT` viene impostata automaticamente da Railway — non aggiungerla.

### 3. Build e start

`railway.json` istruisce Railway a eseguire:
```
Build:  npm install && npm run build
Start:  node server.js
Health: GET /api/health
```

### 4. Verifica

```
GET https://tuo-progetto.up.railway.app/api/health
→ { "status": "ok", "version": "2.2.0" }
```

---

## 📡 API Reference

### Auth

| Metodo | Endpoint | Body | Descrizione |
|---|---|---|---|
| POST | `/api/auth/register` | `{name, pin}` | Crea account (nome scelto dall'utente) |
| POST | `/api/auth/login` | `{name, pin}` | Login, restituisce token |

Tutte le route protette richiedono header `X-Auth: userId:pinHash`.

### Chat

| Metodo | Endpoint | Descrizione |
|---|---|---|
| GET | `/api/chats` | Lista chat dell'utente (metadati) |
| POST | `/api/chats` | Crea nuova chat |
| GET | `/api/chats/:id` | Chat completa con messaggi |
| DELETE | `/api/chats/:id` | Elimina chat |
| PATCH | `/api/chats/:id/title` | Rinomina chat |
| POST | `/api/chats/:id/message` | Invia messaggio, ricevi risposta AI |

### Impostazioni

| Metodo | Endpoint | Descrizione |
|---|---|---|
| GET | `/api/settings/stats` | Statistiche account |
| PATCH | `/api/settings/name` | Cambia nome utente |
| PATCH | `/api/settings/pin` | Cambia PIN (richiede vecchio PIN) |
| DELETE | `/api/settings/account` | Elimina account e tutti i dati |

### Utility

| Metodo | Endpoint | Descrizione |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/config` | Configurazione pubblica (chiave Maps opzionale) |
| GET | `/api/debug` | Info server (solo in development) |

---

## ✨ Funzionalità principali

### Assistente conversazionale (Modello 3)

Il backend classifica automaticamente ogni messaggio:

- **Intent `itinerario`** → ricerca Tavily (3 query parallele) + Groq JSON mode (`response_format: json_object`, `max_tokens: 6000`)
- **Intent `conversazione`** → risposta libera Groq con cronologia ultimi 10 messaggi + Tavily mirato se la domanda riguarda prezzi/meteo/visti

### Geo-clustering anti yo-yo

Il system prompt impone:
- Un'unica area geografica per giornata (raggio max 15 km)
- Percorso lineare A→B→C, mai A→B lontano→ritorno A
- `km_dal_precedente` e `minuti_dal_precedente` obbligatori
- POI oltre 20 km dal cluster giornaliero vengono scartati

### Multiutente con PIN

- Nome scelto dall'utente (2-24 caratteri, validato lato server)
- PIN 4-6 cifre cifrato SHA-256 con salt fisso
- Token sessione `userId:pinHash` in header `X-Auth`
- Persistenza: `data/users.json` + `data/chats_<userId>.json`
- Impostazioni: cambia nome, cambia PIN, statistiche, elimina account

---

## 🗺 Sistema di mappe

La mappa è costruita con **Leaflet.js + OpenStreetMap** (gratuiti, nessuna chiave richiesta).

### Caratteristiche

- **Tema scuro** — tile OSM con filtro CSS `brightness(.85) saturate(.7) hue-rotate(185deg)`
- **Marker colorati per slot orario** — 🌅 giallo (Mattina), ☀️ verde (Pomeriggio), 🌙 viola (Sera)
- **Due viste intercambiabili:**
  - *Percorso* — solo le tappe del giorno selezionato con linea tratteggiata
  - *Tutto l'itinerario* — tutti i giorni sovrapposti, numerati per giorno
- **Popup informativi** — nome attività, descrizione, costo, link "Apri in Google Maps"
- **Fix mappa grigia** — `map.invalidateSize()` chiamato quando l'accordion si apre
- **Nessuna chiave API obbligatoria** — `GOOGLE_MAPS_KEY` opzionale, usata solo per i link di navigazione

---

## 🐛 Bug risolti (v2.2.0)

| # | Bug | Causa | Fix |
|---|---|---|---|
| 1 | Accordion giorni non cliccabile | `onclick="toggleDay(this)"` in stringa HTML — `this` puntava al figlio SVG | `addEventListener` bindato dopo inserimento nel DOM |
| 2 | Chevron non ruotava | Rotazione CSS via `aria-expanded` ignorata su Safari iOS | `chevron.style.transform` impostato direttamente via JS |
| 3 | Secondo set PIN visibile subito | `#newPinDots` senza `display:none` iniziale | CSS `#newPinDots{display:none}` + mostrato solo alla fase 2 |
| 4 | `onclick` inline su bottoni | Rompeva in CSP strict, non testabile | Tutti i bottoni usano `addEventListener` con `id` dedicato |
| 5 | XSS potenziale in `fmtText` | Markdown applicato prima di `esc()` | `esc()` sempre eseguito per primo |
| 6 | Toast sovrapposti | Nessuna rimozione del toast precedente | `document.querySelectorAll(".toast").forEach(t=>t.remove())` |
| 7 | Pin dots stale | `querySelectorAll` cachato alla costruzione | `getDots()` funzione che rilegge il DOM ogni volta |
| 8 | Enter su campo nome non funzionava | Nessun listener su `keydown` | Listener che sposta il focus al PIN pad |
| 9 | Costo `0` (gratuito) mostrava `undefined` | `valore \|\| 0` trattava `0` come falsy | Operatore `??` (nullish coalescing) |

---

## 🗺 Roadmap

- [ ] Export PDF dell'itinerario con mappa stampabile
- [ ] Condivisione itinerario via link pubblico
- [ ] Meteo integrato (OpenWeatherMap) per il periodo scelto
- [ ] Modalità offline completa (itinerari salvati in cache SW)
- [ ] Multi-lingua (EN, FR, DE, ES)
- [ ] Prenotazione diretta via link affiliazione Booking.com / GetYourGuide

---

## 📄 Licenza

MIT © DalziTravel

---

<div align="center">
  <strong>Fatto con ✈️ da DalziTravel</strong><br>
  <em>Powered by Groq llama-3.3-70b · Tavily Search · Leaflet.js · OpenStreetMap</em>
</div>
