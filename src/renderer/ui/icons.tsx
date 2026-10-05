import React from 'react';

/** 图标一律用线条 SVG，不用字符凑（`◫ ⨯ ＋` 那种在中文界面里很难看） */
const S = ({ children }: { children: React.ReactNode }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const IconMin = () => (
  <S>
    <path d="M3.5 8h9" />
  </S>
);

export const IconMax = () => (
  <S>
    <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
  </S>
);

export const IconRestore = () => (
  <S>
    <rect x="3" y="6" width="7" height="7" rx="1.5" />
    <path d="M6 6V4.5A1.5 1.5 0 0 1 7.5 3h4A1.5 1.5 0 0 1 13 4.5v4A1.5 1.5 0 0 1 11.5 10H10" />
  </S>
);

export const IconClose = () => (
  <S>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </S>
);

/** 白天模式显示月亮（点一下入夜），夜晚模式显示太阳（点一下天亮） */
export const IconSun = () => (
  <S>
    <circle cx="8" cy="8" r="2.8" />
    <path d="M8 1.6V3M8 13v1.4M1.6 8H3M13 8h1.4M3.5 3.5l1 1M11.5 11.5l1 1M12.5 3.5l-1 1M4.5 11.5l-1 1" />
  </S>
);

export const IconMoon = () => (
  <S>
    <path d="M8 2a4 4 0 0 0 6 6 6 6 0 1 1-6-6Z" />
  </S>
);

export const IconPlus = () => (
  <S>
    <path d="M8 3.5v9M3.5 8h9" />
  </S>
);

export const IconSplit = () => (
  <S>
    <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
    <path d="M8 3.5v9" />
  </S>
);

/** 收回主窗口 */
export const IconCollect = () => (
  <S>
    <path d="M8 3v6.5M5.5 7L8 9.5 10.5 7M3.5 12.5h9" />
  </S>
);

export const IconChevron = ({ open }: { open: boolean }) => (
  <S>
    <path d={open ? 'M4 9.5L8 5.5l4 4' : 'M4 6.5l4 4 4-4'} />
  </S>
);

/** 还有更多 —— 收纳区里摆不下、收进下拉的那几个 */
export const IconMoreH = () => (
  <S>
    <circle cx="4" cy="8" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="8" r="1.1" fill="currentColor" stroke="none" />
  </S>
);

/** 空栏的图形 */
export const IconEmpty = () => (
  <S>
    <rect x="2.5" y="3.5" width="11" height="9" rx="2" />
    <path d="M2.5 8h3l1 1.5h3L10.5 8h3" />
  </S>
);

/** 布局切片：一块被切成几格的画布 */
export const IconLayout = () => (
  <S>
    <rect x="2.5" y="3.5" width="11" height="9" rx="1.8" />
    <path d="M9.5 3.5v9M2.5 8h7" />
  </S>
);

/** 发送 */
export const IconSend = () => (
  <S>
    <path d="M8 12.5V3.5M4.5 7L8 3.5 11.5 7" />
  </S>
);

/** 停止 */
export const IconStop = () => (
  <S>
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" />
  </S>
);

/** 和这个面板对话 / 关掉它的对话 */
export const IconChat = () => (
  <S>
    <path d="M3 4h10a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 13 11H7.5L4.5 13.5V11H3a1.5 1.5 0 0 1-1.5-1.5v-4A1.5 1.5 0 0 1 3 4z" />
  </S>
);

/** 复制全文 */
export const IconCopy = () => (
  <S>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
  </S>
);

/** 保存 */
export const IconSave = () => (
  <S>
    <path d="M3 4a1.5 1.5 0 0 1 1.5-1.5h5.6L13 5.4V12a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12z" />
    <path d="M5.5 2.5v3.2h4V2.5M5.5 13.5V9.8h5v3.7" />
  </S>
);

/** 设置 —— 齿轮，不是太阳 */
export const IconSettings = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="3.1" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10.6 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

/** 打开所在文件夹 */
export const IconFolderOpen = () => (
  <S>
    <path d="M2.5 12.5V4a1 1 0 0 1 1-1h3l1.5 1.5H12a1 1 0 0 1 1 1v1" />
    <path d="M2.5 12.5l1.9-5h9.1l-1.9 5z" />
  </S>
);

/** 启动 */
export const IconPlay = () => (
  <S>
    <path d="M5 3.6l7.5 4.4L5 12.4z" />
  </S>
);

/** 赞 */
export const IconThumbUp = () => (
  <S>
    <path d="M5.5 7.6l2.2-4.4a1.2 1.2 0 0 1 1.7-.5c.6.4.9 1.1.7 1.8l-.5 2h2.6a1.3 1.3 0 0 1 1.3 1.6l-.9 3.9a1.3 1.3 0 0 1-1.3 1H5.5z" />
    <path d="M5.5 7.4H3.2v6.8h2.3z" />
  </S>
);

/** 踩 */
export const IconThumbDown = () => (
  <S>
    <path d="M10.5 8.4L8.3 12.8a1.2 1.2 0 0 1-1.7.5 1.3 1.3 0 0 1-.7-1.8l.5-2H3.8a1.3 1.3 0 0 1-1.3-1.6l.9-3.9a1.3 1.3 0 0 1 1.3-1h5.8z" />
    <path d="M10.5 8.6h2.3V1.8h-2.3z" />
  </S>
);

/** 用量 */
export const IconDatabase = () => (
  <S>
    <ellipse cx="8" cy="4" rx="5" ry="2" />
    <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" />
    <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
  </S>
);

/** 用时 */
export const IconClock = () => (
  <S>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3.2l2 1.3" />
  </S>
);

/** 文件 */
export const IconCode = () => (
  <S>
    <path d="M6 4.5L3 8l3 3.5M10 4.5L13 8l-3 3.5" />
  </S>
);

/** 挂件的锁：锁住时画闭锁，解开时画开口的锁 */
export const IconLock = ({ open }: { open?: boolean }) => (
  <S>
    <rect x="3.5" y="7.2" width="9" height="5.8" rx="1.4" />
    {open ? (
      <path d="M6 7.2V5.4A2.4 2.4 0 0 1 10.6 4.4" />
    ) : (
      <path d="M6 7.2V5.2a2.8 2.8 0 0 1 5.6 0v2" />
    )}
  </S>
);

/** 分支（在新对话中分支） */
export const IconBranch = () => (
  <S>
    <circle cx="4.5" cy="11.5" r="1.5" />
    <circle cx="4.5" cy="4.5" r="1.5" />
    <circle cx="11.5" cy="6" r="1.5" />
    <path d="M4.5 6v4" />
    <path d="M4.5 9.5 C4.5 7.5 7 6 10 6" />
  </S>
);

/** 重启 */
export const IconRestart = () => (
  <S>
    <path d="M13 8a5 5 0 1 1-1.6-3.7" />
    <path d="M13.2 2.8v3.4h-3.4" />
  </S>
);

/** 停止（方形，跟上面那个圆角方块区分开） */
export const IconStopSquare = () => (
  <S>
    <rect x="4" y="4" width="8" height="8" rx="1" />
  </S>
);

/** 引用（最初截图版本：方方正正带弯钩的 66 引号） */
export const IconQuote = () => (
  <S>
    <path d="M3.5 8a2 2 0 0 1 2-2h.5V5a3 3 0 0 0-3 3v3h4V8H5.5a2 2 0 0 1-2-2zM9.5 8a2 2 0 0 1 2-2h.5V5a3 3 0 0 0-3 3v3h4V8h-1.5a2 2 0 0 1-2-2z" />
  </S>
);

/** 编辑 */
export const IconEdit = () => (
  <S>
    <path d="M11.5 2.5l2 2L5 13H3v-2L11.5 2.5z" />
  </S>
);

/** 标记（高亮） */
export const IconHighlight = () => (
  <S>
    <path d="M9.5 2.5l4 4-7.5 7.5H2v-4L9.5 2.5z" />
    <path d="M2 14h12" />
  </S>
);

/** 对勾（已复制等） */
export const IconCheck = () => (
  <S>
    <path d="M3.5 8.5l3 3 6-6" />
  </S>
);

/** 重新发送（开源通用标准：左向重试回旋箭头 Lucide rotate-ccw） */
export const IconResend = () => (
  <S>
    <path d="M2.5 7.5a5.5 5.5 0 1 1 1.6 3.9" />
    <path d="M2.5 3v4.5H7" />
  </S>
);

export const IconMic = () => (
  <S>
    <rect x="5.5" y="2" width="5" height="8" rx="2.5" />
    <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0" />
    <path d="M8 12v2.5" />
    <path d="M5.5 14.5h5" />
  </S>
);
