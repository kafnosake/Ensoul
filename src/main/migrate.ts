import * as fs from 'fs';
import * as path from 'path';
import { userDataDir } from './paths';

/**
 * 改名字留下的两份数据要搬过来（2026-09-23：anycode → Ensoul）。
 *
 * 为什么必须写成一个模块，而不是"我手工搬一次就完了"：
 * 名字改了以后，**所有存数据的地方路径都会跟着变**，而这些路径是从
 * `app.getPath('userData')`（= `%APPDATA%\<package.json 里的 name>`）和工作区里的
 * 标记目录推出来的，不是写死的常量。也就是说：
 *
 *   · 旧的 `%APPDATA%\anycode\workspace.json` 是**你的面板和全部对话**的真源；
 *   · 旧的 `%APPDATA%\anycode\providers.json` 是**你的接口地址和密钥**；
 *   · 工作区里的 `.anycode/` 装着备份、便签、任务清单、各插件状态。
 *
 * 不搬，第一次用新名字启动就是一个空壳：面板没了、密钥没了、备份也没了 ——
 * 而这些东西用户是看不见的，只会觉得"软件把我东西弄丢了"。
 *
 * 两条原则：
 *   1. **只搬一份、只搬一次**：新地方已经有 workspace.json 就什么都不做
 *      （绝不能反过来把新的覆盖成旧的）。
 *   2. **不动手删旧的**：旧目录原样留着，用户确认没问题了自己删。
 */

/** 旧名字。改名字那次留下的，只在这里出现一次，别的任何地方都不该再写它 */
const OLD = 'anycode';
/** 工作区里的旧标记目录 / 新标记目录 */
const OLD_DIR = '.anycode';
const NEW_DIR = '.ensoul';

/**
 * `%APPDATA%\<旧名>` → 新的 userData。
 *
 * 只搬真的属于"应用数据"的那几样：workspace.json（含 .bak / .before-restore）、
 * closed/（最近关闭的面板本体）、components/（面板组件库）、shots/（对话里的图）、
 * providers.json（提供方与密钥）、plugins.log / restart.log（排查用）。
 * **不搬 Chromium 的 Cache / GPUCache / Local Storage 那一堆** —— 那些是浏览器
 * 自己会重建的缓存，搬过去只是白占几百兆，还可能带着旧的路径记录。
 */
export function migrateUserData(): string {
  let newDir = '';
  try {
    newDir = userDataDir();
  } catch {
    return '';
  }
  if (!newDir) return '';

  const appData = path.dirname(newDir);
  const oldDir = path.join(appData, OLD);
  if (path.resolve(oldDir) === path.resolve(newDir)) return ''; // 名字没变，不用搬
  if (!fs.existsSync(oldDir)) return '';

  // 只搬一次：新地方已经有真源了，就当作搬过了
  if (fs.existsSync(path.join(newDir, 'workspace.json'))) return '';

  const files = ['workspace.json', 'workspace.json.bak', 'workspace.json.before-restore', 'providers.json', 'credentials.json', 'model.json', 'plugins.log', 'restart.log'];
  const dirs = ['closed', 'components', 'shots', 'plugin-state'];

  const moved: string[] = [];
  try {
    fs.mkdirSync(newDir, { recursive: true });
  } catch (e: any) {
    console.error('[改名] 新数据目录建不出来：', e?.message ?? e);
    return '';
  }

  for (const name of files) {
    const from = path.join(oldDir, name);
    const to = path.join(newDir, name);
    try {
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.copyFileSync(from, to);
        moved.push(name);
      }
    } catch (e: any) {
      console.error(`[改名] ${name} 没搬过来：`, e?.message ?? e);
    }
  }
  for (const name of dirs) {
    const from = path.join(oldDir, name);
    const to = path.join(newDir, name);
    try {
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.cpSync(from, to, { recursive: true });
        moved.push(`${name}/`);
      }
    } catch (e: any) {
      console.error(`[改名] ${name}/ 没搬过来：`, e?.message ?? e);
    }
  }

  if (moved.length) {
    console.log(`[改名] 已从旧数据目录搬过来：${moved.join('、')}（旧的留在 ${oldDir}，确认没问题可以自己删）`);
  }
  return moved.join(',');
}

/**
 * 工作区里的 `.anycode/` → `.ensoul/`。
 *
 * 这里用**改名**而不是复制：里面可能攒着几百份文件备份（实测 498 个文件 / 7.9MB），
 * 复制既慢又会让两份分叉。两边都存在时什么都不做 —— 宁可让用户自己看一眼，
 * 也不能猜哪边是对的。
 */
export function migrateWorkspaceState(root: string): string {
  if (!root) return '';
  const from = path.join(root, OLD_DIR);
  const to = path.join(root, NEW_DIR);
  try {
    if (!fs.existsSync(from) || fs.existsSync(to)) return '';
    fs.renameSync(from, to);
    console.log(`[改名] 工作区状态目录已改名：${OLD_DIR} → ${NEW_DIR}（${root}）`);
    return to;
  } catch (e: any) {
    // 改名失败（被占用、跨盘……）不许挡住启动：新的目录会自己建，只是历史备份留在旧目录
    console.error(`[改名] ${OLD_DIR} 改不动（${e?.message ?? e}）：新的会照常建，旧的留在原地`);
    return '';
  }
}
