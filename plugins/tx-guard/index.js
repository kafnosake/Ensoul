const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createHash, randomUUID } = require('crypto');

const WRITE_TOOLS = new Set(['write_file', 'edit', 'restore_backup', 'rollback_recent']);
const MAX_HOLD = 1_000_000;
const inFlight = new Set();
const hash = (text) => text === null ? 'missing' : createHash('sha256').update(text, 'utf8').digest('hex');
const PARAMS = {
  guard: { label: t('写入守卫（改坏了当场撤回）'), type: 'bool', default: true },
  syntax: { label: t('校验 JS / JSON 语法'), type: 'bool', default: true },
  stale: { label: t('待定记录多久后检查恢复（秒）'), type: 'number', default: 120, min: 5, max: 3600 },
};

function syntaxErr(rel, text) {
  const ext = path.extname(rel).toLowerCase();
  try {
    if (ext === '.json') JSON.parse(text);
    else if (ext === '.cjs') new vm.Script(text, { filename: rel });
    else if (ext === '.js') {
      try { new vm.Script(text, { filename: rel }); }
      catch (error) {
        if (!vm.SourceTextModule) throw error;
        new vm.SourceTextModule(text, { identifier: rel });
      }
    } else if (ext === '.mjs' && vm.SourceTextModule) new vm.SourceTextModule(text, { identifier: rel });
    return null;
  } catch (error) { return String(error.message || error); }
}

module.exports = {
  params: PARAMS, name: 'tx-guard',
  description: t('按工具调用记录写入，验收失败时核对版本再回滚；版本冲突保留文件与恢复记录'),
  setup(api) {
    if (!api.onFileWrite || !api.files) {
      api.onBeforeTool((call) => WRITE_TOOLS.has(call.name) ? '写入未执行：主进程版本过旧，请从托盘退出并重新启动以接入写入守卫。' : undefined);
      return;
    }
    const root = path.resolve(api.workspace);
    const on = api.param('guard') !== false, checkSyntax = api.param('syntax') !== false;
    const staleMs = Math.max(5, Number(api.param('stale')) || 120) * 1000;
    const base = path.join(root, '.ensoul/state/tx-guard');
    const box = path.join(base, 'open'), conflicts = path.join(base, 'conflicts'), saved = path.join(base, 'recovered');
    const pending = new Map();
    const inside = (file) => {
      const rel = path.relative(root, path.resolve(file));
      return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
    };
    const recordFile = (id) => path.join(box, id + '.json');
    const put = (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.' + randomUUID() + '.tmp';
      try { fs.writeFileSync(tmp, text, 'utf8'); fs.renameSync(tmp, file); }
      finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    };
    const keepConflict = (rec, reason) => {
      put(path.join(conflicts, rec.txid + '.json'), JSON.stringify({ ...rec, reason, conflictAt: Date.now() }, null, 2));
      fs.unlinkSync(recordFile(rec.txid));
      api.log(`写入恢复保留现场：${rec.rel} · ${reason} · ${path.join(conflicts, rec.txid + '.json')}`);
    };
    const drop = (rec) => { if (fs.existsSync(recordFile(rec.txid))) fs.unlinkSync(recordFile(rec.txid)); };
    const restore = (rec) => {
      if (!inside(rec.full)) throw Error('恢复路径不在当前工作区，保留记录供人工检查');
      const currentHash = api.files.revision(rec.full);
      if (currentHash === rec.beforeHash) return;
      if (!rec.afterHash || currentHash !== rec.afterHash) throw Error('回滚版本冲突，当前文件不属于这次写入');
      const current = currentHash === 'missing' ? null : fs.readFileSync(rec.full, 'utf8');
      if (current !== null) put(path.join(saved, rec.txid + '__' + path.basename(rec.rel)), current);
      api.files.restore(rec.full, rec.before, rec.afterHash);
    };

    api.onFileWrite((event) => {
      if (!on || !WRITE_TOOLS.has(event.toolName) || !inside(event.path)) return;
      if (event.before !== null && (Buffer.byteLength(event.before) > MAX_HOLD || event.before.includes('\0') || hash(event.before) !== event.beforeHash)) return;
      const entries = pending.get(event.toolCallId) || new Map();
      const prior = entries.get(event.path);
      const rec = { ...(prior || { txid: 'tx-' + randomUUID(), toolCallId: event.toolCallId,
        panelId: event.panelId, full: event.path, rel: path.relative(root, event.path),
        before: event.before, beforeHash: event.beforeHash, pid: process.pid, at: Date.now() }), afterHash: event.afterHash };
      // 留底失败就不放行写入。
      put(recordFile(rec.txid), JSON.stringify(rec));
      inFlight.add(rec.txid); entries.set(event.path, rec); pending.set(event.toolCallId, entries);
    });

    api.onAfterTool((done) => {
      const callId = done.toolCallId || done.ctx?.toolCallId;
      const entries = pending.get(callId);
      if (!entries) return;
      pending.delete(callId);
      const notices = [];
      for (const rec of entries.values()) {
        try {
          const currentHash = api.files.revision(rec.full);
          if (currentHash === rec.beforeHash) { drop(rec); continue; }
          if (currentHash !== rec.afterHash) {
            keepConflict(rec, '写入后文件被其他来源改动，未回滚');
            notices.push(`⛔ [FILE_CONFLICT] ${rec.rel} 已发生后续修改，保留现场；记录 ${path.join(conflicts, rec.txid + '.json')}`);
            continue;
          }
          const now = fs.readFileSync(rec.full, 'utf8');
          const error = checkSyntax && syntaxErr(rec.rel, now);
          if (!error || (rec.before !== null && syntaxErr(rec.rel, rec.before))) { drop(rec); continue; }
          restore(rec); drop(rec);
          notices.push(`⛔ ${rec.rel} 没有通过语法验收，已撤回本次写入：${error}`);
        } catch (error) {
          if (fs.existsSync(recordFile(rec.txid))) {
            try { keepConflict(rec, String(error.message || error)); }
            catch (saveError) { api.log('恢复记录仍在 open：' + String(saveError.message || saveError)); }
          }
          notices.push(`⛔ [RESTORE_FAILED] ${rec.rel} 未完成回滚：${error.message || error}；恢复记录 ${base}`);
        } finally { inFlight.delete(rec.txid); }
      }
      if (notices.length) return JSON.stringify({ ok: false,
        code: notices.some((note) => note.includes('FILE_CONFLICT')) ? 'FILE_CONFLICT' : 'WRITE_REJECTED',
        error: notices.join('\n'), rawResult: done.result, next: '请读取当前文件，按现状修复，不要覆盖后续改动。' });
    });

    if (fs.existsSync(box)) for (const file of fs.readdirSync(box).filter((name) => name.endsWith('.json'))) {
      let rec;
      try {
        rec = JSON.parse(fs.readFileSync(path.join(box, file), 'utf8'));
        if (!rec.txid || file !== rec.txid + '.json' || typeof rec.full !== 'string' || typeof rec.rel !== 'string'
          || !(rec.before === null || typeof rec.before === 'string')) throw Error('待定记录格式不完整');
        if (rec.pid === process.pid && (inFlight.has(rec.txid) || Date.now() - (rec.at || 0) < staleMs)) continue;
        if (!rec.beforeHash) rec.beforeHash = hash(rec.before);
        if (rec.beforeHash !== hash(rec.before)) throw Error('恢复记录的旧内容与版本不一致，保留现场');
        restore(rec); drop(rec);
        api.log(`已核对并恢复中断写入：${rec.rel}`);
      } catch (error) {
        if (rec?.txid && file === rec.txid + '.json') {
          try { keepConflict(rec, String(error.message || error)); }
          catch (saveError) { api.log('未移动恢复记录：' + String(saveError.message || saveError)); }
        } else api.log(`待定记录保留：${path.join(box, file)} · ${error.message || error}`);
      }
    }
  },
};
