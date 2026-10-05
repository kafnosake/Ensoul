# DSH 插件生态勘察报告（面向 ensoul 移植决策）

- 勘察范围：`C:\Users\KATU\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`（约 250 个包，`lib/*.js` 为可读的 bundle）
- 本机插件库：`C:\Users\KATU\.dsh\profiles\web\vendor\`（dsh-cny-cost / dsh-command-console / dsh-image-gen / dsh-web-restart）与 `C:\Users\KATU\.dsh\profiles\web\node_modules\dsh-wechat\`
- 剖面配置：`C:\Users\KATU\.dsh\profiles\web\{cordis.yml, cordis.patch.yml, package.json}`
- 全部结论均来自实际文件读取；无法验证的点标注 `(未验证)`。
- 只读任务，未修改任何文件（本报告文件除外，写在会话工作区 `D:\anycode`）。

---

## 1. 插件架构：插件怎么写、怎么注册

### 1.1 运行时底座：cordis 4.0.2

DSH 不是自定义插件系统，而是 vendored 的 **cordis**（`@deepseek-ai/cordis@4.0.2`，`vendor/cordis`）。核心概念三个：

| 概念 | 说明 | 证据 |
|---|---|---|
| `ctx` 服务容器 | `Context` 是**代理对象**，属性读取走服务解析器。所有服务以名字挂在 `ctx` 上（`ctx.tools`、`ctx.commands`、`ctx.systemPrompt`、`ctx.fs`、`ctx.skills`…） | `cordis/lib/types/context.d.ts` |
| `Service` 基类 | `class X extends Service { constructor(ctx, name) { super(ctx, name) } }`；`super()` 内部调 `ctx.reflect.provide(name, this, check)`，**随 fiber 卸载自动注销** | `cordis/src/service.ts:42-59` |
| `inject` 依赖声明 | 插件只在声明的服务**全部可用**时才挂载；不可用时整棵 fiber 处于等待态。数组形式 `inject = ['tools','commands']`，对象形式可带 intercept config | `cordis/lib/types/registry.d.ts:13-15,52-63` |

插件入口支持三种形态（`registry.d.ts:48-81`）：函数 `(ctx, config) => any`、类 `new (ctx, config)`、对象 `{ apply(ctx, config) }`。统一可带 `name` / `Config`（standard-schema 校验器）/ `inject` / `provide` / `intercept`。

作用域：`ctx.extend()` 派生、`ctx.isolate(name, label)` 隔离服务作用域、`ctx.intercept(name, config)` 叠加服务配置。DSH 在此之上加了 `@deepseek-ai/dsh-scope`：**agent 级作用域**——同一个工具可以"全局注册"也可以"注册到某个 agent 的 scope"，读取时按 scope 链合并，近层遮蔽远层（`dsh-tools` 的 `layers`、`dsh-skill` 的 `layers` 都是这个模型）。

### 1.2 apply(ctx) 典型做什么

真实最小形态（本机 vendor 插件 `dsh-web-restart/lib/index.js:22-33,61-63`）：

```js
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-web-restart'
export const inject = ['tools', 'subprocess']

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'dsh_restart',
      description: 'Restart the running DSH web server. ...',
      parameters: {
        reason: { type: 'string', description: '...' },
        graceSeconds: { type: 'number', description: '...' },
        dryRun: { type: 'boolean', description: '...' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) { return [{ type: 'text', text: '...' }] },
      },
      async execute(args, exec) { /* ... */ },
    }),
  )
  ctx.logger?.info?.('dsh-web-restart: ready')
}

export default { name, inject, apply }
```

`apply(ctx)` 里典型会出现的东西（全部实测于真实插件）：

1. `ctx.tools.register(defineTool({...}))` — 注册模型可见工具，返回 disposer。
2. `ctx.commands.register({ name, description, handler })` — 注册人类 `/斜杠命令`（`dsh-commands/lib/types/index.d.ts:37-52,91`）。`name` 是**不带斜杠的小写名**。
3. `ctx.systemPrompt.section({ name, order, text })` — 注册系统提示词片段；`text` 可以是 `(context) => string`；有中心化的 order 常量表 `SECTION_ORDERS`（`dsh-system-prompt/lib/types/index.d.ts:47-141`）。
4. `ctx.systemPrompt.context({ name, order, text })` — 注册**动态运行时上下文**（按 turn 重新物化的 user-role 快照），`CONTEXT_ORDERS` = `SANDBOX_POLICY:110 / APPROVAL_POLICY:115 / SUBAGENT_DELEGATION:120`。
5. `ctx.on('some/waterfall-event', (…, next) => …)` + `ctx.effect(...)` — 挂事件监听，`ctx.effect` 保证随 fiber 卸载。
6. `ctx.sessionProjections.register({ key, stateSchema, stateVersion, init, apply, wire:{viewSchema,view} })` — 注册**会话投影**（从 append-only 会话日志增量折叠出的可展示状态），这是 UI 面板拿数据的标准方式（`dsh-cny-cost` 的 `cnyCost`、`dsh-token-meter`、`dsh-time-context` 都用它）。
7. `ctx.fs.resolve()` / `ctx.fs.read` 等 — 只走 `ctx.fs`，绝不用 `node:fs`，这样才受沙箱约束。
8. `ctx.logger`、`ctx.get('service')`（可选服务，返回 `undefined` 不阻塞）、`ctx.inject([...], cb)`（可选服务到位后再执行）。
9. `ctx.effect(() => ctx.interval(fn, ms), 'label')` — 定时任务。

### 1.3 扩展点全清单（按类别）

| 扩展点 | 注册 API | 读取/消费方 |
|---|---|---|
| 工具 | `ctx.tools.register(definition)` | 每回合装配给模型的 tool schema |
| 人类命令 | `ctx.commands.register(definition)` | 聊天输入框 `/` 菜单 |
| 系统提示词片段 | `ctx.systemPrompt.section({name,order,text})` | 每回合 system prompt |
| 动态上下文快照 | `ctx.systemPrompt.context({name,order,text})` | 每回合注入的 user-role 快照 |
| 会话投影 | `ctx.sessionProjections.register({key,…})` | UI 面板、标题、成本、token |
| 事件/瀑布钩子 | `ctx.on(event, listener)` | 见下方事件表 |
| 工具限制 | `ctx.tools.restrict({allow?,deny?})`（**仅 agent scope 可用**） | 该 agent 的可见工具集 |
| 工具守卫 | `ctx.tools.guard(fn)`（返回字符串即拒绝） | `tools/pre-execute` 之后的单调守卫 |
| 提交流 | `ctx.tools.presentAs(mode)` | native / ptc / both 三种呈现模式 |
| 技能提供者 | `ctx.skills.registerProvider(create)` | 技能目录与加载 |
| 运行时技能 | `ctx.skills.register(skill)` | 同上，进程内注入 |
| 子代理提供者 | `ctx.subagents` + `subagent/provider-added` 事件 | 委派工具 |
| 客户端 UI 模块 | **package.json 的 `dsh.client`**，不是代码 API | 浏览器 roster |
| 配置 schema | 插件的 `Config`（schemastery / standard-schema） | `cordis.patch.yml` 的 `config:` |
| 补丁层 | `cordis.patch.yml` 的 `insert` / id 覆盖 | Loader 组合 |

关键事件（可用 `ctx.on` 挂钩）：

- 工具管线：`tools/pre-execute`、`tools/execute`、`tools/post-execute`、`tools/ptc-dispatch-log`、`tools/result`、`tools/change`（`dsh-tools/lib/types/index.d.ts:38-93`）。三者都是 **waterfall**：`next()` 委派，返回值即接管。
- Agent 循环：`agent/created`、`agent/disposed`、`agent/status`、`agent/session-start`、`agent/pre-step`、`agent/request`、`agent/request-error`、`agent/assistant-stream`、`agent/turn-stopping`、`agent/error`、`agent/inbox/{inserted,claimed,discarded}`（`dsh-agent/lib/types/runtime-types.d.ts:212-419`）。
- 提示词装配：`system-prompt/assemble`（**专家级 waterfall**，可重写整份装配结果）、`system-prompt/change`（`dsh-system-prompt`）。
- 审批：`approval/request`（waterfall，返回 `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`）；审计事件 `approval/asked` / `approval/decided`（`dsh-user-approval/lib/types/types.d.ts:26,76`）。
- 提问：`user-questions/request`（waterfall）。
- 技能：`skills/change`。
- 文件系统：`fs/write-intent`、`fs/edit-intent`、`fs/observed`（`dsh-fs-observation-policy/lib/index.js:90-93`）。

### 1.4 客户端 UI 模块（Web 半）

客户端模块**不靠代码注册**，靠 `package.json` 声明：

```json
"dsh": {
  "client": { "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right", "..."], "platform": "web" },
  "bundle": { "patch": "./cordis.patch.yml" }
}
```

`dsh-client-modules`（Node 侧）扫描 Loader 中所有声明了 `dsh.client` 的包，组装 `window.__DSH_BOOT__` 的模块图，合成 combo script 注入 index.html（`dsh-client-modules/lib/index.js:66-89,139-151,434-489`）。`platform` 必须是字符串，`inject`/`external` 必须是字符串数组，`immediately` 必须是 boolean——校验失败直接抛错。客户端必须导出 `./client` 子路径。

本机实例：`dsh-image-gen` 的 `dsh.client.inject` 列了 7 个 UI 包（`dsh-client-ui-settings-plugins`、`dsh-client-ui-tool`…），`dsh-cny-cost` 是 `"client": { "inject": [], "platform": "web" }`。

### 1.5 配置 / 补丁层如何映射到插件实例

剖面目录结构（`dsh/apps/cli` 的 `profile-boot`）：

- `cordis.yml` = **空数组**的根，仅为了让 Loader 有真实 include 根锚定 `baseUrl`；**永远不要编辑**（每次启动都被覆写）。
- `package.json` 的 `dsh.profile.bundles` = 有序 bundle 列表；`patchReload: "live"` 开启补丁热重载。
- 每个 bundle 包自带 `cordis.patch.yml`，通过 `package.json` 的 `dsh.bundle.patch` 指向。
- 应用顺序（`lib/profile-boot-Dk-7KqJc.js:213-257` + `README.md:39-44`）：

```
空根
 → dsh.profile.bundles 顺序里每个 bundle 的 patch
 → 剖面自己的 cordis.patch.yml
 → 家目录级 $DSH_HOME/cordis.patch.yml   （比剖面层更高优先，机器级偏好）
 → --patch 覆盖层（按 argv 顺序）
 → DSH_TELEMETRY_DISABLED 生成的禁用补丁
```

补丁条目语义（`dsh-app-boot/lib/index.js:59-107`）：

- `- insert: [ {id, name, config?, disabled?}, ... ]`：顶层 insert 追加新行；带 `id` 的 insert 只能插进 `group` 型行的 `config` 数组。
- `- id: <目标id>` + 任意键（`config` / `disabled` / `name`）：**按 id 覆盖目标行**，最后写者胜；`config` 是**整体替换不是深合并**，所以要改一个键必须把该行所有键重述一遍（`dsh-base/README.md:134` 明确列为已知限制）。
- `id` 找不到 → 只 warn 并跳过（不报错）。
- `!!js` 表达式允许（js-yaml 标签），例如 `disabled: !!js process.platform === 'win32'`、`path: !!js dshHomePath('sessions')`。

本机真实例子（`C:\Users\KATU\.dsh\profiles\web\cordis.patch.yml`）：插入 `cny-cost` 行、整体替换 `llm-deepseek` 的 `models` 数组（因为要加 `inputModalities: [text, image]`——harness 按**声明**而非实际能力 gate 图片输入）、插入 `mcp-blender` 行（`name: '@deepseek-ai/dsh-mcp-client'`，`transport: stdio`，`command: …blender-mcp.exe`，`toolCallTimeoutMs: 180000`，`env.BLENDER_MCP_PORT: "9877"`）。

> **一次插件实例 = 一行**。同一个包可以插入多行、每行一份独立 config 与独立实例：`dsh-base/cordis.patch.yml:349-367` 用 `@deepseek-ai/dsh-tool-subagent` 挂了**两行**——`toolName: subagent`（provider `spawn`，`backgroundMode: continuable`）和 `toolName: subagent_fork`（provider `fork`，`backgroundMode: one-shot`）。`dsh-tool-subagent-control/list-agents` 也是同样的子路径多实例手法。

---

## 2. 工具清单（每个插件一行）

格式：`工具名(参数名)` — 作用。除注明外全部来自各包 `lib/index.js` 的 `defineTool({...})` 字面量。

| 插件 | 注册的工具 | 说明 |
|---|---|---|
| `dsh-tool-fs` | `read(file_path, offset?, limit?)` | 读 UTF-8 文本，返回带行号内容。`isConcurrencySafe`；有 `presentCall`+`presentResult` |
| | `write(file_path, content, sandbox_permissions?, justification?)` | 创建/整体覆盖 UTF-8 文本文件 |
| | `edit(file_path, old_string, new_string, replace_all?, sandbox_permissions?, justification?)` | 字面量替换式编辑（唯一匹配或 `replace_all`） |
| | `read_image(file_path)` | 读 PNG/JPEG/WebP/GIF 并把图片本身交回模型；**仅在 `ctx.inject(["attachments"])` 后注册**；依赖模型声明支持 image 模态 |
| `dsh-tool-fs-search` | `glob(pattern, path?)` | 按 glob 找文件路径（只返文件不返目录，含隐藏与 ignored；按 mtime 排序，上限 100） |
| | `grep(pattern, path?, include?)` | ripgrep 正则搜内容，按文件分组返行号 |
| `dsh-tool-pwsh` | `pwsh(command, description, timeoutMs?, workdir?, run_in_background?, sandbox_permissions?, justification?)` | 跑 `pwsh -Command`，每次全新进程（**无状态，用 `workdir` 不要 `cd`**）；Win32 上启用 |
| `dsh-tool-bash` | `bash(command, description, timeoutMs?, workdir?, run_in_background?, sandbox_permissions?, justification?)` | 同构，POSIX 上启用；两者 `Config = { enableRunInBackground: true }` |
| `dsh-tool-jobs` | `job_output(job_id, wait?, timeout_ms?)` | 读后台作业；流式作业只返回自上次读取以来的输出，末尾附 `[status: …]` |
| | `job_list()` | 列出本会话所有作业（运行中+已结束） |
| | `job_kill(job_id, reason?)` | 取消运行中的作业，立即返回 |
| | | `Config = { waitTimeoutMs: 30000, maxWaitTimeoutMs: 600000, completionDelivery: 'wakeup'|'quiet', maxConsecutiveWakes: 3 }` |
| `dsh-tool-todo` | `todo_write(todos[])` | 结构化任务列表；**每次必须发整份列表，整体替换**；item = `{content, status: pending|in_progress|completed}`；config `allowParallelInProgress: true` |
| `dsh-tool-web` | `web_search(queries[])` | 1~4 条查询，返回摘要答案 + 来源 URL 列表；`isConcurrencySafe`，有 `timeoutMs` |
| | `web_fetch(url)` | 抓取指定 HTTP(S) URL 并解码为文本；`isConcurrencySafe`，有 `timeoutMs` |
| | | `Config = { search, fetch, searchMaxResults: 8, searchMaxQueries: 4, fetchTimeoutMs: 30000, searchTimeoutMs: 30000, fetchMaxOutputChars: 200000 }` |
| `dsh-tool-subagent` | `<toolName>(description, prompt, provider?, model?, reasoning_effort?, run_in_background?)` | 委派一个子代理。**同一个包挂两行**：`toolName: subagent`（provider `spawn`，`backgroundMode: continuable`）+ `toolName: subagent_fork`（provider `fork`，`one-shot`）。fork 版继承本对话历史，spawn 版自包含。`provider/model/reasoning_effort` 仅在 `modelSelectionSettings` 开启时出现；`isConcurrencySafe` |
| | `list_subagent_models(provider?, model?)` | 无副作用地查子代理可用 LLM 路由与 reasoning effort（需挂 model-selection policy） |
| `dsh-tool-subagent-control` | `send_message(agent_id, message)` | 给**直接子**代理（或直属父）发消息，不返回答复只确认投递；运行中用于转向，空闲时开启新回合 |
| | `interrupt_agent(agent_id)` | 请求取消某后台代理当前回合（只停当前回合，子代理本身仍可续用） |
| | `list_agents(scope?)` | 经子路径入口 `@deepseek-ai/dsh-tool-subagent-control/list-agents` 单独注册；`scope: children|descendants`，列可续用子代理及其状态 |
| `dsh-tool-workflow` | `workflow(script, meta{name,description,whenToUse?,phases?}, args?)` | 跑 JS 编排脚本，fan-out 大量子代理（`agent()`/`pipeline()`/`parallel()`/`phase()`/`log()` hook），脚本内 `return` 一个 JSON 值作为工具结果。`toolName` 可配（默认 `workflow`），`maxResultChars: 50000` |
| `dsh-tool-ralph` | `ralph(objective, maxRounds?)` | 前台 fresh-agent Ralph 循环：每轮开一个无对话种子的新子代理，只有有界结构化报告跨轮传递；仅当人类明确要求时才用。`maxRounds: 256`（base 剖面覆盖为 64） |
| `dsh-tool-goal` | `create_goal(objective, max_goal_rounds?)` / `get_goal()` / `update_goal(goal_id, revision, action, objective?, max_goal_rounds?, blocked_reason?)` | 同会话持久目标。`get_goal` 返回精确 id/revision/phase/已用轮次/上限/阻塞原因/是否已武装，`update_goal` 前必须先读。`action` ∈ `edit|pause|resume|complete|blocked`；`blocked` 在配置的最少轮数之前会被拒绝（`blockedAfterConsecutiveRounds: 3`） |
| `dsh-tool-skill` | `skill(name)` | 加载某个可用技能的完整正文。同时用 `agent/pre-step` 把 `<available_skills>` 目录以 durable user message 注入；`catalogDescriptionMaxLength: 500` |
| `dsh-tool-present` | `present(files[{path, description?}])` | 把已存在的文件声明为最终交付物（内容不复制不保存，用户打开当前源文件）；`maxFiles: 8` |
| `dsh-tool-ask-user` | `ask_user_question(questions[{id, question, header?, options?[{label,description?}], multi_select?}])` | 向用户提一个或多个问题（每个带稳定 id，答案按 id 回传）；走 `user-questions/request` waterfall；**无 `Config`** |
| `dsh-tool-str-replace-editor` | `str_replace_editor(command, path, file_text?, insert_line?, new_str?, old_str?, view_range?)` | 可选的四命令编辑器：`view`（`cat -n` 语义，目录列 2 层）/ `create` / `str_replace` / `insert`。`maxOutputChars: 16000`，`description` 可覆盖。**base 剖面默认不挂**，需显式 insert |
| `dsh-tool-cordis` | `cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine` / `cordis_inspect_list` / `cordis_inspect_query(platform, provider, method, input?)` / `cordis_inspect_self(pluginId?, packageId?)` | 让 Agent **在运行时定义并挂载自己的 Cordis 插件包**（host 半 + client 半），以及只读自省已挂载的运行时树。仅 `cordis` 预设挂载，**无 `Config`** |
| `dsh-mcp-client` | 动态：`mcp__<serverName>__<rawName>` | MCP 桥。为每个 MCP 工具注册一个 harness 工具，名字规范化到 `[A-Za-z0-9_-]` 并截断到 64 字符；有损时追加 `_<sha256前12位>`。`transport` **只支持 `stdio` 与 `streamable-http`，不支持旧 SSE**。`serverName` 匹配 `/^[A-Za-z0-9_-]{1,32}$/`；`toolCallTimeoutMs: 60000`；stdio 子进程的父环境会被清洗（凭据形状与残留 `DSH_*` 变量剔除） |

**横切观察**：只有 `glob`、`grep`、`web_search`、`web_fetch` 声明了**定义级 `timeoutMs`**；只有 `read`、`read_image`、`web_search`、`web_fetch`、`subagent` 声明 `isConcurrencySafe`；**每个**工具的 `output` 都必带 `render`（否则 `tools.register` 直接抛 TypeError）。

---

## 3. 值得偷的横切策略

> 注意：这批包里**只有一部分是 loader 插件**（`export const inject`）。很多是 cordis **Service 类**（`static inject` + `super(ctx, "服务名")`，没有插件 `name`）。已分别标注。括号内为 `dsh-base/cordis.patch.yml` 实际配置值。

**大输出落盘**
- `dsh-spill` — 只有服务定义，服务名 `spillStore`（`class SpillStore extends Service`），定义 `saveText` 契约返回 `{locator, bytes, retrievalHint}`。价值：与存储介质解耦的接缝。
- `dsh-spill-local` — `LocalSpillStore` 实现。`Config = { root, cleanupPeriodDays: 30 }`；`root` 未设则 `mkdtempSync(join(tmpdir(),'dsh-spill-'))`，0700 目录 / 0600 文件，按 `session-<sha256(sessionId)[0:12]>` 分目录，`retrievalHint = "Use read with offset/limit, or grep this path to search within it."`。
- `dsh-spill-policy` — `name = "spill-policy"`，`inject = ["tools"]`。挂 `tools/post-execute` 与 `tools/ptc-dispatch-log`（均 `{prepend:true}`）；文本 UTF-8 字节超 `maxInlineBytes`（**本部署 50000**）时把**完整文本**存进 `ctx.spillStore`，上下文里只留 head/tail 预览 + `" Full formatted result stored at: "` + locator。跳过嵌套调用（`exec.parent !== void 0`）和 `read` 本身（避免 read→spill→read 死循环）。`maxInlineBytes` 缺失即**真 no-op**。失败一律保留原文（best-effort，绝不把成功变成 `isError`）。
- **为什么重要**：把"大输出"从上下文预算问题降级为"一次额外 read 调用"，且不改写工具语义。

**工具超时**
- `dsh-tool-call-timeout-policy` — `name = "timeout-policy"`，`inject = ["tools"]`，**无 Config**。挂 `tools/execute` 瀑布，读 `ctx.tools.get(exec.name, exec.agent)?.timeoutMs`（未声明就不计）；超时产出 `TOOL_TIMEOUT` / `info.name = "ToolTimeoutError"` / `isError: true`，文本 `tool call timed out after <n>ms`。
- **为什么重要**：把"挂死的工具"变成一条可路由的**结果**而不是卡死整个 agent 循环——超时必须由循环层统一兜底，不能指望每个工具自查。

**重复调用提醒**
- `dsh-repeat-tool-reminder` — `name = "repeat-tool-reminder"`，**完全无 `inject`**。挂 `tools/post-execute`（推进链）与 `agent/pre-step`（遇到 `message.source.kind === "user"` 重置链）。`Config = { thresholds: [3,5,8], include: [], exclude: [], argumentsPreviewChars: 500 }`。第 1 档给温和提醒，之后给带工具名、次数、参数预览（500 字符截断）的详细提醒；来源标记 `{kind:"plugin", plugin:"repeat-tool-reminder", form:"notice"}`。
- **为什么重要**：重复调用同一工具同一参数是 agent 最常见的死循环形态；这是**建议式**（不否决）而非硬拦截的破环器。

**文件观测策略（读后写）**
- `dsh-fs-observation-policy` — `name = "fs-observation-policy"`，**无 `inject`**（不读任何服务）。挂 `fs/write-intent`、`fs/edit-intent`、`fs/observed` 三个事件，内部用 session 为键的 WeakMap 记录"权威的存在/不存在观测"。未读先改直接抛 `FsError('edit requires reading "<path>" first', "FS_NOT_OBSERVED")`。
- **为什么重要**：一条极便宜的乐观并发/幻觉防护——模型无法编辑一个它从未读过的文件。

**审批与权限**
- `dsh-user-approval` — 服务名 `approval`。`Config = { policy: 'ask' | 'never' }`（本部署：`danger-full-access` 时 `never`，否则 `ask`）。通过 `ctx.waterfall(scopeTarget(req.agent), 'approval/request', req, () => 'unavailable')` 组链，**fail-closed**：没有应答者就是 `unavailable`。结果封闭集 `['allowed-once','rejected','cancelled','unavailable']`（`allowed-once` 是唯一授权）。写入审计事件 `approval/asked` / `approval/decided` / `approval/policy`，且必须在一个打开的 turn 内。还会往动态上下文里放一句策略说明（order 115）：`"Approval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed."` 或（never 时）`"Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set sandbox_permissions)."`
- `dsh-permission-presets` — 服务名 `permissionPresets`，`static inject = ["shell","approval","sessions","sessionProjections"]`。预设表把**沙箱模式 + 审批策略**打成一个包：`read-only: {sandbox: read-only, approval: ask}`、`workspace-write: {…, ask}`、`danger-full-access: {…, never}`（`read-only` 是本部署加的）；`CUSTOM_PRESET = "custom"` 为保留的"不匹配任何预设"状态。写路径是 `permission/preset` 事件 + 各自 knob 事件；读路径是 `permissions` 会话投影；人类入口是 `/permission <preset>`。
- **为什么重要**：把两个必须协同的安全旋钮收成**一个可重放的用户选择**，避免"沙箱松了但审批还开着"或反之的错配。
- `dsh-sandbox-policy` — 服务名 `sandboxPolicy`。`Config = { mode: 'read-only'|'workspace-write'|'danger-full-access', workspaceRoot }`（本部署 `mode = DSH_PERMISSION_MODE ?? 'workspace-write'`，`workspaceRoot = process.cwd()`）。解析优先级 = 已批准的显式模式 → 会话 `sandbox/mode` 折叠 → 部署默认；`setSandboxMode` 恰好追加一条 `sandbox/mode`；往上下文注入一行（order 110）例如 `Current DSH file policy: workspace-write. …may modify files under the session workspace: "D:\\anycode".`。真正的执行在 `dsh-fs-sandbox`（服务 `ctx.fs`，只拦 `writeText`/`editText`，拒绝码 `FS_SANDBOX_DENIED`）与 `dsh-pwsh-sandbox`（服务 `ctx.shell`，非 full-access 时走 `ctx.sandbox.confine(...)`）。
- **为什么重要**：模式必须**只有一个所有者**，否则 shell 写入与文件写入会各按各的理解放行；同时模式得进上下文，模型才知道边界在哪。

**压缩**
- `dsh-compaction-basic` — 服务名 `compaction`（实现 `dsh-compaction` 定义的接缝）。`static inject = ["llm","tokenMeter","sessions"]`。默认 `thresholdRatio = 0.8`、`retainRatio = 0.16`、`compactionRetries = 1`；校验 `retainRatio < thresholdRatio`，且 `retainRatio`/`retainTokens` 互斥。挂 `agent/pre-step`、`agent/status`、`session/event`、`agent/request-error`；溢出（overflow）绕过阈值直接触发；子类唯一可覆写点是 `summarize()`。用一段摘要检查点替换历史区间。
- `dsh-compaction-tool-result-pruner` — 服务名 `toolResultPruner`，`static inject = ["tokenMeter"]`。`Config = { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }`；超预算的 `tool/result` 先追加一条 `compaction/prune` 影子计价事件，再把内容替换成 head + `"\n\n[... tool result middle pruned ...]\n\n"` + tail，并用 `surfaceOp {op:"replace"}` 改写。
- **为什么重要**：两层分工——**便宜的确定性裁剪先跑**（保留头尾，绝大多数工具输出中间部分是无用噪声），昂贵的 LLM 摘要只在真正逼近上下文窗口时触发。

**会话标题 / 计量 / 时间**
- `dsh-session-title` — 服务名 `sessionTitle`。真正生成标题的策略是可插拔 provider（`ctx.sessionTitle.register({id, automatic: 'first-prompt'|'all-prompts', generate})`）。本部署值 `fallbackMaxWords: 5`、`fallbackMaxBytes: 40`、`maxTitleBytes: 80`；无 LLM 时用首条用户消息截断兜底，有 LLM 时由 `dsh-session-title-first-prompt-llm`（`targetWords: 5`、`targetCjkCharacters: 10`、`maxInputBytes: 4096`、`maxOutputTokens: 64`、`timeoutMs: 60000`）升级。标题作为 `session/title` 事件落日志，投影读最后一条。
- `dsh-token-meter` — 服务名 `tokenMeter`。`ctx.on("session/event")` 折叠用量：provider 上报的 `usage` 不小于估算时就锚定真实值，否则保持 `{kind:"estimated"}`；启发式 `CHARS_PER_TOKEN = 4`、`BLOCK_OVERHEAD = 4`，提供 `estimateMessage` / `estimateToolsTokens` / `estimateContent`。
- **为什么重要**：压缩、裁剪、成本显示全都需要同一个"无 tokenizer 依赖、可重放"的 token 价格函数；它必须只有一个实现。
- `dsh-time-context` — `name = "time-context"`，`inject = ["agents","sessionProjections"]`，`Config = { timeZone, refreshIntervalMs }`（**无代码默认值，base 未挂，opt-in**）。挂 `agent/pre-step`（`{prepend:true}`），注入一条带 `source {kind:"plugin", plugin:"time-context", form:"snapshot"}` 的**持久 user 消息**：`"Time sampled while preparing turn N, step M: 2026-01-01T09:00:00+09:00[Asia/Tokyo] … Elapsed since the preceding <model-visible message|step context>: 3m 12s."`；`refreshIntervalMs > 0` 时对重复发布去抖。
- **为什么重要**：模型自己猜不出今天的日期和"距上一步过了多久"，而这两件事决定了它会不会去跑一个必然过期的缓存/构建。

**指令与系统提示词**
- `dsh-agent-instructions` — `name = "agent-instructions"`，`inject = ["sessionProjections"]`。`Config`：`projectRootMarkers: [".git"]`、**`maxBytes` 必填（本部署 65536）**、`maxSourceBytes: 1048576`、`instructionFileCandidates: ["AGENTS.md","CLAUDE.md"]`、`localInstructionFileCandidates: ["AGENTS.local.md","CLAUDE.local.md"]`、`dshHome`。作用域 = `$DSH_HOME/AGENTS.md`（用户全局）+ 从项目根到 cwd 的每一级祖先目录；同目录下按候选顺序取全部存在项，内容 trim 后 SHA-1 去重。**以 user 消息交付而不是改写 system prompt**：首轮给 baseline，之后 `tools/result` 里被模型碰过的文件触发增量（`"Updated instructions from: <path>"` / `"Instructions removed: <path>"`），全部包在 `<system-reminder>` 里。
- **为什么重要**：项目约定文件的字节预算是硬约束，且"改了 AGENTS.md 要立刻生效"只能靠增量重发而不是重写系统提示词（后者会打掉 KV cache）。
- `dsh-system-prompt` — 服务名 `systemPrompt`。`Config = { includeHarnessIdentity: true, includeRuntimeContext: true, personaPrefix: "", personaSuffix: "", toolOrder }`。API：`section({name,order,text,complete?})`、`context({name,order,text})`、`tools(provider)`、`variable(name, provider)`、`getSectionOrder/getContextOrder`、`assemble(context)`（内部走 `system-prompt/assemble` 专家瀑布）。内置 section `harness:identity`（-1000）、`deployment:persona-prefix`（0）、`deployment:persona-suffix`（10200）；中心的 order 表让所有插件无需互相知道就能排好顺序。运行时上下文快照前导句：`"Current runtime context. This snapshot supersedes earlier runtime-context snapshots."`
- **为什么重要**：这是把"系统提示词"从字符串拼接升级为**带编号槽位的注册表**——多插件协作时顺序不再靠运气；且 `complete: true` 语义（某 section 直接当整份提示词）让"替换整个人格"成为一个受控操作。

**目标轮次驱动**
- `dsh-goal-round-driver` — `name = "goal-round-driver"`，`inject = ["agents","goals","sessions"]`。只在**静默点**驱动（`ctx.fiber.state === 2`、`agent.status === "idle"`、没有竞争性排队 prompt），每轮前后 `ctx.sessions.flush()`，最多只保留一轮，向 inbox 追加 `agent.followup(createUserMessage({text: "<goal_round>\nObjective: …\nRound: n/maxGoalRounds…" , source:{kind:"goal"}}))`；到上限调 `ctx.goals.block(...)`，失败/取消则 disarm。
- **为什么重要**：把"持久目标"变成**自动续跑**，且带轮次上限与竞态围栏——自动续跑最容易出的 bug 是重入和无限循环，这里两样都显式处理了。

**计划模式**
- `dsh-plan-mode` — 服务名 `planMode`，`static inject = ["tools","systemPrompt","sessionProjections"]`。`Config = { section }`（必填，本部署把整段 plan-mode 规则写在这里）。实现方式很轻：`ctx.systemPrompt.section({name:'plan:policy', order: 500, text: active ? section : ""})` —— **工具目录在两种模式间保持完全一致**（注释写明是为了请求缓存稳定），差别只在提示词与 `exit_plan_mode` 的调用。注册工具 `exit_plan_mode(plan)`，校验计划以 `# ` 开头，通过 `ctx.get("userQuestions").ask({header:'Plan review', question:'Approve this plan and leave plan mode?'})` 走审批，人类入口 `/plan [off|message]`。
- **为什么重要**：如果按模式增删工具，每一次模式切换都会让请求前缀失效（KV cache 全废）。"改提示词不改工具表"是很值钱的一条经验。

**技能系统**（详见第 4 节）
- `dsh-skill`（服务 `skills`，`collectCacheMaxEntries: 128`）；`dsh-skill-filesystem`（`name = "skill-filesystem"`，`inject = ["skills"]`）；`dsh-tool-skill`（`name = "tool-skill"`，`inject = ["agents","tools","skills"]`，`catalogDescriptionMaxLength: 500`）；`dsh-skill-badge`（`disabled: true`）。

**外部钩子（Claude Code / Codex 兼容）**
- `dsh-hook-protocol` — 纯库（无 `name`/`inject`/`apply`）。`DEFAULT_HOOK_TIMEOUT_MS = 600000`、`DEFAULT_STDERR_SUMMARY_MAX_CHARS = 500`、`BLOCKING_EXIT_CODE = 2`；合并优先级 `deny|block > ask > approve|allow` → `"deny"|"ask"|"allow"|"none"`；识别 `decision` / `hookSpecificOutput.permissionDecision` / `continue:false`（粘性 stop）/ `additionalContext` / `updatedInput`。
- `dsh-hooks-claude-code` — `name = "hooks-claude-code"`，`inject = ["shell","sessionProjections"]`。`Config`：`configPath` **必填**、`pluginRoot`、`projectDir`、`defaultTimeoutMs: 600000`、`stderrSummaryMaxChars: 500`。支持事件 `SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / SubagentStart / SubagentStop`，替换 `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}`，注册与结果落 `hook/invoked` / `hook/result` 审计事件。`PreToolUse` 可直接 deny 工具调用。
- `dsh-hooks-codex` — `name = "hooks-codex"`，同构五事件（无 subagent 事件），`dialect: "codex"`。
- **为什么重要**：这是"白嫖生态"的最高杠杆点——已有的社区钩子脚本（格式化、lint、禁改文件、危险命令拦截）零成本接入。注意它只依赖 `ctx.shell`，实现成本极低。

**Webhook**
- `dsh-webhook` — 服务名 `webhookRuntime`。规则是**可信代码** `run(delivery, signal) => WebhookSessionRequest | null`，唯一下游动作是"创建并 prompt 一个根会话"（`workspacePath` + `title` + `prompt` + `agentPreset` + `permissionPreset` + 可选 model）。
- `dsh-webhook-github` — `name = "webhook-github"`，`inject = ["webServer","webhookRuntime","credentials"]`。只接受 `POST` + `application/json`，验 `x-hub-signature-256`（HMAC），返回 `202`/`400`/`401 invalid webhook signature`/`503 webhook runtime is unavailable`。
- **为什么重要**：把"外部事件 → 起一个 agent 会话"做成一条最短链路，是"无人值守 agent"最实用的入口。

**定时**
- `dsh-schedule` — `name = "schedule"`，`inject = ["agents","sessions","tools","sessionPersistence"]`。工具 `schedule_create` / `schedule_list` / `schedule_delete`；种类只有 `after`（`after_seconds`）、`at`（RFC 3339 或 `{date,time,time_zone}`）、`every`（`every_seconds`，下限 `MIN_EVERY_INTERVAL_SECONDS = 300`）——**不支持 cron 表达式**；`MAX_TIMER_DELAY_MS = 2147483647`。到期在 `agent.runMaintenance` 内以 `agent.followup(createUserMessage({source:{kind:'plugin', plugin:'schedule'}}))` 唤醒，标题 `[SCHEDULE REMINDER]` / `[SCHEDULE REMINDER BATCH]`。状态靠持久 `schedule/change` 事件重建，重启不丢。**无 Config**，base 未挂。
- **为什么重要**：让 agent 能自己排"等 10 分钟再看构建结果"这类任务，而不用把整个 process 挂着。

**HTTP 代理**
- `dsh-http-proxy` — 不是 cordis 插件，是启动器调用的库（`installProxyFromEnvironment(env, log)`，见 `dsh/lib/profile-boot-Dk-7KqJc.js:280`）。读 `http_proxy`/`HTTP_PROXY`、`https_proxy`/`HTTPS_PROXY`、`no_proxy`/`NO_PROXY`（`all_proxy`/`ALL_PROXY` 只读），给子进程设 `NODE_USE_ENV_PROXY: "1"`，硬编码 `LOOPBACK_NO_PROXY = ["localhost","127.0.0.1","::1","[::1]"]`，只支持 `http:`/`https:`（socks 系列显式拒绝），用 undici 的 `setGlobalDispatcher` 生效。
- **为什么重要**：`fetch`、Node 自身、被 spawn 的子进程必须是**同一个**代理答案，否则会出现"主进程能联网、工具子进程不能"这类极难查的问题。往返本机永远绕过代理。

---

## 4. 技能系统：发现路径、优先级、frontmatter、如何进入上下文

### 4.1 三个包的职责分离

- `dsh-skill` — 只做**注册表**（服务名 `skills`，`class SkillRegistry extends Service`，`Config = { collectCacheMaxEntries: 128 }`）。管"多来源合并、同名消解、按需加载"，不管技能从哪来。暴露 `registerProvider(create)`、`register(skill)`、`list(options)`、`snapshot(options)`、`get(name, options)`，并在变更时 emit `skills/change`。名字语法 `SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/`。排序常数 `RUNTIME_RANK = 250`、`BUNDLED_SKILL_RANK = 600`。
- `dsh-skill-filesystem` — **本地目录 provider**（`name = "skill-filesystem"`，`inject = ["skills"]`）。
- `dsh-tool-skill` — **模型侧**（`name = "tool-skill"`，`inject = ["agents","tools","skills"]`），注册 `skill` 工具 + 目录注入。

### 4.2 搜索路径与优先级（精确，来自 `dsh-skill-filesystem/lib/index.js:150-188` 的 `roots()`）

按 rank 升序，**低 rank 先赢**（同名技能在 rank 更小的根里胜出）：

| rank | source 值 | 路径 |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs[]`（默认 `[]`） |
| 400 | `user-dsh` | `<dshHome>/skills`（跳过其中的 `.system` 子目录） |
| 500 | `user-agents` | `<agentsHome>/skills` |
| 600 | `bundled` | `Config.bundledSkillDir ?? $DSH_BUNDLED_SKILL_DIR`（仅当 `includeDefaultRoots`） |

- `dshHome` 解析顺序：`Config.dshHome` → `$DSH_HOME` → `~/.dsh`。
- `agentsHome` 解析顺序：`Config.agentsHome` → `$DSH_AGENTS_HOME` → `os.homedir()/.agents`。
- `projectRoot`：从 session cwd 向上找最近一个含 `.git` 的祖先目录（`Config.projectRootMarkers` 默认 `[".git"]`），找不到则用 cwd 本身。
- 「项目根 → project 根到 cwd 的各级祖先」都在扫描范围内。
- 目录内布局只认两种，且**只认一层深度**：目录束 `<root>/<name>/SKILL.md`，或平铺 `<root>/<name>.md`。**嵌套的 `**/SKILL.md` 故意不发现**（源码注释明确）。
- watcher：chokidar `depth: 1`，事件 `add/addDir/change/unlink/unlinkDir`，相关性过滤（深度 1 认 `*.md`，深度 2 认 `SKILL.md`）；`watch: true`、`watchUsePolling: false`、`watchStabilityThresholdMs: 200`、`watchPollIntervalMs: 100`、`watchMaxProjects: 128`、`watchFollowSymlinks: true`。另外 `ctx.on("fs/observed", …)` 在模型 `edit`/`write` 后主动失效缓存。
- **`use_skill` / `list_skills` 这两个名字在整个 bundle 集合里不存在**（grep 0 命中）。工具名就是 `skill`。`.claude/skills` 也不存在。

### 4.3 frontmatter 支持的字段

YAML frontmatter 包在 `---` 之间：

| 字段 | 必需 | 说明 |
|---|---|---|
| `name` | ✅ | 必须匹配 kebab-case 语法 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`，否则整份文件被跳过 |
| `description` | ✅ | 非空字符串；进目录摘要，渲染时按 `catalogDescriptionMaxLength`（默认 **500**）归一化+截断 |
| `whenToUse` | — | 字符串，额外路由提示（进 `SkillSummary.whenToUse`，不直接进模型可见的目录行） |
| `metadata` | — | 任意 object，作为 `SkillDefinition.metadata` 透出 |
| `disable-model-invocation` | — | 布尔（接受 `true/false|yes/no|on/off|1/0`）；`true` ⇒ `modelInvocable: false` |
| `user-invocable` | — | 布尔；`false` ⇒ `userInvocable: false`（默认 `true`） |

- 旧字段名**会硬报错而不是静默忽略**：`frontmatter field "disableModelInvocation" is unsupported; use "disable-model-invocation"`（`modelInvocable` → `disable-model-invocation`，`userInvocable` → `user-invocable` 同理）。
- 任何无效 frontmatter / 缺 name 或 description / 名字不合语法 ⇒ **整条文件被丢弃**并 `ctx.logger.warn("skill file <path> ignored: …")`。
- **没有单技能字节上限，也没有技能数量上限**（全库 grep：只有 `watchMaxProjects: 128` 和 `collectCacheMaxEntries: 128` 两个 128；`maxSourceBytes` 属于 agent-instructions 不属于技能）。

### 4.4 目录如何进入上下文（关键：不是系统提示词）

`dsh-tool-skill` 挂 `ctx.on("agent/pre-step", …)`，在每一步请求前把目录作为一条**持久 user 消息**追加（不是 system prompt section，不是 tool schema）：

```
<system-reminder>
A skill is a reusable set of task-specific instructions. The following skills are available in this session:

<available_skills>
- `skill-name`: 描述文本
...
</available_skills>

If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.
</system-reminder>
```

- 消息带 `source {kind: "skill-catalog", form: "catalog", entries: [{name, description}]}` —— **记录条目本身**，消费方（UI）不需要去解析给模型看的伪 XML。
- **摘要去重**：对 `entries` 取 `sha256(entries.map(e => JSON.stringify([e.name, e.description])).join("\n"))`；digest 未变则完全不重新发布（消息保持原位）。变了就把同一条消息替换成"替换型目录"：`"The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:"`；目录清空则撤回该消息。
- 只有 `isModelInvocable(skill)` 为真的技能进目录。且仅当 `ctx.tools.get("skill", agent) === skillTool` 时才发布——**工具被限制/被同名遮蔽时，目录与调用指引一起消失**（可见性与谓词严格对齐，不会出现"目录里有但调不到"）。

### 4.5 渐进式披露（progressive disclosure）

1. 常驻上下文里只有**名字 + 截断描述**（目录），成本按技能数线性但极小。
2. 模型调 `skill(name)`：`parameters = { name: { type:"string", required:true } }`。执行时先 `ctx.skills.list(lookup)` 校验该名字在**当前 cwd/scope 的胜出集合**里，再 `ctx.skills.get(name, lookup)`。
3. provider 的 `get()` **每次都重新读文件**（`parseSkillFile`），所以改了 `SKILL.md` 不需要任何缓存失效逻辑。文件消失则返回 `undefined`，工具报 `skill "<n>" is unknown or no longer available`；不可模型调用则报 `skill "<n>" is not available for model invocation`。
4. 正文用统一包装渲染（`renderSkillContent`，`<skill_content name="…">` → `<skill_resources>` → `<skill_instructions>`），并附带资源基址指令：`"Base directory for this skill: <dir>"` + `"Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed."` —— 技能可以引用同目录的脚本/模板，**按需再读**，不塞进正文。
5. 人类侧：直接用户文本里扫 `/name`（`SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g`），命中的 `userInvocable` 技能以 `source {kind:"skill-invocation", name, form:"instructions"}` 注入，提示模型"不要为它再调一次 `skill` 工具"。

---

## 5. 推荐短名单（按对 ensoul 的价值排序）

ensoul 现状假设：已有文件读写/列目录/搜索、`run_command`（带 timeout）、构建/启动/停止项目管理、技能（`SKILL.md` + `use_skill`，仅 app 目录）、插件（只有 `addTool` + `onBeforeWrite`）、可停靠多面板 UI 与聊天面板、每窗口模型配置。

排序原则：**先补"不改架构就能接、且失败会导致 agent 变傻或失控"的洞**，再补"能显著扩大能力面"的。

| # | 能力 | 买到了什么 | Node/Electron 原生实现成本 |
|---|---|---|---|
| 1 | **大输出落盘（spill）** | 一次 `npm install`/`pytest` 的 3 万行输出不会把上下文预算吃光。做法：超过 `maxInlineBytes`（DSH 用 50000）就把完整文本写进会话临时目录，上下文只留 head/tail + 路径 + 一句「用 read/grep 拿全文」。**绝不能把成功改成错误**。 | **小**。一个 `spillDir` + 一个在工具结果回写前的变换函数；`read`/`grep` 已有，无需新工具。 |
| 2 | **循环层统一工具超时** | ensoul 的 `run_command` 有 timeout，但**任何**工具（网络、MCP、子代理）都可能挂死。补一个包装所有 tool 调用的 `Promise.race` + 结构化 `TOOL_TIMEOUT` 结果，让循环永远能继续。 | **小**。一个 dispatch 包装器 + 每个工具可选的 `timeoutMs` 字段（默认值给 30s，长任务工具显式覆盖）。 |
| 3 | **技能发现扩展 + 目录去重注入 + 渐进披露修正** | 现在只有 app 目录且工具名是 `use_skill`。三件事：① 增加**项目级** `./.dsh/skills` 与 `./.agents/skills`（ensoul 可自定义，但仍建议支持 `.dsh/skills` 以复用生态），rank 低者优先覆盖同名；② 目录消息按 `sha256([name,description])` 去重，**只在变化时重发**（否则每步都塞一遍，纯浪费）；③ 正文每次读取即时读文件，并附「Base directory for this skill: <dir>」让技能可以引用同目录脚本按需再读。frontmatter 至少支持 `name` / `description` / `whenToUse` / `disable-model-invocation` / `user-invocable`。 | **小到中**。路径解析与 rank 表约 60 行；digest 去重约 30 行；主要工作量在把目录从 system prompt 挪到「可替换的持久上下文消息」（若 ensoul 现在把目录拼进 system prompt，注意这会破坏 prompt cache）。 |
| 4 | **`AGENTS.md` / `CLAUDE.md` 工作区指令 + 增量热更新** | 用户已有的项目约定文件（`AGENTS.md`、`CLAUDE.md`、`AGENTS.local.md`、`CLAUDE.local.md`）零成本生效，且模型写文件后**立即**看到更新（DSH 是 hook 到 `tools/result`，改动文件就发增量：`Updated instructions from: <path>` / `Instructions removed: <path>`）。字节预算：DSH 单批 65536、单文件 1MB。 | **中**。发现逻辑（从 `.git` 祖先链逐级往下收集 + trim 后去重）约 80 行；难点是接入写文件后的增量重建与「替换式 baseline」语义。 |
| 5 | **权限预设（沙箱模式 + 审批策略打包成一个旋钮）** | ensoul 目前只有 `onBeforeWrite`。DSH 证明正确的抽象是**两个独立底层旋钮 + 一个用户可见的预设**：`read-only` / `workspace-write` / `danger-full-access`，每个预设同时定 `sandbox mode` 和 `approval policy`（`ask`/`never`），并作为**会话事件**落盘以便重放。同时把当前模式注入上下文（`Current DSH file policy: workspace-write. …may modify files under the session workspace: "<root>".`），模型才不会越界尝试。 | **中**。两个 knob 的读/写约 100 行；预设表 + `/permission` 命令约 60 行。真正的工作量在把现有的 `onBeforeWrite` 拆成「模式判定」与「审批询问」两层，并让 `run_command` 走同一套判定。 |
| 6 | **`todo_write` 任务清单** | 多步任务的可观测进度 + 大幅减少模型跑偏。关键设计：**每次传整份列表、整体替换**（不是增量 patch），item 只有 `{content, status: pending\|in_progress\|completed}`，允许并行 `in_progress`。 | **小**。一个工具 + 一个面板的渲染，约 100 行。直接接进已有可停靠面板，收益/成本比极高。 |
| 7 | **Web 工具：`web_search` + `web_fetch`** | 从"只能看本地"变成"能查文档/查报错"。DSH 的取舍值得抄：`web_fetch` 只允许**公网 HTTP(S)**（拒绝内网/环回地址，防止 agent 被诱导去打本机服务），结果解码为文本并设上限（`fetchMaxOutputChars: 200000`）；两者都声明 `timeoutMs` 且 `isConcurrencySafe: true`（可并行）。搜索侧 `searchMaxQueries: 4`。 | **中**。fetch + HTML 转文本 + 公网地址校验约 150 行；搜索需要一个 provider（自建需 key，或用 `DuckDuckGo`/SearxNG 之类），provider 抽象与降级约 100 行。**公网校验那一步不要省**。 |
| 8 | **子代理委派（后台 + 续跑）** | 把"探索/调研/并行改造"丢给子代理，主对话上下文不被污染。DSH 的两条形态都值得抄：`spawn`（自包含任务）与 `fork`（继承当前会话历史，请求前缀可复用 KV cache），以及 `run_in_background` 默认开、完成后**主动通知**父会话、`send_message` 可在运行中转向、`list_agents` 可回查。 | **大**。约 400-600 行：子会话生命周期、后台作业注册表、完成通知注入父会话、运行中转向。但 ensoul 已有多面板 UI，天然适合"每个子代理一个面板"。**建议只做 `spawn` 一种形态**，`fork` 的 KV cache 收益在 Electron 单机上不值得复杂度。 |
| 9 | **上下文压缩：两级（先确定性裁剪，再 LLM 摘要）** | 长会话必然撞窗口。DSH 的顺序很关键：`tool-result-pruner`（`thresholdChars: 8192` → 保留 `headChars: 4096` + `[... tool result middle pruned ...]` + `tailChars: 1024`，**先跑且完全不花 token**）→ 超阈值才走 `compaction-basic` 的 LLM 摘要（`thresholdRatio: 0.8`、`retainRatio: 0.16`）。摘要必须落成可重放的检查点事件，且注意 tool_call/tool_result 配对不能被打断（DSH 有 `toolPairingBalancedBefore/After` 校验）。 | **大**。裁剪部分 **小**（约 80 行，建议立刻做）；LLM 摘要部分 **大**（约 300 行，阈值/保留策略/配对完整性/失败重试）。**建议分两步上：先只做裁剪。** |
| 10 | **工具调用管线钩子（`onBeforeToolCall` / `onAfterToolCall`）** | ensoul 现在只有 `onBeforeWrite`。DSH 的 `tools/pre-execute` / `tools/execute` / `tools/post-execute` 三段瀑布（allow/deny/ask → 环绕包装 → 改写结果）是上面第 1、2、5、9 项**共同的挂载点**。没有这个，每一项都要单独侵入工具实现。顺带能白嫖：重复调用提醒（第 3/5/8 次同一工具同一参数时追加一条建议式提醒）。 | **小到中**。约 120 行：把工具 dispatch 收敛到一个函数，前后各开一组有序 listener（返回值可接管 / `next()` 委派）。**强烈建议在第 1、2 项之前先做这一项**，否则会写三遍重复代码。 |

**明确不建议现在做的**（成本高、对单机 Electron 编辑器的边际收益低）：`dsh-tool-cordis` 式运行时代码自修改插件（需要一整套动态加载与沙箱）；`dsh-tool-workflow` 的规模编排（子代理都没做好之前无意义）；MCP 客户端（生态价值高但与本机插件库已在做的事情重叠，且 ensoul 目前连多服务生命周期都没有）；`dsh-webhook` / `dsh-schedule`（对外部触发器才有价值）。

**两条最容易踩的坑（DSH 已经替我们踩过）**：

1. **不要把会变的东西拼进 system prompt**。技能目录、AGENTS.md 增量、审批策略、沙箱模式、当前时间——DSH **全部**用「可替换的持久上下文消息」（`source {kind, form}` 标记，同 id 就地替换）而不是 system prompt section。理由源码里写得很直白：改 system prompt 前缀会让 KV cache 全部失效。ensoul 若现在把技能目录拼进 system prompt，应优先改掉。
2. **只增提示词、不增删工具表**。`dsh-plan-mode` 注释明确写了"工具目录在模式间保持一致是为了请求缓存稳定"，模式差异只体现在提示词与 `exit_plan_mode` 的调用上。同理，切换模式/技能/权限都应该是**消息级**变化而非 tool schema 级变化。

---

## 附：本报告的一手证据位置

- 插件形态与 `defineTool`：`...\dsh-tools\lib\index.js:837-883`、`...\dsh-tools\lib\types\index.d.ts:24-94`
- 最小真实插件：`C:\Users\KATU\.dsh\profiles\web\vendor\dsh-web-restart\lib\index.js`
- 服务基类与依赖注入：`...\cordis\src\service.ts`、`...\cordis\lib\types\{context,registry}.d.ts`
- 补丁层语义：`...\dsh-app-boot\lib\index.js:59-107`；层序：`...\dsh\lib\profile-boot-Dk-7KqJc.js:213-257`、`...\dsh\README.md:34-49`
- 全部行的真实配置值：`...\dsh-base\cordis.patch.yml`（487 行）、`...\dsh-web-app\cordis.patch.yml`（484 行）
- 客户端模块：`...\dsh-client-modules\lib\index.js:66-151,434-489`；声明示例：本机 `dsh-image-gen\package.json` 的 `dsh.client`
- 技能三包：`...\dsh-skill\lib\types\index.d.ts`、`...\dsh-skill-filesystem\lib\index.js:150-188,664-704`、`...\dsh-tool-skill\lib\index.js:56-236`
- 本机插件实例：`C:\Users\KATU\.dsh\profiles\web\{cordis.patch.yml, package.json, vendor\*, node_modules\dsh-wechat}`

