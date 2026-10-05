import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

/**
 * 原子写与写者串行 —— 让「读的人要么看到旧内容、要么看到新内容」落地的两件事。
 *
 * 两件事：
 *   writeFileAtomicSync  随机后缀临时文件 + 独占创建（wx）+ rename 覆盖。读的人要么看到旧内容、
 *                        要么看到新内容，不会看到半截。
 *   withFileLockSync     同目录下 `<文件>.lock` 独占创建，把跨进程的读—改—写串起来，
 *                        免得两个写者互相盖掉对方刚提交的状态。
 *
 * 为什么不能继续直接 writeFileSync 覆盖：providers.json 是主进程和插件一起写的，
 * 写一半被读到、或者两边同时读—改—写，就会丢配置。
 */

/** Windows 上杀毒 / 索引器会短暂锁住目标文件，rename 会被顶回来 —— 退避重试几次 */
const TRANSIENT_RENAME = new Set(['EACCES', 'EBUSY', 'EPERM']);
const RENAME_RETRY_LIMIT = 8;
const RENAME_RETRY_MAX_MS = 200;

/**
 * 同步睡一会儿。
 *
 * 不能用 await —— 这几个函数必须是**同步**的（providers 的 save / upsert / remove 都是同步调用，
 * 改成 async 会把整条调用链掀掉）。Atomics.wait 是同步 API 里唯一不烧 CPU 的睡法。
 */
function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function renameIntoPlace(temp: string, target: string): void {
  let delay = 20;
  for (let i = 0; ; i += 1) {
    try {
      fs.renameSync(temp, target);
      return;
    } catch (e: any) {
      if (process.platform !== 'win32' || !TRANSIENT_RENAME.has(e?.code ?? '')) throw e;
      if (i >= RENAME_RETRY_LIMIT) throw e;
    }
    sleepSync(delay);
    delay = Math.min(delay * 2, RENAME_RETRY_MAX_MS);
  }
}

/**
 * 一步换掉 file 的内容。
 *
 * 先写同目录的随机后缀兄弟（wx 独占创建 —— 有人在这个名字上摆了符号链接也顶不回去），
 * 再用 rename 覆盖目标：同一个目录保证在同一个文件系统上，rename 才是原子的。
 * mode 跟着新 inode 走，所以把一份权限更宽的文件换窄，中间没有 chmod 的空档。
 */
export function writeFileAtomicSync(
  file: string,
  content: string,
  options: { mode?: number } = {},
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    if (options.mode === undefined) fs.writeFileSync(temp, content, { flag: 'wx', encoding: 'utf8' });
    else fs.writeFileSync(temp, content, { flag: 'wx', encoding: 'utf8', mode: options.mode });
    renameIntoPlace(temp, file);
  } catch (e) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* 临时文件没清掉，不改变这次失败的性质 */
    }
    throw e;
  }
}

/**
 * 独占创建（wx）撞上已有的锁 —— 就是别人正拿着。
 * EPERM 要再看一眼文件到底在不在：那是 Windows 独占创建的行为，不能把无关的权限失败也当成争用。
 */
function isContention(e: any, lockPath: string): boolean {
  const code = e?.code;
  if (code === 'EEXIST') return true;
  if (code !== 'EPERM') return false;
  try {
    fs.lstatSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

const LOCK_RETRY_INITIAL_MS = 20;
const LOCK_RETRY_MAX_MS = 200;
const DEFAULT_LOCK_WAIT_MS = 3000;

/**
 * 拿着 file 的写锁跑完一段读—改—写。
 *
 * 锁是 `<文件>.lock` 这个独占创建出来的兄弟文件 —— 配上 rename 提交，读者永远不用加锁，
 * 只有写者互相排队（这正是两个插件同时改 providers.json 需要的）。
 * 抢不到就指数退避重试，过了 deadline 抛错。
 *
 * **不清理别人的锁**：文件多老都不能证明它的主人已经停了，删掉会放进第二个写者，
 * 反而制造出这把锁本来要防的那种并发。孤儿锁由超时兜着 —— 调用方拿到超时错误自己决定怎么退
 * （providers 那边退成直接写：宁可冒着并发，也不能让用户丢配置）。
 */
export function withFileLockSync<T>(
  file: string,
  operation: () => T,
  options: { waitMs?: number } = {},
): T {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + (options.waitMs ?? DEFAULT_LOCK_WAIT_MS);
  let delay = LOCK_RETRY_INITIAL_MS;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, `${process.pid}`, { flag: 'wx', mode: 0o600 });
      break;
    } catch (e: any) {
      if (!isContention(e, lockPath)) throw e;
    }
    if (Date.now() >= deadline) throw new Error(`原子写：等 ${lockPath} 这把写锁超时了`);
    sleepSync(delay);
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
  }
  try {
    return operation();
  } finally {
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      /* 锁没删掉会挡住下一个写者到超时为止，但不该把 operation 的结果吃掉 */
    }
  }
}