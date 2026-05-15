/*
    Serveur Node.js complet corrigé pour Expert Trading Pro v2.0
    ------------------------------------------------------------
    Fichier : server.js

    Fonctions :
    - Galerie de captures
    - Sauvegarde screenshot + JSON
    - Analyse IA simple sur capture sauvegardée
    - Analyse Vision + Marché
    - Sources marché multiples :
        1. Binance
        2. OKX
        3. CoinGecko
    - Calculs techniques :
        RSI, EMA20, EMA50, EMA200, MACD, ATR, support, résistance
    - Réponse JSON contrôlée

    Variables Render nécessaires :
    - OPENAI_API_KEY
    - OPENAI_MODEL optionnel, par défaut : gpt-4.1-mini

    Dépendances :
    - express
    - cors
    - openai
*/

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "30mb" }));
app.use(express.urlencoded({ extended: true, limit: "30mb" }));

const PORT = process.env.PORT || 3000;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const SCREENSHOT_DIR = path.join(__dirname, "screenshots");

if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

app.use("/screenshots", express.static(SCREENSHOT_DIR));

/* ============================================================
   OUTILS GÉNÉRAUX
   ============================================================ */

function maintenantIso() {
    return new Date().toISOString();
}

function nettoyerNomFichier(nom) {
    return String(nom || "")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .replace(/_+/g, "_")
        .slice(0, 180);
}

function arrondir(nombre, decimales = 4) {
    const n = Number(nombre);
    if (!Number.isFinite(n)) return null;
    return Number(n.toFixed(decimales));
}

function moyenne(valeurs) {
    const propres = valeurs.map(Number).filter(Number.isFinite);
    if (propres.length === 0) return null;
    return propres.reduce((a, b) => a + b, 0) / propres.length;
}

function normaliserActifPourBinance(actif) {
    const valeur = String(actif || "BINANCE:BTCUSDT").trim().toUpperCase();

    if (valeur.includes(":")) {
        return valeur.split(":").pop().replace("/", "").replace("-", "");
    }

    return valeur.replace("/", "").replace("-", "");
}

function convertirIntervallePourBinance(intervalle) {
    const valeur = String(intervalle || "1h").trim().toLowerCase();

    const table = {
        "1": "1m",
        "3": "3m",
        "5": "5m",
        "15": "15m",
        "30": "30m",
        "45": "30m",
        "60": "1h",
        "120": "2h",
        "240": "4h",
        "1m": "1m",
        "3m": "3m",
        "5m": "5m",
        "15m": "15m",
        "30m": "30m",
        "1h": "1h",
        "2h": "2h",
        "4h": "4h",
        "d": "1d",
        "1d": "1d",
        "jour": "1d",
        "daily": "1d",
        "w": "1w",
        "1w": "1w",
        "m": "1M",
        "1mth": "1M",
        "1mo": "1M"
    };

    return table[valeur] || "1h";
}

function convertirIntervallePourOKX(intervalle) {
    const b = convertirIntervallePourBinance(intervalle);

    const table = {
        "1m": "1m",
        "3m": "3m",
        "5m": "5m",
        "15m": "15m",
        "30m": "30m",
        "1h": "1H",
        "2h": "2H",
        "4h": "4H",
        "1d": "1D",
        "1w": "1W",
        "1M": "1M"
    };

    return table[b] || "1H";
}

function convertirIntervallePourCoinGeckoDays(intervalle) {
    const b = convertirIntervallePourBinance(intervalle);

    if (["1m", "3m", "5m", "15m", "30m"].includes(b)) return 1;
    if (["1h", "2h", "4h"].includes(b)) return 14;
    if (b === "1d") return 180;
    if (b === "1w") return 365;
    return 90;
}

function convertirActifVersOKX(actif) {
    const symbole = normaliserActifPourBinance(actif);

    if (symbole.endsWith("USDT")) {
        return symbole.replace("USDT", "-USDT");
    }

    if (symbole.endsWith("USD")) {
        return symbole.replace("USD", "-USD");
    }

    return "BTC-USDT";
}

function convertirActifVersCoinGeckoId(actif) {
    const symbole = normaliserActifPourBinance(actif);

    const table = {
        "BTCUSDT": "bitcoin",
        "BTCUSD": "bitcoin",
        "ETHUSDT": "ethereum",
        "ETHUSD": "ethereum",
        "SOLUSDT": "solana",
        "BNBUSDT": "binancecoin",
        "XRPUSDT": "ripple",
        "ADAUSDT": "cardano",
        "DOGEUSDT": "dogecoin",
        "AVAXUSDT": "avalanche-2",
        "LINKUSDT": "chainlink",
        "DOTUSDT": "polkadot"
    };

    return table[symbole] || "bitcoin";
}

/* ============================================================
   SOURCES DE MARCHÉ : BINANCE + OKX + COINGECKO
   ============================================================ */

async function recupererBougiesBinance(symbole, intervalle, limite = 300) {
    const url = new URL("https://api.binance.com/api/v3/klines");

    url.searchParams.set("symbol", symbole);
    url.searchParams.set("interval", intervalle);
    url.searchParams.set("limit", String(Math.min(Math.max(Number(limite) || 300, 50), 1000)));

    const reponse = await fetch(url.toString(), {
        method: "GET",
        headers: { "Accept": "application/json" }
    });

    const texte = await reponse.text();

    if (!reponse.ok) {
        throw new Error("Binance HTTP " + reponse.status + " : " + texte);
    }

    let donnees;
    try {
        donnees = JSON.parse(texte);
    } catch (erreur) {
        throw new Error("Réponse Binance non JSON : " + texte);
    }

    if (!Array.isArray(donnees)) {
        throw new Error("Format Binance inattendu : " + texte);
    }

    const bougies = donnees.map(k => ({
        openTime: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        closeTime: Number(k[6]),
        source: "binance"
    })).filter(b =>
        Number.isFinite(b.open) &&
        Number.isFinite(b.high) &&
        Number.isFinite(b.low) &&
        Number.isFinite(b.close)
    );

    if (bougies.length < 20) {
        throw new Error("Binance a retourné trop peu de bougies.");
    }

    return bougies;
}

async function recupererBougiesOKX(instId, bar, limite = 300) {
    const url = new URL("https://www.okx.com/api/v5/market/candles");

    url.searchParams.set("instId", instId);
    url.searchParams.set("bar", bar);
    url.searchParams.set("limit", String(Math.min(Math.max(Number(limite) || 300, 50), 300)));

    const reponse = await fetch(url.toString(), {
        method: "GET",
        headers: {
            "Accept": "application/json",
            "User-Agent": "ExpertTradingPro/2.0"
        }
    });

    const texte = await reponse.text();

    if (!reponse.ok) {
        throw new Error("OKX HTTP " + reponse.status + " : " + texte);
    }

    let json;
    try {
        json = JSON.parse(texte);
    } catch (erreur) {
        throw new Error("Réponse OKX non JSON : " + texte);
    }

    if (!json || json.code !== "0" || !Array.isArray(json.data)) {
        throw new Error("Format OKX inattendu : " + texte);
    }

    /*
        OKX retourne souvent les bougies dans l'ordre décroissant.
        Format :
        [ts, open, high, low, close, volume, volumeCcy, volumeCcyQuote, confirm]
    */
    const bougies = json.data.map(k => ({
        openTime: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        closeTime: Number(k[0]),
        source: "okx"
    }))
    .filter(b =>
        Number.isFinite(b.openTime) &&
        Number.isFinite(b.open) &&
        Number.isFinite(b.high) &&
        Number.isFinite(b.low) &&
        Number.isFinite(b.close)
    )
    .sort((a, b) => a.openTime - b.openTime);

    if (bougies.length < 20) {
        throw new Error("OKX a retourné trop peu de bougies.");
    }

    return bougies;
}

async function recupererBougiesCoinGecko(coinId, days = 14, limite = 300) {
    const url = new URL(`https://api.coingecko.com/api/v3/coins/${coinId}/ohlc`);

    url.searchParams.set("vs_currency", "usd");
    url.searchParams.set("days", String(days));

    const reponse = await fetch(url.toString(), {
        method: "GET",
        headers: {
            "Accept": "application/json",
            "User-Agent": "ExpertTradingPro/2.0"
        }
    });

    const texte = await reponse.text();

    if (!reponse.ok) {
        throw new Error("CoinGecko HTTP " + reponse.status + " : " + texte);
    }

    let donnees;
    try {
        donnees = JSON.parse(texte);
    } catch (erreur) {
        throw new Error("Réponse CoinGecko non JSON : " + texte);
    }

    if (!Array.isArray(donnees)) {
        throw new Error("Format CoinGecko inattendu : " + texte);
    }

    /*
        CoinGecko OHLC :
        [timestamp, open, high, low, close]
        Pas de volume dans cet endpoint.
    */
    const bougies = donnees.slice(-limite).map(k => ({
        openTime: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: 0,
        closeTime: Number(k[0]),
        source: "coingecko"
    })).filter(b =>
        Number.isFinite(b.open) &&
        Number.isFinite(b.high) &&
        Number.isFinite(b.low) &&
        Number.isFinite(b.close)
    );

    if (bougies.length < 20) {
        throw new Error("CoinGecko a retourné trop peu de bougies.");
    }

    return bougies;
}

async function recupererBougiesMarche(actif, intervalle, limite = 300) {
    const erreurs = [];
    const intervalleBinance = convertirIntervallePourBinance(intervalle);

    /*
        1. Binance
    */
    try {
        const symbole = normaliserActifPourBinance(actif);
        const bougies = await recupererBougiesBinance(symbole, intervalleBinance, limite);

        return {
            source: "binance",
            symbole,
            intervalle: intervalleBinance,
            bougies,
            erreurs
        };
    } catch (erreur) {
        erreurs.push({
            source: "binance",
            message: erreur.message
        });
    }

    /*
        2. OKX
    */
    try {
        const instId = convertirActifVersOKX(actif);
        const bar = convertirIntervallePourOKX(intervalle);
        const bougies = await recupererBougiesOKX(instId, bar, Math.min(limite, 300));

        return {
            source: "okx",
            symbole: instId,
            intervalle: bar,
            bougies,
            erreurs
        };
    } catch (erreur) {
        erreurs.push({
            source: "okx",
            message: erreur.message
        });
    }

    /*
        3. CoinGecko
    */
    try {
        const coinId = convertirActifVersCoinGeckoId(actif);
        const days = convertirIntervallePourCoinGeckoDays(intervalle);
        const bougies = await recupererBougiesCoinGecko(coinId, days, limite);

        return {
            source: "coingecko",
            symbole: coinId,
            intervalle: "days=" + days,
            bougies,
            erreurs
        };
    } catch (erreur) {
        erreurs.push({
            source: "coingecko",
            message: erreur.message
        });
    }

    throw new Error(
        "Aucune source de marché disponible. Détails : " +
        JSON.stringify(erreurs, null, 2)
    );
}

/* ============================================================
   INDICATEURS TECHNIQUES
   ============================================================ */

function calculerEMA(valeurs, periode) {
    if (!Array.isArray(valeurs) || valeurs.length < periode) return null;

    const k = 2 / (periode + 1);
    let ema = moyenne(valeurs.slice(0, periode));

    if (ema === null) return null;

    for (let i = periode; i < valeurs.length; i++) {
        ema = valeurs[i] * k + ema * (1 - k);
    }

    return ema;
}

function calculerRSI(closes, periode = 14) {
    if (!Array.isArray(closes) || closes.length <= periode) return null;

    let gains = 0;
    let pertes = 0;

    for (let i = 1; i <= periode; i++) {
        const diff = closes[i] - closes[i - 1];

        if (diff >= 0) gains += diff;
        else pertes -= diff;
    }

    let gainMoyen = gains / periode;
    let perteMoyenne = pertes / periode;

    for (let i = periode + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        const gain = diff > 0 ? diff : 0;
        const perte = diff < 0 ? -diff : 0;

        gainMoyen = ((gainMoyen * (periode - 1)) + gain) / periode;
        perteMoyenne = ((perteMoyenne * (periode - 1)) + perte) / periode;
    }

    if (perteMoyenne === 0) return 100;

    const rs = gainMoyen / perteMoyenne;
    return 100 - (100 / (1 + rs));
}

function calculerMACD(closes) {
    if (!Array.isArray(closes) || closes.length < 35) {
        return {
            macd: null,
            signal: null,
            histogramme: null
        };
    }

    const macdSeries = [];

    for (let i = 35; i <= closes.length; i++) {
        const slice = closes.slice(0, i);
        const ema12 = calculerEMA(slice, 12);
        const ema26 = calculerEMA(slice, 26);

        if (ema12 !== null && ema26 !== null) {
            macdSeries.push(ema12 - ema26);
        }
    }

    const macd = macdSeries.length ? macdSeries[macdSeries.length - 1] : null;
    const signal = macdSeries.length >= 9 ? calculerEMA(macdSeries, 9) : null;

    return {
        macd,
        signal,
        histogramme: macd !== null && signal !== null ? macd - signal : null
    };
}

function calculerATR(bougies, periode = 14) {
    if (!Array.isArray(bougies) || bougies.length <= periode) return null;

    const trueRanges = [];

    for (let i = 1; i < bougies.length; i++) {
        const h = bougies[i].high;
        const l = bougies[i].low;
        const previousClose = bougies[i - 1].close;

        trueRanges.push(Math.max(
            h - l,
            Math.abs(h - previousClose),
            Math.abs(l - previousClose)
        ));
    }

    return moyenne(trueRanges.slice(-periode));
}

function detecterSupportsResistances(bougies, fenetre = 80) {
    const zone = bougies.slice(-fenetre);

    if (zone.length < 20) {
        return {
            support: null,
            resistance: null
        };
    }

    const lows = zone
        .map(b => b.low)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);

    const highs = zone
        .map(b => b.high)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);

    const indexSupport = Math.floor(lows.length * 0.15);
    const indexResistance = Math.floor(highs.length * 0.85);

    return {
        support: lows[indexSupport] ?? null,
        resistance: highs[indexResistance] ?? null
    };
}

function construireAnalyseTechnique({ actif, intervalle, bougies, sourceMarche, symboleMarche, erreursSources }) {
    if (!Array.isArray(bougies) || bougies.length < 60) {
        return {
            ok: false,
            statut: "historique_insuffisant",
            message: "Historique insuffisant pour calculer une analyse technique fiable.",
            source_marche: sourceMarche || null,
            erreurs_sources: erreursSources || []
        };
    }

    const closes = bougies.map(b => b.close);
    const volumes = bougies.map(b => Number(b.volume || 0));
    const derniere = bougies[bougies.length - 1];

    const ema20 = calculerEMA(closes, 20);
    const ema50 = calculerEMA(closes, 50);
    const ema200 = calculerEMA(closes, 200);
    const rsi = calculerRSI(closes, 14);
    const macd = calculerMACD(closes);
    const atr = calculerATR(bougies, 14);
    const zones = detecterSupportsResistances(bougies, 80);

    let tendance = "neutre";

    if (
        ema20 !== null &&
        ema50 !== null &&
        derniere.close > ema20 &&
        ema20 > ema50
    ) {
        tendance = "haussiere";
    }

    if (
        ema20 !== null &&
        ema50 !== null &&
        derniere.close < ema20 &&
        ema20 < ema50
    ) {
        tendance = "baissiere";
    }

    let signalTechnique = "attendre";

    if (
        tendance === "haussiere" &&
        rsi !== null &&
        rsi < 70 &&
        macd.histogramme !== null &&
        macd.histogramme > 0
    ) {
        signalTechnique = "acheter";
    }

    if (
        tendance === "baissiere" &&
        rsi !== null &&
        rsi > 30 &&
        macd.histogramme !== null &&
        macd.histogramme < 0
    ) {
        signalTechnique = "vendre";
    }

    return {
        ok: true,
        actif,
        intervalle,
        source_marche: sourceMarche || "inconnue",
        symbole_marche: symboleMarche || null,
        erreurs_sources: erreursSources || [],
        prix_actuel: arrondir(derniere.close),
        support_principal: arrondir(zones.support),
        resistance_principale: arrondir(zones.resistance),
        rsi: arrondir(rsi, 2),
        ema20: arrondir(ema20),
        ema50: arrondir(ema50),
        ema200: arrondir(ema200),
        macd: {
            macd: arrondir(macd.macd),
            signal: arrondir(macd.signal),
            histogramme: arrondir(macd.histogramme)
        },
        atr: arrondir(atr),
        volume: arrondir(derniere.volume, 2),
        volume_moyen_20: arrondir(moyenne(volumes.slice(-20)), 2),
        tendance,
        signal_technique: signalTechnique,
        derniere_bougie: {
            openTime: derniere.openTime,
            open: arrondir(derniere.open),
            high: arrondir(derniere.high),
            low: arrondir(derniere.low),
            close: arrondir(derniere.close),
            volume: arrondir(derniere.volume, 2),
            closeTime: derniere.closeTime
        },
        date_calcul: maintenantIso()
    };
}

/* ============================================================
   OPENAI VISION
   ============================================================ */

let openaiClient = null;

function getOpenAIClient() {
    if (!process.env.OPENAI_API_KEY) {
        const erreur = new Error("OPENAI_API_KEY n'est pas configurée sur Render.");
        erreur.httpStatus = 500;
        throw erreur;
    }

    if (!openaiClient) {
        const OpenAI = require("openai");
        openaiClient = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
    }

    return openaiClient;
}

function extraireJsonDepuisTexte(texte) {
    const brut = String(texte || "").trim();

    try {
        return JSON.parse(brut);
    } catch (e) {
        const debut = brut.indexOf("{");
        const fin = brut.lastIndexOf("}");

        if (debut >= 0 && fin > debut) {
            return JSON.parse(brut.slice(debut, fin + 1));
        }

        throw new Error("Réponse IA non JSON : " + brut);
    }
}

function normaliserDecisionVision(json, analyseTechnique) {
    const signalBrut = String(json.signal || json.decision || "attendre").toLowerCase();
    const signal = ["acheter", "vendre", "attendre"].includes(signalBrut)
        ? signalBrut
        : "attendre";

    let confiance = Number(json.confiance ?? json.confidence ?? 0);

    if (!Number.isFinite(confiance)) confiance = 0;
    if (confiance <= 1) confiance = confiance * 100;

    confiance = Math.max(0, Math.min(100, confiance));

    return {
        ok: true,
        statut: "ok",
        source: "openai_vision_plus_marche_multi_sources",
        source_marche: analyseTechnique.source_marche,
        symbole_marche: analyseTechnique.symbole_marche,
        erreurs_sources: analyseTechnique.erreurs_sources || [],
        actif: analyseTechnique.actif,
        intervalle: analyseTechnique.intervalle,
        signal,
        decision: signal.toUpperCase(),
        confiance: arrondir(confiance, 1),
        tendance: json.tendance || analyseTechnique.tendance || "neutre",
        prix_actuel: analyseTechnique.prix_actuel,
        support_principal: analyseTechnique.support_principal,
        resistance_principale: analyseTechnique.resistance_principale,
        stop_loss: Number.isFinite(Number(json.stop_loss)) ? Number(json.stop_loss) : null,
        take_profit_1: Number.isFinite(Number(json.take_profit_1)) ? Number(json.take_profit_1) : null,
        take_profit_2: Number.isFinite(Number(json.take_profit_2)) ? Number(json.take_profit_2) : null,
        resume: json.resume || json.raison || "",
        raisons: Array.isArray(json.raisons) ? json.raisons : [],
        risques: Array.isArray(json.risques) ? json.risques : [],
        recommandations: Array.isArray(json.recommandations) ? json.recommandations : [],
        analyse_visuelle: json.analyse_visuelle || {},
        analyse_technique: analyseTechnique,
        avertissement: "Analyse technique informative. Ce n'est pas un conseil financier.",
        date: maintenantIso()
    };
}

async function analyserImageAvecOpenAIVision({ imageBase64, imageUrl, analyseTechnique, configuration }) {
    const client = getOpenAIClient();

    let imageInputUrl = imageUrl || "";

    if (imageBase64) {
        const propre = String(imageBase64).includes(",")
            ? String(imageBase64).split(",").pop()
            : String(imageBase64);

        imageInputUrl = "data:image/png;base64," + propre;
    }

    if (!imageInputUrl) {
        throw new Error("Aucune image fournie. Envoyer imageBase64 ou imageUrl.");
    }

    const prompt = `
Tu es un analyste technique prudent.

Tu reçois :
1. une capture de graphique ;
2. des données OHLCV calculées côté serveur.

Les données de marché peuvent venir de Binance, OKX ou CoinGecko.
Tu dois tenir compte de la source et des limites éventuelles.
CoinGecko peut ne pas fournir le volume.

Tu dois donner une analyse concrète, mais tu ne dois jamais inventer un prix.
Les prix fiables sont ceux des données numériques ci-dessous.

Données techniques calculées :
${JSON.stringify(analyseTechnique, null, 2)}

Configuration utilisateur :
${JSON.stringify(configuration || {}, null, 2)}

Réponds uniquement en JSON valide.
Structure obligatoire :
{
  "signal": "acheter | vendre | attendre",
  "confiance": 0,
  "tendance": "haussiere | baissiere | neutre",
  "resume": "",
  "raisons": [],
  "risques": [],
  "recommandations": [],
  "stop_loss": null,
  "take_profit_1": null,
  "take_profit_2": null,
  "analyse_visuelle": {
    "supports_visibles": [],
    "resistances_visibles": [],
    "cassure": "",
    "momentum": "",
    "commentaire": ""
  }
}

Règles :
- Si la capture est floue ou incomplète, indique-le dans risques.
- Si le signal est incertain, choisis "attendre".
- Le stop loss et les objectifs doivent être cohérents avec support, résistance et ATR.
- Si la source de marché n'est pas Binance, mentionne la prudence dans risques.
- Ne donne pas d'ordre ferme.
`;

    const response = await client.responses.create({
        model: OPENAI_MODEL,
        input: [
            {
                role: "user",
                content: [
                    { type: "input_text", text: prompt },
                    { type: "input_image", image_url: imageInputUrl }
                ]
            }
        ]
    });

    return extraireJsonDepuisTexte(response.output_text || "");
}

/* ============================================================
   ROUTES GÉNÉRALES
   ============================================================ */

app.get("/", (req, res) => {
    res.json({
        ok: true,
        statut: "ok",
        message: "Serveur Expert Trading Pro actif.",
        routes: [
            "GET /api/test",
            "GET /api/health",
            "GET /api/list",
            "POST /api/save",
            "POST /api/analyze-vision",
            "POST /api/analyze-vision-batch",
            "POST /api/update-notes",
            "POST /api/analyse-technique-pro",
            "POST /api/analyze-vision-pro"
        ],
        sources_marche: ["binance", "okx", "coingecko"],
        date: maintenantIso()
    });
});

app.get("/api/test", (req, res) => {
    res.json({
        ok: true,
        statut: "ok",
        message: "API accessible.",
        model: OPENAI_MODEL,
        openai_key_configuree: Boolean(process.env.OPENAI_API_KEY),
        sources_marche: ["binance", "okx", "coingecko"],
        date: maintenantIso()
    });
});

app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        status: "healthy",
        service: "expert-trading",
        date: maintenantIso()
    });
});

/* ============================================================
   ROUTES CAPTURES
   ============================================================ */

app.get("/api/list", (req, res) => {
    try {
        const files = fs.readdirSync(SCREENSHOT_DIR)
            .filter(file => /\.(png|jpg|jpeg|webp)$/i.test(file))
            .sort((a, b) => {
                const pa = path.join(SCREENSHOT_DIR, a);
                const pb = path.join(SCREENSHOT_DIR, b);
                return fs.statSync(pb).mtimeMs - fs.statSync(pa).mtimeMs;
            });

        res.json(files);
    } catch (erreur) {
        res.status(500).json({
            ok: false,
            message: "Impossible de lister les captures.",
            details: erreur.message
        });
    }
});

app.post("/api/save", (req, res) => {
    try {
        const image = req.body.image || req.body.screenshot_base64;
        const metadata = req.body.metadata || {};
        const configuration = req.body.configuration || {};

        if (!image || typeof image !== "string" || !image.includes("base64,")) {
            return res.status(400).json({
                ok: false,
                message: "Image base64 absente ou invalide."
            });
        }

        const base64 = image.split("base64,").pop();
        const buffer = Buffer.from(base64, "base64");

        const actif = nettoyerNomFichier(metadata.asset || configuration.actif || "ACTIF");
        const intervalle = nettoyerNomFichier(metadata.interval || configuration.intervalle || "INT");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");

        const pngName = `${actif}_${intervalle}_${stamp}.png`;
        const jsonName = pngName.replace(".png", ".json");

        fs.writeFileSync(path.join(SCREENSHOT_DIR, pngName), buffer);

        const metaFinale = {
            ...metadata,
            ...configuration,
            asset: metadata.asset || configuration.actif || null,
            interval: metadata.interval || configuration.intervalle || null,
            date: metadata.date || maintenantIso(),
            image_file: pngName
        };

        fs.writeFileSync(
            path.join(SCREENSHOT_DIR, jsonName),
            JSON.stringify(metaFinale, null, 2),
            "utf-8"
        );

        res.json({
            ok: true,
            success: true,
            message: "Capture enregistrée.",
            fileName: pngName,
            jsonName,
            url: "/screenshots/" + encodeURIComponent(pngName)
        });

    } catch (erreur) {
        res.status(500).json({
            ok: false,
            message: "Erreur lors de la sauvegarde.",
            details: erreur.message
        });
    }
});

app.post("/api/update-notes", (req, res) => {
    try {
        const fileName = nettoyerNomFichier(req.body.fileName || "");
        const notes = String(req.body.notes || "");

        if (!fileName || !fileName.endsWith(".json")) {
            return res.status(400).json({
                ok: false,
                message: "Nom de fichier JSON invalide."
            });
        }

        const filePath = path.join(SCREENSHOT_DIR, fileName);

        let contenu = {};
        if (fs.existsSync(filePath)) {
            contenu = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        }

        contenu.notes = notes;
        contenu.date_update_notes = maintenantIso();

        fs.writeFileSync(filePath, JSON.stringify(contenu, null, 2), "utf-8");

        res.json({
            ok: true,
            success: true,
            message: "Notes archivées.",
            fileName
        });

    } catch (erreur) {
        res.status(500).json({
            ok: false,
            message: "Erreur lors de l'archivage des notes.",
            details: erreur.message
        });
    }
});

/* ============================================================
   ANALYSE SIMPLE COMPATIBLE AVEC analyse.html
   ============================================================ */

app.post("/api/analyze-vision", async (req, res) => {
    try {
        const fileName = nettoyerNomFichier(req.body.fileName || "");

        if (!fileName) {
            return res.status(400).json({
                ok: false,
                message: "fileName est requis."
            });
        }

        const imagePath = path.join(SCREENSHOT_DIR, fileName);

        if (!fs.existsSync(imagePath)) {
            return res.status(404).json({
                ok: false,
                message: "Capture introuvable.",
                fileName
            });
        }

        const buffer = fs.readFileSync(imagePath);
        const imageBase64 = "data:image/png;base64," + buffer.toString("base64");

        const actif = fileName.toUpperCase().includes("ETH")
            ? "BINANCE:ETHUSDT"
            : "BINANCE:BTCUSDT";

        const resultatMarche = await recupererBougiesMarche(actif, "1h", 300);

        const analyseTechnique = construireAnalyseTechnique({
            actif,
            intervalle: resultatMarche.intervalle,
            bougies: resultatMarche.bougies,
            sourceMarche: resultatMarche.source,
            symboleMarche: resultatMarche.symbole,
            erreursSources: resultatMarche.erreurs
        });

        const analyseIA = await analyserImageAvecOpenAIVision({
            imageBase64,
            analyseTechnique,
            configuration: { fileName, origine: "analyze-vision" }
        });

        const analyseFinale = normaliserDecisionVision(analyseIA, analyseTechnique);

        res.json({
            ok: true,
            analysis: {
                decision: analyseFinale.decision,
                confidence: analyseFinale.confiance,
                reasoning: analyseFinale.resume || analyseFinale.raisons.join("\n"),
                details: analyseFinale
            },
            analyse: analyseFinale
        });

    } catch (erreur) {
        res.status(erreur.httpStatus || 500).json({
            ok: false,
            message: "Erreur analyse IA simple.",
            details: erreur.message
        });
    }
});

app.post("/api/analyze-vision-batch", async (req, res) => {
    try {
        const files = Array.isArray(req.body.files) ? req.body.files : [];

        if (files.length === 0) {
            return res.status(400).json({
                ok: false,
                message: "Aucun fichier fourni."
            });
        }

        const results = [];
        const errors = [];

        for (const fileName of files) {
            try {
                const fakeReq = { body: { fileName } };
                const imagePath = path.join(SCREENSHOT_DIR, nettoyerNomFichier(fileName));

                if (!fs.existsSync(imagePath)) {
                    throw new Error("Capture introuvable.");
                }

                const buffer = fs.readFileSync(imagePath);
                const imageBase64 = "data:image/png;base64," + buffer.toString("base64");

                const actif = String(fileName).toUpperCase().includes("ETH")
                    ? "BINANCE:ETHUSDT"
                    : "BINANCE:BTCUSDT";

                const resultatMarche = await recupererBougiesMarche(actif, "1h", 300);

                const analyseTechnique = construireAnalyseTechnique({
                    actif,
                    intervalle: resultatMarche.intervalle,
                    bougies: resultatMarche.bougies,
                    sourceMarche: resultatMarche.source,
                    symboleMarche: resultatMarche.symbole,
                    erreursSources: resultatMarche.erreurs
                });

                const analyseIA = await analyserImageAvecOpenAIVision({
                    imageBase64,
                    analyseTechnique,
                    configuration: { fileName, origine: "analyze-vision-batch" }
                });

                const analyseFinale = normaliserDecisionVision(analyseIA, analyseTechnique);

                results.push({
                    fileName,
                    analysis: {
                        decision: analyseFinale.decision,
                        confidence: analyseFinale.confiance,
                        reasoning: analyseFinale.resume || analyseFinale.raisons.join("\n"),
                        details: analyseFinale
                    }
                });

            } catch (erreurFichier) {
                errors.push({
                    fileName,
                    message: erreurFichier.message
                });
            }
        }

        res.json({
            ok: true,
            results,
            errors
        });

    } catch (erreur) {
        res.status(500).json({
            ok: false,
            message: "Erreur analyse batch.",
            details: erreur.message
        });
    }
});

/* ============================================================
   ANALYSE TECHNIQUE MULTI-SOURCES
   ============================================================ */

app.post("/api/analyse-technique-pro", async (req, res) => {
    try {
        const {
            actif = "BINANCE:BTCUSDT",
            intervalle = "1h"
        } = req.body || {};

        const resultatMarche = await recupererBougiesMarche(actif, intervalle, 300);

        const analyseTechnique = construireAnalyseTechnique({
            actif,
            intervalle: resultatMarche.intervalle,
            bougies: resultatMarche.bougies,
            sourceMarche: resultatMarche.source,
            symboleMarche: resultatMarche.symbole,
            erreursSources: resultatMarche.erreurs
        });

        return res.json(analyseTechnique);

    } catch (erreur) {
        console.error("Erreur /api/analyse-technique-pro :", erreur);

        return res.status(500).json({
            ok: false,
            statut: "erreur",
            message: "Échec de l'analyse technique multi-sources.",
            details: erreur.message,
            date: maintenantIso()
        });
    }
});

/* ============================================================
   ANALYSE VISION + MARCHÉ MULTI-SOURCES
   ============================================================ */

app.post("/api/analyze-vision-pro", async (req, res) => {
    try {
        const {
            actif = "BINANCE:BTCUSDT",
            intervalle = "1h",
            imageBase64 = null,
            imageUrl = null,
            configuration = null
        } = req.body || {};

        const resultatMarche = await recupererBougiesMarche(actif, intervalle, 300);

        const analyseTechnique = construireAnalyseTechnique({
            actif,
            intervalle: resultatMarche.intervalle,
            bougies: resultatMarche.bougies,
            sourceMarche: resultatMarche.source,
            symboleMarche: resultatMarche.symbole,
            erreursSources: resultatMarche.erreurs
        });

        if (!analyseTechnique.ok) {
            return res.status(400).json(analyseTechnique);
        }

        const analyseIA = await analyserImageAvecOpenAIVision({
            imageBase64,
            imageUrl,
            analyseTechnique,
            configuration
        });

        const analyseFinale = normaliserDecisionVision(analyseIA, analyseTechnique);

        return res.json({
            ok: true,
            statut: "ok",
            analysis: analyseFinale,
            analyse: analyseFinale
        });

    } catch (erreur) {
        console.error("Erreur /api/analyze-vision-pro :", erreur);

        return res.status(erreur.httpStatus || 500).json({
            ok: false,
            statut: "erreur",
            message: "Échec de l'analyse Vision + Marché multi-sources.",
            details: erreur.message,
            model: OPENAI_MODEL,
            date: maintenantIso()
        });
    }
});

/* ============================================================
   ROUTE 404
   ============================================================ */

app.use((req, res) => {
    res.status(404).json({
        ok: false,
        statut: "erreur",
        message: "Route introuvable.",
        methode: req.method,
        routeDemandee: req.originalUrl,
        routesDisponibles: [
            "GET /",
            "GET /api/test",
            "GET /api/health",
            "GET /api/list",
            "POST /api/save",
            "POST /api/analyze-vision",
            "POST /api/analyze-vision-batch",
            "POST /api/update-notes",
            "POST /api/analyse-technique-pro",
            "POST /api/analyze-vision-pro"
        ],
        date: maintenantIso()
    });
});

/* ============================================================
   DÉMARRAGE
   ============================================================ */

app.listen(PORT, "0.0.0.0", () => {
    console.log("Serveur Expert Trading Pro actif.");
    console.log("Port :", PORT);
    console.log("Modèle OpenAI :", OPENAI_MODEL);
    console.log("OPENAI_API_KEY configurée :", Boolean(process.env.OPENAI_API_KEY));
    console.log("Sources marché : Binance -> OKX -> CoinGecko");
});
