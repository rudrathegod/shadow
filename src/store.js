// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Resolved lazily so this module can be required (and its pure helpers tested)
// outside a running Electron app.
const file = () => path.join(app.getPath('userData'), 'shadow-data.json');

// Electron accelerator strings. An empty value means intentionally unbound.
const DEFAULT_SHORTCUTS = {
  panic: 'CommandOrControl+\\',
  assist: 'CommandOrControl+Return',
  solve: 'CommandOrControl+G',
  addShot: 'CommandOrControl+.',
  scrollDown: 'CommandOrControl+Down',
  scrollUp: 'CommandOrControl+Up',
  focusInput: 'CommandOrControl+K',
  quit: 'CommandOrControl+Shift+X'
};

// The screenshot shortcuts (solve, addShot) move to a random new key after
// every use, so a combination someone watched you press doesn't stay valid.
// In-memory only (see main.js) — nothing here is written to disk, so an
// explicit rebind in Settings still wins and a restart is back to the default.
// K is left out: it's focusInput's fixed binding, on the same modifier.
// globalShortcut steals the key system-wide, ahead of whatever app has
// focus — not just inside shadow. Bare CommandOrControl+<letter> is where
// every OS/app convention lives (Q quit, W close, S save, C/V copy-paste,
// Z undo, R reload, ...), so the pool only offers the Alt-modified form,
// which nothing system-level claims.
const ROTATE_LETTERS = 'ABCDEFGIJLMNOPQRSTUVWXYZ'.split('');
const ROTATE_POOL = ROTATE_LETTERS.map((c) => `CommandOrControl+Alt+${c}`);
// Picks uniformly from the pool, excluding every accelerator in `exclude`
// (the shortcuts currently bound, so the new key can't collide with itself
// or another action). Returns undefined if that empties the pool.
function randomAccel(exclude = []) {
  const excl = new Set(exclude.filter(Boolean));
  const candidates = ROTATE_POOL.filter((a) => !excl.has(a));
  if (!candidates.length) return undefined;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

const DEFAULTS = {
  provider: 'anthropic',      // screen solving + chat
  sttProvider: 'auto',        // 'auto' | 'openai' | 'gemini' — Anthropic has no speech API
  smart: true,
  recapOnStop: false,
  windowPosition: 'top-center',
  shortcuts: { ...DEFAULT_SHORTCUTS },
  apiKeys: { openai: '', anthropic: '', gemini: '' },
  models: {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    anthropic: { fast: 'claude-sonnet-5', smart: 'claude-sonnet-5' },
    gemini: { fast: 'gemini-flash-latest', smart: 'gemini-pro-latest' }
  }
};

// Model ids the provider has retired. A saved value beats DEFAULTS in the merge
// below, so anyone who opened Settings before the defaults moved on keeps 404ing
// forever — on the chat path and the transcription path both. Drop them on load
// so a defaults bump actually reaches existing installs.
const RETIRED_MODELS = new Set([
  'gemini-1.5-flash', 'gemini-1.5-pro',
  'gemini-2.5-flash', 'gemini-2.5-pro'
]);

// The whole Claude 3.x family (claude-3-*, which covers 3-5 and 3-7) is
// superseded. A prefix test rather than an exact-id list, so dated variants
// like claude-3-5-haiku-20241022 are caught without maintaining every suffix.
const isRetiredModel = (id) => RETIRED_MODELS.has(id) || /^claude-3[-.]/.test(id || '');

function dropRetiredModels(d) {
  for (const [provider, tiers] of Object.entries(d.models || {})) {
    for (const tier of Object.keys(tiers || {})) {
      if (isRetiredModel(tiers[tier])) tiers[tier] = (DEFAULTS.models[provider] || {})[tier] || '';
    }
  }
  return d;
}

// Shortcut ids whose default moved. A saved value still matching the OLD
// default is a stale copy, not a deliberate rebind — rewrite it so the new
// default reaches existing installs. Anything else is a real rebind and is
// left alone, same policy as isRetiredModel.
const RETIRED_SHORTCUT_DEFAULTS = {
  solve: 'CommandOrControl+H',
  addShot: 'CommandOrControl+Shift+H'
};
function dropRetiredShortcuts(d) {
  const saved = d.shortcuts;
  if (!saved) return d;
  for (const [id, oldDefault] of Object.entries(RETIRED_SHORTCUT_DEFAULTS)) {
    if (saved[id] === oldDefault) saved[id] = DEFAULT_SHORTCUTS[id];
  }
  return d;
}

let data = null;

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (k === '__proto__' || k === 'constructor') continue; // JSON.parse makes these own keys
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

function load() {
  if (data) return data;
  try { data = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(file(), 'utf8'))); }
  catch { data = deepMerge(DEFAULTS, {}); }
  dropRetiredModels(data);
  dropRetiredShortcuts(data);
  return data;
}
function save() { try { fs.writeFileSync(file(), JSON.stringify(data, null, 2)); } catch (e) { /* ignore */ } }

module.exports = {
  getSettings() { return load(); },
  setSettings(patch) { load(); data = deepMerge(data, patch || {}); save(); return data; },
  defaultShortcuts() { return { ...DEFAULT_SHORTCUTS }; },
  randomAccel,
  ROTATE_POOL,
  // exported for test.js
  _deepMerge: deepMerge,
  _dropRetiredModels: dropRetiredModels,
  _dropRetiredShortcuts: dropRetiredShortcuts,
  _DEFAULTS: DEFAULTS,
  _DEFAULT_SHORTCUTS: DEFAULT_SHORTCUTS
};
