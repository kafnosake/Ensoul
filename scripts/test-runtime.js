const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-runtime-'));
process.env.ENSOUL_WORKSPACE = box;
globalThis.t = (text) => text;
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: {
  app: { getAppPath: () => root, getPath: () => path.join(box, 'userData'), getVersion: () => 'test' },
  ipcMain: { handle() {}, on() {} }, BrowserWindow: class {}, dialog: {}, shell: {},
} };
const { RunRegistry } = require('../dist/main/run-registry');
const { BuildCoordinator, buildInput } = require('../dist/main/project-build');
const { executeRunCode } = require('../dist/main/ptc');
const { runAsPanel, writeText } = require('../dist/main/fsapi');
const { runTool, setExtensions } = require('../dist/main/agent');
const { runAgent } = require('../dist/main/chat-core');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test.after(() => {
  const target = path.resolve(box);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('ensoul-runtime-'));
  fs.rmSync(target, { recursive: true, force: true });
});

test('取消保留租约；旧任务不能释放新任务', () => {
  const runs = new RunRegistry();
  const first = { runId: 'first', ctrl: new AbortController() };
  assert.equal(runs.claim('p', first), true);
  assert.equal(runs.claim('p', { runId: 'second', ctrl: new AbortController() }), false);
  assert.equal(runs.cancel('p'), true);
  assert.equal(first.ctrl.signal.aborted, true);
  assert.equal(runs.has('p'), true);
  assert.equal(runs.release('p', 'first'), true);
  assert.equal(runs.claim('p', { runId: 'second', ctrl: new AbortController() }), true);
  assert.equal(runs.release('p', 'first'), false);
  assert.equal(runs.get('p').runId, 'second');
});

test('同时请求构建、随后应用同一版本，只执行一次', async () => {
  let count = 0;
  const builds = new BuildCoordinator(() => 'source', () => 'output', async () => {
    count += 1; await sleep(15); return { ok: true, out: 'built' };
  });
  const results = await Promise.all([builds.run('full'), builds.run('full'), builds.run('renderer')]);
  assert.equal(count, 1);
  assert.deepEqual(results.map((result) => !!result.reused), [false, true, true]);
});

test('构建中源码变化、构建失败、产物变化都不能复用', async () => {
  let source = 'a', output = 'a', count = 0;
  const builds = new BuildCoordinator(() => source, () => output, async () => {
    count += 1;
    if (count === 1) source = 'b';
    return { ok: count !== 2, out: 'build' };
  });
  assert.equal((await builds.run('full')).ok, false);
  assert.equal((await builds.run('full')).ok, false);
  assert.equal((await builds.run('full')).ok, true);
  assert.equal((await builds.run('full')).reused, true);
  output = 'modified';
  assert.equal((await builds.run('full')).reused, undefined);
  assert.equal(count, 4);
});

test('构建指纹区分插件入口、渲染依赖和 preload', () => {
  const work = path.join(box, 'fingerprint');
  const put = (rel, content) => {
    const file = path.join(work, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  };
  put('plugins/example/index.js', 'old');
  const full = buildInput(work, 'full'), renderer = buildInput(work, 'renderer');
  put('plugins/example/index.js', 'new');
  assert.equal(buildInput(work, 'full'), full);
  put('src/preload/index.ts', 'preload');
  assert.notEqual(buildInput(work, 'full'), full);
  assert.equal(buildInput(work, 'renderer'), renderer);
  put('plugins/example/view.ts', 'view');
  assert.notEqual(buildInput(work, 'renderer'), renderer);
});

test('PTC 没有 return/log 时，读工具结果仍能到达模型', async () => {
  const result = await executeRunCode('await tools.read_file({path:"a"})', async () => '真实文件内容');
  assert.match(result.output, /真实文件内容/);
});

test('PTC 未授权调用被拒绝，实际执行器不会收到它', async () => {
  let count = 0;
  const result = await executeRunCode('await tools.secret({})', async () => { count += 1; return 'secret'; }, undefined, 50, new Set(['read_file']));
  assert.equal(count, 0);
  assert.match(result.output, /不在当前面板/);
});

test('PTC Promise.all 不能绕过调用预算，同批工具依次执行', async () => {
  let active = 0, peak = 0, count = 0;
  const result = await executeRunCode('await Promise.allSettled([tools.a(),tools.a(),tools.a()])', async () => {
    count += 1; active += 1; peak = Math.max(peak, active); await sleep(15); active -= 1; return 'ok';
  }, undefined, 2, new Set(['a']));
  assert.equal(count, 2);
  assert.equal(peak, 1);
  assert.match(result.output, /最大工具调用上限/);
});

test('PTC 未 await 的工具也要结算，失败不能消失', async () => {
  const result = await executeRunCode('tools.a(); return "结束"', async () => { await sleep(10); throw Error('实际失败'); });
  assert.match(result.output, /实际失败/);
});

test('PTC 无限循环超时可终止，主线程仍能响应', async () => {
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 10);
  try {
    const result = await executeRunCode('while(true) {}', async () => '', undefined, 50, undefined, undefined, 150);
    assert.match(result.output, /TOOL_TIMEOUT/);
    assert.ok(ticks > 2);
  } finally { clearInterval(ticker); }
});

test('PTC 停止传到工具，后续排队调用不启动', async () => {
  const ctrl = new AbortController();
  let count = 0;
  const running = executeRunCode('await Promise.all([tools.a(),tools.a()])', async (_name, _args, signal) => {
    count += 1;
    setTimeout(() => ctrl.abort(Error('测试停止')), 10);
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve('stopped'), { once: true }));
  }, undefined, 50, new Set(['a']), ctrl.signal);
  await assert.rejects(running, /测试停止/);
  await sleep(30);
  assert.equal(count, 1);
});

test('已取消上下文拒绝后续文件写入', () => {
  const ctrl = new AbortController(); ctrl.abort(Error('测试停止'));
  assert.throws(() => runAsPanel('p', () => writeText('cancelled.txt', '不能写'), ctrl.signal), /测试停止/);
  assert.equal(fs.existsSync(path.join(box, 'cancelled.txt')), false);
});

test('工具超时取消处理器上下文，延迟写入被拦截', async () => {
  let delayed;
  setExtensions({ tools: [{ spec: { name: 'slow_test', timeoutMs: 30 }, handler: async () => {
    await sleep(70);
    try { writeText('late.txt', '不能写'); delayed = 'written'; }
    catch { delayed = 'blocked'; }
    return 'done';
  } }] });
  const result = await runTool('slow_test', {}, { panelId: 'p', signal: new AbortController().signal });
  assert.match(result, /TOOL_TIMEOUT/);
  await sleep(80);
  assert.equal(delayed, 'blocked');
  assert.equal(fs.existsSync(path.join(box, 'late.txt')), false);
  setExtensions({ tools: [] });
});

test('停止命令会结束子进程树，不能稍后继续写文件', async () => {
  const script = path.join(box, 'command-child.js');
  const ready = path.join(box, 'ready.txt'), late = path.join(box, 'command-late.txt');
  fs.writeFileSync(script, `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(late)},'bad'),1500);setInterval(()=>{},1000);`);
  const ctrl = new AbortController();
  const running = runTool('run_command', { command: `"${process.execPath}" "${script}"` }, { panelId: 'p', signal: ctrl.signal });
  const rejected = assert.rejects(running, /测试停止/);
  try {
    for (let i = 0; i < 100 && !fs.existsSync(ready); i += 1) await sleep(20);
    assert.ok(fs.existsSync(ready));
  } finally { ctrl.abort(Error('测试停止')); }
  await rejected;
  await sleep(1700);
  assert.equal(fs.existsSync(late), false);
});

test('模型返回多个工具时，停止后不会执行第二个', async () => {
  const original = globalThis.fetch;
  const ctrl = new AbortController();
  const calls = [];
  globalThis.fetch = async () => new Response('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [
    { index: 0, id: 'a', type: 'function', function: { name: 'first', arguments: '{}' } },
    { index: 1, id: 'b', type: 'function', function: { name: 'second', arguments: '{}' } },
  ] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  try {
    await assert.rejects(runAgent([{ role: 'user', content: 'task' }], { baseUrl: 'https://mock.invalid', apiKey: 'fake', model: 'fake' }, [], async (name) => {
      calls.push(name); ctrl.abort(Error('测试停止')); return 'done';
    }, { onText() {}, onTool() {} }, ctrl.signal), /测试停止/);
    assert.deepEqual(calls, ['first']);
  } finally { globalThis.fetch = original; }
});

test('自动刷新等执行收尾，构建应用目录，失败可重试，卸载后不构建', async () => {
  const work = path.join(box, 'refresh');
  for (const rel of ['src/renderer', 'src/shared', 'plugins']) fs.mkdirSync(path.join(work, rel), { recursive: true });
  for (const name of ['one.tsx', 'two.tsx', 'three.tsx']) fs.writeFileSync(path.join(work, 'src/renderer', name), 'fixture');
  const el = require('electron'), getAppPath = el.app.getAppPath, watch = fs.watch;
  const watchers = new Map();
  let busy = true, builds = 0, closed = 0;
  el.app.getAppPath = () => work;
  fs.watch = (dir, _opts, fn) => { watchers.set(dir, fn); return { close() { closed += 1; } }; };
  const plugin = require('../plugins/ui-refresh');
  try {
    plugin.setup({
      param: (key) => key === 'enabled' ? true : 500, log() {},
      panels: () => [{ id: 'p' }], isRunning: () => busy,
      buildProject: async (target, scope) => {
        assert.equal(target, 'renderer'); assert.equal(scope, 'app'); builds += 1;
        if (builds === 1) throw Error('构建异常');
        return { ok: true, out: 'built' };
      },
    });
    const change = watchers.get(path.join(work, 'src/renderer'));
    change('change', 'one.tsx');
    await sleep(550); assert.equal(builds, 0);
    busy = false;
    await sleep(550); assert.equal(builds, 1);
    change('change', 'two.tsx');
    await sleep(550); assert.equal(builds, 2);
    change('change', 'three.tsx'); plugin.dispose();
    await sleep(550); assert.equal(builds, 2); assert.equal(closed, 3);
  } finally {
    plugin.dispose(); fs.watch = watch; el.app.getAppPath = getAppPath;
  }
});

