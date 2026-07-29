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

// --- keybind panel (renderer, driven in jsdom) -----------------------------
// The accelerator conversion is the kind of branchy mapping that breaks quietly:
// a wrong key name just produces a shortcut that never fires.
async function testKeybinds() {
  const fs = require('fs');
  const path = require('path');
  const { JSDOM } = require('jsdom');
  const ROOT = __dirname;
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8'),
    { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const defaults = require('./src/store').defaultShortcuts();
  const actions = Object.keys(defaults).map((id) => ({ id, label: id }));
  let saved = null, captured = [];
  const noop = () => {};
  window.shadow = {
    platform: 'darwin',
    getVersion: async () => '0', settingsGet: async () => ({
      provider: 'anthropic', smart: true, windowPosition: 'top-center',
      apiKeys: {}, models: { anthropic: {} }, shortcuts: { ...defaults }, onboarded: true
    }),
    settingsSet: async () => ({}), captureState: async () => ({ active: false }),
    shortcutsGet: async () => ({ actions, shortcuts: { ...defaults }, defaults: { ...defaults } }),
    shortcutsSet: async (n) => { saved = { ...n }; return { shortcuts: { ...n }, failed: [] }; },
    shortcutsCapture: async (on) => { captured.push(on); return true; },
    windowSetPosition: async () => ({}), checkUpdate: async () => ({}), installUpdate: async () => ({}),
    setIgnoreMouse: noop, log: noop, on: noop, ask: noop, captureToggle: async () => {},
    quitApp: noop, openPane: noop, micPcm: noop, systemPcm: noop
  };
  window.eval(fs.readFileSync(path.join(ROOT, 'renderer/icons.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(ROOT, 'renderer/renderer.js'), 'utf8'));
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const press = (init) => window.document.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, ...init }));
  const keyBtn = (id) => window.document.querySelector(`.s-key-btn[data-id="${id}"]`);
  await tick();

  click(window.document.querySelector('#more-btn'));
  await tick();
  assert.strictEqual(window.document.querySelectorAll('#keys-list .s-key-row').length, actions.length,
    'one row per action');
  assert.strictEqual(keyBtn('solve').textContent, '⌘H', 'mac glyphs for the default binding');

  click(keyBtn('solve'));
  await tick();
  assert.strictEqual(captured[0], true, 'globals released while recording');
  press({ key: 'j', code: 'KeyJ', ctrlKey: true, shiftKey: true });
  await tick();
  assert.strictEqual(saved.solve, 'CommandOrControl+Shift+J');
  assert.strictEqual(keyBtn('solve').textContent, '⌘⇧J');

  // A bare key would swallow that character system-wide — must be refused.
  click(keyBtn('assist'));
  await tick();
  press({ key: 'a', code: 'KeyA' });
  await tick();
  assert.strictEqual(keyBtn('assist').textContent, 'Press keys…', 'still recording after a bare key');

  press({ key: 'Backspace', code: 'Backspace' });
  await tick();
  assert.strictEqual(saved.assist, '', 'Backspace unbinds');

  click(window.document.querySelector('#keys-reset'));
  await tick();
  assert.deepStrictEqual(saved, defaults, 'reset restores every default');
  window.close();
}

// --- runSandboxed ----------------------------------------------------------
(async () => {
  await testKeybinds();

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
