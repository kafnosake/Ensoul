# -*- coding: utf-8 -*-
"""
把头像压到每张 20K 以内。

两套图，两条路：

  面板预设头像  src/renderer/assets/panel-avatars/   512px → WebP（≤20K/张）
      84 张 512² 的 PNG 原件共 12.37MB，而它们最常露脸的地方是成员列表里的 34px
      圆形缩略图 —— 背着 12MB 换不来任何画质。压完 0.97MB。
      输出换扩展名（.webp）需要调用方按主干查表，见 panelAvatarUrl.ts。

  员工头像      .ensoul/state/avatars/               160px → 真 PNG，原地覆盖
      显示上限只有 52px（派单台 .dp-av.big），却存着 512² 的图。压完 2.43MB → 0.19MB。
      **文件名一个字都不改**：有 60 处路径引用焊着 .png（agents/*.json 角色卡、
      wechat.json 名册、dispatch.board.json、histconv 历史…），而那几份是活文件，
      插件内存里存着副本、随时整份写回 —— 换扩展名会把它们写回旧路径，头像直接崩。
      所以这条路只原地重压，不换格式、不改名。

用法（在仓库根目录跑）：
    python scripts/slim-avatars.py                # 两套都压（默认）
    python scripts/slim-avatars.py --target panel # 只压面板预设头像
    python scripts/slim-avatars.py --target emp   # 只压员工头像
    python scripts/slim-avatars.py --cap 30       # 换上限，默认 20（KB）
    python scripts/slim-avatars.py --dry          # 只看会压成多大，不动文件

可重复跑：已经是目标形态的文件（面板的 .webp、员工那头 ≤20K 的 PNG）原样跳过。
**原件不留备份**（老板明确要求，12MB 堆在 work/ 里没意义）——
要重压就从美术出图那边重新拿。
"""
import argparse, glob, io, os, sys

try:
    from PIL import Image
except ImportError:
    sys.exit('需要 Pillow：pip install Pillow')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PANEL_DIR = os.path.join(ROOT, 'src/renderer/assets/panel-avatars')
EMP_DIR = os.path.join(ROOT, '.ensoul/state/avatars')


def fit_webp(im, cap_bytes, size, q_hi=92, q_lo=80):
    """质量优先：从最高质量往下退，第一张落进上限就收。返回 (bytes, 用了几档质量)"""
    data, used = None, q_lo
    for q in range(q_hi, q_lo - 1, -1):
        r = im.resize((size, size), Image.LANCZOS) if size and size != im.width else im
        buf = io.BytesIO()
        r.save(buf, 'WEBP', quality=q, method=6)   # method=6 是 libwebp 最慢也最省的档
        data, used = buf.getvalue(), q
        if len(data) <= cap_bytes:
            break
    return data, used


def slim_panel(cap_kb, size, dry):
    """面板预设头像：出 WebP。源可以是美术刚丢进来的 .png，也可以是压过的 .webp"""
    src = sorted(glob.glob(os.path.join(PANEL_DIR, '*.png'))
                 + glob.glob(os.path.join(PANEL_DIR, '*.webp')))
    if not src:
        print('面板头像目录是空的 → ' + PANEL_DIR)
        return
    cap = cap_kb * 1024
    rows = []
    for f in src:
        ext = os.path.splitext(f)[1].lower()
        out = os.path.splitext(f)[0] + '.webp'
        raw = os.path.getsize(f)
        # 已经是压好的 webp、又没超标 → 跳过（这条让脚本可以反复跑，dry 也算）
        if ext == '.webp' and raw <= cap:
            rows.append((os.path.basename(f), raw / 1024, 0, True))
            continue
        im = Image.open(f).convert('RGB')
        data, q = fit_webp(im, cap, size)
        if not dry:
            if f != out and os.path.exists(f):
                os.remove(f)          # 同名不同扩展名的旧件顺手清掉
            with open(out, 'wb') as fh:
                fh.write(data)
        rows.append((os.path.basename(out), len(data) / 1024, q, False))

    fresh = [r for r in rows if not r[3]]
    sizes = [r[1] for r in rows]
    print('%s %d 张：max=%.1fK avg=%.1fK total=%.2fMB（本次重压 %d 张）'
          % ('[dry]' if dry else '面板头像', len(rows), max(sizes), sum(sizes) / len(sizes),
             sum(sizes) / 1024, len(fresh)))
    over = [r for r in rows if r[1] > cap_kb]
    if over:
        print('⚠ 仍超过 %dK 的：%s' % (cap_kb, over[:5]))


def slim_emp(cap_kb, size, dry, colors=128):
    """员工头像：原地重压成真 PNG，**文件名与扩展名一个字不改**（60 处路径引用焊着它）"""
    files = [f for f in sorted(glob.glob(os.path.join(EMP_DIR, '*')))
             if os.path.splitext(f)[1].lower() in ('.png', '.webp', '.jpg', '.jpeg')]
    if not files:
        print('员工头像目录是空的 → ' + EMP_DIR)
        return
    cap = cap_kb * 1024
    before = sum(os.path.getsize(f) for f in files)
    n = 0
    for f in files:
        if os.path.getsize(f) <= cap and Image.open(f).width <= size:
            continue                   # 已经够小，跳过（可反复跑）
        im = Image.open(f).convert('RGB')
        r = im.resize((size, size), Image.LANCZOS) if size and size != im.width else im
        q = r.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG)
        buf = io.BytesIO()
        q.save(buf, 'PNG', optimize=True)
        if not dry:
            with open(f, 'wb') as fh:
                fh.write(buf.getvalue())
            n += 1
    after = sum(os.path.getsize(f) for f in files)
    print('%s %d 张：%.2fMB → %.2fMB（本次重压 %d 张，%dpx / %d 色）'
          % ('[dry]' if dry else '员工头像', len(files), before / 1048576, after / 1048576,
             n, size, colors))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--target', choices=['panel', 'emp', 'all'], default='all')
    ap.add_argument('--cap', type=float, default=20.0, help='每张上限 KB，默认 20')
    ap.add_argument('--size', type=int, default=512, help='面板头像边长，默认 512')
    ap.add_argument('--emp-size', type=int, default=160, help='员工头像边长，默认 160（显示上限 52px）')
    ap.add_argument('--dry', action='store_true')
    a = ap.parse_args()
    if a.target in ('panel', 'all'):
        slim_panel(a.cap, a.size, a.dry)
    if a.target in ('emp', 'all'):
        slim_emp(a.cap, a.emp_size, a.dry)


if __name__ == '__main__':
    main()
