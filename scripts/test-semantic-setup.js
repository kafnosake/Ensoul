const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-semantic-setup-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function installer(t, { installedCuda = null, deviceAvailable = true } = {}) {
  const directory = fixture(t);
  const calls = [];
  const python = path.join(directory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, 'fixture');
  fs.writeFileSync(path.join(directory, 'pyvenv.cfg'), 'fixture');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../plugins/semantic-search/runtime.js'), 'utf8'), {
    module, exports: module.exports, process, __dirname: path.resolve(__dirname, '../plugins/semantic-search'), Buffer, URL, setTimeout, clearTimeout,
    require(name) {
      if (name === 'child_process') return { spawn(command, args, options) {
        calls.push({ command, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
        child.kill = () => { child.exitCode = 1; child.emit('close', 1); };
        queueMicrotask(() => {
          let code = 0;
          if (args.includes('-c') && args[1].includes('json.dumps')) child.stdout.emit('data', JSON.stringify({ cuda: installedCuda, available: deviceAvailable }));
          if (args.includes('-c') && args[1].includes('assert torch.cuda') && !deviceAvailable) {
            child.stderr.emit('data', 'CUDA 不可用'); code = 1;
          }
          child.exitCode = code; child.emit('close', code);
        });
        return child;
      } };
      if (name === './bootstrap') return require('../plugins/semantic-search/bootstrap');
      return require(name);
    },
  });
  return { directory, calls, prepare: module.exports.prepareEnvironment };
}

test('一键配置为已有 CPU PyTorch 补齐 CUDA 依赖并验证 GPU 运算', async t => {
  const h = installer(t);
  await h.prepare('python', h.directory, { device: 'cuda', proxy: 'direct' });
  const torch = h.calls.find(call => call.args.includes('torch>=2.5,<3'));
  assert.ok(torch.args.includes('https://download.pytorch.org/whl/cu128'));
  assert.ok(torch.args.includes('--force-reinstall'));
  assert.ok(torch.args.includes('--no-deps'));
  assert.ok(torch.args.includes('--only-binary=:all:'));
  const upgrade = h.calls.findIndex(call => call.args.includes('pip') && call.args.includes('--upgrade') && call.args.includes('wheel'));
  const torchPosition = h.calls.indexOf(torch);
  assert.ok(upgrade >= 0 && upgrade < torchPosition, '先更新安装工具，再安装 PyTorch');
  assert.ok(h.calls.filter(call => call.args.includes('wheel') || call.args.includes('-r')).every(call => !call.args.some(arg => arg.includes('download.pytorch.org'))), '普通依赖不使用 CUDA 专用源');
  assert.ok(h.calls.some(call => call.args.includes('-r')));
  const verification = h.calls.at(-1).args.join(' ');
  assert.match(verification, /embedding_gemma2/);
  assert.match(verification, /torch\.cuda\.is_available/);
  assert.match(verification, /device="cuda"/);
});

test('CPU 模式复用现有依赖，不安装 CUDA，也验证文档与媒体依赖', async t => {
  const h = installer(t);
  await h.prepare('python', h.directory, { device: 'cpu' });
  assert.equal(h.calls.some(call => call.args.some(arg => arg.includes('/cu128'))), false);
  assert.match(h.calls.at(-1).args.join(' '), /PIL,av,soundfile,librosa,pypdf,openpyxl/);
  assert.match(h.calls.at(-1).args.join(' '), /device="cpu"/);
});

test('CUDA 依赖可导入但驱动不可用时不返回安装成功', async t => {
  const h = installer(t, { installedCuda: '12.8', deviceAvailable: false });
  await assert.rejects(h.prepare('python', h.directory, { device: 'cuda' }), /CUDA 不可用/);
});

test('没有 Python 时自动准备私有 Python，不要求用户先手工安装', async t => {
  const directory = fixture(t), calls = [], requests = [];
  const module = { exports: {} };
  const fakeSession = { fetch: async url => {
    requests.push(url);
    return { ok: true, json: async () => ({ assets: [{ name: `uv-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'win32' ? 'pc-windows-msvc.zip' : process.platform === 'darwin' ? 'apple-darwin.tar.gz' : 'unknown-linux-gnu.tar.gz'}`, browser_download_url: 'https://fixture.invalid/archive' }] }), arrayBuffer: async () => Buffer.from('fixture archive') };
  } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../plugins/semantic-search/bootstrap.js'), 'utf8'), {
    module, exports: module.exports, process, Buffer,
    require: name => name === 'electron' ? { session: { defaultSession: fakeSession } } : require(name),
  });
  const executable = await module.exports.ensureEnvironment('python', directory, {
    proxy: 'system', runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      if (['python', 'python3'].includes(command)) throw new Error('ENOENT');
      return '';
    },
  });
  assert.match(executable, /python/);
  assert.equal(requests.length, 2);
  assert.ok(calls.some(call => call.command === 'tar'));
  const venv = calls.find(call => call.args[0] === 'venv');
  assert.ok(venv.args.includes('--seed'));
  assert.equal(venv.args.at(-1), directory);
  assert.ok(venv.options.env.UV_PYTHON_INSTALL_DIR.startsWith(directory));
});
