import React from 'react';
import type { PanelFaceProps } from '../../src/shared/types';

/**
 * 组件库面板 —— 读插件写下的那份清单（`.ensoul/state/library.json`），
 * 点一下让**插件**照那个组件新建一块面板。
 *
 * 为什么点一下要绕一圈：脸跑在渲染进程，不该绕过停靠树去建面板（会被核心拦，
 * 拦得对）。所以走那条老路 —— 脸往命令文件里塞一条命令，插件读到就 createPanel。
 *
 * 面板自己轮询那个小 JSON（1.5 秒一次）：比给插件装一套事件总线便宜得多，
 * 也不会因为某次通知丢了就永远不刷新。别处存进来、别处删掉的，它自己会跟上。
 */

interface Item {
  id: string;
  name: string;
  note: string;
  kind: string;
  title: string;
  at: number;
  /** 软件自带的出厂做法：删不掉，同名存一份就能改成自己的 */
  preset?: boolean;
  /** 这条做法打哪来：mine 私人库 / app 跟软件走 / ws 跟工作区走（能提交、能分发） */
  source?: 'mine' | 'app' | 'ws';
}

/** 读成 base64（.ensoulpack 是二进制 zip，交给插件解） */
async function readAsBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** 读成文本（裸组件 JSON） */
function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('read failed'));
    r.readAsText(file);
  });
}

const STATE = '.ensoul/state/library.json';
const CMD = '.ensoul/state/library.cmd.json';

/** 常见类型的说法 —— 认不出来的就直接显示那个 kind，不猜 */
const KIND_LABEL: Record<string, string> = {
  chat: t('对话'),
  files: t('文件'),
  editor: t('编辑器'),
  table: t('表格'),
  form: t('表单'),
  web: t('网页'),
  pomodoro: t('番茄钟'),
  todo: t('任务清单'),
  schedule: t('白板'),
  remote: t('远程访问'),
  // 插件带来的类型：不补就在这儿显示英文 slug（whale-pet、star-chart 这种）
  browser: t('浏览器'),
  canvas: t('无限画布'),
  dispatch: t('调度中心'),
  tickets: t('派单队列'),
  billing: t('实时计费'),
  eschat: 'ESchat',
  'whale-pet': t('桌宠'),
  sticker: t('便利贴'),
  notes: t('便签'),
  library: t('组件库'),
  'pixel-canvas': t('像素画板'),
  'prompt-manager': t('提示词管理台'),
  'task-monitor': t('任务监视器'),
  'computer-control': t('电脑控制台'),
  'voice-input': t('语音输入'),
  git: 'Git',
  'git-packager': t('开源打包台'),
  mcp: t('MCP 生态中心'),
  'our-free-model': t('免费模型车道'),
  'star-chart': t('AI星图'),
};
const labelOf = (kind: string) => KIND_LABEL[kind] || kind;

function parse(text: string): Item[] {
  try {
    const j = JSON.parse(text);
    const list = Array.isArray(j?.items) ? (j.items as Item[]) : [];
    return list
      .filter((i) => i && i.id && i.name)
      .slice()
      .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  } catch {
    return [];
  }
}

const ago = (at: number) => {
  const d = Date.now() - (Number(at) || 0);
  if (!at) return '';
  if (d < 60000) return t('刚刚');
  if (d < 3600000) return t('{n} 分钟前', { n: Math.round(d / 60000) });
  if (d < 86400000) return t('{n} 小时前', { n: Math.round(d / 3600000) });
  return t('{n} 天前', { n: Math.round(d / 86400000) });
};

/**
 * 命令排成一条队列往后发（模块级，不是每挂载一次一条）——
 * 连点两下不会把前一条盖掉。插件执行完会把队列清空，这里读到的通常是空的。
 */
let chain: Promise<void> = Promise.resolve();

function enqueue(fs: PanelFaceProps['fs'], payload: Record<string, unknown>) {
  const run = async () => {
    let cmds: unknown[] = [];
    try {
      const j = JSON.parse(await fs.read(CMD));
      if (Array.isArray(j?.cmds)) cmds = j.cmds;
    } catch {
      cmds = [];
    }
    cmds.push(payload);
    await fs.write(CMD, JSON.stringify({ cmds: cmds.slice(-20) }));
  };
  chain = chain.then(run).catch(() => {});
  return chain;
}

export default function LibraryPanel({ panel, fs }: PanelFaceProps) {
  const [items, setItems] = React.useState<Item[] | null>(null);
  const [sent, setSent] = React.useState(0);

  /**
   * 导入一个组件（.ensoulpack 或一份裸 JSON）。
   *
   * 冲突这儿就问清楚：库里已经有同 id / 同名的，是**新建一个**还是**覆盖同名**。
   * 为什么要问：两种都有人要 —— 别人发来一个改良版的同款，覆盖是正解；
   * 两份想都留着，新建是正解。猜错了要么白丢一个、要么库里长出一对分不清的双胞胎。
   * 问完把选择一起交给插件（它才碰得到文件，脸碰不了）。
   */
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const raw = file.name.endsWith('.ensoulpack') || file.name.endsWith('.zip')
        ? await readAsBase64(file)
        : await readAsText(file);
      // 能不能看出冲突：裸 JSON 里带 id / name，包得等插件解开才知道
      let clash = '';
      if (!file.name.endsWith('.ensoulpack') && !file.name.endsWith('.zip')) {
        try {
          const j = JSON.parse(raw);
          const hit = (items ?? []).find((c) => c.id === j.id || (j.name && c.name === j.name));
          if (hit) clash = hit.name;
        } catch {
          /* 解不开就交给插件去报错 */
        }
      }
      let overwrite = false;
      if (clash) {
        const yes = window.confirm(
          t('库里已经有「{n}」了。\n\n点「确定」= 覆盖同名（用包里这份换掉它）\n点「取消」= 新建一个（两份都留着）', { n: clash })
        );
        overwrite = yes;
      }
      send({ cmd: 'import', data: raw, overwrite });
    } catch (err) {
      alert(t('读取文件失败：') + String(err));
    } finally {
      e.target.value = '';
    }
  };

  const seq = React.useRef(0);

  React.useEffect(() => {
    let alive = true;
    const tick = async () => {
      const text = await fs.read(STATE);
      if (!alive) return;
      setItems(parse(text));
    };
    void tick();
    const timer = setInterval(() => void tick(), 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [panel.id]);

  const send = (patch: Record<string, unknown>) => {
    seq.current += 1;
    void enqueue(fs, { seq: Date.now() * 1000 + (seq.current % 1000), panelId: panel.id, ...patch });
    setSent((n) => n + 1);
  };

  const use = (c: Item) => send({ cmd: 'new', id: c.id });

  const drop = (c: Item) => {
    const ok = window.confirm(`删掉组件「${c.name}」？\n\n删的是这张架子上的做法，已经开着的那块面板不受影响。`);
    if (ok) send({ cmd: 'drop', id: c.id });
  };

  if (!items || !items.length) {
    return (
      <div className="lib">
        <div className="lib-head">
          <div className="lib-title">{panel.title || t('模板库')}</div>
          <div className="lib-sub">{t('存的是「这么做」，不是「这一个」—— 点一下就是新建一块同款面板。')}</div>
          <div className="lib-actions" style={{ marginTop: 6 }}>
            <label className="lib-import-btn" style={{ cursor: 'pointer', display: 'inline-block', padding: '4px 10px', fontSize: 12, background: 'var(--ensoul-btn-bg, #333)', color: 'var(--ensoul-fg, #eee)', borderRadius: 4 }}>
              {t('导入组件 (.ensoulpack / .json)')}
              <input type="file" accept=".ensoulpack,.zip,.json" style={{ display: 'none' }} onChange={handleImport} />
            </label>
          </div>

        </div>
        <div className="lib-empty">
          {items === null ? (
            t('正在读模板库…')
          ) : (
            <>
              {t('库里还空着。')}
              <br />
              {t('看中哪块面板（表格、表单、网页、番茄钟、清单……都行），对着它说一句')}
              <code>{t('把这块面板存成模板')}</code>
              ，助手就会把它的做法存进来 —— 之后在这儿点一下，就能再开一个同款。
              <br />
              <span className="lib-dim">
                要连整段对话一起永久留住（关不关都在），就把它<strong>{t('声明成组件')}</strong>{t('：面板右键选「声明为组件」，或拖到顶上那条组件区。')}
              </span>
            </>
          )}
        </div>
        {sent > 0 && <div className="lib-foot">{t('已发出')}{sent} 条命令；点完没反应说明 library 插件没在跑。</div>}
      </div>
    );
  }

  return (
    <div className="lib">
      <div className="lib-head">
        <div className="lib-title">
          {panel.title || t('模板库')}
          <span className="lib-count">{items.length}</span>
        </div>
        <div className="lib-sub">
          {t('点「新建」= 照这份做法开一块干净的面板（想开几个开几个）。带「出厂」的是软件带的，带「可分发」的跟着这个工作区走（能提交、能发给别人）—— 这两种都删不掉，想改成自己的同名再存一份。')}
        </div>
      </div>

      <div className="lib-list">
        {items.map((c) => (
          <div className="lib-item" key={c.id}>
            <button className="lib-open" onClick={() => use(c)} title={t('照「{n}」新建一块 {k} 面板', { n: c.name, k: labelOf(c.kind) })}>
              <span className="lib-name">{c.name}</span>
              {c.preset ? <span className="lib-tag">{c.source === 'ws' ? t('可分发') : t('出厂')}</span> : null}
              <span className="lib-kind">{labelOf(c.kind)}</span>
              {c.note && <span className="lib-note">{c.note}</span>}
              {c.at ? <span className="lib-at">{ago(c.at)}存的</span> : null}
            </button>
            {c.preset ? null : (
              <button className="lib-drop" onClick={() => drop(c)} title={t('从库里删掉这个组件（已开着的面板不动）')}>
                ×
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="lib-foot">
        {t('上面这些是做法，谁都没带着对话。要接着聊原来那一个，用顶上的收纳区。')}
      </div>
    </div>
  );
}
