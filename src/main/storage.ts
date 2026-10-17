import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { userDataDir } from './paths';

type StorageScopes = Map<string, Map<string, string[]>>;
const projectScopes: StorageScopes = new Map();
const workspaceScopes: StorageScopes = new Map([['*', new Map([['extensions', ['.ensoul/plugins', '.ensoul/skills']]])]]);

function scopeKey(workspace?: string): string {
  return workspace === undefined ? '*' : workspace ? normalizedWorkspace(workspace) : '';
}

function scopedPaths(registry: StorageScopes, workspace = ''): string[] {
  return [...(registry.get('*')?.values() || []), ...(registry.get(scopeKey(workspace))?.values() || [])].flat();
}

function workspacePaths(workspace = ''): string[] {
  return scopedPaths(workspaceScopes, workspace);
}

function setScopes(registry: StorageScopes, owner: string, scopes: string[], workspace?: string): void {
  const key = scopeKey(workspace);
  let owners = registry.get(key);
  if (!owners) registry.set(key, owners = new Map());
  owners.set(String(owner), scopes);
}

export function logicalRuntimePath(rel: string): string {
  const value = String(rel || '').replace(/\\/g, '/');
  const parts = value.split('/').filter(part => part !== '' && part !== '.');
  if (path.isAbsolute(value) || /^[a-z]:/i.test(value) || value.startsWith('/') || parts.some(part => part === '..' || part.includes(':') || part.includes('\0')) || parts[0] !== '.ensoul') {
    throw new Error(`无效的应用数据路径：${rel}`);
  }
  return parts.join('/');
}

export function isRuntimePath(rel: string): boolean {
  const value = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return value === '.ensoul' || value.startsWith('.ensoul/');
}

function inScope(rel: string, scope: string): boolean {
  return rel === scope || rel.startsWith(scope + '/') || rel === scope + '.bak';
}

function normalizedWorkspace(workspace: string): string {
  if (!workspace) throw new Error('项目数据需要明确的工作区');
  const absolute = path.resolve(workspace);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function workspaceId(workspace: string): string {
  return createHash('sha256').update(normalizedWorkspace(workspace)).digest('hex').slice(0, 24);
}

function dataRoot(): string {
  const root = userDataDir();
  if (!root) throw new Error('应用数据目录不可用');
  return root;
}

export function registerProjectStorage(owner: string, paths: string[], workspace?: string): void {
  const scopes = paths.map(logicalRuntimePath);
  if (scopes.some(scope => scope === '.ensoul' || workspacePaths(workspace).some(item => inScope(scope, item)))) {
    throw new Error(`项目状态声明不能覆盖项目扩展目录：${owner}`);
  }
  setScopes(projectScopes, owner, scopes, workspace);
}

export function registerWorkspaceStorage(owner: string, paths: string[], workspace?: string): void {
  const scopes = paths.map(logicalRuntimePath);
  if (scopes.includes('.ensoul')) throw new Error(`工作区配置不能覆盖全部应用数据：${owner}`);
  setScopes(workspaceScopes, owner, scopes, workspace);
}

export function clearStorageRegistrations(ownerPrefix: string, workspace: string): void {
  for (const registry of [projectScopes, workspaceScopes]) {
    const owners = registry.get(scopeKey(workspace));
    if (!owners) continue;
    for (const owner of owners.keys()) if (owner.startsWith(ownerPrefix)) owners.delete(owner);
  }
}

export function projectDataPath(rel: string, workspace: string): string {
  const logical = logicalRuntimePath(rel);
  const project = path.join(dataRoot(), 'projects', workspaceId(workspace));
  const mapping = path.join(project, 'workspace.json');
  if (!fs.existsSync(mapping)) {
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(mapping, JSON.stringify({ workspace: path.resolve(workspace) }, null, 2), { flag: 'wx' });
  }
  return path.join(project, logical);
}

export function runtimePath(rel: string, workspace = ''): string {
  const logical = logicalRuntimePath(rel);
  if (workspacePaths(workspace).some(scope => inScope(logical, scope))) {
    normalizedWorkspace(workspace);
    return path.join(path.resolve(workspace), logical);
  }
  if (scopedPaths(projectScopes, workspace).some(scope => inScope(logical, scope))) {
    return projectDataPath(logical, workspace);
  }
  return path.join(dataRoot(), logical);
}

export interface MigrationFile {
  source: string;
  target: string;
}

export interface MigrationReport {
  workspace: string;
  copied: MigrationFile[];
  conflicts: MigrationFile[];
  archivedCommands: MigrationFile[];
  archivedLinks: MigrationFile[];
  skipped: string[];
  errors: Array<{ source: string; error: string }>;
  reportFile: string;
}

/**
 * 不参与迁移的目录：**插件自己管的运行时产物**，不是应用状态。
 *
 * 为什么必须排除（真踩出来的）：`.ensoul/runtime` 是语义搜索的 Python 环境 + 模型
 * ——3.8 万个文件、3.1 GB，占这个工作区 `.ensoul` 的 **81% 文件数**。它早就整份搬进
 * 应用数据根了（见 plugins/semantic-search/runtime.js：运行时用的是 userData 那份），
 * 工作区里这份是重构前的遗留副本，2026-10-07 之后再没动过。可原来的迁移每次开机
 * 还是要把它按文件 stat（快路）或读+哈希（第一次）走一遍 —— 光这一棵树就让开机
 * 多花几十秒，主进程被钉住的时候窗口拿不到首帧，界面上就是一块黑屏。
 *
 * 换句话说：这是"要给用户搬的应用状态"和"插件自己造的可再生数据"之间的分界，
 * 后者不该进迁移账本，也不该占开机时间。
 */
const MIGRATION_EXCLUDED = ['.ensoul/runtime'];

interface MigratedSource {
  digest: string;
  destination: string;
  target: string;
  /**
   * 迁移那一刻源文件的**大小**与**修改时间**。
   *
   * 记它们是为了下一次开机不必再读一遍文件：大小和 mtime 都没动过，就没有理由
   * 再把整个文件读进来算 sha256（见 migrateFile 里"便宜的那条路"）。
   * 老账本里没有这两个字段，所以是可选 —— 第一次跑还是会走一遍完整校验，之后就走快路。
   */
  size?: number;
  mtimeMs?: number;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

/**
 * 让出一轮事件循环。
 *
 * 迁移是"按文件比对几万个文件"的活（这个工作区 4.7 万个、3.5 GB）。同步跑一趟，
 * 主进程唯一的这条事件循环就被钉死几十秒 —— 窗口在这期间**画不出首帧**
 * （Chromium 要主进程配合提交导航），界面上就是一块黑屏。让出之后：迁移照旧
 * 在插件之前跑完（顺序不变），但界面能在这期间把壳画出来。
 */
const breathe = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * 同一个工作区同一时刻只跑一趟。
 *
 * 调用点有好几个（开机、换工作区、loadPlugins 的兜底），并发跑两趟会让两边
 * 同时写那本 25 MB 的账本、互相盖掉刚提交的部分。
 */
const migrationInFlight = new Map<string, Promise<MigrationReport>>();

export function migrateRuntimeData(workspace: string): Promise<MigrationReport> {
  const key = workspace ? normalizedWorkspace(workspace) : 'unassigned';
  const running = migrationInFlight.get(key);
  if (running) return running;
  const task = runMigration(workspace).finally(() => migrationInFlight.delete(key));
  migrationInFlight.set(key, task);
  return task;
}

async function runMigration(workspace: string): Promise<MigrationReport> {
  const absoluteWorkspace = workspace ? path.resolve(workspace) : '';
  const migrationRoot = path.join(dataRoot(), '.ensoul', 'migrations', workspace ? workspaceId(workspace) : 'unassigned');
  const ledgerFile = path.join(migrationRoot, 'sources.json');
  const globalLedgerFile = path.join(dataRoot(), '.ensoul', 'migrations', 'legacy-global', 'sources.json');
  let ledger: Record<string, MigratedSource> = {};
  let globalLedger: Record<string, MigratedSource> = {};
  if (fs.existsSync(ledgerFile)) ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  if (fs.existsSync(globalLedgerFile)) globalLedger = JSON.parse(fs.readFileSync(globalLedgerFile, 'utf8'));
  const report: MigrationReport = { workspace: absoluteWorkspace, copied: [], conflicts: [], archivedCommands: [], archivedLinks: [], skipped: [], errors: [], reportFile: path.join(migrationRoot, 'report.json') };
  const pendingLedgers = new Map<string, { value: Record<string, MigratedSource>; count: number }>();

  /**
   * 记账；攒够一批才落一次盘。
   *
   * 为什么批量要大一点：账本里是**每一个迁移过的文件**一条，这个工作区有 4.7 万条、
   * 25 MB —— 每 256 个文件就 stringify 一遍整本账，一次开机就是 180 次、几十秒，
   * 全耗在主进程唯一的这条事件循环上。改大之后一次开机最多写十几次。
   * 崩溃最多丢一批，下次开机重扫一遍就补上了。
   */
  const LEDGER_BATCH = 2048;
  const noteLedger = (file: string, value: Record<string, MigratedSource>) => {
    let pending = pendingLedgers.get(file);
    if (!pending) pendingLedgers.set(file, pending = { value, count: 0 });
    if (++pending.count >= LEDGER_BATCH) {
      writeJson(file, value);
      pending.count = 0;
    }
  };

  const migrateFile = (source: string, logical: string, key: string, legacy = false) => {
    try {
      const stat = fs.statSync(source);
      const sourceLedger = legacy ? globalLedger : ledger;
      const sourceLedgerFile = legacy ? globalLedgerFile : ledgerFile;
      const destination = legacy ? path.join(dataRoot(), logical) : runtimePath(logical, absoluteWorkspace);
      if (path.resolve(source) === path.resolve(destination)) { report.skipped.push(source); return; }
      const known = sourceLedger[key];
      /*
       * ── 便宜的那条路：**没动过的文件不读、不哈希** ─────────────────────────
       *
       * 为什么非要有这一条（真踩出来的）：工作区的 .ensoul 是 4.7 万个文件、3.5 GB，
       * 光语义搜索的 Python 环境和模型就 3.1 GB。原来的写法是**每个文件都**
       * readFileSync + sha256 一遍，主进程在开机时被钉死一百多秒：窗口建不出来、
       * 建出来也拿不到首帧，界面上就是一块黑屏（Chromium 新版会把这次被打断的首帧
       * 导航直接掐掉，而掐掉之后没人重试 —— 只剩背景色）。
       *
       * 判据用大小 + mtime（毫秒）+ 目标还在：三个都对上就认定"这一个迁移过、也没再动过"。
       * 代价是"同一毫秒内改成同样大小"的极端情况会漏判一次 —— 对这种迁移来说可以接受，
       * 换来的是开机从"读 3.5 GB"变成"stat 4.7 万个文件"。
       */
      if (known && known.destination === destination && typeof known.size === 'number' && typeof known.mtimeMs === 'number') {
        if (stat.size === known.size && stat.mtimeMs === known.mtimeMs && fs.existsSync(known.target)) {
          report.skipped.push(source);
          return;
        }
      }
      const bytes = fs.readFileSync(source);
      const fingerprint = digest(bytes);
      if (known?.digest === fingerprint && known?.destination === destination) {
        /*
         * 内容没变，只是 mtime 被摸过（复制、还原、杀毒软件扫描都会这样）：
         * 把新的 stat 补进账本，下一次就走上面那条便宜的路，不再读它。
         */
        known.size = stat.size;
        known.mtimeMs = stat.mtimeMs;
        noteLedger(sourceLedgerFile, sourceLedger);
        report.skipped.push(source);
        return;
      }
      let target = destination;
      let kind: 'copied' | 'conflicts' | 'archivedCommands' = 'copied';
      if (/\.cmd\.json(?:\.bak)?$/i.test(logical)) {
        target = path.join(migrationRoot, 'commands', logical, fingerprint.slice(0, 16) + '.json');
        kind = 'archivedCommands';
      } else if ((sourceLedger[key]?.destination === destination && !fs.existsSync(destination)) ||
        (fs.existsSync(destination) && digest(fs.readFileSync(destination)) !== fingerprint)) {
        target = path.join(migrationRoot, 'conflicts', logical + '.' + fingerprint.slice(0, 16));
        kind = 'conflicts';
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      if (digest(fs.readFileSync(target)) !== fingerprint) throw new Error('复制后的内容校验失败');
      sourceLedger[key] = { digest: fingerprint, destination, target, size: stat.size, mtimeMs: stat.mtimeMs };
      noteLedger(sourceLedgerFile, sourceLedger);
      report[kind].push({ source, target });
    } catch (error) {
      report.errors.push({ source, error: String((error as Error).message) });
    }
  };

  let seen = 0;
  const visit = async (dir: string, logical: string): Promise<void> => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const source = path.join(dir, entry.name);
      const relative = logical + '/' + entry.name;
      if (workspacePaths(absoluteWorkspace).some(scope => inScope(relative, scope)) || relative === '.ensoul/migrations') continue;
      if (MIGRATION_EXCLUDED.some(prefix => inScope(relative, prefix))) continue;
      if (entry.isSymbolicLink()) {
        if (fs.existsSync(source)) report.errors.push({ source, error: '符号链接未迁移，请检查原目标' });
        else {
          try {
            const target = path.join(migrationRoot, 'links', relative + '.json');
            writeJson(target, { source, target: fs.readlinkSync(source) });
            report.archivedLinks.push({ source, target });
          } catch (error) { report.errors.push({ source, error: String((error as Error).message) }); }
        }
        continue;
      }
      if (entry.isDirectory()) await visit(source, relative);
      else if (entry.isFile()) migrateFile(source, relative, relative);
      // 让出的粒度按"这片要跑多久"定：这台机器上一次 stat 约 0.4 ms，
      // 16 个条目一片 ≈ 十几毫秒 —— 主进程始终能抽身去伺候 IPC 和首帧。
      // （实测再加密到 4 个一片，首帧并不会更快，反而把迁移本身拖长，所以停在 16。）
      if ((++seen & 0x0f) === 0) await breathe();
    }
  };
  if (absoluteWorkspace) await visit(path.join(absoluteWorkspace, '.ensoul'), '.ensoul');
  const legacyGlobal = path.join(dataRoot(), 'plugin-state');
  if (fs.existsSync(legacyGlobal)) {
    for (const entry of fs.readdirSync(legacyGlobal, { withFileTypes: true })) {
      if (entry.isFile()) migrateFile(path.join(legacyGlobal, entry.name), '.ensoul/state/' + entry.name, entry.name, true);
    }
  }
  for (const [file, pending] of pendingLedgers) {
    if (!pending.count) continue;
    try { writeJson(file, pending.value); }
    catch (error) { report.errors.push({ source: file, error: String((error as Error).message) }); }
  }
  let previous: Partial<MigrationReport> = {};
  if (fs.existsSync(report.reportFile)) previous = JSON.parse(fs.readFileSync(report.reportFile, 'utf8'));
  const history = { ...report };
  for (const kind of ['copied', 'conflicts', 'archivedCommands', 'archivedLinks'] as const) {
    const files = new Map<string, MigrationFile>();
    for (const file of [...(previous[kind] || []), ...report[kind]]) files.set(file.source + '\0' + file.target, file);
    history[kind] = [...files.values()];
  }
  writeJson(report.reportFile, history);
  return report;
}
