/**
 * send-image —— 把一张图**直接发进对话**给用户看（按磁盘路径）。
 *
 * 界面是核心画的（插件跑在主进程，画不了界面），所以这里只做两件事：认路径、
 * 然后喊核心的 `api.live.image()` —— 图就挂在这一轮的回答上，用户在对话里直接看见，
 * 不用去文件面板里翻。路径只认磁盘上的文件，不收 base64：
 * 图塞进 workspace.json 会让它越滚越大（见 shared/types.ts 里 ChatMessage.images 那段）。
 *
 * 为什么单独一个插件、而不是塞进 comfyui：出图只是"发图"的一个来源。
 * 截图、跑出来的图表、别处下的参考图都走同一条路 —— 谁也不该依赖 ComfyUI 在不在。
 */

const fs = require('fs');
const path = require('path');

/** 浏览器能直接显示的几种。别的（psd、tiff、svg）不发 —— 发过去也是个裂图框 */
const EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'];

module.exports = {
  name: 'send-image',
  description: t('把一张图片按路径直接发进对话（用户在对话里直接看见）'),

  setup(api) {
    const root = () => api.workspace;

    api.addTool(
      {
        name: 'send_image', kits: ['art'],
        description:
          t('把一张图直接发进对话给用户看（PNG / JPEG / WebP / GIF / BMP / AVIF）。')
          + t('path 给工作区里的相对路径或本机绝对路径 —— 截图、图表、下载来的参考图都能发，')
          + t('发完用户在对话里直接看见，不用让他去文件面板里找。'),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: t('图片路径：工作区相对路径，或者本机绝对路径') },
          },
          required: ['path'],
        },
        level: 'read',
      },
      (args, ctx) => {
        const raw = String((args && args.path) || '').trim().replace(/^["']|["']$/g, '');
        if (!raw) return t('path 得给：图在工作区里的路径，或者本机的绝对路径。');

        const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root(), raw);
        let size = 0;
        try {
          const st = fs.statSync(abs);
          if (!st.isFile()) return `${raw} 是个目录，不是文件 —— 发图得给具体某个图片文件。`;
          size = st.size;
        } catch {
          return `找不到这个文件：${raw}。给工作区里的相对路径，或者一个本机绝对路径。`;
        }

        const ext = path.extname(abs).toLowerCase();
        if (!EXTS.includes(ext)) {
          return `${ext || '（没有扩展名）'} 不是能直接显示的图片格式，认这些：${EXTS.join(' ')}。`;
        }

        const panelId = ctx && ctx.panelId;
        // 老核心（没重启过）里没有 api.live：那就直说发不出去，别假装成功
        if (!panelId || !api.live || typeof api.live.image !== 'function') {
          return `图找到了（${raw}，${Math.round(size / 1024)} KB），但这一轮没挂在对话上，发不出去。`;
        }
        api.live.image(panelId, abs);
        return `已经把 ${path.basename(abs)}（${Math.round(size / 1024)} KB）发进对话了，用户直接看得见 —— 你不用再把路径贴一遍给他。`;
      },
    );
  },
};
