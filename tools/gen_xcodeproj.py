#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 InkReaderIOS.xcodeproj（经典 pbxproj，Xcode 14+ 可直接打开 / xcodebuild 可编）。

为什么不用 XcodeGen：CI 上多一个 brew 依赖就多一次失败机会，而且 pbxproj 的
结构在这里是固定的（3 个 Swift + 1 个 xcassets + 1 个 www 文件夹引用），
自己写反而更好核对。

用法：python tools/gen_xcodeproj.py
"""
import itertools
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJ_DIR = os.path.join(ROOT, "InkReaderIOS.xcodeproj")
os.makedirs(PROJ_DIR, exist_ok=True)

NAME = "InkReaderIOS"
BUNDLE_ID = "cn.moyue.inkreader.ios"

_counter = itertools.count(1)


def uid():
    return "CB%022X" % next(_counter)


def q(value):
    return '"%s"' % value.replace("\\", "\\\\").replace('"', '\\"')


# ------------------------------------------------------------------ 清单
SOURCES = ["InkReaderIOSApp.swift", "LocalServer.swift", "WebShellView.swift"]
ASSETS = "Assets.xcassets"
WWW = "www"          # 蓝色文件夹引用：整目录原样进 bundle

PROJECT = uid()
TARGET = uid()
MAIN_GROUP = uid()
PRODUCTS_GROUP = uid()
SRC_GROUP = uid()
RES_GROUP = uid()
CL_PROJ = uid()
CL_TARGET = uid()
BC_PROJ_DEBUG = uid()
BC_PROJ_RELEASE = uid()
BC_TGT_DEBUG = uid()
BC_TGT_RELEASE = uid()
PHASE_SOURCES = uid()
PHASE_FRAMEWORKS = uid()
PHASE_RESOURCES = uid()
PRODUCT_REF = uid()

out = []
w = out.append

src_builds = []      # (buildfile_id, fileref_id, name)
file_refs = []       # (id, name, path, lastKnownFileType, sourceTree, group)
res_builds = []      # (buildfile_id, fileref_id, name)
src_children = []
res_children = []

for name in SOURCES:
    ref = uid()
    bf = uid()
    file_refs.append((ref, name, name, "sourcecode.swift", '"<group>"', SRC_GROUP))
    src_builds.append((bf, ref, name))
    src_children.append((ref, name))

# Assets.xcassets（黄色文件夹）
assets_ref = uid()
assets_bf = uid()
# 图标必须在 InkReaderIOS/ 里（和 Swift 同级），放进 Resources 组会解析成工程根，路径就错了
file_refs.append((assets_ref, ASSETS, ASSETS, "folder.assetcatalog", '"<group>"', SRC_GROUP))
res_builds.append((assets_bf, assets_ref, ASSETS))
src_children.append((assets_ref, ASSETS))

# www（蓝色文件夹引用：lastKnownFileType = folder 才会保留目录结构）
www_ref = uid()
www_bf = uid()
file_refs.append((www_ref, WWW, WWW, "folder", '"<group>"', RES_GROUP))
res_builds.append((www_bf, www_ref, WWW))
res_children.append((www_ref, WWW))

# ------------------------------------------------------------------ 输出
w("// !$*UTF8*$!")
w("{")
w("\tarchiveVersion = 1;")
w("\tclasses = {")
w("\t};")
w("\tobjectVersion = 56;")
w("\tobjects = {")
w("")

w("/* Begin PBXBuildFile section */")
for bf, ref, name in src_builds:
    w("\t\t%s /* %s in Sources */ = {isa = PBXBuildFile; fileRef = %s /* %s */; };"
      % (bf, name, ref, name))
for bf, ref, name in res_builds:
    w("\t\t%s /* %s in Resources */ = {isa = PBXBuildFile; fileRef = %s /* %s */; };"
      % (bf, name, ref, name))
w("/* End PBXBuildFile section */")
w("")

w("/* Begin PBXFileReference section */")
w('\t\t%s /* %s.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; '
  'includeInIndex = 0; path = %s.app; sourceTree = BUILT_PRODUCTS_DIR; };' % (PRODUCT_REF, NAME, NAME))
for ref, name, path, ftype, tree, _grp in file_refs:
    w("\t\t%s /* %s */ = {isa = PBXFileReference; lastKnownFileType = %s; path = %s; sourceTree = %s; };"
      % (ref, name, ftype, q(path), tree))
w("/* End PBXFileReference section */")
w("")

w("/* Begin PBXFrameworksBuildPhase section */")
w("\t\t%s /* Frameworks */ = {" % PHASE_FRAMEWORKS)
w("\t\t\tisa = PBXFrameworksBuildPhase;")
w("\t\t\tbuildActionMask = 2147483647;")
w("\t\t\tfiles = (")
w("\t\t\t);")
w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
w("\t\t};")
w("/* End PBXFrameworksBuildPhase section */")
w("")

w("/* Begin PBXGroup section */")
w("\t\t%s = {" % MAIN_GROUP)
w("\t\t\tisa = PBXGroup;")
w("\t\t\tchildren = (")
w("\t\t\t\t%s /* %s */," % (SRC_GROUP, NAME))
w("\t\t\t\t%s /* Resources */," % RES_GROUP)
w("\t\t\t\t%s /* Products */," % PRODUCTS_GROUP)
w("\t\t\t);")
w('\t\t\tsourceTree = "<group>";')
w("\t\t};")

w("\t\t%s /* %s */ = {" % (SRC_GROUP, NAME))
w("\t\t\tisa = PBXGroup;")
w("\t\t\tchildren = (")
for cid, cname in src_children:
    w("\t\t\t\t%s /* %s */," % (cid, cname))
w("\t\t\t);")
w("\t\t\tpath = %s;" % NAME)
w('\t\t\tsourceTree = "<group>";')
w("\t\t};")

w("\t\t%s /* Resources */ = {" % RES_GROUP)
w("\t\t\tisa = PBXGroup;")
w("\t\t\tchildren = (")
for cid, cname in res_children:
    w("\t\t\t\t%s /* %s */," % (cid, cname))
w("\t\t\t);")
w("\t\t\tname = Resources;")
w('\t\t\tsourceTree = "<group>";')
w("\t\t};")

w("\t\t%s /* Products */ = {" % PRODUCTS_GROUP)
w("\t\t\tisa = PBXGroup;")
w("\t\t\tchildren = (")
w("\t\t\t\t%s /* %s.app */," % (PRODUCT_REF, NAME))
w("\t\t\t);")
w("\t\t\tname = Products;")
w('\t\t\tsourceTree = "<group>";')
w("\t\t};")
w("/* End PBXGroup section */")
w("")

w("/* Begin PBXNativeTarget section */")
w("\t\t%s /* %s */ = {" % (TARGET, NAME))
w("\t\t\tisa = PBXNativeTarget;")
w("\t\t\tbuildConfigurationList = %s /* Build configuration list for PBXNativeTarget \"%s\" */;" % (CL_TARGET, NAME))
w("\t\t\tbuildPhases = (")
w("\t\t\t\t%s /* Sources */," % PHASE_SOURCES)
w("\t\t\t\t%s /* Frameworks */," % PHASE_FRAMEWORKS)
w("\t\t\t\t%s /* Resources */," % PHASE_RESOURCES)
w("\t\t\t);")
w("\t\t\tbuildRules = (")
w("\t\t\t);")
w("\t\t\tdependencies = (")
w("\t\t\t);")
w("\t\t\tname = %s;" % NAME)
w("\t\t\tproductName = %s;" % NAME)
w("\t\t\tproductReference = %s /* %s.app */;" % (PRODUCT_REF, NAME))
w('\t\t\tproductType = "com.apple.product-type.application";')
w("\t\t};")
w("/* End PBXNativeTarget section */")
w("")

w("/* Begin PBXProject section */")
w("\t\t%s /* Project object */ = {" % PROJECT)
w("\t\t\tisa = PBXProject;")
w("\t\t\tattributes = {")
w("\t\t\t\tBuildIndependentTargetsInParallel = 1;")
w("\t\t\t\tLastSwiftUpdateCheck = 1600;")
w("\t\t\t\tLastUpgradeCheck = 1600;")
w("\t\t\t\tTargetAttributes = {")
w("\t\t\t\t\t%s = {" % TARGET)
w("\t\t\t\t\t\tCreatedOnToolsVersion = 16.0;")
w("\t\t\t\t\t};")
w("\t\t\t\t};")
w("\t\t\t};")
w("\t\t\tbuildConfigurationList = %s /* Build configuration list for PBXProject \"%s\" */;" % (CL_PROJ, NAME))
w('\t\t\tcompatibilityVersion = "Xcode 14.0";')
w("\t\t\tdevelopmentRegion = zh_CN;")
w("\t\t\thasScannedForEncodings = 0;")
w("\t\t\tknownRegions = (")
w("\t\t\t\ten,")
w("\t\t\t\tBase,")
w('\t\t\t\t"zh-Hans",')
w("\t\t\t);")
w("\t\t\tmainGroup = %s;" % MAIN_GROUP)
w("\t\t\tproductRefGroup = %s /* Products */;" % PRODUCTS_GROUP)
w('\t\t\tprojectDirPath = "";')
w('\t\t\tprojectRoot = "";')
w("\t\t\ttargets = (")
w("\t\t\t\t%s /* %s */," % (TARGET, NAME))
w("\t\t\t);")
w("\t\t};")
w("/* End PBXProject section */")
w("")

w("/* Begin PBXResourcesBuildPhase section */")
w("\t\t%s /* Resources */ = {" % PHASE_RESOURCES)
w("\t\t\tisa = PBXResourcesBuildPhase;")
w("\t\t\tbuildActionMask = 2147483647;")
w("\t\t\tfiles = (")
for bf, ref, name in res_builds:
    w("\t\t\t\t%s /* %s in Resources */," % (bf, name))
w("\t\t\t);")
w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
w("\t\t};")
w("/* End PBXResourcesBuildPhase section */")
w("")

w("/* Begin PBXSourcesBuildPhase section */")
w("\t\t%s /* Sources */ = {" % PHASE_SOURCES)
w("\t\t\tisa = PBXSourcesBuildPhase;")
w("\t\t\tbuildActionMask = 2147483647;")
w("\t\t\tfiles = (")
for bf, ref, name in src_builds:
    w("\t\t\t\t%s /* %s in Sources */," % (bf, name))
w("\t\t\t);")
w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
w("\t\t};")
w("/* End PBXSourcesBuildPhase section */")
w("")

PROJECT_COMMON = [
    ("ALWAYS_SEARCH_USER_PATHS", "NO"),
    ("CLANG_ENABLE_MODULES", "YES"),
    ("CLANG_ENABLE_OBJC_ARC", "YES"),
    ("COPY_PHASE_STRIP", "NO"),
    ("GCC_C_LANGUAGE_STANDARD", "gnu17"),
    ("GCC_NO_COMMON_BLOCKS", "YES"),
    ("IPHONEOS_DEPLOYMENT_TARGET", "17.0"),
    ("SDKROOT", "iphoneos"),
    ("SWIFT_EMIT_LOC_STRINGS", "YES"),
]
PROJECT_DEBUG = [
    ("DEBUG_INFORMATION_FORMAT", "dwarf"),
    ("ENABLE_TESTABILITY", "YES"),
    ("SWIFT_ACTIVE_COMPILATION_CONDITIONS", '"DEBUG $(inherited)"'),
    ("SWIFT_OPTIMIZATION_LEVEL", '"-Onone"'),
]
PROJECT_RELEASE = [
    ("DEBUG_INFORMATION_FORMAT", '"dwarf-with-dsym"'),
    ("SWIFT_COMPILATION_MODE", "wholemodule"),
    ("VALIDATE_PRODUCT", "YES"),
]

TARGET_COMMON = [
    ("ASSETCATALOG_COMPILER_APPICON_NAME", "AppIcon"),
    ("CODE_SIGN_STYLE", "Automatic"),
    ("CURRENT_PROJECT_VERSION", "1"),
    ("GENERATE_INFOPLIST_FILE", "NO"),
    ("INFOPLIST_FILE", "%s/Info.plist" % NAME),
    ("IPHONEOS_DEPLOYMENT_TARGET", "17.0"),
    ("LD_RUNPATH_SEARCH_PATHS", '(\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t\t"@executable_path/Frameworks",\n\t\t\t\t)'),
    ("MARKETING_VERSION", "0.1"),
    ("PRODUCT_BUNDLE_IDENTIFIER", BUNDLE_ID),
    ("PRODUCT_NAME", '"$(TARGET_NAME)"'),
    # 多个值必须整体加引号，否则 pbxproj 解析失败
    ("SUPPORTED_PLATFORMS", '"iphoneos iphonesimulator"'),
    ("SWIFT_VERSION", "5.0"),
    ("TARGETED_DEVICE_FAMILY", '"1,2"'),
]


def write_bc(bc_id, label, settings):
    w("\t\t%s /* %s */ = {" % (bc_id, label))
    w("\t\t\tisa = XCBuildConfiguration;")
    w("\t\t\tbuildSettings = {")
    for key, value in settings:
        w("\t\t\t\t%s = %s;" % (key, value))
    w("\t\t\t};")
    w("\t\t\tname = %s;" % label)
    w("\t\t};")


w("/* Begin XCBuildConfiguration section */")
write_bc(BC_PROJ_DEBUG, "Debug", PROJECT_COMMON + PROJECT_DEBUG)
write_bc(BC_PROJ_RELEASE, "Release", PROJECT_COMMON + PROJECT_RELEASE)
write_bc(BC_TGT_DEBUG, "Debug", TARGET_COMMON)
write_bc(BC_TGT_RELEASE, "Release", TARGET_COMMON)
w("/* End XCBuildConfiguration section */")
w("")


def write_cl(cl_id, label, debug_bc, release_bc):
    w("\t\t%s /* Build configuration list for %s */ = {" % (cl_id, label))
    w("\t\t\tisa = XCConfigurationList;")
    w("\t\t\tbuildConfigurations = (")
    w("\t\t\t\t%s /* Debug */," % debug_bc)
    w("\t\t\t\t%s /* Release */," % release_bc)
    w("\t\t\t);")
    w("\t\t\tdefaultConfigurationIsVisible = 0;")
    w("\t\t\tdefaultConfigurationName = Release;")
    w("\t\t};")


w("/* Begin XCConfigurationList section */")
write_cl(CL_PROJ, 'PBXProject "%s"' % NAME, BC_PROJ_DEBUG, BC_PROJ_RELEASE)
write_cl(CL_TARGET, 'PBXNativeTarget "%s"' % NAME, BC_TGT_DEBUG, BC_TGT_RELEASE)
w("/* End XCConfigurationList section */")
w("")
w("\t};")
w("\trootObject = %s /* Project object */;" % PROJECT)
w("}")

os.makedirs(os.path.join(PROJ_DIR, "project.xcworkspace"), exist_ok=True)
with open(os.path.join(PROJ_DIR, "project.pbxproj"), "w", encoding="utf-8", newline="\n") as f:
    f.write("\n".join(out) + "\n")
with open(os.path.join(PROJ_DIR, "project.xcworkspace", "contents.xcworkspacedata"),
          "w", encoding="utf-8", newline="\n") as f:
    f.write('<?xml version="1.0" encoding="UTF-8"?>\n<Workspace\n   version = "1.0">\n'
            '   <FileRef\n      location = "self:">\n   </FileRef>\n</Workspace>\n')

print("已生成 " + os.path.join(PROJ_DIR, "project.pbxproj"))
print("  源文件 %d 个，资源 %d 项" % (len(SOURCES), len(res_builds)))
