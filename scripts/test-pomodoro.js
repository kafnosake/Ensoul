// 回归测试：拿假 api + 可推进的假时钟跑 plugins/pomodoro
// 验：命令（认 seq）、暂停续跑、结算换段、第 4 个长休、自动接续、重置、预设、坏状态不炸
const fs = require('fs');
const path = require('path');

const WS = path.join(__dirname, '..', '.ensoul', 'tmp', 'pomo-test-ws');
fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(path.join(WS, '.ensoul', 'state'), { recursive: true });
const STATE = path.join(WS, '.ensoul', 'state', 'pomodoro.json');
const CMD = path.join(WS, '.ensoul', 'state', 'pomodoro.cmd.json');
const MIN = 60000;

// 假时钟：插件里所有 Date.now() 都听我们的
let now = 1_700_000_000_000;
Date.now = () => now;

let fails = 0;
const ok = (cond, label) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + label);
  if (!cond) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 等插件的一跳（300ms）跑完 */
const tick = () => sleep(400);

const disk = { load: () => null, save: (v) => disk.value = v };

function makeApi(seed) {
  let saved = seed ?? null;
  return {
    workspace: WS,
    log: () => {},
    state: {
      load: () => saved,
      save: (v) => {
        saved = JSON.parse(JSON.stringify(v));
        fs.writeFileSync(STATE, JSON.stringify(saved, null, 2));
      },
    },
    _saved: () => saved,
  };
}

let seqN = 0;
/** 像面板那样往队列里追一条（读-改-写，面板是唯一的写方） */
const cmd = (panelId, body) => {
  seqN += 1;
  let q = [];
  try {
    const j = JSON.parse(fs.readFileSync(CMD, 'utf8'));
    if (Array.isArray(j.cmds)) q = j.cmds;
  } catch {
    q = [];
  }
  q.push({ seq: now * 1000 + seqN, panelId, ...body });
  fs.writeFileSync(CMD, JSON.stringify({ cmds: q }));
};
const queue = () => {
  try {
    return JSON.parse(fs.readFileSync(CMD, 'utf8')).cmds;
  } catch {
    return [];
  }
};
const panels = () => JSON.parse(fs.readFileSync(STATE, 'utf8')).panels;
const P = 'panel-test';

(async () => {
  const api = makeApi(null);
  const plugin = require(path.join(__dirname, '..', 'plugins', 'pomodoro', 'index.js'));
  ok(plugin.name === 'pomodoro', '插件名叫 pomodoro');
  plugin.setup(api);
  ok(fs.existsSync(STATE) === false, '刚装好还没人用 —— 不写文件');

  // ---------------------------------------------------------- 开始 / 暂停
  cmd(P, { cmd: 'toggle' });
  await tick();
  let c = panels()[P];
  ok(!!c, 'toggle 之后这个面板有了时钟');
  ok(c.running === true, 'toggle：开始计时');
  ok(Math.abs(c.until - (now + 25 * MIN)) < 1000, '到点时刻 = 现在 + 25 分钟（存的是绝对时刻）');
  ok(c.phase === 'work' && c.done === 0, '一开始是专注，番茄数 0');

  // 同一个命令文件被重复读到，不能重复执行
  await tick();
  c = panels()[P];
  ok(c.running === true, '同一个文件被重复读 —— 认 seq，没有翻转成暂停');

  now += 10 * MIN;
  cmd(P, { cmd: 'toggle' });
  await tick();
  c = panels()[P];
  ok(c.running === false, '再 toggle：暂停');
  ok(Math.abs(c.left - 15 * MIN) < 1000, '暂停时把剩下的 15 分钟存下来（不是重新数 25）');

  cmd(P, { cmd: 'toggle' });
  await tick();
  c = panels()[P];
  ok(c.running === true && Math.abs(c.until - (now + 15 * MIN)) < 1000, '继续：接着剩下的 15 分钟跑');

  // ---------------------------------------------------------- 到点结算
  now += 15 * MIN + 1000;
  await tick();
  c = panels()[P];
  ok(c.phase === 'short', '专注到点 → 短休息');
  ok(c.done === 1, '结算了一个番茄');
  ok(c.running === false, '没勾自动接续：停下等你');
  ok(Math.abs(c.left - 5 * MIN) < 1000, '短休 5 分钟待开始');

  // ---------------------------------------------------------- 重置 / 跳过
  cmd(P, { cmd: 'skip' });
  await tick();
  c = panels()[P];
  ok(c.phase === 'work', '跳过短休 → 回到专注');

  cmd(P, { cmd: 'preset', work: 50, short: 10, long: 20 });
  await tick();
  c = panels()[P];
  ok(c.cfg.work === 50 && c.cfg.short === 10 && c.cfg.long === 20, '换节奏：50/10/20');
  ok(Math.abs(c.left - 50 * MIN) < 1000, '没在跑时换节奏，当前这一段跟着变长');

  cmd(P, { cmd: 'reset' });
  await tick();
  c = panels()[P];
  ok(c.running === false && Math.abs(c.left - 50 * MIN) < 1000, '重置：回到这一段的开头');

  cmd(P, { cmd: 'preset', work: 25, short: 5, long: 15 });
  await tick();

  // ---------------------------------------------------------- 自动接续 + 第 4 个长休
  cmd(P, { cmd: 'auto', value: true });
  cmd(P, { cmd: 'sound', value: false });
  await tick();
  c = panels()[P];
  ok(c.cfg.auto === true && c.cfg.sound === false, '同一跳里发的两条命令都没丢（队列）');
  ok(queue().length === 0, '执行完的队列被清空了');

  // 陈旧命令回灌（面板读-改-写撞上插件清空时会这样）：不许执行第二次
  const stale = { seq: now * 1000 + 1, panelId: P, cmd: 'toggle' };
  fs.writeFileSync(CMD, JSON.stringify({ cmds: [stale] }));
  await tick();
  c = panels()[P];
  ok(c.cfg.auto === true, '回灌的旧命令不会被执行第二次（认 seq）');

  // 连着跑 4 个番茄：第 4 个结束该给长休（已经跑着就不再 toggle —— 那会把它暂停）
  const go = async (mins) => {
    if (!panels()[P].running) {
      cmd(P, { cmd: 'toggle' });
      await tick();
    }
    now += mins * MIN + 1000;
    await tick();
  };
  await go(25); // 第 2 个（done 1 → 2），phase 会变成 short
  c = panels()[P];
  ok(c.done === 2, '第 2 个番茄结算了');
  ok(c.running === true, '勾了自动接续 —— 休息也自己跑起来了');
  ok(c.phase === 'short', '短休自动开始');

  await go(5); // 休息结束 → 专注，自动跑
  c = panels()[P];
  ok(c.phase === 'work' && c.running === true, '休息到点 → 自动回到专注');

  now += 25 * MIN + 1000;
  await tick();
  c = panels()[P];
  ok(c.done === 3, '第 3 个番茄结算了');

  now += 5 * MIN + 1000;
  await tick();
  c = panels()[P];
  ok(c.phase === 'work' && c.running === true, '短休到点 → 回到专注（第 4 个）');

  now += 25 * MIN + 1000;
  await tick();
  c = panels()[P];
  ok(c.done === 4, '第 4 个番茄结算了');
  ok(c.phase === 'long', '第 4 个之后给长休（不是短休）');
  ok(Math.abs(c.cfg.long * MIN - c.left) < 1000, '长休 15 分钟');

  plugin.dispose();

  // ---------------------------------------------------------- 坏数据 / 多个面板
  const bad = makeApi({ panels: { x: { phase: 'nope' }, y: 'not-an-object', [P]: { phase: 'work', cfg: { work: 'abc' }, done: -5 } } });
  const p2 = require(path.join(__dirname, '..', 'plugins', 'pomodoro', 'index.js'));
  p2.setup(bad);
  await tick();
  ok(true, '坏状态文件不会把插件炸掉');
  cmd(P, { cmd: 'reset' }); // 逼它落一次盘，好检查归一化后的样子
  await tick();
  const bad2 = bad._saved() || {};
  const y = (bad2.panels || {})[P];
  ok(y && y.cfg.work === 25, '认不出的节奏退回默认 25 分');
  ok(y && y.done === 0, '负数番茄数夹回 0');
  ok(y && !!y.seen, '没有 seen 的老状态按"刚刚"算 —— 不会一升级就被清掉');
  ok(!(bad2.panels || {}).x, 'phase 不合法的条目直接丢掉');
  p2.dispose();

  // 跑着的时钟，面板关掉也照走：换一个面板，谁也不干扰谁
  const multi = makeApi(null);
  const p3 = require(path.join(__dirname, '..', 'plugins', 'pomodoro', 'index.js'));
  p3.setup(multi);
  cmd('panelA', { cmd: 'toggle' });
  await tick();
  cmd('panelB', { cmd: 'toggle' });
  await tick();
  const all = JSON.parse(fs.readFileSync(STATE, 'utf8')).panels;
  ok(Object.keys(all).length === 2, '两个面板各记各的时钟');
  ok(all.panelA.running && all.panelB.running, '两个都在跑');
  p3.dispose();
  fs.rmSync(CMD, { force: true });

  console.log(fails ? `\n${fails} 项没过` : '\n全部通过');
  process.exit(fails ? 1 : 0);
})();
