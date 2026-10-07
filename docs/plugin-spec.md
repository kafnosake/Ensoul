# 插件与组件打包规范（v1）

> 这一页是**可分发规格**：凡是「从别处装进来」或「把自己手上的发出去」，都以它为准。
> v1 · 2026-10-04 · 实现以 `src/main/plugins.ts` 的类型与文件头注释为最后依据。

## 0 · 先分清三样东西

|  | 组件 component | 插件 plugin | 包 .ensoulpack |
|---|---|---|---|
| 是什么 | 一块面板的**做法**：kind + look + spec + 标题 + 提示词 | 一个目录：加工具、加提示、记状态、开设置分区 | 上面两种的**容器** |
| 有代码吗 | 没有，纯数据 | 有（CommonJS） | —— |
| 能自带界面吗 | 不需要，用面板类型渲染 | **v1 不行**（见 §3-6） | —— |
| 现在住哪 | `.ensoul/library/components/<面板 id>.json`，一件一个文件 | `plugins/<名>/`（跟软件）或 `<工作区>/.ensoul/plugins/<名>/`（跟项目） | 用户自己挑地方 |
| 最适合分享什么 | 「这块面板怎么配」 | 「这个能力」 | 一次发好几样 |

后面：插件（§1–3）、组件（§4）、包（§5）、出口与入口（§6）、v1 不做的事（§7）。

## 1 · 插件长什么样

一个目录，`index.js` 是入口：

```
my-plugin/
  index.js       必须有，CommonJS
  manifest.json  分发时必须有（见 §5）
  README.md      可选
  lib/*.js       可选，自己的模块
```

`index.js` 导出：

```js
module.exports = {
  name: 'my-plugin',        // = 目录名，也是判定「装没装」的键
  description: '一句话说清它干什么',
  params: [ /* 可选：自己声明的可调参数，出现在 设置 → 插件 那一行 */ ],
  panel: { /* 可选：自带一种面板类型；v1 只有软件自带的插件能声明，见 §3-6 */ },
  setup(api) {
    api.addTool({ name: 'my_tool', description: '…', parameters: {} },
                (args, ctx) => '…');
  },
};
```

装载三条规则，写包的人和装包的人都要知道：

1. **两个根，先扫到的赢**：软件自带 `plugins/` 与 `<工作区>/.ensoul/plugins/`；同名时**工作区赢**——这就是「把自带插件拷一份到工作区改一改」能当补丁用的原因。
2. **不用注册、不用重启**：放进去，下一轮对话就扫到。要不要重载按 `index.js` 的**文件修改时间**判断——改了才重来，没改就接着用旧实例（所以 `setup` 可以异步做准备）。
3. **一个坏插件不带垮别人**：加载失败只记一条错，其余插件照常加载。

## 2 · 能力面（插件能调什么）

运行时增量（2026-10-05）：工具上下文含 `runId` 与 `signal`；耗时处理器应接收取消并在副作用前检查。`send(..., { signal })` 将取消传到被等待的会话，忙面板返回失败，排队或插话仍走原有 API。`modelPick(panelId)` 返回不含密钥的模型选择；`buildProject('full' | 'renderer', 'workspace' | 'app')` 使用共享构建器，默认 workspace。细节与边界见 [runtime-hardening.md](runtime-hardening.md)。

设置分区可以声明 `placement: 'more'`，把资源安装与下载入口嵌入「更多」，无需另占侧栏。独立分区的 `group: 'extension'` 排在分割线下方，`after` 可以引用内置页 ID 或 `plugin:<插件名>:<分区 ID>`；被引用的分区未启用时，当前入口仍保留。

设置行的 `inline: 'select'` 配合 `options: [{ value, label }]` 提供下拉选择，变更通过首个 action 的 `<id>:<value>` 即时提交。`api.environments.directory(name)` 返回 ensoul 用户数据目录下的全局环境路径；安装 Python 后调用 `api.environments.registerPython({ id, name, path, version?, available? })` 登记到统一解释器清单，所有工作区可见，保持当前激活项。

| 方法 | 干什么 | 现成的例子 |
|---|---|---|
| `addTool(spec, handler)` | 加一个工具给模型用 | todo / jobs / web |
| `onBeforeWrite(fn)` | 写文件之前过一手（改前留底） | file-backup |
| `onBeforeTool(fn)` | 工具执行前拦一手：返回一句话=拦下并把它当结果 | restart-approval |
| `onAfterTool(fn)` \* | 工具执行后看得见结果，能改能清空 | —— |
| `onReasoning(fn)` | 接住模型的思考流 delta（核心不留存，只有这里看得见） | thinking-log |
| `addPrompt(fn, { scope })` | 每轮往提示里加一段；带 `scope` 就只在指定面板类型上出现 | todo |
| `addSummaryNote(fn)` | 压缩历史时被问一次：有什么不能丢的 | notes |
| `addCompactPick(fn)` \* | 压缩那一刻决定这次用哪个模型写纪要 | —— |
| `ask(spec)` | 请用户点个头才继续 | restart-approval |
| `state` | 一小块持久状态（load / save），落 `.ensoul/state/<名>.json` | todo / jobs / web |
| `param` / `setParam` | 插件**自己声明**的可调参数 | pomodoro / file-backup |
| `allParams` / `setPluginParam` | 给「让助手替你调参数」的插件用 | plugin-kit |
| `addSettingsSection(spec)` | 在设置里单开一页（`view()` 现算，`onAction` 收动作） | dsh-compat 等 |

带 \* 的两条是**类型已定义**（`AfterTool` / `CompactPickFn`）、按命名推得，动手前跟核心对一眼。
其余全部有现成插件在用。加新口子的规矩是核心自己写的：**没人用的口子不要留**——它看着像能力，其实是「别人绕着你走」的邀请函。

## 3 · 纪律（硬要求）

1. **状态明确作用域**：默认写 `.ensoul/state/<名>.json`，面板私有状态按 `panels[<panelId>]` 分槽。组件目录、构建状态、账户配置等可以按工作区或账户共享，但须说明归属。共享状态的单写者规则见 `docs/development.md`。
2. **命令走 `.ensoul/state/<名>.cmd.json`**：面板写、插件读，每条必须带 `panelId` 与递增 `seq`；插件只认属于自己那块面板的那条。
3. **不引用核心内部实现**：插件不得直接导入 `src/main` 的 store、index、plugins 等内部单例。允许引用明确公开的共享类型 / 纯函数契约，如 `PanelFaceProps`、ensoulpack 格式；这不是任意引用 `src/shared` 的许可。稳定 SDK 入口尚未实现。
4. **面板的脸只有四样东西**：`panel`（这块面板）、`setText`、`patch`、`fs`。要别的能力就走命令文件回主进程，别自己开洞。
5. **卸载要干净**：插件被移走后，它加的工具、提示片段、设置分区、面板类型必须全部消失（核心是「先卸再装」的逻辑）。
6. **撞内置 kind 的声明一律被忽略**：内置赢（见 `BUILTIN_KINDS`）；撞上已经装了脸的别的插件，先到先得。
7. **密钥不落插件状态**：`.ensoul/state/plugin-params.json` 是明文的，不是放密钥的地方。

## 4 · 组件

一个组件 = 一块面板的**做法**，一个文件：

```json
{
  "id": "panel-mugyf753-3f",
  "name": "番茄钟",
  "kind": "pomodoro",
  "title": "番茄钟",
  "look": { "accent": "#5b8c55", "density": "compact", "showChat": false },
  "spec": { "body": "messages", "systemPrompt": "…" },
  "keywords": ["番茄", "计时"]
}
```

- **一件一个文件**，文件名是面板 id。刻意不挤成一份：两个人各自发布组件时不会 git 冲突，从一大堆里抠一条单独发也别扭。
- 两个位置：出厂组件跟软件走，`.ensoul/library/components/` 跟工作区走（能提交、能发给别人）。
- 应用目录下的 `.ensoul/library/components/` 也是自带组件来源，在任意工作区均可使用。同 id 的工作区做法优先；使用自带组件产生的状态与修改写入当前工作区，不覆盖应用目录的原件。组件库与设置中的组件列表共用核心目录读取接口。
- 导入进去 = **照这份做法新建一块干净面板**，不是把面板本身搬过来（连对话一起搬的是顶上那条收纳区，两回事）。
- 纯数据、无代码、无路径，所以组件导入天然安全：不写任何文件到工作区之外，也不会执行任何东西。

## 5 · 包 .ensoulpack

一个 **zip**，根目录必须有 `manifest.json`：

```json
{
  "spec": 1,
  "type": "plugin",
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "author": "",
  "description": "一句话",
  "host": "^0.1.0",
  "requires": { "plugins": [], "python": [], "tools": [] },
  "files": [ { "path": "index.js", "sha256": "…" } ]
}
```

| 字段 | 说明 |
|---|---|
| `spec` | 规范版本，不认识就拒绝安装（报明确的话，别静默跳过） |
| `type` | `plugin` 或 `component` |
| `id` | 插件=目录名；组件=面板 id 或自定义名 |
| `host` | 要求的最低宿主版本。**没有这一条，老版本装新插件会静默出错** |
| `requires.plugins` | 依赖的其他插件，缺了要提示；`python` 只**声明不自动装**（见 §7） |
| `files` | 文件清单 + 摘要，安装前逐个校验，对不上就整包拒绝 |

组件包（`type: component`）里 `manifest` 之外就一个组件 JSON，`files` 只有那一条。

## 6 · 出口与入口

**出口**（做包）：挂在「开源打包台」（`git-packager`）。它本来就在管「哪些资产外发」，会写 `.gitignore`、会 `git rm --cached`——多一条「导出选中的组件/插件成一个包」是它份内的事。它自身是排除项、不随开源包外流，位置正好。

**入口**（装包）：

| 装什么 | 落在哪 |
|---|---|
| 组件 | 组件库面板（`library`）加一个「导入」按钮；写入走命令文件回主进程 |
| 插件 | 设置 → 更多 → 「安装扩展包」；落到 `<工作区>/.ensoul/plugins/<id>/` |

两条都要**先弹一次清单再落盘**：要说清「这个包会写哪些文件、要开哪些能力」，用户点了才动手。

> 现有的「安装外部扩展包」（填 npm 包名 / Git 地址）**不是分发的正路**：它实质是跑 `npm install <目标>`，要求用户机器有 node 和网络，没有清单、没有版本、没有卸载。它只适合开发者自己装实验包，规范里不当主路。

## 7 · v1 不做的事

1. **带脸插件的运行期加载**。面板的脸现在是**构建期** glob 收进去的（`import.meta.glob('/plugins/*/panel.tsx')`），所以**工作区插件带不了脸**，只能加工具 / 提示 / 状态。要让外部插件带界面就得让渲染层从磁盘动态执行第三方代码——单独设计安全边界，v2 再谈。
2. **自动装 python 依赖**。`requires.python` 只声明、只提示，不替你 pip。
3. **签名与验签**。`files` 里的 sha256 只防传输损坏，不防有人故意改包。
4. **在线市场 / 一键更新**。v1 只保证「文件到手 → 校验 → 落盘」这一段可靠。
