import * as http from 'http';
import * as crypto from 'crypto';
import { rpcCall, rpcChannels, rpcCount } from './rpc';
import { t } from '../shared/i18n';

/**
 * 把 rpc 表挂到本机的一个端口上 —— 后端从此有了 Electron 之外的入口。
 *
 * 只绑 127.0.0.1，每次启动换一枚一次性令牌：别的机器连不上，本机也要带令牌。
 */

/** 碰窗口硬件的能力：远程调用没有窗口可碰，直接拒 */
const LOCAL_ONLY = new Set([
  'panel:float',
  'panel:detach',
  'panel:tear',
  'panel:moveFloat',
  'panel:dockFloat',
  'panel:openFloat',
  'tabs:detach',
  'tabs:tear',
  'window:attach',
  'win:control',
  'win:isLive',
  'win:probeCursor',
]);

let server: http.Server | null = null;
let boundPort = 0;
const token = crypto.randomBytes(12).toString('hex');

export function rpcToken(): string {
  return token;
}

export function rpcPort(): number {
  return boundPort;
}

function send(res: http.ServerResponse, code: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
  });
  res.end(body);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
    res.end();
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');
  const given = req.headers['x-ensoul-token'] || url.searchParams.get('token');
  if (given !== token) {
    send(res, 403, { ok: false, error: t('令牌不对') });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/channels') {
    send(res, 200, { ok: true, count: rpcCount(), channels: rpcChannels() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    send(res, 200, { ok: true, port: boundPort, count: rpcCount() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/rpc') {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', async () => {
      let channel = '';
      try {
        const parsed = JSON.parse(raw || '{}');
        channel = String(parsed.channel || '');
        const args = Array.isArray(parsed.args) ? parsed.args : [];
        if (LOCAL_ONLY.has(channel)) throw new Error(`这条能力只在窗口里能用：${channel}`);
        const result = await rpcCall(channel, args);
        send(res, 200, { ok: true, result });
      } catch (e: any) {
        send(res, 200, { ok: false, channel, error: e?.message ?? String(e) });
      }
    });
    return;
  }

  send(res, 404, { ok: false, error: t('没有这个路径') });
}

export function startRpcServer(preferred = 8787): Promise<number> {
  return new Promise((resolve) => {
    if (server) {
      resolve(boundPort);
      return;
    }

    const listen = (port: number, mayRetry: boolean) => {
      const s = http.createServer((req, res) => {
        void handle(req, res);
      });
      s.once('error', () => {
        if (mayRetry) listen(0, false);
        else resolve(0);
      });
      s.listen(port, '127.0.0.1', () => {
        server = s;
        boundPort = (s.address() as { port: number }).port;
        resolve(boundPort);
      });
    };

    listen(preferred, true);
  });
}

export function stopRpcServer() {
  try {
    server?.close();
  } catch {
    /* 已经关了 */
  }
  server = null;
  boundPort = 0;
}
