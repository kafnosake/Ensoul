const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const ReactDOMServer = require('react-dom/server');

function loadSource(relativePath) {
  const filename = path.join(__dirname, '..', relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, require }, { filename });
  return module.exports;
}

const { buildChatTimeline, appendStreamDelta, restoreChatStream } = loadSource('src/renderer/panel/chat/timeline.ts');
const { renderMarkdown } = loadSource('src/renderer/ui/markdown.tsx');
const message = (id, role = 'user', content = id) => ({ id, role, content, createdAt: 123 });
const response = (id, afterMessageId, content = id, phase = 'progress') => ({ id, afterMessageId, content, phase });
const ids = timeline => Array.from(timeline, entry => entry.id);

test('progress stays between its triggering message and actual tool messages', () => {
  const messages = [message('u'), message('t1', 'tool'), message('steer'), message('t2', 'tool')];
  const progress = [response('r1', 'u'), response('r2', 'steer')];
  const original = JSON.stringify(messages);
  assert.deepEqual(ids(buildChatTimeline(messages, progress)), ['u', 'response:r1', 't1', 'steer', 'response:r2', 't2']);
  assert.equal(JSON.stringify(messages), original);
});

test('persisted progress replaces the live copy once, without repeating the final answer', () => {
  const final = { ...message('answer', 'assistant', 'cumulative'), displayContent: 'final answer', responses: [
    response('r1', 'u', 'saved progress'), response('r2', 't1', 'final answer', 'answer'),
  ] };
  const timeline = buildChatTimeline([message('u'), message('t1', 'tool'), final], [response('r1', 'u', 'old progress')]);
  assert.deepEqual(ids(timeline), ['u', 'response:r1', 't1', 'answer']);
  assert.equal(timeline[1].content, 'saved progress');
  assert.equal(timeline[3].displayContent, 'final answer');
});

test('missing anchors preserve persisted progress before its owner and live progress at the end', () => {
  const final = { ...message('answer', 'assistant'), responses: [response('saved', 'missing')] };
  assert.deepEqual(ids(buildChatTimeline([message('u'), final], [response('live', '')])),
    ['u', 'response:saved', 'answer', 'response:live']);
});

test('drafts, answers and empty tool-only responses do not create duplicate text cards', () => {
  const entries = [response('draft', 'u', 'partial', 'draft'), response('answer', 'u', 'done', 'answer'), response('empty', 'u', '  ')];
  assert.deepEqual(ids(buildChatTimeline([message('u')], entries)), ['u']);
});

test('a hidden triggering message can still anchor progress before display filtering and paging', () => {
  const hidden = { ...message('hidden'), silent: true };
  const timeline = buildChatTimeline([message('u'), hidden, message('t', 'tool')], [response('r', 'hidden')]);
  const visible = timeline.filter(entry => !entry.silent).slice(-2);
  assert.deepEqual(ids(visible), ['response:r', 't']);
});

test('restored stream offsets trim duplicate or overlapping deltas without deleting repeated words', () => {
  assert.equal(appendStreamDelta('abcdef', 'ef', 4), 'abcdef');
  assert.equal(appendStreamDelta('abcdef', 'efgh', 4), 'abcdefgh');
  assert.equal(appendStreamDelta('哈哈', '哈哈', 2), '哈哈哈哈');
  assert.equal(appendStreamDelta('a', 'b'), 'ab');
});

test('raw Markdown preserves headings, paragraphs and unfinished multiline code while streaming', () => {
  const markdown = '# 结论\n第一行\n第二行\n\n**重点**\n\n```js\nconst a = 1;\nconst b = 2;';
  const html = ReactDOMServer.renderToStaticMarkup(renderMarkdown(markdown));
  assert.match(html, /<h1[^>]*>结论<\/h1>/);
  assert.match(html, /第一行<br\/>第二行/);
  assert.match(html, /<p[^>]*><strong>重点<\/strong><\/p>/);
  assert.match(html, /<pre[^>]*><code>const a = 1;\nconst b = 2;<\/code><\/pre>/);
});

const snapshot = (sequence, streamText, overrides = {}) => ({
  panelId: 'p', id: 'a', responseId: 'current', sequence, text: 'cumulative', streamText,
  responses: [response('closed', 'u', 'previous progress'), response('current', 'tool', streamText, 'draft')],
  ...overrides,
});
const deltaEvent = (sequence, delta, offset, overrides = {}) => ({
  kind: 'delta', value: { panelId: 'p', id: 'a', responseId: 'current', sequence, delta, offset, ...overrides },
});
const retractEvent = (sequence, text) => ({ kind: 'retract', value: { panelId: 'p', id: 'a', sequence, text, think: 0 } });
const progressEvent = (sequence, responseId, responses, overrides = {}) => ({
  kind: 'progress', value: { panelId: 'p', id: 'a', sequence, responseId, responses, reset: true, ...overrides },
});

test('retry before the restore snapshot is not retracted twice and retains closed progress', () => {
  const restored = restoreChatStream(snapshot(6, 'prefix'), [deltaEvent(5, 'bad', 6), retractEvent(6, 3)], null);
  assert.equal(restored.text, 'prefix');
  assert.equal(restored.responses[0].content, 'previous progress');
  assert.equal(restored.sequence, 6);
});

test('retry after the restore snapshot retracts the failed suffix before fresh deltas', () => {
  const restored = restoreChatStream(snapshot(5, 'prefixbad'), [retractEvent(6, 3), deltaEvent(7, 'good', 6)], null);
  assert.equal(restored.text, 'prefixgood');
  assert.equal(restored.responses[0].content, 'previous progress');
  assert.equal(restored.sequence, 7);
});

test('restore crosses a sealed progress response, its next draft and a retry in order', () => {
  const closed = response('current', 'u', 'first step');
  const next = response('next', 'tool', '', 'draft');
  const events = [
    progressEvent(6, 'current', [closed]),
    progressEvent(7, 'next', [closed, next]),
    deltaEvent(8, 'bad', 0, { responseId: 'next' }),
    retractEvent(9, 3),
    deltaEvent(10, 'second step', 0, { responseId: 'next' }),
  ];
  const restored = restoreChatStream(snapshot(5, 'first step'), events, null);
  assert.equal(restored.responseId, 'next');
  assert.equal(restored.text, 'second step');
  assert.equal(restored.responses[0].content, 'first step');
  const alreadyStarted = restoreChatStream(snapshot(7, '', { responseId: 'next', responses: [closed, next] }), events, null);
  assert.equal(alreadyStarted.text, restored.text);
});

test('a snapshot containing unflushed text trims the later delta by offset', () => {
  const restored = restoreChatStream(snapshot(4, 'abcdefgh'), [deltaEvent(5, 'efgh', 4), deltaEvent(6, 'ij', 8)], null);
  assert.equal(restored.text, 'abcdefghij');
});

test('a completed assistant snapshot stays cleared while a newer assistant can start', () => {
  assert.equal(restoreChatStream(snapshot(5, 'old'), [deltaEvent(6, 'tail', 3)], 'a').id, null);
  const restored = restoreChatStream(snapshot(5, 'old'), [
    progressEvent(1, 'new', [response('new', 'u', '', 'draft')], { id: 'b' }),
    deltaEvent(2, 'fresh', 0, { id: 'b', responseId: 'new' }),
  ], 'a');
  assert.equal(restored.id, 'b');
  assert.equal(restored.text, 'fresh');
});

test('a snapshot of the newer assistant discards older assistant events before its start', () => {
  const restored = restoreChatStream(snapshot(1, '', { id: 'b', responseId: 'new', responses: [] }), [
    progressEvent(6, 'current', [response('current', 'u')]),
    progressEvent(1, 'new', [response('new', 'u', '', 'draft')], { id: 'b' }),
    deltaEvent(2, 'fresh', 0, { id: 'b', responseId: 'new' }),
  ], null);
  assert.equal(restored.id, 'b');
  assert.equal(restored.text, 'fresh');
});
