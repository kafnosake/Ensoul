/**
 * 无头自检 —— 不开窗口，直接验证工具、插件、技能这几条真在跑。
 *
 * 为什么要它：这个软件的正常验证方式是"起窗口、手点"，可那两件事都做不了自动化，
 * 于是每改一次核心都得靠人肉点一遍。这个脚本把**不依赖界面**的那一半固定下来：
 * 工具语义（edit 的三种结局、大输出落地）、插件加载与生命周期、技能多根扫描。
 *
 * 跑法（改完 src/main 先构建再跑）：
 *   node_modules\typescript\bin\tsc -p tsconfig.main.json
 *   node scripts\selftest.js
 *
 * 它只在自己的临时工作区里动手，不碰真实工作区。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');
const BOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-selftest-'));

// fsapi 在模块加载时读这个环境变量，所以必须最先设好
process.env.ENSOUL_WORKSPACE = BOX;

/**
 * 把 electron 换成一个小小的替身。
 * 主进程代码里只有三处用到它（应用目录、用户目录、userData），
 * 替掉之后 dist 里那些模块就能在纯 node 下跑起来。
 */
const stub = (id, exports) => {
  const file = require.resolve(id);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stub('electron', {
  app: {
    getAppPath: () => APP_DIR,
    getPath: (k) => (k === 'home' ? os.homedir() : path.join(BOX, '.userData')),
  },
  ipcMain: { handle() {}, on() {} },
  BrowserWindow: class {},
  dialog: {},
  shell: {},
});

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const write = (rel, text) => {
  const abs = path.join(BOX, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
  return abs;
};
const read = (rel) => fs.readFileSync(path.join(BOX, rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const agent = require(path.join(APP_DIR, 'dist', 'main', 'agent.js'));
  const plugins = require(path.join(APP_DIR, 'dist', 'main', 'plugins.js'));
  const skills = require(path.join(APP_DIR, 'dist', 'main', 'skills.js'));
  const migrate = require(path.join(APP_DIR, 'dist', 'main', 'migrate.js'));

  // ─────────────────────────────── 0. 改名字留下的旧数据要能自动搬过来
  // 工作区里的标记目录：.anycode → .ensoul（改名，不是复制）
  {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-rename-'));
    fs.mkdirSync(path.join(other, '.anycode', 'state'), { recursive: true });
    fs.writeFileSync(path.join(other, '.anycode', 'state', 'todo.json'), '{"items":[{"content":"老数据","status":"pending"}]}', 'utf8');
    migrate.migrateWorkspaceState(other);
    const movedOk = fs.existsSync(path.join(other, '.ensoul', 'state', 'todo.json'));
    const oldGone = !fs.existsSync(path.join(other, '.anycode'));
    check('旧状态目录 .anycode 自动改名为 .ensoul', movedOk && oldGone, movedOk ? '' : '新目录里没看到那份状态');
    // 两边都在时不许乱动 —— 宁可让人自己看
    fs.mkdirSync(path.join(other, '.anycode'), { recursive: true });
    fs.writeFileSync(path.join(other, '.anycode', 'flag'), 'x', 'utf8');
    migrate.migrateWorkspaceState(other);
    check('新旧目录都在时不动手（不覆盖）', fs.existsSync(path.join(other, '.anycode', 'flag')) && movedOk);
    fs.rmSync(other, { recursive: true, force: true });
  }

  // userData：旧 %APPDATA%\anycode 里的真源要搬过来，且只搬一次
  {
    const oldDir = path.join(BOX, 'anycode'); // 替身把 userData 放在 BOX/.userData，父目录就是 BOX
    fs.mkdirSync(path.join(oldDir, 'closed'), { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'workspace.json'), '{"panels":{},"layout":{},"floating":[]}', 'utf8');
    fs.writeFileSync(path.join(oldDir, 'providers.json'), '{"providers":[]}', 'utf8');
    fs.writeFileSync(path.join(oldDir, 'closed', 'p1.json'), '{"title":"关掉的面板"}', 'utf8');
    fs.writeFileSync(path.join(oldDir, 'Cache'), '不该被搬的浏览器缓存', 'utf8');
    migrate.migrateUserData();
    const newDir = path.join(BOX, '.userData');
    check('旧 userData 的 workspace.json 搬过来了', fs.existsSync(path.join(newDir, 'workspace.json')));
    check('旧 userData 的 providers.json（密钥配置）搬过来了', fs.existsSync(path.join(newDir, 'providers.json')));
    check('closed/ 整个目录也搬过来了', fs.existsSync(path.join(newDir, 'closed', 'p1.json')));
    check('浏览器缓存不搬', !fs.existsSync(path.join(newDir, 'Cache')));
    // 再来一次：不能把新数据覆盖回旧的
    fs.writeFileSync(path.join(newDir, 'workspace.json'), '{"panels":{"new":1}}', 'utf8');
    migrate.migrateUserData();
    check('已经搬过就不再动（不覆盖新的）', fs.readFileSync(path.join(newDir, 'workspace.json'), 'utf8').includes('"new"'));
  }

  // ─────────────────────────────────────────────── 1. edit：三种结局
  write('a.txt', 'line one\nline two\nline three\nline two\n');

  const miss = await agent.runTool('edit', { path: 'a.txt', old_string: '不存在的一段', new_string: 'x' });
  check('edit 找不到原文时拒绝', miss.includes('没找到'), miss.split('\n')[0]);

  const dup = await agent.runTool('edit', { path: 'a.txt', old_string: 'line two', new_string: 'LINE 2' });
  check('edit 原文出现多次时拒绝', dup.includes('出现了 2 次'), dup.split('\n')[0]);
  check('edit 被拒绝时文件没动', read('a.txt').includes('line two'));

  const ok = await agent.runTool('edit', { path: 'a.txt', old_string: 'line three', new_string: 'line THREE' });
  check('edit 唯一匹配时改成功', ok.includes('已改 a.txt') && read('a.txt').includes('line THREE'), ok.split('\n')[0]);

  await agent.runTool('edit', { path: 'a.txt', old_string: 'line two', new_string: 'L2', replace_all: true });
  check('edit replace_all 全改', (read('a.txt').match(/L2/g) || []).length === 2 && !read('a.txt').includes('line two'));

  const newFile = await agent.runTool('edit', { path: 'nope.txt', old_string: 'a', new_string: 'b' });
  check('edit 打不开的文件给的是人话', newFile.includes('读不到 nope.txt'), newFile.split('\n')[0]);

  // 写前钩子必须对 edit 也生效（file-backup 就是靠它留底）
  let hooked = 0;
  agent.setExtensions({ beforeWrite: [() => { hooked += 1; }] });
  await agent.runTool('edit', { path: 'a.txt', old_string: 'line one', new_string: 'line ONE' });
  check('edit 会走插件的写前钩子', hooked === 1, `钩子触发 ${hooked} 次`);

  // ─────────────────────────────────────────────── 2. 工具档位
  agent.setExtensions({
    tools: [
      { plugin: 't', spec: { name: 'plug_read', description: '', parameters: {}, level: 'read' } , handler: () => 'r' },
      { plugin: 't', spec: { name: 'plug_write', description: '', parameters: {}, level: 'write' }, handler: () => 'w' },
      { plugin: 't', spec: { name: 'plug_full', description: '', parameters: {} }, handler: () => 'f' },
    ],
  });
  const names = (lv) => agent.toolsFor(lv).map((t) => t.function.name);
  check('read 档只放行 level=read 的插件工具', names('read').includes('plug_read') && !names('read').includes('plug_full'));
  check('write 档放行 read+write', names('write').includes('plug_write') && !names('write').includes('plug_full'));
  check('full 档放行全部插件工具', names('full').includes('plug_full'));
  check('edit 在 write 档就有', names('write').includes('edit'));

  // ─────────────────────────────────────────────── 3. 大输出落地（spill）
  agent.setExtensions({
    tools: [{ plugin: 't', spec: { name: 'big', description: '', parameters: {} }, handler: () => 'A'.repeat(30_000) + 'TAIL_MARK' }],
  });
  const big = await agent.runTool('big', {});
  const spilled = fs.readdirSync(path.join(BOX, '.ensoul', 'spill')).filter((f) => f.includes('big'));
  check('大输出被落地成文件', spilled.length === 1, spilled[0]);
  check('落地后仍给头和尾', big.startsWith('AAA') && big.includes('TAIL_MARK') && big.includes('已存到'));
  check('落地文件是完整正文', spilled.length === 1 && read(path.join('.ensoul', 'spill', spilled[0])).length === 30_009);

  agent.setExtensions({ tools: [], beforeWrite: [] });

  // ─────────────────────────────────────────────── 4. 技能：多根 + 优先级
  write('.ensoul/skills/from-ensoul/SKILL.md', '---\nname: from-ensoul\ndescription: 工作区 .ensoul 里的技能\nwhenToUse: 测试多根扫描\n---\n正文甲\n');
  write('.agents/skills/flat-one.md', '---\nname: flat-one\ndescription: 根上直接一个 md\n---\n正文乙\n');
  // 插件自报的一根（真实场景里由兼容层插件认领它自己的目录；这里用中立目录名）
  write('plug-skills/from-plugin/SKILL.md', '---\nname: from-plugin\ndescription: 插件自报根里的技能\n---\n正文己\n');
  skills.addSkillRoot(path.join(BOX, 'plug-skills'), '插件 测试用', 20);
  write('.ensoul/skills/with-when/SKILL.md', '---\nname: with-when\ndescription: 带 whenToUse 的技能\nwhenToUse: 需要判断该不该用它时\n---\n正文戊\n');

  const list = skills.scanSkills([]);
  const byName = Object.fromEntries(list.map((s) => [s.name, s]));
  check('扫到工作区 .ensoul 里的技能', Boolean(byName['from-ensoul']));
  check('插件自报的技能根也被扫到', Boolean(byName['from-plugin']), byName['from-plugin'] && byName['from-plugin'].source);
  check('根上的单个 .md 也算技能', Boolean(byName['flat-one']));
  // 软件自带那个根指的就是 ensoul 自己的 skills/ 目录（add-tool / fix-build）
  check('软件自带的兜底根仍然生效', Boolean(byName['add-tool']), 'add-tool');
  check('技能带上来源标签', byName['from-ensoul'].source === '工作区 .ensoul', byName['from-ensoul'].source);
  check('readSkill 按名字取到正文', skills.readSkill('flat-one', []).includes('正文乙'));
  check('技能名不存在时列出已有的', skills.readSkill('没这个', []).includes('没有这个技能'));

  // ─────────────────────────────────────────────── 5. 插件：加载、工具、状态、技能根
  const disabled = [];
  let loaded = plugins.loadPlugins(disabled);
  const toolNames = loaded.tools.map((t) => t.spec.name);
  for (const n of ['todo_write', 'todo_read', 'job_start', 'job_list', 'job_output', 'job_kill', 'web_fetch', 'web_search', 'list_backups', 'restore_backup']) {
    check(`插件注册了 ${n}`, toolNames.includes(n));
  }
  check('插件清单带来源', loaded.info.some((p) => p.source === '软件自带'));
  check('没有插件报错', loaded.info.every((p) => !p.error), loaded.info.map((p) => p.error).filter(Boolean).join(';'));

  // 斜杠命令口子：注册进清单、重名先到先得、脏 id 拒收、ctx 递得进 handler（§六 的面板归属）
  write('.ensoul/plugins/tmpcmd/index.js', [
    'module.exports = {',
    "  name: 'tmpcmd',",
    "  description: '斜杠命令口子的自检插件',",
    '  setup(api) {',
    "    api.addCommand({ id: 'hello', label: '问好', hint: '/hello 名字' }, (args, ctx) => '你好 ' + args + '（' + ctx.panelId + '）');",
    "    api.addCommand({ id: 'hello', label: '重复的', hint: '不该在' }, () => 'dup');",
    "    api.addCommand({ id: 'bad id', label: '脏 id', hint: '不该在' }, () => 'bad');",
    '  },',
    '};',
    '',
  ].join('\n'));
  const withCmd = plugins.loadPlugins([]);
  const drawCmd = withCmd.commands.find((c) => c.id === 'draw');
  check('comfyui 注册了 /draw 斜杠命令', Boolean(drawCmd) && drawCmd.plugin === 'comfyui', drawCmd ? `${drawCmd.id}（${drawCmd.plugin}）` : `commands 共 ${withCmd.commands.length} 条`);
  const hellos = withCmd.commands.filter((c) => c.id === 'hello');
  check('工作区插件的命令也进清单', hellos.length >= 1, String(hellos.length));
  check('重名命令先注册的赢', hellos.length === 1 && hellos[0].label === '问好', hellos.map((c) => c.label).join(','));
  check('带空格的脏 id 被拒收', !withCmd.commands.some((c) => c.id === 'bad id'));
  const helloOut = hellos.length ? await hellos[0].handler('世界', { panelId: 'p1', host: 'main', kind: 'chat' }) : '';
  check('命令 handler 收得到 ctx（面板归属递得进去）', helloOut.includes('你好 世界') && helloOut.includes('（p1）'), helloOut);


  const tool = (n) => loaded.tools.find((t) => t.spec.name === n);
  const ctx = { panelId: 'p1', host: 'main', kind: 'chat' };

  // todo：整份替换 + 按面板分槽落盘 + 每轮回到提示里
  // 提示片段现在是 { fn, scope }（核心的 pluginExtras 按面板 kind 过滤）——
  // 自检这里跟核心同一套判断，否则「B 面板看不到 A 的清单」那几条就成了假的。
  const promptOf = (c) => loaded.prompts
    .filter((p) => !p.scope || !p.scope.length || !c.kind || p.scope.includes(c.kind))
    .map((p) => p.fn(c))
    .join('\n');
  const todoState = () => JSON.parse(read('.ensoul/state/todo.json'));

  const t1 = await tool('todo_write').handler({ todos: [{ content: '第一步', status: 'completed' }, { content: '第二步', status: 'in_progress' }] }, ctx);
  check('todo_write 报告了进度', t1.includes('1 完成') && t1.includes('进行中'), t1.split('\n')[0]);
  check('todo 状态按面板分槽落盘', todoState().panels.p1.items.length === 2 && todoState().active === 'p1');
  const prompt = promptOf(ctx);
  check('todo 每轮把清单放回提示', prompt.includes('当前任务清单') && prompt.includes('第二步') && prompt.includes('[~]'));
  const warn = await tool('todo_write').handler({ todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }] }, ctx);
  check('todo 对并行的进行中给出提醒', warn.includes('同时只做一件'));
  await tool('todo_write').handler({ todos: [{ content: '收尾', status: 'in_progress' }] }, ctx);
  check('todo 整份替换而不是追加', todoState().panels.p1.items.length === 1);

  // 面板隔离（make-plugin §六）：A 写的清单不许漂进 B 的眼前 —— "会话污染"最直接的一条来路
  const ctxB = { panelId: 'p2', host: 'main', kind: 'chat' };
  check('B 面板看不到 A 的清单', !promptOf(ctxB).includes('当前任务清单') && !promptOf(ctxB).includes('收尾'), promptOf(ctxB).split('\n')[0] || '（空）');
  await tool('todo_write').handler({ todos: [{ content: 'B 自己的活', status: 'in_progress' }] }, ctxB);
  check('两块面板各占各的槽', todoState().panels.p1.items.length === 1 && todoState().panels.p2.items[0].content === 'B 自己的活');
  check('B 写清单不动 A 的', promptOf(ctx).includes('收尾') && !promptOf(ctx).includes('B 自己的活'));
  check('B 只看得到自己那份', promptOf(ctxB).includes('B 自己的活') && !promptOf(ctxB).includes('收尾'));
  check('todo_read 也只读自己那份', (await tool('todo_read').handler({}, ctx)).includes('收尾') && !(await tool('todo_read').handler({}, ctx)).includes('B 自己的活'));
  await tool('todo_write').handler({ todos: [] }, ctxB);
  check('清空只清自己那格', !todoState().panels.p2 && todoState().panels.p1.items.length === 1);
  // 老格式（扁平、全局就一份）要能搬进分槽结构，一条不丢
  write('.ensoul/state/todo.json', JSON.stringify({ items: [{ content: '老清单', status: 'pending' }], panelId: 'p1', at: 1 }));
  check('老格式搬到它记着的那块面板名下', promptOf(ctx).includes('老清单') && !promptOf(ctxB).includes('老清单'));

  // work-ledger：构建报错要按归属分段 —— 别人改到一半的文件，模型不许当自己的活接过来
  const hook = async (done) => {
    let text = done.result;
    for (const f of loaded.afterTool) {
      const r = await f({ ...done, result: text });
      if (typeof r === 'string' && r) text = r;
    }
    return text;
  };
  const wrote = (p) => ({ name: 'edit', args: { path: p }, result: `已改 ${p} 第 1 行：行数不变，现在 12 字符。` });
  await hook({ ...wrote('src/mine.ts'), ctx });
  await hook({ ...wrote('src/theirs.ts'), ctx: ctxB });
  const rawBuild = '构建没过 —— 先把下面这些错修掉。\n\n```\nsrc/mine.ts(3,1): error TS1005: x\nsrc/theirs.ts(7,2): error TS2345: y\n```';
  const stamped = await hook({ name: 'build_project', args: {}, ctx, result: rawBuild });
  check('构建报错标出别人改过的文件', stamped.includes('不是这块面板改的') && stamped.includes('src/theirs.ts'), stamped.split('\n')[0]);
  check('自己改过的文件仍然认归自己', stamped.includes('那部分才归你') && stamped.includes('src/mine.ts'));
  const onlyMine = await hook({ name: 'build_project', args: {}, ctx, result: '构建没过\n\n```\nsrc/mine.ts(3,1): error TS1005: x\n```' });
  check('报错全落在自己改的文件上时不插话', onlyMine.startsWith('构建没过') && !onlyMine.includes('不是这块面板改的'), onlyMine.split('\n')[0]);

  // jobs：起、读、收
  const j1 = await tool('job_start').handler({ command: 'echo one & ping -n 2 127.0.0.1 >nul & echo two', label: '自检短任务' }, ctx);
  const jid = (j1.match(/已起：(j\w+)/) || [])[1];
  check('job_start 返回 id', Boolean(jid), jid);
  const j2 = await tool('job_start').handler({ command: 'ping -n 20 127.0.0.1 >nul', label: '自检长任务' }, ctx);
  const longId = (j2.match(/已起：(j\w+)/) || [])[1];

  const list1 = await tool('job_list').handler({}, ctx);
  check('job_list 列得出两个任务', list1.includes(jid) && list1.includes(longId) && list1.includes('[running]'), list1.split('\n')[0]);
  const listOther = await tool('job_list').handler({}, ctxB);
  check('别人的后台任务标出归属', listOther.includes(jid) && listOther.includes('（别的面板起的）'), listOther.split('\n')[0]);

  const out1 = await tool('job_output').handler({ job_id: jid, wait: true, timeout_ms: 15000 }, ctx);
  check('job_output(wait) 等到了结束', /\[status: (done|failed)/.test(out1), (out1.match(/\[status: [^\]]+\]/) || [])[0]);
  check('job_output 给到了输出内容', out1.includes('one') && out1.includes('two'));

  const out2 = await tool('job_output').handler({ job_id: jid }, ctx);
  check('job_output 第二次只给增量（不重复灌）', out2.includes('还没有新输出'), out2.split('\n')[0]);

  const killed = await tool('job_kill').handler({ job_id: longId, reason: '自检' }, ctx);
  check('job_kill 接受请求', killed.includes('已请求收掉'));
  let st = '';
  for (let i = 0; i < 20; i += 1) {
    await sleep(300);
    st = await tool('job_output').handler({ job_id: longId }, ctx);
    if (/\[status: killed/.test(st)) break;
  }
  check('长任务真的被收掉了', /\[status: killed/.test(st), (st.match(/\[status: [^\]]+\]/) || [])[0]);
  check('任务日志落到了盘上', fs.existsSync(path.join(BOX, '.ensoul', 'jobs', `${jid}.log`)));

  // web：内网地址必须被挡掉
  const blocked = await tool('web_fetch').handler({ url: 'http://127.0.0.1:9/secret' }, ctx);
  check('web_fetch 拒绝环回地址', blocked.includes('只连公网'), blocked.split('\n')[0]);
  const blocked2 = await tool('web_fetch').handler({ url: 'http://192.168.1.1/' }, ctx);
  check('web_fetch 拒绝内网地址', blocked2.includes('内网'), blocked2.split('\n')[0]);

  // git：新文件分成「该上传 / 该忽略」两类，并且能把建议补进 .gitignore。
  // 状态是**工作区级**的（谁看都是同一份分支和改动），这里验的就是那个共享事实。
  {
    const { spawnSync } = require('child_process');
    spawnSync('git', ['init'], { cwd: BOX, windowsHide: true });
    write('src/main.ts', 'export const a = 1;\n'); // 源码：该上传
    write('_scratch/note.txt', '草稿\n'); // 草稿：该忽略
    write('debug.log', '噪音\n'); // 日志：该忽略

    check('插件注册了 git_status / git_ignore', Boolean(tool('git_status')) && Boolean(tool('git_ignore')));
    const gs = await tool('git_status').handler({}, ctx);
    check('git_status 分得出该上传的新文件', gs.includes('该上传') && gs.includes('src/main.ts'), gs.split('\n')[0]);
    check('git_status 标出该忽略的临时文件', gs.includes('该忽略') && gs.includes('_scratch/note.txt') && gs.includes('debug.log'));
    check('git_status 给出该补进 .gitignore 的条目', gs.includes('建议补进 .gitignore') && gs.includes('_scratch/') && gs.includes('*.log'));
    check('git 每轮把这份分类摆进提示', promptOf(ctx).includes('该上传'), promptOf(ctx).split('\n')[0]);

    const gi = await tool('git_ignore').handler({ entries: ['.ensoul/', '*.log', '_scratch/'] }, ctx);
    check('git_ignore 把条目补进 .gitignore', gi.includes('已把 3 条') && read('.gitignore').includes('_scratch/'), gi.split('\n')[0]);

    const again = await tool('git_status').handler({}, ctx);
    check('补过之后临时文件都算被盖住了', !again.includes('还没被 .gitignore 盖住') && again.includes('src/main.ts'));
  }

  // file-backup：改写前留底（用 edit 走一遍真实链路）
  const backups = () => {
    try {
      return fs.readdirSync(path.join(BOX, '.ensoul', 'backups'));
    } catch {
      return [];
    }
  };
  const slotsBefore = backups().length;
  agent.setExtensions({ tools: loaded.tools, beforeWrite: loaded.beforeWrite });
  await agent.runTool('edit', { path: 'a.txt', old_string: 'line ONE', new_string: 'line 1' });
  check('file-backup 在 edit 之前留了底', backups().length > slotsBefore, backups().join(','));
  check('留底的是改动前的内容', read(`.ensoul/backups/a.txt/${fs.readdirSync(path.join(BOX, '.ensoul', 'backups', 'a.txt'))[0]}`).includes('line ONE'));

  // 插件改文件后应当自动重载（实例留住 + 看 mtime）
  const jobsIndex = path.join(APP_DIR, 'plugins', 'jobs', 'index.js');
  const original = fs.readFileSync(jobsIndex, 'utf8');
  try {
    fs.writeFileSync(jobsIndex, original.replace("description: '后台", "description: '（改过）后台"), 'utf8');
    const again = plugins.loadPlugins(disabled);
    check('插件文件改过后自动重载', again.info.find((p) => p.name === 'jobs').description.includes('改过'));
  } finally {
    fs.writeFileSync(jobsIndex, original, 'utf8');
    plugins.loadPlugins(disabled);
  }

  // 停用一个插件：它的工具必须一起消失
  const off = plugins.loadPlugins(['todo']);
  check('停用插件后工具消失', !off.tools.some((t) => t.spec.name === 'todo_write') && off.info.find((p) => p.name === 'todo').enabled === false);

  // 网络那一步可以是断的：只报告，不算失败
  try {
    const page = await tool('web_fetch').handler({ url: 'https://example.com', max_chars: 2000 }, ctx);
    console.log(`INFO  web_fetch 真实抓取：${page.split('\n')[0].slice(0, 120)}`);
  } catch (e) {
    console.log(`INFO  web_fetch 真实抓取失败（这台机器可能上不了外网）：${e && e.message}`);
  }

  // our-free-model：工具声明必须在**每一条线**上都活得下来，整两遍也不许丢。
  // 这条是踩过的：转发口先按"进来的请求长什么样"整一遍形（chat 形状 {function:{name}}），
  // 适配器再按上游的线整一遍 —— 第二遍只认 tool.name，于是每个真工具都被丢掉，
  // 模型手上只剩指纹门补的 bash/glob/grep/read 四个假工具，外带 tool_choice:'none'。
  // 后果是走免费车道的员工"一件工具都没有"，而且一句错都不报。
  {
    const { pathToFileURL } = require('url');
    const messagesMod = await import(pathToFileURL(path.join(APP_DIR, 'plugins', 'our-free-model', 'lib', 'messages.js')).href);
    const spec = { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] };
    const flat = [{ name: 'run_command', description: '跑个命令', parameters: spec }];
    const chat = messagesMod.toToolDefs(flat, 'chat');
    check('工具整形出 chat 形状', chat.length === 1 && chat[0].function.name === 'run_command');
    const again = messagesMod.toToolDefs(chat, 'chat');
    check('chat 形状再整一遍不丢工具', again.length === 1 && again[0].function.name === 'run_command', JSON.stringify(again).slice(0, 120));
    check('再整一遍参数 schema 还在', again.length === 1 && again[0].function.parameters.required?.[0] === 'command');
    const claude = messagesMod.toToolDefs(chat, 'claude');
    check('chat 形状能整成 claude 形状且 schema 不丢', claude.length === 1 && claude[0].name === 'run_command' && claude[0].input_schema.required?.[0] === 'command');
    const roundTrip = messagesMod.toToolDefs(claude, 'chat');
    check('claude 形状也能整回 chat 形状', roundTrip.length === 1 && roundTrip[0].function.name === 'run_command' && roundTrip[0].function.parameters.required?.[0] === 'command');
  }

  // ─────────────────────────────────────────────── 收尾
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('没过的：');
    for (const f of failed) console.log(`  · ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  return failed.length ? 1 : 0;
}

main()
  .then((code) => {
    try {
      fs.rmSync(BOX, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不影响结论 */
    }
    process.exit(code);
  })
  .catch((e) => {
    console.error('自检自己崩了：', e);
    process.exit(2);
  });
