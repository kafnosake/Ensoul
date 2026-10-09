/**
 * 生态层的调度台 —— 把「网上有什么」拉回来、缓存好、接成工具和面板命令。
 *
 * 它自己不做网络、不碰磁盘布局，那些在 registry.js / library.js 里；这一层只管：
 *
 *   1. 源从哪来（用户加的 + 出厂那两个，都可以改，没有白名单）
 *   2. 拉回来的东西缓存在哪（<工作区>/.ensoul/state/mcp.market.json，面板读它）
 *   3. 助手能调哪些工具（skill_* / mcp_*）
 *   4. 面板按了按钮走哪条命令（mcp.cmd.json 那个队列，跟原有几条命令一个通道）
 *
 * 为什么必须有缓存这一层：面板脸跑在渲染进程、能力只有读写工作区文件 ——
 * 它连不了 GitHub，也该连。网络那一半全在主进程，结论落在文件里，两边不见面。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const reg = require('./registry');
const lib = require('./library');

/** 缓存文件 —— 面板读的就是它，别改名，面板里写死了同一个串 */
const CACHE_FILE = '.ensoul/state/mcp.market.json';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(Number(n) || 0, hi));

/** 出厂源是「起始清单」，不是白名单：用户加的任何仓库都同等对待 */
function defaultSources(kind) {
  return (reg.DEFAULT_SOURCES[kind] || []).map((s) => Object.assign({}, s, { builtin: true }));
}

/**
 * 读源清单。存在插件状态里（跟 MCP 服务器同一份 json），
 * 没有就落一份出厂的 —— 用户一打开就有东西看，而不是一片空白等他自己加。
 */
function readSources(state, kind) {
  const eco = state && state.ecosystem;
  const list = eco && Array.isArray(eco[kind + 'Sources']) ? eco[kind + 'Sources'] : null;
  if (!list) return defaultSources(kind);
  return list.map((s) => Object.assign({}, s, { builtin: !!(s && s.builtin) })).filter((s) => s.id && (s.repo || s.url));
}

function writeSources(state, kind, list) {
  state.ecosystem = state.ecosystem && typeof state.ecosystem === 'object' ? state.ecosystem : {};
  state.ecosystem[kind + 'Sources'] = list;
  return state;
}

// ── 缓存 ───────────────────────────────────────────────────────────────

function cachePath(api) {
  return api.dataPath(CACHE_FILE);
}

function readCache(api) {
  try {
    const v = JSON.parse(fs.readFileSync(cachePath(api), 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** 合并着写 —— 面板可能正在读，别把别的字段抹掉 */
function patchCache(api, patch) {
  const next = Object.assign({}, readCache(api), patch, { updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(cachePath(api)), { recursive: true });
  fs.writeFileSync(cachePath(api), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ── 拉取 ───────────────────────────────────────────────────────────────

/**
 * 把技能源们拉一遍 —— **每个源一次请求**（拉文件树）：描述要一个技能一次请求，源多了就是几百次，
 * 而匿名 GitHub 每小时只给几十次 —— 那一步留给用户真要细看某个仓库时再抓。
 */
async function collectSkills(state, token, opts) {
  const sources = readSources(state, 'skill');
  const perRepo = clamp((opts && opts.perRepo) || 60, 1, 200);
  const repos = [];
  const errors = [];

  for (const src of sources) {
    if (!src.repo) continue;
    try {
      // 一层请求就够：文件树里哪些目录有 SKILL.md，那本身就是"有哪些技能"的清单。
      // 描述要一个技能一次请求 —— 源多了就是几百次，匿名的 GitHub 每小时只给几十次，
      // 所以那一步留给"用户真要细看某一个仓库"的时候（skill_repo 工具 / 展开时再抓）。
      const listed = await reg.listRepoSkills(src, token);
      repos.push({
        id: src.id,
        label: src.label || listed.repo,
        repo: listed.repo,
        ref: listed.ref,
        url: listed.url,
        builtin: !!src.builtin,
        total: listed.skills.length,
        skills: listed.skills.slice(0, perRepo),
        truncated: listed.skills.length > perRepo,
        described: false,
      });
    } catch (e) {
      errors.push({ id: src.id, repo: src.repo, error: (e && e.message) || String(e) });
      // 这一源挂了不耽误别的源：把失败原样记在它自己那一格里，面板上看得见
      repos.push({ id: src.id, label: src.label || src.repo, repo: src.repo, ref: src.ref || '', url: '', builtin: !!src.builtin, total: 0, skills: [], error: (e && e.message) || String(e) });
    }
  }
  return { repos, errors, sources: sources.map((s) => ({ id: s.id, label: s.label, repo: s.repo, ref: s.ref, builtin: !!s.builtin })) };
}

/** MCP 官方注册表搜一遍 */
async function collectMcp(query, limit) {
  const items = await reg.searchMcp(query, clamp(limit || 80, 1, 200));
  return { query: String(query || ''), items, at: new Date().toISOString() };
}

// ── 这一层对外的样子 ───────────────────────────────────────────────────

/**
 * @param api  插件宿主（workspace / param / state / addTool / refresh / log）
 * @param hooks { loadState, saveState, onBeforeTool } 读写插件那份状态（mcp.json）
 */
function createEcosystem(api, hooks) {
  const root = api.workspace;
  const dataRoot = path.dirname(api.dataPath('.ensoul'));
  /** 两半各自的"正在拉"闸 —— 面板挂载/切标签会反复要求刷新，别叠着打 */
  const busy = { skills: false, mcp: false };
  const token = () => String(api.param('githubToken', '') || '').trim();
  const installScope = () => String(api.param('installScope', 'user') || 'user');

  /**
   * 代理地址同步给联网层。每次刷新前对一次 —— 参数改了（面板、设置、或助手
   * 用 plugin_params 改）下一次刷新就走新地址，不必等插件重挂。
   * 留空 = 按系统代理走。
   */
  function syncProxy() {
    try {
      reg.setProxy(api.param('proxy', '') || '');
    } catch { /* 拿不到参数就按上次那份来 */ }
  }

  /*
   * loadState / saveState 的形状是 (api, ...) —— 这两个包装以前漏传了 api，
   * 于是 state() 一调用就炸在 api.state 上。而它又在 try 外面，
   * 错误被外层的 .catch 吞掉：表现成"技能那半页永远空着，什么错都不报"。
   * 所以这里既补上参数，也把它挪进 try（见 refreshSkills）。
   */
  function state() {
    return hooks.loadState(api);
  }
  function commit(st) {
    hooks.saveState(api, st);
  }

  /** 刷新技能侧：抓源 → 落缓存。失败也有缓存（带 errors），面板照样能打开 */
  async function refreshSkills(reason) {
    // 正在拉就别叠第二次 —— 面板挂载、切标签都会来一下，叠起来会把 GitHub 打爆
    if (busy.skills) return;
    busy.skills = true;
    syncProxy();
    // 先落个"正在拉"的标记：抓两个仓库几十份技能要十几秒，面板上不该是一片空白
    const cur = readCache(api);
    patchCache(api, { skills: Object.assign({}, cur.skills || {}, { loading: true, reason: reason || 'auto' }) });
    api.refresh();
    try {
      const st = state();
      const got = await collectSkills(st, token(), { perRepo: Number(api.param('perRepoSkills', 60)) || 60 });
      const installed = lib.listInstalledSkills(root);
      patchCache(api, {
        skills: Object.assign({}, got, { installed, loading: false, at: new Date().toISOString(), reason: reason || 'auto' }),
        settings: { allowLlmInstall: llmMayInstall() },
      });
      api.log('[market] 技能源已刷新：' + got.repos.length + ' 个仓库，' + got.repos.reduce((n, r) => n + r.skills.length, 0) + ' 份技能');
    } catch (e) {
      patchCache(api, { skills: { repos: [], errors: [{ error: (e && e.message) || String(e) }], installed: lib.listInstalledSkills(root), loading: false, at: new Date().toISOString(), reason: reason || 'auto' } });
      api.log('[market] 技能源刷新失败：' + ((e && e.message) || e));
    } finally {
      busy.skills = false;
    }
    api.refresh();
  }

  async function refreshMcp(query) {
    // 面板每次挂载都会来一下；刚刷过、又是同一个关键词，就直接用缓存那份 ——
    // 官方注册表不该每切一次标签就被打一遍
    if (skipIfFresh('mcp', query) || busy.mcp) return;
    busy.mcp = true;
    syncProxy();
    try {
      const got = await collectMcp(query, Number(api.param('mcpPageSize', 80)) || 80);
      patchCache(api, { mcp: Object.assign({}, got, { installed: lib.listInstalledMcp(root, dataRoot), at: new Date().toISOString() }) });
    } catch (e) {
      patchCache(api, { mcp: { query: String(query || ''), items: [], error: (e && e.message) || String(e), installed: lib.listInstalledMcp(root, dataRoot), at: new Date().toISOString() } });
    } finally {
      busy.mcp = false;
    }
    api.refresh();
  }

  /**
   * 刚刷过就别再刷 —— 面板挂载、切标签都会来一下，匿名注册表被打几遍就没了。
   * query 变了当然要重新查；同一个 query 在窗口期内直接用缓存。
   */
  function skipIfFresh(kind, query) {
    const gap = Number(api.param('refreshGapSec', 300)) || 300;
    const cur = readCache(api);
    const box = cur[kind];
    if (!box || !box.at) return false;
    const age = Date.now() - Date.parse(box.at);
    if (!Number.isFinite(age) || age < 0) return false;
    if (age > gap * 1000) return false;
    if (kind === 'mcp' && String(box.query || '') !== String(query || '')) return false;
    return (box.items || []).length > 0;
  }

  /** 装上 / 卸下之后，缓存里那两份"已装"要立刻跟上，面板不用等下一轮刷新 */
  function syncInstalled() {
    const cur = readCache(api);
    patchCache(api, {
      skills: Object.assign({}, cur.skills || {}, { installed: lib.listInstalledSkills(root) }),
      mcp: Object.assign({}, cur.mcp || {}, { installed: lib.listInstalledMcp(root, dataRoot) }),
      settings: { allowLlmInstall: llmMayInstall() },
    });
    api.refresh();
  }

  // ── 面板发来的命令 ──────────────────────────────────────────────────
  async function handleCommand(cmd) {
    if (!cmd || typeof cmd.action !== 'string') return false;
    switch (cmd.action) {
      case 'market_refresh':
        // 两半一起刷 —— 用户点的是"去网上更新"，不该只更新一半
        await refreshSkills('manual');
        await refreshMcp(readCache(api).mcp?.query || '');
        return true;

      /** 面板上那个搜索框：搜 GitHub 上的技能（在已加的源里筛是面板自己做的） */
      case 'market_search_skills': {
        const cur = readCache(api);
        try {
          const got = await reg.searchRepos(cmd.query || '', token(), 15);
          patchCache(api, { skills: Object.assign({}, cur.skills || {}, { search: { mode: got.mode, query: String(cmd.query || ''), items: got.items, at: new Date().toISOString() } }) });
        } catch (e) {
          patchCache(api, { skills: Object.assign({}, cur.skills || {}, { search: { query: String(cmd.query || ''), items: [], error: (e && e.message) || String(e), at: new Date().toISOString() } }) });
        }
        api.refresh();
        return true;
      }
      case 'market_search_mcp':
        await refreshMcp(cmd.query || '');
        return true;

      /**
       * 自动找源：按 GitHub topic 去搜"全网还有哪些技能库"。
       *
       * 发现的结果**不自动加成源** —— 几十个仓库一起抓描述会被 GitHub 限流打回，
       * 而且用户多半只想要其中几个。所以这里只把它们列出来，谁想加谁点。
       */
      case 'market_discover': {
        const cur = readCache(api);
        patchCache(api, { discover: { loading: true, at: new Date().toISOString() } });
        api.refresh();
        try {
          const got = await reg.discoverSources(token(), { perTopic: Number(api.param('discoverPerTopic', 12)) || 12 });
          const known = new Set(readSources(state(), 'skill').map((s) => s.repo));
          patchCache(api, { discover: { items: got.items.filter((x) => !known.has(x.repo)), known: got.items.filter((x) => known.has(x.repo)).length, errors: got.errors, topics: got.topics, loading: false, at: new Date().toISOString() } });
        } catch (e) {
          patchCache(api, { discover: { items: [], error: (e && e.message) || String(e), loading: false, at: new Date().toISOString() } });
        }
        api.refresh();
        return true;
      }

      /**
       * 细看一个源：把它的技能描述抓回来。
       *
       * 为什么单独一步：描述是**一个技能一次请求**，几十份技能就是几十次，
       * 而匿名 GitHub 每小时只给几十次。所以默认不抓，谁想细看谁点。
       */
      case 'market_describe_repo': {
        const cur = readCache(api);
        const repos = (cur.skills && cur.skills.repos) || [];
        const at = repos.findIndex((r) => r && (r.id === cmd.id || r.repo === cmd.repo));
        if (at < 0) return true;
        const r = repos[at];
        try {
          const skills = await reg.describeRepoSkills(r.repo, r.ref, r.skills || [], (r.skills || []).length, token());
          repos[at] = Object.assign({}, r, { skills, described: true });
          patchCache(api, { skills: Object.assign({}, cur.skills || {}, { repos }) });
        } catch (e) {
          patchCache(api, { lastAction: { kind: 'describe_repo', ok: false, name: r.repo, error: (e && e.message) || String(e), at: new Date().toISOString() } });
        }
        api.refresh();
        return true;
      }

      /**
       * 面板上那几个开关（现在只有"允许助手自行装载"这一条）。
       *
       * 为什么它得摆在面板上而不是只藏在设置里：这条授权管的是"助手能不能自己
       * 从网上装东西到本机"，用户心里要有个能随手拨的闸。藏三层菜单里，等于没有。
       */
      case 'market_set_param': {
        const key = String(cmd.key || '');
        if (key !== 'allowLlmInstall') return true;
        const value = cmd.value === true || cmd.value === 'true';
        api.setParam(key, value);
        syncInstalled();
        return true;
      }

      case 'skill_install': {
        const repo = reg.parseRepoRef(cmd.repo);
        if (!repo) { patchCache(api, { lastAction: { kind: 'skill_install', ok: false, error: '仓库地址看不懂：' + cmd.repo, at: new Date().toISOString() } }); return true; }
        const full = repo.owner + '/' + repo.repo;
        let bundle;
        try {
          bundle = await reg.fetchSkillBundle(full, cmd.ref || '', cmd.path || '', token());
        } catch (e) {
          patchCache(api, { lastAction: { kind: 'skill_install', ok: false, error: (e && e.message) || String(e), at: new Date().toISOString() } });
          return true;
        }
        const meta = reg.parseFront((bundle.files.find((f) => f.path === 'SKILL.md') || {}).text || '');
        const name = lib.safeId(meta.name || cmd.name || (cmd.path || '').split('/').pop() || 'skill');
        const res = lib.installSkill(root, {
          group: full,
          name,
          files: bundle.files,
          repo: full,
          ref: bundle.ref,
          path: cmd.path || '',
          url: 'https://github.com/' + full + (cmd.path ? '/tree/' + bundle.ref + '/' + cmd.path : ''),
          description: meta.description || cmd.description || '',
          whenToUse: meta.whenToUse || '',
          fallbackText: cmd.fallbackText || '',
          scope: cmd.scope || installScope(),
        });
        patchCache(api, { lastAction: { kind: 'skill_install', ok: true, name: res.name, dir: res.dir, files: res.files, at: new Date().toISOString() } });
        syncInstalled();
        return true;
      }

      case 'skill_uninstall': {
        const res = lib.uninstallSkill(root, cmd.id);
        patchCache(api, { lastAction: { kind: 'skill_uninstall', ok: res.ok, id: cmd.id, error: res.error || '', at: new Date().toISOString() } });
        syncInstalled();
        return true;
      }

      case 'skill_source_add': {
        const st = state();
        const list = readSources(st, 'skill');
        const repo = reg.parseRepoRef(cmd.repo);
        if (!repo) { patchCache(api, { lastAction: { kind: 'skill_source_add', ok: false, name: cmd.repo, error: '仓库地址看不懂', at: new Date().toISOString() } }); return true; }
        const full = repo.owner + '/' + repo.repo;
        if (!list.some((s) => s.repo === full)) {
          list.push({ id: lib.safeId(full), label: String(cmd.label || full), repo: full, ref: String(cmd.ref || ''), note: '' });
        }
        writeSources(st, 'skill', list);
        commit(st);
        patchCache(api, { lastAction: { kind: 'skill_source_add', ok: true, name: full, at: new Date().toISOString() } });
        await refreshSkills('source-add');
        return true;
      }

      case 'skill_source_remove': {
        const st = state();
        const list = readSources(st, 'skill').filter((s) => s.id !== cmd.id);
        writeSources(st, 'skill', list);
        commit(st);
        await refreshSkills('source-remove');
        return true;
      }

      case 'mcp_install': {
        const st = state();
        const cur = readCache(api);
        const item = ((cur.mcp && cur.mcp.items) || []).find((x) => x.name === cmd.name);
        if (!item) {
          patchCache(api, { lastAction: { kind: 'mcp_install', ok: false, error: '缓存里没有这条服务，先搜一次', at: new Date().toISOString() } });
          return true;
        }
        const res = lib.installMcp(root, {
          name: cmd.alias || item.title || item.name,
          launch: item.launch,
          source: 'registry',
          registryId: item.name,
          repository: item.repository,
          title: item.title,
          description: item.description,
          envNames: item.envNames,
          remotes: item.remotes,
          scope: cmd.scope || installScope(),
        });
        patchCache(api, { lastAction: { kind: 'mcp_install', ok: res.ok, name: res.name, error: res.error || '', at: new Date().toISOString() } });
        syncInstalled();
        return true;
      }

      case 'mcp_uninstall': {
        const res = lib.uninstallMcp(root, cmd.name, dataRoot);
        patchCache(api, { lastAction: { kind: 'mcp_uninstall', ok: res.ok, name: cmd.name, error: res.error || '', at: new Date().toISOString() } });
        syncInstalled();
        return true;
      }

      default:
        return false;
    }
  }

  // ── 助手能调的工具 ──────────────────────────────────────────────────
  /**
   * 助手自己动手装东西，放不放行。
   *
   * 这件事**得由用户开关说了算**，不能靠模型问一句"我可以装吗"就放行 ——
   * 那是模型在替用户答应自己。所以做成插件参数（设置面板里一个开关，助手也能改）：
   *
   *   allowLlmInstall = false（默认）  助手只能看、只能查，装不了；要用它自己报需要什么，人来装
   *   allowLlmInstall = true          助手可以自己装 —— 装了哪些、什么时候装的都写在市场缓存里，
   *                                   面板的「已装载」页随时能撤，所以这是个可回退的授权
   *
   * 面板上点装载**不受这个开关管** —— 那本来就是人在动手。而 onBeforeTool 留着，
   * 是给以后"要不要连某些源"这类更细的闸用的。
   */
  function llmMayInstall() {
    const raw = api.param('allowLlmInstall', false);
    return raw === true || raw === 'true' || raw === 1;
  }
  function denyLlmInstall(repo) {
    return '这个动作要用户自己来。\n\n目标：' + repo +
      '\n\n用户可以在本面板的「技能仓库 / MCP 服务」里点「装载」，也可以在 设置 → 插件参数 里把 ' +
      '「允许助手自行装载」打开，之后你就能自己装了。\n' +
      '（要用户点头的东西，不该由你代他答应。）\n\n' +
      '注：安装记录会在面板「已装载」里出现，随时能卸载。';
  }
  // 更细的闸（比如"某些源不许装"）以后接 api.onBeforeTool，现在不需要

  function registerTools() {
    const s = (v) => JSON.stringify(v, null, 2);

    api.addTool(
      {
        name: 'skill_search',
        description: '在网上搜技能（SKILL.md 规范的 Agent 技能）。返回仓库列表；带 skill 字段的条目表示直接命中某个仓库里的某一份技能。装之前先用它找。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键词，例如 pdf、frontend、testing；留空就是最热门的那些' },
            limit: { type: 'number', description: '要几条，默认 12' },
          },
        },
      },
      async (args) => {
        try {
          const got = await reg.searchRepos(args.query || '', token(), clamp(args.limit || 12, 1, 30));
          return s({ mode: got.mode, count: got.items.length, items: got.items });
        } catch (e) {
          return '搜索失败：' + ((e && e.message) || e) + '\n（没配 GitHub token 时搜索限流很紧，可在插件参数里填一个）';
        }
      },
    );

    api.addTool(
      {
        name: 'skill_repo',
        description: '列出一个 GitHub 仓库里有哪些技能（含每份的一句话说明）。repo 形如 owner/name。',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: '仓库，形如 anthropics/skills 或 GitHub 网址' },
            ref: { type: 'string', description: '分支 / 标签，不填自动试 main、master' },
            limit: { type: 'number', description: '最多列几份，默认 60' },
          },
          required: ['repo'],
        },
      },
      async (args) => {
        const parsed = reg.parseRepoRef(args.repo);
        if (!parsed) return '仓库地址看不懂：' + args.repo;
        const full = parsed.owner + '/' + parsed.repo;
        try {
          const listed = await reg.listRepoSkills({ id: 'adhoc', repo: full, ref: args.ref || '' }, token());
          const skills = await reg.describeRepoSkills(full, listed.ref, listed.skills, clamp(args.limit || 60, 1, 200), token());
          return s({ repo: full, ref: listed.ref, total: listed.skills.length, shown: skills.length, skills });
        } catch (e) {
          return '读取仓库失败：' + ((e && e.message) || e);
        }
      },
    );

    api.addTool(
      {
        name: 'skill_read',
        description: '读一份技能的正文（还没装的时候先看看它写了什么）。用 skill_repo 或 skill_search 得到的 repo + path。',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: '仓库，形如 owner/name' },
            path: { type: 'string', description: '技能目录，例如 skills/pdf；技能就在仓库根上时留空' },
            ref: { type: 'string', description: '分支，不填自动试' },
          },
          required: ['repo'],
        },
      },
      async (args) => {
        const parsed = reg.parseRepoRef(args.repo);
        if (!parsed) return '仓库地址看不懂：' + args.repo;
        const full = parsed.owner + '/' + parsed.repo;
        const dir = String(args.path || '').replace(/\/SKILL\.md$/i, '').replace(/^\/+|\/+$/g, '');
        const file = dir ? dir + '/SKILL.md' : 'SKILL.md';
        const meta = await reg.readSkillMeta(full, args.ref || 'main', file);
        if (meta.error) return '读取失败：' + meta.error + '\n（也可能是分支不对，试试 main 或 master）';
        return '仓库：' + full + '\n路径：' + file + '\n\n' + meta.head;
      },
    );

    api.addTool(
      {
        name: 'skill_install',
        description: '把一份技能默认装进用户全局技能库（~/.agents/skills/，跨项目通用，装完当轮就能用 use_skill 取到；也可以显式传 scope="workspace" 装入当前工作区）。同一份再装一次是覆盖。装之前要用户点头。',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: '仓库，形如 owner/name' },
            path: { type: 'string', description: '技能目录，例如 skills/pdf' },
            ref: { type: 'string', description: '分支，不填自动试' },
            name: { type: 'string', description: '装成什么名字，不填用技能自己声明的名字' },
            scope: { type: 'string', enum: ['user', 'workspace'], description: '安装位置，默认 user（用户全局）' },
          },
          required: ['repo'],
        },
      },
      async (args) => {
        const parsed = reg.parseRepoRef(args.repo);
        if (!parsed) return '仓库地址看不懂：' + args.repo;
        const full = parsed.owner + '/' + parsed.repo;
        const dir = String(args.path || '').replace(/\/SKILL\.md$/i, '').replace(/^\/+|\/+$/g, '');
        if (!llmMayInstall()) return denyLlmInstall(full + (dir ? '/' + dir : ''));
        try {
          const bundle = await reg.fetchSkillBundle(full, args.ref || '', dir, token());
          if (!bundle.files.length) return '这个目录下没抓到文件（检查 repo / path / ref 是否对得上）';
          const meta = reg.parseFront((bundle.files.find((f) => f.path === 'SKILL.md') || {}).text || '');
          const scope = args.scope || installScope();
          const res = lib.installSkill(root, {
            group: full,
            name: args.name || meta.name || dir.split('/').pop() || full.split('/').pop(),
            files: bundle.files,
            repo: full,
            ref: bundle.ref,
            path: dir,
            url: 'https://github.com/' + full,
            scope,
          });
          syncInstalled();
          return '已装好技能「' + res.name + '」：' + res.dir + '（' + res.files + ' 个文件' + (scope === 'user' ? '，用户全局可用' : '') + '）\n当轮即可用 use_skill 取用。';
        } catch (e) {
          return '安装失败：' + ((e && e.message) || e);
        }
      },
    );

    api.addTool(
      {
        name: 'skill_uninstall',
        description: '卸掉一份已装的技能（整个目录连根删）。id 形如 owner__name/技能名，用 skill_list 查。',
        parameters: { type: 'object', properties: { id: { type: 'string', description: '要卸的技能 id' } }, required: ['id'] },
      },
      async (args) => {
        const res = lib.uninstallSkill(root, args.id);
        if (!res.ok) return '卸载失败：' + res.error;
        syncInstalled();
        return '已卸载：' + res.removed;
      },
    );

    api.addTool(
      {
        name: 'skill_list',
        description: '列出本工作区里已经装进来的技能（这些当轮就能 use_skill 取用）。',
        parameters: { type: 'object', properties: {} },
      },
      async () => {
        const installed = lib.listInstalledSkills(root);
        return s({ count: installed.length, installed });
      },
    );

    api.addTool(
      {
        name: 'mcp_search',
        description: '在 MCP 官方注册表里搜服务（几万条，一直在更新）。返回的 launch 字段可直接启动；requiresConfig 为 true 的要先补环境变量。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键词，例如 github、filesystem、postgres' },
            limit: { type: 'number', description: '要几条，默认 40' },
          },
        },
      },
      async (args) => {
        const q = String(args.query || '').trim();
        const want = clamp(args.limit || 40, 1, 120);
        const cur = readCache(api);
        const cached = cur.mcp && cur.mcp.query === q ? cur.mcp.items || [] : null;
        if (cached && cached.length >= Math.min(want, 20)) {
          return s({ query: q, count: Math.min(want, cached.length), source: 'cache', items: cached.slice(0, want) });
        }
        try {
          const got = await collectMcp(q, Math.max(want, 80));
          patchCache(api, { mcp: Object.assign({}, got, { source: 'live', installed: lib.listInstalledMcp(root, dataRoot), at: new Date().toISOString() }) });
          return s({ query: got.query, count: got.items.length, source: 'live', items: got.items.slice(0, want) });
        } catch (e) {
          return '搜索失败：' + ((e && e.message) || e);
        }
      },
    );

    api.addTool(
      {
        name: 'mcp_install',
        description: '把一个 MCP 服务装进用户全局配置（~/.agents/mcp.json，跨项目通用，装完后全局 mcp 插件会自动连接；也可显式传 scope="workspace" 装入当前工作区）。name 用 mcp_search 返回的 name。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'mcp_search 返回的 name（注册表里的全名）' },
            alias: { type: 'string', description: '想叫它什么，不填用它的标题' },
            auto_connect: { type: 'boolean', description: '装完是否立刻连，默认 true' },
            scope: { type: 'string', enum: ['user', 'workspace'], description: '安装位置，默认 user（用户全局）' },
          },
          required: ['name'],
        },
      },
      async (args) => {
        try {
          const got = await collectMcp(args.name, 50);
          const hit = got.items.find((x) => x.name === args.name) || got.items[0];
          if (!hit) return '注册表里没找到：' + args.name;
          if (!hit.launch) return '这条服务只有远程地址（' + (hit.remotes[0] && hit.remotes[0].url) + '），本插件走的是本地进程，装不了。';
          if (!llmMayInstall()) return denyLlmInstall(hit.title + '（' + hit.name + '）');
          const scope = args.scope || installScope();
          const res = lib.installMcp(root, {
            name: args.alias || hit.title || hit.name,
            launch: hit.launch,
            source: 'registry',
            registryId: hit.name,
            repository: hit.repository,
            title: hit.title,
            description: hit.description,
            envNames: hit.envNames,
            remotes: hit.remotes,
            scope,
          });
          if (!res.ok) return '安装失败：' + res.error;
          syncInstalled();
          const need = hit.envNames.filter((v) => v.required).map((v) => v.name);
          return '已装好 MCP 服务「' + res.name + '」(' + (scope === 'user' ? '用户全局' : '工作区') + ')：' + hit.launch.command + ' ' + hit.launch.args.join(' ') +
            (need.length ? '\n还需要补环境变量：' + need.join('、') : '');
        } catch (e) {
          return '安装失败：' + ((e && e.message) || e);
        }
      },
    );

    api.addTool(
      {
        name: 'mcp_uninstall',
        description: '卸掉一个通过生态市场装进来的 MCP 服务（配置和出厂记录一起删，用户自己手加的不受影响）。',
        parameters: { type: 'object', properties: { name: { type: 'string', description: '服务名' } }, required: ['name'] },
      },
      async (args) => {
        const res = lib.uninstallMcp(root, args.name, dataRoot);
        if (!res.ok) return '卸载失败：' + res.error;
        syncInstalled();
        return '已卸载 MCP 服务：' + res.removed;
      },
    );

    api.addTool(
      {
        name: 'market_status',
        description: '看生态市场此刻的状态：出厂/用户加了哪些技能源、装了几个技能和 MCP 服务、最近一次刷新是什么时候。',
        parameters: { type: 'object', properties: {} },
      },
      async () => {
        const st = state();
        const cache = readCache(api);
        return s({
          sources: readSources(st, 'skill').map((x) => ({ id: x.id, label: x.label, repo: x.repo, builtin: !!x.builtin })),
          cacheAt: cache.updatedAt || '',
          skills: (cache.skills && cache.skills.repos || []).map((r) => ({ repo: r.repo, total: r.total, error: r.error || '' })),
          installedSkills: lib.listInstalledSkills(root).length,
          installedMcp: lib.listInstalledMcp(root, dataRoot).length,
          mcpCacheAt: (cache.mcp && cache.mcp.at) || '',
        });
      },
    );
  }

  return { refreshSkills, refreshMcp, syncInstalled, handleCommand, registerTools, readSources, writeSources };
}

module.exports = { CACHE_FILE, createEcosystem, readCache, patchCache, readSources, writeSources, collectMcp, defaultSources };
