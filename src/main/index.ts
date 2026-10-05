import { BrowserWindow, Menu, app, dialog, ipcMain as rawIpcMain, shell } from 'electron';
import { rpcChannels, rpcCount, wrapIpcMain } from './rpc';
import { rpcToken, startRpcServer } from './server';
import { host as HOST, setHost } from './host';
import { electronHost } from './host-electron';
import { appDir, appVersion, userDataPath } from './paths';
import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage, ChatStats, DockTarget, FloatingWindow, LiveTask, ModelConfig, OutboxItem, Panel, PanelMode, PanelRevision, RetryView } from '../shared/types';
import { MAIN_HOST } from '../shared/types';
import appIdentity from '../shared/app-identity.json';
import { planPluginPack } from '../shared/ensoulpack';
import { matchPanelAvatarFamily } from '../shared/panel-avatars';
import { executeRunCode, getRunCodeToolSpec, renderToolsSdk } from './ptc';
import { commitPromptBaseline, consumePromptDeltas } from './prompt-composer';
import { askOnce, buildPanelSnapshot, buildSystemPrompt, extractEditProposal, failLabel, modeSection, runAgent, summarizeSession, type SteerItem } from './chat-core';
import { describeTool, runTool, runToolConfirmed, setExtensions, toolsFor } from './agent';
import { readSkill, scanSkills, skillRoots, skillsDir } from './skills';
import { loadPlugins, pluginsDir, runSettingsAction, setAskHandler, setChatClearer, setChatCompressor, setChatSender, setChatSteerer, setLiveSink, setRunningProbe, setChatEnqueuer, setModelAsker, setModelCatalog, setPluginParam, setProviderUpserter, setCredentialReader, setCredentialWriter, setRefresher, setToolLister, settingsSectionView, settingsSections, type AskSpec, type SlashCommandReg, type StatusItem } from './plugins';
import type { PluginPrompt, ToolContext } from './plugins';
import { emitReasoning } from './plugins';
import { describeLayout } from './layout-report';
import { store } from './store';
import { migrateUserData, migrateWorkspaceState } from './migrate';
import { listDir, readText, readJsonSnapshot, setUnconfinedSource, setWorkspaceRoot as setFsRoot, workspaceRoot, writeBytes, writeText } from './fsapi';
import { PRESETS, catalog, costOf, describePick, listModels, priceOf, providersPath, remove as removeProvider, resolvePick, upsert } from './providers';
import { keyOf as credentialOf, setKey as setCredential } from './credentials';
import { windows, type DropHit } from './windows';
import { applyTo, getZoom, loadZoom, setZoom, ZOOM_MAX, ZOOM_MIN } from './zoom';
import { getLang, loadLang, setLang } from './lang';
import { installCrashGuard } from './crash';
import { daemonActive, destroyTray, markQuitting, onBeforeRelaunch, quitApp, setupTray, syncDockWithWidgets } from './daemon';
import * as W from './workspace';
import { t } from '../shared/i18n';
import { RunRegistry } from './run-registry';
import { setProjectBuilder, setTaskApi } from './plugins';
import { build as buildProject, buildRenderer, buildApp } from './project';
import { TaskService } from './task-service';

// 同一个应用永远只留一个实例 —— 手跑一遍 启动.sh、npm run app、或者任何路径
// 拉起来的第二份，都在这里直接退出（exit 而不是 quit：quit 走关闭流程，窗口会闪一下），
// 并把已有那个窗口顶到最前面。没有这条锁，每多起一次就多叠一个窗口，
// 两份实例还要抢同一份 .ensoul/state 和 store。
app.setName('ensoul');
process.title = 'ensoul';
if (process.platform === 'win32') app.setAppUserModelId(appIdentity.appId);
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.exit(0);
}

// 越早装越好：晚一秒，就有一秒的死法是静默的
installCrashGuard();

/*
 * 装上**真正的宿主实现**（见 host.ts / host-electron.ts）。
 *
 * 这一行不能省：业务层现在只认 `HOST` 这个门面，而门面默认背后是那份
 * **空实现**（要窗口没有、要广播没人听）。不装的话，症状是"界面半死不活"——
 *   · `HOST.broadcast(...)` 全被丢掉 → 撕标签时那句 `win:liveReady` 发不出去，
 *     渲染层永远不知道跟随窗口起来了 → **标签拖不动**；
 *   · `HOST.windowFromEvent(e)` 永远 null → 窗口按钮点了没反应、
 *     `win:tearEnd` 直接 return（松手也算不出往哪儿落）。
 * 两件事都不报错，只是安静地不工作 —— 所以必须在这里显式装上。
 */
setHost(electronHost);

if (process.platform === 'win32') {
  // 消除 Windows 无边框窗口遮挡探测带来的输入排队与光标/键盘迟滞
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,CalculateNativeWinOcclusionAfterInit');
}

app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.focus();
});

/**
 * 主进程入口：只做编排。
 *
 *   布局 —— 面板与停靠树（纯函数在 workspace.ts，真源在 store.ts）
 *   窗口 —— 浮窗就是另一棵停靠树（windows.ts）
 *   对话 —— 每个面板自己就是一个对话框，模型可以改写这个面板自己
 *
 * 一次动作的固定节奏：改 store → sync 窗口 → 广播。
 */

/**
 * macOS 上必须有一套应用菜单 —— 这不是"要不要给用户菜单栏"的选择题。
 *
 * mac 的快捷键由菜单栏绑定，跟 Windows 直接由控件处理不一样：没有 Edit 菜单里
 * 那几个标准角色（undo / cut / copy / paste / selectAll），输入框里的
 * Cmd+C / Cmd+V / Cmd+A 全是死键 —— 界面上看不出任何异常，用户只会觉得
 * "粘贴不进去"。同理没有 App 菜单就没有 Cmd+Q / Cmd+W，只能去 Dock 上强退。
 *
 * Windows 那条路一个字没动：这里直接 return，菜单栏照旧不存在（窗口自带标题栏，
 * 再挂一条菜单只是白占一行）。
 */
function installAppMenu() {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' }, // 关于 / 隐藏 / 退出（Cmd+Q）
      { role: 'editMenu' }, // 撤销 / 剪切 / 复制 / 粘贴 / 全选
      { role: 'windowMenu' }, // 最小化 / 缩放 / Cmd+W
    ]),
  );
}

const refresh = () => {
  windows.sync();
  /*
   * macOS：Dock 露不露脸。
   *
   * 判据是"除挂件之外还有没有正经窗口"—— 只有桌面小东西活着的时候，Dock 里
   * 不该再占一格（那时入口是菜单栏那个图标）；一旦有主界面或浮窗，就还回来。
   * 这里所有平台都调，Windows 上是空操作（见 daemon.ts）。
   *
   * 放在 refresh 里而不是某个"挂件开关"上：挂件的增减本来就都走这条路，
   * 挂在这里自然跟着每一次布局变化走，不用再散点去接。
   */
  syncDockWithWidgets(windows.frameWindowCount() === 0 && store.widgetList().length > 0);
  windows.broadcast();
};

/**
 * 待用户点头的请求。键是面板 id —— 请求是"这个会话提出来的"。
 *
 * 请求由**插件**提出（`api.ask`，见 plugins/restart-approval），核心只做两件事：
 * 把那条请求摆到界面上、用户点头之后替它跑一次工具调用。
 *
 * 为什么要人来点：这件事的一般形态是"那次调用会收掉这个进程本身"，而请求提出的那一刻
 * 这一轮还没跑完 —— 回复只在内存里、没进 store。自动执行等于把刚写的那段一起杀掉。
 * 用户不点，什么都不会发生。
 */
interface PendingAsk {
  host: string;
  kind: string;
  text: string;
  confirm: string;
  cancel: string;
  /** 第三个按钮：等所有会话都跑完再做（插件给文字，核心判时机），没这条就是两个按钮 */
  defer?: string;
  /** 用户已经选了"等所有会话结束"——请求留在原地，核心替它盯着时机 */
  armed?: boolean;
  then: { tool: string; args?: any };
}
const pendingAsk = new Map<string, PendingAsk>();

/** 全局是否有已挂起（等全部会话结束）的重启任务 */
const isRestartArmed = () => [...pendingAsk.values()].some((a) => a.then?.tool === 'restart_project' && a.armed);

/**
 * 开机接力：真重启会把旧进程整个收掉，等着接力那个 setTimeout 根本活不到那时候 ——
 * 所以由**新进程**开机时读纸条来发（见 registerIpc 里的 resumeOutbox / armResume）。
 */
let bootResumeOutbox: () => void = () => {};

/**
 * 一轮的**流水条**：开工写一条 running、每走一步更新一步、收尾改掉状态。
 *
 * 为什么非要有它：进程被杀 / 断电的时候，收尾那个 catch **一次都不会执行**，
 * 界面上的 error 也来不及写 —— 事后只能靠"事前落过一张纸"认出来。
 * 手法跟 pending-resume.json 一样，只是那个只管"重启前压着的一句话"，这个管每一轮。
 *
 * 开机时扫一遍：还挂着 running 的，就是上一个进程崩在半路留下的，改成 crashed 留证。
 */
const TURN_JOURNAL = ".ensoul/state/turn-journal.json";
let journalCache: any[] = [];
let journalLoaded = false;
const journalFile = () => path.join(workspaceRoot(), TURN_JOURNAL);
function journalRead(): any[] {
  if (journalLoaded) return journalCache;
  journalLoaded = true;
  try {
    const j = JSON.parse(fs.readFileSync(journalFile(), "utf8"));
    journalCache = Array.isArray(j && j.turns) ? j.turns : [];
  } catch {
    journalCache = [];
  }
  return journalCache;
}
function journalWrite() {
  const list = journalRead().slice(-20);
  journalCache = list;
  try {
    fs.mkdirSync(path.dirname(journalFile()), { recursive: true });
    fs.writeFileSync(journalFile(), JSON.stringify({ at: Date.now(), turns: list }, null, 2), "utf8");
  } catch {}
}
/** 开工：落一条 running —— 这是"它现在真在跑"的唯一凭据 */
function turnStart(panelId: string, at: number, text: string) {
  journalRead().push({ panelId, at, step: "", note: "", text: String(text || "").slice(0, 120), status: "running" });
  journalWrite();
}
function turnStep(panelId: string, step: string, note: string) {
  const list = journalRead();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].panelId === panelId && list[i].status === "running") {
      list[i].step = step;
      list[i].note = String(note || "").slice(0, 160);
      break;
    }
  }
  journalWrite();
}
function turnEnd(panelId: string, status: string) {
  const list = journalRead();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].panelId === panelId && list[i].status === "running") {
      list[i].status = status;
      list[i].endedAt = Date.now();
      break;
    }
  }
  journalWrite();
}
function sweepJournal(): number {
  let n = 0;
  for (const t of journalRead()) {
    if (t.status === "running") { t.status = "crashed"; t.endedAt = Date.now(); n += 1; }
  }
  if (n) journalWrite();
  return n;
}

/** 只把该给界面看的那几个字段给界面：谁提的、点了之后跑什么，渲染层不用认识 */
const askView = (a?: PendingAsk) =>
  a ? { text: a.text, confirm: a.confirm, cancel: a.cancel, defer: a.defer ?? '', armed: Boolean(a.armed) } : null;

/** 推给所有窗口：每个窗口里的对话区自己挑自己那条 */
function toAllWindows(channel: string, payload: any) {
  HOST.broadcast(channel, payload);
}

/**
 * 面板此刻住在哪 —— 告诉模型，它才知道自己在什么位置上被改写。
 *
 * 挂件窗口要单独说：它不在停靠树里（findPanel 找不到），但它照样是**活的面板**、
 * 照样会被对话改写。以前这里一律回“不在任何停靠位置” —— 模型看到那句就以为
 * 自己在对着一个不存在的东西说话，位置类的问题（“它在哪、多大”）它只能瞎猜。
 */
function describePlace(panelId: string): string {
  const w = store.panel(panelId)?.widget;
  if (w) {
    const bits = [
      t('自己是一扇挂在屏幕上的挂件窗口'),
      Math.round(w.x) + ',' + Math.round(w.y) + "  " + Math.round(w.width) + '×' + Math.round(w.height),
      w.transparent ? t('背景透明') : w.card ? t('近黑卡面') : '',
      w.onTop === false ? t('不置顶') : t('常驻置顶'),
    ].filter(Boolean);
    return bits.join(' · ') + t('（不在停靠树里；收回用 widget_dock action=off）');
  }
  const at = W.findPanel(store.state, panelId);
  if (!at) return t('不在任何停靠位置');
  return at.where === 'main' ? t('主窗口的标签组里') : t('一个独立浮窗里');
}

/**
 * 插件每轮交上来的补充说明（`api.addPrompt` 的产物）。
 *
 * 拼在本轮用户消息的末尾：它每轮都可能变（比如任务清单的进度），
 * 越容易变的东西越往后放，前面的缓存前缀才不会被它作废。
 * 一个插件出错不许影响别的插件，更不许影响这一轮对话。
 */
function pluginExtras(ctx: { panelId: string; host: string; kind: string }, fns: PluginPrompt[]): string {
  const parts: string[] = [];
  for (const p of fns) {
    // 声明了 scope 的片段只在自己那种面板上出声：别让 B 面板每轮读到 A 的活
    if (p.scope && p.scope.length && ctx.kind && !p.scope.includes(ctx.kind)) continue;
    const fn = p.fn;
    try {
      const text = fn(ctx);
      if (text && String(text).trim()) parts.push(String(text).trim());
    } catch (e: any) {
      console.error('[插件] addPrompt 出错：', e?.message ?? e);
    }
  }
  return parts.join('\n\n');
}

/** 模型上下文窗口（token）。真要准该从模型配置里读，这里先给个稳妥值 */
const CONTEXT_TOKENS = 128_000;
/**
 * 默认：到窗口的 80% 才压缩，逐字保留最近 16%。
 * 这个 80% 只在**缓存还热**时算数 —— 空闲过后门槛降到 COLD_COMPACT_AT（见下面）。
 */
const COMPACT_AT = Math.floor(CONTEXT_TOKENS * 0.8);
const RETAIN_TOKENS = Math.floor(CONTEXT_TOKENS * 0.16);
/**
 * 空闲到这一步，服务商的缓存基本已经过期。
 *
 * TTL 是服务端的事（各家从 5 分钟到几小时不等），客户端问不到也改不了 —— 只能估。
 * 这里取 4 小时，对齐 DeepSeek 文档给的下限（"几小时到几天"）：只在人明显离开过之后才认冷。
 * 判错的方向是不对称的，所以宁可判成"热"：判热只是放弃一次提前压（回到 80% 阈值，没有额外损失），
 * 判冷却可能在缓存还热着时动手，把本该命中的一轮打成全价。
 * 已知代价：对 TTL 只有 5 分钟的 Anthropic，这个门槛几乎永不触发 —— 它那侧的"空闲提前压"等于停用。
 */
const CACHE_IDLE_MS = 4 * 60 * 60_000;
/**
 * 缓存反正已经冷时，压缩是白捡的：那一轮每个 token 本来就要全价重算，
 * 把长会话压短，这一次就便宜 —— 所以门槛从 80% 降到 25%，且不看时间也别等它涨满。
 */
const COLD_COMPACT_AT = Math.floor(CONTEXT_TOKENS * 0.25);

/** 粗估 token：中文约一个字一个，代码/英文约四字符一个，取三折中；结构化工具存档（toolCalls）同样要计入 */
const estimateTokens = (msgs: ChatMessage[]) =>
  Math.round(
    msgs.reduce(
      (n, m) =>
        n
        + (m.content?.length ?? 0) / 3
        + (m.toolCalls?.reduce((t, c) => t + c.args.length + c.result.length, 0) ?? 0) / 3
        + (m.role === 'user' ? (m.images?.length ?? 0) : 0) * 800,
      0,
    ),
  );

/**
 * 压缩时用哪个模型写纪要：**问一遍插件**（`api.addCompactPick`），没人答、或者答的那个
 * 已经没了（提供方被删、模型被去掉），就用这块面板自己选的那个。
 *
 * 为什么要有这一问：写纪要是"把旧对话缩成条目"，不需要挑模型时看重的那个智商，
 * 而用户为了让聊天聪明往往把面板挂在最贵的一档 —— 压缩于是白付那份钱。
 * 挑谁是**策略**，不是核心该写死的道理，所以核心只留"问一句"这个动作。
 * 手动 /compress 与自动压缩共用这一份，改一处两条路都生效。
 */
function compactModelOf(
  picks: ((ctx: ToolContext | null) => string)[],
  ctx: ToolContext,
  fallback: ModelConfig,
): ModelConfig {
  for (const fn of picks) {
    let pick = '';
    try {
      pick = String(fn(ctx) ?? '').trim();
    } catch (e: any) {
      // 一个插件出错只算它没意见，压缩照常
      console.error('[插件] addCompactPick 出错：', e?.message ?? e);
      continue;
    }
    const r = pick ? resolvePick(pick) : null;
    // 还得真有密钥：配了提供方却忘了填 key 的话，用它去压只会拿到一个 401，
    // 那比"多花点钱"糟 —— 退回面板自己那个，压缩照常。
    if (r && r.apiKey) return { ...r, think: fallback.think };
  }
  return fallback;
}

/*
 * 便签（`==…==` 圈出来的重点）**不住在核心里**。
 *
 * 它是"这一路定过哪些事"的记录，跟权限、停靠树、对话本身都无关 —— 是一件**功能**，
 * 所以住在 plugins/notes：插件扫对话、写 `.ensoul/state/notes.json`，
 * 对话面板右边那一条读同一个文件。核心不认识便签，也就没人能把它的概念再钉回来。
 *
 * 两件当年由核心代劳、搬走之后刻意不住了的：
 *   1. 助手回复里的 `==…==` 归插件自己扫（去重按文本，重复扫不会重复记）；
 *   2. 压缩历史时把便签快照锚进摘要 —— 那要求"读插件状态"，核心不该读。
 *   2. 压缩历史时把便签快照锚进摘要 —— 那要求"读插件状态"，核心读不到也不该读。
 *      后来按当初说好的那个口子回来了：核心在压缩那一刻调 `api.addSummaryNote`
 *      问一句"有什么不能丢的"，答话的是 notes 插件。
 *      核心仍然不认识便签，它只认识"有插件想在摘要里留一句话"。
 */

/**
 * 剪贴板里的图落到磁盘。
 * 不把 base64 存进 workspace.json：那是全量读写的 JSON，塞几张截图进去，
 * 之后每次 save 都要序列化几 MB。
 */
function saveShot(dataUrl: string): string {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return '';
  const ext = m[1].split('/')[1].toLowerCase().replace('jpeg', 'jpg').replace('+xml', '');
  const dir = userDataPath('shots');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${ext}`);
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
    return file;
  } catch {
    return '';
  }
}

/** 磁盘上的图读回成模型要的形态 */
function shotPart(file: string) {
  const url = imageUrl(file);
  return url ? { type: 'image_url', image_url: { url } } : null;
}

/**
 * 一张图变成模型认的 URL —— **两种都给得进来**：
 *   · data URL：界面粘进输入框、还没落盘的那种；
 *   · 磁盘路径：待发队列里的那条（排队那一刻就已经落过盘了，路径才是它的原样）。
 * 读不动就返回 null（一张图不该把整轮对话打死）。
 */
function imageUrl(file: string): string | null {
  const s = String(file || '');
  if (!s) return null;
  // data URL 原样交给接口，不落盘也不解 base64
  if (/^data:image\//i.test(s)) return s;
  const ext = path.extname(s).slice(1).toLowerCase() || 'png';
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  try {
    return `data:${mime};base64,${fs.readFileSync(s).toString('base64')}`;
  } catch {
    return null;
  }
}

/** 排队 / 接力时收一张图：data URL 落盘成路径，已经是路径的原样留下（别丢） */
function keepShot(v: string): string {
  const s = String(v || '');
  if (/^data:image\//i.test(s)) return saveShot(s);
  return s && fs.existsSync(s) ? s : '';
}

/**
 * 把插件的状态部件接上。**启动时和每轮对话前各要一次** ——
 * 只在对话里接的话，重启之后到第一次发消息之前，输入框那一排是空的，
 * 看着就像这个功能没了。
 *
 * 插件里写的函数可能是烂的，所以逐个包一层 try：一个坏部件不能让整次广播挂掉。
 */
function wireStatus(items: StatusItem[]) {
  // 留一行痕迹：插件到底加载进来没有、挂上了几个部件。
  // 这东西出问题时的表现只是"界面空着"，没有日志就只能靠猜（今天就猜错了两轮）。
  try {
    fs.appendFileSync(
      userDataPath('plugins.log'),
      `[${new Date().toISOString()}] 状态部件 ${items.length} 个：${items.map((i) => i.id).join(', ') || '（无）'}\n`,
    );
  } catch {
    /* 记不上就算了，不能因为写日志挡住功能 */
  }

  store.setStatusSource((pid) =>
    items
      .map((s) => {
        try {
          const text = s.text(pid, null);
          if (!text) return null;
          return { id: s.id, slot: s.slot === 'head' ? ('head' as const) : ('composer' as const), text, title: s.title?.(pid, null) };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as { id: string; slot: 'composer' | 'head'; text: string; title?: string }[],
  );
}

/**
 * 插件注册的斜杠命令接上，和状态部件同一批线：开机、以及每条消息前各一次 ——
 * 插件可能刚被改过，候选表要跟着新。handler 不过 IPC，广播里只放画弹层要的字段。
 */
function wireCommands(items: SlashCommandReg[]) {
  store.setCommandSource(() => items.map(({ id, label, hint }) => ({ id, label, hint })));
}

/**
 * 把能力清单落盘。
 *
 * 为什么不只打一行日志：启动器用的是 `stdio: 'ignore'`（见 scripts/launch.js），
 * stdout 直接丢掉 —— 日志根本读不到。落盘才是**能被外部读到**的证据，
 * 顺带还是一件真有用的东西：从此"这软件有哪些能力"可以被程序问出来，
 * 而不是只存在于 Electron 的 ipcMain 里。
 */
function dumpRpcTable() {
  const channels = rpcChannels();
  const msg = `[能力清单] rpc 表里 ${rpcCount()} 条：${channels.slice(0, 8).join(', ')} …`;
  console.log(msg);
  try {
    const file = userDataPath('rpc-channels.json');
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), count: channels.length, channels }, null, 2));
  } catch (e: any) {
    console.error('[能力清单] 落盘失败：', e?.message ?? e);
  }
}

function registerIpc() {
  // 把真的 ipcMain 包一层：每条 handle 顺手抄进 rpc 表（见 rpc.ts）。
  // 下面这 100 条 handler **一个字都没改**，行为与包装前完全一致，
  // 多出来的只是：世上终于有一份知道"这软件有哪些能力"的清单。
  const ipcMain = wrapIpcMain(rawIpcMain);

  // ------------------------------------------------------------ 工作区
  ipcMain.handle('ws:state', () => store.publicState());

  // 布局骨架：抓当前工作区的形状 / 照一份形状重排。
  // 核心只知道"形状"，不知道"切片"这回事 —— 存在哪、叫什么名，全是用它的人的事。
  ipcMain.handle('layout:sketch', () => store.sketchLayout());
  ipcMain.handle('layout:apply', (_e, sketch: any, extra?: any) => {
    const ok = store.applySketch(sketch, extra);
    refresh();
    return ok;
  });

  // ------------------------------------------------------------ 面板
  ipcMain.handle('panel:create', (_e, partial: Partial<Panel>, target?: DockTarget) => {
    const panel = store.createPanel(partial ?? {}, target);
    refresh();
    return panel;
  });

  // 关闭 = 收进"最近关闭"，不是真删 —— 手滑关掉还能捞回来
  ipcMain.handle('panel:close', (_e, id: string) => {
    const ok = store.closePanel(id);
    refresh();
    return ok;
  });

  ipcMain.handle('panel:patch', (_e, id: string, patch: Partial<Panel>) => {
    const next = store.patchPanel(id, patch);
    // 纯草稿更新只持久化到 store，不向全窗口广播整棵工作区树，避免打字期间产生界面卡顿
    const keys = patch ? Object.keys(patch) : [];
    const onlyDraft = keys.length === 1 && keys[0] === 'draft';
    if (!onlyDraft) refresh();
    return next;
  });

  ipcMain.handle('panel:activate', (_e, id: string) => {
    if (store.panel(id)?.widget) windows.openWidgetEditor(id);
    else store.activate(id);
    refresh();
    return true;
  });

  /**
   * 一块面板的完整正文 —— 广播里只发骨架，正文按需拉。
   * 只有真正要画对话的那一块（ChatDock）会调它，一次一条，不再每广播一次拖十几 MB。
   */
  ipcMain.handle('panel:body', (_e, id: string) => store.panelFull(String(id || '')));

  ipcMain.handle('panel:rollback', (_e, id: string) => {
    const panel = store.panel(id);
    if (!panel || !panel.revisions || panel.revisions.length === 0) return false;
    const last = panel.revisions.pop()!;
    // 留存当前状态到 redo 栈（防止点错，支持双向恢复）
    if (!panel.redoRevisions) panel.redoRevisions = [];
    panel.redoRevisions.push({
      at: Date.now(),
      kind: panel.kind,
      title: panel.title,
      look: JSON.parse(JSON.stringify(panel.look || {})),
      spec: JSON.parse(JSON.stringify(panel.spec || {})),
      note: last.note ? `改动前：${last.note}` : t('回退前的状态'),
    });
    if (last.kind && last.kind !== panel.kind) {
      panel.kind = last.kind;
    }
    panel.title = last.title;
    panel.look = last.look;
    panel.spec = last.spec;
    panel.updatedAt = Date.now();
    store.save();
    refresh();
    return true;
  });

  ipcMain.handle('panel:redo', (_e, id: string) => {
    const panel = store.panel(id);
    if (!panel || !panel.redoRevisions || panel.redoRevisions.length === 0) return false;
    const next = panel.redoRevisions.pop()!;
    if (!panel.revisions) panel.revisions = [];
    panel.revisions.push({
      at: Date.now(),
      kind: panel.kind,
      title: panel.title,
      look: JSON.parse(JSON.stringify(panel.look || {})),
      spec: JSON.parse(JSON.stringify(panel.spec || {})),
      note: next.note,
    });
    if (next.kind && next.kind !== panel.kind) {
      panel.kind = next.kind;
    }
    panel.title = next.title;
    panel.look = next.look;
    panel.spec = next.spec;
    panel.updatedAt = Date.now();
    store.save();
    refresh();
    return true;
  });

  // ---------------------------------------------------------- 修订历史

  /** 某个面板改过哪些版本（新的在前） */
  ipcMain.handle('panel:history', (_e, panelId: string) => store.history(panelId));

  /** 恢复到指定那一版 —— 不用一版一版往回退 */
  ipcMain.handle('panel:restore', (_e, panelId: string, index: number) => {
    const ok = store.restoreRevision(panelId, index);
    refresh();
    return ok;
  });

  // ---------------------------------------------------------- 收纳区（顶上那条）

  ipcMain.handle('cmp:list', () => store.componentRefs());

  /** 这一页的两处来源各在哪、各几条 —— 空着的时候用它说清"为什么空" */
  ipcMain.handle('cmp:where', () => store.componentDirs());

  /** 把面板收进收纳区：整个面板（对话、草稿、状态）搬走，布局里把它摘掉 —— 顺手声明 + 钉住 */
  ipcMain.handle('cmp:save', (_e, panelId: string, name: string, targetIndex?: number) => {
    const c = store.stowPanel(panelId, name, targetIndex);
    refresh();
    return c;
  });

  /**
   * 把**整个标签组**收进收纳区：组里每个面板各收一件。
   *
   * 一组标签没有"本体"（收进去的是一个个面板），所以走的是同一段批量收纳，
   * 只是名单换成这一组里的全部。返回真收成的件数 —— 界面上要凭它说话。
   */
  ipcMain.handle('cmp:saveGroup', (_e, tabId: string, windowId?: string, targetIndex?: number) => {
    const n = store.stowTabGroup(tabId, windowId, targetIndex);
    refresh();
    return n;
  });

  /** 收纳区组件手动排序：拖拽重排后持久化保存 */
  ipcMain.handle('cmp:reorder', (_e, order: string[]) => {
    const ok = store.reorderComponents(order);
    refresh();
    return ok;
  });

  /**
   * 给一块面板写下**组件声明** —— 组件由这条进来才算数（类型不算数）。
   * 面板继续开着：声明只是把它永久保存下来，立刻出现在 设置 → 组件。
   * **不往顶上那条收纳区加东西** —— 那是 `cmp:pin` 的事，声明 ≠ 钉住。
   */
  ipcMain.handle('cmp:declare', (_e, panelId: string, name: string) => {
    const c = store.declareComponent(panelId, name);
    refresh();
    return c;
  });

  /** 给一条组件**改名**：声明名和面板标题一起改，做法文件跟着走 */
  ipcMain.handle('cmp:rename', (_e, id: string, name: string) => {
    const ok = store.renameComponent(id, name);
    refresh();
    return ok;
  });

  ipcMain.handle('cmp:remove', (_e, id: string) => {
    store.removeComponent(id);
    refresh();
    return store.componentRefs();
  });

  /** 收进顶上那条收纳区（钉住）—— 内容不动，只是条上多一格 */
  ipcMain.handle('cmp:pin', (_e, id: string) => {
    const ok = store.pinComponent(id);
    refresh();
    return ok;
  });

  /**
   * **释放**：从顶上那条撤下来。跟删除是两回事 —— 本体一个字符不丢，
   * 组件库里那一条照旧在、照样能打开。
   */
  ipcMain.handle('cmp:unpin', (_e, id: string) => {
    const ok = store.unpinComponent(id);
    refresh();
    return ok;
  });

  /** 克隆一条组件：照它这一刻的样子**再开一块新的**（新 id、新对话线程），原件不动 */
  ipcMain.handle('cmp:clone', (_e, id: string, target?: DockTarget, index?: number) => {
    const p = store.cloneComponent(id, target, index);
    refresh();
    return p?.id ?? null;
  });

  // 从收纳区打开面板：带了 target 就是"拖到哪儿就开在哪儿"。
  // 打开的是**同一个面板**（id 和对话都接着原来那份），不是照它复制一个；
  // 条目不消费 —— 已经开着就切过去/挪到落点，不开第二份，文件也一个字不动。
  ipcMain.handle('cmp:create', (_e, id: string, target?: DockTarget, index?: number) => {
    const p = store.openComponent(id, target, index);
    refresh();
    return p?.id ?? null;
  });

  /** 收纳区上最多摆几个 —— 纯显示偏好，但存进工作区，重启和换窗口都还在 */
  ipcMain.handle('cmp:setBarMax', (_e, n: number) => {
    store.setComponentBarMax(Number(n));
    refresh();
    return store.componentBarMax();
  });

  /**
   * 把一条组件**导出成一个文件** —— 导的是**做法**（类型、外观、提示词、按钮），
   * **对话不带**：那是这台机器上的工作记录，送组件不送聊天。
   */
  ipcMain.handle('cmp:export', async (_e, id: string) => {
    const pack = store.exportComponent(String(id || ''));
    if (!pack) return { ok: false, error: t('找不到这条组件的本体。') };
    // 文件名里不能出现 \ / : * ? " < > |，有些系统直接拒绝
    const safe = pack.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'component';
    const opts = {
      title: t('把这条组件导出成一个文件'),
      defaultPath: `${safe}.ensoul.json`,
      filters: [{ name: t('EnSoul 组件'), extensions: ['json'] }],
    };
    const r = await HOST.pickSaveFile(opts);
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(r.filePath, pack.json, 'utf8');
    } catch (e) {
      return { ok: false, error: `写不进去：${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true, path: r.filePath, bytes: Buffer.byteLength(pack.json, 'utf8') };
  });

  /** 导入一个组件文件 —— 落到 设置 → 组件 里（新面板 id，跟原件各是各的） */
  ipcMain.handle('cmp:import', async () => {
    const opts = {
      title: t('挑一个组件文件导进来'),
      properties: ['openFile' as const],
      filters: [{ name: t('EnSoul 组件'), extensions: ['json'] }],
    };
    const r = await HOST.pickOpenFile(opts);
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    try {
      const raw = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      const ref = store.importComponent(raw);
      if (!ref) return { ok: false, error: t('这个文件不像导出的组件（缺 component 那一段）。') };
      refresh();
      return { ok: true, name: ref.component || ref.name, id: ref.id };
    } catch (e) {
      return { ok: false, error: `读不了这个文件：${e instanceof Error ? e.message : String(e)}` };
    }
  });

  // ---------------------------------------------------------- 最近关闭

  ipcMain.handle('closed:list', () => store.closedPanels());

  /** 把收起来的面板放回来 */
  ipcMain.handle('closed:reopen', (_e, id: string) => {
    const ok = store.reopenPanel(id);
    refresh();
    return ok;
  });

  /** 彻底忘掉一条 */
  ipcMain.handle('closed:forget', (_e, id: string) => {
    store.forgetClosed(id);
    refresh();
    return store.closedPanels();
  });

  // ------------------------------------------------------------ 停靠（拖放的落点）
  /**
   * 唯一入口。mode = center 就是并入那个标签组；四边之一就是在那旁边
   * 自然分成新的一块 —— 没有单独的"切分"命令，分块是拖出来的结果。
   */
  ipcMain.handle('dock:drop', (_e, panelId: string, target: DockTarget, index?: number) => {
    if (!store.panel(panelId)) return false;
    store.dock(panelId, target, index);
    refresh();
    return true;
  });

  ipcMain.handle('dock:dropTab', (_e, tabId: string, target: DockTarget, fromWindowId?: string) => {
    store.dockTab(tabId, target, fromWindowId);
    refresh();
    return true;
  });

  /** 标签栏高度（浮窗和主窗口同一条，见 .tabstrip）—— 新浮窗的锚点压在它中间 */
  const STRIP_MID = 17;

  /** 把整个标签组拖出去 → 它自己变成一个新浮窗（组里的面板一起走） */
  ipcMain.handle('tabs:detach', (_e, tabId: string, fromWindowId?: string, rawSize?: any) => {
    const size = windows.floatSize(rawSize);
    // 和拖动途中撕出来的走**同一个锚点**：从哪条标签栏拖出去，手感都一样
    const win = store.detachTabGroup(tabId, anchoredAt(size, rawSize), fromWindowId, size);
    refresh();
    return Boolean(win);
  });

  ipcMain.handle('split:ratio', (_e, splitId: string, ratio: number, windowId?: string) => {
    store.setRatio(splitId, ratio, windowId);
    refresh();
    return true;
  });

  ipcMain.handle('tabs:close', (_e, tabId: string, windowId?: string) => {
    store.closeTabGroup(tabId, windowId);
    refresh();
    return true;
  });

  // ------------------------------------------------------------ 浮窗
  /**
   * 面板被拖出了**原来那条标签栏**（不再要求拖到整个窗口外面）。落到哪儿由光标下面的窗口决定：
   *   还是原来那个窗口 → 它自己变成一块新的浮窗（浏览器那种手感：拖出来就是拿出来）
   *   主窗口     → 停靠回主窗口的标签组
   *   别的浮窗   → 并进那个浮窗（浮窗也是容器，所以这是天然的）
   *   哪儿都不是 → 它自己变成一个新的浮窗
   */
  ipcMain.handle('panel:openFloat', (_e, panelId: string, size?: { width: number; height: number }) => {
    // size 由渲染层量出来（CSS 像素），窗口要的是屏幕 DIP —— 缩放开着时差一个乘区
    const f = getZoom();
    const s = size
      ? { width: Math.max(360, Math.round(size.width * f)), height: Math.max(360, Math.round(size.height * f)) }
      : { width: 540, height: 620 };
    const win = store.detachPanel(panelId, undefined, s);
    refresh();
    return Boolean(win);
  });

  ipcMain.handle('panel:detach', (_e, panelId: string, fromWindowId?: string, rawSize?: any) => {
    // 判断“光标底下是谁”要用**真实**光标点；夹取过的那个是给“新窗口开在哪儿”用的 ——
    // 它先减了 60/24 再往工作区里塞，贴着屏幕边拖的时候会把判定带到别的窗口上去。
    const cursor = windows.cursorPoint();
    const size = windows.tearSize(rawSize);
    const at = anchoredAt(size, rawSize);
    const under = windows.windowAt(cursor);
    // 光标底下就是它**原来待的那个窗口**：本意是"从标签栏里拿出来"，不是"拖回去"。
    // 旧行为是并回主窗口 —— 那时只有一路拖到窗口外才走到这儿，现在离开标签栏就会走到。
    const sameHost = under?.kind === 'main' ? !fromWindowId : under?.kind === 'floating' && under.windowId === fromWindowId;
    if (sameHost) {
      store.detachPanel(panelId, at, size);
      refresh();
      return true;
    }
    if (under?.kind === 'main') {
      store.dock(panelId, { where: 'main', tabId: W.firstTabGroup(store.state.layout).id, mode: 'center' });
    } else if (under?.kind === 'floating') {
      const win = store.state.floating.find((w) => w.id === under.windowId);
      if (win && !W.tabOfPanel(win.root, panelId)) {
        store.dock(panelId, { where: 'floating', windowId: win.id, tabId: W.firstTabGroup(win.root).id, mode: 'center' });
      } else {
        store.detachPanel(panelId, at, size);
      }
    } else {
      store.detachPanel(panelId, at, size);
    }
    refresh();
    return true;
  });

  /** 归一化：浮窗整棵树并回主窗口 */
  ipcMain.handle('window:attach', (_e, windowId: string) => {
    store.attachWindow(windowId);
    refresh();
    return true;
  });

  // ------------------------------------------------------------ 窗口
  ipcMain.handle('win:control', (e, action: 'minimize' | 'maximize' | 'close') => {
    const win = HOST.windowFromEvent(e);
    if (!win || win.isDestroyed()) return false;
    if (action === 'minimize') win.minimize();
    // 主窗口走系统最大化；浮窗是 resizable: false（为了关掉系统缩放边框），
    // 系统最大化在那种窗口上会被忽略 —— 由我们自己改 bounds
    else if (action === 'maximize') {
      if (win.isResizable()) {
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
      } else {
        windows.toggleMaximize(win.raw as never);
      }
    } else win.close();
    return true;
  });

  /**
   * 拖浮窗的标题栏、拉大小。界面只上报"按下 / 移动 / 松开"三个信号，
   * 指针坐标由主进程用 screen.getCursorScreenPoint() 自己取 ——
   * 渲染层的 screenX 单位随平台和缩放而变，从渲染层传坐标再换算会把位置算飞。
   */
  const windowIdOfSender = (e: Electron.IpcMainEvent) => {
    const win = HOST.windowFromEvent(e);
    return win ? windows.windowIdOf(win.webContentsId) : null;
  };

  /** 发信号的是哪个窗口：main 或浮窗 id。拖动途中撕下来的那块要认它 */
  const sourceKeyOf = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): string | null => {
    const win = HOST.windowFromEvent(e);
    if (!win || win.isDestroyed()) return null;
    if (windows.isMain(win.webContentsId)) return 'main';
    return windows.windowIdOf(win.webContentsId);
  };

  // 落点探测的答复通道：光标底下那扇窗算完落点，从这里回给主进程
  ipcMain.on('drop:probe:reply', (_e, id: number, hit: unknown) => windows.answerProbe(id, hit));

  /**
   * 「光标底下是谁、它说落在哪」—— 把一个标签拖到**别的窗口**上时唯一的判定入口。
   *
   * 由**光标底下那扇窗**自己用 DOM 回答（windows.probeAt → 渲染层的 probeAt），
   * 和拖浮窗共用同一条通道：提示和落地动作必然是同一个判定，不会各说各的。
   * `own` = 光标还在发问那扇窗自己里面（那就不该走这条，窗口内那套更准）。
   */
  ipcMain.handle('win:probeCursor', async (e, draw = false) => {
    const key = sourceKeyOf(e);
    const res = await windows.probeAt(windows.cursorPoint(), undefined, Boolean(draw));
    if (!res) return { target: null, hit: null, own: false };
    return { target: res.target, hit: res.hit, own: res.target === key };
  });

  /**
   * 松手之后这扇窗去哪儿 —— 拖浮窗和「拖动途中撕下来」共用这一段。
   *
   * 落点由**光标底下那扇窗**回答（windows.probeAt），这里只把答案翻译成归宿。
   * 四种归宿和面板拖拽那套是同一份语义，所以界面上说的和真正发生的一定是一件事：
   *   标签栏 → 并进那组标签；
   *   四边   → 在那块面板旁边分栏；窗口边上 → 在根上分一块（侧窗，均等）；
   *   哪扇窗都不是（含「丢回自己来的那扇」）→ 留在原地当浮窗
   */
  const landWindow = (
    windowId: string,
    res: { target: string; hit: DropHit | null } | null,
  ) => {
    const me = store.state.floating.find((w) => w.id === windowId);
    /*
     * 落在**顶上那条收纳区**上：把这一拖带来的面板收进收纳区，这块窗口随之消失。
     *
     * 这一段必须排在"没有落点就什么都不做"**前面**：收纳区在主窗口的顶栏上，
     * 不在任何标签组里，往下走就会被当成"停在空处"，浮窗原样留在屏幕上 ——
     * 界面上一句"收进收纳区"说完，什么都没发生。
     *
     * 面板一旦离开标签栏就当场撕成浮窗（浏览器那套），所以"拖到收纳区上"这条路上，
     * 光标底下压着的是**这一拖自己那块窗口**，而不是原来那一组 —— 名单只能靠它带下来。
     */
    if (res?.hit && res.hit.bar) {
      /*
       * 收的是这扇窗里装着的面板。
       *
       * 用不着另记一份"这一拖带来了什么"：撕下来的那块窗口本来就是新开的，
       * 里面只装着这一拖带来的东西（一个面板，或者一整组标签）。
       * 拖**整块浮窗**那条路也落在同一句话上 —— 窗口压在收纳区上，
       * 意思就是"把它装的东西收起来"，跟它是怎么被拖过来的无关。
       *
       * 哪些收不动（这一轮还在跑的面板、空壳）由 store 那边一件件判，
       * 这里不重复一遍规则：两处各写一份，早晚会有一处漏掉。
       */
      const root = me?.root;
      const ids = root ? W.tabGroupsOf(root).flatMap((t) => t.panels) : [];
      store.stowPanels(ids, res.hit.barIndex);
      return;
    }
    if (!res || !res.hit) {
      /*
       * 没有落点 = 停在空处，或者停在**面板主体**上（离标签栏和四条边缘带都够远）。
       *
       * 这里**什么都不做**，尤其不许"并回去"。并入只有一个入口：**落到标签栏上**。
       *
       * 上一版在这里加过一条"光标还在另一扇窗身上就并进去"，本意是修"并不回来"，
       * 结果是：从窗口里往外拖一块标签，松手时人还在主体上 —— 想分出来的那块浮窗
       * 当场被并回去，浮窗根本立不起来。主体内不是标签栏，它的意思是"就留在这儿"。
       */
      // 落在桌面上（哪扇窗都不是）：本来挂着的、而且已经拖离宿主了 —— 这才是「拽出来」
      // （只是想在宿主上挪个位置，不该被判成脱离）
      if (me?.parent && !windows.cursorInside(me.parent)) store.setWindowParent(windowId, undefined);
      return;
    }
    const { target, hit } = res;
    const where = target === 'main' ? { where: 'main' as const } : { where: 'floating' as const, windowId: target };
    /*
     * 浮窗之间**只并标签，不分栏**。
     *
     * 浮窗是"临时拎出来看的一块"，里面再切成左右两栏，界面就成了一份缩小的次级本体 ——
     * 和主窗口抢同一件事，还挤得看不清。所以落在浮窗的边上、或者贴到它的外沿，
     * 一律降级成"并进它那一组标签"；分栏只发生在主窗口里（那边有地方）。
     */
    const hostIsFloat = target !== 'main';
    if (hit.tabId && hit.mode === 'tabs') {
      // 标签栏 → 并进这组标签。这是**唯一**的并入入口，浮窗和主窗口都一样
      store.mergeWindowInto(windowId, target, hit.tabId, hit.index);
    } else if (hit.tabId && hit.mode === 'center' && !hostIsFloat) {
      /*
       * 正中 → **嵌成挂件**：浮窗里那块面板贴到这块区域上，浮窗本身随之消失。
       *
       * 只认**单面板**的浮窗：多面板的浮窗在这里会被拆成一堆挂件叠在一起，
       * 那不是"嵌进去"，是把它打散。多面板要走这条得先在浮窗里合并成一个标签。
       */
      store.floatWindowInto(windowId, where, hit.tabId);
    } else if (hit.tabId && hit.mode && !hostIsFloat) {
      store.dockWindowBeside(windowId, where, hit.tabId, hit.mode as 'left' | 'right' | 'top' | 'bottom');
    } else if (hit.side && !hostIsFloat) {
      store.dockWindowAtSide(windowId, where, hit.side);
    } else if (hostIsFloat) {
      // 浮窗身上只有"标签栏"这一个落点（见渲染层 onlyTabs），走到这儿只可能是
      // 中心区（center）那一种 —— 那也是并进去
      store.mergeWindowInto(windowId, target, hit.tabId, hit.index);
    }
    // 主窗口的其余落点：什么都不做。**不要**在这里加"总有归宿"的兜底 ——
    // 兜底会让"停在主体上"被解释成某个归宿，撕出来的浮窗当场被并回去。
  };

  ipcMain.on('float:dragBegin', (e) => {
    const id = windowIdOfSender(e);
    if (id) windows.beginGrab(id);
  });

  ipcMain.on('float:dragMove', (e) => {
    const id = windowIdOfSender(e);
    if (id) windows.moveGrab(id);
  });

  ipcMain.on('float:dragEnd', async (e) => {
    const id = windowIdOfSender(e);
    if (!id) return;
    // 先问落点、再收会话：draw: false 是因为马上要落地了，不必再画一个提示框
    const res = await windows.probeAt(windows.cursorPoint(), id, false, true);
    windows.endGrab(id);
    landWindow(id, res);
    store.reapEmptyWindows();
    refresh();
  });

  // ------------------------------------ 拖动途中就把标签撕下来（浏览器那套）

  /**
   * 一离开标签栏就立一块浮窗挂在光标下，松手只决定它落到哪。
   *
   * 撕出来的窗口**不许抢焦点**（markLive）—— 源窗口那边正按着指针捕获，
   * 一抢焦点，那条捕获链当场断，这一拖就死在半路。
   */
  /** 这一拖撕出来的窗口：源窗口键 → 窗口 id。松手时以它为准，别处那份登记只当加速 */
  const tears = new Map<string, string>();

  const tearOff = (
    sourceKey: string | null,
    make: () => { id: string } | null,
    anchor?: { dx?: number; dy?: number },
  ) => {
    if (!sourceKey) return false;
    const win = make();
    if (!win) return false;
    // 摘面板和开窗口必须同一步做完：中间隔一次广播同步，就会出现
    // "面板已经不在布局里、窗口却还没来" 的空档 —— 那块面板就成了关不掉的幽灵
    windows.markLive(win.id);
    // 窗口没开出来就等于没撕下来：把面板原样并回去。
    // 绝不能留一块"既不在布局里、也没有窗口"的面板 —— 那种面板看不见、关不掉。
    if (!windows.openFloating(win.id)) {
      store.attachWindow(win.id);
      return false;
    }
    tears.set(sourceKey, win.id);
    refresh();
    windows.beginLive(sourceKey, win.id, anchor);
    /*
     * 窗口上屏要几百毫秒。要是它始终没上屏，那块面板就等于丢在空里 ——
     * 看不见、也关不掉。到点把它并回布局：宁可这一拖白费，也不留一块点不动的白板。
     */
    const fallback = setTimeout(() => {
      tearTimers.delete(win.id);
      // 这一拖早结算完了（落地会撤掉这个定时器，这里是第二道保险）
      if (!windows.isLive(win.id)) return;
      if (windows.isShown(win.id)) return;
      for (const [key, id] of [...tears]) if (id === win.id) tears.delete(key);
      store.attachWindow(win.id);
      refresh();
    }, 1600);
    tearTimers.set(win.id, fallback);
    return true;
  };

  /** 撕下来那块的兜底定时器：这一拖一落地就撤掉，绝不让它事后拆掉一块好窗口 */
  const tearTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** 这一拖的收尾：问一句光标底下落到哪，然后落地 —— 正常松手和看门狗兜底共用这一段 */
  const finishTear = async (windowId: string, why: string) => {
    /*
     * 这一拖有结论了，先把"没上屏就并回布局"那道兜底撤掉。
     *
     * 它是撕下来那一刻挂的 1.6 秒定时器，落地之后它还在跑：到点一判，就把一块
     * 已经好好落地的窗口的底板抽走 —— 面板既不在布局里、也没了窗口，界面上就是
     * 卡死变灰、关不掉。日志里抓到过同一扇窗先"上屏"、1.6 秒后又"一直没上屏"。
     */
    const pending = tearTimers.get(windowId);
    if (pending) {
      clearTimeout(pending);
      tearTimers.delete(windowId);
    }
    const res = await windows.probeAt(windows.cursorPoint(), windowId, false, true);
    landWindow(windowId, res);
    store.reapEmptyWindows();
    refresh();
  };
  // 松手信号丢了的时候，主进程自己看表收尾（见 windows.watchLive）
  windows.onLiveStale = (windowId: string) => void finishTear(windowId, t('心跳停了'));

  /**
   * 新窗口该开在哪 —— **固定锚点**：光标压在新窗口那个标签的**中心**。
   *
   * 锚点由渲染层量了传过来（`raw.dx/dy` = 光标在窗口里该待的位置）。它是个常数，
   * 和"从哪一块拖出来、拖的是哪一块"都无关，所以每次出来的手感完全一致。
   *
   * 以前这里是"指针在原块里的偏移 × 按新尺寸等比缩放"：可新窗口是方的、原块往往是
   * 宽扁的，横竖两个缩放系数差得远，指针落点就跟着原块的宽高比漂 —— 每次错开一截，
   * 而且每块都不一样。
   *
   * 位置**不夹**：夹一下指针在新窗口里的位置就变了 —— 贴着屏幕边拖出来时，看到的会是
   * "窗口自己跑到光标底下摊开"，鼠标和窗口当场错开，那就是"脱手"。宁可让它半截探出屏幕
   * （浏览器也这样），也要保证指针还压在锚点上。
   */
  /**
   * 新窗口先摆在哪 —— 用**渲染层量的那个常数锚点**（标签中心）。
   *
   * 这里只是个起点：真值由**新窗口自己**上屏前一量、当场纠正（见 win:anchor）。
   * 那一步才是准的，因为源窗口量不出新窗口的几何。
   *
   * 位置**不夹**：夹一下指针在新窗口里的位置就变了 —— 贴着屏幕边拖出来时，看到的会是
   * "窗口自己跑到光标底下摊开"，鼠标和窗口当场错开，那就是"脱手"。宁可让它半截探出屏幕
   * （浏览器也这样），也要保证指针还压在锚点上。
   */
  const anchoredAt = (size: { width: number; height: number }, raw?: { dx?: number; dy?: number }) => {
    const c = windows.cursorPoint();
    /*
     * raw.dx/dy 是**源窗口渲染层量出来的 CSS 像素**（标签中心），size 也已经换算成 DIP 了
     * （见 windows.floatSize）—— 所以这两个偏移要单独乘一次乘区，两边才是同一个尺子。
     */
    const f = getZoom();
    const dx = (raw?.dx ?? size.width / 2 / f) * f;
    const dy = (raw?.dy ?? STRIP_MID) * f;
    return { x: Math.round(c.x - dx), y: Math.round(c.y - dy) };
  };

  const tearOrigin = (raw?: { width?: number; height?: number; dx?: number; dy?: number }) => {
    const size = windows.tearSize(raw);
    return { size, at: anchoredAt(size, raw), anchor: { dx: raw?.dx, dy: raw?.dy } };
  };

  ipcMain.handle('panel:tear', (e, panelId: string, rawSize?: any) => {
    const { size, at, anchor } = tearOrigin(rawSize);
    // keepSource：撕下来的这一拖，源窗口在松手前不能死（见 store.detachPanel 的说明）
    return tearOff(sourceKeyOf(e), () => store.detachPanel(panelId, at, size, true), anchor);
  });

  ipcMain.handle('tabs:tear', (e, tabId: string, rawSize?: any) => {
    const key = sourceKeyOf(e);
    const { size, at, anchor } = tearOrigin(rawSize);
    // 最后一个参数 = keepSource：拖动途中撕下来，源窗口在松手之前不能死
    return tearOff(
      key,
      () => store.detachTabGroup(tabId, at, key === 'main' ? undefined : key ?? undefined, size, true),
      anchor,
    );
  });

  /** 跟手：源窗口每帧报一句「还在拖」，主进程据此挪那块浮窗，顺便问一句落点 */
  ipcMain.on('win:tearMove', (e) => {
    const key = sourceKeyOf(e);
    if (key) windows.moveLive(key);
  });

  /** 拖动中的"还按着"证据：手停住不动也照发，主进程靠它区分"还按着"和"松手信号丢了" */
  ipcMain.on('win:tearTick', (e) => {
    const key = sourceKeyOf(e);
    if (key) windows.tickLive(key);
  });

  /** 撕下来那块已经上屏 → 广播一句，源窗口据此把手上的吊牌收掉（不让两边叠着） */
  ipcMain.on('win:liveReady', () => {
    HOST.broadcast('win:liveReady');
  });

  /**
   * 撕下来那块窗口**自己**量出了标签中心 → 用它当下面的跟手锚点。
   *
   * 这一步不能省：上面算的锚点是拿**源窗口**的几何推的，而源窗口只知道*自己*那条
   * 标签栏长什么样（左边距、把手、这个标签排第几个）。新窗口里它就一个标签、永远在最左端，
   * 两边的几何根本不是一回事 —— 于是指针落偏，而且拖第几个标签就偏多少。
   * 它自己一量，偏多少当场归零；而且这是**常数**，整场拖动都不会再漂。
   */
  ipcMain.on('win:anchor', (e, dx: number, dy: number) => {
    const id = windowIdOfSender(e);
    // 它量的是自己页面里的 CSS 像素，主进程这儿比的是屏幕 DIP —— 差一个乘区
    const f = getZoom();
    if (id) windows.setAnchor(id, dx * f, dy * f);
  });

  /** 这块窗口是不是"刚被撕下来、正挂在光标下"的那一块 */
  ipcMain.handle('win:isLive', (e) => {
    const win = HOST.windowFromEvent(e);
    if (!win || win.isDestroyed()) return false;
    const id = windows.windowIdOf(win.webContentsId);
    return Boolean(id && windows.isLive(id));
  });

  /** 松手：会话收掉，落点由光标底下那扇窗回答（和拖浮窗共用 landWindow） */
  ipcMain.on('win:tearEnd', async (e) => {
    const key = sourceKeyOf(e);
    if (!key) return;
    const windowId = windows.endLive(key)?.windowId ?? tears.get(key);
    tears.delete(key);
    if (!windowId) {
      /*
       * 收到一个"已经不存在的这一拖"的松手：会话早就结算过了。说明还有窗口攥着一份
       * **过期的拖拽状态**，当场广而告之，让它自己清掉，别带着过期状态继续用下去。
       */
      windows.sendAll('drag:end');
      return;
    }
    await finishTear(windowId, t('松手'));
  });

  ipcMain.on('float:resizeBegin', (e) => {
    const id = windowIdOfSender(e);
    if (id) windows.beginResize(id);
  });

  ipcMain.on('float:resizeMove', (e) => {
    const id = windowIdOfSender(e);
    if (id) windows.resizeMove(id);
  });

  // 松手必须销毁缩放会话 —— 残留的旧锚点就是"按住不放窗口不断变大"的病根
  ipcMain.on('float:resizeEnd', (e) => {
    const id = windowIdOfSender(e);
    if (id) windows.endResize(id);
  });

  // ------------------------------------------------------------ 工作区文件
  // ---------------------------------------------------------- 悬浮面板

  // ------------------------------------------------------------ 界面缩放
  /*
   * 全局乘区只有一个真源（主进程，见 zoom.ts），界面上的滑块/快捷键都只是**提议**：
   * 真正落下去的倍数由这里钳过再发回来，免得两边各算一套、越算越不一样。
   */
  ipcMain.handle('ui:zoom:get', () => getZoom());

  // ------------------------------------------------------------ 语言
  /*
   * 语言的权威在主进程（见 lang.ts）：它同时决定界面文案、助手回话的语言、
   * 以及插件声明里的 label。渲染层自己也存一份（第一帧要用），改的时候两边一起动。
   */
  ipcMain.handle('ui:lang:get', () => getLang());

  ipcMain.handle('ui:lang:set', (_e, lang: string) => {
    const next = setLang(lang);
    /*
     * 插件声明里的 label / 描述是 require 那一刻算死的 —— 光把语言值换掉，
     * 设置里那些插件名和描述还停在旧语言上（用户看到的就是「中文界面配英文描述」）。
     * loadPlugins 里本来有「语言变了就重挂」的闸，但那要等下一次调用；人正盯着设置页，
     * 不能让他等下一轮对话。这里当场推一次。
     */
    loadPlugins(store.disabledPlugins());
    toAllWindows('ui:lang', next);
    return next;
  });

  ipcMain.handle('ui:zoom:set', (_e, factor: number) => {
    const next = setZoom(Number(factor));
    toAllWindows('ui:zoom', next);
    return next;
  });

  /** 脱离布局，浮成一张便签（anchor = 它落进去的那块区域） */
  ipcMain.handle('panel:float', (_e, panelId: string, host: string, anchor: string, rect: any) => {
    store.floatPanel(panelId, host, anchor, rect);
    refresh();
    return true;
  });

  /** 便签归位：给了目标就并到那儿，没给就放回主窗口 */
  ipcMain.handle('panel:dockFloat', (_e, panelId: string, target: DockTarget | null, index?: number) => {
    if (target) store.dockFloatingPanel(panelId, target, index);
    else store.unfloatPanel(panelId);
    refresh();
    return true;
  });

  /** 挪动/改大小。拖动过程在渲染层本地走，只有松手才调这里一次 */
  ipcMain.handle('panel:moveFloat', (_e, panelId: string, patch: any) => {
    store.moveFloat(panelId, patch);
    refresh();
    return true;
  });

  /**
   * 挂件窗口：面板变成一扇独立小窗（见 Panel.widget）。
   *
   * 这一跳只是「登记 + 刷新」：开窗由 windows.sync() 按 store 对齐着来 ——
   * 渲染层和插件都不该直接碰窗口，不然 store 和屏幕上的窗口迟早各说各话。
   */
  ipcMain.handle('panel:widget', (_e, panelId: string, box: any) => {
    const p = store.panel(String(panelId || ''));
    if (!p) return false;
    store.floatWidget(String(panelId), box ?? {});
    refresh();
    return true;
  });

  ipcMain.handle('widget:edit', (e, panelId: string) => {
    const id = String(panelId || '');
    const query = new URL(e.sender.getURL()).searchParams;
    if (!store.panel(id)?.widget || query.get('panel') !== id || query.get('mode') !== 'widget') return false;
    windows.openWidgetEditor(id);
    return true;
  });

  ipcMain.handle('widget:menu', (e, panelId: string) => {
    const id = String(panelId || '');
    const p = store.panel(id);
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!p?.widget || !win) return false;
    const query = new URL(e.sender.getURL()).searchParams;
    if (query.get('panel') !== id || query.get('mode') !== 'widget') return false;
    Menu.buildFromTemplate([
      { label: t('编辑组件'), click: () => windows.openWidgetEditor(id) },
      { label: p.component ? t('更新收藏') : t('收藏组件'), click: () => { store.declareComponent(id, p.title); refresh(); } },
      { type: 'separator' },
      { label: t('删除桌面组件'), click: () => { store.closePanel(id); refresh(); } },
    ]).popup({ window: win });
    return true;
  });

  ipcMain.handle('widget:move', (_e, panelId: string, patch: any) => {
    windows.moveWidget(String(panelId || ''), patch ?? {});
    store.moveWidget(String(panelId || ''), patch ?? {});
    refresh();
    return true;
  });

  /** 挂件归位：取消 widget 状态，摆回主窗口的停靠树 */
  ipcMain.handle('widget:restore', (_e, panelId: string) => {
    const id = String(panelId || '');
    const panel = store.panel(id);
    if (!panel?.widgetReturn || panel.widget) return false;
    store.floatWidget(id, panel.widgetReturn);
    refresh();
    return true;
  });

  ipcMain.handle('widget:close', (_e, panelId: string) => {
    store.unwidget(String(panelId || ''));
    refresh();
    return true;
  });

  ipcMain.handle('fs:root', () => workspaceRoot());
  ipcMain.handle('fs:list', (_e, rel: string) => {
    try {
      return listDir(rel || '.');
    } catch (e: any) {
      return [{ name: `打不开：${e?.message ?? e}`, dir: false, path: '', size: 0 }];
    }
  });
  ipcMain.handle('fs:read', (_e, rel: string) => {
    try {
      return readText(rel);
    } catch (e: any) {
      return `读取失败：${e?.message ?? e}`;
    }
  });
  ipcMain.handle('fs:readJson', (_e, rel: string) => readJsonSnapshot(rel));
  /** 编辑器保存：写回工作区里的文件 */
  ipcMain.handle('fs:write', (_e, rel: string, text: string) => {
    try {
      writeText(rel, text);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
  ipcMain.handle('panel:openFile', (_e, rel: string) => {
    try {
      store.openFile(rel, readText(rel));
    } catch (e: any) {
      store.openFile(rel, `读取失败：${e?.message ?? e}`);
    }
    refresh();
    return true;
  });

  // ------------------------------------------------------------ 模型
  // 提供方配置存在自己的 providers.json 里（学 harness 的结构：提供方 → 密钥 / 地址 / 模型目录）。
  // 前台只负责"选哪个模型"；密钥只往主进程里进，不往下发。
  // 选择是**按会话**存的：钥匙给面板 id 就只改这个会话；给宿主 key
  // （'main' / 浮窗 id）就改那个窗口的兜底 —— 窗口里没单独选过的会话跟着它走。
  const info = (key: string) => {
    const k = key || MAIN_HOST;
    return { ...describePick(store.pickOf(k)), think: store.thinkFor(k) };
  };
  ipcMain.handle('model:get', (_e, key: string = MAIN_HOST) => info(key || MAIN_HOST));
  ipcMain.handle('model:catalog', () => catalog());
  ipcMain.handle('model:set', (_e, key: string, patch: { pick?: string; think?: string }) => {
    const k = key || MAIN_HOST;
    // 两件事分开给：只改思考水平时**不能**把已经选好的模型清掉，反过来也一样
    if (typeof patch?.pick === 'string') store.setModelFor(k, patch.pick);
    if (typeof patch?.think === 'string') store.setThinkFor(k, patch.think);
    refresh();
    return info(k);
  });

  /** 提供方的增删改：密钥在这里进，永远不会被读回去 */
  ipcMain.handle('providers:catalog', () => catalog());
  ipcMain.handle('providers:presets', () => PRESETS);
  ipcMain.handle('providers:save', (_e, provider: any) => {
    upsert(provider);
    refresh();
    return catalog();
  });
  ipcMain.handle('providers:remove', (_e, key: string) => {
    removeProvider(key);
    refresh();
    return catalog();
  });
  /** 让服务端自己报有哪些模型（省得手抄 id）—— 密钥只在这一趟里用，不落任何地方 */
  ipcMain.handle('providers:models', (_e, draft: any) => listModels(draft ?? {}));

  // ------------------------------------------------------------ 设置
  ipcMain.handle('settings:get', () => ({
    workspace: workspaceRoot(),
    configPath: providersPath(),
    model: describePick(store.pickFor(MAIN_HOST)),
    /** 宿主版本 —— 装扩展包时拿它比 manifest 里声明的 host（见 docs/plugin-spec.md §5） */
    version: appVersion(),
    providers: catalog(),
  }));

  /**
   * 完全权限：允许读写工作区之外的路径。**按会话算** —— 改的是哪一块面板的权限，
   * 只有它自己立刻生效，别的会话照旧夹在工作区里。
   */
  ipcMain.handle('settings:setFullAccess', (_e, panelId: string, on: boolean) => {
    store.setPanelFullAccess(String(panelId || ''), Boolean(on));
    refresh(); // 输入框上那枚盾牌要跟着换显示
    return store.panelFullAccess(String(panelId || ''));
  });
  /**
   * 工作模式：**按会话**算 —— 改的是哪一块面板的模式，只有它自己立刻生效。
   * 四种模式共用同一张工具表，这里只落一个字段，提示词那段由 chat-core 现拼。
   */
  ipcMain.handle('settings:setPanelMode', (_e, panelId: string, mode: PanelMode) => {
    store.setPanelMode(String(panelId || ''), mode);
    refresh(); // 会话框上方那四格要跟着换高亮
    return store.panelMode(String(panelId || ''));
  });
  /** 换工作区：写进 store、换 fsapi 的根、把新状态推给所有窗口 */
  const openWorkspace = (dir: string) => {
    if (running.size) throw new Error('请先结束当前任务，再切换工作区');
    store.setWorkspaceRoot(dir);
    // 这是人刚挑的目录：得信它。不信就会变成"标题栏显示已选、fs 说还没选"
    const root = setFsRoot(dir, { trust: true });
    // 改名字留下的旧状态目录（.anycode → .ensoul）在这儿顺手搬正
    migrateWorkspaceState(root);
    // 根换好了，才轮到做法那摊事（拆老的单文件、把本体里的做法搬进工作区）——
    // 反过来做会照旧根拼路径、写进上一个工作区
    store.syncCraftFiles();
    // 冻在文本面板里的那句"读取失败"到此为止 —— 换成真读到的内容
    store.refreshFailedFiles((rel) => readText(rel));
    tasks.recover();
    loadPlugins(store.disabledPlugins());
    refresh();
    return root;
  };

  ipcMain.handle('settings:setWorkspace', (_e, dir: string) => openWorkspace(dir));

  /** 弹系统目录选择器挑一个工作区 */
  ipcMain.handle('ws:pick', async () => {
    const opts = { properties: ['openDirectory' as const], defaultPath: workspaceRoot() || undefined };
    const r = await HOST.pickOpenFile(opts);
    if (r.canceled || !r.filePaths.length) return null;
    return openWorkspace(r.filePaths[0]);
  });

  /** 切回最近开过的某个工作区 */
  ipcMain.handle('ws:open', (_e, dir: string) => openWorkspace(dir));
  /**
   * **这份软件自己住在哪个目录** + 现在的工作区是哪条 —— 界面拿它两相一比，
   * 就能说清"为什么这一页是空的"（多半是工作区指着别处）。
   */
  ipcMain.handle('ws:self', () => ({ dir: selfCheckoutDir(), workspace: workspaceRoot() }));
  ipcMain.handle('settings:revealConfig', async () => {
    HOST.revealInFolder(providersPath());
    return true;
  });

  // ------------------------------------------------------------ 对话
  const running = new RunRegistry<{ runId: string; ctrl: AbortController; msg: ChatMessage }>();
  const tasks = new TaskService(workspaceRoot, {
    enqueue: (task) => {
      const p = store.panel(task.panelId);
      if (!p) throw new Error('任务目标面板已关闭');
      p.outbox ??= [];
      if (!p.outbox.some((item) => item.taskId === task.id)) {
        p.outbox.push({ id: task.id, taskId: task.id, taskWorkspace: task.workspace, text: task.text, at: task.createdAt });
        store.save();
        refresh();
      }
      queueMicrotask(() => pumpTaskQueue(task.panelId));
    },
    remove: (ids) => {
      const remove = new Set(ids);
      for (const p of Object.values(store.state.panels)) {
        if (p.outbox?.some((item) => item.taskId && remove.has(item.taskId))) {
          p.outbox = p.outbox.filter((item) => !item.taskId || !remove.has(item.taskId));
        }
      }
      store.save();
      refresh();
    },
    changed: () => HOST.broadcast('tasks:changed'),
  });
  setProjectBuilder((target, scope) => scope === 'app' ? buildApp(target) : target === 'renderer' ? buildRenderer() : buildProject());

  /**
   * 工具跑动中挂在对话里的东西（生图、下载这类慢活）—— 两件事共用一个快照：
   *   · tasks  —— 进行中的容器：在干什么、跑到哪一步、过程预览图
   *   · images —— 这一轮**还没结束**时先摆出来的图（这一轮结束就转正成消息上的图）
   *
   * **只活在内存里**：这一轮一结束它们就没意义了 —— 图已经落在那条助手消息的
   * images 上、随消息存进 store。落盘的话，下次开软件会看到一个永远转下去的"生成中"。
   *
   * 反过来说：**闲着的时候（没有正在跑的一轮）到货的图不该进这里** —— 见 flushIdleShots。
   */
  const liveTasks = new Map<string, Map<string, LiveTask>>();
  const liveImages = new Map<string, string[]>();
  /**
   * 这一轮此刻在不在重连（断了、正在退避等待下一次）。
   *
   * 为什么搭 live 这趟车而不是新开一条通道：它是**同一件事的两面** ——
   * 上面那些容器说的是"它在干活"，这一条说的是"它卡了一下、正在自己接回来"，
   * 摆在同一块里，切标签回来才能一起恢复（挂载时那个 liveState 一次就都拿到了）。
   * 同样只活在内存里：重连是一次性的现场，落盘只会留下一个永远转不完的"正在重连"。
   */
  const liveRetry = new Map<string, RetryView>();
  /**
   * 闲着的时候到货的图（派单交付这类）—— 攒在同一批里，微任务里合成一条消息。
   * 一个交付动作里的多张图是**连着同一个 tick** 调进来的（见 dispatch 的 deliver_result），
   * 不攒的话一次交付会变成好几条各带一张图的消息。
   */
  const idleShots = new Map<string, string[]>();
  const liveView = (panelId: string) => ({
    panelId,
    tasks: [...(liveTasks.get(panelId)?.values() ?? [])],
    images: liveImages.get(panelId) ?? [],
    retry: liveRetry.get(panelId) ?? null,
  });
  /**
   * 斜杠命令要的两件"只有核心做得到"的事，跟 setChatSender 一个路子：本事在这儿，插件只管喊。
   *   clearChat 清会话 —— 消息和**前情摘要一起清**：只清消息留下摘要，下一轮那句"前情"
   *             还会把清掉的上下文原样带回来，等于没清。
   *   tools     这一刻能用的工具 —— 档位和真发出去的那份是同一个判断（chat 是全权，别的只给写）。
   */
  setChatClearer((panelId) => {
    const p = store.panel(panelId);
    if (!p) return false;
    p.chat = [];
    p.compact = undefined;
    commitPromptBaseline(p);
    store.save();
    refresh();
    return true;
  });
  /**
   * 手动压一次上下文（`/compress`）—— 把这一路压成一份摘要，然后把原文从对话区挪走。
   *
   * 和自动压缩用的是同一份 summarizeSession、同一套规矩，区别只在**什么时候做**、
   * 以及**做完留什么**：自动那条看窗口占用、原文照旧留在界面上；这条是用户说"现在就压"，
   * 压完**清空对话区**，等于带着前情另起一个分支。
   *
   * 和 /clear 的分水岭正在这里：
   *   · /clear    摘要和原文**一起清**，下一轮从真正的空白开始，前面的事一句不剩。
   *   · /compress 留下摘要、留下隐性存档（`compact.archive`），清掉的只是界面上那一段。
   * 存档只落盘、不进请求、不在对话区显示 —— 想看就翻 store，别再送一份给模型。
   */
  setChatCompressor(async (panelId) => {
    const p = store.panel(panelId);
    if (!p) return t('命令没有执行：找不到面板。');
    const older = p.chat.filter((m) => m.role !== 'tool');
    if (!older.length) return t('这块面板还没有可压缩的对话。');
    const cfg = store.modelForPanel(panelId);
    // 压缩时问一遍插件（便签要点走这个进来）—— 和自动压缩那一刻同一份做法
    const ex = loadPlugins(store.disabledPlugins());
    const noteCtx = { panelId, host: store.hostKeyOf(panelId), kind: p.kind };
    const notes = ex.summaryNotes
      .map((fn) => {
        try {
          return String(fn(noteCtx) ?? '').trim();
        } catch {
          return '';
        }
      })
      .filter(Boolean)
      .join('\n\n');
    // 用哪个模型写纪要：问一遍插件（没人答就用面板自己那个）
    const compactCfg = compactModelOf(ex.compactPicks, noteCtx, cfg);
    if (!compactCfg.apiKey) return t('这块面板还没选模型（点对话框右下角那个模型 chip 选一个），压不了。');
    try {
      const summary = await summarizeSession(
        older.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n\n'),
        p.compact?.summary ?? '',
        compactCfg,
        undefined,
        notes,
      );
      // 原文整段挪进隐性存档，对话区清零 —— 下一轮只有摘要 + 新说的话，分支就是从这儿起的
      commitPromptBaseline(p);
      p.compact = {
        summary,
        upTo: 0,
        at: Date.now(),
        archive: [...(p.compact?.archive ?? []), ...p.chat],
      };
      p.chat = [];
      store.save();
      refresh();
      return [
        `已压缩 ${older.length} 条对话，摘要留在前情里，原文已从会话区收起（后台隐性保存着，翻得回来）。`,
        '',
        `—— 从现在起这是一个新分支。想彻底重来用 /clear（那个连摘要和存档一起清）。`,
        '',
        t('【这次留下的摘要】'),
        summary,
      ].join('\n');
    } catch (e: any) {
      return `命令没有执行：摘要请求失败 —— ${e?.message ?? e}`;
    }
  });
  setToolLister((panelId) => {
    const p = store.panel(panelId);
    return toolsFor(p?.kind === 'chat' ? 'full' : 'write', p?.kind, p?.tools).map((t) => ({
      name: t.function.name,
      description: t.function.description,
    }));
  });

  const livePush = (panelId: string) => toAllWindows('chat:live', liveView(panelId));
  const liveClear = (panelId: string) => {
    liveTasks.delete(panelId);
    liveImages.delete(panelId);
    liveRetry.delete(panelId);
    livePush(panelId); // 空快照 = 界面把容器撤掉
  };

  /**
   * 没有正在跑的一轮 → 到货的图**直接成为一条消息**，不进 live 容器。
   *
   * 为什么非得分开：live 容器是"这一轮跑到哪了"的临时现场（只活在内存里、下一轮开头就被清，
   * 见 liveClear 的调用点）。发起人的那一轮早就跑完了 —— 图到的时候往里塞一份，
   * 只会在对话下面多挂一张缩略图：同一张图既当缩略图又当消息显示两遍，
   * 而且用户下一句话一说，缩略图那份就凭空消失（这一条看着像"图丢了"，最唬人）。
   */
  const flushIdleShots = (panelId: string, files: string[]) => {
    const p = store.panel(panelId);
    const unique = [...new Set(files)];
    if (!p || !unique.length) return;
    const note: ChatMessage = {
      id: W.newId('m'),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      images: unique,
    };
    p.chat.push(note);
    store.save();
    toAllWindows('chat:message', { panelId, message: note });
  };

  setLiveSink({
    show(panelId, task) {
      if (!panelId || !task?.key) return;
      const m = liveTasks.get(panelId) ?? new Map<string, LiveTask>();
      // 合并而不是整份替换：进度是**一次报一点**的（这回带 7/28，下回带预览图），
      // 后面的更新不该把 label 抹掉
      m.set(task.key, { ...(m.get(task.key) ?? {}), ...task, key: task.key } as LiveTask);
      liveTasks.set(panelId, m);
      livePush(panelId);
    },
    hide(panelId, key) {
      const m = liveTasks.get(panelId);
      if (!m) return;
      if (key) m.delete(key);
      else m.clear();
      livePush(panelId);
    },
    image(panelId, file) {
      const abs = path.isAbsolute(file) ? file : path.join(workspaceRoot() ?? process.cwd(), file);
      // 文件不在就当没这回事 —— 画一个必然是裂的图框比不画更糟
      if (!fs.existsSync(abs)) return;

      // ① 有正在跑的一轮：挂到**那条助手消息**上（这一轮结束它落盘，图就留在对话里了），
      //    同时在 live 容器里摆一份 —— 这一轮还没结束，消息还没定型，用户得先看得见。
      const msg = running.get(panelId)?.msg;
      if (msg) {
        if (msg.images?.includes(abs)) return;
        msg.images = [...(msg.images ?? []), abs];
        const shown = liveImages.get(panelId) ?? [];
        if (!shown.includes(abs)) {
          shown.push(abs);
          liveImages.set(panelId, shown);
        }
        livePush(panelId);
        return;
      }

      // ② 没有正在跑的一轮（交付送到一个已经跑完的面板）：只造消息，不碰 live 容器。
      //    同一批交付里的多张图攒到一起，合成一条消息。
      const pending = idleShots.get(panelId) ?? [];
      pending.push(abs);
      if (idleShots.has(panelId)) return;
      idleShots.set(panelId, pending);
      queueMicrotask(() => {
        idleShots.delete(panelId);
        flushIdleShots(panelId, pending);
      });
    },
  });

  /**
   * 谁在跑 —— 界面上那个「停止 / 发送」按钮的真源。
   *
   * 切标签时对话面板整个卸载重挂，"是否在跑"若只活在组件的 useState 里，
   * 换回来就变回"能发送"，其实这一轮还在主进程里跑着。状态记在这儿，一变就广播。
   */
  const setRunning = (panelId: string, ctrl: AbortController | null, msg?: ChatMessage, runId?: string) => {
    const changed = ctrl ? running.claim(panelId, { ctrl, msg: msg!, runId: msg!.id })
      : running.release(panelId, runId || '');
    if (!changed) return false;
    HOST.broadcast('chat:running', { panelId, running: Boolean(ctrl) });
    // 有请求在等"所有会话都结束"：这一下可能就是最后一条会话收工，去看一眼
    if (!ctrl) watchDefer();
    return true;
  };

  /**
   * 「等所有会话结束」这个选项的守候。
   *
   * 为什么不能就在 setRunning 里当场判一眼：一轮跑完的收尾里还排着"接力"——
   * 待发队列里下一条会紧接着开跑（见下面 doSend 结尾）。当场判的话，那一轮还没
   * 登记进 running，会被误判成"全都结束了"，重启正好把刚要开跑的那一轮掐掉。
   * 所以改成守着看一眼：**连着两次**看见没人跑才动手，中间只要有一轮起来就重新数。
   */
  let deferTimer: NodeJS.Timeout | null = null;
  let idleTicks = 0;

  /**
   * 重启之后那句等了很久的话，**交给重启后的新进程去发**。
   *
   * 为什么不能在原地 setTimeout 等：真重启会把旧进程整个收掉（Windows 上 taskkill /F），
   * 挂在旧进程里的定时器根本活不到那时候。所以这里只落一张纸条，
   * 新进程开机读到它、等界面接上再发（接线见下面的 bootResumeOutbox）。
   */
  const resumeFile = () => userDataPath('pending-resume.json');

  /** 动真格重启之前落一张纸条：告诉下一个进程"还有话没发出去" */
  const armResumeOutbox = () => {
    try {
      fs.writeFileSync(resumeFile(), JSON.stringify({ at: Date.now() }), 'utf8');
    } catch (e: any) {
      console.error('[重启接力] 纸条没写下：', e?.message ?? e);
    }
  };

  /**
   * 新进程开机时走一次：上次重启前是不是还压着话没说 —— 是就替它发出去。
   *
   * 两条约束：
   *   · 纸条**读了就删**：只认最近这一次重启，不能开一次软件就重放一遍旧队列。
   *   · 只认十分钟以内的纸条：隔夜、隔了好几轮再开机，那句话早就不合时宜了。
   */
  const resumeOutbox = () => {
    let armed = 0;
    try {
      if (!fs.existsSync(resumeFile())) return;
      const raw = JSON.parse(fs.readFileSync(resumeFile(), 'utf8')) as { at?: number };
      armed = Number(raw?.at) || 0;
      fs.unlinkSync(resumeFile());
    } catch {
      return;
    }
    if (!armed || Date.now() - armed > 10 * 60_000) return;
    // 等一拍再发：界面刚挂上，广播还没走完，这时候发出去那条才接得上
    setTimeout(() => {
      for (const p of Object.values(store.state.panels)) {
        if (!p || running.has(p.id)) continue;
        // 只接力**还摆在布局里**的面板：给一个已经关掉的面板发消息，等于把它
        // 从收纳区里拽出来，用户没要过这件事。
        if (!W.findPanel(store.state, p.id)) continue;
        const box = p.outbox;
        if (!box?.length) continue;
        const next = box.find((item) => !item.taskId || item.taskWorkspace === path.resolve(workspaceRoot()));
        if (!next) continue;
        if (!next.taskId) box.splice(box.indexOf(next), 1);
        store.save();
        refresh();
        void sendQueueItem(p.id, next).catch((e: any) => {
          console.error('[重启接力] 自动发送失败：', e?.message ?? e);
        });
      }
    }, 1200);
  };

  bootResumeOutbox = () => { tasks.recover(); resumeOutbox(); };

  const watchDefer = () => {
    if (deferTimer) return;
    idleTicks = 0;
    deferTimer = setInterval(() => {
      if (![...pendingAsk.values()].some((a) => a.armed)) {
        clearInterval(deferTimer!);
        deferTimer = null;
        return;
      }
      if (running.size) {
        idleTicks = 0;
        return;
      }
      idleTicks += 1;
      if (idleTicks < 2) return;
      clearInterval(deferTimer!);
      deferTimer = null;

      const armedEntries = [...pendingAsk.entries()].filter(([_, a]) => a.armed);
      const restartEntries = armedEntries.filter(([_, a]) => a.then.tool === 'restart_project');
      const otherEntries = armedEntries.filter(([_, a]) => a.then.tool !== 'restart_project');

      for (const [pid, ask] of otherEntries) {
        void runPending(pid, ask);
      }

      // 重启请求单例聚合：无论在几个面板点了等重启，统一清空 ask 框并只执行一次重启
      if (restartEntries.length > 0) {
        for (const [pid] of restartEntries) {
          pendingAsk.delete(pid);
          toAllWindows('chat:ask', { panelId: pid, ask: null, restartArmed: false });
        }
        const [primaryPid, primaryAsk] = restartEntries[0];
        // 动真格之前先落纸条：新进程开机靠它把压着的话发出去（旧进程等不到那一刻）
        armResumeOutbox();
        void (async () => {
          const out = await runToolConfirmed(primaryAsk.then.tool, primaryAsk.then.args, {
            panelId: primaryPid,
            host: primaryAsk.host,
            kind: primaryAsk.kind,
          });
          for (const [pid, ask] of restartEntries) {
            const note: ChatMessage = {
              id: W.newId('m'),
              role: 'tool',
              content: `**${ask.confirm}**\n\n${out}`,
              createdAt: Date.now(),
            };
            store.panel(pid)?.chat.push(note);
          }
          store.flushNow();
          refresh();
          for (const [pid] of restartEntries) {
            const lastNote = store.panel(pid)?.chat.slice(-1)[0];
            if (lastNote) toAllWindows('chat:message', { panelId: pid, message: lastNote });
          }
        })();
      }
    }, 1000);
  };

  /**
   * 真的做那件事 —— 用户当场点头做，和"等所有会话结束"到点了做，走的是同一条。
   */
  const runPending = async (panelId: string, ask: PendingAsk) => {
    pendingAsk.delete(panelId);
    toAllWindows('chat:ask', { panelId, ask: null, restartArmed: isRestartArmed() });

    const out = await runToolConfirmed(ask.then.tool, ask.then.args, { panelId, host: ask.host, kind: ask.kind });
    // 结果先写进对话、**立刻落盘**：那个工具真要收掉这个进程的话，下一秒就没了
    const note: ChatMessage = {
      id: W.newId('m'),
      role: 'tool',
      content: `**${ask.confirm}**\n\n${out}`,
      createdAt: Date.now(),
    };
    store.panel(panelId)?.chat.push(note);
    store.flushNow();
    refresh();
    toAllWindows('chat:message', { panelId, message: note });
    // 用户当场点头那种重启：也一样要落纸条 —— 重启后新进程才接得上队列里那句话，
    // 只不过它马上就动手了，纸条是给它自己（下一份自己）留的。
    if (ask.then.tool === 'restart_project') armResumeOutbox();
  };

  /**
   * 用户趁它还在跑的时候插进来的话 —— **只在内存里**。
   *
   * 为什么不落盘：它针对的是**此刻正在跑的那一轮**（等模型做完手头这一步就读到它）。
   * 那一轮一结束这个盒子就没意义了，存下来反而会让下次开软件冒出一句
   * 谁也看不懂的"旧插话"。待发队列（panel.outbox）才落盘，那是另一件事。
   *
   * 键是面板 id，值是**有序**的一小串 —— 谁先插的谁先进去，顺序不能乱。
   */
  const steerBox = new Map<string, SteerItem[]>();

  /** 插话盒子变了就告诉界面：那条排队条要跟着变（"等它这一步做完就插进去"） */
  const steerPush = (panelId: string) => {
    const list = steerBox.get(panelId) ?? [];
    toAllWindows('chat:steer', { panelId, items: list.map((i) => ({ id: i.id, text: i.text, images: i.images })) });
  };

  /**
   * 排队 / 插话的入口，仅此一处。
   *
   * 三个字段就够说清楚：`target` 决定去哪条边界，`panelId` 决定是谁说的，
   * 而它俩合起来决定了这件事归哪块面板 —— 队列串味（A 的话被 B 接走）就是
   * 从这里没带对 id 开始的。
   */
  const outboxOf = (panelId: string) => {
    const p = store.panel(panelId);
    if (!p) return null;
    if (!Array.isArray(p.outbox)) p.outbox = [];
    return p.outbox;
  };
  const outboxView = (panelId: string) =>
    (store.panel(panelId)?.outbox ?? []).map((i) => ({ id: i.id, text: i.text, images: i.images, at: i.at, taskId: i.taskId }));

  const sendQueueItem = (panelId: string, item: OutboxItem) =>
    doSend(panelId, item.text, item.images, item.taskId ? { taskId: item.taskId } : undefined);
  const pumpTaskQueue = (panelId: string) => {
    if (running.has(panelId) || isRestartArmed()) return;
    const box = outboxOf(panelId);
    const item = box?.find((item) => !item.taskId || item.taskWorkspace === path.resolve(workspaceRoot()));
    if (!item || (item.taskId && tasks.get(item.taskId)?.status !== 'queued')) return;
    if (!item.taskId) { box!.splice(box!.indexOf(item), 1); store.save(); refresh(); }
    void sendQueueItem(panelId, item).catch((error: any) => console.error('[任务队列]', error?.message || error));
  };

  /**
   * 排队：**不管它在不在跑，都先进队列**。
   *
   * 它在跑 → 这一整轮结束那一刻接力发出去（见 doSend 收尾）。
   * 它没在跑 → 队列摆上了也不会自己动，所以这里**顺手推它一把**：
   * 用户的意思很清楚（这句话要发出去），没必要让他再按一次。
   */
  const enqueue = (panelId: string, text: string, images?: string[]) => {
    const box = outboxOf(panelId);
    if (!box) return { ok: false, error: t('面板不存在') };
    const shots = (Array.isArray(images) ? images : []).map(keepShot).filter(Boolean);
    const item: OutboxItem = {
      id: W.newId('q'),
      text: String(text ?? ''),
      images: shots.length ? shots : undefined,
      at: Date.now(),
    };
    box.push(item);
    store.save();
    refresh();
    // 没在跑：队首那条就是这一句，直接发出去（出队再发，理由同接力那处）。
    // **但挂着重启时不推这一下**：用户按下回车的那个时刻它的意思就是"这句等重启之后再说"，
    // 当场发出去等于把这句话塞进一个马上要被收掉的进程里。留着，等新进程开机接力。
    if (!running.has(panelId) && !isRestartArmed()) {
      const next = box.find((item) => !item.taskId || item.taskWorkspace === path.resolve(workspaceRoot()));
      if (next) {
        if (!next.taskId) box.splice(box.indexOf(next), 1);
        store.save();
        refresh();
        void sendQueueItem(panelId, next).catch((e: any) => {
          console.error('[排队] 空闲时直接发送失败：', e?.message ?? e);
        });
      }
    }
    return { ok: true, item };
  };

  /**
   * 插话的唯一落点：`images` 这里收的已经是**磁盘路径**（调用方负责先存好）。
   */
  const pushSteer = (panelId: string, text: string, images?: string[], system?: boolean) => {
    if (!running.has(panelId)) {
      return { ok: false, error: t('它现在没在跑 —— 插话是插进正在跑的那一轮的。直接发送就行。') };
    }
    const item: SteerItem = { id: W.newId('s'), text: String(text ?? ''), images: images?.length ? images : undefined, system: system || undefined };
    steerBox.set(panelId, [...(steerBox.get(panelId) ?? []), item]);
    steerPush(panelId);
    return { ok: true, item };
  };

  /**
   * 插话（界面那条「插话」/ Ctrl+回车）：扔进它此刻正在跑的那一轮。
   *
   * 关键的一点是**它不需要等待发送** —— 模型跑到下一个步骤边界（手头这一步做完、
   * 下一次请求之前）就会读到它，而那一刻这一轮还没结束。
   * 没在跑的时候插话是无处可插的：直说，别悄悄变成一条排队（那样用户以为插上了，
   * 其实要等整轮结束才生效）。**先判这个再落图** —— 插不进去就不该留下临时无用文件。
   */
  const steerIn = (panelId: string, text: string, images?: string[]) => {
    if (!running.has(panelId)) {
      return { ok: false, error: t('它现在没在跑 —— 插话是插进正在跑的那一轮的。直接发送就行。') };
    }
    const shots = (Array.isArray(images) ? images : []).map(keepShot).filter(Boolean);
    return pushSteer(panelId, text, shots);
  };

  /** 步骤边界到了：把插话交出去（**交出去就清空**，同一句不会被喂两遍） */
  const takeSteering = (panelId: string): SteerItem[] => {
    const list = steerBox.get(panelId) ?? [];
    if (!list.length) return [];
    steerBox.delete(panelId);
    steerPush(panelId);
    return list;
  };

  /**
   * **插队**：让排队里的某一条**优先**走。
   *
   * 「优先到哪去」由面板此刻的状态定，用户只表达一件事"这条我不等了"：
   *   · 它正在跑 → 送进**正在跑的那一轮**（插话盒子）。它做完手头这一步就读到，
   *     不用等整轮跑完。这是"排队"和"插话"之间唯一那道门。
   *   · 它已经停了 → 抢在队里其他人前面**立刻发出去**。
   *
   * 为什么原来那道"必须在跑，否则不给插"的闸是坏的（这次专门修掉）：
   * 它假设"空闲时队首本来就会自动发，所以插队没意义"。可队列真停着不动的场合
   * 恰好有两个 —— **挂着等重启**（这一轮跑完了，队列故意不推，等重启后由新进程接力）
   * 和**上一轮出错**（出错不接力，不能把用户按下的"停止"当没按）。
   * 于是它只在"你并不需要它"的时候活着，真需要它的两处它都是死的。
   *
   * 图已经在排队那一步落过盘了，直接沿用那批路径，不再经一次 data URL。
   * 任何一步没走成，都**放回原位** —— 不能悄悄弄丢用户的一句话。
   */
  const promoteQueue = (panelId: string, id: string) => {
    const box = outboxOf(panelId);
    if (!box) return { ok: false, error: t('面板不存在') };
    const i = box.findIndex((x) => x.id === id);
    if (i < 0) return { ok: false, error: t('这条已经不在队列里了（可能已经开始发送）') };
    if (box[i].taskId) return { ok: false, error: '派单任务不能插入另一轮；请查询或取消任务' };

    const [item] = box.splice(i, 1);
    store.save();
    refresh();

    // ① 它在跑：送进正在跑的那一轮
    if (running.has(panelId)) {
      const r = pushSteer(panelId, item.text, item.images);
      if (!r.ok) {
        box.splice(i, 0, item);
        store.save();
        refresh();
      }
      return r;
    }

    // ② 它已经停了：立刻发这一条，队里其余的原样留着
    void doSend(panelId, item.text, item.images).catch((e: any) => {
      console.error('[插队] 立刻发送失败：', e?.message ?? e);
      // 发不出去就放回原位，别把这句话弄丢（面板这会儿要是没了，就只能算了）
      const back = outboxOf(panelId);
      if (!back) return;
      back.splice(Math.min(i, back.length), 0, item);
      store.save();
      refresh();
    });
    return { ok: true };
  };

  // ---------------------------------------------------------- 技能与插件

  ipcMain.handle('ext:list', () => {
    return {
      skills: scanSkills(store.disabledSkills()),
      plugins: loadPlugins(store.disabledPlugins()).info,
      skillsDir: skillsDir(),
      /** 一共扫了哪几个技能根（设置面板要显示这个 —— 技能不再只来自软件目录） */
      skillsDirs: skillRoots().map((r) => ({ path: r.path, source: r.source, exists: fs.existsSync(r.path) })),
      pluginsDir: pluginsDir(),
      workspacePluginsDir: workspaceRoot() ? path.join(workspaceRoot(), '.ensoul', 'plugins') : '',
    };
  });

  ipcMain.handle('ext:toggle', (_e, kind: 'skill' | 'plugin', name: string, on: boolean) => {
    store.setDisabled(kind, name, on);
    return { skills: scanSkills(store.disabledSkills()), plugins: loadPlugins(store.disabledPlugins()).info };
  });

  /**
   * 改一个插件参数 —— 设置面板里那些控件走这儿（助手走 plugin_params 工具，
   * 最后也落到同一个 setPluginParam）。value 传 null = 恢复默认。
   *
   * 改完把整份插件清单回过去：界面上要立刻显示新值，也得看看有没有插件因此出错。
   */
  ipcMain.handle('ext:setParam', (_e, plugin: string, key: string, value: unknown) => {
    const r = setPluginParam(String(plugin || ''), String(key || ''), value ?? null);
    return { plugins: loadPlugins(store.disabledPlugins()).info, error: r.ok ? undefined : r.error };
  });

  /**
   * 装 .ensoulpack 第一趟：**只看不写** —— 把要落哪些文件算出来给用户过目。
   *
   * 为什么要有这一趟：规范 §6 要求先弹清单再落盘（说清这个包会写哪些文件），
   * 而清单只有懂包格式的那一侧算得出来 —— 渲染层现在不碰 zip 了。
   * 两趟走同一个 planPluginPack：看的和写的必然是同一批文件，不会各说各的。
   */
  ipcMain.handle('ext:inspectPack', (_e, bytes: ArrayBuffer) => {
    try {
      const plan = planPluginPack(Buffer.from(bytes), {
        curVersion: appVersion(),
        installedPlugins: loadPlugins(store.disabledPlugins()).info.map((p) => p.name),
      });
      return { ok: true, id: plan.id, name: plan.name, version: plan.version, files: plan.files.map((f) => f.rel) };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });

  /**
   * 装 .ensoulpack 第二趟：**这一条才写盘**。
   *
   * 从前这条链整个跑在渲染层：那里没有 require / zlib（窗口是 sandbox +
   * contextIsolation，vite 又把 require 原样搬进产物），于是"设置 → 安装扩展包"
   * 一点就报 require is not defined —— ==导出的包装不回来==。
   * 现在解析在主进程，渲染层只把选到的字节递上来。
   *
   * 先算计划再落盘，顺序不能反：计划那一步把 id 与**每一个条目名**都夹住了
   * （不许 ..、不许绝对路径、不许盘符），任何一条不过就整包拒绝，一个字节都不落地。
   * 从前这两样都原样拼进路径，实测 ../../../src/main/index.ts 能覆盖到开源源码。
   */
  ipcMain.handle('ext:installPack', (_e, bytes: ArrayBuffer) => {
    let plan;
    try {
      plan = planPluginPack(Buffer.from(bytes), {
        curVersion: appVersion(),
        installedPlugins: loadPlugins(store.disabledPlugins()).info.map((p) => p.name),
      });
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
    try {
      for (const f of plan.files) {
        // 二进制写：包里可能有 png / 字体，过一遍 'utf8' 会静默写坏
        writeBytes(plan.targetDir + '/' + f.rel, f.data);
      }
    } catch (e: any) {
      return { ok: false, error: t('写文件失败：') + String(e?.message ?? e) };
    }
    refresh();
    return { ok: true, id: plan.id, name: plan.name, dir: plan.targetDir };
  });

  /**
   * 设置里的**插件分区**：导航（有哪些页）+ 内容（某一页此刻长什么样）+ 动作。
   *
   * 为什么要这一组：有些东西既不是面板也不是工具，而是**一份要在设置里看得见的名单**
   * （AI 员工的编制就是）。插件跑在主进程、画不了界面，所以照 status 那一套来：
   * 插件交一行行数据（含每行的按钮），核心画；用户点按钮时核心把动作递回插件。
   * 函数不过 IPC —— 界面拿到的是当下一刻那份数据，不拿着插件的取数函数到处跑。
   */
  ipcMain.handle('ext:sections', () => settingsSections());
  // 获取系统物理与虚拟音频输入设备（麦克风）
  ipcMain.handle('system:audio-inputs', async () => {
    try {
      if (process.platform === 'win32') {
        const { exec } = await import('child_process');
        return await new Promise((resolve) => {
          const psCmd = 'powershell -NoProfile -Command "Get-CimInstance Win32_SoundDevice | Select-Object Name, Status, DeviceID | ConvertTo-Json"';
          exec(psCmd, { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
            if (err || !stdout) return resolve([]);
            try {
              let parsed = JSON.parse(stdout);
              if (!Array.isArray(parsed)) parsed = [parsed];
              const list = parsed
                .filter((d: any) => d && d.Name && d.Status === 'OK')
                .map((d: any) => ({
                  value: d.Name,
                  label: d.Name
                }));
              resolve(list);
            } catch {
              resolve([]);
            }
          });
        });
      }
      return [];
    } catch {
      return [];
    }
  });


  // ------------------------------------------------------------ 运行环境、多版本 Python 与网络镜像加速
  const envConfigFile = () => path.join(workspaceRoot() || process.cwd(), '.ensoul', 'state', 'env-config.json');

  const MIRROR_MAP: Record<string, { pypi: string; npm: string }> = {
    official: { pypi: 'https://pypi.org/simple', npm: 'https://registry.npmjs.org/' },
    tsinghua: { pypi: 'https://pypi.tuna.tsinghua.edu.cn/simple', npm: 'https://registry.npmmirror.com/' },
    aliyun: { pypi: 'https://mirrors.aliyun.com/pypi/simple/', npm: 'https://registry.npmmirror.com/' },
    tencent: { pypi: 'https://mirrors.cloud.tencent.com/pypi/simple/', npm: 'https://registry.npmmirror.com/' },
    huawei: { pypi: 'https://repo.huaweicloud.com/repository/pypi/simple/', npm: 'https://registry.npmmirror.com/' },
    ustc: { pypi: 'https://pypi.mirrors.ustc.edu.cn/simple/', npm: 'https://registry.npmmirror.com/' },
  };

  const readEnvConfig = () => {
    try {
      const file = envConfigFile();
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      }
    } catch {}
    return {};
  };

/**
 * 上一次"真查到的"包清单。为什么要有它：`pip list` 偶尔会慢到超时，
 * 那一瞬间如果把结果直接画成"未安装"，用户会照着去做一次白装的 pip install。
 * 留着上次的结论兜底，界面上再标一句"这次没查出来"，就不会误导。
 */
  const readEnvDataCache = (file: string): { packages?: string[] } => {
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    return {};
  };

  const writeEnvDataCache = (file: string, packages: string[]) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ at: Date.now(), packages }, null, 2));
    } catch {}
  };

  ipcMain.handle('env:get', () => {
    const cfg = readEnvConfig();
    return {
      mirror: cfg.mirror || 'tsinghua',
      customPypi: cfg.customPypi || '',
      customNpm: cfg.customNpm || '',
      activePythonId: cfg.activePythonId || 'py-default',
      pythons: Array.isArray(cfg.pythons) ? cfg.pythons : [],
    };
  });

  ipcMain.handle('env:save', (_e, config: any) => {
    try {
      const file = envConfigFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(config || {}, null, 2), 'utf8');
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('env:pickFile', async () => {
    const opts = {
      title: t('选择 Python 解释器可执行文件'),
      properties: ['openFile' as const],
      filters: process.platform === 'win32'
        ? [{ name: 'Python Executable', extensions: ['exe'] }, { name: 'All Files', extensions: ['*'] }]
        : [{ name: 'All Files', extensions: ['*'] }]
    };
    const r = await HOST.pickOpenFile(opts);
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('env:testPython', async (_e, pyPath: string) => {
    const { exec } = await import('child_process');
    const cmd = pyPath?.trim() || 'python';
    return new Promise((resolve) => {
      exec(`"${cmd}" --version`, { encoding: 'utf8', timeout: 5000 }, (err, stdout, stderr) => {
        const out = [(stdout || '').trim(), (stderr || '').trim()].filter(Boolean).join(' ');
        if (!err && out.toLowerCase().includes('python')) {
          resolve({ ok: true, version: out });
        } else {
          resolve({ ok: false, error: out || err?.message || t('测试执行失败') });
        }
      });
    });
  });

  // ------------------------------------------------------------ 解释器实体的勘察与移除
  // 为什么要有这一对：以前「删除」只把记录从 env-config.json 里摘掉，磁盘上那份解释器一个字节不动。
  // 下载来的解释器（.ensoul/env/python-<ver>，实测能到 1.2 GB / 4.5 万文件）一旦摘了记录就再没人认领 ——
  // 名单上干干净净，盘上一直占着。更要命的是别的功能会拿它起常驻进程（语音插件的 daemon 就是），
  // 那个进程抱着目录，之后谁删都是 EPERM。所以这里把「勘察」和「动手」分开：先让界面把多大、
  // 几个文件、被谁占着摆出来，人点头了才真动。
  
  /** 下载来的解释器都落在这个根下面。**只有落在这儿的记录才允许物理删除** —— 用户自己挑的解释器永远只摘名单。 */
  const envRootDir = () => path.join(workspaceRoot() || process.cwd(), '.ensoul', 'env');
  
  /** 把任意拼法的路径拍平成小写、统一分隔符、去掉末尾斜杠，用来做安全比对 */
  const normPathKey = (p: string) => {
    try {
      return path.resolve(p).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
    } catch {
      return String(p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
    }
  };
  
  /** 这个路径是不是落在我管的 .ensoul/env 里（是 → 点删会真清盘；不是 → 只把它从名单里拿掉） */
  const insideEnvRoot = (dir: string) => {
    const root = normPathKey(envRootDir());
    const key = normPathKey(dir);
    return !!key && (key === root || key.startsWith(root + '/'));
  };
  
  /** 根自己不算（删根就是删所有解释器，不许） */
  const isEnvRootItself = (dir: string) => normPathKey(dir) === normPathKey(envRootDir());
  
  /** 只认解释器可执行文件本身；别拿一个 system32 下的怪东西去查「谁在用它」 */
  const looksLikeInterpreterExe = (p: string) => /^python(w)?(\.exe)?$/i.test(path.basename(p || ''));
  
  /** 递归量一个目录：几个文件、多少字节。量不动就如实标 partial，不编数。 */
  const measureDir = (dir: string): { files: number; bytes: number; partial: boolean } => {
    let files = 0;
    let bytes = 0;
    let partial = false;
    const walk = (d: string, depth: number) => {
      if (depth > 12) { partial = true; return; }
      let entries: any[] = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { partial = true; return; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        try {
          if (e.isDirectory()) walk(full, depth + 1);
          else if (e.isFile()) { files += 1; bytes += fs.statSync(full).size; }
        } catch { partial = true; }
      }
    };
    if (fs.existsSync(dir)) walk(dir, 0); else partial = true;
    return { files, bytes, partial };
  };
  
  /**
   * 查有哪些活着的进程正在用这个可执行文件。
   * 命令是**固定字符串**（不含任何插值），所以引号怎么拼都写死在这儿；跑不动就返回空数组 ——
   * 宁可不报，也不能把用户引去杀错进程。
   */
  const findUsingProcesses = async (exePath: string): Promise<Array<{ pid: number; path: string; memMB: number }>> => {
    try {
      const { exec } = await import('child_process');
      const cmd = String.raw`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name LIKE 'python%'\" | Select-Object ProcessId,ExecutablePath,WorkingSetSize | ConvertTo-Json -Compress"`;
      const stdout = await new Promise<string>((res) => {
        exec(cmd, { encoding: 'utf8', timeout: 8000 }, (_err: any, so: string) => res(so || ''));
      });
      const raw = JSON.parse((stdout || '').trim() || '[]');
      const arr = Array.isArray(raw) ? raw : [raw];
      const target = normPathKey(exePath);
      return arr
        .filter((it: any) => it && it.ExecutablePath && normPathKey(it.ExecutablePath) === target)
        .map((it: any) => ({
          pid: Number(it.ProcessId) || 0,
          path: String(it.ExecutablePath),
          memMB: Math.round((Number(it.WorkingSetSize) || 0) / 1048576),
        }));
    } catch {
      return [];
    }
  };
  
  /** 递归清一个目录；返回**还删不掉**的残留路径（Windows 上被进程占着的 .pyd 会卡在这） */
  const purgeDir = (dir: string, limit = 6): string[] => {
    const left: string[] = [];
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 }); } catch { /* 下面逐条再扫一遍 */ }
    const collect = (d: string, depth: number) => {
      if (left.length >= limit || depth > 12) return;
      let entries: any[] = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (left.length >= limit) return;
        const full = path.join(d, e.name);
        if (e.isDirectory()) collect(full, depth + 1);
        else { try { fs.unlinkSync(full); } catch { left.push(full); } }
      }
      try { fs.rmdirSync(d); } catch { if (left.length < limit) left.push(d); }
    };
    if (fs.existsSync(dir)) collect(dir, 0);
    return left;
  };
  
  /**
   * 勘察一条解释器记录：磁盘上对应什么、多大、能不能真删、现在谁抱着它。**只读**，不动任何东西。
   * 界面上那个确认框就是拿它的结论写的。
   */
  ipcMain.handle('env:inspectPython', async (_e, record: { id?: string; path?: string; name?: string }) => {
    const cfg = readEnvConfig();
    const list: any[] = Array.isArray(cfg.pythons) ? cfg.pythons : [];
    const rec: any = (record && record.id ? list.find((x: any) => x.id === record.id) : null) || record || {};
    const recPath = String(rec.path || '').trim();
    if (!recPath) return { ok: false, error: t('这条记录里没有解释器路径') };
  
    const isExe = looksLikeInterpreterExe(recPath);
    const dir = isExe ? path.dirname(path.resolve(recPath)) : '';
    const canDelete = !!dir && insideEnvRoot(dir) && !isEnvRootItself(dir) && fs.existsSync(dir);
    const size = canDelete ? measureDir(dir) : { files: 0, bytes: 0, partial: false };
    const inUse = isExe ? await findUsingProcesses(path.resolve(recPath)) : [];
  
    const references: string[] = [];
    if (inUse.length > 0) references.push(t('有进程正拿它跑着'));
    if (cfg.activePythonId && rec.id && cfg.activePythonId === rec.id) references.push(t('它当前是激活解释器'));
  
    return {
      ok: true,
      id: rec.id || '',
      name: rec.name || '',
      path: recPath,
      dir,
      dirExists: !!dir && fs.existsSync(dir),
      fileCount: size.files,
      bytes: size.bytes,
      partial: size.partial,
      canDelete,
      inUse,
      references,
    };
  });
  
  /**
   * 真删一条解释器记录：先收掉抱着它的进程，再递归清目录，最后摘登记。
   * 安全闸写死在 insideEnvRoot 那一条上 —— 用户自己挑的解释器不会被这个 handler 碰到盘。
   */
  ipcMain.handle('env:removePython', async (_e, record: { id?: string; path?: string }) => {
    const file = envConfigFile();
    const cfg = readEnvConfig();
    const list: any[] = Array.isArray(cfg.pythons) ? cfg.pythons : [];
    const id = record?.id || '';
    const rec: any = list.find((x: any) => x.id === id) || null;
    const recPath = String(rec?.path || record?.path || '').trim();
    const isExe = looksLikeInterpreterExe(recPath);
    const dir = isExe ? path.dirname(path.resolve(recPath)) : '';
    const killed: number[] = [];
    let inUse: Array<{ pid: number; path: string; memMB: number }> = [];
    let disk: { mode: 'deleted' | 'refused' | 'external' | 'missing'; bytes: number; files: number; leftovers?: string[] } =
      { mode: 'missing', bytes: 0, files: 0 };
  
    if (!recPath) {
      disk = { mode: 'missing', bytes: 0, files: 0 };
    } else if (!isExe || !insideEnvRoot(dir) || isEnvRootItself(dir)) {
      disk = { mode: 'external', bytes: 0, files: 0 }; // 自己挑的解释器：只摘名单，一个字节都不动
    } else if (!fs.existsSync(dir)) {
      disk = { mode: 'missing', bytes: 0, files: 0 };
    } else {
      inUse = await findUsingProcesses(path.resolve(recPath));
      const size = measureDir(dir);
      // 抱着它的进程必须收掉：不收掉目录永远删不干净，而且它还在这儿等着跑
      for (const proc of inUse) {
        if (!proc.pid) continue;
        try {
          const { exec } = await import('child_process');
          await new Promise<void>((res) => {
            exec(`taskkill /PID ${proc.pid} /T /F`, { windowsHide: true }, () => res());
          });
          killed.push(proc.pid);
        } catch { /* 杀不掉也照删，删不动会如实报残留 */ }
      }
      if (killed.length) await new Promise((r) => setTimeout(r, 500)); // 给 Windows 一点时间松开文件句柄
      const leftovers = purgeDir(dir);
      if (fs.existsSync(dir)) disk = { mode: 'refused', bytes: 0, files: 0, leftovers };
      else disk = { mode: 'deleted', bytes: size.bytes, files: size.files };
    }
  
    // 摘登记：列表里那条拿掉，激活项落到剩下第一条
    const nextList = list.filter((x: any) => x.id !== id);
    const nextActive = (cfg.activePythonId === id || !nextList.some((x: any) => x.id === cfg.activePythonId))
      ? (nextList[0]?.id || 'py-default')
      : cfg.activePythonId;
    let wrote = true;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...cfg, pythons: nextList, activePythonId: nextActive }, null, 2), 'utf8');
    } catch { wrote = false; }
  
    return { ok: true, id, killed, disk, wrote, remaining: nextList.length, activePythonId: nextActive };
  });
  
  /** 孤儿解释器：.ensoul/env 里躺着、名单上已经没有的目录。**只列不删**。 */
  ipcMain.handle('env:listOrphans', () => {
    const cfg = readEnvConfig();
    const list: any[] = Array.isArray(cfg.pythons) ? cfg.pythons : [];
    const claimed = list
      .map((x: any) => String(x.path || '').trim())
      .filter((x: string) => looksLikeInterpreterExe(x))
      .map((x: string) => normPathKey(path.dirname(path.resolve(x))));
    const root = envRootDir();
    let names: string[] = [];
    try { names = fs.readdirSync(root); } catch { return []; }
    return names
      .map((name) => ({ name, dir: path.join(root, name) }))
      .filter((it) => {
        try { return fs.statSync(it.dir).isDirectory(); } catch { return false; }
      })
      .filter((it) => !claimed.includes(normPathKey(it.dir)))
      .map((it) => {
        const size = measureDir(it.dir);
        return { name: it.name, dir: it.dir, bytes: size.bytes, files: size.files };
      });
  });
  
  /** 清一个孤儿目录（同样只认 .ensoul/env 底下的东西） */
  ipcMain.handle('env:removeOrphan', async (_e, dirIn: string) => {
    const dir = String(dirIn || '').trim();
    if (!dir || !insideEnvRoot(dir) || isEnvRootItself(dir)) return { ok: false, error: t('这个目录不在受管的解释器根目录里，拒绝删除') };
    if (!fs.existsSync(dir)) return { ok: true, bytes: 0, files: 0, leftovers: [] as string[] };
    const size = measureDir(dir);
    const leftovers = purgeDir(dir);
    return { ok: true, bytes: size.bytes, files: size.files, leftovers };
  });

  ipcMain.handle('env:detect', async () => {
    const { exec } = await import('child_process');
    const cfg = readEnvConfig();
    const pythons: Array<{ id: string; name: string; path: string; version?: string; available?: boolean }> =
      Array.isArray(cfg.pythons) && cfg.pythons.length > 0
        ? [...cfg.pythons]
        : [];

    const execP = (cmd: string, timeout = 5000): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
      return new Promise((resolve) => {
        exec(cmd, { encoding: 'utf8', timeout }, (err, stdout, stderr) => {
          if (err) resolve({ ok: false, stdout: (stdout || '').trim(), stderr: (stderr || err.message).trim() });
          else resolve({ ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
        });
      });
    };

    // 扫描本机的候选 Python 路径
    let systemCandidates: string[] = [];
    if (process.platform === 'win32') {
      const whereRes = await execP('where python', 3000);
      if (whereRes.ok && whereRes.stdout) {
        systemCandidates = whereRes.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      }
    } else {
      const whichRes = await execP('which -a python3 python', 3000);
      if (whichRes.ok && whichRes.stdout) {
        systemCandidates = whichRes.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      }
    }
    systemCandidates = Array.from(new Set(systemCandidates));

    // 如果还没有配置任何 python，默认注入系统默认 'python'
    if (pythons.length === 0) {
      pythons.push({
        id: 'py-default',
        name: t('系统默认 Python (PATH)'),
        path: 'python',
        available: true,
      });
    }

    // 探测列表里每个 python 的状态
    for (const py of pythons) {
      const testRes = await execP(`"${py.path}" --version`);
      if (testRes.ok && testRes.stdout.toLowerCase().includes('python')) {
        py.version = testRes.stdout;
        py.available = true;
      } else {
        py.version = t('不可用或未找到');
        py.available = false;
      }
    }

    const activeId = cfg.activePythonId || pythons[0]?.id || 'py-default';
    const activeEntry = pythons.find(p => p.id === activeId) || pythons[0];
    const activeCmd = activeEntry?.path || 'python';

    /**
     * 解析当前激活 Python 下装了哪些包。
     *
     * 这里最容易骗人：`pip list` 慢一点（conda 那种上千包的），或者当场出错，
     * 传出去的就是四个 false —— 界面上跟"真的没装"一模一样。
     * 于是宁慢勿错：给足时间；真查不出来就**明说没查出来**，并拿上一次的结果兜着，
     * 绝不再把"不知道"画成"没安装"。
     */
    const probe = async (): Promise<{ names: Set<string> | null; error: string }> => {
      if (!activeEntry?.available) return { names: null, error: t('解释器本身没探到（--version 都没应）') };
      try {
        const pipListRes = await execP(`"${activeCmd}" -m pip list --format=json`, 20000);
        if (!pipListRes.ok || !pipListRes.stdout) {
          return { names: null, error: (pipListRes.stderr || t('pip list 没有输出')).slice(0, 300) };
        }
        const list = JSON.parse(pipListRes.stdout);
        return { names: new Set(list.map((item: any) => String(item.name || '').toLowerCase())), error: '' };
      } catch (e: any) {
        return { names: null, error: String(e?.message ?? e).slice(0, 300) };
      }
    };

    const cacheFile = path.join(workspaceRoot() || process.cwd(), '.ensoul', 'state', 'env-data.json');
    const prev = readEnvDataCache(cacheFile);
    const probeRes = await probe();
    // 真查到了才更新缓存；查不到就沿用上次那份 —— 总比给出一个假的"未安装"强
    const names = probeRes.names ?? new Set<string>(prev.packages || []);
    const known = !!probeRes.names || (prev.packages || []).length > 0;
    const hasFunasr = names.has('funasr');
    const hasTorch = names.has('torch');
    const hasTorchaudio = names.has('torchaudio');
    const hasModelscope = names.has('modelscope');
    if (probeRes.names) writeEnvDataCache(cacheFile, [...names]);

    return {
      nodeVersion: process.version,
      mirror: cfg.mirror || 'tsinghua',
      customPypi: cfg.customPypi || '',
      customNpm: cfg.customNpm || '',
      activePythonId: activeEntry?.id || 'py-default',
      activePythonPath: activeCmd,
      activePythonVersion: activeEntry?.version || '',
      pythons,
      systemCandidates,
      python: {
        configured: activeCmd,
        activePath: activeCmd,
        version: activeEntry?.version || '',
        available: !!activeEntry?.available,
        packages: {
          funasr: hasFunasr,
          torch: hasTorch,
          torchaudio: hasTorchaudio,
          modelscope: hasModelscope,
        },
        /** 这份结论是"真查到了"还是"没查出来、沿用上次"——界面必须分得清 */
        packagesKnown: known,
        probeError: probeRes.error,
        sensevoiceReady: known ? hasFunasr && hasTorch && hasTorchaudio : undefined,
      },
    };
  });

  ipcMain.handle('env:downloadPython', async (_e, versionKey: string) => {
    const { exec } = await import('child_process');
    const https = await import('https');
    const http = await import('http');
    const os = await import('os');

    const ver = versionKey || '3.10.11';
    const downloadUrl = `https://cdn.npmmirror.com/binaries/python/${ver}/python-${ver}-embed-amd64.zip`;
    const targetDir = path.join(workspaceRoot() || process.cwd(), '.ensoul', 'env', `python-${ver}`);
    fs.mkdirSync(targetDir, { recursive: true });
    const zipPath = path.join(targetDir, 'python.zip');
    const pyExe = path.join(targetDir, 'python.exe');

    // 如果已经存在 python.exe 且 pip 可用，直接成功
    if (fs.existsSync(pyExe)) {
      const hasPip = await new Promise<boolean>((res) => {
        exec(`"${pyExe}" -m pip --version`, { timeout: 4000 }, (err) => res(!err));
      });
      if (hasPip) {
        return { ok: true, path: pyExe, version: `Python ${ver}` };
      }
    }

    const downloadFile = (url: string, dest: string): Promise<void> => {
      return new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(dest);
        const getter = url.startsWith('https') ? https : http;
        const request = (reqUrl: string) => {
          getter.get(reqUrl, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              return request(res.headers.location);
            }
            if (res.statusCode !== 200) {
              return reject(new Error(`下载失败，HTTP 状态码: ${res.statusCode}`));
            }
            res.pipe(fileStream);
            fileStream.on('finish', () => {
              fileStream.close(() => resolve());
            });
          }).on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
          });
        };
        request(url);
      });
    };

    try {
      if (!fs.existsSync(pyExe)) {
        // 1. 下载并解压 embed zip
        await downloadFile(downloadUrl, zipPath);
        await new Promise<void>((resolve, reject) => {
          exec(`tar -xf "${zipPath}" -C "${targetDir}"`, { encoding: 'utf8', timeout: 60000 }, (err) => {
            if (err) reject(new Error(t('解压失败: ') + err.message));
            else resolve();
          });
        });
        fs.unlink(zipPath, () => {});
      }

      // 2. 修复 embed 的 _pth：开启 import site，加入 site-packages
      const pthFiles = fs.readdirSync(targetDir).filter((f) => f.endsWith('._pth'));
      for (const pthName of pthFiles) {
        const pthFile = path.join(targetDir, pthName);
        let pthContent = fs.readFileSync(pthFile, 'utf8');
        pthContent = pthContent.replace(/#import site/g, 'import site');
        if (!pthContent.includes('site-packages')) {
          pthContent += '\nLib\\site-packages\nLib\n';
        }
        fs.writeFileSync(pthFile, pthContent, 'utf8');
      }

      // 3. 安装 pip
      const tempPip = path.join(os.tmpdir(), `get-pip-${Date.now()}.py`);
      try {
        await downloadFile('https://bootstrap.pypa.io/get-pip.py', tempPip);
      } catch {
        await downloadFile('https://registry.npmmirror.com/-/binary/python/get-pip.py', tempPip);
      }

      if (fs.existsSync(tempPip)) {
        await new Promise<void>((resolve, reject) => {
          exec(`"${pyExe}" "${tempPip}" --no-warn-script-location`, { encoding: 'utf8', timeout: 180000 }, (err) => {
            fs.unlink(tempPip, () => {});
            if (err) reject(new Error(t('安装 pip 失败: ') + err.message));
            else resolve();
          });
        });
      }

      return { ok: true, path: pyExe, version: `Python ${ver}` };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // ------------------------------------------------------------ 后台 Pip 任务状态管理 (持久化流式日志，防关掉丢失)
  let activePipProcess: any = null;
  let activePipLog = '';
  let activePipStatus: 'idle' | 'running' | 'success' | 'failed' = 'idle';

  ipcMain.handle('env:pipStatus', () => {
    return {
      status: activePipStatus,
      log: activePipLog,
      running: activePipStatus === 'running',
    };
  });

  ipcMain.handle('env:runPip', async (_e, pkgList: string, options?: { pythonPath?: string; mirror?: string; customPypi?: string }) => {
    const { spawn } = await import('child_process');
    const cfg = readEnvConfig();

    if (activePipStatus === 'running') {
      return { ok: false, output: activePipLog, running: true, message: t('已有正在执行中的下载安装任务') };
    }

    let pyCmd = options?.pythonPath?.trim();
    if (!pyCmd) {
      if (cfg.activePythonId && Array.isArray(cfg.pythons)) {
        const found = cfg.pythons.find((p: any) => p.id === cfg.activePythonId);
        if (found && found.path) pyCmd = found.path;
      }
      if (!pyCmd) pyCmd = 'python';
    }

    const pkgs = String(pkgList || '').trim();
    if (!pkgs) return { ok: false, output: t('未指定要安装的包') };

    const mirrorKey = options?.mirror || cfg.mirror || 'tsinghua';
    let pypiUrl = '';
    if (mirrorKey === 'custom') {
      pypiUrl = options?.customPypi || cfg.customPypi || '';
    } else if (MIRROR_MAP[mirrorKey]) {
      pypiUrl = MIRROR_MAP[mirrorKey].pypi;
    }

    const args = ['-m', 'pip', 'install', ...pkgs.split(/\s+/).filter(Boolean), '--progress-bar', 'on', '--no-warn-script-location'];
    if (pypiUrl) {
      args.push('-i', pypiUrl);
      try {
        const parsed = new URL(pypiUrl);
        args.push('--trusted-host', parsed.hostname);
      } catch {}
    }

    activePipStatus = 'running';
    activePipLog = `[开始安装]: ${pyCmd} -m pip install ${pkgs}\n[镜像加速]: ${pypiUrl || '官方默认'}\n----------------------------------------\n`;

    const broadcastPip = (chunk: string) => {
      activePipLog += chunk;
      // 保留末尾 10 万字，防止无限增长
      if (activePipLog.length > 100000) {
        activePipLog = activePipLog.slice(-80000);
      }
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('env:pipLog', { log: activePipLog, chunk });
      }
    };

    try {
      const child = spawn(pyCmd, args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      activePipProcess = child;

      child.stdout?.on('data', (d: Buffer) => {
        broadcastPip(d.toString());
      });

      child.stderr?.on('data', (d: Buffer) => {
        broadcastPip(d.toString());
      });

      return new Promise((resolve) => {
        child.on('close', (code: number) => {
          activePipProcess = null;
          if (code === 0) {
            activePipStatus = 'success';
            broadcastPip('\n----------------------------------------\n[安装成功] 所有指定依赖已就绪。\n');
            resolve({ ok: true, output: activePipLog });
          } else {
            activePipStatus = 'failed';
            broadcastPip(`\n----------------------------------------\n[安装中断/失败] 进程退出码: ${code}\n`);
            resolve({ ok: false, output: activePipLog });
          }
        });

        child.on('error', (err: any) => {
          activePipProcess = null;
          activePipStatus = 'failed';
          broadcastPip(`\n----------------------------------------\n[启动进程异常]: ${err?.message || err}\n`);
          resolve({ ok: false, output: activePipLog });
        });
      });
    } catch (err: any) {
      activePipStatus = 'failed';
      activePipLog += `\n[调用失败]: ${err?.message || err}\n`;
      return { ok: false, output: activePipLog };
    }
  });

  ipcMain.handle('ext:section', (_e, plugin: string, id: string) => settingsSectionView(plugin, id));

  /** 分区里点了个按钮：插件干活，回来的是新内容 + 一句回执（一起给，省一趟） */
  ipcMain.handle('ext:sectionAction', async (_e, plugin: string, id: string, actionId: string, rowId: string) => {
    const r = await runSettingsAction(plugin, id, actionId, rowId);
    // 动作多半改了面板/布局（叫到岗、摆到布局就是），顺手把工作区广播一遍
    refresh();
    const view = await settingsSectionView(plugin, id);
    return { ...r, view };
  });

  /** 看一眼技能正文（设置面板里点开就能读，不用去文件夹里找） */
  ipcMain.handle('ext:readSkill', (_e, name: string) => readSkill(name, store.disabledSkills()));

  /**
   * 看图的两个动作：**交给系统**去开。
   *
   * 为什么要住在核心里、而且是主进程：渲染进程没有 Node 能力，
   * `shell.openPath` / `showItemInFolder` 只有主进程有。
   * 界面那边只报"用户点了哪张图、点了哪个动作"，路径原样带过来 ——
   * 能不能开是系统的事，不在这里猜（开不了它会回一段错误文本）。
   */
  ipcMain.handle('shell:openFile', (_e, p: string) => HOST.openPath(String(p || '')));
  ipcMain.handle('shell:revealFile', (_e, p: string) => {
    HOST.revealInFolder(String(p || ''));
    return '';
  });

  ipcMain.handle('ext:reveal', async (_e, which: 'skills' | 'plugins' | 'workspace-skills' | 'workspace-plugins') => {
    const dir =
      which === 'skills'
        ? skillsDir()
        : which === 'plugins'
          ? pluginsDir()
          : path.join(workspaceRoot(), '.ensoul', which === 'workspace-skills' ? 'skills' : 'plugins');
    // 目录还不存在时先建出来：空目录也能打开，比"打不开"好解释
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* 建不出来就直接打开父目录，openPath 会给出错误 */
    }
    return HOST.openPath(dir);
  });

  /**
   * 插件请用户点头时走这儿：**不执行**，只把请求摆到界面上等用户按。
   *
   * 插件不用认识界面，核心也不用认识插件 —— 中间只有这一份 AskSpec（见 plugins.ts）。
   */
  const raiseAsk = (spec: AskSpec) => {
    const panel = store.panel(spec.panelId);
    if (!panel) return;
    const isRestart = spec.then?.tool === 'restart_project';
    // 若当前已处于全局挂起重启中，后续重启请求直接同步为 armed，避免多面板或多轮重复弹出待确认框
    const alreadyRestartArmed = isRestart && isRestartArmed();
    pendingAsk.set(spec.panelId, {
      host: store.hostKeyOf(spec.panelId),
      kind: panel.kind,
      text: spec.text,
      confirm: spec.confirm || t('确认'),
      cancel: spec.cancel || t('先不'),
      defer: spec.defer ? String(spec.defer.label || t('等所有会话结束')) : undefined,
      then: { tool: spec.then.tool, args: spec.then.args },
      armed: alreadyRestartArmed ? true : undefined,
    });
    toAllWindows('chat:ask', {
      panelId: spec.panelId,
      ask: askView(pendingAsk.get(spec.panelId)),
      restartArmed: isRestartArmed(),
    });
    refresh();
  };
  setAskHandler(raiseAsk);

  /**
   * 发一句话进某个面板、跑完整整一轮 —— 界面上的输入框和 plugins/remote 从
   * HTTP 收到的远程消息**走同一条路**：不另开第二套，权限、压缩、便签就只有一份。
   */
  const doSend = async (panelId: string, text: string, images?: string[], opts?: { silent?: boolean; signal?: AbortSignal; taskId?: string }) => {
    if (opts?.signal?.aborted) return { ok: false, error: t('这一轮已停止') };
    if (running.has(panelId)) return { ok: false, error: t('面板仍在执行或收尾，请使用排队或插话') };
    let panel = store.panel(panelId);
    if (!panel) {
      if (store.reopenPanel(panelId)) {
        refresh();
        panel = store.panel(panelId);
      }
    }
    if (!panel) return { ok: false, error: t('面板不存在') };

    const assistantId = W.newId('m');
    const assistant: ChatMessage = { id: assistantId, role: 'assistant', content: '', createdAt: Date.now(), streaming: true };
    const ctrl = new AbortController();
    const abortFromParent = () => ctrl.abort(opts?.signal?.reason);
    opts?.signal?.addEventListener('abort', abortFromParent, { once: true });
    if (!setRunning(panelId, ctrl, assistant)) return { ok: false, error: t('面板正在执行') };
    let taskOutcome: { ok: boolean; content?: string; error?: string } | undefined;
    const outcome = <T extends { ok: boolean; content?: string; error?: string }>(result: T): T => { taskOutcome = result; return result; };
    try {
    if (opts?.taskId && !tasks.begin(opts.taskId, assistantId, ctrl)) return outcome({ ok: false, error: '任务已经结束或不可执行' });

    // 每条消息开始前重新扫技能、重新加载插件：上一条消息里刚写好的技能或插件，
    // 下一条消息立刻可用。不这么做，"自我进化"就得重启一次才算数。
    // （插件实例是留住的，这里只做一次 stat —— 改过的才重装，没改的接着用。）
    const disabledSkills = store.disabledSkills();
    const extensions = loadPlugins(store.disabledPlugins());
    const host = store.hostKeyOf(panelId);
    const ctx: ToolContext = { panelId, host, kind: panel.kind, runId: assistantId, taskId: opts?.taskId, signal: ctrl.signal };
    setExtensions({
      tools: extensions.tools,
      beforeWrite: extensions.beforeWrite,
      beforeTool: extensions.beforeTool,
      afterTool: extensions.afterTool,
      fileWrite: extensions.fileWrite,
      disabledSkills,
      layout: () => describeLayout(store.state),
      // 组件声明 / 撤销 / 克隆 —— 由模型用 component_declare / component_remove / component_clone 调
      components: {
        declare: (panelId, name) => {
          const id = String(panelId || '');
          const p = store.panel(id);
          if (!p) {
            const all = Object.values(store.state.panels);
            return `找不到那块面板${id ? `（${id}）` : ''} —— 现在开着的有：`
              + (all.length ? all.map((x) => `${x.title}（${x.kind} · ${x.id}）`).join('、') : t('（一块也没有）'));
          }
          const c = store.declareComponent(id, name);
          if (!c) return t('声明没写下来（存档失败），面板原样没动。');
          refresh();
          return `已把「${p.title}」声明为组件「${c.component}」 —— 从现在起它被永久保存：`
            + `关不关都在 设置 → 组件 里，只有在那儿点删除才会没。`
            + `顶上那条收纳区**没有**多出东西（声明 ≠ 钉住）：想挂上去就把面板拖进那一段，`
            + `或者跟用户说一句"收进收纳区"。`
            + `要撤回声明：component_remove({"key":"${c.component}"})。`;
        },
        clone: (id) => {
          const src = store.componentRefs().find((c) => c.id === String(id || ''));
          const p = store.cloneComponent(String(id || ''));
          if (!p) return `克隆不了${id ? `（${id}）` : ''}：找不到这条组件的本体。`;
          refresh();
          return `已照「${src?.component || src?.name || p.title}」克隆出一块新的（${p.title} · ${p.id}），`
            + `已经开在布局里了 —— 两份从此各聊各的，改一边不动另一边。`;
        },
        remove: (key) => {
          const list = store.componentRefs();
          const k = String(key || '').trim();
          const low = k.toLowerCase();
          const hit =
            list.find((c) => c.id === k) ||
            list.find((c) => (c.component || '') === k) ||
            list.find((c) => c.name === k) ||
            (k ? list.find((c) => (c.component || '').toLowerCase().includes(low)) : undefined);
          if (!hit) {
            return `没有这个组件${k ? `（${k}）` : ''}。现在有的是：`
              + (list.length ? list.map((c) => `${c.component || c.name}（${c.kind}）`).join('、') : t('（一个也没有）'));
          }
          const stillOpen = !!store.panel(hit.id);
          store.removeComponent(hit.id);
          refresh();
          return `已撤销组件「${hit.component || hit.name}」`
            + (stillOpen ? t('（面板还开着，只是不再是组件了）') : t('（那份记录一起删了）'));
        },
      },
    });

    // 插件的状态部件：每轮都重新接一次（插件可能刚被改过）
    wireStatus(extensions.status);
    wireCommands(extensions.commands);

    const emit = (channel: string, payload: any) => HOST.broadcast(channel, payload);

    // 记录用户本轮发话瞬间的面板状态快照（回退时精确恢复到用户输入会话时的状态）
    const turnSnapshot: PanelRevision = {
      at: Date.now(),
      kind: panel.kind,
      title: panel.title,
      look: JSON.parse(JSON.stringify(panel.look || {})),
      spec: JSON.parse(JSON.stringify(panel.spec || {})),
      note: (text || '').trim().slice(0, 30) || t('用户发话'),
    };

    // 图先落盘，消息里只留路径。
    // **两种都能收**：界面粘进来的图是 data URL；从待发队列接力过来的那条，
    // 图在排队那一刻就已经落过盘了，给的是路径（再当 data URL 存一遍会全丢）。
    const shots = (Array.isArray(images) ? images : []).map(keepShot).filter(Boolean);
    const userMsg: ChatMessage = {
      id: W.newId('m'),
      role: 'user',
      content: text,
      createdAt: Date.now(),
      images: shots.length ? shots : undefined,
      // 插件注入的机器触发语：**照进历史、不上屏**（见 ChatMessage.silent）。
      // 不 push 进 chat 是不行的 —— 模型下一轮回头就看不明白自己刚才为什么动起来。
      silent: opts && opts.silent ? true : undefined,
    };
    // 点点转蓝：这一轮开始了。必须在这里就广播 —— 等跑完再改，
    // 用户盯着的那个点整轮都是灰的，等于没做。
    panel.status = 'working';
    // 上一轮要是留下个没收拾干净的容器，新的一轮从干净的开始
    liveClear(panelId);
    /**
     * 上一轮要是还有没领走的插话，到这儿就作废了 —— 它针对的是上一轮那一次跑动。
     * 不扔的话，新的一轮一开跑就会被上一轮的旧插话糊一脸。
     */
    if (steerBox.has(panelId)) {
      steerBox.delete(panelId);
      steerPush(panelId);
    }
    panel.chat.push(userMsg);
    store.save();
    emit('chat:message', { panelId, message: userMsg });
    refresh();

    /**
     * 出错的标记（和 Message.tsx 里"默认摊开"的那几条同源）：失败的步骤要让人一眼看见。
     * 命令和工具共用同一套判据。
     */
    const BAD_STEP =
      /工具执行失败|没有这个工具|没能启动|没停下来|构建没过|构建起不来|没有执行|（退出码 [1-9]|not recognized|No such file/;

    /**
     * 斜杠命令（/xxx）：**主进程直接执行，命中就到此为止 —— 模型一个字都不说**。
     *
     * 为什么不让模型插一脚：结果本来就是硬查出来的，再交给模型复述一遍，等于给一个
     * 确定性的结果加一层会出错的转述，还照样按整段上下文烧钱（这块面板已经 89 条对话）。
     * 命中 /xxx 就该跟敲一下本地指令是一回事。认不出的 /xxx 不拦，照常当普通消息发。
     */
    const slashHit = /^\/([\w\u4e00-\u9fa5-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    const slashCmd = slashHit ? extensions.commands.find((c) => c.id === slashHit[1]) : undefined;
    if (slashHit && slashCmd) {
      const argStr = (slashHit[2] || '').trim();
      let out: string;
      try {
        out = String((await slashCmd.handler(argStr, ctx)) ?? '');
        ctrl.signal.throwIfAborted();
      } catch (e: any) {
        out = `命令没有执行：${e?.message ?? e}`;
      }
      const firstLine = (out.split('\n').find((l) => l.trim()) ?? '').trim();
      const now = Date.now();
      const note: ChatMessage = {
        id: W.newId('m'),
        role: 'tool',
        content: `**/${slashCmd.id}${argStr ? ` ${argStr}` : ''}**\n\n\`\`\`\n${out.slice(0, 3000)}\n\`\`\``,
        createdAt: now,
      };
      if (slashCmd.id === 'new') {
        panel.createdAt = now;
        panel.updatedAt = now;
        (panel as any).newSessionAt = now;
      }
      panel.chat.push(note);
      // 点点要落地：命令报错了标红，正常跑完标绿
      panel.status = BAD_STEP.test(firstLine) ? 'error' : 'done';
      store.save();
      emit('chat:message', { panelId, message: note });
      refresh();
      return outcome({ ok: !ctrl.signal.aborted && !BAD_STEP.test(firstLine), content: out, error: ctrl.signal.aborted ? t('这一轮已停止') : undefined });
    }

    /**
     * 这一轮的"壳"先立起来：图要挂在**这条**回复上（say.image 找的是 running 里那条消息），
     * 停止键也要立刻可用 —— 两件事都等 runAgent 之后就来不及了。
     */
    turnStart(panelId, Date.now(), text);
    // 从这一刻起这一轮的正文就"看得见"了（给插件看的快照会带上它）——
    // 插件要的流式就是这一条：有多少转多少，不是整轮跑完才吐。
    store.setLiveTurn(panelId, assistant);

    // 文本里 @ 到的文件，把内容一并带给模型（界面显示的还是原文）
    const refs = [...new Set([...text.matchAll(/@([^\s@]+)/g)].map((m) => m[1]))];
    const attached: string[] = [];
    for (const rel of refs) {
      try {
        const body = readText(rel);
        if (body) attached.push(`【工作区文件 ${rel}】\n\`\`\`\n${body.slice(0, 20000)}\n\`\`\``);
      } catch {
        /* 引用了不存在的文件就忽略 */
      }
    }
    /**
     * 斜杠命令（/xxx）：**主进程直接执行，不经模型** —— 这就是那条确定性入口。
     * 模型这轮拿到的输入里带着真实返回，它只能接着事实往下写；
     * "没跑却说成了"在这里没有落脚点。认不出的 /xxx 不拦，照常当普通消息发。
     */
    const forModel = attached.length ? `${attached.join('\n\n')}\n\n${text}` : text;

    /**
     * 上下文前缀与环境注入：
     * 面板此刻的实时事实（标题/种类/规格/外观）与插件每轮动态（如 todo 清单、git 状态、定时提醒等）
     * 作为【运行时快照】附加在当前轮用户消息头部。
     * 由于处于当前请求的最末尾，历史对话的 KV 前缀缓存不受任何影响。
     * 工作模式（【工作模式：xx】）跟它同一段 —— 同理，切模式也只有这一小段要重算。
     */
    const promptDeltaNotice = consumePromptDeltas(panel);
    const extras = pluginExtras(ctx, extensions.prompts);
    const facts = buildPanelSnapshot(panel, describePlace(panelId));
    const envBlock = [facts, extras].filter(Boolean).join('\n\n');
    // 工作模式接在**本轮消息尾部**（跟快照同一段），不进系统提示 —— 它是会变的东西：
    // 进了系统提示，每切一次模式就要把整段历史重算一遍；拼在尾部就只重算这一小段。
    const modeSec = modeSection(panel.mode);
    let userTurn = [modeSec, envBlock ? '【运行时快照】\n' + envBlock : '', forModel].filter(Boolean).join('\n\n');
    if (promptDeltaNotice) {
      userTurn = `${promptDeltaNotice}\n\n${userTurn}`;
    }

    // 发给模型的对话：系统提示 + 历史 + 这一句（@引用的文件内容已经拼进去了）。
    // 带图的消息走多模态格式：文本 + 若干 image_url。没图的还是纯字符串，
    // 所以老消息一个字都不用改。
    const asApiMessage = (role: string, body: string, pics?: string[]) => {
      const parts = (pics ?? []).map(shotPart).filter(Boolean) as any[];
      if (!parts.length) return { role, content: body };
      return { role, content: [...(body ? [{ type: 'text', text: body }] : []), ...parts] };
    };

    // apiMessages 挪到下面去了 —— 压缩要用 cfg，而 cfg 在后面才拿到

    // 这个面板用的模型：会话自己选的优先，没选过退到它所在窗口
    const cfg = store.modelForPanel(panelId);
    // 这一轮是哪个模型（`provider::model`）—— 连同单价快照一起写进这条账。
    // 记它是给"按模型算钱"用的（见 plugins/billing）：光有三个 token 数分不出
    // 这一笔是免费模型还是贵的那个。
    const pick = store.pickForPanel(panelId);
    // 这一轮用的单价快照 —— 之后换模型，旧账不该跟着变
    const price = priceOf(pick);
    if (!cfg.apiKey) {
      assistant.streaming = false;
      assistant.content = t('这个提供方还没配密钥。点右上角齿轮 → 模型 → 填进去就行。');
      panel.status = 'error'; // 没跑起来也算这一轮失败了，点点标红
      panel.chat.push(assistant);
      store.save();
      emit('chat:message', { panelId, message: assistant });
      liveClear(panelId); // 容器收工：图已经在消息上了，转的那个圈该停了
      refresh();
      turnEnd(panelId, 'failed');
      return outcome({ ok: false, content: assistant.content, error: assistant.content });
    }

    // ── 上下文管理：**只压不裁** ──
    // 到上下文窗口的 80% 就把最旧的一段交给模型摘要，逐字保留最近的 16%。
    // 原文一条都不删 —— 它还躺在 panel.chat 里，界面上照样能翻，
    // 只是被摘要覆盖到的那一段不再原样送出去。
    const upTo = panel.compact?.upTo ?? 0;
    const restAll = panel.chat.slice(upTo, -1);
    // 距上一条消息多久。缓存前缀存在服务商那边、TTL 也在那边，客户端只能这样侧面估冷热。
    const lastAt = panel.chat.slice(0, -1).reduce((n, m) => Math.max(n, m.createdAt || 0), 0);
    const idleMs = Date.now() - (lastAt || Date.now());
    // 缓存还热时**不动**门槛：这时候压缩会把一个本该命中的请求打成全价重算，
    // 省下的那点比代价还少。空闲到缓存大概已经没了，才放宽 —— 反正都要全价，压短的更便宜。
    const compactAt = idleMs > CACHE_IDLE_MS ? COLD_COMPACT_AT : COMPACT_AT;
    if (estimateTokens(restAll.filter((m) => m.role !== 'tool')) > compactAt) {
      let keepFrom = restAll.length;
      let kept = 0;
      while (keepFrom > 0 && kept < RETAIN_TOKENS) {
        keepFrom -= 1;
        if (restAll[keepFrom].role !== 'tool') kept += estimateTokens([restAll[keepFrom]]);
      }
      const older = restAll.slice(0, keepFrom).filter((m) => m.role !== 'tool');
      if (older.length) {
        // 压缩时问一遍插件：有没有哪句话是"进了摘要才不丢"的（便签要点走这个进来）。
        // 只在真压缩这一刻调，所以它现算不花钱，也动不了缓存前缀。
        const summaryNotes = extensions.summaryNotes
          .map((fn) => {
            try {
              return String(fn(ctx) ?? '').trim();
            } catch (e: any) {
              // 一个插件出错只丢它自己那一句，压缩照常
              console.error('[插件] addSummaryNote 出错：', e?.message ?? e);
              return '';
            }
          })
          .filter(Boolean)
          .join('\n\n');
        // 同理问一遍插件：这次用哪个模型写纪要（没人答就用面板自己那个）
        const compactCfg = compactModelOf(extensions.compactPicks, ctx, cfg);
        try {
          const summary = await summarizeSession(
            older.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n\n'),
            panel.compact?.summary ?? '',
            compactCfg,
            ctrl.signal,
            summaryNotes,
          );

          // 便签不在这里锚了 —— 它已经搬去 plugins/notes，核心读不到插件状态（见文件头那段）。
          commitPromptBaseline(panel);
          panel.compact = {
            summary,
            upTo: upTo + keepFrom,
            at: Date.now(),
            // 手动压缩留下的隐性存档不许被自动压缩顺手抹掉 —— 那个字段不参与这里的计算，
            // 但它属于"面板的历史"，重建这个对象时得原样带上。
            archive: panel.compact?.archive,
          };
          store.save();
        } catch (e: any) {
          // 压缩失败不许挡住对话：原文都还在，这一轮就多带一点，下次再说
          console.error('[压缩] 摘要失败：', e?.message ?? e);
        }
      }
    }

    // 送给模型的这一份。**顺序是按缓存排的，不是按好看排的**：
    // 缓存按前缀命中，所以越容易变的东西越要往后放 —— 它一变，
    // 从它开始的整段都作废，放在前面等于每轮都在烧全价。
    // 动作骨架由消息自己存着的 actions 现拼 —— 谁的就是谁的，拼出来一辈子不变。
    // 以前是挑"最后一条带动作的 assistant"来贴：下一轮 lastActMsg 换了人，
    // 上一条上的标注就没了，等于每开一轮都改写一条历史消息，前缀从那句起全废。
    // 确定是否启用 PTC 模式 (可通过 panel.spec.ptcMode 或全局开关控制，默认为 true)
    const isPtc = panel.spec?.ptcMode !== false;
    const baseTools = toolsFor(panel.kind === 'chat' ? 'full' : 'write', panel.kind, panel.tools);
    const ptcSdkDoc = isPtc ? renderToolsSdk(baseTools) : undefined;

    const apiMessages: any[] = [
      {
        role: 'system',
        content: buildSystemPrompt(
          panel,
          disabledSkills,
          // 插件自带的面板类型清单现取。停用的不算 —— 它的面板这会儿也真的不在。
          extensions.info
            .filter((p) => p.enabled && p.panel)
            .map((p) => p.panel as { kind: string; label?: string; hint?: string }),
          ptcSdkDoc,
        ),
      },
      // 摘要：每涨满一个窗口才会变一次，放在前面当稳定前缀的一部分
      ...(panel.compact?.summary ? [{ role: 'system', content: `【前情摘要】\n${panel.compact.summary}` }] : []),
      // 历史：只往后追加，前缀一动不动 —— 缓存命中的主力就是这一段。
      // 有结构化存档（toolCalls）的走**真格式**回放：assistant 带 tool_calls → 每条调用后
      // 跟一条真的 tool 结果 → 最后才是给人看的那句正文，顺序和当时真实发生的一致。
      // 历史里摆真结构，模型才会接着走工具通道；摆文字骨架它分不出真假，看着看着就学会
      // 用文字画一个"调用记录"交差 —— 生图轮报了动作却没提交任务，就是这么学来的。
      // 结构化之前的旧消息保留 actions 骨架兜底（每条只留 6 条、每条 60 字），别让它对干过的活全盲。
      ...panel.chat
        .slice(panel.compact?.upTo ?? 0, -1)
        .filter((m) => m.role !== 'tool')
        .flatMap((m): any[] => {
          // 正文里若混着手写的 [那一轮的动作]（早先模型用文字画的假记录），先刮掉 ——
          // 留着就是给它继续模仿的样板。逐条消息确定性地刮，同一条每轮刮出一样的字，
          // 前缀照旧只追加，缓存不受影响。
          const text = (m.content ?? '')
            .replace(/\n*\[那一轮的动作\][^\n]*(?:\n[-•][^\n]*)*/g, '')
            .replace(/\n+$/, '');
          if (m.role === 'assistant' && m.toolCalls?.length) {
            return [
              {
                role: 'assistant',
                content: null,
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: c.args },
                })),
              },
              // 存的时候已截到前 1200 字，这里原样回灌（工具输出的完整正文不进历史）
              ...m.toolCalls.map((c) => ({ role: 'tool', tool_call_id: c.id, content: c.result })),
              ...(text ? [{ role: 'assistant', content: text }] : []),
            ];
          }
          return [
            asApiMessage(
              m.role,
              m.role === 'assistant' && m.actions?.length
                ? `${text}\n\n[那一轮的动作] ${m.actions
                    .slice(-6)
                    .map((a) => (a.trim().length > 60 ? `- ${a.trim().slice(0, 60)}` : `- ${a}`))
                    .join('\n')}`
                : text,
              // **只把用户发的图回灌给模型**。助手那条消息上的图是给它自己生的、或者
              // send_image 往外发的 —— 那是"给用户看的"，不是给模型看的输入：
              // 一张 1MB 的 PNG 转成 base64 就是几十万字符，每轮重发一遍能把上下文顶爆，
              // 而它对模型这一轮要干的事毫无用处（要看它再 read_file 就够了）。
              m.role === 'user' ? m.images : undefined,
            ),
          ];
        }),
      asApiMessage('user', userTurn, userMsg.images),
    ];

    /**
     * 这一轮的动作记录，一行一条：做了什么事（出错的再带上结果的第一句）。
     *
     * 去处只有一个：下一轮重新发给模型（免得它失忆）。给人看的是另一条路 ——
     * 每次工具调用另存一条 role:'tool' 的消息，那才是对话里看得见的动作行。
     */
    const actions: string[] = [];

    /**
     * 平行的另一本账：同一批工具调用的**结构化**存档，回合末挂在 assistant 上（见下）。
     * actions 是给人看的文字行、也给结构化之前的旧消息兜底；这本账走真 tool_calls 格式
     * 回放 —— 摆真结构模型才会接着走工具通道，摆文字骨架它会照着画一个假的。
     */
    const toolCalls: { id: string; name: string; args: string; result: string }[] = [];

    /**
     * 存档里 args / result 的封顶 —— 这一对**每一轮都会随历史重发**，所以要一起管住。
     *
     * 从前只截了 result，args 是全量存的，而 args 里最大的是 write_file 的 content：
     * 模型写一个两万字的文件，那一轮的 tool_calls.arguments 就是两万字，此后**每一轮**
     * 都跟着重发一遍；一轮里写五个文件就是十万字/轮的固定开销，而且界面看不出来 ——
     * 动作记录显示的是"写入了哪个文件"，不显示参数。
     *
     * 截断只影响回放给模型的这一份：文件早写进工作区了，要原文用 read_file。
     * 截法必须**确定性**（同一份 args 每轮截出一模一样的字），前缀照旧只追加，缓存不受伤。
     */
    const ARGS_MAX = 1_200;
    const clipArgs = (a: unknown) => {
      const s = typeof a === 'string' ? a : JSON.stringify(a ?? {});
      if (s.length <= ARGS_MAX) return s;
      return `${s.slice(0, ARGS_MAX)}…（这个参数共 ${s.length} 字，太长没全存 —— 别照着这里往下猜，要原文自己 read_file）`;
    };

    /**
     * result 同理，但留**头 + 尾**：报错、结论、最终输出几乎都在尾部，
     * 只留前 1200 字常把 `build_project` 的报错整段切掉 —— 下一轮模型就"忘了"错在哪，
     * 于是重跑一遍。头留 800 认住命令本身，尾留 400 接住结局。
     */
    const RESULT_HEAD = 800;
    const RESULT_TAIL = 400;
    const clipResult = (raw: string) => {
      if (raw.length <= RESULT_HEAD + RESULT_TAIL) return raw;
      const mid = raw.length - RESULT_HEAD - RESULT_TAIL;
      return `${raw.slice(0, RESULT_HEAD)}\n\n…（中间 ${mid} 字没存，别猜。原文在工作区里有，要看就 read_file —— 这里已经留住了尾巴，报错和结论一般在尾部）\n\n${raw.slice(-RESULT_TAIL)}`;
    };

    /** agent 干活时，每调一次工具就在对话里留一条记录 */
    const noteTool = (name: string, args: any, result: string) => {
      const head = describeTool(name, args);
      // 崩了之后接手的人要知道「上一步在干什么」
      lastStep = head;
      turnStep(panelId, head, String(result).slice(0, 120));
      const first = String(result).split('\n').find((l) => l.trim()) ?? '';
      // 成功的步骤只留"做了什么"，出错的才带上结果的第一句 —— 这份记录每轮都要重发一遍
      actions.push(BAD_STEP.test(first.trim()) ? `${head} ⚠ ${first.trim().slice(0, 100)}` : head);
      // 结构化存档（下一轮按真 tool_calls 回放）：args / result 都经 clipArgs / clipResult 封顶 ——
      // 结果只留前 1200 字 —— 记住"干成了什么、seed/路径在哪"就够，别每轮回灌一整份工具输出。
      toolCalls.push({
        id: W.newId('c'),
        name,
        args: clipArgs(args),
        result: clipResult(String(result)),
      });
      const note: ChatMessage = {
        id: W.newId('m'),
        role: 'tool',
        content: `**${head}**\n\n\`\`\`\n${String(result).slice(0, 3000)}\n\`\`\``,
        createdAt: Date.now(),
      };
      store.panel(panelId)?.chat.push(note);
      store.save();
      emit('chat:message', { panelId, message: note });
    };

    let full = '';
    /**
     * 这一轮到目前的累计用量。**每完成一次模型调用就会被 onUsage 刷新**，
     * 不是等整轮结束才算 —— 中断（用户按停 / 接口断流 / 超时）不该把前面
     * 已经花掉的 token 一起抹成 0。
     */
    let usage = { prompt: 0, completion: 0, total: 0, cacheHit: 0 };
    let files: string[] = [];
    const started = Date.now();

    /**
     * 把"到目前为止的累计用量"翻成界面上的账。两处共用：
     *   · 跑动中的实时账（onUsage 里推给状态条）
     *   · 结束时写进这条消息的正式账
     * 钱按三档分开记：命中输入、未命中输入、输出各算各的，加起来才是实价。
     */
    const accountOf = (ms: number, changed: string[], at: number): ChatStats => {
      const hit = Math.max(0, Math.min(usage.cacheHit, usage.prompt));
      return {
        tokensIn: usage.prompt,
        tokensOut: usage.completion,
        total: usage.total,
        cacheHit: hit,
        cacheMiss: Math.max(0, usage.prompt - hit),
        pick,
        price: price ?? null,
        cost: price ? costOf(price, usage.prompt, hit, usage.completion) : undefined,
        ms,
        at,
        files: changed,
        rating: null,
      };
    };

    /**
     * 把实时账推给界面，最快 1.5 秒一次。
     *
     * 为什么要节流：每推一次就要广播整个工作区快照（含这局对话的全部历史），
     * 而一轮里可能来回调十几次模型 —— 每来一次都广播，长对话下就是纯浪费。
     * 数值落后一两秒没人看得出来，账也不会因此少记（正式那条用的是同一个累计量）。
     */
    let liveAt = 0;
    const pushLive = () => {
      const now = Date.now();
      if (now - liveAt < 1500) return;
      liveAt = now;
      store.setLiveStats(panelId, accountOf(now - started, [], 0));
      refresh();
    };
    /** 这一轮出事了没有（含用户按停止）—— 决定点点标红还是标绿 */
    let failed = false;
    /** 这一轮到底是怎么收场的 —— 插件靠它区分「事故」和「人按的」 */
    let endReason: 'done' | 'stopped' | 'failed' = 'done';
    /** 上游断掉时是哪一类（FailCode），认不出来就是空串 */
    let failCode = '';
    /** 最近一步走到哪儿了 —— 崩了之后接手的人要知道「上一步在干什么」 */
    let lastStep = '';

    // 流式输出按 50ms 合并一次再推给界面。
    // 以前每来一个 token 就发一条 IPC、界面就整段重渲染一次，长回答能把主线程压死。
    let pending = '';
    let flushTimer: NodeJS.Timeout | null = null;
    const flushDelta = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!pending) return;
      const d = pending;
      pending = '';
      emit('chat:delta', { panelId, id: assistantId, delta: d });
    };
    try {
      ctrl.signal.throwIfAborted();
      const effectiveTools = isPtc ? [getRunCodeToolSpec()] : baseTools;
      const allowedTools = new Set(baseTools.map((tool) => tool.function.name));
      const effectiveRunner = async (name: string, args: any) => {
        if (name === 'run_code' && isPtc) {
          const runRes = await executeRunCode(
            args?.code || '',
            (subName, subArgs, signal) => runTool(subName, subArgs, { ...ctx, signal }),
            (subName, subArgs, subOut) => noteTool(subName, subArgs, subOut),
            50,
            allowedTools,
            ctrl.signal,
          );
          for (const f of runRes.filesWritten) files.push(f);
          return runRes.output;
        }
        if (!allowedTools.has(name)) return `工具 ${name} 不在当前面板/员工授权的工具套件中`;
        return runTool(name, args, ctx);
      };

      const res = await runAgent(
        apiMessages,
        cfg,
        effectiveTools,
        effectiveRunner,
        {
          onText: (d) => {
            // 字又来了 = 重连接上了，那条「重连 3/5」立刻撤掉 ——
            // 留着它就成了"明明在正常输出，下面还挂着正在重连"，自相矛盾。
            if (liveRetry.delete(panelId)) livePush(panelId);
            assistant.content += d;
            pending += d;
            if (!flushTimer) flushTimer = setTimeout(flushDelta, 50);
          },
          // 思维链单独走一条通道：它不进正文，也不进历史 —— 它只是"过程"，
          // 让用户看得见它正在想什么。合并的活交给渲染层按帧做。
          onReasoning: (d) => {
            // 同上：思维链一到就说明重连已经接上了
            if (liveRetry.delete(panelId)) livePush(panelId);
            // 界面拿它显示（合并的活交给渲染层按帧做）；插件拿它做别的 ——
            // 核心自己不留思考，想留住它的是插件的事（如 thinking-log 原样落盘）。
            emit('chat:reasoning', { panelId, id: assistantId, delta: d });
            emitReasoning(panelId, d);
          },
          /**
           * 断了、正在自己接回来。
           *
           * 两件事一起做，缺一样都还是坏的：
           *   · **把上一次的草稿撤掉**。那次尝试吐了一半就断了，重连拿到的是一份全新的
           *     回答，接着写就成了半句话 + 半句话。这里按**字数**撤：连界面上的那份
           *     一起撤（失败分片绝不进入派生消息）。
           *   · **摆出「重连 3/5」**。退避那几秒里接口一个字都不会来，不摆的话用户
           *     只看见它卡住了，会去按停止 —— 那反而把事情弄坏了。
           */
          onRetry: (info) => {
            if (info.discardText || info.discardThink) {
              // 先把攒着还没推的那点推出去。撤回是**按字数**撤的，少推一段就会撤多。
              if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = null;
              }
              if (pending) {
                emit('chat:delta', { panelId, id: assistantId, delta: pending });
                pending = '';
              }
              assistant.content = assistant.content.slice(0, Math.max(0, assistant.content.length - info.discardText));
              emit('chat:retract', { panelId, id: assistantId, text: info.discardText, think: info.discardThink });
            }
            liveRetry.set(panelId, {
              attempt: info.attempt,
              max: info.max,
              label: failLabel(info.code),
              delayMs: info.delayMs,
            });
            livePush(panelId);
          },
          onTool: noteTool,
          /**
           * 步骤边界到了就问一句：用户插话了吗。
           *
           * 插话**不当作新的一轮**：它就落进这一轮的回复里，模型下一步就读到。
           * 而那一步做完（模型不再要工具）时它还会被再问一次（chat-core 里的边界二号）——
           * 那就是"结束单次任务、还没结束会话"那个缝。
           */
          takeSteering: () => takeSteering(panelId),
          /**
           * 一条插话真被领走了：落进对话，让用户看见它被接住了。
           *
           * 为什么非得落一条：不落的话，用户插的那句话在界面上就消失了 ——
           * 他只会看到模型回了一句莫名其妙调整过的答复，不知道自己的话生效了没有。
           */
          onSteering: (it) => {
            const note: ChatMessage = {
              id: W.newId('m'),
              role: 'user',
              content: it.text,
              createdAt: Date.now(),
              images: it.images,
              steer: true,
            };
            store.panel(panelId)?.chat.push(note);
            store.save();
            emit('chat:message', { panelId, message: note });
            // 插话进了这一轮的历史，回复骨架里也得记一笔 —— 下一轮模型才知道
            // 中间被插过一句（这句话本身在历史里，骨架只留一行摘要）
            actions.push(`用户在跑动中插话：「${it.text.slice(0, 60)}」`);
          },
          /**
           * 每完成一次模型调用就把这一轮到目前的账摆到界面上。
           *
           * 助手那条消息要到整轮结束才进 store（中途面板上一个字都不多），所以
           * 只看消息的话，用户按停之后拿到的那条消息就是 0 用量 —— 这一局明明
           * 已经花了几十万 token，界面上却显示成没花过钱。
           */
          onUsage: (u) => {
            usage = u;
            pushLive();
          },
        },
        ctrl.signal,
      );
      full = res.text;
      usage = res.usage;
      files = [...new Set([...files, ...res.files])];
    } catch (err: any) {
      failed = true;
      /**
       * 失败和「用户按了停止」在这儿分手 —— 两边都标红，但**事后必须分得开**：
       *   · 用户按停 = 意图。插件、自动恢复、任何东西都不许把它重新叫起来。
       *   · 上游断掉 = 事故。这才是「该有人管」的那一类。
       *
       * 判据是现成的：用户那条路一定先 abort 了 ctrl，上游断掉时 signal 干净。
       */
      endReason = ctrl.signal.aborted ? 'stopped' : 'failed';
      failCode = String(err?.code || '').trim();
      flushDelta();
      const note = `\n\n⚠ ${err?.message ?? err}`;
      assistant.content += note;
      emit('chat:delta', { panelId, id: assistantId, delta: note });
    }
    flushDelta();
    const endedAt = Date.now();

    // 收尾：这一轮怎么落的，记清楚再散场（crashed 那条走不到这儿，留给开机扫）
    turnEnd(panelId, endReason);
    // 这一轮结束了（跑完，或者被中断）：实时账让位给正式那条 stats，
    // 两个都留着会把同一笔账算两遍。
    store.setLiveStats(panelId, null);
    // 正文马上要进 chat 了，实时那一份让位 —— 两边都留着会让插件把同一句话说两遍
    store.setLiveTurn(panelId, null);
    assistant.streaming = false;
    assistant.content = full || assistant.content;
    // 这条回复的账：用量、用时、动了哪些文件。
    // 用量是 runAgent 一路累计下来的，**中断时也带着已经花掉的那部分** ——
    // 以前这里拿的是 runAgent 的返回值，而中断是从里面抛异常出来的，
    // 于是整条消息的账全成 0：前面十几轮真金白银花掉的 token 一条都不剩。
    assistant.stats = accountOf(endedAt - started, files, endedAt);
    // 这一轮怎么收场的：插件按它决定要不要出手（stopped 一律不许自动恢复）
    assistant.endReason = endReason;
    if (failCode) assistant.failCode = failCode;

    const { clean, proposal } = extractEditProposal(assistant.content);
    assistant.content = clean || assistant.content;
    assistant.edited = Boolean(proposal) && !failed;
    assistant.actions = actions.length ? actions : undefined;
    assistant.toolCalls = toolCalls.length ? toolCalls : undefined;

    const live = store.panel(panelId);
    if (!live) return outcome({ ok: false, content: assistant.content, edited: false, error: t('面板已关闭') });

    live.chat.push(assistant);

    /**
     * 点点落地：失败/中断 → 红；跑完了但回复最后是个问句 → 黄（它在等你回话）；
     * 其余 → 绿。问句这个判据是刻意挑的最便宜的一种：不值当为它再问一遍模型。
     */
    live.status = failed ? 'error' : /\s*[？?]["'）)】\]]?\s*$/.test(assistant.content.trim()) ? 'confirm' : 'done';

    if (proposal && !failed) {
      live.revisions.push({
        at: turnSnapshot.at,
        kind: turnSnapshot.kind,
        title: turnSnapshot.title,
        look: turnSnapshot.look,
        spec: turnSnapshot.spec,
        note: proposal.rationale ? `${turnSnapshot.note} · ${proposal.rationale}` : turnSnapshot.note,
      });
      // 开启新的调整分支，清空重做栈
      live.redoRevisions = [];
      // 换类型。这一条以前缺席 —— 提案里没有 kind、应用时也不认 kind，
      // 于是"把这个面板改写成番茄钟"这类要求永远落不了地：类型原地不动，
      // 界面上什么都不会变，而模型会以为自己改好了。
      if (typeof proposal.kind === 'string' && proposal.kind) live.kind = proposal.kind;
      if (typeof proposal.title === 'string' && proposal.title) live.title = proposal.title;
      if (proposal.look) live.look = { ...live.look, ...proposal.look };
      if (proposal.spec) live.spec = { ...live.spec, ...proposal.spec };
      /**
       * 面板定型这一瞬，顺手把**头像家族**定下来，冻进 look.avatarKey。
       *
       * 时机只有一次：标题刚落地（新面板 → 有了名字）。此后无论改标题还是
       * 再给关键词都不重算 —— 列表里的脸跳一下，用户会以为认错了面板。
       *
       * 模型只给 2~3 个中文短词（keywords），**永远看不见那 84 个文件名**：
       * 词认不出来就当没给，退回 kind / 标题，再不济 misc。任何一步都不阻塞。
       */
      if (live.title !== t('新面板') && !live.look?.avatarKey) {
        const fam = matchPanelAvatarFamily({
          keywords: proposal.keywords,
          kind: live.kind,
          title: live.title,
        });
        live.look = { ...live.look, avatarKey: fam };
      }
    }
    store.save();
    refresh();
    emit('chat:message', { panelId, message: assistant });
    // 容器收工 —— 顺序是刻意的：等这条带图的回复先落进对话，再撤掉临时那个圈。
    // 反过来的话，图会在界面上闪一下不见、又随消息冒出来。
    liveClear(panelId);

    // 面板命名兜底：若标题仍为默认的「新面板」且未在提案中改名，后台静默自动总结标题
    if (!failed && live.title === t('新面板') && !proposal?.title) {
      const firstUserMsg = live.chat.find((m) => m.role === 'user')?.content?.slice(0, 300) || '';
      const assistantSnippet = assistant.content.slice(0, 300);
      if (firstUserMsg) {
        (async () => {
          try {
            const modelCfg = store.modelForPanel(panelId);
            if (!modelCfg.apiKey || !modelCfg.baseUrl) return;
            const titleSys = '你是一个极简总结助手。请根据对话的第一轮内容，生成一个4到10个字的简短面板标题。直接输出标题文字，禁止带引号、书名号、标点符号或任何解释。\n'
              + '只输出一行，格式：标题｜关键词1,关键词2\n'
              + t('关键词是 2~3 个中文主题词（每个 2~4 字，说清这块面板在干什么），用于挑选面板图标；想不到就只输出标题、不写竖线。');
            const userPrompt = `用户：${firstUserMsg}\n助手：${assistantSnippet}`;
            const generated = await askOnce(modelCfg, titleSys, userPrompt, { maxTokens: 32 });
            // 一行两段：`标题｜关键词1,关键词2`。关键词是**可选**的 —— 它没给就整块退到 kind/标题，
            // 所以绝不能因为解析不出来就丢掉标题（标题才是这一段真正要办的事）。
            const [rawTitle, rawKw] = String(generated || '').split(/[｜|]/);
            const cleanTitle = String(rawTitle || '').replace(/["'《》【】\n\r]/g, '').trim().slice(0, 20);
            const keywords = String(rawKw || '')
              .split(/[,，、\s]+/)
              .map((s) => s.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').trim())
              .filter((s) => s.length >= 2)
              .slice(0, 3);
            if (cleanTitle) {
              const current = store.panel(panelId);
              if (current && current.title === t('新面板')) {
                current.title = cleanTitle;
                // 兜底起标题这条路上顺手把头像也定了 —— 白捡一次判断，不多花一次调用
                if (!current.look?.avatarKey) {
                  current.look = {
                    ...current.look,
                    avatarKey: matchPanelAvatarFamily({
                      keywords,
                      kind: current.kind,
                      title: cleanTitle,
                    }),
                  };
                }
                current.updatedAt = Date.now();
                store.save();
                refresh();
              }
            }
          } catch {
            // 静默容错，不干扰正常交互
          }
        })();
      }
    }

    /**
     * 这一轮还有没领走的插话吗 —— 有就说明它是**被中断**收场的（正常路径上
     * 边界二号已经把插话都领走了）。它针对的是刚结束的这一轮，留着只会
     * 糊到下一轮脸上，所以到这儿就作废，并且说一声，别让它无声消失。
     */
    const leftover = takeSteering(panelId);
    /**
     * 没领走的分两种，处理方式正好相反：
     *   · 系统报的状态变更（system）—— 重投。它不是「说过就算了」的话，是事实，
     *     而且正好落在「最后一次工具调用之后」这个常见位置，丢了就真丢了。
     *   · 用户插的话 —— 保持原样作废并说一声（他明明说了，不能假装没看见）。
     */
    const sysDropped = leftover.filter((i) => i.system);
    for (const it of sysDropped) {
      // 重投走队列：这一轮已经关账了，等它当新的一轮发出去
      enqueue(panelId, it.text);
    }
    const userLeft = leftover.filter((i) => !i.system);
    if (userLeft.length) {
      const note: ChatMessage = {
        id: W.newId('m'),
        role: 'tool',
        content: `**插话没能送进去**（这一轮已经结束了）：${userLeft.map((i) => `「${i.text.slice(0, 80)}」`).join('、')}`
          + '\n\n想让它接着做，直接把这句话发出去就行。',
        createdAt: Date.now(),
      };
      store.panel(panelId)?.chat.push(note);
      store.save();
      refresh();
      emit('chat:message', { panelId, message: note });
    }

    /**
     * **接力**：这一轮走完了，队列里还排着话 —— 把队首那条发出去。
     *
     * 这是"提前发送、排队等它跑完"的落点：用户一次把接下来几件事都摆上，
     * 每跑完一轮自动接上一条，不用盯着它什么时候停。
     *
     * 三条约束，每条都有理由：
     *   · **只在正常跑完时接力**（按停/出错不接）—— 出了状况还自动往下灌，
     *     用户按的那个"停止"就等于没按。
     *   · **先出队再发**：发送是异步的，留在队里会被下一轮收尾时又发一遍。
     *   · **不 await**：这一轮的结果早就该交给界面了，让界面等下一轮跑完是错的。
     */
    // 挂着重启时不接力：队列整个停住等重启之后由新进程发（见 bootResumeOutbox）。
    // 不拦这一下的话，"插队"发出去的那一条跑完，会顺手把其余几句也一起发出去 ——
    // 而用户排队时的意思明明是"这些等重启之后再说"。
    if (!failed && !isRestartArmed()) {
      const rested = outboxOf(panelId);
      const next = rested?.find((item) => !item.taskId || item.taskWorkspace === path.resolve(workspaceRoot()));
      if (next) {
        if (!next.taskId) rested!.splice(rested!.indexOf(next), 1);
        store.save();
        refresh();
        queueMicrotask(() => void sendQueueItem(panelId, next).catch((e: any) => {
          console.error('[排队] 接力发送失败：', e?.message ?? e);
        }));
      }
    }

    return outcome({ ok: !failed, content: assistant.content, edited: Boolean(proposal) && !failed,
      ...(failed ? { error: assistant.content, endReason } : {}) });
    } catch (error: any) {
      turnEnd(panelId, ctrl.signal.aborted ? 'stopped' : 'failed');
      store.setLiveStats(panelId, null);
      store.setLiveTurn(panelId, null);
      liveClear(panelId);
      const current = store.panel(panelId);
      if (current) current.status = 'error';
      store.save();
      refresh();
      return outcome({ ok: false, error: String(error?.message || error), endReason: ctrl.signal.aborted ? 'stopped' : 'failed' });
    } finally {
      opts?.signal?.removeEventListener('abort', abortFromParent);
      try {
        try { if (ctrl.signal.aborted) tasks.cancelRun(assistantId); }
        finally { if (opts?.taskId) tasks.finish(opts.taskId, assistantId, { ...(taskOutcome || { ok: false, error: '执行未正常结算' }), tokens: assistant.stats?.total }); }
      } finally { setRunning(panelId, null, undefined, assistantId); }
    }
  };

  ipcMain.handle('chat:send', (_e, panelId: string, text: string, images?: string[]) => doSend(panelId, text, images));
  // 远程那头（plugins/remote 的 HTTP 服务）发来的话也进这条 doSend —— 同一条路
  setChatSender(doSend);
  // 插件要"排一句队"走这条（跟聊天区那个待发队列同一份账、同一处接力）
  setChatEnqueuer(enqueue);
  setTaskApi(tasks);
  ipcMain.handle('tasks:list', (_e, panelId: string) => tasks.list(panelId));
  ipcMain.handle('tasks:get', (_e, id: string, panelId: string) => tasks.get(id, panelId));
  ipcMain.handle('tasks:cancel', (_e, id: string, panelId: string) => tasks.cancel(id, panelId));
  ipcMain.handle('tasks:accept', (_e, id: string, panelId: string, note?: string) => tasks.accept(id, panelId, note));
  /**
   * 插件往面板里送**状态变更**的那条路（api.send 带 steer）。
   *
   * 分流只有两句，但这两句以前散在每个插件作者手里：
   *   · 面板正跑着 → 进插话盒子，模型走到下一个边界就读到。
   *     **不能再起一轮** —— 两轮同时写一块面板，谁的结果都不可信（delivery-alert
   *     原来就是靠手写一句 status 判断绕开的，绕不好就撞上这事）。
   *   · 面板闲着 → 起一轮，就是普通 send。
   *
   * steer 那条一律 silent：状态变更是**系统报的**，不是用户说的话。
   */
  setChatSteerer((panelId, text) => {
    if (running.has(panelId)) {
      const r = pushSteer(panelId, text, undefined, true);
      return Promise.resolve(r.ok ? { ok: true } : { ok: false, error: r.error });
    }
    return doSend(panelId, text, undefined, { silent: true });
  });
  /**
   * 插件问"这一块真在跑吗" —— 答案就是这张内存表（见 store 里那段：落盘的
   * status 会在进程被杀时永久停在 working，拿它当守卫会把用户的话静默吞掉）。
   */
  setRunningProbe((panelId) => running.has(panelId));
  /**
   * 插件问模型一句话：**用这个面板自己选中的模型**（跟会话区同一个 pick、同一份密钥）。
   * 走的是核心那条现成的模型通道，不是插件自己连接口 —— 密钥不出主进程。
   */
  setModelAsker(async (panelId, spec) => {
    /**
     * 用哪个模型：**调用方指定了 pick 就用它**（软件里已配的任意一个），没指定就跟着
     * 这块面板选的走。指定那个认不出来（提供方被删、模型被去掉）时退回面板自己那个 ——
     * 别让"挑了个已经没了的模型"变成出图失败。
     * 密钥在这一层解出来，插件那侧永远只有 pick 这个字符串。
     */
    const mine = store.modelForPanel(panelId);
    const want = spec.pick ? resolvePick(spec.pick) : null;
    const cfg = want ? { ...want, think: store.thinkFor(panelId) } : mine;
    return askOnce(cfg, spec.system || '', spec.user, { maxTokens: spec.maxTokens, signal: spec.signal });
  });
  // 给插件看的模型清单（脱敏）—— 画布那些"过 LLM 用哪个模型"的选择器照它画
  setModelCatalog(() => {
    /**
     * 发出去之前再挡一道：`p.models` 不是数组就当作空目录，**绝不让一个坏条目
     * 把整份清单连根带走**。以前这里是 `p.models.map(...)` —— 只要有一个提供方的
     * models 不是数组（旧配置、手改文件、插件直写），这里当场抛，插件那侧只看得见
     * "模型清单是空的"（调度中心的模型下拉只剩一个占位符就是这么来的）。
     */
    try {
      return catalog().map((p) => ({
        key: p.key,
        label: p.label,
        hasKey: p.hasKey,
        models: (Array.isArray(p.models) ? p.models : []).map((m) => ({ id: m.id, name: m.name })),
      }));
    } catch (e) {
      console.error('[提供方] 清单发不出去：', e);
      return [];
    }
  });
  // 插件替远程新建/打开面板之后也得让界面跟上 —— 和上面同一批"塞进来"的做法
  /**
   * 插件登记提供方走这里 —— 核心分流：配置进 providers.json，密钥进 credentials.json。
   * 插件不再自己写配置文件，于是"密钥明文躺在 providers.json 里"这条旁路就没有了。
   */
  setProviderUpserter((p) => {
    if (!p?.key || !p.baseUrl) return false;
    try {
      upsert({
        key: String(p.key),
        label: String(p.label || p.key),
        api: String(p.api || 'openai-completions'),
        baseUrl: String(p.baseUrl),
        apiKey: String(p.apiKey || ''),
        models: Array.isArray(p.models) ? p.models : [],
      });
      refresh();
      return true;
    } catch (e) {
      console.error('[提供方] 插件登记失败：', e);
      return false;
    }
  });
  /** 插件取一个已配提供方的密钥（只在主进程用） */
  setCredentialReader((k) => credentialOf(k));
  /** 插件把自己那把钥匙存进凭据库 —— 别落在明文的插件参数里 */
  setCredentialWriter((slot, value) => setCredential(slot, value));
  setRefresher(refresh);

  // ———————————————————— 排队与插话（两条语义不同的边界）
  /** 排队：先摆着，这一整轮跑完自动接着发 */
  ipcMain.handle('chat:enqueue', (_e, panelId: string, text: string, images?: string[]) =>
    enqueue(panelId, text, images),
  );
  /** 插话：直接送进**此刻正在跑**的那一轮，等它手头这一步做完就读到 */
  ipcMain.handle('chat:steer', (_e, panelId: string, text: string, images?: string[]) =>
    steerIn(panelId, text, images),
  );
  /** 插队：把排队里某一条提到插话盒子里 —— 队还是要排，但这条先插进去 */
  ipcMain.handle('chat:queueSteer', (_e, panelId: string, id: string) => promoteQueue(panelId, id));
  /** 从队列里删掉一条（还没发出去的才删得掉） */
  ipcMain.handle('chat:queueRemove', (_e, panelId: string, id: string) => {
    const box = outboxOf(panelId);
    if (!box) return { ok: false, error: t('面板不存在') };
    const i = box.findIndex((x) => x.id === id);
    if (i < 0) return { ok: false, error: t('这条已经开始发送了') };
    if (box[i].taskId) return tasks.cancel(box[i].taskId!, panelId);
    box.splice(i, 1);
    store.save();
    refresh();
    return { ok: true };
  });
  /** 改一条排队的话（发出去之前都能改） */
  ipcMain.handle('chat:queueEdit', (_e, panelId: string, id: string, text: string) => {
    const box = outboxOf(panelId);
    const item = box?.find((x) => x.id === id);
    if (!item) return { ok: false, error: t('这条已经开始发送了') };
    if (item.taskId) return { ok: false, error: '任务正文不能改写；请取消后提交新请求' };
    item.text = String(text ?? '');
    store.save();
    refresh();
    return { ok: true };
  });
  /** 界面挂载时问一次：这个面板现在还排着什么、插着什么 */
  ipcMain.handle('chat:outbox', (_e, panelId: string) => ({
    queue: outboxView(panelId),
    steer: (steerBox.get(panelId) ?? []).map((i) => ({ id: i.id, text: i.text, images: i.images })),
  }));

  /**
   * 界面挂载时问一句：现在哪些面板还在跑、跑到哪儿了。
   * 切标签会把面板组件卸载重挂，光知道"在跑"不够 —— 已经吐出来的正文也要接上，
   * 不然它回来之后从半截开始往下写。
   */
  /**
   * 界面切标签回来（组件卸载重挂）时问一句：那些进行中的容器还在不在。
   * 光靠广播的话，切走再切回来这段进度就全丢了 —— 重挂之后什么都不显示。
   */
  ipcMain.handle('chat:liveState', (_e, panelId: string) => liveView(panelId));

  ipcMain.handle('chat:running', () =>
    [...running.entries()].map(([panelId, r]) => ({ panelId, text: r.msg.content })),
  );

  ipcMain.handle('chat:stop', (_e, panelId: string) => {
    const entry = running.get(panelId);
    try { if (entry) tasks.cancelRun(entry.runId); }
    finally { running.cancel(panelId); }
    // 中断也要立刻标红 —— abort 抛进 catch 还要等它把当前那口吐完
    const p = store.panel(panelId);
    if (p) {
      p.status = 'error';
      store.save();
      refresh();
    }
    return true;
  });

  /** 给回复点赞/点踩（同一个再点一次就取消） */
  ipcMain.handle('chat:rate', (_e, panelId: string, messageId: string, rating: 'up' | 'down') => {
    const panel = store.panel(panelId);
    const msg = panel?.chat.find((m) => m.id === messageId);
    if (!msg) return false;
    const cur = msg.stats?.rating ?? null;
    msg.stats = { ...(msg.stats ?? {}), rating: cur === rating ? null : rating };
    store.save();
    refresh();
    return true;
  });

  /** 界面挂载时问一句：这个面板有没有待用户点头的请求（换窗口、刷新之后也找得回来） */
  ipcMain.handle('chat:askState', (_e, panelId: string) => ({
    ask: askView(pendingAsk.get(panelId)),
    restartArmed: isRestartArmed(),
  }));

  /**
   * 用户按下「确认」—— 插件那个 `then` 只有这一条发起路径。
   *
   * 跑的是 runToolConfirmed（**不过插件钩子**）：请求本来就是钩子提的，
   * 回头再问一遍就是个死循环。
   */
  ipcMain.handle('chat:askConfirm', async (_e, panelId: string) => {
    const ask = pendingAsk.get(panelId);
    if (!ask) return { ok: false, error: t('没有待确认的请求。') };
    // 这一轮还在写就别动手：回复在内存里，收掉进程等于这一轮白跑
    if (running.has(panelId)) {
      return { ok: false, error: t('这一轮还没写完 —— 等它停下再点，否则这段回复会跟着进程一起没。') };
    }
    /*
     * 同一件事（重启）别处也躺着一条时：**把别处那几条清掉，这一条照常执行**。
     *
     * 从前这里是「删掉自己这条、return ok」—— 用户点了「确认重启」，界面上那条
     * 请求消失了、重启却没发生，看着就是「点了没用」。
     * 用户按下这个键的意思只有一个：现在重启。所以既清掉重复的，也必须真的重启一次。
     */
    const twin = [...pendingAsk.entries()].find(
      ([pid, a2]) => pid !== panelId && a2.then.tool === ask.then.tool,
    );
    if (twin) {
      for (const [pid, other] of [...pendingAsk.entries()]) {
        if (pid === panelId || other.then.tool !== ask.then.tool) continue;
        pendingAsk.delete(pid);
        toAllWindows('chat:ask', { panelId: pid, ask: null, restartArmed: isRestartArmed() });
      }
    }
    await runPending(panelId, ask);
    return { ok: true };
  });

  /**
   * 用户选了「等所有会话结束」：不立刻做，把它就地挂起来，核心替它盯着时机。
   *
   * 为什么这件事留在核心：判"整个软件还有没有会话在跑"要那份内存里的 running 表，
   * 插件没有钩子看得到（见 plugins.ts 的 AskSpec.defer）。插件只管说"多这个按钮、
   * 按钮上写什么"，什么时候动手是核心的事。
   */
  ipcMain.handle('chat:askDefer', (_e, panelId: string) => {
    const ask = pendingAsk.get(panelId);
    if (!ask) return { ok: false, error: t('没有待确认的请求。') };
    ask.armed = true;
    // 同一件事（重启）只该挂一次：别的面板上要是也躺着一条没点的重启请求，
    // 就跟着一起挂起来 —— 否则它们会一直摆在那儿等用户逐个点，越堆越多。
    const sameKind = ask.then.tool === 'restart_project';
    if (sameKind) {
      for (const [pid, other] of pendingAsk.entries()) {
        if (pid !== panelId && other.then.tool === 'restart_project') other.armed = true;
      }
    }
    for (const [pid, other] of pendingAsk.entries()) {
      if (sameKind && other.then.tool !== 'restart_project') continue;
      toAllWindows('chat:ask', { panelId: pid, ask: askView(other), restartArmed: isRestartArmed() });
    }
    watchDefer();
    return { ok: true };
  });

  /** 用户按下「先不」—— 请求作废，并且留下一条记录 */
  ipcMain.handle('chat:askCancel', (_e, panelId: string) => {
    const ask = pendingAsk.get(panelId);
    if (!ask) return false;
    pendingAsk.delete(panelId);
    toAllWindows('chat:ask', { panelId, ask: null, restartArmed: isRestartArmed() });
    const note: ChatMessage = {
      id: W.newId('m'),
      role: 'tool',
      content: `**${ask.cancel}**：${ask.then.tool} 没有执行。`,
      createdAt: Date.now(),
    };
    store.panel(panelId)?.chat.push(note);
    store.save();
    refresh();
    toAllWindows('chat:message', { panelId, message: note });
    return true;
  });
}

/**
 * **这份软件自己所在的目录** —— 当前跑的这份代码的仓库根（`app.getAppPath()`）。
 *
 * 为什么要它：工作区记在 userData 的 workspace.json 里，而那个目录在仓库**外面** ——
 * 重装、重建、重新 clone 一份都不动它。于是"新建一份仓库、把软件整个重建一遍"，
 * 起来还是指着原来那条路（那个目录也许早没了、也许根本是别的项目），
 * 界面上的表现就是工作区不对、里面什么都扫不到。
 *
 * 只有这个目录确实是 ensoul 的一份 checkout 时才认它 —— 打包成安装包之后
 * getAppPath() 指的地方不会是仓库，那时返回空串，界面也就不提这回事。
 */
function selfCheckoutDir(): string {
  let dir = '';
  try {
    dir = appDir();
  } catch {
    return '';
  }
  if (!dir) return '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
    if (pkg?.name !== 'ensoul') return '';
    if (!fs.existsSync(path.join(dir, 'plugins'))) return '';
    return dir;
  } catch {
    return '';
  }
}

/** 那条记录的路径现在还是个目录吗 */
function dirAlive(dir: string): boolean {
  if (!dir) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.setIcon(path.join(appDir(), 'assets', 'icon.png'));
  // 只在 mac 上装菜单：win 上是空操作，开机这一下完全没影响
  installAppMenu();
  // 改名字（anycode → Ensoul）留下的旧数据先搬过来 —— **必须在 store.load() 之前**，
  // 它要读的 workspace.json / providers.json 现在住在旧目录里
  migrateUserData();
  store.load();
  // 界面的缩放乘区：窗口还没建就得读回来，否则第一帧会先按 100% 画一遍再跳
  loadZoom();
  // 语言：同样要在窗口建起来之前定下来 —— 原生菜单、插件 label 第一眼就要是对的
  loadLang();
  // 记着的那条工作区还在不在？**不在了就别硬认** —— 认下来只会在界面上造出一个
  // "什么都是空的"的假象（路径拼得出、文件一个也读不到，还不报错）。
  // 这时候退回"这份软件自己所在的目录"——重建出来的这份代码显然就是要在它自己身上干活。
  if (!dirAlive(store.state.workspace)) {
    const self = selfCheckoutDir();
    if (self) {
      console.log(
        `[工作区] 记着的那条路（${store.state.workspace || '空'}）现在不是个目录，换成这份软件自己所在的目录：${self}`,
      );
      store.setWorkspaceRoot(self);
    }
  }
  setFsRoot(store.state.workspace, { trust: true });
  // 工作区里的旧状态目录（.anycode → .ensoul）也顺手搬正
  migrateWorkspaceState(store.state.workspace);
  // 根就位之后：把老的单文件拆开、还留在组件本体里的做法搬进工作区的做法文件。
  // 这件事以前挂在「换工作区」那条路上，而启动根本没人走那条路 ——
  // 于是插件和核心都改好了，工作区里却一直是空的。
  store.syncCraftFiles();
  // 上次没选工作区时开过的文件，面板里冻着一句"读取失败" —— 根回来了就重读。
  // 少了这一步，重启之后看到的还是一句早就过期的错，正是"我明明选了工作区"
  store.refreshFailedFiles((rel) => readText(rel));
  // 完全权限是**按会话**的持久设置：真源在 store（panel.fullAccess），
  // 这儿只把"问谁"接上 —— fsapi 拿不到 store，也不该拿。
  setUnconfinedSource((panelId) => store.panelFullAccess(panelId));
  // 开机就把插件的状态部件接上，不等用户先发一条消息 —— 否则重启后那一排是空的
  const bootExt = loadPlugins(store.disabledPlugins());
  wireStatus(bootExt.status);
  wireCommands(bootExt.commands);
  registerIpc();
  dumpRpcTable();
  // 电话线：把这张表挂到本机一个端口上。
  //
  // 这一步做完，"后端"就不再只能被 Electron 调用了 —— 浏览器标签页、脚本、
  // 手机，只要拿到端口和令牌，就能调同一批能力、改同一份工作区。
  // 注意它**不替代**原来的 IPC：窗口照旧走老路，这只是多开的一个入口。
  void startRpcServer().then((port) => {
    if (!port) {
      console.error('[电话线] 端口没起来 —— 后端暂时仍只能在 Electron 里被调用');
      return;
    }
    console.log(`[电话线] 已开通 127.0.0.1:${port} —— ${rpcCount()} 条能力可从 Electron 之外调用`);
    try {
      fs.writeFileSync(
        userDataPath('rpc-endpoint.json'),
        JSON.stringify({ at: Date.now(), port, token: rpcToken(), count: rpcCount() }, null, 2),
      );
    } catch (e: any) {
      console.error('[电话线] 落盘失败：', e?.message ?? e);
    }
  });
  windows.onCloseRequest = (windowId) => {
    // 关掉浮窗 = 它里面的面板归一化回主窗口，不是删除
    store.attachWindow(windowId);
    refresh();
  };
  // 关掉挂件窗口 = 取消挂件状态、面板摆回停靠树（面板本身不该因为关窗而消失）
  windows.onWidgetClose = (panelId) => {
    store.unwidget(panelId);
    refresh();
  };
  windows.createMainWindow();
  refresh();

  // 常驻 + 托盘。**必须放在主窗口建好之后** —— 托盘的「打开」要有个能叫回来的窗口，
  // 而且托盘菜单是这一层唯一的新入口，建不起来就整个退回老行为（见 daemonActive）。
  setupTray({
    show: () => {
      const alive = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
      if (!alive.length) {
        // 窗口在常驻期间被全关了 —— 现在重建一扇，接上同一份 store（状态一直都在）
        windows.createMainWindow();
        refresh();
        return;
      }
      const w = alive[0];
      if (w.isMinimized()) w.restore();
      if (!w.isVisible()) w.show();
      w.focus();
    },
    quit: () => quitApp(),
  });
  // 软重启（app.relaunch + app.exit）**不触发** will-quit（实测只有 quit 事件），
  // 所以那条路上「退出前落盘」得靠这个钩子 —— 不注册的话，最后一次改动会跟着旧进程
  // 一起消失（store 的保存是 250ms 防抖，那一下正落在这个窗口里）。
  onBeforeRelaunch(() => store.flushNow());
  // 界面上那个滑块得知道现在是几倍（乘区由窗口层自己带上，这里只是报个数）
  toAllWindows('ui:zoom', getZoom());
  setTimeout(() => windows.broadcast(), 800);
  // 上一次重启前压着没发出去的那句话：新进程接上界面之后替它发（见 armResumeOutbox）
  bootResumeOutbox();
  // 上一个进程要是在半路上被收掉，收尾那段一次都没跑过 —— 流水条是唯一的凭据
  {
    const crashed = sweepJournal();
    if (crashed) console.warn(`[流水] 上次有 ${crashed} 轮没走完就断了，已记成 crashed`);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      windows.createMainWindow();
      refresh();
    }
  });
});

app.on('window-all-closed', () => {
  // 常驻模式：窗口全没了也**不退出**。
  //
  // 这一步就是「只在调出界面的时候才是 Electron」的全部实现 —— 窗口连同它的
  // 渲染进程一起销毁（那几百兆当场还回去），主进程留着继续跑：面板状态、插件、
  // 正在跑的会话，一样都不丢。托盘是把它叫回来的入口（见 daemon.ts）。
  //
  // 托盘没建起来时 daemonActive() 是 false，这里退回老行为 —— 没有入口的常驻
  // 会让窗口关掉之后再也打不开，那比直接退出糟得多。
  if (daemonActive()) {
    console.log('[常驻] 窗口已全部关闭 —— 留在后台继续跑，点托盘可以重新打开');
    return;
  }
  if (process.platform !== 'darwin') app.quit();
});

// 正常退出（关窗、Cmd+Q、app.quit）前把工作区落盘。
// store 的保存是 250ms 防抖，退出时那个 timer 很可能还挂着 —— 不兜这一下，
// 最后一次改动就留在内存里没了。强杀的路径（重启自己）在 project.ts 里单独兜。
app.on('will-quit', () => {
  // 走到这儿就是真要走了：先把托盘收掉，别在系统栏里留个点了没反应的僵尸图标
  markQuitting();
  destroyTray();
  store.flushNow();
});
