/**
 * 会话检索 —— 在**别的面板的对话**里搜东西。
 *
 * 为什么要靠工具：每一块的对话都落在 userData 下（开着的在 workspace.json，
 * 关掉的在 closed/，收纳的在 components/）。这些路径既不在工作区里、也不进提示，
 * read_file 够不着 —— 于是"上次那个会话里是怎么解决的"只能现查。
 *
 * 它不缓存、不留状态、平时一个字的提示都不占：全按需去捞。
 */

const fs = require('fs');
const path = require('path');

const MAX_HITS = 20;
const SNIP_BEFORE = 70;
const SNIP_AFTER = 130;
const READ_LIMIT = 4000;
const HEAD = 80;

let el = null;
try {
  el = require('electron');
} catch (e) {
  el = null;
}

function baseDir() {
  try {
    return el && el.app ? el.app.getPath('userData') : '';
  } catch (e) {
    return '';
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function flat(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function cut(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function when(t) {
  return t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : t('时间不详');
}

/** 面板 → 会话；一条有字的都没有的空会话不进列表 */
function take(out, p, from) {
  if (!p || !Array.isArray(p.chat)) return;
  const msgs = p.chat.filter((m) => m && typeof m.content === 'string' && m.content.trim());
  if (!msgs.length) return;
  const last = p.chat[p.chat.length - 1];
  out.push({
    id: String(p.id || ''),
    title: String(p.title || t('（无标题）')),
    from,
    at: (last && last.createdAt) || 0,
    msgs,
  });
}

/** 所有会话，按最后说话时间倒序 */
function sessions() {
  const base = baseDir();
  const out = [];
  if (!base) return out;

  const ws = readJson(path.join(base, 'workspace.json'));
  if (ws && ws.panels) for (const p of Object.values(ws.panels)) take(out, p, t('开着'));

  for (const [dir, from] of [['closed', t('已关闭')], ['components', t('收纳区')]]) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(base, dir));
    } catch (e) {
      names = [];
    }
    for (const n of names) {
      if (!n.toLowerCase().endsWith('.json')) continue;
      take(out, readJson(path.join(base, dir, n)), from);
    }
  }

  out.sort((a, b) => b.at - a.at);
  return out;
}

function hitsOf(s, kw) {
  const k = kw.toLowerCase();
  if (!k) return [];
  const hits = [];
  for (const m of s.msgs) {
    const text = flat(m.content);
    const lower = text.toLowerCase();
    for (let i = lower.indexOf(k); i >= 0; i = lower.indexOf(k, i + k.length)) {
      const a = Math.max(0, i - SNIP_BEFORE);
      const b = Math.min(text.length, i + k.length + SNIP_AFTER);
      hits.push({
        role: m.role,
        at: m.createdAt,
        text: (a > 0 ? '…' : '') + text.slice(a, b) + (b < text.length ? '…' : ''),
      });
      if (hits.length >= MAX_HITS) return hits;
    }
  }
  return hits;
}

function label(m) {
  return m && m.role === 'user' ? t('用户') : t('助手');
}

function listLines(list, self) {
  return list
    .map((s, i) => {
      const head = s.msgs.find((m) => m.role === 'user');
      const badge = s.id === self ? t('（就是这一块）') : '';
      return [
        `${i + 1}. 《${s.title}》${badge} [${s.id}] ${s.from} · ${s.msgs.length} 条 · 最后说话 ${when(s.at)}`,
        `   开头：${head ? cut(flat(head.content), HEAD) : '（没有用户消息）'}`,
      ].join('\n');
    })
    .join('\n');
}

module.exports = {
  name: 'history',
  description: t('会话检索：在别的面板的对话里搜关键词，把命中的原文捞回来'),

  setup(api) {
    api.addTool(
      {
        name: 'history_search', kits: ['copy'],
        description:
          t('在**别的面板的对话**里搜关键词。不传 keyword 就把所有会话列一遍（标题、条数、最后说话时间、开头一句）。')
          + t('传了 keyword 就回命中的原文片段，标明是哪个会话、谁说的、什么时候。')
          + t('要某个会话的完整正文，用 history_read。'),
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: t('要找的词；不传就只列会话') },
            limit: { type: 'number', description: `最多回多少条命中片段，默认 ${MAX_HITS}` },
          },
        },
        level: 'read',
      },
      (args, ctx) => {
        const list = sessions();
        if (!list.length) return t('没找到任何有内容的会话。');
        const self = (ctx && ctx.panelId) || '';
        const kw = flat(args && args.keyword);

        if (!kw) {
          return (
            `共 ${list.length} 个有内容的会话（按最后说话时间倒序）。`
            + t('要搜东西就传 keyword；要看某个的正文用 history_read。\n\n${listLines(list, self)}')
          );
        }

        const limit = Number(args && args.limit) > 0 ? Math.min(Number(args.limit), MAX_HITS) : MAX_HITS;
        const blocks = [];
        let total = 0;
        let where = 0;
        for (const s of list) {
          const hits = hitsOf(s, kw);
          if (!hits.length) continue;
          where++;
          const lines = [`—— 《${s.title}》 [${s.id}] ${s.from} · 最后说话 ${when(s.at)}`];
          for (const h of hits) {
            if (total >= limit) break;
            total++;
            lines.push(`   · ${label(h)}（${when(h.at)}）：${h.text}`);
          }
          blocks.push(lines.join('\n'));
          if (total >= limit) break;
        }

        if (!total) return `所有会话里都没有「${kw}」。是不是换个词？`;
        return (
          `找到 ${total} 处「${kw}」，来自 ${where} 个会话`
          + `（要某个的完整正文用 history_read session="id"）：\n\n`
          + blocks.join('\n\n')
        );
      },
    );

    api.addTool(
      {
        name: 'history_read', kits: ['copy'],
        description:
          t('读某个会话的正文。session 给会话 id（history_search 列出来的方括号里那串）或者标题里的一段。')
          + t('给了 keyword 就只回含这个词的那些消息。'),
        parameters: {
          type: 'object',
          properties: {
            session: { type: 'string', description: t('会话 id，或者标题里的一段') },
            keyword: { type: 'string', description: t('只要含这个词的消息；不传就回整段正文') },
          },
          required: ['session'],
        },
        level: 'read',
      },
      (args) => {
        const want = flat(args && args.session).toLowerCase();
        if (!want) return t('要给 session —— 会话 id 或标题里的一段。不知道有哪些会话就先 history_search 不传关键词。');

        const list = sessions();
        const s =
          list.find((x) => x.id.toLowerCase() === want)
          || list.find((x) => x.title.toLowerCase().includes(want))
          || list.find((x) => x.id.toLowerCase().includes(want));
        if (!s) return `没找到匹配「${args.session}」的会话。`;

        const kw = flat(args && args.keyword).toLowerCase();
        let msgs = s.msgs.filter((m) => m.role === 'user' || m.role === 'assistant');
        if (kw) msgs = msgs.filter((m) => flat(m.content).toLowerCase().includes(kw));
        if (!msgs.length) return `《${s.title}》里没有含「${args.keyword}」的正文。`;

        const picked = [];
        let used = 0;
        for (let i = msgs.length - 1; i >= 0; i--) {
          const body = flat(msgs[i].content);
          if (picked.length && used + body.length > READ_LIMIT) break;
          picked.push(`【${label(msgs[i])} · ${when(msgs[i].createdAt)}】${cut(body, READ_LIMIT)}`);
          used += body.length;
        }
        picked.reverse();

        const skipped = msgs.length - picked.length;
        return (
          `《${s.title}》 [${s.id}] ${s.from} · ${s.msgs.length} 条 · 最后说话 ${when(s.at)}`
          + (skipped > 0 ? `\n（前面还有 ${skipped} 条没展开 —— 用 keyword 缩小范围）` : '')
          + '\n\n'
          + picked.join('\n\n')
        );
      },
    );

    api.log('会话检索就绪（读 userData 下的 workspace.json / closed / components）');
  },
};
