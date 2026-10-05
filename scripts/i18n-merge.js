const fs = require('fs');
/**
 * 把翻译交上来的 JSON 并进词典 —— 契约 docs/i18n.md 的第三步。
 *
 * 为什么不手抄：2000 多条里夹着换行、单引号、反引号，手抄必炸。这里统一走 JSON.stringify：
 * 键和值都生成合法的 TS 字面量，换行、引号、反斜杠全都自动转义。
 *
 * 分两处放（跟词典本身一样）：含换行或长过 60 字的进 EN_PROMPTS，其余进 EN。
 *
 * 用法：node scripts/i18n-merge.js work/i18n/done/plugins.json [更多.json ...]
 */
const SHORT = 'src/shared/i18n.ts';
const LONG = 'src/shared/i18n.prompts.ts';
const LONG_AT = 60;

function keysOf(file) {
  const out = new Set();
  let s = '';
  try { s = fs.readFileSync(file, 'utf8'); } catch { return out; }
  const re = /^\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([A-Za-z_$][\w$]*))\s*:/gm;
  let m;
  while ((m = re.exec(s))) {
    const raw = m[1] != null ? '"' + m[1] + '"' : m[2] != null ? "'" + m[2] + "'" : null;
    if (raw == null) { out.add(m[3]); continue; }
    try { out.add(JSON.parse(raw)); } catch { out.add(m[1] != null ? m[1] : m[2]); }
  }
  return out;
}

const files = process.argv.slice(2);
if (!files.length) { console.log('用法：node scripts/i18n-merge.js <填好的.json> ...'); process.exit(1); }

const have = new Set([...keysOf(SHORT), ...keysOf(LONG)]);
const short = [];
const long = [];
let dup = 0;
for (const f of files) {
  let list;
  try { list = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.log('跳过 ' + f + '：' + e.message); continue; }
  for (const e of list) {
    if (!e.zh || !e.en || !String(e.en).trim()) continue;
    if (have.has(e.zh)) { dup++; continue; }
    have.add(e.zh);
    const isLong = /[\r\n]/.test(e.zh) || /[\r\n]/.test(e.en) || e.zh.length > LONG_AT;
    (isLong ? long : short).push(e);
  }
}

const shortKey = (l) => {
  const m = l.match(/^\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([A-Za-z_$\u4e00-\u9fa5][^:\n]*?))\s*:/);
  if (!m) return null;
  const k = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
  return String(k).trim();
};

const line = (e) => '  ' + JSON.stringify(e.zh) + ': ' + JSON.stringify(e.en) + ',';

/*
 * 去重：同一个 key 只能有一条。
 *
 * 合并脚本会把同一批 key 反复并入（每轮交付都重跑），TS 遇到重复属性直接报错、
 * 整个界面白屏。所以写入前先把表里已有的同名 key 摘掉 —— 后写的为准。
 */
function dedupeTable(src, keyOf) {
  const lines = src.split('\n');
  const first = lines.findIndex((l) => /^const EN: Record|^export const EN_PROMPTS/.test(l));
  const last = lines.findIndex((l, i) => i > first && /^\};/.test(l));
  if (first < 0 || last < 0) return src;
  const seen = new Set();
  const out = [];
  // 从后往前扫：保留最后一条，删掉前面重复的
  const marks = new Array(last - first - 1).fill(true);
  for (let i = last - 1; i > first; i--) {
    const k = keyOf(lines[i]);
    if (k === null) continue;
    if (seen.has(k)) marks[i - first - 1] = false;
    else seen.add(k);
  }
  for (let i = first + 1; i < last; i++) if (marks[i - first - 1]) out.push(lines[i]);
  return [...lines.slice(0, first + 1), ...out, ...lines.slice(last)].join('\n');
}

if (short.length) {
  let s = fs.readFileSync(SHORT, 'utf8');
  const anchor = '\n};\n\nconst DICT';
  const at = s.indexOf(anchor);
  if (at < 0) throw new Error('找不到 EN 表收尾锚点，别乱动那个文件');
  s = s.slice(0, at) + '\n' + short.map(line).join('\n') + s.slice(at);
  s = dedupeTable(s, shortKey);
  fs.writeFileSync(SHORT, s);
}

if (long.length) {
  let s = fs.readFileSync(LONG, 'utf8');
  const empty = s.match(/export const EN_PROMPTS[^=]*= \{\};/);
  if (empty) {
    s = s.replace(empty[0], 'export const EN_PROMPTS: Record<string, string> = {\n' + long.map(line).join('\n') + '\n};');
  } else {
    const at = s.lastIndexOf('};');
    if (at < 0) throw new Error('找不到 EN_PROMPTS 收尾');
    s = s.slice(0, at) + long.map(line).join('\n') + '\n' + s.slice(at);
  }
  s = dedupeTable(s, shortKey);
  fs.writeFileSync(LONG, s);
}

console.log('并入短词 ' + short.length + ' 条 → ' + SHORT);
console.log('并入长句 ' + long.length + ' 条 → ' + LONG);
if (dup) console.log('跳过已有 ' + dup + ' 条');