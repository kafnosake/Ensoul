export interface ChatQuote {
  id: string;
  type: 'text' | 'image';
  /** 选中的文本内容，或者图片在工作区的相对路径/绝对路径/URL */
  content: string;
  /** 来源角色或提示（可选） */
  source?: string;
}
