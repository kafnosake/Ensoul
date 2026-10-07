const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ensureEnvironment } = require('./bootstrap');

function aborted(message = '语义模型操作已取消') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else child.kill('SIGKILL');
}

function buildProxyEnvironment(proxy = 'system') {
  const environment = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_ETAG_TIMEOUT: '15', HF_HUB_DOWNLOAD_TIMEOUT: '30' };
  if (proxy !== 'system') {
    for (const key of Object.keys(environment)) if (/^(https?|all)_proxy$/i.test(key)) delete environment[key];
    if (proxy !== 'direct') {
      for (const key of Object.keys(environment)) if (/^no_proxy$/i.test(key)) delete environment[key];
      environment.HTTPS_PROXY = proxy;
      environment.HTTP_PROXY = proxy;
      environment.ALL_PROXY = proxy;
    }
  }
  return environment;
}

function runCommand(command, args, { signal, onStatus, logPath, env } = {}) {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: env || process.env,
    });
    let output = '';
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(output);
    };
    const cancel = () => { stopProcess(child); finish(aborted()); };
    const record = (data) => {
      const text = data.toString('utf8');
      output = (output + text).slice(-12000);
      if (logPath) fs.appendFileSync(logPath, text);
      onStatus?.({ status: 'installing', message: text.trim().split(/\r?\n/).at(-1).slice(-180) });
    };
    child.stdout.on('data', record);
    child.stderr.on('data', record);
    child.once('error', finish);
    child.once('close', (code) => finish(code === 0 ? null : new Error(`依赖安装失败 (${code}): ${output.trim().slice(-2500)}`)));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

async function prepareEnvironment(python, envDir, { signal, onStatus, proxy = 'system', device = 'auto' } = {}) {
  if (signal?.aborted) throw aborted();
  const root = path.resolve(envDir);
  const executable = path.join(root, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  fs.mkdirSync(root, { recursive: true });
  const logPath = path.join(root, 'install.log');
  onStatus?.({ status: 'installing', message: '正在准备专用 Python 环境' });
  await ensureEnvironment(python, root, { signal, proxy, onStatus, runCommand });
  const version = (await runCommand(executable, ['--version'], { signal })).trim();
  onStatus?.({ status: 'installing', message: '专用 Python 已就绪', python: executable, version });
  const environment = buildProxyEnvironment(proxy);
  const pipArgs = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input'];
  async function installGeneral(args) {
    try {
      await runCommand(executable, [...pipArgs, ...args, '--index-url', 'https://pypi.tuna.tsinghua.edu.cn/simple', '--default-timeout', '30'], { signal, onStatus, logPath, env: environment });
    } catch (error) {
      if (signal?.aborted) throw error;
      onStatus?.({ status: 'installing', message: '镜像源未完成安装，正在尝试官方源' });
      await runCommand(executable, [...pipArgs, ...args, '--index-url', 'https://pypi.org/simple'], { signal, onStatus, logPath, env: environment });
    }
  }
  onStatus?.({ status: 'installing', message: '正在更新依赖安装工具' });
  await installGeneral(['--upgrade', 'pip', 'setuptools<82', 'wheel']);
  let useCuda = device === 'cuda';
  if (device === 'auto' && process.platform !== 'darwin') {
    try { await runCommand('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { signal }); useCuda = true; }
    catch (error) { if (signal?.aborted) throw error; }
  }
  let installed = null;
  try { installed = JSON.parse(await runCommand(executable, ['-c', 'import json,torch; print(json.dumps({"cuda":torch.version.cuda,"available":torch.cuda.is_available()}))'], { signal })); }
  catch (error) { if (signal?.aborted) throw error; }
  if (!installed || (useCuda && !installed.cuda)) {
    onStatus?.({ status: 'installing', message: useCuda ? '正在安装 CUDA 运行依赖' : '正在安装 CPU 运行依赖' });
    await runCommand(executable, [...pipArgs, '--upgrade', '--no-deps', '--only-binary=:all:', ...(installed ? ['--force-reinstall'] : []), 'torch>=2.5,<3', 'torchvision>=0.20,<1', ...(process.platform === 'darwin' ? ['--index-url', 'https://pypi.org/simple'] : ['--index-url', `https://download.pytorch.org/whl/${useCuda ? 'cu128' : 'cpu'}`])], { signal, onStatus, logPath, env: environment });
  }

  const reqFile = path.join(__dirname, 'requirements.txt');
  onStatus?.({ status: 'installing', message: '正在安装并检查其余依赖', logPath });
  await installGeneral(['-r', reqFile]);
  await runCommand(executable, ['-m', 'pip', 'check'], { signal, logPath });

  // 3. 严格验证 torch 是否真能导入
  try {
    await runCommand(executable, ['-c', 'import torch,torchvision,sentence_transformers,transformers,PIL,av,soundfile,librosa,pypdf,openpyxl; from transformers.models.auto.configuration_auto import CONFIG_MAPPING; assert "embedding_gemma2" in CONFIG_MAPPING; ' + (useCuda ? 'assert torch.cuda.is_available(), "CUDA 不可用，请检查 NVIDIA 驱动或选择 CPU"; torch.ones(1,device="cuda").cpu()' : 'torch.ones(1,device="cpu")')], { signal, logPath });
  } catch (verifyErr) {
    throw new Error(`依赖安装未真正完成：无法正常导入 PyTorch，请检查网络或代理。\n${verifyErr.message}`);
  }

  onStatus?.({ status: 'installed', message: '语义模型依赖已安装完成并通过验证', python: executable, version, logPath });
  return executable;
}

class ModelRuntime {
  constructor({ python = 'python', model = 'google/embeddinggemma-2', cacheDir, dimensions = 768, vision = true, audio = true, device = 'cpu', proxy = 'system', onStatus, workerPath = path.join(__dirname, 'worker.py'), workerArguments } = {}) {
    if (![128, 256, 512, 768].includes(dimensions)) throw new Error('向量维度必须为 128、256、512 或 768');
    this.python = python;
    this.model = model;
    this.dimensions = dimensions;
    this.cacheDir = path.resolve(cacheDir || path.join(process.cwd(), '.ensoul/runtime/semantic-search/models'));
    this.config = { model, cacheDir: this.cacheDir, dimensions, vision: !!vision, audio: !!audio, device };
    this.onStatus = onStatus;
    this.workerPath = workerPath;
    this.workerArguments = workerArguments;
    this.proxy = proxy || 'system';
    if (!['system', 'direct'].includes(this.proxy)) {
      const url = new URL(this.proxy);
      if (!['http:', 'https:', 'socks:', 'socks5:', 'socks5h:'].includes(url.protocol)) throw new Error('下载代理需要 HTTP 或 SOCKS5 地址');
      if (url.protocol === 'socks:') this.proxy = this.proxy.replace(/^socks:/, 'socks5:');
    }
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.logPath = path.join(this.cacheDir, 'worker.log');
  }

  fingerprint() {
    return JSON.stringify({ model: this.model, dimensions: this.dimensions, instructions: 'embeddinggemma2-retrieval-v1' });
  }

  _redact(text) {
    return text.replace(/((?:https?|socks5?h?):\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
  }

  _environment() {
    const environment = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_ETAG_TIMEOUT: '15', HF_HUB_DOWNLOAD_TIMEOUT: '30' };
    if (this.proxy !== 'system') {
      for (const key of Object.keys(environment)) if (/^(https?|all)_proxy$/i.test(key)) delete environment[key];
      if (this.proxy !== 'direct') {
        for (const key of Object.keys(environment)) if (/^no_proxy$/i.test(key)) delete environment[key];
        environment.HTTPS_PROXY = this.proxy;
        environment.HTTP_PROXY = this.proxy;
        environment.ALL_PROXY = this.proxy;
      }
    }
    return environment;
  }

  _start() {
    if (this.closed) throw new Error('语义模型运行时已关闭');
    if (this.child) return this.child;
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const args = this.workerArguments || ['-u', this.workerPath];
    const child = spawn(this.python, args, {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      env: this._environment(),
    });
    this.child = child;
    let buffer = '';
    let stderr = '';
    let stderrBuffer = '';
    const recordStderr = (data) => {
      const safeText = this._redact(data);
      stderr = (stderr + safeText).slice(-2500);
      try { fs.appendFileSync(this.logPath, safeText); }
      catch (error) { this._terminate(new Error(`无法保存语义模型日志: ${error.message}`), child); }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      if (this.child !== child) return;
      buffer += data;
      let split;
      while ((split = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, split).trim();
        buffer = buffer.slice(split + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch {
          this._terminate(new Error(`语义模型通信数据无效: ${this._redact(line).slice(0, 180)}`), child);
          return;
        }
        if (message.status) {
          this.onStatus?.(message);
          continue;
        }
        const request = this.pending.get(message.id);
        if (!request) continue;
        this.pending.delete(message.id);
        request.detach();
        if (message.ok === true) request.resolve(message.result);
        else {
          const error = new Error(this._redact(message.error || '语义模型执行失败'));
          if (message.code) error.code = message.code;
          request.reject(error);
        }
      }
    });
    child.stderr.on('data', (data) => {
      if (this.child !== child) return;
      stderrBuffer += data;
      let split;
      while ((split = stderrBuffer.indexOf('\n')) !== -1) {
        recordStderr(stderrBuffer.slice(0, split + 1));
        stderrBuffer = stderrBuffer.slice(split + 1);
      }
    });
    child.stdin.on('error', (error) => this._terminate(error, child));
    child.once('error', (error) => this._terminate(error, child));
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      if (stderrBuffer) recordStderr(stderrBuffer);
      this._terminate(new Error(`语义模型进程已退出 (${signal || code})${stderr.trim() ? ': ' + stderr.trim() : ''}`), child);
    });
    return child;
  }

  _terminate(error, child = this.child) {
    if (!child || this.child !== child) return;
    this.child = null;
    for (const request of this.pending.values()) {
      request.detach();
      request.reject(error);
    }
    this.pending.clear();
    stopProcess(child);
  }

  _request(op, payload, signal) {
    if (signal?.aborted) return Promise.reject(aborted());
    let child;
    try { child = this._start(); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const cancel = () => this._terminate(aborted(), child);
      const detach = () => signal?.removeEventListener('abort', cancel);
      this.pending.set(id, { resolve, reject, detach });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      child.stdin.write(JSON.stringify({ id, op, config: this.config, ...payload }) + '\n', (error) => {
        if (error) this._terminate(error, child);
      });
    });
  }

  probe({ signal } = {}) {
    return this._request('probe', {}, signal);
  }

  prepare({ signal } = {}) {
    return this._request('prepare', {}, signal);
  }

  async encode(items, { query = false, code = false, signal } = {}) {
    if (!Array.isArray(items)) throw new Error('待编码内容必须是数组');
    if (signal?.aborted) throw aborted();
    if (this.closed) throw new Error('语义模型运行时已关闭');
    if (items.length === 0) return [];
    for (const item of items) {
      if (!item || typeof item !== 'object' || !['text', 'image', 'audio', 'video'].some((key) => item[key] != null)) throw new Error('每条内容至少需要文字、图片、音频或视频');
      if (item.text != null && typeof item.text !== 'string') throw new Error('文字内容必须为字符串');
      for (const key of ['image', 'audio', 'video']) {
        if (item[key] != null && !(typeof item[key] === 'string' || (Array.isArray(item[key]) && item[key].length && item[key].every((value) => typeof value === 'string')))) throw new Error(`${key} 必须是路径或路径数组`);
      }
      if (!this.config.vision && (item.image != null || item.video != null)) throw new Error('图片与视频编码器尚未启用');
      if (!this.config.audio && item.audio != null) throw new Error('音频编码器尚未启用');
    }
    const vectors = await this._request('encode', { items, query: !!query, code: !!code }, signal);
    if (!Array.isArray(vectors) || vectors.length !== items.length || vectors.some((vector) => !Array.isArray(vector) || vector.length !== this.dimensions || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value)) || !vector.some((value) => value !== 0))) throw new Error('模型返回的向量数量、维度或数值无效');
    return vectors;
  }

  close() {
    this.closed = true;
    this._terminate(aborted('语义模型运行时已关闭'));
  }
}

module.exports = { ModelRuntime, prepareEnvironment };
