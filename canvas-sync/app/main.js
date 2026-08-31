// CANVASync desktop shell.
//
// Thin Electron wrapper around the bridge: it provisions the data root on
// first run (so a friend can start from zero — no installer script needed),
// starts/owns the bridge process, and loads the dashboard the bridge serves
// at http://127.0.0.1:3847/app. All UI logic lives in bridge/public/ — the
// same dashboard works in a plain browser; this shell adds native powers
// (open/reveal files, bridge lifecycle, local-model download) via preload.

const { app, BrowserWindow, ipcMain, shell, dialog, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { localPythonStatus } = require('./local-python.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const BRIDGE_URL = 'http://127.0.0.1:3847';

// --- App-level config (which data root to use) ------------------------------

function appConfigPath() {
  return path.join(app.getPath('userData'), 'canvasync-app.json');
}

function loadAppConfig() {
  try { return JSON.parse(fs.readFileSync(appConfigPath(), 'utf8')); } catch { return {}; }
}

function saveAppConfig(cfg) {
  fs.mkdirSync(path.dirname(appConfigPath()), { recursive: true });
  fs.writeFileSync(appConfigPath(), JSON.stringify(cfg, null, 2));
}

// Must stay in step with ../data-root.js, which every non-Electron entry point
// uses. This file cannot import it — main.js is CommonJS and data-root.js is
// ESM — so the default and the legacy fallback are mirrored here by hand.
// Whatever this returns is exported as CANVAS_SYNC_HOME to the bridge (and
// through it to the pipeline scripts), so the app's answer governs the whole
// app-driven flow.
const DEFAULT_DATA_ROOT = path.join(os.homedir(), 'canvas-sync-data');
const LEGACY_DATA_ROOT  = path.join(os.homedir(), 'Documents', 'CANVASync');

function dataRoot() {
  const configured = loadAppConfig().dataRoot;
  if (configured) return configured;
  // Adopt a pre-move install rather than silently starting empty beside it,
  // but only while the new default does not exist yet.
  try {
    if (!fs.existsSync(DEFAULT_DATA_ROOT) &&
        fs.existsSync(path.join(LEGACY_DATA_ROOT, 'config.json'))) {
      return LEGACY_DATA_ROOT;
    }
  } catch { /* unreadable — fall through to the default */ }
  return DEFAULT_DATA_ROOT;
}

// --- First-run provisioning (replaces install.sh for app users) -------------

function provisionDataRoot() {
  const home = dataRoot();
  const configPath = path.join(home, 'config.json');
  fs.mkdirSync(path.join(home, 'classes'), { recursive: true });
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  try { fs.chmodSync(home, 0o700); } catch {}
  try { fs.writeFileSync(path.join(home, '.nogit'), ''); } catch {}
  if (!fs.existsSync(configPath)) {
    const config = {
      bridgeSecret: crypto.randomBytes(32).toString('hex'),
      maxIngestMb: 200,
      createdBy: 'canvasync-app',
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
  return home;
}

function bridgeSecret() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataRoot(), 'config.json'), 'utf8')).bridgeSecret ?? null;
  } catch {
    return null;
  }
}

// --- Bridge lifecycle -------------------------------------------------------

let bridgeChild = null;      // set only if WE spawned it
let bridgeExternal = false;  // true if something else already runs the bridge

function bridgeHealthy() {
  return new Promise((resolve) => {
    const req = http.get(`${BRIDGE_URL}/health`, {
      headers: { 'X-Bridge-Secret': bridgeSecret() ?? '' },
      timeout: 2500,
    }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function startBridge() {
  if (bridgeChild) return;
  // ELECTRON_RUN_AS_NODE makes Electron's own binary act as plain Node, so
  // app users don't need Node installed or on PATH.
  bridgeChild = spawn(process.execPath, [path.join(REPO_ROOT, 'bridge', 'server.js')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CANVAS_SYNC_HOME: dataRoot(),
    },
    stdio: 'ignore',
  });
  bridgeChild.on('exit', () => { bridgeChild = null; });
}

function stopBridge() {
  if (bridgeChild) {
    bridgeChild.kill('SIGTERM');
    bridgeChild = null;
  }
}

async function ensureBridge() {
  if (await bridgeHealthy()) { bridgeExternal = !bridgeChild; return true; }
  startBridge();
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await bridgeHealthy()) return true;
  }
  return false;
}

// --- Local model helpers ----------------------------------------------------

const DEFAULT_LOCAL_MODEL = 'mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit';

// The python /api/ask and every pipeline stage would actually spawn, plus
// whether it is there — resolved by the shared rules in local-python.js rather
// than by a fallback chain of this file's own. The chain that used to live
// here reported the first python that EXISTED, so a mistyped Settings value
// was answered for by Homebrew's python and the card went green while every
// question failed. See local-python.js for the full account.
function localPython() {
  let settingsEnv = null;
  try {
    settingsEnv = JSON.parse(
      fs.readFileSync(path.join(dataRoot(), 'settings.json'), 'utf8'))?.env ?? null;
  } catch { /* no settings.json yet — env or the default answers */ }
  return localPythonStatus({ settingsEnv });
}

function hfCacheDirFor(modelId) {
  return path.join(os.homedir(), '.cache', 'huggingface', 'hub',
    'models--' + modelId.replace(/\//g, '--'));
}

function dirSizeGb(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch {} }
    }
  };
  try { walk(dir); } catch { return null; }
  return Math.round(total / 1e8) / 10;
}

// --- Window -----------------------------------------------------------------

let win = null;

const APP_ICON = (() => {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    return img.isEmpty() ? null : img;
  } catch { return null; }
})();

let creatingWindow = false;

async function createWindow() {
  // Re-entrancy guard. createWindow awaits ensureBridge() (up to ~15s) before
  // the window exists, during which getAllWindows().length is still 0 — so a
  // dock-icon 'activate' would call createWindow again and open a second,
  // orphaned window. Focus the existing/loading one instead.
  if (win && !win.isDestroyed()) { win.focus(); return; }
  if (creatingWindow) return;
  creatingWindow = true;
  try {
    try {
      provisionDataRoot();
    } catch (err) {
      // e.g. the data-root path exists as a file, or perms deny mkdir.
      dialog.showErrorBox('CANVASync',
        `Could not prepare the data folder:\n\n${err.message}\n\n` +
        'Fix or remove that path, then reopen CANVASync.');
      app.quit();
      return;
    }
    const ok = await ensureBridge();

  win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'CANVASync',
    ...(APP_ICON && process.platform !== 'darwin' ? { icon: APP_ICON } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (ok) {
    win.loadURL(`${BRIDGE_URL}/app/`);
  } else {
    win.loadURL('data:text/html,<h2 style="font-family:sans-serif;margin:80px auto;max-width:480px">' +
      'CANVASync could not start the bridge.<br/><br/>Check that nothing else is using port 3847, ' +
      'then relaunch the app.</h2>');
  }

  // External links (Canvas URLs etc.) go to the default browser. Everything
  // else — anything not exactly the bridge origin — is opened externally and
  // NEVER inside the shell, where a child window would inherit the preload
  // (and thus window.canvasync.getSecret()). A prefix test like
  // url.startsWith(BRIDGE_URL) is unsafe: "http://127.0.0.1:3847@evil.com"
  // starts with the bridge string but resolves to evil.com, so it would load
  // a remote origin with the preload attached. Compare the parsed origin.
  win.webContents.setWindowOpenHandler(({ url }) => {
    let sameOrigin = false;
    try { sameOrigin = new URL(url).origin === BRIDGE_URL; } catch { /* unparseable */ }
    if (sameOrigin || url.startsWith('blob:')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Defense in depth: even a same-origin child window (or a navigation the
  // handler allowed) must not silently become a remote page with the preload.
  // Block any top-level navigation away from the bridge origin.
  win.webContents.on('will-navigate', (event, url) => {
    let sameOrigin = false;
    try { sameOrigin = new URL(url).origin === BRIDGE_URL; } catch { /* unparseable */ }
    if (!sameOrigin) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.on('closed', () => { win = null; });
  } finally {
    creatingWindow = false;
  }
}

// --- IPC --------------------------------------------------------------------

ipcMain.handle('get-secret', () => bridgeSecret());
ipcMain.handle('get-data-root', () => dataRoot());
ipcMain.handle('open-path', (e, p) => shell.openPath(String(p)));
ipcMain.handle('reveal-path', (e, p) => shell.showItemInFolder(String(p)));

ipcMain.handle('restart-bridge', async () => {
  if (bridgeExternal) return { ok: false, error: 'bridge is managed outside the app' };
  stopBridge();
  await new Promise(r => setTimeout(r, 800));
  const ok = await ensureBridge();
  return { ok };
});

ipcMain.handle('choose-data-root', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths[0]) return { changed: false };
  const cfg = loadAppConfig();
  cfg.dataRoot = res.filePaths[0];
  saveAppConfig(cfg);
  return { changed: true, dataRoot: cfg.dataRoot, restartRequired: true };
});

ipcMain.handle('check-local-model', (e, modelId) => {
  const id = modelId || DEFAULT_LOCAL_MODEL;
  const py = localPython();
  const dir = hfCacheDirFor(id);
  const present = fs.existsSync(dir) &&
    fs.readdirSync(dir, { recursive: true }).some(n => String(n).endsWith('.safetensors'));
  // `python` is the configured path whether or not it is there: the card can
  // only tell the user what to fix if it knows what was looked for.
  return { present, pythonOk: py.ok, python: py.python, sizeGb: present ? dirSizeGb(dir) : null };
});

ipcMain.handle('download-local-model', (e, modelId) => {
  const id = modelId || DEFAULT_LOCAL_MODEL;
  const py = localPython();
  if (!py.ok) {
    return { ok: false,
      error: `no python at ${py.python} — set "Local python" in Settings to your `
        + `MLX venv's bin/python, or create that venv (see README)` };
  }
  return new Promise((resolve) => {
    const child = spawn(py.python, ['-c',
      `from huggingface_hub import snapshot_download; snapshot_download(${JSON.stringify(id)})`],
      { stdio: 'ignore' });
    child.on('exit', (code) => resolve(code === 0
      ? { ok: true }
      : { ok: false, error: `downloader exited ${code} — is huggingface_hub installed in that python?` }));
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
});

// --- App lifecycle ----------------------------------------------------------

// Double-clicking the app while it's already running must focus the existing
// window, not start a second Electron (which would fight over the bridge).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', async () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
      // If the bridge died since launch (e.g. a startup port race left the
      // window on the error page), a re-launch should recover it, not just
      // refocus a dead window.
      if (!(await bridgeHealthy())) {
        const ok = await ensureBridge();
        if (ok) win.loadURL(`${BRIDGE_URL}/app/`);
      }
    } else {
      createWindow();
    }
  });

  app.whenReady().then(() => {
    // When launched via `npm start` (no .app bundle) the Dock shows Electron's
    // default icon; replace it with ours. The CANVASync.app launcher gets the
    // Finder icon from its own .icns, but the Dock icon still comes from here.
    if (process.platform === 'darwin' && APP_ICON) {
      try { app.dock.setIcon(APP_ICON); } catch {}
    }
    createWindow();
  });
}

app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', stopBridge);
