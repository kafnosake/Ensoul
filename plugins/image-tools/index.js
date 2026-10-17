/**
 * image-tools —— 给模型真正**动手改图**的能力。
 *
 * 为什么要有这一个插件：历史里这条链路全靠现写脚本 —— 裁一张方图、抠一次底色、
 * 拼一次图集，每次都要模型自己从零写一份 node 脚本（本机没装 ImageMagick），
 * 踩完 GBK 控制台、紫边、图集索引一堆坑才拿到结果。那些脚本每次都是同一件事，
 * 该有一个工具直接干。
 *
 * 两条实现路径，一条语义：
 *   主力 → sharp（本机 devDependency，格式全、质量高）
 *   兜底 → 自带的纯 node PNG 编解码（别人 clone 没装依赖时，PNG 的裁/缩/抠照样能干）
 * 走哪条不影响工具的参数和回执，模型不用知道底下换了谁。
 *
 * 所有工具都写文件、不改原图：源永远是只读的，产物落成新路径。
 */

const fs = require("fs");
const path = require("path");
const png = require("./png");
const adv = require("./advanced");

/** 换行用这个常量：插件源里一个反斜杠转义都不出现，行尾怎么改都不会坏 */
const NL = String.fromCharCode(10);

const EXTS = [".png", ".jpg", ".jpeg", ".webp"];

/** sharp 只在需要它的格式上要求存在；PNG 这一条路它不在也能走 */
let sharpMod;
let sharpTried = false;
function sharp() {
  if (!sharpTried) {
    sharpTried = true;
    try { sharpMod = require("sharp"); } catch (e) { sharpMod = null; }
  }
  return sharpMod;
}

function extOf(p) {
  return path.extname(String(p || "")).toLowerCase();
}

function isImg(p) {
  return EXTS.includes(extOf(p));
}

function rgb2hex(r, g, b) {
  const h = (n) => ("0" + Math.round(n).toString(16)).slice(-2);
  return "#" + h(r) + h(g) + h(b);
}

/** 认一个颜色：0x7f00ff / #7f00ff / 255,0,255 / [255,0,255] */
function parseColor(v) {
  if (v == null) return null;
  if (Array.isArray(v) && v.length >= 3) return [Number(v[0]), Number(v[1]), Number(v[2])];
  const s = String(v).trim();
  const hex = s.indexOf("#") === 0 ? s.slice(1) : s;
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16)];
  }
  const parts = s.split(",").map((x) => Number(x.trim()));
  if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) return parts.slice(0, 3);
  return null;
}

/** 读成 RGBA 原始像素。sharp 在就用它（什么格式都读），不在就只有纯净 PNG 能读 */
async function loadRGBA(abs) {
  const s = sharp();
  if (s) {
    try {
      const r = await s(abs).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { w: r.info.width, h: r.info.height, data: Buffer.from(r.data), via: "sharp" };
    } catch (e) {
      throw new Error("读不了这张图：" + (e && e.message ? e.message : e));
    }
  }
  if (extOf(abs) !== ".png") {
    throw new Error("这张不是 PNG，而本机没装 sharp —— 这条兜底路只认 PNG。装上依赖（npm i）或把源转成 PNG 再来。");
  }
  const raw = png.decode(fs.readFileSync(abs));
  if (raw.channels === 4) return { w: raw.w, h: raw.h, data: raw.data, via: "png" };
  const out = Buffer.alloc(raw.w * raw.h * 4);
  for (let i = 0, j = 0; i < raw.data.length; i += 3, j += 4) {
    out[j] = raw.data[i];
    out[j + 1] = raw.data[i + 1];
    out[j + 2] = raw.data[i + 2];
    out[j + 3] = 255;
  }
  return { w: raw.w, h: raw.h, data: out, via: "png" };
}

/** 写出去。PNG 用自带编码（一条稳路），别的格式要 sharp；JPEG 没有 alpha，会明说 */
async function saveRGBA(abs, w, h, data) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const ext = extOf(abs);
  if (ext === ".png") {
    fs.writeFileSync(abs, png.encode(w, h, data));
    return { note: "" };
  }
  const s = sharp();
  if (!s) throw new Error("要写成 " + ext + " 得装 sharp；PNG 不需要。");
  let pipe = s(Buffer.from(data), { raw: { width: w, height: h, channels: 4 } });
  if (ext === ".jpg" || ext === ".jpeg") pipe = pipe.flatten({ background: "#000000" }).jpeg({ quality: 92 });
  else if (ext === ".webp") pipe = pipe.webp({ quality: 92 });
  else throw new Error("不认的输出格式 " + ext + "，认 .png / .jpg / .webp。");
  await pipe.toFile(abs);
  return { note: ext === ".jpg" || ext === ".jpeg" ? "（JPEG 没有透明通道，透明处按黑底压平了 —— 要透明请输出 .png）" : "" };
}

/** 取一块矩形。坐标先夹进画里，超出的部分按边缘像素延展，不报错也不留黑边 */
function crop(rgba, w, h, x, y, cw, ch) {
  const out = Buffer.alloc(cw * ch * 4);
  for (let yy = 0; yy < ch; yy++) {
    const sy = Math.min(h - 1, Math.max(0, y + yy));
    for (let xx = 0; xx < cw; xx++) {
      const sx = Math.min(w - 1, Math.max(0, x + xx));
      const si = (sy * w + sx) * 4;
      const di = (yy * cw + xx) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return out;
}

/**
 * 重采样。缩小时按面积平均（不会漏掉细节、不会闪噪），放大时双线性。
 * 关键一条：**先乘上 alpha 再平均**（预乘），否则透明边的颜色会把边缘拖出一圈黑 ——
 * 抠完底的图再缩放最容易出这个。
 */
function resample(rgba, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const sx = sw / dw;
  const sy = sh / dh;
  const shrink = sx > 1 || sy > 1;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      if (shrink) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.max(x0 + 1, Math.min(sw, Math.ceil((x + 1) * sx)));
        const y0 = Math.floor(y * sy);
        const y1 = Math.max(y0 + 1, Math.min(sh, Math.ceil((y + 1) * sy)));
        let n = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            const i = (yy * sw + xx) * 4;
            const al = rgba[i + 3] / 255;
            r += rgba[i] * al;
            g += rgba[i + 1] * al;
            b += rgba[i + 2] * al;
            a += rgba[i + 3];
            n += 1;
          }
        }
        if (!n) n = 1;
        a /= n;
        const aw = a / 255;
        r = aw > 0 ? r / n / aw : 0;
        g = aw > 0 ? g / n / aw : 0;
        b = aw > 0 ? b / n / aw : 0;
      } else {
        const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
        const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sy - 0.5));
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const x1 = Math.min(sw - 1, x0 + 1);
        const y1 = Math.min(sh - 1, y0 + 1);
        const tx = fx - x0;
        const ty = fy - y0;
        const px = (xx, yy) => {
          const i = (yy * sw + xx) * 4;
          const al = rgba[i + 3] / 255;
          return [rgba[i] * al, rgba[i + 1] * al, rgba[i + 2] * al, rgba[i + 3]];
        };
        const p00 = px(x0, y0); const p10 = px(x1, y0); const p01 = px(x0, y1); const p11 = px(x1, y1);
        for (let c = 0; c < 4; c++) {
          const top = p00[c] * (1 - tx) + p10[c] * tx;
          const bot = p01[c] * (1 - tx) + p11[c] * tx;
          const v = top * (1 - ty) + bot * ty;
          if (c === 0) r = v; else if (c === 1) g = v; else if (c === 2) b = v; else a = v;
        }
        const aw = a / 255;
        r = aw > 0 ? r / aw : 0;
        g = aw > 0 ? g / aw : 0;
        b = aw > 0 ? b / aw : 0;
      }
      const o = (y * dw + x) * 4;
      out[o] = Math.max(0, Math.min(255, Math.round(r)));
      out[o + 1] = Math.max(0, Math.min(255, Math.round(g)));
      out[o + 2] = Math.max(0, Math.min(255, Math.round(b)));
      out[o + 3] = Math.max(0, Math.min(255, Math.round(a)));
    }
  }
  return out;
}

/** 四角取样：一张图的地色通常就在角上 */
function cornerColor(rgba, w, h) {
  const pts = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  let r = 0; let g = 0; let b = 0;
  for (const p of pts) {
    const i = (p[1] * w + p[0]) * 4;
    r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2];
  }
  return [r / 4, g / 4, b / 4];
}

/** 色距（欧氏平方，够用且快） */
function dist2(r, g, b, c) {
  const dr = r - c[0]; const dg = g - c[1]; const db = b - c[2];
  return dr * dr + dg * dg + db * db;
}

module.exports = {
  name: "image-tools",
  description: t("给模型真正动手改图的能力：读信息、裁切、缩放、抠底、去边、拼图集（本机没有 ImageMagick 也能干）"),

  setup(api) {
    const root = () => api.workspace;
    const resolveIO = (p) => {
      const raw = String(p || "").trim();
      if (!raw) return null;
      return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root(), raw);
    };
    const rel = (abs) => {
      const r = workspaceRel(abs);
      return r;
    };
    const workspaceRel = (abs) => {
      try {
        const r = path.relative(root(), abs);
        return r.split(path.sep).join("/");
      } catch (e) {
        return abs;
      }
    };
    const readIn = async (p, label) => {
      const abs = resolveIO(p);
      if (!abs) throw new Error((label || "图") + " 没给路径。");
      if (!fs.existsSync(abs)) throw new Error("找不到文件：" + p);
      if (!fs.statSync(abs).isFile()) throw new Error(p + " 是个目录，不是图片文件。");
      if (!isImg(abs)) throw new Error("认不出这个扩展名（" + (extOf(abs) || "无") + "），认 " + EXTS.join(" "));
      return { abs, img: await loadRGBA(abs) };
    };
    const outPath = (p) => {
      const abs = resolveIO(p);
      if (!abs) throw new Error("输出路径 out 没给。");
      if (!isImg(abs)) throw new Error("输出认这些扩展名：" + EXTS.join(" ") + "（当前是 " + (extOf(abs) || "无") + "）。");
      return abs;
    };

    // ── 1. 看图信息 ──────────────────────────────────────────
    api.addTool(
      {
        name: "image_info",
        kits: ["art"],
        description:
          t("看一张图的底细：像素尺寸、有没有透明通道、四角底色是什么。")
          + t("要抠底、要判断哪张能当游戏素材、要核对缩放比例之前先跑它 —— 比肉眼猜准。"),
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: t("图片路径（工作区相对路径或本机绝对路径）") } },
          required: ["path"],
        },
        level: "read",
      },
      async (args) => {
        try {
          const { abs, img } = await readIn(args && args.path);
          let opaque = 0;
          for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 250) opaque += 1;
          const soft = Math.round((opaque / (img.w * img.h)) * 1000) / 10;
          const corner = cornerColor(img.data, img.w, img.h);
          const lines = [
            rel(abs) + "：" + img.w + " x " + img.h + " 像素，" + pngEscapeSize(abs),
            t("能透的地方") + "：" + soft + "% " + (soft > 0.5 ? t("（这张本来就带透明通道）") : t("（整张不透明 —— 想透明得先抠底）")),
            t("四角底色") + "：" + rgb2hex(corner[0], corner[1], corner[2]) + " rgb(" + Math.round(corner[0]) + "," + Math.round(corner[1]) + "," + Math.round(corner[2]) + ")",
            t("解码路径") + "：" + img.via + (img.via === "png" ? t("（自带纯 node 解码；装上 sharp 能读更多格式）") : ""),
          ];
          return lines.join(NL);
        } catch (e) {
          return t("看图失败：") + (e && e.message ? e.message : e);
        }
      },
    );

    function pngEscapeSize(abs) {
      try { return Math.round(fs.statSync(abs).size / 1024) + " KB"; } catch (e) { return ""; }
    }

    // ── 2. 裁切 ────────────────────────────────────────────
    api.addTool(
      {
        name: "image_crop",
        kits: ["art"],
        description:
          t("从一张图里裁一块出来存成新文件。以前这类活只能现写脚本（本机没有 ImageMagick），现在一条调用。")
          + t("给 x / y / width / height 裁任意矩形；只想裁成方形就写 size（可选 align=center 居中，默认左上角从 x,y 起）。")
          + t("坐标超出画面会自动夹到边缘，不会报错也不会留黑边。"),
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: t("源图路径（只读，不会被改）") },
            out: { type: "string", description: t("输出路径，建议 .png（要透明就得用 png）") },
            x: { type: "number", description: t("裁切左上角的 x（默认 0）") },
            y: { type: "number", description: t("裁切左上角的 y（默认 0）") },
            width: { type: "number", description: t("裁多宽（不写就按 height 或 size）") },
            height: { type: "number", description: t("裁多高（不写就按 width 或 size）") },
            size: { type: "number", description: t("裁成正方形：边长多少个像素") },
            align: { type: "string", description: t("给了 size 时的取景位置：center（居中，默认）/ top / bottom / left / right") },
            scale: { type: "number", description: t("裁完再缩放到这个倍数（顺手用，省一次调用）") },
          },
          required: ["path", "out"],
        },
        level: "write",
      },
      async (args) => {
        try {
          const { img } = await readIn(args && args.path);
          const dst = outPath(args && args.out);
          let cw = Math.round(Number(args && args.width) || 0);
          let ch = Math.round(Number(args && args.height) || 0);
          const size = Math.round(Number(args && args.size) || 0);
          if (size > 0) { cw = size; ch = size; }
          if (!cw || !ch) return t("得给尺寸：width + height，或者一个 size（正方形）。");
          const align = String((args && args.align) || "center").toLowerCase();
          let x = Math.round(Number(args && args.x) || 0);
          let y = Math.round(Number(args && args.y) || 0);
          if (size > 0) {
            if (align === "center") { x = Math.round((img.w - cw) / 2); y = Math.round((img.h - ch) / 2); }
            else if (align === "top") { x = Math.round((img.w - cw) / 2); y = 0; }
            else if (align === "bottom") { x = Math.round((img.w - cw) / 2); y = img.h - ch; }
            else if (align === "left") { x = 0; y = Math.round((img.h - ch) / 2); }
            else if (align === "right") { x = img.w - cw; y = Math.round((img.h - ch) / 2); }
          }
          // 夹窗：允许窗口比图大（多出来按边缘延展），但起点拉回画面里，免得整块都是空的
          x = Math.min(Math.max(0, x), Math.max(0, img.w - 1));
          y = Math.min(Math.max(0, y), Math.max(0, img.h - 1));
          const win = crop(img.data, img.w, img.h, x, y, cw, ch);
          let ow = cw; let oh = ch;
          let data = win;
          const scale = Number(args && args.scale) || 0;
          if (scale > 0 && Math.abs(scale - 1) > 0.001) {
            ow = Math.max(1, Math.round(cw * scale));
            oh = Math.max(1, Math.round(ch * scale));
            data = resample(win, cw, ch, ow, oh);
          }
          const w2 = await saveRGBA(dst, ow, oh, data);
          return t("裁好了：") + rel(dst) + "（" + ow + " x " + oh + "）" + NL
            + t("（源图") + " " + img.w + " x " + img.h + t("，窗口从 (") + x + "," + y + t(") 起取 ") + cw + " x " + ch + t("）") + w2.note;
        } catch (e) {
          return t("裁切失败：") + (e && e.message ? e.message : e);
        }
      },
    );

    // ── 3. 缩放 ────────────────────────────────────────────
    api.addTool(
      {
        name: "image_resize",
        kits: ["art"],
        description:
          t("把一张图缩放到新尺寸存成新文件（缩小按面积平均、放大双线性，透明边不会拖黑边）。")
          + t("给 width 或 height 单边即可自动按比例；两边都给就是拉伸；也可以直接给 scale（倍数）。"),
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: t("源图路径") },
            out: { type: "string", description: t("输出路径") },
            width: { type: "number", description: t("目标宽（只给宽就按原比例算高）") },
            height: { type: "number", description: t("目标高（只给高就按原比例算宽）") },
            scale: { type: "number", description: t("倍数，比如 0.5 是缩一半、2 是放大一倍") },
          },
          required: ["path", "out"],
        },
        level: "write",
      },
      async (args) => {
        try {
          const { img } = await readIn(args && args.path);
          const dst = outPath(args && args.out);
          let dw = Math.round(Number(args && args.width) || 0);
          let dh = Math.round(Number(args && args.height) || 0);
          const scale = Number(args && args.scale) || 0;
          if (scale > 0 && !dw && !dh) { dw = Math.round(img.w * scale); dh = Math.round(img.h * scale); }
          if (dw && !dh) dh = Math.max(1, Math.round((img.h / img.w) * dw));
          if (dh && !dw) dw = Math.max(1, Math.round((img.w / img.h) * dh));
          if (!dw || !dh) return t("得给目标尺寸：width 或 height，或者一个 scale。");
          dw = Math.max(1, dw); dh = Math.max(1, dh);
          if (dw === img.w && dh === img.h) return t("尺寸没变，没写文件 —— 要给个不一样的尺寸。");
          const data = resample(img.data, img.w, img.h, dw, dh);
          const note = await saveRGBA(dst, dw, dh, data);
          return t("缩好了：") + rel(dst) + "  " + img.w + " x " + img.h + " → " + dw + " x " + dh + w2note(note);
        } catch (e) {
          return t("缩放失败：") + (e && e.message ? e.message : e);
        }
      },
    );

    function w2note(note) { return note && note.note ? note.note : ""; }

    // ── 4. 抠底 ────────────────────────────────────────────
    api.addTool(
      {
        name: "image_cutout",
        kits: ["art"],
        description:
          t("把纯色 / 近纯色的背景抠成透明，输出真正的透明 PNG（游戏引擎能直接用）。")
          + t("不给 color 就从四角自动取底色；tolerance 是容差（0-100，默认 18 —— 有噪点的背景调大些）。")
          + t("带去溢色（紫边 / 绿边）处理：半透明的边缘像素会把颜色往邻近实心处收，不会留下一圈脏边。")
          + t("做不到就直说做不到 —— 它不会用带底色的图冒充透明图。"),
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: t("源图路径") },
            out: { type: "string", description: t("输出路径。要透明必须是 .png") },
            color: { type: "string", description: t("要抠掉的颜色，比如 #ff00ff 或 255,0,255；不写就从四角取") },
            tolerance: { type: "number", description: t("容差 0-100，默认 18。背景有噪点就调大（30-45）") },
            feather: { type: "number", description: t("边缘羽化像素数，默认 1；要生硬的边就写 0") },
            despeckle: { type: "boolean", description: t("去掉抠完留下的小黑点 / 碎渣，默认 true") },
          },
          required: ["path", "out"],
        },
        level: "write",
      },
      async (args) => {
        try {
          const { img, abs } = await readIn(args && args.path);
          const dst = outPath(args && args.out);
          if (extOf(dst) !== ".png") return t("要透明的输出必须是 .png。") ;
          const color = parseColor(args && args.color) || cornerColor(img.data, img.w, img.h);
          const tol = Math.max(0, Math.min(100, Number(args && args.tolerance) >= 0 ? Number(args.tolerance) : 18));
          const feather = args && args.feather != null ? Math.max(0, Number(args.feather)) : 1;
          const despeckle = args && args.despeckle === false ? false : true;
          const r = cutout(img.data, img.w, img.h, color, tol, feather, despeckle);
          if (r.kept === 0) {
            return t("这一张抠不出来：按容差 ") + tol + t(" 判，**所有**像素都被算成背景色了。") + NL
              + t("多半是底色填满了整张（或者主体本身就是这个颜色）—— 看一眼 image_info 的四角底色，或者换一张主体与底色分得开的图。")
          }
          await saveRGBA(dst, img.w, img.h, r.data);
          const pct = Math.round((r.kept / (img.w * img.h)) * 1000) / 10;
          return [
            t("抠好了：") + rel(dst) + "（" + img.w + " x " + img.h + t("，真正的透明 PNG）"),
            t("抠掉的颜色：") + rgb2hex(color[0], color[1], color[2]) + t("，容差 ") + tol + t("，留下 ") + pct + "% " + t("的实心像素"),
            r.fixed > 0 ? t("去溢色：") + r.fixed + t(" 个半透明边缘像素的颜色收了回来（防紫边 / 绿边）") : "",
            r.dropped > 0 ? t("去碎渣：") + r.dropped + t(" 个小孤点被清掉了") : "",
            t("（源图没被动过：") + rel(abs) + t("）"),
          ].filter(Boolean).join(NL);
        } catch (e) {
          return t("抠底失败：") + (e && e.message ? e.message : e);
        }
      },
    );

    // ── 5. 去边 ────────────────────────────────────────────
    api.addTool(
      {
        name: "image_trim",
        kits: ["art"],
        description:
          t("把图四周多余的同色边（白边 / 底色边）裁掉，只留中间的主体，存成新文件。")
          + t("给了 pad 就在主体四周留几个像素的空。底色默认取四角，也能用 color 指定。"),
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: t("源图路径") },
            out: { type: "string", description: t("输出路径") },
            color: { type: "string", description: t("要裁掉的颜色；不写就取四角") },
            tolerance: { type: "number", description: t("容差 0-100，默认 18") },
            pad: { type: "number", description: t("裁完在四周留几个像素，默认 0") },
          },
          required: ["path", "out"],
        },
        level: "write",
      },
      async (args) => {
        try {
          const { img } = await readIn(args && args.path);
          const dst = outPath(args && args.out);
          const color = parseColor(args && args.color) || cornerColor(img.data, img.w, img.h);
          const tol = Math.max(0, Math.min(100, Number(args && args.tolerance) >= 0 ? Number(args.tolerance) : 18));
          const box = contentBox(img.data, img.w, img.h, color, tol, Math.max(0, Math.round(Number(args && args.pad) || 0)));
          if (!box) return t("整张都是一个颜色，没有可留下的主体 —— 没法去边。");
          const data = crop(img.data, img.w, img.h, box.x, box.y, box.w, box.h);
          await saveRGBA(dst, box.w, box.h, data);
          return t("去好边了：") + rel(dst) + "（" + box.w + " x " + box.h + t("；原来 ") + img.w + " x " + img.h + t("，裁掉了 ")
            + (img.w * img.h - box.w * box.h) + t(" 个像素的边）");
        } catch (e) {
          return t("去边失败：") + (e && e.message ? e.message : e);
        }
      },
    );

    // ── 6. 拼图集 ───────────────────────────────────────────
    api.addTool(
      {
        name: "image_sheet",
        kits: ["art"],
        description:
          t("把多张图拼成一张图集（spritesheet），同时输出一份 JSON 索引（每帧在图集里的 x/y/宽/高）。")
          + t("游戏引擎那套：图集本体 + 索引两份一起给。用 files 给一串图片路径，columns 指定几列（不写就自动排成方阵）。")
          + t("每帧尺寸不一致时会自动按最大帧对齐并居中 —— 索引里写的是对齐后的框。"),
        parameters: {
          type: "object",
          properties: {
            files: { type: "array", items: { type: "string" }, description: t("要拼进去的图片路径，按这个顺序排") },
            out: { type: "string", description: t("图集输出路径（建议 .png）") },
            index: { type: "string", description: t("JSON 索引输出路径（不写就在图集旁边加 .json）") },
            columns: { type: "number", description: t("几列；不写就自动排成尽可能方的阵") },
            cell: { type: "number", description: t("强制每个格子边长（不写就按最大那张算）") },
            padding: { type: "number", description: t("格子之间的空隙像素，默认 0") },
          },
          required: ["files", "out"],
        },
        level: "write",
      },
      async (args) => {
        try {
          const files = Array.isArray(args && args.files) ? args.files : [];
          if (!files.length) return t("files 得给一串图片路径。");
          const dst = outPath(args && args.out);
          const imgs = [];
          for (const f of files) {
            const got = await readIn(f, t("第 ") + (imgs.length + 1) + t(" 张"));
            imgs.push({ name: rel(got.abs), img: got.img });
          }
          const cols = Math.max(1, Math.round(Number(args && args.columns) || Math.ceil(Math.sqrt(imgs.length))));
          const rows = Math.ceil(imgs.length / cols);
          const pad = Math.max(0, Math.round(Number(args && args.padding) || 0));
          const forced = Math.round(Number(args && args.cell) || 0);
          let cw = forced; let chh = forced;
          if (!cw) {
            for (const it of imgs) { cw = Math.max(cw, it.img.w); chh = Math.max(chh, it.img.h); }
          }
          const SW = cols * cw + (cols + 1) * pad;
          const SH = rows * chh + (rows + 1) * pad;
          const sheet = Buffer.alloc(SW * SH * 4);
          const frames = [];
          for (let i = 0; i < imgs.length; i++) {
            const it = imgs[i];
            const cx = (i % cols) * (cw + pad) + pad;
            const cy = Math.floor(i / cols) * (chh + pad) + pad;
            let pix = it.img.data;
            let w2 = it.img.w; let h2 = it.img.h;
            if (w2 !== cw || h2 !== chh) {
              const k = Math.min(cw / w2, chh / h2);
              const nw = Math.max(1, Math.round(w2 * k));
              const nh = Math.max(1, Math.round(h2 * k));
              pix = nw === w2 && nh === h2 ? pix : resample(pix, w2, h2, nw, nh);
              w2 = nw; h2 = nh;
            }
            const ox = cx + Math.floor((cw - w2) / 2);
            const oy = cy + Math.floor((chh - h2) / 2);
            for (let y = 0; y < h2; y++) {
              for (let x = 0; x < w2; x++) {
                const si = (y * w2 + x) * 4;
                const di = ((oy + y) * SW + (ox + x)) * 4;
                sheet[di] = pix[si];
                sheet[di + 1] = pix[si + 1];
                sheet[di + 2] = pix[si + 2];
                sheet[di + 3] = pix[si + 3];
              }
            }
            frames.push({ name: path.basename(it.name), source: it.name, x: ox, y: oy, w: w2, h: h2 });
          }
          await saveRGBA(dst, SW, SH, sheet);
          const idxAbs = args && args.index ? resolveIO(args.index) : dst.replace(/\.png$/i, "") + ".json";
          const doc = { sheet: rel(dst), size: { w: SW, h: SH }, columns: cols, rows: rows, cell: { w: cw, h: chh }, padding: pad, frames: frames };
          fs.mkdirSync(path.dirname(idxAbs), { recursive: true });
          fs.writeFileSync(idxAbs, JSON.stringify(doc, null, 2), "utf8");
          const lines = [
            t("图集好了：") + rel(dst) + "（" + SW + " x " + SH + t("，") + cols + " x " + rows + t(" 格，每格 ") + cw + " x " + chh + "）",
            t("索引：") + rel(idxAbs) + t("（") + frames.length + t(" 帧，每帧的 x/y/宽/高都在里面）"),
            t("帧顺序：") + frames.map((f) => f.name).join(" / "),
          ];
          return lines.join(NL);
        } catch (e) {
          return t("拼图集失败：") + (e && e.message ? e.message : e);
        }
      },
    );

    // ── 7. 绿幕抠像（高级） ────────────────────────────────
    api.addTool(
      {
        name: "image_chroma_key",
        kits: ["art"],
        level: "write",
        description: t("绿幕 / 蓝幕抠像（专业键控）。比 image_cutout 强在：它看的是「这个像素的绿色相对红蓝过量多少」，不是跟一个固定颜色比距离 —— 所以幕布光照不均、有折痕、有噪点也抠得干净（固定色距那种在暗部会留脏边、亮部会误伤主体）。自动去绿边 / 蓝边（溢色）：半透明边缘的绿污染会收回去，不会留一圈绿毛。抠完可用 image_outline 勾边、image_over 换背景。输出的必须是 .png。"),
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: t("源图路径（只读）") },
            out: { type: "string", description: t("输出路径，必须是 .png") },
            screen: { type: "string", description: t("幕布色系：green（绿幕，默认）/ blue（蓝幕）/ magenta / cyan") },
            strength: { type: "number", description: t("抠多狠 0-1，默认 0.5。边缘残留多就调大（0.6-0.75），主体被吃掉就调小") },
            feather: { type: "number", description: t("边缘过渡宽度 0-1，默认 0.25。要生硬的边就给 0") },
            spill: { type: "number", description: t("去溢色强度 0-1，默认 0.6。边缘泛绿就调大，主体本身偏绿就调小") },
            despeckle: { type: "boolean", description: t("去掉抠完留下的小碎渣，默认 true") },
            shrink: { type: "number", description: t("蒙版收边像素数，默认 0。主体边缘有一圈半透明脏边时给 1-2") },
          },
          required: ["path", "out"],
        },
      },
      async (args) => {
        try {
          const { img, abs } = await readIn(args && args.path);
          const dst = outPath(args && args.out);
          if (extOf(dst) !== ".png") return t("抠像的输出必须是 .png —— 要透明，JPEG 做不到。");
          const screen = String((args && args.screen) || "green").toLowerCase();
          const r = adv.chromaKey(img.data, img.w, img.h, {
            screen: screen,
            strength: args && args.strength,
            feather: args && args.feather,
            spill: args && args.spill,
          });
          if (r.keyed === img.w * img.h) {
            return t("这一张整张都被判成幕布色了 —— 多半是 screen 选错了，或者它根本不是这个色系的幕布。换一个 screen 再试，或者先用 image_info 看一眼四角底色。");
          }
          let alpha = r.alpha;
          let refined = { dropped: 0, shrunk: 0 };
          const wantRefine = (args && args.despeckle !== false) || (Number(args && args.shrink) || 0) > 0;
          if (wantRefine) {
            const rr = adv.refineAlpha(alpha, img.w, img.h, {
              despeckle: args && args.despeckle !== false,
              shrink: Number(args && args.shrink) || 0,
              feather: 0,
            });
            alpha = rr.alpha;
            refined = rr;
          }
          const outData = Buffer.from(r.data);
          for (let p = 0; p < img.w * img.h; p++) outData[p * 4 + 3] = alpha[p];
          await saveRGBA(dst, img.w, img.h, outData);
          const kept = Math.round((1 - r.keyed / (img.w * img.h)) * 1000) / 10;
          const lines = [
            t("抠像完成：") + rel(dst) + "（" + img.w + " x " + img.h + t("，真正的透明 PNG）"),
            t("幕布色系：") + r.key + t("，留下 ") + kept + t("% 的实心像素"),
          ];
          if (r.spillFixed > 0) lines.push(t("去溢色：") + r.spillFixed + t(" 个边缘像素的幕布色被收了回来（防绿边 / 蓝边）"));
          if (refined.dropped > 0) lines.push(t("去碎渣：") + refined.dropped + t(" 个孤立小点被清掉"));
          lines.push(t("（源图没动：") + rel(abs) + t("）"));
          return lines.join(NL);
        } catch (e) {
          return t("抠像失败：") + (e && e.message ? e.message : e);
        }
      },
    );
    api.addTool(
      {
        name: "image_flood_cutout",
        kits: ["art"],
        level: "write",
        description: t(
          "通用抠图（边界泛洪）。跟 image_cutout 的关键区别：它从画面四边往里长，只吃掉跟边缘连通的背景 —— 所以主体内部有一块跟背景同色的区域（白底里一个白圈、人像里一块同色衣服）不会被误抠成破洞，而 image_cutout 那种固定色距会抠穿。渐变背景也吃得下（判据是跟相邻像素比，不是一个固定颜色）。背景干净就用 image_cutout；背景渐变、或者主体里有同色孔洞，就用它。输出必须是 .png。"
        ),
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: t("源图路径（只读）") },
            out: { type: "string", description: t("输出路径，必须是 .png") },
            tolerance: { type: "number", description: t("容差 0-100，默认 12。背景变化大就调大") },
            shrink: { type: "number", description: t("蒙版收边像素数，默认 0") },
            despeckle: { type: "boolean", description: t("去掉小碎渣，默认 true") },
            feather: { type: "number", description: t("边缘羽化像素数，默认 1；要生硬的边就给 0") },
          },
          required: ["path", "out"],
        },
      },
      async (args) => {
        try {
          const { img, abs } = await readIn(args && args.path);
          const dst = outPath(args && args.out);
          if (extOf(dst) !== ".png") return t("抠图的输出必须是 .png —— 要透明。");
          const r = adv.floodCutout(img.data, img.w, img.h, { tolerance: args && args.tolerance });
          const total = img.w * img.h;
          if (r.keyed >= total) return t("整张都被判成背景了 —— 容差太大，或这张图整体就是一个渐变色。把 tolerance 调小再试。");
          let alpha = r.alpha;
          let dropped = 0;
          let shrunk = 0;
          if (alpha && ((args && args.despeckle !== false) || (Number(args && args.shrink) || 0) > 0)) {
            const rr = adv.refineAlpha(alpha, img.w, img.h, {
              despeckle: args && args.despeckle !== false,
              shrink: Number(args && args.shrink) || 0,
              feather: Number(args && args.feather) || 0,
            });
            alpha = rr.alpha;
            dropped = rr.dropped;
            shrunk = rr.shrunk;
          }
          const outData = Buffer.from(img.data);
          for (let p = 0; p < total; p++) outData[p * 4 + 3] = alpha[p];
          await saveRGBA(dst, img.w, img.h, outData);
          const kept = Math.round(((total - r.keyed) / total) * 1000) / 10;
          const lines = [
            t("抠图完成：") + rel(dst) + "（" + img.w + " x " + img.h + t("，透明 PNG）"),
            t("背景吃掉 ") + r.keyed + t(" 个像素，主体留下 ") + kept + t("%"),
          ];
          if (dropped > 0) lines.push(t("去碎渣：") + dropped + t(" 个小孤点被清掉"));
          if (shrunk > 0) lines.push(t("蒙版收边：") + shrunk + t(" 像素"));
          lines.push(t("（源图没动：") + rel(abs) + t("）"));
          return lines.join(NL);
        } catch (e) {
          return t("抠图失败：") + (e && e.message ? e.message : e);
        }
      },
    );
    api.addTool(
      {
        name: "image_outline",
        kits: ["art"],
        level: "write",
        description: t("给透明图做收尾：勾一圈描边、再铺一层纯色背景。抠完要贴到别的底上、或给角色加一圈黑边时用它。先把图抠透明再用它。"),
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: t("源图路径（带透明的 PNG）") },
            out: { type: "string", description: t("输出路径，必须是 .png") },
            radius: { type: "number", description: t("描边宽度 1-8，默认 2") },
            color: { type: "string", description: t("描边颜色，如 #000000，默认黑") },
            background: { type: "string", description: t("描边之后铺的底色，如 #ffffff；不写就保持透明") },
          },
          required: ["path", "out"],
        },
      },
      async (args) => {
        try {
          const { img, abs } = await readIn(args && args.path);
          const dst = outPath(args && args.out);
          if (extOf(dst) !== ".png") return t("输出的必须是 .png。");
          const radius = Math.max(1, Math.min(8, Math.round(Number(args && args.radius) || 2)));
          const col = parseColor(args && args.color) || [0, 0, 0];
          let data = adv.outline(img.data, img.w, img.h, col, radius);
          const bgs = args && args.background ? parseColor(args.background) : null;
          if (bgs) {
            for (let p = 0; p < img.w * img.h; p++) {
              if (data[p * 4 + 3] !== 0) continue;
              data[p * 4] = bgs[0]; data[p * 4 + 1] = bgs[1]; data[p * 4 + 2] = bgs[2]; data[p * 4 + 3] = 255;
            }
          }
          await saveRGBA(dst, img.w, img.h, data);
          return t("描边完成：") + rel(dst) + "（" + img.w + " x " + img.h + t("，描边 ") + radius + t(" 像素）");
        } catch (e) {
          return t("描边失败：") + (e && e.message ? e.message : e);
        }
      },
    );
    api.log(t("image-tools 就位：") + (sharp() ? "sharp " + require("sharp/package.json").version : t("没装 sharp —— 只走自带 PNG 兜底路")));
  },
};

/** 内容外框：从四边往里收，直到碰上不是底色的像素 */
function contentBox(rgba, w, h, color, tol, pad) {
  const lim = (tol / 100) * (255 * 255 * 3);
  const isBg = (i) => {
    if (rgba[i + 3] < 16) return true;
    return dist2(rgba[i], rgba[i + 1], rgba[i + 2], color) <= lim;
  };
  let top = -1; let bottom = -1; let left = -1; let right = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isBg((y * w + x) * 4)) {
        if (top < 0) top = y;
        bottom = y;
        if (left < 0 || x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (top < 0) return null;
  const x = Math.max(0, left - pad);
  const y = Math.max(0, top - pad);
  const x2 = Math.min(w - 1, right + pad);
  const y2 = Math.min(h - 1, bottom + pad);
  return { x: x, y: y, w: x2 - x + 1, h: y2 - y + 1 };
}

function cutout(rgba, w, h, color, tol, feather, despeckle) {
  const n = w * h;
  const alpha = Buffer.alloc(n);
  const lim = (tol / 100) * (255 * 255 * 3);
  const feather2 = (feather || 0) * (feather || 0);
  const lim2 = (tol / 100 + 0.35) * (255 * 255 * 3);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const d = dist2(rgba[i], rgba[i + 1], rgba[i + 2], color);
    if (d <= lim) alpha[p] = 0;
    else if (feather > 0 && d < lim2) alpha[p] = Math.round(255 * Math.min(1, (Math.sqrt(d) - Math.sqrt(lim)) / Math.max(1, feather)));
    else alpha[p] = 255;
  }
  // 去碎渣：一个孤立的实心点四周全是透明，就把它也抹掉（抠完常见的渣）
  let dropped = 0;
  if (despeckle) {
    const kill = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        if (alpha[p] < 128) continue;
        let near = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (alpha[(y + dy) * w + (x + dx)] >= 128) near += 1;
        }
        if (near <= 1) kill.push(p);
      }
    }
    for (const p of kill) { alpha[p] = 0; dropped += 1; }
  }
  // 去溢色：半透明的边，颜色会被底色污染（紫边 / 绿边）。
  // 做法 —— 沿半径往外找最近的**实心**像素，把边上的颜色朝它拉过去。
  let fixed = 0;
  const out = Buffer.from(rgba);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const a = alpha[p];
      if (a === 0 || a === 255) continue;
      const hit = nearestOpaque(alpha, w, h, x, y, 3);
      if (!hit) continue;
      const i = p * 4;
      const j = hit * 4;
      const k = 1 - a / 255;
      out[i] = Math.round(rgba[i] * (1 - k) + rgba[j] * k);
      out[i + 1] = Math.round(rgba[i + 1] * (1 - k) + rgba[j + 1] * k);
      out[i + 2] = Math.round(rgba[i + 2] * (1 - k) + rgba[j + 2] * k);
      fixed += 1;
    }
  }
  let kept = 0;
  for (let p = 0; p < n; p++) {
    out[p * 4 + 3] = alpha[p];
    if (alpha[p] >= 128) kept += 1;
  }
  return { data: out, fixed: fixed, dropped: dropped, kept: kept };
}

function nearestOpaque(alpha, w, h, x, y, radius) {
  for (let r = 1; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const xx = x + dx; const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const p = yy * w + xx;
        if (alpha[p] === 255) return p;
      }
    }
  }
  return -1;
}