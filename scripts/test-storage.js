const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-storage-'));
const data = path.join(box, 'data');
const a = path.join(box, 'a');
const b = path.join(box, 'b');
for (const dir of [a, b]) fs.mkdirSync(dir, { recursive: true });
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: {
  app: { getAppPath: () => box, getPath: () => data, getVersion: () => 'test' },
} };
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, file);
let storage;
try { storage = require('../src/main/storage.ts'); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
test.after(() => {
  assert.equal(path.dirname(path.resolve(box)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(box).startsWith('ensoul-storage-'));
  fs.rmSync(box, { recursive: true, force: true });
});

test('个人路径固定全局；项目声明分区；项目扩展仍在项目内', () => {
  assert.equal(typeof storage?.runtimePath, 'function', '存储解析器尚未实现');
  const { runtimePath, registerProjectStorage, projectDataPath } = storage;
  registerProjectStorage('git', ['.ensoul/state/git.json']);
  assert.equal(runtimePath('.ensoul/state/notes.json', a), path.join(data, '.ensoul/state/notes.json'));
  assert.equal(runtimePath('.ensoul/state/notes.json', b), runtimePath('.ensoul/state/notes.json', a));
  assert.equal(runtimePath('.ensoul/state/git.json', a), projectDataPath('.ensoul/state/git.json', a));
  assert.notEqual(runtimePath('.ensoul/state/git.json', b), runtimePath('.ensoul/state/git.json', a));
  assert.equal(runtimePath('.ensoul/plugins/custom/index.js', a), path.join(a, '.ensoul/plugins/custom/index.js'));
  assert.equal(runtimePath('.ensoul/skills/custom/SKILL.md', a), path.join(a, '.ensoul/skills/custom/SKILL.md'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(projectDataPath('.ensoul/state/git.json', a))), '../workspace.json'))).workspace, a);
});

test('托管路径拒绝遍历、绝对路径和无项目的项目白名单', () => {
  assert.equal(typeof storage?.runtimePath, 'function');
  for (const rel of ['.ensoul/../secret', '.ensoul/state/../../secret', '.ensoul\\..\\secret', path.join(a, '.ensoul/state/a.json'), 'C:/outside']) {
    assert.throws(() => storage.runtimePath(rel, a));
  }
  assert.throws(() => storage.runtimePath('.ensoul/plugins/a'));
  assert.throws(() => storage.projectDataPath('.ensoul/state/git.json', ''));
});

test('显式项目配置精确留在工作区；同目录其余个人数据默认全局', () => {
  assert.equal(typeof storage?.registerWorkspaceStorage, 'function');
  storage.registerWorkspaceStorage('project-tool', ['.ensoul/tool/config.json']);
  json(path.join(a, '.ensoul/tool/config.json'), { endpoint: 'project' });
  json(path.join(a, '.ensoul/tool/profile.json'), { favorite: 'personal' });
  storage.migrateRuntimeData(a);
  assert.equal(storage.runtimePath('.ensoul/tool/config.json', a), path.join(a, '.ensoul/tool/config.json'));
  assert.equal(fs.existsSync(path.join(data, '.ensoul/tool/config.json')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(storage.runtimePath('.ensoul/tool/profile.json', b))), { favorite: 'personal' });
  assert.throws(() => storage.registerWorkspaceStorage('invalid', ['.ensoul']));
});

test('插件路径声明按工作区保存；撤销只影响该工作区的插件声明', () => {
  const project = '.ensoul/state/scoped-fixture.json';
  const config = '.ensoul/scoped-fixture/config.json';
  storage.registerProjectStorage('plugin:fixture', [project], a);
  storage.registerWorkspaceStorage('plugin:fixture', [config], a);
  assert.equal(storage.runtimePath(project, a), storage.projectDataPath(project, a));
  assert.equal(storage.runtimePath(project, b), path.join(data, project));
  assert.equal(storage.runtimePath(config, a), path.join(a, config));
  assert.equal(storage.runtimePath(config, b), path.join(data, config));
  storage.clearStorageRegistrations('plugin:', a);
  assert.equal(storage.runtimePath(project, a), path.join(data, project));
  assert.equal(storage.runtimePath('.ensoul/state/git.json', a), storage.projectDataPath('.ensoul/state/git.json', a), '核心声明不受撤销影响');
});

test('迁移保留旧文件、保留冲突双方、重试不覆盖且待执行命令仅归档', () => {
  assert.equal(typeof storage?.migrateRuntimeData, 'function');
  json(path.join(a, '.ensoul/state/notes.json'), { note: 'old' });
  json(path.join(a, '.ensoul/state/git.json'), { branch: 'a' });
  json(path.join(a, '.ensoul/state/notes.cmd.json'), { action: 'delete' });
  json(path.join(a, '.ensoul/plugins/custom/index.json'), { project: true });
  const first = storage.migrateRuntimeData(a);
  assert.equal(first.errors.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(storage.runtimePath('.ensoul/state/notes.json', a))), { note: 'old' });
  assert.equal(fs.existsSync(path.join(a, '.ensoul/state/notes.json')), true);
  assert.equal(fs.existsSync(storage.runtimePath('.ensoul/state/notes.cmd.json', a)), false);
  assert.equal(first.archivedCommands.length, 1);
  assert.equal(fs.existsSync(first.archivedCommands[0].target), true);
  assert.equal(fs.existsSync(path.join(data, '.ensoul/plugins/custom/index.json')), false);
  json(storage.runtimePath('.ensoul/state/notes.json', a), { note: 'current' });
  const retry = storage.migrateRuntimeData(a);
  assert.equal(retry.conflicts.length, 0);
  const savedReport = JSON.parse(fs.readFileSync(retry.reportFile));
  assert.equal(savedReport.archivedCommands.length, 1, '迁移报告重跑后仍能查到历史归档');
  assert.deepEqual(JSON.parse(fs.readFileSync(storage.runtimePath('.ensoul/state/notes.json', a))), { note: 'current' });
  json(path.join(b, '.ensoul/state/notes.json'), { note: 'second project' });
  const conflict = storage.migrateRuntimeData(b);
  assert.equal(conflict.conflicts.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(conflict.conflicts[0].target)), { note: 'second project' });
  assert.deepEqual(JSON.parse(fs.readFileSync(storage.runtimePath('.ensoul/state/notes.json', b))), { note: 'current' });
  assert.equal(storage.migrateRuntimeData(b).conflicts.length, 0);
  fs.unlinkSync(storage.runtimePath('.ensoul/state/notes.json', a));
  storage.migrateRuntimeData(a);
  assert.equal(fs.existsSync(storage.runtimePath('.ensoul/state/notes.json', a)), false, '全局删除不能被旧源复活');
  json(path.join(a, '.ensoul/state/notes.json'), { note: 'old source changed' });
  const changedSource = storage.migrateRuntimeData(a);
  assert.equal(changedSource.conflicts.length, 1, '已迁移的旧源变化只能保留为冲突副本');
  assert.equal(fs.existsSync(storage.runtimePath('.ensoul/state/notes.json', a)), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(changedSource.conflicts[0].target)), { note: 'old source changed' });
  json(storage.runtimePath('.ensoul/state/notes.json', a), { note: 'current' });
});

test('旧无工作区状态只迁移一次，换工作区不能复活已经删除的个人数据', () => {
  assert.equal(typeof storage?.migrateRuntimeData, 'function');
  const source = path.join(data, 'plugin-state/fallback.json');
  json(source, { personal: true });
  storage.migrateRuntimeData(a);
  const target = storage.runtimePath('.ensoul/state/fallback.json', a);
  assert.deepEqual(JSON.parse(fs.readFileSync(target)), { personal: true });
  fs.unlinkSync(target);
  storage.migrateRuntimeData(b);
  assert.equal(fs.existsSync(target), false, '全局legacy源也需要固定迁移marker');
});

test('尚未选择工作区也能迁移旧全局插件状态', () => {
  assert.equal(typeof storage?.migrateRuntimeData, 'function');
  json(path.join(data, 'plugin-state/unassigned.json'), { enabled: true });
  assert.doesNotThrow(() => storage.migrateRuntimeData(''));
  assert.deepEqual(JSON.parse(fs.readFileSync(storage.runtimePath('.ensoul/state/unassigned.json'))), { enabled: true });
});

test('文件通道使用逻辑路径、切换项目保留个人数据且普通文件受边界约束', () => {
  assert.equal(typeof storage?.runtimePath, 'function');
  const { setWorkspaceRoot, safePath, listDir, readText, dropPanelSpace } = require('../src/main/fsapi.ts');
  setWorkspaceRoot(a);
  assert.equal(safePath('.ensoul/state/notes.json'), storage.runtimePath('.ensoul/state/notes.json', a));
  assert.ok(listDir('.ensoul/state').some(entry => entry.path === '.ensoul/state/git.json'));
  assert.ok(listDir('.ensoul/state').every(entry => !entry.path.startsWith('../')));
  setWorkspaceRoot(b);
  assert.match(readText('.ensoul/state/notes.json'), /current/);
  assert.throws(() => safePath('../outside'));
  assert.throws(() => safePath(storage.runtimePath('.ensoul/state/notes.json', b)));
  assert.throws(() => safePath('.ensoul/state/../../outside'));
  assert.equal(safePath('src/main.ts'), path.join(b, 'src/main.ts'));
  const panel = storage.runtimePath('.ensoul/panels/fixture/output.txt', b);
  fs.mkdirSync(path.dirname(panel), { recursive: true });
  fs.writeFileSync(panel, 'output');
  dropPanelSpace('fixture');
  assert.equal(fs.existsSync(path.dirname(panel)), false);
});

test('大量运行环境文件分批记录迁移清单，重试与删除语义保持一致', () => {
  const workspace = path.join(box, 'many-files');
  for (let i = 0; i < 300; i++) json(path.join(workspace, '.ensoul/runtime/batch', `${i}.json`), { i });
  const originalWrite = fs.writeFileSync;
  let ledgerWrites = 0;
  fs.writeFileSync = function(file, ...args) {
    if (String(file).endsWith('sources.json.tmp')) ledgerWrites++;
    return originalWrite.call(this, file, ...args);
  };
  let report;
  try { report = storage.migrateRuntimeData(workspace); } finally { fs.writeFileSync = originalWrite; }
  assert.equal(report.errors.length, 0);
  assert.equal(report.copied.length, 300);
  assert.ok(ledgerWrites <= 3, `迁移清单被重写 ${ledgerWrites} 次`);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(path.dirname(report.reportFile), 'sources.json')))).length, 300);
  const target = storage.runtimePath('.ensoul/runtime/batch/0.json', workspace);
  fs.unlinkSync(target);
  assert.equal(storage.migrateRuntimeData(workspace).copied.length, 0);
  assert.equal(fs.existsSync(target), false);
});

test('失效的旧安装链接保留原件并归档目标信息，不阻止迁移', () => {
  const workspace = path.join(box, 'broken-link');
  const source = path.join(workspace, '.ensoul/runtime/old-package');
  const missingTarget = path.join(box, 'missing-package');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.symlinkSync(missingTarget, source, process.platform === 'win32' ? 'junction' : 'dir');
  const report = storage.migrateRuntimeData(workspace);
  assert.equal(report.errors.length, 0);
  assert.equal(report.archivedLinks.length, 1);
  assert.equal(fs.lstatSync(source).isSymbolicLink(), true);
  assert.equal(JSON.parse(fs.readFileSync(report.archivedLinks[0].target)).target, fs.readlinkSync(source));
  const retry = storage.migrateRuntimeData(workspace);
  assert.equal(retry.errors.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(retry.reportFile)).archivedLinks.length, 1);
});
