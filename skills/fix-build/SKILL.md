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

## Windows 上"删不掉的小写文件"（TS1261）

报 `TS1261: Already included file name 'D:/ensoul/src/renderer/panel/PanelSurface.tsx' differs from
file name 'D:/ensoul/src/renderer/panel/panelsurface.tsx' only in casing` 时：

**NTFS 不区分大小写，但目录里确实有两个只差大小写的条目。** Node 的 `readdirSync` /
`fs.existsSync` 看不见幽灵项，只有 cmd 看得见 —— 先 `cmd /c "dir /a /b src\renderer\panel"` 确认。

**最要命的一点：`del 小写名` 删掉的是真身。** 区分大小写不成立，`del chatdock.tsx` 就是删 `ChatDock.tsx`。
动手前一定先 `git status`，看到 ` D` 说明源码已经被删了，`git checkout -- <路径>` 恢复。

把内容搬回正确文件名时**不要 `del` + `ren`**（两步都会动真身），用 node 一次做完：

```bash
node -e "const fs=require('fs');const b=fs.readFileSync('src/renderer/panel/chatdock.tsx');fs.unlinkSync('src/renderer/panel/chatdock.tsx');fs.writeFileSync('src/renderer/panel/ChatDock.tsx',b)"
```

先 `unlink` 幽灵项，再 `writeFile` 正确名 —— 读和写都指向磁盘上真实存在的那一个。

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
