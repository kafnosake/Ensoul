const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const appIdentity = require('../src/shared/app-identity.json');

function plan() {
  const pkg = require('../package.json');
  const version = require(path.join(ROOT, 'node_modules/electron/package.json')).version;
  const icon = path.join(ROOT, 'assets/brand/platform', process.platform === 'darwin' ? 'ensoul.icns' : 'ensoul.ico');
  const stamp = crypto.createHash('sha256').update(fs.readFileSync(__filename)).update(JSON.stringify(appIdentity)).update(fs.readFileSync(icon)).update(`${version}:${pkg.version}:${process.platform}:${process.arch}`).digest('hex').slice(0, 16);
  const output = path.join(ROOT, '.electron', 'brand', `${process.platform}-${process.arch}`, stamp);
  const bundle = path.join(output, `ensoul-${process.platform}-${process.arch}`);
  const exe = process.platform === 'darwin' ? path.join(bundle, 'ensoul.app/Contents/MacOS/ensoul') : path.join(bundle, process.platform === 'win32' ? 'ensoul.exe' : 'ensoul');
  return { pkg, version, icon, output, exe };
}

function cachedZip(version) {
  const name = `electron-v${version}-${process.platform}-${process.arch}.zip`;
  const roots = [process.env.ELECTRON_CACHE, process.env.electron_config_cache];
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'electron', 'Cache'));
  roots.push(path.join(os.homedir(), 'Library', 'Caches', 'electron'), path.join(os.homedir(), '.cache', 'electron'));
  for (const root of roots.filter(Boolean)) {
    if (!fs.existsSync(root)) continue;
    if (fs.existsSync(path.join(root, name))) return root;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(root, entry.name, name))) return path.join(root, entry.name);
    }
  }
}

function brandedEntrySource(applicationDirectory, sourceRoot = ROOT) {
  const relativeRoot = path.relative(applicationDirectory, sourceRoot);
  return `const fs = require('node:fs');
const path = require('node:path');
const root = process.env[${JSON.stringify(appIdentity.sourceRootEnv)}] || path.resolve(__dirname, ${JSON.stringify(relativeRoot)});
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.name !== 'ensoul') throw new Error('ensoul 源码目录无效。');
process.env[${JSON.stringify(appIdentity.sourceRootEnv)}] = root;
require(path.join(root, pkg.main));
`;
}

async function prepareBrandedRuntime() {
  const target = plan();
  const ready = path.join(target.output, 'ready.json');
  if (fs.existsSync(target.exe) && fs.existsSync(ready)) return target.exe;
  let packager;
  try { packager = require(process.env.ENSOUL_PACKAGER_MODULE || '@electron/packager'); }
  catch { throw new Error('缺少应用命名工具 @electron/packager，请运行安装入口更新依赖。'); }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-brand-shell-'));
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'ensoul', productName: 'ensoul', author: target.pkg.author || 'ensoul', version: target.pkg.version, main: 'index.js' }));
  const applicationDirectory = process.platform === 'darwin'
    ? path.join(path.dirname(path.dirname(target.exe)), 'Resources', 'app')
    : path.join(path.dirname(target.exe), 'resources', 'app');
  fs.writeFileSync(path.join(stage, 'index.js'), brandedEntrySource(applicationDirectory));
  console.log('[应用身份] 准备 ensoul 应用壳与系统图标（首次生成，随后复用）…');
  process.env.ELECTRON_GET_USE_PROXY ||= '1';
  process.env.GLOBAL_AGENT_HTTP_PROXY ||= process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7897';
  try {
    await packager({
      dir: stage, name: 'ensoul', executableName: 'ensoul',
      platform: process.platform, arch: process.arch,
      electronVersion: target.version, electronZipDir: cachedZip(target.version),
      out: target.output, overwrite: true, asar: false, prune: false,
      icon: target.icon, appVersion: target.pkg.version,
      appBundleId: appIdentity.appId, helperBundleId: `${appIdentity.appId}.helper`,
      appCategoryType: 'public.app-category.productivity',
      win32metadata: { ProductName: 'ensoul', FileDescription: 'ensoul', InternalName: 'ensoul', OriginalFilename: 'ensoul.exe' },
      extendInfo: { CFBundleDisplayName: 'ensoul', CFBundleName: 'ensoul' },
      osxSign: process.platform === 'darwin' ? { identity: '-', hardenedRuntime: false, preAutoEntitlements: false } : undefined,
    });
    if (!fs.existsSync(target.exe)) throw new Error('应用壳生成后找不到 ensoul 可执行文件。');
    fs.writeFileSync(ready, JSON.stringify({ electron: target.version, executable: target.exe, app: 'ensoul' }) + '\n');
    return target.exe;
  } finally {
    const tempParent = path.resolve(os.tmpdir());
    if (path.dirname(stage) === tempParent && path.basename(stage).startsWith('ensoul-brand-shell-')) fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = { prepareBrandedRuntime, brandedExecutable: () => plan().exe, brandedEntrySource };
if (require.main === module) prepareBrandedRuntime().then((exe) => console.log(`[应用身份] ${exe}`)).catch((error) => { console.error(`[应用身份] ${error.message}`); process.exitCode = 1; });
