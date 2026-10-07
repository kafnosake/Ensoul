import React, { useEffect, useRef, useState } from 'react';
import type { PanelFaceProps } from '../../src/shared/types';

const STATE = '.ensoul/state/semantic-search.json';
const COMMANDS = '.ensoul/semantic-search/commands';
const KINDS = [
  { key: 'documents', label: '文档' },
  { key: 'code', label: '代码' },
  { key: 'history', label: '会话' },
  { key: 'images', label: '图片' },
  { key: 'audio', label: '音频' },
  { key: 'video', label: '视频' },
] as const;
type Kind = (typeof KINDS)[number]['key'];
type Action = 'search' | 'update' | 'cancel' | 'open_source';
type RecordValue = Record<string, unknown>;

interface Snapshot {
  enabled: boolean;
  features: RecordValue;
  runtime: RecordValue;
  index: RecordValue;
  panels: RecordValue;
}

interface SearchHit extends RecordValue {
  score: number;
  source: RecordValue;
}

interface Pending {
  requestId: string;
  action: Action;
  since: number;
}

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseState(value: unknown): Snapshot | null {
  if (!record(value) || typeof value.enabled !== 'boolean' || !record(value.features)
    || !record(value.runtime) || !record(value.index) || !record(value.panels)) return null;
  return { enabled: value.enabled, features: value.features, runtime: value.runtime, index: value.index, panels: value.panels };
}

function parseHits(result: unknown): SearchHit[] | null {
  if (!record(result) || !Array.isArray(result.hits)) return null;
  if (!result.hits.every((hit) => record(hit) && typeof hit.score === 'number'
    && Number.isFinite(hit.score) && record(hit.source))) return null;
  return result.hits as SearchHit[];
}

function timeLabel(value: unknown): string {
  if (typeof value !== 'number' && typeof value !== 'string') return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false });
}

function sourceLabel(hit: SearchHit): string {
  const source = hit.source;
  if (hit.kind === 'history') return string(source.title) || string(source.panelTitle) || string(source.panelId) || '会话';
  const path = string(source.path);
  const line = typeof source.line === 'number' ? source.line : null;
  const page = typeof source.page === 'number' && source.page > 0 ? source.page : null;
  if (path) return `${path}${line && line > 0 ? `:${line}` : ''}${page ? ` · 第 ${page} 页` : ''}`;
  return string(source.title) || string(source.panelTitle) || string(hit.title) || string(source.panelId) || '来源未提供';
}

function statusLabel(value: unknown): string {
  const labels: Record<string, string> = {
    ready: '就绪', idle: '待命', starting: '正在启动', loading: '正在加载',
    running: '运行中', indexing: '正在更新', building: '正在更新', error: '出现错误',
    unavailable: '尚未就绪', disabled: '已关闭', stopped: '已停止', missing: '尚未准备',
    stale: '需要更新', cached: '已缓存', installing: '正在安装', installed: '已安装', encoding: '正在计算',
  };
  return labels[string(value)] || '状态未确认';
}

export default function SemanticSearchPanel({ panel, fs }: PanelFaceProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadMessage, setLoadMessage] = useState('正在读取功能状态…');
  const [readError, setReadError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Kind | ''>('');
  const [media, setMedia] = useState({ image: '', audio: '', video: '' });
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const fsRef = useRef(fs);
  const pendingRef = useRef<Pending | null>(null);
  const readRef = useRef<() => Promise<void>>(async () => {});
  const writingRef = useRef(false);
  fsRef.current = fs;

  useEffect(() => {
    let disposed = false;
    let reading = false;
    let restored = false;
    pendingRef.current = null;
    setPending(null);
    setSnapshot(null);
    setHits([]);
    setSearched(false);
    setReadError('');
    setActionMessage('');
    setActionError('');
    setLoadMessage('正在读取功能状态…');

    const read = async () => {
      if (reading || disposed) return;
      reading = true;
      try {
        const loaded = await fsRef.current.readJson(STATE);
        if (disposed) return;
        if (loaded.status !== 'ready') {
          setSnapshot(null);
          if (loaded.status === 'missing') {
            setReadError('');
            setLoadMessage('功能状态尚未生成，请刷新或检查插件是否启用。');
          } else {
            const reason = loaded.status === 'too_large' ? '状态文件过大' : loaded.error;
            setReadError(`无法读取功能状态：${reason}`);
            setLoadMessage('');
          }
          return;
        }
        const next = parseState(loaded.data);
        if (!next) {
          setSnapshot(null);
          setReadError('功能状态格式不正确，请检查插件状态。');
          setLoadMessage('');
          return;
        }
        setSnapshot(next);
        const permitted = (hit: SearchHit) => next.enabled && next.index.status !== 'stale' && next.features[string(hit.kind)] === true
          && (hit.source.unscoped !== true || next.features.historyArchives === true);
        setHits((previous) => previous.filter(permitted));
        setReadError('');
        setLoadMessage('');
        const savedReply = next.panels[panel.id];
        if (!restored) {
          restored = true;
          if (!pendingRef.current && record(savedReply)) {
            if (savedReply.lastSearch || (savedReply.status === 'done' && savedReply.action === 'search')) {
              const found = parseHits(savedReply.lastSearch || savedReply.result);
              if (found !== null) { setHits(found.filter(permitted)); setSearched(true); }
            }
            if (savedReply.status === 'running' && typeof savedReply.requestId === 'string'
              && ['search', 'update', 'cancel', 'open_source'].includes(string(savedReply.action))) {
              const active: Pending = { requestId: savedReply.requestId, action: savedReply.action as Action, since: Date.now() };
              pendingRef.current = active;
              setPending(active);
            }
          }
        }
        const current = pendingRef.current;
        if (!current) return;
        setElapsed(Math.floor((Date.now() - current.since) / 1000));
        const reply = next.panels[panel.id];
        if (!record(reply) || reply.requestId !== current.requestId) return;
        if (reply.status === 'running') {
          setActionMessage(current.action === 'update' ? '正在更新索引…' : current.action === 'search' ? '正在搜索…' : '正在处理…');
          return;
        }
        if (reply.status !== 'done' && reply.status !== 'error' && reply.status !== 'cancelled') return;
        pendingRef.current = null;
        setPending(null);
        if (reply.status === 'error') {
          setActionError(string(reply.error) || '操作失败，插件未提供原因。');
          setActionMessage('');
        } else if (reply.status === 'cancelled') {
          setActionMessage('已取消。');
        } else if (current.action === 'search') {
          const found = parseHits(reply.result);
          if (found === null) {
            setActionError('搜索结果格式不正确，请检查插件状态。');
            setActionMessage('');
          } else {
            setHits(found.filter(permitted));
            setSearched(true);
            setActionMessage(`找到 ${found.length} 条相关内容。`);
          }
        } else {
          const cancelResult = record(reply.result) ? reply.result.cancelled : undefined;
          setActionMessage(current.action === 'update' ? '索引更新完成。' : current.action === 'cancel'
            ? cancelResult === true ? '已取消。' : cancelResult === false ? '任务已结束，无需取消。' : '取消请求已处理。'
            : '已打开来源。');
        }
      } catch (error) {
        if (!disposed) {
          setSnapshot(null);
          setReadError(`无法读取功能状态：${error instanceof Error ? error.message : String(error)}`);
          setLoadMessage('');
        }
      } finally {
        reading = false;
      }
    };
    readRef.current = read;
    void read();
    const timer = setInterval(() => void read(), 600);
    return () => { disposed = true; clearInterval(timer); };
  }, [panel.id]);

  const submit = async (action: Action, data: RecordValue = {}) => {
    if (writingRef.current) return;
    if (pendingRef.current && action !== 'cancel') return;
    const safePanelId = panel.id.replace(/[^\w.-]+/g, '_');
    if (!safePanelId) { setActionError('无法识别当前面板。'); return; }
    const requestId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const previous = pendingRef.current;
    const current: Pending = { requestId, action, since: Date.now() };
    writingRef.current = true;
    pendingRef.current = current;
    setPending(current);
    setElapsed(0);
    setActionError('');
    setActionMessage('正在提交…');
    try {
      const written = await fsRef.current.write(`${COMMANDS}/${safePanelId}-${requestId}.json`, JSON.stringify({ ...data, requestId, panelId: panel.id, action }));
      if (!written.ok) throw new Error(written.error || '无法保存请求');
      if (pendingRef.current?.requestId === requestId) setActionMessage('等待处理…');
      void readRef.current();
    } catch (error) {
      pendingRef.current = previous;
      setPending(previous);
      setActionMessage('');
      setActionError(`提交失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      writingRef.current = false;
    }
  };

  const enabled = snapshot?.enabled === true;
  const busy = pending !== null;
  const features = snapshot?.features || {};
  const availableKinds = KINDS.filter((item) => features[item.key] === true);
  const selectedKind = availableKinds.some((item) => item.key === kind) ? kind : '';
  const input = Object.fromEntries(Object.entries(media).filter(([key, value]) => value.trim() && features[key === 'image' ? 'images' : key] === true).map(([key, value]) => [key, value.trim()]));
  const canSearch = enabled && !busy && availableKinds.length > 0 && (query.trim() !== '' || Object.keys(input).length > 0);
  const index = snapshot?.index;
  const warnings = Array.isArray(index?.warnings) ? index.warnings.filter((value): value is string => typeof value === 'string') : [];
  const progress = record(index?.progress) ? index.progress : null;
  const completed = progress && typeof progress.completed === 'number' ? progress.completed : null;
  const total = progress && typeof progress.total === 'number' ? progress.total : null;

  return (
    <div className="semantic-search">
      <div className="semantic-search-head">
        <div>
          <h3>语义搜索</h3>
          <p>按含义查找工作区内容</p>
        </div>
        <button type="button" className="semantic-search-btn" onClick={() => void readRef.current()}>刷新</button>
      </div>

      {readError && <div className="semantic-search-notice is-error" role="alert">{readError}</div>}
      {!snapshot && loadMessage && <div className="semantic-search-empty" role="status">{loadMessage}</div>}
      {snapshot && !enabled && <div className="semantic-search-empty"><strong>语义搜索已关闭</strong><span>到设置 → 语义搜索开启，并选择需要的功能。</span></div>}

      {snapshot && enabled && <>
        <div className="semantic-search-overview">
          <div><span>模型</span><strong>{statusLabel(snapshot.runtime.status)}</strong></div>
          <div><span>索引</span><strong>{statusLabel(index?.status)}</strong></div>
          <div><span>内容</span><strong>{typeof index?.items === 'number' ? `${index.items} 条` : '未确认'}</strong></div>
        </div>
        {string(snapshot.runtime.message) && <p className="semantic-search-hint">{string(snapshot.runtime.message)}</p>}
        <div className="semantic-search-index">
          <span>{completed !== null && total !== null && (index?.status === 'indexing' || index?.status === 'building' || index?.status === 'running') ? `更新进度 ${completed} / ${total}` : index?.indexedAt ? `最近更新 ${timeLabel(index.indexedAt)}` : '尚未完成索引更新'}</span>
          <button type="button" className="semantic-search-btn" disabled={busy} onClick={() => void submit('update')}>更新索引</button>
        </div>
        {warnings.length > 0 && <details className="semantic-search-warnings"><summary>索引提醒（{warnings.length}）</summary>{warnings.map((warning, i) => <p key={i}>{warning}</p>)}</details>}
        {availableKinds.length === 0 && <div className="semantic-search-notice">尚未启用内容类型，请在设置中选择文档、代码、会话或媒体。</div>}

        <form className="semantic-search-form" onSubmit={(event) => {
          event.preventDefault();
          if (canSearch) void submit('search', { query: query.trim(), ...(Object.keys(input).length ? { input } : {}), ...(selectedKind ? { kinds: [selectedKind] } : {}), limit: 12 });
        }}>
          <label className="semantic-search-field">
            <span>查找内容</span>
            <textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={3} placeholder="例如：上次讨论面板取消机制时，最后决定怎么做？" />
          </label>
          {(features.images === true || features.audio === true || features.video === true) && <details className="semantic-search-media">
            <summary>用本地图片、音频或视频搜索</summary>
            <p className="semantic-search-hint">填写文件路径，可与上面的描述一起使用。</p>
            {([{ key: 'image', feature: 'images', label: '图片' }, { key: 'audio', feature: 'audio', label: '音频' }, { key: 'video', feature: 'video', label: '视频' }] as const).filter((item) => features[item.feature] === true).map((item) => <label className="semantic-search-field" key={item.key}>
              <span>{item.label}路径</span><input type="text" value={media[item.key]} placeholder={`本地${item.label}文件路径`} onChange={(event) => setMedia((current) => ({ ...current, [item.key]: event.target.value }))} />
            </label>)}
          </details>}
          <div className="semantic-search-controls">
            <label className="semantic-search-filter"><span>范围</span><select value={selectedKind} onChange={(event) => setKind(event.target.value as Kind | '')}><option value="">全部已启用内容</option>{availableKinds.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}</select></label>
            <button className="semantic-search-btn is-primary" type="submit" disabled={!canSearch}>搜索</button>
            {busy && <button className="semantic-search-btn" type="button" disabled={pending.action === 'cancel'} onClick={() => void submit('cancel', { targetRequestId: pending.requestId })}>{pending.action === 'cancel' ? '正在取消' : '取消'}</button>}
          </div>
        </form>
      </>}

      {actionError && <div className="semantic-search-notice is-error" role="alert">{actionError}</div>}
      {actionMessage && <div className="semantic-search-feedback" role="status">{actionMessage}{busy && elapsed >= 15 && <span> 已等待 {elapsed} 秒，尚未收到完成确认。</span>}</div>}
      {searched && hits.length === 0 && <div className="semantic-search-empty">没有找到相关内容。可换个描述，或更新索引后重试。</div>}
      {hits.length > 0 && <div className="semantic-search-results">
        <p className="semantic-search-hint">相似度表示内容接近程度，不是正确概率。</p>
        {hits.map((hit, i) => <article className="semantic-search-hit" key={`${string(hit.id) || sourceLabel(hit)}-${i}`}>
          <div className="semantic-search-hit-head"><strong>{string(hit.title) || sourceLabel(hit)}</strong><span className="semantic-search-score">相似度 {hit.score.toFixed(3)}</span></div>
          <div className="semantic-search-hit-meta"><span>{KINDS.find((item) => item.key === hit.kind)?.label || string(hit.kind) || '内容'}</span>{timeLabel(hit.source.at) && <time>{timeLabel(hit.source.at)}</time>}</div>
          {(string(hit.snippet) || string(hit.text)) && <p className="semantic-search-snippet">{string(hit.snippet) || string(hit.text)}</p>}
          <button type="button" className="semantic-search-source" title={sourceLabel(hit)} disabled={!enabled || busy} onClick={() => void submit('open_source', { hit })}>{sourceLabel(hit)}<span aria-hidden="true">↗</span></button>
        </article>)}
      </div>}
    </div>
  );
}
