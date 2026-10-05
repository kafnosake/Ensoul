import React, { useEffect, useState } from 'react';
import { api } from '../core/api';
import { t } from '../core/i18n';

/**
 * 界面缩放 —— 两个乘区，各管各的。
 *
 *  · **全局**：整个界面一起变，真源在主进程（main/zoom.ts），走 Electron 原生缩放。
 *    入口在 设置 → 外观，所以这里不挂任何全局快捷键 —— 那是很容易被误触的破坏性动作。
 *  · **面板级**：只放大光标底下那一块面板的内容（Ctrl + 滚轮）。落在面板自己身上
 *    （Panel.uiZoom），跟着面板走。
 *
 * 为什么不用 CSS 乘区做全局那一个：乘区记在 webContents 自己身上，主进程随手读得到，
 * 跨窗口拖拽那些「屏幕坐标 ↔ 页面坐标」的换算才有唯一真源 —— CSS 那套主进程看不见，
 * 一遇到落点判定就会两边分家。
 */

const MIN = 0.75;
const MAX = 2;
const STEP = 0.05;

export const clampZoom = (n: number) =>
  Math.round(Math.min(MAX, Math.max(MIN, Number.isFinite(n) ? n : 1)) * 100) / 100;

/**
 * 全局缩放。别处改（另一个窗口、或者将来别处加的入口）靠 onZoom 跟上，
 * 自己改则等主进程把**钳过的真值**回过来再落 —— 界面永远显示的是真值。
 */
export function useGlobalZoom() {
  const [factor, setFactor] = useState(1);

  useEffect(() => {
    let alive = true;
    void api.ui.getZoom().then((f) => {
      if (alive) setFactor(f);
    });
    const off = api.ui.onZoom((f) => setFactor(f));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const apply = (next: number) => {
    void api.ui.setZoom(clampZoom(next)).then(setFactor);
  };

  return { factor, apply };
}

/**
 * 面板级缩放：Ctrl + 滚轮，指着哪块面板就调哪块。
 *
 * 面板的缩放不在这儿实现（它跟着面板走、还被存下来），这里只负责把手势认出来，
 * 再叫面板自己去改 —— 一个面板一份，互不影响。
 */
export function usePanelZoom() {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const host = (e.target as HTMLElement | null)?.closest?.('.panel-surface');
      if (!host) return;
      const panelId = host.getAttribute('data-panel-id');
      if (!panelId) return;
      // 认领这一下：不然浏览器自己还会拿它去缩整页（那是另一种分家）
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(
        new CustomEvent('ensoul:panel-zoom', {
          detail: { panelId, delta: e.deltaY < 0 ? STEP : -STEP },
        }),
      );
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);
}

/**
 * 面板的比例显示 —— 挂在对话区头部那一行、git 状态条的右手边。
 *
 * 为什么不浮在面板的角上：四个角各有主人（右上角正是 git 状态条，右下角是输入区），
 * 浮上去迟早压着谁（踩过：右上角的 110% 把「新 5」挡掉一半）。头部那一行本来就是
 * 「这块面板现在是什么处境」的地方 —— 比例放这儿，跟旁边那些字是一类东西。
 *
 * 没有对话区的面板不显示 —— 那种面板要看比例，把对话区打开就有（本来就是可选项）。
 *
 * 100% 时极淡（只当「这儿写着现在是几倍」）；不在 100% 就亮起来、点一下还原 ——
 * 调歪了只能一点点往回滚，那不叫功能。
 */
export function PanelZoomChip({ panelId, uiZoom }: { panelId: string; uiZoom?: number }) {
  const zoom = clampZoom(uiZoom ?? 1);
  const off = Math.abs(zoom - 1) < 0.001;
  return (
    <button
      type='button'
      className={'panel-zoom-hud' + (off ? '' : ' is-off')}
      onClick={(e) => {
        // 头部整条是可点的（非满幅时点一下收起/展开），别让这一下跟着动
        e.stopPropagation();
        if (!off) void api.panel.patch(panelId, { uiZoom: 1 });
      }}
      title={off ? t('Ctrl + 滚轮可放大这块面板') : t('点击还原到 100%')}
      tabIndex={-1}
    >
      {Math.round(zoom * 100)}%
    </button>
  );
}

/** 全局缩放的提示胶囊（只在设置里改的时候闪一下） */
export function ZoomHud({ factor, visible }: { factor: number; visible: boolean }) {
  if (!visible) return null;
  return <div className="zoom-hud-capsule">{Math.round(factor * 100)}%</div>;
}
