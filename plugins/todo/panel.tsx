import React from 'react';
import type { PanelFaceProps } from '../../src/shared/types';

/**
 * 任务清单面板 —— 读的是插件写下的那份清单（`.ensoul/state/todo.json`）。
 *
 * 清单**一个面板一份**：这块面板有清单就显示自己的；自己没有（清单多半是别处的对话
 * 写下的）就退一步显示最近更新的那一份，并在头上写明这是谁写的 ——
 * 显示别人的东西可以，但不能让人以为是自己的。
 *
 * 为什么用文件当接口，而不是再开一条 IPC：清单本来就是"这个项目的一件事"，
 * 落在工作区里、插件和界面都能直接读，谁都不用认识谁。面板不需要知道
 * todo 插件是否存在 —— 没有那个文件就显示"还没写清单"。
 *
 * 面板自己会轮询（1.5 秒一次、读一个小 JSON）。这是刻意的笨办法：
 * 比"为它加一套事件总线"便宜得多，也不会因为某次通知丢了就永远不刷新。
 */

interface Item {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

interface Entry {
  items: Item[];
  at?: number;
  title?: string;
}

interface Shown {
  items: Item[];
  at: number;
  /** 显示的是别人的清单时，那份清单属于谁（自己的清单这里是空的） */
  owner: string;
}

const FILE = '.ensoul/state/todo.json';

function parse(text: string, panelId: string): Shown | null {
  try {
    const j = JSON.parse(text);
    // 老格式（插件还没搬过的那一份）：顶层就是清单，按自己的看
    if (Array.isArray(j?.items)) return { items: j.items as Item[], at: Number(j.at) || 0, owner: '' };

    const panels: Record<string, Entry> = j?.panels && typeof j.panels === 'object' ? j.panels : {};
    const mine = panels[panelId];
    if (mine && Array.isArray(mine.items) && mine.items.length) {
      return { items: mine.items, at: Number(mine.at) || 0, owner: '' };
    }
    const other = panels[String(j?.active || '')];
    if (other && Array.isArray(other.items) && other.items.length) {
      return { items: other.items, at: Number(other.at) || 0, owner: other.title || t('另一块面板') };
    }
    return null;
  } catch {
    return null;
  }
}

export default function TodoPanel({ panel, fs }: PanelFaceProps) {
  const [state, setState] = React.useState<Shown | null>(null);
  const [missing, setMissing] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    const tick = async () => {
      const text = await fs.read(FILE);
      if (!alive) return;
      const parsed = parse(text, panel.id);
      setState(parsed);
      setMissing(!parsed);
    };
    void tick();
    const timer = setInterval(() => void tick(), 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [panel.id]);

  const items = state?.items ?? [];
  const done = items.filter((t) => t.status === 'completed').length;
  const doing = items.filter((t) => t.status === 'in_progress').length;

  if (missing || !items.length) {
    return (
      <div className="body-blank">
        <div className="blank-title">{panel.title || t('任务清单')}</div>
        <div className="blank-note">
          还没有清单。多步的活让助手先写一份（它动手前用 <code>todo_write</code>{t('写），')}
          {t('清单会一直摆在它面前，也就不会再忘掉自己做到第几步了。')}
        </div>
      </div>
    );
  }

  return (
    <div className="todo-panel">
      <div className="todo-head">
        <span className="todo-count">
          {done} / {items.length} 完成
        </span>
        {doing > 0 && <span className="todo-doing">{t('正在做')}{doing} 件</span>}
        <span className="todo-when">
          {state?.owner ? `（${state.owner} 的清单）` : ''}
          {state?.at ? `更新于 ${new Date(state.at).toLocaleTimeString('zh-CN')}` : ''}
        </span>
      </div>
      <div className="todo-bar">
        <i style={{ width: `${items.length ? Math.round((done / items.length) * 100) : 0}%` }} />
      </div>
      <ul className="todo-list">
        {items.map((t, i) => (
          <li key={i} className={`todo-item is-${t.status}`}>
            <span className="todo-mark">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'}</span>
            <span className="todo-text">{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
