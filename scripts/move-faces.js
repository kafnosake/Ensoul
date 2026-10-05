// 一次性搬迁脚本：把 pomodoro / todo 两张"脸"搬进各自的插件目录，皮跟着走。
// 搬完这个脚本就删 —— 它记的是搬迁前的行号，留着只会误导。
const fs = require('fs');

const log = (...a) => console.log(...a);

// ---------------------------------------------------------------- 脸：pomodoro
{
  const src = 'src/renderer/panel/Pomodoro.tsx';
  let s = fs.readFileSync(src, 'utf8');
  const hits = [];
  const sub = (a, b, label) => {
    if (!s.includes(a)) { hits.push('没命中：' + label); return; }
    s = s.split(a).join(b);
    hits.push('ok  ' + label);
  };

  sub("import type { Panel } from '../../shared/types';",
      "import type { PanelFaceProps } from '../../src/shared/types';", '改类型 import');
  sub("import { api } from '../core/api';\n", '', '删 api import');
  sub('api.fs.', 'fs.', 'api.fs → fs');
  sub('export function Pomodoro({ panel }: { panel: Panel })',
      'export default function Pomodoro({ panel, fs }: PanelFaceProps)', '默认导出 + 收 fs');

  const n = (s.match(/(?<!function )enqueue\(/g) || []).length;
  sub('function enqueue(payload: Record<string, unknown>)',
      "function enqueue(fs: PanelFaceProps['fs'], payload: Record<string, unknown>)", 'enqueue 收 fs 参数');
  s = s.replace(/(?<!function )enqueue\(/g, 'enqueue(fs, ');

  fs.writeFileSync('plugins/pomodoro/panel.tsx', s);
  log('plugins/pomodoro/panel.tsx  ' + s.split(/\r?\n/).length + ' 行');
  hits.forEach((h) => log('   ' + h));
  log('   enqueue 调用点改成 enqueue(fs, …)：' + n + ' 处（应为 0 或正整数）');
  log('   还有 api. 残留吗：' + (s.includes('api.') ? '有！要看' : '没有'));
  fs.unlinkSync(src);
  log('   旧文件已删：' + src);
}

// ------------------------------------------------------------------- 脸：todo
{
  const src = 'src/renderer/panel/TodoPanel.tsx';
  let s = fs.readFileSync(src, 'utf8');
  const hits = [];
  const sub = (a, b, label) => {
    if (!s.includes(a)) { hits.push('没命中：' + label); return; }
    s = s.split(a).join(b);
    hits.push('ok  ' + label);
  };

  sub("import type { Panel } from '../../shared/types';",
      "import type { PanelFaceProps } from '../../src/shared/types';", '改类型 import');
  sub("import { api } from '../core/api';\n", '', '删 api import');
  sub('api.fs.', 'fs.', 'api.fs → fs');
  sub('export function TodoPanel({ panel }: { panel: Panel })',
      'export default function TodoPanel({ panel, fs }: PanelFaceProps)', '默认导出 + 收 fs');

  fs.writeFileSync('plugins/todo/panel.tsx', s);
  log('plugins/todo/panel.tsx  ' + s.split(/\r?\n/).length + ' 行');
  hits.forEach((h) => log('   ' + h));
  log('   还有 api. 残留吗：' + (s.includes('api.') ? '有！要看' : '没有'));
  fs.unlinkSync(src);
  log('   旧文件已删：' + src);
}

// -------------------------------------------------------------------- 皮
fs.copyFileSync('src/renderer/ui/styles/pomodoro.css', 'plugins/pomodoro/panel.css');
log('plugins/pomodoro/panel.css  ' + fs.statSync('plugins/pomodoro/panel.css').size + ' 字节');
fs.unlinkSync('src/renderer/ui/styles/pomodoro.css');

let st = fs.readFileSync('src/renderer/ui/styles.css', 'utf8');
const before = st;
st = st.split(/\r?\n/).filter((l) => !l.includes('styles/pomodoro.css')).join('\n');
fs.writeFileSync('src/renderer/ui/styles.css', st);
log('styles.css 去掉番茄钟那行 @import：' + (st !== before ? 'ok' : '没命中，要看'));

// ------------------------------------------------------------- 插件里的声明
const addDecl = (file, text) => {
  let s = fs.readFileSync(file, 'utf8');
  if (/^\s*panel:/m.test(s)) { log(file + '  已经有 panel 声明，跳过'); return; }
  const i = s.indexOf('module.exports = {');
  if (i < 0) { log(file + '  找不到 module.exports，没插进去'); return; }
  s = s.slice(0, i) + text + s.slice(i);
  fs.writeFileSync(file, s);
  log(file + '  已插入 panel 声明');
};

addDecl('plugins/pomodoro/index.js', `  /**
   * 自带一种面板类型。声明是**纯数据**（它要过 IPC，函数过不去）；脸在 panel.tsx、
   * 皮在 panel.css —— 渲染层扫 plugins/*/panel.tsx 和 *.css 自动收走。
   * 加这一整套不用核心动一行：核心只按这份声明装配。
   */
  panel: {
    kind: 'pomodoro',
    label: '番茄钟',
    hint: '专注 25 分钟，休息 5 分钟',
    title: '番茄钟',
    body: 'messages',
  },

`);

addDecl('plugins/todo/index.js', `  /** 自带一种面板类型：清单的脸在 panel.tsx（见 plugins/pomodoro/index.js 里那段说明） */
  panel: {
    kind: 'todo',
    label: '任务清单',
    hint: '助手写下的待办与进度（todo_write 写的那一份）',
    title: '任务清单',
    body: 'messages',
  },

`);

// ---------------------------------------------------------------- tsconfig
let t = fs.readFileSync('tsconfig.json', 'utf8');
const tb = t;
t = t.replace('"include": ["src/renderer", "src/shared"]',
              '"include": ["src/renderer", "src/shared", "plugins/*/panel.tsx"]');
fs.writeFileSync('tsconfig.json', t);
log('tsconfig 把插件的脸也纳入类型检查：' + (t !== tb ? 'ok' : '没命中，要看'));
