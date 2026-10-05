/** 模式、主题色卡与背景不透明度共用一份存储；默认色卡回落到原有 CSS。 */

const K_THEME = 'ensoul.theme';
const K_THEME_COLOR = 'ensoul.theme.color';
const K_SURFACE_ALPHA = 'ensoul.surface.alpha';
const K_MOTION = 'ensoul.fx.motion';
const K_GLASS = 'ensoul.fx.glass';
const K_FONT_UI = 'ensoul.font.ui';
const K_FONT_CODE = 'ensoul.font.code';
const K_TOOL_STEP = 'ensoul.tool.step';
const K_CODE_WORK_VIEW = 'ensoul.code.workview';

const EVT = 'ensoul:appearance';

export type Theme = 'dark' | 'light';
export type FxMode = 'system' | 'on' | 'off';
export type ToolStepMode = 'compact' | 'standard' | 'detailed' | 'expanded';

export const THEME_COLORS = [
  { key: 'auto', name: '默认', hex: '' },
  { key: 'blue', name: '蓝', hex: '#5b8cff' },
  { key: 'indigo', name: '靛', hex: '#6d7cff' },
  { key: 'violet', name: '紫', hex: '#a78bfa' },
  { key: 'pink', name: '品红', hex: '#e061a8' },
  { key: 'red', name: '朱红', hex: '#e5645f' },
  { key: 'amber', name: '琥珀', hex: '#d99a3c' },
  { key: 'green', name: '绿', hex: '#3ecf8e' },
  { key: 'teal', name: '青', hex: '#2fbfb5' },
] as const;

export type ThemeColor = typeof THEME_COLORS[number]['key'];

/** 字体预设：给的都是本机常见的那几支，没装就自动落到栈里的下一档 */
export const FONTS_UI: { key: string; name: string; stack: string }[] = [
  { key: 'system', name: '系统默认', stack: '"Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif' },
  { key: 'yahei', name: '微软雅黑', stack: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif' },
  { key: 'source', name: '思源 / 苹方', stack: '"Source Han Sans SC", "Noto Sans SC", "PingFang SC", sans-serif' },
  { key: 'serif', name: '衬线', stack: 'Georgia, "Songti SC", SimSun, serif' },
];

export const FONTS_CODE: { key: string; name: string; stack: string }[] = [
  { key: 'system', name: '系统等宽', stack: 'ui-monospace, "Cascadia Mono", Consolas, monospace' },
  { key: 'cascadia', name: 'Cascadia Mono', stack: '"Cascadia Mono", Consolas, monospace' },
  { key: 'consolas', name: 'Consolas', stack: 'Consolas, "Courier New", monospace' },
  { key: 'jetbrains', name: 'JetBrains Mono', stack: '"JetBrains Mono", Consolas, monospace' },
  { key: 'fira', name: 'Fira Code', stack: '"Fira Code", Consolas, monospace' },
];

/** 缩放档位：75 起、每 25 一档、到 200 收住（和主进程 zoom.ts 的上下界一起改） */
export const ZOOM_STEPS = [75, 100, 125, 150, 175, 200];

/* ── 主题 ─────────────────────────────────────────────────────────────── */

/** 系统此刻是浅还是深（只在老存档的 'system' 折现时用得上） */
export function systemTheme(): 'dark' | 'light' {
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function getThemeMode(): Theme {
  const v = localStorage.getItem(K_THEME);
  if (v === 'light' || v === 'dark') return v;
  // 老版本存过 'system'：折成系统此刻那个值，顺手落盘，免得每回都得再算一遍
  const folded = v === 'system' ? systemTheme() : 'dark';
  localStorage.setItem(K_THEME, folded);
  return folded;
}

/** 真正贴到 html 上的那个值 */
export function resolvedTheme(): 'dark' | 'light' {
  return getThemeMode();
}

export function applyTheme(): void {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme();
  root.dataset.themeMode = getThemeMode();
  applySurfaces();
  applyAccent();
}

export function setTheme(t: Theme): void {
  localStorage.setItem(K_THEME, t);
  applyTheme();
  notify();
}

/* ── 主题色卡 ─────────────────────────────────────────────────────────── */

export function getThemeColor(): ThemeColor {
  let stored = localStorage.getItem(K_THEME_COLOR);
  if (stored === null) {
    const legacy = localStorage.getItem('ensoul.accent')?.toLowerCase();
    stored = THEME_COLORS.find((color) => color.hex && color.hex === legacy)?.key ?? 'auto';
    localStorage.setItem(K_THEME_COLOR, stored);
    for (const key of ['ensoul.accent', 'ensoul.accent.alpha', 'ensoul.background.dark', 'ensoul.background.light']) {
      localStorage.removeItem(key);
    }
  }
  return THEME_COLORS.find((color) => color.key === stored)?.key ?? 'auto';
}

export function setThemeColor(color: ThemeColor): void {
  localStorage.setItem(K_THEME_COLOR, color);
  applyTheme();
  notify();
}

function themeRgb(): [number, number, number] | null {
  return hex2rgb(THEME_COLORS.find((color) => color.key === getThemeColor())!.hex);
}

function hex2rgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const toHex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** 朝白（t>0）或朝黑（t<0）混一把：派生 hover 色与文字色，不用再手点一堆色号 */
function mixRgb(rgb: [number, number, number], t: number): [number, number, number] {
  const to = t >= 0 ? 255 : 0;
  const k = Math.abs(t);
  return rgb.map((c) => Math.max(0, Math.min(255, Math.round(c + (to - c) * k)))) as [number, number, number];
}

const mix = (rgb: [number, number, number], t: number) => '#' + mixRgb(rgb, t).map(toHex).join('');

const rgba = (rgb: [number, number, number], a: number) => `rgba(${rgb.join(', ')}, ${a})`;

const DEFAULT_BACKGROUND = { dark: '#0b0d10', light: '#eef1f5' };

export function getSurfaceOpacity(): number {
  const raw = localStorage.getItem(K_SURFACE_ALPHA);
  if (raw === null) return 1;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(1, Math.max(0.6, value / 1000)) : 1;
}

function luminance(rgb: [number, number, number]): number {
  const linear = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

const SURFACE_VARS = [
  '--window-base', '--bg', '--bg-soft', '--panel', '--panel-2', '--card', '--card-2',
  '--pop', '--pop-a', '--pop-b', '--pop-dim', '--grad-bar', '--grad-dock',
  '--text', '--text-2', '--dim', '--faint', '--line', '--line-soft', '--line-hi',
  '--code-bg', '--code-fg',
  '--focus-line', '--scroll', '--scroll-hi', '--user-a', '--user-b', '--user-line',
];

function applySurfaces(): void {
  const root = document.documentElement;
  const color = themeRgb();
  const alpha = getSurfaceOpacity();
  if (!color && alpha === 1) {
    for (const key of SURFACE_VARS) root.style.removeProperty(key);
    return;
  }
  const dark = resolvedTheme() === 'dark';
  const neutral = (hex: string) => hex2rgb(hex)!;
  const tint = (hex: string, weight: number) => {
    const base = neutral(hex);
    return color ? base.map((c, i) => Math.round(c * (1 - weight) + color[i] * weight)) : base;
  };
  const rgb = tint(DEFAULT_BACKGROUND[resolvedTheme()], dark ? 0.24 : 0.22);
  const palette = dark
    ? { soft: '#101317', panel: '#14181d', panel2: '#171c22', card: '#1c222a', hover: '#232a33', pop: '#171c22', code: '#0a0c0f' }
    : { soft: '#e7ebf0', panel: '#ffffff', panel2: '#f8fafc', card: '#f4f7fa', hover: '#e9edf3', pop: '#fcfdff', code: '#f3f5f8' };
  // 嵌套表面先对窗口底色合成一次，避免每套一层 DOM 就再染一次色。
  const flat = (hex: string, a = alpha) => {
    const surface = tint(hex, dark ? 0.12 : 0.075);
    const blended = surface.map((c, i) => Math.round(c * a + rgb[i] * (1 - a)));
    return `rgb(${blended.join(', ')})`;
  };
  const put = (key: string, value: string) => root.style.setProperty(key, value);
  const base = '#' + rgb.map(toHex).join('');
  put('--window-base', base);
  put('--bg', base);
  put('--bg-soft', flat(palette.soft));
  put('--panel', flat(palette.panel));
  put('--panel-2', flat(palette.panel2));
  put('--card', flat(palette.card));
  put('--card-2', flat(palette.hover));
  put('--pop', flat(palette.pop, Math.max(0.96, alpha)));
  put('--pop-a', flat(palette.pop, Math.max(0.98, alpha)));
  put('--pop-b', flat(palette.pop, Math.max(0.94, alpha)));
  put('--pop-dim', flat(palette.soft, Math.max(0.96, alpha)));
  put('--grad-bar', flat(palette.panel2));
  put('--grad-dock', flat(palette.panel2));
  put('--text', dark ? '#f0f3f7' : '#151a22');
  put('--text-2', dark ? '#d8dfe8' : '#313b49');
  put('--dim', dark ? '#b7c1cf' : '#424d5c');
  put('--faint', dark ? '#9aa7b8' : '#536071');
  const edge: [number, number, number] = dark ? [255, 255, 255] : [0, 0, 0];
  put('--line', rgba(edge, 0.16));
  put('--line-soft', rgba(edge, 0.09));
  put('--line-hi', rgba(edge, 0.25));
  put('--code-bg', flat(palette.code));
  put('--code-fg', dark ? '#d8dfe8' : '#252e3a');
  put('--focus-line', flat(dark ? '#3a4a6b' : '#95b0f0'));
  put('--scroll', flat(dark ? '#2c333d' : '#ccd2da'));
  put('--scroll-hi', flat(dark ? '#3d4653' : '#adb5bf'));
  put('--user-a', flat(palette.hover));
  put('--user-b', flat(palette.card));
  put('--user-line', rgba(color ?? neutral(dark ? '#5b8cff' : '#3a6fe8'), dark ? 0.3 : 0.25));
}

export function setSurfaceOpacity(value: number): void {
  if (!Number.isFinite(value)) return;
  const alpha = Math.min(1, Math.max(0.6, value));
  if (alpha === 1) localStorage.removeItem(K_SURFACE_ALPHA);
  else localStorage.setItem(K_SURFACE_ALPHA, String(Math.round(alpha * 1000)));
  applySurfaces();
  applyAccent();
  notify();
}

const ACCENT_VARS = ['--accent', '--accent-rgb', '--accent-hi', '--accent-fg', '--accent-soft', '--accent-on'];

export function applyAccent(): void {
  const root = document.documentElement;
  const dark = resolvedTheme() === 'dark';
  const rgb = themeRgb();
  if (!rgb) {
    for (const k of ACCENT_VARS) root.style.removeProperty(k);
    return;
  }
  const [r, g, b] = rgb;
  root.style.setProperty('--accent', '#' + rgb.map(toHex).join(''));
  root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
  const brightness = luminance(rgb);
  const whiteContrast = 1.05 / (brightness + 0.05);
  const darkContrast = (brightness + 0.05) / (luminance([17, 24, 39]) + 0.05);
  root.style.setProperty('--accent-on', darkContrast > whiteContrast ? '#111827' : '#ffffff');
  root.style.setProperty('--accent-hi', mix(rgb, dark ? 0.16 : 0.1));
  root.style.setProperty('--accent-fg', mix(rgb, dark ? 0.45 : -0.4));
  root.style.setProperty('--accent-soft', rgba(rgb, dark ? 0.14 : 0.13));
}

/* ── 效果开关 ─────────────────────────────────────────────────────────── */

function readFx(key: string): FxMode {
  const v = localStorage.getItem(key);
  return v === 'on' || v === 'off' ? v : 'system';
}

function writeFx(key: string, v: FxMode): void {
  if (v === 'system') localStorage.removeItem(key);
  else localStorage.setItem(key, v);
  applyFx();
  notify();
}

export const getMotion = () => readFx(K_MOTION);
export const setMotion = (v: FxMode) => writeFx(K_MOTION, v);
/** 毛玻璃没有"跟随系统"这一档 —— 开或关 */
export const getGlass = () => localStorage.getItem(K_GLASS) !== 'off';
export const setGlass = (on: boolean) => writeFx(K_GLASS, on ? 'on' : 'off');

export function applyFx(): void {
  const root = document.documentElement;
  const motion = getMotion();
  root.dataset.fxMotion =
    motion === 'system' ? (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'off' : 'on') : motion;
  root.dataset.fxGlass = getGlass() ? 'on' : 'off';
}

/* ── 字体 ─────────────────────────────────────────────────────────────── */

const pick = (list: { key: string; stack: string }[], key: string | null, fallback: string) =>
  list.find((f) => f.key === key)?.stack ?? fallback;

export const getFontUi = () => localStorage.getItem(K_FONT_UI) ?? 'system';
export const getFontCode = () => localStorage.getItem(K_FONT_CODE) ?? 'system';

export function setFontUi(key: string): void {
  localStorage.setItem(K_FONT_UI, key);
  applyFonts();
  notify();
}

export function setFontCode(key: string): void {
  localStorage.setItem(K_FONT_CODE, key);
  applyFonts();
  notify();
}

export function applyFonts(): void {
  const root = document.documentElement;
  root.style.setProperty('--font-ui', pick(FONTS_UI, getFontUi(), FONTS_UI[0].stack));
  root.style.setProperty('--font-code', pick(FONTS_CODE, getFontCode(), FONTS_CODE[0].stack));
}

/* ── 通知 ─────────────────────────────────────────────────────────────── */

/* ── 对话与工具偏好 ─────────────────────────────────────────────────── */

export function getToolStepMode(): ToolStepMode {
  const v = localStorage.getItem(K_TOOL_STEP);
  if (v === 'compact' || v === 'detailed' || v === 'expanded') return v;
  return 'standard';
}

export function setToolStepMode(mode: ToolStepMode): void {
  localStorage.setItem(K_TOOL_STEP, mode);
  notify();
}

export function getCodeWorkView(): boolean {
  return localStorage.getItem(K_CODE_WORK_VIEW) === 'true';
}

export function setCodeWorkView(enabled: boolean): void {
  localStorage.setItem(K_CODE_WORK_VIEW, enabled ? 'true' : 'false');
  notify();
}

function notify(): void {
  window.dispatchEvent(new Event(EVT));
}

/** 外观变了（本窗口改的、别的窗口改的、系统变了的都算）→ 拿它刷新界面上那些显示项 */
export function onAppearance(cb: () => void): () => void {
  window.addEventListener(EVT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(EVT, cb);
    window.removeEventListener('storage', cb);
  };
}

/* ── 入口 ─────────────────────────────────────────────────────────────── */

/** 入口调一次：把存着的几样套上，并跟着系统与别的窗口的改动走 */
export function initTheme(): void {
  applyTheme();
  applyFx();
  applyFonts();

  // 主题不再跟系统走（浅 / 深由用户自己定）；系统那个开关只剩"减少动效"这一档要跟
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
    if (getMotion() === 'system') applyFx();
  });

  // 别的窗口改了外观 → storage 事件只在别的窗口发，正好补上缺的那一半
  window.addEventListener('storage', () => {
    applyTheme();
    applyFx();
    applyFonts();
  });
}
