/**
 * moss-prompt —— 只在「用 MOSS 出图」的那些轮，自动把官方提示词强化规程摆到模型面前。
 *
 * 为什么不是一份普通技能：
 *   技能清单是**每轮都进系统提示**的（名字 + 一句话）。而这份规程有 6KB，只在
 *   真要拿 MOSS 出图时才有用 —— 平时挂着它就是每轮白付一次上下文。
 *   更要紧的是用户的要求是「有且只有在用 moss 的时候」：那就得有人**判断语境**，
 *   技能机制没有这个能力，插件有（addPrompt 每轮拿得到 ctx.panelId，
 *   顺着 api.panels() 就能看见这块面板最近在干什么）。
 *
 * 判据（任一成立即算「在用 MOSS」）：
 *   ① 面板最近若干条消息里出现过 moss 字样（用户点名 / 上一轮的工具参数带过）；
 *   ② 出现过 moss 工作流名（moss-image-t2i / moss-image-img2img 之类）。
 * 两条都只读会话，不猜、不看时钟 —— 于是同一段语境里注入的是**同一份文本**，
 * syncContext 只在「进 moss 场景 / 退出」那一下付一次钱，中间每轮都命中缓存。
 *
 * 注入的是技能正文（assets/SKILL.md，与上游 OpenMOSS/MOSS-Image 的
 * skills/moss-image-prompt-enhancer 逐字节一致），外加编译脚本的位置与用法。
 * 附带一个 moss_prompt 工具，省得模型自己拼 python 命令。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** 回看几条消息的默认值。够覆盖「上一轮出的图 + 这一轮接着改」这一段 */
const LOOKBACK = 8;

/** 命中这个词就算在谈 MOSS。\b 让 mossy / moscow 之类不误判 */
const MOSS_RE = /\bmoss\b/i;

/** 草稿 > 这个尺寸就不往提示里塞了，只回一句「太大了，看文件」 */
const MAX_DRAFT = 64 * 1024;

const PARAMS = {
  enabled: {
    label: t('用 MOSS 出图时自动加载规程'),
    type: 'bool',
    default: true,
    hint: t('关掉就完全不注入 —— 那份 6KB 规程一次都不会出现'),
  },
  lookback: {
    label: t('回看最近几条消息判场景'),
    type: 'number',
    default: 8,
    min: 2,
    max: 60,
    hint: t('在最近这么多条里找到「moss」就算本轮在用它；调大 = 出图后接着聊别的也还挂着规程'),
  },
};

module.exports = {
  params: PARAMS,
  name: 'moss-prompt',
  description: t('用 MOSS-Image 出图时自动加载官方提示词强化规程（Caption / Layout 两种产出 + 坐标编译），平时一声不吭'),

  setup(api) {
    const assets = () => path.join(__dirname, 'assets');

    /** setup 时读一次：这份正文不会中途变，缺了就当场说清楚 */
    let spec = '';
    try {
      const raw = fs.readFileSync(path.join(assets(), 'SKILL.md'), 'utf8');
      // 去掉 frontmatter：那三行是给人看的索引，摆在对话里只是噪音
      spec = raw.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '').trim();
    } catch (e) {
      api.log(`[moss-prompt] 读不到 assets/SKILL.md：${e.message}`);
    }

    /** 参数一改插件会重新 setup，所以这儿读一次就够；越界的数回落到默认 */
    const lookback = (() => {
      const n = Math.round(Number(api.param('lookback')));
      return Number.isFinite(n) && n >= 2 && n <= 60 ? n : LOOKBACK;
    })();

    /**
     * 这块面板最近在聊什么 —— 只拼文本，不解析语义。
     *
     * 两条纪律，都是为了「有且只有」：
     *   ① 跳过 silent 消息。那是机器替用户说的话（面板上下文、别的插件的补充说明），
     *      而本插件**自己注入的那段规程里就有 MOSS 四个字母** —— 把它算成证据，
     *      命中一次之后这段规程会一直被自己续命。
     *   ② 工具痕迹只认 comfyui_run 带 moss 工作流名那一种。moss_prompt 是本插件的手脚，
     *      拿它当证据同样是自证循环；而 comfyui_run + moss-image-* 是"真的在拿它出图"，
     *      最硬的那条。
     */
    const recentText = (panel) => {
      const chat = Array.isArray(panel && panel.chat) ? panel.chat : [];
      const bits = [];
      for (const m of chat.slice(-lookback)) {
        if (!m || m.silent) continue;
        // 只有**用户自己说的**才算数：我自己在回复里复述一句「moss」不算在用，
        // 否则一次测评报告就能让规程挂满后面 8 轮。
        if (m.role === 'user' && typeof m.content === 'string' && m.content) bits.push(m.content);
        for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
          if (String((c && c.name) || '') === 'comfyui_run' && MOSS_RE.test(String((c && c.args) || ''))) {
            bits.push('comfyui_run ' + String(c && c.args));
          }
        }
        for (const a of Array.isArray(m.actions) ? m.actions : []) {
          const s = String(a || '');
          if (s.includes('comfyui_run') && MOSS_RE.test(s)) bits.push(s);
        }
      }
      return bits.join('\n');
    };

    /**
     * 更严的一条：**最后一条证据说了算**。
     *
     * 只看「窗口里出现过 moss」是不够的 —— 用户先让我用 moss 画一张，随后说「换 krea2 再来一张」，
     * 窗口里那条 moss 还在，规程却该撤了。所以按时间顺一遍：中途真的用别的模型出过图，
     * 就当场判成「不在 MOSS 场景」；之后用户再点 moss，又翻回来。
     */
    const lastSignal = (panel) => {
      const chat = Array.isArray(panel && panel.chat) ? panel.chat : [];
      let sig = '';
      for (const m of chat.slice(-lookback)) {
        if (!m || m.silent) continue;
        if (m.role === 'user' && typeof m.content === 'string' && MOSS_RE.test(m.content)) sig = 'moss';
        for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
          if (String((c && c.name) || '') !== 'comfyui_run') continue;
          sig = MOSS_RE.test(String((c && c.args) || '')) ? 'moss' : 'other';
        }
      }
      return sig;
    };

    const inMossScene = (ctx) => {
      const pid = (ctx && ctx.panelId) || '';
      if (!pid) return false;
      const panel = api.panels().find((p) => p.id === pid);
      if (!recentText(panel)) return false;
      return lastSignal(panel) === 'moss';
    };

    /**
     * 每轮问一次：这轮算不算 MOSS 场景。
     * 返回的是一段**固定文本** —— 只要还在同一个场景里，逐字不变。
     */
    api.addPrompt((ctx) => {
      if (!spec) return '';
      if (api.param('enabled') === false) return '';
      if (lookback < 2) return '';
      if (!inMossScene(ctx)) return '';
      return [
        t('【MOSS-Image 提示词强化规程】（这一段只在 MOSS 出图的轮次出现；下面是要点，不是建议）'),
        spec,
        '',
        t('── 本机的落地方式 ──'),
        t('· 草稿写 JSON（caption 模式 {\"caption\":\"...\"}；Layout 模式见下），存到工作区里；'),
        t('· 编译：调 moss_prompt(draft=\"<草稿文件路径或 JSON 文本>\")，它替你跑官方脚本；'),
        t('· 画布宽高必须是 16 的倍数；Layout 草稿用绝对像素 [x_min,y_min,x_max,y_max]，脚本会换算成模型要的居中 yxyx；'),
        t('· 编译结果就是 MOSS 的正向提示词，直接交给 comfyui_run 的 prompt；出图用的宽高要和草稿里声明的一致。'),
        t('· Layout 规范全文在 ' + path.join(assets(), 'references', 'layout.md') + '（要写复杂海报时才读）。'),
      ].join('\n');
    });

    /**
     * 编译草稿 → 提示词。跟官方脚本同一份实现（assets/scripts/compile_prompt.py），
     * 这里只是把「找 python / 传沙盒 / 收输出」这几步封起来。
     */
    api.addTool(
      {
        name: 'moss_prompt',
        description: t(
          '把一份 MOSS-Image 提示词草稿（caption 或 Layout 的 JSON）编译成可以直接交给 comfyui_run 的一句提示词。' +
            'draft 可以是工作区里的草稿文件路径，也可以直接是 JSON 文本。',
        ),
        parameters: {
          type: 'object',
          properties: {
            draft: { type: 'string', description: t('草稿文件路径（相对工作区或绝对路径），或者直接给 JSON 文本') },
          },
          required: ['draft'],
        },
      },
      async (args) => {
        const raw = String((args && args.draft) || '').trim();
        if (!raw) return t('没给草稿。传一个 .json 文件路径，或者直接给 JSON 文本。');

        // 是 JSON 就原样喂，是路径就先读出来 —— 脚本两种都认，但路径要能解析
        let text = raw;
        let fromFile = '';
        if (!raw.startsWith('{')) {
          const full = path.isAbsolute(raw) ? raw : path.join(api.workspace, raw);
          try {
            text = fs.readFileSync(full, 'utf8');
            fromFile = full;
          } catch (e) {
            return t(`草稿读不出来：${full}（${e.message}）`);
          }
        }
        if (text.length > MAX_DRAFT) {
          return t(`草稿太大了（${text.length} 字），这份工具只处理普通尺寸的草稿。`);
        }

        const script = path.join(assets(), 'scripts', 'compile_prompt.py');
        if (!fs.existsSync(script)) return t(`编译脚本不见了：${script}`);

        // 草稿落在插件自己的数据目录里，不往工作区里丢临时文件
        const tmp = path.join(api.dataPath('.ensoul/state/moss-prompt'), `draft-${Date.now()}.json`);
        try {
          fs.mkdirSync(path.dirname(tmp), { recursive: true });
          fs.writeFileSync(tmp, text, 'utf8');
        } catch (e) {
          return t(`草稿临时文件写不了：${e.message}`);
        }

        // 两个解释器都试：有的机器只有 python，有的只有 python3
        let out = null;
        let lastErr = '';
        for (const exe of ['python3', 'python']) {
          const r = spawnSync(exe, [script, tmp], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
          if (r.error) {
            lastErr = r.error.message;
            continue;
          }
          if (r.status === 0) {
            out = String(r.stdout || '').trim();
            break;
          }
          lastErr = String(r.stderr || r.stdout || '').trim() || `退出码 ${r.status}`;
        }
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* 收不掉不算错 */
        }

        if (!out) return t(`编译失败：${lastErr || '没有输出'}`);
        return [
          fromFile ? t(`草稿：${path.relative(api.workspace, fromFile)}`) : t('草稿：直接给的 JSON'),
          t('编译结果（整段就是 MOSS 的正向提示词）：'),
          out,
        ].join('\n');
      },
    );

    api.log(`[moss-prompt] 就绪：${spec ? '规程 ' + spec.length + ' 字' : '规程缺失'}，命中判据 moss × 最近 ${lookback} 条`);
  },
};
