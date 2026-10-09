/**
 * 后台任务 —— 异步长任务生命周期看护与输出流式监听。
 *
 * 为什么必须有：run_command 是**同步等到底**的（120 秒就砍）。可真正花时间的事
 * 恰恰是那种"起来之后一直在跑"的：dev server、watch 构建、跑一遍测试。
 * 拿 run_command 去跑它们，只有两种结果 —— 等 120 秒白等，或者被 timeout 砍掉。
 *
 * 所以这里是四个工具一套：
 *   job_start   起一个后台命令，立刻拿到 id 和开头几行
 *   job_list    看手上有哪些活、都是什么状态
 *   job_output  读输出（只给**上次读之后新增的**，不重复灌）
 *   job_kill    收掉（连整棵进程树一起，不然端口会一直被占着）
 *
 * 三条纪律，写在这里也写进工具说明里：
 *   1. 起来的每一个 id 都要记住，最后**要么读完、要么收掉**，别留一堆野进程。
 *   2. 不要在任务刚起来就死等 —— 它不会主动叫你，你该去干别的，回头用 job_list 看。
 *   3. 输出同时落盘 `.ensoul/jobs/<id>.log`：内存里只留最近的，但一个字都没丢。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/** 内存里每个任务最多留这么多输出（超出从头截掉），磁盘上的日志不截 */
const KEEP_CHARS = 200_000;
const WAIT_MS = 30_000;
const WAIT_MAX = 120_000;

const jobs = new Map();
let seq = 0;
/** 卸载时的收尾动作（宿主在改插件文件 / 退出时会调 dispose） */
let cleanup = null;

const now = () => Date.now();
const secs = (ms) => Math.round(ms / 100) / 10;

function newId() {
  seq += 1;
  return `j${Date.now().toString(36).slice(-4)}${seq}`;
}

/**
 * 别的面板起的任务：看得见，但必须说明归属 —— 不然模型会把它当成自己那摊，
 * 接着去办别人那件活（跨面板串味的另一种形态，跟任务清单是同一个坑）。
 */
function noteOwner(job, ctx) {
  const mine = (ctx && ctx.panelId) || '';
  return job && job.owner && job.owner !== mine ? '（这是「别的面板」起的任务，不是你手上的那件）\n' : '';
}

function statusOf(job) {
  if (job.child) return 'running';
  if (job.killed) return 'killed';
  return job.code === 0 ? 'done' : 'failed';
}

module.exports = {
  name: 'jobs',
  storage: { project: ['.ensoul/state/jobs.json', '.ensoul/jobs'] },
  description: t('后台任务：起长命令（dev server、watch、测试）并随时读输出、收掉，不占用对话'),

  setup(api) {
    const root = () => api.workspace;
    const logFile = (id) => path.join('.ensoul', 'jobs', `${id}.log`);

    /** 状态镜像到工作区，界面上的面板可以直接读（不必为它开 IPC） */
    const mirror = () => {
      api.state.save({
        jobs: [...jobs.values()].map((j) => ({
          id: j.id,
          label: j.label,
          command: j.command,
          workspace: j.workspace,
          cwd: j.cwd,
          status: statusOf(j),
          startedAt: j.startedAt,
          endedAt: j.endedAt || 0,
          code: j.code,
          lines: j.text ? j.text.split('\n').length : 0,
        })),
      });
    };

    const append = (job, chunk) => {
      const s = String(chunk);
      job.text += s;
      if (job.text.length > KEEP_CHARS) {
        const cut = job.text.length - KEEP_CHARS;
        job.dropped += cut;
        job.text = job.text.slice(cut);
        job.readAt = Math.max(0, job.readAt - cut);
      }
      try {
        const abs = api.dataPath(logFile(job.id));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.appendFileSync(abs, s, 'utf8');
      } catch {
        /* 日志落不下来不能挡住任务本身 */
      }
    };

    /** 读"上次之后新增的部分"。tail=true 时改成读最后 N 行 */
    const slice = (job, tail) => {
      if (tail > 0) {
        const lines = job.text.split('\n');
        return { text: lines.slice(-tail).join('\n'), from: Math.max(0, lines.length - tail) };
      }
      const text = job.text.slice(job.readAt);
      job.readAt = job.text.length;
      return { text, from: -1 };
    };

    const finishLine = (job) => {
      const detail = `[status: ${statusOf(job)}${job.code != null ? `, exit ${job.code}` : ''}]`;
      return `${detail} 已跑 ${secs((job.endedAt || now()) - job.startedAt)} 秒。完整日志：${logFile(job.id).split(path.sep).join('/')}`;
    };

    api.addTool(
      {
        name: 'job_start', kits: ['ops'],
        description:
          t('起一个后台命令（dev server、watch、长测试这类"起来后一直在跑"的活）。立刻返回，不阻塞对话。')
          + t('返回的 job_id 要记住：**完事之后要么 job_output 读完、要么 job_kill 收掉**，不然它会一直挂着占端口。')
          + t('任务结束不会主动叫你 —— 用 job_list 看状态。要等结果就先干别的，回头再读。')
          + t('跑完就结束的短命令（几十秒内出结果）用 run_command 更直接。'),
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: t('要跑的命令，在工作区目录下执行') },
            label: { type: 'string', description: t('给这件事起个短名字（列表里好看）') },
            workdir: { type: 'string', description: t('执行子目录（相对工作区路径，可选）') },
          },
          required: ['command'],
        },
      },
      (args, ctx) => {
        const command = String((args && args.command) || '').trim();
        if (!command) return t('job_start 需要 command。');
        const id = newId();
        const job = {
          id,
          // 谁起的活归谁 —— 别的面板看得见，但不该把它当成自己那摊（见 noteOwner）
          owner: (ctx && ctx.panelId) || '',
          label: String((args && args.label) || '').trim() || command.slice(0, 40),
          command,
          workspace: root(),
          cwd: (args && args.workdir) ? path.resolve(root(), String(args.workdir)) : root(),
          child: null,
          text: '',
          readAt: 0,
          dropped: 0,
          startedAt: now(),
          endedAt: 0,
          code: null,
          killed: false,
        };

        try {
          job.child = spawn(command, {
            cwd: job.cwd,
            shell: true,
            windowsHide: true,
            env: { ...process.env, FORCE_COLOR: '0' },
          });
        } catch (e) {
          return `起不来：${(e && e.message) || e}`;
        }

        jobs.set(id, job);
        job.child.stdout && job.child.stdout.on('data', (b) => append(job, b));
        job.child.stderr && job.child.stderr.on('data', (b) => append(job, b));
        job.child.on('error', (err) => {
          append(job, `\n（进程出错：${err.message}）`);
          job.code = -1;
          job.child = null;
          job.endedAt = now();
          mirror();
        });
        job.child.on('exit', (code) => {
          append(job, `\n（结束，退出码 ${code == null ? '?' : code}）`);
          job.code = code == null ? -1 : code;
          job.child = null;
          job.endedAt = now();
          mirror();
        });
        mirror();

        return (
          `已起：${id}（${job.label}）\n`
          + t('命令：${command}\n')
          + `日志：${logFile(id).split(path.sep).join('/')}\n\n`
          + t('接下来别在这儿等 —— 去干别的，回头用 job_list / job_output 看它。')
        );
      },
    );

    api.addTool(
      {
        name: 'job_list', kits: ['ops'],
        description: t('看手上有哪些后台任务，各自的 id、状态、跑了多久。'),
        parameters: { type: 'object', properties: {} },
      },
      (args, ctx) => {
        if (!jobs.size) return t('现在没有后台任务。');
        const mine = (ctx && ctx.panelId) || '';
        return [...jobs.values()]
          .map((j) => {
            const st = statusOf(j);
            const ms = (j.endedAt || now()) - j.startedAt;
            const whose = j.owner && j.owner !== mine ? t('（别的面板起的）') : '';
            return `${j.id}  [${st}]  ${secs(ms)}s  ${j.label}${whose}`;
          })
          .join('\n');
      },
    );

    api.addTool(
      {
        name: 'job_output', kits: ['ops'],
        description:
          t('读某个后台任务的输出。默认只给**上次读之后新增的**部分（不重复灌上下文）。')
          + t('wait: true 会等它结束（最多 2 分钟）—— 只有你真的被它挡住时才这么用。')
          + t('tail 想直接看最后几行日志时用。每次返回最后都带一行 [status: ...]。'),
        parameters: {
          type: 'object',
          properties: {
            job_id: { type: 'string' },
            tail: { type: 'number', description: t('只看最后这么多行（不看增量）') },
            wait: { type: 'boolean', description: t('等它结束（最多 2 分钟）；默认不等') },
            timeout_ms: { type: 'number', description: t('等多久，默认 30000，上限 120000') },
          },
          required: ['job_id'],
        },
      },
      async (args, ctx) => {
        const id = String((args && args.job_id) || '');
        const job = jobs.get(id);
        const ownerNote = noteOwner(job, ctx);
        if (!job) {
          const have = [...jobs.keys()].join('、') || t('（一个都没有）');
          return `没有这个任务：${id || '（没给 id）'}\n现有的：${have}`;
        }

        if (args && args.wait && job.child) {
          const cap = Math.min(WAIT_MAX, Math.max(1, Number(args.timeout_ms) || WAIT_MS));
          await new Promise((resolve) => {
            const done = () => {
              clearTimeout(timer);
              job.child && job.child.removeListener('exit', done);
              resolve();
            };
            const timer = setTimeout(done, cap);
            job.child.on('exit', done);
          });
        }

        const { text } = slice(job, Number(args && args.tail) || 0);
        const head = job.dropped ? `（前面 ${job.dropped} 字符已从内存里滚掉，完整日志在 ${logFile(job.id).split(path.sep).join('/')}）\n` : '';
        const body = text.trim() ? text.replace(/\s+$/, '') : t('（还没有新输出）');
        return `${ownerNote}${head}${body}\n\n${finishLine(job)}`;
      },
    );

    api.addTool(
      {
        name: 'job_send_input', kits: ['ops'],
        description: t('向正在运行的后台任务标准输入 (stdin) 写入一段文本或按键交互（如 y/n、回车换行、控制指令）。'),
        parameters: {
          type: 'object',
          properties: {
            job_id: { type: 'string', description: t('任务 ID') },
            input: { type: 'string', description: t('要输入的字符文本内容') },
            enter: { type: 'boolean', description: t('是否自动在末尾追加回车换行 (默认 true)') },
          },
          required: ['job_id', 'input'],
        },
      },
      (args, ctx) => {
        const id = String((args && args.job_id) || '');
        const job = jobs.get(id);
        if (!job) return t('没有这个任务：') + id;
        if (!job.child || !job.child.stdin || job.child.stdin.destroyed) {
          return t('任务当前未在运行或 stdin 已关闭：') + id;
        }
        const text = String((args && args.input) ?? '');
        const withEnter = args && args.enter === false ? text : (text + '\n');
        try {
          job.child.stdin.write(withEnter);
          append(job, '\n[stdin] ' + text + (args && args.enter === false ? '' : '\n'));
          return t('已向任务 ') + id + t(' 的 stdin 写入 ') + withEnter.length + t(' 字符。');
        } catch (e) {
          return t('写入 stdin 失败: ') + ((e && e.message) || e);
        }
      }
    );

    api.addTool(
      {
        name: 'job_kill', kits: ['ops'],
        description: t('收掉一个后台任务（连它拉起来的子进程一起收，不然端口会被一直占着）。'),
        parameters: {
          type: 'object',
          properties: { job_id: { type: 'string' }, reason: { type: 'string' } },
          required: ['job_id'],
        },
      },
      (args, ctx) => {
        const id = String((args && args.job_id) || '');
        const job = jobs.get(id);
        if (!job) return `没有这个任务：${id || '（没给 id）'}`;
        if (!job.child) return `${id} 已经结束了（${statusOf(job)}）。`;
        const ownerNote = noteOwner(job, ctx);

        job.killed = true;
        const pid = job.child.pid;
        try {
          if (process.platform === 'win32') {
            // /T 一起收子进程树；不带的话 shell 底下的 node 会留下来占端口
            spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
          } else {
            job.child.kill('SIGKILL');
          }
        } catch (e) {
          try {
            job.child.kill();
          } catch {
            /* 已经没了 */
          }
        }
        append(job, `\n（已请求收掉${args && args.reason ? `：${args.reason}` : ''}）`);
        mirror();
        return `${ownerNote}已请求收掉 ${id}（pid ${pid}）。状态会在它真的退出后变成 killed。`;
      },
    );

    // 实例被卸载（改了插件文件 / 退出）时，别把手上的进程留在外面
    cleanup = () => {
      for (const job of jobs.values()) {
        if (!job.child) continue;
        job.killed = true;
        try {
          if (process.platform === 'win32') spawn('taskkill', ['/pid', String(job.child.pid), '/T', '/F'], { windowsHide: true });
          else job.child.kill('SIGKILL');
        } catch {
          /* 收不掉就算了，不能因为清理失败把卸载卡住 */
        }
      }
    };

    api.log(t('后台任务就绪（日志目录：.ensoul/jobs/）'));
  },

  /** 插件宿主卸载我时调这个 */
  dispose() {
    if (!cleanup) return;
    try {
      cleanup();
    } finally {
      cleanup = null;
    }
  },
};
