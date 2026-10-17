/**
 * 代码诊断 —— 改完代码让模型自己看一眼"有没有错"，而不是先去跑一次完整构建。
 *
 * 为什么要有它：本软件改完源码的常规验证是 build_project（几十秒），一次编译失败还要再来一轮。
 * 而各种类型检查器本来就能一份一份地报错，还带行号、错误码、严重级别 —— 那些信息 build 输出里也有，
 * 但混在几百行日志中间，模型得自己刨。这个插件做的是"把它刨出来、按文件归好"。
 *
 * 多语言：按项目里**实际装了什么**挑诊断器，探测不到就说人话（不报错、不装依赖、不联网）。
 * 挑不出来时宁可返回一句"这台机器没有 X 的诊断器"，也不假装检查过了 —— 
 * 一个什么都查不出来的诊断工具，比没有更坏：模型会以为源码是干净的。
 *
 * 为什么参数跟项目自己的门禁同源：本软件的构建链就是 tsc -p tsconfig.main.json，
 * 诊断要跟真正那道门禁一致，参数一旦漂开就变成"诊断说没事、构建过不去"。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** 一次检查最多跑这么久 —— 大项目全量本来就慢，但不该把一轮对话挂死 */
const CHECK_TIMEOUT = 120000;
/** 报错最多回这么多条；再多就不是诊断，是一堵墙 */
const MAX_ISSUES = 60;

module.exports = {
  name: 'code-diagnostics',
  description: t('代码诊断：按项目类型跑对应的检查器（tsc / pyright / ruff / go vet / cargo），把错误按文件归好报回来'),

  setup(api) {
    const workspace = api.workspace || '';

    /** 项目里那份依赖在哪：优先本地 node_modules，不上网、不装 */
    const exists = (rel) => {
      try { return fs.existsSync(path.join(workspace, rel)); } catch (e) { return false; }
    };
    const has = (cmd) => {
      try {
        const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true, shell: true });
        return !r.error && r.status === 0;
      } catch (e) { return false; }
    };

    /** 哪个 tsconfig：优先 src 那份（本软件的门禁就是它），再退到根的 */
    const configFor = (given) => {
      if (given) {
        const abs = path.resolve(workspace, String(given));
        try { if (fs.existsSync(abs)) return String(given); } catch (e) { /* 不存在就走默认 */ }
      }
      for (const c of ['tsconfig.main.json', 'tsconfig.json']) {
        try { if (fs.existsSync(path.join(workspace, c))) return c; } catch (e) { /* 接着找 */ }
      }
      return '';
    };

    /** 项目里有哪些语言 —— 按文件的"证据"判，不猜 */
    const detect = () => {
      const out = [];
      if (exists('node_modules/typescript/bin/tsc') && configFor('')) out.push('ts');
      if (exists('pyproject.toml') || exists('requirements.txt') || exists('setup.py')) out.push('python');
      if (exists('go.mod')) out.push('go');
      if (exists('Cargo.toml')) out.push('rust');
      return out;
    };

    /** 把一条诊断切成结构：统一的形状，各语言解析器只管往里塞 */
    const mk = (file, line, col, level, code, msg) => ({
      file: String(file).replace(/\\/g, '/'),
      line: Number(line) || 0,
      col: Number(col) || 0,
      level: level === 'warning' ? 'warning' : 'error',
      code: code || '',
      msg: String(msg || '').trim(),
    });

    /** 各语言的解析器 —— 每种工具的报错格式不一样，在这里各归各位 */
    const PARSERS = {
      // tsc: src/a.ts(12,5): error TS2322: 类型不匹配
      ts: (text) => {
        const out = [];
        const re = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.*)$/;
        for (const raw of String(text).split(/\r?\n/)) {
          const m = re.exec(raw.trim());
          if (m) out.push(mk(m[1], m[2], m[3], m[4], m[5], m[6]));
        }
        return out;
      },
      // pyright / ruff / go vet / cargo 的 short 格式都落在这一条上：
      //   file:line:col: error: msg    /    file:line:col: [CODE] msg
      generic: (text) => {
        const out = [];
        const re = /^(.+?):(\d+):(\d+)?[\s:-]*(error|warning)?[\s:-]*(\[[A-Za-z0-9]+\]|[A-Z]\d{4})?[\s:-]*(.*)$/;
        for (const raw of String(text).split(/\r?\n/)) {
          const m = re.exec(raw.trim());
          if (!m) continue;
          const level = m[4] || (/\berror\b/i.test(raw) ? 'error' : 'warning');
          out.push(mk(m[1], m[2], m[3], level, (m[5] || '').replace(/[\[\]]/g, ''), m[6]));
        }
        return out;
      },
    };

    /** 跑一条命令，返回 {out, status, timeout} */
    const run = (cmd, argv) => {
      try {
        const r = spawnSync(cmd, argv, {
          cwd: workspace, encoding: 'utf8', timeout: CHECK_TIMEOUT,
          windowsHide: true, maxBuffer: 32 * 1024 * 1024, shell: true,
        });
        return { out: String(r.stdout || '') + String(r.stderr || ''), status: r.status, timeout: !!(r.error && r.error.code === 'ETIMEDOUT') };
      } catch (e) {
        return { out: String((e && e.message) || e), status: -1, timeout: false };
      }
    };

    /**
     * 按语言挑检查器。返回 {label, items, note} 或 {error}。
     * 探测不到就明说 —— 绝不返回"干净"。
     */
    const diagnose = (want) => {
      const have = detect();
      const asked = want && want.language && want.language !== 'auto' ? String(want.language) : '';
      const pick = asked || have[0] || '';

      if (!pick) {
        return { error: t('这台机器上没找到可用的诊断器：没有已装的 typescript、也没有 pyproject/go.mod/Cargo.toml 这类项目标记。不是错误，只是这个项目用不上本工具。') };
      }

      if (pick === 'ts') {
        if (!exists('node_modules/typescript/bin/tsc')) return { error: t('这个项目里没有装 typescript（找不到 node_modules/typescript）—— 跳过类型检查。这不是错误。') };
        const cfg = configFor(want && want.config);
        if (!cfg) return { error: t('没找到 tsconfig（tsconfig.main.json / tsconfig.json 都没有）—— 先确认这是个 TypeScript 项目。') };
        const tsc = path.join(workspace, 'node_modules', 'typescript', 'bin', 'tsc');
        const r = run(process.execPath, [tsc, '-p', cfg, '--noEmit', '--pretty', 'false']);
        if (r.timeout) return { error: t('类型检查超过 ') + Math.round(CHECK_TIMEOUT / 1000) + t(' 秒还没跑完，已经收手。') };
        return { label: 'tsc -p ' + cfg, items: PARSERS.ts(r.out) };
      }

      if (pick === 'python') {
        // 优先 pyright（真类型检查）；没有就退到 ruff（lint）；再没有就只能做语法检查 —— 逐级降级要说清楚
        const args0 = Array.isArray(want && want.paths) ? want.paths : ['.'];
        if (exists('node_modules/.bin/pyright')) {
          const r = run(path.join(workspace, 'node_modules', '.bin', 'pyright'), ['--outputjson', ...args0]);
          if (r.timeout) return { error: t('pyright 超时。') };
          try {
            const j = JSON.parse(r.out.slice(r.out.indexOf('{')));
            const items = [];
            for (const d of (j.generalDiagnostics || [])) {
              items.push(mk((d.file || '').replace(workspace + path.sep, ''), (d.range && d.range.start && d.range.start.line + 1) || 0, (d.range && d.range.start && d.range.start.character + 1) || 0, d.severity === 'warning' ? 'warning' : 'error', d.rule || '', d.message || ''));
            }
            return { label: 'pyright', items };
          } catch (e) {
            return { label: 'pyright', items: PARSERS.generic(r.out) };
          }
        }
        if (has('ruff')) {
          const r = run('ruff', ['check', '--output-format=concise', ...args0]);
          if (r.timeout) return { error: t('ruff 超时。') };
          return { label: 'ruff check', items: PARSERS.generic(r.out) };
        }
        const r = run('python', ['-m', 'compileall', '-q', ...args0]);
        if (r.timeout) return { error: t('语法检查超时。') };
        const items = [];
        for (const raw of r.out.split(/\r?\n/)) {
          const m = /^(.*?):\s*(SyntaxError|IndentationError|TabError):?\s*(.*)$/.exec(raw.trim());
          if (m) items.push(mk(m[1], 0, 0, 'error', m[2], m[3]));
        }
        return { label: 'python -m compileall（只查语法）', items, note: t('本机没装 pyright / ruff，只能查语法错误 —— 类型问题查不出来。') };
      }

      if (pick === 'go') {
        if (!has('go')) return { error: t('这是 Go 项目，但本机 PATH 上没有 go —— 跳过硬检查。') };
        const r = run('go', ['vet', './...']);
        if (r.timeout) return { error: t('go vet 超时。') };
        // go vet 常输出 `file.go:12:3: msg`，也可能带 # 开头的包行，generic 会自然跳过
        return { label: 'go vet ./...', items: PARSERS.generic(r.out) };
      }

      if (pick === 'rust') {
        if (!has('cargo')) return { error: t('这是 Rust 项目，但本机 PATH 上没有 cargo —— 跳过硬检查。') };
        const r = run('cargo', ['check', '--message-format', 'short']);
        if (r.timeout) return { error: t('cargo check 超时。') };
        return { label: 'cargo check', items: PARSERS.generic(r.out) };
      }

      return { error: t('不认识的语言：') + pick + t('（可选 ts / python / go / rust）') };
    };

    api.addTool(
      {
        name: 'type_check',
        level: 'read',
        kits: ['dev', 'review'],
        description:
          t('对项目跑一次检查，把错误按文件归好报回来（带行号、错误码）。')
          + t('按项目类型自动挑检查器：TypeScript 走 tsc、Python 走 pyright/ruff、Go 走 go vet、Rust 走 cargo check。')
          + t('改完代码用它自检，比直接跑 build_project 快，也看得清错在哪。可用 language 指定、files 只看某几个文件。'),
        parameters: {
          type: 'object',
          properties: {
            language: { type: 'string', enum: ['auto', 'ts', 'python', 'go', 'rust'], description: t('可选：指定语言，默认 auto 按项目标记自动挑') },
            files: { type: 'array', items: { type: 'string' }, description: t('可选：只看这几个文件里的错（相对工作区的路径）') },
            config: { type: 'string', description: t('可选：TypeScript 用，指定 tsconfig（默认 tsconfig.main.json，没有就 tsconfig.json）') },
            max_issues: { type: 'number', description: t('可选：最多报几条，默认 60') },
          },
        },
      },
      (args) => {
        if (!workspace) return t('没有工作区 —— 没有项目可查。');
        const r = diagnose(args || {});
        if (r.error) return r.error;

        let items = r.items || [];
        const all = items.length;
        const want = Array.isArray(args && args.files) ? args.files.map((f) => String(f).replace(/\\/g, '/')) : [];
        if (want.length) {
          items = items.filter((it) => want.some((w) => it.file === w || it.file.endsWith('/' + w) || w.endsWith('/' + it.file)));
        }

        const limit = Math.max(1, Math.min(200, Number((args && args.max_issues) || MAX_ISSUES)));
        const head = ['## 代码检查：' + r.label];
        if (r.note) head.push(t('（') + r.note + t('）'));

        if (!items.length) {
          head.push(want.length ? t('你点名的这几个文件里没有报错。') : t('没有报错 —— 这一关是干净的。'));
          if (want.length && all) head.push(t('（全项目还有 ') + all + t(' 条在别的文件里，用不带 files 的调用看）'));
          return head.join('\n');
        }

        const errors = items.filter((i) => i.level === 'error').length;
        head.push(t('共 ') + String(items.length) + t(' 条（error ') + String(errors) + t(' / warning ') + String(items.length - errors) + t('）'));
        if (want.length && all !== items.length) head.push(t('（只显示你点名的文件；全项目共 ') + String(all) + t(' 条）'));

        const byFile = new Map();
        for (const it of items.slice(0, limit)) {
          if (!byFile.has(it.file)) byFile.set(it.file, []);
          byFile.get(it.file).push(it);
        }
        for (const [file, list] of byFile) {
          head.push('');
          head.push('### ' + file + t('（') + String(list.length) + t(' 条）'));
          for (const it of list) {
            head.push('- `' + (it.line ? it.line + (it.col ? ':' + it.col : '') : '?') + '` ' + (it.code ? it.code + ' ' : '') + it.msg);
          }
        }
        if (items.length > limit) {
          head.push('');
          head.push(t('…还有 ') + String(items.length - limit) + t(' 条没列出来。修完上面这些再查一次。'));
        }
        head.push('');
        head.push(t('修完再调一次本工具确认干净；类型过了仍然要跑 build_project 才算真过。'));
        return head.join('\n');
      },
    );
  },
};
