const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const analytics = require('../plugins/semantic-search/analytics');

test('切换 CPU/CUDA 后自动更新仍执行，首次未准备模型时不会抢占配置', async t => {
  const ready = harness(t, { enabled: true, config: { device: 'cpu' }, setup: { device: 'cuda', model: 'google/embeddinggemma-2' } });
  ready.advance(61000);
  await ready.tick();
  await until(() => ready.count('update') === 1);
  await until(() => !ready.latest().operation);
  assert.equal(ready.latest().index.status, 'ready');
  const missing = harness(t, { enabled: true, config: { device: 'cpu' } });
  missing.advance(61000);
  await missing.tick();
  assert.equal(missing.count('update'), 0);
});

test('做法入口有提示、只读权限、正文预算和历史开关，关闭后不启动模型', async t => {
  let request;
  const h = harness(t, { enabled: true }, { search: args => {
    request = args;
    return Promise.resolve({ hits: [{ id: 'learned', kind: 'documents', text: '验收步骤'.repeat(300), source: { recipeType: 'learned', path: 'agent.json' } }], total: 1 });
  } });
  assert.equal(h.toolSpecs.get('recipe_search').level, 'read');
  assert.equal(h.toolSpecs.get('semantic_search').level, 'read');
  assert.match(h.prompts[0](), /use_skill\(\{name:"find-recipe"\}\)/);
  const reply = await h.tool('recipe_search', { query: '安装失败', maxChars: 500 });
  assert.equal(reply.ok, true);
  assert.equal(reply.returnedChars, 500);
  assert.equal(reply.hits[0].truncated, true);
  assert.equal(request.limit, 3);
  assert.equal(request.filter({ kind: 'code', source: {} }), false);
  assert.equal(request.filter({ kind: 'documents', source: { recipeType: 'work' } }), true);
  assert.equal(request.filter({ kind: 'history', source: {} }), false);
  await h.tool('recipe_search', { query: '安装失败', includeHistory: true });
  assert.equal(request.filter({ kind: 'history', source: {} }), true);
  await h.settings.onAction('set:off', 'enabled');
  const before = h.count('search');
  assert.equal((await h.tool('recipe_search', { query: '安装失败' })).ok, false);
  assert.equal(h.count('search'), before);
  assert.equal(h.prompts[0](), '');
});

const pluginFile = path.resolve(__dirname, '../plugins/semantic-search/index.js');
const copy = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function held(gate) {
  return args => new Promise((resolve, reject) => {
    const signal = args.signal;
    const abort = () => reject(Object.assign(new Error('测试操作已取消'), { name: 'AbortError' }));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    gate.promise.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
}

async function until(predicate, message) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.ok(predicate(), message || '异步操作未达到预期状态');
}

function harness(t, initial = {}, plans = {}, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-semantic-plugin-'));
  const workspace = path.join(directory, 'workspace');
  const userData = path.join(directory, 'userData');
  fs.mkdirSync(workspace);
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(workspace, 'evidence.md'), '原文证据');
  const commandDirectory = path.join(userData, '.ensoul/semantic-search/commands');
  const tools = new Map(), toolSpecs = new Map(), prompts = [], timers = new Set(), saves = [], calls = [], runtimes = [], logs = [], opened = [], activated = [], environments = [];
  const panels = [{ id: 'panel-a', kind: 'semantic-search' }, { id: 'panel-b', kind: 'semantic-search' }, { id: 'conversation', kind: 'chat' }];
  const sections = new Map();
  let clock = Date.now();
  class ControlledDate extends Date { static now() { return clock; } }

  function invoke(method, args, fallback) {
    calls.push({ method, args });
    return plans[method] ? plans[method](args) : Promise.resolve(fallback());
  }

  class FakeRuntime {
    constructor(options) { this.options = options; this.closed = 0; runtimes.push(this); }
    prepare(options) { return invoke('prepare', options, () => ({ loaded: true })); }
    probe(options) { return invoke('probe', options, () => ({ cached: true })); }
    encode(inputs, options = {}) { return invoke('encode', { ...options, inputs }, () => inputs.map(() => [1, 0])); }
    close() { this.closed++; }
  }

  class FakeIndex {
    constructor(options) { this.options = options; }
    search(args) {
      return invoke('search', args, () => {
        const features = this.options.getFeatures();
        const hits = [
          { id: 'document', kind: 'documents', source: { path: 'evidence.md', line: 1 } },
          { id: 'code', kind: 'code', source: { path: 'evidence.md', line: 1 } },
          { id: 'history', kind: 'history', source: { panelId: 'conversation', title: '工作区会话', at: 123 } },
          { id: 'archive', kind: 'history', source: { panelId: 'archive', title: '旧会话', unscoped: true } },
        ].filter(hit => features[hit.kind] && (!hit.source.unscoped || features.historyArchives)
          && (!args.kinds || args.kinds.includes(hit.kind)) && (!args.filter || args.filter(hit))).map(hit => ({ ...hit, text: args.query, score: .9 }));
        return { hits, query: args.query };
      });
    }
    update(args) {
      return invoke('update', args, () => {
        this.options.onStatus({ phase: 'embedding', completed: 1, total: 2, reused: 3 });
        return { items: 5, indexedAt: clock, warnings: [] };
      });
    }
    clear(args) { return invoke('clear', args, () => ({ cleared: true })); }
  }

  const electron = {
    app: { getPath: () => userData },
    session: { defaultSession: { resolveProxy: async () => 'PROXY localhost:7890' } },
    shell: { openPath: async filename => { opened.push(filename); return ''; } },
  };
  const dependencies = {
    './runtime': { ModelRuntime: FakeRuntime, prepareEnvironment: async (python, envDir, options) => {
      const executable = await invoke('install', { ...options, python, envDir }, () => 'private-python');
      options.onStatus?.({ status: 'installed', python: executable, version: 'Python 3.10' });
      return executable;
    } },
    './engine': { SemanticIndex: FakeIndex },
    './corpus': { scanCorpus: async () => ({ items: [], warnings: [] }) },
    './extract': { extractDocument: async () => ({ pages: [] }) },
    './analytics': analytics,
    electron,
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(pluginFile, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(pluginFile), process, AbortController, Date: ControlledDate,
    require: Object.assign(name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name), { cache: {}, resolve: name => path.resolve(path.dirname(pluginFile), name) }),
    setInterval: callback => { const timer = { callback, unref() {} }; timers.add(timer); return timer; },
    clearInterval: timer => timers.delete(timer),
  }, { filename: pluginFile });
  const plugin = module.exports;
  plugin.setup({
    workspace: options.workspace ?? workspace, t: text => text,
    dataPath: relative => path.join(userData, relative),
    environments: { directory: name => path.join(userData, 'env', name), registerPython: record => environments.push(copy(record)) },
    state: { load: () => copy(initial), save: state => { saves.push(copy(state)); return true; } },
    panels: () => panels,
    addSettingsSection: section => sections.set(section.id, section),
    addTool: (decl, handler) => { tools.set(decl.name, handler); toolSpecs.set(decl.name, decl); },
    addPrompt: callback => prompts.push(callback),
    addCommand() {},
    createPanel: spec => { const panel = { ...spec, id: 'created' }; panels.push(panel); return panel; },
    activatePanel: id => activated.push(id),
    log: (...values) => logs.push(values.join(' ')),
  });
  t.after(async () => {
    plugin.dispose();
    await flush();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('ensoul-semantic-plugin-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    workspace, directory, tools, timers, saves, calls, runtimes, logs, opened, activated, sections, plugin, environments,
    settings: sections.get('semantic-search'), download: sections.get('model-download'),
    latest: () => saves.at(-1), toolSpecs, prompts,
    count: method => calls.filter(call => call.method === method).length,
    advance: milliseconds => { clock += milliseconds; },
    tool: async (name, args = {}, context = {}) => JSON.parse(await tools.get(name)(args, { panelId: 'panel-a', ...context })),
    tick: async () => { for (const timer of [...timers]) await timer.callback(); await flush(); },
    command: (panelId, requestId, action, args = {}, filename) => {
      fs.mkdirSync(commandDirectory, { recursive: true });
      fs.writeFileSync(path.join(commandDirectory, filename || `${panelId}-${requestId}.json`), JSON.stringify({ ...args, panelId, requestId, action }));
    },
  };
}

test('功能设置在 MCP 后，模型下载独立位于更多，共享配置与状态', t => {
  const h = harness(t);
  assert.equal(h.sections.size, 2);
  assert.equal(h.settings.group, 'extension');
  assert.equal(h.settings.after, 'plugin:mcp:mcp-servers');
  assert.equal(h.settings.placement, undefined);
  assert.equal(h.download.placement, 'more');
  assert.equal(h.download.label, 'EmbeddingGemma 2');
  assert.equal(h.settings.onAction, h.download.onAction);
  const main = h.settings.view(), download = h.download.view();
  const mainActions = main.rows.flatMap(row => row.actions || []).map(action => action.id);
  assert.equal(mainActions.some(action => ['install', 'prepare', 'probe'].includes(action)), false);
  assert.equal(main.rows.some(row => ['python', 'model', 'proxy', 'environment'].includes(row.id)), false);
  assert.ok(['roots', 'dimensions', 'device'].every(id => main.rows.some(row => row.id === id)));
  assert.equal(download.rows.some(row => ['enabled', 'index', 'roots', 'dimensions', 'device'].includes(row.id)), false);
  assert.equal(download.rows.length, 1);
  assert.ok(download.rows[0].actions.some(action => action.id === 'setup' && action.label === '一键配置'));
  h.download.onAction('advanced', 'environment');
  assert.ok(['python', 'model', 'proxy'].every(id => h.download.view().rows.some(row => row.id === id)));
  assert.match(download.note, /全局管理/);
  assert.match(download.note, /不随源码或 Git 分发/);
  h.download.onAction('configure:direct', 'proxy');
  assert.equal(h.latest().config.proxy, 'direct');
  assert.equal(h.settings.view().reply, h.download.view().reply);
  assert.equal(h.calls.length, 0);
});

test('CPU 和 CUDA 使用下拉且保存后重挂保留；设备变化不作废索引', t => {
  const h = harness(t, { config: { device: 'cuda' }, index: { status: 'ready', indexedAt: 123, items: 5 } });
  assert.equal(h.latest().config.device, 'cuda');
  const row = h.settings.view().rows.find(row => row.id === 'device');
  assert.equal(row.inline, 'select');
  assert.deepEqual(copy(row.options).map(option => option.value), ['auto', 'cpu', 'cuda']);
  h.settings.onAction('configure:cpu', 'device');
  assert.equal(h.latest().config.device, 'cpu');
  assert.equal(h.latest().index.status, 'ready');
  const reopened = harness(t, h.latest());
  assert.equal(reopened.settings.view().rows.find(row => row.id === 'device').value, 'cpu');
  reopened.settings.onAction('configure:cuda', 'device');
  assert.equal(harness(t, reopened.latest()).latest().config.device, 'cuda');
});

test('一键配置等待依赖安装再下载验证模型，关闭总开关时也能完成准备', async t => {
  const gate = deferred();
  const h = harness(t, { config: { device: 'cuda' } }, { install: held(gate) });
  h.download.onAction('setup', 'environment');
  await until(() => h.count('install') === 1);
  assert.equal(h.count('prepare'), 0);
  assert.equal(h.calls.find(call => call.method === 'install').args.device, 'cuda');
  gate.resolve('private-python');
  await until(() => h.latest().operation === null);
  assert.equal(h.count('prepare'), 1);
  assert.equal(h.latest().setup.device, 'cuda');
  assert.equal(h.latest().runtime.status, 'ready');
  assert.equal(h.latest().enabled, false);
  assert.equal(h.environments[0].name, '语义搜索 Python');
  assert.ok(h.calls.find(call => call.method === 'install').args.envDir.startsWith(path.join(h.directory, 'userData')));
});

test('一键配置失败保留真实错误，不下载模型或显示准备成功', async t => {
  const h = harness(t, {}, { install: async () => { throw new Error('测试依赖失败'); } });
  h.download.onAction('setup', 'environment');
  await until(() => h.latest().operation === null);
  assert.equal(h.count('prepare'), 0);
  assert.equal(h.latest().setup, undefined);
  assert.equal(h.latest().runtime.status, 'error');
  assert.match(h.download.view().rows[0].desc, /配置失败/);
  assert.match(h.download.view().reply, /测试依赖失败/);
});

test('未完成一键配置前自动索引不抢占安装入口', async t => {
  const h = harness(t, { enabled: true });
  h.advance(120000);
  await h.tick();
  assert.equal(h.count('update'), 0);
  assert.equal(h.latest().operation, null);
  h.download.onAction('setup', 'environment');
  await until(() => h.latest().setup?.completedAt);
  h.advance(120000);
  await h.tick();
  assert.equal(h.count('update'), 1);
});

test('总开关默认关闭，不启动模型、自动索引或助手工具', async t => {
  const h = harness(t);
  assert.equal(h.latest().enabled, false);
  assert.equal(h.latest().features.historyArchives, false);
  h.advance(120000);
  await h.tick();
  for (const [name, args] of [
    ['semantic_search', { query: '工作区' }], ['semantic_index_update', {}],
    ['semantic_similarity', { inputs: ['a', 'b'] }], ['semantic_classify', { inputs: ['a'], labels: ['a', 'b'] }],
    ['semantic_cluster', { inputs: ['a', 'b'], clusters: 2 }],
  ]) {
    const result = await h.tool(name, args);
    assert.equal(result.ok, false);
    assert.match(result.error, /已关闭/);
  }
  assert.equal(h.runtimes.length, 0);
  assert.equal(h.calls.length, 0);
});

test('关闭总开关中止正在运行的任务并释放模型，保留单项选择', async t => {
  const gate = deferred();
  const h = harness(t, { enabled: true, features: { autoIndex: false, audio: false } }, { search: held(gate) });
  const result = h.tool('semantic_search', { query: '长任务' });
  await until(() => h.count('search') === 1);
  const running = h.latest().panels['panel-a'];
  assert.equal(running.status, 'running');
  const runtime = h.runtimes[0];
  h.settings.onAction('set:off', 'enabled');
  assert.equal(h.calls[0].args.signal.aborted, true);
  assert.equal(runtime.closed, 1);
  assert.equal((await result).ok, false);
  assert.equal(h.latest().enabled, false);
  assert.equal(h.latest().features.audio, false);
  assert.equal(h.latest().runtime.status, 'disabled');
  assert.equal(h.latest().panels['panel-a'].status, 'cancelled');
});

test('关闭单项检索或旧会话许可立即过滤已保存命中', async t => {
  const h = harness(t, { enabled: true, features: { autoIndex: false, historyArchives: true } });
  assert.equal((await h.tool('semantic_search', { query: '资料' })).hits.length, 4);
  h.settings.onAction('set:off', 'historyArchives');
  assert.equal(h.latest().panels['panel-a'].result.hits.some(hit => hit.source.unscoped), false);
  assert.equal(h.latest().panels['panel-a'].lastSearch.hits.some(hit => hit.source.unscoped), false);
  h.settings.onAction('set:off', 'documents');
  assert.equal(h.latest().panels['panel-a'].result.hits.some(hit => hit.kind === 'documents'), false);
  h.settings.onAction('set:off', 'agentSearch');
  const denied = await h.tool('semantic_search', { query: '资料' });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /助手检索工具已关闭/);
});

test('设置和工具参数校验拒绝无效范围、输入、配置和工作区外素材', async t => {
  const h = harness(t, { enabled: true, features: { autoIndex: false } });
  assert.throws(() => h.settings.onAction('configure:1024', 'dimensions'), /维度/);
  assert.throws(() => h.settings.onAction('configure:tpu', 'device'), /设备/);
  assert.throws(() => h.settings.onAction('configure:ftp://localhost', 'proxy'), /代理/);
  assert.throws(() => h.settings.onAction('set:on', 'unknown'), /未知功能/);
  fs.writeFileSync(path.join(h.directory, 'outside.png'), 'outside');
  for (const args of [{}, { query: 42 }, { query: 'x', limit: 0 }, { query: 'x', limit: '2' },
    { query: 'x', kinds: ['unknown'] }, { input: { image: '../outside.png' } }, { input: { image: '.' } }]) {
    assert.equal((await h.tool('semantic_search', args)).ok, false);
  }
  assert.equal(h.count('search'), 0);
  assert.equal((await h.tool('semantic_similarity', { inputs: [] })).ok, false);
  assert.equal((await h.tool('semantic_classify', { inputs: ['a'], labels: ['only-one'] })).ok, false);
  assert.equal((await h.tool('semantic_cluster', { inputs: ['a', 'b'], clusters: 5 })).ok, false);
  h.settings.onAction('set:off', 'images');
  fs.writeFileSync(path.join(h.workspace, 'inside.png'), 'inside');
  const denied = await h.tool('semantic_search', { input: { image: 'inside.png' } });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /图片检索已关闭/);
});

test('改变索引目录后清除旧结果，更新索引完成前拒绝继续搜索', async t => {
  const h = harness(t, { enabled: true, features: { autoIndex: false } });
  assert.equal((await h.tool('semantic_search', { query: '旧范围' })).ok, true);
  assert.equal(h.count('search'), 1);
  h.settings.onAction('configure:docs', 'roots');
  assert.equal(h.latest().index.status, 'stale');
  assert.equal(h.latest().panels['panel-a'].result, undefined);
  assert.equal(h.latest().panels['panel-a'].lastSearch, undefined);
  const stale = await h.tool('semantic_search', { query: '新范围' });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /请先更新索引/);
  assert.equal(h.count('search'), 1);
  assert.equal((await h.tool('semantic_index_update')).ok, true);
  assert.equal(h.latest().index.status, 'ready');
  assert.equal((await h.tool('semantic_search', { query: '新范围' })).ok, true);
  assert.equal(h.count('search'), 2);
});

for (const action of ['install', 'prepare', 'probe']) {
  test(`更多中的 ${action} 动作立即返回，后台完成前设置仍可读取`, async t => {
    const gate = deferred();
    const h = harness(t, { features: { autoIndex: false } }, { [action]: held(gate) });
    const reply = h.download.onAction(action, 'environment');
    assert.equal(typeof reply, 'string');
    assert.match(reply, /已开始处理/);
    await until(() => h.count(action) === 1);
    assert.equal(h.latest().operation.action, action);
    assert.ok(h.settings.view().rows.length > 5);
    assert.ok(h.download.view().rows.find(row => row.id === 'environment').actions.some(action => action.id === 'cancel'));
    assert.equal(h.download.onAction('refresh', 'environment'), '');
    if (action === 'prepare') assert.equal(h.runtimes[0].options.proxy, 'http://localhost:7890');
    gate.resolve(action === 'install' ? 'private-python' : action === 'probe' ? { cached: true } : { loaded: true });
    await until(() => h.latest().operation === null);
    assert.equal(h.logs.length, 0);
    assert.notEqual(h.latest().runtime.status, 'error');
    assert.equal(h.latest().enabled, false);
    assert.ok(h.runtimes.every(runtime => runtime.closed >= 1), '总开关关闭时，准备操作完成也应释放模型');
  });
}

test('更多中的取消入口中止下载任务并保存取消状态', async t => {
  const gate = deferred();
  const h = harness(t, {}, { prepare: held(gate) });
  h.download.onAction('prepare', 'environment');
  await until(() => h.count('prepare') === 1);
  const runtime = h.runtimes[0];
  h.advance(1000);
  runtime.options.onStatus({ status: 'preparing', message: '正在下载或载入模型' });
  assert.equal(h.download.view().rows.find(row => row.id === 'environment').desc, '正在下载或载入模型');
  assert.equal(h.download.onAction('cancel', 'environment'), '已发送取消请求');
  assert.equal(h.calls[0].args.signal.aborted, true);
  assert.equal(runtime.closed, 1);
  await until(() => h.latest().operation === null);
  assert.equal(h.latest().runtime.status, 'idle');
  assert.equal(h.download.view().reply, '操作已取消');
  assert.match(h.logs[0], /已取消/);
});

test('下载入口在未选择工作区时不安装环境或启动模型', async t => {
  const h = harness(t, {}, {}, { workspace: '' });
  for (const action of ['install', 'prepare', 'probe']) assert.equal(h.download.onAction(action, 'environment'), '请先选择工作区');
  await h.tick();
  assert.equal(h.runtimes.length, 0);
  assert.equal(h.calls.length, 0);
});

test('两个搜索面板同时派单时，忙回执和已完成结果归属正确', async t => {
  const gate = deferred();
  const h = harness(t, { enabled: true, features: { autoIndex: false } }, { search: held(gate) });
  h.command('panel-a', 'request-a', 'search', { query: '第一项' });
  h.command('panel-b', 'request-b', 'search', { query: '第二项' });
  await h.tick();
  await until(() => h.latest().panels['panel-b']?.status === 'error');
  assert.equal(h.latest().panels['panel-a'].requestId, 'request-a');
  assert.equal(h.latest().panels['panel-a'].status, 'running');
  assert.match(h.latest().panels['panel-b'].error, /另一项操作/);
  assert.equal(h.latest().panels['panel-b'].result, undefined);
  gate.resolve({ hits: [{ id: 'first', kind: 'documents', text: '第一项', score: 1, source: { path: 'evidence.md', line: 1 } }] });
  await until(() => h.latest().panels['panel-a']?.status === 'done');
  assert.equal(h.latest().panels['panel-a'].result.hits[0].text, '第一项');
  assert.equal(h.latest().panels['panel-b'].status, 'error');
  assert.equal(h.count('search'), 1);
});

test('界面命令确认 requestId，重复同一请求不会再次执行，包括较早请求重试', async t => {
  const h = harness(t, { enabled: true, features: { autoIndex: false, historyArchives: true } });
  const run = async (requestId, query) => {
    h.command('panel-a', requestId, 'search', { query });
    await h.tick();
    await until(() => h.latest().panels['panel-a']?.requestId === requestId && h.latest().panels['panel-a']?.status === 'done');
  };
  await run('original', '原请求');
  assert.equal(h.latest().panels['panel-a'].result.query, '原请求');
  await run('original', '重复原请求');
  assert.equal(h.count('search'), 1);
  await run('newer', '新请求');
  assert.equal(h.count('search'), 2);
  h.settings.onAction('set:off', 'historyArchives');
  h.command('panel-a', 'original', 'search', { query: '较早请求重试' });
  await h.tick();
  await flush();
  assert.equal(h.count('search'), 2, '重试较早 requestId 不应再次执行模型查询');
  assert.equal(h.latest().panels['panel-a'].result.hits.some(hit => hit.source.unscoped), false);
  assert.equal(h.latest().panels['panel-a'].lastSearch?.hits.some(hit => hit.source.unscoped), false,
    '重放的 lastSearch 也应过滤已关闭的旧会话');
  h.settings.onAction('configure:docs', 'roots');
  h.command('panel-a', 'original', 'search', { query: '范围变化后的重试' });
  await h.tick();
  assert.equal(h.count('search'), 2);
  assert.equal(h.latest().panels['panel-a'].result?.hits?.length || 0, 0, '索引范围改变后不能重放旧命中');
  assert.equal(h.latest().panels['panel-a'].lastSearch?.hits?.length || 0, 0);
});

test('取消命令中止原任务并等停止后给取消回执；已完成任务不假称取消', async t => {
  const gate = deferred();
  const oldResult = { hits: [{ id: 'document', kind: 'documents', score: 1, text: '已完成的检索', source: { path: 'evidence.md', line: 1 } }] };
  const wait = held(gate);
  const h = harness(t, { enabled: true, features: { autoIndex: false } }, { search: args => args.query === '已完成' ? Promise.resolve(oldResult) : wait(args) });
  assert.equal((await h.tool('semantic_search', { query: '已完成' })).ok, true);
  h.command('panel-a', 'long-request', 'search', { query: '长任务' });
  await h.tick();
  await until(() => h.count('search') === 2);
  h.command('panel-a', 'cancel-request', 'cancel', { targetRequestId: 'long-request' });
  await h.tick();
  await until(() => h.latest().panels['panel-a']?.requestId === 'cancel-request');
  assert.equal(h.latest().panels['panel-a'].status, 'done');
  assert.equal(h.latest().panels['panel-a'].result.cancelled, true);
  assert.equal(h.calls.filter(call => call.method === 'search').at(-1).args.signal.aborted, true);
  assert.equal(h.runtimes[0].closed, 1);
  assert.ok(h.saves.some(state => state.panels['panel-a']?.requestId === 'long-request' && state.panels['panel-a'].status === 'cancelled'));
  assert.equal(h.latest().panels['panel-a'].lastSearch?.hits[0].id, 'document', '取消后已展示的旧结果仍应有来源可打开');
  h.command('panel-a', 'nothing-to-cancel', 'cancel', { targetRequestId: 'long-request' });
  await h.tick();
  assert.equal(h.latest().panels['panel-a'].result.cancelled, false);
  assert.equal(h.latest().panels['panel-a'].lastSearch?.hits[0].id, 'document');
});

test('来源打开使用真实缓存命中，伪造来源不执行外部动作', async t => {
  const h = harness(t, { enabled: true, features: { autoIndex: false } });
  const result = await h.tool('semantic_search', { query: '证据' });
  const hit = result.hits.find(value => value.id === 'document');
  h.command('panel-a', 'open-real', 'open_source', { hit: { ...hit, source: { path: '../outside.exe' } } });
  await h.tick();
  await until(() => h.latest().panels['panel-a']?.requestId === 'open-real');
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0], path.join(h.workspace, 'evidence.md'));
  assert.ok(h.latest().panels['panel-a'].lastSearch.hits.length > 0);
  h.command('panel-a', 'open-forged', 'open_source', { hit: { id: 'not-in-results', source: { path: 'evidence.md' } } });
  await h.tick();
  await until(() => h.latest().panels['panel-a']?.requestId === 'open-forged');
  assert.equal(h.latest().panels['panel-a'].status, 'error');
  assert.equal(h.opened.length, 1);
});

test('卸载停止任务与计时器，迟到完成或状态回调不再保存', async t => {
  const gate = deferred();
  const h = harness(t, { enabled: true, features: { autoIndex: false } }, { search: () => gate.promise });
  const pending = h.tool('semantic_search', { query: '迟到结果' });
  await until(() => h.count('search') === 1);
  const runtime = h.runtimes[0];
  h.plugin.dispose();
  const writes = h.saves.length;
  assert.equal(runtime.closed, 1);
  assert.equal(h.timers.size, 0);
  runtime.options.onStatus({ status: 'ready', message: '迟到状态' });
  gate.resolve({ hits: [] });
  assert.equal((await pending).ok, false);
  await h.tick();
  assert.equal(h.saves.length, writes);
});
