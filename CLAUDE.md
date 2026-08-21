# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                      # run the overlay (Electron)
SHADOW_NO_PROTECT=1 npm start  # run with content protection off, so it shows in screenshots while debugging
npm test                       # node test.js — plain assert self-check, no framework
npm run pack                   # dist/mac-*/shadow.app, unpackaged
npm run dist / dist:win        # release zips (what CI runs)
```

`npm test` is one file of top-level asserts; there is no single-test runner — comment out or run the block you care about. It only covers modules that work without a live Electron `app` object (`verify`, `wav`, `store` pure helpers, `stt` provider selection, plus jsdom-parsed checks of `renderer/`).

## Architecture

Electron, three processes' worth of responsibility in four places:

- **`main.js`** (~700 lines) — all privileged work: window creation, global shortcuts, screenshot capture, STT flush loop, the LLM feature runner, IPC handlers, GitHub-releases update check.
- **`preload.js`** — the *entire* API surface between renderer and main, `contextBridge`-exposed as `window.shadow`. Adding a feature that crosses the boundary means adding both an `invoke`/`send` wrapper here **and** an entry in the `allowed` channel allowlist inside `on()`. A push channel missing from that list silently never fires.
- **`renderer/`** — the glass panel UI (vanilla JS, no framework, no bundler). Owns the two audio taps: `getUserMedia` for mic and `getDisplayMedia` loopback for meeting audio, both downsampled to 16k PCM and pushed to main via `micPcm`/`systemPcm`. Audio capture must live here because those APIs need a renderer and a fresh user gesture.
- **`src/`** — pure-ish modules: `llm.js` (OpenAI/Anthropic/Gemini behind one `stream()` with 429 backoff), `prompts.js` (`MODES` — each feature is a `{needsScreen, system, build()}` entry; add a feature by adding a mode, not by branching in main), `store.js` (JSON settings file + retired-model migration), `stt.js`, `screen.js`, `verify.js`, `wav.js`.

Key flows worth knowing before editing:

- **`runFeature(mode, text, presetImages)`** in main.js is the single funnel for every answer. It guards on one global `state.busy`, streams tokens to the renderer, and enforces a 45s *idle* timeout that resets per token. A cancelled request keeps streaming (no abort on the provider stream), so it's tracked by identity via `activeRequest` — don't clear `busy` from a request that's been superseded.
- **`verifyAndRepair`** (leetcode mode only) spends two extra LLM calls: one to write a test harness, one to fix the code if it fails. `src/verify.js` runs it in a subprocess — Electron's own binary with `ELECTRON_RUN_AS_NODE=1` plus a jsdom bootstrap for JS, `python3|python|py` for Python. It's a timeout, not a jail.
- **STT** batches PCM per channel every `FLUSH_MS`, gated on min-bytes and RMS. A 429 puts it in a 60s cooldown and drops buffered audio rather than queueing a catch-up burst; repeated hard failures set `sttDisabled` permanently for the session. Transcription picks its provider *independently* of chat (`sttProvider`), because Anthropic has no speech API.
- **Invisibility** is `setContentProtection` + `alwaysOnTop('screen-saver')` + `type: 'panel'` on macOS + `setHiddenInMissionControl`. Best-effort, and the README says so — don't strengthen the claim in user-facing copy.
- **Settings** merge saved JSON over `DEFAULTS`, so bumping a default model never reaches an existing install by itself; retired ids must be added to `RETIRED_MODELS` / `isRetiredModel` in `src/store.js` to be rewritten on load.

## Conventions

- No build step, no TypeScript, no framework, no bundler. Keep it that way; new runtime dependencies need a real justification.
- Comments in this codebase explain *why a subtle thing is the way it is* (a race, a provider quirk, a macOS behavior). Preserve them when editing nearby code — several encode bugs that already shipped once.
- `ponytail:` comments mark deliberate shortcuts with their ceiling and upgrade path.

## Committing

Never add a `Co-Authored-By: Claude` trailer.

Every push to main bumps the version and pushes a matching `vX.X.X` tag — `.github/workflows/build.yml` only triggers on tags, and a run triggered by a plain push displays as "main" instead of the version. Normal change: bump the patch (`0.2.165` → `0.2.166`). Tiny change: append a digit (`0.2.165` → `0.2.1651`). The version bump goes in the **same commit** as the code change, never a separate "bump version" commit; bump `package.json` and `package-lock.json` (both occurrences near the top), commit once, then tag and push.

# Our Working Relationship

- You are not my assistant
- I don't like sycophancy
- Be neither rude nor polite. Be matter-of-fact, straightforward, and clear
- Be concise. Avoid long-winded explanations
- I am sometimes wrong. Challenge my assumptions
- Don't be lazy. Do things the right way, not the easy way