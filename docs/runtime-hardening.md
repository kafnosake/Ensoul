# 第一批运行时改进与验收

2026-10-05。保留面板、插件、outbox、steering 和 turn journal，修复反馈、取消与重复构建；没有替换整个框架。

## 已实现

| 范围 | 行为 |
|---|---|
| 面板执行 | 开始准备会话时取得 runId 租约；同面板重复发送返回忙，排队与插话继续使用原有机制。按停保留租约到收尾；按 runId 释放，旧收尾不能清掉新执行 |
| 会话结果 | 面板不存在、缺少密钥、停止与失败不再返回 ok:true；失败时不应用面板改写提案；准备阶段异常也清理实时状态 |
| 工具取消 | ctx.signal 与 AsyncLocalStorage 传播取消；模型工具批次在每次调用前后检查；run_command 停止进程树，超时处理器通过受支持文件 API 的后续写入被拒绝 |
| PTC | 编排代码在可终止工作线程中运行，默认总预算 120 秒；调用最多 50 次，发出时计数；按工具清单授权，宿主依次执行，Promise.all 不造成同面板并发写；无显式输出时返回子工具结果 |
| 分身 | 真正创建隐藏会话，继承模型与工具清单，共用工作区，等待 api.send 的真实结果；不允许分身继续调用 subagent_run / dispatch；记录真实时长与已报告用量，支持 completed / failed / stopped |
| 分身界面 | 打开关联会话，不再点击时重做任务；无关联会话的旧记录显示未验证，不再补假 token |
| 构建协调 | 按项目根固定构建对象，串行请求；源码与产物内容指纹一致才复用成功结果，失败及构建中源码变化不复用；同版本 full 构建可满足后续 renderer 请求 |
| 自动刷新 | 等所有当前面板执行收尾再构建；通过同一协调器构建应用自身目录，即使用户切换工作区也不会构建错误项目；执行类型门禁，构建异常不留下 building 标记，dispose 后不上屏 |
| 变更应用 | main / preload / shared 均参与主进程过期判断；插件面板与构建配置参与启动构建判断；build_project 后 restart_project 可复用同进程内成功构建；核心提示词与预览按变更范围验证 |

新增基础职责分别位于 `run-registry.ts`、`process-control.ts`、`project-build.ts` 和 `ptc-worker.ts`。插件宿主增加 `modelPick(panelId)`（不含密钥）与 `buildProject(target, scope?)`；scope 为 workspace（默认）或 app。

## 验收

- `npm run build`：通过，主进程编译和 Vite 产物完成。
- 渲染类型门禁：当前 29 条存量错误，没有新增，未更新或扩大基线。
- `node scripts/test-runtime.js`：18 项通过；测试只在系统临时目录写入，模型流用替身，不加载全部插件或调用模型服务。`npm run test:runtime` 会先编译再执行。
- 同一组 18 项在本机 Electron 自带 Node 运行模式下通过，包含工作线程和命令取消检查。
- 修改的三个插件入口通过 `node --check`；`git diff --check` 通过。
- 新版本 Electron 启动，本机 RPC 返回 116 条能力；工作区 D:\ensoul，18 块面板，无正在执行的面板；不存在面板的 chat:send 返回 ok:false；启动 stdout / stderr 没有捕获到加载、语法或未处理异常。

自动检查包括：旧 run 释放竞争、取消保留租约、构建复用与失效、插件入口 / preload 指纹分类、PTC 结果可见与权限、并发预算和串行执行、未 await 调用结算、无限循环终止、取消后不启动下一工具、延迟写入拦截、Windows 命令子进程树终止，以及分身三种真实终态。

可靠性判断：这些已覆盖的行为把握较高；未测固定提速比例或成功率。尚未用真实付费模型做完整多面板任务验收，启动与 RPC 检查也不等于所有界面交互已经验收。

## 边界与下一批

- 工作线程用于避免阻塞和终止编排代码，**不是安全沙箱**。现有插件仍是受信任 Node 代码；直接调用 fs、启动自有进程或忽略 signal 的插件不能被这批修改完全阻止。它们需逐个迁移到取消契约。
- api.send 的同步等待链传播取消。第二批已将 dispatch / subagent 改为持久异步任务，并建立 parentTaskId / parentRunId 取消关系，见 [reliable-tasks.md](reliable-tasks.md)。
- completed 表示会话成功结束，不保证业务验收；第二批分别记录文件交付、用户验收、重启中断与请求去重。
- 缓存保存在当前进程内，外部 CLI 构建不会自动登记成可复用构建；构建本身属于共享项目操作，单个会话取消不会撤销已经开始的共享构建。
- 文件宿主内的跨面板写入冲突和 tx-guard 版本校验现已实现，见 [file-write-safety.md](file-write-safety.md)。外部副作用幂等、禁用插件 teardown、配置克隆隔离和统一诊断索引仍未完成。
- Python 现有环境管理应复用；Three.js、DSH 声明适配和通用父子嵌入槽仍属于后续工作。

持久派单与取消关系现已作为第二批实现；最新验证见 [reliable-tasks.md](reliable-tasks.md)，本页的 18 项结果保留为第一批历史。下一批处理插件生命周期和状态契约。总体目标见 [agent-scheduling.md](agent-scheduling.md)，日常规范见 [development.md](development.md)。
