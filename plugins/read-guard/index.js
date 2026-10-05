/**
 * 没读过的文件，不许改。
 *
 * 模型最容易犯的错不是"改错"，是"凭印象改"：心里记得这文件长什么样就直接 edit，
 * old_string 匹配不上，于是换个写法再试、再试 —— 既烧 token，又容易把别处改坏。
 * 防它的成本极低：这次改之前没读过，就不放行。
 *
 * 记账是**内存里的、按面板分的**：换个面板等于换了一段上下文，那边没读过就是没读过。
 * 故意不落盘 —— 重启之后"读过"这个印象本来就该重新建立；宁可让人多读一次，
 * 也不留一张过期的通行证。
 *
 * 只判"看没看过"，不判"看全没看全"：判后者要在 edit 的 old_string 上做区间分析，
 * 既容易误伤，又逼着人为了改一行而整份重读，不值。带 offset/limit 的部分读也算看过。
 */

const fs = require('fs');
const path = require('path');

/** 会改动文件内容的两个工具。文件名对不上就是漏防，名字写错就是白防 —— 以核心的工具表为准 */
const WRITE_TOOLS = new Set(['edit', 'write_file']);

module.exports = {
  name: 'read-guard',
  description: t('没读过的文件不许改：edit / write_file 之前要求先用 read_file 看一遍'),

  setup(api) {
    const root = api.workspace;

    /** panelId -> Set<规范化后的绝对路径> */
    const seen = new Map();

    // 相对、绝对、正反斜杠都要能对上同一份文件；Windows 路径大小写不敏感
    const norm = (p) => {
      const full = path.resolve(root, String(p || ''));
      return process.platform === 'win32' ? full.toLowerCase() : full;
    };

    const isFile = (full) => {
      try {
        return fs.statSync(full).isFile();
      } catch {
        return false; // 不存在 / 是个目录，都当"没有可读的现状"
      }
    };

    const box = (ctx) => {
      const key = (ctx && ctx.panelId) || '';
      let s = seen.get(key);
      if (!s) {
        s = new Set();
        seen.set(key, s);
      }
      return s;
    };

    api.onBeforeTool((call) => {
      if (!call || !call.args) return;
      const rel = call.args.path;
      if (typeof rel !== 'string' || !rel) return;
      const full = norm(rel);

      // 读：读到了才算看过。读不存在的东西（多半是路径记错了）不记账
      if (call.name === 'read_file') {
        if (isFile(full)) box(call.ctx).add(full);
        return;
      }

      if (!WRITE_TOOLS.has(call.name)) return;
      if (!isFile(full)) return; // 新建的文件没有"现状"可读，放行
      if (box(call.ctx).has(full)) {
        box(call.ctx).add(full);
        return; // 读过，放行
      }

      return [
        `${rel} 这次还没读过，${call.name} 没有执行。`,
        `先看一眼现状：read_file（path 填 ${rel}），照实际内容改。`,
        `（read-guard 挡的是"凭印象改"——old_string 对不上再反复试，最费 token 也最容易改坏。）`,
      ].join('\n');
    });
  },
};
