import React, { useEffect, useState } from 'react';
import { api } from '../core/api';
import { shotUrl } from '../panel/chat/format';
import { closeImage, subscribeImage, type ImageViewState } from './image-open';
import { t } from '../core/i18n';

/**
 * 看图 —— 对话里点任何一张图都走它，**只铺满发起的那块面板**。
 *
 * 为什么这一块必须在核心里、不能做成插件：**插件跑在主进程，画不了界面**。
 * 界面渲染、以及"点一下图能开"的接线，是核心留给自己那几件事之一。
 * （插件那边能做的只是"把图发进对话"，见 comfyui 插件的 comfyui_run / send_image。）
 *
 * 为什么每块面板各挂一份、而不是挂在根上：挂在根上时它是 `position: fixed; inset: 0`，
 * 一张图把整个窗口都盖了 —— 侧边栏、标题栏、别的面板统统压掉，
 * 可"我在看这张图"只跟**这块面板**有关。现在按 absolute 铺满自己那块面板
 * （父级 .panel-surface 是 relative），几何上就出不去。
 * 谁开的图由 image-open 里那个 panel 字段认，不是这块面板开的就不亮。
 *
 * 摆法：点图**以外**的任何地方都关（图四周那圈留白也算）、Esc 也关；
 * 双击在"适应窗口"和"原始大小"之间换；顶栏两个"交给系统"的动作。
 * 图按磁盘路径走 —— 不转 base64、不进工作区文件。
 */
export function ImageView({ panel }: { panel: string }) {
  const [view, setView] = useState<ImageViewState | null>(null);
  /** 原始大小（true）还是缩到看得见全图（false）。换图时复位 */
  const [full, setFull] = useState(false);

  useEffect(() => subscribeImage((v) => {
    setView(v);
    setFull(false);
  }), []);

  useEffect(() => {
    // 只有**开着图的那一块**去听键盘：每块面板里都挂着一份查看层，
    // 全都注册的话按一下 Esc 会关好几遍（结果一样，但没必要）
    if (!view || view.panel !== panel) return;
    // Esc 关：看图时手不用离开键盘
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeImage();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [view, panel]);

  // 图是**这块面板**里点开的才摆出来：别处开的图不该在这儿冒头
  if (!view || view.panel !== panel) return null;
  const { path } = view;
  const name = path.replace(/\\/g, '/').split('/').pop() || path;

  return (
    <div className={`imgview${full ? ' is-full' : ''}`} onMouseDown={closeImage}>
      <div className="imgview-bar" onMouseDown={(e) => e.stopPropagation()}>
        <span className="imgview-name" title={path}>
          {name}
        </span>
        <span className="imgview-hint">{full ? t('双击缩回适应窗口') : t('双击看原始大小')}</span>
        <button onClick={() => void api.shell.open(path)} title={t('用系统默认的看图程序打开')}>
          {t('用系统看图器打开')}
        </button>
        <button onClick={() => void api.shell.reveal(path)} title={t('在资源管理器里定位到这张图')}>
          {t('在文件夹里显示')}
        </button>
        <button className="imgview-x" onClick={closeImage}>
          {t('关闭')}
        </button>
      </div>
      {/* 图那一片**不拦事件**。以前这层 stopPropagation 了，而它铺满顶栏以下整片 ——
          于是"点图外面"永远落进这一层、点哪儿都关不掉。现在只有图自己拦：
          点图、双击缩放照旧，点在它周围那圈空处 = 点背景 = 关。 */}
      <div className="imgview-stage">
        <img
          src={shotUrl(path)}
          alt={name}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={() => setFull((v) => !v)}
        />
      </div>
    </div>
  );
}
