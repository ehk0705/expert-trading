
# Enrichissement TradingView IA

Ce paquet ajoute :

- OpenAI Vision ;
- Binance REST ;
- calculs techniques côté serveur ;
- réponse JSON contrôlée ;
- bouton d’analyse Vision + Marché dans `index.html` ;
- bouton d’analyse concrète dans `analyse.html`.

## Fichiers

- `server_additions.js` : bloc à coller dans `server.js`.
- `index_additions.html` : bloc à coller dans `index.html`.
- `analyse_additions.html` : bloc à coller dans `analyse.html`.

## Variables Render nécessaires

Dans Render, ajouter :

```text
OPENAI_API_KEY=ta_cle_api_openai
OPENAI_MODEL=gpt-4.1-mini
```

`OPENAI_MODEL` est optionnel.

## package.json

Vérifier que `openai` est présent :

```json
"openai": "^6.37.0"
```

Si absent :

```bash
npm install openai
```

## Test conseillé

1. Déployer `server.js`.
2. Ouvrir :

```text
https://ton-service-render.onrender.com/api/test
```

3. Tester la route technique depuis `index.html` :

```text
Tester analyse technique
```

4. Choisir un screenshot TradingView.
5. Cliquer sur :

```text
Analyse Vision + Marché
```

## Remarque importante

Le navigateur ne peut pas capturer directement le contenu interne du widget TradingView, car il est chargé depuis une origine externe protégée. La méthode fiable consiste à téléverser un screenshot PNG/JPEG/WebP.
