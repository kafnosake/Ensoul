import React from 'react';
import type { Panel } from '../../shared/types';
import { api } from '../core/api';
import { ChatDock } from './ChatDock';
import { ImageView } from '../ui/ImageView';
import { PanelBoundary } from './PanelBoundary';
import { panelType, panelTypesRevision, subscribePanelTypes } from './registry';
import { FitBox } from './FitBox';
import { clampZoom } from '../ui/ZoomOverlay';
import { markActivePanel } from '../ui/active-panel';
import { t } from '../core/i18n';

/**
 * 一个面板的身体。
 *
 * 面板自己就是对话框，所以这里只有三部分：
 *   外观（look）+ 主体（由注册表按 kind 渲染）+ 对话区。
 * 主体怎么画完全交给注册表 —— 加新面板类型不需要碰这个文件。
 */
export function PanelSurface({ panel, hostKey }: { panel: Panel; hostKey?: string }) {
  /**
   * 面板主体是**外来的代码**（插件自带的脸就是），它抛异常不该把整个窗口带走。
   * 兜底包在最外面一层：里面是主体还是对话区，坏了都一样有话说。
   */
  return (
    <PanelBoundary kind={panel.kind}>
      <ZoomShell panel={panel} hostKey={hostKey} />
    </PanelBoundary>
  );
}

/**
 * 面板级缩放（Ctrl + 滚轮）—— 只改**这一块面板**的观感，不动邻居、不动布局。
 *
 * 用 CSS 的 zoom，而不是 transform: scale：
 *   · transform 只改画面，放大的内容会顶出边界被裁掉，想滚都滚不到 —— 那不是「看清一点」；
 *   · zoom 是**重新排版**（和浏览器整页缩放同一个机制）：字变大、行重排，滚动照旧能滚。
 * 这也正是它不需要后续适配的原因：新面板、插件自带的面板，什么都不用写，
 * 套进这一层就跟着缩放。
 */
function ZoomShell({ panel, hostKey }: { panel: Panel; hostKey: string | undefined }) {
  const zoom = clampZoom(panel.uiZoom ?? 1);


  /** Ctrl+滚轮落在本面板上（usePanelZoom 认人之后喊一声）→ 改自己的缩放 */
  React.useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as { panelId: string; delta: number } | undefined;
      if (!d || d.panelId !== panel.id) return;
      const next = clampZoom((panel.uiZoom ?? 1) + d.delta);
      if (next !== (panel.uiZoom ?? 1)) void api.panel.patch(panel.id, { uiZoom: next });
    };
    window.addEventListener('ensoul:panel-zoom', on);
    return () => window.removeEventListener('ensoul:panel-zoom', on);
  }, [panel.id, panel.uiZoom]);

  return (
    <div className='panel-zoom-box' onMouseEnter={() => markActivePanel(panel.id)}>
      <div className='panel-zoom-inner' style={{ zoom } as React.CSSProperties}>
        <Surface panel={panel} hostKey={hostKey} />
      </div>
    </div>
  );
}

function Surface({ panel, hostKey }: { panel: Panel; hostKey?: string }) {
  // 插件自带的面板类型是**启动之后**才装进注册表的（要等插件清单从主进程回来），
  // 所以这里订阅它：装好了这个面板才会重画。不订阅的话，界面看起来就是「装了没反应」。
  React.useSyncExternalStore(subscribePanelTypes, panelTypesRevision, panelTypesRevision);
  const def = panelType(panel.kind);
  const setText = (text: string) => void api.panel.patch(panel.id, { spec: { ...panel.spec, text } });
  const isChat = panel.kind === 'chat';
  /**
   * 看图那一层 —— **挂在这儿、每块面板各一份**。
   * 以前它挂在根上（main.tsx）而且是 fixed 全窗口的：一张图把侧边栏、标题栏、
   * 别的面板一起盖掉，可「我现在在看这张图」只跟**这块面板**有关。
   * 放在这儿它按 absolute 铺满 .panel-surface（那个是 relative 的），几何上出不去。
   * 谁开的图由 image-open 里那个 panel 字段认，不是这块面板开的就不亮。
   */
  const viewer = <ImageView panel={panel.id} />;

  /**
   * 动作按钮（spec.actions）。**两种面板都要画** —— 以前只画在「非对话」那一支里，
   * 于是 chat 面板规格里的 actions 一个都不显示（规格里明明有这个字段）。
   * 按钮把 prompt 当消息发出去：以 / 开头的会走主进程的斜杠命令，**不经模型**。
   */
  // actions 可能缺（老存档、第三方塞进来的规格）—— 缺了就当没有。
  // 直接读 .length 会让**整块面板**裂开，而这只是个按钮栏，不值得赔上整个面板。
  const actions = panel.spec.actions ?? [];
  const actionsRow =
    actions.length > 0 ? (
      <div className='panel-actions'>
        {actions.map((a) => (
          <button key={a.id} title={a.prompt} onClick={() => void api.chat.send(panel.id, a.prompt || a.label)}>
            {a.label}
          </button>
        ))}
      </div>
    ) : null;

  // 对话面板：消息占满、输入框贴底，和主流对话工具一样。
  // 别的面板：主体 + （需要时才有的）会话。
  if (isChat) {
    return (
      <div
        className={`panel-surface density-${panel.look.density}${panel.chatSide ? ` chat-side-${panel.chatSide}` : ''}`}
        data-panel-id={panel.id}
        style={{ ['--accent' as any]: panel.look.accent }}
      >
        {actionsRow && <div className='panel-actions-dock'>{actionsRow}</div>}
        <ChatDock panel={panel} hostKey={hostKey} full />
        {viewer}
      </div>
    );
  }

  return (
    <div
      className={`panel-surface density-${panel.look.density}${panel.chatSide ? ` chat-side-${panel.chatSide}` : ''}`}
      data-panel-id={panel.id}
      style={{ ['--accent' as any]: panel.look.accent }}
    >
      {/*
        主体外面统一套一层自适应层 —— **所有面板都过，面板自己一句话都不用说**。
        装不下的固定内容（一块钟、一张卡）整块缩放着装进这块地方：拉大就涨、拉小就缩，
        既不出现滚动条也不会裁掉半截；会滚的弹性内容（会话、文件树、编辑器）
        一根手指都不碰，它们自己滚才是对的。判据和量法都在 panel/FitBox.tsx。
      */}
      <FitBox>
        <div className='panel-main'>
          {/* 只有这一层滚：面板本身和工具栏都不跟着动 */}
          <div className='panel-scroll'>
            {def ? (
              def.body({ panel, setText })
            ) : (
              <div className='body-blank'>
                <div className='blank-title'>{t('未知的面板类型：')}{panel.kind}</div>
                <div className='blank-note'>{t('注册表里没有这一种，去 registry.tsx 里注册一个就能渲染了。')}</div>
              </div>
            )}
          </div>
          {actionsRow}
        </div>
      </FitBox>
      {panel.look.showChat && <ChatDock panel={panel} hostKey={hostKey} />}
      {viewer}
    </div>
  );
}
