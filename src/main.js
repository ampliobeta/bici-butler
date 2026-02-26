const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const chokidar = require('chokidar');
const Store = require('electron-store');

const store = new Store();

// ── Paths ─────────────────────────────────────────────────────
const USER_DATA = app.getPath('userData');
const WORKOUT_DIR = path.join(USER_DATA, 'workouts');
if (!fs.existsSync(WORKOUT_DIR)) fs.mkdirSync(WORKOUT_DIR, { recursive: true });

// ── State ─────────────────────────────────────────────────────
let mainWindow = null;
let setupWindow = null;
let LAST = { ts: 0, payload: null };
let STEPS = [];
let FTP = store.get('ftp', null);

// ── ZWO Parser ────────────────────────────────────────────────
function parseZwo(filePath) {
  try {
    const xml = fs.readFileSync(filePath, 'utf8');
    const ftp = FTP || 300;
    const steps = [];
    let t = 0;

    const workoutMatch = xml.match(/<workout>([\s\S]*?)<\/workout>/i);
    if (!workoutMatch) return [];
    const body = workoutMatch[1];

    const elRegex = /<(\w+)([^\/>"']*)(?:\/?>|>[\s\S]*?<\/\1>)/g;
    let m;
    while ((m = elRegex.exec(body)) !== null) {
      const tag = m[1];
      const attrs = m[2];
      const get = (name) => {
        const r = new RegExp(`${name}="([^"]+)"`, 'i');
        const a = attrs.match(r);
        return a ? parseFloat(a[1]) : null;
      };

      const dur = Math.round(get('Duration') || 0);
      if (!dur) continue;

      let label, tlo, thi, zone;

      if (tag === 'Warmup') {
        tlo = Math.round((get('PowerLow') || 0.5) * ftp);
        thi = Math.round((get('PowerHigh') || 0.75) * ftp);
        label = `Warmup ${tlo}–${thi}W`;
        zone = 'warmup';
      } else if (tag === 'Cooldown') {
        tlo = Math.round((get('PowerLow') || 0.4) * ftp);
        thi = Math.round((get('PowerHigh') || 0.6) * ftp);
        label = `Cooldown ${tlo}–${thi}W`;
        zone = 'cooldown';
      } else if (['SteadyState', 'IntervalsT', 'FreeRide', 'Ramp'].includes(tag)) {
        const pwr = Math.round((get('Power') || 0) * ftp);
        const pct = Math.round((get('Power') || 0) * 100);
        if (pct >= 130)      { zone = 'sprint';     label = `Sprint · ${pwr}W`; }
        else if (pct >= 105) { zone = 'activation'; label = `Activation · ${pwr}W`; }
        else if (pct >= 95)  { zone = 'threshold';  label = `Threshold · ${pwr}W`; }
        else if (pct >= 85)  { zone = 'sweetspot';  label = `Sweet Spot · ${pwr}W`; }
        else if (pct >= 75)  { zone = 'endurance';  label = `Endurance · ${pwr}W`; }
        else if (pct >= 60)  { zone = 'tempo';      label = `Tempo · ${pwr}W`; }
        else                 { zone = 'recovery';   label = `Recovery · ${pwr}W`; }
        tlo = thi = pwr;
      } else {
        continue;
      }

      const mins = Math.floor(dur / 60);
      const secs = dur % 60;
      const durStr = secs === 0 ? `${mins}m` : `${mins}m ${secs}s`;
      steps.push({
        label: `${label}  (${durStr})`,
        start: t, end: t + dur,
        target_lo: tlo, target_hi: thi,
        zone, duration: dur
      });
      t += dur;
    }
    console.log(`Loaded: ${path.basename(filePath)} — ${steps.length} steps, ${Math.round(t/60)}m`);
    return steps;
  } catch (e) {
    console.error('ZWO parse error:', e.message);
    return [];
  }
}

// ── Find newest .zwo ──────────────────────────────────────────
function findNewestZwo() {
  try {
    const files = fs.readdirSync(WORKOUT_DIR)
      .filter(f => f.toLowerCase().endsWith('.zwo'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(WORKOUT_DIR, f)).mtime }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length ? path.join(WORKOUT_DIR, files[0].name) : null;
  } catch { return null; }
}

function reloadWorkout() {
  const zwo = findNewestZwo();
  if (zwo) {
    STEPS = parseZwo(zwo);
    if (mainWindow) mainWindow.webContents.send('workout-loaded', path.basename(zwo));
  }
}

// ── Watch workout folder ──────────────────────────────────────
function watchWorkouts() {
  chokidar.watch(WORKOUT_DIR, { ignoreInitial: false })
    .on('add', () => reloadWorkout())
    .on('change', () => reloadWorkout());
}

// ── Current step ──────────────────────────────────────────────
function currentStep(elapsed) {
  for (let i = 0; i < STEPS.length; i++) {
    const s = STEPS[i];
    if (elapsed >= s.start && elapsed < s.end) {
      return { index: i, label: s.label, zone: s.zone,
        remaining_sec: Math.floor(s.end - elapsed),
        target_lo: s.target_lo, target_hi: s.target_hi };
    }
  }
  return null;
}

// ── Express server ────────────────────────────────────────────
function startServer() {
  const expressApp = express();
  expressApp.use(express.json({ limit: '1mb' }));
  expressApp.use(express.text({ type: '*/*', limit: '1mb' }));

  expressApp.post(['/tp', '/tpv'], (req, res) => {
    let data = req.body;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch(e) { data = { raw: data }; }
    }
    LAST = { ts: Date.now(), payload: data };
    res.json({ ok: true });
  });

  expressApp.get('/status', (req, res) => {
    if (!LAST.ts) {
      return res.json({ ok: false, payload: null, step: null, step_index: null, steps: STEPS });
    }
    const d = Array.isArray(LAST.payload) ? LAST.payload[0] : LAST.payload;
    const step = currentStep(d?.time || 0);
    res.json({
      ok: true,
      age_sec: Math.round((Date.now() - LAST.ts) / 100) / 10,
      payload: LAST.payload,
      step,
      step_index: step ? step.index : null,
      steps: STEPS
    });
  });

  expressApp.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

  const server = http.createServer(expressApp);
  server.listen(8787, '127.0.0.1', () => console.log('Bici server: http://127.0.0.1:8787'));
  return server;
}

// ── Setup window ──────────────────────────────────────────────
function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 440, height: 340,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1220',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  setupWindow.loadFile(path.join(__dirname, 'setup.html'));
}

// ── Main HUD window ───────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 400, height: 760,
    minWidth: 280, minHeight: 480,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0c12',
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  mainWindow.loadURL('http://127.0.0.1:8787');
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── IPC handlers ──────────────────────────────────────────────
ipcMain.on('ftp-set', (event, ftp) => {
  FTP = parseInt(ftp);
  store.set('ftp', FTP);
  reloadWorkout();
  if (setupWindow) { setupWindow.close(); setupWindow = null; }
  createMainWindow();
});

ipcMain.on('open-workout-folder', () => {
  shell.openPath(WORKOUT_DIR);
});

ipcMain.handle('get-ftp', () => store.get('ftp', null));
ipcMain.handle('get-workout-dir', () => WORKOUT_DIR);

// ── Boot ──────────────────────────────────────────────────────
let httpServer;
app.whenReady().then(() => {
  httpServer = startServer();
  watchWorkouts();

  if (!FTP) {
    createSetupWindow();
  } else {
    reloadWorkout();
    createMainWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow && !setupWindow) {
    if (!FTP) createSetupWindow();
    else createMainWindow();
  }
});

app.on('before-quit', () => {
  if (httpServer) httpServer.close();
});
