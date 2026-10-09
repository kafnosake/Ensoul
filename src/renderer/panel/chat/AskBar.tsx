import React, { useEffect, useMemo, useState } from 'react';
import { t } from '../../../shared/i18n';
import type { AskViewQuestion } from '../../core/api';

/**
 * 一道题当前答成什么样 —— 提交时原样发给主进程（见 api.chat.askConfirm）。
 * 跟 dsh 的 AskUserQuestionAnswerItem 同形：selected + custom。
 */
export interface AskAnswerDraft {
  id: string;
  selected: string[];
  custom?: string;
}

/**
 * 选项标签末尾的「(Recommended)」/「（推荐）」摘出来单独画成小徽标 ——
 * 布局学 dsh：标签后面跟一个蓝色小字「推荐」，不混在正文里。
 */
const RECO = /[\s]*[（(]\s*(?:Recommended|推荐)\s*[)）][\s]*$/i;

function splitLabel(label: string): { text: string; recommended: boolean } {
  if (RECO.test(label)) return { text: label.replace(RECO, '').trim(), recommended: true };
  return { text: label, recommended: false };
}

/**
 * 这题答过了没有 —— 选了选项，或者填了自定义答案，都算答过。
 *
 * 它是「下一题 / 提交」的**开关**：没作答就把那个按钮置灰（点不动）。
 * 不弹字、不加行 —— 弹一句说明会让卡片长高一截，整块布局被顶上去，
 * 那正是要避免的。灰着的按钮本身就是说明：这题还没答完。
 * 真想放掉这题，走「跳过」—— 那是明说的动作，另算。
 */
function answered(
  q: AskViewQuestion,
  picks: Record<string, string[]>,
  customs: Record<string, string>,
): boolean {
  return (picks[q.id] || []).length > 0 || (customs[q.id] || '').trim() !== '';
}

/**
 * 把草稿收成提交用的答案数组：没答的题照样带上，
 * 空 selected + 无 custom 就是「这题跳过」—— 提问方不用猜。
 */
function toAnswers(
  questions: AskViewQuestion[],
  picks: Record<string, string[]>,
  customs: Record<string, string>,
): AskAnswerDraft[] {
  return questions.map((q) => {
    const sel = picks[q.id] || [];
    const cus = (customs[q.id] || '').trim();
    const item: AskAnswerDraft = { id: q.id, selected: [...sel] };
    if (cus) item.custom = cus;
    return item;
  });
}

/**
 * 问题卡片 —— **占掉输入框的位置**（dsh 的附着式卡片就是这么做的：
 * 「附着式卡片会暂时占用编辑器位置」，见它自己的 README）。
 *
 * 分工说清楚，免得下次又改歪：
 *   · **布局学 dsh**：眉题 + 题目、选项一行行（不是一摞小卡片）、序号方块、
 *     「推荐」小徽标、铅笔自定义、左下 ‹ 1/3 ›、右下「跳过 / 下一题」。
 *   · **材质用本软件自己的**：底色 / 边框 / 圆角 / 阴影 / 字号一律对齐
 *     `.composer`（见 composer.css）—— 它是这一格的原住民，卡片得像它。
 *
 * 三条不许再犯的错：
 * 1. 题目只在一处出现（别把 ask.text 和 question 都渲染，看着像重复）。
 * 2. 底下不许挂「已答 0/3」这类自造说明 —— 纯噪声。
 * 3. 「跳过」跳的是**这一题**；整张作废是右上角 ✕（走 askCancel）。
 * 4. 没作答不许靠「下一题」蒙过去 —— 拦住并就地说明（用「跳过」是另一回事）。
 */
export function AskBar(props: {
  ask: { text: string; confirm: string; cancel: string; questions: AskViewQuestion[] };
  err: string;
  onSubmit: (answers: AskAnswerDraft[]) => void;
  onCancel: () => void;
}) {
  const { ask, err, onSubmit, onCancel } = props;
  const questions = ask.questions;
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [customs, setCustoms] = useState<Record<string, string>>({});
  const [idx, setIdx] = useState(0);
  const [folded, setFolded] = useState(false);

  // 换一张新问卷（题号变了）就清空草稿 —— 上一条的答案不许漏给下一条
  const sig = useMemo(() => questions.map((q) => q.id).join('|'), [questions]);
  useEffect(() => {
    setIdx(0);
    setPicks({});
    setCustoms({});
    setFolded(false);
  }, [sig]);

  const cur = questions[Math.min(idx, questions.length - 1)];
  const curSel = picks[cur.id] || [];
  const multi = Boolean(cur.multiSelect);
  const last = idx >= questions.length - 1;
  /** 这题答了没 —— 决定右下那个按钮是亮着还是灰着 */
  const curAnswered = answered(cur, picks, customs);

  /**
   * 选中一个选项。
   *
   * 单选「点了就走」（dsh 的行为）：把选中和前进放进**同一个事件**里，
   * React 会把这两个 setState 合批，这一帧直接就是下一题 —— 中间不会先渲染出
   * 一个「已选中」的实心按钮。从前这里挂了个 160ms 的 setTimeout，选中和切题
   * 就分成了两帧，用户会看见按钮闪一下再切走（那正是要消掉的）。
   *
   * 多选留在原地继续勾 —— 这时选中态是要看得见的，不给它省。
   */
  const choose = (label: string) => {
    const nextSel = multi
      ? curSel.includes(label)
        ? curSel.filter((x) => x !== label)
        : [...curSel, label]
      : [label];
    const nextPicks = { ...picks, [cur.id]: nextSel };
    setPicks(nextPicks);
    if (multi) return;
    if (last) onSubmit(toAnswers(questions, nextPicks, customs));
    else setIdx((n) => Math.min(questions.length - 1, n + 1));
  };

  const setCustom = (v: string) => setCustoms((prev) => ({ ...prev, [cur.id]: v }));

  // 「跳过」：放掉这题（空答案）再前进；最后一题就直接交卷。整张不作废。
  const skip = () => {
    const p2 = { ...picks, [cur.id]: [] };
    const c2 = { ...customs, [cur.id]: '' };
    setPicks(p2);
    setCustoms(c2);
    if (last) onSubmit(toAnswers(questions, p2, c2));
    else setIdx((n) => Math.min(questions.length - 1, n + 1));
  };

  /**
   * 「下一题 / 提交」：按钮没作答时是灰的（见下面的 disabled），这里再兜一层。
   * 交卷前也再查一遍：万一还有没答的题，就停在那道题上 —— 不加文字说明。
   */
  const next = () => {
    if (!curAnswered) return;
    if (!last) {
      setIdx((n) => Math.min(questions.length - 1, n + 1));
      return;
    }
    const miss = questions.findIndex((q) => !answered(q, picks, customs));
    if (miss >= 0) {
      setIdx(miss);
      return;
    }
    onSubmit(toAnswers(questions, picks, customs));
  };

  if (folded) {
    return (
      <div className="ask-form is-folded">
        <div className="ask-form-head">
          <div className="ask-form-eyebrow">{cur.header || t('提问')}</div>
          <div className="ask-form-tools">
            <button type="button" className="ask-form-icon" title={t('展开问题卡片')} onClick={() => setFolded(false)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 6.5L8 10.5L12 6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            <button type="button" className="ask-form-icon" title={t('放弃整组问题')} onClick={onCancel}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ask-form">
      <div className="ask-form-head">
        <div className="ask-form-heading">
          {cur.header && <div className="ask-form-eyebrow">{cur.header}</div>}
          <div className="ask-form-title">{cur.question}</div>
        </div>
        <div className="ask-form-tools">
          <button type="button" className="ask-form-icon" title={t('收起问题卡片')} onClick={() => setFolded(true)}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 9.5L8 5.5L12 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <button type="button" className="ask-form-icon" title={t('放弃整组问题')} onClick={onCancel}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>
      </div>

      <div className="ask-form-body">
        {cur.detail && <div className="ask-form-detail">{cur.detail}</div>}

        {cur.options && cur.options.length > 0 && (
          <div className="ask-form-options">
            {cur.options.map((o, oi) => {
              const on = curSel.includes(o.label);
              const { text, recommended } = splitLabel(o.label);
              return (
                <button
                  type="button"
                  key={o.label}
                  className={`ask-form-option${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => choose(o.label)}
                >
                  <span className={`ask-form-num${on ? ' is-on' : ''}`} aria-hidden>
                    {on ? (
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5L6.5 11.5L12.5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    ) : (
                      oi + 1
                    )}
                  </span>
                  <span className="ask-form-copy">
                    <span className="ask-form-line">
                      <span className="ask-form-label">{text}</span>
                      {recommended && <span className="ask-form-badge">{t('推荐')}</span>}
                    </span>
                    {o.description && <span className="ask-form-desc">{o.description}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <label className="ask-form-custom">
          <span className="ask-form-pencil" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M10.5 2.9L13.1 5.5L5.6 13H3V10.4L10.5 2.9Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
          </span>
          <textarea
            className="ask-form-field"
            rows={1}
            value={customs[cur.id] || ''}
            placeholder={t('输入你的答案')}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                next();
              }
            }}
          />
        </label>
      </div>

      <div className="ask-form-foot">
        <div className="ask-form-pager">
          <button
            type="button"
            className="ask-form-page"
            disabled={idx === 0}
            title={t('上一题')}
            onClick={() => setIdx((n) => Math.max(0, n - 1))}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M9.5 4L5.5 8L9.5 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <span className="ask-form-progress">{idx + 1} / {questions.length}</span>
          <button
            type="button"
            className="ask-form-page"
            disabled={last}
            title={t('下一题')}
            onClick={() => setIdx((n) => Math.min(questions.length - 1, n + 1))}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6.5 4L10.5 8L6.5 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
        </div>
        <div className="ask-form-actions">
          <button type="button" className="ask-form-skip" onClick={skip}>{t('跳过')}</button>
          <button
            type="button"
            className="ask-form-ok"
            disabled={!curAnswered}
            onClick={next}
          >
            {last ? ask.confirm : t('下一题')}
          </button>
        </div>
      </div>
      {err && <div className="ask-form-err">{err}</div>}
    </div>
  );
}
