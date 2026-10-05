import { app, BrowserWindow, dialog } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appVersion, userDataPath } from './paths';
import { t } from '../shared/i18n';

/**
 * 崩溃收口。
 *
 * 三种死法以前都是静默的：主进程抛未捕获异常（进程直接没）、渲染进程崩
 * （留一个空白窗）、窗口无响应（只能强杀）。用户看到的是"窗口不明不白消失"，
 * 手上一条线索都没有。
 *
 * 这里只做一件事：把现场落成一份文件，然后把话说清楚。不重启、不装作没事 ——
 * 第一次崩就能拿到报告，比任何兜底都值。
 */

/** 渲染层最后几十条输出，崩的时候一起带走 —— 出事前那句通常就在里面 */
const recent: string[] = [];
const MAX_RECENT = 60;

export function noteRecent(text: string) {
  if (!text) return;
  recent.push(text.slice(0, 400));
  if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
}

/** 报告放这儿：跟 userData 走，不依赖工作区 —— 崩的时候工作区可能还没加载 */
function reportDir() {
  return userDataPath('crash');
}

function writeReport(kind: string, detail: unknown): string | null {
  try {
    const dir = reportDir();
    fs.mkdirSync(dir, { recursive: true });
    const at = new Date();
    const body = {
      at: at.toISOString(),
      kind,
      app: {
        version: appVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
      },
      platform: { os: process.platform, arch: process.arch, release: os.release() },
      error: detail instanceof Error ? { message: detail.message, stack: detail.stack } : detail,
      recent,
    };
    const file = path.join(dir, `crash-${at.toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf8');
    // 再留一份不会被时间戳淹没的，回头一眼就能找到
    fs.writeFileSync(path.join(dir, 'last-crash.txt'), `${at.toISOString()}  ${kind}\n\n${JSON.stringify(body, null, 2)}\n`, 'utf8');
    return file;
  } catch {
    return null;
  }
}

function announce(title: string, detail: string) {
  if (!app.isReady()) return;
  void dialog.showMessageBox({ type: 'error', title, message: title, detail, buttons: [t('知道了')] }).catch(() => {});
}

/** 装一次，尽量早调 —— 晚一秒就有一秒的死法是静默的 */
export function installCrashGuard() {
  process.on('uncaughtException', (err) => {
    const file = writeReport('uncaught-exception', err);
    console.error('[崩溃] 主进程未捕获异常：', err);
    announce(t('主进程出错了'), `现场已经记下来了${file ? `：\n${file}` : ''}\n\n软件还活着，但状态可能不干净 —— 建议重启一次。`);
  });

  process.on('unhandledRejection', (reason) => {
    const file = writeReport('unhandled-rejection', reason);
    console.error('[崩溃] 未处理的 Promise 拒绝：', reason);
    // 这条不一定致命（很多是网络失败），记下来就行，不打扰用户
    void file;
  });

  // 界面进程崩了：窗口还在，但里面是空的 —— 至少要说一句，并且给个重载的办法
  app.on('render-process-gone', (_e, wc, details) => {
    const file = writeReport('render-process-gone', { reason: details.reason, exitCode: details.exitCode, url: wc?.getURL?.() });
    console.error('[崩溃] 渲染进程没了：', details);
    const win = wc ? BrowserWindow.fromWebContents(wc) : null;
    if (!app.isReady()) return;
    void dialog
      .showMessageBox({
        type: 'error',
        title: t('界面崩了'),
        message: t('界面进程意外退出'),
        detail: `原因：${details.reason}${file ? `\n现场：${file}` : ''}`,
        buttons: [t('重新加载界面'), t('先不管')],
        defaultId: 0,
        cancelId: 1,
      })
      .then((r) => {
        if (r.response === 0 && win && !win.isDestroyed()) win.reload();
      })
      .catch(() => {});
  });

  // GPU / 网络这些辅助进程崩了通常会自动回退，记一份就够了，不弹窗
  app.on('child-process-gone', (_e, details) => {
    writeReport('child-process-gone', details);
    console.error('[崩溃] 辅助进程没了：', details.type, details.reason);
  });
}
