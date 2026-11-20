import Foundation
import Network

/// App 内极简 HTTP 服务，只监听 127.0.0.1，把内置的 www 当网站发出去。
///
/// 为什么不直接 `loadFileURL`：Web 前端把书存在 IndexedDB、用 fetch 取 vendor 里的
/// wasm（ORT / PaddleOCR / Tesseract）。`file://` 在 iOS 上是「不安全来源」，存储会被拒、
/// wasm 编译会失败。`http://127.0.0.1` 算安全上下文，一切照常 —— 和安卓那边跑
/// serve.py 的效果一样，只是这里只承担「静态文件 + 几个只读接口」。
///
/// 故意不做的事：不监听 0.0.0.0（除了本机谁也连不上）、不处理 POST、
/// 不实现 /api/store（书走前端 IndexedDB）。缺的接口一律 404 + JSON，
/// 前端每处调用都有降级分支，只会少一个功能，不会白屏。
final class LocalServer {

    static let shared = LocalServer()

    private let queue = DispatchQueue(label: "cn.moyue.inkreader.http", qos: .userInitiated)
    private var listener: NWListener?
    private(set) var port: UInt16 = 0

    private init() {}

    /// 同步启动并等到 ready；成功返回端口，失败返回 0。
    func start() -> UInt16 {
        if port > 0 { return port }

        if let l = makeListener(loopbackOnly: true) {
            listener = l
            NSLog("[ink] 本地服务 http://127.0.0.1:\(port)/")
            return port
        }
        // 回环绑定失败（个别系统版本对 requiredLocalEndpoint 挑剔）时退一步，
        // 监听全部网卡。App 只在前台跑、且没有对外接口，风险有限。
        if let l = makeListener(loopbackOnly: false) {
            listener = l
            NSLog("[ink] 本地服务（回退）http://127.0.0.1:\(port)/")
            return port
        }
        NSLog("[ink] 本地服务起不来")
        return 0
    }

    private func makeListener(loopbackOnly: Bool) -> NWListener? {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        if loopbackOnly {
            params.requiredLocalEndpoint = NWEndpoint.hostPort(host: NWEndpoint.Host("127.0.0.1"),
                                                              port: NWEndpoint.Port.any)
        }

        let l: NWListener
        do {
            l = try NWListener(using: params)
        } catch {
            NSLog("[ink] listener 建立失败：\(error)")
            return nil
        }

        let sem = DispatchSemaphore(value: 0)
        l.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.port = l.port?.rawValue ?? 0
                sem.signal()
            case .failed, .cancelled:
                sem.signal()
            default:
                break
            }
        }
        l.newConnectionHandler = { [weak self] conn in
            self?.accept(conn)
        }
        l.start(queue: queue)
        _ = sem.wait(timeout: .now() + 5)
        if port == 0 {
            l.cancel()
            return nil
        }
        return l
    }

    // MARK: - 连接处理

    private func accept(_ conn: NWConnection) {
        conn.start(queue: queue)
        read(conn, buffer: Data())
    }

    /// 读到 `\r\n\r\n` 就交给 handle，不读 body（本服务没有 POST 接口）。
    private func read(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] chunk, _, isDone, error in
            guard let self else { conn.cancel(); return }
            var buf = buffer
            if let chunk { buf.append(chunk) }
            if error != nil {
                conn.cancel()
                return
            }
            if let end = buf.range(of: Data("\r\n\r\n".utf8)) {
                self.handle(conn, head: buf.subdata(in: 0..<end.lowerBound))
                return
            }
            if isDone || buf.count > 256 * 1024 {
                conn.cancel()
                return
            }
            self.read(conn, buffer: buf)
        }
    }

    private func handle(_ conn: NWConnection, head: Data) {
        guard let text = String(data: head, encoding: .utf8) else { conn.cancel(); return }
        let lines = text.components(separatedBy: "\r\n")
        guard let first = lines.first else { conn.cancel(); return }
        let parts = first.split(separator: " ", maxSplits: 2).map(String.init)
        guard parts.count >= 2 else { conn.cancel(); return }

        let method = parts[0].uppercased()
        var target = parts[1]
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let i = line.firstIndex(of: ":") else { continue }
            let key = line[..<i].trimmingCharacters(in: .whitespaces).lowercased()
            let value = String(line[line.index(after: i)...]).trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }

        if let q = target.firstIndex(of: "?") { target = String(target[..<q]) }
        if let h = target.firstIndex(of: "#") { target = String(target[..<h]) }
        let path = target.removingPercentEncoding ?? target

        guard method == "GET" || method == "HEAD" else {
            return sendJSON(conn, status: "405 Method Not Allowed", body: ["ok": false, "error": "只读服务"])
        }

        switch path {
        case "/api/ping":
            return sendJSON(conn, status: "200 OK", body: [
                "ok": true, "app": "ios", "root": documentsPath()
            ])
        case "/api/root":
            return sendJSON(conn, status: "200 OK", body: ["ok": true, "root": documentsPath()])
        default:
            break
        }
        if path.hasPrefix("/api/") {
            return sendJSON(conn, status: "404 Not Found", body: [
                "ok": false, "error": "iOS 壳没有这个接口：" + path
            ])
        }
        serveFile(conn, path: path, headers: headers)
    }

    // MARK: - 静态文件

    private var root: URL {
        if let u = Bundle.main.url(forResource: "www", withExtension: nil) { return u }
        return Bundle.main.bundleURL.appendingPathComponent("www", isDirectory: true)
    }

    private func serveFile(_ conn: NWConnection, path: String, headers: [String: String]) {
        var rel = path.isEmpty ? "/index.html" : path
        if rel.hasSuffix("/") { rel += "index.html" }
        if rel == "/index.html" || rel == "index.html" { rel = "/index.html" }

        // 目录穿越防护：逐段过滤掉 . 和 ..，服务端只按相对路径拼。
        let safe = rel.split(separator: "/").filter { $0 != ".." && $0 != "." }.joined(separator: "/")
        guard !safe.isEmpty else {
            return sendText(conn, status: "404 Not Found", body: "404")
        }
        let file = root.appendingPathComponent(safe)

        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir), !isDir.boolValue else {
            return sendText(conn, status: "404 Not Found", body: "404 Not Found: /" + safe)
        }
        guard let data = try? Data(contentsOf: file, options: .mappedIfSafe) else {
            return sendText(conn, status: "500 Internal Server Error", body: "500")
        }

        let mime = Self.mimeType(for: file.pathExtension)

        // pdf.js 会发 Range 请求，切片能让大 PDF 少读很多字节。
        if let raw = headers["range"], let range = Self.parseRange(raw, total: data.count) {
            let slice = data.subdata(in: range)
            return send(conn, status: "206 Partial Content", headers: [
                ("Content-Type", mime),
                ("Content-Range", "bytes \(range.lowerBound)-\(range.upperBound - 1)/\(data.count)"),
                ("Accept-Ranges", "bytes"),
            ], body: slice)
        }

        send(conn, status: "200 OK", headers: [
            ("Content-Type", mime),
            ("Accept-Ranges", "bytes"),
            // bundle 里的文件随 App 更新，不需要强缓存；前端自己用 ?v= 管版本
            ("Cache-Control", "no-cache"),
        ], body: data)
    }

    private static func parseRange(_ value: String, total: Int) -> Range<Int>? {
        guard total > 0, value.lowercased().hasPrefix("bytes=") else { return nil }
        let spec = value.dropFirst(6).split(separator: ",").first.map(String.init) ?? ""
        let parts = spec.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 2 else { return nil }

        if parts[0].isEmpty {                       // bytes=-1024 末尾 N 字节
            guard let n = Int(parts[1]), n > 0 else { return nil }
            return max(0, total - n)..<total
        }
        guard let start = Int(parts[0]), start < total else { return nil }
        let end = parts[1].isEmpty ? total - 1 : min(total - 1, Int(parts[1]) ?? total - 1)
        guard start <= end else { return nil }
        return start..<(end + 1)
    }

    // MARK: - 响应

    private func sendJSON(_ conn: NWConnection, status: String, body: [String: Any]) {
        let data = (try? JSONSerialization.data(withJSONObject: body, options: [])) ?? Data("{}".utf8)
        send(conn, status: status, headers: [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Access-Control-Allow-Origin", "*"),
        ], body: data)
    }

    private func sendText(_ conn: NWConnection, status: String, body: String) {
        send(conn, status: status, headers: [
            ("Content-Type", "text/plain; charset=utf-8"),
        ], body: Data(body.utf8))
    }

    private func send(_ conn: NWConnection, status: String, headers: [(String, String)], body: Data) {
        var head = "HTTP/1.1 \(status)\r\n"
        for (k, v) in headers { head += "\(k): \(v)\r\n" }
        head += "Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(body)
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }

    // MARK: - 杂项

    private func documentsPath() -> String {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?.path ?? ""
    }

    private static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        // .mjs 必须是 text/javascript，写 application/javascript 时 Safari/ORT 会拒绝执行
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "wasm": return "application/wasm"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "svg": return "image/svg+xml"
        case "ico": return "image/x-icon"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "pdf": return "application/pdf"
        case "epub": return "application/epub+zip"
        case "txt": return "text/plain; charset=utf-8"
        case "zip", "cbz": return "application/zip"
        case "gz": return "application/gzip"
        default: return "application/octet-stream"
        }
    }
}
