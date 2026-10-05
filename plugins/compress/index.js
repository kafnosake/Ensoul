/**
 * compress —— 上下文压缩。
 *
 * 压缩 = 让模型把旧对话写成一份纪要，之后那段原文不再送出去。核心在真正要压的那一刻
 * 才问一次模型，所以这件事**不需要挑模型时看重的那个智商**，而用户为了让聊天聪明
 * 往往把面板挂在最贵的一档 —— 白付。这个插件就是"压缩"这件事的家：
 *
 *   · 它用哪个模型 —— `api.addCompactPick`，答"这次压缩用谁"。手动 /compress 和自动
 *     压缩共用核心那一份实现，所以在这儿设一次、两条路都生效。
 *   · `/compress` 这条命令 —— `api.addCommand` + `api.compressChat`（摘要和落盘归核心，
 *     压缩这件事归这里）。命令和"用哪个模型"本来就该待在一起，分在两处谁也说不清谁在管事。
 *
 * 挑谁**不是**另开一页设置，就是本插件的**一个可调参数**（设置 → 插件 → 展开 compress，
 * 跟番茄钟的"专注时长"并排）。值存在 `.ensoul/state/plugin-params.json` —— 那是参数本来
 * 就有的家，插件不必再自己攒一份状态。
 */

/** 下拉里那一条"别管，跟面板自己选的那个走" —— 不是真模型名，认不出就自然落回面板 */
const AUTO = '__auto__';

module.exports = {
  name: 'compress',
  description: t('上下文压缩：把旧对话写成前情纪要（/compress）。压哪个模型由参数指定，挑个便宜的'),

  params: {
    model: {
      label: t('压缩用哪个模型'),
      type: 'select',
      default: AUTO,
      // 静态那一条排在最前，后面由核心按 optionsFrom 现填模型清单（值是 `提供方::模型`）
      options: [{ value: AUTO, label: t('跟面板走（不单独指定）') }],
      optionsFrom: 'models',
      hint: t('压缩要额外问一次模型，挑个便宜的能省不少；「跟面板走」就是跟聊天用同一个'),
    },
  },

  setup(api) {
    /**
     * 压缩上下文：把这一路压成一份摘要，原文从会话区收起（后台隐性保存），
     * 于是"带着前情另起一个分支" —— 和 /clear 正好差在这：那个连摘要一起清，是真的重来。
     *
     * 摘要要用模型出，所以不是同步返回一句话就完 —— api.compressChat 内部等它跑完
     * （实测一次几秒到几十秒，长的对话更久）。斜杠命令那条路本来就是主进程直接跑、
     * 返回什么就是什么，所以这里 await 得住，模型一个字都插不进来。
     */
    if (typeof api.compressChat === 'function') {
      api.addCommand(
        { id: 'compress', label: t('压缩上下文'), hint: t('/compress —— 把这一路压成摘要，原文隐性保存，另起一个分支') },
        async (_argText, ctx) => {
          const id = (ctx && ctx.panelId) || '';
          if (!id) return t('命令没有执行：不知道是哪块面板。');
          return api.compressChat(id);
        },
      );
    }

    // 压缩那一刻，核心问一句"这次用谁"；空串 = 没意见，用面板自己那个
    if (typeof api.addCompactPick === 'function') {
      api.addCompactPick(() => {
        const v = String(api.param('model', AUTO) || '');
        return v === AUTO ? '' : v;
      });
    } else {
      api.log(t('这个核心还没有 addCompactPick 口子，选模型那一项不生效（需要更新软件）'));
    }

    const cur = String(api.param('model', AUTO) || '');
    api.log(`就绪：/compress 已就位，压缩${cur === AUTO ? '跟面板走' : `用 ${cur}`}`);
  },
};
