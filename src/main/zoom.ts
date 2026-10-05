import { BrowserWindow, app } from 'electron';
import { userDataPath } from './paths';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 界面缩放 —— **一个乘区，主进程说了算**。
 *
 * 用 Electron 原生的 setZoomFactor，而不是在渲染层改 CSS：乘区记在 webContents
 * 自己身上，主进程随手读得到（getZoomFactor），跨窗口拖拽那些"屏幕坐标 ↔ 页面坐标"
 * 的换算才有唯一真源可依。CSS 那一套主进程看不见，一遇到落点判定就会两边分家。
 *
 * 每个窗口一份，所以新建窗口必须自己带上（见 windows.ts 的 load 之后）。
 */

const MIN = 0.75;
const MAX = 2;
const FILE = () => userDataPath('zoom.json');

let factor = 1;

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.round(Math.min(MAX, Math.max(MIN, n)) * 100) / 100;
}

/** 开机读一次；文件不在（头一回）就当 100% */
export function loadZoom(): number {
  try {
    factor = clamp(Number(JSON.parse(fs.readFileSync(FILE(), 'utf8'))?.factor ?? 1));
  } catch {
    factor = 1;
  }
  return factor;
}

export function getZoom(): number {
  return factor;
}

/** 把一个窗口的乘区套成当前值 */
export function applyTo(win: BrowserWindow | null | undefined): void {
  if (!win || win.isDestroyed()) return;
  try {
    const query = new URL(win.webContents.getURL() || 'about:blank').searchParams;
    const desktop = query.get('mode') === 'widget' && query.get('edit') !== '1';
    win.webContents.setZoomFactor(desktop ? 1 : factor);
  } catch {
    /* 窗口正处在销毁/重载的空档：下一轮 applyAll 会补上 */
  }
}

export function applyAll(): void {
  for (const win of BrowserWindow.getAllWindows()) applyTo(win);
}

export function setZoom(next: number): number {
  factor = clamp(next);
  applyAll();
  try {
    fs.writeFileSync(FILE(), JSON.stringify({ factor }));
  } catch {
    /* 写不下去就只活这一次运行，不影响界面 */
  }
  return factor;
}

export { MIN as ZOOM_MIN, MAX as ZOOM_MAX };
