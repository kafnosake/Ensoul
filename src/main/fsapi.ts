import * as fs from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import { t } from '../shared/i18n';
import { fileWrites } from './file-writes';
import type { JsonSnapshot } from '../shared/json-snapshot';

/**
 * 工作区文件访问 —— 让"文件"面板和"文本"面板有真东西可看。
 *
 * **没有默认工作区**：启动时是空的，得由人在左上角挑一个目录；挑过之后写在
 * workspace.json 里，下次自己回来。没有"替你猜一个"的兜底 —— 猜出来的目录
 * 十有八九不存在，还会让文件面板指着一个莫名其妙的地方。
 * （环境变量 ENSOUL_WORKSPACE 是显式指定，不是默认值。）
 * 所有路径都被夹在这个根里面：越界的请求直接拒绝，面板改不了外面的东西。
 */

const SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', '.next']);

/** 根目录是可变的工作区 —— 左上角切了立刻生效。空串 = 还没选 */
let ROOT = process.env.ENSOUL_WORKSPACE ? path.resolve(process.env.ENSOUL_WORKSPACE) : '';

/**
 * 完全权限：关掉"路径必须落在工作区里"这条限制。
 *
 * **按会话算**：一个会话开不开，只看它自己 —— 以前这是整个工作区一个开关，
 * 在任何一块面板的输入框上点一下，别的会话也一起变成了完全权限。
 *
 * 默认关着 —— 工作区是边界，越界直接拒绝。开了之后能读写任意路径，
 * 这才有可能去动工作区之外的东西（比如 ensoul 自己：它通常在 D:\ 下，
 * 不在任何工作区里，夹着就永远改不到自己）。
 *
 * 真源在 store（workspace.json 的 panelFullAccess），这里只负责问它一句。
 */
let unconfinedOf: (panelId: string) => boolean = () => false;

export function setUnconfinedSource(fn: (panelId: string) => boolean) {
  unconfinedOf = fn;
}

/**
 * 这一手读写此刻是在替哪个会话干活。
 *
 * 为什么用 AsyncLocalStorage 而不是到处传 panelId：读写的落点散在
 * readText / writeText / listDir 里，还有 applyEdit、spill 那些转手调它们的地方 ——
 * 每个签名都塞一个面板 id，等于把"哪个会话"缝进整条链路。
 * 在工具执行的入口包一次，底下全都看得到。
 */
const whoAmI = new AsyncLocalStorage<{ panelId: string; signal?: AbortSignal }>();

/** 工具执行的入口包一层 */
export function runAsPanel<T>(panelId: string, fn: () => T, signal?: AbortSignal): T {
  const effectiveSignal = signal ?? whoAmI.getStore()?.signal;
  return panelId || effectiveSignal ? whoAmI.run({ panelId, signal: effectiveSignal }, fn) : fn();
}

export function currentPanelSignal(): AbortSignal | undefined {
  return whoAmI.getStore()?.signal;
}

export function assertPanelActive(): void {
  currentPanelSignal()?.throwIfAborted();
}

/** 此刻这个会话开没开完全权限。**界面自己发起的读写**（文件树、编辑器）没有会话上下文，一律按工作区算 */
export function isUnconfined(): boolean {
  const me = whoAmI.getStore();
  if (!me || !me.panelId) return false;
  return unconfinedOf(me.panelId);
}

export function setWorkspaceRoot(dir: string, opts: { trust?: boolean } = {}) {
  if (!dir) return ROOT; // 空的不算"换工作区"，更不能把已经有的那个顶掉
  const abs = path.resolve(dir);
  let err: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      if (fs.statSync(abs).isDirectory()) {
        ROOT = abs;
        return ROOT;
      }
      console.error('[工作区] 那不是个目录，保持原样：', abs);
      return ROOT;
    } catch (e) {
      // Windows：杀毒/索引器会短暂锁住目录，网络盘也可能还没就绪 —— 再问一次
      err = e;
    }
  }
  if (opts.trust) {
    // 人刚在系统目录对话框里挑过（或点过"最近开过"）：这个路径是真的。
    // 宁可先用上 —— 否则 store 记下了、标题栏显示着，ROOT 却没换过去，
    // 界面就成了"我明明选了工作区"还说没选。真读不了的时候
    // fs:list / fs:read 会报出带路径的真错，比这句谎话有用。
    console.warn('[工作区] stat 问不出来，按传进来的目录直接用：', abs, err);
    ROOT = abs;
  } else {
    // 静默失败就是"分裂状态"的来源，至少得留下可查的线索
    console.error('[工作区] 目录打不开，保持原样：', abs, err);
  }
  return ROOT;
}

export function workspaceRoot(): string {
  return ROOT;
}

/**
 * 面板私有空间：`.ensoul/panels/<面板 id>/`。
 *
 * 为什么按面板分开：这里放的是**这个面板自己跑出来的临时产物**（见 agent.ts 的 spill ——
 * 一次构建几万字的输出落在里面）。混在一个平铺目录里，等于任何面板都能
 * `list_dir .ensoul/spill` 读到别的面板跑过什么命令、输出长什么样。
 * 面板之间默认互不相干，要连就走显式的通道，而不是"文件恰好放在一起"。
 */
export function panelSpaceDir(panelId: string): string {
  const id = String(panelId || "").replace(/[^\w.-]+/g, "_");
  // 只留字符，不留分隔符 —— 但 '.' 和 '..' 必须单独挡：
  // path.join('.ensoul', 'panels', '..') 正好是 .ensoul 本身。
  if (!id || id === "." || id === "..") return "";
  return path.join('.ensoul', 'panels', id);
}

/**
 * 面板**真删**时把它私有的临时产物一起收掉。
 *
 * 只在"记录真的没了"（收纳区删条目 / 彻底忘掉最近关闭）时才调：关面板不是删 ——
 * closePanel 是"放回它的家"，stowPanel 也不消费条目，那些时候这里一个字都不动。
 * 收不掉也不抛：清理失败绝不能把"删面板"变成删不掉。
 */
export function dropPanelSpace(panelId: string): void {
  const rel = panelSpaceDir(panelId);
  if (!rel || !ROOT) return;
  try {
    const base = path.join(ROOT, ".ensoul", "panels");
    const abs = path.resolve(ROOT, rel);
    // 下面一个是递归删：落点但凡不是 panels 底下的那一层，宁可什么都不删，
    // 也不能像 ".." 那样把整个 .ensoul（state、backups 全在里面）端掉。
    if (!abs.startsWith(base + path.sep)) return;
    fs.rmSync(abs, { recursive: true, force: true });
  } catch (e: any) {
    console.error('[面板空间] 清理失败（不影响面板本身）：', e?.message ?? e);
  }
}

export function safePath(rel: string): string {
  if (isUnconfined()) return path.resolve(ROOT, rel || '.');
  if (!ROOT) throw new Error(t('还没选工作区：点左上角「选工作区」挑一个目录'));
  const abs = path.resolve(ROOT, rel || '.');
  const checked = process.platform === 'win32' ? abs.toLowerCase() : abs;
  const boundary = process.platform === 'win32' ? ROOT.toLowerCase() : ROOT;
  if (checked !== boundary && !checked.startsWith(boundary + path.sep)) {
    throw new Error(`越出工作区：${rel}（要跨出去，就在设置 → 通用 里打开"完全权限"）`);
  }
  return abs;
}

const safe = safePath;

export interface DirEntry {
  name: string;
  dir: boolean;
  path: string;
  size: number;
}

export function listDir(rel = '.'): DirEntry[] {
  const abs = safe(rel);
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((d) => !SKIP.has(d.name))
    .map((d) => {
      const full = path.join(abs, d.name);
      let size = 0;
      try {
        size = d.isDirectory() ? 0 : fs.statSync(full).size;
      } catch {
        size = 0;
      }
      return { name: d.name, dir: d.isDirectory(), path: path.relative(ROOT, full).split(path.sep).join('/'), size };
    })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'zh'));
}

export function readText(rel: string, maxBytes = 300_000, observe = false): string {
  const abs = safe(rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) return '';
  if (st.size > maxBytes) return `（这个文件有 ${Math.round(st.size / 1024)} KB，先不整个读进来）`;
  const raw = fs.readFileSync(abs);
  // 二进制就只说一句，别把乱码灌进面板
  if (raw.subarray(0, 8000).includes(0)) return `（二进制文件，${Math.round(st.size / 1024)} KB）`;
  if (observe) fileWrites.observe(abs, raw, whoAmI.getStore()?.panelId || '');
  return raw.toString('utf8');
}

export function readJsonSnapshot(rel: string): JsonSnapshot {
  const limit = 300_000;
  let raw: Buffer;
  try {
    const abs = safe(rel);
    const stat = fs.statSync(abs);
    if (stat.size > limit) return { status: 'too_large', bytes: stat.size, limit };
    raw = fs.readFileSync(abs);
    if (raw.length > limit) return { status: 'too_large', bytes: raw.length, limit };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    return { status: 'error', error: String((error as Error).message) };
  }
  try {
    return { status: 'ready', data: JSON.parse(raw.toString('utf8')) as unknown };
  } catch (error) {
    return { status: 'invalid', error: String((error as Error).message) };
  }
}

/**
 * 写回文件 —— 编辑器保存用（助手新建文件也走这里）。路径同样夹在工作区里。
 *
 * 缺的父目录在这里补上：不补的话，写 `plugins/history/index.js` 这种还不存在的路径
 * 只会得到一句 ENOENT —— 工具说明写着"新建文件也用这个"，实际却只能在别人已经
 * 建好的目录里写。file-backup / jobs 给自己的落盘早就是这么干的。
 */
export function writeText(rel: string, text: string) {
  assertPanelActive();
  const abs = safe(rel);
  fileWrites.write(abs, Buffer.from(text, 'utf8'), true);
  return true;
}

/**
 * 写**二进制**回文件 —— 装扩展包用。
 *
 * 插件包里可能有 png、字体、wasm 这类东西，走 writeText 那句 'utf8' 会把它们
 * 毁掉（而且毁得很安静：写是成功了，文件是坏的）。所以另开一个口子，而不是给
 * writeText 加个参数 —— 那个口子是编辑器和助手在用的，语义不该跟着变。
 *
 * 路径照样夹在工作区里。调用方（ext:installPack）已经把包里的每个条目名净化过
 * 一遍，这里是第二道；两道都在，是因为"能往任意位置写文件"这件事的代价太大。
 */
export function writeBytes(rel: string, data: Buffer): boolean {
  assertPanelActive();
  const abs = safe(rel);
  fileWrites.write(abs, data, false);
  return true;
}
