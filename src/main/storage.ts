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

interface MigratedSource {
  digest: string;
  destination: string;
  target: string;
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

export function migrateRuntimeData(workspace: string): MigrationReport {
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

  const migrateFile = (source: string, logical: string, key: string, legacy = false) => {
    try {
      const bytes = fs.readFileSync(source);
      const fingerprint = digest(bytes);
      const sourceLedger = legacy ? globalLedger : ledger;
      const sourceLedgerFile = legacy ? globalLedgerFile : ledgerFile;
      const destination = legacy ? path.join(dataRoot(), logical) : runtimePath(logical, absoluteWorkspace);
      if (path.resolve(source) === path.resolve(destination)) { report.skipped.push(source); return; }
      if (sourceLedger[key]?.digest === fingerprint && sourceLedger[key]?.destination === destination) {
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
      sourceLedger[key] = { digest: fingerprint, destination, target };
      let pending = pendingLedgers.get(sourceLedgerFile);
      if (!pending) pendingLedgers.set(sourceLedgerFile, pending = { value: sourceLedger, count: 0 });
      if (++pending.count >= 256) {
        writeJson(sourceLedgerFile, sourceLedger);
        pending.count = 0;
      }
      report[kind].push({ source, target });
    } catch (error) {
      report.errors.push({ source, error: String((error as Error).message) });
    }
  };

  const visit = (dir: string, logical: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const source = path.join(dir, entry.name);
      const relative = logical + '/' + entry.name;
      if (workspacePaths(absoluteWorkspace).some(scope => inScope(relative, scope)) || relative === '.ensoul/migrations') continue;
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
      if (entry.isDirectory()) visit(source, relative);
      else if (entry.isFile()) migrateFile(source, relative, relative);
    }
  };
  if (absoluteWorkspace) visit(path.join(absoluteWorkspace, '.ensoul'), '.ensoul');
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
