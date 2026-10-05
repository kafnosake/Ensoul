import * as fs from 'fs';
import { userDataPath } from './paths';
import { writeFileAtomicSync, withFileLockSync } from './atomic-write';

/**
 * 凭据库 —— 密钥单独住一个文件（`%APPDATA%\ensoul\credentials.json`），
 * 里面**只有密钥**，别的一个字都没有。配置和凭据本来就该分开住：
 * 提供方配置（地址、模型目录、显示名）是配置，密钥是凭据，两者本来就该分开存 ——
 * 混在一起的结果是「想分享配置就把密钥一起发出去了」，也分不清哪份文件该加密。
 *
 * 三层取值，从高到低：
 *   1. 进程环境变量 `ENSOUL_KEY_<提供方 key 大写>`  —— 临时换一把、或在别处跑时注入
 *   2. credentials.json
 *   3. 没有（= 这个提供方还没配密钥）
 *
 * 写入走原子写 + 跨进程文件锁（见 atomic-write.ts）。
 */

const FILE = () => userDataPath('credentials.json');
export const credentialsPath = () => FILE();

interface CredFile {
  version: number;
  keys: Record<string, string>;
}

let cache: Record<string, string> | null = null;
/** 这份缓存照着**哪个版本的文件**算出来的（mtime+size）—— 文件被外面改了就作废 */
let cacheStamp = '';

function fileStamp(): string {
  try {
    const s = fs.statSync(FILE());
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '';
  }
}

/** 提供方 key（`deepseek`、`p-mud9030z`）→ 环境变量名（`ENSOUL_KEY_DEEPSEEK`） */
function envNameOf(providerKey: string): string {
  return `ENSOUL_KEY_${String(providerKey || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/** 文件里那份（不含环境变量层）。读坏了当作空 —— 不能拿一份坏的当"用户把密钥删了" */
function readFile(): Record<string, string> {
  const stamp = fileStamp();
  if (cache && stamp && stamp === cacheStamp) return cache;
  let keys: Record<string, string> = {};
  try {
    if (fs.existsSync(FILE())) {
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      const src = raw?.keys;
      if (src && typeof src === 'object') {
        for (const [k, v] of Object.entries(src)) {
          if (typeof v === 'string' && v) keys[k] = v;
        }
      }
    }
  } catch (e) {
    console.error('[凭据] 读取失败：', e);
    return {};
  }
  cache = keys;
  cacheStamp = stamp;
  return keys;
}

/** 此刻生效的那把钥匙：环境变量优先，其次文件 */
export function keyOf(providerKey: string): string {
  const env = process.env[envNameOf(providerKey)];
  if (typeof env === 'string' && env.trim()) return env.trim();
  return readFile()[providerKey] ?? '';
}

/** 这一条现在有没有钥匙（环境变量也算）—— 界面上的 hasKey 用它 */
export function hasKey(providerKey: string): boolean {
  return Boolean(keyOf(providerKey));
}

/**
 * 落盘。
 *
 * 进来的是**整份**密钥表（key → 密钥），空串表示删掉这一条。
 * 写之前先拿锁：主进程和插件会同时改这个文件，不串起来就会互相盖。
 * 拿不到锁（孤儿锁超时）也照样写 —— 宁可冒并发的险，也不能让用户这次改的密钥丢掉。
 */
export function writeAll(keys: Record<string, string>): void {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(keys)) {
    if (typeof v === 'string' && v && k) clean[k] = v;
  }
  const text = JSON.stringify({ version: 1, keys: clean }, null, 2);
  const put = () => {
    writeFileAtomicSync(FILE(), text, { mode: 0o600 });
    cache = clean;
    cacheStamp = fileStamp();
  };
  try {
    withFileLockSync(FILE(), put);
  } catch (e: any) {
    console.error('[凭据] 没拿到写锁，仍然直接写：', e?.message ?? e);
    try {
      put();
    } catch (e2: any) {
      console.error('[凭据] 保存失败：', e2?.message ?? e2);
    }
  }
}

/** 改一条（空串 = 删掉）。读—改—写在锁里做，免得和别人的那次改动互相盖 */
export function setKey(providerKey: string, value: string): void {
  const key = String(providerKey || '');
  if (!key) return;
  const next = { ...readFile() };
  const v = String(value ?? '');
  if (v) next[key] = v;
  else delete next[key];
  writeAll(next);
}

/** 把一批从别处（旧版 providers.json）翻出来的密钥并进来，返回真的动了没有 */
export function mergeIn(keys: Record<string, string>): boolean {
  const cur = readFile();
  let changed = false;
  for (const [k, v] of Object.entries(keys)) {
    if (v && !cur[k]) {
      cur[k] = v;
      changed = true;
    }
  }
  if (changed) writeAll(cur);
  return changed;
}

/** 此刻文件里那份（不含环境变量层）—— 迁移时要拿它去比 */
export function fileKeys(): Record<string, string> {
  return { ...readFile() };
}