/**
 * 让助手能调插件的参数 —— 一个只挂工具、不带面板的插件。
 *
 * 为什么"改参数"这件事要有个插件：参数这套机制（声明、校验、落盘、改完让插件重新
 * setup）住在核心，因为插件跑在主进程、够得着那里；但**给模型一个改参数的入口**是
 * 一个工具，工具该长在插件里 —— 核心的工具表越短，每一轮的提示词越便宜。
 *
 * 它自己不认识任何具体插件：
 *   清单  api.allParams()          —— 核心把声明和当前值一起递过来
 *   改值  api.setPluginParam(...)  —— 和设置面板里那些控件最终走的是同一份校验
 *
 * 于是"用户点着改"和"助手一句话改"永远是同一份值、同一套规则，不分两套。
 */

const fmt = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

/** 工具来的值都是字符串，按声明转成该有的类型 —— 核心还会再校验一次 */
function parse(decl, raw) {
  if (typeof raw !== 'string') return raw;
  const s = raw.trim();
  if (decl.type === 'number') return Number(s);
  if (decl.type === 'bool') return !(s === '' || s === '0' || s === 'false' || s === 'no' || s === 'off');
  return raw;
}

/** 一个插件的参数摊成几行：值、默认值（改过才标）、范围、选项、说明 */
function show(p) {
  const lines = p.params.map((d) => {
    const cur = p.values[d.key];
    const bits = [];
    if (d.type === 'number' && (d.min !== undefined || d.max !== undefined)) {
      bits.push(`${d.min !== undefined ? d.min : '-∞'}–${d.max !== undefined ? d.max : '∞'}`);
    }
    if (d.type === 'select') bits.push(`可选 ${d.options.map((o) => o.value).join(' | ')}`);
    if (d.hint) bits.push(d.hint);
    const changed = cur !== d.default ? `（默认 ${fmt(d.default)}）` : '';
    return `  · ${d.key} = ${fmt(cur)}${changed} — ${d.label}${bits.length ? `（${bits.join('；')}）` : ''}`;
  });
  return `${p.name}${p.enabled ? '' : '［已停用］'} —— ${p.description || '（没写说明）'}\n${lines.join('\n')}`;
}

module.exports = {
  name: 'plugin-kit',
  description: t('给助手上一个 plugin_params 工具：看 / 改各个插件的可调参数'),

  setup(api) {
    api.addTool(
      {
        name: 'plugin_params', kits: ['ui'],
        description:
          t('看和改插件的可调参数。插件会声明若干参数（时长、上限、开关、提示词片段……），') +
          t('这里能列出来并改掉；改完那个插件会**重新准备**一次，新值从下一次工具调用起生效。') +
          t('插件没声明参数时列表是空的 —— 那种插件就是没有可调的东西。'),
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'set', 'reset'],
              description: t('list = 看全部（默认）；set = 改一条；reset = 恢复默认'),
            },
            plugin: { type: 'string', description: t('插件名（set / reset 必填，如 pomodoro）') },
            key: { type: 'string', description: t('参数名（set / reset 必填，如 work）') },
            value: { type: 'string', description: t('新值（set 必填）。开关写 true / false，数字直接写数字') },
          },
          required: ['action'],
        },
        level: 'write',
      },
      (args) => {
        const list = api.allParams();
        const action = String((args && args.action) || 'list');

        if (action === 'list') {
          if (!list.length) return t('当前没有插件声明可调参数。');
          return `插件的可调参数（${list.length} 个插件）：\n\n${list.map(show).join('\n\n')}`;
        }

        const name = String((args && args.plugin) || '').trim();
        const key = String((args && args.key) || '').trim();
        const p = list.find((x) => x.name === name);
        if (!p) {
          const names = list.map((x) => x.name).join('、');
          return `没有这个插件：${name || '(没填)'}\n有参数的插件：${names || '（一个都没有）'}`;
        }
        const decl = p.params.find((d) => d.key === key);
        if (!decl) return `插件 ${name} 没有参数 ${key || '(没填)'}\n它有：${p.params.map((d) => d.key).join('、')}`;

        const before = p.values[key];
        const next = action === 'reset' ? null : parse(decl, args && args.value);
        const r = api.setPluginParam(name, key, next);
        if (!r || !r.ok) return `没改成：${(r && r.error) || '未知原因'}`;

        const after = (api.allParams().find((x) => x.name === name) || { values: {} }).values[key];
        if (before === after) return `${name}.${key} 本来就是 ${fmt(after)}，没动它。`;
        return `${name}.${key}：${fmt(before)} → ${fmt(after)}（${action === 'reset' ? '已恢复默认' : '已改'}）。\n参数改完那个插件会重新准备一次，下一次用它就是新值。`;
      },
    );

    api.log(t('就绪：plugin_params 工具（看 / 改插件参数）'));
  },
};
