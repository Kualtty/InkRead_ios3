/*
 * 墨阅 InkReader · 本机 PaddleOCR（PP-OCRv6 tiny）—— R171
 * ------------------------------------------------------------------
 * 为什么要它：浏览器里的 Tesseract 认不动漫画、扫描件、中文小字（网点/彩色气泡/
 * 轻微倾斜全崩）。本机跑 PaddleOCR 的 det+rec 两个 onnx（合计 6 MB），
 * 精度明显高一个代差，而且**完全离线**——不联网、不连电脑。
 *
 * 为什么不做成替换：Tesseract 已经能用（19 MB 语言包 + 成熟），
 * 万一 onnx 运行时在这台机器上起不来（少见但有可能），用户还有退路。
 * 所以这是**新增一个引擎选项**，Tesseract 原样保留。
 *
 * 依赖：
 *   vendor/ort/ort.min.js + ort-wasm-simd-threaded.{mjs,wasm}   （推理运行时）
 *   vendor/paddle/det.onnx  （1.7 MB，DB 文本检测）
 *   vendor/paddle/rec.onnx  （4.3 MB，CTC 文字识别）
 *   vendor/paddle/keys.txt  （6904 个字符的字典）
 *
 * 输出的格式与 Tesseract 那条路**完全一致**：{words:[{text,bbox,confidence}]}，
 * bbox 是原 canvas 像素坐标。上层建文字层 / 划词 / 高亮 / 备份一行都不用改。
 *
 * ⚠ 三个坑（都踩过）：
 *   1. `ort.env.wasm.numThreads = 1` 必设：多线程版要 SharedArrayBuffer，
 *      而我们的 serve.py 没发 COOP/COEP 头，开线程会直接初始化失败。
 *   2. 输入是 **BGR**（Paddle 的 DecodeImage img_mode=BGR），按 RGB 喂进去
 *      结果不是报错而是「认出一堆毫不相干的字」——最难查的那种错。
 *   3. det 输出是**概率图**，不是框。阈值 + 连通域 + 沿主轴 unclip 才得到框；
 *      直接拿外接矩形会把整段文字和旁边的画框在一起，rec 出来全是乱码。
 */
const OcrPaddle = (() => {
  'use strict';

  const TESS = 'vendor/tesseract';           // 只是复用同一个 vendor 目录的路径风格
  const DIR = 'vendor/paddle';
  const ORT_DIR = 'vendor/ort';

  // v6 tiny 的官方 yml：thresh 0.2 / box_thresh 0.4 / unclip_ratio 1.4
  const DET_THRESH = 0.2;
  const BOX_THRESH = 0.4;
  const UNCLIP = 1.4;
  const DET_LIMIT = 960;      // 长边上限：再大对 tiny 模型没收益，只是更慢
  const REC_H = 48;           // rec 固定高 48（yml 的 image_shape）
  const REC_MAX_W = 1600;

  let _ort = null;
  let _ortLoading = null;
  let _det = null;
  let _rec = null;
  let _keys = null;           // { chars: string[], hasSpace: bool }
  let _loading = null;
  let _lastErr = '';
  let _stat = { detMs: 0, recMs: 0, boxes: 0 };

  /* ---------------- 运行时加载 ---------------- */

  function loadScript(src) {
    return new Promise((res, rej) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => res();
      el.onerror = () => rej(new Error('加载失败：' + src));
      document.head.appendChild(el);
    });
  }

  async function ensureOrt() {
    if (_ort) return _ort;
    if (_ortLoading) return _ortLoading;
    _ortLoading = (async () => {
      if (typeof ort === 'undefined') {
        try { await loadScript(ORT_DIR + '/ort.wasm.min.js'); }
        catch (e) { throw new Error('推理运行时加载失败（vendor/ort/ort.wasm.min.js）'); }
      }
      if (typeof ort === 'undefined') throw new Error('推理运行时没起来：ort 未定义');
      const env = ort.env;
      /* wasm 路径必须给**绝对 URL**：ort 内部是按 ES module specifier 去 import 那个 .mjs 的，
         相对路径会报 `Failed to resolve module specifier 'vendor/ort/...'`（第一次就栽在这）。
         另外用 ort.wasm.min.js（wasm 单后端）而不是 ort.min.js（默认带 jsep/WebGPU）——
         后者找的是 21 MB 的 jsep wasm，WebView 上既用不到又白占体积。 */
      env.wasm.wasmPaths = new URL(ORT_DIR + '/', location.href).href;
      // 见文件头「坑 1」
      env.wasm.numThreads = 1;
      env.wasm.simd = true;
      env.logLevel = 'error';
      _ort = ort;
      return _ort;
    })();
    try { return await _ortLoading; }
    catch (e) { _ortLoading = null; _lastErr = String((e && e.message) || e); throw e; }
  }

  async function loadModel(url) {
    const r = await fetch(url, { cache: 'force-cache' });
    if (!r.ok) throw new Error('模型读取失败：' + url + ' (HTTP ' + r.status + ')');
    const buf = await r.arrayBuffer();
    return new Uint8Array(buf);
  }

  async function ensureSessions() {
    const o = await ensureOrt();
    if (!_det) {
      const bytes = await loadModel(DIR + '/det.onnx');
      _det = await o.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    }
    if (!_rec) {
      const bytes = await loadModel(DIR + '/rec.onnx');
      _rec = await o.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    }
    if (!_keys) {
      const r = await fetch(DIR + '/keys.txt', { cache: 'force-cache' });
      const txt = await r.text();
      const chars = txt.split('\n').filter((x, i, a) => !(i === a.length - 1 && x === ''));
      // 字典里没有空格，但 Paddle 的 CTCLabelDecode 默认 use_space_char=True，
      // 输出类别数会比字典多 1（末尾是空格）。到底哪种，用 rec 的输出维度验，别猜。
      _keys = { chars: chars.map(c => c === '<NL>' ? '\n' : c === '<CR>' ? '\r' : c === '<TAB>' ? '\t' : c), hasSpace: null };
    }
    return { det: _det, rec: _rec };
  }

  /** 预热：第一次识别要实例化 wasm + 两个模型，手机上可能 2~5 秒。
   *  抽屉里点「本机 PaddleOCR」时就先跑一次，别让用户第一次识别等得莫名其妙。 */
  function warmup() {
    if (_loading) return _loading;
    _loading = (async () => {
      await ensureSessions();
      // 拿一张 64×64 的白图走一遍，把 wasm 编译/线程池都热起来
      const c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, 64, 64);
      await recognize(c, {});
      return true;
    })();
    try { return _loading; }
    catch (e) { _loading = null; throw e; }
  }

  /* ---------------- 预处理 ---------------- */

  /** 缩到长边 ≤ limit，宽高各自向上取 32 的倍数（det 全程 stride 32）。 */
  function detSize(w, h, limit) {
    const k = Math.min(1, limit / Math.max(1, Math.max(w, h)));
    const nw = Math.max(32, Math.ceil((w * k) / 32) * 32);
    const nh = Math.max(32, Math.ceil((h * k) / 32) * 32);
    return { nw, nh, sx: w / nw, sy: h / nh };
  }

  /** canvas → Float32 CHW，BGR 顺序（见文件头「坑 2」）。 */
  function toDetTensor(canvas, nw, nh) {
    const c = document.createElement('canvas');
    c.width = nw; c.height = nh;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    try { g.imageSmoothingQuality = 'high'; } catch (e) { }
    g.drawImage(canvas, 0, 0, nw, nh);
    const px = g.getImageData(0, 0, nw, nh).data;
    const n = nw * nh;
    const out = new Float32Array(3 * n);
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const b = px[p], gg = px[p + 1], r = px[p + 2];
      out[i] = (b / 255 - mean[0]) / std[0];
      out[n + i] = (gg / 255 - mean[1]) / std[1];
      out[2 * n + i] = (r / 255 - mean[2]) / std[2];
    }
    return out;
  }

  /* ---------------- DB 后处理 ---------------- */

  /** 连通域 + 主轴投影，得到带角度的框。
   *  返回 [{cx,cy,w,h,angle,score}]，坐标在**缩放后**的图上。 */
  function dbPost(prob, nw, nh) {
    const n = nw * nh;
    const label = new Int32Array(n).fill(-1);
    const comps = [];
    const stack = new Int32Array(n);
    for (let start = 0; start < n; start++) {
      if (label[start] !== -1 || prob[start] <= DET_THRESH) continue;
      const id = comps.length;
      let sp = 0;
      stack[sp++] = start;
      label[start] = id;
      let sX = 0, sY = 0, sXX = 0, sYY = 0, sXY = 0, sP = 0, cnt = 0;
      const pts = [];
      // 8 邻域：文字笔画细，4 邻域会把一条线断成好几段
      while (sp) {
        const q = stack[--sp];
        const x = q % nw, y = (q - x) / nw;
        pts.push(q);
        sX += x; sY += y; sXX += x * x; sYY += y * y; sXY += x * y;
        sP += prob[q]; cnt++;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= nh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = x + dx;
            if (xx < 0 || xx >= nw) continue;
            const q2 = yy * nw + xx;
            if (label[q2] === -1 && prob[q2] > DET_THRESH) { label[q2] = id; stack[sp++] = q2; }
          }
        }
      }
      if (cnt < 8) continue;
      const score = sP / cnt;
      if (score < BOX_THRESH) continue;

      const cx = sX / cnt, cy = sY / cnt;
      const cxx = sXX / cnt - cx * cx;
      const cyy = sYY / cnt - cy * cy;
      const cxy = sXY / cnt - cx * cy;
      // 主轴方向（文字行的长方向）
      const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
      for (let k = 0; k < pts.length; k++) {
        const q = pts[k];
        const x = q % nw, y = (q - x) / nw;
        const dx = x - cx, dy = y - cy;
        const u = dx * ca + dy * sa;
        const v = -dx * sa + dy * ca;
        if (u < u0) u0 = u;
        if (u > u1) u1 = u;
        if (v < v0) v0 = v;
        if (v > v1) v1 = v;
      }
      let w = u1 - u0, h = v1 - v0;
      if (w < 3 || h < 3) continue;
      // unclip：Paddle 用 pyclipper 沿多边形外扩，这里按 DB 论文的近似——
      // 外扩距离 = 面积 × ratio / 周长，长边基本不动、短边变胖（正好把字上下的空隙包进来）
      const dist = (w * h * UNCLIP) / (2 * (w + h));
      w += 2 * dist; h += 2 * dist;
      // 竖条（h 远大于 w）几乎都是画框/表格线，交给下一轮或者直接扔掉
      if (w < 4 && h < 4) continue;
      comps.push({ cx: cx + (u0 + u1) / 2 * ca - (v0 + v1) / 2 * sa,
                   cy: cy + (u0 + u1) / 2 * sa + (v0 + v1) / 2 * ca,
                   w, h, angle: ang, score });
    }
    return comps;
  }

  /** 把若干带角度的框按「先上下、再左右」排好。
   *  同一行的判定用中线容差（0.6×高度），比「y 完全相等」宽容得多。 */
  function sortBoxes(boxes) {
    const arr = boxes.slice().sort((a, b) => {
      const ra = Math.abs(Math.sin(a.angle)) > 0.7;   // 竖排：按 x 从右往左
      const rb = Math.abs(Math.sin(b.angle)) > 0.7;
      if (ra && rb) return (b.cx * (b.angle > 0 ? -1 : 1)) - (a.cx * (a.angle > 0 ? -1 : 1));
      return a.cy - b.cy;
    });
    const out = [];
    let line = [];
    let lineY = null, lineH = 0;
    const flush = () => {
      line.sort((a, b) => a.cx - b.cx);
      out.push.apply(out, line);
      line = [];
    };
    arr.forEach(b => {
      if (lineY === null) { lineY = b.cy; lineH = b.h; }
      else if (Math.abs(b.cy - lineY) > Math.max(lineH, b.h) * 0.6) { flush(); lineY = b.cy; lineH = b.h; }
      else lineH = Math.max(lineH, b.h);
      line.push(b);
    });
    if (line.length) flush();
    return out;
  }

  /* ---------------- 裁切 + 识别 ---------------- */

  /** 按角度裁一块出来并缩到高 48；返回 {canvas, k}（k = 缩放比，用于还原坐标）。 */
  function cropBox(canvas, b, sx, sy) {
    // 先还原到原图坐标
    const cx = b.cx * sx, cy = b.cy * sy;
    const w = Math.max(2, b.w * sx), h = Math.max(2, b.h * sy);
    // 高度**必须正好 48**：rec 的 inference.yml 写死了 image_shape [3,48,320]，
    // 导出成 onnx 后高度是固定轴（宽度才是动态的）。小字也要放大到 48，不能保持原高
    // —— 否则直接报 `Got invalid dimensions for input: x ... Expected: 48`。
    const k = REC_H / h;
    const ow = Math.max(8, Math.round(w * k));
    const oh = REC_H;
    const c = document.createElement('canvas');
    c.width = Math.min(REC_MAX_W, ow);
    c.height = oh;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    try { g.imageSmoothingQuality = 'high'; } catch (e) { }
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.save();
    g.translate(c.width / 2, oh / 2);
    g.rotate(b.angle);
    g.drawImage(canvas, cx - w / 2, cy - h / 2, w, h, -c.width / 2, -oh / 2, c.width, oh);
    g.restore();
    return { canvas: c, k, w, h };
  }

  function toRecTensor(canvas) {
    const w = canvas.width, h = canvas.height;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    const px = g.getImageData(0, 0, w, h).data;
    const n = w * h;
    const out = new Float32Array(3 * n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      out[i] = (px[p] / 255 - 0.5) / 0.5;          // 通道顺序对 rec 影响不大（三通道同权重），
      out[n + i] = (px[p + 1] / 255 - 0.5) / 0.5;  // 但归一化必须一致
      out[2 * n + i] = (px[p + 2] / 255 - 0.5) / 0.5;
    }
    return out;
  }

  /** CTC 贪心解码。charset = ['blank'] + 字典 [+ ' ']。 */
  function ctcDecode(data, T, C) {
    const chars = _keys.chars;
    // 输出类别数对不上就是字典/空格判断错了，按实际宽度修正一次
    const extra = C - chars.length;
    const charAt = (i) => {
      if (i <= 0) return '';
      if (i <= chars.length) return chars[i - 1];
      return extra > 1 ? ' ' : '';
    };
    let text = '', prev = -1, sum = 0, cnt = 0;
    for (let t = 0; t < T; t++) {
      const off = t * C;
      let best = -1, bi = 0;
      for (let c = 0; c < C; c++) {
        const v = data[off + c];
        if (v > best) { best = v; bi = c; }
      }
      if (bi !== 0 && bi !== prev) {
        const ch = charAt(bi);
        if (ch) { text += ch; sum += best; cnt++; }
      }
      prev = bi;
    }
    return { text, conf: cnt ? sum / cnt : 0 };
  }

  /* ---------------- 对外 ---------------- */

  /** 认一张 canvas。opts.psm 忽略（那是 Tesseract 的参数，这里不用）。 */
  async function recognize(canvas, opts) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    await ensureSessions();
    const W = canvas.width, H = canvas.height;
    if (!W || !H) return { words: [] };

    const { nw, nh, sx, sy } = detSize(W, H, DET_LIMIT);
    // BGR 图像里通道 0 是蓝 —— Paddle 的 DetResize 是直接 resize 再接 Normalize，没有额外处理
    const detIn = toDetTensor(canvas, nw, nh);
    const detFeed = {};
    detFeed[_det.inputNames[0]] = new _ort.Tensor('float32', detIn, [1, 3, nh, nw]);
    const detOut = await _det.run(detFeed);
    const tDet = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;

    const outName = _det.outputNames[0];
    const prob = detOut[outName].data;             // [1,1,nh,nw]
    let boxes = dbPost(prob, nw, nh);
    boxes = sortBoxes(boxes);

    const words = [];
    let recMs = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      // bbox 换算回**原 canvas**（上层要的是原图坐标）
      const cx = b.cx * sx, cy = b.cy * sy;
      const ca = Math.cos(b.angle), sa = Math.sin(b.angle);
      const hw = (b.w * sx) / 2, hh = (b.h * sy) / 2;
      const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [
        cx + x * ca - y * sa, cy + x * sa + y * ca
      ]);
      const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
      const bbox = {
        x0: Math.max(0, Math.min.apply(null, xs)),
        y0: Math.max(0, Math.min.apply(null, ys)),
        x1: Math.min(W, Math.max.apply(null, xs)),
        y1: Math.min(H, Math.max.apply(null, ys))
      };
      if (bbox.x1 - bbox.x0 < 4 || bbox.y1 - bbox.y0 < 4) continue;

      const crop = cropBox(canvas, b, sx, sy);
      const recIn = toRecTensor(crop.canvas);
      const feed = {};
      feed[_rec.inputNames[0]] = new _ort.Tensor('float32', recIn, [1, 3, crop.canvas.height, crop.canvas.width]);
      const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const out = await _rec.run(feed);
      recMs += (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t1;
      // v6 的 rec 可能给两个头（CTC + NRTR），取 3 维那个
      let data = null, T = 0, C = 0;
      _rec.outputNames.forEach(n => {
        const t = out[n];
        if (!t || !t.dims || t.dims.length !== 3) return;
        if (!data || t.dims[2] > C) { data = t.data; T = t.dims[1]; C = t.dims[2]; }
      });
      if (!data) continue;
      if (_keys.hasSpace === null) _keys.hasSpace = C > _keys.chars.length + 1;
      const dec = ctcDecode(data, T, C);
      const text = String(dec.text || '').trim();
      if (!text) continue;
      words.push({ text, bbox, confidence: Math.round(dec.conf * 100) });
    }

    _stat = { detMs: Math.round(tDet), recMs: Math.round(recMs), boxes: boxes.length };
    return { words };
  }

  function status() {
    return {
      ready: !!( _det && _rec ),
      err: _lastErr,
      stat: _stat,
      keys: _keys ? _keys.chars.length : 0,
      spaceChar: _keys ? _keys.hasSpace : null
    };
  }

  function dispose() {
    try { if (_det) _det.release && _det.release(); } catch (e) { }
    try { if (_rec) _rec.release && _rec.release(); } catch (e) { }
    _det = null; _rec = null; _loading = null;
  }

  return { recognize, warmup, status, dispose, ensureOrt };
})();

if (typeof window !== 'undefined') window.OcrPaddle = OcrPaddle;
