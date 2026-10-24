// =============================================================
// persist.js — Persistance locale de la progression
// Chargé EN PREMIER (avant app.js) : synchronise le localStorage avec le
// store disque du serveur (/api/state). Le fichier data/store.json devient la
// source de vérité durable ; le localStorage n'est plus qu'un cache navigateur.
//
// - Au chargement : hydrate le localStorage depuis le serveur (le disque gagne).
//   Premier lancement (store vide) : on POUSSE la progression déjà présente
//   dans le navigateur vers le disque (migration sans perte).
// - Ensuite : chaque écriture d'une clé « ei-* » est répercutée sur le disque
//   (débattue à 400 ms). Une suppression envoie null.
//
// L'hydratation utilise un XHR SYNCHRONE : app.js lit le localStorage dès son
// évaluation, il faut donc que les valeurs disque soient en place avant. En
// local (localhost) c'est instantané et invisible.
// =============================================================

(function () {
  if (window.EI_STATIC) return; // version en ligne : pas de store disque
  var EI = /^ei-/; // seules les clés de l'app sont persistées

  // --- 1. Hydratation (bloquante) ---
  var serverHadData = false;
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/state', false); // synchrone
    xhr.send();
    if (xhr.status === 200) {
      var data = JSON.parse(xhr.responseText || '{}');
      var keys = Object.keys(data);
      serverHadData = keys.length > 0;
      keys.forEach(function (k) {
        if (data[k] != null) {
          try { localStorage.setItem(k, data[k]); } catch (_) {}
        }
      });
    }
  } catch (_) { /* serveur injoignable : on reste en localStorage seul */ }

  // --- 2. Mise en miroir des écritures futures (débattue) ---
  var _set = localStorage.setItem.bind(localStorage);
  var _remove = localStorage.removeItem.bind(localStorage);
  var pending = {};
  var timer = null;

  function flush() {
    timer = null;
    var payload = pending;
    pending = {};
    try {
      fetch('/api/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(function () {});
    } catch (_) {}
  }

  function schedule(key, value) {
    if (!EI.test(key)) return; // on ne persiste que les clés de l'app
    pending[key] = value; // value === null => suppression côté serveur
    if (!timer) timer = setTimeout(flush, 400);
  }

  localStorage.setItem = function (k, v) { _set(k, v); schedule(k, String(v)); };
  localStorage.removeItem = function (k) { _remove(k); schedule(k, null); };

  // --- 3. Migration premier lancement : le disque est vide mais le navigateur
  // contient déjà une progression -> on la pousse une fois vers le disque. ---
  if (!serverHadData) {
    var migrate = {};
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (EI.test(key)) migrate[key] = localStorage.getItem(key);
    }
    if (Object.keys(migrate).length) {
      try {
        fetch('/api/state', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(migrate)
        }).catch(function () {});
      } catch (_) {}
    }
  }
})();
