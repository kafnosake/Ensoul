/**
 * 任务清单 —— 跨轮任务状态持久化与规划调度。
 *
 * 它治的是这个软件最反复的那个毛病："每次都跑不完，我也不知道它到底干了啥"。
 * 一份写在明面上的清单解决两件事：
 *
 *   1. **跨轮不忘。** 清单落盘，并且在**每一轮**都被放回它眼前（addPrompt，
 *      正文拼在本轮用户消息末尾）—— 于是模型不会做三步就把前两步的计划忘干净。
 *   2. **看得见。** 清单同时是一个面板（kind: todo）能直接读的文件，
 *      用户随时看得见它在第几步、还剩什么。
 *   3. **一个面板一份。** 清单按面板存、按面板发 —— 两块面板各干各的活时，
 *      A 的清单不会漂进 B 的提示里，让 B 丢下自己的活去做 A 的（会话污染最直接的一条来路）。
 *
 * 为什么状态放**工作区**（`.ensoul/state/todo.json`）而不是内存：
 * 一个工作区就是一个项目，"这个项目的计划"属于这个项目，重启软件也该还在；
 * 而且界面上的面板能直接读这个文件，不必再为它开一条 IPC。
 *
 * 清单是**整份原子替换**的：不给每一条编号、不让局部改，
 * 因为局部改会让模型和维护清单这两件事悄悄跑偏 —— 整份发过来，永远只信最后一份。
 */

const FILE = '.ensoul/state/todo.json';
const MAX_ITEMS = 50;
const MAX_TEXT = 200;
/** 面板已经不在了的那一份清单的落脚处 */
const ORPHAN = '_orphan';

/**
 * 清单长这样：{ at, active, panels: { <panelId>: { items, at, title } } }
 *
 * `active` 只是给面板那张脸看的（这块面板自己没有清单时，显示最近更新的那一份）；
 * **交给模型的那一份永远只取自己这个 panelId 的**，不看 active。
 */
function load(api) {
  const raw = api.state.load(null) || {};
  const state = {
    at: Number(raw.at) || 0,
    active: String(raw.active || ''),
    panels: raw.panels && typeof raw.panels === 'object' ? { ...raw.panels } : {},
  };
  // 老格式（全局一份、顶层就是 items）：搬到它记着的那块面板名下，一条都不丢
  if (!raw.panels && Array.isArray(raw.items) && raw.items.length) {
    const owner = String(raw.panelId || '') || ORPHAN;
    state.panels[owner] = { items: raw.items, at: Number(raw.at) || 0 };
    state.active = owner;
  }
  return state;
}

function save(api, state) {
  state.at = Date.now();
  api.state.save(state);
}

/** 这块面板自己的清单 —— 没有就是空的 */
function itemsOf(state, panelId) {
  const one = state.panels[panelId];
  return one && Array.isArray(one.items) ? one.items : [];
}

/** 写清单那一刻顺手记下面板名字：别的面板打开那张脸时，才说得出这是谁的清单 */
function titleOf(api, panelId) {
  try {
    const p = api.panels().find((x) => x.id === panelId);
    return (p && p.title) || '';
  } catch {
    return '';
  }
}

const MARK = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };
const LABEL = { pending: t('待办'), in_progress: t('进行中'), completed: t('已完成') };

function render(items) {
  if (!items.length) return t('（清单是空的）');
  return items.map((t, i) => `${MARK[t.status] ?? '[ ]'} ${i + 1}. ${t.content}`).join('\n');
}

module.exports = {
  name: 'todo',
  description: t('任务清单：把当前要做的几件事写下来，跨轮不忘，界面上也看得见'),

  /** 自带一种面板类型：清单的脸在 panel.tsx（见 plugins/pomodoro/index.js 里那段说明）。声明要在 module.exports 里面 */
  panel: {
    kind: 'todo',
    label: t('任务清单'),
    hint: t('助手写下的待办与进度（todo_write 写的那一份）'),
    title: t('任务清单'),
    body: 'messages',
  },

  setup(api) {
    // 老格式（全局就那么一份）在挂载时就搬成按面板存的 —— 面板那张脸不必等谁先写一次清单
    const boot = api.state.load(null) || {};
    if (!boot.panels && Array.isArray(boot.items) && boot.items.length) save(api, load(api));

    api.addTool(
      {
        name: 'todo_write', kits: ['planner'],
        description:
          t('记录/更新当前这件事的任务清单。**每次都要发完整的清单**（会整份替换上一份），不是只发改动的那几条。')
          + t('清单会被保留并在之后每一轮都重新给你看 —— 所以多步任务先写清单，比你自己记在叙述里可靠得多。')
          + t('状态只有三种：pending（还没开始）| in_progress（正在做，**同时只该有一条**）| completed（做完了）。')
          + t('一件事做完就立刻标 completed，别攒着。单步的小事不用写清单。')
          + t('**卡在外部输入的不许写 in_progress**（等交付、等用户确认、等一张你拿不到的凭据）—— 那种写 pending，把卡点写进这句话里。')
          + t('活被撤了、交了、黄了，下次写清单就把对应条目删掉或标 completed —— 已结的活不许一直挂着当坏账。')
          + t('清单是**这块面板自己的**：别的面板看不到它，你也不用管别的面板在做什么。'),
        parameters: {
          type: 'object',
          properties: {
            todos: {
              type: 'array',
              description: t('完整的任务清单，替换掉之前那一份'),
              items: {
                type: 'object',
                properties: {
                  content: { type: 'string', description: t('这件任务是什么 —— 一句简短的祈使句') },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                },
                required: ['content', 'status'],
              },
            },
          },
          required: ['todos'],
        },
        // 清单跟"能不能改文件"是同一档：编辑器面板里的小对话也该能用上
        level: 'write',
      },
      (args, ctx) => {
        const id = (ctx && ctx.panelId) || '';
        const state = load(api);
        const raw = Array.isArray(args && args.todos) ? args.todos : [];
        if (!raw.length) {
          delete state.panels[id];
          if (state.active === id) state.active = '';
          save(api, state);
          return t('清单已清空。');
        }

        const items = [];
        for (const t of raw.slice(0, MAX_ITEMS)) {
          const content = String((t && t.content) || '').trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT);
          if (!content) continue;
          const status = ['pending', 'in_progress', 'completed'].includes(t && t.status) ? t.status : 'pending';
          items.push({ content, status });
        }
        if (!items.length) return t('清单里没有一条有效任务（每条要带 content）。');

        const doing = items.filter((t) => t.status === 'in_progress').length;
        state.panels[id] = { items, at: Date.now(), title: titleOf(api, id) };
        state.active = id;
        save(api, state);

        const count = (s) => items.filter((t) => t.status === s).length;
        const warn = doing > 1 ? `\n\n⚠ 现在有 ${doing} 条「进行中」—— 同时只做一件，其余标回 pending。` : '';
        return (
          `清单已更新（共 ${items.length} 条：${count('completed')} 完成 / ${doing} 进行中 / ${count('pending')} 待办）。`
          + `\n\n${render(items)}${warn}`
        );
      },
    );

    api.addTool(
      {
        name: 'todo_read', kits: ['planner'],
        description: t('把当前的任务清单原样读出来（正常情况下你不用调它 —— 清单每一轮都会自动给你看）。'),
        parameters: { type: 'object', properties: {} },
        level: 'read',
      },
      (_args, ctx) => {
        const items = itemsOf(load(api), (ctx && ctx.panelId) || '');
        if (!items.length) return '现在没有清单。';
        const count = (s) => items.filter((t) => t.status === s).length;
        return `${render(items)}\n\n（${count('completed')} 完成 / ${count('in_progress')} 进行中 / ${count('pending')} 待办）`;
      },
    );

    // 每一轮把清单摆回它面前。这是"跨轮不忘"的全部实现 —— 落盘 + 每轮重发。
    //
    // 但只列**没做完**的：这段拼在本轮用户消息里，每轮重发一遍，是一笔固定开销。
    // 做完的条目在面板上、在 todo_read 里照样一条不少 —— 那些地方只在真要查的时候看，
    // 不必每轮占着预算。编号保留原样、不重排：模型对着编号说话时才不会指错。
    //
    // **只摆这块面板自己的**：不看 ctx 的话，A 面板写的清单会漂到 B 面板的提示里，
    // B 就丢下手里的活去做 A 的事了 —— 这就是用户看到的那种"会话污染"。
    api.addPrompt((ctx) => {
      const items = itemsOf(load(api), (ctx && ctx.panelId) || '');
      if (!items.length) return '';
      const count = (s) => items.filter((t) => t.status === s).length;
      const done = count('completed');
      const open = items
        .map((t, i) => ({ t, n: i + 1 }))
        .filter((x) => x.t.status !== 'completed')
        .map((x) => `${MARK[x.t.status] ?? '[ ]'} ${x.n}. ${x.t.content}`);
      return [
        '【当前任务清单】（todo_write 写的，跨轮保留，只属于这块面板。做完了就更新它，别让它和事实对不上；清单和派单/事实冲突时以事实为准，整份改掉。这里只列没做完的）',
        open.length ? open.join('\n') : '（没有未完成的条目）',
        done ? `（另有 ${done} 条已完成，不逐条列 —— 要看用 todo_read）` : '',
        `（${done} 完成 / ${count('in_progress')} 进行中 / ${count('pending')} 待办）`,
      ].filter(Boolean).join('\n');
    });

    api.log('任务清单就绪（状态文件：' + FILE + '，按面板各存一份）');
  },
};
