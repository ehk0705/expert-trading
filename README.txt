Correction style.css

Problème :
le fond du graphique était blanc comme le fond du canvas, ce qui rendait le graphique invisible.

Correction :
- fond de page gris bleuté ;
- fond du graphique sombre type TradingView ;
- bordure sombre du graphique ;
- filigrane discret ;
- boutons conservés ;
- structure CSS nettoyée.

Important :
si le JavaScript Lightweight Charts force encore le fond en blanc, il faut aussi remplacer dans index.html :

layout: {
    background: { color: '#131722' },
    textColor: '#d1d4dc'
},
grid: {
    vertLines: { color: '#2a2e39' },
    horzLines: { color: '#2a2e39' }
}
