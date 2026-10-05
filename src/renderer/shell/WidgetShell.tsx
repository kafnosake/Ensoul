import React from 'react';
import { api } from '../core/api';
import { useWorkspace } from '../core/useWorkspace';
import { PanelSurface } from '../panel/PanelSurface';
import { ChatDock } from '../panel/ChatDock';
import { t } from '../core/i18n';
import { DesktopCreate } from './DesktopCreate';
import { DesktopSurface } from './DesktopSurface';
import { DesktopGlass } from './DesktopGlass';
import { useWidgetDrag } from './useWidgetDrag';

/**
 * 挂件窗口 —— 一扇**只装一块面板**的窗口（见 Panel.widget）。
 *
 * 它跟 FloatingShell 的关系，是"一个面板"跟"一棵停靠树"的关系：
 * 浮窗里还能叠标签、能分块；挂件窗口里就只有这一块 —— 所以这里没有 DockTree、
 * 没有标签栏、没有落点判定，就一块裸的面板铺满整扇窗。
 *
 * 三件事决定了它的画法：
 *
 *   1. **无壳**：这扇窗 frame: false，所以页面上不该再有边框、标题栏、阴影 ——
 *      留了就是"窗前还有一层壳"，拖起来看着像两个窗口。
 *   2. **背景交给面板自己**：window 可以是透明的（形象有轮廓的挂件），
 *      所以这里**不铺任何底色** —— 铺了透明就白设了。面板自己的 CSS 决定画什么。
 *   3. **可穿透**：透明处要漏鼠标给底下的程序（桌宠这一类）。穿透由面板自己声明
 *      （floatBare 那套的老规矩：实心件要显式写 pointer-events: auto），
 *      这里只负责给它一块能透的底。
 *
 * 这一层刻意做得很薄：挂件长什么样是**面板的事**，核心只负责"让它成为一扇窗"。
 */
export function WidgetShell({ panelId }: { panelId: string }) {
  const ws = useWorkspace();
  const panel = ws?.panels?.[panelId];
  const drag = useWidgetDrag(panel);
  const isEditor = new URLSearchParams(location.search).get('edit') === '1';

  /**
   * 面板没了（被关掉、被并回布局）→ 这扇窗也就没有存在的理由。
   *
   * 不能让它留成一块白板：无壳、置顶的窗口一旦空白，就是"屏幕上贴着个透明方块，
   * 看不见也点不着"—— 比浮窗那种白板更难发现。所以面板一没，当场让主进程关窗。
   */
  React.useEffect(() => {
    if (ws && !panel) void api.window.closeWidget(panelId);
  }, [ws, panel, panelId]);

  /**
   * 桌面组件（panel.widget.card）—— 整扇窗退成"透明的画布"，卡面由这一层自己画。
   *
   * 为什么非要把底色挪到页面里：卡片的圆角得靠**窗口透明**才铰得出来。
   * 窗口一旦不透明，四角就是方的，网页画的圆角会被窗口底色填成直角（见 PanelWidget.card）。
   */
  const isCard = panel?.widget?.card === true;
  React.useEffect(() => {
    if (!isCard || isEditor) return;
    document.documentElement.classList.add('widget-card-document');
    return () => document.documentElement.classList.remove('widget-card-document');
  }, [isCard, isEditor]);

  if (!panel) {
    /**
     * 还没拿到状态（首帧）或面板刚消失 —— 画一层空的占位，什么都不显示。
     * 底下不留底色：这就是"透明窗口"该有的样子。
     */
    return <div className="widget-shell" />;
  }

  if (isEditor) {
    return <div className="desktop-editor"><header>{panel.title} · 编辑桌面组件</header>
      <div className="desktop-editor-chat"><ChatDock panel={panel} hostKey="main" full /></div></div>;
  }
  
  return (
    <div className={isCard ? 'widget-shell widget-card' : 'widget-shell'}
      {...(isCard ? drag : {})}
      onPointerDownCapture={isCard ? event => {
        if (event.button !== 0 || !(event.target as Element).closest('input, textarea, select, [contenteditable="true"]')) return;
        void api.ext.sectionAction('widget-dock', 'desktop', 'focusInput', panelId);
      } : undefined}
      onContextMenu={isCard ? (event) => { event.preventDefault(); void api.window.widgetMenu(panelId); } : undefined}>
      {isCard && <div className="desktop-drag-handle" title={t('拖动组件')}><span /></div>}
      <div className="widget-tools">
        {isCard && <button type="button" title={t('编辑组件')} aria-label={t('编辑组件')} onClick={() => void api.window.editWidget(panelId)}><WidgetIcon action="edit" /></button>}
        <button
          type="button"
          title={t('收回本体（可撤销）')}
          onClick={() => void api.window.closeWidget(panelId)}
        >
          {isCard ? <WidgetIcon action="return" /> : t('收回')}
        </button>
        <button
          type="button"
          className="is-danger"
          title={t('删掉这个组件')}
          onClick={() => void api.panel.close(panelId)}
        >
          {isCard ? <WidgetIcon action="close" /> : '✕'}
        </button>
      </div>
      <div className="widget-body">
        {isCard && panel.widget && <DesktopGlass panelId={panelId} box={panel.widget} />}
        {isCard ? <DesktopSurface panel={panel} /> : <PanelSurface panel={panel} hostKey={`widget:${panelId}`} />}
      </div>
      {isCard && <DesktopCreate panelId={panel.id} initial={panel.kind === 'chat'} />}
    </div>
  );
}

function WidgetIcon({ action }: { action: 'edit' | 'return' | 'close' }) {
  const paths = { edit: 'M3 11V8l7-7 3 3-7 7H3ZM8 3l3 3', return: 'M6 3 2 7l4 4M2 7h8a3 3 0 0 1 0 6', close: 'm3 3 8 8M11 3l-8 8' };
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[action]} /></svg>;
}
