import React, { useEffect, useRef, useState } from 'react';
import type { Panel } from '../../shared/types';
import { api } from '../core/api';
import { IconCopy, IconSave } from '../ui/icons';
import { renderMarkdown } from '../ui/markdown';
import { t } from '../core/i18n';

/** 文本面板的主体：能写、能读、能存回磁盘。markdown 文件默认看排版好的样子 */
export function EditorBody({ panel, setText }: { panel: Panel; setText(text: string): void }) {
  const name = panel.file ?? panel.title;
  const [mode, setMode] = useState<'preview' | 'source'>('source');
  const [saved, setSaved] = useState(panel.spec.text);
  /** 文本框里真正显示的内容 —— 以本地这一份为准，理由见下面那段 effect */
  const [text, setLocal] = useState(panel.spec.text);
  /** 刚发出去、还没回来的那几份内容：用来认出"这是我的回声" */
  const sent = useRef<string[]>([]);

  // 面板是复用的：打开的文件一变，就按文件类型重挑一次视图，并把"已保存"对齐
  useEffect(() => {
    const md = /\.(md|markdown|mdx)$/i.test(panel.file ?? '');
    setMode(md && panel.spec.text ? 'preview' : 'source');
    setSaved(panel.spec.text);
  }, [panel.file]);

  /**
   * 面板状态是**异步回来的**：敲一下 → IPC → 主进程改 → 广播回来，中间还夹着一次整份写盘。
   * 打字快过这个来回时，回来的旧内容会盖到 DOM 上 —— 光标跳到最后，刚敲的字也没了。
   * 所以这里以本地这一份为准：回来的要是我们刚发出去的那几份之一，就当回声丢掉；
   * 只有**不是**自己敲的（打开别的文件、对话改写面板、恢复）才换进来。
   */
  useEffect(() => {
    const next = panel.spec.text ?? '';
    const i = sent.current.lastIndexOf(next);
    if (i >= 0) {
      // 自己的旧回声，扔掉；比它晚发出去的还留着
      sent.current = sent.current.slice(i + 1);
      return;
    }
    sent.current = [];
    setLocal(next);

    /**
     * 换工作区 / 重启恢复根之后，主进程会把冻住的"读取失败"换成真读到的内容。
     * 那时"已保存"还停在旧错误上，不跟着走就会凭空冒出一个"未保存"的点，
     * 甚至让人存不进去 —— 所以这个时刻单独对齐一次。
     */
    if ((saved ?? '').startsWith(t('读取失败：')) && !next.startsWith(t('读取失败：'))) setSaved(next);
  }, [panel.spec.text, panel.file]);

  /** 敲字：本地立刻生效，同时把这一份发给面板状态 */
  const onInput = (v: string) => {
    setLocal(v);
    sent.current.push(v);
    if (sent.current.length > 64) sent.current.shift();
    setText(v);
  };

  const dirty = Boolean(panel.file) && text !== saved;

  const save = async () => {
    if (!panel.file) return;
    const r = await api.fs.write(panel.file, text);
    if (r.ok) setSaved(text);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (panel.file && text !== saved) void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel.file, text, saved]);

  const copy = () => void navigator.clipboard?.writeText(text ?? '');

  return (
    <div className="editor-body">
      <div className="editor-bar">
        <span className="editor-path" title={panel.file ?? ''}>
          {panel.file ?? t('未命名')}
        </span>
        {dirty && (
          <span className="editor-dirty" title={t('未保存')}>
            ●
          </span>
        )}
        <div className="editor-tools">
          <button className={mode === 'preview' ? 'is-on' : ''} onClick={() => setMode('preview')}>
            {t('预览')}
          </button>
          <button className={mode === 'source' ? 'is-on' : ''} onClick={() => setMode('source')}>
            {t('源码')}
          </button>
          {panel.file && (
            <button className={dirty ? 'is-dirty' : ''} onClick={() => void save()} title={t('保存（Ctrl+S）')}>
              <IconSave />
            </button>
          )}
          <button onClick={copy} title={t('复制全文')}>
            <IconCopy />
          </button>
        </div>
      </div>

      {mode === 'preview' ? (
        <div className="md-view">
          {text ? renderMarkdown(text) : <span className="muted">{t('（空）')}</span>}
        </div>
      ) : (
        <textarea
          className="body-code"
          value={text}
          spellCheck={false}
          onChange={(e) => onInput(e.target.value)}
          placeholder={t('在这里写点什么；左边点一个文件会把内容读进来，Ctrl+S 存回磁盘。')}
        />
      )}
    </div>
  );
}
