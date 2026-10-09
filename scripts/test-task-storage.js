const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const box = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-task-storage-'));
const userData = path.join(box, 'userData');
const a = path.join(box, 'a');
const b = path.join(box, 'b');
for (const dir of [userData, a, b]) fs.mkdirSync(dir, { recursive: true });
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: {
  app: { getAppPath: () => box, getPath: () => userData, getVersion: () => 'test' },
} };
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, file);
const { TaskService } = require('../src/main/task-service.ts');
const request = requestId => ({ panelId: 'worker', text: '实际任务', requestId });
const context = { panelId: 'owner', runId: 'owner-run' };
const queue = { enqueue() {}, remove() {}, changed() {} };
test.after(() => {
  assert.equal(path.dirname(path.resolve(box)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(box).startsWith('ensoul-task-storage-'));
  fs.rmSync(box, { recursive: true, force: true });
});

test('任务保存到全局项目分槽，切换后的迟到完成仍写原项目', () => {
  let current = a;
  const service = new TaskService(() => current, queue);
  const first = service.submit(request('a1'), context).task;
  assert.ok(first);
  assert.equal(fs.existsSync(path.join(a, '.ensoul/state/tasks.json')), false, '任务 journal 不应继续写入工作区');
  const { projectDataPath } = require('../src/main/storage.ts');
  const aFile = projectDataPath('.ensoul/state/tasks.json', a);
  assert.ok(fs.existsSync(aFile));
  assert.equal(first.workspace, path.resolve(a));
  assert.equal(service.begin(first.id, 'run-a', new AbortController()), true);
  current = b;
  const second = service.submit(request('b1'), context).task;
  assert.equal(service.list().some(task => task.id === first.id), false);
  service.finish(first.id, 'run-a', { ok: true, content: 'Finished in A' });
  assert.equal(JSON.parse(fs.readFileSync(aFile)).tasks.find(task => task.id === first.id).status, 'completed');
  assert.equal(JSON.parse(fs.readFileSync(projectDataPath('.ensoul/state/tasks.json', b))).tasks[0].id, second.id);
  current = a;
  assert.equal(service.get(first.id).result, 'Finished in A');
});

test('旧 journal 复制到原项目分槽，保留源记录和原任务 workspace', () => {
  const legacyRoot = path.join(box, 'legacy');
  const oldFile = path.join(legacyRoot, '.ensoul/state/tasks.json');
  const oldTask = { id: 'task-old', workspace: legacyRoot, originPanelId: 'owner', panelId: 'worker', requestId: 'old', text: 'Old', status: 'completed', createdAt: 1, updatedAt: 1 };
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  fs.writeFileSync(oldFile, JSON.stringify({ version: 1, tasks: [oldTask] }));
  const oldText = fs.readFileSync(oldFile, 'utf8');
  const { migrateRuntimeData, projectDataPath } = require('../src/main/storage.ts');
  migrateRuntimeData(legacyRoot);
  const service = new TaskService(() => legacyRoot, queue);
  assert.equal(service.get('task-old').workspace, legacyRoot);
  assert.equal(fs.readFileSync(oldFile, 'utf8'), oldText);
  assert.ok(fs.existsSync(projectDataPath('.ensoul/state/tasks.json', legacyRoot)));
});
