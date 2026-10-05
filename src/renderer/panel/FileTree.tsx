import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../core/api';
import { useWorkspace } from '../core/useWorkspace';
import { t } from '../core/i18n';

/**
 * 工作区文件树。
 *
 * 这是一个普通面板 —— 和别的面板一样能拖、能停靠、能分离成浮窗。
 * 点文件会在文本面板里打开（已经开着的就切过去，没开就新开一个标签）。
 *
 * 显示逻辑照主流编辑器来，不自己发明一套：
 *   1. 层级靠「一个固定的缩进步进」（15px/层），不画竖线、不上颜色
 *   2. 行首一枚单色描边图标（文件夹 / 文件），字色只用明暗两档
 *   3. 选中的是整行铺一层浅底，不额外加侧边条、不加粗
 *   4. 顶上有个过滤框，打字就把整棵树翻成一张扁平结果表（带上级路径）
 * 想往这儿加新花样之前，先问一句：主流编辑器会不会这么干。
 */
interface Entry {
  name: string;
  dir: boolean;
  path: string;
  size: number;
}

/** 行首图标：单色描边，颜色跟着字色走，和编辑器里那套一致 */
const Caret = ({ open }: { open: boolean }) => (
  <svg className={`ft-caret${open ? ' is-open' : ''}`} viewBox="0 0 12 12" aria-hidden="true">
    <path
      d="M4.2 2.4 8 6l-3.8 3.6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const FolderIcon = () => (
  <svg className="ft-ic" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M2 4.2c0-.6.5-1.1 1.1-1.1h2.5c.3 0 .6.15.8.4l.7.9h5.8c.6 0 1.1.5 1.1 1.1v6.3c0 .6-.5 1.1-1.1 1.1H3.1c-.6 0-1.1-.5-1.1-1.1V4.2z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.15"
      strokeLinejoin="round"
    />
  </svg>
);

const FileIcon = () => (
  <svg className="ft-ic" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M3.6 3.1c0-.6.5-1.1 1.1-1.1h4.1L12.4 5.5v7.4c0 .6-.5 1.1-1.1 1.1H4.7c-.6 0-1.1-.5-1.1-1.1V3.1z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.15"
      strokeLinejoin="round"
    />
    <path d="M8.7 2v3.5h3.7" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" />
  </svg>
);

const parentOf = (p: string) => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

/** 根目录路径太长就只留最后两段 —— 面板窄，尾巴比开头有用 */
const shortRoot = (p: string) => {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
};

export function FileTree() {
  const ws = useWorkspace();
  const [root, setRoot] = useState('');
  const [kids, setKids] = useState<Record<string, Entry[]>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({ '.': true });
  const [current, setCurrent] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Entry[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const kidsRef = useRef<Record<string, Entry[]>>(kids);
  kidsRef.current = kids;

  const load = async (dir: string) => {
    const list = await api.fs.list(dir);
    setKids((k) => ({ ...k, [dir]: list }));
    return list;
  };

  // 工作区根目录换了就整个重来
  useEffect(() => {
    setKids({});
    setOpen({ '.': true });
    setCurrent(null);
    setQuery('');
    void api.fs.root().then(setRoot);
    void load('.');
  }, [ws?.workspace]);

  /** 过滤：不在这棵树上打转，直接把已展开之外的目录也扫出来（有深度和条数上限） */
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      setHits(null);
      setScanning(false);
      return;
    }
    let dead = false;
    setScanning(true);
    const out: Entry[] = [];
    let dirs = 0;

    const scan = async (dir: string, depth: number) => {
      if (dead || depth > 8 || dirs > 160 || out.length > 400) return;
      dirs += 1;
      let list = kidsRef.current[dir];
      if (!list) {
        try {
          list = await api.fs.list(dir);
        } catch {
          return;
        }
        if (dead) return;
        kidsRef.current = { ...kidsRef.current, [dir]: list as Entry[] };
        setKids((k) => ({ ...k, [dir]: list as Entry[] }));
      }
      for (const e of list) {
        if (dead || out.length > 400) return;
        const normPath = e.path.replace(/\\/g, '/').toLowerCase();
        const normName = e.name.toLowerCase();
        const match = normName.includes(q) || normPath.includes(q);
        if (match) {
          out.push(e);
        }
        // 关键修复：只要是目录，必须继续向下递归扫描子项，绝不能截断丢弃内部文件
        if (e.dir) {
          await scan(e.path, depth + 1);
        }
      }
    };

    const timer = setTimeout(async () => {
      await scan('.', 0);
      if (dead) return;
      // 排序：优先文件名直接匹配的，且文件排在文件夹前面
      out.sort((a, b) => {
        const aName = a.name.toLowerCase().includes(q);
        const bName = b.name.toLowerCase().includes(q);
        if (aName !== bName) return aName ? -1 : 1;
        if (a.dir !== b.dir) return a.dir ? 1 : -1;
        return a.path.length - b.path.length;
      });
      setHits(out);
      setScanning(false);
    }, 120);

    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [query]);

  const toggle = async (p: string) => {
    const next = !open[p];
    setOpen((o) => ({ ...o, [p]: next }));
    if (next && !kids[p]) await load(p);
  };

  /** 展开一个路径的所有祖先目录；若 openSelf 为 true，则将该路径本身也设为展开 */
  const openAncestors = async (targetPath: string, openSelf = false) => {
    const norm = targetPath.replace(/\\/g, '/');
    const parts = norm.split('/').filter(Boolean);
    const toOpen: Record<string, boolean> = { '.': true };
    let cur = '';
    const len = openSelf ? parts.length : parts.length - 1;
    for (let i = 0; i < len; i++) {
      cur = cur ? `${cur}/${parts[i]}` : parts[i];
      toOpen[cur] = true;
      if (!kidsRef.current[cur]) {
        try {
          const list = await api.fs.list(cur);
          kidsRef.current = { ...kidsRef.current, [cur]: list };
          setKids((k) => ({ ...k, [cur]: list }));
        } catch {
          /* 忽略单层读取失败 */
        }
      }
    }
    setOpen((o) => ({ ...o, ...toOpen }));
  };

  const pick = (e: Entry) => {
    if (e.dir) {
      if (hits) {
        // 过滤模式下点击文件夹：展开该文件夹并清空过滤，在树中无缝定位展开（符合直觉的打开文件夹）
        setCurrent(e.path);
        void openAncestors(e.path, true);
        setQuery('');
      } else {
        void toggle(e.path);
      }
    } else {
      setCurrent(e.path);
      void api.panel.openFile(e.path);
      void openAncestors(e.path, false);
    }
  };

  const rows = useMemo(() => {
    const out: React.ReactNode[] = [];
    const walk = (dir: string, depth: number) => {
      for (const e of kids[dir] ?? []) {
        out.push(<Row key={e.path} e={e} depth={depth} open={!!open[e.path]} on={current === e.path} onPick={() => pick(e)} />);
        if (e.dir && open[e.path]) walk(e.path, depth + 1);
      }
    };
    walk('.', 0);
    return out;
  }, [kids, open, current]);

  return (
    <div className="file-tree">
      <div className="ft-head">
        <div className="ft-rootline">
          <span className="ft-roottag">{t('工作区')}</span>
          <span className="ft-root" title={root}>
            {root ? shortRoot(root) : '…'}
          </span>
        </div>
        <input
          type="search"
          className="ft-filter"
          value={query}
          spellCheck={false}
          placeholder={t('过滤文件…')}
          onChange={(ev) => setQuery(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Escape') {
              setQuery('');
            } else if (ev.key === 'Enter' && hits && hits.length > 0) {
              pick(hits[0]);
            }
          }}
        />
      </div>

      <div className="ft-list">
        {hits ? (
          hits.length === 0 ? (
            <div className="ft-empty">{scanning ? t('翻目录…') : t('没有匹配的文件')}</div>
          ) : (
            hits.map((e) => (
              <Row key={e.path} e={e} depth={0} open={false} on={current === e.path} flat onPick={() => pick(e)} />
            ))
          )
        ) : (
          rows
        )}
      </div>
    </div>
  );
}

function Row(props: {
  e: Entry;
  depth: number;
  open: boolean;
  on: boolean;
  flat?: boolean;
  onPick(): void;
}) {
  const { e, depth, open, on, flat, onPick } = props;
  const parent = flat ? parentOf(e.path) : '';

  return (
    <div
      className={`ft-row${on ? ' is-on' : ''}${e.dir ? ' is-dir' : ''}`}
      style={{ paddingLeft: 6 + (flat ? 0 : depth) * 15 }}
      onClick={onPick}
      title={e.dir ? (flat ? `${e.path} · 点击在目录树中展开` : e.path) : `${e.path} · ${sizeText(e.size)}`}
    >
      {flat && <span className="ft-up">{parent || '.'}</span>}
      {e.dir ? <Caret open={open} /> : <span className="ft-spacer" />}
      {e.dir ? <FolderIcon /> : <FileIcon />}
      <span className="ft-name">{e.name}</span>
    </div>
  );
}

const sizeText = (n: number) =>
  n > 1024 * 1024 ? `${Math.round(n / 1024 / 1024)}M` : n > 1024 ? `${Math.round(n / 1024)}K` : `${n}`;
