/**
 * 给插件面板注入取词函数 —— 改在 index.html 里最省事。
 *
 * 为什么不 import：插件面板（plugins/<名>/panel.tsx）与核心是两套构建（vite 的
 * import.meta.glob 直接扫插件目录），插件去 import src/ 下的路径迟早出岔子；
 * 而且插件是**外来的脸**，不该假设核心内部文件在哪。
 *
 * 所以：取词函数由**核心**挂到 window 上一次（这里），插件只管取 ——
 * 拿不到就回落成"原文即结果"（跟中文下的表现一致），插件不会被它绊倒。
 */
import { getLang, onLang, registerLocale, setLangValue, t } from '../../shared/i18n';

declare global {
  const t: (key: string, params?: Record<string, any>) => string;
}

export function installPluginI18n(): void {
  const bridge = {
    t,
    get lang() {
      return getLang();
    },
    /** 插件面板要重画时挂这儿（订阅核心的语言事件） */
    onLang,
  };
  (window as any).__ensoulI18n = bridge;
  (globalThis as any).__ensoulI18n = bridge;
  (window as any).t = t;
  (globalThis as any).t = t;
}

/*
 * **一加载就挂上，不能等 main.tsx 里再调。**
 *
 * 插件面板是 eager 预加载的（见 panel/pluginPanels.tsx 那个 import.meta.glob），
 * 而且它们在**模块顶层**就取词 —— billing 的 RANGES / VIEWS 就是 `label: t('24 小时')`。
 * 那些模块的求值比 main.tsx 的函数体早：原先只在 main.tsx 里调这一下，轮到插件时
 * `t` 还不存在，上来就是 ReferenceError: t is not defined，React 整棵树挂不上，
 * 窗口只剩一片白（改了 src 构建出来的那一版必白）。
 */
installPluginI18n();

/*
 * ── 插件自带的词典 ─────────────────────────────────────────────────────
 *
 * 插件的文案是**它自己的私有文案**，住在 <插件目录>/locales/<lang>.json ——
 * 核心词典那三行规矩头一条就是"严格限于核心渲染层，不含插件私有文案"。
 *
 * 为什么在渲染层也要收一遍：插件的 index.js 跑在主进程、panel.tsx 跑在这儿。
 * 主进程那边读盘注册（见 main/plugins.ts 的 mount）只管得到 index.js 的取词；
 * 面板这张脸取词走的是**渲染层这一份 t**，不在这儿注册，英文界面就会整片
 * 变成 [M] 开头的未译标记。
 *
 * 收法和脸、皮一个路子：glob 在**构建时**收走（跟 panel.tsx / panel.css 同源），
 * 所以工作区插件带不了词典 —— 跟它带不了脸是同一个道理（见 pluginPanels 顶部）。
 */
const dicts = import.meta.glob('/plugins/*/locales/*.json', { eager: true }) as Record<string, { default?: Record<string, string> }>;

for (const [path, mod] of Object.entries(dicts)) {
  // 路径形如 /plugins/<名>/locales/<lang>.json
  const m = /^\/plugins\/[^/]+\/locales\/([\w-]+)\.json$/.exec(path);
  if (!m) continue;
  const lang = m[1];
  if (lang !== 'zh' && lang !== 'en') continue;
  const dict = mod?.default;
  if (!dict || typeof dict !== 'object') continue;
  /*
   * **只补核心没有的**，不覆盖核心已有的。
   *
   * 为什么：插件词典是后注册的，直接 assign 会把核心那版盖掉。而在此之前
   * 插件词典从未被加载过 —— 也就是说界面上一直生效的是**核心那一版**。
   * 让插件版盖上去，等于顺手改了这些插件的界面文案；那是个独立决定，
   * 得有它的原因和复核，不该混在"接线"这一步里悄悄发生。
   *
   * 所以这里保守：核心已经翻过的词条原样留着，插件词典只补自己独有的那些。
   * 哪天要统一到插件词典，那是一次**有意的迁移**（改核心 + 改插件 + 验一遍），
   * 而不是接线时的副产品。
   */
  registerLocale(lang, dict, { keepExisting: true });
}
