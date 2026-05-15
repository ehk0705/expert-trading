style.css corrigé

Problème constaté :
le graphique était invisible, car le fond du graphique était trop sombre ou trop proche du fond des éléments affichés.

Correction :
- fond de page : gris bleuté moyen ;
- fond du graphique : gris très clair ;
- grille : gris plus foncé et visible ;
- texte du graphique : foncé ;
- bordure du graphique : plus nette.

Important :
si le graphique reste invisible, il faut aussi vérifier les couleurs JavaScript de Lightweight Charts dans index.html :
layout.background doit être #f3f6fb
grid doit être #aeb8c8
textColor doit être #111827
