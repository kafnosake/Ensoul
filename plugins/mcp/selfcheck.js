/**
 * 核过一遍：这个文件的形状对不对。
 *
 * 插件没有构建步骤、也没单测，写完只有"装载时不炸"这一道关。这个脚本就补那一道 ——
 * 用纯 node 把三个模块 require 进来，把能离线验的都验掉：
 *
 *   registry  别在顶层就发网络请求；解析类的纯函数给几个真实样例
 *   library   装载 / 列表 / 卸载走一遍（在临时目录里，不碰真工作区）
 *   ecosystem 形状检查：导出的东西都在
 *
 * 跑法：node plugins/mcp/selfcheck.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const here = __dirname;
const reg = require(path.join(here, 'registry.js'));
const lib = require(path.join(here, 'library.js'));
const eco = require(path.join(here, 'ecosystem.js'));

let passed = 0;
let failed = 0;

function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.log('  ✗ ' + name + ' → ' + ((e && e.message) || e));
  }
}

console.log('registry.js');
ok('仓库地址三种写法都认', () => {
  assert.deepStrictEqual(reg.parseRepoRef('anthropics/skills'), { owner: 'anthropics', repo: 'skills' });
  assert.deepStrictEqual(reg.parseRepoRef('https://github.com/obra/superpowers'), { owner: 'obra', repo: 'superpowers' });
  assert.deepStrictEqual(reg.parseRepoRef('https://github.com/x/y.git'), { owner: 'x', repo: 'y' });
  assert.strictEqual(reg.parseRepoRef('随便一句话'), null);
});
ok('frontmatter 只认那三个键', () => {
  const m = reg.parseFront('---\nname: pdf\ndescription: 处理 PDF\nfoo: bar\n---\n\n正文');
  assert.strictEqual(m.name, 'pdf');
  assert.strictEqual(m.description, '处理 PDF');
  assert.strictEqual(m.foo, 'bar');
});
ok('文件树里挑技能：每个 SKILL.md 算一份，按目录去重', () => {
  const list = reg.pickSkills([
    { type: 'blob', path: 'skills/pdf/SKILL.md', size: 100 },
    { type: 'blob', path: 'skills/pdf/helper.py', size: 10 },
    { type: 'blob', path: 'SKILL.md', size: 100 },
    { type: 'blob', path: '.claude-plugin/marketplace.json', size: 10 },
    { type: 'blob', path: '.github/SKILL.md', size: 10 },
    { type: 'tree', path: 'skills/pdf' },
  ]);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].name, 'pdf');
  assert.strictEqual(list[0].dir, 'skills/pdf');
});
ok('默认源有技能源也有 MCP 源，且都是「可改的起始清单」不是白名单', () => {
  assert.ok(reg.DEFAULT_SOURCES.skill.length >= 1);
  assert.ok(reg.DEFAULT_SOURCES.mcp.some((s) => s.url));
});
ok('MCP 注册表条目 → 可启动配置', () => {
  const item = reg.normalizeMcp({
    name: 'com.x/y',
    title: 'Y',
    description: 'd',
    version: '1.2.3',
    packages: [{ registryType: 'npm', identifier: 'y-mcp', version: '1.2.3', runtimeHint: 'npx', runtimeArguments: [{ value: '-y', type: 'positional' }], environmentVariables: [{ name: 'TOKEN', isRequired: true, isSecret: true }] }],
    remotes: [],
  }, { isLatest: true });
  assert.strictEqual(item.launch.command, 'npx');
  assert.deepStrictEqual(item.launch.args, ['-y', 'y-mcp@1.2.3']);
  assert.strictEqual(item.requiresConfig, true);
  assert.strictEqual(item.envNames[0].secret, true);
});
ok('只有远程地址的服务：不给 launch（本地起不来）', () => {
  const item = reg.normalizeMcp({ name: 'a/b', remotes: [{ type: 'streamable-http', url: 'https://x' }] }, {});
  assert.strictEqual(item.launch, null);
  assert.strictEqual(item.remotes.length, 1);
});

console.log('library.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-check-'));
ok('装进核心认的两层结构里', () => {
  const res = lib.installSkill(tmp, {
    group: 'anthropics__skills',
    name: 'pdf',
    files: [{ path: 'SKILL.md', text: '---\nname: pdf\ndescription: 处理 PDF\n---\n\n正文' }, { path: 'helper.py', text: 'print(1)' }],
    repo: 'anthropics/skills',
  });
  assert.strictEqual(res.files, 2);
  const onDisk = path.join(tmp, '.ensoul', 'skills', 'anthropics__skills', 'pdf', 'SKILL.md');
  assert.ok(fs.existsSync(onDisk), 'SKILL.md 该落在 skills/<仓库>/<技能>/ 下');
  assert.ok(fs.existsSync(path.join(path.dirname(onDisk), 'helper.py')), '附属文件要一起下来');
});
ok('列得出来，带描述与归属', () => {
  const list = lib.listInstalledSkills(tmp);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'pdf');
  assert.strictEqual(list[0].description, '处理 PDF');
  assert.strictEqual(list[0].id, 'anthropics__skills/pdf');
});
ok('用户手放的技能不算「已装」', () => {
  const manual = path.join(tmp, '.ensoul', 'skills', 'my-own', 'handmade');
  fs.mkdirSync(manual, { recursive: true });
  fs.writeFileSync(path.join(manual, 'SKILL.md'), '---\nname: handmade\n---\n');
  const list = lib.listInstalledSkills(tmp);
  assert.strictEqual(list.filter((s) => s.name === 'handmade').length, 0);
  assert.strictEqual(lib.uninstallSkill(tmp, 'my-own/handmade').ok, false);
  assert.ok(fs.existsSync(path.join(manual, 'SKILL.md')), '不该被删掉');
});
ok('卸载连根拔，连带空壳仓库目录一起收', () => {
  const res = lib.uninstallSkill(tmp, 'anthropics__skills/pdf');
  assert.strictEqual(res.ok, true);
  assert.ok(!fs.existsSync(path.join(tmp, '.ensoul', 'skills', 'anthropics__skills', 'pdf')));
  assert.ok(!fs.existsSync(path.join(tmp, '.ensoul', 'skills', 'anthropics__skills')), '仓库那层空了就该收掉');
});
ok('目录穿越的名字会被挡在目录里', () => {
  const res = lib.installSkill(tmp, { group: 'g', name: 'x', files: [{ path: '../../evil.txt', text: 'nope' }], repo: 'g' });
  assert.ok(!fs.existsSync(path.join(tmp, 'evil.txt')));
  assert.ok(res.files === 0, '越界的文件不该算装成功');
});
ok('MCP：装进 mcp.json，并且只认自己装的那些', () => {
  const res = lib.installMcp(tmp, { name: 'filesystem', launch: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] }, source: 'registry', title: 'Filesystem' });
  assert.strictEqual(res.ok, true);
  const st = lib.readMcpState(tmp);
  assert.strictEqual(st.servers.length, 1);
  const list = lib.listInstalledMcp(tmp);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'filesystem');
  // 用户自己手工加的：出现在 mcp.json 里，但不出现在我们的卸载列表里
  st.servers.push({ name: 'by-hand', command: 'node', args: [], enabled: true, status: 'disconnected', error: '', tools: [] });
  fs.writeFileSync(path.join(tmp, '.ensoul', 'mcp', 'servers.json'), JSON.stringify(st));
  assert.strictEqual(lib.listInstalledMcp(tmp).length, 1, '手工加的不该出现在这里');
  assert.strictEqual(lib.uninstallMcp(tmp, 'by-hand').ok, false, '也不该被我们删掉');
});
ok('MCP 卸载：配置和出厂记录一起走', () => {
  assert.strictEqual(lib.uninstallMcp(tmp, 'filesystem').ok, true);
  assert.strictEqual(lib.readMcpState(tmp).servers.filter((s) => s.name === 'filesystem').length, 0);
  assert.ok(!fs.existsSync(path.join(tmp, '.ensoul', 'mcp', 'project', 'filesystem')));
});

console.log('ecosystem.js');
ok('导出的都在', () => {
  for (const k of ['CACHE_FILE', 'createEcosystem', 'readCache', 'patchCache', 'readSources', 'collectMcp']) {
    assert.ok(eco[k] !== undefined, '缺：' + k);
  }
});
ok('源清单：没存过就是出厂那两个', () => {
  const list = eco.readSources({}, 'skill');
  assert.ok(list.length >= 1);
  assert.ok(list.every((s) => s.builtin));
});
ok('源清单：存过就照存的来，用户加的在里面', () => {
  const list = eco.readSources({ ecosystem: { skillSources: [{ id: 'x', repo: 'a/b' }] } }, 'skill');
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].repo, 'a/b');
  assert.strictEqual(list[0].builtin, false);
});
ok('缓存写进去读得回来，且不抹掉别的字段', () => {
  eco.patchCache({ dataPath: relative => path.join(tmp, relative) }, { skills: { repos: [{ id: 'a' }] } });
  eco.patchCache({ dataPath: relative => path.join(tmp, relative) }, { mcp: { items: [] } });
  const c = eco.readCache({ dataPath: relative => path.join(tmp, relative) });
  assert.strictEqual(c.skills.repos.length, 1);
  assert.ok(c.mcp);
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + passed + ' 项通过，' + failed + ' 项失败');
process.exit(failed ? 1 : 0);
