/**
 * 浏览器操作 —— 给模型一只手，让它真的能"用"内置浏览器。
 *
 * 为什么单独一个插件而不是塞进 plugins/browser：那个插件管的是"面板怎么开网页"（脸 + 地址栏），
 * 这个管的是"模型怎么操作那个网页"。两件事的宿主不同 —— 脸在渲染进程，操作必须从主进程下手
 * （Electron 的 webContents 只有主进程够得着）。
 *
 * 拿哪一块网页：面板 spec.text 是它现在打开的地址，按地址认领最稳；
 * 认不出（多个浏览器面板 / 刚跳转）就退到"最近创建的那个 webview"。
 *
 * 索引的来路：browser_snapshot 给页面上每个可交互元素打一个 data-ensoul-i 标记，
 * 后面的 click / type 就认这个号。**先 snapshot 再点** —— 页面一刷新标记就没了。
 */

const fs = require('fs');
const path = require('path');

/** 一次注入最多等这么久；页面卡住时不能把这一轮对话一起挂死 */
const EVAL_TIMEOUT = 15000;

function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('localhost') || s.startsWith('127.0.0.1') || /^192\.168\./.test(s) || /^10\./.test(s)) return 'http://' + s;
  return 'https://' + s;
}

/** 快照脚本：给可交互元素编号，并把页面正文一起带回来 */
const SNAP_JS = `(() => {
  const SEL = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[onclick],[contenteditable="true"]';
  const vis = (el) => {
    try {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const st = window.getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
    } catch (e) { return false; }
  };
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const items = [];
  let i = 0;
  for (const el of Array.from(document.querySelectorAll(SEL))) {
    if (i >= 150) break;
    if (!vis(el)) continue;
    el.setAttribute('data-ensoul-i', String(i));
    const tag = el.tagName.toLowerCase();
    const label = clean(
      el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('name') || ''
    ).slice(0, 90);
    items.push({
      i: i,
      tag: tag,
      type: el.getAttribute('type') || '',
      label: label,
      href: el.getAttribute('href') ? String(el.getAttribute('href')).slice(0, 120) : '',
      value: (tag === 'input' || tag === 'textarea') ? String(el.value || '').slice(0, 60) : '',
      checked: (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) ? !!el.checked : undefined,
    });
    i += 1;
  }
  const body = document.body ? document.body.innerText : '';
  return {
    url: location.href,
    title: document.title,
    ready: document.readyState,
    elements: items,
    text: body.replace(/\\n{2,}/g, '\\n').trim().slice(0, 5000),
    textLen: body.length,
    scrollY: Math.round(window.scrollY || 0),
    scrollH: document.body ? Math.round(document.body.scrollHeight) : 0
  };
})()`;

/** 按编号 / 选择器 / 文字找元素 —— 三选一，优先级从高到低 */
function findJs(args, action) {
  const idx = args && args.index;
  const sel = args && args.selector ? String(args.selector) : '';
  const text = args && args.text ? String(args.text) : '';
  return `(() => {
  const idx = ${idx === undefined || idx === null || idx === '' ? 'null' : JSON.stringify(Number(idx))};
  const sel = ${JSON.stringify(sel)};
  const want = ${JSON.stringify(text)};
  let el = null;
  if (idx !== null && !Number.isNaN(idx)) el = document.querySelector('[data-ensoul-i="' + idx + '"]');
  if (!el && sel) { try { el = document.querySelector(sel); } catch (e) { return { ok: false, error: '选择器不合法: ' + sel }; } }
  if (!el && want) {
    const W = want.toLowerCase();
    const pool = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"],[onclick]'));
    el = pool.find((x) => ((x.innerText || x.value || x.getAttribute('aria-label') || x.getAttribute('placeholder') || '')).toLowerCase().includes(W)) || null;
  }
  if (!el) return { ok: false, error: '没找到目标元素（号=' + idx + ' 选择器=' + sel + ' 文字=' + want + '）。先调 browser_snapshot 拿编号。' };
  ${action}
})()`;
}

/** 一个"当前这条路"的选择说明，回给模型看 */
function pickNote(wc, how) {
  let url = '';
  try { url = wc.getURL() || ''; } catch (e) { /* 已销毁 */ }
  return '（' + how + '：' + (url || '未知地址') + '）';
}

module.exports = {
  name: 'browser-control',
  description: t('浏览器操作：给模型一双手，能读页面、点按钮、填表单、截图（配合内置浏览器面板）'),

  setup(api) {
    const workspace = api.workspace || '';

    /** 主进程够得着的那些 webview —— 一个进程里可能开着好几块浏览器面板 */
    const liveWebviews = () => {
      try {
        const { webContents } = require('electron');
        if (!webContents || typeof webContents.getAllWebContents !== 'function') return [];
        return webContents.getAllWebContents().filter((wc) => {
          try {
            return !wc.isDestroyed() && wc.getType() === 'webview';
          } catch (e) {
            return false;
          }
        });
      } catch (e) {
        return [];
      }
    };

    /** 这块工作区里有哪些浏览器面板 */
    const browserPanels = () => {
      let panels = [];
      try { panels = api.panels() || []; } catch (e) { panels = []; }
      return panels.filter((p) => p && p.kind === 'browser');
    };

    /**
     * 把浏览器面板叫回前台。
     *
     * 为什么必须做这一步：浏览器面板**不在当前选中的标签页里**时，渲染层会把它那块
     * webview 卸掉，主进程这一刻 getAllWebContents 就看不见它了 —— 于是"同一个页面，
     * 上一秒能读、这一秒说没有"。实测就是这么跳的。
     * 人遇到这情况会点一下那块标签，这里做的就是同一件事。
     */
    const wake = async (args) => {
      const brows = browserPanels();
      if (!brows.length) return false;
      const want = normalizeUrl((args && args.url_contains) || '') || '';
      const target =
        (want && brows.find((p) => String((p.spec && p.spec.text) || '').indexOf(want.replace(/^https?:\/\//, '')) >= 0)) || brows[0];
      try {
        if (typeof api.activatePanel === 'function') api.activatePanel(target.id);
        else if (typeof api.showPanel === 'function') api.showPanel(target.id);
      } catch (e) {
        return false;
      }
      // 等 webview 挂回来。这个数是"够用就行"：太短赶不上挂载，太长每次都白等。
      await new Promise((r) => setTimeout(r, 450));
      return true;
    };

    /**
     * 认领一块网页：先按地址对，再按面板 spec 对，最后退到最近的那个。
     * 一块都看不见时，先把面板叫回前台再试 —— 见 wake 上面那段。
     */
    const pick = async (args, tries = 3) => {
      for (let round = 0; round < tries; round += 1) {
        const all = liveWebviews();
        if (all.length) {
          const want = normalizeUrl((args && args.url_contains) || '') || '';
          if (want) {
            const hit = all.find((wc) => {
              try { return String(wc.getURL() || '').indexOf(want.replace(/^https?:\/\//, '')) >= 0; } catch (e) { return false; }
            });
            if (hit) return { wc: hit, how: t('按地址认领') };
          }
          // 面板自己记着"我开着哪个地址"，那是比历史记录更可靠的一条线索
          for (const p of browserPanels()) {
            const target = normalizeUrl(p.spec && p.spec.text);
            if (!target) continue;
            const bare = target.replace(/^https?:\/\//, '').replace(/\/+$/, '');
            const hit = all.find((wc) => {
              try {
                return String(wc.getURL() || '').replace(/^https?:\/\//, '').replace(/\/+$/, '').indexOf(bare) === 0;
              } catch (e) { return false; }
            });
            if (hit) return { wc: hit, how: t('按浏览器面板的地址认领') };
          }
          return { wc: all[all.length - 1], how: t('没认出是哪一块，用了最近打开的那个') };
        }
        // 看不见网页：可能是面板挂在别的标签页上。叫回来再试。
        if (round < tries - 1) {
          const woke = await wake(args);
          if (!woke) break; // 压根没有浏览器面板，再等也没用
        }
      }
      if (!browserPanels().length) return { error: t('现在没有浏览器面板。先用 browser_open 打开一个网址，然后再操作它。') };
      return { error: t('浏览器面板在，但它的网页还没挂载好（可能刚打开或正在加载）。稍等再调一次本工具；也可以先 browser_navigate 把它叫醒。') };
    };

    /** 把一段 JS 浇进页面；页面卡死时按超时收手，别把这一轮对话一起拖住 */
    const evalIn = async (wc, code, userGesture) => {
      const run = wc.executeJavaScript(code, Boolean(userGesture));
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(t('页面 15 秒没有响应'))), EVAL_TIMEOUT));
      return Promise.race([run, timeout]);
    };

    // ── 1. 读页面：正文 + 所有可交互元素编号 ─────────────────────────────
    api.addTool(
      {
        name: 'browser_snapshot',
        level: 'read',
        kits: ['ui', 'web'],
        description: t('读内置浏览器当前页面的正文与所有可交互元素（按钮/链接/输入框），并给它们编号。要点击或填表单之前必须先调它 —— 编号只在这次快照之后有效。'),
        parameters: {
          type: 'object',
          properties: {
            url_contains: { type: 'string', description: t('可选：开着一块以上网页时，用地址片段指明操作哪一块') },
          },
        },
      },
      async (args) => {
        const got = await pick(args);
        if (got.error) return got.error;
        try {
          const snap = await evalIn(got.wc, SNAP_JS, false);
          if (!snap || typeof snap !== 'object') return t('页面没有返回可用内容。');
          const lines = [];
          lines.push('## ' + (snap.title || '(无标题)'));
          lines.push(snap.url + '  ' + pickNote(got.wc, got.how));
          lines.push('状态：' + snap.ready + '；纵向位置 ' + snap.scrollY + ' / ' + snap.scrollH);
          lines.push('');
          lines.push('### 可交互元素（' + snap.elements.length + ' 个）');
          if (!snap.elements.length) lines.push('（没有可点的东西）');
          for (const e of snap.elements) {
            const bits = ['[' + e.i + ']', e.tag + (e.type ? ':' + e.type : '')];
            if (e.label) bits.push('「' + e.label + '」');
            if (e.value) bits.push('值=' + e.value);
            if (e.checked !== undefined) bits.push(e.checked ? '已勾选' : '未勾选');
            if (e.href) bits.push('→ ' + e.href);
            lines.push(bits.join(' '));
          }
          lines.push('');
          lines.push('### 页面正文（' + snap.textLen + ' 字' + (snap.textLen > snap.text.length ? '，已截断' : '') + '）');
          lines.push(snap.text || '（空）');
          return lines.join('\n');
        } catch (e) {
          return t('读页面失败：') + (e && e.message ? e.message : e);
        }
      },
    );

    // ── 2. 点 ──────────────────────────────────────────────────────────
    api.addTool(
      {
        name: 'browser_click',
        level: 'full',
        kits: ['ui', 'web'],
        description: t('点击内置浏览器页面上的元素。优先用 browser_snapshot 给的编号（index）；也可以给 CSS 选择器或可见文字。'),
        parameters: {
          type: 'object',
          properties: {
            index: { type: 'number', description: t('元素编号 —— browser_snapshot 结果里那个方括号里的数字') },
            selector: { type: 'string', description: t('可选：CSS 选择器，如 #submit') },
            text: { type: 'string', description: t('可选：元素上可见的文字（模糊匹配）') },
            url_contains: { type: 'string', description: t('可选：开着一块以上网页时，用地址片段指明操作哪一块') },
          },
        },
      },
      async (args) => {
        const got = await pick(args);
        if (got.error) return got.error;
        const code = findJs(
          args,
          `el.scrollIntoView({ block: 'center' });
  try { el.focus(); } catch (e) {}
  el.click();
  return { ok: true, tag: el.tagName.toLowerCase(), label: (el.innerText || el.value || el.getAttribute('aria-label') || '').slice(0, 80) };`,
        );
        try {
          const r = await evalIn(got.wc, code, true);
          if (!r || !r.ok) return t('点击失败：') + ((r && r.error) || t('未知原因'));
          // 点完之后等一小会儿，让页面把跳转/请求发出去 —— 立刻回去读往往还是旧页面
          await new Promise((res) => setTimeout(res, 600));
          let after = '';
          try { after = got.wc.getURL() || ''; } catch (e) { after = ''; }
          return '已点击 ' + r.tag + (r.label ? '「' + r.label + '」' : '') + '。' + pickNote(got.wc, got.how) + (after ? '\n现在的地址：' + after : '') + '\n要看结果就再调一次 browser_snapshot。';
        } catch (e) {
          return t('点击失败：') + (e && e.message ? e.message : e);
        }
      },
    );

    // ── 3. 填 ──────────────────────────────────────────────────────────
    api.addTool(
      {
        name: 'browser_type',
        level: 'full',
        kits: ['ui', 'web'],
        description: t('往内置浏览器页面的输入框/文本域里填字。用 React/Vue 这类框架的站点必须走这个工具，直接改 DOM 的值框架收不到。可带 submit 表示填完按回车。'),
        parameters: {
          type: 'object',
          properties: {
            index: { type: 'number', description: t('输入框编号 —— browser_snapshot 结果里那个方括号里的数字') },
            selector: { type: 'string', description: t('可选：CSS 选择器') },
            text: { type: 'string', description: t('要填进去的内容') },
            value: { type: 'string', description: t('要填进去的内容（与 text 同义，二选一）') },
            submit: { type: 'boolean', description: t('填完按一次回车（表单站常用）') },
            clear: { type: 'boolean', description: t('先把原来的内容清空（默认 true）') },
          },
        },
      },
      async (args) => {
        const got = await pick(args);
        if (got.error) return got.error;
        const value = args && (args.value !== undefined && args.value !== null && args.value !== '' ? args.value : args.text);
        if (value === undefined || value === null || value === '') return t('要填什么？给 text 或 value。');
        const submit = args && args.submit ? 'true' : 'false';
        const clear = args && args.clear === false ? 'false' : 'true';
        const code = findJs(
          args,
          `const V = ${JSON.stringify(String(value))};
  const SUBMIT = ${submit};
  const CLEAR = ${clear};
  const tag = el.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !el.isContentEditable) return { ok: false, error: '这不是一个输入框：' + tag };
  el.scrollIntoView({ block: 'center' });
  el.focus();
  if (el.isContentEditable && tag !== 'INPUT' && tag !== 'TEXTAREA') {
    el.textContent = (CLEAR ? '' : el.textContent || '') + V;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  } else {
    const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    const next = (CLEAR ? '' : String(el.value || '')) + V;
    if (desc && desc.set) desc.set.call(el, next); else el.value = next;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  let submitted = false;
  if (SUBMIT) {
    const k = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', k));
    el.dispatchEvent(new KeyboardEvent('keypress', k));
    el.dispatchEvent(new KeyboardEvent('keyup', k));
    if (el.form && typeof el.form.requestSubmit === 'function') { try { el.form.requestSubmit(); } catch (e) {} }
    submitted = true;
  }
  return { ok: true, tag: tag, len: V.length, submitted: submitted };`,
        );
        try {
          const r = await evalIn(got.wc, code, true);
          if (!r || !r.ok) return t('填字失败：') + ((r && r.error) || t('未知原因'));
          if (submit === 'true') await new Promise((res) => setTimeout(res, 700));
          return '已往 ' + r.tag + ' 填入 ' + r.len + ' 个字' + (r.submitted ? '，并按下回车' : '') + '。' + pickNote(got.wc, got.how) + '\n要看结果就再调一次 browser_snapshot。';
        } catch (e) {
          return t('填字失败：') + (e && e.message ? e.message : e);
        }
      },
    );

    // ── 4. 跳转 ────────────────────────────────────────────────────────
    api.addTool(
      {
        name: 'browser_navigate',
        level: 'full',
        kits: ['ui', 'web'],
        description: t('让内置浏览器的网页跳到另一个地址，并等它加载完。browser_open 只负责把网址摆到面板上，要真正等页面好、接着操作，用这个。'),
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: t('要去的网址') },
            url_contains: { type: 'string', description: t('可选：开着一块以上网页时，指明操作哪一块') },
          },
          required: ['url'],
        },
      },
      async (args) => {
        const url = normalizeUrl(args && args.url);
        if (!url) return t('没给网址。');
        const got = await pick(args);
        if (got.error) return got.error;
        try {
          await got.wc.loadURL(url);
          await new Promise((res) => setTimeout(res, 300));
          await evalIn(got.wc, 'document.readyState');
          return '已跳转到 ' + url + '。' + pickNote(got.wc, got.how) + '\n接着用 browser_snapshot 看页面。';
        } catch (e) {
          return t('跳转失败：') + (e && e.message ? e.message : e);
        }
      },
    );

    // ── 5. 原样跑一段 JS ──────────────────────────────────────────────
    api.addTool(
      {
        name: 'browser_eval',
        level: 'full',
        kits: ['ui', 'web'],
        description: t('在内置浏览器的页面里直接执行一段 JavaScript 并取回结果（返回值要能 JSON 序列化）。前面几个工具覆盖不了的场景才用它。'),
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: t('要执行的 JS，最后一行写表达式或 return') },
            url_contains: { type: 'string', description: t('可选：开着一块以上网页时，指明操作哪一块') },
          },
          required: ['code'],
        },
      },
      async (args) => {
        const code = String((args && args.code) || '').trim();
        if (!code) return t('没给要执行的 JS。');
        const got = await pick(args);
        if (got.error) return got.error;
        try {
          const r = await evalIn(got.wc, code, true);
          let text;
          try { text = typeof r === 'string' ? r : JSON.stringify(r, null, 2); } catch (e) { text = String(r); }
          if (text && text.length > 8000) text = text.slice(0, 8000) + '\n…（结果太长，已截断）';
          return '结果：\n' + (text === undefined ? 'undefined' : text);
        } catch (e) {
          return t('执行失败：') + (e && e.message ? e.message : e);
        }
      },
    );

    // ── 6. 截图（顺便挂进对话）─────────────────────────────────────────
    api.addTool(
      {
        name: 'browser_screenshot',
        level: 'write',
        kits: ['ui', 'web'],
        description: t('给内置浏览器当前页面截一张图，存到本面板的私有目录并直接挂进这一轮回答里（用户能看见）。做前端视觉校验、确认页面长什么样时用它。'),
        parameters: {
          type: 'object',
          properties: {
            url_contains: { type: 'string', description: t('可选：开着一块以上网页时，指明操作哪一块') },
          },
        },
      },
      async (args, ctx) => {
        const got = await pick(args);
        if (got.error) return got.error;
        try {
          const img = await got.wc.capturePage();
          const png = img.toPNG();
          if (!png || !png.length) return t('截图为空。');
          const panelId = (ctx && ctx.panelId) || 'shared';
          const dir = path.join(workspace, '.ensoul', 'panels', String(panelId));
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, 'browser-shot-' + Date.now() + '.png');
          fs.writeFileSync(file, png);
          try { api.live.image(panelId, file); } catch (e) { /* 界面那边不在也不该让这次调用失败 */ }
          const rel = path.relative(workspace, file).split(path.sep).join('/');
          return '已截图（' + png.length + ' 字节）：' + rel + '\n' + pickNote(got.wc, got.how) + '\n图已经挂在回答里，用户直接看得到。';
        } catch (e) {
          return t('截图失败：') + (e && e.message ? e.message : e);
        }
      },
    );
  },
};
