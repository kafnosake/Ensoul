const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const sourceFile = path.join(__dirname, '../src/shared/chat-history.ts');
const source = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const isolatedModule = { exports: {} };
vm.runInNewContext(source, {
  module: isolatedModule,
  exports: isolatedModule.exports,
  require(name) { throw new Error(`chat history test must not load runtime modules: ${name}`); },
}, { filename: sourceFile });
const { expandChatResponses } = isolatedModule.exports;

const indexFile = path.join(__dirname, '../src/main/index.ts');
const indexSource = ts.createSourceFile(indexFile, fs.readFileSync(indexFile, 'utf8'), ts.ScriptTarget.ES2022, true);
const replayExpressions = [];
function findReplay(node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'flatMap'
    && node.expression.expression.getText(indexSource).startsWith('expandChatResponses(')) {
    replayExpressions.push(node.getText(indexSource));
  }
  ts.forEachChild(node, findReplay);
}
findReplay(indexSource);
assert.equal(replayExpressions.length, 1, 'index has one response-aware history replay expression');
const replayModule = { exports: {} };
const replaySource = ts.transpileModule(`exports.replay = (panel) => (${replayExpressions[0]});`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInNewContext(replaySource, {
  module: replayModule,
  exports: replayModule.exports,
  expandChatResponses,
  asApiMessage: (role, content) => ({ role, content }),
  require(name) { throw new Error(`history replay test must not load runtime modules: ${name}`); },
}, { filename: indexFile });
const replay = (panel) => JSON.parse(JSON.stringify(replayModule.exports.replay(panel)));

const message = (id, role, content = id) => ({ id, role, content, createdAt: 1 });
const response = (id, afterMessageId, content = id, toolCalls) => ({
  id, afterMessageId, content, phase: toolCalls?.length ? 'progress' : 'answer', toolCalls,
});
const call = (id) => ({ id, name: 'read_file', args: '{}', result: `result ${id}` });
const ids = (messages) => Array.from(messages, (item) => item.id);

test('回复与工具、插话按原锚点恢复；汇总账不会复制到每段', () => {
  const user = message('u', 'user');
  const tool1 = message('t1', 'tool');
  const steering = { ...message('steer', 'user'), steer: true };
  const tool2 = message('t2', 'tool');
  const firstCall = call('c1');
  const secondCall = call('c2');
  const aggregate = {
    ...message('aggregate', 'assistant', 'p1\n\np2\n\nanswer'),
    toolCalls: [firstCall, secondCall],
    actions: ['read first', 'read second'],
    stats: { tokensIn: 10, tokensOut: 5 },
    displayContent: 'answer',
    responses: [
      { ...response('p1', 'u', 'p1', [firstCall]), createdAt: 2 },
      response('p2', 'steer', 'p2', [secondCall]),
      response('answer', 't2'),
    ],
  };
  const fixture = [user, tool1, steering, tool2, aggregate];
  const original = JSON.stringify(fixture);
  const expanded = expandChatResponses(fixture);
  assert.deepEqual(ids(expanded), ['u', 'p1', 't1', 'steer', 'p2', 't2', 'answer']);
  assert.equal(expanded[0], user);
  assert.equal(expanded[2], tool1);
  assert.equal(expanded[3], steering);
  assert.equal(expanded[4].toolCalls[0], secondCall);
  assert.equal(expanded[1].createdAt, 2);
  assert.equal(expanded[4].createdAt, aggregate.createdAt);
  for (const part of expanded.filter((item) => item.role === 'assistant')) {
    assert.equal(part.responseOf, aggregate.id);
    assert.equal(part.actions, undefined);
    assert.equal(part.stats, undefined);
    assert.equal(part.responses, undefined);
    assert.equal(part.displayContent, undefined);
  }
  assert.equal(JSON.stringify(fixture), original);
});

test('旧消息与未产生响应的消息保持原样', () => {
  const fixture = [
    message('u', 'user'),
    message('s', 'system'),
    { ...message('a', 'assistant'), toolCalls: [call('c')] },
    { ...message('empty', 'assistant'), responses: [] },
  ];
  const expanded = expandChatResponses(fixture);
  assert.deepEqual(ids(expanded), ids(fixture));
  fixture.forEach((item, index) => {
    assert.equal(expanded[index], item);
    assert.equal(expanded[index].responseOf, undefined);
  });
});

test('未知锚点放到所属助手位置，空白无工具响应不进入历史', () => {
  const fixture = [message('u', 'user'), {
    ...message('aggregate', 'assistant'),
    responses: [
      response('fallback1', 'missing'),
      response('empty', 'missing', ''),
      response('fallback2', 'another-missing', '', [call('c')]),
    ],
  }, message('next', 'user')];
  const expanded = expandChatResponses(fixture);
  assert.deepEqual(ids(expanded), ['u', 'fallback1', 'fallback2', 'next']);
  assert.equal(expanded[2].content, '');
  assert.equal(expanded[2].toolCalls[0].id, 'c');
});

test('同一锚点多个响应保持响应顺序，工具消息可作为锚点', () => {
  const fixture = [message('u', 'user'), message('tool', 'tool'), {
    ...message('aggregate', 'assistant'),
    responses: [response('first', 'tool'), response('second', 'tool')],
  }];
  assert.deepEqual(ids(expandChatResponses(fixture)), ['u', 'tool', 'first', 'second']);
});

test('上一轮汇总助手可作为下一轮锚点，即使自身被展开替换', () => {
  const fixture = [message('u', 'user'), {
    ...message('previous', 'assistant'),
    responses: [response('previous-answer', 'u')],
  }, {
    ...message('current', 'assistant'),
    responses: [response('current-answer', 'previous')],
  }];
  assert.deepEqual(ids(expandChatResponses(fixture)), ['u', 'previous-answer', 'current-answer']);
});

test('主进程真实回放将新段正文与工具调用同行发送，并保留插话顺序', () => {
  const fixture = {
    chat: [
      message('u', 'user', '开始'),
      message('tool1', 'tool', 'UI 工具记录一'),
      { ...message('steer', 'user', '请调整方向'), steer: true },
      message('tool2', 'tool', 'UI 工具记录二'),
      {
        ...message('aggregate', 'assistant', '完整累计正文'),
        toolCalls: [call('c1'), call('c2')],
        responses: [
          response('first', 'u', '先读文件', [call('c1')]),
          response('second', 'steer', '按插话继续', [call('c2')]),
          response('answer', 'tool2', '最终结论'),
        ],
      },
      message('current', 'user', '本轮新问题'),
    ],
  };
  const recorded = replay(fixture);
  assert.deepEqual(recorded, [
    { role: 'user', content: '开始' },
    { role: 'assistant', content: '先读文件', tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'c1', content: 'result c1' },
    { role: 'user', content: '请调整方向' },
    { role: 'assistant', content: '按插话继续', tool_calls: [
      { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'c2', content: 'result c2' },
    { role: 'assistant', content: '最终结论' },
  ]);
  assert.equal(recorded.some((item) => item.content === '本轮新问题'), false);
});

test('主进程真实回放保持旧存档的空正文调用、工具结果、独立正文结构', () => {
  const recorded = replay({ chat: [
    message('u', 'user', '历史问题'),
    { ...message('legacy', 'assistant', '旧版结论'), toolCalls: [call('old')] },
    message('current', 'user', '本轮新问题'),
  ] });
  assert.deepEqual(recorded, [
    { role: 'user', content: '历史问题' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'old', type: 'function', function: { name: 'read_file', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'old', content: 'result old' },
    { role: 'assistant', content: '旧版结论' },
  ]);
});
