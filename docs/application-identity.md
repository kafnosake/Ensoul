# 应用图标、名称与进程身份

`app.setName()` 只控制 Electron 内部名称，不能把操作系统里的 Electron 进程变成 ensoul。因此日常启动入口使用 `scripts/brand-runtime.js` 生成的应用壳：Windows 可执行文件为 `ensoul.exe`，文件说明、产品名、内部名与图标一起写入；macOS 使用 `ensoul.app`、主可执行文件 `ensoul` 及 packager 命名的 ensoul Helper 辅助应用。

`启动.cmd` / `启动.command`、`npm start`、`npm run app` 最终都走 `scripts/launch.js`。它先准备平台 Electron、按需构建，再准备或复用应用壳。启动器不会安装 npm 依赖；新增加的 `@electron/packager` / `sharp` 由安装入口准备。直接手动执行 `electron .` 仍是原始开发壳，系统进程会保留 Electron 名称。

应用壳缓存位于 `.electron/brand/<平台>-<架构>/<指纹>/`。指纹覆盖生成脚本、平台、Electron 版本、应用版本和图标；首次生成尽量复用已有 Electron ZIP，随后启动复用缓存。修改品牌资源生成新的缓存目录，不覆盖正在运行的可执行文件。清理旧缓存前先确认对应进程已经退出。

这是一层有品牌身份的源码宿主，不复制整个项目。启动器通过 `ENSOUL_SOURCE_ROOT` 指向当前 checkout；壳的入口检查项目名称并加载源码目录的 `dist/main/index.js`，路径层也使用这一源码根。插件、组件、源码编辑和构建仍作用于当前项目。缓存里的可执行文件需要通过项目启动入口运行。

macOS 本机生成时使用 ad-hoc 签名，适合本地开发；没有做 Apple Developer 发布签名或公证。macOS 的实际显示与辅助进程需要在 macOS 上确认。Windows 的程序名和版本资源可本机检查，但旧 Electron 实例不会因生成新壳而自动改名，需要退出后从新入口启动。

品牌素材说明见 [assets/brand/README.md](../assets/brand/README.md)。素材变更无需修改应用业务代码；顶栏遮罩由渲染构建处理，主窗口和 Dock / 托盘图标需要重新启动后生效。

依据：[Electron app.setName](https://www.electronjs.org/docs/latest/api/app#appsetnamename)、[Electron Packager 选项](https://electron.github.io/packager/main/interfaces/Options.html)。
