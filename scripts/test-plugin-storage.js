const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-plugin-storage-'));
const data = path.join(temp, 'data');
const first = path.join(temp, 'first');
const second = path.join(temp, 'second');
for (const directory of [data, first, second]) fs.mkdirSync(directory);

function loadPlugin(name) {
  const filename = path.resolve(__dirname, '..', 'plugins', name, 'index.js');
  const timers = [];
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, require: createRequire(filename),
    __dirname: path.dirname(filename), __filename: filename, process,
    t: text => text, console, Buffer,
    setInterval: (callback, delay) => { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; },
    clearInterval() {}, setTimeout: () => ({ unref() {} }), clearTimeout() {},
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { plugin: module.exports, timers, evaluate: expression => vm.runInContext(expression, context) };
}

function host(workspace, panels) {
  const summaries = [];
  return {
    workspace, summaries,
    dataPath: relative => path.join(data, relative),
    panels: () => panels,
    param: (name, fallback) => fallback,
    patchPanel: (id, patch) => Object.assign(panels.find(panel => panel.id === id), patch),
    addPrompt() {}, addCommand() {}, addTool() {}, addSummaryNote: note => summaries.push(note),
    log() {}, refresh() {},
  };
}

let failures = 0;
function test(name, run) {
  try { run(); console.log('PASS ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.stack); }
}

test('histconv persists and reopens the same panel history after switching workspace', () => {
  const panel = { id: 'history-panel', chat: [{ id: 'message', role: 'user', content: 'remember this', createdAt: Date.now() }], status: 'idle' };
  const one = loadPlugin('histconv');
  one.plugin.setup(host(first, [panel]));
  one.plugin.dispose();
  const file = path.join(data, '.ensoul/state/histconv/history-panel.json');
  assert.ok(fs.existsSync(file), 'history must be saved in the fixed data root');
  const entry = JSON.parse(fs.readFileSync(file, 'utf8')).entries[0];
  const command = path.join(data, '.ensoul/state/histconv.cmd.json');
  fs.writeFileSync(command, JSON.stringify({ cmds: [{ seq: 1, kind: 'jump', pid: panel.id, key: entry.key }] }));
  const next = { ...panel, chat: [] };
  const two = loadPlugin('histconv');
  two.plugin.setup(host(second, [next]));
  two.plugin.dispose();
  assert.equal(next.chat[0]?.content, 'remember this', 'the second workspace must restore history through the same command channel');
  assert.ok(!fs.existsSync(path.join(first, '.ensoul')));
  assert.ok(!fs.existsSync(path.join(second, '.ensoul')));
});

test('notes are available to the same panel in another workspace', () => {
  const panel = { id: 'notes-panel', chat: [
    { id: 'user', role: 'user', content: 'keep this decision', createdAt: Date.now() },
    { id: 'assistant', role: 'assistant', content: '==personal note==', createdAt: Date.now() },
  ] };
  const one = loadPlugin('notes');
  one.plugin.setup(host(first, [panel]));
  one.plugin.dispose();
  assert.ok(fs.existsSync(path.join(data, '.ensoul/state/notes/notes-panel.json')), 'notes must be saved in the fixed data root');
  const api = host(second, [{ ...panel, chat: [] }]);
  const two = loadPlugin('notes');
  two.plugin.setup(api);
  two.plugin.dispose();
  assert.ok(api.summaries.some(summary => summary({ panelId: panel.id }).includes('personal note')));
});

test('dispatch copies only employee case files into personal storage and keeps the original', () => {
  const original = path.join(first, 'work', 'employee', '成功案例.json');
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.writeFileSync(original, JSON.stringify([{ at: 1, work: 'task', how: 'recipe' }]));
  const dispatch = loadPlugin('dispatch');
  const read = dispatch.evaluate('readCases');
  assert.equal(read(host(first, []), 'employee')[0]?.how, 'recipe');
  assert.ok(fs.existsSync(path.join(data, '.ensoul/state/cases/employee/成功案例.json')));
  assert.ok(fs.existsSync(original));
  assert.equal(read(host(second, []), 'employee')[0]?.how, 'recipe');
});

test('dispatch keeps both originals when another project has different employee cases', () => {
  const source = path.join(second, 'work', 'employee', '成功案例.json');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const text = JSON.stringify([{ at: 2, work: 'different task', how: 'different recipe' }]);
  fs.writeFileSync(source, text);
  const dispatch = loadPlugin('dispatch');
  assert.equal(dispatch.evaluate('readCases')(host(second, []), 'employee')[0]?.how, 'recipe');
  assert.equal(fs.readFileSync(source, 'utf8'), text);
  const reportDirectory = path.join(data, '.ensoul/migrations/dispatch-cases');
  const reports = fs.readdirSync(reportDirectory).map(name => JSON.parse(fs.readFileSync(path.join(reportDirectory, name), 'utf8')));
  assert.ok(reports.some(report => report.records[source]?.status === 'conflict'));
});

test('MCP global server definitions are not copied into project definitions', () => {
  const mcp = loadPlugin('mcp');
  const library = require('../plugins/mcp/library');
  const originalUserFile = library.userMcpFile;
  const userFile = path.join(data, 'user-mcp.json');
  library.userMcpFile = () => userFile;
  try {
    fs.writeFileSync(userFile, JSON.stringify({ servers: [{ name: 'personal', command: 'node', enabled: false }] }));
    const projectFile = path.join(first, '.ensoul/mcp/servers.json');
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    const projectText = JSON.stringify({ servers: [{ name: 'project-only', command: 'node', enabled: false }] });
    fs.writeFileSync(projectFile, projectText);
    let saved = { servers: [], ecosystem: { skillSources: [{ id: 'mine', repo: 'owner/repo' }] } };
    const api = { ...host(first, []), state: { load: () => saved, save: value => { saved = value; } } };
    const load = mcp.evaluate('loadState');
    const save = mcp.evaluate('saveState');
    const state = load(api);
    assert.ok(state.servers.some(server => server.name === 'personal'));
    assert.ok(state.servers.some(server => server.name === 'project-only'), 'explicit project definitions must still apply');
    save(api, state);
    assert.equal(fs.readFileSync(projectFile, 'utf8'), projectText);
    assert.equal(saved.ecosystem.skillSources[0].id, 'mine', 'personal source settings must survive normalization');
    const next = load({ ...api, workspace: second });
    assert.ok(!next.servers.some(server => server.name === 'project-only'), 'project definitions cannot follow the user into another project');
  } finally { library.userMcpFile = originalUserFile; }
});

if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('temporary directory escaped');
fs.rmSync(temp, { recursive: true, force: true });
if (failures) process.exitCode = 1;
