/**
 * 纯 node 的 PNG 编解码 —— **兜底用**。
 *
 * 为什么留这么一份：主力走 sharp（本机有，质量高、格式全），但 sharp 是
 * devDependency，别人 clone 下来没装依赖时它就不在了。那时候至少让
 * 「裁一张、缩一张」这种最基本的活还能干 —— 代价是这条兜底路只认
 * 8bit 非隔行、RGB / RGBA 的 PNG，别的格式直说读不了，绝不假装成功。
 */

const zlib = require('zlib');

function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    crc ^= buf[n];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

/** 解出 { w, h, channels, data } —— channels 是 3(RGB) 或 4(RGBA) */
function decode(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('这不是一份 PNG');
  }
  let off = 8;
  let w = 0;
  let h = 0;
  let bd = 0;
  let ct = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bd = data[8];
      ct = data[9];
      if (data[12] !== 0) throw new Error('隔行 PNG 这条兜底路读不了（装上 sharp 就能读）');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bd !== 8) throw new Error(`只有 8bit 的 PNG 能读（这份是 ${bd}bit）`);
  const channels = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (!channels) throw new Error('只有 RGB / RGBA 的 PNG 能读（调色板、灰度请装上 sharp）');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const line = raw.slice(p, p + stride);
    p += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
  }
  return { w, h, channels, data: out };
}

/** 编码成 8bit RGBA PNG */
function encode(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { decode, encode };
