import React, { useRef, useState } from 'react';
import type { DockNode, DockSplit, TabGroup, Workspace } from '../../shared/types';
import { isTabGroup } from '../../shared/types';
import { api } from '../core/api';
import { IconChat, IconClose, IconEmpty, IconPlus } from '../ui/icons';
import { statusClass, statusColor, statusLabel } from '../ui/status';
import { PanelSurface } from '../panel/PanelSurface';
import { FloatPanel } from '../panel/FloatPanel';
import type { DragState, Host } from './drag';
import { isNoop, willDetach } from './drag';
import { zoomScale } from '../ui/zoom-space';
import { t } from '../core/i18n';

/**
 * 停靠树：主窗口和浮窗渲染的是同一个组件。
 *
 * 叶子是标签组（若干面板叠成标签），内部节点是切分（左右 / 上下）。
 * 分块怎么来的？不是点出来的，是拖出来的 —— 面板（或整个标签组）拖到另一块的边上松手，
 * 树里就多了个 split 节点。
 */
export interface DockProps {
  node: DockNode;
  ws: Workspace;
  host: Host;
  drag: DragState | null;
  onTabPointerDown: (panelId: string, tabId: string, e: React.PointerEvent) => void;
  /** 拖标签栏的空白处 = ？两种壳不一样，见 stripTitle */
  onStripPointerDown: (tabId: string, e: React.PointerEvent) => void;
  /** 双击标签栏空白处（如浮窗铺满全屏/还原） */
  onStripDoubleClick?: (tabId: string, e: React.MouseEvent) => void;
  /**
   * 标签栏空白处的拖动是干什么的 —— 两个壳不一样：
   *   主窗口：搬动整组标签（它上面还有一条真正的标题栏）
   *   浮窗：  移动这个窗口（浮窗没有标题栏，标签栏自己就是窗口的顶）
   */
  stripTitle?: string;
}

export function DockTree(props: DockProps) {
  return isTabGroup(props.node) ? (
    <TabsView {...props} node={props.node} />
  ) : (
    <SplitView {...props} node={props.node} />
  );
}

function SplitView({ node, ...rest }: DockProps & { node: DockSplit }) {
  const box = useRef<HTMLDivElement>(null);

  /**
   * 拖分割线改比例。
   *
   * **这条路上一个 setState 都不发**：比例直接写到容器的 CSS 变量 `--split` 上，
   * 两个 `.dock-cell` 的 flex-grow 读它（见 dock.css）。为什么值得绕开 React：
   *
   *   · 老写法每动一下就 `setLive()` —— 把 SplitView 整个重渲染一遍，而这棵子树里
   *     住着无限画布和一条几百条消息的对话（画布那张脸在渲染里还要读一次布局算小地图）。
   *   · 更要命的是老写法每次移动**先读 getBoundingClientRect()、紧接着改样式**：
   *     读布局 → 写样式 → 再读，浏览器只能每帧强制同步重排一次（layout thrashing）。
   *   拖着分割线"电脑特别卡"，主因就是这两条。
   *
   * 现在每次移动只做两件事：算一个数、写一个变量。盒子尺寸**只在按下时量一次**
   * （容器自己不会在拖动中改大小），同一帧里多余的移动用 rAF 合并掉。
   */
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const boxEl = box.current;
    if (!boxEl) return;
    document.body.classList.add('is-resizing');

    const r = boxEl.getBoundingClientRect(); // 只量这一次
    const horizontal = node.direction === 'row';
    const span = horizontal ? r.width : r.height;
    const from = horizontal ? r.left : r.top;
    /** 落点 → 比例（0.08–0.92），跟老写法同一套钳制 */
    const at = (ev: { clientX: number; clientY: number }) =>
      span > 0 ? Math.max(0.08, Math.min(0.92, ((horizontal ? ev.clientX : ev.clientY) - from) / span)) : node.ratio;

    let raf = 0;
    let latest = node.ratio;
    const move = (ev: PointerEvent) => {
      latest = at(ev);
      // pointermove 比帧密得多，不合并就是白算几十次
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          boxEl.style.setProperty('--split', String(latest));
        });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      const final = at(ev);
      // 把手写的值**定在最终比例上**，而不是抹掉：抹掉会让这个变量暂时缺失，
      // 两个 cell 各退成 flex-grow:1 闪一下。定在同值上，React 之后写不写都对得上。
      boxEl.style.setProperty('--split', String(final));
      document.body.classList.remove('is-resizing');
      void api.dock.setRatio(node.id, final, rest.host.kind === 'floating' ? rest.host.windowId : undefined);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className={`dock-split dock-${node.direction}`}
      ref={box}
      /* 比例由 CSS 变量下发（拖动中由上面那段直接改它，不走 React） */
      style={{ ['--split' as any]: String(node.ratio) }}
    >
      <div className="dock-cell">
        <DockTree {...rest} node={node.children[0]} />
      </div>
      <div className={`dock-gutter gutter-${node.direction}`} onPointerDown={startResize} title={t('拖动调整比例')} />
      <div className="dock-cell">
        <DockTree {...rest} node={node.children[1]} />
      </div>
    </div>
  );
}

function TabsView({
  node,
  ws,
  host,
  drag,
  onTabPointerDown,
  onStripPointerDown,
  onStripDoubleClick,
  stripTitle,
}: DockProps & { node: TabGroup }) {
  const active = node.active ? ws.panels[node.active] : null;
  /**
   * 落到**自己这一块**上，而且这一落等于没落（见 isNoop）：不亮蓝边、也不画预览。
   * 会在自己那组里挪位置时亮一下边框，看着像"要并进哪儿"，可松手什么都不发生。
   */
  const hitTab = drag?.hit?.tabId ?? null;
  const noop = Boolean(drag && hitTab === node.id && isNoop(drag));
  const isTarget = Boolean(drag && !drag.outside && hitTab === node.id && !noop);
  /**
   * 落点就在**这一条标签栏**上 → 插到第几个位置（拖动中实时跟着左右走）。
   * 这一处不画框：要表示的是"插进它们中间"，所以由下面那个空位把标签挤开。
   */
  const isSourceGroup = Boolean(drag && drag.source.kind === 'tabs' && drag.source.tabId === node.id);
  const draggingPanelId = drag && drag.source.kind === 'panel' ? drag.source.panelId : null;
  const selfPanelIndex = draggingPanelId ? node.panels.indexOf(draggingPanelId) : -1;
  const isSameGroupDrag = selfPanelIndex >= 0;

  /**
   * 优雅插槽判定：同组内拖拽时，只有真正跨过相邻标签才显示指示线，
   * 原位时不显示跳动插槽；跨组或外部拖入时保持标准位置指示。
   */
  const insertAt = (() => {
    if (!drag || drag.outside || drag.source.kind === 'tabs' || !drag.hit || drag.hit.tabId !== node.id || drag.hit.mode !== 'tabs') {
      return null;
    }
    const raw = drag.hit.index ?? node.panels.length;
    if (isSameGroupDrag) {
      if (raw === selfPanelIndex) return null;
      return raw < selfPanelIndex ? raw : raw + 1;
    }
    return raw;
  })();
  const lifting = Boolean(drag && isSourceGroup && willDetach(drag));
  /** 标签上右键出来的小菜单 —— 面板自己的操作就该在面板上，不该逼人去设置里找 */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  /** 本组根节点 —— 量缩放倍率要从这里上溯（见 ui/zoom-space.ts） */
  const root = useRef<HTMLElement | null>(null);

  const hostKey = host.kind === 'main' ? 'main' : host.windowId;
  /** 挂在这一组区域上的挂件（把一块浮窗拖到面板正中就是它）：切标签、挪区域它都在 */
  const widgets = Object.values(ws.panels).filter((p) => p.float && p.float.host === hostKey && p.float.anchor === node.id);
  const newHere = () =>
    void api.panel.create(
      { kind: 'chat' },
      host.kind === 'main'
        ? { where: 'main', tabId: node.id, mode: 'center' }
        : { where: 'floating', windowId: host.windowId, tabId: node.id, mode: 'center' },
    );

  return (
    <section
      className={`tabs-group${isTarget ? ' is-drop-target' : ''}${isSourceGroup ? ' is-dragging' : ''}${lifting ? ' is-lifting' : ''}`}
      data-tab-id={node.id}
      ref={root}
    >
      <header
        className="tabstrip"
        onPointerDown={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest('.tab') || t.closest('button')) return;
          onStripPointerDown(node.id, e);
        }}
        onDoubleClick={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest('.tab') || t.closest('button')) return;
          onStripDoubleClick?.(node.id, e);
        }}
        title={stripTitle ?? t('拖动空白处 = 搬动整组')}
      >
        <div className="tabs">
          {node.panels.map((id, i) => {
            const p = ws.panels[id];
            if (!p) return null;
            return (
              <React.Fragment key={id}>
                {insertAt === i && <span className="tab-slot" />}
              <div
                key={id}
                data-panel-id={id}
                className={`tab${node.active === id ? ' is-on' : ''}${draggingPanelId === id ? ' is-dragging' : ''}`}
                onPointerDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    e.stopPropagation();
                    void api.panel.close(id);
                    return;
                  }
                  onTabPointerDown(id, node.id, e);
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    e.stopPropagation();
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  // 菜单是 fixed：面板缩放过之后 left/top 会被再乘一次倍率（实测），
                  // 先换回面板内部单位，指针和菜单才对得上
                  const k = zoomScale(root.current);
                  setMenu({ id, x: e.clientX / k, y: e.clientY / k });
                }}
                title={t('拖动：换位置 / 出窗口变浮窗；中键关闭；右键更多')}
              >
                <span
                  className={`tab-dot ${statusClass(p)}`}
                  style={{ background: statusColor(p), color: statusColor(p) }}
                  title={statusLabel(p)}
                />
                <span className="tab-title">{p.title}</span>
                {p.kind !== 'chat' && (
                  <button
                    className={`tab-chat${p.look.showChat ? ' is-on' : ''}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() =>
                      void api.panel.patch(id, { look: { ...p.look, showChat: !p.look.showChat } })
                    }
                    title={p.look.showChat ? t('关掉对话') : t('和它对话')}
                  >
                    <IconChat />
                  </button>
                )}
                <button
                  className="tab-x"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => void api.panel.close(id)}
                  title={t('关闭面板')}
                >
                  <IconClose />
                </button>
              </div>
              </React.Fragment>
            );
          })}
          {insertAt != null && insertAt >= node.panels.length && <span className="tab-slot" />}
        </div>
        <button className="tab-add" onPointerDown={(e) => e.stopPropagation()} onClick={newHere} title={t('在这一组里新建面板')}>
          <IconPlus />
        </button>
      </header>

      <div className="tabs-body">
        {active ? (
          <PanelSurface key={active.id} panel={active} hostKey={host.kind === 'main' ? 'main' : host.windowId} />
        ) : (
          <div className="group-empty">
            <span className="empty-icon">
              <IconEmpty />
            </span>
            <div className="empty-title">{t('这里是空的')}</div>
            <div className="empty-note">{t('新建一个面板，或者把别处的标签拖过来')}</div>
            <button className="primary" onClick={newHere}>
              {t('新建面板')}
            </button>
          </div>
        )}
      </div>

      {/*
       * 挂件画在这一组里面。默认锁着（见 FloatPanel）—— 摆好之后它就只是一块内容，
       * 鼠标贴上去才露出一个小锁；解开才能拖、改大小、解除。
       */}
      {widgets.map((p) => (
        <FloatPanel key={p.id} panel={p} hostKey={hostKey} />
      ))}

      {menu && (
        <>
          <div
            className="ctx-mask"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
            <button
              onClick={() => {
                void api.components.declare(menu.id, '');
                setMenu(null);
              }}
              title={t('永久保存这块面板')}
            >
              {t('存成组件')}
            </button>
            <button
              onClick={() => {
                for (const pid of node.panels) if (pid !== menu.id) void api.panel.close(pid);
                setMenu(null);
              }}
            >
              {t('关闭其他')}
            </button>
            <button
              onClick={() => {
                void api.panel.close(menu.id);
                setMenu(null);
              }}
              title={t('关闭')}
            >
              {t('关闭')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
