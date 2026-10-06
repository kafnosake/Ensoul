/**
 * doctor —— 项目问题定位、故障诊断与架构速查中枢。
 *
 * 专门解决"这个项目干活很快，但遇到问题找资料找半天"的痛点：
 *
 * 1. doctor_diagnose:
 *    输入报错信息、堆栈、异常现象或涉及符号，
 *    自动进行：
 *      - 暗坑规则库精准匹配（CRLF行尾陷阱、dist时效脱节、契约三件套遗漏、floatBare穿透、串味等）
 *      - 架构真源定位（唯一修改落点、调用链与相关文件清单）
 *      - 运行时证据检查（源码 vs dist 时间戳、最近 git diff 涉及文件、最近日志报错）
 *      - 给出高置信度根因判断与立即可执行的修复步骤
 *
 * 2. doctor_healthcheck:
 *    一键全景体检：
 *      - 构建与产物同步状态（dist 是否陈旧）
 *      - 核心源码 CRLF/LF 行尾格式预警（防止 edit 失败）
 *      - 所有插件有效性与语法检查
 *      - 状态持久化 JSON 完整性检查
 *      - 运行时近期高频错误聚类
 *      - 工作区未提交改动
 *
 * 3. doctor_search_docs:
 *    在 docs/、skills/、AGENTS.md、CLAUDE.md 中按关键词切片精准检索，不用通读几万字文档。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const STATE_FILE = '.ensoul/state/doctor.json';
const CMD_FILE = '.ensoul/state/doctor.cmd.json';

// i18n 安全兜底
const t = typeof globalThis.t === 'function' ? globalThis.t : (str) => str;

/** 常见硬坑规则库 */
const PITFALL_RULES = [
  {
    id: 'EDIT_CRLF',
    name: '行尾 CRLF / LF 混合导致 edit 工具找不到锚点',
    pattern: /(没找到这段原文|not found in file|failed to match|old_string)/i,
    check(ctx) {
      if (ctx.query && this.pattern.test(ctx.query)) return true;
      if (ctx.file && /src[\\/](main|shared)/i.test(ctx.file)) return true;
      return false;
    },
    cause: '本项目仓库行尾不统一：src/main/index.ts、plugins.ts、store.ts 等为 CRLF (\\r\\n)，而部分代码与模型默认为 LF (\\n)。edit 工具进行多行匹配时因换行符差异必然报错。',
    solution: [
      '改用只包含单行的独一无二锚点进行 edit 替换；',
      '或者使用 node 临时脚本按实际行尾替换：node -e "const s=fs.readFileSync(p, \'utf8\');..."',
      '改前可用 node -e 检查目标文件的行尾格式：s.includes(\'\\r\\n\') ? \'CRLF\' : \'LF\''
    ],
    reference: 'skills/ensoul-map/SKILL.md §动手前先核行尾'
  },
  {
    id: 'DIST_OUTDATED',
    name: '源码已改动但 dist 未构建或 Electron 未重启（改了没反应）',
    pattern: /(没反应|未生效|还是旧的|旧代码|not working|no effect|界面没变)/i,
    check(ctx) {
      return ctx.query && this.pattern.test(ctx.query);
    },
    cause: 'Electron 运行时直接执行 dist/ 编译产物，而非 src/ 源码。改了 src/renderer 需要 vite 界面构建；改了 src/main、src/preload 或 src/shared 必须重新构建并执行 restart_project。',
    solution: [
      '检查构建时间戳：对比 src 最新修改时间与 dist 生成时间；',
      '主进程改动：执行 build_project，构建成功后执行 restart_project 重启实例；',
      '界面改动：等待当前轮次结束 ui-refresh 自动构建，或手动 build_project。'
    ],
    reference: 'skills/fix-build/SKILL.md §改了没反应 / 构建失败'
  },
  {
    id: 'CONTRACT_TRINITY',
    name: '跨进程契约未同步三件套（shared/types、api.ts、preload）',
    pattern: /(BUILTIN_KINDS|Property '.*' does not exist on type 'Window'|api..* is not a function|IPC通道|types.ts)/i,
    check(ctx) {
      return ctx.query && this.pattern.test(ctx.query);
    },
    cause: '向核心添加新字段、新面板类型或 IPC 契约时，漏掉了协同更新。通常加一个字段需要同时动三处：shared/types.ts、renderer/core/api.ts、preload/index.ts。少一个就会报类型编译错误。',
    solution: [
      '1. 检查 src/shared/types.ts 中的接口定义与常量；',
      '2. 检查 src/preload/index.ts 是否导出了对应 IPC 调用；',
      '3. 检查 src/renderer/core/api.ts 是否封装了类型安全的 API 方法。'
    ],
    reference: 'skills/fix-build/SKILL.md §类型错误的头号来源'
  },
  {
    id: 'FLOAT_BARE_POINTER',
    name: '悬浮挂件 floatBare 缺少 pointer-events: auto 导致点击穿透',
    pattern: /(floatBare|点不到|点击无反应|看不见摸不着|按钮点不动|穿透)/i,
    check(ctx) {
      return ctx.query && this.pattern.test(ctx.query);
    },
    cause: '面板声明了 floatBare: true 时，核心会在外壳关闭 pointer-events。挂件内部实心可见元素必须显式补 pointer-events: auto，否则整个面板像透明盖子一样穿透。',
    solution: [
      '在对应的 panel.css 中为实心内容与交互按钮补充样式规则：',
      '.your-button, .your-card { pointer-events: auto; }'
    ],
    reference: 'skills/make-plugin/SKILL.md §四、挂件怎么缩放第 3 条'
  },
  {
    id: 'PLUGIN_SYNTAX_EXPORT',
    name: '插件导出格式错误或语法失效',
    pattern: /(plugin.*load|panel 声明|module.exports|Cannot find module)/i,
    check(ctx) {
      return ctx.query && this.pattern.test(ctx.query);
    },
    cause: '插件必须使用 CommonJS (module.exports = { name, setup, panel })；若将 panel 声明写在 module.exports 外面，或者使用了 ES Module export，插件加载器会静默忽略或报错。',
    solution: [
      '确保 plugins/<名>/index.js 最外层为 module.exports = { name, description, setup(api), panel: {...} }；',
      '确保 panel.body 只填写 messages | code | table | form | web 之一；',
      '检查 index.js 中是否有语法错误（可先用 node -c 语法检查）。'
    ],
    reference: 'skills/make-plugin/SKILL.md §一、插件三件套'
  },
  {
    id: 'PANEL_ISOLATION',
    name: '插件状态未按 panelId 隔离（跨面板串味）',
    pattern: /(串味|别的面板|面板冲突|两个面板|被顶替|状态混乱)/i,
    check(ctx) {
      return ctx.query && this.pattern.test(ctx.query);
    },
    cause: '插件在主进程运行，若全局使用一个单一变量或同一个 state 槽位，多块同类型面板同时打开时就会相互覆盖。',
    solution: [
      '插件内部状态应以 panelId 作为 Map 的 key 进行分槽存储；',
      'addPrompt / addTool 回调中通过 ctx?.panelId 获取当前调用的面板上下文。'
    ],
    reference: 'skills/make-plugin/SKILL.md §五、几块面板不许串味'
  },
  {
    id: 'NODE_PS1_DIRECTORY',
    name: 'npm PowerShell 包装脚本报错（Node install directory）',
    pattern: /Could not determine Node.js install directory/i,
    check(ctx) {
      return ctx.query && this.pattern.test(ctx.query);
    },
    cause: '这是 Windows 环境下 npm.ps1 寻径已知缺陷，并非项目本身问题。',
    solution: [
      '在命令中改用 cmd /c "npm run build" 或显式调用 "C:\\Program Files\\nodejs\\node.exe"。'
    ],
    reference: 'AGENTS.md §怎么干活'
  },
  {
    id: 'EPERM_PORT_BLOCKED',
    name: '子进程权限异常 (EPERM) 或端口被占用',
    pattern: /(spawn EPERM|Access is denied|EADDRINUSE|端口占用)/i,
    check(ctx) {
      return ctx.query && this.pattern.test(ctx.query);
    },
    cause: '安全软件阻拦，或上一轮 Electron/服务子进程未完全退出导致端口/文件句柄被占用。',
    solution: [
      '1. 调用 stop_project 彻底关掉旧实例；',
      '2. 若端口仍被占，检查任务管理器中的孤儿 node/electron 进程并结束；',
      '3. 重新调用 start_project 或 restart_project。'
    ],
    reference: 'skills/fix-build/SKILL.md §几种看起来像错误的情况'
  }
];

/** 架构真源映射库 */
const ARCH_ORIGIN_MAP = [
  {
    keyword: /(系统提示|system prompt|buildSystemPrompt|提示词)/i,
    component: '系统提示词装配',
    truthPath: 'src/main/chat-core.ts',
    fn: 'buildSystemPrompt()',
    notes: '注意：系统提示词只放静态指令以保住 Prompt Cache！面板事实和动态插件信息在消息末尾注入，绝不进系统提示。'
  },
  {
    keyword: /(快照|面板快照|snapshot|buildPanelSnapshot)/i,
    component: '面板实时快照',
    truthPath: 'src/main/chat-core.ts',
    fn: 'buildPanelSnapshot()',
    notes: '由 index.ts 动态拼装在每轮用户消息最前沿。'
  },
  {
    keyword: /(工具表|toolsFor|agent工具|function call|addTool)/i,
    component: '模型工具分发与注册',
    truthPath: 'src/main/agent.ts',
    fn: 'toolsFor(level), runTool()',
    notes: '核心工具在 agent.ts 中按权限级别 (read/write/full) 注册；插件工具通过 api.addTool 挂载。'
  },
  {
    keyword: /(内置面板|BUILTIN_KINDS|panel registry|注册表)/i,
    component: '内置面板类型注册',
    truthPath: 'src/shared/types.ts & src/renderer/panel/registry.tsx',
    fn: 'BUILTIN_KINDS & registerPanelType()',
    notes: '内置面板必须同时在 shared/types.ts 和 renderer 注册表登记。'
  },
  {
    keyword: /(插件宿主|PluginHost|插件钩子|onBeforeTool|onAfterTool)/i,
    component: '插件加载与事件总线',
    truthPath: 'src/main/plugins.ts',
    fn: 'loadPlugins(), PluginHost 类',
    notes: '每轮对话都会调用 loadPlugins 确保动态生效。'
  },
  {
    keyword: /(状态持久化|state.load|state.save|.ensoul[\\/]state)/i,
    component: '插件状态与命令文件',
    truthPath: '.ensoul/state/<插件名>.json & .ensoul/state/<插件名>.cmd.json',
    fn: 'api.state.load() / api.state.save()',
    notes: '面板与插件之间不开私有 IPC，统一走文件状态队列通道。'
  },
  {
    keyword: /(停靠树|布局|dock|describe_layout|FitBox|FloatPanel)/i,
    component: '停靠树与自适应缩放',
    truthPath: 'src/renderer/panel/FloatPanel.tsx & FitBox.tsx',
    fn: 'FitBox 自动检测 overflow',
    notes: '挂件位置按比例 rx/ry 存储，尺寸按自然 CSS 编写，缩放由 FitBox 自动处理。'
  }
];

function getMtimeSafe(filePath) {
  try {
    const st = fs.statSync(filePath);
    return st.mtimeMs;
  } catch {
    return 0;
  }
}

function findLatestMtime(dirPath, extFilter) {
  let latest = 0;
  let latestFile = '';
  function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'dist' && entry.name !== '.ensoul') {
          walk(full);
        }
      } else if (entry.isFile()) {
        if (!extFilter || extFilter.some(ext => entry.name.endsWith(ext))) {
          try {
            const mt = fs.statSync(full).mtimeMs;
            if (mt > latest) {
              latest = mt;
              latestFile = full;
            }
          } catch {}
        }
      }
    }
  }
  walk(dirPath);
  return { latest, latestFile };
}

/** 检查行尾 */
function checkFileEol(filePath) {
  try {
    const buf = fs.readFileSync(filePath, 'utf8');
    const hasCrlf = buf.includes('\r\n');
    const hasLf = buf.replace(/\r\n/g, '').includes('\n');
    if (hasCrlf && hasLf) return 'MIXED';
    if (hasCrlf) return 'CRLF';
    return 'LF';
  } catch {
    return 'UNKNOWN';
  }
}

/** 运行健康体检 */
function runHealthCheck(workspaceRoot) {
  const ws = workspaceRoot || process.cwd();
  const report = {
    timestamp: new Date().toISOString(),
    overall: 'HEALTHY',
    items: []
  };

  // 1. 构建产物时效检查
  const srcStat = findLatestMtime(path.join(ws, 'src'), ['.ts', '.tsx', '.js']);
  const distStat = findLatestMtime(path.join(ws, 'dist'), ['.js']);
  let buildStatus = 'PASS';
  let buildMsg = 'dist 产物与源码保持最新';
  if (srcStat.latest > 0 && distStat.latest > 0) {
    if (srcStat.latest - distStat.latest > 3000) {
      buildStatus = 'WARN';
      buildMsg = `源码比编译产物新（最新源码修改于 ${new Date(srcStat.latest).toLocaleTimeString()}：${path.relative(ws, srcStat.latestFile)}），可能尚未构建生效！`;
    }
  } else if (distStat.latest === 0) {
    buildStatus = 'FAIL';
    buildMsg = 'dist/ 目录不存在或为空，项目尚未完成初次构建！';
  }
  report.items.push({
    category: '构建时效',
    status: buildStatus,
    detail: buildMsg,
    hint: buildStatus !== 'PASS' ? '执行 build_project，改动涉及主进程时执行 restart_project' : undefined
  });

  // 2. 核心源码行尾格式扫描 (CRLF/LF 陷阱)
  const keyFiles = [
    'src/main/index.ts',
    'src/main/plugins.ts',
    'src/main/store.ts',
    'src/main/fsapi.ts',
    'src/main/chat-core.ts',
    'src/main/agent.ts'
  ];
  const crlfFiles = [];
  const mixedFiles = [];
  for (const f of keyFiles) {
    const full = path.join(ws, f);
    if (fs.existsSync(full)) {
      const eol = checkFileEol(full);
      if (eol === 'CRLF') crlfFiles.push(f);
      if (eol === 'MIXED') mixedFiles.push(f);
    }
  }
  let eolStatus = 'PASS';
  let eolDetail = '核心文件行尾格式正常';
  if (mixedFiles.length > 0) {
    eolStatus = 'WARN';
    eolDetail = `存在混合行尾文件（${mixedFiles.join(', ')}），可能导致多行 edit 精确匹配失败`;
  } else if (crlfFiles.length > 0) {
    eolDetail = `已知 CRLF 核心文件：${crlfFiles.join(', ')}（提示：edit 匹配此文件请使用单行锚点）`;
  }
  report.items.push({
    category: '代码行尾 (EOL)',
    status: eolStatus,
    detail: eolDetail,
    hint: '遇到 edit 报错时请先确认该文件行尾，或改用单行唯一锚点'
  });

  // 3. 插件健康度与语法自检
  const pluginsDir = path.join(ws, 'plugins');
  let pluginWarns = [];
  let pluginCount = 0;
  if (fs.existsSync(pluginsDir)) {
    try {
      const dirs = fs.readdirSync(pluginsDir, { withFileTypes: true });
      for (const d of dirs) {
        if (d.isDirectory()) {
          pluginCount++;
          const idx = path.join(pluginsDir, d.name, 'index.js');
          if (!fs.existsSync(idx)) {
            pluginWarns.push(`plugins/${d.name} 缺少 index.js 入口`);
            continue;
          }
          // 语法验证检查
          try {
            const code = fs.readFileSync(idx, 'utf8');
            new Function(`"use strict"; return (function() { ${code} });`);
            // 检查 module.exports 结构
            if (!code.includes('module.exports')) {
              pluginWarns.push(`plugins/${d.name}/index.js 未导出 module.exports`);
            }
          } catch (syntaxErr) {
            pluginWarns.push(`plugins/${d.name}/index.js 存在语法错误: ${syntaxErr.message}`);
          }
        }
      }
    } catch (e) {
      pluginWarns.push(`扫描 plugins 目录失败: ${e.message}`);
    }
  }
  report.items.push({
    category: '插件健康度',
    status: pluginWarns.length === 0 ? 'PASS' : 'WARN',
    detail: `已扫描 ${pluginCount} 个插件。${pluginWarns.length === 0 ? '全部语法校验通过' : '发现潜在隐患: ' + pluginWarns.slice(0, 3).join('; ')}`,
    hint: pluginWarns.length > 0 ? '请修正插件入口文件及 CommonJS 语法' : undefined
  });

  // 4. 状态文件合法性检查
  const stateDir = path.join(ws, '.ensoul', 'state');
  let badJsonFiles = [];
  if (fs.existsSync(stateDir)) {
    try {
      const sFiles = fs.readdirSync(stateDir);
      for (const sf of sFiles) {
        if (sf.endsWith('.json')) {
          const sPath = path.join(stateDir, sf);
          try {
            const raw = fs.readFileSync(sPath, 'utf8');
            if (raw.trim()) JSON.parse(raw);
          } catch {
            badJsonFiles.push(sf);
          }
        }
      }
    } catch {}
  }
  report.items.push({
    category: '状态文件持久化',
    status: badJsonFiles.length === 0 ? 'PASS' : 'FAIL',
    detail: badJsonFiles.length === 0 ? '所有 .ensoul/state/*.json 格式正常' : `发现损坏的 JSON 状态文件: ${badJsonFiles.join(', ')}`,
    hint: badJsonFiles.length > 0 ? '建议备份后清理或重置损坏的状态文件' : undefined
  });

  // 5. 最近日志异常过滤探测
  let recentErrors = [];
  const logDir = path.join(ws, '.ensoul', 'logs');
  if (fs.existsSync(logDir)) {
    try {
      const logs = fs.readdirSync(logDir).filter(f => f.endsWith('.log'));
      for (const lf of logs.slice(0, 5)) {
        const full = path.join(logDir, lf);
        const content = fs.readFileSync(full, 'utf8');
        const lines = content.split('\n');
        const errLines = lines.filter(l => /(Error|Exception|Failed|TypeError|ReferenceError)/i.test(l) && !l.includes('0 errors'));
        if (errLines.length > 0) {
          recentErrors.push(`[${lf}] ${errLines[errLines.length - 1].trim()}`);
        }
      }
    } catch {}
  }
  report.items.push({
    category: '日志异常探测',
    status: recentErrors.length === 0 ? 'PASS' : 'WARN',
    detail: recentErrors.length === 0 ? '近期日志未发现未捕获异常' : `近期异常摘要: ${recentErrors.slice(0, 3).join(' | ')}`,
    hint: recentErrors.length > 0 ? '可使用 doctor_diagnose 深入分析报错' : undefined
  });

  // 综合评级
  if (report.items.some(i => i.status === 'FAIL')) report.overall = 'FAIL';
  else if (report.items.some(i => i.status === 'WARN')) report.overall = 'WARN';

  return report;
}

/** 智能问题定位与根因诊断 */
function diagnoseIssue(query, targetPath, workspaceRoot) {
  const ws = workspaceRoot || process.cwd();
  const q = String(query || '').trim();
  const result = {
    query: q,
    matchedPitfalls: [],
    archOrigins: [],
    contextChecks: [],
    recommendations: []
  };

  // 1. 匹配硬坑规则
  for (const rule of PITFALL_RULES) {
    if (rule.check({ query: q, file: targetPath })) {
      result.matchedPitfalls.push({
        id: rule.id,
        name: rule.name,
        cause: rule.cause,
        solution: rule.solution,
        reference: rule.reference
      });
    }
  }

  // 2. 匹配架构真源
  for (const arch of ARCH_ORIGIN_MAP) {
    if (arch.keyword.test(q) || (targetPath && arch.keyword.test(targetPath))) {
      result.archOrigins.push({
        component: arch.component,
        truthPath: arch.truthPath,
        fn: arch.fn,
        notes: arch.notes
      });
    }
  }

  // 3. 动态环境上下文检查
  const srcStat = findLatestMtime(path.join(ws, 'src'), ['.ts', '.tsx', '.js']);
  const distStat = findLatestMtime(path.join(ws, 'dist'), ['.js']);
  if (srcStat.latest > 0 && distStat.latest > 0 && srcStat.latest > distStat.latest) {
    result.contextChecks.push({
      type: 'BUILD_DRIFT',
      warning: '注意：当前检测到 src/ 最新文件修改时间晚于 dist/ 编译产物，代码改动尚未完成构建！'
    });
  }

  // 4. 汇总建议
  if (result.matchedPitfalls.length > 0) {
    for (const p of result.matchedPitfalls) {
      result.recommendations.push(...p.solution);
    }
  }
  if (result.archOrigins.length > 0) {
    result.recommendations.push(
      `建议查阅对应唯一真源落点：${result.archOrigins.map(a => a.truthPath).join(', ')}`
    );
  }
  if (result.recommendations.length === 0) {
    result.recommendations.push(
      '未匹配到已知特定暗坑，建议按以下顺序排查：1. build_project 检查完整编译报错；2. grep 定位报错符号；3. 查看最近日志 read_logs；4. 使用 doctor_search_docs 检索相关文档。'
    );
  }

  return result;
}

/** 针对 docs 和 skills 的切片级精准检索 */
function searchDocs(keyword, workspaceRoot) {
  const ws = workspaceRoot || process.cwd();
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return '请提供搜索关键词';

  const targets = [
    'AGENTS.md',
    'CLAUDE.md',
    'docs/development.md',
    'docs/runtime-hardening.md',
    'docs/architecture-review.md',
    'docs/file-write-safety.md',
    'docs/reliable-tasks.md',
    'docs/plugin-spec.md',
    'skills/ensoul-map/SKILL.md',
    'skills/fix-build/SKILL.md',
    'skills/make-plugin/SKILL.md',
    'skills/add-tool/SKILL.md',
    'skills/prompt-protocol/SKILL.md'
  ];

  const results = [];
  for (const rel of targets) {
    const full = path.join(ws, rel);
    if (!fs.existsSync(full)) continue;
    try {
      const text = fs.readFileSync(full, 'utf8');
      const lines = text.split('\n');
      let currentSection = path.basename(rel);
      let matchBuffer = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#')) {
          currentSection = line.replace(/^#+\s*/, '').trim();
        }
        if (line.toLowerCase().includes(kw)) {
          // 提取上下文 3 行
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length - 1, i + 2);
          const snippet = lines.slice(start, end + 1).map((l, idx) => `${start + idx + 1}: ${l}`).join('\n');
          results.push({
            file: rel,
            section: currentSection,
            line: i + 1,
            snippet
          });
          if (results.length >= 12) break;
        }
      }
    } catch {}
    if (results.length >= 12) break;
  }

  if (results.length === 0) {
    return `在核心文档与技能中未找到包含「${keyword}」的内容。建议缩短关键词或改用 grep 全局搜索。`;
  }

  let out = `## 文档精准检索结果（关键词: "${keyword}"，共 ${results.length} 处匹配）\n\n`;
  for (const r of results) {
    out += `### 📄 ${r.file} > ${r.section} (第 ${r.line} 行)\n` +
           `\`\`\`markdown\n${r.snippet}\n\`\`\`\n\n`;
  }
  return out;
}

module.exports = {
  name: 'doctor',
  description: t('项目问题定位、故障诊断与架构速查中枢（一键体检/根因诊断/文档速查）'),

  panel: {
    kind: 'doctor',
    label: t('项目诊断'),
    hint: t('快速定位项目报错、暗坑排查与系统体检'),
    title: t('项目体检与排障'),
    body: 'messages'
  },

  setup(api) {
    const ws = typeof api.workspace === 'function' ? api.workspace() : (api.workspace || process.cwd());

    // 工具 1：智能根因排查与定位
    api.addTool({
      name: 'doctor_diagnose',
      level: 'read',
      kits: ['dev', 'troubleshoot'],
      description: t('智能分析项目中的报错信息、异常现象或函数符号。自动匹配已知暗坑（CRLF行尾/产物时效/契约同步/穿透/串味等）、定位架构唯一真源与修改落点，并输出诊断与修复建议。'),
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: t('报错信息、堆栈、异常行为现象描述或涉及的符号名')
          },
          path: {
            type: 'string',
            description: t('可选：涉及的文件路径或目录')
          }
        },
        required: ['query']
      }
    }, (args) => {
      const res = diagnoseIssue(args.query, args.path, ws);
      let out = `# 🩺 问题诊断报告\n\n**查询现象 / 报错**：\`${res.query}\`\n\n`;
      
      if (res.contextChecks.length > 0) {
        out += `### ⚠️ 实时环境预警\n`;
        for (const c of res.contextChecks) {
          out += `- ${c.warning}\n`;
        }
        out += '\n';
      }

      if (res.matchedPitfalls.length > 0) {
        out += `### 🎯 匹配到的已知硬坑与故障模式\n`;
        for (const p of res.matchedPitfalls) {
          out += `#### 【${p.id}】${p.name}\n`;
          out += `- **根因机理**：${p.cause}\n`;
          out += `- **规范出处**：\`${p.reference}\`\n`;
          out += `- **推荐解法**：\n`;
          for (const s of p.solution) out += `  1. ${s}\n`;
          out += '\n';
        }
      }

      if (res.archOrigins.length > 0) {
        out += `### 🗺️ 架构唯一真源与涉及模块\n`;
        for (const a of res.archOrigins) {
          out += `- **功能单元**：${a.component}\n`;
          out += `  - 真源落点：\`${a.truthPath}\`\n`;
          out += `  - 关键入口：\`${a.fn}\`\n`;
          out += `  - 说明：${a.notes}\n\n`;
        }
      }

      out += `### 💡 下一步建议行动\n`;
      for (let i = 0; i < res.recommendations.length; i++) {
        out += `${i + 1}. ${res.recommendations[i]}\n`;
      }

      return out;
    });

    // 工具 2：全景健康体检
    api.addTool({
      name: 'doctor_healthcheck',
      level: 'read',
      kits: ['dev', 'troubleshoot'],
      description: t('一键执行项目与运行时全景健康体检。涵盖构建产物时效、核心代码行尾(CRLF/LF)检查、插件健康度与语法校验、状态持久化JSON完整性及最近日志异常。'),
      parameters: { type: 'object', properties: {} }
    }, () => {
      const hc = runHealthCheck(ws);
      let out = `# 🩺 项目健康体检报告\n\n`;
      out += `**体检时间**：${hc.timestamp} | **综合状态**：**${hc.overall === 'HEALTHY' ? '✅ 运行良好 (HEALTHY)' : hc.overall === 'WARN' ? '⚠️ 存在告警 (WARN)' : '❌ 存在异常 (FAIL)'}**\n\n`;
      out += `| 检查项 | 状态 | 详细事实 | 建议 |\n`;
      out += `|---|---|---|---|\n`;
      for (const item of hc.items) {
        const mark = item.status === 'PASS' ? '🟢 PASS' : item.status === 'WARN' ? '🟡 WARN' : '🔴 FAIL';
        out += `| ${item.category} | ${mark} | ${item.detail} | ${item.hint || '无'} |\n`;
      }
      return out;
    });

    // 工具 3：文档与规范切片级速查
    api.addTool({
      name: 'doctor_search_docs',
      level: 'read',
      kits: ['dev', 'troubleshoot'],
      description: t('在项目的核心文档(docs/)与技能(skills/)中进行切片级精准关键词检索，快速提取相关架构说明与规范，免去翻找全篇文档。'),
      parameters: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            description: t('要查询的规范关键词、模块名或现象，例如 "floatBare"、"行尾"、"缓存"、"三件套"')
          }
        },
        required: ['keyword']
      }
    }, (args) => {
      return searchDocs(args.keyword, ws);
    });

    // 快捷命令
    api.addCommand({
      id: 'doctor',
      label: t('项目体检'),
      hint: t('运行一键系统体检报告')
    }, () => {
      const hc = runHealthCheck(ws);
      return JSON.stringify(hc, null, 2);
    });
  }
};
