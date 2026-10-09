const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-template-storage-'));
const app = path.join(box, 'app');
const userData = path.join(box, 'userData');
const a = path.join(box, 'a');
const b = path.join(box, 'b');
for (const dir of [app, userData, a, b]) fs.mkdirSync(dir, { recursive: true });
process.env.ENSOUL_WORKSPACE = a;
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: {
  app: { getAppPath: () => app, getPath: () => userData, getVersion: () => 'test' },
} };
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, file);
const { setWorkspaceRoot } = require('../src/main/fsapi.ts');
const { store } = require('../src/main/store.ts');
const globalCraft = id => path.join(userData, '.ensoul/library/components', `${id}.json`);
function json(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
}
const craft = (id, name) => ({ id, panel: id, name, title: name, kind: 'chat', look: { accent: 'red' }, spec: { prompt: name } });
test.after(() => {
  store.flushNow();
  assert.equal(path.dirname(path.resolve(box)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(box).startsWith('ensoul-template-storage-'));
  fs.rmSync(box, { recursive: true, force: true });
});

test('导入的个人组件做法写入全局，切换项目仍可读取', () => {
  setWorkspaceRoot(a, { trust: true });
  const imported = store.importComponent({ component: { name: 'Personal', kind: 'chat', look: { accent: 'red' }, spec: { prompt: 'Keep me' } } });
  assert.ok(imported);
  assert.ok(fs.existsSync(globalCraft(imported.id)), '个人组件模板应保存到固定应用数据根');
  assert.equal(fs.existsSync(path.join(a, '.ensoul/library/components', `${imported.id}.json`)), false);
  setWorkspaceRoot(b, { trust: true });
  assert.equal(store.componentCrafts().find(it => it.id === imported.id).spec.prompt, 'Keep me');
});

test('全局个人做法优先，项目专属和自带做法仍可读取', () => {
  json(globalCraft('priority'), craft('priority', 'Personal'));
  json(path.join(a, '.ensoul/library/components/priority.json'), craft('priority', 'Old workspace'));
  json(path.join(a, '.ensoul/library/components/project-only.json'), craft('project-only', 'Project'));
  json(path.join(app, '.ensoul/library/components/builtin.json'), craft('builtin', 'Builtin'));
  setWorkspaceRoot(a, { trust: true });
  assert.equal(store.componentCrafts().find(it => it.id === 'priority').name, 'Personal');
  assert.equal(store.componentCrafts().find(it => it.id === 'project-only').name, 'Project');
  assert.equal(store.componentCrafts().find(it => it.id === 'builtin').source, 'app');
  setWorkspaceRoot(b, { trust: true });
  assert.equal(store.componentCrafts().some(it => it.id === 'project-only'), false);
  assert.equal(store.componentCrafts().find(it => it.id === 'priority').name, 'Personal');
});

test('撤销个人组件后保留的旧项目副本不会重新出现', () => {
  setWorkspaceRoot(a, { trust: true });
  const imported = store.importComponent({ component: { name: 'Delete me', kind: 'chat', spec: { prompt: 'Old' } } });
  assert.ok(imported);
  json(path.join(a, '.ensoul/library/components', `${imported.id}.json`), craft(imported.id, 'Old copy'));
  store.removeComponent(imported.id);
  assert.equal(fs.existsSync(globalCraft(imported.id)), false);
  assert.ok(fs.existsSync(path.join(a, '.ensoul/library/components', `${imported.id}.json`)), '迁移后的工作区原件应保留');
  assert.equal(store.componentCrafts().some(it => it.id === imported.id), false);
  store.syncCraftFiles();
  assert.equal(store.componentCrafts().some(it => it.id === imported.id), false);
});

test('旧单文件拆分不覆盖已有全局模板，也不复活已撤销模板', () => {
  setWorkspaceRoot(a, { trust: true });
  json(globalCraft('legacy-existing'), craft('legacy-existing', 'Current'));
  json(path.join(userData, '.ensoul/library/presets.json'), { items: [craft('legacy-existing', 'Old'), craft('legacy-new', 'New')] });
  store.syncCraftFiles();
  assert.equal(store.componentCrafts().find(it => it.id === 'legacy-existing').name, 'Current');
  assert.equal(store.componentCrafts().find(it => it.id === 'legacy-new').name, 'New');
  assert.ok(fs.existsSync(globalCraft('legacy-new')));
});

test('旧个人模板复制后切换仍可用，撤销后重复迁移不会复活', () => {
  const root = path.join(box, 'migration');
  const original = path.join(root, '.ensoul/library/components/migrated-personal.json');
  json(original, craft('migrated-personal', 'Migrated'));
  const oldText = fs.readFileSync(original, 'utf8');
  const { migrateRuntimeData } = require('../src/main/storage.ts');
  migrateRuntimeData(root);
  assert.ok(fs.existsSync(globalCraft('migrated-personal')));
  assert.equal(fs.readFileSync(original, 'utf8'), oldText);
  setWorkspaceRoot(b, { trust: true });
  assert.equal(store.componentCrafts().find(it => it.id === 'migrated-personal').name, 'Migrated');
  store.removeComponent('migrated-personal');
  migrateRuntimeData(root);
  setWorkspaceRoot(root, { trust: true });
  assert.equal(store.componentCrafts().some(it => it.id === 'migrated-personal'), false);
  assert.equal(fs.existsSync(globalCraft('migrated-personal')), false);
});

test('修改只有项目副本的模板生成全局个人版本，保留项目源文件', () => {
  const original = path.join(a, '.ensoul/library/components/rename-project.json');
  json(original, craft('rename-project', 'Project name'));
  const oldText = fs.readFileSync(original, 'utf8');
  setWorkspaceRoot(a, { trust: true });
  assert.equal(store.renameComponent('rename-project', 'Personal name'), true);
  assert.equal(fs.readFileSync(original, 'utf8'), oldText);
  assert.equal(JSON.parse(fs.readFileSync(globalCraft('rename-project'))).name, 'Personal name');
  setWorkspaceRoot(b, { trust: true });
  assert.equal(store.componentCrafts().find(it => it.id === 'rename-project').name, 'Personal name');
});

test('旧组件本体的内嵌做法不覆盖已有全局模板', () => {
  json(globalCraft('stow-conflict'), craft('stow-conflict', 'Current'));
  const oldBody = path.join(userData, 'components/stow-conflict.json');
  json(oldBody, { id: 'stow-conflict', component: 'Old body', kind: 'chat', title: 'Old body', look: { accent: 'blue' }, spec: { prompt: 'Old body' }, chat: [] });
  const oldText = fs.readFileSync(oldBody, 'utf8');
  store.syncCraftFiles();
  assert.equal(JSON.parse(fs.readFileSync(globalCraft('stow-conflict'))).name, 'Current');
  assert.equal(fs.readFileSync(oldBody, 'utf8'), oldText);
});

test('已存个人组件改名同步全局做法，继续保留原提示词', () => {
  setWorkspaceRoot(a, { trust: true });
  const imported = store.importComponent({ component: { name: 'Before rename', kind: 'chat', spec: { prompt: 'Same prompt' } } });
  assert.ok(imported);
  assert.equal(store.renameComponent(imported.id, 'After rename'), true);
  const saved = JSON.parse(fs.readFileSync(globalCraft(imported.id), 'utf8'));
  assert.equal(saved.name, 'After rename');
  assert.equal(saved.spec.prompt, 'Same prompt');
});
