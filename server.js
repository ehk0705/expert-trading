/*
    server.js
    Expert Trading Pro v2.0

    Fonctionnalités :
    - Sert index.html et analyse.html
    - Connexion PostgreSQL Render
    - Crée / corrige la table trading_capture
    - Sauvegarde l'image du graphique + configuration_json
    - Liste les captures pour analyse.html
    - Analyse technique multi-sources : Binance -> OKX -> CoinGecko
    - Analyse Vision + Marché avec OpenAI
    - Suppression sécurisée des captures avec ADMIN_DELETE_PASSWORD
*/

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const app = express();

app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const PORT = process.env.PORT || 3000;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const SCREENSHOT_DIR = path.join(__dirname, "screenshots");

if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

/*
    Base PostgreSQL Render

    Priorité :
    1. DATABASE_URL
    2. expert-trading-db
    3. EXPERT_TRADING_DB

    Remarque :
    Un nom avec tiret fonctionne seulement avec process.env["expert-trading-db"].
*/
const DATABASE_URL =
    process.env.DATABASE_URL ||
    process.env["expert-trading-db"] ||
    process.env.EXPERT_TRADING_DB ||
    null;

const db = DATABASE_URL
    ? new Pool({
        connectionString: DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    })
    : null;

app.use("/screenshots", express.static(SCREENSHOT_DIR));
app.use(express.static(__dirname));

function maintenantIso() {
    return new Date().toISOString();
}

function nettoyerNomFichier(nom) {
    return String(nom || "")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .replace(/_+/g, "_")
        .slice(0, 180);
}

function arrondir(n, d = 4) {
    n = Number(n);
    if (!Number.isFinite(n)) return null;
    return Number(n.toFixed(d));
}

function moyenne(v) {
    const a = v.map(Number).filter(Number.isFinite);
    if (!a.length) return null;
    return a.reduce((x, y) => x + y, 0) / a.length;
}

function verifierDbConfiguree() {
    if (!db) {
        const erreur = new Error(
            "DATABASE_URL n'est pas configurée. Ajoutez DATABASE_URL dans Render avec l'URL PostgreSQL."
        );
        erreur.httpStatus = 500;
        throw erreur;
    }
}

async function initialiserTableTradingCapture() {
    verifierDbConfiguree();

    await db.query(`
        CREATE TABLE IF NOT EXISTS trading_capture (
            id SERIAL PRIMARY KEY,
            actif VARCHAR(100) NOT NULL,
            indicateur VARCHAR(100),
            intervalle VARCHAR(50),
            nom_fichier VARCHAR(255),
            configuration_json JSONB NOT NULL,
            screenshot_base64 TEXT,
            date_capture TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await db.query(`
        ALTER TABLE trading_capture
        ADD COLUMN IF NOT EXISTS nom_capture VARCHAR(255),
        ADD COLUMN IF NOT EXISTS categorie_analyse VARCHAR(100),
        ADD COLUMN IF NOT EXISTS actif_libelle VARCHAR(100),
        ADD COLUMN IF NOT EXISTS indicateur_libelle VARCHAR(100),
        ADD COLUMN IF NOT EXISTS intervalle_libelle VARCHAR(50),
        ADD COLUMN IF NOT EXISTS source_parametres VARCHAR(100),
        ADD COLUMN IF NOT EXISTS lecture_directe_graphique BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS type_bougie VARCHAR(50),
        ADD COLUMN IF NOT EXISTS type_bougie_libelle VARCHAR(100);
    `);

    await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_capture_nom_capture_unique
        ON trading_capture (nom_capture)
        WHERE nom_capture IS NOT NULL;
    `);
}

async function testerConnexionDb() {
    verifierDbConfiguree();
    const resultat = await db.query("SELECT NOW() AS maintenant;");
    return resultat.rows[0];
}

/* ============================================================
   Routes générales
============================================================ */

app.get("/", (req, res) => {
    const fichier = path.join(__dirname, "index.html");

    if (fs.existsSync(fichier)) {
        return res.sendFile(fichier);
    }

    return res.json({
        ok: true,
        message: "Serveur actif, mais index.html est absent.",
        date: maintenantIso()
    });
});

app.get("/api/test", (req, res) => {
    res.json({
        ok: true,
        message: "API accessible.",
        model: OPENAI_MODEL,
        openai_key_configuree: Boolean(process.env.OPENAI_API_KEY),
        database_url_configuree: Boolean(DATABASE_URL),
        date: maintenantIso()
    });
});

/* ============================================================
   Routes PostgreSQL
============================================================ */

app.get("/api/verifier-db", async (req, res) => {
    try {
        const resultat = await testerConnexionDb();

        res.json({
            ok: true,
            message: "Connexion PostgreSQL réussie.",
            database_url_configuree: Boolean(DATABASE_URL),
            maintenant: resultat.maintenant,
            date: maintenantIso()
        });
    } catch (erreur) {
        res.status(erreur.httpStatus || 500).json({
            ok: false,
            message: "Connexion PostgreSQL impossible.",
            details: erreur.message,
            database_url_configuree: Boolean(DATABASE_URL),
            date: maintenantIso()
        });
    }
});

app.get("/api/creer-table", async (req, res) => {
    try {
        await initialiserTableTradingCapture();

        res.json({
            ok: true,
            message: "Table trading_capture créée ou mise à jour.",
            date: maintenantIso()
        });
    } catch (erreur) {
        res.status(erreur.httpStatus || 500).json({
            ok: false,
            message: "Erreur création ou mise à jour de la table trading_capture.",
            details: erreur.message,
            date: maintenantIso()
        });
    }
});

app.get("/api/verifier-table", async (req, res) => {
    try {
        verifierDbConfiguree();

        const resultat = await db.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'trading_capture'
            ORDER BY ordinal_position;
        `);

        res.json({
            ok: true,
            table: "trading_capture",
            colonnes: resultat.rows,
            date: maintenantIso()
        });
    } catch (erreur) {
        res.status(erreur.httpStatus || 500).json({
            ok: false,
            message: "Impossible de vérifier la table trading_capture.",
            details: erreur.message,
            date: maintenantIso()
        });
    }
});

app.get("/api/verifier-captures", async (req, res) => {
    try {
        verifierDbConfiguree();

        const resultat = await db.query(`
            SELECT COUNT(*)::int AS total
            FROM trading_capture;
        `);

        res.json({
            ok: true,
            total: resultat.rows[0].total,
            date: maintenantIso()
        });
    } catch (erreur) {
        res.status(erreur.httpStatus || 500).json({
            ok: false,
            message: "Impossible de compter les captures.",
            details: erreur.message,
            date: maintenantIso()
        });
    }
});

app.get("/api/structure-table", async (req, res) => {
    try {
        verifierDbConfiguree();

        const resultat = await db.query(`
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = 'trading_capture'
            ORDER BY ordinal_position;
        `);

        res.json({
            ok: true,
            table: "trading_capture",
            structure: resultat.rows,
            date: maintenantIso()
        });
    } catch (erreur) {
        res.status(erreur.httpStatus || 500).json({
            ok: false,
            message: "Impossible de lire la structure de la table.",
            details: erreur.message,
            date: maintenantIso()
        });
    }
});

app.get("/api/contenu-table", async (req, res) => {
    try {
        verifierDbConfiguree();

        const resultat = await db.query(`
            SELECT 
                id,
                actif,
                indicateur,
                intervalle,
                nom_fichier,
                nom_capture,
                categorie_analyse,
                date_capture,
                CASE 
                    WHEN screenshot_base64 IS NULL THEN false
                    ELSE true
                END AS image_presente,
                configuration_json
            FROM trading_capture
            ORDER BY date_capture DESC
            LIMIT 20;
        `);

        res.json({
            ok: true,
            table: "trading_capture",
            captures: resultat.rows,
            date: maintenantIso()
        });
    } catch (erreur) {
        res.status(erreur.httpStatus || 500).json({
            ok: false,
            message: "Impossible de lire le contenu de la table.",
            details: erreur.message,
            date: maintenantIso()
        });
    }
});

/* ============================================================
   Captures PostgreSQL
============================================================ */

app.post("/api/captures", async (req, res) => {
    try {
        await initialiserTableTradingCapture();

        const body = req.body || {};

        const actif = body.actif || body.configuration_json?.actif || "NON_RENSEIGNE";
        const indicateur = body.indicateur || body.configuration_json?.indicateur || null;
        const intervalle = body.intervalle || body.configuration_json?.intervalle || null;

        const nom_fichier = body.nom_fichier || body.nom_capture || "capture-" + Date.now();
        const nom_capture = body.nom_capture || nom_fichier;

        const categorie_analyse =
            body.categorie_analyse ||
            body.categorieAnalyse ||
            body.configuration_json?.categorieAnalyseLibelle ||
            body.configuration_json?.categorieAnalyse ||
            null;

        const configuration_json =
            body.configuration_json ||
            body.configuration ||
            {
                actif,
                indicateur,
                intervalle,
                categorie_analyse,
                dateConfiguration: maintenantIso()
            };

        const screenshot_base64 =
            body.screenshot_base64 ||
            body.screenshotBase64 ||
            body.image ||
            body.configuration_json?.screenshot_base64 ||
            body.configuration_json?.snapshot?.screenshotBase64 ||
            null;

        const actif_libelle = body.actif_libelle || actif;
        const indicateur_libelle = body.indicateur_libelle || indicateur;
        const intervalle_libelle = body.intervalle_libelle || intervalle;

        const source_parametres =
            body.source_parametres ||
            configuration_json?.graphique?.source ||
            "lightweight_charts_canvas";

        const lecture_directe_graphique =
            body.lecture_directe_graphique === true ||
            body.lecture_directe_graphique === "true";

        const type_bougie =
            body.type_bougie ||
            configuration_json?.style ||
            null;

        const type_bougie_libelle =
            body.type_bougie_libelle ||
            configuration_json?.style ||
            null;

        const resultat = await db.query(
            `
            INSERT INTO trading_capture (
                actif,
                indicateur,
                intervalle,
                nom_fichier,
                nom_capture,
                categorie_analyse,
                actif_libelle,
                indicateur_libelle,
                intervalle_libelle,
                source_parametres,
                lecture_directe_graphique,
                type_bougie,
                type_bougie_libelle,
                configuration_json,
                screenshot_base64
            )
            VALUES (
                $1, $2, $3, $4, $5,
                $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15
            )
            ON CONFLICT (nom_capture)
            WHERE nom_capture IS NOT NULL
            DO UPDATE SET
                actif = EXCLUDED.actif,
                indicateur = EXCLUDED.indicateur,
                intervalle = EXCLUDED.intervalle,
                nom_fichier = EXCLUDED.nom_fichier,
                categorie_analyse = EXCLUDED.categorie_analyse,
                actif_libelle = EXCLUDED.actif_libelle,
                indicateur_libelle = EXCLUDED.indicateur_libelle,
                intervalle_libelle = EXCLUDED.intervalle_libelle,
                source_parametres = EXCLUDED.source_parametres,
                lecture_directe_graphique = EXCLUDED.lecture_directe_graphique,
                type_bougie = EXCLUDED.type_bougie,
                type_bougie_libelle = EXCLUDED.type_bougie_libelle,
                configuration_json = EXCLUDED.configuration_json,
                screenshot_base64 = EXCLUDED.screenshot_base64,
                date_capture = CURRENT_TIMESTAMP
            RETURNING 
                id,
                actif,
                indicateur,
                intervalle,
                nom_fichier,
                nom_capture,
                categorie_analyse,
                actif_libelle,
                indicateur_libelle,
                intervalle_libelle,
                source_parametres,
                lecture_directe_graphique,
                type_bougie,
                type_bougie_libelle,
                date_capture;
            `,
            [
                actif,
                indicateur,
                intervalle,
                nom_fichier,
                nom_capture,
                categorie_analyse,
                actif_libelle,
                indicateur_libelle,
                intervalle_libelle,
                source_parametres,
                lecture_directe_graphique,
                type_bougie,
                type_bougie_libelle,
                configuration_json,
                screenshot_base64
            ]
        );

        res.json({
            ok: true,
            statut: "ok",
            message: "Capture, image et configuration JSON enregistrées dans PostgreSQL.",
            capture: resultat.rows[0],
            image_presente: Boolean(screenshot_base64),
            configuration_presente: Boolean(configuration_json),
            date: maintenantIso()
        });

    } catch (erreur) {
        console.error("Erreur /api/captures POST :", erreur);

        res.status(erreur.httpStatus || 500).json({
            ok: false,
            statut: "erreur",
            message: "Erreur sauvegarde capture dans PostgreSQL.",
            details: erreur.message,
            date: maintenantIso()
        });
    }
});

app.get("/api/captures", async (req, res) => {
    try {
        await initialiserTableTradingCapture();

        const resultat = await db.query(`
            SELECT
                id,
                actif,
                indicateur,
                intervalle,
                nom_fichier,
                nom_capture,
                categorie_analyse,
                actif_libelle,
                indicateur_libelle,
                intervalle_libelle,
                source_parametres,
                lecture_directe_graphique,
                type_bougie,
                type_bougie_libelle,
                configuration_json,
                date_capture,
                CASE 
                    WHEN screenshot_base64 IS NULL THEN false
                    ELSE true
                END AS image_presente
            FROM trading_capture
            ORDER BY date_capture DESC
            LIMIT 100;
        `);

        res.json({
            ok: true,
            captures: resultat.rows,
            total: resultat.rows.length,
            date: maintenantIso()
        });

    } catch (erreur) {
        console.error("Erreur /api/captures GET :", erreur);

        res.status(erreur.httpStatus || 500).json({
            ok: false,
            message: "Impossible de lister les captures PostgreSQL.",
            details: erreur.message,
            date: maintenantIso()
        });
    }
});

app.get("/api/captures/:id", async (req, res) => {
    try {
        await initialiserTableTradingCapture();

        const id = Number(req.params.id);

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({
                ok: false,
                message: "ID de capture invalide."
            });
        }

        const resultat = await db.query(`
            SELECT
                id,
                actif,
                indicateur,
                intervalle,
                nom_fichier,
                nom_capture,
                categorie_analyse,
                actif_libelle,
                indicateur_libelle,
                intervalle_libelle,
                source_parametres,
                lecture_directe_graphique,
                type_bougie,
                type_bougie_libelle,
                configuration_json,
                screenshot_base64,
                date_capture
            FROM trading_capture
            WHERE id = $1;
        `, [id]);

        if (resultat.rows.length === 0) {
            return res.status(404).json({
                ok: false,
                message: "Capture introuvable.",
                id
            });
        }

        res.json({
            ok: true,
            capture: resultat.rows[0],
            date: maintenantIso()
        });

    } catch (erreur) {
        console.error("Erreur /api/captures/:id :", erreur);

        res.status(erreur.httpStatus || 500).json({
            ok: false,
            message: "Impossible de lire la capture.",
            details: erreur.message,
            date: maintenantIso()
        });
    }
});

async function viderCapturesPostgres(req, res) {
    try {
        verifierDbConfiguree();

        const motDePasse =
            req.body?.motDePasse ||
            req.body?.password ||
            req.query?.motDePasse ||
            req.query?.password ||
            "";

        if (!process.env.ADMIN_DELETE_PASSWORD) {
            return res.status(500).json({
                ok: false,
                message: "ADMIN_DELETE_PASSWORD n'est pas configuré sur Render."
            });
        }

        if (motDePasse !== process.env.ADMIN_DELETE_PASSWORD) {
            return res.status(403).json({
                ok: false,
                message: "Mot de passe incorrect."
            });
        }

        await initialiserTableTradingCapture();

        const resultat = await db.query(`
            DELETE FROM trading_capture;
        `);

        res.json({
            ok: true,
            message: "Toutes les captures PostgreSQL ont été supprimées.",
            lignes_supprimees: resultat.rowCount,
            date: maintenantIso()
        });

    } catch (erreur) {
        console.error("Erreur suppression captures :", erreur);

        res.status(erreur.httpStatus || 500).json({
            ok: false,
            message: "Erreur lors de la suppression des captures PostgreSQL.",
            details: erreur.message,
            date: maintenantIso()
        });
    }
}

app.post("/api/vider-captures", viderCapturesPostgres);
app.delete("/api/vider-captures", viderCapturesPostgres);
app.post("/api/vider-table", viderCapturesPostgres);
app.delete("/api/vider-table", viderCapturesPostgres);
app.post("/api/vider-trading-capture", viderCapturesPostgres);
app.delete("/api/vider-trading-capture", viderCapturesPostgres);

/* ============================================================
   Anciennes routes fichiers locaux
============================================================ */

app.get("/api/list", (req, res) => {
    try {
        const files = fs
            .readdirSync(SCREENSHOT_DIR)
            .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
            .sort((a, b) => {
                return fs.statSync(path.join(SCREENSHOT_DIR, b)).mtimeMs -
                       fs.statSync(path.join(SCREENSHOT_DIR, a)).mtimeMs;
            });

        res.json(files);
    } catch (erreur) {
        res.status(500).json({
            ok: false,
            message: "Impossible de lister les captures locales.",
            details: erreur.message
        });
    }
});

app.get("/api/check-screenshot", (req, res) => {
    const fileName = nettoyerNomFichier(req.query.fileName || "");
    const imagePath = path.join(SCREENSHOT_DIR, fileName);
    const exists = Boolean(fileName) && fs.existsSync(imagePath);

    res.status(exists ? 200 : 404).json({
        ok: exists,
        fileName,
        exists,
        path: imagePath,
        date: maintenantIso()
    });
});

app.post("/api/save", (req, res) => {
    try {
        const image = req.body.image || req.body.screenshot_base64;
        const metadata = req.body.metadata || {};

        if (!image || !String(image).includes("base64,")) {
            return res.status(400).json({
                ok: false,
                message: "Image base64 absente."
            });
        }

        const buffer = Buffer.from(String(image).split("base64,").pop(), "base64");

        const actif = nettoyerNomFichier(metadata.asset || "ACTIF");
        const intervalle = nettoyerNomFichier(metadata.interval || "INT");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");

        const pngName = `${actif}_${intervalle}_${stamp}.png`;
        const jsonName = pngName.replace(".png", ".json");

        fs.writeFileSync(path.join(SCREENSHOT_DIR, pngName), buffer);
        fs.writeFileSync(
            path.join(SCREENSHOT_DIR, jsonName),
            JSON.stringify({
                ...metadata,
                image_file: pngName,
                date: metadata.date || maintenantIso()
            }, null, 2),
            "utf-8"
        );

        res.json({
            ok: true,
            success: true,
            message: "Capture locale enregistrée.",
            fileName: pngName,
            jsonName,
            url: "/screenshots/" + encodeURIComponent(pngName)
        });

    } catch (erreur) {
        res.status(500).json({
            ok: false,
            message: "Erreur sauvegarde locale.",
            details: erreur.message
        });
    }
});

app.post("/api/update-notes", (req, res) => {
    try {
        const fileName = nettoyerNomFichier(req.body.fileName || "");

        if (!fileName.endsWith(".json")) {
            return res.status(400).json({
                ok: false,
                message: "Nom JSON invalide."
            });
        }

        const p = path.join(SCREENSHOT_DIR, fileName);

        let obj = {};
        if (fs.existsSync(p)) {
            obj = JSON.parse(fs.readFileSync(p, "utf-8"));
        }

        obj.notes = String(req.body.notes || "");
        obj.date_update_notes = maintenantIso();

        fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf-8");

        res.json({
            ok: true,
            success: true,
            message: "Notes archivées.",
            fileName
        });

    } catch (erreur) {
        res.status(500).json({
            ok: false,
            message: "Erreur archivage.",
            details: erreur.message
        });
    }
});

/* ============================================================
   Marché et analyse technique
============================================================ */

function normaliserActif(actif) {
    const v = String(actif || "BINANCE:BTCUSDT").toUpperCase();
    return (v.includes(":") ? v.split(":").pop() : v)
        .replace("/", "")
        .replace("-", "");
}

function intervalleBinance(i) {
    const v = String(i || "1h").toLowerCase();

    const t = {
        "1": "1m",
        "5": "5m",
        "15": "15m",
        "30": "30m",
        "60": "1h",
        "240": "4h",
        "d": "1d",
        "w": "1w",
        "m": "1M",
        "1m": "1m",
        "5m": "5m",
        "15m": "15m",
        "30m": "30m",
        "1h": "1h",
        "4h": "4h",
        "1d": "1d",
        "1w": "1w",
        "1M": "1M"
    };

    return t[v] || "1h";
}

function intervalleOKX(i) {
    const b = intervalleBinance(i);

    return {
        "1m": "1m",
        "5m": "5m",
        "15m": "15m",
        "30m": "30m",
        "1h": "1H",
        "4h": "4H",
        "1d": "1D",
        "1w": "1W",
        "1M": "1M"
    }[b] || "1H";
}

function actifOKX(actif) {
    const s = normaliserActif(actif);

    if (s.endsWith("USDT")) return s.replace("USDT", "-USDT");
    if (s.endsWith("USD")) return s.replace("USD", "-USD");

    return "BTC-USDT";
}

function coinGeckoId(actif) {
    const s = normaliserActif(actif);

    return {
        BTCUSDT: "bitcoin",
        BTCUSD: "bitcoin",
        ETHUSDT: "ethereum",
        ETHUSD: "ethereum",
        SOLUSDT: "solana",
        BNBUSDT: "binancecoin",
        XRPUSDT: "ripple",
        ADAUSDT: "cardano",
        DOGEUSDT: "dogecoin",
        AVAXUSDT: "avalanche-2",
        LINKUSDT: "chainlink",
        DOTUSDT: "polkadot"
    }[s] || "bitcoin";
}

function daysCoinGecko(i) {
    const b = intervalleBinance(i);

    if (["1m", "5m", "15m", "30m"].includes(b)) return 1;
    if (["1h", "4h"].includes(b)) return 14;
    if (b === "1d") return 180;

    return 90;
}

async function bougiesBinance(actif, intervalle, limit = 300) {
    const url = new URL("https://api.binance.com/api/v3/klines");

    url.searchParams.set("symbol", normaliserActif(actif));
    url.searchParams.set("interval", intervalleBinance(intervalle));
    url.searchParams.set("limit", String(limit));

    const r = await fetch(url);
    const txt = await r.text();

    if (!r.ok) {
        throw new Error("Binance HTTP " + r.status + " : " + txt);
    }

    const j = JSON.parse(txt);

    if (!Array.isArray(j)) {
        throw new Error("Format Binance inattendu.");
    }

    return j.map(k => ({
        openTime: +k[0],
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
        volume: +k[5],
        closeTime: +k[6],
        source: "binance"
    }));
}

async function bougiesOKX(actif, intervalle, limit = 300) {
    const url = new URL("https://www.okx.com/api/v5/market/candles");

    url.searchParams.set("instId", actifOKX(actif));
    url.searchParams.set("bar", intervalleOKX(intervalle));
    url.searchParams.set("limit", String(Math.min(limit, 300)));

    const r = await fetch(url, {
        headers: {
            "Accept": "application/json",
            "User-Agent": "ExpertTradingPro/2.0"
        }
    });

    const txt = await r.text();

    if (!r.ok) {
        throw new Error("OKX HTTP " + r.status + " : " + txt);
    }

    const j = JSON.parse(txt);

    if (!j || j.code !== "0" || !Array.isArray(j.data)) {
        throw new Error("Format OKX inattendu : " + txt);
    }

    return j.data.map(k => ({
        openTime: +k[0],
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
        volume: +k[5],
        closeTime: +k[0],
        source: "okx"
    })).sort((a, b) => a.openTime - b.openTime);
}

async function bougiesCoinGecko(actif, intervalle, limit = 300) {
    const url = new URL(
        `https://api.coingecko.com/api/v3/coins/${coinGeckoId(actif)}/ohlc`
    );

    url.searchParams.set("vs_currency", "usd");
    url.searchParams.set("days", String(daysCoinGecko(intervalle)));

    const r = await fetch(url, {
        headers: {
            "Accept": "application/json",
            "User-Agent": "ExpertTradingPro/2.0"
        }
    });

    const txt = await r.text();

    if (!r.ok) {
        throw new Error("CoinGecko HTTP " + r.status + " : " + txt);
    }

    const j = JSON.parse(txt);

    if (!Array.isArray(j)) {
        throw new Error("Format CoinGecko inattendu.");
    }

    return j.slice(-limit).map(k => ({
        openTime: +k[0],
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
        volume: 0,
        closeTime: +k[0],
        source: "coingecko"
    }));
}

async function recupererBougiesMarche(actif, intervalle) {
    const erreurs = [];

    try {
        return {
            source: "binance",
            symbole: normaliserActif(actif),
            intervalle: intervalleBinance(intervalle),
            bougies: await bougiesBinance(actif, intervalle),
            erreurs
        };
    } catch (erreur) {
        erreurs.push({
            source: "binance",
            message: erreur.message
        });
    }

    try {
        return {
            source: "okx",
            symbole: actifOKX(actif),
            intervalle: intervalleOKX(intervalle),
            bougies: await bougiesOKX(actif, intervalle),
            erreurs
        };
    } catch (erreur) {
        erreurs.push({
            source: "okx",
            message: erreur.message
        });
    }

    try {
        return {
            source: "coingecko",
            symbole: coinGeckoId(actif),
            intervalle: "days=" + daysCoinGecko(intervalle),
            bougies: await bougiesCoinGecko(actif, intervalle),
            erreurs
        };
    } catch (erreur) {
        erreurs.push({
            source: "coingecko",
            message: erreur.message
        });
    }

    throw new Error(
        "Aucune source de marché disponible : " +
        JSON.stringify(erreurs, null, 2)
    );
}

function ema(values, p) {
    if (!values || values.length < p) return null;

    let e = moyenne(values.slice(0, p));
    const k = 2 / (p + 1);

    for (let i = p; i < values.length; i++) {
        e = values[i] * k + e * (1 - k);
    }

    return e;
}

function rsi(closes, p = 14) {
    if (!closes || closes.length <= p) return null;

    let gains = 0;
    let pertes = 0;

    for (let i = 1; i <= p; i++) {
        const d = closes[i] - closes[i - 1];

        if (d >= 0) gains += d;
        else pertes -= d;
    }

    let gm = gains / p;
    let pm = pertes / p;

    for (let i = p + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];

        gm = ((gm * (p - 1)) + (d > 0 ? d : 0)) / p;
        pm = ((pm * (p - 1)) + (d < 0 ? -d : 0)) / p;
    }

    if (pm === 0) return 100;

    const rs = gm / pm;
    return 100 - (100 / (1 + rs));
}

function macd(closes) {
    if (!closes || closes.length < 35) {
        return {
            macd: null,
            signal: null,
            histogramme: null
        };
    }

    const series = [];

    for (let i = 35; i <= closes.length; i++) {
        const s = closes.slice(0, i);
        const e12 = ema(s, 12);
        const e26 = ema(s, 26);

        if (e12 !== null && e26 !== null) {
            series.push(e12 - e26);
        }
    }

    const m = series.at(-1) ?? null;
    const sig = series.length >= 9 ? ema(series, 9) : null;

    return {
        macd: m,
        signal: sig,
        histogramme: m !== null && sig !== null ? m - sig : null
    };
}

function atr(b, p = 14) {
    if (!b || b.length <= p) return null;

    const tr = [];

    for (let i = 1; i < b.length; i++) {
        tr.push(Math.max(
            b[i].high - b[i].low,
            Math.abs(b[i].high - b[i - 1].close),
            Math.abs(b[i].low - b[i - 1].close)
        ));
    }

    return moyenne(tr.slice(-p));
}

function supports(b) {
    const z = b.slice(-80);

    if (z.length < 20) {
        return {
            support: null,
            resistance: null
        };
    }

    const lows = z.map(x => x.low).sort((a, b) => a - b);
    const highs = z.map(x => x.high).sort((a, b) => a - b);

    return {
        support: lows[Math.floor(lows.length * 0.15)],
        resistance: highs[Math.floor(highs.length * 0.85)]
    };
}

function analyseTechnique({ actif, intervalle, marche }) {
    const b = marche.bougies.filter(x => Number.isFinite(x.close));

    if (b.length < 30) {
        throw new Error("Historique insuffisant.");
    }

    const closes = b.map(x => x.close);
    const vols = b.map(x => x.volume || 0);
    const last = b.at(-1);

    const e20 = ema(closes, 20);
    const e50 = ema(closes, 50);
    const e200 = ema(closes, 200);
    const m = macd(closes);
    const a = atr(b);
    const s = supports(b);
    const r = rsi(closes);

    let tendance = "neutre";

    if (e20 && e50 && last.close > e20 && e20 > e50) {
        tendance = "haussiere";
    }

    if (e20 && e50 && last.close < e20 && e20 < e50) {
        tendance = "baissiere";
    }

    return {
        ok: true,
        actif,
        intervalle: marche.intervalle,
        source_marche: marche.source,
        symbole_marche: marche.symbole,
        erreurs_sources: marche.erreurs,
        prix_actuel: arrondir(last.close),
        support_principal: arrondir(s.support),
        resistance_principale: arrondir(s.resistance),
        rsi: arrondir(r, 2),
        ema20: arrondir(e20),
        ema50: arrondir(e50),
        ema200: arrondir(e200),
        macd: {
            macd: arrondir(m.macd),
            signal: arrondir(m.signal),
            histogramme: arrondir(m.histogramme)
        },
        atr: arrondir(a),
        volume: arrondir(last.volume, 2),
        volume_moyen_20: arrondir(moyenne(vols.slice(-20)), 2),
        tendance,
        signal_technique: "attendre",
        date_calcul: maintenantIso()
    };
}

app.post("/api/analyse-technique-pro", async (req, res) => {
    try {
        const {
            actif = "BINANCE:BTCUSDT",
            intervalle = "1h"
        } = req.body || {};

        const marche = await recupererBougiesMarche(actif, intervalle);
        const analyse = analyseTechnique({ actif, intervalle, marche });

        res.json(analyse);

    } catch (erreur) {
        res.status(500).json({
            ok: false,
            message: "Échec analyse technique multi-sources.",
            details: erreur.message,
            date: maintenantIso()
        });
    }
});

/* ============================================================
   OpenAI Vision
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

function extraireJson(txt) {
    txt = String(txt || "").trim();

    try {
        return JSON.parse(txt);
    } catch (erreur) {
        const a = txt.indexOf("{");
        const b = txt.lastIndexOf("}");

        if (a >= 0 && b > a) {
            return JSON.parse(txt.slice(a, b + 1));
        }

        throw new Error("Réponse IA non JSON : " + txt);
    }
}

async function openaiVision({ imageBase64, analyseTechnique, configuration }) {
    const client = getOpenAIClient();

    const prompt = `Tu es un analyste technique prudent. Analyse l'image et les données techniques. Réponds uniquement en JSON valide avec cette structure:
{"signal":"acheter | vendre | attendre","confiance":0,"tendance":"haussiere | baissiere | neutre","resume":"","raisons":[],"risques":[],"recommandations":[],"stop_loss":null,"take_profit_1":null,"take_profit_2":null,"analyse_visuelle":{"commentaire":""}}

Données techniques:
${JSON.stringify(analyseTechnique, null, 2)}

Configuration:
${JSON.stringify(configuration || {}, null, 2)}

N'invente jamais de prix. Si incertain, choisis attendre.`;

    if (client.responses && typeof client.responses.create === "function") {
        const response = await client.responses.create({
            model: OPENAI_MODEL,
            input: [{
                role: "user",
                content: [
                    {
                        type: "input_text",
                        text: prompt
                    },
                    {
                        type: "input_image",
                        image_url: imageBase64
                    }
                ]
            }]
        });

        return extraireJson(response.output_text || "");
    }

    if (
        client.chat &&
        client.chat.completions &&
        typeof client.chat.completions.create === "function"
    ) {
        const response = await client.chat.completions.create({
            model: OPENAI_MODEL,
            messages: [{
                role: "user",
                content: [
                    {
                        type: "text",
                        text: prompt
                    },
                    {
                        type: "image_url",
                        image_url: {
                            url: imageBase64
                        }
                    }
                ]
            }],
            temperature: 0.2
        });

        return extraireJson(response.choices?.[0]?.message?.content || "");
    }

    throw new Error("Module OpenAI incompatible. Mettre openai à jour dans package.json.");
}

function normaliserDecision(j, t) {
    const sig = ["acheter", "vendre", "attendre"].includes(
        String(j.signal || j.decision || "attendre").toLowerCase()
    )
        ? String(j.signal || j.decision).toLowerCase()
        : "attendre";

    let conf = Number(j.confiance ?? j.confidence ?? 0);

    if (!Number.isFinite(conf)) conf = 0;
    if (conf <= 1) conf *= 100;

    return {
        ok: true,
        statut: "ok",
        source: "openai_vision_plus_marche_multi_sources",
        source_marche: t.source_marche,
        symbole_marche: t.symbole_marche,
        erreurs_sources: t.erreurs_sources,
        actif: t.actif,
        intervalle: t.intervalle,
        signal: sig,
        decision: sig.toUpperCase(),
        confiance: arrondir(Math.max(0, Math.min(100, conf)), 1),
        tendance: j.tendance || t.tendance,
        prix_actuel: t.prix_actuel,
        support_principal: t.support_principal,
        resistance_principale: t.resistance_principale,
        stop_loss: Number.isFinite(Number(j.stop_loss)) ? Number(j.stop_loss) : null,
        take_profit_1: Number.isFinite(Number(j.take_profit_1)) ? Number(j.take_profit_1) : null,
        take_profit_2: Number.isFinite(Number(j.take_profit_2)) ? Number(j.take_profit_2) : null,
        resume: j.resume || j.raison || "",
        raisons: Array.isArray(j.raisons) ? j.raisons : [],
        risques: Array.isArray(j.risques) ? j.risques : [],
        recommandations: Array.isArray(j.recommandations) ? j.recommandations : [],
        analyse_visuelle: j.analyse_visuelle || {},
        analyse_technique: t,
        avertissement: "Analyse technique informative. Ce n'est pas un conseil financier.",
        date: maintenantIso()
    };
}

function estErreurQuotaOpenAI(error) {
    const message = String(error?.message || error?.error?.message || "").toLowerCase();
    const code = String(error?.code || error?.error?.code || "").toLowerCase();
    const type = String(error?.type || error?.error?.type || "").toLowerCase();
    const status = Number(error?.status || error?.httpStatus || error?.response?.status || 0);

    return (
        status === 429 ||
        code.includes("insufficient_quota") ||
        type.includes("insufficient_quota") ||
        message.includes("exceeded your current quota") ||
        message.includes("insufficient quota") ||
        message.includes("billing") ||
        message.includes("quota")
    );
}

function reponseErreurQuotaOpenAI(res, error) {
    return res.status(429).json({
        ok: false,
        statut: "quota_openai_insuffisant",
        message: "Quota OpenAI API insuffisant.",
        details:
            "Le compte OpenAI API utilisé par le serveur n'a plus de crédit disponible, " +
            "ou la clé API est liée à un projet sans quota actif.",
        erreur_openai: String(
            error?.message ||
            error?.error?.message ||
            error ||
            "Erreur OpenAI inconnue."
        ),
        solution:
            "Ajouter du crédit sur platform.openai.com, vérifier que la clé OPENAI_API_KEY de Render " +
            "appartient au bon projet OpenAI, puis redéployer le service Render.",
        verification: {
            billing: "https://platform.openai.com/settings/billing/overview",
            cle_render: "Render > Environment > OPENAI_API_KEY",
            modele: OPENAI_MODEL
        },
        model: OPENAI_MODEL,
        date: maintenantIso()
    });
}

function reponseErreurOpenAI(res, error, messageDefaut) {
    if (estErreurQuotaOpenAI(error)) {
        return reponseErreurQuotaOpenAI(res, error);
    }

    return res.status(error?.httpStatus || error?.status || 500).json({
        ok: false,
        statut: "erreur",
        message: messageDefaut,
        details: error?.message || String(error),
        model: OPENAI_MODEL,
        date: maintenantIso()
    });
}

app.get("/api/openai-diagnostic", (req, res) => {
    try {
        const OpenAI = require("openai");
        const c = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY || "absente"
        });

        res.json({
            ok: true,
            openai_key_configuree: Boolean(process.env.OPENAI_API_KEY),
            model: OPENAI_MODEL,
            has_responses_create: Boolean(c.responses && c.responses.create),
            has_chat_completions_create: Boolean(
                c.chat &&
                c.chat.completions &&
                c.chat.completions.create
            ),
            date: maintenantIso()
        });

    } catch (erreur) {
        res.status(500).json({
            ok: false,
            message: "Diagnostic OpenAI impossible.",
            details: erreur.message
        });
    }
});

app.post("/api/analyze-vision-pro", async (req, res) => {
    try {
        const {
            actif = "BINANCE:BTCUSDT",
            intervalle = "1h",
            imageBase64 = null,
            imageUrl = null,
            fileName = null,
            configuration = null
        } = req.body || {};

        let imageBase64Final = imageBase64 || null;

        if (!imageBase64Final && !imageUrl && fileName) {
            const safe = nettoyerNomFichier(fileName);
            const p = path.join(SCREENSHOT_DIR, safe);

            if (!fs.existsSync(p)) {
                return res.status(404).json({
                    ok: false,
                    message: "Capture introuvable sur le serveur.",
                    details: "Le fichier n'existe pas dans /screenshots. Recréez une capture.",
                    fileName: safe,
                    date: maintenantIso()
                });
            }

            imageBase64Final = "data:image/png;base64," +
                fs.readFileSync(p).toString("base64");
        }

        if (!imageBase64Final && !imageUrl) {
            return res.status(400).json({
                ok: false,
                message: "Aucune image fournie.",
                details: "Envoyer fileName, imageBase64 ou imageUrl."
            });
        }

        const marche = await recupererBougiesMarche(actif, intervalle);
        const tech = analyseTechnique({ actif, intervalle, marche });

        const ia = await openaiVision({
            imageBase64: imageBase64Final || imageUrl,
            analyseTechnique: tech,
            configuration
        });

        const final = normaliserDecision(ia, tech);

        res.json({
            ok: true,
            statut: "ok",
            analysis: final,
            analyse: final
        });

    } catch (erreur) {
        console.error("Erreur /api/analyze-vision-pro :", erreur);
        return reponseErreurOpenAI(
            res,
            erreur,
            "Échec de l'analyse Vision + Marché multi-sources."
        );
    }
});

app.post("/api/analyze-vision", async (req, res) => {
    try {
        const safe = nettoyerNomFichier(req.body.fileName || "");
        const p = path.join(SCREENSHOT_DIR, safe);

        if (!fs.existsSync(p)) {
            return res.status(404).json({
                ok: false,
                message: "Capture introuvable.",
                fileName: safe
            });
        }

        const imageBase64 = "data:image/png;base64," +
            fs.readFileSync(p).toString("base64");

        const marche = await recupererBougiesMarche("BINANCE:BTCUSDT", "1h");
        const tech = analyseTechnique({
            actif: "BINANCE:BTCUSDT",
            intervalle: "1h",
            marche
        });

        const ia = await openaiVision({
            imageBase64,
            analyseTechnique: tech,
            configuration: {
                fileName: safe
            }
        });

        const final = normaliserDecision(ia, tech);

        res.json({
            ok: true,
            analysis: {
                decision: final.decision,
                confidence: final.confiance,
                reasoning: final.resume || final.raisons.join("\n"),
                details: final
            },
            analyse: final
        });

    } catch (erreur) {
        console.error("Erreur /api/analyze-vision :", erreur);
        return reponseErreurOpenAI(
            res,
            erreur,
            "Erreur analyse IA simple."
        );
    }
});

/* ============================================================
   Erreur 404
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
            "GET /api/verifier-db",
            "GET /api/creer-table",
            "GET /api/verifier-table",
            "GET /api/verifier-captures",
            "GET /api/structure-table",
            "GET /api/contenu-table",
            "GET /api/captures",
            "GET /api/captures/:id",
            "POST /api/captures",
            "POST /api/analyse-technique-pro",
            "POST /api/analyze-vision-pro",
            "POST /api/vider-captures",
            "DELETE /api/vider-captures"
        ],
        date: maintenantIso()
    });
});

/* ============================================================
   Démarrage
============================================================ */

app.listen(PORT, "0.0.0.0", () => {
    console.log("Serveur Expert Trading Pro actif sur le port", PORT);
});