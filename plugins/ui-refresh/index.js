/**
 * 界面源码一改，界面自己就重建 + 刷新 —— 不重启，也不来问用户点头。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 *
 * 界面（含插件的 panel.tsx / panel.css）是**构建期**被打进 dist/renderer 的，
 * 窗口读的是磁盘上那份产物（src/main/windows.ts 的 loadFile，没有 dev server 就没有 HMR）。
 * 所以"改完界面，界面上什么也没变"是必然的：光是 reload 窗口没用，读到的还是旧包，
 * 必须重新跑一次 vite build。
 *
 * 而这一步以前只有 full 档的工具（build_project / restart_project）够得着，
 * 插件面板只拿得到 write 档 —— 于是每改一次界面，都得让用户去点一下确认重启。
 *
 * 顺带说清楚：纯界面改动本来**不需要重启**（核心 src/main/project.ts 的 restart()
 * 已经把它降级成"重建界面 + 刷新窗口"），要点头的那道确认只对"真会杀掉进程的主进程改动"
 * 才是必要的。这个插件就是把那条降级路径变成环境行为。
 *
 * ── 为什么是插件，不是核心 ────────────────────────────────────────────
 *
 * 它不画界面、不参与对话，只是"存盘 → 重建 → 刷新"这一个流程；插件跑在主进程，
 * spawn 和 BrowserWindow 都够得着。放进核心反而更贵：核心一动就得重启一次才生效，
 * 而插件的 index.js 是**运行时**从 plugins/<名>/index.js 读的（见 plugins.ts 的
 * pluginRoots / loadPlugins），落一个文件，下一条消息扫目录时就装上了。
 *
 * ── 什么时候才上屏（这一条是后加的，原来说明里没有）──────────────────
 *
 * **自动构建等模型这一轮跑完，再构建并刷新窗口。**
 * 一轮里常常连着改好几个文件，以前是落盘（约 1 秒后）刷一次：刷的全是半成品，
 * 用户那边的输入框草稿、滚动位置也跟着被顶掉几回。
 * 判定的锚点是面板的 live —— 它的生命周期就是**整轮**（开跑挂上、轮末清掉，
 * 见核心 index.ts 的 setLiveStats），所以"没有面板在跑"就等于"它写完了"。
 * 取不到"轮末"这种事件，只能每秒看一眼（只读内存里那份快照，且只在有结果压着时才跑）。
 * 兜底：压过 MAX_HOLD_MS 还没等到轮末就先刷一次 —— 一轮可能跑几分钟（出图那种），
 * 总不能让界面上一直是旧的。
 *
 * ── 边界（故意的）────────────────────────────────────────────────────
 *
 * 只盯界面那一半：src/renderer、src/shared、插件的 panel.tsx / panel.css。
 * src/main 改了**不碰** —— 它的代码已经在内存里跑着，热替换不了，只能真重启，
 * 那条路还是走原来那道要用户点头的确认。
 *
 * ── 还得告诉模型一声 ──────────────────────────────────────────────────
 *
 * 光把行为做出来不够：模型不知道有这回事，照样会在回复里写"请你点一下构建 / 重启"，
 * 用户就白等一趟。所以这里顺手挂一段 `api.addPrompt` —— 拼在**本轮用户消息的末尾**
 * （不进系统提示，理由见 index.ts 的 pluginExtras），每块面板说一次就够。
 */

const fs = require('fs');
const path = require('path');

/** 改完等这么久没再动才动手：编辑器保存一次常常连着触发好几个事件 */
const QUIET_MS = 800;
/** 有构建结果压着等"轮末"时，多久看一眼跑完没有 */
const HOLD_POLL_MS = 1000;
/** 最多压这么久：一轮可能跑几分钟（出图那种），不能让界面一直停在旧的上面 */
const MAX_HOLD_MS = 120000;

const EXTS = new Set(['.tsx', '.ts', '.css', '.html']);
/** 盯哪几个目录（相对应用目录） */
const WATCH = ['src/renderer', 'src/shared', 'plugins'];

const PARAMS = {
  enabled: {
    label: t('开启自动构建与刷新'),
    type: 'bool',
    default: false,
    hint: t('开发修改界面源码时开启；平时使用建议关闭，避免后台构建占 CPU 与白屏闪烁'),
  },
  quietMs: {
    label: t('防抖延迟（毫秒）'),
    type: 'number',
    default: 1500,
    min: 500,
    max: 10000,
    hint: t('文件修改停止后多久开始构建'),
  },
};

let stopWatching = null;

function safeRequire(name) {
  try {
    return require(name);
  } catch {
    return null;
  }
}

/** 是不是"改了它就得重建界面"的文件 */
function relevant(rel) {
  const p = String(rel).split('\\').join('/');
  if (p.startsWith('dist/') || p.startsWith('node_modules/') || p.startsWith('.ensoul/') || p.startsWith('.')) return false;
  if (!EXTS.has(path.extname(p).toLowerCase())) return false;
  // 插件的脑（index.js）住主进程，改了它不用重建界面；脸和皮才进构建
  if (p.startsWith('plugins/')) return /^plugins\/[^/]+\/panel\.(tsx|css)$/.test(p);
  return p.startsWith('src/renderer/') || p.startsWith('src/shared/');
}

module.exports = {
  params: PARAMS,
  name: 'ui-refresh',
  description: t('界面源码一改就自己重建并刷新窗口，不用重启也不用来问用户'),

  setup(api) {
    if (stopWatching) {
      try { stopWatching(); } catch {}
      stopWatching = null;
    }

    const enabled = api && typeof api.param === 'function'
      ? api.param('enabled', PARAMS.enabled.default) === true
      : false;

    if (!enabled) {
      api.log(t('界面自动刷新未开启（可根据需要在 设置-插件参数 中开启）'));
      stopWatching = () => {};
      return;
    }

    const quietMs = Math.max(500, Math.min(10000, Number(api.param('quietMs', PARAMS.quietMs.default)) || 1500));
    const el = safeRequire('electron');
    const root = el && el.app && typeof el.app.getAppPath === 'function' ? el.app.getAppPath() : '';
    if (!root) {
      api.log(t('拿不到应用目录（不在 Electron 里？），不盯界面源码了'));
      return;
    }

    let timer = null;
    let building = false;
    let again = false;
    let fails = 0;
    /** 上一次重建之后真刷新了几个窗口 —— 这个数字是"改动到底有没有上屏"的凭据 */
    let lastReload = 0;
    let lastOut = '';
    /** 最近一次构建花了多少秒（压着的那次上屏时要写进状态文件） */
    let lastSecs = '0';
    /** 已经构建好、但压着还没上屏 —— 等模型这一轮整个跑完再放出去 */
    let held = false;
    let heldAt = 0;
    let holdTimer = null;
    const watchers = [];

    /**
     * 界面上那一小块字：只在**构建失败**或**压着没上屏**时显示，都好就消失
     * （成功了本来就不该占地方）。
     */
    if (typeof api.addStatusItem === 'function') {
      api.addStatusItem({
        id: 'ui-refresh',
        text: () => (fails ? `界面重建失败 ×${fails}` : held ? t('界面待上屏') : ''),
        title: () =>
          fails
            ? `${lastOut.slice(-600)}`
            : held
              ? t('界面已经构建好了，等这一轮跑完自动刷新窗口')
              : t('界面源码改完会自动重建并刷新窗口'),
      });
    }

    /**
     * 告诉干活的模型：这里改了界面会自己生效，别再开口要用户点构建 / 重启。
     *
     * 三条纪律照 agents-md 抄：不放进系统提示（那会把缓存前缀整段作废）、同一块面板
     * 同一个状态只发一次（背景知识不需要每轮复述）、面板一删记账跟着走。
     * 唯一的多余动作是**失败时重发** —— 那正是最需要模型知道的时候，顺带把报错尾巴带上，
     * 省得它再去翻日志。
     */
    const told = new Map(); // panelId -> 上次说过的状态：'ok' 或 'fail:N'

    if (typeof api.addPrompt === 'function') {
      api.addPrompt((ctx) => {
        const key = (ctx && ctx.panelId) || '';
        const state = fails ? `fail:${fails}` : 'ok';
        const live = new Set(api.panels().map((p) => p.id));
        for (const k of [...told.keys()]) if (k !== key && !live.has(k)) told.delete(k);
        if (told.get(key) === state) return '';
        told.set(key, state);

        const head =
          t('【界面自动刷新】这个工作区挂着 ui-refresh：改了界面源码（src/renderer、src/shared、') +
          t('插件的 panel.tsx / panel.css）后不用要求用户构建或重启 —— 文件稳定且当前会话结束后，它请求共享构建服务完成类型门禁和界面构建。') +
          t('等你这一轮整个结束才一次性上屏（一轮里往往连改好几个文件，中途刷的全是半成品，') +
          t('还会把用户正看的滚动位置顶掉）。所以 read_logs 里看到「界面已重建」只等于编译过了，') +
          t('看到「界面已上屏」才是真在窗口上了 —— 别对用户说"已经生效"，更别要求他点重启。') +
          t('只有改了 src/main 才必须真重启，那道确认要用户点。');
        return fails
          ? `${head}\n（上一次重建**失败**了，第 ${fails} 次，报错尾巴：\n\`\`\`\n${lastOut.slice(-800)}\n\`\`\`）`
          : head;
      });
    }

    /**
     * 有没有哪块面板正在跑一轮（含它这一轮里的工具调用）。
     *
     * live 账的生命周期就是**整轮**：开跑时挂上、轮末（跑完或被中断）才清掉
     * （核心 index.ts 的 setLiveStats），所以"没有面板在跑"是"它写完了"最准的信号 ——
     * 比盯文件事件准得多：文件事件只知道"刚动过一笔"，不知道后面还有没有下一笔。
     */
    function busy() {
      try {
        const ps = api.panels();
        return Array.isArray(ps) && ps.some((p) => p && (api.isRunning ? api.isRunning(p.id) : p.live));
      } catch {
        return false;
      }
    }

    /**
     * 构建好了，但模型这一轮还在跑：先压着，等它跑完再刷。
     *
     * 没有"轮末"的钩子可用，只能自己盯着 busy() 轮询 —— 每秒一次，读的是内存里那份
     * 面板快照，而且只在有构建结果压着的时候才跑，不算负担。
     */
    function holdUntilIdle() {
      if (!held) {
        held = true;
        heldAt = Date.now();
      }
      if (holdTimer) return;
      holdTimer = setInterval(() => {
        const waited = Date.now() - heldAt;
        if (busy() && waited < MAX_HOLD_MS) return;
        clearInterval(holdTimer);
        holdTimer = null;
        flushHeld(waited >= MAX_HOLD_MS && busy() ? `压了 ${Math.round(waited / 1000)}s 还没等到轮末，先刷` : '等这一轮跑完才刷的');
      }, HOLD_POLL_MS);
    }

    /** 把压着的那次上屏放出去 */
    function flushHeld(why) {
      if (!held) return;
      held = false;
      const n = reload();
      api.log(`界面已上屏（${why || t('等这一轮跑完才刷的')}），刷新了 ${n} 个窗口`);
      note(true, lastSecs, '');
    }

    function reload() {
      const e2 = safeRequire('electron');
      const wins =
        e2 && e2.BrowserWindow && typeof e2.BrowserWindow.getAllWindows === 'function'
          ? e2.BrowserWindow.getAllWindows()
          : [];
      let n = 0;
      for (const w of wins) {
        try {
          const wc = w && w.webContents;
          if (!wc) continue;
          // 一定要绕缓存：文件是新的，窗口里那份 html 可能还是旧的
          if (typeof wc.reloadIgnoringCache === 'function') wc.reloadIgnoringCache();
          else wc.reload();
          n += 1;
        } catch (err) {
          api.log(`刷新窗口失败：${(err && err.message) || err}`);
        }
      }
      lastReload = n;
      return n;
    }

    /** 最近一次结果落盘：想知道"到底重建了没有"，读这个文件就行，不用翻日志 */
    function note(ok, secs, out) {
      try {
        fs.mkdirSync(path.join(root, '.ensoul', 'state'), { recursive: true });
        fs.writeFileSync(
          path.join(root, '.ensoul', 'state', 'ui-refresh.json'),
          JSON.stringify(
            {
              at: Date.now(),
              ok,
              secs: Number(secs),
              fails,
              reloaded: lastReload,
              // 构建好了但压着没上屏（等模型这一轮跑完）：读这个文件的人别把它当"已生效"
              held,
              out: String(out || '').slice(-1500),
            },
            null,
            2,
          ),
        );
      } catch {
        /* 写不下就算了，不影响构建本身 */
      }
    }

    async function build() {
      if (building) {
        again = true; // 正在构建时又改了：这次跑完再来一次
        return;
      }
      building = true;
      const t0 = Date.now();
      let r;
      try { r = await api.buildProject('renderer', 'app'); }
      catch (error) { r = { ok: false, out: error?.message || String(error) }; }
      finally { building = false; }
      if (disposed) return;
      const secs = ((Date.now() - t0) / 1000).toFixed(1);

      if (r.ok) {
        fails = 0;
        lastOut = '';
        lastSecs = secs;
        if (busy()) {
          // 构建照做（模型自己要 read_logs 看编译过没过），但窗口先别动：
          // 它这一轮还没写完，现在刷等于把半成品摆到用户眼前
          api.log(`界面已重建（${secs}s），先压着 —— 等这一轮跑完再上屏`);
          holdUntilIdle();
        } else {
          // 没人跑着（用户自己在编辑器里改的这类）：照旧立刻刷
          if (holdTimer) clearInterval(holdTimer);
          holdTimer = null;
          held = false;
          const n = reload();
          api.log(`界面已重建（${secs}s），刷新了 ${n} 个窗口`);
        }
      } else {
        fails += 1;
        lastOut = r.out;
        api.log(`界面重建失败（第 ${fails} 次，${secs}s）：\n${r.out}`);
      }
      note(r.ok, secs, r.out);

      if (again) {
        again = false;
        schedule();
      }
    }

    const mtimes = new Map();
    let disposed = false;

    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (disposed) return;
        if (busy()) { schedule(); return; }
        void build();
      }, quietMs);
    }

    for (const rel of WATCH) {
      const abs = path.join(root, rel);
      if (!fs.existsSync(abs)) continue;
      try {
        watchers.push(
          fs.watch(abs, { recursive: true }, (_ev, file) => {
            // Windows 下 file 经常为 null 或空，绝不盲目假触发
            if (!file) return;
            const fullRel = path.join(rel, String(file)).split('\\').join('/');
            if (!relevant(fullRel)) return;
            // 校验文件修改时间，防止属性读取等无效变动
            const absTarget = path.join(root, fullRel);
            try {
              const stat = fs.statSync(absTarget);
              if (!stat.isFile()) return;
              const prev = mtimes.get(fullRel) || 0;
              if (stat.mtimeMs <= prev) return;
              mtimes.set(fullRel, stat.mtimeMs);
            } catch {
              return;
            }
            schedule();
          }),
        );
      } catch (err) {
        api.log(`盯 ${rel} 没盯上：${(err && err.message) || err}`);
      }
    }
    api.log(`界面自动刷新已就位：盯着 ${watchers.length} 个目录，改完 ${quietMs}ms 自动重建 + 刷新`);

    stopWatching = () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (holdTimer) clearInterval(holdTimer);
      holdTimer = null;
      held = false;
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* 已经关了 */
        }
      }
      watchers.length = 0;
    };
  },

  /** 插件文件改了会重载：旧实例的 watcher 必须收掉，不然每改一次就多一套 */
  dispose() {
    if (stopWatching) stopWatching();
    stopWatching = null;
  },
};
