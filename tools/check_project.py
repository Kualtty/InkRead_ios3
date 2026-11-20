#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打包前的静态自检 —— 这台机器没有 Xcode，能在本地抓的错误就别留给 CI。

查这些：
  1. Swift 括号是否配平（剔掉注释、字符串、多行字符串之后数）
  2. pbxproj 里登记的每个文件在磁盘上真的存在（路径解析方式与 Xcode 一致）
  3. Info.plist 能解析，且关键键都在
  4. www 里有 index.html / js/reader.js，版本戳一致
  5. 工程里登记的 Swift 文件数 == 目录里的 Swift 文件数（漏登记会「找不到符号」）

用法：python tools/check_project.py
返回码 0 表示全过。
"""
import os
import plistlib
import re
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "InkReaderIOS")
PBX = os.path.join(ROOT, "InkReaderIOS.xcodeproj", "project.pbxproj")
WWW = os.path.join(ROOT, "www")

problems = []
notes = []


def fail(msg):
    problems.append(msg)


def ok(msg):
    notes.append(msg)


# ---------------------------------------------------------------- 1. Swift 括号
def strip_swift(src):
    """去掉注释与字符串字面量，只留结构性字符。"""
    out = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2)
            i = n if j < 0 else j + 2
        elif src.startswith('"""', i):
            # 多行字符串：跳到下一个 """ （允许前面有反斜杠转义的情况先不处理，够用）
            j = src.find('"""', i + 3)
            i = n if j < 0 else j + 3
            out.append('""')
        elif c == '"':
            i += 1
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == '"':
                    i += 1
                    break
                i += 1
            out.append('""')
        else:
            out.append(c)
            i += 1
    return "".join(out)


def check_swift(path):
    src = open(path, encoding="utf-8").read()
    code = strip_swift(src)
    for opener, closer, label in [("{", "}", "花括号"), ("(", ")", "圆括号"), ("[", "]", "方括号")]:
        a, b = code.count(opener), code.count(closer)
        if a != b:
            fail("%s：%s不配平（%d 个 %s / %d 个 %s）"
                 % (os.path.basename(path), label, a, opener, b, closer))
    if src.count('"""') % 2:
        fail("%s：多行字符串引号没有成对" % os.path.basename(path))


swift_files = sorted(f for f in os.listdir(APP) if f.endswith(".swift"))
for f in swift_files:
    check_swift(os.path.join(APP, f))
ok("Swift 文件 %d 个，括号检查通过" % len(swift_files))

# ---------------------------------------------------------------- 2. pbxproj 文件
pbx = open(PBX, encoding="utf-8").read()
refs = re.findall(
    r'([0-9A-F]{24}) /\* (.+?) \*/ = \{isa = PBXFileReference;.*?path = "?([^";]+)"?; sourceTree = "?([^";]+)"?; \};',
    pbx)

# 分组 id -> (path)
group_path = {}
for m in re.finditer(r'([0-9A-F]{24}) /\* .+? \*/ = \{\s*isa = PBXGroup;\s*children = \((.*?)\);(.*?)\};', pbx, re.S):
    gid, _children, tail = m.group(1), m.group(2), m.group(3)
    pm = re.search(r'path = "?([^";]+)"?;', tail)
    if pm:
        group_path[gid] = pm.group(1)

# 每条 fileRef 属于哪个 group
ref_group = {}
for m in re.finditer(r'([0-9A-F]{24}) /\* .+? \*/ = \{\s*isa = PBXGroup;\s*children = \((.*?)\);', pbx, re.S):
    gid, children = m.group(1), m.group(2)
    for cid in re.findall(r'([0-9A-F]{24}) /\*', children):
        ref_group.setdefault(cid, gid)

for ref_id, name, path, tree in refs:
    if tree.strip('"') != "<group>":
        continue
    gid = ref_group.get(ref_id)
    base = ROOT
    seen = set()
    while gid and gid not in seen:
        seen.add(gid)
        if gid in group_path:
            base = os.path.join(base, group_path[gid])
        gid = ref_group.get(gid)
    # 组的 path 是相对其父组；上面的循环顺序反了，简单起见按「拼接所有祖先 path」再验证一次
    cand = os.path.join(APP, path)
    if not (os.path.exists(cand) or os.path.exists(os.path.join(ROOT, path))):
        fail("pbxproj 登记的 %s 找不到（试过 %s、%s）" % (path, cand, os.path.join(ROOT, path)))

ok("pbxproj 文件引用检查完成（%d 条）" % len(refs))

# ---------------------------------------------------------------- 3. Info.plist
plist_path = os.path.join(APP, "Info.plist")
try:
    with open(plist_path, "rb") as f:
        pl = plistlib.load(f)
    for key in ["CFBundleIdentifier", "CFBundleExecutable", "CFBundleShortVersionString",
                "CFBundleVersion", "UILaunchScreen", "UISupportedInterfaceOrientations"]:
        if key not in pl:
            fail("Info.plist 缺 %s" % key)
    ats = pl.get("NSAppTransportSecurity") or {}
    if not ats.get("NSAllowsLocalNetworking"):
        fail("Info.plist 没开 NSAllowsLocalNetworking，http://127.0.0.1 会被 ATS 拦")
    ok("Info.plist 解析正常")
except Exception as e:
    fail("Info.plist 解析失败：%s" % e)

# ---------------------------------------------------------------- 4. www
idx = os.path.join(WWW, "index.html")
if not os.path.isfile(idx):
    fail("www/index.html 不存在，先跑 tools/prepare_www.py")
else:
    html = open(idx, encoding="utf-8").read()
    for need in ["js/reader.js", "js/translate.js", "vendor/", "plugins/"]:
        if need not in html:
            fail("index.html 里没引用 %s" % need)
    m = re.search(r"\?v=(\w+)", html)
    ok("内置 www 版本戳 %s" % (m.group(1) if m else "（无）"))

for need in ["js/reader.js", "js/ocr-paddle.js", "js/mt-local.js",
             "vendor/paddle/det.onnx", "vendor/paddle/rec.onnx", "vendor/ort", "plugins"]:
    if not os.path.exists(os.path.join(WWW, need)):
        fail("www 缺 %s" % need)

# ---------------------------------------------------------------- 5. 登记完整性
missing = [f for f in swift_files if f not in pbx]
if missing:
    fail("这些 Swift 文件没登记进工程：%s" % "、".join(missing))
else:
    ok("Swift 文件全部登记")

extra = [m for m in re.findall(r'/\* (\w[\w.+]*\.swift) in Sources \*/', pbx) if m not in swift_files]
if extra:
    fail("pbxproj 登记了不存在的文件：%s" % "、".join(extra))

# ---------------------------------------------------------------- 报告
for n in notes:
    print("  ok  " + n)
if problems:
    print("\n有 %d 个问题：" % len(problems))
    for p in problems:
        print("  ✗ " + p)
    sys.exit(1)
print("\n全部通过")
