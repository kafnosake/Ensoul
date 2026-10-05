/**
 * 面板预设头像 —— 家族词典与选图（纯数据 + 纯函数，主进程与渲染层共用）。
 *
 * 为什么是一个共用文件：**认家族**这件事两边都要做，而且要给出同一个答案 ——
 *   · 主进程：首轮提案带了 keywords 时算一次，把结果冻进 `look.avatarKey`；
 *   · 渲染层：老面板（没有 avatarKey 的）按 kind / 标题现算一次兜底。
 * 两边各写一份词典，迟早对不上，同一个面板在两处会长出两张脸。
 *
 * 这里**不许**出现 fs、也**不许**出现 `import.meta.glob` —— 主进程会栽在后者上。
 * 这里只管"哪个家族、第几张"，把文件名拼出来；真去取图片 URL 是渲染层的事。
 *
 * 家族清单与出图规格见 `work/panel-avatar-presets.md`（v2：14 家族 × 6 变体 = 84 张）。
 */

export const PANEL_AVATAR_FAMILIES = [
  'dev',
  'monitor',
  'prompt',
  'dispatch',
  'art',
  'writing',
  'billing',
  'chat',
  'file',
  'time',
  'research',
  'audio',
  'game',
  'misc',
] as const;

export type PanelAvatarFamily = (typeof PANEL_AVATAR_FAMILIES)[number];

/** 每个家族出几张（同一家族第 k 张靠 seed 散列挑，不落库） */
export const PANEL_AVATAR_VARIANTS = 6;

export function isPanelAvatarFamily(v: unknown): v is PanelAvatarFamily {
  return typeof v === 'string' && (PANEL_AVATAR_FAMILIES as readonly string[]).includes(v);
}

/**
 * 面板类型 → 家族。
 *
 * **`chat` 刻意不在表里。** 一块面板可以是 chat 而干着任何事（编辑器、监视台、
 * 头像工作台……），把它映射到 chat 家族等于让大半个列表长同一张脸 ——
 * 那一级的本意是"类型本身就说明了用途"，chat 说明不了。它交给关键词和标题。
 */
const KIND_FAMILY: Record<string, PanelAvatarFamily> = {
  dispatch: 'dispatch',
  tickets: 'dispatch',
  notes: 'prompt',
  sticker: 'prompt',
  'prompt-manager': 'prompt',
  billing: 'billing',
  'usage-meter': 'billing',
  browser: 'chat',
  eschat: 'chat',
  files: 'file',
  file: 'file',
  editor: 'file',
  git: 'file',
  history: 'file',
  histconv: 'file',
  pomodoro: 'time',
  todo: 'time',
  jobs: 'monitor',
  'task-monitor': 'monitor',
  'loop-guard': 'monitor',
  web: 'research',
  mcp: 'research',
};

/**
 * 家族词典 —— 中文短词，**子串包含**判定（中文没有词边界，不切词）。
 *
 * 词要"具体到能定家族"才放进来：`插件` 能定到 dev，`工具` 定不到任何东西，
 * 放进来只会让一堆面板挤同一张脸。泛词一律丢进 GENERIC_WORDS 降权。
 */
const FAMILY_KEYWORDS: Record<PanelAvatarFamily, string[]> = {
  dev: ['插件', '开发', '调试', '编译', '构建', '代码', '重构', '报错', '修复', '脚本', '接口', '架构', '组件', '打包工具', '工程', '类型', '实现'],
  monitor: ['监视', '监控', '状态', '性能', '日志', '巡检', '追踪', '卡顿', '崩溃', '队列', '占用', '诊断'],
  prompt: ['提示词', '系统提示', '规则', '措辞', '人设', '词典', '术语', '前缀', '口径', '表达', '写作规范'],
  dispatch: ['派单', '调度', '派发', '分派', '工单', '令牌', '收件箱', '部门', '经理', '员工', '转派', '协作'],
  art: ['出图', '绘画', '画布', '图集', '抠图', '色键', '立绘', '图标', '素材', '美术', '像素', '原画', '贴图', '精灵图', '模型', '绘画', '姿势'],
  writing: ['文案', '剧情', '对白', '设定', '剧本', '故事', '台词', '命名', '世界観', '世界观', '文本', '措辞', '润色'],
  billing: ['计费', '花销', '成本', '用量', '价格', '账单', '额度', '开销', '费用', '预算', '统计'],
  chat: ['对话', '会话', '聊天', '联系人', '消息', '微信', '沟通', '交流', '回复', '客服'],
  file: ['文件', '目录', '路径', '版本', '备份', '归档', '仓库', 'git', '开源', '发版', '提交', '分支', '历史记录', '导入导出'],
  time: ['定时', '提醒', '番茄', '计时', '倒计时', '日程', '计划', '周期', '待办', '排期', '清单'],
  research: ['检索', '搜索', '资料', '调研', '查找', '文献', '网页', '抓取', '采集', '情报', '调查', '百科'],
  audio: ['语音', '音频', '音乐', '音效', '配音', '录音', '转写', '朗读', '声音', '播报', '听写'],
  game: ['游戏', '玩法', '关卡', '数值', '战斗', '宠物', '副本', '机制', '平衡', '掉落', '技能', '属性'],
  misc: [],
};

/**
 * 泛词 —— 命中也只算半分。
 *
 * 它们的作用是**防守**：万一哪天有人往词典里塞了个大词（"开发""设计"），
 * 会被这里按半分算，不至于一个词把所有面板都拉过去。
 */
const GENERIC_WORDS = new Set([
  '工具', '设计', '任务', '系统', '功能', '工作', '项目', '方案',
  '优化', '分析', '管理', '界面', '面板', '讨论', '记录', '整理',
]);

function scoreOf(fam: PanelAvatarFamily, tokens: string[]): number {
  const dict = FAMILY_KEYWORDS[fam];
  if (!dict.length) return 0;
  let s = 0;
  for (const raw of tokens) {
    const t = String(raw || '').trim();
    // 单字太容易误命中（"图""人"），一律不算
    if (t.length < 2) continue;
    if (!dict.some((k) => t.includes(k))) continue;
    s += GENERIC_WORDS.has(t) ? 0.5 : 1;
  }
  return s;
}

function bestFamily(tokens: string[]): PanelAvatarFamily | null {
  let best: PanelAvatarFamily | null = null;
  let bestScore = 0;
  for (const fam of PANEL_AVATAR_FAMILIES) {
    const s = scoreOf(fam, tokens);
    // 严格大于：同分时保留 FAMILIES 里靠前的那个，结果稳定、可复现
    if (s > bestScore) {
      bestScore = s;
      best = fam;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * 定家族 —— 五级，先命中先取：
 *
 *   1. **显式指定**（`avatarKey`：插件自报，或用户在界面上点选）
 *   2. **模型给的主题关键词**（首轮提案里的 keywords）
 *   3. **面板类型**（kind → 家族）
 *   4. **标题词典**
 *   5. **兜底 misc** —— 谁都认不出来时，同标题哈希稳定取一张，
 *      总比全体顶着个字母强
 *
 * 纯函数、不抛错、不落盘。词认不出来就当没给，**绝不阻塞任何流程**。
 */
export function matchPanelAvatarFamily(opts: {
  avatarKey?: string;
  keywords?: unknown;
  kind?: string;
  title?: string;
}): PanelAvatarFamily {
  const explicit = String(opts.avatarKey || '').trim().toLowerCase();
  if (isPanelAvatarFamily(explicit)) return explicit;

  const kw = Array.isArray(opts.keywords) ? opts.keywords.map((x) => String(x)) : [];
  const byKeywords = bestFamily(kw);
  if (byKeywords) return byKeywords;

  const byKind = KIND_FAMILY[String(opts.kind || '').trim().toLowerCase()];
  if (byKind) return byKind;

  const byTitle = bestFamily([String(opts.title || '')]);
  if (byTitle) return byTitle;

  return 'misc';
}

/**
 * 家族内第几张 —— **算，不存**。
 *
 * seed 用**面板 id**，不用标题：标题会改（用户随手改个名、模型补个标题），
 * 挂在标题上的话，列表里的脸会在用户眼皮底下换一张。面板 id 一生不变。
 */
export function panelAvatarVariant(seed: string, count: number = PANEL_AVATAR_VARIANTS): number {
  let h = 2166136261;
  const s = String(seed || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const n = Math.max(1, Math.floor(count) || 1);
  return (h >>> 0) % n;
}

/**
 * 文件名，如 `dev-3.webp` —— 落点是 src/renderer/assets/panel-avatars/。
 *
 * 扩展名是 webp 不是 png：84 张原件 12.4MB，压到每张 20K 以内之后一共 0.97MB。
 * 查表那头（panelAvatarUrl.ts）只认主干、不认扩展名，所以这里换格式不影响匹配。
 */
export function panelAvatarFileName(family: PanelAvatarFamily, seed: string): string {
  return `${family}-${panelAvatarVariant(seed) + 1}.webp`;
}
