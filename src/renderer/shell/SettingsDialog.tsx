import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type CatalogProvider, type CatalogModel, type ClosedRef, type ComponentRef, type ExtSnapshot, type ModelPick, type Panel, type PluginSettingsRef, type PluginSettingsView, type ProviderDraft } from '../core/api';
import { IconClose, IconFolderOpen } from '../ui/icons';
import { panelType } from '../panel/registry';
import { useGlobalZoom } from '../ui/ZoomOverlay';
import { THEME_COLORS, FONTS_UI, FONTS_CODE, ZOOM_STEPS, getThemeMode, getThemeColor, setTheme, setThemeColor, getFontUi, setFontUi, getFontCode, setFontCode, getMotion, setMotion, getGlass, setGlass, getToolStepMode, setToolStepMode, getCodeWorkView, setCodeWorkView, onAppearance, type FxMode, type ToolStepMode } from '../ui/theme';
import { getSurfaceOpacity, setSurfaceOpacity } from '../ui/theme';
import { type PluginInfo, type PluginParamDecl } from '../../shared/types';
import { t, localeTag, LANGS, getLang, setLang, onLang } from '../core/i18n';





/**
 * 设置：点齿轮弹出来的卡片。
 *
 * 模型这块照着 harness 那套来：**提供方列表 → 编辑（密钥 / 地址 / 模型目录）**，
 * 加上"添加提供方 / 添加自定义提供方"。配置存在自己的 providers.json 里（JSON，不是 yaml）。
 * 密钥只会往主进程里进，界面上永远显示"已配置"，读不回来。
 */
/**
 * 设置分页。项目一多，一长条滚到底是没法用的 —— 每类各占一页，左边是导航。
 *
 * 工作区和权限都不在这里：它们贴在别处更顺手 ——
 * 工作区在左上角选（它是"当前在哪个项目"，长期概念），
 * 权限在输入框那一排（它是"这一句发出去能碰什么"，发之前就该看见）。
 * 收纳区和历史放这儿：它们是回头翻的东西，不是每时每刻要盯的。
 */
/**
 * 一列可展开的行共用的一套状态：**开几条显示几条**，互不顶掉。
 * 以前是「一次只展开一个」，结果想对照两条说明就得来回点。
 */
function useOpenKeys() {
  const [keys, setKeys] = useState<string[]>([]);
  return {
    has: (k: string) => keys.includes(k),
    toggle: (k: string) => setKeys((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k])),
    drop: (k: string) => setKeys((ks) => ks.filter((x) => x !== k)),
    /** 删掉第 i 条之后，比它大的下标整体上移一位 */
    shiftAfterDrop: (i: number) =>
      setKeys((ks) => ks.filter((k) => Number(k) !== i).map((k) => (Number(k) > i ? String(Number(k) - 1) : k))),
  };
}

/**
 * 内置那几页，**顺序就是导航上的顺序**。
 *
 * 「通用设置」（原「外观」）摆在最前面：主题、字号这些是进来第一眼就要调的东西。
 * 「插件」紧挨着「模型」—— 都是“给助手加能力”，一个加模型、一个加手脚；
 * 插件开的那些分区不在这张表里：它们统一排在最后、由一条分割线隔开（见 nav）。
 */
const PAGES = [
  { id: 'look', label: '通用设置', desc: '主题、配色、字体、尺寸与效果' },
  { id: 'model', label: '模型', desc: '各路提供方，以及它们的密钥与模型目录' },
  { id: 'plugins', label: '插件', desc: '给助手加工具，参数就地改' },
  { id: 'components', label: '组件', desc: '被声明过的面板都在这儿，关不关都在' },
  { id: 'closed', label: '历史会话', desc: '没被声明成组件的会话，关掉后落在这儿' },
  { id: 'skills', label: '技能', desc: '按需取用的说明，只带名字进提示' },
  // 「更多」排在**插件分区之后**：它是外置资源那一堆（镜像、Python、离线套件），
  // 跟 agent / MCP 这些"装上去才有"的分区是一家人，跟上面那几页内置的不是。
  { id: 'more', label: '更多', desc: '扩展生态：安装外置包与精选离线模型套件' },
] as const;

type PageId = (typeof PAGES)[number]['id'];

/**
 * 侧栏里的一页，可能是内置的，也可能是**插件开的**。
 *
 * 插件开的那几页分两拨：跟着软件来的（原生插件，比如 agent）紧接在内置页后面；
 * **要下载外部资源**的（语音输入、MCP 这种）坠在最末，前面用一条分割线（`sep`）隔开 ——
 * 它们是后来装上去的，装一个、内置那几页就得整体往下挪一格，用惯的人每次都得重新找。
 * id 用 `plugin:插件名:分区id`：两种页共用一套"当前在哪一页"的状态，不用再分一个维度。
 */
type NavPage = {
  id: string;
  label: string;
  desc: string;
  plugin?: { plugin: string; section: string };
  /** 这一条是分割线、不是页：内置那几页与插件分区之间那一道 */
  sep?: true;
  /** 插件分区声明的锚点：想排在哪一页正下方（见 PluginSettingsRef.after） */
  after?: string;
};

const pluginPageId = (plugin: string, section: string) => `plugin:${plugin}:${section}`;

/**
 * 切换分区时让整张卡片顺着新布局撑开 / 收起，而不是瞬间换一副骨架。
 *
 * 卡在哪一层：设置卡片的高是**由内容顶出来的**，所以让里面这一格动起来，卡片就跟着动。
 * 别只过渡 max-height —— **上界拦不住变矮**：内容一短当场就缩回去了，得动真正的高度。
 *
 * 高度从哪来：`height: auto` 插不了值，没法直接过渡；给死一个高度又会把内容硬裁进框里。
 * 所以每切一次量一对：**起点**在点导航那一刻量（那时 DOM 还停在旧页），
 * **终点**等新页落进 DOM、还没画到屏幕上时（useLayoutEffect）量。两个都是实实在在的像素值，
 * 浏览器才有得插值。量终点前要先把行内高度松开，不然量到的是上一次钉住的数。
 *
 * `ready` 是给**异步内容**留的（插件开的那些分区）：切过去的时候正文还没取回来，
 * 那一刻页是空的、矮的 —— 那不是它该有的高度。这时候别量也别过渡，就停在旧高度上等着；
 * 等内容到齐了再量一次、一口气撑开。不这么办的话，高度会被量两遍（先矮后高），
 * 看上去就是切过去以后又抽一下。
 *
 * 过渡跑完就撤掉行内高度、交回 auto：往后内容自己再长（展开一行、数据加载出来）
 * 不会被困在某个数字里。
 */
function usePaneStretch(pageId: string, ready: boolean) {
  const re = useRef<HTMLDivElement>(null);
  /** 切换前那一刻量到的旧高度；`null` 表示这次切换没量过（比如刚打开） */
  const fromRef = useRef<number | null>(null);
  /** 松口的那一帧；切换再来一次之前先撤掉，免得上一次的回调把这一次改回去 */
  const rafRef = useRef(0);

  /**
   * 点导航的那一刻调 —— **DOM 还停在旧页**，这时候量到的才是这次过渡的起点。
   * 放到 effect 里去量就晚了：那时 React 已经把新页渲染进去了，量出来是新高度，
   * 起点和终点一样，过渡自然一步都不动。
   */
  const capture = () => {
    const el = re.current;
    if (el) fromRef.current = el.offsetHeight;
  };

  useLayoutEffect(() => {
    const el = re.current;
    if (!el) return;

    // 内容还没到齐：这一刻的矮不是真的矮，量了就跑偏。别动它，把高度停在切换前那个数上，
    // 起点也留着别消费 —— 等内容到齐那一次，再从这个高度一口气撑到真正的高度
    if (!ready) {
      cancelAnimationFrame(rafRef.current);
      if (fromRef.current != null) el.style.height = `${fromRef.current}px`;
      return;
    }

    cancelAnimationFrame(rafRef.current);
    const from = fromRef.current;
    fromRef.current = null;
    // 松开行内高度，量这一页的自然高度。中间会重排一下，但还没到画的那一步，屏幕上看不见
    el.style.height = '';
    const to = el.offsetHeight;

    // 没有旧高度起点（如初次打开未点导航）或高度一致、以及开启了减弱动效偏好时不播放过渡
    if (from == null || from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // 起点钉在旧高度上，**并强制读一次**让浏览器认下这个值：
    // 只设不读的话，它记着的起点还是刚才那个 auto，而 auto 插不了值，过渡压根不会开始
    el.style.height = `${from}px`;
    void el.offsetHeight;
    // 下一帧再松到新高度 —— 两个像素值之间，浏览器才有得插值
    rafRef.current = requestAnimationFrame(() => {
      el.style.height = `${to}px`;
    });
  }, [pageId, ready]);

  // 过渡一跑完就撤掉写死的高度，交回 auto：往后内容自己再长（展开一行、数据加载出来）
  // 不会被困在某个数字里。只认自己这一格、只认 height —— 子元素上的过渡也会冒泡到这儿来
  const settle = (e?: React.TransitionEvent<HTMLDivElement>) => {
    if (e && (e.target !== e.currentTarget || e.propertyName !== 'height')) return;
    if (re.current) re.current.style.height = '';
  };
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  return { re, settle, capture };
}

export function SettingsDialog({ onClose }: { onClose(): void }) {
  const [page, setPage] = useState<string>('look');
  // 界面缩放：改一下就地落盘、所有窗口一起跟上（真值由主进程钳过再回来）
  const zoom = useGlobalZoom();
  /** 外观一改（本窗口、别的窗口、系统）就重渲染一次 —— 下面几样都从真源现读 */
  const [, bumpLook] = useState(0);
  useEffect(() => onAppearance(() => bumpLook((n) => n + 1)), []);
  const themeMode = getThemeMode();
  const themeColor = getThemeColor();
  const surfaceOpacity = getSurfaceOpacity();
  const fontUi = getFontUi();
  const fontCode = getFontCode();
  const motion = getMotion();
  const glass = getGlass();
  const toolStepMode = getToolStepMode();
  const codeWorkView = getCodeWorkView();
  const [info, setInfo] = useState<{
    workspace: string;
    configPath: string;
    model: ModelPick;
    providers: CatalogProvider[];
  } | null>(null);
  /** 展开着的提供方表单：点谁就落在谁自己那一行下面，想同时编辑几个都行 */
  const [editing, setEditing] = useState<ProviderDraft[]>([]);
  const [adding, setAdding] = useState(false);
  const [presets, setPresets] = useState<ProviderDraft[]>([]);
  const [ext, setExt] = useState<ExtSnapshot | null>(null);
  /** 技能页里展开着的那几条 —— 详情（说明全文 + 正文）就地落在各自下面，开几条显示几条 */
  const openSkill = useOpenKeys();
  const [cmps, setCmps] = useState<ComponentRef[]>([]);
  const [closed, setClosed] = useState<ClosedRef[]>([]);
  const [panels, setPanels] = useState<Panel[]>([]);
  const [saveFrom, setSaveFrom] = useState('');
  const [saveName, setSaveName] = useState('');
  /** 导出 / 导入那两下刚才的结果（成功、失败、取消），就地显示在组件页顶上 */
  const [packMsg, setPackMsg] = useState('');

  /** 正在改名的那一条（点名字进去，回车/失焦落定，Esc 撤） */
  const [renaming, setRenaming] = useState('');
  const [renameText, setRenameText] = useState('');
  /** Esc 那一刻置上：让紧跟着的 blur 别把它当成「改完了」提交 */
  const cancelRename = useRef(false);
  /**
   * 组件页的两处来源：本机面板本体目录、工作区做法目录，各几条。
   *
   * 这一页空着的时候必须能回答"**为什么空**" —— 是这台机器上本来就没有那些本体
   * （换台机器刚 clone 下来就是这样），还是工作区里那几份做法也没读到（多半工作区指错了）。
   * 把路径和条数摊在界面上，就不用谁去猜。
   */
  const [cmpWhere, setCmpWhere] = useState<{
    bodyDir: string;
    bodyCount: number;
    craftDir: string;
    craftCount: number;
  } | null>(null);
  /**
   * 「这份软件自己住在哪个目录」+ 现在的工作区是哪条。
   *
   * 工作区存在 userData 里、在仓库外面 —— 重建软件不会动它，于是"新建一份仓库、
   * 整个重来一遍"起来的还是原来那条路。两个路径一对不上，组件页空着就说得通了，
   * 也就地点一下换过来，不用谁去翻文件。
   */
  const [selfWs, setSelfWs] = useState<{ dir: string; workspace: string } | null>(null);


  /** 插件页里展开着的插件 —— 参数一摆开挺长，但开几个显示几个，互不顶掉 */
  const openPlugin = useOpenKeys();
  /** 插件在设置里开的那些分区（导航用）：插件刚装上/刚改完都要能看见，所以进这张卡时拉一次 */
  const [sections, setSections] = useState<PluginSettingsRef[]>([]);
  /** 当前这个插件分区的内容 + 上一次点按钮的回执（切页时清掉回执，别让它赖在别的页上） */
  const [sectionView, setSectionView] = useState<PluginSettingsView | null>(null);
  const [sectionBusy, setSectionBusy] = useState('');
  /**
   * 行内文本框里**用户正打着**的字，按行 id 存。
   *
   * 为什么非得存一份（踩过）：输入框以前是 defaultValue（不受控），值只在 DOM 里；
   * 而那一行的「安装」按钮走的是另一条路（只递动作 id，拿不到 DOM 里的字）——
   * 于是**点按钮完全没反应**，只有回车能装。存成受控的，两边才拿得到同一个值。
   */
  const [inlineText, setInlineText] = useState<Record<string, string>>({});
  /** 插件分区的内容取回来没有 —— 取回来之前那一页是空的，不该按那个高度去做过渡 */
  const [sectionLoaded, setSectionLoaded] = useState(false);
  /** 进这张卡要的那批数据拉齐了没有（齐了才把卡片摆出来，见 load 上面那段） */
  const [booted, setBooted] = useState(false);
  const [moreUrl, setMoreUrl] = useState('');
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreFeedback, setMoreFeedback] = useState('');

  // 运行环境、多版本 Python 与网络镜像加速管理
  const [envData, setEnvData] = useState<any>(null);
  const [selectedMirror, setSelectedMirror] = useState('tsinghua');
  const [customPypi, setCustomPypi] = useState('');
  const [customNpm, setCustomNpm] = useState('');
  const [pythons, setPythons] = useState<Array<{ id: string; name: string; path: string; version?: string; available?: boolean }>>([]);
  const [activePythonId, setActivePythonId] = useState('py-default');
  // 盘上躺着、名单里已经没有的解释器目录（删记录不清盘的旧账）
  const [pyOrphans, setPyOrphans] = useState<Array<{ name: string; dir: string; bytes: number; files: number }>>([]);

  // 添加 Python
  const [showAddPy, setShowAddPy] = useState(false);
  const [newPyName, setNewPyName] = useState('');
  const [newPyPath, setNewPyPath] = useState('');

  // 联网下载 Python 状态
  const [downloadVer, setDownloadVer] = useState('3.10.11');
  const [downloadingPy, setDownloadingPy] = useState(false);
  const [pyAddTab, setPyAddTab] = useState<'download' | 'custom'>('download');

  // 依赖安装与终端回显
  const [envBusy, setEnvBusy] = useState(false);
  const [envLog, setEnvLog] = useState('');
  const [pipInput, setPipInput] = useState('');

  const loadEnvData = async () => {
    try {
      const [saved, detected, orphans] = await Promise.all([
        api.env?.get?.().catch(() => null),
        api.env?.detect?.().catch(() => null),
        // 盘上躺着、名单里已经没有的解释器目录：以前删记录不清盘，它们就永远悬在那儿
        api.env?.listOrphans?.().catch(() => []) as Promise<Array<{ name: string; dir: string; bytes: number; files: number }>>,
      ]);
      setPyOrphans(Array.isArray(orphans) ? orphans : []);
      if (saved) {
        if (saved.mirror) setSelectedMirror(saved.mirror);
        if (saved.customPypi) setCustomPypi(saved.customPypi);
        if (saved.customNpm) setCustomNpm(saved.customNpm);
        if (saved.activePythonId) setActivePythonId(saved.activePythonId);
        if (Array.isArray(saved.pythons) && saved.pythons.length > 0) {
          setPythons(saved.pythons);
        } else if (detected?.python) {
          const initList = [
            {
              id: 'py-default',
              name: '系统默认 Python',
              path: detected.python.activePath || 'python',
              version: detected.python.version,
              available: detected.python.available,
            },
          ];
          setPythons(initList);
          setActivePythonId('py-default');
        }
      }
      if (detected) {
        setEnvData(detected);
      }
    } catch (_) {}
  };

  const persistEnv = async (patch: any) => {
    try {
      const current = await api.env?.get?.().catch(() => ({}));
      const next = { ...current, ...patch };
      await api.env?.save?.(next);
      await loadEnvData();
    } catch (_) {}
  };

  /**
   * 横线下面那一批（要下载外置资源的）—— 顺序按这张表来，不按插件目录的字母序。
   *
   * 为什么要有这张表：字母序会把它们排错位，插件页的顺序得由这张表说了算。
   * 表里没写的排在后面。
   */
  const EXTERNAL_ORDER = ['mcp', 'computer-control', 'browser'];
  const SECTION_EXTERNAL = new Set(EXTERNAL_ORDER);
  /**
   * 「要下载才有」的那几个 —— 跟上面那张**不是一回事**：
   * 那张管的是"分区排在横线下面"，这张管的是"插件没部署就先别列进插件页"。
   * 自带的分区排在横线下面，但**不该从插件页里消失**。
   */
  const DOWNLOADABLE = new Set(['computer-control', 'mcp', 'browser']);
  const extRank = (p: string) => {
    const i = EXTERNAL_ORDER.indexOf(p);
    return i < 0 ? EXTERNAL_ORDER.length : i;
  };
  const sectionPages = (external: boolean) =>
    sections
      .filter((s) => SECTION_EXTERNAL.has(s.plugin) === external)
      .sort((a, b) => (external ? extRank(a.plugin) - extRank(b.plugin) : 0))
      .map((s) => ({
        id: pluginPageId(s.plugin, s.id),
        label: s.label,
        desc: s.hint || `${s.plugin} 插件开的设置页`,
        plugin: { plugin: s.plugin, section: s.id },
        after: s.after,
      }));
  const extPages = sectionPages(true);

  /**
   * 内置那几页 + 插件开的那些 —— 侧栏画的就是它。
   *
   * 「更多」的位置是**那条横线上方的最后一个**：它紧跟在 agent 后面、排在
   * 分割线之前。横线下面那一批是"要下载外置资源的"（MCP 与扩展插件），
   * 「更多」自己讲的是镜像 / Python / 离线套件，跟它们是同一类话题，
   * 所以它守在横线上沿收尾 —— **不是整页最末**（那会被当成又一个外置分区）。
   */
  const builtinPages = PAGES.filter((p) => p.id !== 'more').map((p) => ({ id: p.id, label: p.label, desc: p.desc }));
  const morePage = PAGES.find((p) => p.id === 'more')!;

  /*
   * 插件开的那些分区，怎么摆：
   *
   *   声明了 after 的      → **插到那一页的正下方**（如「模型」下面那个"桌面组件"，
   *                        它跟模型一样属于"进来第一眼要调的东西"，不该隔着一整列）
   *   没声明 / 认不出的     → **统一收尾**（在「更多」之后、横线之前）
   *
   * 收尾那一批为什么不按 id 的字母序散进去：它们是"装上去才有"的东西，用户不会去记
   * 它在第几行；固定在末尾，位置就不随别处增删而漂。
   */
  const allSections = sectionPages(false);
  const builtinIds = new Set(builtinPages.map((p) => p.id));
  /*
   * 认不出的锚点（页名写错、那一页被砍了）**当没声明**，掉回收尾那一批。
   *
   * 这一条必须守住：锚点只是"排得好看点"的诉求，而丢页是真丢东西 ——
   * 插件的入口在侧栏上没了，用户连点进去看看的机会都没有，还不会报错。
   */
  const anchored = allSections.filter((p) => p.after && builtinIds.has(p.after));
  const loose = allSections.filter((p) => !(p.after && builtinIds.has(p.after)));
  const nav: NavPage[] = [];
  for (const page of builtinPages) {
    nav.push(page);
    for (const a of anchored) if (a.after === page.id) nav.push(a);
  }
  nav.push(...loose);
  nav.push({ id: morePage.id, label: morePage.label, desc: morePage.desc });
  // 那条线只在**真有需要下载的插件分区**时才画：末了光秃秃挂一条线，看着像出错
  if (extPages.length) nav.push({ id: 'sep', label: '', desc: '', sep: true as const });
  nav.push(...extPages);
  const here = nav.find((p) => p.id === page) ?? nav[0];
  /** 切分区时整张卡片的伸缩动画，见 usePaneStretch */
  const stretch = usePaneStretch(page, !here.plugin || sectionLoaded);
  /**
   * 插件分两拨摆：**声明了参数的一拨、没声明的另一拨**。
   *
   * 为什么分：一屏四十来个插件平铺，"哪些是能调的"全靠一个个点开看。
   * 分完在最上面就一眼看得见 —— 有参数的那组才是要进来动手的地方，
   * 其余的是纯后台插件，装在那儿不用管。
   */
  const rawPlugins = ext?.plugins ?? [];
  const allPlugins = rawPlugins;
  const officialPlugins = allPlugins.filter((p) => p.source === 'app');
  const installedPlugins = allPlugins.filter((p) => p.source === 'workspace');
  const tunable = allPlugins.filter((p) => p.params.length > 0);
  const fixed = allPlugins.filter((p) => p.params.length === 0);
  const [showAddPluginModal, setShowAddPluginModal] = useState(false);
  const [npmOrUrl, setNpmOrUrl] = useState('');
  const [installMsg, setInstallMsg] = useState('');
  const [installing, setInstalling] = useState(false);

  /** 当前这一页的开头那两行：分区名 + 一句话说明 */
  const pageHead = (
    <div className="set-head">
      <div className="set-head-title">{t(here.label)}</div>
      <div className="set-head-desc">{t(here.desc)}</div>
    </div>
  );

  /**
   * 进这张卡要的那批数据 —— **一把取齐了才让卡片出场**。
   *
   * 插件在设置里开的那些分区（导航里的 agent 就在其中）也在这批里：它从前是坠在最后、
   * 单独一个 await，于是卡片先按「没有那几条」的样子摆出来，等它回来导航中间才多出一项、
   * 旁边几行的位置跟着挪一下 —— 看着就是后加载出来的。
   *
   * 现在不等齐不出场（见下面 booted）—— 但**七条必须并发**。
   * 从前它们是七个串行 await：每条都要单独占一次 IPC 的来回，而主进程那边只要有人在
   * 存盘 / 广播（十几 MB 的状态），后面六条就全排在队列里等 —— 串行七趟叠出来就是
   * "点一下齿轮要等一秒"。并发发出去只占**一趟**来回，谁快谁先回来，总耗时以最慢那条为准。
   */
  
  /**
   * 装一个 .ensoulpack 扩展包。
   *
   * **解析、校验、落盘全在主进程**：渲染层没有 require / zlib（窗口是 sandbox +
   * contextIsolation，而 vite 只处理 import、把 require 原样搬进产物）——
   * 从前这里 await import 一份共享 CJS，一点就 "require is not defined"，
   * 导出的包装不回来。这里只剩三件事：选文件、把字节递上去、把回执念出来。
   *
   * 两趟 IPC：inspect 先算清单给用户过目（规范 §6：先弹清单再落盘），install 才写。
   * 同一份字节走同一个计划函数，看到的和写下去的必然是同一批文件。
   */
  const handleInstallEnsoulPack = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 同一个文件连选两次也得能再触发一次
    if (!file) return;
    try {
      setMoreLoading(true);
      setMoreFeedback(t("正在解析扩展包..."));
      const bytes = await file.arrayBuffer();
      const look = await api.ext.inspectPack(bytes);
      if (!look.ok) {
        setMoreFeedback(t("安装失败：") + (look.error || ""));
        return;
      }
      const files = (look.files || []).map((f) => "  • " + f).join("\n");
      const yes = window.confirm(
        t("安装插件「{name}」({id} v{ver})\n\n即将写入文件：\n{files}\n\n是否确认安装到工作区扩展目录？", {
          name: String(look.name || look.id || ''),
          id: String(look.id || ''),
          ver: look.version || "1.0.0",
          files,
        }),
      );
      if (!yes) {
        setMoreFeedback(t("已取消安装"));
        return;
      }
      const r = await api.ext.installPack(bytes);
      if (!r.ok) {
        setMoreFeedback(t("安装失败：") + (r.error || ""));
        return;
      }
      await load();
      setMoreFeedback(t("插件「{name}」安装成功！", { name: r.name || r.id || "" }));
    } catch (err: any) {
      setMoreFeedback(t("读取包失败：") + (err?.message || err));
    } finally {
      setMoreLoading(false);
    }
  };
;

  const load = async () => {
    try {
      const [infoV, extV, cmpsV, whereV, selfV, closedV, ws] = await Promise.all([
        api.settings.get(),
        api.ext.list(),
        api.components.list(),
        api.components.where(),
        api.workspace.self(),
        api.closed.list(),
        api.workspace.get(),
      ]);
      setInfo(infoV);
      setExt(extV);
      setCmps(cmpsV);
      setCmpWhere(whereV);
      setSelfWs(selfV);
      setClosed(closedV);
      setPanels(Object.values(ws.panels));
      // 插件分区单独一条（它要扫插件目录）—— 与上面那批同时在路上
      setSections(await api.ext.sections());
    } finally {
      // 读失败了也得放卡片出来 —— 缺的那几页各有各的兜底，总比整张卡没入口强
      setBooted(true);
    }
  };

  /** 进一个插件分区 / 点完它的按钮之后：把这一页此刻的内容拉回来 */
  const loadSection = async (plugin: string, section: string) => {
    // 内容来之前先记住这一刻的高度，取回来以后再由它撑开（见 usePaneStretch 的 ready）
    stretch.capture();
    try {
      setSectionView(await api.ext.section(plugin, section));
    } finally {
      // 拉失败也得放行，不然这一页会一直被"还没到齐"钉在旧高度上
      setSectionLoaded(true);
    }
  };

  const gotoPage = (id: string) => {
    // 先量起点：这一刻 DOM 还停在旧页上，量到的才是这次过渡该从哪儿开始
    if (id !== page) stretch.capture();
    setPage(id);
    setSectionView(null);
    setSectionBusy('');
    setSectionLoaded(false);
    const p = nav.find((x) => x.id === id);
    if (p?.plugin) void loadSection(p.plugin.plugin, p.plugin.section);
  };

  /** 导航上那个数字：分区有多少条（插件在 ext:sections 里顺手算好的） */
  const sectionCount = (plugin: string, section: string) =>
    sections.find((s) => s.plugin === plugin && s.id === section)?.count ?? 0;

  /**
   * 行内“挑模型”那个下拉的可选项 —— 真源是软件里配好的模型清单。
   *
   * 界面自己算一遍、不向插件要：插件交上来的只是“这个人此刻用的是哪个”，
   * “有哪些可挑”是软件级的事实，两边各管一半，谁也不必去读对方的账。
   */
  const modelChoices = (info?.providers ?? []).flatMap((p) =>
    (p.models ?? []).map((m) => ({ value: `${p.key}::${m.id}`, label: `${p.label} / ${m.name}` })),
  );

  const runSectionAction = async (actionId: string, rowId: string) => {
    if (!here.plugin) return;
    setSectionBusy(`${actionId}:${rowId}`);
    const r = await api.ext.sectionAction(here.plugin.plugin, here.plugin.section, actionId, rowId);
    if (r.view) setSectionView(r.view);
    setSectionBusy('');
    // 这些动作多半动了面板（叫到岗、摆到布局）—— 顺手把下面几个下拉要的清单刷一遍
    setPanels(Object.values((await api.workspace.get()).panels));
    setCmps(await api.components.list());
  };

  /**
   * 把行内那一格里的字交出去 —— **回车和「安装」按钮共用这一条路**。
   *
   * 以前只有回车通得了：按钮只递一个光秃秃的动作 id，插件那边只认 `动作:值`，
   * 于是点「安装」什么都不发生（既不报错、也不装）。用户看见的就是一个死按钮。
   */
  const submitInlineText = (row: PluginSettingsView['rows'][number]) => {
    const raw = String(inlineText[row.id] ?? row.value ?? '').trim();
    const a = (row.actions ?? [])[0];
    if (!raw || !a) return;
    void runSectionAction(`${a.id}:${raw}`, row.id);
  };

  const reopen = async (id: string) => {
    await api.panel.reopen(id);
    setClosed(await api.closed.list());
    setPanels(Object.values((await api.workspace.get()).panels));
  };

  const forget = async (id: string) => setClosed(await api.panel.forget(id));

  const saveCmp = async () => {
    if (!saveFrom) return;
    await api.components.declare(saveFrom, saveName);
    setSaveName('');
    setSaveFrom('');
    setCmps(await api.components.list());
    // 面板继续开着（声明不从布局里摘东西），但标题/类型可能在别的窗口刚改过，顺手刷一遍下拉
    setPanels(Object.values((await api.workspace.get()).panels));
  };

  const newFromCmp = async (id: string) => {
    await api.components.create(id);
    // 打开 = 把面板放回布局；条目是入口，一直留着（开着的高亮归条自己画，这里刷新面板下拉）
    setCmps(await api.components.list());
    setPanels(Object.values((await api.workspace.get()).panels));
  };

  /** 唯一的删除入口：真删（连对话记录一起），必须用户在这一页点头 */
  const delCmp = async (id: string) => {
    const c = cmps.find((x) => x.id === id);
    if (!window.confirm(`彻底删除组件「${c?.component || c?.name || id}」？\n这是真删 —— 它那份对话记录一起没了，放不回来。\n（只想让它从顶上那条收纳区撤下来、内容留着，用「从顶栏释放」；\n克隆出来的别的实例各是各的，不受影响。）`)) return;
    setCmps(await api.components.remove(id));
    setPanels(Object.values((await api.workspace.get()).panels));
  };

  /** 点名字进改名 */
  const startRename = (c: ComponentRef) => {
    setRenaming(c.id);
    setRenameText(c.component || c.name);
    cancelRename.current = false;
  };

  /** 改名：声明名和面板标题一起改（做法文件跟着走），空名或没变就当没发生 */
  const commitRename = async (id: string) => {
    const c = cmps.find((x) => x.id === id);
    const next = renameText.trim();
    setRenaming('');
    if (!c || !next || next === (c.component || c.name)) return;
    const ok = await api.components.rename(id, next);
    if (!ok) {
      window.alert('改名没写进去 —— 本体或做法文件写不了，名字还是原来的。');
      return;
    }
    setCmps(await api.components.list());
    setPanels(Object.values((await api.workspace.get()).panels));
  };

  const pinCmp = async (id: string) => {
    await api.components.pin(id);
    setCmps(await api.components.list());
  };
  const unpinCmp = async (id: string) => {
    await api.components.unpin(id);
    setCmps(await api.components.list());
  };

  /** 克隆一块新的：新面板、新对话线程，原件一个字节不动 */
  const cloneCmp = async (id: string) => {
    await api.components.clone(id);
    setCmps(await api.components.list());
    setPanels(Object.values((await api.workspace.get()).panels));
  };

  /**
   * 把这一条**导出一个文件** —— 导的是做法，**对话不带**（那是这台机器上的工作记录）。
   * 文件选择器由主进程弹（渲染进程碰不到系统对话框），所以这一步只是等一个结果。
   */
  const exportCmp = async (id: string) => {
    const r = await api.components.exportPack(id);
    if (r.canceled) return;
    if (!r.ok) {
      setPackMsg(`导出失败：${r.error || '不知道什么原因'}`);
      return;
    }
    setPackMsg(`已导出到 ${r.path}（${Math.max(1, Math.round((r.bytes ?? 0) / 1024))} KB）—— 只有做法、不带对话；换台机器在「设置 → 组件」里点「导入组件」就能用它。`);
  };

  /** 导入一个组件文件 —— 变成这一页里的新一条（新面板 id，跟原件各是各的） */
  const importCmp = async () => {
    const r = await api.components.importPack();
    if (r.canceled) return;
    if (!r.ok) {
      setPackMsg(`导入失败：${r.error || '不知道什么原因'}`);
      return;
    }
    setPackMsg(`已导入组件「${r.name}」—— 就在下面这份清单里。`);
    setCmps(await api.components.list());
    setPanels(Object.values((await api.workspace.get()).panels));
  };

  /** 工作区指的不是这份代码所在的目录：一把换过来（换完做法、插件、技能都跟着这个根走） */
  const useSelfWs = async () => {
    const d = selfWs?.dir;
    if (!d) return;
    const root = await api.workspace.open(d);
    setPackMsg(`工作区已换成 ${root} —— 做法、插件、技能都跟着这个目录走了；下面这份清单重新扫过了。`);
    await load();
  };





  /**
   * 改一个插件参数。改完不用重启：下一次 loadPlugins 会让那个插件重新 setup 读到新值，
   * 所以这儿只把新清单收下来 —— 界面立刻显示新值，也顺便看得见有没有插件因此报错。
   * 值和"用户点着改"走的是同一份校验（见主进程 setPluginParam）。
   */
  const saveParam = async (plugin: string, key: string, value: string | number | boolean | null) => {
    const r = await api.ext.setParam(plugin, key, value);
    setExt((v) => (v ? { ...v, plugins: r.plugins } : v));
    if (r.error) window.alert(r.error);
  };

  const toggleExt = async (kind: 'skill' | 'plugin', name: string, on: boolean) => {
    const next = await api.ext.toggle(kind, name, on);
    setExt((v) => (v ? { ...v, ...next } : v));
  };

  useEffect(() => {
    // 拉齐了才开口（失败也算齐）—— 免得卡片先按「还没读到插件那几页」的样子摆出来
    void load().finally(() => setBooted(true));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /*
   * 语言一变就把清单重新拉一遍。
   *
   * 插件名、面板类型名、参数说明都是主进程按当时的语言算好送过来的 —— 主进程那边
   * 重挂完插件，这边不重拉就还是旧语言那批字（页面上看着像「切了没生效」）。
   */
  useEffect(() => onLang(() => void load()), []);

  useEffect(() => {
    if (page === 'more') {
      void loadEnvData();
    }
  }, [page]);

  const startAdd = async () => {
    setPresets(await api.providers.presets());
    setAdding(true);
  };

  const startCustom = () => {
    setEditing((es) => [
      ...es,
      {
        key: `p-${Date.now().toString(36)}`,
        label: '自定义',
        api: 'openai-completions',
        baseUrl: '',
        models: [],
      },
    ]);
    setAdding(false);
  };

  /** 列表里那一行 → 一份可编辑的草稿（点它才展开，收起时草稿一并丢掉） */
  const draftFor = (p: CatalogProvider): ProviderDraft => ({
    key: p.key,
    label: p.label,
    api: p.api,
    baseUrl: p.baseUrl,
    models: p.models,
  });

  const toggleEdit = (d: ProviderDraft) =>
    setEditing((es) => (es.some((e) => e.key === d.key) ? es.filter((e) => e.key !== d.key) : [...es, d]));

  const closeEdit = (key: string) => setEditing((es) => es.filter((e) => e.key !== key));

  const removeProvider = async (key: string) => {
    const list = await api.providers.remove(key);
    setInfo((v) => (v ? { ...v, providers: list } : v));
    closeEdit(key);
  };

  const savedProvider = async (list: CatalogProvider[], key: string) => {
    setInfo((v) => (v ? { ...v, providers: list } : v));
    closeEdit(key);
    setAdding(false);
  };

  // 数据没拉齐就先不出场：卡片那 140ms 的弹出动画和这一批读取是同时开始的，
  // 先摆出「内置那几条」的样子、等插件那几页回来再补进去，看着就是后加载出来的
  if (!booted) return null;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{t('设置')}</span>
          <button className="modal-x" onClick={onClose} title={t('关闭')}>
            <IconClose />
          </button>
        </div>

        <div className="settings" ref={stretch.re} onTransitionEnd={stretch.settle}>
          <nav className="set-nav">
            {nav.map((p) =>
              p.sep ? (
                <div key={p.id} className="set-nav-sep" />
              ) : (
                <button key={p.id} className={`set-nav-item${page === p.id ? ' is-on' : ''}`} onClick={() => gotoPage(p.id)}>
                  <span className="set-nav-label">{t(p.label)}</span>
                  {p.id === 'components' && <span className="set-nav-count">{cmps.length}</span>}
                  {p.id === 'closed' && <span className="set-nav-count">{closed.length}</span>}
                  {p.id === 'skills' && <span className="set-nav-count">{ext?.skills.length ?? 0}</span>}
                  {p.id === 'plugins' && <span className="set-nav-count">{ext?.plugins.length ?? 0}</span>}
                  {p.plugin && <span className="set-nav-count">{sectionCount(p.plugin.plugin, p.plugin.section)}</span>}
                </button>
              ),
            )}
          </nav>

          <div className="set-body" data-page={page}>
            {pageHead}
            {here.plugin && (
              <section className="set-block">
                {sectionView?.note && <div className="set-note">{sectionView.note}</div>}
                {sectionView?.reply && <div className="set-note set-note-hi">{sectionView.reply}</div>}
                <div className="ext-list">
                  {(sectionView?.rows ?? []).map((r, i) => (
                    <React.Fragment key={r.id}>
                    <div className={r.role === 'control' ? 'ext-row is-control' : 'ext-row'}>
                      <span className="ext-name">{r.title}</span>
                      <span className="ext-desc">{r.desc || ''}</span>
                      {r.meta && <span className="ext-size">{r.meta}</span>}
                      {/*
                        行内那一格：有些值只在“这一行”上有意义（员工用哪个模型）——
                        真源在别处，可要改它的手就在这儿，不必为改一个下拉跑一趟。
                        新值编进动作 id 交回插件：界面不认识“模型”是什么，只管把这一格的新值递回去。
                      */}
                      {r.inline === 'models' && (
                        <select
                          className="ext-inline"
                          value={r.value || ''}
                          disabled={Boolean(sectionBusy)}
                          title={t('他干活用哪个模型')}
                          onChange={(e) => void runSectionAction(`setModel:${e.target.value}`, r.id)}
                        >
                          <option value="">{r.placeholder || t('未指定（开不了工）')}</option>
                          {modelChoices.map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.label}
                            </option>
                          ))}
                          {/* 提供方被删掉之后，行上那个旧值也得看得见 —— 否则下拉会静悄悄地跳回第一项 */}
                          {r.value && !modelChoices.some((m) => m.value === r.value) && (
                            <option value={r.value}>{`${r.value}（清单里已经没有这一项）`}</option>
                          )}
                        </select>
                      )}
                      {/*
                        行内文本格：安装扩展插件这种操作，输入值无法做成固定选项 ——
                        包名 / GitHub 地址 / 本地路径，用户得自己打字。
                        敲回车就把这一格的内容编进动作 id 交回插件（`<动作>:<内容>`），
                        跟下拉同一套路：界面不认识"包名"是什么，它只负责把字递出去。
                      */}
                      {r.inline === 'text' && (
                        <input
                          className="ext-inline ext-inline-text"
                          type="text"
                          value={inlineText[r.id] ?? r.value ?? ''}
                          placeholder={r.placeholder || ''}
                          disabled={Boolean(sectionBusy)}
                          onChange={(e) => setInlineText((m) => ({ ...m, [r.id]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter') return;
                            // 回车跟右边那颗按钮走同一条路，免得两边行为不一样
                            submitInlineText(r);
                          }}
                        />
                      )}
                      {/*
                        行内开关：有些东西不是一个"值"，是一个**状态** —— 开着就一直在。
                        按钮表达不了它（按一下只是"做一次"），所以给它一颗真正的扣子。
                        on/off 编进动作 id 递回插件，跟下拉、文本框同一套路。
                      */}
                      {r.inline === 'switch' && (
                        <button
                          className={'fx-switch' + (r.value === 'on' ? ' is-on' : '')}
                          disabled={Boolean(sectionBusy)}
                          title={r.value === 'on' ? '关掉' : '打开'}
                          onClick={() => void runSectionAction(`set:${r.value === 'on' ? 'off' : 'on'}`, r.id)}
                        >
                          <i />
                        </button>
                      )}
                      {(r.actions ?? []).map((a) => (
                        <button
                          key={a.id}
                          title={a.hint || ''}
                          disabled={Boolean(sectionBusy)}
                          onClick={() => {
                            // 这一行带文本框（装插件那种）：「安装」得把框里的字一起递出去。
                            // 只递动作 id 的话，插件收到一个光秃秃的 install，什么都不发生。
                            if (r.inline === 'text') submitInlineText(r);
                            else void runSectionAction(a.id, r.id);
                          }}
                        >
                          {sectionBusy.startsWith(`${a.id}:`) ? '…' : a.label}
                        </button>
                      ))}
                    </div>
                    </React.Fragment>
                  ))}
                  {sectionView && sectionView.rows.length === 0 && (
                    <div className="ext-blank">{sectionView.empty || '这一页现在是空的。'}</div>
                  )}
                  {!sectionView && <div className="ext-blank">{t('正在读…')}</div>}
                </div>
              </section>
            )}
            {page === 'components' && (
              <section className="set-block">
                <div className="set-title">{t('组件')}</div>
                <div className="set-note">
                  {t('被声明过的面板都在这儿，关不关都在。')}<strong>{t('点名字那一格就能改名')}</strong>{t('（顶栏、标题一起跟着变）。「收进收纳区」只是让它在顶栏占一格，跟声明不是一回事；「克隆一个」是照它再开一块新的。')}
                  <strong>{t('只有这一页的「删除」是真删')}</strong>{t('，连那份对话记录一起没。')}
                </div>
                {cmpWhere && (
                  <div className="set-note">
                    {t('本机存着 {n} 份组件、工作区里还有 {m} 份做法', { n: cmpWhere.bodyCount, m: cmpWhere.craftCount })}
                    （<code>{cmpWhere.bodyDir}</code> / <code>{cmpWhere.craftDir}</code>）。
                    {cmpWhere.bodyCount === 0 && cmpWhere.craftCount === 0 && t('两处都是空的 —— 多半是工作区指错了。')}
                  </div>
                )}

                <div className="cmp-bar">
                  <select value={saveFrom} onChange={(e) => setSaveFrom(e.target.value)}>
                    <option value="">{t('选一个面板…')}</option>
                    {panels.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}（{p.kind}）
                      </option>
                    ))}
                  </select>
                  <input
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    placeholder={t('声明名（组件就叫这个；留空用面板标题）')}
                    spellCheck={false}
                  />
                  <button className="primary" disabled={!saveFrom} onClick={() => void saveCmp()}>
                    声明为组件
                  </button>
                  <button
                    onClick={() => void importCmp()}
                    title={t('挑一个导出过的组件文件（.ensoul.json）导进来 —— 它变成下面清单里的一条，跟原件各是各的')}
                  >
                    导入组件
                  </button>
                </div>

                {selfWs?.dir && selfWs.dir !== selfWs.workspace && (
                  <div className="set-note set-note-hi">
                    这份软件自己住在 <code>{selfWs.dir}</code>，工作区现在却指着{' '}
                    <code>{selfWs.workspace || '（还没选）'}</code>。组件、做法、技能全是按工作区找的 ——
                    指着别处，这一页就是空的。
                    <button onClick={() => void useSelfWs()} title={t('把这个目录设成工作区 —— 换完立刻重扫一遍')}>
                      {t('把工作区换成这份软件所在的目录')}
                    </button>
                  </div>
                )}

                {packMsg && <div className="set-note set-note-hi">{packMsg}</div>}

                <div className="ext-list">
                  {cmps.map((c) => (
                    <div className="ext-row cmp-row" key={c.id}>
                      <span className="ext-name">
                        {renaming === c.id ? (
                          <input
                            className="cmp-rename"
                            value={renameText}
                            autoFocus
                            spellCheck={false}
                            onChange={(e) => setRenameText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') e.currentTarget.blur();
                              else if (e.key === 'Escape') {
                                cancelRename.current = true;
                                e.currentTarget.blur();
                              }
                            }}
                            onBlur={() => {
                              if (cancelRename.current) {
                                cancelRename.current = false;
                                setRenaming('');
                                return;
                              }
                              void commitRename(c.id);
                            }}
                          />
                        ) : (
                          <button className="cmp-name" title={t('点一下改名（顶栏和标题一起改）')} onClick={() => startRename(c)}>
                            {c.name}
                          </button>
                        )}
                      </span>
                      <span className="ext-desc">
                        {panelType(c.kind)?.label || c.kind}
                        {c.craftOnly ? t(' · 跟着仓库来的') : c.pinned ? t(' · 挂在顶上收纳区') : t(' · 只在库里')}
                        {' · '}
                        {c.craftOnly || c.file ? `${Math.max(1, Math.round(c.bytes / 1024))} KB` : t('开着')}
                      </span>
                      <span className="ext-size">
                        {c.savedAt
                          ? new Date(c.savedAt).toLocaleDateString(localeTag(),  { month: '2-digit', day: '2-digit' })
                          : '—'}
                      </span>
                      <button
                        onClick={() => void newFromCmp(c.id)}
                        title={c.craftOnly ? t('照这份做法开一块 —— 提示词、按钮、配色都带过来，对话从零开始') : undefined}
                      >
                        {c.craftOnly ? t('照它开一块') : c.file ? t('打开') : t('切过去')}
                      </button>
                      {c.craftOnly ? null : (
                        <>
                          {c.pinned ? (
                            <button onClick={() => void unpinCmp(c.id)} title={t('从顶上那条收纳区撤下来 —— 内容一个字符不丢，这一页照旧列着')}>
                              从顶栏释放
                            </button>
                          ) : (
                            <button onClick={() => void pinCmp(c.id)} title={t('挂到顶上那条收纳区，条上占一格')}>
                              收进收纳区
                            </button>
                          )}
                          <button onClick={() => void cloneCmp(c.id)} title={t('照它这一刻的样子再开一块新的（新对话线程，两份互不影响）')}>
                            克隆一个
                          </button>
                          <button
                            onClick={() => void exportCmp(c.id)}
                            title={t('把这一条的做法（类型、外观、提示词、按钮）打成一个文件 —— 换台机器导进去就是同款一块面板；对话记录不跟着走')}
                          >
                            导出
                          </button>
                          <button onClick={() => void delCmp(c.id)}>{t('删除')}</button>
                        </>
                      )}
                    </div>
                  ))}
                  {cmps.length === 0 && (
                    <div className="ext-blank">
                      {t('这儿还一条都没有 —— 从上面挑一块面板、点「声明为组件」就进来了。')}
                    </div>
                  )}
                </div>
              </section>
            )}

            
            {page === 'closed' && (
              <section className="set-block">
                <div className="set-title">{t('历史会话')}</div>
                <div className="set-note">
                  <strong>{t('没被声明成组件的面板')}</strong>{t('关掉就落在这儿 —— 不管它是对话、表格还是番茄钟。')}
                  {t('关掉不是删掉：连同它那整段对话记录一起留着，本体在')} <code>closed/&lt;id&gt;.json</code>{t('，重启也还在。')}
                  <strong>{t('不设条数上限、不会自动清理')}</strong>{t(' —— 想瘦身只能在这一页手动删除。')}
                  {t('（声明过的那些关闭时回组件库、不进这儿 —— 哪怕它没挂到顶栏。）')}
                </div>

                <div className="ext-list">
                  {closed.map((p) => (
                    <div className="ext-row" key={p.id}>
                      <span className="ext-name">{p.title}</span>
                      <span className="ext-desc">
                        {p.kind} · {Math.round(p.bytes / 1024)} KB · closed/{p.file}
                      </span>
                      <span className="ext-size">
                        {p.closedAt
                          ? new Date(p.closedAt).toLocaleString('zh-CN', {
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : '—'}
                      </span>
                      <button onClick={() => void reopen(p.id)}>{t('放回来')}</button>
                      <button onClick={() => void forget(p.id)}>{t('彻底删除')}</button>
                    </div>
                  ))}
                  {closed.length === 0 && <div className="ext-blank">{t('没有关掉的面板。')}</div>}
                </div>
              </section>
            )}

            {page === 'model' && (
              <section className="set-block">
                <div className="set-title">{t('模型')}</div>
            <div className="set-note">{t('填入各提供方的 API 密钥即可使用其模型。前台只负责在对话框上选。')}</div>

            <div className="pv-list">
              {(info?.providers ?? []).map((p) => {
                const open = editing.some((d) => d.key === p.key);
                return (
                  <div className={`pv-item${open ? ' is-open' : ''}`} key={p.key}>
                    <div className="pv-row" onClick={() => toggleEdit(draftFor(p))}>
                      <span className="pv-caret">▸</span>
                      <span className="pv-name">{p.label}</span>
                      {!p.builtin && <span className="pv-tag">{t('自定义')}</span>}
                      <span className={`pv-dot${p.hasKey ? '' : ' is-off'}`} title={p.hasKey ? '已配置密钥' : '还没配密钥'} />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleEdit(draftFor(p));
                        }}
                      >
                        {open ? '收起' : '编辑'}
                      </button>
                      <button
                        className="pv-del"
                        title={p.builtin ? '删掉这个内置提供方（想要再加回来，用下面的「添加提供方」）' : '删掉这个提供方'}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (p.builtin && !window.confirm(`删掉「${p.label}」？想要再加回来，用下面的「添加提供方」。`)) return;
                          void removeProvider(p.key);
                        }}
                      >
                        删除
                      </button>
                    </div>
                    {open && (
                      <ProviderForm
                        draft={editing.find((d) => d.key === p.key) as ProviderDraft}
                        key={p.key}
                        isNew={false}
                        onSaved={(list) => savedProvider(list, p.key)}
                        onCancel={() => closeEdit(p.key)}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {/* 还没进列表的新提供方：它们没有"自己那一行"可挂，只能在列表下面单起一块 */}
            {editing
              .filter((d) => !(info?.providers ?? []).some((p) => p.key === d.key))
              .map((d) => (
                <ProviderForm
                  key={d.key}
                  draft={d}
                  isNew
                  onSaved={(list) => savedProvider(list, d.key)}
                  onCancel={() => closeEdit(d.key)}
                />
              ))}

            {editing.length === 0 && (
              <div className="pv-add">
                <button onClick={() => void startAdd()}>{t('＋ 添加提供方')}</button>
                <button onClick={startCustom}>{t('＋ 添加自定义提供方')}</button>
              </div>
            )}

            {adding && (
              <div className="pv-presets">
                {presets
                  .filter((p) => !info?.providers.some((x) => x.key === p.key))
                  .map((p) => (
                    <button
                      key={p.key}
                      onClick={() => {
                        setEditing((es) => [...es, p]);
                        setAdding(false);
                      }}
                    >
                      {p.label}
                    </button>
                  ))}
                <button onClick={() => setAdding(false)}>{t('取消')}</button>
              </div>
            )}

            <div className="set-line">
              <span className="set-k">{t('配置文件')}</span>
              <span className="set-v mono">{info?.configPath ?? '—'}</span>
              <button onClick={() => void api.settings.revealConfig()} title={t('在资源管理器里打开')}>
                <IconFolderOpen />
                <span>{t('打开')}</span>
              </button>
            </div>
              </section>
            )}

            {page === 'skills' && (
              <section className="set-block">
                <div className="set-title">{t('技能')}</div>
            <div className="set-note">
              {t('按需取用的说明。系统提示里只带名字和一句话，助手觉得对得上才用')} <code>use_skill</code> 取正文
              —— 所以技能写多长都不占日常开销。
            </div>
            <div className="ext-list">
              {(ext?.skills ?? []).map((s) => (
                <SkillRow
                  key={`${s.source}/${s.name}`}
                  skill={s}
                  open={openSkill.has(`${s.source}/${s.name}`)}
                  onOpen={() => openSkill.toggle(`${s.source}/${s.name}`)}
                  onEnable={(on) => void toggleExt('skill', s.name, on)}
                />
              ))}
              {(ext?.skills.length ?? 0) === 0 && (
                <div className="ext-blank">{t('还没有技能。放一个 skills/<名字>/SKILL.md 就有了。')}</div>
              )}
            </div>
            <div className="set-note">
              技能来自这几个地方（越靠前越优先，重名时前面的赢）——
              项目自己的技能放进工作区，换项目就跟着换；软件自带的那份一直兜底。
            </div>
            <div className="ext-roots">
              {(ext?.skillsDirs ?? []).map((r) => (
                <div className="ext-root" key={r.path}>
                  <span className={`ext-root-dot${r.exists ? ' is-on' : ''}`} />
                  <span className="ext-root-src">{r.source}</span>
                  <span className="set-v mono">{r.path}</span>
                </div>
              ))}
            </div>
            <div className="set-line">
              <span className="set-k">{t('软件自带')}</span>
              <span className="set-v mono">{ext?.skillsDir ?? '—'}</span>
              <button onClick={() => void api.ext.reveal('skills')} title={t('在资源管理器里打开')}>
                <IconFolderOpen />
                <span>{t('打开')}</span>
              </button>
            </div>
            <div className="set-line">
              <span className="set-k">{t('这个工作区')}</span>
              <span className="set-v mono">{ext?.skillsDirs?.[0]?.path ?? '—'}</span>
              <button onClick={() => void api.ext.reveal('workspace-skills')} title={t('在资源管理器里打开')}>
                <IconFolderOpen />
                <span>{t('打开')}</span>
              </button>
            </div>
              </section>
            )}

            {page === 'look' && (
          <div className="set-pane">
            {/* 语言 —— 界面与助手一起切（真源在主进程，见 main/lang.ts） */}
            <section className="set-block">
              <div className="set-title">{t('语言')}</div>
              <div className="set-frow">
                <div className="set-fk">
                  {t('界面语言')}
                  <div className="set-row-desc">{t('界面与助手的语言')}</div>
                </div>
                <div className="fx-seg">
                  {LANGS.map((l) => (
                    <button
                      key={l.key}
                      className={getLang() === l.key ? 'is-on' : ''}
                      onClick={() => void setLang(l.key)}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              </div>
            </section>
            <section className="set-block">
              <div className="set-title">{t('主题')}</div>
              <div className="set-frow set-row-wrap">
                <div className="set-fk">{t('模式')}</div>
                <div className="fx-modes">
                  {([
                    { key: 'light', name: '浅色', art: 'fx-art-light' },
                    { key: 'dark', name: '深色', art: 'fx-art-dark' },
                  ] as const).map((m) => (
                    <button
                      key={m.key}
                      className={'fx-mode' + (themeMode === m.key ? ' is-on' : '')}
                      onClick={() => setTheme(m.key)}
                    >
                      <span className={'fx-art ' + m.art} />
                      <span>{t(m.name)}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="set-frow set-row-wrap">
                <div className="set-fk">{t('主题色')}</div>
                <div className="fx-swabs">
                  {THEME_COLORS.map((a) => (
                    <button
                      type="button"
                      key={a.key}
                      className={'fx-swab' + (themeColor === a.key ? ' is-on' : '')}
                      style={{ '--swab': a.hex || undefined } as React.CSSProperties}
                      title={t(a.name)}
                      aria-label={t(a.name)}
                      aria-pressed={themeColor === a.key}
                      onClick={() => setThemeColor(a.key)}
                    >
                      {a.hex ? '' : t('默认')}
                    </button>
                  ))}
                </div>
              </div>
              <div className="set-frow set-row-wrap">
                <div className="set-fk">
                  {t('窗口不透明度')}
                  <div className="set-row-desc">{t('调整背景层次，文字保持清晰；当前不会透出桌面。')}</div>
                </div>
                <div className="set-alpha">
                  <input type="range" aria-label={t('窗口不透明度')} min={60} max={100} step={5}
                    value={Math.round(surfaceOpacity * 100)}
                    onChange={(e) => setSurfaceOpacity(Number(e.target.value) / 100)} />
                  <span className="set-alpha-val">{Math.round(surfaceOpacity * 100)}%</span>
                </div>
              </div>
            </section>

            {/* 尺寸 —— 两个乘区：全局缩放（主进程）与面板缩放（Ctrl 滚轮，跟着每块面板走） */}
            <section className="set-block">
              <div className="set-title">{t('尺寸')}</div>
              <div className="set-frow set-row-wrap">
                <div className="set-fk">
                  {t('界面缩放')}
                  <div className="set-row-desc">
                    {t('整个界面一起放大：文字、图标、间距都是重排出来的，不是把画面拉大 —— 和系统缩放一个道理。')}
                  </div>
                </div>
                <div className="set-zoom-ticks">
                  {ZOOM_STEPS.map((p) => (
                    <button
                      key={p}
                      className={Math.round(zoom.factor * 100) === p ? 'is-on' : ''}
                      onClick={() => zoom.apply(p / 100)}
                    >
                      {p}%
                    </button>
                  ))}
                </div>
              </div>
              <div className="set-row-desc set-zoom-note">
                {t('想只放大某一块面板？鼠标指着那块面板，按 Ctrl 滚轮 —— 那是这块面板自己的缩放，各块互不影响，也不会挤动旁边的布局。')}
              </div>
            </section>

            {/* 排版 —— 字体选的是"栈"，系统里没装就自动落到下一档 */}
            <section className="set-block">
              <div className="set-title">{t('排版')}</div>
              <div className="set-frow">
                <div className="set-fk">{t('界面字体')}</div>
                <select value={fontUi} onChange={(e) => setFontUi(e.target.value)}>
                  {FONTS_UI.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="set-frow">
                <div className="set-fk">{t('代码字体')}</div>
                <select value={fontCode} onChange={(e) => setFontCode(e.target.value)}>
                  {FONTS_CODE.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>
            </section>

            {/* 效果 —— 两个开关，落点是 html 上那两个 data 属性 */}
            <section className="set-block">
              <div className="set-title">{t('效果')}</div>
              <div className="set-frow">
                <div className="set-fk">
                  {t('动态效果')}
                  <div className="set-row-desc">{t('关掉它，过渡与动画都不做，切换就是到位即完成。')}</div>
                </div>
                <div className="fx-seg">
                  {(['system', 'on', 'off'] as FxMode[]).map((v) => (
                    <button
                      key={v}
                      className={motion === v ? 'is-on' : ''}
                      onClick={() => setMotion(v)}
                    >
                      {v === 'system' ? t('跟随系统') : v === 'on' ? t('开启') : t('关闭')}
                    </button>
                  ))}
                </div>
              </div>
              <div className="set-frow">
                <div className="set-fk">
                  {t('界面内毛玻璃')}
                  <div className="set-row-desc">{t('关掉就撤掉毛玻璃，背后不透出一片花。')}</div>
                </div>
                <button
                  className={'fx-switch' + (glass ? ' is-on' : '')}
                  onClick={() => setGlass(!glass)}
                  title={glass ? '关掉毛玻璃' : '打开毛玻璃'}
                >
                  <i />
                </button>
              </div>
            </section>

            {/* 对话交互与工作视图 */}
            <section className="set-block">
              <div className="set-title">{t('交互与工作视图')}</div>
              <div className="set-frow">
                <div className="set-fk">
                  {t('工作步骤展示')}
                  <div className="set-row-desc">{t('选择希望看到多少工具调用细节')}</div>
                </div>
                <select
                  value={toolStepMode}
                  onChange={(e) => setToolStepMode(e.target.value as ToolStepMode)}
                >
                  <option value="compact">{t('简洁')}</option>
                  <option value="standard">{t('标准')}</option>
                  <option value="detailed">{t('详细')}</option>
                  <option value="expanded">{t('完全展开')}</option>
                </select>
              </div>

              <div className="set-frow">
                <div className="set-fk">
                  {t('显示代码工作视图')}
                  <div className="set-row-desc">{t('开启后，显示轨迹、本轮代码差异，可选择完整的 Agent 预设切换')}</div>
                </div>
                <button
                  className={'fx-switch' + (codeWorkView ? ' is-on' : '')}
                  onClick={() => setCodeWorkView(!codeWorkView)}
                  title={codeWorkView ? '关闭代码工作视图' : '开启代码工作视图'}
                >
                  <i />
                </button>
              </div>

              <div className="set-frow">
                <div className="set-fk">
                  {t('快捷键')}
                  <div className="set-row-desc">{t('查看和编辑当前可用的快捷键和输入操作')}</div>
                </div>
                <button
                  onClick={() => window.alert('常用快捷键：\n· Ctrl + Enter：发送消息 / 保存修改\n· Esc：取消编辑 / 关闭弹窗\n· Ctrl + 滚轮：针对单面板进行自由缩放\n· 双击会话边缘：复位会话宽度')}
                >
                  {t('查看快捷键')}
                </button>
              </div>
            </section>
          </div>

        )}
        {page === 'plugins' && (
              <section className="set-block">
                <div className="set-title">{t('插件')}</div>
            <div className="set-note">
              {t('给助手加工具的扩展：')}<code>plugins/&lt;{t('名字')}&gt;/index.js</code>
              {t('，CommonJS。能注册新工具（todo / jobs / web 就是插件），也能挂在写文件之前 —— 内置的 file-backup 靠这一手，每次改写前自动留底。插件改完不用重启：下一次对话就会用新代码。')}
            </div>
            <div className="plg-list">
              {tunable.length > 0 && (
                <div className="plg-group">{t('有参数可调 ·')} {tunable.length}</div>
              )}
              {tunable.map((p) => (
                <PluginRow
                  key={`${p.source}/${p.name}`}
                  p={p}
                  open={openPlugin.has(`${p.source}/${p.name}`)}
                  onOpen={() => openPlugin.toggle(`${p.source}/${p.name}`)}
                  onEnable={(on) => void toggleExt('plugin', p.name, on)}
                  onParam={(plugin, key, value) => void saveParam(plugin, key, value)}
                />
              ))}
              {fixed.length > 0 && (
                <div className="plg-group">没参数可调 · {fixed.length}</div>
              )}
              {fixed.map((p) => (
                <PluginRow
                  key={`${p.source}/${p.name}`}
                  p={p}
                  open={openPlugin.has(`${p.source}/${p.name}`)}
                  onOpen={() => openPlugin.toggle(`${p.source}/${p.name}`)}
                  onEnable={(on) => void toggleExt('plugin', p.name, on)}
                  onParam={(plugin, key, value) => void saveParam(plugin, key, value)}
                />
              ))}
              {(ext?.plugins.length ?? 0) === 0 && (
                <div className="ext-blank">{t('还没有插件。放一个 plugins/<名字>/index.js 就有了。')}</div>
              )}
            </div>
            <div className="set-line">
              <span className="set-k">{t('软件自带')}</span>
              <span className="set-v mono">{ext?.pluginsDir ?? '—'}</span>
              <button onClick={() => void api.ext.reveal('plugins')} title={t('在资源管理器里打开')}>
                <IconFolderOpen />
                <span>{t('打开')}</span>
              </button>
            </div>
            <div className="set-line">
              <span className="set-k">{t('这个工作区')}</span>
              <span className="set-v mono">{ext?.workspacePluginsDir ?? '—'}</span>
              <button onClick={() => void api.ext.reveal('workspace-plugins')} title={t('在资源管理器里打开')}>
                <IconFolderOpen />
                <span>{t('打开')}</span>
              </button>
            </div>
              </section>
            )}

        {page === 'more' && (
          <section className="set-block">
            <div className="set-title">{t('扩展生态与运行环境')}</div>
            <div className="set-note">
              {t('配置下载镜像加速、管理本地多个 Python 解释器版本，并在各离线套件内按需下载依赖。')}
            </div>

            {/* 1. 顶置：网络与下载镜像加速 */}
            <div className="more-panel-section">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', width: '100%' }}>
                <div>
                  <div className="more-section-title" style={{ margin: 0 }}>{t('下载镜像源加速')}</div>
                  <div style={{ fontSize: '12px', color: 'var(--dim)', marginTop: '2px' }}>
                    {t('加速 pip 依赖安装、离线模型拉取与 npm 扩展包下载')}
                  </div>
                </div>
                <select
                  className="more-input-field mono"
                  style={{ maxWidth: '300px' }}
                  value={selectedMirror}
                  onChange={async (e) => {
                    const val = e.target.value;
                    setSelectedMirror(val);
                    await persistEnv({ mirror: val });
                  }}
                >
                  <option value="tsinghua">{t('清华大学镜像站 (Tsinghua TUNA) [推荐]')}</option>
                  <option value="aliyun">{t('阿里云开源镜像站 (Aliyun)')}</option>
                  <option value="tencent">{t('腾讯云软件源 (Tencent Cloud)')}</option>
                  <option value="huawei">{t('华为开源镜像站 (Huawei Cloud)')}</option>
                  <option value="ustc">{t('中国科学技术大学 (USTC)')}</option>
                  <option value="official">{t('官方源 (pypi.org / npmjs.org)')}</option>
                  <option value="custom">{t('自定义镜像源')}</option>
                </select>
              </div>

              {selectedMirror === 'custom' && (
                <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                  <input
                    type="text"
                    className="more-input-field mono"
                    placeholder={t('PyPI 镜像 URL，如 https://pypi.tuna.tsinghua.edu.cn/simple')}
                    value={customPypi}
                    onChange={(e) => setCustomPypi(e.target.value)}
                  />
                  <button
                    className="more-action-btn"
                    onClick={async () => {
                      await persistEnv({ customPypi, customNpm });
                      setMoreFeedback('自定义镜像地址已保存');
                    }}
                  >
                    保存
                  </button>
                </div>
              )}
            </div>

            {/* 2. Python 解释器管理 */}
            <div className="more-panel-section">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 240px' }}>
                  <div className="more-section-title" style={{ margin: 0 }}>{t('Python 解释器管理')}</div>
                  <div style={{ fontSize: '12px', color: 'var(--dim)', marginTop: '2px' }}>
                    {t('管理本地多个 Python 版本，离线模型与脚本执行将调用当前激活的解释器')}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                  <button
                    className="more-action-btn"
                    style={{ fontSize: '12px', padding: '6px 14px', whiteSpace: 'nowrap' }}
                    onClick={() => setShowAddPy((v) => !v)}
                  >
                    {showAddPy ? '取消添加' : '+ 添加 Python 版本'}
                  </button>
                </div>
              </div>

              {/* 添加 Python 面板：默认联网下载，支持切到指定本地路径 */}
              {showAddPy && (
                <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '6px', padding: '12px', marginTop: '12px' }}>
                  <div style={{ display: 'flex', gap: '12px', borderBottom: '1px solid var(--line)', paddingBottom: '8px', marginBottom: '10px' }}>
                    <button
                      type="button"
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: '2px 6px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        fontWeight: pyAddTab === 'download' ? 600 : 400,
                        color: pyAddTab === 'download' ? 'var(--accent)' : 'var(--dim)',
                        borderBottom: pyAddTab === 'download' ? '2px solid var(--accent)' : '2px solid transparent',
                        borderRadius: 0,
                      }}
                      onClick={() => setPyAddTab('download')}
                    >
                      联网快速下载 (推荐)
                    </button>
                    <button
                      type="button"
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: '2px 6px',
                        cursor: 'pointer',
                        fontSize: '12px',
                        fontWeight: pyAddTab === 'custom' ? 600 : 400,
                        color: pyAddTab === 'custom' ? 'var(--accent)' : 'var(--dim)',
                        borderBottom: pyAddTab === 'custom' ? '2px solid var(--accent)' : '2px solid transparent',
                        borderRadius: 0,
                      }}
                      onClick={() => setPyAddTab('custom')}
                    >
                      指定本地已有路径
                    </button>
                  </div>

                  {pyAddTab === 'download' ? (
                    <div>
                      <div style={{ fontSize: '12px', color: 'var(--dim)', marginBottom: '8px' }}>
                        {t('通过上方已选镜像源高速下载官方便携免配置 Python，解压并自动隔离于工作区环境，不污染系统全局：')}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <select
                          className="more-input-field mono"
                          style={{ maxWidth: '240px', padding: '6px 10px', fontSize: '12px' }}
                          value={downloadVer}
                          onChange={(e) => setDownloadVer(e.target.value)}
                        >
                          <option value="3.10.11">{t('Python 3.10.11 (AI 离线库最佳推荐)')}</option>
                          <option value="3.11.9">{t('Python 3.11.9 (标准稳定版)')}</option>
                          <option value="3.9.13">{t('Python 3.9.13 (兼容老旧组件)')}</option>
                        </select>
                        <button
                          className="more-action-btn"
                          style={{
                            background: 'var(--accent)',
                            color: '#fff',
                            border: 'none',
                            padding: '6px 14px',
                            fontSize: '12px',
                            whiteSpace: 'nowrap',
                          }}
                          disabled={downloadingPy}
                          onClick={async () => {
                            setDownloadingPy(true);
                            setEnvBusy(true);
                            setEnvLog('正在通过镜像加速下载便携式 Python ' + downloadVer + '...\n请稍候，下载完成后将自动解压并加入解释器列表。\n');
                            try {
                              const res = await api.env.downloadPython(downloadVer);
                              if (res.ok && res.path) {
                                setEnvLog((prev) => prev + '\n[完成] 成功安装并就绪: ' + res.path + '\n');
                                const newId = 'py-' + Date.now();
                                const newEntry = {
                                  id: newId,
                                  name: 'Python ' + downloadVer + ' (便携隔离版)',
                                  path: res.path,
                                  version: res.version || ('Python ' + downloadVer),
                                  available: true,
                                };
                                const updated = [...pythons.filter((p) => p.path !== res.path), newEntry];
                                setPythons(updated);
                                setActivePythonId(newId);
                                await persistEnv({ pythons: updated, activePythonId: newId });
                                await loadEnvData();
                                setShowAddPy(false);
                              } else {
                                setEnvLog((prev) => prev + '\n[错误] 下载安装失败: ' + (res.error || '未知错误') + '\n');
                              }
                            } catch (err: any) {
                              setEnvLog((prev) => prev + '\n[异常] ' + (err?.message || err) + '\n');
                            } finally {
                              setDownloadingPy(false);
                              setEnvBusy(false);
                            }
                          }}
                        >
                          {downloadingPy ? '正在联网下载解压...' : '立即下载并设为激活'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: '8px', marginBottom: '8px' }}>
                        <input
                          type="text"
                          className="more-input-field"
                          style={{ fontSize: '12px', padding: '6px 8px' }}
                          placeholder={t('环境标签，例如: Conda 3.10')}
                          value={newPyName}
                          onChange={(e) => setNewPyName(e.target.value)}
                        />
                        <input
                          type="text"
                          className="more-input-field mono"
                          style={{ fontSize: '12px', padding: '6px 8px' }}
                          placeholder={t('例如: D:\\Python310\\python.exe')}
                          value={newPyPath}
                          onChange={(e) => setNewPyPath(e.target.value)}
                        />
                        <button
                          type="button"
                          className="more-action-btn"
                          style={{ fontSize: '12px', padding: '6px 12px', whiteSpace: 'nowrap' }}
                          onClick={async () => {
                            const picked = await api.env?.pickFile?.();
                            if (picked) setNewPyPath(picked);
                          }}
                        >
                          浏览...
                        </button>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                        <button
                          className="more-action-btn"
                          style={{ fontSize: '12px', padding: '6px 14px', whiteSpace: 'nowrap' }}
                          disabled={!newPyPath.trim()}
                          onClick={async () => {
                            const pathVal = newPyPath.trim();
                            if (!pathVal) return;
                            const nameVal = newPyName.trim() || pathVal.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2, -1)[0] || 'Python';
                            const check = await api.env.testPython(pathVal);
                            const newEntry = {
                              id: 'py-' + Date.now(),
                              name: nameVal,
                              path: pathVal,
                              version: check.ok ? check.version : '不可用',
                              available: check.ok,
                            };
                            const updated = [...pythons, newEntry];
                            setPythons(updated);
                            setActivePythonId(newEntry.id);
                            await persistEnv({ pythons: updated, activePythonId: newEntry.id });
                            await loadEnvData();
                            setShowAddPy(false);
                            setNewPyName('');
                            setNewPyPath('');
                          }}
                        >
                          保存并激活
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* 多版本卡片列表 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
                {pythons.map((item) => {
                  const isActive = item.id === activePythonId;
                  return (
                    <div
                      key={item.id}
                      className={"py-version-card" + (isActive ? ' active' : '')}
                    >
                      <div className="py-version-left">
                        <div className="py-version-title-row">
                          <span className="py-version-name">{item.name}</span>
                          {isActive && (
                            <span className="env-status-badge ready">
                              当前激活
                            </span>
                          )}
                          <span className={"env-status-badge " + (item.available ? 'ready' : 'missing')}>
                            {item.version || (item.available ? '可用' : '不可用')}
                          </span>
                        </div>
                        <div className="py-version-path mono" title={item.path}>
                          {item.path}
                        </div>
                      </div>

                      <div className="py-version-actions">
                        {!isActive && (
                          <button
                            className="more-action-btn"
                            style={{ fontSize: '11px', padding: '4px 10px', whiteSpace: 'nowrap' }}
                            onClick={async () => {
                              setActivePythonId(item.id);
                              await persistEnv({ activePythonId: item.id });
                              await loadEnvData();
                            }}
                          >
                            设为当前
                          </button>
                        )}
                        <button
                          className="more-action-btn"
                          style={{ fontSize: '11px', padding: '4px 8px', whiteSpace: 'nowrap' }}
                          onClick={async () => {
                            const res = await api.env.testPython(item.path);
                            const updated = pythons.map((p) =>
                              p.id === item.id ? { ...p, available: res.ok, version: res.ok ? res.version : '不可用' } : p
                            );
                            setPythons(updated);
                            await persistEnv({ pythons: updated });
                          }}
                        >
                          检测
                        </button>
                        <button
                          className='more-action-btn'
                          style={{ fontSize: '11px', padding: '4px 8px', color: '#ef4444', whiteSpace: 'nowrap' }}
                          onClick={async () => {
                            // 以前这里只做 pythons.filter —— 名单干净了，磁盘上一个字节没动。
                            // 现在先勘察：把「多大、几个文件、能不能真删、谁正抱着它」摆清楚，再决定怎么说。
                            const info: any = await api.env.inspectPython({ id: item.id, path: item.path, name: item.name }).catch(() => null);
                            if (!info || info.ok === false) {
                              window.alert(`${info?.error || t('勘察失败')}\n（只是没看清，什么都没动）`);
                              return;
                            }

                            const mb = (info.bytes / 1048576).toFixed(1);
                            const sizeLine = info.canDelete
                              ? `磁盘占用：${mb} MB（${info.fileCount} 个文件）`
                              : t('这是你自己挑的解释器 —— 只会把它从名单里拿掉，磁盘上的东西一个字节都不动。');
                            const users = (info.inUse || []).filter((x: any) => x.pid);
                            const killLine = users.length
                              ? `\n正被 ${users.length} 个进程占着（必须先把它们收掉，否则目录删不干净）：\n` +
                                users.map((x: any) => `  · PID ${x.pid}（占内存 ${x.memMB} MB）`).join('\n')
                              : '';

                            // 既没记录要摘、盘上又没东西 —— 直说，别拿一个空确认框糊人
                            if (!info.canDelete && !info.dirExists && users.length === 0) {
                              const updated0 = pythons.filter((p) => p.id !== item.id);
                              setPythons(updated0);
                              const nextActive0 = isActive ? (updated0[0]?.id || 'py-default') : activePythonId;
                              setActivePythonId(nextActive0);
                              await persistEnv({ pythons: updated0, activePythonId: nextActive0 });
                              await loadEnvData();
                              return;
                            }

                            const title = info.canDelete ? t('删除解释器并清盘') : t('从名单里移除解释器');
                            const ask = info.canDelete
                              ? t('这会把上面这坨从磁盘上真删掉，放不回来。')
                              : t('磁盘上的文件不动，只是不再让它出现在这份名单里。');
                            const tail = users.length ? t('\n收掉这些进程会当场中断它们正在做的事（语音输入那类）。') : '';

                            if (!window.confirm(`【${title}】${item.name}\n${item.path}\n\n${sizeLine}${killLine}\n\n${ask}${tail}`)) return;

                            if (isActive && info.canDelete) {
                              // 把当前正在跑东西的解释器抽走，脚本会当场没得用 —— 这是独立于「清盘」的一次点头
                              if (!window.confirm(t('注意：它现在就是当前激活的解释器。删掉之后，正在用它跑的东西会断，得重选一个。'))) return;
                            }

                            const res: any = await api.env.removePython({ id: item.id, path: item.path }).catch(() => null);
                            if (!res || res.ok === false) {
                              window.alert(`${res?.error || t('删除失败')}\n（磁盘上什么都没动）`);
                              return;
                            }

                            // 删完重新探一次：否则界面上的「当前激活」和主进程里真存的对不上
                            await loadEnvData();
                            await api.env.detect?.().then((d: any) => d && setEnvData(d)).catch(() => {});

                            if (res.disk?.mode === 'refused') {
                              window.alert(
                                t('有文件还被占着，没删干净。\n登记已经摘掉了，剩下的残留在「残留解释器目录」里，可以在那儿重试。') +
                                ((res.disk.leftovers || []).length ? `\n\n首先卡住的：\n${(res.disk.leftovers || []).join('\n')}` : '')
                              );
                            } else if (res.disk?.mode === 'deleted') {
                              setEnvLog((prev) => prev + `\n[环境] 已删除解释器：${item.name}（清掉 ${mb} MB / ${info.fileCount} 个文件）\n`);
                            }
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  );
                })}
              {/* 残留解释器目录：以前的「删除」只摘名单不清盘，这些就是那时候留下的账。
                  只列出来、你点才清 —— 不替你做主。 */}
              {pyOrphans.length > 0 && (
                <div style={{ marginTop: '12px', border: '1px solid var(--line)', borderRadius: '6px', padding: '10px 12px' }}>
                  <div className='more-section-title' style={{ margin: 0 }}>{t('残留解释器目录')}</div>
                  <div style={{ fontSize: '12px', opacity: 0.75, margin: '4px 0 8px' }}>
                    {t('这些解释器已经不在上面的名单里了，文件却还躺在 .ensoul/env 下面占着盘。清掉它们不影响任何已登记的解释器。')}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {pyOrphans.map((o) => (
                      <div key={o.dir} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: '12px' }}>{o.name}</div>
                          <div className='mono' style={{ fontSize: '11px', opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={o.dir}>
                            {(o.bytes / 1048576).toFixed(1)} MB · {o.files} {t('个文件')}
                          </div>
                        </div>
                        <button
                          className='more-action-btn'
                          style={{ fontSize: '11px', padding: '4px 8px', color: '#ef4444', whiteSpace: 'nowrap' }}
                          onClick={async () => {
                            if (!window.confirm(`清掉这个残留目录？\n${o.dir}\n${(o.bytes / 1048576).toFixed(1)} MB · ${o.files} 个文件\n\n真删，放不回来。`)) return;
                            const res: any = await api.env.removeOrphan(o.dir).catch(() => null);
                            if (!res || res.ok === false) {
                              window.alert(`${res?.error || t('清理失败')}`);
                              return;
                            }
                            if ((res.leftovers || []).length) {
                              window.alert(t('还有文件被占着，没删干净：') + '\n' + (res.leftovers || []).slice(0, 6).join('\n'));
                            } else {
                              setEnvLog((prev) => prev + `\n[环境] 已清理残留目录：${o.name}（${(res.bytes / 1048576).toFixed(1)} MB）\n`);
                            }
                            await loadEnvData();
                          }}
                        >
                          清理
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              </div>
            </div>

            {/* 3. 官方精选离线组件 */}
            <div className="more-panel-section">
              <div className="more-section-title">{t('官方精选离线组件')}</div>
              <div className="more-section-desc">{t('本地离线 AI 推理与系统级功能，按需下载依赖并启用：')}</div>

              <div className="more-cards-list">
                {[
                  {
                    id: 'computer-control',
                    name: '电脑控制套件 (OS Agent)',
                    tag: '系统驱动',
                    desc: '桌面高清视觉捕捉与键鼠控制，支持紧急制动。',
                    size: '12 MB',
                  },
                  {
                    id: 'mcp',
                    name: 'MCP 核心套件',
                    tag: '开放协议',
                    desc: 'Anthropic 开源 MCP 生态支持，自动握手外部服务。',
                    size: '5 MB',
                  },
                ].map((item) => {
                  const targetPlg = (ext?.plugins || []).find((p: any) => p.name === item.id);
                  const isInstalled = targetPlg ? !!targetPlg.enabled : false;
                  
                  const pkgs = envData?.python?.packages;
                  // 这一格最要紧的是**别把"没查出来"画成"没安装"**：
                  // 前者点一下重查就知道，后者会让人去做一次白装的 pip install。
                  const pkgKnown = (envData?.python as any)?.packagesKnown !== false;
                  const pkgLabel = (v?: boolean) => (v ? '已就绪' : pkgKnown ? '未安装' : '未检测到');

                  return (
                    <div className="more-card-item" key={item.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
                            <span className="more-card-name">{item.name}</span>
                            <span className="more-card-tag">{item.tag}</span>
                            <span style={{ fontSize: '11px', color: 'var(--dim)' }}>{item.size}</span>
                            
                          </div>
                          <div className="more-card-desc">{item.desc}</div>
                        </div>
                        <button
                          className={'fx-switch' + (isInstalled ? ' is-on' : '')}
                          disabled={moreLoading}
                          onClick={async () => {
                            setMoreLoading(true);
                            setMoreFeedback('正在更新 ' + item.name + '...');
                            try {
                              const nextState = !isInstalled;
                              if (nextState) {
                                setMoreFeedback('正在部署 ' + item.name + '...');
                                if (item.id) await toggleExt('plugin', item.id, true);
                                setMoreFeedback(item.name + ' 已启用并就绪，已同步到插件列表。');
                              } else {
                                setMoreFeedback('正在停用 ' + item.name + '...');
                                if (item.id) await toggleExt('plugin', item.id, false);
                                setMoreFeedback(item.name + ' 已停用。');
                              }
                            } catch (err: any) {
                              setMoreFeedback('操作失败: ' + (err?.message || err));
                            } finally {
                              setMoreLoading(false);
                            }
                          }}
                        >
                          <i />
                        </button>
                      </div>

                                          </div>
                  );
                })}
              </div>
            </div>

            {/* 4. 安装外部扩展包 */}
            <div className="more-panel-section">
              <div className="more-section-title">{t('安装外部扩展包')}</div>
              <div className="more-section-desc">{t('输入 npm 包名或 Git 仓库地址，直接拉取并加载：')}</div>
              
              <div style={{ marginBottom: 12 }}>
                <label className="more-action-btn" style={{ display: 'inline-flex', alignItems: 'center', cursor: 'pointer', padding: '6px 14px' }}>
                  {t('📦 选择并安装 .ensoulpack 扩展包')}
                  <input type="file" accept=".ensoulpack,.zip" style={{ display: 'none' }} onChange={handleInstallEnsoulPack} />
                </label>
              </div>
              <div className="more-input-group">
                <input
                  type="text"
                  className="more-input-field mono"
                  placeholder={t('例如：ensoul-plugin-terminal 或 https://github.com/...')}
                  value={moreUrl}
                  onChange={(e) => setMoreUrl(e.target.value)}
                />
                <button
                  className="more-action-btn"
                  disabled={!moreUrl.trim() || moreLoading}
                  onClick={async () => {
                    const target = moreUrl.trim();
                    if (!target) return;
                    setMoreLoading(true);
                    setMoreFeedback('正在安装 ' + target + '...');
                    try {
                      const res = await api.command?.run?.('npm install ' + target + ' --no-audit') || '';
                      await load();
                      setMoreFeedback('安装成功: ' + (res.trim() || '完成'));
                      setMoreUrl('');
                    } catch (err: any) {
                      setMoreFeedback('安装失败: ' + (err?.message || err));
                    } finally {
                      setMoreLoading(false);
                    }
                  }}
                >
                  {moreLoading ? '正在安装...' : '安装'}
                </button>
              </div>
              {moreFeedback && <div className="more-feedback mono">{moreFeedback}</div>}
            </div>
          </section>
        )}
          </div>
        </div>

      </div>
    </div>
  );
}

/**
 * 一个插件在设置面板里的样子：一行标题（名字 + 一句说明 + 启用开关），点开是它的全部 ——
 * 参数就在里面就地改。
 *
 * 为什么要展开：一个插件声明的参数不展开就没地方看见；而"启用/停用"只是它的两个状态之一，
 * 不该占满整行 —— 参数、工具、面板类型、目录都是回头要查的东西，收在同一格里最省事。
 */
/**
 * 一条技能在设置里的样子：一行标题，点开是它自己的详情。
 *
 * 详情**就地落在这一条下面**（说明全文 + 正文 + 它在哪个目录里），
 * 不再往页面下方摆一个"技能预览"窗口 —— 那种窗口一屏技能时跟哪一行都对不上号。
 * 正文按需读：没展开过就不去翻那个文件。
 */
function SkillRow({
  skill,
  open,
  onOpen,
  onEnable,
}: {
  skill: ExtSnapshot['skills'][number];
  open: boolean;
  onOpen(): void;
  onEnable(on: boolean): void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open || text !== null) return;
    let dead = false;
    api.ext
      .readSkill(skill.name)
      .then((t) => {
        if (!dead) setText(t);
      })
      .catch((e: any) => {
        if (!dead) setErr(String(e?.message ?? e));
      });
    return () => {
      dead = true;
    };
  }, [open, skill.name, text]);

  const size = skill.bytes < 1024 ? `${skill.bytes}B` : `${(skill.bytes / 1024).toFixed(1)}k`;

  return (
    <div className={`ext-skill${skill.enabled ? '' : ' is-off'}${open ? ' is-open' : ''}`}>
      <div className="ext-skill-head" onClick={onOpen} title={open ? '收起' : '展开：说明、正文、它在哪个目录'}>
        <span className="plg-caret">▸</span>
        <span className="ext-name">{skill.name}</span>
        <span className="ext-desc">{t(skill.description) || t('（没写说明）')}</span>
        <span className="ext-src" title={skill.root}>
          {skill.source}
        </span>
        <span className="ext-size">{size}</span>
        <button
          onClick={(e) => {
            e.stopPropagation(); // 别顺手把这一行也展开了
            onEnable(!skill.enabled);
          }}
        >
          {skill.enabled ? '停用' : '启用'}
        </button>
      </div>

      {open && (
        <div className="ext-skill-body">
          <div className="ext-skill-desc">{t(skill.description) || t('（没写说明）')}</div>
          <div className="ext-skill-path mono">{skill.root}</div>
          {err ? (
            <div className="ext-blank">正文读不出来：{err}</div>
          ) : text === null ? (
            <div className="ext-blank">{t('读正文…')}</div>
          ) : (
            <pre className="ext-skill-pre">{text}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function PluginRow({
  p,
  open,
  onOpen,
  onEnable,
  onParam,
}: {
  p: PluginInfo;
  open: boolean;
  onOpen(): void;
  onEnable(on: boolean): void;
  onParam(plugin: string, key: string, value: string | number | boolean | null): void;
}) {
  const changed = p.params.filter((d) => p.values[d.key] !== d.default).length;
  /** 展开着的工具们 —— 工具各自一条，点开看它自己是干什么的，开几个显示几个 */
  const openTool = useOpenKeys();
  return (
    <div className={`plg-row${p.enabled ? '' : ' is-off'}${open ? ' is-open' : ''}`}>
      <div className="plg-head" onClick={onOpen} title={open ? '收起' : '展开：参数、工具、目录'}>
        <span className="plg-caret">▸</span>
        <span className="plg-name">{p.name}</span>

        <span className="plg-desc">{p.error ? t('出错：{err}', { err: t(p.error) }) : t(p.description) || t('（没写说明）')}</span>
        {p.params.length > 0 && (
          <span className={`plg-badge${changed ? ' is-dirty' : ''}`} title={changed ? `改过 ${changed} 项` : '没改过'}>
            {p.params.length} 项可调
            {changed ? ` · 改了 ${changed}` : ''}
          </span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation(); // 别顺手把这一行也展开了
            onEnable(!p.enabled);
          }}
        >
          {p.enabled ? '停用' : '启用'}
        </button>
      </div>

      {open && (
        <div className="plg-body">
          <div className="plg-meta">
            <span>面板：{p.panel ? `${p.panel.kind}（${p.panel.label}）` : '—'}</span>
            <span className="mono">{p.dir}</span>
          </div>

          {/* 工具逐条列、逐条展开 —— 挤成一行「工具：a、b、c」的话，
              每个工具自己干什么就永远看不见了（长了还会被切掉） */}
          <div className="plg-tools">
            <div className="plg-tools-title">工具{p.tools.length ? ` · ${p.tools.length} 个` : ''}</div>
            {p.tools.length === 0 ? (
              <div className="plg-none">{t('没注册工具 —— 纯后台插件。')}</div>
            ) : (
              p.tools.map((t) => (
                <div className={`plg-tool${openTool.has(t.name) ? ' is-open' : ''}`} key={t.name}>
                  <div
                    className="plg-tool-head"
                    onClick={() => openTool.toggle(t.name)}
                    title={openTool.has(t.name) ? '收起' : '展开：这个工具是干什么的'}
                  >
                    <span className="plg-caret">▸</span>
                    <span className="plg-tool-name mono">{t.name}</span>
                    <span className="plg-tool-desc">{t.description || '（没写说明）'}</span>
                  </div>
                  {openTool.has(t.name) && (
                    <div className="plg-tool-body">
                      {t.description || '（这个工具没写说明 —— 模型看到的也只有名字）'}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {p.params.length === 0 ? (
            <div className="plg-none">
              {t('没有可调参数 —— 要么它没什么需要调的，要么该在插件的')} <code>params</code> {t('里声明出来。')}
            </div>
          ) : (
            p.params.map((d) => (
              <ParamField key={d.key} decl={d} value={p.values[d.key]} onSet={(v) => onParam(p.name, d.key, v)} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 一条参数控件。两个讲究：
 *
 *   · 开关和下拉**点下去就生效**（那一下就是决定）；文字和数字**离开这一格才提交**
 *     （onBlur / 回车）。因为改一条参数会让整个插件重新准备一次 —— 每敲一个字符来一次太吵。
 *   · 值跟默认不一样时右边冒出"恢复默认"：调过什么一眼看得见，也都回得去。
 */
function ParamField({
  decl,
  value,
  onSet,
}: {
  decl: PluginParamDecl;
  value: string | number | boolean;
  onSet(v: string | number | boolean | null): void;
}) {
  const [draft, setDraft] = useState(String(value ?? ''));
  // 本地即时响应状态，用户点击选中那一毫秒立刻展示并锁定，绝不回弹
  const [selectedVal, setSelectedVal] = useState<string>(String(value ?? decl.default ?? ''));
  const [deviceOptions, setDeviceOptions] = useState<{ value: string; label: string }[]>(
    () => (decl.options && decl.options.length ? decl.options : []),
  );

  useEffect(() => {
    setDraft(String(value ?? ''));
    if (value !== undefined && value !== null) {
      setSelectedVal(String(value));
    }
  }, [value]);

  const dirty = value !== decl.default;

  /**
   * 插件的参数里声明 `optionsFrom: 'audio-inputs'` 时，选项得**枚举这台机器的麦克风**。
   * 这是核心给的通用机制（插件只说"选项从哪来"，枚举的事核心做）—— 从前那份枚举结果
   * 存在一个**模块级**变量里，于是同一次会话里几块设置页会互相抢；现在归这块面板自己。
   */
  const audioScanned = useRef<{ value: string; label: string }[] | null>(null);
  useEffect(() => {
    if (decl.optionsFrom !== 'audio-inputs') return;
    let alive = true;
    const scan = async () => {
      if (audioScanned.current) {
        setDeviceOptions(audioScanned.current);
        return;
      }
      try {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        // 先要一次权限：没授权的设备名是一串空标签，选了也认不出是哪一只
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((track) => track.stop());
        } catch {
          /* 用户没给权限：照样列出来，标签差点也比空着强 */
        }
        const devs = await navigator.mediaDevices.enumerateDevices();
        const list = devs
          .filter((d) => d.kind === 'audioinput')
          .map((d, i) => ({ value: d.deviceId || String(i), label: d.label || t('麦克风 {n}', { n: i + 1 }) }));
        if (!list.length) return;
        audioScanned.current = list;
        if (alive) setDeviceOptions(list);
      } catch {
        /* 枚举不动就沿用声明里给的选项 */
      }
    };
    void scan();
    return () => {
      alive = false;
    };
  }, [decl]);

  const commit = () => {
    if (decl.type === 'number') {
      const n = Number(draft);
      if (!Number.isFinite(n)) {
        setDraft(String(value ?? ''));
        return;
      }
      if (n !== value) onSet(n);
      return;
    }
    if (draft !== String(value ?? '')) onSet(draft);
  };

  return (
    <div className={'plg-param' + (dirty ? ' is-dirty' : '')}>
      <span className="plg-param-label" title={decl.hint || ''}>
        {decl.label}
        <span className="plg-param-hint">{decl.hint || ''}</span>
      </span>

      <span className="plg-param-input">
        {decl.type === 'bool' ? (
          <input type="checkbox" checked={value === true} onChange={(e) => onSet(e.target.checked)} />
        ) : decl.type === 'select' ? (
          <select
            value={selectedVal}
            onChange={(e) => {
              const val = e.target.value;
              setSelectedVal(val);
              onSet(val);
            }}
          >
            {(() => {
              const opts = ((decl as any).optionsFrom === 'audio-inputs' ? deviceOptions : decl.options) ?? [];
              const hasCurr = opts.some((o) => o.value === selectedVal);
              const finalOpts = hasCurr || !selectedVal ? opts : [...opts, { value: selectedVal, label: selectedVal }];
              return finalOpts.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ));
            })()}
          </select>
        ) : decl.multiline ? (
          <textarea value={draft} rows={3} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
        ) : (
          <input
            type={decl.type === 'number' ? 'number' : 'text'}
            value={draft}
            min={decl.min}
            max={decl.max}
            step={decl.step}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
        )}
      </span>

      <span className="plg-param-tail">
        {decl.type === 'number' && (decl.min !== undefined || decl.max !== undefined) && (
          <span className="plg-param-range">
            {(decl.min ?? '-∞')}–{(decl.max ?? '∞')}
          </span>
        )}
        {dirty && (
          <button className="plg-reset" onClick={() => { onSet(null); setSelectedVal(String(decl.default ?? '')); }} title={'恢复默认：' + String(decl.default)}>
            恢复默认
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * 一个模型的单价：三档基础价 + 可选的分时段（峰谷）价。
 *
 * 草稿（下面这个 PriceDraft）归**父级**管，编辑框只负责画和改，自己不留副本 ——
 * 原先它自己 useState 存一份，删掉一个模型、索引往前挪，框里还捧着上一个模型的价，
 * 于是"填进去的峰谷段落到别的模型身上"，看着就是填了没保存。
 *
 * 敲字过程中留住原文（"0." 这种半截数字不能当场被吃成 0），落成配置由 priceOfDraft 负责。
 * 峰谷段写本机时间、起点含终点不含，跨零点把终点写得比起点小（22:00 → 02:00）。
 */
type PriceDraft = {
  hit: string;
  miss: string;
  out: string;
  tiers: { from: string; to: string; hit: string; miss: string; out: string }[];
};

type Price = NonNullable<CatalogModel['price']>;
type Tier = NonNullable<Price['tiers']>[number];

const numText = (n?: number) => (typeof n === 'number' && Number.isFinite(n) ? String(n) : '');
const numOf = (s: string): number | null => {
  const t = s.trim();
  return t && Number.isFinite(Number(t)) ? Number(t) : null;
};
/**
 * 时间写得宽松也认：`8` / `8:30` / `8：30` / `8点30` / `0830` / `830` 都收，一律落成 `HH:MM`。
 * 以前只认写全的 `08:00`，敲个 8、18 就被静默丢掉 —— 看着就是"填了峰谷却没保存"。
 */
const normTime = (s: string): string | null => {
  const t = s
    .trim()
    .replace(/[：.．。]/g, ':')
    .replace(/[点时]/g, ':')
    .replace(/^:+|:+$/g, '');
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(t) ?? /^(\d{2})(\d{2})$/.exec(t) ?? /^(\d)(\d{2})$/.exec(t) ?? /^(\d{1,2})$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = m[2] === undefined ? 0 : Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
};

const timeOk = (s: string) => normTime(s) !== null;

/** 一段峰谷算不算数：起止都写得出来，且不是零长度的段（from === to 主进程会跳过） */
const tierOk = (t: { from: string; to: string }) => {
  const a = normTime(t.from);
  const b = normTime(t.to);
  return a !== null && b !== null && a !== b;
};

const draftOfPrice = (p?: Price): PriceDraft => ({
  hit: numText(p?.hit),
  miss: numText(p?.miss),
  out: numText(p?.out),
  tiers: (p?.tiers ?? []).map((t) => ({
    from: t.from,
    to: t.to,
    hit: numText(t.hit),
    miss: numText(t.miss),
    out: numText(t.out),
  })),
});

/**
 * 草稿落成配置。
 *
 * 基础三档缺一档 → 这个模型算没定价（宁可显示"未定价"，也不按 0 算出一笔假账）。
 * 峰谷段：**时间写全了就收**，段里空着的档沿用外层的基础价 —— 只改某一段的某一档、
 * 或只想换个时段价，不必把三档重抄一遍；也免得"漏填一个格子"把整段无声吞掉
 * （那正是"填了峰谷却没保存"的另一半由来）。时间没写全的段还是半截，不收进配置。
 */
const priceOfDraft = (d: PriceDraft): Price | undefined => {
  const h = numOf(d.hit);
  const m = numOf(d.miss);
  const o = numOf(d.out);
  if (h === null || m === null || o === null) return undefined;
  const tiers: Tier[] = [];
  for (const t of d.tiers) {
    if (!tierOk(t)) continue;
    tiers.push({
      from: normTime(t.from)!,
      to: normTime(t.to)!,
      hit: numOf(t.hit) ?? h,
      miss: numOf(t.miss) ?? m,
      out: numOf(t.out) ?? o,
    });
  }
  return tiers.length ? { hit: h, miss: m, out: o, tiers } : { hit: h, miss: m, out: o };
};

/** 收起时那一行显示什么：三档 + 有几段峰谷；三档没填齐就是"未定价" */
const priceSummary = (d: PriceDraft): string => {
  const h = numOf(d.hit);
  const m = numOf(d.miss);
  const o = numOf(d.out);
  if (h === null || m === null || o === null) return '未定价';
  const n = d.tiers.filter(tierOk).length;
  return `${h} / ${m} / ${o} 元` + (n ? ` · ${n} 段峰谷` : '');
};

const timeBad = (s: string) => Boolean(s.trim()) && !timeOk(s);

/** 编辑表单里一个模型的草稿：id / 显示名 / 价格草稿（价格草稿由 PriceEditor 就地改） */
type ModelDraft = { id: string; name: string; price: PriceDraft };

const modelDraftOf = (m?: CatalogModel): ModelDraft => ({
  id: m?.id ?? '',
  name: m?.name ?? '',
  price: draftOfPrice(m?.price),
});

function PriceEditor({ draft, onChange }: { draft: PriceDraft; onChange(d: PriceDraft): void }) {
  const setTier = (i: number, patch: Partial<PriceDraft['tiers'][number]>) =>
    onChange({ ...draft, tiers: draft.tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  // 说清"现在这堆东西保存下去会变成什么" —— 缺档会被判未定价、时间没写全的段会被丢掉，
  // 以前这些都是无声发生的，看起来就像填了没保存。
  const total = draft.tiers.length;
  const kept = draft.tiers.filter(tierOk).length;
  const warn = !priceOfDraft(draft) || (total > 0 && kept < total);
  const state = !priceOfDraft(draft)
    ? '三档没填齐 —— 这个模型存下去是"未定价"'
    : total === 0
      ? '存下去按这三档算'
      : kept === 0
        ? '峰谷段时间没写全，不会保存'
        : `存下去 ${kept} 段峰谷价${total > kept ? `，另有 ${total - kept} 段没写全、不保存` : ''}`;

  return (
    <>
      <div className="pv-price">
        <span className="pv-price-tag" title={t('按元 / 百万 token 算，三档都填了才生效')}>
          单价
        </span>
        <input className="pv-num" value={draft.hit} placeholder={t('命中')} onChange={(e) => onChange({ ...draft, hit: e.target.value })} spellCheck={false} />
        <input className="pv-num" value={draft.miss} placeholder={t('未命中')} onChange={(e) => onChange({ ...draft, miss: e.target.value })} spellCheck={false} />
        <input className="pv-num" value={draft.out} placeholder={t('输出')} onChange={(e) => onChange({ ...draft, out: e.target.value })} spellCheck={false} />
        <span className="pv-price-unit">{t('元/百万')}</span>
        <button
          className="pv-tier-add"
          title={t('加一段峰谷时段（本机时间，起点含、终点不含；跨零点写 22:00 → 02:00）。段里留空的档按上面三档算')}
          onClick={() => onChange({ ...draft, tiers: [...draft.tiers, { from: '', to: '', hit: '', miss: '', out: '' }] })}
        >
          ＋ 峰谷段
        </button>
      </div>
      {draft.tiers.map((tier, j) => (
        <div className="pv-tier" key={j}>
          <input
            className={`pv-time${timeBad(tier.from) ? ' is-bad' : ''}`}
            value={tier.from}
            placeholder="00:30"
            onChange={(e) => setTier(j, { from: e.target.value })}
            onBlur={(e) => setTier(j, { from: normTime(e.target.value) ?? e.target.value })}
            spellCheck={false}
          />
          <span className="pv-arrow">→</span>
          <input
            className={`pv-time${timeBad(tier.to) ? ' is-bad' : ''}`}
            value={tier.to}
            placeholder="08:30"
            onChange={(e) => setTier(j, { to: e.target.value })}
            onBlur={(e) => setTier(j, { to: normTime(e.target.value) ?? e.target.value })}
            spellCheck={false}
          />
          <input className="pv-num" value={tier.hit} placeholder={t('同上')} onChange={(e) => setTier(j, { hit: e.target.value })} spellCheck={false} />
          <input className="pv-num" value={tier.miss} placeholder={t('同上')} onChange={(e) => setTier(j, { miss: e.target.value })} spellCheck={false} />
          <input className="pv-num" value={tier.out} placeholder={t('同上')} onChange={(e) => setTier(j, { out: e.target.value })} spellCheck={false} />
          <button
            className="pv-model-del"
            title={t('删掉这一段')}
            onClick={() => onChange({ ...draft, tiers: draft.tiers.filter((_, k) => k !== j) })}
          >
            ×
          </button>
        </div>
      ))}
      <div className={`pv-price-state${warn ? ' is-warn' : ''}`}>{state}</div>
    </>
  );
}

/** 一个提供方的编辑表单：密钥 / 地址 / 模型目录 */
function ProviderForm({
  draft,
  isNew,
  onSaved,
  onCancel,
}: {
  draft: ProviderDraft;
  isNew: boolean;
  onSaved(list: CatalogProvider[]): void;
  onCancel(): void;
}) {
  const [label, setLabel] = useState(draft.label);
  const [baseUrl, setBaseUrl] = useState(draft.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ModelDraft[]>(() => (draft.models.length ? draft.models.map(modelDraftOf) : [modelDraftOf()]));
  /** 展开着的价目们 —— 想同时看/改几个模型的价都行，开几个显示几个 */
  const openModels = useOpenKeys();
  /** 「单价」按钮自己当浮层的锚点：浮层挂在 body 上，位置靠这个按钮的坐标算 */
    const [busy, setBusy] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  /** 正在问服务端要模型清单；fetched 是问完那句话（有几个，或哪儿不对） */
  const [fetching, setFetching] = useState(false);
  const [fetched, setFetched] = useState('');
  /** 拉回来的可选模型 = 选单的内容；null 就是没拉过 / 收起来了 */
  const [pickable, setPickable] = useState<CatalogModel[] | null>(null);
  /** 选单和那排按钮一起看：点到这外面就收起来 */
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.providers.catalog().then((list) => setHasKey(Boolean(list.find((p) => p.key === draft.key)?.hasKey)));
  }, [draft.key]);

  const setModel = (i: number, patch: Partial<ModelDraft>) =>
    setModels((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  // 选单开着的时候：点别处或按 Esc 就收起来（按钮自己那一段不算"别处"）
  useEffect(() => {
    if (!pickable) return;
    const onDown = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickable(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickable(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickable]);

  /**
   * 问服务端要一份模型清单，**展成一张选单**（不自动往目录里塞）。
   * 挑哪个加哪个 —— 一次拉回几十个模型全落进目录，那是给人添乱。
   */
  const fetchModels = async () => {
    if (pickable) {
      setPickable(null);
      return;
    }
    setFetching(true);
    setFetched('');
    const r = await api.providers.models({ key: draft.key, baseUrl: baseUrl.trim(), apiKey });
    setFetching(false);
    if (r.error) {
      setFetched(`没拉到：${r.error}`);
      return;
    }
    setPickable(r.models);
    setFetched(`服务端有 ${r.models.length} 个`);
  };

  /** 从选单里挑一个：只把这一条加进目录（价格照旧留空，点那一行再填） */
  const addFromPicker = (m: CatalogModel) => {
    setModels((ms) => [...ms, { id: m.id, name: m.name || m.id, price: draftOfPrice(undefined) }]);
  };

  const save = async () => {
    setBusy(true);
    const list = await api.providers.save({
      key: draft.key,
      label: label.trim() || draft.key,
      api: draft.api || 'openai-completions',
      baseUrl: baseUrl.trim(),
      apiKey,
      models: models
        .filter((m) => m.id.trim())
        .map((m) => { const price = priceOfDraft(m.price); return { id: m.id.trim(), name: (m.name || m.id).trim(), ...(price ? { price } : {}) }; }),
    });
    setBusy(false);
    onSaved(list);
  };

  return (
    <div className="pv-form">
      <div className="pv-form-head">{isNew ? '添加提供方' : `编辑 ${draft.label}`}</div>

      <label className="pv-field">
        <span>{t('名称')}</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} spellCheck={false} />
      </label>

      <label className="pv-field">
        <span>{t('API 密钥')}</span>
        <input
          value={apiKey}
          type="password"
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={hasKey ? '已配置 —— 输入新值可替换' : 'sk-...'}
        />
      </label>

      <div className="pv-sub">{t('自定义设置')}</div>

      <label className="pv-field">
        <span>{t('API 地址')}</span>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.deepseek.com"
          spellCheck={false}
        />
      </label>

      <div className="pv-sub">{t('模型目录')}</div>
      <div className="pv-note">
        {t('单价按元 / 百万 token。')}<strong>{t('模型一行一条，点那一行就展开它自己的价目')}</strong>（峰谷段也在里头加，想开几条开几条）；
        三档都填了才算数，缺一档显示"未定价"。
        <br />
        <strong>{t('懒得手抄 id 就点「列出可用模型」')}</strong>{t('：拿填好的地址和密钥问服务端要一份清单，')}
        <strong>{t('点哪个加哪个')}</strong>{t('，一次只进一条。')}
      </div>
      <div className="pv-models">
        {models.map((m, i) => (
          <div className={`pv-model-box${openModels.has(String(i)) ? ' is-open' : ''}`} key={i}>
            <div
              className="pv-model"
              title={openModels.has(String(i)) ? '收起这个模型的单价' : '改这个模型的单价'}
              onClick={(e) => {
                // 行里的输入框、删除按钮自己管自己，别顺手把这一行也展开了
                if ((e.target as HTMLElement).closest('input, .pv-model-del')) return;
                openModels.toggle(String(i));
              }}
            >
              <span className="pv-caret">▸</span>
              <input value={m.id} placeholder={t('模型 id')} onChange={(e) => setModel(i, { id: e.target.value })} spellCheck={false} />
              <input value={m.name} placeholder={t('显示名')} onChange={(e) => setModel(i, { name: e.target.value })} spellCheck={false} />
              <span className="pv-price-sum">{priceSummary(m.price)}</span>
              <button className="pv-model-del" onClick={() => { setModels((ms) => ms.filter((_, j) => j !== i)); openModels.shiftAfterDrop(i); }} title={t('删掉这个模型')}>
                ×
              </button>
            </div>
            {openModels.has(String(i)) && (
              <div className="pv-model-body">
                <PriceEditor draft={m.price} onChange={(p) => setModel(i, { price: p })} />
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="pv-model-actions" ref={pickerRef}>
        <button className="pv-add-model" onClick={() => { setModels((ms) => [...ms, modelDraftOf()]); openModels.toggle(String(models.length)); }}>
          ＋ 添加模型
        </button>
        <button
          className="pv-add-model"
          disabled={fetching}
          onClick={() => void fetchModels()}
          title={t('用上面的地址和密钥问服务端有哪些模型')}
        >
          {fetching ? '正在拉取…' : pickable ? '▾ 收起清单' : '▾ 列出可用模型'}
        </button>
        {fetched && <span className="pv-fetch-state">{fetched}</span>}
        {pickable && (
          <div className="pv-picker">
            {pickable.length === 0 && <div className="pv-picker-note">{t('这个地址没给出模型列表')}</div>}
            {pickable.map((m) => {
              const added = models.some((x) => x.id.trim() === m.id);
              return (
                <button
                  key={m.id}
                  className={`pv-picker-row${added ? ' is-added' : ''}`}
                  disabled={added}
                  title={added ? '已经在目录里了' : '加进模型目录'}
                  onClick={() => addFromPicker(m)}
                >
                  <span className="pv-picker-id">{m.id}</span>
                  <span className="pv-picker-flag">{added ? '已加入' : '＋'}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="pv-form-actions">
        <button onClick={onCancel}>{t('取消')}</button>
        <button className="primary" disabled={busy} onClick={() => void save()}>
          保存
        </button>
      </div>
    </div>
  );
}