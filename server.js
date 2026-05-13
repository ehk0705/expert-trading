const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration des middlewares
app.use(cors());
// Augmentation de la limite pour supporter les captures d'écran haute résolution
app.use(express.json({ limit: '50mb' }));

// Sert les fichiers statiques (index.html, analyse.html) depuis la racine
app.use(express.static(__dirname));

// Rend le dossier screenshots accessible publiquement
app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));

// Création récursive du dossier screenshots s'il n'existe pas
const screenshotDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
}

// --- ROUTES API ---

// API : Sauvegarder la capture et les métadonnées
app.post('/api/save', (req, res) => {
    const { image, metadata } = req.body;
    
    if (!image) {
        return res.status(400).json({ error: "Aucune image reçue" });
    }

    const base64Data = image.replace(/^data:image\/png;base64,/, "");
    const timestamp = Date.now();
    const filename = `chart_${timestamp}.png`;
    const filePath = path.join(screenshotDir, filename);

    // Sauvegarde de l'image
    fs.writeFile(filePath, base64Data, 'base64', (err) => {
        if (err) {
            console.error("Erreur d'écriture image:", err);
            return res.status(500).json({ error: "Erreur lors de l'enregistrement de l'image" });
        }
        
        // Sauvegarde des métadonnées (JSON)
        try {
            const jsonPath = filePath.replace('.png', '.json');
            fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2));
            res.json({ success: true, filename });
        } catch (jsonErr) {
            console.error("Erreur écriture JSON:", jsonErr);
            res.status(500).json({ error: "Image sauvée, mais erreur sur les métadonnées" });
        }
    });
});

// API : Lister les fichiers pour l'interface d'analyse
app.get('/api/list', (req, res) => {
    fs.readdir(screenshotDir, (err, files) => {
        if (err) {
            return res.status(500).json({ error: "Impossible de lire le dossier de captures" });
        }
        // On ne renvoie que les fichiers PNG, triés du plus récent au plus ancien
        const images = files
            .filter(f => f.endsWith('.png'))
            .sort((a, b) => b.localeCompare(a));
        res.json(images);
    });
});

// Démarrage du serveur
app.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(`Serveur EXPERT-TRADING actif sur le port ${PORT}`);
    console.log(`===========================================`);
});