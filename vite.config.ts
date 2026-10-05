import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 打包之前先挡一道：**「用了、但没定义的名字」**。
 *
 * vite 只搬代码，不做类型检查 —— `DRAWER_MIN`、`willDetach` 这种名字它照收不误，
 * 进了包就是渲染时 ReferenceError：React 把整棵树卸掉，窗口只剩一片白，而且
 * 这份白已经上屏了（见 panel-crash.log / crash/last-crash.txt 两次现场）。
 * tsc 两秒就能把这类名字点出来，所以挡在打包之前。
 *
 * 认这三种：TS2304（找不到名字）· TS2552（是不是想写某某）· TS2349（把值当函数调）。
 * 前两种是「名字丢了」，第三种是「名字还在、但不是那个东西」—— 局部变量把 import 进来的
 * 函数遮住（`list.map((t) => … t('更早'))`，那个 t 是元素不是取词函数）就是这种：
 * 源码里读着没问题、tsc 只当类型噪音，可压缩后调用点变成 `s(...)`，上屏照样整棵树卸掉。
 * 别的一律不管：现存那些类型噪音（插件面板里的窄化、少数导出）不该拦着界面更新，
 * 那会把"改完三秒上屏"变成"改完永远不上去"。
 *
 * 为什么写在**配置求值**这一步，而不是 vite 插件的 buildStart：
 * vite 会先清空 outDir 再跑 buildStart —— 拦在那里，留下的是一个被清空的
 * dist/renderer，下次开窗口反而连界面都读不到。配置这一步在清目录之前。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const tsc = path.join(here, 'node_modules', 'typescript', 'bin', 'tsc');

function undefinedNames(): string[] {
  let out = '';
  try {
    out = execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json', '--noEmit'], {
      cwd: here,
      encoding: 'utf8',
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  return out.split(/\r?\n/).filter((l) => /error TS(2304|2552|2349):/.test(l));
}

const undef = undefinedNames();
if (undef.length) {
  throw new Error(
    `界面里有「名字用错了」的地方（没定义、或被局部变量遮住了），这一版不打包（上屏就是白屏）：\n${undef.slice(0, 20).join('\n')}`,
  );
}

export default defineConfig({
  base: './',
  root: '.',
  plugins: [react()],
  /**
   * 构建标识 —— 打进出包，面板崩溃现场会把它一起记下来（见 PanelBoundary）。
   * 这一项是打包机器的时间戳，跟 dist 里的产物文件名一一对应：拿到一份
   * 带着压缩栈的报告（index-XXXX.js:198:11108）能立刻认出是哪个版本。
   */
  define: {
    __BUILD_TAG__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'chrome128',
  },
  server: { port: 5199, strictPort: true },
});
