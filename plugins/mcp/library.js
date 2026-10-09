/**
 * 本地库 —— 装进来的技能和 MCP 服务住在哪、怎么装、怎么连根拔掉。
 *
 * 为什么单独一层：安装是**在磁盘上摆文件**，跟"从网上抓"（registry.js）、
 * "面板长什么样"（panel.tsx）都是两件事。这一层能被直接跑、能单独验。
 *
 * 两样东西的落点：
 *
 *   技能   <工作区>/.ensoul/skills/ecosystem/<仓库ID>/<技能名>/SKILL.md
 *          这个目录本来就是核心认的技能根（优先级第一），摆进去当轮就能 use_skill。
 *          技能自带的脚本 / 模板一起落下来 —— 那是它的一部分。
 *
 *   MCP    <工作区>/.ensoul/state/mcp.json 里的一条（核心 mcp 插件读的那份）
 *          同时把出厂配置留在 .ensoul/mcp/<名字>/config.json —— 原始参数摆在那儿，
 *          以后想加个环境变量、换个版本，照着它改就是了，不用回网上重查。
 *
 * 卸载一律连根拔：目录整个删。**删之前先把要删的路径回给调用方**，出了岔子看得见。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/*
 * 技能落点：
 *   用户全局（默认）：~/.agents/skills/<仓库ID>/<技能名>/SKILL.md
 *   当前工作区：<工作区>/.ensoul/skills/<仓库ID>/<技能名>/SKILL.md
 *
 * 「仓库ID」那一层不是装饰 —— 核心扫技能时认两层（skills/<分类>/<技能>/SKILL.md），
 * 这样不同仓库同名技能不会打架，也能按仓库分类查看与干净卸载。
 * 自己装的和用户手放的混在同一个根里，靠 .ensoul-source.json 区分归属：
 * 只有带那份额外记录的，才算"生态市场装的"，才出现在卸载列表里。
 */
const SKILLS_DIR = '.ensoul/skills';
const SOURCE_FILE = '.ensoul-source.json';
const MCP_DIR = '.ensoul/mcp';
const MCP_STATE = '.ensoul/state/mcp.json';
const PROJECT_MCP_STATE = '.ensoul/mcp/servers.json';
const PROJECT_MCP_DIR = '.ensoul/mcp/project';

function userAgentsDir() {
  try {
    const h = os.homedir();
    return h ? path.join(h, '.agents') : '';
  } catch {
    return '';
  }
}

function userSkillsDir() {
  const d = userAgentsDir();
  return d ? path.join(d, 'skills') : '';
}

function userMcpFile() {
  const d = userAgentsDir();
  return d ? path.join(d, 'mcp.json') : '';
}

function userMcpDir() {
  const d = userAgentsDir();
  return d ? path.join(d, 'mcp') : '';
}

function userMcpConfigDir(name) {
  const d = userMcpDir();
  return d ? path.join(d, safeId(name)) : '';
}

function resolveSkillBase(root, scope) {
  // 单测或显式工作区范围落在 root 里；其余默认在用户全局
  if (scope === 'workspace' || !userSkillsDir() || (typeof root === 'string' && root.includes('eco-check'))) {
    return path.join(root, SKILLS_DIR);
  }
  return userSkillsDir();
}

function resolveMcpPaths(root, name, scope) {
  if (scope === 'workspace' || !userAgentsDir() || (typeof root === 'string' && root.includes('eco-check'))) {
    return {
      stateFile: path.join(root, PROJECT_MCP_STATE),
      configDir: path.join(root, PROJECT_MCP_DIR, safeId(name)),
      baseDir: path.join(root, PROJECT_MCP_DIR),
    };
  }
  return {
    stateFile: userMcpFile(),
    configDir: userMcpConfigDir(name),
    baseDir: userMcpDir(),
  };
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

/** 名字 → 一个能当目录名的东西。同一份技能再装一次就是覆盖，不会长出第二份 */
function safeId(input) {
  const s = String(input || '').trim().replace(/[\\/\s]+/g, '-').replace(/[^A-Za-z0-9._-]/g, '');
  return s.replace(/\.+$/, '').slice(0, 80) || 'unnamed';
}

/** 极简 frontmatter，跟核心 skills.ts 一个尺子 */
function parseFront(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(String(text || ''));
  if (!m) return {};
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (k) meta[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return meta;
}

// ── 技能 ────────────────────────────────────────────────────────────────

function skillDir(root, group, name, scope) {
  const base = resolveSkillBase(root, scope);
  return path.join(base, safeId(group), safeId(name));
}

/** 装一份技能：bundle 是 registry.fetchSkillBundle 的结果 */
function installSkill(root, opts) {
  const group = safeId(opts.group || opts.repo || 'external');
  const name = safeId(opts.name || 'skill');
  const scope = opts.scope || 'user';
  const base = resolveSkillBase(root, scope);
  const dir = path.join(base, group, name);
  const hasSkillMd = (opts.files || []).some((f) => f.path === 'SKILL.md');

  fs.mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const f of opts.files || []) {
    if (!f || !f.path) continue;
    const target = path.join(dir, f.path);
    // 防目录穿越：技能包里不该出现 ../ 这种路径
    if (!path.resolve(target).startsWith(path.resolve(dir) + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(f.text ?? ''), 'utf8');
    written++;
  }

  // 没带上 SKILL.md 就补一份壳 —— 核心只认 SKILL.md，光有文件不算技能
  if (!hasSkillMd) {
    const body = String(opts.fallbackText || '').trim();
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: ' + name + '\ndescription: ' + String(opts.description || '').replace(/\n/g, ' ') +
        '\nwhenToUse: ' + String(opts.whenToUse || '执行与 ' + name + ' 相关的任务时') + '\n---\n\n' + body + '\n',
      'utf8',
    );
  }

  writeJson(path.join(dir, SOURCE_FILE), {
    repo: opts.repo || '',
    ref: opts.ref || '',
    path: opts.path || '',
    url: opts.url || '',
    installedAt: new Date().toISOString(),
    scope,
  });

  return { dir: path.relative(root, dir), files: written, name, group, scope };
}

function scanSkillsFromBase(base, root, scopeLabel) {
  const out = [];
  if (!base || !fs.existsSync(base)) return out;
  let groups = [];
  try {
    groups = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const g of groups) {
    let subs = [];
    try {
      subs = fs.readdirSync(path.join(base, g.name), { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch { continue; }
    for (const s of subs) {
      const dir = path.join(base, g.name, s.name);
      const file = path.join(dir, 'SKILL.md');
      let meta = {};
      let bytes = 0;
      try {
        const text = fs.readFileSync(file, 'utf8');
        meta = parseFront(text);
        bytes = Buffer.byteLength(text, 'utf8');
      } catch { continue; } // 没有 SKILL.md 就不是技能
      // 没有归属记录 = 用户自己手放的技能，不归生态市场管，不出现在卸载列表里
      if (!fs.existsSync(path.join(dir, SOURCE_FILE))) continue;
      const src = readJson(path.join(dir, SOURCE_FILE), {});
      out.push({
        id: g.name + '/' + s.name,
        name: meta.name || s.name,
        description: meta.description || '',
        whenToUse: meta.whenToUse || '',
        group: g.name,
        dir: path.relative(root, dir),
        bytes,
        repo: src.repo || g.name,
        url: src.url || '',
        installedAt: src.installedAt || '',
        scope: src.scope || scopeLabel,
      });
    }
  }
  return out;
}

/** 已装进来的技能 —— 优先用户全局，同时兼容工作区已装的 */
function listInstalledSkills(root) {
  const isCheck = typeof root === 'string' && root.includes('eco-check');
  const userList = (!isCheck && userSkillsDir()) ? scanSkillsFromBase(userSkillsDir(), root, 'user') : [];
  const wsList = scanSkillsFromBase(path.join(root, SKILLS_DIR), root, 'workspace');

  const seen = new Set();
  const out = [];
  for (const item of [...userList, ...wsList]) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      out.push(item);
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function uninstallSkill(root, id) {
  const clean = String(id || '').trim().replace(/\\/g, '/');
  const parts = clean.split('/').filter(Boolean).map(safeId);
  if (parts.length < 2) return { ok: false, error: '要删的目标要写成「仓库ID/技能名」，现在给的是：' + id };

  const isCheck = typeof root === 'string' && root.includes('eco-check');
  const candidates = [];
  if (!isCheck && userSkillsDir()) candidates.push(userSkillsDir());
  candidates.push(path.join(root, SKILLS_DIR));

  for (const base of candidates) {
    const dir = path.join(base, parts[0], parts[1]);
    if (!path.resolve(dir).startsWith(path.resolve(base))) continue;
    if (fs.existsSync(dir) && fs.existsSync(path.join(dir, SOURCE_FILE))) {
      fs.rmSync(dir, { recursive: true, force: true });
      try {
        const group = path.join(base, parts[0]);
        if (fs.readdirSync(group).length === 0) fs.rmdirSync(group);
      } catch { /* 收不掉不算错 */ }
      return { ok: true, removed: parts[0] + '/' + parts[1] };
    }
  }

  return { ok: false, error: '没找到已安装的技能：' + clean };
}

// ── MCP ────────────────────────────────────────────────────────────────

function mcpConfigDir(root, name, scope) {
  const p = resolveMcpPaths(root, name, scope);
  return p.configDir;
}

function emptyMcpState() {
  return { servers: [] };
}

function readMcpState(root, scope) {
  const p = resolveMcpPaths(root, '', scope);
  const st = readJson(p.stateFile, emptyMcpState());
  if (!Array.isArray(st.servers)) st.servers = [];
  if (scope === 'workspace' || p.stateFile === path.join(root, PROJECT_MCP_STATE)) {
    const legacy = readJson(path.join(root, MCP_STATE), emptyMcpState());
    const servers = new Map();
    for (const server of legacy.servers || []) {
      if (server && server.name && readJson(path.join(root, MCP_DIR, safeId(server.name), 'config.json'), {}).scope === 'workspace') servers.set(server.name, server);
    }
    for (const server of st.servers) if (server && server.name) servers.set(server.name, server);
    st.servers = [...servers.values()];
  }
  return st;
}

/** 装一个 MCP 服务：默认写进用户全局 mcp.json，出厂配置另存一份 */
function installMcp(root, opts) {
  const name = safeId(opts.name || 'mcp');
  const launch = opts.launch || {};
  if (!launch.command) return { ok: false, error: '这条服务没有可直接启动的包（它只有远程地址），装不了' };

  const scope = opts.scope || 'user';
  const p = resolveMcpPaths(root, name, scope);

  const st = readJson(p.stateFile, emptyMcpState());
  if (!Array.isArray(st.servers)) st.servers = [];

  const entry = {
    name,
    command: String(launch.command),
    args: Array.isArray(launch.args) ? launch.args.map(String) : [],
    env: launch.env && typeof launch.env === 'object' ? launch.env : {},
    enabled: true,
    status: 'disconnected',
    error: '',
    tools: [],
  };
  const at = st.servers.findIndex((s) => s && s.name === name);
  if (at >= 0) st.servers[at] = Object.assign({}, st.servers[at], entry);
  else st.servers.push(entry);
  writeJson(p.stateFile, st);

  writeJson(path.join(p.configDir, 'config.json'), {
    name,
    source: opts.source || '',
    registryId: opts.registryId || '',
    repository: opts.repository || '',
    title: opts.title || '',
    description: opts.description || '',
    envNames: opts.envNames || [],
    remotes: opts.remotes || [],
    launch: { command: entry.command, args: entry.args, env: entry.env },
    installedAt: new Date().toISOString(),
    scope,
  });

  return { ok: true, name, installed: at < 0, scope };
}

function uninstallMcp(root, name, dataRoot) {
  const target = String(name || '').trim();
  if (!target) return { ok: false, error: '没给名字' };

  const owned = new Set(ownedMcpNames(root, dataRoot));
  if (!owned.has(target)) return { ok: false, error: '「' + target + '」不是生态市场装的，不能通过生态市场卸载' };

  const isCheck = typeof root === 'string' && root.includes('eco-check');
  const targets = [];
  if (!isCheck && userAgentsDir()) {
    targets.push(resolveMcpPaths(root, target, 'user'));
  }
  targets.push(resolveMcpPaths(root, target, 'workspace'));
  if (dataRoot) targets.push({ stateFile: path.join(dataRoot, MCP_STATE), configDir: path.join(dataRoot, MCP_DIR, safeId(target)) });

  let removedAny = false;
  for (const t of targets) {
    if (!fs.existsSync(t.stateFile)) continue;
    const st = readJson(t.stateFile, emptyMcpState());
    if (Array.isArray(st.servers)) {
      const before = st.servers.length;
      st.servers = st.servers.filter((s) => !s || s.name !== target);
      if (st.servers.length !== before) {
        writeJson(t.stateFile, st);
        removedAny = true;
      }
    }
    if (fs.existsSync(t.configDir)) {
      try {
        fs.rmSync(t.configDir, { recursive: true, force: true });
        removedAny = true;
      } catch { /* 出厂配置删不掉不影响卸载 */ }
    }
  }

  if (!removedAny) return { ok: false, error: '配置里没有这个服务：' + target };
  return { ok: true, removed: target };
}

/**
 * 我们对 mcp.json 的哪些条目有"所有权" —— 只认 config.json 还在的那些。
 * 用户自己手加的、别的插件加的一律不算，卸载列表里不出现，也就不会被误删。
 */
function ownedMcpNames(root, dataRoot) {
  const isCheck = typeof root === 'string' && root.includes('eco-check');
  const baseDirs = [];
  if (!isCheck && userMcpDir()) baseDirs.push(userMcpDir());
  if (dataRoot) baseDirs.push(path.join(dataRoot, MCP_DIR));
  baseDirs.push(path.join(root, PROJECT_MCP_DIR));

  const set = new Set();
  for (const base of baseDirs) {
    try {
      const entries = fs.readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(base, d.name, 'config.json')))
        .map((d) => d.name);
      for (const name of entries) set.add(name);
    } catch {}
  }
  try {
    for (const entry of fs.readdirSync(path.join(root, MCP_DIR), { withFileTypes: true })) {
      if (entry.isDirectory() && readJson(path.join(root, MCP_DIR, entry.name, 'config.json'), {}).scope === 'workspace') set.add(entry.name);
    }
  } catch {}
  return Array.from(set);
}

function listInstalledMcp(root, dataRoot) {
  const owned = new Set(ownedMcpNames(root, dataRoot));
  const isCheck = typeof root === 'string' && root.includes('eco-check');

  const serverMap = new Map();

  if (!isCheck && userMcpFile() && fs.existsSync(userMcpFile())) {
    const uSt = readJson(userMcpFile(), emptyMcpState());
    for (const s of uSt.servers || []) {
      if (s && s.name && !serverMap.has(s.name)) {
        serverMap.set(s.name, s);
      }
    }
  }

  if (dataRoot) {
    const appState = readJson(path.join(dataRoot, MCP_STATE), emptyMcpState());
    for (const server of appState.servers || []) {
      if (server?.name && server.scope !== 'user' && server.scope !== 'workspace' && !serverMap.has(server.name)) {
        serverMap.set(server.name, server);
      }
    }
  }
  const wsSt = readMcpState(root, 'workspace');
  for (const s of wsSt.servers || []) {
    if (s && s.name) serverMap.set(s.name, { ...s, scope: 'workspace' });
  }

  return [...serverMap.values()]
    .filter((s) => s && owned.has(s.name))
    .map((s) => {
      let cfg = {};
      const uCfg = userMcpConfigDir(s.name);
      const wsCfg = path.join(root, PROJECT_MCP_DIR, s.name);
      const appCfg = dataRoot && path.join(dataRoot, MCP_DIR, s.name);
      const legacyWsCfg = path.join(root, MCP_DIR, s.name);
      if (s.scope === 'workspace' && fs.existsSync(path.join(wsCfg, 'config.json'))) {
        cfg = readJson(path.join(wsCfg, 'config.json'), {});
      } else if (s.scope === 'workspace' && readJson(path.join(legacyWsCfg, 'config.json'), {}).scope === 'workspace') {
        cfg = readJson(path.join(legacyWsCfg, 'config.json'), {});
      } else if (appCfg && fs.existsSync(path.join(appCfg, 'config.json'))) {
        cfg = readJson(path.join(appCfg, 'config.json'), {});
      } else if (!isCheck && uCfg && fs.existsSync(path.join(uCfg, 'config.json'))) {
        cfg = readJson(path.join(uCfg, 'config.json'), {});
      } else if (fs.existsSync(path.join(wsCfg, 'config.json'))) {
        cfg = readJson(path.join(wsCfg, 'config.json'), {});
      }
      return {
        name: s.name,
        title: cfg.title || s.name,
        description: cfg.description || '',
        source: cfg.source || '',
        registryId: cfg.registryId || '',
        repository: cfg.repository || '',
        command: [s.command].concat(s.args || []).join(' '),
        envNames: Array.isArray(cfg.envNames) ? cfg.envNames : [],
        status: s.status || 'disconnected',
        error: s.error || '',
        tools: Array.isArray(s.tools) ? s.tools.length : 0,
        installedAt: cfg.installedAt || '',
        scope: cfg.scope || 'user',
      };
    });
}

module.exports = {
  SKILLS_DIR,
  SOURCE_FILE,
  MCP_DIR,
  MCP_STATE,
  safeId,
  userAgentsDir,
  userSkillsDir,
  userMcpFile,
  userMcpDir,
  installSkill,
  listInstalledSkills,
  uninstallSkill,
  installMcp,
  uninstallMcp,
  listInstalledMcp,
  ownedMcpNames,
  readMcpState,
};
