const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { ModelRuntime } = require('../plugins/semantic-search/runtime');

const fixture = `
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const reply = result => send({ id: request.id, ok: true, result });
  if (request.op === 'probe') return reply({ pid: process.pid, cached: false, dimensions: request.config.dimensions, proxy: process.env.HTTPS_PROXY || null, allProxy: process.env.ALL_PROXY || null });
  if (request.op === 'prepare') {
    send({ status: 'ready', message: 'fixture ready' });
    return reply({ loaded: true });
  }
  const text = request.items[0].text;
  if (text === 'error') return send({ id: request.id, ok: false, error: 'fixture failure', code: 'FIXTURE_ERROR' });
  if (text === 'proxy-error') {
    process.stderr.write('failure at https://user:');
    setTimeout(() => {
      process.stderr.write('secret@proxy.invalid:7897\\n');
      send({ id: request.id, ok: false, error: 'failure at https://user:secret@proxy.invalid:7897' });
    }, 10);
    return;
  }
  if (text === 'crash') return process.exit(9);
  if (text === 'bad-json') return process.stdout.write('unexpected log\\n');
  if (text === 'wrong-count') return reply([]);
  if (text === 'wrong-dimension') return reply([[1]]);
  if (text === 'nan') return reply([Array(request.config.dimensions).fill(NaN)]);
  if (text === 'zero') return reply([Array(request.config.dimensions).fill(0)]);
  send({ status: 'encoding', message: text || 'media', request });
  const vectors = request.items.map(item => Array.from({ length: request.config.dimensions }, (_, index) => index === 0 ? (item.text === 'fast' ? 2 : 1) : index === 1 ? (request.code ? 3 : request.query ? 2 : 1) : 0));
  setTimeout(() => reply(vectors), text === 'wait' ? 10000 : text === 'slow' ? 70 : 1);
});
`;

function runtimeFor(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-semantic-runtime-'));
  const workerPath = path.join(directory, 'worker.cjs');
  fs.writeFileSync(workerPath, fixture);
  const runtime = new ModelRuntime({
    python: process.execPath, dimensions: 128, cacheDir: path.join(directory, 'cache'), workerArguments: [workerPath], ...overrides,
  });
  t.after(() => {
    runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return runtime;
}

test('runtime lazily starts, reports preparation, preserves combined inputs and query contract', async t => {
  const events = [];
  const runtime = runtimeFor(t, { onStatus: status => events.push(status) });
  assert.equal(runtime.child, null);
  assert.equal((await runtime.probe()).cached, false);
  assert.equal((await runtime.prepare()).loaded, true);
  const items = [{ text: 'title: file | text: 内容 <|image|>', image: ['file.png'], audio: 'file.wav', video: 'file.mp4' }];
  const vectors = await runtime.encode(items, { query: true, code: true });
  assert.equal(vectors.length, 1);
  assert.equal(vectors[0].length, 128);
  assert.equal(vectors[0][1], 3);
  assert.deepEqual(events.find(event => event.status === 'encoding').request.items, items);
  assert.equal(events.some(event => event.status === 'ready'), true);
});

test('concurrent requests retain their own out-of-order results', async t => {
  const runtime = runtimeFor(t);
  const [slow, fast] = await Promise.all([runtime.encode([{ text: 'slow' }]), runtime.encode([{ text: 'fast' }])]);
  assert.equal(slow[0][0], 1);
  assert.equal(fast[0][0], 2);
  assert.equal(runtime.pending.size, 0);
});

test('cancelling one request terminates the worker and rejects every pending request', async t => {
  const runtime = runtimeFor(t);
  const firstPid = (await runtime.probe()).pid;
  const child = runtime.child;
  const exited = once(child, 'exit');
  const controller = new AbortController();
  const first = runtime.encode([{ text: 'wait' }], { signal: controller.signal });
  const second = runtime.encode([{ text: 'wait' }]);
  const results = Promise.allSettled([first, second]);
  controller.abort();
  assert.equal(runtime.child, null);
  assert.equal(runtime.pending.size, 0);
  for (const result of await results) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.name, 'AbortError');
  }
  await exited;
  assert.notEqual((await runtime.probe()).pid, firstPid);
});

test('pre-aborted calls do not start a worker', async t => {
  const runtime = runtimeFor(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runtime.probe({ signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(runtime.encode([{ text: 'wait' }], { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(runtime.child, null);
});

test('close terminates work and prevents reopening', async t => {
  const runtime = runtimeFor(t);
  await runtime.probe();
  const exited = once(runtime.child, 'exit');
  const pending = runtime.encode([{ text: 'wait' }]);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  runtime.close();
  await rejected;
  await exited;
  await assert.rejects(runtime.probe(), /已关闭/);
  await assert.rejects(runtime.encode([]), /已关闭/);
});

test('worker failures are surfaced without losing a healthy process', async t => {
  const runtime = runtimeFor(t);
  const pid = (await runtime.probe()).pid;
  await assert.rejects(runtime.encode([{ text: 'error' }]), { code: 'FIXTURE_ERROR', message: 'fixture failure' });
  assert.equal((await runtime.probe()).pid, pid);
  for (const text of ['wrong-count', 'wrong-dimension', 'nan', 'zero']) await assert.rejects(runtime.encode([{ text }]), /向量/);
});

test('broken protocol and worker exits reject work, then allow a fresh worker', async t => {
  const runtime = runtimeFor(t);
  const before = (await runtime.probe()).pid;
  await assert.rejects(runtime.encode([{ text: 'bad-json' }]), /通信数据无效/);
  const next = (await runtime.probe()).pid;
  assert.notEqual(next, before);
  await assert.rejects(runtime.encode([{ text: 'crash' }]), /已退出/);
  assert.notEqual((await runtime.probe()).pid, next);
});

test('dimensions and disabled encoders fail before process startup; space fingerprint ignores encoder loading', async t => {
  assert.throws(() => new ModelRuntime({ dimensions: 64 }), /向量维度/);
  const runtime = runtimeFor(t, { vision: false, audio: false });
  await assert.rejects(runtime.encode([{ image: 'file.png' }]), /编码器/);
  await assert.rejects(runtime.encode([{ video: 'file.mp4' }]), /编码器/);
  await assert.rejects(runtime.encode([{ audio: 'file.wav' }]), /编码器/);
  await assert.rejects(runtime.encode([{ text: 123 }]), /字符串/);
  await assert.rejects(runtime.encode([{ image: [123] }]), /路径/);
  assert.equal(runtime.child, null);
  assert.equal(runtime.fingerprint(), runtimeFor(t, { vision: true, audio: true }).fingerprint());
  assert.notEqual(runtime.fingerprint(), runtimeFor(t, { dimensions: 256 }).fingerprint());
});

test('missing Python process returns an actionable startup error', async t => {
  const runtime = runtimeFor(t, { python: path.join(os.tmpdir(), 'missing-ensoul-python-executable') });
  await assert.rejects(runtime.probe(), { code: 'ENOENT' });
  assert.equal(runtime.pending.size, 0);
});

test('download proxy reaches subprocess; direct disables inherited proxy and errors redact credentials', async t => {
  const configured = runtimeFor(t, { proxy: 'socks://user:secret@proxy.invalid:7897' });
  const probe = await configured.probe();
  assert.equal(probe.proxy, 'socks5://user:secret@proxy.invalid:7897');
  assert.equal(probe.allProxy, probe.proxy);
  const direct = runtimeFor(t, { proxy: 'direct' });
  const noProxy = await direct.probe();
  assert.equal(noProxy.proxy, null);
  assert.equal(noProxy.allProxy, null);
  await assert.rejects(configured.encode([{ text: 'proxy-error' }]), error => !error.message.includes('secret') && error.message.includes('[redacted]'));
  await configured.probe();
  const log = fs.readFileSync(configured.logPath, 'utf8');
  assert.equal(log.includes('secret'), false);
  assert.equal(log.includes('[redacted]'), true);
});
