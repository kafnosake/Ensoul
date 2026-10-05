import * as fs from 'fs';
import * as path from 'path';
import { userDataPath } from './paths';
import type { ChatCost, TokenPrice } from '../shared/types';
import { readTextFile } from './chat-core';
import {
  keyOf as credentialOf,
  setKey as setCredential,
  writeAll as writeCredentials,
  fileKeys as credentialFileKeys,
} from './credentials';
import { writeFileAtomicSync, withFileLockSync } from './atomic-write';
import { t } from '../shared/i18n';

/**
 * 模型提供方配置 —— 学 harness 那套结构（提供方 → 密钥 / 地址 / 模型目录），
 * 但存在自己的 **JSON** 里（`%APPDATA%\ensoul\providers.json`），不碰 yaml，
 * 也不去读 harness 的配置。两边各配各的，互不干扰。
 *
 * 前台看到的永远是脱敏版本（只有 hasKey），密钥只在主进程里流转。
 */

export interface ProviderModel {
  id: string;
  name: string;
  /**
   * 单价：元 / 百万 token，三档分开（命中缓存的输入 / 未命中的输入 / 输出）。
   * **没填就是算不了钱** —— 界面上那笔账会显示"未定价"，而不是拿个假数字充数。
   * 想加就在 `providers.json` 的模型里补 `price`。
   *
   * 有峰谷价的再加一段 `tiers`，写清每段起止（本机时区，起含止不含）：
   *   { "hit": 0.2, "miss": 2, "out": 8,
   *     "tiers": [{ "from": "00:30", "to": "08:30", "hit": 0.1, "miss": 1, "out": 4 }] }
   * 命中哪段用哪段，一段没命中就落回外层那三个数。
   */
  price?: TokenPrice;
}

export interface Provider {
  /** 唯一标识 */
  key: string;
  /** 界面上的名字 */
  label: string;
  api: string;
  baseUrl: string;
  apiKey: string;
  /** 内置的不能删 */
  builtin?: boolean;
  models: ProviderModel[];
}

const FILE = () => userDataPath('providers.json');
export const providersPath = () => FILE();

/**
 * 常见提供方的预设，供"添加提供方"用（密钥一律留空，等用户填）。
 *
 * 单价只给**有把握**的那几档填了；没有可靠标价的先留空，
 * 界面上会显示"未定价"，而不是编一个数出来当真。
 */
export const PRESETS: Omit<Provider, 'apiKey'>[] = [
  {
    key: 'deepseek',
    label: 'DeepSeek',
    api: 'openai-completions',
    baseUrl: 'https://api.deepseek.com',
    builtin: true,
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', price: { hit: 0.2, miss: 2, out: 8 } },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', price: { hit: 0.5, miss: 4, out: 16 } },
      { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision' },
    ],
  },
  {
    key: 'openai',
    label: 'OpenAI',
    api: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'gpt-5-mini', name: 'GPT-5 mini' },
    ],
  },
  {
    key: 'moonshot',
    label: 'Moonshot',
    api: 'openai-completions',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: [{ id: 'kimi-k2-0905-preview', name: 'Kimi K2' }],
  },
  {
    key: 'zhipu',
    label: t('智谱'),
    api: 'openai-completions',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [{ id: 'glm-4.6', name: 'GLM-4.6' }],
  },
  {
    key: 'dashscope',
    label: t('通义千问'),
    api: 'openai-completions',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [{ id: 'qwen3-max', name: 'Qwen3-Max' }],
  },
];

let cache: Provider[] | null = null;
/** 这份缓存是照着**哪一份文件**算出来的（mtime+size）—— 文件动了就作废，见 load() */
let cacheStamp = '';

/**
 * 一个提供方的模型目录**必须永远是数组**。这条不变量有好几处默默依赖：
 * `catalog()` 把它原样发给前台、IPC 层 `p.models.map(...)` 再发一层、插件的
 * `api.models()` 照它画下拉。以前谁往中间塞一条 `models` 不是数组的
 * （手改文件、旧版本存的、别的插件直写 providers.json），`p.models.map` 就在
 * `setModelCatalog` 那个回调里**当场抛** —— 插件那边只看得见"模型清单是空的"，
 * 界面上只剩一个占位符（2026-09-30 这次就是这么坏的）。所以入口统一洗一遍，
 * 坏条目丢掉一颗不留。
 */
function normModels(raw: unknown): ProviderModel[] {
  if (!Array.isArray(raw)) return [];
  const out: ProviderModel[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const o = m as { id?: unknown; name?: unknown; price?: unknown };
    const id = String(o.id ?? '').trim();
    if (!id) continue;
    const name = String(o.name ?? '').trim() || id;
    out.push(o.price && typeof o.price === 'object' ? { id, name, price: o.price as TokenPrice } : { id, name });
  }
  return out;
}

/** 一个提供方整条洗一遍：key 空的不认，models 一律是数组 */
function normProvider(raw: unknown): Provider | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const key = String(o.key ?? '').trim();
  if (!key) return null;
  return {
    key,
    label: String(o.label ?? '').trim() || key,
    api: String(o.api ?? '').trim() || 'openai-completions',
    baseUrl: String(o.baseUrl ?? '').trim(),
    apiKey: String(o.apiKey ?? ''),
    builtin: Boolean(o.builtin),
    models: normModels(o.models),
  };
}

/** 文件指纹：读不到就返回空串（当作"不知道"，别拿它去比） */
function fileStamp(): string {
  try {
    const s = fs.statSync(FILE());
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '';
  }
}

/**
 * 用户删掉过的预设提供方。
 *
 * 不记着这件事的话，删了也白删：`load()` 每次都照 PRESETS 把缺的预设补回来，
 * 表现就是"删不掉"。所以删除要在文件里留一条记录，加载时按它跳过。
 * 重新添加同一个 key 时这条记录就撤掉。
 */
let removedKeys: string[] = [];

function defaults(): Provider[] {
  return PRESETS.filter((p) => p.builtin).map((p) => ({ ...p, apiKey: '' }));
}

export function load(): Provider[] {
  /**
   * 缓存失效：**文件一改就重读**。
   * 以前这里是 `if (cache) return cache` —— 一次算好用到天荒地老。可 providers.json
   * 是**多插件 + 主进程一起写**的（free-model-provider 就自己直写这份文件）。别人把文件修好了，
   * 这边还抱着旧那份；反过来文件坏过一次，这份坏清单就再也换不掉 —— 界面上的表现正是
   * "模型清单永远是空的、重启才好"。所以按 mtime+size 认版本。
   */
  const stamp = fileStamp();
  if (cache && stamp && stamp === cacheStamp) {
    /**
     * 缓存命中也要把密钥重取一遍：环境变量（`ENSOUL_KEY_<提供方>`）不属于文件，
     * 它变了文件的指纹（mtime+size）一个字都不会动 —— 直接返回缓存的话，
     * 换环境变量就得重启才认。
     */
    for (const p of cache) p.apiKey = credentialOf(p.key);
    return cache;
  }
  let list: Provider[] = [];
  let removed: string[] = [];
  /** 从旧文件里翻出来的明文密钥（key → 密钥）—— 升级到独立凭据库时要用 */
  const legacy: Record<string, string> = {};
  try {
    if (fs.existsSync(FILE())) {
      const raw = JSON.parse(readTextFile(FILE()));
      if (Array.isArray(raw?.providers)) {
        for (const p of raw.providers) {
          const k = p && typeof p.key === 'string' ? p.key : '';
          const v = p && typeof p.apiKey === 'string' ? p.apiKey : '';
          if (k && v) legacy[k] = v;
          const n = normProvider(p);
          // 内存里这份不带密钥 —— 它从凭据库现取（见下面 for 那一行）
          if (n) list.push({ ...n, apiKey: '' });
        }
      }
      if (Array.isArray(raw?.removed)) removed = raw.removed.filter((k: unknown): k is string => typeof k === 'string');
    }
  } catch (e) {
    console.error('[提供方] 读取失败，用默认：', e);
    // 读坏了：**别把这份空的记进缓存** —— 下一次再读一眼，别人修好了当场就自愈
    return defaults();
  }
  /**
   * 旧版把明文密钥存在 providers.json 里，新版只存配置、密钥搬去 credentials.json。
   * 这里把翻出来的那批并进凭据库（已有值的不覆盖），再把本文件洗一遍 ——
   * 老的 providers.json 升级上来什么都不用做，密钥就换到新家了。
   */
  if (Object.keys(legacy).length) {
    const had = credentialFileKeys();
    const fresh: Record<string, string> = {};
    for (const [k, v] of Object.entries(legacy)) if (!had[k]) fresh[k] = v;
    if (Object.keys(fresh).length) writeCredentials({ ...had, ...fresh });
    try {
      withFileLockSync(FILE(), () =>
        writeFileAtomicSync(
          FILE(),
          JSON.stringify({ version: 1, providers: list.map((p) => ({ ...p, apiKey: undefined })), removed }, null, 2),
          { mode: 0o600 },
        ),
      );
    } catch (e) {
      console.error('[提供方] 洗掉明文密钥没成功，下次启动再试：', e);
    }
  }
  removedKeys = removed;
  const gone = new Set(removed);

  // 删过的预设不再当预设看待：既不用它补回列表，也不拿它的目录去覆盖用户那份
  const builtins = defaults().filter((b) => !gone.has(b.key));
  for (const b of builtins) {
    if (!list.some((p) => p.key === b.key)) list.push(b);
  }
  // 内置项的目录以代码为准，免得旧配置里少了模型；
  // 顺带把代码里新加的单价补进旧配置 —— 老 providers.json 里没有 price，
  // 不补的话计费会一直显示"未定价"，用户会以为是坏的和自己的配置没关系。
  list = list.map((p) => {
    const b = builtins.find((x) => x.key === p.key);
    if (!b) return p;
    const models = (p.models?.length ? p.models : b.models).map((m) => {
      if (m.price) return m;
      const pm = b.models.find((x) => x.id === m.id)?.price;
      return pm ? { ...m, price: pm } : m;
    });
    return { ...p, builtin: true, label: p.label || b.label, baseUrl: p.baseUrl || b.baseUrl, models };
  });
  // 密钥一律从凭据库现取 —— providers.json 里那份即使还带着明文也不算数。
  // 放在这儿是为了把上面补进来的内置预制项也一起管上（它们只是没有密钥，不代表没配过）。
  for (const p of list) p.apiKey = credentialOf(p.key);
  cache = list;
  cacheStamp = stamp;
  return list;
}

/**
 * 落盘：**配置进 providers.json，密钥进 credentials.json**。
 *
 * 文件里一个密码都不留（配置和凭据分开住）。所以 providers.json 现在可以直接
 * 分享、进备份、进版本库都不出事 —— 密钥那一份才需要当心。
 */
export function save(list: Provider[]) {
  // 存之前也洗一遍：**进来的东西是外面给的**（表单、插件），脏的当场挡在门外
  const incoming = list.map(normProvider).filter((p): p is Provider => Boolean(p));
  // 密钥先搬去凭据库（空串 = 删掉这一条），内存那份照旧带着密钥给下游用
  const keys = credentialFileKeys();
  for (const p of incoming) {
    const v = String(p.apiKey ?? '');
    /**
     * **空 = 不改它现在那把**，不是删掉。
     *
     * 界面上的表单本来就带不回原密钥（只显示"已配置"，占位符写着"输入新值可替换"），
     * 传上来自然是空串 —— 当成删除的话，用户随便改一下地址就会把钥匙弄丢。
     * 真删走 remove()，那里是显式的。
     */
    if (v) keys[p.key] = v;
  }
  writeCredentials(keys);
  const clean = incoming.map((p) => ({ ...p, apiKey: undefined }));
  cache = incoming;
  try {
    const text = JSON.stringify({ version: 1, providers: clean, removed: removedKeys }, null, 2);
    withFileLockSync(FILE(), () => writeFileAtomicSync(FILE(), text, { mode: 0o600 }));
  } catch (e: any) {
    // 拿不到写锁也不让这次保存丢掉：孤儿锁由超时兜着，退成直接写
    console.error('[提供方] 没拿到写锁，仍然直接写：', e?.message ?? e);
    try {
      writeFileAtomicSync(FILE(), JSON.stringify({ version: 1, providers: clean, removed: removedKeys }, null, 2), { mode: 0o600 });
    } catch (e2) {
      console.error('[提供方] 保存失败：', e2);
    }
  }
  // 刚写出去的就是文件此刻的样子 —— 记上指纹，省得下一趟再读一遍
  cacheStamp = fileStamp();
}

/** 新增或更新一个提供方（key 相同就是更新；apiKey 传空表示不改） */
export function upsert(next: Provider) {
  const list = [...load()];
  const i = list.findIndex((p) => p.key === next.key);
  if (i < 0) {
    list.push({ ...next, key: next.key || `p-${Date.now().toString(36)}` });
  } else {
    const cur = list[i];
    list[i] = {
      ...cur,
      ...next,
      apiKey: next.apiKey ? next.apiKey : cur.apiKey,
      builtin: cur.builtin,
    };
  }
  // 重新加回来：撤销"删过它"的记录，并认回预设身份（这样下次启动不会又按预设重造一份）
  if (removedKeys.includes(next.key)) {
    removedKeys = removedKeys.filter((k) => k !== next.key);
    const preset = PRESETS.find((p) => p.key === next.key);
    const j = list.findIndex((p) => p.key === next.key);
    if (preset && j >= 0) list[j] = { ...list[j], builtin: true };
  }
  save(list);
  return list;
}

/**
 * 删掉一个提供方 —— 预设也能删（用户删了就是不要了）。
 * 预设删完在文件里记一笔，否则 `load()` 下次又把它补回来。
 */
export function remove(key: string) {
  const list = load().filter((p) => p.key !== key);
  const preset = PRESETS.find((p) => p.key === key && p.builtin);
  if (preset && !removedKeys.includes(key)) removedKeys = [...removedKeys, key];
  save(list);
  // 这一条不要了，它那把钥匙也别留在凭据库里当孤儿
  setCredential(key, '');
  return list;
}

/**
 * 问服务端自己有哪些模型（OpenAI 兼容的 GET /models），省得手抄模型 id。
 *
 * 密钥：表单里刚敲的优先，没敲就用已存的 —— 所以"只填密钥、还没保存"也能拉。
 * 地址：先按填的原样试 `/models`，不通用再补一层 `/v1`（有的只认带版本的那条）。
 */
export async function listModels(draft: { key: string; baseUrl?: string; apiKey?: string }): Promise<{
  models: ProviderModel[];
  error?: string;
}> {
  const saved = load().find((p) => p.key === draft?.key);
  const apiKey = (draft?.apiKey ?? '').trim() || saved?.apiKey || '';
  const raw = (draft?.baseUrl ?? '').trim() || saved?.baseUrl || '';
  const base = raw.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  if (!base) return { models: [], error: t('先填 API 地址') };
  if (!apiKey) return { models: [], error: t('先填 API 密钥') };

  const roots = [base];
  if (!/\/v\d+$/.test(base)) roots.push(`${base}/v1`);

  let last = '';
  for (const root of roots) {
    try {
      const res = await fetch(`${root}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        last = `返回 ${res.status}`;
        continue;
      }
      const json: any = await res.json();
      const rows: any[] = Array.isArray(json)
        ? json
        : Array.isArray(json?.data)
          ? json.data
          : Array.isArray(json?.models)
            ? json.models
            : [];
      const models = rows
        .map((m) => (typeof m === 'string' ? { id: m, name: m } : { id: String(m?.id ?? ''), name: String(m?.name ?? m?.id ?? '') }))
        .filter((m) => m.id);
      if (!models.length) {
        last = t('这个地址没给出模型列表');
        continue;
      }
      return { models };
    } catch (e: any) {
      last = String(e?.message ?? e);
    }
  }
  return { models: [], error: last || t('拉取失败') };
}

export interface CatalogProvider {
  key: string;
  label: string;
  api: string;
  baseUrl: string;
  hasKey: boolean;
  builtin: boolean;
  models: ProviderModel[];
}

/** 给前台看的：没有密钥，只有"配没配"（单价是公开信息，照发） */
export function catalog(): CatalogProvider[] {
  return load().map((p) => ({
    key: p.key,
    label: p.label,
    api: p.api,
    baseUrl: p.baseUrl,
    hasKey: Boolean(p.apiKey),
    builtin: Boolean(p.builtin),
    models: p.models,
  }));
}

export function resolvePick(pick: string): { baseUrl: string; apiKey: string; model: string; provider: string } | null {
  const i = pick.indexOf('::');
  if (i < 0) return null;
  const key = pick.slice(0, i);
  const model = pick.slice(i + 2);
  const p = load().find((x) => x.key === key);
  if (!p || !model) return null;
  return { baseUrl: p.baseUrl, apiKey: p.apiKey, model, provider: p.key };
}

/**
 * 按三档单价算这一轮实际花了多少。单价是"元 / 百万 token"，所以都要除以一百万。
 * 命中数偶尔会比输入总数还大（接口这么报过），先夹住，别算出负的未命中。
 */
export function costOf(price: TokenPrice, tokensIn: number, cacheHit: number, tokensOut: number): ChatCost {
  const hit = Math.max(0, Math.min(cacheHit, tokensIn));
  const miss = Math.max(0, tokensIn - hit);
  const per = 1_000_000;
  const c = {
    hit: (hit / per) * price.hit,
    miss: (miss / per) * price.miss,
    out: (Math.max(0, tokensOut) / per) * price.out,
  };
  return { ...c, total: c.hit + c.miss + c.out };
}

/** `HH:MM`（也认 `8`、`8:30`、`8：30`）→ 当天的第几分钟；写得不像时间就返回 null（这一段直接跳过） */
function minuteOf(s: string): number | null {
  const t = String(s ?? '')
    .trim()
    .replace(/[：.．。]/g, ':')
    .replace(/[点时]/g, ':')
    .replace(/^:+|:+$/g, '');
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(t) ?? /^(\d{2})(\d{2})$/.exec(t) ?? /^(\d)(\d{2})$/.exec(t) ?? /^(\d{1,2})$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = m[2] === undefined ? 0 : Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/**
 * 把"可能带分时段（峰谷）的单价"落成**一条实在的单价** —— 挑价就发生在这一步。
 *
 * 时间按**本机时区**算，起点含、终点不含；终点比起点小表示跨零点（22:00 → 02:00）。
 * 按数组顺序取**第一条**命中的段；没命中、没配 tiers、时间写得不成样子，
 * 一律落回外层那三个数。
 *
 * 返回的对象一定不带 tiers —— 它要原样写进消息快照，得是"这轮究竟按什么价算的"，
 * 不能让下游拿着价格表再自己解释一遍。
 */
export function resolvePrice(price: TokenPrice | null | undefined, at: number): TokenPrice | null {
  if (!price) return null;
  const base: TokenPrice = { hit: price.hit, miss: price.miss, out: price.out };
  if (!Array.isArray(price.tiers) || !price.tiers.length) return base;
  const d = new Date(at);
  const now = d.getHours() * 60 + d.getMinutes();
  for (const t of price.tiers) {
    const a = minuteOf(t.from);
    const b = minuteOf(t.to);
    if (a === null || b === null || a === b) continue;
    const inside = a < b ? now >= a && now < b : now >= a || now < b;
    if (inside) return { hit: t.hit, miss: t.miss, out: t.out };
  }
  return base;
}

/**
 * 选中项此刻的单价（已经按峰谷挑过段）。找不到（模型没配 price）就返回 null ——
 * 上层据此显示"未定价"，而不是按 0 元算出一个看着很美的假总价。
 *
 * 一轮只在开工时问一次：这一轮从头到尾都按开工那一刻的价算 ——
 * 跨了段的轮次按开工时刻归属，不会同一轮里前后半截两个价。
 */
export function priceOf(pick: string, at: number = Date.now()): TokenPrice | null {
  const i = pick.indexOf('::');
  if (i < 0) return null;
  const p = load().find((x) => x.key === pick.slice(0, i));
  return resolvePrice(p?.models.find((m) => m.id === pick.slice(i + 2))?.price, at);
}

export function describePick(pick: string) {
  const i = pick.indexOf('::');
  const key = i >= 0 ? pick.slice(0, i) : '';
  const mid = i >= 0 ? pick.slice(i + 2) : '';
  const p = load().find((x) => x.key === key);
  const m = p?.models.find((x) => x.id === mid);
  return { pick, provider: p?.label ?? '', name: m?.name ?? mid ?? '', hasKey: Boolean(p?.apiKey), price: m?.price ?? null };
}

/** 默认落点：第一个配了密钥的提供方的第一个模型，否则第一个提供方的第一个模型 */
export function fallbackPick(): string | null {
  const list = load();
  const withKey = list.find((p) => p.apiKey && p.models[0]);
  const p = withKey ?? list.find((x) => x.models[0]);
  return p?.models[0] ? `${p.key}::${p.models[0].id}` : null;
}
