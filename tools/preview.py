#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在本机复刻 iOS 壳的环境：只发 www 静态文件 + 极简 /api/ping。

壳里就是这么跑前端的，所以「电脑上 serve.py 好好的、App 里白屏」这种问题，
用它就能提前发现，不用等 CI 编完装到手机上才知道。

用法：python tools/preview.py [端口，默认 8901]
      然后浏览器打开 http://127.0.0.1:8901/
"""
import http.server
import json
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WWW = os.path.join(ROOT, "www")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WWW, **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("  [api] %s\n" % (fmt % args))

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/ping":
            return self._json({"ok": True, "app": "ios-preview", "root": WWW})
        if path == "/api/root":
            return self._json({"ok": True, "root": WWW})
        if path.startswith("/api/"):
            # 与壳保持一致：缺的接口回 404 JSON，前端据此降级
            return self._json({"ok": False, "error": "iOS 壳没有这个接口：" + path}, 404)
        return super().do_GET()

    def guess_type(self, path):
        # .mjs 必须是 text/javascript，SimpleHTTPRequestHandler 的默认表给的是
        # application/javascript，ORT 的模块加载会因此失败
        if path.endswith(".mjs"):
            return "text/javascript"
        if path.endswith(".wasm"):
            return "application/wasm"
        return super().guess_type(path)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8901
    if not os.path.isfile(os.path.join(WWW, "index.html")):
        print("www/index.html 不存在，先跑 tools/prepare_www.py")
        return 2
    with Server(("127.0.0.1", port), Handler) as httpd:
        print("iOS 壳预览：http://127.0.0.1:%d/" % port)
        print("（只服务 www，没有任何 serve.py 接口）")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
