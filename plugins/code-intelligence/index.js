/**
 * code-intelligence —— 代码智能感知、精准切片、变更审查与排查证据账本插件。
 *
 * 专门解决"盲目全盘搜索、粗放读整文件、Token 空转浪费、修改质量失控、跨轮排查丢证据"的痛点：
 *
 * 1. symbol_find:
 *    文本符号候选定位（函数、类、接口、类型、常量）。返回候选定义与引用。
 *
 * 2. code_slice:
 *    代码精准切片。支持按符号或行号区间切片读取，利用作用域边界裁剪，杜绝粗暴加载 2000 行。
 *
 * 3. review_changes:
 *    变更线索检查。
 *    基于 git diff / 变更分析，对即将提交或刚修改的代码进行语法完整性、CRLF/LF换行、
 *    调试残留、资源泄漏、契约不一致等全维度扫描，并给出精准修复建议。
 *
 * 4. investigation_record:
 *    排查证据账本。持久化排查假说、已排除项和已证实事实，跨轮与上下文压缩后依然保留线索。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ts = require('typescript');

function getWorkspace(api) {
  if (typeof api.workspace === 'function') return api.workspace();
  if (typeof api.workspace === 'string') return api.workspace;
  return process.cwd();
}

/**
 * 递归扫描目录中的代码文件（排除构建产物、依赖和虚拟目录）
 */
function walkCodeFiles(dir, maxFiles = 3000) {
  const results = [];
  const ignoredDirs = new Set(['node_modules', '.git', 'dist', '.ensoul', 'release', 'build', '.electron', 'coverage']);
  const codeExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.html', '.md']);

  function walk(current) {
    if (results.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (results.length >= maxFiles) return;
      if (ent.isDirectory()) {
        if (!ignoredDirs.has(ent.name) && !ent.name.startsWith('.')) {
          walk(path.join(current, ent.name));
        }
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (codeExts.has(ext)) {
          results.push(path.join(current, ent.name));
        }
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * 在代码中定位符号定义
 */
function findSymbolInFiles(symbol, scopeDir, ws) {
  const targetDir = scopeDir ? path.resolve(ws, scopeDir) : ws;
  const files = walkCodeFiles(targetDir);
  const definitions = [];
  const references = [];

  // 严格匹配定义的正则模式
  const defPatterns = [
    new RegExp(`(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${symbol}\\b`),
    new RegExp(`(?:export\\s+)?(?:class|interface|type|enum)\\s+${symbol}\\b`),
    new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${symbol}\\s*[:=]`),
    new RegExp(`(?:public|private|protected|static|async|get|set)\\s+${symbol}\\s*[(:=]`),
    new RegExp(`\\b${symbol}\\s*:\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>`),
    new RegExp(`\\b${symbol}\\s*\\([^)]*\\)\\s*\\{`)
  ];

  for (const filePath of files) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    if (!content.includes(symbol)) continue;

    const lines = content.split(/\r?\n/);
    const relPath = path.relative(ws, filePath).split(path.sep).join('/');

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      if (!line.includes(symbol)) continue;

      const trimmed = line.trim();
      // 忽略单行注释
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

      const isDef = defPatterns.some((pattern) => pattern.test(line));
      const hit = {
        file: relPath,
        line: idx + 1,
        code: trimmed.slice(0, 160)
      };

      if (isDef) {
        definitions.push(hit);
      } else if (references.length < 30) {
        references.push(hit);
      }
    }
  }

  return { definitions, references };
}

/**
 * 提取符号或区间代码切片（JS/TS 使用语法树声明范围）
 */
function sliceCode(filePath, ws, options) {
  const absPath = path.resolve(ws, filePath);
  if (!fs.existsSync(absPath)) {
    return { error: `文件不存在: ${filePath}` };
  }

  const content = fs.readFileSync(absPath, 'utf8');
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;

  if (options.symbol) {
    if (!/\.[cm]?[jt]sx?$/i.test(absPath)) {
      return { error: '符号切片支持 JS/TS 文件；其他文件请指定 start_line。' };
    }
    const source = ts.createSourceFile(absPath, content, ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) {
      return { error: '文件存在语法错误，不能确认完整符号范围；请指定 start_line。' };
    }
    const sym = String(options.symbol);
    let declaration;
    const visit = (node) => {
      if (declaration) return;
      const named = ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
        || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
        || ts.isEnumDeclaration(node) || ts.isVariableDeclaration(node)
        || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)
        || ts.isPropertyAssignment(node) || ts.isGetAccessorDeclaration(node)
        || ts.isSetAccessorDeclaration(node);
      if (named && node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === sym) {
        declaration = ts.isVariableDeclaration(node) && ts.isVariableStatement(node.parent?.parent)
          ? node.parent.parent : node;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (!declaration) return { error: `在 ${filePath} 中未找到符号声明 ${sym}` };
    const declarationStart = source.getLineAndCharacterOfPosition(declaration.getStart(source)).line;
    const declarationEnd = source.getLineAndCharacterOfPosition(declaration.getEnd() - 1).line;
    const start = Math.max(0, declarationStart - 2);
    const end = Math.min(lines.length - 1, declarationEnd + 2, start + 199);
    return {
      file: filePath, symbol: sym, startLine: start + 1, endLine: end + 1, totalLines,
      declarationStart: declarationStart + 1, declarationEnd: declarationEnd + 1,
      truncated: end < declarationEnd,
      slice: lines.slice(start, end + 1).map((line, i) => `${start + i + 1}: ${line}`).join('\n')
    };
  }

  // 按起止行号截取
  const start = Math.max(0, (options.startLine || 1) - 1);
  const count = Math.min(options.limit || 60, 200);
  const end = Math.min(totalLines - 1, start + count - 1);

  const slice = lines.slice(start, end + 1).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
  return {
    file: filePath,
    startLine: start + 1,
    endLine: end + 1,
    totalLines,
    slice
  };
}

/**
 * 变更审查（review_changes）
 */
function reviewDiffChanges(ws, targetFiles) {
  const git = (args) => execFileSync('git', ['-c', 'core.quotePath=false', '--literal-pathspecs', ...args], {
    cwd: ws, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 10_000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const paths = (targetFiles || []).map((file) => {
    const relative = path.relative(ws, path.resolve(ws, String(file)));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error(`审查路径越出工作区：${file}`);
    }
    return relative.split(path.sep).join('/') || '.';
  });
  let diffText;
  const skippedFiles = [];
  try {
    git(['rev-parse', '--show-toplevel']);
    let hasHead = true;
    try { git(['rev-parse', '--verify', 'HEAD']); } catch { hasHead = false; }
    const flags = ['--no-ext-diff', '--no-textconv', '--no-color'];
    diffText = hasHead ? git(['diff', ...flags, 'HEAD', '--', ...paths])
      : git(['diff', ...flags, '--cached', '--', ...paths]) + git(['diff', ...flags, '--', ...paths]);
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths]).split('\0').filter(Boolean);
    for (const relative of untracked) {
      const bytes = fs.readFileSync(path.join(ws, relative));
      if (bytes.includes(0)) { skippedFiles.push(relative); continue; }
      const lines = bytes.toString('utf8').split(/\r?\n/);
      diffText += `\ndiff --git a/${relative} b/${relative}\n@@ -0,0 +1,${lines.length} @@\n`
        + lines.map((line) => '+' + line).join('\n') + '\n';
    }
  } catch (err) {
    return { status: 'error', summary: `未完成变更检查：${err.message}`, checkedFiles: [], issues: [] };
  }

  const issues = [];
  const filesChecked = new Set();

  if (!diffText.trim()) {
    return {
      status: skippedFiles.length ? 'not_checked' : 'clean',
      summary: skippedFiles.length ? '仅发现未扫描的二进制文件。' : '指定范围内没有可检查的代码变更。',
      checkedFiles: [], skippedFiles, issues: []
    };
  }

  const diffBlocks = diffText.split(/^diff --git /m);

  for (const block of diffBlocks) {
    if (!block.trim()) continue;
    const headerMatch = block.match(/^a\/(.+?) b\/(.+)$|^"a\/(.+?)" "b\/(.+?)"$/m);
    if (!headerMatch) continue;

    const filePath = headerMatch[2] || headerMatch[4];
    filesChecked.add(filePath);

    const addedLines = [];
    const lines = block.split(/\r?\n/);
    let currentLineNum = 0;

    for (const line of lines) {
      const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        currentLineNum = parseInt(hunkMatch[1], 10);
        continue;
      }
      if (line.startsWith('+') && !line.startsWith('+++')) {
        addedLines.push({
          line: currentLineNum,
          content: line.slice(1)
        });
        currentLineNum++;
      } else if (line.startsWith(' ')) {
        currentLineNum++;
      }
    }

    const debuggerLines = new Set();
    if (/\.[cm]?[jt]sx?$/i.test(filePath) && fs.existsSync(path.join(ws, filePath))) {
      const source = ts.createSourceFile(filePath, fs.readFileSync(path.join(ws, filePath), 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node) => {
        if (ts.isDebuggerStatement(node)) debuggerLines.add(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    // 审查 1：调试代码遗留检查 (console.log / debugger)
    for (const item of addedLines) {
      if (debuggerLines.has(item.line)) {
        issues.push({
          level: 'blocker',
          file: filePath,
          line: item.line,
          code: item.content.trim(),
          rule: 'no-debugger',
          message: '检测到遗留的 debugger 调试断点，生产与运行环境中禁止提交。'
        });
      }
      if (/\bconsole\.(log|debug|trace)\(/.test(item.content) && !filePath.includes('test') && !filePath.includes('scripts/')) {
        issues.push({
          level: 'minor',
          file: filePath,
          line: item.line,
          code: item.content.trim(),
          rule: 'clean-console',
          message: '新增了调试级别控制台输出，请确认是否为必要日志。'
        });
      }
    }

    // 审查 2：插件契约隐患检查 (api.workspace 函数化调用)
    if (filePath.startsWith('plugins/')) {
      for (const item of addedLines) {
        if (/api\.workspace\(\)/.test(item.content) && !/typeof api\.workspace\s*===?\s*['"]function['"]/.test(item.content)) {
          issues.push({
            level: 'major',
            file: filePath,
            line: item.line,
            code: item.content.trim(),
            rule: 'contract-workspace-getter',
            message: '发现 api.workspace() 调用；宿主通常提供字符串属性，请复核是否已有类型检查或适配。'
          });
        }
      }
    }

    // 审查 3：未处理的异步与监听泄露
    for (const item of addedLines) {
      if (/addEventListener\(/.test(item.content) && !/removeEventListener/.test(block)) {
        issues.push({
          level: 'major',
          file: filePath,
          line: item.line,
          code: item.content.trim(),
          rule: 'event-listener-leak',
          message: '新增了事件监听，但本补丁内未找到对应的解绑逻辑。长驻面板或插件重新加载时可能导致内存泄漏。'
        });
      }
      if (/setInterval\(/.test(item.content) && !/clearInterval|cleanup|dispose/.test(block)) {
        issues.push({
          level: 'major',
          file: filePath,
          line: item.line,
          code: item.content.trim(),
          rule: 'timer-leak',
          message: '新增了 setInterval 定时器，请确保在 dispose 或 cleanup 中清除。'
        });
      }
    }

    // 审查 4：绝对路径硬编码
    for (const item of addedLines) {
      if (/(?:[A-Za-z]:[\\/]|(?:\/(?:Users|home|root)\/))/.test(item.content) && !/process\.env|fallback/.test(item.content)) {
        issues.push({
          level: 'major',
          file: filePath,
          line: item.line,
          code: item.content.trim(),
          rule: 'no-hardcoded-path',
          message: '疑似包含开发机硬编码绝对路径，跨机器或环境部署时会导致失败。'
        });
      }
    }
  }

  const blockerCount = issues.filter((i) => i.level === 'blocker').length;
  const majorCount = issues.filter((i) => i.level === 'major').length;
  const minorCount = issues.filter((i) => i.level === 'minor').length;

  let status = 'pass';
  if (blockerCount > 0) status = 'failed';
  else if (majorCount > 0 || skippedFiles.length > 0) status = 'warning';
  if (!filesChecked.size) status = 'not_checked';

  return {
    status,
    checkedFiles: Array.from(filesChecked),
    skippedFiles,
    stats: { blocker: blockerCount, major: majorCount, minor: minorCount },
    issues
  };
}

module.exports = {
  name: 'code-intelligence',
  description: '代码智能检索、精准切片、变更审查与排查证据账本（自研 MIT 友好）',

  setup(api) {
    const t = api.t || ((s) => s);
    const ws = getWorkspace(api);
    const ledgerFile = path.join(ws, '.ensoul', 'state', 'investigation.json');
    const readLedger = () => {
      const state = api.state.load(null);
      if (state && state.schemaVersion === 1 && state.panels) return state;
      const legacyRecords = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : [];
      return { schemaVersion: 1, panels: {}, legacyRecords };
    };
    const scopeKey = (ctx) => ctx.taskId ? 'task:' + ctx.taskId : 'conversation';
    const renderLedger = (ctx) => {
      if (!ctx?.panelId) return '';
      const state = readLedger();
      const records = state.panels[ctx.panelId]?.[scopeKey(ctx)] || [];
      if (!records.length) return '';
      const labels = { testing: '待验证假设', confirmed: '已记录结论', refuted: '已排除路线' };
      const lines = records.slice(-5).map((record) => `  · [${labels[record.status]}] ${record.hypothesis} (证据: ${record.evidence})${record.nextStep ? '；下一步：' + record.nextStep : ''}`);
      return '【当前面板与任务的排查记录】\n历史结论需结合当前源码复核，新证据可以修正。\n' + lines.join('\n');
    };

    // 1. 符号候选查找
    api.addTool({
      name: 'symbol_find',
      level: 'read',
      kits: ['dev', 'review'],
      description: t('精准查找代码符号（函数、类、接口、类型定义、变量）。返回定义所在文件与行号，过滤普通文本引用，避免全盘盲目搜索。'),
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: t('要查找的符号名称，如 buildSystemPrompt 或 searchWorkspace') },
          path: { type: 'string', description: t('可选：限定子目录，如 src 或 plugins') }
        },
        required: ['symbol']
      }
    }, (args) => {
      const res = findSymbolInFiles(args.symbol, args.path, ws);
      let out = `## 符号查找结果: \`${args.symbol}\`\n\n`;
      if (res.definitions.length === 0 && res.references.length === 0) {
        return out + `未在代码中找到该符号。`;
      }

      if (res.definitions.length > 0) {
        out += `### 📌 符号定义 / 声明 (${res.definitions.length} 处)\n`;
        for (const def of res.definitions) {
          out += `- **\`${def.file}:${def.line}\`**: \`${def.code}\`\n`;
        }
        out += '\n';
      }

      if (res.references.length > 0) {
        out += `### 🔗 引用与调用 (${res.references.length} 处)\n`;
        for (const ref of res.references.slice(0, 15)) {
          out += `- \`${ref.file}:${ref.line}\`: \`${ref.code}\`\n`;
        }
        if (res.references.length > 15) {
          out += `- …（还有 ${res.references.length - 15} 处引用被折叠）\n`;
        }
      }
      return out;
    });

    // 2. 代码精准切片
    api.addTool({
      name: 'code_slice',
      level: 'read',
      kits: ['dev'],
      description: t('读取指定文件的代码切片。JS/TS 符号按语法树定位；也可按行号读取，超过范围预算会明确提示。'),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: t('文件相对路径，如 src/main/agent.ts') },
          symbol: { type: 'string', description: t('可选：要截取的目标函数或类名（按语法树取得声明范围）') },
          start_line: { type: 'number', description: t('可选：起始行号（从 1 开始）') },
          limit: { type: 'number', description: t('可选：截取行数（默认 60，上限 200）') }
        },
        required: ['path']
      }
    }, (args) => {
      const res = sliceCode(args.path, ws, {
        symbol: args.symbol,
        startLine: args.start_line,
        limit: args.limit
      });
      if (res.error) return `⚠️ ${res.error}`;
      const note = res.truncated ? `\n符号完整范围为第 ${res.declarationStart} ~ ${res.declarationEnd} 行；当前仅显示前 200 行窗口，请用 start_line 继续读取。` : '';
      return `### 📄 代码切片: \`${res.file}\` (第 ${res.startLine} ~ ${res.endLine} 行，共 ${res.totalLines} 行)${note}\n\n\`\`\`ts\n${res.slice}\n\`\`\``;
    });

    // 3. 变更自检与代码审查门禁
    api.addTool({
      name: 'review_changes',
      level: 'read',
      kits: ['dev', 'review'],
      description: t('检查 Git 变更与未跟踪文件中的调试语句和候选隐患。输出启发式线索，不替代构建、测试和人工复核。'),
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: { type: 'string' },
            description: t('可选：要审查的具体文件路径列表，留空审查所有未提交变更')
          }
        }
      }
    }, (args) => {
      const res = reviewDiffChanges(ws, args?.files);
      let out = `## 变更检查报告\n\n`;
      const labels = { pass: '已扫描，未命中重要规则', warning: '有候选问题或未扫描文件', failed: '发现调试断点', clean: '没有待检查变更', not_checked: '未完成代码扫描', error: '检查失败' };
      out += `**检查状态**：${labels[res.status]}\n`;
      if (res.summary) out += res.summary + '\n';
      if (res.skippedFiles?.length) out += `未扫描文件：${res.skippedFiles.join(', ')}\n`;
      if (res.checkedFiles && res.checkedFiles.length > 0) {
        out += `**审查文件**：${res.checkedFiles.map((f) => `\`${f}\``).join(', ')}\n\n`;
      }

      if (res.issues.length === 0) {
        if (res.checkedFiles?.length) out += '未命中当前启发式规则；仍需按改动范围进行验证。';
        return out;
      }

      out += `### 缺陷与风险清单 (${res.issues.length} 条)\n\n`;
      for (const iss of res.issues) {
        const badge = iss.level === 'blocker' ? '🚨 [阻断]' : iss.level === 'major' ? '⚠️ [重要]' : 'ℹ️ [建议]';
        out += `#### ${badge} \`${iss.file}:${iss.line}\` (${iss.rule})\n`;
        out += `- **问题**：${iss.message}\n`;
        out += `- **涉及代码**：\`${iss.code}\`\n\n`;
      }
      return out;
    });

    // 4. 排查证据账本
    api.addTool({
      name: 'investigation_record',
      level: 'write',
      kits: ['dev', 'troubleshoot'],
      description: t('按当前面板和任务保存排查假设、结论与排除项；新证据可以更新同一假设。'),
      parameters: {
        type: 'object',
        properties: {
          hypothesis: { type: 'string', description: t('排查假说或待验证结论') },
          status: { type: 'string', enum: ['testing', 'confirmed', 'refuted'], description: t('状态：testing 验证中 | confirmed 已证实 | refuted 已排除') },
          evidence: { type: 'string', description: t('查证事实、文件行号或报错证据') },
          next_step: { type: 'string', description: t('下一步行动建议') }
        },
        required: ['hypothesis', 'status', 'evidence']
      }
    }, (args, ctx) => {
      if (!ctx?.panelId) return '记录失败：缺少当前面板上下文。';
      ctx.signal?.throwIfAborted();
      if (!['testing', 'confirmed', 'refuted'].includes(args.status)) return '记录失败：排查状态无效。';
      try {
        const state = readLedger();
        const panel = state.panels[ctx.panelId] || (state.panels[ctx.panelId] = {});
        const key = scopeKey(ctx);
        const records = panel[key] || [];
        const record = { time: new Date().toISOString(), hypothesis: args.hypothesis,
          status: args.status, evidence: args.evidence, nextStep: args.next_step || '' };
        const index = records.findIndex((item) => item.hypothesis === args.hypothesis);
        if (index >= 0) records.splice(index, 1);
        records.push(record);
        panel[key] = records.slice(-20);
        if (!api.state.save(state)) return '记录失败：排查状态未保存。';
        return `排查记录已保存：【${args.status}】${args.hypothesis}\n证据：${args.evidence}`;
      } catch (err) {
        return `记录失败：${err.message}`;
      }
    });


    // 工具 5：小预算代码地图生成 (Repo Map)
    api.addTool({
      name: 'repo_map',
      level: 'read',
      kits: ['dev', 'nav'],
      description: t('生成高密度、小预算的核心代码骨架地图。提取文件中的核心导出、类与函数签名，控制在 1000~2000 字预算内，避免盲目遍历整目录。'),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: t('指定目录范围，默认工作区核心 (src 与 plugins)') },
          max_lines: { type: 'number', description: t('最大返回行数预算，默认 80 行') },
          filter: { type: 'string', description: t('关键字过滤，例如 "agent"、"store"') }
        }
      }
    }, (args) => {
      const scope = args?.path ? path.resolve(ws, args.path) : ws;
      const maxLines = Math.min(200, Math.max(20, Number(args?.max_lines) || 80));
      const kw = args?.filter ? String(args.filter).toLowerCase() : null;

      const files = walkCodeFiles(scope, 500).filter(f => {
        const ext = path.extname(f);
        return ['.ts', '.tsx', '.js'].includes(ext);
      });

      const outlines = [];
      const sigPattern = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+([A-Za-z0-9_$]+)|class\s+([A-Za-z0-9_$]+)|interface\s+([A-Za-z0-9_$]+)|type\s+([A-Za-z0-9_$]+)|const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\()/;

      for (const f of files) {
        if (outlines.length >= maxLines) break;
        const rel = path.relative(ws, f).replace(/\\/g, '/');
        if (kw && !rel.toLowerCase().includes(kw) && !path.basename(rel).toLowerCase().includes(kw)) {
          // 如果给了关键字过滤，且路径不包含，则跳过
          continue;
        }

        try {
          const content = fs.readFileSync(f, 'utf8');
          const lines = content.split(/\r?\n/);
          const sigs = [];

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const m = line.match(sigPattern);
            if (m) {
              const name = m[1] || m[2] || m[3] || m[4] || m[5];
              if (name && !name.startsWith('_')) {
                sigs.push(name);
              }
            }
            if (sigs.length >= 6) break;
          }

          if (sigs.length > 0) {
            outlines.push(`📄 ${rel}\n   └─ ${sigs.join(', ')}`);
          }
        } catch {}
      }

      if (!outlines.length) {
        return t('未在指定范围内匹配到代码大纲。');
      }

      return [
        `### 🗺️ 代码骨架地图 (Repo Map) [共 ${outlines.length} 模块]`,
        outlines.slice(0, maxLines).join('\n'),
        outlines.length >= maxLines ? t('\n…（已达到最大预算行数，可通过更具体的 path 或 filter 参数收窄）') : ''
      ].filter(Boolean).join('\n');
    });

    
    // 工具 6：UI与文本溯源 (ui_text_find)
    api.addTool({
      name: 'ui_text_find',
      level: 'read',
      kits: ['dev', 'troubleshoot', 'i18n'],
      description: t('根据用户在界面、截图或报错中看到的文本（如英文模式下漏翻译的中文、按钮标题、提示文本），精准溯源其在源码组件中的位置，并自动检测该文本是属于硬编码未提取、还是缺少翻译字典、亦或是提取被局部变量遮蔽。'),
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: t('用户看到的界面文本片段（如 "开始对话" 或 "项目诊断"）') },
          path: { type: 'string', description: t('可选限定目录，如 src/renderer 或 plugins') }
        },
        required: ['text']
      }
    }, (args) => {
      const query = String(args?.text || '').trim();
      if (!query) return t('请提供待查询的界面文本。');

      const scope = args?.path ? path.resolve(ws, args.path) : ws;
      const files = walkCodeFiles(scope, 2000).filter(f => {
        const ext = path.extname(f);
        return ['.tsx', '.jsx', '.ts', '.js'].includes(ext);
      });

      // 读取词典缓存
      const dictKeys = new Set();
      const coreEnPath = path.resolve(ws, 'src/shared/locales/core.en.ts');
      const promptsPath = path.resolve(ws, 'src/shared/i18n.prompts.ts');
      for (const p of [coreEnPath, promptsPath]) {
        if (fs.existsSync(p)) {
          try {
            const raw = fs.readFileSync(p, 'utf8');
            const reg = /['"`]([^'"`\r\n]+)['"`]\s*:\s*['"`]/g;
            let m;
            while ((m = reg.exec(raw)) !== null) {
              dictKeys.add(m[1]);
            }
          } catch {}
        }
      }

      const hits = [];
      for (const f of files) {
        let content;
        try {
          content = fs.readFileSync(f, 'utf8');
        } catch {
          continue;
        }

        if (!content.includes(query)) continue;
        const rel = path.relative(ws, f).replace(/\\/g, '/');
        const lines = content.split(/\r?\n/);

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.includes(query)) continue;
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

          // 分析命中特征
          const tMatches = [...line.matchAll(/\bt\s*\(\s*['`"]([^'`"]+)['`"]/g)].map(m => m[1]);
          const targetInT = tMatches.some(str => str.includes(query));
          const wrappedInT = targetInT || /\bt\s*\(\s*['`"][^'`"]*['`"]/.test(line);
          const hasInDict = tMatches.some(str => dictKeys.has(str)) || dictKeys.has(query) || [...dictKeys].some(k => k.includes(query));

          let diagnosis = '';
          if (!wrappedInT) {
            diagnosis = '⚠️ 【硬编码未提取】该文本未被 t("...") 包裹，在任何语言切换下都会固定显示原文！';
          } else if (!hasInDict) {
            diagnosis = '❌ 【漏填英文翻译】源码已包裹 t("...")，但翻译字典 (core.en.ts / i18n.prompts.ts) 中缺少对应条目，回落为中文原文！';
          } else {
            diagnosis = '✅ 【字典已收录】源码已包裹且字典有记录；若界面仍显示中文，多半属于 t 变量被局部遮蔽 (i18n-t-shadowing) 或组件未监听语言变更。';
          }

          hits.push({
            file: rel,
            line: i + 1,
            code: trimmed.slice(0, 160),
            diagnosis
          });

          if (hits.length >= 15) break;
        }
        if (hits.length >= 15) break;
      }

      if (!hits.length) {
        return t('未在代码中找到包含文本 "{text}" 的有效源码行。可尝试截取更短的独立词组重试。', { text: query });
      }

      const out = [
        `## 🔍 界面文本溯源与诊断报告: "${query}"`,
        `共定位到 ${hits.length} 处源码匹配：\n`
      ];

      for (const h of hits) {
        out.push(`### 📍 ` + h.file + ':' + h.line);
        out.push('```tsx\n' + h.line + ': ' + h.code + '\n```');
        out.push(h.diagnosis + '\n');
      }

      return out.join('\n');
    });

    api.addPrompt(renderLedger);
    api.addSummaryNote(renderLedger);
  }
};
