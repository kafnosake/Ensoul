/**
 * 联网能力 —— 网页内容抓取与聚合搜索服务（web_fetch / web_search）。
 *
 * 一个只会读本地文件的助手，遇到"这个库现在的 API 是什么样""这个报错到底什么意思"
 * 就只能靠记忆答，而记忆是会过时的。这两个工具把它接上真正的互联网。
 *
 *   web_fetch   抓一个网页/接口，把 HTML 剥成正文交给模型（不是把几千行标签灌进去）
 *   web_search  搜一个关键词，拿回标题 + 链接 + 摘要
 *
 * 搜索**不需要任何密钥**：默认按一张候选表挨个试（必应 → DuckDuckGo），谁先给出
 * 结果就用谁。为什么不只挂一个 —— 只挂 DuckDuckGo 的话，在够不着它的网络上搜索会
 * **直接废掉**：实测某台机器 DDG 全族超时，而 cn.bing 直连 0.2 秒就回。
 * 想换成自己的搜索服务，在应用数据根放一个 `.ensoul/state/web.json`：
 *
 *   { "searchUrl": "https://自己的搜索/api?q={query}&n={count}" }
 *
 * 配了它就只用它。返回什么就照什么读 —— RSS / JSON / 必应 HTML / DuckDuckGo HTML 四种形状都认。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const FETCH_MS = 25_000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_CHARS = 60_000;
/** 搜索单次要快：一个源不通就赶紧换下一个，别让人干等 */
const SEARCH_MS = 12_000;

/** 自检每个源的等待上限：反正已经全不通了，别让人再等一轮 */
const PROBE_MS = 6_000;

/**
 * 候选搜索源：谁先给出结果就用谁。
 * 顺序按"国内网络上最可能直接可用"排 —— 必应在前面，DuckDuckGo 兜底。
 * 只挂一个源的风险是实打实的：DDG 在够不着它的网络上全族超时，搜索就直接废了。
 */
const SEARCH_SOURCES = [
  { name: t('必应'), url: (q) => 'https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&format=rss' },
  { name: t('必应'), url: (q) => 'https://cn.bing.com/search?q=' + encodeURIComponent(q) },
  { name: 'DuckDuckGo', url: (q) => 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q) },
];

/** 去掉 CDATA / 标签 / 常见实体，留纯文本 */
function unesc(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&ensp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从一次搜索响应里提结果 —— 四种形状都认，认不出就回空表：
 *   JSON（自带搜索服务）/ RSS（必应 format=rss）/ 必应 HTML（li.b_algo）/ DuckDuckGo HTML
 * 每种都只取"标题 + 链接 + 摘要"三样。
 */
function parseHits(body, type, count) {
  const hits = [];
  const add = (title, url, snippet) => {
    if (hits.length >= count || !url) return;
    hits.push({ title: unesc(title), url: String(url).trim(), snippet: unesc(snippet) });
  };

  // 1) JSON —— 自带的搜索服务/接口
  if (/json/i.test(type) || /^\s*[{[]/.test(body)) {
    try {
      const j = JSON.parse(body);
      const list = j.results || j.items || j.data || [];
      for (const it of list.slice(0, count)) {
        add(it.title || it.name, it.url || it.link || it.href, it.snippet || it.description || it.text);
      }
      if (hits.length) return hits;
    } catch {
      /* 不是 JSON，往下走 */
    }
  }

  // 2) RSS / Atom —— 必应 /search?format=rss 走这条
  if (/<(rss|feed|channel)[\s>]/i.test(body)) {
    for (const m of body.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const b = m[1];
      add(
        (/<title>([\s\S]*?)<\/title>/.exec(b) || [])[1] || '',
        (/<link>([\s\S]*?)<\/link>/.exec(b) || [])[1] || '',
        (/<description>([\s\S]*?)<\/description>/.exec(b) || [])[1] || '',
      );
      if (hits.length >= count) break;
    }
    if (hits.length) return hits;
  }

  // 3) 必应 HTML
  if (/b_algo/.test(body)) {
    for (const m of body.matchAll(/<li class="b_algo"[\s\S]*?(?=<li class="b_algo"|<\/ol>|<\/main>|$)/g)) {
      const b = m[0];
      const h2 = (/<h2[^>]*>([\s\S]*?)<\/h2>/.exec(b) || [])[1] || '';
      if (!h2) continue;
      add(
        h2,
        (/<a[^>]+href="(https?:\/\/[^"]+)"/.exec(h2) || [])[1] || '',
        (/<div class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/.exec(b) || [])[1] ||
          (/<p[^>]*>([\s\S]*?)<\/p>/.exec(b) || [])[1] ||
          '',
      );
      if (hits.length >= count) break;
    }
    if (hits.length) return hits;
  }

  // 4) DuckDuckGo HTML（兜底：留着原来那套正则，能连上它时照旧好用）
  if (/result__a/.test(body)) {
    const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snip = [...body.matchAll(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => unesc(m[1]));
    let m;
    let i = 0;
    while ((m = re.exec(body)) && hits.length < count) {
      let href = m[1];
      const uddg = /[?&]uddg=([^&]+)/.exec(href);
      if (uddg) href = decodeURIComponent(uddg[1]);
      add(m[2], href, snip[i] || '');
      i += 1;
    }
  }

  return hits;
}

/**
 * 只许抓公网。
 *
 * 为什么这道闸不能省：网址是**模型给出来的**，而模型可能是被某个网页的内容带偏
 * 才给出这个网址的（提示注入）。放了环回和内网，一次诱导就能让它去捅本机
 * 或内网的服务（`http://127.0.0.1:3080/...`、云环境的元数据地址……）。
 * 所以这里按"字面量 + 明显的内网段"直接拒掉，不给它任何解释空间。
 */
function denyReason(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return t('这个网址没有主机名');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return t('这是本机/内网地址');
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return t('这是内网地址');
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 0 || a === 10) return t('这是本机/内网地址');
    if (a === 192 && b === 168) return t('这是内网地址');
    if (a === 172 && b >= 16 && b <= 31) return t('这是内网地址');
    if (a === 169 && b === 254) return t('这是链路本地地址');
    if (a >= 224) return '这不是一个可访问的主机地址';
  }
  return '';
}

/** 把 HTML 剥成能读的正文。不追求完美排版，只求"人能看懂、模型不用猜标签" */
function htmlToText(html) {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').trim();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n· ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

/**
 * 连通性自检 —— 搜索全线不通时跑一次，把"到底哪一段断了"摆出来。
 *
 * 每步只看"能不能连上、多久、返回几"，不解析内容：要的是**判断**，不是结果。
 * 带 Range 头只要前 1KB，省流量也省时间。
 */
async function probe(url, ms) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Range: 'bytes=0-1023' },
    });
    try {
      await res.arrayBuffer();
    } catch {
      /* 读不完不影响"可达"这个判断 */
    }
    return { ok: true, status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, err: (e && e.message) || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 代理配置：Node 的 fetch 不认系统代理，只认这几个环境变量 —— 顺手报出来 */
function proxyEnv() {
  const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  const hit = keys.map((k) => [k, process.env[k]]).filter((kv) => kv[1]);
  return hit.length ? hit.map((kv) => kv[0] + '=' + kv[1]).join('，') : t('（没配）');
}

/** 自检报告：候选源逐个探一遍 + 代理念一下，拼成人能读的几行 */
async function diagnose() {
  const lines = [t('联网自检：'), t('  · 代理环境变量：') + proxyEnv()];
  for (const src of SEARCH_SOURCES) {
    const r = await probe(src.url('ensoul'), PROBE_MS);
    lines.push(
      '  · ' +
        src.name +
        '：' +
        (r.ok ? t('可达 ') + r.status + '（' + r.ms + 'ms）' : t('连不上 —— ') + (r.err || t('超时')) + '（' + r.ms + 'ms）'),
    );
  }
  return lines.join('\n');
}

async function get(url, accept, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || FETCH_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: accept || 'text/html,application/json;q=0.9,*/*;q=0.8' },
    });
    const type = String(res.headers.get('content-type') || '');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error(`响应太大（${Math.round(buf.length / 1024)} KB），不抓了`);
    const body = buf.toString('utf8');
    return { ok: res.ok, status: res.status, url: res.url || url, type, body };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  name: 'web',
  description: t('联网：抓网页/接口正文（web_fetch）、搜关键词（web_search）'),

  setup(api) {
    const state = () => api.state.load({});

    api.addTool(
      {
        name: 'web_fetch', kits: ['copy'],
        description:
          '抓一个网址（网页或接口）并把正文取回来。HTML 会被剥成纯文本，JSON 会原样给你。'
          + '**不知道确切网址时先用 web_search**。抓长篇文档时先看返回的开头，需要更后面就再抓一次并调大 max_chars。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '完整的 http(s) 网址' },
            max_chars: { type: 'number', description: `最多返回多少字，默认 12000，上限 ${MAX_CHARS}` },
          },
          required: ['url'],
        },
        // 只是看，不改任何东西 —— 最低档就给它
        level: 'read',
      },
      async (args) => {
        const url = String((args && args.url) || '').trim();
        if (!/^https?:\/\//i.test(url)) return `web_fetch 需要一个完整的 http(s) 网址，收到的是：${url || t('（空）')}`;
        let host = '';
        try {
          host = new URL(url).hostname;
        } catch {
          return `这个网址读不出来：${url}`;
        }
        const bad = denyReason(host);
        if (bad) return `不抓 ${url}：${bad}。这个工具只连公网。`;
        const cap = Math.min(MAX_CHARS, Math.max(500, Number(args && args.max_chars) || 12_000));

        let r;
        try {
          r = await get(url);
        } catch (e) {
          return `抓不到 ${url}：${(e && e.message) || e}`;
        }
        if (!r.ok) return `${url} 返回 ${r.status}。${r.body.slice(0, 400)}`;

        if (/json/i.test(r.type)) {
          let pretty = r.body;
          try {
            pretty = JSON.stringify(JSON.parse(r.body), null, 2);
          } catch {
            /* 不是合法 JSON 就原样给 */
          }
          return `${url}（JSON，${pretty.length} 字符）\n\n\`\`\`json\n${pretty.slice(0, cap)}\n\`\`\``;
        }

        const { title, text } = htmlToText(r.body);
        const head = `${url}${title ? `\n标题：${title}` : ''}（正文 ${text.length} 字符）`;
        if (!text) return `${head}\n\n（这个页面没有可读正文，可能整页是脚本渲染的）`;
        return `${head}\n\n${text.slice(0, cap)}${text.length > cap ? `\n\n…（还有 ${text.length - cap} 字没显示，要的话调大 max_chars 再抓一次）` : ''}`;
      },
    );

    api.addTool(
      {
        name: 'web_search', kits: ['copy'],
        description:
          t('搜一个关键词，拿回标题 + 链接 + 摘要。**要查"现在的"东西就用它** —— 库的新写法、报错、版本变更。')
          + t('拿到链接后再用 web_fetch 读正文。默认不需要密钥。'),
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            count: { type: 'number', description: t('要几条结果，默认 6，上限 10') },
          },
          required: ['query'],
        },
        level: 'read',
      },
      async (args) => {
        const q = String((args && args.query) || '').trim();
        if (!q) return t('web_search 需要 query。');
        const count = Math.min(10, Math.max(1, Number(args && args.count) || 6));

        // 配了自定义源就先试它，再走候选表 —— 一个源挂掉不该让整个搜索废掉
        const custom = String(state().searchUrl || '').trim();
        const sources = [];
        if (custom.includes('{query}')) {
          sources.push({
            name: t('自定义源'),
            url: () => custom.replace('{query}', encodeURIComponent(q)).replace('{count}', String(count)),
          });
        }
        for (const src of SEARCH_SOURCES) sources.push({ name: src.name, url: () => src.url(q) });

        const tried = [];
        for (const src of sources) {
          let r;
          try {
            r = await get(
              src.url(),
              'text/html,application/rss+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
              SEARCH_MS,
            );
          } catch (e) {
            tried.push(src.name + '：' + ((e && e.message) || e));
            continue;
          }
          if (!r.ok) {
            tried.push(src.name + t('：返回 ') + r.status);
            continue;
          }
          const hits = parseHits(r.body, r.type, count);
          if (!hits.length) {
            tried.push(src.name + t('：没解析出结果（') + r.body.length + t(' 字符）'));
            continue;
          }
          return (
            '「' + q + t('」的搜索结果（') + hits.length + t(' 条，来源 ') + src.name + '）：\n\n' +
            hits
              .map((h, n) => (n + 1) + '. ' + (h.title || t('(无标题)')) + '\n   ' + h.url + (h.snippet ? '\n   ' + h.snippet.slice(0, 300) : ''))
              .join('\n\n')
          );
        }

        // 全线不通：当场探一遍，把断在哪一段摆出来 —— 别只丢一句"连不上"让人猜
        const diag = await diagnose();
        return (
          '「' + q + '」没搜到 —— 每个源的结果：\n' +
          tried.map((t) => '  · ' + t).join('\n') +
          '\n\n' + diag +
          '\n\n想换成自己的搜索服务，就在应用数据根建一个 .ensoul/state/web.json 写 {"searchUrl":"https://.../search?q={query}"}；' +
          t('或者把已知网址直接用 web_fetch 抓。')
        );
      },
    );

    api.log(t('联网就绪（搜索候选：必应 → DuckDuckGo，可用 .ensoul/state/web.json 换）'));
  },
};
