/**
 * PTC (Program-aided Tool Calling) 模式：
 * 1. 把所有 Native 工具的 JSON Schema 紧凑渲染为 TypeScript 接口定义
 * 2. 在可终止的工作线程中运行编排代码，工具调用由宿主执行
 */

import type { ToolSpec } from './agent';
import { t } from '../shared/i18n';
import * as path from 'path';
import { Worker } from 'worker_threads';

export interface PtcRunResult {
  output: string;
  subCalls: { name: string; args: any; result: string }[];
  filesWritten: string[];
}

/**
 * 将单个 JSON Schema 类型转换为简洁的 TypeScript 类型字面量
 */
function schemaToTsType(schema: any, indentLevel = 1): string {
  if (!schema) return 'any';
  if (schema.enum && Array.isArray(schema.enum)) {
    return schema.enum.map((v: any) => JSON.stringify(v)).join(' | ');
  }
  if (schema.type === 'string') return 'string';
  if (schema.type === 'number' || schema.type === 'integer') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'array') {
    const itemType = schemaToTsType(schema.items, indentLevel);
    return itemType.includes('|') ? `(${itemType})[]` : `${itemType}[]`;
  }
  if (schema.type === 'object' || schema.properties) {
    const props = schema.properties || {};
    const req = new Set(Array.isArray(schema.required) ? schema.required : []);
    const keys = Object.keys(props);
    if (!keys.length) return 'Record<string, any>';
    const pad = '  '.repeat(indentLevel);
    const innerPad = '  '.repeat(indentLevel + 1);
    const lines: string[] = ['{'];
    for (const k of keys) {
      const p = props[k];
      const opt = req.has(k) ? '' : '?';
      const desc = p?.description ? ` /** ${p.description.replace(/\n+/g, ' ')} */\n${innerPad}` : '';
      lines.push(`${innerPad}${desc}${k}${opt}: ${schemaToTsType(p, indentLevel + 1)};`);
    }
    lines.push(`${pad}}`);
    return lines.join('\n');
  }
  return 'any';
}

/**
 * 将传入的所有工具声明渲染成紧凑的 TypeScript SDK 接口代码
 */
export function renderToolsSdk(tools: ToolSpec[]): string {
  const lines: string[] = [
    t('// ── PTC 模式：已注册的可用工具 SDK 声明 ──'),
    t('// 大模型无需直接发出原生 tool call，只需在 run_code 中通过 `await tools.<工具名>(参数)` 调用。'),
    t('// 原生 tools 列表只有 run_code；以下 SDK 才是当前面板实际获授权的工具清单。清单内工具可通过 run_code 调用，不能因原生列表未单列它们就声称没有工具或权限。'),
    'declare const tools: {',
  ];

  for (const t of tools) {
    const fn = t.function;
    if (fn.name === 'run_code') continue; // 避免自引用
    const desc = fn.description ? fn.description.replace(/\n+/g, ' ') : '';
    lines.push(`  /** ${desc} */`);
    const params = fn.parameters as any;
    const req = Array.isArray(params?.required) && params.required.length > 0;
    const tsParam = schemaToTsType(params, 1);
    lines.push(`  ${fn.name}(args${req ? '' : '?'}: ${tsParam}): Promise<any>;`);
  }

  lines.push('};');
  return lines.join('\n');
}

/**
 * 构造唯一的 run_code 工具声明
 */
export function getRunCodeToolSpec(): ToolSpec {
  return {
    type: 'function',
    function: {
      name: 'run_code',
      description: t('在可终止的工作线程中执行异步 JavaScript 来调度授权工具。通过 await tools.<name>(args) 调用；工具依次执行。return 或 console.log 指定输出；没有显式输出时返回子工具结果。'),
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: t('要在异步函数体内执行的代码字符串（支持 top-level await 和 return，无需再写 async function 包装）。通过 await tools.<tool_name>(args) 调用工具。'),
          },
          description: {
            type: 'string',
            description: t('一句话说明这段程序的目标/行为。'),
          },
        },
        required: ['code'],
      },
    },
  };
}

/**
 * 工作线程隔离阻塞，不是第三方代码的安全沙箱。
 */
export async function executeRunCode(
  code: string,
  rawRunner: (name: string, args: any, signal?: AbortSignal) => Promise<string>,
  onSubTool?: (name: string, args: any, result: string) => void,
  maxSubCalls = 50,
  allowedTools?: Set<string>,
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<PtcRunResult> {
  const subCalls: { name: string; args: any; result: string }[] = [];
  const filesWritten: string[] = [];
  signal?.throwIfAborted();
  const ctrl = new AbortController();
  const worker = new Worker(path.join(__dirname, 'ptc-worker.js'), {
    workerData: { code },
    resourceLimits: { maxOldGenerationSizeMb: 128 },
  });
  let calls = 0;
  let queue = Promise.resolve();
  let callError = '';
  const done = await new Promise<{ value?: unknown; error?: string; logs?: string[] }>((resolve, reject) => {
    let settled = false;
    const finish = (value?: { value?: unknown; error?: string; logs?: string[] }, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(value!);
    };
    const onAbort = () => {
      ctrl.abort(signal?.reason);
      finish(undefined, signal?.reason || new Error('这一轮已停止'));
    };
    const timer = setTimeout(() => {
      const error = new Error('[TOOL_TIMEOUT] run_code 执行超时');
      ctrl.abort(error);
      finish({ error: error.message });
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('error', (error) => { ctrl.abort(error); finish({ error: error.message }); });
    worker.on('exit', (code) => {
      if (!settled) {
        const error = new Error(`run_code 工作线程提前退出（${code}）`);
        ctrl.abort(error);
        finish({ error: error.message });
      }
    });
    worker.on('message', (message) => {
      if (settled) return;
      if (message.type === 'done') {
        void queue.then(() => finish(message));
        return;
      }
      if (message.type !== 'call') return;
      const { name, args, id } = message;
      const denied = allowedTools && !allowedTools.has(name);
      const overLimit = calls >= maxSubCalls;
      if (denied || overLimit) {
        const error = denied ? `工具 ${name} 不在当前面板/员工授权的工具套件中`
          : `达到单次 run_code 的最大工具调用上限 (${maxSubCalls} 次)`;
        callError ||= error;
        worker.postMessage({ id, error });
        return;
      }
      calls += 1;
      queue = queue.then(async () => {
        try {
          ctrl.signal.throwIfAborted();
          const result = await rawRunner(name, args, ctrl.signal);
          ctrl.signal.throwIfAborted();
          subCalls.push({ name, args, result });
          if (name === 'write_file' && args?.path && /^已写入 /.test(result)) filesWritten.push(String(args.path));
          onSubTool?.(name, args, result);
          let value: unknown = result;
          try { value = JSON.parse(result); } catch { /* 字符串结果沿用原文 */ }
          if (!settled) worker.postMessage({ id, value });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          callError ||= text;
          if (!settled) worker.postMessage({ id, error: text });
        }
      });
    });
  });
  signal?.throwIfAborted();
  const parts = done.logs || [];
  if (done.value !== undefined) parts.push(typeof done.value === 'object' ? JSON.stringify(done.value, null, 2) : String(done.value));
  if (!parts.length) parts.push(...subCalls.map((call) => `${call.name}:\n${call.result}`));
  if (done.error || callError) parts.push(`执行出错: ${done.error || callError}`);
  if (!parts.length) parts.push('[执行完成，未调用工具，也没有输出]');
  const seeTags = subCalls.flatMap((call) => Array.from(call.result.matchAll(/\[\[see:\s*([^\n\]]+?)\]\]/gi), (match) => match[0]));
  parts.push(...new Set(seeTags));
  return { output: parts.join('\n\n').trim(), subCalls, filesWritten };
}
