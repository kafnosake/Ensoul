/**
 * 计划模式 —— 先只读探查、出一份计划、等用户点头，才允许动文件。
 *
 * 为什么要有它：模型最常见的坏习惯是「边想边改」—— 第一处还没看清就往里写，
 * 改到第三处才发现方向错了，这时前两处已经落盘。计划模式给这一轮加一道门：
 * 进入之后编辑类工具一律被拦下，模型只能读；它把打算怎么做写进一份计划，
 * 用户看过、点了同意（还能留一句批注），门才放开。
 *
 * 这道门为什么放在插件里：核心的 onBeforeTool 天生就是「拦下这次调用」的口子，
 * 而「什么条件下算在做计划」是一条策略 —— 核心不该认识这两个字。
 */

const WRITE_TOOLS = new Set(['edit', 'write_file', 'patch_apply']);
const MUTATING_EXTRA = new Set(['run_command', 'build_project', 'restart_project', 'start_project', 'stop_project']);

/** 面板 id -> 计划状态 { active, plan, askedAt } */
const modes = new Map();

function isActive(panelId) {
  const one = modes.get(panelId);
  return !!(one && one.active);
}

module.exports = {
  name: 'plan-mode',
  description: t('计划模式：先只读探查、出计划、等用户点头才放行改文件'),

  setup(api) {
    /** 内部收尾件：用户点完之后核心来跑它，把答案交回来 */
    const waiting = new Map();

    const settle = (panelId, value) => {
      const w = waiting.get(panelId);
      if (!w) return false;
      waiting.delete(panelId);
      if (w.off) w.off();
      w.resolve(value);
      return true;
    };

    // 1. 进/出计划模式
    api.addTool(
      {
        name: 'plan_mode',
        level: 'read',
        kits: ['planner', 'dev'],
        description:
          t('进入或退出**计划模式**。进入之后编辑类工具（edit / write_file / patch_apply）会被拦下，')
          + t('你只能读代码、查资料；把打算怎么做讲清楚，再用 plan_submit 交给用户审批。')
          + t('大改动、动架构、用户说「先说说你打算怎么做」时用它 —— 别一上手就改。'),
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['enter', 'exit', 'status'], description: t('enter 进入 / exit 退出 / status 看现在是不是在计划模式') },
            reason: { type: 'string', description: t('可选：为什么进入计划模式（一句话，会显示给用户）') },
          },
          required: ['action'],
        },
      },
      (args, ctx) => {
        const panelId = (ctx && ctx.panelId) || '';
        const action = String((args && args.action) || 'status');
        if (action === 'status') {
          return isActive(panelId)
            ? t('现在**在**计划模式：只能读，不能改文件。写完计划用 plan_submit 交给用户。')
            : t('现在不在计划模式：可以正常改文件。要做大改动的话，先用 plan_mode(enter) 进计划模式。');
        }
        if (action === 'enter') {
          const reason = (args && args.reason) ? String(args.reason) : '';
          modes.set(panelId, { active: true, plan: '', reason: reason, askedAt: 0 });
          return [
            t('已进入计划模式。现在开始只读探查：'),
            t('· 可以用的：read_file / grep / glob / list_dir / search / symbol_find / code_slice / web_fetch 等只读工具'),
            t('· 会被拦下的：edit / write_file / patch_apply（以及 run_command、构建、起停进程）'),
            t('把该怎么改想清楚之后，调 plan_submit 把步骤写成一份计划交上去 —— 用户点头才放行。'),
          ].join('\n');
        }
        modes.delete(panelId);
        return t('已退出计划模式，可以正常改文件了。');
      },
    );

    // 2. 提交计划、等用户点头
    api.addTool(
      {
        name: 'plan_submit',
        level: 'read',
        kits: ['planner'],
        description:
          t('把一份实施计划交给用户审批，调用会**一直等到用户答复**。')
          + t('用户同意之后你才能改文件；被拒绝时把用户写的理由读进去，改计划再来。')
          + t('计划要具体到文件和步骤（改哪个文件、怎么改、改完怎么验证），别写空话。'),
        parameters: {
          type: 'object',
          properties: {
            plan: { type: 'string', description: t('计划正文（Markdown，分步骤写清改哪里、怎么验证）') },
          },
          required: ['plan'],
        },
        timeoutMs: 0,
      },
      (args, ctx) => {
        const panelId = (ctx && ctx.panelId) || '';
        if (!panelId) return t('拿不到是哪块面板在提交计划。');
        const plan = String((args && args.plan) || '').trim();
        if (!plan) return t('plan 是空的 —— 没写计划就别提交。');
        if (!isActive(panelId)) {
          return t('现在不在计划模式（可能已经退出）—— 计划已经记下，你可以直接动手；要重新走审批就先 plan_mode(enter)。');
        }
        if (waiting.has(panelId)) return t('已经有一份计划在等用户回复，先等它。');

        const state = modes.get(panelId) || { active: true };
        state.plan = plan;
        state.askedAt = Date.now();
        modes.set(panelId, state);

        return new Promise((resolve) => {
          const onAbort = () => settle(panelId, t('这一轮停了 —— 计划没等到答复。'));
          const sig = ctx && ctx.signal;
          if (sig) {
            if (sig.aborted) return resolve(t('这一轮已经停了，计划没提交。'));
            sig.addEventListener('abort', onAbort, { once: true });
          }
          const off = () => { if (sig) sig.removeEventListener('abort', onAbort); };
          waiting.set(panelId, { resolve, off });

          api.ask({
            panelId,
            text: t('它提交了一份实施计划，等你点头') + (plan.length > 400 ? t('（计划正文在下面的问题里）') : '') + ':' + '\n' + plan,
            confirm: t('同意，按这个做'),
            cancel: t('不同意（说一句为什么）'),
            questions: [
              {
                id: 'approve',
                header: t('审批'),
                question: t('同意按这份计划动手吗？'),
                detail: plan.length > 1500 ? plan.slice(0, 1500) + '\n…（计划太长，正文在模型那条消息里）' : plan,
                options: [
                  { label: t('同意，按这个做'), description: t('计划已经写清要改哪些文件、怎么验证') },
                  { label: t('不同意（说一句为什么）'), description: t('在下面写清哪里不行、应该怎么改') },
                ],
              },
            ],
            then: { tool: 'plan_verdict', args: { panelId } },
          });
        });
      },
    );

    // 3. 答案的落点：用户提交（或取消）时核心并进 then.args 再跑它
    api.addTool(
      {
        name: 'plan_verdict',
        hidden: true,
        level: 'read',
        kits: ['planner'],
        description: t('（内部收尾用，模型不用调）把用户对计划的答复交给正等着的那次调用。'),
        parameters: {
          type: 'object',
          properties: {
            panelId: { type: 'string' },
            answers: { type: 'array', items: { type: 'object' } },
            cancelled: { type: 'boolean' },
          },
        },
      },
      (args, ctx) => {
        const panelId = String((args && args.panelId) || (ctx && ctx.panelId) || '');
        const answers = (args && Array.isArray(args.answers)) ? args.answers : [];
        const first = answers[0] || {};
        const custom = String(first.custom || '').trim();
        const picked = Array.isArray(first.selected) ? first.selected.join(' ') : '';
        const text = (picked + ' ' + custom).trim();

        if (args && args.cancelled) {
          settle(panelId, t('用户没有答复这份计划（先不了）。别动手改文件，把计划留在正文里，等用户回来。'));
          return t('好了，这一轮接着跑。');
        }
        const rejected = /不同意/.test(text);
        if (rejected) {
          modes.set(panelId, { active: true, plan: '', reason: '', askedAt: 0 });
          settle(
            panelId,
            t('用户**不同意**这份计划') + (custom ? t('，理由是：') + custom : t('。')) + '\n'
            + t('仍在计划模式：不许改文件。按用户的意见调整计划，再调 plan_submit 重新提交。'),
          );
          return t('好了，这一轮接着跑。');
        }
        modes.delete(panelId);
        settle(
          panelId,
          t('用户**同意**了这份计划 —— 计划模式已解除，现在可以改文件了。')
          + (custom ? t('补充指示：') + custom + '\n' : '\n')
          + t('按计划一步步做：每改完一处按计划里写的方式验证；中途若发现计划不对，停下来说清楚，别硬做。'),
        );
        return t('好了，这一轮接着跑。');
      },
    );

    // 4. 门：计划模式里编辑类工具一律拦下
    api.onBeforeTool((call) => {
      const panelId = (call.ctx && call.ctx.panelId) || '';
      if (!panelId || !isActive(panelId)) return;
      const name = String(call.name || '');
      const editing = WRITE_TOOLS.has(name) || MUTATING_EXTRA.has(name);
      if (!editing) return;
      return [
        t('计划模式**没有放行**这次 ') + name + t(' 调用。'),
        t('现在只能读：把该看的地方看完，然后把打算怎么做写成一份计划，调 plan_submit 交给用户审批。'),
        t('用户同意之后门会自己放开 —— 不要重试这个工具，也不要绕过它换别的工具去做同一件事。'),
      ].join('\n');
    });

    // 5. 计划模式每轮提醒一次，别让它中途忘了这道门
    api.addPrompt((ctx) => {
      const panelId = (ctx && ctx.panelId) || '';
      if (!isActive(panelId)) return '';
      const one = modes.get(panelId) || {};
      const lines = [t('【计划模式生效中】现在只能读、不能改文件（编辑类工具会被拦下）。')];
      if (one.reason) lines.push(t('进入原因：') + one.reason);
      lines.push(t('看完之后调 plan_submit 提交计划等用户点头；被拒绝就按用户的意见改计划重新提交。'));
      return lines.join('\n');
    });

  },

  dispose() {
    for (const [pid] of [...modes.entries()]) modes.delete(pid);
  },
};
