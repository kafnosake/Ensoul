# 仓库展示素材

这组素材围绕“随手开面板 → 挂入一块待办 → 便利贴派单 → 员工回执”介绍 ensoul。每个场景只展示一个动作，嵌入场景只保留一块小工具。品牌暂用 ensoul 文字标识，没有使用旧图标。

## 可直接使用的文件

| 文件 | 用途 |
| --- | --- |
| [cover.png](assets/showcase/cover.png) | README 首屏，1400 × 1120 |
| [demo.mp4](assets/showcase/demo.mp4) | 14 秒连续动作演示，1280 × 950，30 fps |
| [demo.gif](assets/showcase/demo.gif) | README 循环演示，1280 × 950，24 fps |
| [embed.png](assets/showcase/embed.png) | 会话中嵌入一块待办，1280 × 850 |
| [collaborate.png](assets/showcase/collaborate.png) | 员工会话与原便利贴完成章，1280 × 940 |
| [share.png](assets/showcase/share.png) | 分享封面，1200 × 630 |

旧版截图、主题拼图与动画已从当前版本移除。新素材使用 125% 渲染缩放，便利贴使用面板自带的 160% 内容缩放。视频以连续缓动轨迹呈现拖动、落点提示、松手挂入与派单。

## 展示口径

一句话介绍：**随手开一块面板，把工具嵌进会话，让面板彼此协作。**

仓库简介：**随手开面板，把小面板嵌进会话，让便利贴和 AI 员工彼此协作。每块面板都有自己的会话与模型，组成由你定义的工作台。Electron / Node.js agent 编辑器。**

英文简介：**Open panels freely, embed tools inside conversations, and let panels work together. Sticky notes hand tasks to AI employees and receive completion receipts. Built with Electron and Node.js.**

建议标签：`agent`、`ai-workspace`、`electron`、`llm`、`nodejs`、`plugins`、`react`、`typescript`。

当前远端为 Gitea。分享封面是可下载素材，没有作为仓库头像上传，也没有更改实例级 Open Graph 模板。

## 画面来源

- 使用已构建的真实 Electron 渲染层；待办、便签、员工列表、会话、落点提示和完成章来自现有界面代码。
- 截图进程使用独立临时用户目录、内存工作区和模拟 IPC。会话与任务为虚构示例，不打开用户实际会话、不启动插件后端、不调用模型、不修改工作区状态。
- 点击「＋」使用现有新建交互；独立工具窗口和挂入提示使用现有窗口界面；便签拖给员工使用现有前端派单处理，并确认隔离 IPC 收到原话。最终布局、生成结果和完成章使用演示状态。
- 光标、窗口与便签移动由脚本合成，采用连续缓动；这是功能演示，不能描述为实际指针操作录像或模型现场生成。14 秒是剪辑时长。
- 不展示被 Git 忽略的私有扩展与暂停开发的桌面组件。挂件指应用内嵌入面板，独立浮窗指普通 Electron 窗口。

发布时保留“真实界面 / 演示数据 / 脚本编排 / 未调用真实模型”说明。界面更新后应重新生成素材。

## 重新制作

需要已有 `dist/renderer` 与 `dist/preload` 产物、本机 Electron。该脚本不运行项目主进程，不需要构建或重启正在使用的 ensoul。

```bash
node scripts/render-showcase.cjs
python scripts/make-showcase.py
```

合成需要 Python、Pillow 和 ffmpeg。当前字体使用 Windows 微软雅黑；其他系统需调整字体路径。Electron 可通过已安装的 `electron` 包定位，ffmpeg 可通过 `FFMPEG` 环境变量指定。

截图与动画中间帧在被忽略的 `.ensoul/tmp/showcase-v3/`，最终素材输出到 `docs/assets/showcase/`。[本地预览页](repository-preview.html) 使用 MP4 自动循环播放。
