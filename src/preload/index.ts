import { contextBridge, ipcRenderer, webFrame } from 'electron';
import type { ChatDeltaEvent, ChatProgressEvent, ChatRetractEvent } from '../shared/types';
import type { WidgetEditRequest } from '../shared/widget-editor';
const WIDGET_EDIT_CHANNEL: typeof import('../shared/widget-editor').WIDGET_EDIT_REQUEST = 'ui:editWidget';

/**
 * 预加载：只暴露一组明确的、被审查过的通道，渲染进程拿不到 Node 能力。
 * 主窗口和浮窗用的是同一份 API —— 它们承载的都是停靠树，本来就是同一套东西。
 */

const queryOf = (key: string): string | undefined => {
  const fromSearch = new URLSearchParams(location.search).get(key);
  if (fromSearch) return fromSearch;
  const hit = process.argv.find((a) => a.includes(`${key}=`));
  if (!hit) return undefined;
  const m = hit.match(new RegExp(`${key}=([^&]+)`));
  return m ? decodeURIComponent(m[1]) : undefined;
};

const on = (channel: string, cb: (...args: any[]) => void) => {
  const fn = (_e: unknown, ...args: any[]) => cb(...args);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

/** 一条还没发出去的话：排队项和插话项形状一样，界面上就一套画法 */
interface SteerItemView {
  id: string;
  text: string;
  images?: string[];
  at?: number;
}

const api = {
  mode: (queryOf('mode') as 'main' | 'floating' | 'widget') ?? 'main',
  windowId: queryOf('window'),
  /** 挂件窗口：它是哪一块面板的那扇窗（见 Panel.widget） */
  widgetPanel: queryOf('panel'),
  tasks: {
    list: (panelId: string) => ipcRenderer.invoke('tasks:list', panelId),
    get: (id: string, panelId: string) => ipcRenderer.invoke('tasks:get', id, panelId),
    cancel: (id: string, panelId: string) => ipcRenderer.invoke('tasks:cancel', id, panelId),
    accept: (id: string, panelId: string) => ipcRenderer.invoke('tasks:accept', id, panelId),
    onChanged: (cb: () => void) => on('tasks:changed', cb),
  },

  workspace: {
    get: () => ipcRenderer.invoke('ws:state'),
    onState: (cb: (state: any) => void) => on('ws:state', cb),
    /** 弹系统目录选择器换一个工作区；取消返回 null */
    pick: () => ipcRenderer.invoke('ws:pick'),
    /** 切回最近开过的某个工作区 */
    open: (dir: string) => ipcRenderer.invoke('ws:open', dir),
    /** 这份软件自己所在的目录（不是 checkout 就是空串）+ 现在的工作区 */
    self: () => ipcRenderer.invoke('ws:self'),
  },

  /** 布局骨架：抓当前工作区的形状 / 照一份形状重排 */
  layout: {
    sketch: () => ipcRenderer.invoke('layout:sketch'),
    apply: (sketch: any, extra?: any) => ipcRenderer.invoke('layout:apply', sketch, extra),
  },

  panel: {
    create: (partial: any, target?: any) => ipcRenderer.invoke('panel:create', partial, target),
    close: (id: string) => ipcRenderer.invoke('panel:close', id),
    patch: (id: string, patch: any) => ipcRenderer.invoke('panel:patch', id, patch),
    /**
     * 一块面板的**完整正文**（对话 / 压缩存档 / 修订）。
     *
     * 广播（ws:state）里只有骨架 + 摘要 —— 正文十几 MB，每广播一次就拖着它走，
     * 那正是"点一下要等一秒"的根。ChatDock 挂载时按需拉这一条补上。
     */
    body: (id: string) => ipcRenderer.invoke('panel:body', id),
    activate: (id: string) => ipcRenderer.invoke('panel:activate', id),
    rollback: (id: string) => ipcRenderer.invoke('panel:rollback', id),
    redo: (id: string) => ipcRenderer.invoke('panel:redo', id),
    /** 改过哪些版本（新的在前），每条带原始下标 */
    history: (id: string) => ipcRenderer.invoke('panel:history', id),
    /** 恢复到指定那一版 */
    restore: (id: string, index: number) => ipcRenderer.invoke('panel:restore', id, index),
    detach: (id: string, fromWindowId?: string, size?: { width: number; height: number }) => ipcRenderer.invoke('panel:detach', id, fromWindowId, size),
    /** 拖动途中就把它撕下来：当场立一块浮窗挂在光标下（浏览器那套） */
    tear: (id: string, size?: { width: number; height: number }) => ipcRenderer.invoke('panel:tear', id, size),
    /** 把工作区里的文件打开到文本面板 */
    openFile: (rel: string) => ipcRenderer.invoke('panel:openFile', rel),
    /** 脱离布局，浮成一张便签（anchor = 它落进去的那块区域） */
    float: (panelId: string, host: string, anchor: string, rect: any) =>
      ipcRenderer.invoke('panel:float', panelId, host, anchor, rect),
    /** 便签归位，回到停靠树里 */
    dockFloat: (panelId: string, target: any, index?: number) =>
      ipcRenderer.invoke('panel:dockFloat', panelId, target, index),
    /** 挪动/改大小；拖动过程在本地走，松手才调这里 */
    moveFloat: (panelId: string, patch: any) => ipcRenderer.invoke('panel:moveFloat', panelId, patch),
    /** 把收进"最近关闭"的面板放回来 */
    reopen: (id: string) => ipcRenderer.invoke('closed:reopen', id),
    /** 从"最近关闭"里彻底忘掉一条 */
    forget: (id: string) => ipcRenderer.invoke('closed:forget', id),
  },

  /** 最近关闭的面板（关掉 ≠ 删掉） */
  closed: {
    list: () => ipcRenderer.invoke('closed:list'),
  },

  /**
   * 收纳区（顶上那条）：存的是**面板本身**（对话、草稿、状态一起），本体在 components/<id>.json。
   * save = 收起来（从布局里摘掉），create = 打开那个面板（条目一直留着；开着就切过去，不开第二份）。
   * remove = 真删，只有 设置 → 组件 会调它；pin / unpin = 收进 / 撤出顶上那条收纳区，内容都不动。
   */
  components: {
    list: () => ipcRenderer.invoke('cmp:list'),
    /** 这一页的两处来源：本机面板本体目录、工作区做法目录，各查到几条 */
    where: () => ipcRenderer.invoke('cmp:where'),
    save: (panelId: string, name: string, targetIndex?: number) => ipcRenderer.invoke('cmp:save', panelId, name, targetIndex),
    /** 把**整个标签组**收进收纳区：组里每个面板各收一件，返回收成的件数 */
    saveGroup: (tabId: string, windowId?: string, targetIndex?: number) =>
      ipcRenderer.invoke('cmp:saveGroup', tabId, windowId, targetIndex),
    /** 收纳区组件重新排序：支持拖拽排序 */
    reorder: (order: string[]) => ipcRenderer.invoke('cmp:reorder', order),
    /** 写下组件声明（面板不消失，只是从此被永久保存） */
    declare: (panelId: string, name: string) => ipcRenderer.invoke('cmp:declare', panelId, name),
    /** 给一条组件**改名**：声明名和面板标题一起改，做法文件跟着走 */
    rename: (id: string, name: string) => ipcRenderer.invoke('cmp:rename', id, name),
    remove: (id: string) => ipcRenderer.invoke('cmp:remove', id),
    /** 收进顶上那条收纳区（钉住）—— 内容一个字不动 */
    pin: (id: string) => ipcRenderer.invoke('cmp:pin', id),
    /** 从顶上那条**释放**：撤下来而已，本体与库里那一条都留着 */
    unpin: (id: string) => ipcRenderer.invoke('cmp:unpin', id),
    /** 克隆一块新的（新 id、新对话线程），原件不动 */
    clone: (id: string, target?: any, index?: number) => ipcRenderer.invoke('cmp:clone', id, target, index),
    create: (id: string, target?: any, index?: number) => ipcRenderer.invoke('cmp:create', id, target, index),
    /** 收纳区上最多摆几个（超出的收进「»」下拉） */
    setBarMax: (n: number) => ipcRenderer.invoke('cmp:setBarMax', n),
    /** 导出成**一个文件**（只有做法，不带对话）—— 换台机器导进去就是同款一块面板 */
    exportPack: (id: string) => ipcRenderer.invoke('cmp:export', id),
    /** 导入一个组件文件（变成 设置 → 组件 里的一条，新面板 id） */
    importPack: () => ipcRenderer.invoke('cmp:import'),
  },

  fs: {
    root: () => ipcRenderer.invoke('fs:root'),
    list: (rel: string) => ipcRenderer.invoke('fs:list', rel),
    read: (rel: string) => ipcRenderer.invoke('fs:read', rel),
    readJson: (rel: string): Promise<import('../shared/json-snapshot').JsonSnapshot> => ipcRenderer.invoke('fs:readJson', rel),
    write: (rel: string, text: string) => ipcRenderer.invoke('fs:write', rel, text),
  },

  /** 设置：只显示与工作区切换；模型 api 在后台配置文件里改，前台没有入口 */
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    setWorkspace: (dir: string) => ipcRenderer.invoke('settings:setWorkspace', dir),
    /** 完全权限：**按会话** —— 给面板 id 就只改那一个会话能读写工作区之外的路径 */
    setFullAccess: (panelId: string, on: boolean) => ipcRenderer.invoke('settings:setFullAccess', panelId, on),
    /** 工作模式：**按会话** —— 给面板 id 就只改那一个会话的模式 */
    setPanelMode: (panelId: string, mode: string) => ipcRenderer.invoke('settings:setPanelMode', panelId, mode),
    revealConfig: () => ipcRenderer.invoke('settings:revealConfig'),
  },

  dock: {
    /** 拖放的唯一入口：中央并入标签组，四边在那旁边自然分出新的停靠区 */
    drop: (panelId: string, target: any, index?: number) => ipcRenderer.invoke('dock:drop', panelId, target, index),
    /** 拖动整个标签组 */
    dropTab: (tabId: string, target: any, fromWindowId?: string) =>
      ipcRenderer.invoke('dock:dropTab', tabId, target, fromWindowId),
    /** 整个标签组拖出去，变成一个浮窗 */
    detachTabs: (tabId: string, fromWindowId?: string, size?: { width: number; height: number }) =>
      ipcRenderer.invoke('tabs:detach', tabId, fromWindowId, size),
    /** 拖动途中把整组标签撕下来 */
    tearTabs: (tabId: string, size?: { width: number; height: number }) => ipcRenderer.invoke('tabs:tear', tabId, size),
    setRatio: (splitId: string, ratio: number, windowId?: string) =>
      ipcRenderer.invoke('split:ratio', splitId, ratio, windowId),
    closeTabs: (tabId: string, windowId?: string) => ipcRenderer.invoke('tabs:close', tabId, windowId),
  },

  window: {
    /** 归一化：浮窗整棵树并回主窗口 */
    attach: (windowId: string) => ipcRenderer.invoke('window:attach', windowId),
    control: (action: 'minimize' | 'maximize' | 'close') => ipcRenderer.invoke('win:control', action),
    closeWidget: (panelId: string) => ipcRenderer.invoke('widget:close', panelId),
    restoreWidget: (panelId: string) => ipcRenderer.invoke('widget:restore', panelId),
    widgetMenu: (panelId: string) => ipcRenderer.invoke('widget:menu', panelId),
    editWidget: (panelId: string) => ipcRenderer.invoke('widget:edit', panelId),
    moveWidget: (panelId: string, patch: any) => ipcRenderer.invoke('widget:move', panelId, patch),
    // 界面只报手势信号，指针坐标由主进程自己取（screenX 的单位并不可靠）
    beginDrag: () => ipcRenderer.send('float:dragBegin'),
    moveDrag: () => ipcRenderer.send('float:dragMove'),
    endDrag: () => ipcRenderer.send('float:dragEnd'),
    beginResize: () => ipcRenderer.send('float:resizeBegin'),
    resizeMove: () => ipcRenderer.send('float:resizeMove'),
    resizeEnd: () => ipcRenderer.send('float:resizeEnd'),
    /** 主进程来问「这个点下面是哪一块」—— 由本窗口用 DOM 回答（见 dock/drag.ts 的 probeAt） */
    onProbe: (cb: (q: { id: number; x: number; y: number; draw?: boolean }) => void) => on('drop:probe', cb),
    /** 把算出来的落点回给主进程 */
    probeReply: (id: number, hit: unknown) => ipcRenderer.send('drop:probe:reply', id, hit),
    /** 提示收掉：这一拖结束了 */
    onProbeEnd: (cb: () => void) => on('drop:probe:end', cb),
    /** 光标底下那扇窗说「落在哪」—— 拖到别的窗口上时靠它 */
    probeCursor: (draw = false) => ipcRenderer.invoke('win:probeCursor', draw),
    /** 我刚被撕下来、正挂在光标下？是的话这块窗口负责回报"拖到哪了 / 松手了" */
    isLive: () => ipcRenderer.invoke('win:isLive'),
    tearMove: () => ipcRenderer.send('win:tearMove'),
    /** 拖动中的心跳：手停住不动也照发，主进程靠它区分"还按着"和"松手信号丢了" */
    tearTick: () => ipcRenderer.send('win:tearTick'),
    tearEnd: () => ipcRenderer.send('win:tearEnd'),    /** 主进程宣布"这一拖结束了" —— 每个窗口据此把自己那份状态清干净 */
    onDragEnd: (cb: () => void) => on('drag:end', cb),
    /** 撕下来那块窗口上屏了 */
    liveReady: () => ipcRenderer.send('win:liveReady'),
    /** 撕下来那块自己量出标签中心，回给主进程当跟手锚点 */
    readyAnchor: (dx: number, dy: number) => ipcRenderer.send('win:anchor', dx, dy),
    /** 收到「上屏了」—— 源窗口据此把跟手的吊牌收掉 */
    onLiveReady: (cb: () => void) => on('win:liveReady', cb),
  },

  /**
   * 界面缩放 —— **一个乘区**，主进程说了算。
   *
   * 渲染层只管说"要几倍"，真正落下去的是 Electron 原生缩放（webContents.setZoomFactor）：
   * 文字重排、布局重算，跟系统缩放一个道理，新装的面板/插件一张都不用适配。
   * 不用 CSS 乘区：主进程看不见它，跨窗口拖拽的坐标换算会当场分家。
   */
  ui: {
    /**
     * 界面与助手的语言。真源在主进程（见 main/lang.ts）—— 它同时决定界面文案、
     * 助手回话的语言、以及插件声明里的显示名，那三处分别在渲染层、主进程和插件里，
     * 得有一个地方同时够得到。
     */
    getLang: () => ipcRenderer.invoke('ui:lang:get'),
    setLang: (lang: string) => ipcRenderer.invoke('ui:lang:set', lang),
    /** 别的窗口改了 —— 跟上 */
    onLang: (cb: (lang: string) => void) => on('ui:lang', cb),
    /** 全局：所有窗口一起变，落盘，下次开机还是它 */
    getZoom: () => ipcRenderer.invoke('ui:zoom:get'),
    setZoom: (factor: number) => ipcRenderer.invoke('ui:zoom:set', factor),
    /** 别的窗口改了（或主进程钳过范围）—— 跟上，别自己再算一遍 */
    onZoom: (cb: (factor: number) => void) => on('ui:zoom', cb),
    /**
     * 主进程按住了 Ctrl/⌘+W（那个键 Chromium 自己要拿去关窗口，渲染层根本收不到），
     * 通知界面：关掉**当前这块面板**，别关窗口。
     */
    onClosePanel: (cb: () => void) => on('ui:closePanel', cb),
    onEditWidget: (cb: (request: WidgetEditRequest) => void) => on(WIDGET_EDIT_CHANNEL, cb),
  },

  model: {
    /** 模型来自本应用自己的提供方配置；这里只能看和选 */
    get: (hostKey: string) => ipcRenderer.invoke('model:get', hostKey),
    catalog: () => ipcRenderer.invoke('model:catalog'),
    set: (hostKey: string, patch: { pick?: string; think?: string }) => ipcRenderer.invoke('model:set', hostKey, patch),
  },

  /** 提供方的增删改（密钥从这儿进，不会被读回来） */
  providers: {
    catalog: () => ipcRenderer.invoke('providers:catalog'),
    presets: () => ipcRenderer.invoke('providers:presets'),
    save: (provider: any) => ipcRenderer.invoke('providers:save', provider),
    remove: (key: string) => ipcRenderer.invoke('providers:remove', key),
    /** 问服务端有哪些模型（用表单里现填的地址和密钥，密钥没填就用已存的） */
    models: (draft: { key: string; baseUrl?: string; apiKey?: string }) => ipcRenderer.invoke('providers:models', draft),
  },

  /** 技能与插件：跟软件走，不跟工作区走 —— 换工作区不该把能力弄丢 */
  ext: {
    list: () => ipcRenderer.invoke('ext:list'),
    toggle: (kind: 'skill' | 'plugin', name: string, on: boolean) =>
      ipcRenderer.invoke('ext:toggle', kind, name, on),
    readSkill: (name: string) => ipcRenderer.invoke('ext:readSkill', name),
    setParam: (plugin: string, key: string, value: unknown) =>
      ipcRenderer.invoke('ext:setParam', plugin, key, value),
    /**
     * 装一个 .ensoulpack 扩展包。
     *
     * 只递字节，不许在这里解析：渲染层没有 require / zlib（窗口是 sandbox +
     * contextIsolation），zip 那条链整个住在主进程。
     * 两趟 —— inspect 先算清单（要念给用户听），install 才落盘。
     */
    inspectPack: (bytes: ArrayBuffer) => ipcRenderer.invoke('ext:inspectPack', bytes),
    installPack: (bytes: ArrayBuffer) => ipcRenderer.invoke('ext:installPack', bytes),
    /** 设置里的插件分区：有哪些页 / 某一页的内容 / 点一个动作 */
    sections: () => ipcRenderer.invoke('ext:sections'),
    section: (plugin: string, id: string) => ipcRenderer.invoke('ext:section', plugin, id),
    sectionAction: (plugin: string, id: string, actionId: string, rowId: string) =>
      ipcRenderer.invoke('ext:sectionAction', plugin, id, actionId, rowId),
    reveal: (which: 'skills' | 'plugins') => ipcRenderer.invoke('ext:reveal', which),
  },

  /** 运行环境、多版本 Python 与网络镜像加速 */
  env: {
    get: () => ipcRenderer.invoke('env:get'),
    save: (cfg: any) => ipcRenderer.invoke('env:save', cfg),
    detect: () => ipcRenderer.invoke('env:detect'),
    testPython: (pyPath: string) => ipcRenderer.invoke('env:testPython', pyPath),
    downloadPython: (versionKey?: string) => ipcRenderer.invoke('env:downloadPython', versionKey),
    runPip: (pkgList: string, options?: any) => ipcRenderer.invoke('env:runPip', pkgList, options),
    pipStatus: () => ipcRenderer.invoke('env:pipStatus'),
    onPipLog: (cb: (payload: { log: string; chunk: string }) => void) => {
      const handler = (_: any, payload: { log: string; chunk: string }) => cb(payload);
      ipcRenderer.on('env:pipLog', handler);
      return () => ipcRenderer.removeListener('env:pipLog', handler);
    },
    pickFile: () => ipcRenderer.invoke('env:pickFile'),
    inspectPython: (record: { id?: string; path?: string; name?: string }) => ipcRenderer.invoke('env:inspectPython', record),
    removePython: (record: { id?: string; path?: string }) => ipcRenderer.invoke('env:removePython', record),
    listOrphans: () => ipcRenderer.invoke('env:listOrphans'),
    removeOrphan: (dir: string) => ipcRenderer.invoke('env:removeOrphan', dir),
  },

  /** 看图：把一张图交给系统（用默认程序打开 / 在文件夹里显示） */
  shell: {
    open: (p: string) => ipcRenderer.invoke('shell:openFile', p),
    reveal: (p: string) => ipcRenderer.invoke('shell:revealFile', p),
  },

  zoom: {
    getFactor: () => webFrame.getZoomFactor(),
    setFactor: (f: number) => webFrame.setZoomFactor(f),
  },

  chat: {
    send: (panelId: string, text: string, images?: string[]) =>
      ipcRenderer.invoke('chat:send', panelId, text, images),
    /** 排队：先摆着，这一整轮跑完自动接着发 */
    enqueue: (panelId: string, text: string, images?: string[]) =>
      ipcRenderer.invoke('chat:enqueue', panelId, text, images),
    /** 插话：送进此刻正在跑的那一轮，它手头这一步做完就读到 */
    steer: (panelId: string, text: string, images?: string[]) =>
      ipcRenderer.invoke('chat:steer', panelId, text, images),
    /** 插队：把排队里某一条提到插话盒子里 */
    queueSteer: (panelId: string, id: string) => ipcRenderer.invoke('chat:queueSteer', panelId, id),
    queueRemove: (panelId: string, id: string) => ipcRenderer.invoke('chat:queueRemove', panelId, id),
    queueEdit: (panelId: string, id: string, text: string) =>
      ipcRenderer.invoke('chat:queueEdit', panelId, id, text),
    /** 这个面板还排着什么、插着什么（切标签回来靠它接上） */
    outbox: (panelId: string) => ipcRenderer.invoke('chat:outbox', panelId),
    /** 插话盒子变了（排队那条要跟着变） */
    onSteer: (cb: (p: { panelId: string; items: SteerItemView[] }) => void) => on('chat:steer', cb),
    stop: (panelId: string) => ipcRenderer.invoke('chat:stop', panelId),
    /** 现在有哪些面板还在跑 —— 切标签会把面板组件卸载重挂，状态得从这儿接回来 */
    running: () => ipcRenderer.invoke('chat:running'),
    /** 某个面板开跑 / 跑完 —— 一变就广播 */
    onRunning: (cb: (p: { panelId: string; running: boolean }) => void) => on('chat:running', cb),
    rate: (panelId: string, messageId: string, rating: 'up' | 'down') =>
      ipcRenderer.invoke('chat:rate', panelId, messageId, rating),
    /** 这个面板有没有待用户点头的请求（换窗口、刷新之后界面靠它找回来） */
    askState: (panelId: string) =>
      ipcRenderer.invoke('chat:askState', panelId) as Promise<{
        ask: { text: string; confirm: string; cancel: string; defer?: string; armed?: boolean } | null;
        restartArmed?: boolean;
      }>,
    /** 用户按下「确认」—— 插件请求的那次工具调用只能从这儿发起 */
    askConfirm: (panelId: string) => ipcRenderer.invoke('chat:askConfirm', panelId),
    /** 用户选了「等所有会话结束」：挂起来，等整个软件都闲下来再自动做 */
    askDefer: (panelId: string) => ipcRenderer.invoke('chat:askDefer', panelId),
    askCancel: (panelId: string) => ipcRenderer.invoke('chat:askCancel', panelId),
    /** 请求出现/消失 —— 界面据此弹那条待确认的提示 */
    onAsk: (
      cb: (p: {
        panelId: string;
        ask: { text: string; confirm: string; cancel: string; defer?: string; armed?: boolean } | null;
        /** 全局是不是有"等全部会话结束才重启"挂着 —— 挂上了，输入框要换手势 */
        restartArmed?: boolean;
      }) => void,
    ) => on('chat:ask', cb),
    /** 进行中的容器（生图这类慢活的进度）+ 这一轮已经送进对话的图；切标签回来靠它接上 */
    liveState: (panelId: string) => ipcRenderer.invoke('chat:liveState', panelId),
    /** 进行中那一块变了就推一份整快照过来（不是增量 —— 就这么点数据） */
    onLive: (cb: (p: { panelId: string; tasks: any[]; images: string[]; retry?: any }) => void) => on('chat:live', cb),
    /** 重连把上一次那半截草稿作废：给的是字数，界面自己把尾巴切掉 */
    onRetract: (cb: (p: ChatRetractEvent) => void) => on('chat:retract', cb),
    onMessage: (cb: (p: { panelId: string; message: any }) => void) => on('chat:message', cb),
    onDelta: (cb: (p: ChatDeltaEvent) => void) => on('chat:delta', cb),
    onProgress: (cb: (p: ChatProgressEvent) => void) => on('chat:progress', cb),
    /** 思维链：模型吐正文之前先吐的那一段 */
    onReasoning: (cb: (p: { panelId: string; id: string; delta: string }) => void) => on('chat:reasoning', cb),
  },
};

contextBridge.exposeInMainWorld('ensoul', api);
