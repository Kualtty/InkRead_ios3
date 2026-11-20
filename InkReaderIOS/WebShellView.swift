import SwiftUI
import WebKit
import Network

/// 整个 App 就这一屏：一个铺满的 WKWebView，加载本地服务提供的 www。
///
/// 前端（`InkReaderWeb` 那套）一行不改地跑在里面，所以界面、标注、手写、导入
/// 跟电脑/安卓完全一致。壳只负责三件事：起本地服务、把 JS 的 alert/confirm
/// 补上（WKWebView 默认不弹，`if(!confirm())return` 会静默失效）、接住要落盘的文件。
struct WebShellView: UIViewRepresentable {

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = true

        let ucc = WKUserContentController()
        ucc.addUserScript(WKUserScript(source: bridgeScript,
                                       injectionTime: .atDocumentStart,
                                       forMainFrameOnly: true))
        ucc.add(context.coordinator, name: "ink")
        cfg.userContentController = ucc

        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.navigationDelegate = context.coordinator
        wv.uiDelegate = context.coordinator
        wv.allowsBackForwardNavigationGestures = true
        wv.allowsLinkPreview = false
        wv.scrollView.bounces = false
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.isOpaque = false
        wv.backgroundColor = .systemBackground
        wv.underPageBackgroundColor = .systemBackground
        if #available(iOS 16.4, *) { wv.isInspectable = true }   // 自签版留着方便 Safari 调试
        context.coordinator.webView = wv

        let port = LocalServer.shared.start()
        guard port > 0, let url = URL(string: "http://127.0.0.1:\(port)/") else {
            wv.loadHTMLString(Self.failureHTML, baseURL: nil)
            return wv
        }
        wv.load(URLRequest(url: url, cachePolicy: .reloadRevalidatingCacheData))
        return wv
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    // MARK: - 注入给前端的桥

    /// 前端用 `window.InkAndroid` 判断「在 App 里」：有它就去掉浏览器里的手机外框、
    /// 显示 App 专属项。这里给它一个同名对象，并且只实现确定能实现的方法 ——
    /// 前端每个调用点都先 `typeof A.xxx === 'function'`，缺的会自然降级到 Web 分支。
    private var bridgeScript: String {
        let ips = Self.localIPv4().joined(separator: ",")
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?.path ?? ""
        return """
        (function(){
          var H = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ink;
          function post(m){ try { if (H) H.postMessage(m); } catch(e) {} }
          window.InkAndroid = {
            __shell: 'ios',
            lanIps: function(){ return \(Self.jsQuote(ips)); },
            dataDir: function(){ return \(Self.jsQuote(docs)); },
            outDir: function(){ return \(Self.jsQuote(docs + "/墨阅导出")); },
            saveBlob: function(b64, name, mime){ post({cmd:'saveBlob', b64:b64, name:name, mime:mime||''}); },
            restartApp: function(){ post({cmd:'restartApp'}); }
          };
          window.__inkShell = 'ios';
        })();
        """
    }

    private static func jsQuote(_ s: String) -> String {
        var out = "\""
        for ch in s.unicodeScalars {
            switch ch {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            default: out.unicodeScalars.append(ch)
            }
        }
        return out + "\""
    }

    /// en0 / bridge100 这类物理或虚拟网卡上的 IPv4，用于「我的地址」那栏显示。
    private static func localIPv4() -> [String] {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return [] }
        defer { freeifaddrs(list) }

        var out: [String] = []
        var cursor = first
        while true {
            let ifa = cursor.pointee
            if let sa = ifa.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) {
                let name = String(cString: ifa.ifa_name)
                if name.hasPrefix("en") || name.hasPrefix("bridge") {
                    var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    if getnameinfo(sa, socklen_t(sa.pointee.sa_len),
                                   &host, socklen_t(host.count),
                                   nil, 0, NI_NUMERICHOST) == 0 {
                        let ip = String(cString: host)
                        if !ip.hasPrefix("127.") { out.append(ip) }
                    }
                }
            }
            guard let next = ifa.ifa_next else { break }
            cursor = next
        }
        return out
    }

    private static let failureHTML = """
    <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <body style="font:16px -apple-system;padding:32px;line-height:1.7">
    <h2>本地服务没起来</h2>
    <p>App 内的 HTTP 服务没能监听回环地址，页面取不到。</p>
    <p>请退出 App 重开一次；仍旧不行的话，把这条信息告诉我：<code>listener failed</code>。</p>
    </body>
    """
}

// MARK: - WKWebView 代理

final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {

    weak var webView: WKWebView?

    // MARK: JS 桥

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let cmd = body["cmd"] as? String else { return }
        switch cmd {
        case "saveBlob":
            guard let b64 = body["b64"] as? String,
                  let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else {
                alert("保存失败", "数据读不出来")
                return
            }
            save(data: data, name: (body["name"] as? String) ?? "导出.bin")
        case "restartApp":
            webView?.reload()
        default:
            break
        }
    }

    /// 前端导出的书/标注落盘到 Documents，这样在「文件」App 里能直接拷走。
    private func save(data: Data, name: String) {
        let fm = FileManager.default
        guard let docs = fm.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let dir = docs.appendingPathComponent("墨阅导出", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)

        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var target = dir.appendingPathComponent(name)
        var i = 2
        while fm.fileExists(atPath: target.path) {
            let n = ext.isEmpty ? "\(base)-\(i)" : "\(base)-\(i).\(ext)"
            target = dir.appendingPathComponent(n)
            i += 1
        }
        do {
            try data.write(to: target, options: .atomic)
            alert("已保存", "\(target.lastPathComponent)\n「文件」App → 我的 iPhone/iPad → 墨阅 → 墨阅导出")
        } catch {
            alert("保存失败", error.localizedDescription)
        }
    }

    // MARK: 导航

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.allow); return }
        let scheme = (url.scheme ?? "").lowercased()

        if scheme == "http" || scheme == "https" {
            let host = url.host ?? ""
            if host == "127.0.0.1" || host == "localhost" {
                decisionHandler(.allow)
            } else if navigationAction.targetFrame == nil {
                // 新窗口打开的外链（查词跳百科之类）交给系统浏览器，别把阅读界面顶掉
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
            return
        }
        // mailto: / itms-services: / 自定义 scheme
        UIApplication.shared.open(url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { webView.load(URLRequest(url: url)) }
        return nil
    }

    // MARK: alert / confirm / prompt
    // WKWebView 默认**不弹**这三个，不实现的话前端 `if (!confirm('删？')) return;`
    // 会直接当 false 处理 —— 表现为「点了删除没反应」。必须补齐。

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler() })
        present(a, fallback: completionHandler)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) })
        present(a) { completionHandler(false) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "确定", style: .default) { _ in
            completionHandler(a.textFields?.first?.text)
        })
        present(a) { completionHandler(nil) }
    }

    // MARK: 工具

    private func alert(_ title: String, _ text: String) {
        let a = UIAlertController(title: title, message: text, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "好", style: .default))
        present(a, fallback: nil)
    }

    private func present(_ alert: UIAlertController, fallback: (() -> Void)?) {
        guard let vc = topViewController() else {
            fallback?()
            return
        }
        vc.present(alert, animated: true)
    }

    private func topViewController() -> UIViewController? {
        guard let window = webView?.window else { return nil }
        var vc = window.rootViewController
        while let presented = vc?.presentedViewController { vc = presented }
        return vc
    }
}
