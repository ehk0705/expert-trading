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
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, 
});

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));
app.use('/screenshots', express.static(screenshotDir));

// --- ROUTES API ---

/**
 * API : Analyse de vision par IA
 * Fusionnée avec le debug pour plus de clarté
 */
app.post('/api/analyze-vision', async (req, res) => {
    const { fileName } = req.body;
    const filePath = path.join(screenshotDir, fileName);

    console.log("--- TENTATIVE D'ANALYSE IA ---");
    console.log("Fichier cible :", filePath);

    if (!fs.existsSync(filePath)) {
        console.error("ERREUR : Fichier introuvable sur le disque.");
        return res.status(404).json({ error: "Image introuvable pour analyse." });
    }

    try {
        // 1. Encodage de l'image locale en Base64
        const imageBuffer = fs.readFileSync(filePath);
        const base64Image = imageBuffer.toString('base64');

        console.log("Envoi à OpenAI GPT-4o...");

        // 2. Appel à l'API Vision
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: "Tu es un ingénieur financier expert. Analyse les graphiques TradingView avec précision."
                },
                {
                    role: "user",
                    content: [
                        { 
                            type: "text", 
                            text: `Analyse ce graphique. Détecte la tendance, les supports/résistances et le momentum. 
                                   Réponds UNIQUEMENT en format JSON strict comme suit : 
                                   {
                                     "decision": "ACHETER", "VENDRE" ou "ATTENDRE",
                                     "confidence": 85,
                                     "reasoning": "Texte court technique"
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
        console.log("Analyse reçue avec succès :", analysis.decision);

        // 3. Sauvegarde dans le fichier JSON correspondant
        const jsonPath = filePath.replace('.png', '.json');
        if (fs.existsSync(jsonPath)) {
            const fileData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            fileData.ai_analysis = analysis; 
            fs.writeFileSync(jsonPath, JSON.stringify(fileData, null, 2));
        }

        res.json({ success: true, analysis });

    } catch (error) {
        console.error("ERREUR CRITIQUE API VISION :", error.message);
        res.status(500).json({ 
            error: "Échec de l'analyse IA.", 
            details: error.message 
        });
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
 * API : Sauvegarder une capture
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
            res.status(500).json({ error: "Erreur écriture métadonnées." });
        }
    });
});

/**
 * API : Mettre à jour les notes
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
            res.status(500).json({ error: "Erreur lors de la mise à jour." });
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
    console.log(`📁 Stockage : ${screenshotDir}`);
    console.log(`===========================================`);
});