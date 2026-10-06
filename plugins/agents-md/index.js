/** 工作区规则每轮注入当前版本；addPrompt 的内容不进入历史回放。 */

const fs = require('fs');
const path = require('path');

/** 认这两个名字。两个都在就都发 —— 别的工具（Cursor 等）认 CLAUDE.md，顺手兼容 */
const NAMES = ['AGENTS.md', 'CLAUDE.md'];

/** 单份上限。超过就只发开头，并告诉模型哪里能读全 —— 保护的是每一轮的预算 */
const MAX_BYTES = 64 * 1024;

module.exports = {
  name: 'agents-md',
  description: t('自动读工作区根下的 AGENTS.md / CLAUDE.md，每轮提供给模型，内容未变时复用读取结果'),

  setup(api) {
    const root = api.workspace;
    const at = (name) => path.join(root, name);

    let cachedFingerprint = '';
    let cachedRules = '';

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

      const fp = fingerprint();
      if (!fp) { cachedFingerprint = ''; cachedRules = ''; return ''; }
      if (cachedFingerprint === fp) return cachedRules;

      const chunks = render();
      if (!chunks.length) return '';
      cachedFingerprint = fp;

      cachedRules = [
        t('【工作区说明】工作区根下的说明文件（项目自己的规矩；以下为当前版本）'),
        ...chunks,
        t('照它办。它跟你手上的通用做法冲突时以它为准；它没说到的地方照旧。'),
      ].join('\n\n');
      return cachedRules;
    });

    api.log(`工作区说明就绪（认 ${NAMES.join(' / ')}，在 ${root}，每轮提供当前版本）`);
  },
};
