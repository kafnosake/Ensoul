const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { userDataPath } = require('../dist/main/paths');
const base = path.join(userDataPath(''), 'env/semantic-search');
const python = path.join(base, `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

test('真实模型贯通做法扫描、索引、插件工具与 PTC 调用', { timeout: 180000 }, async t => {
  if (!fs.existsSync(python) || !fs.existsSync(path.join(base, 'models'))) { t.skip('本机未准备模型，不执行下载'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-recipe-real-'));
  const workspace = path.join(directory, 'workspace'), userData = path.join(directory, 'userData');
  fs.mkdirSync(path.join(workspace, 'work'), { recursive: true });
  fs.mkdirSync(path.join(workspace, '.ensoul/state/agents'), { recursive: true });
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(workspace, '.gitignore'), '.ensoul/\n');
  fs.writeFileSync(path.join(workspace, 'work/install.md'), '网络中断后的安装恢复：先检查代理，再复用缓存继续下载。安装完成后以依赖导入成功验收。');
  const file = path.join(workspace, '.ensoul/state/agents/engineer.json');
  fs.writeFileSync(file, JSON.stringify({ id: 'engineer', name: '工程师', learned: [{ name: '下载恢复', how: '适用：安装下载中断。步骤：复用缓存继续下载。边界：文件校验失败则重新下载。验收：依赖正常导入。' }] }));
  const entry = path.resolve(__dirname, '../plugins/semantic-search/index.js'), realRequire = createRequire(entry);
  const requireForPlugin = name => name === 'electron' ? { app: { getPath: () => userData } } : realRequire(name);
  requireForPlugin.cache = require.cache; requireForPlugin.resolve = realRequire.resolve;
  const mod = { exports: {} }, tools = new Map();
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), { module: mod, exports: mod.exports, __dirname: path.dirname(entry),
    require: requireForPlugin, process, AbortController, setInterval, clearInterval });
  const plugin = mod.exports;
  t.after(async () => {
    plugin.dispose();
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  plugin.setup({ workspace, t: text => text,
    state: { load: () => ({ enabled: true, config: { device: 'auto' }, features: { images: false, audio: false, video: false, autoIndex: false } }), save: () => true },
    environments: { directory: () => base }, panels: () => [],
    addSettingsSection() {}, addPrompt() {}, addCommand() {}, log() {}, addTool: (spec, handler) => tools.set(spec.name, handler) });
  const ctx = { panelId: 'case-task' };
  const updated = JSON.parse(await tools.get('semantic_index_update')({}, ctx));
  assert.equal(updated.ok, true);
  assert.equal(updated.items, 2);
  const reply = JSON.parse(await tools.get('recipe_search')({ query: '下载中断后如何继续安装' }, ctx));
  assert.equal(reply.ok, true);
  assert.deepEqual(new Set(reply.hits.map(hit => hit.recipeType)), new Set(['learned', 'work']));
  assert.ok(reply.hits.every(hit => Number.isFinite(hit.score) && fs.existsSync(hit.source.path)));
  assert.ok(reply.returnedChars <= 3000);
  const { executeRunCode } = require('../dist/main/ptc');
  const execution = await executeRunCode('return await tools.recipe_search({query:"下载恢复"})',
    (name, args) => tools.get(name)(args, ctx), undefined, 50, new Set(['recipe_search']));
  assert.match(execution.output, /learned/);
  assert.match(execution.output, /work/);
  fs.writeFileSync(file, JSON.stringify({ id: 'engineer', learned: [] }));
  const removed = JSON.parse(await tools.get('semantic_index_update')({}, ctx));
  assert.equal(removed.removed, 1);
  const final = JSON.parse(await tools.get('recipe_search')({ query: '下载恢复' }, ctx));
  assert.ok(final.hits.every(hit => hit.recipeType === 'work'));
});
