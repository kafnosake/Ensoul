# 开发规范与最短验证路径

2026-10-05。适用于 ensoul 自身开发，配合根目录 `AGENTS.md` 使用。本文是工作规范；标为“目标”的机制尚未实现。当前实现与限制见 [runtime-hardening.md](runtime-hardening.md)。核心工作准则和 prompt-manager 预览已按范围验证；旧技能中的重复规则仍需后续同步。

## 1. 从任务入口定位

每次开始只记录四件事：可复现现象、预期行为、允许修改的范围、验收条件。修复一个 bug 与重构模块分开交付。

| 现象 / 任务 | 首先看 | 必要时再看 |
|---|---|---|
| 模型工具来回调用，却似乎看不到结果 | `src/main/ptc.ts`，`index.ts` 的 `effectiveRunner` | `chat-core.ts` 的 `runAgent`、历史回放 |
| 停止后还在改文件 / 旧回复覆盖新任务 | `src/main/index.ts` 的 `chat:stop`、`doSend` 收尾 | `agent.ts` 工具执行，`plugins/jobs` |
| 派单超时、重复交付、忙面板收不到任务 | `plugins/dispatch/index.js` 的 `deliver` | `index.ts` 的 `enqueue` / `running`，`plugins/tickets` |
| 改了代码界面没变化 / 一直重复构建 | `src/main/project.ts` | `plugins/ui-refresh/index.js`，`scripts/launch.js` |
| 下载源码后缺环境 / 首次运行失败 | `scripts/bootstrap.ps1` / `bootstrap.sh`，`scripts/setup.js` | `scripts/ensure-electron.js`，`scripts/npm-command.js` |
| 插件工具缺失、禁用后仍有动作 | `src/main/plugins.ts` 的 `loadPlugins` / `mount` / `dispose` | `src/main/agent.ts` 的 `toolsFor`，插件 `setup` |
| 插件面板没出现 / 找不到渲染代码 | `src/renderer/panel/pluginPanels.tsx`，插件 `panel` 声明 | `registry.tsx`，`PanelSurface.tsx` |
| 面板嵌入、缩放、边框、停靠问题 | `FloatPanel.tsx`、`FitBox.tsx`、`src/shared/types.ts` | `src/main/workspace.ts`、`store.ts` 对应操作 |
| 状态串到另一面板 / 克隆污染原件 | 插件的状态 key、`store.ts` 的 `cloneComponent` | `plugins.ts` 的 `state` 实现 |
| 提示更新没生效 / 规则矛盾 | `chat-core.ts`，`prompt-composer.ts` | `plugins/agents-md`、`plugins/prompt-manager`，相关技能 |
| 组件导出导入错误 | `src/shared/ensoulpack.ts`，`plugins/library` | `scripts/test-ensoulpack.js` |

采用“入口 → 数据写入点 → 数据读取点”的路径。先搜符号，再读函数及直接调用方；通常前两批各读 2–4 段就足够提出可验证假设。这是默认节奏，不是硬性文件数量限制。

定位两次无进展时，先回答：刚才的检查排除了什么？下一项检查怎样区分两个假设？没有答案就换策略，不继续扩大扫描。

## 2. 代码归属

产品上的功能单位仍然只有面板。任务记录、运行实例和工具调用 ID 是内部执行信息，不需要变成用户要管理的新面板体系。

| 层 | 负责 | 约束 |
|---|---|---|
| `src/shared/` | IPC/RPC 数据契约、面板数据、纯函数 | 不依赖 Electron、DOM、文件系统；不是放杂项逻辑的目录 |
| `src/main/` | 面板身份、存储、agent 循环、工具管线、通用生命周期与执行仲裁 | 不硬编码番茄钟、桌宠、计费等业务规则 |
| `src/preload/` | 有类型的 IPC 桥 | 不承载业务流程，不暴露任意主进程对象 |
| `src/renderer/` | 外壳、停靠、通用面板容器、会话和渲染适配 | 不直接读写 Node 文件；不复制主进程状态真源 |
| `plugins/<名>/` | 功能、工具、面板内容、设置、状态和可替换策略 | 通过宿主契约接入，不直接导入主进程内部单例 |
| `skills/`、`docs/` | 按需的操作知识、接口说明 | 不重复保存另一套工具 schema、状态机或默认提示词 |

添加功能的顺序：现有插件扩展点 → 现有面板类型 → 新插件面板类型 → 补一个通用宿主能力。最后一项只增加可复用能力，不按某个插件名字写分支。

本规范允许插件引用明确公开的共享类型 / 纯函数契约（当前如 `PanelFaceProps`、ensoulpack 格式），不能把 `src/main` 内部单例当 SDK。`docs/plugin-spec.md` 已同步这条边界。后续先整理公开入口白名单，再考虑独立 SDK；稳定 SDK 目录尚未实现。

当前插件 UI 可以放在应用的 `plugins/<名>/panel.tsx` / `panel.css`；工作区 `.ensoul/plugins` 的脸没有进入构建期 glob，暂不能照这个路径动态增加 UI。新动态 UI 的支持需要单独设计加载协议。

## 3. 少量但明确的代码规则

- 新代码使用相邻文件的格式；TS / TSX / JS 以两空格、单引号、分号为默认。保留已有行尾，不全库格式化。
- 模块按职责拆，不按固定行数拆。先把新行为放在小模块，修改到哪个大函数再提取哪个职责；不要为了修一个 bug 拆整个 `index.ts` / `store.ts`。
- 常规命名：类型 / React 组件用 PascalCase，变量 / 函数用 camelCase，工具沿用 snake_case，插件目录用短横线。遵从已有公开名字，避免只为统一格式破坏兼容。
- 边界上的输入按 schema 或明确类型检查；模块内部依靠已建立的契约。JSON、网络、旧存档、第三方插件输入用 `unknown` 再收窄，新业务代码不扩散 `any`。
- `kind`、工具参数、IPC channel、事件字段各有一个真源。插件注册表和帮助说明从真源生成，例子只示范用法。
- 跨进程只传可序列化数据；函数、AbortSignal、进程句柄、watcher、Map 留在宿主内部，不能混进面板持久化快照。
- 不用空 `catch` 吞掉关键失败。可以容忍的 UI 预览失败写诊断；状态提交、任务交付和源码写入失败必须向调用者反馈。
- 注释说明为什么、所有权和生命周期，不复述代码。用户看见的界面文案不写开发日志。
- 当前 CommonJS 插件后端可继续使用，不为统一语言全面改成 TS。跨插件公共接口稳定后，再考虑 JSDoc 类型或单独的 SDK 类型声明。
- 类型基线只能在明确清掉对应错误后收紧；不把新增错误加入基线，不通过增加全局 `as any` 消除报错。

## 4. 状态、命令与生命周期

插件实例属于初始化时的工作区。工作区切换会 dispose 旧实例并重新 setup，工作区参数缓存同时失效；实例的 `api.workspace` 和 `api.state` 始终绑定该实例的工作区，不能跨目录复用内存状态。`api.state.save` 返回是否成功，业务指纹只在写入确认后更新。

界面读取 JSON 状态用 `fs.readJson`：结果明确区分 `ready`、`missing`、`too_large`、`invalid`、`error`。缺失不是坏文件，组件应展示初始化/空状态；结构校验仍由对应界面完成，真正读取失败要给出文件与原因。文本读取接口不承载快照错误协议。工作区与快照回归用 `node --test scripts/test-workspace-snapshots.js`，在系统临时目录运行，不使用真实工作区。

文件仍可作为插件与 UI 的数据边界，但每个文件要写明作用域：workspace、panel 或 task。

- 面板私有状态用 `panels[panelId]`；计时器、账本、便签实例按真实实例分槽。
- 全局组件目录、供应商配置、构建状态可以按工作区共享，不为通过启发式检查强行分面板。
- 当前 `api.state.save` 是整份写入。读 → 等异步操作 → 写的流程可能覆盖他人更新；在共享状态中避免跨 `await` 持有旧快照。
- 临时文件 + rename 只解决正常路径下的文件替换，不解决业务上的读改写冲突。多实例 / 多进程写同一路径需要单写者或 revision 检查。
- 当前命令通道按各插件实际契约写入（常见为 `{ cmds: [...] }`，每条带 `panelId` 和递增 `seq`），不要直接用新字段替换。目标增加 `requestId` 和确认记录，解决跨窗口追加 / 消费的冲突；读到同一命令两次不能再次执行副作用。
- `setup` 注册资源，`dispose` 清理对应资源；关闭 / 隐藏面板、禁用 / 卸载插件、取消任务必须分别定义。
- 有定时器、watcher、网络订阅或后台进程的插件必须能够重复 mount / dispose，而不增加第二份资源。
- 克隆面板配置、从模板新建、分叉会话是三种动作。新的实例只复制配置；队列、运行 ID、进行中状态和资源句柄不继承。需要带历史时显式分叉会话。

以下为**未来状态契约示意，不是当前 api.state 的参数**：

```ts
type StateEnvelope<T> = {
  schemaVersion: number;
  revision: number;
  data: T;
};
```

版本迁移放在状态拥有者一侧；UI 不为各种历史格式各写一套修复逻辑。

## 5. 验证与应用更新是两步

首次环境准备使用根目录的 `安装.cmd` / `安装.command`：bootstrap 复用 Node.js 22+，缺少时下载官方便携版本到 `.runtime/<平台>-<架构>/`，核对 SHA256，然后运行 `scripts/setup.js` 安装依赖、严格准备 Electron、构建。全部成功才调用 `launch.js --no-build`。已安装 Node.js 的命令行用户可用 `npm run setup`。

日常 `启动.cmd` / `启动.command` 仅选择 Node.js 并调用同一份 `scripts/launch.js`；不会安装 npm 依赖。`启动.cmd` 保持一行纯 ASCII。npm 优先通过当前 Node.js 配套的 `npm-cli.js` 执行，便携环境只影响当前进程 PATH。首次安装会修改 `node_modules` 和构建产物，不能拿真实共享工作区反复安装来做脚本自检；应在独立副本验证。仅改安装脚本不需重启正在使用的 ensoul。

启动器使用带 ensoul 进程身份的应用壳；`npm start` / `npm run app` 也走这个入口。首次生成需要安装入口准备 `@electron/packager`，后续复用 `.electron/brand` 缓存。应用壳通过 `ENSOUL_SOURCE_ROOT` 加载当前源码目录，插件和自我开发路径保持指向该 checkout。进程身份与图标更新见 [application-identity.md](application-identity.md)，完整素材说明见 [assets/brand/README.md](../assets/brand/README.md)。

“检查通过”与“运行时吃进这份产物”分别确认。最短验证选择如下；集成 / 发布检查另做，不要求每个局部任务执行全套。

| 改动范围 | 默认验证 | 生效方式 | 何时扩大检查 |
|---|---|---|---|
| 文档、说明、技能正文 | 路径、说明和源码一致性；技能元信息检查 | 下次读取；热会话旧提示需另外核实 | 涉及规则优先级时核对提示拼装 |
| 插件 `index.js` / 后端 JS | `node --check` 修改的 JS 文件；只审计该插件；一个对应行为检查 | 单改入口确认重挂；改已缓存依赖文件当前须真正重启，或显式清依赖缓存并验证 | 工具 / 钩子契约改动时检查调用方 |
| 插件 UI、renderer TSX | `node scripts/check-types.js`；渲染构建；一次目标界面检查 | renderer reload | 改注册表、CSS 公共类、容器时覆盖嵌入布局 |
| 纯 CSS / HTML / 资源 | 渲染构建；目标界面检查 | renderer reload | 全局样式变化时看另一种面板 |
| main / preload | `node node_modules/typescript/bin/tsc -p tsconfig.main.json --noEmit`；对应行为检查 | 主进程构建后真正重启 | 涉及 RPC / 宿主边界时补解耦检查 |
| shared 运行时代码 | 主进程类型检查 + 渲染类型门禁；对应纯函数或边界检查 | 构建两端并重启 | 同时改变持久化格式时验证迁移 |
| `.ensoulpack` 格式 / library 导入导出 | 先 `npm run build:main` 更新测试依赖的 dist，再 `node scripts/test-ensoulpack.js` | 按涉及的前后端分别应用 | 契约变更时跑完整往返 |
| agent 循环 / 取消 / 队列 / 调度 | 类型检查；隔离的时序与并发检查 | 构建后重启 | 必须覆盖停止、超时、重复交付、恢复 |

常用命令均从项目根目录执行：

```text
node scripts/audit-plugins.js <插件名>
node scripts/check-types.js
node node_modules/typescript/bin/tsc -p tsconfig.main.json --noEmit
npm run build:main
npm run build:renderer
npm run build
```

在 ensoul 内优先使用现成 build / restart 工具做应用更新；外部开发环境使用上述 CLI。每批改动由一个任务统一构建，不让多个 worker 同时写 `dist`。同一代码版本已经检查通过后，只有新增改动、失败或未解决的问题才重跑。

**现有脚本的限制：**

- `scripts/check-types.js` 放行存量类型债，退出 0 不等于所有类型错误为零；`--update` 会写基线，不能作为验证命令。
- `scripts/audit-plugins.js` 是启发式扫描。告警需复核作用域，不证明一定串面板。
- `scripts/check-skills.js` 是技能可发现性诊断，默认工作区为 `D:\WORK`，不是技能格式门禁；调用时显式传项目路径。
- `scripts/selftest.js` 依赖编译产物，还原地改写真实 `plugins/jobs/index.js`、加载全部插件并执行网络 / 子进程操作。修好隔离性之前只在专门测试环境运行。
- `scripts/test-notes.js` / `test-pomodoro.js` 的 mock 和当前插件契约不同步，不能作为已可靠的默认验收。
- `scripts/test-ensoulpack.js` 删除并重建固定 `.ensoul/tmp/pack-test` 且依赖 dist；同一工作区不要并发跑。`--noEmit` 不更新产物，验证前需要主进程构建。
- `scripts/check-decouple.js` 是编译模块加载冒烟，require 成功不能证明整条依赖链没有 Electron；需要时另做静态依赖约束与宿主替身检查。
- `npm run test:runtime` 先编译主进程，再在系统临时目录检查租约、取消、PTC、构建协调和分身执行；不加载全部插件、不访问模型服务、不改真实源码。
- 自动刷新通过共享构建服务执行渲染类型门禁与 Vite；构建通过和窗口刷新仍是两种事实。

不要为可逆、低影响的文案 / 样式修改添加复述实现的测试。对取消、并发、恢复和数据迁移，使用能重现失败行为的测试。

## 6. 给开发模型的任务与交接模板

```text
目标：哪一种现象要变成什么行为
复现：最少操作或输入；没有复现时说明缺少的证据
范围：允许修改的文件 / 模块；同一文件唯一写作者
入口：函数 / 错误 / 相关状态，不要求重新探索整个仓库
验收：一个行为检查 + 必要的类型 / 构建范围
交付：改动文件、原因、检查结果、是否已应用到运行时
```

交接只保留：已确认事实、排除过的假设、改动、未完成检查、下一步。长工具输出和完整日志用路径引用，不搬进每个模型的上下文。PTC 无显式输出时会返回子工具结果；有 return/log 时，要在输出中保留判断需要的信息。
