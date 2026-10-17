/**
 * patch-guard —— 让"批量改文件"回到有护栏的车道，并且拦得住"同一个脚本跑第二遍"。
 *
 * 治的是两个同源的事故（它们叠在一起最伤）：
 *
 *   一、模型要批量改代码时，习惯写个 node 脚本用 fs.writeFileSync 直接改源码。
 *       那条路**绕开了全部护栏** —— file-backup 的留底、tx-guard 的语法撤回、
 *       read-guard 的先读后写、文件租约，一层都吃不到（见 docs/file-write-safety.md：
 *       "旧插件直接用 fs、终端命令、外部编辑器和其他进程不会领取租约"）。
 *       → 这里给一个走 api.files.write 的工具 patch_apply：结构化、可校验、可留底。
 *
 *   二、补丁脚本是**非幂等**的：第一次跑完锚点已经变了，第二次要么抛错（走运），
 *       要么匹配漂移到**别的地方**，删掉本不该动的代码（那次事故伤了 4 个文件）。
 *       → 这里把它变成"系统记得它跑过、也记得它动过谁"的操作。
 *
 * 三件事，一件一环：
 *
 *   1. patch_apply —— 幂等批量编辑。目标已经是"改后"状态就跳过并如实报告；
 *      全部校验通过才动手，要么全成、要么一处不动。写入统一走 api.files.write，
 *      于是它和 edit 站在**同一条**协调器车道上。
 *
 *   2. patch_dry_run —— 只报不写。改之前先看清会改哪几处、哪几处已被应用。
 *
 *   3. 同一条改文件的命令**不要跑第二遍**（onBeforeTool 拦）。
 *
 *      ── 判据一：不看命令长什么样，只看它实际改了什么 ──
 *
 *      危险词能被 base64、变量拼接绕过去；"文件真的变了"绕不过去 —— 那是结果，不是意图。
 *      所以这里两条腿：onBeforeTool 记下跑之前工作区的样子，onAfterTool 再扫一遍，
 *      diff 出这次真正被改动的文件 + 改前改后的哈希。
 *
 *      ── 判据二：文件现在处在哪个状态，决定放不放行 ──
 *
 *      记下的是"某条命令把 A 从 before 改成了 after"。它再来时，看现在的 A：
 *
 *        现在 == before  -> 文件已经回到它当初的输入状态，重跑是一次忠实的重放 -> 放行
 *        现在 == after   -> 文件正是它上次留下的结果。脚本的锚点当初是按 before 写的，
 *                           再跑一次就会在 after 上重新匹配 —— **这正是事故** -> 拦
 *        两个都不是      -> 中间有第三方动过（别的面板、人手动、另一个脚本）,
 *                           再跑就会在陌生基准上匹配 -> 拦
 *
 *      ── 判据三：看过，就不拦 ──
 *
 *      拦的目的是逼人**先看清现状**，而不是永久禁止。所以：如果它上次改过的那些文件
 *      （处在 after 或第三方状态的）在这之后都被 read_file / code_slice 读过一遍，
 *      就放行 —— 看过之后还决定跑，那是知情的选择。这条和 read-guard 是同一个精神。
 *
 *      时间窗：只对"刚跑过"的命令设防（默认 10 分钟，可调）。隔了很久再跑同一条命令
 *      （比如两次 npm install）不该被拦 —— 事故是**紧接着**重放，不是隔天再用一次。
 *
 * 为什么不复用 restart-guard 那套 flatten/unpackScripts：那套是为了认"动进程"，
 * 判据是进程动作 + 品牌词，跟"改文件"无关。这里换判据不是省事，是因为
 * 杀进程和改文件这两件事，能绕过去的方式根本不是同一种。
 *
 * 已知边界：job_start 是**立刻返回**的（活还在后台跑），拿它前后扫描 diff 不出东西，
 * 所以后台任务不参与"改动了什么"的记账 —— 它连记账都不记。拦的是同步的 run_command，
 * 也就是事故里那一条。
 *
 * 状态：.ensoul/state/patch-guard.json（走 api.state）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 可调参数（设置面板里能改，助手也能改 —— 见 plugins/plugin-kit） */
const PARAMS = {
  window: {
    label: t('同一条命令多久之内算"刚跑过"（秒）'),
    type: 'number', default: 600, min: 30, max: 86400,
    hint: t('只对这个时间窗内的重复执行设防；隔久了再跑同一条命令（比如两次 npm install）不拦'),
  },
};

/** 一个命令体的指纹：只认"这条命令"，不看它跑了几次 */
const fingerprint = (name, args) => {
  const pick = [args && args.command, args && args.workdir];
  return crypto.createHash('sha1').update(String(name) + '@@' + JSON.stringify(pick || [])).digest('hex').slice(0, 16);
};

const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** 能起任意命令的工具。job_start 是异步的，见头部说明：不参与记账 */
const SHELL_TOOLS = new Set(['run_command', 'job_start']);
const SYNC_SHELL = new Set(['run_command']);

/** "读过了"的口子 —— 这些工具跑过，就算看过那个文件 */
const READ_TOOLS = new Set(['read_file', 'code_slice']);

/** 扫描时跳过的目录：产物、缓存、依赖 —— 它们天天在变，进来了全是噪音 */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'out', 'build', '.ensoul', '.cache', '.idea', '.vscode',
  'coverage', '.venv', 'venv', '__pycache__', '.next', 'target', 'vendor', 'tmp', 'temp',
  'logs', 'comfyui', '.electron',
]);

/** 值得比对内容的后缀 */
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', '.json', '.css', '.md', '.txt',
  '.html', '.py', '.sh', '.cmd', '.bat', '.yml', '.yaml', '.toml', '.xml', '.svg',
]);

/** 单次快照最多看多少个文件 —— 超了就不扫（宁可漏拦，也不让每条命令都卡住） */
const MAX_FILES = 4000;

module.exports = {
  params: PARAMS,
  name: 'patch-guard',
  description: t('批量改文件走有护栏的车道（patch_apply 幂等编辑），并拦住破坏性脚本的第二次执行'),

  setup(api) {
    const t = api.t || ((s) => s);
    const ROOT = String(api.workspace || '');
    const WINDOW_MS = Math.max(30, Number(api.param('window', 600)) || 600) * 1000;

    // ── 状态 ────────────────────────────────────────────────────────────
    // panels[panelId] = { fp, at, files: { <相对路径>: { before, after } } }
    const load = () => {
      const raw = api.state.load(null) || {};
      const panels = raw && typeof raw === 'object' && raw.panels && typeof raw.panels === 'object' ? raw.panels : {};
      return { panels: panels };
    };
    const save = (state) => {
      state.panels = state.panels || {};
      const keys = Object.keys(state.panels);
      if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete state.panels[k];
      api.state.save(state);
    };

    /** panelId -> Set<相对路径> —— 这次会话里"看过"的文件。故意不落盘：重启后该重新看 */
    const reads = new Map();
    const markRead = (id, rel) => {
      if (!id || !rel) return;
      const set = reads.get(id) || new Set();
      set.add(String(rel).replace(/\\/g, '/'));
      if (set.size > 500) set.delete(set.values().next().value);
      reads.set(id, set);
    };

    /** 工作区内的相对路径 -> 绝对路径；越界返回空串 */
    const inside = (rel) => {
      if (!ROOT) return '';
      const abs = path.resolve(ROOT, String(rel || ''));
      const norm = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
      const r = norm(ROOT.replace(/[\\/]+$/, ''));
      const a = norm(abs);
      return a === r || a.startsWith(r + path.sep) || a.startsWith(r + '/') ? abs : '';
    };

    const readOf = (abs) => {
      try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
    };

    /**
     * 给工作区拍一张快照：相对路径 -> 内容哈希。
     * 只比内容，不比 mtime —— mtime 会被 checkout、被工具碰一下就变，那样满盘噪声。
     */
    const snap = () => {
      const out = new Map();
      if (!ROOT) return out;
      const walk = (dir) => {
        if (out.size >= MAX_FILES) return;
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (out.size >= MAX_FILES) return;
          if (SKIP_DIRS.has(e.name)) continue;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { walk(p); continue; }
          if (!e.isFile()) continue;
          if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
          const text = readOf(p);
          if (text === null) continue;
          out.set(path.relative(ROOT, p).replace(/\\/g, '/'), sha(text));
        }
      };
      walk(ROOT);
      return out;
    };

    /** 两张快照之间变了哪些文件 —— 这就是"这条命令实际改了什么" */
    const diff = (before, after) => {
      const changed = new Map();
      for (const [rel, hash] of after) {
        if (before.get(rel) !== hash) changed.set(rel, { before: before.get(rel) || 'missing', after: hash });
      }
      for (const [rel, hash] of before) {
        if (!after.has(rel)) changed.set(rel, { before: hash, after: 'missing' });
      }
      return changed;
    };

    const hashNow = (rel) => {
      const abs = inside(rel);
      const now = abs ? readOf(abs) : null;
      return now === null ? 'missing' : sha(now);
    };

    // ── 一、patch_apply / patch_dry_run ────────────────────────────────

    /**
     * 一份补丁：{ path, find, replace, expect? }
     *   find     要被替换掉的原文（原样，含缩进）
     *   replace  换成什么；给空串就是删掉这一段
     *   expect   可选：改完之后文件里应该包含它（防"改错了地方"）
     *
     * 幂等的关键在 find 的三种情况，一条都不许含糊：
     *   find 0 次、replace 已在        -> 已经应用过，跳过并如实说；
     *   find 0 次、replace 也不在      -> 锚点漂了，报错，不动这个文件；
     *   find >1 次                     -> 要求写得更唯一，报错，不动这个文件。
     */
    const planOne = (raw) => {
      const rel = String((raw && raw.path) || '').trim();
      const find = String((raw && raw.find) != null ? raw.find : '');
      const replace = String((raw && raw.replace) != null ? raw.replace : '');
      const expect = raw && raw.expect != null ? String(raw.expect) : null;
      const abs = inside(rel);
      if (!rel || !abs) return { rel: rel || '（空路径）', error: t('路径为空或跑到工作区外面了') };

      const text = readOf(abs);
      if (text === null) return { rel, error: t('文件不存在或读不出来 —— 新建文件请用 write_file') };
      if (!find) return { rel, error: t('find 是空的：定位不到就一定会改错地方，拒绝执行') };

      const times = text.split(find).length - 1;
      if (times === 0) {
        if (replace && text.indexOf(replace) >= 0) {
          return { rel, abs, text, next: text, done: true, note: t('已经是改后的样子（find 找不到了、replace 在位）→ 跳过') };
        }
        return { rel, error: t('find 在这个文件里出现 0 次 —— 锚点不在原位。先 read_file 看清现状再改，别换个写法硬试') };
      }
      if (times > 1) {
        return { rel, error: t('find 出现了 ' + times + ' 次，改哪一处不确定。把 find 写长一点、长到全局唯一，或者拆成多条') };
      }

      const at = text.indexOf(find);
      const next = text.slice(0, at) + replace + text.slice(at + find.length);
      if (next === text) return { rel, abs, text, next, done: true, note: t('内容没有变化 → 跳过') };
      if (expect && next.indexOf(expect) < 0) {
        return { rel, error: t('改完之后没有出现 expect 里的内容 —— 多半是改错了地方，没动手') };
      }
      return { rel, abs, text, next, done: false };
    };

    const runPatch = (args, dry) => {
      const list = Array.isArray(args && args.patches) ? args.patches : [];
      if (!list.length) return t('patches 是空的：一次至少要发一条 { path, find, replace }');
      if (list.length > 40) return t('一次最多 40 条 —— 再多请分批，好定位是哪儿改坏的');

      const plans = list.map(planOne);
      const bad = plans.filter((r) => r.error);
      const skips = plans.filter((r) => !r.error && r.done);
      const work = plans.filter((r) => !r.error && !r.done);

      const lines = [];
      if (skips.length) {
        lines.push(t('### 已经应用过（跳过，没有重复动手）'));
        for (const r of skips) lines.push('- ' + r.rel + ' — ' + r.note);
      }
      if (bad.length) {
        lines.push(t('### 没通过校验（这些文件一处都没动）'));
        for (const r of bad) lines.push('- ' + r.rel + ' — ' + r.error);
      }

      // 有错就整批不动 —— 半成品比没改更坏：文件停在不一致状态，构建红了还说不清是谁弄的
      if (bad.length) {
        lines.unshift(t('**这批补丁没有执行：有没通过校验的条目。** 要对就全部改，要不就一处不动。'), '');
        return lines.join('\n');
      }

      if (dry) {
        lines.unshift(t('**dry-run：将有 ' + work.length + ' 个文件被改（一个字都没写）。**'), '');
        for (const r of work) lines.push('- ' + r.rel + ' — 将替换 1 处');
        if (!work.length) lines.push(t('（没有需要改的 —— 目标都已经是改后的样子了）'));
        return lines.join('\n');
      }

      if (!work.length) {
        lines.unshift(t('**这批补丁没有任何文件被改动** —— 目标都已经是改后的样子了。'), '');
        return lines.join('\n');
      }

      const okFiles = [];
      const failFiles = [];
      for (const r of work) {
        try {
          api.files.write(r.rel, r.next);
          okFiles.push(r.rel);
        } catch (error) {
          failFiles.push({ rel: r.rel, why: String((error && error.message) || error) });
        }
      }

      lines.unshift(t('**已改 ' + okFiles.length + ' 个文件。**'), '');
      for (const rel of okFiles) lines.push('- 已改：' + rel);
      for (const f of failFiles) lines.push('- 失败：' + f.rel + ' — ' + f.why);
      if (failFiles.length) lines.push('', t('失败的这几个没写进去。它可能正被别的面板动 —— 先 read_file 看清现状。'));
      return lines.join('\n');
    };

    api.addTool(
      {
        name: 'patch_apply', kits: ['dev'],
        description:
          t('批量改文件：一次发一组补丁，逐条校验后**要么全改、要么一处不动**，写入走和 edit 同一条护栏车道（有留底、有语法校验、有先读后写）。')
          + t('每条 { path, find, replace }：find 是要替换掉的原文（原样、含缩进），replace 是换成什么（空串=删掉这段）。')
          + t('**幂等**：目标已经是改后的样子就跳过并如实报告，绝不会重复动手 —— 所以同一个补丁重发，不会像脚本那样删到别处。')
          + t('find 找不到（锚点漂了）或出现多次（不确定改哪处）都直接报错、不动那个文件，不会硬猜。')
          + t('要用它取代"写个 node 脚本 fs.writeFileSync 批量改源码"—— 脚本那条路绕开了留底、语法校验和先读后写。')
          + t('改之前想先看清会改哪几处，用 patch_dry_run。'),
        parameters: {
          type: 'object',
          properties: {
            patches: {
              type: 'array',
              description: t('要改的几处，每处一条'),
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: t('相对工作区的文件路径') },
                  find: { type: 'string', description: t('要被替换掉的原文，必须原样且全局唯一') },
                  replace: { type: 'string', description: t('换成什么；空串表示删掉这一段') },
                  expect: { type: 'string', description: t('可选：改完之后文件里应该出现这段内容，用来防改错地方') },
                },
                required: ['path', 'find'],
              },
            },
          },
          required: ['patches'],
        },
        level: 'write',
      },
      (args) => runPatch(args, false),
    );

    api.addTool(
      {
        name: 'patch_dry_run', kits: ['dev'],
        description:
          t('只检查不写：把这组补丁逐条验一遍，报出哪几个文件会被改、哪几处已经应用过了、哪几处锚点对不上。')
          + t('参数和 patch_apply 一模一样。改重要文件之前先跑它。'),
        parameters: {
          type: 'object',
          properties: {
            patches: { type: 'array', description: t('要试算的补丁，同 patch_apply'), items: { type: 'object' } },
          },
          required: ['patches'],
        },
        level: 'read',
      },
      (args) => runPatch(args, true),
    );

    // ── 二、同一条改文件的命令，不要跑第二遍 ──────────────────────────

    /** panelId -> { fp, before: Map } —— 命令跑之前的快照，跑完就消费掉 */
    const pending = new Map();

    api.onBeforeTool((call) => {
      if (!call || !SYNC_SHELL.has(call.name) || !call.args) return;
      const cmd = String(call.args.command || '');
      if (!cmd) return;

      const id = (call.ctx && call.ctx.panelId) || '';
      if (!id) return;
      const fp = fingerprint(call.name, call.args);
      const state = load();
      const prev = state.panels[id];

      if (prev && prev.fp === fp && prev.files && Date.now() - Number(prev.at || 0) < WINDOW_MS) {
        const set = reads.get(id) || new Set();
        const unresolved = [];
        const unread = [];
        for (const rel of Object.keys(prev.files)) {
          const rec = prev.files[rel] || {};
          const now = hashNow(rel);
          if (now === rec.before) continue; // 回到它当初的输入状态 —— 重跑是忠实的重放
          unresolved.push(rel);
          if (!set.has(rel)) unread.push(rel);
        }

        if (unresolved.length && unread.length) {
          prev.at = Number(prev.at) || Date.now();
          save(state);
          const shown = unread.slice(0, 6);
          const out = [
            t('**没有执行：这条命令刚刚跑过一次，而它上次改过的文件还是它留下的样子。**'),
            t('脚本的锚点是按**改之前**的内容写的。再跑一遍，它会在**改之后**的内容上重新匹配 ——'),
            t('匹配不到就无事发生，匹配到别处就删掉本不该动的代码。这就是重复执行会误删的来路。'),
            '',
            t('它上次改过、这次还没看过的文件：'),
          ];
          for (const f of shown) out.push('  · ' + f);
          if (unread.length > shown.length) out.push('  · ……还有 ' + (unread.length - shown.length) + ' 个');
          out.push('');
          out.push(t('要往下走，选一条：'));
          out.push(t('1. 先用 read_file 看清这些文件现在是什么样。**看过之后这条命令就能跑** —— 拦的是"没看就重放"，不是"不许重跑"。'));
          out.push(t('2. 真要改，把补丁内容按**现状**重写（find 改了就是一条新命令，不受这条管）。'));
          out.push(t('3. 批量改代码改用 **patch_apply**：它幂等，重复应用只会报"已经应用过"然后跳过。'));
          return out.join('\n');
        }
      }

      // 记账：记下"跑之前" —— 跑完在 onAfterTool 里 diff
      pending.set(id, { fp: fp, before: snap() });
      if (pending.size > 64) pending.delete(pending.keys().next().value);
    });

    api.onAfterTool((done) => {
      if (!done) return;
      const id = (done.ctx && done.ctx.panelId) || '';

      // 看过文件就记一笔 —— 上面那条"看过就放行"靠它
      if (READ_TOOLS.has(done.name) && done.args && done.args.path) markRead(id, done.args.path);

      if (!done.name || !SYNC_SHELL.has(done.name) || !id) return;
      const held = pending.get(id);
      if (!held) return;
      pending.delete(id);

      let changed;
      try { changed = diff(held.before, snap()); } catch { return; }
      if (!changed.size) return; // 这条命令什么都没改 —— 不留记账，第二次也不拦

      const files = {};
      for (const [rel, rec] of changed) files[rel] = { before: rec.before, after: rec.after };
      const state = load();
      state.panels[id] = { fp: held.fp, at: Date.now(), files: files };
      save(state);
    });

    // ── 三、让规矩一开始就在场 ────────────────────────────────────────
    // 不靠"犯错后被拦"：新建的每一块面板，提示里本身就带着这条。
    api.addPrompt(() => [
      t('【改文件】'),
      t('· 改工作区源码一律用 edit / write_file / patch_apply。别写 node 脚本用 fs.writeFileSync 批量改 —— 那条路绕开了留底、语法校验和先读后写。'),
      t('· 确实需要脚本做批量替换时，脚本只输出 diff 或 dry-run 结果，真正的写入回到 edit / patch_apply。'),
      t('· 同一个改文件的脚本**不要紧接着跑第二遍**：第一遍之后锚点已经变了，第二遍会删到别处。要先看清文件现状，再决定怎么改。'),
    ].join('\n'));

    api.log('patch-guard 就绪（幂等批量编辑 + 重复执行拦截）');
  },
};
