const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-writes-'));
process.env.ENSOUL_WORKSPACE = box;
globalThis.t = (text) => text;
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: {
  app: { getAppPath: () => path.resolve(__dirname, '..'), getPath: () => path.join(box, 'userData'), getVersion: () => 'test' },
  ipcMain: { handle() {}, on() {} }, BrowserWindow: class {}, dialog: {}, shell: {},
} };
const { fileWrites } = require('../dist/main/file-writes');
const { runtimePath, isRuntimePath, registerProjectStorage } = require('../dist/main/storage');
for (const plugin of [require('../plugins/tx-guard'), require('../plugins/file-backup')]) registerProjectStorage('fixture:' + plugin.name, plugin.storage.project);
const { setWorkspaceRoot, writeText, safePath } = require('../dist/main/fsapi');
const { runTool, runToolConfirmed, setExtensions } = require('../dist/main/agent');
const ctx = (panelId) => ({ panelId, host: 'main', kind: 'chat', runId: panelId + '-run' });
const hash = (text) => text === null ? 'missing' : createHash('sha256').update(text).digest('hex');
let serial = 0;
function fixture() {
  const root = path.join(box, String(++serial)); fs.mkdirSync(root);
  setWorkspaceRoot(root);
  const hooks = { fileWrite: [], afterTool: [], beforeTool: [], beforeWrite: [], tools: [] };
  const logs = [];
  const api = {
    workspace: root, dataPath: rel => runtimePath(rel, root), param: () => undefined, log: (...args) => logs.push(args.join(' ')),
    onFileWrite: (fn) => hooks.fileWrite.push(fn), onAfterTool: (fn) => hooks.afterTool.push(fn),
    onBeforeTool: (fn) => hooks.beforeTool.push(fn), onBeforeWrite: (fn) => hooks.beforeWrite.push(fn),
    addTool: (spec, handler) => hooks.tools.push({ spec, handler }),
    files: {
      write: writeText, revision: (rel) => fileWrites.revision(safePath(rel)),
      restore: (rel, before, expected) => fileWrites.restore(safePath(rel), before, expected),
    },
  };
  const plugin = require('../plugins/tx-guard'); plugin.setup(api);
  const configure = () => setExtensions(hooks);
  configure();
  const resolve = rel => isRuntimePath(rel) ? runtimePath(rel, root) : path.join(root, rel);
  const put = (rel, text) => { const file = resolve(rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const read = (rel) => fs.readFileSync(resolve(rel), 'utf8');
  const records = (kind) => {
    const dir = runtimePath('.ensoul/state/tx-guard/' + kind, root);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name)))) : [];
  };
  return { root, hooks, api, plugin, configure, put, read, records, logs };
}
const write = (panelId, content, file = 'a.json') => runTool('write_file', { path: file, content }, ctx(panelId));
const read = (panelId, file = 'a.json') => runTool('read_file', { path: file }, ctx(panelId));
test.afterEach(() => setExtensions({ tools: [], beforeTool: [], afterTool: [], beforeWrite: [], fileWrite: [] }));
test.after(() => {
  assert.equal(path.dirname(path.resolve(box)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(box).startsWith('ensoul-writes-'));
  fs.rmSync(box, { recursive: true, force: true });
});

test('同文件竞争在验收结束前拒绝，编辑器与确认入口也不能绕过', async () => {
  const f = fixture(); f.put('a.json', '{"a":1}');
  await read('B');
  let release, arrived;
  const ready = new Promise((resolve) => { arrived = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  f.hooks.afterTool.unshift(async (done) => { if (done.name === 'write_file' && done.ctx.panelId === 'A') { arrived(); await gate; } });
  f.configure();
  const first = write('A', '{bad'); await ready;
  try {
    assert.equal(JSON.parse(await write('B', '{"b":2}')).code, 'FILE_CONFLICT');
    assert.equal(JSON.parse(await runToolConfirmed('write_file', { path: 'a.json', content: '{}' }, ctx('B'))).code, 'FILE_CONFLICT');
    assert.throws(() => writeText('a.json', '编辑器保存'), /其他调用/);
    assert.equal(f.records('open').length, 1);
  } finally { release(); }
  assert.match(await first, /已撤回本次写入/);
  assert.equal(f.read('a.json'), '{"a":1}');
  assert.match(await write('B', '{"b":2}'), /已写入/);
  assert.equal(f.read('a.json'), '{"b":2}');
});

test('读后发生更新，覆盖和局部 edit 都拒绝；重读后可继续', async () => {
  const f = fixture(); f.put('a.json', '{"a":1}');
  await read('A'); await write('B', '{"a":2}');
  assert.equal(JSON.parse(await write('A', '{"a":3}')).code, 'FILE_CONFLICT');
  const edit = () => runTool('edit', { path: 'a.json', old_string: '2', new_string: '3' }, ctx('A'));
  assert.equal(JSON.parse(await edit()).code, 'FILE_CONFLICT');
  assert.equal(f.read('a.json'), '{"a":2}');
  await read('A'); assert.match(await edit(), /已改/);
  assert.equal(f.read('a.json'), '{"a":3}');
});

test('每次调用有不同编号，记录跟随实际写入而不是工具参数', async () => {
  const f = fixture(), calls = [], events = [];
  f.hooks.beforeTool.push((call) => { calls.push(call.toolCallId); assert.equal(call.toolCallId, call.ctx.toolCallId); });
  f.hooks.fileWrite.push((event) => events.push(event)); f.configure();
  await write('A', '{"a":1}'); await write('A', '{"a":2}');
  assert.notEqual(calls[0], calls[1]); assert.equal(events[0].toolCallId, calls[0]);
  assert.equal(events[1].toolCallId, calls[1]); assert.equal(events[1].beforeHash, hash('{"a":1}'));
  assert.equal(f.records('open').length, 0);
});

test('留底后、提交前的外部更新不会被覆盖，也不会被回滚', async () => {
  const f = fixture(); f.put('a.json', '{"a":1}');
  f.hooks.fileWrite.push(() => f.put('a.json', '{"external":1}')); f.configure();
  const out = await write('A', '{bad');
  assert.match(out, /FILE_CONFLICT/); assert.equal(f.read('a.json'), '{"external":1}');
  assert.equal(f.records('conflicts').length, 1); assert.equal(f.records('open').length, 0);
});

test('写后验收前发生后续修改，保留当前文件和独立冲突记录', async () => {
  const f = fixture(); f.put('a.json', '{"a":1}');
  f.hooks.afterTool.unshift((done) => { if (done.name === 'write_file') f.put('a.json', '{"other":2}'); });
  f.configure(); const out = await write('A', '{bad');
  assert.match(out, /保留现场/); assert.equal(f.read('a.json'), '{"other":2}');
  const rec = f.records('conflicts')[0]; assert.equal(rec.before, '{"a":1}'); assert.equal(rec.afterHash, hash('{bad'));
});

test('拦截、写入失败和未匹配 edit 均释放租约，不留下假事务', async () => {
  const f = fixture(); f.put('a.json', '{}');
  f.hooks.beforeTool.push(() => '被拦截'); f.configure(); assert.equal(await write('A', '{}'), '被拦截');
  f.hooks.beforeTool.length = 0; f.configure();
  assert.match(await runTool('edit', { path: 'a.json', old_string: '不存在', new_string: 'x' }, ctx('B')), /没找到/);
  assert.equal(f.records('open').length, 0);
  const dir = '.ensoul/state/tx-guard/open'; f.put(dir, '阻止留底');
  assert.match(await write('A', '{"a":2}'), /失败/); assert.equal(f.read('a.json'), '{}');
  fs.unlinkSync(runtimePath(dir, f.root));
  assert.match(await write('B', '{"b":2}'), /已写入/);
});

test('新建坏文件可以撤回，原本不合法的 JSON 方言不会误撤', async () => {
  const f = fixture(); assert.match(await write('A', '{bad'), /已撤回本次写入/);
  assert.equal(fs.existsSync(path.join(f.root, 'a.json')), false);
  f.put('a.json', '// jsonc\n{}'); await read('A'); await write('A', '// 保留方言\n{}');
  assert.equal(f.read('a.json'), '// 保留方言\n{}');
});

test('目录别名、大小写与相对路径共用同一写入租约', async () => {
  const f = fixture(); f.put('real/a.json', '{}');
  fs.symlinkSync(path.join(f.root, 'real'), path.join(f.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  let release, arrived;
  const ready = new Promise((resolve) => { arrived = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  f.hooks.afterTool.unshift(async (done) => { if (done.ctx.panelId === 'A') { arrived(); await gate; } }); f.configure();
  const first = write('A', '{"a":1}', 'real/a.json'); await ready;
  try {
    assert.equal(JSON.parse(await write('B', '{}', 'alias/./a.json')).code, 'FILE_CONFLICT');
    if (process.platform === 'win32') assert.equal(JSON.parse(await write('B', '{}', 'REAL/A.JSON')).code, 'FILE_CONFLICT');
  } finally { release(); }
  await first; assert.equal(f.read('alias/a.json'), '{"a":1}');
});

test('恢复仅还原匹配预计版本的文件；旧记录、后续修改和损坏记录保留', () => {
  const f = fixture();
  const record = (id, name, current, extra = {}) => {
    f.put(name, current);
    const rec = { txid: id, rel: name, full: path.join(f.root, name), before: '{}', beforeHash: hash('{}'), afterHash: hash('{bad'), pid: -1, at: 0, ...extra };
    f.put('.ensoul/state/tx-guard/open/' + id + '.json', JSON.stringify(rec));
  };
  record('match', 'match.json', '{bad'); record('changed', 'changed.json', '{"other":1}');
  record('legacy', 'legacy.json', '{bad', { afterHash: undefined, beforeHash: undefined });
  f.put('.ensoul/state/tx-guard/open/broken.json', '{broken');
  f.plugin.setup(f.api);
  assert.equal(f.read('match.json'), '{}'); assert.equal(f.read('changed.json'), '{"other":1}'); assert.equal(f.read('legacy.json'), '{bad');
  assert.equal(f.records('conflicts').length, 2);
  assert.equal(f.read('.ensoul/state/tx-guard/open/broken.json'), '{broken');
});

test('真实备份工具通过统一写入路径，批量回滚失败保留对应流水', async () => {
  const f = fixture(); require('../plugins/file-backup').setup(f.api); f.configure();
  f.put('a.json', '{"a":1}'); await read('A'); await write('B', '{"a":2}');
  assert.equal(JSON.parse(await runTool('restore_backup', { path: 'a.json' }, ctx('A'))).code, 'FILE_CONFLICT');
  const journal = runtimePath('.ensoul/backups/_journal.json', f.root);
  const before = JSON.parse(fs.readFileSync(journal)); assert.equal(before.length, 1);
  const out = await runTool('rollback_recent', { steps: 1 }, ctx('A'));
  assert.match(out, /未恢复 1 项/); assert.equal(JSON.parse(fs.readFileSync(journal)).length, 1); assert.equal(f.read('a.json'), '{"a":2}');
  await read('A'); assert.match(await runTool('restore_backup', { path: 'a.json' }, ctx('A')), /回滚到/);
  assert.equal(f.read('a.json'), '{"a":1}');
});
