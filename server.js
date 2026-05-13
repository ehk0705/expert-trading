const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000; // Important pour Render

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Servir les fichiers statiques (HTML, JS, CSS)
app.use(express.static(path.join(__dirname, 'public')));
// Servir le dossier des screenshots pour pouvoir les voir dans l'analyse
app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));

// S'assurer que le dossier screenshots existe
const screenshotDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir);
}

// API : Sauvegarder une capture
app.post('/api/save', (req, res) => {
    const { image, metadata } = req.body;
    const base64Data = image.replace(/^data:image\/png;base64,/, "");
    const filename = `chart_${Date.now()}.png`;
    const filePath = path.join(screenshotDir, filename);

    fs.writeFile(filePath, base64Data, 'base64', (err) => {
        if (err) return res.status(500).json({ error: "Erreur d'écriture" });
        
        // Sauvegarde des notes dans un fichier JSON associé
        const jsonPath = filePath.replace('.png', '.json');
        fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2));
        
        res.json({ success: true, filename });
    });
});

// API : Lister les images pour l'analyse
app.get('/api/list', (req, res) => {
    fs.readdir(screenshotDir, (err, files) => {
        if (err) return res.status(500).json({ error: "Impossible de lire le dossier" });
        const images = files.filter(f => f.endsWith('.png'));
        res.json(images);
    });
});

app.listen(PORT, () => console.log(`Serveur actif sur le port ${PORT}`));