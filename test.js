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

// --- runSandboxed ----------------------------------------------------------
(async () => {
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
