import React from 'react';
import type { ChatMessage, Panel } from '../../../shared/types';
import type { ToolStepMode } from '../../ui/theme';
import { Message } from './Message';
import { t } from '../../core/i18n';

export function parseToolInfo(content: string) {
  const [headRaw, ...rest] = content.split('\n');
  const out = rest
    .join('\n')
    .replace(/^\s*```[a-z]*\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const bad = /工具执行失败|没有这个工具|没能启动|没停下来|构建没过|构建起不来|没有执行|（退出码 [1-9]|^Error|^SyntaxError|not recognized|No such file/m.test(out);

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

  let verb = head.split(' ')[0] || head;
  if (verb.startsWith('/')) verb = verb.slice(1);
  return { verb, bad, out };
}

export interface ToolGroupProps {
  tools: ChatMessage[];
  panel: Panel;
  stepMode: ToolStepMode;
  onQuoteImage?: (imgUrl: string) => void;
  onEditUserMsg?: (msgId: string, newText: string) => void;
  /** 重新发送：与 Message 保持一致 —— 传的是正文（可带图），不是消息 id */
  onResendUserMsg?: (content: string, images?: string[]) => void;
}

export const ToolGroup = React.memo(function ToolGroup({
  tools,
  panel,
  stepMode,
  onQuoteImage,
  onEditUserMsg,
  onResendUserMsg,
}: ToolGroupProps) {
  if (tools.length === 0) return null;

  const count = tools.length;
  let badCount = 0;
  const verbList: string[] = [];

  for (const m of tools) {
    const info = parseToolInfo(m.content || '');
    if (info.bad) badCount++;
    if (info.verb && !verbList.includes(info.verb)) {
      verbList.push(info.verb);
    }
  }

  const lastAt = tools[tools.length - 1].createdAt;
  const time = new Date(lastAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const verbsSummary = verbList.slice(0, 4).join(', ') + (verbList.length > 4 ? '…' : '');

  const [open, setOpen] = React.useState(false);

  return (
    <details
      className={`tool-group-card${badCount > 0 ? ' has-bad' : ''}`}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="tool-group-summary">
        <span className="tool-group-arrow">▸</span>
        <span className="tool-group-icon">⚡</span>
        <span className="tool-group-title">
          {count === 1 ? (
            <>
              {t('已调用工具')} <span className="tool-group-verb">{verbList[0] || 'tool'}</span>
            </>
          ) : (
            <>
              {t('已执行 {n} 个步骤', { n: count })}
              {verbsSummary && <span className="tool-group-verbs">({verbsSummary})</span>}
            </>
          )}
        </span>
        {badCount > 0 && (
          <span className="tool-group-badge-bad">
            {t('{n} 个异常', { n: badCount })}
          </span>
        )}
        <span className="tool-group-time">{time}</span>
      </summary>
      {open && (
        <div className="tool-group-list">
        {tools.map((m) => (
          <Message
            key={m.id}
            panel={panel}
            id={m.id}
            role={m.role}
            content={m.displayContent ?? m.content}
            edited={m.edited}
            at={m.createdAt}
            stepMode={stepMode}
            stats={m.stats}
            images={m.images}
            steer={m.steer}
            onQuoteImage={onQuoteImage}
            onEditUserMsg={onEditUserMsg}
            onResendUserMsg={onResendUserMsg}
          />
        ))}
      </div>
      )}
    </details>
  );
});
