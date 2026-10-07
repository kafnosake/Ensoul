const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const runFile = promisify(execFile);
const CODE = new Set('js jsx mjs cjs ts tsx mts cts py pyi java kt kts c h cpp hpp cc cs go rs rb php swift scala sh bash zsh fish ps1 psm1 bat cmd sql graphql gql vue svelte css scss sass less html htm xml lua r jl ex exs erl clj cljs dart m mm groovy make cmake dockerfile'.split(' '));
const DOCUMENTS = new Set('md mdx markdown txt rst adoc org json jsonc jsonl yaml yml toml ini cfg conf csv tsv log'.split(' '));
const IMAGES = new Set('jpg jpeg png webp bmp gif tiff tif'.split(' '));
const AUDIO = new Set('wav mp3 flac ogg oga m4a aac opus'.split(' '));
const VIDEO = new Set('mp4 webm mov avi mkv m4v'.split(' '));
const UNSUPPORTED_DOCUMENTS = new Set('pdf doc docx ppt pptx xls xlsx odt odp ods rtf'.split(' '));
const EXTRACTABLE_DOCUMENTS = new Set('pdf docx pptx xlsx'.split(' '));
const EXCLUDED_DIRS = new Set('.git node_modules dist build out target .ensoul .runtime .electron .venv venv __pycache__ .ssh .aws .azure .gcloud'.split(' '));
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;

function abortError() {
  const error = new Error('索引操作已取消');
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function excluded(relative) {
  const parts = relative.replace(/\\/g, '/').toLowerCase().split('/');
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) return true;
  const name = parts.at(-1);
  return /^\.env(?:\.|$)/.test(name) || /^(?:\.?credentials|\.?secrets?|\.?keys|providers)(?:\.|$)/.test(name)
    || /^(?:id_rsa|id_ed25519|id_ecdsa)(?:\.|$)/.test(name) || /\.(?:pem|key|p12|pfx|keystore)$/.test(name);
}

function kindOf(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const name = path.basename(file).toLowerCase();
  if (CODE.has(ext) || ['makefile', 'dockerfile', 'cmakelists.txt'].includes(name)) return 'code';
  if (DOCUMENTS.has(ext) || ['readme', 'license', 'licence', 'changelog'].includes(name)) return 'documents';
  if (IMAGES.has(ext)) return 'images';
  if (AUDIO.has(ext)) return 'audio';
  if (VIDEO.has(ext)) return 'video';
  return null;
}

function chunkText(text, { maxChars = 1800, overlapChars = 220, maxLines = 48 } = {}) {
  const units = [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.length <= maxChars) units.push({ text: line, line: index + 1 });
    else {
      for (let at = 0; at < line.length; at += Math.max(1, maxChars - overlapChars)) {
        units.push({ text: line.slice(at, at + maxChars), line: index + 1 });
        if (at + maxChars >= line.length) break;
      }
    }
  }
  const chunks = [];
  for (let start = 0; start < units.length;) {
    let end = start;
    let chars = 0;
    while (end < units.length && end - start < maxLines) {
      const cost = units[end].text.length + (end > start ? 1 : 0);
      if (end > start && chars + cost > maxChars) break;
      chars += cost;
      end++;
      if (!units[end - 1].text.trim() && chars >= Math.min(600, maxChars / 2)) break;
    }
    const selected = units.slice(start, end);
    const nonempty = selected.filter((unit) => unit.text.trim());
    const body = selected.map((unit) => unit.text).join('\n').trim();
    if (body) chunks.push({ text: body, line: nonempty[0].line, endLine: nonempty.at(-1).line, part: chunks.length });
    if (end >= units.length) break;
    let next = end;
    let overlap = 0;
    while (next > start + 1 && end - next < 5) {
      const cost = units[next - 1].text.length + 1;
      if (overlap + cost > overlapChars) break;
      overlap += cost;
      next--;
    }
    start = Math.max(start + 1, next);
  }
  return chunks;
}

async function fileHash(file, signal) {
  checkAbort(signal);
  const digest = crypto.createHash('sha256');
  const stream = fs.createReadStream(file);
  const cancel = () => stream.destroy(abortError());
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for await (const bytes of stream) {
      checkAbort(signal);
      digest.update(bytes);
    }
    return digest.digest('hex');
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

async function listedFiles(workspace, signal) {
  const globs = [...EXCLUDED_DIRS].flatMap((directory) => ['--glob', `!**/${directory}/**`]);
  try {
    const { stdout } = await runFile('rg', ['--files', '--hidden', '--null', '--no-require-git', ...globs, '.'], {
      cwd: workspace, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, signal, windowsHide: true,
    });
    return stdout.toString('utf8').split('\0').filter(Boolean);
  } catch (error) {
    checkAbort(signal);
    if (error.code === 1 && !String(error.stderr || '').trim()) return [];
    if (error.code !== 'ENOENT') throw new Error(`读取工作区文件清单失败：${String(error.stderr || error.message).trim()}`);
  }
  try {
    const { stdout } = await runFile('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: workspace, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, signal, windowsHide: true,
    });
    return [...new Set(stdout.toString('utf8').split('\0').filter(Boolean))];
  } catch (error) {
    checkAbort(signal);
    throw new Error('无法按忽略规则扫描工作区，请安装 ripgrep（rg），或在 Git 工作区中使用 Git。');
  }
}

async function readJson(file, signal) {
  checkAbort(signal);
  try {
    return JSON.parse(await fsp.readFile(file, { encoding: 'utf8', signal }));
  } catch (error) {
    checkAbort(signal);
    if (error.code === 'ENOENT') return null;
    throw new Error(`读取会话文件失败 ${file}：${error.message}`);
  }
}

async function addHistory({ workspace, userData, features, items, warnings, signal }) {
  if (!features.history || !userData) return;
  const seen = new Set();
  const take = (panel, file, unscoped = false) => {
    if (!panel || !Array.isArray(panel.chat)) return;
    const panelId = String(panel.id || path.basename(file, '.json'));
    for (let ordinal = 0; ordinal < panel.chat.length; ordinal++) {
      const message = panel.chat[ordinal];
      if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !message.content.trim()) continue;
      const messageId = String(message.id || `ordinal-${ordinal}`);
      const key = `${panelId}:${messageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const chunk of chunkText(message.content)) {
        const title = String(panel.title || panelId);
        const input = { text: `title: ${title} | text: ${chunk.text}` };
        items.push({
          id: `history:${key}:${chunk.part}`, kind: 'history', text: chunk.text, input,
          source: { path: file, messageLine: chunk.line, messageEndLine: chunk.endLine, panelId, messageId, title, at: message.createdAt || 0, ...(unscoped ? { unscoped: true } : {}) },
          fingerprint: hash(JSON.stringify(input)),
        });
      }
    }
  };
  const currentFile = path.join(userData, 'workspace.json');
  const current = await readJson(currentFile, signal);
  const sameWorkspace = current && typeof current.workspace === 'string'
    && path.resolve(current.workspace) === path.resolve(workspace);
  if (sameWorkspace && current.panels && typeof current.panels === 'object') {
    for (const skeleton of Object.values(current.panels)) {
      checkAbort(signal);
      if (!skeleton || typeof skeleton.id !== 'string' || !/^[\w.-]+$/.test(skeleton.id)) continue;
      const file = path.join(userData, 'panels', `${skeleton.id}.json`);
      const body = await readJson(file, signal);
      take({ ...skeleton, ...(body || {}) }, body ? file : currentFile);
      await new Promise((resolve) => setImmediate(resolve));
    }
  } else if (current) warnings.push('当前保存的会话属于其他工作区，已跳过。');
  let unassigned = 0;
  for (const directory of ['closed', 'components']) {
    const base = path.join(userData, directory);
    let files;
    try { files = await fsp.readdir(base); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const name of files) {
      checkAbort(signal);
      if (!name.endsWith('.json')) continue;
      const file = path.join(base, name);
      const panel = await readJson(file, signal);
      const assigned = panel && typeof panel.workspace === 'string' && panel.workspace;
      if (assigned && path.resolve(assigned) !== path.resolve(workspace)) continue;
      if (!assigned && !features.historyArchives) { unassigned++; continue; }
      take(panel, file, !assigned);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  if (unassigned) warnings.push(`已跳过 ${unassigned} 份无法确认工作区归属的旧会话；可在设置中明确启用本机旧会话。`);
}

async function addLearned({ workspace, features, items, warnings, signal }) {
  if (!features.documents) return;
  const directory = path.join(workspace, '.ensoul', 'state', 'agents');
  let files;
  try { files = await fsp.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of files) {
    checkAbort(signal);
    if (!name.endsWith('.json')) continue;
    const file = path.join(directory, name);
    const real = await fsp.realpath(file);
    if (!inside(workspace, real)) { warnings.push(`已跳过指向工作区外的角色卡：${name}`); continue; }
    let card;
    try { card = await readJson(real, signal); } catch (error) { checkAbort(signal); warnings.push(error.message); continue; }
    for (const [ordinal, learned] of (Array.isArray(card?.learned) ? card.learned : []).entries()) {
      if (typeof learned?.name !== 'string' || typeof learned.how !== 'string' || !learned.how.trim()) continue;
      const title = `${card.name || name}：${learned.name}`;
      for (const chunk of chunkText(learned.how)) {
        const input = { text: `title: ${title} | text: ${chunk.text}` };
        items.push({ id: `learned:${name}:${ordinal}:${chunk.part}`, kind: 'documents', text: chunk.text, input,
          source: { path: file, title, recipeType: 'learned', learnedName: learned.name, agentId: card.id || path.basename(name, '.json'), at: learned.at || 0 },
          fingerprint: hash(JSON.stringify(input)) });
      }
    }
  }
}

async function scanCorpus({ workspace, userData, features = {}, roots, signal, onProgress, extract }) {
  checkAbort(signal);
  const root = await fsp.realpath(path.resolve(workspace));
  const selected = [];
  for (const entry of roots?.length ? roots : ['.']) {
    if (typeof entry !== 'string' || !entry.trim()) throw new Error('索引目录必须是工作区内的有效路径。');
    const resolved = path.resolve(root, entry);
    if (!inside(root, resolved)) throw new Error(`索引目录不能离开工作区：${entry}`);
    const real = await fsp.realpath(resolved);
    if (!inside(root, real)) throw new Error(`索引目录的链接指向了工作区外：${entry}`);
    selected.push(real);
  }
  const files = ['documents', 'code', 'images', 'audio', 'video'].some((kind) => features[kind])
    ? await listedFiles(root, signal) : [];
  const items = [];
  const warnings = [];
  let skipped = 0;
  let unsupported = 0;
  for (let index = 0; index < files.length; index++) {
    checkAbort(signal);
    if (index % 128 === 0) {
      onProgress?.({ phase: 'scanning', completed: index, total: files.length, items: items.length });
      await new Promise((resolve) => setImmediate(resolve));
    }
    const relative = files[index];
    const absolute = path.resolve(root, relative);
    if (!inside(root, absolute) || excluded(relative) || !selected.some((selectedRoot) => inside(selectedRoot, absolute))) { skipped++; continue; }
    const extension = path.extname(relative).slice(1).toLowerCase();
    const richDocument = UNSUPPORTED_DOCUMENTS.has(extension);
    const kind = kindOf(relative) || (EXTRACTABLE_DOCUMENTS.has(extension) && extract ? 'documents' : null);
    if (!kind || !features[kind]) {
      if (features.documents && richDocument) unsupported++;
      skipped++;
      continue;
    }
    const real = await fsp.realpath(absolute);
    if (!inside(root, real)) { skipped++; warnings.push(`已跳过指向工作区外的文件：${relative}`); continue; }
    const stat = await fsp.stat(real);
    if (!stat.isFile()) { skipped++; continue; }
    const textKind = !richDocument && (kind === 'documents' || kind === 'code');
    if (stat.size > (textKind ? MAX_TEXT_BYTES : MAX_MEDIA_BYTES)) {
      skipped++;
      warnings.push(`文件过大，未索引：${relative}`);
      continue;
    }
    if (richDocument) {
      let extracted;
      try { extracted = await extract(real, { signal }); } catch (error) {
        checkAbort(signal);
        if (error.name === 'AbortError') throw error;
        skipped++;
        warnings.push(`未能提取文档正文 ${relative}：${error.message}`);
        continue;
      }
      const title = path.relative(root, absolute).replace(/\\/g, '/');
      const pages = extracted && Array.isArray(extracted.pages) && extracted.pages.length
        ? extracted.pages : [{ text: typeof extracted === 'string' ? extracted : extracted?.text }];
      let count = 0;
      for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const page = pages[pageIndex];
        if (typeof page?.text !== 'string') continue;
        for (const chunk of chunkText(page.text)) {
          const input = { text: `title: ${title} | text: ${chunk.text}` };
          items.push({
            id: `documents:${title}:${pageIndex}:${chunk.part}`, kind, text: chunk.text, input,
            source: { path: absolute, title, ...(title.startsWith('work/') ? { recipeType: 'work' } : {}), ...(Number.isInteger(page.page) && page.page > 0 ? { page: page.page } : {}) },
            fingerprint: hash(JSON.stringify(input)),
          });
          count++;
        }
      }
      if (!count) { skipped++; warnings.push(`未提取到可检索正文：${relative}`); }
    } else if (textKind) {
      const bytes = await fsp.readFile(real, { signal });
      if (bytes.includes(0)) { skipped++; continue; }
      const title = path.relative(root, absolute).replace(/\\/g, '/');
      for (const chunk of chunkText(bytes.toString('utf8'))) {
        const input = { text: `title: ${title} | text: ${chunk.text}` };
        items.push({
          id: `${kind}:${title}:${chunk.part}`, kind, text: chunk.text, input,
          source: { path: absolute, line: chunk.line, endLine: chunk.endLine, title, ...(title.startsWith('work/') ? { recipeType: 'work' } : {}) },
          fingerprint: hash(JSON.stringify(input)),
        });
      }
    } else {
      const field = { images: 'image', audio: 'audio', video: 'video' }[kind];
      const fingerprint = await fileHash(real, signal);
      const title = path.relative(root, absolute).replace(/\\/g, '/');
      items.push({ id: `${kind}:${title}`, kind, input: { [field]: real }, source: { path: absolute, title }, fingerprint });
    }
    onProgress?.({ phase: 'scanning', completed: index + 1, total: files.length, items: items.length });
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (unsupported) warnings.push(`${unsupported} 份 PDF / Office 等文档需要正文提取器，尚未进入索引。`);
  await addLearned({ workspace: root, features, items, warnings, signal });
  await addHistory({ workspace: root, userData, features, items, warnings, signal });
  checkAbort(signal);
  return { items, skipped, warnings };
}

module.exports = { scanCorpus, chunkText, inside, excluded, kindOf, hash, checkAbort };
