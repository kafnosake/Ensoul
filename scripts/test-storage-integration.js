const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-storage-integration-'));
const data = path.join(box, 'data');
const a = path.join(box, 'a');
const b = path.join(box, 'b');
for (const dir of [data, a, b]) fs.mkdirSync(dir);
process.env.ENSOUL_WORKSPACE = a;
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: {
  app: { getPath: () => data, getAppPath: () => path.resolve(__dirname, '..'), getVersion: () => 'test' },
} };
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, file);
global.t = text => text;
const { setWorkspaceRoot } = require('../src/main/fsapi.ts');
const { projectDataPath, registerProjectStorage } = require('../src/main/storage.ts');
test.after(() => fs.rmSync(box, { recursive: true, force: true }));

test('tool output remains readable in the same panel after switching projects', () => {
  const { archiveToolResult } = require('../src/main/agent.ts');
  const output = 'tool-result-'.repeat(250);
  setWorkspaceRoot(a);
  archiveToolResult('storage-test', output, { panelId: 'storage-panel' });
  const dir = path.join(data, '.ensoul/panels/storage-panel');
  assert.ok(fs.existsSync(dir), 'panel output uses fixed application data root');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  setWorkspaceRoot(b);
  assert.equal(fs.readFileSync(path.join(dir, files[0]), 'utf8'), output);
  assert.equal(fs.existsSync(path.join(a, '.ensoul/panels/storage-panel')), false);
});

test('turn journal cache and writes follow the original project partition', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const start = source.indexOf('const TURN_JOURNAL');
  const end = source.indexOf('/** 只把该给界面看的', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ fs, path, projectDataPath, registerProjectStorage,
    workspaceRoot: () => current, exports: {} });
  vm.runInContext(ts.transpileModule(source.slice(start, end) + '\nexports.read = journalRead; exports.start = turnStart;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  let current = a;
  context.exports.start('panel-a', 1, 'A');
  const journalA = projectDataPath('.ensoul/state/turn-journal.json', a);
  assert.ok(fs.existsSync(journalA), 'journal is stored outside project files');
  current = b;
  context.exports.start('panel-b', 2, 'B');
  const journalB = projectDataPath('.ensoul/state/turn-journal.json', b);
  assert.deepEqual(JSON.parse(fs.readFileSync(journalA)).turns.map(item => item.panelId), ['panel-a']);
  assert.deepEqual(JSON.parse(fs.readFileSync(journalB)).turns.map(item => item.panelId), ['panel-b']);
});

test('extension installation defaults to user scope and retains explicit project scope', () => {
  const file = path.join(__dirname, '../src/main/extension-storage.ts');
  const install = fs.existsSync(file) ? require(file).installPluginFiles : undefined;
  assert.equal(typeof install, 'function', 'managed extension installer exists');
  const plan = { id: 'storage-test', targetDir: '.ensoul/plugins/storage-test',
    files: [{ rel: 'index.js', data: Buffer.from('module.exports = {};') }] };
  const globalDir = install(plan, a);
  assert.equal(globalDir, path.join(data, '.ensoul/plugins/storage-test'));
  assert.equal(fs.readFileSync(path.join(globalDir, 'index.js'), 'utf8'), 'module.exports = {};');
  assert.equal(fs.existsSync(path.join(a, plan.targetDir)), false);
  const projectDir = install(plan, b, 'workspace');
  assert.equal(projectDir, path.join(b, plan.targetDir));
  assert.equal(fs.readFileSync(path.join(projectDir, 'index.js'), 'utf8'), 'module.exports = {};');
});

test('a failed migration leaves the active and saved workspace unchanged', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const start = source.indexOf('const openWorkspace =');
  const end = source.indexOf("ipcMain.handle('settings:setWorkspace'", start);
  let selected = a;
  const store = { state: { workspace: a }, setWorkspaceRoot: root => { store.state.workspace = root; },
    syncCraftFiles() {}, refreshFailedFiles() {}, disabledPlugins: () => [] };
  const context = vm.createContext({ exports: {}, running: new Map(), store,
    setFsRoot: root => { selected = root; return root; }, workspaceRoot: () => selected,
    migrateWorkspaceState() {}, preparePluginStorage() {},
    migrateRuntimeData: () => ({ errors: [{ source: 'state.json', error: 'locked' }] }),
    tasks: { recover() {} }, loadPlugins() {}, refresh() {}, readText() {} });
  vm.runInContext(ts.transpileModule(source.slice(start, end) + '\nexports.open = openWorkspace;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  assert.throws(() => context.exports.open(b), /迁移失败/);
  assert.equal(selected, a);
  assert.equal(store.state.workspace, a);
});

test('a migration error in a recent project does not prevent the current project from opening', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const start = source.indexOf('const migrationRoots =');
  const end = source.indexOf('preparePluginStorage(store.state.workspace);', start);
  const context = vm.createContext({ path, store: { state: { workspace: a, recentWorkspaces: [b] } },
    dirAlive: () => true, migrateWorkspaceState() {}, preparePluginStorage() {},
    migrateRuntimeData: root => ({ errors: root === b ? [{ source: 'link', error: 'symlink' }] : [], reportFile: 'report.json' }),
    console: { log() {}, warn() {} } });
  assert.doesNotThrow(() => vm.runInContext(source.slice(start, end), context));
});
