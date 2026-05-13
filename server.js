const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// MODIFICATION ICI : On sert les fichiers depuis la racine (.) et non plus /public
app.use(express.static(__dirname));

// Gestion du dossier screenshots
const screenshotDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir);
}

// API : Sauvegarder
app.post('/api/save', (req, res) => {
    const { image, metadata } = req.body;
    const base64Data = image.replace(/^data:image\/png;base64,/, "");
    const filename = `chart_${Date.now()}.png`;
    const filePath = path.join(screenshotDir, filename);

    fs.writeFile(filePath, base64Data, 'base64', (err) => {
        if (err) return res.status(500).json({ error: "Erreur écriture" });
        fs.writeFileSync(filePath.replace('.png', '.json'), JSON.stringify(metadata, null, 2));
        res.json({ success: true, filename });
    });
});

// API : Lister
app.get('/api/list', (req, res) => {
    fs.readdir(screenshotDir, (err, files) => {
        if (err) return res.status(500).json({ error: "Erreur lecture" });
        res.json(files.filter(f => f.endsWith('.png')));
    });
});

app.listen(PORT, () => console.log(`Serveur expert-trading actif sur le port ${PORT}`));