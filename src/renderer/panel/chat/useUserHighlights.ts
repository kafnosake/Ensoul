import { useState, useEffect, useCallback } from 'react';

/**
 * 用户划词高亮的本地状态 —— 纯前端个人视觉笔记：
 *   · 只存"哪条消息、文本第几个字符起、多长"，落在 localStorage，
 *     刷新 / 重启都在，会话 JSON 一个字节都不碰（LLM 永远读不到你标了哪）。
 *   · 上色由 CSS Custom Highlight API 完成，消息 DOM 本身零改动 ——
 *     零宽度变化、零断行、零"跨节点被拆成几块"。
 */
export interface UserHighlight {
  id: string;
  msgId: string;
  /** 起点：该条消息 .msg-body 文本（textContent 口径）里的绝对字符偏移 */
  start: number;
  len: number;
  /** 创建时从 DOM 抓的原文 —— 消息内容被改写后按它兜底重新定位 */
  text: string;
}

const STORAGE_KEY = 'ensoul:user_highlights';

function loadAll(): Record<string, UserHighlight[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    // 兼容旧版本数据：早期存的是纯文本数组（string[]）——转成"占位记录"
    //（msgId 空、start -1），由 paint 阶段在真实 DOM 里重新定位后回填，
    // 旧标记一条不丢，也不会因为格式变化把整个面板搞崩。
    const out: Record<string, UserHighlight[]> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!Array.isArray(v)) continue;
      const arr: UserHighlight[] = [];
      v.forEach((item: any, i: number) => {
        if (typeof item === 'string') {
          if (item.trim()) arr.push({ id: `hl-old-${k}-${i}`, msgId: '', start: -1, len: item.length, text: item });
        } else if (
          item && typeof item === 'object' &&
          typeof item.id === 'string' && typeof item.msgId === 'string' &&
          typeof item.start === 'number' && typeof item.len === 'number' &&
          typeof item.text === 'string'
        ) {
          arr.push(item);
        }
      });
      out[k] = arr;
    }
    return out;
  } catch {
    return {};
  }
}

function saveAll(data: Record<string, UserHighlight[]>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {}
}

export function useUserHighlights(panelId: string) {
  const [highlights, setHighlights] = useState<UserHighlight[]>(() => loadAll()[panelId] || []);

  useEffect(() => {
    setHighlights(loadAll()[panelId] || []);
  }, [panelId]);

  const persist = useCallback(
    (next: UserHighlight[]): UserHighlight[] => {
      const all = loadAll();
      all[panelId] = next;
      saveAll(all);
      return next;
    },
    [panelId],
  );

  /** 标记一段文字（位置完全相同则跳过 —— 严禁重复套娃） */
  const addHighlight = useCallback(
    (msgId: string, start: number, len: number, text: string) => {
      setHighlights((prev) => {
        if (prev.some((h) => h.msgId === msgId && h.start === start && h.len === len)) return prev;
        const id = `hl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        return persist([...prev, { id, msgId, start, len, text }]);
      });
    },
    [persist],
  );

  /** 取消一条标记 */
  const removeHighlight = useCallback(
    (id: string) => {
      setHighlights((prev) => persist(prev.filter((h) => h.id !== id)));
    },
    [persist],
  );

  /** paint 阶段定位到真实位置后回填（旧格式迁移 / 消息被改写后的重定位） */
  const migrateHighlights = useCallback(
    (items: { id: string; msgId: string; start: number }[]) => {
      setHighlights((prev) => {
        let changed = false;
        const next = prev.map((h) => {
          const m = items.find((x) => x.id === h.id);
          if (m && (h.msgId !== m.msgId || h.start !== m.start)) {
            changed = true;
            return { ...h, msgId: m.msgId, start: m.start };
          }
          return h;
        });
        return changed ? persist(next) : prev;
      });
    },
    [persist],
  );

  return { highlights, addHighlight, removeHighlight, migrateHighlights };
}
