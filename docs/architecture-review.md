# 架构审查与修复顺序

审查日期：2026-10-04。依据当前工作区源码，包含原有未提交改动；不是仅审查 Git HEAD。没有读取私人会话或凭据。此次仅更新开发规范和设计文档，没有修复下列运行时代码。

## 1. 结论

面板与位置分离、插件功能、组件复用、按需技能和独立 Node 后端都是可以保留的基础。主要阻力是执行语义和开发反馈不统一：模型得到不完整或虚假的成功反馈、超时和停止不能正确结束工作、不同更新路径各自构建、说明与接口漂移。

仅把轻量模型换成强模型，或把功能重写一遍，都不能消除这些运行时问题。先让工具结果和任务状态可信，再减少每次任务的定位与验证成本。

## 2. 已确认的问题

行号是本次工作区快照，仅供定位；之后应按函数名查找。以下缺口均来自静态代码证据；时序问题还需要隔离复现，未声称已在用户实际运行中重现。

| 优先级 | 证据 | 影响 | 首个修复 |
|---|---|---|---|
| P0 | `plugins/subagent/index.js:61` 的 handler 只写记录；第 72–75 行直接设 completed / 4秒 / 3.2K tok | 工具返回成功，但没有执行模型或任务 | 暂停注册或返回明确 unsupported；接入真实派单并从实际 run 统计结果后再启用 |
| P0 | `index.ts:3836` 停止时立即清空 running；`index.ts:3501` 旧 run 收尾无身份核对；`chat-core.ts:1217` 调工具不传 signal | 停止后工具可能继续执行，新旧 run 占用和收尾有竞争 | runId 租约 + 工具 / 子任务取消链；旧 run 不得清理新 run |
| P1 | `index.ts:3144` 默认 PTC；`:3365` 未传 allowedTools；`ptc.ts:151` 在主进程执行 AsyncFunction，计数在子调用完成后递增 | 工具清单不能完全约束实际调用，并发计数和终止不可靠 | 先传 allowlist、开始时计数、统一取消；再隔离 PTC 执行 |
| P1 | `ptc.ts:167` 无 return / console 输出时只回“成功，调用数” | 模型可能读了文件却没收到代码，重复定位 | 提供有限的自动结果返回，或强制工具模板显式返回读取结果 |
| P1 | `dispatch/index.js:1547` await 另一面板整轮；工具声明无 timeoutMs；`agent.ts:888` 默认 60秒，`:899` 仅 Promise.race | 父工具超时后子任务仍可能写文件，重派可能重复执行 | 派单立即返回任务 ID，等待独立处理；超时查询、去重、取消 |
| P1 | `project.ts:407` 重启界面再构建 renderer，`:417` 主进程重启再全量 build；`ui-refresh/index.js:353` 独立 Vite 构建 | build → restart 重复构建，多来源竞争 dist | 单一构建所有者 + buildId，刷新与重启应用已验证版本 |
| P1 | `project.ts:233` 只用 src/main 判断主进程失效；`:169` 只查 src 判断总体失效 | preload / shared 或插件脸的变更可能被分类错，出现改了不生效 | 集中变更分类，覆盖 main、preload、shared、renderer、插件与构建配置 |
| P1 | `plugins.ts:1852` 扫到插件先 mount；`:1870` disabled 只排除贡献，不 dispose | 被禁用插件仍可能有定时器 / watcher / 子进程 | 元信息发现与激活分开；禁用执行 teardown，重启用执行 setup |
| P1 | `tx-guard/index.js:245` 用 panelId + 文件名找待验事务；PTC 允许并发调用 | 同文件多笔写入可能串事务，回滚也可能覆盖后续更新 | 写入串行；事务按 toolCallId 关联并校验回滚版本 |
| P2 | `plugins.ts:1005` EBUSY / EPERM 时 copy 覆盖；`:1639` 保存失败仅日志；无 revision | 不完全原子、读改写冲突；调用者可能误以为已保存 | 明确保存结果与作用域；共享写入序列化，必要时版本检查 |
| P2 | `store.ts:1882` clone 浅拷面板，仅深拷 chat，重设少量字段 | 可能复制队列 / 进行中状态或共享 spec / look 引用 | 显式白名单复制配置，运行身份和队列重置；分叉会话另行定义 |
| P2 | `plugins.ts:1620` 插件日志走 console；`project.ts:548` read_logs 读自己的内存日志 | 自动刷新出错时模型可能被引导去错误日志源 | 统一带 task/run/plugin 来源的诊断索引，返回对应 logRef |
| P2 | `plugins.ts:1850` 只看入口 mtime，`:1740` 只清入口 require 缓存 | 改插件依赖文件可能继续执行旧代码 | 目录内声明文件指纹 + 插件所属模块缓存失效 |
| P2 | `plugins/pomodoro/panel.tsx:111` 读改写命令文件；`index.js:247` 消费后整份清空 | 消费期间新追加命令可能丢失 | 主进程单写者队列，或单命令文件 + requestId / 回执 |
| P2 | `src/main/index.ts:3687` 失败 / 停止后仍返回 ok:true；`dispatch/index.js:2426` 至少一个文件存在即可整单 done | 对话返回、工作成功和完整交付混为一谈 | 结构化终态，按验收和完整产物检查提交 |

PTC 清单裁剪与实际权限不一致、取消竞争等应优先处理，但这不是一次完整安全审计。旧插件使用 Node 内部能力的信任模型还需另外明确。

当前无边框 float 面板的 anchor 指向标签组（`src/shared/types.ts:363`），不是任意面板内部递归嵌入。产品愿景可继续保留，但真正的父子插槽与嵌入生命周期应单独验收。

## 3. 说明与检查存在漂移

- `chat-core.ts:124`、prompt-manager 的 fallback、`skills/make-plugin` 与 `skills/fix-build` 仍要求几乎所有源码改动全量 build + restart；实际已有 renderer reload 和插件重挂。
- `skills/ensoul-map` 的技能根列表含 `.dsh/skills`，但 `src/main/skills.ts` 核心只列 `.ensoul/skills`、`.agents/skills`、用户 `.agents`、插件自报 roots 和内置 skills。DSH 根须由插件注册，不能保证总存在。
- `prompt-manager/panel.tsx` 有一份长 fallback，与真正提示词和插件 UI 能力描述不同步。应该让预览读取当前 prompt composer；技能只解释规则，不再复制规则原文。
- `scripts/check-skills.js` 的实际用途是技能发现诊断，README 原先称作格式检查，容易形成假验收；本次已修正文案。
- `scripts/selftest.js:337` 原地写真实 jobs 插件再恢复，并加载全部插件，不能按开头注释认定完全隔离。其旧字符串替换也未适配当前 `t(...)` 描述。
- notes / pomodoro 测试没有配置插件所需的全局 `t`；notes 的 mock 没跟上 addSummaryNote / addTool，且未设置隔离 workspace。先修 harness，再把它们作为可靠门禁。
- 渲染类型基线按文件 + 错误码计数。同一桶里修掉旧错、增加新错，可能互相抵消；`--update` 可以扩大基线，并没有强制单向收紧。保留过渡机制，但新增代码不得依赖这个漏洞。

## 4. 最初只读审查的检查

| 检查 | 结果 | 说明 |
|---|---|---|
| `node node_modules/typescript/bin/tsc -p tsconfig.main.json --noEmit` | 退出 0 | 当前主进程 / preload / shared 类型检查通过；未改产物 |
| `node scripts/check-types.js` | 退出 0，存量 32 条 | 没有超过现有类型基线，不表示渲染层零错误；未更新基线 |
| `node scripts/audit-plugins.js` | 47 个插件，11 条告警，退出 1 | 静态启发式，需要按状态作用域复核；未将其计为 11 个已证明 bug |

最初只读审查没有启动 / 重启应用，也没有执行有副作用的 selftest。后续第一批运行时修改已构建、回归检查并启动，最新验收见 [runtime-hardening.md](runtime-hardening.md)。

最初交付为规范文档；后续已同步核心工作准则和 prompt-manager 预览，现有技能正文仍未修改。上表行号与缺口描述记录的是改动前的审查快照，不能当成当前代码行号或仍未修复的完整清单。

## 5. 推荐的执行批次

“落地把握”是基于改动边界的主观成功判断，不是测得的成功率；未做基准测试，不承诺固定提速比例。

| 批次 | 工作范围 | 验收 | 落地把握 |
|---|---|---|---|
| A：让反馈可信 | 停用假 subagent 成功；PTC 结果可见 / allowlist / 调用计数；隔离旧测试 | read/search 结果到达模型；未授权调用被拒；占位返回 unsupported；测试不改真实源码 | 高，边界清楚；完整 PTC 隔离不包含在本批 |
| B：让停止与派单可信 | runId 租约；取消链；异步 taskId；令牌去重；复用 outbox | 停止不启动后续写；旧收尾不清新 run；父等待超时不重复派单；取消子任务被传播 | 中，需要明确时序和插件兼容，强模型负责这一批 |
| C：每批改动只构建一次 | 变更分类；共享构建队列；buildId；自动刷新改为提交请求 | 同版本 build → apply 只有一次构建；preload/shared 正确重启；纯 UI 只 reload | 高到中，先用串行批次实现，后做增量优化 |
| D：稳定插件与组件契约 | disabled teardown；配置 clone；状态保存结果；最小诊断索引；同步旧说明 | 重复启停资源数不增长；两个实例状态不串；失败日志可定位；保存失败显式返回 | 中，可按能力独立交付 |
| E：扩展服务 | Python 执行器、Three.js 内容、一个简单 DSH 插件适配 | 生命周期与取消符合统一契约；两实例不串；加载 / 卸载可验证 | 窄能力高，任意 DSH 插件透明兼容低，必须逐类评估 |

每批拆成可验收的小任务，不同时改调度、存储、面板布局和服务适配。现有大文件不是立即全面重写的理由；先提取正在调整的职责，逐步形成更小的稳定模块。

已有 `src/main/index.ts:2105` 起的 env:* 处理与 `src/renderer/core/api.ts:347` 的 Python 环境 API。批次 E 应复用并逐步提取这些能力，不将解释器管理误当成完全缺失；统一的可取消执行服务仍需要独立验收。

## 6. DSH 借鉴边界

已核对 [DeepSeek Harness 官方架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)（2026-10-04）：其插件依托 Cordis 的服务、类型事件与可撤销 effect。这支持“生命周期和依赖契约值得借鉴”的判断，不能推出 ensoul 已具备同等实现。

建议把 manifest 与适配层作为插件提供：声明实际依赖服务、工具与状态版本、映射范围和 teardown；缺服务时明确不支持。LLM 做一次映射与测试草稿，运行时执行固定适配。先验一个简单插件，再决定是否需要引入完整 Cordis 运行时；不为追求口号马上替换整个 ensoul 核心。

详细工作规范见 [development.md](development.md)，执行设计见 [agent-scheduling.md](agent-scheduling.md)。
