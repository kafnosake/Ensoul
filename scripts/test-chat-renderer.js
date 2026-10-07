const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const electronName = process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
  : process.platform === 'win32' ? 'electron.exe' : 'electron';
const electron = path.join(root, '.electron', `${process.platform}-${process.arch}`, electronName);
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-chat-renderer-'));
const firstText = '# 流式标题\n\n正在检查 **初步定位**。\n\n| 项目 | 状态 |\n| --- | --- |\n| 文字流 | 已分层 |\n\n```js\nconst first = 1;\nconst second = 2;';
const finalText = '# 最终结论\n\n**最终答案** 已完成。';

const mock = `
(() => {
  const listeners = new Map();
  const on = (event, cb) => {
    const callbacks = listeners.get(event) || new Set();
    callbacks.add(cb); listeners.set(event, callbacks);
    return () => callbacks.delete(cb);
  };
  const emit = (event, value) => {
    for (const cb of [...(listeners.get(event) || [])]) cb(value);
  };
  const subscribe = event => cb => on(event, cb);
  window.__fixtureErrors = [];
  window.addEventListener('error', event => window.__fixtureErrors.push(event.message));
  window.addEventListener('unhandledrejection', event => window.__fixtureErrors.push(String(event.reason)));
  window.__fixturePanel = {
    id: 'renderer-fixture', kind: 'chat', title: '流式验收',
    status: 'working', look: {}, spec: { body: 'messages', text: '', actions: [], fields: [] },
    revisions: [], redoRevisions: [], outbox: [],
    chat: [{ id: 'user-1', role: 'user', content: '请逐步检查并给出结论。', createdAt: 1000 }],
  };
  const workspace = {
    panels: { 'renderer-fixture': window.__fixturePanel }, models: {}, status: {}, commands: [],
  };
  window.__fixtureBus = { on, emit };
  window.ensoul = {
    mode: 'main',
    workspace: { get: async () => workspace, onState: subscribe('workspace') },
    panel: { patch: async () => true, body: async () => window.__fixturePanel },
    fs: {
      read: async () => '',
      write: async () => { throw new Error('fixture must not write workspace files'); },
    },
    tasks: { list: async () => [], onChanged: subscribe('tasks') },
    ui: { onLang: subscribe('lang') },
    chat: {
      running: async () => [], liveState: async () => ({ tasks: [], images: [] }),
      askState: async () => ({ ask: null }), outbox: async () => ({ queue: [], steer: [] }),
      onDelta: subscribe('delta'), onProgress: subscribe('progress'), onRetract: subscribe('retract'),
      onRunning: subscribe('running'), onReasoning: subscribe('reasoning'), onMessage: subscribe('message'),
      onLive: subscribe('live'), onAsk: subscribe('ask'), onSteer: subscribe('steer'),
    },
  };
  localStorage.setItem('histconv.rail.renderer-fixture', '0');
  let sequence = 0;
  const payload = value => ({ panelId: 'renderer-fixture', id: 'assistant-turn', sequence: ++sequence, ...value });
  const firstText = ${JSON.stringify(firstText)};
  const answer = ${JSON.stringify(finalText)};
  const response1 = { id: 'response-1', content: firstText, afterMessageId: 'user-1', phase: 'progress', createdAt: 1100 };
  window.__fixtureStages = {
    stream() {
      emit('running', { panelId: 'renderer-fixture', running: true });
      emit('progress', payload({ responseId: 'response-1', reset: true, responses: [] }));
      emit('delta', payload({ responseId: 'response-1', offset: 0, delta: firstText }));
    },
    tool() {
      emit('progress', payload({ responseId: 'response-1', reset: true, responses: [response1] }));
      emit('message', { panelId: 'renderer-fixture', message: {
        id: 'tool-1', role: 'tool', content: '**读取 demo.ts**\\n\\n\`\`\`\\n工具结果\\n\`\`\`', createdAt: 1200,
      } });
      emit('progress', payload({ responseId: 'response-2', reset: true, responses: [response1] }));
      emit('delta', payload({ responseId: 'response-2', offset: 0, delta: answer }));
    },
    final() {
      const suffix = '\\n\\n补充结论。';
      // 故意让最后一片还在渲染节流队列里时落定，验证它不会变成重复尾巴。
      emit('delta', payload({ responseId: 'response-2', offset: answer.length, delta: suffix }));
      emit('message', { panelId: 'renderer-fixture', message: {
        id: 'assistant-turn', role: 'assistant', content: firstText + '\\n\\n' + answer + suffix,
        displayContent: answer + suffix, createdAt: 1300, streaming: false,
        responses: [response1, { id: 'response-2', content: answer + suffix, afterMessageId: 'tool-1', phase: 'answer' }],
      } });
      emit('running', { panelId: 'renderer-fixture', running: false });
    },
  };
})();
`;

const renderer = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { t } from ${JSON.stringify(path.join(root, 'src/shared/i18n.ts').replace(/\\/g, '/'))};
import { ChatDock } from ${JSON.stringify(path.join(root, 'src/renderer/panel/ChatDock.tsx').replace(/\\/g, '/'))};
import ${JSON.stringify(path.join(root, 'src/renderer/ui/styles.css').replace(/\\/g, '/'))};

function Fixture() {
  const [panel, setPanel] = React.useState(window.__fixturePanel);
  React.useEffect(() => {
    const off = window.__fixtureBus.on('message', event => {
      setPanel(previous => ({ ...previous, chat: [...previous.chat, event.message] }));
    });
    window.__fixtureReady = true;
    return off;
  }, []);
  return <ChatDock panel={panel} full />;
}
window.t = t;
createRoot(document.getElementById('root')).render(<Fixture />);
`;

function electronMain() {
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
app.setName('ensoul-chat-renderer-test');
app.setPath('userData', path.join(__dirname, 'userData'));
app.disableHardwareAcceleration();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const resultFile = path.join(__dirname, 'result.json');
let window;
let timeout;
async function run() {
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/.test(details.url) }));
  window = new BrowserWindow({
    width: 1180, height: 850, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: false, nodeIntegration: false },
  });
  window.webContents.on('console-message', (_event, _level, message) => console.log(message));
  window.webContents.on('render-process-gone', (_event, details) => { throw new Error('renderer gone: ' + details.reason); });
  await window.loadFile(path.join(__dirname, 'fixture.html'));
  const execute = script => window.webContents.executeJavaScript(script);
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await execute('Boolean(window.__fixtureReady)')) break;
    await delay(50);
  }
  assert.equal(await execute('Boolean(window.__fixtureReady)'), true, 'real ChatDock mounts');
  await delay(100);
  await execute('window.__fixtureStages.stream()');
  await delay(250);
  const streaming = await execute(`(() => {
    const body = document.querySelector('.live-write-body');
    const style = body && getComputedStyle(body);
    return {
      heading: body?.querySelector('h1')?.textContent,
      bold: body?.querySelector('strong')?.textContent,
      table: body?.querySelector('table')?.textContent,
      code: body?.querySelector('pre code')?.textContent,
      height: body?.getBoundingClientRect().height,
      display: style?.display, errors: window.__fixtureErrors,
    };
  })()`);
  assert.equal(streaming.heading, '流式标题');
  assert.equal(streaming.bold, '初步定位');
  assert.match(streaming.table, /文字流/);
  assert.equal(streaming.code, 'const first = 1;\nconst second = 2;');
  assert.ok(streaming.height > 0, 'streaming Markdown has visible layout');
  assert.deepEqual(streaming.errors, []);
  fs.writeFileSync(path.join(__dirname, 'streaming.png'), (await window.webContents.capturePage()).toPNG());

  await execute('window.__fixtureStages.tool()');
  await delay(250);
  const layered = await execute(`(() => {
    const progress = document.querySelector('[data-msg-id="response:response-1"]');
    const tool = document.querySelector('.tool-row');
    return {
      progressHeading: progress?.querySelector('h1')?.textContent,
      beforeTool: Boolean(progress && tool && (progress.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING)),
      currentHeading: document.querySelector('.live-write-body h1')?.textContent,
      count: document.querySelectorAll('[data-msg-id="response:response-1"]').length,
      errors: window.__fixtureErrors,
    };
  })()`);
  assert.equal(layered.progressHeading, '流式标题');
  assert.equal(layered.beforeTool, true, 'progress is before its tool');
  assert.equal(layered.currentHeading, '最终结论');
  assert.equal(layered.count, 1);
  assert.deepEqual(layered.errors, []);

  await execute('window.__fixtureStages.final()');
  await delay(350);
  const final = await execute(`(() => {
    const log = document.querySelector('.dock-log');
    const progress = document.querySelector('[data-msg-id="response:response-1"]');
    const tool = document.querySelector('.tool-row');
    const answer = document.querySelector('[data-msg-id="assistant-turn"]');
    return {
      progressCount: document.querySelectorAll('[data-msg-id="response:response-1"]').length,
      finalCount: document.querySelectorAll('[data-msg-id="assistant-turn"]').length,
      liveCount: document.querySelectorAll('.live-write').length,
      headings: [...log.querySelectorAll('h1')].map(node => node.textContent),
      finalBody: answer?.querySelector('.msg-body')?.textContent,
      suffixCount: (log.textContent.match(/补充结论。/g) || []).length,
      beforeTool: Boolean(progress && tool && (progress.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING)),
      beforeAnswer: Boolean(tool && answer && (tool.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING)),
      errors: window.__fixtureErrors,
    };
  })()`);
  assert.equal(final.progressCount, 1);
  assert.equal(final.finalCount, 1);
  assert.equal(final.liveCount, 0, 'final event clears the pending streaming tail');
  assert.deepEqual(final.headings, ['流式标题', '最终结论']);
  assert.match(final.finalBody, /最终答案/);
  assert.equal(final.suffixCount, 1);
  assert.equal(final.beforeTool, true);
  assert.equal(final.beforeAnswer, true);
  assert.deepEqual(final.errors, []);
  fs.writeFileSync(path.join(__dirname, 'final.png'), (await window.webContents.capturePage()).toPNG());
  fs.writeFileSync(resultFile, JSON.stringify({ ok: true, streaming, layered, final }, null, 2));
  clearTimeout(timeout);
  window.destroy();
  app.quit();
}
timeout = setTimeout(() => {
  fs.writeFileSync(resultFile, JSON.stringify({ ok: false, error: 'renderer test timed out' }));
  if (window && !window.isDestroyed()) window.destroy();
  process.exitCode = 1;
  app.quit();
}, 25000);
run().catch(async error => {
  const diagnostics = window && !window.isDestroyed()
    ? await window.webContents.executeJavaScript('({ errors: window.__fixtureErrors, html: document.getElementById("root")?.innerHTML })')
    : null;
  fs.writeFileSync(resultFile, JSON.stringify({ ok: false, error: error.stack || String(error), diagnostics }));
  clearTimeout(timeout);
  if (window && !window.isDestroyed()) window.destroy();
  process.exitCode = 1;
  app.quit();
});
}

async function run() {
  assert.ok(fs.existsSync(electron), 'isolated Electron runtime exists');
  await esbuild.build({
    stdin: { contents: renderer, resolveDir: root, sourcefile: 'chat-renderer-fixture.tsx', loader: 'tsx' },
    bundle: true, platform: 'browser', format: 'iife', target: 'chrome130',
    outfile: path.join(box, 'bundle.js'), loader: { '.svg': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent',
  });
  fs.writeFileSync(path.join(box, 'main.cjs'), `(${electronMain.toString()})();`);
  fs.writeFileSync(path.join(box, 'fixture.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none';">
    <link rel="stylesheet" href="bundle.css"><style>html,body,#root{height:100%;margin:0;}#root{display:flex;flex-direction:column;}.chatdock.is-full{height:100%;}</style>
    </head><body><div id="root"></div><script>${mock}</script><script src="bundle.js"></script></body></html>`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path.join(box, 'main.cjs')], { cwd: box, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  const report = fs.existsSync(path.join(box, 'result.json')) ? JSON.parse(fs.readFileSync(path.join(box, 'result.json'), 'utf8')) : null;
  if (!report?.ok || exitCode !== 0) throw new Error(JSON.stringify({ box, exitCode, report, output }, null, 2));
  console.log(JSON.stringify({ ok: true, artifactDirectory: box, screenshots: [path.join(box, 'streaming.png'), path.join(box, 'final.png')], checks: ['流式标题/粗体/表格/未闭合多行代码', '进度→工具→后续正文', '完成后进度不重复、临时尾巴清除'] }, null, 2));
}
run().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
