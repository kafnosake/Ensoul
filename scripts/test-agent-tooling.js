const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-tooling-'));
process.env.ENSOUL_WORKSPACE = box;
globalThis.t = (text) => text;
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: {
  app: { getAppPath: () => root, getPath: () => path.join(box, 'userData'), getVersion: () => 'test' },
  ipcMain: { handle() {}, on() {} }, BrowserWindow: class {}, dialog: {}, shell: {},
} };
const { runTool, setExtensions, archiveToolResult } = require('../dist/main/agent');
const { conversationForSummary } = require('../dist/main/chat-core');
const { recordPromptDelta, consumePromptDeltas, commitPromptBaseline } = require('../dist/main/prompt-composer');
const code = require('../plugins/code-intelligence');

test.after(() => {
  assert.equal(path.dirname(path.resolve(box)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(box).startsWith('ensoul-tooling-'));
  fs.rmSync(box, { recursive: true, force: true });
});

function fixture(name) {
  const workspace = path.join(box, name);
  fs.mkdirSync(workspace, { recursive: true });
  const tools = {}, prompts = [], summaries = [];
  let state = null;
  let saveOk = true;
  code.setup({
    workspace, addTool: (spec, handler) => { tools[spec.name] = handler; },
    addPrompt: (handler) => prompts.push(handler), addSummaryNote: (handler) => summaries.push(handler),
    state: { load: (fallback) => state === null ? fallback : structuredClone(state),
      save: (value) => { if (!saveOk) return false; state = structuredClone(value); return true; } },
  });
  const put = (file, content) => {
    const target = path.join(workspace, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  return { workspace, tools, prompts, summaries, put, state: () => state, failSave: () => { saveOk = false; } };
}

test('符号切片不会被字符串、注释和模板中的括号截断', () => {
  const f = fixture('slice');
  f.put('a.ts', [
    'function target() {', '  const a = "}";', '  // }',
    '  const b = `value: ${a}`;', '  const c = /}/;',
    '  const after = 42;', '  return after;', '}',
  ].join('\n'));
  const result = f.tools.code_slice({ path: 'a.ts', symbol: 'target' });
  assert.match(result, /return after/);
  assert.match(result, /8: }/);
});

test('符号名称精确匹配，箭头函数也使用声明范围', () => {
  const f = fixture('exact-symbol');
  f.put('a.ts', 'function targetExtra() {\n' + '  const unrelated = 1;\n'.repeat(8)
    + '}\n\nexport const target = () => {\n  return "EXACT_MARKER";\n};\n');
  const result = f.tools.code_slice({ path: 'a.ts', symbol: 'target' });
  assert.match(result, /EXACT_MARKER/);
  assert.doesNotMatch(result, /unrelated/);
});

test('超预算符号与无法解析的文件明确报告边界', () => {
  const f = fixture('slice-budget');
  f.put('large.ts', 'function target() {\n' + '  doWork();\n'.repeat(240) + '}\n');
  assert.match(f.tools.code_slice({ path: 'large.ts', symbol: 'target' }), /完整范围.*当前仅显示/);
  f.put('bad.ts', 'function target() { const broken = ; }');
  assert.match(f.tools.code_slice({ path: 'bad.ts', symbol: 'target' }), /不能确认完整符号范围/);
});

function git(workspace, ...args) {
  return execFileSync('git', ['-c', 'user.name=Tooling Test', '-c', 'user.email=tooling@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd: workspace, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

test('审查覆盖未跟踪文件，字符串中的 debugger 不产生阻断', () => {
  const f = fixture('review-untracked');
  git(f.workspace, 'init', '--quiet');
  f.put('new tool.ts', 'const text = "debugger";\ndebugger;\n');
  const result = f.tools.review_changes({ files: ['new tool.ts'] });
  assert.match(result, /new tool.ts:2/);
  assert.match(result, /no-debugger/);
  assert.doesNotMatch(result, /代码质量符合安全标准/);
  f.put('new tool.ts', 'const text = "debugger";\n');
  assert.doesNotMatch(f.tools.review_changes({ files: ['new tool.ts'] }), /发现调试断点/);
});

test('审查覆盖首次提交前的暂存区及单行变更', () => {
  const f = fixture('review-staged');
  git(f.workspace, 'init', '--quiet');
  f.put('a.ts', 'debugger;\n');
  git(f.workspace, 'add', '--', 'a.ts');
  assert.match(f.tools.review_changes({ files: ['a.ts'] }), /a.ts:1/);
  f.put('a.ts', 'const value = 1;\n');
  git(f.workspace, 'add', '--', 'a.ts');
  git(f.workspace, 'commit', '--quiet', '-m', 'fixture');
  f.put('a.ts', 'const value = 1;\ndebugger;\n');
  assert.match(f.tools.review_changes({ files: ['a.ts'] }), /a.ts:2/);
});

test('空范围、二进制文件与 Git 失败均不会被报告为通过', () => {
  const f = fixture('review-empty');
  git(f.workspace, 'init', '--quiet');
  const empty = f.tools.review_changes({ files: ['missing.ts'] });
  assert.match(empty, /没有待检查变更/);
  assert.doesNotMatch(empty, /FAILED|符合安全标准/);
  f.put('binary.dat', Buffer.from([1, 0, 2]));
  assert.match(f.tools.review_changes({}), /未扫描/);
  const outsideGit = fixture('not-git');
  assert.match(outsideGit.tools.review_changes({}), /检查失败/);
});

test('审查参数作为独立 argv，特殊字符不经过 shell', () => {
  const module = { exports: {} }, calls = [], tools = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'plugins/code-intelligence/index.js'), 'utf8'), {
    module, exports: module.exports, require: (name) => name === 'child_process' ? {
      execFileSync: (file, args, options) => { calls.push({ file, args, options }); return args.includes('--verify') ? 'head' : ''; },
    } : require(name), Buffer,
  });
  module.exports.setup({ workspace: box, addTool: (spec, handler) => { tools[spec.name] = handler; },
    addPrompt() {}, addSummaryNote() {}, state: { load: () => null, save: () => true } });
  const file = 'x" & echo INJECTION & "';
  tools.review_changes({ files: [file] });
  const diff = calls.find((call) => call.args.includes('diff'));
  assert.equal(diff.file, 'git');
  assert.equal(diff.options.shell, undefined);
  assert.equal(diff.args[diff.args.indexOf('--') + 1], file);
  assert.ok(diff.args.includes('--literal-pathspecs'));
});

test('账本按面板与任务隔离，假设可更新并进入压缩快照', () => {
  const f = fixture('ledger');
  const ctx = { panelId: 'A', taskId: 'one' };
  f.tools.investigation_record({ hypothesis: 'HYPOTHESIS_A', status: 'testing', evidence: 'old' }, ctx);
  assert.equal(f.prompts[0]({ panelId: 'B', taskId: 'one' }), '');
  assert.equal(f.prompts[0]({ panelId: 'A', taskId: 'two' }), '');
  assert.match(f.prompts[0](ctx), /待验证假设/);
  assert.doesNotMatch(f.prompts[0](ctx), /禁止反向推翻|已锁定事实/);
  f.tools.investigation_record({ hypothesis: 'HYPOTHESIS_A', status: 'refuted', evidence: 'new', next_step: 'CHECK_B' }, ctx);
  assert.equal(f.state().panels.A['task:one'].length, 1);
  assert.match(f.summaries[0](ctx), /new.*CHECK_B/);
});

test('旧无归属账本保留但不注入；保存失败及取消不宣称成功', () => {
  const f = fixture('legacy-ledger');
  f.put('.ensoul/state/investigation.json', JSON.stringify([{ hypothesis: 'LEGACY_UNKNOWN_OWNER' }]));
  assert.equal(f.prompts[0]({ panelId: 'A' }), '');
  f.tools.investigation_record({ hypothesis: 'new', status: 'confirmed', evidence: 'fact' }, { panelId: 'A' });
  assert.equal(f.state().legacyRecords[0].hypothesis, 'LEGACY_UNKNOWN_OWNER');
  f.failSave();
  assert.match(f.tools.investigation_record({ hypothesis: 'failed', status: 'testing', evidence: 'fact' }, { panelId: 'A' }), /未保存/);
  const ctrl = new AbortController(); ctrl.abort(Error('STOP_MARKER'));
  assert.throws(() => f.tools.investigation_record({ hypothesis: 'stopped', status: 'testing', evidence: 'fact' },
    { panelId: 'A', signal: ctrl.signal }), /STOP_MARKER/);
});

test('工作区规则在第二轮、修改后与新插件实例中完整提供', () => {
  const f = fixture('rules');
  const agents = require('../plugins/agents-md');
  const mount = () => {
    let prompt;
    agents.setup({ workspace: f.workspace, addPrompt: (fn) => { prompt = fn; },
      panels: () => [{ id: 'p' }, { id: 'worker', noWorkspacePrompt: true }], log() {} });
    return prompt;
  };
  f.put('AGENTS.md', 'RULE_ORIGINAL_SENTINEL');
  const prompt = mount();
  assert.match(prompt({ panelId: 'p' }), /RULE_ORIGINAL_SENTINEL/);
  assert.match(prompt({ panelId: 'p' }), /RULE_ORIGINAL_SENTINEL/);
  assert.equal(prompt({ panelId: 'worker' }), '');
  f.put('AGENTS.md', 'RULE_UPDATED_SENTINEL_LONGER');
  assert.match(prompt({ panelId: 'p' }), /RULE_UPDATED_SENTINEL/);
  assert.match(prompt({ panelId: 'p' }), /RULE_UPDATED_SENTINEL/);
  assert.match(mount()({ panelId: 'p' }), /RULE_UPDATED_SENTINEL/);
  fs.unlinkSync(path.join(f.workspace, 'AGENTS.md'));
  assert.equal(prompt({ panelId: 'p' }), '');
});

test('热提示跨轮保留最新规则，可恢复旧基底，压缩后固化', () => {
  const panel = { spec: { systemPrompt: 'BASE_RULE' }, chat: [{ role: 'user', content: 'task' }] };
  recordPromptDelta(panel, 'LATEST_RULE');
  assert.match(consumePromptDeltas(panel), /LATEST_RULE/);
  assert.match(consumePromptDeltas(panel), /LATEST_RULE/);
  assert.equal(recordPromptDelta(panel, 'LATEST_RULE').changed, false);
  assert.equal(recordPromptDelta(panel, 'BASE_RULE').changed, true);
  assert.match(consumePromptDeltas(panel), /BASE_RULE/);
  recordPromptDelta(panel, 'FINAL_RULE');
  commitPromptBaseline(panel);
  assert.equal(panel.spec.systemPrompt, 'FINAL_RULE');
  assert.equal(consumePromptDeltas(panel), '');
});

function probeFixture() {
  const module = { exports: {} }, processMock = new EventEmitter(), consoleMock = { error() {} };
  const tools = {}, hooks = [], commands = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, 'plugins/runtime-probe/index.js'), 'utf8'), {
    module, exports: module.exports, require, process: processMock, console: consoleMock, Error,
  });
  const api = { addTool: (spec, handler) => { tools[spec.name] = handler; }, onAfterTool: (fn) => hooks.push(fn),
    addCommand: (_spec, fn) => commands.push(fn), log() {} };
  return { plugin: module.exports, api, tools, hooks, commands, processMock, consoleMock };
}

test('探针读取真实结果契约和关联 ID，不把无记录宣称为健康', () => {
  const f = probeFixture(); f.plugin.setup(f.api);
  try {
    assert.doesNotMatch(f.tools.probe_runtime_errors({}), /运行现场健康/);
    f.hooks[0]({ name: 'edit', result: '工具执行失败：ERROR_MARKER', status: 'error', durationMs: 12,
      ctx: { panelId: 'p', runId: 'run', taskId: 'task' }, toolCallId: 'call' });
    assert.match(f.tools.probe_runtime_errors({ type: 'tool_failure' }), /ERROR_MARKER/);
    const event = JSON.parse(f.commands[0]())[0];
    assert.equal(event.panelId, 'p'); assert.equal(event.runId, 'run');
    assert.equal(event.taskId, 'task'); assert.equal(event.toolCallId, 'call');
    assert.equal(event.durationMs, 12);
    f.hooks[0]({ name: 'run_command', result: 'bad\n（退出码 7）', ctx: { panelId: 'p' } });
    assert.equal(JSON.parse(f.commands[0]()).length, 2);
  } finally { f.plugin.dispose(); }
});

test('探针卸载清除监听，重挂不会重复记录或破坏其他 console 包装', () => {
  const f = probeFixture(), original = f.consoleMock.error;
  for (let i = 0; i < 2; i += 1) {
    f.plugin.setup(f.api);
    assert.equal(f.processMock.listenerCount('uncaughtException'), 1);
    assert.equal(f.processMock.listenerCount('unhandledRejection'), 1);
    f.processMock.emit('unhandledRejection', Error('event'));
    f.plugin.dispose();
    assert.equal(f.processMock.listenerCount('uncaughtException'), 0);
    assert.equal(f.processMock.listenerCount('unhandledRejection'), 0);
    assert.equal(f.consoleMock.error, original);
  }
  f.plugin.setup(f.api);
  const previous = f.consoleMock.error;
  const other = (...args) => previous(...args);
  f.consoleMock.error = other;
  f.plugin.dispose();
  assert.equal(f.consoleMock.error, other);
  assert.doesNotThrow(() => f.consoleMock.error('Error after dispose'));
});

test('完整命令输出和退出码保留在产物中，失败终态与耗时进入钩子', async () => {
  const seen = [];
  setExtensions({ tools: [], beforeTool: [], afterTool: [(done) => { seen.push(done); }], fileWrite: [] });
  const command = `"${process.execPath}" -e "process.stdout.write('A'.repeat(10000)+'MIDDLE_EVIDENCE'+'B'.repeat(20000)+'TAIL_EVIDENCE');process.exitCode=7"`;
  const result = await runTool('run_command', { command }, { panelId: 'p', host: 'main', kind: 'chat', runId: 'r' });
  assert.equal(seen[0].status, 'error');
  assert.ok(seen[0].durationMs >= 0);
  assert.match(seen[0].result, /MIDDLE_EVIDENCE/);
  const reference = result.match(/已存到 ([^；\n]+)/)?.[1];
  assert.ok(reference);
  assert.ok(result.indexOf(reference) < 800);
  const full = fs.readFileSync(path.join(box, reference), 'utf8');
  assert.match(full, /MIDDLE_EVIDENCE/);
  assert.match(full, /TAIL_EVIDENCE/);
  assert.match(full, /退出码 7/);
});

test('跨轮历史和压缩摘要保留工具证据及完整输出引用', () => {
  const original = 'X'.repeat(1600) + 'HISTORY_MIDDLE_EVIDENCE' + 'Y'.repeat(1600);
  const stored = archiveToolResult('grep', original, { panelId: 'p', host: 'main', kind: 'chat' });
  const reference = stored.match(/已存到 ([^；\n]+)/)?.[1];
  assert.ok(reference);
  assert.match(fs.readFileSync(path.join(box, reference), 'utf8'), /HISTORY_MIDDLE_EVIDENCE/);
  const summaryInput = conversationForSummary([{ id: 'm', role: 'assistant', content: '结论', createdAt: 1,
    toolCalls: [{ id: 'call', name: 'grep', args: '{"pattern":"needle"}', result: stored }] }]);
  assert.match(summaryInput, /工具 grep/);
  assert.match(summaryInput, /needle/);
  assert.ok(summaryInput.includes(reference));
});
