const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { scanCorpus, chunkText, hash, inside, checkAbort } = require('../plugins/semantic-search/corpus');
const { SemanticIndex } = require('../plugins/semantic-search/engine');

test('做法扫描只索引角色经验正文并标记 work 文档，删除经验移除映射', async t => {
  const workspace = await temporary(t);
  await put(workspace, '.gitignore', '.ensoul/\n');
  await put(workspace, 'work/recovery.md', '适用：下载中断。步骤：复用缓存继续下载。验收：依赖导入成功。');
  const card = { id: 'engineer', name: '工程师', secret: '不应索引的凭据', learned: [{ name: '断点恢复', how: '先更新安装工具，再安装依赖；导入成功才算完成。', at: 123 }] };
  await put(workspace, '.ensoul/state/agents/engineer.json', card);
  const args = { workspace, features: { documents: true } };
  const first = await scanCorpus(args);
  const learned = first.items.find(item => item.source.recipeType === 'learned');
  assert.match(learned.text, /更新安装工具/);
  assert.equal(learned.source.learnedName, '断点恢复');
  assert.ok(first.items.some(item => item.source.recipeType === 'work'));
  assert.ok(first.items.every(item => !JSON.stringify(item).includes('不应索引的凭据')));
  const sample = fixture(path.join(workspace, '.ensoul/index'), first.items);
  await sample.index.update();
  card.learned = [];
  await put(workspace, '.ensoul/state/agents/engineer.json', card);
  sample.setItems((await scanCorpus(args)).items);
  assert.equal((await sample.index.update()).removed, 1);
  assert.equal((await scanCorpus({ ...args, features: { documents: false } })).items.length, 0);
});

test('做法筛选在排名之前执行，不把相似的普通代码当做法', async t => {
  const sample = fixture(await temporary(t), [item('code', 'alpha', 'code'), item('work', 'beta', 'documents', { recipeType: 'work' })]);
  await sample.index.update();
  const result = await sample.index.search({ query: 'alpha', limit: 1, filter: entry => entry.source.recipeType === 'work' });
  assert.deepEqual(result.hits.map(hit => hit.id), ['work']);
});

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ensoul-semantic-test-'));
  t.after(async () => {
    assert.ok(inside(path.resolve(os.tmpdir()), path.resolve(directory)));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function put(directory, name, content) {
  const file = path.join(directory, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
}

function item(id, text, kind = 'documents', source = {}) {
  return { id, kind, text, input: { text }, source: { title: id, path: `${id}.md`, line: 1, ...source }, fingerprint: hash(text) };
}

function fixture(directory, initial) {
  let items = initial;
  let model = 'model-a:2';
  let fail = false;
  let features = { documents: true, code: true, history: true, images: true, audio: true, video: true, historyArchives: true };
  const calls = [];
  const runtime = {
    fingerprint: () => model,
    encode: async (inputs, { signal }) => {
      checkAbort(signal);
      calls.push(inputs);
      if (fail) return [];
      return inputs.map((input) => input.text?.includes('alpha') ? [1, 0] : [0, 1]);
    },
  };
  const scan = async ({ signal }) => { checkAbort(signal); return { items, skipped: 0, warnings: [] }; };
  const options = { directory, runtime, scan, getFeatures: () => features };
  return { index: new SemanticIndex(options), options, runtime, calls,
    setItems: (next) => { items = next; }, setModel: (next) => { model = next; },
    setFail: (next) => { fail = next; }, setFeatures: (next) => { features = { ...features, ...next }; } };
}

test('text chunks keep real lines, overlap, and every part of a long line', () => {
  const lines = Array.from({ length: 75 }, (_, index) => `line-${index + 1}: ${'x'.repeat(34)}`);
  const chunks = chunkText(lines.join('\r\n'), { maxChars: 600, overlapChars: 120, maxLines: 15 });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.equal(chunk.text, lines.slice(chunk.line - 1, chunk.endLine).join('\n'));
  assert.ok(chunks.some((chunk, index) => index > 0 && chunk.line <= chunks[index - 1].endLine));
  for (let line = 1; line <= lines.length; line++) assert.ok(chunks.some((chunk) => chunk.line <= line && chunk.endLine >= line));
  const long = '0123456789'.repeat(550);
  const longChunks = chunkText(long, { maxChars: 1000, overlapChars: 100 });
  assert.ok(longChunks.length > 5);
  assert.ok(longChunks.every((chunk) => chunk.line === 1 && chunk.endLine === 1 && chunk.text.length <= 1000));
  assert.equal(longChunks[0].text.slice(-100), longChunks[1].text.slice(0, 100));
});

test('scan honors gitignore, secrets, generated paths, selected roots, and cancellation', async (t) => {
  const directory = await temporary(t);
  const workspace = path.join(directory, 'workspace');
  await put(workspace, '.gitignore', 'ignored/\n*.skip\n');
  await put(workspace, 'docs/keep.md', 'Heading\n\nUseful alpha document');
  await put(workspace, 'src/index.ts', 'export const alpha = 1;');
  await put(workspace, 'ignored/no.md', 'must not appear');
  await put(workspace, 'node_modules/no.md', 'must not appear');
  await put(workspace, 'build/no.md', 'must not appear');
  await put(workspace, '.ensoul/state/secrets.json', 'must not appear');
  await put(workspace, '.env.local', 'TOKEN=private');
  await put(workspace, 'credentials.json', 'private');
  await put(workspace, 'portrait.png', 'image placeholder');
  const features = { documents: true, code: true, images: true };
  const scanned = await scanCorpus({ workspace, features });
  assert.deepEqual(scanned.items.map((entry) => entry.source.title).sort(), ['docs/keep.md', 'portrait.png', 'src/index.ts']);
  assert.equal(scanned.items.find((entry) => entry.kind === 'images').input.image, path.join(workspace, 'portrait.png'));
  const selected = await scanCorpus({ workspace, features, roots: ['docs'] });
  assert.deepEqual(selected.items.map((entry) => entry.source.title), ['docs/keep.md']);
  await assert.rejects(scanCorpus({ workspace, features, roots: ['../outside'] }), /不能离开工作区/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(scanCorpus({ workspace, features, signal: aborted.signal }), { name: 'AbortError' });
  const during = new AbortController();
  await assert.rejects(scanCorpus({ workspace, features, signal: during.signal, onProgress: () => during.abort() }), { name: 'AbortError' });
});

test('root links cannot escape the workspace', async (t) => {
  const directory = await temporary(t);
  const workspace = path.join(directory, 'workspace');
  const outside = path.join(directory, 'outside');
  await put(workspace, 'a.md', 'inside');
  await put(outside, 'secret.md', 'outside');
  try { await fs.symlink(outside, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) {
    if (error.code === 'EPERM') { t.skip('当前用户不能创建文件链接'); return; }
    throw error;
  }
  await assert.rejects(scanCorpus({ workspace, features: { documents: true }, roots: ['escape'] }), /链接指向了工作区外/);
  const scanned = await scanCorpus({ workspace, features: { documents: true } });
  assert.ok(scanned.items.every((entry) => entry.text !== 'outside'));
});

test('history loads split live bodies only in their workspace and archives require explicit opt-in', async (t) => {
  const directory = await temporary(t);
  const workspace = path.join(directory, 'workspace');
  const userData = path.join(directory, 'userData');
  await fs.mkdir(workspace);
  await put(userData, 'workspace.json', { workspace, panels: { live: { id: 'live', title: 'Current chat' } } });
  await put(userData, 'panels/live.json', { chat: [{ id: 'm1', role: 'user', content: 'alpha live', createdAt: 123 }] });
  await put(userData, 'closed/old.json', { id: 'old', chat: [{ id: 'm2', role: 'assistant', content: 'old archive' }] });
  await put(userData, 'closed/foreign.json', { id: 'foreign', workspace: path.join(directory, 'another'), chat: [{ id: 'm3', role: 'user', content: 'foreign archive' }] });
  let scanned = await scanCorpus({ workspace, userData, features: { history: true } });
  assert.deepEqual(scanned.items.map((entry) => entry.text), ['alpha live']);
  assert.equal(scanned.items[0].source.messageId, 'm1');
  assert.equal(scanned.items[0].source.line, undefined);
  assert.match(scanned.warnings.join('\n'), /无法确认工作区归属/);
  scanned = await scanCorpus({ workspace, userData, features: { history: true, historyArchives: true } });
  assert.equal(scanned.items.length, 2);
  assert.equal(scanned.items.find((entry) => entry.text === 'old archive').source.unscoped, true);
  await put(userData, 'workspace.json', { workspace: path.join(directory, 'another'), panels: { live: { id: 'live' } } });
  scanned = await scanCorpus({ workspace, userData, features: { history: true } });
  assert.equal(scanned.items.length, 0);
  assert.match(scanned.warnings.join('\n'), /其他工作区/);
  scanned = await scanCorpus({ workspace, userData, features: { history: false, historyArchives: true } });
  assert.equal(scanned.items.length, 0);
});

test('rich document extraction preserves pages without inventing source lines', async (t) => {
  const directory = await temporary(t);
  await put(directory, 'report.pdf', 'PDF placeholder');
  const scanned = await scanCorpus({ workspace: directory, features: { documents: true }, extract: async () => ({ pages: [{ page: 2, text: 'alpha report page' }] }) });
  assert.equal(scanned.items[0].source.page, 2);
  assert.equal(scanned.items[0].source.line, undefined);
  assert.equal(scanned.items[0].input.text, 'title: report.pdf | text: alpha report page');
});

test('unreadable rich documents are reported while remaining documents are indexed', async (t) => {
  const directory = await temporary(t);
  await put(directory, 'broken.pdf', 'PDF placeholder');
  await put(directory, 'legacy.doc', 'old document');
  await put(directory, 'readme.md', 'alpha text');
  const scanned = await scanCorpus({ workspace: directory, features: { documents: true }, extract: async () => { throw new Error('文档已加密'); } });
  assert.equal(scanned.items.length, 1);
  assert.equal(scanned.items[0].source.title, 'readme.md');
  assert.equal(scanned.skipped, 2);
  assert.match(scanned.warnings.join('\n'), /文档已加密/);
  assert.match(scanned.warnings.join('\n'), /需要正文提取器/);
});

test('index persists vectors and incrementally adds, changes, removes, and invalidates model cache', async (t) => {
  const directory = await temporary(t);
  const sample = fixture(directory, [item('a', 'alpha'), item('b', 'beta')]);
  let summary = await sample.index.update();
  assert.equal(summary.embedded, 2);
  assert.equal(summary.dimensions, 2);
  summary = await sample.index.update();
  assert.equal(summary.embedded, 0);
  assert.equal(summary.reused, 2);
  sample.setItems([item('a', 'alpha changed'), item('c', 'beta new')]);
  summary = await sample.index.update();
  assert.equal(summary.embedded, 2);
  assert.equal(summary.removed, 1);
  const restored = new SemanticIndex(sample.options);
  assert.equal((await restored.search({ query: 'alpha' })).hits[0].id, 'a');
  assert.equal((await restored.stats()).items, 2);
  assert.equal((await fs.readdir(directory)).filter((file) => file.endsWith('.bin')).length, 1);
  sample.setModel('model-b:2');
  await assert.rejects(restored.search({ query: 'alpha' }), /更新索引/);
  summary = await sample.index.update();
  assert.equal(summary.reused, 0);
  assert.equal(summary.embedded, 2);
  await sample.index.clear();
  assert.equal((await sample.index.stats()).items, 0);
});

test('feature switches immediately filter cached content including unscoped archives', async (t) => {
  const directory = await temporary(t);
  const sample = fixture(directory, [item('d', 'alpha'), item('c', 'alpha code', 'code'), item('h', 'alpha old', 'history', { unscoped: true })]);
  await sample.index.update();
  assert.equal((await sample.index.search({ query: 'alpha' })).hits.length, 3);
  sample.setFeatures({ code: false, historyArchives: false });
  assert.deepEqual((await sample.index.search({ query: 'alpha' })).hits.map((hit) => hit.id), ['d']);
  assert.equal((await sample.index.stats()).activeItems, 1);
  assert.equal((await sample.index.search({ query: 'alpha', kinds: ['code'] })).hits.length, 0);
});

test('query encoding receives retrieval intent, code scope, and multimodal inputs', async (t) => {
  const directory = await temporary(t);
  const sample = fixture(directory, [item('c', 'alpha code', 'code')]);
  await sample.index.update();
  let captured;
  sample.runtime.encode = async (inputs, options) => { captured = { inputs, options }; return [[1, 0]]; };
  await sample.index.search({ query: 'alpha', kinds: ['code'], input: { image: 'local.png' } });
  assert.equal(captured.options.query, true);
  assert.equal(captured.options.code, true);
  assert.deepEqual(captured.inputs, [{ image: 'local.png', text: 'alpha' }]);
});

test('encoding errors identify source files and preserve the committed index', async (t) => {
  const directory = await temporary(t);
  const sample = fixture(directory, [item('a', 'alpha')]);
  await sample.index.update();
  const before = await fs.readFile(path.join(directory, 'current.json'), 'utf8');
  sample.setItems([item('broken-image', 'beta', 'images', { title: 'demo.gif' })]);
  sample.runtime.encode = async () => { throw new Error('图片读取失败'); };
  await assert.rejects(sample.index.update(), /demo\.gif.*图片读取失败/);
  assert.equal(await fs.readFile(path.join(directory, 'current.json'), 'utf8'), before);
});

test('incomplete encoding and cancelled updates preserve the previous committed index', async (t) => {
  const directory = await temporary(t);
  const sample = fixture(directory, [item('a', 'alpha')]);
  await sample.index.update();
  const before = await fs.readFile(path.join(directory, 'current.json'), 'utf8');
  sample.setItems([item('b', 'beta')]);
  sample.setFail(true);
  await assert.rejects(sample.index.update(), /数量不完整/);
  assert.equal(await fs.readFile(path.join(directory, 'current.json'), 'utf8'), before);
  assert.equal((await sample.index.stats()).items, 1);
  sample.setFail(false);
  const controller = new AbortController();
  sample.runtime.encode = async () => { controller.abort(); return [[0, 1]]; };
  await assert.rejects(sample.index.update({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(await fs.readFile(path.join(directory, 'current.json'), 'utf8'), before);
  assert.equal((await sample.index.stats()).busy, false);
});

test('simultaneous index instances cannot write the same cache', async (t) => {
  const directory = await temporary(t);
  const sample = fixture(directory, [item('a', 'alpha')]);
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let resume;
  const held = new Promise((resolve) => { resume = resolve; });
  sample.runtime.encode = async () => { entered(); await held; return [[1, 0]]; };
  const update = sample.index.update();
  await started;
  const second = new SemanticIndex(sample.options);
  await assert.rejects(second.update(), { code: 'INDEX_BUSY' });
  resume();
  await update;
  assert.equal((await sample.index.stats()).busy, false);
});

test('a dimension change with a matching runtime fingerprint never commits incompatible vectors', async (t) => {
  const directory = await temporary(t);
  const sample = fixture(directory, [item('a', 'alpha')]);
  await sample.index.update();
  sample.setItems([item('a', 'alpha'), item('b', 'beta')]);
  sample.runtime.encode = async (inputs) => inputs.map(() => [0, 1, 0]);
  await assert.rejects(sample.index.update(), /维度已变化/);
  assert.equal((await sample.index.stats()).items, 1);
  sample.setModel('model-a:3');
  const summary = await sample.index.update();
  assert.equal(summary.dimensions, 3);
  assert.equal(summary.reused, 0);
});

test('corrupt cache is reported until explicit rebuild or clear replaces it', async (t) => {
  const directory = await temporary(t);
  const sample = fixture(directory, [item('a', 'alpha')]);
  await sample.index.update();
  const pointer = JSON.parse(await fs.readFile(path.join(directory, 'current.json'), 'utf8'));
  await fs.writeFile(path.join(directory, pointer.vectors), Buffer.from([1]));
  const restored = new SemanticIndex(sample.options);
  await assert.rejects(restored.search({ query: 'alpha' }), /不完整/);
  await assert.rejects(restored.update(), /不完整/);
  const summary = await restored.update({ force: true });
  assert.equal(summary.embedded, 1);
  assert.match(summary.warnings.join('\n'), /强制重建恢复/);
  assert.equal((await fs.readdir(directory)).filter((name) => name.endsWith('.bin')).length, 1);
  await fs.writeFile(path.join(directory, 'current.json'), '{broken');
  await restored.clear();
  assert.equal((await restored.stats()).items, 0);
  assert.equal((await fs.readdir(directory)).filter((name) => name.endsWith('.bin')).length, 1);
});
