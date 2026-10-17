/**
 * turn-resume —— 断点续跑（类 codex 的 resume）。
 *
 * ══ 它补的是哪一个洞 ═══════════════════════════════════════════════════
 *
 * 这个软件已经把"一轮为什么停"记得很清楚：每条助手消息上有 `endReason`
 * （done / stopped / failed）和 `failCode`（哪一类断的），进程级的中断另有
 * 一张流水条（`.ensoul/state/turn-journal.json`）。但**记下来不等于接得上**：
 *
 *   · 上游超时 / 连接断 / 空响应 —— 消息里那条 ⚠ 就摆在那儿，然后就没有然后了。
 *     用户得自己打一句「继续」，而模型这时候已经**看不见断点在哪**了
 *     （从头重来等于把已经花掉的 token 再花一次，还不一定落在同一个地方）。
 *   · 正文撞上输出长度上限 —— 核心会提示「说『继续』我把剩下的补完」，
 *     可那是一句人话，得**人来念**。
 *   · 进程被杀在半路 —— 流水条记了 crashed，面板上却一个字都没有，
 *     用户回来只看到半截对话，不知道它干到哪儿了。
 *
 * 这个插件把这三件事接上：**认得出断点、说得出断在哪、接得回去**。
 *
 * ══ 什么能自动续，什么绝不 ════════════════════════════════════════════
 *
 * 唯一的硬纪律：**用户按的停止一次都不许自动续**。
 * 判据是现成的 —— `endReason === 'stopped'` 就是"意图"，核心自己也是这么分的
 * （见 index.ts 里"失败和用户按了停止在这儿分手"那段）。它默认只在状态条上挂着、
 * 由人点；自动那条路一个字都不碰它。
 *
 * 能自动续的只有**事故**：TIMEOUT / TRANSPORT / EMPTY_RESPONSE / RATE_LIMIT /
 * SERVER 五类。认证错、请求不合法那些续了也白续，只会烧钱。
 *
 * ══ 怎么不烧钱 ═══════════════════════════════════════════════════════
 *
 *   · 一个断点续一次就记账（面板 + 类型 + 那条消息的 id），续不上不再重复；
 *   · 同一块面板最多 maxTries 次，每次退避翻倍；
 *   · 超过 window 秒的老断点不自动续（用户多半早换话题了），只在状态条上挂着；
 *   · 用户在那之后又说过话（含插话）—— 他早自己接上了，一个字都不发。
 *
 * ══ 它是外挂，核心一个字没改 ══════════════════════════════════════════
 *
 * 读：`api.panels()` 的面板正文 + 流水条（只读，不往回写）。
 * 写：`api.send()`（起一轮）。续跑那句走 silent（进历史、不上屏）——
 * 用户没说过那句话，它就不该在对话里冒充他说；跟 delivery-alert 叫醒发起人
 * 是同一个道理，只是这里叫的是"断在半路的那一轮自己"。
 *
 * 状态：`.ensoul/state/turn-resume.json`（按工作区隔离，见 storage 声明）。
 */

const fs = require('fs');

/** 可调参数（设置面板里能改，助手也能改 —— 见 plugins/plugin-kit） */
const PARAMS = {
  auto: { label: t('上游断掉后自动接着跑'), type: 'bool', default: true, hint: t('只对"事故型"断点生效（超时 / 连接断 / 空响应 / 限流 / 服务端错）；用户自己按的停止一律不自动续') },
  truncate: { label: t('正文被输出长度截断时自动补完'), type: 'bool', default: true, hint: t('一轮回复写到一半撞上输出上限，自动接着补，不用手打「继续」') },
  crash: { label: t('进程崩在半路后续跑'), type: 'bool', default: true, hint: t('上次软件没退干净（进程被杀）留下的断点，下次开机后自动接着做') },
  window: { label: t('断点多久之内还算「刚断的」（秒）'), type: 'number', default: 1800, min: 60, max: 86400, hint: t('隔太久的断点只在状态条上提示，不自动续 —— 用户多半早换话题了') },
  maxTries: { label: t('同一块面板最多自动续几次'), type: 'number', default: 2, min: 1, max: 10, hint: t('续了还是断，就不再自动动它，只留在状态条上由人点') },
  backoff: { label: t('第一次续跑前等多久（秒）'), type: 'number', default: 20, min: 5, max: 600, hint: t('给上游缓一口气；同一块面板后续每次翻倍') },
};

/**
 * 可恢复的失败类别 —— 这是"事故"的名单。
 * 认证错（AUTH）、请求不合法（REQUEST）续了还是同一句话，不在名单里。
 * 跟 delivery-alert 那份 RECOVERABLE 是同一个口径。
 */
const RECOVERABLE = { TIMEOUT: 1, TRANSPORT: 1, EMPTY_RESPONSE: 1, RATE_LIMIT: 1, SERVER: 1 };

/** 断点类型翻成人话（状态条上那一行字要用） */
const KIND_LABEL = {
  failed: () => t('上游断掉'),
  truncate: () => t('正文被截断'),
  crashed: () => t('进程断在半路'),
  stopped: () => t('被按停'),
};

/**
 * 正文被输出长度上限截断时，核心往回复里追的那句话（见 chat-core 的 finishReason === 'length'）。
 * 中英两种都认 —— 界面语言切过之后落盘的正文可能是英文那份。
 */
const CUT_RE = /(输出长度上限截断|cut off by the output length)/;

/** 核心落的流水条：只读。形状不对就整条跳过，别让别人的脏数据带崩这里 */
const JOURNAL = '.ensoul/state/turn-journal.json';
/** "续过了"最多记多少条 */
const DONE_MAX = 60;
/** 多久扫一遍。界面那一跳是 1.5 秒，这个不必更密 —— 反正要等退避 */
const TICK = 5000;

/** 模块级：dispose 要能收掉它（插件文件改了会重装，旧的那份靠这个收摊） */
let timer = null;

module.exports = {
  params: PARAMS,
  name: 'turn-resume',
  description: t('断点续跑：上游断了 / 正文被截断 / 进程崩在半路，自动或一句话接着上次的位置往下做'),

  /**
   * 状态按工作区隔离 —— 不声明这行就落在全局目录里，所有工作区共读一份：
   * 换个工作区还挂着上一个工作区的断点（跟 target-dir 同一个坑）。
   */
  storage: { project: ['.ensoul/state/turn-resume.json'] },

  setup(api) {
    /** 参数 setup 时读一次就够 —— 改了参数核心会让插件重新 setup */
    const conf = {
      auto: api.param('auto') !== false,
      truncate: api.param('truncate') !== false,
      crash: api.param('crash') !== false,
      window: Math.max(60, Number(api.param('window')) || 1800) * 1000,
      maxTries: Math.max(1, Number(api.param('maxTries')) || 2),
      backoff: Math.max(5, Number(api.param('backoff')) || 20) * 1000,
    };

    /** 磁盘上那份可能旧了、或者被人手改坏了 —— 只信字段齐全的那部分 */
    const raw = api.state.load(null) || {};
    let done = raw && typeof raw.done === 'object' && raw.done ? { ...raw.done } : {};
    let tries = raw && typeof raw.tries === 'object' && raw.tries ? { ...raw.tries } : {};

    function save() {
      // "续过了"只留最近的一批 —— 不然这个文件会一直长
      const keys = Object.keys(done)
        .sort((a, b) => Number(done[b] || 0) - Number(done[a] || 0))
        .slice(0, DONE_MAX);
      const next = {};
      for (const k of keys) next[k] = done[k];
      done = next;
      try {
        api.state.save({ at: Date.now(), done, tries });
      } catch (e) {
        api.log(`状态写不下去：${(e && e.message) || e}`);
      }
    }

    /** 此刻的断点：面板 id -> 断点。状态条只读它，不现扫（那一路每广播一次都会跑） */
    let cache = new Map();
    /** 缓存指纹 —— 变了才喊界面重画，免得每 5 秒广播一整个工作区快照 */
    let stamp = '';
    let busy = false;

    const keyOf = (bp) => `${bp.panelId}:${bp.kind}:${bp.anchor}`;

    /**
     * 这一轮断在**哪一步** —— 从流水条里取，取不到就空串。
     *
     * 为什么不从消息本身拿：消息上只有正文和账，"最后调的是哪个工具"只有流水条记着
     * （核心的 noteTool 每调一次工具就 turnStep 一次）。续跑那句把它说给模型听，
     * 它才知道该从哪儿接手，而不是把整件活从头再来一遍。
     *
     * 只认**同一块面板、且时刻不早于这一轮开始**的那条 —— 面板跑过很多轮，
     * 取错了就成了"上上次卡在哪儿"，比不说还坏。
     */
    function lastStepOf(panelId, since) {
      try {
        const file = api.dataPath(JOURNAL);
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        const rows = (Array.isArray(j && j.turns) ? j.turns : []).filter(
          (row) => row && row.panelId === panelId && (Number(row.at) || 0) >= (since || 0) - 1000,
        );
        const last = rows[rows.length - 1];
        return last && last.step ? String(last.step).slice(0, 80) : '';
      } catch {
        return '';
      }
    }

    /** 这一块面板的正文里，最后一条助手消息算不算"断点" */
    function detectPanel(p) {
      const chat = Array.isArray(p.chat) ? p.chat : [];
      let idx = -1;
      let last = null;
      for (let i = chat.length - 1; i >= 0; i -= 1) {
        const m = chat[i];
        if (m && m.role === 'assistant' && !m.silent) {
          last = m;
          idx = i;
          break;
        }
      }
      if (!last) return null;
      /**
       * 用户在那之后又说过话（插话也算）—— 他自己早接上了，这里就别再插嘴。
       * 少了这一条，用户断了一次之后正常接着聊，这个插件会在半路又替他开一轮。
       */
      for (let i = idx + 1; i < chat.length; i += 1) {
        const m = chat[i];
        if (m && m.role === 'user' && !m.silent) return null;
      }

      // 断在**什么时候**：优先用这一轮的收尾时刻（stats.at）—— 一轮可能跑几十分钟，
      // 拿创建时刻当"刚断的"，退避和窗口判断都会差一大截。没有才退回创建时刻。
      const at = Number(last.stats && last.stats.at) || Number(last.createdAt) || 0;
      const base = { panelId: p.id, title: p.title || p.id, msgId: last.id, at, anchor: last.id };

      if (last.endReason === 'failed') {
        const code = String(last.failCode || '');
        if (!RECOVERABLE[code]) return null;
        // "断在哪一步"从流水条里取 —— 续跑那句把它说给模型听，它才知道该从哪儿接手
        return { ...base, kind: 'failed', code, step: lastStepOf(p.id, at) };
      }
      if (last.endReason === 'stopped') {
        return { ...base, kind: 'stopped', code: 'STOPPED', step: '' };
      }
      // 正文撞上输出上限：核心追的那句警告就落在正文里，它是这一类的唯一凭据
      if (CUT_RE.test(String(last.content || ''))) {
        return { ...base, kind: 'truncate', code: 'LENGTH', step: '' };
      }
      return null;
    }

    /**
     * 那一轮**断在哪一步**（从流水条里取，只读）。
     *
     * 只认不晚于这个断点时刻的那几条 —— 同一个面板可能还有更早的正常轮，
     * 不按时间卡，就会报出上次那条无关的步骤。取最近一条。
     */
    function lastStepOf(panelId, at) {
      try {
        const file = api.dataPath(JOURNAL);
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        const rows = (Array.isArray(j && j.turns) ? j.turns : []).filter(
          (row) => row && row.panelId === panelId && row.step && (!at || Number(row.at || 0) <= at + 60000),
        );
        const last = rows[rows.length - 1];
        return last ? String(last.step) : '';
      } catch {
        return ''; // 没有流水条就是没有 —— 这一步说不出来不影响续跑
      }
    }

    /** 流水条里挂着 crashed 的 —— 就是"上次进程死在这一步上" */
    function detectCrashed(byId, taken) {
      const out = [];
      try {
        const file = api.dataPath(JOURNAL);
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        const rows = Array.isArray(j && j.turns) ? j.turns : [];
        for (const row of rows) {
          if (!row || row.status !== 'crashed' || !row.panelId) continue;
          if (taken.has(row.panelId)) continue; // 那块面板最后的助手消息本身就是个断点，交给上面那条
          const at = Number(row.endedAt || row.at) || 0;
          const p = byId.get(row.panelId);
          if (!p) continue; // 面板已经关掉了，续回去也没地方落
          /**
           * 崩过之后这块面板**又正常跑过**了 —— 流水条还留着那条 crashed，可事早翻篇了。
           * 少了这一条，每开一次软件都会把一块早恢复正常的面板再报成断点，
           * 而它一旦真去续，就是平白多起一轮无关的对话。
           */
          const chat = Array.isArray(p.chat) ? p.chat : [];
          if (chat.some((m) => m && m.role === 'assistant' && !m.silent && Number(m.createdAt || 0) > at)) continue;
          out.push({
            panelId: row.panelId,
            title: p.title || row.panelId,
            kind: 'crashed',
            code: 'CRASH',
            anchor: `${at}:${String(row.text || '').slice(0, 40)}`,
            at,
            step: String(row.step || ''),
            msgId: '',
          });
        }
      } catch {
        /* 没有流水条就是没有（新工作区、或者还没跑过一轮） */
      }
      return out;
    }

    /** 扫一遍全工作区，返回此刻所有断点（面板 id 去重：一块面板只留一个） */
    function scan() {
      const panels = api.panels() || [];
      const byId = new Map(panels.map((p) => [p.id, p]));
      const found = [];
      const taken = new Set();
      for (const p of panels) {
        const bp = detectPanel(p);
        if (!bp) continue;
        taken.add(p.id);
        found.push(bp);
      }
      if (conf.crash) {
        for (const bp of detectCrashed(byId, taken)) {
          taken.add(bp.panelId);
          found.push(bp);
        }
      }
      const next = new Map();
      for (const bp of found) next.set(bp.panelId, bp);
      return next;
    }

    /** 缓存换了没有 —— 换了才喊界面重画 */
    function syncCache(next) {
      const key = [...next.values()].map((bp) => keyOf(bp)).sort().join('|');
      cache = next;
      if (key === stamp) return;
      stamp = key;
      api.refresh();
    }

    /**
     * 这一块面板这一刻该不该自动续。
     *
     * 返回空串 = 不续（并且说明为什么，好让状态条上那句 title 讲得清）。
     * 返回一段文字 = 该续了，这段就是要发过去的话。
     */
    function autoReason(bp) {
      if (bp.kind === 'stopped') return ''; // 用户按的停止，永远不自动 —— 这一条不许改
      if (bp.kind === 'failed' && !conf.auto) return '';
      if (bp.kind === 'truncate' && !conf.truncate) return '';
      if (bp.kind === 'crashed' && !conf.crash) return '';
      const age = Date.now() - bp.at;
      if (age > conf.window) return '';
      if (done[keyOf(bp)]) return '';
      const n = Math.max(0, Number((tries[bp.panelId] || {}).n) || 0);
      if (n >= conf.maxTries) return '';
      // 退避：第一次等 backoff，往后每续一次翻倍
      if (age < conf.backoff * 2 ** n) return '';
      return reviveText(bp);
    }

    /** 续跑那一刻要说的话 —— 说清"断在哪、别从头来" */
    function reviveText(bp) {
      if (bp.kind === 'failed') {
        const where = bp.step ? t('，当时正跑在「{s}」这一步', { s: bp.step }) : '';
        // 断在半路时，最后那一步可能已经做完、也可能只做了一半 —— 让它自己看一眼再接着走，
        // 但**不要重头再来**（那会把已经花掉的 token 再花一遍，还不一定落在同一处）。
        return t('【断点续跑】上一轮被上游断掉了（{c}）{w}。先确认到那一步为止已经落地的结果（该读的读一眼、该看的看一眼），再接着往下做 —— 不要从头重来、也不要复述这一条。', { c: bp.code, w: where });
      }
      if (bp.kind === 'truncate') {
        return t('【断点续写】上一轮正文撞上输出长度上限、被截断了。接着那句话往下补完，不要重复已经说过的部分。');
      }
      if (bp.kind === 'crashed') {
        return t('【断点续跑】上次软件在「{s}」这一步被中断了（进程没退干净）。先确认那一步的现状（文件写到哪、命令跑没跑完），再接着把它做完，不要从头重来。', {
          s: bp.step || t('未知步骤'),
        });
      }
      return t('【断点续跑】接着上一轮的位置往下做。');
    }

    /** 真去续一次 —— 自动那条路和手动那条路都走它 */
    async function revive(panelId, why) {
      const bp = cache.get(String(panelId || ''));
      if (!bp) return { ok: false, error: t('这块面板没有断点') };
      if (api.isRunning(bp.panelId)) return { ok: false, error: t('它正在跑，等这一轮跑完再说') };
      const text = why || reviveText(bp);
      try {
        // silent：进历史、不上屏 —— 用户没说过这句话，它就不该在对话里冒充他说。
        // steer：核心自己分流（没在跑就是普通 send），这里不自己判一次。
        const r = await api.send(bp.panelId, text, undefined, { silent: true, steer: true });
        if (!r || r.ok === false) {
          const rec = tries[bp.panelId] || { n: 0 };
          tries[bp.panelId] = { n: Math.max(1, Number(rec.n) || 0), at: Date.now() };
          save();
          return { ok: false, error: (r && r.error) || t('没发出去') };
        }
        done[keyOf(bp)] = Date.now();
        const rec = tries[bp.panelId] || { n: 0 };
        tries[bp.panelId] = { n: (Number(rec.n) || 0) + 1, at: Date.now() };
        save();
        api.log(`[turn-resume] 已续跑 ${bp.panelId}（${bp.kind}）`);
        return { ok: true, kind: bp.kind, panelId: bp.panelId, title: bp.title };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    }

    async function tick() {
      if (busy) return;
      busy = true;
      try {
        const found = scan();
        syncCache(found);
        for (const bp of found.values()) {
          const text = autoReason(bp);
          if (!text) continue;
          if (api.isRunning(bp.panelId)) continue;
          // 先记"续过了"再发：send 那条路可能把断点本身改掉（新消息进来），
          // 反过来的话同一跳里就可能在旧基准上再续一次
          done[keyOf(bp)] = Date.now();
          save();
          const r = await revive(bp.panelId, text);
          if (!r.ok) api.log(`[turn-resume] ${bp.panelId} 没续上：${r.error}`);
        }
      } catch (e) {
        // 续跑失败不该变成反复重试的噪音
        api.log(`[turn-resume] ${String((e && e.message) || e)}`);
      } finally {
        busy = false;
      }
    }

    /** 状态条上那段悬停说明 —— 讲清"断在哪、为什么没自动续" */
    function detail(bp) {
      const lines = [`${bp.title}：${KIND_LABEL[bp.kind] ? KIND_LABEL[bp.kind]() : bp.kind}`];
      if (bp.kind === 'failed') lines.push(t('断在哪一类：{c}', { c: bp.code }));
      if (bp.kind === 'crashed' && bp.step) lines.push(t('断在这一步：{s}', { s: bp.step }));
      const age = Math.round((Date.now() - bp.at) / 1000);
      lines.push(t('断了多久：{n} 秒前', { n: age }));
      if (bp.kind === 'stopped') {
        lines.push(t('这是用户按的停止 —— 不会自动续，要接着做就点下面那一条。'));
      } else if (age * 1000 > conf.window) {
        lines.push(t('已经超过 {m} 分钟了，不再自动续（改「断点多久之内还算刚断的」可以放宽）。', { m: Math.round(conf.window / 60000) }));
      } else if (done[keyOf(bp)]) {
        lines.push(t('已经自动续过一次；续了还是断就不再自动动它。'));
      } else {
        lines.push(t('到点会自动接着做，也可以现在点。'));
      }
      return lines.join('\n');
    }

    // ── 会话框顶上那一条：抬眼就在 ──────────────────────────────────────
    api.addStatusItem({
      id: 'turn-resume',
      slot: 'head',
      // 没有断点就一个字不显示 —— 这块字只该在真出事的时候露脸
      text(panelId) {
        const bp = cache.get(panelId);
        return bp ? t('↻ 断点 · {l}', { l: KIND_LABEL[bp.kind] ? KIND_LABEL[bp.kind]() : bp.kind }) : '';
      },
      title(panelId) {
        const bp = cache.get(panelId);
        return bp ? detail(bp) : '';
      },
      /**
       * 点开的下拉 —— 动作借设置分区那条老路（plugin + section）递回来，
       * 不新开一条 IPC（跟 target-dir 那颗「项目 ▾」同一套）。
       */
      menu(panelId) {
        const bp = cache.get(panelId);
        if (!bp) return null;
        return {
          title: t('断点续跑'),
          plugin: 'turn-resume',
          section: 'turn-resume',
          items: [
            { label: t('立刻接着跑'), desc: t('从断点往下做，不从头重来'), action: 'go', row: panelId },
            { label: t('丢掉这个断点'), desc: t('不再自动续，状态条上也不再挂'), action: 'drop', row: panelId },
          ],
        };
      },
    });

    // ── 动作落点：设置里**不单开一页**（顶上那颗菜单走这条路递回来）─────
    api.addSettingsSection({
      id: 'turn-resume',
      label: t('断点续跑'),
      hint: t('上游断了 / 正文被截断 / 进程崩在半路 —— 认得出断点，也接得回去'),
      // 入口是会话顶上那颗「↻ 断点」，再往设置里摆一页等于把同一件事分成两个地方
      hidden: true,
      view: () => ({ rows: [] }),
      onAction: (actionId, rowId) => {
        const act = String(actionId || '');
        const pid = String(rowId || '');
        const bp = cache.get(pid);
        if (!bp) return t('这块面板现在没有断点。');
        if (act === 'drop') {
          done[keyOf(bp)] = Date.now();
          tries[pid] = { n: conf.maxTries, at: Date.now() };
          save();
          cache.delete(pid);
          stamp = '';
          api.refresh();
          return t('丢掉了「{t}」上那个断点，不再自动续。', { t: bp.title });
        }
        if (act === 'go') {
          return revive(pid).then(
            (r) => (r.ok ? t('已经从断点接着跑了（{t}）。', { t: bp.title }) : t('没续上：{e}', { e: r.error })),
            (e) => t('没续上：{e}', { e: String((e && e.message) || e) }),
          );
        }
        return '';
      },
    });

    // ── 助手够得着的那只手 ─────────────────────────────────────────────
    api.addTool(
      {
        name: 'resume_turn',
        level: 'write',
        kits: ['dev', 'exec'],
        description:
          t('看 / 续 / 丢弃「断点」—— 上一轮被上游断掉、正文被输出长度截断、或进程崩在半路留下的未完工作。')
          + t('action=list 列出所有断点；go 立刻从断点接着跑（panelId 不填就是当前这块）；drop 丢掉一个断点（不再自动续、也不在状态条上挂）。')
          + t('用户说「接着刚才那个继续」「刚才断在哪儿了」时用它，不要凭记忆重说一遍任务。'),
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'go', 'drop'], description: t('要做什么') },
            panelId: { type: 'string', description: t('哪块面板；不填就是当前这块') },
          },
          required: ['action'],
        },
      },
      async (args, ctx) => {
        const action = String((args && args.action) || 'list');
        const pid = String((args && args.panelId) || (ctx && ctx.panelId) || '');
        const found = scan();
        syncCache(found);
        if (action === 'list') {
          const list = [...found.values()];
          if (!list.length) return t('现在没有断点：手上没有哪一轮是被断在半路的。');
          return [
            t('现在有 {n} 个断点：', { n: list.length }),
            ...list.map((bp) =>
              `- ${bp.title}（${bp.panelId}）：${KIND_LABEL[bp.kind] ? KIND_LABEL[bp.kind]() : bp.kind}`
              + `${bp.step ? t('，断在「{s}」', { s: bp.step }) : ''}`
              + `，${t('{n} 秒前断的', { n: Math.round((Date.now() - bp.at) / 1000) })}`
              + `${done[keyOf(bp)] ? t('（已经续过一次）') : ''}`,
            ),
            t('要接着做就 resume_turn({"action":"go","panelId":"<上面那个 id>"})。'),
          ].join('\n');
        }
        if (!pid) return t('要给出 panelId（哪一块面板的断点）。');
        if (!found.has(pid)) return t('这块面板现在没有断点。');
        if (action === 'drop') {
          const bp = found.get(pid);
          done[keyOf(bp)] = Date.now();
          tries[pid] = { n: conf.maxTries, at: Date.now() };
          save();
          cache.delete(pid);
          stamp = '';
          api.refresh();
          return t('丢掉了「{t}」上那个断点，不再自动续。', { t: bp.title });
        }
        if (action === 'go') {
          if (api.isRunning(pid)) return t('它正在跑 —— 等这一轮跑完再续。');
          const r = await revive(pid);
          return r.ok ? t('已经从断点接着跑了（{t}）。', { t: r.title }) : t('没续上：{e}', { e: r.error });
        }
        return t('action 只能是 list / go / drop。');
      },
    );

    // ── 键盘上最快的那条路 ─────────────────────────────────────────────
    api.addCommand(
      {
        id: '续跑',
        label: t('断点续跑'),
        hint: t('/续跑 —— 看当前这块面板有没有断点；带上「全部」看所有面板'),
      },
      async (argText, ctx) => {
        const found = scan();
        syncCache(found);
        const all = String(argText || '').trim();
        if (all === '全部' || all === 'all') {
          const list = [...found.values()];
          if (!list.length) return t('现在没有断点。');
          return list.map((bp) => `${bp.title}（${bp.panelId}）：${KIND_LABEL[bp.kind] ? KIND_LABEL[bp.kind]() : bp.kind}`).join('\n');
        }
        const pid = (ctx && ctx.panelId) || '';
        const bp = found.get(pid);
        if (!bp) return t('这块面板没有断点 —— 它上一轮是正常收的尾。');
        const r = await revive(pid);
        return r.ok ? t('已经从断点接着跑了。') : t('没续上：{e}', { e: r.error });
      },
    );

    // 开机那一趟先把断点扫出来（进程崩过的那些就藏在流水条里），再进定时
    syncCache(scan());
    timer = setInterval(() => void tick(), TICK);
    if (timer && typeof timer.unref === 'function') timer.unref();
    api.log(t('断点续跑就绪（自动续：事故型 {a}；截断补完：{b}；崩溃续跑：{c}）', {
      a: conf.auto ? t('开') : t('关'),
      b: conf.truncate ? t('开') : t('关'),
      c: conf.crash ? t('开') : t('关'),
    }));
  },

  dispose() {
    if (timer) clearInterval(timer);
    timer = null;
  },
};
