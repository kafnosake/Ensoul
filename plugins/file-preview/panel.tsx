import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PanelFaceProps } from '../../src/shared/types';
import { t } from '../../src/renderer/core/i18n';

/**
 * 文件预览面板 —— 一张脸，按扩展名分发到对应的查看器。
 *
 * 它自己**不读二进制**：脸只有 \`fs.read\`（纯文本，300KB 上限），图、视频、
 * 3D 模型根本读不进来。文件是主进程那个**只读 + Range** 的本地服务喂过来的
 * （见 plugins/file-preview/index.js），这里只负责拼 URL、选查看器、画界面。
 *
 * 为什么非得 Range：\`<video>\` 拖进度条要 206 分段响应，three 的加载器走 fetch ——
 * 裸 file:// 过不了 CORS（唯一豁免的是 \`<img>\`，所以核心的看图能用，别的都不行）。
 *
 * 「这块面板在看哪个文件」存在\`panel.file\`上（跟文本面板同一个字段）——
 * 于是开几块预览面板各看各的，谁也不串味；状态文件里只有服务地址与授权表，
 * 那两样对每块面板都是同一份事实。
 */

const STATE_FILE = '.ensoul/state/file-preview.json';
const CMD_FILE = '.ensoul/state/file-preview.cmd.json';

/** 图像：浏览器 \`<img>\` 直接认的几种 */
const IMAGE = ['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'tif', 'tiff'];
/** 视频 */
const VIDEO = ['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'avi'];
/** 音频 */
const AUDIO = ['mp3', 'wav', 'wave', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'weba'];
/** 3D 模型 */
const MODEL = ['glb', 'gltf', 'obj', 'stl', 'ply', 'fbx'];
/** 按文本看 */
const TEXT = [
  'txt', 'md', 'markdown', 'json', 'jsonc', 'csv', 'tsv', 'log', 'xml', 'html', 'htm', 'css', 'scss',
  'less', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'py', 'rb', 'go', 'rs', 'java',
  'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'lua', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'gitignore', 'sql', 'graphql', 'proto', 'glsl', 'frag', 'vert',
  'mtl', 'srt', 'vtt',
];

const extOf = (p: string): string => {
  const s = String(p || '').replace(/\\/g, '/');
  const base = s.slice(s.lastIndexOf('/') + 1);
  // .gitignore 这种"整个名字就是扩展名"的
  if (base.startsWith('.') && base.indexOf('.', 1) < 0) return base.slice(1).toLowerCase();
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase();
};

const baseOf = (p: string): string => {
  const s = String(p || '').replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1);
};

type Kind = 'image' | 'video' | 'audio' | 'model' | 'text' | 'other';

function kindOf(ext: string): Kind {
  if (IMAGE.includes(ext)) return 'image';
  if (VIDEO.includes(ext)) return 'video';
  if (AUDIO.includes(ext)) return 'audio';
  if (MODEL.includes(ext)) return 'model';
  if (TEXT.includes(ext)) return 'text';
  return 'other';
}

const sizeText = (n: number): string => {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
};

/** 绝对路径 → 服务地址。**按段编码**，让 gltf 里的相对贴图还能顺着 URL 找回来 */
function fileUrl(base: string, abs: string): string {
  const segs = String(abs || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return base + '/' + segs.map(encodeURIComponent).join('/');
}

interface Svc {
  ok: boolean;
  port: number;
  token: string;
  reason: string;
}

/** 服务地址（没端口就没意义） */
const svcBase = (s: Svc | null): string =>
  s && s.ok && s.port ? 'http://127.0.0.1:' + s.port + '/fs/' + s.token : '';

/**
 * 读一份服务状态（端口 + 令牌）。
 *
 * 单独抽出来是因为有**两处**要用：一处是每 1.2 秒的常规轮询，另一处是
 * fetch 失败时的「当场重问一遍」。插件一重载就换端口，手里那份立刻过期 ——
 * 而浏览器对连不上的本机端口只会报一句 Failed to fetch，什么都看不出来。
 */
async function readSvc(fs: PanelFaceProps['fs']): Promise<Svc | null> {
  try {
    const text = await fs.read(STATE_FILE);
    const j = JSON.parse(text);
    return {
      ok: !!j.ok,
      port: Number(j.port) || 0,
      token: String(j.token || ''),
      reason: String(j.reason || ''),
    };
  } catch {
    return null;
  }
}

export default function FilePreviewPanel({ panel, patch, fs }: PanelFaceProps) {
  const [svc, setSvc] = useState<Svc | null>(null);
  const [info, setInfo] = useState<{ ok: boolean; size: number; type: string; status: number; err: string } | null>(null);
  const [denied, setDenied] = useState(false);
  const [nonce, setNonce] = useState(0);
  /** 有东西正拖在这块面板上（画一圈提示） */
  const [over, setOver] = useState(false);
  /** 拖进来但拿不到磁盘路径时的临时一份（blob 地址，不记进面板） */
  const [temp, setTemp] = useState<{ url: string; name: string; size: number } | null>(null);

  const abs = String(panel.file || '');
  const ext = extOf(abs);
  const kind = kindOf(ext);
  const base = svc && svc.ok ? 'http://127.0.0.1:' + svc.port + '/fs/' + svc.token : '';
  const url = base && abs ? fileUrl(base, abs) : '';

  // 服务地址在状态文件里（插件写、这里读）。每秒看一次：插件重载会换端口和令牌
  useEffect(() => {
    let dead = false;
    const tick = async () => {
      try {
        const text = await fs.read(STATE_FILE);
        const j = JSON.parse(text);
        if (dead) return;
        setSvc({
          ok: !!j.ok,
          port: Number(j.port) || 0,
          token: String(j.token || ''),
          reason: String(j.reason || ''),
        });
      } catch {
        if (!dead) setSvc({ ok: false, port: 0, token: '', reason: '' });
      }
    };
    void tick();
    const timer = setInterval(tick, 1200);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [fs]);

  // 拿一下大小与内容类型（HEAD 就够，不搬内容）
  useEffect(() => {
    if (!url) {
      setInfo(null);
      setDenied(false);
      return;
    }
    let dead = false;
    /**
     * 403 要**自己退避重试几轮**，别把那一屏钉死。
     *
     * 为什么：区外文件的放行发生在**插件那一侧**，每 200ms 一跳
     * （`authorizePanelFiles`）—— 也就是说"面板一指向它"到"服务愿意给"
     * 之间有个几百毫秒的窗口。而这里只认 `url`/`nonce`，撞上那个窗口就
     * 一直显示"读不了"，非等用户手动点一下才行 —— 可用户什么都没做错。
     * 重试几轮（200/600/1200ms）就跨过去了；真放行不了才亮那个"授权"按钮。
     */
    let tries = 0;
    const RETRY = [200, 600, 1200, 2000];
    let timer: any = 0;

    /**
     * 重试前**当场重问一遍服务地址**。
     *
     * 这一步非有不可：插件是热重载的，一重载就换端口、换令牌。面板手里那份
     * 是 1.2 秒轮询缓存的，撞上重载就指向一个没人听的端口 —— 浏览器对此只报
     * 一句 TypeError: Failed to fetch，既不告诉你是端口过期，也不给状态码。
     * 光重试同一个旧地址是没用的（我第一版就只重试 403，于是这种情况一直卡死）。
     */
    const refreshSvc = async () => {
      const next = await readSvc(fs);
      if (!dead && next && next.ok) setSvc(next);
      return svcBase(next);
    };

    /** 这一轮实际要打的地址 —— 重试时会跟着新端口换掉 */
    let target = url;

    const load = async () => {
      let resp: Response | null = null;
      let thrown: any = null;

      try {
        resp = await fetch(target, { method: 'HEAD' });
      } catch (e: any) {
        thrown = e;
      }

      if (dead) return;

      // 连接层面就没通（旧端口 / 服务刚换令牌）→ 换新地址再来
      if (thrown) {
        if (tries < RETRY.length) {
          const wait = RETRY[tries];
          tries += 1;
          // 重问服务地址：插件重载会换端口，手里那份可能已经指向死端口
          const freshBase = await refreshSvc();
          if (dead) return;
          if (freshBase && abs) target = fileUrl(freshBase, abs);
          timer = setTimeout(load, wait);
          return;
        }
        setInfo({ ok: false, size: 0, type: '', status: 0, err: String((thrown && thrown.message) || thrown) });
        return;
      }

      if (!resp) return;

      // 403：授权是插件每 200ms 一跳做的，等它一拍
      if (resp.status === 403) {
        if (tries < RETRY.length) {
          const wait = RETRY[tries];
          tries += 1;
          timer = setTimeout(load, wait);
          return;
        }
        setDenied(true);
        setInfo({ ok: false, size: 0, type: '', status: 403, err: '' });
        return;
      }
      if (!resp.ok) {
        setDenied(false);
        setInfo({ ok: false, size: 0, type: '', status: resp.status, err: '' });
        return;
      }
      setDenied(false);
      setInfo({
        ok: true,
        size: Number(resp.headers.get('content-length')) || 0,
        type: String(resp.headers.get('content-type') || ''),
        status: 200,
        err: '',
      });
    };

    void load();
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
    };
  }, [url, nonce]);

  /** 工作区外的文件要面板显式排一条授权命令 —— 插件下一跳读到就放行 */
  const allow = useCallback(async () => {
    if (!abs) return;
    try {
      let queue: any[] = [];
      try {
        const text = await fs.read(CMD_FILE);
        const j = JSON.parse(text);
        if (j && Array.isArray(j.cmds)) queue = j.cmds;
      } catch {
        /* 还没发过命令 */
      }
      queue.push({ seq: Date.now(), panelId: panel.id, cmd: 'allow', path: abs });
      await fs.write(CMD_FILE, JSON.stringify({ cmds: queue.slice(-40) }));
    } catch {
      /* 写不进去就等下一跳 */
    }
    // 插件每 200ms 看一次命令 —— 等一下再重试
    setTimeout(() => setNonce((n) => n + 1), 350);
  }, [abs, fs, panel.id]);

  /** 把「要看的那个文件」记到这块面板上 —— 面板只存路径，一次一个 */
  const pick = useCallback(
    (next: string) => {
      const clean = String(next || '').replace(/\\/g, '/');
      setNonce((n) => n + 1);
      setTemp(null);
      patch({ file: clean });
    },
    [patch],
  );

  /** 关掉当前这个，回到白板（等着拖下一个进来） */
  const clear = useCallback(() => {
    setTemp(null);
    patch({ file: '' });
  }, [patch]);

  /**
   * 拖进来的东西 → 换成「在看哪个文件」。
   *
   * 优先拿**磁盘路径**：那才是这块面板的正经状态 —— 助手读得到、刷新还在、
   * 关掉面板再开还是它。拿不到路径（只给了一个 File 对象）才退一步，用 blob
   * 地址当场看一眼，那种不记进面板，刷新就没了。
   *
   * 一次只认第一个文件：想看第二个，再开一块预览面板（面板本来就是这么用的）。
   */
  const takeDrop = useCallback(
    async (dt: DataTransfer) => {
      const f = dt.files && dt.files[0];
      if (!f) {
        // 没带文件，可能拖/粘的是一段文字 —— 那就当路径用
        const text = String(dt.getData('text/plain') || '').trim();
        if (text && text.length < 1024) pick(text.replace(/^["']|["']$/g, ''));
        return;
      }
      const abs = await absPathOf(f);
      if (abs) {
        pick(abs);
        return;
      }
      setTemp({ url: URL.createObjectURL(f), name: f.name, size: f.size });
    },
    [pick],
  );

  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      void takeDrop(e.dataTransfer);
    },
  };

  // ── 还没有要看的东西：白板，等着拖进来或者让助手打开 ─────────────
  if (!abs && !temp) {
    return (
      <div className={'fp' + (over ? ' is-over' : '')} {...dropProps}>
        <DropBoard over={over} onPick={pick} />
      </div>
    );
  }

  if (!svc || !svc.ok) {
    return (
      <div className="fp">
        <div className="fp-empty">
          <div className="fp-empty-title">{t('文件预览服务还没起来')}</div>
          <div className="fp-empty-note">{svc && svc.reason ? svc.reason : t('正在等主进程把只读服务拉起来；它是插件起的，稍等一下或者去设置里看看插件是否启用。')}</div>
        </div>
      </div>
    );
  }

  // 拿不到磁盘路径的那种（拖进来一个 File）：临时看一眼，不记进面板
  if (temp) {
    return (
      <div className="fp" {...dropProps}>
        <div className="fp-bar">
          <span className="fp-name" title={temp.name}>{temp.name}</span>
          <span className="fp-tag">{t('临时')}</span>
          <span className="fp-size">{sizeText(temp.size)}</span>
          <span className="fp-gap" />
          <button className="fp-btn" onClick={clear} title={t('关掉这个文件，回到白板')}>{t('关掉')}</button>
        </div>
        <div className="fp-main">
          <TempView url={temp.url} name={temp.name} ext={extOf(temp.name)} />
        </div>
      </div>
    );
  }

  return (
    <div className="fp" {...dropProps}>
      <div className="fp-bar">
        <span className="fp-name" title={abs}>{baseOf(abs)}</span>
        <span className="fp-tag">{kindOf(ext) === 'other' ? (ext ? '.' + ext : t('无扩展名')) : t('{k}', { k: kindOf(ext) })}</span>
        {info && info.ok && <span className="fp-size">{sizeText(info.size)}</span>}
        <span className="fp-gap" />
        <button className="fp-btn" onClick={() => setNonce((n) => n + 1)} title={t('重新读一次')}>{t('刷新')}</button>
        <button className="fp-btn" onClick={clear} title={t('关掉这个文件，回到白板')}>{t('关掉')}</button>
      </div>

      <div className="fp-main">
        {denied ? (
          <div className="fp-empty">
            <div className="fp-empty-title">{t('这个文件在工作区外面')}</div>
            <div className="fp-empty-note">{t('预览服务默认只放行工作区里面的文件。点一下授权，它就把这一个路径记进放行表（只读，随时可以在状态文件里清掉）。')}</div>
            <div className="fp-row">
              <code className="fp-path">{abs}</code>
              <button className="fp-btn is-primary" onClick={() => void allow()}>{t('授权并重试')}</button>
            </div>
          </div>
        ) : !info ? (
          <div className="fp-empty"><div className="fp-empty-note">{t('读文件信息…')}</div></div>
        ) : !info.ok ? (
          <div className="fp-empty">
            <div className="fp-empty-title">
              {info.status === 404 ? t('找不到这个文件') : info.status === 403 ? t('没被授权') : t('读不了这个文件')}
            </div>
            <div className="fp-empty-note">{info.err || ('HTTP ' + info.status)}</div>
            {/* 把实际用的地址摆出来：连不上时"哪个端口"就是全部线索，
                而 Failed to fetch 本身什么都不告诉你。 */}
            <div className="fp-note-src">{url || t('（还没有服务地址）')}</div>
            <div className="fp-row">
              <button className="fp-btn is-primary" onClick={() => setNonce((n) => n + 1)}>{t('重试')}</button>
            </div>
          </div>
        ) : kind === 'image' ? (
          <ImageViewer key={url + '#' + nonce} url={url} size={info.size} name={baseOf(abs)} />
        ) : kind === 'video' ? (
          <VideoViewer key={url + '#' + nonce} url={url} />
        ) : kind === 'audio' ? (
          <AudioViewer key={url + '#' + nonce} url={url} name={baseOf(abs)} />
        ) : kind === 'model' ? (
          <ModelViewer key={url + '#' + nonce} url={url} ext={ext} name={baseOf(abs)} />
        ) : kind === 'text' ? (
          <TextViewer key={url + '#' + nonce} url={url} size={info.size} />
        ) : (
          <HexViewer key={url + '#' + nonce} url={url} size={info.size} ext={ext} type={info.type} />
        )}
      </div>
    </div>
  );
}

// ── 白板：还没有要看的东西时 ────────────────────────────────────────
/**
 * 这块面板是**一块白板**，不是文件浏览器 —— 所以这里没有目录树
 * （那是文件树面板的活，摆在这儿只是重复一遍）。
 *
 * 它只回答一个问题："看哪个文件？" 三条路，都不用离开这块面板：
 *   · 把文件**拖进来**（最顺手）
 *   · 粘一个路径回车（工作区内外都行；区外的要授权一次）
 *   · 让助手替你开（它调 file_preview 工具，等价于直接改了 panel.file）
 *
 * 一次只显示一个。想看两个，再开一块预览面板 —— 面板本来就该这么用。
 */
function DropBoard({ over, onPick }: { over: boolean; onPick(p: string): void }) {
  const [typed, setTyped] = useState('');
  return (
    <div className={'fp-board' + (over ? ' is-over' : '')}>
      <div className="fp-board-mark">{over ? '⤓' : '▤'}</div>
      <div className="fp-board-title">{over ? t('松手就打开') : t('把文件拖进来')}</div>
      <div className="fp-board-note">
        {t('图像、视频、音频、3D 模型、文本都认。也可以直接粘一个路径，或者让助手帮你打开。')}
      </div>
      <div className="fp-pick">
        <input
          className="fp-input"
          value={typed}
          spellCheck={false}
          placeholder={t('粘一个路径，回车打开')}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && typed.trim()) onPick(typed.trim().replace(/^["']|["']$/g, ''));
          }}
        />
      </div>
    </div>
  );
}

/**
 * 拖进来的那个 File 有没有磁盘路径。
 *
 * Electron 从 32 起把 \`File.path\` 拿掉了，官方给的是 \`webUtils.getPathForFile\`，
 * 而它只在 preload 里够得着 —— 渲染层拿不到，所以这里先探一下：探得到就用真路径
 * （那才是正经状态），探不到就退回去用 blob 临时看一眼。
 */
async function absPathOf(file: File): Promise<string> {
  const anyFile = file as any;
  if (typeof anyFile.path === 'string' && anyFile.path) return anyFile.path;
  // sandbox 下 webUtils 只在 preload 够得着，核心替我们转了一手
  try {
    const bridge = (globalThis as any).ensoul;
    if (bridge && bridge.files && typeof bridge.files.pathFor === 'function') {
      const p = bridge.files.pathFor(file);
      if (typeof p === 'string' && p) return p;
    }
  } catch {
    /* 拿不到就当没有 */
  }
  const w = anyFile.webUtils;
  if (w && typeof w.getPathForFile === 'function') {
    try {
      const p = w.getPathForFile(file);
      if (typeof p === 'string' && p) return p;
    } catch {
      /* 拿不到就当没有 */
    }
  }
  return '';
}

/** 临时那一份（没有磁盘路径）：只按扩展名分图像 / 媒体 / 文本看一眼 */
function TempView({ url, name, ext }: { url: string; name: string; ext: string }) {
  const kind = kindOf(ext);
  if (kind === 'image') {
    return (
      <div className="fp-canvas">
        <img className="fp-img" src={url} alt={name} style={{ maxWidth: '100%', maxHeight: '100%' }} />
      </div>
    );
  }
  if (kind === 'video') {
    return (
      <div className="fp-canvas is-media">
        <video className="fp-media" src={url} controls />
      </div>
    );
  }
  if (kind === 'audio') {
    return (
      <div className="fp-canvas is-media">
        <div className="fp-audio">
          <div className="fp-audio-name">{name}</div>
          <audio className="fp-media" src={url} controls />
        </div>
      </div>
    );
  }
  return (
    <div className="fp-empty">
      <div className="fp-empty-title">{t('这一份没带磁盘路径')}</div>
      <div className="fp-empty-note">{t('这种没有磁盘路径的一份，只能临时看一眼图像、视频和音频。想长久地看它，把它放进工作区再拖进来。')}</div>
    </div>
  );
}

// ── 图像 ────────────────────────────────────────────────────────────
function ImageViewer({ url, size, name }: { url: string; size: number; name: string }) {
  const [fit, setFit] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [nat, setNat] = useState({ w: 0, h: 0 });
  const [err, setErr] = useState(false);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const host = useRef<HTMLDivElement>(null);

  const show = Math.max(0.02, Math.min(64, zoom));

  return (
    <>
      <div className="fp-bar is-thin">
        <button className="fp-btn" onClick={() => { setFit(true); setZoom(1); setPos({ x: 0, y: 0 }); }}>{t('适应窗口')}</button>
        <button className="fp-btn" onClick={() => { setFit(false); setZoom(1); setPos({ x: 0, y: 0 }); }}>{t('原始大小')}</button>
        <button className="fp-btn" onClick={() => setZoom((z) => Math.max(0.02, z / 1.25))}>−</button>
        <span className="fp-zoom">{Math.round(show * 100)}%</span>
        <button className="fp-btn" onClick={() => setZoom((z) => Math.min(64, z * 1.25))}>+</button>
        <span className="fp-gap" />
        {nat.w > 0 && <span className="fp-size">{nat.w} × {nat.h}</span>}
      </div>

      <div
        className={'fp-canvas' + (size > 0 ? ' is-checker' : '')}
        ref={host}
        onWheel={(e) => {
          const next = Math.max(0.02, Math.min(64, show * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
          setFit(false);
          setZoom(next);
        }}
        onMouseDown={(e) => { drag.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }; }}
        onMouseMove={(e) => {
          if (!drag.current) return;
          setPos({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y });
        }}
        onMouseUp={() => { drag.current = null; }}
        onMouseLeave={() => { drag.current = null; }}
        onDoubleClick={() => { setFit((v) => !v); setZoom(1); setPos({ x: 0, y: 0 }); }}
      >
        {err ? (
          <div className="fp-empty"><div className="fp-empty-title">{t('这张图没能显示出来')}</div><div className="fp-empty-note">{name}</div></div>
        ) : (
          <img
            className="fp-img"
            src={url}
            alt={name}
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNat({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            onError={() => setErr(true)}
            style={
              fit
                ? { maxWidth: '100%', maxHeight: '100%', transform: 'none' }
                : { transform: 'translate(' + pos.x + 'px,' + pos.y + 'px) scale(' + show + ')', maxWidth: 'none', maxHeight: 'none' }
            }
          />
        )}
      </div>
    </>
  );
}

// ── 视频 ────────────────────────────────────────────────────────────
function VideoViewer({ url }: { url: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [rate, setRate] = useState(1);
  return (
    <>
      <div className="fp-bar is-thin">
        {[0.5, 1, 1.5, 2].map((r) => (
          <button
            key={r}
            className={'fp-btn' + (rate === r ? ' is-on' : '')}
            onClick={() => { setRate(r); if (ref.current) ref.current.playbackRate = r; }}
          >
            {r}×
          </button>
        ))}
        <span className="fp-gap" />
        <span className="fp-size">{t('拖进度条走的是分段读取，不会把整个视频搬进内存')}</span>
      </div>
      <div className="fp-canvas is-media">
        <video ref={ref} className="fp-media" src={url} controls preload="metadata" />
      </div>
    </>
  );
}

// ── 音频 ────────────────────────────────────────────────────────────
function AudioViewer({ url, name }: { url: string; name: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [rate, setRate] = useState(1);
  return (
    <>
      <div className="fp-bar is-thin">
        {[0.75, 1, 1.25, 1.5, 2].map((r) => (
          <button
            key={r}
            className={'fp-btn' + (rate === r ? ' is-on' : '')}
            onClick={() => { setRate(r); if (ref.current) ref.current.playbackRate = r; }}
          >
            {r}×
          </button>
        ))}
      </div>
      <div className="fp-canvas is-media">
        <div className="fp-audio">
          <div className="fp-audio-name">{name}</div>
          <audio ref={ref} className="fp-media" src={url} controls preload="metadata" />
        </div>
      </div>
    </>
  );
}

// ── 3D 模型 ─────────────────────────────────────────────────────────
function ModelViewer({ url, ext, name }: { url: string; ext: string; name: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(true);
  const [wire, setWire] = useState(false);
  const [spin, setSpin] = useState(false);
  const [stats, setStats] = useState({ tris: 0, meshes: 0 });
  /** 场景那套东西都留在 ref 里：按钮改的是它，不走 React 重渲染 */
  const sc = useRef<any>(null);
  const wireRef = useRef(false);
  const spinRef = useRef(false);

  useEffect(() => { wireRef.current = wire; }, [wire]);
  useEffect(() => { spinRef.current = spin; }, [spin]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let dead = false;
    let cleanup = () => {};

    void (async () => {
      try {
        const THREE = await import('three');
        const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');

        let obj: any = null;
        if (ext === 'glb' || ext === 'gltf') {
          const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
          const loader = new GLTFLoader();
          /**
           * 挂 Draco 解码器 —— 不挂的话，压缩过的 glb 直接抛
           * "No DRACOLoader instance provided"（实测那批 HD2D 道具全是压缩的）。
           *
           * 解码文件不从 dist 拿：界面是 file:// 页面，取不到站内的东西；
           * 它由预览服务喂（/draco/...，跟模型同一个源、同一套 CORS 头）。
           * 解码器还要起 blob Worker，那条路靠 index.html 的 worker-src 放行。
           */
          const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js');
          const draco = new DRACOLoader();
          // 解码器和模型同一个源（url 就是那个只读服务给的），从它身上取 origin 即可
          const origin = new URL(url).origin;
          draco.setDecoderPath({
            js: origin + '/draco/draco_wasm_wrapper.js',
            wasm: origin + '/draco/draco_decoder.wasm',
          });
          loader.setDRACOLoader(draco);
          const gltf = await loader.loadAsync(url);
          obj = gltf.scene;
        } else if (ext === 'obj') {
          const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
          obj = await new OBJLoader().loadAsync(url);
        } else if (ext === 'stl') {
          const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
          const g = await new STLLoader().loadAsync(url);
          g.computeVertexNormals();
          obj = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xc8ccd4, metalness: 0.05, roughness: 0.65 }));
        } else if (ext === 'ply') {
          const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
          const g = await new PLYLoader().loadAsync(url);
          g.computeVertexNormals();
          obj = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xc8ccd4, flatShading: true, roughness: 0.7 }));
        } else if (ext === 'fbx') {
          const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
          obj = await new FBXLoader().loadAsync(url);
        } else {
          throw new Error(t('这种 3D 格式还没接：') + ext);
        }

        if (dead || !host.current) return;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x101216);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x333844, 2.0));
        const key = new THREE.DirectionalLight(0xffffff, 2.2);
        key.position.set(3, 6, 4);
        scene.add(key);
        const rim = new THREE.DirectionalLight(0x88aaff, 1.0);
        rim.position.set(-4, 2, -3);
        scene.add(rim);

        scene.add(obj);

        // 统计一下，顺手告诉用户"模型真的进来了"
        let tris = 0;
        let meshes = 0;
        obj.traverse((n: any) => {
          if (!n.isMesh) return;
          meshes += 1;
          const g = n.geometry;
          if (g && g.index) tris += g.index.count / 3;
          else if (g && g.attributes && g.attributes.position) tris += g.attributes.position.count / 3;
        });

        // 把镜头摆到装得下整个模型的位置
        const box = new THREE.Box3().setFromObject(obj);
        const sizeV = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.max(sizeV.x, sizeV.y, sizeV.z, 0.001) / 2;
        const dist = radius / Math.tan((45 * Math.PI) / 360) * 2.1;

        // 地面网格按模型大小铺，免得巨型模型底下是根头发丝
        const grid = new THREE.GridHelper(radius * 8, 24, 0x2a3040, 0x1c212b);
        grid.position.y = box.min.y;
        scene.add(grid);
        const axes = new THREE.AxesHelper(radius * 1.2);
        axes.position.copy(center);
        scene.add(axes);

        const camera = new THREE.PerspectiveCamera(45, 1, Math.max(radius / 1000, 0.001), radius * 200);
        const setCam = () => {
          camera.position.set(center.x + dist * 0.7, center.y + dist * 0.55, center.z + dist * 0.7);
          camera.near = Math.max(dist / 500, 0.001);
          camera.far = dist * 100;
          camera.updateProjectionMatrix();
        };
        setCam();

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        el.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.target.copy(center);
        controls.minDistance = radius / 50;
        controls.maxDistance = radius * 60;
        controls.autoRotateSpeed = 1.6;
        controls.update();

        const resize = () => {
          const w = el.clientWidth || 1;
          const h = el.clientHeight || 1;
          renderer.setSize(w, h, false);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        };
        resize();
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
        ro?.observe(el);

        let raf = 0;
        const loop = () => {
          raf = requestAnimationFrame(loop);
          controls.autoRotate = spinRef.current;
          controls.update();
          renderer.render(scene, camera);
        };
        loop();

        sc.current = { THREE, camera, controls, renderer, obj, center, dist, setCam };

        setStats({ tris: Math.round(tris), meshes });
        setBusy(false);

        cleanup = () => {
          cancelAnimationFrame(raf);
          ro?.disconnect();
          controls.dispose();
          scene.traverse((n: any) => {
            if (n.geometry) n.geometry.dispose?.();
            const m = n.material;
            if (Array.isArray(m)) m.forEach((x: any) => x.dispose?.());
            else m?.dispose?.();
          });
          renderer.dispose();
          if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
        };
      } catch (e: any) {
        if (!dead) {
          setBusy(false);
          setErr(String((e && e.message) || e));
        }
      }
    })();

    return () => {
      dead = true;
      cleanup();
    };
  }, [url, ext]);

  const reset = () => {
    const s = sc.current;
    if (!s) return;
    s.setCam();
    s.controls.target.copy(s.center);
    s.controls.update();
  };

  const toggleWire = () => {
    const next = !wire;
    setWire(next);
    const s = sc.current;
    if (!s) return;
    s.obj.traverse((n: any) => {
      const m = n.material;
      if (Array.isArray(m)) m.forEach((x: any) => { if ('wireframe' in x) x.wireframe = next; });
      else if (m && 'wireframe' in m) m.wireframe = next;
    });
  };

  return (
    <>
      <div className="fp-bar is-thin">
        <button className="fp-btn" onClick={reset}>{t('重置视角')}</button>
        <button className={'fp-btn' + (wire ? ' is-on' : '')} onClick={toggleWire}>{t('线框')}</button>
        <button className={'fp-btn' + (spin ? ' is-on' : '')} onClick={() => setSpin((v) => !v)}>{t('自转')}</button>
        <span className="fp-gap" />
        {stats.meshes > 0 && <span className="fp-size">{t('{m} 个网格 · {t} 个三角面', { m: stats.meshes, t: stats.tris.toLocaleString() })}</span>}
      </div>
      <div className="fp-canvas is-3d">
        <div className="fp-3d" ref={host} />
        {busy && <div className="fp-overlay">{t('加载模型…（贴图与网格一起拉，大模型要等一下）')}</div>}
        {!!err && (
          <div className="fp-overlay is-err">
            <div className="fp-empty-title">{t('这个模型没能加载')}</div>
            <div className="fp-empty-note">{err}</div>
            <div className="fp-empty-note">{name}</div>
          </div>
        )}
      </div>
    </>
  );
}

// ── 文本 ────────────────────────────────────────────────────────────
const TEXT_CAP = 512 * 1024;
const TEXT_HEAD = 256 * 1024;

function TextViewer({ url, size }: { url: string; size: number }) {
  const [text, setText] = useState('');
  const [cut, setCut] = useState(false);
  const [err, setErr] = useState('');
  const [wrap, setWrap] = useState(false);

  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const whole = size <= TEXT_CAP;
        const r = await fetch(url, whole ? {} : { headers: { Range: 'bytes=0-' + (TEXT_HEAD - 1) } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const body = await r.text();
        if (dead) return;
        setText(body);
        setCut(!whole);
      } catch (e: any) {
        if (!dead) setErr(String((e && e.message) || e));
      }
    })();
    return () => {
      dead = true;
    };
  }, [url, size]);

  return (
    <>
      <div className="fp-bar is-thin">
        <button className={'fp-btn' + (wrap ? ' is-on' : '')} onClick={() => setWrap((v) => !v)}>{t('自动换行')}</button>
        <span className="fp-gap" />
        {cut && <span className="fp-size">{t('只显示了前 256 KB')}</span>}
      </div>
      <div className="fp-code" style={wrap ? undefined : { whiteSpace: 'pre' }}>
        {err ? <div className="fp-empty">{err}</div> : text}
      </div>
    </>
  );
}

// ── 别的二进制：给个十六进制头 ──────────────────────────────────────
function HexViewer({ url, size, ext, type }: { url: string; size: number; ext: string; type: string }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const r = await fetch(url, { headers: { Range: 'bytes=0-4095' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = new Uint8Array(await r.arrayBuffer());
        if (dead) return;
        const lines: string[] = [];
        for (let i = 0; i < buf.length; i += 16) {
          const chunk = buf.subarray(i, i + 16);
          const hex = Array.from(chunk).map((b) => b.toString(16).padStart(2, '0')).join(' ');
          const asc = Array.from(chunk).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
          lines.push(i.toString(16).padStart(8, '0') + '  ' + hex.padEnd(47, ' ') + '  |' + asc + '|');
        }
        setText(lines.join('\n'));
      } catch (e: any) {
        if (!dead) setErr(String((e && e.message) || e));
      }
    })();
    return () => {
      dead = true;
    };
  }, [url]);

  return (
    <>
      <div className="fp-bar is-thin">
        <span className="fp-size">{ext ? '.' + ext : t('无扩展名')} · {type || t('未知类型')} · {t('前 4 KB')}</span>
        <span className="fp-gap" />
        <span className="fp-size">{sizeText(size)}</span>
      </div>
      <div className="fp-code is-hex">
        {err ? <div className="fp-empty">{t('这个文件没认出来，也读不到它的头：') + err}</div> : text}
      </div>
    </>
  );
}
