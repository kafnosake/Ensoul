const fs = require('node:fs');
const path = require('node:path');

if (process.versions.electron) {
  const { app, BrowserWindow, session } = require('electron');
  const [htmlFile, outputFile, profile, screenshotDirectory] = process.argv.slice(2);
  app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    let blockedRequests = 0;
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
      blockedRequests++;
      callback({ cancel: true });
    });
    const window = new BrowserWindow({ show: false, width: 1280, height: 900,
      webPreferences: { offscreen: true, contextIsolation: true, sandbox: true } });
    const evaluate = source => window.webContents.executeJavaScript(source);
    const pause = duration => new Promise(resolve => setTimeout(resolve, duration));
    const waitFor = async (label, source) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (await evaluate(source)) return;
        await pause(25);
      }
      throw new Error(`等待超时：${label}`);
    };
    const clickPage = label => evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('.set-nav-item')).find(item => item.querySelector('.set-nav-label')?.textContent === ${JSON.stringify(label)});
      if (!button) throw new Error('没有找到设置分区');
      button.click();
    })()`);
    const measure = () => evaluate(`(() => {
      const body = document.querySelector('.set-body');
      const bounds = body.getBoundingClientRect();
      const items = Array.from(body.querySelectorAll('.ext-row, .more-card-item, .more-input-field, .more-action-btn')).map(item => {
        const box = item.getBoundingClientRect();
        return { text: item.textContent.trim().slice(0, 60), left: box.left, right: box.right, width: box.width };
      });
      return { page: body.dataset.page, viewport: innerWidth, clientWidth: body.clientWidth, scrollWidth: body.scrollWidth,
        left: bounds.left, right: bounds.right, outside: items.filter(item => item.left < bounds.left - 1 || item.right > bounds.right + 1) };
    })()`);
    try {
      await window.loadFile(htmlFile);
      await waitFor('完整设置页导航', 'document.querySelectorAll(".set-nav-item").length >= 10');
      const navigation = await evaluate('Array.from(document.querySelectorAll(".set-nav-label")).map(item => item.textContent)');
      await clickPage('更多');
      await waitFor('更多里的模型下载卡片', 'document.querySelector(".set-body").dataset.page === "more" && Array.from(document.querySelectorAll(".more-section-title")).some(item => item.textContent === "EmbeddingGemma 2") && document.body.innerText.includes("一键配置")');
      await waitFor('全局语义搜索解释器可见', 'document.querySelector(".set-body").innerText.includes("语义搜索 Python")');
      const moreText = await evaluate('document.querySelector(".set-body").innerText');
      const moreReads = await evaluate('window.settingsFixture.reads');
      await clickPage('语义搜索');
      await waitFor('运行设备下拉', 'Boolean(document.querySelector("select[aria-label=运行设备]"))');
      const chooseDevice = value => evaluate(`(() => {
        const select = document.querySelector('select[aria-label=运行设备]');
        select.value = ${JSON.stringify(value)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await chooseDevice('cuda');
      await waitFor('CUDA 选择已保存', 'document.querySelector("select[aria-label=运行设备]").value === "cuda" && !document.querySelector("select[aria-label=运行设备]").disabled');
      await clickPage('更多');
      await clickPage('语义搜索');
      await waitFor('再次打开保留 CUDA', 'document.querySelector("select[aria-label=运行设备]")?.value === "cuda"');
      await evaluate('window.settingsFixture.failNextAction = true');
      await chooseDevice('cpu');
      await waitFor('保存失败可见且控件恢复', 'document.querySelector("[role=alert]")?.textContent.includes("测试保存失败") && !document.querySelector("select[aria-label=运行设备]").disabled');
      const failedValue = await evaluate('document.querySelector("select[aria-label=运行设备]").value');
      await chooseDevice('cpu');
      await waitFor('失败后仍能保存 CPU', 'document.querySelector("select[aria-label=运行设备]").value === "cpu" && !document.querySelector("[role=alert]")');
      const savedActions = await evaluate('window.settingsFixture.actions');
      await clickPage('更多');
      await waitFor('显示模型下载卡片', 'document.body.innerText.includes("一键配置")');
      await window.webContents.capturePage().then(image => fs.writeFileSync(path.join(screenshotDirectory, 'settings-dialog-more.png'), image.toPNG()));
      const layouts = [];
      for (const [width, zoom] of [[920, 1], [1280, 1], [1600, 1], [1600, 1.65]]) {
        window.setSize(width, 1000);
        window.webContents.setZoomFactor(zoom);
        await pause(75);
        await clickPage('语义搜索');
        await waitFor('语义搜索功能行', 'document.querySelector(".set-body").dataset.page === "plugin:semantic-search:semantic-search" && document.querySelectorAll(".fx-switch").length >= 13');
        await pause(100);
        layouts.push({ width, zoom, ...await measure() });
        if (width === 1600 && zoom === 1.65) {
          await window.webContents.capturePage().then(image => fs.writeFileSync(path.join(screenshotDirectory, 'settings-dialog-semantic.png'), image.toPNG()));
        }
        await clickPage('更多');
        await waitFor('再次显示模型下载卡片', 'document.querySelector(".set-body").dataset.page === "more" && Array.from(document.querySelectorAll(".more-section-title")).some(item => item.textContent === "EmbeddingGemma 2") && document.body.innerText.includes("一键配置")');
        await pause(100);
        layouts.push({ width, zoom, ...await measure() });
      }
      fs.writeFileSync(outputFile, JSON.stringify({ navigation, moreText, moreReads, layouts, blockedRequests, savedActions, failedValue,
        errors: await evaluate('window.settingsFixture.errors') }, null, 2));
      window.destroy();
      app.quit();
    } catch (error) {
      window.destroy();
      throw error;
    }
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const os = require('node:os');
  const vm = require('node:vm');
  const ts = require('typescript');
  const { pathToFileURL } = require('node:url');
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const run = promisify(execFile);
  const repository = path.resolve(__dirname, '..');
  const electron = process.platform === 'win32' ? path.join(repository, '.electron/win32-x64/electron.exe')
    : process.platform === 'darwin' ? path.join(repository, `.electron/darwin-${process.arch}/Electron.app/Contents/MacOS/Electron`)
      : path.join(repository, `.electron/${process.platform}-${process.arch}/electron`);
  const clone = value => JSON.parse(JSON.stringify(value));

  async function registeredFixture(workspace) {
    const hostFile = path.join(repository, 'src/main/plugins.ts');
    const hostSource = ts.createSourceFile(hostFile, fs.readFileSync(hostFile, 'utf8'), ts.ScriptTarget.Latest, true);
    let registration, serialization;
    const visit = node => {
      if (ts.isMethodDeclaration(node) && node.name.getText(hostSource) === 'addSettingsSection' && node.body) registration = node.getText(hostSource);
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'settingsSections') serialization = node.getText(hostSource);
      ts.forEachChild(node, visit);
    };
    visit(hostSource);
    assert.ok(registration && serialization, '必须使用实际宿主注册和输出函数');
    const instances = new Map();
    const context = vm.createContext({ module: { exports: {} }, exports: {}, instances,
      loadPlugins() {}, store: { disabledPlugins: () => [] } });
    context.exports = context.module.exports;
    const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInContext(transpile(serialization), context, { filename: hostFile });
    const register = (name, declarations) => {
      const inst = { name, info: { enabled: true }, sections: [] };
      context.inst = inst;
      const host = vm.runInContext(transpile(`({${registration}})`), context, { filename: hostFile });
      for (const declaration of declarations) host.addSettingsSection(declaration);
      instances.set(name, inst);
      return inst;
    };

    const pluginFile = path.join(repository, 'plugins/semantic-search/index.js');
    const sections = [];
    const module = { exports: {} };
    const dependencies = {
      './runtime': {}, './engine': {}, './corpus': {}, './extract': {}, './analytics': {},
      electron: { app: { getPath: () => workspace } },
    };
    vm.runInNewContext(fs.readFileSync(pluginFile, 'utf8'), { module, exports: module.exports, __dirname: path.dirname(pluginFile), process, AbortController,
      require: Object.assign(name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name), { cache: {}, resolve: name => path.resolve(path.dirname(pluginFile), name) }),
      setInterval: () => ({ unref() {} }), clearInterval() {},
    }, { filename: pluginFile });
    const plugin = module.exports;
    try {
      plugin.setup({ workspace, t: text => text, state: { load: () => ({}), save: () => true },
        panels: () => [], addSettingsSection: section => sections.push(section), addTool() {}, addPrompt() {}, addCommand() {}, log() {} });
      register('semantic-search', sections);
      register('agent', [{ id: 'agents', label: 'agent', view: () => ({ rows: [] }) }]);
      register('desktop-widgets', [{ id: 'widgets', label: '桌面组件', after: 'model', view: () => ({ rows: [] }) }]);
      register('mcp', [{ id: 'mcp-servers', label: 'MCP 服务', view: () => ({ rows: [] }) }]);
      const refs = clone(await context.module.exports.settingsSections());
      const views = Object.fromEntries(Array.from(instances.values()).flatMap(inst => inst.sections.map(section => [`${inst.name}:${section.id}`, clone(section.view())])));
      return { refs, views };
    } finally {
      plugin.dispose();
    }
  }

  test('实际宿主契约与完整设置弹层：更多下载、MCP 下方语义搜索和内容宽度', { timeout: 45000 }, async t => {
    assert.ok(fs.existsSync(electron), '需要已有的平台 Electron，测试不会安装依赖');
    const esbuild = require('esbuild');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-settings-dialog-'));
    t.after(() => {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('ensoul-settings-dialog-'));
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const workspace = path.join(directory, 'workspace');
    fs.mkdirSync(workspace);
    const registered = await registeredFixture(workspace);
    const fixture = { ...registered, reads: [], errors: [], actions: [] };
    const htmlFile = path.join(directory, 'fixture.html');
    const bundleFile = path.join(directory, 'fixture.js');
    const outputFile = path.join(directory, 'result.json');
    const profile = path.join(directory, 'profile');
    fs.mkdirSync(profile);
    const screenshotDirectory = path.join(repository, '.ensoul/tmp');
    fs.mkdirSync(screenshotDirectory, { recursive: true });
    fs.writeFileSync(htmlFile, `<!doctype html><html data-theme="light"><head><meta charset="utf-8">
      <link rel="stylesheet" href="${pathToFileURL(path.join(repository, 'src/renderer/ui/styles.css')).href}">
      <style>*{animation:none!important;transition:none!important}</style></head><body><div id="fixture"></div>
      <script>localStorage.setItem('ensoul.theme','light');localStorage.setItem('ensoul.lang','zh');
      window.settingsFixture=${JSON.stringify(fixture)};
      window.addEventListener('error', event => window.settingsFixture.errors.push(event.message));
      window.addEventListener('unhandledrejection', event => window.settingsFixture.errors.push(String(event.reason)));
      const noSubscription = () => () => {};
      window.ensoul={
        settings:{get:async()=>({workspace:${JSON.stringify(workspace)},configPath:'fixture.json',model:{},providers:[]})},
        ext:{list:async()=>({plugins:[],skills:[]}),sections:async()=>structuredClone(window.settingsFixture.refs),
          section:async(plugin,section)=>{window.settingsFixture.reads.push({plugin,section});return structuredClone(window.settingsFixture.views[plugin+':'+section]||{rows:[]})},
          sectionAction:async(plugin,section,action,row)=>{
            if(window.settingsFixture.failNextAction){window.settingsFixture.failNextAction=false;throw Error('测试保存失败')}
            window.settingsFixture.actions.push({plugin,section,action,row});
            const view=window.settingsFixture.views[plugin+':'+section];
            view.rows.find(item=>item.id===row).value=action.slice(action.indexOf(':')+1);
            return {ok:true,view:structuredClone(view)};
          }},
        components:{list:async()=>[],where:async()=>({bodyDir:'',bodyCount:0,craftDir:'',craftCount:0})},
        workspace:{self:async()=>({dir:${JSON.stringify(workspace)},workspace:${JSON.stringify(workspace)}}),get:async()=>({panels:{}})},
        closed:{list:async()=>[]},env:{get:async()=>({activePythonId:'system',pythons:[{id:'system',name:'系统默认 Python',path:'python'},{id:'semantic-search',name:'语义搜索 Python',path:'global/env/semantic-search/python',version:'Python 3.12',available:true}]}),detect:async()=>null,listOrphans:async()=>[]},
        ui:{getZoom:async()=>1,onZoom:noSubscription,onLang:noSubscription}
      };</script><script src="${pathToFileURL(bundleFile).href}"></script></body></html>`);
    await esbuild.build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';
      import {SettingsDialog} from './src/renderer/shell/SettingsDialog';createRoot(document.querySelector('#fixture')).render(<SettingsDialog onClose={()=>{}}/>);`,
      resolveDir: repository, loader: 'tsx', sourcefile: 'settings-dialog-fixture.tsx' },
      bundle: true, platform: 'browser', format: 'iife', outfile: bundleFile,
      define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
      plugins: [{ name: 'fixture-registry', setup(build) {
        build.onResolve({ filter: /^\.\.\/panel\/registry$/ }, () => ({ path: 'registry', namespace: 'fixture-registry' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture-registry' }, () => ({ contents: `export function panelType(){return {label:'测试组件'};}`, loader: 'js' }));
      } }],
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await run(electron, [__filename, htmlFile, outputFile, profile, screenshotDirectory], { env, windowsHide: true, timeout: 30000 });
    const result = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    await t.test('下载声明通过实际宿主传递并只在更多中显示', () => {
      assert.equal(registered.refs.find(section => section.id === 'model-download').placement, 'more');
      assert.equal(result.navigation.includes('EmbeddingGemma 2'), false, '下载资源不能独占侧栏');
      assert.match(result.moreText, /EmbeddingGemma 2/);
      assert.match(result.moreText, /一键配置/);
      assert.match(result.moreText, /语义搜索 Python/);
      assert.match(result.moreText, /global\/env\/semantic-search\/python/);
      assert.doesNotMatch(result.moreText, /安装运行环境|Python 路径|模型路径|下载代理/);
      assert.ok(result.moreReads.some(read => read.plugin === 'semantic-search' && read.section === 'model-download'));
    });
    await t.test('语义搜索在 MCP 服务正下方，与注册顺序无关', () => {
      const index = result.navigation.indexOf('MCP 服务');
      assert.ok(index >= 0);
      assert.equal(result.navigation[index + 1], '语义搜索');
    });
    await t.test('设备下拉即时提交，再进页面保留值，保存失败显示错误且可以重试', () => {
      assert.deepEqual(result.savedActions.map(action => action.action), ['configure:cuda', 'configure:cpu']);
      assert.ok(result.savedActions.every(action => action.row === 'device' && action.plugin === 'semantic-search'));
      assert.equal(result.failedValue, 'cuda');
    });
    await t.test('两种页面在三种窗口宽度及 165% 缩放下没有横向溢出', () => {
      assert.equal(result.layouts.length, 8);
      const failures = result.layouts.filter(layout => layout.scrollWidth > layout.clientWidth + 1 || layout.outside.length);
      assert.deepEqual(failures, [], `设置内容横向越界：${JSON.stringify(failures, null, 2)}`);
      assert.equal(result.blockedRequests, 0);
      assert.deepEqual(result.errors, []);
    });
    console.log(`完整设置页截图：${path.join(screenshotDirectory, 'settings-dialog-more.png')}；${path.join(screenshotDirectory, 'settings-dialog-semantic.png')}`);
  });
}
