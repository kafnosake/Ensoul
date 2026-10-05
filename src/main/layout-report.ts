import type { DockNode, WorkspaceFull } from '../shared/types';
import { isTabGroup } from '../shared/types';
import { windows } from './windows';
import { t } from '../shared/i18n';

/**
 * 把当前布局讲成一段话 —— **不截图、不看图**，直接说清楚界面现在长什么样。
 *
 * 为什么需要它：助手改的是代码，而用户面对的是屏幕。两边描述的是同一个软件，
 * 但助手永远看不到后者 —— 于是它只能在脑子里猜"用户说的那个面板在哪一块"。
 * 这个接口就是把那半边补上：有哪些窗口、谁跟谁并排、比例多少、哪个正显示着、
 * 哪些浮着、哪些挂在别人身上，全是现成的结构化信息，一个像素都不用读。
 *
 * 纯读取，不改任何状态。
 */

const pct = (n: number) => `${Math.round(n * 100)}%`;

function walk(node: DockNode, ws: WorkspaceFull, depth: number, out: string[]): void {
  const pad = '  '.repeat(depth);

  if (isTabGroup(node)) {
    const panels = node.panels.map((id) => ws.panels[id]).filter(Boolean);
    out.push(`${pad}标签组：${panels.length} 个标签`);
    for (const p of panels) {
      const on = p.id === node.active ? '▸' : ' ';
      const msgs = p.chat.filter((m) => m.role !== 'system').length;
      const bits = [`${on} ${p.title}`, `[${p.kind}]`];
      if (msgs) bits.push(`${msgs} 条对话`);
      if (p.float) bits.push(t('（悬浮中）'));
      if (p.revisions.length) bits.push(`${p.revisions.length} 个历史版本`);
      out.push(`${pad}  ${bits.join('  ')}`);
    }
    return;
  }

  out.push(`${pad}${node.direction === 'row' ? '左右分' : '上下分'}  ${pct(node.ratio)} / ${pct(1 - node.ratio)}`);
  walk(node.children[0], ws, depth + 1, out);
  walk(node.children[1], ws, depth + 1, out);
}

export function describeLayout(ws: WorkspaceFull): string {
  const out: string[] = [];

  const main = windows.boundsOf('main');
  out.push(
    `【主窗口】${main ? `${main.width}×${main.height}，左上角 (${main.x}, ${main.y})` : '（还没建起来）'}`,
  );
  walk(ws.layout, ws, 1, out);

  out.push('');
  out.push(`【浮窗】${ws.floating.length} 个`);
  for (const w of ws.floating) {
    const b = windows.boundsOf(w.id);
    const where = b ? `${b.width}×${b.height}，左上角 (${b.x}, ${b.y})` : t('（窗口还没建起来）');
    const owner = w.parent ? `挂在${w.parent === 'main' ? '主窗口' : '别的浮窗'}上` : t('独立');
    out.push(`- ${where}  ${owner}`);
    walk(w.root, ws, 1, out);
  }

  const floats = Object.values(ws.panels).filter((p) => p.float);
  out.push('');
  out.push(`【悬浮小窗】${floats.length} 个`);
  for (const p of floats) {
    const f = p.float!;
    out.push(
      `- ${p.title} [${p.kind}]  浮在${f.host === 'main' ? '主窗口' : '某个浮窗'}的某块区域上，` +
        `位置 横 ${Math.round(f.rx * 100)}% / 纵 ${Math.round(f.ry * 100)}%，` +
        t('大小 {w}×{h}', { w: Math.round(f.width), h: Math.round(f.height) }),
    );
  }

  return out.join('\n');
}
