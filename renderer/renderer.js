/* shadow renderer — UI state, mic capture, IPC, streaming render. */
(function () {
  const { icon } = window.ICONS;
  const shadow = window.shadow; // exposed by preload
  const $ = (s) => document.querySelector(s);

  // ---- paint icons -------------------------------------------------------
  $('#logo-btn').innerHTML = icon('logo', { size: 18 });
  $('.tb-hide .chev').innerHTML = icon('chevron-down', { size: 14 });
  $('#stop-btn').innerHTML = icon('stop-square', { size: 15 });
  document.querySelector('.act[data-mode="assist"] .ic').innerHTML = icon('sparkles', { size: 16 });
  document.querySelector('.act[data-mode="say"] .ic').innerHTML = icon('wand-sparkles', { size: 16 });
  document.querySelector('.act[data-mode="followup"] .ic').innerHTML = icon('message-circle', { size: 16 });
  document.querySelector('.act[data-mode="recap"] .ic').innerHTML = icon('refresh-cw', { size: 16 });
  $('#smart-toggle .ic').innerHTML = icon('zap', { size: 14 });
  if (shadow.platform !== 'darwin') {
    const kc = document.querySelectorAll('#placeholder .keycap')[0];
    if (kc) kc.textContent = 'Ctrl';
  }
  $('#panic-btn').innerHTML = icon('eye-off', { size: 15 });
  $('#more-btn').innerHTML = icon('more-horizontal', { size: 18 });
  $('#send-btn').innerHTML = icon('play', { size: 15 });
  $('#copy-answer').innerHTML = icon('copy', { size: 15 });
  $('#copy-code').innerHTML = icon('code', { size: 15 });
  $('#regenerate-answer').innerHTML = icon('refresh-cw', { size: 15 });
  $('#stop-answer').innerHTML = icon('stop-square', { size: 14 });
  $('#clear-answer').innerHTML = icon('trash', { size: 15 });
  $('#transcript-btn').innerHTML = icon('copy', { size: 15 });

  // ---- state -------------------------------------------------------------
  let settings = null;
  let version = '';
  let busy = false;
  let aiEl = null;       // current streaming <div class="ai-text">
  let caretEl = null;
  let lastAnswerText = '';
  let lastAnswerCode = '';
  let lastRequest = null;
  let listening = false;
  let sttOff = false;

  const messages = $('#messages');

  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // minimal, safe markdown: fenced code, bullets, numbered steps, inline code,
  // bold, paragraphs. No math rendering — answers use plain-text notation
  // (d/dx, ∫, x^2), which needs no special handling beyond escaping.
  const BULLET = /^\s*[-*]\s+/;
  const NUMBERED = /^\s*\d+[.)]\s+/;
  // Same shape as extractCode in src/verify.js — the renderer has no require(),
  // so this is a deliberate duplicate rather than a shared module.
  const CODE_FENCE = /```\w*\n([\s\S]*?)```/;
  function extractFencedCode(text) {
    const m = CODE_FENCE.exec(text || '');
    return m ? m[1] : '';
  }
  function renderMarkdown(text) {
    const lines = text.split('\n');
    let html = '', inCode = false, listTag = null, buf = [];
    const closeList = () => { if (listTag) { html += '</' + listTag + '>'; listTag = null; } };
    const flushP = () => { if (buf.length) { html += '<p>' + inline(buf.join(' ')) + '</p>'; buf = []; } };
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    for (const raw of lines) {
      const line = raw;
      if (/^```/.test(line.trim())) {
        if (!inCode) { flushP(); closeList(); html += '<pre><code>'; inCode = true; }
        else { html += '</code></pre>'; inCode = false; }
        continue;
      }
      if (inCode) { html += esc(line) + '\n'; continue; }
      // Numbered steps were previously joined into one run-on paragraph, which
      // made any step-by-step working unreadable.
      const marker = BULLET.test(line) ? BULLET : (NUMBERED.test(line) ? NUMBERED : null);
      if (marker) {
        const tag = marker === BULLET ? 'ul' : 'ol';
        flushP();
        if (listTag !== tag) { closeList(); html += '<' + tag + '>'; listTag = tag; }
        html += '<li>' + inline(line.replace(marker, '')) + '</li>';
        continue;
      }
      if (line.trim() === '') { flushP(); closeList(); continue; }
      buf.push(line.trim());
    }
    flushP(); closeList(); if (inCode) html += '</code></pre>';
    return html;
  }

  function clearMessages() {
    messages.innerHTML = ''; aiEl = null; caretEl = null; lastAnswerText = ''; lastAnswerCode = '';
    $('#copy-code').classList.add('hidden');
  }

  function addUserBubble(text) {
    const b = document.createElement('div');
    b.className = 'user-bubble';
    b.textContent = text;
    messages.appendChild(b);
  }

  function startAi(small) {
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    messages.appendChild(aiEl);
  }

  function appendToken(t) {
    if (!aiEl) startAi(false);
    aiEl.dataset.raw += t;
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = t;
    aiEl.insertBefore(span, caretEl);
  }

  // `ok` false means the bubble holds an error message, which shouldn't become
  // the thing Copy hands you.
  function finalizeAi(ok) {
    if (!aiEl) return;
    const raw = aiEl.dataset.raw || '';
    lastAnswerText = ok === false ? '' : raw;
    lastAnswerCode = ok === false ? '' : extractFencedCode(raw);
    $('#copy-code').classList.toggle('hidden', !lastAnswerCode);
    aiEl.innerHTML = renderMarkdown(raw);
    aiEl = null; caretEl = null;
  }

  function setBusy(v) { busy = v; $('#send-btn').classList.toggle('busy', v); }
  function setRequestState(text, state) {
    const el = $('#request-state');
    el.textContent = text || '';
    el.dataset.state = state || '';
    $('#answer-tools').classList.toggle('visible', !!text || !!lastAnswerText);
  }
  function setToolbarStatus(text, state) {
    $('#toolbar-status-text').textContent = text;
    $('#toolbar-status').dataset.state = state;
  }
  // Working outranks everything while a request streams. Below that, a
  // transcription failure needs to stay visible until it's resolved — a toast
  // that auto-hides after 11s is easy to miss if you weren't looking at that
  // moment, and "Listening" would otherwise keep claiming to work.
  function restoreToolbarStatus() {
    if (sttOff) return setToolbarStatus('Mic off', 'stt-off');
    setToolbarStatus(listening ? 'Listening' : 'Ready', listening ? 'listening' : 'ready');
  }
  function showAnswerToolStatus(text) {
    const el = $('#answer-tool-status');
    el.textContent = text;
    clearTimeout(showAnswerToolStatus.timer);
    showAnswerToolStatus.timer = setTimeout(() => { el.textContent = ''; }, 1800);
  }

  // ---- actions -----------------------------------------------------------
  function runMode(mode, text) {
    if (busy) return;
    setBusy(true);
    setRequestState('Working', 'working');
    setToolbarStatus('Working', 'working');
    shadow.ask({ mode, text: text || '' });
  }

  document.querySelectorAll('.act').forEach((btn) => {
    btn.addEventListener('click', () => runMode(btn.dataset.mode, ''));
  });

  const input = $('#input');
  const placeholder = $('#placeholder');
  const composer = $('#composer');

  function syncPlaceholder() {
    placeholder.classList.toggle('hidden', input.value.length > 0 || document.activeElement === input);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }
  input.addEventListener('input', syncPlaceholder);
  input.addEventListener('focus', () => { composer.classList.add('focused'); placeholder.classList.add('hidden'); });
  input.addEventListener('blur', () => { composer.classList.remove('focused'); syncPlaceholder(); });
  $('#input-area').addEventListener('click', () => input.focus());

  function send() {
    const text = input.value.trim();
    if (!text) { runMode('assist', ''); return; }
    input.value = ''; syncPlaceholder();
    runMode('ask', text);
  }
  $('#send-btn').addEventListener('click', send);
  $('#copy-answer').addEventListener('click', async () => {
    if (!lastAnswerText) return showAnswerToolStatus('Nothing to copy');
    try {
      await navigator.clipboard.writeText(lastAnswerText);
      showAnswerToolStatus('Copied');
    } catch { showAnswerToolStatus('Copy unavailable'); }
  });
  $('#copy-code').addEventListener('click', async () => {
    if (!lastAnswerCode) return;
    try {
      await navigator.clipboard.writeText(lastAnswerCode);
      showAnswerToolStatus('Code copied');
    } catch { showAnswerToolStatus('Copy unavailable'); }
  });
  $('#regenerate-answer').addEventListener('click', () => {
    if (lastRequest && !busy) runMode(lastRequest.mode, lastRequest.text);
  });
  $('#stop-answer').addEventListener('click', async () => {
    if (!busy) return;
    await shadow.cancelAsk();
    setBusy(false);
    finalizeAi(true);
    setRequestState('Stopped', 'stopped');
    restoreToolbarStatus();
    showAnswerToolStatus('Stopped');
  });
  $('#transcript-btn').addEventListener('click', async () => {
    const text = await shadow.transcriptGet();
    if (!text) return showStatus('Nothing captured yet.');
    try {
      await navigator.clipboard.writeText(text);
      showStatus('Transcript copied.');
    } catch { showStatus('Copy unavailable.'); }
  });
  $('#clear-answer').addEventListener('click', () => {
    clearMessages();
    setRequestState('', '');
    $('#answer-tools').classList.remove('visible');
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) { e.preventDefault(); send(); }
    if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); runMode('assist', ''); }
  });

  // Smart toggle
  const smartBtn = $('#smart-toggle');
  smartBtn.addEventListener('click', async () => {
    settings.smart = !settings.smart;
    smartBtn.classList.toggle('on', settings.smart);
    await shadow.settingsSet({ smart: settings.smart });
  });

  function setCollapsed(collapsed) {
    $('#panel').classList.toggle('collapsed', collapsed);
    $('#hide-btn').classList.toggle('collapsed', collapsed);
    $('#live-dot').style.display = collapsed ? 'none' : '';
  }

  function scrollOverlay(direction) {
    const delta = direction === 'up' ? -180 : 180;
    messages.scrollBy({ top: delta, behavior: 'smooth' });
  }

  // Hide / collapse. Panic is the same collapse — it leaves the toolbar up rather
  // than hiding the window, so there's something visible to click to get back.
  const toggleCollapsed = () => setCollapsed(!$('#panel').classList.contains('collapsed'));
  $('#hide-btn').addEventListener('click', toggleCollapsed);
  $('#panic-btn').addEventListener('click', toggleCollapsed);
  shadow.on('overlay:panic', toggleCollapsed);

  // Stop = start/stop listening. Kick off system-audio capture straight from the click so
  // the user-gesture is fresh for getDisplayMedia (loopback capture needs it).
  $('#stop-btn').addEventListener('click', () => {
    const turningOn = !$('#stop-btn').classList.contains('active');
    if (turningOn) startSystemAudio();
    shadow.captureToggle();
  });

  // ---- capture: shared Float32 -> Int16 PCM conversion --------------------
  function toInt16(f) {
    const out = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    return out;
  }

  // ---- capture: shared silent-tap wiring (stream -> ScriptProcessor -> onPcm) ----
  function makeAudioTap(stream, onPcm) {
    const ctx = new AudioContext({ sampleRate: 16000 });
    const node = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const sink = ctx.createGain(); sink.gain.value = 0; // run processor silently
    node.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
    proc.onaudioprocess = (e) => onPcm(toInt16(e.inputBuffer.getChannelData(0)).buffer);
    return {
      stop() {
        proc.disconnect(); proc.onaudioprocess = null;
        node.disconnect();
        ctx.close();
        stream.getTracks().forEach((t) => t.stop());
      }
    };
  }

  // ---- capture: mic (renderer side) --------------------------------------
  let micStream = null, micTap = null, micWanted = false;
  async function startMic() {
    micWanted = true;
    if (micStream) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      // Capture can be toggled off while the permission prompt / device open is
      // still pending. Without this the tap gets built after stopMic() already
      // ran and the mic stays live with the indicator showing off.
      if (!micWanted) { stream.getTracks().forEach((t) => t.stop()); return; }
      micStream = stream;
      micTap = makeAudioTap(micStream, (buf) => shadow.micPcm(buf));
    } catch (err) {
      shadow.log('mic error: ' + (err && err.message));
    }
  }
  function stopMic() {
    micWanted = false;
    if (micTap) { micTap.stop(); micTap = null; }
    micStream = null;
  }

  // ---- capture: system/meeting audio (getDisplayMedia loopback, in shadow's process) ----
  let sysStream = null, sysTap = null, sysStarting = null, sysWanted = false;
  async function startSystemAudio() {
    sysWanted = true;
    if (sysStream) return;
    if (sysStarting) return sysStarting;
    sysStarting = (async () => {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        if (!sysWanted) { stream.getTracks().forEach((t) => t.stop()); return; }
        stream.getVideoTracks().forEach((t) => t.stop()); // we only want the audio
        const tracks = stream.getAudioTracks();
        if (!tracks.length) { shadow.log('system audio: no loopback track (macOS loopback unsupported here)'); stream.getTracks().forEach((t) => t.stop()); return; }
        sysStream = new MediaStream(tracks);
        sysTap = makeAudioTap(sysStream, (buf) => shadow.systemPcm(buf));
        shadow.log('system audio: capturing loopback');
      } catch (err) {
        shadow.log('system audio error: ' + (err && err.message));
      } finally {
        sysStarting = null;
      }
    })();
    return sysStarting;
  }
  function stopSystemAudio() {
    sysWanted = false;
    if (sysTap) { sysTap.stop(); sysTap = null; }
    sysStream = null;
  }

  // ---- events from main --------------------------------------------------
  shadow.on('capture:state', ({ active }) => {
    $('#live-dot').classList.toggle('off', !active);
    $('#stop-btn').classList.toggle('active', active);
    listening = active;
    if (!busy) restoreToolbarStatus();
    if (active) { startMic(); startSystemAudio(); } else { stopMic(); stopSystemAudio(); }
  });
  shadow.on('stt:state', ({ off }) => { sttOff = off; if (!busy) restoreToolbarStatus(); });
  shadow.on('overlay:scroll', ({ direction }) => scrollOverlay(direction));
  shadow.on('overlay:focus-input', () => input.focus());
  shadow.on('llm:start', ({ userBubble, small, mode, text, replayable }) => {
    clearMessages();
    if (userBubble) addUserBubble(userBubble);
    startAi(!!small);
    setBusy(true);
    setRequestState('Generating', 'working');
    setToolbarStatus('Working', 'working');
    // Main is the only place that knows the mode for shortcut-driven runs.
    lastRequest = replayable ? { mode, text: text || '' } : null;
    // The `hidden` attribute is a UA-origin rule and loses to
    // `.answer-tools button { display: grid }`; .hidden carries !important.
    $('#regenerate-answer').classList.toggle('hidden', !lastRequest);
  });
  shadow.on('llm:token', ({ text }) => appendToken(text));
  shadow.on('llm:done', () => {
    finalizeAi(true); setBusy(false); setRequestState('', ''); restoreToolbarStatus();
  });
  shadow.on('llm:error', ({ message }) => {
    if (!aiEl) startAi(true);
    aiEl.dataset.raw = message; finalizeAi(false); setBusy(false);
    setRequestState('Something went wrong', 'error');
    restoreToolbarStatus();
  });
  let statusTimer = null;
  function showStatus(message) {
    let el = document.getElementById('shadow-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'shadow-status';
      const panel = document.getElementById('panel');
      panel.insertBefore(el, document.getElementById('action-row'));
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => el.classList.remove('show'), 11000);
  }
  shadow.on('status', ({ message }) => { shadow.log('[status] ' + message); showStatus(message); });

  // ---- settings ----------------------------------------------------------
  const scrim = $('#settings-scrim');
  // ⌘, opens Settings from anywhere, including while the mouse sits off the
  // panel in click-through mode — without forcing setIgnore(false) here, clicks
  // on the freshly-opened modal fell through to whatever's behind shadow until
  // the mouse happened to move.
  function openSettings() { fillSettings(); loadKeys(); scrim.classList.remove('hidden'); setIgnore(false); }
  function closeSettings() {
    // Closing mid-recording would otherwise leave every global shortcut released.
    if (recordingId) stopRecording(false);
    saveSettings();
    scrim.classList.add('hidden');
  }
  $('#more-btn').addEventListener('click', openSettings);
  $('#s-close').addEventListener('click', closeSettings);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeSettings(); });

  function fillSettings() {
    document.querySelectorAll('#provider-seg button').forEach((b) => b.classList.toggle('on', b.dataset.provider === settings.provider));
    document.querySelectorAll('#stt-seg button').forEach((b) => b.classList.toggle('on', b.dataset.stt === (settings.sttProvider || 'auto')));
    $('#key-openai').value = settings.apiKeys.openai || '';
    $('#key-anthropic').value = settings.apiKeys.anthropic || '';
    $('#key-gemini').value = settings.apiKeys.gemini || '';
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    $('#s-status').textContent = statusText();
    $('#s-version').textContent = 'shadow v' + version;
    document.querySelectorAll('#pos-grid button').forEach((b) => b.classList.toggle('on', b.dataset.pos === (settings.windowPosition || 'top-center')));
    $('#recap-on-stop').checked = !!settings.recapOnStop;
  }

  // ---- settings: tabs -----------------------------------------------------
  document.querySelectorAll('.s-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.s-tab').forEach((t) => t.classList.toggle('on', t === tab));
      document.querySelectorAll('.s-panel').forEach((p) => p.classList.toggle('hidden', p.id !== 's-panel-' + tab.dataset.tab));
    });
  });

  // ---- settings: screen position -------------------------------------------
  document.querySelectorAll('#pos-grid button').forEach((b) => b.addEventListener('click', async () => {
    document.querySelectorAll('#pos-grid button').forEach((x) => x.classList.toggle('on', x === b));
    settings.windowPosition = b.dataset.pos;
    await shadow.windowSetPosition(b.dataset.pos);
  }));

  // ---- settings: keybinds ---------------------------------------------------
  // Electron wants accelerator strings ('CommandOrControl+Shift+H'); the user
  // presses keys. These two convert between that and something readable.
  const KEY_ALIASES = { Enter: 'Return', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab' };
  function accelKey(e) {
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return null;
    if (KEY_ALIASES[e.key]) return KEY_ALIASES[e.key];
    if (/^F\d{1,2}$/.test(e.key)) return e.key;
    // e.code so the printed key doesn't shift under Shift/Alt (⌥H must not become '˙').
    if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
    if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
    return e.key.length === 1 ? e.key.toUpperCase() : null;
  }
  function prettyAccel(accel) {
    if (!accel) return 'Not set';
    const mac = shadow.platform === 'darwin';
    return accel.split('+').map((p) => {
      if (p === 'CommandOrControl') return mac ? '⌘' : 'Ctrl';
      if (p === 'Shift') return mac ? '⇧' : 'Shift';
      if (p === 'Alt') return mac ? '⌥' : 'Alt';
      if (p === 'Return') return '↵';
      if (p === 'Up') return '↑';
      if (p === 'Down') return '↓';
      return p;
    }).join(mac ? '' : '+');
  }

  let keyActions = [], keyBinds = {}, keyFailed = [], recordingId = null;
  // What's actually bound right now. Separate from keyBinds because Settings
  // posts keyBinds back to disk, and the solve rotation must never be saved.
  let keyLive = {};

  function renderKeys() {
    const list = $('#keys-list');
    list.innerHTML = '';
    keyActions.forEach((a) => {
      const row = document.createElement('div');
      row.className = 's-key-row';
      const name = document.createElement('span');
      name.textContent = a.label;
      const btn = document.createElement('button');
      btn.className = 's-key-btn';
      btn.dataset.id = a.id;
      if (recordingId === a.id) {
        btn.textContent = 'Press keys…';
        btn.classList.add('recording');
      } else {
        btn.textContent = prettyAccel(keyBinds[a.id]);
        if (!keyBinds[a.id]) btn.classList.add('unbound');
        if (keyFailed.some((f) => f.id === a.id)) btn.classList.add('conflict');
      }
      btn.addEventListener('click', () => startRecording(a.id));
      row.appendChild(name); row.appendChild(btn);
      list.appendChild(row);
    });
    const conflicts = keyFailed.map((f) => prettyAccel(f.accel)).join(', ');
    $('#keys-status').textContent = recordingId
      ? 'Press a combination with ⌘/Ctrl, Alt or Shift. Backspace clears it, Esc cancels.'
      : (conflicts ? 'In use by another app or duplicated here: ' + conflicts : 'Changes apply immediately.');
  }

  async function startRecording(id) {
    recordingId = id;
    await shadow.shortcutsCapture(true); // release globals so we can see the keys
    renderKeys();
  }
  async function commitKeys() {
    const res = await shadow.shortcutsSet(keyBinds);
    keyBinds = res.shortcuts; keyFailed = res.failed || [];
    keyLive = { ...keyLive, ...res.shortcuts }; // a rebind clears the rotation, so saved == live again
    // closeSettings() writes the whole `settings` object back, so the copy read
    // at boot has to be refreshed or it would overwrite what we just saved.
    settings.shortcuts = res.shortcuts;
    renderKeys();
  }
  async function stopRecording(save) {
    recordingId = null;
    if (save) await commitKeys();
    else { await shadow.shortcutsCapture(false); renderKeys(); }
  }

  // Capture phase so a recording press never reaches the app's own handlers.
  document.addEventListener('keydown', (e) => {
    if (!recordingId) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { stopRecording(false); return; }
    if (e.key === 'Backspace') { keyBinds[recordingId] = ''; stopRecording(true); return; }
    const key = accelKey(e);
    if (!key) return; // modifier alone — keep waiting
    const mods = [];
    if (e.metaKey || e.ctrlKey) mods.push('CommandOrControl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    // A global shortcut with no modifier would swallow that key everywhere.
    if (!mods.length) { $('#keys-status').textContent = 'Needs at least one modifier (⌘/Ctrl, Alt or Shift).'; return; }
    keyBinds[recordingId] = mods.concat(key).join('+');
    stopRecording(true);
  }, true);

  async function loadKeys() {
    const res = await shadow.shortcutsGet();
    keyActions = res.actions;
    keyBinds = { ...res.defaults, ...res.shortcuts };
    keyLive = { ...keyBinds, ...res.effective };
    renderKeys();
  }
  $('#keys-reset').addEventListener('click', async () => {
    const res = await shadow.shortcutsGet();
    keyBinds = { ...res.defaults };
    await commitKeys();
  });

  // ---- quit ------------------------------------------------------------
  $('#quit-btn').addEventListener('click', () => shadow.quitApp());
  let updateZip = null;
  $('#update-btn').addEventListener('click', async () => {
    const btn = $('#update-btn');
    if (updateZip) {
      btn.textContent = 'Installing… shadow will restart';
      btn.disabled = true;
      // Only macOS swaps the bundle in place; elsewhere this just opens the
      // download, so don't leave the button stuck on "Installing…".
      // installUpdate can reject outright (offline mid-download, bad zip on the
      // release, unzip failing) — without a catch that left the button disabled
      // on "Installing…" forever, with no way to retry short of restarting shadow.
      try {
        const res = await shadow.installUpdate(updateZip);
        if (!res || !res.ok) {
          btn.textContent = 'Download opened in your browser — unzip and replace shadow';
          btn.disabled = false;
        }
      } catch {
        btn.textContent = 'Install failed — click to try again';
        btn.disabled = false;
      }
      return;
    }
    btn.textContent = 'Checking…';
    try {
      const { current, latest, zipUrl } = await shadow.checkUpdate();
      if (latest && latest !== current && zipUrl) {
        updateZip = zipUrl;
        btn.textContent = 'Update available: v' + latest + ' — click to install';
      } else {
        btn.textContent = 'Up to date (v' + current + ')';
      }
    } catch {
      btn.textContent = 'Check failed — try again';
    }
  });
  function statusText() {
    const k = settings.apiKeys;
    const has = [k.openai && 'OpenAI', k.anthropic && 'Anthropic', k.gemini && 'Gemini'].filter(Boolean);
    // Mirror createSTT's resolution so this never claims a provider that has no key.
    const want = settings.sttProvider || 'auto';
    const stt = want === 'auto'
      ? (k.openai ? 'Whisper' : (k.gemini ? 'Gemini' : 'none'))
      : (k[want] ? (want === 'openai' ? 'Whisper' : 'Gemini') : want + ' (no key)');
    return 'Solving: ' + settings.provider + ' · transcription: ' + stt + ' · keys: ' + (has.join(', ') || 'none set');
  }
  function syncCurrentModelFields() {
    if (!settings.models[settings.provider]) settings.models[settings.provider] = {};
    settings.models[settings.provider].fast = $('#model-fast').value.trim();
    settings.models[settings.provider].smart = $('#model-smart').value.trim();
  }
  document.querySelectorAll('#stt-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.sttProvider = b.dataset.stt;
    document.querySelectorAll('#stt-seg button').forEach((x) => x.classList.toggle('on', x === b));
    $('#s-status').textContent = statusText();
  }));
  document.querySelectorAll('#provider-seg button').forEach((b) => b.addEventListener('click', () => {
    syncCurrentModelFields();
    settings.provider = b.dataset.provider;
    document.querySelectorAll('#provider-seg button').forEach((x) => x.classList.toggle('on', x === b));
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    $('#s-status').textContent = statusText();
  }));
  async function saveSettings() {
    settings.apiKeys.openai = $('#key-openai').value.trim();
    settings.apiKeys.anthropic = $('#key-anthropic').value.trim();
    settings.apiKeys.gemini = $('#key-gemini').value.trim();
    settings.recapOnStop = $('#recap-on-stop').checked;
    syncCurrentModelFields();
    await shadow.settingsSet(settings);
  }

  // ---- example conversation (matches the reference screenshot) ------------
  function showExample() {
    clearMessages();
    addUserBubble('What should I say?');
    const ai = document.createElement('div');
    ai.className = 'ai-text';
    ai.textContent = '“A discounted cash flow model values a company by projecting future free cash flows and discounting them to present value using the weighted average cost of capital.”';
    messages.appendChild(ai);
  }

  // ---- global keys -------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !scrim.classList.contains('hidden')) closeSettings();
    if (e.metaKey && e.key === ',') { e.preventDefault(); openSettings(); }
  });

  // ---- click-through: only the UI blocks the mouse; empty gaps pass to your screen ----
  let ignoring = null;
  function setIgnore(v) { if (v !== ignoring) { ignoring = v; shadow.setIgnoreMouse(v); } }
  document.addEventListener('mousemove', (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const overUI = !!(el && el.closest && el.closest('#toolbar, #panel-wrap, #settings-scrim, #onboard-scrim'));
    setIgnore(!overUI);
  });
  setIgnore(true); // start fully click-through; hovering the panel re-enables it

  // ---- onboarding / first-run tutorial -----------------------------------
  const obScrim = $('#onboard-scrim');
  const isMac = shadow.platform === 'darwin';
  const kbd = (id) => keyLive[id] ? '<span class="kbd">' + prettyAccel(keyLive[id]) + '</span>' : '<span class="kbd">unbound</span>';
  const OB_STEPS = [
    {
      icon: 'sparkles',
      title: 'Welcome to shadow',
      body: 'shadow is a private AI copilot that floats over your screen. It can <strong>see your screen</strong>, <strong>hear your meetings</strong>, and help you answer questions or solve coding problems — while staying hidden from most screen shares.<br><br>This quick guide gets you running in about a minute.'
    },
    ...(isMac ? [{
      icon: 'shield',
      title: 'Allow shadow to see & hear',
      body: 'shadow needs two macOS permissions. Click each button, turn <strong>shadow</strong> ON in the window that opens, then come back here.<ul><li><strong>Microphone</strong> — to hear you</li><li><strong>Screen Recording</strong> — to see your screen and hear meeting audio</li></ul>',
      buttons: [
        { label: 'Open Microphone settings', action: () => shadow.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone') },
        { label: 'Open Screen Recording settings', action: () => shadow.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') }
      ]
    }] : [{
      icon: 'shield',
      title: 'Allow shadow to see & hear',
      body: 'When you first use a feature, Windows will prompt for <strong>Microphone</strong> and <strong>screen share</strong> access — click <strong>Allow</strong>. No manual settings needed.'
    }]),
    {
      icon: 'key',
      title: 'Connect an AI provider',
      body: 'shadow uses <strong>your own</strong> API key — pick <span class="hl">OpenAI</span>, <span class="hl">Anthropic</span>, or <span class="hl">Google Gemini</span>. Get a key from your provider, then paste it into shadow\'s Settings.<br><br><strong>Tip:</strong> the listening features need speech-to-text access (an OpenAI key with Whisper, or a Gemini key). A chat-only key still powers screen &amp; coding help.',
      buttons: [{ label: 'Open shadow Settings', action: () => { finishOnboard(); openSettings(); } }]
    },
    {
      icon: 'eye-off',
      title: 'Stay hidden in Zoom',
      body: 'shadow is hidden from most screen shares automatically (Google Meet, Teams, QuickTime — nothing to do). <strong>Zoom needs one setting:</strong><br><br>Zoom → <span class="hl">Settings</span> → <span class="hl">Share Screen</span> → <span class="hl">Advanced</span> → <strong>Screen capture mode</strong> → choose <strong>“Advanced capture with window filtering.”</strong><br><br>Avoid “<strong>without</strong> window filtering” — that mode reveals shadow.'
    },
    {
      icon: 'check',
      title: 'You’re all set',
      // A function, not a string: the solve shortcut moves after every use, so
      // this has to read the live binding each time the guide is rendered.
      body: () => `How to use shadow:<ul><li>${kbd('panic')} — <strong>Panic</strong>: collapse shadow instantly if someone walks over. Press again to bring it back.</li><li>${kbd('assist')} — <strong>Assist</strong> with whatever's on screen or being said</li><li>${kbd('solve')} — solve a coding problem on screen. <strong>This one changes after every use</strong> — the new combination shows up here.</li><li>${kbd('addShot')} — add another screenshot before solving (for problems that need scrolling). <strong>This one changes after every use</strong> too</li><li>${kbd('scrollUp')} / ${kbd('scrollDown')} — scroll the answer</li><li>${kbd('focusInput')} — jump to the input box</li><li>Click <strong>▢</strong> in the top bar to start listening to a meeting</li><li>Type a question and press <span class="kbd">↵</span></li></ul>Reopen this guide anytime by clicking the <strong>shadow logo</strong>. Quit with ${kbd('quit')}.`
    }
  ];
  let obIndex = 0;
  function renderOnboard() {
    const step = OB_STEPS[obIndex];
    $('#ob-icon').innerHTML = icon(step.icon, { size: 34 });
    $('#ob-title').textContent = step.title;
    $('#ob-body').innerHTML = typeof step.body === 'function' ? step.body() : step.body;
    const btns = $('#ob-buttons'); btns.innerHTML = '';
    (step.buttons || []).forEach((b) => { const el = document.createElement('button'); el.textContent = b.label; el.addEventListener('click', b.action); btns.appendChild(el); });
    const dots = $('#ob-dots'); dots.innerHTML = '';
    OB_STEPS.forEach((_, i) => { const d = document.createElement('span'); if (i === obIndex) d.className = 'on'; dots.appendChild(d); });
    $('#ob-back').style.visibility = obIndex === 0 ? 'hidden' : 'visible';
    $('#ob-next').textContent = obIndex === OB_STEPS.length - 1 ? 'Done' : 'Next';
    $('#ob-skip').style.visibility = obIndex === OB_STEPS.length - 1 ? 'hidden' : 'visible';
  }
  function showOnboard() { obIndex = 0; renderOnboard(); obScrim.classList.remove('hidden'); setIgnore(false); }
  async function finishOnboard() {
    obScrim.classList.add('hidden');
    if (settings && !settings.onboarded) { settings.onboarded = true; await shadow.settingsSet({ onboarded: true }); }
  }
  $('#ob-next').addEventListener('click', () => { if (obIndex === OB_STEPS.length - 1) finishOnboard(); else { obIndex++; renderOnboard(); } });
  $('#ob-back').addEventListener('click', () => { if (obIndex > 0) { obIndex--; renderOnboard(); } });
  $('#ob-skip').addEventListener('click', finishOnboard);
  $('#logo-btn').addEventListener('click', showOnboard);
  // Solve rotates to a new combination after each use; keep the guide (and the
  // Settings row, if it's open) showing what's actually bound.
  shadow.on('shortcuts:changed', (d) => {
    keyLive = { ...keyLive, ...(d && d.effective) };
    if (!obScrim.classList.contains('hidden')) renderOnboard();
  });

  // ---- boot --------------------------------------------------------------
  (async function boot() {
    settings = await shadow.settingsGet();
    version = await shadow.getVersion();
    smartBtn.classList.toggle('on', !!settings.smart);
    showExample();
    syncPlaceholder();
    const keys = await shadow.shortcutsGet();
    keyLive = { ...keys.defaults, ...keys.shortcuts, ...keys.effective };
    const back = keys.shortcuts.panic || keys.defaults.panic;
    $('#panic-btn').setAttribute('aria-label', back
      ? 'Panic — collapse shadow (' + prettyAccel(back) + ' toggles it)'
      : 'Panic — collapse shadow');
    const st = await shadow.captureState();
    $('#live-dot').classList.toggle('off', !st.active);
    $('#stop-btn').classList.toggle('active', st.active);
    listening = st.active;
    restoreToolbarStatus();
    if (!settings.onboarded) showOnboard();
  })();
})();
