const { spawn } = require('child_process');
const path = require('path');

function extractDocument(python, filename, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(new Error('操作已取消'));
  return new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(__dirname, 'extract.py'), filename], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (err) reject(err); else resolve(value);
    };
    const abort = () => { child.kill(); finish(new Error('文档读取已取消')); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('文档读取超时')); }, 60000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => {
      output += data.toString();
      if (output.length > 8 * 1024 * 1024) { child.kill(); finish(new Error('提取文本超过 8 MB')); }
    });
    child.stderr.on('data', data => { errors = (errors + data.toString()).slice(-4000); });
    child.on('error', err => finish(err));
    child.on('close', code => {
      try {
        const value = JSON.parse(output);
        if (code !== 0 || value.error) throw new Error(value.error || errors || `文档读取失败 (${code})`);
        finish(null, value);
      } catch (err) { finish(err); }
    });
  });
}

module.exports = { extractDocument };
