const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');
const { runNpm } = require('./npm-command');

const ROOT = path.resolve(__dirname, '..');
const say = (message) => console.log(`[安装] ${message}`);

async function proxyEnv() {
  const env = { ...process.env };
  let proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  if (!proxy) {
    const candidatePorts = [7890, 7897, 10809, 10808];
    for (const port of candidatePorts) {
      const ok = await new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const finish = (val) => { socket.destroy(); resolve(val); };
        socket.setTimeout(200);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
      });
      if (ok) {
        proxy = `http://127.0.0.1:${port}`;
        break;
      }
    }
  }
  if (proxy) Object.assign(env, {
    HTTPS_PROXY: proxy, HTTP_PROXY: proxy,
    npm_config_proxy: proxy, npm_config_https_proxy: proxy,
  });
  return env;
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('需要 Node.js 22 或更高版本。请使用根目录的安装入口，它会自动准备 Node.js。');
  }
  const env = await proxyEnv();
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  const options = { cwd: ROOT, stdio: 'inherit', env };
  say('1/3 安装项目依赖（包含开发与构建工具）…');
  const deps = runNpm(['install', '--include=dev', '--no-audit', '--no-fund'], {
    ...options, env: { ...env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
  });
  if (deps.error || deps.status !== 0) throw new Error('依赖安装失败。检查上方网络或 npm 错误后重新运行安装入口。');
  say('2/3 准备本机 Electron…');
  const electron = spawnSync(process.execPath, [path.join(__dirname, 'ensure-electron.js')], options);
  if (electron.error || electron.status !== 0) throw new Error('Electron 尚未就绪，安装没有完成。');
  say('3/3 构建应用…');
  const build = runNpm(['run', 'build'], options);
  if (build.error || build.status !== 0) throw new Error('构建失败，安装没有完成。请查看上方具体错误。');
  say('环境与应用产物已就绪。');
}

main().catch((error) => {
  say(error.message);
  process.exitCode = 1;
});
