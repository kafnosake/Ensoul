const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function runNpm(args, options = {}) {
  const bin = path.dirname(fs.realpathSync(process.execPath));
  const cli = [
    process.env.npm_execpath,
    path.join(bin, 'node_modules/npm/bin/npm-cli.js'),
    path.join(bin, '../lib/node_modules/npm/bin/npm-cli.js'),
  ].find((file) => file && file.endsWith('.js') && fs.existsSync(file));
  if (cli) return spawnSync(process.execPath, [cli, ...args], options);
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    ...options,
    shell: process.platform === 'win32',
  });
}

module.exports = { runNpm };
