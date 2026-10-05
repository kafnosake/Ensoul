/**
 * 插件面板隔离扫描 —— make-plugin SKILL.md §六 的机器版。
 *
 * 为什么要有它：这个软件里**同时有好几块面板在跑不同的活**。插件只要有一个"单槽"
 * （一个全局表、一份不带 id 的状态文件、一个不看 ctx 的 addPrompt），N 块面板就被黏成一块 ——
 * 症状是"A 面板干着干着，开始干 B 的活"。这种错**不报错、不崩、不闪**，
 * 只在人真用起来的时候才现形，所以得有个能跑的检查兜住它。
 *
 * 跑法：
 *   node scripts/audit-plugins.js              扫全部插件
 *   node scripts/audit-plugins.js todo jobs    只扫这几个
 *
 * 它做的是**静态启发式判断**：命中某个口子、附近一大段里又找不到 panelId，就报一条。
 * 所以它的用处是"漏不掉"，不是"替人下结论" —— 有告警就自己看一眼，确实不该分面板的，
 * 往下面 EXEMPT 里写一条并说清为什么，别让下一个人重新猜一遍。有告警退出码为 1。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'plugins');
/** 判据的"附近"有多大：钩子/状态调用前后这么多行里找 panelId */
const NEAR = 60;

const RULES = [
  {
    id: 'command',
    label: '斜杠命令',
    hit: /api\.addCommand\(/,
    file: /^index\.js$/,
    need: /ctx/,
    why: '命令 handler 必须收下 ctx（拿得到 panelId 才知道是哪块面板敲的它，结果才不会记到别人头上）',
  },
  {
    id: 'prompt',
    label: '每轮注入',
    hit: /api\.addPrompt\(/,
    file: /^index\.js$/,
    need: /panelId/,
    why: 'addPrompt 必须只交这块面板的正文（ctx.panelId），否则 A 的清单/提醒会摆到 B 眼前，B 就丢下自己的活去干 A 的',
  },
  {
    id: 'memory',
    label: '内存表',
    hit: /new (Map|Set)\(/,
    file: /^index\.js$/,
    need: /panelId/,
    /** 只看模块级的（顶格那一行）—— 函数里的临时 Set 活在一次调用里，跨不了面板 */
    top: true,
    why: '模块级表要拿 panelId 当 key（或者 key 里带上它），否则所有面板共用一份指纹/计数，两块面板会互相打断',
  },
  {
    id: 'state',
    label: '状态文件',
    hit: /api\.state\.save\(/,
    file: /^index\.js$/,
    need: /panelId/,
    why: '落盘状态要按面板分槽（panels[panelId]），单槽会被后写的整个盖掉，而读的人还以为那是自己的',
  },
  {
    id: 'cmd',
    label: '命令文件',
    hit: /\.cmd\.json/,
    file: /^index\.js$/,
    need: /panelId/,
    why: '命令文件每条要带 panelId，插件只认属于自己那块面板的那条',
  },
];

/** 确实不该按面板分的，写明白为什么 —— 这是给人看的，不是给判据开的后门 */
const EXEMPT = [
  { plugin: 'dispatch', rule: 'memory', why: 'panelStamp 是**按面板 id** 存的（applyPending 里 get/set 都用 p.id，就是面板 id）—— 它记的是"这块面板的对话长度 / 压到哪了"，用来判提示词缓存还热不热；判据认的字面是 panelId，那两处离声明 95 行、超出「附近」的 60 行' },
  { plugin: 'remote', rule: 'state', why: '远程访问的开关/端口/隧道属于整台机器一份，不属于任何一块面板' },
  { plugin: 'remote', rule: 'cmd', why: '同上：remote 的命令是"开/关/换端口"，改的是机器的状态，不是某块面板的活' },
  { plugin: 'work-ledger', rule: 'state', why: '台账按**文件**分槽（files[路径] = 谁改的、什么时候），不按面板 —— 它记的就是"这个文件被别的面板动过"这个跨面板事实，按面板分槽等于把台账切成 N 份，正好看不见别人。' },
  { plugin: 'work-ledger', rule: 'memory', why: 'WRITE_TOOLS / BUILD_TOOLS 是工具名白名单（哪些算"改文件"、哪些算"跑构建"）—— 定义域是工具名不是面板，全局一份才对，跟 ui-refresh 的 EXTS 同一条道理' },
  { plugin: 'pomodoro', rule: 'cmd', why: '命令在 applyCmd 里按 raw.panelId 认槽，判据的"附近"够不着，人工复核过' },
  { plugin: 'codex-radar', rule: 'cmd', why: '命令在 applyCmd 里按 raw.panelId 认槽（每条队列项都由脸带上 panelId），命中的两处是文件头常量和注释，判据的「附近」够不着' },
  { plugin: 'codex-radar', rule: 'memory', why: 'cache 是 codex-resets.com 那一份**全站同一份**的重置动态快照（十几分钟才动一次）—— 它不是某块面板的东西，各面板各抓一次只会重复打同一个接口；数据落到各自槽位后由面板读各自的' },
  { plugin: 'schedule', rule: 'state', why: 'state 里每条任务、每条到点记录都带 panelId（normalize 里就有），只是离 save 那行远了点' },
  { plugin: 'library', rule: 'state', why: '组件库是这一整个工作区共享的一张架子（跟工作区文件同级）：组件本来就该被所有面板看得见、调得动，按面板分槽反而会让存在 A 面板里的组件在 B 面板上凭空消失。归属只在命令队列里认（每条带 panelId）' },
  { plugin: 'library', rule: 'cmd', why: '命令每条都带 panelId（脸写进队列、applyCmd 按它认归属），只是判据的「附近」够不着文件头那两处常量和注释' },
  { plugin: 'ui-refresh', rule: 'memory', why: 'EXTS 是扩展名白名单（.tsx/.ts/.css/.html 该不该触发刷新）—— 定义域是"文件类型"不是"面板"，全局一份才对；按面板分反而会让同一种文件在不同面板下刷新行为不一致' },
  { plugin: 'whale-pet', rule: 'state', why: 'DeepSeek 余额是这一个账户一份，不属于任何一块面板 —— 所有鲸鱼娘面板显示的本就是同一份余额，按面板分槽只会让每块面板各自查一次 API' },
  { plugin: 'whale-pet', rule: 'cmd', why: '命令（刷新余额 / 打开用量页）每条都带 panelId（脸写进队列），但动作本身改的是账户级状态，谁点的都照办；判据的「附近」够不着文件头常量和注释' },
  { plugin: 'git', rule: 'prompt', why: 'git 局面（分支 / 改动 / 未跟踪文件）是工作区级的事实：一个工作区只有一份仓库，两块面板看到的分支和改动必然相同，按面板分槽反而让每块面板各自维护一份假象。跟 AGENTS.md、工作区文件同级' },
  { plugin: 'git', rule: 'state', why: '同上：状态就是这一刻的 git 局面，不存在「A 面板的改动」和「B 面板的改动」。归属只在命令队列里认（每条带 panelId，记下是哪个面板点的按钮）' },
  { plugin: 'git', rule: 'cmd', why: '命令每条都带 panelId（脸写进队列、applyCmds 按它记日志），只是判据的「附近」够不着文件头那两处常量' },
  { plugin: 'our-free-model', rule: 'cmd', why: '命令每条都带 panelId（脸写进队列、applyCmd 按它记日志），但动作改的是整个工作区一份的服务（一个转发口、一轮探测），谁点的都照办；判据的「附近」够不着文件头那两处常量' },
  { plugin: 'canvas', rule: 'cmd', why: '命令每条都带 panelId（pushOp 脸写进队列、runCmd 按 cmd.panelId 认槽），命中的三处是文件头常量和注释，判据的「附近」够不着队列那半边' },
  { plugin: 'histconv', rule: 'cmd', why: '每条命令必带 pid（就是面板 id，runCmd 没有 pid 直接不办），按它认历史文件的归属；判据认的字面是 panelId，队列那半边离文件头常量太远' },
  { plugin: 'histconv', rule: 'memory', why: 'boxes 按 pid、cache 按面板 id 做 key（openBox / get 处就看得见），天生按面板分槽；lastTouch 也是——pid → 这块面板最后一次动过的时间，问的就是"这一块"，天然按面板分槽。prevAlive 记的是「上一拍哪些面板还活着」——它要的正是全量名单（收走消失面板的账），按面板分反而没法工作。四张表的 key 都离声明那几行远了点' },
  { plugin: 'eschat', rule: 'memory', why: 'dormCache 是后台面板目录的索引缓存（按目录 mtime 失效），所有 eschat 面板看的是同一份目录，按面板分槽只会复制 N份相同扫描；noThink 记「哪个员工已关过思考」——动作落在员工角色卡上、不在面板上，按面板分会让同一员工被关两次' },
  { plugin: 'git-packager', rule: 'cmd', why: '命令每条都带 panelId（脸写进队列），打包台管理的是开源发布的全局排除清单与 .gitignore，跟 git/library 插件同级' },
];

const names = fs.existsSync(DIR)
  ? fs.readdirSync(DIR).filter((n) => fs.statSync(path.join(DIR, n)).isDirectory())
  : [];
const pick = process.argv.slice(2);
const targets = pick.length ? names.filter((n) => pick.includes(n)) : names;

const exempted = [];
let warns = 0;

function scanFile(plugin, file) {
  const full = path.join(DIR, plugin, file);
  const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
  for (const rule of RULES) {
    if (!rule.file.test(file)) continue;
    lines.forEach((text, i) => {
      if (!rule.hit.test(text)) return;
      if (rule.top && /^\s/.test(text)) return;
      const from = Math.max(0, i - NEAR);
      const near = lines.slice(from, Math.min(lines.length, i + NEAR + 1)).join('\n');
      if (rule.need.test(near)) return;
      const ex = EXEMPT.find((e) => e.plugin === plugin && e.rule === rule.id);
      const at = `plugins/${plugin}/${file}:${i + 1}`;
      if (ex) {
        exempted.push({ at, rule: rule.id, label: rule.label, code: text.trim().slice(0, 70), why: ex.why });
        return;
      }
      warns += 1;
      console.log(`WARN  ${at}  [${rule.label}]  ${text.trim().slice(0, 70)}`);
      console.log(`      → ${rule.why}`);
    });
  }
}

console.log(`插件面板隔离扫描（make-plugin §六）：${targets.length} 个插件 × ${RULES.length} 条判据`);
console.log('');

for (const plugin of targets) {
  const dir = path.join(DIR, plugin);
  const files = fs.readdirSync(dir).filter((f) => /^(index\.js|panel\.tsx)$/.test(f));
  if (!files.length) {
    console.log(`skip  plugins/${plugin}（没有 index.js / panel.tsx）`);
    continue;
  }
  const before = warns;
  for (const f of files) scanFile(plugin, f);
  if (warns === before) console.log(`ok    plugins/${plugin}`);
}

const scanned = targets.length;
console.log('');
console.log(`扫了 ${scanned} 个插件：${warns} 条告警，${exempted.length} 处豁免（写在脚本的 EXEMPT 里）。`);

if (exempted.length) {
  console.log('');
  console.log('豁免的（不是没问题，是这里说清了为什么不按面板分）：');
  for (const e of exempted) console.log(`  · ${e.at}  [${e.label}]  ${e.why}`);
}

if (warns) {
  console.log('');
  console.log('告警的看一遍：真该按面板分的就照 §六 改；确实不该分的，往 EXEMPT 里补一条并写清为什么。');
}

process.exit(warns ? 1 : 0);
