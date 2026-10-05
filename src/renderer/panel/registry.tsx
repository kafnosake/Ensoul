import React from 'react';
import type { Panel, PanelSpec } from '../../shared/types';
import { defaultLook } from '../../shared/types';
import { FileTree } from './FileTree';
import { EditorBody } from './EditorBody';
import { api } from '../core/api';
import { t } from '../core/i18n';

/**
 * 面板类型注册表。
 *
 * 内置的那几种（chat / files / editor / table / form / web）在这里注册。
 * **插件自带的面板不在这儿** —— 它们的声明在 `plugins/<名>/index.js` 的 `panel` 字段，
 * 脸在 `plugins/<名>/panel.tsx`、皮在 `panel.css`，由 `pluginPanels.ts` 那个管理器
 * 按插件清单装配进来（启动之后才装，所以这里带了订阅）。
 *
 * 为什么拆成两处：内置面板是"核心做不到没人能做"的那部分（对话本身就是核心），
 * 插件面板是"长了就长在插件里"的那部分 —— 加一种插件面板不该回来改这个文件。
 * 加**内置**类型才用 registerPanelType，并记得把 kind 加进 shared/types 的 BUILTIN_KINDS。
 */

export interface PanelTypeDef {
  /** 类型名，存进 Panel.kind */
  kind: string;
  /** 菜单里显示的名字 */
  label: string;
  /** 菜单里的一句说明 */
  hint?: string;
  /** 新建这种面板时的初始内容 */
  create(): Partial<Panel> & { kind: string };
  /** 主体怎么渲染。外观、对话区、回退由 PanelSurface 统一负责 */
  body(props: { panel: Panel; setText(text: string): void }): React.ReactNode;
  /**
   * 这种面板浮起来时，壳上**不画底**、透明处也**不吃鼠标**（漏给底下的面板）——
   * 只有"整块内容浮在别的面板上面"的挂件才声明它。
   * 会话、文件这些浮起来照样是实心一块：里面是要读的正文，透上来就没法看。
   */
  floatBare?: boolean;
}

const registry = new Map<string, PanelTypeDef>();

/**
 * 注册表是**会长的**：插件自带的面板类型在启动之后才装进来（要等插件清单从主进程回来）。
 * 所以它得能被订阅 —— 不然装完了界面也不会重渲染，看起来就是"插件装了没反应"。
 */
const listeners = new Set<() => void>();
let revision = 0;

export function subscribePanelTypes(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 给 useSyncExternalStore 用的快照：变了就重渲染 */
export function panelTypesRevision(): number {
  return revision;
}

function emit() {
  revision++;
  for (const fn of listeners) fn();
}

export function registerPanelType(def: PanelTypeDef) {
  registry.set(def.kind, def);
  emit();
}

/** 插件被停用/删掉时把它那一种收走 */
export function unregisterPanelType(kind: string): boolean {
  const had = registry.delete(kind);
  if (had) emit();
  return had;
}

export function panelTypes(): PanelTypeDef[] {
  return [...registry.values()];
}

export function panelType(kind: string): PanelTypeDef | undefined {
  return registry.get(kind);
}

// ---------------------------------------------------------------- 内置类型

const spec = (body: PanelSpec['body'], text = ''): PanelSpec => ({
  body,
  systemPrompt: '',
  actions: [],
  fields: [],
  text,
});

/**
 * 只有"对话"面板自己带输入框。
 * 别的面板（文本、文件、表格……）默认**不带会话** —— 编辑器就是编辑器；
 * 需要让它被对话改写时，点标签上的对话图标就地开一个。
 */
const noChat = { ...defaultLook(), showChat: false };

registerPanelType({
  kind: 'chat',
  label: t('对话'),
  hint: t('空面板，靠对话把它改造成任何东西'),
  create: () => ({ kind: 'chat', title: t('默认对话面板'), spec: spec('messages') }),
  body: ({ panel }) => (
    <div className="body-blank">
      <div className="blank-title">{panel.title}</div>
      <div className="blank-note">{t('对它说一句话，它会按你说的话改写自己。')}</div>
    </div>
  ),
});

registerPanelType({
  kind: 'files',
  label: t('文件'),
  hint: t('工作区目录树，点文件就打开'),
  create: () => ({ kind: 'files', title: t('文件'), look: noChat, spec: spec('messages') }),
  body: () => <FileTree />,
});

registerPanelType({
  kind: 'editor',
  label: t('文本'),
  hint: t('可以直接写、也可以打开工作区里的文件'),
  create: () => ({ kind: 'editor', title: t('文本'), look: noChat, spec: spec('code', '') }),
  body: ({ panel, setText }) => <EditorBody panel={panel} setText={setText} />,
});

registerPanelType({
  kind: 'table',
  label: t('表格'),
  hint: t('每行一条，逗号分隔'),
  create: () => ({ kind: 'table', title: t('表格'), look: noChat, spec: spec('table', '第一列,第二列\n值,值') }),
  body: ({ panel }) => {
    const rows = (panel.spec.text || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(','));
    if (rows.length === 0) return <div className="blank">{t('还没有数据（每行一条，逗号分隔）。')}</div>;
    return (
      <table className="body-table">
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i}>
              {cells.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  },
});

registerPanelType({
  kind: 'form',
  label: t('表单'),
  hint: t('由对话生成的字段'),
  create: () => ({ kind: 'form', title: t('表单'), look: noChat, spec: spec('form') }),
  body: ({ panel }) => (
    <div className="body-form">
      {/* fields 可能缺（老存档 / 第三方规格）—— 缺了当空表，别在渲染期抛 */}
      {(panel.spec.fields ?? []).length === 0 && <div className="blank">{t('这个面板还没有字段。')}</div>}
      {(panel.spec.fields ?? []).map((f) => (
        <label key={f.key}>
          <span>{f.label}</span>
          <input type={f.type === 'number' ? 'number' : f.type === 'bool' ? 'checkbox' : 'text'} />
        </label>
      ))}
    </div>
  ),
});

registerPanelType({
  kind: 'web',
  label: t('网页'),
  hint: t('内嵌一个网址'),
  create: () => ({ kind: 'web', title: t('网页'), look: noChat, spec: spec('web', 'https://') }),
  body: ({ panel }) => <iframe className="body-web" src={panel.spec.text} title={panel.title} />,
});

// 便利贴（便签）**不在这儿** —— 它本来就是 plugins/notes 的一份声明，
// 脸在 plugins/notes/panel.tsx。核心以前替它注册了 sticker / notes 两个 kind，
// 那是越界：核心 import 了插件的脸。现在 alias 由插件自己声明（见 PluginPanelDecl.aliases）。

/** 用对话把面板改成别的类型时，也要能落到注册表上 */
export function createByKind(kind: string): Partial<Panel> & { kind: string } {
  const def = panelType(kind);
  return def ? def.create() : { kind: 'chat', title: t('新面板'), spec: spec('messages') };
}
