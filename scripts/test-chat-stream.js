const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const sourceFile = path.join(__dirname, '../src/main/chat-core.ts');
const source = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const responseFile = path.join(__dirname, '../src/shared/chat-responses.ts');
const responseSource = ts.transpileModule(fs.readFileSync(responseFile, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const responseModule = { exports: {} };
vm.runInNewContext(responseSource, {
  module: responseModule, exports: responseModule.exports,
  require: (name) => { throw new Error(`response buffer must remain pure: ${name}`); },
}, { filename: responseFile });
const { ChatResponseBuffer } = responseModule.exports;
const cfg = { provider: 'mock', baseUrl: 'https://mock.invalid/v1', apiKey: 'test', model: 'mock' };
const history = [{ role: 'user', content: '开始' }];
const tools = [{ type: 'function', function: { name: 'read_file', description: 'test', parameters: {} } }];
const readCall = [{ index: 0, id: 'read_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"demo.ts"}' } }];

function reply(deltas, finishReason = 'stop') {
  return { deltas, finishReason };
}

function harness(plans) {
  const requests = [];
  const trace = [];
  const segments = [];
  const encoder = new TextEncoder();
  const module = { exports: {} };
  const denyFiles = () => { throw new Error('chat stream test must not access workspace files'); };
  const context = {
    module, exports: module.exports, AbortController, TextDecoder, setTimeout, clearTimeout,
    require(name) {
      if (name === 'fs') return { existsSync: denyFiles, readFileSync: denyFiles, statSync: denyFiles };
      if (name === 'path') return path;
      if (name === '../shared/types') return { BUILTIN_KINDS: [] };
      if (name === './skills') return { skillDigest: () => '' };
      if (name === './lang') return { getLang: () => 'zh' };
      if (name === '../shared/i18n') return { localeTag: () => 'zh-CN', t: (text) => text };
      throw new Error(`unexpected module: ${name}`);
    },
    async fetch(url, options) {
      assert.equal(url, `${cfg.baseUrl}/chat/completions`);
      const plan = plans[requests.length];
      assert.ok(plan, 'unexpected model request');
      requests.push(JSON.parse(options.body));
      const frames = plan.deltas.map((delta) => ({ choices: [{ delta }] }));
      if (plan.finishReason !== null) frames.push({ choices: [{ delta: {}, finish_reason: plan.finishReason }] });
      const chunks = frames.map((frame) => encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      chunks.push(encoder.encode('data: [DONE]\n\n'));
      let index = 0;
      return {
        ok: true, status: 200, headers: { get: () => null },
        body: { getReader: () => ({
          async read() {
            options.signal.throwIfAborted();
            if (index === chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
          },
        }) },
      };
    },
  };
  vm.runInNewContext(source, context, { filename: sourceFile });
  const current = () => segments[segments.length - 1];
  const events = {
    onResponseStart() {
      segments.push({ text: '', think: '', ended: false });
      trace.push({ type: 'start' });
    },
    onText(delta) {
      current().text += delta;
      trace.push({ type: 'text', delta });
    },
    onReasoning(delta) {
      current().think += delta;
      trace.push({ type: 'reasoning', delta });
    },
    onResponseEnd(info) {
      current().ended = true;
      current().text = info.content;
      trace.push({ type: 'end', content: info.content, hasTools: info.hasTools });
    },
    onRetry(info) {
      current().text = current().text.slice(0, current().text.length - info.discardText);
      current().think = current().think.slice(0, current().think.length - info.discardThink);
      trace.push({ type: 'retry', text: info.discardText, think: info.discardThink });
    },
    onTool(name, args, result) {
      trace.push({ type: 'tool', name, result });
    },
  };
  const runner = async (name, args) => {
    assert.equal(name, 'read_file');
    assert.equal(args.path, 'demo.ts');
    trace.push({ type: 'execute', name });
    return '文件内容';
  };
  return {
    requests, trace, segments, events,
    run: (signal) => module.exports.runAgent(history, cfg, tools, runner, events, signal),
  };
}

test('回复结束事件先于工具执行，每次模型回复各有一组边界', async () => {
  const h = harness([
    reply([{ reasoning_content: '先思考' }, { content: '先看' }, { content: '代码。' }, { tool_calls: readCall }], 'tool_calls'),
    reply([{ content: '**完成**' }]),
  ]);
  const result = await h.run();
  assert.deepEqual(h.trace, [
    { type: 'start' },
    { type: 'reasoning', delta: '先思考' },
    { type: 'text', delta: '先看' },
    { type: 'text', delta: '代码。' },
    { type: 'end', content: '先看代码。', hasTools: true },
    { type: 'execute', name: 'read_file' },
    { type: 'tool', name: 'read_file', result: '文件内容' },
    { type: 'start' },
    { type: 'text', delta: '**完成**' },
    { type: 'end', content: '**完成**', hasTools: false },
  ]);
  assert.equal(result.text, '先看代码。\n\n**完成**');
  assert.equal(result.ended, 'done');
  assert.equal(h.requests.length, 2);
  const assistant = h.requests[1].messages.find((message) => message.role === 'assistant');
  assert.equal(assistant.content, '先看代码。');
  assert.equal(assistant.tool_calls[0].id, 'read_1');
  assert.equal(h.requests[1].messages.at(-1).tool_call_id, 'read_1');
});

test('重试撤回仅覆盖当前回复的失败草稿，不重复开始或完成回复', async () => {
  const h = harness([
    reply([{ content: '已确认。' }, { tool_calls: readCall }], 'tool_calls'),
    reply([{ reasoning_content: '失败思考' }, { content: '失败草稿' }], null),
    reply([{ reasoning_content: '新的思考' }, { content: '最终答复。' }]),
  ]);
  const result = await h.run();
  assert.equal(result.text, '已确认。\n\n最终答复。');
  assert.deepEqual(h.segments, [
    { text: '已确认。', think: '', ended: true },
    { text: '最终答复。', think: '新的思考', ended: true },
  ]);
  assert.deepEqual(h.trace.filter((event) => event.type === 'retry'), [
    { type: 'retry', text: '失败草稿'.length, think: '失败思考'.length },
  ]);
  assert.equal(h.trace.filter((event) => event.type === 'start').length, 2);
  assert.equal(h.trace.filter((event) => event.type === 'end').length, 2);
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.requests[2].messages, h.requests[1].messages);
});

test('停止保留前一段完成状态，当前半段不会发出伪完成或重试', async () => {
  const h = harness([
    reply([{ content: '已确认。' }, { tool_calls: readCall }], 'tool_calls'),
    reply([{ content: '尚未说完' }]),
  ]);
  const ctrl = new AbortController();
  const onText = h.events.onText;
  h.events.onText = (delta) => {
    onText(delta);
    if (delta === '尚未说完') ctrl.abort(new Error('user stopped'));
  };
  await assert.rejects(h.run(ctrl.signal), /停止/);
  assert.deepEqual(h.segments, [
    { text: '已确认。', think: '', ended: true },
    { text: '尚未说完', think: '', ended: false },
  ]);
  assert.equal(h.trace.filter((event) => event.type === 'end').length, 1);
  assert.equal(h.trace.filter((event) => event.type === 'retry').length, 0);
  assert.equal(h.requests.length, 2);
});

test('无工具回复先完成，边界插话仍能启动下一次回复', async () => {
  const h = harness([
    reply([{ content: '候选答复。' }]),
    reply([{ content: '调整后的答复。' }]),
  ]);
  const queue = [];
  const onEnd = h.events.onResponseEnd;
  h.events.onResponseEnd = (info) => {
    onEnd(info);
    if (info.content === '候选答复。') queue.push({ text: '改用第二种方案' });
  };
  h.events.takeSteering = () => queue.splice(0);
  h.events.onSteering = (item) => h.trace.push({ type: 'steering', text: item.text });
  const result = await h.run();
  assert.deepEqual(h.trace, [
    { type: 'start' },
    { type: 'text', delta: '候选答复。' },
    { type: 'end', content: '候选答复。', hasTools: false },
    { type: 'steering', text: '改用第二种方案' },
    { type: 'start' },
    { type: 'text', delta: '调整后的答复。' },
    { type: 'end', content: '调整后的答复。', hasTools: false },
  ]);
  assert.equal(result.text, '候选答复。\n\n调整后的答复。');
  assert.equal(h.requests.length, 2);
  assert.match(h.requests[1].messages.at(-1).content, /改用第二种方案/);
});

test('缺少工具名的占位调用不会把回复误标为带工具', async () => {
  const h = harness([
    reply([{ content: '回答。' }, { tool_calls: [{ index: 0, function: { arguments: '{}' } }] }], 'tool_calls'),
  ]);
  const result = await h.run();
  assert.equal(result.text, '回答。');
  assert.deepEqual(h.trace.at(-1), { type: 'end', content: '回答。', hasTools: false });
  assert.equal(h.trace.filter((event) => event.type === 'execute').length, 0);
});

test('没有正文的工具回复也保留模型调用边界', async () => {
  const h = harness([
    reply([{ tool_calls: readCall }], 'tool_calls'),
    reply([{ content: '最终答复。' }]),
  ]);
  const result = await h.run();
  assert.deepEqual(h.trace[1], { type: 'end', content: '', hasTools: true });
  assert.equal(h.trace.filter((event) => event.type === 'start').length, 2);
  assert.equal(result.text, '最终答复。');
});

function responseBuffer() {
  const message = { id: 'assistant_1', role: 'assistant', content: '', createdAt: 1 };
  return { message, buffer: new ChatResponseBuffer(message) };
}

test('分段缓冲器同步累计正文，只在有正文的回复之间插入一组空行', () => {
  const { message, buffer } = responseBuffer();
  const first = buffer.start('response_1', 'user_1', 10);
  buffer.append('先看');
  buffer.append('代码。');
  buffer.seal('先看代码。', true);
  assert.equal(buffer.current, first);
  assert.equal(first.afterMessageId, 'user_1');
  assert.equal(first.createdAt, 10);
  assert.equal(first.phase, 'progress');
  const second = buffer.start('response_2', 'tool_1', 20);
  assert.equal(message.content, '先看代码。');
  buffer.append('最终');
  buffer.append('答复。');
  buffer.seal('最终答复。', false);
  assert.equal(message.content, '先看代码。\n\n最终答复。');
  assert.equal(buffer.current, second);
  assert.equal(second.phase, 'answer');
  assert.equal(message.responses, buffer.responses);
  assert.equal(buffer.responses.length, 2);
});

test('分段缓冲器的撤回只影响第二段，撤空后重试不会重复插入边界', () => {
  const { message, buffer } = responseBuffer();
  buffer.start('response_1', 'user_1', 10);
  buffer.append('已确认。');
  buffer.seal('已确认。', true);
  buffer.start('response_2', 'tool_1', 20);
  buffer.append('失败草稿');
  buffer.retract(2);
  assert.equal(message.content, '已确认。\n\n失败');
  assert.equal(buffer.responses[0].content, '已确认。');
  buffer.retract(100);
  assert.equal(buffer.current.content, '');
  assert.equal(message.content, '已确认。');
  buffer.append('重试完成。');
  buffer.seal('重试完成。', false);
  assert.equal(message.content, '已确认。\n\n重试完成。');
  assert.equal(buffer.responses.length, 2);
  assert.equal(buffer.responses[0].phase, 'progress');
});

test('候选答复在下一段开始时变为进度，保留其文本与原有锚点', () => {
  const { message, buffer } = responseBuffer();
  const candidate = buffer.start('candidate', 'user_1', 10);
  buffer.append('候选答复。');
  buffer.seal('候选答复。', false);
  assert.equal(candidate.phase, 'answer');
  const continued = buffer.start('continued', 'steering_1', 20);
  assert.equal(candidate.phase, 'progress');
  assert.equal(candidate.content, '候选答复。');
  assert.equal(candidate.afterMessageId, 'user_1');
  assert.equal(continued.afterMessageId, 'steering_1');
  assert.equal(continued.phase, 'draft');
  assert.equal(message.content, '候选答复。');
  buffer.append('调整后的答复。');
  buffer.seal('调整后的答复。', false);
  assert.equal(message.content, '候选答复。\n\n调整后的答复。');
  assert.equal(continued.phase, 'answer');
});

test('空正文工具段仍保留配对调用，后续答复没有多余开头空行', () => {
  const { message, buffer } = responseBuffer();
  const toolResponse = buffer.start('tool_response', 'user_1', 10);
  buffer.seal('', true);
  const calls = [{ id: 'call_1', name: 'read_file', args: '{"path":"demo.ts"}', result: '文件内容' }];
  toolResponse.toolCalls = calls;
  buffer.start('answer', 'tool_1', 20);
  buffer.append('最终答复。');
  buffer.seal('最终答复。', false);
  assert.equal(toolResponse.content, '');
  assert.equal(toolResponse.phase, 'progress');
  assert.equal(toolResponse.toolCalls, calls);
  assert.equal(buffer.responses[0], toolResponse);
  assert.equal(buffer.responses.length, 2);
  assert.equal(message.content, '最终答复。');
});

test('seal 后追加的本地警告同时保留在当前段和累计正文中', () => {
  const { message, buffer } = responseBuffer();
  buffer.start('response_1', 'user_1', 10);
  buffer.append('前一段。');
  buffer.seal('前一段。', true);
  buffer.start('response_2', 'tool_1', 20);
  buffer.append('未说完');
  buffer.seal('未说完', false);
  buffer.append('\n\n⚠ 回复被长度上限截断');
  assert.equal(buffer.current.content, '未说完\n\n⚠ 回复被长度上限截断');
  assert.equal(buffer.current.phase, 'answer');
  assert.equal(buffer.responses[0].content, '前一段。');
  assert.equal(message.content, '前一段。\n\n未说完\n\n⚠ 回复被长度上限截断');
  const empty = responseBuffer();
  empty.buffer.start('empty', 'user_1', 10);
  empty.buffer.seal('', false);
  empty.buffer.append('\n\n⚠ 工具调用没有名称');
  assert.equal(empty.message.content, '\n\n⚠ 工具调用没有名称');
});

test('工具中断后单独建立说明段，保留旧进度段及其工具调用', () => {
  const { message, buffer } = responseBuffer();
  const progress = buffer.start('progress', 'user_1', 10);
  buffer.append('开始读文件。');
  buffer.seal('开始读文件。', true);
  progress.toolCalls = [{ id: 'call_1', name: 'read_file', args: '{}', result: '已开始' }];
  const interrupted = buffer.start('interrupted', 'tool_1', 20);
  buffer.append('⚠ 用户停止了这一轮');
  assert.equal(progress.phase, 'progress');
  assert.equal(progress.content, '开始读文件。');
  assert.equal(progress.toolCalls[0].id, 'call_1');
  assert.equal(interrupted.phase, 'draft');
  assert.equal(interrupted.content, '⚠ 用户停止了这一轮');
  assert.equal(buffer.current, interrupted);
  assert.equal(message.content, '开始读文件。\n\n⚠ 用户停止了这一轮');
});
