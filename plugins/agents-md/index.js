/**
 * 工作区根下的 AGENTS.md / CLAUDE.md，每轮自动读给模型，**内容变了才重发**。
 *
 * 工作区规范说明注入。要解决的事：项目的规矩（用哪个包管理器、
 * 目录怎么摆、哪些文件别碰）现在只能靠用户每次手打一遍，或者模型自己瞎猜。
 * 落到根目录一个文件是最省事的做法 —— 它跟仓库一起走，改一次全体生效。
 *
 * 三条核心纪律，缺一条这个插件就会变成负资产：
 *
 * 1. **不放系统提示。** 走 `api.addPrompt`，正文拼在本轮用户消息的末尾 —— 系统提示
 *    是最前面那条消息，往里塞每轮都会变的东西，等于每轮按全价重算整个对话。
 * 2. **没变就不重发。** 按面板记账（mtime+size 指纹），同一个面板上一轮发过的版本
 *    原样不动就返回空串。每一轮都重发一份一模一样的 5KB 说明，是纯烧钱。
 * 3. **首轮必发。** 新面板没有记账，天然会发 —— 第一次运行就能看见这份说明。
 *
 * 记账是**内存里的、按面板分的**：换个面板等于换了一段上下文，那边没发过就得再发一次。
 * 故意不落盘：重启之后该重发一遍，留一张跨重启的旧通行证只会让文件改了却没人知道。
 *
 * 已知的边界：面板的对话被压缩之后，早先那份说明可能被压掉，而这个插件不会重发
 * （指纹没变）。真被压掉时模型手上还有 read_file，读一眼就是了 —— 为这个把指纹
 * 改成"每轮都发"不划算。
 */

const fs = require('fs');
const path = require('path');

/** 认这两个名字。两个都在就都发 —— 别的工具（Cursor 等）认 CLAUDE.md，顺手兼容 */
const NAMES = ['AGENTS.md', 'CLAUDE.md'];

/** 单份上限。超过就只发开头，并告诉模型哪里能读全 —— 保护的是每一轮的预算 */
const MAX_BYTES = 64 * 1024;

module.exports = {
  name: 'agents-md',
  description: t('自动读工作区根下的 AGENTS.md / CLAUDE.md，内容变了才重发给模型'),

  setup(api) {
    const root = api.workspace;
    const at = (name) => path.join(root, name);

    /** panelId -> 上一轮发出去的那一版指纹（形如 `AGENTS.md:1732..:5231`） */
    const sent = new Map();

    /** 这一份此刻是什么版本：没有返回 ''，有返回能代表"这一版"的指纹 */
    const stampOf = (file) => {
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) return '';
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return ''; // 不存在、读不到、是个目录，都当"没有这一份"
      }
    };

    const fingerprint = () =>
      NAMES.map((n) => [n, stampOf(at(n))])
        .filter(([, s]) => s)
        .map(([n, s]) => `${n}:${s}`)
        .join('|');

    /** 真去读一遍。只在指纹变了的时候调 */
    const render = () => {
      const chunks = [];
      for (const name of NAMES) {
        const file = at(name);
        if (!stampOf(file)) continue;
        let body;
        try {
          body = fs.readFileSync(file, 'utf8');
        } catch (e) {
          api.log(`${name} 读不了：${e.message}`);
          continue;
        }
        let tail = '';
        if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) {
          body = body.slice(0, MAX_BYTES);
          tail = `（这份文件只截了前 ${MAX_BYTES / 1024}KB，要看全的用 read_file 读 ${name}）`;
        }
        body = body.trim();
        if (!body) continue;
        chunks.push([`--- ${name} ---`, body, tail].filter(Boolean).join('\n'));
      }
      return chunks;
    };

    api.addPrompt((ctx) => {
      const key = (ctx && ctx.panelId) || '';

      // 挂了 noWorkspacePrompt 的面板（员工工作面）不收全局说明：
      // 他只叠「通用提示词 + 角色卡上那份专属提示词」。不记账，标摘了下一轮照发
      const me = key ? api.panels().find((p) => p.id === key) : null;
      if (me && me.noWorkspacePrompt) return '';

      // 面板删了，它的记账也跟着走。只在开新面板时才真扫一遍，成本可以忽略
      const live = new Set(api.panels().map((p) => p.id));
      for (const k of [...sent.keys()]) if (k !== key && !live.has(k)) sent.delete(k);

      const fp = fingerprint();
      if (!fp) {
        sent.delete(key); // 文件被删了：下回再建出来要能重发
        return '';
      }
      if (sent.get(key) === fp) return ''; // 还是那一版，一个字都不必花

      const chunks = render();
      if (!chunks.length) return '';
      sent.set(key, fp);

      return [
        t('【工作区说明】工作区根下的说明文件（项目自己的规矩；这一版跟上一版不同才会出现）'),
        ...chunks,
        t('照它办。它跟你手上的通用做法冲突时以它为准；它没说到的地方照旧。'),
      ].join('\n\n');
    });

    api.log(`工作区说明就绪（认 ${NAMES.join(' / ')}，在 ${root}，内容变了才重发）`);
  },
};
