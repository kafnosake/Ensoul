# 桌面宿主与主题材质：实施草案

本文件保留初始方案与交接任务，并记录后续验证；当前进度以最新桌面约束一节为准。审查日期：2026-10-05。首先面向 Windows；半透明与圆角悬浮设计为纯视觉表现，不代表已经支持 macOS 的桌面交互。


## 2026-10-05 创建流程与卡顿修复（覆盖下方早期约束）

最新流程：双击或框选创建组件方框，方框下方只显示一次需求输入；Enter 提交，Shift+Enter 换行。设置 → 桌面组件新增生成模型选择，未单独指定时使用本体默认模型。提交由插件固定模型并发起一轮正常会话，收起输入区并恢复原方框高度；聊天与推理继续留在本体。已提交状态持久化，重复提交不会启动第二轮；模型尚未产出可显示类型时不报告组件已经完成，可回本体继续修改。

性能证据与修复：

- 原拖动每帧走 widget:move → refresh → 全部窗口原生标记同步与工作区广播；save 本身已防抖，不能误称每帧写盘。改走已有本地窗口硬件消息，仅移动当前窗口，松手保存和广播一次；静止点击没有位置变化时不保存。
- 桌面插件只在原生参数真正改变时设置置顶/任务栏标记；卸载恢复原方法。600 次同参数同步，置顶重复调用 0 次、任务栏调用 1 次。
- 全局鼠标 hook 在空闲移动和组件拖动时不解码坐标；各 1,000 次移动的解码次数为 0。真实桌面框选仍监听移动，事件照常透传。
- 原生移动使用 NOSIZE，尺寸调整使用 NOMOVE，避免分数 DPI 下回写不必要的尺寸/位置。隔离探针在本机约 133.75% 缩放下验证物理窗口及渲染像素尺寸不变；位置允许最多 1 个物理像素的坐标舍入。

锁定的嵌入/悬浮挂件改为右键长按 900ms 出现进度圈并解锁；短按保留原右键行为，松开、移动超过 8px、取消、失焦、Esc 等撤销手势。输入控件不触发解锁，解锁后仍可用锁定按钮重新锁定。

验证：类型门禁无新增问题、渲染构建通过；插件 hook、生命周期、原生坐标、拖动及创建流程隔离检查通过。实际 React/Electron 创建探针验证输入框、重复 Enter 仅派发一次、单次最终位置提交和按钮交互；长按解锁通过 12 项 DOM 行为检查。这里没有消耗真实模型额度做功能生成，也未以计数改进冒充真实 FPS 或“所有卡顿已根治”。全局鼠标 hook 仍在 Electron 主线程，繁重同步工作仍可能影响它，独立监听进程是后续性能检查方向。

生效：已重挂桌面插件、恢复用户已开启的桌面手势，并刷新当前两扇应用界面；读取模块 URL 确认两者均加载本次构建的同一渲染包。没有重启主进程。

## 2026-10-05 最新桌面约束与修复

本节覆盖后文旧草案中“复用 PanelSurface、实色黑卡和默认对话入口”的设计。用户最新要求：桌面组件安静、轻量、样式统一，优先速度、稳定、质量、易用与美观。

- 桌面使用独立 `DesktopSurface`，只渲染功能主体。普通面板的聊天、动作栏、缩放、默认标题与未知类型提示不进入桌面；空 chat 类型保持空白。会话和推理在 Ensoul 编辑窗中继续保留原 panelId，未迁移或删除历史。
- 宿主统一提供背景约 72%–78% 不透明度、8px 圆角、白色主文字、浅灰次文字和 8px 间距。没有外阴影和外围底板；根背景透明。功能内容用透明根节点和宿主 token，避免重复叠底与整窗 opacity。
- 通用样式：`desktop-stack`、`desktop-row`、`desktop-value`、`desktop-label`、`desktop-button`。生成提示要求使用这套样式，避免每个组件重新试风格；普通运行依靠本地状态与插件，模型只在编辑时参与。这里的运行策略是生成约束，不代表已禁止所有第三方插件自行调用模型。
- 编辑/收回/删除按钮改为悬停时显示的小图标。组件空白处与顶部细拖动区可拖动；按钮、输入控件和 `data-desktop-interactive` 区域继续处理自身交互。
- 桌面宿主移除原生边框样式。它仅为自己的窗口包装 `setBounds`，把屏幕 DIP 转为物理坐标再转成父窗口坐标；仅移动时保持原尺寸。卸载与关闭恢复原方法和样式，核心不依赖桌面插件。

验收：类型门禁无新增问题、渲染构建成功、插件手势/挂载/失败回退测试通过。`node scripts/test-desktop-widgets.cjs` 使用独立 Electron 实例和伪工作区，不调用模型、不写真实面板状态；检查静默占位、背景 alpha=191/255、圆角外 alpha=0、真实原生窗口拖动 60×30 DIP 且尺寸不变、浅主题文字、聊天隔离和按钮点击。测试预览写 `.ensoul/tmp/desktop-glass-preview.png`。

当前范围内可靠性高；各 DPI 组合、Explorer 重启和 Win+D 仍需单独人工验收。半透明渲染已经验证，壁纸的真正原生模糊尚未验证；CSS blur 不能跨窗口模糊壁纸，不能把当前效果宣传为已完成的原生磨砂。换成 WebView2 也仍需处理原生桌面宿主与合成关系。

## 当前实施进度

2026-10-05 完成 T1 的首批渲染层改动：深浅模式分别保存自定义背景色，主要背景层支持 60%–100% 不透明度，提供配色重置，并改善自定义强调色的主按钮文字对比。沿用 localStorage 与跨窗口通知；原生窗口材质接入时再迁移权威设置到主进程。

入口：设置 → 外观 → 主题。最新设置收敛为三个项目：浅色/深色模式、主题色色卡、窗口不透明度。移除自由取色、窗口底色与强调色透明度的独立配置。窗口不透明度当前控制软件内部背景层，窗口的基底保持实色，不会透出桌面。原有“界面内毛玻璃”仍属于效果开关，未修改主进程，未实现 T2/D0。

色卡同时派生窗口底色、内容表面、选中态与强调色；浅色和深色共用色卡，但模式决定明暗和文字颜色。背景混合预先合成一次，嵌套 DOM 不再重复染色。默认色卡与 100% 不透明度完全回落到原有 CSS。旧强调色若匹配预设则迁移到对应色卡，其余旧自定义颜色回到默认；旧背景色与强调色 alpha 移除，模式与背景不透明度保留。

类型门禁通过（没有新增问题）、渲染构建通过；临时逻辑检查覆盖默认样式保留、颜色转换、alpha 范围、重新加载保存值、跨窗口同步、强调色文字对比、深浅切换与重置。尚未在真实 Electron 界面做视觉验收。

2026-10-05 补记（D0/D2 之后的状态）：**桌面宿主（D0）已在 `plugins/widget-dock/desk-host.js` 落地并实测可用** —— 本机 `available()` 返回 true，能认到 Progman + SHELLDLL_DefView，走的是 WS_CHILD + SetParent（顺序不能反，见该文件头），手势用 WH_MOUSE_LL 旁听、从不拦截。**D2 的卡面这一半本轮补齐**：`PanelWidget.card` 是三处一起接的（`types.ts` 声明 → `store.floatWidget` 记下 → `windows.openWidget` 据此让窗口透明），卡面由 `WidgetShell` 的 `.widget-card` 自己画（窗口不透明时圆角会被底色填成直角）。此前 `plugins/widget-dock/DesktopSurface.tsx` 与 `desktop.css` 是**死代码**（没人 import，产物里从没有过 `.desktop-card`），本轮已删；`.desktop-editor` 的样式也从那份没被加载的 css 搬进了 `styles/shell.css`。

**仍未按草案做的**：`PanelWidget` 没有 `placement` / `displayId` / `locked` 字段，桌面归属由插件账本 `.ensoul/state/widget-dock.json` 的 `deskPanels` 自己管（核心不知道"桌面层"这回事）。这偏离了草案 §一 的契约，但保住了"核心只认挂件窗口、沉不沉由插件定"的分界 —— 要不要按草案把 placement 升进 shared，留待定。D3（每显示器壁纸）未做。

2026-10-05 可见性修复：在本机独立 Electron 窗口中复现了“父窗口正确但卡片在屏幕外”：挂载前 `(80, 80)`，挂载后 `(-2080, -2295)`，同时返回成功。修正为挂载前保留屏幕坐标、挂载后用 ScreenToClient 转换；修正 HWND_TOP（0）误写为 HWND_BOTTOM（1），先撤销置顶再设置子窗口层级，并检查 SetWindowPos 的返回结果。修正后物理坐标和 Electron DIP bounds 均保持不变。

创建流程现在等待窗口显示和页面加载，再等待实际挂载；失败会报告错误并将面板收回应用。生命周期同时响应 show/did-finish-load，跳过隐藏或加载中的窗口；重挂插件时明确清理它自己的辅助模块缓存。聊天类型卡片显示紧凑的编辑入口，已定义的其他面板继续复用 PanelSurface。

验证：插件手势/失败回退检查、负坐标桌面挂载与定位失败回退检查通过；真实 Electron 挂载保留了位置，卡片中心像素不透明；实际渲染包加载后取得“开始对话”按钮与截图 `.ensoul/tmp/desktop-fixed-preview.png`；类型门禁和渲染构建通过。未将这些检查扩大解释为所有 DPI、Explorer 重启或 Win+D 交互已全部通过。

## 已确认的问题

| 位置 | 当前行为 | 与目标的差距 |
| --- | --- | --- |
| `src/main/windows.ts` 的 `openWidget` | 无边框、默认置顶，独立于主窗口 | 是全局挂件，尚未挂在系统桌面层 |
| `src/shared/types.ts` 的 `PanelWidget` | 保存窗口位置、透明与置顶状态 | 缺少明确的桌面宿主身份与显示器归属 |
| `src/renderer/shell/WidgetShell.tsx` | 已复用 `PanelSurface`，另有对话编辑窗口 | 可以沿用内容与编辑体验，不必重新造组件系统 |
| `src/main/index.ts` | 托盘常驻时，全部窗口关闭也保留进程 | 常驻基础已有；仍需区分主窗口关闭与真正退出 |
| `src/renderer/ui/theme.ts` | 深浅模式、整套主题色卡、背景不透明度、CSS 毛玻璃开关 | 背景 alpha 只在界面内部合成，原生窗口材质未接入 |
| `src/main/windows.ts` 的主窗口 | 固定不透明底色，无系统材质设置 | 页面内模糊无法直接获得窗外毛玻璃 |
| `base.css` / `shell.css` | body 与主要壳背景不透明；部分弹层使用 CSS 模糊 | 即使加上原生材质，页面覆盖层也可能将效果完全挡住 |

注意：`shell.css` 后面已有 widget 背景透明的覆盖规则；不要只读前面的公共规则就误判整个 widget 壳始终不透明。不过 body 的底色和面板内容仍需分别检查。

## 一、桌面组件：增加宿主，复用面板

功能继续属于面板/插件，系统桌面位置属于运行时。番茄钟、计费器、桌宠不各写一份窗口代码。

链路：面板及其会话、状态 → 现有 PanelSurface → 桌面外壳 → 系统桌面适配器。

第一版在现有 `PanelWidget` 上增加可选 placement，旧存档缺省仍为 overlay，保留旧置顶挂件行为。未来再统一 dock/embedded/floating/desktop 宿主，不在这一轮迁移整套停靠树。

```ts
// 契约草案，名称可以根据现有接口调整。
type WidgetPlacement = 'overlay' | 'desktop';

interface DesktopPlacement {
  displayId: string;
  x: number; // 显示器内的 DIP 坐标
  y: number;
  width: number;
  height: number;
  locked: boolean;
}

interface PanelHostContext {
  kind: 'dock' | 'embedded' | 'floating' | 'overlay' | 'desktop';
  bounds: { width: number; height: number };
  capabilities: {
    interactive: boolean;
    desktopAttached: boolean;
    nativeBackdrop: boolean;
  };
}
```

placement 是用户选择，desktopAttached 是实际挂载结果，两者不能混为一谈。显示器标识失效时重新匹配并将位置收回可见区域；同时处理负坐标显示器与 DIP/原生像素换算。

面板得到真实 host context，LLM 每轮从现有 `buildPanelSnapshot` 获得它。位置事实放动态快照，不反复改系统提示词前缀。面板移动宿主时，沿用同一个 panelId、会话、功能状态和任务；不要再创建一个代理。

常态只显示紧凑内容；右键提供“编辑功能 / 调整位置 / 收回软件”。编辑打开现有普通对话窗口，不要求桌面卡片承载完整聊天区。默认锁定位置，但功能按钮仍可点击；“锁定”不能等价于“鼠标全部穿透”。

### Windows 原生层：先做一个可点击卡片的实验

Electron 的 `alwaysOnTop: false` 只取消置顶，不会使窗口成为桌面的一部分。Windows 也没有可直接依赖的 Electron `type: 'desktop'`。窗口类型具有平台差异，见 [Electron 窗口参数](https://www.electronjs.org/docs/latest/api/structures/base-window-options)。

候选路线是 Explorer 桌面窗口结构（Progman / WorkerW / DefView）加原生窗口挂载。项目已有 koffi，适合先做隔离的小实验；是否最终直接使用 koffi，或改用独立原生宿主，取决于实验中的 DPI、输入和 Electron 窗口生命周期结果。

不要照抄一个旧教程，把“找到 WorkerW + SetParent 成功”当作完成。不同桌面结构需要识别，Windows 更新也会改变它。Lively 的维护者已讨论过新桌面结构和输入/挂起问题，见 [维护者说明](https://github.com/lively-community/lively/discussions/3004)。这个路线是工程候选，不是稳定公开的完整桌面插件契约。

壁纸与可交互卡片必须分开验收：

- 壁纸通常位于图标后面，不接管点击。
- 卡片需要收到按钮点击，同时普通应用能盖住它，卡片外的桌面图标仍可操作。
- 挂在图标后面得到一个“看得见但点不到”的卡片，不能算完成。先验证桌面子窗口层级与命中区域，再决定最终挂载方式；不以全屏透明窗口吞掉桌面点击来补救。

原型只放一个黑色圆角卡片和一个按钮，不接 LLM、不接动画、不加主题配置。先过以下人工验收：

1. 普通应用能盖住它；Win+D 后仍处于桌面，并且按钮可点击。
2. 桌面图标的打开、拖动、右键和空白区域框选仍正常。
3. 关闭/最小化 Ensoul 主窗口，卡片仍在；托盘真正退出后卡片消失。
4. Explorer 重启、睡眠恢复、切换显示器后可以重新挂载；失败时不留下悬浮空白窗口。
5. 100% / 150% / 200% 缩放及双屏下，位置与点击区域相符。
6. 退出能够恢复/释放原生关系、监听与窗口，不修改系统壁纸存档，也不关闭 Explorer 的窗口。

`SetParent` 本身不会自动改好窗口样式；跨进程、不同 DPI awareness 的挂载可能产生额外行为，参见 [Microsoft SetParent 文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent)。这些是原型必须解决的机制，不应分散到每个业务插件里。

建议新增 `src/main/desktop-host.ts` 和 Windows 适配模块，窗口管理器只调用 create/attach/detach/restore。原生句柄不传给 LLM 或面板脚本。attach 失败返回明确状态，保留面板内容，允许用户收回；不要悄悄变成置顶悬浮窗。

### 外观与运行成本

按用户要求，桌面卡片默认采用不透明近黑底、14–18px 圆角、细高光边、柔和渐变和少量纹理，形成磨砂材质观感。底色完全不透明时看不到真实背后模糊，这是正常的；如果后来允许透出背景，再提供另一种真实玻璃材质。

圆角要连同原生窗口边界一起验证，不能只有网页圆角、外面仍有黑色矩形。桌面挂载后的子窗口不预设能使用 DWM acrylic；第一版黑色卡片不依赖该效果。

先少量卡片，一块一窗口便于沿用现有运行时。记录实际 renderer 内存和 GPU 占用后，再判断是否需要一个显示器共用宿主；不要一开始就为假定的几百块卡片重写渲染系统。

LLM 只在用户要求定义/修改功能时工作。倒计时、计费、动画由代码运行；例如倒计时保存 endAt，每次绘制计算剩余时间，后台插件负责到期动作，不能依赖被遮挡窗口中的精确 setInterval。锁屏/全屏时暂停昂贵动画，业务状态继续。Windows 遮挡不会可靠地转成网页 hidden，见 [Electron 可见性说明](https://www.electronjs.org/docs/latest/api/browser-window#page-visibility)。

动态壁纸后续复用同一适配器，增加每显示器一块的 wallpaper surface。首版先 HTML/CSS/Canvas；three.js 可以作为内容插件能力，不必先增加一套壁纸功能框架。

判断：面板复用与黑色材质可靠性高；Windows 真正桌面挂载可靠性中等；“桌面挂载 + 交互 + 系统毛玻璃”组合尚未验证。没有实机原型，不给出百分比成功率。

## 二、主题：颜色、背景 alpha、系统材质分别管理

CSS `backdrop-filter` 用于网页内层叠内容；不能靠它模糊另一个应用窗口。Electron 明确列出这一限制，见 [透明窗口限制](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles#limitations)。

主题设置只保留深浅模式、主题色色卡、窗口不透明度三项。“默认”色卡恢复原有配色，不重置模式或不透明度。色卡管理整套背景与强调色，用户不需要手动选颜色；材质开关保留在效果区。原生材质接入前，滑块文案明确不会透出桌面。

```ts
// 持久设置与实际支持能力分开。
interface AppearanceSettings {
  version: 1;
  mode: 'dark' | 'light';
  accent: string;
  background: string;
  surfaceOpacity: number; // 背景着色层，不能作用于整棵 UI
  material: 'solid' | 'glass';
}
```

先用现有颜色变量，增加语义：窗口着色、侧栏、内容表面、弹出表面、文本、边框。不要一次替换所有 CSS 变量；现有 `--bg` / `--panel` / `--pop` 等逐步映射，先覆盖主壳、侧栏、面板、输入区、弹窗和浮窗。

主背景只铺一次着色层，内容区域叠加很薄的层次，避免 body、shell、panel 多层重复的高 alpha 把玻璃再次堵死。文本、按钮文字、图标保持清晰，不能使用容器 `opacity` 或 `BrowserWindow.setOpacity` 实现背景透明度。自定义强调色还应派生适合的按钮文字颜色；任意浅色配固定白字会难读。

主题应用建立一条链：持久设置 → 派生 CSS token → 渲染层背景 → 原生窗口材质。涉及原生窗口后，主进程持有规范化设置并广播所有宿主；已有 localStorage 值做一次迁移或作为启动缓存，不能两边各自成为权威。保留现有字体/动效偏好，不为这个任务改写其他设置。

### 真正的窗外毛玻璃

本地 Electron 33 类型声明已包含 `setBackgroundMaterial`，不需要仅为尝试该 API 升级 Electron。在 Windows 11 22H2 / build 22621 及以后，优先实验 acrylic；macOS 使用 vibrancy；不支持的系统明确回到实色材质。

Electron 的 API 与支持版本见 [setBackgroundMaterial](https://www.electronjs.org/docs/latest/api/browser-window#winsetbackgroundmaterialmaterial-windows)。Mica 与 Desktop Acrylic 是不同材质；本需求强调磨砂、弱化背后物体，优先评估 acrylic，而非把任意 Mica 效果都叫作同样的玻璃。参见 [Microsoft 系统材质说明](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwm_systembackdrop_type)。

先用最小普通窗口验证当前 Electron 33、无边框、背景 alpha 和 acrylic 的组合，再接主壳。不要盲目混用 `transparent: true`、CSS blur 与 acrylic。如果必需的构造参数不能动态改变，应明确安排窗口重建并恢复状态，不宣传所有效果都能立即无重启切换。

原生模糊由系统控制，Electron 该 API 没有可自由设置的 blur 半径。UI 滑块调背景着色层，不应宣传为“系统模糊强度”。建议起始背景不透明度 85%，开放约 60%–100%，实际范围根据忙碌桌面/浅色应用背景的可读性验收调整；不允许通过关闭模糊退化成清晰透明玻璃。

不支持原生玻璃时，设置显示实际能力并使用实色，保留用户选项以便以后支持。桌面卡片与主窗口可得到不同有效材质：不能因为主窗口支持 acrylic 就推断桌面子窗口也支持。

### 主题验收

- 亮、暗、复杂壁纸和窗后高对比文字下，主 UI 文字保持清晰，背后文字在玻璃模式下不能清晰辨认。
- 滑块只改变背景，不使文字、图标和整个窗口一起褪色；重复叠层不把效果堵死。
- 主窗口、浮窗、设置页和新打开窗口颜色一致；桌面卡片默认黑色材质可独立于主主题。
- 深浅切换、色卡选择、恢复默认和重启后恢复正确；按钮文字适应色卡的强调色。
- 原生材质不可用/关闭系统透明效果时有明确实色回退，无黑边、白闪或假效果状态。

判断：自定义颜色与背景层重构可靠性高；支持系统上的普通窗口 acrylic 可靠性中高，仍需当前机器验证；Windows 旧版本的原生磨砂暂不列入首版承诺。

## 交给轻量模型的顺序

每次只派一个任务，附修改边界和验收，不让模型自行扩展到整套窗口或主题重写。

| 顺序 | 任务与主要范围 | 完成标准 |
| --- | --- | --- |
| T1 | `theme.ts`、设置外观区、相关 CSS：统一主题色卡与背景不透明度，取消独立背景取色和强调色 alpha | 深浅模式均适用色卡，默认配色不变，文字不变淡，保存/恢复正确 |
| T2 | 隔离的普通窗口材质实验，然后窗口创建与主题 IPC | 当前机器 acrylic 实际可见，实色回退有效，主要背景不盖死效果 |
| D0 | 隔离桌面宿主实验：一个黑卡片、一个按钮 | 桌面六项验收通过，尤其 Win+D 与图标/按钮交互；失败记录真实假设与证据 |
| D1 | shared/store/window/preload：可选 desktop placement、持久位置、能力状态 | 旧挂件仍正常；桌面失败不假装成功，不改变 panelId |
| D2 | WidgetShell/PanelSurface 与动态快照：复用内容、编辑入口、黑色卡片 | 移动宿主保留会话与状态，模型能准确知道自己在哪儿 |
| D3 | 每显示器壁纸 surface、恢复与动画节流 | 不影响图标交互与原有静态壁纸，退出释放资源 |

T1、D1/D2 的明确局部工作适合轻量模型；D0 与 T2 的平台机制更适合较强模型定边界后再交接。优先完成 T1；D0 与 T2 各自独立验证，避免同时调桌面挂载和系统玻璃，导致故障无法归因。

实现阶段按改动范围 build/reload/restart；本次只有方案文件，不构建、不重启。原生能力验收应记录 Windows build、Electron 实际版本、缩放和显示器配置，不能以单元测试或“API 没报错”代替效果与交互验收。
