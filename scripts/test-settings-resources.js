const fs = require('node:fs');
const path = require('node:path');

if (process.versions.electron) {
  const { app, BrowserWindow, session } = require('electron');
  const [htmlFile, outputFile, profile, screenshotFile] = process.argv.slice(2);
  app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    let blockedRequests = 0;
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
      ++blockedRequests;
      callback({ cancel: true });
    });
    const window = new BrowserWindow({ show: false, width: 920, height: 760,
      webPreferences: { offscreen: true, contextIsolation: true, sandbox: true } });
    const evaluate = (source) => window.webContents.executeJavaScript(source);
    const pause = (duration) => new Promise((resolve) => setTimeout(resolve, duration));
    const waitFor = async (label, source) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (await evaluate(source)) return;
        await pause(25);
      }
      throw new Error(`等待超时：${label}`);
    };
    const setInput = async (value) => {
      await evaluate(`(() => {
        const input = document.querySelector('input[aria-label="模型下载来源"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await pause(25);
    };
    const click = (label) => evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('.more-action-btn')).find((item) => item.textContent === ${JSON.stringify(label)});
      if (!button) throw new Error('找不到动作按钮');
      button.click();
    })()`);
    const settleAction = () => evaluate(`window.resourceFixture.completeAction()`);
    try {
      await window.loadFile(htmlFile);
      await waitFor('首次渲染资源视图', 'window.resourceFixture.reads.length > 0 && document.querySelectorAll(".more-card-item").length === 2');
      await pause(50);
      const initial = await evaluate(`({ text: document.body.innerText, reads: window.resourceFixture.reads })`);
      fs.writeFileSync(screenshotFile, (await window.webContents.capturePage()).toPNG());

      const draft = 'https://cache.example.invalid/models';
      await setInput(draft);
      const beforeDraftPoll = await evaluate(`(() => {
        window.resourceFixture.view.rows[1].value = 'https://server.example.invalid/changed';
        return window.resourceFixture.reads.length;
      })()`);
      await waitFor('后台轮询更新', `window.resourceFixture.reads.length > ${beforeDraftPoll}`);
      await pause(50);
      const draftAfterPoll = await evaluate('document.querySelector("input").value');

      await click('保存');
      await waitFor('文本动作进入 busy', 'window.resourceFixture.actions.length === 1 && Array.from(document.querySelectorAll(".more-action-btn")).every((item) => item.disabled)');
      const textCall = await evaluate('window.resourceFixture.actions[0]');
      await settleAction();
      await waitFor('文本动作解除 busy', 'Array.from(document.querySelectorAll(".more-action-btn")).every((item) => !item.disabled)');

      await setInput('');
      await click('保存');
      await waitFor('空输入动作', 'window.resourceFixture.actions.length === 2 && Boolean(window.resourceFixture.completeAction)');
      const emptyCall = await evaluate('window.resourceFixture.actions[1]');
      await settleAction();
      await waitFor('空输入动作解除 busy', 'Array.from(document.querySelectorAll(".more-action-btn")).every((item) => !item.disabled)');

      await click('下载');
      await waitFor('下载动作', 'window.resourceFixture.actions.length === 3 && Boolean(window.resourceFixture.completeAction)');
      const downloadCall = await evaluate('window.resourceFixture.actions[2]');
      await settleAction();
      await waitFor('下载动作回执', 'document.body.innerText.includes("已开始处理") && Array.from(document.querySelectorAll(".more-action-btn")).every((item) => !item.disabled)');
      const beforeReplyPoll = await evaluate(`(() => {
        window.resourceFixture.view.reply = '模型下载完成（测试回执）';
        window.resourceFixture.view.rows[0].meta = '已下载';
        return window.resourceFixture.reads.length;
      })()`);
      await waitFor('后台完成回执', `window.resourceFixture.reads.length > ${beforeReplyPoll} && document.body.innerText.includes('模型下载完成（测试回执）')`);
      const replyText = await evaluate('document.body.innerText');

      await evaluate('window.resourceFixture.nextError = true');
      await click('检查');
      await waitFor('动作失败显示原因并解除 busy', 'document.querySelector("[role=alert]")?.textContent.includes("fixture action failure") && Array.from(document.querySelectorAll(".more-action-btn")).every((item) => !item.disabled)');
      const failure = await evaluate(`({ error: document.querySelector('[role=alert]').textContent, busy: Array.from(document.querySelectorAll('.more-action-btn')).some((item) => item.disabled) })`);

      const readsBeforeUnmount = await evaluate(`(() => {
        window.resourceFixture.root.unmount();
        return window.resourceFixture.reads.length;
      })()`);
      await pause(2300);
      const readsAfterUnmount = await evaluate('window.resourceFixture.reads.length');
      fs.writeFileSync(outputFile, JSON.stringify({ initial, draft, draftAfterPoll, textCall, emptyCall, downloadCall,
        replyText, failure, readsBeforeUnmount, readsAfterUnmount, blockedRequests, screenshotFile }));
      window.destroy();
      app.quit();
    } catch (error) {
      window.destroy();
      throw error;
    }
  }).catch((error) => { console.error(error); app.exit(1); });
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

  test('更多资源入口实际渲染、轮询保留草稿、准确提交动作并停止后台更新', { timeout: 30000 }, async (t) => {
    assert.ok(fs.existsSync(electron), '需要已有的平台 Electron，测试不会安装依赖');
    const esbuild = require('esbuild');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-settings-resources-'));
    t.after(() => {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('ensoul-settings-resources-'));
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const htmlFile = path.join(directory, 'fixture.html');
    const bundleFile = path.join(directory, 'fixture.js');
    const outputFile = path.join(directory, 'result.json');
    const profile = path.join(directory, 'profile');
    fs.mkdirSync(profile);
    const screenshotFile = path.join(repository, '.ensoul/tmp/settings-resources-preview.png');
    fs.mkdirSync(path.dirname(screenshotFile), { recursive: true });
    const stylesheet = pathToFileURL(path.join(repository, 'src/renderer/ui/styles.css')).href;
    const fixture = {
      view: {
        note: '模型保存在本机数据目录；源码仓库只保留下载入口。下载完成后，在“语义搜索”分区启用所需能力。',
        rows: [
          { id: 'model', title: '本地语义模型', desc: '下载模型文件、检查本地资源。此页使用隔离测试数据，不会下载真实模型。', meta: '尚未下载',
            actions: [{ id: 'download', label: '下载' }, { id: 'check', label: '检查' }] },
          { id: 'source', role: 'control', title: '模型下载来源', desc: '填写可用的下载来源；留空使用默认来源。', inline: 'text', value: 'https://model.example.invalid',
            placeholder: '留空使用默认来源', actions: [{ id: 'save', label: '保存' }] },
        ],
      },
      reads: [], actions: [], nextError: false,
    };
    fs.writeFileSync(htmlFile, `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="${stylesheet}">
      <style>html,body{height:100%;overflow:hidden}.settings{height:100%;padding:20px;box-sizing:border-box}*{transition:none!important;animation:none!important}</style>
      </head><body><div class="settings"><nav class="set-nav"><button class="set-nav-item">模型</button><button class="set-nav-item">MCP 服务</button><button class="set-nav-item">语义搜索</button><button class="set-nav-item is-on">更多</button></nav>
      <div class="set-body"><section class="set-block"><div class="set-title">扩展生态与运行环境</div><div class="set-note">按需下载本地资源，并管理相关配置。</div><div id="resources"></div></section></div></div>
      <script>window.resourceFixture = ${JSON.stringify(fixture)};
      window.ensoul = { ui: {}, ext: {
        section: async (plugin, section) => {
          window.resourceFixture.reads.push({ plugin, section });
          return structuredClone(window.resourceFixture.view);
        },
        sectionAction: async (plugin, section, actionId, rowId) => {
          const fixture = window.resourceFixture;
          fixture.actions.push({ plugin, section, actionId, rowId });
          if (fixture.nextError) { fixture.nextError = false; throw new Error('fixture action failure'); }
          return new Promise((resolve) => {
            fixture.completeAction = () => {
              if (rowId === 'source') fixture.view.rows[1].value = actionId.slice('save:'.length);
              fixture.view.reply = rowId === 'model' ? '已开始处理' : '配置已保存';
              fixture.completeAction = null;
              resolve({ ok: true, reply: fixture.view.reply, view: structuredClone(fixture.view) });
            };
          });
        }
      }};</script><script src="${pathToFileURL(bundleFile).href}"></script></body></html>`);
    await esbuild.build({
      stdin: { contents: `import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { PluginResources } from './src/renderer/shell/PluginResources';
        const root = createRoot(document.querySelector('#resources'));
        window.resourceFixture.root = root;
        root.render(<PluginResources sections={[{ plugin: 'fixture-resources', id: 'downloads', label: '语义模型与运行环境', hint: '可选下载，按需启用。', count: 2 }]} />);`,
      resolveDir: repository, loader: 'tsx', sourcefile: 'settings-resources-fixture.tsx' },
      bundle: true, platform: 'browser', format: 'iife', outfile: bundleFile,
      define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await run(electron, [__filename, htmlFile, outputFile, profile, screenshotFile], { env, windowsHide: true, timeout: 25000 });
    const result = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    assert.match(result.initial.text, /语义模型与运行环境/);
    assert.match(result.initial.text, /模型下载来源/);
    assert.deepEqual(result.initial.reads, [{ plugin: 'fixture-resources', section: 'downloads' }]);
    assert.equal(result.draftAfterPoll, result.draft, '后台更新不能覆盖正在编辑的文本');
    assert.deepEqual(result.textCall, { plugin: 'fixture-resources', section: 'downloads', actionId: `save:${result.draft}`, rowId: 'source' });
    assert.deepEqual(result.emptyCall, { plugin: 'fixture-resources', section: 'downloads', actionId: 'save:', rowId: 'source' });
    assert.deepEqual(result.downloadCall, { plugin: 'fixture-resources', section: 'downloads', actionId: 'download', rowId: 'model' });
    assert.match(result.replyText, /模型下载完成（测试回执）/);
    assert.doesNotMatch(result.replyText, /已开始处理/);
    assert.equal(result.failure.error, 'fixture action failure');
    assert.equal(result.failure.busy, false);
    assert.equal(result.readsAfterUnmount, result.readsBeforeUnmount, '卸载后不应继续请求插件视图');
    assert.equal(result.blockedRequests, 0, 'fixture 不应发起真实网络请求');
    assert.ok(fs.existsSync(result.screenshotFile));
    console.log(`已验证实际渲染、文本与普通动作、回执更新、失败清理和卸载停轮询。截图：${result.screenshotFile}`);
  });
}
