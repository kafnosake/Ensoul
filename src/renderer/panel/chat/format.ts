/**
 * 对话里到处要用的几个"把数字变成人话"的小函数。
 * 用量、时长、时间在好几处显示，格式必须一致 —— 所以只留这一份。
 */

/** 磁盘上的截图变成能显示的 URL */
export const shotUrl = (p: string) => `file:///${String(p).replace(/\\/g, '/')}`;

export const fmtTokens = (n?: number) =>
  n == null ? '—' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;

export const fmtDur = (ms?: number) => {
  if (ms == null) return '—';
  const s = Math.max(1, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${s}秒`;
};

export const fmtTime = (at?: number) =>
  at ? new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
