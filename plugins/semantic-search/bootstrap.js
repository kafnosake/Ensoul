const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

async function ensureEnvironment(python, root, { signal, proxy, onStatus, runCommand }) {
  const executable = path.join(root, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (fs.existsSync(executable) && fs.existsSync(path.join(root, 'pyvenv.cfg'))) return executable;
  const candidates = python && !['python', 'python3'].includes(python) ? [python] : ['python', 'python3'];
  for (const candidate of candidates) {
    try {
      await runCommand(candidate, ['-c', 'import sys; assert (3, 10) <= sys.version_info[:2] < (3, 14)'], { signal });
      await runCommand(candidate, ['-m', 'venv', root], { signal, onStatus });
      return executable;
    } catch (error) {
      if (signal?.aborted || candidates.length === 1) throw error;
    }
  }

  onStatus?.({ status: 'installing', message: '未找到可用 Python，正在下载专用 Python 环境' });
  const targets = {
    'win32-x64': 'x86_64-pc-windows-msvc.zip', 'win32-arm64': 'aarch64-pc-windows-msvc.zip',
    'darwin-x64': 'x86_64-apple-darwin.tar.gz', 'darwin-arm64': 'aarch64-apple-darwin.tar.gz',
    'linux-x64': 'x86_64-unknown-linux-gnu.tar.gz', 'linux-arm64': 'aarch64-unknown-linux-gnu.tar.gz',
  };
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw new Error('当前平台暂不支持自动下载 Python');
  const tools = path.join(root, 'bootstrap');
  fs.mkdirSync(tools, { recursive: true });
  const uv = path.join(tools, process.platform === 'win32' ? 'uv.exe' : `uv-${target.replace('.tar.gz', '')}/uv`);
  if (!fs.existsSync(uv)) {
    const { session } = require('electron');
    const downloadSession = proxy === 'system' ? session.defaultSession : session.fromPartition('semantic-search-download');
    if (proxy !== 'system') await downloadSession.setProxy(proxy === 'direct' ? { mode: 'direct' } : { proxyRules: proxy });
    const request = async url => {
      const response = await downloadSession.fetch(url, { signal, headers: { 'User-Agent': 'ensoul-semantic-search' } });
      if (!response.ok) throw new Error(`Python 环境下载失败：HTTP ${response.status}`);
      return response;
    };
    const release = await (await request('https://api.github.com/repos/astral-sh/uv/releases/latest')).json();
    const asset = release.assets.find(asset => asset.name === `uv-${target}`);
    if (!asset) throw new Error('未找到当前平台的 Python 环境安装器');
    const bytes = Buffer.from(await (await request(asset.browser_download_url)).arrayBuffer());
    if (asset.digest?.startsWith('sha256:') && createHash('sha256').update(bytes).digest('hex') !== asset.digest.slice(7)) throw new Error('Python 环境安装器校验失败');
    const archive = path.join(tools, `uv.${target.endsWith('.zip') ? 'zip' : 'tar.gz'}`);
    fs.writeFileSync(archive, bytes);
    await runCommand('tar', ['-xf', archive, '-C', tools], { signal });
  }
  await runCommand(uv, ['venv', '--seed', '--python', '3.12', '--allow-existing', root], {
    signal, onStatus,
    env: { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(tools, 'python'), UV_CACHE_DIR: path.join(tools, 'cache'),
      ...(proxy === 'direct' ? { HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '' } : proxy !== 'system' ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy } : {}) },
  });
  return executable;
}

module.exports = { ensureEnvironment };
