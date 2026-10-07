const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/shared/settings-navigation.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const moduleObject = { exports: {} };
vm.runInNewContext(compiled.outputText, { module: moduleObject, exports: moduleObject.exports });
const { placeSettingsSections } = moduleObject.exports;
const ids = pages => Array.from(pages, page => page.id);

test('插件分区可以紧接其他插件分区，且不受登记顺序影响', () => {
  const pages = [
    { id: 'plugin:semantic-search:semantic-search', after: 'plugin:mcp:mcp-servers' },
    { id: 'plugin:computer-control:settings' },
    { id: 'plugin:mcp:mcp-servers' },
  ];
  assert.deepEqual(ids(placeSettingsSections([], pages)), [
    'plugin:computer-control:settings', 'plugin:mcp:mcp-servers', 'plugin:semantic-search:semantic-search',
  ]);
});

test('内置锚点、同一锚点的兄弟分区和后续分区保留稳定顺序', () => {
  const base = [{ id: 'look' }, { id: 'model' }, { id: 'plugins' }];
  const sections = [{ id: 'one', after: 'model' }, { id: 'two', after: 'model' }, { id: 'nested', after: 'one' }, { id: 'loose' }];
  assert.deepEqual(ids(placeSettingsSections(base, sections)), ['look', 'model', 'one', 'nested', 'two', 'plugins', 'loose']);
  assert.deepEqual(ids(base), ['look', 'model', 'plugins']);
});

test('MCP未启用时语义搜索分区仍可见，未知与循环锚点不会丢页', () => {
  const sections = [{ id: 'search', after: 'missing' }, { id: 'a', after: 'b' }, { id: 'b', after: 'a' }, { id: 'self', after: 'self' }];
  assert.deepEqual(ids(placeSettingsSections([], sections)), ['search', 'a', 'b', 'self']);
});
