import { useEffect, useRef } from 'react';
import type { Workspace } from '../../shared/types';
import { api } from '../core/api';

/**
 * 当前"正在用"的那块面板 —— Ctrl/⌘+W 关的就是它。
 *
 * 每个窗口各有一份（各自独立的文档环境），所以主窗口按的关主窗口的面板、
 * 浮窗按的关浮窗的 —— 不用再把"哪个窗口"传来传去。
 */
let lastActive = '';

export function markActivePanel(id: string) {
  if (id) lastActive = id;
}

export function activePanelId() {
  return lastActive;
}

/**
 * Ctrl/⌘ + W：关掉当前会话，而不是整扇窗。
 *
 * 键是**主进程**拦下来的（见 main/windows.ts 的 before-input-event）—— Chromium
 * 自己就认这个键，渲染层根本收不到；只有主进程能按住它，再让界面去关面板。
 */
export function useCloseActivePanel(ws: Workspace | null) {
  const ref = useRef(ws);
  ref.current = ws;
  useEffect(() => {
    return api.ui.onClosePanel(() => {
      const id = activePanelId();
      if (!id || !ref.current?.panels[id]) return;
      void api.panel.close(id);
    });
  }, []);
}
