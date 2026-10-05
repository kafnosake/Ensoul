import React, { useEffect, useRef, useState } from 'react';
import { api } from '../core/api';
import { useWorkspace } from '../core/useWorkspace';
import { DockPreview } from '../dock/DockPreview';
import { DockTree } from '../dock/DockTree';
import { askForeignThrottled, barHitAt, dragHint, groupBox, hitDock, isNoop, isOutside, leftTabstrip, placeDrag, tabAnchor, willDetach, type DragSource, type DragState } from '../dock/drag'
import { ComponentBar } from './ComponentBar';
import { LayoutBar } from './LayoutBar';
import { SidebarMonitor } from './SidebarMonitor';
import { SettingsDialog } from './SettingsDialog';
import { ZoneHint } from './ZoneHint';
import { IconChevron, IconClose, IconFolderOpen, IconMax, IconMin, IconMoon, IconSettings, IconSun } from '../ui/icons';
import { getThemeMode, resolvedTheme, setTheme, onAppearance, type Theme } from '../ui/theme';
import { usePanelZoom } from '../ui/ZoomOverlay';
import { useCloseActivePanel } from '../ui/active-panel';
import { t } from '../core/i18n';
import { ChatDock } from '../panel/ChatDock';

/**
 * 主窗口：一棵大的停靠树。
 *
 * 拖的时候每帧只做一次命中判定（rAF 合并），判定结果画成一层全局预览，
 * 松手时才改一次布局树 —— 这样拖起来才跟手。
 */
/**
 * 拉出标签栏多少像素就算「撕下来」。
 *
 * 这个数是全屏可用的关键：主窗口常年是最大化的，光标到不了窗口外，
 * 所以「拖出去」只能按**离开发出的那条标签栏多远**来算。
 * 比拖拽阈值（6px）大得多，所以栏内换位置、点一下切标签都不会误触。
 */
const TEAR_PAD = 44;

export function MainShell() {
  const ws = useWorkspace();
  // Ctrl + 滚轮认领面板级缩放（全局缩放的入口在 设置 → 外观，不挂快捷键）
  usePanelZoom();
  /** Ctrl/⌘+W 关的是当前会话 —— 那个键由主进程按住（见 main/windows.ts） */
  useCloseActivePanel(ws);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [showMonitor, setShowMonitor] = useState(() => localStorage.getItem('ensoul_show_monitor') !== 'false');
  /** 隐藏 = 整个组件卸载（定时器、请求全停）；再显示时重新挂载，一挂载就拉一次最新数据 */
  const setMonitor = (on: boolean) => {
    setShowMonitor(on);
    localStorage.setItem('ensoul_show_monitor', String(on));
  };
  const showMonitorRef = useRef(showMonitor);
  showMonitorRef.current = showMonitor;

  useEffect(() => {
    const onToggle = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail;
      if (typeof detail === 'boolean') setMonitor(detail);
    };
    window.addEventListener('ensoul:monitor-set', onToggle);
    return () => window.removeEventListener('ensoul:monitor-set', onToggle);
  }, []);

  /**
   * 调出被隐藏的监视台：标题栏 ◈ 按钮，或 Ctrl/⌘+B。
   * 光靠一个按钮不够 —— 隐藏之后界面上一点痕迹都没有，用户找不回来（这是踩过的坑）。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        setMonitor(!showMonitorRef.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [showSettings, setShowSettings] = useState(false);
  const [dismissedReturn, setDismissedReturn] = useState(() => localStorage.getItem('ensoul_widget_return_dismiss') || '');
  const returnedWidget = Object.values(ws?.panels || {}).filter(panel => panel.widgetReturn && !panel.widget).sort((a, b) => b.widgetReturn!.returnedAt - a.widgetReturn!.returnedAt)[0];
  const returnKey = returnedWidget ? `${returnedWidget.id}:${returnedWidget.widgetReturn!.returnedAt}` : '';
  const dismissReturn = () => { setDismissedReturn(returnKey); localStorage.setItem('ensoul_widget_return_dismiss', returnKey); };
  /** 白天还是夜晚：换的时候贴到 html 上，选择进 localStorage，别的窗口跟着换 */
  /** 外观模式：浅色 / 深色。真源在 ui/theme.ts，这里只镜像一份，用来画那颗按钮 */
  const [themeMode, setThemeModeState] = useState<Theme>(getThemeMode());
  // 别的窗口改了、或者系统那一档变了 —— 这颗按钮跟着换
  useEffect(() => onAppearance(() => setThemeModeState(getThemeMode())), []);
  const [pickOpen, setPickOpen] = useState(false);
  /** "或粘一个路径"那一行的草稿 —— 系统目录对话框靠不住的时候还有这条路 */
  const [wsDraft, setWsDraft] = useState('');
  /** 挂在这个主窗口下面的浮窗 —— 它们会跟着主窗口一起动 */
  const kids = (ws?.floating ?? []).filter((f) => f.parent === 'main');
  /**
   * 菜单里要列的工作区：**当前这个永远排第一**。
   * 只列"最近开过"的话，那个字段一旦空着（老版本存盘时没带上），菜单里就只剩
   * 一条"打开文件夹…" —— 看着像坏的，而且换过去就再也换不回来。
   */
  const wsList: string[] = [];
  for (const d of [ws?.workspace, ...(ws?.recentWorkspaces ?? [])]) {
    if (d && !wsList.includes(d)) wsList.push(d);
  }
  /** 切到某个目录：关掉菜单，其余交给主进程（写 store、换 fs 根、推给所有窗口） */
  const switchTo = (dir: string) => {
    const next = dir.trim();
    if (!next) return;
    setPickOpen(false);
    void api.workspace.open(next);
  };
  const pending = useRef<{ source: DragSource; x: number; y: number; moved: boolean; pid?: number } | null>(null);
  const live = useRef<DragState | null>(null);
  const raf = useRef(0);
  const cursor = useRef({ x: 0, y: 0 });
  /** 顶上那条收纳区的矩形 —— 拖动时拿它判"松手是不是要收起来" */
  const barRef = useRef<HTMLDivElement>(null);
  /** 整个窗口的壳 —— 指针捕获挂在它上面（见 grab） */
  const shellRef = useRef<HTMLDivElement>(null);
  /**
   * 这一拖已经交给主进程了：正在跟手的那块不再是渲染层的吊牌，而是一块**真窗口**。
   * 交出去之后渲染层只负责报「拖到哪了 / 松手了」，落点全归主进程判。
   */
  const handedOff = useRef(false);
  /**
   * 心跳定时器：**已经不再启动**（字段留着是为了别把下面几处清理一起翻掉）。
   * 定时器不会自己停，松手信号一丢它就一直响，这一拖永远收不了尾 —— "卡死"就是这么来的。
   * "还按着"现在由指针事件证明，见 FloatingShell 里那段。
   */
  const beat = useRef(0);

  useEffect(() => {
    const flush = () => {
      raf.current = 0;
      const p = pending.current;
      if (!p) return;
      const { x, y } = cursor.current;
      const outside = isOutside(x, y);
      /*
       * 收纳区那一条自己就是一个落点（松手 = 把这一拖里的面板收起来），不参与停靠判定。
       *
       * 判定走 **barHitAt**，和"被问的那扇窗"用的是同一处（见 drag.ts）：面板一离开标签栏
       * 就撕成了浮窗，之后落点全由**光标底下那扇窗**回答 —— 两条路若有出入，同一个位置
       * 就会出现"看得见框、松手却什么都没发生"。它比这一段的矩形上下各宽 3px，擦着边也算。
       *
       * 整组标签**也**收：一组没有"本体"，但那一组里的每个面板都有，逐个收进去就是
       * "整组一起收起来"（见 store 的 stowPanels）。
       */
      const bar = outside
        ? null
        : barHitAt(x, y, p.source.kind === 'component' ? p.source.componentId : undefined);
      const raw = outside || bar ? null : hitDock(x, y);
      // 离开**它出发的那条标签栏**了没有 —— 浏览器那种"拖出去就是拿出来"靠它
      const tabIdOf = p.source.kind === 'component' || p.source.kind === 'monitor' ? undefined : p.source.tabId;
      /*
       * 离开**它出发的那条标签栏**了没有 —— 这就是「拖出来」唯一那道闸门。
       *
       * 门槛取 TEAR_PAD（44px）而不是 0：栏内横向换位置、点一下切标签都不会误触。
       * 以前这道闸门是「光标跑出窗口外」—— 可主窗口常年最大化，光标永远碰不到那个
       * 边界，于是撕窗口一次都不会发生。按距离算才是浏览器那套。
       */
      const outOfBar = !outside && !bar && leftTabstrip(tabIdOf, x, y, TEAR_PAD);
      const next: DragState = {
        source: p.source,
        from: { kind: 'main' },
        x,
        y,
        hit: raw,
        bar,
        outside,
        outOfBar,
      };
      live.current = next;
      setDrag(next);
      /*
       * 撕出一块真窗口：**离开出发那条标签栏 44 像素就够了**。
       *
       * 这里曾经还多要一条「底下没有落点」，那是错的。往下拖的时候光标底下
       * 永远是那块面板自己，那个条件永不成立 —— 于是撕窗口一次都不发生，
       * 界面上只剩一个跟手的方块图案，拖到哪儿都不真切。
       *
       * 撕出来之后落点照样算得出来：真窗口落地时问的是**光标底下那扇窗**
       * （windows.probeAt → 渲染层的 probeAt），主窗口还在原地，
       * 并组 / 分栏 / 挂件 / 侧窗它照样答得出来。
       */
      /*
       * 只有「松手真的会拿出来」这一种情况才当场撕出一块真窗口跟手（判据和松手那条路同一个）。
       *
       * 窗口里压着某块面板的时候不能撕：跟手的那块真窗口正好盖在光标底下，
       * 落点预览、让位、插入位置全被它挡住，看上去就是"拖到哪儿都不反应"。
       * 窗口内的落点由本窗口的 DOM 判，本来就准 —— 撕窗口只在离开这扇窗之后才有意义。
       */
      /*
       * 一离开出发的那条标签栏，就当场撕出一块**真窗口**挂在光标下（浏览器那套）。
       *
       * 不要求"底下没有落点"：往下拖的时候光标底下永远是那块面板自己，那个条件
       * 永不成立 —— 撕窗口一次都不会发生，界面上只剩一个跟手的方块图案。
       * 撕出来之后落点照样算得出来：真窗口落地时问的是**光标底下那扇窗**。
       */
      /*
       * 只有「松手真的会拿出来」才当场撕一块真窗口跟手（判据和松手那条路同一个）。
       *
       * 否则那块跟手的真窗口正好盖在光标底下，本窗口画的落点预览 / 让位 / 插入位置
       * 全被它挡住 —— 明明看得见框，怎么拖都不落位，就是它挡的。窗口内的落点
       * 本来就判得准，撕窗口只在离开这扇窗之后才有意义。
       */
      if (willDetach(next) && !handedOff.current) {
        handOff();
      }
      /*
       * 指针在窗口外：问一句「底下是谁、它说落在哪」。
       * 提示要说得准就得问 —— 本窗口的 DOM 看不到别的窗口里有什么（限流 70ms）。
       */
      if (next.outside) {
        const ask = askForeignThrottled();
        if (ask) {
          void ask.then((f) => {
            const cur = live.current;
            if (!cur || !cur.outside || handedOff.current) return;
            const nx = { ...cur, foreign: f };
            live.current = nx;
            setDrag(nx);
          });
        }
      }
    };

    /**
     * 把这一拖交给一块真窗口：面板（或整组标签）从布局树里摘出来、当场立户。
     * 摘走的正好是持着鼠标捕获的那个标签元素 —— 所以跟手和落点都改由主进程算
     * （见 windows.moveLive / win:tearEnd）。
     */
    const handOff = () => {
      const p = pending.current;
      if (!p || p.source.kind === 'component' || p.source.kind === 'monitor') return;
      handedOff.current = true;
      if (!beat.current) {
        beat.current = window.setInterval(() => {
          api.window.tearTick();
        }, 150);
      }
      api.window.tearTick();
      // 固定锚点：光标压在新窗口那个标签的**中心**（见 drag.ts 的 tabAnchor）。
      // 传一成不变的数，主进程拿它算位置 —— 和光标挪得快慢无关。
      const box = { ...groupBox(p.source.tabId), ...tabAnchor(p.source.tabId, p.source.kind === 'panel' ? p.source.panelId : undefined) };
      // 主进程没接住这一拖（通道没接上、那块已经不在了）就当场复原：
      // 宁可这一拖什么都没发生，也不能留一块看不见又关不掉的面板
      const undo = (ok: boolean) => {
        if (ok) return;
        handedOff.current = false;
        pending.current = null;
        live.current = null;
        if (beat.current) {
          clearInterval(beat.current);
          beat.current = 0;
        }
        setDrag(null);
      };
      const ask = p.source.kind === 'panel'
        ? api.panel.tear(p.source.panelId, box)
        : api.dock.tearTabs(p.source.tabId, box);
      void ask.then(undo, () => undo(false));
    };

    const onMove = (e: PointerEvent) => {
      const p = pending.current;
      if (!p) return;
      cursor.current = { x: e.clientX, y: e.clientY };
      if (!p.moved) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return;
        p.moved = true;
        /*
         * 确认真在拖了，才把指针攥到**壳元素**上。
         * 按下就攥住是不行的：那样这一次点击的 pointerup 会落到壳上，
         * click 再也送不到按钮上（收纳区整条点不动就是这个原因）。
         * 攥在壳上而不是标签上：标签会被卸载（拖出去时它就从布局树里走了），
         * 捕获元素一被卸载，浏览器当场收回捕获，松手信号就再也回不来了。
         */
        try {
          shellRef.current?.setPointerCapture?.(p.pid ?? 0);
        } catch {
          /* 合成事件没有有效 pointerId：窗口内这一拖照样走得完 */
        }
      }
      // 已经交出去了：这一拖「拖到哪了」由主进程算，渲染层只是那个报点的人
      if (handedOff.current) {
        if (!raf.current) {
          raf.current = requestAnimationFrame(() => {
            raf.current = 0;
            api.window.tearMove();
            api.window.tearTick();
            const cur = live.current;
            if (cur) {
              const x = cursor.current.x;
              const y = cursor.current.y;
              const next: DragState = {
                ...cur,
                x,
                y,
                bar: isOutside(x, y) ? null : barHitAt(x, y),
              };
              live.current = next;
              setDrag(next);
            }
          });
        }
        return;
      }
      if (!raf.current) raf.current = requestAnimationFrame(flush);
    };

    const onUp = () => {
      const pid = pending.current?.pid;
      if (pid != null) {
        try {
          shellRef.current?.releasePointerCapture?.(pid);
        } catch {
          /* 已经自己释放了 */
        }
      }
      const p = pending.current;
      const d = live.current;
      const off = handedOff.current;
      pending.current = null;
      live.current = null;
      handedOff.current = false;
      if (beat.current) {
        clearInterval(beat.current);
        beat.current = 0;
      }
      if (raf.current) {
        cancelAnimationFrame(raf.current);
        raf.current = 0;
      }
      setDrag(null);
      /*
       * 交出去的那一拖：落点由主进程问光标底下那扇窗来判（见 windows.probeAt）。
       * 这里再判一次就落两遍 —— 但**收纳区**那一处是主进程判的（landWindow），
       * 落点由它接住，所以这边什么都不用做。
       */
      if (off) {
        api.window.tearEnd();
        return;
      }
      if (!p) return;
      if (!d) {
        // 没移动 = 点了一下：面板切到它自己，整组则什么都不做
        if (p.source.kind === 'panel') void api.panel.activate(p.source.panelId);
        return;
      }
      void placeDrag(d);
    };

    /**
     * 失焦**不等于**这一拖结束了。
     *
     * 拖动期间源窗口一直在失焦（跟手那块真窗口就摆在它上面，还在被反复挪动），
     * 以前这里每失焦一次就发一句"松手"—— 日志里一秒能记六遍。一句话就把还在进行的
     * 一拖结算掉，面板当场脱手："拖出去之后卡一下、然后就不跟手了"就是它。
     *
     * 这一拖的收尾交给两位正主：**撕出来那块真窗口**报松手（它就在光标底下，看得见按钮），
     * 报不出来还有主进程的看门狗兜底（windows.watchLive）。两边都不靠源窗口。
     */
    const onBlur = () => {
      // 撕窗弹出或穿透屏幕时源窗口会失焦，绝不能在失焦时掐断拖拽
      if (handedOff.current) return;
      if (!pending.current && !live.current) return;
      pending.current = null;
      live.current = null;
      if (beat.current) {
        clearInterval(beat.current);
        beat.current = 0;
      }
      if (raf.current) {
        cancelAnimationFrame(raf.current);
        raf.current = 0;
      }
      setDrag(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      if (beat.current) {
        clearInterval(beat.current);
        beat.current = 0;
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  /**
   * 撕下来那块真窗口说「我上屏了」→ 这一拖的交接到此为止。
   *
   * handedOff 必须在这里清掉：它是"我正把这一拖交出去"的记号。
   * 清不掉的话，之后每一次松手都会被当成"这一拖的松手"把动作吞掉 ——
   * 那个窗口就再也点不动、也关不掉了，看上去就是"卡死"。
   */
  useEffect(
    () =>
      api.window.onLiveReady(() => {
        // 新浮窗已上屏，收掉源窗口内部的半透明跟手吊牌；
        // 指针仍在源窗口捕获中，保持 handedOff 和 pending 直到 onUp 真实松手！
        live.current = null;
        setDrag(null);
      }),
    [],
  );

  /** 主进程宣布"这一拖结束了"：所有窗口把自己那份拖拽状态清干净，绝不带着过期状态过日子 */
  useEffect(
    () =>
      api.window.onDragEnd(() => {
        handedOff.current = false;
        pending.current = null;
        live.current = null;
        if (beat.current) {
          clearInterval(beat.current);
          beat.current = 0;
        }
        if (raf.current) {
          cancelAnimationFrame(raf.current);
          raf.current = 0;
        }
        setDrag(null);
      }),
    [],
  );

  const grab = (source: DragSource, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    /*
     * 收纳区那些入口靠**原生 click** 打开，所以它们身上什么都不许截：
     * 一 preventDefault、或者一 setPointerCapture，那个 click 就再也送不到按钮上，
     * 整条收纳区会变成点不动。只有真在拖的时候才接管指针（见 onMove）。
     */
    if (source.kind !== 'component' && source.kind !== 'monitor') e.preventDefault();
    cursor.current = { x: e.clientX, y: e.clientY };
    pending.current = { source, x: e.clientX, y: e.clientY, moved: false, pid: e.pointerId };
  };

  return (
    <div className="shell" ref={shellRef}>
      <header className="titlebar">
        <div className="brand" role="img" title="ensoul" aria-label="ensoul">
          <span className="brand-mark" aria-hidden="true" />
          {kids.length > 0 && (
            <span className="win-kids" title={t('挂在这个窗口下面的浮窗：{n} 个，会跟着它一起动', { n: kids.length })}>
              ⊞ {kids.length}
            </span>
          )}

          {/* 工作区在这里选，不在设置里 —— 它是"当前在哪个项目"，一个工作区就是一个长期目录 */}
          <div className="ws-pick">
            <button className="ws-pick-btn" onClick={() => setPickOpen((v) => !v)} title={ws?.workspace ?? ''}>
              <IconFolderOpen />
              <span className="ws-pick-name">{dirName(ws?.workspace)}</span>
              <IconChevron open={pickOpen} />
            </button>

            {pickOpen && (
              <>
                <div className="ws-pick-mask" onClick={() => setPickOpen(false)} />
                <div className="ws-pick-menu">
                  <div className="ws-pick-head">{t('工作区')}</div>
                  {wsList.map((d) => (
                    <button
                      key={d}
                      className={`ws-pick-item${d === ws?.workspace ? ' is-on' : ''}`}
                      onClick={() => {
                        setPickOpen(false);
                        if (d !== ws?.workspace) void api.workspace.open(d);
                      }}
                    >
                      <span className="ws-pick-item-name">{dirName(d)}</span>
                      <span className="ws-pick-item-path">{d}</span>
                    </button>
                  ))}
                  {/* 粘一个路径也能切 —— 目录对话框在某些机器上会躲在窗口后面，
                      那时候光有"打开文件夹…"就等于没有 */}
                  <div className="ws-pick-manual">
                    <input
                      value={wsDraft}
                      placeholder={t('或粘一个路径，回车切换')}
                      spellCheck={false}
                      onChange={(e) => setWsDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') switchTo(wsDraft);
                      }}
                    />
                    <button disabled={!wsDraft.trim()} onClick={() => switchTo(wsDraft)}>
                      {t('切换')}
                    </button>
                  </div>
                  <button
                    className="ws-pick-item ws-pick-add"
                    onClick={() => {
                      setPickOpen(false);
                      void api.workspace.pick();
                    }}
                  >
                    <IconFolderOpen />
                    <span>{t('打开文件夹…')}</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        {/* 收纳区直接摆在菜单栏这一条里：左边品牌 + 工作区，中间收纳区，右边设置和窗口按钮 */}
        <ComponentBar
          ws={ws}
          barRef={barRef}
          onBar={!!drag?.bar}
          active={!!drag}
          barIndex={drag?.bar?.barIndex}
          draggingComponentId={drag?.source.kind === 'component' ? drag.source.componentId : null}
          onGrab={(componentId, name, e) => grab({ kind: 'component', componentId, name }, e)}
        />

        <div className="titlebar-actions">
          <LayoutBar ws={ws} />
          <button
            onClick={() => {
              const current = resolvedTheme();
              const next: Theme = current === 'light' ? 'dark' : 'light';
              setTheme(next);
              setThemeModeState(next);
            }}
            title={resolvedTheme() === 'light' ? t('浅色模式（点击切到深色）') : t('深色模式（点击切到浅色）')}
          >
            {resolvedTheme() === 'light' ? <IconMoon /> : <IconSun />}
          </button>
          <button onClick={() => setShowSettings(true)} title={t('设置（工作区、模型、技能、插件）')}>
            <IconSettings />
          </button>
        </div>
        <div className="win-buttons">
          <button onClick={() => void api.window.control('minimize')} title={t('最小化')}>
            <IconMin />
          </button>
          <button onClick={() => void api.window.control('maximize')} title={t('最大化')}>
            <IconMax />
          </button>
          <button className="win-close" onClick={() => void api.window.control('close')} title={t('关闭')}>
            <IconClose />
          </button>
        </div>
      </header>

      <div className="shell-body-row" style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
        {showMonitor && (
          <SidebarMonitor
            ws={ws}
            onHide={() => setMonitor(false)}
            onGrab={(panelId, name, state, e, look) =>
              grab({ kind: 'monitor', panelId, name, state, accent: look?.accent, avatar: look?.avatar }, e)
            }
            draggingPanelId={drag?.source.kind === 'monitor' ? drag.source.panelId : null}
          />
        )}
        {!showMonitor && (
          <button
            className="sbm-reveal"
            onClick={(e) => {
              e.stopPropagation();
              setMonitor(true);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            title={t('显示侧边监视台（Ctrl+B）')}
          >
            ▶
          </button>
        )}
        <main className="workspace" style={{ flex: 1, minWidth: 0 }}>
        {ws ? (
          <DockTree
            node={ws.layout}
            ws={ws}
            host={{ kind: 'main' }}
            drag={drag}
            onTabPointerDown={(panelId, tabId, e) => grab({ kind: 'panel', panelId, tabId }, e)}
            onStripPointerDown={(tabId, e) => grab({ kind: 'tabs', tabId }, e)}
          />
        ) : (
          <div className="blank">{t('正在打开工作区…')}</div>
        )}
      </main>
      </div>

      {returnedWidget && returnKey !== dismissedReturn && <div className="widget-return-notice" role="status">
        <span>{t('已收回')} · {returnedWidget.title}</span>
        <button onClick={() => void api.window.restoreWidget(returnedWidget.id)}>{t('撤销收回')}</button>
        <button aria-label={t('关闭提示')} onClick={dismissReturn}>✕</button>
      </div>}
      <ZoneHint />

      <DockPreview hit={drag?.hit ?? null} hidden={!!drag && willDetach(drag)} sameGroup={!!drag && isNoop(drag)} />
      <DragOverlay
        drag={drag}
        busy={!!ws && drag?.source.kind === 'panel' && ws.panels[drag.source.panelId]?.status === 'working'}
      />
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
    </div>
  );
}

/**
 * 跟着指针的一句落点提示。
 *
 * 跟手的东西是**那块面板本体的真窗口** —— 一离开标签栏就撕出来。
 * 界面上不再画任何"模拟的小窗"：一块假窗户跟着走，只会盖住底下的落点。
 *
 * busy = 这一轮还没跑完（收不进去，提示里要说清）
 */
function DragOverlay({ drag, busy }: { drag: DragState | null; busy?: boolean }) {
  if (!drag) return null;

  return (
    <>
      <div className="drag-hint">
        {drag.source.kind === 'component' ? (
          drag.outside ? (
            t('松开 → 不打开，入口还在组件区里')
          ) : drag.hit?.mode === 'center' ? (
            t('松开 → 打开到这儿，并进这组标签')
          ) : drag.hit ? (
            t('松开 → 打开到这儿，分成新的一块')
          ) : (
            t('拖到某块区域的中间或边上再松手 → 打开到那儿')
          )
        ) : (
          dragHint(drag)
        )}
      </div>

      {/*
        监视台里抓出来的会话：跟手一张半透明的影子卡（便签靠浏览器的 drag image，
        我们这条是自绘指针管线，浏览器不会给图 —— 得自己画一张跟着光标走）。
        pointer-events:none 才不挡 elementFromPoint 的命中判定（同 .drag-hint）。
      */}
      {drag.source.kind === 'monitor' && (
        <div className="drag-session-ghost" style={{ left: drag.x, top: drag.y }}>
          <span className="dsg-avatar" style={{ background: drag.source.accent || 'var(--accent)' }}>
            {drag.source.avatar ? <img src={drag.source.avatar} alt="" /> : drag.source.name.trim().charAt(0) || '?'}
          </span>
          <span className="dsg-name">{drag.source.name}</span>
        </div>
      )}
    </>
  );
}



/** 指针是不是落在这一块里（收纳区那条就是靠它判"松手要不要收起来"） */
function inRect(el: HTMLElement | null, x: number, y: number): boolean {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** 路径最后一段，当工作区的显示名 */
function dirName(p?: string): string {
  if (!p) return t('选工作区');
  const clean = p.replace(/[\\/]+$/, '');
  return clean.split(/[\\/]/).pop() || p;
}
