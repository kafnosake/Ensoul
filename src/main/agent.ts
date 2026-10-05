import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { listDir, panelSpaceDir, readText, runAsPanel, safePath, workspaceRoot, writeText } from './fsapi';
import { randomUUID } from 'crypto';
import { fileWrites, FileConflict, type FileWriteHook } from './file-writes';
import { build, needsBuild, restart, start, status as projectStatus, stop, tail } from './project';
import { readSkill } from './skills';
import type { AfterTool, BeforeTool, BeforeWrite, PluginTool, ToolContext } from './plugins';
import { t } from '../shared/i18n';
import { killProcessTree } from './process-control';

/**
 * agent 能真正动手的地方 —— 工具。
 *
 * 只有三档权限，默认最保守：
 *   read   只能看（读文件、列目录、搜内容）
 *   write  还能改工作区里的文件
 *   full   还能跑命令（构建、测试、git……）
 *
 * 所有路径都被 fsapi 夹在工作区里；命令也在工作区目录下执行，带超时和输出上限。
 */

export type ToolLevel = 'read' | 'write' | 'full';

/** 靠工作区吃饭的工具：没有工作区就没有"这个项目"，调用时直接回一句人话 */
const PROJECT_TOOLS = new Set([
  'build_project',
  'start_project',
  'stop_project',
  'restart_project',
  'project_status',
]);

/**
 * 外部（插件、技能）在每一轮对话开始前注入进来的东西。
 *
 * 为什么走注入，而不是让 agent 自己去 import 插件加载器：加载要读盘、要 require、
 * 还要查 store 里的开关，那些都是 IPC 层的活。这边只接收结果，于是这个模块
 * 仍然可以单独看懂、单独改。
 */
let pluginTools: PluginTool[] = [];
let beforeWrite: BeforeWrite[] = [];
let beforeTool: BeforeTool[] = [];
let afterTool: AfterTool[] = [];
let fileWrite: FileWriteHook[] = [];
let offSkills: string[] = [];
/** 读当前界面布局。由 IPC 层注入 —— 这里不 import store，本模块才能单独看懂 */
let layoutReport: () => string = () => t('（拿不到布局）');
/** 组件声明 / 撤销 —— 同样由 IPC 层注入（它才拿得到 store） */
let componentOps: ComponentOps | null = null;

/** 组件声明相关的两个动作 —— 接口摆在注入处，实现住 IPC 层 */
export interface ComponentOps {
  /** 给一块面板写下组件声明（panelId 给空串就是"当前这块"由调用方兜） */
  declare(panelId: string, name: string): string;
  /** 撤销一条组件（按名字或 id 找） */
  remove(key: string): string;
  /** 照一条组件克隆出一块新的（新 id、新对话线程），把新面板开在布局里 */
  clone(id: string): string;
}

/** 核心工具名。插件重名时以核心为准 —— 静默被插件顶掉会让两边都莫名其妙。 */
const CORE_TOOLS = new Set([
  'list_dir',
  'read_file',
  'write_file',
  'edit',
  'search',
  'grep',
  'glob',
  'read_image',
  'read_logs',
  'run_command',
  'build_project',
  'start_project',
  'stop_project',
  'restart_project',
  'project_status',
  'use_skill',
  'describe_layout',
  'component_declare',
  'component_remove',
  'component_clone',
]);

export function setExtensions(p: {
  tools?: PluginTool[];
  beforeWrite?: BeforeWrite[];
  beforeTool?: BeforeTool[];
  afterTool?: AfterTool[];
  fileWrite?: FileWriteHook[];
  disabledSkills?: string[];
  /** 读当前界面布局 —— 由 IPC 层注入（那边才拿得到 store 和窗口） */
  layout?: () => string;
  /** 组件声明 / 撤销 —— 由 IPC 层注入（那边才拿得到 store） */
  components?: ComponentOps;
}) {
  if (p.tools) pluginTools = p.tools.filter((t) => t.spec?.name && !CORE_TOOLS.has(t.spec.name));
  if (p.beforeWrite) beforeWrite = p.beforeWrite;
  if (p.beforeTool) beforeTool = p.beforeTool;
  if (p.afterTool) afterTool = p.afterTool;
  if (p.fileWrite) fileWrite = p.fileWrite;
  if (p.disabledSkills) offSkills = p.disabledSkills;
  if (p.layout) layoutReport = p.layout;
  if (p.components) componentOps = p.components;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
  timeoutMs?: number;
}

const spec = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  timeoutMs?: number,
): ToolSpec => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
  timeoutMs,
});

/**
 * 这个工具该不该出现在 `kind` 这种面板上。
 *
 * 不声明 `scope` = 到处都给（老插件一个字不用改）；声明了 = 只给清单里那几种面板。
 *
 * 为什么这件事必须住在核心里：工具表是核心装配的，插件没有"把自己的工具从某块面板上
 * 摘掉"的口子（有的话就是又开一套权限体系）。所以"只在某种面板上有意义"这件事，
 * 只能由核心在装配时按声明裁。
 */
function inScope(spec: PluginTool['spec'], kind?: string): boolean {
  const scope = spec.scope;
  if (!Array.isArray(scope) || !scope.length) return true;
  // 说不出是哪块面板时不做裁剪：宁可多给一个工具，也不能让某块面板悄悄少一个
  if (!kind) return true;
  return scope.includes(kind);
}

/** 每个组都会发的那几个通用工具 —— 归哪组由 KITS 写死，不靠名字里的下划线猜 */
const SHARED_TOOLS = new Set<string>([
  'list_dir', 'read_file', 'write_file', 'edit', 'search', 'grep', 'glob', 'read_image', 'read_logs', 'run_command',
  'use_skill', 'learn', 'deliver_result', 'send_image', 'dispatch',
  'todo_write', 'todo_read', 'history_search', 'history_read',
]);

/**
 * 根据工具名或描述特征智能推断其所属的套件组（防止插件未声明 kits 导致新工具被漏掉）。
 *
 * 分组跟 dispatch 的 KITS 对齐 —— **像素 / 画布 / 运维 / 规划各归各的组**，
 * 不再一律塞进 art / dev：否则勾「美术」会顺带带上画布工具，勾「画布」又拿到出图。
 * 认不出来的一律兜进 dev（新插件的工具至少不会漏给开发）。
 */
export function inferKitsForTool(name: string, description = ''): string[] {
  const n = String(name || '').toLowerCase();
  const d = String(description || '').toLowerCase();
  const kits = new Set<string>();

  // 1. 美术出图：ComfyUI 那一套 + 发图
  if (n.startsWith('comfyui_') || n === 'send_image' || d.includes('comfyui') || d.includes(t('出图'))) kits.add('art');

  // 2. 插件自带的工具（像素画师、无限画布这些）**在自己的声明里写 kits**，
  //    核心不替它们记工具名前缀 —— 这里只留"能凭工具名认出来"的那几档。

  // 3. 运维 / 长任务：后台任务 + 备份回滚
  if (n.startsWith('job_') || n.includes('backup') || n.startsWith('restore_')) kits.add('ops');

  // 4. 待办 / 调度
  if (n.startsWith('todo_')) kits.add('planner');

  // 5. 界面 / 模板：看布局、改组件、存开模板、开浏览器、调插件参数
  if (
    n.startsWith('component_') ||
    n.startsWith('template_') ||
    n === 'describe_layout' ||
    n === 'browser_open' ||
    n === 'plugin_params'
  ) {
    kits.add('ui');
  }

  // 6. 版本控制与发布
  if (n.startsWith('git_') || n.includes('diff') || n.includes('release') || d.includes('git') || d.includes(t('发布'))) {
    kits.add('dev');
    kits.add('release');
  }
  if (n.startsWith('packager_') || d.includes(t('打包'))) kits.add('release');

  // 7. 文案与信息检索（网页、历史会话）
  if (
    n.startsWith('web_') ||
    n.startsWith('history_') ||
    n.includes('fetch') ||
    n.includes('crawl') ||
    d.includes(t('查资料')) ||
    d.includes(t('网页'))
  ) {
    kits.add('copy');
  }

  // 8. 构建 / 运行工程
  if (
    n.startsWith('project_') ||
    n.startsWith('build_') ||
    n.startsWith('start_') ||
    n.startsWith('stop_') ||
    n.startsWith('restart_')
  ) {
    kits.add('dev');
  }

  // 9. 兜底：新插件的工具至少别漏给开发组。通用工具（SHARED_TOOLS）不参与推断 ——
  // 靠名字里的下划线猜，只会把 dev 蹭给所有人。
  if (!kits.size && !SHARED_TOOLS.has(n) && (n.includes('_') || d.length > 0)) kits.add('dev');

  return Array.from(kits);
}

export function toolsFor(level: ToolLevel, kind?: string, allow?: string[]): ToolSpec[] {
  const all = toolsForAll(level, kind);
  if (!allow || !allow.length) return all;
  const keep = new Set(allow);
  // '*' = 一个都不裁（全量）
  if (keep.has('*')) return all;
  // 支持精准匹配、通配符模式匹配（如 comfyui_* / git_*）、以及插件工具自己声明所属的 kits
  const wildcards = allow.filter((a) => a.includes('*')).map((w) => new RegExp('^' + w.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));
  const picked = all.filter((t) => {
    if (keep.has(t.function.name)) return true;
    if (wildcards.some((re) => re.test(t.function.name))) return true;
    const pt = pluginTools.find((p) => p.spec.name === t.function.name);
    if (pt && Array.isArray(pt.spec.kits) && pt.spec.kits.some((k) => keep.has(k))) return true;
    if (inferKitsForTool(t.function.name, t.function.description).some((k) => keep.has(k))) { return true;

    }
    return false;
  });
  // 一个都没挑中（清单写错、工具改名）时**退回全给**：宁可多给一个工具，
  // 也不能让某块面板悄悄变成哑巴 —— 跟 inScope 里那条兜底是同一个道理。
  return picked.length ? picked : all;
}

/**
 * 这块面板能看到哪些工具。
 *
 * 两层收窄，顺序不能反：
 *   · `level` = **权限上限**（read 只能看 / write 能改文件 / full 能跑命令）
 *   · `allow` = **白名单**，写在面板上（`Panel.tools`）—— 给员工配的那一套工具
 *
 * 白名单只在权限上限之内再收窄，越不过它：给只读面板配 `run_command` 也拿不到。
 *
 * 为什么白名单住在核心：工具表是核心装配的，插件没有"把自己的工具从某块面板上摘掉"
 * 的口子（有的话就是又开一套权限体系）。所以"这块面板只给这几个"只能由核心在装配时裁。
 */
function toolsForAll(level: ToolLevel, kind?: string): ToolSpec[] {
  /** 插件工具默认按「最高权限」算；自己声明了 level 就按声明来 */
  const rank: Record<ToolLevel, number> = { read: 0, write: 1, full: 2 };
  const pluginSpecs = pluginTools
    .filter((t) => rank[(t.spec.level ?? 'full') as ToolLevel] <= rank[level])
    .filter((t) => inScope(t.spec, kind))
    .map((t) => ({
      type: 'function' as const,
      function: {
        name: t.spec.name,
        description: t.spec.description,
        parameters: t.spec.parameters,
      },
    }));

  const base = [
    spec('list_dir', t('列出工作区里某个目录的内容。path 用相对工作区的路径，根目录写 "."'), { path: { type: 'string' } }, ['path']),
    spec(
      'read_file',
      t('读工作区里的文本文件，返回带行号的内容（一次最多 2000 行）。结果末尾会写明文件总行数和下一段的起点 —— 没读完就接着带 offset 读。'),
      {
        path: { type: 'string' },
        offset: { type: 'number', description: t('从第几行开始读（1 开始）。默认 1') },
        limit: { type: 'number', description: t('读多少行。默认 2000，最多 2000') },
      },
      ['path'],
    ),
    spec(
      'search',
      t('在工作区里按关键词搜文件名和文件内容。**尽量带 path 限定到一个子目录** —— 在工作区根上搜会把这个盘上的所有项目都翻一遍，')
        + t('又慢又会搜到一堆无关项目。返回的第一行会说明这次看了多少文件；如果被预算截断，会明确写出来。'),
      {
        keyword: { type: 'string' },
        path: { type: 'string', description: t('只在这个目录里搜（相对工作区）。不传就是整个工作区') },
      },
      ['keyword'],
    ),
    spec(
      'grep',
      t('按正则表达式或文本精准搜索工作区文件内容。支持文件包含过滤（如 include: "*.ts,*.tsx"）和子目录限制，')
        + t('返回文件名、行号与匹配行。比 search 更快更准，适合精确定位函数、类型、变量或报错。'),
      {
        pattern: { type: 'string', description: t('正则表达式或搜索文本') },
        path: { type: 'string', description: t('只在这个目录里搜（相对工作区）。默认整个工作区') },
        include: { type: 'string', description: t('文件名通配过滤，多个用逗号隔开，例如 "*.ts,*.tsx" 或 "*.json"') },
        caseSensitive: { type: 'boolean', description: t('是否大小写敏感。默认 false') },
        limit: { type: 'number', description: t('最多返回多少条匹配行。默认 100，上限 300') },
      },
      ['pattern'],
    ),
    spec(
      'glob',
      t('按 glob 通配符模式快速匹配工作区文件路径（例如 "plugins/*/index.js"、"src/**/*.ts"、"*.json"）。')
        + t('返回匹配到的相对文件路径列表，适合一次性定位某种模式的文件。'),
      {
        pattern: { type: 'string', description: t('glob 匹配模式，如 "**/*.ts" 或 "plugins/*/*.json"') },
        path: { type: 'string', description: t('搜索起点子目录（相对工作区）。默认工作区根目录') },
        limit: { type: 'number', description: t('最多返回多少个文件路径。默认 150，上限 500') },
      },
      ['pattern'],
    ),
    spec(
      'read_image',
      t('读取工作区里或本机绝对路径的图片文件（PNG / JPEG / WebP / GIF / BMP / AVIF），返回图片基本信息（格式、文件大小），')
        + t('并让大模型直接用视觉感知查看该图片，用于美术生图质检、前端 UI 视觉校验或确认参考图。'),
      {
        path: { type: 'string', description: t('图片路径（工作区相对路径或本机绝对路径）') },
      },
      ['path'],
    ),
    spec('read_logs', t('读这个项目最近的运行输出（启动、构建、报错都在里面）'), { lines: { type: 'number' } }, []),
    spec(
      'describe_layout',
      t('看用户此刻的界面长什么样：有哪些窗口、面板怎么摆的、谁跟谁并排、哪个正显示着、')
        + t('哪些浮着、哪些挂在别的窗口上。不用截图，直接给结构。')
        + t('改界面前先看一眼 —— 只看代码永远猜不到用户屏幕上到底是什么状态。'),
      {},
      [],
    ),
    // 技能正文按需取 —— 系统提示里只有名字和一句话说明
    spec(
      'use_skill',
      t('取出一个技能的完整内容（接线细节、踩过的坑、成串的约束都在里面）。先看系统提示里的技能清单，再决定取哪个。'),
      { name: { type: 'string' } },
      ['name'],
    ),
  ];
  if (level === 'read') return [...base, ...pluginSpecs];

  const write = [
    ...base,
    ...pluginSpecs,
    spec(
      'write_file',
      t('把内容写入工作区里的文件（整份覆盖）。新建文件也用这个，缺的父目录会自动建出来。已有文件先 read_file；遇到 FILE_CONFLICT 时重读当前版本，不重复旧覆盖。')
        + t('只改几行别用它 —— 整份重写又贵又容易把别处改坏，那种情况用 edit。'),
      { path: { type: 'string' }, content: { type: 'string' } },
      ['path', 'content'],
    ),
    spec(
      'edit',
      t('把文件里的一段原文换成新的一段 —— 改代码默认就该用它。')
        + t('old_string 必须是文件里**原样**存在的一段（含缩进），大文件里最好带上前后几行，保证它只出现一次。')
        + t('出现多次时会拒绝执行，那时要么把 old_string 写得更长更唯一，要么明确加 replace_all。'),
      {
        path: { type: 'string' },
        old_string: { type: 'string', description: t('要被替换掉的原文，必须与文件里一模一样') },
        new_string: { type: 'string', description: t('换成什么。传空串就是删掉这一段') },
        replace_all: { type: 'boolean', description: t('原文出现多次时是否全部替换。默认 false') },
      },
      ['path', 'old_string', 'new_string'],
    ),
    spec(
      'component_declare',
      t('给一块面板写下**组件声明** —— 有声明才算组件。')
        + t('声明过的面板**被永久保存**：关不关都在组件区与 设置 → 组件 里，只有用户在设置里手动删才会没。')
        + t('面板继续开着，不会从这里消失。不给 panelId 就是当前这块面板。'),
      {
        name: { type: 'string', description: t('声明名 —— 这个组件就叫这个名字（例：godot）') },
        panelId: { type: 'string', description: t('给哪块面板声明；不写就是当前这块') },
      },
      ['name'],
    ),
    spec(
      'component_clone',
      t('照一条组件**克隆出一块新的** —— 同一个案例的另一个实例：新面板、新对话线程，已经开在布局里，')
        + t('两份从此各聊各的。用它来"实例化很多个"（比如同一套做法的第二个、第三个）。')
        + t('原件一个字节不动。id 给面板 id（拿不准就先看 设置 → 组件 里那一列）。'),
      { id: { type: 'string', description: t('要克隆哪一条组件：面板 id') } },
      ['id'],
    ),
    spec(
      'component_remove',
      t('撤销一条组件声明（连它那份本体记录一起删，撤了之后这块面板就只是普通面板了）。key 给声明名或面板 id。'),
      { key: { type: 'string', description: t('声明名或面板 id') } },
      ['key'],
    ),
  ];
  if (level === 'write') return write;

  return [
    ...write,
    spec(
      'run_command',
      t('在工作区目录下执行一条命令（测试、git、跑脚本等），返回输出。不要跑交互式命令。')
        + t('注意：构建用 build_project、重启用 restart_project、读文件用 read_file —— 这三件事不要拿它代替。'),
      {
        command: { type: 'string' },
        workdir: { type: 'string', description: t('执行命令的子目录（相对工作区路径）。不传默认在工作区根目录') },
      },
      ['command'],
    ),
    spec(
      'build_project',
      t('只构建，不碰进程：编译源码、产出可运行的东西，返回完整构建输出。改完代码先用它确认能编译过。'),
      {},
      [],
    ),
    spec(
      'start_project',
      t('启动这个项目；如果源码比产物新，会先自动构建。已经在跑就不重复启动。可选传 command 覆盖启动命令。'),
      { command: { type: 'string' } },
      [],
    ),
    spec('stop_project', t('停掉这个项目正在跑的实例。'), {}, []),
    spec(
      'project_status',
      t('看项目现在的状态：跑没跑、用的哪条启动命令、什么时候起的、产物要不要重建、最近输出。'),
      {},
      [],
    ),
    spec(
      'restart_project',
      t('重启这个项目：先重新构建，构建通过再停掉旧实例、拉起新的（改完代码用它让改动生效）。构建失败会把输出原样给你，项目不会重启。可选传 command 覆盖启动命令。'),
      { command: { type: 'string' } },
      [],
    ),
  ];
}

function runCommand(command: string, workdir?: string, signal?: AbortSignal): Promise<string> {
  const root = workspaceRoot();
  let cwd: string | undefined = root || undefined;
  if (workdir) {
    cwd = root ? path.resolve(root, workdir) : path.resolve(workdir);
  }
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32' });
    let output = '';
    let failure: Error | undefined;
    const append = (chunk: Buffer) => {
      if (failure) return;
      output += String(chunk);
      if (output.length > 4 * 1024 * 1024) {
        failure = new Error('命令输出超过 4MB，已停止');
        output = output.slice(0, 20_000);
        killProcessTree(child);
      }
    };
    const abort = () => killProcessTree(child);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { failure = new Error('命令执行超时'); abort(); }, 120_000);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (error) => { cleanup(); reject(error); });
    child.on('close', (code) => {
      cleanup();
      if (signal?.aborted) { reject(signal.reason); return; }
      if (failure) { reject(failure); return; }
      resolve(`${output.trim()}${code ? `\n（退出码 ${code}）` : ''}`.slice(0, 20_000) || t('（没有输出）'));
    });
  });
}

/**
 * 搜索的硬预算。
 *
 * 为什么必须有：工作区根上挂着几十个项目（实测一个 20 万文件的目录），
 * 而以前这里是**同步**遍历 —— 一次根目录搜索会把 Electron 主进程按住几十秒
 * 到几分钟：界面不动、点停止也没反应、正在跑的接口调用被拖死。
 * 现在三个上限一起管（文件数 / 字节数 / 时间），到点就收手，
 * 并且**明确告诉调用方结果被截断了**，不能悄悄返回一句"没找到"。
 */
const SEARCH_FILES = 4000;
const SEARCH_BYTES = 24 * 1024 * 1024;
const SEARCH_MS = 6000;
const SEARCH_HITS = 60;

/** 简单搜索：先按文件名，再按内容。范围由调用方给（不给就是工作区根） */
async function searchWorkspace(keyword: string, scope = '.'): Promise<string> {
  const root = workspaceRoot();
  const base = path.resolve(root, scope || '.');
  if (base !== root && !base.startsWith(root + path.sep)) return `越出工作区：${scope}`;
  if (!keyword) return t('（没给关键词）');

  const skip = new Set([
    'node_modules', '.git', '__pycache__', 'dist', '.venv', 'venv', '.next',
    // 备份 / 缓存 / 构建产物 / 编辑器目录：文件多、内容重复，搜出来全是噪音
    '.ensoul', '.cache', '.idea', '.vscode', 'build', 'out', 'target',
    'vendor', 'coverage', 'tmp', 'temp', 'logs', '__snapshots__',
  ]);
  const hits: string[] = [];
  const t0 = Date.now();
  const lower = keyword.toLowerCase();
  let files = 0;
  let bytes = 0;
  let big = 0;
  let cut = '';

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (cut || depth > 6 || hits.length >= SEARCH_HITS) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 读不了的目录就跳过
    }
    for (const e of entries) {
      if (cut) return;
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (e.name.toLowerCase().includes(lower)) {
        hits.push(`文件名命中：${rel}`);
        if (hits.length >= SEARCH_HITS) cut = `命中已经够 ${SEARCH_HITS} 条了`;
        continue;
      }
      if (files >= SEARCH_FILES) { cut = `已经看了 ${SEARCH_FILES} 个文件`; return; }
      if (bytes >= SEARCH_BYTES) { cut = `已经读满 ${Math.round(SEARCH_BYTES / 1024 / 1024)} MB`; return; }
      if (Date.now() - t0 > SEARCH_MS) { cut = `已经跑了 ${Math.round(SEARCH_MS / 1000)} 秒`; return; }
      try {
        const st = await fs.promises.stat(full);
        if (st.size > 400_000) {
          big += 1;
          continue;
        }
        files += 1;
        bytes += st.size;
        // 每读一批就让出主线程一次 —— 这是"界面不卡"的关键。
        // 全是同步 IO 的话，主进程会一直憋在这一次搜索里，窗口整个冻住。
        if (files % 32 === 0) await new Promise((r) => setImmediate(r));
        const text = await fs.promises.readFile(full, 'utf8');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && hits.length < SEARCH_HITS; i += 1) {
          if (lines[i].toLowerCase().includes(lower)) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
        }
      } catch {
        /* 二进制或读不了就跳过 */
      }
    }
  };

  await walk(base, 0);

  const head =
    `（在 ${scope || '.'} 里搜「${keyword}」：看了 ${files} 个文件 / ${Math.round(bytes / 1024)} KB` +
    `${big ? `，跳过 ${big} 个大文件` : ''}）`;
  const body = hits.length ? hits.join('\n') : '没找到';
  const tail = cut ? `\n…${cut}就收手了，**结果不完整**。把 path 缩小到一个子目录再搜一次。` : '';
  return `${head}\n${body}${tail}`;
}

// 将简单 glob 模式转换为正则表达式
function globToRegex(glob: string): RegExp {
  const g = glob.trim().replace(/\\/g, '/');
  let regStr = '^';
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          regStr += '(?:.+/)?';
          i += 3;
          continue;
        } else {
          regStr += '.*';
          i += 2;
          continue;
        }
      } else {
        regStr += '[^/]*';
        i += 1;
        continue;
      }
    } else if (c === '?') {
      regStr += '[^/]';
      i += 1;
      continue;
    } else if (['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'].includes(c)) {
      regStr += '\\' + c;
      i += 1;
    } else {
      regStr += c;
      i += 1;
    }
  }
  regStr += '$';
  return new RegExp(regStr, 'i');
}

/**
 * grep: 正则或文本搜索，支持文件 include 过滤（如 *.ts,*.js）和子目录范围
 */
async function grepWorkspace(
  pattern: string,
  scope = '.',
  include?: string,
  caseSensitive = false,
  maxHits = 100,
): Promise<string> {
  const root = workspaceRoot();
  const base = path.resolve(root, scope || '.');
  if (base !== root && !base.startsWith(root + path.sep)) return `越出工作区：${scope}`;
  if (!pattern) return '（没给搜索表达式）';

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
  } catch (e: any) {
    return `正则表达式不合法：${e?.message ?? e}`;
  }

  const includeFilters = include
    ? include
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(globToRegex)
    : null;

  const skip = new Set([
    'node_modules', '.git', '__pycache__', 'dist', '.venv', 'venv', '.next',
    '.ensoul', '.cache', '.idea', '.vscode', 'build', 'out', 'target',
    'vendor', 'coverage', 'tmp', 'temp', 'logs', '__snapshots__',
  ]);

  const hits: string[] = [];
  const limit = Math.max(1, Math.min(Number(maxHits) || 100, 300));
  const t0 = Date.now();
  let files = 0;
  let bytes = 0;
  let cut = '';

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (cut || depth > 8 || hits.length >= limit) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (cut) return;
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (includeFilters && !includeFilters.some((re) => re.test(e.name) || re.test(rel))) {
        continue;
      }
      files += 1;
      if (files >= 6000) { cut = '已检查达到 6000 个文件上限'; return; }
      if (Date.now() - t0 > 8000) { cut = '运行已达到 8 秒超时'; return; }
      try {
        const st = await fs.promises.stat(full);
        if (st.size > 500_000) continue;
        bytes += st.size;
        if (files % 32 === 0) await new Promise((r) => setImmediate(r));
        const text = await fs.promises.readFile(full, 'utf8');
        // 二进制忽略
        if (text.slice(0, 1000).includes('\0')) continue;
        const lines = text.split('\r\n');
        for (let i = 0; i < lines.length && hits.length < limit; i += 1) {
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
        }
      } catch {
        /* 读取失败跳过 */
      }
    }
  };

  await walk(base, 0);

  const head = `（在 ${scope || '.'} 里匹配「${pattern}」${include ? `，限定 ${include}` : ''}：扫描了 ${files} 个文件 / ${Math.round(bytes / 1024)} KB）`;
  const body = hits.length ? hits.join('\r\n') : '没找到匹配内容';
  const tail = cut ? `\r\n…${cut}就收手了，结果不完整。请缩小 path 范围或使用 include 过滤文件。` : '';
  return `${head}\r\n${body}${tail}`;
}

/**
 * glob: 快速匹配文件路径列表（支持 ** / * 通配符）
 */
async function globWorkspace(pattern: string, scope = '.', maxHits = 150): Promise<string> {
  const root = workspaceRoot();
  const base = path.resolve(root, scope || '.');
  if (base !== root && !base.startsWith(root + path.sep)) return `越出工作区：${scope}`;
  if (!pattern) return '（没给匹配模式）';

  const reg = globToRegex(pattern);
  const skip = new Set([
    'node_modules', '.git', '__pycache__', 'dist', '.venv', 'venv', '.next',
    '.ensoul', '.cache', '.idea', '.vscode', 'build', 'out', 'target',
  ]);
  const matched: string[] = [];
  const limit = Math.max(1, Math.min(Number(maxHits) || 150, 500));
  const t0 = Date.now();
  let count = 0;
  let cut = '';

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (cut || depth > 8 || matched.length >= limit) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (cut) return;
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      const relFromScope = path.relative(base, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      count += 1;
      if (count >= 10000) { cut = '已遍历 10000 个文件上限'; return; }
      if (Date.now() - t0 > 6000) { cut = '遍历达到 6 秒超时'; return; }
      if (reg.test(e.name) || reg.test(rel) || reg.test(relFromScope)) {
        matched.push(rel);
      }
    }
  };

  await walk(base, 0);

  const head = `（匹配模式「${pattern}」，起点「${scope || '.'}」：遍历了 ${count} 个文件，命中 ${matched.length} 条）`;
  const body = matched.length ? matched.join('\r\n') : '（未匹配到符合条件的文件）';
  const tail = cut ? `\r\n…${cut}，结果可能不完整。` : '';
  return `${head}\r\n${body}${tail}`;
}

/**
 * read_image: 读取图片并输出信息，同时注入 [[see: 路径]] 让模型视觉通道感知
 */
function readImageFile(filePath: string): string {
  if (!filePath) return '请提供图片文件路径。';
  let abs = '';
  try {
    abs = path.isAbsolute(filePath) ? filePath : safePath(filePath);
  } catch (e: any) {
    return `路径无效或越界：${e?.message ?? e}`;
  }

  if (!fs.existsSync(abs)) {
    return `图片文件不存在：${filePath}`;
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch (e: any) {
    return `无法读取文件信息：${e?.message ?? e}`;
  }
  if (st.isDirectory()) {
    return `该路径是一个目录，不是图片文件：${filePath}`;
  }

  const ext = path.extname(abs).slice(1).toLowerCase();
  const validExts = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']);
  if (!validExts.has(ext)) {
    return `文件后缀 .${ext} 不是受支持的常见图片格式（支持 png, jpg, jpeg, webp, gif, bmp, avif）。`;
  }

  const sizeKb = Math.round(st.size / 1024);
  const rel = workspaceRoot() ? path.relative(workspaceRoot(), abs).split(path.sep).join('/') : filePath;

  // 通过 [[see: 路径]] 标记让宿主 chat-core 将图片打包成 Base64 视觉块送入大模型，同时给出文字摘要
  return [
    `已读取图片：${rel}（格式：${ext.toUpperCase()}，大小：${sizeKb} KB）`,
    '图片已成功载入视觉通道，你可以直接查看并评估其视觉内容。',
    `[[see: ${abs}]]`,
  ].join('\r\n');
}

/** 构建/命令的输出可能很长，只留尾巴 —— 报错都在末尾 */
function tailOut(s: string, n = 4000): string {
  const t = (s || '').trim();
  if (!t) return '（没有输出）';
  return t.length > n ? `…（前面省略 ${t.length - n} 字）\n${t.slice(-n)}` : t;
}

/**
 * 工具结果的**落地**：太大的输出正文不再整段塞回上下文，而是写进工作区一个文件，
 * 只把开头、结尾和文件位置交给模型。
 *
 * 为什么：一次构建 / 一次全库搜索的输出动辄几万字，整段带回去就是几万 token，
 * 而真正要看的通常是**结尾那几行报错**和开头那句命令。落地之后模型需要哪一段就
 * read_file 带 offset/limit 去取 —— 花的是它真要看的那点钱。
 */
const SPILL_AT = 8_000;
const SPILL_HEAD = 3_000;
const SPILL_TAIL = 2_000;
/** 这几种同理：它们既不落地也不修剪，正文整份给（见下面 NO_SPILL 与 chat-core 的 KEEP_WHOLE） */
/**
 * 阈值必须**小于** pruneToolText 的 PRUNE_AT(8192)：这样"会被修剪"的那一档全部先被落地
 * 接走，落地后 head+tail+提示不到 5.2k 字，修剪就再也够不着它。
 *
 * 为什么从前会丢东西：两个阈值中间曾有 8192~20000 这么一段空白 —— 不长到触发落地，
 * 又长到会触发修剪，于是中间那一大段被悄悄掐掉，而 read_file 的 footer 还在说
 * "End of file"。现在落地是**唯一**那道闸，且落地的提示里带着可取回的文件路径。
 *
 * 这几种的输出是"就是要整份看"的：技能正文是**指令**（掐中间等于给半套流程），
 * 另外两个是结构化清单。它们既不落地也不修剪 —— 名字与 chat-core 的 KEEP_WHOLE 对齐，
 * 改一份记得改另一份。
 *
 * read_file **不在**这里了：它一屏最多 50KB（约一万七千字），从前既不落地、又被修剪，
 * 模型拿着头 4096 字、看着"读完了"的 footer，就把半份文件当全份用 —— 这是错的，不只是贵。
 */
const NO_SPILL = new Set(['use_skill', 'list_dir', 'describe_layout']);

/**
 * read_file 的窗口参数（READ_LIMIT / READ_MAX_LINE_LENGTH / READ_MAX_BYTES）。
 * 这里是同步读整份再开窗，10MB 封顶。
 */
const READ_LIMIT = 2_000;
const READ_MAX_LINE = 2_000;
const READ_MAX_BYTES = 50 * 1024;
const READ_MAX_FILE = 10 * 1024 * 1024;

function spill(name: string, text: string, ctx: ToolContext | null): string {
  const s = String(text ?? '');
  if (s.length <= SPILL_AT || NO_SPILL.has(name)) return s;
  // 落进**这个面板自己的目录**：里面装的是它跑过的命令的原始输出，
  // 混在一个平铺目录里，别的面板 list_dir 一下就能读到。
  const mine = panelSpaceDir(ctx?.panelId || '') || path.join('.ensoul', 'spill');
  const rel = path.join(mine, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}.txt`);
  const head = s.slice(0, SPILL_HEAD);
  const tailPart = s.slice(-SPILL_TAIL);
  const note =
    `\n\n…（中间 ${s.length - SPILL_HEAD - SPILL_TAIL} 字没显示。完整输出 ${s.length} 字已存到 ` +
    `${rel.split(path.sep).join('/')}；要中间那一段就用 read_file 带 offset/limit 去读，别整份读）\n\n`;
  try {
    const abs = path.join(workspaceRoot(), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, s, 'utf8');
  } catch (e: any) {
    // 落不下来也绝不能把"成功"变成"失败"：原样给开头和结尾，说明中间没了
    return `${head}${note}（落地失败：${e?.message ?? e}）\n${tailPart}`;
  }
  return `${head}${note}${tailPart}`;
}

/**
 * 工具的唯一入口。
 *
 * 三层：真正干活（出错往外抛）→ 统一收场（错误也变成一句能读懂的话交给模型）
 * → 插件加工（`onAfterTool`，能改写结果）→ 落地（太大的输出写文件，只把头尾和位置交回去）。
 *
 * 在这之前先过一次插件钩子（`onBeforeTool`）：它能把这次调用拦下来，
 * 换一句话当结果交给模型。重启用的是这条路 —— 见 plugins/restart-approval。
 * 一个插件钩子出错不许拦住工具本身：它的活是"多一道意见"，不是"卡住别人"。
 */
export async function runTool(name: string, args: any, ctx: ToolContext | null = null): Promise<string> {
  return invokeTool(name, args, ctx, false);
}

async function invokeTool(name: string, args: any, ctx: ToolContext | null, confirmed: boolean): Promise<string> {
  const toolCallId = 'tool-' + randomUUID();
  const callCtx = ctx ? { ...ctx, toolCallId } : null;
  const beforeHooks = [...beforeTool], afterHooks = [...afterTool];
  const call = { id: toolCallId, name, panelId: ctx?.panelId || '', hooks: [...fileWrite] };
  // 整个这一趟（含 before / after 钩子、真正干活、落盘）都贴着这个会话跑 ——
  // fsapi 靠它知道"这一手读写是在替谁做"，完全权限才按会话算得准（见 fsapi 的 isUnconfined）。
  return fileWrites.withCall(call, () => runAsPanel(ctx?.panelId ?? '', async () => {
    try {
      ctx?.signal?.throwIfAborted();
      if (['write_file', 'edit', 'restore_backup'].includes(name) && typeof args?.path === 'string' && args.path) fileWrites.acquire(safePath(args.path));
      for (const hook of confirmed ? [] : beforeHooks) {
        try {
          const blocked = await hook({ name, args, ctx: callCtx, toolCallId });
          if (typeof blocked === 'string') return blocked;
        } catch (e: any) {
          console.error('[插件钩子 onBeforeTool] 出错：', e?.message ?? e);
        }
      }
      ctx?.signal?.throwIfAborted();
      return await execTool(name, args, callCtx, toolCallId, afterHooks);
    } catch (error) {
      if (error instanceof FileConflict) return error.result();
      throw error;
    } finally { fileWrites.release(toolCallId); }
  }, ctx?.signal));
}

/**
 * 用户点过头之后跑的那一次 —— **不再过插件钩子**。
 * 请求本身就是插件提的，回头再问一遍就成了死循环（见 plugins.ts 的 AskSpec）。
 */
export async function runToolConfirmed(name: string, args: any, ctx: ToolContext | null = null): Promise<string> {
  return invokeTool(name, args, ctx, true);
}

async function execTool(name: string, args: any, ctx: ToolContext | null, toolCallId: string, afterHooks: AfterTool[]): Promise<string> {
  ctx?.signal?.throwIfAborted();
  const ctrl = new AbortController();
  const abort = () => ctrl.abort(ctx?.signal?.reason);
  ctx?.signal?.addEventListener('abort', abort, { once: true });
  const callCtx = ctx ? { ...ctx, signal: ctrl.signal } : null;
  let out = '';
  const pluginMatch = pluginTools.find((p) => p.spec?.name === name);
  let timeoutMs = pluginMatch?.spec?.timeoutMs;
  if (!timeoutMs || timeoutMs <= 0) {
    if (name.startsWith('comfyui_')) timeoutMs = 300_000;
    else if (name === 'run_command' || name.startsWith('web_')) timeoutMs = 120_000;
    else timeoutMs = 60_000;
  }

  let timer: NodeJS.Timeout | undefined;
  let rejectAbort: () => void = () => {};
  const abortedPromise = new Promise<string>((_, reject) => {
    rejectAbort = () => reject(ctrl.signal.reason || new Error('这一轮已停止'));
    ctrl.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  const timeoutPromise = new Promise<string>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`[TOOL_TIMEOUT] 工具 ${name} 执行超时（超过 ${Math.round(timeoutMs! / 1000)} 秒无响应）`);
      ctrl.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    out = await Promise.race([
      runAsPanel(ctx?.panelId ?? '', () => runToolRaw(name, args, callCtx), ctrl.signal),
      timeoutPromise,
      abortedPromise,
    ]);
  } catch (e: any) {
    out = e instanceof FileConflict ? e.result() : `工具执行失败：${e?.message ?? e}`;
  } finally {
    if (timer) clearTimeout(timer);
    ctrl.signal.removeEventListener('abort', rejectAbort);
    ctx?.signal?.removeEventListener('abort', abort);
  }
  // 结果交给模型之前，再过一次插件的"后"钩子：它能看，也能换掉这段结果。
  // 刻意放在落盘（spill）之前 —— 插件看到的是**完整**的原始结果，落盘仍是最后一道兜底。
  // 钩子出错只记一笔就放行：它的活是"多一道加工"，不是"把结果变成报错"。
  for (const hook of afterHooks) {
    try {
      const replaced = await hook({ name, args, ctx: callCtx, toolCallId, result: out });
      if (typeof replaced === 'string') out = replaced;
    } catch (e: any) {
      console.error('[插件钩子 onAfterTool] 出错：', e?.message ?? e);
    }
  }
  ctx?.signal?.throwIfAborted();
  return spill(name, out, ctx);
}

/** 真正干活的那一层 */
async function runToolRaw(name: string, args: any, ctx: ToolContext | null): Promise<string> {
  // 项目类工具操作的"这个项目"就是当前工作区。一个工作区都没选的时候，
  // 它们没有对象可谈 —— 早点说清楚，别掉到下面拿空路径去拼 shell 命令。
  if (PROJECT_TOOLS.has(name) && !workspaceRoot()) {
    return '还没选工作区：先点左上角「选工作区」挑一个目录 —— 项目工具操作的"这个项目"就是当前工作区。';
  }
  switch (name) {
    case 'component_declare':
      return componentOps
        ? componentOps.declare(String(args?.panelId || ctx?.panelId || ''), String(args?.name ?? ''))
        : '（拿不到面板清单）';
    case 'component_remove':
      return componentOps ? componentOps.remove(String(args?.key ?? '')) : '（拿不到面板清单）';
    case 'component_clone':
      return componentOps ? componentOps.clone(String(args?.id ?? ctx?.panelId ?? '')) : '（拿不到面板清单）';
    case 'list_dir':
      return listDir(args?.path || '.')
        .slice(0, 200)
        .map((e) => `${e.dir ? t('[目录] ') : '       '}${e.path}${e.dir ? '' : `  (${e.size} 字节)`}`)
        .join('\n') || '（空目录）';
    case 'read_file': {
      const rel = String(args?.path ?? '');
      const text = readText(rel, READ_MAX_FILE, true);
      // 超大/二进制的特殊回执不套行号外壳（和 applyEdit 认的是同两句话）
      if (text.startsWith('（这个文件有 ') || text.startsWith('（二进制文件')) return text;
      const rawLines = text.split('\n');
      if (rawLines[rawLines.length - 1] === '') rawLines.pop(); // 末尾换行不算一行
      const total = rawLines.length;

      const offset = Math.floor(Number(args?.offset) || 1);
      if (offset < 1) return 'offset 从 1 开始。';
      if (offset > total && !(total === 0 && offset === 1)) return `offset ${offset} 越界：${rel} 一共只有 ${total} 行。`;
      const limit = Math.floor(Number(args?.limit) || READ_LIMIT);
      if (limit < 1) return 'limit 至少 1 行。';
      if (limit > READ_LIMIT) return `limit 最多 ${READ_LIMIT} 行 —— 要接着读，等这次结果末尾告诉你从哪行继续。`;

      // 开窗：三条硬上限 —— 行数、单行字数、总共字节数
      const out: string[] = [];
      let bytes = 0;
      let capped = false;
      let endLine = offset - 1;
      for (const raw of rawLines.slice(offset - 1, offset - 1 + limit)) {
        const line = raw.length > READ_MAX_LINE
          ? `${raw.slice(0, READ_MAX_LINE)}... (line truncated to ${READ_MAX_LINE} chars)`
          : raw;
        const cost = Buffer.byteLength(line, 'utf8') + (out.length ? 1 : 0);
        if (bytes + cost > READ_MAX_BYTES) { capped = true; break; }
        bytes += cost;
        out.push(line);
        endLine += 1;
      }

      // footer 永远在：文件多长、下次从哪读，模型不用猜也不用试探
      const footer = capped
        ? `(Output capped. Showing lines ${offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
        : endLine < total
          ? `(Showing lines ${offset}-${endLine} of ${total}. Use offset=${endLine + 1} to continue.)`
          : `(End of file - total ${total} lines)`;
      const body = out.length
        ? `${out.map((l, i) => `${offset + i}: ${l}`).join('\n')}\n\n${footer}`
        : footer;
      return `<path>${rel}</path>\n<type>file</type>\n<content>\n${body}\n</content>`;
    }
    case 'write_file': {
      const rel = String(args?.path ?? '');
      const text = String(args?.content ?? '');
      // 插件挂在"写之前"的钩子（内置的 file-backup 就在这里留底）。
      // 钩子出错不许挡住写入本身 —— 它是附加能力，不是必经关卡。
      for (const fn of beforeWrite) {
        try {
          fn(rel, text);
        } catch (e: any) {
          console.error('[插件] 写前钩子出错：', e?.message ?? e);
        }
      }
      writeText(rel, text);
      return `已写入 ${rel}（${text.length} 字符）`;
    }
    case 'edit':
      return applyEdit(String(args?.path ?? ''), args ?? {});
    case 'use_skill':
      return readSkill(String(args?.name ?? ''), offSkills);
    case 'search':
      return await searchWorkspace(String(args?.keyword ?? ''), String(args?.path ?? '.'));
    case 'grep':
      return await grepWorkspace(
        String(args?.pattern ?? ''),
        String(args?.path ?? '.'),
        args?.include ? String(args.include) : undefined,
        Boolean(args?.caseSensitive),
        Number(args?.limit) || 100,
      );
    case 'glob':
      return await globWorkspace(String(args?.pattern ?? ''), String(args?.path ?? '.'), Number(args?.limit) || 150);
    case 'read_image':
      return readImageFile(String(args?.path ?? ''));
    case 'run_command':
      return await runCommand(String(args?.command ?? ''), args?.workdir ? String(args.workdir) : undefined, ctx?.signal);
    case 'read_logs':
      return tail(Number(args?.lines) || 80);
    case 'describe_layout':
      return layoutReport();
    case 'build_project': {
      const r = await build();
      return [
        r.ok ? t('构建通过。') : t('构建没过 —— 先把下面这些错修掉。'),
        '',
        t('构建输出（末尾）：'),
        '```',
        tailOut(r.out),
        '```',
      ].join('\n');
    }
    case 'start_project': {
      const s = await start(args?.command ? String(args.command) : undefined);
      if (s.running) return `已启动：${s.command}\n\n最近输出：\n${tail(30)}`;
      return `没能启动（命令：${s.command || '还没有可用的启动命令'}）\n\n最近输出：\n${tail(30)}`;
    }
    case 'stop_project': {
      const s = stop();
      return s.running ? `没停下来，还在跑：${s.command}` : t('已停止。');
    }
    case 'project_status': {
      const s = projectStatus();
      return [
        `运行中：${s.running ? '是' : '否'}`,
        `启动命令：${s.command || '（还没定）'}`,
        s.running ? `启动于：${new Date(s.startedAt).toLocaleString('zh-CN')}` : '',
        `工作区：${s.workspace}`,
        `产物要不要重建：${needsBuild() ? '要' : '不要'}`,
        '',
        t('最近输出：'),
        tail(40),
      ]
        .filter(Boolean)
        .join('\n');
    }
    case 'restart_project': {
      const r = await restart(args?.command ? String(args.command) : undefined);
      if (!r.built) {
        return [
          t('构建没过，没有重启 —— 先把下面这些错修掉。'),
          '',
          t('构建输出（末尾）：'),
          '```',
          tailOut(r.out),
          '```',
        ].join('\n');
      }
      const head = r.reloaded
        ? t('只改了界面代码：已重建界面并刷新窗口，应用没有重启（窗口、布局、对话都还在）。')
        : r.selfRestart
          ? t('构建通过。约半秒后旧进程退出、新产物拉起新实例；窗口会消失一下，对话存在 store 里，回来还在。')
          : `构建通过，已重启：${r.status.command}`;
      return `${head}\n\n最近输出：\n${tail(30)}`;
    }
    default: {
      // 插件注册的工具走这里。核心工具在上面的 case 里已经短路掉了。
      const hit = pluginTools.find((t) => t.spec.name === name);
      if (hit) {
        const out = await hit.handler(args ?? {}, ctx);
        return String(out ?? '');
      }
      return `没有这个工具：${name}`;
    }
  }
}

/** 出现几次。用 indexOf 数，不做正则 —— old_string 里什么字符都可能有 */
function countOf(text: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let at = text.indexOf(needle);
  while (at >= 0) {
    n += 1;
    at = text.indexOf(needle, at + needle.length);
  }
  return n;
}

/**
 * 改文件里的某一段 —— 「改代码默认用它」的那个工具。
 *
 * 为什么必须有：整份 write_file 改一行，等于把整个文件重发一遍（贵），
 * 而且模型复述原文时抄错一个字就静默改坏了别处。edit 只认"原文确实在这儿"，
 * 找不到就报错、出现多次就拒绝 —— 于是改错的路基本被堵死。
 */
function applyEdit(rel: string, args: any): string {
  const oldText = String(args?.old_string ?? '');
  const newText = String(args?.new_string ?? '');
  const all = Boolean(args?.replace_all);
  if (!rel) return t('edit 需要 path。');
  if (!oldText) return t('edit 需要 old_string（要替换掉的那段原文）；想在文件末尾追加就用 write_file。');

  let text = '';
  try {
    text = readText(rel);
  } catch (e: any) {
    return `读不到 ${rel}：${e?.message ?? e}（新文件用 write_file）`;
  }
  if (text.startsWith(t('（这个文件有 ')) || text.startsWith(t('（二进制文件'))) return `${rel}：${text}`;

  const n = countOf(text, oldText);
  if (n === 0) {
    return (
      `在 ${rel} 里没找到这段原文，一个字符都没改。\n`
      + t('多半是缩进/空行/引号和文件里不一致 —— 用 read_file 把要改的那几行连上下文一起读出来，')
      + t('照着原文（含缩进）重新给 old_string。')
    );
  }
  if (n > 1 && !all) {
    return (
      `这段原文在 ${rel} 里出现了 ${n} 次，没有动手 —— 只改一处会改错地方。\n`
      + t('把 old_string 前后各多带几行、补到它在文件里唯一，或者确认是要全改时加 replace_all: true。')
    );
  }

  const at = text.indexOf(oldText);
  const lineAt = text.slice(0, at).split('\n').length;
  const next = all ? text.split(oldText).join(newText) : text.slice(0, at) + newText + text.slice(at + oldText.length);
  if (next === text) return `${rel} 没变化（新内容和原文一样）。`;

  for (const fn of beforeWrite) {
    try {
      fn(rel, next);
    } catch (e: any) {
      console.error('[插件] 写前钩子出错：', e?.message ?? e);
    }
  }
  writeText(rel, next);

  const added = next.split('\n').length - text.split('\n').length;
  const delta = added === 0 ? t('行数不变') : added > 0 ? `多了 ${added} 行` : `少了 ${-added} 行`;
  return `已改 ${rel} 第 ${lineAt} 行${all ? `起（共 ${n} 处）` : ''}：${delta}，现在 ${next.length} 字符。`;
}

/** 给对话里显示的一句话说明 */
export function describeTool(name: string, args: any): string {
  switch (name) {
    case 'read_file':
      return `read ${args?.path ?? ''}`.trim();
    case 'write_file':
      return `write ${args?.path ?? ''}`.trim();
    case 'edit':
      return `edit ${args?.path ?? ''}`.trim();
    case 'list_dir':
      return `list ${args?.path ?? '.'}`.trim();
    case 'search':
      return `search ${args?.keyword ?? ''}${args?.path && args.path !== '.' ? ` in ${args.path}` : ''}`.trim();
    case 'grep':
      return `grep ${args?.pattern ?? ''}${args?.include ? ` (${args.include})` : ''}${args?.path && args.path !== '.' ? ` in ${args.path}` : ''}`.trim();
    case 'glob':
      return `glob ${args?.pattern ?? ''}${args?.path && args.path !== '.' ? ` in ${args.path}` : ''}`.trim();
    case 'read_image':
      return `view ${args?.path ?? ''}`.trim();
    case 'run_command':
      return `run ${args?.command ?? ''}${args?.workdir ? ` @ ${args.workdir}` : ''}`.trim();
    case 'read_logs':
      return 'logs';
    case 'build_project':
      return 'build';
    case 'start_project':
      return 'start';
    case 'stop_project':
      return 'stop';
    case 'restart_project':
      return 'restart';
    case 'project_status':
      return 'status';
    case 'web_search':
      return `web search ${args?.query ?? ''}`.trim();
    case 'web_fetch':
      return `fetch ${args?.url ?? ''}`.trim();
    case 'dispatch':
      return `dispatch ${args?.emp || args?.dept || ''}`.trim();
    case 'use_skill':
      return `skill ${args?.name ?? ''}`.trim();
    case 'git_status':
      return 'git status';
    case 'git_ignore':
      return 'git ignore';
    default:
      return name;
  }
}
