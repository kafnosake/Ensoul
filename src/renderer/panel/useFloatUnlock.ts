import { useEffect, useRef, useState } from 'react';
import type { PointerEvent, MouseEvent } from 'react';

const HOLD_MS = 900;
const MOVE_TOLERANCE = 8;
const INTERACTIVE = 'button, input, textarea, select, a, [role="button"], [contenteditable]:not([contenteditable="false"]), [data-no-float-unlock]';

interface Hold {
  pointerId: number;
  x: number;
  y: number;
  started: number;
  completed: boolean;
}

export function useFloatUnlock(locked: boolean, unlock: () => void) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const progress = useRef<SVGCircleElement>(null);
  const hold = useRef<Hold | null>(null);
  const frame = useRef<number | null>(null);
  const blockMenuUntil = useRef(0);
  const unlockRef = useRef(unlock);
  unlockRef.current = unlock;

  const cancel = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    hold.current = null;
    setPoint(null);
  };

  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const active = hold.current;
      if (!active || event.pointerId !== active.pointerId || active.completed) return;
      if (!(event.buttons & 2) || Math.hypot(event.clientX - active.x, event.clientY - active.y) > MOVE_TOLERANCE) cancel();
    };
    const stop = (event: globalThis.PointerEvent) => {
      const active = hold.current;
      if (!active || event.pointerId !== active.pointerId) return;
      if (active.completed) blockMenuUntil.current = performance.now() + 1000;
      cancel();
    };
    const down = (event: globalThis.PointerEvent) => {
      if (hold.current && event.buttons !== 2) cancel();
    };
    const leave = (event: globalThis.PointerEvent) => {
      if (!event.relatedTarget) cancel();
    };
    const hidden = () => { if (document.hidden) cancel(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', stop, true);
    window.addEventListener('pointercancel', stop, true);
    window.addEventListener('lostpointercapture', stop, true);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerout', leave, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', stop, true);
      window.removeEventListener('pointercancel', stop, true);
      window.removeEventListener('lostpointercapture', stop, true);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerout', leave, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', escape);
      document.removeEventListener('visibilitychange', hidden);
      cancel();
    };
  }, []);

  useEffect(() => {
    if (!locked && !hold.current?.completed) cancel();
  }, [locked]);

  const onPointerDownCapture = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button === 2) blockMenuUntil.current = 0;
    if (!locked || event.button !== 2 || event.buttons !== 2) return;
    if ((event.target as Element).closest(INTERACTIVE)) return;
    cancel();
    const bounds = event.currentTarget.getBoundingClientRect();
    setPoint({
      x: Math.max(20, Math.min(bounds.width - 20, event.clientX - bounds.left + 24)),
      y: Math.max(20, Math.min(bounds.height - 20, event.clientY - bounds.top + 24)),
    });
    const active: Hold = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      started: performance.now(),
      completed: false,
    };
    hold.current = active;
    const tick = (now: number) => {
      if (hold.current !== active) return;
      const ratio = Math.min(1, (now - active.started) / HOLD_MS);
      if (progress.current) progress.current.style.strokeDashoffset = String(1 - ratio);
      if (ratio < 1) {
        frame.current = requestAnimationFrame(tick);
      } else {
        frame.current = null;
        active.completed = true;
        blockMenuUntil.current = now + 1000;
        setPoint(null);
        unlockRef.current();
      }
    };
    frame.current = requestAnimationFrame(tick);
  };

  const onContextMenuCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (!hold.current && performance.now() > blockMenuUntil.current) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return { point, progress, onPointerDownCapture, onContextMenuCapture };
}
