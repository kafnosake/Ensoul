---
name: fix-build
description: 构建失败、改完代码界面没反应、报错看不懂时，按这个顺序排查
---

# 改了没反应 / 构建失败，怎么查

**这个软件跑的是 `dist/`，不是 `src/`。** `electron .` 只读 `dist`。
改了源码没构建，界面一定没反应，而且**无显式异常提示** —— 这是最隐蔽的一种排查陷阱：
不是报错，是静默地跑旧代码。

## 顺序

1. `build_project` 拿完整错误。报错都在输出的**末尾**，前面全是噪声。
2. 主进程报错（`src/main/**`）→ `tsc` 会指出文件和行号，直接去改。
3. 渲染层报错（`src/renderer/**`）→ vite 通常只说哪个文件、不说行号，
   去那个文件找最近动过的地方。
4. **类型错误的头号来源**：改了 `src/shared/types.ts` 的字段，忘了同步另外两处。
   加一个字段通常要动三个文件：`shared/types.ts`、`renderer/core/api.ts`、
   `preload/index.ts`。少一个就是编译不过。
5. 构建过了但界面还是旧的 → 只是没重启。`restart_project`。

## 几种"看起来像错误、其实不是"的情况

- `spawn EPERM` / `Access is denied`：沙箱或杀软挡住了子进程。换一条命令，别硬顶。
- 端口占用 / 新旧实例打架：旧实例没死干净。先 `stop_project`，再 `restart_project`。
- `npm` 报 `Could not determine Node.js install directory`：这是 npm 的 PowerShell
  包装脚本（`npm.ps1`）找不到安装目录，不是项目的问题。用 `cmd /c "npm run build"`
  或直接调 `node node_modules/typescript/bin/tsc`。
- `启动.cmd` 每次都会构建，所以双击启动拿到的永远是最新产物；
  但 `restart_project` 走 `needsBuild()` 判断 —— 源码比产物新才构建。

## 构建通过 ≠ 改动生效

还要过一次 `restart_project`。而且如果改的是**主进程**（`src/main/**`），
重启是必须的；改渲染层同样需要重启，因为窗口加载的是构建产物，不做热更新。
