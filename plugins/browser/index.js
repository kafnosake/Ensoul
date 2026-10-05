/**
 * 浏览器 —— 面板里开一个真网页。
 *
 * 为什么不是 iframe：大多数网站会拒绝被 iframe 嵌（X-Frame-Options / CSP），
 * 直接白屏。这里用 Electron 自带的 <webview>（真 Chromium 内核），零新依赖 ——
 * 主进程把 webviewTag 打开（src/main/windows.ts），脸里就能渲染它。
 *
 * 站内 target=_blank / window.open 默认会被 webview 拦死（点了没反应），
 * 开 allowpopups 又会甩出脱离面板体系的独立窗口。所以在这儿接管：
 * 新窗口请求一律改成"在面板内部导航"，浏览器行为就完整了，也不必开 allowpopups。
 */

let app = null;
try {
  app = (require('electron') || {}).app || null;
} catch {
  app = null;
}

/** dispose 要能收掉它：插件文件一改会重装，旧的监听不能留着 */
let onCreated = null;

function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (s.startsWith('//')) return `https:${s}`;
  if (s.startsWith('localhost') || s.startsWith('127.0.0.1') || /^192\.168\./.test(s) || /^10\./.test(s)) {
    return `http://${s}`;
  }
  return `https://${s}`;
}

module.exports = {
  name: 'browser',
  description: t('浏览器：面板里开真实网页（Electron webview），地址栏与前进后退长在脸上，地址存在面板自己的 spec 里'),

  panel: {
    kind: 'browser',
    label: t('浏览器'),
    hint: t('真实浏览器内核，什么站都能开'),
    title: t('浏览器'),
    body: 'web',
    text: '',
  },

  setup(api) {
    // 跨面板工具调用：允许其他会话面板/AI 员工直接在浏览器中打开网址
    if (api && typeof api.addTool === 'function') {
      api.addTool(
        {
          name: 'browser_open', kits: ['ui'],
          description:
            t('在内置浏览器面板中打开指定网址（支持在现有浏览器面板中跳转，或新建浏览器面板）。其他智能体/面板需要展示网页、查看前端、阅读文档时调用。'),
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string', description: t('要访问的网址，例如 https://github.com 或 http://localhost:5173') },
              title: { type: 'string', description: t('浏览器面板标题（可选）') },
              new_panel: { type: 'boolean', description: t('是否新建独立浏览器面板（默认 false，优先复用现有浏览器面板）') },
            },
            required: ['url'],
          },
          level: 'write',
        },
        async (args, ctx) => {
          const url = normalizeUrl(args && args.url);
          if (!url) return t('打开失败：未提供有效网址。');
          const title = (args && args.title) || '';
          const newPanel = Boolean(args && args.new_panel);
          const panels = (typeof api.panels === 'function' ? api.panels() : []) || [];
          const existing = !newPanel ? panels.find((p) => p.kind === 'browser') : null;
          if (existing) {
            api.patchPanel(existing.id, {
              spec: { ...existing.spec, text: url },
              ...(title ? { title } : {}),
            });
            if (typeof api.showPanel === 'function') api.showPanel(existing.id);
            return `已在浏览器面板「${title || existing.title || '浏览器'}」(${existing.id}) 中打开网址：${url}`;
          }
          if (typeof api.createPanel === 'function') {
            const created = api.createPanel({
              kind: 'browser',
              title: title || t('浏览器'),
              spec: { body: 'messages', text: url, actions: [], fields: [], systemPrompt: '' },
            });
            return `已新建浏览器面板「${created.title}」(${created.id}) 并打开网址：${url}`;
          }
          return t('打开失败：主程序不支持动态创建面板');
        },
      );
    }

    // 斜杠命令：在任何输入框中敲 /browser <url> 即可唤起打开
    if (api && typeof api.addCommand === 'function') {
      api.addCommand(
        { id: 'browser', label: t('在浏览器打开'), hint: t('/browser <网址>') },
        async (args, ctx) => {
          const url = normalizeUrl(args);
          if (!url) return t('用法：/browser <网址>');
          const panels = (typeof api.panels === 'function' ? api.panels() : []) || [];
          const existing = panels.find((p) => p.kind === 'browser');
          if (existing) {
            api.patchPanel(existing.id, {
              spec: { ...existing.spec, text: url },
            });
            if (typeof api.showPanel === 'function') api.showPanel(existing.id);
            return `已在浏览器面板「${existing.title}」打开：${url}`;
          }
          if (typeof api.createPanel === 'function') {
            const created = api.createPanel({
              kind: 'browser',
              title: t('浏览器'),
              spec: { body: 'messages', text: url, actions: [], fields: [], systemPrompt: '' },
            });
            return `已新建浏览器面板并打开：${url}`;
          }
          return t('打开失败：环境不支持创建面板');
        },
      );
    }

    // 纯 node 测试环境里没有真的 electron：app 可能是残缺替身，没有 on 就没钩子可挂
    if (!app || typeof app.on !== 'function') return;
    onCreated = (_evt, wc) => {
      let isWebview = false;
      try {
        isWebview = wc.getType() === 'webview';
      } catch {
        return;
      }
      if (!isWebview) return;
      wc.setWindowOpenHandler(({ url }) => {
        if (url && url !== 'about:blank') {
          try {
            void wc.loadURL(url);
          } catch {
            // 导航失败页面自己会报，别让它把窗口打开流程搅了
          }
        }
        return { action: 'deny' };
      });
    };
    app.on('web-contents-created', onCreated);
  },

  dispose() {
    if (app && onCreated && typeof app.removeListener === 'function') {
      app.removeListener('web-contents-created', onCreated);
    }
    onCreated = null;
  },
};
