/**
 * runtime-probe —— 运行时报错现场捕获与链路诊断探针。
 *
 * 解决痛点：
 * "Agent 遇事只能瞎猜，看不到真实运行现场的崩溃堆栈、IPC 拒绝和渲染控制台报错"
 *
 * 核心能力：
 * 1. 钩取当前主进程的 uncaughtException、unhandledRejection 与 console.error
 * 3. 关联最近一次被调用的工具、耗时与报错
 * 4. 提供 `probe_runtime_errors` 工具与 /probe 斜杠命令，直接输出结构化现场
 */

const { format } = require('util');

// 环形缓冲，保留最近的运行现场事件
const MAX_EVENTS = 60;
const ringBuffer = [];

let hooked = false;
let origConsoleError = null;
let consoleWrapper = null;

function onRejection(reason) {
  recordEvent('unhandledRejection', reason instanceof Error ? reason.message : String(reason), reason instanceof Error ? reason.stack : '');
}

function onException(err) {
  recordEvent('uncaughtException', err.message, err.stack);
}

function recordEvent(type, message, stack, meta = {}) {
  const item = {
    id: 'err_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    time: new Date().toLocaleTimeString('zh-CN'),
    timestamp: Date.now(),
    type,
    message: String(message || '').slice(0, 500),
    stack: stack ? String(stack).slice(0, 1500) : '',
    ...meta,
  };
  ringBuffer.push(item);
  if (ringBuffer.length > MAX_EVENTS) ringBuffer.shift();
}

function installHooks() {
  if (hooked) return;
  hooked = true;

  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  const previous = console.error;
  origConsoleError = previous;
  consoleWrapper = function (...args) {
    const line = format(...args);
    if (hooked && /error|failed|失败|错误/i.test(line)) {
      recordEvent('console.error', line, '');
    }
    previous.apply(console, args);
  };
  console.error = consoleWrapper;
}

module.exports = {
  name: 'runtime-probe',
  description: '运行时报错现场捕获与调用链异常诊断探针（捕获主进程崩溃、未处理拒绝与近期致命日志）',

  setup(api) {
    installHooks();

    // 监控所有工具调用异常
    api.onAfterTool((done) => {
      if (!done) return;
      const result = String(done.result || '');
      const failed = done.status === 'error' || /^工具执行失败[:：]/.test(result)
        || (done.name === 'run_command' && /（退出码 -?\d+）$/.test(result));
      if (failed) {
        recordEvent('tool_failure', `工具 ${done.name} 失败: ${result}`, '', {
          tool: done.name,
          durationMs: done.durationMs,
          panelId: done.ctx?.panelId,
          runId: done.ctx?.runId,
          taskId: done.ctx?.taskId,
          toolCallId: done.toolCallId,
        });
      }
    });

    // 注册运行时现场诊断工具
    api.addTool(
      {
        name: 'probe_runtime_errors',
        level: 'read',
        kits: ['dev', 'troubleshoot'],
        description: '获取当前运行时现场发生的最近报错与异常事件（包含主进程未处理异常、Promise拒绝、近期失败的工具调用与错误控制台输出）。',
        parameters: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: '获取最近几条报错（默认 10，上限 30）',
            },
            type: {
              type: 'string',
              description: '按错误类型过滤：all | uncaughtException | unhandledRejection | tool_failure | console.error',
            },
          },
        },
      },
      (args) => {
        const limit = Math.min(Math.max(Number(args?.limit) || 10, 1), 30);
        const filterType = args?.type || 'all';

        let list = [...ringBuffer];
        if (filterType !== 'all') {
          list = list.filter((e) => e.type === filterType);
        }
        const recent = list.slice(-limit);

        if (!recent.length) {
          return `### 运行现场记录\n当前筛选范围内没有捕获到错误记录（缓冲区共 ${ringBuffer.length} 条事件）；这不代表所有运行环节均已验证。`;
        }

        let md = `### 🚨 运行时现场近期报错 (最近 ${recent.length} 条)\n\n`;
        for (const ev of recent.reverse()) {
          md += `#### 【${ev.type}】 ${ev.time}\n`;
          md += `- **信息**：\`${ev.message}\`\n`;
          if (ev.tool) md += `- **关联工具**：\`${ev.tool}\`${typeof ev.durationMs === 'number' ? ` (耗时 ${ev.durationMs}ms)` : ''}\n`;
          if (ev.panelId) md += `- **面板**：${ev.panelId}；runId：${ev.runId || '未报告'}；taskId：${ev.taskId || '未报告'}\n`;
          if (ev.stack) {
            md += `- **调用栈**：\n\`\`\`\n${ev.stack.slice(0, 600)}\n\`\`\`\n`;
          }
          md += '\n';
        }
        return md;
      }
    );

    // 注册快捷诊断命令 /probe
    api.addCommand(
      {
        id: 'probe',
        label: '运行现场探针',
        hint: '输出当前内存中捕获的最近报错与崩溃现场',
      },
      () => {
        const count = ringBuffer.length;
        if (!count) return '目前没有捕获到主进程报错或工具异常。';
        return JSON.stringify(ringBuffer.slice(-10), null, 2);
      }
    );

    api.log('运行时现场探针就绪 (监控未处理拒绝、全局异常与工具失败)');
  },

  dispose() {
    process.removeListener('unhandledRejection', onRejection);
    process.removeListener('uncaughtException', onException);
    if (console.error === consoleWrapper && origConsoleError) console.error = origConsoleError;
    origConsoleError = null;
    consoleWrapper = null;
    hooked = false;
    ringBuffer.length = 0;
  },
};
