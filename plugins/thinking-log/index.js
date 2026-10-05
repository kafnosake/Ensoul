/**
 * 思考落盘 —— 把模型的**思考链**原样写进工作区。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 *
 * 在这之前，思考是"过眼就散"的：chat-core 收到那一刻 delta 就交给界面显示，
 * 正文一开始流就撤下，这一轮跑完整段就没了 —— 正文进了历史、工具调用进了存档，
 * 唯独思考在盘上**一个字都没有**。于是想回头查"它当时到底怎么想的"，
 * 唯一的办法是让它重推一遍，而重推拿到的是另一次思考，不是那一次。
 *
 * 现在的通道：核心开了一个 `onReasoning` 钩子（只读、不拦不改），
 * 这个插件挂上去接一份。核心不知道有落盘这回事，插件也不用认识对话框。
 *
 * ── 落成什么 ──────────────────────────────────────────────────────────
 *
 *   <工作区>/.ensoul/state/thinking/<YYYY-MM-DD>.jsonl
 *
 * 一行一段思考：`{ at, panel, text }`（时间、哪块面板、原样的思考全文）。
 * 为什么是 JSONL 而不是一个 JSON：思考又长又碎，一整份读出来才写回去太亏，
 * 而追加一行具备原子性，异常中断也仅丢失尾行，具备极高的持久化鲁棒性。
 *
 * 为什么按天分文件：这是**翻**的东西，不是**算**的东西。按天切，一天一份，
 * 单份不会长到打不开，过期整份删掉也不心疼（keep_days）。
 *
 * ── 一段的边界在哪 ────────────────────────────────────────────────────
 *
 * 核心传的是 delta，不带"这段想完了"的标记（一轮里模型要想好几回：写一段正文、
 * 又想一段）。所以这里用**空闲**判段：多久没有新字就算这段想完了，落一行。
 * 攒到一定字数也先落一批 —— 进程要是这会儿被重启，丢的是这一小段，不是整轮。
 */

const fs = require('fs');
const path = require('path');

/**
 * 可调参数（设置面板里能改，助手也能改 —— 见 plugins/plugin-kit）。
 * 两个都是"按项目定"的事：攻坚项目想留久一点，跑一跑就丢的活不必。
 */
const PARAMS = {
  keep_days: { label: t('思考日志留多少天'), type: 'number', default: 30, min: 1, max: 3650, hint: t('过期按天整份删掉') },
  idle_ms: { label: t('多久没新字算想完一段'), type: 'number', default: 2000, min: 300, max: 60000, hint: t('落下的一行就是一段') },
};

/** 一段最多先攒多少字就落一批 —— 长思考不该整段押在内存里等它想完 */
const FLUSH_CHARS = 8000;

module.exports = {
  params: PARAMS,
  name: 'thinking-log',
  description: t('把模型的思考链原样落盘到 .ensoul/state/thinking/<日期>.jsonl（一行一段：at / panel / text）'),

  setup(api) {
    const root = api.workspace || '';
    if (!root) {
      // 还没选工作区：不能把相对路径当真的用 —— 那会写进进程的 cwd。
      api.log(t('没有工作区，思考先不落盘'));
      return;
    }

    const box = path.join(root, '.ensoul', 'state', 'thinking');
    const keepDays = Math.max(1, Math.round(Number(api.param('keep_days')) || 30));
    const idleMs = Math.max(300, Math.round(Number(api.param('idle_ms')) || 2000));

    /** 本地日期（人翻日志按的是本地的那一天，不是 UTC 的） */
    const dayName = (t) => {
      const d = new Date(t);
      const p2 = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    };

    /** panelId -> { text, timer }：此刻正在想、还没落盘的那一段 */
    const live = new Map();

    const write = (panelId, text, at) => {
      try {
        fs.mkdirSync(box, { recursive: true });
        fs.appendFileSync(path.join(box, `${dayName(at)}.jsonl`), `${JSON.stringify({ at, panel: panelId, text })}\n`, 'utf8');
      } catch (e) {
        api.log(t('落盘失败：'), e && e.message); // 记录失败不能反过来影响对话
      }
    };

    const flush = (panelId) => {
      const s = live.get(panelId);
      if (!s) return;
      if (s.timer) {
        clearTimeout(s.timer);
        s.timer = null;
      }
      const text = s.text.trim();
      s.text = '';
      if (text) write(panelId, text, Date.now());
    };

    api.onReasoning((panelId, delta) => {
      const id = String(panelId || '');
      const d = String(delta || '');
      if (!id || !d) return;

      let s = live.get(id);
      if (!s) {
        s = { text: '', timer: null };
        live.set(id, s);
      }
      s.text += d;

      if (s.timer) clearTimeout(s.timer);
      if (s.text.length >= FLUSH_CHARS) flush(id); // flush 里已经把 timer 收掉了
      s.timer = setTimeout(() => flush(id), idleMs);
    });

    // 过期清理：插件每次启动扫一次就够（它不是每天都会长出新的一天，
    // 而"多久没清"这件事不值得多养一个定时器）
    const cut = dayName(Date.now() - keepDays * 86400000);
    try {
      for (const f of fs.readdirSync(box)) {
        if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
        if (f.slice(0, 10) < cut) fs.unlinkSync(path.join(box, f));
      }
    } catch {
      /* 目录还不存在，正常 */
    }

    api.log(`思考落盘就绪：${path.relative(root, box) || box}（留 ${keepDays} 天，空闲 ${idleMs}ms 落一段）`);
  },
};
