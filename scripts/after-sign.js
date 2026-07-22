// electron-builder afterSign hook: re-signs the packaged app ad-hoc with the
// real bundle identifier (appId) instead of leaving it as the generic
// "Electron" identity, so macOS TCC (Screen Recording, etc.) grants persist
// across rebuilds instead of resetting every time.
const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appId = context.packager.appInfo.info._configuration.appId || 'com.shadow.overlay';
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  execFileSync('find', [appPath, '-name', '._*', '-delete']);
  execFileSync('xattr', ['-cr', appPath]);
  execFileSync('codesign', [
    '--force', '--deep', '--sign', '-',
    '--identifier', appId,
    appPath
  ]);
};
