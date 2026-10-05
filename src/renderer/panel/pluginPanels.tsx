/// <reference types="vite/client" />
import * as React from 'react';
import { BUILTIN_KINDS, defaultLook, defaultSpec } from '../../shared/types';
import type { PanelFaceProps, PluginInfo, PluginPanelDecl } from '../../shared/types';
import { api } from '../core/api';
import { panelType, registerPanelType, unregisterPanelType, type PanelTypeDef } from './registry';

/**
 * 插件自带面板的**管理器**。
 *
 * 这一层存在的理由只有一个：**加一种插件面板，不用再回来改核心的 registry.tsx**。
 *
 * 分工是死的，就在这里：
 *
 *   plugins/<名>/index.js    声明"我有一种面板"——纯数据（要过 IPC，函数过不去）
 *   plugins/<名>/panel.tsx   这张脸——渲染层组件，下面 glob 在**构建时**收走
 *   plugins/<名>/panel.css   这点皮——同上，收走就随包走
 *
 * 核心只干装配：声明 + 脸 → 注册表里的一项；插件被停用/删掉就卸下来。
 *
 * ── 两条边界，写清楚免得后来的人白试 ──────────────────────────────────
 *
 * · **工作区插件（<工作区>/.ensoul/plugins）带不了脸。** glob 是构建期定下来的，
 *   一个运行期才出现的目录不可能被打进渲染包里。工作区插件照样能加工具、加提示、
 *   写自己的状态，只是不能自带界面 —— 要脸就放进软件自带的 plugins/。
 *
 * · **撞内置 kind 的声明一律忽略**（内置赢，见 BUILTIN_KINDS）：插件不该把"对话"
 *   变成别的东西。撞上已经装了脸的别的插件，同样先到先得。
 */

/** 插件目录里的脸：`plugins/<名>/panel.tsx` 的默认导出 */
const faces = import.meta.glob('/plugins/*/panel.tsx', { eager: true }) as Record<
  string,
  { default?: React.ComponentType<PanelFaceProps> }
>;

/**
 * 插件目录里的皮。这里不看返回值 —— glob 到就等于"它会被打进包里"。
 * 顺序在建制上排在核心样式之后，所以插件想盖核心的样式盖得住。
 */
const skins = import.meta.glob('/plugins/*/panel.css', { eager: true }) as Record<string, unknown>;
void skins;

const faceOf = (plugin: string): React.ComponentType<PanelFaceProps> | undefined =>
  faces[`/plugins/${plugin}/panel.tsx`]?.default;

/** kind → 装它的插件名；用来判断"该卸的卸、该换的换" */
const installed = new Map<string, string>();
/** kind → 声明的指纹；声明改了就重装一次 */
const prints = new Map<string, string>();

function makeDef(decl: PluginPanelDecl, face: React.ComponentType<PanelFaceProps>): PanelTypeDef {
  const Face = face;
  return {
    kind: decl.kind,
    label: decl.label,
    hint: decl.hint,
    floatBare: decl.floatBare === true,
    create: () => ({
      kind: decl.kind,
      title: decl.title ?? decl.label,
      // 默认跟内置工具面板一致：不带会话栏（需要时用户点标签上的对话图标就开）
      look: { ...defaultLook(), showChat: false, ...decl.look },
      spec: { ...defaultSpec('chat'), body: decl.body ?? 'messages', text: decl.text ?? '' },
    }),
    /**
     * 给脸的东西就这四样：自己、改自己、读写文件。
     * **不给全量 api** —— 脸跑在渲染进程，不该绕过停靠树/对话/持久化这些核心。
     */
    body: ({ panel, setText }) => (
      <Face
        panel={panel}
        setText={setText}
        patch={(p) => void api.panel.patch(panel.id, p)}
        fs={{
          read: (rel) => api.fs.read(rel),
          readJson: (rel) => api.fs.readJson(rel),
          write: (rel, text) => api.fs.write(rel, text),
          // 要读可能很大的快照时先看大小：超过上限就别读（读回来是一句占位文字，不是 JSON）
          list: (rel) => api.fs.list(rel),
        }}
      />
    ),
  };
}

/**
 * 按插件清单装/卸面板类型。**幂等**：清单没变就什么都不做，返回这次动了几种。
 * 外壳挂载时、以及插件启停之后都可以放心调。
 */
export function installPluginPanels(plugins: PluginInfo[]): number {
  const want = new Map<string, { decl: PluginPanelDecl; face: React.ComponentType<PanelFaceProps>; name: string }>();

  for (const info of plugins) {
    const decl = info.panel;
    if (!decl || !info.enabled) continue;
    const face = faceOf(info.name);
    if (!face) {
      console.warn(`[插件 ${info.name}] 声明了面板 ${decl.kind}，但 plugins/${info.name}/panel.tsx 没找到 —— 没有脸，装不上`);
      continue;
    }
    // 主 kind + 它认的旧名，一起装 —— 老存档里存的是旧 kind，改名了也得开得出来
    for (const kind of [decl.kind, ...(decl.aliases ?? [])]) {
      const owner = installed.get(kind);
      if ((BUILTIN_KINDS as readonly string[]).includes(kind) || (panelType(kind) && owner !== info.name)) {
        console.warn(`[插件 ${info.name}] 面板类型 ${kind} 已被占用（内置或别的插件），这条声明忽略`);
        continue;
      }
      want.set(kind, { decl: { ...decl, kind }, face, name: info.name });
    }
  }

  let changed = 0;
  // 先卸：插件没了、被停用了，它那一种面板就该消失
  for (const kind of [...installed.keys()]) {
    if (want.has(kind)) continue;
    unregisterPanelType(kind);
    installed.delete(kind);
    prints.delete(kind);
    changed++;
  }
  // 再装：同一插件同样的声明就不重装（免得每轮都 emit 一次、把界面刷一遍）
  for (const [kind, w] of want) {
    const print = JSON.stringify(w.decl) + '|' + kind;
    if (installed.get(kind) === w.name && prints.get(kind) === print) continue;
    installed.set(kind, w.name);
    prints.set(kind, print);
    registerPanelType(makeDef(w.decl, w.face));
    changed++;
  }
  return changed;
}

/** 外壳挂一次：拉插件清单 → 装配 */
export async function refreshPluginPanels(): Promise<number> {
  try {
    const snap = await api.ext.list();
    return installPluginPanels(snap.plugins ?? []);
  } catch (e) {
    console.warn('插件面板装配失败：', e);
    return 0;
  }
}
