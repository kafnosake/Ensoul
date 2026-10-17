/**
 * ComfyUI 调度中心 —— 提供生图管线、模型检索与工作流执行能力。
 *
 * 它不重复 ComfyUI 自己的事（界面、节点、显存调度都归 ComfyUI），只把这四步交给助手：
 *
 *   comfyui_status    通不通、什么版本、队列里堆了多少，顺手能打断 / 清队列
 *   comfyui_models    服务器上有些什么 checkpoint / lora / vae ……
 *   comfyui_workflow  管"命名工作流"（API 格式 JSON），存在工作区里
 *   comfyui_run       拿一个工作流 + 一段提示词去出图，等它跑完，把图存回工作区
 *   comfyui_launch    把 ComfyUI 起起来 / 关掉 —— 本机参数直接起，远程用一条 ssh 命令
 *
 * 启动机制三条路按顺序走（谁起的记在 instance.json，关停与闲置回收都认它）：
 *   ① 有「启动命令」就用它（远程 ssh、自定义启动脚本都走这条）；
 *   ② 服务已在跑 → 直接用它的（Desktop 开着就走它的服务，不另起）；
 *   ③ Desktop 进程开着（冷启动中）→ 只等它应声，不撞端口、不双开；
 *   ④ 都没有 → 静默起 python main.py（无窗口无控制台，argv 照桌面版 app 的写法拼：
 *      --base-directory / --user-directory / --listen / --port，前端、模型路径参数一起带上；
 *      桌面版装法的 web UI 在 pip 包外面，光 --front-end-root 就是治这个的）；
 *   ⑤ python 那套参数缺了才回退拉桌面版 exe。
 * 关停链：关闭命令 > 按归属 pid 收进程树（映像名核对防 pid 复用误杀）> 如实说关不了。
 * 静默实例闲置超时（idle 参数，默认 30 分钟、队列无活）自动回收 —— 不永久驻留。
 * 监视入口是会话框顶上的状态位（addStatusItem slot=head）：显示连接/队列，下拉就地启停。
 * 起之前先做参数就绪检查，缺哪项、哪项指向不存在的文件，直观反馈缺失原因。
 *
 * 命令与参数**只从设置里读，模型不能临时传**：模型本来就有跑命令的手脚（run_command），
 * 这里再开一个"你说什么我跑什么"的口子，等于把用户配好的白名单换成任意命令。
 * 都是 detached + unref 起的（本机那条另加 windowsHide + CREATE_NO_WINDOW，别弹黑框）：
 * 交出去就归自己活，软件关了也不带走它；输出堆在应用资料目录 .ensoul/comfyui/launch.log，
 * 起不来时把 pid 和日志最后几行回给助手看。
 *
 * 工作流用标准占位符接收参数：
 *
 *   {{prompt}}  必填：写在某个文本节点的输入里
 *   {{seed}}    可选：写它就会换成这次的随机种子（否则整份 JSON 原样提交）
 *   {{image}}   可选：图生图。只认 inputs.image 那一个字段、值必须恰好是占位符，
 *               最多一处；给了 image 参数才会去替换
 *
 * 配置在插件参数里（地址、等待上限、出图目录）。产物落在工作区：
 *   .ensoul/comfyui/workflows/*.json   工作流
 *   comfyui/out/                       项目出图
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_URL = 'http://127.0.0.1:8188';
const PROMPT_PH = '{{prompt}}';
const SEED_PH = '{{seed}}';
const IMAGE_PH = '{{image}}';
/** 兼容早期单百分号占位符格式 */
const LEGACY = { prompt: '%prompt%', seed: '%seed%', image: '%image%' };

const REQ_MS = 20_000;
const POLL_MS = 1_000;
const JSON_LIMIT = 8 * 1024 * 1024;
const IMAGE_LIMIT = 64 * 1024 * 1024;
const CLIP = 3_000;
const MAX_NAMES = 200;

const PARAMS = {
  preview: {
    label: t('过程中推预览图'),
    type: 'bool',
    default: true,
    hint: t('出图时让 ComfyUI 把每一步的草稿也推过来 —— 对话里就能边生成边看（默认的 latent2rgb 几乎不费性能）。')
      + t('关掉只留进度条'),
  },
  url: {
    label: t('ComfyUI 地址'),
    type: 'text',
    default: DEFAULT_URL,
    hint: t('命令行版默认 8188，ComfyUI Desktop 默认 8000；在别的机器上就写 192.168.x.x:8000'),
  },
  timeout: {
    label: t('出图等待上限（秒）'),
    type: 'number',
    default: 300,
    min: 10,
    max: 3600,
    hint: t('超过就放弃等待，不再占着这一轮对话'),
  },
  out: {
    label: t('出图保存目录'),
    type: 'text',
    default: 'comfyui/out',
    hint: t('相对工作区。想直接在文件面板里看见图，就改成 pics 这类普通目录'),
  },
  see: {
    label: t('出图后自己看一眼（长边像素）'),
    type: 'number',
    default: 768,
    min: 0,
    max: 1536,
    hint: t('出完图把成品按长边缩到这么大，附回给模型看一眼 —— 好不好由它自己判断，差就重画。')
      + t('0 = 不看。768 那一档约 600 token，**而且只在出图那一轮占，不留在历史里**；')
      + t('模型不支持看图就填 0（不然接口会报错）。'),
  },
  start: {
    label: t('启动命令（远程启动 ComfyUI）'),
    type: 'text',
    default: '',
    hint: t('留空 = 起不了。本机：python main.py --listen 127.0.0.1 --port 8188；')
      + t('远程：ssh gpu@192.168.1.20 "cd ~/ComfyUI && nohup python3 main.py --listen 0.0.0.0 --port 8188 > ~/comfyui.log 2>&1 &"'),
  },
  stop: {
    label: t('关闭命令'),
    type: 'text',
    default: '',
    hint: t('留空也能关：我们自己静默起的实例按归属记录直接收进程树。')
      + t('远程 / 外部实例要在这填一条，例：ssh gpu@192.168.1.20 "pkill -f main.py"'),
  },
  idle: {
    label: t('闲置自动回收（分钟）'),
    type: 'number',
    default: 30,
    min: 0,
    max: 1440,
    hint: t('静默起的实例多久没活干就自动收掉（0 = 不自动收）。只收我们自己起的 —— ')
      + t('Desktop 自己开的永远不动；出图排队中绝不收；下次出图自动再起。'),
  },
  desktop: {
    label: t('ComfyUI Desktop 可执行文件（本机启动）'),
    type: 'text',
    default: '',
    hint: t('桌面版装法填这个最省事，填了就不看下面 python / main.py。例 D:\\\\ComfyUI\\\\ComfyUI.exe'),
  },
  python: {
    label: t('python 解释器路径'),
    type: 'text',
    default: '',
    hint: t('例 D:\\\\ComfyUI\\\\.venv\\\\Scripts\\\\python.exe，或者 /home/me/ComfyUI/venv/bin/python'),
  },
  main: {
    label: t('main.py 路径'),
    type: 'text',
    default: '',
    hint: t('ComfyUI 的入口脚本。例 D:\\\\ComfyUI\\\\main.py'),
  },
  base: {
    label: t('base 目录'),
    type: 'text',
    default: '',
    hint: t('ComfyUI 的安装根目录（--base-directory）。例 D:\\\\ComfyUI。')
      + t('桌面版装法必须给，不然它找不到前端就自己退出'),
  },
  frontend: {
    label: t('--front-end-root（可选）'),
    type: 'text',
    default: '',
    hint: t('桌面版装法的 web UI 在 pip 包外面，填上它才不会「找不到内置前端」直接退出'),
  },
  extra: {
    label: t('额外模型路径配置（可选）'),
    type: 'text',
    default: '',
    hint: t('extra_model_paths.yaml 的路径，填了且文件在就带上'),
  },
  boot: {
    label: t('启动等待上限（秒）'),
    type: 'number',
    default: 240,
    min: 10,
    max: 1800,
    hint: t('模型大的机器开得慢，给它留着；桌面版第一次冷启动（自检、装依赖）尤其慢，')
      + t('实测能超两分钟。等不到就把日志最后几行回给助手'),
  },
};

/** 想看哪些模型就从哪个节点上问 —— ComfyUI 把候选列表挂在节点的输入定义里 */
const NODES = {
  checkpoint: 'CheckpointLoaderSimple',
  lora: 'LoraLoader',
  vae: 'VAELoader',
  controlnet: 'ControlNetLoader',
  upscale: 'UpscaleModelLoader',
  clip: 'CLIPLoader',
  unet: 'UNETLoader',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

function clip(s, n) {
  const txt = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return txt.length > (n || CLIP) ? `${txt.slice(0, n || CLIP)}…` : txt;
}

/** 用户可能只写 127.0.0.1:8188，也可能带尾斜杠 / 已经带 http */
function origin(raw) {
  const s = String(raw || '').trim() || DEFAULT_URL;
  const withScheme = /^https?:\/\//i.test(s) ? s : `http://${s}`;
  return withScheme.replace(/\/+$/, '');
}

function seedOf(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.floor(n) % 0x1_0000_0000;
  return Math.floor(Math.random() * 0x1_0000_0000);
}

/** 工具给的路径必须夹在工作区里 —— 不然模型一句话就能读到工作区外的文件 */
function inside(root, rel) {
  const abs = path.resolve(root, String(rel || ''));
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`这个路径跑到工作区外面去了：${rel}`);
  }
  return abs;
}

function rel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

/** 一个带超时的请求。连接不上会抛 TypeError，调用处统一翻译成人话 */
async function http(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_MS);
  try {
    return await fetch(url, { ...(init || {}), signal: ctrl.signal, redirect: 'error' });
  } finally {
    clearTimeout(timer);
  }
}

async function body(res, limit) {
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > limit) throw new Error(`响应太大（${Math.round(buf.length / 1024 / 1024)} MB），不读了`);
  return buf;
}

async function askJson(url, init, what) {
  const res = await http(url, init);
  const text = (await body(res, JSON_LIMIT)).toString('utf8');
  if (!res.ok) throw new Error(`ComfyUI ${what} 报 ${res.status}：${clip(text)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`ComfyUI ${what} 返回的不是 JSON：${clip(text)}`);
  }
}

function friendly(e, originUrl, hint) {
  if (e instanceof TypeError || (e && e.name === 'AbortError')) {
    return `连不上 ${originUrl} —— 确认 ComfyUI 开着、地址对、防火墙没挡。`
      + t('端口别写错：命令行版默认 8188，ComfyUI Desktop 默认 8000。')
      + `${hint || ''}`;
  }
  return `没成：${(e && e.message) || e}`;
}

/** 只问一句"在不在"：通就是 true，连不上、超时、报错都当没在 */
async function alive(target) {
  try {
    const res = await http(`${target}/system_stats`);
    return res.ok;
  } catch {
    return false;
  }
}

/** 启动命令的输出都往这儿堆 —— 起不来时助手回的就是它最后几行 */
function launchLog(api) {
  const dir = api.dataPath('.ensoul/comfyui');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'launch.log');
}

/** 只读文件尾巴：日志涨到几百 MB 也不会往上下文里灌 */
function logTail(abs, max) {
  const n = max || 1200;
  try {
    const fd = fs.openSync(abs, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const from = Math.max(0, size - n);
      const buf = Buffer.alloc(size - from);
      if (buf.length) fs.readSync(fd, buf, 0, buf.length, from);
      return buf.toString('utf8').trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/**
 * 盯着刚交出去的进程：它是不是**很快就退了**。
 *
 * 为什么要盯：detached 起来的进程崩了没人知道 —— 只会在「等它应声」那里
 * 白等满 boot 秒（真踩过：安装目录里留着的旧版 exe 一启动就 fatal，
 * 硬等 150 秒才拿到日志）。unref 只影响"父进程要不要为它活着"，exit 事件照样来。
 */
function watch(child) {
  const proc = { pid: child.pid || 0, code: null, at: 0, err: '' };
  child.on('exit', (code) => {
    proc.code = code === null || code === undefined ? -1 : code;
    proc.at = Date.now();
  });
  child.on('error', (e) => {
    proc.code = -1;
    proc.at = Date.now();
    proc.err = String((e && e.message) || e);
  });
  return proc;
}

/** 桌面版和命令行版的默认端口不一样 —— 地址填错端口的表现就是"永远连不上" */
const PORT_HINT =
  t('\n也确认一下端口：命令行版默认 8188，ComfyUI Desktop 默认 **8000** —— ')
  + '地址里写 8188 而对面其实是桌面版，就会一直连不上。';

/** 日志里那几种一眼能认出来的故障，直接翻成人话（都是真踩过的） */
function launchDiagnosis(text) {
  const raw = String(text || '');
  if (/Version mismatch between V8 binary and snapshot/i.test(raw)) {
    return '\n这行是明牌：那个可执行文件跟同目录的 snapshot 版本对不上 —— '
      + t('安装目录里留了旧版的 exe（升级只换了 exe 旁边的 snapshot 文件），')
      + '用一个目录里较新的那个 exe。';
  }
  if (/EADDRINUSE|address already in use/i.test(raw)) {
    return '\n这行是明牌：那个端口已经被别的进程占了 —— 换一个 --port，或者先把占着它的关掉。';
  }
  if (/No module named|ModuleNotFoundError/i.test(raw)) {
    return '\n这行是明牌：python 环境不对 —— 要用 ComfyUI 自己那个 venv / 桌面版自带的解释器。';
  }
  return '';
}

/** detached + unref：命令交出去就归它自己活（软件关掉也不带走它），输出进日志 */
function spawnDetached(cmd, cwd, log) {
  const fd = fs.openSync(log, 'a');
  try {
    fs.writeSync(fd, `\n[${new Date().toISOString()}] $ ${cmd}\n`);
    const child = spawn(String(cmd), {
      cwd,
      shell: true,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    return watch(child);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* 关不掉就算了，不影响命令本身 */
    }
  }
}

/** CREATE_NO_WINDOW：Win32 上「别开控制台窗口」那个进程创建标志 */
const CREATE_NO_WINDOW = 134217728;

/**
 * 本机启动的命令行参数 argv 组装。
 * 为什么不是一条 `main.py --port` 就完事：桌面版装法的 web UI 在 pip 包外面，
 * 不给 --base-directory / --user-directory 它找不着自己的目录，不给 --front-end-root
 * 它去找内置前端包然后退出。
 */
function launcherArgv(conf, port) {
  const base = conf.base;
  const argv = [
    conf.python,
    conf.main,
    '--base-directory', base,
    '--user-directory', path.join(base, 'user'),
    '--listen', '127.0.0.1',
    '--port', String(port),
  ];
  if (conf.frontend) argv.push('--front-end-root', conf.frontend);
  if (conf.extra && fs.existsSync(conf.extra)) argv.push('--extra-model-paths-config', conf.extra);
  return argv;
}

/** 起之前先看清缺什么：缺哪项、哪项指向不存在的文件，都列出来 */
/**
 * 起之前先看清缺什么 —— 两条本机路各查各的，谁先谁后由 launchAct 定：
 *   silent = python 三件套（静默起，无窗口）；desktop = 桌面版 exe（回退，它自己开窗口）。
 * 不再"填了 desktop 就只看 desktop"：静默启动优先，desktop 是兜底。
 */
function launchReadiness(conf) {
  const silent = [];
  if (!conf.python) silent.push('python 解释器路径');
  else if (!fs.existsSync(conf.python)) silent.push(`python 不在（${conf.python}）`);
  if (!conf.main) silent.push('main.py 路径');
  else if (!fs.existsSync(conf.main)) silent.push(`main.py 不在（${conf.main}）`);
  if (!conf.base) silent.push('base 目录');
  else if (!fs.existsSync(conf.base)) silent.push(`base 目录不在（${conf.base}）`);
  if (conf.frontend && !fs.existsSync(conf.frontend)) silent.push(`--front-end-root 指向的目录不在（${conf.frontend}）`);
  const desktopOk = !!conf.desktop && fs.existsSync(conf.desktop);
  return {
    silentOk: silent.length === 0,
    desktopOk,
    // 两条路都没有才算起不了；报错优先报静默那条缺什么，再补 desktop 的情况
    ok: silent.length === 0 || desktopOk,
    missing: silent.length === 0
      ? []
      : desktopOk ? [] : silent.concat(
          conf.desktop ? [`桌面版可执行文件不在（${conf.desktop}）`] : []),
    silent,
  };
}

/** Desktop 主程序进程还在不在 —— 冷启动中（窗口开了、服务还没应声）时别去撞它的端口 */
function desktopInFlight(conf) {
  if (process.platform !== 'win32' || !conf.desktop) return false;
  try {
    const exe = path.win32.basename(conf.desktop);
    const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${exe}`], { encoding: 'utf8', windowsHide: true });
    const out = String((r && r.stdout) || '');
    return out.toLowerCase().includes(exe.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * argv 版启动：桌面版 exe 和 python main.py 都用它 —— 走 shell（cmd.exe），
 * 因为**隐藏的 console 只有从 shell 那儿拿得到**（见函数体注释，三条死路全试过）。
 * hide 签名保留：shell 自己的黑窗恒压 windowsHide，GUI 程序的窗口不受它管。
 */
function spawnArgvDetached(argv, cwd, log, hide = true) {
  const fd = fs.openSync(log, 'a');
  try {
    fs.writeSync(fd, `\n[${new Date().toISOString()}] $ ${argv.join(' ')}\n`);
    // 无窗口的正确姿势（照抄 plugins/jobs 实证跑通的配方）：**shell:true + windowsHide**。
    // cmd.exe 有一颗**隐藏的** console，python 继承它 —— forrtl/Intel 运行时（custom nodes
    // 里一堆 MKL）有 console 才不闹。另两条路实测踩死过，别再试：CREATE_NO_WINDOW 裸
    // spawn 是整棵树没 console → forrtl error (200) 秒退码 2；conhost --headless /
    // powershell -WindowStyle Hidden 当 wrapper 在本体无 console 的 GUI 父进程下秒退、
    // 子进程根本没起。代价两笔都合算：首进程是 cmd.exe（杀走 taskkill /T，stopAct 正是
    // 这么杀的）；进程树不脱离 ensoul，软件退了服务跟着走 —— 正合绝不永久驻留的意。
    const line = argv.map((s) => (String(s).indexOf(' ') >= 0 ? '"' + s + '"' : s)).join(' ');
    const child = spawn(line, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    return watch(child);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* 同上，关不掉不影响进程 */
    }
  }
}

/**
 * 姊妹端口：8188 ↔ 8000。这两个值搞混是"连不上"最常见的原因 ——
 * 起 ComfyUI 的时候顺手探一眼另一个，就知道是不是"其实起来了、只是端口不对"。
 */
function altTarget(target) {
  try {
    const u = new URL(target);
    const host = u.hostname.toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost') return '';
    const p = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    const other = p === 8188 ? 8000 : p === 8000 ? 8188 : 0;
    if (!other) return '';
    u.port = String(other);
    return u.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** 地址是不是指本机 —— 指别处就只能靠「启动命令」ssh 过去起 */
function isLocal(target) {
  try {
    const host = new URL(target).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '[::1]';
  } catch {
    return true;
  }
}

/** 从地址里取端口，拼本机 argv 用 */
function portOf(target) {
  try {
    const u = new URL(target);
    return Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  } catch {
    return 8188;
  }
}

// ─────────────────────────── 工作流 ───────────────────────────

function parseWorkflow(text, what) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('工作流是空的');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${what} 不是合法 JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) {
    throw new Error(`${what} 得是 API 格式的 JSON 对象（ComfyUI 里「工作流 → 导出（API）」那种）`);
  }
  return value;
}

function isRecord(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 把提示词 / 种子 / 源图灌进工作流。
 * 参数替换规则：文本支持内嵌占位符；图片占位符严格匹配 inputs.image 字段，
 * 而且最多一处（那个字段只能放一个文件名）。
 */
function prepare(workflow, prompt, seed, image) {
  let hits = 0;
  let images = 0;

  const inject = (v) => {
    if (typeof v === 'string') {
      let s = v;
      if (s.includes(PROMPT_PH) || s.includes(LEGACY.prompt)) {
        hits += 1;
        s = s.split(PROMPT_PH).join(prompt).split(LEGACY.prompt).join(prompt);
      }
      if (s === SEED_PH || s === LEGACY.seed) return seed;
      if (s.includes(SEED_PH) || s.includes(LEGACY.seed)) {
        s = s.split(SEED_PH).join(String(seed)).split(LEGACY.seed).join(String(seed));
      }
      return s;
    }
    if (Array.isArray(v)) return v.map(inject);
    if (isRecord(v)) {
      const out = {};
      for (const [k, child] of Object.entries(v)) out[k] = inject(child);
      return out;
    }
    return v;
  };

  const out = {};
  for (const [id, value] of Object.entries(workflow)) {
    const node = isRecord(value) ? value : null;
    if (!node || !isRecord(node.inputs)) {
      out[id] = value;
      continue;
    }
    const inputs = inject(node.inputs);
    const bare = inputs.image === IMAGE_PH || inputs.image === LEGACY.image;
    if (bare) {
      images += 1;
      if (image !== undefined) inputs.image = image;
    }
    out[id] = { ...node, inputs };
  }

  if (hits === 0) throw new Error(`工作流里没有 ${PROMPT_PH} —— 至少要在某个文本输入里写上它，提示词才有地方进`);
  if (image === undefined) {
    if (images > 0) throw new Error(`工作流里有 ${IMAGE_PH}，得同时给 image 参数（一张工作区里的图片）才能跑`);
  } else if (images === 0) {
    throw new Error(`给了 image，但工作流里没有 ${IMAGE_PH} 那个输入 —— 图生图的工作流要在 LoadImage 的 image 字段写 ${IMAGE_PH}`);
  } else if (images > 1) {
    throw new Error(`工作流里有 ${images} 处 ${IMAGE_PH}，只能留一处`);
  }
  return out;
}

/**
 * 增量覆盖：{ "节点id.inputs.字段": 新值 } —— 只动写到的那几处，其余原样。
 * 路径逐段往下走；哪一段对不上就报错（写错了却悄悄不生效，比报错难查得多）。
 * 数字段当数组下标用（LoRA 这类 6.inputs.loras.0.strength 就靠它）。
 * 在 prepare 之后应用：你显式给的值是最终裁决，盖过占位符替换的结果。
 * 只活在这一次提交里，不写回磁盘 —— 原工作流一个字节不动。
 */
function applySet(workflow, set) {
  if (set === undefined || set === null) return workflow;
  if (!isRecord(set)) throw new Error('set 得是个对象：{ "节点id.inputs.字段": 新值 }');
  const keys = Object.keys(set);
  if (!keys.length) return workflow;
  for (const key of keys) {
    const segs = String(key).split('.');
    if (segs.length < 2 || segs.some((s) => !s)) {
      throw new Error(`set 的键 "${key}" 写法不对 —— 至少两段：节点id.字段，例如 6.inputs.steps`);
    }
    let host = workflow;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      const at = Number(seg);
      if (isRecord(host)) {
        if (!Object.prototype.hasOwnProperty.call(host, seg)) {
          throw new Error(`set 的 "${key}" 走不到 ${segs.slice(0, i + 1).join('.')} —— 这一层只有：${Object.keys(host).join('、') || '（空）'}`);
        }
      } else if (Array.isArray(host)) {
        if (!Number.isInteger(at) || at < 0 || at >= host.length) {
          throw new Error(`set 的 "${key}"：${segs.slice(0, i).join('.')} 是数组（长度 ${host.length}），这一段要写数字下标`);
        }
      } else {
        throw new Error(`set 的 "${key}"：${segs.slice(0, i).join('.')} 是 ${typeof host}，走不下去了`);
      }
      host = host[seg];
    }
    const last = segs[segs.length - 1];
    const lastAt = Number(last);
    if (isRecord(host)) {
      // 末段也查存在性：字段名打错时**不许静默新增**，那正是最难查的一类错。
      if (!Object.prototype.hasOwnProperty.call(host, last)) {
        throw new Error(`set 的 "${key}"：这层没有 "${last}" —— 这一层有：${Object.keys(host).join('、') || '（空）'}`);
      }
      host[last] = set[key];
    } else if (Array.isArray(host)) {
      if (!Number.isInteger(lastAt) || lastAt < 0 || lastAt >= host.length) {
        throw new Error(`set 的 "${key}"：${segs.slice(0, -1).join('.')} 是数组（长度 ${host.length}），末段要写数字下标`);
      }
      host[lastAt] = set[key];
    } else {
      throw new Error(`set 的 "${key}"：${segs.slice(0, -1).join('.')} 是 ${typeof host}，没法往里写值`);
    }
  }
  return workflow;
}

/**
 * 最小 WebSocket 客户端 —— 只够读 ComfyUI 推过来的进度和预览帧。
 *
 * 为什么不直接用 WebSocket：插件跑在 Electron 的 Node 20 里，那里**没有**全局 WebSocket
 * （系统 node 22 有，Electron 33 的 node 20 实测是 undefined），而插件只能用它自带的模块、
 * 装不了 npm 包。所以握手和帧解析自己来，够用就行：文本帧、二进制帧、分片、ping，
 * 不协商任何扩展（于是没有压缩那一层要解）。
 *
 * 连不上、握手不是 101、或者 3 秒还没握上，都返回 null —— 调用方照常出图，
 * 只是这一块没有细进度可看。进度是锦上添花，不许它挡住出图。
 */
function wsOpen(target, clientId, onText, onBinary) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(`${String(target).replace(/^http/, 'ws')}/ws`);
    } catch {
      return resolve(null);
    }
    u.searchParams.set('clientId', clientId);
    const sock = net.connect({ host: u.hostname, port: Number(u.port || 80) });
    let settled = false;
    let buf = Buffer.alloc(0);
    let handshaked = false;
    let frag = null;
    let fragOp = 0;

    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const giveUp = () => {
      try {
        sock.destroy();
      } catch {
        /* 已经断了 */
      }
      done(null);
    };
    const timer = setTimeout(giveUp, 3_000);
    sock.setNoDelay(true);
    sock.on('error', giveUp);
    sock.on('close', () => done(null));
    sock.on('connect', () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n`
        + `Host: ${u.host}\r\n`
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n`
        + 'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaked) {
        const at = buf.indexOf('\r\n\r\n');
        if (at < 0) return; // 头还没收全
        const head = buf.slice(0, at).toString('latin1');
        buf = buf.slice(at + 4);
        if (!/^HTTP\/1\.1 101/.test(head)) return giveUp();
        handshaked = true;
        done(sock);
      }
      // 一帧一帧往下取；不够一帧就等下一次 data
      for (;;) {
        if (buf.length < 2) return;
        const fin = (buf[0] & 0x80) !== 0;
        const op = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < off + 2) return;
          len = buf.readUInt16BE(off);
          off += 2;
        } else if (len === 127) {
          if (buf.length < off + 8) return;
          const big = buf.readBigUInt64BE(off);
          // 预览帧撑死几百 KB。比这大就是出错了 —— 别把内存交给对面
          if (big > BigInt(8 * 1024 * 1024)) return giveUp();
          len = Number(big);
          off += 8;
        }
        let mask = null;
        if (masked) {
          if (buf.length < off + 4) return;
          mask = buf.slice(off, off + 4);
          off += 4;
        }
        if (buf.length < off + len) return;
        let payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (mask) {
          const copy = Buffer.from(payload);
          for (let i = 0; i < copy.length; i += 1) copy[i] ^= mask[i % 4];
          payload = copy;
        }

        if (op === 0x8) {
          try {
            sock.destroy();
          } catch {
            /* 已经断了 */
          }
          return;
        }
        if (op === 0x9) {
          // ping 得回 pong，不然对面会当我们死了（掩码位给上、键全 0 就行）
          try {
            sock.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0]));
          } catch {
            /* 写不进去就算了 */
          }
          continue;
        }
        if (op === 0xa) continue; // pong
        if (op === 0x1 || op === 0x2) {
          frag = payload;
          fragOp = op;
        } else if (op === 0x0 && frag) {
          frag = Buffer.concat([frag, payload]);
        } else {
          continue; // 不认识的东西（压缩帧之类）直接丢
        }
        if (!fin) continue; // 还有续帧
        const whole = frag;
        frag = null;
        try {
          if (fragOp === 0x1) onText(whole.toString('utf8'));
          else onBinary(whole);
        } catch {
          /* 一帧读不懂不该把整场进度搞没 */
        }
      }
    });
  });
}

/** 二进制预览帧里，图片本体从哪开始：找 PNG 签名，或者 JPEG 的 SOI */
function imageStart(buf) {
  const png = buf.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (png >= 0) return png;
  return buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
}

/** 第一个 output 类的图（预览图不算） */
function firstImage(outputs) {
  if (!isRecord(outputs)) return null;
  for (const node of Object.values(outputs)) {
    const list = isRecord(node) && Array.isArray(node.images) ? node.images : [];
    for (const item of list) {
      if (!isRecord(item) || typeof item.filename !== 'string' || !item.filename) continue;
      const img = {
        filename: item.filename,
        subfolder: typeof item.subfolder === 'string' ? item.subfolder : '',
        type: typeof item.type === 'string' ? item.type : 'output',
      };
      if (img.type === 'output') return img;
    }
  }
  return null;
}

module.exports = {
  params: PARAMS,
  name: 'comfyui',
  description: t('连 ComfyUI：看队列与模型、管命名工作流、拿提示词出图并把图存回工作区'),
  panel: {
    kind: 'comfyui',
    label: t('ComfyUI 管理器'),
    title: t('ComfyUI 管理器'),
    hint: t('工作流接线查看、改名与描述；模型清单与风格描述'),
    body: 'messages',
  },

  setup(api) {
    const root = () => api.workspace;
    const cfg = () => {
      const t = Number(api.param('timeout'));
      const b = Number(api.param('boot'));
      const e = Number(api.param('see'));
      const s = (k) => String(api.param(k) || '').trim();
      return {
        url: origin(api.param('url')),
        // 要不要让 ComfyUI 推过程预览（默认开）—— 关掉就只有进度条，没有那张半成品
        preview: api.param('preview') !== false,
        timeout: Number.isFinite(t) && t >= 10 ? Math.min(3600, t) : PARAMS.timeout.default,
        // 出图后附给模型"看一眼"的长边像素（0 = 不看，见 seeFile）
        see: Number.isFinite(e) && e >= 0 ? Math.min(1536, Math.round(e)) : PARAMS.see.default,
        out: String(api.param('out') || PARAMS.out.default),
        start: s('start'),
        stop: s('stop'),
        desktop: s('desktop'),
        python: s('python'),
        main: s('main'),
        base: s('base'),
        frontend: s('frontend'),
        extra: s('extra'),
        boot: Number.isFinite(b) && b >= 10 ? Math.min(1800, b) : PARAMS.boot.default,
      };
    };

    /** 有没有可能把它起起来：命令、桌面版、或者本机三件套齐全 —— 缺一个都算没有 */
    const canStart = () => {
      const c = cfg();
      return !!(c.start || c.desktop || (c.python && c.main && c.base));
    };

    /** 连不上时顺手提一句"能起"—— 但别把没配的东西说得像配了 */
    const launchHint = () =>
      canStart()
        ? ' 它现在没开着的话，comfyui_launch 能把它起起来。'
        : ' 想让它能被起起来：本机填 python + main.py + base 目录（桌面版就填可执行文件），'
          + '远程在「启动命令」里填一条 ssh。';

    const wfDir = () => api.dataPath('.ensoul/comfyui/workflows');
    const wfFile = (name) => path.join(wfDir(), `${name}.json`);
    const outDir = () => inside(root(), cfg().out);

    /**
     * 对话里那一块"进行中"的容器（在干什么、跑到哪一步、过程预览图）——
     * 界面是核心画的，插件只说该显示什么（核心的 api.live，见 src/main/plugins.ts）。
     *
     * 三处都判空：没重启过的老核心里没有 api.live，而"界面没跟上"绝不该让出图失败。
     * 也不做节流：ComfyUI 的采样进度本来就一拍一条，多余的更新只是把同一个 key 覆盖掉。
     */
    // key 按"这一次出图"给：并行跑的几张各占一行、各推各的预览，
    // 谁先跑完只收自己那一行（共用一个 key 时，先跑完的会把别人的进度一起收掉）。
    const say = {
      show(ctx, patch, key) {
        const id = ctx && ctx.panelId;
        if (!id || !api.live || typeof api.live.show !== 'function') return;
        try {
          api.live.show(id, { key: key || 'comfyui', label: t('ComfyUI 出图'), ...patch });
        } catch {
          /* 界面这一头出事不影响出图 */
        }
      },
      hide(ctx, key) {
        const id = ctx && ctx.panelId;
        if (!id || !api.live || typeof api.live.hide !== 'function') return;
        try {
          api.live.hide(id, key || 'comfyui');
        } catch {
          /* 同上 */
        }
      },
      image(ctx, file) {
        const id = ctx && ctx.panelId;
        if (!id || !api.live || typeof api.live.image !== 'function') return;
        try {
          api.live.image(id, file);
        } catch {
          /* 同上 */
        }
      },
    };
    /** 预览根目录（每次开跑时整个扫一遍，清掉上几轮的残留帧和 see 小图） */
    const previewRoot = () => api.dataPath('.ensoul/comfyui/preview');
    /** 这一次跑的预览帧落在哪儿 —— 每次跑一个自己的子目录（最多留两张），
        并行跑几张就几个目录：互相不覆盖，谁跑完只扫自己那摊 */
    const previewDir = (slot) => path.join(previewRoot(), slot || 'x');

    /**
     * 出图后"自己看一眼"：把成品按长边缩到 `see` 那么大、存成一张 jpg，交给核心附回给模型
     * （工具结果里写一行 `[[see: 路径]]`，核心那边是 chat-core 的 takeSeePaths）。
     *
     * 用 Electron 自带的 nativeImage —— 插件跑在主进程里（plugins.ts 用真的 require 加载），
     * 直接就能用，不必为这件事装图形库（这个项目一个图片处理依赖都没有）。
     *
     * 拿不到就**干脆不看**，绝不把原图塞回去：一张 1MB 的 PNG 转 base64 是几十万字符，
     * 那比不看糟糕得多 —— 这一点上核心和插件是同一条线。
     */
    function seeFile(src, edge, dir) {
      if (!(edge > 0)) return '';
      try {
        const { nativeImage } = require('electron');
        if (!nativeImage || typeof nativeImage.createFromPath !== 'function') return '';
        const img = nativeImage.createFromPath(src);
        if (img.isEmpty()) return '';
        const size = img.getSize();
        const long = Math.max(size.width || 0, size.height || 0);
        if (!long) return '';
        // 只给 width，Electron 自己按比例缩 —— 长边就是它
        const small = long > edge
          ? img.resize({ width: Math.max(1, Math.round((size.width * edge) / long)), quality: 'good' })
          : img;
        const buf = small.toJPEG(80);
        if (!buf || !buf.length) return '';
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `see-${Date.now().toString(36)}.jpg`);
        fs.writeFileSync(file, buf);
        return file;
      } catch {
        return '';
      }
    }

    function safeName(raw) {
      const s = String(raw || '').trim();
      if (!s) throw new Error('得给个工作流名字');
      if (!/^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5 .-]{0,59}$/.test(s)) {
        throw new Error('名字只能是中英文、数字、空格、点、下划线、短横线，最多 60 字');
      }
      return s;
    }

    function listWorkflows() {
      const dir = wfDir();
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.json'))
        .map((f) => {
          const abs = path.join(dir, f);
          let note = '';
          try {
            const parsed = parseWorkflow(fs.readFileSync(abs, 'utf8'), f);
            const text = JSON.stringify(parsed);
            const hasPrompt = text.includes(PROMPT_PH) || text.includes(LEGACY.prompt);
            const hasImage = text.includes(IMAGE_PH) || text.includes(LEGACY.image);
            note = [hasPrompt ? t('文生图') : t('（没写 {p}）', { p: PROMPT_PH }), hasImage ? t('图生图') : ''].filter(Boolean).join(' / ');
          } catch {
            note = t('（这份 JSON 读不了）');
          }
          const st = fs.statSync(abs);
          return { name: f.replace(/\.json$/i, ''), note, size: st.size, at: st.mtimeMs };
        })
        .sort((a, b) => b.at - a.at);
    }

    /** 提交 → 等 → 取图。等待期间只轮询，不占别的资源 */
    async function runWorkflow(target, workflow, prompt, seed, imagePath, ctx, slot, key, set) {
      const clientId = `ensoul-${Math.random().toString(36).slice(2, 10)}`;

      // ── 进度：跟 ComfyUI 开一条 WS，它把采样进度和预览帧推过来 ──
      // 用**同一个 clientId** 连（提交时也带它），这样收到的是这次的活。
      // 连不上就算了（sock 为 null）：出图照跑，只是没有细进度可看。
      const startedAt = now();
      let sock = null;
      let pct = null;
      let mine = null; // 这次的 prompt_id；提交之后才填上，没填上时不好挑消息
      let lastFrame = 0;
      let frames = 0;
      const elapsed = () => `${Math.max(1, Math.round((now() - startedAt) / 1000))} 秒`;

      const onMsg = (text) => {
        let m;
        try {
          m = JSON.parse(text);
        } catch {
          return;
        }
        const d = (m && m.data) || {};
        // 同一台机器上可能还有别人在出图：认准自己的 prompt_id，别播报别人的进度
        if (mine && d.prompt_id && d.prompt_id !== mine) return;
        if (m.type === 'progress' && Number(d.max) > 0) {
          pct = Math.round((Number(d.value) / Number(d.max)) * 100);
          say.show(ctx, { percent: pct, note: t('采样 {v}/{m} · {e}', { v: d.value, m: d.max, e: elapsed() }) }, key);
        } else if (m.type === 'executing' && d.node) {
          say.show(ctx, { note: t('执行节点 {n} · {e}', { n: d.node, e: elapsed() }) }, key);
        } else if (m.type === 'status') {
          const q = d.status && d.status.exec_info && d.status.exec_info.queue_remaining;
          if (!mine && typeof q === 'number' && q > 0) {
            say.show(ctx, { note: t('排队中，前面还有 {q} 个 · {e}', { q, e: elapsed() }) }, key);
          }
        } else if (m.type === 'executing' && d.node === null) {
          close(); // 这张跑完了，进度到此为止（结果还是由 HTTP 那头取）
        } else if (m.type === 'execution_error' || m.type === 'execution_interrupted') {
          close();
        }
      };

      const onFrame = (buf) => {
        // 预览帧：4 字节事件类型 + 4 字节图片类型 + 图片本体（有的版本还夹一段元数据）。
        // 不照版本号猜偏移 —— 直接在帧里找 PNG / JPEG 的头，从那儿往后就是图。
        if (!ctx || now() - lastFrame < 400) return; // 4 fps 足够看出"在长"，再多是白推
        const at = imageStart(buf);
        if (at < 0) return; // 未编码的预览（RGBA 裸数据）不认，跳过
        lastFrame = now();
        frames += 1;
        try {
          fs.mkdirSync(previewDir(slot), { recursive: true });
          const file = path.join(previewDir(slot), `frame-${frames}${buf[at + 1] === 0x50 ? '.png' : '.jpg'}`);
          fs.writeFileSync(file, buf.slice(at));
          // 只留最近两帧：预览图高频刷新，避免无意义的磁盘堆积与资源泄漏。
          // 文件名一直往后走是必要的 —— 名字不变的话界面会拿缓存里的旧帧，看着像卡住了。
          const all = fs
            .readdirSync(previewDir(slot))
            .map((n) => ({ n, i: Number((n.match(/-(\d+)\./) || [])[1]) }))
            .filter((x) => Number.isFinite(x.i))
            .sort((a, b) => a.i - b.i);
          for (const old of all.slice(0, -2)) {
            try {
              fs.unlinkSync(path.join(previewDir(), old.n));
            } catch {
              /* 删不掉就留着 */
            }
          }
          say.show(ctx, {
            preview: file,
            percent: pct,
            note: t('采样中{p} · {e}', { p: pct === null ? '' : ` ${pct}%`, e: elapsed() }),
          }, key);
        } catch {
          /* 预览是锦上添花，出错不碍事 */
        }
      };

      function close() {
        if (!sock) return;
        try {
          sock.destroy();
        } catch {
          /* 已经断了 */
        }
        sock = null;
      }

      sock = await wsOpen(target, clientId, onMsg, onFrame);
      if (sock) {
        // 它自己收自己的尾：等待上限过了还没动静就断开，别挂在那儿
        const killer = setTimeout(close, (cfg().timeout + 15) * 1000);
        if (killer.unref) killer.unref();
      }
      if (ctx) {
        say.show(ctx, { percent: null, note: t('已提交，等它开始…') }, key);
      }

      let uploaded;
      if (imagePath) {
        const abs = inside(root(), imagePath);
        if (!fs.existsSync(abs)) throw new Error(`找不到这张图：${imagePath}`);
        const buf = fs.readFileSync(abs);
        if (buf.length > IMAGE_LIMIT) throw new Error('这张图超过 64 MB 了，先压一下');
        const ext = (path.extname(abs) || '.png').toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
          throw new Error(`ComfyUI 只收 PNG / JPEG / WebP，这张是 ${ext}`);
        }
        const form = new FormData();
        form.append('image', new Blob([buf]), `ensoul-${now().toString(36)}${ext}`);
        const res = await http(`${target}/upload/image`, {
          method: 'POST',
          headers: { accept: 'application/json' },
          body: form,
        });
        const text = (await body(res, JSON_LIMIT)).toString('utf8');
        if (!res.ok) throw new Error(`上传源图失败（${res.status}）：${clip(text)}`);
        const payload = JSON.parse(text);
        if (!payload || typeof payload.name !== 'string' || !payload.name) {
          throw new Error(`上传源图没回文件名：${clip(text)}`);
        }
        uploaded = payload.subfolder ? `${payload.subfolder}/${payload.name}` : payload.name;
      }

      // set 是在 prepare **之后**打的：你显式给的字段是最终裁决，会盖过占位符替换的结果。
      const prepared = applySet(prepare(workflow, prompt, seed, uploaded), set);
      const accepted = await askJson(
        `${target}/prompt`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            prompt: prepared,
            client_id: clientId,
            // 过程预览：**得在这一次请求里点**（extra_data.preview_method）。
            // ComfyUI 默认 none —— 不点它，采样过程中一帧草稿都不推，
            // 对话里就只剩一条进度条（见 latent_preview.py / execution.py 的 set_preview_method）。
            ...(cfg().preview && ctx ? { extra_data: { preview_method: 'auto' } } : {}),
          }),
        },
        t('提交工作流'),
      );
      const promptId = accepted && accepted.prompt_id;
      if (typeof promptId !== 'string' || !promptId) {
        throw new Error(`ComfyUI 没回 prompt_id：${clip(JSON.stringify(accepted))}`);
      }

      mine = promptId; // 从现在起，只认这个 id 的进度
      const deadline = now() + cfg().timeout * 1000;
      for (;;) {
        const hist = await askJson(`${target}/history/${encodeURIComponent(promptId)}`, undefined, '查询结果');
        const entry = hist && hist[promptId];
        if (entry) {
          const st = isRecord(entry.status) ? entry.status : {};
          if (st.status_str === 'error') {
            throw new Error(`工作流跑挂了：${clip(JSON.stringify(st.messages || st))}`);
          }
          const img = firstImage(entry.outputs);
          if (img) {
            close(); // 图有了，进度这条线收掉
            return { promptId, img, waited: cfg().timeout * 1000 - (deadline - now()) };
          }
          if (st.completed === true) {
            throw new Error('工作流跑完了，但没输出图片 —— 检查结尾有没有 SaveImage 这类保存节点');
          }
        }
        if (now() > deadline) {
          close();
          throw new Error(
            t('等了 {s} 秒还没出图（prompt_id {p}，队列里可能还排着）。', { s: cfg().timeout, p: promptId })
            + t('可以让 comfyui_status 看看队列，或者去设置里把等待上限调大。'),
          );
        }
        await sleep(POLL_MS);
      }
    }

    api.addTool(
      {
        name: 'comfyui_status', kits: ['art'],
        description:
          t('看 ComfyUI 通不通：版本、显卡、队列里排了多少、正在跑哪张。')
          + 'action 还能顺手管理队列：interrupt 打断当前那张、clear 清空排队、cancel + prompt_id 撤掉某个排队任务。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['status', 'interrupt', 'clear', 'cancel'],
              description: t('status（默认）/ interrupt 打断 / clear 清空 / cancel 撤销指定任务'),
            },
            prompt_id: { type: 'string', description: 'action=cancel 时要撤的那个 prompt_id' },
            url: { type: 'string', description: '临时换一个 ComfyUI 地址' },
          },
          required: [],
        },
        level: 'write',
      },
      async (args) => {
        const target = origin((args && args.url) || cfg().url);
        const action = String((args && args.action) || 'status');
        try {
          if (action === 'interrupt') {
            const res = await http(`${target}/interrupt`, { method: 'POST' });
            if (!res.ok) throw new Error(`打断失败（${res.status}）：${clip((await body(res, 4096)).toString('utf8'))}`);
            return `已经让 ComfyUI 打断当前那张（${target}）。`;
          }
          if (action === 'clear') {
            const res = await http(`${target}/queue`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ clear: true }),
            });
            if (!res.ok) throw new Error(`清队列失败（${res.status}）`);
            return `已经清空 ${target} 的排队任务。`;
          }
          if (action === 'cancel') {
            const id = String((args && args.prompt_id) || '').trim();
            if (!id) return 'action=cancel 需要 prompt_id —— 先用 comfyui_status 看队列里那些 id。';
            const res = await http(`${target}/queue`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ delete: [id] }),
            });
            if (!res.ok) throw new Error(`撤单失败（${res.status}）`);
            return `撤掉了排队里的 ${id}。`;
          }

          const [stats, queue] = await Promise.all([
            askJson(`${target}/system_stats`, undefined, 'system_stats'),
            askJson(`${target}/queue`, undefined, 'queue'),
          ]);
          const sys = (stats && stats.system) || {};
          const devices = Array.isArray(stats && stats.devices) ? stats.devices : [];
          const running = Array.isArray(queue && queue.queue_running) ? queue.queue_running : [];
          const pending = Array.isArray(queue && queue.queue_pending) ? queue.queue_pending : [];
          const lines = [`ComfyUI ${target} 在跑。`];
          if (sys.comfyui_version) lines.push(`版本：${sys.comfyui_version}${sys.python_version ? `（Python ${sys.python_version}）` : ''}`);
          for (const d of devices) {
            lines.push(
              `${d.name || t('设备')}：显存 ${gb(d.vram_free)} / ${gb(d.vram_total)} 空闲${d.torch_vram_total ? `，torch 占用 ${gb(d.torch_vram_total)}` : ''}`,
            );
          }
          lines.push(`队列：正在跑 ${running.length} 个，排着 ${pending.length} 个`);
          for (const item of running.slice(0, 3)) lines.push(`  · 跑着 ${(item && item[1]) || '?'}`);
          for (const item of pending.slice(0, 5)) lines.push(`  · 排队 ${(item && item[1]) || '?'}`);
          return lines.join('\n');
        } catch (e) {
          return friendly(e, target, launchHint());
        }
      },
    );

    api.addTool(
      {
        name: 'comfyui_models', kits: ['art'],
        description:
          t('列出 ComfyUI 服务器上装了哪些模型（checkpoint / lora / vae / controlnet / upscale / clip / unet）。')
          + t('写提示词或改工作流之前先看一眼，别用服务器上没有的模型名。'),
        parameters: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['checkpoint', 'lora', 'vae', 'controlnet', 'upscale', 'clip', 'unet', 'all'],
              description: t('看哪一类（默认 checkpoint）；all = 都列一遍'),
            },
            filter: { type: 'string', description: '名字里含这个词的才列，例如 sd / flux / xl' },
            url: { type: 'string', description: '临时换一个 ComfyUI 地址' },
          },
          required: [],
        },
        level: 'read',
      },
      async (args) => {
        const target = origin((args && args.url) || cfg().url);
        const kind = String((args && args.kind) || 'checkpoint');
        const kinds = kind === 'all' ? Object.keys(NODES) : [kind];
        const filter = String((args && args.filter) || '').trim().toLowerCase();
        try {
          const blocks = [];
          for (const k of kinds) {
            const node = NODES[k];
            if (!node) return `不认识的 kind：${k}。可选：${Object.keys(NODES).join(' / ')} / all`;
            const info = await askJson(`${target}/object_info/${node}`, undefined, `object_info/${node}`);
            const req = info && info[node] && info[node].input && info[node].input.required;
            const field = req && Object.keys(req).find((f) => Array.isArray(req[f]) && Array.isArray(req[f][0]));
            const names = field ? req[field][0].map(String) : [];
            const shown = (filter ? names.filter((n) => n.toLowerCase().includes(filter)) : names).slice(0, MAX_NAMES);
            if (!shown.length) {
              blocks.push(`${k}（用 ${node} 问的）：${names.length ? `有 ${names.length} 个，但没有名字含「${filter}」的` : t('一个都没有')}`);
              continue;
            }
            blocks.push(`${k}（${shown.length}${names.length > shown.length ? ` / 共 ${names.length}` : ''} 个）：\n${shown.map((n) => `  · ${n}`).join('\n')}`);
          }
          return `${target}\n\n${blocks.join('\n\n')}`;
        } catch (e) {
          return friendly(e, target);
        }
      },
    );

    api.addTool(
      {
        name: 'comfyui_workflow', kits: ['art'],
        description:
          t('管命名工作流（存在应用资料目录 .ensoul/comfyui/workflows/，comfyui_run 就按名字找它们）。\n')
          + t('action=list 看有哪些；get 看某一份的 JSON；save 存一份（json 参数给 API 格式的 JSON 文本，')
          + t('在 ComfyUI 里用「工作流 → 导出（API）」拿到）；delete 删掉。'),
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'get', 'save', 'delete'], description: t('默认 list') },
            name: { type: 'string', description: t('工作流名字（get / save / delete 必填）') },
            json: { type: 'string', description: t('action=save 时的 API 格式工作流 JSON 文本') },
          },
          required: ['action'],
        },
        level: 'write',
      },
      (args) => {
        const action = String((args && args.action) || 'list');
        try {
          if (action === 'list') {
            const all = listWorkflows();
            if (!all.length) {
              return `还没有工作流。要加一份：在 ComfyUI 里把工作流「导出（API）」，把那段 JSON 用 comfyui_workflow action=save 存进来（文本输入里记得写 ${PROMPT_PH}，那是提示词入口）。`;
            }
            return `工作区里有 ${all.length} 份工作流（新的在前）：\n${all
              .map((w) => `  · ${w.name} —— ${w.note}，${Math.round(w.size / 1024)} KB`)
              .join('\n')}`;
          }
          const name = safeName(args && args.name);
          const abs = wfFile(name);
          if (action === 'get') {
            if (!fs.existsSync(abs)) return `没有这份工作流：${name}`;
            const text = fs.readFileSync(abs, 'utf8');
            return `${rel(root(), abs)}\n\n${text.length > 12_000 ? `${text.slice(0, 12_000)}\n……（太长，截了）` : text}`;
          }
          if (action === 'save') {
            const parsed = parseWorkflow(args && args.json, 'json');
            const text = JSON.stringify(parsed, null, 2);
            fs.mkdirSync(wfDir(), { recursive: true });
            const existed = fs.existsSync(abs);
            fs.writeFileSync(abs, text, 'utf8');
            const bytes = Buffer.byteLength(text, 'utf8');
            const hasPrompt = text.includes(PROMPT_PH);
            return (
              `${existed ? '已覆盖' : '已保存'}：${rel(root(), abs)}（${parsed && Object.keys(parsed).length} 个节点，${Math.round(bytes / 1024)} KB）\n`
              + (hasPrompt
                ? `跑它：comfyui_run workflow=${name} prompt="……"`
                : `注意：这份 JSON 里没有 ${PROMPT_PH}，comfyui_run 会拒收 —— 想让它能吃提示词，就在文本节点里写上 ${PROMPT_PH}。`)
            );
          }
          if (action === 'delete') {
            if (!fs.existsSync(abs)) return `没有这份工作流：${name}`;
            fs.unlinkSync(abs);
            return `删掉了工作流 ${name}。`;
          }
          return t('action 只能是 list / get / save / delete。');
        } catch (e) {
          return `没成：${(e && e.message) || e}`;
        }
      },
    );

    api.addTool(
      {
        name: 'comfyui_run', kits: ['art'],
        description:
          t('用一份工作流出图：提交给 ComfyUI，等它跑完，把输出图下载到工作区（默认 comfyui/out/），返回本地路径。')
          + t('工作流里要有 ${PROMPT_PH} 作为提示词入口；图生图的工作流要在 LoadImage 的 image 字段写 ${IMAGE_PH}，再传 image 参数。')
          + t('想动别的字段（步数 / 尺寸 / 模型 / CFG / 采样器……）不必整份 JSON 重传：变更项塞进 set，只给改的那几处，其余原样、不落盘。')
          + t('等待上限默认 300 秒（可在插件参数里改）—— 会一直占着这一轮，急的话先 comfyui_status 看看队列。')
          + t('硬规矩：图的存在只认本工具的成功返回 —— 这一轮没拿到返回，就不许在回复里说"出了/发了/第 N 张"，不许报 seed、路径、张数，哪怕格式再像真的。'),
        parameters: {
          type: 'object',
          properties: {
            workflow: { type: 'string', description: t('工作流名字，或者直接给一段 API 格式的 JSON（以 { 开头）') },
            prompt: { type: 'string', description: t('这次画什么（英文通常效果更好）') },
            image: { type: 'string', description: `图生图的源图：工作区里的图片路径（工作流里要有 ${IMAGE_PH}）` },
            seed: { type: 'number', description: t('随机种子；不给就随机一个（返回里会告诉你这次用的哪个，好复现）') },
            set: {
              type: 'object',
              description: t('对这份工作流的增量修改，只写有变更的字段：键是路径（节点id.inputs.字段），值是新值。')
                + t('例：{"6.inputs.steps": 30}；数组下标也行：{"7.inputs.loras.0.strength": 0.8}。')
                + t('节点 id 用 comfyui_workflow action=get 看。只活在本次提交，不写回原工作流；换源图用 image 参数，别用 set。'),
            },
            url: { type: 'string', description: t('临时换一个 ComfyUI 地址') },
          },
          required: ['workflow', 'prompt'],
        },
        level: 'write',
      },
      runDraw,
    );

    /**
     * 出图的正身 —— 工具 comfyui_run 和斜杠命令 /draw 共用这一个 handler：
     * 出图逻辑只有一份，斜杠和工具拿到的结果一字不差。
     */
    async function runDraw(args, ctx) {
        const target = origin((args && args.url) || cfg().url);
        // 这一次跑自己占一个进度 key + 一个预览子目录：并行跑几张时各行其是，
        // 谁跑完只收自己那行、只扫自己那摊（共用一个 key 时先跑完的会把别人连带收掉）
        const slot = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const key = `comfyui-${slot}`;
        try {
          const raw = String((args && args.workflow) || '').trim();
          if (!raw) return t('workflow 得给：工作区里工作流的名字，或者一段 API 格式 JSON。');
          const prompt = String((args && args.prompt) || '').trim();
          if (!prompt) return t('prompt 得给：这次要画什么。');

          let workflow;
          let label;
          if (raw.startsWith('{')) {
            workflow = parseWorkflow(raw, t('内联 JSON'));
            label = t('（内联 JSON）');
          } else {
            const name = safeName(raw);
            const abs = wfFile(name);
            if (!fs.existsSync(abs)) {
              const all = listWorkflows().map((w) => w.name);
              return `没找到工作流 ${name}。${all.length ? `现在有：${all.join('、')}` : '工作区里一份都没有 —— 先用 comfyui_workflow save 存一份。'}`;
            }
            workflow = parseWorkflow(fs.readFileSync(abs, 'utf8'), name);
            label = name;
          }

          const seed = seedOf(args && args.seed);
          const started = now();
          // 上一轮留下的预览帧和 see 小图都没用了，整个扫干净（新一轮的 see 要到下一轮组装时才被读走）
          try {
            fs.rmSync(previewRoot(), { recursive: true, force: true });
          } catch {
            /* 删不掉不碍事 */
          }
          // 对话里先摆出那块容器：出图要十几秒到几分钟，这期间用户要看得见它在动
          say.show(ctx, { percent: null, note: t('正在提交…') }, key);
          const result = await runWorkflow(
            target,
            workflow,
            prompt,
            seed,
            String((args && args.image) || '').trim() || undefined,
            ctx,
            slot,
            key,
            isRecord(args && args.set) ? args.set : undefined,
          );

          const view = new URL(`${target}/view`);
          view.searchParams.set('filename', result.img.filename);
          if (result.img.subfolder) view.searchParams.set('subfolder', result.img.subfolder);
          view.searchParams.set('type', result.img.type || 'output');
          const res = await http(view.toString());
          if (!res.ok) throw new Error(`取图失败（${res.status}）：${clip((await body(res, 4096)).toString('utf8'))}`);
          const buf = await body(res, IMAGE_LIMIT);

          const dir = outDir();
          fs.mkdirSync(dir, { recursive: true });
          const ext = (path.extname(result.img.filename) || '.png').toLowerCase();
          const local = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${result.img.filename.replace(ext, '')}${ext}`);
          fs.writeFileSync(local, buf);
          // 图落盘了：直接送进对话（核心把它挂在这一轮的回答上），容器收工。
          // 顺带把预览帧扫掉 —— 真正的图已经有了，那些半成品没必要留着。
          // 进队列横排里等着：整轮跑完才随回复一起发出来，不生成一张蹦一张。
          // 收掉的只是**这一次**的进度行；预览也只扫自己这摊，别碰并行还在跑的。
          say.image(ctx, local);
          say.hide(ctx, key);
          try {
            fs.rmSync(previewDir(slot), { recursive: true, force: true });
          } catch {
            /* 删不掉不碍事 */
          }

          // 顺手压一张小图附回去给模型看（参数 see = 长边像素，0 = 不看）。
          // 放在扫预览帧**之后**：那张小图就住在预览目录里，别刚写完又被扫掉。
          const edge = cfg().see;
          const small = seeFile(local, edge, previewDir(slot));
          const seeLine = small
            ? `[[see: ${small}]]\n`
              + t('上面那行是给你的：这张图你**看得到**（长边 ${edge} px 的小图）。看一眼再说话 —— ')
              + t('崩坏／糊／空白／不是要的东西，就自己改提示词或换 seed 重画（最多重画两次）；没问题就别折腾。\n')
            : edge > 0
              ? '（参数 see 开着，但这次没能把图附给你看：压图不可用 —— 别假装看过它。）\n'
              : '';

          return (
            t('出图完成（{s} 秒，seed {seed}）\n', { s: Math.round((now() - started) / 1000), seed })
            + t('工作流：${label}\n')
            + t('本地文件：${rel(root(), local)}（${Math.round(buf.length / 1024)} KB）\n')
            + t('图已经直接发进对话里了（用户能看见，不用你再贴路径）。\n')
            + seeLine
            + `远端：${result.img.filename}${result.img.subfolder ? `（${result.img.subfolder}）` : ''}，prompt_id ${result.promptId}`
          );
        } catch (e) {
          // 没成：收掉**这一次**的进度行，别让它一直转（图本来也没出）
          say.hide(ctx, key);
          return friendly(e, target);
        }
    }

    /**
     * 斜杠命令 /draw —— 输入框里敲、主进程直接执行，不经模型：
     *   /draw 一只戴围巾的猫          → 用默认工作流（t2i-default，或仅有的那份）
     *   /draw t2i-default 一只猫      → 第一个词认得工作流名就用它，剩下整段是提示词
     * 返回的就是 runDraw 的真实返回 —— 出没出图、seed 是多少，以这里为准。
     */
    api.addCommand(
      { id: 'draw', label: t('画一张'), hint: t('/draw [工作流] 提示词 —— 直接出图，不经模型') },
      (argText, ctx) => {
        const arg = String(argText || '').trim();
        if (!arg) return t('命令没有执行：/draw 后面要写画什么，例如 /draw 一只戴围巾的猫。');
        const names = listWorkflows().map((w) => w.name);
        const first = arg.split(/\s+/)[0];
        const named = names.includes(first);
        const prompt = named ? arg.slice(first.length).trim() : arg;
        if (!prompt) return t('命令没有执行：/draw 后面要写画什么。');
        if (!names.length) return t('命令没有执行：工作区里一份工作流都没有 —— 先用 comfyui_workflow save 存一份。');
        const workflow = named ? first : names.includes('t2i-default') ? 't2i-default' : names[0];
        return runDraw({ workflow, prompt }, ctx);
      },
    );

    /**
     * 等它应声 / 等它没声 —— 都是轻接口轮询，不占别的资源。
     * 盯着 proc 是为了"它退了就别再等"：崩掉的进程不会因为多等几分钟就应声。
     * alt 只有"等它应声"时才给：应声在姊妹端口上就返回那个地址（字符串），
     * 别让人白等满 boot 秒才发现"它其实起来了"。
     */
    async function waitFor(target, seconds, want, proc, alt) {
      const deadline = now() + seconds * 1000;
      let round = 0;
      for (;;) {
        if ((await alive(target)) === want) return true;
        if (proc && proc.code !== null) return false;
        // 姊妹端口要等到第二轮才信：detached 进程的 exit 事件是异步送到的，
        // 头一轮它可能已经死了、只是还没报上来 —— 那会儿去看别的端口，
        // 就会把"别的实例在跑"错报成"它起来了"（拿一个立刻退出的 exe 试出来的）
        if (alt && want === true && round > 0 && (await alive(alt))) return alt;
        if (now() > deadline) return false;
        await sleep(POLL_MS);
        round++;
      }
    }

    // ── 归属记录：这会儿跑着的实例是谁起的 —— 关停、闲置回收都认它 ────────
    const instPath = () => api.dataPath('.ensoul/comfyui/instance.json');
    const readInst = () => {
      try {
        const o = JSON.parse(fs.readFileSync(instPath(), 'utf8'));
        return o && Number(o.pid) > 0 ? o : null;
      } catch { return null; }
    };
    const writeInst = (rec) => {
      try {
        fs.mkdirSync(path.dirname(instPath()), { recursive: true });
        fs.writeFileSync(instPath(), JSON.stringify(rec));
      } catch { /* 记不上不影响出图，只是关停时少一条依据 */ }
    };
    const clearInst = () => { try { fs.unlinkSync(instPath()); } catch { /* 没有就算了 */ } };

    /** pid 还在不在（win32 顺带核对映像名 —— pid 会被系统复用，裸 pid 会误杀别人） */
    function pidAlive(pid, image) {
      const p = Number(pid);
      if (!p || p <= 0) return false;
      if (process.platform === 'win32') {
        try {
          const r = spawnSync('tasklist', ['/FI', `PID eq ${p}`], { encoding: 'utf8', windowsHide: true });
          const out = String((r && r.stdout) || '');
          if (!out.includes(String(p))) return false;
          if (image) {
            return out.split(/\r?\n/)
              .filter((l) => l.includes(String(p)))
              .some((l) => l.toLowerCase().includes(String(image).toLowerCase()));
          }
          return true;
        } catch { return false; }
      }
      try { process.kill(p, 0); return true; } catch { return false; }
    }

    /** 收掉我们起的那棵进程树：win32 用 taskkill /T（连子进程），其它平台杀进程组 */
    function killPid(pid) {
      const p = Number(pid);
      if (!p) return false;
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(p), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
        } else {
          try { process.kill(-p, 'SIGTERM'); } catch { process.kill(p, 'SIGTERM'); }
        }
        return true;
      } catch { return false; }
    }

    /**
     * 关停链 —— 状态条的「关闭」、comfyui_launch stop、闲置回收，都走这一条：
     *   ① 配了「关闭命令」→ 跑它（远程 ssh 靠这条）；
     *   ② 有归属记录且进程还活着 → 按 pid 收进程树（映像名核对过，防 pid 复用误杀）；
     *   ③ 都没有 → 如实说关不了（Desktop 是你手动开的，去它窗口关）。
     */
    async function stopAct(target, conf, log, tail) {
      if (!(await alive(target))) { clearInst(); return `${target} 现在没在跑，不用关。`; }
      if (conf.stop) {
        spawnDetached(conf.stop, root(), log);
        const gone = await waitFor(target, 30, false);
        if (gone) clearInst();
        return gone
          ? `已经关掉 ${target}。`
          : `关闭命令跑了，但 ${target} 三十秒后还在应答 —— 可能没杀干净，或者那不是它。日志最后几行：\n${tail()}`;
      }
      const inst = readInst();
      if (inst && pidAlive(inst.pid, inst.name)) {
        killPid(inst.pid);
        const gone = await waitFor(target, 30, false);
        if (gone) {
          clearInst();
          return `已经收掉 ${target}（pid ${inst.pid}，${inst.mode === 'desktop-exe' ? '桌面版（我们起的）' : '静默实例'}）。`;
        }
        return `pid ${inst.pid} 收了但 ${target} 还在应答 —— 可能是子进程顶着。日志最后几行：\n${tail()}`;
      }
      if (inst) clearInst(); // 记录过期了（进程早没了），顺手清掉
      return NO_STOP;
    }

    /**
     * 启动入口 —— 状态条的「启动」、comfyui_launch，都走这一条。
     * 三路按既定优先级：服务已在跑就直接用（Desktop 开着就走它的）→
     * Desktop 进程开着（冷启动中）等它应声、不撞端口 → 静默起 python（无窗口无控制台）→
     * python 那套参数缺了才回退拉 Desktop exe。
     */
    async function launchAct(args) {
      const target = origin((args && args.url) || cfg().url);
      const action = String((args && args.action) || 'start').toLowerCase();
      const conf = cfg();
      const log = launchLog(api);
      const tail = () => logTail(log) || t('（日志是空的）');
      const up = await alive(target);

      if (action === 'stop') return stopAct(target, conf, log, tail);
      if (action !== 'start' && action !== 'restart') {
        return `action 只认 start / stop / restart，收到的是 ${action}。`;
      }

      let lead = '';
      if (action === 'restart') {
        if (!up) lead = `（${target} 本来就没在跑）`;
        else {
          const stopped = await stopAct(target, conf, log, tail);
          if (await alive(target)) return `重启没成：${stopped}`;
          lead = t('（已先关掉旧的）');
        }
      } else if (up) {
        return `${target} 已经开着，不用再起（Desktop 在跑就直接用它的服务）。想重来一遍就说 restart。`;
      }

      // Desktop 进程开着、服务还没应声 —— 它自己冷启动中：只等它，绝不另起一份抢端口
      if (!conf.start && isLocal(target) && desktopInFlight(conf)) {
        const t0d = now();
        const hitd = await waitFor(target, conf.boot, true, null, altTarget(target));
        if (typeof hitd === 'string') {
          return `${lead}Comfy Desktop 在跑，它的服务应声在 ${hitd} —— 把插件参数里的「ComfyUI 地址」改成 ${hitd} 就能直接出图了。`;
        }
        if (hitd === true) {
          const inst0 = readInst();
          if (!inst0) writeInst({ pid: 0, name: conf.desktop ? path.win32.basename(conf.desktop) : '', mode: 'desktop', at: Date.now(), url: target });
          return `${lead}${target} 起来了（Comfy Desktop 已在跑，等了 ${Math.round((now() - t0d) / 1000)} 秒）。` + t('接着就能 comfyui_run 出图了。');
        }
        return `${lead}Comfy Desktop 的窗口开着，但等了 ${conf.boot} 秒它的服务还没应声 —— 可能卡在启动或已崩，去它窗口看一眼；`
          + t('要我们另起一份（静默 python），先把它的窗口关掉。') + `日志最后几行：\n${tail()}`;
      }

      let proc = null;
      let how = '';
      let mode = '';
      try {
        if (conf.start) {
          proc = spawnDetached(conf.start, root(), log);
          how = t('启动命令');
          mode = 'cmd';
        } else {
          if (!isLocal(target)) return REMOTE_START(target);
          const ready = launchReadiness(conf);
          if (!ready.ok) return NO_START(ready.missing);
          if (ready.silentOk) {
            // 静默起：windowsHide + CREATE_NO_WINDOW，无窗口无黑框；端口跟 url 参数走
            proc = spawnArgvDetached(launcherArgv(conf, portOf(target)), conf.base, log);
            how = `python main.py（${portOf(target)} 端口，静默）`;
            mode = 'silent';
          } else {
            // 回退：桌面版 exe —— 它自己开窗口、不听 --port，起完看它应声在哪个端口
            proc = spawnArgvDetached([conf.desktop], path.dirname(conf.desktop), log, false);
            how = t('桌面版');
            mode = 'desktop-exe';
          }
        }
      } catch (e) {
        return `没能把它起起来（${(e && e.message) || e}）。日志在 ${rel(root(), log)}。`;
      }

      const pid = proc ? proc.pid : 0;
      const t0 = now();
      const hit = await waitFor(target, conf.boot, true, proc, altTarget(target));
      if (hit !== true) {
        // 起来了，只是在姊妹端口上应声 —— 直接告诉它改成哪个地址
        if (typeof hit === 'string') {
          if (mode !== 'cmd') writeInst({ pid, name: mode === 'desktop-exe' && conf.desktop ? path.win32.basename(conf.desktop) : '', mode, at: Date.now(), url: hit });
          return `${lead}${how}起起来了，但它应声的是 ${hit}，不是参数里的 ${target}。`
            + t('（命令行版默认 8188，ComfyUI Desktop 默认 8000。）')
            + `把插件参数里的「ComfyUI 地址」改成 ${hit} 就能直接出图了。`;
        }
        // 它自己退了就别再等 —— 这不是"开得慢"，是它出错了（否则白等满 boot 秒）
        if (proc && proc.code !== null) {
          return `起不来：${how} 拉起来的进程立刻退了（pid ${pid}，退出码 ${proc.code}`
            + `${proc.err ? `，${proc.err}` : ''}）。`
            + `日志最后几行（${rel(root(), log)}）：\n${tail()}${launchDiagnosis(tail())}`;
        }
        return `起是起了（${how}，pid ${pid}），但等了 ${conf.boot} 秒 ${target} 还没应声。`
          + t('可能是模型还在加载、或者它自己崩了。')
          + `日志最后几行（${rel(root(), log)}）：\n${tail()}${PORT_HINT}`;
      }
      // 起来了 —— 记下归属（cmd 那条不记：远程进程收不着，关它靠 stop 命令）
      if (mode !== 'cmd') {
        writeInst({ pid, name: process.platform === 'win32' ? 'cmd.exe' : 'sh', mode, at: Date.now(), url: target });
      }
      return `${lead}${target} 起来了（${how}，pid ${pid}，等了 ${Math.round((now() - t0) / 1000)} 秒）。`
        + t('接着就能 comfyui_run 出图了。');
    }

    const SSH_EXAMPLE =
      '  ssh gpu@192.168.1.20 "cd ~/ComfyUI && nohup python3 main.py --listen 0.0.0.0 --port 8188 > ~/comfyui.log 2>&1 &"';
    const NO_START = (missing) =>
      (missing.length
        ? `起不了：本机这几项参数缺了、或者指向不存在的文件 ——\n${missing.map((m) => `  · ${m}`).join('\n')}\n`
        : '')
      + t('想让我能起它，二选一：\n')
      + '  ① 本机装法：插件参数里填「ComfyUI Desktop 可执行文件」（桌面版最省事），或者 python + main.py + base 目录；\n'
      + '  ② 远程 / 自定义：在「启动命令」里填一条完整命令，ssh 到别的机器也行，例如：\n'
      + SSH_EXAMPLE;
    const NO_STOP =
      t('这个实例没有归属记录（不是我们起的），参数里也没配「关闭命令」，我不能替你关它。')
      + t('想让我能关，在 stop 里填一条关闭命令，例如：\n')
      + '  ssh gpu@192.168.1.20 "pkill -f main.py"\n'
      + t('（本机我们起的不用配 —— 监视面板的「关闭」直接收；桌面版手动关它的窗口就行。）');
    const REMOTE_START = (target) =>
      `${target} 不在本机，本机那些参数起不了它 —— 在「启动命令」里填一条 ssh，例如：\n${SSH_EXAMPLE}`;

    api.addTool(
      {
        name: 'comfyui_launch', kits: ['art'],
        description:
          t('把 ComfyUI 起起来 / 关掉。启动与关闭的命令 / 参数都在插件参数里配好，模型不能临时传命令：')
          + t('本机可以填桌面版可执行文件，或者 python + main.py + base 目录（照桌面版 app 的 argv 拼，')
          + t('该带的前端、模型路径参数一起带上）；远程就在「启动命令」里填一条 ssh。')
          + t('start 先探头看是不是已经开着，没开才起，然后等它应声；stop 跑关闭命令；restart 先关再开。')
          + t('起不来（参数缺、命令没跑起来、等超时）会把缺的项、pid 和日志最后几行回给你。'),
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['start', 'stop', 'restart'],
              description: t('start = 起（默认）；stop = 关；restart = 先关再起'),
            },
            url: { type: 'string', description: t('临时换一个 ComfyUI 地址') },
          },
          required: [],
        },
        level: 'write',
      },
      async (args) => launchAct(args),
    );

    // ── 监视器：会话框顶上那一条状态位 —— 原生 UI 常驻槽位（插件交数据、核心画）──
    // 不是面板、不是组件：抬眼就在，点开下拉就地启动 / 关闭。钟在主进程（面板切走照跑）。
    let snap = { up: false, at: 0, busy: false, running: 0, pending: 0, url: '' };
    let lastBusy = 0; // 最后一次看到它有活干 —— 闲置回收的钟
    let tickTimer = null;
let mgrCmdTimer = null;
let mgrSnapTimer = null;

    async function tick() {
      const conf = cfg();
      const target = conf.url;
      const up = await alive(target);
      let running = 0;
      let pending = 0;
      if (up) {
        try {
          const q = await askJson(`${target}/queue`, undefined, '队列');
          running = q.queue_running ? q.queue_running.length : 0;
          pending = q.queue_pending ? q.queue_pending.length : 0;
        } catch { /* 队列问不到不影响连通性判断 */ }
      }
      snap = { up, at: Date.now(), busy: running + pending > 0, running, pending, url: target };
      if (snap.busy) lastBusy = Date.now();

      // 闲置自动回收：只收我们静默起的；队列有活绝不收；Desktop 自己开的永远不动
      const idleMin = Number(api.param('idle'));
      if (up && !snap.busy && idleMin > 0) {
        const inst = readInst();
        if (inst && inst.mode === 'silent') {
          const idleSince = Math.max(Number(inst.at) || 0, lastBusy);
          if (Date.now() - idleSince > idleMin * 60_000) {
            const log = launchLog(api);
            const msg = await stopAct(target, conf, log, () => logTail(log) || t('（日志是空的）'));
            api.log(`[ComfyUI] 闲置 ${idleMin} 分钟自动回收：${msg}`);
            snap = { ...snap, up: false, busy: false, running: 0, pending: 0 };
          }
        }
      }
    }
    tickTimer = setInterval(() => { tick().catch(() => { /* 心跳失败下一轮再试 */ }); }, 3000);
    if (tickTimer.unref) tickTimer.unref();
    tick().catch(() => {});
    // ── 管理器面板：命令队列（面板写、这里读，认 seq）与模型快照 ──
    const cmdFile = path.join(api.workspace, '.ensoul/state/comfyui.cmd.json');
    const snapFile = path.join(api.workspace, '.ensoul/state/comfyui-models.json');
    let lastSeq = 0;
    let refreshing = false;

    /** 模型清单快照：脸（渲染层）开不了 HTTP，靠这份文件看服务器上有什么 */
    const refreshModels = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const target = origin(cfg().url);
        const snap = { at: Date.now(), url: target, up: false, kinds: {} };
        try { snap.up = !!(await alive(target)); } catch { snap.up = false; }
        if (snap.up) {
          for (const k of ['checkpoint', 'lora', 'vae']) {
            try {
              const node = NODES[k];
              const info = await askJson(target + '/object_info/' + node, undefined, 'object_info/' + node);
              const req = info && info[node] && info[node].input && info[node].input.required;
              const field = req && Object.keys(req).find((f) => Array.isArray(req[f]) && Array.isArray(req[f][0]));
              snap.kinds[k] = field ? req[field][0].map(String) : [];
            } catch (e) { snap.kinds[k] = []; }
          }
        }
        try {
          fs.mkdirSync(path.dirname(snapFile), { recursive: true });
          fs.writeFileSync(snapFile, JSON.stringify(snap, null, 2), 'utf8');
        } catch (e) { api.log('[ComfyUI] 模型快照写入失败：' + ((e && e.message) || e)); }
      } finally { refreshing = false; }
    };

    /** 面板发来的命令：改工作流名 / 刷新模型快照 */
    const runMgrCmd = (c) => {
      const act = String((c && c.action) || '');
      if (act === 'rename') {
        const from = safeName(c.from);
        const to = safeName(c.to);
        if (from === to) return;
        const src = wfFile(from);
        const dst = wfFile(to);
        if (!fs.existsSync(src)) throw new Error('没有这个工作流：' + from);
        if (fs.existsSync(dst)) throw new Error('已经有叫 ' + to + ' 的了');
        fs.renameSync(src, dst);
        api.log('[ComfyUI] 工作流改名：' + from + ' → ' + to);
        return;
      }
      // 删掉一份工作流（真身文件在插件这边，脸只能发包）
      if (act === 'delete') {
        const name = safeName(c.name);
        const abs = wfFile(name);
        if (!fs.existsSync(abs)) throw new Error('没有这个工作流：' + name);
        fs.unlinkSync(abs);
        api.log('[ComfyUI] 工作流删除：' + name);
        return;
      }
      // 就地改参数：把 set 合并进真身文件（键是 节点id.inputs.字段，跟 comfyui_run 的 set 同形）
      if (act === 'patch') {
        const name = safeName(c.name);
        const abs = wfFile(name);
        if (!fs.existsSync(abs)) throw new Error('没有这个工作流：' + name);
        const doc = parseWorkflow(fs.readFileSync(abs, 'utf8'), name);
        const next = applySet(doc, c.set);
        fs.writeFileSync(abs, JSON.stringify(next, null, 2), 'utf8');
        api.log('[ComfyUI] 工作流改参数：' + name);
        return;
      }
      if (act === 'refresh_models') { refreshModels().catch(() => {}); }
    };

    const pullCmds = () => {
      let text = '';
      try {
        if (!fs.existsSync(cmdFile)) return;
        text = fs.readFileSync(cmdFile, 'utf8');
        fs.unlinkSync(cmdFile);
      } catch { return; }
      if (!text) return;
      let doc = null;
      try { doc = JSON.parse(text); } catch { return; }
      const seq = Number(doc && doc.seq) || 0;
      if (seq && seq <= lastSeq) return;
      lastSeq = seq;
      for (const c of Array.isArray(doc.cmds) ? doc.cmds : []) {
        try { runMgrCmd(c); } catch (e) { api.log('[ComfyUI] 面板命令失败：' + ((e && e.message) || e)); }
      }
    };

    mgrCmdTimer = setInterval(pullCmds, 400);
    if (mgrCmdTimer.unref) mgrCmdTimer.unref();
    mgrSnapTimer = setInterval(() => { refreshModels().catch(() => {}); }, 120000);
    if (mgrSnapTimer.unref) mgrSnapTimer.unref();
    refreshModels().catch(() => {});

    // ── 出图规则：面板在 .ensoul/comfyui/rules.json 里维护一张追加式规则表，
    //    这里每轮把它塞回对话里。规则独立于工作流文件 —— 工作流怎么改，
    //    新会话照样认这几条默认（画面尺寸、步数、用哪个模型……）。
    const rulesFile = () => path.join(root(), '.ensoul/comfyui/rules.json');
    const readRules = () => {
      try {
        const doc = JSON.parse(fs.readFileSync(rulesFile(), 'utf8'));
        const list = Array.isArray(doc && doc.rules) ? doc.rules : [];
        return list
          .map((r, i) => ({ no: Number(r && r.no) || i + 1, text: String((r && r.text) || '').trim() }))
          .filter((r) => r.text);
      } catch { return []; }
    };
    api.addPrompt(() => {
      const list = readRules();
      if (!list.length) return '';
      return [
        '【ComfyUI 出图规则】（用户在管理器面板里定的默认，出图时按它来）',
        ...list.map((r) => `  规则${r.no}：${r.text}`),
        '这些规则优先于工作流里的原值：用 comfyui_run 出图时，把对应的字段按规则覆盖（走 set 参数，不写回工作流文件）。',
      ].join('\n');
    }, { scope: ['comfyui'] });


    api.addStatusItem({
      id: 'comfyui',
      slot: 'head',
      text() {
        if (!snap.at) return 'ComfyUI …';
        if (!snap.up) return 'ComfyUI ○ 未连接';
        const q = snap.running + snap.pending;
        return q > 0 ? `ComfyUI 🟢 已连接（跑 ${snap.running} · 排 ${snap.pending}）` : 'ComfyUI 🟢 已连接';
      },
      title() {
        const inst = readInst();
        const lines = [`${snap.up ? '已连接' : '未连接'}：${snap.url}`];
        if (inst) {
          const src = inst.mode === 'silent' ? '静默实例（我们起的）'
            : inst.mode === 'desktop' ? 'Comfy Desktop'
            : inst.mode === 'desktop-exe' ? '桌面版（我们起的）' : '启动命令';
          lines.push(`来源：${src}` + (inst.pid ? `，pid ${inst.pid}` : ''));
          const idleMin = Number(api.param('idle'));
          if (inst.mode === 'silent' && snap.up && !snap.busy && idleMin > 0) {
            const left = Math.max(0, idleMin * 60_000 - (Date.now() - Math.max(Number(inst.at) || 0, lastBusy)));
            lines.push(`闲置 ${Math.max(1, Math.ceil(left / 60000))} 分钟后自动回收`);
          }
        } else if (snap.up) {
          lines.push('来源：不是我们起的（外部实例）');
        }
        if (snap.busy) lines.push(`队列：跑 ${snap.running} · 排 ${snap.pending}`);
        lines.push('点一下就地启动 / 关闭');
        return lines.join('\n');
      },
      menu() {
        return snap.up
          ? {
              title: 'ComfyUI',
              plugin: 'comfyui',
              section: 'comfyui',
              items: [
                { label: t('关闭'), desc: t('收掉后台实例（我们起的按归属收；Desktop 自己开的去它窗口关）'), action: 'stop', row: '' },
                { label: t('重启'), desc: t('先关再起'), action: 'restart', row: '' },
              ],
            }
          : {
              title: 'ComfyUI',
              plugin: 'comfyui',
              section: 'comfyui',
              items: [
                { label: t('启动'), desc: t('Desktop 在跑就用它的服务，没跑就静默起（无窗口）'), action: 'start', row: '' },
              ],
            };
      },
    });

    // 状态条下拉的回执口：核心只负责画和回传（plugin + section），动作在这儿执行
    api.addSettingsSection({
      id: 'comfyui',
      label: 'ComfyUI',
      hidden: true,
      hint: t('会话顶上状态条下拉的动作从这儿回执'),
      view: () => ({ rows: [] }),
      onAction: (actionId) => {
        const act = String(actionId || 'start');
        return Promise.resolve(launchAct({ action: act })).catch((e) => String((e && e.message) || e));
      },
    });

    api.log(
      t('ComfyUI 就绪（{u}，工作流 {w}，出图 {o}', { u: cfg().url, w: rel(root(), wfDir()), o: cfg().out })
      + `${canStart() ? '，可启动' : '，未配启动方式'}）`,
    );
  },

  /** 插件重载前收掉心跳，不然旧实例的定时器永远跑着 */
  dispose() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (mgrCmdTimer) { clearInterval(mgrCmdTimer); mgrCmdTimer = null; }
    if (mgrSnapTimer) { clearInterval(mgrSnapTimer); mgrSnapTimer = null; }
    touchUse = null;
  },
};

/** 显存数字是人看的，别丢一堆字节 */
function gb(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 GB';
  return `${Math.round((n / 1024 / 1024 / 1024) * 10) / 10} GB`;
}
