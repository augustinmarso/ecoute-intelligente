// =============================================================
// electron/main.js — Enveloppe application desktop
// Démarre le serveur Express EN INTERNE puis ouvre l'app dans une fenêtre
// native (pas de navigateur, pas de barre d'adresse). Une vraie app.
// =============================================================

const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');

// L'app packagée est en lecture seule (asar) : on écrit cache/ et data/ dans
// un SOUS-dossier dédié du dossier utilisateur (%APPDATA%/ecoute-intelligente/
// ei-store) — isolé des dossiers internes d'Electron (Cache, GPUCache…), qui
// entreraient en collision sur Windows (système de fichiers insensible à la
// casse). Doit être défini AVANT de require le serveur (lu à l'évaluation).
process.env.EI_DATA_ROOT = path.join(app.getPath('userData'), 'ei-store');

// Démarre le serveur intégré. Si le port est déjà pris (un `node server.js`
// tourne en parallèle), on réutilise l'instance existante au lieu d'échouer.
async function ensureServer() {
  const { startServer, PORT } = require('../server.js');
  try {
    await startServer(PORT);
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
  }
  return PORT;
}

function createWindow(port) {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#ECE2D2',
    title: 'Écoute Intelligente',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true, // barre de menus masquée (Alt pour l'afficher)
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });

  win.loadURL(`http://localhost:${port}`);

  // Les liens externes (ex. « ouvrir sur YouTube ») s'ouvrent dans le
  // navigateur système, pas dans une fenêtre de l'app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null); // pas de menu par défaut
  let port;
  try {
    port = await ensureServer();
  } catch (e) {
    console.error('Impossible de démarrer le serveur :', e.message);
    app.quit();
    return;
  }
  createWindow(port);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
