import React, { useEffect, useState } from 'react';
import type { OutboxItem } from '../../../shared/types';
import { api } from '../../core/api';
import { fmtTime } from './format';
import { t } from '../../core/i18n';

/**
 * 排队条：还没发出去的那些话，摆在输入框**上面**。
 *
 * 两段，语义完全不同：
 *   · **排队的**：等这一整轮跑完，队首那条自动发出去，成为新的一轮。
 *     用户可以把接下来几件事一次都摆上，不用盯着它什么时候停；
 *   · **插进去的**：已经送进此刻正在跑的那一轮了，模型做完手头这一步就会读到。
 *     它不排队 —— 这一轮还没结束它就已经生效了。
 *
 * 「插队」按钮就是把上面那段的某一条**提到**下面那段：这是两条边界之间唯一的门。
 *
 * 数据两头都从主进程拿（`chat:outbox` 问一次 + `chat:steer` 听广播），
 * 队列那一段其实也躺在面板上（panel.outbox），跟着工作区快照一起回来 ——
 * 但**不要**只信快照：插话盒子不在快照里（它只在主进程内存里）。
 */
export function Outbox({
  panelId,
  queue,
  busy,
  restartArmed,
}: {
  panelId: string;
  /** 排队的话（面板上的 outbox，跟着工作区快照回来） */
  queue: OutboxItem[];
  /** 它此刻在不在跑 —— 不在跑就插不了队（挂着重启时是例外，见下） */
  busy: boolean;
  /** 挂着"等全部会话结束就重启"：这时候"插队"= 不等重启、现在就发 */
  restartArmed?: boolean;
}) {
  /** 插话盒子的镜像（主进程内存里那份，靠广播同步） */
  const [steer, setSteer] = useState<OutboxItem[]>([]);
  /** 正在改的那一条（编辑框里的文本），null = 没在改 */
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  /** 插不进去时的说法（"它没在跑"这类）—— 摆在条上，别用弹窗 */
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    void api.chat.outbox(panelId).then((r) => {
      if (alive && Array.isArray(r?.steer)) setSteer(r.steer);
    });
    const off = api.chat.onSteer((p) => {
      if (p.panelId === panelId) setSteer(Array.isArray(p.items) ? p.items : []);
    });
    return () => {
      alive = false;
      off();
    };
  }, [panelId]);

  const act = (p: Promise<{ ok: boolean; error?: string }>) => {
    setErr('');
    void p.then((r) => {
      if (!r?.ok && r?.error) setErr(r.error);
    });
  };

  if (!queue.length && !steer.length && !err) return null;

  return (
    <div className="outbox">
      {err && <div className="outbox-err">{err}</div>}

      {/* 插进去的那些：已经在往正在跑的那一轮里送了，标一句"等它这一步做完就进" */}
      {steer.length > 0 && (
        <div className="outbox-sec">
          <span className="outbox-tag is-steer">{t('插话中')}</span>
          {steer.map((it) => (
            <div className="outbox-row is-steer" key={it.id}>
              <span className="outbox-text">{it.text}</span>
              {it.images?.length ? <span className="outbox-pic">{it.images.length} 图</span> : null}
            </div>
          ))}
        </div>
      )}

      {/* 排队的那些：这一轮跑完自动接上，从队首开始 */}
      {queue.length > 0 && (
        <div className="outbox-sec">
          <span className="outbox-tag">{t('排队')}{queue.length}</span>
          {queue.map((it, i) => (
            <div className="outbox-row" key={it.id}>
              {editing?.id === it.id ? (
                <>
                  <input
                    className="outbox-edit"
                    value={editing.text}
                    autoFocus
                    onChange={(e) => setEditing({ id: it.id, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        act(api.chat.queueEdit(panelId, it.id, editing.text));
                        setEditing(null);
                      }
                      if (e.key === 'Escape') setEditing(null);
                    }}
                  />
                  <button
                    className="outbox-btn"
                    title={t('保存（回车）')}
                    onClick={() => {
                      act(api.chat.queueEdit(panelId, it.id, editing.text));
                      setEditing(null);
                    }}
                  >
                    {t('存')}
                  </button>
                </>
              ) : (
                <>
                  {/* 序号只对"排在谁前面"有意义 —— 第一条就是这一轮跑完要发的 */}
                  <span className="outbox-idx">{i + 1}</span>
                  <span className="outbox-text" title={it.text}>
                    {it.text}
                  </span>
                  {it.images?.length ? <span className="outbox-pic">{it.images.length} 图</span> : null}
                  <span className="outbox-time">{fmtTime(it.at)}</span>
                  <button
                    className="outbox-btn is-steer"
                    /* 这颗按钮**始终按得动** —— 它只表达一件事"这条我不等了"，
                       至于"优先到哪去"由主进程按此刻状态定：
                         在跑 → 送进正在跑的那一轮（下一步就读到）；
                         停了 → 抢在队里其他人前面立刻发。
                       原来写的是 disabled={!busy}，那等于**恰恰在最该用它的两个场合**
                       （挂着等重启、上一轮出错）按钮是死的。 */
                    title={
                      busy
                        ? t('插队：送进正在跑的那一轮')
                        : restartArmed
                          ? t('不等重启，现在就发这条')
                          : t('立刻发这条（不等队列）')
                    }
                    onClick={() => act(api.chat.queueSteer(panelId, it.id))}
                  >
                    {t('插队')}
                  </button>
                  <button
                    className="outbox-btn"
                    title={t('改这句')}
                    onClick={() => setEditing({ id: it.id, text: it.text })}
                  >
                    {t('改')}
                  </button>
                  <button
                    className="outbox-btn"
                    title={t('移出队列')}
                    onClick={() => act(api.chat.queueRemove(panelId, it.id))}
                  >
                    ×
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
