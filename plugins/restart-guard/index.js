/**
 * 重启这件事，只许走 restart_project。
 *
 * agent 想"让改动生效"时很容易自己做主：起个 powershell、把 ensoul 杀掉、再用
 * node scripts/launch.js 拉起来。这条路在这个运行时里**必翻车** —— run_command /
 * job_start 起的进程都是 ensoul 的子进程，命令一返回就被连坐收走；于是它以为
 * "已经发了"，日志里却一个字都没有，用户看到的是"你没发啊"。
 *
 * 核心早就为这件事留了正路：restart_project（被 restart-approval 拦成一条界面请求，
 * 用户点头才真做）。这里做两件事：
 *   1. **堵死歪路**（onBeforeTool）—— 命令碰本体就弹回正路；
 *   2. **让每块面板开局就知道规矩**（addPrompt）—— 不靠"犯错后被拦"，
 *      以后新开的任何面板，提示里本身就带着这条，压根不会去试歪路。
 *
 * 判据是"这段命令**会改变进程状态**，且动的是 ensoul 本体" —— 不是"命令里有危险词"。
 * 所以：
 *   · npm run build、git、跑测试、跑自检一律放行；
 *   · Get-Process / Get-CimInstance / Select-String / Test-Path 这类**只读查询**
 *     即使提到 ensoul.exe 也放行（2026-10-09 修：上一版把只读查询也拦了，
 *     agent 连"现在有几个实例、日志写了什么"都查不了）；
 *   · taskkill / Stop-Process / start / schtasks / Invoke-CimMethod Create、
 *     直接执行 scripts/launch.js、直接起 ensoul.exe —— 只要沾上 ensoul 就挡下。
 *
 * 命令体会深挖两层：base64 / -EncodedCommand 解出来看；命令里显式执行的脚本
 * （-File、node <脚本>、& '<路径>'、cmd /c）读进来一起看，脚本里再嵌 base64 也解。
 */

const fs = require('fs');
const path = require('path');

/** 应用根 —— 本插件住在 <根>/plugins/<名>/ */
const APP_ROOT = path.resolve(__dirname, '..', '..');
const APP_LOWER = APP_ROOT.toLowerCase();

/** 只有这两个工具能起任意命令 */
const SHELL_TOOLS = new Set(['run_command', 'job_start']);

/** 一出现就说明在碰 ensoul 本体：品牌可执行文件、本项目的启动器 */
const APPLIANCE = /ensoul\.exe|scripts[\\/]launch\.js/i;

/** **会改变进程状态**的动作：杀 / 起 / 定时。纯查询不在其列 */
const PROC_ACTION =
  /\b(taskkill|stop-process|terminate-process|killall|pkill|start-process|invoke-cimmethod|schtasks|wmic)\b|\.kill\s*\(/i;

/** 把本体**当命令执行**（不是"提到它"，是"跑它"） */
const INVOKE_APPLIANCE =
  /(^|[\s&|;])["']?[^\s"'|&;]*ensoul\.exe|\bnode(?:\.exe)?\s+["']?[^\s"']*launch\.js/i;

/** ensoul 这个词 */
const MENTION = /ensoul/i;

/** 在 ensoul 自己的工作区里 npm start / npm run app 就是拉起本体 */
const NPM_LAUNCH = /\bnpm(?:\.cmd)?\s+(?:run\s+)?(?:start|app)\b/i;

/** 一眼看得出不动物体的只读命令 —— 没有配套的动进程动作时就放行 */
const READONLY =
  /\b(get-content|get-item|get-childitem|get-process|get-ciminstance|select-string|test-path|findstr|tasklist|format-list|format-table|measure-object|where-object)\b|node\s+--check\b/i;

/** 值得读进来看的脚本后缀 */
const SCRIPT_EXT = new Set(['.js', '.cjs', '.mjs', '.ps1', '.cmd', '.bat', '.sh', '.py']);
/** 单个脚本读进来的上限 */
const MAX_SCRIPT = 256 * 1024;
/** 解出来的文本总量上限 */
const MAX_UNPACKED = 512 * 1024;

/** 解出来的内容得基本是可打印文本才值得看 */
function printable(text) {
  if (!text || text.length < 8) return false;
  let ok = 0;
  for (const ch of text) if (ch >= ' ' || ch === '\n' || ch === '\r' || ch === '\t') ok += 1;
  return ok / text.length > 0.85;
}

/** 命令体里的 base64 / -EncodedCommand：解出来一起看 */
function unpackBlobs(text, acc) {
  const plain = /[A-Za-z0-9+/]{80,}={0,2}/g;
  let m;
  while ((m = plain.exec(text))) {
    try {
      const s = Buffer.from(m[0], 'base64').toString('utf8');
      if (printable(s)) acc.push(s);
    } catch { /* 不是合法 base64 就算了 */ }
  }
  // PowerShell 的 -EncodedCommand 是 UTF-16LE
  const enc = /-(?:encodedcommand|enc|e)\s+(["']?)([A-Za-z0-9+/=]{40,})\1/gi;
  while ((m = enc.exec(text))) {
    try {
      const s = Buffer.from(m[2], 'base64').toString('utf16le');
      if (printable(s)) acc.push(s);
    } catch { /* 同上 */ }
  }
}

/**
 * 命令里显式执行的脚本文件，读进来一起看。
 * 路径先按 workdir 折绝对，再洗掉 cmd 转义留下的引号 / 反斜杠 —— 不洗的话
 * `node \"D:\x.ps1\"` 这种写法会对不上真文件（这正是上一版的漏网）。
 */
function unpackScripts(text, acc, base) {
  // cmd / PowerShell 里转义过的引号（node \"D:\x.ps1\"）先还原 ——
  // 不还原的话路径会在反斜杠处断开，真文件永远对不上（上一版的漏网就在这）
  const clean = text.replace(/\\(["'])/g, '$1');
  const FORMS = [
    /-file\s+(["']?)([^"'\s]+)\1/gi,
    /\b(?:node|node\.exe|python|python3|py)\s+(["']?)([^"'\s]+)\1/gi,
    /&\s*(["'])([^"'\s]+)\1/g,
    /\bcmd(?:\.exe)?\s+\/c\s+(["']?)([^"'\s]+)\1/gi,
  ];
  for (const re of FORMS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(clean))) {
      const cand = String(m[2] || '').replace(/^[\\"']+|[\\"']+$/g, '');
      if (!cand || cand.startsWith('-')) continue;
      if (!SCRIPT_EXT.has(path.extname(cand).toLowerCase())) continue;
      try {
        const target = path.resolve(base || APP_ROOT, cand);
        const st = fs.statSync(target);
        if (!st.isFile() || st.size > MAX_SCRIPT) continue;
        const s = fs.readFileSync(target, 'utf8');
        if (!printable(s)) continue;
        acc.push(s);
        unpackBlobs(s, acc); // 脚本里再嵌一层 base64 也解出来
      } catch { /* 文件不在 / 读不动，就当没有 */ }
    }
  }
}

/** 把一条命令拍平成"实际会跑到的东西"——原文 + 解出来的各层 */
function flatten(raw, base) {
  const acc = [raw];
  unpackBlobs(raw, acc);
  unpackScripts(raw, acc, base);
  return acc.join('\n').slice(0, MAX_UNPACKED);
}

/** 每块面板、每一轮都摆在模型眼前的规矩 —— 不靠拦，靠它一开始就知道 */
function restartRules() {
  return [
    t('【重启 / 启动本应用，只有这几条路】'),
    t('· 让改动生效：调 restart_project（它先构建，再在界面上摆一条确认请求，用户点头才真做）。'),
    t('· 只是想把应用拉起来：start_project；想让它停下：stop_project。'),
    t('· 不要用 run_command / job_start 去杀或拉起本应用本体（taskkill、Stop-Process、schtasks、start ensoul.exe、scripts/launch.js 都一样）—— 那些命令起的进程会被连坐收走，你看着像"发了"，实际一行日志都没有，用户只会看到"你没发"。'),
    t('· 改了 src/main 必须真重启；只改界面（src/renderer、src/shared、插件里的 panel.tsx）不用重启，界面会自动重建上屏。'),
  ].join('\n');
}

module.exports = {
  name: 'restart-guard',
  description: t('不许用命令行杀或拉起 ensoul 本体：重启走 restart_project，启动走 start_project'),

  setup(api) {
    // 一、让规矩**常驻在每块面板的提示里**（以后新开的面板同样自动带上）
    api.addPrompt(() => restartRules());

    // 二、兜底拦截：真去动了本体就把这次调用弹回正路
    api.onBeforeTool((call) => {
      if (!call || !call.args || !SHELL_TOOLS.has(call.name)) return;
      const raw = String(call.args.command || '');
      if (!raw) return;

      const base = path.resolve(String(api.workspace || APP_ROOT), String(call.args.workdir || ''));
      const hay = flatten(raw, base);

      const mutating = PROC_ACTION.test(hay);
      const appliance = APPLIANCE.test(hay);
      const mentioned = MENTION.test(hay);
      const inApp = base.toLowerCase() === APP_LOWER;
      const byNpm = inApp && NPM_LAUNCH.test(hay);

      // 只读查询（没有任何会改变进程状态的动作）一律放行 —— 数实例、看日志、翻源码
      if (READONLY.test(hay) && !mutating) return;

      const hit =
        (mutating && (appliance || mentioned)) ||
        INVOKE_APPLIANCE.test(hay) ||
        byNpm;
      if (!hit) return;

      return [
        t('没有执行：这条命令在动 ensoul 应用自身的进程。'),
        t('用命令行杀 / 拉 ensoul 在这个运行时里成不了 —— run_command / job_start 起的进程都是 ensoul 的子进程，命令一返回就被连坐收走，你只会以为「发了」，实际一行日志都没有。'),
        t('让改动生效：调 restart_project（会先构建，再摆一条界面请求等用户点头）。'),
        t('只是想把应用拉起来：start_project；想让它停下：stop_project。'),
      ].join('\n');
    });
  },
};
