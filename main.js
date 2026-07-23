const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell, systemPreferences } = require('electron'); 
const path = require('path'); 
const store = require('./src/store'); 
const { captureScreenshot } = require('./src/screen'); 
const { createSTT } = require('./src/stt'); 
const { createLLM } = require('./src/llm'); 
const { MODES } = require('./src/prompts'); 
const { rms16 } = require('./src/wav'); 

// Disable Chromium GPU acceleration before app readiness to avoid spawning a
// separate GPU helper process for this lightweight overlay.
app.disableHardwareAcceleration();

let win = null; 

// -------- capture / transcript state -------- 
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } }; 
let sttDisabled = false; // set when the key can't reach any speech model (stops retry spam) 
const buffers = { you: [], them: [] }; 
const transcript = []; // { channel, text, ts } 
const FLUSH_MS = 3500; 
const MIN_BYTES = Math.floor(16000 * 2 * 0.6); // ~0.6s 
const RMS_GATE = 240; 
let flushTimer = null; 

function send(channel, data) { 
  if (win && !win.isDestroyed()) win.webContents.send(channel, data); 
} 

// -------- window position -------- 
const MARGIN = 6; 
function computePosition(preset, w, h) { 
  const { workArea } = screen.getPrimaryDisplay(); 
  const xLeft = workArea.x + MARGIN; 
  const xCenter = Math.round(workArea.x + (workArea.width - w) / 2); 
  const xRight = workArea.x + workArea.width - w - MARGIN; 
  const yTop = workArea.y + MARGIN; 
  const yCenter = Math.round(workArea.y + (workArea.height - h) / 2); 
  const yBottom = workArea.y + workArea.height - h - MARGIN; 

  switch (preset) { 
    case 'top-left': return { x: xLeft, y: yTop }; 
    case 'top-right': return { x: xRight, y: yTop }; 
    case 'bottom-left': return { x: xLeft, y: yBottom }; 
    case 'bottom-center': return { x: xCenter, y: yBottom }; 
    case 'bottom-right': return { x: xRight, y: yBottom }; 
    case 'center': return { x: xCenter, y: yCenter }; 
    case 'top-center': 
    default: return { x: xCenter, y: yTop }; 
  } 
} 

function setWindowPosition(preset) { 
  if (!win) return; 
  const [w, h] = win.getSize(); 
  const { x, y } = computePosition(preset, w, h); 
  win.setPosition(x, y); 
} 

// -------- window -------- 
function createWindow() { 
  const settings = store.getSettings(); 
  const W = 700, H = 600; 
  const { x, y } = computePosition(settings.windowPosition, W, H); 

  win = new BrowserWindow({ 
    width: W, 
    height: H, 
    x, 
    y, 
    frame: false, 
    transparent: true, 
    hasShadow: false, 
    resizable: true, 
    skipTaskbar: true, 
    alwaysOnTop: true, 
    fullscreenable: false, 
    // macOS custom non-activating configurations
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}), 
    webPreferences: { 
      preload: path.join(__dirname, 'preload.js'), 
      contextIsolation: true, 
      nodeIntegration: false, 
      sandbox: false 
    } 
  }); 

  // Invisibility + overlay behavior. Set SHADOW_NO_PROTECT=1 to disable for debugging. 
  win.setContentProtection(!process.env.SHADOW_NO_PROTECT); 
  // excluded from screen capture (best-effort) 
  win.setAlwaysOnTop(true, 'screen-saver', 1); 
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); 
  
  if (typeof win.setHiddenInMissionControl === 'function') {
    win.setHiddenInMissionControl(true); 
  }

  win.loadFile(path.join(__dirname, 'renderer', 'index.html')); 
  win.webContents.on('did-finish-load', () => win.showInactive()); 
  win.webContents.on('render-process-gone', (_e, d) => console.log('[shadow] renderer gone', JSON.stringify(d))); 
} 

// -------- STT flushing -------- 
async function flushChannel(channel) { 
  if (state.transcribing[channel]) return; 
  const chunks = buffers[channel]; 
  if (!chunks.length) return; 

  const pcm = Buffer.concat(chunks); 
  buffers[channel] = []; 

  if (pcm.length < MIN_BYTES) return; 
  if (rms16(pcm) < RMS_GATE) return; // silence gate 

  state.transcribing[channel] = true; 
  try { 
    const settings = store.getSettings(); 
    const stt = createSTT(settings); 
    if (!stt.available) { 
      if (!sttDisabled) { 
        sttDisabled = true; 
        send('status', { message: 'No transcription key set. Add an OpenAI (Whisper) or Gemini key in Settings to enable listening. Screen/LeetCode features work without it.' }); 
      } 
      return; 
    } 

    const res = await stt.transcribe(pcm); 
    if (res.error) { 
      handleSttError(res.error, settings); 
      return; 
    } 

    if (res.text && res.text.trim()) { 
      const turn = { channel, text: res.text.trim(), ts: Date.now() }; 
      transcript.push(turn); 
      send('transcript', turn); 
    } 
  } catch (e) { 
    console.log('[stt] error', e && e.message); 
  } finally { 
    state.transcribing[channel] = false; 
  } 
} 

function handleSttError(err, settings) { 
  console.log('[stt] error', err.provider, err.status, err.code, err.message); 
  if (sttDisabled) return; 
  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found'; 
  sttDisabled = true; // stop hammering the API every few seconds 
  if (noAccess) { 
    send('status', { message: 'Transcription off: your ' + err.provider + ' key has no access to a speech-to-text model (403). Screen + LeetCode still work. To enable listening: give the key Whisper/transcription access, or add a Gemini key in Settings and reopen.' }); 
  } else { 
    send('status', { message: 'Transcription error (' + err.provider + '): ' + err.message }); 
  } 
} 

function startFlushLoop() { 
  if (flushTimer) return; 
  flushTimer = setInterval(() => { 
    flushChannel('you'); 
    flushChannel('them'); 
  }, FLUSH_MS); 
} 

function stopFlushLoop() { 
  if (flushTimer) { 
    clearInterval(flushTimer); 
    flushTimer = null; 
  } 
} 

// -------- capture toggle -------- 
function setCapturing(active) { 
  state.capturing = active; 
  if (active) { 
    startFlushLoop(); 
  } else { 
    stopFlushLoop(); 
    buffers.you = []; 
    buffers.them = []; 
  } 
  send('capture:state', { active }); 
  return active; 
} 

// -------- feature runner -------- 
async function runFeature(mode, userText) { 
  if (state.busy) return; 
  const def = MODES[mode]; 
  if (!def) return; 
  state.busy = true; 
  try { 
    const settings = store.getSettings(); 
    const llm = createLLM(settings); 
    const userBubble = def.userBubble !== null ? def.userBubble : (mode === 'ask' ? userText : null); 
    send('llm:start', { userBubble, small: !!def.small }); 

    if (!llm.ready) { 
      send('llm:error', { message: 'Add your ' + settings.provider + ' API key in Settings (gear icon) to start. Model: ' + (llm.model || 'unset') + '.' }); 
      return; 
    } 

    let imageDataUrl = null; 
    if (def.needsScreen) { 
      const access = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted';
      if (access === 'denied') {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
        send('status', { message: 'Screen capture needs permission — opening System Settings. Grant Screen Recording to shadow, then fully quit and reopen the app.' });
      } else {
        // 'granted' or 'not-determined' — attempt the capture either way. When
        // not-determined (e.g. right after removing shadow from the Screen
        // Recording list), this is what actually triggers macOS's native
        // permission prompt; checking status alone never does.
        try { 
          imageDataUrl = await captureScreenshot(); 
        } catch (e) { 
          send('status', { message: 'Screen capture failed: ' + (e && e.message ? e.message : e) }); 
        } 
      } 
    } 

    const built = def.build({ transcript, userText: userText || '' });
    const STREAM_TIMEOUT_MS = 25000;
    const full = await Promise.race([
      llm.stream({ system: def.system, turns: [{ role: 'user', text: built }], imageDataUrl, onToken: (t) => send('llm:token', { text: t }) }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`No response after ${STREAM_TIMEOUT_MS / 1000}s — check your network or API key access and try again.`)), STREAM_TIMEOUT_MS))
    ]);
    if (!full || !full.trim()) {
      send('llm:error', { message: 'The model returned an empty response (it may have declined to answer). Try again.' });
    } else {
      send('llm:done', {});
    }
  } catch (e) { 
    console.log('[llm] error', e && e.message);
    send('llm:error', { message: 'Error: ' + (e && e.message ? e.message : String(e)) }); 
  } finally { 
    state.busy = false; 
  } 
} 

// -------- IPC -------- 
ipcMain.handle('app:getVersion', () => app.getVersion());
ipcMain.handle('app:checkUpdate', async () => {
  // ponytail: no code-signing cert -> no silent Squirrel auto-update; this checks
  // GitHub releases and, on mac, installs on click via a swap-and-relaunch script.
  const res = await fetch('https://api.github.com/repos/rudrathegod/shadow/releases/latest');
  const rel = await res.json();
  const latest = (rel.tag_name || '').replace(/^v/, '');
  const asset = (rel.assets || []).find((a) => a.name === 'shadow-mac.zip');
  return { current: app.getVersion(), latest, url: rel.html_url, zipUrl: asset && asset.browser_download_url };
});

ipcMain.handle('app:installUpdate', async (_e, zipUrl) => {
  if (process.platform !== 'darwin' || !app.isPackaged) {
    shell.openExternal(zipUrl);
    return { ok: false };
  }
  const fs = require('fs');
  const os = require('os');
  const { execFileSync, spawn } = require('child_process');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-update-'));
  const zipPath = path.join(tmp, 'shadow-mac.zip');
  const res = await fetch(zipUrl);
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  execFileSync('unzip', ['-o', zipPath, '-d', tmp]);

  const newApp = path.join(tmp, 'shadow.app');
  const currentApp = path.resolve(process.resourcesPath, '..', '..'); // .../shadow.app

  // Swap after this process exits: remove old bundle, move new one in, clear
  // quarantine (same as after-sign.js does at build time), relaunch.
  const script = path.join(tmp, 'apply-update.sh');
  fs.writeFileSync(script, `#!/bin/bash
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done
rm -rf "${currentApp}"
mv "${newApp}" "${currentApp}"
xattr -cr "${currentApp}"
open "${currentApp}"
`, { mode: 0o755 });

  spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
  return { ok: true };
});
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => { 
  sttDisabled = false; 
  return store.setSettings(patch); 
}); 
ipcMain.handle('window:setPosition', (_e, preset) => { 
  const saved = store.setSettings({ windowPosition: preset }); 
  setWindowPosition(preset); 
  return saved; 
}); 
ipcMain.on('app:quit', () => app.quit()); 
ipcMain.handle('capture:toggle', () => setCapturing(!state.capturing)); 
ipcMain.handle('capture:state', () => ({ active: state.capturing })); 
ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text)); 
ipcMain.on('mic:pcm', (_e, arrayBuffer) => { 
  if (state.capturing) buffers.you.push(Buffer.from(arrayBuffer)); 
}); 
ipcMain.on('system:pcm', (_e, arrayBuffer) => { 
  if (state.capturing) buffers.them.push(Buffer.from(arrayBuffer)); 
}); 
ipcMain.on('mouse:ignore', (_e, v) => { 
  if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); 
}); 
ipcMain.on('open-pane', (_e, url) => { 
  shell.openExternal(url).catch(() => {}); 
}); 
ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg)); 

// -------- shortcuts -------- 
function registerShortcuts() { 
  globalShortcut.register('CommandOrControl+Return', () => runFeature('assist', '')); 
  globalShortcut.register('CommandOrControl+H', () => runFeature('leetcode', '')); 
  globalShortcut.register('CommandOrControl+Down', () => send('overlay:scroll', { direction: 'down' }));
  globalShortcut.register('CommandOrControl+Up', () => send('overlay:scroll', { direction: 'up' }));
  globalShortcut.register('CommandOrControl+Shift+X', () => app.quit()); 
} 

// -------- lifecycle -------- 
// Execute platform-specific UI management cleanly before internal ready hooks trigger
if (process.platform === 'darwin' && app.dock) { 
  app.dock.hide(); 
} 

app.whenReady().then(() => { 
  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture'; 
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission))); 
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission)); 

  // System-audio loopback for getDisplayMedia
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (sources.length) callback({ video: sources[0], audio: 'loopback' });
      else callback();
    }).catch(() => callback());
  }, { useSystemPicker: false });

  createWindow();
  registerShortcuts();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => app.quit());
