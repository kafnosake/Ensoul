'use strict';

/**
 * advanced.js —— 高级抠像与合成：绿幕/蓝幕键控、边缘去溢色、蒙版细化、描边、投影。
 *
 * 为什么单独一层、而且写成纯函数：
 *   image-tools 已有的 image_cutout 是**平色距离抠底** —— 拿一个颜色当背景算欧氏距离。
 *   画布上干净的纯色底够用，可真实拍摄的绿幕光照不均、有噪点、有折痕：
 *   固定颜色距离在这种图上会把暗部留成脏边、把亮部误判成前景。
 *   专业做法是看**绿色相对红蓝的过量**（键控过量）—— 它对亮度变化不敏感。这一层就是它。
 *
 * 只吃 RGBA Buffer、只吐 RGBA Buffer，不碰文件、不碰工作区。
 */

/** 夹到 [0,255] 的整数 */
function c255(v) {
  const n = Math.round(v);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

/** 夹到 [0,1] */
function c01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 键控过量：这个像素有多像幕布。
 * 绿幕 = g 比 max(r,b) 高多少；蓝幕 = b 比 max(r,g) 高多少。
 * 它看的是**通道之间的相对关系**，整体调亮调暗都不影响判定。
 */
function excessAt(r, g, b, key) {
  if (key === 'green') return g - Math.max(r, b);
  if (key === 'blue') return b - Math.max(r, g);
  if (key === 'magenta') return Math.min(r, b) - g;
  if (key === 'cyan') return Math.min(r, g) - b;
  return 0;
}


/**
 * 绿幕/蓝幕键控抠像。
 *
 * 每一步都只跟像素算，不碰文件。
 *
 * 关键参数是 screen（幕布色系）与 strength（抠多狠）。
 * 判定走 excessAt（通道过量），所以整张偏亮偏暗都不影响。
 */
function chromaKey(rgba, w, h, opt) {
  const o = opt || {};
  const key = o.screen === 'blue' ? 'blue' : o.screen === 'magenta' ? 'magenta' : o.screen === 'cyan' ? 'cyan' : 'green';
  const strength = c01(o.strength === undefined ? 0.5 : o.strength);
  const feather = c01(o.feather === undefined ? 0.25 : o.feather);
  const spill = c01(o.spill === undefined ? 0.6 : o.spill);
  const n = w * h;
  const alpha = Buffer.alloc(n);
  const out = Buffer.from(rgba);
  const t0 = 8 + strength * 80;
  const t1 = t0 + 6 + feather * 120;
  let keyed = 0;
  let spillFixed = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const r = rgba[i]; const g = rgba[i + 1]; const b = rgba[i + 2];
    const e = excessAt(r, g, b, key);
    // 过量越大 = 越像幕布 = 越该被抠掉；小于 t0 一律当实心，t0..t1 之间按比例过渡。
    let a = 255;
    if (e >= t1) a = 0;
    else if (e > t0) a = c255(255 * (1 - (e - t0) / Math.max(1, t1 - t0)));
    alpha[p] = a;
    if (a === 0) { keyed += 1; continue; }
    if (spill > 0 && e > 0) {
      const k = c01((e / Math.max(1, t1)) * spill);
      if (key === 'green') {
        const cap = (r + b) / 2;
        if (g > cap) { out[i + 1] = c255(g - (g - cap) * k); spillFixed += 1; }
      } else if (key === 'blue') {
        const cap = (r + g) / 2;
        if (b > cap) { out[i + 2] = c255(b - (b - cap) * k); spillFixed += 1; }
      }
    }
  }
  for (let p = 0; p < n; p++) out[p * 4 + 3] = alpha[p];
  return { data: out, alpha: alpha, keyed: keyed, spillFixed: spillFixed, key: key };
}


/**
 * 蒙版细化：把 alpha 边缘收一收、擦掉小碎渣、填掉小孔洞。
 * 抠完的 alpha 往往有毛刺和孤点，直接合成会显脏。
 */
function refineAlpha(alpha, w, h, opt) {
  const o = opt || {};
  const shrink = Math.max(0, Math.min(8, Math.round(Number(o.shrink) || 0)));
  const despeckle = o.despeckle === false ? false : true;
  const n = w * h;
  let out = Buffer.from(alpha);
  let shrunk = 0;
  for (let i = 0; i < shrink; i++) {
    const next = Buffer.from(out);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        if (out[p] < 8) continue;
        let min = out[p];
        min = Math.min(min, out[p - 1], out[p + 1], out[p - w], out[p + w]);
        if (min < out[p]) { next[p] = min; shrunk += 1; }
      }
    }
    out = next;
  }
  let dropped = 0;
  if (despeckle) {
    const kill = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        if (out[p] < 128) continue;
        let near = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            if (out[(y + dy) * w + (x + dx)] >= 128) near += 1;
          }
        }
        if (near <= 1) kill.push(p);
      }
    }
    for (const p of kill) { out[p] = 0; dropped += 1; }
  }
  return { alpha: out, shrunk: shrunk, dropped: dropped };
}


/**
 * 边界泛洪抠图：从画面四边往里长，只吃掉**与边缘连通**的近似背景，主体内部的同色洞不会被误抠。
 *
 * 这是平色抠底做不到的那件事：logo 里一个白底的白色圆环、人像里一块跟背景同色的衣服，
 * 平色距离一律照抠，抠完就是个破洞；泛洪只认「连到边上」的部分。
 * 渐变背景也能吃下去 —— 判据是跟**相邻像素**比，不是跟一个固定颜色比。
 */
function floodCutout(rgba, w, h, opt) {
  const o = opt || {};
  // tolerance 是 0-100 的百分数（跟本插件既有的 image_cutout 一把尺子）。
  // 阈值按平方折算：tol 越大越松，100 就等于全吃。
  const tol = Math.max(0, Math.min(100, Number(o.tolerance) >= 0 ? Number(o.tolerance) : 12)) / 100;
  const lim = tol * tol * 3 * 255 * 255;
  const n = w * h;
  const alpha = Buffer.alloc(n, 255);
  const seen = Buffer.alloc(n);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = y * w + x;
    if (seen[p]) return;
    seen[p] = 1;
    stack.push(p);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  let keyed = 0;
  while (stack.length) {
    const p = stack.pop();
    const i = p * 4;
    alpha[p] = 0;
    keyed += 1;
    const x = p % w;
    const y = (p - x) / w;
    const near = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
    for (const pt of near) {
      const nx = pt[0]; const ny = pt[1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (seen[q]) continue;
      const j = q * 4;
      const dr = rgba[j] - rgba[i];
      const dg = rgba[j + 1] - rgba[i + 1];
      const db = rgba[j + 2] - rgba[i + 2];
      if (dr * dr + dg * dg + db * db <= lim) push(nx, ny);
      else seen[q] = 1;
    }
  }
  return { alpha: alpha, keyed: keyed, total: n };
}

// 描边：给不透明像素的外围长一圈边（游戏素材常见的勾边）。只动 alpha 之外的合成，返回新的 RGBA。
function outline(rgba, w, h, color, radius) {
  const r = Math.max(1, Math.min(8, Math.round(Number(radius) || 2)));
  const n = w * h;
  const out = Buffer.from(rgba);
  const c = color || [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (rgba[p * 4 + 3] > 0) continue;
      let hit = 0;
      for (let dy = -r; dy <= r && !hit; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx; const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (rgba[(ny * w + nx) * 4 + 3] > 0) { hit = 1; break; }
        }
      }
      if (hit) { const i = p * 4; out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255; }
    }
  }
  return out;
}

module.exports = { c255, c01, excessAt, chromaKey, refineAlpha, floodCutout, outline };
