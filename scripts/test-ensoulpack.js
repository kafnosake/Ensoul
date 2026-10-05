#!/usr/bin/env node
/**
 * .ensoulpack 回归 —— 容器、净化、装包计划、两条真实的"导出 → 导入"。
 *
 * 为什么要有它：这一块的失败方式是**静默**的。装一半失败、条目名越界、
 * comp.id 拼成文件名、组件落到软件目录而不是工作区 —— 全都不会报错，
 * 只会在某天发现源码被覆盖了、或者"导出的组件装不上"。
 *
 * 跑法：node scripts/test-ensoulpack.js
 * 用假 api 驱动真插件（跟 scripts/test-pomodoro.js 同一种做法），
 * 不碰 Electron、不动真工作区，全部落在 .ensoul/tmp/ 下。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, '.ensoul', 'tmp', 'pack-test');
const WS = path.join(TMP, 'ws');

let fails = 0;
const ok = (cond, label) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond) fails++;
};
const throws = (fn, label) => {
  try {
    fn();
    ok(false, label + '（本该拒绝，却通过了）');
  } catch (e) {
    ok(true, label + ' → ' + String(e.message).slice(0, 60));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(WS, '.ensoul', 'state'), { recursive: true });

process.env.ENSOUL_WORKSPACE = WS;

/*
 * 插件里的 t() 来自**全局那一份**（核心在 require 插件之前装好，见 plugins.ts 的 mount）。
 * 这里跑的是没装壳的裸 node，得自己装一个最简版：不做翻译，只做占位符替换 ——
 * 缺了它，插件模块顶层那句 t(...) 会直接 "t is not defined"，整个文件加载不了。
 */
globalThis.t = (s, vars) => {
  let out = String(s);
  for (const [k, v] of Object.entries(vars || {})) out = out.split('{' + k + '}').join(String(v));
  return out;
};

const pack = require(path.join(ROOT, 'src', 'shared', 'ensoulpack.js'));
const { createZip, parseZip, safePackId, safeEntryPath, planPluginPack } = pack;
const crypto = require('crypto');

/** 假 api：只给插件真正会用到的那几个口子 */
function makeApi(ws) {
  let state = null;
  return {
    workspace: ws,
    workspaceRoot: () => ws,
    log: () => {},
    state: { load: () => state, save: (v) => (state = JSON.parse(JSON.stringify(v))) },
    createPanel: () => ({ id: 'panel-new', title: 'x' }),
    addTool: () => {},
  };
}

function makePluginZip(id, entries, manifestExtra) {
  const files = entries.map((e) => ({ path: e.path, data: Buffer.from(e.body, 'utf8') }));
  const manifest = Object.assign(
    {
      spec: 1,
      type: 'plugin',
      id,
      name: id,
      version: '1.0.0',
      host: '>=0.1.0',
      files: files.map((f) => ({ path: f.path, sha256: crypto.createHash('sha256').update(f.data).digest('hex') })),
    },
    manifestExtra || {},
  );
  return createZip([{ path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') }, ...files]);
}

/** 等一个文件/目录出现，最多等 4 秒（插件的一跳是 300ms） */
async function waitFor(fn, ms) {
  const until = Date.now() + (ms || 4000);
  while (Date.now() < until) {
    const v = fn();
    if (v) return v;
    await sleep(300);
  }
  return null;
}

function containerTests() {
  const bin = Buffer.alloc(20000);
  for (let i = 0; i < bin.length; i++) bin[i] = (i * 37) & 0xff;
  const files = [
    { path: 'manifest.json', data: Buffer.from('{"spec":1}', 'utf8') },
    { path: 'assets/图片.bin', data: bin },
    { path: 'index.js', data: Buffer.from('module.exports = { name: "x" };', 'utf8') },
  ];
  const back = parseZip(createZip(files));
  ok(back.size === 3, '容器往返：三个条目都回来了');
  ok(Buffer.compare(back.get('assets/图片.bin'), bin) === 0, '容器往返：20KB 二进制逐字节一致');
  ok(back.get('index.js').toString('utf8') === 'module.exports = { name: "x" };', '容器往返：文本一致');
  ok(back.has('assets/图片.bin'), '容器往返：中文名没被改');
}

function sanitizeTests() {
  ok(safePackId('notepad') === 'notepad', 'id：正常名字通过');
  ok(safePackId('my.plugin_2-x') === 'my.plugin_2-x', 'id：点 / 下划线 / 连字符都认');
  ok(safePackId('..') === '', 'id：.. 挡下');
  ok(safePackId('.') === '', 'id：. 挡下');
  ok(safePackId('../../src/main') === '', 'id：带斜杠挡下');
  ok(safePackId('a\\\\b') === '', 'id：反斜杠挡下');

  ok(safeEntryPath('lib/a.js') === 'lib/a.js', '条目：正常路径通过');
  ok(safeEntryPath('lib\\\\win\\\\a.js') === 'lib/win/a.js', '条目：反斜杠归一成正斜杠');
  ok(safeEntryPath('../../../src/main/index.ts') === null, '条目：../ 越界挡下');
  ok(safeEntryPath('/etc/passwd') === null, '条目：绝对路径挡下');
  ok(safeEntryPath('C:/windows/x') === null, '条目：盘符挡下');
  ok(safeEntryPath('a/../b') === null, '条目：中段 .. 挡下');
  ok(safeEntryPath('') === null, '条目：空名挡下');
  ok(safeEntryPath('./a.js') === 'a.js', '条目：前导 ./ 收掉');
}

function planTests() {
  const goodZip = makePluginZip('notepad', [
    { path: 'index.js', body: 'module.exports = { name: "notepad", setup() {} };' },
    { path: 'lib/util.js', body: 'module.exports = 1;' },
  ]);
  const plan = planPluginPack(goodZip, { curVersion: '0.1.0', installedPlugins: [] });
  ok(plan.id === 'notepad', '计划：id 认出来了');
  ok(plan.targetDir === '.ensoul/plugins/notepad', '计划：落点是 .ensoul/plugins/<id>');
  ok(plan.files.length === 2 && plan.files.every((f) => !f.rel.includes('..')), '计划：两个条目都是干净的相对路径');
  ok(!plan.files.some((f) => f.rel === 'manifest.json'), '计划：manifest 不落进插件目录');

  const opts = { curVersion: '0.1.0', installedPlugins: [] };
  // 这就是复验里那条能覆盖开源源码的包
  throws(() => planPluginPack(makePluginZip('evil', [{ path: '../../../src/main/index.ts', body: '// pwned' }]), opts), '坏包：条目 ../ 越界');
  throws(() => planPluginPack(makePluginZip('..', [{ path: 'index.js', body: 'x' }]), opts), '坏包：id = ..');
  throws(() => planPluginPack(makePluginZip('../../src', [{ path: 'index.js', body: 'x' }]), opts), '坏包：id = ../../src');
  throws(() => planPluginPack(Buffer.from('not a zip at all', 'utf8'), opts), '坏包：不是 zip');
  throws(() => planPluginPack(makePluginZip('comp', [{ path: 'x.json', body: '{}' }], { type: 'component' }), opts), '坏包：类型不对');
  throws(() => planPluginPack(makePluginZip('ver', [{ path: 'index.js', body: 'x' }], { spec: 99 }), opts), '坏包：规范版本不认识');
  throws(() => planPluginPack(makePluginZip('dep', [{ path: 'index.js', body: 'x' }], { requires: { plugins: ['nothing-here'] } }), opts), '坏包：缺依赖');
  throws(() => planPluginPack(makePluginZip('future', [{ path: 'index.js', body: 'x' }], { host: '>=9.0.0' }), opts), '坏包：宿主版本不够');
  {
    const zip = makePluginZip('sum', [{ path: 'index.js', body: 'module.exports = 1;' }]);
    const tampered = Buffer.from(zip);
    const at = tampered.indexOf(Buffer.from('module.exports = 1;', 'utf8'));
    tampered.write('module.exports = 2;', at, 'utf8');
    throws(() => planPluginPack(tampered, opts), '坏包：摘要对不上');
  }
}

function installTests() {
  const goodZip = makePluginZip('notepad', [
    { path: 'index.js', body: 'module.exports = { name: "notepad", setup() {} };' },
    { path: 'lib/util.js', body: 'module.exports = 1;' },
  ]);
  const plan = planPluginPack(goodZip, { curVersion: '0.1.0', installedPlugins: [] });
  // fsapi 是 TypeScript，跑的是构建产物（dist）—— 测试不另造一份实现的副本
  const { writeBytes } = require(path.join(ROOT, 'dist', 'main', 'fsapi.js'));
  for (const f of plan.files) writeBytes(plan.targetDir + '/' + f.rel, f.data);
  const installed = path.join(WS, '.ensoul', 'plugins', 'notepad');
  ok(fs.existsSync(path.join(installed, 'index.js')), '真装：index.js 落地了');
  ok(fs.existsSync(path.join(installed, 'lib', 'util.js')), '真装：子目录里的文件也落地了');
  ok(require(path.join(installed, 'index.js')).name === 'notepad', '真装：装完能 require 起来');
}

/** 5a. 组件包：打包台导出 → 组件库导入 */
async function componentRoundTrip() {
  const compDir = path.join(WS, '.ensoul', 'library', 'components');
  fs.mkdirSync(compDir, { recursive: true });
  const compId = 'panel-testcmp-1';
  fs.writeFileSync(
    path.join(compDir, compId + '.json'),
    JSON.stringify({ id: compId, name: '测试组件', kind: 'chat', title: '测试组件', look: {}, spec: { systemPrompt: 'hi' } }, null, 2),
  );

  const packager = require(path.join(ROOT, 'plugins', 'git-packager', 'index.js'));
  let exportTool = null;
  const pApi = makeApi(WS);
  pApi.addTool = (spec, fn) => { if (spec.name === 'packager_export_pack') exportTool = fn; };
  packager.setup(pApi);
  ok(typeof exportTool === 'function', '端到端·组件：打包台注册了 export_pack');
  if (!exportTool) return;

  // 输出路径是**相对工作区**的（打包台就是这么拼的）；这里还得保证父目录存在，
  // 因为"导出"只负责写那一个文件，不会替用户把目录建出来
  const outRel = 'exports/comp.ensoulpack';
  fs.mkdirSync(path.join(WS, 'exports'), { recursive: true });
  const msg = await exportTool({ id: compId, type: 'component', outPath: outRel });
  const outAbs = path.join(WS, outRel);
  ok(fs.existsSync(outAbs), '端到端·组件：导出文件落在工作区里 —— ' + String(msg).slice(0, 80));
  if (!fs.existsSync(outAbs)) return;

  const before = new Set(fs.readdirSync(compDir));
  const lib = require(path.join(ROOT, 'plugins', 'library', 'index.js'));
  let said = '';
  const lApi = makeApi(WS);
  lApi.log = (m) => { said = String(m); };
  lib.setup(lApi);
  const cmdFile = path.join(WS, '.ensoul', 'state', 'library.cmd.json');
  fs.writeFileSync(cmdFile, JSON.stringify({
    cmds: [{ seq: 1, panelId: 'panel-lib', cmd: 'import', data: fs.readFileSync(outAbs).toString('base64'), overwrite: false }],
  }));
  const fresh = await waitFor(() => {
    const now = fs.readdirSync(compDir).filter((f) => !before.has(f));
    return now.length ? now : null;
  });
  ok(!!fresh, '端到端·组件：导入后多出一个组件文件 —— ' + (fresh || []).join(',') + ' ／ 插件日志：' + said.slice(0, 120));
  if (fresh) {
    const c = JSON.parse(fs.readFileSync(path.join(compDir, fresh[0]), 'utf8'));
    // 库里已经有同名的了 → 插件按"新建一个"处理，名字会带上（导入）后缀 —— 这也是设计
    ok(String(c.name).indexOf('测试组件') === 0, '端到端·组件：名字带回来了 —— ' + c.name);
    ok(path.dirname(path.resolve(compDir, fresh[0])) === compDir, '端到端·组件：落在组件目录里，没往外跑');
  }
  if (lib.dispose) lib.dispose();
}

/** 5b. 组件导入：越界 id 必须被拒，源码目录一个字节都不许多 */
async function rejectComponent() {
  const lib = require(path.join(ROOT, 'plugins', 'library', 'index.js'));
  let rejected = '';
  const api = makeApi(WS);
  api.log = (m) => { if (String(m).includes('拒绝')) rejected = String(m); };
  lib.setup(api);
  const cmdFile = path.join(WS, '.ensoul', 'state', 'library.cmd.json');
  fs.writeFileSync(cmdFile, JSON.stringify({
    cmds: [{
      seq: 900,
      panelId: 'panel-lib',
      cmd: 'import',
      data: JSON.stringify({ id: '../../../src/main/poison', name: 'x', kind: 'chat' }),
      overwrite: false,
    }],
  }));
  const got = await waitFor(() => (rejected ? rejected : null));
  ok(!!got, '端到端·组件：越界 id 被拒绝 —— ' + String(got).slice(0, 70));
  ok(!fs.existsSync(path.join(ROOT, 'src', 'main', 'poison.json')), '端到端·组件：源码目录里没多出 poison.json');
  if (lib.dispose) lib.dispose();
}

/** 5c. 无脸插件包：打包台导出 → 装包计划算一遍 → 落到 .ensoul/plugins/<id> */
async function pluginRoundTrip() {
  // 造一个"无脸插件"（只有工具、没有界面）放在工作区的插件根下，然后拿打包台导出
  const srcDir = path.join(WS, '.ensoul', 'plugins', 'notepad');
  fs.mkdirSync(path.join(srcDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.js'), 'module.exports = { name: "notepad", description: "x", setup() {} };');
  fs.writeFileSync(path.join(srcDir, 'lib', 'util.js'), 'module.exports = 1;');

  const packager = require(path.join(ROOT, 'plugins', 'git-packager', 'index.js'));
  let exportTool = null;
  const pApi = makeApi(WS);
  pApi.addTool = (spec, fn) => { if (spec.name === 'packager_export_pack') exportTool = fn; };
  packager.setup(pApi);
  if (!exportTool) { ok(false, '端到端·插件：没拿到 export_pack'); return; }

  const msg = await exportTool({ id: 'notepad', type: 'plugin', outPath: 'exports/notepad.ensoulpack' });
  const outAbs = path.join(WS, 'exports', 'notepad.ensoulpack');
  ok(fs.existsSync(outAbs), '端到端·插件：导出成功 —— ' + String(msg).slice(0, 90));
  if (!fs.existsSync(outAbs)) return;

  // 导出完把原件挪走，再看装包能不能把它原样装回来（这才叫真正的往返）
  fs.rmSync(srcDir, { recursive: true, force: true });
  ok(!fs.existsSync(srcDir), '端到端·插件：原件已移走，接下来全靠这个包');

  const plan = planPluginPack(fs.readFileSync(outAbs), {
    curVersion: '0.1.0',
    installedPlugins: [],
  });
  ok(plan.id === 'notepad', '端到端·插件：包里的 id 认出来了');
  const { writeBytes } = require(path.join(ROOT, 'dist', 'main', 'fsapi.js'));
  for (const f of plan.files) writeBytes(plan.targetDir + '/' + f.rel, f.data);
  ok(fs.existsSync(path.join(srcDir, 'index.js')), '端到端·插件：装回来了 —— index.js 在');
  ok(fs.existsSync(path.join(srcDir, 'lib', 'util.js')), '端到端·插件：子目录也装回来了');
  ok(require(path.join(srcDir, 'index.js')).name === 'notepad', '端到端·插件：装回来能 require 起来');
}

(async () => {
  containerTests();
  sanitizeTests();
  planTests();
  installTests();
  await componentRoundTrip();
  await rejectComponent();
  await pluginRoundTrip();
  console.log('');
  console.log(fails ? '❌ ' + fails + ' 条没过' : '✅ 全部通过');
  process.exit(fails ? 1 : 0);
})();
