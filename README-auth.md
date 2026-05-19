# Authentification Expert Trading

## Fichiers fournis

- `server.js` : version complète avec authentification JWT et table `app_user`.
- `index.html` : version complète avec écran de connexion.
- `auth-table.sql` : script SQL de création de la table utilisateur.
- `package-auth-ajout.json` : dépendances à ajouter si ton `package.json` existe déjà.

## Variables Render à ajouter

```text
JWT_SECRET=une_phrase_longue_et_unique
AUTH_ADMIN_USER=admin
AUTH_ADMIN_PASSWORD=mot_de_passe_solide
AUTH_TOKEN_EXPIRATION=8h
```

## Dépendances à installer

```bash
npm install bcryptjs jsonwebtoken
```

## Important

Le mot de passe n'est pas stocké en clair. Le serveur stocke seulement `password_hash` avec `bcryptjs`.

Au démarrage, si `AUTH_ADMIN_PASSWORD` est défini et que l'utilisateur n'existe pas encore, le serveur crée automatiquement l'utilisateur administrateur.

## Test rapide

Après déploiement Render :

1. Ouvre : `https://expert-trading.onrender.com/api/auth/init`
2. Ouvre : `https://expert-trading.onrender.com`
3. Connecte-toi avec `AUTH_ADMIN_USER` et `AUTH_ADMIN_PASSWORD`.
