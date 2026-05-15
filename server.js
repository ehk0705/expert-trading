const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// --- GESTION DU RÉPERTOIRE DE STOCKAGE ---
// Déclaré en haut pour être accessible partout
const screenshotDir = path.join(__dirname, 'screenshots');

if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    console.log("Dossier 'screenshots' initialisé.");
}

// --- CONFIGURATION IA ---
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const HAS_OPENAI_KEY = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim() !== '');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 90000
});

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));
app.use('/screenshots', express.static(screenshotDir));

// --- OUTILS INTERNES ---
function safeFileName(fileName) {
    if (!fileName || typeof fileName !== 'string') return null;
    const cleaned = path.basename(fileName);
    if (!/^[a-zA-Z0-9._-]+\.(png|jpg|jpeg|webp|json)$/i.test(cleaned)) return null;
    return cleaned;
}

function imageMimeType(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    return 'image/png';
}

function jsonPathForImage(filePath) {
    return filePath.replace(/\.(png|jpg|jpeg|webp)$/i, '.json');
}

function extractJsonObject(text) {
    if (!text || typeof text !== 'string') {
        throw new Error('Réponse IA vide.');
    }

    try {
        return JSON.parse(text);
    } catch (firstError) {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
            return JSON.parse(text.slice(start, end + 1));
        }
        throw firstError;
    }
}

function normalizeAnalysis(analysis) {
    const allowed = ['ACHETER', 'VENDRE', 'ATTENDRE'];
    let decision = String(analysis.decision || 'ATTENDRE').trim().toUpperCase();
    if (!allowed.includes(decision)) decision = 'ATTENDRE';

    const confidenceNumber = Number(analysis.confidence);
    const confidence = Number.isFinite(confidenceNumber) ? Math.max(0, Math.min(100, Math.round(confidenceNumber))) : 0;

    const reasoning = String(analysis.reasoning || analysis.raison || 'Aucune justification reçue.').trim();

    return { decision, confidence, reasoning };
}

function writeJsonIfPossible(jsonPath, mutator) {
    try {
        let fileData = {};
        if (fs.existsSync(jsonPath)) {
            const raw = fs.readFileSync(jsonPath, 'utf8');
            fileData = raw.trim() ? JSON.parse(raw) : {};
        }
        mutator(fileData);
        fs.writeFileSync(jsonPath, JSON.stringify(fileData, null, 2));
        return true;
    } catch (err) {
        console.error('Impossible de mettre à jour le JSON :', err.message);
        return false;
    }
}

function validateImageForAnalysis(requestedFileName) {
    const fileName = safeFileName(requestedFileName);

    if (!fileName) {
        const error = new Error('Nom de fichier invalide.');
        error.httpStatus = 400;
        error.details = 'Le serveur accepte seulement les fichiers png, jpg, jpeg ou webp présents dans le dossier screenshots.';
        throw error;
    }

    if (!/\.(png|jpg|jpeg|webp)$/i.test(fileName)) {
        const error = new Error('Le fichier à analyser doit être une image.');
        error.httpStatus = 400;
        error.details = 'Extensions acceptées : png, jpg, jpeg, webp.';
        throw error;
    }

    const filePath = path.join(screenshotDir, fileName);

    if (!fs.existsSync(filePath)) {
        const error = new Error('Image introuvable pour analyse.');
        error.httpStatus = 404;
        error.details = `Le fichier ${fileName} est absent du dossier screenshots.`;
        throw error;
    }

    return { fileName, filePath };
}

function openAIErrorDetails(error) {
    const status = error.status || error.code || error.httpStatus || null;
    let details = error.details || error.message || 'Erreur inconnue.';

    if (status === 401) {
        details = 'Clé OpenAI invalide ou absente.';
    } else if (status === 429) {
        details = 'Quota OpenAI atteint, crédit insuffisant ou trop de requêtes.';
    } else if (status === 400) {
        details = error.message || 'Requête OpenAI invalide. Vérifiez le modèle et le format de l’image.';
    }

    return { status, details };
}

async function analyzeImageFile(fileName) {
    if (!HAS_OPENAI_KEY) {
        const error = new Error('OPENAI_API_KEY absente sur le serveur Render.');
        error.httpStatus = 500;
        error.details = 'Ajoutez OPENAI_API_KEY dans les variables d’environnement Render, puis redéployez le service.';
        throw error;
    }

    const validated = validateImageForAnalysis(fileName);

    console.log('--- TENTATIVE D\'ANALYSE IA ---');
    console.log('Fichier cible :', validated.filePath);

    // 1. Encodage de l'image locale en Base64
    const imageBuffer = fs.readFileSync(validated.filePath);
    const base64Image = imageBuffer.toString('base64');
    const mime = imageMimeType(validated.fileName);

    console.log(`Envoi à OpenAI avec le modèle ${OPENAI_MODEL}...`);

    // 2. Appel à l'API Vision
    const response = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        temperature: 0.2,
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [
            {
                role: 'system',
                content: 'Tu es un ingénieur financier expert en analyse technique. Tu analyses uniquement ce qui est visible sur le graphique. Tu ne promets jamais un gain. Tu retournes seulement un JSON valide.'
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `Analyse cette capture TradingView. Détecte la tendance visuelle, les zones probables de support/résistance et le momentum visible.

Réponds UNIQUEMENT en JSON strict, sans markdown, sous cette forme exacte :
{
  "decision": "ACHETER" ou "VENDRE" ou "ATTENDRE",
  "confidence": 0,
  "reasoning": "Explication technique courte en français."
}

Règles :
- Si le graphique est illisible ou insuffisant, réponds ATTENDRE.
- Si le prix est trop proche d'une résistance ou d'un support sans confirmation, réponds ATTENDRE.
- La confiance doit être un nombre entre 0 et 100.`
                    },
                    {
                        type: 'image_url',
                        image_url: {
                            url: `data:${mime};base64,${base64Image}`,
                            detail: 'low'
                        }
                    }
                ]
            }
        ]
    });

    const content = response?.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error('OpenAI a retourné une réponse vide.');
    }

    const rawAnalysis = extractJsonObject(content);
    const analysis = normalizeAnalysis(rawAnalysis);
    console.log('Analyse reçue avec succès :', validated.fileName, analysis.decision, analysis.confidence + '%');

    // 3. Sauvegarde dans le fichier JSON correspondant
    const jsonPath = jsonPathForImage(validated.filePath);
    writeJsonIfPossible(jsonPath, (fileData) => {
        fileData.ai_analysis = analysis;
        fileData.ai_analysis_date = new Date().toISOString();
        fileData.ai_model = OPENAI_MODEL;
    });

    return { fileName: validated.fileName, analysis };
}

/* ============================================================
   AJOUT : BINANCE + CALCULS TECHNIQUES + VISION CONTRÔLÉE
   ============================================================ */

function normaliserActifPourBinancePro(actif) {
    const valeur = String(actif || 'BINANCE:BTCUSDT').trim().toUpperCase();

    if (valeur.includes(':')) {
        return valeur.split(':').pop().replace('/', '').replace('-', '');
    }

    return valeur.replace('/', '').replace('-', '');
}

function convertirIntervallePourBinancePro(intervalle) {
    const valeur = String(intervalle || '1h').trim().toLowerCase();

    const table = {
        '1': '1m',
        '3': '3m',
        '5': '5m',
        '15': '15m',
        '30': '30m',
        '45': '30m',
        '60': '1h',
        '120': '2h',
        '240': '4h',
        '1h': '1h',
        '2h': '2h',
        '4h': '4h',
        '1d': '1d',
        'd': '1d',
        'jour': '1d',
        'daily': '1d',
        '1w': '1w',
        'w': '1w'
    };

    return table[valeur] || valeur || '1h';
}

async function recupererBougiesBinancePro(symbole, intervalle, limite = 300) {
    const url = new URL('https://api.binance.com/api/v3/klines');
    url.searchParams.set('symbol', symbole);
    url.searchParams.set('interval', intervalle);
    url.searchParams.set('limit', String(Math.min(Math.max(Number(limite) || 300, 50), 1000)));

    const reponse = await fetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' }
    });

    const texte = await reponse.text();

    if (!reponse.ok) {
        throw new Error('Erreur Binance HTTP ' + reponse.status + ' : ' + texte);
    }

    let donnees;
    try {
        donnees = JSON.parse(texte);
    } catch (erreur) {
        throw new Error('Réponse Binance non JSON : ' + texte);
    }

    if (!Array.isArray(donnees)) {
        throw new Error('Format Binance inattendu.');
    }

    return donnees.map(k => ({
        openTime: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        closeTime: Number(k[6])
    })).filter(b =>
        Number.isFinite(b.open) &&
        Number.isFinite(b.high) &&
        Number.isFinite(b.low) &&
        Number.isFinite(b.close)
    );
}

function moyennePro(valeurs) {
    const propres = valeurs.filter(v => Number.isFinite(v));
    if (propres.length === 0) return null;
    return propres.reduce((a, b) => a + b, 0) / propres.length;
}

function calculerEMAPro(valeurs, periode) {
    if (!Array.isArray(valeurs) || valeurs.length < periode) return null;

    const k = 2 / (periode + 1);
    let ema = moyennePro(valeurs.slice(0, periode));

    for (let i = periode; i < valeurs.length; i++) {
        ema = valeurs[i] * k + ema * (1 - k);
    }

    return ema;
}

function calculerRSIPro(closes, periode = 14) {
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

function calculerMACDPro(closes) {
    if (!Array.isArray(closes) || closes.length < 35) {
        return { macd: null, signal: null, histogramme: null };
    }

    const macdSeries = [];

    for (let i = 35; i <= closes.length; i++) {
        const slice = closes.slice(0, i);
        const ema12 = calculerEMAPro(slice, 12);
        const ema26 = calculerEMAPro(slice, 26);

        if (ema12 !== null && ema26 !== null) {
            macdSeries.push(ema12 - ema26);
        }
    }

    const macd = macdSeries.length ? macdSeries[macdSeries.length - 1] : null;
    const signal = macdSeries.length >= 9 ? calculerEMAPro(macdSeries, 9) : null;

    return {
        macd,
        signal,
        histogramme: macd !== null && signal !== null ? macd - signal : null
    };
}

function calculerATRPro(bougies, periode = 14) {
    if (!Array.isArray(bougies) || bougies.length <= periode) return null;

    const trs = [];

    for (let i = 1; i < bougies.length; i++) {
        const h = bougies[i].high;
        const l = bougies[i].low;
        const pc = bougies[i - 1].close;

        trs.push(Math.max(
            h - l,
            Math.abs(h - pc),
            Math.abs(l - pc)
        ));
    }

    return moyennePro(trs.slice(-periode));
}

function detecterSupportsResistancesPro(bougies, fenetre = 80) {
    const zone = bougies.slice(-fenetre);

    if (zone.length < 20) {
        return { support: null, resistance: null };
    }

    const lows = zone.map(b => b.low).filter(Number.isFinite).sort((a, b) => a - b);
    const highs = zone.map(b => b.high).filter(Number.isFinite).sort((a, b) => a - b);

    const indexSupport = Math.floor(lows.length * 0.15);
    const indexResistance = Math.floor(highs.length * 0.85);

    return {
        support: lows[indexSupport] ?? null,
        resistance: highs[indexResistance] ?? null
    };
}

function arrondirPro(nombre, decimales = 4) {
    if (!Number.isFinite(nombre)) return null;
    return Number(Number(nombre).toFixed(decimales));
}

function construireAnalyseTechniquePro({ actif, intervalle, symbole, bougies }) {
    if (!Array.isArray(bougies) || bougies.length < 60) {
        return {
            ok: false,
            statut: 'historique_insuffisant',
            message: 'Historique insuffisant pour calculer une analyse technique fiable.'
        };
    }

    const closes = bougies.map(b => b.close);
    const volumes = bougies.map(b => b.volume);
    const derniere = bougies[bougies.length - 1];

    const ema20 = calculerEMAPro(closes, 20);
    const ema50 = calculerEMAPro(closes, 50);
    const ema200 = calculerEMAPro(closes, 200);
    const rsi = calculerRSIPro(closes, 14);
    const macd = calculerMACDPro(closes);
    const atr = calculerATRPro(bougies, 14);
    const zones = detecterSupportsResistancesPro(bougies, 80);

    let tendance = 'neutre';

    if (ema20 && ema50 && derniere.close > ema20 && ema20 > ema50) {
        tendance = 'haussiere';
    }

    if (ema20 && ema50 && derniere.close < ema20 && ema20 < ema50) {
        tendance = 'baissiere';
    }

    let signalTechnique = 'attendre';

    if (
        tendance === 'haussiere' &&
        rsi !== null &&
        rsi < 70 &&
        macd.histogramme !== null &&
        macd.histogramme > 0
    ) {
        signalTechnique = 'acheter';
    }

    if (
        tendance === 'baissiere' &&
        rsi !== null &&
        rsi > 30 &&
        macd.histogramme !== null &&
        macd.histogramme < 0
    ) {
        signalTechnique = 'vendre';
    }

    return {
        ok: true,
        actif,
        symbole,
        intervalle,
        prix_actuel: arrondirPro(derniere.close),
        support_principal: arrondirPro(zones.support),
        resistance_principale: arrondirPro(zones.resistance),
        rsi: arrondirPro(rsi, 2),
        ema20: arrondirPro(ema20),
        ema50: arrondirPro(ema50),
        ema200: arrondirPro(ema200),
        macd: {
            macd: arrondirPro(macd.macd),
            signal: arrondirPro(macd.signal),
            histogramme: arrondirPro(macd.histogramme)
        },
        atr: arrondirPro(atr),
        volume: arrondirPro(derniere.volume, 2),
        volume_moyen_20: arrondirPro(moyennePro(volumes.slice(-20)), 2),
        tendance,
        signal_technique: signalTechnique,
        derniere_bougie: derniere,
        date_calcul: new Date().toISOString()
    };
}

function convertirImageEnDataUrlPro({ imageBase64, imageUrl, fileName }) {
    if (imageUrl) {
        return String(imageUrl);
    }

    if (imageBase64) {
        const image = String(imageBase64);

        if (image.startsWith('data:image/')) {
            return image;
        }

        return 'data:image/png;base64,' + image.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
    }

    if (fileName) {
        const validated = validateImageForAnalysis(fileName);
        const imageBuffer = fs.readFileSync(validated.filePath);
        const base64Image = imageBuffer.toString('base64');
        const mime = imageMimeType(validated.fileName);
        return `data:${mime};base64,${base64Image}`;
    }

    const erreur = new Error('Aucune image fournie. Envoyer imageBase64, imageUrl ou fileName.');
    erreur.httpStatus = 400;
    throw erreur;
}

function normaliserAnalyseVisionPro(raw, analyseTechnique) {
    const signalBrut = String(raw.signal || raw.decision || 'attendre').trim().toLowerCase();

    let signal = 'attendre';
    if (['acheter', 'buy', 'achat'].includes(signalBrut)) signal = 'acheter';
    if (['vendre', 'sell', 'vente'].includes(signalBrut)) signal = 'vendre';

    let confiance = Number(raw.confiance ?? raw.confidence ?? 0);
    if (!Number.isFinite(confiance)) confiance = 0;
    if (confiance <= 1) confiance = confiance * 100;
    confiance = Math.max(0, Math.min(100, Math.round(confiance)));

    return {
        ok: true,
        statut: 'ok',
        source: 'openai_vision_plus_binance',
        actif: analyseTechnique.actif,
        symbole: analyseTechnique.symbole,
        intervalle: analyseTechnique.intervalle,
        signal,
        decision: signal.toUpperCase(),
        confiance,
        tendance: raw.tendance || analyseTechnique.tendance || 'neutre',
        prix_actuel: analyseTechnique.prix_actuel,
        support_principal: analyseTechnique.support_principal,
        resistance_principale: analyseTechnique.resistance_principale,
        rsi: analyseTechnique.rsi,
        ema20: analyseTechnique.ema20,
        ema50: analyseTechnique.ema50,
        ema200: analyseTechnique.ema200,
        macd: analyseTechnique.macd,
        atr: analyseTechnique.atr,
        volume: analyseTechnique.volume,
        stop_loss: Number.isFinite(Number(raw.stop_loss)) ? Number(raw.stop_loss) : null,
        take_profit_1: Number.isFinite(Number(raw.take_profit_1)) ? Number(raw.take_profit_1) : null,
        take_profit_2: Number.isFinite(Number(raw.take_profit_2)) ? Number(raw.take_profit_2) : null,
        resume: String(raw.resume || raw.reasoning || raw.raison || '').trim(),
        raisons: Array.isArray(raw.raisons) ? raw.raisons : [],
        risques: Array.isArray(raw.risques) ? raw.risques : [],
        recommandations: Array.isArray(raw.recommandations) ? raw.recommandations : [],
        analyse_visuelle: raw.analyse_visuelle && typeof raw.analyse_visuelle === 'object' ? raw.analyse_visuelle : {},
        analyse_technique: analyseTechnique,
        avertissement: "Analyse technique informative. Ce n'est pas un conseil financier.",
        date: new Date().toISOString()
    };
}

async function analyserImageAvecOpenAIVisionPro({ imageBase64, imageUrl, fileName, analyseTechnique, configuration }) {
    if (!HAS_OPENAI_KEY) {
        const error = new Error('OPENAI_API_KEY absente sur le serveur Render.');
        error.httpStatus = 500;
        error.details = 'Ajoutez OPENAI_API_KEY dans les variables d’environnement Render, puis redéployez le service.';
        throw error;
    }

    const imageDataUrl = convertirImageEnDataUrlPro({ imageBase64, imageUrl, fileName });

    const prompt = `Tu es un analyste technique prudent.

Tu reçois :
1. une capture TradingView ;
2. des données OHLCV Binance calculées côté serveur.

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
- Ne donne pas d'ordre ferme.
- Ne promets jamais un gain.
- Ne donne pas de conseil financier personnalisé.`;

    const response = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        temperature: 0.15,
        max_tokens: 1400,
        response_format: { type: 'json_object' },
        messages: [
            {
                role: 'system',
                content: 'Tu retournes uniquement un JSON valide. Tu es prudent. Tu n’inventes jamais les prix.'
            },
            {
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    {
                        type: 'image_url',
                        image_url: {
                            url: imageDataUrl,
                            detail: 'high'
                        }
                    }
                ]
            }
        ]
    });

    const content = response?.choices?.[0]?.message?.content;

    if (!content) {
        throw new Error('OpenAI a retourné une réponse vide.');
    }

    const rawJson = extractJsonObject(content);
    return normaliserAnalyseVisionPro(rawJson, analyseTechnique);
}

// --- ROUTES API ---

/**
 * API : Santé du serveur
 */
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'Serveur actif',
        openaiKeyConfigured: HAS_OPENAI_KEY,
        model: OPENAI_MODEL,
        screenshotDir
    });
});

/**
 * API : Analyse de vision par IA
 * Fusionnée avec le debug pour plus de clarté
 */
app.post('/api/analyze-vision', async (req, res) => {
    const requestedFileName = req.body ? req.body.fileName : null;

    console.log('--- REQUÊTE ANALYSE IA SIMPLE ---');
    console.log('Nom reçu :', requestedFileName);

    try {
        const result = await analyzeImageFile(requestedFileName);
        res.json({ success: true, analysis: result.analysis, fileName: result.fileName });
    } catch (error) {
        console.error('ERREUR CRITIQUE API VISION :', error);
        const info = openAIErrorDetails(error);

        res.status(error.httpStatus || 500).json({
            success: false,
            error: 'Échec de l\'analyse IA.',
            details: info.details,
            openaiStatus: info.status,
            model: OPENAI_MODEL
        });
    }
});

/**
 * API : Analyse de plusieurs captures par IA
 * Les images sont analysées une par une pour éviter de saturer OpenAI.
 */
app.post('/api/analyze-vision-batch', async (req, res) => {
    const requestedFileNames = Array.isArray(req.body?.fileNames) ? req.body.fileNames : [];
    const maxBatch = Number(process.env.MAX_BATCH_ANALYZE || 10);
    const cleanLimit = Number.isFinite(maxBatch) && maxBatch > 0 ? Math.min(maxBatch, 25) : 10;

    console.log('--- REQUÊTE ANALYSE IA MULTIPLE ---');
    console.log('Nombre reçu :', requestedFileNames.length);

    if (requestedFileNames.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'Aucun fichier reçu.',
            details: 'Envoyez un tableau fileNames contenant au moins une image.'
        });
    }

    if (requestedFileNames.length > cleanLimit) {
        return res.status(400).json({
            success: false,
            error: 'Trop de fichiers à analyser en une seule fois.',
            details: `Limite actuelle : ${cleanLimit} fichier(s). Modifiez MAX_BATCH_ANALYZE sur Render si nécessaire.`
        });
    }

    const results = [];
    let successCount = 0;
    let errorCount = 0;

    for (const requestedFileName of requestedFileNames) {
        try {
            const result = await analyzeImageFile(requestedFileName);
            successCount += 1;
            results.push({
                success: true,
                fileName: result.fileName,
                analysis: result.analysis
            });
        } catch (error) {
            errorCount += 1;
            const info = openAIErrorDetails(error);
            const safeName = safeFileName(requestedFileName) || String(requestedFileName || 'fichier inconnu');
            console.error('Erreur analyse batch pour', safeName, ':', info.details);
            results.push({
                success: false,
                fileName: safeName,
                error: 'Échec de l\'analyse IA.',
                details: info.details,
                openaiStatus: info.status
            });

            // Si OpenAI refuse pour quota ou clé, inutile de continuer : les autres images échoueront aussi.
            if (info.status === 401 || info.status === 429 || error.httpStatus === 500) {
                break;
            }
        }
    }

    res.json({
        success: errorCount === 0,
        partialSuccess: successCount > 0 && errorCount > 0,
        successCount,
        errorCount,
        totalRequested: requestedFileNames.length,
        analyzedCount: results.length,
        results,
        model: OPENAI_MODEL
    });
});

/**
 * API : Analyse technique seule
 * Ne consomme aucun crédit OpenAI.
 * Sert à vérifier Binance, RSI, EMA, MACD, ATR, support et résistance.
 */
app.post('/api/analyse-technique-pro', async (req, res) => {
    try {
        const { actif = 'BINANCE:BTCUSDT', intervalle = '1h', limite = 300 } = req.body || {};

        const symbole = normaliserActifPourBinancePro(actif);
        const intervalleBinance = convertirIntervallePourBinancePro(intervalle);
        const bougies = await recupererBougiesBinancePro(symbole, intervalleBinance, limite);

        const analyseTechnique = construireAnalyseTechniquePro({
            actif,
            symbole,
            intervalle: intervalleBinance,
            bougies
        });

        return res.json(analyseTechnique);

    } catch (error) {
        console.error('Erreur /api/analyse-technique-pro :', error);

        return res.status(500).json({
            ok: false,
            statut: 'erreur',
            message: 'Échec de l’analyse technique.',
            details: error.message,
            date: new Date().toISOString()
        });
    }
});

/**
 * API : Analyse concrète Vision + Marché
 * Combine :
 * - capture TradingView ;
 * - données Binance ;
 * - RSI, EMA, MACD, ATR ;
 * - réponse JSON contrôlée.
 */
app.post('/api/analyze-vision-pro', async (req, res) => {
    try {
        const {
            actif = 'BINANCE:BTCUSDT',
            intervalle = '1h',
            limite = 300,
            imageBase64 = null,
            imageUrl = null,
            fileName = null,
            configuration = null
        } = req.body || {};

        const symbole = normaliserActifPourBinancePro(actif);
        const intervalleBinance = convertirIntervallePourBinancePro(intervalle);

        const bougies = await recupererBougiesBinancePro(symbole, intervalleBinance, limite);

        const analyseTechnique = construireAnalyseTechniquePro({
            actif,
            symbole,
            intervalle: intervalleBinance,
            bougies
        });

        if (!analyseTechnique.ok) {
            return res.status(400).json(analyseTechnique);
        }

        const analyseFinale = await analyserImageAvecOpenAIVisionPro({
            imageBase64,
            imageUrl,
            fileName,
            analyseTechnique,
            configuration
        });

        if (fileName) {
            const safeName = safeFileName(fileName);
            if (safeName) {
                const filePath = path.join(screenshotDir, safeName);
                const jsonPath = jsonPathForImage(filePath);

                writeJsonIfPossible(jsonPath, (fileData) => {
                    fileData.ai_analysis_pro = analyseFinale;
                    fileData.ai_analysis_pro_date = new Date().toISOString();
                    fileData.ai_model = OPENAI_MODEL;
                });
            }
        }

        return res.json({
            ok: true,
            statut: 'ok',
            success: true,
            analysis: analyseFinale,
            analyse: analyseFinale,
            model: OPENAI_MODEL
        });

    } catch (error) {
        console.error('Erreur /api/analyze-vision-pro :', error);
        const info = openAIErrorDetails(error);

        return res.status(error.httpStatus || 500).json({
            ok: false,
            statut: 'erreur',
            success: false,
            message: 'Échec de l’analyse Vision + Marché.',
            details: info.details,
            openaiStatus: info.status,
            model: OPENAI_MODEL,
            date: new Date().toISOString()
        });
    }
});

/**
 * API : Lister toutes les captures
 */
app.get('/api/list', (req, res) => {
    fs.readdir(screenshotDir, (err, files) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: 'Impossible de lire le dossier.',
                details: err.message
            });
        }

        const images = files
            .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
            .sort((a, b) => b.localeCompare(a));

        res.json(images);
    });
});

/**
 * API : Sauvegarder une capture
 */
app.post('/api/save', (req, res) => {
    const { image, metadata } = req.body;
    if (!image) {
        return res.status(400).json({
            success: false,
            error: 'Données d\'image manquantes.'
        });
    }

    const timestamp = Date.now();
    const fileName = `chart_${timestamp}.png`;
    const filePath = path.join(screenshotDir, fileName);
    const base64Data = image.replace(/^data:image\/png;base64,/, '');

    fs.writeFile(filePath, base64Data, 'base64', (err) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: 'Erreur lors de la sauvegarde.',
                details: err.message
            });
        }

        const jsonPath = filePath.replace('.png', '.json');
        try {
            const data = metadata && typeof metadata === 'object' ? metadata : {};
            data.fileName = fileName;
            data.savedAt = new Date().toISOString();
            fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
            res.json({ success: true, filename: fileName });
        } catch (jsonErr) {
            res.status(500).json({
                success: false,
                error: 'Erreur écriture métadonnées.',
                details: jsonErr.message
            });
        }
    });
});

/**
 * API : Mettre à jour les notes
 */
app.post('/api/update-notes', (req, res) => {
    const requestedFileName = req.body ? req.body.fileName : null;
    const fileName = safeFileName(requestedFileName);
    const notes = req.body ? req.body.notes : '';

    if (!fileName || !fileName.toLowerCase().endsWith('.json')) {
        return res.status(400).json({
            success: false,
            error: 'Nom de fichier JSON invalide.'
        });
    }

    const filePath = path.join(screenshotDir, fileName);

    if (fs.existsSync(filePath)) {
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            const fileData = raw.trim() ? JSON.parse(raw) : {};
            fileData.notes = notes || '';
            fileData.notesUpdatedAt = new Date().toISOString();
            fs.writeFileSync(filePath, JSON.stringify(fileData, null, 2));
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({
                success: false,
                error: 'Erreur lors de la mise à jour.',
                details: err.message
            });
        }
    } else {
        res.status(404).json({
            success: false,
            error: 'Fichier introuvable.',
            details: `Le fichier ${fileName} est absent du dossier screenshots.`
        });
    }
});

/**
 * Route générique pour diagnostiquer les mauvaises URL API
 */
app.use('/api', (req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route API introuvable.',
        method: req.method,
        routeDemandee: req.originalUrl,
        routesDisponibles: [
            'GET /api/health',
            'GET /api/list',
            'POST /api/save',
            'POST /api/analyze-vision',
            'POST /api/analyze-vision-batch',
            'POST /api/analyse-technique-pro',
            'POST /api/analyze-vision-pro',
            'POST /api/update-notes'
        ]
    });
});

// --- DÉMARRAGE DU SERVEUR ---
app.listen(PORT, () => {
    console.log('===========================================');
    console.log('🚀 EXPERT TRADING PRO v2.0 - IA READY');
    console.log(`📍 Port : ${PORT}`);
    console.log(`📁 Stockage : ${screenshotDir}`);
    console.log(`🤖 Modèle OpenAI : ${OPENAI_MODEL}`);
    console.log(`🔑 OPENAI_API_KEY configurée : ${HAS_OPENAI_KEY ? 'OUI' : 'NON'}`);
    console.log('✅ Routes ajoutées : /api/analyse-technique-pro et /api/analyze-vision-pro');
    console.log('===========================================');
});
