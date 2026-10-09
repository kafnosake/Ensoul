import React, { useRef, useState } from 'react';
import { api } from '../../core/api';
import type { PluginStatusMenu } from '../../../shared/types';

/**
 * 会话框顶上那一块插件状态（git 分支、目标项目……）。
 *
 * 声明了 menu 的可以点开一个小下拉 —— git 那种只是块字，目标项目这种要能当场切。
 * 画在这儿、动作回插件的**设置分区那条老路**（ext:sectionAction）：插件只说菜单里有
 * 哪些项，核心只画一次，不新开界面体系、也不多一条 IPC。
 */
export function HeadStatusChip({ s }: {
  s: { id: string; text: string; title?: string; menu?: PluginStatusMenu };
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ left: 0, top: 0 });
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const btn = useRef<HTMLButtonElement>(null);
  const menu = s.menu;

  if (!menu) return <span className="head-status" title={s.title}>{s.text}</span>;

  const toggle = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setAt({ left: r.left, top: r.bottom + 6 });
    setOpen((v) => !v);
  };

  const fire = async (action: string, row: string) => {
    setBusy(true);
    try {
      await api.ext.sectionAction(menu.plugin, menu.section, action, row);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <>
      <button
        ref={btn}
        className={'head-status head-status-btn' + (open ? ' is-open' : '')}
        title={s.title}
        onClick={toggle}
      >
        {s.text}
        <span className="hs-caret">▾</span>
      </button>
      {open && (
        <>
          <div className="hs-mask" onClick={() => setOpen(false)} />
          <div className="hs-menu" style={{ left: at.left, top: at.top }}>
            <div className="hs-head">{menu.title || s.text}</div>
            {menu.items.map((it, i) => (
              <button
                key={`${it.action}:${it.row}:${i}`}
                className={'hs-item' + (it.on ? ' is-on' : '')}
                disabled={busy}
                onClick={() => void fire(it.action, it.row)}
              >
                <span className="hs-item-label">
                  {it.on ? '● ' : ''}
                  {it.label}
                </span>
                {it.desc && <span className="hs-item-desc">{it.desc}</span>}
              </button>
            ))}
            {menu.manual && (
              <div className="hs-manual">
                <input
                  value={draft}
                  placeholder={menu.manual.placeholder || ''}
                  spellCheck={false}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    const v = draft.trim();
                    if (e.key === 'Enter' && v) {
                      setDraft('');
                      void fire(menu.manual!.actionPrefix + v, menu.manual!.row);
                    }
                  }}
                />
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
