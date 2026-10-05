---
name: ensoul-map
description: 这个软件自身的接线地图：系统提示、工具表、面板类型、技能、插件各在哪
whenToUse: 要改这个软件本身（提示词、面板、插件、工具）时，先读这条，别先翻源码
---

# ensoul 接线地图

照着这张表直接去改。**不要为了「搞清楚项目里有什么」而全盘搜索** —— 那张表就在下面。

| 要改的东西 | 唯一真源 / 落点 |
|---|---|
| 系统提示词（**只放指令**） | `src/main/chat-core.ts` 的 `buildSystemPrompt()` |
| 面板此刻的事实（标题/种类/位置/外观/规格） | `chat-core.ts` 的 `buildPanelSnapshot()`，由 `index.ts` 拼在**本轮用户消息最前面**。不进系统提示 —— 面板一改就会打掉缓存前缀 |
| 提示里「有哪些面板类型」 | 运行时生成：内置取 `src/shared/types.ts` 的 `BUILTIN_KINDS`，插件取各自 `panel` 声明，拼接点在 `src/main/index.ts` |
| 模型能用的工具清单 | `src/main/agent.ts` 的 `toolsFor()`。它随每轮请求的 `tools` 字段发出去，**提示里不复述** |
| 内置面板类型 | `src/shared/types.ts` 的 `BUILTIN_KINDS`；渲染注册表 `src/renderer/panel/registry.tsx` |
| 插件自带的面板类型 | `plugins/<名>/index.js` 里的 `panel: { kind, label, hint }` |
| 技能 | `src/main/skills.ts`。提示里只有「名字 + 一句话」，正文用 `use_skill` 按需取 |
| 技能目录优先级 | `<工作区>/.ensoul/skills` → `.dsh/skills` → `.agents/skills` → 用户级同名目录 → 软件自带 `skills/`。重名时**先出现者赢** |
| 插件 | `plugins/<名>/index.js`；状态写 `.ensoul/state/<名>.json` |
| 面板**私有**的临时产物 | `<工作区>/.ensoul/panels/<面板 id>/`。路径由 `src/main/fsapi.ts` 的 `panelSpaceDir()` 拼、`dropPanelSpace()` 收。核心的 spill（单次输出 >2 万字就落盘）落在这儿 —— 放平铺目录里，任何面板 `list_dir` 一下就能读到别人跑过什么命令。只在「真删」（收纳区删条目 `/` 彻底忘掉最近关闭）时回收；关面板不是删，一个字都不动 |
| 嵌入（悬浮）面板的位置与缩放 | 位置**按比例**存：`src/shared/types.ts` 的 `PanelFloat.rx/ry` + `floatRatio()`；折成像素、夹进母体在 `src/renderer/panel/FloatPanel.tsx`。缩放由 `src/renderer/panel/FitBox.tsx` **自动**做：滚不动的整块缩放装进容器、滚得动的自己滚（例外 `data-fit="off"`），**面板不用声明任何东西**（规则见技能 `make-plugin` 第四节） |
| 界面此刻长什么样 | 别猜，先调 `describe_layout` |
| 启动/构建 | `build_project`、`restart_project`（改完源码必须两个都走，不重启界面一个字都不会变，还不报错） |

插件能挂的钩子（`src/main/plugins.ts` 的 `PluginHost`，照真名抄，别猜）：

`addTool` / `onBeforeWrite`（只在 `write_file` `edit` 且内容真变了时触发）/
`onBeforeTool`（任何工具执行**前**，返回一句话即拦下）/
`onAfterTool`（任何工具执行**后**、结果交给模型**前**，返回一句话即换掉结果）/
`addPrompt`（每轮前一次，正文进该面板的系统提示）/ `addStatusItem` / `ask` / `send` /
`panels()` / `componentRefs()` / `createPanel` / `openComponent` / `log` / `workspace` / `state.load|save`

`onBeforeTool` 与 `onAfterTool` 的分工：**前一个管「放不放行」，后一个管「结果怎么给你看」**。
after 是加工不是设卡 —— 它换内容，拦不住调用；已在用的例子是 `plugins/loop-guard`（连续重复调用追一句提醒）。
before 的现成例子是 `plugins/read-guard`（没读过的文件不许 `edit`/`write_file`，返回一句话即拦下）。

`addPrompt` 每轮返一段正文，跟着**本轮用户消息的末尾**走（`index.ts` 的 `pluginExtras`），
不进系统提示 —— 所以它每轮怎么变都行，动不了那截稳定前缀，插件拿它报进度是正当用法。
（`plugins.ts` 该接口的注释和 `pluginExtras` 的头注释都还写着「进系统提示」，是行为改过没跟着改的旧话。
判断这类事**看拼装点，别信注释**。）

## 分流：新东西该放哪
- 先问「插件能不能做」。能 → `plugins/<名>/`，看技能 `make-plugin`。
- 核心只留插件做不到的：界面渲染、停靠树、对话循环、工具管线、系统提示装配。
- 加工具看技能 `add-tool`；构建报错看 `fix-build`；改提示词看 `prompt-protocol`。

## 动手前先核行尾（踩过一次，白花了二十分钟）
这个仓库**行尾不统一**：`src/main/index.ts`、`src/main/plugins.ts`、`src/main/store.ts`、`src/main/fsapi.ts` 是 **CRLF**，
`src/main/chat-core.ts`、`src/main/agent.ts`、`skills/*.md` 是 LF。

`edit` 的多行锚点是按 `\n` 去匹的，**在 CRLF 文件上必然报「没找到这段原文」，而单行锚点照常成功** ——
症状就是「同一个文件，改一行行、改两行不行」。遇上了先核行尾，别怀疑自己抄错：

`node -e "const s=require('fs').readFileSync(process.argv[1],'utf8');console.log(s.split(String.fromCharCode(13)).length>1?'CRLF':'LF')" src/main/index.ts`

对策：要么只给单行锚点，要么写个临时脚本按文件实际行尾拼锚点（命中数不等于 1 就抛错），改完把脚本删掉。
