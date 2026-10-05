import React, { useState } from 'react';
import { IconCheck, IconCopy, IconHighlight, IconQuote } from '../../ui/icons';
import { t } from '../../core/i18n';

export interface SelectionPos {
  x: number;
  y: number;
  selectedText: string;
  msgId?: string;
  /** 选区起点在该条消息 .msg-body 文本里的绝对偏移 / 长度 —— 只用于本地标记落库 */
  start?: number;
  len?: number;
  /** 选区与已有高亮相交 → 浮窗按钮显示「取消标记」 */
  isMarked?: boolean;
  /** 与选区相交的已有高亮 id（取消标记用） */
  hlIds?: string[];
}

export function SelectionToolbar({
  pos,
  onQuote,
  onCopy,
  onHighlight,
  onClose,
}: {
  pos: SelectionPos;
  onQuote: (text: string) => void;
  onCopy: (text: string) => void;
  onHighlight: (pos: SelectionPos) => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  // 坐标边界防溢出
  const toolbarWidth = pos.isMarked ? 210 : 190;
  const toolbarHeight = 36;
  const clampedX = Math.max(8, Math.min(pos.x, window.innerWidth - toolbarWidth - 12));
  let clampedY = pos.y + 4;
  if (clampedY + toolbarHeight > window.innerHeight - 10) {
    clampedY = Math.max(8, pos.y - toolbarHeight - 16);
  }

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    onCopy(pos.selectedText);
    setCopied(true);
    setTimeout(() => {
      onClose();
    }, 600);
  };

  const handleQuote = (e: React.MouseEvent) => {
    e.stopPropagation();
    onQuote(pos.selectedText);
    onClose();
  };

  const handleHighlight = (e: React.MouseEvent) => {
    e.stopPropagation();
    onHighlight(pos);
    onClose();
  };

  return (
    <div
      className="selection-toolbar"
      style={{ left: clampedX, top: clampedY }}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <button className="st-btn" onClick={handleQuote} title={t('引用选中文字到输入框')}>
        <IconQuote />
        <span>{t('引用')}</span>
      </button>
      <button className={`st-btn${copied ? ' is-copied' : ''}`} onClick={handleCopy} title={t('复制选中文本')}>
        {copied ? <IconCheck /> : <IconCopy />}
        <span>{copied ? t('已复制') : t('复制')}</span>
      </button>
      <button className="st-btn" onClick={handleHighlight} title={pos.isMarked ? t('取消标记') : t('标记高亮')}>
        <IconHighlight />
        <span>{pos.isMarked ? t('取消标记') : t('标记')}</span>
      </button>
    </div>
  );
}
