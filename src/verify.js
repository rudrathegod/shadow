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

const RUNNERS = {
  javascript: { cmd: 'node', args: ['-e'], wrap: (code) => JSDOM_BOOTSTRAP + code },
  js: { cmd: 'node', args: ['-e'], wrap: (code) => JSDOM_BOOTSTRAP + code },
  python: { cmd: 'python3', args: ['-c'], wrap: (code) => code },
  py: { cmd: 'python3', args: ['-c'], wrap: (code) => code }
};

function extractCode(markdown) {
  const m = /```(\w+)?\n([\s\S]*?)```/.exec(markdown || '');
  if (!m) return null;
  return { lang: (m[1] || '').toLowerCase(), code: m[2] };
}

function stripFences(text) {
  const extracted = extractCode(text);
  return extracted ? extracted.code : (text || '').trim();
}

function runSandboxed(lang, code, timeoutMs = 5000) {
  const runner = RUNNERS[lang];
  if (!runner) return Promise.resolve({ supported: false });
  return new Promise((resolve) => {
    const child = spawn(runner.cmd, [...runner.args, runner.wrap(code)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let done = false;
    const finish = (result) => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ supported: true, ok: false, unavailable: false, error: `timed out after ${timeoutMs}ms (possible infinite loop)` }); }, timeoutMs);
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish({ supported: true, ok: false, unavailable: true, error: 'runner not available: ' + e.message }));
    child.on('close', (code_) => finish({ supported: true, ok: code_ === 0, unavailable: false, error: code_ === 0 ? null : (stderr.trim() || `exited with code ${code_}`) }));
  });
}

module.exports = { extractCode, stripFences, runSandboxed };
