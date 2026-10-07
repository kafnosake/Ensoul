/**
 * 联网聚合层 —— 生态市场「联网的那一半」。
 *
 * 这个文件只做三件事，别的一概不碰：
 *   1. 把「网上此刻有哪些仓库 / 有哪些技能」算出来（不预设白名单，源是可以加的）
 *   2. 把一份技能从仓库里抓下来（SKILL.md 加上它旁边的附属文件）
 *   3. 把 MCP 官方注册表的一条记录翻成「能直接起进程的配置」
 *
 * 它不读状态文件、不注册工具、不知道面板长什么样 —— 那些是 index.js / ecosystem.js 的事。
 * 之所以单独一层：这一层能被 `node -e` 直接跑，抓不到东西时不用把整个软件拉起来。
 *
 * 三个数据源的分工：
 *   GitHub 仓库  技能的家（SKILL.md 就是本软件认的技能格式，同一个规范）
 *   GitHub 搜索  找仓库（有 token 走 code search 直命技能，没 token 退成 repo search）
 *   MCP 官方注册表   MCP 服务的家（Anthropic 自己维护的那一份，几万条，一直有新的）
 */

'use strict';

const GH = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const MCP_REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';
const UA = 'ensoul-market';

/**
 * 出厂自带的源 —— 是**起始清单**，不是白名单。
 * 用户在面板上能加任何 GitHub 仓库；这里挑的是榜单头部那几个：
 * 官方出品、以及社区里公认叫得响的技能库。
 *
 * 挑的尺子是"仓库里真有 SKILL.md"。那些只有一份 README、把人往外链的
 * awesome-* 收藏夹，抓出来是零 —— 看过好几个，一个都没收进来。
 */
const DEFAULT_SOURCES = {
  skill: [
    { id: 'anthropic', label: 'Anthropic 官方技能', repo: 'anthropics/skills', ref: 'main', note: 'SKILL.md 规范的源头，官方示例技能库' },
    { id: 'superpowers', label: 'Superpowers', repo: 'obra/superpowers', ref: 'main', note: '工程流程类技能合集' },
    { id: 'ecc', label: 'ECC', repo: 'affaan-m/ECC', ref: 'main', note: '技能 + 记忆 + 安全的研究型 harness，技能数是这一批里最多的' },
    { id: 'wshobson', label: 'wshobson/agents', repo: 'wshobson/agents', ref: 'main', note: '多 harness 插件市场，百余份现成技能' },
    { id: 'alirezarezvani', label: 'Claude Skills 大合集', repo: 'alirezarezvani/claude-skills', ref: 'main', note: '三百多份技能的社区合集' },
    { id: 'kdense', label: '科研技能', repo: 'K-Dense-AI/scientific-agent-skills', ref: 'main', note: '把 agent 变成 AI 科学家的技能库' },
    { id: 'addyosmani', label: 'Addy Osmani 工程技能', repo: 'addyosmani/agent-skills', ref: 'main', note: '生产级工程技能' },
    { id: 'mattpocock', label: 'mattpocock/skills', repo: 'mattpocock/skills', ref: 'main', note: '给真工程师的技能集' },
  ],
  mcp: [
    { id: 'official', label: 'MCP 官方注册表', url: MCP_REGISTRY, note: 'registry.modelcontextprotocol.io，全网 MCP 服务的权威索引' },
  ],
};

function ghHeaders(token) {
  const h = { 'User-Agent': UA, Accept: 'application/vnd.github+json' };
  if (token) h.Authorization = 'Bearer ' + token;
  return h;
}

/*
 * 出网 —— 整个插件库只有这一处真正发请求，所以代理也只在这一处配。
 *
 * 为什么不用 Node 自带的 fetch：它（undici）**默认不读任何代理设置**。
 * 系统里开着代理时，窗口打得开、这里抓不到，而且报的不是"代理没走"，
 * 是一句连接超时 —— 查起来要绕很久。所以优先借 Electron 的 session 发请求
 * （那走的是 Chromium 网络栈，认代理），拿不到 Electron（纯 node 跑自检）才退回全局 fetch。
 */
const PROXY_PARTITION = 'ecosystem-market';

let proxyRule = '';        // 空 = 跟系统代理走
let marketSession = null;
let proxyApplied = null;   // 已经下发给 session 的规则，避免每次请求都重设

/** 代理地址由插件参数喂进来（面板上能手改，助手也能改） */
function setProxy(rule) {
  const next = String(rule || '').trim();
  if (next === proxyRule) return;
  proxyRule = next;
  proxyApplied = null;
}

function electronSession() {
  if (marketSession) return marketSession;
  try {
    const el = require('electron');
    if (el && el.session && typeof el.session.fromPartition === 'function') {
      marketSession = el.session.fromPartition(PROXY_PARTITION);
    }
  } catch { /* 纯 node：没有 electron，退回全局 fetch */ }
  return marketSession;
}

/** 优先走 Electron 网络栈（认代理）；这条不通、又没指定代理时，退回直连再试一次 */
async function httpFetch(url, init) {
  const ses = electronSession();
  if (ses && typeof ses.fetch === 'function') {
    if (proxyRule && proxyApplied !== proxyRule) {
      try {
        await ses.setProxy({ proxyRules: proxyRule });
      } catch (e) {
        // 代理设不上（地址写错之类）不该把活卡死：记一笔，按系统默认继续试
        noteProxyError(e);
      }
      proxyApplied = proxyRule;
    }
    try {
      return await ses.fetch(url, init);
    } catch (e) {
      if (proxyRule) {
        const err = e instanceof Error ? e : new Error(String(e));
        err.message = err.message + '（走的是代理 ' + proxyRule + '，它可能没开或地址不对）';
        throw err;
      }
      // 没指定代理：系统代理可能配歪了，直连再试一次
      return await fetch(url, init);
    }
  }
  return await fetch(url, init);
}

let lastProxyError = '';
function noteProxyError(e) {
  lastProxyError = (e && e.message) || String(e);
}

/** 发一个请求、把正文取回来。超时和状态码都摊在错误消息里 —— 网络问题该让人一眼看出是哪一段 */
async function fetchText(url, o) {
  const opts = o || {};
  const ms = opts.timeoutMs || 20000;
  const ctl = new AbortController();
  let timer = null;
  // 除了 abort 再加一道 race：万一某条通道不认 signal，也不至于挂死在这里
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new Error('请求超时（' + ms + 'ms）：' + url));
    }, ms);
  });
  try {
    const res = await Promise.race([
      httpFetch(url, { headers: opts.headers || {}, signal: ctl.signal }),
      guard,
    ]);
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        if (j && j.message) msg = j.message;
      } catch { /* 不是 JSON 就用原文 */ }
      const e = new Error(res.status + ' ' + msg);
      e.status = res.status;
      throw e;
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, opts) {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('返回的不是 JSON：' + text.slice(0, 200));
  }
}

/** 抓一段文本（SKILL.md 这类） */
async function getText(url, opts) {
  return await fetchText(url, opts || {});
}

/** 并发闸门 —— 抓一个仓库几十个文件时别把连接打爆 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        out[i] = { __error: e && e.message ? e.message : String(e) };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/** 'owner/repo' / GitHub 网址 / 带 .git 尾巴 —— 都认 */
function parseRepoRef(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m = s.match(/github\.com\/([^/\s#?]+)\/([^/\s#?]+)/i);
  if (m) return { owner: m[1], repo: m[2].replace(/\.git$/i, '') };
  const m2 = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (m2) return { owner: m2[1], repo: m2[2].replace(/\.git$/i, '') };
  return null;
}

function rawUrl(fullName, ref, file) {
  return RAW + '/' + fullName + '/' + (ref || 'main') + '/' + String(file).split('/').map(encodeURIComponent).join('/');
}

/** 极简 frontmatter：只认技能那三个键，跟核心 skills.ts 一个尺子 */
function parseFront(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(String(text || ''));
  if (!m) return {};
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (!k) continue;
    meta[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return meta;
}

/**
 * 备用路：jsDelivr 的包文件清单。
 *
 * 为什么非要有它：GitHub 匿名 API 一小时只给 60 次，抓两个大仓库就见底，
 * 而它报出来的是一句 403 —— 用户看到的就是"技能库一片空、什么都没抓回来"。
 * jsDelivr 不占那份配额、也不要 token，代价只是拿不到 sha（我们用不上 sha）。
 */
async function jsdelivrTree(fullName, ref) {
  const use = ref || 'main';
  const data = await getJson(
    'https://data.jsdelivr.com/v1/packages/gh/' + fullName + '@' + encodeURIComponent(use) + '?structure=flat',
    { timeoutMs: 30000 },
  );
  const files = Array.isArray(data.files) ? data.files : [];
  if (!files.length) throw new Error('jsDelivr 上读不到 ' + fullName + ' 的文件清单');
  const entries = [];
  for (const f of files) {
    const p = String(f.name || '').replace(/^\/+/, '');
    if (!p) continue;
    entries.push({ type: 'blob', path: p, size: Number(f.size) || 0 });
  }
  return { ref: use, entries };
}

/** 拉一个仓库的文件树。ref 猜错就退 main / master —— 仓库用什么分支名，我们不该假设 */
async function repoTree(fullName, preferRef, token) {
  const refs = [];
  for (const r of [preferRef, 'main', 'master']) if (r && refs.indexOf(r) < 0) refs.push(r);
  let last = null;
  let throttled = false;
  for (const r of refs) {
    try {
      const data = await getJson(
        GH + '/repos/' + fullName + '/git/trees/' + encodeURIComponent(r) + '?recursive=1',
        { headers: ghHeaders(token), timeoutMs: 30000 },
      );
      return { ref: r, entries: Array.isArray(data.tree) ? data.tree : [] };
    } catch (e) {
      last = e;
      if (e && e.status === 404) continue;
      // 403 = 配额见底。换分支救不了，但 jsDelivr 能救
      if (e && e.status === 403) { throttled = true; break; }
      throw e;
    }
  }
  if (throttled) {
    for (const r of refs) {
      try { return await jsdelivrTree(fullName, r); }
      catch (e) { last = e; }
    }
  }
  throw last || new Error('仓库读不出来');
}

/**
 * 从文件树里挑出技能。
 *
 * 判据只有一条：**这个仓库里每一个 SKILL.md 就是一个技能** —— 同一个规范，
 * 不管它摆在 skills/ 下面、还是散在仓库各处（很多仓库是混着摆的）。
 * 目录名当技能名，够用了；描述等真要装的时候再抓那一个。
 */
function pickSkills(entries) {
  const out = [];
  const seen = new Set();
  for (const e of entries || []) {
    if (!e || e.type !== 'blob') continue;
    const p = String(e.path || '');
    if (!/SKILL\.md$/i.test(p)) continue;
    if (p.startsWith('.claude-plugin/') || p.startsWith('.github/')) continue;
    const dir = p.replace(/\/SKILL\.md$/i, '');
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push({
      name: dir ? dir.split('/').pop() : 'root',
      dir,
      file: p,
      bytes: e.size || 0,
    });
  }
  out.sort((a, b) => a.dir.localeCompare(b.dir));
  return out;
}

/** 一个仓库里有哪些技能。不抓正文 —— 那是用户点开某一个时才付的代价 */
async function listRepoSkills(source, token) {
  const ref = parseRepoRef(source.repo);
  if (!ref) throw new Error('仓库地址看不懂：' + source.repo);
  const fullName = ref.owner + '/' + ref.repo;
  const tree = await repoTree(fullName, source.ref, token);
  const skills = pickSkills(tree.entries);
  return {
    sourceId: source.id,
    label: source.label || fullName,
    repo: fullName,
    ref: tree.ref,
    url: 'https://github.com/' + fullName,
    skills,
  };
}

/** 一个技能的 frontmatter（描述、什么时候用）—— 点开时才抓这一个 */
async function readSkillMeta(repo, ref, file) {
  try {
    const text = await getText(rawUrl(repo, ref, file));
    const meta = parseFront(text);
    return {
      name: meta.name || '',
      description: meta.description || '',
      whenToUse: meta.whenToUse || meta.when_to_use || '',
      head: text.slice(0, 8000),
    };
  } catch (e) {
    return { name: '', description: '', whenToUse: '', head: '', error: e && e.message ? e.message : String(e) };
  }
}

/**
 * 把一个技能整个抓下来 —— SKILL.md 加上它**同目录下**的附属文件。
 *
 * 为什么连附属一起抓：技能常带脚本、模板、参考文档（那些文件是它的一部分，
 * 只抓 SKILL.md 会得到一份指向不存在文件的说明）。只抓同目录及其子目录，
 * 不碰仓库其余部分 —— 免得把一个仓库整个拖进工作区。
 */
async function fetchSkillBundle(fullName, ref, dir, token) {
  const tree = await repoTree(fullName, ref, token);
  const prefix = dir ? dir + '/' : '';
  const blobs = (tree.entries || []).filter((e) => {
    if (!e || e.type !== 'blob') return false;
    const p = String(e.path || '');
    if (dir && !p.startsWith(prefix)) return false;
    if (!dir && p.indexOf('/') >= 0) return false;
    return (e.size || 0) <= 512 * 1024;
  }).slice(0, 60);

  const files = await mapLimit(blobs, 6, async (e) => {
    const rel = dir ? String(e.path).slice(prefix.length) : String(e.path);
    const text = await getText(rawUrl(fullName, tree.ref, e.path));
    return { path: rel, text };
  });

  const good = [];
  const failed = [];
  for (let i = 0; i < blobs.length; i++) {
    const r = files[i];
    if (!r || r.__error) {
      failed.push({ path: blobs[i].path, error: (r && r.__error) || '抓取失败' });
      continue;
    }
    good.push(r);
  }
  return { ref: tree.ref, files: good, failed };
}

/**
 * 自动找源 —— 不靠人（也不靠我）手列一份清单。
 *
 * 做法就是走 GitHub 自己的 topic：社区把技能库都打上了 `claude-skills` / `agent-skills`
 * 这些标签，于是"全网有多少个技能库"这件事有了个可查的答案，而不是一份会过期的名单。
 * 每个 topic 取一页，合并去重，按 star 排 —— 热度本身就够当筛选条件了。
 *
 * 为什么这件事必须放在这一层：**源该有多少个，不该由写代码的人拍板。**
 * 新仓库今天冒出来一个，明天这个清单就该自己长出来。
 */
async function discoverSources(token, opts) {
  const o = opts || {};
  const perTopic = Math.max(1, Math.min(o.perTopic || 12, 50));
  const topics = Array.isArray(o.topics) && o.topics.length
    ? o.topics
    : ['claude-skills', 'agent-skills', 'claude-code-skills', 'skills', 'mcp'];
  const seen = new Set();
  const out = [];
  const errors = [];

  for (const topic of topics) {
    try {
      const data = await getJson(
        GH + '/search/repositories?q=' + encodeURIComponent('topic:' + topic) +
          '&sort=stars&order=desc&per_page=' + perTopic,
        { headers: ghHeaders(token), timeoutMs: 25000 },
      );
      for (const repo of data.items || []) {
        const full = repo.full_name;
        if (!full || seen.has(full)) continue;
        seen.add(full);
        out.push({
          repo: full,
          ref: repo.default_branch || 'main',
          stars: repo.stargazers_count || 0,
          description: repo.description || '',
          topic,
          updatedAt: repo.updated_at ? String(repo.updated_at).slice(0, 10) : '',
        });
      }
    } catch (e) {
      errors.push({ topic, error: (e && e.message) || String(e) });
    }
  }
  out.sort((a, b) => b.stars - a.stars);
  return { items: out, errors, topics };
}

/** 找一个仓库里所有技能的名字和一句话描述（并行抓 frontmatter，封顶 40 个） */
async function describeRepoSkills(fullName, ref, skills, limit, token) {
  const pick = skills.slice(0, Math.max(1, Math.min(Number(limit) || 40, 200)));
  const metas = await mapLimit(pick, 6, (s) => readSkillMeta(fullName, ref, s.file));
  return pick.map((s, i) => {
    const m = metas[i] && !metas[i].__error ? metas[i] : {};
    return Object.assign({}, s, {
      name: m.name || s.name,
      description: m.description || '',
      whenToUse: m.whenToUse || '',
    });
  });
}

/** 按关键词找仓库 —— 有 token 走 code search（直接命中技能），没 token 退成 repo search */
async function searchRepos(query, token, limit) {
  const n = Math.max(1, Math.min(limit || 12, 30));
  const q = String(query || '').trim();

  if (token) {
    try {
      const url = GH + '/search/code?q=' + encodeURIComponent((q ? q + ' ' : '') + 'filename:SKILL.md') + '&per_page=' + n;
      const data = await getJson(url, { headers: ghHeaders(token), timeoutMs: 25000 });
      const seen = new Set();
      const out = [];
      for (const it of data.items || []) {
        const full = it && it.repository && it.repository.full_name;
        if (!full || seen.has(full)) continue;
        seen.add(full);
        out.push({
          repo: full,
          ref: '',
          skill: { name: String(it.path || '').replace(/\/SKILL\.md$/i, '').split('/').pop() || 'root', dir: String(it.path || '').replace(/\/SKILL\.md$/i, ''), file: it.path, bytes: it.size || 0 },
          stars: it.repository.stargazers_count || 0,
          description: it.repository.description || '',
        });
      }
      if (out.length) return { mode: 'code', items: out };
    } catch (e) {
      if (e && e.status === 403) {
        const err = new Error('GitHub 搜索被限流（未配 token 时每小时只有几次）。在插件参数里填一个 GitHub token 就顺畅了。');
        err.status = 403;
        throw err;
      }
    }
  }

  const url = GH + '/search/repositories?q=' + encodeURIComponent(q ? q + ' agent skills' : 'agent skills') +
    '&sort=stars&order=desc&per_page=' + n;
  const data = await getJson(url, { headers: ghHeaders(token), timeoutMs: 25000 });
  return {
    mode: 'repo',
    items: (data.items || []).map((r) => ({
      repo: r.full_name,
      ref: r.default_branch || 'main',
      skill: null,
      stars: r.stargazers_count || 0,
      description: r.description || '',
      updatedAt: r.updated_at ? String(r.updated_at).slice(0, 10) : '',
    })),
  };
}

/** MCP 官方注册表。翻页、按名字去重 —— 同一份服务会有一串历史版本压在上面 */
async function searchMcp(query, limit) {
  const want = Math.max(1, Math.min(limit || 60, 200));
  const out = [];
  const byName = new Map();
  let cursor = '';
  let guard = 0;
  while (byName.size < want && guard++ < 5) {
    const qs = new URLSearchParams({ limit: '100' });
    if (query) qs.set('search', String(query));
    if (cursor) qs.set('cursor', cursor);
    const data = await getJson(MCP_REGISTRY + '?' + qs.toString(), { timeoutMs: 25000 });
    const list = Array.isArray(data.servers) ? data.servers : [];
    for (const it of list) {
      const s = it && it.server ? it.server : it;
      if (!s || !s.name) continue;
      const meta = (it && it._meta && it._meta['io.modelcontextprotocol.registry/official']) || {};
      const item = normalizeMcp(s, meta);
      const prev = byName.get(item.name);
      if (!prev || (meta.isLatest && !prev.latest)) byName.set(item.name, Object.assign(item, { latest: !!meta.isLatest }));
    }
    const next = data.metadata && data.metadata.nextCursor;
    if (!next) break;
    cursor = next;
  }
  for (const v of byName.values()) out.push(v);
  return out.slice(0, want);
}

/** 注册表的一条 → 我们能用的形状。stdio 能直起，remote 只能给人看 */
function normalizeMcp(s, meta) {
  const pkgs = Array.isArray(s.packages) ? s.packages : [];
  const npm = pkgs.find((p) => p && (p.registryType === 'npm' || (p.identifier && !p.registryType))) || null;
  const remotes = Array.isArray(s.remotes) ? s.remotes : [];
  const extra = npm && Array.isArray(npm.runtimeArguments)
    ? npm.runtimeArguments.filter((a) => a && a.type === 'positional').map((a) => String(a.value))
    : [];
  const envNames = npm && Array.isArray(npm.environmentVariables)
    ? npm.environmentVariables.map((v) => ({ name: String(v.name || ''), required: !!v.isRequired, secret: !!v.isSecret, description: String(v.description || '') })).filter((v) => v.name)
    : [];

  let launch = null;
  if (npm && npm.identifier) {
    const pkg = String(npm.identifier) + (npm.version && npm.version !== 'latest' ? '@' + npm.version : '');
    launch = { command: npm.runtimeHint || 'npx', args: ['-y', pkg].concat(extra), env: {} };
  }

  return {
    id: String(s.name),
    name: String(s.name),
    title: String(s.title || s.name.split('/').pop()),
    description: String(s.description || ''),
    version: String(s.version || ''),
    repository: (s.repository && s.repository.url) || '',
    remotes: remotes.map((r) => ({ type: String(r.type || ''), url: String(r.url || '') })),
    envNames,
    launch,
    requiresConfig: !!launch && envNames.some((v) => v.required),
    updatedAt: String((meta && (meta.updatedAt || meta.publishedAt)) || '').slice(0, 10),
  };
}

module.exports = {
  GH,
  RAW,
  MCP_REGISTRY,
  DEFAULT_SOURCES,
  ghHeaders,
  setProxy,
  proxyRule: () => proxyRule,
  proxyError: () => lastProxyError,
  getJson,
  getText,
  mapLimit,
  parseRepoRef,
  parseFront,
  rawUrl,
  repoTree,
  pickSkills,
  listRepoSkills,
  discoverSources,
  readSkillMeta,
  describeRepoSkills,
  fetchSkillBundle,
  searchRepos,
  searchMcp,
  normalizeMcp,
};
