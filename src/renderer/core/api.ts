import type { WidgetEditRequest } from '../../shared/widget-editor';

import type {
  ChatMessage,
  ChatDeltaEvent,
  ChatProgressEvent,
  ChatRetractEvent,
  ChatRunningState,
  ClosedRef,
  ComponentRef,
  DockNode,
  DockTarget,
  DropMode,
  FloatingWindow,
  Panel,
  PanelComponent,
  PanelFloat,
  PanelMode,
  PanelSpec,
  PanelWidget,
  PluginInfo,
  PluginSettingsRef,
  PluginSettingsView,
  Rect,
  LiveTask,
  SkillInfo,
  OutboxItem,
  RetryView,
  TabGroup,
  LayoutPreset,
  SketchNode,
  SketchSlot,
  TokenPrice,
  Workspace,
  TaskRecord,
} from '../../shared/types';

/**
 * 渲染进程能看到的全部能力。
 * 主窗口与浮窗共用同一份 API —— 它们承载的都是停靠树。
 */
export interface EvolveApi {
  tasks: {
    list(panelId: string): Promise<TaskRecord[]>;
    get(id: string, panelId: string): Promise<TaskRecord | undefined>;
    cancel(id: string, panelId: string): Promise<{ ok: boolean; error?: string }>;
    accept(id: string, panelId: string): Promise<{ ok: boolean; error?: string }>;
    onChanged(cb: () => void): () => void;
  };
  mode: 'main' | 'floating' | 'widget';
  /** 挂件窗口：它是**哪一块面板**的那扇窗（见 Panel.widget） */
  widgetPanel?: string;
  windowId?: string;

  zoom?: {
    getFactor(): number;
    setFactor(factor: number): void;
  };

  workspace: {
    get(): Promise<Workspace>;
    onState(cb: (state: Workspace) => void): () => void;
    /** 弹系统目录选择器换一个工作区；取消返回 null */
    pick(): Promise<string | null>;
    /** 切回最近开过的某个工作区 */
    open(dir: string): Promise<string>;
    /**
     * **这份软件自己住在哪个目录**（不是一份 checkout 就是空串）+ 现在的工作区是哪条。
     * 两相一比就能说清"工作区是不是指着别处"—— 那是"组件页空着"最常见的原因。
     */
    self(): Promise<{ dir: string; workspace: string }>;
  };

  /**
   * 布局**骨架**：抓当前工作区的形状、照一份形状重排。
   *
   * 只提供这两个原语，**不认识"切片"这个概念** —— 存几份、叫什么名、放哪个文件，
   * 是界面（或插件）自己的事。骨架里只记 kind / look / spec 这些"样子"，
   * 于是任何插件新加的面板类型都自动被记得住、还原得回来。
   */
  layout: {
    sketch(): Promise<SketchNode>;
    apply(sketch: SketchNode, extra?: { floating?: FloatingWindow[]; widgets?: { panelId: string; box: PanelWidget }[] }): Promise<boolean>;
  };

  panel: {
    create(partial: Partial<Panel> & { kind?: Panel['kind'] }, target?: DockTarget): Promise<Panel>;
    close(id: string): Promise<boolean>;
    patch(id: string, patch: Partial<Panel>): Promise<Panel | null>;
    /**
     * 一块面板的**完整正文**（对话 / 压缩存档 / 修订）。
     *
     * 广播里只有骨架 + 摘要（正文十几 MB，每广播一次就拖一遍 —— 那正是卡顿的根），
     * 所以真正要画对话的那块（ChatDock）挂载时调这一条补上。
     */
    body(id: string): Promise<Panel | null>;
    activate(id: string): Promise<boolean>;
    rollback(id: string): Promise<boolean>;
    redo(id: string): Promise<boolean>;
    /** 改过哪些版本（新的在前），每条带原始下标 */
    history(id: string): Promise<{ index: number; at: number; title: string; note: string }[]>;
    /** 恢复到指定那一版 —— 不用一版一版往回退 */
    restore(id: string, index: number): Promise<boolean>;
    /** 分离：交给一个新的浮窗 */
    /**
     * 分离：交给一个新的浮窗。fromWindowId = 它原来待的那个窗口 ——
     * 主进程靠它认出"光标底下还是自己家"，那种情况该立户，不是被并回去；
     * size = 它原来占的那块区域，新窗口照它开，一出来就跟原来一样大。
     */
    detach(id: string, fromWindowId?: string, size?: { width: number; height: number }): Promise<boolean>;
    /** 确定性开辟为独立悬浮窗（不受鼠标光标位置与拖拽判定影响） */
    openFloat(id: string, size?: { width: number; height: number }): Promise<boolean>;
    /** 拖动途中就把它撕下来：当场立一块浮窗挂在光标下跟着走 */
    tear(id: string, size?: { width: number; height: number; dx?: number; dy?: number }): Promise<boolean>;
    /** 把工作区里的文件打开到文本面板 */
    openFile(rel: string): Promise<boolean>;
    /** 脱离布局，浮成一张便签（anchor = 它落进去的那块区域；位置给**比例** {@link floatRatio}） */
    float(
      panelId: string,
      host: string,
      anchor: string,
      box: { rx: number; ry: number; width: number; height: number },
    ): Promise<boolean>;
    /** 便签归位：给了目标就并到那儿，给 null 就放回主窗口 */
    dockFloat(panelId: string, target: DockTarget | null, index?: number): Promise<boolean>;
    /** 挪动/改大小；拖动过程在本地走，松手才调这里 */
    moveFloat(panelId: string, patch: Partial<PanelFloat>): Promise<boolean>;
    /** 把收进"最近关闭"的面板放回来 */
    reopen(id: string): Promise<boolean>;
    /** 从"最近关闭"里彻底忘掉一条 */
    forget(id: string): Promise<ClosedRef[]>;
  };

  /** 最近关闭的面板（关掉 ≠ 删掉；本体在 closed/<id>.json 里） */
  closed: {
    list(): Promise<ClosedRef[]>;
  };

  /**
   * 组件库（`components/<id>.json`，广播里只有索引）。
   *
   * 两层：**声明**（`component`）= 进库、被永久保存，关不关都在；
   * **钉住**（`pinned`）= 同时挂在顶上那条收纳区。存为组件不等于收进收纳区。
   * 条目是**持久入口**：打开不消费它，删除只从 设置 → 组件 手动来。
   * 克隆 = 照它再开一块新的（同一个案例的另一个实例），原件不动。
   */
  components: {
    /** 此刻的入口列表（索引，够画入口） */
    list(): Promise<ComponentRef[]>;
    /** 两处来源的目录与条数（空着时用它在界面上说清"为什么空"） */
    where(): Promise<{ bodyDir: string; bodyCount: number; craftDir: string; craftCount: number }>;
    /** 把面板**收进去**：它从布局里消失，对话、草稿、状态一起存走 */
    save(panelId: string, name: string, targetIndex?: number): Promise<ComponentRef | null>;
    /**
     * 把**整个标签组**收进收纳区：组里每个面板各收一件。
     *
     * 一组标签没有"本体"（收进去的是一件件具体的东西），所以是按面板逐个收，
     * 返回真收成了几件 —— 0 就是一件都没收成（比如那些面板这一轮还在跑）。
     */
    saveGroup(tabId: string, windowId?: string, targetIndex?: number): Promise<number>;
    /** 手动对收纳区组件重新排序：支持拖拽排序并持久化 */
    reorder(order: string[]): Promise<boolean>;
    /** 写下**组件声明**：面板不消失，从这一刻起它被永久保存，条目常驻组件区 */
    declare(panelId: string, name: string): Promise<ComponentRef | null>;
    /** 给一条组件**改名**：声明名和面板标题一起改（做法文件跟着走） */
    rename(id: string, name: string): Promise<boolean>;
    /** 从组件库里删掉一条 —— 真删，连它那份对话记录一起没（只该由设置页调用） */
    remove(id: string): Promise<ComponentRef[]>;
    /** 收进顶上那条收纳区（钉住）：内容不动，条上多一格 */
    pin(id: string): Promise<boolean>;
    /** 从顶栏**释放**：撤下来而已 —— 本体和库里那一条都留着 */
    unpin(id: string): Promise<boolean>;
    /** 克隆一块新的（新 id、新对话线程），返回值是新面板的 id */
    clone(id: string, target?: DockTarget, index?: number): Promise<string | null>;
    /** 打开那个面板（同一个面板，不是复制）；条目不消费，已经开着就切过去/挪到落点 */
    create(id: string, target?: DockTarget, index?: number): Promise<string | null>;
    /** 收纳区上最多摆几个（纯显示偏好，存进工作区，重启还在） */
    setBarMax(n: number): Promise<number>;
    /**
     * 导出成**一个文件** —— 装的是**做法**（类型、外观、提示词、按钮），**对话不带**。
     * 文件选择器由主进程弹；用户取消就是 canceled: true。
     */
    exportPack(id: string): Promise<{ ok: boolean; path?: string; bytes?: number; canceled?: boolean; error?: string }>;
    /** 导入一个组件文件 —— 变成这一页里的一条（新面板 id，跟原件各是各的） */
    importPack(): Promise<{ ok: boolean; name?: string; id?: string; canceled?: boolean; error?: string }>;
  };

  fs: {
    root(): Promise<string>;
    list(rel: string): Promise<{ name: string; dir: boolean; path: string; size: number }[]>;
    read(rel: string): Promise<string>;
    readJson(rel: string): Promise<import('../../shared/json-snapshot').JsonSnapshot>;
    write(rel: string, text: string): Promise<{ ok: boolean; error?: string }>;
  };

  /** 设置：提供方（模型配置）+ 工作区 */
  settings: {
    get(): Promise<{
      workspace: string;
      configPath: string;
      model: ModelPick;
      /** 宿主版本（装包时校验 manifest.host 用） */
      version: string;
      providers: CatalogProvider[];
    }>;
    setWorkspace(dir: string): Promise<string>;
    /** 完全权限：**按会话** —— 给面板 id 就只改那一个会话能不能读写工作区之外的路径 */
    setFullAccess(panelId: string, on: boolean): Promise<boolean>;
    /** 工作模式：**按会话** —— 给面板 id 就只改那一个会话的模式（auto | guess | chat | exec） */
    setPanelMode(panelId: string, mode: PanelMode): Promise<PanelMode>;
    revealConfig(): Promise<boolean>;
  };

  dock: {
    drop(panelId: string, target: DockTarget, index?: number): Promise<boolean>;
    /** 拖动整个标签组 */
    dropTab(tabId: string, target: DockTarget, fromWindowId?: string): Promise<boolean>;
    detachTabs(tabId: string, fromWindowId?: string, size?: { width: number; height: number }): Promise<boolean>;
    /** 拖动途中把整组标签撕下来 */
    tearTabs(tabId: string, size?: { width: number; height: number; dx?: number; dy?: number }): Promise<boolean>;
    setRatio(splitId: string, ratio: number, windowId?: string): Promise<boolean>;
    closeTabs(tabId: string, windowId?: string): Promise<boolean>;
  };

  window: {
    attach(windowId: string): Promise<boolean>;
    control(action: 'minimize' | 'maximize' | 'close'): Promise<boolean>;
    /** 挂件窗口：面板没了就把这扇窗收掉（不然屏幕上留个看不见的透明方块） */
    closeWidget(panelId: string): Promise<boolean>;
    restoreWidget(panelId: string): Promise<boolean>;
    widgetMenu(panelId: string): Promise<boolean>;
    editWidget(panelId: string): Promise<boolean>;
    /** 挂件窗口：挪整扇窗（面板里的按钮用它安排位置） */
    moveWidget(panelId: string, patch: { x?: number; y?: number; width?: number; height?: number }): Promise<boolean>;
    beginDrag(): void;
    moveDrag(): void;
    endDrag(): void;
    beginResize(): void;
    resizeMove(): void;
    /** 松手：销毁主进程里的缩放会话，残留锚点会让窗口按旧锚点暴涨 */
    resizeEnd(): void;
    /** 拖动浮窗时的落点提示：target 是"落到哪个窗口"，zone 是那个窗口里的哪一区 */
    /**
     * 主进程来问「这个点下面是哪一块」—— 由本窗口用 DOM 回答（见 dock/drag.ts 的 probeAt）。
     * 答案就是「松手会落到哪」，所以提示框和落地动作必然是同一个判定。
     * `draw: false` 是松手那一刻问的：只要答案，不用再画框。
     */
    onProbe(cb: (q: { id: number; x: number; y: number; draw?: boolean; whole?: boolean }) => void): () => void;
    /** 把答案回给主进程 */
    probeReply(id: number, hit: unknown): void;
    /** 提示收掉：这一拖结束了 */
    onProbeEnd(cb: () => void): () => void;
    /**
     * 「光标底下是谁、它说落在哪」—— 拖到**别的窗口**上时靠它。
     * `own` 说明光标还在我自己窗口里，那就走窗口内那一套。
     */
    probeCursor(draw?: boolean): Promise<{
      target: string | null;
      hit: { tabId?: string; mode?: string; side?: string } | null;
      own: boolean;
    }>;
    /**
     * 我刚被撕下来、正挂在光标下？是的话这块窗口负责回报"拖到哪了 / 松手了" ——
     * 源窗口那边的鼠标捕获在面板离开布局时可能就断了，接力棒得有人接。
     */
    isLive(): Promise<boolean>;
    tearMove(): void;
    /** 拖动中的心跳（手停住不动也照发）—— 主进程靠它区分"还按着"和"松手信号丢了" */
    tearTick(): void;
    tearEnd(): void;
    /** 主进程宣布"这一拖结束了" */
    onDragEnd(cb: () => void): () => void;
    /** 撕下来那块窗口已经上屏 —— 源窗口这时才把跟手的吊牌收掉（补掉交接的空档） */
    liveReady(): void;
    onLiveReady(cb: () => void): () => void;
    /**
     * 撕下来的这块窗口**自己**量出"我那个标签的中心在窗口里哪儿"，回给主进程当跟手锚点。
     *
     * 为什么必须由它自己量：源窗口只知道**自己**那条标签栏的几何（左内边距、把手宽度、
     * 标签排在第几个）。拿那套去摆新窗口，指针就落在别处 —— 而且每块面板偏得都不一样。
     * 新窗口量自己才是唯一准的，而且**要在上屏之前报**，否则第一帧就偏了。
     */
    readyAnchor(dx: number, dy: number): void;
  };

  /**
   * 界面缩放：全局一个乘区。范围与钳制在主进程（0.75 ~ 1.6），
   * 这里回来的永远是钳过的真值 —— 界面按它显示就好。
   */
  ui: {
    /**
     * 界面与助手的语言。真源在主进程（见 main/lang.ts）—— 它同时决定界面文案、
     * 助手回话的语言、以及插件声明里的显示名，那三处分别在渲染层、主进程和插件里，
     * 得有一个地方同时够得到。
     */
    getLang(): Promise<string>;
    setLang(lang: string): Promise<string>;
    /** 别的窗口改了 —— 跟上 */
    onLang(cb: (lang: string) => void): () => void;
    getZoom(): Promise<number>;
    setZoom(factor: number): Promise<number>;
    onZoom(cb: (factor: number) => void): () => void;
    /** 主进程拦下 Ctrl/⌘+W → 界面关掉当前面板（见 ui/active-panel.ts） */
    onClosePanel(cb: () => void): () => void;
    onEditWidget(cb: (request: WidgetEditRequest) => void): () => void;
  };

  model: {
    /**
     * 模型来自本应用自己的提供方配置；这里只能看和选。
     * `key` 给**面板 id** 就是这个会话自己的模型；给 'main' / 浮窗 id
     * 就是那个窗口的兜底 —— 窗口里没单独选过的会话跟着它走。
     */
    get(key: string): Promise<ModelPick>;
    catalog(): Promise<CatalogProvider[]>;
    set(key: string, patch: { pick?: string; think?: string }): Promise<ModelPick>;
  };

  /** 提供方的增删改：密钥从这儿进，永远读不回来 */
  providers: {
    catalog(): Promise<CatalogProvider[]>;
    presets(): Promise<ProviderDraft[]>;
    save(provider: ProviderDraft): Promise<CatalogProvider[]>;
    remove(key: string): Promise<CatalogProvider[]>;
    /** 去服务端拉一份模型清单（OpenAI 兼容的 /models）—— 拉不到就回一句话 */
    models(draft: { key: string; baseUrl?: string; apiKey?: string }): Promise<{ models: CatalogModel[]; error?: string }>;
  };

  /** 技能与插件：技能来自多个根，插件来自两个根 */
  ext: {
    list(): Promise<ExtSnapshot>;
    toggle(kind: 'skill' | 'plugin', name: string, on: boolean): Promise<{ skills: SkillInfo[]; plugins: PluginInfo[] }>;
    readSkill(name: string): Promise<string>;

    /**
     * 装 .ensoulpack 包的两趟。字节递上去，解析与落盘都在主进程 ——
     * 渲染层没有 require / zlib，从前那条 await import 一跑就 require is not defined。
     * inspect 只算清单（先给用户过目），install 才写盘。
     */
    inspectPack(bytes: ArrayBuffer, scope?: import('../../shared/storage').ExtensionInstallScope): Promise<PackInspectResult>;
    installPack(bytes: ArrayBuffer, scope?: import('../../shared/storage').ExtensionInstallScope): Promise<PackInstallResult>;
    /** 改一个插件的可调参数（null = 恢复默认）—— 回来的是新的插件清单 */
    setParam(
      plugin: string,
      key: string,
      value: string | number | boolean | null,
    ): Promise<{ plugins: PluginInfo[]; error?: string }>;
    /**
     * 设置里的**插件分区** —— 有些东西（AI 员工的编制）既不是面板也不是工具，
     * 而是**一份要在设置里看得见的名单**。三件事：有哪些页、某一页此刻的内容、
     * 点一下某个动作（回来的是新内容 + 一句回执，一趟给全）。
     */
    sections(): Promise<PluginSettingsRef[]>;
    section(plugin: string, id: string): Promise<PluginSettingsView | null>;
    sectionAction(
      plugin: string,
      id: string,
      actionId: string,
      rowId: string,
    ): Promise<{ ok: boolean; reply?: string; error?: string; view: PluginSettingsView | null }>;
    reveal(which: 'skills' | 'plugins' | 'workspace-skills' | 'workspace-plugins'): Promise<string>;
  };

  /** 运行环境、多版本 Python 与网络镜像加速 */
  env: {
    get(): Promise<{
      mirror?: string;
      customPypi?: string;
      customNpm?: string;
      activePythonId?: string;
      pythons?: Array<{ id: string; name: string; path: string; version?: string; available?: boolean }>;
    }>;
    save(config: {
      mirror?: string;
      customPypi?: string;
      customNpm?: string;
      activePythonId?: string;
      pythons?: Array<{ id: string; name: string; path: string; version?: string; available?: boolean }>;
    }): Promise<{ ok: boolean; error?: string }>;
    detect(): Promise<{
      nodeVersion: string;
      mirror: string;
      customPypi: string;
      customNpm: string;
      activePythonId: string;
      activePythonPath: string;
      activePythonVersion: string;
      pythons: Array<{ id: string; name: string; path: string; version?: string; available?: boolean }>;
      systemCandidates: string[];
    }>;
    testPython(path: string): Promise<{ ok: boolean; version?: string; error?: string }>;
    runPip(
      pkgList: string,
      options?: { pythonPath?: string; mirror?: string; customPypi?: string }
    ): Promise<{ ok: boolean; output: string }>;
    pickFile(): Promise<string | null>;
    /** 删之前先勘察：多大、几个文件、能不能真删、谁正抱着它。只读，不动任何东西。 */
    inspectPython(record: { id?: string; path?: string; name?: string }): Promise<{
      ok: boolean;
      error?: string;
      id: string;
      name: string;
      path: string;
      dir: string;
      dirExists: boolean;
      fileCount: number;
      bytes: number;
      partial: boolean;
      /** true = 落在我管的 .ensoul/env 里，删会连盘一起清；false = 只摘名单 */
      canDelete: boolean;
      inUse: Array<{ pid: number; path: string; memMB: number }>;
      references: string[];
    }>;
    /** 真删：先收掉抱着它的进程，再递归清目录，最后摘登记 */
    removePython(record: { id?: string; path?: string }): Promise<{
      ok: boolean;
      error?: string;
      killed: number[];
      disk: { mode: 'deleted' | 'refused' | 'external' | 'missing'; bytes: number; files: number; leftovers?: string[] };
      wrote: boolean;
      remaining: number;
      activePythonId: string;
    }>;
    /** 盘上躺着、名单里已经没有的解释器目录（只列不删） */
    listOrphans(): Promise<Array<{ name: string; dir: string; bytes: number; files: number }>>;
    removeOrphan(dir: string): Promise<{ ok: boolean; error?: string; bytes: number; files: number; leftovers: string[]; killed?: number[] }>;
  };

  /** 看图：把一张图交给系统（打开不了时回一段错误文本） */
  shell: {
    open(path: string): Promise<string>;
    reveal(path: string): Promise<string>;
  };

  chat: {
    send(
      panelId: string,
      text: string,
      /** 剪贴板粘进来的图，data URL */
      images?: string[],
    ): Promise<{ ok: boolean; content?: string; edited?: boolean; error?: string }>;
    stop(panelId: string): Promise<boolean>;
    /**
     * 排队：先摆着，这一整轮跑完自动接着发出去。
     * 和 `steer` 是两条不同的路 —— 这条等整轮结束，那条插进正在跑的这一轮。
     */
    enqueue(panelId: string, text: string, images?: string[]): Promise<{ ok: boolean; error?: string }>;
    /** 插话：送进**此刻正在跑**的那一轮，它手头这一步做完就读到 */
    steer(panelId: string, text: string, images?: string[]): Promise<{ ok: boolean; error?: string }>;
    /** 插队：把排队里某一条提到插话盒子里（它还在跑时才插得进去） */
    queueSteer(panelId: string, id: string): Promise<{ ok: boolean; error?: string }>;
    queueRemove(panelId: string, id: string): Promise<{ ok: boolean; error?: string }>;
    queueEdit(panelId: string, id: string, text: string): Promise<{ ok: boolean; error?: string }>;
    /** 这个面板还排着什么、插着什么（切标签回来靠它接上） */
    outbox(panelId: string): Promise<{ queue: OutboxItem[]; steer: OutboxItem[] }>;
    /** 插话盒子变了（排队那条要跟着变） */
    onSteer(cb: (p: { panelId: string; items: OutboxItem[] }) => void): () => void;
    /** 哪些面板此刻还在跑（主进程是真源）—— 面板组件卸载重挂后靠它恢复"停止"按钮和已吐出的正文 */
    running(): Promise<ChatRunningState[]>;
    /** 某个面板开跑 / 跑完 */
    onRunning(cb: (p: { panelId: string; running: boolean }) => void): () => void;
    rate(panelId: string, messageId: string, rating: 'up' | 'down'): Promise<boolean>;
    /** 插件提出的"请用户点头"的请求（重启用的是这条路，见 plugins/restart-approval） */
    askState(panelId: string): Promise<{ ask: AskView | null; restartArmed?: boolean }>;
    /** 提交答案：结构化问答把 answers 一并带过去；老路（请用户点头）不传 */
    askConfirm(panelId: string, answer?: unknown): Promise<{ ok: boolean; error?: string }>;
    /** 选了「等所有会话结束」：挂起来，整个软件都闲下来再自动做 */
    askDefer(panelId: string): Promise<{ ok: boolean; error?: string }>;
    askCancel(panelId: string): Promise<boolean>;
    onAsk(cb: (p: { panelId: string; ask: AskView | null; restartArmed?: boolean }) => void): () => void;
    /** 进行中的容器（生图这类慢活的进度）+ 这一轮已经送进对话的图 + 此刻在不在重连 */
    liveState(panelId: string): Promise<{ tasks: LiveTask[]; images: string[]; retry?: RetryView | null }>;
    /** 进行中那一块变了 —— 推过来的是一份整快照 */
    onLive(cb: (p: { panelId: string; tasks: LiveTask[]; images: string[]; retry?: RetryView | null }) => void): () => void;
    /**
     * 断了重连时，把上一次那半截草稿作废。
     *
     * 给的是**字数**不是新内容：界面自己把尾巴切掉。为什么不发一份全文过来 ——
     * 重连可能连着来五次，每次都重传一遍整段正文（长回答能到几十 KB），纯浪费。
     */
    onRetract(cb: (p: ChatRetractEvent) => void): () => void;
    onMessage(cb: (p: { panelId: string; message: ChatMessage }) => void): () => void;
    onDelta(cb: (p: ChatDeltaEvent) => void): () => void;
    onProgress(cb: (p: ChatProgressEvent) => void): () => void;
    /** 思维链：模型吐正文之前先吐的那一段 */
    onReasoning(cb: (p: { panelId: string; id: string; delta: string }) => void): () => void;
  };
}

/**
 * 一条待用户点头的请求：插件提的，核心画的。
 * 界面上只知道这几句话 —— 是谁提的、点了之后跑什么，它不用认识。
 */
/** 一道题的可选项 */
export interface AskViewOption {
  label: string;
  description?: string;
}

/** 一道题 —— 跟主进程下发的 AskQuestionItem 同形（dsh 的 ask_user_question 对齐） */
export interface AskViewQuestion {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: AskViewOption[];
  multiSelect?: boolean;
}

export interface AskView {
  text: string;
  confirm: string;
  cancel: string;
  /** 第三个按钮：「等所有会话结束再做」。空串 = 没这个选项 */
  defer?: string;
  /**
   * 结构化的问题清单 —— 有它，界面上画的是问题表单（翻页 / 单选多选 /
   * 自定义答案 / 跳过），提交之后问答一并回到提问方。
   * 没有它就是那条老路：一句话 + 两个按钮。
   */
  questions?: AskViewQuestion[];
  /** 已经选了"等所有会话结束"，正等时机 */
  armed?: boolean;
}

export interface CatalogModel {
  /** 单价（元 / 百万 token）：公开信息，照发给前台 —— 设置面板要靠它来编辑 */
  price?: TokenPrice;
  id: string;
  name: string;
}

/** 装包第一趟的回执：**只看不写**，把要落哪些文件算出来给用户过目 */
export interface PackInspectResult {
  ok: boolean;
  error?: string;
  id?: string;
  name?: string;
  /** 包里声明的版本 —— 只为在确认框里念一句，不参与任何判断 */
  version?: string;
  dir?: string;
  /** 相对安装目录的路径清单 */
  files?: string[];
}

/** 装包第二趟的回执：这一趟真写盘了 */
export interface PackInstallResult {
  ok: boolean;
  error?: string;
  id?: string;
  name?: string;
  dir?: string;
}

/** 设置面板里那一屏：技能清单、插件清单、以及两边各自的目录 */
export interface ExtSnapshot {
  skills: SkillInfo[];
  plugins: PluginInfo[];
  /** 软件自带的技能目录 */
  skillsDir: string;
  /** 一共扫了哪几个技能根（工作区的几个约定目录、插件自带的、用户级、软件自带） */
  skillsDirs: { path: string; source: string; exists: boolean }[];
  pluginsDir: string;
  /** 这个工作区自己的插件目录：`.ensoul/plugins` */
  workspacePluginsDir: string;
  userPluginsDir: string;
}

/** 一个提供方（下发给前台的脱敏版本：只有"配没配密钥"） */
export interface CatalogProvider {
  key: string;
  label: string;
  api: string;
  baseUrl: string;
  hasKey: boolean;
  builtin: boolean;
  models: CatalogModel[];
}

/** 保存提供方时提交的东西（apiKey 留空表示不改） */
export interface ProviderDraft {
  key: string;
  label: string;
  api: string;
  baseUrl: string;
  apiKey?: string;
  models: CatalogModel[];
}

/** 某一刻选中的模型 */
export interface ModelPick {
  pick: string;
  provider: string;
  name: string;
  hasKey: boolean;
  /** 思考水平：空串 = 不发参数；off / low / medium / high */
  think?: string;
}

declare global {
  interface Window {
    ensoul: EvolveApi;
  }
}

export const api = window.ensoul;

export type { ChatMessage, ClosedRef, ComponentRef, DockNode, DockTarget, DropMode, LayoutPreset, Panel, PanelComponent, PanelSpec, Rect, SketchNode, SketchSlot, TabGroup, Workspace };
