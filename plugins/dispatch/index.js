/**
 * dispatch —— 派单器 + 员工编制管理。
 *
 * ══ 数据怎么摆（这一版最要紧的改动）═══════════════════════════════════════
 *
 * **一个员工一个 JSON**：`.ensoul/state/agents/<id>.json` —— 这就是他的角色卡。
 *   { id, name, dept, role, avatar, intro, skills[], strength, model, prompt, panel, history[] }
 * 卡里放的是这个人**自己**的东西：简介、能力范围、特长、**固定模型**、专属提示词。
 * 改他不用碰任何别人 —— 这就是"用 web 逻辑管理员工"。
 *
 * **名册只记结构**：`.ensoul/state/dispatch.json` —— 哪些部门、每部门谁是经理、还有谁。
 *   { depts: [ { name, manager: "<agentId>", members: ["<agentId>", …] } ] }
 * 名册里**不抄**姓名特长提示词 —— 抄一份就是两份真源，迟早分叉。
 *
 * 所以：要一个人 → 从名册拿到 id → 读他那张卡。姓名是卡上的字段，改名字不用改名册。
 *
 * ══ 提示词怎么叠（要求 2）════════════════════════════════════════════════
 * 员工面板的 spec.systemPrompt 只放**他自己的专属提示词**。核心那套 agent 通用提示词
 * 由 chat-core 每轮自动拼在最前面（那是所有面板都有的底座），所以是「通用 + 专属」；
 * 而组件库里那份模板的通用长文案**不抄进来** —— 员工是一个人，不是一份模板的副本。
 *
 * ══ 经理能看到什么（要求 4）══════════════════════════════════════════════
 * 每轮给**经理面板**注入一段本部门花名册：每个人的简介、能力范围、特长、模型，
 * 外加**完成的工作**（确认有效的成功案例：做了什么 + 实现路径，存他自己的工作区）。
 * 经理据此挑人 —— 不用去挨个翻别人的面板。
 *
 * 两条文件通道（跟 library / pomodoro 同一个路子）：
 *   状态  .ensoul/state/dispatch.board.json   插件写、面板读
 *   命令  .ensoul/state/dispatch.cmd.json     面板写、插件读（每条带 panelId，队列认 seq）
 * 面板上每一下点击的回执写在看板的 feed 里，**绝不 api.send 进对话** ——
 * 那种回执是当"用户消息"投进去的，等于每点一下按钮就唤醒模型跑一整轮。
 */

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const REG = '.ensoul/state/dispatch.json';
const AGENTS = '.ensoul/state/agents';
/** 头像文件的落点 —— 卡上只存**这个目录下的相对路径**，base64 一个字节都不许内联 */
const AVATARS = '.ensoul/state/avatars';
const BOARD_FILE = '.ensoul/state/dispatch.board.json';
const CMD_FILE = '.ensoul/state/dispatch.cmd.json';
/** 派单令牌 / 收件箱：既是"谁欠谁一件活"的账，也是交付物送达的地址簿 */
const INBOX_FILE = '.ensoul/state/dispatch.inbox.json';

/** 一次派单里最多改派几跳（防 A→B→A 转圈） */
const MAX_HOP = 3;
/** 回执带回调用者面前时截断，别把对方的整篇输出灌进这边上下文 */
const RECEIPT = 1800;
/** 命令多久看一次；看板多久重算一次（脸 1.5 秒轮询一次，比它密一档就够） */
const TICK = 300;
const BOARD_TICK = 1200;
/**
 * 头像**不许内联在卡里**（这一版改的就是这里）。
 *
 * 卡是唯一真源，而它会**被整份抄进快照**（dispatch.board.json / eschat.json）：
 * 一张 512×512 赛璐璐 PNG 的 data URL 就是 56–287KB，三四张就把两份快照顶过
 * fs:read 的 300KB 上限 → 面板读到的是**一句占位文字**、JSON.parse 炸 → 看板 null
 * → 组织树和侧栏同时变空（看着像"员工全没了"，其实一张卡都没丢）。
 * 现在落点 `.ensoul/state/avatars/<id>.<ext>`，卡上只留**应用资料相对路径**。
 *
 * AVATAR_MAX 留着，但防的东西变了：它现在防"有人往命令里塞巨大 base64"，
 * 写完立刻落盘、卡上不留 —— 不是"卡要被撑爆"。
 */
const AVATAR_MAX = 400 * 1024;
/** 扩展名对齐：jpeg → jpg，其余原样（认不出来的当 png） */
const AV_EXT = { png: 'png', jpeg: 'jpg', jpg: 'jpg', webp: 'webp', gif: 'gif' };
/** 履历最多记几条（够看出"最近在干什么"就行） */
const HIST_MAX = 12;
/** 学会的工作流最多存几条 —— 跑通一条记一条，够看出"他会什么"就行 */
const LEARN_MAX = 20;
/** 一件派出去的活最多挂多久没人交付（过了就当废了，不再认这个令牌） */
const WAIT_TTL = 24 * 3600 * 1000;
/** 送出前就断了、留在收件箱里没人认的令牌，超过这么久就由巡检收掉 */
const ORPHAN_GRACE = 90 * 1000;
/** 收件箱最多留几条记录 */
const INBOX_MAX = 60;

let cmdTimer = null;
let boardTimer = null;

// ─────────────────────────────────────────────────── 员工卡（一人一个文件）

const agentsDir = (api) => api.dataPath(AGENTS);
const agentFile = (api, id) => path.join(agentsDir(api), `${id}.json`);
const avatarsDir = (api) => api.dataPath(AVATARS);

/**
 * base64 的 data URL → 磁盘上的一个文件，返回**工作区相对路径**（正斜杠）；失败返回 ''。
 *
 * 同一个人的旧文件顺手删掉（换过头像格式时目录里会留下一张谁都不认的图）。写盘失败
 * 不抛：那不是"这个人废了"，调用方把字段清成空串就行。
 */
function landAvatar(api, id, dataUrl) {
  const empId = String(id || '').trim();
  if (!empId) return '';
  const m = /^data:image\/([a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(String(dataUrl || ''));
  if (!m) return '';
  const ext = AV_EXT[m[1].toLowerCase()] || 'png';
  let buf;
  try {
    buf = Buffer.from(m[2], 'base64');
  } catch {
    return '';
  }
  if (!buf.length) return '';
  const dir = avatarsDir(api);
  const file = `${empId}.${ext}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 同名不同扩展的残留 —— 换过格式的话它会一直躺在那儿
    for (const n of fs.readdirSync(dir)) {
      if (n !== file && n.startsWith(`${empId}.`) && !n.endsWith('.json')) {
        try {
          fs.unlinkSync(path.join(dir, n));
        } catch {
          /* 删不掉不阻塞写入 */
        }
      }
    }
    fs.writeFileSync(path.join(dir, file), buf);
  } catch (e) {
    api.log(`[dispatch] 头像落盘失败（${empId}）：${String((e && e.message) || e)}`);
    return '';
  }
  return `${AVATARS}/${file}`;
}

/** 这个人名下的头像文件全收掉（人被移出编制时用；删不掉不抛） */
function dropAvatars(api, id) {
  const empId = String(id || '').trim();
  if (!empId) return;
  const dir = avatarsDir(api);
  try {
    for (const n of fs.readdirSync(dir)) {
      if (n.startsWith(`${empId}.`) && !n.endsWith('.json')) {
        try {
          fs.unlinkSync(path.join(dir, n));
        } catch {
          /* 留着也不影响谁 */
        }
      }
    }
  } catch {
    /* 目录还没建过 —— 正常 */
  }
}

/**
 * 卡上的头像字段 → 界面能直接喂 `<img src>` 的地址。
 *
 * **快照里只准出现这个函数的结果** —— base64 一个字节都不许进 dispatch.board.json /
 * eschat.json（那正是这次事故的根子）。file:// 在这个应用里能直接显示，跟对话里发图
 * 是同一条路（见 src/renderer/panel/chat/format.ts 的 shotUrl）。
 */
function avaUrl(api, v) {
  const s = String(v || '').trim();
  if (!s) return '';
  // 过渡期兜底：老卡（还没迁移的 data URL）、已经算好的 file://、外链 —— 原样给
  if (s.startsWith('data:') || s.startsWith('file://') || /^(https?|blob):/i.test(s)) return s;
  const abs = path.isAbsolute(s) ? s : s.replace(/\\/g, '/').startsWith('.ensoul/') ? api.dataPath(s) : path.resolve(api.workspace || '.', s);
  return `file:///${abs.replace(/\\/g, '/')}`;
}

/*
 * file:///D:/... → 工作区相对路径（认不出就原样返回）。
 *
 * 卡上的头像**只存相对路径**：绝对地址换台机器、换盘符、换工作区目录就废。
 * 而面板保存角色卡时回传的是**看板里的那个值**，看板给的又是 avaUrl 算好的
 * file:// 绝对地址 —— 于是"点一下保存"就能把绝对地址写回卡里。
 * 收口放在 readCard / writeCard 这一进一出两处，跟"base64 一律落盘"是同一道闸。
 */
function relAvatar(api, v) {
  const s = String(v || '').trim();
  if (!/^file:/i.test(s)) return s;
  const ws = path.dirname(api.dataPath('.ensoul')).split(path.sep).join('/');
  let p = s.slice('file:'.length).split('/').filter(Boolean).join('/');
  try {
    p = decodeURIComponent(p);
  } catch {
    /* 编码坏了就用原样比 */
  }
  p = p.split(String.fromCharCode(92)).join("/");
  return p.startsWith(ws + '/') ? p.slice(ws.length + 1) : s;
}

function newId() {
  return `emp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 卡片的形状在这里定死一遍：外部读进来的一律过这一道，缺字段补默认 */
/**
 * 工具套件组 —— 一个岗位一整套工具。
 *
 * 为什么要有它：49 个工具的表**每轮都要发一遍**（约 3.3 万字符）。全体员工都拿全量是浪费 ——
 * 经理只需要"挑人 + 转发"，给他 49 个工具，既费 token 又让他更容易选错。
 *
 * 名字必须跟真工具一字不差（写错的会被核心滤掉）。改这里只动数据，不用动代码。
 * 卡上写了 `kit` 就用卡上的；没写按岗位推一个（见 defaultKit）。
 */
const KITS = {
  /**
   * 基本功能：每个员工都有的底子 —— 派单、读工作区、重启请求、查技能。
   * 不给 deliver_result（交付归专业组，经理更不该去交）、
   * 不给写码 / 构建那一串 —— 要动手就叠自己的专业组。
   */
  base: ['dispatch', 'read_file', 'list_dir', 'read_logs', 'restart_project', 'use_skill', 'learn'],
  /** 美术出图：写提示词 + 调 ComfyUI + 发图 / 交付 */
  art: ['comfyui_status', 'comfyui_models', 'comfyui_workflow', 'comfyui_run', 'comfyui_launch', 'send_image',
    'read_file', 'write_file', 'use_skill', 'learn', 'deliver_result'],
  /** 像素画师：像素画布那一套工具，**不含 comfyui** —— 出图不归它 */
  pixel: ['pixel_init', 'pixel_batch', 'pixel_matrix', 'pixel_read', 'pixel_export', 'pixel_import', 'send_image',
    'read_file', 'write_file', 'use_skill', 'learn', 'deliver_result'],
  /** 无限画布：读 / 改画布，**不含 comfyui 与像素工具** */
  canvas: ['canvas_read', 'canvas_edit', 'read_file', 'write_file', 'use_skill', 'learn', 'deliver_result'],
  /** 文案：读写稿子 + 查资料（含网页与历史会话检索） */
  copy: ['read_file', 'write_file', 'edit', 'search', 'web_search', 'web_fetch', 'history_search', 'history_read',
    'use_skill', 'learn', 'deliver_result'],
  /** 核心写码：改代码 + 跑构建 + git 状态 —— 长任务与发布另有 ops / release */
  dev: ['read_file', 'write_file', 'edit', 'search', 'list_dir', 'read_logs',
    'run_command', 'build_project', 'start_project', 'stop_project', 'project_status', 'restart_project',
    'git_status', 'git_ignore', 'use_skill', 'learn', 'deliver_result'],
  /** 运维 / 长任务：后台任务 + 备份回滚 + 看日志 */
  ops: ['job_start', 'job_list', 'job_output', 'job_kill', 'read_logs', 'run_command',
    'list_backups', 'restore_backup', 'use_skill', 'learn', 'deliver_result'],
  /** 待办 / 调度：任务清单与定时提醒 */
  planner: ['todo_write', 'todo_read', 'whiteboard_list', 'whiteboard_node', 'use_skill', 'learn', 'deliver_result'],
  /** 界面 / 模板：看布局、改组件、存开模板、开浏览器、调插件参数 */
  ui: ['describe_layout', 'component_declare', 'component_clone', 'component_remove',
    'template_save', 'template_open', 'template_list', 'browser_open', 'plugin_params',
    'read_file', 'edit', 'use_skill', 'learn', 'deliver_result'],
  /** 执行：轻量动手 + 判断该不该转派 */
  exec: ['read_file', 'write_file', 'edit', 'search', 'list_dir', 'run_command', 'dispatch',
    'todo_write', 'todo_read', 'use_skill', 'learn', 'deliver_result'],
  /** 发布门：能读 diff、能跑 git，但**不给写码那一串** —— 它是审查，不是开发 */
  release: ['git_status', 'git_ignore', 'packager_status', 'packager_toggle', 'packager_sync', 'read_file', 'list_dir', 'search', 'edit', 'run_command',
    'history_search', 'dispatch', 'use_skill', 'learn', 'deliver_result'],
  /**
   * 全量：一个都不裁。'*' 是给核心看的通配 —— 见到它就原样放行，
   * 免得把几十个工具名抄一份在这儿、还得跟着核心一起漂移。
   * 「天生全能型」的人勾这个；也可以跟别的组一起勾（重复的会自动去掉）。
   */
  all: ['*'],
};

/**
 * 套件组的人话名字与适用场景 —— 只给面板画勾选用（KITS 是给机器的，这里是给人的）。
 *
 * 这两个常量只是**内置种子**：真正生效的套件组表在 .ensoul/state/dispatch.kits.json。
 * 头一次用就把种子写出去，之后以那个文件为准 —— 加一组不用改代码，改完下一轮就生效。
 * 文件没了 / 写坏了就退回种子：一个配置文件不该让整个编制开不了工。
 */
const KIT_INFO = {
  base: { label: t('基本功能'), when: t('全员底子：派单、读工作区、重启请求、查技能（经理的默认）') },
  art: { label: t('美术出图'), when: t('写提示词、调 ComfyUI、把图交回去') },
  pixel: { label: t('像素画师'), when: t('像素画布上画、批量刷、导图 —— 不出图、不碰 ComfyUI') },
  canvas: { label: t('无限画布'), when: t('读画布、改画布节点与连线') },
  copy: { label: t('文案写作'), when: t('读写稿子、查资料（网页 + 历史会话）') },
  dev: { label: t('核心写码'), when: t('改代码、跑构建、看 git 状态') },
  ops: { label: t('运维 / 长任务'), when: t('开后台任务、读日志、备份回滚') },
  planner: { label: t('待办 / 调度'), when: t('任务清单与定时提醒') },
  ui: { label: t('界面 / 模板'), when: t('看布局、改组件、存开模板、开浏览器、调插件参数') },
  exec: { label: t('执行 / 轻量动手'), when: t('跑命令、改文件，顺带判断该不该转派') },
  release: { label: t('发布 / 开源'), when: t('审 diff、跑 git —— 看得见工作区，但不写码') },
  all: { label: t('全量（一个都不裁）'), when: t('天生全能型 —— 什么都能干，只是习惯把活发包给别人') },
};

/** 套件组表落在哪 —— 这是编制的一部分，跟 board / cmd 同族 */
const KITS_FILE = '.ensoul/state/dispatch.kits.json';

/** 内置种子 —— 文件还没建出来（或被写坏）时用它 */
function seedKits() {
  const out = {};
  for (const key of Object.keys(KITS)) {
    const info = KIT_INFO[key] || {};
    out[key] = { key, label: info.label || key, when: info.when || '', tools: KITS[key].slice() };
  }
  return out;
}

/** 每个组都会发的那几个通用工具 —— 归哪组由 KITS 写死，不靠名字里的下划线猜 */
const SHARED_TOOLS = new Set([
  'list_dir', 'read_file', 'write_file', 'edit', 'search', 'read_logs', 'run_command',
  'use_skill', 'learn', 'deliver_result', 'send_image', 'dispatch',
  'todo_write', 'todo_read', 'history_search', 'history_read',
]);

/**
 * 根据工具名或描述特征智能推断其所属的套件组（防止插件未声明 kits 导致新工具被漏掉）。
 *
 * 分组跟 dispatch 的 KITS 对齐 —— **像素 / 画布 / 运维 / 规划各归各的组**，
 * 不再一律塞进 art / dev：否则勾「美术」会顺带带上画布工具，勾「画布」又拿到出图。
 * 认不出来的一律兜进 dev（新插件的工具至少不会漏给开发）。
 *
 * 与 src/main/agent.ts 里的同名函数逻辑一字不差 —— 改一处就得改另一处。
 */
function inferKitsForTool(name, desc) {
  const n = String(name || '').toLowerCase();
  const d = String(desc || '').toLowerCase();
  const kits = new Set();

  // 1. 美术出图：ComfyUI 那一套 + 发图
  if (n.startsWith('comfyui_') || n === 'send_image' || d.includes('comfyui') || d.includes(t('出图'))) kits.add('art');

  // 2. 像素画师 / 无限画布：各归各的组，别再混进美术
  if (n.startsWith('pixel_')) kits.add('pixel');
  if (n.startsWith('canvas_')) kits.add('canvas');

  // 3. 运维 / 长任务：后台任务 + 备份回滚
  if (n.startsWith('job_') || n.includes('backup') || n.startsWith('restore_')) kits.add('ops');

  // 4. 待办 / 调度
  if (n.startsWith('todo_') || n.startsWith('whiteboard_')) kits.add('planner');

  // 5. 界面 / 模板：看布局、改组件、存开模板、开浏览器、调插件参数
  if (
    n.startsWith('component_') ||
    n.startsWith('template_') ||
    n === 'describe_layout' ||
    n === 'browser_open' ||
    n === 'plugin_params'
  ) {
    kits.add('ui');
  }

  // 6. 版本控制与发布
  if (n.startsWith('git_') || n.includes('diff') || n.includes('release') || d.includes('git') || d.includes(t('发布'))) {
    kits.add('dev');
    kits.add('release');
  }
  if (n.startsWith('packager_') || d.includes(t('打包'))) kits.add('release');

  // 7. 文案与信息检索（网页、历史会话）
  if (
    n.startsWith('web_') ||
    n.startsWith('history_') ||
    n.includes('fetch') ||
    n.includes('crawl') ||
    d.includes(t('查资料')) ||
    d.includes(t('网页'))
  ) {
    kits.add('copy');
  }

  // 8. 构建 / 运行工程
  if (
    n.startsWith('project_') ||
    n.startsWith('build_') ||
    n.startsWith('start_') ||
    n.startsWith('stop_') ||
    n.startsWith('restart_')
  ) {
    kits.add('dev');
  }

  // 9. 兜底：新插件的工具至少别漏给开发组。通用工具（SHARED_TOOLS）不参与推断 ——
  // 靠名字里的下划线猜，只会把 dev 蹭给所有人。
  if (!kits.size && !SHARED_TOOLS.has(n) && (n.includes('_') || d.length > 0)) kits.add('dev');

  return Array.from(kits);
}

/**
 * 动态扩容：用已加载的插件工具对套件组表进行实时丰富
 */
function expandKitsWithPlugins(baseMap, api) {
  const map = {};
  for (const k of Object.keys(baseMap || {})) {
    map[k] = { ...baseMap[k], tools: (baseMap[k].tools || []).slice() };
  }
  if (!api || typeof api.allPluginTools !== 'function') return map;
  try {
    const specs = api.allPluginTools();
    if (!Array.isArray(specs)) return map;
    for (const spec of specs) {
      if (!spec || !spec.name) continue;
      const explicit = Array.isArray(spec.kits) ? spec.kits : [];
      const inferred = inferKitsForTool(spec.name, spec.description);
      const targetKits = new Set([...explicit, ...inferred]);

      for (const tKit of targetKits) {
        if (!map[tKit]) {
          map[tKit] = {
            key: tKit,
            label: t('扩容·') + tKit,
            when: t('由插件动态声明的新套件组'),
            tools: [],
          };
        }
        if (!map[tKit].tools.includes(spec.name) && !map[tKit].tools.includes('*')) {
          map[tKit].tools.push(spec.name);
        }
      }
    }
  } catch {
    /* 忽略读取失败 */
  }
  return map;
}

/**
 * 读套件组表。**按文件的 mtime + size 缓存** —— 每轮、每块面板都要问一次，
 * 不缓存就是每轮几十次 stat。
 *
 * 三种情形都不许把编制搞瘫：
 *   文件不在 → 写一份种子出去（让人看得见、改得动），本次用种子；
 *   文件坏了 / 空的 / 一条都不合法 → 用种子，**但不覆盖用户那份**（他可能正在改）；
 *   一切正常 → 以文件为准。
 */
let kitsCache = { sig: null, map: null };
function loadKits(api) {
  const p = api.dataPath(KITS_FILE);
  let sig = 'none';
  try {
    const st = fs.statSync(p);
    sig = st.mtimeMs + ':' + st.size;
  } catch {
    sig = 'none';
  }
  if (kitsCache.sig === sig && kitsCache.map) return expandKitsWithPlugins(kitsCache.map, api);

  let map = seedKits();
  if (sig === 'none') {
    // 头一次：把种子写出去，让人看得见、改得动
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(
        p,
        JSON.stringify(
          {
            _readme:
              t('工具套件组表。每组 tools 里写**工具的真名字**；写 "*" 表示一个都不裁（全量）。') +
              t('加一组就往 kits 里追加一项，下一轮就出现在角色卡上，不必重启。'),
            kits: Object.values(seedKits()),
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch {
      /* 写不出去就只用种子，不影响开工 */
    }
  } else {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const list = Array.isArray(j && j.kits) ? j.kits : [];
      const built = {};
      for (const k of list) {
        const key = String((k && k.key) || '').trim();
        if (!key || !Array.isArray(k && k.tools)) continue;
        built[key] = {
          key,
          label: String((k && k.label) || key),
          when: String((k && k.when) || ''),
          tools: k.tools.map((t) => String(t).trim()).filter(Boolean),
        };
      }
      if (Object.keys(built).length) map = built;
    } catch {
      /* 坏了就用种子 —— 一个配置文件不该让整个编制开不了工 */
    }
  }
  kitsCache = { sig, map };
  return expandKitsWithPlugins(map, api); // dynamic expansion
  return map;
}

/** 面板要的套件组清单（key + 人话名 + 场景 + 工具名单） */
function kitOptions(api) {
  return Object.values(loadKits(api));
}

/**
 * 卡上没写 kit 时，按岗位推一个。
 *
 * **顺序即规则，别调**：
 *   1. 开源组经理是唯一例外 —— 它自己审 diff、自己跑 git，不是纯路由；
 *   2. 其余经理一律 base —— 挑人、转发原话、回执，就是它的全部工作。
 *      部门技能（文案稿、美术图）是**他手下的人**干的活，不能因为"他在文案组"
 *      就把写稿的工具配给他（那样他既费 token，又更容易自己上手越界）。
 *   3. 剩下的按部门给成员的活。
 */
function defaultKit(card) {
  const dept = String((card && card.dept) || '');
  const isMgr = String((card && card.role) || '') === 'manager';
  if (dept.includes(t('开源'))) return 'release';
  if (isMgr) return 'base';
  if (dept.includes(t('像素'))) return 'pixel';
  if (dept.includes(t('画布'))) return 'canvas';
  if (dept.includes(t('美术'))) return 'art';
  if (dept.includes(t('运维'))) return 'ops';
  // 「策划」是本工作室的实际部门名，「规划」是岗位通称 —— 两个都认
  if (dept.includes(t('规划')) || dept.includes(t('策划'))) return 'planner';
  if (dept.includes(t('文案'))) return 'copy';
  if (dept.includes(t('开发'))) return 'dev';
  return 'exec';
}

/**
 * 这张卡**生效**的套件组，可能不止一个：
 *   卡上勾了 → 就按勾的来（勾几个算几个，重叠的合并）；
 *   一个都没勾 → 按岗位推一个。
 * 自动推的那份也一并返回 —— 于是面板上「勾着的」永远等于「正在生效的」，不会两套说法。
 */
function kitList(card) {
  const own = Array.isArray(card && card.kits)
    ? card.kits.map((k) => String(k).trim()).filter(Boolean)
    : [];
  // 没勾的人：base 是底子，再叠一个岗位组 —— 基本功能本就该人人有。
  // （旧写法 [defaultKit(card)] 会让回退的人漏掉 base：开发组成员只拿到 dev，没有 dispatch。）
  const byPost = defaultKit(card);
  return own.length ? own : (byPost === 'base' ? ['base'] : ['base', byPost]);
}

/** 这张卡对应的工具清单 —— 写进他那块面板的 tools 字段 */
/**
 * 这张卡对应的工具清单 —— 写进他那块面板的 tools 字段。
 *
 * **顺序只由套件组表的定义顺序决定，跟勾选先后无关** —— 否则同样的两组，
 * 换个勾的顺序就得到另一份清单，白废一次前缀缓存。
 * 重叠的工具去重：多选本来就会重叠，这是设计，不是意外。
 *
 * 套件 key 也写入清单；组被删掉或工具改名时，核心按剩余匹配发放，不扩大授权。
 */
function toolsOf(api, card) {
  const defs = loadKits(api);
  const picked = kitList(card);
  const out = [];
  const seen = new Set();
  const pickedSet = new Set(picked);
  if (pickedSet.has('all')) return ['*'];
  for (const key of Object.keys(defs)) {
    if (!pickedSet.has(key)) continue;
    for (const t of defs[key].tools) {
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  if (api && typeof api.allPluginTools === 'function') {
    try {
      const allSpecs = api.allPluginTools();
      if (Array.isArray(allSpecs)) {
        for (const spec of allSpecs) {
          if (!spec || !spec.name || seen.has(spec.name)) continue;
          const specKits = new Set([...(Array.isArray(spec.kits) ? spec.kits : []), ...inferKitsForTool(spec.name, spec.description)]);
          if (Array.from(specKits).some((k) => pickedSet.has(k))) {
            seen.add(spec.name);
            out.push(spec.name);
          }
        }
      }
    } catch {
      /* 忽略读取失败 */ } } for (const k of picked) { if (!seen.has(k)) { seen.add(k); out.push(k); } } if (false) { {
    }
  }
  if (out.includes('dispatch') || out.includes('subagent_run')) {
    for (const name of ['task_status', 'task_cancel']) if (!out.includes(name)) out.push(name);
  }
  return out;
}

function normCard(raw, fallbackId) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    id: String(c.id || fallbackId || '').trim(),
    name: String(c.name || '').trim(),
    dept: String(c.dept || '').trim(),
    role: c.role === 'manager' ? 'manager' : 'member',
    avatar: typeof c.avatar === 'string' ? c.avatar : '',
    intro: String(c.intro || ''),
    skills: Array.isArray(c.skills) ? c.skills.map((s) => String(s).trim()).filter(Boolean) : [],
    strength: String(c.strength || ''),
    /** 固定模型：`provider::model`。空 = 还没指定，这个人开不了工 */
    model: String(c.model || '').trim(),
    /**
     * 工具套件组（见 dispatch.kits.json 那张表）。**可以勾多个，一个不勾 = 按岗位推一个**。
     * 老的单值 kit 就地升成数组，老卡不用手改；存的时候去重。
     * 认不出来的 key **留着不删**（也许那张表只是暂时被改坏了），算清单时自然忽略它。
     */
    kits: (Array.isArray(c.kits) ? c.kits : c.kit ? [c.kit] : [])
      .map((k) => String(k).trim())
      .filter((k, i, a) => k && a.indexOf(k) === i)
      .slice(0, 16),
    /**
     * 员工自己**申请**、还没生效的工具组。空 = 没有待生效的。
     *
     * 为什么不申请当场生效（这是整套设计的要害）：面板的工具表一变，请求前缀缓存
     * **全废**，那一轮按全价重算整个前缀 —— 省下的字节还不够赔。所以申请只登记在这儿，
     * 等"缓存本来就要重建"的那一刻才并进 kits 生效，见 applyPending。
     */
    pendingKits: (Array.isArray(c.pendingKits) ? c.pendingKits : [])
      .map((k) => String(k).trim())
      .filter((k, i, a) => k && a.indexOf(k) === i)
      .slice(0, 16),
    /** 专属提示词（核心的通用提示词由 chat-core 另外叠在最前面） */
    prompt: String(c.prompt || ''),
    /** 他那块面板的 id —— 名字改了也不影响认人 */
    panel: String(c.panel || '').trim(),
    history: Array.isArray(c.history)
      ? c.history.slice(-HIST_MAX).map((h) => ({
          at: Number((h && h.at) || 0),
          task: String((h && h.task) || '').slice(0, 200),
          note: String((h && h.note) || '').slice(0, 300),
        }))
      : [],
    /**
     * 学会的工作流 —— **跑通一条存一条**：能力是学出来的，不是天生的。
     * learned 是经历（带日期）；同时把名字补进 skills，派单和经理挑人就直接命中。
     * 专属：存进他那张卡，别人没有；给别人用走 copySkill（调度中心的「复制给…」）。
     */
    learned: Array.isArray(c.learned)
      ? c.learned
          .slice(-LEARN_MAX)
          .map((l) => ({
            name: String((l && l.name) || '').trim().slice(0, 80),
            how: String((l && l.how) || '').slice(0, 500),
            at: Number((l && l.at) || 0),
          }))
          .filter((l) => l.name)
      : [],
  };
}

function readCard(api, id) {
  try {
    const c = normCard(JSON.parse(fs.readFileSync(agentFile(api, id), 'utf8')), id);
    // 绝对地址一律收成相对路径（老卡、面板回传的 file:// 都在这道被收干净）
    return { ...c, avatar: relAvatar(api, c.avatar) };
  } catch {
    return null;
  }
}

function writeCard(api, card) {
  const c = normCard(card, card && card.id);
  // 面板回传的 avatar 是**看板里的值**（avaUrl 算好的 file://）—— 落盘前收成相对路径
  c.avatar = relAvatar(api, c.avatar);
  /**
   * **兜底那一道**：谁把 data URL 塞进来（面板点头像换图、老卡、别的插件），
   * 都在写盘前当场落成文件、字段换成路径。这样"卡里内联着头像"从此不可能发生，
   * 也就不会再顺着快照把面板撑空。
   */
  if (c.avatar && c.avatar.startsWith('data:')) {
    if (c.avatar.length > AVATAR_MAX) {
      api.log(`[dispatch] ${c.name || c.id} 的头像 ${Math.round(c.avatar.length / 1024)}KB 超过上限，丢弃`);
      c.avatar = '';
    } else {
      const rel = landAvatar(api, c.id, c.avatar);
      if (!rel) api.log(`[dispatch] ${c.name || c.id} 的头像落盘失败，字段清空`);
      c.avatar = rel;
    }
  } else if (c.avatar && c.avatar.length > AVATAR_MAX) {
    // 路径不该有这么长 —— 真这么长说明这个字段被塞了别的东西
    c.avatar = '';
  }
  fs.mkdirSync(agentsDir(api), { recursive: true });
  fs.writeFileSync(agentFile(api, c.id), JSON.stringify(c, null, 2), 'utf8');
  return c;
}

function dropCard(api, id) {
  try {
    fs.unlinkSync(agentFile(api, id));
  } catch {
    /* 本来就不在就算了 */
  }
  // 人走了，他的头像文件也跟着走 —— 留着只会在 avatars/ 里攒无名文件
  dropAvatars(api, id);
}

/** 全部员工卡：读目录就是真相（名册那条索引只记结构，谁真存在看这儿） */
function allCards(api) {
  let files = [];
  try {
    files = fs.readdirSync(agentsDir(api)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const c = readCard(api, f.replace(/\.json$/, ''));
    if (c && c.id && c.name) out.push(c);
  }
  return out;
}

// ──────────────────────────────────── 总提示词：分段存、调度中心合成
//
// 一个员工最终收到的提示词 = 公司基础提示词 + 公司简介 + 部门简介 + 部门提示词
//                            + 本人简介 + 职位提示词。
// 六段**分开存、只在这儿合成**，员工面板里永远只有合成结果（spec.systemPrompt）。
//   公司简介/基础提示词  每公司一份  .ensoul/state/companies/<公司id>.json
//   部门简介/提示词      每部门一份  .ensoul/state/depts/<公司id>__<部门名>.json
//   简介/职位提示词      每人一份    .ensoul/state/agents/<id>.json（角色卡上本来就有的字段）
// 名册（dispatch.json）仍然只是花名册：公司和部门的**名字与结构**在里面，一个提示词都不进。
// 部门文件按公司 id 分目录，两家公司各有一个「美术组」不会互相覆盖。

const BASE_FILE = '.ensoul/state/dispatch.base.json'; // 旧的全局基础提示词：只作新公司的出厂默认值
const DEPTS_DIR = '.ensoul/state/depts';
const COS_DIR = '.ensoul/state/companies';

const coFile = (api, id) => api.dataPath(path.join(COS_DIR, `${String(id || '').trim()}.json`));

/** 公司的文字内容（简介 + 基础提示词）。文件不在就现出厂的：接旧全局那份，没有就 DEFAULT_BASE */
function readCoFile(api, id) {
  try {
    const j = JSON.parse(fs.readFileSync(coFile(api, id), 'utf8'));
    return { intro: String((j && j.intro) || ''), base: String((j && j.base) || '') };
  } catch {
    return { intro: '', base: '' };
  }
}

function ensureCoFile(api, id) {
  if (fs.existsSync(coFile(api, id))) return;
  fs.mkdirSync(path.dirname(coFile(api, id)), { recursive: true });
  fs.writeFileSync(coFile(api, id), JSON.stringify({ intro: '', base: readBase(api) }), 'utf8');
}

/** 名册里的一条公司（结构）+ 文件里的内容 → 面板/合成要用的完整一份 */
function coText(api, co) {
  const f = readCoFile(api, co.id);
  const base = String(f.base || '').trim() ? f.base : readBase(api);
  return { id: co.id, name: co.name, intro: f.intro, base };
}

/** 基础提示词的出厂值 —— 只留干活必需的，没有一句"怎么改面板 / 怎么改这个软件" */
const DEFAULT_BASE = [
  t('你是这家 AI 游戏公司的一名员工，这块面板是你的工作面。用户提问就正常回答；让你做事就直接调工具，不要只回一句"可以……"。'),
  t('1 不许虚报：交付前回看工具记录，这轮没有成功的工具调用就直说没调上；图、文件、数字一个都不许编。'),
  t('2 关键结论用 ==两个等号== 圈出来（一处不超过二十个字，圈得准比圈得多重要）。'),
  t('3 读文件用 read_file 的 offset/limit 只读要的那段；动手前想清楚改哪几处，一次做完。'),
  t('4 回复用 markdown 排版；本轮 tools 就是全部工具，以它为准；改文本用 edit，别整份 write_file 重发。'),
  t('5 回复先给结论和动作，再给依据；能一句说完的不写三段，不重复背景、不复述对方原话（派单正文同理）。'),
  t('6 多步工程开工前先摆进度树（节点 / 谁做 / 前置 / 交付物 / 下一步）；前置没敲定就先问，不许直接埋头做。'),
  t('工作区就是这个项目所在的目录，路径都相对它来写。'),
].join('\n');

function readBase(api) {
  try {
    const j = JSON.parse(fs.readFileSync(api.dataPath(BASE_FILE), 'utf8'));
    const t = String((j && j.base) || '');
    return t.trim() ? t : DEFAULT_BASE;
  } catch {
    return DEFAULT_BASE;
  }
}

function writeBase(api, text) {
  const t = String(text || '').trim();
  fs.writeFileSync(api.dataPath(BASE_FILE), JSON.stringify({ base: t || DEFAULT_BASE }), 'utf8');
}

/** 部门文件按「公司id__部门名」存 —— 两家公司各有美术组，互不覆盖 */
function deptFile(api, coId, name) {
  return api.dataPath(path.join(DEPTS_DIR, `${String(coId || '')}__${String(name || '').trim()}.json`));
}

function readDept(api, coId, name) {
  const legacy = api.dataPath(path.join(DEPTS_DIR, `${String(name || '').trim()}.json`));
  const file = fs.existsSync(deptFile(api, coId, name)) ? deptFile(api, coId, name) : legacy;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { intro: String((j && j.intro) || ''), prompt: String((j && j.prompt) || '') };
  } catch {
    return { intro: '', prompt: '' };
  }
}

function writeDept(api, coId, name, data) {
  const file = deptFile(api, coId, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ name: String(name || '').trim(), intro: String((data && data.intro) || ''), prompt: String((data && data.prompt) || '') }), 'utf8');
}

/**
 * 合成 —— **顺序是管理员定死的：基础 → 姓名 → 简介 → 隶属公司 → 部门 → 职能**。
 * 先"我是谁"，再"我在哪"，最后"我干什么"；段与段之间不写自我说明，一句废话都不加。
 * 姓名/隶属公司/部门是结构信息，永远在；简介、公司简介、部门提示词、职能没写就整段不出（不留空标题）。
 * 公司层按**他的主部门**（卡上的 dept）认 —— 一个人只有一块工作面、一份提示词，
 * 跨公司兼职时别人可以派活给他，但他的提示词按主部门算，不会一会儿变一会儿变。
 */
function composePrompt(api, card) {
  const reg = readRegSafe(api);
  const d0 = reg.depts.find((x) => x.name === card.dept);
  const co0 = d0 ? reg.companies.find((c) => c.id === d0.company) : null;
  const co = co0 ? coText(api, co0) : null;
  const parts = [(co ? co.base : readBase(api)).trim()];

  // ① 姓名
  parts.push(`【姓名】${card.name}`);

  // ② 简介：本人简介 + 擅长 + 已学会 —— 一样都没有就整段不出
  const introBits = [String(card.intro || '').trim()];
  if (card.skills.length) introBits.push(`擅长：${card.skills.join('、')}`);
  const learned = (card.learned || []).map((l) => l.name).filter(Boolean);
  if (learned.length) introBits.push(`已学会：${learned.join('、')}`);
  const introSeg = introBits.filter(Boolean).join('\n');
  if (introSeg) parts.push(`【简介】${introSeg}`);

  // ③ 隶属公司：名字永远在；简介写了才跟在名字后面
  if (co && String(co.name || '').trim()) {
    const coIntro = String(co.intro || '').trim();
    parts.push(`【隶属公司】${co.name}${coIntro ? `\n${coIntro}` : ''}`);
  }

  // ④ 部门：名字永远在；简介 / 部门提示词跟着 —— 经理不吃部门提示词（他挑人派活，不掌握本组干活用的工具）
  const d = readDept(api, d0 ? d0.company : '', card.dept);
  const deptIntro = String(d.intro || '').trim();
  const deptPrompt = String(d.prompt || '').trim();
  const deptBits = (card.role === 'manager' ? [deptIntro] : [deptIntro, deptPrompt]).filter(Boolean);
  parts.push(`【部门】${card.dept}${deptBits.length ? `\n${deptBits.join('\n\n')}` : ''}`);

  // ⑤ 职能：职位提示词，压轴（没写就不出）
  const duty = String(card.prompt || '').trim();
  if (duty) parts.push(`【职能】${duty}`);

  return parts.filter(Boolean).join('\n\n');
}

/**
 * 合成结果落到这个人自己的面板上（改哪一段都调它，改完全组一起同步）
 * 缓存纪律保护：
 *   - 会话未开始（无 chat 记录）：直接写入 systemPrompt；
 *   - 热会话活跃中：systemPrompt 纹丝不动，将改动记为 promptState.pendingDeltas，
 *     在下一轮单次增量通知给模型，并在下一次压缩（热压/冷压/手动压）时收敛固化进基底。
 */
function syncPrompt(api, card) {
  if (!card) return;
  const p = panelOf(api, card);
  if (!p || typeof api.patchPanel !== 'function') return;
  const composed = composePrompt(api, card);
  const currentSys = String((p.spec && p.spec.systemPrompt) || '');
  if (currentSys === composed) return;

  const chatCount = Array.isArray(p.chat) ? p.chat.filter((m) => m && m.role !== 'tool').length : 0;
  if (chatCount === 0 || !currentSys.trim()) {
    // 冷面板 / 新会话：直接更新基准
    api.patchPanel(p.id, {
      spec: { ...(p.spec || {}), systemPrompt: composed },
      promptState: { activeBase: composed, pendingDeltas: [] },
    });
  } else {
    // 热面板：不破坏 KV Cache 前缀，以增量方式暂存
    const existingDeltas = (p.promptState && Array.isArray(p.promptState.pendingDeltas)) ? p.promptState.pendingDeltas : [];
    const newDelta = {
      id: 'delta_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      title: (card.name || t('员工')) + t(' 职能规则更新'),
      text: composed,
      createdAt: Date.now(),
      appliedOnce: false,
    };
    api.patchPanel(p.id, {
      promptState: {
        activeBase: (p.promptState && p.promptState.activeBase) || currentSys,
        pendingDeltas: [...existingDeltas, newDelta],
      },
    });
  }
}

function syncDept(api, deptName) {
  const d = readRegSafe(api).depts.find((x) => x.name === deptName);
  if (!d) return;
  for (const id of [d.manager, ...d.members].filter(Boolean)) syncPrompt(api, cardById(api, id));
}

/** 整家公司重算（改公司名/简介/基础提示词之后） */
function syncCompany(api, coId) {
  const reg = readRegSafe(api);
  for (const d of reg.depts.filter((x) => x.company === coId)) {
    for (const id of [d.manager, ...d.members].filter(Boolean)) syncPrompt(api, cardById(api, id));
  }
}

// ────────────────────────────────────────────────────── 名册（只记结构）

function regPath(api) {
  return api.dataPath(REG);
}

/**
 * 名册 = 公司（id+名）→ 部门（名 + 挂在哪家公司 + 经理/成员 id）。
 * **只记结构**：公司的简介与基础提示词在 companies/ 下的文件里，一个提示词都不在这儿。
 * **旧格式要能读**：以前这里是 `{depts:[...]}`（没有公司层）或更早的 `{title, skills}`
 * 对象数组 —— 前者由 migrate 补出一家公司，后者会当场升成员工卡，所以读到旧形状不能报错。
 */
function readReg(api) {
  let depts = [];
  let companies = [];
  try {
    const d = JSON.parse(fs.readFileSync(regPath(api), 'utf8'));
    depts = Array.isArray(d && d.depts) ? d.depts : [];
    companies = Array.isArray(d && d.companies) ? d.companies : [];
  } catch {
    return { companies: [], depts: [] };
  }
  return {
    companies: companies
      .map((c, i) => ({ id: String((c && c.id) || '').trim() || `co-${i + 1}`, name: String((c && c.name) || '').trim() || t('公司') }))
      .filter((c) => c.id),
    depts: depts
    .map((x) => {
      const old = x && x.manager && typeof x.manager === 'object' && !Array.isArray(x.manager) ? x.manager : null;
      return {
        name: String((x && x.name) || '').trim(),
        /** 经理：新格式是 id 字符串；旧的 `{title}` 先原样留着，交给 migrate 处理 */
        manager: typeof (x && x.manager) === 'string' ? x.manager : '',
        managerTitle: old ? String(old.title || '') : '',
        members: Array.isArray(x && x.members)
          ? x.members.map((m) => (typeof m === 'string' ? m : String((m && m.title) || ''))).filter(Boolean)
          : [],
        /** 旧的成员是对象 —— 带着 title/skills，migrate 要照它建卡 */
        oldMembers: Array.isArray(x && x.members) ? x.members.filter((m) => m && typeof m === 'object') : [],
        /** 挂在哪家公司；旧名册没有这一层，migrate 补 */
        company: String((x && x.company) || '').trim(),
      };
    })
    .filter((d) => d.name),
  };
}

/** 写名册：**只覆盖 depts**，公司层原样留着 —— 各处只改部门时不用带着公司一起传 */
function saveReg(api, depts) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(regPath(api), 'utf8')) || {};
  } catch {
    raw = {};
  }
  const body = {
    ...raw,
    at: Date.now(),
    depts: depts.map((d) => ({
      name: d.name,
      company: d.company || '',
      manager: d.manager || '',
      members: d.members || [],
    })),
  };
  fs.mkdirSync(path.dirname(regPath(api)), { recursive: true });
  fs.writeFileSync(regPath(api), JSON.stringify(body, null, 2), 'utf8');
}

/** 写公司层：同理，只覆盖 companies，部门原样留着 */
function saveCos(api, companies) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(regPath(api), 'utf8')) || {};
  } catch {
    raw = {};
  }
  const body = {
    ...raw,
    at: Date.now(),
    companies: companies.map((c) => ({ id: c.id, name: c.name })),
  };
  fs.mkdirSync(path.dirname(regPath(api)), { recursive: true });
  fs.writeFileSync(regPath(api), JSON.stringify(body, null, 2), 'utf8');
}

function readRegSafe(api) {
  try {
    return readReg(api);
  } catch {
    return { companies: [], depts: [] };
  }
}

/**
 * 旧名册 → 员工卡。读到旧形状（`{title, skills}`）就就地升一次：
 * 一个人一张卡，技能搬进卡里，名册换成 id。
 * 只在真读到旧形状时才动，升级完写回 —— 幂等，跑一百遍结果一样。
 */
function migrate(api) {
  const reg = readRegSafe(api);
  const depts = reg.depts;
  let companies = reg.companies;
  let touched = false;

  // 公司层：旧名册没有 companies → 建一家「公司」，把现有部门全挂上去
  if (!companies.length) {
    const id = `co-${Date.now().toString(36)}`;
    companies = [{ id, name: t('公司') }];
    for (const d of depts) d.company = id;
    saveCos(api, companies);
    if (depts.length) saveReg(api, depts);
  }
  for (const c of companies) ensureCoFile(api, c.id);
  for (const d of depts) {
    if (!d.company || !companies.some((c) => c.id === d.company)) {
      d.company = companies[0].id;
      touched = true;
    }
  }

  for (const d of depts) {
    // 旧经理：`{title}` → 一张 manager 卡
    if (!d.manager && d.managerTitle) {
      const card = writeCard(api, {
        id: newId(),
        name: d.managerTitle,
        dept: d.name,
        role: 'manager',
        intro: `${d.name}的部门经理`,
        prompt: '',
      });
      d.manager = card.id;
      touched = true;
    } else if (d.manager && !readCard(api, d.manager)) {
      d.manager = '';
      touched = true;
    }

    // 旧成员：对象 → 各自的卡
    if (d.oldMembers && d.oldMembers.length) {
      for (const m of d.oldMembers) {
        const title = String((m && m.title) || '').trim();
        if (!title) continue;
        const card = writeCard(api, {
          id: newId(),
          name: title,
          dept: d.name,
          role: 'member',
          skills: Array.isArray(m && m.skills) ? m.skills : [],
        });
        d.members.push(card.id);
        touched = true;
      }
    }

    // 名册里的 id 必须真有一张卡，不然就是死键
    const alive = d.members.filter((id) => !!readCard(api, id));
    if (alive.length !== d.members.length) {
      d.members = alive;
      touched = true;
    }
  }

  /**
   * 内联头像一次性搬到磁盘（幂等，跑一百遍结果一样）：
   * data URL → `.ensoul/state/avatars/<id>.<ext>`，卡上换成相对路径、内联数据不留。
   * 放在迁移里而不是每次读卡时判 —— 这是**一次性的历史包袱**，不该每轮都付一遍判断钱。
   */
  for (const c of allCards(api)) {
    if (!String(c.avatar || '').startsWith('data:')) continue;
    const rel = landAvatar(api, c.id, c.avatar);
    writeCard(api, { ...c, avatar: rel || '' });
    api.log(`[dispatch] ${c.name} 的内联头像已落盘：${rel || '（写不出去，字段清空）'}`);
    touched = true;
  }

  if (touched) saveReg(api, depts);
  return readRegSafe(api);
}

/** 部门 → 它挂在哪家公司（名册里按部门名找，认不到就返回第一家公司兜底） */
function coOfDept(reg, deptName) {
  const d = reg.depts.find((x) => x.name === deptName);
  if (d) return reg.companies.find((c) => c.id === d.company) || reg.companies[0] || null;
  return reg.companies[0] || null;
}

// ────────────────────────────────────────────────────────── 认人 / 找面板

/**
 * 认"他的工作面是哪一块" —— **和 plugins/eschat 的 homesOf 是同一条规矩**（改一处就得改两处）。
 *
 * 一个人的面板常常不止一块：派单开过一块、eschat 开过一块、手上还留着更早的几块。
 * 原来这里只认"卡上记的 id"，那个 id 一过时就按标题抓**第一块**同名面板 —— 于是
 * 派出去的活落在 A 块、用户在 eschat 里看的是 B 块（我们被坑过一次：卡上指着 9/25 那块，
 * 9/26 开的那块才真在干活；还有一次抓到了同名但早就不用的空块）。
 *
 * 所以按面板自己的"热度"挑：① 真是员工工作面 ② 最近说过话 ③ 说得多
 * ④ 都没说过话时，才回到卡上记的 id，再不行看谁最后动过。
 */
function heatOf(chat) {
  let last = 0;
  let n = 0;
  for (const m of Array.isArray(chat) ? chat : []) {
    if (!m || m.role === 'tool') continue;
    if (!(typeof m.content === 'string' && m.content.trim())) continue;
    n++;
    const t = Number((m.createdAt || m.at) || 0);
    if (t > last) last = t;
  }
  return [last, n];
}

function panelOf(api, card) {
  const all = api.panels() || [];
  const want = String((card && card.name) || '');
  const cardId = String((card && card.panel) || '');
  const mine = all.filter((p) => String(p.title || '') === want || String(p.id) === cardId);
  if (!mine.length) return null;
  const key = (p) => [
    p.lockedModel === true && p.noWorkspacePrompt === true ? 1 : 0,
    ...heatOf(p.chat),
    String(p.id) === cardId ? 1 : 0,
    Number(p.updatedAt || 0),
  ];
  return mine.reduce((best, p) => {
    const a = key(p);
    const b = key(best);
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] > b[i] ? p : best;
    }
    return best;
  });
}

/** 把一份对话抄下来 —— 灌进新面板时不能共用同一个数组（改一处两边都变） */
function chatCopy(chat) {
  try {
    return JSON.parse(JSON.stringify(Array.isArray(chat) ? chat : []));
  } catch (e) {
    return [];
  }
}

/**

 * 一份**睡太久**的对话被开回来 → 把工作面清空。
 *
 * 为什么省不得：收纳区里那份是**真开回来**的（同一块面板、同一份 chat）。开回来之后，
 * 紧接着那条派单会带着几天前的完整上下文开跑 —— 新会话等于从没发生（实测就是这样）。
 * 只动这一组字段（与 histconv 的 `/new` 完全同一组），**不碰 histconv 的账**：
 * 那几段一条不少地留在左边抽屉里，员工这一轮该有的【接续锚点】照旧由那边给。
 */
function clearStaleWork(api, p, name) {
  if (!p || typeof api.patchPanel !== 'function') return false;
  const now = Date.now();
  try {
    api.patchPanel(String(p.id), {
      chat: [],
      compact: undefined,
      createdAt: now,
      updatedAt: now,
      newSessionAt: now,
    });
    api.log(`「${name}」的工作面睡太久了，按过期处理：工作面清空（旧的在左边抽屉里）`);
    return true;
  } catch (e) {
    api.log(`清空过期工作面失败：${(e && e.message) || e}`);
    return false;
  }
}

/**
 *
 * 这份对话是不是**已经过期**了 —— 最后一次有人说话到现在，超过了 histconv 的会话边界。
 *
 * 为什么要判它：员工睡着（收进收纳区 / 历史会话）时，他的工作面在 histconv 眼里早就
 * 是"到点该翻篇"的状态；可那个 2 秒的扫描只看**活着**的面板，关着的那份它根本看不见。
 * 于是派单一来，我们把那份几天前的对话原样抄进新工作面 —— 等于把旧上下文整个复活，
 * 新会话从来没发生过（实测就是这么来的：跨 6 天的死会话一路续着）。
 * 过期的对话就不接了：那一份仍然在左边抽屉里（inheritHistconv 已经把账继承过来）。
 */
function staleChat(api, chat) {
  try {
    const rows = Array.isArray(chat) ? chat : [];
    let at = 0;
    for (const m of rows) {
      if (!m || m.role === 'tool') continue;
      const t = Number(m.createdAt) || 0;
      if (t > at) at = t;
    }
    return !!at && Date.now() - at > gapMsOf(api);
  } catch (e) {
    return false; // 判不出来就不拦：宁可接回来，也不能把活卡在这儿
  }
}

/** 会话边界（毫秒）—— 值只声明在 plugins/histconv，这边读同一个键，不另立一份 */
function gapMsOf(api) {
  let min = 0;
  try {
    const all = api.allParams && api.allParams();
    const p = Array.isArray(all) ? all.find((x) => String((x && x.name) || '') === 'histconv') : null;
    min = p && p.values ? Number(p.values.gapMin) || 0 : 0;
  } catch (e) {
    /* 读不到就用兜底 */
  }
  return (min > 0 ? min : 30) * 60000;
}

/**
 * 他名下**睡着的**那份面板（收纳区 / 历史会话）—— 和 plugins/eschat 的 asleep 同一条规矩。
 *
 * 为什么需要它：要一块面板时**只看活着的**，就会新开一块空的，而他的对话正睡在旁边 ——
 * 用户点开看到一片空白，还以为记录丢了（文案组经理、何且曦就是这么攒出来的）。
 * 睡着的两份都是同一个人的对话，不是别的东西：能开就开回来，开不了就把对话抄进来。
 */
function sleepingOf(api, card) {
  try {
    const el = require('electron');
    const base = el && el.app ? el.app.getPath('userData') : '';
    if (!base) return null;
    const name = String((card && card.name) || '');
    const cardId = String((card && card.panel) || '');
    const out = [];
    for (const [where, dir] of [['stow', 'components'], ['closed', 'closed']]) {
      let names = [];
      try {
        names = fs.readdirSync(path.join(base, dir));
      } catch (e) {
        continue; // 目录还没建过 —— 正常
      }
      for (const n of names) {
        if (!n.endsWith('.json')) continue;
        let p = null;
        try {
          p = JSON.parse(fs.readFileSync(path.join(base, dir, n), 'utf8'));
        } catch (e) {
          continue;
        }
        const id = String((p && p.id) || n.slice(0, -'.json'.length));
        if (String((p && p.title) || '') !== name && id !== cardId) continue;
        out.push({ id, where, chat: (p && p.chat) || [], key: [
          p && p.lockedModel === true && p.noWorkspacePrompt === true ? 1 : 0,
          ...heatOf(p && p.chat),
          id === cardId ? 1 : 0,
        ] });
      }
    }
    if (!out.length) return null;
    return out.reduce((best, x) => {
      for (let i = 0; i < x.key.length; i++) {
        if (x.key[i] !== best.key[i]) return x.key[i] > best.key[i] ? x : best;
      }
      return best;
    });
  } catch (e) {
    return null;
  }
}

/**
 * 开一块**他的工作面** —— 员工面板的唯一出处：派单要用的、面板上「叫到岗」要用的，都走这里。
 *
 * hidden = 后台工作面（收得到消息、干得了活，但不占用户布局）；seedChat = 从历史会话接回来时
 * 把那份对话原样抄进新面板（旧文件一个字节不动）。
 *
 * 这段原来住在 setup() 里，却被模块级的 wakeOrOpen 调用 —— 函数声明只在 setup 的作用域里可见，
 * 于是"他的面板没了 → 新开一块"那条路一走到就 ReferenceError，被 place() 兜成一句「开工作面时出错」。
 * 提到模块级就是为了这条路真能走通。
 */
function inheritHistconv(api, oldId, newId) {
  try {
    if (!oldId || !newId || oldId === newId) return;
    const histDir = api.dataPath('.ensoul/state/histconv');
    const oldFile = path.join(histDir, `${String(oldId).replace(/[^\w.-]+/g, '_')}.json`);
    const newFile = path.join(histDir, `${String(newId).replace(/[^\w.-]+/g, '_')}.json`);
    if (!fs.existsSync(oldFile)) return;
    const oldData = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
    let newData = { at: Date.now(), arch: 0, entries: [] };
    if (fs.existsSync(newFile)) {
      try { newData = JSON.parse(fs.readFileSync(newFile, 'utf8')); } catch {}
    }
    const map = new Map();
    for (const e of (oldData.entries || [])) if (e && e.key) map.set(e.key, e);
    for (const e of (newData.entries || [])) if (e && e.key) map.set(e.key, e);
    newData.entries = Array.from(map.values()).sort((a, b) => (a.from || 0) - (b.from || 0));
    if (oldData.anchor && !newData.anchor) newData.anchor = oldData.anchor;
    fs.mkdirSync(histDir, { recursive: true });
    fs.writeFileSync(newFile, JSON.stringify(newData, null, 2), 'utf8');
    api.log(`[dispatch] 历史会话继承成功：${oldId} -> ${newId}（共 ${newData.entries.length} 条）`);
  } catch (e) {
    api.log(`[dispatch] 历史会话继承失败：${(e && e.message) || e}`);
  }
}

function openWorkPanel(api, card, hidden, seedChat) {
  const p = api.createPanel({
    title: card.name,
    kind: 'chat',
    // hidden = 后台工作面：收得到消息、干得了活，但不占用户的布局（见 Panel.hidden）。
    // 派单时自动开的就是这种 —— 员工该不该显形是用户的事，跟接不接活无关。
    hidden: !!hidden,
    // seedChat：从历史会话接回来时，把那份对话原样抄进新面板（旧文件一个字节不动）
    chat: chatCopy(seedChat),
    look: { accent: card.role === 'manager' ? '#e0a35f' : '#5b8cff', density: 'normal', showChat: true },
    spec: { body: 'messages', systemPrompt: composePrompt(api, card), actions: [], fields: [], text: '' },
  });
  if (card.model && typeof api.setModel === 'function') api.setModel(p.id, card.model);
  // 经理**不开思考**：派单、转述、回话都是看一眼就该决定的活，让它想只是白等。
  if (String(card.role) === 'manager' && typeof api.setThink === 'function') api.setThink(p.id, 'off');
  // lockedModel：会话区不给换模型；noWorkspacePrompt：他只叠通用提示词 + 专属那份，不收全局说明
  // **不写 component**：员工是个人，不是一份组件（见 shared/types 的 isComponentPanel）——
  // 他该在 设置 → agent 里按名册管，不该跑进 设置 → 组件 那张"可复用的做法"架子。
  if (typeof api.patchPanel === 'function') api.patchPanel(p.id, { lockedModel: true, noWorkspacePrompt: true, tools: toolsOf(api, card) });
  const oldPid = String(card.panel || '');
  if (oldPid && oldPid !== p.id) {
    inheritHistconv(api, oldPid, p.id);
  }
  const next = writeCard(api, { ...card, panel: p.id });
  return { panel: p, card: next };
}

/**
 * 把**调度中心那块面板**摆到眼前：已经有了就切过去，没有就现开一块。
 *
 * 编制的编辑台只有一块 —— 设置里点「在调度中心中查看」走的就是它：
 * 设置那一页只管看一眼、点两下，真要改组织还是回那边去改。
 */
function openBoardPanel(api) {
  const live = (api.panels() || []).find((p) => String(p.kind) === PANEL_DECL.kind);
  if (live) {
    if (typeof api.activatePanel === 'function') api.activatePanel(String(live.id));
    else api.showPanel(String(live.id));
    return { panel: live, how: 'live' };
  }
  const p = api.createPanel({
    kind: PANEL_DECL.kind,
    title: PANEL_DECL.title || PANEL_DECL.label,
    look: { ...(PANEL_DECL.look || {}) },
    spec: { body: PANEL_DECL.body || 'messages', systemPrompt: '', actions: [], fields: [], text: '' },
  });
  if (typeof api.activatePanel === 'function') api.activatePanel(String(p.id));
  return { panel: p, how: 'new' };
}
/**
 * 要一块能干活的他的面板 —— **先唤醒睡着的，实在没有才新开**。
 * 派单和「开工作面」都走这一条：两条路各写一份，迟早又分叉成两种行为。
 */
function wakeOrOpen(api, card, hidden) {
  const live = panelOf(api, card);
  if (live) {
    if (String(card.panel || '') !== String(live.id)) {
      inheritHistconv(api, card.panel, live.id);
      writeCard(api, { ...card, panel: String(live.id) });
    }
    return { panel: live, card, how: 'live' };
  }

  const sleep = sleepingOf(api, card);
  if (sleep && sleep.where === 'stow' && typeof api.openComponent === 'function') {
    try {
      const p = api.openComponent(sleep.id);
      if (p) {
        if (hidden && typeof api.hidePanel === 'function') api.hidePanel(String(p.id));
        if (staleChat(api, p.chat)) clearStaleWork(api, p, card.name);
        api.log(`[dispatch] 把「${card.name}」从收纳区叫回工作面 ${p.id}`);
        return { panel: p, card: writeCard(api, { ...card, panel: String(p.id) }), how: 'stow' };
      }
    } catch (e) {
      api.log(t('从收纳区叫回失败：') + ((e && e.message) || e));
    }
  }

  if (sleep && sleep.chat && sleep.chat.length && !staleChat(api, sleep.chat)) {
    api.log(`[dispatch] 把「${card.name}」睡着的对话接进新工作面（${sleep.chat.length} 条）`);
    return { ...openWorkPanel(api, card, hidden, sleep.chat), how: 'seed' };
  }

  return { ...openWorkPanel(api, card, hidden), how: 'new' };
}

function cardById(api, id) {
  return id ? readCard(api, id) : null;
}

/** 按名字（或 id）找一张卡：先精确、再"名字里含" */
function findCard(api, word) {
  const w = String(word || '').trim();
  if (!w) return null;
  const cards = allCards(api);
  return cards.find((c) => c.id === w) || cards.find((c) => c.name === w) || cards.find((c) => c.name.includes(w)) || null;
}

function pickDept(depts, word) {
  const w = String(word || '').trim();
  if (!w) return null;
  return depts.find((d) => d.name === w) || depts.find((d) => d.name.includes(w) || w.includes(d.name)) || null;
}

/** 这块面板是哪个部门的经理？不是经理就 null */
function deptOfManager(api, depts, panelId) {
  if (!panelId) return null;
  for (const d of depts) {
    const p = d.manager ? panelOf(api, cardById(api, d.manager) || {}) : null;
    if (p && p.id === panelId) return d;
  }
  return null;
}

/**
 * 这块面板是不是某个部门的经理？
 * 要它是因为**交付话术得看人**：经理只挑人转发，不该有"提交令牌"这个动作。
 * 原来两种人看到的是同一句"干完到插件提交令牌"，于是经理转派完也照着交了一遍 ——
 * 一个令牌交两次，图还被它自己搬进了自己那块对话。
 */
function isManagerPanel(api, pid) {
  try {
    return !!deptOfManager(api, readReg(api).depts, pid);
  } catch {
    return false;
  }
}

/**
 * 部门简介，压成**一行**带出来；没写就返回空串。两个地方要它：
 * 每轮的【组织（实时）】注入、以及 orgLine（无参派单 / 报错时那句「当前组织架构」）。
 * 折一行是因为这段每轮都发、按行计价（prompt-protocol §5）。
 * 一份逻辑两处用，是吃过亏的：简介原来只拼进**本部门成员自己**的合成提示词
 * （composePrompt ④），于是「git 归开源组」这句话只送到了开源组眼前，
 * 组外的人拿到一张只有五个组名的名单 —— 名字判不了归属，越界就是这么发生的。
 */
function introOf(api, coId, deptName) {
  const intro = String(readDept(api, coId, deptName).intro || '').trim().replace(/\s+/g, ' ');
  return intro ? ` —— ${intro}` : '';
}

function orgLine(api, depts) {
  return depts
    .map((d) => {
      const mgr = cardById(api, d.manager);
      const ms = d.members.map((id) => (cardById(api, id) || {}).name || '?').join('、') || t('暂无');
      return `${d.name}${introOf(api, d.company, d.name)}（经理：${(mgr && mgr.name) || '未设'}；员工：${ms}）`;
    })
    .join('\n');
}

/** 从一句回话里认"不归我 → 转xx组" */
function rerouteTo(text) {
  const m = String(text || '').match(/不归我[^\n]{0,80}?转\s*(?:给)?\s*([^\s，,。.;；、：:）)】\]]+)/);
  return m ? m[1].trim() : '';
}

/**
 * 认派单目标：先认人、再认部门经理。**工具和面板走同一个函数** ——
 * 面板上点一下和模型说一句"派给文案组"必须落到同一条路上。
 */
function resolveTarget(api, depts, deptWord, empWord, opts) {
  /**
   * 认到人 → 要一块他**真能干活**的面板。两条路，缺一条就会误报：
   *   ① 活着的（panelOf 认热度最高的那块）直接用；
   *   ② 没有就一律走 **wakeOrOpen** —— 睡在收纳区 / 历史会话里的叫回来、接上那份对话，
   *      实在没有才新开一块（hidden = 后台工作面：收得到消息、干得了活，不占用户布局）。
   *
   * 为什么 ② 必须包含"睡着的"：原先是 `panelOf || ensure` 两步走，第二步只看"能不能现开"
   * —— 面板被收纳或收进历史会话的人，**模型明明有效**，也会走到"开不出来"那一句上，
   * 报文还把它怪成"没指定模型"（开发组经理那单就是这么被挡回来的）。模型有效、人也在编，就该派得出去。
   *
   * 报错文案按**真正的原因**分岔：没模型说没模型，其余说"打不开工作面"，不再一律甩锅模型。
   */
  const place = (card) => {
    /**
     * 先认**活着的**：有现成的就直接用，模型空不空都不用管 ——
     * 那块面板就在那儿、收得到消息、跑得完一轮，派单没有理由因为它卡上缺个模型就拒收。
     */
    let p = panelOf(api, card);
    let why = '';
    if (!p) {
      // 没有才要开：开一块新工作面**必须有模型**（没模型开出来的面板派过去也是白开）
      if (!card.model) return { panel: null, why: t('卡上还没指定模型') };
      try {
        const r = wakeOrOpen(api, card, !!(opts && opts.hidden));
        p = (r && r.panel) || null;
        if (p) api.log(`[dispatch] 工作面就位（${r.how}）：${card.name} → ${p.id}`);
        else why = t('面板没能创建出来');
      } catch (e) {
        why = t('开工作面时出错：') + String((e && e.message) || e);
      }
    }
    // 认到的这块就是他的工作面了 —— **写回卡**，让"他的面板"以后只有一个答案。
    // 不写回的话，下次认人还得再猜一遍，卡上那份 id 会一直指着早就关掉的那一块
    // （这次"eschat 看不到美术组的记录"，根子就在这儿）。写失败不算派单失败。
    try {
      if (p && String(card.panel || '') !== String(p.id)) {
        writeCard(api, { ...card, panel: p.id });
      }
    } catch (e) {
      api.log(t('写回工作面 id 失败：') + ((e && e.message) || e));
    }
    return { panel: p || null, why };
  };

  /** 打不开时的那一句 —— 有模型就别再怪模型 */
  const cannot = (who, card, why) =>
    card && card.model
      ? `${who}的工作面开不出来 —— 他卡上有模型（${card.model}，是有效的），不是模型的问题：${why || '原因不明'}。`
      : `${who}${why ? ` —— ${why}` : ' —— 多半是他卡上还没指定模型'}。去调度中心给他挑一个模型再派。`;

  if (empWord) {
    const card = findCard(api, empWord);
    if (!card) return { error: `名册里没有叫「${empWord}」的员工。当前组织架构：\n${orgLine(api, depts)}` };
    const r = place(card);
    if (!r.panel) return { error: cannot(`「${card.name}」`, card, r.why) };
    return { target: r.panel, card, label: `${card.name}（${card.dept}）` };
  }
  const d = pickDept(depts, deptWord);
  if (!d) return { error: `没有叫「${deptWord}」的部门。当前组织架构：\n${orgLine(api, depts)}` };
  const mgr = cardById(api, d.manager);
  if (!mgr) return { error: `「${d.name}」还没设经理。去调度中心给它指定一个（要有模型才能干活）。` };
  const r = place(mgr);
  if (!r.panel) return { error: cannot(`「${d.name}」的经理（${mgr.name}）`, mgr, r.why) };
  return { target: r.panel, card: mgr, label: t('{m}（{d}经理）', { m: mgr.name, d: d.name }) };
}

/** 持久入队，立即返回任务编号；目标忙时由核心队列接力。 */
async function deliver(api, depts, origin, target, label, task, ticket, opts) {
  if (target.id === origin.id) return JSON.stringify({ ok: false, error: '不能向自己派单' });
  const parent = opts.context?.taskId && api.tasks.get(opts.context.taskId, origin.id);
  if (parent?.correlationId === ticket.token && ticket.holder && ticket.holder !== origin.id && ticket.holder !== target.id) {
    return JSON.stringify({ ok: false, taskId: ticket.taskId, error: '该令牌已经流转给另一执行人，请查询原任务，不能另开一条执行分支' });
  }
  const packet = ticketBanner(ticket) + '任务内容：' + stripPacketHead(task);
  const result = api.tasks.submit({
    panelId: target.id, text: packet, title: label,
    requestId: ticket.token + ':' + target.id, correlationId: ticket.token,
  }, opts.context);
  if (!result.ok) return JSON.stringify(result);
  if (!result.reused) {
    try { moveHolder(api, ticket.token, target.id, label, result.task.id); }
    catch (error) {
      api.tasks.cancel(result.task.id, origin.id);
      return JSON.stringify({ ok: false, taskId: result.task.id, error: String(error?.message || error) });
    }
  }
  api.log('[dispatch] ' + origin.name + ' → ' + label + ' · ' + result.task.id);
  return JSON.stringify({ ok: true, taskId: result.task.id, token: ticket.token,
    status: result.task.status, reused: result.reused,
    message: '任务已登记；这不代表完成或验收通过。通过 task_status 查询结果，不要重复派单或循环轮询。' });
}

// ──────────────────────────────────────────────────── 完成的工作（成功案例）

/**
 * 完成的工作 = **活确认有效之后**才记的一条成功案例：只存「做了什么 + 实现路径」，
 * 不存对话、不存回执原文 —— 上下文过两天就没用了，路径才是能复用的。
 * 存应用资料目录：.ensoul/state/cases/<员工名>/成功案例.json（姓名全局唯一；改名时 saveCard 把文件夹一起搬）。
 */
const CASES_DIR = '.ensoul/state/cases';
const CASE_MAX = 30;

function casesFile(api, name) {
  const employee = String(name || '').trim();
  const destination = api.dataPath(path.join(CASES_DIR, employee, '成功案例.json'));
  migrateCaseFile(api, employee, destination);
  return destination;
}

function migrateCaseFile(api, employee, destination) {
  const source = path.join(api.workspace || '.', 'work', employee, '成功案例.json');
  if (!fs.existsSync(source)) return;
  const crypto = require('crypto');
  const project = crypto.createHash('sha256').update(path.resolve(api.workspace || '.')).digest('hex').slice(0, 16);
  const reportFile = api.dataPath(`.ensoul/migrations/dispatch-cases/${project}.json`);
  let report = { workspace: api.workspace, records: {} };
  try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch {}
  const fingerprint = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  if (report.records?.[source]?.fingerprint === fingerprint) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  let status = 'copied';
  if (!fs.existsSync(destination)) fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  else if (fs.readFileSync(source).equals(fs.readFileSync(destination))) status = 'same';
  else {
    status = 'conflict';
    api.log(`[dispatch] 员工案例冲突，保留原件：${source}；现有资料：${destination}`);
  }
  report.records = report.records || {};
  report.records[source] = { source, destination, fingerprint, status, at: Date.now() };
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
}

function readCases(api, name) {
  try {
    const j = JSON.parse(fs.readFileSync(casesFile(api, name), 'utf8'));
    const list = Array.isArray(j) ? j : Array.isArray(j && j.cases) ? j.cases : [];
    return list
      .map((c) => ({
        at: Number((c && c.at) || 0),
        work: String((c && c.work) || '').slice(0, 200),
        how: String((c && c.how) || '').slice(0, 400),
      }))
      .filter((c) => c.work || c.how);
  } catch {
    return [];
  }
}

function writeCases(api, name, list) {
  const f = casesFile(api, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(list.slice(-CASE_MAX), null, 2), 'utf8');
}

// ──────────────────────────────────────────────────────── 派单令牌 / 收件箱
//
// 为什么要有它：派单是**同步嵌套**的 —— A 调 dispatch，一路 await 到最底下那个员工，
// 回执再一层层翻上来。所以**文字**本来就带得回来；带不回来的是**文件**：
// 二伯用 comfyui 出的图挂在他自己那条消息上，翻到 A 手里只剩一句"画好了"。
//
// 于是给每次派单发一个**令牌**，令牌跟着任务往下走、每一跳换一次手（holder）：
//   A 派单  → 令牌 tk-x（from = A，holder = 美术组经理）
//     经理挑人转派 → **同一个令牌**，holder = 二伯
//       二伯画完调 deliver_result({token:"tk-x", files:[…]})
//         → 文件直接挂进 A 的对话，A 不用问路、二伯也不用知道 A 是谁
//
// **同一个令牌一路走到底**是这套东西的关键：中间任何一跳都用不着抄令牌，只要它
// 还是 holder，addPrompt 每轮就把它手上的令牌摆在眼前（见 waitLines），
// 所以经理哪怕用自己的话转述一遍，链路也不会断 —— 而断了是不会报错的，
// 只会静悄悄地没人交回来，那是最难查的一类失败。
//
// 令牌**不是面板**：它是收件箱里的一条记录。面板要拖要关，拿来当令牌用会断；
// 而"用户手一滑关掉一块面板就把一条流程弄丢"是这个软件里最不该发生的事。

const inboxFile = (api) => api.dataPath(INBOX_FILE);

/** 收件箱里的一条，形状在这儿定死一遍：外部（含人手改过的）读进来一律过这道 */
function normTicket(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  return {
    token: String(t.token || '').trim(),
    requestId: String(t.requestId || ''),
    requestDigest: String(t.requestDigest || ''),
    taskId: String(t.taskId || ''),
    at: Number(t.at || 0),
    /** 谁发起的：交付时文件就挂到这块面板上 */
    fromPanel: String(t.fromPanel || ''),
    fromName: String(t.fromName || '上游'),
    /** 发起时要求的是什么 —— 到货提醒要把这句原话还给他 */
    task: String(t.task || '').slice(0, 400),
    /** 现在这个令牌在谁手上（交付时按它认人；不认识人只认号） */
    holder: String(t.holder || ''),
    holderName: String(t.holderName || ''),
    /** 转了几手，只作痕迹 */
    hops: Array.isArray(t.hops) ? t.hops.map((h) => String(h).slice(0, 80)).slice(-8) : [],
    status: ['done', 'cancelled', 'accepted', 'spare'].includes(t.status) ? t.status : 'pending',
    acceptedAt: Number(t.acceptedAt || 0),
    score: String(t.score || ''),
    starred: t.starred === true,
    workSummary: String(t.workSummary || ''),
    howSummary: String(t.howSummary || ''),
    rejectCount: Number(t.rejectCount || 0),
    lastRejectReason: String(t.lastRejectReason || ''),
    /** 谁交的 */
    by: String(t.by || ''),
    note: String(t.note || '').slice(0, 400),
    files: Array.isArray(t.files) ? t.files.map((f) => String(f)).filter(Boolean).slice(-20) : [],
    doneAt: Number(t.doneAt || 0),
    /**
     * 被**手动撤单**的时刻（0 = 没撤过）。
     *
     * 撤单只改账，不改已经在跑的那一轮：撤销一个令牌之后，它不再算"欠着"、
     * 不再摆到持股人的眼前，之后就算交上来也不再收 —— 但那边该跑完的这一轮照跑。
     * 真去打断一轮要花一次模型调用，那是另一件事，不混在这里。
     */
    cancelledAt: Number(t.cancelledAt || 0),
    /**
     * 交付的**那一刻**发起人正好在等 dispatch（同步链路），路径已经写进他的回执了。
     * 有这个标记就不必再叫他一趟 —— 同一件事说两遍是纯噪音。
     * 只有"派单早返回了、东西后来才到"的活才需要叫醒。
     */
    receiptAt: Number(t.receiptAt || 0),
    /**
     * 发起人派这一单时声明的**交付之后还要接着办什么**（照抄他的原话）。
     *
     * 空 = 交了就完：图挂进他的对话、到此为止，一个字都不说（"画张亚丝娜"就是这种）。
     * 有 = 交付到位时把他叫起来，把这句话原样摆在他面前，他接着往下干。
     *
     * **判据在发起人手里**（他自己当场说"完"还是"接着办"），不在交付人手里，
     * 也不按任务类型去猜 —— 同一张图，今天只是想看看、明天是要接到画面上，类型没变。
     */
    follow: String(t.follow || '').slice(0, 400),
  };
}

function readInbox(api) {
  try {
    const j = JSON.parse(fs.readFileSync(inboxFile(api), 'utf8'));
    const list = Array.isArray(j) ? j : Array.isArray(j && j.entries) ? j.entries : [];
    return list.map(normTicket).filter((t) => t.token);
  } catch {
    return [];
  }
}

function writeInbox(api, list) {
  const f = inboxFile(api);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ at: Date.now(), entries: list.slice(-INBOX_MAX) }, null, 2), 'utf8');
}

function newToken() {
  return `tk-${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`;
}

function ago(ms) {
  const d = Date.now() - Number(ms || 0);
  if (!Number.isFinite(d) || d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  return `${Math.floor(d / 86400000)} 天前`;
}

/**
 * 这块面板手上正拿着哪个令牌（派给它的活还没交付）。
 * 按 holder 现读文件认，**不在内存里记** —— 插件文件一改就重载，内存表会没，
 * 而令牌一丢就是"没人交回来还不报错"。
 */
function heldTicket(api, panelId, taskId) {
  if (!panelId) return null;
  if (taskId) {
    const task = api.tasks.get(taskId, panelId);
    if (task?.correlationId) return readInbox(api).find((ticket) => ticket.token === task.correlationId && ticket.holder === panelId && ticket.status === 'pending') || null;
  }
  const now = Date.now();
  const mine = readInbox(api).filter((t) => t.holder === panelId && t.status === 'pending' && now - t.at < WAIT_TTL);
  return mine.length ? mine[mine.length - 1] : null;
}

/**
 * 发一个令牌：他自己接的是新活就新建一个；他本来就是**替别人转派**
 * （手上有令牌）就把同一个令牌交下去 —— 一路走到底，交付时直接落回最初那个人。
 * **这里不写 holder** —— 等真送出去了再写（moveHolder），
 * 否则"没送成"的派单也会把令牌挂在对方名下，以后按 holder 认人就认错。
 */
function issueToken(api, fromPanel, fromName, task, follow, requestId, requestDigest, taskId) {
  const list = readInbox(api);
  const current = taskId && api.tasks.get(taskId, fromPanel);
  const carry = current?.correlationId ? list.find((ticket) => ticket.token === current.correlationId) : heldTicket(api, fromPanel);
  if (carry) {
    const i = list.findIndex((t) => t.token === carry.token);
    if (i >= 0) return list[i];
  }
  const previous = list.find((ticket) => ticket.fromPanel === fromPanel && ticket.requestId === requestId);
  if (previous) {
    if (previous.requestDigest && previous.requestDigest !== requestDigest) throw new Error('requestId 已用于另一份派单，请查询原任务或使用新编号');
    return previous;
  }
  const t = normTicket({
    token: newToken(),
    at: Date.now(),
    fromPanel,
    fromName,
    requestId,
    requestDigest,
    task: String(task || '').slice(0, 400),
    follow: String(follow || '').slice(0, 400),
    status: 'pending',
  });
  writeInbox(api, [...list, t]);
  return t;
}

/** 令牌换手：谁接了这单活，谁就是当前的 holder */
function moveHolder(api, token, panelId, label, taskId) {
  if (!token || !panelId) return;
  const list = readInbox(api);
  const i = list.findIndex((t) => t.token === token);
  if (i < 0) return;
  const hop = `→ ${label}`;
  const hops = list[i].hops.includes(hop) ? list[i].hops : [...list[i].hops, hop];
  list[i] = { ...list[i], taskId: list[i].taskId || taskId, holder: panelId, holderName: label, hops };
  writeInbox(api, list);
}

/**
 * 撤销单个令牌：
 * 只有 pending 状态的令牌才能撤；撤完更新状态为 cancelled，打上时间戳并记录日志。
 */
function cancelSingleTicket(api, token, reason) {
  const inbox = readInbox(api);
  const i = inbox.findIndex((x) => x.token === token);
  if (i < 0) return { ok: false, msg: '收件箱里没有令牌 ' + token };
  const it = inbox[i];
  if (it.status === 'done' || it.status === 'accepted') {
    return { ok: false, msg: '令牌 ' + token + ' 已经交付/结案，无法撤单。' };
  }
  if (it.status === 'cancelled') {
    if (api.tasks) api.tasks.cancelCorrelation(token, it.fromPanel);
    return { ok: true, msg: '令牌 ' + token + ' 此前已被撤单。' };
  }
  if (api.tasks) api.tasks.cancelCorrelation(token, it.fromPanel);
  inbox[i] = {
    ...it,
    status: 'cancelled',
    cancelledAt: Date.now(),
    cancelReason: reason || '主动撤销',
  };
  writeInbox(api, inbox);
  api.log('[dispatch] 令牌 ' + token + ' 已撤单（原因：' + (reason || '无') + '）');
  return { ok: true, msg: '已撤回令牌 ' + token + '（任务「' + (it.task || '').slice(0, 32) + '」）。' };
}

/**
 * 巡检：把"没有承办人"的孤儿令牌收掉。
 *
 * issueToken 是**先落盘**再送任务的，而"送出去"这一步有两处断在 moveHolder 之前
 * （不能自派 / 目标正忙）—— 那两处一断，令牌就留在收件箱里、holder 为空：谁也不认它，
 * 可 delivery-alert 过 60 秒就会判它"没有承办人"、报到发起人那里；发起人收到就重派，
 * 重派又撞同一个忙 → 又一张孤儿。2026-10-04 那晚连着四条重单就是这么滚出来的。
 *
 * 送失败当场回收是主路（见 deliver 收尾那一段）；这里是兜底 —— 进程死在半路时
 * 当场那一段根本没跑到，残留只能靠下一次开机或下一跳收干净。
 * 判据两条，缺一不可：没有 holder（真没人接）+ 过了 ORPHAN_GRACE（还在送路上的别抢着撤）。
 */
let taskJournalStamp = '';
let taskTicketIndex = new Map();
function sweepOrphans(api) {
  const now = Date.now();
  const inbox = readInbox(api);
  const journal = api.dataPath('.ensoul/state/tasks.json');
  const stat = fs.existsSync(journal) ? fs.statSync(journal) : null;
  const stamp = stat ? `${journal}:${stat.mtimeMs}:${stat.size}` : '';
  if (stamp !== taskJournalStamp) {
    const tasks = stat ? JSON.parse(fs.readFileSync(journal, 'utf8')).tasks || [] : [];
    const index = new Map();
    for (const task of tasks) {
      if (!task.correlationId) continue;
      const list = index.get(task.correlationId) || [];
      list.push(task); index.set(task.correlationId, list);
    }
    taskTicketIndex = index; taskJournalStamp = stamp;
  }
  let n = 0;
  for (const it of inbox) {
    if (!it || it.status !== 'pending') continue;
    const linked = taskTicketIndex.get(it.token) || [];
    const stopped = linked.find((task) => ['cancelled', 'cancelling', 'interrupted', 'failed'].includes(task.status));
    if (stopped) {
      it.status = 'cancelled'; it.cancelledAt = now;
      it.cancelReason = stopped.error || '关联任务已停止，请查询 taskId'; n++;
      continue;
    }
    if (linked.length && !it.holder) {
      const target = linked[linked.length - 1];
      it.holder = target.panelId; it.holderName = target.title;
      it.taskId = linked.find((task) => task.originPanelId === it.fromPanel)?.id || target.id;
      n++;
    }
    if (it.holder) continue;
    if (now - Number(it.at || 0) < ORPHAN_GRACE) continue;
    it.status = 'cancelled';
    it.cancelledAt = now;
    it.cancelReason = '没有承办人（送出前就断了），已自动回收';
    n += 1;
  }
  if (!n) return 0;
  writeInbox(api, inbox);
  api.log(`[dispatch] 已同步 ${n} 张令牌的执行状态`);
  return n;
}

/**
 * 挂在任务开头的那一段：**只报令牌号**。
 *
 * 交付该怎么走不在这儿讲 —— 那是每轮都在的通用上下文（waitLines 的【派单令牌】那段）
 * 和 deliver_result 的工具说明在管。这一段会跟着任务永久留在对方的对话历史里，每轮重发一遍，
 * 写长了就是每轮都为同一句话付钱；更要紧的是**别写「来自 X」** —— 对方会以为东西要交回给 X，
 * 而交付落点只认令牌，不认正文里出现的名字。
 */
function ticketBanner(ticket) {
  return ticket ? `【派单令牌 ${ticket.token}】` : '';
}

/**
 * 拼包之前，剥掉**上一跳已经拼在开头**的票头。
 *
 * 为什么会有：经理那一跳是「把收到的原话原样转发」，而原话就是上一跳拼出来的整包
 * （开头带着【派单令牌 …】任务内容：）。不剥就再拼一层，送过去是叠两个头。
 * 只动开头：正文中间出现同样的字样，那是他自己在说事，一个字不碰。
 */
function stripPacketHead(text) {
  let s = String(text == null ? '' : text);
  for (let i = 0; i < 4; i++) {
    const t = s.replace(/^\s*【派单令牌[^】]*】\s*(?:任务内容：\s*)?/, '');
    if (t === s) break;
    s = t;
  }
  return s;
}

/**
 * 每轮摆在眼前的一段：借的人和被借的人都得看见。
 *   手上拿着令牌的人 —— 告诉他交付走哪个号；
 *   派出去还没回的人 —— 告诉他别去催、文件自己会来。
 */
function waitLines(api, pid, taskId) {
  if (!pid) return '';
  const now = Date.now();
  const list = readInbox(api).filter((t) => now - t.at < WAIT_TTL);
  const out = [];
  const isMgr = isManagerPanel(api, pid);
  const current = taskId && api.tasks.get(taskId, pid);
  for (const tk of list.filter((x) => x.holder === pid && x.status === 'pending' && (!current?.correlationId || x.token === current.correlationId)).slice(-2)) {
    out.push(
      isMgr
        ? `【派单令牌 ${tk.token}】「${tk.fromName}」派来的活（要求：${tk.task.slice(0, 120)}）归你**挑人转发** ——`
          + t('转给本组员工时把令牌带上就行；**你自己不提交令牌、不搬文件**，交付是执行人的活。')
          + `\n这是**还没转出去**的单：转发成功后这一段下一轮就消失 —— 下一轮还看见它，就是没发出去，先补派。`
        : `【派单令牌 ${tk.token}】「${tk.fromName}」派来的活（要求：${tk.task.slice(0, 120)}）在你手上 ——`
          + `干完用 **deliver_result({token:"${tk.token}", files:[…]})** 提交：东西由插件直接送到派单人那块对话，`
          + t('你不用管他是谁，也别往别处搬。')
    );
  }
  // 【已结的单】撤单和交付只在 /inbox 里看得见 —— 执行人新会话看不到，他清单里
  // 那条"欠一次交付"就成了坏账，只能翻工作区考古（真发生过：对着已交付的单找了十几轮令牌）。
  const settled = list.filter((x) => x.holder === pid && (x.status === 'cancelled' || x.status === 'done'));
  if (settled.length) {
    const last = settled[settled.length - 1];
    const verb = last.status === 'cancelled' ? '已撤单，不用交了' : '你已交付，别重复交';
    out.push(
      `【已结的单】${last.token} ${verb}${settled.length > 1 ? `（另有 ${settled.length - 1} 单已结，敲 /inbox 可查）` : ''}`
      + t(' —— 派单状态为准；你清单里若还挂着这单的条目，把它删掉或标完成。'),
    );
  }
  const mine = list.filter((x) => x.fromPanel === pid && x.status === 'pending' && x.holder !== pid);
  if (mine.length) {
    out.push(
      t('【派出去的单】还没交付的 {n} 件：', { n: mine.length })
      + `${mine.slice(-3).map((tk) => `${tk.token}→${tk.holderName || t('在办')}`).join('、')}。`
      + t('对方一提交令牌，插件就会来告诉你「哪个令牌完成了」—— 交付的文件按那个令牌查（敲 /inbox）。')
    );
  }
  /**
   * 【到货】—— 给"派单早结束了、东西后来才到"的活补一句话。
   *
   * 经理那一跳改成转发即结束之后，发起人那条回执是**抢在交付之前**的，所以路径得在这儿
   * 补回来（图会自己挂进对话，可路径说不出口，他后面还要拿它去做别的事）。
   * 说过一次就盖上 receiptAt —— 同一件事每轮重讲一遍是纯噪音，而且每轮都付钱。
   */
  const arrived = list.filter((x) => x.fromPanel === pid && x.status === 'done' && x.files.length && !x.receiptAt);
  if (arrived.length) {
    out.push(
      t('【到货】你派出去的单已经交回来了：\n')
      + arrived
        .map((t) => `· ${t.token} ← ${t.by || t.holderName || '对方'}：${t.files.join('、')}${t.note ? `（${t.note}）` : ''}`)
        .join('\n')
    );
    const all = readInbox(api);
    for (const t of arrived) {
      const i = all.findIndex((x) => x.token === t.token);
      if (i >= 0) all[i] = { ...all[i], receiptAt: Date.now() };
    }
    writeInbox(api, all);
  }
  return out.join('\n');
}

/**
 * 这次派单期间对方已经交东西回来了没有 —— 同步链路里发起人就是靠这一行知道文件路径的
 * （图会自己挂进对话，但**路径**得说出来，他后面还得拿它去做别的事）。
 */
function deliveredNote(api, token) {
  const list = readInbox(api);
  const i = list.findIndex((x) => x.token === token);
  if (i < 0) return '';
  const t = list[i];
  if (t.status === 'done' && t.files.length) {
    // 送到这儿就算"已经通知过了"：文件挂进他对话、路径写在回执里，两头都到位
    if (!t.receiptAt) {
      list[i] = { ...t, receiptAt: Date.now() };
      writeInbox(api, list);
    }
    return `\n\n【✅ 契约已闭环】交付物已成功送达（${t.by || t.holderName || '对方'}）：\n${t.files.map((f) => `· ${f}`).join('\n')}`;
  }
  if (t.status === 'pending') {
    return `\n\n【⚠️ 契约未闭环】执行人「${t.holderName || '对方'}」尚未调用 deliver_result 提交交付物，令牌「${t.token}」当前仍处于挂起状态。若对方已输出文件，请督促其执行 deliver_result 提交以完成闭环。`;
  }
  return '';
}

// ──────────────────────────────────────────── 每轮给经理注入部门花名册

/** 一张卡的"简历"两行字 —— 经理挑人看的就是这几样 */
function resumeOf(api, card, withWork) {
  const bits = [];
  if (card.intro) bits.push(card.intro);
  if (card.skills.length) bits.push(`能力：${card.skills.join('、')}`);
  if (card.strength) bits.push(`特长：${card.strength}`);
  const learned = (card.learned || []).map((l) => l.name).filter(Boolean);
  if (learned.length) bits.push(`已学会：${learned.join('、')}`);
  bits.push(card.model ? `模型：${card.model.split('::').slice(-1)[0]}` : t('模型：**未指定（开不了工）**'));
  const head = `· ${card.name}｜${bits.join('｜')}`;
  if (!withWork) return head;
  const done = readCases(api, card.name)
    .slice(-3)
    .reverse()
    .map((c) => c.work)
    .filter(Boolean);
  return done.length ? `${head}\n    完成：${done.join(' ／ ')}` : `${head}\n    完成：还没交过活`;
}

/**
 * 编制 → 面板（幂等）。启动时跑一次，之后每轮消息再跑一遍：
 * 卡上改了 kit（或改了部门、角色），**下一轮就生效，不必重启**。
 *
 * 为什么对**所有**同名面板都写，而不是只写 `panelOf` 挑出的那一块：一个人可能留下
 * 不止一块同名面板（旧副本、界面上那块、后台那块）。只补一块，其余几块仍旧按全量
 * 49 个工具发 —— 裁了半天等于没裁。
 *
 * 每块都比一遍，跟该给的一样就不写盘（patchPanel 要存盘，白写就是白费 IO）。
 */
/** 每块面板上次见到的样子（对话长度 / 压到哪了）—— 用来判"这一刻缓存还热不热" */
const panelStamp = new Map();

function syncPanels(api) {
  try {
    for (const c of allCards(api)) {
      const want = toolsOf(api, c);
      for (const p of api.panels() || []) {
        const mine = String(p.title || '') === c.name || (c.panel && String(p.id) === String(c.panel));
        if (!mine) continue;
        const have = Array.isArray(p.tools) ? p.tools : null;
        const same = !!have && have.length === want.length && have.every((t, k) => t === want[k]);
        if (!same && typeof api.patchPanel === 'function') api.patchPanel(p.id, { tools: want });
      }
      // 「这是员工工作面、别当组件」那个标，只补 `panelOf` 认的那一块：
      // 它参与 panelOf 的排序（认人、送交付都靠这个排序），给副本乱标会把认人认歪
      const best = panelOf(api, c);
      if (best && typeof api.patchPanel === 'function') {
        const patches = {};
        if (best.noWorkspacePrompt !== true) patches.noWorkspacePrompt = true;
        if (best.title !== c.name) patches.title = c.name;
        if (Object.keys(patches).length) api.patchPanel(best.id, patches);
      }
      syncPrompt(api, c);
    }
  } catch (e) {
    api.log(`[dispatch] 编制没落到面板上：${String((e && e.message) || e)}`);
  }
}

/**
 * 调度中心这块面板的声明（纯数据）。
 * 单提一个常量是因为**要开它的人不止一个**：面板类型的注册用它，
 * 设置里的「在调度中心中查看」也照它现开一块（见 openBoardPanel）。
 */
const PANEL_DECL = {
  kind: 'dispatch',
  label: t('调度中心'),
  hint: t('按角色卡管理员工与部门：简介、能力范围、特长、固定模型、专属提示词、学会的工作流（可复制）'),
  title: t('调度中心'),
  body: 'messages',
  look: { showChat: true, accent: '#7c6cf0' },
};

module.exports = {
  name: 'dispatch',
  description: t('派单器 + 员工编制：一个员工一张角色卡（独立 JSON，含专属提示词与固定模型），把活路由到人'),

  /** 声明是纯数据（要过 IPC），必须在 module.exports 里 —— 放外面整个插件加载不了 */
  panel: PANEL_DECL,

  setup(api) {
    try {
      const employees = fs.readdirSync(path.join(api.workspace || '.', 'work'), { withFileTypes: true });
      for (const employee of employees) if (employee.isDirectory()) casesFile(api, employee.name);
    } catch (error) { if (error.code !== 'ENOENT') api.log(`[dispatch] 员工案例迁移失败：${error.message}`); }
    // 旧的 `{title, skills}` 名册就地升成员工卡（幂等）
    try {
      migrate(api);
    } catch (e) {
      api.log(`[dispatch] 名册升级失败：${String((e && e.message) || e)}`);
    }

    // 追认给**已经开出来的**员工面板（幂等）：缺标补标；基础/部门/卡上任何一段
    // 变过 → 合成结果就不一样 → 这里每条消息都对一遍，不一样才写（省得白存盘）
    try {
      for (const c of allCards(api)) {
        const p = panelOf(api, c);
        if (!p) continue;
        if (typeof api.patchPanel === 'function') {
          // 工具清单跟着一起补：老面板上没有这个字段，不补等于还是全量发 49 个工具。
          // 只在跟该给的不一样时才写（每条消息都对一遍，一样就不动盘）
          const want = toolsOf(api, c);
          const have = Array.isArray(p.tools) ? p.tools : null;
          const same = !!have && have.length === want.length && have.every((t, k) => t === want[k]);
          if (!same) api.patchPanel(p.id, { noWorkspacePrompt: true, tools: want });
        }
        syncPrompt(api, c);
      }
    } catch (e) {
      api.log(`[dispatch] 老员工面板补标失败：${String((e && e.message) || e)}`);
    }

    // ────────────────────────────── 员工自己申请的工具组（等着生效的那几组）

    /** 卡上等着生效的套件组 —— 员工申请来的；已经在手里的不算 */
    function pendingOf(card) {
      const arr = Array.isArray(card && card.pendingKits) ? card.pendingKits : [];
      const have = new Set(kitList(card));
      return arr.map((k) => String(k).trim()).filter((k, i, a) => k && !have.has(k) && a.indexOf(k) === i);
    }

    /**
     * 把等着生效的套件组**并进卡里**。只挑"缓存前缀本来就要重建"的那一刻做，
     * 一共三种，别的一律等着：
     *   · 面板刚开 / 插件刚加载（第一次见到它，没有热缓存可废）；
     *   · 刚压缩过（compact.upTo 往前走了，消息序列已经变了）；
     *   · 对话被清空了（chat 变短）。
     * 在热会话里换工具表，省下的字节还不够赔废掉的那一整段前缀。
     *
     * 只写卡；面板上的 tools 交给 syncPanels —— 它每轮都比对，发现不一样才会写，
     * 于是"改工具表"这件事全程序只有一条路。
     */
    function applyPending(api) {
      const done = [];
      for (const card of allCards(api)) {
        const p = panelOf(api, card);
        if (!p) continue;
        const len = Array.isArray(p.chat) ? p.chat.length : 0;
        const upTo = Number((p.compact && p.compact.upTo) || 0);
        const prev = panelStamp.get(p.id);
        // **不管有没有待生效的都要记** —— 判断基准得一直往前滚，否则一有申请就误判成"冷"
        panelStamp.set(p.id, { len, upTo });
        const pend = pendingOf(card);
        if (!pend.length) continue;
        // 第一次看见这块面板：**只有"对话是空的"才算真的刚开**，才敢当场应用。
        // 带了历史的第一次看见 = 多半是刚重启 —— 而服务端的**前缀缓存不受我们重启影响**，
        // 那时应用等于白废一段热前缀。这种情况只记基准，等它自己变冷。
        if (!prev && len > 0) continue;
        if (prev && len >= prev.len && upTo <= prev.upTo) continue; // 热会话，等着
        const merged = [...kitList(card), ...pend].filter((k, i, a) => a.indexOf(k) === i).slice(0, 16);
        try {
          writeCard(api, { ...card, kits: merged, pendingKits: [] });
          done.push({ name: card.name, kits: pend });
        } catch (e) {
          api.log(`[dispatch] 应用待生效套件组失败：${String((e && e.message) || e)}`);
        }
      }
      return done;
    }

    /**
     * "你申请到的工具组"那一段 —— **只在待生效期间出现**，真生效后自然就没了
     * （那时完整说明已经跟着工具表发出去了，再说一遍是纯噪音，而且每轮都付钱）。
     */
    function pendingNote(api, card) {
      const pend = pendingOf(card);
      if (!pend.length) return '';
      const defs = loadKits(api);
      const rows = pend.map((k) => {
        const d = defs[k] || {};
        const tools = (d.tools || []).filter((t) => t !== '*');
        return `· ${d.label || k}${d.when ? `：${d.when}` : ''}${tools.length ? `（${tools.join('、')}）` : '（全部工具）'}`;
      });
      return `\n【你已经申请到的工具组 —— 下一次开工才真的发到你手上】\n${rows.join('\n')}\n`
        + t('申请已经记在你的角色卡上了，**这一轮还调不到它们**（工具表要等下一次开工重建）。')
        + t('现在要干这活，就照旧用手上有的工具，或者把活托给有这组工具的人 —— 别假装调用它们。');
    }

    /**
     * 每轮注入一句"组织知识"，分两档：
     *   · 经理 —— 本部门每个人的**简历 + 最近接的活**，据此挑人（要求 4）
     *   · 其他人 —— 部门清单**带各自简介**（凭什么判归属就在这一行）；仍然不知道各部门有几个人、什么岗位
     */
    api.addPrompt((ctx) => {
      const pid = (ctx && ctx.panelId) || '';
      // ① 等着生效的套件组：够条件（面板刚开 / 刚压缩 / 对话被清空）就并进卡里，
      //    下一行的 syncPanels 会发现 tools 不一样并写上去 —— 这一刻缓存本来就要重建，白换
      for (const d of applyPending(api)) pushFeed(`「${d.name}」申请生效：${d.kits.join('、')}`);
      // ② 编制每轮再对一遍（幂等，一样就不写盘）：卡上改了套件组，下一轮就生效，不用重启
      syncPanels(api);
      // 令牌那一段跟编制无关：借的人（要交付）和被借的人（等交付）都得看见。
      // 摆在这儿而不是只在派单正文里 —— 中间有人拿自己的话转述一遍，
      // 令牌也不会因此丢掉（丢了不报错，只是静悄悄没人交回来）
      const wait = waitLines(api, pid, ctx?.taskId);
      // 还等着生效的那几组，说一句 —— 只在这个窗口期出现，生效后自然没了
      const meCard = allCards(api).find((c) => c.panel === pid);
      const kitAsk = meCard ? pendingNote(api, meCard) : '';
      const { companies, depts } = readRegSafe(api);
      // kitAsk 拼在下面每一条返回路径上 —— 这里**不能提前 return**，那会把花名册/组织清单挡掉
      if (!depts.length) return [wait, kitAsk].filter(Boolean).join('\n\n');
      const mine = deptOfManager(api, depts, pid);
      if (mine) {
        const rows = mine.members
          .map((id) => cardById(api, id))
          .filter(Boolean)
          .map((c) => resumeOf(api, c, true))
          .join('\n');
        const roster = `【${mine.name}·部门花名册（实时）】\n${rows || '（本部门暂无员工）'}\n挑人看这些就够了，不用去翻别人的面板；派活用 dispatch({emp:"姓名"})。`;
        return [roster, wait, kitAsk].filter(Boolean).join('\n\n');
      }
      const line = companies
        .map((c) => `${c.name}${depts.filter((d) => d.company === c.id).map((d) => `\n  · ${d.name}${introOf(api, c.id, d.name)}`).join('') || '（暂无部门）'}`)
        .join('；');
      const org = `【组织（实时）】${line}\n当前为普通对话面板。只有在用户明确主动要求发包/派单给指定部门或员工，或员工接到上游流转命令时，才调用 dispatch 派单；提问、闲聊、方案探讨与新建面板场景一律由你自己直接回答，严禁擅自派单。`;
      return [org, wait, kitAsk].filter(Boolean).join('\n\n');
    });

    /**
     * 契约拦截器：
     * 监控工具执行。当持有待交付令牌的员工执行了生成或写文件类工具时，
     * 在工具返回结果末尾追加强契约提示，提醒其必须调用 deliver_result，杜绝口头敷衍。
     */
    api.onAfterTool((done) => {
      const { name, ctx, result } = done;
      const pid = (ctx && ctx.panelId) || '';
      if (!pid) return;
      const held = heldTicket(api, pid, ctx?.taskId);
      if (!held || held.status !== 'pending') return;
      const isWorkTool = !['dispatch', 'deliver_result', 'learn', 'use_skill', 'todo_write', 'todo_read'].includes(name);
      if (isWorkTool && typeof result === 'string' && result.trim()) {
        const isProduce = ['comfyui_run', 'write_file', 'edit', 'canvas_edit'].includes(name) ||
          /\.(png|jpe?g|webp|gif|bmp|avif|ts|tsx|js|jsx|json|py|md|html|css)/i.test(result);
        if (isProduce) {
          return (
            result +
            `\n\n【⚡ 契约拦截提示】你当前正持有派单令牌「${held.token}」（来自 ${held.fromName}）。` +
            `产出已就绪，请务必在本轮结束前调用 deliver_result({token: "${held.token}", files: [...]}) 提交交付物并释放令牌！口头说明不视为交付。`
          );
        }
      }
    });

    api.addTool(
      {
        name: 'dispatch',
        description:
          t('把一项工作任务派发给 AI 员工，持久入队后立即返回 taskId；通过 task_status 查询结果，派单成功不表示完成。')
          + t('同一轮重复相同派单复用请求与令牌；不循环轮询，不因没有即时回执重复派单。')
          + t('**转发后自查这单到底出去没有**：转发成功，令牌就不再挂在你名下 —— 下一轮还看到 ')
          + t('「【派单令牌 X】…归你挑人转发」，说明**没转出去**（只回一句「已发送」不算数），补派一次。')
          + t('dept = 派给某个部门的经理（由经理在本部门内挑人）；emp = 直接派给某位员工（按角色卡上的姓名）。')
          + t('两个都不填就返回组织架构。')
          + t('**【派单规格与技术交底纪律（杜绝断章取义与添油加醋）】**：')
          + t('1.【严禁情绪化与碎片化转播】：接单模型（尤其是基础/便宜模型）没有全局上下文！严禁截取用户带情绪、吐槽或前后脱节的半截原话甩过去，碎片信息会导致严重误解破坏！')
          + t('2.【严禁擅自添油加醋】：严禁在任务中擅自脑补未经确认的规则、夸大要求或主观延伸，把问题描黑。传达原意必须客观、精准、不失真。')
          + t('3.【输出完整技术交底四要素】：')
          + t('   - 核心诉求：完整准确传达用户真实意图（剔除无意义情绪，讲清业务目标）；')
          + t('   - 范围与边界：指出具体的文件路径、模块或函数；')
          + t('   - 禁区与保护：明确绝对不许删改或覆盖哪些逻辑（防止便宜模型盲目重写、删库或覆盖成果）；')
          + t('   - 验收与交付：明确交付物格式与验证标准。')
          + t('4.【前置未定严禁开单】：需求含糊、有歧义时，必须在当前对话中问清敲定后再派。对方正忙时任务会排队。')
          + t('只派职能之外的实操任务；提问、讨论、要方案一律自己答。')
          + t('**follow**：只有用户明确说了交付之后的承接动作才填；无后续一律留空。'),
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: t('任务正文：完整严谨的技术任务书（包含诉求原意、精确路径范围、禁区保护与验收指标）。严禁断章取义带情绪传话，亦严禁擅自添油加醋。') },
            dept: { type: 'string', description: t('目标部门名（交给该部门经理挑人）') },
            emp: { type: 'string', description: t('目标员工姓名（角色卡上的名字）') },
            requestId: { type: 'string', description: t('可选的稳定请求编号；重试沿用原编号。未提供时按本轮执行与任务内容识别重复。新的独立任务使用新编号。') },
            follow: {
              type: 'string',
              description:
                t('**交付之后还要接着干什么** —— 只在用户原话里明确说了后续用途时才填')
                + t('（「画张背景图接到 loading 画面上」里的「接到 loading 画面上」），**照抄原话**，')
                + t('不许自己编、不许推断。用户只是想看看 / 没提后续 = **留空**：')
                + t('留空就是"交了就完"，图挂进对话、一声不吭。它决定交付到位时要不要把发起人叫起来接着办，')
                + t('填错要多花一轮钱，拿不准就留空。'),
            },
          },
          required: ['task'],
        },
        level: 'write',
      },
      async (args, ctx) => {
        const task = String((args && args.task) || '').trim();
        const { depts } = readRegSafe(api);
        if (!depts.length) return `编制还是空的（${REG}）。先去调度中心建一个部门。`;
        const deptWord = String((args && args.dept) || '').trim();
        const empWord = String((args && args.emp) || '').trim();

        if (!task) return `要派什么活？（task 不能为空）\n\n当前组织架构：\n${orgLine(api, depts)}`;
        if (!deptWord && !empWord) {
          return `没指定派给谁。当前组织架构：\n${orgLine(api, depts)}\n\n填 dept（部门）或 emp（姓名）再派一次。`;
        }

        // 派到"还没工作面"的人头上：现给他开一块**后台**的（不占布局），
        // 睡着的那份（收纳区 / 历史会话）也叫回来 —— 开面板那一套统一在 resolveTarget 里。
        const pick = resolveTarget(api, depts, deptWord, empWord, { hidden: true });
        if (pick.error) return pick.error;

        const originId = (ctx && ctx.panelId) || '';
        const origin = api.panels().find((p) => p.id === originId);
        const originName = (origin && origin.title) || t('上游');
        // 令牌先发、再送任务（送的时候才写 banner）。他自己正拿着别人的令牌，
        // 说明这是**替上游转派** —— 同一个令牌交下去，别另起一个
        const follow = String((args && args.follow) || '').trim().slice(0, 400);
        const requestDigest = createHash('sha256').update(JSON.stringify([task, pick.target.id, follow])).digest('hex');
        const requestId = String(args.requestId || '') || (ctx.taskId || ctx.runId || originId) + ':' + requestDigest;
        const ticket = issueToken(api, originId, originName, task, follow, requestId, requestDigest, ctx?.taskId);
        if (['cancelled', 'accepted', 'spare'].includes(ticket.status)) return JSON.stringify({ ok: false, taskId: ticket.taskId, error: '原派单已结案或取消，请查询原任务；新任务使用新编号' });
        return deliver(api, depts, { id: originId, name: originName }, pick.target, pick.label, task, ticket, {
          context: ctx,
        });
      },
    );

    /**
     * learn —— 把刚跑通的一个工作流存成**自己的**技能（能力是学出来的）。
     * 按 ctx.panelId 认人，只有在编、开过工作面的员工存得进；存两处：
     *   · learned 多一条（工作流名 + 步骤 + 日期）＝ 工作经历；
     *   · skills 补上这个名字 ＝ 能力范围（派单和经理挑人直接命中）。
     * 专属：写进他那张卡，别人没有；复制走 copySkill（调度中心的「复制给…」）。
     */
    api.addTool(
      {
        name: 'learn',
        description:
          t('学新本事，存进自己的角色卡。两种用法：')
          + t('① 跑通了一个工作流 —— name = 工作流名（短，如「角色三视图出图流程」），how = 步骤要点（几行以内）；')
          + t('验证真能出结果才存。')
          + t('② 手上缺工具、这活干不了 —— kit = 套件组的 key 申请一组工具，')
          + t('**批准后下一次开工（新会话或压缩之后）才真的发给你**，这一轮还调不到。')
          + t('两样都是你的专属积累，别人没有；要给同事用，由管理员在调度中心复制。'),
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: t('工作流名（短）；申请工具组时不填') },
            how: { type: 'string', description: t('步骤要点，几行以内；申请工具组时不填') },
            kit: { type: 'string', description: t('要申请的套件组 key（申请工具组时填这个；学工作流时不填）') },
          },
          required: ['name'],
        },
        level: 'write',
      },
      async (args, ctx) => {
        const pid = (ctx && ctx.panelId) || '';
        const card = allCards(api).find((c) => c.panel === pid);
        if (!card) return t('你没有角色卡（不在编制里），学的东西没地方存 —— 让管理员在调度中心给你建卡、开工作面。');
        // 申请一组工具：**只登记，不当场生效**（道理见 pendingKits 那段）
        const wantKit = String((args && args.kit) || '').trim();
        if (wantKit) {
          const defs = loadKits(api);
          const d = defs[wantKit];
          if (!d) {
            const can = Object.keys(defs).filter((k) => k !== 'all').join('、');
            return `没有叫「${wantKit}」的套件组。能申请的是：${can}（还有一组「全量」只能由管理员在调度中心勾）。`;
          }
          // 「全量」= 一个都不裁，等于把最高权限拿到自己手上 —— 那一组只走人工
          if (wantKit === 'all') {
            return t('「全量」那一组不能自己申请 —— 那等于把最高权限（含 run_command）拿到手上。要用它，让管理员在调度中心的角色卡上勾。');
          }
          const pend = Array.isArray(card.pendingKits) ? card.pendingKits : [];
          if (kitList(card).includes(wantKit)) {
            return `你已经拿着「${d.label || wantKit}」这组了（正在生效），不用申请。`;
          }
          if (pend.includes(wantKit)) {
            return `「${d.label || wantKit}」你申请过了，已经在等着生效 —— 下一次开工就会发到你手上，这轮再申请也是同一件事。`;
          }
          card.pendingKits = [...pend, wantKit].slice(0, 16);
          writeCard(api, card);
          api.log(`[dispatch] ${card.name} 申请套件组 ${wantKit}`);
          return `已申请「${d.label || wantKit}」${d.when ? `（${d.when}）` : ''}。`
            + t('已经记在你的角色卡上了 —— **下一次开工才会真的发到你手上**（工具表中途换会废掉整段缓存，不值当）。')
            + t('这一轮请用手上现有的工具干，或者把活托给有这组工具的人。');
        }

        const name = String((args && args.name) || '').trim().slice(0, 80);
        if (!name) return t('name 要填：这个工作流叫什么？');
        const how = String((args && args.how) || '').trim().slice(0, 500);
        card.learned = [...(card.learned || []).filter((l) => l.name !== name), { name, how, at: Date.now() }].slice(-LEARN_MAX);
        if (!card.skills.includes(name)) card.skills = [...card.skills, name];
        writeCard(api, card);
        pushFeed(`「${card.name}」存下工作流：${name}`);
        api.log(`[dispatch] ${card.name} 学会 ${name}`);
        return `已存进你自己的角色卡：工作流「${name}」${how ? '（含步骤要点）' : ''}，能力范围也补上了这个名字。这是你的专属积累 —— 别人没有；要给谁用，让管理员在调度中心点「复制给…」。`;
      },
    );

    /**
     * deliver_result —— 交回令牌，把**文件**送回发起人。
     *
     * 这是"员工不必认识别的部门的人"能成立的另一半：发起的一方不用追问活交到谁手上了，
     * 交付的一方也用不着知道是谁派的 —— 两边都只认这一个号。
     * 文字回执本来就随派单原路返回，所以这个工具**只为文件而存在**：
     * 出的图、渲染的音频、生成的一批资源。
     */
    api.addTool(
      {
        name: 'deliver_result',
        description:
          t('干完活之后**到插件提交派单令牌** —— 等于说"这单完成、可以交"，交付物（图 / 音频 / 生成的一批资源）由插件送到派单人那块对话里。')
          + t('token 用提示词里给你的那个「派单令牌」（形如 tk-xxxx）；你在替别人转派时它自己跟着走，不用管。')
          + t('不用给谁写回信：完成信号由插件发出。你是自己提问的人、没派单过就别用它（要把图发进自己这块对话用 send_image）。'),
        parameters: {
          type: 'object',
          properties: {
            token: { type: 'string', description: t('派单令牌，形如 tk-xxxx（提示词里「派单令牌」给你的那个）') },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: t('要交回去的文件路径（工作区相对路径或本机绝对路径），可以给多个'),
            },
            note: { type: 'string', description: t('一句话附言：这是什么、下一步该干什么') },
          },
          required: ['files'],
        },
        level: 'write',
      },
      async (args, ctx) => {
        const pid = (ctx && ctx.panelId) || '';
        const list = readInbox(api);
        const want = String((args && args.token) || '').trim();

        // 令牌优先；没填就按"你手上正拿着的那一个"兜底 —— 模型忘了抄号不该让整件事失败
        let idx = want ? list.findIndex((t) => t.token === want) : -1;
        if (idx < 0 && !want) {
          const held = heldTicket(api, pid, ctx?.taskId);
          if (held) idx = list.findIndex((t) => t.token === held.token);
        }
        if (idx < 0) {
          const mine = list.filter((t) => t.holder === pid && t.status === 'pending');
          if (!mine.length) {
            return `没认到派单令牌${want ? `「${want}」` : ''} —— 你手上没有等交付的派单。要把文件发进自己这块对话，用 send_image。`;
          }
          return `令牌「${want}」没认到。你手上还没交付的是这几个号：${mine.map((t) => t.token).join('、')}`;
        }

        const ticket = list[idx];
        // 撤了的单不再收交付 —— 但要说清，不然对方以为自己的活白干了
        if (ticket.status === 'cancelled') {
          return `令牌 ${ticket.token} 已经被**撤单**了（${ago(ticket.cancelledAt)}）—— 这一单不用再交，手上那些文件你留着直接用就行。`;
        }
        // 令牌在谁手上，交付就是谁的事。中转的人（经理）不该替执行人交 ——
        // 交两次的后果不只是吵：它第二次往往拿的是**自己编的路径**（已经出过一次）。
        if (String(ticket.holder) !== String(pid)) {
          return `令牌 ${ticket.token} 现在在「${ticket.holderName || '执行人'}」手上 —— 交付由执行人提交，你这边不用交。`
            + `交付物会由插件直接送到派单人那块对话。`;
        }
        const current = ctx?.taskId && api.tasks.get(ctx.taskId, pid);
        if (current?.correlationId && current.correlationId !== ticket.token) return '交付令牌与当前任务不匹配，请使用当前任务的令牌。';
        if (['done', 'accepted', 'spare'].includes(ticket.status)) return `令牌 ${ticket.token} 已提交交付：${ticket.files.join('、')}。不会重复发送。`;
        const raw = args && args.files;
        const files = (Array.isArray(raw) ? raw : [raw]).map((f) => String(f || '').trim()).filter(Boolean);
        if (!files.length) return t('files 要填：要交回去的文件路径（图、音频、资源都行），可以给多个。');

        const root = api.workspace || '.';
        const sent = [];
        const missing = [];
        for (const f of files) {
          const abs = path.isAbsolute(f) ? path.normalize(f) : path.resolve(root, f);
          if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
            missing.push(f);
            continue;
          }
          // 图直接挂进发起人的对话 —— 这就是"任务已执行"最硬的证据：
          // 不用另造一个"视为已完成"的判定，文件到了就是到了
          sent.push(path.relative(root, abs) || abs);
        }
        if (missing.length || !sent.length) {
          return `没有提交交付 —— 文件不完整：${missing.join('、')}。补齐文件后再提交，不会把部分文件记为完成。`;
        }
        api.tasks.delivered(ticket.token, pid, sent);

        const note = String((args && args.note) || '').trim().slice(0, 300);
        const alive = !!api.panels().find((p) => p.id === ticket.fromPanel);
        list[idx] = {
          ...ticket,
          status: 'done',
          doneAt: Date.now(),
          by: ticket.holderName || pid,
          note,
          files: [...new Set([...ticket.files, ...sent])],
        };
        writeInbox(api, list);
        for (const file of sent) {
          if (api.live?.image && /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file)) api.live.image(ticket.fromPanel, path.resolve(root, file));
        }
        api.log(`[dispatch] ${ticket.token} 已提交，送达 ${ticket.fromName}：${sent.length} 个文件`);

        return [
          alive
            ? `已提交，插件把它送到「${ticket.fromName}」那块对话了：${sent.length} 个文件（图直接看得见）。`
            : `「${ticket.fromName}」那块工作面已经关了 —— ${sent.length} 个文件记在收件箱里没丢（那边敲 /inbox 能看到路径）。`,
          ...sent.map((f) => `· ${f}`),
          missing.length ? `× 这几个路径不存在，没交出去：${missing.join('、')}` : '',
          note ? `附言已带上：${note}` : '',
          t('令牌 {tk} 记为**已交付**，不用再交一次。', { tk: ticket.token }),
        ]
          .filter(Boolean)
          .join('\n');
      },
    );

    /**
     * dispatch_cancel —— 撤销一项派发或承接的工作任务令牌。
     * 解决“派单中途被用户打断或方案变更，令牌一直卡在未完结状态”的痛点。
     */
    api.addTool(
      {
        name: 'dispatch_cancel',
        description:
          t('撤销一项派发或承接的工作任务令牌。当任务被人类打断、需求变更、不再需要执行、或执行报错中止时调用此工具快速释放令牌，避免令牌一直卡在未交付状态。')
          + t('token 可选；不传默认撤销当前面板持有的待交付令牌，或当前面板最近派出的未完成令牌；传 all=true 则撤销当前面板所有关联的挂起令牌。'),
        parameters: {
          type: 'object',
          properties: {
            token: { type: 'string', description: t('要撤销的派单令牌号，形如 tk-xxxx（可选）') },
            all: { type: 'boolean', description: t('是否一键撤销当前面板所有挂起未完成的单（默认 false）') },
            reason: { type: 'string', description: t('撤单原因说明（可选）') },
          },
        },
      },
      (args, ctx) => {
        const pid = (ctx && ctx.panelId) || '';
        const tk = String((args && args.token) || '').trim();
        const all = !!(args && args.all);
        const reason = String((args && args.reason) || '').trim() || t('主动取消任务');
        const inbox = readInbox(api);

        if (all) {
          const targets = inbox.filter((tk) => (tk.holder === pid || tk.fromPanel === pid) && tk.status === 'pending');
          if (!targets.length) return t('当前面板没有待处理或挂起中的派单。');
          let count = 0;
          for (const t of targets) {
            cancelSingleTicket(api, t.token, reason);
            count++;
          }
          return `已成功撤销 ${count} 个挂起的派单令牌。相关任务已终止。`;
        }

        if (tk) {
          const r = cancelSingleTicket(api, tk, reason);
          return r.msg;
        }

        const held = heldTicket(api, pid);
        if (held && held.status === 'pending') {
          const r = cancelSingleTicket(api, held.token, reason);
          return `已释放你手头正拿着的令牌：${r.msg}`;
        }

        const myOut = inbox.filter((t) => t.fromPanel === pid && t.status === 'pending');
        if (myOut.length) {
          const last = myOut[myOut.length - 1];
          const r = cancelSingleTicket(api, last.token, reason);
          return `已撤回你最近派出的令牌：${r.msg}`;
        }

        return t('当前面板没有找到可撤销的挂起派单。若指定令牌请传 token 参数。');
      },
    );

    /**
     * /inbox —— 看一眼"我派出去的活"和"我手上欠的活"。
     *
     * 为什么是斜杠命令、不再开一块面板：这件事的核心是**一份记录**，不是一块要拖来拖去的界面。
     * 面板 = 类型 + 规格，记录本来也可以用现成的 table 类型表达；但为一份随手可查的账
     * 多开一块面板，收益配不上多出来的那个东西 —— 关不掉的界面才是负担。
     * 只列跟这块工作面有关的条目，别人的只报个数（免得串味）。
     */
    api.addCommand(
      { id: 'inbox', label: t('收件箱'), hint: t('派单令牌：我派出去的活、我手上要交付的活') },
      (_args, ctx) => {
        const pid = (ctx && ctx.panelId) || '';
        const all = readInbox(api);
        const row = (t) =>
          t.status === 'done'
            ? `· ${t.token} ← ${t.by || t.holderName || '对方'}｜已交付 ${t.files.length} 个文件｜「${t.task.slice(0, 36)}」｜${ago(t.doneAt)}`
            : t.status === 'cancelled'
            ? `· ${t.token} ⊘ 已撤单｜「${t.task.slice(0, 36)}」｜撤于 ${ago(t.cancelledAt)}`
            : `· ${t.token} → ${t.holderName || '在办'}｜等交付｜「${t.task.slice(0, 36)}」｜派于 ${ago(t.at)}`;
        const outMine = all.filter((t) => t.fromPanel === pid);
        const inMine = all.filter((t) => t.holder === pid && t.fromPanel !== pid && t.status === 'pending');
        const others = all.length - outMine.length - inMine.length;
        const blocks = [];
        if (outMine.length) blocks.push(`**我派出去的**\n${outMine.map(row).join('\n')}`);
        if (inMine.length) blocks.push(`**我手上要交付的**\n${inMine.map(row).join('\n')}`);
        if (!blocks.length) blocks.push(t('这块工作面还没有派单记录。'));
        if (others > 0) blocks.push(`（另有 ${others} 件属于别的工作面，不在这儿显示）`);
        return blocks.join('\n\n');
      },
    );

    /**
     * /cancel —— 一键撤销挂起的派单。
     * 用法：
     *   /cancel          撤销自己手上欠的或最近派出的单
     *   /cancel all      撤销当前面板涉及的所有挂起未完结派单（彻底告别手动撤单）
     *   /cancel tk-xxxx  撤销指定令牌
     */
    api.addCommand(
      { id: 'cancel', label: t('撤销派单'), hint: t('快速撤销挂起未交付的任务（/cancel、/cancel all 或 /cancel tk-xxxx）') },
      (args, ctx) => {
        const pid = (ctx && ctx.panelId) || '';
        const arg = String(args || '').trim();
        const inbox = readInbox(api);

        if (arg.toLowerCase() === 'all') {
          const targets = inbox.filter((t) => (t.holder === pid || t.fromPanel === pid) && t.status === 'pending');
          if (!targets.length) return '当前面板没有待处理或挂起中的派单。';
          let count = 0;
          for (const t of targets) {
            cancelSingleTicket(api, t.token, '通过 /cancel all 一键撤单');
            count++;
          }
          return `✅ 已一键批量撤销 ${count} 个挂起的派单令牌，无需再交付或催办！`;
        }

        if (arg.startsWith('tk-')) {
          const res = cancelSingleTicket(api, arg, '通过 /cancel 命令撤销');
          return res.ok ? `✅ ${res.msg}` : `❌ ${res.msg}`;
        }

        // 未带参数：优先撤销自己手头正拿着的 pending 单
        const held = heldTicket(api, pid);
        if (held && held.status === 'pending') {
          const res = cancelSingleTicket(api, held.token, '通过 /cancel 释放当前手头任务');
          return `✅ ${res.msg}`;
        }

        // 其次撤销自己作为发起人最近派出的 pending 单
        const outPending = inbox.filter((t) => t.fromPanel === pid && t.status === 'pending');
        if (outPending.length) {
          const last = outPending[outPending.length - 1];
          const res = cancelSingleTicket(api, last.token, '通过 /cancel 撤回发出的任务');
          return `✅ ${res.msg}`;
        }

        return '没有找到可撤销的挂起派单（手上没有未完成任务，也没有发出去的未完结单）。如需撤销指定单，可输入 /cancel tk-xxxx。';
      },
    );

    // ────────────────────────────────────────────────── 调度中心（面板）

    const boardPath = api.dataPath(BOARD_FILE);
    const cmdPath = api.dataPath(CMD_FILE);
    let lastSeq = 0;
    /** 上一次**真正写盘**的那版看板的业务指纹（不含 at，见 boardSig） */
    let lastBoard = '';
    /**
     * 上一次**非空**的模型清单 —— 兜底。
     * providers.json 是多插件 + 主进程一起写的，读的那一瞬间可能正被写坏：
     * 那一刻 modelOptions() 只会得到 []，直接写进看板，模型下拉就空一下
     * —— 用户看到的就是"一会儿有一会儿没"。空不是真相，是读坏了，用上一份顶上。
     */
    let lastValidModels = [];
    /** 上游读空/读错只抱怨一次 —— 每 1.2 秒往日志里刷同一句是噪声，不是排查线索 */
    let modelsWarned = false;
    /** 面板上那行回执：**写在看板里，绝不 api.send 进对话** */
    let feed = [];
    /**
     * 「这一下要打开谁」—— 设置那边点「在调度中心中查看」时写进来（只留最近一次）。
     * 看板是插件与面板唯一能互通的地方，所以借它当信箱：面板读到就把这个人翻出来，
     * 再回一条 clearFocus 把请求收掉（不收的话，下次切标签回来又会翻一遍）。
     */
    let focusReq = null;
    function pushFeed(text, ok = true) {
      const now = Date.now();
      // 只保留最近 8 秒以内的回执，且最多存 6 条，超时的历史记录自动淘汰
      feed = [...feed.filter((x) => now - (Number(x.at) || 0) < 8000).slice(-5), { at: now, text: String(text || ''), ok }];
      writeBoard();
    }

    /** 可选模型清单 —— 角色卡上要"指定模型"，得让面板有个下拉可挑 */
    function modelOptions() {
      try {
        const out = [];
        for (const p of api.models() || []) {
          for (const m of (Array.isArray(p.models) ? p.models : [])) {
            if (!p.key || !m || !m.id) continue;
            out.push({ pick: `${p.key}::${m.id}`, label: `${p.label} / ${m.name}` });
          }
        }
        // 拿到了就记住 —— 这是"上一次有效清单"
        if (out.length) {
          lastValidModels = out;
          modelsWarned = false;
          return out;
        }
        /**
         * 空 ≠"用户没配模型"，是**这一趟没读出来**（上游那份清单正被写坏 / 核心那边抛了）。
         * 以前这里默默 `return []`，看板就跟着空，界面上只剩一个占位符 ——
         * 谁也看不出上游出了什么事（2026-09-30 排查这个花了半天，就栽在这句沉默上）。
         */
        if (!modelsWarned) {
          modelsWarned = true;
          api.log('[dispatch] 模型清单读出来是空的（api.models() 没给东西）—— 先顶着上一份，等上游好');
        }
      } catch (e) {
        if (!modelsWarned) {
          modelsWarned = true;
          api.log(`[dispatch] 读模型清单出错：${String((e && e.message) || e)} —— 先顶着上一份`);
        }
      }
      return lastValidModels;
    }

    /** 一张卡 → 给面板看的（面板不该拿到整张卡，只给它要画的东西） */
    function viewOf(card) {
      if (!card) return null;
      const p = panelOf(api, card);
      return {
        id: card.id,
        name: card.name,
        dept: card.dept,
        role: card.role,
        /** 出给界面的一律是能直接喂 <img src> 的绝对 URL —— 快照里不许再出现 base64 */
        avatar: avaUrl(api, card.avatar),
        intro: card.intro,
        skills: card.skills,
        strength: card.strength,
        model: card.model,
        prompt: card.prompt,
        hasPanel: !!p,
        learned: (card.learned || []).slice(-6).reverse(),
        kits: kitList(card),
        /** true = 本人一个都没勾，这份是按岗位推出来的 */
        kitAuto: !(Array.isArray(card.kits) && card.kits.length),
        tools: toolsOf(api, card),
        pendingKits: pendingOf(card),
        composed: composePrompt(api, card),
        cases: readCases(api, card.name).slice(-6).reverse(),
      };
    }

    function boardOf() {
      const { companies, depts } = readRegSafe(api);
      const base = readBase(api);
      return {
        at: Date.now(),
        base,
        baseLen: base.length,
        companies: companies.map((c) => ({ ...coText(api, c), count: depts.filter((d) => d.company === c.id).length })),
        depts: depts.map((d) => ({
          name: d.name,
          company: d.company,
          intro: readDept(api, d.company, d.name).intro,
          prompt: readDept(api, d.company, d.name).prompt,
          manager: viewOf(cardById(api, d.manager)),
          members: d.members.map((id) => viewOf(cardById(api, id))).filter(Boolean),
        })),
        models: modelOptions(),
        kits: kitOptions(api),
        // 仅向看板注入 8 秒以内的有效回执，过期历史不写入看板
        feed: feed.filter((x) => Date.now() - (Number(x.at) || 0) < 8000),
        /**
         * 「要打开谁」的请求（面板读过就回 clearFocus 销掉）。
         * 带 20 秒保质期：面板万一没认领（关着、脚本被换掉），放久了会莫名其妙翻一个人出来。
         */
        focus: focusReq && Date.now() - (Number(focusReq.at) || 0) < 20000 ? focusReq : null,
      };
    }

    /**
     * 看板的**业务指纹** —— 故意不含 at。
     *
     * at 是"这一份什么时候生成的"，每算一次就是一个新值：拿整份 JSON（含 at）去比，
     * 结果永远是"变了"，1.2 秒一跳的定时器就成了**无休止重写盘**，
     * 顺带把 1.5 秒一跳的面板喂得每跳都 setBoard（下拉框反复销毁重建的根子）。
     * 比业务内容：只有它真变了，才值得换个新 at 并落盘。
     */
    function boardSig(b) {
      return JSON.stringify([b.base, b.baseLen, b.companies, b.depts, b.models, b.kits, b.feed, b.focus]);
    }

    function writeBoard() {
      const board = boardOf();
      const sig = boardSig(board);
      if (sig === lastBoard && fs.existsSync(boardPath)) return false;
      const text = JSON.stringify(board);
      try {
        fs.mkdirSync(path.dirname(boardPath), { recursive: true });
        fs.writeFileSync(`${boardPath}.tmp`, text, 'utf8');
        fs.renameSync(`${boardPath}.tmp`, boardPath);
        lastBoard = sig;
      } catch (e) {
        api.log(`[dispatch] 看板写盘失败：${String((e && e.message) || e)}`);
        return false;
      }
      return true;
    }

    // ── 员工的"工作面"：一块 chat 面板，提示词只放他自己的，模型锁死 ──

    /**
     * 把一张角色卡落成一块能干活的员工面板。
     * 三件事一起做完，少一件这个人就是半残的：
     *   · 标题 = 卡上的名字（路由认人先认 id、名字兜底）
     *   · spec.systemPrompt = **他自己的专属提示词**（通用那套由 chat-core 叠）
     *   · 模型 = 卡上指定的那个，并且 **lockedModel**（会话区不给换）
     */

    /** 改一张卡，并把改动**同步到他那块面板**（提示词、名字、模型、锁定） */
    function applyCard(card, patch) {
      const next = writeCard(api, { ...card, ...patch });
      const p = panelOf(api, next);
      if (p && typeof api.patchPanel === 'function') {
        const pp = { spec: { ...(p.spec || {}), systemPrompt: composePrompt(api, next) } };
        if (p.title !== next.name) pp.title = next.name;
        pp.lockedModel = true;
        pp.noWorkspacePrompt = true;
        pp.tools = toolsOf(api, next);
        api.patchPanel(p.id, pp);
      }
      if (p && next.model && typeof api.setModel === 'function') api.setModel(p.id, next.model);
      return next;
    }

    function normSkills(v) {
      if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
      return String(v || '')
        .split(/[，,、;；\n]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 12);
    }

    // ──────────────────────────────────────────── 设置 → agent（编制那一页）

    /**
     * 员工在设置里的**分区**。
     *
     * 员工是**一个人**，不是一块面板、也不是一个工具 —— 他是一份要看得见、能点两下的名单。
     * 调度中心管的是"编制怎么改"（加人、改卡），这一页管的是"他用哪个模型、去哪看他"。
     *
     * 数据全部现算（`view()`）：名册、看板、面板表都是当下一刻的真源，缓存一份只会跟它们漂开。
     * 这一页**不写说明文字**：进来的人只想知道这几件事，成段的解释只会把名单挤下去。
     */
    function employeesView() {
      const all = allCards(api);

      const rows = all.map((c) => {
        const parts = [c.dept || t('无部门'), c.role === 'manager' ? t('经理') : t('员工')];
        return {
          id: String(c.id),
          title: String(c.name),
          desc: parts.join(' · '),
          // 模型是**岗位属性**，可它平时住在调度中心的角色卡里 ——
          // 为改一个模型跑一趟那边不值当，就在这一行上直接挑（见 PluginSettingsRow.inline）。
          inline: 'models',
          value: c.model || '',
          // 按钮**恒定这两个**：他此刻在不在岗、在不在布局里，都不改按钮的样子 ——
          // 那些是行尾那一小格（meta）的事，按钮不该一会儿有一会儿没。
          actions: [
            { id: 'inspect', label: t('在调度中心中查看'), hint: t('打开调度中心那块面板 —— 编制的编辑台') },
            { id: 'talk', label: t('对话'), hint: t('切到他的工作面；还没开过就现开一块') },
          ],
        };
      });

      return { rows, empty: t('编制里还没有人 —— 去调度中心建一家公司、一个部门，再往里加员工。') };
    }

    api.addSettingsSection({
      id: 'employees',
      label: 'agent',
      hint: t('AI 员工名册：就地调模型，去调度中心或进工作面'),
      view: () => employeesView(),
      onAction: (actionId, rowId) => {
        const card = cardById(api, rowId);
        if (!card) return '这个人已经不在编制里了（刷新一下这一页）。';
        const act = String(actionId || '');

        /**
         * 行内下拉挑完模型：新值编在动作 id 里带过来（见 PluginSettingsRow.inline）。
         * 界面不认识"模型"是什么，它只是把这一格的新值交回来；写进哪、怎么生效是插件的事。
         */
        if (act.indexOf('setModel:') === 0) {
          const pick = act.slice('setModel:'.length);
          if (pick === String(card.model || '')) return '';
          applyCard(card, { model: pick });
          return pick
            ? `「${card.name}」的模型改成 ${pick.split('::').slice(-1)[0]}。`
            : `「${card.name}」的模型清空了 —— 不挑一个他开不了工。`;
        }

        if (act === 'inspect') {
          const r = openBoardPanel(api);
          // 顺手把"要看谁"留在看板上：面板在别处，只有这条路能把这一页翻出来
          focusReq = { id: String(card.id), at: Date.now() };
          writeBoard();
          return r.how === 'new'
            ? `调度中心开出来了，翻到「${card.name}」那一页。`
            : `切到调度中心了，翻到「${card.name}」那一页。`;
        }

        if (act === 'talk') {
          if (!card.model) return `「${card.name}」还没指定模型 —— 就在这一行右边给他挑一个。`;
          try {
            const r = wakeOrOpen(api, card, false);
            const pid = String(r.panel.id);
            if (typeof api.activatePanel === 'function') api.activatePanel(pid);
            else api.showPanel(pid);
            return `已切到「${card.name}」的工作面。`;
          } catch (e) {
            return `开工作面没成：${String((e && e.message) || e)}`;
          }
        }

        return '这一下不认识（插件和界面版本可能对不上）。';
      },
    });

    // ── 面板写来的命令 ──

    function readCmdQueue() {
      try {
        const j = JSON.parse(fs.readFileSync(cmdPath, 'utf8'));
        return Array.isArray(j && j.cmds) ? j.cmds : [];
      } catch {
        return [];
      }
    }

    function clearCmdQueue() {
      try {
        fs.writeFileSync(cmdPath, JSON.stringify({ cmds: [] }), 'utf8');
      } catch {
        /* 清不掉就留着，下一跳还会走到这里 */
      }
    }

    /**
     * 一条命令：每条都带 panelId（认归属）；动作本身多是全局的（改编制、开面板）。
     * 认 seq：同一个文件被重复读到不会执行第二遍（加人加两遍才是真事故）。
     */
    async function applyCmd(raw) {
      const { companies, depts } = readRegSafe(api);
      const seq0 = raw && raw.seq;
      const deptOf = (name) => depts.find((x) => x.name === String(name || '').trim());
      /** 一条部门命令落在哪家公司：面板会带上 company；没带就按部门名认，再兜到第一家公司 */
      const coFor = (raw2, deptName) => {
        const byId = companies.find((c) => c.id === String((raw2 && raw2.company) || '').trim());
        if (byId) return byId;
        return coOfDept({ companies, depts }, deptName) || companies[0] || null;
      };

      switch (raw && raw.cmd) {
        /** 加部门 —— 同时把经理**建出来**（要求 4）；给了模型才开得了工 */
        case 'addDept': {
          const name = String(raw.name || '').trim();
          if (!name) return { reply: '部门名不能为空', ok: false };
          if (deptOf(name)) return { reply: `${name} 已经在名册里了（部门名全局唯一）`, ok: false };
          const co = coFor(raw, '');
          if (!co) return { reply: '还没有公司 —— 先在左栏建一家', ok: false };
          const mgr = writeCard(api, {
            id: newId(),
            name: `${name}经理`,
            dept: name,
            role: 'manager',
            intro: `${name}的部门经理：只看人、派活、盯交付，不代做`,
            model: String(raw.model || ''),
          });
          depts.push({ name, company: co.id, manager: mgr.id, members: [] });
          saveReg(api, depts);
          api.log(`[dispatch] ${co.name} 新部门 ${name}，经理 ${mgr.name}`);
          if (!mgr.model) {
            return { reply: `已在「${co.name}」下建部门「${name}」并建好经理「${mgr.name}」的角色卡。**还没指定模型 —— 指定了才能开工**。`, ok: false };
          }
          const r = openWorkPanel(api, mgr);
          return { reply: `已在「${co.name}」下建部门「${name}」+ 经理「${mgr.name}」，工作面也开好了（模型已锁定）。` };
        }

        /** 补经理 —— 部门在、经理没了（被移除过）的时候用 */
        case 'fixManager': {
          const d = deptOf(raw.dept);
          if (!d) return { reply: '没有这个部门', ok: false };
          if (d.manager && cardById(api, d.manager)) return { reply: `${d.name} 本来就有经理`, ok: false };
          const mgr = writeCard(api, {
            id: newId(),
            name: `${d.name}经理`,
            dept: d.name,
            role: 'manager',
            intro: `${d.name}的部门经理：只看人、派活、盯交付，不代做`,
            model: String(raw.model || ''),
          });
          d.manager = mgr.id;
          saveReg(api, depts);
          api.log(`[dispatch] ${d.name} 补了经理 ${mgr.name}`);
          if (!mgr.model) return { reply: `已给「${d.name}」补好经理「${mgr.name}」。**指定模型后**才能开工。`, ok: false };
          openWorkPanel(api, mgr);
          return { reply: `已给「${d.name}」补好经理「${mgr.name}」并开好工作面。` };
        }

        /** 加员工 —— **一并建角色卡**（要求 3）；有模型就把工作面开出来 */
        case 'addAgent': {
          const d = deptOf(raw.dept);
          if (!d) return { reply: `没有叫「${raw.dept}」的部门`, ok: false };
          const name = String(raw.name || '').trim();
          if (!name) return { reply: '员工姓名不能为空', ok: false };
          if (allCards(api).some((c) => c.name === name)) return { reply: `已经有叫「${name}」的人了（路由认名字，得唯一）`, ok: false };
          let card = writeCard(api, {
            id: newId(),
            name,
            dept: d.name,
            role: 'member',
            intro: String(raw.intro || ''),
            avatar: String(raw.avatar || ''),
            skills: normSkills(raw.skills),
            strength: String(raw.strength || ''),
            model: String(raw.model || ''),
            prompt: String(raw.prompt || ''),
          });
          d.members.push(card.id);
          saveReg(api, depts);
          api.log(`[dispatch] ${d.name} 加了 ${card.name}`);
          if (!card.model) {
            return { reply: `已建好「${name}」的角色卡并记进 ${d.name}。**还没指定模型** —— 在卡片上选一个，才能开工作面干活。`, ok: false };
          }
          card = openWorkPanel(api, card).card;
          return { reply: `已建好「${name}」的角色卡（模型已锁定）并开好工作面。` };
        }

        /** 改角色卡 —— 面板上"修改角色卡"存的就是这一条 */
        case 'saveCard': {
          const card = cardById(api, String(raw.id || ''));
          if (!card) return { reply: '找不到这张角色卡', ok: false };
          const name = String(raw.name || '').trim();
          if (!name) return { reply: '姓名不能为空', ok: false };
          if (name !== card.name && allCards(api).some((c) => c.name === name)) {
            return { reply: `已经有叫「${name}」的人了（路由认名字，得唯一）`, ok: false };
          }
          // 改名 = 他的工作区跟着搬（完成的工作按名字存；还没建过文件夹就不用管）
          if (name !== card.name) {
            try {
              fs.renameSync(casesFile(api, card.name), casesFile(api, name));
            } catch {
              /* 没有旧文件夹 —— 正常 */
            }
          }
          // 经理不写特长（挑人派活用不上）；**职位提示词经理照写** —— 挑人标准、派单写法、回执要求就是他的职位
          const isMgr = card.role === 'manager';
          // 工具套件组：面板上勾的那些（可以多个）。去重后照存 ——
          // 认不出来的 key 也留着（也许那张表只是暂时被改坏了），算清单时自然忽略。
          const kitWant = (Array.isArray(raw.kits) ? raw.kits : [])
            .map((k) => String(k).trim())
            .filter((k, i, a) => k && a.indexOf(k) === i)
            .slice(0, 16);
          const next = applyCard(card, {
            name,
            intro: String(raw.intro || ''),
            avatar: typeof raw.avatar === 'string' ? raw.avatar : card.avatar,
            skills: normSkills(raw.skills),
            strength: isMgr ? '' : String(raw.strength || ''),
            kits: kitWant,
            model: String(raw.model || ''),
            prompt: String(raw.prompt || ''),
          });
          if (!next.model) return { reply: `「${next.name}」的卡已保存，但**没指定模型** —— 开不了工。`, ok: false };
          const liveP = panelOf(api, next);
          if (!liveP) {
            const r = openWorkPanel(api, next);
            return { reply: `「${next.name}」的卡已保存，工作面也开好了（模型已锁定）。`, ok: true, _card: r.card };
          }
          if (typeof api.patchPanel === 'function' && liveP.title !== next.name) {
            api.patchPanel(liveP.id, { title: next.name });
          }
          return { reply: `「${next.name}」的角色卡已保存 —— 下一轮起生效（提示词与模型都同步过去了）。` };
        }

        /** 记一笔「完成的工作」：活**确认有效**才记，只存做了什么 + 实现路径，不存上下文 */
        case 'noteCase': {
          const card = findCard(api, String(raw.emp || raw.id || ''));
          if (!card) return { reply: '找不到这个人', ok: false };
          const work = String(raw.work || '').trim();
          const how = String(raw.how || '').trim();
          if (!work) return { reply: 'work（完成了什么）不能为空', ok: false };
          const list = readCases(api, card.name);
          list.push({ at: Date.now(), work: work.slice(0, 200), how: how.slice(0, 400) });
          writeCases(api, card.name, list);
          api.log(`[dispatch] ${card.name} 完成：${work.slice(0, 40)}`);
          return { reply: `已记入「${card.name}」的完成的工作（work/${card.name}/成功案例.json，共 ${list.length} 条）。` };
        }

        /** 建公司 —— 编制树的根。名字先给个占位，点开它改名、写简介和基础提示词 */
        case 'addCo': {
          const name = String(raw.name || '').trim() || '新公司';
          if (companies.some((c) => c.name === name)) return { reply: `已经有叫「${name}」的公司了`, ok: false };
          const id = `co-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
          ensureCoFile(api, id);
          saveCos(api, [...companies, { id, name }]);
          api.log(`[dispatch] 建了公司 ${name}`);
          return { reply: `已建公司「${name}」—— 点它写公司简介和**本公司的基础提示词**（原全局那份默认值已经接过来），再往里加部门。` };
        }

        /** 改公司：名字 / 简介 / 基础提示词 → 整家公司重新合成 */
        case 'saveCo': {
          const co = companies.find((c) => c.id === String(raw.id || '').trim());
          if (!co) return { reply: '找不到这家公司', ok: false };
          const name = String(raw.name || '').trim();
          if (!name) return { reply: '公司名不能为空', ok: false };
          if (name !== co.name && companies.some((c) => c.name === name)) return { reply: `已经有叫「${name}」的公司了`, ok: false };
          co.name = name;
          saveCos(api, companies);
          fs.mkdirSync(path.dirname(coFile(api, co.id)), { recursive: true });
          fs.writeFileSync(coFile(api, co.id), JSON.stringify({ intro: String(raw.intro || ''), base: String(raw.base || '') }), 'utf8');
          syncCompany(api, co.id);
          const n = depts.filter((d) => d.company === co.id).reduce((s, d) => s + 1 + d.members.length, 0);
          api.log(`[dispatch] ${co.name} 的公司提示词已保存`);
          return { reply: `「${co.name}」已保存（简介 ${String(raw.intro || '').length} 字 · 基础提示词 ${String(raw.base || '').length} 字）—— 本公司 ${n} 人的合成提示词已同步。` };
        }

        /** 改本部门的简介 / 提示词 → 本部门所有人重新合成（经理不吃部门提示词那段） */
        case 'saveDept': {
          const d = deptOf(raw.name);
          if (!d) return { reply: '没有这个部门', ok: false };
          const co = coFor(raw, d.name);
          writeDept(api, co ? co.id : d.company, d.name, { intro: raw.intro, prompt: raw.prompt });
          syncDept(api, d.name);
          api.log(`[dispatch] ${d.name} 的部门提示词已保存`);
          return { reply: `「${d.name}」的部门简介与部门提示词已保存 —— 本部门 ${[d.manager, ...d.members].filter(Boolean).length} 人的合成提示词已同步。` };
        }

        /** 复制一条学会的工作流给另一个人 —— 技能专属，但可以复制 */
        case 'copySkill': {
          const from = cardById(api, String(raw.from || ''));
          const to = cardById(api, String(raw.to || ''));
          if (!from || !to) return { reply: '找不到人（源或目标不在编制里了）', ok: false };
          if (from.id === to.id) return { reply: '不用复制给自己 —— 本来就是他的。', ok: false };
          const item = (from.learned || []).find((l) => l.name === String(raw.name || ''));
          if (!item) return { reply: `「${from.name}」的卡上没有「${raw.name}」这条工作流`, ok: false };
          const dup = (to.learned || []).some((l) => l.name === item.name);
          to.learned = [...(to.learned || []).filter((l) => l.name !== item.name), { name: item.name, how: item.how, at: Date.now() }].slice(-LEARN_MAX);
          if (!to.skills.includes(item.name)) to.skills = [...to.skills, item.name];
          writeCard(api, to);
          api.log(`[dispatch] ${from.name} → ${to.name} 复制 ${item.name}`);
          return {
            reply: `已把工作流「${item.name}」从 ${from.name} 复制给 ${to.name}${dup ? t('（覆盖了他原来那条）') : ''} —— 现在他的卡上也有了（经历 + 能力范围）。`,
          };
        }

        /**
         * 挂现有员工 —— **不同公司/部门用同一个人**：把已有的卡挂进本部门的成员表。
         * 卡只有一张（一个面板、一份提示词），所以：
         *   · 主部门仍是卡上的 dept（合成提示词按它算，不因兼职而变）；
         *   · 挂载只记在名册的 members 里 —— 于是他在新部门也出现在树上、可被派活、经理也能看见他。
         */
        case 'attachAgent': {
          const d = deptOf(raw.dept);
          if (!d) return { reply: `没有叫「${raw.dept}」的部门`, ok: false };
          const card = findCard(api, String(raw.emp || ''));
          if (!card) return { reply: `编制里没有叫「${raw.emp}」的人`, ok: false };
          if (d.manager === card.id || d.members.includes(card.id)) {
            return { reply: `「${card.name}」本来就在「${d.name}」`, ok: false };
          }
          d.members.push(card.id);
          saveReg(api, depts);
          api.log(`[dispatch] ${card.name} 挂进 ${d.name}`);
          const home = card.dept === d.name ? '（他本来的主部门就是这儿）' : `（主部门仍是「${card.dept}」，他的提示词按主部门算，不因兼职而变）`;
          return { reply: `已把「${card.name}」挂进「${d.name}」${home} —— 他的卡和工作面还是那一个，没有多建。` };
        }

        /** 摘出：只是把他从这个部门的成员表里去掉，卡和面板都留着 */
        case 'detachAgent': {
          const d = deptOf(raw.dept);
          if (!d) return { reply: `没有叫「${raw.dept}」的部门`, ok: false };
          const card = findCard(api, String(raw.emp || ''));
          if (!card) return { reply: `编制里没有叫「${raw.emp}」的人`, ok: false };
          if (card.dept === d.name) {
            return { reply: `「${card.name}」的主部门就是「${d.name}」—— 要摘他得先把他移出编制（或者改他的主部门）。`, ok: false };
          }
          d.members = d.members.filter((x) => x !== card.id);
          saveReg(api, depts);
          api.log(`[dispatch] ${card.name} 从 ${d.name} 摘出`);
          return { reply: `已把「${card.name}」从「${d.name}」摘出 —— 他回到主部门「${card.dept}」，卡和工作面都没动。` };
        }

        /** 移除 —— 面板上就这一个删除入口（要求 5） */
        case 'removeAgent': {
          const id = String(raw.id || '');
          const card = cardById(api, id);
          if (!card) return { reply: '找不到这个人', ok: false };
          const d = deptOf(card.dept);
          if (d) {
            d.members = d.members.filter((x) => x !== id);
            if (d.manager === id) d.manager = '';
            saveReg(api, depts);
          }
          dropCard(api, id);
          api.log(`[dispatch] 移除了 ${card.name}`);
          return { reply: `已把「${card.name}」移出编制（角色卡删了；他那块面板还开着，要收就自己关掉）。` };
        }

        /** 撤部门 —— 连同它的经理卡一起撤，成员回流到"无部门"不该发生，先挡住 */
        case 'removeDept': {
          const d = deptOf(raw.name);
          if (!d) return { reply: '没有这个部门', ok: false };
          if (d.members.length) {
            return { reply: `「${d.name}」还有 ${d.members.length} 个人 —— 先把他们移走或改部门，再撤这个部门。`, ok: false };
          }
          if (d.manager) dropCard(api, d.manager);
          saveReg(api, depts.filter((x) => x.name !== d.name));
          api.log(`[dispatch] 撤了部门 ${d.name}`);
          return { reply: `已撤掉部门「${d.name}」（连它的经理角色卡一起撤了）。` };
        }

        /** 单开工作面 —— 卡在、面板没了的时候用 */
        case 'openPanel': {
          const card = cardById(api, String(raw.id || ''));
          if (!card) return { reply: '找不到这张角色卡', ok: false };
          if (!card.model) return { reply: `「${card.name}」还没指定模型 —— 指定了才能开工。`, ok: false };
          if (panelOf(api, card)) return { reply: `「${card.name}」的工作面本来就在。` };
          const r = wakeOrOpen(api, card, false);
          if (r.how === 'stow') return { reply: `已把「${card.name}」从收纳区叫回工作面 —— 对话还是原来那份。` };
          if (r.how === 'seed') return { reply: `已给「${card.name}」开好工作面，睡在历史会话里的对话也接过来了。` };
          return { reply: `已给「${card.name}」开好工作面（模型已锁定）。` };
        }

        /**
         * 撤单 / 恢复 —— 派单队列面板点的那两下。
         *
         * 为什么动作落在这里、而不在那边插件的代码里：收件箱是**这个插件写的**。
         * 谁都能读写同一个文件，迟早被后写的整个盖掉（丢的不是一条记录，是一件事没人交）。
         * 所以别的面板只往命令队列里放一条，改账这一下永远由收件箱的主人来做。
         */
        case 'cancelTicket':
        case 'restoreTicket': {
          const tk = String(raw.token || '').trim();
          const inbox = readInbox(api);
          const i = inbox.findIndex((x) => x.token === tk);
          if (i < 0) return { reply: `收件箱里没有 ${tk}`, ok: false };
          const it = inbox[i];
          const cancel = raw.cmd === 'cancelTicket';
          if (cancel && it.status === 'done') return { reply: `${tk} 已经交付了 —— 交了的单不用撤。`, ok: false };
          if (cancel && it.status === 'cancelled') return { reply: `${tk} 本来就是撤了的。`, ok: false };
          if (!cancel && it.status !== 'cancelled') return { reply: `${tk} 不在撤单状态。`, ok: false };
          if (cancel) return { reply: cancelSingleTicket(api, tk, '通过调度面板撤单').msg };
          if (it.taskId) return { reply: '已取消的执行不会自动重做。请使用新的 requestId 重新派单。', ok: false };
          inbox[i] = cancel
            ? { ...it, status: 'cancelled', cancelledAt: Date.now() }
            : { ...it, status: 'pending', cancelledAt: 0 };
          writeInbox(api, inbox);
          api.log(`[dispatch] ${tk} ${cancel ? t('已撤单') : t('已恢复')}`);
          return {
            reply: cancel
              ? `${tk} 撤单了 —— 不再算欠着，${it.holderName || t('执行人')} 之后交上来也不收（他手上那一轮不会被打断）。`
              : `${tk} 恢复成等交付了。`,
          };
        }

        case 'acceptTicket': {
          const tk = String(raw.token || '').trim();
          const inbox = readInbox(api);
          const i = inbox.findIndex((x) => x.token === tk);
          if (i < 0) return { reply: `收件箱里没有 ${tk}`, ok: false };
          const it = inbox[i];
          if (it.status === 'accepted') return { reply: `${tk} 本来就是已验收结案的。`, ok: false };
          if (it.status !== 'done') return { reply: '尚未提交完整交付，不能验收。', ok: false };
          if (it.taskId) {
            const accepted = api.tasks.accept(it.taskId, it.fromPanel, String(raw.how || raw.work || ''));
            if (!accepted.ok) return { reply: accepted.error, ok: false };
          }

          // 肯定 vs 部分肯定：肯定算作已完成工作并星标，部分肯定算作已完成工作（不星标）
          const isStarred = raw.starred === true || raw.level === 'confirmed' || (String(raw.score || '').includes('肯定') && !String(raw.score || '').includes('部分'));
          const score = raw.score ? String(raw.score).trim() : (isStarred ? '🌟 肯定' : '✔️ 部分肯定');
          let work = String(raw.work || '').trim();
          if (!work) {
            work = (it.task || '').split('\n').map((x) => x.trim()).find((x) => x && !x.startsWith('【')) || (it.task || '').slice(0, 50);
          }
          work = work.slice(0, 200);

          let how = String(raw.how || '').trim();
          if (!how) {
            const notePart = it.note ? `交付说明: ${it.note}` : '';
            const filesPart = (Array.isArray(it.files) && it.files.length) ? `产物: ${it.files.map((f) => path.basename(f)).join(', ')}` : '';
            how = [notePart, filesPart].filter(Boolean).join('；') || '按规范完成并通过验收';
          }
          how = how.slice(0, 400);

          inbox[i] = {
            ...it,
            status: 'accepted',
            acceptedAt: Date.now(),
            score,
            starred: isStarred,
            workSummary: work,
            howSummary: how,
          };
          writeInbox(api, inbox);

          // 活确认有效、被肯定采纳后，才记入员工个人的「完成的工作」（成功案例.json）
          const empName = it.holderName || it.by;
          let caseNote = '';
          if (empName) {
            try {
              const list = readCases(api, empName);
              list.push({
                at: Date.now(),
                work: work,
                how: `[${score}] ${how}`,
                token: tk,
                starred: isStarred,
              });
              writeCases(api, empName, list);
              caseNote = `已记入「${empName}」的完成工作（work/${empName}/成功案例.json${isStarred ? t(' · ⭐已星标') : ''}）。`;
            } catch (e) {
              caseNote = `计入成功案例提示：${String((e && e.message) || e)}`;
            }
          }

          api.log(`[dispatch] ${tk} 验收结案（评分：${score}）`);
          return { reply: `${tk} 验收结案（${score}）。${caseNote}` };
        }

        /** 放入备用池：老板没否定也没肯定，暂时保留交付物，但绝不计入已完成工作 */
        case 'spareTicket': {
          const tk = String(raw.token || '').trim();
          const inbox = readInbox(api);
          const i = inbox.findIndex((x) => x.token === tk);
          if (i < 0) return { reply: `收件箱里没有 ${tk}`, ok: false };
          const it = inbox[i];
          inbox[i] = {
            ...it,
            status: 'spare',
            sparedAt: Date.now(),
            note: raw.note ? t('{a} (备用: {b})', { a: it.note || '', b: raw.note }).trim() : it.note,
          };
          writeInbox(api, inbox);
          api.log(`[dispatch] ${tk} 移入备用池（不计入已完成工作）`);
          return { reply: `${tk} 已转入备用池（暂时不作为已完成工作，不写入成功案例）。` };
        }

        case 'rejectTicket': {
          const tk = String(raw.token || '').trim();
          const reason = String(raw.reason || raw.note || '未达到预期，请检查并调整交付物').trim();
          const inbox = readInbox(api);
          const i = inbox.findIndex((x) => x.token === tk);
          if (i < 0) return { reply: `收件箱里没有 ${tk}`, ok: false };
          const it = inbox[i];
          if (it.status === 'cancelled') return { reply: `${tk} 已经撤单，无法打回。`, ok: false };
          const rejectCount = (Number(it.rejectCount) || 0) + 1;
          let retry;
          const wakeMsg = `【派单打回重做】\n令牌：${tk}\n原任务：${stripPacketHead(it.task)}\n验收意见：${reason}\n请根据意见重新修改，完成后重新提交 deliver_result。`;
          if (it.taskId) {
            if (api.tasks.get(it.taskId)?.status !== 'completed') return { reply: '请等当前会话结束；失败或取消的任务请重新派单。', ok: false };
            retry = api.tasks.submit({ panelId: it.holder, text: wakeMsg, title: it.holderName,
              requestId: tk + ':rework:' + rejectCount, correlationId: tk }, { panelId: it.fromPanel });
            if (!retry.ok) return { reply: retry.error, ok: false };
          }
          inbox[i] = {
            ...it,
            taskId: retry?.task?.id || it.taskId,
            status: 'pending',
            rejectedAt: Date.now(),
            rejectCount,
            lastRejectReason: reason,
          };
          writeInbox(api, inbox);
          api.log(`[dispatch] ${tk} 被打回重做（第 ${rejectCount} 次）：${reason}`);
          if (!it.taskId && it.holder) {
            try {
              const p = api.send(it.holder, wakeMsg);
              if (p && typeof p.then === 'function') p.catch(() => {});
            } catch {}
          }
          return { reply: `${tk} 已打回给 ${it.holderName || t('承办人')}，要求重新修改交付。` };
        }

        /** 面板把"这个请求我认过了"记回来 —— 一条请求只该被消费一次 */
        case 'clearFocus': {
          focusReq = null;
          return null;
        }

        default:
          return null;
      }
    }

    cmdTimer = setInterval(() => {
      let applied = false;
      // 兜底巡孤儿：送单半路断掉时，「当场回收」那一段跑不到，残留只能在这儿收
      try { sweepOrphans(api); } catch (e) { api.log(`[dispatch] 孤儿巡检失败：${String((e && e.message) || e)}`); }
      for (const raw of readCmdQueue()) {
        const s = Number(raw && raw.seq);
        if (!Number.isFinite(s) || s <= lastSeq) continue;
        // **seq 不许把闸门推到未来**：手写命令拍脑袋填了个大 seq（曾超前真实时间 21 分钟），
        // lastSeq 一旦越过真实时间，面板此后的点击会永远被当成"旧命令"跳过 —— 表现就是"改了存不上"。
        lastSeq = Math.min(s, Date.now() * 1000 - 1);
        // 命令可能异步：**先挪 seq 再干活**，否则下一跳会把同一条又做一遍
        Promise.resolve()
          .then(() => applyCmd(raw))
          .then((r) => {
            if (r && r.reply) pushFeed(r.reply, r.ok !== false);
            else writeBoard();
          })
          .catch((e) => pushFeed(`这一步没成：${String((e && e.message) || e)}`, false));
        applied = true;
      }
      if (applied) clearCmdQueue();
    }, TICK);
    if (cmdTimer && typeof cmdTimer.unref === 'function') cmdTimer.unref();

    boardTimer = setInterval(writeBoard, BOARD_TICK);
    if (boardTimer && typeof boardTimer.unref === 'function') boardTimer.unref();
    writeBoard();
    // 开机先收一遍上次残留的孤儿（不花模型调用，只改一个状态文件）
    try { sweepOrphans(api); } catch {}

    api.log(`调度中心就绪（员工卡 ${AGENTS}/，看板 ${BOARD_FILE}）`);
  },

  dispose() {
    if (cmdTimer) clearInterval(cmdTimer);
    if (boardTimer) clearInterval(boardTimer);
    cmdTimer = null;
    boardTimer = null;
    taskJournalStamp = '';
    taskTicketIndex = new Map();
  },
};
