const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-snapshots-'));
const app = path.join(box, 'app');
const a = path.join(box, 'a');
const b = path.join(box, 'b');
for (const dir of [app, a, b]) fs.mkdirSync(dir, { recursive: true });
process.env.ENSOUL_WORKSPACE = a;
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: {
  app: { getAppPath: () => app, getPath: () => path.join(box, 'userData'), getVersion: () => 'test' },
} };
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, file);
const { setWorkspaceRoot, readJsonSnapshot } = require('../src/main/fsapi.ts');
const { store } = require('../src/main/store.ts');
const { loadPlugins } = require('../src/main/plugins.ts');
const { snapshotFailed, validateSnapshot } = require('../src/shared/json-snapshot.ts');
function json(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}
function functionSource(file, name) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  let found;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(found, `${name} exists`);
  return found;
}
test.after(() => {
  assert.equal(path.dirname(path.resolve(box)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(box).startsWith('ensoul-snapshots-'));
  fs.rmSync(box, { recursive: true, force: true });
});

test('首次没有快照是 missing；过大、损坏和目录读取仍报告失败', () => {
  setWorkspaceRoot(a, { trust: true });
  assert.deepEqual(readJsonSnapshot('missing.json'), { status: 'missing' });
  assert.equal(snapshotFailed(readJsonSnapshot('missing.json')), false);
  json(path.join(a, 'good.json'), { contacts: [] });
  assert.deepEqual(readJsonSnapshot('good.json'), { status: 'ready', data: { contacts: [] } });
  fs.writeFileSync(path.join(a, 'broken.json'), '{');
  assert.equal(readJsonSnapshot('broken.json').status, 'invalid');
  fs.writeFileSync(path.join(a, 'large.json'), ' '.repeat(300001));
  assert.equal(readJsonSnapshot('large.json').status, 'too_large');
  fs.mkdirSync(path.join(a, 'directory'));
  assert.equal(readJsonSnapshot('directory').status, 'error');
  assert.equal(readJsonSnapshot('../outside.json').status, 'error');
  assert.equal(validateSnapshot({ status: 'ready', data: null }, Boolean, 'shape').status, 'invalid');
  assert.equal(validateSnapshot({ status: 'missing' }, () => false, 'shape').status, 'missing');
});

test('应用组件在外部工作区可见、能打开；同 id 的工作区做法优先', () => {
  const appFile = path.join(app, '.ensoul/library/components/shared.json');
  json(appFile, { id: 'shared', panel: 'shared', name: 'Application', kind: 'chat', look: {}, spec: { text: 'app' } });
  const original = fs.readFileSync(appFile, 'utf8');
  setWorkspaceRoot(a, { trust: true });
  assert.equal(store.componentCrafts().find((it) => it.id === 'shared').source, 'app');
  assert.ok(store.componentRefs().some((it) => it.id === 'shared' && it.craftOnly));
  const opened = store.openComponent('shared');
  assert.equal(opened.title, 'Application');
  assert.equal(opened.spec.text, 'app');
  assert.equal(fs.readFileSync(appFile, 'utf8'), original);
  json(path.join(a, '.ensoul/library/components/shared.json'), { id: 'shared', name: 'Workspace A', kind: 'chat' });
  assert.equal(store.componentCrafts().find((it) => it.id === 'shared').name, 'Workspace A');
  setWorkspaceRoot(b, { trust: true });
  assert.equal(store.componentCrafts().find((it) => it.id === 'shared').name, 'Application');
});

test('切换工作区重建自带插件；旧实例状态接口不会写入新工作区', () => {
  const dir = path.join(app, 'plugins/fixture');
  fs.mkdirSync(dir, { recursive: true });
  global.__snapshotFixture = { hosts: [], disposed: 0 };
  fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = {
    name: 'fixture',
    setup(api) { global.__snapshotFixture.hosts.push(api); api.state.save({ workspace: api.workspace }); },
    dispose() { global.__snapshotFixture.disposed++; }
  };`);
  setWorkspaceRoot(a, { trust: true });
  loadPlugins([]);
  const first = global.__snapshotFixture.hosts.at(-1);
  const count = global.__snapshotFixture.hosts.length;
  loadPlugins([]);
  assert.equal(global.__snapshotFixture.hosts.length, count);
  setWorkspaceRoot(b, { trust: true });
  loadPlugins([]);
  const second = global.__snapshotFixture.hosts.at(-1);
  assert.notEqual(first, second);
  assert.equal(first.workspace, a);
  assert.equal(second.workspace, b);
  assert.ok(global.__snapshotFixture.disposed > 0);
  assert.equal(first.state.save({ old: true }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a, '.ensoul/state/fixture.json'))), { old: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b, '.ensoul/state/fixture.json'))), { workspace: b });
  assert.equal(second.componentCrafts().find((it) => it.id === 'shared').source, 'app');
});

test('调度快照写入失败会重试；确认落盘后才缓存指纹；文件丢失可重建', () => {
  const boardPath = path.join(box, 'board.json');
  let fail = true;
  const context = vm.createContext({ path, boardPath, lastBoard: '',
    boardOf: () => ({ depts: [] }), boardSig: JSON.stringify, api: { log() {} },
    fs: { ...fs, writeFileSync(...args) {
      if (fail) { fail = false; throw new Error('temporary write failure'); }
      return fs.writeFileSync(...args);
    } },
  });
  vm.runInContext(functionSource(path.join(__dirname, '../plugins/dispatch/index.js'), 'writeBoard'), context);
  assert.equal(context.writeBoard(), false);
  assert.equal(context.lastBoard, '');
  assert.equal(fs.existsSync(boardPath), false);
  assert.equal(context.writeBoard(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(boardPath)), { depts: [] });
  assert.equal(context.writeBoard(), false);
  fs.unlinkSync(boardPath);
  assert.equal(context.writeBoard(), true);
});

test('成员快照收到失败确认时仍会重试，不把未保存的版本认成已保存', () => {
  let count = 0;
  const context = vm.createContext({ print: '', myPanels: {}, recalls: {}, tops: {},
    drain() {}, cards: () => [], snapshot: () => ({ contacts: [] }), t: (text) => text,
    api: { panels: () => [], param: () => false, log() {}, state: { save() { return ++count > 1; } } },
  });
  vm.runInContext(functionSource(path.join(__dirname, '../plugins/eschat/index.js'), 'tick'), context);
  context.tick();
  assert.equal(context.print, '');
  context.tick();
  assert.ok(context.print);
  context.tick();
  assert.equal(count, 2);
});
