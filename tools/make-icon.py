#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 iOS App 图标（1024×1024，App Store 要求的唯一尺寸）。

iOS 会自动加圆角遮罩，所以这里把 SVG 原有的 rx 去掉、底色铺满，
避免「圆角套圆角」出现一圈白边（Web 的 make-icons.js 踩过同样的坑）。

不依赖 Pillow / playwright：直接用 Edge 的 headless 截图。
用法：python tools/make-icon.py [--src <icon.svg 路径>]
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, "InkReaderIOS", "Assets.xcassets", "AppIcon.appiconset")

EDGES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
]


def find_browser():
    for p in EDGES:
        if os.path.isfile(p):
            return p
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.join(ROOT, "www", "icon.svg"))
    ap.add_argument("--size", type=int, default=1024)
    args = ap.parse_args()

    svg = open(args.src, encoding="utf-8").read()
    size = args.size
    svg = re.sub(r'width="\d+"', 'width="%d"' % size, svg, count=1)
    svg = re.sub(r'height="\d+"', 'height="%d"' % size, svg, count=1)
    svg = svg.replace('rx="112"', 'rx="0"')          # 满幅，交给 iOS 自己裁圆角

    tmp = tempfile.mkdtemp(prefix="inkicon")
    src_svg = os.path.join(tmp, "icon.svg")
    open(src_svg, "w", encoding="utf-8").write(svg)

    png = os.path.join(tmp, "icon-%d.png" % size)
    exe = find_browser()
    if not exe:
        print("找不到 Edge / Chrome，无法生成图标")
        return 2

    url = "file:///" + src_svg.replace("\\", "/")
    cmd = [
        exe, "--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--default-background-color=00000000",
        "--virtual-time-budget=4000",
        "--screenshot=" + png,
        "--window-size=%d,%d" % (size, size),
        url,
    ]
    subprocess.run(cmd, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   timeout=90)

    if not os.path.isfile(png):
        print("截图没生成：%s" % png)
        return 1

    # 只校验 PNG 头里记录的宽高，不依赖第三方库
    with open(png, "rb") as f:
        head = f.read(33)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        print("产物不是 PNG")
        return 1
    w = int.from_bytes(head[16:20], "big")
    h = int.from_bytes(head[20:24], "big")

    os.makedirs(OUT_DIR, exist_ok=True)
    shutil.copy2(png, os.path.join(OUT_DIR, "icon-1024.png"))
    print("已生成 AppIcon %dx%d → %s" % (w, h, os.path.join(OUT_DIR, "icon-1024.png")))
    shutil.rmtree(tmp, ignore_errors=True)
    return 0 if (w, h) == (size, size) else 1


if __name__ == "__main__":
    sys.exit(main())
