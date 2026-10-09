import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../core/api';
import type { DockNode, LayoutPreset, SketchNode, Workspace } from '../../shared/types';
import { IconLayout, IconPlus } from '../ui/icons';
import { t } from '../core/i18n';

/**
 * 顶栏上的**布局切片**控件。
 *
 * 只有两件事，刻意不做第三件：
 *   1. **回到某个布局** —— 点那一格就切过去；
 *   2. **新增一个布局** —— 照**此刻屏幕上的样子**复制一份出来，然后在这一份上改。
 *
 * 于是"切片"就跟虚拟桌面一样好理解：新建 = 拷贝当前，改完自动存回当前那一格，
 * 点别格 = 回去。没有编辑器、没有树形面板、没有命名弹窗。
 *
 * 存哪儿：`.ensoul/state/layout-presets.json`（由宿主解析到固定应用数据目录）。
 * 为什么不让核心管：切片叫什么、存几份、放哪个文件，都是**用它的人**的事。
 * 核心只提供两个原语（api.layout.sketch / apply），它压根不知道有"切片"这回事。
 *
 * 为什么新插件不用改一行就能被记住：骨架里只有 kind / look / spec 这些"样子"，
 * 没有面板名单。插件甲声明了 kind=xxx，它的面板就自动能被存进切片、还原回来。
 */
export function LayoutBar({ ws }: { ws: Workspace | null }) {
  const [open, setOpen] = useState(false);
  const [slices, setSlices] = useState<LayoutPreset[]>([]);
  /** 此刻停在哪一格（空串 = 还没建过任何一格） */
  const [current, setCurrent] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  /** 定时器里要用最新的值 —— 闭包里的 state 是那一刻的旧值 */
  const curRef = useRef('');
  curRef.current = current;
  const slicesRef = useRef<LayoutPreset[]>([]);
  slicesRef.current = slices;

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 正在等存的那一份摆法（指纹）。同一份改动再来广播**不许重置定时器**，
   *  否则对话每流一个字就重置一次，定时器永远等不到 700ms —— 这就是"存不下去"的第二个元凶 */
  const pendingFp = useRef('');
  /**
   * apply 之后刚落成的那一份摆法：它是**我摆的**，别当成"用户改了"又存回去
   * （存回去会把"这一格缺了什么"当成现状写死，那一格就废了）。
   * 空串 = 下一跳不管是什么都先按住。
   */
  const holdFp = useRef<string | null>(null);
  /** 头一次拿到的摆法只是"脚下这份"，不作数 */
  const fingerprintReady = useRef(false);

  // ---------------------------------------------------------------- 读写

  const persist = useCallback(async (next: LayoutPreset[], cur: string) => {
    setSlices(next);
    setCurrent(cur);
    await api.fs.write(FILE, JSON.stringify({ at: Date.now(), current: cur, slices: next }, null, 2));
  }, []);

  /** 把此刻屏幕上的布局存进当前那一格（没有当前格就什么都不做） */
  const saveCurrent = useCallback(async () => {
    const id = curRef.current;
    if (!id) return;
    const [sketch, zoom] = await Promise.all([
      api.layout.sketch(),
      api.ui.getZoom().catch(() => 1),
    ]);
    const sidebar = localStorage.getItem('ensoul_show_monitor') !== 'false';
    const floating = ws?.floating ? JSON.parse(JSON.stringify(ws.floating)) : undefined;
    const widgets = ws?.widgets ? JSON.parse(JSON.stringify(ws.widgets)) : undefined;
    const next = slicesRef.current.map((s) =>
      s.id === id ? { ...s, at: Date.now(), sketch, zoom, sidebar, floating, widgets } : s
    );
    slicesRef.current = next;
    setSlices(next);
    await api.fs.write(FILE, JSON.stringify({ at: Date.now(), current: id, slices: next }, null, 2));
    pendingFp.current = '';
  }, [ws]);

  /** 布局动了 —— 抖一下再存，别在拖拽的每一帧都往磁盘写 */
  const queueSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveCurrent(), 700);
  }, [saveCurrent]);

  // 挂载就读一次；没有这份文件就是"还没建过切片"，一切照旧
  useEffect(() => {
    let alive = true;
    void (async () => {
      const text = await api.fs.read(FILE).catch(() => '');
      if (!alive) return;
      try {
        const j = JSON.parse(text) as { current?: string; slices?: LayoutPreset[] };
        const list = Array.isArray(j?.slices) ? j.slices.filter((s) => s && s.id && s.sketch) : [];
        setSlices(list);
        setCurrent(typeof j?.current === 'string' ? j.current : '');
      } catch {
        /* 读不到 / 不是 JSON：当作第一次用 */
      }
      setReady(true);
    })();
    return () => {
      alive = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // 布局变了就存回当前那一格 —— "在切片的基础上改"就是靠这一条落地的。
  //
  // 判据是**摆法指纹**（形状 + 每格是谁 + 谁在前），不是对象引用：
  // 广播整个 workspace 时 layout 常常是个新对象，但摆法一个字没变 ——
  // 拿引用判会每次都当成"改了"，于是每次广播都重置一次定时器。
  useEffect(() => {
    if (!ws || !ready) return;
    const fp = fingerprint(ws.layout, ws.floating);
    if (!fingerprintReady.current) {
      fingerprintReady.current = true;
      holdFp.current = null; // 头一次拿到的就是脚下这份，不作数
      return;
    }
    if (holdFp.current === null) {
      // 刚 apply 过：这是我自己摆出来的那一跳，按住不存
      holdFp.current = fp;
      return;
    }
    if (holdFp.current !== '' && holdFp.current !== fp) holdFp.current = '';
    if (fp === pendingFp.current) return; // 同一份改动又来了一遍：别动定时器
    if (!curRef.current) return;
    pendingFp.current = fp;
    queueSave();
  }, [ws, ready, queueSave]);

  // ---------------------------------------------------------------- 动作

  const go = async (s: LayoutPreset) => {
    if (busy || s.id === current) return;
    setBusy(true);
    // 按住 apply 之后那一跳：它是我摆的，不是用户改的
    holdFp.current = null;
    // 顺带把"我马上就要到这一格"先落盘 —— 崩在这里也不会两个格子都丢
    curRef.current = s.id;
    setCurrent(s.id);
    if (typeof s.zoom === 'number' && Number.isFinite(s.zoom)) {
      void api.ui.setZoom(s.zoom).catch(() => {});
    }
    if (typeof s.sidebar === 'boolean') {
      window.dispatchEvent(new CustomEvent('ensoul:monitor-set', { detail: s.sidebar }));
    }
    await api.layout.apply(s.sketch, { floating: s.floating, widgets: s.widgets });
    pendingFp.current = '';
    await api.fs.write(FILE, JSON.stringify({ at: Date.now(), current: s.id, slices: slicesRef.current }, null, 2));
    setBusy(false);
  };

  /** 新增：照此刻的样子复制一格出来，并停在它上面 */
  const add = async () => {
    if (busy) return;
    setBusy(true);
    const [sketch, zoom] = await Promise.all([
      api.layout.sketch(),
      api.ui.getZoom().catch(() => 1),
    ]);
    const sidebar = localStorage.getItem('ensoul_show_monitor') !== 'false';
    const floating = ws?.floating ? JSON.parse(JSON.stringify(ws.floating)) : undefined;
    const widgets = ws?.widgets ? JSON.parse(JSON.stringify(ws.widgets)) : undefined;
    const used = new Set(slicesRef.current.map((s) => s.name));
    let n = slicesRef.current.length + 1;
    while (used.has(`布局 ${n}`)) n++;
    const s: LayoutPreset = {
      id: `slice-${Date.now().toString(36)}`,
      name: t('布局 {n}', { n }),
      at: Date.now(),
      sketch,
      zoom,
      sidebar,
      floating,
      widgets,
    };
    const next = [...slicesRef.current, s];
    await persist(next, s.id);
    setBusy(false);
  };

  /** 重命名切片保存 */
  const commitRename = async (id: string, newName: string) => {
    const trimmed = newName.trim();
    setEditingId(null);
    if (!trimmed) return;
    const next = slicesRef.current.map((item) => (item.id === id ? { ...item, name: trimmed } : item));
    await persist(next, current);
  };

  const drop = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = slicesRef.current.filter((s) => s.id !== id);
    const cur = current === id ? (next[0]?.id ?? '') : current;
    pendingFp.current = ''; // 换格子了，脚下这份要重新按当前格子的口径来
    await persist(next, cur);
  };

  return (
    <div className="lb">
      <button
        className={`lb-btn${open ? ' is-on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={t('布局切片：切到另一套摆法，或照现在这套复制一格出来改')}
      >
        <IconLayout />
      </button>

      {open && (
        <>
          <div className="lb-mask" onClick={() => setOpen(false)} />
          <div className="lb-pop">
            <div className="lb-head">{t('布局切片')}</div>

            {slices.map((s) => {
              const on = s.id === current;
              return (
                <button
                  key={s.id}
                  className={`lb-item${on ? ' is-on' : ''}`}
                  disabled={busy}
                  onClick={() => void go(s)}
                  title={on ? `${s.name}（当前）` : `切到 ${s.name}`}
                >
                  <span className="lb-pv">
                    <Preview node={s.sketch} />
                  </span>
                  {editingId === s.id ? (
                    <input
                      className="lb-name-input"
                      value={editingName}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitRename(s.id, editingName);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      onBlur={() => void commitRename(s.id, editingName)}
                    />
                  ) : (
                    <span
                      className="lb-name"
                      title={t('双击改名')}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingId(s.id);
                        setEditingName(s.name);
                      }}
                    >
                      {s.name}
                    </span>
                  )}

                  {on && <span className="lb-badge">{t('当前')}</span>}
                  {slices.length > 1 && (
                    <span className="lb-x" title={t('删掉这一格（布局本身不动）')} onClick={(e) => void drop(s.id, e)}>
                      ✕
                    </span>
                  )}
                </button>
              );
            })}

            {ready && !slices.length && <div className="lb-empty">{t('还没有切片，先照现在的样子存一格')}</div>}

            <button className="lb-add" disabled={busy} onClick={() => void add()} title={t('照现在的样子复制一格出来，然后在这一格上改')}>
              <IconPlus />
              <span>{t('照现在的布局新增一格')}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}


/**
 * 算出一份摆法的**指纹**：形状、槽位包含哪些面板、各组当前切到第几个。
 * 只要指纹变了，就说明屏幕上的布局真被拖动或切标签了；
 * 对话流式输出、标题更新、模型状态变化等不会改变这个串，因此不会重置 700ms 计时器。
 */
function fingerprint(node: DockNode | null | undefined, floating?: Array<{ root: DockNode }>): string {
  if (!node) return '';
  const walk = (n: DockNode): string => {
    if (n.type === 'tabs') {
      return 'T[' + n.active + ':' + (n.panels || []).join(',') + ']';
    }
    if (n.type === 'split') {
      const kids = n.children || [];
      const r = Math.round((Number(n.ratio) || 0.5) * 100);
      return 'S(' + n.direction + ':' + r + '<' + (kids[0] ? walk(kids[0]) : '') + '|' + (kids[1] ? walk(kids[1]) : '') + '>)';
    }
    return '';
  };
  const mainFp = walk(node);
  const floatFp = (floating || []).map((w) => walk(w.root)).join(';');
  return mainFp + (floatFp ? '//' + floatFp : '');
}

/** 切片存哪儿 —— 跟着工作区走，一个项目一套布局 */
const FILE = '.ensoul/state/layout-presets.json';

/**
 * 一格切片的**缩略示意图** —— 直接用骨架画，不截图。
 * 所以拉一格大一点小一点、换台机器，图都跟着准，也不用存任何图片。
 */
function Preview({ node }: { node: SketchNode }) {
  if (!node || (node.type !== 'tabs' && node.type !== 'split')) return <span className="lb-pv-blank" />;
  if (node.type === 'tabs') {
    const n = Math.max(1, Math.min(node.slots?.length ?? 0, 4));
    return (
      <span className={`lb-pv-tabs n${n}`}>
        {Array.from({ length: n }, (_, i) => (
          <i key={i} />
        ))}
      </span>
    );
  }
  const kids = node.children ?? [];
  if (kids.length < 2) return <span className="lb-pv-blank" />;
  const r = Math.max(0.08, Math.min(0.92, Number(node.ratio) || 0.5));
  return (
    <span className={`lb-pv-split ${node.direction === 'column' ? 'col' : 'row'}`}>
      <span style={{ flex: r }}>
        <Preview node={kids[0]} />
      </span>
      <span style={{ flex: 1 - r }}>
        <Preview node={kids[1]} />
      </span>
    </span>
  );
}
