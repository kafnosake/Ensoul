/**
 * 渲染层的语言入口 —— 界面各处只认这一个。
 *
 * 三件事必须一起发生，缺一个就会出现"界面英文了、日期还是中式"这种半截状态：
 *   · 文案（t）
 *   · 日期/时间的格式化标签（localeTag，见 shared/i18n 的 fmtTime/fmtDate）
 *   · html lang 属性（无障碍与 CSS 断行要用）
 *
 * 存储走**主进程**（api.ui.getLang / setLang）：语言还要决定助手回话的语言和插件
 * 声明里的名字，那些在主进程和插件里 —— 只存 localStorage 的话它们看不见。
 * localStorage 也留一份：index.html 要在第一帧之前把 html lang 贴对，那时还没有 IPC。
 */

import { getLang, isLang, onLang, setLangValue, localeTag, t, fmtTime, fmtDate, LANGS, type Lang } from '../../shared/i18n';
import React from 'react';
import { api } from './api';

export const K_LANG = 'ensoul.lang';

export { t, localeTag, fmtTime, fmtDate, LANGS, onLang, getLang };
export type { Lang };

function apply(lang: Lang): void {
  setLangValue(lang, true);
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.documentElement.dataset.lang = lang;
}

/**
 * **模块一加载就同步贴一次语言**（读 localStorage，不问主进程）。
 *
 * 为什么非得在这儿、不能等 initLang()：插件面板和内置类型注册表都在**模块顶层**取词
 * （billing 的 RANGES / VIEWS 就是 `label: t('24 小时')`），而它们的模块求值发生在
 * 渲染入口的函数体**之前** —— initLang() 里那次 apply 根本还没轮到。
 *
 * 后果就是那批 label 冻在中文上：界面全英文，唯独几块面板里的固定标签是中文，
 * 且只有整窗重载才会重取一次（语言是模块求值那一刻的快照，不会自己更新）。
 *
 * 这一下不改"以主进程为准"：initLang() 拿到权威值后照样会再 apply 一次盖过去。
 */
(() => {
  let v: string | null = null;
  try {
    v = localStorage.getItem(K_LANG);
  } catch {
    /* 隐私模式之类：按中文来 */
  }
  apply(isLang(v) ? v : 'zh');
})();

/** 别的窗口改了语言 —— 跟上 */
if (api?.ui?.onLang) {
  api.ui.onLang((next: any) => {
    if (isLang(next) && next !== getLang()) {
      try {
        localStorage.setItem(K_LANG, next);
      } catch {
        /* 存不进去就只活这一次运行 */
      }
      apply(next);
    }
  });
}

/**
 * 开机把语言定下来。**以主进程为准**，拿不到才用 localStorage 里那份。
 * 返回 Promise 是为了让调用处能 await —— 但那不是必须的：定不下来时界面先按
 * localStorage（或中文）画，值回来了自己会重画一遍。
 */
export async function initLang(): Promise<Lang> {
  let local: Lang = 'zh';
  try {
    const v = localStorage.getItem(K_LANG);
    if (isLang(v)) local = v;
  } catch {
    /* 隐私模式之类：回落中文 */
  }
  /**
   * **进 IPC 之前先把这一份贴上去**：localStorage 是同步的，不用等主进程。
   *
   * 为什么不能等到 await 之后再贴：插件的脸（plugins/<名>/panel.tsx）是 eager 预加载的，
   * 它们在**模块顶层**就取词（billing 的 RANGES / VIEWS 就是 label: t('24 小时')）。
   * 模块求值发生在渲染入口的函数体之前 —— 而这里挂起等主进程的时候，
   * 入口的函数体已经接着往下跑、插件模块随即求值了。等 IPC 回来再 apply，
   * 那批 label 早就冻成中文，只有整窗重载才会重取一次。
   *
   * 表现就是：**界面全英文，唯独那几块插件面板里的固定标签还是中文**。
   */
  apply(local);
  try {
    const fromMain = await api.ui.getLang();
    if (isLang(fromMain)) {
      if (fromMain !== local) {
        localStorage.setItem(K_LANG, fromMain);
        apply(fromMain);
      }
      return fromMain;
    }
  } catch {
    /* 主进程还没起来：先用 local 这一份，下一轮对不上会自己纠正 */
  }
  return local;
}

/** 换语言：主进程落盘 + 广播，本地立刻生效（不等广播回来，界面点了就该变） */
export async function setLang(next: Lang): Promise<void> {
  try {
    localStorage.setItem(K_LANG, next);
  } catch {
    /* 同上 */
  }
  apply(next);
  try {
    await api.ui.setLang(next);
  } catch {
    /* 主进程没接住：界面这一份也算数，下次开机再同步 */
  }
}

/**
 * 语言一变就重画这块组件。
 *
 * 为什么要订阅：组件里取过的词都进了各自的渲染结果，光把词典换掉界面不会动 —— 不订阅的话，
 * 切语言要等到下一次交互才换字，看着像没生效。
 *
 * 用法：const { t: tr } = useLang(); —— 把 t 改名成 tr。
 * 组件里常有个叫 t 的局部变量（list.map((t) => …)），那会遮住取词函数；源码里读着没问题，
 * 压缩后调用点成了 s(...)，上屏就是白屏（见 vite.config.ts 那段）。改名躲开。
 */
export function useLang() {
  const [lang, setLang] = React.useState(getLang());
  React.useEffect(() => onLang((l) => setLang(l)), []);
  return { lang, t };
}
