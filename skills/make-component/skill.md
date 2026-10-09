---
name: make-component
description: 将面板塑造、改写并沉淀为可复用组件的规范与操作指南 —— 涵盖 FLOAT_EDIT 动态重塑协议、内置与插件面板类型选型、spec/actions/fields 规格设计、会话栏侧停靠（chatSide 左右侧边栏）、component_declare 永久声明、克隆与分发导出。
---

# 面板改写与组件化规范 (make-component)

## 零、核心定位：面板 vs 插件 vs 组件

不要把「做组件」和「写插件」混淆：

| 概念 | 本质与载体 | 适用场景 | 动手方式 |
|---|---|---|---|
| **面板 (Panel)** | 运行时的交互工作单元（`kind` + `spec` + `look` + 会话） | 解决当前对话的具体任务 | 默认存在，随时可被塑造 |
| **组件 (Component)** | **面板做法的永久结晶**（定型的规格、提示词与按钮布局） | 沉淀常用工作台、表单工具、监视器、可多开的工作流程 | **不写代码**：`FLOAT_EDIT` 改写 + `component_declare` 声明 |
| **插件 (Plugin)** | 主进程扩展模块（`plugins/<名>/index.js` + `panel.tsx`） | 必须调用系统底层、长期驻留常驻服务、引入专属原生工具 | 编写 CommonJS 后台与 React 前端代码（参见 `make-plugin`） |

> **法则**：能用现有面板类型（内置或现有插件面板）+ 规格表达的，**坚决不写新插件代码**，直接塑造面板并声明为组件。

---

## 一、面板塑造：FLOAT_EDIT 动态改写协议

改变当前面板的形态、标题、按钮与提示词，**无需编写或编译任何代码**，只需在回答末尾附带 `<<<FLOAT_EDIT>>>` 提案块：

### 1. 提案格式标准

```
<<<FLOAT_EDIT>>>
{
  "kind": "可选：切换面板类型（内置或插件类型）",
  "title": "简明贴切的标题",
  "keywords": ["2到3个主题关键词，仅用于自动挑选头像，不要写形容词或颜色"],
  "look": {
    "accent": "#5b8cff",
    "density": "compact|normal|roomy",
    "showChat": true
  },
  "spec": {
    "body": "messages|code|table|form|web",
    "systemPrompt": "这块面板专属的角色/任务系统提示词",
    "actions": [
      { "id": "act_1", "label": "执行排查", "prompt": "点击后向对话注入的指令" }
    ],
    "fields": [
      { "key": "target", "label": "目标对象", "type": "text" },
      { "key": "enable_cache", "label": "开启缓存", "type": "bool" }
    ]
  },
  "rationale": "改动理由，记录在修订历史中"
}
<<<END_FLOAT_EDIT>>>
```

### 2. 面板类型 (kind) 选型表

- **内置原生类型**：
  - `chat`：纯对话交互。
  - `form`：结构化输入表单，通过 `spec.fields` 定义字段，配合 `spec.actions` 快速提交。
  - `table`：结构化表格与数据罗列。
  - `editor`：文本/代码编辑面板。
  - `files`：目录与文件浏览。
  - `web`：网页与外部仪表盘嵌入。
- **现有插件扩展类型**：
  - `pomodoro`（番茄钟）、`canvas`（无限画布）、`billing`（实时计费）、`notes`（便签）、`sticker`（便利贴）、`dispatch`（调度中心）、`codex-radar`（额度雷达）等。

---

## 二、重要特性：会话栏侧停靠 (chatSide)

为了让包含工作区主体（如表单、代码、画布、浏览器、插件工作台）的组件获得更合理的屏幕纵深，系统原生支持将伴随会话栏**侧置到左右侧边栏**。

### 1. 行为与交互规则
- **适用对象**：**仅对复合组件/非纯对话面板生效**（包含操作主体视图与伴随会话栏的面板，如 `form`、`table`、`editor`、`files`、`web` 或各类插件面板；纯 `chat` 面板由于全屏都是消息流，不提供侧栏切换）。
- **一键轮转**：在面板头部工具栏点击停靠图标（`▭ / ◨ / ◧`），依次在 **底部 (默认 `▭`) → 右侧 (`right` `◨`) → 左侧 (`left` `◧`) → 底部** 轮转。
- **外观类响应**：面板根节点会自动附带 `chat-side-left` 或 `chat-side-right` 类名，外层 flex 方向变为横向 `flex-direction: row`，主视图与会话区横向自适应并排。
- **窄栏里的默认值**（侧停特有，别按贴底部的习惯推）：
  - **历史会话默认收起**。贴底时消息列居中、左右大片留白，历史栏住留白里零代价，所以默认开着；侧面是把一条窄栏一切两半，它一展开正文就只剩一半 —— 于是这个停法下从**收起**开始，要看得点头栏那颗 `☰`。这个开合**只活在当前停法**里，不影响按面板记住的贴底偏好。
  - **头栏是单行且不缩**：里面每一项都 `flex: none` + `nowrap`，装不下的尾部被裁掉；窄栏里「条数」不显示，回退/恢复收成 `↺ ↻` 两个图标。写规格时别再往头栏塞长文案。
  - **待点头那条请求会换行**：`ask-bar` 在窄栏里文字独占一行、按钮落到下一行，不再被压成竖排。
  - **侧停是「整块缩放」，不是改宽度**：侧栏里的会话区整体 `zoom: 0.8`（`chat.css` 的 `.chatdock.is-side-*` 里的 `--side-zoom`），宽度本身还是用户拖的那个值（默认 `SESSION_W_SIDE`）。这层 zoom 叠在面板自己的 `uiZoom` 之上，所以 `ui/zoom-space.ts` 的 `zoomScale()` 必须**连乘**各层 zoom，否则拖动差一个倍率、指针到了栏不跟。**高度只写 `100%`**：zoom 下百分比是按缩放后的空间算的，`100%` 就等于填满；写 `calc(100% / 倍率)` 会变成 125%，多出来的那一截被面板裁掉，贴底的输入框整条不见。宽度是另一回事 —— 要固定 360 视觉像素就得除以倍率换算成本地像素。
  - **别让 `width: 100%` 的元素再吃边距**：窄栏里 `.composer`、`ask-bar` 这类原本按居中列给满宽的东西，改边距时必须同时把宽度改成 `auto`，否则 100% + 左右边距 = 从栏的右边缘支出去一截。
  - **窄栏里禁横向滚动条**：`.dock-log` 在侧停时加 `overflow-x: hidden`，**并且**把整块会话区的横向滚动条高度压成 0（`.chatdock.is-side-left ::-webkit-scrollbar:horizontal { height: 0 }`）—— 只加 `overflow-x` 挡不住内容里表格 / 代码块各自那一层，那条横杠会落在输入框正上方，看着像个可疑的拖动条。

### 2. 声明与持久化契约（全链路已打通）
- **通过 FLOAT_EDIT 原生改写**：可以在改写提案中直接指定侧置停靠及宽度：
  ```json
  {
    "kind": "form",
    "title": "API调试台",
    "chatSide": "right",
    "chatWSide": 400
  }
  ```
- **挂载位置**：`chatSide?: 'left' | 'right'` 与 `chatWSide?: number` 保存在 `Panel` 根对象上（**不进入 `look`**，避免污染外观主题判定）。
- **组件做法自动纳管 (Craft)**：已接入 `putCraft`、`withCraft` 与 `openCraftAsPanel`。组件声明后，其侧栏停靠偏好与侧栏宽度会随做法文件永久保存，克隆 (`component_clone`) 或从组件库打开时**完整保留侧置状态，不再退回底部**。
- **双轨宽度**：
  - 贴底时使用 `panel.chatW`（基于居中列宽）；
  - 侧停时使用 `panel.chatWSide`（独立侧栏宽度像素）；
  - 两者具有完全独立的量纲，在切换时各自记住上次拖拽的尺寸，互不干扰。

---

## 三、沉淀为组件：生命周期与操作

一块调顺手的面板，只需一步即可沉淀为永久资产：

### 1. 声明为组件 (`component_declare`)
当面板改写完毕、提示词与规格确认好后，调用工具：
```js
await tools.component_declare({
  name: "组件唯一英文标识或短名", // 例如 "api-debugger" 或 "godot-helper"
  panelId: "可选，留空默认当前面板"
});
```
- **永久驻留**：声明后的面板被永久记录在应用数据区（不会因关闭而丢失），在 **设置 → 组件** 以及组件选择器中永久可见。
- **做法与数据解耦 (Craft)**：
  - 系统会将做法写入 `.ensoul/crafts/<id>.json`；
  - **白名单持久化**：做法仅保存 `kind`、`title`、`look`、`spec`；
  - **动态 text 剔除**：`spec.text`（如浏览器当前 URL、临时运行输出）会自动剔除，避免污染可分发模板或产生 Git 脏数据。

### 2. 实例化复用 (`component_clone` / `template_open`)
- **克隆新实例**：调用 `component_clone({ id: "面板ID" })`，立即照该组件克隆出一块独立的新面板与新对话上下文，原件毫发无损。
- **从模板开启**：调用 `template_open({ name: "组件名" })` 开启干净的初始面板。

### 3. 分发与打包 (`packager_export_pack`)
若要分享给他人或提交到开源仓库：
```js
await tools.packager_export_pack({
  id: "panel-xxxx",
  type: "component",
  outPath: "exports/my-tool.ensoulpack"
});
```
将生成标准的 `.ensoulpack` 组件包文件。

---

## 四、组件设计最佳实践

### 1. 打造操作型工作台 (Form + Actions)
- 将 `kind` 设为 `form` 或保留 `chat` 并提供 `spec.actions`；
- 在 `spec.actions` 里配置 2~4 个高频操作按钮（如「检查环境」、「生成配置」、「一键修复」），注入明确的指令字符串；
- 将业务约束与角色规约写入 `spec.systemPrompt`。

### 2. 面板定型与头像机制 (Keywords)
- 当面板从「新面板」重命名时，在 `FLOAT_EDIT` 提案中提供 **2~3 个中文主题词**（如 `["接口", "调试"]`）；
- 系统会自动根据词库分配匹配的头像家族（`look.avatarKey`），此后永久冻结。

### 3. 撤销与清理
- 如果不再需要保留组件声明，调用 `component_remove({ key: "组件名或面板ID" })`；
- 撤销后面板仍可继续作为普通面板使用，但从组件库列表中除名。
