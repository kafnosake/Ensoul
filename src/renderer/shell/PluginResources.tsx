import React, { useEffect, useRef, useState } from 'react';
import { api } from '../core/api';
import type { PluginSettingsRef, PluginSettingsView } from '../../shared/types';
import { t } from '../core/i18n';

interface PluginResourcesProps {
  sections: PluginSettingsRef[];
}

type ResourceRow = PluginSettingsView['rows'][number];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ResourceSection({ section }: { section: PluginSettingsRef }) {
  const [view, setView] = useState<PluginSettingsView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [actionError, setActionError] = useState('');
  const [reply, setReply] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<{ actionId: string; rowId: string } | null>(null);
  const mounted = useRef(false);
  const acting = useRef(false);
  const revision = useRef(0);

  useEffect(() => {
    mounted.current = true;
    let reading = false;
    let disposed = false;
    const refresh = async () => {
      if (reading || acting.current || disposed) return;
      reading = true;
      const request = ++revision.current;
      try {
        const next = await api.ext.section(section.plugin, section.id);
        if (disposed || request !== revision.current) return;
        setView(next);
        setReply('');
        setFetchError('');
        setLoaded(true);
      } catch (error) {
        if (disposed || request !== revision.current) return;
        setFetchError(errorText(error));
        setLoaded(true);
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      disposed = true;
      mounted.current = false;
      ++revision.current;
      window.clearInterval(timer);
    };
  }, [section.plugin, section.id]);

  const runAction = async (row: ResourceRow, actionId: string) => {
    if (acting.current) return;
    acting.current = true;
    ++revision.current;
    setBusy({ actionId, rowId: row.id });
    setActionError('');
    setReply('');
    const submitted = row.inline === 'text' || row.inline === 'select'
      ? `${actionId}:${drafts[row.id] ?? row.value ?? ''}`
      : actionId;
    try {
      const result = await api.ext.sectionAction(section.plugin, section.id, submitted, row.id);
      if (!mounted.current) return;
      setView(result.view);
      setLoaded(true);
      setFetchError('');
      if (!result.ok || result.error) {
        setActionError(result.error || result.reply || t('操作未完成。'));
      } else {
        setReply(result.reply || '');
        if (row.inline === 'text' || row.inline === 'select') {
          setDrafts((current) => {
            const next = { ...current };
            delete next[row.id];
            return next;
          });
        }
      }
    } catch (error) {
      if (mounted.current) setActionError(errorText(error));
    } finally {
      acting.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  return (
    <div className="more-panel-section">
      <div className="more-section-title">{section.label}</div>
      {section.hint && <div className="more-section-desc">{section.hint}</div>}
      {view?.note && <div className="more-section-desc" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{view.note}</div>}
      {(reply || view?.reply) && ((reply || view?.reply || '').length > 240
        ? <details className="more-section-desc"><summary>{t('查看操作详情')}</summary><pre style={{ maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{reply || view?.reply}</pre></details>
        : <div className="more-feedback-msg" role="status" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{reply || view?.reply}</div>)}
      {(actionError || fetchError) && <div className="more-section-desc" role="alert" style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{actionError || fetchError}</div>}
      <div className="more-cards-list">
        {(view?.rows ?? []).map((row) => (
          <div key={row.id} className="more-card-item" style={{ flexWrap: 'wrap' }}>
            <div className="more-card-main" style={{ flex: '1 1 220px' }}>
              <div className="more-card-head" style={{ flexWrap: 'wrap' }}>
                <span className="more-card-name more-card-title">{row.title}</span>
                {row.meta && <span className="more-card-tag" style={{ overflowWrap: 'anywhere', maxWidth: '100%' }}>{row.meta}</span>}
              </div>
              {row.desc && <div className="more-card-desc" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{row.desc}</div>}
              {row.inline === 'select' && (
                <select aria-label={row.title} className="more-input-field" value={row.value || ''} disabled={Boolean(busy)}
                  onChange={event => {
                    const action = row.actions?.[0]?.id || 'configure';
                    void runAction({ ...row, value: event.target.value }, action);
                  }}>
                  {(row.options ?? []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              )}
              {row.inline === 'text' && (
                <input
                  className="more-input-field"
                  style={{ boxSizing: 'border-box', width: '100%', minWidth: 0, marginTop: 8 }}
                  type="text"
                  aria-label={row.title}
                  value={drafts[row.id] ?? row.value ?? ''}
                  placeholder={row.placeholder || ''}
                  disabled={Boolean(busy)}
                  onChange={(event) => setDrafts((current) => ({ ...current, [row.id]: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                    const action = row.actions?.[0];
                    if (!action) return;
                    event.preventDefault();
                    void runAction(row, action.id);
                  }}
                />
              )}
            </div>
            {row.inline !== 'select' && Boolean(row.actions?.length) && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignSelf: 'center' }}>
                {row.actions?.map((action) => (
                  <button
                    key={action.id}
                    className="more-action-btn"
                    style={{ minWidth: 72, padding: '7px 12px' }}
                    title={action.hint || ''}
                    disabled={Boolean(busy)}
                    onClick={() => void runAction(row, action.id)}
                  >
                    {busy?.rowId === row.id && busy?.actionId === action.id ? t('处理中…') : action.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {!loaded && <div className="more-section-desc">{t('正在读…')}</div>}
        {loaded && !view && !fetchError && <div className="more-section-desc">{t('资源管理暂不可用，请确认对应插件已启用。')}</div>}
        {view && view.rows.length === 0 && <div className="more-section-desc">{view.empty || t('这个分区暂无可下载的资源。')}</div>}
      </div>
    </div>
  );
}

export function PluginResources({ sections }: PluginResourcesProps) {
  return <>{sections.map((section) => <ResourceSection key={JSON.stringify([section.plugin, section.id])} section={section} />)}</>;
}
