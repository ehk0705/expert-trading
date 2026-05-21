/*
    server-plus.js
    Expert Trading Pro v2.0

    Fichier fusionné à partir de :
    - server(16).js : authentification, multi-IA, protection API, PostgreSQL
    - server - light-chart.js : base historique light-chart, captures, analyse technique, routes PostgreSQL

    Fonctionnalités :
    - Sert index.html et analyse.html
    - Connexion PostgreSQL Render
    - Crée / corrige la table trading_capture
    - Sauvegarde l'image du graphique + configuration_json
    - Liste les captures pour analyse.html
    - Analyse technique multi-sources : OKX -> CoinGecko -> Binance
    - Analyse Vision + Marché avec OpenAI, Gemini, Mistral et Claude
    - Suppression sécurisée des captures avec ADMIN_DELETE_PASSWORD
*/

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();

app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET || null;
const AUTH_ADMIN_USER = process.env.AUTH_ADMIN_USER || "admin";
const AUTH_ADMIN_PASSWORD = process.env.AUTH_ADMIN_PASSWORD || null;
const AUTH_TOKEN_EXPIRATION = process.env.AUTH_TOKEN_EXPIRATION || "1h";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const MARKET_PRIMARY_SOURCE = String(process.env.MARKET_PRIMARY_SOURCE || "okx").toLowerCase();
const AI_PRIMARY_PROVIDER = String(process.env.AI_PRIMARY_PROVIDER || "openai").toLowerCase();
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || "pixtral-large-latest";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";

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
   Authentification utilisateur
============================================================ */

async function initialiserTableUtilisateurs() {
    verifierDbConfiguree();

    await db.query(`
        CREATE TABLE IF NOT EXISTS app_user (
            id SERIAL PRIMARY KEY,
            username VARCHAR(100) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            date_creation TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    if (AUTH_ADMIN_PASSWORD) {
        const existe = await db.query(
            "SELECT id FROM app_user WHERE username = $1 LIMIT 1;",
            [AUTH_ADMIN_USER]
        );

        if (existe.rows.length === 0) {
            const hash = await bcrypt.hash(AUTH_ADMIN_PASSWORD, 12);

            await db.query(
                `INSERT INTO app_user (username, password_hash)
                 VALUES ($1, $2);`,
                [AUTH_ADMIN_USER, hash]
            );

            console.log("Utilisateur administrateur créé :", AUTH_ADMIN_USER);
        }
    }
}

function verifierSecretJwt() {
    if (!JWT_SECRET) {
        const erreur = new Error("JWT_SECRET n'est pas configuré sur Render.");
        erreur.httpStatus = 500;
        throw erreur;
    }
}

function extraireToken(req) {
    const authorization = req.headers.authorization || "";

    if (authorization.startsWith("Bearer ")) {
        return authorization.slice(7).trim();
    }

    return "";
}

function authentifierToken(req, res, next) {
    try {
        verifierSecretJwt();

        const token = extraireToken(req);

        if (!token) {
            return res.status(401).json({
                ok: false,
                message: "Authentification requise."
            });
        }

        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (erreur) {
        return res.status(401).json({
            ok: false,
            message: "Session invalide ou expirée.",
            details: erreur.message
        });
    }
}

app.post("/api/auth/login", async (req, res) => {
    try {
        verifierDbConfiguree();
        verifierSecretJwt();
        await initialiserTableUtilisateurs();

        const username = String(req.body?.username || "").trim();
        const password = String(req.body?.password || "");

        if (!username || !password) {
            return res.status(400).json({
                ok: false,
                message: "Nom d'utilisateur et mot de passe requis."
            });
        }

        const resultat = await db.query(
            `SELECT id, username, password_hash, date_creation
             FROM app_user
             WHERE username = $1
             LIMIT 1;`,
            [username]
        );

        if (resultat.rows.length === 0) {
            return res.status(401).json({
                ok: false,
                message: "Identifiants incorrects."
            });
        }

        const utilisateur = resultat.rows[0];
        const motDePasseOk = await bcrypt.compare(password, utilisateur.password_hash);

        if (!motDePasseOk) {
            return res.status(401).json({
                ok: false,
                message: "Identifiants incorrects."
            });
        }

        const token = jwt.sign(
            {
                id: utilisateur.id,
                username: utilisateur.username
            },
            JWT_SECRET,
            {
                expiresIn: AUTH_TOKEN_EXPIRATION
            }
        );

        res.json({
            ok: true,
            message: "Connexion réussie.",
            token,
            utilisateur: {
                id: utilisateur.id,
                username: utilisateur.username,
                date_creation: utilisateur.date_creation
            },
            expiration: AUTH_TOKEN_EXPIRATION,
            date: maintenantIso()
        });
    } catch (erreur) {
        res.status(erreur.httpStatus || 500).json({
            ok: false,
            message: "Erreur lors de l'authentification.",
            details: erreur.message,
            date: maintenantIso()
        });
    }
});

app.get("/api/auth/me", authentifierToken, (req, res) => {
    res.json({
        ok: true,
        utilisateur: req.user,
        date: maintenantIso()
    });
});

app.get("/api/auth/init", async (req, res) => {
    try {
        await initialiserTableUtilisateurs();

        const total = await db.query("SELECT COUNT(*)::int AS total FROM app_user;");

        res.json({
            ok: true,
            message: "Table app_user créée ou vérifiée.",
            table: "app_user",
            total_utilisateurs: total.rows[0].total,
            admin_user_configure: Boolean(AUTH_ADMIN_USER),
            admin_password_configure: Boolean(AUTH_ADMIN_PASSWORD),
            jwt_secret_configure: Boolean(JWT_SECRET),
            date: maintenantIso()
        });
    } catch (erreur) {
        res.status(erreur.httpStatus || 500).json({
            ok: false,
            message: "Erreur initialisation authentification.",
            details: erreur.message,
            date: maintenantIso()
        });
    }
});

function protegerRoutesApi(req, res, next) {
    const routesPubliques = [
        "/api/auth/login",
        "/api/auth/init",
        "/api/test"
    ];

    if (routesPubliques.includes(req.path)) {
        return next();
    }

    return authentifierToken(req, res, next);
}

app.use("/api", protegerRoutesApi);

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
        market_primary_source: MARKET_PRIMARY_SOURCE,
        sources_non_crypto: ["yahoo"],
        ai_primary_provider: AI_PRIMARY_PROVIDER,
        openai_key_configuree: Boolean(process.env.OPENAI_API_KEY),
        gemini_key_configuree: Boolean(process.env.GEMINI_API_KEY),
        mistral_key_configuree: Boolean(process.env.MISTRAL_API_KEY),
        anthropic_key_configuree: Boolean(process.env.ANTHROPIC_API_KEY),
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
        await initialiserTableUtilisateurs();

        res.json({
            ok: true,
            message: "Tables trading_capture et app_user créées ou mises à jour.",
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
        await initialiserTableTradingCapture();

        const limite = Math.min(Math.max(parseInt(req.query.limit || "50", 10) || 50, 1), 200);

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
                date_capture,
                CASE
                    WHEN screenshot_base64 IS NULL THEN false
                    ELSE true
                END AS image_presente,
                CASE
                    WHEN screenshot_base64 IS NULL THEN 0
                    ELSE LENGTH(screenshot_base64)
                END AS taille_image_base64,
                configuration_json
            FROM trading_capture
            ORDER BY date_capture DESC
            LIMIT $1;
        `, [limite]);

        const total = await db.query(`
            SELECT COUNT(*)::int AS total
            FROM trading_capture;
        `);

        res.json({
            ok: true,
            table: "trading_capture",
            requete: "SELECT colonnes principales FROM trading_capture ORDER BY date_capture DESC",
            limite,
            total_table: total.rows[0].total,
            total_retourne: resultat.rows.length,
            captures: resultat.rows,
            date: maintenantIso()
        });
    } catch (erreur) {
        res.status(erreur.httpStatus || 500).json({
            ok: false,
            message: "Impossible de lire le contenu de la table trading_capture.",
            details: erreur.message,
            date: maintenantIso()
        });
    }
});

app.get("/api/contenu-table-complet", async (req, res) => {
    try {
        await initialiserTableTradingCapture();

        const limite = Math.min(Math.max(parseInt(req.query.limit || "10", 10) || 10, 1), 50);

        const resultat = await db.query(`
            SELECT *
            FROM trading_capture
            ORDER BY date_capture DESC
            LIMIT $1;
        `, [limite]);

        res.json({
            ok: true,
            table: "trading_capture",
            requete: "SELECT * FROM trading_capture ORDER BY date_capture DESC",
            avertissement: "Cette route retourne aussi screenshot_base64. La réponse peut être très volumineuse.",
            limite,
            total_retourne: resultat.rows.length,
            captures: resultat.rows,
            date: maintenantIso()
        });
    } catch (erreur) {
        res.status(erreur.httpStatus || 500).json({
            ok: false,
            message: "Impossible de lire le contenu complet de la table trading_capture.",
            details: erreur.message,
            date: maintenantIso()
        });
    }
});

app.get("/api/select-trading-capture", async (req, res) => {
    try {
        await initialiserTableTradingCapture();

        const limite = Math.min(Math.max(parseInt(req.query.limit || "50", 10) || 50, 1), 200);

        const resultat = await db.query(`
            SELECT
                id,
                actif,
                indicateur,
                intervalle,
                nom_capture,
                categorie_analyse,
                date_capture,
                configuration_json
            FROM trading_capture
            ORDER BY date_capture DESC
            LIMIT $1;
        `, [limite]);

        res.json({
            ok: true,
            message: "Résultat SELECT FROM trading_capture.",
            sql_execute: "SELECT id, actif, indicateur, intervalle, nom_capture, categorie_analyse, date_capture, configuration_json FROM trading_capture ORDER BY date_capture DESC",
            limite,
            lignes: resultat.rows,
            date: maintenantIso()
        });
    } catch (erreur) {
        res.status(erreur.httpStatus || 500).json({
            ok: false,
            message: "Erreur SELECT FROM trading_capture.",
            details: erreur.message,
            date: maintenantIso()
        });
    }
});

app.get("/api/capture-image/:id", async (req, res) => {
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
            SELECT id, nom_capture, screenshot_base64
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

        const capture = resultat.rows[0];

        if (!capture.screenshot_base64) {
            return res.status(404).json({
                ok: false,
                message: "La capture existe, mais elle ne contient pas d'image.",
                id
            });
        }

        res.json({
            ok: true,
            id: capture.id,
            nom_capture: capture.nom_capture,
            screenshot_base64: capture.screenshot_base64,
            date: maintenantIso()
        });
    } catch (erreur) {
        res.status(erreur.httpStatus || 500).json({
            ok: false,
            message: "Impossible de lire l'image de la capture.",
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

function prefixeActif(actif) {
    const v = String(actif || "").toUpperCase();
    return v.includes(":") ? v.split(":")[0] : "";
}

function estActifCrypto(actif) {
    const p = prefixeActif(actif);
    const s = normaliserActif(actif);

    if (["BINANCE", "OKX", "COINBASE", "KRAKEN", "BITSTAMP", "BYBIT"].includes(p)) {
        return true;
    }

    return /^(BTC|ETH|SOL|BNB|XRP|ADA|DOGE|AVAX|LINK|DOT|LTC|BCH|MATIC|TRX)(USDT|USD|USDC)$/.test(s);
}

function estActifForexOuMetaux(actif) {
    const p = prefixeActif(actif);
    const s = normaliserActif(actif);

    if (p === "OANDA" || p === "FX" || p === "FOREXCOM") return true;

    return /^(EUR|GBP|AUD|NZD|USD|CAD|CHF|JPY|XAU|XAG)(USD|EUR|GBP|AUD|NZD|CAD|CHF|JPY)$/.test(s);
}

function symboleYahoo(actif) {
    const s = normaliserActif(actif);
    const original = String(actif || "").toUpperCase();

    const correspondances = {
        XAUUSD: "XAUUSD=X",
        XAGUSD: "XAGUSD=X",
        EURUSD: "EURUSD=X",
        GBPUSD: "GBPUSD=X",
        USDJPY: "JPY=X",
        USDCAD: "CAD=X",
        USDCHF: "CHF=X",
        AUDUSD: "AUDUSD=X",
        NZDUSD: "NZDUSD=X"
    };

    if (correspondances[s]) return correspondances[s];

    if (estActifForexOuMetaux(actif)) {
        if (s.length === 6) return s + "=X";
        throw new Error("Symbole Forex ou métaux non reconnu pour Yahoo : " + actif);
    }

    if (original.includes(":")) {
        return original.split(":").pop();
    }

    return s;
}

function symboleStooq(actif) {
    const s = normaliserActif(actif);
    const original = String(actif || "").toUpperCase();

    const correspondances = {
        XAUUSD: "xauusd",
        XAGUSD: "xagusd",
        EURUSD: "eurusd",
        GBPUSD: "gbpusd",
        USDJPY: "usdjpy",
        USDCAD: "usdcad",
        USDCHF: "usdchf",
        AUDUSD: "audusd",
        NZDUSD: "nzdusd",
        SPX: "^spx",
        DXY: "dxy",
        AAPL: "aapl.us",
        TSLA: "tsla.us",
        NVDA: "nvda.us",
        MSFT: "msft.us",
        AMZN: "amzn.us",
        GOOGL: "googl.us",
        GOOG: "goog.us"
    };

    if (correspondances[s]) return correspondances[s];

    if (original.startsWith("NASDAQ:") || original.startsWith("NYSE:")) {
        return s.toLowerCase() + ".us";
    }

    if (estActifForexOuMetaux(actif) && s.length === 6) {
        return s.toLowerCase();
    }

    throw new Error("Symbole Stooq non reconnu pour : " + actif);
}

function intervalleYahoo(i) {
    const v = String(i || "1d").toLowerCase();

    if (v.includes("day") || v.includes("days")) return "1d";

    const t = {
        "1": "1m",
        "5": "5m",
        "15": "15m",
        "30": "30m",
        "60": "1h",
        "240": "1h",
        "d": "1d",
        "1d": "1d",
        "w": "1wk",
        "1w": "1wk",
        "m": "1mo",
        "1m": "1m",
        "5m": "5m",
        "15m": "15m",
        "30m": "30m",
        "1h": "1h",
        "4h": "1h"
    };

    return t[v] || "1d";
}

function rangeYahoo(i) {
    const v = String(i || "").toLowerCase();

    const m = v.match(/days\s*=\s*(\d+)/);
    if (m) return Math.max(1, Number(m[1])) + "d";

    const intervalle = intervalleYahoo(i);

    if (["1m", "5m", "15m", "30m"].includes(intervalle)) return "7d";
    if (intervalle === "1h") return "60d";
    if (intervalle === "1wk") return "2y";
    if (intervalle === "1mo") return "5y";

    return "1y";
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
    if (estActifCrypto(actif) && s.endsWith("USD")) return s.replace("USD", "-USD");

    throw new Error("OKX ne doit pas être utilisé pour cet actif non crypto ou non reconnu : " + actif);
}

function coinGeckoId(actif) {
    const s = normaliserActif(actif);

    const correspondances = {
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
    };

    if (!correspondances[s]) {
        throw new Error("CoinGecko ne doit pas être utilisé pour cet actif non crypto ou non reconnu : " + actif);
    }

    return correspondances[s];
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

function symbolesYahooPossibles(actif) {
    const principal = symboleYahoo(actif);
    const s = normaliserActif(actif);
    const liste = [principal];

    /*
        Certains symboles TradingView, surtout OANDA:XAUUSD et OANDA:XAGUSD,
        peuvent être refusés par Yahoo Finance selon la disponibilité du flux.
        On essaie donc le symbole spot puis le contrat futur Yahoo le plus courant.
    */
    if (s === "XAUUSD") liste.push("GC=F");
    if (s === "XAGUSD") liste.push("SI=F");

    return [...new Set(liste.filter(Boolean))];
}

async function bougiesYahoo(actif, intervalle, limit = 300) {
    const symboles = symbolesYahooPossibles(actif);
    const erreurs = [];

    for (const symbole of symboles) {
        try {
            const url = new URL(
                `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbole)}`
            );

            url.searchParams.set("range", rangeYahoo(intervalle));
            url.searchParams.set("interval", intervalleYahoo(intervalle));
            url.searchParams.set("includePrePost", "false");

            const r = await fetch(url, {
                headers: {
                    "Accept": "application/json",
                    "User-Agent": "ExpertTradingPro/2.0"
                }
            });

            const txt = await r.text();

            if (!r.ok) {
                throw new Error("Yahoo Finance HTTP " + r.status + " pour " + symbole + " : " + txt);
            }

            const j = JSON.parse(txt);
            const result = j?.chart?.result?.[0];

            if (!result || !Array.isArray(result.timestamp)) {
                const erreurYahoo = j?.chart?.error?.description || txt;
                throw new Error("Format Yahoo Finance inattendu pour " + symbole + " : " + erreurYahoo);
            }

            const quote = result.indicators?.quote?.[0] || {};
            const timestamps = result.timestamp || [];

            const bougies = timestamps.map((ts, index) => ({
                openTime: Number(ts) * 1000,
                open: Number(quote.open?.[index]),
                high: Number(quote.high?.[index]),
                low: Number(quote.low?.[index]),
                close: Number(quote.close?.[index]),
                volume: Number(quote.volume?.[index] || 0),
                closeTime: Number(ts) * 1000,
                source: "yahoo"
            })).filter(x =>
                Number.isFinite(x.open) &&
                Number.isFinite(x.high) &&
                Number.isFinite(x.low) &&
                Number.isFinite(x.close)
            );

            if (bougies.length < 30) {
                throw new Error("Historique Yahoo Finance insuffisant pour " + actif + " (" + symbole + ").");
            }

            bougies.forEach(b => {
                b.source = "yahoo";
                b.symboleSource = symbole;
            });

            return bougies.slice(-limit);
        } catch (erreur) {
            erreurs.push(erreur.message || String(erreur));
        }
    }

    throw new Error("Yahoo Finance indisponible pour " + actif + " : " + erreurs.join(" | "));
}

async function bougiesStooq(actif, intervalle, limit = 300) {
    /*
        Source de secours sans clé API.
        Utilisée surtout quand Yahoo Finance répond 429 Too Many Requests.
        Stooq fournit principalement des données quotidiennes ; l'intervalle demandé est donc ignoré ici.
    */
    const symbole = symboleStooq(actif);
    const url = new URL("https://stooq.com/q/d/l/");

    url.searchParams.set("s", symbole);
    url.searchParams.set("i", "d");

    const r = await fetch(url, {
        headers: {
            "Accept": "text/csv,text/plain,*/*",
            "User-Agent": "Mozilla/5.0 ExpertTradingPro/2.0"
        }
    });

    const txt = await r.text();

    if (!r.ok) {
        throw new Error("Stooq HTTP " + r.status + " : " + txt);
    }

    const lignes = txt.trim().split(/\r?\n/).filter(Boolean);

    if (lignes.length < 31 || !/^Date,/i.test(lignes[0])) {
        throw new Error("Format Stooq inattendu ou historique insuffisant pour " + actif + " (" + symbole + ") : " + txt.slice(0, 160));
    }

    const bougies = lignes.slice(1).map(ligne => {
        const colonnes = ligne.split(",");
        const date = colonnes[0];
        const open = Number(colonnes[1]);
        const high = Number(colonnes[2]);
        const low = Number(colonnes[3]);
        const close = Number(colonnes[4]);
        const volume = Number(colonnes[5] || 0);
        const temps = new Date(date + "T00:00:00Z").getTime();

        return {
            openTime: temps,
            open,
            high,
            low,
            close,
            volume: Number.isFinite(volume) ? volume : 0,
            closeTime: temps,
            source: "stooq"
        };
    }).filter(x =>
        Number.isFinite(x.openTime) &&
        Number.isFinite(x.open) &&
        Number.isFinite(x.high) &&
        Number.isFinite(x.low) &&
        Number.isFinite(x.close)
    );

    if (bougies.length < 30) {
        throw new Error("Historique Stooq insuffisant pour " + actif + " (" + symbole + ").");
    }

    return bougies.slice(-limit);
}

function sourceMarcheConfiguree() {
    const sources = ["okx", "coingecko", "binance", "yahoo", "stooq"];
    return sources.includes(MARKET_PRIMARY_SOURCE) ? MARKET_PRIMARY_SOURCE : "okx";
}

function ordreSourcesMarche(actif) {
    if (!estActifCrypto(actif)) {
        return ["yahoo", "stooq"];
    }

    const defaut = ["okx", "coingecko", "binance"];
    const principale = sourceMarcheConfiguree();

    if (principale === "yahoo") {
        return ["yahoo", ...defaut];
    }

    return [principale, ...defaut.filter(x => x !== principale)];
}

function enrichirErreurSourceMarche(source, erreur) {
    const message = erreur.message || String(erreur);
    const restrictionGeographique =
        message.includes("HTTP 451") ||
        message.toLowerCase().includes("restricted location") ||
        message.toLowerCase().includes("service unavailable from a restricted location");

    const limiteRequetes =
        message.includes("HTTP 429") ||
        message.toLowerCase().includes("too many requests") ||
        message.toLowerCase().includes("rate limit");

    return {
        source,
        type: restrictionGeographique
            ? "restriction_geographique"
            : (limiteRequetes ? "limite_requetes" : "erreur_source"),
        bloquant: false,
        message
    };
}

async function essayerSourceMarche(source, actif, intervalle, erreurs) {
    if (source === "okx") {
        return {
            source: "okx",
            symbole: actifOKX(actif),
            intervalle: intervalleOKX(intervalle),
            bougies: await bougiesOKX(actif, intervalle),
            erreurs
        };
    }

    if (source === "coingecko") {
        return {
            source: "coingecko",
            symbole: coinGeckoId(actif),
            intervalle: "days=" + daysCoinGecko(intervalle),
            bougies: await bougiesCoinGecko(actif, intervalle),
            erreurs
        };
    }

    if (source === "binance") {
        return {
            source: "binance",
            symbole: normaliserActif(actif),
            intervalle: intervalleBinance(intervalle),
            bougies: await bougiesBinance(actif, intervalle),
            erreurs
        };
    }

    if (source === "yahoo") {
        return {
            source: "yahoo",
            symbole: symbolesYahooPossibles(actif).join(" | "),
            intervalle: intervalleYahoo(intervalle) + " / " + rangeYahoo(intervalle),
            bougies: await bougiesYahoo(actif, intervalle),
            erreurs
        };
    }

    if (source === "stooq") {
        return {
            source: "stooq",
            symbole: symboleStooq(actif),
            intervalle: "1d",
            bougies: await bougiesStooq(actif, intervalle),
            erreurs
        };
    }

    throw new Error("Source de marché inconnue : " + source);
}

async function recupererBougiesMarche(actif, intervalle) {
    const erreurs = [];
    const ordre = ordreSourcesMarche(actif);

    for (const source of ordre) {
        try {
            return await essayerSourceMarche(source, actif, intervalle, erreurs);
        } catch (erreur) {
            erreurs.push(enrichirErreurSourceMarche(source, erreur));
        }
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

function construirePromptAnalyseVision({ analyseTechnique, configuration }) {
    return `Tu es un analyste technique prudent. Analyse l'image et les données techniques. Réponds uniquement en JSON valide avec cette structure:
{"signal":"acheter | vendre | attendre","confiance":0,"tendance":"haussiere | baissiere | neutre","resume":"","raisons":[],"risques":[],"recommandations":[],"stop_loss":null,"take_profit_1":null,"take_profit_2":null,"analyse_visuelle":{"commentaire":""}}

Données techniques:
${JSON.stringify(analyseTechnique, null, 2)}

Configuration:
${JSON.stringify(configuration || {}, null, 2)}

N'invente jamais de prix. Si incertain, choisis attendre.`;
}

function estActifImageSeule(valeur) {
    const texte = String(valeur || "").trim().toUpperCase();

    return (
        !texte ||
        texte === "IMAGE_SEULE" ||
        texte === "IMAGE SEULE" ||
        texte === "IMAGE-ONLY" ||
        texte === "IMAGE_ONLY" ||
        texte === "NON_RENSEIGNE" ||
        texte === "N/A" ||
        texte.includes("A_LIRE_SUR_CAPTURE")
    );
}

function construirePromptAnalyseVisionSeule({ configuration }) {
    return `Tu es un analyste technique prudent. Tu reçois uniquement une image de graphique TradingView, sans données de marché externes fiables.

Objectif :
1. Lire visuellement l'image.
2. Tenter d'identifier les paramètres visibles :
   - symbole exact si visible, par exemple NASDAQ:MSFT, BINANCE:BTCUSDT, OANDA:XAUUSD ;
   - nom de l'actif si visible ;
   - intervalle ou unité de temps si visible ;
   - indicateurs visibles ;
   - type de graphique ;
   - tendance visuelle.
3. Donner une analyse prudente uniquement à partir de l'image.
4. Ne jamais inventer de prix exact si le prix n'est pas clairement lisible.

Réponds uniquement en JSON valide avec cette structure exacte :
{
  "signal": "acheter | vendre | attendre",
  "confiance": 0,
  "tendance": "haussiere | baissiere | neutre | indeterminee",
  "resume": "",
  "raisons": [],
  "risques": [],
  "recommandations": [],
  "stop_loss": null,
  "take_profit_1": null,
  "take_profit_2": null,
  "analyse_visuelle": {
    "commentaire": "",
    "symbole_visible": null,
    "actif_visible": null,
    "intervalle_visible": null,
    "indicateurs_visibles": [],
    "type_graphique_visible": null,
    "prix_lisible": null
  },
  "parametres_lus_image": {
    "symbole": null,
    "actif": null,
    "intervalle": null,
    "indicateurs": [],
    "type_graphique": null,
    "fiabilite": "faible | moyenne | forte"
  }
}

Configuration reçue :
${JSON.stringify(configuration || {}, null, 2)}

Règles :
- Si le symbole ou l'intervalle n'est pas clairement visible, mets null.
- Si l'image est insuffisante, choisis "attendre".
- Cette analyse ne doit pas prétendre utiliser Yahoo, Stooq, Binance, OKX, CoinGecko ou une autre source de marché.`;
}

async function analyseVisionSeule({ imageBase64, configuration }) {
    const prompt = construirePromptAnalyseVisionSeule({ configuration });
    const image = await preparerImagePourIA(imageBase64);
    const erreursIA = [];
    const ordre = ordreFournisseursIA();

    for (const provider of ordre) {
        if (!providerIAConfigure(provider)) {
            erreursIA.push({
                fournisseur: provider,
                ignore: true,
                message: "Clé API absente. Fournisseur ignoré."
            });
            continue;
        }

        try {
            const resultat = await appelerFournisseurIA(provider, {
                prompt,
                image
            });

            resultat._erreurs_ia = erreursIA;
            return resultat;
        } catch (erreur) {
            erreursIA.push({
                fournisseur: provider,
                message: erreur.message
            });
        }
    }

    const erreurFinale = new Error(
        "Aucun fournisseur IA disponible ou fonctionnel pour l'analyse Vision seule : " +
        JSON.stringify(erreursIA, null, 2)
    );
    erreurFinale.erreursIA = erreursIA;
    erreurFinale.httpStatus = 500;
    throw erreurFinale;
}

function normaliserDecisionVisionSeule(j, configuration = {}) {
    const sig = ["acheter", "vendre", "attendre"].includes(
        String(j.signal || j.decision || "attendre").toLowerCase()
    )
        ? String(j.signal || j.decision).toLowerCase()
        : "attendre";

    let conf = Number(j.confiance ?? j.confidence ?? 0);

    if (!Number.isFinite(conf)) conf = 0;
    if (conf <= 1) conf *= 100;

    const analyseVisuelle = j.analyse_visuelle || {};
    const parametresLus = j.parametres_lus_image || {
        symbole: analyseVisuelle.symbole_visible || null,
        actif: analyseVisuelle.actif_visible || null,
        intervalle: analyseVisuelle.intervalle_visible || null,
        indicateurs: Array.isArray(analyseVisuelle.indicateurs_visibles) ? analyseVisuelle.indicateurs_visibles : [],
        type_graphique: analyseVisuelle.type_graphique_visible || null,
        fiabilite: "faible"
    };

    return {
        ok: true,
        statut: "ok",
        mode: "vision_seule",
        source: "ia_vision_seule_image",
        fournisseur_ia: j._fournisseur_ia || "inconnu",
        modele_ia: j._modele_ia || null,
        erreurs_ia: Array.isArray(j._erreurs_ia) ? j._erreurs_ia : [],
        source_marche: "non_utilisee",
        symbole_marche: null,
        erreurs_sources: [],
        actif: parametresLus.symbole || parametresLus.actif || configuration?.actif || "IMAGE_SEULE",
        intervalle: parametresLus.intervalle || configuration?.intervalle || null,
        signal: sig,
        decision: sig.toUpperCase(),
        confiance: arrondir(Math.max(0, Math.min(100, conf)), 1),
        tendance: j.tendance || "indeterminee",
        prix_actuel: analyseVisuelle.prix_lisible || null,
        support_principal: null,
        resistance_principale: null,
        stop_loss: Number.isFinite(Number(j.stop_loss)) ? Number(j.stop_loss) : null,
        take_profit_1: Number.isFinite(Number(j.take_profit_1)) ? Number(j.take_profit_1) : null,
        take_profit_2: Number.isFinite(Number(j.take_profit_2)) ? Number(j.take_profit_2) : null,
        resume: j.resume || j.raison || "",
        raisons: Array.isArray(j.raisons) ? j.raisons : [],
        risques: Array.isArray(j.risques) ? j.risques : [],
        recommandations: Array.isArray(j.recommandations) ? j.recommandations : [],
        analyse_visuelle: analyseVisuelle,
        parametres_lus_image: parametresLus,
        analyse_technique: null,
        avertissement: "Analyse Vision seule informative. Les paramètres sont lus depuis l'image quand ils sont visibles. Ce n'est pas un conseil financier.",
        date: maintenantIso()
    };
}


function providerIAConfigure(provider) {
    if (provider === "openai") return Boolean(process.env.OPENAI_API_KEY);
    if (provider === "gemini") return Boolean(process.env.GEMINI_API_KEY);
    if (provider === "mistral") return Boolean(process.env.MISTRAL_API_KEY);
    if (provider === "claude") return Boolean(process.env.ANTHROPIC_API_KEY);
    return false;
}

function ordreFournisseursIA() {
    const defaut = ["openai", "gemini", "mistral", "claude"];
    const principal = ["openai", "gemini", "mistral", "claude"].includes(AI_PRIMARY_PROVIDER)
        ? AI_PRIMARY_PROVIDER
        : "openai";

    return [principal, ...defaut.filter(x => x !== principal)];
}

function extraireImageBase64(image) {
    const v = String(image || "");
    const m = v.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);

    if (m) {
        return {
            mediaType: m[1],
            base64: m[2],
            dataUrl: v
        };
    }

    return {
        mediaType: "image/png",
        base64: v.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, ""),
        dataUrl: v.startsWith("data:") ? v : "data:image/png;base64," + v
    };
}

async function imageUrlVersDataUrl(urlImage) {
    const r = await fetch(urlImage, {
        headers: {
            "User-Agent": "ExpertTradingPro/2.0"
        }
    });

    if (!r.ok) {
        throw new Error("Image URL HTTP " + r.status + " : " + await r.text());
    }

    const buffer = Buffer.from(await r.arrayBuffer());
    const mediaType = r.headers.get("content-type") || "image/png";

    return `data:${mediaType};base64,${buffer.toString("base64")}`;
}

async function preparerImagePourIA(imageBase64OuUrl) {
    const v = String(imageBase64OuUrl || "");

    if (/^https?:\/\//i.test(v)) {
        return extraireImageBase64(await imageUrlVersDataUrl(v));
    }

    return extraireImageBase64(v);
}

async function openaiVisionDepuisPrompt({ prompt, image }) {
    const client = getOpenAIClient();

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
                        image_url: image.dataUrl
                    }
                ]
            }]
        });

        const json = extraireJson(response.output_text || "");
        json._fournisseur_ia = "openai";
        json._modele_ia = OPENAI_MODEL;
        return json;
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
                            url: image.dataUrl
                        }
                    }
                ]
            }],
            temperature: 0.2
        });

        const json = extraireJson(response.choices?.[0]?.message?.content || "");
        json._fournisseur_ia = "openai";
        json._modele_ia = OPENAI_MODEL;
        return json;
    }

    throw new Error("Module OpenAI incompatible. Mettre openai à jour dans package.json.");
}

async function geminiVisionDepuisPrompt({ prompt, image }) {
    if (!process.env.GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY n'est pas configurée sur Render.");
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;

    const r = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            contents: [{
                role: "user",
                parts: [
                    { text: prompt },
                    {
                        inline_data: {
                            mime_type: image.mediaType,
                            data: image.base64
                        }
                    }
                ]
            }],
            generationConfig: {
                temperature: 0.2,
                response_mime_type: "application/json"
            }
        })
    });

    const txt = await r.text();

    if (!r.ok) {
        throw new Error("Gemini HTTP " + r.status + " : " + txt);
    }

    const data = JSON.parse(txt);
    const sortie = (data.candidates?.[0]?.content?.parts || [])
        .map(p => p.text || "")
        .join("\n")
        .trim();

    const json = extraireJson(sortie);
    json._fournisseur_ia = "gemini";
    json._modele_ia = GEMINI_MODEL;
    return json;
}

async function mistralVisionDepuisPrompt({ prompt, image }) {
    if (!process.env.MISTRAL_API_KEY) {
        throw new Error("MISTRAL_API_KEY n'est pas configurée sur Render.");
    }

    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + process.env.MISTRAL_API_KEY
        },
        body: JSON.stringify({
            model: MISTRAL_MODEL,
            temperature: 0.2,
            response_format: {
                type: "json_object"
            },
            messages: [{
                role: "user",
                content: [
                    {
                        type: "text",
                        text: prompt
                    },
                    {
                        type: "image_url",
                        image_url: image.dataUrl
                    }
                ]
            }]
        })
    });

    const txt = await r.text();

    if (!r.ok) {
        throw new Error("Mistral HTTP " + r.status + " : " + txt);
    }

    const data = JSON.parse(txt);
    const json = extraireJson(data.choices?.[0]?.message?.content || "");
    json._fournisseur_ia = "mistral";
    json._modele_ia = MISTRAL_MODEL;
    return json;
}

async function claudeVisionDepuisPrompt({ prompt, image }) {
    if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error("ANTHROPIC_API_KEY n'est pas configurée sur Render.");
    }

    const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
            model: ANTHROPIC_MODEL,
            max_tokens: 1200,
            temperature: 0.2,
            messages: [{
                role: "user",
                content: [
                    {
                        type: "text",
                        text: prompt
                    },
                    {
                        type: "image",
                        source: {
                            type: "base64",
                            media_type: image.mediaType,
                            data: image.base64
                        }
                    }
                ]
            }]
        })
    });

    const txt = await r.text();

    if (!r.ok) {
        throw new Error("Claude HTTP " + r.status + " : " + txt);
    }

    const data = JSON.parse(txt);
    const sortie = (data.content || [])
        .map(x => x.text || "")
        .join("\n")
        .trim();

    const json = extraireJson(sortie);
    json._fournisseur_ia = "claude";
    json._modele_ia = ANTHROPIC_MODEL;
    return json;
}

async function appelerFournisseurIA(provider, params) {
    if (provider === "openai") return openaiVisionDepuisPrompt(params);
    if (provider === "gemini") return geminiVisionDepuisPrompt(params);
    if (provider === "mistral") return mistralVisionDepuisPrompt(params);
    if (provider === "claude") return claudeVisionDepuisPrompt(params);

    throw new Error("Fournisseur IA inconnu : " + provider);
}

async function openaiVision({ imageBase64, analyseTechnique, configuration }) {
    const prompt = construirePromptAnalyseVision({ analyseTechnique, configuration });
    const image = await preparerImagePourIA(imageBase64);
    const erreursIA = [];
    const ordre = ordreFournisseursIA();

    for (const provider of ordre) {
        if (!providerIAConfigure(provider)) {
            erreursIA.push({
                fournisseur: provider,
                ignore: true,
                message: "Clé API absente. Fournisseur ignoré."
            });
            continue;
        }

        try {
            const resultat = await appelerFournisseurIA(provider, {
                prompt,
                image
            });

            resultat._erreurs_ia = erreursIA;
            return resultat;
        } catch (erreur) {
            erreursIA.push({
                fournisseur: provider,
                message: erreur.message
            });
        }
    }

    const erreurFinale = new Error(
        "Aucun fournisseur IA disponible ou fonctionnel : " +
        JSON.stringify(erreursIA, null, 2)
    );
    erreurFinale.erreursIA = erreursIA;
    erreurFinale.httpStatus = 500;
    throw erreurFinale;
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
        source: "ia_vision_plus_marche_multi_sources",
        fournisseur_ia: j._fournisseur_ia || "inconnu",
        modele_ia: j._modele_ia || null,
        erreurs_ia: Array.isArray(j._erreurs_ia) ? j._erreurs_ia : [],
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

app.get("/api/ai-diagnostic", (req, res) => {
    res.json({
        ok: true,
        market_primary_source: MARKET_PRIMARY_SOURCE,
        ai_primary_provider: AI_PRIMARY_PROVIDER,
        ordre_fournisseurs_ia: ordreFournisseursIA(),
        fournisseurs: {
            openai: {
                cle_configuree: Boolean(process.env.OPENAI_API_KEY),
                modele: OPENAI_MODEL
            },
            gemini: {
                cle_configuree: Boolean(process.env.GEMINI_API_KEY),
                modele: GEMINI_MODEL
            },
            mistral: {
                cle_configuree: Boolean(process.env.MISTRAL_API_KEY),
                modele: MISTRAL_MODEL
            },
            claude: {
                cle_configuree: Boolean(process.env.ANTHROPIC_API_KEY),
                modele: ANTHROPIC_MODEL
            }
        },
        note: "Les fournisseurs sans clé API sont ignorés automatiquement.",
        date: maintenantIso()
    });
});

function extraireErreursSourcesDepuisErreur(erreur) {
    if (!erreur) return [];

    const message = String(erreur.message || erreur || "");
    const debut = message.indexOf("[");
    const fin = message.lastIndexOf("]");

    if (debut >= 0 && fin > debut) {
        try {
            const erreurs = JSON.parse(message.slice(debut, fin + 1));
            if (Array.isArray(erreurs)) return erreurs;
        } catch (erreurJson) {
            return [{
                source: "marche",
                type: "erreur_source",
                bloquant: false,
                message
            }];
        }
    }

    return [{
        source: "marche",
        type: "erreur_source",
        bloquant: false,
        message
    }];
}

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
                    details: "Le fichier n'existe pas dans /screenshots. Recréez une capture ou envoyez imageBase64.",
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

        const configurationFinale = configuration || {};
        const actifFinal =
            actif ||
            configurationFinale?.actif ||
            configurationFinale?.graphique?.actif ||
            "IMAGE_SEULE";

        const intervalleFinal =
            intervalle ||
            configurationFinale?.intervalle ||
            configurationFinale?.graphique?.intervalle ||
            null;

        /*
            Cas important :
            Les captures issues de index_gr.html sont volontairement des images seules.
            Il ne faut pas appeler Yahoo, Stooq, Binance, OKX ou CoinGecko avec IMAGE_SEULE.
            On lance donc une analyse Vision seule et l'IA tente de lire le symbole,
            l'intervalle et les indicateurs directement depuis l'image.
        */
        if (estActifImageSeule(actifFinal) || configurationFinale?.type === "capture_image_seule") {
            const iaVisionSeule = await analyseVisionSeule({
                imageBase64: imageBase64Final || imageUrl,
                configuration: {
                    ...configurationFinale,
                    actif: "IMAGE_SEULE",
                    intervalle: intervalleFinal,
                    mode_analyse: "vision_seule"
                }
            });

            const finalVisionSeule = normaliserDecisionVisionSeule(iaVisionSeule, configurationFinale);

            return res.json({
                ok: true,
                statut: "ok",
                mode: "vision_seule",
                message: "Analyse Vision seule effectuée. Aucune source de marché externe n'a été appelée.",
                analysis: finalVisionSeule,
                analyse: finalVisionSeule,
                parametres_lus_image: finalVisionSeule.parametres_lus_image,
                avertissement: finalVisionSeule.avertissement,
                date: maintenantIso()
            });
        }

        let marche = null;
        let tech = null;
        let erreurMarche = null;

        try {
            marche = await recupererBougiesMarche(actifFinal, intervalleFinal || "1h");
            tech = analyseTechnique({
                actif: actifFinal,
                intervalle: intervalleFinal || "1h",
                marche
            });
        } catch (erreur) {
            erreurMarche = erreur;
            console.warn("Marché indisponible pour /api/analyze-vision-pro. Bascule en Vision seule :", erreur.message);
        }

        /*
            Correction importante :
            si Yahoo, Stooq, Binance, OKX ou CoinGecko échouent, l'analyse ne doit pas retourner 500.
            On continue avec une analyse Vision seule, en conservant l'erreur de marché comme avertissement.
        */
        if (!tech) {
            const iaVisionSeule = await analyseVisionSeule({
                imageBase64: imageBase64Final || imageUrl,
                configuration: {
                    ...configurationFinale,
                    actif: actifFinal,
                    intervalle: intervalleFinal,
                    mode_analyse: "vision_seule_marche_indisponible",
                    erreur_marche: erreurMarche ? erreurMarche.message : "Marché indisponible."
                }
            });

            const finalVisionSeule = normaliserDecisionVisionSeule(iaVisionSeule, {
                ...configurationFinale,
                actif: actifFinal,
                intervalle: intervalleFinal
            });

            finalVisionSeule.mode = "vision_seule_marche_indisponible";
            finalVisionSeule.actif = actifFinal;
            finalVisionSeule.intervalle = intervalleFinal;
            finalVisionSeule.erreurs_sources = extraireErreursSourcesDepuisErreur(erreurMarche);
            finalVisionSeule.avertissement =
                "Les sources de marché externes sont indisponibles. Analyse effectuée uniquement à partir de l'image. " +
                "Ce n'est pas un conseil financier.";

            return res.json({
                ok: true,
                statut: "ok",
                mode: "vision_seule_marche_indisponible",
                message: "Analyse Vision seule effectuée parce qu'aucune source de marché externe n'est disponible.",
                analysis: finalVisionSeule,
                analyse: finalVisionSeule,
                erreurs_sources: finalVisionSeule.erreurs_sources,
                avertissement: finalVisionSeule.avertissement,
                date: maintenantIso()
            });
        }

        const ia = await openaiVision({
            imageBase64: imageBase64Final || imageUrl,
            analyseTechnique: tech,
            configuration: configurationFinale
        });

        const final = normaliserDecision(ia, tech);

        res.json({
            ok: true,
            statut: "ok",
            mode: "vision_plus_marche",
            analysis: final,
            analyse: final,
            date: maintenantIso()
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
            "POST /api/auth/login",
            "GET /api/auth/me",
            "GET /api/auth/init",
            "GET /api/verifier-db",
            "GET /api/creer-table",
            "GET /api/verifier-table",
            "GET /api/verifier-captures",
            "GET /api/structure-table",
            "GET /api/contenu-table",
            "GET /api/contenu-table-complet",
            "GET /api/select-trading-capture",
            "GET /api/capture-image/:id",
            "GET /api/captures",
            "GET /api/captures/:id",
            "POST /api/captures",
            "POST /api/analyse-technique-pro",
            "POST /api/analyze-vision-pro",
            "GET /api/ai-diagnostic",
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

    if (db) {
        initialiserTableUtilisateurs().catch(erreur => {
            console.error("Initialisation app_user impossible :", erreur.message);
        });
    }
});
