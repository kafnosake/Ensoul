/**
 * delivery-alert —— 交付提醒。
 *
 * ══ 它补的是哪一个洞 ══════════════════════════════════════════════════════
 *
 * dispatch 插件把派单做成**同步嵌套**的：A 调 dispatch，一路 await 到最底下那个员工，
 * 回执再一层层翻上来。好处是文字回执天然带得回来；代价是 A 那块面板**从头到尾挂着
 * working** —— 对方画三分钟的图，发起人就干等三分钟，这期间用户跟它说不了话。
 *
 * 后来 dispatch 里多了一条**派单令牌**（收件箱 .ensoul/state/dispatch.inbox.json）：
 * 交付时按令牌把文件挂回发起人的对话。于是"谁在等"和"东西什么时候好"就解耦了 ——
 * 发起人早跑完了也不要紧，文件照样落进去，**只是没有人叫他一声**。
 *
 * ══ 什么时候叫、什么时候一声不吭 ══════════════════════════════════════════
 *
 * **判据在发起人手里，不在这个插件手里** —— 他派单时那一格 `follow` 是空的还是填了：
 *
 *   · **留空（默认）= 交了就完** —— 交付物（图）已经由 dispatch 挂进他的对话，
 *     那本身就是最硬的"到货"信号：他下一轮读历史就看见了。这儿一个字都不说。
 *     以前这儿会 api.send 一句「令牌 xxx 已完成」，那是把图已经说清的事又说一遍、
 *     还白花一轮模型调用 —— 用户的原话是"不想看到这条"。
 *   · **填了 = 交完接着办** —— 把他叫起来，但走 `silent`（进历史、不上屏）：
 *     用户看不见那句机器触发语，看见的是他接着干出来的东西。
 *
 * 所以这个插件现在只干一件事：盯着收件箱，谁是"声明了要接着办"的单、交回来了、
 * 而发起人那块面板正好闲着，就悄悄把他叫起来。
 *
 * ══ 为什么单独一个插件，不并进 dispatch ══════════════════════════════════
 *
 * 因为它要**花掉一轮模型调用**（叫醒一个人 = 让他跑一轮）。那是一种打扰，
 * 用户应该能单独关掉：关掉之后令牌机制原样好使，只是不再自动叫人。
 * 一个插件做一件事，关得掉才是它的价值。
 *
 * ══ 它只读、不抢 ══════════════════════════════════════════════════════════
 *
 * 收件箱归 dispatch 写，这个插件**只读**它、一个字节都不往回写；
 * 它自己那份"叫过了"的账记在自己状态里（.ensoul/state/delivery-alert.json）。
 * 两边各写各的文件，谁都不覆盖谁 —— 同一个文件两个插件抢着写，迟早丢一条。
 * 「叫过了」按**令牌**记（令牌全局唯一）：既不会重复叫，也不会把别人的算成自己的。
 */

const fs = require('fs');
const path = require('path');

/** dispatch 的收件箱：只读。格式由那边定，认不动就整条跳过，别让别人的脏数据带崩这里 */
const INBOX_FILE = '.ensoul/state/dispatch.inbox.json';
/** 核心每一轮落的那张流水条：只读。开机扫出 crashed，就是「上次崩在半路」 */
const JOURNAL_FILE = '.ensoul/state/turn-journal.json';
/**
 * 派单令牌多久算「没送出去」—— 正常是毫秒级。
 *
 * **必须长过 dispatch 的 ORPHAN_GRACE（90 秒）**：那段窗口里 dispatch 自己就会把
 * 没送出去的令牌收掉（变成 cancelled 就不再进这里）。抢在它前面报出来，报到发起人
 * 那儿就只剩一个动作——重派；而重派又撞同一个忙、又开一张新令牌，孤儿越滚越多。
 * 2026-10-04 那晚连着四条重单就是这么滚出来的。
 */
const HOLDER_GRACE = 120 * 1000;
/** 24h 的 TTL 到点前先喊两嗓子（dispatch 里那个 WAIT_TTL） */
const TTL_WARN = 12 * 3600 * 1000;
/** 允许自动重叫的失败类别 —— 请求本身不合法的那些叫了也白叫，只会烧钱 */
const RECOVERABLE = { TIMEOUT: 1, TRANSPORT: 1, EMPTY_RESPONSE: 1 };
/** 同一令牌同一类异常最多叫几次、退避多久 */
const MAX_TRY = 2;
const BACKOFF = [60 * 1000, 120 * 1000];
/** 多久看一眼。界面那一跳是 1.5 秒，这个不必更密 —— 反正要等对方先跑完 */
const TICK = 2000;
/** "叫过了"最多记多少个令牌 */
const SEEN_MAX = 200;

let timer = null;

/** 收件箱里所有像样的条目（形状不对的整条丢） */
function readTickets(api) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(api.workspace || '.', INBOX_FILE), 'utf8'));
    const list = Array.isArray(j) ? j : Array.isArray(j && j.entries) ? j.entries : [];
    return list.filter((tk) => tk && typeof tk === 'object' && tk.token);
  } catch {
    return [];
  }
}

/**
 * 交付了、有文件、能落回某块面板的 —— 只有这些才有"要不要叫他"这个问题。
 *
 * `receiptAt` 是 dispatch 打的标记：交付时发起人正好在等回执、路径已经写进他的回执了，
 * 这种不必再叫一趟。**例外是他声明了 `follow`**（交完接着办）—— 那件事跟回执无关，
 * 路径给没给他都得办，所以照叫。
 */
function delivered(api) {
  return readTickets(api).filter(
    (tk) =>
      tk.status === 'done' &&
      tk.fromPanel &&
      Array.isArray(tk.files) &&
      tk.files.length &&
      (!tk.receiptAt || tk.follow),
  );
}

/** 流水条里还挂着 running 的（= 上次进程死在这一步上），以及被开机扫成 crashed 的 */
function journalAnomalies(api) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(api.workspace || '.', JOURNAL_FILE), 'utf8'));
    const list = Array.isArray(j && j.turns) ? j.turns : [];
    return list.filter((x) => x && (x.status === 'crashed' || x.status === 'running'));
  } catch {
    return [];
  }
}

/** 这块工作面派出去、还没交付的（挂到状态条上给人看） */
function waiting(api, panelId) {
  if (!panelId) return [];
  // 只认 pending：撤单的（cancelled）已经不算欠着了，别挂在状态条上催人
  return readTickets(api).filter((tk) => tk.status === 'pending' && tk.fromPanel === panelId);
}

/**
 * 叫醒发起人的那一段 —— **只在 follow 有值时用**，而且走 silent（进历史、不上屏）。
 *
 * 说人话、不说机制：东西就挂在他上面那条对话里，"文件按令牌去查 —— 敲 /inbox"是写给
 * 机器看的，东西已经在眼前的时候纯属让人破译。真正非说不可的只有一件：
 * **他派单时说的那件后续**，原话还给他，他接着办。
 */
/**
 * 叫醒发起人的那一段 —— **只在 follow 有值时用**，而且走 silent（进历史、不上屏）。
 *
 * 说人话、不说机制：东西就挂在他上面那条对话里，"文件按令牌去查 —— 敲 /inbox"是写给
 * 机器看的，东西已经在眼前的时候纯属让人破译。真正非说不可的只有一件：
 * **他派单时说的那件后续**，原话还给他，他接着办。
 *
 * ⚠ 票据参数**不许叫 t** —— t 是插件里的翻译函数（全局注入，见 lang.ts 的
 * installForPlugins）。票据叫 t 就会把翻译函数遮住，`t(...)` 变成"调用一个对象"，
 * 运行时当场抛错、整条状态项被吞掉。这里一律叫 tk。
 */
/**
 * 判「这条派单是不是断了」—— 只读事实，不问任何模型回忆。
 *
 * 返回 [{ tk, kind, text, to }]：kind 是异常类别（同时也是「叫过没有」的键），
 * to 是**该管这件事的人**（发起人 / 承办人），text 是给模型看的那一段。
 */
/** 某个面板最近一步走到哪儿了（从流水条里取）—— 接手的人要知道「卡在哪儿」 */
function lastStepOf(api, panelId) {
  const rows = journalAnomalies(api).filter((x) => x.panelId === panelId);
  // 先挑崩掉的那条 —— 同一个面板可能还有更早的正常轮，取错了就成了「卡在别的步骤上」
  const last = rows.filter((x) => x.status === 'crashed').pop() || rows[rows.length - 1];
  return (last && last.step) || '';
}

/** 这块面板最近那条助手消息是怎么收场的 —— endReason / failCode 就记在那儿 */
function lastEnd(panel) {
  const chat = Array.isArray(panel && panel.chat) ? panel.chat : [];
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    const m = chat[i];
    if (m && m.role === 'assistant' && m.endReason) return m;
  }
  return null;
}

function broken(api, tickets, panels) {
  const now = Date.now();
  const out = [];
  for (const tk of tickets) {
    if (!tk || tk.status !== 'pending') continue;
    const age = now - Number(tk.at || 0);
    const holderPanel = tk.holder ? panels.get(tk.holder) : null;
    const holderAlive = Boolean(holderPanel);
    const step = tk.holder ? lastStepOf(api, tk.holder) : '';
    const where = step ? t('（卡在：{s}）', { s: String(step).slice(0, 60) }) : '';
    const base = t('令牌 {tk}：{task}', { tk: tk.token, task: String(tk.task || '').slice(0, 140) });

    // ① 令牌没送出去：没有主人，永远不会有人去交
    if (!tk.holder && age > HOLDER_GRACE) {
      out.push({ tk, kind: 'noholder', to: tk.fromPanel,
        text: t('【派单异常】这张单**没有承办人** —— 送出去之前就断了，dispatch 那边应当已经把它回收。\n') + base
          + t('\n它不在任何人手上，不会有人去交（/cancel {tk} 可以手动收掉它）。', { tk: tk.token })
          + t('\n**先别急着重派**：确认目标那块工作面已经跑完这一轮再派 —— 它还忙着重派只会再断一次。') });
      continue;
    }
    // ② 承办人那块面板没了：认号认不到人
    if (tk.holder && !holderAlive) {
      out.push({ tk, kind: 'noholder2', to: tk.fromPanel,
        text: t('【派单异常】承办人「{who}」那块工作面已经不在线了。\n', { who: tk.holderName || tk.holder }) + base
          + t('\n这单还挂着，但没人接得住。请 /cancel 后重新派一次。') });
      continue;
    }
    // ③ 逼近 24h TTL —— 到点之后 dispatch 两边一起过滤，谁都看不见它了
    if (age > TTL_WARN && holderAlive) {
      out.push({ tk, kind: 'ttl', to: tk.holder,
        text: t('【派单提醒】这单挂着快一天了。\n') + base
          + t('\n你手上还拿着它{where}。做得了就交，做不了就 /cancel 或转派 —— 到点之后两边都看不见它了。', { where }) });
      continue;
    }
    // ④ 承接那一轮是上游断掉的：令牌还在他手上，人却已经停了
    const end = holderAlive ? lastEnd(holderPanel) : null;
    if (end && end.endReason === 'failed') {
      const ok = RECOVERABLE[String(end.failCode || '')];
      if (ok) {
        out.push({ tk, kind: 'upstream', to: tk.holder,
          text: t('【派单异常】你上一轮被上游断掉了（{why}）。\n', { why: end.failCode || '接口断了' }) + base
            + t('\n这单还在你手上{where}。接着做完就交 deliver_result；做不了就直接说一声。', { where }) });
      }
      continue;
    }
  }
  return out;
}

function wakeText(tk) {
  const who = tk.by || tk.holderName || t('对方');
  const names = (tk.files || []).map((f) => path.basename(f)).slice(-4).join('、');
  return [
    t('「{who}」交活了{a}，东西已经挂在上面那条对话里。', { who, a: names ? t('：{n}', { n: names }) : '' }),
    t('你派这一单时说了，交回来之后要接着办：**{f}**', { f: tk.follow }),
    t('现在就去办它 —— 图从上面那条消息里取。办完直接说结果，不用再提令牌、也不用复述这一条。'),
  ].join('\n');
}

module.exports = {
  name: 'delivery-alert',
  description: t('交付提醒：只叫「派单时声明了交完要接着办」的单，且静默叫（不往对话里多塞一句话）'),

  setup(api) {
    const old = api.state.load({ seen: {} });
    let seen = old && old.seen && typeof old.seen === 'object' ? { ...old.seen } : {};

    function save() {
      // 只留最近的一批 —— 不然这个文件会一直长
      const stamp = (v) => (v && typeof v === "object" ? Number(v.at || 0) : Number(v || 0));
      const keys = Object.keys(seen)
        .sort((a, b) => stamp(seen[b]) - stamp(seen[a]))
        .slice(0, SEEN_MAX);
      const next = {};
      for (const k of keys) next[k] = seen[k];
      seen = next;
      api.state.save({ at: Date.now(), seen });
    }

    let busy = false;
    async function tick() {
      if (busy) return;
      busy = true;
      try {
        // ── 第二件事：链路断了没人知道 ────────────────────────────────
        const panels = new Map((api.panels() || []).map((p) => [p.id, p]));
        const tickets = readTickets(api);
        const events = broken(api, tickets, panels);

        // ⑤ 进程整个死在半路：流水条挂着 crashed，而这块面板手上正拿着令牌
        for (const row of journalAnomalies(api)) {
          if (row.status !== 'crashed') continue;
          const held = tickets.find((x) => x.status === 'pending' && x.holder === row.panelId);
          if (!held) continue;
          events.push({
            tk: held,
            kind: 'crashed',
            to: row.panelId,
            text: t('【派单异常】你上一轮**没走完就断了**（进程断在半路），这单还在你手上。\n')
              + t('令牌 {tk}：{task}\n', { tk: held.token, task: String(held.task || '').slice(0, 140) })
              + t('接着做完就交 deliver_result；做不了就直接说一声。'),
          });
        }

        for (const ev of events) {
          const key = ev.tk.token + ':' + ev.kind;
          const rec = seen[key];
          const tries = rec && typeof rec === 'object' ? Number(rec.n || 0) : rec ? 1 : 0;
          // 叫够了就只留在状态条上 —— 越限还自动叫，等于烧钱循环
          if (tries >= MAX_TRY) continue;
          if (tries > 0) {
            const last = rec && typeof rec === 'object' ? Number(rec.at || 0) : Number(rec || 0);
            if (Date.now() - last < (BACKOFF[tries - 1] || BACKOFF[BACKOFF.length - 1])) continue;
          }
          const home = (api.panels() || []).find((p) => p.id === ev.to);
          if (!home) continue; // 该管的人也不在线，报给谁都没用
          seen[key] = { n: tries + 1, at: Date.now() };
          save();
          // steer：面板在跑就插进去、没在跑才起一轮 —— 分流归核心，不再自己判断 status
          await api.send(home.id, ev.text, undefined, { silent: true, steer: true });
        }

        for (const tk of delivered(api)) {
          if (seen[tk.token]) continue; // 叫过了
          const home = (api.panels() || []).find((p) => p.id === tk.fromPanel);
          // 发起人那块工作面已经关了：别再念叨（文件本来就在工作区里，路径也记在收件箱）
          if (!home) {
            seen[tk.token] = Date.now();
            save();
            continue;
          }
          // 他正跑着 —— 文件这会儿已经挂进他那一轮了（核心的 live.image 就是这么做的），
          // 再往里塞一轮就是叠第二轮；等他跑完下一跳再说
          /**
           * **没声明"交完接着办"的单，到这儿就静默收场。**
           *
           * 交付物（图）已经由 dispatch 挂进发起人的对话了 —— 那就是最硬的"到货"信号，
           * 他下一轮读历史就看见了。再 api.send 一句「令牌 xxx 已完成」，等于把图已经说清
           * 的事又说一遍，还白花一轮模型调用。用户的原话：不想看到这条。
           */
          if (!tk.follow) {
            seen[tk.token] = Date.now();
            save();
            continue;
          }
          if (home.status === 'working') continue;
          seen[tk.token] = Date.now();
          save();
          // silent：**进历史、不上屏** —— 模型得知道这一轮为什么跑，用户不该看见这句机器话
          await api.send(home.id, wakeText(tk), undefined, { silent: true });
        }
      } catch (e) {
        // 叫不醒不该变成一个反复重试的噪音：这一条已经记成"叫过了"，只留一行日志
        api.log(`[delivery-alert] ${String((e && e.message) || e)}`);
      } finally {
        busy = false;
      }
    }

    timer = setInterval(() => void tick(), TICK);
    if (timer && typeof timer.unref === 'function') timer.unref();

    // 输入框那一排：这块工作面还有几件派出去的活没交回来
    api.addStatusItem({
      id: 'delivery-alert',
      text(panelId) {
        const n = waiting(api, panelId).length;
        if (!n) return '';
        const panels = new Map((api.panels() || []).map((p) => [p.id, p]));
        const bad = broken(api, readTickets(api), panels).filter((e) => e.to === panelId).length;
        // 有断了的就数出来 —— 只报「待交付」会让人以为事情还在正常推进
        return bad ? t('待交付 {n}（{b} 张异常）', { n, b: bad }) : t('待交付 {n}', { n });
      },
      title(panelId) {
        const rows = waiting(api, panelId).map(
          (tk) => t('· {tk} → {who}：{task}', { tk: tk.token, who: tk.holderName || t('在办'), task: String(tk.task || '').slice(0, 40) }),
        );
        return rows.length ? t('派出去还没交付的活：\n') + rows.join('\n') : '';
      },
    });

    api.log(`交付提醒就绪（盯 ${INBOX_FILE}）`);
  },

  dispose() {
    if (timer) clearInterval(timer);
    timer = null;
  },
};
