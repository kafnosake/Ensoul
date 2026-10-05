import { app } from 'electron';
import { userDataPath } from './paths';
import * as fs from 'fs';
import * as path from 'path';
import * as i18n from '../shared/i18n';
import type { Lang } from '../shared/i18n';

/**
 * 界面与助手语言 —— **主进程是权威**。
 *
 * 为什么不让渲染层自己拿 localStorage 说了算：语言不只在界面上生效，它还要决定
 * 系统提示里让模型用哪种语言回答、插件声明里的 label 用哪种语言显示。这三处
 * 分别在渲染层、主进程、以及被主进程 require 的插件里 —— 得有一个地方能同时
 * 够到，那就只能是主进程。
 *
 * 渲染层仍然存一份 localStorage（index.html 要在第一帧前把 html lang 贴对，见那儿），
 * 但开机时会拿主进程的值盖过去 —— 万一两边不一致，以这边为准。
 *
 * 跟 zoom.ts 一个路子：落 userData 一个小 json，改一次广播给所有窗口。
 */

const FILE = () => userDataPath('language.json');

function normalize(v: unknown): Lang {
  return i18n.isLang(v) ? v : 'zh';
}

/** 开机读一次；文件不在（头一回）就当中文 */
export function loadLang(): Lang {
  let v: unknown = 'zh';
  try {
    v = JSON.parse(fs.readFileSync(FILE(), 'utf8'))?.lang;
  } catch {
    v = 'zh';
  }
  const lang = normalize(v);
  i18n.setLangValue(lang, false); // 开局这一下不必通知（还没人订阅）
  installForPlugins();
  return lang;
}

export function getLang(): Lang {
  return i18n.getLang();
}

export function setLang(next: unknown): Lang {
  const lang = normalize(next);
  i18n.setLangValue(lang, false); // 广播由调用方（index.ts）负责，那里才知道有哪些窗口
  try {
    fs.writeFileSync(FILE(), JSON.stringify({ lang }));
  } catch {
    /* 写不下去就只活这一次运行 */
  }
  return lang;
}

/**
 * 插件怎么读到当前语言。
 *
 * 插件是**被 require 进来的普通 CJS**（见 plugins.ts），它们住在 plugins/ 下，
 * 到 dist/ 的相对路径在"源码树运行"和"打包成 asar"两种情形下不一样 —— 让每个
 * 插件自己算路径迟早会错。所以这里把模块本体挂到 global 上一次，插件只管取：
 *
 *   const i18n = global.__ensoulI18n;
 *   const t = i18n ? i18n.t : (s) => s;
 *
 * 拿不到就回落成"原文即结果"（跟中文下的表现一致），插件不会被它绊倒。
 */
export function installForPlugins(): void {
  (globalThis as any).__ensoulI18n = i18n;
  (globalThis as any).t = i18n.t;
}

/*
 * 模块一被 require 就装上 —— 不等 loadLang()。
 *
 * 为什么不只挂在 loadLang 里：插件的 require 时机由加载器决定，而"谁先被 import"
 * 是打包器的自由。真发生过的那次是插件先加载：顶层就写 t(...) 的插件当场
 * "t is not defined"，整份工具静默消失，界面上只表现为"功能没了"。
 * 取词函数可以比语言取值更早就在 —— 两件事分开。
 */
installForPlugins();

export { i18n };
