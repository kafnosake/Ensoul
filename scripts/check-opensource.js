#!/usr/bin/env node
/**
 * 开源包体检 —— 别人 clone 下来，能不能顺顺当当起得来。
 *
 * ── 它答的是哪一个问题 ────────────────────────────────────────────────
 *
 * 打包台（git-packager）管的是"哪些资产不上传"：它列排除项、写 .gitignore。
 * 但它管不到另一件事：**核心的代码里还认不认这些排除项**。
 *
 * 认了就出事。核心 import 一个不在开源包里的插件文件 → vite 解析不到 → 构建直接失败
 * （这事真发生过：WidgetShell 静态 import 了 plugins/widget-dock/DesktopSurface）。
 * 比它轻一点的是"核心留着某个排除项的名字、状态文件、词典条目"：构建过得去，
 * 但开源出去的那份代码里挂着一串"点了没反应"的东西，别人查半天才发现是缺插件。
 *
 * 所以这道体检只问一件事：**排除项的名字，在 src/ 里还有没有**。
 *
 * ── 三种命中，三种性质 ────────────────────────────────────────────────
 *
 *   import  「静态 import 了排除项目录」—— **致命**，构建会断，必须修
 *   path    「代码里写着排除项的状态文件 / 目录名」—— 该修，核心不该知道
 *   word    「注释、文案、词典里出现了这个词」—— 看情况，人名地名不算
 *
 * 退出码：致命命中就 1，其余 0 —— 好让它在 CI / 验收里当门禁用。
 *
 * 用法：node scripts/check-opensource.js [--all]
 *   --all 连 plugins/ 下那几个排除项目录自己也报（默认不报：内部还要用它们）
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
/** 排除项从**一个地方**读：打包台写进 .gitignore 的那一段。不另抄一份名单 —— 抄了就会对不上。 */
const GITIGNORE = path.join(ROOT, '.gitignore');
const START = '# <<< ENSOUL_PACKAGER_EXCLUDES_START >>>';
const END = '# <<< ENSOUL_PACKAGER_EXCLUDES_END >>>';

function excludedNames() {
  let text = '';
  try {
    text = fs.readFileSync(GITIGNORE, 'utf8');
  } catch {
    return [];
  }
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a < 0 || b < 0) return [];
  const out = [];
  for (const line of text.slice(a + START.length, b).split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    // 只认 plugins/<名>/ 这一种：组件、员工卡之类的不算"名字"，它们不是代码
    const m = t.match(/^plugins\/([^/]+)\/?$/);
    // 裸 \`git\` 不算：它在核心到处都是正当用法（.gitignore、git 状态条、git 命令），
    // 任务点名的也是 git-packager。同理只认"名字里有辨识度"的那几个。
    if (m && m[1] !== 'git') out.push(m[1]);
  }
  return [...new Set(out)].sort();
}

const SCAN_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * 这几个词**在英文里本来就有正当意思**：canvas = 画布，schedule = 调度，git = 版本控制。
 * 光看见字母就报，等于天天喊狼来了 —— 门禁一旦有噪音，就没人再看它。
 * 所以它们要**当标识符用**才算（被引号包住、带下划线、或是个状态文件名）：
 *   'canvas'  canvas_read  schedule.json  plugins/schedule   ← 算（这是插件的名字）
 *   canvas 画布   schedule a task  调度                        ← 不算（那是这个词本身）
 */
const WORDY = new Set(['canvas', 'schedule', 'git']);
/** 一眼就是插件专属术语的中文词 —— 出现在核心里必是残留 */
const TERMS = [
  '像素画板', '像素画布', '无限画布', '无限画板', '白板', '桌面组件', '桌面挂件', '桌面手势',
  '沉进桌面层', '开源打包台', '打包台', '桌宠', '语音输入', 'SenseVoice', 'Our Free Model',
];
const skipDir = (d) => d === 'node_modules' || d === '.git' || d === 'dist' || d === '.tmp' || d === '.ensoul' || d === 'work';

function walk(dir, out = []) {
  let items = [];
  try {
    items = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of items) {
    if (skipDir(f)) continue;
    const full = path.join(dir, f);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (SCAN_EXT.test(f)) out.push(full);
  }
  return out;
}

/**
 * 词典（i18n.ts / i18n.prompts.ts）是**共享资源**：核心和开源包里的插件都从它取词。
 * 一个词条只要还有开源包里的代码用着，它就是正当的 —— 哪怕词里提到某个排除项
 * （dispatch 的 kit 标签叫「无限画布」，可 dispatch 自己是开源包里的）。
 * 所以查词典时只报**没人用**的那几条。
 */
function usedOutside(roots, i18nFiles, names) {
  const used = new Set();
  const files = [];
  for (const root of roots) {
    for (const f of walk(root)) {
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      // 排除项插件自己不算：它们不随开源包外发
      if (names.some((n) => rel.startsWith('plugins/' + n + '/'))) continue;
      files.push(f);
    }
  }
  for (const f of files) {
    if (i18nFiles.includes(path.relative(ROOT, f).replace(/\\/g, '/'))) continue;
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const re of [/\bt\(\s*'((?:[^'\\]|\\.)*)'/g, /\bt\(\s*"((?:[^"\\]|\\.)*)"/g]) {
      let m;
      while ((m = re.exec(text))) used.add(m[1].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
    }
  }
  return used;
}

function main() {
  const all = process.argv.includes('--all');
  const names = excludedNames();

  if (!names.length) {
    console.log('排除清单是空的（.gitignore 里没有那段标记）—— 没什么可查的。');
    return 0;
  }

  const targets = all ? [...walk('src'), ...walk('plugins')] : walk('src').filter((f) => {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    // plugins/<排除项>/ 里的自己不该报自己 —— 它们内部当然会提自己的名字
    return !names.some((n) => rel.startsWith('plugins/' + n + '/'));
  });

  const I18N_FILES = ['src/shared/i18n.ts', 'src/shared/i18n.prompts.ts'];
  /** GLOSSARY 是术语表（画布→canvas 这种词对词），只给翻译当参照，不是文案词条 */
  const GLOSSARY_RANGE = (() => {
    const L = fs.readFileSync(path.join(ROOT, 'src/shared/i18n.ts'), 'utf8').split('\n');
    const a = L.findIndex((l) => /^export const GLOSSARY/.test(l));
    const b = L.findIndex((l, i) => i > a && /^\};/.test(l));
    return a < 0 || b < 0 ? null : [a + 1, b + 1];
  })();
  const stillUsed = usedOutside(['src', 'plugins'], I18N_FILES, names);

  const fatal = [];
  const soft = [];

  for (const file of targets) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    let lines = [];
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n');
    } catch {
      continue;
    }
    lines.forEach((line, i) => {
      /*
       * 词典（i18n.ts / i18n.prompts.ts）单独一套判据：
       *   · **还有开源包里的代码在用**这条 → 正当（它是共享资源，核心和插件都从它取词）
       *   · 没人用、词里又出现排除项的名字 → 残留（那是替不上传的插件留的词条）
       * 不能只看"行里有没有那个字母"：英文里 canvas's、scheduled、git 到处都是正当用法。
       */
      if (I18N_FILES.includes(rel)) {
        if (rel === 'src/shared/i18n.ts' && GLOSSARY_RANGE && i + 1 >= GLOSSARY_RANGE[0] && i + 1 <= GLOSSARY_RANGE[1]) return;
        const km = line.match(/^\s*"((?:[^"\\]|\\.)*)"\s*:/);
        if (!km) return;
        let key = km[1];
        try { key = JSON.parse('"' + km[1] + '"'); } catch { /* 原样用 */ }
        if (stillUsed.has(key)) return;
        const terms = TERMS.some((w) => key.includes(w));
        const named = names.some((n) => !WORDY.has(n) ? new RegExp('(^|[^A-Za-z0-9_-])' + n + '($|[^A-Za-z0-9_-])').test(key) : false);
        if (!terms && !named) return;
        soft.push({ at: rel + ':' + (i + 1), n: 'i18n', body: '没人用的词条：' + key.slice(0, 90), kind: 'dead' });
        return;
      }
      for (const n of names) {
        if (!line.includes(n)) continue;
        // 中文术语命中：直接算残留
        const byTerm = TERMS.some((w) => line.includes(w));
        if (!byTerm && WORDY.has(n)) {
          const asIdent =
            new RegExp("(['\"\`])" + n + "\\1").test(line) ||
            new RegExp("\\b" + n + "(_|\\.json|\\.cmd|\\b\\s*:)").test(line) ||
            new RegExp("plugins/" + n).test(line);
          if (!asIdent) continue;
        }
        const at = rel + ':' + (i + 1);
        const body = line.trim().slice(0, 120);
        // 静态 import 到排除项目录里 —— 构建会断
        if (new RegExp("(from|require\\(|import\\()\\s*['\"][^'\"]*(plugins/|\\.\\./)+" + n + "/").test(line)) {
          fatal.push({ at, n, body });
        } else if (/['"\`][^'"\`]*\.json|\\.ensoul\/state\/|plugins\//.test(line)) {
          soft.push({ at, n, body, kind: 'path' });
        } else {
          soft.push({ at, n, body, kind: 'word' });
        }
      }
    });
  }

  console.log('排除项名单（来自 .gitignore 的打包台段落）：' + names.join('、'));
  console.log('扫了 ' + targets.length + ' 个文件（' + (all ? 'src/ + plugins/' : 'src/') + '）\n');

  if (!fatal.length && !soft.length) {
    console.log('✅ 干净：排除项的名字在' + (all ? '代码里' : ' src/ 里') + '一个都没有。');
    console.log('   别人 clone 下来构建不会因为缺插件而断。');
    return 0;
  }

  if (fatal.length) {
    console.log('❌ 致命 ' + fatal.length + ' 处 —— 静态 import 了不在开源包里的文件，构建会断：');
    for (const h of fatal) console.log('   ' + h.at + '  [' + h.n + ']\n     ' + h.body);
    console.log('');
  }
  if (soft.length) {
    console.log((fatal.length ? '⚠ ' : '⚠ ') + '待看 ' + soft.length + ' 处（名字出现在代码/文案里）：');
    for (const h of soft) console.log('   ' + h.at + '  [' + h.n + '/' + h.kind + ']\n     ' + h.body);
    console.log('');
  }

  return fatal.length ? 1 : 0;
}

process.exit(main());
