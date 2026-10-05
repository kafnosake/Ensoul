import React from 'react';
import { api } from '../core/api';
import { t } from '../core/i18n';

export function DesktopCreate({ panelId, initial }: { panelId: string; initial: boolean }) {
  const [phase, setPhase] = React.useState<'loading' | 'input' | 'running' | 'closed'>('loading');
  const [mode, setMode] = React.useState<'generate' | 'update'>('generate');
  const [text, setText] = React.useState('');
  const [error, setError] = React.useState('');
  const sending = React.useRef(false);
  const opening = React.useRef(false);
  const input = React.useRef<HTMLTextAreaElement>(null);
  const action = (name: string) => api.ext.sectionAction('widget-dock', 'desktop', name, panelId);
  React.useEffect(() => {
    let active = true;
    void api.fs.read('.ensoul/state/widget-dock.json').then(raw => {
      let draft: { submitted?: boolean; inputOpen?: boolean } = {};
      try { draft = JSON.parse(raw).drafts?.[panelId] || {}; } catch { /* 兼容旧组件。 */ }
      if (!active) return;
      setMode(draft.submitted || !initial ? 'update' : 'generate');
      setPhase((draft.inputOpen ?? (initial && !draft.submitted)) ? 'input' : 'closed');
    }).catch(() => { if (active) { setMode(initial ? 'generate' : 'update'); setPhase(initial ? 'input' : 'closed'); } });
    return () => { active = false; };
  }, [panelId]);

  React.useEffect(() => api.ui.onEditWidget(request => {
    if (request.panelId !== panelId || sending.current || opening.current) return;
    opening.current = true;
    void action('composer:open').then(result => {
      if (!result.ok) throw new Error(result.error || t('无法展开输入框'));
      setMode('update');
      setError('');
      setPhase('input');
      requestAnimationFrame(() => {
        input.current?.focus();
        void action('focusInput').then(focus => { if (!focus.ok) setError(focus.error || t('无法取得键盘焦点')); });
      });
    }).catch(failure => { setError(String(failure instanceof Error ? failure.message : failure)); setPhase('input'); })
      .finally(() => { opening.current = false; });
  }), [panelId]);

  const close = async () => {
    if (sending.current) return;
    const result = await action('composer:close');
    if (result.ok) setPhase('closed');
    else setError(result.error || t('无法收起输入框'));
  };
  const submit = async () => {
    const prompt = text.trim();
    if (!prompt || sending.current) return;
    sending.current = true;
    setError('');
    try {
      setPhase('running');
      const result = await action(`${mode}:${encodeURIComponent(prompt)}`);
      if (!result.ok) throw new Error(result.error || t('无法更新组件'));
      setText('');
      setMode('update');
      setPhase('closed');
    } catch (failure) {
      const state = await api.fs.read('.ensoul/state/widget-dock.json').catch(() => '{}');
      try { if (JSON.parse(state).drafts?.[panelId]?.submitted) setMode('update'); } catch { /* 保留原需求。 */ }
      const reopened = await action('composer:open');
      setError([String(failure instanceof Error ? failure.message : failure), reopened.ok ? '' : reopened.error].filter(Boolean).join(' · '));
      setPhase('input');
    } finally { sending.current = false; }
  };

  if (phase === 'loading' || phase === 'closed') return null;
  if (phase === 'running') return <>
    <div className="desktop-create-progress" role="status" aria-label={t('正在更新组件')} />
    <button className="desktop-create-cancel" type="button" title={t('停止配置，保留组件')} aria-label={t('停止配置，保留组件')} onClick={() => void action('cancelGenerate')}>✕</button>
  </>;
  return <form className="desktop-create" data-desktop-interactive="true" onSubmit={event => { event.preventDefault(); void submit(); }} onContextMenu={event => event.stopPropagation()}>
    <div className="desktop-create-input">
      <textarea ref={input} value={text} onChange={event => setText(event.target.value)} placeholder={t(mode === 'generate' ? '这个组件要做什么？' : '想怎么修改这个组件？')} aria-label={t('组件需求')}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); }
          if (event.key === 'Escape') { event.preventDefault(); void close(); }
        }} />
      <button type="submit" disabled={!text.trim() || sending.current} aria-label={t('提交需求')} title={t('提交需求')}>↑</button>
      <button type="button" className="desktop-create-close" onClick={() => void close()} aria-label={t('收起输入框')} title={t('收起输入框')}>✕</button>
    </div>
    {error && <div className="desktop-create-error" role="alert">{error}</div>}
  </form>;
}
