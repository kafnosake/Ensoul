import React from 'react';
import type { LiveTask } from '../../../shared/types';
import { shotUrl } from './format';
import { openImage } from '../../ui/image-open';
import { t } from '../../core/i18n';

/**
 * 工具跑动中挂在对话里的那一块：**进行中的容器**（在干什么、跑到哪一步、过程预览图）
 * 加上这一轮已经送进对话的图。
 *
 * 为什么要有它：一次出图十几秒到几分钟，那期间对话区里只有一条"正在跑工具"的死行，
 * 用户看不出它是在干活还是卡死了。Gemini / 豆包那种"边生成边看"补的就是这一段。
 *
 * 它是**临时**的 —— 这一轮跑完，图随助手消息留在对话里，这一块被主进程撤掉
 * （见 index.ts 的 liveClear）。所以这里不用管持久化，也不该显示"生成中 3/28"这种
 * 会过期的状态：它压根不落盘。
 */
export function LiveCard({ tasks, images, panel }: { tasks: LiveTask[]; images: string[]; panel: string }) {
  if (!tasks.length && !images.length) return null;
  // 每次跑各自带预览：横排里 = 还在跑的"生成中" + 已出好的成品，全排在一起
  const previews = tasks.map((task) => task.preview).filter(Boolean) as string[];
  return (
    <div className="live-card">
      {tasks.map((task) => {
        // percent 不给 = 不知道进度（比如队列里排着）：画一条来回滚的条，
        // 不编一个百分比出来 —— 假的进度条比没有更让人恼火
        const known = typeof task.percent === 'number' && Number.isFinite(task.percent);
        return (
          <div className="live-task" key={task.key}>
            <div className="live-head">
              <span className="live-spin" />
              <span className="live-label">{task.label}</span>
              {task.note && <span className="live-note">{task.note}</span>}
            </div>
            <div className={`live-bar${known ? '' : ' is-indet'}`}>
              {known && <i style={{ width: `${Math.max(2, Math.min(100, task.percent as number))}%` }} />}
            </div>
          </div>
        );
      })}
      {/* 队列横排：跑着的预览 + 已出好的成品排在一起，原尺寸并排（不裁不撑）。
          成品只在这儿等 —— 整轮跑完才随回复一起发出来 */}
      {(previews.length > 0 || images.length > 0) && (
        <div className="live-strip">
          {previews.map((p, i) => (
            <div className="live-cell" key={`p${i}`}>
              <img src={shotUrl(p)} alt="" title={t('点开看大图')} onClick={() => openImage(p, panel)} />
              <span className="live-preview-tag">{t('生成中')}</span>
            </div>
          ))}
          {images.map((s, i) => (
            <div className="live-cell" key={i}>
              <img src={shotUrl(s)} alt="" title={t('点开看大图')} onClick={() => openImage(s, panel)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
