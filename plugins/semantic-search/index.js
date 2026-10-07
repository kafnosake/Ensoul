const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
for (const modulePath of ['./runtime', './bootstrap', './engine', './corpus']) delete require.cache[require.resolve(modulePath)];
const { ModelRuntime, prepareEnvironment } = require('./runtime');
const { scanCorpus } = require('./corpus');
const { SemanticIndex } = require('./engine');
const { extractDocument } = require('./extract');
const analytics = require('./analytics');

const SOURCES = ['documents', 'code', 'history', 'images', 'audio', 'video'];
const FEATURES = {
  documents: ['文档检索', '按语义检索工作区中的 Markdown、TXT、PDF、Word 与表格等文件'],
  code: ['代码检索', '按功能描述匹配代码实现，定位到真实文件与行号'],
  history: ['会话检索', '检索当前工作区各面板的对话历史与上下文记录'],
  historyArchives: ['跨工作区旧会话', '包含本机没有工作区标记的关闭和收纳会话'],
  images: ['图片检索', '用文字或图片寻找工作区中的图片（多模态特性）'],
  audio: ['音频检索', '用文字或音频寻找相关声音内容'],
  video: ['视频检索', '用文字或视频寻找相关画面内容'],
  agentSearch: ['助手检索工具', '让各面板中的助手按需自动调取语义检索并引用原文'],
  similarity: ['相似度比较', '比较文字、图片、音频和视频内容相似度'],
  classification: ['内容分类', '按提供的类别名称零样本匹配内容'],
  clustering: ['内容分组', '把相近的内容自动归到同一组'],
  autoIndex: ['自动更新索引', '开启后每分钟轻量检查内容变化，复用已有向量'],
};
const DEFAULTS = {
  schemaVersion: 1, enabled: false,
  features: Object.fromEntries(Object.keys(FEATURES).map(k => [k, k !== 'historyArchives'])),
  config: { python: 'python', model: 'google/embeddinggemma-2', dimensions: 768, device: 'auto', proxy: 'system', roots: [] },
  runtime: { status: 'idle', message: '尚未准备模型' },
  index: { status: 'idle', items: 0, indexedAt: null }, panels: {},
};

let shutdown = null;

function loadState(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const state = { ...DEFAULTS, ...raw, features: { ...DEFAULTS.features }, config: { ...DEFAULTS.config }, panels: {} };
  state.enabled = raw.enabled === true;
  for (const key of Object.keys(FEATURES)) if (typeof raw.features?.[key] === 'boolean') state.features[key] = raw.features[key];
  for (const key of ['python', 'model', 'device', 'proxy']) if (typeof raw.config?.[key] === 'string' && raw.config[key].trim()) state.config[key] = raw.config[key];
  if ([128, 256, 512, 768].includes(raw.config?.dimensions)) state.config.dimensions = raw.config.dimensions;
  if (Array.isArray(raw.config?.roots)) state.config.roots = raw.config.roots.filter(x => typeof x === 'string');
  state.index = { ...DEFAULTS.index, ...raw.index, status: raw.index?.status === 'stale' ? 'stale' : raw.index?.indexedAt ? 'ready' : 'idle' };
  state.runtime = { status: state.enabled ? 'idle' : 'disabled', message: state.enabled ? '按需加载本地模型' : '已关闭' };
  if (!['auto', 'cpu', 'cuda'].includes(state.config.device)) state.config.device = 'auto';
  state.operation = null;
  return state;
}

function userDataDirectory() {
  const electron = require('electron');
  return electron?.app?.getPath('userData') || '';
}

module.exports = {
  name: 'semantic-search',
  description: 'EmbeddingGemma 2 本地多模态检索、内容比较、分类和分组',
  panel: { kind: 'semantic-search', label: '语义搜索', title: '语义搜索', hint: '用描述或素材寻找工作区内容' },

  setup(api) {
    const t = api.t || (text => text);
    const state = loadState(api.state.load(null));
    const workspace = api.workspace || '';
    const directory = path.join(workspace, '.ensoul', 'semantic-search');
    const envBase = api.environments?.directory('semantic-search') || path.join(userDataDirectory(), 'env', 'semantic-search');
    const envDir = path.join(envBase, `${process.platform}-${process.arch}`);
    const legacyModels = path.join(workspace, '.ensoul', 'runtime', 'semantic-search', 'models');
    const commands = path.join(directory, 'commands');
    let disposed = false, runtime = null, engine = null, job = null, reading = false, lastWrite = 0;
    let nextUpdate = Date.now() + 60000, modelProxy = state.config.proxy;
    let advanced = false;
    const activeRequests = new Set();
    const receipts = new Map();

    function save(force = true) {
      if (disposed) return;
      if (!force && Date.now() - lastWrite < 500) return;
      const liveIds = new Set(api.panels().map(panel => panel.id));
      for (const panelId of Object.keys(state.panels)) if (!liveIds.has(panelId)) delete state.panels[panelId];
      for (const [panelId, reply] of Object.entries(state.panels)) {
        if (reply.requestId && ['done', 'error', 'cancelled'].includes(reply.status)) receipts.set(`${panelId}:${reply.requestId}`, reply);
      }
      while (receipts.size > 128) receipts.delete(receipts.keys().next().value);
      if (!api.state.save(state)) throw new Error('语义搜索状态保存失败');
      lastWrite = Date.now();
    }

    function pythonPath() {
      const privatePython = path.join(envDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      return fs.existsSync(privatePython) ? privatePython : state.config.python;
    }

    function getRuntime() {
      if (!runtime) runtime = new ModelRuntime({
        python: pythonPath(), model: state.config.model, dimensions: state.config.dimensions,
        device: state.config.device, proxy: modelProxy, cacheDir: path.join(envBase, 'models'),
        vision: state.features.images || state.features.video, audio: state.features.audio,
        onStatus: status => { if (!disposed && job && !job.controller.signal.aborted) { state.runtime = { ...state.runtime, ...status }; save(false); } },
      });
      return runtime;
    }

    function getEngine() {
      if (!engine) engine = new SemanticIndex({
        directory: path.join(directory, 'index'), runtime: getRuntime(), getFeatures: () => state.features,
        scan: ({ signal } = {}) => scanCorpus({ workspace, userData: userDataDirectory(), features: state.features, roots: state.config.roots, signal,
          extract: (file, options) => extractDocument(pythonPath(), file, options),
          onProgress: progress => { if (!disposed && job && !job.controller.signal.aborted) { state.index.progress = progress; save(false); } },
        }),
        onStatus: status => { if (!disposed && job && !job.controller.signal.aborted) { state.index = { ...state.index, ...status, progress: status.phase === 'embedding' ? { completed: status.completed, total: status.total } : state.index.progress }; save(false); } },
      });
      return engine;
    }

    function stop() {
      job?.controller.abort();
      runtime?.close();
      runtime = null;
      engine = null;
    }

    function assertEnabled(feature) {
      if (!state.enabled) throw new Error('语义搜索已关闭，请在设置 → 语义搜索中开启');
      if (!workspace) throw new Error('请先选择工作区');
      if (feature && !state.features[feature]) throw new Error(`${FEATURES[feature][0]}已关闭`);
    }

    async function inputsOf(values) {
      if (!Array.isArray(values) || values.length < 1 || values.length > 100) throw new Error('请提供 1–100 项内容');
      const results = [];
      for (const value of values) {
        const input = typeof value === 'string' ? { text: value } : value;
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('内容必须是文字或多模态输入');
        const item = {};
        if (input.text !== undefined) {
          if (typeof input.text !== 'string' || input.text.length > 20000) throw new Error('输入文字应少于 20000 字');
          if (input.text.trim()) item.text = input.text;
        }
        for (const [key, feature] of [['image', 'images'], ['audio', 'audio'], ['video', 'video']]) {
          if (input[key] === undefined) continue;
          if (!state.features[feature]) throw new Error(`${FEATURES[feature][0]}已关闭`);
          if (typeof input[key] !== 'string') throw new Error('素材应为工作区内的本地文件路径');
          const resolved = await fs.promises.realpath(path.resolve(workspace, input[key]));
          const root = await fs.promises.realpath(workspace);
          const relative = path.relative(root, resolved);
          if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('素材路径必须位于当前工作区内');
          if (!(await fs.promises.stat(resolved)).isFile()) throw new Error('素材路径应指向文件');
          item[key] = resolved;
        }
        if (!Object.keys(item).length) throw new Error('请输入描述或选择素材');
        results.push(item);
      }
      return results;
    }

    async function perform(action, args, signal) {
      if (signal.aborted) throw new Error('操作已取消');
      if (action === 'setup') {
        delete state.setup;
        if (workspace && fs.existsSync(legacyModels)) {
          state.runtime = { status: 'installing', message: '正在复用已有模型缓存' }; save();
          await fs.promises.cp(legacyModels, path.join(envBase, 'models'), { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true });
        }
        await perform('install', args, signal);
        if (signal.aborted) throw new Error('操作已取消');
        const result = await perform('prepare', args, signal);
        state.setup = { device: state.config.device, model: state.config.model, completedAt: Date.now(), actualDevice: result.device };
        state.runtime = { ...result, status: 'ready', message: '全部配置完成，可以启用语义搜索' };
        return result;
      }
      if (action === 'install') {
        if (state.config.proxy === 'system') {
          const session = require('electron').session?.defaultSession;
          const resolved = session ? await session.resolveProxy('https://huggingface.co') : '';
          const match = /(?:^|;\s*)(PROXY|HTTPS|SOCKS5?)\s+([^;]+)/i.exec(resolved);
          modelProxy = match ? `${match[1].startsWith('SOCKS') ? 'socks5' : 'http'}://${match[2]}` : 'system';
        } else modelProxy = state.config.proxy;
        const python = await prepareEnvironment(state.config.python, envDir, {
          signal,
          proxy: modelProxy,
          device: state.config.device,
          onStatus: status => {
            if (!disposed && !signal.aborted) {
              if (status.python) api.environments?.registerPython({ id: `semantic-search-${process.platform}-${process.arch}`, name: '语义搜索 Python', path: status.python, version: status.version, available: true });
              state.runtime = status; save(false);
            }
          }
        });
        runtime?.close(); runtime = null; engine = null;
        state.runtime = { status: 'ready', message: '运行环境已准备，下一步下载模型', python };
        return { python };
      }
      if (action === 'probe') {
        const result = await getRuntime().probe({ signal });
        state.runtime = { status: result.cached ? 'cached' : 'missing', message: result.cached ? '模型已缓存，可以开启检索' : '模型尚未下载，请点下载模型', ...result };
        return result;
      }
      if (action === 'prepare') {
        if (!workspace) throw new Error('请先选择工作区');
        if (state.config.proxy === 'system') {
          const session = require('electron').session?.defaultSession;
          const resolved = session ? await session.resolveProxy('https://huggingface.co') : '';
          const match = /(?:^|;\s*)(PROXY|HTTPS|SOCKS5?)\s+([^;]+)/i.exec(resolved);
          modelProxy = match ? `${match[1].startsWith('SOCKS') ? 'socks5' : 'http'}://${match[2]}` : 'system';
        } else modelProxy = state.config.proxy;
        runtime?.close(); runtime = null; engine = null;
        const result = await getRuntime().prepare({ signal });
        state.runtime = { ...state.runtime, status: 'ready', message: '本地模型已就绪' };
        return result;
      }
      if (action === 'clear') {
        await getEngine().clear({ signal });
        state.index = { status: 'idle', items: 0, indexedAt: null };
        state.panels = {};
        return { cleared: true };
      }
      assertEnabled();
      if (action === 'update') {
        delete state.index.error;
        state.index.status = 'indexing';
        const result = await getEngine().update({ signal, force: args.force === true });
        state.index = { ...result, status: 'ready', progress: null };
        nextUpdate = Date.now() + 60000;
        return result;
      }
      if (action === 'search' || action === 'recipes') {
        if (state.index.status === 'stale') throw new Error('索引范围或模型配置已改变，请先更新索引');
        const input = (await inputsOf([{ ...(args.input || {}), ...(args.query ? { text: args.query } : {}) }]))[0];
        if (action === 'recipes') {
          const limit = args.limit ?? 3, maxChars = args.maxChars ?? 3000;
          if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error('做法数量应为 1–8');
          if (!Number.isInteger(maxChars) || maxChars < 500 || maxChars > 8000) throw new Error('做法正文预算应为 500–8000 字符');
          const result = await getEngine().search({ query: args.query, input, kinds: ['documents', 'history'], limit, signal,
            filter: item => ['learned', 'work'].includes(item.source?.recipeType) || (args.includeHistory === true && item.kind === 'history') });
          let remaining = maxChars;
          const hits = [];
          for (const hit of result.hits) {
            if (!remaining) break;
            const text = hit.text.slice(0, remaining);
            remaining -= text.length;
            hits.push({ ...hit, text, recipeType: hit.source?.recipeType || 'history', truncated: text.length < hit.text.length });
          }
          return { ...result, hits, returnedChars: maxChars - remaining,
            guidance: '候选做法须核对适用条件、失败边界与验收结果；截断内容请按来源读取。无合适命中时使用限定目录的 search 或 history_search/history_read。' };
        }
        if (!Number.isInteger(args.limit ?? 10) || (args.limit ?? 10) < 1 || (args.limit ?? 10) > 50) throw new Error('结果数量应为 1–50');
        if (args.kinds && (!Array.isArray(args.kinds) || args.kinds.some(k => !SOURCES.includes(k)))) throw new Error('搜索范围无效');
        return getEngine().search({ query: args.query || '', input, kinds: args.kinds, limit: args.limit ?? 10, signal });
      }
      if (action === 'similarity') { assertEnabled('similarity'); return analytics.similarity(getRuntime(), await inputsOf(args.inputs), signal); }
      if (action === 'classify') { assertEnabled('classification'); return analytics.classify(getRuntime(), await inputsOf(args.inputs), args.labels, signal); }
      if (action === 'cluster') { assertEnabled('clustering'); return analytics.cluster(getRuntime(), await inputsOf(args.inputs), args.clusters ?? 3, signal); }
      throw new Error('未识别的语义搜索动作');
    }

    function run(action, args = {}, panelId = '', requestId = randomUUID(), parentSignal) {
      if (job) return Promise.reject(new Error('后台正在处理另一项操作，请等它完成或取消'));
      if (disposed) return Promise.reject(new Error('扩展已卸载'));
      const controller = new AbortController();
      const abort = () => controller.abort();
      parentSignal?.addEventListener('abort', abort, { once: true });
      if (parentSignal?.aborted) controller.abort();
      const current = { action, panelId, requestId, controller };
      job = current;
      const lastSearch = state.panels[panelId]?.lastSearch;
      if (panelId) state.panels[panelId] = { requestId, action, status: 'running', lastSearch };
      state.operation = { action, panelId, requestId };
      try { save(); } catch (error) { job = null; parentSignal?.removeEventListener('abort', abort); return Promise.reject(error); }
      const promise = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error('操作已取消');
        return perform(action, args, controller.signal);
      }).then(result => {
        if (controller.signal.aborted || disposed) throw new Error('操作已取消');
        if (panelId && state.panels[panelId]?.requestId === requestId) state.panels[panelId] = { requestId, action, status: 'done', result, lastSearch: action === 'search' ? result : lastSearch };
        state.reply = t('操作已完成');
        return result;
      }).catch(error => {
        const cancelled = controller.signal.aborted;
        if (panelId && state.panels[panelId]?.requestId === requestId) state.panels[panelId] = { requestId, action, status: cancelled ? 'cancelled' : 'error', error: error.message, lastSearch };
        if (action === 'update') state.index = { ...state.index, status: cancelled ? 'cancelled' : 'error', error: error.message, progress: null };
        if (['setup', 'install', 'prepare', 'probe'].includes(action)) state.runtime = { ...state.runtime, status: cancelled ? 'idle' : 'error', message: error.message };
        state.reply = cancelled ? t('操作已取消') : error.message;
        throw error;
      }).finally(() => {
        parentSignal?.removeEventListener('abort', abort);
        if (job === current) { job = null; state.operation = null; }
        if (!state.enabled) {
          runtime?.close(); runtime = null; engine = null;
          if (!['setup', 'install', 'prepare', 'probe'].includes(action)) state.runtime = { ...state.runtime, status: 'disabled', message: t('已关闭') };
        }
        save();
      });
      current.promise = promise;
      return promise;
    }

    function background(action, args = {}) {
      if (job) return t('后台正忙，请先完成或取消当前操作');
      if (!workspace) return t('请先选择工作区');
      run(action, args).catch(error => api.log('语义搜索：', error.message));
      return t('已开始处理，可在设置或搜索面板查看进度');
    }

    function openPanel() {
      const panel = api.panels().find(p => p.kind === 'semantic-search') || api.createPanel({ kind: 'semantic-search', title: t('语义搜索'), look: { showChat: false } });
      api.activatePanel(panel.id);
      return t('已打开语义搜索');
    }

    function configRows(values) {
      return values.map(([id, title, desc, value]) => ({ id, role: 'control', title: t(title), desc: t(desc), inline: 'text', value, actions: [{ id: 'configure', label: t('保存') }] }));
    }

    function choiceRow(id, title, desc, value, options) {
      return { id, role: 'control', title: t(title), desc: t(desc), inline: 'select', value, options: options.map(([value, label]) => ({ value, label: t(label) })), actions: [{ id: 'configure', label: t('保存') }] };
    }

    function formatIndexDesc(index) {
      if (index.error) {
        const err = String(index.error);
        if (/cuda/i.test(err)) return t('CUDA 暂不可用，请在「更多」一键配置对应依赖，或将运行设备选择为 CPU');
        return t(`⚠️ 索引未完成：${err}`);
      }
      if (index.status === 'indexing' || index.status === 'building') {
        const p = index.progress;
        if (p && typeof p.completed === 'number' && typeof p.total === 'number' && p.total > 0) {
          const pct = Math.round((p.completed / p.total) * 100);
          return t(`⏳ 正在构建向量索引：${p.completed} / ${p.total} 项 (${pct}%)`);
        }
        return t('⏳ 正在扫描并构建工作区语义索引…');
      }
      if (index.status === 'stale') return t('⚡ 检索范围或配置已改变，请点击「更新索引」');
      if (index.indexedAt) return `${index.items || 0} ${t('条内容')} · ${new Date(index.indexedAt).toLocaleString()}`;
      return t('⚪ 尚未建立索引，请点击「更新索引」开始');
    }

    function settingsView() {
      const toggle = (id, title, desc, value) => ({ id, title: t(title), desc: t(desc), inline: 'switch', value: value ? 'on' : 'off' });
      return {
        note: t('首次使用请在「更多 → EmbeddingGemma 2」点击「一键配置」，再开启语义搜索并更新索引。下拉选项即时保存；关闭总开关会停止任务并释放模型。'),
        reply: state.reply || '',
        rows: [
          { ...toggle('enabled', '启用语义搜索', '总开关；各项功能的选择会保留', state.enabled), role: 'control', actions: [{ id: 'open', label: t('打开搜索面板') }] },
          ...Object.entries(FEATURES).map(([id, labels]) => toggle(id, ...labels, state.features[id])),
          { id: 'index', role: 'control', title: t('工作区索引'), desc: formatIndexDesc(state.index), meta: state.index.status,
            actions: [{ id: 'update', label: t('更新索引') }, { id: 'rebuild', label: t('重建索引') }, { id: 'cancel', label: t('取消任务') }, { id: 'clear', label: t('清除索引') }, { id: 'refresh', label: t('刷新状态') }] },
          ...configRows([
            ['roots', '索引目录', '相对工作区路径，用分号分隔；填 . 表示整个工作区。建议限定在文档与源码目录', state.config.roots.join(';') || '.'],
          ]),
          choiceRow('dimensions', '向量维度', '修改后需要更新索引', String(state.config.dimensions), [['128', '128'], ['256', '256'], ['512', '512'], ['768', '768（默认）']]),
          choiceRow('device', '运行设备', '按所选设备运行；更换设备后可在「更多」一键配置对应依赖', state.config.device, [['auto', '自动选择'], ['cpu', 'CPU'], ['cuda', 'CUDA（NVIDIA 显卡）']]),
        ],
      };
    }

    function modelDownloadView() {
      const isBusy = Boolean(job);
      const ready = state.setup?.device === state.config.device && state.setup?.model === state.config.model;
      const desc = state.runtime.status === 'error' ? t('配置失败，请展开操作详情查看原因。') : isBusy ? state.runtime.message
        : ready ? t('已配置完成，可以在语义搜索中启用。') : t('自动准备 Python、所选设备的依赖和模型，并验证可用性；已有内容会复用。');
      const actions = isBusy ? [{ id: 'cancel', label: t('取消任务') }]
        : [{ id: 'setup', label: t('一键配置') }, { id: 'advanced', label: t(advanced ? '收起高级设置' : '高级设置') }];
      const rows = [
        { id: 'environment', role: 'control', title: t('模型与运行环境'), desc, meta: state.config.device === 'auto' ? t('自动选择设备') : state.config.device.toUpperCase(), actions },
        ...(advanced ? configRows([
          ['proxy', '下载代理', 'system 使用系统代理，direct 直连，或填写 HTTP 代理地址', state.config.proxy],
          ['python', 'Python 路径', '默认自动查找；没有可用 Python 时自动下载', state.config.python],
          ['model', '模型路径', '默认模型名称或已有本地模型目录', state.config.model],
        ]) : []),
      ];

      return {
        note: t('一键配置全部依赖。环境与模型由 ensoul 全局管理，所有工作区共用；解释器显示在上方 Python 管理中，不随源码或 Git 分发。'),
        reply: state.reply || '',
        rows,
      };
    }

    function onSettingsAction(actionId, rowId) {
      if (actionId === 'advanced') { advanced = !advanced; return ''; }
      if (actionId.startsWith('set:')) {
        const value = actionId === 'set:on';
        if (rowId !== 'enabled' && !Object.hasOwn(FEATURES, rowId)) throw new Error('未知功能开关');
        stop();
        if (rowId === 'enabled') state.enabled = value; else state.features[rowId] = value;
        for (const panelId of Object.keys(state.panels)) {
          const result = state.panels[panelId].result;
          const permitted = hit => state.enabled && state.features[hit.kind] && (!hit.source?.unscoped || state.features.historyArchives);
          if (result?.hits) result.hits = result.hits.filter(permitted);
          const previous = state.panels[panelId].lastSearch;
          if (previous?.hits) previous.hits = previous.hits.filter(permitted);
        }
        state.runtime = { status: state.enabled ? 'idle' : 'disabled', message: state.enabled ? t('按需加载本地模型') : t('已关闭') };
        nextUpdate = Date.now() + 1500;
        state.reply = t('开关已保存'); save();
        return state.reply;
      }
      if (actionId.startsWith('configure:')) {
        const value = actionId.slice('configure:'.length).trim();
        if (!Object.hasOwn(state.config, rowId)) throw new Error('未知配置');
        if (rowId === 'dimensions' && ![128, 256, 512, 768].includes(Number(value))) throw new Error('向量维度应为 128、256、512 或 768');
        if (rowId === 'device' && !['auto', 'cpu', 'cuda'].includes(value)) throw new Error('运行设备应为 auto、cpu 或 cuda');
        if (rowId === 'proxy' && !['system', 'direct'].includes(value) && !/^https?:\/\/[^\s]+$/.test(value)) throw new Error('代理应为 system、direct 或 HTTP 代理地址');
        if (['model', 'python'].includes(rowId) && !value) throw new Error('请填写有效路径');
        stop();
        state.config[rowId] = rowId === 'dimensions' ? Number(value) : rowId === 'roots' ? value.split(';').map(s => s.trim()).filter(Boolean) : value;
        modelProxy = state.config.proxy;
        const changesIndex = ['roots', 'dimensions', 'model'].includes(rowId);
        if (changesIndex) {
          state.index.status = 'stale'; nextUpdate = Date.now() + 1500;
          for (const panelId of Object.keys(state.panels)) { delete state.panels[panelId].result; delete state.panels[panelId].lastSearch; }
        }
        state.reply = t(changesIndex ? '配置已保存，请更新索引' : '配置已保存'); save(); return state.reply;
      }
      if (actionId === 'open') return openPanel();
      if (actionId === 'refresh') {
        return '';
      }
      if (actionId === 'cancel') { stop(); return t('已发送取消请求'); }
      if (actionId === 'rebuild') return background('update', { force: true });
      if (['setup', 'install', 'prepare', 'probe', 'update', 'clear'].includes(actionId)) return background(actionId);
      throw new Error('未知设置动作');
    }

    api.addSettingsSection({ id: 'semantic-search', label: t('语义搜索'), hint: t('检索范围与功能开关'), after: 'plugin:mcp:mcp-servers', group: 'extension', view: settingsView, onAction: onSettingsAction });
    api.addSettingsSection({ id: 'model-download', label: 'EmbeddingGemma 2', hint: t('下载本地语义模型与运行环境'), placement: 'more', view: modelDownloadView, onAction: onSettingsAction });

    const mediaSchema = { type: 'object', properties: { text: { type: 'string' }, image: { type: 'string' }, audio: { type: 'string' }, video: { type: 'string' } }, additionalProperties: false };
    const tool = (name, description, action, properties, required = []) => api.addTool({ name, description: t(description), level: action === 'update' ? 'write' : 'read', kits: ['dev', 'copy', 'art'], parameters: { type: 'object', properties, required } }, async (args, ctx) => {
      try {
        assertEnabled('agentSearch');
        const result = await run(action, args, ctx?.panelId || '', randomUUID(), ctx?.signal);
        return JSON.stringify({ ok: true, ...result });
      } catch (error) { return JSON.stringify({ ok: false, error: error.message }); }
    });
    tool('semantic_search', '按含义检索工作区文档、代码、会话和素材。结果是候选证据，请确认原文；已知符号先精确搜索。', 'search', { query: { type: 'string' }, input: mediaSchema, kinds: { type: 'array', items: { type: 'string', enum: SOURCES } }, limit: { type: 'integer', minimum: 1, maximum: 50 } });
    tool('recipe_search', '技能不能解决或重复失败时，按含义查找以前的做法。默认查角色卡 learned 与 work 文档；includeHistory 才加入已启用的历史会话。返回有来源的短片段，默认最多 3 条、正文合计 3000 字符；须验证原文，失败则用关键词检索。', 'recipes', {
      query: { type: 'string' }, includeHistory: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 8 }, maxChars: { type: 'integer', minimum: 500, maximum: 8000 }
    }, ['query']);
    api.addPrompt(() => state.enabled && state.features.agentSearch ? t('技能不能解决、同一步骤连续失败或需要以前案例时，先 use_skill({name:"find-recipe"}) 查找做法；本轮有 recipe_search 就按需检索，先角色经验和 work 文档，再按需加历史。正文已限制长度，不全量读会话；工具不可用时按该技能的关键词路径查找。') : '');
    tool('semantic_index_update', '增量更新已启用范围的本地语义索引，可取消。', 'update', { force: { type: 'boolean' } });
    tool('semantic_similarity', '比较多项文字或本地素材的相似度，分数不是概率。', 'similarity', { inputs: { type: 'array', items: mediaSchema, minItems: 1, maxItems: 100 } }, ['inputs']);
    tool('semantic_classify', '将内容匹配到提供的类别，返回各类别相似度。', 'classify', { inputs: { type: 'array', items: mediaSchema }, labels: { type: 'array', items: { type: 'string' } } }, ['inputs', 'labels']);
    tool('semantic_cluster', '将相近的文字与素材自动分组。', 'cluster', { inputs: { type: 'array', items: mediaSchema }, clusters: { type: 'integer', minimum: 2, maximum: 20 } }, ['inputs']);
    api.addCommand({ id: 'semantic', label: t('语义搜索'), hint: t('打开搜索面板，或 /semantic 描述要查找的内容') }, async (query, ctx) => query.trim() ? JSON.stringify(await run('search', { query }, ctx?.panelId || '', randomUUID(), ctx?.signal)) : openPanel());

    async function openSource(command) {
      assertEnabled();
      if (disposed || job) throw new Error(disposed ? '扩展已卸载' : '后台正忙，请等待当前操作完成');
      if (state.index.status === 'stale') throw new Error('索引范围已改变，请先更新索引并重新搜索');
      const slot = state.panels[command.panelId];
      const previous = slot?.lastSearch || slot?.result;
      const hit = previous?.hits?.find(item => item.id === command.hit?.id);
      if (!hit || !state.features[hit.kind] || (hit.source?.unscoped && !state.features.historyArchives)) throw new Error('搜索结果已过期，请重新搜索');
      if (hit.source?.panelId) {
        if (!api.panels().some(p => p.id === hit.source.panelId)) throw new Error('该会话已归档，当前结果中已保留原文');
        assertEnabled();
        if (disposed) throw new Error('扩展已卸载');
        api.activatePanel(hit.source.panelId);
      } else if (hit.source?.path) {
        const filename = await fs.promises.realpath(path.resolve(workspace, hit.source.path));
        const relative = path.relative(await fs.promises.realpath(workspace), filename);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('来源已移出当前工作区');
        assertEnabled();
        if (disposed || !state.features[hit.kind]) throw new Error('来源检索范围已关闭');
        const error = await require('electron').shell.openPath(filename);
        if (error) throw new Error(error);
      } else throw new Error('来源不可打开');
      return { opened: true };
    }

    async function consume() {
      if (disposed || reading || !workspace) return;
      reading = true;
      try {
        const names = await fs.promises.readdir(commands).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        for (const name of names.slice(0, 100)) {
          if (!name.endsWith('.json') || activeRequests.has(name)) continue;
          const file = path.join(commands, name);
          let cmd;
          try {
            if ((await fs.promises.stat(file)).size > 65536) throw new Error('命令过大');
            cmd = JSON.parse(await fs.promises.readFile(file, 'utf8'));
            if (typeof cmd.panelId !== 'string' || typeof cmd.requestId !== 'string' || !/^[\w.-]+$/.test(cmd.panelId) || !/^[\w.-]+$/.test(cmd.requestId)) throw new Error('命令编号无效');
            if (name !== `${cmd.panelId}-${cmd.requestId}.json`) throw new Error('命令文件与请求编号不一致');
            if (!api.panels().some(p => p.id === cmd.panelId && p.kind === 'semantic-search')) throw new Error('搜索面板已关闭');
          } catch (error) { api.log('语义搜索命令：', error.message); await fs.promises.unlink(file); continue; }
          activeRequests.add(name);
          await fs.promises.unlink(file);
          const receipt = receipts.get(`${cmd.panelId}:${cmd.requestId}`);
          if (receipt) {
            if (job?.panelId !== cmd.panelId) {
              const permitted = hit => state.enabled && state.features[hit.kind] && (!hit.source?.unscoped || state.features.historyArchives);
              const result = receipt.result?.hits ? { ...receipt.result, hits: receipt.result.hits.filter(permitted) } : receipt.result;
              const lastSearch = receipt.lastSearch?.hits ? { ...receipt.lastSearch, hits: receipt.lastSearch.hits.filter(permitted) } : receipt.lastSearch;
              state.panels[cmd.panelId] = state.index.status === 'stale' && (receipt.action === 'search' || lastSearch)
                ? { requestId: cmd.requestId, action: cmd.action, status: 'error', error: '索引范围已改变，请更新索引并重新搜索' }
                : { ...receipt, result, lastSearch };
              save();
            }
            activeRequests.delete(name); continue;
          }
          if (state.panels[cmd.panelId]?.requestId === cmd.requestId) { activeRequests.delete(name); continue; }
          if (cmd.action === 'cancel') {
            const target = job;
            if (target && (!cmd.targetRequestId || target.requestId === cmd.targetRequestId) && (!target.panelId || target.panelId === cmd.panelId)) {
              stop();
              target.promise.catch(() => {}).finally(() => {
                if (!disposed) {
                  const lastSearch = state.panels[cmd.panelId]?.lastSearch;
                  state.panels[cmd.panelId] = { requestId: cmd.requestId, action: 'cancel', status: 'done', result: { cancelled: true }, lastSearch }; save();
                }
              });
            } else {
              const lastSearch = state.panels[cmd.panelId]?.lastSearch;
              state.panels[cmd.panelId] = { requestId: cmd.requestId, action: 'cancel', status: 'done', result: { cancelled: false }, lastSearch }; save();
            }
            activeRequests.delete(name);
            continue;
          }
          const action = cmd.action === 'open_source' ? openSource(cmd).then(result => {
            const previous = state.panels[cmd.panelId]?.lastSearch || state.panels[cmd.panelId]?.result;
            state.panels[cmd.panelId] = { requestId: cmd.requestId, action: cmd.action, status: 'done', result: { ...previous, ...result }, lastSearch: previous }; save();
          }) : run(cmd.action, cmd, cmd.panelId, cmd.requestId);
          action.catch(error => {
            if (!disposed && (state.panels[cmd.panelId]?.requestId !== cmd.requestId || state.panels[cmd.panelId]?.status === 'running')) {
              const previous = state.panels[cmd.panelId]?.lastSearch;
              state.panels[cmd.panelId] = { requestId: cmd.requestId, action: cmd.action, status: 'error', error: error.message, lastSearch: previous }; save();
            }
          }).finally(() => activeRequests.delete(name));
        }
        if (state.enabled && state.features.autoIndex && state.setup?.model === state.config.model && !job && Date.now() >= nextUpdate) {
          nextUpdate = Date.now() + 60000;
          background('update');
        }
      } finally { reading = false; }
    }

    const timer = setInterval(() => consume().catch(error => api.log('语义搜索：', error.message)), 600);
    timer.unref?.();
    save();
    shutdown = () => { disposed = true; clearInterval(timer); stop(); };
  },

  dispose() { shutdown?.(); shutdown = null; },
};
