/**
 * MCP (Model Context Protocol) 插件 —— 接入 Anthropic / 开源 MCP 生态。
 *
 * 通过 stdio (JSON-RPC 2.0) 管理和连接外部 MCP Server，
 * 自动发现工具，并允许智能体和用户直接调用。
 *
 * 状态：.ensoul/state/mcp.json
 * 命令：.ensoul/state/mcp.cmd.json
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
/*
 * 自家那三个子模块的缓存先清掉，再 require。
 *
 * 为什么非清不可：核心重挂插件时只 `delete require.cache[插件 index.js]` 那一条，
 * 它 require 出来的子模块还留在缓存里 —— 于是「改 registry.js / ecosystem.js 没反应」，
 * 而且不报错（跟改了插件却没生效是同一个坑，只是深了一层）。
 */
for (const sub of ['./registry', './library', './ecosystem']) {
  try { delete require.cache[require.resolve(sub)]; } catch (_) { /* 还没解析过就算了 */ }
}
const ecosystem = require('./ecosystem');
const library = require('./library');

const STATE_FILE = '.ensoul/state/mcp.json';
const CMD_FILE = '.ensoul/state/mcp.cmd.json';
const TICK_INTERVAL = 800;
/** 面板上能调的（助手改参数走 plugin_params，见 plugins/plugin-kit） */
const PARAMS = {
  installScope: { label: t('默认安装位置'), type: 'select', default: 'user', options: ['user', 'workspace'], hint: t('user = 用户全局 (~/.agents/)，跨所有项目生效；workspace = 仅当前项目 (.ensoul/)') },
  allowLlmInstall: { label: t('允许助手自行装载'), type: 'bool', default: false, hint: t('打开后助手能自己装技能和 MCP 服务（装了哪些在面板「已装载」里，随时能卸）；关着就只能查、不能装') },
  proxy: { label: t('代理地址'), type: 'text', default: '', hint: t('联网走这条代理（http:// 或 socks5://），本机常见的填 http://127.0.0.1:7897；留空 = 跟系统代理走') },
  githubToken: { label: t('GitHub token'), type: 'text', default: '', hint: t('不填也能用，填了搜索顺畅很多（匿名每小时只有几次）') },
  perRepoSkills: { label: t('每个仓库最多列几个技能'), type: 'number', default: 200, min: 10, max: 400, hint: t('大仓库动辄几百份。调太高会把面板缓存撑过 300KB 读不动，别贪') },
  mcpPageSize: { label: t('MCP 搜索一次取几条'), type: 'number', default: 80, min: 20, max: 200 },
  discoverPerTopic: { label: t('自动找源：每个主题取几个'), type: 'number', default: 12, min: 5, max: 50, hint: t('按 GitHub 主题（claude-skills 等）搜技能库，取热度最高的前几个') },
  refreshGapSec: { label: t('同一关键词多久内不重复联网'), type: 'number', default: 300, min: 30, max: 86400, hint: t('面板切来切去时，别把注册表和 GitHub 反复打一遍（秒）') },
};

// 活动连接字典：serverName -> { process, pendingRequests: Map, buffer: string, ready: boolean, tools: [] }
const activeServers = new Map();

let timer = null;
let lastSeq = 0;
let apiHost = null;
/** 生态层的调度台（setup 时建，命令队列要用） */
let eco = null;
/** 上一次联网刷新是什么时候 —— 面板点得太勤时拦住 */
let lastRefresh = 0;

function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const servers = Array.isArray(r.servers) ? r.servers : [];
  return {
    ...r,
    servers: servers.map((s) => ({
      ...s,
      name: String(s.name || '').trim(),
      command: String(s.command || '').trim(),
      args: Array.isArray(s.args) ? s.args.map(String) : [],
      env: s.env && typeof s.env === 'object' ? s.env : {},
      enabled: s.enabled !== false,
      status: 'disconnected', // 'connected' | 'connecting' | 'disconnected' | 'error'
      error: '',
      tools: Array.isArray(s.tools) ? s.tools : []
    })).filter((s) => s.name && s.command),
    lastActive: Date.now()
  };
}

function loadState(api) {
  const appState = api.state.load(normalize({ servers: [] }));
  const projectState = library.readMcpState(api.workspace, 'workspace');
  const globalFile = library.userMcpFile ? library.userMcpFile() : '';
  let globalServers = [];
  if (globalFile && fs.existsSync(globalFile)) {
    try {
      const gRaw = JSON.parse(fs.readFileSync(globalFile, 'utf8'));
      if (Array.isArray(gRaw.servers)) globalServers = gRaw.servers;
    } catch {}
  }
  const map = new Map();
  for (const s of globalServers) if (s && s.name) map.set(s.name, { ...s, scope: 'user' });
  for (const s of appState.servers || []) {
    if (!s || !s.name || s.scope === 'user' || s.scope === 'workspace') continue;
    map.set(s.name, s);
  }
  for (const s of projectState.servers) if (s && s.name) map.set(s.name, { ...s, scope: 'workspace', workspace: api.workspace });
  return normalize({ ...appState, servers: Array.from(map.values()), lastActive: appState.lastActive || Date.now() });
}

function saveState(api, st) {
  try {
    api.state.save(st);
  } catch (e) {
    api.log(t('[MCP] 保存状态失败:'), e.message);
  }
  const globalFile = library.userMcpFile ? library.userMcpFile() : '';
  if (globalFile && fs.existsSync(globalFile)) {
    try {
      const gRaw = JSON.parse(fs.readFileSync(globalFile, 'utf8'));
      if (Array.isArray(gRaw.servers) && gRaw.servers.length > 0) {
        const currentMap = new Map((st.servers || []).filter((s) => s.scope !== 'workspace').map((s) => [s.name, s]));
        const updated = gRaw.servers.map((s) => {
          const live = currentMap.get(s.name);
          return live ? Object.assign({}, s, { status: live.status, error: live.error, tools: live.tools }) : s;
        });
        fs.writeFileSync(globalFile, JSON.stringify({ ...gRaw, servers: updated }, null, 2), 'utf8');
      }
    } catch {}
  }
}

// 发送 JSON-RPC 消息到子进程
function sendRpc(serverEntry, proc, method, params, id) {
  return new Promise((resolve, reject) => {
    if (!proc || proc.killed) {
      return reject(new Error(t('MCP 进程未运行')));
    }
    const req = {
      jsonrpc: '2.0',
      id: id !== undefined ? id : Date.now() + Math.random(),
      method,
      params
    };
    if (req.id !== null) {
      serverEntry.pendingRequests.set(req.id, { resolve, reject, timer: setTimeout(() => {
        serverEntry.pendingRequests.delete(req.id);
        reject(new Error(`请求超时 (${method})`));
      }, 30000) });
    }
    try {
      proc.stdin.write(JSON.stringify(req) + '\n');
      if (req.id === null) resolve();
    } catch (err) {
      reject(err);
    }
  });
}

// 处理 stdio 数据流
function handleStdoutChunk(serverEntry, chunk, serverName, onToolsUpdate) {
  serverEntry.buffer += chunk.toString('utf8');
  let newlineIdx;
  while ((newlineIdx = serverEntry.buffer.indexOf('\n')) !== -1) {
    const line = serverEntry.buffer.slice(0, newlineIdx).trim();
    serverEntry.buffer = serverEntry.buffer.slice(newlineIdx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && serverEntry.pendingRequests.has(msg.id)) {
        const req = serverEntry.pendingRequests.get(msg.id);
        clearTimeout(req.timer);
        serverEntry.pendingRequests.delete(msg.id);
        if (msg.error) {
          req.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          req.resolve(msg.result);
        }
      }
    } catch (e) {
      // 忽略无法解析的调试输出行
    }
  }
}

// 修复 Windows 下缺少 shebang 的 npm 包垫片，防止调用裸 .js 唤起系统默认编辑器（如 VS Code）
function sanitizeWindowsNpxShim(serverConf) {
  if (process.platform !== 'win32') return;
  if (serverConf.command !== 'npx' || !Array.isArray(serverConf.args)) return;

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return;
  const npxCacheDir = path.join(localAppData, 'npm-cache', '_npx');
  if (!fs.existsSync(npxCacheDir)) return;

  try {
    const hashes = fs.readdirSync(npxCacheDir);
    for (const h of hashes) {
      const binDir = path.join(npxCacheDir, h, 'node_modules', '.bin');
      if (!fs.existsSync(binDir)) continue;
      const cmdFiles = fs.readdirSync(binDir).filter((f) => f.endsWith('.cmd'));
      for (const cmdFile of cmdFiles) {
        const cmdPath = path.join(binDir, cmdFile);
        const cmdContent = fs.readFileSync(cmdPath, 'utf8');
        const nakedJsRegex = /^(\s*)"(%dp0%[^"\r\n]+\.js)"(\s*%\*.*)$/m;
        if (nakedJsRegex.test(cmdContent)) {
          const fixed = cmdContent.replace(
            nakedJsRegex,
            '$1IF EXIST "%dp0%\\\\node.exe" (\r\n  "%dp0%\\\\node.exe" "$2"$3\r\n) ELSE (\r\n  node "$2"$3\r\n)'
          );
          fs.writeFileSync(cmdPath, fixed, 'utf8');
        }
      }
    }
  } catch (_) {}
}

// 连接单个 MCP 服务器
async function connectServer(serverConf, api) {
  const name = serverConf.name;
  if (activeServers.has(name)) {
    const existing = activeServers.get(name);
    if (existing.ready) return existing;
    // 如果存在但未就绪，先关闭
    disconnectServer(name);
  }

  sanitizeWindowsNpxShim(serverConf);

  const serverEntry = {
    process: null,
    pendingRequests: new Map(),
    buffer: '',
    ready: false,
    tools: []
  };
  activeServers.set(name, serverEntry);

  try {
    const child = spawn(serverConf.command, serverConf.args, {
      cwd: api.workspace,
      env: { ...process.env, ...serverConf.env },
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    serverEntry.process = child;

    child.stdout.on('data', (c) => handleStdoutChunk(serverEntry, c, name));
    child.stderr.on('data', (c) => {
      api.log(`[MCP ${name} stderr]`, c.toString('utf8').trim());
    });

    child.on('error', (err) => {
      api.log(`[MCP ${name}] 启动失败:`, err.message);
      serverEntry.ready = false;
      updateServerStatus(api, name, 'error', err.message);
    });

    child.on('close', (code) => {
      serverEntry.ready = false;
      activeServers.delete(name);
      updateServerStatus(api, name, 'disconnected', `进程退出，代码 ${code}`);
    });

    // 1. 初始化 MCP 握手
    const initRes = await sendRpc(serverEntry, child, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'ensoul-mcp', version: '1.0.0' }
    });

    // 2. 发送 initialized 通知
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    } catch (_) {}

    // 3. 拉取可用工具
    const toolsRes = await sendRpc(serverEntry, child, 'tools/list', {});
    const tools = (toolsRes && Array.isArray(toolsRes.tools)) ? toolsRes.tools : [];
    serverEntry.tools = tools;
    serverEntry.ready = true;

    updateServerStatus(api, name, 'connected', '', tools);
    return serverEntry;
  } catch (err) {
    serverEntry.ready = false;
    updateServerStatus(api, name, 'error', err.message);
    throw err;
  }
}

function disconnectServer(name) {
  if (!activeServers.has(name)) return;
  const entry = activeServers.get(name);
  try {
    if (entry.process && !entry.process.killed) {
      entry.process.kill();
    }
  } catch (_) {}
  activeServers.delete(name);
}

function updateServerStatus(api, name, status, error = '', tools = null) {
  const st = loadState(api);
  const target = st.servers.find((s) => s.name === name);
  if (target) {
    target.status = status;
    target.error = error;
    if (tools !== null) target.tools = tools;
    saveState(api, st);
    api.refresh();
  }
}

/**
 * 让生态层去网上刷一遍。节流在**这里**、不在生态层里 ——
 * 面板点刷新是用户明确要的，该立刻动；这里拦的是开机那次自动拉、以及日志里
 * 那种"一连串命令把 GitHub 打爆"的情况（匿名搜索每小时只有几次）。
 */
function refreshMarket(reason) {
  const now = Date.now();
  if (now - lastRefresh < 5000) return;
  lastRefresh = now;
  if (!eco) return;
  eco.refreshSkills(reason).catch(() => {});
  eco.refreshMcp('').catch(() => {});
}

// 轮询命令通道
function checkCommands(api) {
  const cmdPath = api.dataPath(CMD_FILE);
  if (!fs.existsSync(cmdPath)) return;
  try {
    const raw = fs.readFileSync(cmdPath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data.seq !== 'number' || data.seq <= lastSeq) return;
    lastSeq = data.seq;

    const cmds = Array.isArray(data.cmds) ? data.cmds : [];
    for (const cmd of cmds) {
      if (!cmd || typeof cmd.action !== 'string') continue;
      // 生态市场那一批（刷新、装载、卸载、加源）转交生态层 —— 它们要联网、要等，
      // 别卡住这条 800ms 的心跳。跑完生态层自己会喊界面重画。
      if (/^(market_|skill_|mcp_install$|mcp_uninstall$)/.test(cmd.action)) {
        if (eco) eco.handleCommand(cmd).catch((e) => api.log('[market] 命令失败：' + ((e && e.message) || e)));
        else api.log('[market] 还没准备好，忽略了命令：' + cmd.action);
        continue;
      }
      if (cmd.action === 'connect') {
        const st = loadState(api);
        const s = st.servers.find((x) => x.name === cmd.name);
        if (s) connectServer(s, api).catch(() => {});
      } else if (cmd.action === 'disconnect') {
        disconnectServer(cmd.name);
        updateServerStatus(api, cmd.name, 'disconnected');
      } else if (cmd.action === 'add') {
        const st = loadState(api);
        const exists = st.servers.find((x) => x.name === cmd.name);
        if (!exists) {
          st.servers.push({
            name: cmd.name,
            command: cmd.command,
            args: cmd.args || [],
            env: cmd.env || {},
            enabled: true,
            status: 'disconnected',
            error: '',
            tools: []
          });
          saveState(api, st);
        }
      } else if (cmd.action === 'remove') {
        disconnectServer(cmd.name);
        const st = loadState(api);
        st.servers = st.servers.filter((x) => x.name !== cmd.name);
        saveState(api, st);
      }
    }
  } catch (e) {
    // 忽略解析错误
  }
}

module.exports = {
  name: 'mcp',
  storage: { workspace: ['.ensoul/mcp/servers.json', '.ensoul/mcp/project'] },
  params: PARAMS,
  description: t('生态入口：联网找技能与 MCP 服务，装进来即用，不想要了能撤'),
  panel: {
    kind: 'mcp',
    label: t('生态市场'),
    hint: t('统合仓库：联网找技能与 MCP 服务，装载、卸载都在这里'),
    title: t('生态市场'),
    body: 'messages'
  },
  setup(api) {
    apiHost = api;
    eco = ecosystem.createEcosystem(api, { loadState, saveState });
    eco.registerTools();
    // 首次联网放在后面几秒，别挡着装载 —— 拉不到也不影响 MCP 那一半照常干活
    setTimeout(() => refreshMarket('boot'), 2500);
    const st = loadState(api);
    saveState(api, st);

    // 定时检查命令与活动状态
    timer = setInterval(() => {
      checkCommands(api);
    }, TICK_INTERVAL);

    // 自动连接启用的服务器
    for (const s of st.servers) {
      if (s.enabled) {
        connectServer(s, api).catch((err) => {
          api.log(`[MCP] 自动连接 ${s.name} 失败:`, err.message);
        });
      }
    }

    // 状态栏显示连接数（挂在面板右上角）
    api.addStatusItem({
      id: 'mcp-status',
      slot: 'head',
      text() {
        let count = 0;
        for (const [_, entry] of activeServers) {
          if (entry.ready) count++;
        }
        return count > 0 ? `MCP: ${count} 在线` : '';
      },
      title() {
        return `已连接 ${activeServers.size} 个 MCP 服务器`;
      }
    });

    // 注册 Agent 可用工具
    api.addTool(
      {
        name: 'mcp_list_servers',
        description: t('列出当前配置的所有 MCP (Model Context Protocol) 服务器及其连接状态和工具数量。'),
        parameters: { type: 'object', properties: {} }
      },
      async () => {
        const sState = loadState(api);
        const list = sState.servers.map((s) => ({
          name: s.name,
          command: s.command,
          status: s.status,
          tools_count: s.tools ? s.tools.length : 0,
          error: s.error || undefined
        }));
        return JSON.stringify({ servers: list }, null, 2);
      }
    );

    api.addTool(
      {
        name: 'mcp_server_add',
        description: t('添加或更新一个 MCP 服务器配置。添加后可调用 mcp_tools 获取工具。'),
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'MCP 服务唯一名称（例如 github, sqlite, filesystem）' },
            command: { type: 'string', description: '启动命令，如 npx, python, node' },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: t('命令参数数组，例如 ["-y", "@modelcontextprotocol/server-filesystem", "src"]'),
            },
            auto_connect: { type: 'boolean', description: '是否立即尝试连接，默认 true' }
          },
          required: ['name', 'command']
        }
      },
      async (args) => {
          const sState = loadState(api);
          let target = sState.servers.find((x) => x.name === args.name);
          if (!target) {
            target = {
              name: args.name,
              command: args.command,
              args: args.args || [],
              env: {},
              enabled: true,
              status: 'disconnected',
              error: '',
              tools: []
            };
            sState.servers.push(target);
          } else {
            target.command = args.command;
            target.args = args.args || [];
          }
          saveState(api, sState);

          if (args.auto_connect !== false) {
            try {
              const entry = await connectServer(target, api);
              return `成功添加并连接 MCP 服务 "${args.name}"，获取到 ${entry.tools.length} 个工具。`;
            } catch (err) {
              return `已添加 MCP 服务 "${args.name}"，但初始连接失败: ${err.message}`;
            }
          }
          return `已添加 MCP 服务 "${args.name}"。`;
        }
    );

    api.addTool(
      {
        name: 'mcp_tools',
        description: t('获取已连接的 MCP 服务器提供的全部工具及参数 schema。'),
        parameters: {
          type: 'object',
          properties: {
            server: { type: 'string', description: '指定查看某个 server 的工具，不传则返回所有服务的工具' }
          }
        }
      },
      async (args) => {
          const sState = loadState(api);
          const results = [];
          for (const s of sState.servers) {
            if (args.server && s.name !== args.server) continue;
            results.push({
              server: s.name,
              status: s.status,
              tools: s.tools || []
            });
          }
          return JSON.stringify(results, null, 2);
        }
    );

    // 注册 MCP 专用设置分区
    api.addSettingsSection({
      id: 'mcp-servers',
      label: t('MCP 服务'),
      hint: t('已配置的 Model Context Protocol 服务器列表与连接管理'),
      view: () => {
        const st = loadState(api);
        const rows = (st.servers || []).map((s) => ({
          id: s.name,
          title: s.name,
          desc: `${s.command} ${(s.args || []).join(' ')}`,
          meta: s.status === 'connected' ? `已连接 (${(s.tools || []).length} 个工具)` : (s.status === 'connecting' ? '正在连接...' : (s.status === 'error' ? `出错: ${s.error}` : '未连接')),
          actions: [
            {
              id: s.status === 'connected' ? 'disconnect' : 'connect',
              label: s.status === 'connected' ? t('断开') : t('连接'),
              hint: s.status === 'connected' ? t('断开与该 MCP 服务的连接') : t('连接并发现工具')
            },
            {
              id: 'remove',
              label: t('删除'),
              hint: t('从配置中移除该 MCP 服务')
            }
          ]
        }));
        return {
          note: t('Model Context Protocol (MCP) 服务器管理：通过标准 stdio JSON-RPC 2.0 协议连接外部工具服务。'),
          rows,
          empty: t('还没有添加任何 MCP 服务。智能体可通过 mcp_server_add 工具添加，或在此配置。')
        };
      },
      onAction: async (actionId, rowId) => {
        const st = loadState(api);
        const target = (st.servers || []).find((s) => s.name === rowId);
        if (!target) return '未找到该 MCP 服务。';
        if (actionId === 'connect') {
          try {
            const entry = await connectServer(target, api);
            return `成功连接到 ${target.name}，已加载 ${entry.tools.length} 个工具。`;
          } catch (e) {
            return `连接失败: ${e.message}`;
          }
        }
        if (actionId === 'disconnect') {
          const entry = activeServers.get(target.name);
          if (entry && entry.process) {
            try { entry.process.kill(); } catch (_) {}
          }
          activeServers.delete(target.name);
          target.status = 'disconnected';
          target.tools = [];
          saveState(api, st);
          return `已断开与 ${target.name} 的连接。`;
        }
        if (actionId === 'remove') {
          const entry = activeServers.get(target.name);
          if (entry && entry.process) {
            try { entry.process.kill(); } catch (_) {}
          }
          activeServers.delete(target.name);
          st.servers = st.servers.filter((s) => s.name !== rowId);
          saveState(api, st);
          return `已删除 MCP 服务 ${target.name}。`;
        }
        return '未知操作';
      }
    });

    api.addTool(
      {
        name: 'mcp_call',
        description: t('调用指定 MCP 服务器导出的工具，执行操作并返回执行结果。'),
        parameters: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'MCP 服务器名称' },
            tool: { type: 'string', description: '工具名称' },
            arguments: { type: 'object', description: '传递给工具的实参对象' }
          },
          required: ['server', 'tool']
        }
 },
        async (args) => {
          const serverName = args.server;
          let entry = activeServers.get(serverName);
          if (!entry || !entry.ready) {
            // 尝试重连一次
            const sState = loadState(api);
            const conf = sState.servers.find((x) => x.name === serverName);
            if (!conf) return `错误: 未找到名为 "${serverName}" 的 MCP 服务`;
            try {
              entry = await connectServer(conf, api);
            } catch (err) {
              return `连接 MCP 服务 "${serverName}" 失败: ${err.message}`;
            }
          }

          try {
            const result = await sendRpc(entry, entry.process, 'tools/call', {
              name: args.tool,
              arguments: args.arguments || {}
            });
            return JSON.stringify(result, null, 2);
          } catch (err) {
            return `调用 MCP 工具 ${args.tool} 失败: ${err.message}`;
          }
        }
    );
  },
  dispose() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    for (const [name, entry] of activeServers) {
      try {
        if (entry.process && !entry.process.killed) entry.process.kill();
      } catch (_) {}
    }
    activeServers.clear();
  }
};
