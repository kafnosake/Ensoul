/**
 * 组件库 —— 把"一块面板的做法"存下来，以后随时再开一个。
 *
 * 它治的是这件事：一块面板是慢慢调出来的 —— 类型、规格、按钮、外观、提示词，
 * 改到顺手要花好几轮。可关掉之后那份做法就只在布局里剩下那一个实例，
 * 想再开一个同款只能从头再讲一遍。
 *
 * 这里存的是**做法**（kind + look + spec + 标题），不是面板本身：
 *   · 存进 .ensoul/state/library.json —— 跟工作区走，重启、换窗口都还在
 *   · 调用 = 照这份做法**新建一个干净面板**；同一个组件想开几份就开几份
 *
 * 跟顶上那条「收纳区」分工不同，别弄混：
 *   · 收纳区收的是**面板本身**（连对话、草稿一起），点开还是那一个，接着往下聊
 *   · 组件库存的是**这种做法**，点开是新的一个（对话是空的）
 * 两种都留着，各有各的用处 —— 这条不是把收纳区换个做法，是补上缺的那一半。
 *
 * 面板（kind: library）只是这张架子的显示器 + 遥控器：
 *   状态  .ensoul/state/library.json      插件写、面板读
 *   命令  .ensoul/state/library.cmd.json  面板写、插件读（队列，认 seq）
 * 脸碰不到核心，也不用碰 —— 要新建面板就走命令文件回主进程。
 */

const fs = require('fs');
const path = require('path');
// 包与路径校验只有一份（src/shared/ensoulpack.ts），插件走那层薄壳转过去 ——
// 两个地方各写一套"条目名怎么算合法"，迟早在某一侧漏掉一条。
const { safePackId, safeEntryPath } = require('../../src/shared/ensoulpack.js');

const STATE_FILE = '.ensoul/state/library.json';
const CMD_FILE = '.ensoul/state/library.cmd.json';
/** 脸的轮询是 1.5 秒一次；这里比它快一档，点击到面板出现之间不留一段空等 */
const TICK = 300;
const MAX_ITEMS = 200;
const MAX_NAME = 60;
const MAX_NOTE = 200;
/**
 * 可分发的那份做法有**两个**位置 —— 跟核心找插件、找技能是同一个约定（跟软件走 + 跟工作区走）：
 *   · APP：插件自己带着的，跟着软件走、只读，`git pull` 就跟着新
 *   · WS ：跟着工作区走的那份，**能提交、能分发给别人**
 * 用户私人那份在 STATE_FILE（不进 git），自己随手存的草稿式模板住那儿。
 *
 * WS 那份**由核心写**（`src/main/store.ts` 的 putCraft：声明组件、改做法、撤销都在那儿），
 * 因为组件本体（那份带整段对话的存档）也归核心管 —— 做法跟对话分家这件事，
 * 分界线正好落在"核心管本体、插件管架子"这条老规矩上。插件只读，不写。
 */
const APP_PRESET_FILE = path.join(__dirname, 'presets.json');
/**
 * 跟着工作区走的做法：**一个组件一个文件**，文件名是面板 id。
 * 一件一个文件而不是所有人挤一份 —— 两个人各自发布组件时，
 * 挤在同一份文件里 git 必冲突；要从一大堆里抠出一条来单独开源也别扭。
 */
const WS_CRAFT_DIR = '.ensoul/library/components';
/** 老版本那个所有人挤一份的文件：核心启动时会把它拆开，这儿只是兜底认一下 */
const WS_LEGACY_FILE = '.ensoul/library/presets.json';

/** 模块级：dispose 要能收掉它（插件文件改了会重装，旧的那份靠这个收摊） */
let timer = null;

/**
 * 把一份原始清单收拾成条目 —— 三份（我的 / 软件自带 / 可分发）过同一套校验。
 * `source` 一路带到界面上，好让人一眼看出这条是私人的、软件带的、还是能发出去的。
 */
function shape(list, fallback) {
  const out = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    // 一条做法的身份证是**面板 id**：新写法两个字段都写，老写法只写 panel，都认
    const id = String(it.id || it.panel || '').trim();
    if (!id) continue;
    // 来源跟着条目走：读回盘时不能一律按“私人的”算 —— 那样出厂/可分发的标签
    // 每读一次就掉一次（库里那几条正是这么被改成 mine 的）
    const source = ['app', 'ws', 'mine'].includes(String(it.source)) ? String(it.source) : fallback;
    out.push({
      id,
      name: String(it.name || '').trim().slice(0, MAX_NAME) || t('未命名组件'),
      note: String(it.note || '').trim().slice(0, MAX_NOTE),
      // 类型认不出来也照存：面板那边按 kind 装配，这里不认识不等于核心不认识
      kind: String(it.kind || 'chat').trim() || 'chat',
      title: String(it.title || '').trim().slice(0, MAX_NAME),
      look: it.look && typeof it.look === 'object' ? it.look : {},
      spec: it.spec && typeof it.spec === 'object' ? it.spec : {},
      at: Number(it.at) || 0,
      // 这条做法对应哪块面板（核心按面板 id 认）—— 只用来显示归属，不参与判断
      panel: String(it.panel || '').trim(),
      preset: source !== 'mine' || it.preset === true,
      source,
    });
  }
  return out;
}

function load(api) {
  const raw = api.state.load(null) || {};
  return { at: Number(raw.at) || 0, items: shape(Array.isArray(raw.items) ? raw.items : [], 'mine') };
}

function readRaw(file) {
  try {
    const j = JSON.parse(require('fs').readFileSync(file, 'utf8'));
    return { note: String((j && j.note) || ''), items: Array.isArray(j && j.items) ? j.items : [] };
  } catch {
    return { note: '', items: [] }; // 没这份文件（或坏了）就当没有，不该拖累整个插件
  }
}

/** 扫一个目录，把里面每个 json 读成一条（坏的跳过，不拖累别的） */
function readDirItems(dir) {
  const out = [];
  let files = [];
  try {
    files = require('fs').readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));
  } catch {
    return out; // 还没这个目录（第一个组件声明时才生出来）
  }
  for (const f of files) {
    try {
      const j = JSON.parse(require('fs').readFileSync(path.join(dir, f), 'utf8'));
      if (j && typeof j === 'object') out.push(j);
    } catch {
      /* 坏文件跳过 */
    }
  }
  return out;
}

/**
 * 几处做法合起来：软件自带那份 + 工作区里一件一件的（+ 老的单文件，兜底）。
 * 工作区那份盖过软件那份 —— 同一台机器上的就地改动说话。
 * 去重按 **id**（面板 id / 出厂条目的 id），**不按名字**：
 * 两块面板叫同一个名字是常事，按名字去重会平白吃掉一条。
 */
function loadPresets(api) {
  if (typeof api.componentCrafts === 'function') {
    const byId = new Map();
    for (const item of shape(readRaw(APP_PRESET_FILE).items, 'app')) byId.set(item.id, item);
    for (const item of shape(api.componentCrafts(), 'ws')) byId.set(item.id, item);
    return [...byId.values()];
  }
  const wsDir = path.join(api.workspace || '.', WS_CRAFT_DIR);
  const drafts = [
    ...shape(readRaw(path.join(api.workspace || '.', WS_LEGACY_FILE)).items, 'ws'),
    ...shape(readDirItems(wsDir), 'ws'),
  ].sort((a, b) => (a.at || 0) - (b.at || 0)); // 新的盖旧的

  const byId = new Map();
  for (const i of shape(readRaw(APP_PRESET_FILE).items, 'app')) byId.set(i.id, i);
  for (const i of drafts) byId.set(i.id, i);
  return [...byId.values()];
}

/**
 * 把出厂模板并进库 —— 每次启动重来一遍，理由是"出厂那份永远只有一份、永远是最新的"：
 *   · 上一轮同步进来的出厂快照先砍掉，再照新的 presets.json 重新放一遍（软件更新后模板跟着新）
 *   · **同名以用户那份为准**：他动过手改过，就不该被出厂版盖回去
 *   · 用户自己的条目一个都不碰
 * 返回有没有变动；变了就得落盘 —— 面板读的是那份文件，不落盘等于没合。
 */
function mergePresets(state, presets) {
  const mine = state.items.filter((i) => !i.preset);
  // 按 **id** 去重，不按名字：两块面板叫同一个名字是常事，
  // 按名字会让其中一条平白消失（同名到底留哪条也该由用户看着挑，不该由代码替他决定）
  const taken = new Set(mine.map((i) => i.id));
  const next = mine.concat(presets.filter((p) => !taken.has(p.id)));
  // 用户存的新的在前；出厂的是 at=0，天然垫底（面板也按 at 排）
  next.sort((a, b) => (b.at || 0) - (a.at || 0));
  // 比的是**整条内容**，不是只比 id：id 一个没变、内容改了（改名、换类型、补说明、
  // 来源被读回盘那步抹成 mine）时，只比 id 会判成“没变”，架子上那份就永远停在旧版本上
  const sig = (i) => JSON.stringify([i.id, i.name, i.note, i.kind, i.title, i.look, i.spec, i.at, i.preset, i.source]);
  const before = state.items.map(sig).join('\u0000');
  const after = next.map(sig).join('\u0000');
  if (before === after) return false;
  state.items = next;
  return true;
}

function save(api, state) {
  state.at = Date.now();
  api.state.save(state);
}

/** 浅拷贝一份再存：别让后面对面板的改动顺着引用改到库里的条目 */
function clone(v) {
  try {
    return JSON.parse(JSON.stringify(v || {}));
  } catch {
    return {};
  }
}

function newId() {
  return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

/** 名字或 id 找一个 —— 先精确、再忽略大小写、最后认"名字里含这个" */
function findItem(state, key) {
  const k = String(key || '').trim();
  if (!k) return null;
  const low = k.toLowerCase();
  return (
    state.items.find((i) => i.id === k) ||
    state.items.find((i) => i.name === k) ||
    state.items.find((i) => i.name.toLowerCase() === low) ||
    state.items.find((i) => i.name.toLowerCase().includes(low)) ||
    null
  );
}

function nameList(state) {
  return state.items.length ? state.items.map((i) => `${i.name}（${i.kind}）`).join('、') : t('（库里还空着）');
}

module.exports = {
  name: 'library',
  description: t('模板库：把一块面板的做法（类型 + 规格 + 外观 + 提示词）存成模板，随时一键新建一个干净的同款'),

  /** 声明是纯数据（要过 IPC），必须在 module.exports 里面 —— 放外面整个插件加载不了 */
  panel: {
    kind: 'library',
    label: t('模板库'),
    hint: t('存下来的做法模板都在这儿，点一下新建一个干净的同款面板'),
    title: t('模板库'),
    body: 'messages',
  },

  setup(api) {
    const state = load(api);
    // 可分发的那两份每次启动合一遍（同名以用户那份为准），所以软件更新后模板跟着更新
    if (mergePresets(state, loadPresets(api))) save(api, state);
    const cmdPath = path.join(api.workspace || '.', CMD_FILE);
    let lastSeq = 0;

    /** 照一份组件新建面板 —— 存的是做法，新建出来的对话是空的 */
    function openItem(item, titleArg) {
      if (!item) return null;
      const p = api.createPanel({
        title: String(titleArg || '').trim().slice(0, MAX_NAME) || item.title || item.name,
        kind: item.kind,
        look: clone(item.look),
        spec: clone(item.spec),
      });
      return p;
    }

    api.addTool(
      {
        name: 'template_save', kits: ['ui'],
        description:
          t('把一块面板的**做法**存成组件（类型 + 规格 + 外观 + 提示词，**不含对话**），以后可以随时新建同款的干净面板。')
          + t('不给 panelId 就是存**当前这块面板**。同名再存一次就是更新那一份（改顺手了再存一遍）。')
          + t('存的是"这么做"而不是"这一个"：要连整段对话一起留住，用顶上的收纳区（把面板拖上去）。'),
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: t('组件名 —— 短、说清它是干什么的（会显示在组件库面板上）') },
            panelId: { type: 'string', description: t('存哪一块面板的做法；不写就是当前这块') },
            note: { type: 'string', description: t('一句说明（可选）：这个组件是做什么用的') },
          },
          required: ['name'],
        },
        level: 'write',
      },
      (args, ctx) => {
        const name = String((args && args.name) || '').trim().slice(0, MAX_NAME);
        if (!name) return t('要给组件起个名字（name）。');

        const all = api.panels();
        const want = String((args && args.panelId) || '').trim() || (ctx && ctx.panelId) || '';
        const src = all.find((p) => p.id === want);
        if (!src) {
          return `找不到那块面板${want ? `（${want}）` : ''} —— 现在开着的有：`
            + (all.length ? all.map((p) => `${p.title}（${p.kind} · ${p.id}）`).join('、') : t('（一块也没有）'));
        }

        const item = {
          name,
          note: String((args && args.note) || '').trim().slice(0, MAX_NOTE),
          kind: src.kind,
          title: src.title || '',
          look: clone(src.look),
          spec: clone(src.spec),
          at: Date.now(),
        };
        // 只认用户自己那份 —— 撞上同名出厂模板不算"更新"，是另存一份改过的（出厂那份就此让位）
        const old = state.items.find((i) => i.name === name && !i.preset);
        if (old) {
          item.id = old.id;
          Object.assign(old, item);
        } else {
          item.id = newId();
          state.items.push(item);
          if (state.items.length > MAX_ITEMS) state.items.splice(0, state.items.length - MAX_ITEMS);
        }
        state.items.sort((a, b) => b.at - a.at);
        save(api, state);

        return `已${old ? '更新' : '存下'}组件「${name}」：${src.kind} 面板的做法（对话没带进来）。`
          + `要照它新建一个：template_open({"name":"${name}"})。现在模板库里共 ${state.items.length} 个模板。`;
      },
    );

    api.addTool(
      {
        name: 'template_open', kits: ['ui'],
        description:
          t('从组件库里的一个组件**新建一块面板**（同款做法、干净的一份，可以开很多个）。')
          + t('name 给组件名或它的 id。要接着聊原来那一个，就用顶上的收纳区，别用这个。'),
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: t('组件名或 id') },
            title: { type: 'string', description: t('新面板的标题（可选；默认用组件存下来的标题）') },
          },
          required: ['name'],
        },
        level: 'write',
      },
      (args) => {
        const item = findItem(state, (args && args.name) || '');
        if (!item) {
          return `组件库里没有「${String((args && args.name) || '').trim()}」。现在有的是：${nameList(state)}`;
        }
        const p = openItem(item, args && args.title);
        if (!p) return t('面板没建起来（组件里的类型可能已经不可用了）。');
        return `已新建面板「${p.title}」（${item.kind}，照组件「${item.name}」的做法，对话是空的）。`;
      },
    );

    api.addTool(
      {
        name: 'template_list', kits: ['ui'],
        description: t('把组件库里存着的组件列一遍（名字、类型、说明）—— 想知道"我手上有哪些可以随手开的东西"时用它。'),
        parameters: { type: 'object', properties: {} },
        level: 'read',
      },
      () => {
        const presets = state.items.filter((i) => i.preset).length;
        if (!state.items.length) {
          return t('模板库还空着。看中哪块面板，用 template_save 把它的做法存成模板（{name:"模板名"}，不给 panelId 就是当前这块）。');
        }
        const tagOf = (i) => (i.source === 'app' ? t('·出厂') : i.source === 'ws' ? t('·可分发') : '');
        return `组件库（${state.items.length} 个${presets ? `，其中 ${presets} 个是可分发的做法（出厂 + 本工作区）` : ''}）：\n`
          + state.items
            .map((i, n) => `${n + 1}. ${i.name}  [${i.kind}]${tagOf(i)}${i.note ? ` —— ${i.note}` : ''}`)
            .join('\n');
      },
    );

      /** 面板写的命令队列：两次点击落在同一跳里也不会丢前一条 */
    function readCmdQueue() {
      try {
        const j = JSON.parse(require('fs').readFileSync(cmdPath, 'utf8'));
        return Array.isArray(j && j.cmds) ? j.cmds : [];
      } catch {
        return []; // 还没发过命令，或者正读到一半 —— 下一跳再说
      }
    }

    function clearCmdQueue() {
      try {
        require('fs').writeFileSync(cmdPath, JSON.stringify({ cmds: [] }), 'utf8');
      } catch {
        /* 清不掉就留着，下一跳还会走到这里 */
      }
    }

    /**
     * 一条命令：谁写的（panelId）只用来认归属，动作本身是全局的 ——
     * 组件库是这一整个工作区共享的一张架子，哪块面板上点的都一样。
     * 认 seq：同一个文件被重复读到不会执行第二遍（新建面板执行两遍就是开出来两块）。
     */
    function applyCmd(raw) {
      const from = String((raw && raw.panelId) || '');
      switch (raw && raw.cmd) {
        case 'new': {
          const item = state.items.find((i) => i.id === String(raw.id || ''));
          if (!item) return false;
          openItem(item, '');
          api.log(`面板 ${from || '?'} 点了组件「${item.name}」→ 新建一块 ${item.kind} 面板`);
          return true;
        }
        
        case 'import': {
          try {
            let comp = null;
            /**
             * 导入进来的东西**一律不可信**：id 会被拼成文件名、包里的条目名会被拼成路径。
             * 不夹住它们，一份 "../../../src/main/poison" 就能写到开源源码里去。
             * 所以：**任何一条不合规就整份拒绝**，一个字节都不落地。
             */
            const reject = (why) => {
              api.log(t('导入被拒绝：') + why);
              return false;
            };
            const rawData = String(raw.data || '');
            const overwrite = raw.overwrite === true;
            if (!rawData) {
              api.log(t('导入失败：数据为空'));
              return false;
            }
            if (rawData.trim().startsWith('{')) {
              comp = JSON.parse(rawData);
            } else {
              /*
               * .ensoulpack（zip）。按 docs/plugin-spec.md §5 逐条校验：
               *   spec 认不认识 · type 对不对 · files 摘要对不对
               * 任何一条不过就整包拒绝，并说清是哪条不过 —— 静默装进去半包是最坏的结果。
               */
              const ensoulpack = require('../../src/shared/ensoulpack.js');
              const crypto = require('crypto');
              const buf = Buffer.from(rawData, 'base64');
              const files = ensoulpack.parseZip(buf);
              const mfRaw = files.get('manifest.json');
              if (!mfRaw) throw new Error(t('根目录下缺少 manifest.json'));
              const mf = JSON.parse(mfRaw.toString('utf8'));
              if (mf.spec !== 1) throw new Error(t('不认识的包规范版本：') + mf.spec);
              if (mf.type !== 'component') throw new Error(t('这个包不是组件包（type 是 ') + mf.type + t('）'));

              // 摘要校验（files 是 [{path, sha256}]；老包写成对象也认）
              const list = Array.isArray(mf.files)
                ? mf.files
                : Object.entries(mf.files || {}).map(([p, s]) => ({ path: p, sha256: s }));
              for (const f of list) {
                const fb = files.get(f.path);
                if (!fb) throw new Error(t('包里缺文件：') + f.path);
                const sha = crypto.createHash('sha256').update(fb).digest('hex');
                if (f.sha256 && sha !== f.sha256) throw new Error(t('文件摘要对不上：') + f.path);
              }

              for (const [p, content] of files.entries()) {
                if (p === 'manifest.json' || !p.endsWith('.json')) continue;
                // 条目名先净化再读：越界的那一条直接整包拒绝，不是"跳过它"
                const safeP = safeEntryPath(p);
                if (!safeP) throw new Error(t('包里有不合规的条目名（不许绝对路径、不许 .. 越界）：') + p);
                comp = JSON.parse(content.toString('utf8'));
                break;
              }
            }

            if (!comp || !comp.kind) throw new Error(t('组件定义无效（缺 kind）'));

            /*
             * 文件名就是 id（见 store 的 craftFileOf：一个组件一个文件、文件名是面板 id）。
             * 压缩包里只净化了"用来找组件"的那一个条目名，真正落盘用的是 comp.id ——
             * 两个都夹住了，这个口子才算关上。
             */
            const cid = safePackId(comp.id);
            if (!cid) {
              return reject(
                t('组件 id 不合法（只许字母、数字、点、下划线、连字符，且不能是 . 或 ..）：') + String(comp.id ?? ''),
              );
            }
            comp.id = cid;

            /*
             * 同名冲突：面板那边已经问过用户了（覆盖 / 新建），这里照办。
             * 猜错方向的代价：覆盖错 = 白丢一份别人发来的改良版；新建错 = 库里
             * 长出一对分不清的双胞胎。所以这个选择**必须由人来点**，插件不替他想。
             */
            const at = state.items.findIndex((c) => c.id === comp.id || (comp.name && c.name === comp.name));
            if (at >= 0 && !overwrite) {
              const rnd = Math.random().toString(36).slice(2, 7);
              comp.id = 'panel-imp-' + rnd;
              comp.name = comp.name + t('（导入）');
            }

            // 落盘要拼**工作区的绝对路径**：插件进程的 cwd 是软件目录，不是工作区 ——
            // 拿相对路径去写，组件会落到软件自己的目录里（早先就是这么错的）
            const craftDir = path.join(api.workspace || '.', WS_CRAFT_DIR);
            if (!fs.existsSync(craftDir)) fs.mkdirSync(craftDir, { recursive: true });
            const targetFile = path.join(craftDir, comp.id + '.json');
            fs.writeFileSync(targetFile, JSON.stringify(comp, null, 2), 'utf8');

            mergePresets(state, loadPresets(api));
            save(api, state);
            api.log(
              at >= 0 && overwrite
                ? t('已覆盖组件「') + comp.name + t('」，落盘 ') + targetFile
                : t('已导入组件「') + comp.name + t('」，落盘 ') + targetFile,
            );
            return true;
          } catch (err) {
            api.log(t('导入组件失败：') + ((err && err.message) || err));
            return false;
          }
        }

        case 'drop': {
          const at = state.items.findIndex((i) => i.id === String(raw.id || ''));
          if (at < 0) return false;
          if (state.items[at].preset) {
            // 可分发的那两份删不掉：它们不在这个库里，删了下次启动还在
            const src = state.items[at].source === 'ws' ? `${WS_CRAFT_DIR}/` : 'plugins/library/presets.json';
            api.log(`面板 ${from || '?'} 想删「${state.items[at].name}」—— 不删（那条在 ${src}，要改就同名存一份自己的）`);
            return true;
          }
          const [gone] = state.items.splice(at, 1);
          save(api, state);
          api.log(`面板 ${from || '?'} 删掉了组件「${gone.name}」（已经开着的那块面板不受影响）`);
          return true;
        }
        default:
          return false;
      }
    }

    function tick() {
      let applied = false;
      for (const raw of readCmdQueue()) {
        const s = Number(raw && raw.seq);
        if (!Number.isFinite(s) || s <= lastSeq) continue; // 执行过的跳过
        lastSeq = s;
        if (applyCmd(raw)) applied = true;
      }
      if (applied) clearCmdQueue();

      // 做法那份文件由核心写（声明、改做法、撤销都在它那儿），这儿只管读 ——
      // 但组件一改，架子上那份清单得跟着刷新，所以照样每跳合一次。
      if (mergePresets(state, loadPresets(api))) save(api, state);
    }

    timer = setInterval(tick, TICK);
    if (timer && typeof timer.unref === 'function') timer.unref();

    api.log(
      `组件库就绪（私人库 ${STATE_FILE}，可分发 ${APP_PRESET_FILE} + ${WS_CRAFT_DIR}/，`
      + t('命令 ${CMD_FILE}，共 ${state.items.length} 个，其中可分发 ${state.items.filter((i) => i.preset).length} 个）'),
    );
  },

  dispose() {
    if (timer) clearInterval(timer);
    timer = null;
  },
};
