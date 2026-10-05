/**
 * 长文本英文词典 —— **已移出加载路径**（2026-10-04）。
 *
 * 真表在 work/i18n/dict/en.prompts.ts。这里留空表，i18n.ts 照旧 import 它，
 * 拿到的空对象让 DICT.en 为空 —— 所有文案回落中文原文（原生表现）。
 * 要恢复：把 work/i18n/dict/en.prompts.ts 的内容贴回这里。
 */
export const EN_PROMPTS: Record<string, string> = {};
