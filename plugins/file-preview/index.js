/**
 * 文件预览 —— 让工作区里的文件真的"看得见"。
 *
 * 为什么需要它：核心的文本面板只会把文件当文本读。图、视频、音频、3D 模型
 * 进了 textarea 就是一堆乱码；而大文件（几百 MB 的视频、几十 MB 的 glb）
 * 更不该整份搬进渲染进程的内存里。
 *
 * 分工（跟别的插件一样，脸是哑的、脑在主进程）：
 *
 *   plugins/file-preview/index.js    脑：一个只读的本地文件服务，带 Range
 *   plugins/file-preview/panel.tsx   脸：按扩展名分发到图像 / 视频 / 音频 / 3D / 文本查看器
 *   plugins/file-preview/panel.css   皮
 *
 * ── 为什么不把文件直接递给渲染层 ──────────────────────────────────────
 *
 * 脸只有 `fs.read`（纯文本，还有 300KB 上限），二进制读不进来。
 * `<video>` 拖进度条要 206 分段响应，three 的 GLTFLoader 走 fetch ——
 * 裸 file:// 过不了 CORS（唯一豁免的是 <img>，所以核心的看图能用）。
 *
 * 所以这里起一个**只监听 127.0.0.1** 的只读 HTTP 服务：
 *
 *   · 每次 setup 换一枚随机令牌（跟核心 rpc server 同一个路子），
 *     令牌不对一律 403 —— 本机别的进程也读不到你的文件；
 *   · 默认只放行**工作区里面**的文件，边界的判定先过 realpath
 *     （软链接指到工作区外也拦得住）；
 *   · 工作区外的文件要面板显式排一条命令来授权，授权记在状态文件里；
 *   · 只实现 GET / HEAD / OPTIONS，没有任何写入口。
 *
 * 地址形如 http://127.0.0.1:<port>/fs/<token>/D%3A/ensoul/a.png
 * 路径**按段拆开**而不是整条塞进 query：gltf 里的相对贴图要能顺着 URL
 * 相对解析到同一个目录（foo.gltf 里的 ./tex.png 得解析成隔壁那张图）。
 *
 * ── 两条文件通道 ────────────────────────────────────────────────────
 *
 *   状态  .ensoul/state/file-preview.json      插件写、面板读：端口 + 令牌 + 授权表
 *   命令  .ensoul/state/file-preview.cmd.json  面板写、插件读：授权工作区外的文件
 *         队列里每条都带 panelId（脸写进来时带上）—— 授权这件事本身是**文件级**的，
 *         所以放行表不按面板分槽；panelId 只用来记「这个路径是谁点的授权」。
 *
 * 「这块面板在看哪个文件」不在这儿存 —— 它就在面板自己的 `file` 字段上
 * （跟文本面板同一个字段，store 本来就会持久化它）。于是这里没有"单槽"：
 * 开几块预览面板，各看各的，谁也不串味。
 * 授权表（allow）确实是全局一份，但那跟"哪块面板"无关 —— 它回答的是
 * "这个路径能不能读"，跟 git 状态是工作区级的事实同一个道理。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

/** 插件写、面板读 */
const STATE = '.ensoul/state/file-preview.json';
/** 面板写、插件读 */
const CMD = '.ensoul/state/file-preview.cmd.json';
/** 多久看一次命令文件（读的是个几百字节的小文件，代价可以忽略） */
const TICK = 200;
/** 授权表最多记多少条，超了按最近用的留 */
const MAX_ALLOW = 128;

/** 扩展名 → MIME。表里没有的一律 application/octet-stream。 */
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.weba': 'audio/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.stl': 'model/stl',
  '.obj': 'text/plain; charset=utf-8',
  '.mtl': 'text/plain; charset=utf-8',
  '.ply': 'application/octet-stream',
  '.fbx': 'application/octet-stream',
  '.dae': 'model/vnd.collada+xml',
  '.3ds': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
};

const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

let server = null;
let timer = null;
let lastSeq = 0;

/** 读一份 JSON；读不到、写坏了都当没有 —— 下一跳还有机会 */
function readJson(file, fallback) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 这个路径读不读得动。
 * 先 resolve，再（存在的话）过一遍 realpath —— 软链接指向工作区外也要拦住。
 */
function makeGate(root, allow) {
  const rlow = path.resolve(root).toLowerCase();
  return (abs) => {
    let p = path.resolve(abs);
    try {
      p = fs.realpathSync.native(p);
    } catch {
      /* 还不存在：就按原路径判，反正下一步 stat 会失败 */
    }
    const low = p.toLowerCase();
    if (low === rlow || low.startsWith(rlow + path.sep)) return true;
    return allow.has(low);
  };
}

module.exports = {
  name: 'file-preview',
  description: t('把工作区里的文件直接看起来：图像、视频、音频、3D 模型、文本 —— 大文件按 Range 分段读，不整份塞进内存'),

  panel: {
    kind: 'file-preview',
    label: t('文件预览'),
    hint: t('看图、看视频、听音频、转 3D 模型'),
    title: t('文件预览'),
    body: 'messages',
  },

  /*
   * 状态/命令文件**必须**走 api.dataPath，不许自己 path.join(workspace, …)。
   *
   * 踩过的坑，代价很大：面板唯一能读文件的口子是 `fs.read`，它走核心的
   * `runtimePath()` 做重定向；插件裸拼路径写的是工作区里那份 ——
   * **同一个逻辑路径被解析成两个文件**。面板于是永远读着冻结的旧副本
   * （端口早死了），界面上只有一句 `TypeError: Failed to fetch`，
   * 从外部怎么测都是 200。查了很久才定位到"两份文件"。
   *
   * `api.dataPath(rel)` 就是 `runtimePath(rel, workspace)`，与面板同一条路。
   */
  setup(api) {
    const root = api.workspace || process.cwd();
    const statePath = api.dataPath(STATE);
    const cmdPath = api.dataPath(CMD);

    /*
     * 每次 setup 换一枚新令牌。插件热重载会重建整个模块，老服务在 dispose 里
     * 关掉了，令牌也就作废 —— 面板读到新状态自然切到新地址。
     */
    const token = crypto.randomBytes(18).toString('hex');

    /** 上一轮说的授权表，读回来接着用（路径一律按小写规范化存） */
    const allow = new Set(
      (readJson(statePath, {}).allow || []).map((x) => String(x || '').toLowerCase()).filter(Boolean),
    );
    const touched = new Map(
      (readJson(statePath, {}).allowAt || []).map((pair) => [String(pair[0] || '').toLowerCase(), Number(pair[1]) || 0]),
    );

    const gate = makeGate(root, allow);

    /** 授权表按"最近用过"封顶 —— 不按时间清，清了下次还得再授权一遍 */
    function trimAllow() {
      if (allow.size <= MAX_ALLOW) return false;
      const keep = [...allow]
        .sort((a, b) => (touched.get(b) || 0) - (touched.get(a) || 0))
        .slice(0, MAX_ALLOW);
      const keepSet = new Set(keep);
      let cut = false;
      for (const p of [...allow]) {
        if (!keepSet.has(p)) {
          allow.delete(p);
          cut = true;
        }
      }
      return cut;
    }

    function saveState(extra) {
      /*
       * 端口要**稳稳地取**：`server` 在 listen 之前就被赋了值，那一刻
       * `address()` 还是 null（端口要等监听成功才有）。直接取就抛 ——
       * 而 setup 的同步阶段（比如"起来先放行一次"）正好落在那个窗口里，
       * 一抛整个插件就装不上了。取不到就按 0 写，下一跳自然会补上。
       */
      let port = 0;
      try {
        const addr = server && server.address();
        port = addr && typeof addr === 'object' ? addr.port : 0;
      } catch {
        port = 0;
      }
      const body = {
        ok: !!port,
        port,
        token,
        at: Date.now(),
        reason: port ? '' : extra && extra.reason ? extra.reason : '',
        allow: [...allow],
        allowAt: [...touched.entries()].slice(-MAX_ALLOW),
      };
      writeJson(statePath, body);
      return body;
    }

    // ── 那个只读服务 ────────────────────────────────────────────────
    /**
     * Draco 解码器（three 自带的那两个 gltf 解码文件）。
     *
     * 为什么由主进程喂、而不是打进界面包：解码器得**起一个 blob Worker** 跑，
     * 而界面是 file:// 页面 —— 解码文件放 dist 里它 fetch 不到（file:// 取不到，
     * 这正是整个只读服务存在的理由）；走这条路它就和模型同一个来源、同一套
     * CORS 头（那套头是实测出来的，少一条浏览器就整条掐掉）。
     */
    const DRACO_DIR = (() => {
      try {
        return path.join(path.dirname(require.resolve('three/package.json')), 'examples', 'jsm', 'libs', 'draco', 'gltf');
      } catch {
        try {
          return path.join(api.workspace, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco', 'gltf');
        } catch {
          return '';
        }
      }
    })();
    /** 只认这几个名字 —— 上面那个目录里的东西不经过 gate，白名单是唯一的边界 */
    const DRACO_FILES = {
      'draco_wasm_wrapper.js': 'text/javascript; charset=utf-8',
      'draco_decoder.wasm': 'application/wasm',
    };

    function serve(req, res) {
      /*
       * 这几个头不是可选的，少一句浏览器就把请求整个掐掉（报 TypeError: Failed to fetch，
       * 连状态码都看不到 —— 我第一版就是栽在这儿：node 侧测着 200，界面里一直"读不了"）。
       *
       *   · `access-control-allow-origin: *`  ← 页面是 file://（源是 opaque），天生跨源
       *   · `access-control-allow-private-network` ← **Private Network Access**：
       *     Chromium 把"公网/本地文件页 → 127.0.0.1"当作从公开网络进私有网络，
       *     预检里带 `Access-Control-Request-Private-Network: true`，服务端必须
       *     回一句 `true` 才放行。这一条只有浏览器认，所以 curl / node 测不出来。
       *   · `cross-origin-resource-policy: cross-origin` ← 免得被 CORP 再挡一道
       */
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
        'access-control-allow-private-network': 'true',
        'access-control-expose-headers': 'content-range, accept-ranges, content-length, content-type',
        'cross-origin-resource-policy': 'cross-origin',
      };
      const fail = (code, msg) => {
        res.writeHead(code, { ...cors, 'content-type': 'text/plain; charset=utf-8' });
        res.end(msg);
      };

      try {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, cors);
          res.end();
          return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, t('这里只读：只放行 GET / HEAD'));

        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (url.pathname === '/ping') return fail(200, 'file-preview ok');

        /**
         * Draco 解码器：**不经过 gate**，只认白名单里的两个文件名。
         *
         * 它在 node_modules 里 —— 按 gate 的规矩那是"工作区里的"，可这里不能走
         * 那条路：gate 要的是"面板正看着的文件"，解码器不是。白名单是唯一入口，
         * 名字对不上就没这门。
         */
        const dm = /^\/draco\/([^/]+)$/.exec(url.pathname);
        if (dm) {
          const name = dm[1];
          const ctype = DRACO_FILES[name];
          if (!ctype) return fail(404, t('解码器里没有这个文件'));
          if (!DRACO_DIR) return fail(500, t('找不到 three 的解码器目录'));
          const file = path.join(DRACO_DIR, name);
          let buf;
          try {
            buf = fs.readFileSync(file);
          } catch {
            return fail(404, t('解码器文件读不到'));
          }
          res.writeHead(200, {
            ...cors,
            'content-type': ctype,
            'content-length': buf.length,
            'cache-control': 'public, max-age=86400',
          });
          if (req.method === 'HEAD') return res.end();
          return res.end(buf);
        }

        const hit = /^\/fs\/([^/]+)\/(.*)$/.exec(url.pathname);
        if (!hit) return fail(404, t('没有这个路径'));
        if (hit[1] !== token) return fail(403, t('令牌不对'));

        let segs;
        try {
          segs = hit[2].split('/').filter(Boolean).map(decodeURIComponent);
        } catch {
          return fail(400, t('路径编码坏了'));
        }
        if (!segs.length) return fail(400, t('没给路径'));

        // Windows 的盘符是路径的第一段（D%3A → "D:"）；其余平台从根开始
        const abs =
          /^[a-zA-Z]:$/.test(segs[0])
            ? path.normalize(segs[0] + path.sep + segs.slice(1).join(path.sep))
            : path.normalize(path.sep + segs.join(path.sep));

        if (!gate(abs)) return fail(403, t('这个路径不在工作区里，也没被授权'));

        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          return fail(404, t('找不到这个文件'));
        }
        if (!st.isFile()) return fail(404, t('这是个目录，不是文件'));

        const total = st.size;
        const type = mimeOf(abs);
        const head = {
          ...cors,
          'content-type': type,
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
          'last-modified': st.mtime.toUTCString(),
        };

        // Range：视频拖进度条、3D 加载器分段读都靠它
        const raw = String(req.headers.range || '').trim();
        const m = /^bytes=(\d*)-(\d*)$/.exec(raw);
        let start = 0;
        let end = total - 1;
        let partial = false;
        if (m && (m[1] || m[2])) {
          if (m[1]) {
            start = Number(m[1]);
            end = m[2] ? Number(m[2]) : total - 1;
          } else {
            const tail = Number(m[2]);
            start = Math.max(0, total - tail);
            end = total - 1;
          }
          if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
            res.writeHead(416, { ...cors, 'content-range': `bytes */${total}` });
            res.end();
            return;
          }
          partial = true;
        }

        if (partial) {
          res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': end - start + 1 });
        } else {
          res.writeHead(200, { ...head, 'content-length': total });
        }
        if (req.method === 'HEAD') {
          res.end();
          return;
        }

        const stream = fs.createReadStream(abs, partial ? { start, end } : undefined);
        stream.on('error', () => {
          try {
            res.destroy();
          } catch {
            /* 已经断了 */
          }
        });
        res.on('close', () => stream.destroy());
        stream.pipe(res);
      } catch (e) {
        fail(500, String((e && e.message) || e));
      }
    }

    const s = http.createServer((req, res) => serve(req, res));
    s.on('error', (e) => {
      api.log(`文件预览服务起不来：${(e && e.message) || e}`);
      server = null;
      saveState({ reason: t('本地只读服务没起来（端口被占？）') });
    });
    s.listen(0, '127.0.0.1', () => {
      server = s;
      // 别让它成为"进程退不掉"的理由
      if (typeof s.unref === 'function') s.unref();
      saveState();
      api.log(`文件预览就位（http://127.0.0.1:${s.address().port}，只读、只放行工作区）`);
    });
    server = s;

    // ── 命令通道：面板排一条授权 ────────────────────────────────────
    /**
     * 队列里每条都带 panelId（记下是谁点的），但**授权本身是文件级的** ——
     * 同一个文件被哪块面板授权过都一样能读，所以 allow 不按面板分槽。
     */
    function applyCmds() {
      const q = readJson(cmdPath, null);
      const cmds = q && Array.isArray(q.cmds) ? q.cmds : [];
      if (!cmds.length) return false;

      let applied = false;
      for (const raw of cmds) {
        const seq = Number(raw && raw.seq);
        if (!Number.isFinite(seq) || seq <= lastSeq) continue; // 已经执行过的，跳过
        lastSeq = seq;
        const cmd = String((raw && raw.cmd) || '');
        const p = String((raw && raw.path) || '').trim();
        if (!p) continue;
        // 谁点的（记下来只为了日志里说得清；放行是文件级的，不按面板分）
        const by = String((raw && raw.panelId) || '') || t('未署名面板');
        let abs = path.resolve(p);
        try {
          abs = fs.realpathSync.native(abs);
        } catch {
          /* 不存在就按原样记 */
        }
        const low = abs.toLowerCase();
        // open：把某个文件摆到某块预览面板上（path=要看的文件，target=哪块面板，默认就是发起的那块）。
        // 助手在别的面板里也能用这条路把模型/图推到预览面板 —— 那条路本来只有面板内部才有。
        if (cmd === 'open') {
          const to = String((raw && (raw.target || raw.panelId)) || '');
          const patched = to ? api.patchPanel(to, { file: abs.replace(/\\/g, '/') }) : null;
          if (patched) {
            allow.add(low);
            touched.set(low, Date.now());
            applied = true;
            api.log(t('把 {p} 摆到预览面板 {to} 上', { p: abs, to }));
          } else {
            api.log(t('找不到要摆的那块预览面板：{to}', { to }));
          }
          continue;
        }
        if (cmd !== 'allow') continue;
        const fresh = !allow.has(low);
        allow.add(low);
        touched.set(low, Date.now());
        applied = true;
        if (fresh) api.log(t('放行工作区外的路径：{p}（{by} 点的）', { p: abs, by }));
      }

      if (applied) {
        trimAllow();
        saveState();
        try {
          fs.writeFileSync(cmdPath, JSON.stringify({ cmds: [] }), 'utf8');
        } catch {
          /* 清不掉也无所谓：seq 不会再大过 lastSeq，同一批不会执行两次 */
        }
      }
      return applied;
    }

    /**
     * 面板正在看的那个文件，**本身就是一次授权**。
     *
     * 为什么必须补这一步：`panel.file` 有好几条来路 —— 助手调工具、用户粘路径、
     * 拖进来，还有**旧存档里存着的那一个**。可授权以前只写在助手工具那条路上，
     * 于是另外几条撞上工作区外的文件时，服务这侧一律 403，界面上就是"读不了"。
     * （3D 模型尤其明显：它连第一次 GET 都拿不到，画布上只剩一句读不了。）
     *
     * 放行不等于放松边界：能被面板指着看的，本来就是用户自己打开的东西 ——
     * 面板 id 和 file 都躺在工作区存档里，用户看得见、也随时能改。
     * 工作区内的文件走 gate 本来就通，这里只管区外那部分。
     */
    function authorizePanelFiles() {
      let list = [];
      try {
        list = api.panels() || [];
      } catch {
        return false; // 拿不到面板清单就下一跳再说
      }
      const rlow = path.resolve(root).toLowerCase();
      let fresh = false;
      for (const p of list) {
        if (!p || !p.file) continue;
        if (String(p.kind || '') !== 'file-preview') continue;
        let real = path.resolve(String(p.file).replace(/\\/g, '/'));
        try {
          real = fs.realpathSync.native(real);
        } catch {
          /* 还不存在就先按原路径记，反正服务那边还会 stat 一次 */
        }
        const low = real.toLowerCase();
        if (low === rlow || low.startsWith(rlow + path.sep)) continue; // 区内的本来就通
        touched.set(low, Date.now());
        if (!allow.has(low)) {
          allow.add(low);
          fresh = true;
          api.log(t('放行工作区外的路径：{p}（预览面板正看着它）', { p: real }));
        }
      }
      if (fresh) {
        trimAllow();
        saveState();
      }
      return fresh;
    }

    timer = setInterval(() => {
      applyCmds();
      authorizePanelFiles();
    }, TICK);
    if (timer && typeof timer.unref === 'function') timer.unref();
    // 起来先放行一次：旧存档里存着的那个区外文件，不用等下一跳
    authorizePanelFiles();

    // ── 工具：让助手把某个文件摆到预览面板上 ──────────────────────
    api.addTool(
      {
        name: 'file_preview',
        description:
          t('把一个文件摆到文件预览面板上看：图像、视频、音频、3D 模型（glb/gltf/obj/stl/ply/fbx）都能开，别的按文本或十六进制看。')
          + t('path 给工作区里的相对路径，或者一个本机绝对路径。用户说"打开这个文件看看 / 看看这个模型"时用它。'),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: t('要看的文件：工作区相对路径，或本机绝对路径') },
          },
          required: ['path'],
        },
        level: 'read',
        scope: ['file-preview'],
      },
      (args, ctx) => {
        const raw = String((args && args.path) || '').trim().replace(/^["']|["']$/g, '');
        if (!raw) return t('path 得给：要看的那个文件在哪。');
        const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          return t('找不到这个文件：{p}。给工作区里的相对路径，或者一个本机绝对路径。', { p: raw });
        }
        if (!st.isFile()) return t('{p} 是个目录，不是文件 —— 预览得给具体某个文件。', { p: raw });

        const ext = path.extname(abs).toLowerCase();
        const inside = gate(abs);
        // 工作区外的文件先在授权表里记一笔（这一轮就生效，服务端下次请求放行）
        if (!inside) {
          const low = abs.toLowerCase();
          allow.add(low);
          touched.set(low, Date.now());
          trimAllow();
          saveState();
        }

        const panelId = (ctx && ctx.panelId) || '';
        const who = panelId ? api.patchPanel(panelId, { file: abs.replace(/\\/g, '/') }) : null;
        if (!who) {
          return t('文件在：{p}（{n} KB，{ext}）。但这块面板不是文件预览面板，我摆不上去 —— 让用户切到文件预览面板再说。', {
            p: raw,
            n: Math.round(st.size / 1024),
            ext: ext || t('（没有扩展名）'),
          });
        }
        return t('已经把 {name}（{n} KB，{ext}）摆到预览面板上了，用户直接看得见 —— 不用再把路径贴一遍。', {
          name: path.basename(abs),
          n: Math.round(st.size / 1024),
          ext: ext || t('（没有扩展名）'),
        });
      },
    );

    api.log(t('文件预览就绪（状态 {s}，命令 {c}）', { s: STATE, c: CMD }));
  },

  dispose() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (server) {
      try {
        server.close();
      } catch {
        /* 已经关了 */
      }
      server = null;
    }
  },
};

/* touch 1791995400000 */
