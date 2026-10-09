import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type ComponentRef } from '../../shared/types';
import { api, type Workspace } from '../core/api';
import { panelType } from '../panel/registry';
import { IconMoreH } from '../ui/icons';
import { t } from '../core/i18n';

/** 组件挂在哪种面板上 —— 显示注册过的类型名（内置和插件都算），认不出来才退回 kind */
const kindName = (kind: string) => panelType(kind)?.label || kind;

/**
 * 组件区 —— 就长在主窗口菜单栏里（顶栏中间那一段），不另起一行。
 *
 * 条目是**持久入口**（快捷方式），只列**收进收纳区的**（`pinned`）——
 * 存为组件（声明）只让它在 设置 → 组件 里落户，**不占条上这一格**；
 * 收的是**面板本身**，不是"这种做法"：
 *   · 把面板拖到这一段上松手 → 整个面板（对话、草稿、状态）收进 `components/<id>.json`，
 *     布局里它就消失了（判定在 MainShell 里，这里只负责接住）
 *   · 点一下名字 → **打开那个面板**（同一个 id、同一段对话，不是复制一个）；
 *     已经开着就只是切过去，条目**不会**因此消失
 *   · 按住名字往外拖 → 拖到哪块区域的中间/边上松手，就在那儿打开（开着就是挪过去）
 *   · 面板开着时这个名字点亮 —— 跟任务栏一个道理，点它 = 切过去
 *   · 随顶栏宽度自适应容纳，放不下的自动收进右边的「»」下拉
 *
 * 条上**没有删除键**，也没有"释放"键：删除和释放都只在 设置 → 组件 里手动做
 * （释放 = 从条上撤下来，本体一个字符不丢），软件不会自己清掉任何一条入口。
 * 条上只画名字：本体可能带着十几万字的对话，不进广播 ——
 * 打开时主进程按 id 去 `components/<id>.json` 取，跟"历史会话"一个套路。
 */
export function ComponentBar({
  ws,
  barRef,
  onBar,
  active,
  barIndex,
  draggingComponentId,
  onGrab,
}: {
  ws: Workspace | null;
  /** 拖动时要拿这个矩形判"松手是不是落在收纳区上"，所以得挂到主窗口那层 */
  barRef: React.RefObject<HTMLDivElement>;
  /** 这一拖正落在这条上 —— 松手就收起来 */
  onBar: boolean;
  /** 正在拖东西：条要显形，不然看不出这儿是个落点 */
  active: boolean;
  /** 落点插在第几个组件 */
  barIndex?: number;
  /** 正在拖拽的收纳区组件 id */
  draggingComponentId?: string | null;
  /** 按住名字往外拖 —— 交给主窗口那套落点判定，松手时就把那个面板放回那儿 */
  onGrab: (componentId: string, name: string, e: React.PointerEvent) => void;
}) {
  const [open, setOpen] = useState(false);
  /** 条上只画**钉住的** —— 声明过但没收进收纳区的，只在 设置 → 组件 里躺着 */
  const items: ComponentRef[] = (ws?.componentRefs ?? []).filter((c) => c.pinned);
  /**
   * 条目的**内容指纹** —— 只有这几个字段变了，才该重测宽度、重做位移动画。
   *
   * 主进程广播很勤（面板被更新、状态部件每 1~2 秒刷一次），但那些都**不改收纳区条目**。
   * 若直接拿 items（每轮渲染都是新数组引用）当依赖，每次广播都会重跑一遍测量与 FLIP，
   * 顶栏宽度一旦卡在临界值上，条目就会在「平铺」与「»」下拉之间来回横跳 —— 这就是"老是跳"的来源。
   */
  const itemsKey = items.map((c) => `${c.id}:${c.name}:${c.pinned ? 1 : 0}`).join('|');
  const itemsRef = useRef(items);
  itemsRef.current = items;
  /** 这些入口里哪些面板此刻开着 —— 开着的名字要点亮（跟任务栏一个道理） */
  const live = new Set(Object.keys(ws?.panels ?? {}));

  const slotRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [maxFit, setMaxFit] = useState<number>(items.length);

  /** 动态测量顶栏剩余宽度，计算最多能平铺摆几个，放不下的进下拉 */
  const updateFit = useCallback(() => {
    const list = itemsRef.current;
    const slot = slotRef.current;
    const measure = measureRef.current;
    if (!slot || !measure || list.length === 0) {
      setMaxFit(list.length);
      return;
    }

    // 可用宽度：slot 宽度减去 .cmpfav 自身左右 padding（6px * 2 = 12px）
    const availWidth = slot.clientWidth - 12;
    if (availWidth <= 0) return;

    const children = Array.from(measure.children) as HTMLElement[];
    const itemEls = children.slice(0, list.length);
    const moreEl = children[list.length];
    const moreWidth = (moreEl?.offsetWidth || 24) + 4; // 更多按钮宽度 + gap

    const gap = 4;
    let totalAllWidth = 0;
    const itemWidths: number[] = [];

    for (let i = 0; i < itemEls.length; i++) {
      const w = itemEls[i].offsetWidth;
      itemWidths.push(w);
      totalAllWidth += w + (i > 0 ? gap : 0);
    }

    // 全量能放下，不需要「»」更多按钮
    if (totalAllWidth <= availWidth) {
      setMaxFit(list.length);
      return;
    }

    // 放不下，给「»」更多按钮预留宽度后计算能放几个
    const targetWidth = availWidth - moreWidth;
    let currentWidth = 0;
    let count = 0;

    for (let i = 0; i < itemWidths.length; i++) {
      const next = currentWidth + (count > 0 ? gap : 0) + itemWidths[i];
      if (next <= targetWidth) {
        currentWidth = next;
        count++;
      } else {
        break;
      }
    }

    /*
     * 迟滞（上下沿分开）：减少一格是"确实放不下"，照做；
     * 但要**增**一格时必须有 8px 余量才肯动 —— 顶栏右侧的状态部件是活的（每 1~2 秒刷新），
     * slot 宽度会在零点几像素上抖，没有余量就会一直横跳。
     */
    setMaxFit((prev) => {
      if (count === prev) return prev;
      if (count > prev && currentWidth + 8 > targetWidth) return prev;
      return count;
    });
  }, [itemsKey]);

  useLayoutEffect(() => {
    updateFit();
  }, [updateFit]);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const ro = new ResizeObserver(() => {
      updateFit();
    });
    ro.observe(slot);
    return () => ro.disconnect();
  }, [updateFit]);

  const shown = items.slice(0, maxFit);
  const hidden = items.slice(maxFit);

  // FLIP 丝滑过渡动画：当收纳区组件顺序改变被挤过去时，平滑位移过渡
  const prevCmpRects = useRef<Map<string, DOMRect>>(new Map());
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const itemEls = Array.from(bar.querySelectorAll<HTMLElement>('.cmpfav-item[data-cmp-id]'));
    const prev = prevCmpRects.current;

    itemEls.forEach((el) => {
      const id = el.getAttribute('data-cmp-id');
      if (!id) return;
      const newRect = el.getBoundingClientRect();
      const oldRect = prev.get(id);
      if (oldRect) {
        const dx = oldRect.left - newRect.left;
        if (Math.abs(dx) > 1 && !el.classList.contains('is-dragging')) {
          el.style.transform = `translateX(${dx}px)`;
          el.style.transition = 'none';
          requestAnimationFrame(() => {
            el.style.transition = 'transform 200ms cubic-bezier(0.2, 0, 0, 1)';
            el.style.transform = '';
          });
        }
      }
    });

    const nextMap = new Map<string, DOMRect>();
    itemEls.forEach((el) => {
      const id = el.getAttribute('data-cmp-id');
      if (id) nextMap.set(id, el.getBoundingClientRect());
    });
    prevCmpRects.current = nextMap;
    // 依赖条目指纹而不是 items：广播更新面板内容时不该重做位移动画
  }, [itemsKey]);

  const selfShownIndex = draggingComponentId ? shown.findIndex((c) => c.id === draggingComponentId) : -1;
  const isSameBarDrag = selfShownIndex >= 0;
  const insertAt = (() => {
    if (!onBar || typeof barIndex !== 'number') return null;
    if (isSameBarDrag) {
      if (barIndex === selfShownIndex) return null;
      return barIndex < selfShownIndex ? barIndex : barIndex + 1;
    }
    return barIndex;
  })();

  // 下拉收着的时候条目被删到不溢出了，菜单不该留在那儿
  useEffect(() => {
    if (hidden.length === 0) setOpen(false);
  }, [hidden.length]);

  /** 打开那个面板（开着就切过去）—— 入口不消费，这条还在 */
  const openItem = (id: string) => {
    setOpen(false);
    void api.components.create(id);
  };

  /**
   * 按住 = 拖出去，点一下 = 在这儿开一个。
   * 拖动松手后浏览器还会补一个 click，那一下不能算"点" ——
   * 否则拖一次会开两个面板（一个在原处、一个在落点）。
   * 判据就是指针位移：离按下时差得远，就说明刚才是拖着走的。
   */
  const down = useRef<{ x: number; y: number } | null>(null);
  const grabItem = (c: ComponentRef) => (e: React.PointerEvent) => {
    down.current = { x: e.clientX, y: e.clientY };
    onGrab(c.id, c.name, e);
  };
  const clickItem = (c: ComponentRef) => (e: React.MouseEvent) => {
    const d = down.current;
    down.current = null;
    if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
    openItem(c.id);
  };

  return (
    <div ref={slotRef} className="cmpfav-slot">
      <div
        ref={barRef}
        className={`cmpfav${onBar ? ' is-drop' : ''}${active ? ' is-active' : ''}`}
        title={t('收纳区：收进来的面板都挂在这儿 —— 关不关都在；点名字打开那个面板（开着就切过去）。把面板拖到这一段上就是把它收进来。释放/删除在 设置 → 组件')}
      >
        {items.length === 0 && (
          <span className="cmpfav-empty">
            {onBar ? t('松开 → 收进收纳区') : active ? t('拖到这儿 → 收进收纳区') : t('收进来的面板都在这儿；把面板拖进来就行了')}
          </span>
        )}

        {shown.map((c, i) => (
          <React.Fragment key={c.id}>
            {insertAt === i && <span className="cmpfav-drop-slot" />}
            <div
              className={`cmpfav-item${draggingComponentId === c.id ? ' is-dragging' : ''}`}
              data-cmp-id={c.id}
            >
              <button
                className={`cmpfav-name${live.has(c.id) ? ' is-on' : ''}`}
                onPointerDown={grabItem(c)}
                onClick={clickItem(c)}
                title={`${kindName(c.kind)} · ${Math.round(c.bytes / 1024)} KB · ${
                  live.has(c.id)
                    ? t('这个面板开着 —— 点一下切过去；按住拖到布局里就是把它挪过去')
                    : t('点一下打开这个面板（同一段对话接着往下走）；按住拖到布局里，松在哪儿就开在哪儿')
                }`}
              >
                {t(c.name)}
              </button>
            </div>
          </React.Fragment>
        ))}
        {insertAt != null && insertAt >= shown.length && <span className="cmpfav-drop-slot" />}

        {hidden.length > 0 && (
          <div className="cmpfav-more">
            <button className="cmpfav-more-btn" onClick={() => setOpen((v) => !v)} title={t('还有 {n} 个收着的面板', { n: hidden.length })}>
              <IconMoreH />
            </button>
            {open && (
              <>
                <div className="cmpfav-mask" onClick={() => setOpen(false)} />
                <div className="cmpfav-menu">
                  {hidden.map((c) => (
                    <button
                      key={c.id}
                      className={`cmpfav-menu-item${live.has(c.id) ? ' is-on' : ''}`}
                      onPointerDown={(e) => {
                        // 拖出去了菜单就该收掉：松手不会再有 onClick
                        setOpen(false);
                        grabItem(c)(e);
                      }}
                      onClick={clickItem(c)}
                    >
                      <span className="cmpfav-menu-name">{t(c.name)}</span>
                      <span className="cmpfav-menu-kind">{kindName(c.kind)}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 离屏测量容器：与真实渲染类名一致，用于精确探测每个 item 的实际宽度 */}
      <div
        ref={measureRef}
        aria-hidden="true"
        style={{
          position: 'absolute',
          visibility: 'hidden',
          pointerEvents: 'none',
          top: -9999,
          left: -9999,
          display: 'flex',
          gap: 4,
          height: 0,
          overflow: 'hidden',
        }}
      >
        {items.map((c) => (
          <div className="cmpfav-item" key={c.id}>
            <button className="cmpfav-name" tabIndex={-1} type="button">
              {c.name}
            </button>
          </div>
        ))}
        <div className="cmpfav-more">
          <button className="cmpfav-more-btn" tabIndex={-1} type="button">
            <IconMoreH />
          </button>
        </div>
      </div>
    </div>
  );
}
