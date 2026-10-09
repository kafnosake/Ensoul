const os = require('os');
const path = require('path');

function userDataDirectory() {
  try {
    const electron = require('electron');
    const directory = electron?.app?.getPath('userData');
    if (directory) return directory;
  } catch {}
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'ensoul');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'ensoul');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'ensoul');
}

module.exports = { userDataDirectory };
