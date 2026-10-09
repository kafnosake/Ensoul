
/**
 * 流式输出容错闭合：补全末尾未闭合的代码块围栏，避免流式过程中代码块断层
 */
function patchStreamingMarkdown(text: string): string {
  const fences = text.match(/```/g);
  if (fences && fences.length % 2 !== 0) {
    return text + '\n```';
  }
  return text;
}

import React, { useState } from 'react';
import type { ChatStats, Panel } from '../../../shared/types';
import { renderMarkdown } from '../../ui/markdown';
import { MessageFooter } from './MessageFooter';
import { shotUrl } from './format';
import { openImage } from '../../ui/image-open';
import { panelType } from '../registry';
import { IconCheck, IconCopy, IconEdit, IconQuote, IconResend } from '../../ui/icons';
import { getToolStepMode, type ToolStepMode } from '../../ui/theme';
import { t } from '../../core/i18n';

/**
 * 提案块的认法跟主进程一致（两个以上的 < / >）—— 这里兜两头：
 * 流式过程中标记还没闭合、以及主进程没认出来而留在历史里的残留。
 * 认出来就把正文和提案切开：正文照常渲染，提案画成一张能看懂的小卡。
 */
const PROP_OPEN = /<{2,}\s*FLOAT_EDIT\s*>{2,}/;
const PROP_CLOSE = /<{2,}\s*END_FLOAT_EDIT\s*>{2,}/;

function splitProposal(content: string) {
  const mo = PROP_OPEN.exec(content);
  if (!mo) return null;
  const rest = content.slice(mo.index + mo[0].length);
  const mc = PROP_CLOSE.exec(rest);
  const raw = (mc ? rest.slice(0, mc.index) : rest).trim();
  const tail = mc ? rest.slice(mc.index + mc[0].length) : '';
  const jsonText = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let proposal: any = null;
  try {
    proposal = JSON.parse(jsonText);
  } catch {
    // 流式还没写完、或者 JSON 坏了 —— 下面按"没解析出来"画，不猜
  }
  return { body: (content.slice(0, mo.index) + tail).trim(), raw, proposal };
}

/** 一条消息：用户靠右，助手靠左，都带角色和时间 —— 主流编辑器都长这样 */
// 用 memo 包住：流式输出时父组件每帧重渲染，历史消息不能跟着每帧重新解析一遍 markdown。
export const Message = React.memo(function Message({
  panel,
  id,
  role,
  content,
  edited,
  at,
  streaming,
  stepMode,
  stats,
  images,
  steer,
  onQuoteImage,
  onEditUserMsg,
  onResendUserMsg,
}: {
  panel: Panel;
  id: string;
  role: string;
  content: string;
  edited?: boolean;
  at: number;
  streaming?: boolean;
  stepMode?: ToolStepMode;
  stats?: ChatStats;
  /** 这条消息带的图（磁盘路径） */
  images?: string[];
  /** 这是用户跑到一半插进去的话（不是开场那一轮） */
  steer?: boolean;
  /** 引用这张图 */
  onQuoteImage?: (imgUrl: string) => void;
  /** 编辑用户消息 */
  onEditUserMsg?: (msgId: string, newContent: string) => void;
  /** 重新发送用户消息 */
  onResendUserMsg?: (content: string, images?: string[]) => void;
}) {
  const mine = role === 'user';
  const isTool = role === 'tool';
  const time = new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  // 正文里如果混着 <<<FLOAT_EDIT>>> 提案块：切开，标记原文永远不直接示人
  const prop = content.includes('FLOAT_EDIT') ? splitProposal(content) : null;
  const body = prop ? prop.body : content;
  const markdown = React.useMemo(() => renderMarkdown(streaming ? patchStreamingMarkdown(body) : body), [body, streaming]);

  // 用户消息的编辑态与复制态
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(body);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard?.writeText(body);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const handleSaveEdit = () => {
    const trimmed = editText.trim();
    if (!trimmed) return;
    onEditUserMsg?.(id, trimmed);
    setEditing(false);
  };

  const handleSaveAndResend = () => {
    const trimmed = editText.trim();
    if (!trimmed) return;
    onEditUserMsg?.(id, trimmed);
    setEditing(false);
    onResendUserMsg?.(trimmed, images);
  };

  /**
   * 图怎么摆：**用户自己发的在上面，助手发的在下面**。
   * 点开看大图，悬停时支持快捷引用
   */
  const shotsEl = images && images.length > 0 && (
    <div className={`msg-shots${mine ? '' : ' is-big'}`}>
      {images.map((s, i) => (
        <div className="msg-shot-wrap" key={i}>
          <img src={shotUrl(s)} alt="" title={t('点开看大图')} onClick={() => openImage(s, panel.id)} />
          {onQuoteImage && (
            <button
              className="msg-shot-quote-btn"
              title={t('引用这张图片')}
              onClick={(e) => {
                e.stopPropagation();
                onQuoteImage(s);
              }}
            >
              <IconQuote />
            </button>
          )}
        </div>
      ))}
    </div>
  );

  // 动作只占一行：摘要在这儿，输出点开才看 —— 不然一条动作就吃掉半屏。
  // 但**失败的那几步默认摊开**：构建没过、命令报错正是最需要被看见的东西，
  // 成功的读文件没人会去点开。
  if (isTool) {
    const [headRaw, ...rest] = content.split('\n');
    const out = rest
      .join('\n')
      .replace(/^\s*```[a-z]*\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    // 只认工具自己报的失败标记。不要拿 /Error|错误/ 去扫整段输出 ——
    // 读源码时正文里本来就有 "Error"，那会把一大堆正常的读取也摊开，又变成噪音。
    const bad = /工具执行失败|没有这个工具|没能启动|没停下来|构建没过|构建起不来|没有执行|（退出码 [1-9]|^Error|^SyntaxError|not recognized|No such file/m.test(out);

    // 规整工具头为现代 CLI / DevTools 国际化风格，兼容历史旧格式与 markdown 标记
    let head = headRaw.replace(/\*\*/g, '').trim();
    head = head.replace(/^斜杠命令\s*\//, '/');
    head = head.replace(/^跑命令[：:]\s*/, 'run ');
    head = head.replace(/^搜\s+/, 'search ');
    head = head.replace(/^读\s+/, 'read ');
    head = head.replace(/^写\s+/, 'write ');
    head = head.replace(/^改\s+/, 'edit ');
    head = head.replace(/^看目录\s+/, 'list ');
    head = head.replace(/^正则检索\s+/, 'grep ');
    head = head.replace(/^文件匹配\s+/, 'glob ');
    head = head.replace(/^查看图片\s+/, 'view ');
    head = head.replace(/^构建项目\b/, 'build');
    head = head.replace(/^启动项目\b/, 'start');
    head = head.replace(/^停止项目\b/, 'stop');
    head = head.replace(/^构建并重启项目\b/, 'restart');
    head = head.replace(/^看项目状态\b/, 'status');
    head = head.replace(/^读项目日志\b/, 'logs');

    // 拆分出指令动词与目标参数：斜杠命令保留 cmd 徽标，工具调用直接以动词为主体（如 run / search / read），更清爽自然
    const isSlash = head.startsWith('/');
    let verb = '';
    let target = '';
    if (isSlash) {
      const m = head.match(/^(\/[\w\u4e00-\u9fa5-]+)(?:\s+(.*))?$/);
      verb = m ? m[1] : head;
      target = m && m[2] ? m[2] : '';
    } else {
      const sp = head.indexOf(' ');
      if (sp > 0) {
        verb = head.slice(0, sp);
        target = head.slice(sp + 1);
      } else {
        verb = head;
      }
    }

    const activeMode = stepMode ?? getToolStepMode();
    const isCompact = activeMode === 'compact';
    const isDetailed = activeMode === 'detailed';
    const isExpanded = activeMode === 'expanded';

    // 变更/运行类操作（写、改、运行、启停等）
    const isMutatingOrRun = /^(run|edit|write|build|start|restart|stop|delete|rm|mkdir|install|exec|bash|cmd)/i.test(verb);

    // 梯度展开策略：
    // - expanded: 全部展开
    // - detailed: 变更/运行类及出错操作自动展开，只读类操作折叠
    // - standard: 仅出错操作自动展开
    // - compact: 全折叠，保持 Codex 式极简单行（即使失败也保持紧凑单行，标红点提示，点击展开）
    const isOpen =
      isExpanded
        ? true
        : isDetailed
        ? (bad || isMutatingOrRun)
        : isCompact
        ? false
        : bad;

    const outLines = out ? out.split('\n').length : 0;
    const rowClass = [
      'tool-row',
      `mode-${activeMode}`,
      isCompact && 'is-compact',
      isDetailed && 'is-detailed',
      bad && 'is-bad',
    ].filter(Boolean).join(' ');

    return (
      <details className={rowClass} open={isOpen}>
        <summary>
          {isCompact ? (
            <span className="tool-dot" title={bad ? t('执行异常 (点击展开)') : t('点击展开输出')} />
          ) : (
            <span className="tool-arrow" />
          )}
          <span className="tool-head">
            <span className={`tool-verb${isSlash ? ' is-cmd' : ''}`}>{verb}</span>
            {target && <span className="tool-target" title={target}>{target}</span>}
          </span>
          {isDetailed && (
            <span className="tool-badge">
              {bad ? t('异常') : isMutatingOrRun ? t('已执行') : `${outLines}L`}
            </span>
          )}
          <span className="tool-time">{time}</span>
        </summary>
        <pre className="tool-out">{out || t('（没有输出）')}</pre>
      </details>
    );
  }

  return (
    <div
      className={`msg msg-${mine ? 'user' : 'assistant'}${streaming ? ' is-streaming' : ''}`}
      data-msg-id={id}
    >
      <div className="msg-main">
        {!mine && (
          <div className="msg-meta">
            <span>{t('助手')}</span>
            {edited && <span className="msg-tag">{t('已改写面板')}</span>}
            <span className="msg-time">{time}</span>
          </div>
        )}
        {mine && (steer || edited) && (
          <div className="msg-meta">
            {steer && <span className="msg-tag">{t('插话')}</span>}
            {edited && <span className="msg-tag">{t('已改写面板')}</span>}
          </div>
        )}
        <div className="msg-body">
          {mine && shotsEl}
          {editing ? (
            <div className="msg-user-edit">
              <textarea
                className="msg-user-edit-input"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setEditing(false);
                  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    handleSaveEdit();
                  }
                }}
                rows={Math.max(2, Math.min(10, editText.split('\n').length))}
                autoFocus
              />
              <div className="msg-user-edit-actions">
                <button className="mue-btn cancel" onClick={() => setEditing(false)} title={t('取消修改 (Esc)')}>
                  {t('取消')}
                </button>
                <button className="mue-btn save" onClick={handleSaveEdit} title={t('保存修改 (Ctrl+Enter)')}>
                  {t('保存')}
                </button>
                {onResendUserMsg && (
                  <button className="mue-btn resend" onClick={handleSaveAndResend} title={t('保存并重新发送此消息')}>
                    {t('重发')}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              {markdown}
              {prop && <PropCard prop={prop} streaming={streaming} />}
            </>
          )}
          {!mine && shotsEl}
        </div>

        {/* 用户消息气泡下方：时间戳 + 极简轻量图标（复制、编辑、重新发送） */}
        {mine && !editing && (
          <div className="msg-foot-user">
            <span className="msg-time">{time}</span>
            <div className="msg-user-actions">
              <button
                className={`msg-act-icon${copied ? ' is-copied' : ''}`}
                title={t('复制')}
                onClick={handleCopy}
              >
                {copied ? <IconCheck /> : <IconCopy />}
              </button>
              {onEditUserMsg && (
                <button
                  className="msg-act-icon"
                  title={t('编辑')}
                  onClick={() => {
                    setEditText(body);
                    setEditing(true);
                  }}
                >
                  <IconEdit />
                </button>
              )}
              {onResendUserMsg && (
                <button
                  className="msg-act-icon"
                  title={t('重新发送')}
                  onClick={() => onResendUserMsg(body, images)}
                >
                  <IconResend />
                </button>
              )}
            </div>
          </div>
        )}

        {!mine && stats && !streaming && <MessageFooter panel={panel} id={id} stats={stats} content={content} />}
      </div>
    </div>
  );
});

/** 提案卡：把标记翻译成人话 —— 改了什么、为什么改，原文折起来想看再看 */
function PropCard({ prop, streaming }: { prop: NonNullable<ReturnType<typeof splitProposal>>; streaming?: boolean }) {
  const p = prop.proposal;
  const lines: string[] = [];
  if (p) {
    if (typeof p.title === 'string' && p.title) lines.push(`标题 → ${p.title}`);
    if (typeof p.kind === 'string' && p.kind) lines.push(`类型 → ${panelType(p.kind)?.label || p.kind}`);
    if (p.look) lines.push(t('外观（配色 / 密度）有改动'));
    if (p.spec) lines.push(t('面板内容有改动'));
  }
  return (
    <div className="prop-card">
      <div className="prop-title">
        <span>{t('面板改写提案')}</span>
        {streaming && <span className="prop-state">{t('正在提交…')}</span>}
      </div>
      {lines.map((l, i) => (
        <div className="prop-line" key={i}>
          {l}
        </div>
      ))}
      {!lines.length && !p && (
        <div className="prop-line">{streaming ? t('提案还没写完…') : t('这段提案没能解析出来')}</div>
      )}
      {typeof p?.rationale === 'string' && p.rationale && <div className="prop-why">{p.rationale}</div>}
      {prop.raw && !streaming && (
        <details className="prop-more">
          <summary>{t('提案原文')}</summary>
          <pre>{prop.raw}</pre>
        </details>
      )}
    </div>
  );
}
