/**
 * 文案扫描 —— 把界面里**还没翻**的中文抠出来，交给翻译的人。
 *
 * 为什么要有它：让人直接改 226 个源码文件去套 t() 是灾难（CRLF、JSX、模板串，
 * 一个手滑就是白屏）。改成三步之后，「翻译」和「改代码」彻底分开：
 *
 *   1. node scripts/i18n-scan.js collect src/renderer -o out.json   抠出待翻条目
 *   2. 翻译的人在 out.json 里填 en 字段（**不碰代码**）
 *   3. node scripts/i18n-scan.js merge out.json                     并进词典
 *
 * 于是翻译的人填错词最多是某一句不对，不可能把界面搞崩；改代码的人也不必懂英文。
 *
 * 用法：
 *   node scripts/i18n-scan.js scan <目录...>        每个文件还剩多少条
 *   node scripts/i18n-scan.js collect <目录...> -o out.json
 *   node scripts/i18n-scan.js merge <填好的.json>
 */
const fs = require('fs');
const path = require('path');

const CJK = /[\u4e00-\u9fa5]/;
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', '.scratch', '.vite', 'work', 'plugin-state']);
const CODE_EXT = /\.(ts|tsx|js|jsx)$/;

/** 词典里已经有的 key —— 不重复报、也不重复翻 */
function existingKeys() {
  const out = new Set();
  for (const f of ['src/shared/i18n.ts', 'src/shared/i18n.prompts.ts']) {
    let s = '';
    try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const re = /(?:^|\n)\s*(?:'((?:[^'\\]|\\.)*)'|([\w\u4e00-\u9fa5]+))\s*:\s*(?:'|\x60)/g;
    let m;
    while ((m = re.exec(s))) {
      const k = String(m[1] == null ? m[2] : m[1]).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      if (k && CJK.test(k)) out.add(k);
    }
  }
  return out;
}

function files(targets) {
  const out = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isFile()) { if (CODE_EXT.test(p)) out.push(p); return; }
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(path.join(p, e.name));
    }
  };
  for (const t of targets) walk(t);
  return out;
}

/** 一行里的中文候选：引号里那一段 + JSX 裸文本。不做语义分析，宁可多报不许漏报 */
function stringsInLine(line) {
  const found = [];
  const re = /(['"])((?:[^'"\n]|\\.)*?)\1/g;
  let m;
  while ((m = re.exec(line))) { if (CJK.test(m[2])) found.push(m[2]); }
  const jsx = line.match(/>[^<>{}]*[\u4e00-\u9fa5][^<>{}]*</g) || [];
  for (const j of jsx) found.push(j.slice(1, -1).trim());
  return found;
}

function collect(targets) {
  const have = existingKeys();
  const entries = new Map();
  for (const f of files(targets)) {
    const rel = path.relative(process.cwd(), f).split(path.sep).join('/');
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const tr = line.trim();
      if (tr.startsWith('//') || tr.startsWith('*') || tr.startsWith('/*')) return;
      for (const s of stringsInLine(line)) {
        const zh = s.trim();
        if (zh.length < 2 || !CJK.test(zh)) continue;
        if (have.has(zh)) continue;
        if (!entries.has(zh)) entries.set(zh, []);
        const where = entries.get(zh);
        if (where.length < 6) where.push(rel + ':' + (i + 1));
      }
    });
  }
  return [...entries.entries()].map(([zh, where]) => ({ zh: zh, len: zh.length, where: where, en: '' }))
    .sort((a, b) => b.len - a.len);
}

/** 把填好的英文并进 src/shared/i18n.ts 的 EN 表 */
function merge(file) {
  const add = JSON.parse(fs.readFileSync(file, 'utf8'));
  const target = 'src/shared/i18n.ts';
  let s = fs.readFileSync(target, 'utf8');
  const anchor = '\n};\n\nconst DICT';
  const at = s.indexOf(anchor);
  if (at < 0) throw new Error('找不到 EN 表收尾锚点，别乱动那个文件');
  const esc = (v) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const pairs = [];
  const skipped = [];
  for (const e of add) {
    if (!e.zh || !e.en) continue;
    const key = /^[A-Za-z_$][\w$]*$/.test(e.zh) ? e.zh : "'" + esc(e.zh) + "'";
    if (s.includes('\n  ' + key + ':')) { skipped.push(e.zh); continue; }
    pairs.push('  ' + key + ": '" + esc(e.en) + "',");
  }
  s = s.slice(0, at) + '\n' + pairs.join('\n') + s.slice(at);
  fs.writeFileSync(target, s);
  console.log('并入 ' + pairs.length + ' 条' + (skipped.length ? '，跳过已存在 ' + skipped.length + ' 条' : ''));
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const outIdx = argv.indexOf('-o');
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
const targets = (outIdx >= 0 ? argv.slice(1, outIdx) : argv.slice(1)).filter(Boolean);

if (cmd === 'scan') {
  const have = existingKeys();
  console.log('词典里已有 ' + have.size + ' 条');
  for (const f of files(targets)) {
    const rel = path.relative(process.cwd(), f).split(path.sep).join('/');
    const n = collect([f]).length;
    if (n) console.log(String(n).padStart(5) + '  ' + rel);
  }
} else if (cmd === 'collect') {
  const list = collect(targets);
  console.log('待翻 ' + list.length + ' 条，共 ' + list.reduce((a, b) => a + b.len, 0) + ' 个中文字');
  if (outFile) { fs.writeFileSync(outFile, JSON.stringify(list, null, 2)); console.log('已写 ' + outFile); }
} else if (cmd === 'merge') {
  merge(targets[0]);
} else {
  console.log('用法：scan | collect | merge，见文件头注释');
}