import React from 'react';
import { api } from '../core/api';
import { t } from '../core/i18n';

/** 出错的现场落在这儿：界面上那张卡片说不全（尤其栈），得留一份能查的 */
const CRASH_LOG = '.ensoul/state/panel-crash.log';
/**
 * 同一批现场另存一份**带时间戳的归档**（见 componentDidCatch 里那段说明）。
 * 以前只有上面那一份、而它是整份覆盖 —— 连着炸几块时只剩最后一块。
 */
const CRASH_DIR = '.ensoul/state/panel-crash';

/**
 * 这一份产物是什么时候构建的 —— 由 vite 在打包时注进来（见 vite.config.ts 的 define）。
 * 拿不到就写 'dev'（vite dev 或测试环境下没有这个值），不影响任何逻辑。
 */
declare const __BUILD_TAG__: string | undefined;
const BUILD_TAG: string = typeof __BUILD_TAG__ === 'string' ? __BUILD_TAG__ : 'dev';

/**
 * 一块面板的兜底：**脸崩了只烂这一块，不烂整个窗口**。
 *
 * 为什么必须有它：面板主体是**外来的代码**（插件自带的脸就在 plugins/<名>/panel.tsx），
 * 而插件那两半是**两个节奏**在热更新 —— 脑在主进程按文件时间重挂，脸跟着 ui-refresh
 * 重建 reload。中间那一小段窗口期里，脸可能拿着旧形状的数据（脑还没重算）——
 * 于是某一行 `.length` 就抛了。
 *
 * 没有这层的时候，React 遇到渲染异常会把**整棵树卸掉**：用户看到的是全窗口白屏，
 * 连"是哪块面板坏的"都看不出来，只能重启软件。有了它，坏的是这块面板、话摆在脸上。
 */
export class PanelBoundary extends React.Component<
  { kind: string; children: React.ReactNode; fallback?: React.ReactNode },
  { error: Error | null; at: number }
> {
  state: { error: Error | null; at: number } = { error: null, at: 0 };
  /** 这一回已经自动重画过了吗 —— 只自动重画一次，真错了第二回就把卡片摆出来 */
  private retried = false;
  /** 上一次炸是什么时候 —— 紧接着又炸就说明重画救不了它，别再自动重画了 */
  private lastCrashAt = 0;

  static getDerivedStateFromError(error: Error) {
    return { error, at: Date.now() };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 落一份到控制台：出错信息在界面上说不全（尤其栈），排查时得有
    console.error(`[panel] 面板（${this.props.kind}）渲染出错：`, error);
    /**
     * 现场落盘。卡片上只有一个 message，**栈和"出错的是哪棵组件树"都在这一步丢掉**，
     * 于是每次只能看见"哪里炸了"却看不见"谁炸的" —— 几百轮里都只能靠猜。
     */
    /**
     * 带上**产物标识**：报错栈里是压缩后的文件名和列号（index-XXXX.js:198:11108），
     * 不知道是哪个版本的产物，就得靠反解产物才认得回源码 —— 这一步查一次要很久。
     * 标识跟着构建时间走，跟 dist 里的文件名一一对应，一眼能对上。
     */
    const report = `时间：${new Date().toISOString()}
产物：${String(BUILD_TAG)}
面板类型：${this.props.kind}
错误：${String(error?.message || error)}

{t('错误栈：')}
${String(error?.stack || '（没有栈）')}

{t('出错的那棵组件树：')}
${String(info?.componentStack || '（没有 componentStack）')}`;
    void api.fs.write(CRASH_LOG, report).catch(() => {});
    /**
     * 另存一份**带时间戳的归档**。上面那一份是整份覆盖的，连着炸几块面板时
     * 只会留下最后一块 —— 而"哪些面板一起炸"恰恰是最有用的线索：
     * 全部 chat 面板一起炸 = 共用代码的问题，单独一块炸 = 那块自己的问题。
     * 归档失败不影响任何事（只是少一份现场），所以 onError 一律吞掉。
     */
    void api.fs
      .write(`${CRASH_DIR}/${new Date().toISOString().replace(/[:.]/g, '-')}-${this.props.kind}.log`, report)
      .catch(() => {});
    /**
     * 自动重画一次。这类在提交期炸掉的错（DOM 树跟 React 记的不一致）**重画一次就好** ——
     * 用户现在就是这么做的，只是得自己动手。让他每轮都点一下是不对的。
     * 但**紧接着又炸就不重画了**（下面那个 burst）：那说明重画救不了它，摆卡片说话，别转圈。
     */
    const burst = Date.now() - this.lastCrashAt < 3000;
    this.lastCrashAt = Date.now();
    if (!this.retried && !burst) {
      this.retried = true;
      setTimeout(() => this.setState({ error: null }), 400);
    }
  }

  /** 重画成功了 = 这一回过去了，下次再炸还能自动重画一次 */
  componentDidUpdate() {
    if (!this.state.error) this.retried = false;
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if ('fallback' in this.props) return this.props.fallback;
    return (
      <div className="panel-crash">
        <div className="crash-head">{t('这块面板出错了')}</div>
        <div className="crash-msg">{String(error?.message || error)}</div>
        <div className="crash-note">
          面板类型「{this.props.kind}」渲染时抛了异常。别的面板不受影响 —— 修好之后点下面重画。
        </div>
        <div className="crash-acts">
          <button onClick={() => this.setState({ error: null })}>{t('重画一次')}</button>
          <button onClick={() => window.location.reload()}>{t('重载界面')}</button>
        </div>
      </div>
    );
  }
}
