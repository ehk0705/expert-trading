const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
// Render fournit le port via la variable d'environnement PORT
const PORT = process.env.PORT || 3000;

// --- MIDDLEWARES ---
app.use(cors());
// Augmentation de la limite pour les captures haute résolution (Base64)
app.use(express.json({ limit: '50mb' }));

// Sert les fichiers HTML/JS (index.html, analyse.html) depuis la racine
app.use(express.static(__dirname));

// --- GESTION DU RÉPERTOIRE DE STOCKAGE ---
const screenshotDir = path.join(__dirname, 'screenshots');

// Création récursive du dossier s'il n'existe pas au démarrage
if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    console.log("Dossier 'screenshots' initialisé.");
}

// Rend le dossier des captures accessible via l'URL /screenshots
app.use('/screenshots', express.static(screenshotDir));

// --- ROUTES API ---

/**
 * API : Lister toutes les captures
 * Utilisée par analyse.html pour afficher la galerie
 */
app.get('/api/list', (req, res) => {
    fs.readdir(screenshotDir, (err, files) => {
        if (err) {
            return res.status(500).json({ error: "Impossible de lire le dossier." });
        }
        // Filtre les fichiers PNG et les trie du plus récent au plus ancien
        const images = files
            .filter(f => f.toLowerCase().endsWith('.png'))
            .sort((a, b) => b.localeCompare(a));
        res.json(images);
    });
});

/**
 * API : Sauvegarder une capture et ses métadonnées
 * Reçoit l'image en Base64 et l'objet metadata (actif, intervalle, date)
 */
app.post('/api/save', (req, res) => {
    const { image, metadata } = req.body;

    if (!image) {
        return res.status(400).json({ error: "Données d'image manquantes." });
    }

    const timestamp = Date.now();
    const fileName = `chart_${timestamp}.png`;
    const filePath = path.join(screenshotDir, fileName);

    // Extraction des données Base64
    const base64Data = image.replace(/^data:image\/png;base64,/, "");

    // Écriture du fichier image
    fs.writeFile(filePath, base64Data, 'base64', (err) => {
        if (err) {
            console.error("Erreur écriture image:", err);
            return res.status(500).json({ error: "Erreur lors de la sauvegarde de l'image." });
        }

        // Création du fichier JSON correspondant pour les métadonnées
        const jsonPath = filePath.replace('.png', '.json');
        try {
            fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2));
            res.json({ success: true, filename: fileName });
        } catch (jsonErr) {
            console.error("Erreur écriture JSON:", jsonErr);
            res.status(500).json({ error: "Image sauvegardée, mais erreur métadonnées." });
        }
    });
});

/**
 * API : Mettre à jour les notes d'une analyse technique
 * Utilisée par le bouton "Enregistrer l'analyse" dans analyse.html
 */
app.post('/api/update-notes', (req, res) => {
    const { fileName, notes } = req.body;
    const filePath = path.join(screenshotDir, fileName);

    if (fs.existsSync(filePath)) {
        try {
            const fileData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            fileData.notes = notes; // Ajout ou mise à jour du champ 'notes'
            fs.writeFileSync(filePath, JSON.stringify(fileData, null, 2));
            res.json({ success: true });
        } catch (err) {
            console.error("Erreur MAJ Notes:", err);
            res.status(500).json({ error: "Erreur lors de la mise à jour des notes." });
        }
    } else {
        res.status(404).json({ error: "Fichier de métadonnées introuvable." });
    }
});

// --- DÉMARRAGE DU SERVEUR ---
app.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(`🚀 EXPERT TRADING PRO v2.0 - CLOUD READY`);
    console.log(`📍 Port : ${PORT}`);
    console.log(`📁 Stockage : ${screenshotDir}`);
    console.log(`===========================================`);
});