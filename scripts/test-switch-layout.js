const fs = require('node:fs');
const path = require('node:path');

if (process.versions.electron) {
  const { app, BrowserWindow } = require('electron');
  const [htmlFile, outputFile, profile] = process.argv.slice(2);
  app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, width: 800, height: 600,
      webPreferences: { offscreen: true, contextIsolation: true, sandbox: true } });
    await window.loadFile(htmlFile);
    const debuggerApi = window.webContents.debugger;
    debuggerApi.attach('1.3');
    await debuggerApi.sendCommand('DOM.enable');
    await debuggerApi.sendCommand('CSS.enable');
    const measurements = [];
    for (const theme of ['light', 'dark']) {
      for (const context of ['ext-row', 'plg-head', 'set-frow']) {
        for (const on of [false, true]) {
          for (const disabled of [false, true]) {
            await window.webContents.executeJavaScript(`
              document.documentElement.dataset.theme = ${JSON.stringify(theme)};
              document.querySelector('.set-body').innerHTML = '<div class="${context}"><span>设置项</span><button id="toggle" class="fx-switch${on ? ' is-on' : ''}" ${disabled ? 'disabled' : ''}><i></i></button></div>';
            `);
            const { root } = await debuggerApi.sendCommand('DOM.getDocument');
            const { nodeId } = await debuggerApi.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#toggle' });
            for (const hover of [false, true]) {
              await debuggerApi.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: hover ? ['hover'] : [] });
              const measurement = await window.webContents.executeJavaScript(`(() => {
                const button = document.querySelector('#toggle');
                const knob = button.querySelector('i');
                const track = button.getBoundingClientRect();
                const dot = knob.getBoundingClientRect();
                const style = getComputedStyle(button);
                const probe = document.createElement('span');
                probe.style.color = 'var(--accent)';
                button.after(probe);
                const accent = getComputedStyle(probe).color;
                probe.remove();
                return { track: { x: track.x, y: track.y, width: track.width, height: track.height },
                  dot: { x: dot.x, y: dot.y, width: dot.width, height: dot.height },
                  padding: style.padding, background: style.backgroundColor, accent,
                  knobColor: getComputedStyle(knob).backgroundColor, pixelRatio: window.devicePixelRatio };
              })()`);
              measurements.push({ theme, context, on, disabled, hover, ...measurement });
            }
          }
        }
      }
    }
    fs.writeFileSync(outputFile, JSON.stringify(measurements));
    window.destroy();
    app.quit();
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const os = require('node:os');
  const { pathToFileURL } = require('node:url');
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const run = promisify(execFile);
  const repository = path.resolve(__dirname, '..');
  const electron = process.platform === 'win32' ? path.join(repository, '.electron/win32-x64/electron.exe')
    : process.platform === 'darwin' ? path.join(repository, `.electron/darwin-${process.arch}/Electron.app/Contents/MacOS/Electron`)
      : path.join(repository, `.electron/${process.platform}-${process.arch}/electron`);

  test('实际 Chromium 排版中，共用开关在两种主题和各设置行保持旋钮左右对齐', { timeout: 30000 }, async t => {
    assert.ok(fs.existsSync(electron), '需要已安装的平台 Electron，测试不会安装依赖');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-switch-layout-'));
    t.after(() => {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('ensoul-switch-layout-'));
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const htmlFile = path.join(directory, 'fixture.html');
    const outputFile = path.join(directory, 'layout.json');
    const profile = path.join(directory, 'profile');
    fs.mkdirSync(profile);
    const stylesheet = pathToFileURL(path.join(repository, 'src/renderer/ui/styles.css')).href;
    fs.writeFileSync(htmlFile, `<html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="${stylesheet}"><style>*{transition:none!important;animation:none!important}</style></head><body><div class="settings"><div class="set-nav"></div><div class="set-body"></div></div></body></html>`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await run(electron, [__filename, htmlFile, outputFile, profile], { env, windowsHide: true, timeout: 25000 });
    const measurements = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    assert.equal(measurements.length, 48);
    for (const value of measurements) {
      const { track, dot } = value;
      const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= .5 / value.pixelRatio + .02, `${message}：实际 ${actual}，预期 ${expected}`);
      const label = `${value.theme}/${value.context}/${value.on ? '开' : '关'}/${value.disabled ? '禁用' : '可用'}/${value.hover ? '悬停' : '普通'}`;
      close(track.width, 34, `${label}轨道宽度`);
      close(track.height, 19, `${label}轨道高度`);
      close(dot.width, 13, `${label}旋钮直径`);
      close(dot.height, 13, `${label}旋钮高度`);
      close(dot.y + dot.height / 2, track.y + track.height / 2, `${label}垂直居中`);
      close(value.on ? track.x + track.width - dot.x - dot.width : dot.x - track.x, 3, `${label}旋钮距外边缘`);
      assert.ok(dot.x >= track.x + 1 && dot.x + dot.width <= track.x + track.width - 1, `${label}旋钮应在轨道内`);
      if (value.on) { assert.equal(value.background, value.accent, `${label}轨道应保持开启颜色`); assert.equal(value.knobColor, 'rgb(255, 255, 255)'); }
    }
    console.log(`已验证 ${measurements.length} 组真实排版：旋钮直径 13px，左右终点距外边缘 3px。`);
  });
}
