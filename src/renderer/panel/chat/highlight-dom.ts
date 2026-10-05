/**
 * 用户高亮的 DOM 工具 —— 全程只读，绝不改写消息 DOM：
 *   · 量偏移：文本流里第 N 个字符在哪；
 *   · 换 Range：把 [start, start+len) 变成一个跨节点也连续的 Range；
 *   · 上色：交给 CSS Custom Highlight（::highlight(user-note-mark)），
 *     浏览器自己画底色，不插入任何标签 —— 宽度、断行、结构全都纹丝不动。
 *
 * 多个对话面板共用 document 级注册表，所以这里按面板分份额维护、合并刷新。
 */

const shares = new Map<string, Range[]>();

/** root 文本里到 (node, offset) 为止的纯文本字符数；找不到返回 -1 */
export function absOffset(root: Node, node: Node, offset: number): number {
  let acc = 0;
  let found = false;

  const subtreeLen = (n: Node): number => {
    if (n.nodeType === Node.TEXT_NODE) return (n as Text).length;
    let s = 0;
    const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
    let t: Node | null;
    while ((t = w.nextNode())) s += (t as Text).length;
    return s;
  };

  const walk = (n: Node): void => {
    if (found) return;
    if (n === node) {
      if (n.nodeType === Node.TEXT_NODE) {
        acc += Math.min(offset, (n as Text).length);
      } else {
        for (const k of Array.from(n.childNodes).slice(0, offset)) acc += subtreeLen(k);
      }
      found = true;
      return;
    }
    if (n.nodeType === Node.TEXT_NODE) {
      acc += (n as Text).length;
      return;
    }
    for (const c of Array.from(n.childNodes)) {
      walk(c);
      if (found) return;
    }
  };

  walk(root);
  return found ? acc : -1;
}

/** 把 root 文本里的 [start, start+len) 换算成一个连续 Range（跨节点也是一整段） */
export function makeRange(root: Node, start: number, len: number): Range | null {
  if (len <= 0) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let sNode: Text | null = null;
  let sOff = 0;
  let eNode: Text | null = null;
  let eOff = 0;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    const next = acc + t.length;
    if (!sNode && start >= acc && start <= next) {
      sNode = t;
      sOff = start - acc;
    }
    if (start + len <= next) {
      eNode = t;
      eOff = start + len - acc;
      break;
    }
    acc = next;
  }
  if (!sNode || !eNode) return null;
  const r = document.createRange();
  r.setStart(sNode, Math.max(0, Math.min(sOff, sNode.length)));
  r.setEnd(eNode, Math.max(0, Math.min(eOff, eNode.length)));
  return r;
}

function flush() {
  const CSSH = (CSS as any).highlights;
  const H = (window as any).Highlight;
  if (!CSSH || !H) return;
  const all: Range[] = [];
  for (const rs of shares.values()) all.push(...rs);
  CSSH.set('user-note-mark', all.length > 0 ? new H(...all) : new H());
}

export interface PaintMigration {
  id: string;
  msgId: string;
  start: number;
}

/**
 * 把某个面板的高亮记录画到屏幕上，并返回需要回填的定位迁移清单：
 *   · 正常记录：按消息 id + 偏移直接定位；内容被改写过则按原文兜底重找；
 *   · 旧版只有文本的记录（msgId 为空）：在当前可见消息里全文扫描定位。
 * 两步都找不到（那段文字已经不存在）就跳过 —— 不画、不崩。
 */
export function paintHighlights(
  key: string,
  root: HTMLElement | null,
  list: { id: string; msgId: string; start: number; len: number; text: string }[],
): PaintMigration[] {
  const ranges: Range[] = [];
  const migrations: PaintMigration[] = [];
  if (root) {
    const msgBodies = (msgEl: Element): HTMLElement =>
      (msgEl.querySelector('.msg-body') as HTMLElement) || (msgEl as HTMLElement);
    for (const h of list) {
      if (h.len <= 0 || !h.text) continue;
      let target: Element | null = null;
      let start = -1;

      // ① 按记录的消息 id 直接定位
      if (h.msgId) {
        const escaped = h.msgId.replace(/["\\]/g, '\\$&');
        const msgEl = root.querySelector(`[data-msg-id="${escaped}"]`);
        if (msgEl) {
          const tc = msgBodies(msgEl).textContent || '';
          if (tc.slice(h.start, h.start + h.len) === h.text) {
            target = msgEl;
            start = h.start;
          } else {
            const alt = tc.indexOf(h.text);
            if (alt !== -1) {
              target = msgEl;
              start = alt;
            }
          }
        }
      }

      // ② 旧格式占位记录（或消息 id 已失效）：在可见消息里按原文全文找
      if (!target) {
        for (const msgEl of Array.from(root.querySelectorAll('[data-msg-id]'))) {
          const tc = msgBodies(msgEl).textContent || '';
          const at = tc.indexOf(h.text);
          if (at !== -1) {
            target = msgEl;
            start = at;
            break;
          }
        }
      }

      if (!target || start < 0) continue;
      const body = msgBodies(target);
      const r = makeRange(body, start, h.len);
      if (!r) continue;
      ranges.push(r);
      const msgId = target.getAttribute('data-msg-id') || '';
      if (msgId && (msgId !== h.msgId || start !== h.start)) {
        migrations.push({ id: h.id, msgId, start });
      }
    }
  }
  shares.set(key, ranges);
  flush();
  return migrations;
}

/** 面板卸载：让出份额 */
export function clearHighlights(key: string) {
  shares.delete(key);
  flush();
}
