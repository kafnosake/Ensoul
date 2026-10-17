import * as fs from 'fs';
import { userDataPath } from './paths';
import { readTextFile } from './chat-core';
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

/** 已经留过底的那一版（mtime+size）—— 同一份坏文件不重复留 */
let quarantined = '';

/**
 * 读不动的那份先原样留一个 `.corrupt-<时间戳>` 兄弟，再当空处理。
 *
 * 为什么非留不可：这份文件被读坏之后，只要有人写一次（插件登记自己那把密钥就够），
 * 就会拿"空表 + 这一把"把整份盖掉 —— 用户原来那批密钥就此永久消失。
 * 只报一句 ["读取失败"] 是拦不住这次覆写的，得让坏的那份先落到盘上。
 */
function quarantineCorrupt(): void {
  try {
    const stamp = fileStamp();
    if (!stamp || stamp === quarantined) return;
    const dest = `${FILE()}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(FILE(), dest);
    quarantined = stamp;
    console.error(`[凭据] 这份读不动，已原样留底：${dest}`);
  } catch (e) {
    console.error('[凭据] 读坏了，留底也没成功：', e);
  }
}

/** 文件里那份（不含环境变量层）。读坏了当作空，但会先留底（见 quarantineCorrupt） */
function readFile(): Record<string, string> {
  const stamp = fileStamp();
  if (cache && stamp && stamp === cacheStamp) return cache;
  let keys: Record<string, string> = {};
  try {
    if (fs.existsSync(FILE())) {
      /**
       * 走 readTextFile 而不是裸 readFileSync：PowerShell / 记事本存过的 JSON 带 UTF-8 BOM，
       * `JSON.parse` 会直接抛。这里一旦抛，整批密钥就被当空 —— 接着下一次写把它们全盖掉。
       * providers.json 一直走的是这个剥 BOM 的读法，凭据这边漏了，是真实丢过数据的口子。
       */
      const raw = JSON.parse(readTextFile(FILE()));
      const src = raw?.keys;
      if (src && typeof src === 'object') {
        for (const [k, v] of Object.entries(src)) {
          if (typeof v === 'string' && v) keys[k] = v;
        }
      }
    }
  } catch (e) {
    quarantineCorrupt();
    console.error('[凭据] 读取失败（已留底）：', e);
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