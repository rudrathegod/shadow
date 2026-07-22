// Full-resolution screenshot via desktopCapturer (main process).
// First call triggers the macOS Screen-Recording permission prompt for the app.
const { desktopCapturer, screen } = require('electron');

async function captureScreenshot() {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;
  // Cap the requested thumbnail size — asking for full native resolution on a
  // 2x/5K display (e.g. 6016x3384) makes Electron silently hand back an empty
  // thumbnail with no error. Vision models don't need native res anyway.
  const MAX_DIM = 1920;
  const scale = Math.min(1, MAX_DIM / Math.max(width, height));
  const thumbnailSize = { width: Math.round(width * scale), height: Math.round(height * scale) };

  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  if (!sources.length) throw new Error('no screen sources found');
  // Prefer the primary display source.
  const src = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];
  const img = src.thumbnail;
  if (!img || img.isEmpty()) throw new Error('screenshot came back empty — try again');
  return img.toDataURL(); // data:image/png;base64,...
}

module.exports = { captureScreenshot };
