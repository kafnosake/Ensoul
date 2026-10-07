const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { performance } = require('node:perf_hooks');
const { ModelRuntime } = require('../plugins/semantic-search/runtime');
const { scanCorpus, inside } = require('../plugins/semantic-search/corpus');
const { SemanticIndex } = require('../plugins/semantic-search/engine');
const { extractDocument } = require('../plugins/semantic-search/extract');
const analytics = require('../plugins/semantic-search/analytics');

const runFile = promisify(execFile);
const repository = path.resolve(__dirname, '..');
const environment = path.join(repository, '.ensoul', 'runtime', 'semantic-search');
const python = process.env.ENSOUL_SEMANTIC_PYTHON || path.join(environment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const cache = process.env.ENSOUL_SEMANTIC_CACHE || path.join(environment, 'models');
const assets = process.env.ENSOUL_SEMANTIC_ASSETS || path.join(environment, 'smoke-assets');
const media = { images: ['red-square.png', 'image'], audio: ['tone.wav', 'audio'], video: ['red-square.mp4', 'video'] };

async function available(file) {
  try { await fs.access(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function put(directory, name, content) {
  const file = path.join(directory, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
}

async function makeDocx(directory, signal) {
  const program = [
    'import sys, zipfile',
    'from pathlib import Path',
    'from xml.sax.saxutils import escape',
    "text = '锂电池储存指南：电池应放在阴凉干燥处，避免长时间满电储存，并定期检查电量。'",
    'root = Path(sys.argv[1])',
    'with zipfile.ZipFile(root / "battery.docx", "w", zipfile.ZIP_DEFLATED) as z:',
    '    z.writestr("[Content_Types].xml", \'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>\')',
    '    z.writestr("_rels/.rels", \'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>\')',
    '    z.writestr("word/document.xml", \'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>\' + escape(text) + \'</w:t></w:r></w:p><w:sectPr/></w:body></w:document>\')',
  ].join('\n');
  await runFile(python, ['-c', program, directory], { windowsHide: true, signal, encoding: 'utf8' });
}

async function closeWorker(runtime) {
  const child = runtime.child;
  let exit;
  if (child && child.exitCode === null) {
    exit = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('真实模型 worker 在关闭后未退出')), 10000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }
  runtime.close();
  if (exit) await exit;
  assert.equal(runtime.child, null);
  assert.equal(runtime.pending.size, 0);
}

test('real local model integrates corpus, persistence, multimodal queries, and analytics', { timeout: 600000 }, async (t) => {
  if (!(await available(python))) {
    t.skip('未准备本地语义模型 Python 环境；未执行真实模型验证。');
    return;
  }
  for (const [filename] of Object.values(media)) {
    if (!(await available(path.join(assets, filename)))) {
      t.skip(`缺少真实媒体测试素材 ${filename}；未执行多模态集成验证。`);
      return;
    }
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ensoul-semantic-integration-'));
  const workspace = path.join(temporary, 'workspace');
  const userData = path.join(temporary, 'userData');
  const directory = path.join(temporary, 'index');
  const runtime = new ModelRuntime({ python, cacheDir: cache, model: 'google/embeddinggemma-2', dimensions: 768,
    device: 'auto', vision: true, audio: true, proxy: 'direct' });
  runtime.logPath = path.join(temporary, 'worker.log');
  t.after(async () => {
    try { await closeWorker(runtime); } finally {
      assert.ok(inside(path.resolve(os.tmpdir()), path.resolve(temporary)));
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });
  let probe;
  try { probe = await runtime.probe({ signal: t.signal }); } catch (error) {
    if (error.code === 'DEPENDENCIES_MISSING') {
      t.skip(`本地模型依赖未准备：${error.message}；未执行真实模型验证。`);
      return;
    }
    throw error;
  }
  if (!probe.cached) {
    t.skip('本地权重缓存不完整；此测试不会下载模型，未执行真实编码。');
    return;
  }
  for (const capability of ['text', 'code', 'images', 'audio', 'video']) assert.equal(probe.capabilities[capability], true, `${capability} 编码依赖未准备`);
  await put(workspace, '.gitignore', 'ignored/\n');
  await put(workspace, 'traffic.md', '# 城市公共交通规划\n\n公交换乘优化方案：同步线路发车时间，增设换乘站台，减少乘客等待时间。\n');
  await put(workspace, 'garden.md', '# 阳台植物养护\n\n花草需要适当浇水和充足阳光，定期检查土壤湿度。\n');
  await put(workspace, 'ignored/private.md', '此文件必须被忽略。');
  await put(workspace, 'duration.js', 'export function formatDuration(seconds) {\n  return Math.floor(seconds / 60) + " minutes";\n}\n');
  await makeDocx(workspace, t.signal);
  for (const [filename] of Object.values(media)) await fs.copyFile(path.join(assets, filename), path.join(workspace, filename));
  await put(userData, 'workspace.json', { workspace, panels: { current: { id: 'current', title: '面板取消机制' } } });
  await put(userData, 'panels/current.json', { chat: [{ id: 'message-1', role: 'assistant', content: '面板取消链使用 AbortSignal，把取消请求传递给所有正在执行的工具。', createdAt: 12345 }] });
  await put(userData, 'closed/unassigned.json', { id: 'unassigned', chat: [{ id: 'old', role: 'user', content: '没有工作区归属的旧会话不应进入索引。' }] });
  const features = { documents: true, code: true, history: true, images: true, audio: true, video: true, historyArchives: false };
  const scan = ({ signal, onProgress } = {}) => scanCorpus({ workspace, userData, features, signal, onProgress,
    extract: (file, options) => extractDocument(python, file, options) });
  const index = new SemanticIndex({ directory, runtime, scan, getFeatures: () => features });
  const facts = { model: probe.model, device: probe.device, dimensions: probe.dimensions, downloads: false };
  const start = performance.now();

  await t.test('all six enabled source kinds enter a real 768-dimensional index', async () => {
    const summary = await index.update({ signal: t.signal });
    assert.equal(summary.items, 8);
    assert.equal(summary.embedded, 8);
    assert.equal(summary.dimensions, 768);
    const stats = await index.stats();
    assert.deepEqual(stats.counts, { documents: 3, code: 1, history: 1, images: 1, audio: 1, video: 1 });
    assert.match(summary.warnings.join('\n'), /无法确认工作区归属/);
    facts.initialIndex = { items: summary.items, dimensions: summary.dimensions, counts: stats.counts };
  });

  await t.test('Chinese text, document extraction, code intent, and split conversation sources are retrievable', async () => {
    const result = await index.search({ query: '减少城市公交换乘等待时间的方法', kinds: ['documents'], signal: t.signal });
    assert.equal(path.basename(result.hits[0].source.path), 'traffic.md');
    assert.match(result.hits[0].text, /公交换乘优化方案/);
    assert.equal(result.hits[0].source.line, 1);
    assert.ok(Number.isFinite(result.hits[0].score));
    facts.chineseHit = { file: path.basename(result.hits[0].source.path), score: result.hits[0].score, line: result.hits[0].source.line };
    const documents = await index.search({ query: '锂电池怎样安全存放', kinds: ['documents'], signal: t.signal });
    const document = documents.hits.find(hit => path.basename(hit.source.path) === 'battery.docx');
    assert.ok(document);
    assert.match(document.text, /阴凉干燥/);
    assert.equal(document.source.line, undefined);
    const code = await index.search({ query: 'formatDuration', kinds: ['code'], signal: t.signal });
    assert.equal(path.basename(code.hits[0].source.path), 'duration.js');
    assert.equal(code.hits[0].source.line, 1);
    assert.equal(code.hits[0].source.endLine, 3);
    const history = await index.search({ query: '面板工具如何传递取消请求', kinds: ['history'], signal: t.signal });
    assert.equal(history.hits.length, 1);
    assert.equal(history.hits[0].source.panelId, 'current');
    assert.equal(history.hits[0].source.messageId, 'message-1');
    assert.equal(history.hits[0].source.at, 12345);
  });

  await t.test('animated GIF and mixed image/text batches return finite vectors', async () => {
    const gif = path.join(temporary, 'animated.gif');
    await runFile(python, ['-c', 'from PIL import Image; import sys; a=Image.new("RGB",(48,48),"red"); b=Image.new("RGB",(48,48),"blue"); a.save(sys.argv[1],save_all=True,append_images=[b],duration=100,loop=0)', gif], { windowsHide: true, signal: t.signal });
    const vectors = await runtime.encode([{ image: gif }, { text: '红色方形', image: path.join(workspace, 'red-square.png') }], { signal: t.signal });
    assert.equal(vectors.length, 2);
    for (const vector of vectors) { assert.equal(vector.length, 768); assert.ok(vector.every(Number.isFinite)); }
  });

  await t.test('image, audio, video, and combined text/media query paths return valid sources', async () => {
    const completed = [];
    for (const [kind, [filename, field]] of Object.entries(media)) {
      const result = await index.search({ input: { [field]: path.join(workspace, filename) }, kinds: [kind], signal: t.signal });
      assert.equal(result.hits.length, 1);
      assert.equal(result.hits[0].kind, kind);
      assert.equal(path.basename(result.hits[0].source.path), filename);
      assert.ok(Number.isFinite(result.hits[0].semanticScore));
      completed.push(kind);
    }
    const mixed = await index.search({ query: '红色方形与短音调', input: {
      image: path.join(workspace, 'red-square.png'), audio: path.join(workspace, 'tone.wav'), video: path.join(workspace, 'red-square.mp4'),
    }, kinds: ['images', 'audio', 'video'], signal: t.signal });
    assert.equal(mixed.hits.length, 3);
    assert.ok(mixed.hits.every(hit => Number.isFinite(hit.score) && inside(workspace, hit.source.path)));
    facts.mediaCompatibility = { requests: completed, combinedModalities: ['text', 'image', 'audio', 'video'], hits: mixed.hits.length, quality: '只验证请求兼容、有限分数和来源；未断言媒体语义排名质量' };
    features.images = false;
    const disabled = await index.search({ query: '红色方形', kinds: ['images'], signal: t.signal });
    assert.deepEqual(disabled.hits, []);
    features.images = true;
  });

  await t.test('changing and deleting a document reuses unchanged real vectors', async () => {
    await put(workspace, 'traffic.md', '# 地铁接驳站设计\n\n新增轮椅无障碍坡道、清晰导向标志和地铁接驳步行通道。\n');
    await fs.unlink(path.join(workspace, 'garden.md'));
    const summary = await index.update({ signal: t.signal });
    assert.equal(summary.items, 7);
    assert.equal(summary.embedded, 1);
    assert.equal(summary.reused, 6);
    assert.equal(summary.removed, 1);
    const restored = new SemanticIndex({ directory, runtime, scan, getFeatures: () => features });
    const hits = (await restored.search({ query: '轮椅无障碍坡道', kinds: ['documents'], signal: t.signal })).hits;
    assert.equal(path.basename(hits[0].source.path), 'traffic.md');
    assert.match(hits[0].text, /轮椅无障碍坡道/);
    assert.ok(hits.every(hit => path.basename(hit.source.path) !== 'garden.md'));
    facts.incremental = { items: summary.items, embedded: summary.embedded, reused: summary.reused, removed: summary.removed, persistedReload: true };
  });

  await t.test('similarity uses actual embeddings and produces a finite symmetric matrix', async () => {
    const result = await analytics.similarity(runtime, [
      { text: '城市公共交通出行服务' }, { text: '城市公共交通出行服务' }, { image: path.join(workspace, 'red-square.png') },
    ], t.signal);
    assert.equal(result.matrix.length, 3);
    for (let row = 0; row < 3; row++) {
      assert.equal(result.matrix[row].length, 3);
      assert.ok(Math.abs(result.matrix[row][row] - 1) < 1e-5);
      for (let column = 0; column < 3; column++) {
        assert.ok(Number.isFinite(result.matrix[row][column]));
        assert.ok(Math.abs(result.matrix[row][column] - result.matrix[column][row]) < 1e-5);
      }
    }
    assert.ok(result.matrix[0][1] > 0.99);
    facts.similarity = { shape: [3, 3], duplicateTextScore: result.matrix[0][1] };
  });

  await t.test('classification matches real encodings to provided labels with finite scores', async () => {
    const labels = ['公共交通', '园艺养护'];
    const result = await analytics.classify(runtime, [{ text: '公交车和地铁让市民便捷出行。' }, { text: '阳台花草需要浇水和充足的阳光。' }], labels, t.signal);
    assert.equal(result.results.length, 2);
    for (const entry of result.results) {
      assert.ok(labels.includes(entry.label));
      assert.equal(entry.scores.length, 2);
      assert.ok(entry.scores.every(score => Number.isFinite(score.score)));
      assert.ok(entry.scores[0].score >= entry.scores[1].score);
    }
    facts.classification = { returnedLabels: result.results.map(entry => entry.label), scoreMeaning: result.scoreMeaning };
  });

  await t.test('clustering partitions every input using real vectors', async () => {
    const result = await analytics.cluster(runtime, [
      { text: '城市公共交通线路规划和公交车站。' }, { text: '公交与地铁的换乘站台服务。' },
      { text: '阳台花草的浇水和日照养护。' }, { text: '盆栽植物需要松软土壤和适当湿度。' },
    ], 2, t.signal);
    assert.equal(result.groups.length, 2);
    const indices = result.groups.flatMap(group => group.indices);
    assert.deepEqual([...indices].sort((a, b) => a - b), [0, 1, 2, 3]);
    facts.clustering = { groups: result.groups.map(group => group.indices) };
  });

  facts.elapsedMs = Math.round(performance.now() - start);
  t.diagnostic(JSON.stringify(facts));
});
