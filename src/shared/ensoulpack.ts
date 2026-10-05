import * as zlib from 'zlib';
import { createHash } from 'crypto';
import { t } from './i18n';

/**
 * .ensoulpack 容器：**造包、解包、以及"这个包能不能装"**。
 *
 * 三块职责放同一个文件，因为它们共用同一份格式定义（zip 条目 + manifest）——
 * 拆开会立刻出现两处"条目名怎么算合法"的说法。
 *
 * ── 为什么只有主进程能碰它 ────────────────────────────────────────────
 * 从前这份是 .js，渲染层 `await import('../../shared/ensoulpack.js')` 直接解包。
 * 窗口是 sandbox + contextIsolation，而 vite 只认 `import`、**管不到 `require`**：
 * `require('zlib')` 原样留在产物里，于是"设置 → 安装扩展包"一点就
 * `require is not defined` —— **导出的包装不回来**。
 * 所以解析这条链整个搬到主进程；渲染层只选文件、把字节递上去。
 *
 * ── 为什么插件也要用同一份 ────────────────────────────────────────────
 * 插件（组件库、开源打包台）解包、造包走的是这个文件 —— 核心与插件对
 * "包长什么样"只有一个说法。它们是 CJS，走 src/shared/ensoulpack.js 那层薄壳
 * 转到构建产物（见那个文件的说明）。
 */

/** 包规范版本 —— 不认识就拒绝，别静默跳过 */
export const PACK_SPEC = 1;

export interface EnsoulFile {
  path: string;
  data: Buffer;
}

export interface PackFileRef {
  path: string;
  sha256?: string;
}

export interface PackManifest {
  spec?: number;
  type?: string;
  id?: string;
  name?: string;
  version?: string;
  host?: string;
  requires?: { plugins?: string[]; python?: string[] };
  files?: PackFileRef[] | Record<string, string>;
}

/** 一次装包计划：全部校验通过之后才拿得到 */
export interface PackPlan {
  id: string;
  name: string;
  /** 包里声明的版本 —— 只为在确认框里念一句 */
  version: string;
  /** 相对工作区的落点前缀，形如 .ensoul/plugins/<id> */
  targetDir: string;
  /** 要写的文件（相对 targetDir 的安全路径） */
  files: { rel: string; data: Buffer }[];
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ TABLE[(c ^ buf[i]) & 0xff];
  }
  return (c ^ 0xffffffff) >>> 0;
}
const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = ((c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)) >>> 0;
  }
  TABLE[i] = c;
}

export function createZip(files: EnsoulFile[]): Buffer {
  const localHeaders: Buffer[] = [];
  const cdHeaders: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.path.replace(/\\/g, '/'), 'utf8');
    const rawData = file.data;
    const deflated = zlib.deflateRawSync(rawData);
    // If deflated is larger, store raw
    const useStore = deflated.length >= rawData.length;
    const compData = useStore ? rawData : deflated;
    const method = useStore ? 0 : 8;
    const fileCrc = crc32(rawData);

    // Local file header (30 bytes + name)
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0); // signature
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(method, 8); // compression
    lh.writeUInt16LE(0, 10); // mod time
    lh.writeUInt16LE(0, 12); // mod date
    lh.writeUInt32LE(fileCrc, 14); // crc32
    lh.writeUInt32LE(compData.length, 18); // comp size
    lh.writeUInt32LE(rawData.length, 22); // uncomp size
    lh.writeUInt16LE(nameBuf.length, 26); // file name len
    lh.writeUInt16LE(0, 28); // extra field len
    nameBuf.copy(lh, 30);

    localHeaders.push(lh, compData);

    // Central directory header (46 bytes + name)
    const cdh = Buffer.alloc(46 + nameBuf.length);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0, 8); // flags
    cdh.writeUInt16LE(method, 10); // compression
    cdh.writeUInt16LE(0, 12); // mod time
    cdh.writeUInt16LE(0, 14); // mod date
    cdh.writeUInt32LE(fileCrc, 16); // crc32
    cdh.writeUInt32LE(compData.length, 20); // comp size
    cdh.writeUInt32LE(rawData.length, 24); // uncomp size
    cdh.writeUInt16LE(nameBuf.length, 28); // file name len
    cdh.writeUInt16LE(0, 30); // extra field len
    cdh.writeUInt16LE(0, 32); // comment len
    cdh.writeUInt16LE(0, 34); // disk num
    cdh.writeUInt16LE(0, 36); // internal attr
    cdh.writeUInt32LE(0, 38); // external attr
    cdh.writeUInt32LE(offset, 42); // relative offset of local header
    nameBuf.copy(cdh, 46);

    cdHeaders.push(cdh);
    offset += lh.length + compData.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const h of cdHeaders) cdSize += h.length;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); // total entries on disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12); // size of central dir
  eocd.writeUInt32LE(cdOffset, 16); // offset of central dir
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...localHeaders, ...cdHeaders, eocd]);
}

export function parseZip(buf: Buffer): Map<string, Buffer> {
  // 返回 Map<path, Buffer>
  const result = new Map<string, Buffer>();
  let pos = 0;
  while (pos < buf.length - 4) {
    const sig = buf.readUInt32LE(pos);
    if (sig !== 0x04034b50) break; // 不是 local header 说明到达 central directory
    const method = buf.readUInt16LE(pos + 8);
    const compSize = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const name = buf.subarray(pos + 30, pos + 30 + nameLen).toString('utf8');
    const dataStart = pos + 30 + nameLen + extraLen;
    const compData = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) {
      data = compData;
    } else if (method === 8) {
      data = zlib.inflateRawSync(compData);
    } else {
      throw new Error('Unsupported compression method: ' + method);
    }
    result.set(name, data);
    pos = dataStart + compSize;
  }
  return result;
}

/**
 * 宿主版本够不够 —— manifest.host 认这几种写法：`^1.2.3` · `>=1.2.3` · `1.2.3`。
 * 只做"够不够"这一件事，不引一个 semver 库：包格式是我们自己定的，够用就行。
 * 认不出来（写了个怪东西）就当**不满足** —— 装上去会静默出错的那类风险，
 * 宁可拦住让作者把 host 写清楚。
 */
export function satisfies(cur: string, want: string): boolean {
  const num = (s: string) => s.split('.').map((x) => parseInt(x, 10) || 0);
  const [cMaj, cMin, cPat] = num(cur);
  const w = String(want || '').trim();
  const m = w.match(/^(\^|>=|>|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return false;
  const [, op, a, b, c] = m;
  const wMaj = Number(a), wMin = Number(b || 0), wPat = Number(c || 0);
  const cmp = (x: number, y: number) => (x === y ? 0 : x > y ? 1 : -1);
  const d = cmp(cMaj, wMaj) || cmp(cMin, wMin) || cmp(cPat, wPat);
  if (op === '^') return cMaj === wMaj && d >= 0;
  if (op === '>') return d > 0;
  return d >= 0;
}

/**
 * 包里的 id —— 它会被拼成目录名 / 文件名，所以**只认字母数字点下划线连字符**。
 *
 * `.` 与 `..` 必须单独挡：path.join('.ensoul/plugins', '..') 正好是 .ensoul 本身。
 * 参照 fsapi.ts 的 panelSpaceDir() —— 那儿已经挡过同一件事，这里照同一套来。
 */
export function safePackId(raw: unknown): string {
  const id = String(raw ?? '').trim();
  if (!id || id === '.' || id === '..') return '';
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return '';
  return id;
}

/**
 * 压缩包条目名 → 安全的相对路径；**不合规一律返回 null**。
 *
 * 挡的是四类：空、绝对路径（`/` 开头、Windows 盘符）、任何一段 `..`、
 * 以及收紧之后什么都不剩的。反斜杠先归一成正斜杠 —— zip 里两种都见过，
 * 别让 `..\\..\\` 从另一边绕过去。
 */
export function safeEntryPath(raw: unknown): string | null {
  const name = String(raw ?? '').replace(/\\/g, '/').trim();
  if (!name) return null;
  if (name.startsWith('/')) return null;
  if (/^[A-Za-z]:/.test(name)) return null;
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (!parts.length) return null;
  if (parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

/** 摘要表：数组与新写的对象两种写法都认 */
export function manifestFiles(mf: PackManifest): PackFileRef[] {
  if (Array.isArray(mf.files)) return mf.files;
  return Object.entries(mf.files || {}).map(([p, s]) => ({ path: p, sha256: String(s) }));
}

/**
 * 把一份插件包算成"要写哪些文件"，或者抛出一句能读懂的话。
 *
 * **全程只看不写**：任何一条不过就抛，调用方一个字节都还没落盘 —— 这正是
 * "整包拒绝"能成立的原因。写完就没有退路了（半装上的插件谁也说不清）。
 *
 * 按 docs/plugin-spec.md §5 逐条校验：spec · type · host · requires · 摘要 · 路径。
 */
export function planPluginPack(
  data: Buffer,
  opts: { curVersion: string; installedPlugins: string[] },
): PackPlan {
  let files: Map<string, Buffer>;
  try {
    files = parseZip(data);
  } catch (e: any) {
    throw new Error(t('扩展包解不开：') + (e?.message ?? e));
  }
  const mfRaw = files.get('manifest.json');
  if (!mfRaw) throw new Error(t('扩展包损坏：根目录下缺失 manifest.json'));

  let mf: PackManifest;
  try {
    mf = JSON.parse(mfRaw.toString('utf8'));
  } catch (e: any) {
    throw new Error(t('manifest.json 不是合法 JSON：') + (e?.message ?? e));
  }

  // 1) 规范版本与包类型：认不认识、是不是这个入口该收的东西
  if (mf.spec !== PACK_SPEC) throw new Error(t('不支持的包规范版本：') + mf.spec);
  if (mf.type !== 'plugin') throw new Error(t('此入口仅用于安装插件包，当前包类型为：') + mf.type);

  // 2) id：它是要变成目录名的那一个，先夹住它，后面的路径才有意义
  const id = safePackId(mf.id);
  if (!id) {
    throw new Error(
      t('扩展包 id 不合法（只许字母、数字、点、下划线、连字符，且不能是 . 或 ..）：') + String(mf.id ?? ''),
    );
  }

  // 3) host：这个包要求的最低宿主版本够不够
  const wantHost = String(mf.host || '').trim();
  if (wantHost && !satisfies(String(opts.curVersion || '0.0.0'), wantHost)) {
    throw new Error(
      t('这个包要求宿主 {want}，当前是 {cur} —— 装上去会静默出错，先升级软件。', {
        want: wantHost,
        cur: String(opts.curVersion || '0.0.0'),
      }),
    );
  }

  // 4) requires：依赖的别的插件缺不缺（缺了就装个跑不起来的）
  const need = Array.isArray(mf.requires?.plugins) ? mf.requires.plugins : [];
  if (need.length) {
    const have = new Set(opts.installedPlugins.map((n) => String(n)));
    const lack = need.map((n) => String(n)).filter((n) => !have.has(n));
    if (lack.length) throw new Error(t('这个包还依赖这些插件，缺了：') + lack.join('、'));
  }

  // 5) 文件清单：每个文件的摘要都要对得上
  for (const f of manifestFiles(mf)) {
    const buf = files.get(String(f.path));
    if (!buf) throw new Error(t('扩展包缺失文件：') + f.path);
    if (f.sha256) {
      const sha = createHash('sha256').update(buf).digest('hex');
      if (sha !== f.sha256) throw new Error(t('文件摘要校验失败：') + f.path);
    }
  }

  /*
   * 6) 条目路径：**每一个都要能安全地拼到落点下面**。
   * 这是"包能覆盖开源源码"那个洞的正解 —— 从前 id 与条目名都原样拼上，
   * 实测 `../../../src/main/index.ts` 能落到 src/main/ 里去。
   * 现在越界即整包拒绝，并指名道姓说是哪一条。
   */
  const out: { rel: string; data: Buffer }[] = [];
  const seen = new Set<string>();
  for (const [rawName, buf] of files.entries()) {
    if (rawName.endsWith('/')) continue; // 目录项：没有内容
    if (rawName === 'manifest.json') continue; // 清单本身不落进插件目录
    const rel = safeEntryPath(rawName);
    if (!rel) throw new Error(t('包里有不合规的条目名（不许绝对路径、不许 .. 越界）：') + rawName);
    if (seen.has(rel)) throw new Error(t('包里有重复的条目名：') + rel);
    seen.add(rel);
    out.push({ rel, data: buf });
  }
  if (!out.length) throw new Error(t('这个包里除了 manifest.json 什么都没有。'));

  return {
    id,
    name: String(mf.name || id),
    version: String(mf.version || '1.0.0'),
    targetDir: '.ensoul/plugins/' + id,
    files: out,
  };
}
