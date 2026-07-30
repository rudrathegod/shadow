// Self-check for the pure logic that can fail silently: `node test.js`.
// Only covers modules that don't need an Electron app object.
const assert = require('assert');
const { extractCode, stripFences, runSandboxed } = require('./src/verify');
const { pcmToWav, rms16 } = require('./src/wav');

// --- extractCode -----------------------------------------------------------
assert.strictEqual(extractCode('no fences here'), null);
assert.deepStrictEqual(extractCode('```python\nx = 1\n```'), { lang: 'python', code: 'x = 1\n' });
assert.strictEqual(extractCode('```\nplain\n```').lang, '', 'unlabelled fence has no lang');
assert.strictEqual(stripFences('```js\na\n```'), 'a\n');
assert.strictEqual(stripFences('  bare text  '), 'bare text');

// --- the self-repair splice (main.js verifyAndRepair) ----------------------
// Replacing via /```[\s\S]*?```/ hit the first backtick run, not the block that
// was actually tested, and a string replacement ate $&/$'/$` in the new code —
// both silently showed code that differed from what passed the test.
{
  const answer = 'Use ```str.replace``` carefully.\n\n```javascript\nconst a = 1;\n```\n\nO(n).';
  const extracted = extractCode(answer);
  const fixedCode = 'const fix = s => s.replace(/x/g, "[$&]");';
  const out = answer.replace(extracted.code, () => fixedCode);
  assert.ok(out.includes('Use ```str.replace``` carefully.'), 'prose before the block survives');
  assert.ok(out.includes(fixedCode), '$& is inserted literally, not expanded');
  assert.ok(!out.includes('const a = 1;'), 'the tested block is the one replaced');
}

// An empty fenced block still reports a lang, so verifyAndRepair must reject it
// on code as well — an empty needle would splice the fix in front of the prose.
{
  const empty = extractCode('```js\n```');
  assert.strictEqual(empty.lang, 'js');
  assert.strictEqual(empty.code, '');
  assert.strictEqual('a\n\n```js\n```'.replace(empty.code, () => 'X').slice(0, 1), 'X',
    'documents why the !code.trim() guard exists');
}

// --- store: retired model migration ----------------------------------------
// A saved value beats DEFAULTS in the merge, so bumping DEFAULTS alone never
// reached anyone who had opened Settings before. These must be rewritten.
{
  const { _deepMerge, _dropRetiredModels, _DEFAULTS } = require('./src/store');
  const stale = { models: { gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-1.5-pro' } } };
  const merged = _dropRetiredModels(_deepMerge(_DEFAULTS, stale));
  assert.strictEqual(merged.models.gemini.fast, 'gemini-flash-latest');
  assert.strictEqual(merged.models.gemini.smart, 'gemini-pro-latest');
  // The whole Claude 3.x family is retired, including dated suffixes.
  for (const id of ['claude-3-5-haiku-20241022', 'claude-3-5-sonnet-latest', 'claude-3-7-sonnet-20250219', 'claude-3-opus-20240229']) {
    const m = _dropRetiredModels(_deepMerge(_DEFAULTS, { models: { anthropic: { smart: id } } }));
    assert.strictEqual(m.models.anthropic.smart, 'claude-sonnet-5', id + ' should be replaced');
  }
  // Current ids must not be caught by the claude-3 prefix test.
  for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']) {
    const m = _dropRetiredModels(_deepMerge(_DEFAULTS, { models: { anthropic: { smart: id } } }));
    assert.strictEqual(m.models.anthropic.smart, id, id + ' must survive');
  }
  // A model the user deliberately chose must survive untouched.
  const custom = { models: { gemini: { fast: 'gemini-3-something' } } };
  assert.strictEqual(_dropRetiredModels(_deepMerge(_DEFAULTS, custom)).models.gemini.fast, 'gemini-3-something');
  // Prototype pollution via a JSON own-key must not reach Object.prototype.
  _deepMerge({}, JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.strictEqual({}.polluted, undefined, 'deepMerge drops __proto__');
}

// --- STT provider selection ------------------------------------------------
// Transcription picks its provider independently of solving/chat, because
// Anthropic has no speech API. 'auto' keeps the historic Whisper-then-Gemini
// fallback; an explicit choice must NOT quietly fall back to the other one.
{
  const { createSTT } = require('./src/stt');
  const make = (apiKeys, sttProvider) =>
    createSTT({ apiKeys, sttProvider, models: { gemini: { fast: 'gemini-flash-latest' } } });
  const both = { openai: 'o', gemini: 'g' };

  assert.deepStrictEqual(make(both, 'auto').providers, ['openai', 'gemini'], 'auto prefers Whisper');
  assert.deepStrictEqual(make({ gemini: 'g' }, 'auto').providers, ['gemini'], 'auto falls back');
  assert.deepStrictEqual(make(both, 'openai').providers, ['openai'], 'explicit openai only');
  assert.deepStrictEqual(make(both, 'gemini').providers, ['gemini'], 'explicit gemini only');
  // Existing installs have no sttProvider saved at all.
  assert.deepStrictEqual(make(both, undefined).providers, ['openai', 'gemini'], 'undefined behaves as auto');
  // Choosing a provider whose key is missing must report unavailable rather
  // than silently transcribing with the other one.
  assert.strictEqual(make({ gemini: 'g' }, 'openai').available, false);
  assert.strictEqual(make({ openai: 'o' }, 'gemini').available, false);
  assert.strictEqual(make({}, 'auto').available, false);
  assert.strictEqual(make({ gemini: 'g' }, 'openai').wanted, 'openai', 'caller can name the missing key');
}

// --- rate-limit detection --------------------------------------------------
// Shared by the chat retry loop and the STT cooldown, and the two paths hand it
// different error shapes: the Gemini SDK throws an Error whose message embeds
// the status, while stt.js builds a plain {status, code, message, provider}.
{
  const { isRateLimited } = require('./src/llm');
  const geminiSdkError = new Error(
    'got status: 429 Too Many Requests. {"error":{"message":"exception parsing response","code":429,"status":"Too Many Requests"}}');
  assert.ok(isRateLimited(geminiSdkError), 'message-embedded 429');
  assert.ok(isRateLimited({ status: 429, message: 'x' }), 'stt error shape');
  assert.ok(isRateLimited({ error: { code: 429 }, message: 'x' }), 'nested code');
  assert.ok(isRateLimited({ message: 'Rate limit exceeded' }), 'wording only');
  assert.ok(!isRateLimited({ status: 500, message: 'server error' }), '500 is not a rate limit');
  assert.ok(!isRateLimited({ status: 403, message: 'forbidden' }), '403 must stay a hard failure');
  assert.ok(!isRateLimited(null) && !isRateLimited(undefined), 'null-safe');
}

// --- wav -------------------------------------------------------------------
{
  const pcm = Buffer.alloc(8); // 4 samples of silence
  const wav = pcmToWav(pcm, 16000, 1);
  assert.strictEqual(wav.length, 44 + pcm.length);
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(wav.readUInt32LE(4), 36 + pcm.length, 'RIFF chunk size');
  assert.strictEqual(wav.readUInt32LE(24), 16000, 'sample rate');
  assert.strictEqual(wav.readUInt32LE(40), pcm.length, 'data chunk size');

  assert.strictEqual(rms16(Buffer.alloc(0)), 0);
  assert.strictEqual(rms16(pcm), 0, 'silence is below any gate');
  const loud = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 2) loud.writeInt16LE(1000, i);
  assert.strictEqual(rms16(loud), 1000);
}

// --- renderer tests (driven in jsdom) --------------------------------------
// Boots the real renderer against the real index.html, with the preload API
// stubbed. `state` exposes what the renderer sent back out.
function bootRenderer() {
  const fs = require('fs');
  const path = require('path');
  const { JSDOM } = require('jsdom');
  const ROOT = __dirname;
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8'),
    { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const defaults = require('./src/store').defaultShortcuts();
  const actions = Object.keys(defaults).map((id) => ({ id, label: id }));
  const state = { saved: null, captured: [], handlers: {}, defaults, actions, ignoreCalls: [] };
  const noop = () => {};
  window.shadow = {
    platform: 'darwin',
    getVersion: async () => '0', settingsGet: async () => ({
      provider: 'anthropic', smart: true, windowPosition: 'top-center',
      apiKeys: {}, models: { anthropic: {} }, shortcuts: { ...defaults }, onboarded: true
    }),
    settingsSet: async () => ({}), captureState: async () => ({ active: false }),
    shortcutsGet: async () => ({ actions, shortcuts: { ...defaults }, defaults: { ...defaults } }),
    shortcutsSet: async (n) => { state.saved = { ...n }; return { shortcuts: { ...n }, failed: [] }; },
    shortcutsCapture: async (on) => { state.captured.push(on); return true; },
    windowSetPosition: async () => ({}), checkUpdate: async () => ({}), installUpdate: async () => ({}),
    setIgnoreMouse: (v) => state.ignoreCalls.push(v), log: noop, ask: noop, captureToggle: async () => {},
    cancelAsk: async () => true,
    quitApp: noop, openPane: noop, micPcm: noop, systemPcm: noop, panic: noop,
    on: (ch, cb) => { state.handlers[ch] = cb; }
  };
  window.eval(fs.readFileSync(path.join(ROOT, 'renderer/icons.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'renderer/renderer.js'), 'utf8'));
  return { window, state, tick: () => new Promise((r) => setTimeout(r, 30)) };
}

// --- answer controls -------------------------------------------------------
// Regenerate has to replay the mode main actually ran, which for a shortcut-
// driven run the renderer never saw; and an error message must not become the
// thing Copy hands you.
async function testAnswerControls() {
  const { window, state, tick } = bootRenderer();
  await tick();
  const $ = (s) => window.document.querySelector(s);
  const status = () => $('#toolbar-status-text').textContent;

  // A shortcut-driven leetcode run: preset images can't be replayed.
  state.handlers['llm:start']({ userBubble: null, small: false, mode: 'leetcode', text: '', replayable: false });
  assert.strictEqual(status(), 'Working', 'toolbar reports Working while streaming');
  // Asserted as the class, not the `hidden` attribute or a computed style: the
  // attribute's UA rule loses to `.answer-tools button { display: grid }`, and
  // jsdom's getComputedStyle ignores cascade origin so it would pass either way.
  const regenHidden = () => $('#regenerate-answer').classList.contains('hidden');
  assert.ok(regenHidden(), 'regenerate hidden when the run cannot be replayed');

  state.handlers['llm:token']({ text: 'answer body' });
  state.handlers['llm:done']({});
  assert.strictEqual(status(), 'Ready', 'toolbar returns to Ready when idle');
  $('#copy-answer').click();
  await tick();
  assert.ok($('#answer-tool-status').textContent, 'copy acts on a real answer');

  // An error leaves nothing worth copying.
  state.handlers['llm:start']({ userBubble: null, small: false, mode: 'assist', text: 'hi', replayable: true });
  assert.ok(!regenHidden(), 'regenerate offered for a replayable run');
  state.handlers['llm:error']({ message: 'Error: boom' });
  $('#answer-tool-status').textContent = '';
  $('#copy-answer').click();
  await tick();
  assert.strictEqual($('#answer-tool-status').textContent, 'Nothing to copy',
    'copy refuses an error bubble, and says so');
  assert.strictEqual(status(), 'Ready', 'toolbar recovers after an error');
}

// --- icon integrity --------------------------------------------------------
// A typo'd name renders an <svg> with no children, and a malformed arc (an `a`
// command with anything but 7 params) makes the browser silently drop the rest
// of the subpath — both are invisible until you look at the running app.
async function testIcons() {
  const { window, tick } = bootRenderer();
  await tick();
  const svgs = [...window.document.querySelectorAll('svg')];
  assert.ok(svgs.length > 8, 'renderer painted its icons: ' + svgs.length);
  for (const svg of svgs) {
    assert.ok(svg.children.length, 'empty svg — unknown icon name near: ' + svg.parentElement.id);
  }
  const src = require('fs').readFileSync(require('path').join(__dirname, 'renderer/icons.js'), 'utf8');
  // Numbers in path data may abut (".5.5" is two), so tokenize rather than split.
  const NUM = /-?(?:\d*\.\d+|\d+\.?)/g;
  for (const [, d] of src.matchAll(/\bd="([^"]*)"/g)) {
    for (const [, params] of d.matchAll(/[aA]([-\d.,\s]+)/g)) {
      const n = params.match(NUM).length;
      assert.strictEqual(n % 7, 0, `arc takes 7 params, got ${n}: a${params.trim()}`);
    }
  }
}

// --- answer rendering ------------------------------------------------------
// The math branch of `assist` returns numbered working, which used to be joined
// into one run-on paragraph because only bullets were handled.
async function testMarkdown() {
  const { window, state, tick } = bootRenderer();
  await tick();
  const render = async (text) => {
    state.handlers['llm:start']({ userBubble: null, small: false });
    state.handlers['llm:token']({ text });
    state.handlers['llm:done']({});
    await tick();
    return window.document.querySelector('.ai-text').innerHTML;
  };

  const steps = await render('1. Let u = 3x^2 + 1.\n2. dy/du = 5u^4.\n3. du/dx = 6x.');
  assert.ok(/<ol>(<li>.*?<\/li>){3}<\/ol>/.test(steps), 'numbered steps become one <ol>: ' + steps);
  assert.ok(!/<p>1\./.test(steps), 'steps are not collapsed into a paragraph');

  // ")" is as common as "." for step markers.
  assert.ok(/<ol><li>first<\/li><li>second<\/li><\/ol>/.test(await render('1) first\n2) second')));

  // Bullets must still work, and switching list type must close the previous one.
  const bullets = await render('- alpha\n- beta');
  assert.ok(/<ul><li>alpha<\/li><li>beta<\/li><\/ul>/.test(bullets), bullets);
  const mixed = await render('- bullet\n1. step');
  assert.ok(/<ul><li>bullet<\/li><\/ul><ol><li>step<\/li><\/ol>/.test(mixed), 'ul closes before ol: ' + mixed);

  // Plain-text math must survive escaping untouched — no LaTeX renderer exists.
  const math = await render('Answer: ∫ x^2 dx = x^3/3 + C, lim(x->a) & d/dx');
  assert.ok(math.includes('∫ x^2 dx = x^3/3 + C'), 'unicode and carets pass through: ' + math);
  assert.ok(math.includes('lim(x-&gt;a) &amp; d/dx'), 'angle bracket and ampersand escaped: ' + math);

  // A fence still closes an open list and stays verbatim.
  const fenced = await render('1. run this\n```\nx < 1 && y\n```');
  assert.ok(/<\/ol><pre><code>x &lt; 1 &amp;&amp; y/.test(fenced), 'list closes before code: ' + fenced);
  window.close();
}

// Opening Settings via ⌘, must drop click-through, or the modal renders under
// a mouse that still passes clicks through to whatever's behind shadow.
async function testSettingsClickThrough() {
  const { window, state, tick } = bootRenderer();
  await tick();
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: ',', metaKey: true }));
  await tick();
  assert.strictEqual(state.ignoreCalls[state.ignoreCalls.length - 1], false,
    'opening settings re-enables mouse events on the panel');
  window.close();
}

// installUpdate can reject (offline mid-download, bad release asset) — the
// button must recover instead of staying stuck disabled on "Installing…".
async function testUpdateButtonRecoversFromFailure() {
  const { window, state, tick } = bootRenderer();
  await tick();
  window.shadow.checkUpdate = async () => ({ current: '1.0.0', latest: '1.1.0', zipUrl: 'https://example.test/x.zip' });
  window.shadow.installUpdate = async () => { throw new Error('network down'); };
  const btn = window.document.querySelector('#update-btn');
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  click(btn); await tick(); // "Checking..." -> finds an update
  click(btn); await tick(); // "Installing..." -> installUpdate rejects
  assert.strictEqual(btn.disabled, false, 'button re-enabled after a failed install');
  assert.match(btn.textContent, /try again/i, 'failure is surfaced, not silently stuck');
  window.close();
}

// The accelerator conversion is the kind of branchy mapping that breaks quietly:
// a wrong key name just produces a shortcut that never fires.
async function testKeybinds() {
  const { window, state, tick } = bootRenderer();
  const defaults = state.defaults, actions = state.actions;
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const press = (init) => window.document.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, ...init }));
  const keyBtn = (id) => window.document.querySelector(`.s-key-btn[data-id="${id}"]`);
  await tick();

  click(window.document.querySelector('#more-btn'));
  await tick();

  // The transcription selector defaults to Auto when nothing is saved.
  const sttOn = [...window.document.querySelectorAll('#stt-seg button')].filter((b) => b.classList.contains('on'));
  assert.strictEqual(sttOn.length, 1, 'exactly one transcription provider selected');
  assert.strictEqual(sttOn[0].dataset.stt, 'auto');
  click(window.document.querySelector('#stt-seg button[data-stt="gemini"]'));
  await tick();
  assert.strictEqual(window.document.querySelector('#stt-seg button[data-stt="gemini"]').classList.contains('on'), true);
  assert.strictEqual(window.document.querySelector('#stt-seg button[data-stt="auto"]').classList.contains('on'), false,
    'selecting one deselects the others');

  assert.strictEqual(window.document.querySelectorAll('#keys-list .s-key-row').length, actions.length,
    'one row per action');
  assert.strictEqual(keyBtn('solve').textContent, '⌘H', 'mac glyphs for the default binding');

  click(keyBtn('solve'));
  await tick();
  assert.strictEqual(state.captured[0], true, 'globals released while recording');
  press({ key: 'j', code: 'KeyJ', ctrlKey: true, shiftKey: true });
  await tick();
  assert.strictEqual(state.saved.solve, 'CommandOrControl+Shift+J');
  assert.strictEqual(keyBtn('solve').textContent, '⌘⇧J');

  // A bare key would swallow that character system-wide — must be refused.
  click(keyBtn('assist'));
  await tick();
  press({ key: 'a', code: 'KeyA' });
  await tick();
  assert.strictEqual(keyBtn('assist').textContent, 'Press keys…', 'still recording after a bare key');

  press({ key: 'Backspace', code: 'Backspace' });
  await tick();
  assert.strictEqual(state.saved.assist, '', 'Backspace unbinds');

  click(window.document.querySelector('#keys-reset'));
  await tick();
  assert.deepStrictEqual(state.saved, defaults, 'reset restores every default');
  window.close();
}

// --- runSandboxed ----------------------------------------------------------
(async () => {
  await testMarkdown();
  await testKeybinds();
  await testIcons();
  await testAnswerControls();
  await testSettingsClickThrough();
  await testUpdateButtonRecoversFromFailure();

  assert.deepStrictEqual(await runSandboxed('rust', 'fn main(){}'), { supported: false });

  const pass = await runSandboxed('javascript', 'if (1 + 1 !== 2) process.exit(1);');
  assert.ok(pass.supported && pass.ok, 'passing JS exits 0: ' + pass.error);

  const fail = await runSandboxed('javascript', 'throw new Error("boom");');
  assert.ok(fail.supported && !fail.ok && /boom/.test(fail.error), 'failure surfaces stderr');

  // The jsdom bootstrap is the whole reason DOM answers can be verified at all.
  const dom = await runSandboxed('javascript',
    'document.body.innerHTML = "<p>hi</p>";' +
    'if (document.querySelector("p").textContent !== "hi") process.exit(1);');
  assert.ok(dom.ok, 'jsdom bootstrap provides a real document: ' + dom.error);

  const loop = await runSandboxed('javascript', 'while (true) {}', 1000);
  assert.ok(!loop.ok && /timed out/.test(loop.error), 'infinite loop is killed');

  console.log('all tests passed');
})();
