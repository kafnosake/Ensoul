/**
 * 多语言内核 —— 界面、系统提示、插件提示词共用的那一层。
 *
 * 三条设计，别绕开：
 *
 *   1. **中文原文就是 key。** `t('通用设置')` 中文下原样返回，英文下查 EN 表。
 *      好处有两个：中文界面的代码一个字都不用改（`t()` 是纯包装，包不包长得一样）；
 *      词典里缺哪条也不会白屏 —— 直接回落原文，最坏就是那一句还是中文。
 *   2. **术语表是唯一真源**（见下面 GLOSSARY）：新词先在这里定死，再动文案。
 *      同一个概念在界面、提示词、插件里必须叫同一个英文词，否则英文用户看到的是
 *      三种说法。改词只改这里，别在别处顺手换同义词。
 *   3. **状态住内存，读写分两端**：渲染层落 localStorage（所有窗口共享一份）、
 *      主进程落 userData/language.json。两边都往这里 `setLangValue()` 灌，
 *      `onLang` 一发，各处自己重画。
 *
 * 词典缺条目是**正常状态**（这是一个正在翻译中的工程）：`t()` 永远不抛错。
 */

/* 英文词典**在加载路径里** —— 两张表（CORE_EN 短词 + EN_PROMPTS 长文本）都并进 DICT.en，
 *  见下面 const EN 那一段。曾经把长文本那张摘出去过一次，代价见 i18n.prompts.ts 顶部。 */

export type Lang = 'zh' | 'en';

/** 设置里那一列。加语言只加这里 + DICT 一张表 */
export const LANGS: { key: Lang; label: string }[] = [
  { key: 'zh', label: '中文' },
  { key: 'en', label: 'English' },
];

/**
 * 术语表 —— 全软件统一叫法（对齐开源社区惯用词）。
 *
 * 面板 panel ｜ 浮窗 floating window ｜ 停靠 dock ｜ 停靠树 dock tree
 * 标签组 tab group ｜ 收纳区 shelf ｜ 组件 component ｜ 挂件 widget
 * 工作区 workspace ｜ 技能 skill ｜ 插件 plugin ｜ 扩展 extension
 * 派单 dispatch ｜ 令牌 token ｜ 员工 agent ｜ 角色卡 agent card
 * 部门 department ｜ 经理 manager ｜ 便签 sticker ｜ 画布 canvas
 * 提示词 prompt ｜ 出图 generate ｜ 种子 seed ｜ 队列 queue ｜ 工作流 workflow
 * 提供方 provider ｜ 密钥 API key ｜ 上下文 context ｜ 回合 turn
 * 自主 auto ｜ 推测 reason ｜ 问答 chat ｜ 执行 execute
 */
export const GLOSSARY: Record<string, string> = {
  面板: 'panel',
  浮窗: 'floating window',
  停靠: 'dock',
  停靠树: 'dock tree',
  标签组: 'tab group',
  收纳区: 'shelf',
  组件: 'component',
  挂件: 'widget',
  工作区: 'workspace',
  技能: 'skill',
  插件: 'plugin',
  扩展: 'extension',
  派单: 'dispatch',
  令牌: 'token',
  员工: 'agent',
  角色卡: 'agent card',
  部门: 'department',
  经理: 'manager',
  便签: 'sticker',
  画布: 'canvas',
  提示词: 'prompt',
  出图: 'generate',
  种子: 'seed',
  队列: 'queue',
  工作流: 'workflow',
  提供方: 'provider',
  密钥: 'API key',
  上下文: 'context',
  回合: 'turn',
};

import { CORE_EN } from './locales/core.en';
import { EN_PROMPTS } from './i18n.prompts';

/**
 * 英文词典 —— 拆分治理架构：
 * 1. 核心短词：CORE_EN (src/shared/locales/core.en.ts) —— 按钮、标题、提示、错误
 * 2. 长文本：EN_PROMPTS (src/shared/i18n.prompts.ts) —— 系统提示、工具描述、插件写给模型的规矩
 * 3. 插件词典：运行时按需注册（见 registerLocale）
 *
 * **两张表都要进 DICT**。少放一张，那张表里的词在英文下就整片回落中文 —— 而
 * 长文本那张尤其致命：它是**给模型看的**。模型一旦读到满屏中文指令，就会照着中文
 * 回话（这正是 2026-10-04 那次把 EN_PROMPTS 移出加载路径之后的表现）。
 */
const EN: Record<string, string> = {
  ...CORE_EN,
  ...EN_PROMPTS,
};

/**
 * 插件/模块按需扩充词表（支持每个插件单文件按需注入）。
 *
 * `keepExisting`：只补**这张表里还没有的**词条，已有的一个字不动。
 * 给插件词典用 —— 它跟核心词典难免有重叠（同一个中文原文，两边各翻过一版），
 * 谁赢必须是个有意的决定，不能由"谁后注册"来定。
 */
export function registerLocale(
  lang: Lang,
  dict: Record<string, string>,
  opts?: { keepExisting?: boolean },
): void {
  if (!DICT[lang]) DICT[lang] = {};
  if (!opts?.keepExisting) {
    Object.assign(DICT[lang], dict);
    return;
  }
  for (const [k, v] of Object.entries(dict)) {
    if (DICT[lang][k] === undefined) DICT[lang][k] = v;
  }
}

const DICT: Record<Lang, Record<string, string>> = {
  zh: {}, // 中文不需要表：原文即结果
  // 长文本另放一处（见 i18n.prompts.ts 顶部那三条硬规矩），这里合起来查
  en: EN,
};

let cur: Lang = 'zh';
const subs = new Set<(l: Lang) => void>();

/** 认不认这个值（外部存进来的字符串要过一道，别把脏值灌进来） */
export function isLang(v: unknown): v is Lang {
  return v === 'zh' || v === 'en';
}

export function getLang(): Lang {
  return cur;
}

/**
 * 灌一个新语言。**同值也照样通知** —— 从磁盘/存储里读到的那一次也要让界面重画一遍，
 * 那是"开局把界面调成该有的样子"，不能因为"值没变"而跳过。
 */
export function setLangValue(l: Lang, notify = true): void {
  cur = isLang(l) ? l : 'zh';
  if (notify) for (const f of subs) f(cur);
}

export function onLang(cb: (l: Lang) => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

/**
 * 取一句当前语言的文字。`zh` 传中文原文（也就是 key）。
 *
 * `vars` 是占位替换：原文里写 `{n}`，这里传 `{ n: 3 }`。
 * 英文语序和中文不同时，写法在词典里单独定（词典值是完整句子，占位符名字对得上即可）。
 */
export function t(zh: string, vars?: Record<string, string | number>): string {
  /*
   * 中文不是「直接 return zh」—— 占位符在中文下同样要替换。
   *
   * 从前这里提前返回，`t('暂存 {n}', { n: 3 })` 在中文界面上原样吐出「暂存 {n}」：
   * git 状态条、用量条、各种计数全是那个样子。英文下因为走了查表那条路，反而正常。
   * 语言只决定**去哪张表取词**，跟「替换不替换占位符」是两件事，别耦合在一起。
   */
  /*
   * 换行的两种写法都要认。
   *
   * 词典是**一行一条 JSON**，所以那里的 key 只能写 \n（反斜杠 + n）；
   * 而代码里写成 '\n……' 时，JS 会先把它变成一个**真换行符**。
   * 同一个字符串，两边字面不同 —— 不归一化就永远查不到。
   * 这里只做"查词前统一"，不改返回值，所以译文里该有换行的地方照旧。
   */
  // 换行规范化
  const key = zh.includes('\n') ? zh.replace(/\n/g, '\\n') : zh;
  let translated = cur === 'zh' ? zh : (DICT[cur]?.[key] ?? DICT[cur]?.[zh]);
  
  // 缺词显形探针：非中文模式下若词典缺失，警报显形，杜绝静默回落
  // 防御重复加标：如果字符串已经以 [M] 开头，不再叠加
  if (cur !== 'zh' && translated === undefined) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`[i18n:missing] [${cur}] "${zh}"`);
    }
    translated = zh.startsWith('[M] ') ? zh : `[M] ${zh}`;
  }
  
  let out = translated ?? zh;
  if (vars) {
    for (const k of Object.keys(vars)) out = out.split(`{${k}}`).join(String(vars[k]));
  }
  return out;
}

/** 有没有翻过这一条（界面可以拿它做"翻译覆盖率"，暂时没人用） */
export function hasTranslation(zh: string): boolean {
  return cur === 'zh' || zh in DICT[cur];
}

/** 交给 Intl / toLocaleString 用的标签 */
export function localeTag(): string {
  return cur === 'zh' ? 'zh-CN' : 'en-US';
}

/** 时间：`fmtTime(ms)` → 14:05；`fmtTime(ms, true)` → 10/03 14:05 */
export function fmtTime(ms: number, withDate = false): string {
  const d = new Date(ms);
  return withDate
    ? d.toLocaleString(localeTag(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' });
}

/** 日期：`fmtDate(ms)` → 10/03 */
export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(localeTag(), { month: '2-digit', day: '2-digit' });
}
