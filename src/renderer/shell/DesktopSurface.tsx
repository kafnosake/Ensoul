import React from 'react';
import type { Panel } from '../../shared/types';
import { api } from '../core/api';
import { PanelBoundary } from '../panel/PanelBoundary';
import { FitBox } from '../panel/FitBox';
import { panelType, panelTypesRevision, subscribePanelTypes } from '../panel/registry';

/** 桌面只显示功能主体，会话仍由本体中的编辑入口承载。 */
export function DesktopSurface({ panel }: { panel: Panel }) {
  React.useSyncExternalStore(subscribePanelTypes, panelTypesRevision, panelTypesRevision);
  const def = panelType(panel.kind);
  if (panel.kind === 'chat' || !def) return null;

  return (
    <PanelBoundary key={panel.kind} kind={panel.kind} fallback={null}>
      <DesktopBody panel={panel} />
    </PanelBoundary>
  );
}

function DesktopBody({ panel }: { panel: Panel }) {
  return <div className="desktop-content" data-desktop-widget="true" data-panel-id={panel.id}>
    <FitBox>{panelType(panel.kind)?.body({
      panel,
      setText: (text) => void api.panel.patch(panel.id, { spec: { ...panel.spec, text } }),
    })}</FitBox>
  </div>;
}
