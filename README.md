<div align="center">

# shadow

**An open-source AI copilot that floats over your screen — sees what you see, hears your meetings, and stays hidden from screen shares.**

A free, self-hosted alternative to Cluely. Bring your own AI key (OpenAI · Anthropic · Google Gemini).



</div>

---

> [!IMPORTANT]
> **Please read this first.** shadow tries to stay out of screen recordings/shares, but this is **best-effort, not guaranteed** — on macOS 15.4+ Apple can let modern capture tools see it anyway, and a phone camera always can. Using a hidden assistant during a **proctored exam, job interview, or recorded meeting** may break that platform's rules and, in some places, consent laws. shadow is built for legitimate uses — your own notes, studying, accessibility, and practice. **You are responsible for how you use it.**

---

## What it does

shadow floats a small glass panel on top of everything. It takes **three separate inputs** — your **screen**, your **microphone**, and your **meeting audio** (what the other person says) — and uses an AI model to help you in real time.

| Feature | How to trigger | What it uses |
|---|---|---|
| **Assist** | `⌘` `↵` or the *Assist* button | your screen + recent conversation |
| **What should I say?** | button | meeting audio + your mic |
| **Follow-up questions** | button | the whole conversation |
| **Recap** | button | the whole conversation |
| **Ask anything** | type + `↵` | your screen + conversation |
| **Solve a coding problem** | `⌘` `H` | your screen only |
| **Smart** toggle | pill in the box | switches to a smarter (slower) model |

It's a copilot for **live meetings** ("what do I say to that?") and **coding problems** (screenshot → full solution), and it's designed to be **invisible in screen shares** so it stays your private assistant.

---

## Install

There are two ways to install shadow. **If you're not a developer, use Option A.**

### Option A — Download the app (easiest)

**macOS:**
1. Go to the [**Releases**](../../releases) page and download **`shadow-mac.zip`**.
2. Double-click the zip to unzip it. You'll get **`shadow.app`**.
3. Drag **`shadow.app`** into your **Applications** folder.
4. **First open (important):** because shadow is a free app without a paid Apple certificate, macOS will refuse to open it normally the first time. Do this once:
   - **Right-click** `shadow.app` → **Open** → click **Open** in the dialog.
   - If macOS instead says **"shadow is damaged and can't be opened,"** open the **Terminal** app and paste this line, then press Return:
     ```bash
     xattr -cr /Applications/shadow.app
     ```
     Then double-click shadow.app again. (This just tells macOS "yes, I trust this app I downloaded." It's safe.)

After that, shadow opens normally forever.

**Windows:**
1. Go to the [**Releases**](../../releases) page and download **`shadow-win.zip`**.
2. Right-click the zip → **Extract All...** to unzip it. You'll get a `shadow-win-unpacked` folder with `shadow.exe` inside.
3. Move that folder wherever you want to keep the app (e.g. `C:\Program Files\shadow`), then run **`shadow.exe`**.
4. **First open:** Windows Defender SmartScreen will likely say *"Windows protected your PC"* because the app isn't code-signed. Click **More info** → **Run anyway**. (This just means no paid certificate was used — the app itself is open source, see the code yourself.)

After that, shadow opens normally forever. No installer, no admin rights needed — it's a portable app.

### Option B — Run from source (developers)

You need [Node.js](https://nodejs.org) 18+ installed. No Xcode required.

```bash
git clone https://github.com/rudrathegod/shadow.git
cd shadow
npm install
npm start
```

To build your own app:
```bash
npm run pack          # creates dist/mac-arm64/shadow.app (on macOS)
npm run dist:win      # creates dist/shadow-win.zip (on Windows, or via CI)
```
> Note: the packaged mac app is **ad-hoc signed** (no paid Apple certificate). macOS ties permission grants to the exact build, so **rebuilding resets the mic/screen permissions** — you'll grant them again. For everyday use, build once and keep it. The Windows build is unsigned too, so each rebuild re-triggers the SmartScreen warning.

---

## First launch — the 1-minute setup

When shadow opens the first time, a **built-in tutorial** walks you through everything below. You can reopen it anytime by clicking the **shadow logo** (top-left of the pill). Here's the same thing in writing.

### Step 1 — Grant permissions

**macOS:** shadow can't help until macOS lets it see and hear. When you first use a feature, macOS will prompt you — click **Allow**. If a prompt doesn't appear, add shadow manually:

- **Microphone:** System Settings → **Privacy & Security** → **Microphone** → turn on **shadow**.
- **Screen Recording:** System Settings → **Privacy & Security** → **Screen Recording** → turn on **shadow**. (This one grant covers both screenshots *and* meeting audio.) macOS may ask you to **quit & reopen** shadow — let it.

**Windows:** when you first use a feature, Windows will prompt for **Microphone** access and, separately, a **"Share your screen or window"** picker will appear for screen/meeting-audio capture — choose the screen or window to share and click **Allow/Share**. There's no manual settings toggle to hunt down.

### Step 2 — Add your AI key (bring your own)

shadow uses **your own** API key, so it's free to run (you only pay your AI provider for what you use). Click the **`...`** button in the input box (or press `⌘` `,`) to open **Settings**, pick a provider, and paste your key:

| Provider | Get a key | Notes |
|---|---|---|
| **OpenAI** | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | One key does everything — **but** for the *listening* features the key must have **Whisper / audio** access (a "restricted" project key that only allows chat will give a 403 on transcription). |
| **Anthropic (Claude)** | [console.anthropic.com](https://console.anthropic.com) | Great for screen & coding help. Claude has no speech-to-text, so add an OpenAI or Gemini key too if you want the listening features. |
| **Google Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | One key does chat + transcription. |

Your key is stored **only on your computer** (in `shadow-data.json`) and is sent **only** to that provider. shadow has no server and collects nothing.

### Step 3 — The Zoom setting (only needed for Zoom)

shadow is hidden from most screen-share tools automatically — **Google Meet, Microsoft Teams, and QuickTime need nothing.** **Zoom** has a specific setting that decides whether it respects shadow's "don't capture me" flag:

> **Zoom → Settings → Share Screen → Advanced → Screen capture mode → choose "Advanced capture with window filtering."**

<div align="center"><img src="docs/zoom-setting.png" width="560" alt="Zoom screen capture mode setting" /></div>

**Why:** the *"...with window filtering"* modes tell Zoom to leave out windows that mark themselves as private — which is exactly what shadow does. The **"Advanced capture without window filtering"** mode grabs the raw screen and **will show shadow**, so avoid it.

---

## How to use it

- **`⌘` `↵` — Assist.** The do-the-smart-thing key. On a coding problem it solves it; in a conversation it tells you what to say. Works from anywhere.
- **`⌘` `H` — Solve what's on screen.** Screenshots a coding problem and returns the code, approach, and time/space complexity.
- **`⌘` `⇧` `H` — Add another screenshot.** Scroll to reveal more of a long problem, press this to add it to the batch, then press `⌘` `H` to solve using all of them together.
- **`⌘` `↓` — Scroll the overlay down.** Moves through longer answers without clicking it.
- **`⌘` `↑` — Scroll the overlay up.** Moves back through longer answers without clicking it.
- **The `▢` button** (top bar) — start/stop **listening** to a meeting. The green dot means it's live.
- **Type a question** in the box and press `↵` to ask about your screen or conversation.
- **Smart** — flip it on for a smarter, more thorough model; off for fast and cheap.
- **Hide** collapses the panel to just the top bar. Drag shadow around by the **top pill**. Quit with `⌘` `⇧` `X`.

The panel is see-through and click-through — the empty space around it never blocks the app behind it.

### On Windows

Same shortcuts, with `Ctrl` instead of `⌘`:

- **`Ctrl` `↵` — Assist.**
- **`Ctrl` `H` — Solve the coding problem on screen.**
- **`Ctrl` `↓` / `Ctrl` `↑` — Scroll the overlay down / up.**
- **Quit** with `Ctrl` `Shift` `X`.

Permissions are simpler too: Windows prompts for **Microphone** and screen-share access the first time you use a feature — click **Allow** and you're done. No manual settings to hunt down.

---

## How it works (under the hood)

shadow is an [Electron](https://www.electronjs.org/) app. Everything runs locally except the calls to your chosen AI provider.

**The three inputs are kept completely separate:**
- **Screen** — captured with Electron's `desktopCapturer` (full-resolution screenshots, taken only when a feature needs one).
- **Your mic ("You")** — `getUserMedia` → downsampled to 16 kHz audio → transcribed.
- **Meeting audio ("Them")** — `getDisplayMedia` loopback capture of your system's output audio, kept on its own channel so shadow knows *who* said what.

Both audio streams are transcribed (OpenAI Whisper or Gemini) and fed, with an optional screenshot, to your AI model. Responses **stream** into the panel word-by-word.

**The invisibility** is a single Electron window flag: `setContentProtection(true)`. On macOS this sets `NSWindowSharingNone`, asking the window server to exclude shadow from screen-capture streams — the same mechanism DRM apps and Zoom's own toolbar use. On Windows it maps to `WDA_EXCLUDEFROMCAPTURE`, which does the equivalent for Desktop Duplication / Windows Graphics Capture (used by most screen-share and recording tools since Windows 10 2004). Neither is a GPU trick or a special overlay layer — and on both platforms, some capture tools can still see the window anyway (macOS 15.4+ for Apple's own tools; older Windows builds or apps using legacy GDI capture on Windows), which is why it's best-effort (see the disclaimer at the top).

```
main process ──┬─ overlay window (frameless, transparent, always-on-top, content-protected)
               ├─ screenshot capture (desktopCapturer)
               ├─ speech-to-text (Whisper / Gemini)      ── "You" + "Them" channels
               └─ LLM streaming (OpenAI / Anthropic / Gemini)
renderer ──────┴─ the glass UI + mic capture + system-audio loopback
```

---

## Troubleshooting

**"It says give access, but I already gave access."**
You probably granted an older build. Because the app is ad-hoc signed, a rebuild changes its identity and macOS stops honoring the old grant (the checkmark can linger). Toggle shadow **off and on** in System Settings → Screen Recording, or remove and re-add it.

**A feature returns "403" / "no access to model."**
Your API key is restricted. Most often it's an OpenAI **project key that only allows chat models** — it works for screen/coding help but 403s on transcription (Whisper). Fix: enable audio/Whisper on the key, use an unrestricted key, or add a Gemini key (shadow falls back to it for transcription).

**Listening does nothing / no transcript.**
Check Settings shows a transcription-capable key (OpenAI with Whisper, or Gemini). Also make sure Screen Recording is granted (meeting audio needs it).

**shadow shows up in my Zoom share.**
Set Zoom's **Screen capture mode** to *"Advanced capture with window filtering"* (see Step 3). And remember: on macOS 15.4+ this can still fail — it's best-effort.

**"shadow is damaged and can't be opened."**
Run `xattr -cr /Applications/shadow.app` in Terminal once (see Install → Option A).

**Windows: "Windows protected your PC."**
Click **More info** → **Run anyway**. This is SmartScreen flagging the app because it isn't code-signed (no paid certificate) — it happens once per build (see Install → Option A, Windows).

**Windows: no screen-share picker appears / feature does nothing.**
Some versions of Windows require enabling "Screen Recording" access for the app under **Settings → Privacy & security → Screen capture / App permissions**, similar to a browser permission prompt. Also confirm your antivirus isn't silently blocking the unsigned `.exe`.

---

## Privacy

- No accounts, no servers, no telemetry. shadow collects nothing.
- Your API keys live in a local file (`shadow-data.json`) and are sent only to the provider you chose.
- Screenshots and audio are sent to your AI provider only when a feature runs, and are not stored by shadow beyond the current session's transcript (kept in memory).

## Contributing

Issues and PRs welcome. shadow is intentionally small and readable — `main.js` (app + capture + AI), `renderer/` (the UI), `src/` (providers). No build step for the source (plain HTML/CSS/JS).

## Credits & license

Built as an open-source study of how tools like **Cluely** and **Interview Coder** work. Modeled on the open-source clones `pickle-com/glass` and `sohzm/cheating-daddy`.

**License: All Rights Reserved — see [LICENSE](LICENSE). No redistribution, modification, or rebranding without permission.**
