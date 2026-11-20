#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 InkReaderWeb 的前端资源拷成 iOS 壳的内置 www。

壳里跑的就是这一份，所以**改完前端必须重跑本脚本**再打包，否则 App 里还是旧页面
（跟安卓的 sync-www.py 是同一个道理）。

用法：
    python tools/prepare_www.py            # 自动找 ../InkReaderWeb/<唯一带 index.html 的目录>
    python tools/prepare_www.py --src "E:/windy/smallTools/InkReaderWeb/某目录"
    python tools/prepare_www.py --check    # 只比对，不写
"""
import argparse
import filecmp
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # InkReaderIOS
DST = os.path.join(ROOT, "www")

# 运行时真正要用的东西。不要整个目录拷 —— 开发树里还有 data/、docs/、
# localocr/（1.3G 模型）、installer/，拷进去 App 会胖到几百兆还没用。
DIRS = ["css", "js", "vendor", "plugins"]
FILES = [
    "index.html",
    "manifest.json",
    "icon.svg",
    "icon-180.png",
    "icon-192.png",
    "icon-512.png",
]
SKIP_SUFFIX = (".tmp", ".bak", ".log", ".orig", "~")


def find_src():
    base = os.path.join(os.path.dirname(ROOT), "InkReaderWeb")
    if not os.path.isdir(base):
        return None
    hits = []
    for name in os.listdir(base):
        p = os.path.join(base, name)
        if os.path.isfile(os.path.join(p, "index.html")) and os.path.isdir(os.path.join(p, "js")):
            hits.append(p)
    if len(hits) == 1:
        return hits[0]
    if not hits:
        return None
    # 多个就挑最近改过 index.html 的
    hits.sort(key=lambda p: os.path.getmtime(os.path.join(p, "index.html")), reverse=True)
    return hits[0]


def ignore_junk(_dir, names):
    return [n for n in names if n.endswith(SKIP_SUFFIX)]


def copy_all(src, dst):
    removed = 0
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    os.makedirs(dst, exist_ok=True)
    for d in DIRS:
        s = os.path.join(src, d)
        if not os.path.isdir(s):
            print("  ! 缺少目录 " + d)
            continue
        shutil.copytree(s, os.path.join(dst, d), ignore=ignore_junk)
    for f in FILES:
        s = os.path.join(src, f)
        if not os.path.isfile(s):
            print("  ! 缺少文件 " + f)
            continue
        shutil.copy2(s, os.path.join(dst, f))
    return removed


def du(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def diff_report(src, dst):
    """只报「有没有落后」，不做逐字节比对（40 MB 文件太多，看时间戳就够）。"""
    stale = []
    for d in DIRS:
        s_dir, d_dir = os.path.join(src, d), os.path.join(dst, d)
        if not os.path.isdir(d_dir):
            stale.append(d + "/ 整个缺")
            continue
        for root, _dirs, files in os.walk(s_dir):
            for f in files:
                if f.endswith(SKIP_SUFFIX):
                    continue
                sp = os.path.join(root, f)
                rel = os.path.relpath(sp, src)
                dp = os.path.join(dst, rel)
                if not os.path.isfile(dp):
                    stale.append(rel + " 缺")
                elif os.path.getsize(sp) != os.path.getsize(dp):
                    stale.append(rel + " 大小不同")
                elif os.path.getmtime(sp) > os.path.getmtime(dp) + 1:
                    stale.append(rel + " 比源旧")
    for f in FILES:
        sp, dp = os.path.join(src, f), os.path.join(dst, f)
        if not os.path.isfile(dp):
            stale.append(f + " 缺")
        elif os.path.getsize(sp) != os.path.getsize(dp):
            stale.append(f + " 大小不同")
    return stale


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    src = args.src or find_src()
    if not src or not os.path.isfile(os.path.join(src, "index.html")):
        print("找不到前端源目录，用 --src 指定（要含 index.html 与 js/）")
        return 2
    print("源：" + src)

    if args.check:
        if not os.path.isdir(DST):
            print("www 还不存在")
            return 1
        stale = diff_report(src, DST)
        if stale:
            print("内置 www 落后 %d 项：" % len(stale))
            for s in stale[:20]:
                print("  - " + s)
            return 1
        print("内置 www 与源一致（%.1f MB）" % (du(DST) / 1048576))
        return 0

    copy_all(src, DST)
    n = sum(len(fs) for _r, _d, fs in os.walk(DST))
    print("已写入 %s" % DST)
    print("  %d 个文件，%.1f MB" % (n, du(DST) / 1048576))
    return 0


if __name__ == "__main__":
    sys.exit(main())
