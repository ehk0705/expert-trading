/*
    server.js corrigé
    - sert index.html et analyse.html
    - sauvegarde et liste les captures
    - /api/analyze-vision-pro accepte fileName
    - sources marché : Binance -> OKX -> CoinGecko
    - OpenAI compatible : responses.create ou chat.completions.create
    - gestion claire des erreurs 429 / quota OpenAI API insuffisant
*/

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(cors({ origin: "*", methods: ["GET", "POST", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json({ limit: "30mb" }));
app.use(express.urlencoded({ extended: true, limit: "30mb" }));

const PORT = process.env.PORT || 3000;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const SCREENSHOT_DIR = path.join(__dirname, "screenshots");

if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

app.use("/screenshots", express.static(SCREENSHOT_DIR));
app.use(express.static(__dirname));

function maintenantIso() { return new Date().toISOString(); }

function nettoyerNomFichier(nom) {
    return String(nom || "").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_").slice(0, 180);
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

function normaliserActif(actif) {
    const v = String(actif || "BINANCE:BTCUSDT").toUpperCase();
    return (v.includes(":") ? v.split(":").pop() : v).replace("/", "").replace("-", "");
}

function intervalleBinance(i) {
    const v = String(i || "1h").toLowerCase();
    const t = { "1":"1m","5":"5m","15":"15m","30":"30m","60":"1h","240":"4h","d":"1d","D":"1d","w":"1w","W":"1w","1m":"1m","5m":"5m","15m":"15m","30m":"30m","1h":"1h","4h":"4h","1d":"1d","1w":"1w" };
    return t[v] || "1h";
}

function intervalleOKX(i) {
    const b = intervalleBinance(i);
    return ({ "1m":"1m","5m":"5m","15m":"15m","30m":"30m","1h":"1H","4h":"4H","1d":"1D","1w":"1W" })[b] || "1H";
}

function actifOKX(actif) {
    const s = normaliserActif(actif);
    if (s.endsWith("USDT")) return s.replace("USDT", "-USDT");
    if (s.endsWith("USD")) return s.replace("USD", "-USD");
    return "BTC-USDT";
}

function coinGeckoId(actif) {
    const s = normaliserActif(actif);
    return ({
        BTCUSDT:"bitcoin", BTCUSD:"bitcoin",
        ETHUSDT:"ethereum", ETHUSD:"ethereum",
        SOLUSDT:"solana", BNBUSDT:"binancecoin",
        XRPUSDT:"ripple", ADAUSDT:"cardano",
        DOGEUSDT:"dogecoin", AVAXUSDT:"avalanche-2",
        LINKUSDT:"chainlink", DOTUSDT:"polkadot"
    })[s] || "bitcoin";
}

function daysCoinGecko(i) {
    const b = intervalleBinance(i);
    if (["1m","5m","15m","30m"].includes(b)) return 1;
    if (["1h","4h"].includes(b)) return 14;
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
    if (!r.ok) throw new Error("Binance HTTP " + r.status + " : " + txt);
    const j = JSON.parse(txt);
    if (!Array.isArray(j)) throw new Error("Format Binance inattendu.");
    return j.map(k => ({ openTime:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5], closeTime:+k[6], source:"binance" }));
}

async function bougiesOKX(actif, intervalle, limit = 300) {
    const url = new URL("https://www.okx.com/api/v5/market/candles");
    url.searchParams.set("instId", actifOKX(actif));
    url.searchParams.set("bar", intervalleOKX(intervalle));
    url.searchParams.set("limit", String(Math.min(limit, 300)));
    const r = await fetch(url, { headers: { "Accept": "application/json", "User-Agent": "ExpertTradingPro/2.0" } });
    const txt = await r.text();
    if (!r.ok) throw new Error("OKX HTTP " + r.status + " : " + txt);
    const j = JSON.parse(txt);
    if (!j || j.code !== "0" || !Array.isArray(j.data)) throw new Error("Format OKX inattendu : " + txt);
    return j.data.map(k => ({ openTime:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5], closeTime:+k[0], source:"okx" })).sort((a,b)=>a.openTime-b.openTime);
}

async function bougiesCoinGecko(actif, intervalle, limit = 300) {
    const url = new URL(`https://api.coingecko.com/api/v3/coins/${coinGeckoId(actif)}/ohlc`);
    url.searchParams.set("vs_currency", "usd");
    url.searchParams.set("days", String(daysCoinGecko(intervalle)));
    const r = await fetch(url, { headers: { "Accept": "application/json", "User-Agent": "ExpertTradingPro/2.0" } });
    const txt = await r.text();
    if (!r.ok) throw new Error("CoinGecko HTTP " + r.status + " : " + txt);
    const j = JSON.parse(txt);
    if (!Array.isArray(j)) throw new Error("Format CoinGecko inattendu.");
    return j.slice(-limit).map(k => ({ openTime:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:0, closeTime:+k[0], source:"coingecko" }));
}

async function recupererBougiesMarche(actif, intervalle) {
    const erreurs = [];
    try { return { source:"binance", symbole:normaliserActif(actif), intervalle:intervalleBinance(intervalle), bougies:await bougiesBinance(actif, intervalle), erreurs }; }
    catch(e) { erreurs.push({ source:"binance", message:e.message }); }
    try { return { source:"okx", symbole:actifOKX(actif), intervalle:intervalleOKX(intervalle), bougies:await bougiesOKX(actif, intervalle), erreurs }; }
    catch(e) { erreurs.push({ source:"okx", message:e.message }); }
    try { return { source:"coingecko", symbole:coinGeckoId(actif), intervalle:"days="+daysCoinGecko(intervalle), bougies:await bougiesCoinGecko(actif, intervalle), erreurs }; }
    catch(e) { erreurs.push({ source:"coingecko", message:e.message }); }
    throw new Error("Aucune source de marché disponible : " + JSON.stringify(erreurs, null, 2));
}

function ema(values, p) {
    if (!values || values.length < p) return null;
    let e = moyenne(values.slice(0, p));
    const k = 2 / (p + 1);
    for (let i = p; i < values.length; i++) e = values[i] * k + e * (1 - k);
    return e;
}

function rsi(closes, p = 14) {
    if (!closes || closes.length <= p) return null;
    let gains = 0, pertes = 0;
    for (let i=1;i<=p;i++){ const d=closes[i]-closes[i-1]; if(d>=0) gains+=d; else pertes-=d; }
    let gm=gains/p, pm=pertes/p;
    for(let i=p+1;i<closes.length;i++){ const d=closes[i]-closes[i-1]; gm=((gm*(p-1))+(d>0?d:0))/p; pm=((pm*(p-1))+(d<0?-d:0))/p; }
    if(pm===0) return 100;
    const rs=gm/pm; return 100-(100/(1+rs));
}

function macd(closes) {
    if (!closes || closes.length < 35) return { macd:null, signal:null, histogramme:null };
    const series=[];
    for(let i=35;i<=closes.length;i++){ const s=closes.slice(0,i); const e12=ema(s,12), e26=ema(s,26); if(e12!==null&&e26!==null) series.push(e12-e26); }
    const m=series.at(-1) ?? null, sig=series.length>=9?ema(series,9):null;
    return { macd:m, signal:sig, histogramme:(m!==null&&sig!==null)?m-sig:null };
}

function atr(b, p=14) {
    if (!b || b.length <= p) return null;
    const tr=[];
    for(let i=1;i<b.length;i++) tr.push(Math.max(b[i].high-b[i].low, Math.abs(b[i].high-b[i-1].close), Math.abs(b[i].low-b[i-1].close)));
    return moyenne(tr.slice(-p));
}

function supports(b) {
    const z=b.slice(-80);
    if(z.length<20) return { support:null, resistance:null };
    const lows=z.map(x=>x.low).sort((a,b)=>a-b), highs=z.map(x=>x.high).sort((a,b)=>a-b);
    return { support:lows[Math.floor(lows.length*0.15)], resistance:highs[Math.floor(highs.length*0.85)] };
}

function analyseTechnique({ actif, intervalle, marche }) {
    const b=marche.bougies.filter(x=>Number.isFinite(x.close));
    if(b.length<30) throw new Error("Historique insuffisant.");
    const closes=b.map(x=>x.close), vols=b.map(x=>x.volume||0), last=b.at(-1);
    const e20=ema(closes,20), e50=ema(closes,50), e200=ema(closes,200), m=macd(closes), a=atr(b), s=supports(b), r=rsi(closes);
    let tendance="neutre";
    if(e20&&e50&&last.close>e20&&e20>e50) tendance="haussiere";
    if(e20&&e50&&last.close<e20&&e20<e50) tendance="baissiere";
    return {
        ok:true, actif, intervalle:marche.intervalle, source_marche:marche.source, symbole_marche:marche.symbole, erreurs_sources:marche.erreurs,
        prix_actuel:arrondir(last.close), support_principal:arrondir(s.support), resistance_principale:arrondir(s.resistance),
        rsi:arrondir(r,2), ema20:arrondir(e20), ema50:arrondir(e50), ema200:arrondir(e200),
        macd:{ macd:arrondir(m.macd), signal:arrondir(m.signal), histogramme:arrondir(m.histogramme) },
        atr:arrondir(a), volume:arrondir(last.volume,2), volume_moyen_20:arrondir(moyenne(vols.slice(-20)),2),
        tendance, signal_technique:"attendre", date_calcul:maintenantIso()
    };
}

let openaiClient = null;
function getOpenAIClient() {
    if (!process.env.OPENAI_API_KEY) {
        const e = new Error("OPENAI_API_KEY n'est pas configurée sur Render.");
        e.httpStatus = 500;
        throw e;
    }
    if (!openaiClient) {
        const OpenAI = require("openai");
        openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return openaiClient;
}

function extraireJson(txt) {
    txt=String(txt||"").trim();
    try { return JSON.parse(txt); } catch(e) {
        const a=txt.indexOf("{"), b=txt.lastIndexOf("}");
        if(a>=0&&b>a) return JSON.parse(txt.slice(a,b+1));
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
            input: [{ role:"user", content:[{type:"input_text", text:prompt}, {type:"input_image", image_url:imageBase64}] }]
        });
        return extraireJson(response.output_text || "");
    }

    if (client.chat && client.chat.completions && typeof client.chat.completions.create === "function") {
        const response = await client.chat.completions.create({
            model: OPENAI_MODEL,
            messages: [{ role:"user", content:[{type:"text", text:prompt}, {type:"image_url", image_url:{url:imageBase64}}] }],
            temperature: 0.2
        });
        return extraireJson(response.choices?.[0]?.message?.content || "");
    }

    throw new Error("Module OpenAI incompatible. Mettre openai à jour dans package.json.");
}

function normaliserDecision(j, t) {
    const sig = ["acheter","vendre","attendre"].includes(String(j.signal||j.decision||"attendre").toLowerCase()) ? String(j.signal||j.decision).toLowerCase() : "attendre";
    let conf = Number(j.confiance ?? j.confidence ?? 0); if(!Number.isFinite(conf)) conf=0; if(conf<=1) conf*=100;
    return {
        ok:true, statut:"ok", source:"openai_vision_plus_marche_multi_sources",
        source_marche:t.source_marche, symbole_marche:t.symbole_marche, erreurs_sources:t.erreurs_sources,
        actif:t.actif, intervalle:t.intervalle, signal:sig, decision:sig.toUpperCase(), confiance:arrondir(Math.max(0,Math.min(100,conf)),1),
        tendance:j.tendance||t.tendance, prix_actuel:t.prix_actuel, support_principal:t.support_principal, resistance_principale:t.resistance_principale,
        stop_loss:Number.isFinite(Number(j.stop_loss))?Number(j.stop_loss):null,
        take_profit_1:Number.isFinite(Number(j.take_profit_1))?Number(j.take_profit_1):null,
        take_profit_2:Number.isFinite(Number(j.take_profit_2))?Number(j.take_profit_2):null,
        resume:j.resume||j.raison||"", raisons:Array.isArray(j.raisons)?j.raisons:[], risques:Array.isArray(j.risques)?j.risques:[],
        recommandations:Array.isArray(j.recommandations)?j.recommandations:[], analyse_visuelle:j.analyse_visuelle||{}, analyse_technique:t,
        avertissement:"Analyse technique informative. Ce n'est pas un conseil financier.", date:maintenantIso()
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
        erreur_openai: String(error?.message || error?.error?.message || error || "Erreur OpenAI inconnue."),
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

app.get("/", (req,res)=>{
    const p=path.join(__dirname,"index.html");
    if(fs.existsSync(p)) return res.sendFile(p);
    res.json({ok:true,message:"Serveur actif, mais index.html est absent.",date:maintenantIso()});
});

app.get("/api/test",(req,res)=>res.json({ok:true,message:"API accessible",model:OPENAI_MODEL,openai_key_configuree:Boolean(process.env.OPENAI_API_KEY),date:maintenantIso()}));

app.get("/api/openai-diagnostic",(req,res)=>{
    try{
        const OpenAI=require("openai"); const c=new OpenAI({apiKey:process.env.OPENAI_API_KEY||"absente"});
        res.json({ok:true,openai_key_configuree:Boolean(process.env.OPENAI_API_KEY),model:OPENAI_MODEL,has_responses_create:Boolean(c.responses&&c.responses.create),has_chat_completions_create:Boolean(c.chat&&c.chat.completions&&c.chat.completions.create),date:maintenantIso()});
    }catch(e){res.status(500).json({ok:false,message:"Diagnostic impossible",details:e.message});}
});

app.get("/api/list",(req,res)=>{
    try{
        const files=fs.readdirSync(SCREENSHOT_DIR).filter(f=>/\.(png|jpg|jpeg|webp)$/i.test(f)).sort((a,b)=>fs.statSync(path.join(SCREENSHOT_DIR,b)).mtimeMs-fs.statSync(path.join(SCREENSHOT_DIR,a)).mtimeMs);
        res.json(files);
    }catch(e){res.status(500).json({ok:false,message:"Impossible de lister les captures",details:e.message});}
});

app.get("/api/check-screenshot",(req,res)=>{
    const fileName=nettoyerNomFichier(req.query.fileName||"");
    const imagePath=path.join(SCREENSHOT_DIR,fileName);
    const exists=!!fileName && fs.existsSync(imagePath);
    res.status(exists?200:404).json({ok:exists,fileName,exists,path:imagePath,date:maintenantIso()});
});

app.post("/api/save",(req,res)=>{
    try{
        const image=req.body.image||req.body.screenshot_base64;
        const metadata=req.body.metadata||{};
        if(!image || !String(image).includes("base64,")) return res.status(400).json({ok:false,message:"Image base64 absente."});
        const buffer=Buffer.from(String(image).split("base64,").pop(),"base64");
        const actif=nettoyerNomFichier(metadata.asset||"ACTIF");
        const intervalle=nettoyerNomFichier(metadata.interval||"INT");
        const stamp=new Date().toISOString().replace(/[:.]/g,"-");
        const pngName=`${actif}_${intervalle}_${stamp}.png`;
        const jsonName=pngName.replace(".png",".json");
        fs.writeFileSync(path.join(SCREENSHOT_DIR,pngName),buffer);
        fs.writeFileSync(path.join(SCREENSHOT_DIR,jsonName),JSON.stringify({...metadata, image_file:pngName, date:metadata.date||maintenantIso()},null,2),"utf-8");
        res.json({ok:true,success:true,message:"Capture enregistrée",fileName:pngName,jsonName,url:"/screenshots/"+encodeURIComponent(pngName)});
    }catch(e){res.status(500).json({ok:false,message:"Erreur sauvegarde",details:e.message});}
});

app.post("/api/update-notes",(req,res)=>{
    try{
        const fileName=nettoyerNomFichier(req.body.fileName||"");
        if(!fileName.endsWith(".json")) return res.status(400).json({ok:false,message:"Nom JSON invalide"});
        const p=path.join(SCREENSHOT_DIR,fileName);
        let obj={}; if(fs.existsSync(p)) obj=JSON.parse(fs.readFileSync(p,"utf-8"));
        obj.notes=String(req.body.notes||""); obj.date_update_notes=maintenantIso();
        fs.writeFileSync(p,JSON.stringify(obj,null,2),"utf-8");
        res.json({ok:true,success:true,message:"Notes archivées",fileName});
    }catch(e){res.status(500).json({ok:false,message:"Erreur archivage",details:e.message});}
});

app.post("/api/analyse-technique-pro", async (req,res)=>{
    try{
        const {actif="BINANCE:BTCUSDT", intervalle="1h"}=req.body||{};
        const marche=await recupererBougiesMarche(actif, intervalle);
        res.json(analyseTechnique({actif, intervalle, marche}));
    }catch(e){res.status(500).json({ok:false,message:"Échec analyse technique multi-sources.",details:e.message,date:maintenantIso()});}
});

app.post("/api/analyze-vision-pro", async (req,res)=>{
    try{
        const {actif="BINANCE:BTCUSDT", intervalle="1h", imageBase64=null, imageUrl=null, fileName=null, configuration=null}=req.body||{};
        let imageBase64Final=imageBase64 || null;
        if(!imageBase64Final && !imageUrl && fileName){
            const safe=nettoyerNomFichier(fileName);
            const p=path.join(SCREENSHOT_DIR,safe);
            if(!fs.existsSync(p)) return res.status(404).json({ok:false,message:"Capture introuvable sur le serveur.",details:"Le fichier n'existe pas dans /screenshots. Recréez une capture.",fileName:safe,date:maintenantIso()});
            imageBase64Final="data:image/png;base64,"+fs.readFileSync(p).toString("base64");
        }
        if(!imageBase64Final && !imageUrl) return res.status(400).json({ok:false,message:"Aucune image fournie.",details:"Envoyer fileName, imageBase64 ou imageUrl."});
        const marche=await recupererBougiesMarche(actif, intervalle);
        const tech=analyseTechnique({actif, intervalle, marche});
        const ia=await openaiVision({imageBase64:imageBase64Final||imageUrl, analyseTechnique:tech, configuration});
        const final=normaliserDecision(ia, tech);
        res.json({ok:true,statut:"ok",analysis:final,analyse:final});
    }catch(e){
        console.error("Erreur /api/analyze-vision-pro:", e);
        return reponseErreurOpenAI(res, e, "Échec de l'analyse Vision + Marché multi-sources.");
    }
});

app.post("/api/analyze-vision", async (req,res)=>{
    try{
        req.body = { ...(req.body||{}), actif:"BINANCE:BTCUSDT", intervalle:"1h", fileName:req.body.fileName };
        // Réutilisation simple
        const safe=nettoyerNomFichier(req.body.fileName||"");
        const p=path.join(SCREENSHOT_DIR,safe);
        if(!fs.existsSync(p)) return res.status(404).json({ok:false,message:"Capture introuvable",fileName:safe});
        const imageBase64="data:image/png;base64,"+fs.readFileSync(p).toString("base64");
        const marche=await recupererBougiesMarche("BINANCE:BTCUSDT","1h");
        const tech=analyseTechnique({actif:"BINANCE:BTCUSDT", intervalle:"1h", marche});
        const ia=await openaiVision({imageBase64, analyseTechnique:tech, configuration:{fileName:safe}});
        const final=normaliserDecision(ia, tech);
        res.json({ok:true,analysis:{decision:final.decision,confidence:final.confiance,reasoning:final.resume||final.raisons.join("\n"),details:final},analyse:final});
    }catch(e){
        console.error("Erreur /api/analyze-vision:", e);
        return reponseErreurOpenAI(res, e, "Erreur analyse IA simple.");
    }
});

app.post("/api/vider-captures", (req, res) => {
    try {
        const motDePasse = req.body.motDePasse;

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

        captures = [];

        return res.json({
            ok: true,
            message: "Toutes les captures ont été supprimées."
        });

    } catch (erreur) {
        return res.status(500).json({
            ok: false,
            message: "Erreur lors de la suppression des captures.",
            details: erreur.message
        });
    }
});

app.use((req,res)=>res.status(404).json({ok:false,message:"Route introuvable",methode:req.method,routeDemandee:req.originalUrl,date:maintenantIso()}));

app.listen(PORT,"0.0.0.0",()=>console.log("Serveur Expert Trading Pro actif sur port",PORT));
