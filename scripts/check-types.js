/**
 * 渲染层类型门禁 —— 「改完不看类型就出货」这件事的闸门。
 *
 * 为什么要有它：build:main 本来就是 tsc，**主进程一直有这道关**；只有渲染层没有 ——
 * build:renderer 走 vite，esbuild 只剥类型、不看类型。于是 groupOf(t: number) 里
 * 一句 t('更早')（形参把 import 进来的 t() 挡住了）能一路溜到用户面前：
 * 产物里翻成 U0(s){…s("更早")}，跑起来才报 "s is not a function"，
 * 当场炸掉**所有** chat 面板。tsc 抓这个错是零误报的（TS2349 数字不可调用）。
 *
 * ── 为什么是棘轮，不是一刀切 ─────────────────────────────────────────
 * 存量还挂着一批类型错误（记账见 scripts/type-baseline.json）。直接挂死会挡住今天的
 * 构建，于是一个都不修 —— 那是反效果。棘轮只咬**新增**：存量记账放着，谁新添一笔当场变红。
 * 存量清掉一点，就 --update 收紧一点，直到归零。
 *
 * 跑法：
 *   node scripts/check-types.js            # 只拦新增（build 里走这条）
 *   node scripts/check-types.js --update   # 清完存量，把基线收紧到现在
 *   node scripts/check-types.js --all      # 一条都不许有（基线归零后用它）
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(__dirname, 'type-baseline.json');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

const args = process.argv.slice(2);
const update = args.includes('--update');
const strict = args.includes('--all');

/**
 * 错误按「文件|错误码」分桶计数 —— **不拿行号做键**：行号随编辑天天漂，
 * 拿它当键会让棘轮天天误报，误报几次就没人看了。
 */
function run() {
  if (!fs.existsSync(TSC)) {
    console.error('找不到 typescript —— 先 npm install');
    process.exit(2);
  }
  const r = spawnSync(process.execPath, [TSC, '-p', 'tsconfig.json'], { cwd: ROOT, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const buckets = new Map();
  const items = [];
  for (const raw of out.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(raw.trim());
    if (!m) continue;
    const file = m[1].replace(/\\/g, '/');
    const key = file + '|' + m[4];
    buckets.set(key, (buckets.get(key) || 0) + 1);
    items.push({ file, line: Number(m[2]), code: m[4], msg: m[5], key });
  }
  return { buckets, items };
}

const { buckets, items } = run();

function writeBaseline(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  fs.writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}

if (update) {
  const obj = {};
  for (const [k, n] of buckets) obj[k] = n;
  writeBaseline(obj);
  console.log('基线已收紧：' + Object.keys(obj).length + ' 笔记账，共 ' + items.length + ' 个错误');
  process.exit(0);
}

let base = {};
try {
  base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
} catch {
  base = {};
}

const regressions = [];
const debts = [];
let stored = 0;

for (const [key, n] of buckets) {
  const allowed = strict ? 0 : base[key] || 0;
  stored += Math.min(n, allowed);
  if (n > allowed) regressions.push({ key, n, allowed, over: n - allowed });
  else if (n < allowed) debts.push({ key, n, allowed });
}

// 基线里记着、这次一个都没有了 = 已经修好，可以收紧
const cleared = [];
for (const key of Object.keys(base)) {
  if (!buckets.has(key)) cleared.push({ key, allowed: base[key] });
}

if (regressions.length) {
  console.log('');
  console.log('── 类型门禁：拦下 ' + regressions.length + ' 处**新增**错误 ──');
  for (const r of regressions) {
    const [file, code] = r.key.split('|');
    console.log('  ' + code + '  ' + file + '   （基线 ' + r.allowed + ' → 现在 ' + r.n + '）');
  }
  const shown = new Set(regressions.map((r) => r.key));
  const detail = items.filter((it) => shown.has(it.key));
  console.log('');
  console.log('  原文：');
  for (const d of detail.slice(0, 25)) {
    console.log('    ' + d.file + '(' + d.line + '): ' + d.code + ': ' + d.msg.slice(0, 160));
  }
  if (detail.length > 25) console.log('    ……还有 ' + (detail.length - 25) + ' 条');
  console.log('');
  console.log('  这几条是**这次改出来的**。修掉，或者（确认是误报时）用');
  console.log('  node scripts/check-types.js --update 重新记账。');
  console.log('');
  process.exit(1);
}

console.log('类型门禁：通过（存量记账 ' + stored + ' 条，没有新增）');
if (cleared.length) {
  console.log('  ↓ 这些桶已经清空，可以 --update 收紧基线：');
  for (const c of cleared.slice(0, 20)) console.log('    ' + c.key.split('|')[1] + '  ' + c.key.split('|')[0]);
}
if (debts.length) {
  console.log('  ↓ 这些桶变少了，可以 --update 收紧：');
  for (const d of debts.slice(0, 20)) console.log('    ' + d.key.split('|')[1] + '  ' + d.key.split('|')[0] + '  ' + d.allowed + ' → ' + d.n);
}
process.exit(0);
