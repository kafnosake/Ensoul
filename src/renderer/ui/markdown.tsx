import React from 'react';

/**
 * 极简 markdown 渲染 —— 只为让文档面板看起来像在读东西，不追求规范完备。
 * 支持：标题、粗体、行内代码、代码块、有序/无序列表、表格、链接、引用、分隔线、段落。
 */
export function renderMarkdown(src: string): React.ReactNode[] {
  const lines = (src || '').split('\n');
  const out: React.ReactNode[] = [];
  let seq = 0;
  // 稳定的 key：同一个块在两次渲染之间必须拿到同一个 key，React 才会复用 DOM。
  // 这里以前是全局递增计数器，每次渲染 key 全变 → 整棵子树被卸载重建，
  // 流式输出时每个 token 重建一次，是界面卡死的元凶之一。
  const k = () => `md-${out.length}-${seq++}`;

  const inline = (text: string): React.ReactNode => {
    const parts: React.ReactNode[] = [];
    // 重点标记 `==……==` 用**惰性**匹配，中间不排除等号 —— 从前这里和便签那边一样是
    // `[^=\n]+`，圈里只要带一个 `=`（`a=b`、`x == y`、代码片段）整条就不算标记，
    // 高亮不出来、流式时还把裸 `==` 直接露给用户。惰性是为了 `==甲== 和 ==乙==` 时
    // 分成两条，别被贪婪连成一条。
    const re = /(`[^`]+`|\*\*[^*]+\*\*|==[\s\S]+?==|\[[^\]]*\]\([^)\s]+\))/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index > last) parts.push(text.slice(last, m.index));
      const t = m[0];
      if (t.startsWith('`')) parts.push(<code key={k()}>{t.slice(1, -1)}</code>);
      else if (t.startsWith('==')) parts.push(<mark className="hl" key={k()}>{t.slice(2, -2)}</mark>);
      else if (t.startsWith('[')) {
        const cut = t.indexOf('](');
        parts.push(
          <a className="md-a" href={t.slice(cut + 2, -1)} target="_blank" rel="noreferrer" key={k()}>
            {t.slice(1, cut)}
          </a>,
        );
      } else parts.push(<strong key={k()}>{t.slice(2, -2)}</strong>);
      last = m.index + t.length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts.length === 1 ? parts[0] : parts;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trimStart().startsWith('```')) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(
        <pre className="md-pre" key={k()}>
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const Tag = (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const)[level - 1];
      out.push(
        <Tag className={`md-h md-h${level}`} key={k()}>
          {inline(h[2])}
        </Tag>,
      );
      i += 1;
      continue;
    }

    // 有序列表：1. / 2) 都认，起始号写进 <ol start>，断号续上也照原样
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ol) {
      const items: React.ReactNode[] = [];
      let startNum = parseInt(ol[1], 10);
      while (i < lines.length) {
        const m = lines[i].match(/^\s*(\d+)[.)]\s+(.*)$/);
        if (!m) break;
        if (items.length === 0) startNum = parseInt(m[1], 10);
        items.push(<li key={k()}>{inline(m[2])}</li>);
        i += 1;
      }
      out.push(
        <ol className="md-ul" start={startNum} key={k()}>
          {items}
        </ol>,
      );
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push(<hr className="md-hr" key={k()} />);
      i += 1;
      continue;
    }

    // 表格：表头行 + 分隔行（|---|---|）+ 数据行，三者缺一不可 ——
    // 只凭"这一行有竖线"就当表格，会把普通句子里的竖线误认成表格。
    if (line.includes('|') && i + 1 < lines.length) {
      const delim = lines[i + 1];
      if (/^[|:\-\s]+$/.test(delim) && delim.includes('-') && delim.includes('|')) {
        const split = (row: string): string[] =>
          row
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((c) => c.trim());
        const align = (m: string): 'left' | 'center' | 'right' =>
          m.startsWith(':') && m.endsWith(':') ? 'center' : m.endsWith(':') ? 'right' : 'left';
        const head = split(line);
        const marks = split(delim);
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          rows.push(split(lines[i]));
          i += 1;
        }
        out.push(
          <table className="md-table" key={k()}>
            <thead>
              <tr>
                {head.map((c, ci) => (
                  <th key={k()} style={{ textAlign: align(marks[ci] || '') }}>
                    {inline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={k()}>
                  {r.map((c, ci) => (
                    <td key={k()} style={{ textAlign: align(marks[ci] || '') }}>
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>,
        );
        continue;
      }
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      out.push(
        <ul className="md-ul" key={k()}>
          {items.map((t) => (
            <li key={k()}>{inline(t)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(
        <blockquote className="md-quote" key={k()}>
          {buf.map((t, n) => (
            <React.Fragment key={k()}>
              {n > 0 && <br />}
              {inline(t)}
            </React.Fragment>
          ))}
        </blockquote>,
      );
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const buf: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|\s*[-*]\s|\s*\d+[.)]\s|\s*>|\s*```|\s*\|)/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push(
      <p className="md-p" key={k()}>
        {buf.map((t, n) => (
          <React.Fragment key={k()}>
            {n > 0 && <br />}
            {inline(t)}
          </React.Fragment>
        ))}
      </p>,
    );
  }

  return out;
}
