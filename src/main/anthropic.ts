/**
 * Anthropic Messages 协议适配（`POST /v1/messages`）。
 *
 * 对话循环内部只有一套形状（OpenAI 那套）：ApiMessage / ToolSpec / CallResult。
 * 这里把那一套翻成 Anthropic 的形状、再把回包翻回来 —— chat-core 那边只多几个分支。
 * 协议细节全部关在这个文件里，anthropic 这条路上怎么改都碰不到 openai 通路。
 *
 * 三处天生对不上、必须在这儿抹平的：
 *   1. 系统提示不在 messages 里，走顶层 `system`；
 *   2. 工具结果不是 role:'tool'，是 **user 消息里的 tool_result 块**，而且必须和它的
 *      tool_use 配对、排在同一条 user 消息里 —— 配错或顺序不对就是 400；
 *   3. `max_tokens` **必填**，且思考预算得小于它（budget 16384 配 max_tokens 8192
 *      会被直接拒掉）。
 */

export const ANTHROPIC_VERSION = '2023-06-01';

/** 用量：字段名对齐 chat-core 的 AgentUsage，省得两边再翻一道 */
export interface AnthropicUsage {
  prompt: number;
  completion: number;
  total: number;
  cacheHit: number;
}

/** 这条提供方是不是走 Anthropic 原生协议 */
export function isAnthropicApi(api?: string): boolean {
  return String(api ?? '').trim().toLowerCase() === 'anthropic-messages';
}

/**
 * 拼请求地址。用户填什么都能用：
 *   官方域 `https://api.anthropic.com`、带版本的 `…/v1`、已经写全了的 `…/v1/messages`、
 *   以及中转给的任意前缀。不重复补 `/v1`。
 */
export function anthropicEndpoint(baseUrl: string): string {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (/\/messages$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base)) return `${base}/messages`;
  return `${base}/v1/messages`;
}

/**
 * 鉴权头。官方只认 `x-api-key`；中转网关大多只搬了 OpenAI 那套 `Authorization`。
 * 非官方域两个都带上 —— 省得用户填了中转、一路 401 却查不出原因。
 */
export function anthropicHeaders(cfg: { apiKey: string; baseUrl?: string }): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    'x-api-key': String(cfg.apiKey ?? ''),
  };
  if (!/anthropic\.com/i.test(String(cfg.baseUrl ?? ''))) h.Authorization = `Bearer ${String(cfg.apiKey ?? '')}`;
  return h;
}

/** 把 content 拍平成纯文本（图片块丢掉，只留文字） */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) return String(content);
  return content
    .map((p: any) => (typeof p === 'string' ? p : p?.type === 'text' ? String(p.text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

/** data URL 的图 → Anthropic 的 base64 图块。认不出来就丢掉（宁缺不报错） */
function imageBlock(part: any): any | null {
  const url = String(part?.image_url?.url ?? '');
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (!m) return null;
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2].replace(/\s/g, '') } };
}

/** user 消息的 content → Anthropic 的块数组（文本 + 图） */
function userBlocks(content: unknown): any[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'text', text: String(content ?? '') }];
  const out: any[] = [];
  for (const p of content) {
    if (typeof p === 'string') {
      if (p) out.push({ type: 'text', text: p });
      continue;
    }
    if (p?.type === 'text') {
      if (p.text) out.push({ type: 'text', text: String(p.text) });
      continue;
    }
    const img = imageBlock(p);
    if (img) out.push(img);
  }
  return out.length ? out : [{ type: 'text', text: '' }];
}

/** 参数字符串 → 对象。模型偶尔吐半截 JSON，落到 {} 上也比抛出去强 */
function safeJson(raw: unknown): any {
  if (raw && typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(String(raw ?? '{}'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * OpenAI 形状的消息数组 → Anthropic 的 `{ system, messages }`。
 *
 * 配对是这里的命门：一条 assistant 里的几个 tool_use，回执必须是**紧跟着的那一条
 * user**、且几个 tool_result 挤在同一个 content 数组里。拆成好几条 user 消息会被拒。
 */
export function toAnthropicMessages(msgs: any[]): { system: string; messages: any[] } {
  const system: string[] = [];
  const out: any[] = [];

  for (const m of msgs ?? []) {
    const role = String(m?.role ?? '');
    if (role === 'system') {
      const txt = textOf(m.content);
      if (txt) system.push(txt);
      continue;
    }

    if (role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: String(m.tool_call_id ?? ''),
        content: textOf(m.content),
      };
      const last = out[out.length - 1];
      // 上一条就是这批工具的回执 → 并进去，不再单开一条 user
      if (last && last.__results) last.content.push(block);
      else out.push({ __results: true, role: 'user', content: [block] });
      continue;
    }

    if (role === 'assistant') {
      const blocks: any[] = [];
      const txt = textOf(m.content);
      if (txt) blocks.push({ type: 'text', text: txt });
      for (const tc of m.tool_calls ?? []) {
        const name = String(tc?.function?.name ?? '');
        if (!name) continue;
        blocks.push({
          type: 'tool_use',
          id: String(tc?.id ?? ''),
          name,
          input: safeJson(tc?.function?.arguments),
        });
      }
      // 空 assistant 会被接口拒掉，直接跳过（它本来也没带来任何信息）
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
      continue;
    }

    out.push({ role: 'user', content: userBlocks(m.content) });
  }

  for (const m of out) delete m.__results;
  return { system: system.join('\n\n'), messages: out };
}

/** 工具清单 → Anthropic 的 tools（`parameters` 在这儿叫 `input_schema`） */
export function toAnthropicTools(tools: any[]): any[] {
  return (tools ?? [])
    .map((t) => ({
      name: String(t?.function?.name ?? t?.name ?? ''),
      description: String(t?.function?.description ?? t?.description ?? ''),
      input_schema: t?.function?.parameters ?? t?.input_schema ?? { type: 'object', properties: {} },
    }))
    .filter((t) => t.name);
}

/**
 * 请求体。
 *
 * `max_tokens` 必填 —— 而思考预算**占用**它：budget 必须小于 max_tokens，否则 400。
 * 所以这里按"预算 + 给正文留的余量"抬高上限，而不是死写一个数。
 */
export function toAnthropicBody(opts: {
  model: string;
  system: string;
  messages: any[];
  tools: any[];
  think?: Record<string, unknown> | null;
  maxTokens?: number;
  stream?: boolean;
}): any {
  const budget = Number((opts.think?.thinking as any)?.budget_tokens ?? 0);
  /**
   * messages 先浅拷一份：下面要往**最后一条**上打缓存断点，不能改调用方的数组/对象
   * （那个数组同一轮里可能还要复用）。
   */
  const msgs = (opts.messages ?? []).map((m) => m);
  const body: any = {
    model: opts.model,
    max_tokens: Math.max(opts.maxTokens ?? 8192, budget + 4096),
    messages: msgs,
    stream: opts.stream !== false,
  };
  // system 走**块数组**而不是裸字符串：只有块数组才挂得上 cache_control。
  // 这个断点把 tools + system 圈进缓存。
  if (opts.system) {
    body.system = [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }];
  }
  /**
   * **第二个断点打在最后一条消息上** —— 少了它，Anthropic 的缓存里就只有 tools + system。
   *
   * Anthropic 的断点语义是"把它**前面**的全部内容圈进缓存"：只打 system 那一个断点，
   * 缓存里就真的只有 system（实测某些线路每轮恒定命中 1,173 token），**整个会话正文
   * 每轮都在按全价重读** —— 这正是 claude 系列命中率只有 6% 的原因。
   * 打在最后一条上，下一轮请求的前缀（到同一个位置为止）就能整体命中；每轮往后滚一次。
   *
   * 上限 4 个断点，我们只用 2 个。写缓存贵 1.25 倍、读便宜 10 倍，一轮就回本。
   */
  const last = msgs[msgs.length - 1];
  if (last) {
    const mark = (b: any) => (b && typeof b === 'object' ? { ...b, cache_control: { type: 'ephemeral' } } : b);
    const content = last.content;
    if (Array.isArray(content) && content.length) {
      msgs[msgs.length - 1] = { ...last, content: [...content.slice(0, -1), mark(content[content.length - 1])] };
    } else if (typeof content === 'string' && content) {
      msgs[msgs.length - 1] = { ...last, content: [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }] };
    }
  }
  if (opts.think && Object.keys(opts.think).length) Object.assign(body, opts.think);
  if (opts.tools?.length) body.tools = toAnthropicTools(opts.tools);
  return body;
}

/** usage 桶 —— Anthropic 把"输入"和"缓存"分开报，得自己加起来才是总输入 */
export interface AnthropicStreamState {
  content: string;
  calls: any[];
  stopReason: string;
  idx: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export function newAnthropicStream(): AnthropicStreamState {
  return { content: '', calls: [], stopReason: '', idx: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

function soakUsage(st: AnthropicStreamState, u: any): void {
  if (!u || typeof u !== 'object') return;
  // 注意是**覆盖**不是累加：message_start 报输入、message_delta 报输出，
  // 各报的是一次请求的不同部分，加起来就翻倍了。
  if (u.input_tokens != null) st.input = Number(u.input_tokens) || 0;
  if (u.cache_read_input_tokens != null) st.cacheRead = Number(u.cache_read_input_tokens) || 0;
  if (u.cache_creation_input_tokens != null) st.cacheWrite = Number(u.cache_creation_input_tokens) || 0;
  if (u.output_tokens != null) st.output = Number(u.output_tokens) || 0;
}

/** 攒到现在的用量；一个字都还没报就返回 null（别拿 0 冒充"用过了"） */
export function anthropicUsageOf(st: AnthropicStreamState): AnthropicUsage | null {
  if (!st.input && !st.cacheRead && !st.cacheWrite && !st.output) return null;
  const prompt = st.input + st.cacheRead + st.cacheWrite;
  return { prompt, completion: st.output, total: prompt + st.output, cacheHit: st.cacheRead };
}

/** 收尾原因 → 对话循环认的那几个词 */
export function anthropicFinishReason(stopReason: string): string {
  switch (String(stopReason ?? '')) {
    case 'tool_use': return 'tool_calls';
    case 'max_tokens': return 'length';
    case 'end_turn':
    case 'stop_sequence': return 'stop';
    default: return '';
  }
}

/**
 * 喂一个流式事件。返回它是不是个错误事件（错误由调用方抛，好带上 Fail 分类）。
 *
 * Anthropic 的流和 OpenAI 那套完全不是一个形状：没有 `choices[].delta`，
 * 而是 `content_block_start / _delta / _stop` 一段段拼。工具参数也是**半截 JSON
 * 字符串**一段段来的（`input_json_delta`），必须原样攒着，最后再整体解析。
 */
export function feedAnthropicEvent(
  st: AnthropicStreamState,
  j: any,
  onText?: (d: string) => void,
  onReasoning?: (d: string) => void,
): { error?: string } {
  const type = String(j?.type ?? '');

  if (type === 'error') {
    const msg = String(j?.error?.message ?? j?.message ?? '');
    return { error: msg || '接口在流里报了个错' };
  }

  if (type === 'message_start') {
    soakUsage(st, j?.message?.usage);
    return {};
  }

  if (type === 'content_block_start') {
    st.idx = Number(j?.index ?? 0);
    const b = j?.content_block ?? {};
    if (b.type === 'tool_use') {
      st.calls[st.idx] = {
        id: String(b.id ?? ''),
        type: 'function',
        function: { name: String(b.name ?? ''), arguments: '' },
      };
    } else if (b.type === 'text' && b.text) {
      st.content += String(b.text);
      onText?.(String(b.text));
    } else if (b.type === 'thinking' && b.thinking) {
      onReasoning?.(String(b.thinking));
    }
    return {};
  }

  if (type === 'content_block_delta') {
    const d = j?.delta ?? {};
    if (d.type === 'text_delta' && d.text) {
      st.content += String(d.text);
      onText?.(String(d.text));
    } else if (d.type === 'thinking_delta' && d.thinking) {
      onReasoning?.(String(d.thinking));
    } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
      const call = st.calls[Number(j?.index ?? st.idx)];
      if (call) call.function.arguments += d.partial_json;
    }
    return {};
  }

  if (type === 'message_delta') {
    if (j?.delta?.stop_reason) st.stopReason = String(j.delta.stop_reason);
    soakUsage(st, j?.usage);
    return {};
  }

  return {};
}

/** 非流式回包 → 内部那套 CallResult 的字段 */
export function fromAnthropicMessage(j: any): {
  content: string;
  toolCalls: any[];
  usage: AnthropicUsage | null;
  finishReason: string;
} {
  const blocks: any[] = Array.isArray(j?.content) ? j.content : [];
  let content = '';
  const toolCalls: any[] = [];
  for (const b of blocks) {
    if (b?.type === 'text') content += String(b.text ?? '');
    else if (b?.type === 'tool_use') {
      toolCalls.push({
        id: String(b.id ?? ''),
        type: 'function',
        function: { name: String(b.name ?? ''), arguments: JSON.stringify(b.input ?? {}) },
      });
    }
  }
  const st = newAnthropicStream();
  soakUsage(st, j?.usage);
  return { content, toolCalls, usage: anthropicUsageOf(st), finishReason: anthropicFinishReason(j?.stop_reason) };
}
