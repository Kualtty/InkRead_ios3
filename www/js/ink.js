/* ============================================================
   ink.js —— 手写 / 涂鸦画布
   ------------------------------------------------------------
   锚定模式：
     · 漫画（分页 / 卷轴）统一按「图片下标」存，key 形如 bookId:p<下标>，
       坐标归一化到「该张图片本身」（不是视口）。这样：
         - 分页与卷轴两种形态的笔迹互通（同一张图在两种形态下都是 p<idx>）；
         - 排序 / 反转 / 拆分 / 合并后，library.js 把 :p<旧> 重映射成 :p<新>，
           笔迹随图片一起搬家（坐标按图归一化，重映射不会错位）。
     · 文字书：**按「字符偏移」锚定**（本书一份 :text 记录）。每个点存成「相对锚点字符
       矩形左上角的像素偏移」，并记下落笔时的字号 afs；渲染时按当前字号 / 落笔字号的比例
       缩放 → 改字号（重排、页数变化）后笔迹仍然贴着同一段文字，粗细也跟着字一起变。
       旧版按页归一化的笔迹（:p<页> / :v）在页面渲染出来时自动迁移成偏移锚定。
   完成后画布保持可见，仅关闭 pointer-events，因此笔迹始终能看到且能随内容滚动。
   ============================================================ */
class InkCanvas {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.strokes = [];
    this.enabled = false;      // 是否接收输入
    this.mode = 'page';        // page | doc（文字书用；漫画统一走 comic 分支）
    this.tool = 'pen';
    this.color = '#000000';
    this.width = 4;
    this.current = null;
    this.erasing = false;
    this.scrollTop = 0;
    this.key = null;
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = 1; this.cssH = 1;
    // 漫画上下文：comic=是否漫画书；bookId=书 id；pageIndex=当前中心图下标
    this.context = { comic: false, bookId: null, pageIndex: 0 };
    // 文本书：本次载入的旧版（按页归一化）记录 key，保存时只回写这些，避免误删没载入的页
    this._legacyKeys = new Set();
    // R88：框选（tool='select'）。sel 存笔迹对象引用（不落库），_selDrag/_selSnap 是拖拽中的临时状态
    this.sel = new Set();
    this._selDrag = null;
    this._selSnap = null;
    // R89：落笔计数。异步读库（_loadComic/_loadText）返回时拿它对表：
    // 读库期间用户画过东西 → 那次载入作废，别把刚画的笔迹用库里的旧内容盖掉。
    this._strokeEpoch = 0;

    this._bind();
    this._frame = null;
  }

  /** 由 reader.js 在打开书 / 切形态时告知当前书上下文 */
  setContext(ctx) {
    // scroll=是否卷轴形态（true 时多图同屏，需载入全部页笔迹；false=分页只载当前页）
    // layer / pageSel：承载"按页归一化"内容的滚动层与子页选择器。
    //   漫画默认 imgLayer / .comic-img；PDF 连续卷轴复用同一套笔迹模型，传 pdfLayer / .pdf-page。
    const prev = this.context || {};
    this.context = Object.assign({ comic: false, bookId: null, pageIndex: 0, scroll: false, layer: 'imgLayer', pageSel: '.comic-img' }, ctx);
    // R88 修：换书（或文本书↔漫画切换）时立刻丢掉上一本的笔迹。
    // 否则 loadFor 之前那一小段空档里 strokes 还是「上一本的形状」，而 context 已经换了 ——
    // 文本书的笔迹（pts/偏移锚定）落进漫画分支会去读 s.points → undefined.map → 直接崩，
    // 手写工具条一点就白屏。同一本书反复 setContext（切页/滚动）不清，避免笔迹闪没。
    const b0 = prev.bookId || null, b1 = this.context.bookId || null;
    if (b0 !== b1 || !!prev.textBook !== !!this.context.textBook || !!prev.comic !== !!this.context.comic) {
      this.strokes = [];
      this.sel = new Set();
      this.key = null;
      this.current = null;
    }
  }

  /* ---------- 尺寸 ---------- */
  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) {
      // 刚打开书时阅读区可能还没布局（0×0），此时不能就这么返回：cssW 会停在 1，
      // 之后所有坐标换算全错、旧笔迹也没法迁移。稍后重试一次。
      if (!this._retryTimer) {
        this._retryTimer = setTimeout(() => { this._retryTimer = null; this.resize(); }, 120);
      }
      return;
    }
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = r.width; this.cssH = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.redraw();
    if (this.context.textBook) this._doMigrate();   // 画布有尺寸了，可以按几何位置迁移旧笔迹
  }

  setMode(mode) { this.mode = mode; this.redraw(); }
  setScrollTop(v) {
    // 文本书：锚点矩形每帧现取，滚动只要重绘（不再依赖 scrollTop 反算）
    if (this.context.textBook) { this.scheduleRedraw(); return; }
    // 漫画（分页/卷轴）坐标按图归一化，_toCanvas 实时读 imgLayer 的滚动位置，
    // 这里只要触发重绘即可（scroll 值本身由 _toCanvas 现取）。
    if (this.context.comic) { this.scrollTop = v; this.scheduleRedraw(); return; }
    if (this.mode !== 'doc') return;
    this.scrollTop = v;
    this.scheduleRedraw();
  }

  /* ---------- 显示 / 输入 ---------- */
  setEnabled(v) {
    this.enabled = v;
    if (!v) { this.current = null; this.erasing = false; this.clearSelection(); }
    this.canvas.classList.toggle('active', v);   // active → 接收指针事件
    this._syncVisible();
    if (v) this.resize();
  }

  /** 完成手写后仍显示笔迹，只是不可编辑 */
  _syncVisible() {
    const show = this.enabled || this.strokes.length > 0;
    this.canvas.classList.toggle('show', show);
  }

  /* ---------- 指针 ---------- */
  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => this._down(e));
    c.addEventListener('pointermove', e => this._move(e));
    c.addEventListener('pointerup', e => this._up(e));
    c.addEventListener('pointercancel', e => this._up(e));
    c.addEventListener('pointerleave', e => this._up(e));
    // #17：手写进行中右键取消当前这一笔（不落库），对应「点其他地方取消勾画」
    c.addEventListener('contextmenu', e => {
      if (this.enabled && this.current) { e.preventDefault(); this.cancelStroke(); }
    });
  }

  /** 取某张图**相对滚动层视口**的矩形：top/left 已经是「扣掉滚动量后的屏幕内偏移」。
   *  R89 修：原来用 offsetTop/offsetLeft，基准是 offsetParent —— 漫画的图直接挂在 #imgLayer 下
   *  （基准=layer，含 52px padding），PDF 的页挂在 .pdf-stack 里（基准=stack，少一层 padding）。
   *  笔画落点又拿 canvas 的坐标去当 layer 的坐标，两个基准一混，笔迹就整体飘一段
   *  （iPad 上表现为「手指在这、笔迹在下面」）。统一改成 getBoundingClientRect 相减，
   *  与滚动、padding、transform 缩放全都自动对上。 */
  _layout(idx) {
    const layer = $(this.context.layer || 'imgLayer');
    if (!layer) return null;
    const sel = this.context.pageSel || '.comic-img';
    const img = layer.querySelector(sel + '[data-idx="' + idx + '"]');
    if (!img) return null;
    const lr = layer.getBoundingClientRect(), r = img.getBoundingClientRect();
    return { top: r.top - lr.top, left: r.left - lr.left, w: r.width, h: r.height };
  }

  /** 屏幕坐标（clientX/clientY）→ 落在哪张图、图上归一化坐标。漫画 / PDF 连续卷轴共用。
   *  一律以「滚动层的 rect」为基准换算，不再拿画布的归一化比例乘 layer.clientWidth ——
   *  画布铺满阅读区、滚动层可能有 padding / 滚动条，两者宽高和左上角都不一定相同。 */
  _pointToPage(cx, cy) {
    const layer = $(this.context.layer || 'imgLayer');
    if (!layer) return null;
    const sel = this.context.pageSel || '.comic-img';
    const lr = layer.getBoundingClientRect();
    const rx = cx - lr.left, ry = cy - lr.top;
    const imgs = layer.querySelectorAll(sel);
    let best = null, bestD = Infinity;
    for (const im of imgs) {
      const i = parseInt(im.dataset.idx, 10);
      const r = im.getBoundingClientRect();
      const left = r.left - lr.left, top = r.top - lr.top, w = r.width, h = r.height;
      if (ry >= top && ry <= top + h && rx >= left && rx <= left + w) {
        // 统一按「宽度」归一化（x、y 都除以 w），渲染时也都乘 w：
        // 这样笔迹形状不被页面盒宽高比拉伸（修 #5/#11：漫画/文本字迹「拉长变形/压扁」）。
        // 文本页宽跨形态恒定、漫画图保持原始宽高比 → 既保形又锚定到内容。
        return { page: i, x: (rx - left) / Math.max(1, w), y: (ry - top) / Math.max(1, w) };
      }
      const d = Math.abs(ry - (top + h / 2));
      if (d < bestD) { bestD = d; best = { i, left, top, w, h }; }
    }
    if (best) {  // 没精确落在图上（缝/留白）：取最近的一张，避免笔迹丢到当前页
      // ⚠️ y 也必须除以**宽度**（best.w），不能除以高度（best.h）：
      // 上面精确命中那条分支是按宽归一化的，_toCanvas 渲染时 x、y 也都乘宽。
      // 以前这里写成 /h，只要图被缩小 / 被布局压成非正方形（图片书适应屏幕后 h≠w），
      // 在图片范围外涂写就会整体偏移（用户反馈：缩小后在图外画，笔迹和落笔位置对不上），
      // 图内涂写却没事 —— 因为只有「图外」才会走到这条兜底分支。
      return { page: best.i, x: (rx - best.left) / Math.max(1, best.w), y: (ry - best.top) / Math.max(1, best.w) };
    }
    return null;
  }

  /** 文本书「旧坐标归一化用的那个页盒」：横向分页是 #pageText（只渲染当前页），
   *  竖向卷轴是 .txt-page[data-idx=N]，富文本是 .html-book（整本一个盒，旧版 _page 恒为 0）。 */
  _pageEl(idx) {
    const ctx = this.context;
    if (!ctx.pageSel) return null;
    const layer = $(ctx.layer || 'txtLayer');
    if (!layer) return null;
    if (idx != null) {
      const one = layer.querySelector(ctx.pageSel + '[data-idx="' + idx + '"]');
      if (one) return one;
    }
    return layer.querySelector(ctx.pageSel);
  }

  /** 屏幕坐标 → 存储坐标 */
  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    const vx = (e.clientX - r.left) / Math.max(1, r.width);
    const vy = e.clientY - r.top;
    const p = (e.pressure && e.pressure > 0 && e.pointerType === 'pen') ? e.pressure : 0.5;
    if (this.context.comic) {
      const pp = this._pointToPage(e.clientX, e.clientY);
      if (pp) return { x: pp.x, y: pp.y, p, _page: pp.page };
      // 拿不到图（极端情况）：退回视口归一化 + 当前页，至少不丢笔迹
      return { x: vx, y: vy / Math.max(1, r.height), p, _page: this.context.pageIndex };
    }
    if (this.context.textBook && this.mode === 'page') {
      // 文字书旧格式：按页盒**宽度**归一化（x、y 都除以盒宽）—— 与已发布版本的
      // _pointToPage 口径一致，迁移旧笔迹才对得上位置（当年就是这么存进 DB 的）
      const pb = this._pageEl(this.context.pageIndex);
      if (pb) {
        const pr = pb.getBoundingClientRect();
        return { x: (e.clientX - pr.left) / Math.max(1, pr.width), y: (e.clientY - pr.top) / Math.max(1, pr.width), p, _page: this.context.pageIndex };
      }
    }
    if (this.mode === 'doc') return { x: vx, y: vy + this.scrollTop, p };
    return { x: vx, y: vy / Math.max(1, r.height), p };
  }

  /** 存储坐标 → 画布绘制坐标（px） */
  _toCanvas(p) {
    if (!this.context.comic && this.context.textBook && this.mode === 'page') {
      const pb = this._pageEl(p._page != null ? p._page : this.context.pageIndex);
      if (pb) {
        const pr = pb.getBoundingClientRect();
        const cr = this.canvas.getBoundingClientRect();
        const w = Math.max(1, pr.width);
        return { x: p.x * w + (pr.left - cr.left), y: p.y * w + (pr.top - cr.top) };
      }
    }
    if (this.context.comic) {
      const lay = this._layout(p._page);
      if (!lay) return { x: p.x * this.cssW, y: p.y * this.cssW };
      const layer = $(this.context.layer || 'imgLayer');
      const lr = layer ? layer.getBoundingClientRect() : { left: 0, top: 0 };
      const cr = this.canvas.getBoundingClientRect();
      // lay.top/left 已含滚动 → 这里只补「滚动层左上角 vs 画布左上角」的位移
      // （画布铺满阅读区、滚动层在其内部，两者不一定重合；不补就整体飘一截）
      const ox = lr.left - cr.left, oy = lr.top - cr.top;
      // 统一按宽度缩放（x、y 都乘 lay.w），与 _pos 的按宽归一化配对 → 笔迹形状不被盒宽高比拉伸（修 #5/#11）
      return { x: p.x * lay.w + lay.left + ox, y: p.y * lay.w + lay.top + oy };
    }
    if (this.mode === 'doc') return { x: p.x * this.cssW, y: p.y - this.scrollTop };
    return { x: p.x * this.cssW, y: p.y * this.cssH };
  }

  /* ---------- 文本书：字符偏移锚定 ---------- */

  /** 屏幕点 → 「相对锚点字符矩形」的像素偏移（落笔那一刻的字号下量的，配合 afs 做等比缩放） */
  _posRel(e, ar) {
    const p = (e.pressure && e.pressure > 0 && e.pointerType === 'pen') ? e.pressure : 0.5;
    return { rx: e.clientX - ar.left, ry: e.clientY - ar.top, p };
  }

  /** 旧版（按页盒归一化 / 文档绝对 px）坐标 → 画布坐标。迁移旧笔迹时用，不能走 _toCanvas
   *  （那个按当前 context.comic 分支，文本书的新 context 是 comic:false）。
   *  ⚠️ 文本书的旧坐标是「按页盒宽度」归一化的，页盒得按当前形态去找：
   *     横向分页 #pageText、竖向 .txt-page[data-idx]、富文本 .html-book。
   *     直接用画布尺寸换算会整体偏几十像素（实测左上各飘 ~35px），迁移出来的笔迹压不到原文。 */
  _legacyToCanvas(p) {
    const ctx = this.context;
    if (ctx.textBook) {
      const pb = this._pageEl(p._page);
      if (pb) {
        const pr = pb.getBoundingClientRect();
        const cr = this.canvas.getBoundingClientRect();
        const w = Math.max(1, pr.width);
        return { x: p.x * w + (pr.left - cr.left), y: p.y * w + (pr.top - cr.top) };
      }
    }
    if (p._page != null) {
      const lay = this._layout(p._page);
      if (lay) {
        const layer = $(this.context.layer || 'imgLayer');
        const lr = layer ? layer.getBoundingClientRect() : { left: 0, top: 0 };
        const cr = this.canvas.getBoundingClientRect();
        return {
          x: p.x * lay.w + lay.left + (lr.left - cr.left),
          y: p.y * lay.w + lay.top + (lr.top - cr.top)
        };
      }
    }
    if (this.mode === 'doc') return { x: p.x * this.cssW, y: p.y - this.scrollTop };
    return { x: p.x * this.cssW, y: p.y * this.cssH };
  }

  /** 一笔「现在」应该画在哪：返回画布坐标点 + 线宽（已按当前字号/页码尺寸缩放）。
   *  锚点字符当前不在页面上（改字号后跑到别页、或那一页还没渲染）→ 返回 null，跳过不画。 */
  _strokePoints(s) {
    const ctx = this.context;
    if (s.aoff != null && typeof ctx.rectOf === 'function') {
      // 同一偏移的锚点矩形在一次重绘里只查一次（一笔几十个点、一页一堆笔迹，别反复算 Range）
      const memo = this._rectMemo || (this._rectMemo = new Map());
      let hit = memo.get(s.aoff);
      if (hit === undefined) { hit = ctx.rectOf(s.aoff); memo.set(s.aoff, hit); }
      if (!hit || !hit.rect) return null;
      const k = (hit.fs && s.afs) ? (hit.fs / s.afs) : 1;      // 字号比例 = 笔迹缩放比例
      const cr = this.canvas.getBoundingClientRect();
      const ox = hit.rect.left - cr.left, oy = hit.rect.top - cr.top;
      return {
        pts: (s.pts || []).map(p => ({ x: ox + p.rx * k, y: oy + p.ry * k })),
        w: s.width * k
      };
    }
    // 旧格式：漫画 / PDF / 迁移失败的笔迹
    if (!Array.isArray(s.points)) return null;   // 形状对不上（笔迹挂错上下文）→ 跳过，别让整块画布崩掉
    let w = s.width;
    if (s.wn) {                       // 落笔时按「页宽」归一化的线宽 → 缩放/换排版后粗细跟着变
      const lay = this._layout(s._page != null ? s._page : ctx.pageIndex);
      if (lay && lay.w) w = s.wn * lay.w;
    }
    return { pts: s.points.map(p => this._toCanvas(p)), w };
  }

  /** 橡皮的判定点（画布坐标）：文本书直接用视口坐标，其余走原来的存储坐标映射 */
  _erasePoint(e) {
    if (this.context.textBook) {
      const cr = this.canvas.getBoundingClientRect();
      return { x: e.clientX - cr.left, y: e.clientY - cr.top };
    }
    return this._toCanvas(this._pos(e));
  }

  _down(e) {
    if (!this.enabled) return;
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { }
    if (this.tool === 'eraser') { this.erasing = true; this._eraseAt(this._erasePoint(e)); return; }
    // R88 框选：不落笔，只做「框住 / 拖动 / 拖角缩放」三种手势
    if (this.tool === 'select') { this._selDown(e); return; }
    const ctx = this.context;
    let stroke = null;
    if (ctx.textBook && typeof ctx.anchorAt === 'function') {
      const a = ctx.anchorAt(e.clientX, e.clientY);
      if (a && a.rect) {
        // 文本书：锚到「落笔点那个字符」——点存成相对该字符矩形左上角的像素偏移，
        // 连同落笔字号 afs 一起存，渲染时按当前字号比例缩放（改字号后仍贴同一段文字）。
        stroke = {
          tool: this.tool, color: this.color, width: this.width,
          afs: a.fs || 16, aoff: a.off, _ar: a.rect, pts: [this._posRel(e, a.rect)]
        };
      }
    }
    if (!stroke) {
      const pos = this._pos(e);
      stroke = { tool: this.tool, color: this.color, width: this.width, _page: pos._page, points: [pos] };
      if (this.context.comic) {
        // 线宽按页宽归一化：放大/缩小后笔画粗细跟着页面一起变
        //（原来固定 px，200% 时字变大了笔画还那么细，看着像「只有字在缩放」）
        const lay = this._layout(pos._page);
        if (lay && lay.w) stroke.wn = this.width / lay.w;
      }
    }
    this.current = stroke;
    this.strokes.push(stroke);
    this._strokeEpoch = (this._strokeEpoch || 0) + 1;   // 见 _loadComic 的并发保护
    this.redraw();
  }

  _move(e) {
    if (!this.enabled) return;
    e.preventDefault();
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    if (this.tool === 'eraser') {
      if (!this.erasing) return;
      for (const ev of evs) this._eraseAt(this._erasePoint(ev));
      return;
    }
    if (this.tool === 'select') { this._selMove(e); return; }
    if (!this.current) return;
    const anchored = this.current.aoff != null;
    const arr = anchored ? this.current.pts : this.current.points;
    const minD = anchored ? 0.5 : 0.0004;      // 锚定坐标是像素，旧格式是归一化 0~1
    for (const ev of evs) {
      const p = anchored ? this._posRel(ev, this.current._ar) : this._pos(ev);
      const last = arr[arr.length - 1];
      const dx = anchored ? (last.rx - p.rx) : (last.x - p.x);
      const dy = anchored ? (last.ry - p.ry) : (last.y - p.y);
      if (Math.abs(dx) < minD && Math.abs(dy) < minD) continue;
      arr.push(p);
    }
    this.redraw();
  }

  _up() {
    if (this.tool === 'select') { this._selUp(); return; }
    if (this.erasing) { this.erasing = false; this._save(); return; }
    if (this.current) { this.current = null; this._save(); }
  }

  /** 取消当前正在画的这一笔（不入库）。按 Esc / 右键取消时调用，
   *  解决「一旦落笔就必须画完、没法反悔」（#17：PDF/漫画/文本勾画没法轻易取消）。
   *  注意：_down 已把这一笔 push 进 strokes（绘制中），取消要把它也摘掉，否则它会留着被后续 _save 落库。 */
  cancelStroke() {
    if (this.erasing) { this.erasing = false; this.redraw(); return; }
    if (this.current) {
      const idx = this.strokes.indexOf(this.current);
      if (idx >= 0) this.strokes.splice(idx, 1);
      this.current = null;
      this.redraw();
    }
  }

  /** 橡皮：屏幕像素半径判定，支持按住拖动连续擦除。
   *  入参是**画布坐标**（文本书由 _erasePoint 直接给视口坐标，其余走存储坐标映射）。 */
  _eraseAt(c) {
    this._rectMemo = new Map();
    const rp = Math.max(16, this.width * 2.2);          // 屏幕 px
    const before = this.strokes.length;
    this.strokes = this.strokes.filter(s => {
      const g = this._strokePoints(s);
      if (!g) return true;                              // 当前不在页面上的笔迹，别因为擦不到就删掉
      for (const q of g.pts) {
        if (Math.hypot(q.x - c.x, q.y - c.y) < rp) return false;
      }
      return true;
    });
    if (this.strokes.length !== before) {
      // R88：擦掉的那笔如果正被框选，从选中集合里摘掉（否则缩放会作用到已删对象上）
      if (this.sel && this.sel.size) {
        const live = new Set(this.strokes);
        for (const s of [...this.sel]) if (!live.has(s)) this.sel.delete(s);
      }
      this.redraw(); this._save();
    }
  }

  undo() {
    if (!this.strokes.length) return;
    this.sel = new Set();          // R88：撤销后原来选中的对象可能已经不在了，直接取消选择
    this.strokes.pop(); this.redraw(); this._save();
  }
  clear() {
    this.sel = new Set();          // R88：清空后选中集合里的对象多半已经不在了
    if (this.context.textBook) {
      // 「清空本页」：只清此刻画在当前页面/视口上的笔迹。
      // 文本书的笔迹是按字符偏移锚定的，整本共用一条记录，不能像漫画那样按 _page 删，
      // 所以用「现在能不能在画布上看到它」来判断属于哪一页。
      this._rectMemo = new Map();
      const cr = this.canvas.getBoundingClientRect();
      this.strokes = this.strokes.filter(s => {
        if (s.aoff == null) return s._page != null ? s._page !== this.context.pageIndex : false;
        const g = this._strokePoints(s);
        if (!g || !g.pts.length) return true;                 // 不在当前页 → 留着
        return !g.pts.some(p => p.x > -4 && p.y > -4 && p.x < cr.width + 4 && p.y < cr.height + 4);
      });
      this.redraw();
      this._saveText();
      return;
    }
    if (this.context.comic) {
      // 只清当前页：把当前页的笔迹从内存去掉，并删掉该页记录（其它页不动）
      this.strokes = this.strokes.filter(s => s._page !== this.context.pageIndex);
      this.redraw();
      this._saveCurrentPage();
      return;
    }
    this.strokes = []; this.redraw(); this._save();
  }

  /* ---------- R88 框选：移动位置 / 缩放 / 改颜色 ----------
   * 用户需求（2026-10-30）：「加一个自由框选字迹，可移动位置、放缩和改变颜色」。
   * 做法：
   *   · 选中集合存**笔迹对象引用**（this.sel），不落库；
   *     变换直接写回原来的 pts（字符偏移锚定）/ points（归一化）字段，
   *     所以文本书那种「贴着某段文字」的笔迹搬走后仍然贴字（rx/ry 就地改）。
   *   · 手势：空白处拖 = 框选；框内拖 = 移动；四角小方块拖 = 等比缩放（对角为锚点）。
   *   · 一律在**画布坐标**里算变换，再逐点换算回存储坐标，
   *     三种锚定格式（字符偏移 / 图归一化 / 页归一化）共用同一套逻辑。
   */
  _canvasPt(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** 单笔在画布上的包围盒（含线宽） */
  _strokeBBox(s) {
    const g = this._strokePoints(s);
    if (!g || !g.pts.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of g.pts) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    const pad = Math.max(1, (g.w || 1) / 2);
    return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  }

  /** 当前选中集合在画布上的包围盒（每帧现算 → 滚动 / 翻页后自动跟着走） */
  selBBox() {
    if (!this.sel || !this.sel.size) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
    for (const s of this.sel) {
      const b = this._strokeBBox(s);
      if (!b) continue;
      any = true;
      if (b.x0 < x0) x0 = b.x0;
      if (b.y0 < y0) y0 = b.y0;
      if (b.x1 > x1) x1 = b.x1;
      if (b.y1 > y1) y1 = b.y1;
    }
    return any ? { x0, y0, x1, y1 } : null;
  }

  /** 四角手柄；ax/ay 是对角点（缩放时保持不动的那个锚点） */
  _handlesOf(bb) {
    return [
      { name: 'tl', x: bb.x0, y: bb.y0, ax: bb.x1, ay: bb.y1 },
      { name: 'tr', x: bb.x1, y: bb.y0, ax: bb.x0, ay: bb.y1 },
      { name: 'bl', x: bb.x0, y: bb.y1, ax: bb.x1, ay: bb.y0 },
      { name: 'br', x: bb.x1, y: bb.y1, ax: bb.x0, ay: bb.y0 },
    ];
  }

  _handleAt(p, bb) {
    // 命中半径跟着框的大小走（手柄本身只画 ±5px）。原来固定 16px，比手柄大三倍，
    // 小笔迹（几十像素见方）的「框中心」就落在角上 → 想拖动反而变成缩放。
    const tol = Math.min(10, Math.max(5, Math.min(bb.x1 - bb.x0, bb.y1 - bb.y0) * 0.22));
    for (const h of this._handlesOf(bb)) {
      if (Math.abs(p.x - h.x) <= tol && Math.abs(p.y - h.y) <= tol) return h;
    }
    return null;
  }

  clearSelection() {
    if (!this.sel || !this.sel.size) { this.sel = new Set(); return; }
    this.sel.clear();
    this._selDrag = null;
    this._selSnap = null;
    this.redraw();
  }

  _isSelected(s) { return !!(this.sel && this.sel.has(s)); }

  /** 框选：**框碰到就算**（笔迹包围盒与选框只要相交就选中）。
   *  R89 改：以前要求「包围盒中心落在框里」，等于非得框住一大半不可 ——
   *  用户（2026-11-01）明确不喜欢：「这个框选一定要框选该字迹的百分之几以上吗」。
   *  现在按相交判定，框到一笔的任何一部分都能选中，跟直觉一致。 */
  selectInRect(r) {
    this.sel = new Set();
    for (const s of this.strokes) {
      const b = this._strokeBBox(s);
      if (!b) continue;
      const hitX = b.x0 <= r.x1 && b.x1 >= r.x0;
      const hitY = b.y0 <= r.y1 && b.y1 >= r.y0;
      if (hitX && hitY) this.sel.add(s);
    }
    return this.sel.size;
  }

  /** 画布坐标 → 该笔的存储坐标（_toCanvas / _strokePoints 的逆运算） */
  _c2s(cx, cy, s) {
    const ctx = this.context;
    if (s.aoff != null && typeof ctx.rectOf === 'function') {
      const hit = ctx.rectOf(s.aoff);
      if (!hit || !hit.rect) return null;                  // 锚点不在当前页，算不出来
      const cr = this.canvas.getBoundingClientRect();
      const ox = hit.rect.left - cr.left, oy = hit.rect.top - cr.top;
      const k = (hit.fs && s.afs) ? (hit.fs / s.afs) : 1;
      return { rx: (cx - ox) / k, ry: (cy - oy) / k };
    }
    if (ctx.comic) {
      const lay = this._layout(s._page != null ? s._page : ctx.pageIndex);
      if (!lay || !lay.w) return null;
      const layer = $(ctx.layer || 'imgLayer');
      const lr = layer ? layer.getBoundingClientRect() : { left: 0, top: 0 };
      const cr = this.canvas.getBoundingClientRect();
      const ox = lay.left + (lr.left - cr.left), oy = lay.top + (lr.top - cr.top);
      return { x: (cx - ox) / lay.w, y: (cy - oy) / lay.w };
    }
    if (this.mode === 'doc') return { x: cx / Math.max(1, this.cssW), y: cy + this.scrollTop };
    if (ctx.textBook && this.mode === 'page') {
      const pb = this._pageEl(s._page != null ? s._page : ctx.pageIndex);
      if (!pb) return null;
      const pr = pb.getBoundingClientRect(), cr = this.canvas.getBoundingClientRect();
      const w = Math.max(1, pr.width);
      return { x: (cx - (pr.left - cr.left)) / w, y: (cy - (pr.top - cr.top)) / w };
    }
    return { x: cx / Math.max(1, this.cssW), y: cy / Math.max(1, this.cssH) };
  }

  /** 拖拽开始时给选中笔迹拍快照；之后每次移动都从快照重算，拖多久都不累积误差 */
  _selSnapshot() {
    const map = new Map();
    for (const s of this.sel) {
      const g = this._strokePoints(s);
      if (!g || !g.pts.length) continue;
      const src = (s.aoff != null) ? (s.pts || []) : (s.points || []);
      map.set(s, {
        anchored: s.aoff != null,
        pts: g.pts.map(q => ({ x: q.x, y: q.y })),
        // 原存储点整份留着：_page（漫画/PDF 属于哪张图）、p（压感）这些字段改写时不能丢。
        // 丢了 _page，_toCanvas 找不到图 → 退回按视口缩放，笔迹看着「凭空上移一大截」。
        src: src.map(q => Object.assign({}, q)),
        width: s.width,
        wn: (s.wn != null) ? s.wn : null,
      });
    }
    return map;
  }

  /** 对选中笔迹施加画布坐标变换；k = 线宽缩放倍数（纯移动传 1） */
  _xformSel(fn, k) {
    if (!this._selSnap) return;
    for (const [s, snap] of this._selSnap) {
      const out = [];
      let ok = true;
      for (const q of snap.pts) {
        const m = fn(q);
        const st = this._c2s(m.x, m.y, s);
        if (!st) { ok = false; break; }
        out.push(st);
      }
      if (!ok) continue;                                  // 这笔此刻不在页面上，先不动它
      if (snap.anchored) {
        s.pts = out.map((st, i) => Object.assign({}, snap.src[i], { rx: st.rx, ry: st.ry }));
      } else {
        s.points = out.map((st, i) => Object.assign({}, snap.src[i], { x: st.x, y: st.y }));
      }
      s.width = snap.width * (k || 1);
      if (snap.wn != null) s.wn = snap.wn * (k || 1);
    }
    this.redraw();
  }

  _selDown(e) {
    const p = this._canvasPt(e);
    this._selDrag = null;
    this._selSnap = null;
    const bb = this.selBBox();
    if (bb) {
      // 小笔迹（小于 28px 见方）且按点是「框里面」→ 一律当拖动，别跟四个角抢判定
      const small = Math.min(bb.x1 - bb.x0, bb.y1 - bb.y0) < 28;
      const inside = p.x > bb.x0 + 1 && p.x < bb.x1 - 1 && p.y > bb.y0 + 1 && p.y < bb.y1 - 1;
      const h = (small && inside) ? null : this._handleAt(p, bb);
      if (h) {                                            // 拖角 → 等比缩放
        this._selSnap = this._selSnapshot();
        this._selDrag = {
          mode: 'scale', anchor: { x: h.ax, y: h.ay }, p0: p,
          d0: Math.max(2, Math.hypot(p.x - h.ax, p.y - h.ay))
        };
        return;
      }
      if (p.x >= bb.x0 - 2 && p.x <= bb.x1 + 2 && p.y >= bb.y0 - 2 && p.y <= bb.y1 + 2) {
        this._selSnap = this._selSnapshot();               // 框内拖 → 移动
        this._selDrag = { mode: 'move', p0: p };
        return;
      }
    }
    this._selDrag = { mode: 'band', p0: p, p1: p };        // 空白处拖 → 重新框选
  }

  _selMove(e) {
    const d = this._selDrag;
    if (!d) return;
    const p = this._canvasPt(e);
    if (d.mode === 'band') { d.p1 = p; this.redraw(); return; }
    if (d.mode === 'move') {
      const dx = p.x - d.p0.x, dy = p.y - d.p0.y;
      this._xformSel(q => ({ x: q.x + dx, y: q.y + dy }), 1);
      return;
    }
    if (d.mode === 'scale') {
      const dist = Math.hypot(p.x - d.anchor.x, p.y - d.anchor.y);
      const f = Math.max(0.1, Math.min(12, dist / d.d0));
      const ax = d.anchor.x, ay = d.anchor.y;
      this._xformSel(q => ({ x: ax + (q.x - ax) * f, y: ay + (q.y - ay) * f }), f);
    }
  }

  _selUp() {
    const d = this._selDrag;
    if (!d) return;
    this._selDrag = null;
    if (d.mode === 'band') {
      const x0 = Math.min(d.p0.x, d.p1.x), x1 = Math.max(d.p0.x, d.p1.x);
      const y0 = Math.min(d.p0.y, d.p1.y), y1 = Math.max(d.p0.y, d.p1.y);
      if (x1 - x0 < 8 && y1 - y0 < 8) this.sel = new Set();   // 只是点了一下 → 取消选择
      else this.selectInRect({ x0, y0, x1, y1 });
      this.redraw();
      return;
    }
    this._selSnap = null;
    this._save();                                        // 移动 / 缩放完成才落库
  }

  /** 给选中的笔迹换颜色（工具栏色点直接生效） */
  setSelectionColor(c) {
    if (!this.sel || !this.sel.size) return 0;
    for (const s of this.sel) s.color = c;
    this.redraw();
    this._save();
    return this.sel.size;
  }

  /** 给选中的笔迹换粗细（拖「粗细」滑杆直接生效） */
  setSelectionWidth(w) {
    if (!this.sel || !this.sel.size) return 0;
    for (const s of this.sel) {
      s.width = w;
      if (s.wn != null) {                                // 漫画：线宽另存了「按页宽归一化」值，一起改
        const lay = this._layout(s._page != null ? s._page : this.context.pageIndex);
        if (lay && lay.w) s.wn = w / lay.w;
      }
    }
    this.redraw();
    this._save();
    return this.sel.size;
  }

  /** 删除选中的笔迹（框选后按 Delete/Backspace，或点工具条「删除选中」）。
   *  漫画/PDF 的笔迹按页存，某页被删空时也必须把该页记录写成空数组，
   *  否则 _save 只 upsert「内存里还有笔迹的页」，旧记录留在库里、重开书又冒出来。 */
  deleteSelection() {
    if (!this.sel || !this.sel.size) return 0;
    const dead = new Set(this.sel);
    const n = dead.size;
    this._dirtyPages = this._dirtyPages || new Set();
    for (const s of dead) if (s._page != null) this._dirtyPages.add(s._page);
    this.strokes = this.strokes.filter(s => !dead.has(s));
    this.sel = new Set();
    this._selDrag = null;
    this._selSnap = null;
    this.redraw();
    this._save();
    return n;
  }

  /* ---------- 绘制 ---------- */
  scheduleRedraw() {
    if (this._frame) return;
    this._frame = requestAnimationFrame(() => { this._frame = null; this.redraw(); });
  }

  redraw() {
    const ctx = this.ctx;
    if (!ctx || !this.cssW) return;
    this._rectMemo = new Map();          // 每次重绘重新解析锚点（滚动/字号/翻页后矩形都变了）
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    for (const s of this.strokes) {
      if (!(s.points && s.points.length) && !(s.pts && s.pts.length)) continue;
      const g = this._strokePoints(s);
      if (!g) continue;                        // 锚点字符不在当前页（改字号/翻页后），跳过
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (s.tool === 'marker') {
        ctx.globalAlpha = 0.34;
        ctx.globalCompositeOperation = 'multiply';
        ctx.strokeStyle = s.color;
        ctx.lineWidth = g.w * 2.4;
      } else {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = g.w;
      }
      const pts = g.pts;
      if (pts.length === 1) {
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i].x + pts[i + 1].x) / 2;
          const my = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
        }
        ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
        ctx.stroke();
      }
      ctx.restore();
    }
    // R88：框选的可视化（只在框选工具下出现，涂画时不会挡视线）
    if (this.tool === 'select') {
      const bb = this.selBBox();
      if (bb) {
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#0A84FF';
        ctx.strokeRect(bb.x0, bb.y0, Math.max(1, bb.x1 - bb.x0), Math.max(1, bb.y1 - bb.y0));
        ctx.setLineDash([]);
        ctx.fillStyle = '#0A84FF';
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1.5;
        for (const h of this._handlesOf(bb)) {
          ctx.fillRect(h.x - 5, h.y - 5, 10, 10);
          ctx.strokeRect(h.x - 5, h.y - 5, 10, 10);
        }
        ctx.restore();
      }
      const d = this._selDrag;
      if (d && d.mode === 'band') {
        const x0 = Math.min(d.p0.x, d.p1.x), x1 = Math.max(d.p0.x, d.p1.x);
        const y0 = Math.min(d.p0.y, d.p1.y), y1 = Math.max(d.p0.y, d.p1.y);
        ctx.save();
        ctx.fillStyle = 'rgba(10,132,255,0.10)';
        ctx.strokeStyle = '#0A84FF';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 4]);
        ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
        ctx.strokeRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
        ctx.restore();
      }
    }
    ctx.restore();
    if (this._needMigrate) this._doMigrate();
  }

  /* ---------- 持久化 ---------- */
  async loadFor(key) {
    if (this.context.textBook) return this._loadText();
    if (this.context.comic) return this._loadComic();
    if (key === this.key) return;
    this.key = key;
    this.strokes = [];
    this.sel = new Set();
    const bookId = String(key).split(':')[0];
    const all = await DB.byIndex('annots', 'bookId', bookId);
    const rec = all.find(a => a.type === 'ink' && a.key === key);
    if (rec && rec.strokes) this.strokes = rec.strokes;
    this._syncVisible();
    this.redraw();
  }

  /** 漫画：按形态载入笔迹
       - 卷轴：多图同屏，载入本书全部 :p<下标>（滚到哪张画哪张）
       - 分页：只载入当前页 :p<pageIndex>（其它页不在 DOM 里，载入会按视口归一化错位） */
  async _loadComic() {
    // R89：并发保护。refreshInk / renderPage / togglePen 都会触发 loadFor，
    // 几次 _loadComic 同时在飞时，后回来的那次会把「刚画上去的笔迹」清掉重来 →
    // 表现成「画一笔闪一下没了」「重开后笔迹条数翻倍」。
    // 双保险：① seq —— 只认最后一次；② epoch —— 读库期间用户画过东西就整次作废，
    // 绝不能用「库里的旧内容」覆盖内存里刚画的那一笔。
    const seq = this._loadSeq = (this._loadSeq || 0) + 1;
    const ep = this._strokeEpoch || 0;
    const bookId = this.context.bookId;
    if (!bookId) { this.strokes = []; this.sel = new Set(); return; }
    const all = await DB.byIndex('annots', 'bookId', bookId);
    if (seq !== this._loadSeq) return;
    if ((this._strokeEpoch || 0) !== ep) return;
    this.strokes = [];
    this.sel = new Set();
    for (const a of all) {
      if (a.type !== 'ink') continue;
      const tail = String(a.key || '').split(':')[1] || '';
      const idx = parseInt(tail.replace(/^p/, ''), 10);
      if (Number.isNaN(idx)) continue;
      if (!this.context.scroll && idx !== this.context.pageIndex) continue;   // 分页：只取当前页
      if (!Array.isArray(a.strokes)) continue;
      for (const s of a.strokes) { s._page = idx; this.strokes.push(s); }
    }
    this._syncVisible();
    this.redraw();
  }

  /* ---------- 文本书（txt / html / epub / docx）：整本一套，按字符偏移锚定 ---------- */

  /** 载入本书全部笔迹。新格式在 :text 一条记录里；旧版按页存的（:p<页> / :v）顺手迁移。
   *  分页模式下旧记录只载当前页（其它页盒子不在 DOM 里，载入必错位）。 */
  async _loadText() {
    const bookId = this.context.bookId;
    if (!bookId) return;
    const k = bookId + ':text';
    const scroll = !!this.context.scroll;
    const seq = this._loadSeq = (this._loadSeq || 0) + 1;
    const ep = this._strokeEpoch || 0;
    this._legacyKeys = new Set();
    const all = await DB.byIndex('annots', 'bookId', bookId);
    // 连续几次 refreshInk 会并发进这里，读库回来时若已有更新的那一次，就丢掉本次结果
    //（否则同一个 stroke 会被 push 好几遍 → 屏幕上笔迹叠成一条“变粗”的线）
    if (seq !== this._loadSeq) return;
    if ((this._strokeEpoch || 0) !== ep) return;   // R89：读库期间画过 → 本次作废，别覆盖
    this.strokes = [];
    this.sel = new Set();
    for (const a of all) {
      if (a.type !== 'ink' || !Array.isArray(a.strokes)) continue;
      if (a.key === k) { for (const s of a.strokes) this.strokes.push(s); continue; }
      const m = /:p(\d+)$/.exec(a.key || '');
      const pg = m ? parseInt(m[1], 10) : 0;
      if (!scroll && m && pg !== this.context.pageIndex) continue;
      let used = false;
      for (const s of a.strokes) {
        if (s.aoff != null) { this.strokes.push(s); continue; }   // 已经是偏移锚定
        s._page = pg; s._legacyKey = a.key;
        this.strokes.push(s); used = true;
      }
      if (used) this._legacyKeys.add(a.key);
    }
    this.key = k;
    this._syncVisible();
    // 迁移必须等画布有尺寸（refreshInk 里 loadFor 早于 resize，此刻 canvas 可能还是 0×0），
    // 所以先记个标记，交给 resize() 末尾做。
    this._needMigrate = true;
    this.redraw();
    if (this.cssW && this.cssH) this._doMigrate();
  }

  /** 画布尺寸就绪后把旧版笔迹迁移成偏移锚定，并立刻回写（迁移过的从 :pN 里搬走） */
  _doMigrate() {
    if (!this._needMigrate) return;
    if (!(this.cssW > 10) || !(this.cssH > 10)) return;   // 画布还没尺寸，等下次 resize/重绘再迁
    this._needMigrate = false;
    this._migrateLegacy();
    if (this._migrated) {
      this._migrated = 0;
      this._saveText();
      this.redraw();
    }
  }

  /** 旧版「按页归一化」的笔迹 → 字符偏移锚定（就地改字段，保存时回写到 :text）。
   *  只迁移「此刻真的画在当前页面/视口内」的笔迹：用它现在的画布位置反查光标，
   *  拿到的那个字符就是锚点。看不到的（在别的页/别处滚动）留着，滚到再迁。 */
  _migrateLegacy() {
    const ctx = this.context;
    if (typeof ctx.anchorAt !== 'function') return;
    const cr = this.canvas.getBoundingClientRect();
    if (!cr.width || !cr.height) return;
    let n = 0;
    for (const s of this.strokes) {
      if (s.aoff != null || !s.points || !s.points.length) continue;
      // 那一页/那个页盒还没渲染出来，坐标算不出来 → 留着，滚到/翻到再迁
      if (s._page != null) {
        const ready = this.context.textBook ? !!this._pageEl(s._page) : !!this._layout(s._page);
        if (!ready) continue;
      }
      const q0 = this._legacyToCanvas(s.points[0]);
      if (q0.x < 0 || q0.y < 0 || q0.x > cr.width || q0.y > cr.height) continue;
      const a = ctx.anchorAt(cr.left + q0.x, cr.top + q0.y);
      if (!a || !a.rect) continue;
      const ax = a.rect.left - cr.left, ay = a.rect.top - cr.top;
      s.afs = a.fs || 16;
      s.aoff = a.off;
      s.pts = s.points.map(p => {
        const q = this._legacyToCanvas(p);
        return { rx: q.x - ax, ry: q.y - ay, p: p.p };
      });
      delete s.points;
      n++;
    }
    if (n) this._migrated = n;
  }

  /** 文本书保存：:text 存全部偏移锚定的笔迹；旧版按页记录只回写「本次载入过的」，
   *  已迁移/已擦掉的从里面摘掉（摘空就删记录），没载入的页原样不动。 */
  async _saveText() {
    const bookId = this.context.bookId;
    if (!bookId) return;
    this._syncVisible();
    const recKey = bookId + ':text';
    const all = await DB.byIndex('annots', 'bookId', bookId);
    const clean = s => {
      const c = Object.assign({}, s);
      delete c._page; delete c._ar; delete c._legacyKey;
      return c;
    };
    let rec = all.find(a => a.type === 'ink' && a.key === recKey);
    if (!rec) rec = { id: 'ink-' + bookId + '-text', bookId, type: 'ink', key: recKey };
    rec.strokes = this.strokes.filter(s => s.aoff != null).map(clean);
    rec.updatedAt = Date.now();
    await DB.put('annots', rec);

    const live = new Set(this.strokes);
    for (const key of this._legacyKeys) {
      const old = all.find(a => a.type === 'ink' && a.key === key);
      if (!old) continue;
      const keep = (old.strokes || []).filter(s => live.has(s) && s.aoff == null);
      if (keep.length === (old.strokes || []).length) continue;
      if (!keep.length) { await DB.del('annots', old.id); continue; }
      old.strokes = keep; old.updatedAt = Date.now();
      await DB.put('annots', old);
    }
  }

  async _save() {
    if (this.context.textBook) return this._saveText();
    if (!this.key && !this.context.comic) return;
    this._syncVisible();
    const bookId = this.context.bookId || (this.key ? String(this.key).split(':')[0] : null);
    if (!bookId) return;

    // 漫画：按 _page 分组，逐张图 upsert 到 :p<下标>。
    // 关键：只更新「当前在内存里」的页，绝不删除其它页的记录——
    // 分页模式下 this.strokes 只含当前页，若按「未出现的页=删除」会误删全部页。
    // 显式清空某一页由 clear() 单独删该页记录。
    if (this.context.comic) {
      const groups = {};
      for (const s of this.strokes) {
        const pg = (s._page != null) ? s._page : this.context.pageIndex;
        (groups[pg] = groups[pg] || []).push(s);
      }
      // 被「框选删除」清空的页也要落盘（空数组 = 该页确实一笔不剩了）
      if (this._dirtyPages && this._dirtyPages.size) {
        for (const pg of this._dirtyPages) if (!groups[pg]) groups[pg] = [];
        this._dirtyPages.clear();
      }
      const existing = await DB.byIndex('annots', 'bookId', bookId);
      const inkRecs = existing.filter(a => a.type === 'ink' && (a.key || '').indexOf(bookId + ':p') === 0);
      for (const pgStr of Object.keys(groups)) {
        const pg = parseInt(pgStr, 10);
        const recKey = bookId + ':p' + pg;
        const rec = inkRecs.find(a => a.key === recKey) || {
          id: 'ink-' + bookId + '-p' + pg,
          bookId, type: 'ink', key: recKey
        };
        rec.strokes = groups[pg].map(s => { const c = Object.assign({}, s); delete c._page; return c; });
        rec.updatedAt = Date.now();
        await DB.put('annots', rec);
      }
      return;
    }

    // 文字书：单 key 原逻辑
    const all = await DB.byIndex('annots', 'bookId', bookId);
    const rec = all.find(a => a.type === 'ink' && a.key === this.key) || {
      id: 'ink-' + bookId + '-' + String(this.key).split(':')[1],
      bookId, type: 'ink', key: this.key
    };
    rec.strokes = this.strokes;
    rec.updatedAt = Date.now();
    await DB.put('annots', rec);
  }

  /** 只删当前页的笔迹记录（清空某一页时用，不动其它页） */
  async _saveCurrentPage() {
    if (!this.context.comic) return;
    const bookId = this.context.bookId;
    if (!bookId) return;
    const all = await DB.byIndex('annots', 'bookId', bookId);
    const recKey = bookId + ':p' + this.context.pageIndex;
    const rec = all.find(a => a.type === 'ink' && a.key === recKey);
    if (rec) await DB.del('annots', rec.id);
  }
}
