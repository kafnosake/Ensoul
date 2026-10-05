/**
 * 用量与花费：挂在输入框那一排。
 *
 * 这东西以前是**写死在核心里的** —— 算钱在 providers.ts、记账在 index.ts、
 * 画界面在 ChatDock.tsx，三个文件各摊一块。现在它只是一个插件：
 * 关掉它，那一行就干净消失，核心一行都不用改。
 *
 * 界面部分它只给文本：插件跑在主进程，画不了界面，所以它只说"这个面板该显示什么"，
 * 由核心统一渲染。悬停看到的明细走 title。
 *
 * ⚠ 账目对象**不许叫 t** —— t 是这个壳子里的翻译函数（全局注入，见 lang.ts 的
 * installForPlugins）。叫成 t 就会把翻译函数遮住，`t(...)` 变成"调用一个对象"，
 * 运行时当场抛错、整条状态项被吞掉（用量就是这么消失过一次的）。这里一律叫 acc。
 */

const fmt = (n) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;

/** 把一条账累加进总数 —— 消息里的 `stats` 和跑着那一轮的实时账是同一个形状 */
function add(acc, s) {
  if (!s) return;
  acc.rounds += 1;

  const h = Math.min(s.cacheHit ?? 0, s.tokensIn ?? 0);
  acc.inTok += s.tokensIn ?? 0;
  acc.outTok += s.tokensOut ?? 0;
  acc.hit += h;
  acc.miss += s.cacheMiss ?? Math.max(0, (s.tokensIn ?? 0) - h);
  if (s.cacheHit != null) acc.cached += 1;

  if (s.cost) {
    acc.billed += 1;
    acc.cHit += s.cost.hit;
    acc.cMiss += s.cost.miss;
    acc.cOut += s.cost.out;
    acc.price = s.price ?? acc.price;
  }
}

/** 把一个面板的账汇总起来 */
function sum(panel) {
  const acc = {
    inTok: 0,
    outTok: 0,
    hit: 0,
    miss: 0,
    cHit: 0,
    cMiss: 0,
    cOut: 0,
    rounds: 0,
    billed: 0,
    cached: 0,
    price: null,
    /** 里面有没有"正在跑、还没跑完"的那一轮 */
    live: false,
  };

  for (const m of panel.chat ?? []) add(acc, m.stats);

  /**
   * 正在跑的那一轮：它的助手消息要到整轮跑完才进 chat，可钱已经在花了。
   * 带着它，状态条才会一轮一轮往上走；用户中途按停，那些 token 也不会凭空消失
   * （以前就是消失的：整条消息的账全成 0）。
   */
  if (panel.live) {
    add(acc, panel.live);
    acc.live = true;
  }

  return acc;
}

module.exports = {
  name: 'usage-meter',
  description: t('在输入框那一排显示这个面板的用量与花费，悬停看命中 / 未命中 / 输出的分项账'),

  setup(api) {
    const find = (panelId) => api.panels().find((x) => x.id === panelId);

    api.addStatusItem({
      id: 'usage',

      text(panelId) {
        const p = find(panelId);
        if (!p) return '';
        const acc = sum(p);
        if (!acc.inTok && !acc.outTok) return '';

        const bits = [fmt(acc.inTok + acc.outTok)];
        if (acc.cached) bits.push(t('命中 {p}%', { p: Math.round((acc.hit / Math.max(1, acc.inTok)) * 100) }));
        const sym = t('命中') !== '命中' ? '$' : '¥';
        if (acc.billed) bits.push(`${sym}${(acc.cHit + acc.cMiss + acc.cOut).toFixed(3)}`);
        // 还没跑完就标出来：数字是"到现在为止"，后面还会涨
        if (acc.live) bits.push(t('进行中'));
        return bits.join(' · ');
      },

      title(panelId) {
        const p = find(panelId);
        if (!p) return '';
        const acc = sum(p);
        const lines = [t('{a} 轮 · {b} 轮已计费', { a: acc.rounds, b: acc.billed })];
        if (acc.live) lines.push(t('（含正在跑的这一轮 —— 它还没跑完，数字还会往上走）'));

        if (acc.billed) {
          lines.push(t('命中输入    {n}    ¥{c}', { n: fmt(acc.hit), c: acc.cHit.toFixed(4) }));
          lines.push(t('未命中输入  {n}    ¥{c}', { n: fmt(acc.miss), c: acc.cMiss.toFixed(4) }));
          lines.push(t('输出        {n}    ¥{c}', { n: fmt(acc.outTok), c: acc.cOut.toFixed(4) }));
          lines.push(t('实际总价    ¥{c}', { c: (acc.cHit + acc.cMiss + acc.cOut).toFixed(4) }));
          if (acc.price) {
            lines.push(t('单价 {a} / {b} / {c} 元每百万（命中 / 未命中 / 输出）', { a: acc.price.hit, b: acc.price.miss, c: acc.price.out }));
          }
        } else {
          lines.push(t('还没有可计费的轮次（旧记录里没记过账）'));
        }

        const legacy = acc.rounds - acc.cached;
        if (legacy > 0) lines.push(t('另有 {n} 轮是旧版本留下的记录：没记缓存命中、也没算过钱', { n: legacy }));

        return lines.join('\n');
      },
    });
  },
};
