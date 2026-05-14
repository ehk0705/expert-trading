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
    const confidence = Number.isFinite(confidenceNumber)
        ? Math.max(0, Math.min(100, Math.round(confidenceNumber)))
        : 0;

    const reasoning = String(
        analysis.reasoning ||
        analysis.raison ||
        'Aucune justification reçue.'
    ).trim();

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

/**
 * Détails d'erreur OpenAI
 * Correction importante :
 * - status = statut HTTP numérique : 400, 401, 403, 429, 500...
 * - code = code OpenAI : insufficient_quota, invalid_api_key...
 * - type = type OpenAI : invalid_request_error, rate_limit_error...
 * - details = message lisible
 */
function openAIErrorDetails(error) {
    const status =
        error.status ||
        error.response?.status ||
        error.httpStatus ||
        null;

    const code =
        error.code ||
        error.error?.code ||
        error.response?.data?.error?.code ||
        null;

    const type =
        error.type ||
        error.error?.type ||
        error.response?.data?.error?.type ||
        null;

    let details =
        error.details ||
        error.message ||
        error.error?.message ||
        error.response?.data?.error?.message ||
        'Erreur inconnue.';

    if (code === 'insufficient_quota') {
        details = 'Quota OpenAI insuffisant. Crédit API absent, épuisé ou facturation non activée.';
    } else if (code === 'invalid_api_key') {
        details = 'Clé OPENAI_API_KEY invalide.';
    } else if (status === 401) {
        details = 'Clé OpenAI invalide ou absente.';
    } else if (status === 403) {
        details = 'Accès OpenAI refusé. Vérifiez les droits du compte API ou la facturation.';
    } else if (status === 429) {
        details = 'Limite OpenAI atteinte : trop de requêtes, quota insuffisant ou limite de compte dépassée.';
    } else if (status === 400) {
        details = error.message || 'Requête OpenAI invalide. Vérifiez le modèle et le format de l’image.';
    }

    return {
        status,
        code,
        type,
        details
    };
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

    console.log(
        'Analyse reçue avec succès :',
        validated.fileName,
        analysis.decision,
        analysis.confidence + '%'
    );

    // 3. Sauvegarde dans le fichier JSON correspondant
    const jsonPath = jsonPathForImage(validated.filePath);
    writeJsonIfPossible(jsonPath, (fileData) => {
        fileData.ai_analysis = analysis;
        fileData.ai_analysis_date = new Date().toISOString();
        fileData.ai_model = OPENAI_MODEL;
    });

    return { fileName: validated.fileName, analysis };
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

        return res.json({
            success: true,
            analysis: result.analysis,
            fileName: result.fileName
        });

    } catch (error) {
        const info = openAIErrorDetails(error);

        console.error('ERREUR CRITIQUE API VISION :', {
            message: error.message,
            status: info.status,
            code: info.code,
            type: info.type,
            details: info.details
        });

        let message = "Échec de l'analyse IA.";

        if (info.code === "insufficient_quota") {
            message = "Quota OpenAI insuffisant. Ajoutez du crédit API ou vérifiez la facturation OpenAI.";
        } else if (info.code === "invalid_api_key") {
            message = "Clé OPENAI_API_KEY invalide.";
        } else if (info.status === 401) {
            message = "Clé OPENAI_API_KEY absente, invalide ou mal configurée dans Render.";
        } else if (info.status === 429) {
            message = "Limite OpenAI atteinte : trop de requêtes, quota insuffisant ou limite de compte dépassée.";
        } else if (info.status === 400) {
            message = "Requête OpenAI invalide. Vérifiez le modèle, le format de l'image ou le contenu envoyé.";
        } else if (info.status === 403) {
            message = "Accès OpenAI refusé. Vérifiez les droits du compte API ou la facturation.";
        } else if (!process.env.OPENAI_API_KEY) {
            message = "OPENAI_API_KEY n'est pas configurée dans les variables d'environnement Render.";
        }

        return res.status(info.status || error.httpStatus || 500).json({
            success: false,
            error: message,
            details: info.details || error.message || "Erreur inconnue.",
            openaiStatus: info.status || null,
            openaiCode: info.code || null,
            openaiType: info.type || null,
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

            console.error('Erreur analyse batch pour', safeName, ':', {
                status: info.status,
                code: info.code,
                type: info.type,
                details: info.details
            });

            results.push({
                success: false,
                fileName: safeName,
                error: 'Échec de l\'analyse IA.',
                details: info.details,
                openaiStatus: info.status,
                openaiCode: info.code,
                openaiType: info.type
            });

            // Si OpenAI refuse pour quota ou clé, inutile de continuer : les autres images échoueront aussi.
            if (
                info.status === 401 ||
                info.status === 403 ||
                info.status === 429 ||
                info.code === 'insufficient_quota' ||
                info.code === 'invalid_api_key' ||
                error.httpStatus === 500
            ) {
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

            res.json({
                success: true,
                filename: fileName
            });

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

            res.json({
                success: true
            });

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
    console.log('===========================================');
});