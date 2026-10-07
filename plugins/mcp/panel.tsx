import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PanelFaceProps } from '../../src/shared/types';
import { t } from '../../src/renderer/core/i18n';

/**
 * 生态市场 —— 统合仓库的**脸**。
 *
 * 它自己连不了网、也不该连：网上有的东西由主进程拉回来落在
 * `.ensoul/state/mcp.market.json`，这里只管两件事 ——
 *
 *   读那个缓存显示出来（每 2 秒看一次，跑着的抓取一有结果就自己出现）
 *   把用户点的动作写进命令队列（.ensoul/state/mcp.cmd.json），主进程去执行
 *
 * 命令走**队列**格式：{ panelId, seq, cmds: [...] }。单条裸对象会被插件那边
 * 认成"没有 seq"直接跳过 —— 旧的直装按钮就是这么一直没生效的。
 */

const CMD_FILE = '.ensoul/state/mcp.cmd.json';
const CACHE_FILE = '.ensoul/state/mcp.market.json';

interface SkillItem {
  name: string;
  dir: string;
  file: string;
  bytes: number;
  description?: string;
  whenToUse?: string;
}

interface RepoEntry {
  id: string;
  label: string;
  repo: string;
  ref: string;
  url: string;
  builtin?: boolean;
  total: number;
  skills: SkillItem[];
  truncated?: boolean;
  described?: boolean;
  error?: string;
}

interface InstalledSkill {
  id: string;
  name: string;
  description: string;
  group: string;
  dir: string;
  bytes: number;
  repo: string;
  url: string;
}

interface McpItem {
  name: string;
  title: string;
  description: string;
  version: string;
  repository: string;
  remotes: { type: string; url: string }[];
  envNames: { name: string; required: boolean; secret: boolean }[];
  launch: { command: string; args: string[] } | null;
  requiresConfig: boolean;
  updatedAt: string;
}

interface InstalledMcp {
  name: string;
  title: string;
  description: string;
  command: string;
  envNames: { name: string; required: boolean }[];
  status: string;
  tools: number;
  repository: string;
}

interface DiscoverItem {
  repo: string;
  ref: string;
  stars: number;
  description: string;
  topic: string;
  updatedAt: string;
}

interface MarketCache {
  updatedAt?: string;
  skills?: {
    repos?: RepoEntry[];
    sources?: { id: string; label: string; repo: string; builtin?: boolean }[];
    installed?: InstalledSkill[];
    loading?: boolean;
    search?: { mode?: string; query?: string; items?: { repo: string; ref: string; skill: SkillItem | null; stars: number; description: string }[]; error?: string };
    at?: string;
    errors?: { id?: string; repo?: string; error: string }[];
  };
  mcp?: { query?: string; items?: McpItem[]; installed?: InstalledMcp[]; at?: string; error?: string };
  lastAction?: { kind: string; ok: boolean; name?: string; id?: string; files?: number; dir?: string; error?: string; at: string };
  settings?: { allowLlmInstall?: boolean };
  discover?: { items?: DiscoverItem[]; known?: number; errors?: { topic: string; error: string }[]; topics?: string[]; loading?: boolean; error?: string; at?: string };
}

export default function MarketplacePanel({ panel, fs: vfs }: PanelFaceProps) {
  const [tab, setTab] = useState<'skills' | 'mcp' | 'installed'>('skills');
  const [query, setQuery] = useState('');
  const [cache, setCache] = useState<MarketCache>({});
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [addSource, setAddSource] = useState('');
  const seqRef = useRef(Date.now());

  /** 发一条命令给主进程。队列格式，seq 单调递增 —— 插件靠它去重与排序 */
  const send = async (action: string, payload: Record<string, any> = {}) => {
    const seq = ++seqRef.current;
    const body = { panelId: panel.id, seq, cmds: [Object.assign({ action }, payload)] };
    const res = await vfs.write(CMD_FILE, JSON.stringify(body));
    if (res && res.ok === false) setNote('命令没写进去：' + (res.error || '未知原因'));
    return seq;
  };

  const sync = async () => {
    try {
      /*
       * readJson 回的是**快照**（{status:'ready',data} / missing / too_large / invalid），
       * 不是解析好的 JSON。这里以前直接把壳当数据用了：于是 cache.skills 永远是 undefined，
       * 表现成"导航栏都在、按钮点得动、底下一片空白" —— 最难查的那种症状。
       */
      const snap = await vfs.readJson(CACHE_FILE);
      if (snap.status === 'ready') {
        const data = snap.data as MarketCache;
        setCache(data && typeof data === 'object' ? data : {});
        setNote('');
      } else if (snap.status === 'missing') {
        setCache({});
      } else if (snap.status === 'too_large') {
        setNote('缓存文件太大了（' + Math.round(snap.bytes / 1024) + ' KB > ' + Math.round(snap.limit / 1024) + ' KB）—— 面板读不动，去插件参数里把「每个仓库最多列几个技能」调小');
      } else {
        setNote('缓存读不出来：' + (snap.error || snap.status));
      }
    } catch (e: any) {
      /* 还没刷过就是空的，不算错 */
      setNote('缓存读取失败：' + ((e && e.message) || e));
    }
  };

  useEffect(() => {
    void sync();
    const timer = setInterval(() => void sync(), 2000);
    return () => clearInterval(timer);
  }, []);

  // 防抖：搜索关键词交给主进程去查（脸连不了网），结果落回同一个缓存
  const debounce = useRef<any>(null);
  useEffect(() => {
    if (tab === 'installed') return;
    clearTimeout(debounce.current);
    const q = query.trim();
    if (!q && tab === 'mcp') return; // MCP 首屏用缓存里那一份，不用清空重查
    debounce.current = setTimeout(() => {
      void send(tab === 'skills' ? 'market_search_skills' : 'market_search_mcp', { query: q });
    }, 450);
    return () => clearTimeout(debounce.current);
  }, [tab, query]);

  // 动作有结果了给一句话 —— 主进程把结果写在 lastAction 里（脸看不到它的返回值）
  const lastAt = useRef('');
  useEffect(() => {
    const la = cache.lastAction;
    if (!la || !la.at || la.at === lastAt.current) return;
    lastAt.current = la.at;
    if (la.kind === 'skill_install') setNote(la.ok ? '已装载技能：' + (la.name || '') + '（' + (la.files || 0) + ' 个文件 → ' + (la.dir || '') + '）' : '装载失败：' + (la.error || ''));
    else if (la.kind === 'mcp_install') setNote(la.ok ? '已装载 MCP 服务：' + (la.name || '') : '装载失败：' + (la.error || ''));
    else if (la.kind === 'skill_uninstall') setNote(la.ok ? '已卸载：' + (la.id || '') : '卸载失败：' + (la.error || ''));
    else if (la.kind === 'mcp_uninstall') setNote(la.ok ? '已卸载：' + (la.name || '') : '卸载失败：' + (la.error || ''));
    else if (la.kind === 'skill_source_add') setNote(la.ok ? '已加上源：' + (la.name || '') : '加源失败：' + (la.error || ''));
    setBusy('');
  }, [cache]);

  const skillRepos = cache.skills?.repos || [];
  const installedSkills = cache.skills?.installed || [];
  const mcpItems = cache.mcp?.items || [];
  const installedMcp = cache.mcp?.installed || [];
  const sources = cache.skills?.sources || [];
  const search = cache.skills?.search;
  const searching = tab === 'skills' && !!query.trim() && !!search;

  const filteredRepos = useMemo<RepoEntry[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skillRepos;
    return skillRepos
      .map((r) => Object.assign({}, r, {
        skills: (r.skills || []).filter((s) =>
          (s.name + ' ' + (s.description || '') + ' ' + (s.whenToUse || '')).toLowerCase().includes(q)),
      }))
      .filter((r) => r.skills.length > 0 || (r.repo || '').toLowerCase().includes(q));
  }, [skillRepos, query]);

  const installSkill = async (repo: string, ref: string, skill: SkillItem) => {
    setBusy('install:' + repo + '/' + skill.dir);
    setNote('');
    await send('skill_install', { repo, ref, path: skill.dir, name: skill.name, group: repo.replace('/', '__') });
  };

  const uninstallSkill = async (id: string) => {
    if (!confirm('把「' + id + '」整个目录删掉？')) return;
    setBusy('uninstall:' + id);
    await send('skill_uninstall', { id });
  };

  const installMcp = async (item: McpItem) => {
    setBusy('mcp:' + item.name);
    setNote('');
    await send('mcp_install', { name: item.name, alias: item.title });
  };

  const uninstallMcp = async (name: string) => {
    if (!confirm('卸掉 MCP 服务「' + name + '」？配置和出厂记录一起删。')) return;
    setBusy('mcpdel:' + name);
    await send('mcp_uninstall', { name });
  };

  const addSourceSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = addSource.trim();
    if (!raw) return;
    setBusy('src');
    setNote('');
    await send('skill_source_add', { repo: raw, label: raw });
    setAddSource('');
  };

  const refreshedAt = (cache.skills?.at || cache.updatedAt || '').replace('T', ' ').slice(0, 19);
  const isInstalledSkill = (repo: string, name: string) =>
    installedSkills.some((s) => s.repo === repo && (s.name === name || s.id.endsWith('/' + name)));

  return (
    <div className="eco-root">
      <div className="eco-nav">
        <div className="eco-tabs">
          <button className={'eco-tab ' + (tab === 'skills' ? 'is-active' : '')} onClick={() => setTab('skills')}>
            技能仓库 ({skillRepos.reduce((n, r) => n + (r.total || 0), 0)})
          </button>
          <button className={'eco-tab ' + (tab === 'mcp' ? 'is-active' : '')} onClick={() => setTab('mcp')}>
            MCP 服务 ({mcpItems.length})
          </button>
          <button className={'eco-tab ' + (tab === 'installed' ? 'is-active' : '')} onClick={() => setTab('installed')}>
            已装载 ({installedSkills.length + installedMcp.length})
          </button>
        </div>

        <div className="eco-actions">
          <span className="eco-stamp">
            {cache.skills?.loading ? '正在联网拉取技能…' : (refreshedAt ? '联网更新于 ' + refreshedAt : '还没联网拉过')}
          </span>
          <label className="eco-switch" title={t('打开后助手能自己从网上装技能和 MCP 服务；关着它就只能查、不能装')}>
            <input
              type="checkbox"
              checked={!!cache.settings?.allowLlmInstall}
              onChange={(e) => void send('market_set_param', { key: 'allowLlmInstall', value: e.target.checked })}
            />
            <span>允许助手自行装载</span>
          </label>
          <button className="eco-btn" onClick={() => void send('market_refresh')} title={t('去网上重新拉一遍')}>
            联网更新
          </button>
          <button className="eco-btn" onClick={() => void send('market_discover')} title={t('按 GitHub 主题搜一遍全网还有哪些技能库')}>
            自动找源
          </button>
        </div>
      </div>

      {tab !== 'installed' && (
        <div className="eco-toolbar">
          <input
            className="eco-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === 'skills'
              ? '搜技能（在已加的源里筛；也可以搜 GitHub 上的新仓库）…'
              : '搜 MCP 官方注册表（github / postgres / filesystem …）…'}
          />
          {tab === 'skills' && (
            <form className="eco-addsrc" onSubmit={addSourceSubmit}>
              <input
                className="eco-input eco-input-sm"
                value={addSource}
                onChange={(e) => setAddSource(e.target.value)}
                placeholder="加一个技能源：owner/repo 或 GitHub 链接"
              />
              <button className="eco-btn" type="submit">加源</button>
            </form>
          )}
        </div>
      )}

      {note && <div className="eco-note">{note}</div>}

      <div className="eco-body">
        {tab === 'skills' && (
          <div className="eco-pane">
            {sources.length > 0 && (
              <div className="eco-sources">
                {sources.map((s) => (
                  <span key={s.id} className={'eco-chip' + (s.builtin ? '' : ' is-user')}>
                    {s.label || s.repo}
                    {!s.builtin && (
                      <button className="eco-chip-x" title={t('去掉这个源')} onClick={() => void send('skill_source_remove', { id: s.id })}>×</button>
                    )}
                  </span>
                ))}
              </div>
            )}

            {searching && (
              <div className="eco-block">
                <div className="eco-block-head">
                  <strong>GitHub 搜索：{search?.query || ''}</strong>
                  <span className="eco-dim">{search?.mode === 'code' ? '按技能命中' : '按仓库命中'} · {search?.items?.length || 0} 条</span>
                </div>
                {search?.error && <div className="eco-err">{search.error}</div>}
                {(search?.items || []).map((it) => (
                  <div key={it.repo + (it.skill?.dir || '')} className="eco-row">
                    <div className="eco-row-main">
                      <div className="eco-row-title">
                        {it.repo}
                        {it.skill && <span className="eco-tag">{it.skill.name}</span>}
                      </div>
                      <div className="eco-row-desc">{it.description || ''}</div>
                    </div>
                    <div className="eco-row-side">
                      <span className="eco-dim">★ {it.stars}</span>
                      {it.skill ? (
                        <button className="eco-btn is-primary" disabled={!!busy} onClick={() => void installSkill(it.repo, it.ref, it.skill!)}>
                          装载
                        </button>
                      ) : (
                        <span className="eco-dim">看仓库里有什么，再决定装哪一份</span>
                      )}
                      <button className="eco-btn" disabled={!!busy} onClick={() => void send('skill_source_add', { repo: it.repo, label: it.repo })}>
                        加为源
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {(cache.discover?.items?.length || cache.discover?.loading) && (
              <div className="eco-block">
                <div className="eco-block-head">
                  <strong>发现到的技能库</strong>
                  <span className="eco-dim">
                    {cache.discover?.loading ? '正在按主题搜索…' : '按 GitHub 主题搜到的，加为源就会去抓它的技能'}
                  </span>
                </div>
                {cache.discover?.error && <div className="eco-err">{cache.discover.error}</div>}
                {(cache.discover?.items || []).map((d) => (
                  <div key={d.repo} className="eco-row">
                    <div className="eco-row-main">
                      <div className="eco-row-title">
                        {d.repo}
                        <span className="eco-tag">{d.topic}</span>
                        <span className="eco-dim">★ {d.stars}</span>
                      </div>
                      <div className="eco-row-desc">{d.description || ''}</div>
                    </div>
                    <div className="eco-row-side">
                      <button className="eco-btn is-primary" disabled={!!busy} onClick={() => void send('skill_source_add', { repo: d.repo, label: d.repo, ref: d.ref })}>
                        加为源
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!searching && filteredRepos.length === 0 && (
              <div className="eco-empty">
                还没有拉到技能。点右上角「联网更新」去 GitHub 抓一遍；
                也可以在下面加一个仓库当源。
              </div>
            )}

            {!searching && filteredRepos.map((r) => (
              <div key={r.id} className="eco-block">
                <div className="eco-block-head">
                  <strong>{r.label || r.repo}</strong>
                  <span className="eco-dim">{r.repo} · {r.total} 份{r.ref ? ' · ' + r.ref : ''}</span>
                  {r.url && <a className="eco-link" href={r.url} target="_blank" rel="noreferrer">仓库</a>}
                  {!r.described && r.total > 0 && (
                    <button className="eco-btn eco-btn-xs" disabled={!!busy} onClick={() => void send('market_describe_repo', { id: r.id, repo: r.repo })}>
                      抓说明
                    </button>
                  )}
                </div>
                {r.error && <div className="eco-err">{r.error}</div>}
                {(r.skills || []).map((s) => {
                  const key = r.id + '/' + s.dir;
                  const open = selected === key;
                  const done = isInstalledSkill(r.repo, s.name);
                  return (
                    <div key={key} className={'eco-row' + (open ? ' is-open' : '')}>
                      <div className="eco-row-main" onClick={() => setSelected(open ? '' : key)}>
                        <div className="eco-row-title">
                          {s.name}
                          {done && <span className="eco-tag is-ok">已装</span>}
                          {s.bytes > 0 && <span className="eco-dim">{(s.bytes / 1024).toFixed(1)} KB</span>}
                        </div>
                        <div className="eco-row-desc">{s.description || s.dir}</div>
                        {open && s.whenToUse && <div className="eco-row-when">什么时候用：{s.whenToUse}</div>}
                      </div>
                      <div className="eco-row-side">
                        <button
                          className={'eco-btn' + (done ? '' : ' is-primary')}
                          disabled={!!busy}
                          onClick={() => void installSkill(r.repo, r.ref, s)}
                        >
                          {done ? '重装' : '装载'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {tab === 'mcp' && (
          <div className="eco-pane">
            {cache.mcp?.error && <div className="eco-err">注册表读不出来：{cache.mcp.error}</div>}
            {mcpItems.length === 0 && !cache.mcp?.error && (
              <div className="eco-empty">注册表里没拉到东西。换个关键词，或点右上角「联网更新」。</div>
            )}
            {mcpItems.map((m) => (
              <div key={m.name} className="eco-row">
                <div className="eco-row-main">
                  <div className="eco-row-title">
                    {m.title || m.name}
                    {m.version && <span className="eco-tag">v{m.version}</span>}
                    {!m.launch && <span className="eco-tag is-warn">只有远程地址</span>}
                    {m.requiresConfig && <span className="eco-tag is-warn">要配密钥</span>}
                  </div>
                  <div className="eco-row-desc">{m.description}</div>
                  <div className="eco-row-when">
                    {m.name}
                    {m.launch ? ' · ' + m.launch.command + ' ' + (m.launch.args || []).join(' ') : ''}
                  </div>
                  {m.envNames && m.envNames.length > 0 && (
                    <div className="eco-row-when">
                      环境变量：{m.envNames.map((v) => v.name + (v.required ? '*' : '')).join('、')}
                    </div>
                  )}
                </div>
                <div className="eco-row-side">
                  {m.repository && <a className="eco-link" href={m.repository} target="_blank" rel="noreferrer">仓库</a>}
                  <button className="eco-btn is-primary" disabled={!m.launch || !!busy} onClick={() => void installMcp(m)}>
                    装载
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'installed' && (
          <div className="eco-pane">
            <div className="eco-block">
              <div className="eco-block-head">
                <strong>已装载的技能</strong>
                <span className="eco-dim">{installedSkills.length} 份 · 装在 .ensoul/skills/，当轮就能 use_skill 取用</span>
              </div>
              {installedSkills.length === 0 && <div className="eco-empty">还没装技能。</div>}
              {installedSkills.map((s) => (
                <div key={s.id} className="eco-row">
                  <div className="eco-row-main">
                    <div className="eco-row-title">{s.name}<span className="eco-tag">{s.group}</span></div>
                    <div className="eco-row-desc">{s.description || s.dir}</div>
                  </div>
                  <div className="eco-row-side">
                    <button className="eco-btn is-danger" onClick={() => void uninstallSkill(s.id)}>卸载</button>
                  </div>
                </div>
              ))}
            </div>

            <div className="eco-block">
              <div className="eco-block-head">
                <strong>已装载的 MCP 服务</strong>
                <span className="eco-dim">{installedMcp.length} 个 · 只列生态市场装的，手工加的不在这儿</span>
              </div>
              {installedMcp.length === 0 && <div className="eco-empty">还没装 MCP 服务。</div>}
              {installedMcp.map((m) => (
                <div key={m.name} className="eco-row">
                  <div className="eco-row-main">
                    <div className="eco-row-title">
                      <span className={'eco-dot dot-' + m.status} />
                      {m.name}
                      {m.tools > 0 && <span className="eco-tag">{m.tools} 个工具</span>}
                    </div>
                    <div className="eco-row-desc">{m.description || m.command}</div>
                    {m.envNames.filter((v) => v.required).length > 0 && (
                      <div className="eco-row-when">还缺环境变量：{m.envNames.filter((v) => v.required).map((v) => v.name).join('、')}</div>
                    )}
                  </div>
                  <div className="eco-row-side">
                    <button className="eco-btn is-danger" onClick={() => void uninstallMcp(m.name)}>卸载</button>
                  </div>
                </div>
              ))}
            </div>

            <div className="eco-block">
              <div className="eco-block-head"><strong>连上来的服务</strong>
                <span className="eco-dim">进程与工具的开关在 设置 → MCP 服务 那一页</span>
              </div>
              <div className="eco-empty">这块面板只管装载与卸载；连接状态与工具清单去设置页看。</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
