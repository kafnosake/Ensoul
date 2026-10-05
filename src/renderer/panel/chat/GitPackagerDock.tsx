import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Panel } from '../../../shared/types';
import { api } from '../../core/api';

interface AssetItem {
  id: string;
  name: string;
  category: 'core' | 'plugin' | 'component' | 'agent' | 'skill' | 'custom';
  categoryLabel: string;
  path: string;
  files?: string[];
  desc: string;
  excluded: boolean;
  isSelf?: boolean;
  dept?: string;
  isCore?: boolean;
}

interface PackagerSnapshot {
  ok: boolean;
  updatedAt: number;
  summary: {
    total: number;
    included: number;
    excluded: number;
  };
  excludes: string[];
  categories: {
    core?: AssetItem[];
    plugins?: AssetItem[];
    components?: AssetItem[];
    agents?: AssetItem[];
    custom?: AssetItem[];
    skills?: AssetItem[];
  };
}

const STATE_FILE = '.ensoul/state/git-packager.json';
const CMD_FILE = '.ensoul/state/git-packager.cmd.json';

let chain: Promise<void> = Promise.resolve();

function enqueueCmd(payload: Record<string, unknown>) {
  const run = async () => {
    let cmds: unknown[] = [];
    try {
      const text = await api.fs.read(CMD_FILE);
      const j = JSON.parse(text);
      if (Array.isArray(j?.cmds)) cmds = j.cmds;
    } catch {
      cmds = [];
    }
    cmds.push(payload);
    await api.fs.write(CMD_FILE, JSON.stringify({ cmds: cmds.slice(-50) }));
  };
  chain = chain.then(run).catch(() => {});
  return chain;
}

export function GitPackagerDock({ panel }: { panel: Panel }) {
  const isXiaoLin = Boolean(panel.title && panel.title.includes('小林'));
  if (!isXiaoLin) return null;

  const [snap, setSnap] = useState<PackagerSnapshot | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'all' | 'core' | 'plugin' | 'component' | 'agent' | 'custom' | 'skill'>('all');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [addingFeature, setAddingFeature] = useState(false);
  const [featName, setFeatName] = useState('');
  const [featDesc, setFeatDesc] = useState('');
  const [featPaths, setFeatPaths] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const text = await api.fs.read(STATE_FILE);
        if (!alive || !text) return;
        const j = JSON.parse(text);
        if (j && j.ok) setSnap(j);
      } catch {}
    };
    void tick();
    const timer = setInterval(() => void tick(), 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const sendCmd = useCallback(
    (cmd: string, data: Record<string, unknown> = {}) => {
      seq.current += 1;
      const s = Date.now() + (seq.current % 1000);
      void enqueueCmd({ seq: s, panelId: panel.id, cmd, ...data });
    },
    [panel.id],
  );

  const toggleItem = (item: AssetItem) => {
    if (item.isSelf) {
      setNotice('打包台自身已配置自我保护，强制保持排除。');
      setTimeout(() => setNotice(''), 3000);
      return;
    }
    sendCmd('toggle', { id: item.id, excluded: !item.excluded });
  };

  const handleBatch = (exclude: boolean) => {
    sendCmd('batch', { category: activeTab === 'all' ? undefined : activeTab, exclude });
    setNotice(exclude ? '已排除当前分类所有资产' : '已开源当前分类所有资产');
    setTimeout(() => setNotice(''), 3000);
  };

  const handleSync = () => {
    sendCmd('sync');
    setNotice('已同步排除清单至 .gitignore 并移出索引');
    setTimeout(() => setNotice(''), 4000);
  };

  const handleReset = () => {
    sendCmd('reset');
    setNotice('已重置为默认排除状态');
    setTimeout(() => setNotice(''), 3000);
  };

  const handleAddFeatureSubmit = () => {
    if (!featName.trim()) {
      alert('请输入功能名称');
      return;
    }
    const paths = featPaths
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!paths.length) {
      alert('请至少输入一个关联路径');
      return;
    }
    sendCmd('addFeature', {
      name: featName.trim(),
      desc: featDesc.trim(),
      paths,
    });
    setFeatName('');
    setFeatDesc('');
    setFeatPaths('');
    setAddingFeature(false);
    setNotice('已添加功能块「' + featName.trim() + '」');
    setTimeout(() => setNotice(''), 3000);
  };

  const allItems = useMemo(() => {
    if (!snap?.categories) return [];
    return [
      ...(snap.categories.core || []),
      ...(snap.categories.plugins || []),
      ...(snap.categories.components || []),
      ...(snap.categories.agents || []),
      ...(snap.categories.skills || []),
      ...(snap.categories.custom || []),
    ];
  }, [snap]);

  const filteredItems = useMemo(() => {
    let list = allItems;
    if (activeTab !== 'all') {
      list = list.filter((i) => i.category === activeTab);
    }
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((i) => {
        return (
          i.name.toLowerCase().includes(q) ||
          i.id.toLowerCase().includes(q) ||
          (i.desc && i.desc.toLowerCase().includes(q))
        );
      });
    }
    return list;
  }, [allItems, activeTab, query]);

  if (collapsed) {
    const inc = snap?.summary?.included ?? 0;
    const exc = snap?.summary?.excluded ?? 0;
    return (
      <div
        className="git-packager-dock-mini"
        onClick={() => setCollapsed(false)}
        title="展开开源打包台（小林专属：开源范围与排除管理）"
      >
        <span className="mini-icon">📦</span>
        <span className="mini-label">打包台</span>
        <span className="mini-badge">{inc}/{inc + exc}</span>
      </div>
    );
  }

  const summary = snap?.summary || { total: 0, included: 0, excluded: 0 };

  return (
    <div className="git-packager-dock">
      {/* 头部标题与操作 */}
      <div className="packager-dock-head">
        <div className="dock-title-left">
          <span className="dock-title-icon">📦</span>
          <span className="dock-title-text">开源打包台</span>
          <span className="dock-title-sub">勾选排除</span>
        </div>
        <div className="packager-dock-header-actions">
          <button
            className="packager-mini-btn packager-close-btn"
            onClick={() => setCollapsed(true)}
            title="收起为迷你图标"
          >
            收起
          </button>
        </div>
      </div>

      {/* 统计指标条 */}
      <div className="packager-dock-stats">
        <span className="stat-pill">总计 <b>{summary.total}</b></span>
        <span className="stat-pill stat-inc">开源 <b>{summary.included}</b></span>
        <span className="stat-pill stat-exc">排除 <b>{summary.excluded}</b></span>
      </div>

      {/* 提示条 */}
      {notice && <div className="packager-dock-notice">{notice}</div>}

      {/* 分类切换 */}
      <div className="packager-dock-tabs">
        <button
          className={'packager-tab-chip ' + (activeTab === 'all' ? 'active' : '')}
          onClick={() => setActiveTab('all')}
        >
          全部 ({allItems.length})
        </button>
        <button
          className={'packager-tab-chip ' + (activeTab === 'core' ? 'active' : '')}
          onClick={() => setActiveTab('core')}
        >
          本体 ({snap?.categories?.core?.length || 0})
        </button>
        <button
          className={'packager-tab-chip ' + (activeTab === 'component' ? 'active' : '')}
          onClick={() => setActiveTab('component')}
        >
          组件 ({snap?.categories?.components?.length || 0})
        </button>
        <button
          className={'packager-tab-chip ' + (activeTab === 'plugin' ? 'active' : '')}
          onClick={() => setActiveTab('plugin')}
        >
          插件 ({snap?.categories?.plugins?.length || 0})
        </button>
        <button
          className={'packager-tab-chip ' + (activeTab === 'agent' ? 'active' : '')}
          onClick={() => setActiveTab('agent')}
        >
          员工 ({snap?.categories?.agents?.length || 0})
        </button>
        <button
          className={'packager-tab-chip ' + (activeTab === 'skill' ? 'active' : '')}
          onClick={() => setActiveTab('skill')}
        >
          技能 ({snap?.categories?.skills?.length || 0})
        </button>
        <button
          className={'packager-tab-chip ' + (activeTab === 'custom' ? 'active' : '')}
          onClick={() => setActiveTab('custom')}
        >
          自定义 ({snap?.categories?.custom?.length || 0})
        </button>
      </div>

      {/* 搜索与批量操作 */}
      <div className="packager-dock-search-row">
        <input
          type="text"
          className="dock-search-input"
          placeholder="搜索资产或描述..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="dock-link-btn" onClick={() => handleBatch(false)}>
          全部开源
        </button>
        <span className="dock-sep">|</span>
        <button className="dock-link-btn" onClick={() => handleBatch(true)}>
          全部排除
        </button>
      </div>

      {/* 添加功能弹窗 */}
      {addingFeature && (
        <div className="dock-modal-overlay">
          <div className="dock-modal">
            <div className="dock-modal-title">添加自定义功能块</div>
            <input
              type="text"
              className="dock-modal-input"
              placeholder="功能名称（如：自研支付系统）"
              value={featName}
              onChange={(e) => setFeatName(e.target.value)}
            />
            <input
              type="text"
              className="dock-modal-input"
              placeholder="功能说明"
              value={featDesc}
              onChange={(e) => setFeatDesc(e.target.value)}
            />
            <textarea
              className="dock-modal-textarea"
              placeholder="关联路径（一行一个或逗号隔开，如 src/pay/、config/pay.json）"
              value={featPaths}
              onChange={(e) => setFeatPaths(e.target.value)}
              rows={3}
            />
            <div className="dock-modal-actions">
              <button className="dock-btn-sec" onClick={() => setAddingFeature(false)}>
                取消
              </button>
              <button className="dock-btn-pri" onClick={handleAddFeatureSubmit}>
                确定添加
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 资产列表 */}
      <div className="packager-dock-list">
        {filteredItems.map((item) => {
          const isExc = item.excluded;
          return (
            <div
              key={item.id}
              className={'packager-block-card ' + (isExc ? 'is-excluded' : 'is-included')}
              onClick={() => toggleItem(item)}
            >
              <div className="block-card-main">
                <input
                  type="checkbox"
                  className="block-checkbox"
                  checked={!isExc}
                  disabled={item.isSelf}
                  onChange={() => toggleItem(item)}
                  onClick={(e) => e.stopPropagation()}
                />
                <div className="block-card-title-col">
                  <div className="block-card-title-line">
                    <span className={'block-badge badge-' + item.category}>{item.categoryLabel}</span>
                    <span className="block-name" title={item.name}>{item.name}</span>
                    {item.isSelf && <span className="self-tag">🔒自保</span>}
                  </div>
                  {item.desc && <div className="block-desc">{item.desc}</div>}
                </div>
                <div className="block-status-pill">
                  {item.isSelf ? (
                    <span className="pill-text pill-self">不外发</span>
                  ) : isExc ? (
                    <span className="pill-text pill-exc">已排除</span>
                  ) : (
                    <span className="pill-text pill-inc">开源</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {filteredItems.length === 0 && (
          <div className="dock-empty-hint">暂无匹配的功能块。</div>
        )}
      </div>
    </div>
  );
}
