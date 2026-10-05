import { useEffect, useState } from 'react';
import type { ChatMessage } from '../../../shared/types';
import { api } from '../../core/api';

/**
 * 历史会话从哪儿来 —— 读插件写下的那份文件（`.ensoul/state/histconv/<面板 id>.json`）。
 *
 * **一块面板一份文件**：界面读文件是整读一次，而 `fs:read` 有个 300 KB 上限
 * （超了只回一句"先不整个读进来"）—— 以前所有面板的历史堆在同一个 JSON 里，
 * 涨过 300 KB 之后这里就再也解析不出东西，左边一条刻度都不显示。
 * 分开之后每块面板只读自己那一份，也不会被别人的大历史拖死。
 *
 * 跟 useNotes 一样的约定：插件每 2 秒扫对话、有变化才落盘，这里每 1.5 秒
 * 当一只笨眼睛读一次，内容没变就不 setState。谁都不用认识谁 —— 插件没装、
 * 文件不在，左边缘那条刻度带只是空着，一个字都不报错。
 */
const DIR = '.ensoul/state/histconv';
/** 界面的动作写这儿（插件每 600ms 取一次）；跟插件那条规则必须一致 */
const CMD = '.ensoul/state/histconv.cmd.json';
const TICK_MS = 1500;

/**
 * 界面要动插件那份账时走这条路：**追加一条命令**，插件取走就清空。
 * 为什么不让界面直接改那份账：界面够不着工作区（只有主进程能读写），而且
 * "删掉第几条"这种判断得有一份权威的账来做 —— 放着插件自己做，界面只管说。
 * seq 一路涨、只认比它大的：插件那边认的是"处理到第几条"，不是"文件里有没有东西"，
 * 于是两边同时写也不会互相吃掉。
 */
let seq = 0;
export type HistCmd =
  | { kind: 'jump'; key: string }
  | { kind: 'branch'; msgId: string; title?: string; switchToBranch?: boolean }
  | { kind: 'rename'; key: string; title: string }
  | { kind: 'remove'; keys: string[] }
  | { kind: 'reorder'; keys: string[] }
  | { kind: 'title'; keys: string[] };

export async function sendHistCmd(panelId: string, cmd: HistCmd): Promise<void> {
  let cmds: unknown[] = [];
  try {
    const raw = await api.fs.read(CMD);
    const j = JSON.parse(raw);
    if (Array.isArray(j?.cmds)) cmds = j.cmds;
  } catch {
    cmds = []; // 没这个文件 / 正在写一半：从空开始，插件那边照旧读得到
  }
  seq += 1;
  cmds.push({ ...cmd, pid: panelId, seq, at: Date.now() });
  // 只留最近几十条：这是"刚刚点的那几下"，不是账本
  await api.fs.write(CMD, JSON.stringify({ cmds: cmds.slice(-40) }));
}

/** 一次已经结束的对话：冻结（闲置）· 压缩前 · 收尾 */
export interface HistEntry {
  key: string;
  why: 'idle' | 'compress' | 'end' | 'branch' | 'active' | string;
  from: number;
  to: number;
  /** 清单里叫什么。模型起的（插件写的）；空串 = 还没起，界面退回显示开头那句 */
  title: string;
  /** 人的名次（拖过排序才有意义）；没拖过就等于 from，于是天然按时间排 */
  ord: number;
  /** 是否是当前面板活跃的会话 */
  isCurrent?: boolean;
  /** 只有用户和助手的正文（工具消息不收，见插件头注） */
  msgs: ChatMessage[];
}

/** 面板 id 变文件名 —— 跟插件那条规则必须一模一样，对不上就是读不到 */
function fileOf(panelId: string): string {
  const safe = String(panelId || '').replace(/[^\w.-]+/g, '_');
  return safe ? `${DIR}/${safe}.json` : '';
}

/** 文件坏了、结构不对就当没有，别把面板弄崩 */
function pick(text: string): HistEntry[] {
  try {
    const j = JSON.parse(text);
    const list = j?.entries;
    const activeKey = typeof j?.activeKey === 'string' ? j.activeKey : '';
    if (!Array.isArray(list)) return [];
    return list
      .filter((e: any) => e && typeof e.key === 'string' && Array.isArray(e.msgs) && e.msgs.length > 0)
      .map((e: any) => ({
        key: String(e.key),
        why: String(e.why || ''),
        from: Number(e.from) || 0,
        to: Number(e.to) || 0,
        title: typeof e.title === 'string' ? e.title : '',
        ord: Number(e.ord) || Number(e.from) || 0,
        isCurrent: Boolean(activeKey && e.key === activeKey),
        msgs: (e.msgs as any[]).filter((m) => m && typeof m.content === 'string') as ChatMessage[],
      }));
  } catch {
    return [];
  }
}

export function useHist(panelId: string): HistEntry[] {
  const [entries, setEntries] = useState<HistEntry[]>([]);

  useEffect(() => {
    let alive = true;
    let last = '';
    const file = fileOf(panelId);
    if (!file) return setEntries([]);
    const tick = async () => {
      const text = await api.fs.read(file);
      if (!alive) return;
      // 内容没变就不 setState —— 否则每 1.5 秒白白重渲染一遍这块面板
      if (text === last) return;
      last = text;
      setEntries(text ? pick(text) : []);
    };
    void tick();
    const timer = setInterval(() => void tick(), TICK_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [panelId]);

  return entries;
}
