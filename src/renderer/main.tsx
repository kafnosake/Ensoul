import React from 'react';
import ReactDOM from 'react-dom/client';
// 样式只有一个入口：styles.css 里按层叠顺序 @import 各块。
// 往这里直接 import 单独的 .css 会让顺序脱离那一份清单 —— 别再这么干。
// （插件自带的面板样式不走这里：plugins/<名>/panel.css 由下面的管理器扫走。）
import './ui/styles.css';
import { api } from './core/api';
import { initTheme } from './ui/theme';
// 插件面板的取词函数要先挂：插件模块一加载就取词，晚一步那批 label 就回落成中文。
// 真正管用的是 core/plugin-i18n.ts 里那一下**模块顶层**的自装 —— 这个 import 的位置
// 就是它比插件面板先跑的原因，别把它挪到 pluginPanels / MainShell 后面。
import { installPluginI18n } from './core/plugin-i18n';
import { initLang, onLang } from './core/i18n';
import { refreshPluginPanels } from './panel/pluginPanels';
import { FloatingShell } from './shell/FloatingShell';
import { MainShell } from './shell/MainShell';
import { WidgetShell } from './shell/WidgetShell';

/**
 * 插件自带的面板类型，要先拿插件清单（在主进程）才知道有哪些。
 * 挂在这儿而不是某个壳里：主窗口和浮窗都由这个入口起，一处就够。
 * 装好之后管理器会通知注册表，界面自己重画 —— 不用刷新窗口。
 */
initTheme();
// 取词函数已经在 core/plugin-i18n.ts 模块顶层挂好了（那才是抢在插件面板前面的那一下）；
// 这里再挂一遍只是幂等，图个"入口处看得见"。
installPluginI18n();
// 语言的权威在主进程（见 main/lang.ts）。不 await —— 先按 localStorage 那份画，值回来自己重画。
void initLang();
void refreshPluginPanels();

/**
 * 一个渲染入口，**三种**角色：
 *   main     主窗口：一棵大的停靠树
 *   floating 浮窗： 一棵小的停靠树（所以它里面照样能放多个面板、能分块）
 *   widget   挂件窗口：**不是停靠树，就一块面板**（见 Panel.widget）——
 *            无壳、可透明、常驻置顶，所以这里画的是裸的那一块，不带壳、不带标签栏。
 */
/**
 * 订阅语言的根组件：语言一变，整棵树重画。
 *
 * 为什么非要有它：各处取过的词都进了各自的渲染结果，光把词典换掉界面不会动 —— 只订阅设置窗
 * 没用，主壳、浮窗、侧栏、面板标题都还停在旧语言上（看着像「只有设置变了」）。挂在这一层，
 * 一处覆盖三种窗口（main / floating / widget）。
 */
function LangRoot({ render }: { render: () => React.ReactNode }) {
  const [, bump] = React.useState(0);
  React.useEffect(() => onLang(() => bump((n) => n + 1)), []);
  // 必须**现调** render()，不能把 children 原样透传：
  // 元素引用不变时 React 会跳过整个子树的重渲染，那样订阅等于白订。
  return <>{render()}</>;
}

const root = ReactDOM.createRoot(document.getElementById('root')!);

root.render(
  <LangRoot
    render={() =>
      api.mode === 'widget' && api.widgetPanel ? (
        <WidgetShell panelId={api.widgetPanel} />
      ) : api.mode === 'floating' && api.windowId ? (
        <FloatingShell windowId={api.windowId} />
      ) : (
        <MainShell />
      )
    }
  />,
);

