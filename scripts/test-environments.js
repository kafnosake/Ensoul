const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-environments-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mod = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/main/environments.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(source, { exports: mod.exports, require: name => name === './paths' ? { userDataPath: () => root } : require(name) });
  return { root, api: mod.exports };
}
function legacy(workspace, config) {
  const file = path.join(workspace, '.ensoul/state/env-config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config));
}
test('各工作区共用解释器，登记更新保留当前激活项', t => {
  const { root, api } = fixture(t);
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  legacy(a, { pythons: [{ id: 'system', name: '系统', path: 'python' }], activePythonId: 'system' });
  api.registerPythonEnvironment({ id: 'semantic', name: '语义搜索 Python', path: 'global/python', version: 'Python 3.10' }, a);
  api.registerPythonEnvironment({ id: 'semantic', name: '语义搜索 Python', path: 'global/python', version: 'Python 3.12' }, b);
  const config = api.readEnvironmentConfig(b);
  assert.equal(config.pythons.length, 2);
  assert.equal(config.activePythonId, 'system');
  assert.equal(config.pythons[1].version, 'Python 3.12');
  assert.equal(api.environmentDirectory('semantic-search'), path.join(root, 'env/semantic-search'));
});
test('旧配置只迁移一次，删除后不会从旧工作区重新出现', t => {
  const { root, api } = fixture(t);
  const workspace = path.join(root, 'workspace');
  legacy(workspace, { pythons: [{ id: 'old', name: '旧环境', path: 'old/python' }] });
  const config = api.readEnvironmentConfig(workspace);
  config.pythons = [];
  fs.writeFileSync(api.environmentConfigFile(), JSON.stringify(config));
  assert.equal(api.readEnvironmentConfig(workspace).pythons.length, 0);
});
test('不同工作区重名解释器保留，损坏配置明确报错', t => {
  const { root, api } = fixture(t);
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  legacy(a, { pythons: [{ id: 'python', name: 'A', path: 'a/python' }] });
  legacy(b, { pythons: [{ id: 'python', name: 'B', path: 'b/python' }] });
  api.readEnvironmentConfig(a);
  const config = api.readEnvironmentConfig(b);
  assert.equal(new Set(config.pythons.map(value => value.id)).size, 2);
  fs.writeFileSync(api.environmentConfigFile(), 'broken');
  assert.throws(() => api.readEnvironmentConfig(a));
  assert.equal(fs.readFileSync(api.environmentConfigFile(), 'utf8'), 'broken');
});
