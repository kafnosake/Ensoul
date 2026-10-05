import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export type BuildTarget = 'full' | 'renderer';
export type BuildScope = 'workspace' | 'app';
export type BuildResult = { ok: boolean; out: string; reused?: boolean };

export class BuildCoordinator {
  private queue: Promise<unknown> = Promise.resolve();
  private completed = new Map<BuildTarget, { key: string; output: string }>();

  constructor(
    private input: (target: BuildTarget) => string,
    private output: (target: BuildTarget) => string,
    private execute: (target: BuildTarget) => Promise<BuildResult>,
  ) {}

  run(target: BuildTarget): Promise<BuildResult> {
    const operation = this.queue.then(async () => {
      const key = this.input(target);
      const cached = this.completed.get(target);
      if (cached?.key === key && cached.output === this.output(target)) {
        return { ok: true, reused: true, out: '复用同一源码版本已通过的构建。' };
      }
      const result = await this.execute(target);
      if (!result.ok) return result;
      if (key !== this.input(target)) {
        return { ok: false, out: `${result.out}\n构建期间源码又发生变化，请等待写入结束后重新构建。` };
      }
      this.completed.set(target, { key, output: this.output(target) });
      if (target === 'full') {
        this.completed.set('renderer', { key: this.input('renderer'), output: this.output('renderer') });
      }
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

export function buildInput(root: string, target: BuildTarget): string {
  const dirs = target === 'full' ? ['src', 'plugins', 'assets'] : ['src/renderer', 'src/shared', 'plugins', 'assets'];
  return fingerprint(root, dirs, true, ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.main.json', 'vite.config.ts', 'index.html', 'scripts/check-types.js', 'scripts/type-baseline.json']);
}

export function buildOutput(root: string, target: BuildTarget): string {
  return fingerprint(root, target === 'full' ? ['dist/main', 'dist/preload', 'dist/shared', 'dist/renderer'] : ['dist/renderer']);
}

function fingerprint(root: string, dirs: string[], source = false, files: string[] = []): string {
  const hash = createHash('sha256').update(path.resolve(root));
  const add = (relative: string) => {
    const file = path.join(root, relative);
    hash.update(relative);
    hash.update(fs.readFileSync(file));
  };
  const walk = (relative: string) => {
    const dir = path.join(root, relative);
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        if (source && child.startsWith('plugins/') && /^plugins\/[^/]+\/index\.js$/.test(child)) continue;
        add(child);
      }
    }
  };
  for (const dir of dirs) walk(dir);
  for (const file of files) if (fs.existsSync(path.join(root, file))) add(file);
  return hash.digest('hex');
}
