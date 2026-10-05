/**
 * 工作台账 —— 记下工作区里的文件最近是哪块面板改的，构建报错时按归属分段标出来。
 *
 * 治的是这个：好几块面板在同一个工作区里并行干活，改的是**同一份源码**。
 * 谁改到一半，另一块面板的 build_project 就红了，而报错里只写文件名和行号 ——
 * 不写这个文件是谁动的。看到自己的构建红了，就可能把别人的活接过来修，
 * 两边撞在一起，都把对方的改动当成了自己弄坏的。
 *
 * 跟 jobs 当初缺 `owner` 是同一个病：**共享的东西没标归属**，模型就会把它
 * 当成自己那摊接着干。所以这里只做一件事：核心的写文件工具跑完记一笔
 * （谁改的、什么时候），构建报错时对照台账，把出错的文件分成
 * 「不是你改的」和「你自己改的」两段。
 *
 * 状态按**文件**分槽、不按面板分 —— 归属本来就是给人跨面板看的事实，
 * 按面板分反而看不见了（理由写在 audit 的 EXEMPT 里）。
 *
 * 不猜报错格式：只认 `文件(行,列)` 这种（tsc 就是它），认不出来就原样放行 ——
 * 台账是来帮忙的，不该因为解析不出来就把工具结果改写掉。
 */

const WRITE_TOOLS = new Set(['write_file', 'edit', 'restore_backup']);
const BUILD_TOOLS = new Set(['build_project', 'restart_project']);
/** 台账记多少个文件：够看出"最近谁在动"就行，不能无界长 */
const MAX_FILES = 400;

/** 结果里带这些词 = 这次没改成，不记账（工具失败是给文本，不是 throw） */
const NOT_DONE = /没找到|没改|失败|拒绝|不在工作区|打不开|读不到|没有这份/;

/** tsc 的报错形如 `src/main/store.ts(1038,39): error TS2739: ...` */
const ERR_LINE = /([\w./\\@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|css|json))\((\d+),(\d+)\)/g;

function ago(ms) {
  const d = Math.max(0, Date.now() - (Number(ms) || 0));
  if (d < 90_000) return t('刚刚');
  if (d < 3_600_000) return `${Math.round(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} 小时前`;
  return `${Math.round(d / 86_400_000)} 天前`;
}

module.exports = {
  name: 'work-ledger',
  description: t('记下工作区里的文件最近是哪块面板改的，构建报错时按归属分段标出来 —— 别人改到一半的活，别当自己的'),

  setup(api) {
    const read = () => {
      const raw = api.state.load(null) || {};
      return {
        at: Number(raw.at) || 0,
        files: raw.files && typeof raw.files === 'object' ? { ...raw.files } : {},
      };
    };

    /** 报错里写《标题》比写面板 id 好认；标题取不到就退回"别的面板" */
    const titleOf = (panelId) => {
      try {
        const p = api.panels().find((x) => x && x.id === panelId);
        return (p && p.title) || '';
      } catch {
        return '';
      }
    };

    const note = (rel, ctx) => {
      const file = String(rel || '').trim().replace(/\\/g, '/');
      if (!file || !ctx || !ctx.panelId) return;
      const st = read();
      st.files[file] = { panelId: ctx.panelId, title: titleOf(ctx.panelId), at: Date.now() };
      const all = Object.keys(st.files);
      if (all.length > MAX_FILES) {
        all.sort((a, b) => (st.files[a].at || 0) - (st.files[b].at || 0));
        for (const k of all.slice(0, all.length - MAX_FILES)) delete st.files[k];
      }
      st.at = Date.now();
      api.state.save(st);
    };

    api.onAfterTool((done) => {
      const name = String((done && done.name) || '');
      const out = String((done && done.result) || '');
      const ctx = done && done.ctx;

      if (WRITE_TOOLS.has(name)) {
        if (!NOT_DONE.test(out)) note(done.args && (done.args.path || done.args.file), ctx);
        return;
      }
      if (!BUILD_TOOLS.has(name)) return;

      const files = [...new Set([...out.matchAll(ERR_LINE)].map((m) => m[1].replace(/\\/g, '/')))];
      if (!files.length) return;

      const mine = (ctx && ctx.panelId) || '';
      const st = read();
      const notMine = [];
      const yours = [];
      for (const f of files) {
        const rec = st.files[f];
        if (!rec || !rec.panelId) notMine.push(`${f}（这个工作区里没人拿工具改过它）`);
        else if (rec.panelId === mine) yours.push(f);
        else notMine.push(`${f} —— ${rec.title ? `《${rec.title}》` : '别的面板'}${ago(rec.at)}改过`);
      }
      // 报错全落在你自己改过的文件上：没什么好说的，原样放行
      if (!notMine.length) return;

      const lines = [
        `⚠ 这次构建的报错里，有 ${notMine.length} 个文件**不是这块面板改的**：`,
        ...notMine.map((x) => `  · ${x}`),
        '',
        t('这些多半是别的面板正在改的活（也可能是刚被人手改过）。**不要顺手去修** ——'),
        t('先照原样报给用户，问清这摊归谁：改别人的活会跟对方撞上，两个人都白干。'),
      ];
      if (yours.length) lines.push('', `这里头你自己改过的是：${yours.join('、')} —— 那部分才归你。`);
      lines.push('', '---', out);
      return lines.join('\n');
    });
  },
};
