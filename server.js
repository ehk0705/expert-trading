const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION DU CHEMIN LOCAL ---
// Utilisation du chemin absolu sur votre disque C:
const screenshotDir = "C:\\trading-screenshots"; 

// Création du dossier s'il n'existe pas
if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    console.log(`Dossier créé : ${screenshotDir}`);
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// On lie la route virtuelle /screenshots au dossier réel sur C:
app.use('/screenshots', express.static(screenshotDir));

// --- API ROUTES ---

// Lister les images depuis C:\trading-screenshots
app.get('/api/list', (req, res) => {
    fs.readdir(screenshotDir, (err, files) => {
        if (err) return res.status(500).json({ error: "Erreur lecture disque local" });
        const images = files
            .filter(f => f.toLowerCase().endsWith('.png'))
            .sort((a, b) => b.localeCompare(a));
        res.json(images);
    });
});

// Sauvegarder dans C:\trading-screenshots
app.post('/api/save', (req, res) => {
    const { image, metadata } = req.body;
    const timestamp = Date.now();
    const filename = `chart_${timestamp}.png`;
    const filePath = path.join(screenshotDir, filename);

    const base64Data = image.replace(/^data:image\/png;base64,/, "");
    
    fs.writeFile(filePath, base64Data, 'base64', (err) => {
        if (err) {
            console.error("Erreur écriture:", err);
            return res.status(500).json({ error: "Impossible d'écrire sur C:" });
        }
        
        const jsonPath = filePath.replace('.png', '.json');
        fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2));
        res.json({ success: true, filename });
    });
});

// Mettre à jour les notes
app.post('/api/update-notes', (req, res) => {
    const { fileName, notes } = req.body;
    const filePath = path.join(screenshotDir, fileName);

    if (fs.existsSync(filePath)) {
        try {
            const fileData = JSON.parse(fs.readFileSync(filePath));
            fileData.notes = notes;
            fs.writeFileSync(filePath, JSON.stringify(fileData, null, 2));
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: "Erreur modification JSON" });
        }
    } else {
        res.status(404).json({ error: "Fichier introuvable" });
    }
});

app.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(`STATION LOCALE ACTIVE`);
    console.log(`Stockage : ${screenshotDir}`);
    console.log(`URL : http://localhost:${PORT}`);
    console.log(`===========================================`);
});