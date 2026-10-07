const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: {
  app: { getAppPath: () => path.resolve(__dirname, '..'), getPath: () => require('node:os').tmpdir() },
} };
const { toolsFor, toolsForPanel } = require('../dist/main/agent');
const { renderToolsSdk, executeRunCode } = require('../dist/main/ptc');
const names = (level, allow) => toolsFor(level, 'chat', allow).map((tool) => tool.function.name);

test('通用面板改写显示类型或带旧清单时仍有命令、构建与重启工具', () => {
  for (const kind of ['chat', 'code', 'table', 'form', 'web', 'custom-plugin']) {
    const tools = toolsForPanel({ kind, tools: ['read_file'] });
    const available = tools.map((tool) => tool.function.name);
    for (const name of ['run_command', 'build_project', 'restart_project']) {
      assert.ok(available.includes(name), `${kind} missing ${name}`);
      assert.ok(renderToolsSdk(tools).includes(`${name}(`));
    }
  }
});

test('员工仍遵循自己的套件；不存在的面板不发工具', () => {
  assert.deepEqual(toolsForPanel({ kind: 'chat', noWorkspacePrompt: true, tools: ['read_file'] })
    .map((tool) => tool.function.name), ['read_file']);
  assert.deepEqual(toolsForPanel(), []);
});

test('显式清单无匹配时不扩大到全部工具', () => {
  assert.deepEqual(names('full', ['missing_tool']), []);
  assert.deepEqual(names('read', ['restart_project']), []);
  assert.deepEqual(names('full', ['read_file', 'missing_tool']), ['read_file']);
});

test('默认、全量、开发套件与通配符保留各自的权限边界', () => {
  assert.ok(names('full').includes('restart_project'));
  assert.deepEqual(names('full', ['*']), names('full'));
  assert.ok(names('full', ['dev']).includes('restart_project'));
  assert.ok(!names('write', ['dev']).includes('restart_project'));
  assert.deepEqual(names('full', ['restart_*']), ['restart_project']);
});

test('PTC 声明和执行使用同一份重启授权清单', async () => {
  const tools = toolsFor('full', 'chat', ['restart_project']);
  const sdk = renderToolsSdk(tools);
  assert.match(sdk, /restart_project\(args\?/);
  assert.match(sdk, /原生 tools 列表只有 run_code/);
  const calls = [];
  const runner = async (name) => { calls.push(name); return '请求已挂起'; };
  const allowed = new Set(tools.map((tool) => tool.function.name));
  const result = await executeRunCode('return await tools.restart_project({})', runner, undefined, 50, allowed);
  assert.match(result.output, /请求已挂起/);
  const denied = await executeRunCode('return await tools.run_command({command:"ignored"})', runner, undefined, 50, allowed);
  assert.match(denied.output, /不在当前面板/);
  assert.deepEqual(calls, ['restart_project']);
});
