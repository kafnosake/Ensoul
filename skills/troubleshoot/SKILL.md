---
name: troubleshoot
description: 快速定位软件报错、改动未生效、暗坑排障与架构真源寻径
whenToUse: 当遇到报错、改了代码界面没反应、edit 工具匹配失败、功能不工作、或不知道某项功能该改哪个文件时使用
---

# 快速定位与故障排查指南 (Troubleshoot & Doctor)

解决"干活很快但找问题找半天资料"的核心原则：**优先使用诊断工具自动化定位，禁止盲目全盘搜索或漫无边际翻阅文档。**

## 一、排障三板斧

| 步骤 | 调用工具 | 适用场景与解决问题 |
|---|---|---|
| 1. **根因定位** | `doctor_diagnose({ query })` | 输入报错文本、堆栈或异常现象（如"edit失败"、"改了没反应"），秒级匹配已知暗坑并输出修复建议 |
| 2. **环境体检** | `doctor_healthcheck()` | 怀疑系统状态异常时调用：自动检测 dist 产物时效、CRLF行尾隐患、插件语法、持久化坏文件与日志报错 |
| 3. **精准检索** | `doctor_search_docs({ keyword })` | 需要查询某项规范细节（如 floatBare、promptCache、panelId隔离）时，切片提取权威文档段落 |

## 二、高频暗坑排查速查

1. **改了源码无任何反应（无报错）**
   - 检查：运行 `doctor_healthcheck`，查看是否提示"源码比编译产物新"。
   - 原因：Electron 跑的是 `dist/`，改了 `src/main` 必须 `build_project` + `restart_project`。
   - 纯界面改动（renderer/shared/插件panel）会由 ui-refresh 在轮次结束后编译上屏。

2. **edit 工具报"没找到这段原文"**
   - 原因：Windows 下 `src/main/index.ts`、`plugins.ts` 等核心文件是 **CRLF** (\r\n)，多行匹配因 \n 失败。
   - 对策：改用单行唯一锚点；或者编写 node 临时脚本读取实际行尾进行局部替换。
   - **注意**：写入工具用错大小写的路径（`chatdock.tsx` 而不是 `ChatDock.tsx`）会在 NTFS 上留下
     幽灵目录项，报错形态完全不同 —— 见下面第 6 条。

6. **TS1261 "differs ... only in casing"（Windows 幽灵文件）**
   - 现象：tsc 说 `PanelSurface.tsx` 和 `panelsurface.tsx` 都被纳入了，但源码里明明只有一个。
   - 原因：NTFS 不区分大小写；写入工具用了与仓库不同的大小写，目录里就有了两个只差大小写的
     目录项。**Node 的 `readdirSync` / `fs.existsSync` 看不见幽灵项，只有 cmd 看得见。**
   - 查：`cmd /c "dir /a /b <目录>"`（别信 `list_dir` 和 `readdir`）。
   - **致命坑：`del 小写名` 删掉的是真身。** 先 `git status` 确认（出现 ` D` 就是被删了），
     `git checkout -- <路径>` 恢复；搬回正确名字要用 `unlink(幽灵)` + `writeFile(正确名)`，
     不能 `del` 再 `ren`。

3. **类型报错 Property does not exist / BUILTIN_KINDS 冲突**
   - 原因：改动跨进程契约漏掉了三件套同步。
   - 必改三处：`src/shared/types.ts`、`src/renderer/core/api.ts`、`src/preload/index.ts`。

4. **挂件/悬浮面板看得见摸不着（点击穿透）**
   - 原因：声明了 `floatBare: true`，但未在对应 `panel.css` 中为按钮/卡片补充 `pointer-events: auto`。

5. **两个同类面板数据互相覆盖（串味）**
   - 原因：插件状态保存在全局单例中，未按 `panelId` 分槽隔离。
   - 对策：`state` 和回调均按 `ctx.panelId` 隔离。

## 三、唯一真源落点检索表

- 系统提示词指令：`src/main/chat-core.ts` (`buildSystemPrompt`)
- 运行时面板快照：`src/main/chat-core.ts` (`buildPanelSnapshot`)
- 模型工具分发：`src/main/agent.ts` (`toolsFor`, `runTool`)
- 内置面板类型：`src/shared/types.ts` (`BUILTIN_KINDS`) + `src/renderer/panel/registry.tsx`
- 插件扩展入口：`plugins/<名>/index.js`（脑）+ `plugins/<名>/panel.tsx`（脸）
- 插件状态持久化：`.ensoul/state/<名>.json` 与 `.ensoul/state/<名>.cmd.json`
- 面板私有隔离产物：`.ensoul/panels/<面板id>/`
