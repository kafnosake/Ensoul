import React from 'react';
import type { Panel } from '../../shared/types';
import { api } from '../core/api';

export function useWidgetDrag(panel: Panel | undefined) {
  const pointer = React.useRef<number | null>(null);
  const frame = React.useRef(0);
  const panelId = panel?.id;
  const end = () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    if (pointer.current !== null) api.window.endDrag();
    pointer.current = null;
  };
  React.useEffect(() => {
    const cancel = () => end();
    window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('blur', cancel); end(); };
  }, [panelId]);
  const finish = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== event.pointerId) return;
    end();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if (!panel?.widget?.card || event.button !== 0 || pointer.current !== null) return;
      if ((event.target as Element).closest('button, input, textarea, select, a, [role="button"], [contenteditable="true"], [data-desktop-interactive], .widget-tools')) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      pointer.current = event.pointerId;
      api.window.beginDrag();
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      if (pointer.current !== event.pointerId || frame.current) return;
      frame.current = requestAnimationFrame(() => { frame.current = 0; api.window.moveDrag(); });
    },
    onPointerUp: finish,
    onPointerCancel: finish,
    onLostPointerCapture: finish,
  };
}
