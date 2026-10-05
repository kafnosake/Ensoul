/**
 * 解耦体检 —— 「后端脱离 Electron」这件事，此刻做到哪了。
 *
 * 为什么要它：这件事的验收标准只有一条，而且**不需要开窗口**就能量：
 * 把 dist/main 下每个模块直接 require 一遍。能加载进来 = 这条链一行 electron 都不沾。
 *
 * 于是它成了防退化的闸门：以后谁在业务文件顶上顺手写一句 `import ... from 'electron'`，
 * 这里立刻变红 —— 而不是等到某天想跑纯 Node 后端时才发现早就断了。
 *
 * 跑法：
 *   npm run build:main
 *   node scripts/check-decouple.js
 *
 * ── 两张名单，判定标准不一样 ─────────────────────────────────────────
 *
 *   业务链 BUSINESS  必须**全部**可加载。少一个都是欠账。
 *   壳层   SHELL     本来就归 Electron（窗口、托盘、缩放、崩溃弹窗）——
 *                    它们加载失败是**设计如此**，不算欠账，只报数。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
// 没有主进程在场时，工作区路径得有个落处，否则 fsapi 在建目录时就炸了
process.env.ENSOUL_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-decouple-'));

/** 业务链：后端跑起来真正需要的那一半，必须零 electron */
const BUSINESS = [
  'paths',            // 路径
  'host',             // 宿主能力接口（空实现那一份）
  'store',            // 状态真源
  'workspace',        // 布局纯函数
  'fsapi',            // 文件
  'providers',        // 模型与计价
  'skills',           // 技能
  'prompt-composer',  // 提示词拼装
  'ptc',              // 代码沙盒
  'plugins',          // 插件宿主
  'agent',            // 工具
  'chat-core',        // 对话内核
  'migrate',          // 搬家
  'layout-report',    // 布局描述
  'project',          // 构建 / 重启
  'rpc',              // 能力表
  'server',           // 电话线（HTTP RPC）
];

/** 壳层：窗口硬件。import electron 是本职，不要求纯 Node 能加载 */
const SHELL = ['crash', 'daemon', 'windows', 'zoom', 'host-electron', 'index'];

function probe(name) {
  const file = path.join(ROOT, 'dist', 'main', name + '.js');
  if (!fs.existsSync(file)) return { name, ok: false, why: '没构建出来（先跑 npm run build:main）' };
  try {
    require(file);
    return { name, ok: true };
  } catch (e) {
    return { name, ok: false, why: String(e && e.message).slice(0, 100) };
  }
}

console.log('── 业务链（必须全部通过）──');
const bizBad = [];
for (const m of BUSINESS) {
  const r = probe(m);
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${m}${r.ok ? '' : '  — ' + r.why}`);
  if (!r.ok) bizBad.push(m);
}

console.log('');
console.log('── 壳层（依赖 electron 是本分，仅供参考）──');
let shellOk = 0;
for (const m of SHELL) {
  const r = probe(m);
  if (r.ok) shellOk++;
  console.log(`${r.ok ? '可加载' : '要 Electron'}  ${m}${r.ok ? '' : '  — ' + r.why}`);
}

console.log('');
console.log(`业务链 ${BUSINESS.length - bizBad.length} / ${BUSINESS.length} 通过`);
console.log(`壳层   ${shellOk} / ${SHELL.length} 可加载（本来就不要求）`);
console.log(`本次进程 electron = ${process.versions.electron}（undefined 才对）`);

if (bizBad.length) {
  console.log('');
  console.log('欠账：' + bizBad.join(', '));
  process.exitCode = 1;
}
