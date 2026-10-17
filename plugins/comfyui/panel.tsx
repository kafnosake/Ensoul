import React from 'react';
import type { PanelFaceProps } from '../../src/shared/types';

/**
 * ComfyUI 管理器 —— 工作流与模型的可视化管理台。
 *
 * 分工（谁写谁读，一个字都别越界）：
 *   .ensoul/comfyui/workflows/*.json   插件管真身（save/delete），这里只读 + 发改名命令
 *   .ensoul/comfyui/meta.json          这张脸自己读写：工作流描述、模型风格描述
 *   .ensoul/state/comfyui-models.json  插件落的模型清单快照（脸开不了 HTTP，靠它看服务器）
 *   .ensoul/state/comfyui.cmd.json     脸写、插件读的命令队列（改名 / 刷新模型，认 seq）
 *
 * 接线视图是**只读**的：按节点逐张卡片渲染，引用画成「← #N 节点类型」，占位符高亮。
 * 不给编辑 —— 改接线是改 API JSON，错了 comfyui_run 直接失败，得走对话或 ComfyUI 本体。
 */

const WF_DIR = '.ensoul/comfyui/workflows';
const META_FILE = '.ensoul/comfyui/meta.json';
const RULES_FILE = '.ensoul/comfyui/rules.json';
const SNAP_FILE = '.ensoul/state/comfyui-models.json';
const CMD_FILE = '.ensoul/state/comfyui.cmd.json';

const PH = { prompt: '{{prompt}}', seed: '{{seed}}', image: '{{image}}' };
const PH_OLD = { prompt: '%prompt%', seed: '%seed%', image: '%image%' };

interface Meta {
  workflows: Record<string, string>;
  models: Record<string, string>;
}

/** 一条出图规则：no 是它在追加序列里的编号（只增不改） */
interface Rule { no: number; text: string }

interface Snap {
  at?: number;
  up?: boolean;
  url?: string;
  kinds?: Record<string, string[]>;
}

interface WfRow { name: string; size: number }

interface WfNode { id: string; class_type?: string; inputs?: Record<string, unknown> }

const EMPTY_META: Meta = { workflows: {}, models: {} };

function parseMeta(text: string): Meta {
  try {
    const j = JSON.parse(text || '{}');
    return {
      workflows: j && typeof j.workflows === 'object' && j.workflows ? j.workflows : {},
      models: j && typeof j.models === 'object' && j.models ? j.models : {},
    };
  } catch {
    return { workflows: {}, models: {} };
  }
}

function parseSnap(text: string): Snap {
  try { return JSON.parse(text || '{}') || {}; } catch { return {}; }
}

/** 读工作流 JSON：认 API 格式（{id:{class_type,inputs}}），也认 UI 导出格式（{nodes:[…]}） */
function parseWf(text: string): WfNode[] | null {
  let j: any;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object') return null;

  // UI 导出格式：{ nodes: [{ id, type, widgets_values, inputs }] }
  if (Array.isArray(j.nodes)) {
    return j.nodes.map((n: any) => ({
      id: String(n.id ?? '?'),
      class_type: String(n.type ?? n.class_type ?? '?'),
      inputs: n.inputs && typeof n.inputs === 'object' ? n.inputs : {},
      __ui: true,
    })) as WfNode[];
  }

  const ids = Object.keys(j);
  ids.sort((a, b) => {
    const na = Number(a); const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.localeCompare(b);
  });
  return ids.map((id) => ({ id, ...(j[id] || {}) }));
}

/** 节点类型的人话标签；没列到的原样显示 */
const CLS: Record<string, string> = {
  CheckpointLoaderSimple: '模型加载',
  CheckpointLoader: '模型加载',
  UNETLoader: 'UNET 加载',
  CLIPLoader: 'CLIP 加载',
  VAELoader: 'VAE 加载',
  LoraLoader: 'LoRA 加载',
  LoraLoaderModelOnly: 'LoRA 加载',
  ControlNetLoader: 'ControlNet 加载',
  ControlNetApply: 'ControlNet 应用',
  UpscaleModelLoader: '放大模型加载',
  ImageUpscaleWithModel: '模型放大',
  CLIPTextEncode: '文本编码',
  KSampler: '采样',
  KSamplerAdvanced: '采样（高级）',
  EmptyLatentImage: '空白潜空间',
  EmptySD3LatentImage: '空白潜空间',
  VAEDecode: 'VAE 解码',
  VAEEncode: 'VAE 编码',
  VAEEncodeForInpaint: 'VAE 编码（修补）',
  SaveImage: '保存图片',
  PreviewImage: '预览图片',
  LoadImage: '读入图片',
  GrowMask: '扩张遮罩',
  FeatherMask: '羽化遮罩',
  ImageScale: '图像缩放',
};

// ══════════════════════════════════════════════════════════════════════
// 接线图：盒子 + 贝塞尔连线，自动分层布局（只读，但看着像 ComfyUI 原生）
// ══════════════════════════════════════════════════════════════════════

type NKind = 'load' | 'text' | 'sample' | 'latent' | 'vae' | 'mask' | 'image' | 'out' | 'other';

/** 盒子头上色用的粗分类 —— 一眼分出「加载 / 文本 / 采样 / 解码 / 输出」 */
function kindOf(cls: string): NKind {
  const c = cls.toLowerCase();
  if (/(checkpoint|unetloader|loraloader|cliploader|vaeloader|controlnetloader|upscalemodelloader|ipadapter)/.test(c)) return 'load';
  if (c.indexOf('encode') >= 0 && c.indexOf('clip') >= 0) return 'text';
  if (c.indexOf('ksampler') === 0) return 'sample';
  if (c.indexOf('empty') === 0) return 'latent';
  if (c.indexOf('vae') >= 0) return 'vae';
  if (c.indexOf('mask') >= 0) return 'mask';
  if (c.indexOf('save') >= 0 || c.indexOf('preview') >= 0) return 'out';
  if (c.indexOf('image') >= 0) return 'image';
  return 'other';
}

const G_W = 210;
const G_HEAD = 26;
const G_ROW = 18;
const G_LABEL = 17;
const G_MAXROWS = 8;
const G_GAPX = 52;

function cut(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

interface GRowB { k: string; v: string; ref: boolean; ph: boolean }

interface GBox {
  id: string; cls: string; label: string; kind: NKind;
  rows: GRowB[]; more: number; rowAt: Record<string, number>;
  x: number; y: number; w: number; h: number;
}

interface GEdge { key: string; from: string; to: string; name: string }

/** 盒子正文那几行：引用画成 #目标，标量截断；超出上限就记个「+N 项」 */
function graphRows(n: WfNode): { rows: GRowB[]; more: number; rowAt: Record<string, number> } {
  const rows: GRowB[] = [];
  const rowAt: Record<string, number> = {};
  let more = 0;
  for (const [k, v] of Object.entries((n.inputs || {}) as Record<string, unknown>)) {
    if (rows.length >= G_MAXROWS) { more++; continue; }
    rowAt[k] = rows.length;
    if (isRef(v)) rows.push({ k, v: '#' + String(v[0]), ref: true, ph: false });
    else if (typeof v === 'string') rows.push({ k, v: cut(v, 16), ref: false, ph: hasAnyPh(v) });
    else rows.push({ k, v: cut(JSON.stringify(v), 16), ref: false, ph: false });
  }
  return { rows, more, rowAt };
}

/**
 * DAG 分层布局：x 按「最长路径」分层，y 往「前驱中心」上靠，跑三遍就挺齐了。
 * 跟 XMind / ComfyUI 原生一个路子：左进右出，源头在左，产物在右。
 */
function layoutGraph(nodes: WfNode[]) {
  const byId = new Map<string, WfNode>();
  for (const n of nodes) byId.set(String(n.id), n);
  const ids = nodes.map((n) => String(n.id));

  const preds = new Map<string, string[]>();
  const edges: GEdge[] = [];
  for (const id of ids) preds.set(id, []);
  for (const n of nodes) {
    const to = String(n.id);
    for (const [k, v] of Object.entries((n.inputs || {}) as Record<string, unknown>)) {
      if (!isRef(v)) continue;
      const from = String(v[0]);
      if (!byId.has(from)) continue;
      edges.push({ key: from + '>' + to + '/' + k, from, to, name: k });
      if (preds.get(to)!.indexOf(from) < 0) preds.get(to)!.push(from);
    }
  }

  const layer = new Map<string, number>();
  const walk = (id: string, seen: Record<string, boolean>): number => {
    const got = layer.get(id);
    if (got !== undefined) return got;
    if (seen[id]) return 0;
    seen[id] = true;
    let deep = 0;
    for (const p of preds.get(id) || []) deep = Math.max(deep, walk(p, seen) + 1);
    delete seen[id];
    layer.set(id, deep);
    return deep;
  };
  for (const id of ids) walk(id, {});

  const cols = new Map<number, string[]>();
  for (const id of ids) {
    const L = layer.get(id) || 0;
    const list = cols.get(L);
    if (list) list.push(id); else cols.set(L, [id]);
  }
  const order = [...cols.keys()].sort((a, b) => a - b);

  const box = new Map<string, GBox>();
  for (const id of ids) {
    const raw = byId.get(id)!;
    const cls = String(raw.class_type || '?');
    const gr = graphRows(raw);
    const lines = gr.rows.length + (gr.more ? 1 : 0);
    box.set(id, {
      id, cls, label: CLS[cls] || '', kind: kindOf(cls),
      rows: gr.rows, more: gr.more, rowAt: gr.rowAt,
      x: 0, y: 0, w: G_W, h: G_HEAD + Math.max(1, lines) * G_ROW + G_LABEL + 6,
    });
  }

  const GAPY = 26;
  const mid = (id: string) => { const b = box.get(id)!; return b.y + b.h / 2; };

  for (let pass = 0; pass < 3; pass++) {
    for (const L of order) {
      const list = cols.get(L)!;
      for (const id of list) box.get(id)!.x = L * (G_W + G_GAPX);

      const want: Record<string, number> = {};
      if (L > 0) {
        for (const id of list) {
          const ps = preds.get(id) || [];
          let sum = 0;
          for (const p of ps) sum += mid(p);
          want[id] = ps.length ? sum / ps.length : mid(id);
        }
        list.sort((a, b) => {
          const d = (want[a] || 0) - (want[b] || 0);
          return d !== 0 ? d : (a < b ? -1 : 1);
        });
      }

      let y = 0;
      for (const id of list) {
        const b = box.get(id)!;
        if (L > 0) y = Math.max(y, (want[id] || 0) - b.h / 2);
        b.y = y;
        y += b.h + GAPY;
      }
      // 整列居中，别让某一列吊在天上
      let top = Infinity; let bottom = -Infinity;
      for (const id of list) { const b = box.get(id)!; top = Math.min(top, b.y); bottom = Math.max(bottom, b.y + b.h); }
      const shift = -(top + bottom) / 2;
      for (const id of list) box.get(id)!.y += shift;
    }
  }

  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const id of ids) {
    const b = box.get(id)!;
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  const PAD = 20;
  for (const id of ids) { const b = box.get(id)!; b.x += PAD - minX; b.y += PAD - minY; }

  return {
    list: ids.map((id) => box.get(id)!),
    map: box,
    edges,
    width: Math.max(1, maxX - minX) + PAD * 2,
    height: Math.max(1, maxY - minY) + PAD * 2,
  };
}

function isRef(v: unknown): v is [string, number] {
  return Array.isArray(v) && v.length >= 2 && typeof v[0] === 'string';
}

/** 值里含任意一种已知占位符（两种写法都算）—— 用来决定要不要高亮这一格 */
const PH_ALL = [PH.prompt, PH.seed, PH.image, PH_OLD.prompt, PH_OLD.seed, PH_OLD.image];
function hasAnyPh(v: unknown): boolean {
  return typeof v === 'string' && PH_ALL.some((p) => v.includes(p));
}

/** 模型风格的出厂预填 —— 存过就以存的为准 */
function defaultStyle(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('noobai')) return 'NoobAI 系：角色立绘与人体结构强的动漫万金油，cfg 5 上下、28~60 步，写角色向提示词最稳。';
  if (n.includes('celestreal')) return 'celestreal 系：偏场景与柔和光影，角色锐度一般，适合风景与氛围图。';
  if (n.includes('krea')) return 'Krea 系：画面干净、构图稳，适合写实与概念图；提示词写自然语言更吃得住。';
  if (n.includes('illusion')) return 'illusion 系：整体偏幻想柔化，适合概念与意象类画面。';
  if (n.includes('flux')) return 'Flux 系：大模型画质、自然语言提示词，cfg 通常 1、步数 20~30。';
  return '';
}

const kb = (n: number) => Math.max(1, Math.round(n / 1024)) + ' KB';

const LEGEND: Record<NKind, string> = {
  load: '加载', text: '文本', sample: '采样', latent: '潜空间',
  vae: 'VAE', mask: '遮罩', image: '图像', out: '输出', other: '其它',
};

const KIND_COLOR: Record<NKind, string> = {
  load: '#8b6cf0', text: '#d99a2b', sample: '#e0574a', latent: '#4a9de0',
  vae: '#2fa596', mask: '#b07ad0', image: '#3fae74', out: '#2f9e6e', other: '#7a8699',
};

/**
 * 接线图 —— 真正的一张节点图：盒子在左、产物在右，连线是贝塞尔曲线。
 *
 * 只读，但看和，操作上和 ComfyUI 原生一致：
 *   · 拖空白处平移，滚轮缩放（以指针为锚），右上角有 +/−/归位
 *   · 悬停或点中一个盒子 → 只高亮它和它的上下游连线，其余压暗
 *   · 连接线的落点对准**目标节点的那一行输入**，不是笼统的盒子中心
 *
 * 不给拖拽/连线编辑 —— 改接线是改 API JSON，错了 comfyui_run 直接失败，得走对话或 ComfyUI 本体。
 */
function WiringGraph({ nodes, name, onBack }: { nodes: WfNode[]; name: string; onBack: () => void }) {
  const graph = React.useMemo(() => layoutGraph(nodes), [nodes]);
  const [view, setView] = React.useState({ x: 0, y: 0, k: 1 });
  const [lit, setLit] = React.useState<string | null>(null);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const drag = React.useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);


  /** 把整张图缩放到刚好填进画布（留一点边）—— 换工作流、改窗口尺寸时都重算 */
  const fit = React.useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const k = Math.min(1.6, Math.max(0.34, Math.min(
      (r.width - 28) / Math.max(1, graph.width),
      (r.height - 28) / Math.max(1, graph.height),
      1.1,
    )));
    setView({ k, x: (r.width - graph.width * k) / 2, y: (r.height - graph.height * k) / 2 });
  }, [graph.width, graph.height]);

  React.useEffect(() => {
    setLit(null);
    fit();
  }, [name, fit]);

  // 画布尺寸变了（分栏拖动、窗口缩放）也重新适配一次
  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  // 滚轮缩放：得用原生监听才能 preventDefault（React 的 wheel 是被动的）
  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => {
        const rect = el.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const k2 = Math.min(2.4, Math.max(0.6, v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
        // 让指针下的那个点保持不动
        const wx = (px - v.x) / v.k;
        const wy = (py - v.y) / v.k;
        return { k: k2, x: px - wx * k2, y: py - wy * k2 };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onDown = (e: React.MouseEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  };
  const onMove = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }));
  };
  const onUp = () => { drag.current = null; };

  const zoom = (f: number) => setView((v) => ({ ...v, k: Math.min(2.4, Math.max(0.6, v.k * f)) }));
  const reset = () => fit();

  /** 高亮集合：点中的盒子、它左右两跳的邻居，以及牵涉到的连线 */
  const { litNodes, litEdges } = React.useMemo(() => {
    if (!lit) return { litNodes: null as Set<string> | null, litEdges: null as Set<string> | null };
    const ns = new Set<string>([lit]);
    for (const e of graph.edges) {
      if (e.from === lit) ns.add(e.to);
      if (e.to === lit) ns.add(e.from);
    }
    const es = new Set<string>();
    for (const e of graph.edges) if (e.from === lit || e.to === lit) es.add(e.key);
    return { litNodes: ns, litEdges: es };
  }, [lit, graph]);

  const dim = (id: string) => litNodes !== null && !litNodes.has(id);

  const model = nodes.find((n) => String(n.class_type || '').startsWith('CheckpointLoader'));
  const latent = nodes.find((n) => String(n.class_type || '').startsWith('Empty'));
  const sampler = nodes.find((n) => String(n.class_type || '').startsWith('KSampler'));
  const flat = JSON.stringify(nodes.map((n) => n.inputs || {}));
  const hasPrompt = [PH.prompt, PH_OLD.prompt].some((p) => flat.indexOf(p) >= 0);
  const hasImage = [PH.image, PH_OLD.image].some((p) => flat.indexOf(p) >= 0);
  const hasSeed = [PH.seed, PH_OLD.seed].some((p) => flat.indexOf(p) >= 0);

  return (
    <div className='cm-wiring'>
      <div className='cm-bar'>
        <span className='cm-cur'>{name}</span>
        {onBack && <button className='cm-btn cm-btn-xs' onClick={onBack} title='回到工作流列表'>换一份</button>}
        <span className='cm-gap' />
        <span className='cm-chip'>{nodes.length} 个节点</span>
        <span className='cm-chip'>{graph.edges.length} 条连线</span>
      </div>
      <div className='cm-sum'>
        {model && <span className='cm-chip cm-chip-k'><b>模型</b>{String(model.inputs?.ckpt_name || '')}</span>}
        {latent && latent.inputs && (
          <span className='cm-chip cm-chip-k'><b>尺寸</b>{String(latent.inputs.width)}×{String(latent.inputs.height)}</span>
        )}
        {sampler && sampler.inputs && (
          <span className='cm-chip cm-chip-k'>
            <b>采样</b>{String(sampler.inputs.steps)} 步 · cfg {String(sampler.inputs.cfg)} · {String(sampler.inputs.sampler_name || '')}
          </span>
        )}
        {hasPrompt && <span className='cm-chip cm-slot'>文生图 {'{{prompt}}'}</span>}
        {hasImage && <span className='cm-chip cm-slot'>图生图 {'{{image}}'}</span>}
        {hasSeed && <span className='cm-chip cm-slot'>含 {'{{seed}}'}</span>}
      </div>
      {nodes.some((n: any) => n.__ui) && (
        <div className='cm-note cm-warn'>
          这份像是 ComfyUI 界面导出的格式，连线可能不全。要让 comfyui_run 跑得动，请在 ComfyUI 里用「导出（API）」存一份。
        </div>
      )}
      <div className='cm-graph' ref={wrapRef}
        onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}>
        <svg width='100%' height='100%'>
          <g transform={`translate(${view.x}, ${view.y}) scale(${view.k})`}>
            {graph.edges.map((e) => {
              const a = graph.map.get(e.from);
              const b = graph.map.get(e.to);
              if (!a || !b) return null;
              const x1 = a.x + a.w;
              const y1 = a.y + G_HEAD + (a.rows.length * G_ROW) / 2 + 4;
              const ri = b.rowAt[e.name];
              const x2 = b.x;
              const y2 = ri === undefined ? b.y + b.h / 2 : b.y + G_HEAD + (ri + 0.5) * G_ROW;
              const dx = Math.max(30, Math.abs(x2 - x1) * 0.5);
              const on = litEdges === null || litEdges.has(e.key);
              return (
                <path key={e.key}
                  className={'cm-edge' + (litEdges && litEdges.has(e.key) ? ' is-on' : '')}
                  opacity={on ? 1 : 0.14}
                  d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`} />
              );
            })}
            {graph.list.map((b) => {
              const color = KIND_COLOR[b.kind];
              const active = lit === b.id;
              return (
                <g key={b.id} className='cm-gnode'
                  onMouseEnter={() => setLit(b.id)} onMouseLeave={() => setLit(null)}
                  opacity={dim(b.id) ? 0.22 : 1}>
                  <rect className={'cm-gbox' + (active ? ' is-on' : '')}
                    x={b.x} y={b.y} width={b.w} height={b.h} rx={8} />
                  <path d={`M ${b.x} ${b.y + 8} a 8 8 0 0 1 8 -8 h ${b.w - 16} a 8 8 0 0 1 8 8 v ${G_HEAD - 8} h ${-(b.w)} z`}
                    fill={color} opacity={active ? 1 : 0.85} />
                  <text className='cm-gid' x={b.x + 8} y={b.y + 15}>#{b.id}</text>
                  <text className='cm-gcls' x={b.x + b.w - 8} y={b.y + 15} textAnchor='end'>
                    {cut(b.cls, 26)}
                  </text>
                  {b.rows.map((r, i) => {
                    const yy = b.y + G_HEAD + (i + 0.5) * G_ROW;
                    return (
                      <g key={r.k}>
                        <text className='cm-gk' x={b.x + 9} y={yy + 4}>{cut(r.k, 13)}</text>
                        <text className={'cm-gv' + (r.ph ? ' is-ph' : '') + (r.ref ? ' is-ref' : '')}
                          x={b.x + b.w - 9} y={yy + 4} textAnchor='end'>
                          {r.ref ? '◀ ' + r.v : r.v}
                        </text>
                      </g>
                    );
                  })}
                  {b.more > 0 && (
                    <text className='cm-gmore' x={b.x + 9} y={b.y + G_HEAD + b.rows.length * G_ROW + 6}>
                      + 还有 {b.more} 项
                    </text>
                  )}
                  {b.label && (
                    <text className='cm-glabel' x={b.x + 9} y={b.y + b.h - 5}>{b.label}</text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
        <div className='cm-zoombar'>
          <button className='cm-btn' onClick={() => zoom(1.2)} title='放大'>＋</button>
          <button className='cm-btn' onClick={() => zoom(1 / 1.2)} title='缩小'>－</button>
          <button className='cm-btn' onClick={reset} title='归位'>归位</button>
        </div>
        <div className='cm-legend'>
          {(['load', 'text', 'sample', 'latent', 'vae', 'out'] as NKind[]).map((k) => (
            <span className='cm-legend-i' key={k}>
              <i style={{ background: KIND_COLOR[k] }} />
              {LEGEND[k]}
            </span>
          ))}
        </div>
      </div>
      <div className='cm-note'>连线为只读；拖空白平移、滚轮缩放、悬停看上下游。改接线请在 ComfyUI 里改完用「导出（API）」存回来。</div>
    </div>
  );
}


/**
 * 出图规则面板 —— 追加式的「默认规矩」：规则1、规则2……
 * 存在 .ensoul/comfyui/rules.json，插件每轮把它塞回对话，
 * 所以不管工作流文件怎么改，新会话出图照样吃这几条默认。
 * 一行一条（「默认尺寸 1280x720」这样写就成），改完即存。
 */
function RulesPanel({ rules, draft, onDraft, onAdd, onRemove }: {
  rules: Rule[];
  draft: string;
  onDraft: (s: string) => void;
  onAdd: () => void;
  onRemove: (no: number) => void;
}) {
  return (
    <div className='cm-rules'>
      <div className='cm-params-head'>出图规则<span className='cm-count'>新会话里默认按这些来（追加式）</span></div>
      {rules.length === 0 && (
        <div className='cm-rules-empty'>还没有规则。下面写一条，例如「默认画布 1280x720」「默认 20 步」。</div>
      )}
      {rules.map((r) => (
        <div className='cm-rule' key={r.no}>
          <span className='cm-rule-no'>规则{r.no}</span>
          <span className='cm-rule-tx'>{r.text}</span>
          <button className='cm-rule-x' title='删除这条规则' onClick={() => onRemove(r.no)}>✕</button>
        </div>
      ))}
      <div className='cm-rules-add'>
        <input value={draft} placeholder='追加一条规则，例如：默认 20 步'
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onAdd(); }} />
        <button className='cm-btn cm-primary' onClick={onAdd}>追加</button>
      </div>
    </div>
  );
}

export default function ComfyuiManagerPanel({ panel, fs }: PanelFaceProps) {
  const [tab, setTab] = React.useState<'wf' | 'models'>('wf');
  const [rows, setRows] = React.useState<WfRow[]>([]);
  const [wfLoaded, setWfLoaded] = React.useState(false);
  const [meta, setMeta] = React.useState<Meta>({ ...EMPTY_META });
  const [snap, setSnap] = React.useState<Snap>({});
  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState<'name' | 'size'>('name');
  const [open, setOpen] = React.useState<string | null>(null);
  const [wf, setWf] = React.useState<WfNode[] | null>(null);
  const [wfErr, setWfErr] = React.useState('');
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [renameTo, setRenameTo] = React.useState('');
  const [noting, setNoting] = React.useState<string | null>(null);
  const [noteDraft, setNoteDraft] = React.useState('');
  const [styleFor, setStyleFor] = React.useState<string | null>(null);
  const [styleDraft, setStyleDraft] = React.useState('');
  const [tip, setTip] = React.useState('');
  const [warn, setWarn] = React.useState('');
  const [confirmDel, setConfirmDel] = React.useState<string | null>(null);
  const [rules, setRules] = React.useState<Rule[]>([]);
  const [ruleDraft, setRuleDraft] = React.useState('');
  const seqRef = React.useRef(0);
  const tipTimer = React.useRef<any>(undefined);

  const flash = React.useCallback((msg: string, bad = false) => {
    setTip(msg);
    setWarn(bad ? msg : '');
    if (tipTimer.current) clearTimeout(tipTimer.current);
    tipTimer.current = setTimeout(() => { setTip(''); setWarn(''); }, bad ? 4200 : 2600);
  }, []);

  React.useEffect(() => () => { if (tipTimer.current) clearTimeout(tipTimer.current); }, []);

  const readMeta = React.useCallback(async () => {
    try { setMeta(parseMeta(await fs.read(META_FILE))); } catch { setMeta({ ...EMPTY_META }); }
  }, [fs]);

  const readRules = React.useCallback(async () => {
    try {
      const doc = JSON.parse((await fs.read(RULES_FILE)) || '{}');
      const list = Array.isArray(doc && doc.rules) ? doc.rules : [];
      setRules(list
        .map((r: any, i: number) => ({ no: Number(r && r.no) || i + 1, text: String((r && r.text) || '').trim() }))
        .filter((r: Rule) => r.text));
    } catch { setRules([]); }
  }, [fs]);

  const refresh = React.useCallback(async () => {
    try {
      const list = await fs.list(WF_DIR);
      const wfRows = (list || [])
        .filter((f) => !f.dir && f.name.toLowerCase().endsWith('.json'))
        .map((f) => ({ name: f.name.replace(/\.json$/i, ''), size: f.size }));
      setRows(wfRows);
    } catch { setRows([]); }
    setWfLoaded(true);
    try { setSnap(parseSnap(await fs.read(SNAP_FILE))); } catch { setSnap({}); }
    await readMeta();
    await readRules();
  }, [fs, readMeta, readRules]);

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  // 打开的接线单独慢一点拉：别让轮询把正在看的视图顶来顶去
  React.useEffect(() => {
    if (!open) { setWf(null); setWfErr(''); return; }
    let alive = true;
    const load = async () => {
      try {
        const nodes = parseWf(await fs.read(WF_DIR + '/' + open + '.json'));
        if (!alive) return;
        if (!nodes) { setWf(null); setWfErr('这份文件不是合法的 API 工作流 JSON'); return; }
        setWf(nodes); setWfErr('');
      } catch (e) {
        if (!alive) return;
        setWf(null); setWfErr(String((e && (e as any).message) || e));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [open, fs]);

  const sendCmd = async (cmds: any[]) => {
    seqRef.current = Math.max(Date.now(), seqRef.current + 1);
    await fs.write(CMD_FILE, JSON.stringify({ panelId: panel.id, seq: seqRef.current, cmds }));
  };

  const saveMeta = async (m: Meta): Promise<boolean> => {
    const r = await fs.write(META_FILE, JSON.stringify(m, null, 2));
    if (r && r.ok === false) { flash('保存失败：' + (r.error || ''), true); return false; }
    setMeta(m);
    return true;
  };

  const doRename = async () => {
    const from = renaming || '';
    const to = renameTo.trim();
    if (!to || to === from) { setRenaming(null); return; }
    if (!/^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5 .-]{0,59}$/.test(to)) {
      flash('名字只能用中英文、数字、空格、点、下划线、短横线，最多 60 字', true); return;
    }
    if (rows.some((r) => r.name === to)) { flash('已经有叫「' + to + '」的了', true); return; }
    const next: Meta = { workflows: { ...meta.workflows }, models: { ...meta.models } };
    if (typeof next.workflows[from] === 'string') {
      next.workflows[to] = next.workflows[from];
      delete next.workflows[from];
    }
    if (!(await saveMeta(next))) return;
    await sendCmd([{ action: 'rename', from, to }]);
    setRenaming(null);
    if (open === from) setOpen(to);
    flash('已改名：' + from + ' → ' + to);
    setTimeout(() => void refresh(), 900);
  };

  const saveRules = async (list: Rule[]): Promise<boolean> => {
    const r = await fs.write(RULES_FILE, JSON.stringify({ rules: list }, null, 2));
    if (r && r.ok === false) { flash('保存规则失败：' + (r.error || ''), true); return false; }
    setRules(list);
    return true;
  };

  const addRule = async () => {
    const text = ruleDraft.trim();
    if (!text) return;
    const nextNo = rules.reduce((m, r) => Math.max(m, r.no), 0) + 1;
    const next = rules.concat([{ no: nextNo, text }]);
    if (await saveRules(next)) {
      setRuleDraft('');
      flash('已追加 规则' + nextNo + '：' + text);
    }
  };

  const delRule = async (no: number) => {
    const next = rules.filter((r) => r.no !== no);
    if (await saveRules(next)) flash('已删除 规则' + no);
  };


  const doDelete = async (name: string) => {
    await sendCmd([{ action: 'delete', name }]);
    const next: Meta = { workflows: { ...meta.workflows }, models: { ...meta.models } };
    delete next.workflows[name];
    await saveMeta(next);
    setConfirmDel(null);
    if (open === name) setOpen(null);
    flash('已删除工作流：' + name);
    setTimeout(() => void refresh(), 800);
  };

  const saveNote = async () => {
    const name = noting || '';
    const next: Meta = { workflows: { ...meta.workflows }, models: { ...meta.models } };
    if (noteDraft.trim()) next.workflows[name] = noteDraft.trim();
    else delete next.workflows[name];
    if (await saveMeta(next)) { flash(noteDraft.trim() ? '描述已保存' : '描述已清空'); setNoting(null); }
  };

  const saveStyle = async () => {
    const name = styleFor || '';
    const next: Meta = { workflows: { ...meta.workflows }, models: { ...meta.models } };
    if (styleDraft.trim()) next.models[name] = styleDraft.trim();
    else delete next.models[name];
    if (await saveMeta(next)) { flash(styleDraft.trim() ? '风格描述已保存' : '风格描述已清空'); setStyleFor(null); }
  };

  const styleOf = (n: string) => (typeof meta.models[n] === 'string' ? meta.models[n] : defaultStyle(n));

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows
      .filter((r) => {
        if (!q) return true;
        const note = (meta.workflows[r.name] || '').toLowerCase();
        return r.name.toLowerCase().includes(q) || note.includes(q);
      });
    list.sort((a, b) => (sort === 'size' ? b.size - a.size : a.name.localeCompare(b.name)));
    return list;
  }, [rows, meta, query, sort]);

  // ── 右栏：接线图（只读）。没选工作流时给一句空态，选了就画图 ──
  const renderWiring = () => {
    if (open === null) {
      return (
        <div className='cm-stage-empty'>
          <div className='cm-stage-empty-i'>◇</div>
          <div className='cm-stage-empty-t'>从左边点一份工作流，这里显示它的接线图</div>
          <div className='cm-stage-empty-s'>只读视图：可拖空白平移、滚轮缩放、悬停看上下游</div>
        </div>
      );
    }
    if (!wf && !wfErr) return <div className='cm-note'>读取中…</div>;
    if (wfErr) return <div className='cm-note cm-warn'>读不出来：{wfErr}</div>;
    return <WiringGraph nodes={wf || []} name={open} onBack={() => setOpen(null)} />;
  };

  // ── 工作流列表 ────────────────────────────────────────────────
  const renderWfList = () => (
    <div className='cm-list'>
      <div className='cm-bar'>
        <span className='cm-title'>工作流</span>
        <span className='cm-count'>{rows.length} 份</span>
        {query && <span className='cm-count'>· 命中 {visible.length}</span>}
        <span className='cm-gap' />
        <button className='cm-btn' onClick={() => setSort(sort === 'name' ? 'size' : 'name')}>
          {sort === 'name' ? '按名字' : '按大小'}
        </button>
        <button className='cm-btn' onClick={() => void refresh()}>刷新</button>
      </div>
      <div className='cm-search'>
        <input value={query} placeholder='搜名字或描述…' onChange={(e) => setQuery(e.target.value)} />
      </div>
      {wfLoaded && !rows.length && (
        <div className='cm-empty'>
          还没有工作流。在 ComfyUI 里导出（API）后存进来，或让助手用 comfyui_workflow 存一份。
        </div>
      )}
      {rows.length > 0 && !visible.length && <div className='cm-empty'>没有匹配「{query}」的工作流。</div>}
      {visible.map((r) => (
        <div className={(open === r.name ? 'cm-row cm-row-click is-sel' : 'cm-row cm-row-click')}
          key={r.name} onClick={() => setOpen(r.name)} title='点击查看接线图'>
          <div className='cm-row-main'>
            {renaming === r.name ? (
              <input className='cm-name-in' autoFocus value={renameTo}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenameTo(e.target.value)}
                onBlur={() => void doRename()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void doRename();
                  if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); }
                }} />
            ) : (
              <span className='cm-row-name' title='点名字改名'
                onClick={(e) => { e.stopPropagation(); setRenaming(r.name); setRenameTo(r.name); setNoting(null); }}>
                {r.name}
              </span>
            )}
            <span className='cm-row-size'>{kb(r.size)}</span>
            <button className='cm-del' title='删除这份工作流'
              onClick={(e) => { e.stopPropagation(); setConfirmDel(confirmDel === r.name ? null : r.name); }}>✕</button>
          </div>
          {confirmDel === r.name && (
            <div className='cm-confirm' onClick={(e) => e.stopPropagation()}>
              删掉「{r.name}」？此操作不可撤销。
              <button className='cm-btn cm-danger' onClick={() => void doDelete(r.name)}>删除</button>
              <button className='cm-btn' onClick={() => setConfirmDel(null)}>取消</button>
            </div>
          )}
          {noting === r.name ? (
            <div className='cm-edit cm-edit-col' onClick={(e) => e.stopPropagation()}>
              <textarea autoFocus rows={2} value={noteDraft} placeholder='这份工作流是干什么的…'
                onChange={(e) => setNoteDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setNoting(null); }} />
              <div className='cm-edit-acts'>
                <button className='cm-btn cm-primary' onClick={() => void saveNote()}>保存</button>
                <button className='cm-btn' onClick={() => setNoting(null)}>取消</button>
              </div>
            </div>
          ) : (
            <div className={meta.workflows[r.name] ? 'cm-row-note cm-row-edit' : 'cm-row-note cm-row-edit cm-row-addnote'}
              title='点这里加/改描述'
              onClick={(e) => { e.stopPropagation(); setNoting(r.name); setNoteDraft(meta.workflows[r.name] || ''); setRenaming(null); }}>
              {meta.workflows[r.name] || '＋ 加描述'}
            </div>
          )}
        </div>
      ))}
    </div>
  );

  // ── 模型页 ────────────────────────────────────────────────────
  const renderModels = () => {
    const kinds = snap.kinds || {};
    const ckpts = (kinds.checkpoint || []).slice().sort((a, b) => a.localeCompare(b));
    const stamp = snap.at ? new Date(snap.at).toLocaleString('zh-CN') : '';
    const noStyle = ckpts.filter((n) => !styleOf(n)).length;
    const refreshModels = async () => {
      await sendCmd([{ action: 'refresh_models' }]);
      flash('已请求刷新模型清单…');
      setTimeout(() => void refresh(), 1200);
    };
    return (
      <div className='cm-list'>
        <div className='cm-bar'>
          <span className='cm-title'>模型</span>
          <span className={snap.up ? 'cm-ok' : 'cm-warn'}>● {snap.up ? '已连接' : '未连接'}</span>
          {snap.url && <span className='cm-count cm-mono'>{snap.url}</span>}
          <span className='cm-gap' />
          <button className='cm-btn' onClick={() => void refreshModels()}>刷新</button>
        </div>
        <div className='cm-count' style={{ marginBottom: 8 }}>
          {stamp ? '快照 ' + stamp : '还没拉到快照'}
          {ckpts.length ? ' · ' + ckpts.length + ' 个 checkpoint' : ''}
          {noStyle ? ' · ' + noStyle + ' 个没写风格' : ''}
        </div>
        {!ckpts.length && (
          <div className='cm-empty'>
            {snap.up
              ? '连上了，但服务器没报出 checkpoint 清单 —— 点上面的刷新再试。'
              : '连不上 ComfyUI 就拿不到清单。先确认它开着（助手用 comfyui_launch 能起），再点刷新。'}
          </div>
        )}
        {ckpts.map((n) => (
          <div className='cm-row' key={n}>
            <div className='cm-row-main'>
              <span className='cm-row-name cm-mono'>{n}</span>
            </div>
            {styleFor !== n && (
              styleOf(n)
                ? <div className='cm-row-note'>{styleOf(n)}</div>
                : <div className='cm-row-note cm-row-note-muted'>（还没写风格描述）</div>
            )}
            <div className='cm-row-acts'>
              <button className='cm-btn' onClick={() => {
                setStyleFor(styleFor === n ? null : n);
                setStyleDraft(typeof meta.models[n] === 'string' ? meta.models[n] : defaultStyle(n));
              }}>
                {styleFor === n ? '收起' : (styleOf(n) ? '改风格' : '加风格')}
              </button>
            </div>
            {styleFor === n && (
              <div className='cm-edit cm-edit-col'>
                <textarea autoFocus rows={3} value={styleDraft} placeholder='这个模型适合画什么、采样参数怎么给…'
                  onChange={(e) => setStyleDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') setStyleFor(null); }} />
                <div className='cm-edit-acts'>
                  <button className='cm-btn cm-primary' onClick={() => void saveStyle()}>保存</button>
                  <button className='cm-btn' onClick={() => setStyleFor(null)}>取消</button>
                </div>
              </div>
            )}
          </div>
        ))}
        {(['lora', 'vae'] as const).map((k) => (
          (kinds[k] || []).length > 0 && (
            <div className='cm-group' key={k}>
              <div className='cm-group-title'>{k === 'lora' ? 'LoRA' : 'VAE'}（{(kinds[k] || []).length}）</div>
              <div className='cm-group-body'>
                {(kinds[k] || []).map((m) => <span className='cm-chip cm-mono' key={m}>{m}</span>)}
              </div>
            </div>
          )
        ))}
      </div>
    );
  };

  return (
    <div className='cm-root'>
      <div className='cm-tabs'>
        <button className={tab === 'wf' ? 'cm-tab is-on' : 'cm-tab'} onClick={() => setTab('wf')}>
          工作流{rows.length ? ' ' + rows.length : ''}
        </button>
        <button className={tab === 'models' ? 'cm-tab is-on' : 'cm-tab'} onClick={() => setTab('models')}>模型</button>
        <span className='cm-gap' />
        {tip && <span className={warn ? 'cm-tip cm-tip-warn' : 'cm-tip'}>{tip}</span>}
      </div>
      <div className={tab === 'wf' ? 'cm-body cm-split' : 'cm-body'}>
        {tab === 'wf' ? (
          <>
            <div className='cm-pane-left'>
              {renderWfList()}
              <RulesPanel rules={rules} draft={ruleDraft} onDraft={setRuleDraft}
                onAdd={() => void addRule()} onRemove={(no) => void delRule(no)} />
            </div>
            <div className='cm-pane-right'>{renderWiring()}</div>
          </>
        ) : renderModels()}
      </div>
    </div>
  );
}
