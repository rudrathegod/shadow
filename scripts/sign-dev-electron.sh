#!/bin/sh
# Ad-hoc codesigns the local dev Electron binary with a stable identifier.
# Without this, every `npm install` drops a fresh Electron.app with a new
# signature, so macOS treats it as a "new app" and silently drops the
# Screen Recording grant made under `npm start`.
set -e

[ "$(uname)" = "Darwin" ] || exit 0

ELECTRON_APP="node_modules/electron/dist/Electron.app"
[ -d "$ELECTRON_APP" ] || exit 0

codesign --force --deep --sign - \
  --identifier "com.shadow.overlay.dev" \
  "$ELECTRON_APP" 2>/dev/null || true
