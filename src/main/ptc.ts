/**
 * PTC (Program-aided Tool Calling) 模式：
 * 1. 把所有 Native 工具的 JSON Schema 紧凑渲染为 TypeScript 接口定义
 * 2. 在可终止的工作线程中运行编排代码，工具调用由宿主执行
 */

import { isResidentTool, type ToolSpec } from './agent';
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

/** 工具说明压成一行并掐到上限 —— 按需区只留「它是干什么的」这一点线索 */
function oneLine(text: string, max = 100): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * 将传入的所有工具声明渲染成紧凑的 TypeScript SDK 接口代码。
 *
 * 分两段，账这么算：
 *   · 常驻工具（见 agent.ts 的 RESIDENT_TOOLS）给**完整签名** —— 它们是每轮都会用到的，
 *     这一段的字节会随轮数线性计费，所以必须只留真正高频的。
 *   · 其余工具只给「名字 + 一行说明」—— 参数表由 tool_find 现取，
 *     那一笔只在真正要用的那一轮付一次（见 renderToolFind）。
 *
 * 两段都在 `declare const tools` 里，所以按需那些也**可以直接调用** ——
 * 区别只是提示里没有它们的参数形状，不知道怎么写就先 tool_find。
 */
export function renderToolsSdk(tools: ToolSpec[]): string {
  const usable = tools.filter((tool) => tool.function.name !== 'run_code'); // 避免自引用
  // 安全阀：按需那一段要靠 tool_find 才取得回来。白名单（员工工具套件）把它滤掉时
  // 就必须整体退回全量 —— 否则那些工具只剩个名字，参数表再也取不到，等于被静默摘掉。
  const canDefer = usable.some((tool) => tool.function.name === 'tool_find');
  const resident = usable.filter((tool) => !canDefer || isResidentTool(tool.function.name));
  const onDemand = canDefer ? usable.filter((tool) => !isResidentTool(tool.function.name)) : [];

  const lines: string[] = [
    t('// ── PTC 模式：已注册的可用工具 SDK 声明 ──'),
    t('// 大模型无需直接发出原生 tool call，只需在 run_code 中通过 `await tools.<工具名>(参数)` 调用。'),
    t('// 原生 tools 列表只有 run_code；以下 SDK 才是当前面板实际获授权的工具清单。清单内工具可通过 run_code 调用，不能因原生列表未单列它们就声称没有工具或权限。'),
    'declare const tools: {',
  ];

  for (const tool of resident) {
    const fn = tool.function;
    const desc = fn.description ? fn.description.replace(/\n+/g, ' ') : '';
    lines.push(`  /** ${desc} */`);
    const params = fn.parameters as any;
    const req = Array.isArray(params?.required) && params.required.length > 0;
    const tsParam = schemaToTsType(params, 1);
    lines.push(`  ${fn.name}(args${req ? '' : '?'}: ${tsParam}): Promise<any>;`);
  }

  if (onDemand.length) {
    lines.push(
      '',
      t('  // ── 以下工具同样可直接调用；参数表没写在这儿，用 tool_find 现取 ──'),
      t('  // 不知道参数怎么写时：`await tools.tool_find({ name: "<名字>" })` 拿完整定义，再照它调。'),
      t('  // 参数已经清楚的，直接 `await tools.<名字>(...)` 调用即可，不必先查。'),
    );
    for (const tool of onDemand) {
      const fn = tool.function;
      lines.push(`  /** ${oneLine(fn.description || '')} */`);
      lines.push(`  ${fn.name}(args?: any): Promise<any>;`);
    }
  }

  lines.push('};');
  return lines.join('\n');
}

/**
 * tool_find 的回执 —— 一个工具的完整参数表。
 *
 * 这一份是**当轮的增量**：它只出现在这次工具返回里，不回写系统提示，
 * 所以取多少都不动前缀缓存 —— 这正是它比常驻便宜的原因。
 */
export function renderToolFind(tools: ToolSpec[], name: string): string {
  const wanted = String(name ?? '').trim();
  if (!wanted) return t('tool_find 要 name：想取哪一个工具的参数表。');
  const found = tools.find((tool) => tool.function.name === wanted);
  if (!found) {
    const names = tools
      .filter((tool) => tool.function.name !== 'run_code')
      .map((tool) => tool.function.name)
      .join('、');
    return t('这块面板上没有叫「{n}」的工具。可用的有：{list}', { n: wanted, list: names });
  }
  const fn = found.function;
  const desc = fn.description ? fn.description.replace(/\n+/g, ' ') : '';
  const params = fn.parameters as any;
  const req = Array.isArray(params?.required) && params.required.length > 0;
  const tsParam = schemaToTsType(params, 1);
  return [
    `// ${fn.name} —— 完整参数表`,
    `/** ${desc} */`,
    `async function ${fn.name}(args${req ? '' : '?'}: ${tsParam}): Promise<any>`,
    '',
    t('参数 JSON Schema（照它填）：'),
    '```json',
    JSON.stringify(params ?? { type: 'object', properties: {} }, null, 1),
    '```',
    '',
    t('调用方式：') + '`await tools.' + fn.name + '({ ... })`',
  ].join('\n');
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
    /**
     * 看门狗**可停表**：它算的是「工作线程自己在算」的时间，
     * 不含「宿主在替它等一个子工具」的时间。
     *
     * 为什么必须这样：天生该长跑的子工具不少 —— 等人回答问题、跑一条长命令、出图……
     * 拿总墙钟去掐，掐掉的是**正在正常干活的那些调用**；而真正的死循环在 worker 里，
     * 表一直走着，照旧掐得住。这一层从前就是这么把一次提问掐没的。
     */
    let timer: NodeJS.Timeout | undefined;
    const stopTimer = () => {
      if (timer) { clearTimeout(timer); timer = undefined; }
    };
    const armTimer = () => {
      stopTimer();
      timer = setTimeout(() => {
        const error = new Error('[TOOL_TIMEOUT] run_code 执行超时');
        ctrl.abort(error);
        finish({ error: error.message });
      }, timeoutMs);
    };
    armTimer();
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
        /*
         * 宿主替它跑子工具的这段时间**停表** —— 见上面 armTimer 那段：
         * 这段时间花多久由子工具自己说了算（它有自己的 timeoutMs），
         * 不算进 run_code 的墙钟里。跑完接着计时，防的还是 worker 自己转死。
         */
        stopTimer();
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
        } finally {
          /* 子工具跑完了，看门狗重新开始算「worker 自转」的时间 */
          if (!settled) armTimer();
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
