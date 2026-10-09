/**
 * 模型主动问用户 —— 阻塞式提问工具，工具返回之前这一轮不算完。
 *
 * 分三层：工具（模型面，纯转换）/ 接缝（能力面，等人回答）/ 界面（回答面）。
 * 这个软件里后两层核心已经现成了：
 *   · 接缝 = 插件 API 的 api.ask（AskSpec）+ 主进程的 pendingAsk；
 *   · 界面 = 对话区 composer 正上方那一块（老横条 + 新问题表单，见 ChatDock.tsx）。
 * 缺的只是第一层：模型能调的 ask_user_question 工具。这个插件补的就是它。
 *
 * 关键在于是**阻塞**的：工具返回之前这一轮不算完 ——
 * 模型真的停在那里等人回答，而不是把问句写进正文然后这一轮就结束了。所以：
 *   1. spec.timeoutMs 必须给足（不给就掉进 core 的 60 秒默认值，人还没读完题就超时）；
 *   2. 用户提交的答案是顺着 then.args 回来的（见 index.ts 的 chat:askConfirm）；
 *   3. 用户按「先不」那条路也要把这次调用收尾，否则它一直挂着（core 的 askCancel 里也做了）。
 *
 * 为什么不去 onBeforeTool 里拦：那个口子天生是「拦下来、换成一条请求」，
 * 可一拦下这次调用就**结束了** —— 模型拿到的是那句提示文本，等不到答案。
 * 要阻塞，只能在 handler 里挂着等。
 */

/** 等的上限：够人慢慢读题、慢慢选 */
const WAIT_MS = 10 * 60 * 1000;

/**
 * 此刻挂着的等待 —— **按面板分槽**。
 * 两块面板同时各问各的是常态；用一个全局单槽的话，后问的那块会把先问的挤掉。
 */
const waiting = new Map();

/** 把答案交给正挂着的那次调用；没人等就返回 false */
function settle(panelId, value) {
  const w = waiting.get(panelId);
  if (!w) return false;
  waiting.delete(panelId);
  clearTimeout(w.timer);
  w.resolve(value);
  return true;
}

module.exports = {
  name: 'ask-user',
  description: t('模型能中途停下来问用户（确认 / 选择 / 缺信息）：一次一批题，答完这一轮接着跑'),

  /** 插件被换掉 / 关掉：还挂着的全放开，否则那些工具调用会永远吊着 */
  dispose() {
    for (const [pid] of [...waiting.entries()]) {
      settle(pid, t('提问插件被卸载了 —— 这次没问到，按手头信息继续。'));
    }
  },

  setup(api) {
    api.addTool(
      {
        name: 'ask_user_question',
        kits: ['planner'],
        description:
          t('需要用户确认、做个选择、或者缺一项只有他知道的信息时，用这个工具**当场**问他。')
          + t('一次可以问一道或多道（每题一个稳定的 id，答案里原样带回来）。')
          + t('调用会**一直等着**用户回答，拿到答案之后这一轮接着往下跑。')
          + t('所以别拿它当普通提问：闲聊、要方案、解释概念、能自己判断的事，直接答，不要用它。')
          + t('每题可以给 options（选项）：推荐的那个放第一个，标签后面加「(Recommended)」。')
          + t('multi_select=true 表示多选。用户也能自己写一段，答案会以 custom 回来。')
          + t('用户可能跳过某一题（selected 是空的、也没有 custom）—— 那是「他没意见」，别再追问同一件事。'),
        parameters: {
          type: 'object',
          properties: {
            questions: {
              type: 'array',
              description: t('要问用户的问题（至少一道）'),
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: t('这题的稳定编号 —— 答案里原样带回来') },
                  question: { type: 'string', description: t('要问的那句话，写具体') },
                  header: { type: 'string', description: t('可选：短标题，如「确认」「选模式」') },
                  detail: { type: 'string', description: t('可选：补充说明，讲清背景或后果') },
                  options: {
                    type: 'array',
                    description: t('可选：让用户挑。推荐项放第一个，标签后面加「(Recommended)」'),
                    items: {
                      type: 'object',
                      properties: {
                        label: { type: 'string', description: t('选项标签，短') },
                        description: { type: 'string', description: t('一句话讲清这个选择的代价') },
                      },
                      required: ['label'],
                    },
                  },
                  multi_select: { type: 'boolean', description: t('是否可多选，默认否') },
                },
                required: ['id', 'question'],
              },
            },
          },
          required: ['questions'],
        },
        // 问答跟能不能改文件无关，编辑器面板里的小对话也该能用上
        level: 'read',
        // **不给就掉进 core 的 60 秒默认值** —— 这一条是这套东西能不能用的命门
        timeoutMs: WAIT_MS + 30 * 1000,
      },
      (args, ctx) => {
        const panelId = (ctx && ctx.panelId) || '';
        if (!panelId) return t('拿不到是哪块面板在问 —— 这次不问了。');

        const raw = args && Array.isArray(args.questions) ? args.questions : [];
        const questions = raw
          .map((q, i) => {
            if (!q || typeof q.question !== 'string' || !q.question.trim()) return null;
            const one = { id: String(q.id || 'q' + (i + 1)), question: String(q.question).trim() };
            if (q.header) one.header = String(q.header);
            if (q.detail) one.detail = String(q.detail);
            if (Array.isArray(q.options) && q.options.length) {
              one.options = q.options
                .filter((o) => o && typeof o.label === 'string' && o.label.trim())
                .map((o) => (o.description ? { label: String(o.label), description: String(o.description) } : { label: String(o.label) }));
            }
            if (q.multi_select === true) one.multiSelect = true;
            return one;
          })
          .filter(Boolean);

        if (!questions.length) return t('questions 是空的 —— 没有要问的，就别问了。');
        // 同一块面板上一次还没答完：别叠第二条（叠了前一条永远等不到）
        if (waiting.has(panelId)) return t('这块面板上已经有一条在等用户回答，先等它。');

        const first = questions[0];
        const title = questions.length > 1
          ? first.question + t('（共 {n} 题）').replace('{n}', String(questions.length))
          : first.question;

        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            settle(panelId, t('等用户回答超时了（10 分钟）—— 先别继续，回头再问一次。'));
          }, WAIT_MS);
          waiting.set(panelId, { resolve, timer });

          api.ask({
            panelId,
            text: title,
            confirm: t('提交'),
            cancel: t('不回答，跳过'),
            questions,
            // 用户提交的答案由核心并进 then.args（见 index.ts 的 chat:askConfirm）
            then: { tool: 'ask_user_answer', args: { panelId } },
          });
        });
      },
    );

    /**
     * 答案的落点：用户按下提交（或跳过）时，核心把答案并进 then.args 再跑这个工具。
     * 它只做一件事 —— 把那份答案交给正挂着的那个 Promise，那次调用这才返回。
     *
     * 为什么不叫 ask_user_answered 之类：它是内部收尾件，模型不该看见它，
     * 名字越不像「模型该调的」越好。
     */
    api.addTool(
      {
        name: 'ask_user_answer',
        // 内部收尾件：核心要能跑它，但**不发给模型**（见 PluginToolSpec.hidden）
        hidden: true,
        kits: ['planner'],
        level: 'read',
        description: t('（内部收尾用，模型不用调）把用户在问题表单上提交的答案交给正在等的那次调用。'),
        parameters: {
          type: 'object',
          properties: {
            panelId: { type: 'string', description: t('哪块面板') },
            answers: { type: 'array', items: { type: 'object' }, description: t('每题一条：id / selected / custom') },
            cancelled: { type: 'boolean', description: t('用户选了先不回答') },
          },
        },
      },
      (args, ctx) => {
        const panelId = String((args && args.panelId) || (ctx && ctx.panelId) || '');
        if (args && args.cancelled) {
          return settle(panelId, t('用户选择先不回答 —— 别再问同一件事，按手头信息继续，或者把问题写进正文。'))
            ? t('好了，这一轮接着跑。')
            : t('这条取消没有对应的等待。');
        }
        const answers = args && Array.isArray(args.answers) ? args.answers : [];
        return settle(panelId, JSON.stringify({ answers }))
          ? t('答案已经交给模型，这一轮接着跑了。')
          : t('这条答案没有对应的等待 —— 那一轮可能已经停了。');
      },
    );
  },
};
