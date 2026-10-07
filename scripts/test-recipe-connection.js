const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const repository = path.resolve(__dirname, '..');
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: {
  app: { getAppPath: () => repository, getPath: () => os.tmpdir() }
} };
const { readSkill, skillDigest } = require('../dist/main/skills');
const { setExtensions, toolsForPanel, toolsFor } = require('../dist/main/agent');
const { renderToolsSdk } = require('../dist/main/ptc');

test('find-recipe 能被发现与读取，入口与备用路径在正文里', () => {
  assert.match(skillDigest(), /find-recipe/);
  const content = readSkill('find-recipe');
  assert.match(content, /recipe_search/);
  assert.match(content, /history_search.*history_read/);
  assert.match(content, /不可用|未提供/);
});

test('实际工具分配和 PTC SDK 保留做法入口，员工只读权限可以使用', () => {
  const plugin = require('../plugins/semantic-search');
  const tools = [];
  plugin.setup({ workspace: '', t: text => text, state: { load: () => ({}), save: () => true },
    environments: { directory: () => os.tmpdir() }, panels: () => [],
    addSettingsSection() {}, addPrompt() {}, addCommand() {}, log() {},
    addTool: (spec, handler) => tools.push({ spec, handler, plugin: 'semantic-search' }) });
  try {
    setExtensions({ tools });
    for (const available of [toolsForPanel({ kind: 'chat' }), toolsFor('read', 'chat', ['dev']),
      toolsForPanel({ kind: 'table', noWorkspacePrompt: true, tools: ['recipe_search'] })]) {
      assert.ok(available.some(tool => tool.function.name === 'recipe_search'));
      assert.match(renderToolsSdk(available), /recipe_search\(/);
    }
    assert.ok(!toolsFor('read', 'chat', ['dev']).some(tool => tool.function.name === 'semantic_index_update'));
  } finally { plugin.dispose(); setExtensions({ tools: [] }); }
});

test('关键词备用入口读取拆分会话正文，保留旧格式和关闭会话', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-recipe-history-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const name of ['panels', 'closed']) fs.mkdirSync(path.join(directory, name));
  fs.writeFileSync(path.join(directory, 'workspace.json'), JSON.stringify({ panels: {
    live: { id: 'live', title: '下载恢复' }, legacy: { id: 'legacy', title: '旧格式', chat: [{ role: 'assistant', content: '旧格式恢复步骤' }] }
  } }));
  fs.writeFileSync(path.join(directory, 'panels/live.json'), JSON.stringify({ id: 'live', chat: [{ role: 'assistant', content: '网络恢复后复用缓存继续下载', createdAt: 0 }] }));
  fs.writeFileSync(path.join(directory, 'closed/closed.json'), JSON.stringify({ id: 'closed', title: '已关闭', chat: [{ role: 'assistant', content: '已关闭的恢复案例' }] }));
  const mod = { exports: {} }, handlers = new Map();
  vm.runInNewContext(fs.readFileSync(path.join(repository, 'plugins/history/index.js'), 'utf8'), {
    module: mod, exports: mod.exports, t: text => text,
    require: name => name === 'electron' ? { app: { getPath: () => directory } } : require(name)
  });
  mod.exports.setup({ t: text => text, addTool: (spec, handler) => handlers.set(spec.name, handler), log() {} });
  const result = handlers.get('history_search')({ keyword: '恢复' }, null);
  assert.match(result, /网络恢复后复用缓存/);
  assert.match(result, /旧格式恢复步骤/);
  assert.match(result, /已关闭的恢复案例/);
  assert.match(handlers.get('history_read')({ session: 'live' }, null), /网络恢复后复用缓存/);
});
