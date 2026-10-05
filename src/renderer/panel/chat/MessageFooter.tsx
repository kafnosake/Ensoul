import { useState } from 'react';
import type { ChatStats, Panel } from '../../../shared/types';
import { api } from '../../core/api';
import { IconBranch, IconClock, IconCode, IconCopy, IconDatabase, IconThumbDown, IconThumbUp } from '../../ui/icons';
import { fmtDur, fmtTime, fmtTokens } from './format';
import { sendHistCmd } from './useHist';
import { t } from '../../core/i18n';

/** 回复下面那一条：文件改动 / 复制 / 赞踩 / 用量 / 速度 / 用时 / 时间 */
export function MessageFooter({ panel, id, stats, content }: { panel: Panel; id: string; stats: ChatStats; content: string }) {
  const files = stats.files ?? [];
  const speed = stats.ms && stats.tokensOut ? stats.tokensOut / (stats.ms / 1000) : 0;
  const [branching, setBranching] = useState(false);

  const onBranch = () => {
    if (branching) return;
    setBranching(true);
    void sendHistCmd(panel.id, {
      kind: 'branch',
      msgId: id,
      switchToBranch: true,
    });
    setTimeout(() => setBranching(false), 800);
  };

  return (
    <div className="msg-foot">
      {files.length > 0 && (
        <div className="foot-files">
          <span className="foot-label">{t('本轮文件改动')}</span>
          {files.slice(0, 4).map((f) => (
            <span className="foot-file" key={f} title={f}>
              <IconCode />
              {f.split('/').pop()}
            </span>
          ))}
          {files.length > 4 && <span className="foot-more">+ {files.length - 4} 个文件</span>}
        </div>
      )}

      <div className="foot-bar">
        <button onClick={() => void navigator.clipboard?.writeText(content)} title={t('复制')}>
          <IconCopy />
        </button>
        <button
          className={stats.rating === 'up' ? 'is-on' : ''}
          onClick={() => void api.chat.rate(panel.id, id, 'up')}
          title={t('答得好')}
        >
          <IconThumbUp />
        </button>
        <button
          className={stats.rating === 'down' ? 'is-bad' : ''}
          onClick={() => void api.chat.rate(panel.id, id, 'down')}
          title={t('答得不好')}
        >
          <IconThumbDown />
        </button>
        <button onClick={onBranch} disabled={branching} title={branching ? t('正在创建分支…') : t('在新对话中分支')}>
          <IconBranch />
        </button>

        <span className="foot-stat">
          <IconDatabase />{t('用量')}{fmtTokens(stats.total)}
          {speed > 0 ? ` · ${speed.toFixed(1)} tok/s` : ''}
        </span>
        <span className="foot-stat">
          <IconClock /> 用时 {fmtDur(stats.ms)}
        </span>
        {stats.cost && (
          <span
            className="foot-stat"
            title={t('命中 ¥{a} · 未命中 ¥{b} · 输出 ¥{c}', { a: stats.cost.hit.toFixed(4), b: stats.cost.miss.toFixed(4), c: stats.cost.out.toFixed(4) })}
          >
            ¥{stats.cost.total.toFixed(4)}
          </span>
        )}
        <span className="foot-time">{fmtTime(stats.at)}</span>
      </div>
    </div>
  );
}
