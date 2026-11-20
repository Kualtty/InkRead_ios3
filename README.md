# 墨阅 iOS 壳（InkReaderIOS）

把 `InkReaderWeb` 那套前端**原样**塞进一个 iOS App：界面、标注、手写、主题、
导入导出跟电脑/安卓完全一致，书存在手机里，电脑不开机也能看。

- Swift 5 + SwiftUI，部署目标 **iOS / iPadOS 17.0**
- 依赖：**零第三方**（只有系统框架 WebKit / Network）
- 产物：未签名 ipa，用 Sideloadly + 免费 Apple ID 自签装机

---

## 为什么是「壳」而不是重写原生

`InkReader`（同目录那个 1 万行的 SwiftUI 工程）是 9 月按原型做的第一版，
之后 170 多轮改动全落在 Web 上，两边差了 3 倍代码量：Web 有 Tesseract + PaddleOCR
两套离线 OCR、4 个方向的离线翻译小模型、多端对账，原生版一样都没有。

补齐原生等于把 30k 行重写一遍。而前端本来就是浏览器里跑的 —— **OCR 和翻译都是
纯前端 WASM 在算**，不是电脑在算。所以把前端整个装进 App，能力自然就有了。

```
┌─────────────────────────────────────────┐
│  InkReaderIOS.app                        │
│  ┌───────────────────────────────────┐   │
│  │ WKWebView                         │   │
│  │   http://127.0.0.1:<随机端口>/     │   │
│  │   ↑ 内置 www（40 MB，和电脑同一份） │   │
│  └───────────────────────────────────┘   │
│  LocalServer（Network.framework）        │
│    静态文件 + Range + /api/ping          │
└─────────────────────────────────────────┘
```

**为什么非要起 HTTP 服务、不直接 `loadFileURL`**：前端把书存 IndexedDB、用 fetch 取
vendor 里的 wasm。`file://` 在 iOS 上是「不安全来源」，存储会被拒、wasm 编译会失败。
`http://127.0.0.1` 算安全上下文，一切照常。

壳只做三件前端做不了的事：

1. 起本地服务（`LocalServer.swift`）
2. 补上 `alert / confirm / prompt` —— WKWebView 默认**不弹**，
   不实现的话前端 `if (!confirm('删？')) return;` 会静默当 false，
   表现就是「点了没反应」（`WebShellView.swift` 的 Coordinator）
3. 接住要落盘的文件（导出到「文件」App 的「墨阅导出」）

---

## 目录

```
InkReaderIOS/
├── InkReaderIOS/
│   ├── InkReaderIOSApp.swift     入口，就一屏
│   ├── WebShellView.swift        WKWebView + JS 桥 + alert/confirm/prompt
│   ├── LocalServer.swift         127.0.0.1 上的极简 HTTP（静态 + Range）
│   ├── Info.plist                ATS 本地网络、文件共享、图标
│   └── Assets.xcassets/          AppIcon（1024，满幅）
├── www/                          内置前端（由 tools/prepare_www.py 生成，要提交）
├── tools/
│   ├── prepare_www.py            从 InkReaderWeb 拷前端
│   ├── gen_xcodeproj.py          生成 .xcodeproj（CI 上用 -target 编，不需要 scheme）
│   ├── make-icon.py              SVG → 1024 PNG（Edge headless 截图，不用 Pillow）
│   ├── preview.py                本机复刻壳的环境（只有静态文件 + /api/ping）
│   ├── test-shell.js             冒烟测试：白屏 / 异常 / 溢出 / 导入 / 阅读
│   └── check_project.py          没有 Xcode 时的静态自检
└── .github/workflows/build-unsigned-ipa.yml
```

---

## 改完前端之后

```bash
python tools/prepare_www.py     # 重新拷 www（**必做**，否则 App 里还是旧页面）
python tools/check_project.py   # 静态自检
python tools/gen_xcodeproj.py   # 只有在增删 Swift 文件时才需要
```

验证前端在「没有 serve.py」的环境里能不能跑（不用等 CI）：

```bash
python tools/preview.py 8901 &
# 另开一个终端
INK_BASE=http://127.0.0.1:8901 NODE_PATH=<InkReaderWeb>/node_modules node tools/test-shell.js
```

`test-shell.js` 现在 22 项：书架不白屏、无未捕获异常、无静态资源 404、
`.mjs` 是 `text/javascript`、`.wasm` 是 `application/wasm`、iPad 竖屏不横向溢出、
注入 `InkAndroid` 后控制条消失、真导一本 TXT 能进阅读器且正文渲染出来。

---

## 编译与装机

这台开发机是 Windows，装不了 Xcode，所以：

1. 推到 GitHub（公开仓库，macOS runner 才免费）
2. 仓库 → Actions → 「编译未签名 ipa」→ Run workflow
3. Artifacts 下载 `InkReaderIOS-unsigned-ipa`
4. Windows 上用 [Sideloadly](https://sideloadly.io/) + 免费 Apple ID 装机
   - 免费签名 **7 天过期**，到期重跑第 4 步（不用重新编译）

想彻底不碰电脑：688 元/年开发者账号 + TestFlight，一年签一次。

---

## 现在能做什么 / 还不能

| 能力 | 状态 |
|---|---|
| 书架、导入 TXT/PDF/EPUB/漫画 | ✅ 走 IndexedDB，不需要服务端 |
| 阅读、标注、笔记、手写、播读 | ✅ 前端原样 |
| 扫描版 OCR（PaddleOCR） | ⚠️ 模型在 `vendor/paddle` 里、纯前端 ORT，**待真机验证**（Safari 的 WASM SIMD） |
| 离线翻译 | ❌ 模型（114 MB/方向）没打进 App，界面会显示「未下载」 |
| 多端对账 / 共享面板 | ❌ 那些接口要 `serve.py`，壳里没有 |
| 连电脑用电脑的引擎 | ❌ 同上 |

后面三件事要补，都是在壳里加接口（/api/mt-local/*、/api/store/*），前端一行不用改。

---

## 已知取舍

- **不做 App Store 上架**：苹果 4.2 条会以「只是网页壳」拒掉。本工程只为自签装机。
- `www` 40 MB 提交在仓库里，改前端就要重跑 `prepare_www.py` 并提交 —— 换来 CI
  不需要额外拉资源，也不会因为网络问题编不过。
- `vendor/tesseract`（19 MB）暂时留着：前端「自动」引擎的兜底。确认 Paddle 在
  iOS 上稳定后可以删掉，包能瘦 19 MB。
