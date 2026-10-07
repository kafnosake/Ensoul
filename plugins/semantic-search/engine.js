const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { checkAbort } = require('./corpus');

const writers = new Set();
const KINDS = ['documents', 'code', 'history', 'images', 'audio', 'video'];
const SCHEMA_VERSION = 1;

function emptySnapshot() {
  return { items: [], vectors: [], indexedAt: null, dimensions: 0, fingerprint: '', warnings: [], skipped: 0 };
}

function busyError() {
  const error = new Error('索引正在更新，请等待当前操作完成。');
  error.code = 'INDEX_BUSY';
  return error;
}

function validVector(vector, dimensions) {
  return (Array.isArray(vector) || ArrayBuffer.isView(vector)) && vector.length > 0
    && (!dimensions || vector.length === dimensions) && Array.from(vector).every((value) => typeof value === 'number' && Number.isFinite(Math.fround(value)))
    && Array.from(vector).some((value) => value !== 0);
}

function isEnabled(item, features) {
  return features[item.kind] && (!item.source?.unscoped || features.historyArchives);
}

function cosine(left, right) {
  if (left.length !== right.length) return 0;
  let dot = 0;
  let a = 0;
  let b = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    a += left[index] * left[index];
    b += right[index] * right[index];
  }
  return a && b ? dot / Math.sqrt(a * b) : 0;
}

function exactScore(query, item) {
  const normalized = String(query || '').toLowerCase().trim();
  if (!normalized) return 0;
  const text = `${item.source?.title || ''}\n${item.text || ''}`.toLowerCase();
  if (text.includes(normalized)) return 1;
  const words = [...new Set(normalized.split(/[\s,，。:：;；!?！？]+/).filter((word) => word.length >= 2))];
  return words.length ? words.filter((word) => text.includes(word)).length / words.length * 0.5 : 0;
}

async function fingerprintOf(runtime) {
  const value = typeof runtime.fingerprint === 'function' ? await runtime.fingerprint()
    : { model: runtime.model || '', dimensions: runtime.dimensions || 0 };
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function encodedVectors(result) {
  const vectors = Array.isArray(result) ? result : result?.vectors;
  if (!Array.isArray(vectors)) throw new Error('嵌入服务没有返回向量数组。');
  return vectors;
}

async function acquireLock(directory) {
  const file = path.join(directory, '.write-lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.close();
      return async () => { await fs.unlink(file); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw busyError(); }
      if (!Number.isInteger(owner.pid)) throw busyError();
      try { process.kill(owner.pid, 0); throw busyError(); } catch (probe) {
        if (probe.code !== 'ESRCH') throw busyError();
      }
      await fs.unlink(file);
    }
  }
  throw busyError();
}

class SemanticIndex {
  constructor({ directory, runtime, scan, getFeatures, onStatus }) {
    this.directory = path.resolve(directory);
    this.runtime = runtime;
    this.scan = scan;
    this.getFeatures = getFeatures || (() => Object.fromEntries(KINDS.map((kind) => [kind, true])));
    this.onStatus = onStatus || (() => {});
    this.snapshot = null;
    this.loading = null;
    this.busy = false;
  }

  async _read() {
    let pointer;
    try { pointer = JSON.parse(await fs.readFile(path.join(this.directory, 'current.json'), 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return emptySnapshot();
      throw new Error(`索引入口损坏：${error.message}`);
    }
    if (!/^meta-[\w-]+\.json$/.test(pointer.metadata) || !/^vectors-[\w-]+\.bin$/.test(pointer.vectors)) throw new Error('索引入口格式无效。');
    const metadata = JSON.parse(await fs.readFile(path.join(this.directory, pointer.metadata), 'utf8'));
    const bytes = await fs.readFile(path.join(this.directory, pointer.vectors));
    if (metadata.schemaVersion !== SCHEMA_VERSION || !Array.isArray(metadata.items)
      || !Number.isInteger(metadata.dimensions) || metadata.dimensions < 0
      || (metadata.items.length && !metadata.dimensions)
      || bytes.length !== metadata.items.length * metadata.dimensions * 4) throw new Error('索引元数据与向量不完整，请重建索引。');
    const vectors = metadata.items.map((item, ordinal) => {
      const vector = [];
      for (let dimension = 0; dimension < metadata.dimensions; dimension++) vector.push(bytes.readFloatLE((ordinal * metadata.dimensions + dimension) * 4));
      if (!item || typeof item.id !== 'string' || !KINDS.includes(item.kind) || !validVector(vector, metadata.dimensions)) throw new Error('索引数据格式无效，请重建索引。');
      return vector;
    });
    return { ...metadata, vectors, pointer };
  }

  async _load() {
    if (this.snapshot) return this.snapshot;
    if (!this.loading) this.loading = this._read().then((snapshot) => {
      this.snapshot = snapshot;
      return snapshot;
    }).finally(() => { this.loading = null; });
    return this.loading;
  }

  async _write(snapshot, signal) {
    const id = crypto.randomUUID();
    const pointer = { metadata: `meta-${id}.json`, vectors: `vectors-${id}.bin` };
    const metadataFile = path.join(this.directory, pointer.metadata);
    const vectorFile = path.join(this.directory, pointer.vectors);
    const pointerTemp = path.join(this.directory, `current-${id}.tmp`);
    const bytes = Buffer.alloc(snapshot.items.length * snapshot.dimensions * 4);
    for (let ordinal = 0; ordinal < snapshot.vectors.length; ordinal++) {
      for (let dimension = 0; dimension < snapshot.dimensions; dimension++) bytes.writeFloatLE(snapshot.vectors[ordinal][dimension], (ordinal * snapshot.dimensions + dimension) * 4);
    }
    const { vectors, pointer: ignored, ...metadata } = snapshot;
    let committed = false;
    try {
      checkAbort(signal);
      await fs.writeFile(metadataFile, JSON.stringify({ ...metadata, schemaVersion: SCHEMA_VERSION }), { flag: 'wx', signal });
      await fs.writeFile(vectorFile, bytes, { flag: 'wx', signal });
      await fs.writeFile(pointerTemp, JSON.stringify(pointer), { flag: 'wx', signal });
      checkAbort(signal);
      await fs.rename(pointerTemp, path.join(this.directory, 'current.json'));
      committed = true;
      const previous = this.snapshot?.pointer;
      this.snapshot = { ...snapshot, pointer };
      if (previous) {
        const cleanup = await Promise.allSettled([fs.unlink(path.join(this.directory, previous.metadata)), fs.unlink(path.join(this.directory, previous.vectors))]);
        const failed = cleanup.filter((result) => result.status === 'rejected' && result.reason.code !== 'ENOENT');
        if (failed.length) this.onStatus({ phase: 'cleanup-warning', message: '旧索引缓存暂时无法清理。' });
      }
    } finally {
      if (!committed) await Promise.allSettled([fs.unlink(metadataFile), fs.unlink(vectorFile), fs.unlink(pointerTemp)]);
    }
  }

  async _removeUnusedSnapshots() {
    const pointer = this.snapshot?.pointer;
    if (!pointer) return;
    const names = await fs.readdir(this.directory);
    const removals = names.filter((name) => /^(?:meta-[\w-]+\.json|vectors-[\w-]+\.bin|current-[\w-]+\.tmp)$/.test(name)
      && name !== pointer.metadata && name !== pointer.vectors);
    const results = await Promise.allSettled(removals.map((name) => fs.unlink(path.join(this.directory, name))));
    if (results.some((result) => result.status === 'rejected' && result.reason.code !== 'ENOENT')) this.onStatus({ phase: 'cleanup-warning', message: '部分旧索引缓存暂时无法清理。' });
  }

  async _exclusive(operation, signal) {
    checkAbort(signal);
    if (this.busy || writers.has(this.directory)) throw busyError();
    this.busy = true;
    writers.add(this.directory);
    let release;
    try {
      await fs.mkdir(this.directory, { recursive: true });
      release = await acquireLock(this.directory);
      checkAbort(signal);
      return await operation();
    } finally {
      try { if (release) await release(); } finally {
        writers.delete(this.directory);
        this.busy = false;
      }
    }
  }

  async update({ signal, force = false } = {}) {
    return this._exclusive(async () => {
      this.onStatus({ phase: 'scanning' });
      const fingerprint = await fingerprintOf(this.runtime);
      let previous;
      let recoveryWarning;
      try { previous = await this._read(); } catch (error) {
        if (!force) throw error;
        previous = emptySnapshot();
        recoveryWarning = `已通过强制重建恢复不可读索引：${error.message}`;
      }
      this.snapshot = previous;
      const scanned = await this.scan({ signal, onProgress: this.onStatus });
      checkAbort(signal);
      if (!scanned || !Array.isArray(scanned.items) || !Array.isArray(scanned.warnings)) throw new Error('语料扫描没有完成。');
      const features = await this.getFeatures();
      const items = scanned.items.filter((item) => item && KINDS.includes(item.kind) && isEnabled(item, features));
      const ids = new Set();
      for (const item of items) {
        if (!item || typeof item.id !== 'string' || !item.fingerprint || !item.input || ids.has(item.id)) throw new Error('语料条目缺少唯一标识或内容指纹。');
        ids.add(item.id);
      }
      const compatible = !force && previous.fingerprint === fingerprint;
      const old = new Map(previous.items.map((item, ordinal) => [item.id, { item, vector: previous.vectors[ordinal] }]));
      const vectors = new Array(items.length);
      const changed = [];
      let reused = 0;
      for (let ordinal = 0; ordinal < items.length; ordinal++) {
        const record = old.get(items[ordinal].id);
        if (compatible && record?.item.fingerprint === items[ordinal].fingerprint) { vectors[ordinal] = record.vector; reused++; }
        else changed.push(ordinal);
      }
      let dimensions = compatible ? previous.dimensions : 0;
      for (let offset = 0; offset < changed.length; offset += 16) {
        checkAbort(signal);
        const batch = changed.slice(offset, offset + 16);
        this.onStatus({ phase: 'embedding', completed: offset, total: changed.length, reused });
        let output;
        try {
          output = encodedVectors(await this.runtime.encode(batch.map((ordinal) => items[ordinal].input), { signal }));
        } catch (error) {
          checkAbort(signal);
          if (error.name === 'AbortError') throw error;
          const sources = [...new Set(batch.map(ordinal => items[ordinal].source?.title || items[ordinal].source?.path || items[ordinal].id))];
          throw new Error(`嵌入失败（${sources.join('、')}）：${error.message}`);
        }
        checkAbort(signal);
        if (output.length !== batch.length) throw new Error('嵌入服务返回的条目数量不完整；原索引已保留。');
        for (let index = 0; index < batch.length; index++) {
          const vector = output[index];
          if (!validVector(vector, dimensions)) throw new Error('嵌入服务返回了无效向量，或模型维度已变化；请确认模型设置后重建索引。');
          dimensions = dimensions || vector.length;
          vectors[batch[index]] = Array.from(vector);
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (await fingerprintOf(this.runtime) !== fingerprint) throw new Error('索引期间模型设置已变化，原索引已保留。');
      const snapshot = { items, vectors, dimensions, fingerprint, indexedAt: Date.now(), warnings: recoveryWarning ? [recoveryWarning, ...scanned.warnings] : scanned.warnings, skipped: scanned.skipped || 0 };
      checkAbort(signal);
      this.onStatus({ phase: 'saving', items: items.length });
      await this._write(snapshot, signal);
      if (recoveryWarning) await this._removeUnusedSnapshots();
      const summary = { items: items.length, embedded: changed.length, reused, removed: previous.items.filter((item) => !ids.has(item.id)).length,
        skipped: snapshot.skipped, warnings: snapshot.warnings, indexedAt: snapshot.indexedAt, dimensions };
      this.onStatus({ phase: 'ready', ...summary });
      return summary;
    }, signal);
  }

  async search({ query, input, kinds, limit = 10, filter, signal } = {}) {
    checkAbort(signal);
    const snapshot = await this._load();
    const features = await this.getFeatures();
    const requested = Array.isArray(kinds) ? kinds : KINDS;
    const candidates = snapshot.items.map((item, ordinal) => ({ item, ordinal })).filter(({ item }) => isEnabled(item, features) && requested.includes(item.kind) && (!filter || filter(item)));
    if (!candidates.length) return { hits: [], indexedAt: snapshot.indexedAt, total: 0, warnings: snapshot.warnings };
    if (snapshot.fingerprint !== await fingerprintOf(this.runtime)) throw new Error('模型或向量维度已改变，请先更新索引。');
    const request = { ...(input || {}), ...(typeof query === 'string' && query.trim() ? { text: query.trim() } : {}) };
    if (!Object.values(request).some((value) => typeof value === 'string' && value.trim())) throw new Error('请输入搜索内容或选择查询文件。');
    const output = encodedVectors(await this.runtime.encode([request], { signal, query: true, code: requested.length === 1 && requested[0] === 'code' }));
    checkAbort(signal);
    if (output.length !== 1 || !validVector(output[0], snapshot.dimensions)) throw new Error('查询向量无效，或模型维度与当前索引不一致。');
    const currentFeatures = await this.getFeatures();
    const hits = candidates.filter(({ item }) => isEnabled(item, currentFeatures)).map(({ item, ordinal }) => {
      const semanticScore = cosine(output[0], snapshot.vectors[ordinal]);
      const lexicalScore = exactScore(request.text, item);
      return { id: item.id, kind: item.kind, text: item.text || '', source: item.source,
        score: semanticScore * 0.88 + lexicalScore * 0.12, semanticScore, exactScore: lexicalScore };
    }).sort((left, right) => right.score - left.score).slice(0, Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 10)));
    return { hits, indexedAt: snapshot.indexedAt, total: candidates.length, warnings: snapshot.warnings };
  }

  async stats() {
    const snapshot = await this._load();
    const features = await this.getFeatures();
    const counts = Object.fromEntries(KINDS.map((kind) => [kind, snapshot.items.filter((item) => item.kind === kind).length]));
    return { items: snapshot.items.length, activeItems: snapshot.items.filter((item) => isEnabled(item, features)).length,
      counts, dimensions: snapshot.dimensions, indexedAt: snapshot.indexedAt, fingerprint: snapshot.fingerprint,
      busy: this.busy, warnings: snapshot.warnings, skipped: snapshot.skipped };
  }

  async clear({ signal } = {}) {
    return this._exclusive(async () => {
      await this._write(emptySnapshot(), signal);
      await this._removeUnusedSnapshots();
      return this.stats();
    }, signal);
  }
}

module.exports = { SemanticIndex, cosine, exactScore, validVector };
