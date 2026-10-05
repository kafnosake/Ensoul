export interface Node {
  component: 'calendar' | 'clock' | 'note' | 'text' | 'column';
  props: { title?: string; text?: string; weekStartsOn?: 0 | 1; showWeekNumbers?: boolean; hour12?: boolean; seconds?: boolean };
  children?: Node[];
}
export interface Document { protocol: 'ensoul.desktop-ui.v1'; root: Node }

const CATALOG: Record<string, string[]> = {
  calendar: ['title', 'weekStartsOn', 'showWeekNumbers'],
  clock: ['title', 'hour12', 'seconds'],
  note: ['title', 'text'],
  text: ['text'],
  column: [],
};
function validate(value: any, depth = 0): Node {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) throw new Error('组件配置格式错误');
  if (!Object.hasOwn(CATALOG, value.component)) throw new Error('该功能尚未在桌面组件目录中，支持日历、时钟、便签和文字');
  if (Object.keys(value).some(key => !['component', 'props', 'children'].includes(key))) throw new Error('组件只能包含 component、props、children');
  const props = value.props || {};
  if (typeof props !== 'object' || Array.isArray(props) || Object.keys(props).some(key => !CATALOG[value.component].includes(key))) throw new Error('组件属性不在目录中');
  for (const key of ['title', 'text']) if (props[key] !== undefined && (typeof props[key] !== 'string' || props[key].length > (key === 'title' ? 80 : 2000))) throw new Error('文字属性格式错误');
  for (const key of ['showWeekNumbers', 'hour12', 'seconds']) if (props[key] !== undefined && typeof props[key] !== 'boolean') throw new Error('开关属性必须是布尔值');
  if (props.weekStartsOn !== undefined && ![0, 1].includes(props.weekStartsOn)) throw new Error('weekStartsOn 只能是 0 或 1');
  if (value.component === 'column') {
    if (!Array.isArray(value.children) || !value.children.length || value.children.length > 6) throw new Error('column 需要 1–6 个子组件');
    return { component: 'column', props, children: value.children.map((child: unknown) => validate(child, depth + 1)) };
  }
  if (value.children !== undefined) throw new Error('只有 column 可以包含子组件');
  return { component: value.component, props };
}
export function parse(raw: string | Document): Document {
  const value = typeof raw === 'string' ? JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) : raw;
  if (value?.protocol !== 'ensoul.desktop-ui.v1') throw new Error('缺少 ensoul.desktop-ui.v1 协议标记');
  if (Object.keys(value).some(key => !['protocol', 'root'].includes(key))) throw new Error('协议只支持 protocol 和 root');
  return { protocol: value.protocol, root: validate(value.root) };
}
export function preset(prompt: string): Document | null {
  const match = /^(?:请)?(?:帮我|我想要|我需要|我要|给我)?(?:做|创建|生成|添加|要|来)?(?:一个|个)?(?:简单的)?(日历|时钟|便签)(?:组件|挂件)?[。.!！]?$/.exec(prompt.trim());
  if (!match) return null;
  const component = ({ 日历: 'calendar', 时钟: 'clock', 便签: 'note' } as const)[match[1] as '日历' | '时钟' | '便签'];
  return { protocol: 'ensoul.desktop-ui.v1', root: { component, props: component === 'calendar' ? { weekStartsOn: 1 } : {} } };
}

export function starter(prompt: string): Document | null {
  if (/(?:不要|不需要|不用|取消|删除|移除).{0,5}(?:日历|时钟|便签)/.test(prompt)) return null;
  const nodes: Node[] = [];
  if (/日历|\bcalendar\b/i.test(prompt)) nodes.push({ component: 'calendar', props: { weekStartsOn: 1 } });
  if (/时钟|\bclock\b/i.test(prompt)) nodes.push({ component: 'clock', props: {} });
  if (/便签|记事本|\bnotes?\b/i.test(prompt)) nodes.push({ component: 'note', props: {} });
  if (!nodes.length) return null;
  return { protocol: 'ensoul.desktop-ui.v1', root: nodes.length === 1 ? nodes[0] : { component: 'column', props: {}, children: nodes } };
}
