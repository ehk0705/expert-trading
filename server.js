const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
// --- NOUVEAU : INTEGRATION IA ---
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// ---debug ---
app.post('/api/analyze-vision', async (req, res) => {
    const { fileName } = req.body;
    const filePath = path.join(screenshotDir, fileName);

    console.log("--- DEBUG ANALYSE ---");
    console.log("Fichier cible :", filePath);
    console.log("Existe ? :", fs.existsSync(filePath));

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Image introuvable." });
    }
    // ... reste du code
	

// --- CONFIGURATION IA ---
// Assurez-vous d'ajouter OPENAI_API_KEY dans vos variables d'environnement sur Render
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, 
});

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// --- GESTION DU RÉPERTOIRE DE STOCKAGE ---
const screenshotDir = path.join(__dirname, 'screenshots');

if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    console.log("Dossier 'screenshots' initialisé.");
}

app.use('/screenshots', express.static(screenshotDir));

// --- ROUTES API ---

/**
 * NOUVELLE API : Analyse de vision par IA
 * Lit le fichier image local et l'envoie à GPT-4o Vision
 */
app.post('/api/analyze-vision', async (req, res) => {
    const { fileName } = req.body;
    const filePath = path.join(screenshotDir, fileName);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Image introuvable pour analyse." });
    }

    try {
        // 1. Encodage de l'image locale en Base64 pour l'envoi
        const imageBuffer = fs.readFileSync(filePath);
        const base64Image = imageBuffer.toString('base64');

        // 2. Appel à l'API Vision
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: "Tu es un ingénieur financier expert en analyse technique. Ton rôle est d'analyser les graphiques TradingView."
                },
                {
                    role: "user",
                    content: [
                        { 
                            type: "text", 
                            text: `Analyse ce graphique. Détecte la tendance, les supports/résistances et le momentum. 
                                   Réponds UNIQUEMENT en format JSON strict comme suit : 
                                   {
                                     "decision": "ACHETER" ou "VENDRE" ou "ATTENDRE",
                                     "confidence": (nombre entre 0 et 100),
                                     "reasoning": "Explication technique courte (max 300 caractères)"
                                   }` 
                        },
                        {
                            type: "image_url",
                            image_url: { url: `data:image/png;base64,${base64Image}` }
                        }
                    ],
                },
            ],
            response_format: { type: "json_object" }
        });

        const analysis = JSON.parse(response.choices[0].message.content);

        // 3. Sauvegarder automatiquement l'analyse dans le fichier JSON correspondant
        const jsonPath = filePath.replace('.png', '.json');
        if (fs.existsSync(jsonPath)) {
            const fileData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            fileData.ai_analysis = analysis; // On stocke l'analyse pour la retrouver plus tard
            fs.writeFileSync(jsonPath, JSON.stringify(fileData, null, 2));
        }

        res.json({ success: true, analysis });

    } catch (error) {
        console.error("Erreur Vision IA:", error);
        res.status(500).json({ error: "Échec de l'analyse IA." });
    }
});

/**
 * API : Lister toutes les captures
 */
app.get('/api/list', (req, res) => {
    fs.readdir(screenshotDir, (err, files) => {
        if (err) return res.status(500).json({ error: "Impossible de lire le dossier." });
        const images = files
            .filter(f => f.toLowerCase().endsWith('.png'))
            .sort((a, b) => b.localeCompare(a));
        res.json(images);
    });
});

/**
 * API : Sauvegarder une capture et ses métadonnées
 */
app.post('/api/save', (req, res) => {
    const { image, metadata } = req.body;
    if (!image) return res.status(400).json({ error: "Données d'image manquantes." });

    const timestamp = Date.now();
    const fileName = `chart_${timestamp}.png`;
    const filePath = path.join(screenshotDir, fileName);
    const base64Data = image.replace(/^data:image\/png;base64,/, "");

    fs.writeFile(filePath, base64Data, 'base64', (err) => {
        if (err) return res.status(500).json({ error: "Erreur lors de la sauvegarde." });
        const jsonPath = filePath.replace('.png', '.json');
        try {
            fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2));
            res.json({ success: true, filename: fileName });
        } catch (jsonErr) {
            res.status(500).json({ error: "Image sauvegardée, erreur JSON." });
        }
    });
});

/**
 * API : Mettre à jour les notes d'une analyse technique
 */
app.post('/api/update-notes', (req, res) => {
    const { fileName, notes } = req.body;
    const filePath = path.join(screenshotDir, fileName);

    if (fs.existsSync(filePath)) {
        try {
            const fileData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            fileData.notes = notes;
            fs.writeFileSync(filePath, JSON.stringify(fileData, null, 2));
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: "Erreur lors de la mise à jour des notes." });
        }
    } else {
        res.status(404).json({ error: "Fichier introuvable." });
    }
});

// --- DÉMARRAGE DU SERVEUR ---
app.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(`🚀 EXPERT TRADING PRO v2.0 - IA READY`);
    console.log(`📍 Port : ${PORT}`);
    console.log(`🤖 IA : OpenAI GPT-4o Vision activée`);
    console.log(`===========================================`);
});