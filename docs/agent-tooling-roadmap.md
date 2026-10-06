# Agent 定位能力与工具开发路线

2026-10-06。依据当前工作区源码、隔离的最小复现和工具官方资料。本文交付调查与开发清单；下面的新工具接口均为建议，不代表已经注册或可调用。未修改现有运行时代码，未构建或重启。

本文保留为修复前的调查快照。后续已修复的问题、状态迁移与验证结果见 [agent-tooling-fixes.md](agent-tooling-fixes.md)；下面的源码行号对应调查时版本。

## 1. 判断与证据

ensoul 的问题同时出在检索证据、上下文保留和开发工具的表达能力。已有插件、PTC、后台命令、取消链和持久任务可以继续使用。优先把证据做准、让每次检查回答一个具体问题，再增加工具覆盖面。

本次未回放真实模型排查任务，因此没有测得各原因在实际慢任务中的占比，也没有可承诺的提速或成功率百分比。

### 已复现或能直接确定的缺陷

| 问题 | 当前证据 | 对定位的影响 |
|---|---|---|
| LF 文件的 grep 结果失真 | `src/main/agent.ts:679` 使用 `text.split('\r\n')`，`:683` 截取匹配行前 200 字 | LF 文件变成一整行，命中深处却显示文件开头；行号和相关片段都可能错误 |
| 命令输出先截断再落盘 | `src/main/agent.ts:469` 将输出及退出码整体截到 20,000 字，`:969` 才进入输出落盘流程 | 大输出尾部的报错和非零退出码可能永久丢失 |
| AGENTS.md 一次注入后不再可见 | `plugins/agents-md/index.js:103` 指纹未变就返回空；`src/main/index.ts:3009` 保存原始正文，`:3118` 只往当轮请求加说明，`:3258` 回放原始历史 | 第二轮请求可能不再包含工作区规范，模型后续偏离规则有明确机制原因 |
| 热会话提示更新也只发一次 | `src/main/prompt-composer.ts:87` 保留旧系统提示，`:111` 消费增量；`index.ts:3127` 只加入当轮正文 | 新规则在下一轮可能消失，直到压缩或清理时固化 |
| doctor 草稿无法完成 setup | `plugins/doctor/index.js:575` 调用 `api.workspace()`，宿主 `src/main/plugins.ts:583` 声明其为字符串 | 目前不能把这份未提交草稿当作已生效的诊断能力 |

最小复现：实际 LF 文件 `src/shared/panel-avatars.ts` 有 194 个 LF、0 个 CRLF。搜索 `mcp: 'research'`，当前算法返回第 1 行的文件头注释，片段不含搜索符号；正确分行返回第 70 行的实际命中。

另两项使用不加载真实宿主、不写文件的 Node mock：agents-md 首次注入 2211 字符，第二次为 0；doctor 传入符合宿主契约的 workspace 字符串后抛出 `api.workspace is not a function`。它们验证局部机制，不等于完整 Electron 端到端验收。

### 会增加空转的设计缺口

- 文本检索按固定目录排除，缺少标准 ignore 语义和符号关系。超出匹配数、深度或文件大小限制时，结果不总能明确表达检索不完整。见 `src/main/agent.ts:635–696`。
- `read_file` 默认 2000 行，找一个函数容易读取大量旁支。见 `src/main/agent.ts:1005`。
- 工具历史结果仅保留头 800 / 尾 400 字；自动摘要输入只拼消息正文，不包含 assistant 上的 `toolCalls`。中间命中和已排除证据可能丢失。见 `src/main/index.ts:3342`、`:3200`。
- 当前 PTC 的 SDK 包含本面板全部可用工具，返回类型统一为 `Promise<any>`；没有完整的按需发现机制。缓存能降低部分计费，仍然占用上下文并增加选择噪声。见 `src/main/ptc.ts:63`、`src/main/index.ts:3234`。
- 单次 agent 排查期间不断追加消息，没有按证据进展整理上下文；自动压缩发生在下一轮发送前。见 `src/main/chat-core.ts:1099`、`src/main/index.ts:3166`。
- loop-guard 只提醒连续同参数重复，A → B → A 可以漏过；read-guard 只记路径，不记读区间和文件版本。见 `plugins/loop-guard/index.js:39`、`plugins/read-guard/index.js:29`。
- PTC 子工具通过队列串行执行。模型写 Promise.all 并不让独立搜索并行。它目前有保护写入顺序的作用，后续需要按工具副作用分类再开放并行。见 `src/main/ptc.ts:175`。

### 与 CLI 的实际差距

已有 `run_command`，也有 jobs 的后台进程、增量输出和等待。因此无需再造一套基础命令执行器。当前缺的是可指定 cwd 的交互进程会话、stdin/PTY、可靠终态和结构化输出，以及 rg、语言服务等成熟开发工具的直接接入。`job_start` 当前主要参数为 command / label；参见 `plugins/jobs/index.js:115`。

图形界面的优势应体现在现场错误、任务证据、代码位置和验证结果可关联。否则窗口只是展示层，模型仍在用弱化的文本命令猜测。

## 2. 值得开发的插件与工具范式

| 优先级 / 插件 | 首版工具建议 | 解决什么 | 落点与可行性判断 |
|---|---|---|---|
| P1 `code-intelligence` | `code_search`、`read_spans`、`symbol_outline`、`symbol_definition`、`symbol_references` | 精确找命中、定义与调用方，按符号读取 | 先封装 `rg --json`，复用现有 TypeScript language service；插件可做。实现把握高，复杂动态调用仍需文本检索 |
| P1 `runtime-probe` | `runtime_errors`、`runtime_snapshot`、`runtime_trace` | 从真实报错、IPC 和操作现场追代码 | 插件负责过滤与聚合；renderer/main 诊断源需要通用宿主入口。插件日志可先接入；完整跨进程关联可行性中 |
| P1 `investigation-ledger` | `investigation_open`、`evidence_record`、`investigation_status` | 保存已确认、已排除和下一项检查，减少跨轮重找 | 现有 hooks、state、addSummaryNote 足以做首版；长期规则注入先修。实现把握高 |
| P2 扩展 `jobs` | `process_start`、`process_read`、`process_input`、`process_wait`、`process_stop` | 编译 watch、调试服务和交互 CLI 能连续使用 | 扩展现有插件，补 cwd / cursor / 终态；PTY 单列后续批次。非交互首版把握高，PTY 中 |
| P2 `verification` | `verification_plan`、`verify_change`、`verification_status` | 按实际改动选择检查，交付可追溯的验证结果 | 复用 git diff 和 buildProject；记录源码版本、检查范围、退出码、产物引用。实现把握高，验证选择收益需实测 |
| P2 `repo-map` / 结构搜索 | `repo_map`、`structural_search` | 自然语言任务给入口地图，跨文件找代码结构 | 地图限定预算；结构搜索用 ast-grep。插件可做，排序命中率需调优 |
| P3 `mcp-bridge` + 工具目录 | `tool_find`、按需描述及受权调用 | 引入外部成熟工具，同时控制每轮上下文规模 | MCP 连接生命周期可做插件；动态目录、授权调用和 PTC 集合更新需要核心薄接口。接入把握中，收益需基准验证 |

这些名称是候选接口，开发时应沿用已有相近接口，避免产生两套作用相同的工具。

### 一手资料与借鉴边界

- [Serena](https://github.com/oraios/serena)：借鉴 LSP 的定义、引用和符号导航；ensoul 的 TS/JS 首版也可以直接使用 TypeScript language service。字符串注册、IPC channel 等动态关系不能只依靠 LSP。
- [ast-grep JS API](https://ast-grep.github.io/guide/api-usage/js-api.html)：按语法结构匹配，比字符串搜索更适合找不同排版的函数调用。它不提供完整的符号语义关系。
- [Aider repo map](https://aider.chat/docs/repomap.html)：用预算约束地图，把相关文件和重要符号先给模型。地图是导航线索，命中后仍读源码；不把全项目地图永久塞进系统提示。
- [Playwright MCP](https://github.com/microsoft/playwright-mcp)：适合有状态的浏览器探索；官方也建议 coding agent 考虑 CLI + Skills 来控制工具与快照 token。[Electron 自动化](https://playwright.dev/docs/api/class-electron) 属于 experimental，不能把普通浏览器 MCP 接通等同于 ensoul 主进程可观测。
- [OpenAI Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)：先给能力概览，再按需要加载定义。API 支持与具体 provider / model 有关；ensoul 应实现自己的公共目录契约，再做供应商适配。
- [OpenAI Programmatic Tool Calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling)、[Anthropic PTC](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)：批量过滤和聚合在程序中完成，模型收到最后的相关证据。小量且依赖推理的操作不一定因此更省；ensoul 应扩展已有 PTC。

第三方工具首版开放只读查询。符号重命名和 AST rewrite 后续返回 edits、源文件版本与 diff，再通过 `api.files` 写入，保留文件租约与冲突检查。

语义检索放在找不到具体符号或入口时补充候选；已知报错、路径、函数名或 channel 时先精确搜索。不要把相似度当作已经证明的相关性。

## 3. 工具应怎样返回结果

一个工具调用应让模型知道：查到什么、证据在哪里、还有多少没看、下一步怎样展开。先让新插件返回 JSON 字符串；PTC 已尝试解析 JSON，不必为了首个插件立即改所有旧工具。

建议首版公共结果形状：

```ts
type EvidenceResult = {
  status: 'ok' | 'error' | 'cancelled' | 'unsupported';
  summary: string;
  data?: unknown;
  evidence?: Array<{
    path?: string;
    startLine?: number;
    endLine?: number;
    symbol?: string;
    sourceVersion?: string;
    artifactRef?: string;
  }>;
  totalMatches?: number;
  truncated?: boolean;
  truncationReason?: string;
  nextCursor?: string;
};
```

这仍是设计示意。需要跨进程共用时再放到 `src/shared/`，按插件需要收窄 data 类型；旧字符串工具保留适配，不做全库改写。

- 检索默认输出少量排名靠前的命中与上下文，保留总量、截断原因和展开方式。没有匹配与工具执行失败分别表达。
- 读取按符号或行段进行；全文输出是明确选择。已读区间带文件版本，文件变化后失效。
- 命令先保存完整 stdout/stderr，再生成短摘要。退出码、取消、超时为独立字段，不能藏在容易截断的尾巴里。
- 证据引用绑定实际观察的文件版本和 run/task；mtime 只能当线索，不能证明运行实例已经应用源码。
- 工具提供输入/输出 schema、典型调用和副作用属性。只读搜索才能缓存或并行；写入、构建、重启沿用现有协调器。

## 4. 排查工作的默认路径

```text
症状 / 报错 / 复现步骤
  → 取现场证据或具体符号
  → 查定义、写入点、读取点和直接调用方
  → 记当前假设及能区分假设的下一项检查
  → 局部修改
  → 按范围验证
  → 确认运行实例应用版本并交付证据
```

证据账本只保留症状、结论、排除项、假设、检查和引用，不保存模型思维链。记录“已排除”要给实际检查依据；工具日志不能自动替模型证明根因。两次检查无新证据时生成短检查点，调整查询或检查方式，不再泛化目录扫描。

doctor 可以成为这个路径的入口：规则返回候选入口、匹配理由、需要确认的证据。只有后续检查支持时才升级为结论；未命中时根据症状选检查，不统一先做完整构建。troubleshoot 应与 `docs/development.md` 的变更范围一致。

小改动默认一个执行者。只将独立证据源或互不重叠的模块并行；派单带已有证据、排除项、文件范围和交付格式。继承父任务范围后再收窄工具，避免每个 worker 重新从根目录调查。

## 5. 分批开发与验收

每项按独立任务交付，同一文件只有一个写作者，构建和应用更新由一个任务统一负责。

| 批次 | 复现与预期 | 修改范围 | 验收条件 |
|---|---|---|---|
| 0A 检索正确性 | 同一内容的 LF / CRLF 搜索均返回真实行号和命中；限制不能伪装完整 | `agent.ts` 的 grep 和相关结果提示 | LF / CRLF / 无命中 / 达到上限的隔离样例，实际命中片段和行号准确 |
| 0B 命令证据 | 超 20K 输出后尾部报错与非零退出码可恢复 | run_command 的捕获、落盘和摘要顺序 | 隔离命令产生大 stdout、尾部 stderr、非零退出；完整产物含尾部，摘要含终态 |
| 0C 指令持久性 | AGENTS 和热更新规则在后续请求持续生效 | 注入与历史组装契约、相关插件 | 捕获首轮、第二轮、规则修改后第二轮和压缩后请求；当前规则可见，过期规则被明确替代 |
| 0D doctor 接入 | 草稿正常注册，候选与已确认结论分开 | doctor / troubleshoot | 最小宿主契约测试、插件重挂、实际工具注册检查；无关输入不输出已确认根因 |
| 1 定位工具 | 给符号后快速得到定义、引用和必要代码段 | code-intelligence 插件 | 函数、类型、字符串 channel 等固定题；正确入口、忽略规则、截断和源版本可检查 |
| 2 现场与证据 | 操作失败后可从错误追入口；继续任务保留已查证据 | runtime-probe、investigation-ledger；需要时补诊断源 | 一个 renderer 错误和一个主进程错误可关联；跨轮/压缩仍能展开证据；文件变更后旧证据失效 |
| 3 执行与验证 | 长任务连续可控，改动只做适当检查 | jobs、verification | cwd / cursor / 退出码 / 取消可靠；文档、插件、renderer、main/shared 分别选对检查；未改源码不重复验证 |
| 4 按需扩展 | 目录增长后仍只加载相关工具；只读批量查询能实际并行 | 工具目录、MCP桥、PTC少量公共接口 | 未加载工具可发现，未授权工具不可调用；查询能并行、写入仍受协调；运行集合更新有明确规则 |

批次 0 处理明确缺陷，实现把握高；符号工具在本项目 TS/JS 范围内把握高；跨进程现场和动态工具加载涉及宿主契约，把握中。以上是工程判断，不是实测成功率。更换模型单独做对照，避免同时更换模型和工具后无法归因。

核心改动按 `docs/development.md` 执行 build + restart 验证；插件后端重挂；文档不构建。完成工具注册、任务执行、检查通过和运行版本生效分别报告。

## 6. 怎样确认缩短工期

先挑约 10–15 个已经知道正确入口和验收条件的历史问题，覆盖报错、无变化、IPC、插件状态、工具结果和界面。涉及写入的回放在隔离工作区进行；不要默认加载全部真实插件或运行当前 selftest。

保持模型、提示与任务条件一致，每次只改一个机制；记录单项与累计收益：

- 从开始到首个正确相关证据的时间、模型轮数和工具调用数。
- 无关文件读取量、重复读取量和重复检查量；“无关”按最终问题证据链人工复核。
- 输入/输出 token、缓存命中与工具产物体积；缓存用量按供应商实际报告，未知则留空。
- 修复后首次验证通过率、回归情况、重做次数和完整交付耗时。
- 工具错误被正确反馈、截断结果可恢复、长期规则仍可见的比例。

先形成基线，再填写目标改善幅度。检索更少但漏掉关键调用方不算成功；应同时看定位成本和最终质量。


## 6. 当前落地进展跟踪 (实施更新)

- [x] **LF 行号失真修复**：`src/main/agent.ts:679` 正确支持 LF/CRLF 分割。
- [x] **长日志报错截断保留**：`src/main/agent.ts:469` 保留头部 7k + 尾部 12k 关键错误与退出码。
- [x] **工作区规则热脱落修复**：`plugins/agents-md/index.js` 保持轻量常驻锚点指引，防止多轮遗忘。
- [x] **代码智能插件 `code-intelligence`**：
  - `symbol_find`：语义符号定位（过滤注释与引用噪音）
  - `code_slice`：作用域闭合边界精准切片（避免大文件倾倒）
  - `review_changes`：基于 Git Diff 的自动化变更审查门禁
  - `investigation_record`：排查证据账本（已证/已排事实持久化）
  - `repo_map`：小预算代码拓扑大纲（小 Token 呈现代码架构）
- [x] **运行时现场探针 `runtime-probe`**：
  - `probe_runtime_errors`：捕获主进程未捕获异常、Promise 拒绝与工具失败调用栈
  - `/probe` 命令：现场快速排障
- [x] **后台进程能力扩展 `jobs`**：
  - `job_start`：支持自定义 `workdir` 子目录
  - `job_send_input`：支持向任务 stdin 交互写入
