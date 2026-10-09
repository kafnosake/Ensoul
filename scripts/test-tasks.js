const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
globalThis.t = (text) => text;
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-tasks-'));
const userData = path.join(box, 'userData');
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: {
  app: { getAppPath: () => path.resolve(__dirname, '..'), getPath: () => userData, getVersion: () => 'test' },
} };
const { TaskService } = require('../dist/main/task-service');
const { projectDataPath, registerProjectStorage, runtimePath } = require('../dist/main/storage');
const journalFile = root => projectDataPath('.ensoul/state/tasks.json', root);
let serial = 0;
const request = (patch = {}) => ({ panelId: 'worker', text: '实际任务', title: '任务', requestId: 'r1', ...patch });
const context = (patch = {}) => ({ panelId: 'owner', runId: 'owner-run', ...patch });
function fixture() {
  const root = path.join(box, String(++serial));
  fs.mkdirSync(root, { recursive: true });
  const queue = new Map();
  const adapter = {
    enqueue(task) { queue.set(task.id, task); },
    remove(ids) { for (const id of ids) queue.delete(id); }, changed() {},
  };
  return { root, queue, adapter, service: new TaskService(() => root, adapter) };
}
function start(service, task, runId = 'worker-run') {
  const ctrl = new AbortController();
  assert.equal(service.begin(task.id, runId, ctrl), true);
  return ctrl;
}
test.after(() => {
  assert.equal(path.dirname(path.resolve(box)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(box).startsWith('ensoul-tasks-'));
  fs.rmSync(box, { recursive: true, force: true });
});

test('重复提交复用编号和队列，冲突正文拒绝，独立请求保留', () => {
  const { service, queue } = fixture();
  const first = service.submit(request(), context());
  assert.equal(first.ok, true);
  const again = service.submit(request(), context({ runId: 'later' }));
  assert.equal(again.task.id, first.task.id);
  assert.equal(again.reused, true);
  assert.equal(queue.size, 1);
  assert.equal(service.submit(request({ text: '另一任务' }), context()).ok, false);
  assert.equal(service.submit(request({ requestId: 'r2' }), context()).ok, true);
  assert.equal(queue.size, 2);
});

test('任务先落盘，重启修复缺失 outbox；同任务只领取一次', () => {
  const { root, adapter, queue, service } = fixture();
  adapter.enqueue = (task) => {
    assert.equal(JSON.parse(fs.readFileSync(journalFile(root))).tasks[0].id, task.id);
    queue.set(task.id, task);
  };
  const task = service.submit(request(), context()).task;
  queue.clear();
  const recovered = new TaskService(() => root, adapter);
  recovered.recover(); recovered.recover();
  assert.equal(queue.size, 1);
  start(recovered, task);
  assert.equal(queue.size, 0);
  assert.equal(recovered.begin(task.id, 'duplicate', new AbortController()), false);
});

test('重启将正在执行标为中断，并取消尚未开始的后代', () => {
  const { root, adapter, queue, service } = fixture();
  const parent = service.submit(request(), context()).task;
  start(service, parent);
  const child = service.submit(request({ panelId: 'child', requestId: 'child' }), context({ panelId: 'worker', taskId: parent.id, runId: 'worker-run' })).task;
  const recovered = new TaskService(() => root, adapter);
  recovered.recover();
  assert.equal(recovered.get(parent.id).status, 'interrupted');
  assert.equal(recovered.get(child.id).status, 'cancelled');
  assert.equal(queue.size, 0);
  assert.equal(recovered.begin(parent.id, 'retry', new AbortController()), false);
});

test('排队取消后重启不重放；迟到成功不能覆盖取消或错误 runId', () => {
  const { root, adapter, queue, service } = fixture();
  const first = service.submit(request(), context()).task;
  service.cancel(first.id, 'owner');
  new TaskService(() => root, adapter).recover();
  assert.equal(queue.size, 0);
  const second = service.submit(request({ requestId: 'r2' }), context()).task;
  const ctrl = start(service, second);
  service.finish(second.id, 'wrong-run', { ok: true });
  assert.equal(service.get(second.id).status, 'running');
  service.cancel(second.id, 'owner');
  assert.equal(ctrl.signal.aborted, true);
  assert.equal(service.get(second.id).status, 'cancelling');
  service.finish(second.id, 'worker-run', { ok: true, content: '迟到结论' });
  assert.equal(service.get(second.id).status, 'cancelled');
});

test('已结束的经理仍保留父子取消关系，覆盖运行中与排队的孙任务', () => {
  const { service, queue } = fixture();
  const manager = service.submit(request(), context()).task;
  start(service, manager);
  const child = service.submit(request({ panelId: 'child', requestId: 'child' }), context({ panelId: 'worker', taskId: manager.id, runId: 'worker-run' })).task;
  const childCtrl = start(service, child, 'child-run');
  const grandchild = service.submit(request({ panelId: 'grandchild', requestId: 'grandchild' }), context({ panelId: 'child', taskId: child.id, runId: 'child-run' })).task;
  service.finish(manager.id, 'worker-run', { ok: true });
  service.cancelRun('owner-run');
  assert.equal(service.get(manager.id).status, 'completed');
  assert.equal(childCtrl.signal.aborted, true);
  assert.equal(service.get(grandchild.id).status, 'cancelled');
  assert.equal(queue.size, 0);
});

test('父任务结束或冒用父 runId 时拒绝新增子任务', () => {
  const { service } = fixture();
  const parent = service.submit(request(), context()).task;
  start(service, parent);
  const childRequest = request({ panelId: 'child', requestId: 'child' });
  assert.equal(service.submit(childRequest, context({ panelId: 'worker', taskId: parent.id, runId: 'wrong' })).ok, false);
  service.finish(parent.id, 'worker-run', { ok: true });
  assert.equal(service.submit(childRequest, context({ panelId: 'worker', taskId: parent.id, runId: 'worker-run' })).ok, false);
});

test('目标失效记为失败；任务日志写失败不会派出任务', () => {
  const { service, adapter, queue } = fixture();
  adapter.enqueue = () => { throw Error('目标面板关闭'); };
  const result = service.submit(request(), context());
  assert.equal(result.ok, false);
  assert.equal(result.task.status, 'failed');
  assert.match(result.error, /关闭/);
  assert.equal(queue.size, 0);
  const broken = fixture();
  const blocked = path.dirname(journalFile(broken.root));
  fs.mkdirSync(path.dirname(blocked), { recursive: true });
  fs.writeFileSync(blocked, '阻止创建日志目录');
  assert.throws(() => broken.service.submit(request(), context()));
  assert.equal(broken.queue.size, 0);
});

test('取消时即使队列存盘失败，也中止当前执行；结果不会伪装为成功', () => {
  const { service, adapter } = fixture();
  const task = service.submit(request(), context()).task;
  const ctrl = start(service, task);
  adapter.remove = () => { throw Error('队列写失败'); };
  assert.throws(() => service.cancel(task.id), /队列写失败/);
  assert.equal(ctrl.signal.aborted, true);
  service.finish(task.id, 'worker-run', { ok: true });
  assert.equal(service.get(task.id).status, 'cancelled');
});

test('损坏日志明确报错并保留文件；工作区请求编号互相隔离', () => {
  const bad = fixture();
  const file = journalFile(bad.root);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{broken');
  assert.throws(() => bad.service.recover());
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  const a = fixture(), b = fixture();
  let currentRoot = a.root;
  const service = new TaskService(() => currentRoot, a.adapter);
  const first = service.submit(request(), context()).task;
  currentRoot = b.root;
  assert.equal(service.get(first.id), undefined);
  assert.equal(service.begin(first.id, 'wrong-workspace', new AbortController()), false);
  const second = service.submit(request(), context()).task;
  assert.notEqual(first.id, second.id);
});

test('会话成功与文件交付、用户验收分别记录；缺失文件拒绝部分交付', () => {
  const { service, root } = fixture();
  const task = service.submit(request({ correlationId: 'ticket' }), context()).task;
  start(service, task);
  fs.writeFileSync(path.join(root, 'a.txt'), '结果');
  assert.throws(() => service.delivered('ticket', 'worker', ['a.txt', 'missing.txt']), /不完整/);
  assert.equal(service.get(task.id).delivery, undefined);
  assert.equal(service.accept(task.id, 'owner').ok, false);
  service.finish(task.id, 'worker-run', { ok: true, content: '结论', tokens: 123 });
  assert.equal(service.accept(task.id, 'owner').ok, false);
  service.delivered('ticket', 'worker', ['a.txt']);
  assert.equal(service.get(task.id).acceptance, undefined);
  assert.equal(service.accept(task.id, 'worker').ok, false);
  assert.equal(service.accept(task.id, 'owner', '检查通过').ok, true);
  assert.equal(service.get(task.id).tokens, 123);
  assert.equal(service.get(task.id).acceptance.note, '检查通过');
});

test('未结束的后代阻止根任务验收；无关面板不可查看或取消', () => {
  const { service } = fixture();
  const parent = service.submit(request(), context()).task;
  start(service, parent);
  const child = service.submit(request({ panelId: 'child', requestId: 'child' }), context({ panelId: 'worker', taskId: parent.id, runId: 'worker-run' })).task;
  service.finish(parent.id, 'worker-run', { ok: true });
  assert.equal(service.accept(parent.id, 'owner').ok, false);
  assert.equal(service.get(child.id, 'stranger'), undefined);
  assert.equal(service.cancel(child.id, 'stranger').ok, false);
  start(service, child, 'child-run'); service.finish(child.id, 'child-run', { ok: true });
  assert.equal(service.accept(parent.id, 'owner').ok, true);
});

test('分身立即入队并继承模型与工具，跨轮重试不新建面板', () => {
  const { root, service, queue } = fixture();
  let handler, created = 0;
  require('../plugins/subagent').setup({
    workspace: root, tasks: service, addTool: (_spec, fn) => { handler = fn; },
    createPanel: (partial) => { created++; return { ...partial, id: 'child' }; },
    tools: () => [{ name: 'read_file' }, { name: 'subagent_run' }, { name: 'dispatch' }, { name: 'task_status' }],
    patchPanel: (_id, patch) => assert.deepEqual(patch.tools, ['read_file', 'task_status']),
    modelPick: () => 'provider::model', setModel: (_id, pick) => assert.equal(pick, 'provider::model'),
    closePanel() { throw Error('不应关闭已登记面板'); },
  });
  const args = { title: '分身', task: '具体任务', requestId: 'stable' };
  const result = JSON.parse(handler(args, context()));
  assert.equal(result.status, 'queued'); assert.equal(created, 1); assert.equal(queue.size, 1);
  queue.clear();
  const again = JSON.parse(handler(args, context({ runId: 'new-run' })));
  assert.equal(again.taskId, result.taskId); assert.equal(created, 1); assert.equal(queue.size, 1);
  assert.equal(JSON.parse(handler({ ...args, task: '其他任务' }, context())).ok, false);
});

test('真实派单插件：忙时入队、令牌去重、交付不串单、撤单取消执行', async () => {
  const { root, service, queue } = fixture();
  const plugin = require('../plugins/dispatch');
  registerProjectStorage('dispatch', plugin.storage?.project || []);
  const dataPath = rel => runtimePath(rel, root);
  const put = (rel, data) => { const file = dataPath(rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
  put('.ensoul/state/dispatch.json', { companies: [{ id: 'co', name: '公司' }], depts: [{ name: '开发', company: 'co', manager: 'mgr', members: ['emp'] }] });
  for (const [id, name, role] of [['mgr', '经理', 'manager'], ['emp', '开发员', 'member']]) put('.ensoul/state/agents/' + id + '.json', { id, name, role, dept: '开发', panel: id, model: 'p::m', kits: role === 'manager' ? ['router'] : ['dev'] });
  const panels = [{ id: 'owner', title: '发起人' }, { id: 'mgr', title: '经理' }, { id: 'emp', title: '开发员' }];
  const handlers = new Map(), prompts = [];
  let images = 0;
  const api = {
    workspace: root, dataPath, tasks: service, panels: () => panels, log() {},
    addTool: (spec, fn) => handlers.set(spec.name, fn), addPrompt: (fn) => prompts.push(fn),
    onAfterTool() {}, addCommand() {}, addSettingsSection() {},
    patchPanel: (id, patch) => Object.assign(panels.find((p) => p.id === id), patch),
    models: () => [], live: { image() { images++; } },
  };
  let commandSeq = Date.now() * 1000;
  const command = async (cmd, token, done) => {
    put('.ensoul/state/dispatch.cmd.json', { cmds: [{ cmd, token, panelId: 'owner', seq: ++commandSeq }] });
    for (let i = 0; i < 50 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(done(), true, cmd + ' 没有更新真实任务');
  };
  try {
    plugin.setup(api);
    assert.ok(panels.find((p) => p.id === 'mgr').tools.includes('task_status'));
    const dispatch = handlers.get('dispatch');
    const first = JSON.parse(await dispatch({ emp: '开发员', task: '制作文件', requestId: 'stable' }, context()));
    const inboxFile = dataPath('.ensoul/state/dispatch.inbox.json');
    const readInbox = () => JSON.parse(fs.readFileSync(inboxFile)).entries;
    const gap = readInbox(); gap[0].holder = ''; gap[0].taskId = '';
    put('.ensoul/state/dispatch.inbox.json', { entries: gap });
    plugin.dispose(); plugin.setup(api);
    assert.equal(readInbox()[0].holder, 'emp'); assert.equal(readInbox()[0].taskId, first.taskId);
    const again = JSON.parse(await dispatch({ emp: '开发员', task: '制作文件', requestId: 'stable' }, context({ runId: 'another' })));
    assert.equal(first.status, 'queued'); assert.equal(first.taskId, again.taskId); assert.equal(queue.size, 1);
    await assert.rejects(dispatch({ emp: '经理', task: '变更任务', requestId: 'stable' }, context()), /另一份派单/);
    const second = JSON.parse(await dispatch({ emp: '开发员', task: '另一任务', requestId: 'other' }, context()));
    const workerContext = context({ panelId: 'emp', taskId: first.taskId, runId: 'work' });
    const ctrl = start(service, { id: first.taskId }, 'work');
    const prompt = prompts.map((fn) => fn(workerContext)).join('\n');
    assert.ok(prompt.includes(first.token)); assert.ok(!prompt.includes(second.token));
    fs.writeFileSync(path.join(root, 'result.png'), 'fixture');
    const deliver = handlers.get('deliver_result');
    const wrong = await deliver({ token: second.token, files: ['result.png'] }, workerContext);
    assert.match(wrong, /不匹配/);
    const partial = await deliver({ files: ['result.png', 'missing'] }, workerContext);
    assert.match(partial, /不完整/); assert.equal(images, 0);
    assert.equal(service.get(first.taskId).delivery, undefined);
    await deliver({ files: ['result.png'] }, workerContext);
    await deliver({ token: first.token, files: ['result.png'] }, workerContext);
    assert.equal(images, 1); assert.equal(service.get(first.taskId).acceptance, undefined);
    service.finish(first.taskId, 'work', { ok: true });
    assert.equal(ctrl.signal.aborted, false);
    await command('acceptTicket', first.token, () => Boolean(service.get(first.taskId).acceptance));
    assert.equal(readInbox().find((ticket) => ticket.token === first.token).status, 'accepted');
    await command('rejectTicket', first.token, () => readInbox().find((ticket) => ticket.token === first.token).taskId !== first.taskId);
    const rework = readInbox().find((ticket) => ticket.token === first.token).taskId;
    assert.equal(service.get(rework).status, 'queued');
    assert.equal(service.get(rework).acceptance, undefined);
    await command('cancelTicket', first.token, () => service.get(rework).status === 'cancelled');
    await command('restoreTicket', first.token, () => JSON.parse(fs.readFileSync(dataPath('.ensoul/state/dispatch.cmd.json'))).cmds.length === 0);
    assert.equal(service.get(rework).status, 'cancelled');
    const secondCtrl = start(service, { id: second.taskId }, 'second-work');
    await handlers.get('dispatch_cancel')({ token: second.token }, context());
    assert.equal(secondCtrl.signal.aborted, true);
    service.finish(second.taskId, 'second-work', { ok: true });
    assert.equal(service.get(second.taskId).status, 'cancelled');
    const manager1 = JSON.parse(await dispatch({ emp: '经理', task: '第一件经理任务', requestId: 'mgr1' }, context()));
    const manager2 = JSON.parse(await dispatch({ emp: '经理', task: '第二件经理任务', requestId: 'mgr2' }, context()));
    start(service, { id: manager1.taskId }, 'manager-run');
    const managerContext = context({ panelId: 'mgr', taskId: manager1.taskId, runId: 'manager-run' });
    const forwarded = JSON.parse(await dispatch({ emp: '开发员', task: '第一件员工任务' }, managerContext));
    assert.equal(forwarded.token, manager1.token); assert.notEqual(forwarded.token, manager2.token);
    assert.equal(service.get(forwarded.taskId).parentTaskId, manager1.taskId);
    const retried = JSON.parse(await dispatch({ emp: '开发员', task: '第一件员工任务' }, managerContext));
    assert.equal(retried.taskId, forwarded.taskId);
    service.finish(manager1.taskId, 'manager-run', { ok: true });
    service.cancel(manager1.taskId, 'owner');
    assert.equal(service.get(forwarded.taskId).status, 'cancelled');
  } finally { plugin.dispose(); }
});
