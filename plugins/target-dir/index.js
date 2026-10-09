/**
 * 目标目录 —— 「这会儿在哪个项目里干活」这件事的唯一一份账。
 *
 * 四件事：
 *   1. 记住当前目标项目。**全局一份**，不按面板分槽 —— 目标项目是整个工作区的处境，
 *      不存在"A 面板的目标项目"和"B 面板的目标项目"。
 *   2. 每轮把两条规矩摆到模型眼前：现在做的是哪个项目、临时文件该放哪。
 *   3. 模型伸手去动**别的**已登记项目时，在工具结果后面附一句提醒 —— 只提醒，不拦。
 *   4. 顺带一个 target_dir 工具，让助手一句话就能切。
 *
 * 用户点得着的入口只有一个：**会话框顶上那颗「项目 xx ▾」**。
 * 点开只列**人选过的那几个** —— 点一下切过去；想加新的用底下那行「打开文件夹…」。
 * 不预先扫工作区把目录列一堆：列表里只该有**人自己选过的**。
 * 设置里**不另开页**（见 addSettingsSection 那处 hidden）：同一件事摆两个地方，
 * 只会让人猜哪个才算数。
 */

const fs = require('fs');
const path = require('path');

/** 系统目录对话框（跟工作区那颗「打开文件夹…」同一条路）；纯 node 环境拿不到就回落成手填 */
let el = null;
try {
  el = require('electron');
} catch {
  el = null;
}

/** 最多登记几个项目 */
const MAX_PROJECTS = 30;

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
const lastBit = (p) => norm(p).split('/').filter(Boolean).pop() || norm(p);

/** 把一个值里出现的路径字符串都捞出来（工具参数里叫什么名的都有） */
function collectPaths(v, out, depth) {
  if (depth > 3) return;
  if (typeof v === 'string') {
    if (v) out.push(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectPaths(x, out, depth + 1);
    return;
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) collectPaths(v[k], out, depth + 1);
  }
}

module.exports = {
  name: 'target-dir',
  description: t('目标目录：记住当前在哪个项目里干活，改到别的项目时提醒一句，临时文件不往项目里放'),

  setup(api) {
    const root = api.workspace || '';
    const absOf = (p) => path.resolve(root, String(p));

    /** 磁盘上那份可能旧了、或者被人手改坏了 —— 只信字段齐全的那部分 */
    let state = (() => {
      const raw = api.state.load(null) || {};
      const list = Array.isArray(raw.projects) ? raw.projects : [];
      return {
        current: typeof raw.current === 'string' ? norm(raw.current) : '',
        projects: list
          .filter((p) => p && typeof p.path === 'string' && p.path.trim())
          .slice(0, MAX_PROJECTS)
          .map((p) => ({ path: norm(p.path), name: String(p.name || '').trim() || lastBit(p.path) })),
      };
    })();

    let lastReply = '';

    const project = () => state.projects.find((p) => p.path === state.current) || null;

    function save() {
      try {
        api.state.save({ current: state.current, projects: state.projects, at: Date.now() });
        api.refresh();
      } catch (e) {
        api.log(`状态写不下去：${e && e.message}`);
      }
    }

    /** 登记一个目录。不存在就建出来 —— 跟"打开工作区"同一个模式：目录由人指。 */
    function addProject(raw) {
      const p = norm(raw);
      if (!p) throw new Error(t('要填一个目录'));
      if (path.isAbsolute(String(raw)) || /^[a-z]:/i.test(p)) throw new Error(t('填工作区里的相对路径，例如 my-game'));
      if (p === '.ensoul' || p.startsWith('.ensoul/')) throw new Error(t('这个目录归软件自己用'));

      const rootAbs = path.resolve(root);
      const target = path.resolve(rootAbs, p);
      if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) {
        throw new Error(t('要填工作区里的相对路径'));
      }

      const existed = fs.existsSync(target);
      if (!existed) {
        try {
          fs.mkdirSync(target, { recursive: true });
        } catch (e) {
          throw new Error(t('建不出这个目录：{e}', { e: e && e.message }));
        }
      }

      const old = state.projects.find((x) => x.path === p);
      if (old) {
        state.current = p;
        save();
        return t('「{n}」本来就在表里，已设为当前项目', { n: old.name });
      }
      if (state.projects.length >= MAX_PROJECTS) throw new Error(t('项目太多了（上限 {n}），先移除几个', { n: MAX_PROJECTS }));

      state.projects.push({ path: p, name: lastBit(p) });
      state.current = p;
      save();
      return existed
        ? t('已登记并设为当前项目：「{n}」', { n: lastBit(p) })
        : t('已登记、已建出目录、并设为当前项目：「{n}」', { n: lastBit(p) });
    }

    /**
     * 从系统目录框里挑一个 —— 跟左上角切工作区那颗「打开文件夹…」是同一条路。
     *
     * 挑出来的一定是绝对路径，而登记表里存的是**工作区里的相对路径**，
     * 所以这里当场换算一次；换不到工作区里面就明说一句，不硬塞进表里
     * （目标项目本来的意思就是"这个工作区里的哪个子项目"，越界那种事
     * 该走"把那个目录当工作区打开"）。
     */
    async function pickProject() {
      if (!el || !el.dialog || typeof el.dialog.showOpenDialog !== 'function') {
        throw new Error(t('这台机器上打不开目录框，那就直接填路径吧。'));
      }
      const rootAbs = path.resolve(root);
      const opts = {
        title: t('挑一个目标项目目录（当前工作区里的）'),
        defaultPath: rootAbs,
        properties: ['openDirectory'],
      };
      const win = el.BrowserWindow
        ? el.BrowserWindow.getFocusedWindow() || el.BrowserWindow.getAllWindows()[0]
        : null;
      const res = win ? await el.dialog.showOpenDialog(win, opts) : await el.dialog.showOpenDialog(opts);
      if (!res || res.canceled || !res.filePaths || !res.filePaths.length) return t('没选目录。');

      const abs = path.resolve(res.filePaths[0]);
      if (abs === rootAbs) throw new Error(t('这就是工作区根目录，要选它里面的子目录。'));
      const rel = path.relative(rootAbs, abs).replace(/\\/g, '/');
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(t('只能选工作区里的目录；{p} 在外面 —— 想在那儿干活，先用左上角把它作为工作区打开。', { p: abs }));
      }
      return addProject(rel);
    }

    function useProject(raw) {
      const p = norm(raw);
      const hit = state.projects.find((x) => x.path === p || x.name === p);
      if (!hit) throw new Error(t('表里没有「{p}」', { p: String(raw) }));
      state.current = hit.path;
      save();
      return t('当前项目已切到「{n}」', { n: hit.name });
    }

    function removeProject(raw) {
      const p = norm(raw);
      const i = state.projects.findIndex((x) => x.path === p || x.name === p);
      if (i < 0) throw new Error(t('表里没有「{p}」', { p: String(raw) }));
      const was = state.projects[i];
      state.projects.splice(i, 1);
      if (state.current === was.path) state.current = '';
      save();
      return t('已从表里去掉「{n}」（磁盘上的目录没动）', { n: was.name });
    }

    function listText() {
      const cur = project();
      const lines = [
        cur ? t('当前项目：{n}（{p}）', { n: cur.name, p: cur.path }) : t('当前项目：还没选'),
      ];
      if (!state.projects.length) {
        lines.push(t('表里还没有任何项目。用 target_dir add 登记一个目录。'));
        return lines.join('\n');
      }
      lines.push(t('已登记的项目：'));
      for (const p of state.projects) {
        lines.push(`  ${p.path === state.current ? '●' : '○'} ${p.name}  (${p.path})`);
      }
      return lines.join('\n');
    }

    // ── 工具 ────────────────────────────────────────────────────────────

    api.addTool(
      {
        name: 'target_dir',
        level: 'write',
        description:
          t('管「这会儿在哪个项目里干活」：list 看当前项目和已登记的项目，add 登记一个目录（工作区里的相对路径，不存在就建出来），use 切到某个项目，remove 从表里去掉。')
          + t('目录由人指定，不靠扫盘猜。'),
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'add', 'use', 'remove'], description: t('要做什么') },
            path: { type: 'string', description: t('工作区里的相对路径，例如 my-game') },
          },
          required: ['action'],
        },
      },
      (args) => {
        const action = String((args && args.action) || '');
        const p = String((args && args.path) || '');
        try {
          if (action === 'list') return listText();
          if (action === 'add') return addProject(p);
          if (action === 'use') return useProject(p);
          if (action === 'remove') return removeProject(p);
          return t('action 只能是 list / add / use / remove。');
        } catch (e) {
          return String((e && e.message) || e);
        }
      },
    );

    // ── 每轮摆到模型眼前的两条规矩（全局，不按面板分）────────────────────

    api.addPrompt(() => {
      const cur = project();
      // 没选就一个字都不说 —— 选不选目标项目是**人想不想用这个功能**的事，
      // 不是开工的先决条件。摆一条"先去挑一个"在这儿，只会让每一次没选的对话
      // 都被塞一句多余的话，还把"动手"和"选目录"绑成一件事。
      if (!cur) return '';
      const others = state.projects.filter((x) => x.path !== state.current).map((x) => x.name);
      const lines = [
        t('【目标目录】当前正在做的项目：{n}（工作区里的 {p}）。', { n: cur.name, p: cur.path }),
        t('临时文件、草稿、导出物放工作区根或 .ensoul/tmp，不要放进任何项目目录。'),
      ];
      if (others.length) lines.push(t('别的项目（不该动的）：{l}。要动它们时先跟用户说一句。', { l: others.join('、') }));
      return lines.join('\n');
    });

    // ── 越界提醒：只提醒，不拦 ─────────────────────────────────────────

    api.onAfterTool((done) => {
      const cur = project();
      if (!cur) return;
      const others = state.projects.filter((x) => x.path !== cur.path);
      if (!others.length) return;

      const seen = [];
      collectPaths(done && done.args, seen, 0);
      if (!seen.length) return;

      const hit = others.find((x) => {
        const rel = x.path;
        const ab = norm(absOf(x.path));
        return seen.some((s) => {
          const v = norm(s);
          return v === rel || v.startsWith(rel + '/') || v === ab || v.startsWith(ab + '/');
        });
      });
      if (!hit) return;

      return (
        String((done && done.result) || '')
        + '\n\n'
        + t('【提醒】这次动到的是「{n}」（{p}）—— 不是当前目标项目「{c}」。确认一下是不是有意为之；要在这边干活，就让用户切一下当前项目。', {
          n: hit.name,
          p: hit.path,
          c: cur.name,
        })
      );
    });

    // ── 会话框顶上那一条：抬眼就在 ──────────────────────────────────────

    api.addStatusItem({
      id: 'target-dir',
      slot: 'head',
      // 没选也露脸：这块本来就是"点它去选"，空着等于把入口藏了
      text() {
        const cur = project();
        return cur ? t('项目 {n}', { n: cur.name }) : t('未选项目');
      },
      title() {
        const cur = project();
        if (!cur) return t('还没选目标项目，点一下挑一个');
        const others = state.projects.filter((x) => x.path !== cur.path).map((x) => x.name);
        const lines = [t('当前目标项目：{n}', { n: cur.name }), cur.path];
        if (others.length) lines.push(t('已登记的其它项目：{l}', { l: others.join('、') }));
        lines.push(t('点一下切换；没有的用底下那行「打开文件夹…」挑进来'));
        return lines.join('\n');
      },
      /**
       * 点开的下拉 —— 跟左上角切工作区那颗一个形状：**全是点选，不用打字**。
       * 动作回给下面那个同名分区的 onAction（菜单只管说有什么，画和回传都是核心的事）。
       */
      menu() {
        return {
          title: t('目标项目'),
          plugin: 'target-dir',
          section: 'target-dir',
          items: [
            ...state.projects.map((p) => ({
              label: p.name,
              desc: p.path,
              on: p.path === state.current,
              action: 'use',
              row: p.path,
            })),
            // 跟左上角那颗「打开文件夹…」一模一样：清单里没有的，当场挑一个加进来。
            { label: t('打开文件夹…'), desc: t('挑一个目录，登记并切过去'), action: 'pick', row: '' },
          ],
        };
      },
    });

    // ── 主控制台：设置里的一页（插件交数据、核心画）──────────────────────

    api.addSettingsSection({
      id: 'target-dir',
      label: t('目标目录'),
      // 设置里**不单开一页** —— 切换项目这件事的入口是会话顶上那颗「项目 ▾」，
      // 抬眼就在、点一下就切。再往设置里摆一页，等于把同一件事分成两个地方。
      // 这一份仍然注册着，是因为顶上那颗下拉的动作要走 plugin + section 这条路递回来。
      hidden: true,
      hint: t('当前在哪个项目里干活 —— 模型越界去动别的项目时会收到提醒，但不会被拦住'),
      // 注册要求有个 view；这一页不上导航，所以给个空的就行。
      // 真正给人看的界面是会话顶上那颗「项目 ▾」。
      view: () => ({ rows: [] }),
      onAction: (actionId, rowId) => {
        const act = String(actionId || '');
        const rid = String(rowId || '');
        lastReply = '';
        try {
          if (act === 'pick') {
            // 目录框是异步的：把 promise 交回去（核心会等它），选完那一趟就带回新内容。
            // 出错也回一句话、不抛出去 —— 抛了会在界面上变成一条没人接的报错。
            return pickProject()
              .then((msg) => { lastReply = msg; return msg; })
              .catch((err) => {
                const msg = String((err && err.message) || err);
                lastReply = msg;
                return msg;
              });
          }
          if (rid === '__add') {
            lastReply = addProject(act.startsWith('add:') ? act.slice(4) : '');
            return lastReply;
          }
          if (act === 'use') {
            lastReply = useProject(rid);
            return lastReply;
          }
          if (act === 'remove') {
            lastReply = removeProject(rid);
            return lastReply;
          }
        } catch (e) {
          lastReply = String((e && e.message) || e);
        }
        return lastReply;
      },
    });

    api.log(`目标目录就绪（全局一份；当前：${project() ? project().path : '未选'}）`);
  },
};
