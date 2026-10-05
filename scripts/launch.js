/**
 * 启动器 —— Windows 和 macOS 共用这一份，平台路径只在**这里**算一次。
 *
 * 根目录入口通过 bootstrap 选择系统或项目内 Node.js，再进入这里。
 * 首次安装由 setup.js 负责；日常启动不安装 npm 依赖。
 *
 * 顺序是有讲究的（每一步都是踩过的坑）：
 *   1. **先认平台**：把本机那份 Electron 准备好（缺了就补、链接指对）。
 *      这一步必须在 build 之前 —— 不然出现过的那个场面会重演：启动脚本以为
 *      "依赖没装"，跑 npm install 去重装，断网时把 node_modules 弄坏。
 *   2. **再构建**：不能拿"dist 在不在"当依据。改了 src 不重建，跑的还是旧产物，
 *      而且一声不吭 —— 这是这个项目反复吃过的一个亏。
 *   3. **最后拉起**：用**本机这份**的可执行文件，detached 起，启动器自己退出。
 *      这样关掉那个命令行窗口不会把软件带走。
 *
 * 用法：
 *   node scripts/launch.js             # 认平台 → 构建 → 启动
 *   node scripts/launch.js --dry-run   # 只把三件事算出来打印，不启动（排查用）
 *   node scripts/launch.js --no-build  # 跳过构建
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { runNpm } = require('./npm-command');
const { prepareBrandedRuntime, brandedExecutable } = require('./brand-runtime');
const appIdentity = require('../src/shared/app-identity.json');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const noBuild = argv.includes('--no-build');

const say = (msg) => console.log(`[启动] ${msg}`);

/** 本机这份 Electron 的可执行文件在哪（平台不同，路径形状也不同） */
function electronExe() {
  const rel =
    process.platform === 'win32'
      ? 'electron.exe'
      : process.platform === 'darwin'
        ? 'Electron.app/Contents/MacOS/Electron'
        : 'electron';
  return path.join(ROOT, '.electron', `${process.platform}-${process.arch}`, rel);
}

function ensureElectron() {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'ensure-electron.js')], { cwd: ROOT, stdio: 'inherit' });
  return r.status === 0;
}

function build() {
  say('构建中（主进程 + 界面）…');
  const r = runNpm(['run', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  return r.status === 0;
}

async function main() {
  const exe = electronExe();

  if (dryRun) {
    say(`平台：${process.platform}-${process.arch}`);
    say(`可执行文件：${exe}`);
    say(`它存在吗：${fs.existsSync(exe) ? '在' : '不在（要先 node scripts/ensure-electron.js）'}`);
    say(`将执行：${exe} "${ROOT}"（工作目录 ${ROOT}）`);
    say(`日常运行使用的 ensoul 应用壳：${brandedExecutable()}`);
    return fs.existsSync(exe) ? 0 : 1;
  }

  if (!ensureElectron()) {
    say('Electron 没准备好，先不启动。');
    return 1;
  }
  if (!fs.existsSync(exe)) {
    // ensure 说成功但文件还是不在：只能是有别的东西在动它，别硬起
    say(`找不到本机这份 Electron：${exe}`);
    return 1;
  }

  if (!noBuild && !build()) {
    say('构建没过，先不启动（把上面的错修掉再来）。');
    return 1;
  }

  const branded = await prepareBrandedRuntime();
  say(`拉起：${branded}`);
  const env = { ...process.env, [appIdentity.sourceRootEnv]: ROOT };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(branded, [], { cwd: ROOT, env, detached: true, stdio: 'ignore' });
  child.unref();
  say('已交给新进程，启动器退出。');
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => { say(error.message); process.exitCode = 1; });
