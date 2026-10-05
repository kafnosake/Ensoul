const fs = require('node:fs');
const path = require('node:path');
const sharp = require(process.env.ENSOUL_SHARP_MODULE || 'sharp');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'assets', 'brand');
const geometry = require('../assets/brand/source/geometry.json');
const { left, right, star, leftFacet, rightFacet, leftSeam, rightSeam } = geometry;
const sizes = [16, 20, 22, 24, 32, 48, 64, 128, 256, 512, 1024];
const files = [];
const mkdir = (name) => fs.mkdirSync(path.join(out, name), { recursive: true });
for (const dir of ['svg', 'png', 'platform', 'ui']) mkdir(dir);

function svg(content, viewBox = geometry.viewBox, width = 1024, height = width) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}" role="img" aria-labelledby="title"><title id="title">ensoul</title>${content}</svg>`;
}

function definitions(dark = false) {
  return `<defs>
    <linearGradient id="tile" x2="0.3" y2="1"><stop stop-color="${dark ? '#34383d' : '#fffdf8'}"/><stop offset="1" stop-color="${dark ? '#171a1e' : '#ece6dc'}"/></linearGradient>
    <linearGradient id="back" x1="0" y1="0" x2="0.8" y2="1"><stop stop-color="${dark ? '#f4f0e7' : '#25272a'}"/><stop offset="1" stop-color="${dark ? '#bab8b1' : '#090b0e'}"/></linearGradient>
    <linearGradient id="front" x1="0.2" y1="0" x2="0.8" y2="1"><stop stop-color="${dark ? '#fffdf5' : '#74777c'}"/><stop offset="0.5" stop-color="${dark ? '#e4e0d6' : '#41454b'}"/><stop offset="1" stop-color="${dark ? '#c9c7c0' : '#24272c'}"/></linearGradient>
    <linearGradient id="core" x2="0.7" y2="1"><stop stop-color="${dark ? '#fffdf5' : '#65696f'}"/><stop offset="1" stop-color="${dark ? '#d3d0c8' : '#14171b'}"/></linearGradient>
    <filter id="lift" x="-15%" y="-15%" width="135%" height="140%" color-interpolation-filters="sRGB"><feDropShadow dx="0" dy="9" stdDeviation="7" flood-color="#07090c" flood-opacity="${dark ? '.4' : '.22'}"/></filter>
    <clipPath id="left"><path d="${left}"/></clipPath><clipPath id="right"><path d="${right}"/></clipPath><clipPath id="star"><path d="${star}"/></clipPath>
    </defs>`;
}

function layered(dark = false, shadow = true) {
  const edge = dark ? '#fffdf5' : '#a8abb0';
  return `<g${shadow ? ' filter="url(#lift)"' : ''}>
    <path d="${left}" fill="url(#back)"/>
    <g clip-path="url(#left)"><path d="${leftFacet}" fill="url(#front)"/><path d="${leftSeam}" fill="none" stroke="${edge}" stroke-opacity=".72" stroke-width="5"/></g>
    <path d="${right}" fill="url(#back)"/>
    <g clip-path="url(#right)"><path d="${rightFacet}" fill="url(#front)"/><path d="${rightSeam}" fill="none" stroke="${edge}" stroke-opacity=".72" stroke-width="5"/></g>
    <path d="${star}" fill="url(#core)"/>
    <g clip-path="url(#star)"><path d="M513 713 L644 584 L644 713Z" fill="${dark ? '#ffffff' : '#85898e'}"/><path d="M644 713 L769 713 L644 841Z" fill="${dark ? '#d4d0c8' : '#32363c'}"/></g>
    </g>`;
}

function mono(color = 'currentColor', micro = false) {
  if (!micro) return `<g fill="${color}"><path d="${left}"/><path d="${right}"/><path d="${star}"/></g>`;
  return `<defs><mask id="cuts" maskUnits="userSpaceOnUse" x="0" y="0" width="1254" height="1254"><rect width="1254" height="1254" fill="white"/><path d="${leftSeam}" stroke="black" stroke-width="32" fill="none" stroke-linecap="round"/><path d="${rightSeam}" stroke="black" stroke-width="32" fill="none" stroke-linecap="round"/></mask></defs><g fill="${color}"><g mask="url(#cuts)"><path d="${geometry.microLeft}"/><path d="${geometry.microRight}"/></g><path d="${geometry.microStar}"/></g>`;
}

function appIcon(dark = false, micro = false) {
  const tile = `<rect x="62" y="62" width="1130" height="1130" rx="235" fill="url(#tile)" stroke="${dark ? '#4a4e54' : '#ffffff'}" stroke-width="5"/>`;
  return svg(definitions(dark) + tile + (micro ? mono(dark ? '#f5f2eb' : '#202328', true) : layered(dark)));
}

function save(name, content) {
  const rel = `svg/${name}.svg`;
  fs.writeFileSync(path.join(out, rel), content);
  files.push(rel);
  return content;
}

const light = save('app-icon-light', appIcon());
const dark = save('app-icon-dark', appIcon(true));
save('app-icon-micro', appIcon(false, true));
save('app-icon-dark-micro', appIcon(true, true));
save('mark-layered-light', svg(definitions() + layered(false, false), geometry.markViewBox));
save('mark-layered-dark', svg(definitions(true) + layered(true, false), geometry.markViewBox));
save('mark-mono-dark', svg(mono('#202328'), geometry.markViewBox));
save('mark-mono-light', svg(mono('#f5f2eb'), geometry.markViewBox));
save('mark-current-color', svg(mono(), geometry.markViewBox));
save('mark-micro', svg(mono('currentColor', true), geometry.markViewBox));
save('core', svg(`<path d="${star}" fill="currentColor"/>`, '485 550 310 315'));

for (const [name, color] of [['dark', '#202328'], ['light', '#f5f2eb']]) {
  save(`wordmark-${name}`, svg(`<path d="${geometry.wordmark}" transform="translate(16 140)" fill="${color}"/>`, `0 0 ${geometry.wordmarkWidth + 32} 175`, 700, 200));
  const symbol = `<g transform="translate(-10 -15) scale(.2)">${mono(color)}</g>`;
  const word = `<path d="${geometry.wordmark}" transform="translate(230 172) scale(1.05)" fill="${color}"/>`;
  save(`lockup-horizontal-${name}`, svg(symbol + word, `0 0 ${260 + geometry.wordmarkWidth * 1.05} 245`, 1200, 400));
  save(`lockup-stacked-${name}`, svg(`<g transform="translate(7 0) scale(.48)">${mono(color)}</g><path d="${geometry.wordmark}" transform="translate(${(630 - geometry.wordmarkWidth) / 2} 730)" fill="${color}"/>`, '0 0 630 770', 630, 770));
}

fs.writeFileSync(path.join(out, 'ui/sprite.svg'), `<svg xmlns="http://www.w3.org/2000/svg"><symbol id="ensoul-mark" viewBox="${geometry.markViewBox}">${mono()}</symbol><symbol id="ensoul-core" viewBox="485 550 310 315"><path d="${star}" fill="currentColor"/></symbol></svg>`);
fs.writeFileSync(path.join(out, 'ui/tokens.css'), ':root { --ensoul-ink: #202328; --ensoul-fold: #74777c; --ensoul-paper: #fffdf8; --ensoul-paper-shade: #ece6dc; --ensoul-clear-space: 0.25em; }\n.ensoul-logo { display: inline-block; width: 24px; height: 24px; background: currentColor; mask: url("../svg/mark-micro.svg") center / contain no-repeat; -webkit-mask: url("../svg/mark-micro.svg") center / contain no-repeat; }\n');

function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const at = 6 + i * 16;
    header[at] = header[at + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

async function png(content, size) {
  return sharp(Buffer.from(content), { density: 144 }).resize(size, size, { fit: 'contain' }).png().toBuffer();
}

async function main() {
  const icons = [];
  for (const size of sizes) {
    const data = await png(size <= 32 ? appIcon(false, true) : light, size);
    fs.writeFileSync(path.join(out, `png/app-icon-${size}.png`), data);
    fs.writeFileSync(path.join(out, `png/app-icon-dark-${size}.png`), await png(size <= 32 ? appIcon(true, true) : dark, size));
    if ([16, 24, 32, 48, 64, 128, 256].includes(size)) icons.push({ size, data });
  }
  for (const name of ['mark-layered-light', 'mark-layered-dark', 'mark-mono-dark', 'mark-mono-light', 'mark-micro']) {
    for (const size of [24, 32, 64, 128, 256, 512]) {
      const content = fs.readFileSync(path.join(out, `svg/${name}.svg`), 'utf8').replaceAll('currentColor', '#202328');
      fs.writeFileSync(path.join(out, `png/${name}-${size}.png`), await png(content, size));
    }
  }
  for (const name of ['wordmark-dark', 'wordmark-light', 'lockup-horizontal-dark', 'lockup-horizontal-light', 'lockup-stacked-dark', 'lockup-stacked-light']) {
    const content = fs.readFileSync(path.join(out, `svg/${name}.svg`));
    fs.writeFileSync(path.join(out, `png/${name}.png`), await sharp(content, { density: 144 }).resize({ width: 1200 }).png().toBuffer());
  }
  fs.writeFileSync(path.join(out, 'platform/ensoul.ico'), ico(icons));
  fs.copyFileSync(path.join(out, 'platform/ensoul.ico'), path.join(out, 'platform/favicon.ico'));
  const chunks = [];
  for (const [type, size] of [['icp4',16],['icp5',32],['icp6',64],['ic07',128],['ic08',256],['ic09',512],['ic10',1024]]) {
    const data = fs.readFileSync(path.join(out, `png/app-icon-${size}.png`));
    const h = Buffer.alloc(8); h.write(type); h.writeUInt32BE(data.length + 8, 4);
    chunks.push(h, data);
  }
  const h = Buffer.alloc(8); h.write('icns'); h.writeUInt32BE(8 + chunks.reduce((n, b) => n + b.length, 0), 4);
  fs.writeFileSync(path.join(out, 'platform/ensoul.icns'), Buffer.concat([h, ...chunks]));
  fs.copyFileSync(path.join(out, 'png/app-icon-1024.png'), path.join(root, 'assets/icon.png'));
  fs.copyFileSync(path.join(out, 'png/app-icon-32.png'), path.join(root, 'assets/tray.png'));
  const template = svg(mono('#000000', true), geometry.markViewBox);
  fs.writeFileSync(path.join(root, 'assets/trayTemplate.png'), await png(template, 22));
  fs.writeFileSync(path.join(root, 'assets/trayTemplate@2x.png'), await png(template, 44));
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ name: 'ensoul', version: 1, preferredTheme: 'paper', sizes, svg: files, smallSize: 'Use micro at 16–32px; use monochrome for dense UI and OS template icons.' }, null, 2) + '\n');
  console.log('Exported SVG, PNG, ICO, ICNS and app/tray assets.');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
