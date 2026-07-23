// Self-check for generated code: run the model's own solution against a
// model-written test harness in a short-lived subprocess. JS/Python only —
// those are the runtimes already on the machine, no new dependency needed.
// ponytail: sandbox is just a subprocess + timeout, not a real jail (no seccomp/
// container). Fine for a personal tool where you'd copy-paste the same code
// into your own shell anyway; upgrade to vm2/isolated-vm/a container if this
// ever runs untrusted input from someone other than the local user.
const { spawn } = require('child_process');

// Plain `node -e` has no `document`/`window` — most interview-style JS problems
// (event handlers, DOM manipulation) would silently "pass" a syntax check while
// the actual bug (e.g. wrong node removed) goes undetected. Boot a real jsdom
// document first so those bugs actually surface.
const JSDOM_BOOTSTRAP = `
const { JSDOM } = require(${JSON.stringify(require.resolve('jsdom'))});
const __dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
global.window = __dom.window;
global.document = __dom.window.document;
global.navigator = __dom.window.navigator;
global.Node = __dom.window.Node;
global.Element = __dom.window.Element;
global.HTMLElement = __dom.window.HTMLElement;
global.Event = __dom.window.Event;
global.MouseEvent = __dom.window.MouseEvent;
`;

// A packaged app can't assume the end user has a system `node` on PATH —
// most non-developers won't. Electron's own binary IS a full Node runtime
// when launched with ELECTRON_RUN_AS_NODE, so use that instead of trusting
// the environment to have Node installed separately.
const jsRunner = {
  cmds: [{ cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }],
  args: ['-e'],
  wrap: (code) => JSDOM_BOOTSTRAP + code
};
// Python has no bundled equivalent — fall back across the command names
// different installers actually leave on PATH (Windows commonly has none of
// these as "python3"; it's "python" or the "py" launcher instead).
const pyRunner = {
  cmds: [{ cmd: 'python3' }, { cmd: 'python' }, { cmd: 'py' }],
  args: ['-c'],
  wrap: (code) => code
};

const RUNNERS = { javascript: jsRunner, js: jsRunner, python: pyRunner, py: pyRunner };

function extractCode(markdown) {
  const m = /```(\w+)?\n([\s\S]*?)```/.exec(markdown || '');
  if (!m) return null;
  return { lang: (m[1] || '').toLowerCase(), code: m[2] };
}

function stripFences(text) {
  const extracted = extractCode(text);
  return extracted ? extracted.code : (text || '').trim();
}

function runOnce(candidate, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(candidate.cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(candidate.env || {}) }
    });
    let stderr = '';
    let done = false;
    const finish = (result) => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, unavailable: false, error: `timed out after ${timeoutMs}ms (possible infinite loop)` }); }, timeoutMs);
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', () => finish({ ok: false, unavailable: true, error: null }));
    child.on('close', (code_) => finish({ ok: code_ === 0, unavailable: false, error: code_ === 0 ? null : (stderr.trim() || `exited with code ${code_}`) }));
  });
}

async function runSandboxed(lang, code, timeoutMs = 5000) {
  const runner = RUNNERS[lang];
  if (!runner) return { supported: false };
  const args = [...runner.args, runner.wrap(code)];
  for (const candidate of runner.cmds) {
    const result = await runOnce(candidate, args, timeoutMs);
    if (!result.unavailable) return { supported: true, ok: result.ok, unavailable: false, error: result.error };
  }
  return { supported: true, ok: false, unavailable: true, error: 'no runner found on PATH (' + runner.cmds.map((c) => c.cmd).join(', ') + ')' };
}

module.exports = { extractCode, stripFences, runSandboxed };
