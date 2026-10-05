import { useEffect, useState } from 'react';
import type { PanelNote } from '../../../shared/types';
import { api } from '../../core/api';

/**
 * 便签从哪儿来 —— 读插件写下的那份文件（`.ensoul/state/notes.json`）。
 *
 * 便签已经不是核心的东西了（见 plugins/notes）。界面这边跟任务清单面板一样，
 * 只当一只笨眼睛：每 1.5 秒读一次这个小 JSON，有就显示，没有就当这条对话
 * 还没定下什么事。谁都不用认识谁 —— 插件没装、文件被删，这里什么都不报错，只是空着。
 *
 * 为什么是轮询而不是等插件通知：比"再加一套事件总线"便宜得多，也不会因为
 * 某次通知丢了就永远不刷新。便签是给人长期翻的记录，晚一秒出现无所谓。
 */
const FILE = '.ensoul/state/notes.json';
const TICK_MS = 1500;

/**
 * 从整份 state 里挑出这个面板的那几条。文件坏了、结构不对就当没有，别把面板弄崩。
 *
 * 一条便签 = 用户那句话 + 它下一轮回答里标出来的几条（marks）。老结构（扁平的
 * user/assistant 两行）认不出来就跳过 —— 插件在头一回启动时已经把它迁成新结构了。
 */
function pick(text: string, panelId: string): PanelNote[] {
  try {
    const j = JSON.parse(text);
    const list = j?.panels?.[panelId];
    if (!Array.isArray(list)) return [];
    return list
      .filter((n: any) => n && typeof n.text === 'string' && n.text)
      .map((n: any) => ({
        at: Number(n.at) || 0,
        text: n.text as string,
        marks: Array.isArray(n.marks) ? n.marks.filter((m: any) => typeof m === 'string' && m) : [],
      }));
  } catch {
    return [];
  }
}

export function useNotes(panelId: string): PanelNote[] {
  const [notes, setNotes] = useState<PanelNote[]>([]);

  useEffect(() => {
    let alive = true;
    let last = '';
    const tick = async () => {
      const text = await api.fs.read(FILE);
      if (!alive) return;
      // 内容没变就**不 setState** —— 否则每 1.5 秒白白重渲染一遍这块面板
      // （消息本身是 memo 的，但这一列的外壳和刻度都会跟着走）
      if (text === last) return;
      last = text;
      setNotes(text ? pick(text, panelId) : []);
    };
    void tick();
    const timer = setInterval(() => void tick(), TICK_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [panelId]);

  return notes;
}
