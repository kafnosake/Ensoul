import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Panel } from '../../../shared/types';
import { SESSION_GUTTER, SESSION_W } from './constants';
import { sendHistCmd, useHist, type HistEntry } from './useHist';
import { zoomScale } from '../../ui/zoom-space';
import { t } from '../../core/i18n';

/**
 * 历史会话 —— 挂在**会话区左边界**上的一道原生小栏，跟右边缘那条便签刻度同一族。
 *
 * ── 它挂在哪 ──────────────────────────────────────────────────────────
 * 消息列是**居中**的（--col-w），所以列左边缘外侧有一整片留白。它就住在那片留白里，
 * **紧贴列左边缘**（左边距 = 列左缘 - 它自己 - 一道缝），垂直居中排列。
 * 不是面板最左边（面板宽 2145、列 760 的时候两者差着几百像素，看着像贴在屏幕上），
 * 也不是浮窗 —— 所以**没有边框、没有圆角、没有投影**，就是一列裸文字。
 *
 * ── 一版一行，点一下跳过去 ────────────────────────────────────────────
 * 按时间分组（今天 / 昨天 / 7 天内 / 更早），行上写标题（模型起的；没起就退回
 * 显示开头那句）。==点一行 = 中间的会话跳过去==：插件把面板的 chat 换成那一段。
 * 这才是"回档"，跟"就地展开只读一份"是两回事。
 *
 * **行上只写标题** —— 时间、条数、来路徽章全撤了。用户没要这三样，它们挤在
 * 标题右边，把字推到离列缘一百多像素，看着"离会话区老远"（他点名过两回）。
 * 一版的来路插件还记着（去重要用），只是不再摆到脸上。
 *
 * 几个动作都在「⋯」里（右键一行也出同一个菜单），走命令文件递回插件：
 * 重命名（就地输入）· 多选 · 删除。**排序不用菜单** —— 直接把那一行拖走就是了。
 *
 * ── 字挨着列 ──────────────────────────────────────────────────────────
 * 这一栏挂在列的**左**边，所以"贴着列缘"= **右对齐**：标题的字右端落在
 * 离列缘一道缝的地方，多长多短都一样。左对齐时字头永远在栏的最左边，
 * 那才是"离得远"。
 *
 * ── 宽度怎么决定（用户点名的规矩）────────────────────────────────────
 *   列左边的留白 ≥ 188px  → 一栏 176px
 *   留白在 120~188 之间   → ==先把字挤窄==（跟着缩到刚好塞得下）
 *   留白 < 120px          → ==整栏让位、直接隐藏==（会话列铺开优先）
 * 量的是列左边那片留白的实际宽度 = (容器宽 - 列宽) / 2，ResizeObserver 跟着 ——
 * 拖列宽、拉窗口、切面板都跟手。
 */

/** 一栏默认多宽 */
const RAIL_W = 176;
/** 再窄就不成句了 —— 到这儿就让位，直接隐藏 */
const RAIL_MIN = 120;
/** 跟消息列之间至少留这么一道缝 */
const GAP = 12;

/** 分组：今天 / 昨天 / 7 天内 / 更早 —— 跟 deepseek 那个侧栏一个分法 */
function groupOf(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = d.getTime();
  if (day >= day0) return t('今天');
  if (day >= day0 - 86400000) return t('昨天');
  if (day >= day0 - 7 * 86400000) return t('7 天内');
  return t('更早');
}

/** 行上写什么：模型起的标题；还没起就退回挑第一次开口那句 */
function label(e: HistEntry): string {
  if (e.title) return e.title;
  const head = e.msgs.find((m) => m.role === 'user') || e.msgs[0];
  const text = head && typeof head.content === 'string' ? head.content : '';
  return text.replace(/\s+/g, ' ').slice(0, 60) || t('（没有正文）');
}

export function HistRail({ panel }: { panel: Panel }) {
  const entries = useHist(panel.id);
  /** 这一栏能给多宽（量出来的），null = 还没量到 */
  const [room, setRoom] = useState<number | null>(null);
  /** 正在就地改名的那一行 */
  const [editing, setEditing] = useState('');
  const [draft, setDraft] = useState('');
  /** 多选：挑中的 key */
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [multi, setMulti] = useState(false);
  /** 行上的小菜单（重命名 / 多选 / 删除）—— 悬停那颗「⋯」或右键一行 */
  const [menu, setMenu] = useState<{ e: HistEntry; x: number; y: number } | null>(null);
  /** 拖拽排序：正被拖的那一行 */
  const [drag, setDrag] = useState('');
  /** 这一栏的根节点 —— 量宽度看的是它的父节点（.dock-body） */
  const box = useRef<HTMLDivElement | null>(null);
  /** 本栏根节点 —— 量缩放倍率要从这里上溯（见 ui/zoom-space.ts） */
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setEditing('');
    setPicked(new Set());
    setMulti(false);
    setMenu(null);
  }, [panel.id]);

  /**
   * 量自己挂的那个容器（.dock-body）：它是**容器本身**的宽度，跟这一栏开不开、
   * 列拖多宽都无关（这一栏是绝对定位，不吃它的地方）。列宽 = min(拖出来的宽度,
   * 容器宽 - 两边留白)（跟 chat.css 里的 --col-w 同一条式子），
   * 留白 = (容器宽 - 列宽) / 2 —— 那就是列左边空出来的那一半，这一栏就住这里。
   */
  useLayoutEffect(() => {
    const el = box.current?.parentElement ?? null;
    if (!el) return;
    const measure = () => {
      // rect 是屏幕单位，而下面要跟 chatW / SESSION_W / GUTTER 这些内部 px 比大小 —— 先换算
      const w = el.getBoundingClientRect().width / zoomScale(el);
      if (!w) return;
      const col = Math.min(panel.chatW ?? SESSION_W, w - SESSION_GUTTER * 2);
      setRoom((w - col) / 2 - GAP);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [panel.chatW, panel.id]);

  // 关掉小菜单：点别处、按 Esc 都收
  useEffect(() => {
    if (!menu) return;
    const away = () => setMenu(null);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', key);
    };
  }, [menu]);

  /** 新的在最上面（跟读文章一个方向：越往下越旧）；手动拖过之后以 ord 为准 */
  const list = [...entries].sort((a, b) => b.ord - a.ord || b.to - a.to);

  /** 宽度：留白够就 176，挤得动就跟着缩（量不到时先按 176 画） */
  const width = room == null ? RAIL_W : Math.min(RAIL_W, room);
  /**
   * 留白不够就**让位**（会话列铺开优先）。但元素本身还得在 —— 它是量宽度的
   * 那只耳朵：真把它从树上摘掉，ResizeObserver 就断了，窗口再拉大也回不来。
   * 所以是 display:none，不是不渲染。
   */
  const hidden = room != null && room < RAIL_MIN;

  /** 拖完把新次序递回去 —— 从**上到下**给 key，插件那边按它定名次 */
  const drop = (targetKey: string) => {
    if (!drag || drag === targetKey) return setDrag('');
    const keys = list.map((x) => x.key);
    const from = keys.indexOf(drag);
    const to = keys.indexOf(targetKey);
    if (from < 0 || to < 0) return setDrag('');
    keys.splice(to, 0, ...keys.splice(from, 1));
    setDrag('');
    void sendHistCmd(panel.id, { kind: 'reorder', keys });
  };

  const commitRename = (e: HistEntry) => {
    const t = draft.trim();
    setEditing('');
    if (t && t !== e.title) void sendHistCmd(panel.id, { kind: 'rename', key: e.key, title: t });
  };

  const doRemove = (keys: string[]) => {
    if (!keys.length) return;
    void sendHistCmd(panel.id, { kind: 'remove', keys });
    setMulti(false);
    setPicked(new Set());
  };

  let lastGroup = '';

  return (
    <div className={`hist-rail${hidden ? ' is-hidden' : ''}`} ref={box} style={{ width }}>
      {multi && (
        <div className="hist-multi">
          <span className="hist-multi-n">{t('已选')}{picked.size}</span>
          <button className="hist-multi-btn" title={t('全选')} onClick={() => setPicked(new Set(list.map((x) => x.key)))}>
            {t('全选')}
          </button>
          <button className="hist-multi-btn" title={t('取消')} onClick={() => { setMulti(false); setPicked(new Set()); }}>
            {t('取消')}
          </button>
          <button
            className="hist-multi-del"
            disabled={!picked.size}
            title={t('删除')}
            onClick={() => doRemove([...picked])}
          >
            {t('删除')}
          </button>
        </div>
      )}

      <div className="hist-scroll">
        {list.length === 0 && (
          <div className="hist-none">{t('还没有历史。')}</div>
        )}
        {list.map((e) => {
          const g = groupOf(e.to || e.from);
          const head = g !== lastGroup;
          lastGroup = g;
          const on = picked.has(e.key);
          return (
            <React.Fragment key={e.key}>
              {head && <div className="hist-group">{g}</div>}
              <div
                className={`hist-row${on ? ' is-picked' : ''}${e.isCurrent ? ' is-current' : ''}${drag === e.key ? ' is-drag' : ''}`}
                draggable={!multi}
                onDragStart={() => setDrag(e.key)}
                onDragEnd={() => setDrag('')}
                onDragOver={(ev) => ev.preventDefault()}
                onDrop={() => drop(e.key)}
                onClick={() => {
                  if (multi) {
                    setPicked((s) => {
                      const next = new Set(s);
                      if (next.has(e.key)) next.delete(e.key);
                      else next.add(e.key);
                      return next;
                    });
                    return;
                  }
                  if (editing === e.key) return;
                  if (e.isCurrent) return;
                  // 就是这一下：中间的会话跳过去（跳走之前插件会把当前这段收进历史）
                  void sendHistCmd(panel.id, { kind: 'jump', key: e.key });
                }}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  // 菜单是 fixed：面板缩放过之后 left/top 会被再乘一次倍率（实测），
                  // 先换回面板内部单位，指针和菜单才对得上
                  const k = zoomScale(ev.currentTarget as HTMLElement);
                  setMenu({ e, x: ev.clientX / k, y: ev.clientY / k });
                }}
                title={e.title ? `${e.title}\n（点一下跳过去 · 拖走改次序 · 右键更多）` : t('点一下跳过去')}
              >
                {editing === e.key ? (
                  <input
                    className="hist-rename"
                    autoFocus
                    value={draft}
                    onChange={(ev) => setDraft(ev.target.value)}
                    onBlur={() => commitRename(e)}
                    onClick={(ev) => ev.stopPropagation()}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') commitRename(e);
                      if (ev.key === 'Escape') setEditing('');
                    }}
                  />
                ) : (
                  <span className="hist-name">{label(e)}</span>
                )}
                {!multi && (
                  <button
                    className="hist-more"
                    title={t('更多')}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                      const k = zoomScale(ev.currentTarget as HTMLElement);
                      setMenu({ e, x: Math.min(r.left / k - 90, window.innerWidth / k - 150), y: r.bottom / k + 2 });
                    }}
                  >
                    ⋯
                  </button>
                )}
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {menu && (
        <div
          className="hist-menu"
          ref={root}
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(ev) => ev.stopPropagation()}
        >
          <button
            onClick={() => {
              setDraft(menu.e.title || label(menu.e));
              setEditing(menu.e.key);
              setMenu(null);
            }}
          >
            {t('重命名')}
          </button>
          <button
            onClick={() => {
              setMulti(true);
              setPicked(new Set([menu.e.key]));
              setMenu(null);
            }}
          >
            {t('多选')}
          </button>
          <button
            className="is-danger"
            onClick={() => {
              doRemove([menu.e.key]);
              setMenu(null);
            }}
          >
            {t('删除')}
          </button>
        </div>
      )}
    </div>
  );
}
