import React from 'react';
import type { PanelWidget, Rect } from '../../shared/types';
import { api } from '../core/api';

export function DesktopGlass({ panelId, box }: { panelId: string; box: PanelWidget }) {
  const [material, setMaterial] = React.useState<{ image: string | null; displays: Rect[]; dimensions: { width: number; height: number } } | null>(null);
  const [zoom, setZoom] = React.useState(1);
  React.useEffect(() => {
    let active = true;
    void api.ext.sectionAction('widget-dock', 'desktop', 'glass', panelId).then(result => {
      if (active && result.ok && result.reply) {
        try { setMaterial(JSON.parse(result.reply)); } catch { /* 使用透明底色。 */ }
      }
    });
    void api.ui.getZoom().then(value => { if (active) setZoom(value); });
    const off = api.ui.onZoom(setZoom);
    return () => { active = false; off(); };
  }, [panelId]);
  if (!material?.image) return null;
  const display = material.displays.find(d => box.x + box.width / 2 >= d.x && box.x + box.width / 2 < d.x + d.width && box.y + box.height / 2 >= d.y && box.y + box.height / 2 < d.y + d.height) || material.displays[0];
  if (!display || !material.dimensions) return null;
  const fill = Math.max(display.width / material.dimensions.width, display.height / material.dimensions.height);
  const width = material.dimensions.width * fill;
  const height = material.dimensions.height * fill;
  return <div className="desktop-glass" aria-hidden="true"><div style={{
    backgroundImage: `url("${material.image}")`,
    backgroundSize: `${width / zoom}px ${height / zoom}px`,
    backgroundPosition: `${(display.x - box.x + (display.width - width) / 2) / zoom + 24}px ${(display.y - box.y + (display.height - height) / 2) / zoom + 24}px`,
  }} /></div>;
}
