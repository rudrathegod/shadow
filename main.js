const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell, systemPreferences } = require('electron'); 
const path = require('path'); 
const store = require('./src/store'); 
const { captureScreenshot } = require('./src/screen'); 
const { createSTT } = require('./src/stt'); 
const { createLLM, isRateLimited } = require('./src/llm');
const { MODES } = require('./src/prompts');
const { rms16 } = require('./src/wav');
const { extractCode, stripFences, runSandboxed } = require('./src/verify');

let win = null; 

// -------- capture / transcript state -------- 
const state = { capturing: false, busy: false, transcribing: { you: false, them: false } }; 
let activeRequest = null;
let sttDisabled = false; // set when the key can't reach any speech model (stops retry spam)
let sttFailures = 0; // consecutive transient failures; resets on any success
const STT_MAX_FAILURES = 3;
// A 429 means "come back later", not "you're broken". Retrying every FLUSH_MS
// just deepens the hole and burns the same quota the chat calls need, so back
// off for a whole quota window instead.
let sttCooldownUntil = 0;
const STT_COOLDOWN_MS = 60000;
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
  const W = 700, H = 780; 
  const { x, y } = computePosition(settings.windowPosition, W, H); 

  win = new BrowserWindow({ 
    width: W, 
    height: H, 
    minWidth: 420,
    minHeight: 420,
    maxWidth: 1000,
    maxHeight: 1100,
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

  // Windows drops the capture-exclusion affinity when the window is shown again
  // after a hide, and showing is what every path here ends with (first load,
  // focus-input, re-create on activate). Re-assert all three overlay properties
  // in one place rather than trusting the one call in this function to stick.
  win.on('show', () => {
    if (!win || win.isDestroyed()) return;
    win.setContentProtection(!process.env.SHADOW_NO_PROTECT);
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  });

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

  // Drain first, then bail — audio recorded during a cooldown is discarded
  // rather than piling up for a burst of catch-up requests afterwards.
  if (Date.now() < sttCooldownUntil) return;

  if (pcm.length < MIN_BYTES) return;
  if (rms16(pcm) < RMS_GATE) return; // silence gate 

  state.transcribing[channel] = true; 
  try { 
    const settings = store.getSettings(); 
    const stt = createSTT(settings); 
    if (!stt.available) { 
      if (!sttDisabled) {
        sttDisabled = true;
        send('status', {
          message: stt.wanted === 'auto'
            ? 'No transcription key set. Add an OpenAI (Whisper) or Gemini key in Settings to enable listening. Screen/LeetCode features work without it.'
            : 'Transcription is set to ' + stt.wanted + ', but no ' + stt.wanted + ' key is set. Add one in Settings, or switch transcription to Auto.'
        });
        send('stt:state', { off: true });
      }
      return; 
    } 

    const res = await stt.transcribe(pcm);
    if (res.error) {
      handleSttError(res.error);
      return;
    }

    sttFailures = 0;
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

function handleSttError(err) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  if (sttDisabled) return;

  // A key that can't reach a speech model will never start working on its own —
  // disable immediately rather than retrying every few seconds forever.
  if (err.status === 403 || err.status === 401 || err.code === 'model_not_found') {
    sttDisabled = true;
    send('status', { message: 'Transcription off: your ' + err.provider + ' key has no access to a speech-to-text model (403). Screen + LeetCode still work. To enable listening: give the key Whisper/transcription access, or add a Gemini key in Settings and reopen.' });
    send('stt:state', { off: true });
    return;
  }

  // Rate limiting is self-inflicted at FLUSH_MS: two channels transcribing every
  // 3.5s is ~17-34 requests/min against a free tier that allows far fewer. Pause
  // rather than counting it as a failure — nothing is wrong, there's just no room.
  if (isRateLimited(err)) {
    sttCooldownUntil = Date.now() + STT_COOLDOWN_MS;
    send('status', { message: 'Transcription paused ' + (STT_COOLDOWN_MS / 1000) + 's — ' + err.provider + ' is rate-limiting. It resumes on its own.' });
    return;
  }

  // Anything else (5xx, dropped connection) is usually transient, so keep
  // trying — but give up after a few in a row so a real outage doesn't hammer
  // the API every FLUSH_MS for the rest of the session.
  sttFailures++;
  if (sttFailures >= STT_MAX_FAILURES) {
    sttDisabled = true;
    send('status', { message: 'Transcription off after ' + STT_MAX_FAILURES + ' errors in a row (' + err.provider + '): ' + err.message + ' — change any setting to re-enable.' });
    send('stt:state', { off: true });
  } else {
    send('status', { message: 'Transcription error (' + err.provider + '): ' + err.message + ' — retrying.' });
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
    // Opt-in: a summary waiting the moment you stop listening beats having to
    // remember to click Recap before the transcript scrolls out of mind.
    if (store.getSettings().recapOnStop && transcript.length && !state.busy) runFeature('recap', '');
  }
  send('capture:state', { active });
  return active;
}

// -------- screenshot capture (shared by single-shot and batched capture) --------
async function captureOneScreenshot() {
  const access = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted';
  if (access === 'denied') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    send('status', { message: 'Screen capture needs permission — opening System Settings. Grant Screen Recording to shadow, then fully quit and reopen the app.' });
    return null;
  }
  // 'granted' or 'not-determined' — attempt the capture either way. When
  // not-determined (e.g. right after removing shadow from the Screen
  // Recording list), this is what actually triggers macOS's native
  // permission prompt; checking status alone never does.
  try {
    return await captureScreenshot();
  } catch (e) {
    send('status', { message: 'Screen capture failed: ' + (e && e.message ? e.message : e) });
    return null;
  }
}

// -------- self-check: run the model's own code against its own test harness --------
async function verifyAndRepair(llm, answerText, images) {
  const extracted = extractCode(answerText);
  // Empty code also has to bail: there's nothing to test, and an empty needle
  // would make the repair splice below match at index 0 and prepend.
  if (!extracted || !extracted.lang || !extracted.code.trim()) return {};
  const lang = extracted.lang;
  const silent = (system, userText, imageDataUrls) =>
    llm.stream({ system, turns: [{ role: 'user', text: userText }], imageDataUrls, onToken: () => {} }).catch(() => '');

  const harnessRaw = await silent(
    `You write short, self-contained test scripts. Given the ORIGINAL PROBLEM (screenshot) and a proposed solution's code, ` +
    `output ONLY a runnable ${lang} script (no prose, no markdown fences) that checks edge cases called out or implied by ` +
    `the problem statement (boundary values, out-of-range/invalid inputs, empty/min/max sizes) plus typical cases, with ` +
    `explicit expected values derived from the problem — not from re-running the solution — ` +
    `calls the solution, and exits non-zero (raise/throw or process.exit(1)/sys.exit(1)) on any mismatch, or exits 0 if everything passes.`,
    'Solution:\n\n' + extracted.code,
    images
  );
  const harness = stripFences(harnessRaw);
  if (!harness) return {};

  const first = await runSandboxed(lang, extracted.code + '\n\n' + harness);
  if (!first.supported || first.unavailable) return {};
  if (first.ok) return { note: 'Self-test passed.' };

  const fixedRaw = await silent(
    `Fix the bug in this solution so it passes the given test, staying faithful to the original problem (screenshot). ` +
    `Return ONLY the corrected solution in a single fenced ${lang} code block, no prose.`,
    `Original solution:\n${extracted.code}\n\nTest:\n${harness}\n\nFailure:\n${first.error}`,
    images
  );
  const fixed = extractCode(fixedRaw);
  if (!fixed) return { note: 'Self-test failed: ' + first.error };

  const retry = await runSandboxed(lang, fixed.code + '\n\n' + harness);
  if (retry.ok) {
    // Swap the exact substring extractCode matched. A ```-to-``` regex can land
    // on a different span than the one that was tested (any earlier inline
    // triple-backtick run wins), and a string replacement would eat $&/$'/$`
    // sequences in the code — either way the shown answer silently stops
    // matching the one that passed.
    const newText = answerText.replace(extracted.code, () => fixed.code);
    return { text: newText, note: 'Found and fixed a bug during self-test.' };
  }
  return { note: `Self-test still failing after one fix attempt: ${retry.error} — double check before using.` };
}

// -------- Cmd+. batching: ⌘. adds a screenshot without solving, ⌘G solves using all of them --------
let pendingShots = [];
// ⌘. is a global shortcut and each shot is a multi-MB data URL, so an
// accidental key-repeat would otherwise build a request no provider will accept.
const MAX_BATCH = 15;
async function addScreenshotToBatch() {
  if (pendingShots.length >= MAX_BATCH) {
    send('status', { message: `Batch is full (${MAX_BATCH} screenshots) — press ${prettySolve()} to solve using them.` });
    return;
  }
  const img = await captureOneScreenshot();
  if (!img) return;
  pendingShots.push(img);
  send('status', { message: `Added screenshot ${pendingShots.length} to the batch — press ${prettySolve()} to solve using all of them, or ${prettyAccelMain(effectiveShortcuts().addShot)} to add more.` });
  rotateShortcutRandom('addShot'); // after the push commits — a failed capture must not move the key
}
// solve and addShot each move to a random new key after every successful use,
// so a combination someone saw you press is already dead. Session-only: never
// written to settings, so an explicit rebind in Settings still wins.
let rotatedAccel = {}; // id -> session-only override
function effectiveShortcuts() {
  const saved = { ...store.defaultShortcuts(), ...(store.getSettings().shortcuts || {}) };
  for (const id of Object.keys(rotatedAccel)) if (rotatedAccel[id]) saved[id] = rotatedAccel[id];
  return saved;
}
// Status copy has to name the key that's live right now, not the one that was
// live when the string was written.
function prettyAccelMain(accel) {
  return (accel || '')
    .split('+')
    .map((k) => k === 'CommandOrControl' ? (process.platform === 'darwin' ? '⌘' : 'Ctrl')
      : k === 'Shift' ? (process.platform === 'darwin' ? '⇧' : 'Shift')
      : k === 'Alt' ? (process.platform === 'darwin' ? '⌥' : 'Alt') : k)
    .join(process.platform === 'darwin' ? '' : '+');
}
const prettySolve = () => prettyAccelMain(effectiveShortcuts().solve) || 'the solve shortcut';
// Picks a random accelerator for `id`, excluding every shortcut currently
// bound (so it can't collide with itself or another action), bounded so a
// nearly-exhausted pool can't spin forever.
function rotateShortcutRandom(id) {
  const current = effectiveShortcuts();
  if (!current[id]) return; // deliberately unbound — leave it that way
  const taken = Object.values(current);
  for (let attempt = 0; attempt < 20; attempt++) {
    const next = store.randomAccel(taken);
    if (!next) break;
    rotatedAccel[id] = next;
    if (!registerShortcuts().some((f) => f.id === id)) {
      send('shortcuts:changed', { effective: effectiveShortcuts() });
      return;
    }
    taken.push(next);
  }
  rotatedAccel[id] = null;
  registerShortcuts();
  send('shortcuts:changed', { effective: effectiveShortcuts() });
}

async function captureAndSolve() {
  if (state.busy) return;
  const img = await captureOneScreenshot();
  const images = pendingShots.concat(img ? [img] : []);
  if (!images.length) return; // capture failed; status already shown
  // Re-check: the capture above is slow enough that another request can start
  // during it, and runFeature would silently drop this one — taking the whole
  // batch with it if we'd already cleared it.
  if (state.busy) {
    send('status', { message: 'Still answering the previous request — your screenshots are kept, press ' + prettySolve() + ' again in a moment.' });
    return;
  }
  pendingShots = [];
  rotateShortcutRandom('solve'); // after the run commits — a failed capture must not move the key
  runFeature('leetcode', '', images);
}

// -------- feature runner --------
async function runFeature(mode, userText, presetImages) {
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) return;
  state.busy = true;
  const request = { cancelled: false };
  activeRequest = request;
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings);
    const userBubble = def.userBubble !== null ? def.userBubble : (mode === 'ask' ? userText : null);
    // The renderer can't know the mode for runs started from a global shortcut,
    // so every start carries what Regenerate needs to replay it. Runs fed
    // preset screenshots aren't replayable — re-running would drop the images.
    const start = { userBubble, small: !!def.small, mode, text: userText || '', replayable: !presetImages };
    send('llm:start', start);

    if (!llm.ready) {
      send('llm:error', { message: 'Add your ' + settings.provider + ' API key in Settings (gear icon) to start. Model: ' + (llm.model || 'unset') + '.' });
      return;
    }

    let images = presetImages || [];
    if (!presetImages && def.needsScreen) {
      const img = await captureOneScreenshot();
      if (img) images = [img];
    }

    const built = def.build({ transcript, userText: userText || '' });

    // Idle timeout: resets on every token, so a long-but-flowing answer never
    // gets cut off — only a genuine stall (no tokens for 45s) trips it.
    // Some providers deliver the full answer but then hang before closing the
    // stream (never fire their "done" event) — in that case we already have a
    // complete-looking answer sitting in `acc`, so surface that instead of
    // discarding it behind a hard error.
    const IDLE_TIMEOUT_MS = 45000;
    // Set when any attempt had to back off, so we don't follow a rate-limited
    // answer with two more optional calls.
    let hitRateLimit = false;
    async function attempt() {
      if (request.cancelled) return { text: '', stalled: false, cancelled: true };
      let acc = '';
      // Losing the race doesn't cancel the underlying stream — it can wake up
      // later and keep firing onToken. Without this flag those stale tokens get
      // sent to the renderer long after we moved on, interleaving themselves
      // into the retry's bubble or into the post-verify rewrite.
      let abandoned = false;
      let resetIdle, idleTimer;
      const timedOut = new Promise((resolve) => {
        idleTimer = setTimeout(() => resolve({ timedOut: true }), IDLE_TIMEOUT_MS);
        resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => resolve({ timedOut: true }), IDLE_TIMEOUT_MS); };
      });
      const streamed = llm.stream({
        system: def.system,
        turns: [{ role: 'user', text: built }],
        imageDataUrls: images,
        onToken: (t) => { if (abandoned || request.cancelled) return; acc += t; send('llm:token', { text: t }); resetIdle(); },
        onRateLimit: (attempt, waitMs) => {
          if (request.cancelled) return;
          hitRateLimit = true;
          send('status', { message: `Rate limited by the API — retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt})…` });
        }
      }).then((full) => ({ timedOut: false, full }));
      // Once the race is settled nothing is awaiting `streamed`, so a late
      // failure would surface as an unhandled rejection. Swallow it here; this
      // extra handler doesn't affect the race below.
      streamed.catch(() => {});
      try {
        const result = await Promise.race([streamed, timedOut]);
        if (request.cancelled) return { text: '', stalled: false, cancelled: true };
        if (!result.timedOut) return { text: result.full, stalled: false };
        abandoned = true;
        // A true hang with zero tokens is treated the same as an empty completion
        // below — one silent retry — instead of surfacing an error on what's
        // often just one bad connection.
        return { text: acc, stalled: !!acc.trim() };
      } finally {
        clearTimeout(idleTimer);
      }
    }

    let { text: full, stalled } = await attempt();
    if (request.cancelled) return;
    // A handful of providers occasionally return a genuinely empty completion
    // (transient safety pass, cold-start hiccup) with no error thrown — one
    // silent retry clears most of these before bothering the user.
    if (!full || !full.trim()) {
      send('llm:start', start);
      ({ text: full, stalled } = await attempt());
      if (request.cancelled) return;
    }
    if (!full || !full.trim()) {
      send('llm:error', { message: `The model gave no response twice in a row (empty completion, or no reply after ${IDLE_TIMEOUT_MS / 1000}s each time) — check your network or API key access and try again.` });
    } else {
      // The self-test costs two more calls (harness, then repair). That's the
      // difference between one request per ⌘G and three — worth skipping when
      // the provider is already refusing us.
      if (mode === 'leetcode' && hitRateLimit) {
        send('status', { message: 'Skipped the self-test — the API is rate-limiting. Double-check the solution.' });
      } else if (mode === 'leetcode') {
        send('status', { message: 'Verifying the solution runs correctly…' });
        const verified = await verifyAndRepair(llm, full, images);
        if (request.cancelled) return;
        if (verified.text) {
          full = verified.text;
          send('llm:start', start);
          send('llm:token', { text: full });
        }
        if (verified.note) send('status', { message: verified.note });
      }
      if (stalled) send('status', { message: 'Connection stalled after the answer came through — showing what was received.' });
      send('llm:done', {});
    }
  } catch (e) { 
    console.log('[llm] error', e && e.message);
    send('llm:error', { message: 'Error: ' + (e && e.message ? e.message : String(e)) }); 
  } finally { 
    // A cancelled request keeps running to completion (there's no abort on the
    // underlying stream), so it must not clear the busy flag out from under the
    // request that replaced it — otherwise a third one starts alongside it.
    if (activeRequest === request) { activeRequest = null; state.busy = false; }
  } 
} 

// -------- IPC -------- 
ipcMain.handle('app:getVersion', () => app.getVersion());
ipcMain.handle('app:checkUpdate', async () => {
  // ponytail: no code-signing cert -> no silent Squirrel auto-update; this checks
  // GitHub releases and installs on click via a swap-and-relaunch script (mac
  // and Windows). Unsigned means Windows still shows a SmartScreen warning on
  // the relaunched exe — that needs a cert, not more code here.
  const res = await fetch('https://api.github.com/repos/rudrathegod/shadow/releases/latest');
  const rel = await res.json();
  const latest = (rel.tag_name || '').replace(/^v/, '');
  // The release carries both zips — picking the mac one unconditionally left
  // Windows with no zipUrl, which the renderer reads as "Up to date" forever.
  const assetName = process.platform === 'win32' ? 'shadow-win.zip' : 'shadow-mac.zip';
  const asset = (rel.assets || []).find((a) => a.name === assetName);
  return { current: app.getVersion(), latest, url: rel.html_url, zipUrl: asset && asset.browser_download_url };
});

ipcMain.handle('app:installUpdate', async (_e, zipUrl) => {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  if ((!isMac && !isWin) || !app.isPackaged) {
    shell.openExternal(zipUrl);
    return { ok: false };
  }
  const fs = require('fs');
  const os = require('os');
  const { execFileSync, spawn } = require('child_process');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-update-'));
  const zipPath = path.join(tmp, isWin ? 'shadow-win.zip' : 'shadow-mac.zip');
  const res = await fetch(zipUrl);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const chunks = [];
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    send('update:progress', { received, total });
  }
  fs.writeFileSync(zipPath, Buffer.concat(chunks.map((c) => Buffer.from(c))));

  // Both platforms do the same dance: unpack to temp, then hand a script to a
  // detached process that waits for this one to exit before swapping. Neither
  // OS lets you replace the files of a running app in place.
  if (isMac) {
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

    spawn('/bin/bash', [script], { detached: true, stdio: 'ignore', cwd: tmp }).unref();
  } else {
    // The Windows zip holds the app files at its root (no wrapper folder), so
    // the extracted directory *is* the new install directory.
    const newDir = path.join(tmp, 'new');
    const ps = (p) => `'${String(p).replace(/'/g, "''")}'`; // PowerShell literal
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath ${ps(zipPath)} -DestinationPath ${ps(newDir)} -Force`]);

    // resourcesPath/../.. is the .app on mac but lands a directory too high on
    // Windows — the install dir is simply where the exe lives.
    const currentDir = path.dirname(app.getPath('exe'));

    // Rename-then-move rather than delete-then-copy, so a failed swap can roll
    // back instead of leaving the user with no app at all.
    const script = path.join(tmp, 'apply-update.ps1');
    fs.writeFileSync(script, `$ErrorActionPreference = 'Stop'
$current = ${ps(currentDir)}
$new = ${ps(newDir)}
$backup = $current + '.old'

while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }

if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
Move-Item -LiteralPath $current -Destination $backup
try {
  Move-Item -LiteralPath $new -Destination $current
} catch {
  Move-Item -LiteralPath $backup -Destination $current
  throw
}
Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
Start-Process -FilePath (Join-Path $current 'shadow.exe')
`);

    // cwd must be outside the install dir, or the swap can't move it.
    spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script],
      { detached: true, stdio: 'ignore', cwd: tmp }).unref();
  }

  app.quit();
  return { ok: true };
});
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  if (sttDisabled) send('stt:state', { off: false });
  sttDisabled = false;
  sttFailures = 0;
  sttCooldownUntil = 0; // switching provider/key should retry immediately
  return store.setSettings(patch);
});
ipcMain.handle('transcript:get', () => transcript.map((t) => (t.channel === 'them' ? 'Them: ' : 'You: ') + t.text).join('\n'));
ipcMain.handle('shortcuts:get', () => ({
  actions: Object.entries(SHORTCUT_ACTIONS).map(([id, d]) => ({ id, label: d.label })),
  // `shortcuts` is what Settings edits and posts back — it must stay the saved
  // map, or the rotation would be written to disk on the next round-trip.
  shortcuts: store.getSettings().shortcuts || {},
  effective: effectiveShortcuts(), // display only: what's actually bound now

  defaults: store.defaultShortcuts()
}));
ipcMain.handle('shortcuts:set', (_e, next) => {
  rotatedAccel = {}; // an explicit rebind beats the rotation
  const saved = store.setSettings({ shortcuts: next || {} });
  return { shortcuts: saved.shortcuts, failed: registerShortcuts() };
});
// Global shortcuts outrank the focused window, so ⌘G would fire "solve" instead
// of being recorded. Release them while the user is picking new keys.
ipcMain.handle('shortcuts:capture', (_e, on) => {
  if (on) globalShortcut.unregisterAll(); else registerShortcuts();
  return true;
});
ipcMain.handle('window:setPosition', (_e, preset) => {
  const saved = store.setSettings({ windowPosition: preset }); 
  setWindowPosition(preset); 
  return saved; 
}); 
// Button can only hide — once hidden there's nothing to click, so coming back
// is the global shortcut's job.
ipcMain.on('app:quit', () => app.quit());
ipcMain.handle('capture:toggle', () => setCapturing(!state.capturing)); 
ipcMain.handle('capture:state', () => ({ active: state.capturing })); 
ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text)); 
ipcMain.handle('ask:cancel', () => {
  if (!activeRequest) return false;
  activeRequest.cancelled = true;
  state.busy = false;
  return true;
});
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

// -------- panic: collapse the panel down to the toolbar, and bring it back --------
// The renderer owns the collapsed state (it's a CSS class), so main just pokes it
// and doesn't try to mirror it. Capture keeps running so a meeting in progress
// isn't interrupted.
function togglePanic() { send('overlay:panic'); }

// -------- shortcuts --------
// Order here is the order shown in Settings.
const SHORTCUT_ACTIONS = {
  panic: { label: 'Panic — collapse / bring back', run: () => togglePanic() },
  assist: { label: 'Assist', run: () => runFeature('assist', '') },
  solve: { label: 'Solve what\'s on screen', run: () => captureAndSolve() },
  addShot: { label: 'Add screenshot to batch', run: () => addScreenshotToBatch() },
  scrollDown: { label: 'Scroll answer down', run: () => send('overlay:scroll', { direction: 'down' }) },
  scrollUp: { label: 'Scroll answer up', run: () => send('overlay:scroll', { direction: 'up' }) },
  focusInput: { label: 'Focus the input box', run: () => { if (win) { win.show(); win.focus(); } send('overlay:focus-input', {}); } },
  quit: { label: 'Quit shadow', run: () => app.quit() }
};

// Returns the bindings that couldn't be claimed — an accelerator already taken
// by another app (or by another row here) silently does nothing otherwise, which
// looks identical to a broken feature.
function registerShortcuts() {
  globalShortcut.unregisterAll();
  const saved = effectiveShortcuts();
  const failed = [];
  for (const [id, def] of Object.entries(SHORTCUT_ACTIONS)) {
    const accel = saved[id];
    if (!accel) continue; // blank = deliberately unbound
    let ok = false;
    try { ok = globalShortcut.register(accel, def.run); } catch { ok = false; }
    if (!ok) failed.push({ id, label: def.label, accel });
  }
  return failed;
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
