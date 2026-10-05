#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Ensoul Pixel Engine (最大支持 128x128)
用于 LLM 驱动的高性能、带防呆与修形功能的像素画处理引擎。
"""

import sys
import os
import json
from PIL import Image, ImageDraw

CANVAS_FILE = os.path.join(".ensoul", "pixel", "canvas.json")
PREVIEW_FILE = os.path.join(".ensoul", "pixel", "preview.png")

# 经典 16 色 PICO-8 调色板
DEFAULT_PALETTE = [
    "#000000", "#1D2B53", "#7E2553", "#008751",
    "#AB5236", "#5F574F", "#C2C3C7", "#FFF1E8",
    "#FF004D", "#FFA300", "#FFEC27", "#00E436",
    "#29ADFF", "#83769C", "#FF77A8", "#FFCCAA"
]

def load_canvas():
    if not os.path.exists(CANVAS_FILE):
        return init_canvas(32, 32)
    with open(CANVAS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

def save_canvas(data):
    os.makedirs(os.path.dirname(CANVAS_FILE), exist_ok=True)
    with open(CANVAS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)

def init_canvas(w=32, h=32):
    w = max(4, min(128, int(w)))
    h = max(4, min(128, int(h)))
    # grid: h rows, each has w items. None represents transparent
    grid = [[None for _ in range(w)] for _ in range(h)]
    data = {
        "width": w,
        "height": h,
        "palette": DEFAULT_PALETTE,
        "symmetry": False,
        "symmetry_axis": w // 2,
        "grid": grid
    }
    save_canvas(data)
    return data

def set_pixel(data, x, y, color):
    w, h = data["width"], data["height"]
    if 0 <= x < w and 0 <= y < h:
        data["grid"][y][x] = color
        if data.get("symmetry"):
            axis = data.get("symmetry_axis", w // 2)
            # x' 对称计算: 例如 w=32, 0 对称到 31 -> (2*axis - 1 - x)
            sym_x = 2 * axis - 1 - x if axis * 2 == w else 2 * axis - x
            if 0 <= sym_x < w:
                data["grid"][y][sym_x] = color

def draw_line(data, x0, y0, x1, y1, color):
    # Bresenham's line algorithm
    dx = abs(x1 - x0)
    dy = abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx - dy
    while True:
        set_pixel(data, x0, y0, color)
        if x0 == x1 and y0 == y1:
            break
        e2 = 2 * err
        if e2 > -dy:
            err -= dy
            x0 += sx
        if e2 < dx:
            err += dx
            y0 += sy

def draw_rect(data, x, y, w, h, color, fill=True):
    for r in range(y, y + h):
        for c in range(x, x + w):
            if fill or (r == y or r == y + h - 1 or c == x or c == x + w - 1):
                set_pixel(data, c, r, color)

def flood_fill(data, x, y, new_color):
    w, h = data["width"], data["height"]
    if not (0 <= x < w and 0 <= y < h):
        return
    old_color = data["grid"][y][x]
    if old_color == new_color:
        return
    stack = [(x, y)]
    visited = set()
    while stack:
        cx, cy = stack.pop()
        if (cx, cy) in visited:
            continue
        visited.add((cx, cy))
        if 0 <= cx < w and 0 <= cy < h and data["grid"][cy][cx] == old_color:
            data["grid"][cy][cx] = new_color
            stack.append((cx + 1, cy))
            stack.append((cx - 1, cy))
            stack.append((cx, cy + 1))
            stack.append((cx, cy - 1))

def outline(data, outline_color="#000000"):
    w, h = data["width"], data["height"]
    old_grid = [row[:] for row in data["grid"]]
    for y in range(h):
        for x in range(w):
            if old_grid[y][x] is None:
                # 检查四周 8 个方向是否有非空像素
                has_neighbor = False
                for dy in [-1, 0, 1]:
                    for dx in [-1, 0, 1]:
                        if dx == 0 and dy == 0:
                            continue
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < w and 0 <= ny < h and old_grid[ny][nx] is not None:
                            has_neighbor = True
                            break
                    if has_neighbor:
                        break
                if has_neighbor:
                    data["grid"][y][x] = outline_color

def hex_to_rgba(h):
    if not h:
        return (0, 0, 0, 0)
    h = h.lstrip('#')
    if len(h) == 6:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)
    elif len(h) == 8:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), int(h[6:8], 16))
    return (0, 0, 0, 255)

def render_preview(scale=None):
    data = load_canvas()
    w, h = data["width"], data["height"]
    if scale is None:
        # 自动算最合适的预览尺寸，约 512px 宽
        scale = max(2, min(32, 512 // max(w, h)))
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    for y in range(h):
        for x in range(w):
            c = data["grid"][y][x]
            if c:
                img.putpixel((x, y), hex_to_rgba(c))
    
    # 最近邻放大（保证绝对像素锐利边缘）
    preview_img = img.resize((w * scale, h * scale), Image.NEAREST)
    os.makedirs(os.path.dirname(PREVIEW_FILE), exist_ok=True)
    preview_img.save(PREVIEW_FILE, "PNG")
    return PREVIEW_FILE, w, h, scale

def execute_batch(commands):
    data = load_canvas()
    for cmd in commands:
        op = cmd.get("op")
        if op == "init":
            data = init_canvas(cmd.get("w", 32), cmd.get("h", 32))
        elif op == "pixel":
            set_pixel(data, cmd["x"], cmd["y"], cmd["c"])
        elif op == "line":
            draw_line(data, cmd["x0"], cmd["y0"], cmd["x1"], cmd["y1"], cmd["c"])
        elif op == "rect":
            draw_rect(data, cmd["x"], cmd["y"], cmd["w"], cmd["h"], cmd["c"], cmd.get("fill", True))
        elif op == "flood":
            flood_fill(data, cmd["x"], cmd["y"], cmd["c"])
        elif op == "symmetry":
            data["symmetry"] = bool(cmd.get("enabled", True))
            data["symmetry_axis"] = cmd.get("axis", data["width"] // 2)
        elif op == "outline":
            outline(data, cmd.get("color", "#000000"))
        elif op == "grid":
            # 批量矩阵载入: rows: list of strings or hex
            # cmd["rows"] 传入二维数组或紧凑索引
            rows = cmd.get("rows", [])
            for r_idx, row in enumerate(rows):
                if r_idx < data["height"]:
                    for c_idx, val in enumerate(row):
                        if c_idx < data["width"]:
                            data["grid"][r_idx][c_idx] = val if val else None
    save_canvas(data)
    out_file, w, h, s = render_preview()
    return {"status": "ok", "width": w, "height": h, "scale": s, "file": out_file}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python pixel_engine.py <init|render|batch_json> [args...]")
        sys.exit(1)
    
    action = sys.argv[1]
    if action == "init":
        w = int(sys.argv[2]) if len(sys.argv) > 2 else 32
        h = int(sys.argv[3]) if len(sys.argv) > 3 else 32
        init_canvas(w, h)
        out, w, h, s = render_preview()
        print(json.dumps({"status": "ok", "msg": f"Initialized {w}x{h} canvas", "preview": out}))
    elif action == "render":
        scale = int(sys.argv[2]) if len(sys.argv) > 2 else None
        out, w, h, s = render_preview(scale)
        print(json.dumps({"status": "ok", "file": out, "width": w, "height": h, "scale": s}))
    elif action == "batch":
        # 读取 stdin 的 JSON 批量指令
        try:
            content = sys.stdin.read()
            cmds = json.loads(content)
            res = execute_batch(cmds)
            print(json.dumps(res))
        except Exception as e:
            print(json.dumps({"status": "error", "error": str(e)}))
