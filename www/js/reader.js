/* ============================================================
   reader.js —— 阅读器核心
   ============================================================ */

const R = {
  book: null,
  format: 'txt',
  text: '',
  pages: [],          // txt 分页结果
  pageIndex: 0,
  totalPages: 1,
  annots: [],         // 本书标注
  pdfDoc: null,
  pdfRenderTask: null,
  imgUrls: [],
  barsVisible: true,
  autoTimer: null,
  penMode: false,
  chapters: [],
  searchHits: [],
  searchIdx: -1,
  lastScrollTop: 0,
  _saveTimer: null
};

const $ = id => document.getElementById(id);
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(x => x + x).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ============================================================
   打开 / 关闭
   ============================================================ */
async function openBook(book) {
  // 老版本把 .md 当纯文本存进来的书：打开时现场转成富文本（标题/列表/表格都渲染出来，
  // 目录按 # 的层级重建）。不迁移的话用户只会看到一堆 `### 相关性` 原始符号，
  // 而且目录几乎抽不出来（用户 R57 实测「###目录识别不准确，并且没有渲染」）。
  if (book && book.format === 'txt' && typeof Importer !== 'undefined'
    && Importer.convertLegacyMarkdown && Importer.convertLegacyMarkdown(book)) {
    try { await DB.put('books', book); } catch (e) { console.warn('保存 Markdown 迁移结果失败', e); }
    setTimeout(() => toast('这个文件是 Markdown，已按标题层级重新排版'), 700);
  }
  R.book = book;
  R.format = book.format === 'txt' ? 'txt' : book.format;
  // HTML / 富文本（html/epub/docx 都渲染成 html）：抽出纯文本供「全文翻译」使用；
  // 原本 R.text 为空，会导致翻译面板报「当前书没有可翻译的正文」（#9）。
  if (book.format === 'html' && book.content && book.content.html) {
    R.text = stripHtmlToText(book.content.html);
  } else {
    // 兜底：缺 kind 但带 text 的旧书 / 手动导入也能拿到正文用于翻译（真实 importer 都设 kind:'text'，此处容错）；
    // pdf / 漫画 content 没有 .text 字段，不会误用。
    R.text = (book.content && book.content.text != null) ? book.content.text : '';
  }
  R._htmlMode = (book.format === 'html');
  R.chapters = book.chapters || [];
  R.annots = await Annot.list(book.id);
  R.pageIndex = 0;
  R.penMode = false;
  // 换书时重置「文字层可见」开关：默认**不显示**识别/文字层
  // （用户反馈「显示识别出的文字」好像默认就是开着的 —— 上一本书勾过就会带过来）。
  // R53 起只有一个总开关 _showTextLayer（数字版文字层 + OCR 层一起管），
  // 旧的两个字段保留成别名，老测试/老代码赋值后调用 applyOcrTextVisibility() 依然生效。
  R._showTextLayer = false;
  R._ocrShowList = false;                        // 抽屉里「每页识别出的文字」是否展开（与文字层无关）
  R._ocrShowText = false;
  R._pdfShowText = false;
  document.body.classList.remove('show-text');  // 开关本体在 body 上，换书一并复位
  R._ocrPages = '';                             // 上一本书填的页码别带到下一本（否则「填1、5却识别7、8」）
  R._ocrWords = null;                           // 上一本的 OCR 词框缓存也别留着
  // 图片书 OCR 状态（见「图片书 OCR」一节）：换书必须全清，否则上一本的词框会贴到新书的图上
  R._imgOcr = null;
  R._imgOcrPages = null;
  R._imgOcrText = null;
  R._imgTextLayers = null;
  R._imgOcrBusy = null;
  R._imgOcrConf = null;
  R._imgOcrBad = null;
  R._ocrCfg = null;                             // 上一本的识别语言别带过来（下面 loadOcrCfg 会读本本的）
  try { await loadOcrCfg(); } catch (e) { }

  // 上一本书的残留状态一律清掉：否则换一本同样排版设置的书会直接沿用旧分页结果
  R._layoutSig = null;
  R.pages = [];
  R.totalPages = 0;            // 空书 / 解析失败的书不该显示上一本的"1 / 500"
  R._scrollProgress = 0;
  R.searchHits = []; R.searchIdx = -1; R._searchLen = 0; R._searchKind = 'offset';
  R._pdfText = null;
  R._pdfTextFull = false;     // R70：R._pdfText 是否已「整本提取完」（OCR 会往里面塞单页，别混为一谈）
  R._scanPages = new Set();   // 扫描页（几乎无文本层）索引集合，供「一键全部 OCR」使用
  R._ocrCancel = false;       // 批量 OCR 中途停止标志
  // 目录跨书残留清理（修 #9：换书后目录抽屉仍显示上一本书的章节/折叠/多选状态）
  tocRoot = -1; tocCollapsed.clear(); tocSelectMode = false; tocChecked.clear();
  // 开着笔返回书架再打开下一本时，画布会留在屏幕上吃掉所有点击，必须真的退出手写模式
  if (R.penMode && typeof togglePen === 'function') togglePen(false);
  if ($('bookSearchInput')) $('bookSearchInput').value = '';
  if ($('searchCount')) $('searchCount').textContent = '0 结果';

  $('readerTitle').textContent = book.title;
  document.querySelector('.view-library').classList.remove('active');
  $('readerView').classList.add('active');

  applySettings(true);

  if (R.format === 'pdf') await initPdf();
  else if (R.format === 'comic') initComic();
  else if (R.format === 'html') initHtml();
  else initTxt();

  // 目录自愈：旧版导入器可能给书打了 tocDetected=true 却没存好章节（或章节结构损坏），
  // 导致新版打开时因「已识别」而跳过补识别 → 目录空白、锚点指向不存在的元素。
  // 现改为：内容类书（html/txt/epub/docx）只要章节为空或结构损坏、且非用户主动清空，就重新提取；
  // PDF 维持原逻辑（仅首次未识别时提取大纲，避免每次打开都读 PDF 大纲）。
  if (!book.tocCleared && tocChaptersBroken() && (R.format === 'pdf' ? !book.tocDetected : (R.format !== 'comic'))) {
    try { await reDetectChapters(true); } catch (e) { console.warn('自动识别目录失败', e); }
  }

  await refreshInk();
  updateChrome();
  showBars(true);
  resetBarTimer();
  setTimeout(() => toast('提示：在正文上拖动/长按可选中文字，选好后可高亮或写笔记'), 1400);
}

async function closeBook() {
  if (!R.book) {                       // 没开书时也允许调用（比如测试或返回书架）
    $('readerView').classList.remove('active');
    document.querySelector('.view-library').classList.add('active');
    applyUiBg();                       // R112：抽屉/翻译面板的配色要跟着语境回到书库
    Library.refresh();
    return;
  }
  if (R.penMode && typeof togglePen === 'function') togglePen(false);
  saveProgress(true);
  stopAuto();
  if (typeof TTS !== 'undefined') TTS.stop(true);
  releaseImages();
  if (R.pdfDoc) { try { R.pdfDoc.destroy(); } catch (e) { } R.pdfDoc = null; }
  $('readerView').classList.remove('active');
  document.querySelector('.view-library').classList.add('active');
  applyUiBg();                         // R112：同上，回到书库后抽屉配色换回界面背景
  Library.refresh();
}

/* ============================================================
   初始化各格式
   ============================================================ */
/**
 * 切书时把不属于当前格式的图层清空。
 * 只摘掉 .active 是不够的：内层 DOM 还在，一旦某条 CSS（比如卷轴模式的 display:flex）
 * 特异性压过 #imgLayer{display:none}，上一本漫画就会盖在新书上。
 * @param {string[]} keep 要保留内容的图层 id
 */
function clearLayers(keep) {
  const drop = (id) => !keep.includes(id);
  if (drop('imgLayer')) {
    const el = $('imgLayer');
    el.innerHTML = '';
    el.scrollTop = 0; el.scrollLeft = 0;
    el.dataset.fit = Settings.comicFit || 'contain';
    el.dataset.spread = 'false';
    el.removeAttribute('data-mode');
    releaseImages();                       // 顺手回收上一本漫画的 blob URL
  }
  // 这三层里有常驻的子节点（#pageText / #scrollInner / #pdfCanvas），只能清内容不能连锅端
  if (drop('txtLayer')) { const n = $('pageText'); if (n) n.innerHTML = ''; }
  if (drop('scrollLayer')) { const n = $('scrollInner'); if (n) n.innerHTML = ''; }
  if (drop('pdfLayer')) {
    const s = $('pdfStack');
    if (s) s.innerHTML = '';
    R._pdfRendered = new Set();
  }
}

function initTxt() {
  $('txtLayer').classList.add('active');
  $('scrollLayer').classList.remove('active');
  $('pdfLayer').classList.remove('active');
  $('imgLayer').classList.remove('active');
  clearLayers(['txtLayer', 'scrollLayer']);
  if ($('pdfZoomCtl')) $('pdfZoomCtl').hidden = true;
  // txt 模式也复用漫画的缩放控件，但「缩放」= 调整字号（字体随缩放同步变大变小），
  // 这样 txt 也有可见的放大/缩小，且文字始终清晰（重排版而非位图拉伸）。
  if ($('comicZoomCtl')) { $('comicZoomCtl').hidden = false; updateComicZoomLabel(); }
  relayout();
  const loc = parseInt(R.book.locator || 0);
  if (Settings.direction === 'vertical') {
    switchMode('vertical');
    scrollToOffset(loc);
  } else {
    switchMode('horizontal');
    goToPage(pageIndexForOffset(loc), true);
  }
}

/* ============================================================
   富文本（HTML）阅读：整篇渲染进 scrollInner，滚动式翻页。
   图片/表格/链接原样显示；目录与书签走元素 id 锚点；进度按滚动百分比。
   （txt 阅读完全不动，本模式是并行的独立路径。）
   ============================================================ */
function initHtml() {
  $('txtLayer').classList.remove('active');
  $('scrollLayer').classList.add('active');
  $('pdfLayer').classList.remove('active');
  $('imgLayer').classList.remove('active');
  clearLayers(['scrollLayer']);
  if ($('pdfZoomCtl')) $('pdfZoomCtl').hidden = true;
  if ($('comicModeBtn')) $('comicModeBtn').hidden = true;     // html 无分页/卷轴切换
  if ($('comicZoomCtl')) { $('comicZoomCtl').hidden = false; updateComicZoomLabel(); }  // 字号缩放
  R.pages = [{ start: 0, end: 0 }];
  R.totalPages = 1;
  renderHtmlPage();
  // 恢复阅读位置：**优先用与阅读形态无关的字符偏移 htmlOff**。
  // 旧口径（滚动百分比 / 页码比例）在「翻页 ⇄ 滚动」之间换算必然错位：
  // 一屏一页是按固定屏高切的，页码与内容长度不是线性关系，百分比搬过去就落错地方。
  // data-off 是渲染后 DOM 的累计字符偏移，两种形态下都成立，所以拿它当唯一锚点。
  const loc = R.book.locator;
  const savedOff = parseInt(R.book.htmlOff, 10);
  if (!isNaN(savedOff) && savedOff > 0) {
    requestAnimationFrame(() => htmlScrollToOffset(savedOff));
    updateChrome();
    return;
  }
  if (typeof loc === 'number' && loc > 0) {
    if (Settings.htmlPaged) {
      const pg = Math.min((R.totalPages || 1) - 1, Math.round(loc * Math.max(1, (R.totalPages || 1) - 1)));
      requestAnimationFrame(() => goToPage(pg, true));
    } else {
      requestAnimationFrame(() => htmlScrollToFraction(loc));
    }
  } else if (typeof loc === 'string' && loc) {
    requestAnimationFrame(() => htmlScrollToAnchor(loc.replace(/^#/, '')));
  }
  updateChrome();
}

function renderHtmlPage() {
  const inner = $('scrollInner');
  const html = (R.book.content && R.book.content.html) || '';
  inner.innerHTML = '<div class="html-book" data-idx="0">' + html + '</div>';
  // 给标题自动补 id：目录/书签锚点跳转依赖元素 id（修 #9：原本无 id 的标题会被目录检测丢弃）
  let n = 0;
  inner.querySelectorAll('.html-book h1, .html-book h2, .html-book h3, .html-book h4, .html-book h5, .html-book h6').forEach(h => {
    if (!h.id) h.id = 'ink-h-' + (n++);
  });
  R._htmlRendered = true;
  const layer = $('scrollLayer');
  if (layer) {
    layer.classList.toggle('html-paged', !!Settings.htmlPaged);
    layer.scrollTop = 0;
  }
  // 公式排版（KaTeX）必须排在分页**之前**：KaTeX 会改写 DOM、把行高撑开，
  // 先分页再渲染的话每页实际都比屏幕高一截 → 翻页后还得在页面里再滚一下
  // （R106 用户反馈「一页有一个 scroll」）。放在这里也保证分页测到的块高是最终高度。
  if (typeof InkMath !== 'undefined') {
    try { InkMath.renderIn(inner); } catch (e) { console.warn('公式渲染失败', e); }
  }
  // 翻页模式：把整篇内容按屏幕高切成「一屏一页」的 .html-page（#12）
  if (Settings.htmlPaged) layoutHtmlPages();
  else R.totalPages = 1;
  // 给文本块补 data-off（递增字符偏移），使划词能算出全局偏移→弹框/划线/笔记/搜索/翻译可用（修 #4）
  assignHtmlOffsets();
  bumpInkToken();                       // data-off 全部重算过，锚点索引跟着失效
  // 正文内链：点击后平滑滚动到锚点。
  // 原来只拦截 href^="#"，但 EPUB 合并成单 DOM 后，原文里的跨文件链接仍是
  // "chap2.xhtml#id" / "../Text/chap2.xhtml#id" 形式，不拦截就会让浏览器
  // 直接导航到不存在的文件，表现为「链接没反应」或 404。
  // 这里拦截所有含 '#' 且非 http(s)/mailto 的链接，只取 hash 部分作为 id 跳转。
  inner.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href') || '';
    const lower = href.toLowerCase();
    if (!href.trim()) return;
    if (lower.startsWith('http://') || lower.startsWith('https://')) {
      // 外部链接：新标签页打开，避免直接导航离开阅读器（修：外链点击丢失书本）
      a.addEventListener('click', (e) => {
        e.preventDefault();
        try { window.open(href, '_blank', 'noopener'); } catch (_) { location.href = href; }
      });
      return;
    }
    if (lower.startsWith('mailto:')) return;
    if (!href.includes('#')) return;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const id = href.split('#').pop();
      const jumped = htmlScrollToAnchor(id);
      // 目标 id 在合并后的单文档里找不到（跨文件锚点重名/丢失）→ 回退到目标文件 section 开头。
      // importer 已把跨文件链接重写成 #id + data-epub-file，保证「至少跳到那一章」。
      if (!jumped) {
        const fb = a.getAttribute('data-epub-file');
        if (fb) htmlScrollToAnchor(fb);
      }
    });
  });
  refreshInk();
  paintHtmlHighlights();   // 富文本高光 / 标记着色（修 #12：之前只入库不渲染）
}

/* 给富文本（html/epub）的文本块补 data-off：按文档顺序累计文本长度，作为该块的「全局字符偏移」。
 * 划词时 globalOffsetOf 找到最近带 data-off 的块即能算出选区偏移，弹框与翻译等得以触发（修 #4）。
 * 注意：html 没有纯文本 R.text，data-off 仅在本书渲染内稳定，用于「选词→翻译/笔记」等即时操作；
 *       只给叶子文本块（p/li/h1-6/...）补，排除 div 容器，避免父/子块重复计偏移。 */
function assignHtmlOffsets() {
  const root = document.querySelector('#scrollInner .html-book');
  if (!root) return;
  let off = 0;
  // 块级公式（div.ink-math）也要占一个 data-off：它是独立块，不算的话
  // 后面所有块的偏移都会前移「一整段公式的源码长度」，笔记指到别处。
  const blocks = root.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,dd,dt,figcaption,pre,div.ink-math');
  blocks.forEach(b => {
    // 用「源码长度」而不是 textContent.length：公式被 KaTeX 排版后，一个
    // `\theta_{0}` 在页面上只剩「θ0」，textContent 会短一大截，
    // 而标注 / 书签存的是源码口径的字符偏移 —— 按 textContent 算会让后面的块全体前移，
    // 越往后偏得越多（几十段之后笔记就指到别的段落去了）。
    const t = textLenOf(b);
    b.dataset.off = off;
    off += t;
  });
}

/** 元素的「源码文本长度」：普通文本照算，已渲染的公式取它的原始源码长度。 */
function textLenOf(el) {
  if (!el) return 0;
  if (el.nodeType === 3) return (el.nodeValue || '').length;
  if (el.nodeType !== 1) return 0;
  if (el.classList && (el.classList.contains('ink-math') || el.classList.contains('katex'))) {
    const n = parseInt(el.dataset ? el.dataset.srclen : '', 10);
    if (!isNaN(n)) return n;
  }
  let n = 0;
  for (let i = 0; i < el.childNodes.length; i++) n += textLenOf(el.childNodes[i]);
  return n;
}

/** 富文本翻页模式：某页「对齐到顶栏下沿」应有的 scrollTop。
    不能直接用 pg.offsetTop —— offsetTop 以滚动容器的 padding 边为基准，
    把 padding-top(24+44=68px 的顶栏留白) 也算进去了；直接赋值等于把整页
    顶到 y=0（顶栏背后），表现为翻页后看不到正文最上面（R64 用户反馈）。
    必须减掉 padding-top，与 CSS 里 .html-paged 的 scroll-padding-top 保持同一口径。 */
function htmlPageScrollTop(layer, pg) {
  if (!layer || !pg) return 0;
  const pad = parseFloat(getComputedStyle(layer).paddingTop) || 0;
  return Math.max(0, pg.offsetTop - pad);
}

/** 找「块内第几个字」的排版位置（给 splitTallBlock 二分用）：返回该字符所在的文本节点与偏移。 */
function _textPointAt(el, k) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  let n, left = k;
  while ((n = walker.nextNode())) {
    const len = (n.nodeValue || '').length;
    if (left > len) { left -= len; continue; }
    return { node: n, off: Math.max(0, Math.min(len, left)) };
  }
  return null;
}

/** 长段落按像素高度切成两半（给翻页模式用）。
 *  一屏装不下的单个 <p> 以前是「整段塞进一页 + 页内滚动」，用户看到的就是
 *  「这一页怎么还要再滚一下」。现在直接按行切成连续的两个 <p>，文本顺序不变，
 *  字符偏移也不变（分页后 assignHtmlOffsets 会重算）。 */
function _splitBlockAtHeight(el, maxH) {
  const texts = [];
  {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) if ((n.nodeValue || '').trim()) texts.push(n.nodeValue.length);
  }
  const total = texts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const top = el.getBoundingClientRect().top;
  const bottomAt = (k) => {
    const p = _textPointAt(el, k);
    if (!p || p.off <= 0) return 0;
    try {
      const r = document.createRange();
      r.setStart(p.node, Math.max(0, p.off - 1));
      r.setEnd(p.node, p.off);
      return r.getBoundingClientRect().bottom - top;
    } catch (e) { return 0; }
  };
  let lo = 1, hi = total, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bottomAt(mid) <= maxH) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best <= 0 || best >= total) return null;
  const p = _textPointAt(el, best);
  if (!p || p.off <= 0) return null;
  return p;
}

/** 列表（ul/ol/dl）比一屏还高：按条目分组，拆成若干个「同类列表」。
 *  不拆的话它只能整块占一页 + 页内滚动（用户看到的「html 还是有 scroll」）。
 *  分组判据用每个条目的真实顶边（getBoundingClientRect），不用 offsetHeight 累加。 */
function splitListBlock(el, maxH) {
  let kids = Array.from(el.children);
  if (!kids.length) return [el];
  // 目录式的嵌套列表：<li><a>章节</a><ol>几十个子项</ol></li>
  // 外层 li 几乎全是那个子列表，按文字切切不动（它自己只有一行链接）。
  // 先把子列表本身拆成几段，每段包一个 li 插回同一层，外层分组就正常了。
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const li of Array.from(el.children)) {
      if (li.getBoundingClientRect().height <= maxH) continue;
      const sub = li.querySelector(':scope > ul, :scope > ol');
      if (!sub || sub.getBoundingClientRect().height <= maxH * 0.5) continue;
      const chunks = splitListBlock(sub, maxH);
      if (chunks.length < 2) continue;
      let prev = li;
      chunks.forEach((c, i) => {
        if (i === 0) return;                       // 第一段留在原 li，其余各包一个 li
        const holder = document.createElement('li');
        holder.appendChild(c);
        li.parentNode.insertBefore(holder, prev.nextSibling);
        prev = holder;
      });
      changed = true;
    }
    if (!changed) break;
  }
  kids = Array.from(el.children);
  // 再把「单个条目仍然超过一屏」的条目自己拆开 —— 否则下面按条目分组时永远只有一组，
  // 结果就是「一个超长 li 独占一页 + 页内滚动」。拆出来的新 li 已经插回原位置。
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].getBoundingClientRect().height <= maxH) continue;
    const parts = splitTallBlock(kids[i], maxH);
    if (parts.length > 1) { kids.splice(i, 1, ...parts); i += parts.length - 1; }
  }
  if (kids.length < 2) return kids.length ? kids : [el];
  const cs0 = getComputedStyle(el);
  const budget = Math.max(120, maxH - (parseFloat(cs0.marginTop) || 0) - (parseFloat(cs0.marginBottom) || 0) - 6);
  const rects = kids.map(k => k.getBoundingClientRect());
  const groups = [];
  let start = 0;
  for (let i = 1; i < kids.length; i++) {
    // 判据是「这一组从首条顶边到最后一条底边」的总高（用 top 差只看单项高度，
    // 两个各占半屏的条目加起来超一屏也发现不了 —— 正是没拆开的原因）
    if (rects[i].bottom - rects[start].top > budget) { groups.push([start, i]); start = i; }
  }
  groups.push([start, kids.length]);
  if (groups.length < 2) return [el];                 // 单条就超一屏：拆不动，交给兜底
  const baseStart = parseInt(el.getAttribute('start'), 10) || 1;
  const out = [];
  groups.forEach(([a, b], gi) => {
    const box = el.cloneNode(false);                  // 空壳：保留 class/style/reversed
    box.removeAttribute('id');
    box.removeAttribute('data-off');
    if (el.tagName === 'OL') box.setAttribute('start', String(baseStart + a));
    for (let i = a; i < b; i++) box.appendChild(kids[i]);
    out.push(box);
  });
  out.forEach(box => el.parentNode.insertBefore(box, el));   // 顺序：out[0] 在最前
  el.remove();
  return out;
}

/** 表格比一屏还高：按行分组拆成多张表，表头（thead）每张都带上。 */
function splitTableBlock(el, maxH) {
  const body = el.tBodies && el.tBodies[0];
  const rows = body ? Array.from(body.rows) : Array.from(el.rows || []);
  if (rows.length < 2) return [el];
  const csT = getComputedStyle(el);
  const headH = el.tHead ? el.tHead.getBoundingClientRect().height : 0;
  const marginT = (parseFloat(csT.marginTop) || 0) + (parseFloat(csT.marginBottom) || 0);
  const budgetT = Math.max(120, maxH - headH - marginT - 8);
  const rects = rows.map(r => r.getBoundingClientRect());
  const groups = [];
  let start = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rects[i].bottom - rects[start].top > budgetT) { groups.push([start, i]); start = i; }
  }
  groups.push([start, rows.length]);
  if (groups.length < 2) return [el];
  const out = [];
  groups.forEach(([a, b]) => {
    const box = el.cloneNode(true);                   // 深拷贝：连同 colgroup / thead / caption
    const b2 = (box.tBodies && box.tBodies[0]) || box;
    Array.from(b2.rows || []).forEach((r, i) => { if (i < a || i >= b) r.remove(); });
    box.removeAttribute('id');
    box.removeAttribute('data-off');
    out.push(box);
  });
  out.forEach(box => el.parentNode.insertBefore(box, el));   // 顺序：out[0] 在最前
  el.remove();
  return out;
}

/** 把一个超高的文字块拆成若干「一屏以内」的块，返回拆出来的那串节点。 */
function splitTallBlock(el, maxH) {
  if (el.classList && (el.classList.contains('ink-math') || el.classList.contains('html-page'))) return [el];
  // 列表 / 表格：按条目、按行拆（HTML 书里最常见的「一页放不下」）
  if (el.tagName === 'UL' || el.tagName === 'OL' || el.tagName === 'DL') return splitListBlock(el, maxH);
  if (el.tagName === 'TABLE') return splitTableBlock(el, maxH);
  // 段落 / 标题 / 引文 / 代码块 / 普通容器：按文字位置二分切
  const splittable = /^(P|LI|BLOCKQUOTE|DD|DT|PRE|H1|H2|H3|H4|H5|H6|DIV|SECTION|ARTICLE)$/.test(el.tagName);
  if (!splittable) return [el];
  // 带图 / 表格 / 图形的块不按文字切（会把图切坏）；这些交给「图片按页高缩放 + 兜底」处理
  if (el.querySelector('table,figure')) return [el];
  const out = [];
  let node = el, guard = 0;
  while (node && node.offsetHeight > maxH && guard++ < 30) {
    const p = _splitBlockAtHeight(node, maxH);
    if (!p) break;
    const rest = node.cloneNode(false);
    rest.removeAttribute('id');
    rest.removeAttribute('data-off');
    try {
      const r = document.createRange();
      r.setStart(p.node, p.off);
      r.setEnd(node, node.childNodes.length);
      rest.appendChild(r.extractContents());
    } catch (e) { break; }
    if (!rest.textContent.replace(/\s/g, '')) break;
    node.parentNode.insertBefore(rest, node.nextSibling);
    out.push(node);
    node = rest;
  }
  if (node) out.push(node);
  return out;
}

/** 分页之后的「真实测量」收尾：
 *  预估分页会漏掉外边距、图片加载后的高度、内联样式的大留白 —— 于是有些页实际比一屏高，
 *  表现就是「翻到这一页还得在页里滚一下」（HTML 书尤其明显，md 书段落规整所以看不出来）。
 *  这里逐页量 scrollHeight，超了就把页尾的块挪到下一页（内容顺序不变），
 *  只剩单块还超时才退化成「页内滚动」兜底。 */
function fitPagedOverflow(pages, pageH, root) {
  const GAP = 4;
  pages.forEach(p => { p.style.minHeight = ''; p.style.maxHeight = ''; p.style.overflowY = ''; });
  let guard = 0;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    while (p.children.length > 1 && p.scrollHeight > pageH + GAP && guard++ < 4000) {
      let next = p.nextElementSibling;
      if (!next || !next.classList || !next.classList.contains('html-page')) {
        next = document.createElement('div');
        next.className = 'html-page';
        root.appendChild(next);
        pages.push(next);
      }
      next.insertBefore(p.lastElementChild, next.firstChild);
    }
  }
  pages.forEach((p, i) => {
    p.setAttribute('data-idx', i);
    p.style.minHeight = pageH + 'px';
    if (p.scrollHeight > pageH + GAP) {              // 单块本身就超过一屏：只能页内滚动
      p.style.maxHeight = pageH + 'px';
      p.style.overflowY = 'auto';
      p.style.scrollBehavior = 'auto';
    }
  });
}

/** 富文本翻页模式：把 .html-book 的顶层块按 scrollLayer 视口高切成若干 .html-page，
    每个 page 一个 data-idx，笔迹按页锚定（与漫画/PDF 同一套按图归一化逻辑）。
    已分过页时先拍平回原始顺序再重新切，避免重复嵌套。 */
function layoutHtmlPages() {
  const root = document.querySelector('#scrollInner .html-book');
  if (!root) return;
  const layer = $('scrollLayer');
  if (!layer) return;
  // 一页的高度 = **可视内容区**的高度，不是整个滚动容器的 clientHeight。
  // clientHeight 把上下 padding（顶栏 68px + 底栏 90px）也算进去了，用它当页高的话
  // 每页都会比屏幕高出一百多像素 → 翻页后总还要在页面里再滚一下（R106 用户反馈）。
  const lcs = getComputedStyle(layer);
  const padV = (parseFloat(lcs.paddingTop) || 0) + (parseFloat(lcs.paddingBottom) || 0);
  const pageH = Math.max(240, layer.clientHeight - padV - 6);
  // 拍平：若之前已是 .html-page，取回原始子节点（块被整体移动，id 仍在，无需重建锚点）
  let kids;
  if (root.firstElementChild && root.firstElementChild.classList.contains('html-page')) {
    kids = [];
    Array.from(root.children).forEach(pg => Array.from(pg.children).forEach(c => kids.push(c)));
  } else {
    // 取「最外层块」而非只取叶子文本：figure/ul/ol/table 等容器整体搬动，
    // 其内部的 img/figcaption/li/td 不再单独抽走，避免图片、表格、列表、以及嵌在其中的
    // 链接在翻页模式下丢失（修 #3：paged 模式图片/某些文字/链接就没了）。
    // 去嵌套：只留不包含在任何其它选中块里的最外层节点（figure 内的 img 不再重复搬）。
    const SEL = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,dd,dt,figcaption,img,figure,table,ul,ol,div.ink-math';
    let nodes = Array.from(root.querySelectorAll(SEL));
    nodes = nodes.filter(n => !nodes.some(m => m !== n && m.contains(n)));
    kids = nodes.length ? nodes : Array.from(root.children);
  }
  if (!kids.length) { R.totalPages = 1; return; }

  // 目录式的嵌套列表：<li><a>章节名</a><ol>几十个子项</ol></li>
  // 外层 li 一整块永远超过一屏，而按文字切又切不动（它自己只有那一行链接）。
  // 这里把里面的子列表提升成独立块，让分页能按子项把它拆开。
  // 放在 kids 收集之后：无论是首次分页还是「先拍平再分页」，都要过这一道。
  {
    const flat = [];
    kids.forEach(n => {
      if (n.nodeType !== 1) { flat.push(n); return; }
      const sub = n.querySelector(':scope > ul, :scope > ol');
      if (!sub) { flat.push(n); return; }
      const nh = n.getBoundingClientRect().height;
      const sh = sub.getBoundingClientRect().height;
      if (sh < pageH * 0.5 || nh < pageH * 0.8) { flat.push(n); return; }
      const head = [];
      const flushHead = () => {
        if (!head.length) return;
        const p = document.createElement('p');
        head.forEach(h => p.appendChild(h));
        head.length = 0;
        flat.push(p);
      };
      Array.from(n.childNodes).forEach(c => {
        if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) {
          flushHead();
          flat.push(c);
        } else head.push(c);
      });
      flushHead();
    });
    kids = flat;
  }

  // —— 保留锚点（修：翻页模式「内部链接 / 目录跳转」报「未找到锚点」）——
  // 翻页会重建 DOM（只保留 SEL 顶层块），挂在非 SEL 元素（section/span/div 等）上的
  // id/name 会被丢弃，导致 getElementById 在翻页模式永远找不到目标。
  // 这里在重建前记录所有 [id]/[name] 元素 → 其「归属块」（自身/祖先/首个后代/最近前置的 SEL 顶层块），
  // 重建后把丢失的锚点以零尺寸 <a> 重新注入归属块开头，使翻页模式也能命中。
  const anchorMap = [];
  if (!(root.firstElementChild && root.firstElementChild.classList.contains('html-page'))) {
    root.querySelectorAll('[id],[name]').forEach(el => {
      const id = el.id;
      const name = el.getAttribute ? el.getAttribute('name') : '';
      if (!id && !name) return;
      let owner = null;
      let cur = el;
      while (cur && cur !== root) { if (kids.indexOf(cur) >= 0) { owner = cur; break; } cur = cur.parentElement; }
      if (!owner) { for (const k of kids) { if (el.contains(k)) { owner = k; break; } } }
      if (!owner) { let best = null; for (const k of kids) { if (k.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) best = k; else break; } owner = best; }
      anchorMap.push({ id, name, owner });
    });
    kids.forEach((k, i) => k.setAttribute('data-kid', i));
  }

  // 一屏装不下的长段落先切碎，再进分页循环。
  // 不切的话它只能「整段独占一页 + 页内滚动」，表现就是「翻到这一页还得再滚一下」。
  {
    const expanded = [];
    kids.forEach(k => {
      if (!k.classList.contains('ink-math') && !k.classList.contains('html-page')
        && k.offsetHeight > pageH * 0.9) {
        splitTallBlock(k, pageH).forEach(x => expanded.push(x));
      } else expanded.push(k);
    });
    kids = expanded;
    kids.forEach((k, i) => k.setAttribute('data-kid', i));
  }

  // 量每个块的「顶边位置 + 高度」（相对 .html-book）。
  // 不能只累加 offsetHeight：块与块之间的外边距、KaTeX display 公式自带的 1em 上下留白
  // 都不在 offsetHeight 里，漏掉之后页面实际高度会比 pageH 高出一两百像素 ——
  // 表现就是「翻到这一页还得再滚一下」（R106 用户反馈）。
  // 用「块顶边相对页首的位移」来判断，外边的空隙自然算进去了。
  const rootRect = root.getBoundingClientRect();
  const geo = kids.map(k => {
    const r = k.getBoundingClientRect();
    return { t: r.top - rootRect.top, h: r.height };
  });
  root.innerHTML = '';
  const pages = [];
  let cur = null, pageTop = 0;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i], g = geo[i];
    const needNew = !cur || (cur.children.length > 0 && g.t - pageTop + g.h > pageH + 2);
    if (needNew) {
      cur = document.createElement('div');
      cur.className = 'html-page';
      cur.setAttribute('data-idx', pages.length);
      root.appendChild(cur);
      pages.push(cur);
      pageTop = g.t;
    }
    cur.appendChild(k);
  }
  // 记下页高：CSS 里图片限高用 var(--page-h)（以前写死 100vh-96px，
  // 比实际可视区高一百多像素，大图依然撑爆一页）。
  root.style.setProperty('--page-h', pageH + 'px');
  fitPagedOverflow(pages, pageH, root);
  R.totalPages = pages.length;
  R.book.totalPages = pages.length;
  if (R.pageIndex >= pages.length) R.pageIndex = pages.length - 1;
  const target = pages[R.pageIndex];
  if (target) layer.scrollTop = htmlPageScrollTop(layer, target);

  // 注入重建时丢失的锚点
  if (anchorMap.length) {
    for (const a of anchorMap) {
      const stillThere = (a.id && document.getElementById(a.id)) || (a.name && document.querySelector('[name="' + (window.CSS && CSS.escape ? CSS.escape(a.name) : a.name) + '"]'));
      if (stillThere) continue;
      const owner = a.owner;
      if (!owner || !owner.parentNode || !(owner.parentNode.classList && owner.parentNode.classList.contains('html-page'))) continue;
      const anchor = document.createElement('a');
      if (a.id) anchor.id = a.id;
      if (a.name) anchor.setAttribute('name', a.name);
      anchor.style.cssText = 'position:absolute;width:0;height:0;';
      owner.insertBefore(anchor, owner.firstChild);
    }
  }
}

function htmlScrollToAnchor(id) {
  if (!id) return;
  let el = document.getElementById(id);
  // 兼容 <a name="..."> 形式的锚点（部分 epub 内链用 name 而非 id）
  if (!el) {
    const sel = '[name="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]';
    el = document.querySelector(sel);
  }
  // 兜底：旧版导入器曾把标题自带 id 覆盖成 h-N，导致正文 <a href="#原id"> 失效（提示「未找到锚点」）。
  // 此时按「链接文字 ≈ 标题文字」匹配最近的一个标题，让旧书的内链也能跳转（修：内链找不到锚点）。
  if (!el) {
    const a = document.querySelector('#scrollInner a[href="#' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    const linkText = a ? (a.textContent || '').trim() : '';
    if (linkText) {
      const heads = document.querySelectorAll('#scrollInner h1,#scrollInner h2,#scrollInner h3,#scrollInner h4,#scrollInner h5,#scrollInner h6');
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      const lt = norm(linkText);
      for (const h of heads) {
        const ht = norm(h.textContent);
        if (ht && (ht === lt || ht.includes(lt) || lt.includes(ht))) { el = h; break; }
      }
    }
  }
  const layer = $('scrollLayer');
  if (!el || !layer) { toast('未找到锚点：' + id); return false; }
  if (Settings.htmlPaged) {
    // 翻页模式：直接定位到「锚点所在的那一页」，并精确对齐该页顶边。
    // 之前用「精确滚动到锚点 + 再反推页码」，当锚点落在某页底部时，scroll-snap 会把滚动
    // 吸附到下一页顶边，导致翻过目标（表现为内链跳错页）。改成直接取锚点归属的 .html-page，
    // 任何分页形态都能稳稳落到正确的页，且对齐页顶（章节标题即页首）。
    const pg = el.closest('.html-page');
    const idx = pg ? (parseInt(pg.dataset.idx, 10) || 0) : 0;
    R.pageIndex = idx;
    if (pg) layer.scrollTop = htmlPageScrollTop(layer, pg);
    refreshInk(); updateChrome(); scheduleSave();
    return true;
  }
  const r = el.getBoundingClientRect();
  const lr = layer.getBoundingClientRect();
  layer.scrollTop += (r.top - lr.top) - 8;
  return true;
}

function htmlScrollToFraction(fr) {
  const layer = $('scrollLayer');
  if (!layer) return;
  const max = Math.max(0, layer.scrollHeight - layer.clientHeight);
  layer.scrollTop = Math.min(1, Math.max(0, fr)) * max;
}

/** 富文本书签/笔记摘要：取当前视口上方最近的 h1-h3 标题，否则取视口首段文字 */
function htmlReadContext() {
  const layer = $('scrollLayer');
  const root = document.querySelector('.html-book');
  if (!layer || !root) return '';
  const top = layer.scrollTop + 12;
  let head = '';
  root.querySelectorAll('h1,h2,h3').forEach(h => {
    if (h.offsetTop <= top) head = (h.textContent || '').replace(/\s+/g, ' ').trim();
  });
  if (head) return head.slice(0, 40);
  // 没标题就抓视口内第一个非空文本节点
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n, first = '';
  while ((n = walker.nextNode())) {
    const r = n.parentNode.getBoundingClientRect();
    if (r.top >= layer.getBoundingClientRect().top && (n.nodeValue || '').trim()) {
      first = n.nodeValue.replace(/\s+/g, ' ').trim(); break;
    }
  }
  return first.slice(0, 40);
}

/** 把富文本 HTML 抽成纯文本（保留段落换行），供「全文翻译」使用（html/epub/docx 都渲染成 html，本身没有 R.text） */
function stripHtmlToText(html) {
  if (!html) return '';
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,head,meta,link').forEach(n => n.remove());
    const blocks = ['p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'li', 'tr', 'section', 'blockquote', 'pre'];
    doc.body.querySelectorAll(blocks.join(',')).forEach(n => { n.appendChild(document.createTextNode('\n')); });
    return (doc.body ? doc.body.textContent : '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
  } catch (e) { return ''; }
}

/** 当前视口内可见的富文本正文（「翻译本页」用），没有则退回整本纯文本 */
function htmlVisibleText() {
  const layer = document.getElementById('scrollLayer');
  const root = document.querySelector('.html-book');
  if (!layer || !root) return (R.text || '');
  const vr = layer.getBoundingClientRect();
  const parts = [];
  // 只取「叶子段落块」。之前把 div/section/td 也算进来，父容器与子段落会重复计入 →
  // 翻译面板条目数虚高、同一段被译两遍（用户实测：卷轴/翻页的翻译条数差很多）。
  const sel = 'h1,h2,h3,h4,h5,p,li,blockquote,dd,dt,pre';
  root.querySelectorAll(sel).forEach(el => {
    if (el.querySelector(sel)) return;
    const r = el.getBoundingClientRect();
    if (r.bottom < vr.top - 4 || r.top > vr.bottom + 4) return;
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) parts.push(t);
  });
  const v = parts.join('\n');
  return v || (R.text || '');
}

/** 把 pdf.js 的**树形**大纲按文档顺序拍平，保留真实嵌套深度。
 *  ⚠️ 旧代码 `outline.map(o => ({...level:1}))` 把多级书签全压成 1 级 ——
 *  4 层书签的 PDF 打出来是一长串顶级项，用户看到的就是「目录层级不对 / 只有一层」。 */
function flattenPdfOutline(items, level, out) {
  level = level || 1; out = out || [];
  (items || []).forEach(o => {
    if (!o) return;
    const lv = Math.min(TOC_MAX_LEVEL, Math.max(1, level));
    out.push({ title: o.title, dest: o.dest, level: lv });
    if (o.items && o.items.length) flattenPdfOutline(o.items, lv + 1, out);
  });
  return out;
}

async function initPdf() {
  $('pdfLayer').classList.add('active');
  $('txtLayer').classList.remove('active');
  $('scrollLayer').classList.remove('active');
  $('imgLayer').classList.remove('active');
  clearLayers(['pdfLayer']);
  R.pdfZoom = 1;                              // 进入 PDF 重置为「适应宽度」
  if ($('pdfZoomCtl')) $('pdfZoomCtl').hidden = false;
  if ($('comicZoomCtl')) $('comicZoomCtl').hidden = true;
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    R.pdfDoc = await pdfjsLib.getDocument({ data: R.book.content.data.slice(0) }).promise;
    R.totalPages = R.pdfDoc.numPages;
    // 目录：只有在「还没有保存过的目录」时才用 PDF 大纲自动填充；
    // 否则保留用户手动改名/删除/新增的结果（修 #7：PDF 目录之前每次打开都被大纲覆盖，编辑无效）
    try {
      if (!(R.book.chapters && R.book.chapters.length)) {
        const outline = await R.pdfDoc.getOutline();
        if (outline && outline.length) {
          // 保留大纲的树形层级（见 flattenPdfOutline），别一律压成 1 级
          R.chapters = flattenPdfOutline(outline);
        }
      }
    } catch (e) { }
    // 连续卷轴：整本拼成一条长卷，从上往下滚（类似漫画卷轴，不是单页上下滑）
    if (!R._pdfScrollBound) {
      R._pdfScrollBound = true;
      // 点 PDF 上的标记带 → 打开该标注的笔记编辑。
      // 标记带是 pointer-events:none（不挡划词），所以在这里按坐标反查；
      // 有命中也只在「没有正在划词」时才弹，避免选字时误触。
      $('pdfLayer').addEventListener('click', (e) => {
        if (R.format !== 'pdf' || R.penMode) return;
        const sel = window.getSelection && window.getSelection();
        if (sel && !sel.isCollapsed) return;
        const id = pdfHlHitTest(e.clientX, e.clientY);
        if (!id) return;
        const ann = (R.annots || []).find(x => x.id === id);
        if (!ann) return;
        e.stopPropagation();     // 不要顺带触发「点区域翻页」
        // 和 txt 一样：点标记 → 这一片所有标记的浮层（可叠加样式 / 改色 / 笔记 / 清除）
        if (!openMarkEditor(ann.start, ann.end, e.clientX, e.clientY)) openNoteComposer(ann);
      });
      $('pdfLayer').addEventListener('scroll', () => {
        if (R.format !== 'pdf') return;
        ink.setScrollTop($('pdfLayer').scrollTop);   // 笔迹随卷轴滚动重绘
        pdfLazyRender();
        const layer = $('pdfLayer'), stack = $('pdfStack');
        if (!stack) return;
        const cTop = layer.scrollTop + 48;
        let cur = 0;
        stack.querySelectorAll('.pdf-page').forEach(cv => {
          if (cv.offsetTop <= cTop) cur = parseInt(cv.dataset.idx, 10);
        });
        ink.context.pageIndex = cur;
        if (cur !== R.pageIndex) {
          R.pageIndex = cur; R.book.locator = cur;
          updateChrome(); scheduleSave();
        } else updateChrome();
      }, { passive: true });
    }
    await renderPdfStack();
    goToPage(parseInt(R.book.locator || 0), true);
  } catch (e) {
    console.error(e);
    toast('PDF 加载失败：' + e.message);
  }
}

/** 建好整本 PDF 的页面占位（按"适应宽度"算每页高度），再懒渲染进入视口的页 */
async function renderPdfStack() {
  const layer = $('pdfLayer'), stack = $('pdfStack');
  if (!layer || !stack || !R.pdfDoc) return;
  stack.innerHTML = '';
  R._pdfRendered = new Set();
  const n = R.pdfDoc.numPages;
  const availW = Math.max(100, layer.clientWidth - 32);
  for (let i = 1; i <= n; i++) {
    const page = await R.pdfDoc.getPage(i);
    const v0 = page.getViewport({ scale: 1 });
    const h = Math.round(v0.height * (availW / v0.width));
    const cv = document.createElement('canvas');
    cv.className = 'pdf-page';
    cv.dataset.idx = i - 1;
    cv.style.width = availW + 'px';
    cv.style.height = h + 'px';
    stack.appendChild(cv);
  }
  pdfLazyRender();
  restoreOcrLayers();      // 画布重建后把有缓存的 OCR 文字层贴回来（见 restoreOcrLayers）
}

/** 只渲染「进入视口 ± 一屏」的页，避免一次 raster 整本 */
async function pdfLazyRender() {
  const layer = $('pdfLayer'), stack = $('pdfStack');
  if (!layer || !stack || !R.pdfDoc) return;
  const top = layer.scrollTop, bot = top + layer.clientHeight, buf = layer.clientHeight;
  const tasks = [];
  stack.querySelectorAll('.pdf-page').forEach(cv => {
    const idx = parseInt(cv.dataset.idx, 10);
    if (R._pdfRendered && R._pdfRendered.has(idx)) return;
    const cTop = cv.offsetTop, cBot = cTop + cv.offsetHeight;
    if (cBot >= top - buf && cTop <= bot + buf) tasks.push(renderPdfPage(idx));
  });
  await Promise.all(tasks);
  syncPdfTextLayers();     // 懒渲染可能改了画布尺寸 → 文字层重新贴齐
}

function initComic() {
  $('imgLayer').classList.add('active');
  $('txtLayer').classList.remove('active');
  $('scrollLayer').classList.remove('active');
  $('pdfLayer').classList.remove('active');
  clearLayers(['imgLayer']);
  if ($('pdfZoomCtl')) $('pdfZoomCtl').hidden = true;
  if ($('comicZoomCtl')) { $('comicZoomCtl').hidden = false; updateComicZoomLabel(); }
  releaseImages();
  R._pdfText = null;                       // 上一本 PDF 的检索文本别留着
  R._pdfTextFull = false;
  R.imgUrls = R.book.content.items.map(it => URL.createObjectURL(it.blob));
  R.totalPages = R.imgUrls.length;
  goToPage(parseInt(R.book.locator || 0), true);
  hintLongComic();
  // 图片书也能「像 PDF 一样」：识别文字 → 划词 / 查词 / 翻译 / 高亮。
  // 这里把本书识别过的页读回来（只读索引，词框滚到那一页再按需解），并挂上滚动/缩放的重排。
  imgOcrState();
  R._imgTextLayers.clear();
  bindImgOcrEvents();
  loadImgOcrIndex();
}

/** 长图条漫在"分页"模式下要把一张图滚很久，提示一句可以切成卷轴 */
function hintLongComic() {
  if (Settings.comicMode === 'scroll' || !R.imgUrls.length) return;
  if (R._longHinted === R.book.id) return;
  const im = new Image();
  im.onload = () => {
    R._longHinted = R.book.id;
    if (im.naturalWidth && im.naturalHeight / im.naturalWidth > 1.6) {
      toast('这本是长图条漫 —— 点底栏「📄 分页」切成「📜 卷轴」，手指往上划就能一页接一页');
    }
  };
  im.src = R.imgUrls[0];
}

function releaseImages() {
  R.imgUrls.forEach(u => URL.revokeObjectURL(u));
  R.imgUrls = [];
}

/* ============================================================
   模式切换：horizontal（左右分页） / vertical（上下滚动）
   ============================================================ */
function switchMode(dir) {
  Settings.direction = dir;
  saveSettings();
  const vertical = dir === 'vertical';

  if (R.format === 'txt') {
    $('scrollLayer').classList.toggle('active', vertical);
    $('txtLayer').classList.toggle('active', !vertical);
    if (vertical) {
      renderScrollContent();
      scrollToOffset(parseInt(R.book.locator || 0));
    } else {
      relayout();
      goToPage(pageIndexForOffset(parseInt(R.book.locator || 0)), true);
    }
  }
  refreshInk();
  updateChrome();
}

/* ============================================================
   TXT 重排（分页）
   ============================================================ */
let paginator = null;
function contentBox() {
  const el = $('readerContent');
  /* R170：必须和 CSS 里 .page-layer 的 padding（min(边距, 18vw)）用同一个上限。
     以前分页按 56px 排、渲染按用户设的 140px 缩，两边对不上 ——
     手机上表现就是「一行只有五个字」。 */
  const m = Math.min(Settings.margin, (el.clientWidth || 360) * 0.18);
  const w = el.clientWidth - m * 2;
  const h = el.clientHeight - 44 - 60 - 8;
  return { w: Math.max(200, w), h: Math.max(120, h) };
}

function relayout() {
  if (R.format !== 'txt') return;
  if (!paginator) paginator = new Paginator();
  // 空书 / 解析失败的书：给一页空白，别让页码停在上一本的页数上
  if (!R.text) {
    R._layoutSig = '';
    R.pages = [{ start: 0, end: 0 }];
    R.totalPages = 1;
    if (R.book) R.book.totalPages = 1;
    return;
  }
  const box = contentBox();
  const sig = `${box.w}x${box.h}|${Settings.fontSize}|${Settings.lineHeight}|${Settings.letterSpacing}|${Settings.paraSpacing}|${Settings.fontFamily}|${Settings.bold}`;
  if (R._layoutSig === sig && R.pages.length) return;
  R._layoutSig = sig;
  R.pages = paginator.paginate(R.text, box.h, box.w);
  R.totalPages = R.pages.length;
  R.book.totalPages = R.totalPages;
}

/* ============================================================
   渲染：分页模式
   ============================================================ */
function buildHTML(chunk, chunkStart) {
  const lines = chunk.split('\n');
  let off = chunkStart, html = '';
  for (const line of lines) {
    html += `<p data-off="${off}">${decorate(line, off)}</p>`;
    off += line.length + 1;
  }
  return html;
}

function decorate(text, base) {
  if (!text) return '';
  const end = base + text.length;
  const hs = R.annots
    .filter(a => a.type === 'highlight' && a.end > base && a.start < end)
    .sort((a, b) => a.start - b.start);
  const srs = (R.searchHits || []).filter(i => i < end && i + R._searchLen > base);
  if (!hs.length && !srs.length) return esc(text);

  // 收集所有切点，按段渲染 —— 支持多个标记重叠时样式叠加
  const cuts = new Set([base, end]);
  for (const h of hs) {
    if (h.start > base && h.start < end) cuts.add(h.start);
    if (h.end > base && h.end < end) cuts.add(h.end);
  }
  for (const i of srs) {
    if (i > base && i < end) cuts.add(i);
    const ie = i + R._searchLen;
    if (ie > base && ie < end) cuts.add(ie);
  }
  const pts = Array.from(cuts).sort((a, b) => a - b);

  let out = '';
  for (let k = 0; k < pts.length - 1; k++) {
    const s = pts[k], e = pts[k + 1];
    if (s >= end || e > end) break;
    const seg = esc(text.slice(s - base, e - base));
    const cover = hs.filter(h => h.start <= s && h.end >= e);
    // 命中可能是多段（切点把一段命中拆开），记下它在全局结果列表里的序号，
    // 这样「上一个/下一个」才能高亮到真正对应的那一段，而不是按出现顺序瞎猜
    const hiHit = srs.find(i => i <= s && i + R._searchLen >= e);
    const hit = hiHit !== undefined;
    if (!cover.length && !hit) { out += seg; continue; }

    // 注意：'hl' 类只在「高亮」样式时才加 —— .hl 带黄色背景，
    // 若所有样式都套用会让下划线/删除线/粗体也变成黄色块
    const cls = ['mk'];
    const css = {};
    let wavyColor = '', strikeColor = '', hlColor = '', hasNote = false;
    for (const h of cover) {
      const st = h.style || 'highlight';
      const c = h.color || HL_COLORS[0];
      cls.push('mk-' + st);
      if (st === 'highlight') cls.push('hl');
      if (h.note) hasNote = true;
      // 注意用 background-color 而不是 background 简写：简写会把下面的
      // background-image（删除线/波浪线）一起重置掉。
      if (st === 'highlight') { css['background-color'] = hlFill(c); hlColor = c; }
      else if (st === 'underline') css['border-bottom'] = `2px solid ${hlLine(c)}`;
      // 删除线 / 波浪线都改用 background 图层（与 html 同一套方案）：
      // text-decoration-line 是单值属性，两者同时存在时会互相顶掉（用户实测「互斥」）。
      else if (st === 'strike') strikeColor = hlLine(c);
      else if (st === 'wavy') wavyColor = hlLine(c);
      // 粗体只加粗，不改颜色 —— 保持与正文一致，否则在浅色主题下会发灰看不清
      else if (st === 'bold') css['font-weight'] = '800';
    }
    const bgs = [], reps = [], poss = [], sizes = [];
    if (wavyColor) {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="5">' +
        '<path d="M0 4 Q2.5 0 5 4 T10 4" fill="none" stroke="' + wavyColor + '" stroke-width="1.5"/></svg>';
      // ⚠️ 这里要拼进 `style="..."` 属性里，所以 data-uri 外层必须用单引号：
      //    用 url("…") 会提前结束 style 属性，导致后面所有样式（含 --note-color）全丢。
      bgs.push("url('data:image/svg+xml;utf8," + encodeURIComponent(svg) + "')");
      reps.push('repeat-x'); poss.push('0 calc(100% - 1px)'); sizes.push('10px 5px');
    }
    if (strikeColor) {
      bgs.push('linear-gradient(' + strikeColor + ',' + strikeColor + ')');
      reps.push('no-repeat'); poss.push('0 52%'); sizes.push('100% 1.6px');
    }
    if (bgs.length) {
      css['background-image'] = bgs.join(',');
      css['background-repeat'] = reps.join(',');
      css['background-position'] = poss.join(',');
      css['background-size'] = sizes.join(',');
    }
    if (hit) { cls.push('sr'); css['background-color'] = css['background-color'] || hlFill('#FFD60A'); }
    if (hasNote) {
      cls.push('note');
      css['--note-color'] = noteAccentFor(hlColor);
    }
    // 原文被改过、位置已不可靠的标记：保留内容，但明确画出来
    if (cover.some(h => h.broken)) cls.push('mk-broken');

    // 多个标记重叠时，优先命中「有笔记」的那个，方便点击编辑
    const target = cover.find(h => h.note) || cover[cover.length - 1];
    const styleStr = Object.keys(css).map(k => `${k}:${css[k]}`).join(';');
    const hitAttr = hit ? ` data-hit="${R.searchHits.indexOf(hiHit)}"` : '';
    out += `<span class="${cls.join(' ')}" data-id="${target ? target.id : ''}"${hitAttr} style="${styleStr}">${seg}</span>`;
  }
  return out;
}

function renderPage() {
  bumpInkToken();                       // 内容/字号变了：笔迹锚点索引（偏移→矩形）必须重建
  if (R.format === 'html') { renderHtmlPage(); return; }
  if (R.format === 'txt') {
    if (Settings.direction === 'vertical') return;
    const p = R.pages[R.pageIndex];
    if (!p) return;
    const pt = $('pageText');
    pt.innerHTML = buildHTML(R.text.slice(p.start, p.end), p.start);
    pt.dataset.idx = R.pageIndex;   // 供手写笔迹按页盒归一化（与竖向卷轴同一套逻辑，修分页字迹错位）
    // txt 里也可能直接写 $$...$$（论文摘要、笔记），顺手排版一下
    if (typeof InkMath !== 'undefined' && pt.textContent.indexOf('$') >= 0) {
      try { InkMath.renderIn(pt); } catch (e) { }
    }
    animatePage(1);
  } else if (R.format === 'comic') {
    renderComicPage();
  } else if (R.format === 'pdf') {
    if ($('pdfStack')) pdfLazyRender();
  }
}

/* ============================================================
   漫画渲染：页面适配 / 双页 / 右到左
   ------------------------------------------------------------
   R.pageIndex 始终是**图片下标**（不是"屏"下标），这样开关双页
   不会让进度和书签错位。双页只在横屏生效（竖屏强行双页会太小）。
   ============================================================ */
function comicSpreadOn() {
  if (comicScrollOn()) return false;
  // 竖屏自动退回单页
  return !!Settings.comicSpread && window.innerWidth > window.innerHeight;
}
/** 连续卷轴（条漫）：整本拼成一条长卷，滚到底自然就是下一页 */
function comicScrollOn() { return R.format === 'comic' && Settings.comicMode === 'scroll'; }
function comicStep() { return comicSpreadOn() ? 2 : 1; }

/* 漫画三种翻页方向：
   ltr = 左→右（翻页往左划） / rtl = 右→左（日漫） / ttb = 上→下（连续卷轴）
   底层仍然是 comicRTL + comicMode 两个开关，这里只是把它们包装成一个更好点的概念。 */
const COMIC_DIR_LABEL = { ltr: '左→右', rtl: '右→左（日漫）', ttb: '上→下（卷轴）' };
const COMIC_DIR_ICON = { ltr: '⇄ 左右', rtl: '⇄ 右左', ttb: '⇅ 上下' };
/* 窄屏用的一字版：⇄ 和 ⇅ 区分「左右翻 / 上下滚」，右左的差别交给 title */
const COMIC_DIR_ICON_MIN = { ltr: '⇄', rtl: '⇄', ttb: '⇅' };
function comicDir() {
  if (comicScrollOn()) return 'ttb';
  return Settings.comicRTL ? 'rtl' : 'ltr';
}

/** 漫画图片缩放：v 是倍数（1=100%）。边界 0.3~3（最小 30%，最大 300%）。
 *  重绘时严格锚定当前页（R.pageIndex 不变），所以调缩放绝不会跳到别的页 / 末页。 */
function setComicZoom(v) {
  v = Math.min(3, Math.max(0.3, v || 1));
  Settings.comicZoom = v;
  saveSettings();
  if (typeof buildSettingsPanel === 'function') buildSettingsPanel();
  updateComicZoomLabel();
  if (R.format === 'comic') {
    const keep = R.pageIndex;
    renderPage();                                  // 只重绘当前页，不翻页
    if (comicScrollOn()) requestAnimationFrame(() => comicScrollTo(keep));
    updateChrome();
  }
  // 缩放后笔迹要跟着图片/页面一起缩放重绘，否则手写会错位（#195）
  if (typeof ink !== 'undefined' && ink && ink.strokes.length) ink.redraw();
}
function comicZoomBy(d) { setComicZoom((Settings.comicZoom || 1) + d); }
function comicZoomFit() { setComicZoom(1); }
/** txt 模式的「缩放」= 调整字号：字体随缩放同步放大/缩小，文字重排版保持清晰。 */
function txtZoomBy(step) {
  const v = Math.min(64, Math.max(10, (Settings.fontSize || 18) + step));
  if (v === Settings.fontSize) return;
  Settings.fontSize = v;
  saveSettings();
  applySettings(false);   // 改字号会触发 txt 重排版
  updateComicZoomLabel();
  if (typeof ink !== 'undefined' && ink && ink.strokes.length) ink.redraw();  // 字号缩放后笔迹跟随（#195）
}
function txtZoomFit() {
  Settings.fontSize = 18;
  saveSettings();
  applySettings(false);
  updateComicZoomLabel();
  if (typeof ink !== 'undefined' && ink && ink.strokes.length) ink.redraw();
}
function updateComicZoomLabel() {
  const el = $('comicZoomVal');
  if (!el) return;
  // txt / 富文本模式显示字号（px），漫画/图片模式显示缩放百分比
  if (R && (R.format === 'txt' || R.format === 'html')) el.textContent = (Settings.fontSize || 18) + 'px';
  else el.textContent = Math.round((Settings.comicZoom || 1) * 100) + '%';
}
/** 只更新缩放系数到图层，不重建 DOM（滑块拖动用，避免整页重绘导致卷轴跳动/闪烁） */
function layerApplyZoom() {
  const layer = $('imgLayer');
  if (layer) layer.style.setProperty('--z', Settings.comicZoom || 1);
}

function setComicDir(d) {
  // 三个方向是「互斥且完整」的：选了哪个就直接落到那个形态，
  // 不要再保留"两个独立开关"带来的半成品状态 —— 否则在卷轴模式下点"左右/右左"
  // 只会反转页序、界面却还是卷轴，用户以为"怎么点都没反应、必须先点卷轴才能切"。
  //   上→下(ttb) = 连续卷轴
  //   左→右(ltr) / 右→左(rtl) = 分页，并设定左右翻阅方向
  if (d === 'ttb') {
    Settings.comicMode = 'scroll';
  } else {
    Settings.comicMode = 'paged';
    Settings.comicRTL = (d === 'rtl');
  }
  saveSettings();
  if (typeof buildSettingsPanel === 'function') buildSettingsPanel();
  if (R && R.format === 'comic') { renderPage(); updateChrome(); refreshInk(); }
  toast('漫画翻页方向：' + (COMIC_DIR_LABEL[d] || d));
}

/** 卷轴模式下：当前停在「视口顶部」的那张图（以顶部为准，而非中心）。
 * 用中心判定会在「首图偏矮（如扉页）」时把中心算到下一张，导致首图被直接跳过、
 * 表现为「吞掉第一张、翻不过去」。改以视口顶部偏移量为准，首图只要露出顶部即为当前页。 */
function comicScrollIndex() {
  const layer = $('imgLayer');
  const imgs = layer.querySelectorAll('.comic-img');
  if (!imgs.length) return 0;
  const top = layer.scrollTop + 8;   // 视口顶部再下 8px，避免贴边抖动
  for (let i = imgs.length - 1; i >= 0; i--) {
    if (imgs[i].offsetTop <= top) return parseInt(imgs[i].dataset.idx, 10) || 0;
  }
  return parseInt(imgs[0].dataset.idx, 10) || 0;
}

/** 卷轴模式：滚到第 idx 张图的顶部 */
function comicScrollTo(idx) {
  const layer = $('imgLayer');
  const img = layer.querySelector(`.comic-img[data-idx="${idx}"]`);
  layer.scrollTop = img ? img.offsetTop : 0;
}

function renderComicPage() {
  const layer = $('imgLayer');
  const n = R.imgUrls.length;
  if (!n) { layer.innerHTML = ''; return; }
  layer.style.setProperty('--z', Settings.comicZoom || 1);   // 图片缩放系数（默认 1）

  /* ---------- 连续卷轴：整本一气呵成往下滚 ---------- */
  if (comicScrollOn()) {
    layer.dataset.mode = 'scroll';
    layer.dataset.fit = 'scroll';
    layer.dataset.spread = 'false';
    // 卷轴模式必须从顶部对齐：清掉分页分支遗留的 inline justify-content:center（单页分页会设 center），
    // 否则卷轴内容被垂直居中、顶部图片被推到视口上方，表现为「看不到上面几张 / 翻不到最上」（#4）。
    layer.style.justifyContent = 'flex-start';
    // 卷轴模式一律按"上→下=第1页→最后一页"的自然顺序渲染（向下滚=下一页），
    // 不再因右→左而整体倒序。右→左的"反向"语义只体现在分页模式（双页第1页在右 + 左右划方向反转，
    // renderComicPage / 滑动判断已处理）。这样卷轴方向的"上划=上页、下划=下页"在左右/右左下都一致。
    const ordered = R.imgUrls.map((u, i) => ({ u, i }));
    layer.innerHTML = ordered.map(({ u, i }) =>
      `<img class="comic-img" src="${u}" data-idx="${i}" draggable="false" ` +
      `loading="${i > 2 ? 'lazy' : 'eager'}" alt="第 ${i + 1} 页">`).join('');
    // 只绑一次（#imgLayer 是常驻节点，按书 id 反复 addEventListener 会越积越多，
    // 换书回来一次滚动就跑 N 遍 updateChrome）。回调里读的是当时的 R.book，不会串。
    if (!layer._scrollBound) {
      layer._scrollBound = true;
      layer.addEventListener('scroll', () => {
        const idx = comicScrollIndex();
        ink.setScrollTop(layer.scrollTop);   // 笔迹已按图载入，滚到哪张画哪张，无需重新拉库
        if (idx !== R.pageIndex) {
          R.pageIndex = idx;
          R.book.locator = idx;
          updateChrome();
          scheduleSave();
        } else {
          updateChrome();
        }
      }, { passive: true });
      // 用户主动手势（滚轮/触摸/拖拽）后取消程序 align 回拉（修 #202/#5）
      if (!layer._userScrollBound) {
        layer._userScrollBound = true;
        const mark = () => { R._comicUserScrolled = true; };
        layer.addEventListener('wheel', mark, { passive: true });
        layer.addEventListener('touchstart', mark, { passive: true });
        layer.addEventListener('pointerdown', mark, { passive: true });
      }
    } else {
      updateChrome();
    }
    // 图片是异步解码的，高度出来后要重新对准一次，否则会停在错误位置（首图/目标页错位）
    R._comicUserScrolled = false;
    const target = Math.max(0, Math.min(n - 1, R.pageIndex));
    // 用户主动滚动后（滚轮/触摸/拖拽）取消后续 align 回拉，避免「卷轴吞图、翻不过去」（#202/#5）
    const align = () => { if (R._comicUserScrolled) return; comicScrollTo(target); };
    // 目标图强制 eager 加载：否则懒加载的图在视口外不解码、offsetTop 恒为 0，
    // 设 scrollTop 会被浏览器夹到内容顶部，表现为「卡在前面几页、翻不到目标页」。
    const tImg = layer.querySelector(`.comic-img[data-idx="${target}"]`);
    if (tImg && !tImg.complete) {
      try { tImg.loading = 'eager'; } catch (e) {}
      tImg.addEventListener('load', align, { once: true });
      tImg.addEventListener('error', align, { once: true });
    }
    // 只等「目标页上方」的图解码（它们的高度影响目标页的 offsetTop，不解码会算错位置）；
    // 目标页及以下的图加载完**不再**回拉滚动条 —— 否则往下滚时下方的图一解码就把视图
    // 拽回目标页，表现为「卷轴吞图、翻不过去」（#202）。
    layer.querySelectorAll('.comic-img').forEach(img => {
      const di = parseInt(img.dataset.idx, 10);
      if (img.complete || di >= target) return;
      img.addEventListener('load', align, { once: true });
      img.addEventListener('error', align, { once: true });
    });
    requestAnimationFrame(align);
    setTimeout(align, 600);   // 兜底：个别图解码慢时再对准一次，避免停在错误位置
    scheduleImgLayerSync();   // 有识别过文字的页要把透明文字层重新贴回来（滚到哪建到哪）
    return;
  }
  layer.dataset.mode = 'paged';

  const step = comicStep();
  let i = Math.max(0, Math.min(n - 1, R.pageIndex));
  if (step === 2) i -= i % 2;          // 对齐到偶数，避免半屏错位
  R.pageIndex = i;

  const idxs = step === 2 ? [i, i + 1].filter(x => x < n) : [i];
  // 日漫：右边才是第一页，所以整屏顺序要反过来
  const order = Settings.comicRTL ? idxs.slice().reverse() : idxs;
  layer.dataset.fit = Settings.comicFit || 'contain';
  layer.dataset.spread = String(idxs.length > 1);
  // 单页：始终居中（左右/右左都居中，RTL 的"第一页在最右"是整本书的页序含义——
  // 即往右点到头是第一页、翻页顺序反向，体现在双页 reverse，而不是把单页顶到屏幕右边留一片空白）。
  // 双页（spread）时顺序已在上面 reverse，不再单独挪。
  layer.style.justifyContent = (idxs.length === 1) ? 'center' : '';
  // draggable=false：否则手指/鼠标按在图上会触发浏览器原生的"拖图片"，
  // 把 pointer 事件掐断，表现为"划了但翻不了页"
  layer.innerHTML = order.map(x =>
    `<img class="comic-img" src="${R.imgUrls[x]}" data-idx="${x}" draggable="false" ` +
    `alt="第 ${x + 1} 页">`).join('');
  scheduleImgLayerSync();     // 换页 / 缩放 / 切 fit 后：有 OCR 的页把文字层贴回来
}

/* ============================================================
   滑动翻页（iPad 上必须能用手指划，不能只靠底栏按钮）
   ------------------------------------------------------------
   左右划 = 上一页 / 下一页（日漫右→左时方向反过来）
   上下划 = 同样翻页，但**只在当前内容没法继续滚动时**才触发，
            否则会把"上下滚动正文"和"上下翻页"打架。
   会主动避让：手写模式、正在选中文字、点到工具栏/弹层/按钮上。
   ============================================================ */
const SWIPE_MIN = 56;          // 触发阈值（px）
let _swipe = null;

/**
 * 这一划是不是"还想滚动内容"？
 * 上下滚动的小说、按宽度铺满的长条漫画、按高度铺满的横向卷轴，
 * 手指划过去时应该交给浏览器滚动，而不是翻页。
 */
function _scrollRoom(target, dx, dy, stop) {
  // 漫画分页模式：整页就是一屏，不存在"还能滚内容"，左右/上下划都应翻页，
  // 不要再被当成"滚动图片"吃掉（否则竖排漫画点上下完全翻不了页）。
  if (R.format === 'comic' && !comicScrollOn()) return false;
  const EDGE = 28;   // 只剩这么点就不算了：滚到头再继续划，就该翻页，别把人卡在一页里
  // 亚像素 / 边框造成的 1~2px 溢出不算「能滚」：漫画分页时图片常比容器宽一两个像素，
  // 之前会把「左划」判成「横向还能滚」而吃掉手势 —— 实测左划永不翻页、右划正常。
  const MIN_ROOM = 8;
  let el = target;
  while (el && el !== stop && el.nodeType === 1) {
    const st = getComputedStyle(el);
    if (/(auto|scroll)/.test(st.overflowY) && Math.abs(dy) > Math.abs(dx)
        && el.scrollHeight - el.clientHeight > MIN_ROOM) {
      const down = el.scrollTop > EDGE;                                          // 还能往上滚
      const up = el.scrollTop + el.clientHeight < el.scrollHeight - EDGE;        // 还能往下滚
      if ((dy > 0 && down) || (dy < 0 && up)) return true;
    }
    if (/(auto|scroll)/.test(st.overflowX) && Math.abs(dx) >= Math.abs(dy)
        && el.scrollWidth - el.clientWidth > MIN_ROOM) {
      const left = el.scrollLeft > EDGE;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - EDGE;
      if ((dx > 0 && left) || (dx < 0 && right)) return true;
    }
    el = el.parentElement;
  }
  return false;
}

function initSwipe() {
  const el = $('readerView');
  if (!el || el._swipeBound) return;
  el._swipeBound = true;

  /** 这一下是不是点在工具栏 / 弹层 / 手写画布上（这些地方不翻页） */
  const busy = (target) => {
    if (!R.book || R.penMode) return true;
    if (Settings.swipeTurn === false) return true;
    if (target && target.closest && target.closest(
      '.bar, .drawer, .sheet, #selPopover, button, input, textarea, .ink-canvas')) return true;
    return false;
  };

  const clearSel = () => {
    const s = window.getSelection && window.getSelection();
    if (s && !s.isCollapsed) s.removeAllRanges();
  };

  /** 这一下是不是按在"已经选中的文字"上（那就是在调整选区，不是划动翻页） */
  const onSelection = (target, x, y) => {
    const s = window.getSelection && window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) return false;
    if (!(target && target.closest && target.closest('#pageText, #pdfLayer'))) return false;
    const r = s.getRangeAt(0).getBoundingClientRect();
    return x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 6;
  };

  /** 这次手势里已经划出文字选区了吗（鼠标划词选字的信号） */
  const dragSelected = () => {
    const s = window.getSelection && window.getSelection();
    return !!(s && !s.isCollapsed && s.toString().trim());
  };

  const start = (target, x, y, touch) => {
    if (busy(target)) return;
    _swipe = { x, y, done: false, touch: !!touch, ptr: !touch, had: onSelection(target, x, y) };
  };

  /** @returns {boolean} 是否翻了页 */
  const step = (target, x, y) => {
    if (!_swipe || _swipe.done) return false;
    const dx = x - _swipe.x, dy = y - _swipe.y;
    if (Math.abs(dx) < SWIPE_MIN && Math.abs(dy) < SWIPE_MIN) return false;
    _swipe.done = true;
    if (busy(target)) return false;
    if (_swipe.had) return false;                            // 正在改选区
    // 鼠标划词选字优先：手指划动不需要先选中文字，鼠标拖过去就是在选字
    if (!_swipe.touch && dragSelected()) return false;
    // 内容本身还能滚 → 让浏览器去滚，别抢手势
    if (_scrollRoom(target, dx, dy, el)) return false;

    if (Math.abs(dx) > Math.abs(dy) * 1.2) {
      // PDF 连续卷轴：横向手势不翻页（否则左右划会变成翻「一屏」，看起来像上下滑），
      // 只保留竖向原生滚动。
      if (R.format === 'pdf') return false;
      clearSel();                                            // 划动翻页不该留下一片选中文字
      // 漫画分页：左→右(LTR) 与 右→左(RTL) 的手感要反过来。
      //   LTR：左划=下一页（手指往左推走当前页，下一页从右边进来）
      //   RTL：右划=下一页（日漫：下一页在左边，往右推才露出来）
      // ⚠️ 这两个方向和第 1 版一致（git HEAD 里 `rtl ? dx>0 : dx<0`）；
      //    26 轮整理漫画方向时符号写反了，导致「左划翻不了页」，已改回。
      const goNext = Settings.comicRTL ? (dx > 0) : (dx < 0);
      goNext ? nextPage() : prevPage();
      return true;
    }
    if (Math.abs(dy) > Math.abs(dx) * 1.2) {
      clearSel();
      dy < 0 ? nextPage() : prevPage();                      // 上划=下一页，下划=上一页
      return true;
    }
    return false;
  };

  /**
   * 收尾。手指手势和鼠标手势各记各的：
   * 触屏上浏览器会先抛一个 pointercancel，要是被它清掉状态，
   * 后面的 touchmove 就全都白划了。
   */
  const end = (fromTouch) => {
    if (!_swipe) return;
    if (fromTouch || _swipe.ptr) _swipe = null;
  };

  /* 手指：走 touch 事件。
     注意不能用 pointer 事件 —— 触屏上 Chrome/Safari 会在第一次 move 之后
     直接抛 pointercancel（因为浏览器把手势判给了滚动），划到一半就断，
     表现就是"划了但翻不了页"。touchmove 不会断。 */
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { end(); return; }           // 双指缩放不算
    const t = e.touches[0];
    start(e.target, t.clientX, t.clientY, true);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!_swipe || e.touches.length !== 1) return;
    const t = e.touches[0];
    step(e.target, t.clientX, t.clientY);
  }, { passive: true });
  ['touchend', 'touchcancel'].forEach(ev =>
    el.addEventListener(ev, () => end(true), { passive: true }));

  /* 鼠标 / 触控笔：走 pointer 事件 */
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;                   // 交给上面
    start(e.target, e.clientX, e.clientY, e.pointerType === 'pen');
  }, { passive: true });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' || !_swipe) return;
    step(e.target, e.clientX, e.clientY);
  }, { passive: true });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev =>
    el.addEventListener(ev, () => end(false), { passive: true }));
}

function animatePage(dir) {
  const el = $('pageText');
  el.animate(
    [{ transform: `translateX(${dir * 26}px)`, opacity: 0.15 }, { transform: 'translateX(0)', opacity: 1 }],
    { duration: 190, easing: 'cubic-bezier(.32,.72,0,1)' }
  );
}

/* ============================================================
   PDF 渲染
   ============================================================ */
/** 画布上是否真的画了东西（缩小抽样判断）。
 *  用途：区分「空白页」和「这一页还没渲染」——renderPdfStack 只给每页建了画布占位，
 *  没进过视口的页 canvas 还是默认 300×150 全透明，Tesseract 拿到只会回「没有文字」，
 *  用户看到的就是「不往下滑就识别不了第 X 页，说是空白」（R55 实测）。 */
function pdfCanvasHasInk(cv) {
  try {
    const w = cv.width | 0, h = cv.height | 0;
    if (!w || !h) return false;
    const sw = 120, sh = Math.max(1, Math.round(h * sw / w));
    const c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    const g = c.getContext('2d');
    g.drawImage(cv, 0, 0, sw, sh);
    const d = g.getImageData(0, 0, sw, sh).data;
    for (let k = 0; k < d.length; k += 4) {
      if (d[k + 3] > 16 && (d[k] < 244 || d[k + 1] < 244 || d[k + 2] < 244)) return true;
    }
    return false;
  } catch (e) { return true; }     // 取不到像素就当有内容，交给 OCR 自己判断
}

/** 渲染单页到它的画布（连续卷轴里每页一个 canvas）。i 为 0 基页下标。 */
async function renderPdfPage(i) {
  if (!R.pdfDoc) return;
  const stack = $('pdfStack');
  const cv = stack && stack.querySelector('.pdf-page[data-idx="' + i + '"]');
  if (!cv) return;
  const num = i + 1;
  try {
    if (cv._task) { try { cv._task.cancel(); } catch (e) { } }
    const page = await R.pdfDoc.getPage(num);
    const box = $('pdfLayer');
    const availW = Math.max(100, box.clientWidth - 32);
    const v0 = page.getViewport({ scale: 1 });
    const scale = (availW / v0.width) * (R.pdfZoom || 1);   // 1=适应宽度；>1 放大可上下滚看细节
    const viewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.floor(viewport.width * dpr);
    cv.height = Math.floor(viewport.height * dpr);
    cv.style.width = viewport.width + 'px';
    cv.style.height = viewport.height + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cv._task = page.render({ canvasContext: ctx, viewport });
    await cv._task.promise;
    cv._task = null;
    if (R._pdfRendered) R._pdfRendered.add(i);
    updatePdfZoomLabel();
    cv._viewport = viewport;          // 供扫描页「点此识别」按需触发 OCR 时复用
    // 文字层：数字版 PDF 把文本抽成可选中的透明叠层 → 划词 / 复制 / 查词 / 搜索
    // ⚠️ 已经 OCR 过的扫描页优先用缓存的词框重建：以前这里无条件重建 PDF 文字层，
    //    会把 OCR 层删掉、换回「🔍 点此识别」——缩放一次文字就没了（用户说的「时灵时不灵」）。
    const ocrRec = R._ocrWords && R._ocrWords[i];
    if (ocrRec && ocrRec.words && ocrRec.words.length) {
      buildOcrLayer(i, cv, ocrRec, viewport);
    } else try {
      const txt = await buildPdfTextLayer(cv, page, viewport, i);
      // 扫描版 / 图片型 PDF（几乎无文本层）
      if (txt.trim().length < 4) {
        if (pdfShouldAutoOcr()) {
          await ocrPdfPage(i, cv, viewport);     // 自动识别（设置开启）
        } else {
          markPdfPageScanned(cv, i);             // 否则放「🔍 点此识别」覆盖层，由用户逐页决定（修 #20）
          if (!R._scanHintShown) {
            R._scanHintShown = true;
            toast('检测到扫描页：点页面上的 🔍 可识别文字（设置里可开启自动 OCR）');
          }
        }
      }
    } catch (e) { console.warn('PDF 文字层构建失败', e); }
  } catch (e) {
    if (e && e.name !== 'RenderingCancelledException') console.warn(e);
  }
}

/** 矩阵相乘（pdf.js Util.transform 不可用时兜底） */
function _matMul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ];
}
function _txf(viewport, t) {
  return (pdfjsLib.Util && pdfjsLib.Util.transform)
    ? pdfjsLib.Util.transform(viewport.transform, t)
    : _matMul(viewport.transform, t);
}

/**
 * 按标注区间算出「文字真实渲染盒」——用 Range.getClientRects()，返回视口坐标系矩形数组。
 * 为什么不用 span 的自然宽度 / transform 反推：PDF 文字层的 span 被 scaleX 拉伸过，
 * 背景盒与字形宽度/高度都不一致（实测高光带只盖住半个字、上下被压成一条）。
 * 让浏览器自己算选区矩形，宽度天然等于字形宽、高度等于字号盒，最贴近 PDF 阅读器的效果。
 */
function pdfAnnotRects(spans, a) {
  // ⚠️ 不要用 Range.getClientRects() 取几何：
  //   ① Safari/iPadOS 对透明文字层的 client rect 不可靠（高度按行盒算出来只有一两像素）
  //      → 用户实测「iPad 上划词高光永远是扁的一条」；
  //   ② OCR 页的 span 是 overflow:hidden 的固定盒，Range 只量到字形行盒，同样偏矮。
  // 改成「按 span 自身布局盒（offsetLeft/Top/Width/Height）线性换算」：
  //   buildPdfTextLayer 已用 letter-spacing 把布局宽对齐到 _pw（不再用 scaleX 压字形），
  //   所以区间宽度 = 比例 × _pw 与字形严格一致，高度取 offsetHeight。
  const out = [];
  for (const s of spans) {
    const s0 = parseFloat(s.dataset.off);
    if (!isFinite(s0)) continue;
    const len = (s.textContent || '').length;
    if (!len) continue;
    const s1 = s0 + len;
    const from = Math.max(a.start, s0), to = Math.min(a.end, s1);
    if (to <= from) continue;                 // 不相交
    // ⚠️ 可视宽不能无条件用 _pw：pdf.js 对「行尾空白」给的 width 是**整行剩余进宽**
    //    （实测一个空格 _pw=256px，而它实际只占 7px）。拿它当可视宽会让高光带横跨
    //    大半行 —— 用户看到的就是「蓝色重叠、和字对不上」（2026-10-21 实测 前提.pdf）。
    //    正常文字 span 的 offsetWidth ≈ _pw（第二遍已用字间距对齐），取较小值即可。
    const natW = s.offsetWidth || 0;
    const visW = s._pw ? (natW ? Math.min(s._pw, natW + 0.5) : s._pw) : natW;
    const h = s.offsetHeight || parseFloat(s.style.fontSize) || 12;
    if (!visW || !h) continue;
    const k0 = (from - s0) / len, k1 = (to - s0) / len;
    // 基线：按该 span 实测的「基线比例」算（数字版 span 用 pdfBaselineRatio 缓存，
    // OCR span 在 fitOcrSpan 里按同一套字体度量写入）。旧写法 top+min(h,fs) 假设
    // 「盒顶到基线 = 一个字号」，中文会差 2~4px → 下划线/删除线整体偏下。
    const fs = parseFloat(s.style.fontSize) || Math.min(h, 12);
    const br = s._baseRatio || 0.8;
    // 竖排（R121）：文字是**竖着**排的，区间沿高度分布，不是沿宽度。
    // 不分开处理的话，「选一整列」会被算成「只选了 1/6 宽的一条」。
    const vert = s.dataset.vert === '1';
    out.push({
      left: vert ? s.offsetLeft : (s.offsetLeft + k0 * visW),
      top: vert ? (s.offsetTop + k0 * h) : s.offsetTop,
      width: vert ? (s.offsetWidth || 1) : Math.max(1, (k1 - k0) * visW),
      height: vert ? Math.max(1, (k1 - k0) * h) : h,
      fs,
      vert,
      base: s.offsetTop + br * fs,           // 基线（相对文字层）
    });
  }
  return out;
}

/** 自绘 PDF 划词带：把「当前选区覆盖的所有 span」按行合并成整齐矩形。
 *  为什么不用原生 ::selection（R58 用户第 1 条）：
 *  原生是「一个 span 一块」，PDF 同一行常被 pdf.js 拆成多个字号/基线略不同的 span
 *  （实测「1.」top=220、「你好」top=219，还有 26px 的大字与 17px 的小字混排），
 *  选中跨 span 时几块蓝底上下错开、互相叠住 → 用户看到的就是「划词重叠」。
 *  这里改成：一个 span 一个矩形（起止 span 用 Range 精确裁剪）→ 按行分组
 *  （top 差 ≤ 3px 视为同一行）→ 组内按 x 相邻合并（间隙 ≤ 4px 才并，双栏不会被连成一片）。 */
function spanSubRect(sp, from, to) {
  const tn = sp.firstChild;
  if (!tn || tn.nodeType !== 3) return null;
  const len = (tn.nodeValue || '').length;
  const f = Math.max(0, Math.min(len, from)), t = Math.max(0, Math.min(len, to));
  if (t <= f) return null;
  try {
    const rr = document.createRange();
    rr.setStart(tn, f); rr.setEnd(tn, t);
    const q = rr.getBoundingClientRect();
    const base = sp.getBoundingClientRect();
    // 文字层可能被外层 transform 缩放：把测量值换算回「布局坐标」
    const k = (sp.offsetWidth && base.width) ? (base.width / sp.offsetWidth) : 1;
    return { l: sp.offsetLeft + (q.left - base.left) / k, t: sp.offsetTop, w: q.width / k, h: sp.offsetHeight };
  } catch (e) { return null; }
}

function paintPdfSelection() {
  document.querySelectorAll('.pdf-sel-ov').forEach(n => n.remove());
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  const a = pdfPseudoOffset(r.startContainer, r.startOffset);
  const b = pdfPseudoOffset(r.endContainer, r.endOffset);
  if (a == null || b == null) return;
  const s = Math.min(a, b), e = Math.max(a, b);
  if (!(e > s)) return;
  const node = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
  const layer = node && node.closest ? node.closest('.pdf-text-layer') : null;
  if (!layer) return;
  const spans = Array.from(layer.querySelectorAll('span[data-off]')).filter(sp => {
    const o = parseFloat(sp.dataset.off), L = (sp.textContent || '').length;
    return o + L > s && o < e;
  });
  if (!spans.length) return;
  const rects = [];
  for (const sp of spans) {
    const o = parseFloat(sp.dataset.off), L = (sp.textContent || '').length;
    const from = Math.max(0, s - o), to = Math.min(L, e - o);
    if (to <= from) continue;
    // 整 span 覆盖 → 直接用布局盒（最稳）；边缘 span 用 Range 裁到字符级
    const full = (from <= 0.001 && to >= L - 0.001);
    const q = full ? { l: sp.offsetLeft, t: sp.offsetTop, w: sp.offsetWidth, h: sp.offsetHeight }
      : (spanSubRect(sp, from, to) || { l: sp.offsetLeft, t: sp.offsetTop, w: sp.offsetWidth, h: sp.offsetHeight });
    if (q.w > 0 && q.h > 0) rects.push(q);
  }
  if (!rects.length) return;
  // ① 按行分组（top 差 ≤ 3px）
  rects.sort((p, q) => (p.t - q.t) || (p.l - q.l));
  const rows = [];
  for (const q of rects) {
    const row = rows.find(rw => Math.abs(rw.t - q.t) <= 3);
    if (row) { row.items.push(q); row.t = Math.min(row.t, q.t); row.b = Math.max(row.b, q.t + q.h); }
    else rows.push({ t: q.t, b: q.t + q.h, items: [q] });
  }
  // ② 行内按 x 相邻合并
  const out = [];
  for (const rw of rows) {
    rw.items.sort((p, q) => p.l - q.l);
    let cur = null;
    for (const q of rw.items) {
      if (cur && q.l - (cur.l + cur.w) <= 4) { cur.w = Math.max(cur.w, q.l + q.w - cur.l); }
      else { cur = { l: q.l, w: q.w, t: rw.t, h: rw.b - rw.t }; out.push(cur); }
    }
  }
  let ov = layer.querySelector('.pdf-sel-layer');
  if (!ov) {
    ov = document.createElement('div');
    ov.className = 'pdf-sel-layer';
    ov.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:1';
  }
  ov.innerHTML = '';
  for (const g of out) {
    const d = document.createElement('div');
    d.className = 'pdf-sel-ov';
    d.style.left = g.l + 'px';
    d.style.top = (g.t + (g.h ? 0 : 0)) + 'px';
    d.style.width = g.w + 'px';
    d.style.height = g.h + 'px';
    ov.appendChild(d);
  }
  if (!ov.parentNode) layer.appendChild(ov);
}

let _selOvRaf = 0;
function scheduleSelOverlay() {
  if (_selOvRaf) return;
  _selOvRaf = requestAnimationFrame(() => { _selOvRaf = 0; try { paintPdfSelection(); } catch (e) { } });
}
document.addEventListener('selectionchange', scheduleSelOverlay);

/** 波浪线底纹（透明 span 上的 text-decoration:wavy 不显示，改用可重复的 SVG 底图） */
function wavyBg(color) {
  const c = color || '#e5a50a';
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='8' height='5'>"
    + "<path d='M0 3.4 Q2 .6 4 3.4 T8 3.4' fill='none' stroke='" + c + "' stroke-width='1.4'/></svg>";
  return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
}

/**
 * 给 PDF 文字层的某个标注区间画「标记带」。
 * 关键改动（修用户实测：删除标注后高光还在、点不动字、也划不了、划词高光被压扁）：
 *   1) 标记不再写到 span 上（background/border/onclick/title 会永久残留，删除标注也不消失，
 *      而且 span 上的 onclick 会抢走点击，导致文字点不动、划不了）；
 *   2) 改成独立的 .pdf-hl-band 图层，每次重画先把旧带子整层删掉 → 删除一定干净；
 *   3) 几何取 Range 的真实矩形 → 宽度与字形一致，高度按字号盒上下各放 12% → 不再「扁平」；
 *   4) 下划线 / 删除线 / 波浪线都用带子画，样式统一，不再依赖透明 span 的 border/text-decoration。
 */
/* ===== PDF「加粗」：直接膨胀画布像素（R59） =====
 * 为什么放弃 -webkit-text-stroke / text-shadow：
 *   文字层 span 是**透明**覆盖层，字体是 pdf.js 给的名字、位置由 transform 换算，
 *   和画布上真正画出来的字形永远有亚像素偏差。描边画的是 DOM 字形轮廓，叠在画布原字上
 *   → 两个轮廓错开 = 用户看到的「重影」；而 0.6px 是常数，字号越大相对越细
 *   → 用户第 2 条「正文本来就很大，加粗没区别」。
 * 现在改成真正作用在画布像素上：取标记区域 → 按「与背景的亮度差」做成只有笔画的蒙版
 *   （透明底，白纸/深底都成立）→ 沿 8 个方向各偏移 radius 叠加。
 *   用的就是原字形本身，不可能重影；radius ∝ 字号，大字小字都看得出来。 */
function paintPdfBold(cv, groups) {
  const cssW = cv && cv.offsetWidth, cssH = cv && cv.offsetHeight;
  if (!cssW || !cssH || !groups || !groups.length) return null;
  const k = cv.width / cssW;                 // device px / css px
  const ov = document.createElement('canvas');
  ov.className = 'pdf-bold-layer';
  ov.width = cv.width; ov.height = cv.height;
  ov.style.width = '100%'; ov.style.height = '100%';
  const octx = ov.getContext('2d');
  const LUM = (r, g, b) => (r * 299 + g * 587 + b * 114) / 1000;

  groups.forEach(g => {
    // 按行分块：一次处理整段会让 getImageData 覆盖整页（慢），按行切小得多
    const rows = [];
    g.rects.slice().sort((a, b) => a.top - b.top).forEach(r => {
      const L = rows[rows.length - 1];
      if (L && Math.abs(r.top - L.top0) <= 4) L.rs.push(r);
      else rows.push({ top0: r.top, rs: [r] });
    });
    const radCss = Math.max(0.55, Math.min(1.5, (g.fs || 14) * 0.03));
    const rad = Math.max(1, Math.round(radCss * k));
    rows.forEach(row => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      row.rs.forEach(r => {
        x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top);
        x1 = Math.max(x1, r.left + r.width); y1 = Math.max(y1, r.top + r.height);
      });
      const pad = radCss + 3;
      x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
      x1 = Math.min(cssW, x1 + pad); y1 = Math.min(cssH, y1 + pad);
      const bx = Math.round(x0 * k), by = Math.round(y0 * k);
      const bw = Math.round((x1 - x0) * k), bh = Math.round((y1 - y0) * k);
      if (bw <= 2 || bh <= 2) return;
      const t = document.createElement('canvas');
      t.width = bw; t.height = bh;
      const tc = t.getContext('2d', { willReadFrequently: true });
      try { tc.drawImage(cv, bx, by, bw, bh, 0, 0, bw, bh); } catch (e) { return; }
      let img;
      try { img = tc.getImageData(0, 0, bw, bh); } catch (e) { return; }   // 跨域画布兜底
      const d = img.data;
      // 背景亮度 = 本块亮度直方图的峰值（白纸→255，深色 PDF→接近 0，两种都成立）
      const hist = new Uint32Array(32);
      for (let i = 0; i < d.length; i += 4) {
        const l = Math.min(255, Math.max(0, LUM(d[i], d[i + 1], d[i + 2]) | 0));
        hist[l >> 3]++;
      }
      let bgB = 0, bgN = -1;
      for (let i = 0; i < 32; i++) if (hist[i] > bgN) { bgN = hist[i]; bgB = i; }
      const bg = bgB * 8 + 4;
      // 只留笔画：alpha = 与背景的亮度差，纸面纹理 / 淡底色被 26 的阈值抹掉
      for (let i = 0; i < d.length; i += 4) {
        const a = Math.abs(LUM(d[i], d[i + 1], d[i + 2]) - bg) * 1.8;
        d[i + 3] = a < 26 ? 0 : Math.min(255, a);
      }
      dilateAlpha(img, bw, bh, rad);
      tc.putImageData(img, 0, 0);
      octx.save();
      octx.beginPath();
      const grow = Math.ceil(rad) + 2;
      row.rs.forEach(r => octx.rect(
        Math.round(r.left * k) - grow, Math.round(r.top * k) - grow,
        Math.round(r.width * k) + grow * 2, Math.round(r.height * k) + grow * 2));
      octx.clip();
      octx.drawImage(t, bx, by);
      octx.restore();
    });
  });
  return ov;
}

/** 一次性形态学膨胀：每个像素取圆形邻域内 alpha 最大的那个像素（连同它的颜色）。
 *  为什么不是「多次偏移 drawImage 叠加」：叠加会让边缘 alpha 迅速饱和（9 次 0.1 → 0.6），
 *  36px 的汉字笔画间隙被填满，看着就是糊成一团黑块（实测就是这个效果）。
 *  取 max 保留原始抗锯齿渐变 —— 笔画变粗，边缘仍然平滑。 */
function dilateAlpha(img, w, h, R) {
  const src = new Uint8ClampedArray(img.data);
  const dst = img.data;
  const R2 = R * R;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let best = src[i + 3], bi = i;
      if (best === 255) continue;                    // 笔画心部，不用动
      const y0 = Math.max(0, y - R), y1 = Math.min(h - 1, y + R);
      const x0 = Math.max(0, x - R), x1 = Math.min(w - 1, x + R);
      for (let yy = y0; yy <= y1; yy++) {
        const dy = yy - y, row = yy * w;
        for (let xx = x0; xx <= x1; xx++) {
          const dx = xx - x;
          if (dx * dx + dy * dy > R2) continue;
          const j = (row + xx) * 4;
          const a = src[j + 3];
          if (a > best) { best = a; bi = j; }
        }
      }
      dst[i] = src[bi]; dst[i + 1] = src[bi + 1]; dst[i + 2] = src[bi + 2]; dst[i + 3] = best;
    }
  }
}

function paintPdfHighlights(layer, pageIdx) {
  if (!layer) return;
  // ① 清场：旧带子 + 旧版本残留在 span 上的样式（老书/老页面必须能自愈）
  layer.querySelectorAll('.pdf-hl-layer').forEach(n => n.remove());
  // 粗体叠层先留着：签名没变就能直接复用（整页加粗重算一次约 100ms，缩放/滚动时不该反复付）
  const prevBold = layer.querySelector('canvas.pdf-bold-layer');
  const spans = Array.from(layer.querySelectorAll('span[data-off]'));
  spans.forEach(s => {
    if (!s.getAttribute('style') && !s.style.cursor && !s.title && !s.onclick) return;
    s.style.background = '';
    s.style.borderBottom = '';
    s.style.textDecoration = '';
    s.style.textDecorationColor = '';
    s.style.fontWeight = '';
    s.style.webkitTextStroke = '';
    s.style.cursor = '';
    if (s.title) s.removeAttribute('title');
    s.onclick = null;
  });
  // 提前返回也要把旧的粗体叠层清掉（否则删掉粗体标注后画面上还留着一份）
  const dropBold = () => { if (prevBold) prevBold.remove(); layer._boldSig = ''; };
  if (!R.annots || !R.annots.length) return dropBold();
  const pageStart = pageIdx * 1e7;
  const annots = R.annots.filter(a => a.type === 'highlight' && !a.broken &&
    a.end > a.start && a.end > pageStart && a.start < pageStart + 1e7);
  if (!annots.length || !spans.length) return dropBold();

  const bandLayer = document.createElement('div');
  bandLayer.className = 'pdf-hl-layer';

  /* ① 拆成「带子矩形」。粗体走画布像素膨胀（paintPdfBold），不画带子。 */
  const items = [];      // { st, color, r, id, t }
  const dots = [];       // 有笔记的标记：这条标注最后一个矩形的右上角点一下
  const hits = [];       // 命中区（整块字身盒）：点「文字本身」也要能打开标记面板
  const bolds = [];      // [{ rects, fs }]
  annots.forEach((a, ai) => {
    const st = a.style || 'highlight';
    const color = a.color || HL_COLORS[0];
    const rects = pdfAnnotRects(spans, a);
    if (!rects.length) return;
    // 命中区用「字身盒」而不是带子：下划线/删除线的带子只有 2px 高，
    // 用户得精确点到那条线上才有反应（R59：「正文二字点了没用，要点下划线」）。
    // 逐 rect 生成（不合并成一个大外框）—— 跨行标注若用外框，点行间空白也会命中。
    rects.forEach(r => hits.push({ id: a.id, note: !!(a.note && String(a.note).trim()), r }));
    // 有笔记 → 右上角小圆点。**粗体也要有**（R59：选了粗体就看不到这个点了）。
    if (a.note) dots.push({ id: a.id, color, r: rects[rects.length - 1] });
    if (st === 'bold') {
      // 半径跟着这条标注里最大的字号走 → 正文那种本来就很大的字也能看出加粗
      const fs = rects.reduce((m, r) => Math.max(m, r.fs || r.height || 0), 0);
      bolds.push({ rects, fs, id: a.id });
      return;
    }
    // t 用来决定「谁盖谁」：同一个位置有多条标注时，后建的（t 大）盖住先建的，
    // 而不是两块半透明叠成更深的颜色（用户反复反馈的「高光重叠」）。
    const t = (a.createdAt || 0) + ai * 0.001;
    rects.forEach(r => items.push({ st, color, r, id: a.id, t }));
  });

  /* ② 合并同款同色、同一行、相接（或轻微重叠）的矩形 —— 这是「划词高光重叠」的根因修法：
   *   pdf.js 给「空格」的 item.width 往往比实际间隙宽（实测空格盒 7px、真实间隙 4px），
   *   span 布局盒按 _pw 撑开后，前一个词的带子和后一个词的带子会互相压住 3~4px；
   *   两条 38% 透明度的色块叠在一起 → 每个词之间出现一条更深的竖条，看着就是
   *   「高光重叠、和字对不上」（用户 R55 实测：前提.pdf 的「A table follows」）。
   *   同一段被重复标注（同色同款）也会叠深 —— 合并后统一成一条，颜色永远均匀。 */
  const bands = resolveBandOverlaps(mergePdfBands(items));
  /* ①-2 命中层：整块字身盒（透明），只用于 pdfHlHitTest 反查。
   *  有了它，点字本身（不只点那条 2px 的线）就能打开标记面板；
   *  粗体标注没有带子，以前完全点不动，现在也有命中区（R59 第 8 条）。 */
  hits.forEach(h => {
    const d = document.createElement('div');
    d.className = 'pdf-hit';
    d.dataset.annot = h.id;
    if (h.note) d.dataset.note = '1';
    d.style.left = h.r.left + 'px'; d.style.top = h.r.top + 'px';
    d.style.width = h.r.width + 'px'; d.style.height = h.r.height + 'px';
    bandLayer.appendChild(d);
  });
  bands.forEach(b => {
    const d = document.createElement('div');
    d.className = 'pdf-hl-band pdf-hl-' + b.st;
    d.dataset.annot = b.id;
    // r 已是「相对文字层」的布局坐标（不受 transform 影响），不用再减 boundingRect
    const r = b.r, st = b.st, color = b.color;
    const top = r.top, left = r.left, h = r.height, fs = r.fs || h, base = r.base || (top + fs);
    // 竖排（R121）：线要**竖着**画 —— 高亮按列宽 × 整列高，下划线/删除线/波浪线画在列边。
    // 竖排的「字下」= 列的右侧（文字从上往下流），所以线贴右边而不是下边。
    if (r.vert) {
      const lw = Math.max(2, fs * 1.24);
      if (st === 'underline' || st === 'wavy' || st === 'strike') {
        const off = st === 'underline' ? (r.width - 1) : (st === 'wavy' ? (r.width + 2) : (r.width * 0.5));
        d.style.left = (left + off) + 'px';
        d.style.width = (st === 'wavy' ? '4px' : (st === 'strike' ? '1.6px' : '2px'));
        d.style.top = top + 'px'; d.style.height = r.height + 'px';
        if (st === 'wavy') {
          d.style.backgroundImage = wavyBg(color);
          d.style.backgroundRepeat = 'repeat-y';
          d.style.backgroundSize = '5px 8px';
        } else d.style.background = color;
      } else {
        d.style.left = (left - (lw - r.width) / 2) + 'px';
        d.style.width = lw + 'px';
        d.style.top = top + 'px'; d.style.height = r.height + 'px';
        d.style.background = hexA(color, 0.38);
      }
    } else if (st === 'underline') {
      // 贴着基线下方 1px —— 和 txt 的「字下一条线」观感一致
      d.style.left = left + 'px'; d.style.width = r.width + 'px';
      d.style.top = (base + 1) + 'px'; d.style.height = '2px';
      d.style.background = color;
    } else if (st === 'strike') {
      d.style.left = left + 'px'; d.style.width = r.width + 'px';
      d.style.top = (base - fs * 0.32) + 'px'; d.style.height = '1.6px';
      d.style.background = color;
    } else if (st === 'wavy') {
      // 比下划线再低 2px：两条线同时存在时不会叠在一起
      d.style.left = left + 'px'; d.style.width = r.width + 'px';
      d.style.top = (base + 3) + 'px'; d.style.height = '4px';
      d.style.backgroundImage = wavyBg(color);
      d.style.backgroundRepeat = 'repeat-x';
      d.style.backgroundSize = '8px 5px';
    } else {
      // 高亮：按**字号盒**画（不是行盒），上下各放 12%，和字的大小贴合
      d.style.left = left + 'px'; d.style.width = r.width + 'px';
      d.style.top = (top - fs * 0.12) + 'px'; d.style.height = (fs * 1.24) + 'px';
      d.style.background = hexA(color, 0.38);
    }
    bandLayer.appendChild(d);
  });

  /* ③ 笔记小圆点最后画（保证压在带子上面，不会被后画的带子盖住） */
  dots.forEach(dt => {
    const r = dt.r, fs = r.fs || r.height || 12;
    const dot = document.createElement('div');
    dot.className = 'pdf-note-dot';
    dot.dataset.annot = dt.id;
    dot.style.left = Math.max(0, r.left + r.width - 4) + 'px';
    dot.style.top = (r.top - fs * 0.12 - 2) + 'px';
    dot.style.background = noteAccentFor(dt.color);
    bandLayer.appendChild(dot);
  });
  if (bandLayer.childElementCount) layer.appendChild(bandLayer);

  /* ④ 粗体：对画布像素做膨胀（见 paintPdfBold）。放在文字层最前面，
   *  压在带子下面，高光/下划线仍然盖在字上，观感与不加粗时一致。
   *  签名（页 + 画布尺寸 + 粗体标注区间）没变就直接复用上一份，别重复算。 */
  const cv = layer._cv || document.querySelector('#pdfStack .pdf-page[data-idx="' + pageIdx + '"]');
  const sig = pageIdx + '|' + (cv ? cv.width + 'x' + cv.height : '') + '|' +
    bolds.map(g => g.id + ':' + Math.round(g.fs || 0)).join(',');
  if (!bolds.length) {
    dropBold();
  } else if (prevBold && layer._boldSig === sig) {
    /* 复用 */
  } else {
    if (prevBold) prevBold.remove();
    const ov = cv ? paintPdfBold(cv, bolds) : null;
    if (ov) layer.insertBefore(ov, layer.firstChild);
    layer._boldSig = sig;
  }
}

/** 合并带子矩形：同款式 + 同颜色 + 同一行 + 水平相接/轻微重叠（≤ 2.5px）的并成一条。
 *  「同一行」用**聚类**判定（按 top 排序后，与当前簇首行顶差 ≤ 1.5px 归同一行），
 *  不用「top/2 取整分桶」——分桶会把 1128.9 和 1129.1 拆到两个桶里，同一行的带子
 *  就合不上；而单纯用 |Δtop| ≤ 2 又可能把上下相邻的两行（行距很小）连成一片。 */
function mergePdfBands(items) {
  const groups = new Map();
  items.forEach(it => {
    const key = it.st + '|' + it.color;
    const arr = groups.get(key);
    if (arr) arr.push(it); else groups.set(key, [it]);
  });
  const out = [];
  groups.forEach(arr => {
    arr.sort((x, y) => (x.r.top - y.r.top) || (x.r.left - y.r.left));
    // ① 按 top 聚类成「行」
    const lines = [];
    for (const it of arr) {
      const L = lines[lines.length - 1];
      if (L && Math.abs(it.r.top - L.top0) <= 1.5) L.items.push(it);
      else lines.push({ top0: it.r.top, items: [it] });
    }
    // ② 每行内按 left 合并
    lines.forEach(L => {
      L.items.sort((x, y) => x.r.left - y.r.left);
      let cur = null;
      for (const it of L.items) {
        const r = it.r;
        const curRight = cur ? cur.r.left + cur.r.width : 0;
        if (cur && r.left <= curRight + 2.5) {
          cur.r.width = Math.max(curRight, r.left + r.width) - cur.r.left;
          continue;
        }
        cur = { st: it.st, color: it.color, id: it.id, t: it.t || 0, r: Object.assign({}, r) };
        out.push(cur);
      }
    });
  });
  return out;
}

/** 矩形相减：从 r 里挖掉 cut，返回剩余矩形（最多 4 块） */
function subtractRect(r, cut) {
  const ix = Math.min(r.left + r.width, cut.left + cut.width) - Math.max(r.left, cut.left);
  const iy = Math.min(r.top + r.height, cut.top + cut.height) - Math.max(r.top, cut.top);
  if (ix <= 0.3 || iy <= 0.3) return [r];               // 不相交
  const out = [];
  const top = Math.max(r.top, cut.top), bottom = Math.min(r.top + r.height, cut.top + cut.height);
  if (cut.top > r.top + 0.3) out.push({ ...r, height: cut.top - r.top });                       // 上段
  if (cut.top + cut.height < r.top + r.height - 0.3) {                                          // 下段
    out.push({ ...r, top: cut.top + cut.height, height: r.top + r.height - (cut.top + cut.height) });
  }
  const hh = bottom - top;
  if (cut.left > r.left + 0.3) out.push({ ...r, top, height: hh, width: cut.left - r.left });    // 左段
  if (cut.left + cut.width < r.left + r.width - 0.3) {                                          // 右段
    out.push({ ...r, top, height: hh, left: cut.left + cut.width, width: r.left + r.width - (cut.left + cut.width) });
  }
  return out.filter(x => x.width > 0.8 && x.height > 0.8);
}

/**
 * 让同一款式（高亮/下划线/删除线/波浪）的带子**互不重叠**：新的盖住旧的。
 * 为什么要这一步（用户 R55/R57 反复反馈「划词高光还是重叠」）：
 *   · 同一段被标了两次（颜色不同）→ 两条 38% 透明色块叠在一起，中间那块明显更深；
 *   · 相邻词的交界处（空格 span 比真实间隙宽）可能仍有 1~2px 搭边；
 *   · 老版本存下来的标注是按 span 拆成多条存的，天然互相压住。
 * 合并同色相邻只解决最后一种的一部分；这里再做一次几何去重，**任何颜色组合都不会叠**。
 */
function resolveBandOverlaps(bands) {
  if (bands.length < 2) return bands;
  /* 只和「同一类装饰」比：高亮是整块色带，下划线/删除线/波浪是几条细线，
     它们**本来就该同时存在**（高亮 + 下划线是常见组合）。若不分家，2px 的下划线
     会从高亮块里挖掉一条横缝，高亮看着像被切开。 */
  const kindOf = (st) => (st === 'highlight' ? 'hl' : 'line');
  const order = bands.slice().sort((a, b) => (b.t || 0) - (a.t || 0));   // 新 → 旧
  const claimed = new Map();   // kind → [矩形...]
  const out = [];
  for (const b of order) {
    const kind = kindOf(b.st);
    const list = claimed.get(kind) || [];
    let parts = [b.r];
    for (const c of list) {
      // 竖向几乎不重叠（相邻两行的色带边缘搭了 1~2px）不算压住，否则会在上一行
      // 的带子底部挖出一条细细的空隙，看着更像「高光少了半截」。
      const iy = Math.min(b.r.top + b.r.height, c.top + c.height) - Math.max(b.r.top, c.top);
      if (iy < Math.min(b.r.height, c.height) * 0.45) continue;
      const next = [];
      for (const p of parts) next.push(...subtractRect(p, c));
      parts = next;
      if (!parts.length) break;
    }
    parts.forEach(p => out.push({ st: b.st, color: b.color, id: b.id, t: b.t, r: p }));
    list.push(b.r);
    claimed.set(kind, list);
  }
  return out;
}

/** 点 PDF 上的标记 → 打开该标注的笔记编辑。
 *  带子本身 pointer-events:none（不能挡划词），所以在 #pdfLayer 上用坐标反查。
 *  R59：先查 `.pdf-hit`（整块字身盒）—— 下划线/删除线的带子只有 2px 高，
 *  以前必须精确点在那条线上；粗体根本没有带子，完全点不动。 */
function pdfHlHitTest(x, y) {
  let fallback = null;
  const hits = document.querySelectorAll('.pdf-hit[data-annot]');
  for (const b of hits) {
    const r = b.getBoundingClientRect();
    if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) {
      if (b.dataset.note === '1') return b.dataset.annot;   // 有笔记那条优先
      fallback = b.dataset.annot;                            // 否则取最后一条（最新的在上）
    }
  }
  if (fallback) return fallback;
  const bands = document.querySelectorAll('.pdf-hl-band[data-annot]');
  for (const b of bands) {
    const r = b.getBoundingClientRect();
    if (x >= r.left - 3 && x <= r.right + 3 && y >= r.top - 6 && y <= r.bottom + 6) return b.dataset.annot;
  }
  return null;
}

/** 会话内给已渲染的 PDF 页现加高光 / 标记后，重新给可见页的文字层上色。
 *  背景：pdfLazyRender 对已渲染页（R._pdfRendered.has(idx)）直接跳过、不重建文字层，
 *  而高光着色只在 buildPdfTextLayer 里做 → 现加的高亮存了却画不出（#12 残余）。
 *  这里只重跑 paintPdfHighlights，不动画布、不重置滚动。 */
function repaintPdfHighlights() {
  const stack = $('pdfStack'), layer = $('pdfLayer');
  if (!stack || !layer) return;
  const top = layer.scrollTop, bot = top + layer.clientHeight, buf = layer.clientHeight;
  stack.querySelectorAll('.pdf-page').forEach(cv => {
    const idx = parseInt(cv.dataset.idx, 10);
    const cTop = cv.offsetTop, cBot = cTop + cv.offsetHeight;
    if (cBot < top - buf || cTop > bot + buf) return;   // 只处理可见页
    // 文字层挂在 stack 下、并记在 cv._textLayer（buildPdfTextLayer），并非 cv 子节点，
    // 用 cv.querySelector 找不到 → 改用 cv._textLayer。
    const tl = cv._textLayer || cv.querySelector('.pdf-text-layer');
    if (tl) paintPdfHighlights(tl, idx);
  });
}

/** 富文本（html/epub）高光 / 标记着色：把标注区间内的文字包进 <mark>，让高亮/下划线/删除线等真正显示。
 *  之前 txt/html 只有 PDF 有 paintPdfHighlights，富文本高亮只入库不渲染，导致「选词→高亮有弹窗但页面无显示」（#12）。
 *
 *  ⚠️ 2026-10-21 重写（用户实测：html 上「同一段不能叠多个样式 / 不同位置也不能共存」）：
 *  旧实现是「逐条标注 surroundContents 包一层 mark」，第二条命中同一段文字时，
 *  其文本节点已在第一条的 mark 里（旧代码直接跳过），于是第二条样式永远画不出来；
 *  不同位置时虽然能画，但每次重画都重建整棵 mark，容易与选区/光标打架。
 *  现在改为 **按切点分段**（与 txt 的 decorate 同一套思路）：
 *    ① 先拆掉全部旧 mark、normalize 回纯文本；
 *    ② 每个文本节点收集所有相交标注，取切点集合，逐段生成一个 mark；
 *    ③ 每个 mark 的 class 合并该段覆盖到的全部样式 → 天然支持重叠 / 多样式叠加 / 任意多条共存。
 *  注意保持 data-off 偏移口径不变（文本内容不变，只是加了包裹元素）。 */
/** 笔记标记的强调色：默认琥珀橙；若高亮底色本身是橙/黄系，换成紫罗兰，避免「笔记和高光糊成一片」。
 *  （用户要求：笔记标记的颜色要和所选的高光/划线颜色区分开。） */
function noteAccentFor(baseColor) {
  const ORANGE = '#FF9F0A', VIOLET = '#7048E8';
  if (!baseColor) return ORANGE;
  const c = String(baseColor).trim();
  let r = 0, g = 0, b = 0;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
    const h = c.length === 4
      ? c[1] + c[1] + c[2] + c[2] + c[3] + c[3]
      : c.slice(1);
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  } else {
    const m = c.match(/rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/i);
    if (!m) return ORANGE;
    r = +m[1]; g = +m[2]; b = +m[3];
  }
  // 橙黄判据：红分量最高、蓝分量很低。
  const orangeish = r > 180 && b < 140 && r - b > 70;
  return orangeish ? VIOLET : ORANGE;
}

function paintHtmlHighlights() {
  const root = document.querySelector('#scrollInner .html-book');
  if (!root) return;
  // 1) 先复原：拆掉旧 <mark.ink-hl>，文本并回原父节点
  root.querySelectorAll('mark.ink-hl').forEach(m => {
    const p = m.parentNode;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    if (m.parentNode) m.parentNode.removeChild(m);
  });
  root.normalize();
  const annots = (R.annots || []).filter(a => a.type === 'highlight' && !a.broken && a.end > a.start);
  if (!annots.length) return;

  // 2) 逐「带 data-off 的叶子块」处理，块内逐文本节点按切点分段
  root.querySelectorAll('[data-off]').forEach(b => {
    const bo = parseInt(b.dataset.off, 10) || 0;
    const tns = [];
    const tw = document.createTreeWalker(b, NodeFilter.SHOW_TEXT, null);
    let o = 0, n;
    while ((n = tw.nextNode())) {
      const len = (n.nodeValue || '').length;
      if (len) tns.push({ n, s: bo + o, e: bo + o + len });
      o += len;
    }
    if (!tns.length) return;
    const local = annots.filter(a => a.end > bo && a.start < bo + o);
    if (!local.length) return;

    for (const it of tns) {
      const cover = local.filter(a => a.end > it.s && a.start < it.e);
      if (!cover.length) continue;
      const txt = it.n.nodeValue;
      const cuts = new Set([0, txt.length]);
      cover.forEach(a => {
        cuts.add(Math.max(0, a.start - it.s));
        cuts.add(Math.min(txt.length, a.end - it.s));
      });
      const pts = Array.from(cuts).sort((x, y) => x - y);
      const frag = document.createDocumentFragment();
      for (let k = 0; k < pts.length - 1; k++) {
        const cs = pts[k], ce = pts[k + 1];
        if (ce <= cs) continue;
        const str = txt.slice(cs, ce);
        const gs = it.s + cs, ge = it.s + ce;
        const cov = cover.filter(a => a.start <= gs && a.end >= ge);
        if (!cov.length) { frag.appendChild(document.createTextNode(str)); continue; }
        const mark = document.createElement('mark');
        const cls = ['ink-hl'];
        // 每种样式各自保留「最新那条标注」：颜色互不串色（用户实测：先粉色高亮，
        // 后面加的所有划线都跟着变粉 —— 旧代码 `color = color || a.color` 取的是
        // 数组里第一条覆盖标注的颜色，后加的标注永远用不上自己的颜色）。
        const byStyle = {};
        let hasNote = false;
        for (const a of cov) {
          const st = a.style || 'highlight';
          const prev = byStyle[st];
          // 「最新」判据：createdAt 大的优先；没有时间戳的按数组顺序取后者
          if (!prev || (a.createdAt || 0) >= (prev.createdAt || 0)) byStyle[st] = a;
          if (a.note) hasNote = true;
        }
        const styles = Object.keys(byStyle);
        styles.forEach(st => cls.push('hl-' + st));
        mark.className = cls.join(' ');

        const colorOf = (st) => (byStyle[st] && byStyle[st].color) || '';
        // 高亮：底色（后加的高亮覆盖前面的颜色）
        if (byStyle.highlight) {
          mark.style.setProperty('--c-hl', hlFill(colorOf('highlight') || '#FFE066'));
        }
        // 下划线：用 box-shadow 画「内阴影底线」，不占 text-decoration-line
        if (byStyle.underline) mark.style.setProperty('--c-ul', hlLine(colorOf('underline') || '#1C7ED6'));
        // 删除线 / 波浪线：都走 background-image 多层叠加 —— 它们原本共用
        // `text-decoration-line` 单值属性，同时加会互相顶掉（用户实测「波浪线和删除线互斥」）。
        const bgs = [], reps = [], poss = [], sizes = [];
        if (byStyle.wavy) {
          const c = hlLine(colorOf('wavy') || '#2F9E44');
          const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="5">' +
            '<path d="M0 4 Q2.5 0 5 4 T10 4" fill="none" stroke="' + c + '" stroke-width="1.5"/></svg>';
          bgs.push('url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '")');
          reps.push('repeat-x'); poss.push('0 calc(100% - 1px)'); sizes.push('10px 5px');
        }
        if (byStyle.strike) {
          const c = hlLine(colorOf('strike') || '#E03131');
          bgs.push('linear-gradient(' + c + ',' + c + ')');
          reps.push('no-repeat'); poss.push('0 52%'); sizes.push('100% 1.6px');
        }
        if (bgs.length) {
          mark.style.backgroundImage = bgs.join(',');
          mark.style.backgroundRepeat = reps.join(',');
          mark.style.backgroundPosition = poss.join(',');
          mark.style.backgroundSize = sizes.join(',');
        }
        if (byStyle.bold) mark.style.fontWeight = '800';
        if (hasNote) {
          mark.classList.add('has-note');
          // 笔记标记的「边框 + 圆点」用与高光/划线不同的强调色：
          // 默认琥珀橙；若高光本身就是橙黄系，自动换成紫罗兰，保证永远能区分开。
          mark.style.setProperty('--note-color', noteAccentFor(colorOf('highlight')));
        }
        // 一条文字可能同时被多条标注覆盖：点击优先命中「有笔记」的那条，方便直接编辑
        const target = cov.find(a => a.note) || cov[cov.length - 1];
        mark.dataset.aid = target.id;
        mark.style.cursor = 'pointer';
        mark.title = target.note ? '📝 ' + target.note : (target.text || '').slice(0, 40);
        // 点击高亮 → 打开「这条标注自己的」笔记编辑（不再跳书签/标注列表页，也不会毫无反应）。
        mark.onclick = (ev) => {
          // ⚠️ 拖选经过已有高光 / 在同一段上叠第二个样式时，mouseup 会顺带派发 click 到这里，
          // 之前会直接弹出「笔记编辑」挡住选区浮层 → 用户实测「多个标记不能共存、没法换颜色」。
          // 有选区时一律让位给划词逻辑，只在「单击、无选区」时才打开标记编辑器。
          const sel = window.getSelection && window.getSelection();
          if (sel && !sel.isCollapsed) return;
          ev.stopPropagation();
          const ann = R.annots.find(x => x.id === target.id);
          if (!ann) return;
          // 和 txt 一样：点标记 → 打开「这一片所有标记」的浮层（可叠加/改色/写笔记/清除），
          // 而不是只打开点到的那一条的笔记（用户 2026-10-21 反馈）。
          if (!openMarkEditor(ann.start, ann.end, ev.clientX, ev.clientY)) openNoteComposer(ann);
        };
        mark.textContent = str;
        frag.appendChild(mark);
      }
      if (it.n.parentNode) it.n.parentNode.replaceChild(frag, it.n);
    }
  });
}

/**
 * 给某一页 PDF 建可选中文字层（透明 span 叠在画布上）。
 * 返回该页抽取到的纯文本，供调用方判断是否为扫描页（决定是否走 OCR）。
 */
/** 把「绝对定位的覆盖层」（文字层 / 扫描角标）贴到画布实际位置上。
 *  为什么不用 cv.offsetLeft：offsetLeft 的参照系是 offsetParent，而覆盖层的父节点是
 *  #pdfStack —— 两者不一定是同一个（双页/居中/缩放溢出时就会差一截），用户实测
 *  「PDF 错位、跑到左边」多半就是这个。用 boundingClientRect 相减，任何布局都稳。 */
function placeLayerOverCanvas(layer, cv) {
  const stack = $('pdfStack');
  if (!layer || !cv || !stack) return;
  const sr = stack.getBoundingClientRect(), cr = cv.getBoundingClientRect();
  layer.style.left = (cr.left - sr.left) + 'px';
  layer.style.top = (cr.top - sr.top) + 'px';
  layer.style.width = Math.round(cr.width * 10) / 10 + 'px';
  layer.style.height = Math.round(cr.height * 10) / 10 + 'px';
  layoutOcrSpans(layer, cv);
}

/** OCR 文字层的字号要按「当前画布高」重算（bbox 位置已经是百分比，字号的 px 值不是）。
 *  否则缩放后 OCR 出来的字会大小不符、看着像「认错了行」。
 *  data-nh = 墨迹高 / 画布高，data-fr = 字号 / 墨迹高（见 fitOcrSpan）。 */
function layoutOcrSpans(layer, cv) {
  if (!layer || !layer.classList || !layer.classList.contains('ocr-layer')) return;
  const h = (cv && cv.offsetHeight) || 0;
  if (!h) return;
  layer.querySelectorAll('span[data-nh]').forEach(s => {
    const nh = parseFloat(s.dataset.nh);
    const fr = parseFloat(s.dataset.fr) || 1.39;   // 老数据没 data-fr 时按拉丁大写比例兜底
    if (nh > 0) s.style.fontSize = Math.max(6, nh * h * fr).toFixed(2) + 'px';
  });
}

/** 布局变化（缩放 / 窗口大小 / 双页切换）后，把所有文字层重新贴回画布上 */
function syncPdfTextLayers() {
  const stack = $('pdfStack');
  if (!stack) return;
  stack.querySelectorAll('.pdf-page[data-idx]').forEach(cv => {
    if (cv._textLayer) placeLayerOverCanvas(cv._textLayer, cv);
    if (cv._scanMark) placeLayerOverCanvas(cv._scanMark, cv);
  });
}

/** 某个字体在 `line-height:1` 下，**基线距 span 盒顶**占字号的比例。
 *
 *  为什么必须实测：旧代码把 span 的 top 写成 `基线 - 字号`，等于假设「盒顶到基线正好
 *  一个字号」。但实际基线位置 = 半行距 + ascent，而行距/上下高由**字体的字体度量**决定：
 *  · 拉丁回退字体常见 ascent+descent ≈ 1.0em；
 *  · 中文字体（PingFang / 微软雅黑）ascent+descent 明显更大（~1.2em 以上）。
 *  于是同一个 top 下，英文大致对齐、中文整体**偏上一个多像素**——用户看到的就是
 *  「中文数字的显示字符略略偏上，有点重影，英文字符没有」（R55 实测 前提.pdf）。
 *
 *  做法：用 0 尺寸 inline-block 探针（它的基线 = 底边）实测一次比例，
 *  按字体缓存。设置时 span 用 `line-height:1`，top = 基线 - ratio*字号，
 *  基线位置就与 PDF 完全一致，与字体无关。 */
const _pdfBaseRatio = Object.create(null);
function pdfBaselineRatio(fam) {
  const key = fam || '_default';
  if (_pdfBaseRatio[key] != null) return _pdfBaseRatio[key];
  let ratio = 0.8;
  try {
    const d = document.createElement('span');
    d.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;white-space:pre;'
      + 'line-height:1;font-size:100px;font-family:' + (fam || 'serif');
    d.textContent = 'Hg中';
    const pr = document.createElement('i');     // ⚠️ 必须是 <i>：.pdf-text-layer span 的 CSS 会把 span 变成 absolute
    pr.style.cssText = 'display:inline-block;width:0;height:0;overflow:visible;font-style:normal';
    d.insertBefore(pr, d.firstChild);
    document.body.appendChild(d);
    const dr = d.getBoundingClientRect(), prr = pr.getBoundingClientRect();
    ratio = (prr.bottom - dr.top) / 100;
    d.remove();
    if (!(ratio > 0.4 && ratio < 1.5)) ratio = 0.8;
  } catch (e) { ratio = 0.8; }
  _pdfBaseRatio[key] = ratio;
  return ratio;
}

async function buildPdfTextLayer(cv, page, viewport, pageIdx) {
  const stack = $('pdfStack');
  if (!stack) return '';
  if (cv._textLayer && cv._textLayer.parentNode) cv._textLayer.parentNode.removeChild(cv._textLayer);
  // 用画布「实际渲染盒」而非 viewport 盒定位 —— canvas 的 CSS 尺寸可能因适应屏幕 / 缩放而
  // 与 viewport 不一致；用 offsetWidth/Height 再按 viewport 比例缩放 span，文字层永远贴齐画布，
  // 缩放 / 适应都不再错位重叠（修 #6 / #10）。
  const boxW = cv.offsetWidth || viewport.width;
  const boxH = cv.offsetHeight || viewport.height;
  const sx = boxW / viewport.width;
  const sy = boxH / viewport.height;
  const layer = document.createElement('div');
  layer.className = 'pdf-text-layer' + (R._showTextLayer ? ' show-text' : '');
  layer.style.left = '0px';
  layer.style.top = '0px';
  layer.style.width = boxW + 'px';
  layer.style.height = boxH + 'px';
  let cumOff = pageIdx * 1e7;          // 每页 1e7 字符上限，跨页伪偏移不重叠
  let text = '';
  const spans = [];
  try {
    const tc = await page.getTextContent();
    for (const item of (tc.items || [])) {
      if (!item.str) continue;
      text += item.str;
      const tx = _txf(viewport, item.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]);
      const span = document.createElement('span');
      span.textContent = item.str;
      // 按 pdf.js 的 transform 定位 + 自然字号（white-space:pre）排版；宽度留待第二遍按实测拉伸
      const fs0 = fontHeight * sy;
      // 基线比例按字体实测（见 pdfBaselineRatio）；line-height:1 让「盒顶→基线」只由字体度量决定
      const br = pdfBaselineRatio(item.fontName || '');
      span._baseRatio = br;
      span._baseY = tx[5] * sy;                  // 真实基线（相对文字层）
      span.style.lineHeight = '1';
      span.style.left = (tx[4] * sx) + 'px';
      span.style.top = (span._baseY - br * fs0) + 'px';
      span.style.fontSize = fs0 + 'px';
      span.style.transformOrigin = 'left top';
      if (item.fontName) span.style.fontFamily = item.fontName;
      span.dataset.off = cumOff;
      // 目标宽度（缩放后 CSS px）= PDF 字宽 advance。
      // ⚠️ item.width 是 **PDF 用户空间单位**，必须再乘 viewport.scale 才变成 CSS px
      //    （textContent 的 transform 已由 _txf 应用过 viewport.transform，但 width 没有）。
      //    少乘 scale 会让 _pw 小一大截（实测 277 vs 实际 460），于是第二遍只能
      //    scaleX/缩字号去硬压 —— 用户看到「字扁瘦」「划词和原文字对不上」。
      span._pw = (typeof item.width === 'number' && item.width > 0)
        ? item.width * (viewport.scale || 1) * sx : 0;
      cumOff += item.str.length;
      layer.appendChild(span);
      spans.push(span);
    }
  } catch (e) { /* 无文本层则忽略 */ }
  stack.appendChild(layer);
  placeLayerOverCanvas(layer, cv);       // 贴在画布上（不再依赖 offsetLeft 的参照系）
  cv._textLayer = layer;
  layer._cv = cv;                        // paintPdfHighlights 里画粗体叠层要用画布像素
  cv._textZoom = R.pdfZoom || 1;
  // 第二遍：把每个 span 的**布局宽度**对齐到 PDF 字宽（item.width * sx）。
  //
  // ⚠️ 这里绝不能用 `transform: scaleX(pw/w)`（R48 之前的做法）：
  //    浏览器 fallback 字体通常比 PDF 原字体宽，scaleX<1 会把字形**横向压扁**
  //    （用户开「A」核对时看到「字还是扁瘦」）；而且 transform 不改布局盒，
  //    offsetLeft/offsetWidth 仍是未缩放值 —— 高光带按 _pw 算、字形按自然宽渲染，
  //    两者对不上（用户：「划词和原文字不太对得上」「高光重叠」）。
  //
  // 改用 letter-spacing 微调**字间距**：字形不变形，布局宽度 = 自然宽 + len*ls ≈ _pw，
  // 于是 span 的布局盒、字形、高光带三者严格同宽。间距变化限制在 ±0.6em 内，
  // 极端字体（宽度差太大）宁可留一点缝，也不把字压扁。
  for (const span of spans) {
    if (!span._pw) continue;
    const txt = span.textContent || '';
    const len = Math.max(1, txt.length);
    const w0 = span.offsetWidth;                       // 自然宽（未加字间距）
    if (!(w0 > 0)) continue;
    const fs0 = parseFloat(span.style.fontSize) || 12;
    const ratio = span._pw / w0;
    // ① 宽度差太大（fallback 字体比 PDF 原字体宽很多）→ **等比缩小字号**，
    //    而不是 scaleX 压扁（压扁会让 A 模式看到「扁瘦」的字）。
    //    下限 0.45：再小就认不出字了，剩下的差交给字间距。
    if (ratio < 0.98) {
      const r = Math.max(0.45, ratio);
      const fs = fs0 * r;
      span.style.fontSize = fs.toFixed(2) + 'px';
      // 字号变小后**按真实基线重新定位**（旧代码 top += fs0-fs 假设「盒顶 = 基线 - 字号」，
      // 中文/西文度量不同时会飘几个像素）
      const br = span._baseRatio || 0.8;
      const by = (span._baseY != null) ? span._baseY : ((parseFloat(span.style.top) || 0) + br * fs0);
      span.style.top = (by - br * fs).toFixed(2) + 'px';
    }
    // ② 剩余差值用**小幅**字间距补齐（±0.12em 内），避免字符重叠
    const w1 = span.offsetWidth;
    const fs1 = parseFloat(span.style.fontSize) || fs0;
    let ls = (span._pw - w1) / len;
    const lim = fs1 * 0.12;
    if (ls > lim) ls = lim;
    if (ls < -lim) ls = -lim;
    if (Math.abs(ls) > 0.02) span.style.letterSpacing = ls.toFixed(3) + 'px';
  }
  // PDF 高光 / 标记着色（修 #12：之前只入库、不渲染到文字层）
  paintPdfHighlights(layer, pageIdx);
  return text;
}

/* ---------------- PDF OCR（扫描版 / 图片型） ---------------- */
let _tesseractLoading = null;
/* R159：Tesseract 的运行文件（引擎 + WASM 核心 + 中英日繁语言包，共约 15 MB）
   以前全靠 CDN 现拉 —— 手机上没有「能用」的识别，十次有八次就是这一步连不上
   （jsdelivr / unpkg 在国内时好时坏，APK 里又没有内置副本）。
   现在优先用随包带的 vendor/tesseract/，CDN 只做最后兜底。 */
const TESS_HOME = 'vendor/tesseract';
/** 随包带的语言包（其余语言仍然联网取） */
const TESS_LOCAL_LANGS = ['chi_sim', 'chi_tra', 'eng', 'jpn'];
function tessLocalUrl(f) {
  // ⚠ 必须给**绝对地址**：worker.min.js 里用 importScripts(corePath) 加载核心，
  //   相对路径会相对 worker 自己的目录再拼一次 → vendor/tesseract/vendor/tesseract/...
  //   web 打开是 http://…/vendor/…，APK 里是同一套 serve.py，跟着走就行。
  const rel = TESS_HOME + '/' + f;
  try { return new URL(rel, location.href).href; } catch (e) { return rel; }
}
async function ensureTesseract() {
  if (window.Tesseract) return window.Tesseract;
  if (_tesseractLoading) return _tesseractLoading;
  // 先本地；本地没有再走 CDN（两个源轮着试：jsdelivr 偶尔很慢/被劫持，unpkg 常常还能用）。
  // 加载不出来就是「点了识别没反应」，所以本地也要有兜底。
  const urls = [
    tessLocalUrl('tesseract.min.js'),
    'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
    'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js'
  ];
  const loadOne = (u) => new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = u;
    el.onload = () => resolve(window.Tesseract);
    el.onerror = () => { try { el.remove(); } catch (e) { } reject(new Error('load fail')); };
    document.head.appendChild(el);
  });
  _tesseractLoading = (async () => {
    let last = null;
    for (const u of urls) {
      try {
        const T = await loadOne(u);
        if (T) return T;
      } catch (e) { last = e; }
    }
    _tesseractLoading = null;
    throw new Error('识别引擎加载失败（本地副本和在线源都没取到，可能是安装包不完整）');
  })();
  return _tesseractLoading;
}

/** 本地有没有这份语言包 —— 有就离线认，没有才去网上取 */
let _tessLocalLangCache = null;
function tessLocalLangs() {
  if (_tessLocalLangCache) return Promise.resolve(_tessLocalLangCache);
  // 不额外发请求：直接试 HEAD 一次 chi_sim，成了就认为整批都在（它们是同一批打进来的）
  return fetch(tessLocalUrl('lang/chi_sim.traineddata'), { method: 'HEAD', cache: 'no-store' })
    .then(function (r) {
      _tessLocalLangCache = r && r.ok ? TESS_LOCAL_LANGS.slice() : [];
      return _tessLocalLangCache;
    })
    .catch(function () { _tessLocalLangCache = []; return _tessLocalLangCache; });
}

/* ---------- 复用一个 worker（R122 关键修复） ----------
   ⚠️ `Tesseract.recognize(img, lang)` 这种顶层写法**每次都新建 worker 再销毁**：
   每页都要重新初始化引擎、重新读一遍语言包 —— 这就是「每页三分钟」的真正原因，
   而且语言包每次读失败/读一半，认出来就是一片乱码。
   这里自己建一个 worker 常驻，换个语言/方向才重建。 */
let _ocrWorker = null, _ocrWorkerLang = '', _ocrWorkerBusy = null;
let _ocrUsedLangFromNet = false;   // 这次用的语言包是不是从网上取的（不在随包带的那四种里）
async function ocrGetWorker() {
  const T = await ensureTesseract();
  const lang = ocrLangString(ocrCfg());
  if (_ocrWorker && _ocrWorkerLang === lang) return _ocrWorker;
  // 串行化：两页同时调用时别抢着重建
  if (_ocrWorkerBusy) { try { await _ocrWorkerBusy; } catch (e) { } }
  if (_ocrWorker && _ocrWorkerLang === lang) return _ocrWorker;
  _ocrWorkerBusy = (async () => {
    if (_ocrWorker) {
      try { await _ocrWorker.terminate(); } catch (e) { }
      _ocrWorker = null; _ocrWorkerLang = '';
    }
    const langs = ocrCfg().langs.slice();
    const localLangs = await tessLocalLangs();
    // 选的语言都在包里 → 完全离线；差一种就得联网（langPath 走 CDN）
    const allLocal = langs.every(function (l) { return localLangs.indexOf(l) >= 0; });
    _ocrUsedLangFromNet = !allLocal;
    const base = {
      // 引擎和核心都用随包带的副本，手机不联网也能认出字
      workerPath: tessLocalUrl('worker.min.js'),
      logger: function (m) {
        if (m && m.status === 'recognizing text') console.log('OCR ' + Math.round((m.progress || 0) * 100) + '%');
        else if (m && m.status) console.log('OCR ' + m.status + ' ' + Math.round((m.progress || 0) * 100) + '%');
      }
    };
    if (allLocal) {
      base.langPath = tessLocalUrl('lang');
      // ⚠ 本地语言包是**未压缩**的 .traineddata：aapt2 打 APK 时会把 .gz 自动解压并
      //   去掉后缀（assets 里变成 chi_sim.traineddata），运行时按 .gz 去要就是 404。
      base.gzip = false;
    }
    // 核心分 SIMD / 普通两版：新手机都有 SIMD（快一截），老设备加载不了再退回去
    const cores = [tessLocalUrl('tesseract-core-simd-lstm.wasm.js'),
                   tessLocalUrl('tesseract-core-lstm.wasm.js')];
    let last = null;
    for (let i = 0; i < cores.length; i++) {
      try {
        const w = await T.createWorker(langs, 1, Object.assign({}, base, { corePath: cores[i] }));
        if (w) {
          _ocrWorker = w;
          _ocrWorkerLang = lang;
          return w;
        }
      } catch (e) { last = e; }
    }
    throw new Error((last && last.message ? last.message + ' ' : '')
      + (allLocal ? '识别引擎初始化失败' : '识别引擎初始化失败（这门语言要联网下语言包）'));
  })();
  try { return await _ocrWorkerBusy; } finally { _ocrWorkerBusy = null; }
}
/** 把 worker 丢掉（语言包出问题 / 换语言后重来时用） */
async function ocrDropWorker() {
  if (_ocrWorker) { try { await _ocrWorker.terminate(); } catch (e) { } }
  _ocrWorker = null; _ocrWorkerLang = '';
}
/* ---------------- OCR 语言 / 排版方向（R121） ----------------
   Tesseract 的语言是按「训练数据包」走的：chi_sim 只认简体、jpn 认日文……
   一次可以给多个（用 + 连），代价是每个包十几 MB、识别也慢一点。
   **竖排不靠 Tesseract 的 *_vert 模型**：把图顺时针转 90°，竖列就变成横行，
   用普通模型认完再把坐标转回来 —— 一份语言包横竖通吃，也省掉 PSM=5 那套参数。 */
const OCR_LANGS = [
  { k: 'chi_sim', n: '简体中文' },
  { k: 'chi_tra', n: '繁體中文' },
  { k: 'jpn', n: '日本語' },
  { k: 'kor', n: '한국어' },
  { k: 'eng', n: 'English' },
  { k: 'rus', n: 'Русский' },
  { k: 'fra', n: 'Français' },
  { k: 'deu', n: 'Deutsch' },
  { k: 'spa', n: 'Español' },
  { k: 'ita', n: 'Italiano' },
  { k: 'por', n: 'Português' },
  { k: 'vie', n: 'Tiếng Việt' },
  { k: 'tha', n: 'ไทย' }
];
/** OCR 语言 → 翻译引擎的源语言码（认得出是什么语言就别让引擎去猜） */
const OCR_SRC_LANG = {
  jpn: 'JA', kor: 'KO', eng: 'EN', rus: 'RU', fra: 'FR',
  deu: 'DE', spa: 'ES', ita: 'IT', por: 'PT', vie: 'VI', tha: 'TH'
};

/* ---------------- 本地视觉 OCR 引擎（R123） ----------------
   浏览器里的 Tesseract 认不动漫画（网点、彩色气泡、手写小字），也认不动糊掉的扫描页。
   本机跑一个视觉 OCR 模型（serve.py 转发 /api/ocr）能强一个代差，而且返回的仍然是
   {words:[{text,bbox}]} —— 后面的建层 / 划词 / 高亮 / 备份一行都不用改。
   Settings.ocrEngine：
     auto      有本地模型就用它，没有就退回浏览器内（默认）
     local     强制本地（没装就报错，不去偷偷下语言包）
     tesseract 强制浏览器内（离线、不想装模型时用）
   预处理（灰度 / 反相 / 拉对比度）是**专门给 Tesseract 补的**：视觉模型看彩色原图更准，
   所以远端这条路不做预处理，只压尺寸。 */
const OCR_ENGINES = [
  { k: 'auto', n: '自动' },
  { k: 'paddle', n: '本机 PaddleOCR', appOnly: true },
  { k: 'local', n: '本地模型' },
  { k: 'tesseract', n: '浏览器内' }
];
/* R171：PaddleOCR 是**新增**的第四种引擎，不替换 Tesseract。
   只在「手机 App」里露面 —— 用户明确说过 Web 端先不动。
   但桌面端要能自测（不然我改完只能靠猜），所以带 `?ort=1` 打开也放出来。 */
function ocrPaddleAllowed() {
  if (typeof OcrPaddle === 'undefined') return false;
  if (typeof window !== 'undefined' && window.InkAndroid) return true;
  try { return /[?&]ort=1(?:&|$)/.test(String(location.search || '')); } catch (e) { return false; }
}
function ocrEngines() {
  return OCR_ENGINES.filter(function (o) { return !o.appOnly || ocrPaddleAllowed(); });
}
let _ocrStatus = null;        // {at, ok, installed, running, backend, gpu, ...}
let _ocrStatusBusy = null;
// 上次「删除模型」还剩几个文件没删掉（0 = 正常）。放在模块级而不是直接改 DOM：
// 事件处理器删完会调 paint()，painOcrEng() 一重绘就把临时文案冲掉了 ——
// 表现就是「点了删除，按钮还是删除模型、什么都不说」（2026-11 用户反馈）。
let _ocrUninstallLeft = 0;
let _ocrUninstallWhy = '';
let _ocrDoneNotifiedAt = 0;   // 已经为哪一次「下载结束」提示过了（防重复 toast）
let _ocrRemoteBrokenAt = 0;   // 远端失败过 → 一分钟内不再试，直接用 Tesseract

function ocrEngine() {
  const s = (typeof Settings !== 'undefined' && Settings) || {};
  const k = s.ocrEngine || 'auto';
  // paddle 没加载成功（老安装包 / vendor 被删）就当没选它，别让识别直接抛错
  if (k === 'paddle' && !ocrPaddleAllowed()) return 'auto';
  return ['auto', 'local', 'tesseract', 'paddle'].indexOf(k) >= 0 ? k : 'auto';
}
/** 识别服务在哪：空 = 本机（手机自己 / 这台电脑）；否则是另一台设备的地址。
 *  R159：手机跑不动视觉模型，但同一局域网里电脑装了模型时，可以把图发过去认。 */
function ocrBase() {
  const s = (typeof Settings !== 'undefined' && Settings) || {};
  return String(s.ocrRemoteBase || '').trim().replace(/\/+$/, '');
}
function ocrApi(path) {
  const b = ocrBase();
  return b ? (b + path) : path;
}
/** 把用户填的地址收拾成 http://ip:port（只填 ip 时补默认端口）。
    R169：用户常把整条接口地址粘进来（…/v1/chat/completions），
    旧实现会在末尾补 :8123，拼出 `http://ip:9000/v1/chat/completions:8123` 这种废地址。 */
function ocrNormBase(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  const m = /^(https?:\/\/[^\/?#]+)/i.exec(s);
  if (m) s = m[1];                       // 只留 协议 + 主机 + 端口
  s = s.replace(/\/+$/, '');
  if (!/:\d+$/.test(s.replace(/^https?:\/\//i, ''))) s += ':8123';
  return s;
}
function ocrAgoText(ts) {
  const d = Date.now() - (ts || 0);
  if (!ts) return '';
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.round(d / 60000) + ' 分钟前';
  return Math.round(d / 3600000) + ' 小时前';
}

/** 「识别服务」那一行的状态文字。R169：
    用户填完地址点「确定」，只看到一句 3 秒就消失的提示，不知道到底连上没连上。
    现在状态常驻在抽屉里：连上 / 连不上 / 那台没装模型，三种都写清楚，还注明什么时候测的。 */
/** R170：界面上不写完整内网地址。用户截图发出去时，`http://192.168.x.x:8123`
    等于把自己的网段和那台机器的位置一起送人（他自己在截图里手工涂过两次）。
    R172：**连第一段和最后一段也不给**。以前留成 `172.***.***.92`，用户当场就问
    「地址为啥不能完全去敏，为啥还搞个 172....92」—— 首尾两段照样能缩小到某个网段里的
    某一台。现在只留协议和端口（端口是必要的：12345 还是 8123 一眼看出是不是墨阅），
    主机一律换成点。
    输入框里仍是完整地址（自己要改，看得见），只有回显 / 状态行打码。 */
function maskAddr(u) {
  const s = String(u || '');
  const m = /^(https?:\/\/)([^\/:?#]+)(:\d+)?/.exec(s);
  if (!m) return s;
  const host = m[2];
  const out = /^[0-9.]+$/.test(host)
    ? host.split('.').map(function () { return '•••'; }).join('.')
    : '••••••';
  return m[1] + out + (m[3] || '');
}

function ocrRemoteStatHtml() {
  const b = ocrBase();
  if (!b) return '';
  const s = _ocrStatus || {};
  const show = esc(maskAddr(b));
  // 换了地址就别拿旧结果糊弄人
  if (!s.at || (s._base && s._base !== b)) {
    return '🖥 识别服务：<b>' + show + '</b> · 还没试过（点「改识别服务」确定会试一次）';
  }
  const when = ocrAgoText(s.at);
  if (!s.ok) {
    return '❌ 连不上 <b>' + show + '</b>（' + when + '试的）· 识别会退回本机';
  }
  if (!s.installed) {
    return '⚠️ 连上了 <b>' + show + '</b>，但那台没装识别模型（' + when + '试的）· 会退回本机';
  }
  return '✅ 识别服务 <b>' + show + '</b> 可用（' + when + '测的）';
}

function ocrEngineName(k) {
  const o = ocrEngines().filter(function (x) { return x.k === (k || ocrEngine()); })[0];
  return o ? o.n : '自动';
}
/** 问一次服务端：装没装、跑没跑、用 GPU 还是 CPU。缓存 20 秒，抽屉反复打开不会一直打接口。 */
function ocrStatus(force) {
  const now = Date.now();
  if (!force && _ocrStatus && now - _ocrStatus.at < 20000) return Promise.resolve(_ocrStatus);
  if (_ocrStatusBusy) return _ocrStatusBusy;
  /* R169：远程识别服务连不上时，浏览器默认要等很久（手机上像卡死）。
     5 秒没回应就当连不上，把话说清楚，别让「填完确定」变成一个没结果的等待。 */
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const to = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) { } }, 5000) : null;
  _ocrStatusBusy = fetch(ocrApi('/api/ocr/status'), {
    cache: 'no-store', mode: 'cors', signal: ctrl ? ctrl.signal : undefined
  })
    .then(function (r) { return r.json(); })
    .then(function (j) { _ocrStatus = Object.assign({ at: Date.now(), ok: true, _base: ocrBase() }, j || {}); return _ocrStatus; })
    .catch(function () { _ocrStatus = { at: Date.now(), ok: false, installed: false, running: false, _base: ocrBase() }; return _ocrStatus; })
    .then(function (v) {
      if (to) clearTimeout(to);
      _ocrStatusBusy = null;
      // 下载是在服务端跑的：点了「后台下载」就关页面的人，回来时在这里补一句「已经装好了」
      try { ocrNoticeDone(v); } catch (e) { }
      return v;
    });
  return _ocrStatusBusy;
}
/** 这次识别走不走本地模型（同步判据：只认上次探测的结果，别让点一下等三秒） */
function ocrUseLocal() {
  const e = ocrEngine();
  if (e === 'tesseract') return false;
  if (e === 'paddle') return false;          // R171：本机 PaddleOCR 不走 /api/ocr 那条线
  if (!_ocrStatus || !_ocrStatus.installed) return false;
  return true;
}
/** 后端状态一句话（给抽屉显示）。别写成「已安装未启动 · CPU（…加速不可用）」这种术语串：
 *  用户看不懂「未启动」是好是坏 —— 实际上本地引擎是**用到才起**，平时停着是正常的。 */
function ocrBackendText() {
  const isApp = typeof window !== 'undefined' && !!window.InkAndroid;
  /* R171：选了「本机 PaddleOCR」时，上面那些「本地模型装没装」的话全都不适用 ——
     它不看 /api/ocr，模型和运行时都随包带着。这里单独给一句实话：准不准、快不快。 */
  if (ocrEngine() === 'paddle') {
    const pw = (typeof OcrPaddle !== 'undefined' && OcrPaddle.status) ? OcrPaddle.status() : null;
    if (!pw) return '本机 PaddleOCR 没加载（会退回浏览器内识别）';
    if (pw.ready) {
      const s2 = pw.stat || {};
      return '✅ PaddleOCR 已就绪 · 随包带的模型（6 MB）· 刚才一页检测 ' + (s2.detMs || 0) +
        'ms / 识别 ' + (s2.recMs || 0) + 'ms · 不联网';
    }
    if (pw.err) return '❌ PaddleOCR 起不来：' + pw.err + '（会退回浏览器内识别）';
    return '本机 PaddleOCR：还没跑过，第一次识别会先加载模型（约 1~3 秒）';
  }
  /* R172：选了「浏览器内」就得说浏览器内的话。以前这里直接往下走，读的是
     「本地模型装没装」，于是切到「浏览器内」状态行还写着「已装 · 显卡 Vulkan」——
     看着像没切成功（用户就是这么以为的）。 */
  if (ocrEngine() === 'tesseract') {
    return '浏览器内识别（Tesseract）：不用装模型、不联网，漫画 / 小字 / 糊页会弱一些';
  }
  /* R159：填了「另一台设备的识别服务」就优先用它 —— 手机自己跑不动视觉模型，
     但局域网里电脑装了的话，认漫画/扫描件能强一个代差。 */
  const base = ocrBase();
  const show = maskAddr(base);          // R172：状态行也不露完整地址
  const st = _ocrStatus;
  if (base) {
    if (!st) return '正在问 ' + show + ' 的识别服务…';
    if (!st.ok) return '连不上 ' + show + '（会退回' + (isApp ? '手机内' : '浏览器内') + '识别）';
    if (!st.installed) return show + ' 上没装识别模型（会退回' + (isApp ? '手机内' : '浏览器内') + '识别）';
    const d0 = st.backend === 'cpu' ? 'CPU' : (st.backend === 'cuda' ? '显卡 CUDA' : '显卡 Vulkan');
    return '用 ' + show + ' 的模型识别 · ' + d0 + (st.running ? '' : '（用到才启动）');
  }
  /* R158：APK 里根本没有本地模型这条线（电脑版二进制跑不了安卓）。
     以前这里照样显示「未安装（改用浏览器内识别）」+ 一个「下载识别模型」按钮，
     点下去就撞 dalvik-cache 报错 —— 现在直接说清手机用的是哪一种。
     R159：识别引擎（WASM）+ 中/繁/英/日语言包已经随安装包带上了，不用再下载。 */
  if (isApp) {
    // R172：默认「自动」现在会落到 PaddleOCR 上，状态行得说实话
    if (ocrPaddleAllowed()) return '自动：先用本机 PaddleOCR（随包带模型，不联网），认不动再退回浏览器内';
    return '手机上直接认：引擎和中/繁/英/日语言包都在安装包里，不用下载、不联网也能用';
  }
  const s = _ocrStatus;
  if (!s) return '正在检测本地识别引擎…';
  if (!s.ok) return '没连上本地服务（识别会退回浏览器内）';
  if (!s.installed) return '未安装（改用浏览器内识别）';
  const dev = s.backend === 'cpu' ? 'CPU' : (s.backend === 'cuda' ? '显卡 CUDA' : '显卡 Vulkan');
  const slow = (s.backend === 'cpu' && s.gpu) ? '（显卡用不上，慢些）' : '';
  if (s.running) return '已就绪 · 用 ' + dev + ' 识别' + slow;
  return '已装 · 识别时自动启动 · ' + dev + slow;
}
/** 重新探测后端：清掉「上次验过的」再走一遍 GPU→CPU（换驱动后点这个） */async function ocrRedetect() {
  try {
    toast('正在检测显卡…');
    const r = await fetch('/api/ocr/redetect', { method: 'POST' });
    const j = await r.json().catch(function () { return null; });
    await ocrStatus(true);
    paintOcrEng();
    if (j && j.ok) toast(j.detail || '检测完成');
    else toast('检测失败：' + ((j && j.detail) || '看设置里的后端状态'));
  } catch (e) {
    toast('检测失败：' + e.message);
  }
}
/** 字节 → 人读。装模型这套东西动辄 1 GB，MB 整数看着没概念。 */
function ocrFmtBytes(n) {
  n = n || 0;
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return Math.round(n / 1048576) + ' MB';
  return Math.round(n / 1024) + ' KB';
}
/** 速度专用格式：必须保留一位小数。
 *  ocrFmtBytes 是给「体积」用的，Math.round 会把 0.9 KB/s 显示成「1 KB/s」——
 *  明明是龟速，看着却像有个整数的速度，用户反而更慌。 */
function ocrFmtRate(n) {
  n = n || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB/s';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB/s';
  return Math.round(n) + ' B/s';
}
/** 时长：超过一小时就换算，别甩出「约 37179 分钟」这种没法读的数。 */
function ocrFmtDur(sec) {
  sec = Math.max(0, sec || 0);
  if (sec < 60) return '不到 1 分钟';
  const m = Math.round(sec / 60);
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return h + ' 小时' + (r ? ' ' + r + ' 分' : '');
  const d = Math.floor(h / 24), hh = h % 24;
  return d + ' 天' + (hh ? ' ' + hh + ' 小时' : '');
}
/** 本地模型这条总共要多少（模型 + 运行时）。
 *  运行时按 CPU 包的实测体积兜底（105 MB）：没装时后端 libBytes=0，
 *  直接拿 totalBytes 会算出「1.22 GB」，装完却变成 1.32 GB，用户会以为算错了。 */
const OCR_LIB_EST = 110 * 1048576;
function ocrNeedBytes(s) {
  s = s || _ocrStatus || {};
  return 1310887648 + Math.max(s.libBytes || 0, OCR_LIB_EST);
}
/** 把「后端状态 + 下载/删除按钮」按当前探测结果刷新（抽屉里几个元素，可能不在 DOM 里） */
function paintOcrEng() {
  const s = _ocrStatus || {};
  const lb = $('ocrEngStat'), ib = $('ocrInstBtn'), rb = $('ocrRedetBtn');
  const sb = $('ocrInstStopBtn'), db = $('ocrDelBtn');
  const ins = !!s.installing;
  const pg = s.progress || {};
  if (lb) {
    // 下载中就把进度写进状态行：不打开弹窗也看得见「在下 / 下到哪」
    // 后面那句「可关窗口」很重要：以前下载中弹窗既没 ×也不能收起，
    // 用户点进去看进度就退不出来了（只能「取消下载」）。
    // 失败过也要在这里留一句：否则状态行回到「未安装」，看着像从没下过。
    const stgName = pg.stage === 'runtime' ? '正在准备识别引擎' : '正在下载模型';
    // 百分比只报「整体」这一个，跟弹窗同源。以前这里报的是 stagePct（本段百分比），
    // 分母是当前这一段（运行时 649 MB / 模型 1.31 GB），跟整体不是一回事 ——
    // 于是弹窗写 10%、抽屉写 29.2%，看着像两个地方在互相打脸（2026-11 用户反馈）。
    // 要说清「卡在哪一段」，用字节数说，别再养第二个百分比。
    const allPct = pg.pct || 0;
    lb.textContent = ins
      ? stgName + ' · 整体 ' + allPct + '%（' + ocrFmtBytes(pg.stageGot || pg.got) + ' / '
        + ocrFmtBytes(pg.stageTotal || pg.total) + '）· 可关掉窗口，下载不中断'
      : (s.failed ? '上次下载失败 · 点按钮看原因 / 重试'
        : (_ocrUninstallLeft ? '没删干净：' + _ocrUninstallWhy : ocrBackendText()));
  }
  if (rb) rb.hidden = !s.installed;
  if (sb) sb.hidden = !ins;
  if (db) {
    db.hidden = !(s.installed && !ins);
    // 删不干净时把按钮本身改掉：用户看到「删除模型」会以为没反应，再点第二次、第三次。
    db.textContent = _ocrUninstallLeft ? '再删一次（有文件被占用）' : '删除模型';
    db.title = _ocrUninstallLeft ? _ocrUninstallWhy : '';
  }
  if (!ib) return;
  /* 安卓壳：下载 / 删除模型、换后端这几个按钮统统收掉（点了只会报错），
     状态行在上面已经写成「手机内识别」。 */
  if (typeof window !== 'undefined' && window.InkAndroid) {
    ib.hidden = true;
    if (db) db.hidden = true;
    if (sb) sb.hidden = true;
    if (rb) rb.hidden = true;
    return;
  }
  ib.hidden = !!(s.installed && !ins);
  ib.disabled = false;                 // 下载中也要能点：点开弹窗看进度 / 取消
  ib.textContent = ins
    ? '查看下载进度'
    : (s.failed ? '重试下载（约 ' + ocrFmtBytes(ocrNeedBytes(s)) + '）'
      : '下载识别模型（约 ' + ocrFmtBytes(ocrNeedBytes(s)) + '）');
}
let _ocrPollTimer = 0;
/** 下载期间每 2.5 秒刷新一次进度；下完就停。进度按磁盘算，刷新页面也不丢。 */
function ocrPollInstall() {
  if (_ocrPollTimer) return;
  _ocrPollTimer = setInterval(async function () {
    const s = await ocrStatus(true);
    paintOcrEng();
    ocrInstPaint();
    if (!s || !s.installing) {
      clearInterval(_ocrPollTimer);
      _ocrPollTimer = 0;
      const s2 = await ocrStatus(true);
      paintOcrEng();
      ocrInstPaint();
      ocrInstFinish(s2);
    }
  }, 2500);
}
/* ---------------- 下载本地模型的弹窗（和「安装本地翻译引擎」对齐） ----------------
   为什么要有弹窗：模型 1.3 GB，用户有权先知道「装到哪个盘、占多少、盘里还剩多少」
   再决定要不要下。以前只有一个按钮，点下去按钮变成一行百分比 —— 装哪儿不知道，
   想改主意也没地方取消。 */
let _ocrInstSpeed = { stage: '', samples: [], bps: 0 };

/** 下载速度 = 最近 20 秒的平均，不是两次采样的瞬时差。
 *
 *  为什么：下载是 8 路 curl 各自缓冲写盘，磁盘上的字节是**台阶状**长的。
 *  2.5 秒一个采样窗口，经常正好落在两个台阶之间 —— 只多出几百字节，算出来
 *  「1 KB/s · 约 37179 分钟」，而实际可能有好几百 KB/s（2026-11-15 用户实测
 *  报的就是这个数）。窗口拉到 20 秒，台阶被摊平，数字才像真的。
 *  另外 30 秒一个字节都没多就直接归零，不拿旧速度骗人。 */
function ocrInstBps(stage, got) {
  const now = Date.now();
  const S = _ocrInstSpeed;
  if (S.stage !== stage) { S.stage = stage; S.samples = []; S.bps = 0; }
  S.samples.push({ t: now, got: got || 0 });
  while (S.samples.length > 2 && now - S.samples[0].t > 20000) S.samples.shift();
  const a = S.samples[0], dt = (now - a.t) / 1000;
  if (dt >= 6) {
    const d = (got || 0) - a.got;
    if (d > 0) S.bps = d / dt;
    else if (dt >= 30) S.bps = 0;
  }
  return S.bps;
}
/** 换阶段 / 重新开下载时清空采样（字节口径变了，差分没意义） */
function ocrInstSpeedReset() { _ocrInstSpeed = { stage: '', samples: [], bps: 0 }; }

/** 弹窗正文：两处真实落点 + 预计占用 + 剩余空间 + 断点续传说明 */
function ocrInstWhereHtml() {
  const s = _ocrStatus || {};
  const base = s.dir || '';
  const models = s.modelsDir || (base ? base + '\\models' : 'localocr\\models');
  const lib = s.libDir || (base ? base + '\\llama' : 'localocr\\llama');
  const need = ocrNeedBytes(s);
  const libB = Math.max(s.libBytes || 0, OCR_LIB_EST);   // 没装时按 CPU 包体积估
  const free = s.freeBytes || 0;
  const tight = free > 0 && free < need + 300 * 1048576;
  const head = s.installed
    ? '✅ 已装好，占用 <b>' + ocrFmtBytes((s.modelBytes || 0) + libB) + '</b><br>'
    : '';
  return head +
    '模型：<b class="ocr-inst-path">' + esc(models) + '\\</b><br>' +
    '运行时：<b class="ocr-inst-path">' + esc(lib) + '\\</b><br>' +
    '预计占用 <b>' + ocrFmtBytes(need) + '</b>（模型 ' + ocrFmtBytes(1310887648) +
    ' + 运行时 ' + ocrFmtBytes(libB) + '）· 所在盘剩余 <b' +
    (tight ? ' class="ocr-inst-warn"' : '') + '>' +
    (free ? ocrFmtBytes(free) : '读不到') + '</b>' +
    (tight ? '<br><span class="ocr-inst-warn">空间不太够，建议先清理</span>' : '') +
    // 失败原因只写一句：能看懂的那行（failMsg，服务端已挑好），没有才用日志末行。
    // 以前整段摊日志，半屏都是 [1/2] 下载 xxx 这种过程信息，真正原因反而看不出来。
    ((!s.installing && !s.installed && (s.failMsg || (s.logTail && s.logTail.length)))
      ? '<div class="ocr-inst-log">' + esc(String(s.failMsg || s.logTail[s.logTail.length - 1])) + '</div>'
      : '') +
    '<div class="ocr-inst-note"><b>不碰 C 盘</b>。支持断点续传：取消或关掉浏览器都不丢，再点接着下。</div>' +
    // 下载中必须说清「关窗 ≠ 取消」：否则用户点进来看进度就以为退不出去
    (s.installing
      ? '<div class="ocr-inst-note ocr-inst-note-key">关窗<b>不会</b>停止下载（进度在抽屉里）；要停点「取消下载」。</div>'
      : '') +
    // 分两段下：先运行时，再模型。运行时这一段能占整体的三分之一（CUDA 版 649 MB），
    // 不说明的话，用户看到百分比爬得慢就以为卡死了。
    //
    // R149：用户问「为什么下两个」—— 光说「分两步」不够，要说清这两样分别是什么、
    // 是不是重复下。所以下载中**不分阶段**都摆这一段，模型阶段再补一句「第几个文件」。
    ocrInstTwoStepHtml(s) +
    // 源（R149）：1 KB/s 时最该告诉用户「卡在哪个源上」，以及他能做什么。
    ocrInstSrcHtml(s);
}

/** 「要下两样东西」的说明。引擎/模型阶段各自说清在下第几个文件。 */
function ocrInstTwoStepHtml(s) {
  if (!s.installing || !s.progress) return '';
  const pg = s.progress;
  const rtTotal = pg.stage === 'runtime' ? (pg.stageTotal || 0) : 0;
  const head = pg.stage === 'runtime'
    ? '现在下 ① 识别引擎（' + (rtTotal ? ocrFmtBytes(rtTotal) : '24~650 MB') + '）'
    : '现在下 ② 识别模型（' + ocrFmtBytes(1310887648) + '）';
  let t = head + '。两样都要：① 是让电脑能跑模型的程序，② 才是认字的权重，不是重复下载。';
  const fm = /^(\d+)\/(\d+)\s+(.+)$/.exec(String(pg.file || ''));
  if (fm) {
    const i = parseInt(fm[1], 10), n = parseInt(fm[2], 10);
    if (pg.stage === 'runtime') {
      // CPU / Vulkan 版引擎只有 1 个包；只有 CUDA 版拆成「本体 + cudart 运行库」。
      // 用户问过「没显卡是不是只用下一个」——界面上直接答，别让他去猜 373 MB 要不要下。
      t += (n === 1)
        ? '没有 N 卡的机器用 CPU / Vulkan 版，引擎只有 1 个包（' + fm[3] +
          '），不用下 CUDA 那套 373 MB 运行库；下完这个就进模型。'
        : '引擎分 ' + n + ' 个包（本体 + CUDA 运行库），当前第 ' + i + ' 个（' + fm[3] +
          '），缺一个都起不来。';
    } else {
      t += '当前文件 ' + i + '/' + n + '（' + fm[3] +
        '）—— 两个 gguf 合起来才是一个完整模型，缺一个都起不来。';
    }
  }
  return '<div class="ocr-inst-note">' + esc(t) + '</div>';
}

/** 当前源的一行说明。github.com 要额外提示（用户可开加速器，否则等自动换源）。 */
function ocrInstSrcHtml(s) {
  const pg = s.progress || {};
  const src = String(pg.src || '');
  if (!s.installing || !src) return '';
  const gh = /(^|\.)github\.com$/i.test(src);
  return '<div class="ocr-inst-note' + (gh ? ' ocr-inst-note-key' : '') + '">' +
    '来源：<b>' + esc(src) + '</b>' +
    (gh
      // 这句是用户实测要的：看到 1 KB/s 时先怀疑 GitHub 直连，开加速器就能救回来；
      // 没加速器也别急，慢源超过 25 秒会被自动换掉。
      ? '（GitHub 直连不稳 —— 有加速器的话开上会快很多；不开也行，慢源 25 秒内会自动换镜像）'
      : '（镜像站，慢的话会自动换下一个源）') +
    '</div>';
}

/** 按当前状态重画弹窗（进度条只在下载中显示） */
function ocrInstPaint() {
  const mask = $('ocrInstMask');
  if (!mask) return;
  const s = _ocrStatus || {};
  const pg = s.progress || {};
  const ins = !!s.installing;
  const body = $('ocrInstBody');
  if (body) body.innerHTML = ocrInstWhereHtml();
  const prog = $('ocrInstProg');
  if (prog) prog.hidden = !ins;
  if (ins) {
    const pct = Math.min(100, pg.pct || 0);
    const fill = $('ocrInstFill'); if (fill) fill.style.width = pct + '%';
    const pctEl = $('ocrInstPct'); if (pctEl) pctEl.textContent = pct + '%';
    const eta = $('ocrInstEta');
    if (eta) {
      const bps = ocrInstBps(pg.stage, pg.got);
      // 主数字（进度条右边）是「整体」，这行说「这一段」的字节 ——
      // 两个数字各说各的分母，否则 191 MB / 649 MB 会被人拿去跟 10% 对比。
      let t = '本段 ' + (pg.stage === 'runtime' ? '识别引擎 ' : '模型 ')
        + ocrFmtBytes(pg.stageGot || pg.got) + ' / ' + ocrFmtBytes(pg.stageTotal || pg.total);
      if (bps > 0) {
        t += ' · ' + ocrFmtRate(bps);
        // 剩余时间必须按**整体**算：引擎 + 模型是两个下载任务，只按本段算会让人
        // 以为 649 MB 下完就完事了。所以明写「全部还需」。
        const left = (pg.total || 0) - (pg.got || 0);
        if (left > 0) {
          const secLeft = left / bps;
          // R149：超过 6 小时就别报具体数了。用户实测过「约 37179 分钟」——
          // 那是 25 天，报出来只会让人以为程序坏了。这种情况真实含义是
          // 「这个源不行」，那就直说会被换源 + 可开加速器。
          t += secLeft > 6 * 3600
            ? ' · 按当前速度要 6 小时以上（慢源会自动换；有加速器就开上会快很多）'
            : ' · 全部还需约 ' + ocrFmtDur(secLeft);
        }
      } else if ((pg.got || 0) > 0) {
        t += ' · 暂时没动静（在等源响应，超过 25 秒会自动换源）';
      }
      eta.textContent = t;
    }
  }
  const go = $('ocrInstGo'), bg = $('ocrInstBg'), ca = $('ocrInstCancel'), x = $('ocrInstX');
  // 已装好就只剩「关闭」：不给重新下载的入口（要重装先删）
  if (go) { go.hidden = ins || !!s.installed; go.textContent = s.failed ? '重试下载' : '开始下载'; }
  // 「后台下载」在下载中也要在：用户点进来看进度，得能就地收起来回到阅读。
  // 收起来 = ocrInstClose()，下载照跑（进度在抽屉状态行 / 按钮文案上）。
  if (bg) {
    bg.hidden = !!s.installed && !ins;        // 已装好且没在下 → 没东西可下
    bg.textContent = ins ? '收起窗口（继续下载）' : (s.failed ? '后台重试' : '后台下载');
    bg.disabled = false;
  }
  // × 下载中也给：以前隐藏是为了「别以为是取消」，结果变成「进来就出不去了」。
  // 现在文案和说明都写清「关窗不中断下载」，取消另有专门按钮 + 二次确认。
  if (x) {
    x.hidden = false;
    x.title = ins ? '关闭窗口（下载继续，不会中断；要停止请点「取消下载」）' : '关闭';
  }
  if (ca) { ca.disabled = false; ca.textContent = ins ? '取消下载' : '关闭'; }
  const title = $('ocrInstTitle');
  if (title) {
    title.textContent = ins ? '正在下载本地识别模型'
      : (s.installed ? '本地识别模型已装好'
        : (s.failed ? '下载中断' : '下载本地识别模型'));
  }
}

function ocrInstClose() {
  const m = $('ocrInstMask');
  if (m && m.parentNode) m.parentNode.removeChild(m);
}

/** 收起下载窗口：只关窗，下载照跑（进度靠抽屉状态行 / 轮询继续刷新）。 */
function ocrInstBgClose() {
  const ins = !!(_ocrStatus && _ocrStatus.installing);
  ocrInstClose();
  if (ins) toast('已收起窗口，下载在后台继续（抽屉里的状态行能看进度）');
}

/** 打开弹窗。已经在下的会直接显示进度（关掉抽屉再点也能看）。 */
function ocrInstOpen() {
  if ($('ocrInstMask')) { ocrInstPaint(); return; }
  const mask = document.createElement('div');
  mask.className = 'ocr-inst-mask';
  mask.id = 'ocrInstMask';
  mask.innerHTML =
    '<div class="ocr-inst" role="dialog" aria-modal="true">' +
      '<button class="ocr-inst-x" id="ocrInstX" aria-label="关闭" title="关闭">×</button>' +
      '<h3 id="ocrInstTitle">下载本地识别模型</h3>' +
      '<div class="ocr-inst-body" id="ocrInstBody"></div>' +
      '<div class="ocr-inst-prog" id="ocrInstProg" hidden>' +
        '<div class="ocr-inst-bar"><div class="ocr-inst-fill" id="ocrInstFill"></div></div>' +
        '<div class="ocr-inst-meta"><span id="ocrInstPct">0%</span><span id="ocrInstEta"></span></div>' +
      '</div>' +
      '<div class="ocr-inst-acts">' +
        '<button type="button" class="btn-plain" id="ocrInstBg">后台下载</button>' +
        '<button type="button" class="btn-plain" id="ocrInstCancel">关闭</button>' +
        '<button type="button" class="btn-primary" id="ocrInstGo">开始下载</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(mask);
  // 点遮罩空白 = 关闭。下载中也允许关：关窗**不等于**取消（取消另有按钮 + 二次确认），
  // 以前下载中点遮罩没反应，加上 × 也藏起来，用户点进来看进度就退不出去了。
  mask.addEventListener('click', function (e) {
    if (e.target === mask) ocrInstClose();
  });
  $('ocrInstX').onclick = ocrInstClose;
  $('ocrInstCancel').onclick = function () { ocrCancelInstall(); };
  $('ocrInstBg').onclick = function () {
    // 下载中：就地收起窗口；没在下载：按「后台下载」直接开跑再收起
    if (_ocrStatus && _ocrStatus.installing) ocrInstBgClose();
    else ocrStartInstall(true);
  };
  $('ocrInstGo').onclick = function () { ocrStartInstall(false); };
  ocrStatus(true).then(function () {
    paintOcrEng(); ocrInstPaint();
    if (_ocrStatus && _ocrStatus.installing) ocrPollInstall();
  });
  ocrInstPaint();
}

/** 发起下载。bg=true 表示「后台下载」：发起后关掉弹窗，进度在抽屉状态行里看。 */
async function ocrStartInstall(bg) {
  /* ⚠ 安卓壳里不要下：本地识别引擎是电脑版的 llama.cpp（x86 可执行文件 + 几百 MB 模型），
     安卓既跑不了这个二进制、也没法在 dalvik-cache 里换属主 —— 用户看到的只会是
     「Error changing dalvik-cache ownership : Permission denied」这种完全看不懂的报错。 */
  if (window.InkAndroid) {
    toast('安卓版没有本地识别引擎：那是电脑版的程序（几百 MB）。'
      + '要识别请在电脑上做，再用「⇄ 对账」把笔记 / 译文同步过来。');
    return;
  }
  if (_ocrStatus && _ocrStatus.installing) { if (bg) ocrInstClose(); return; }
  _ocrInstUserStop = false;            // 用户在重试，之前那次「取消」标记作废
  const go = $('ocrInstGo'), bgb = $('ocrInstBg');
  if (go) { go.disabled = true; go.textContent = '正在启动…'; }
  if (bgb) bgb.disabled = true;
  try {
    const r = await fetch('/api/ocr/install', { method: 'POST' });
    const j = await r.json().catch(function () { return {}; });
    if (!j.ok) { toast(j.error || '下载启动失败'); return; }
    toast(j.already ? '已经在下载了'
      : ('开始下载（约 ' + ocrFmtBytes(ocrNeedBytes()) + '），下完会提示'));
    if (bg) ocrInstClose();
    await ocrStatus(true);
    paintOcrEng(); ocrInstPaint();
    ocrPollInstall();
  } catch (e) {
    toast('下载启动失败：' + (e && e.message ? e.message : e));
  } finally {
    if (go) { go.disabled = false; go.textContent = (_ocrStatus && _ocrStatus.failed) ? '重试下载' : '开始下载'; }
    if (bgb) bgb.disabled = false;
  }
}

/** 取消下载：真的停下来（后端杀进程树 + 清临时分片），不是只把进度藏起来。 */
async function ocrCancelInstall() {
  const s = _ocrStatus || {};
  if (!s.installing) { ocrInstClose(); return; }
  if (!confirm('取消下载？\n\n已经下完的文件会保留，下次接着下；下到一半的临时分片会清理掉。')) return;
  _ocrInstUserStop = true;             // 自己点的取消，别当成「下载中断」弹回来
  const ca = $('ocrInstCancel');
  if (ca) { ca.disabled = true; ca.textContent = '正在停止…'; }
  try {
    const r = await fetch('/api/ocr/install/cancel', { method: 'POST' });
    const j = await r.json().catch(function () { return {}; });
    toast(j.detail || (j.ok ? '已停止下载' : '停止失败'));
  } catch (e) {
    toast('停止下载失败：' + (e && e.message ? e.message : e));
  }
  ocrInstSpeedReset();
  await ocrStatus(true);
  paintOcrEng(); ocrInstPaint();
  if (ca && !(_ocrStatus && _ocrStatus.installing)) ocrInstClose();
}

/** 删除模型（只删 localocr\，不碰 data\；删完回落到浏览器内识别） */
async function ocrUninstall() {
  const s = _ocrStatus || {};
  const sz = ocrFmtBytes((s.modelBytes || 0) + (s.libBytes || 0));
  const where = (s.modelsDir || (s.dir ? s.dir + '\\models' : 'localocr\\models')) + '\\';
  if (!confirm('删除本地识别模型？\n\n会删掉 ' + sz + '：' + where +
    '\n删完自动回到浏览器内识别（Tesseract），以后还能重新下载。\n' +
    '\n书和标注不受影响 —— 只删模型文件本身。')) return;
  toast('正在删除…');
  let j = {};
  let netErr = '';
  try {
    const r = await fetch('/api/ocr/uninstall', { method: 'POST' });
    j = await r.json().catch(function () { return {}; });
  } catch (e) {
    // 服务端异常时连接会被掐断，response.json() 抛「Unexpected end of JSON input」——
    // 别把这句原文丢给用户，他只需要知道「没删成，再试一次」。
    netErr = (e && e.message) ? e.message : String(e);
  }
  // 引擎选的还是「本地模型」但文件没了 → 回到 auto，别让用户每页卡一次超时
  if (typeof Settings !== 'undefined' && Settings && Settings.ocrEngine === 'local') {
    Settings.ocrEngine = 'auto';
    try { saveSettings(); } catch (e) { }
  }
  // ⚠️ 丢掉缓存**和在途请求**：轮询可能刚好在删除前发出，回来会把「还装着」塞回界面，
  //    于是删完了按钮还是「删除模型」（用户就会反复点第二次、第三次）。
  _ocrStatus = null;
  _ocrStatusBusy = null;
  const s2 = await ocrStatus(true) || {};
  if (!s2.installed) {
    // 删干净了：按钮要变回「下载识别模型」（paintOcrEng 按 installed 画）
    _ocrUninstallLeft = 0;
    _ocrUninstallWhy = '';
    paintOcrEng();
    ocrInstPaint();
    toast(j.detail || (netErr ? '删除请求异常，但模型已经不在本机了' : '已删除'));
    return;
  }
  // 没删干净：说清楚，否则「点了没反应」——用户唯一能做的就是再点一次
  _ocrUninstallLeft = Math.max(1, parseInt(j.left, 10) || 0);
  _ocrUninstallWhy = j.detail || netErr || '还有文件没删掉（正被占用）';
  paintOcrEng();
  ocrInstPaint();
  toast(_ocrUninstallWhy);
}

/** 轮询发现「不再下载」时收尾：装好了就提示；没装成要把窗口留住并说清原因。

    ⚠️ 这里以前只把进度条末位写成「已停止」—— 而「后台下载」模式下窗口早就关了，
    用户看到的就是「下载自己跳没了」，最后只有 localocr\install.log 里一段 traceback。
    现在：失败 = 把窗口拉回来 + 摊日志最后一行 + 给「重试下载」；用户自己点的取消不算失败。 */
let _ocrInstUserStop = false;

/** 下载结束了（在别的页面/关着页面下的）→ 补一句「已经装好了」，同一次结束只报一次。
 *  服务端 `lastDone` 是下载进程退出时记下的（watch 线程，不依赖页面轮询）。
 *  一小时前的旧结果不再报：那是上次开机的事，用户早就知道了。 */
function ocrNoticeDone(s) {
  const d = s && s.lastDone;
  if (!d || !d.ok || !s.installed) return false;
  if (d.at === _ocrDoneNotifiedAt) return false;
  if (Date.now() / 1000 - d.at > 3600) return false;
  _ocrDoneNotifiedAt = d.at;
  try { toast('识别模型已装好，选「本地模型」就能用'); } catch (e) { }
  return true;
}

function ocrInstFinish(s) {
  if (!s) return;
  ocrInstSpeedReset();
  if (s.installed) {
    _ocrInstUserStop = false;
    // 正常情况下 status 回来时 ocrNoticeDone 已经报过了（同一次结束只报一次，别叠两句）；
    // 只有老服务没有 lastDone 字段时才在这里兜一句。
    if (!s.lastDone) {
      try { toast('识别模型已装好，选「本地模型」就能用'); } catch (e) { }
    }
    ocrInstPaint();
    return;
  }
  const et = $('ocrInstEta');
  if (et) et.textContent = '已停止';
  if (_ocrInstUserStop) { _ocrInstUserStop = false; ocrInstPaint(); return; }
  ocrInstOpen();                       // 已开着就只是重画
  ocrInstPaint();
  const why = s.failMsg || ((s.logTail && s.logTail.length) ? s.logTail[s.logTail.length - 1] : '');
  try { toast('下载中断' + (why ? '：' + why : '，可点「重试下载」接着下')); } catch (e) { }
}

/** 视觉模型的花费跟像素成正比（每 784 像素左右一个 token）：2800 宽的一页要算
 *  七八千个 token，CPU 上就是好几分钟还容易把上下文顶爆。这里把长边压到 1600 —— 
 *  一页漫画的对白在 1600 下仍然清楚，速度却能快三四倍。返回缩放比，坐标按它还原。 */
const OCR_REMOTE_MAX_SIDE = 1600;
function ocrShrinkCanvas(canvas) {
  const long = Math.max(canvas.width, canvas.height);
  const k = Math.min(1, OCR_REMOTE_MAX_SIDE / Math.max(1, long));
  if (k > 0.995) return { cv: canvas, k: 1 };
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(canvas.width * k));
  c.height = Math.max(1, Math.round(canvas.height * k));
  const g = c.getContext('2d');
  if (g) {
    g.imageSmoothingEnabled = true;
    try { g.imageSmoothingQuality = 'high'; } catch (e) { }
    g.drawImage(canvas, 0, 0, c.width, c.height);
  }
  return { cv: c, k: k };
}
/** 让本地模型认一页 canvas → 返回 [{text,bbox}]（bbox 是**原 canvas** 的像素坐标）。
 *  图片只在内存里转一圈，不落盘；服务端把 JPEG 直接喂给模型。 */
async function ocrRemoteCanvas(canvas, vert) {
  const cfg = ocrCfg();
  const shrunk = ocrShrinkCanvas(canvas);
  const blob = await new Promise(function (res) {
    try { shrunk.cv.toBlob(res, 'image/jpeg', 0.92); } catch (e) { res(null); }
  });
  if (!blob) throw new Error('图片转 JPEG 失败');
  const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  // 超时跟后端对齐（后端 urlopen timeout=600）：以前前端 300 秒就先掐了，
  // 一页 A4 扫描件在 CPU 上实测 ~190 秒，字多一点的页就顶到 300 秒 →
  // 前端当成「模型没响应」退回 Tesseract（更认不动）→ 用户看到的是「识别总失败」。
  const timer = ctl ? setTimeout(function () { ctl.abort(); }, 600000) : 0;
  if (ctl) R._ocrAbort = ctl;          // 「⏹ 停止」要能当场掐断，而不是等这一页算完
  let resp;
  try {
    resp = await fetch(ocrApi('/api/ocr'), {
      method: 'POST',
      headers: {
        'Content-Type': 'image/jpeg',
        'X-Ocr-Lang': cfg.langs.join('+'),
        'X-Ocr-Vert': vert ? '1' : '0'
      },
      body: blob,
      signal: ctl ? ctl.signal : undefined
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(R._ocrCancel
        ? '已停止（用户取消）'
        : '这一页 10 分钟还没算完（CPU 上一页约 2–3 分钟），已中断；可只选几页重试');
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    if (ctl && R._ocrAbort === ctl) R._ocrAbort = null;
  }
  let j = null;
  try { j = await resp.json(); } catch (e) { }
  if (!j) throw new Error('识别服务没有返回 JSON（HTTP ' + resp.status + '）');
  if (!j.ok) throw new Error(j.error || '识别失败');
  const back = 1 / (shrunk.k || 1);          // 缩小过就把坐标还原回原 canvas
  return (j.words || []).map(function (w) {
    const b = w.bbox || {};
    return {
      text: w.text, confidence: w.confidence,
      bbox: {
        x0: (b.x0 || 0) * back, y0: (b.y0 || 0) * back,
        x1: (b.x1 || 0) * back, y1: (b.y1 || 0) * back
      }
    };
  });
}

/** 抽屉里的「识别语言 / 排版方向」控件（PDF 扫描页和图片书共用同一块） */
function ocrCfgHtml() {
  const cfg = ocrCfg();
  // 初始按钮状态就按「上次探测到的」画对：抽屉每次打开都会重填 innerHTML，
  // 新节点不带上状态 → 模型明明装好了，却先闪一颗「下载识别模型」出来。
  const st0 = _ocrStatus || {};
  const have0 = !!st0.installed;
  const ins0 = !!st0.installing;
  const chip = function (v, n, on, attr) {
    return '<button type="button" class="ocr-chip' + (on ? ' on' : '') + '" data-' + attr + '="' + v + '">' + n + '</button>';
  };
  return '<div class="ocr-sec">' +
    '<div class="ocr-sec-t">识别引擎<span class="ocr-sec-h" title="本机 PaddleOCR：随包带模型（6 MB），中文/漫画/扫描件最准，完全离线，不用连电脑。本地模型：电脑版那套视觉模型（1.4 GB），漫画/扫描件强但手机上跑不动。浏览器内：Tesseract，不用装东西但认不动漫画。">手机上优先用前两个</span></div>' +
    '<div class="ocr-chips" id="ocrEngChips">' +
      ocrEngines().map(function (o) { return chip(o.k, o.n, cfg.engine === o.k, 'eng'); }).join('') +
    '</div>' +
    '<div class="ocr-cur" id="ocrEngStat">' + ocrBackendText() + '</div>' +
    /* R172：下面这一整块（下载/删除模型、借电脑的识别服务）**只对「自动 / 本地模型」有意义**。
       PaddleOCR 随包带模型，浏览器内是 Tesseract —— 选着它们还摆一堆「下载 1.33 GB」
       「改识别服务」，用户点下去只会莫名其妙（他原话：只在本地模型那里用，就只在
       本地模型和自动那里显示）。所以整块一起收，切引擎时由 paint() 跟着收放。 */
    '<div id="ocrLocalWrap"' + ((cfg.engine === 'auto' || cfg.engine === 'local') ? '' : ' hidden') + '>' +
    '<div class="ocr-row">' +
      '<button type="button" class="btn-plain" id="ocrInstBtn"' + (have0 && !ins0 ? ' hidden' : '') + '>' +
        (ins0 ? '查看下载进度' : '下载识别模型') + '</button>' +
      '<button type="button" class="btn-plain" id="ocrInstStopBtn"' + (ins0 ? '' : ' hidden') + '>取消下载</button>' +
      '<button type="button" class="btn-plain" id="ocrRedetBtn"' + (have0 ? '' : ' hidden') + '>重新检测显卡</button>' +
      '<button type="button" class="btn-plain" id="ocrDelBtn"' + (have0 && !ins0 ? '' : ' hidden') + '>删除模型</button>' +
    '</div>' +
    // R159：手机跑不动视觉模型，但可以借电脑的 —— 这一行就是那个入口
    '<div class="ocr-row">' +
      '<button type="button" class="btn-plain" id="ocrRemoteBtn">🖥 ' +
        (ocrBase() ? '改识别服务…' : '用另一台设备（电脑）的识别模型…') +
      '</button>' +
    '</div>' +
    // R169：连上没连上要能看见，不能只靠一句会消失的提示
    (ocrBase() ? '<div class="ocr-cur" id="ocrRemoteStat">' + ocrRemoteStatHtml() + '</div>' : '') +
    // 地址从哪来，直接写在这里：以前只在弹窗标题里给一个像真地址的示例，等于没说
    '<div class="ocr-hint">填什么：那台<b>装了识别模型的电脑</b>在局域网里的地址。' +
      '在电脑上打开墨阅 →「设置 → 连到别的设备」最上面那行「我的地址」，' +
      '或「📡 共享」面板里显示的那串地址（形如 <code>http://电脑的局域网地址:8123</code>）。<br>' +
      '留空＝只用本机。手机上有「本机 PaddleOCR」就够了（随包带模型，不联网）；' +
      '「本地模型」那套 1.4 GB 是电脑版的，手机上跑不起来。</div>' +
    '</div>' +
    '<div class="ocr-sec-t">识别语言<span class="ocr-sec-h" title="可多选。认日文漫画就选「日本語」；中英混排留「简体中文 + English」。每多一种语言多下十几 MB 包，也慢一些。">可多选</span></div>' +
    '<div class="ocr-chips" id="ocrLangChips">' +
      OCR_LANGS.map(function (o) { return chip(o.k, o.n, cfg.langs.indexOf(o.k) >= 0, 'lang'); }).join('') +
    '</div>' +
    '<div class="ocr-sec-t">排版方向<span class="ocr-sec-h" title="竖排（日漫、台版／港版书、古文）会把图顺时针转 90° 再识别，认完把坐标转回来；自动＝先横排，认不出东西再试竖排。">竖排会转 90° 再认</span></div>' +
    '<div class="ocr-chips" id="ocrDirChips">' +
      ['auto', 'h', 'v'].map(function (d) { return chip(d, ocrDirName(d), cfg.dir === d, 'dir'); }).join('') +
    '</div>' +
    '<div class="ocr-cur" id="ocrCfgLabel">当前：' + ocrCfgLabel(cfg) + '</div>' +
  '</div>';
}

/** 绑上面那块控件（两个抽屉共用；root 传抽屉 body） */
function bindOcrCfgUi(root) {
  if (!root) return;
  // ⚠️ 抽屉 body 是常驻元素，innerHTML 每次重填但监听器不会跟着消失：
  //    不挡一下，开几次抽屉就叠几层 handler，点一次胶囊会来回切好几次。
  //    但「不重复绑」不等于「不重画」：新节点是按 ocrCfgHtml() 的初始态生成的，
  //    模型已经装好也可能先长出一颗「下载识别模型」。所以先 paint 再回去。
  const paint = function () {
    const cfg = ocrCfg();
    const lc = $('ocrLangChips'), dc = $('ocrDirChips'), lb = $('ocrCfgLabel');
    const ec = $('ocrEngChips');
    if (lc) Array.prototype.forEach.call(lc.children, function (b) { b.classList.toggle('on', cfg.langs.indexOf(b.dataset.lang) >= 0); });
    if (dc) Array.prototype.forEach.call(dc.children, function (b) { b.classList.toggle('on', b.dataset.dir === cfg.dir); });
    if (ec) Array.prototype.forEach.call(ec.children, function (b) { b.classList.toggle('on', b.dataset.eng === cfg.engine); });
    // R172：本地模型那一整块（下载/删除/改识别服务）只在「自动 / 本地模型」下有意义
    // （PaddleOCR 随包带模型、浏览器内是 Tesseract，都不走 /api/ocr）。
    // 切引擎时跟着收放，不用等抽屉重开。
    const rw = $('ocrLocalWrap');
    if (rw) rw.hidden = !(cfg.engine === 'auto' || cfg.engine === 'local');
    paintOcrEng();
    if (lb) lb.textContent = '当前：' + ocrCfgLabel(cfg);
  };
  root._ocrCfgPaint = paint;          // 抽屉重开时用它把新节点重画一遍
  if (root._ocrCfgBound) {
    try { paint(); } catch (e) { }
    if (_ocrStatus && _ocrStatus.installing) ocrPollInstall();
    return;
  }
  root._ocrCfgBound = true;
  // 打开抽屉就问一次后端状态（缓存 20 秒，不会每开一次都打接口）；
  // 正在下载的话顺手把轮询接上 —— 关掉抽屉再打开也能继续看进度。
  ocrStatus().then(function (s) {
    paint();
    if (s && s.installing) ocrPollInstall();
  });
  root.addEventListener('click', async function (e) {
    // 「重新检测显卡」：换过驱动 / 换过机器才需要（正常情况下后端结论会记住）
    const rb = (e.target && e.target.closest) ? e.target.closest('#ocrRedetBtn') : null;
    if (rb) {
      e.preventDefault();
      rb.disabled = true;
      await ocrRedetect();
      rb.disabled = false;
      paint();
      return;
    }
    // 下载按钮单独一支（它不是 .ocr-chip，进去会被上面的 closest 过滤掉）
    const ib = (e.target && e.target.closest) ? e.target.closest('#ocrInstBtn') : null;
    if (ib) {
      e.preventDefault();
      // 下载中也能点：打开弹窗看进度 / 取消（不再像以前那样点下去就没退路）
      ocrInstOpen();
      return;
    }
    // 抽屉里直接取消下载
    const cb2 = (e.target && e.target.closest) ? e.target.closest('#ocrInstStopBtn') : null;
    if (cb2) {
      e.preventDefault();
      await ocrCancelInstall();
      paint();
      return;
    }
    // 删除模型（释放 1.4 GB）
    const db2 = (e.target && e.target.closest) ? e.target.closest('#ocrDelBtn') : null;
    if (db2) {
      e.preventDefault();
      await ocrUninstall();
      paint();
      return;
    }
    // 借另一台设备（电脑）的识别模型
    const rem = (e.target && e.target.closest) ? e.target.closest('#ocrRemoteBtn') : null;
    if (rem) {
      e.preventDefault();
      /* R169：以前标题里写「例 192.168.x.x:8123」—— 那是个看着像真的内网地址，
         用户会去找自己机器上有没有这个 IP。现在示例写 xxx，并且说清去哪抄：
         电脑上「设置 → 连到别的设备」最上面那条「我的地址」。 */
      showInput('识别服务地址（填电脑那台上的「我的地址」，留空＝只用本机）',
        ocrBase() || '',
        async function (v) {
          const b2 = ocrNormBase(v);
          if (typeof Settings !== 'undefined' && Settings) {
            Settings.ocrRemoteBase = b2;
            try { saveSettings(); } catch (err) { }
          }
          _ocrStatus = null;
          paint();
          if (!b2) { toast('已改回只用本机识别'); return; }
          /* 先给一个「在连」的反馈，再报结果。以前是「点确定 → 一片安静 → 3 秒后
             一个 toast 闪过」，用户根本分不清成没成；现在结果还常驻在抽屉里。 */
          const st0 = $('ocrStatus');
          if (st0) st0.textContent = '⏳ 正在连 ' + maskAddr(b2) + ' …（最多等 5 秒）';
          const st = await ocrStatus(true);
          paint();                       // 重画后 #ocrRemoteStat 就是最新状态
          const line = $('ocrRemoteStat');
          if (line) line.innerHTML = ocrRemoteStatHtml();
          if (st && st.ok && st.installed) {
            if (st0) st0.textContent = '✅ 已连上 ' + maskAddr(b2) + '，之后识别用那台设备的模型';
            toast('✅ 已连上 ' + maskAddr(b2) + '，识别会用那台的模型');
          } else if (st && st.ok) {
            if (st0) st0.textContent = '⚠️ ' + maskAddr(b2) + ' 连上了，但那台还没装识别模型 —— 识别时会用本机';
            toast('连上了，但那台还没装识别模型（会先用本机识别）');
          } else {
            if (st0) st0.textContent = '❌ 连不上 ' + maskAddr(b2) + ' —— 识别时会用本机。确认两台在同一个 WiFi、那台开着墨阅';
            toast('❌ 连不上 ' + maskAddr(b2) + '：确认两台在同一个 WiFi、那台开着墨阅');
          }
        },
        { placeholder: '那台电脑的局域网地址:8123' });
      return;
    }
    const b = e.target && e.target.closest ? e.target.closest('.ocr-chip') : null;
    if (!b) return;
    e.preventDefault();
    if (b.dataset.eng) {
      const pick = b.dataset.eng;
      if (typeof Settings !== 'undefined' && Settings) {
        Settings.ocrEngine = pick;
        try { saveSettings(); } catch (err) { }
      }
      /* R172：**先亮，再问**。以前是 await ocrStatus(true) 之后才 paint()，
         而这台机器 /api/ocr/status 要 3.6 秒（手机上更慢，超时是 5 秒）——
         点一下胶囊三秒半没反应，看着就像没点上（用户：「没法轻易切换识别引擎，
         要点一下别的按钮才行」）。现在高亮和状态行立刻变，后端状态在后台补。 */
      paint();
      if (pick === 'tesseract') {
        toast('已切到浏览器内识别（Tesseract）');
        return;
      }
      /* R171：PaddleOCR 不用问后端，直接开始加载模型（1~3 秒）。
         点了没反应是最糟的体验，所以先 paint 再 await。 */
      if (pick === 'paddle') {
        toast('正在加载本机 PaddleOCR（第一次约 1~3 秒）…');
        try {
          await OcrPaddle.warmup();
          toast(ocrBackendText());        // 这行自带「✅ PaddleOCR 已就绪」，别再叠一层
        } catch (e) {
          toast('PaddleOCR 起不来：' + String((e && e.message) || e) + '（识别会退回浏览器内）');
        }
        paint();
        return;
      }
      ocrStatus(true).then(function (s) {
        paint();
        s = s || _ocrStatus || {};
        if (pick !== 'auto' && !s.installed) {
          toast('本地识别模型还没装，现在仍用浏览器内识别（上面有下载入口）');
        } else if (pick === 'local' && s.installed) {
          toast('已切到本地模型：' + ocrBackendText());
        }
      });
      return;
    }
    if (b.dataset.lang) {
      const langs = ocrCfg().langs.slice();
      const at = langs.indexOf(b.dataset.lang);
      if (at >= 0) {
        if (langs.length === 1) { toast('至少要留一种识别语言'); return; }
        langs.splice(at, 1);
      } else langs.push(b.dataset.lang);
      await setOcrCfg({ langs: langs });
    } else if (b.dataset.dir) {
      await setOcrCfg({ dir: b.dataset.dir });
    } else return;
    paint();
    // 已经识别过的页是用旧语言认的：不自动重认（贵），但要把话说清楚
    const n = R.format === 'comic'
      ? ((R._imgOcrPages && R._imgOcrPages.size) || 0)
      : (R._ocrWords ? Object.keys(R._ocrWords).length : 0);
    if (n) toast('语言 / 方向已改，已识别的 ' + n + ' 页要重新识别一次才会按新设置来');
  });
}

function ocrCfgKey() { return 'ocrCfg:' + ((R.book && R.book.id) || ''); }

/** 当前这本书的 OCR 设置：书里存过用书里的，否则用全局「上次选的」。
 *  书级配置真的有用 —— 同一个人的书架上日文漫画和中文小说是混着放的。 */
function ocrCfg() {
  const s = (typeof Settings !== 'undefined' && Settings) || {};
  let langs = (R._ocrCfg && R._ocrCfg.langs) || s.ocrLangs;
  if (!Array.isArray(langs) || !langs.length) langs = ['chi_sim', 'eng'];
  langs = langs.filter(function (k) {
    return OCR_LANGS.some(function (o) { return o.k === k; });
  });
  if (!langs.length) langs = ['chi_sim'];
  let dir = (R._ocrCfg && R._ocrCfg.dir) || s.ocrDir || 'auto';
  if (['auto', 'h', 'v'].indexOf(dir) < 0) dir = 'auto';
  return { langs: langs, dir: dir, engine: ocrEngine() };
}
function ocrLangString(cfg) {
  cfg = cfg || ocrCfg();
  return cfg.langs.join('+');
}
/** 「用哪套语言 + 哪个方向」的签名：换设置后已识别的页要当没识别过 */
function ocrSig() { const c = ocrCfg(); return c.langs.join('+') + '|' + c.dir; }
function ocrDirName(dir) { return dir === 'v' ? '竖排' : (dir === 'h' ? '横排' : '自动'); }
function ocrCfgLabel(cfg) {
  cfg = cfg || ocrCfg();
  const names = cfg.langs.map(function (k) {
    const o = OCR_LANGS.filter(function (x) { return x.k === k; })[0];
    return o ? o.n : k;
  });
  return names.join(' + ') + ' · ' + ocrDirName(cfg.dir);
}
async function loadOcrCfg() {
  R._ocrCfg = null;
  const key = ocrCfgKey();
  if (!R.book || !R.book.id) return null;
  try {
    const rec = await DB.kvGet(key);
    if (rec && Array.isArray(rec.langs) && rec.langs.length) R._ocrCfg = { langs: rec.langs.slice(), dir: rec.dir || 'auto' };
  } catch (e) { console.warn('读取 OCR 设置失败', e); }
  return R._ocrCfg;
}
/** 改 OCR 设置：写书级 kv + 记住全局默认 + 把源语言同步给翻译。
 *  返回新配置。已识别过的页不会自动重认（贵），由用户按「识别本页 / 识别全部」。 */
async function setOcrCfg(patch) {
  const cur = ocrCfg();
  const next = {
    langs: (patch && patch.langs ? patch.langs.slice() : cur.langs.slice()),
    dir: (patch && patch.dir) || cur.dir
  };
  if (!next.langs.length) next.langs = ['chi_sim'];
  if (['auto', 'h', 'v'].indexOf(next.dir) < 0) next.dir = 'auto';
  R._ocrCfg = next;
  if (typeof Settings !== 'undefined' && Settings) {
    Settings.ocrLangs = next.langs.slice();
    Settings.ocrDir = next.dir;
    try { saveSettings(); } catch (e) { }
  }
  try { await DB.kvSet(ocrCfgKey(), { langs: next.langs, dir: next.dir }); } catch (e) { }
  // 翻译的源语言跟着 OCR 语言走：「日语漫画翻成中文」把源语言写成 JA，比 auto 稳
  try {
    if (window.InkTranslate && InkTranslate.setBookSourceLang) InkTranslate.setBookSourceLang(ocrSrcLangOf(next.langs));
  } catch (e) { }
  return next;
}
/** 识别语言 → 翻译源语言。只有「明确是一种非中文语言（+英文）」时才写死，其余交给 auto */
function ocrSrcLangOf(langs) {
  const main = (langs || []).filter(function (k) { return k !== 'eng'; });
  if (main.length === 1 && OCR_SRC_LANG[main[0]]) return OCR_SRC_LANG[main[0]];
  return 'auto';
}

/** 处理竖排用**逆时针**转 90°（不是顺时针，很容易搞反）：
 *  竖排一列 = 字从上到下；逆时针转完，这一列变成一行、字从左到右，
 *  而且「列从右往左」正好变成「行从上往下」—— Tesseract 拿到的就是一张正常的横排页面。
 *  （顺时针转的话，列内的字会变成从右往左读，认出来全是反的。） */
function rotateCanvasV(cv) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, cv.height);
  c.height = Math.max(1, cv.width);
  const g = c.getContext('2d');
  g.translate(0, c.height);
  g.rotate(-Math.PI / 2);
  g.drawImage(cv, 0, 0);
  return c;
}
/** 旋转图（逆时针）里的框 → 原图里的框。w = 原图宽（= 旋转图高）。
 *  映射：x' = y、y' = w - x，所以反解 x = w - y'、y = x'。 */
function unrotateBox(b, w) {
  return { x0: w - b.y1, y0: b.x0, x1: w - b.y0, y1: b.x1 };
}
/** 竖排的阅读顺序：**列从右往左**，同列从上往下。
 *  转 90° 之后 Tesseract 给的是「列 = 行，从左往右」，日文／中文竖排正好是反的。 */
function orderVertical(words) {
  if (!words || words.length < 2) return (words || []).slice();
  const wds = words.map(function (w) { return Math.max(1, (w.bbox.x1 - w.bbox.x0)); }).sort(function (a, b) { return a - b; });
  const step = Math.max(6, (wds[(wds.length - 1) >> 1] || 12) * 0.7);
  return words.slice().sort(function (a, b) {
    const ca = Math.round((a.bbox.x0 + a.bbox.x1) / 2 / step);
    const cb = Math.round((b.bbox.x0 + b.bbox.x1) / 2 / step);
    if (ca !== cb) return cb - ca;                 // 列：右 → 左
    return a.bbox.y0 - b.bbox.y0;                  // 同列：上 → 下
  });
}
function ocrCharsOf(words) {
  let n = 0;
  (words || []).forEach(function (w) { n += String(w.text || '').replace(/\s+/g, '').length; });
  return n;
}
function ocrConfOf(words) {
  let s = 0, n = 0;
  (words || []).forEach(function (w) {
    const c = (w.confidence === 0 || w.confidence) ? w.confidence : 80;
    s += c; n++;
  });
  return n ? s / n : 0;
}
function ocrScoreOf(r) {
  return ocrCharsOf(r.words) * (0.2 + Math.max(0, Math.min(100, r.conf || 0)) / 100);
}

/** 送进识别引擎前先「修一下图」（R122）。
 *  彩漫 / 扫描件的乱码有一大半不是模型不行，而是：
 *    · 彩色背景 + 深色描边的字（灰度化后对比才够）
 *    · 整体偏暗的截图（黑底白字）—— Tesseract 只擅长「白底黑字」，得反相
 *    · 画面偏灰、对比度低 —— 按 2% / 98% 分位拉一次
 *  不改尺寸（坐标映射不能变），也不做二值化（会把中文小字的抗锯齿吃掉，反而更差）。
 *  ⚠️ 一定 clone 一份再改：PDF 那里的 canvas 就是屏幕上显示的那张，就地改会把书变灰。 */
function ocrPrepCanvas(src) {
  const cv = document.createElement('canvas');
  cv.width = src.width; cv.height = src.height;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, 0, 0);
  try {
    const W = cv.width, H = cv.height;
    const d = g.getImageData(0, 0, W, H);
    const p = d.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < p.length; i += 4) {
      const v = (p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114) | 0;
      p[i] = p[i + 1] = p[i + 2] = v; p[i + 3] = 255;
      hist[v]++;
    }
    const total = W * H;
    // ⚠️ 用 0.1% / 99.9% 而不是 2% / 98%：黑底白字的页面里白字像素常不到 2%，
    //    用 2% 会把 hi 压到背景亮度上，整张图会被拉成一片死白（第一版就这么翻车的）。
    let lo = 0, hi = 255, acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > total * 0.001) { lo = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > total * 0.001) { hi = i; break; } }
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    const mean = total ? sum / total : 128;
    const invert = mean < 100;                       // 整页偏暗 = 黑底白字
    // 直方图太集中（几乎纯色页）就别硬拉，否则噪点会被放大成满屏黑斑
    if (hi - lo < 24) { lo = 0; hi = 255; }
    const span = Math.max(8, hi - lo);
    // 已经是「白底黑字 + 对比充分」的干净页就别碰（实测这类图处理完反而会差一两个字），
    // 只去救真正需要的：偏暗（黑底白字）、发灰低对比、彩色干扰。
    // 判据：没反相（本来就是白底）+ 近处有纯白（hi>210）+ 近处有纯黑（lo<60）+ 跨度够大。
    // ⚠️ 不要卡 mean 上限：白底黑字的整页平均亮度本来就在 230 以上，卡上限等于永远不跳过。
    if (!invert && mean > 100 && span > 190 && hi > 210 && lo < 60) {
      return cv;
    }
    for (let i = 0; i < p.length; i += 4) {
      let v = (p[i] - lo) * 255 / span;
      v = v < 0 ? 0 : (v > 255 ? 255 : v);
      if (invert) v = 255 - v;
      v = v < 128 ? v * 0.92 : 255 - (255 - v) * 0.92;   // 轻微 S 曲线：笔画更实
      p[i] = p[i + 1] = p[i + 2] = v | 0;
    }
    g.putImageData(d, 0, 0);
  } catch (e) {
    console.warn('OCR 预处理跳过（读不到像素）', e);
  }
  return cv;
}

/** 这页是不是「认出来了但基本是乱码」（R122）。
 *  ⚠️ 不能只看平均置信度：实测一页 18px 小字糊图，识别结果成片「育岑岑育育岑岑 / 为为污江为为」，
 *  置信度却有 85% —— Tesseract 会「自信地认错」。所以要另看文本本身的形状：
 *    · 同一个字连着出现 ≥3 次（乱码最典型的特征）
 *    · 一大页里不同词少得可怜（多数词反复重复）
 *    · 符号 / 乱码字符占比过高
 *  命中只用来**提示用户**（这页可能不准，换个语言或放大再认），不拦着识别结果。 */
function ocrLooksGarbage(rec, text) {
  const words = ((rec && rec.words) || []).map(function (w) { return String(w.text || '').trim(); }).filter(Boolean);
  const t = String(text || '');
  if (!words.length) return true;
  if (/(.)\1{2,}/.test(t)) return true;                       // 3 个一样的字连着
  const uniq = new Set(words).size;
  if (words.length >= 12 && uniq / words.length < 0.34) return true;   // 词几乎都在重复
  const sym = (t.match(/[^\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7afA-Za-z0-9\s，。、；：？！「」『』（）《》“”‘’…—·,.;:?!"'()\-]/g) || []).length;
  if (t.length > 20 && sym / t.length > 0.18) return true;     // 一堆 》|EE 之类的杂符号
  return false;
}

/** 认一张 canvas。返回 { words（原图坐标、已按阅读顺序排好）、vert、conf }。
 *  dir: h = 只横排；v = 只竖排（转 90°）；auto = 先横排，结果太差再转一次挑好的。 */
async function ocrRecognizeCanvas(cv, opts) {
  const cfg = ocrCfg();
  // PSM：3 = 整页自动分栏（扫描书页）；11 = 稀疏文本（漫画 / 海报这种「字零散、周围全是画」）。
  // 实测漫画页 11 比 3 少错一两个字、置信度也高一点，所以图片书默认 11。
  // ⚠️ PSM 只有 Tesseract 认；本地视觉模型不看这个参数（它自己找字）。
  const psm = String((opts && opts.psm) || '3');
  // 先探一次后端（缓存 20 秒），决定这轮到底走本地还是浏览器内。
  if (cfg.engine !== 'tesseract' && cfg.engine !== 'paddle' && !_ocrStatus) { try { await ocrStatus(); } catch (e) { } }
  let useLocal = ocrUseLocal() && (Date.now() - _ocrRemoteBrokenAt > 60000);
  // 选「本机 PaddleOCR」时**不再问 /api/ocr 的后端状态**：那条线是电脑版视觉模型，
  // 跟这个完全是两回事，问了只会白等 20 秒一次的探测。
  /* R172：「自动」在手机上也得落到 PaddleOCR 上。
     以前只有显式选 paddle 才用它，而默认是 auto、手机上又没有本地视觉模型 →
     自动 = Tesseract，等于把随包带着的那个更准的引擎白放着（面板上还写着
     「手机上优先用前两个」）。现在：本地模型能用就用它，用不上再看 Paddle。
     Web 端 ocrPaddleAllowed() 恒 false（除非 ?ort=1），行为一点不变。 */
  let usePaddle = (cfg.engine === 'paddle'
    || (cfg.engine === 'auto' && !useLocal && ocrPaddleAllowed()))
    && typeof OcrPaddle !== 'undefined';

  const tessWords = async function (canvas) {
    // 复用常驻 worker（R122）：顶层 Tesseract.recognize() 每次都新建 worker + 重新读语言包，
    // 慢，而且语言包读到一半就开认 → 一片乱码
    const w = await ocrGetWorker();
    try { await w.setParameters({ tessedit_pageseg_mode: psm }); } catch (e) { }
    let res;
    try {
      res = await w.recognize(canvas);
    } catch (e) {
      console.warn('识别失败，重建识别引擎再试一次', e);
      await ocrDropWorker();
      const w2 = await ocrGetWorker();
      res = await w2.recognize(canvas);
    }
    return ((res.data && res.data.words) || []).map(function (w) {
      return { text: w.text, bbox: w.bbox, confidence: w.confidence };
    }).filter(function (w) { return w.bbox && String(w.text || '').trim(); });
  };

  const once = async function (canvas, vert) {
    let words;
    /* R171：本机 PaddleOCR。它是**并列的第三个引擎**，不是替换 Tesseract：
       onnx 运行时起不来（老安装包 / wasm 被删 / 系统 WebView 太旧）时自动退回浏览器内，
       并且只提示一次 —— 每页都弹一句会很吵。 */
    if (usePaddle) {
      try {
        const pr = await OcrPaddle.recognize(canvas, {});
        words = (pr.words || []).map(function (w) {
          return { text: w.text, bbox: w.bbox, confidence: w.confidence };
        });
      } catch (e) {
        if (R._ocrCancel) throw e;
        console.warn('本机 PaddleOCR 失败，退回浏览器内识别', e);
        usePaddle = false;
        if (!R._ocrPaddleTold) {
          R._ocrPaddleTold = true;
          try { toast('本机 PaddleOCR 没起来，已退回浏览器内识别（设置 → 识别引擎 里能看到原因）'); } catch (e2) { }
        }
        words = await tessWords(ocrPrepCanvas(canvas));
      }
    } else if (useLocal) {
      try {
        words = await ocrRemoteCanvas(canvas, vert);
      } catch (e) {
        // 用户点了「⏹ 停止」：直接抛上去，别再偷偷退回 Tesseract 把整页重认一遍
        // （那样「停止」在用户眼里就是「点了没反应，还在跑」）。
        if (R._ocrCancel) throw e;
        // 超时 ≠ 引擎坏了：一页 A4 在 CPU 上本来就 2–3 分钟，字多一点就顶到上限。
        // 这时候再拿 Tesseract 硬啃一张 A4（更慢、更认不出）只会让用户等更久、还看不到原因。
        if (/还没算完/.test(String((e && e.message) || ''))) throw e;
        // 本地服务挂了（没启动 / 模型被删 / 连接失败）不该让用户什么都认不出来：
        // 当场退回浏览器内，并且一分钟内不再重试，免得每页都卡一次超时。
        console.warn('本地模型识别失败，退回浏览器内识别', e);
        _ocrRemoteBrokenAt = Date.now();
        useLocal = false;
        if (!R._ocrFallbackTold) {
          R._ocrFallbackTold = true;
          try { toast('本地识别模型没响应，已退回浏览器内识别（设置 → 识别引擎 可看状态）'); } catch (e2) { }
        }
        words = await tessWords(ocrPrepCanvas(canvas));
      }
    } else {
      words = await tessWords(canvas);
    }
    if (vert) console.log('OCR [竖] 完成');
    // 异常词框在「文字是横的」这套坐标里修（竖排已经转过来了，正好也是横的）
    const fix = normalizeOcrBoxes(words);
    words.forEach(function (w, k) {
      const f = fix.get(k);
      if (f) { w.bbox.y0 = f.y0; w.bbox.y1 = f.y1; }
    });
    if (vert) {
      const w0 = cv.width || canvas.height;      // 逆时针转：原图宽 = 旋转图高
      words = words.map(function (w) {
        return { text: w.text, bbox: unrotateBox(w.bbox, w0), confidence: w.confidence };
      });
      words = orderVertical(words);
    }
    return { words: words, vert: !!vert, conf: ocrConfOf(words) };
  };

  // 预处理（灰度 / 拉对比度 / 暗底反相，尺寸不变）是**专门给 Tesseract 补的**：
  // 模型看彩色原图更准，硬转灰度反而丢信息，所以本地模型 / PaddleOCR 这条路直接送原图。
  const prep = (useLocal || usePaddle) ? cv : ocrPrepCanvas(cv);
  if (cfg.dir === 'v') return once(rotateCanvasV(prep), true);
  const flat = await once(prep, false);
  if (cfg.dir !== 'auto') return flat;
  // 自动：横排几乎没认出东西（竖排页面转 90° 才认得出）就再来一次。
  // 阈值别定太高：一张漫画页可能只有十几个字，认对 4 个字以上就别浪费一次识别。
  const chars = ocrCharsOf(flat.words);
  if (chars >= 4 && flat.conf >= 52) return flat;
  // 第二次识别失败（比如语言包只下了一半）不该把已经拿到的横排结果也丢掉
  let turned = null;
  try { turned = await once(rotateCanvasV(prep), true); } catch (e) { console.warn('竖排重试失败，先用横排结果', e); }
  if (!turned) return flat;
  return ocrScoreOf(turned) > ocrScoreOf(flat) ? turned : flat;
}

/** 竖排的一个词贴到 bbox 上：writing-mode:vertical-rl + 用字距把整列填满。
 *  文字层是透明的，量准的意义在于「选中/高光带正好压在原文上」。 */
function fitOcrSpanV(span, text, b, cw, ch) {
  const boxW = Math.max(1, b.x1 - b.x0);
  const boxH = Math.max(1, b.y1 - b.y0);
  const n = Math.max(1, Array.from(String(text)).length);
  const g = ocrMeasureCtx();
  g.font = '400 100px ' + OCR_FONT_FAMILY;
  const mw = g.measureText('国').width || 100;          // 一个全角字宽 ≈ 竖排时的竖直步进
  const fs = Math.max(4, boxW / (mw / 100));            // 列宽 = 字宽
  const adv = n * fs * (mw / 100);
  const gap = n > 1 ? (boxH - adv) / (n - 1) : 0;
  span.style.writingMode = 'vertical-rl';
  span.style.textOrientation = 'mixed';
  span.style.left = ((b.x0) / cw * 100).toFixed(4) + '%';
  span.style.top = ((b.y0) / ch * 100).toFixed(4) + '%';
  span.style.width = (boxW / cw * 100).toFixed(4) + '%';
  span.style.height = (boxH / ch * 100).toFixed(4) + '%';
  span.style.fontSize = fs.toFixed(2) + 'px';
  span.style.fontFamily = OCR_FONT_FAMILY;
  span.style.fontWeight = '400';
  span.style.lineHeight = '1';
  span.style.overflow = 'visible';
  span.style.letterSpacing = (isFinite(gap) ? gap : 0).toFixed(2) + 'px';
  // 内层 <i> 只放文字（横排那套的 scaleX 拉伸对竖排没意义，留着会歪）
  let inner = span.firstElementChild;
  if (!inner) {
    inner = document.createElement('i');
    span.textContent = '';
    span.appendChild(inner);
  }
  inner.textContent = String(text);
  inner.style.display = 'block';
  inner.style.fontStyle = 'normal';
  inner.style.whiteSpace = 'pre';
  inner.style.transform = '';
  inner.style.transformOrigin = '';
  span.dataset.vert = '1';
  span.dataset.fr = (fs / boxH).toFixed(6);
  span.dataset.nh = (boxH / ch).toFixed(6);
}

/** 用 OCR 的词框给某一页建文字层（识别完成后、以及缩放重建画布后恢复时都走这里）。
 *  返回这一页拼出来的纯文本。 */
function buildOcrLayer(i, cv, rec, viewport) {
  const stack = $('pdfStack');
  if (!stack) return '';
  const words = (rec && rec.words) || [];
  if (!words.length) return '';
  if (cv._textLayer && cv._textLayer.parentNode) cv._textLayer.parentNode.removeChild(cv._textLayer);
  const layer = document.createElement('div');
  // ocr-layer：标记出这是 OCR 出来的文字（总开关一起管，但样式略淡一点）
  // 显示与否由 R._showTextLayer 统一控制，见 applyTextLayerVisibility()
  layer.className = 'pdf-text-layer ocr-layer' + (R._showTextLayer ? ' show-text' : '');
  layer.style.left = '0px';
  layer.style.top = '0px';
  layer.style.width = (cv.offsetWidth || (viewport && viewport.width) || 0) + 'px';
  layer.style.height = (cv.offsetHeight || (viewport && viewport.height) || 0) + 'px';
  let cumOff = i * 1e7, text = '', prevCJK = false;
  // 竖排（R121）：列从右往左、字竖着写。识别时已经把图转过 90°，词框是**转回来**的，
  // 顺序也排好了，所以这里只负责摆 + 换书写方向。
  const vert = !!(rec && rec.vert);
  // rec.norm = 识别阶段已经做过词框归一，别再按「横排的行」归一一次（竖排会被归错）
  const boxFix = (rec && rec.norm) ? null : normalizeOcrBoxes(words);
  let wi = -1;
  for (const w of words) {
    wi++;
    const t = String(w.text || '').trim();
    const b = w.bbox;                       // 画布像素坐标（cv.width/height = viewport*dpr）
    if (!t || !b) continue;
    // 中文词之间不塞空格：OCR 的 words 是**词**级，直接拼 "第 一 章" 会让查词/搜索/翻译都断成单字。
    const cjk = ocrNoSpace(t);
    if (text && !(cjk && prevCJK)) text += ' ';
    text += t;
    prevCJK = cjk;
    const span = document.createElement('span');
    span.textContent = t;
    // ⚠️ 位置一律用**百分比**而不是 px：画布会随缩放/适应屏幕重渲染（像素尺寸变化），
    //    百分比跟着容器走，OCR 层永远不会因为「识别时的尺寸 ≠ 现在的尺寸」而整体错位。
    const cw = (rec && rec.cw) || cv.width || 1;
    const chh = (rec && rec.ch) || cv.height || 1;
    const fx = boxFix ? boxFix.get(wi) : null;
    const bb = fx ? { x0: b.x0, x1: b.x1, y0: fx.y0, y1: fx.y1 } : b;
    if (vert) fitOcrSpanV(span, t, bb, cw, chh); else fitOcrSpan(span, t, bb, cw, chh);
    span.dataset.off = cumOff;
    span.dataset.bbox = [b.x0, b.y0, b.x1, b.y1].join(',');
    cumOff += t.length + 1;                 // 伪偏移只用于标注锚定，与上面的 text 拼接口径无关
    layer.appendChild(span);
  }
  stack.appendChild(layer);
  placeLayerOverCanvas(layer, cv);
  cv._textLayer = layer;
  layer._cv = cv;                        // 同上：粗体叠层要读这张画布的像素
  cv._ocrText = text;
  cv._ocrDone = true;
  paintPdfHighlights(layer, i);          // 扫描页 OCR 出的文字层同样渲染高光（修 #12）
  if (!R._pdfText) R._pdfText = [];
  R._pdfText[i] = text;                     // 让书内搜索能命中扫描页
  if (cv._scanMark && cv._scanMark.parentNode) cv._scanMark.parentNode.removeChild(cv._scanMark);
  cv._scanMark = null;
  if (R._scanPages) R._scanPages.delete(i);
  return text;
}

/** 缩放 / 换排版会 renderPdfStack() 清空 #pdfStack（画布全重建）。
 *  有缓存的页直接用缓存的词框把文字层重建回来，不用再联网识别。 */
function restoreOcrLayers() {
  const words = R._ocrWords;
  if (!words) return;
  const stack = $('pdfStack');
  if (!stack) return;
  stack.querySelectorAll('.pdf-page[data-idx]').forEach(cv => {
    const i = parseInt(cv.dataset.idx, 10);
    const ws = words[i];
    if (!ws || cv._textLayer) return;
    buildOcrLayer(i, cv, ws, cv._viewport);
  });
}

/** 送进本地模型的「识别专用画布」：长边固定 OCR_PDF_TARGET_LONG，**
 *  与窗口宽度 / 阅读器缩放 / 屏幕 DPR 全部无关。
 *
 *  为什么不能直接喂屏幕上那张画布：它的分辨率 =
 *      (可视宽 / 页宽) × R.pdfZoom × devicePixelRatio
 *  窗口一窄、或者缩放调到 80%，A4 扫描页就只剩五六百像素 —— 小字在模型眼里糊成一团，
 *  而屏幕上是浏览器插值放大显示的，用户看着照样「很清楚」（R125 已经验证过这个错觉）。
 *  反过来，放大阅读器又能把「识别得好不好」变成随机数：同一页换个窗口大小重认一次，
 *  结果就不一样。所以识别走独立通道，只取决于 PDF 本身。
 *
 *  viewport 用同一个 page 算，旋转/裁切和屏幕上完全一致 → 百分比坐标仍能原样套回 cv。 */
const OCR_PDF_TARGET_LONG = 1600;
async function ocrPdfSourceCanvas(i, domCv) {
  if (!R.pdfDoc) return domCv;
  try {
    if (_ocrStatus === null) { try { await ocrStatus(); } catch (e) { } }
    const page = await R.pdfDoc.getPage(i + 1);
    const v0 = page.getViewport({ scale: 1 });
    const long = Math.max(v0.width, v0.height) || 1;
    // 上限 6 倍：小尺寸页面（漫画 PDF 常见）也要能补到 1600，别被一个死倍率卡在半路
    const scale = Math.min(6, Math.max(1, OCR_PDF_TARGET_LONG / long));
    const vp = page.getViewport({ scale: scale });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(vp.width));
    c.height = Math.max(1, Math.round(vp.height));
    const g = c.getContext('2d');
    if (!g) return domCv;
    // 透明底 PDF 先垫白：视觉模型对「白底黑字」最稳（和图片书那条路一个口径）
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    c._vp = vp;
    return c;
  } catch (e) {
    // 渲染专用画布失败不该让整页识别失败：退回屏幕那张，顶多是分辨率差一点
    console.warn('识别专用画布渲染失败，退回屏幕画布', e);
    return domCv;
  }
}

async function ocrPdfPage(i, cv, viewport) {
  // 语言/方向换过之后，旧结果不算数（要重认才生效）
  if (cv._ocrDone && cv._ocrSig === ocrSig()) return;
  // 重认之前先留一份旧文本：认完如果变了，按旧文翻出来的译文要作废（R148）
  const oldText = (R._pdfText && R._pdfText[i]) || '';
  cv._ocrDone = true;
  cv._ocrSig = ocrSig();
  R._ocrRunning = true;      // 见 ocrRequestStop：没有这一条，「停止」分不清「在认」和「没在认」
  try {
    // 别再说「首次需联网下载语言包」——装了本地模型的机器看到这句会以为在重下 1.3 GB。
    toast(ocrUseLocal()
      ? '正在识别这一页…（本地模型跑 CPU，一页约 2–3 分钟，可随时点「⏹ 停止」）'
      : '正在 OCR 识别扫描页…（浏览器内识别，首次需联网下载语言包）');
    // 本地模型走「固定分辨率的识别专用画布」；浏览器内 Tesseract 那条路本来就有
    // 自己的放大策略（ocrPrepCanvas / ocrShrinkCanvas），仍用屏幕上这张。
    // ⚠️ 必须先问回后端状态再决定：ocrUseLocal() 在没探测过时返回 false，
    //    那就永远走不到专用画布这条路上（装好模型也当没装）。
    if (ocrEngine() !== 'tesseract' && !_ocrStatus) { try { await ocrStatus(); } catch (e) { } }
    const srcCv = ocrUseLocal() ? await ocrPdfSourceCanvas(i, cv) : cv;
    const rec = await ocrRecognizeCanvas(srcCv);
    const words = (rec && rec.words) || [];
    if (!words.length) throw new Error('这一页没有识别出任何文字（可能是空白页或图片分辨率太低）');
    // 词框留一份缓存：缩放会重建画布（renderPdfStack 清空 #pdfStack），
    // 没有缓存就只能重新联网识别一遍 —— 用户看到的就是「文字层突然没了」。
    if (!R._ocrWords) R._ocrWords = {};
    // 连「识别时的画布像素尺寸」一起存：重建画布后它可能还没 raster（cv.width 只有 300），
    // 百分比必须按识别时的尺寸算，否则恢复出来的层会整体错位。
    // vert / norm：竖排（列从右往左）与「词框已归一、已排序」，建层时不用再处理一遍。
    // ⚠️ cw/ch 取**识别时那张画布**（srcCv）的尺寸，不是屏幕上这张：
    //    走了专用画布之后两者分辨率不同，用错就会整层错位。
    R._ocrWords[i] = { words: words, cw: srcCv.width || 1, ch: srcCv.height || 1, vert: !!rec.vert, norm: true };
    const text = buildOcrLayer(i, cv, R._ocrWords[i], viewport);
    appendOcrPreview(i, text, words.length);
    toast('OCR 完成：本页识别 ' + words.length + ' 词，可直接划词/搜索');
    // 第二次识别和第一次结果不一样 → 旧的「页下译文」和面板那一节都是按旧文翻的，
    // 标成要重译；结果一样就留着（别让用户白翻一遍）。
    if (oldText && oldText !== text) dropPageTrAfterOcrChange('p', i, cv, oldText);
  } catch (e) {
    // ⚠️ 失败必须允许重试：之前 _ocrDone 一旦置 true 就再也不跑，
    // 用户第一次遇到网络抖动后就「怎么点都没反应」，以为 OCR 没真正识别。
    cv._ocrDone = false;
    cv._ocrSig = '';
    console.warn('OCR 失败', e);
    const raw = String((e && e.message) || e);
    // 用户自己按的停止：状态行写「已停止」，不要报成「识别失败」
    if (R._ocrCancel) {
      const st = $('ocrStatus');
      if (st) st.textContent = '已停止（第 ' + (i + 1) + ' 页中断，未识别完）';
      return;
    }
    const msg = /fetch|network|Failed to load|traineddata|CORS|importScripts/i.test(raw)
      ? '语言包 / 识别引擎下载失败，请确认联网后重试'
      : raw;
    toast('OCR 失败：' + msg);
    const st = $('ocrStatus');
    if (st) st.textContent = '第 ' + (i + 1) + ' 页识别失败：' + msg;
  } finally {
    R._ocrRunning = false;      // 「⏹ 停止」靠它判断「现在到底有没有在认」
    ocrStopVisual(false);       // 这一页彻底结束了，按钮恢复成可点的「⏹ 停止」
  }
}

/** 某一页的识别结果被清除 / 重做之后，把「拿旧文本翻出来的东西」一起作废（R148）。
 *
 *  之前只清文字层：画布/图片下方那块「页下译文」还留着，面板里也照旧列着 ——
 *  用户看到的是「识别都清掉了，译文还在」，而且第二次识别成功后翻译还是按旧的来。
 *  markerEl：PDF 是 canvas、图片书是 <img>，页下译文块就贴在它后面。
 *  oldText ：被作废的那一版识别文本（用于删掉按这段文本存的译文缓存）。 */
function dropPageTrAfterOcrChange(kind, i, markerEl, oldText) {
  try {
    let n = markerEl ? markerEl.nextElementSibling : null;
    while (n && n.classList && n.classList.contains('pdf-tr-block')) {
      const nx = n.nextElementSibling;
      n.remove();
      n = nx;
    }
    if (markerEl && markerEl.dataset) { delete markerEl.dataset.trDone; delete markerEl.dataset.trDoing; }
  } catch (e) { }
  try {
    if (oldText && typeof window.__inkDropTextTr === 'function') window.__inkDropTextTr(oldText);
  } catch (e) { }
  try {
    if (typeof window.__inkMarkPageStale === 'function') {
      window.__inkMarkPageStale(kind + i, oldText ? '识别已更新，需重译' : '识别已清除');
    }
  } catch (e) { }
}

/** 清掉某一页的 OCR 结果：移除文字层、恢复「🔍 扫描页」角标、把它记回扫描页集合。
 *  用户诉求（2026-10-21）：识别文字默认就显示出来了、而且没有清除入口。
 *  清除后该页回到「扫描图」状态：可以重新识别，也可以不识别当图片看。 */
function clearOcrPage(i) {
  const cv = document.querySelector('#pdfStack .pdf-page[data-idx="' + i + '"]');
  if (!cv || !cv._ocrText) return false;
  const oldText = (R._pdfText && R._pdfText[i]) || '';
  if (cv._textLayer && cv._textLayer.parentNode) cv._textLayer.parentNode.removeChild(cv._textLayer);
  cv._textLayer = null;
  delete cv._ocrText;
  cv._ocrDone = false;                       // 允许重新识别
  if (R._pdfText) delete R._pdfText[i];
  if (R._ocrWords) delete R._ocrWords[i];    // 清掉缓存，缩放时不会又冒出来
  if (cv._scanMark && cv._scanMark.parentNode) cv._scanMark.parentNode.removeChild(cv._scanMark);
  cv._scanMark = null;
  if (R._scanPages) R._scanPages.add(i);
  markPdfPageScanned(cv, i);                 // 角标回来（可再次点开 OCR）
  // 识别没了，按它翻出来的译文也就不成立了（页下块 + 面板那一节）
  dropPageTrAfterOcrChange('p', i, cv, oldText);
  return true;
}

/** OCR 文字层的字体：量字体度量和真正渲染必须用**同一串**，否则算出来的字号/基线还会偏。
 *  ⚠️ 不能用 system-ui —— canvas 里它和 DOM 里解析到的实际字体不一定相同
 *  （实测 canvas=Segoe UI、DOM=Segoe UI Variable，墨迹高度差 ~9%，字会整体偏大偏上）。
 *  用具体的 Arial + 中文回退，两端都能落到可预期的字形上。 */
const OCR_FONT_FAMILY = 'Arial, "Microsoft YaHei", "PingFang SC", sans-serif';
let _ocrMeasureCtx = null;
function ocrMeasureCtx() {
  if (!_ocrMeasureCtx) _ocrMeasureCtx = document.createElement('canvas').getContext('2d');
  return _ocrMeasureCtx;
}

/** Tesseract 偶尔给出**异常词框**：实测一页里单独一个「1」的框是 266,83,302,162（高 79），
 *  同一行 "PAGE" 只有 55 高 —— 按词框算字号，这个「1」会被放到 109px，看着就像
 *  「字比原图大、还上下串行」。这里按行做一次归一：
 *  行高/行底取该行词框高度、底边的**中位数**，明显离群的词框拉回行框。 */
function normalizeOcrBoxes(words) {
  const lines = [];
  words.forEach((w, k) => {
    const b = w.bbox;
    if (!b || b.y1 <= b.y0) return;
    let hit = null;
    for (const L of lines) {
      const ov = Math.min(b.y1, L.y1) - Math.max(b.y0, L.y0);
      const mh = Math.min(b.y1 - b.y0, L.y1 - L.y0);
      if (ov > mh * 0.5) { hit = L; break; }
    }
    if (!hit) { hit = { y0: b.y0, y1: b.y1, ws: [] }; lines.push(hit); }
    hit.ws.push({ k, b });
  });
  // 取**下中位**：一行只有 2 个词时（如「PAGE 1」），上中位会被异常框带偏
  const med = a => { const s = a.slice().sort((x, y) => x - y); return s[(s.length - 1) >> 1] || 0; };
  const fix = new Map();
  for (const L of lines) {
    if (!L.ws.length) continue;
    const lh = med(L.ws.map(x => x.b.y1 - x.b.y0));
    const lb = med(L.ws.map(x => x.b.y1));
    if (!lh || !lb) continue;
    for (const { k, b } of L.ws) {
      let y0 = b.y0, y1 = b.y1;
      if (y1 - y0 > lh * 1.2 || y1 > lb + lh * 0.25) { y0 = lb - lh; y1 = lb; }
      fix.set(k, { y0, y1 });
    }
  }
  return fix;
}

/** OCR 拼文本时「这两个词之间要不要留空格」的判定（R121）。
 *  汉字 + 假名（平假名/片假名/半角片假名）都不留 —— 否则日文会变成「むかしむかし あるところに」，
 *  查词、划词、翻译全被拆碎。**韩文不算**：韩语本来就用空格分词，硬拼会粘成一坨。 */
function ocrNoSpace(t) {
  return /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/.test(String(t || ''));
}

/** 把 OCR 出的一个词**精确**贴到 Tesseract 给的 bbox 上。
 *
 *  坑：Tesseract 的 `words[].bbox` 是**墨迹包围盒**（去掉行距、去掉字体上下留白），
 *  以前直接拿它的高度当 font-size —— 字形墨迹只占 font-size 的 ~72%（拉丁大写），
 *  于是「字看着比原图小、但整体又偏下偏右」，用户看到的就是「对不上」。
 *  这里用 measureText 拿到字体度量，反算字号 / 基线，并横向缩放到正好填满 bbox。 */
function fitOcrSpan(span, text, b, cw, ch) {
  const boxH = Math.max(1, b.y1 - b.y0);
  const boxW = Math.max(1, b.x1 - b.x0);
  const g = ocrMeasureCtx();
  const M = 100;                                  // 参考字号
  g.font = '400 ' + M + 'px ' + OCR_FONT_FAMILY;
  const m = g.measureText(text);
  const inkAsc = m.actualBoundingBoxAscent || M * 0.72;    // 这个词的墨迹高（相对基线）
  const fAsc = m.fontBoundingBoxAscent || M * 0.8;        // 字体盒 ascent
  const fDsc = m.fontBoundingBoxDescent || M * 0.2;
  const fs = Math.max(4, M * boxH / inkAsc);             // 让墨迹高正好 == bbox 高
  const k = fs / M;
  // 水平：墨迹左边缘（相对文字原点）也要对齐 bbox 左边缘
  const inkLeft = -(m.actualBoundingBoxLeft || 0) * k;
  // 垂直：line-height:1 时基线在盒内 (fs + fAsc*k - fDsc*k)/2 处，往上退让墨迹高 → 墨迹顶 == bbox 顶
  const baseline = (fs + (fAsc - fDsc) * k) / 2;
  // 记下「基线距盒顶 / 字号」的比例：高光带 / 下划线按它算基线（见 pdfAnnotRects）
  span._baseRatio = baseline / fs;
  span.style.left = ((b.x0 - inkLeft) / cw * 100).toFixed(4) + '%';
  span.style.top = ((b.y0 + inkAsc * k - baseline) / ch * 100).toFixed(4) + '%';
  span.style.width = (boxW / cw * 100).toFixed(4) + '%';
  span.style.height = (boxH / ch * 100).toFixed(4) + '%';
  span.style.fontSize = fs.toFixed(2) + 'px';
  span.style.fontFamily = OCR_FONT_FAMILY;
  span.style.fontWeight = '400';
  span.style.lineHeight = '1';
  span.style.overflow = 'visible';
  // 横向缩放放在内层 <i> 上：外层的背景/边框还得**正好等于 bbox**（缩放会把背景一起拉宽）
  let inner = span.firstElementChild;
  if (!inner) {
    inner = document.createElement('i');
    span.textContent = '';
    span.appendChild(inner);
  }
  inner.textContent = text;
  inner.style.display = 'block';
  inner.style.fontStyle = 'normal';
  inner.style.whiteSpace = 'pre';
  inner.style.transformOrigin = 'left top';
  // 不同字体的字宽和原扫描件总会差几个百分点，横向拉/压到「墨迹宽 == bbox 宽」
  const inkW = (m.actualBoundingBoxRight + m.actualBoundingBoxLeft) || m.width;
  const sxk = boxW / Math.max(1, inkW * k);
  inner.style.transform = 'scaleX(' + (isFinite(sxk) && sxk > 0 ? sxk.toFixed(3) : '1') + ')';
  span.dataset.fr = (fs / boxH).toFixed(6);      // 字号 / 墨迹高（缩放后按新高度重算字号用）
  span.dataset.nh = (boxH / ch).toFixed(6);      // 墨迹高 / 画布高
}

/** 重建抽屉里的「识别结果」预览（清空后按当前页面重新收集，避免重复追加） */
function showOcrPreview() {
  const box = $('ocrPreview');
  if (!box) return;
  box.innerHTML = '';
  box.hidden = true;
  Array.from(document.querySelectorAll('.pdf-page[data-idx]')).forEach(cv => {
    const i = parseInt(cv.dataset.idx, 10);
    if (!isFinite(i) || !cv._ocrText) return;
    appendOcrPreview(i, cv._ocrText, (cv._ocrText.match(/\S+/g) || []).length);
  });
}

/** 把单页 OCR 结果追加到抽屉的「识别结果」区（让用户能确认真的识别出了什么）。
 *
 *  ⚠️ R55 语义澄清（用户原话：「显示识别出的文字（核对是否真的认对了）这个指的是啥？
 *  不应该是下方的『第 3 页 · 237 词：xxx』这种展示的开关吗？否则和 A 就重复功能了」）：
 *    · 抽屉上方的勾选框 = **下方每页识别出的文字**要不要展开显示（核对用）；
 *    · 缩放条上的「A」= PDF 页面上的透明文字层要不要显示（能划词/搜索，看不见字形）；
 *    两者是**两件事**，不再合并。
 *  行首 👁 = 跳到这一页 + 显示/隐藏这一页的文字层（等价于点 A，但只针对这一页）。 */
function appendOcrPreview(i, text, words, conf, looksBad) {
  const box = $('ocrPreview');
  if (!box) return;
  const shown = !!R._ocrShowList;
  let row = box.querySelector('.ocr-preview-row[data-page="' + i + '"]');
  if (!row) {
    row = document.createElement('div');
    row.className = 'ocr-preview-row';
    row.dataset.page = String(i);
    box.appendChild(row);
  }
  const cQ = (conf === 0 || conf) ? Math.round(conf) : null;
  const bad = (cQ !== null && cQ < 62) || !!looksBad;
  const qTag = cQ === null ? ''
    : ('<span class="opr-q' + (bad ? ' bad' : '') + '" title="识别置信度 / 质量。标红=多半是乱码：换对语言、把图放大再试">'
       + (bad ? '⚠️ ' : '') + cQ + '%</span>');
  row.innerHTML = '<div class="opr-head">' +
      '<span class="opr-eye" title="跳到第 ' + (i + 1) + ' 页并显示/隐藏这一页的文字层（和缩放条的 A 是同一个开关）">👁</span>' +
      '<b>第 ' + (i + 1) + ' 页</b> · ' + (words || 0) + ' 词 ' + qTag +
      '<span class="opr-caret">' + (shown ? '▾' : '▸') + '</span>' +
    '</div>' +
    '<div class="opr-text"' + (shown ? '' : ' hidden') + '>' + esc(String(text || '')) + '</div>';
  const eye = row.querySelector('.opr-eye');
  if (eye) eye.onclick = (e) => { e.stopPropagation(); toggleOcrPreviewLayer(i); };
  row.onclick = () => toggleOcrPreviewText(row);
  box.hidden = false;
  renderOcrEyeStates();
}

/** 展开 / 收起某一页的识别文字（只影响抽屉里的展示，不动页面上的文字层） */
function toggleOcrPreviewText(row) {
  if (!row) return;
  const t = row.querySelector('.opr-text');
  const c = row.querySelector('.opr-caret');
  if (!t) return;
  t.hidden = !t.hidden;
  if (c) c.textContent = t.hidden ? '▸' : '▾';
}

/** 「显示每页识别出的文字」总开关（抽屉里那个勾选框） */
function setOcrShowList(on) {
  R._ocrShowList = !!on;
  document.querySelectorAll('.ocr-preview-row').forEach(r => {
    const t = r.querySelector('.opr-text');
    const c = r.querySelector('.opr-caret');
    if (t) t.hidden = !on;
    if (c) c.textContent = on ? '▾' : '▸';
  });
  const cb = $('ocrShowText');
  if (cb && cb.checked !== !!on) cb.checked = !!on;
}

/** 行首 👁：跳到该页并切换这一页的文字层（和 A 同一个总开关，只是顺手跳页） */
function toggleOcrPreviewLayer(i) {
  const same = (R._showTextLayer && String(R._ocrPreviewPage) === String(i));
  if (!same && R.pageIndex !== i) {
    try { goToPage(i, true); } catch (e) { /* PDF 懒渲染时忽略 */ }
  }
  R._ocrPreviewPage = i;
  setTextLayer(!same);
}

/** PDF 扫描页是否自动 OCR：默认 false（让用户在扫描页上「点此识别」逐页决定，满足 #20）。 */
function pdfShouldAutoOcr() {
  return !!(Settings && Settings.pdfAutoOcr);
}

/**
 * 扫描页角标：自动 OCR 关闭时，在扫描页右上角放一个不挡正文的小角标（🔍 扫描页），
 * 点它打开「PDF OCR」抽屉针对该页识别（不再用覆盖整页的按钮，修 #5：按钮别盖在页面上影响看东西）。
 * 同时把该页记入 R._scanPages，供抽屉「一键识别全部扫描页」使用。
 */
function markPdfPageScanned(cv, i) {
  if (!cv || cv._scanMark) return;
  const stack = $('pdfStack');
  if (!stack) return;
  if (R._scanPages) R._scanPages.add(i);
  const m = document.createElement('div');
  m.className = 'pdf-scan-mark';
  m.innerHTML = '<button type="button" class="pdf-scan-badge" title="扫描页（无文本层）：点此打开 OCR 面板识别">🔍 扫描页</button>';
  m.style.left = '0px';
  m.style.top = '0px';
  const btn = m.querySelector('button');
  if (btn) btn.onclick = (e) => {
    e.stopPropagation();
    openOcrDrawer(i);
  };
  stack.appendChild(m);
  placeLayerOverCanvas(m, cv);
  cv._scanMark = m;
}

/**
 * PDF OCR 抽屉：把「一键识别全部 / 中途停止 / 选择页数」等控制从阅读页移到侧栏抽屉，
 * 不遮挡正文（修 #5：OCR 按钮别盖在页面上影响看东西）。可来自扫描页角标（pageIdx 指定单页）。
 */
/**
 * 「显示文字层」总开关（数字版文字层 + OCR 识别层一起管）——对应缩放条上的「A」。
 * R53：A 只管数字版层、扫描版整页是 OCR 层 → 勾了勾选框后 A「像没反应」；
 * 曾把抽屉勾选框也并到这个开关上。R55 用户澄清后**拆开**：
 *   · A / 本函数 = 页面上的透明文字层（能划词、能搜索）；
 *   · 抽屉勾选框 = 下方「第 N 页 · X 词：正文…」这些识别结果的展开显示（见 setOcrShowList）。
 */
function setTextLayer(on, opts) {
  R._showTextLayer = !!on;
  R._ocrShowText = R._showTextLayer;      // 兼容旧字段 / 旧测试
  R._pdfShowText = R._showTextLayer;
  applyTextLayerVisibility();
  // 图片书：可见范围内可能还有「识别过但没建层」的页（滚到哪建到哪），顺手补上
  if (R.format === 'comic') { try { scheduleImgLayerSync(); } catch (e) { } }
  const t = opts && opts.toast;
  if (t !== false) {
    const n = document.querySelectorAll('.pdf-text-layer.show-text span').length;
    const o = document.querySelectorAll('.pdf-text-layer.ocr-layer.show-text span').length;
    toast(R._showTextLayer
      ? ('文字层已显示（本页 ' + n + ' 个文字块' + (o ? '，其中识别层 ' + o + ' 个' : '')
        + '）' + (n ? '' : '，当前页还没有文字层' + (R.format === 'comic' ? '（图片要先识别）' : '')))
      : '文字层已隐藏');
  }
}

/** 兼容旧入口：外面先改 R._ocrShowText 再调它 */
function applyOcrTextVisibility() {
  setTextLayer(!!R._ocrShowText, { toast: false });
}

/** 把文字层开关状态刷到所有已有文字层 + A 按钮上（含之后新建的层，建层时也会读开关） */
function applyTextLayerVisibility() {
  const on = !!R._showTextLayer;
  document.body.classList.toggle('show-text', on);
  document.querySelectorAll('.pdf-text-layer').forEach(n => n.classList.toggle('show-text', on));
  const a = $('pdfTextToggle');
  if (a) a.classList.toggle('on', on);
  const ca = $('comicTextToggle');
  if (ca) ca.classList.toggle('on', on);
  renderOcrEyeStates();
}

/** 抽屉里每行的 👁 状态（= 该页文字层当前是否可见）——与「展开文字」是两件事 */
function renderOcrEyeStates() {
  const on = !!R._showTextLayer;
  document.querySelectorAll('.ocr-preview-row').forEach(r => {
    const onRow = on && String(r.dataset.page) === String(R._ocrPreviewPage);
    r.classList.toggle('on', onRow);
    const eye = r.querySelector('.opr-eye');
    if (eye) { eye.textContent = '👁'; eye.style.opacity = onRow ? '1' : '.45'; }
  });
}

function openOcrDrawer(pageIdx) {
  const body = $('ocrDrawerBody');
  if (!body) return;
  // 图片书：同一扇抽屉，但页 = 图片页（没有「扫描页」概念，见 openImgOcrDrawer）
  if (R.format === 'comic') { openImgOcrDrawer(pageIdx); return; }
  const scanCount = (R._scanPages && R._scanPages.size) || 0;
  body.innerHTML =
    '<div class="ocr-panel">' +
      '<div class="ocr-status" id="ocrStatus">共 ' + scanCount + ' 个扫描页待识别' + (scanCount ? '' : '（本书已全是数字版，无需 OCR）') + '</div>' +
      ocrCfgHtml() +
      '<div class="ocr-row">' +
        '<button class="btn-primary" id="ocrAllBtn">🔍 一键识别全部扫描页（' + scanCount + '）</button>' +
        '<button class="btn-plain" id="ocrStopBtn">⏹ 停止</button>' +
      '</div>' +
      '<div class="ocr-row">' +
        '<input id="ocrPagesInput" class="ocr-pages-input" placeholder="页数，如 1-5,8（空=全部扫描页）" title="填页码或范围，留空则识别全部扫描页">' +
        '<button class="btn-plain" id="ocrSelBtn">识别所选</button>' +
      '</div>' +
      '<div class="ocr-hint">留空 = 识别全部扫描页；也可填 1-5,8 这样的页码。</div>' +
      '<div class="ocr-progress"><div class="ocr-progress-bar" id="ocrBar"></div></div>' +
      '<div class="ocr-row">' +
        '<label class="ocr-keep"><input type="checkbox" id="ocrShowText"' + (R._ocrShowList ? ' checked' : '') + '> 显示下方每页识别出的文字（核对是否真的认对了）</label>' +
      '</div>' +
      '<div class="ocr-row">' +
        '<button class="btn-plain" id="ocrClearBtn" title="删掉本页（或所填页）的识别结果，恢复成扫描图">🧹 清除本页识别</button>' +
        '<button class="btn-plain" id="ocrClearAllBtn" title="删掉全部已识别页的文字层">清除全部</button>' +
      '</div>' +
      '<div class="ocr-hint">点行 = 展开 / 收起那页文字；点行首 👁 = 跳到那页并显示文字层（同缩放条 A）。</div>' +
      '<div class="ocr-preview" id="ocrPreview" hidden></div>' +
      '<div class="ocr-tip">浏览器内识别首次要联网下语言包（每种 10–20MB）；用本地模型不用。</div>' +
    '</div>';
  bindOcrCfgUi(body);
  // R70：一键识别会先整本检查（含没翻到过的页），给个「检查中」状态并防连点
  $('ocrAllBtn').onclick = async () => {
    const btn = $('ocrAllBtn');
    if (btn && btn.disabled) return;
    if (btn) { btn.disabled = true; btn.textContent = '🔍 正在检查整本…'; }
    try {
      await runBulkOcr(null);
    } finally {
      if (btn) btn.disabled = false;
      detectAllScanPages().then(list => {
        R._ocrAllPages = list;
        if (btn) btn.textContent = '🔍 一键识别全部扫描页（' + list.length + '）';
      }).catch(() => {
        if (btn) btn.textContent = '🔍 一键识别全部扫描页';
      });
    }
  };
  // 「显示下方每页识别出的文字」：只管抽屉里这段文字的展开/收起（R55 与 A 拆开，
  //  A 才是页面上的透明文字层）。行首 👁 才是「这一页的文字层开/关」。
  const showBox = $('ocrShowText');
  if (showBox) {
    showBox.checked = !!R._ocrShowList;
    showBox.onchange = () => setOcrShowList(!!showBox.checked);
  }
  // ⏹ 停止：除了置取消标记，还要把**正在飞的那个请求**掐断 ——
  // 一页 A4 在 CPU 上要 2–3 分钟，只置标记的话用户点完还要干等两三分钟，看起来就是「停不掉」。
  $('ocrStopBtn').onclick = () => { ocrRequestStop(); };
  $('ocrSelBtn').onclick = () => {
    const v = $('ocrPagesInput').value.trim();
    const max = (R.pageCount || (R.pdfDoc && R.pdfDoc.numPages) || 0);
    if (!v) { toast('先填页码，比如 1,5 或 1-3'); return; }
    // ⚠️ 明确填了页码就**严格按填的来**：不要再用「只保留扫描页」去过滤，
    //    否则用户填 1,5、第 5 页恰好有文字层，就变成只识别 1 —— 看着像「识别错了页」。
    //    （「只认扫描页」的过滤只在「识别全部扫描页」那条路径里用。）
    const raw = parsePageList(v, Math.max(max, 1e9));   // 先不过滤范围，才能报「第 X 页超出」
    const over = raw.filter(i => i >= max);
    const list = Array.from(new Set(raw.filter(i => i < max))).sort((a, b) => a - b);
    if (!list.length) {
      toast('页码超出范围：本书共 ' + max + ' 页');
      return;
    }
    if (over.length) toast('第 ' + over.map(i => i + 1).join('、') + ' 页超出范围（本书共 ' + max + ' 页），已跳过');
    // 回显「这次到底识别哪几页」，避免出现「我填 1,5 它却识别第 7 页」的困惑
    const label = list.map(i => i + 1).join('、');
    const st0 = $('ocrStatus'); if (st0) st0.textContent = '准备识别第 ' + label + ' 页（共 ' + list.length + ' 页）…';
    runBulkOcr(list);
  };
  // 页数输入**跨抽屉开关保留**（存在 R._ocrPages 上）：
  // 旧代码每次打开都把 value 覆盖成当前页，用户填的「1, 5」一关抽屉就没了
  // （用户实测「填 1,5 却识别第 7 页」就是当前页覆盖造成的）。
  const inp0 = $('ocrPagesInput');
  if (inp0) {
    inp0.value = R._ocrPages || (typeof pageIdx === 'number' ? String(pageIdx + 1) : '');
    inp0.oninput = () => { R._ocrPages = inp0.value; };
  }
  // 回填已有识别结果（本次会话识别过的页），一眼能看出「到底认出来没有」
  const pv = $('ocrPreview');
  if (pv) { pv.innerHTML = ''; pv.hidden = true; }
  const done = Array.from(document.querySelectorAll('.pdf-page[data-idx]')).filter(cv => cv._ocrText);
  if (done.length) {
    done.forEach(cv => appendOcrPreview(parseInt(cv.dataset.idx, 10) || 0, cv._ocrText, (cv._ocrText.match(/\S+/g) || []).length));
  }
  // 「清除本页识别」：按输入框的页码清；输入为空就清当前页
  const clearBtn = $('ocrClearBtn');
  if (clearBtn) clearBtn.onclick = () => {
    const v = $('ocrPagesInput').value.trim();
    const max = (R.pageCount || (R.pdfDoc && R.pdfDoc.numPages) || 0);
    let list = v ? parsePageList(v, max) : [];
    if (!list.length) list = [R.pageIndex || 0];
    let n = 0;
    list.forEach(i => { if (clearOcrPage(i)) n++; });
    showOcrPreview();
    updateOcrProgress(0, (R._scanPages && R._scanPages.size) || 0);
    const st0 = $('ocrStatus'); if (st0) st0.textContent = n ? ('已清除 ' + n + ' 页的识别结果') : '这些页本来就没有识别结果';
    toast(n ? ('已清除 ' + n + ' 页识别结果') : '没有可清除的识别结果');
  };
  const clearAllBtn = $('ocrClearAllBtn');
  if (clearAllBtn) clearAllBtn.onclick = () => {
    let n = 0;
    document.querySelectorAll('.pdf-page[data-idx]').forEach(cv => {
      if (cv._ocrText && clearOcrPage(parseInt(cv.dataset.idx, 10))) n++;
    });
    showOcrPreview();
    const st0 = $('ocrStatus'); if (st0) st0.textContent = n ? ('已清除全部 ' + n + ' 页识别结果') : '还没有识别过任何页';
    toast(n ? ('已清除 ' + n + ' 页识别结果') : '还没有识别结果');
  };
  updateOcrProgress(0, scanCount);
  const titleEl = $('ocrDrawerTitle');
  if (titleEl) titleEl.textContent = 'PDF OCR';
  // 打开抽屉时把「文字层显示」状态同步到勾选框 / 预览行（两边永远一致）
  applyTextLayerVisibility();
  openDrawer('ocrDrawer');
  // R70：把「整本到底有多少页需要识别」数出来（不能只算翻到过、登记过的那几页）。
  // 用户反馈「没划到过的那一页，一键识别就是识别不出来」—— 根因就是这个计数/列表。
  detectAllScanPages().then(list => {
    R._ocrAllPages = list;
    const btn = $('ocrAllBtn');
    if (btn) btn.textContent = '🔍 一键识别全部扫描页（' + list.length + '）';
    const st = $('ocrStatus');
    if (st) {
      st.textContent = list.length
        ? '整本有 ' + list.length + ' 页需要识别（含没翻到过的页）'
        : '整本都检查过了：没有需要识别的扫描页（都能选中文字，或已经识别过）';
    }
  }).catch(() => { });
}

/** 解析 "1-5,8,12" → 0 基页索引数组（越界/非法项忽略） */
function parsePageList(s, max) {
  const out = [];
  if (!s) return out;
  s.split(/[,，\s]+/).forEach(part => {
    part = part.trim();
    if (!part) return;
    const rng = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rng) {
      let a = parseInt(rng[1], 10) - 1, b = parseInt(rng[2], 10) - 1;
      if (a > b) { const t = a; a = b; b = t; }
      for (let k = a; k <= b && k < max; k++) if (k >= 0) out.push(k);
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10) - 1;
      if (n >= 0 && n < max) out.push(n);
    }
  });
  return out;
}

/** 批量 OCR：pageList 为空则对「整本所有扫描页」；R._ocrCancel 可中途停止 */
async function runBulkOcr(pageList) {
  const stack = $('pdfStack');
  // ⚠️ 取消标记必须**进函数就清**，不能等「整本检查」结束才清：
  //    一键识别会先 detectAllScanPages()（扫描页多时要好几秒），用户在这期间点「⏹ 停止」，
  //    标记会被后面那句 R._ocrCancel = false 抹掉 → 点了完全没用，看着就是「停不掉」。
  R._ocrCancel = false;
  R._ocrAbort = null;
  R._ocrJob = true;          // 「⏹ 停止」据此知道「有批量任务在跑」（页与页之间也算）
  if (!pageList || !pageList.length) {
    // R70：别再只认 R._scanPages —— 它只在「这一页被渲染过」时才登记，
    // 于是没翻到过的扫描页永远进不了识别队列，用户看到的就是「一键识别漏页」。
    // 现在先按整本文字层重新数一遍，再和已登记的合并。
    const st0 = $('ocrStatus');
    if (st0) st0.textContent = '正在检查整本哪些页需要识别…';
    let all = [];
    try { all = await detectAllScanPages(); } catch (e) { all = []; }
    pageList = Array.from(new Set([...(R._scanPages || []), ...all]));
  }
  // 已经识别过的页直接跳过（否则会把同一页重识别一遍，白等）
  pageList = pageList.filter(i => {
    const cv = stack && stack.querySelector('.pdf-page[data-idx="' + i + '"]');
    return !(cv && cv._ocrText);
  }).sort((a, b) => a - b);
  if (!pageList.length) {
    const n = (R.pdfDoc && R.pdfDoc.numPages) || 0;
    toast('整本检查完了：没有需要识别的页（都能选中文字，或已经识别过）');
    const st0 = $('ocrStatus');
    if (st0) st0.textContent = '没有需要识别的页。想强制重识别某几页，在下面填页码（如 1-' + Math.max(1, n) + '）再点「识别所选」。';
    ocrJobEnd();
    return;
  }
  const total = pageList.length;
  // 把「本次到底识别哪几页」一直挂在状态栏上（用户反馈：填了 1、5，却看不出到底识别了哪几页）
  const labelAll = pageList.slice(0, 20).map(i => i + 1).join('、') + (pageList.length > 20 ? '…' : '');
  let done = 0;
  const failed = [];          // [{page, msg}] —— 失败必须如实报出来
  // 已识别的页逐页登记（用户反馈：识别完看不出到底识别了哪几页，容易以为「识别错了页」）
  const okPages = [];
  updateOcrProgress(0, total);
  for (const i of pageList) {
    if (R._ocrCancel) { toast('已停止 OCR：完成 ' + done + '/' + total); break; }
    let cv = stack && stack.querySelector('.pdf-page[data-idx="' + i + '"]');
    const st = $('ocrStatus');
    /* ⚠️ 懒渲染：页面**节点**一直都在（renderPdfStack 给整本建了占位），
     *   但没进过视口的页**画布还是空白**。旧代码只「滚过去等 450ms」碰运气，
     *   没等着就喂给 Tesseract 一张空图 → 「这一页没有识别出任何文字（空白页）」。
     *   现在不依赖滚动，直接显式渲染这一页再识别（大页面也不用等，await 到渲染完成）。 */
    if (cv && (!R._pdfRendered || !R._pdfRendered.has(i))) {
      if (st) st.textContent = '正在加载第 ' + (i + 1) + ' 页画面…（本次：第 ' + labelAll + ' 页 · ' + (done + failed.length + 1) + '/' + total + '）';
      try { await renderPdfPage(i); } catch (e) { /* 渲染失败下面统一报 */ }
    }
    if (!cv) { failed.push({ page: i + 1, msg: '这一页还没渲染出来（请先翻到该页再识别）' }); done++; updateOcrProgress(done, total); continue; }
    if (!pdfCanvasHasInk(cv)) {
      failed.push({ page: i + 1, msg: '这一页画面是空白的（渲染完成也没有内容，可能是真的空白页）' });
      done++; updateOcrProgress(done, total);
      continue;
    }
    if (st) st.textContent = '正在识别第 ' + (i + 1) + ' 页…（本次：第 ' + labelAll + ' 页 · ' + (done + failed.length + 1) + '/' + total + '）';
    try {
      await ocrPdfPage(i, cv, cv._viewport);
      if (cv._ocrText) okPages.push(i + 1);
      else if (!R._ocrCancel) failed.push({ page: i + 1, msg: (st && st.textContent) || '没识别出文字' });
    } catch (e) {
      // 用户主动停的那一页不算「失败」——否则收尾会写成「失败 1 页」，看着像真的出错了
      if (!R._ocrCancel) failed.push({ page: i + 1, msg: (e && e.message) || String(e) });
    }
    done++;
    updateOcrProgress(done, total);
    if (R._ocrCancel) break;
  }
  const st = $('ocrStatus');
  const okTxt = okPages.length ? '识别成功：第 ' + okPages.join('、') + ' 页' : '没有成功识别任何页';
  const badTxt = failed.length
    ? '；失败 ' + failed.length + ' 页（' + failed.map(f => '第 ' + f.page + ' 页：' + String(f.msg).replace(/^OCR 失败：/, '').slice(0, 40)).join('；') + '）'
    : '';
  if (st) {
    // 停止后的文案要能一眼看出「确实停了、停在哪」：以前一律拼成「已停止 · 没有成功识别任何页」，
    // 看着像出错，也看不出到底停没停。
    st.textContent = R._ocrCancel
      ? ('已停止 · 本次完成 ' + okPages.length + '/' + total + ' 页'
        + (okPages.length ? '（已完成第 ' + okPages.join('、') + ' 页）' : '（一页都没认完）'))
      : ('完成 · ' + okTxt + badTxt);
  }
  toast((R._ocrCancel ? 'OCR 已停止 · ' : '') + okTxt + (failed.length ? '，' + failed.length + ' 页失败' : ''));
  if (failed.length) console.warn('OCR 失败明细', failed);
  ocrJobEnd();
}

function updateOcrProgress(done, total) {
  const bar = $('ocrBar');
  if (bar) bar.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
}

/** 「⏹ 停止」的点按反馈：按钮当场变灰 + 文案变「⏳ 正在停止…」。
 *
 *  用户原话：「停止可否有点击反馈，我也不知道 ocr 到底停了没停」——
 *  一页在 CPU 上要两三分钟，只把**状态行**的文字换掉（按钮本身一点反应都没有），
 *  用户会以为没点着，于是连点好几次。
 *  停止是异步的（要等 abort 冒到 fetch 那一层），所以按钮必须自己先表态。 */
function ocrStopVisual(on) {
  ['ocrStopBtn', 'imgOcrStopBtn'].forEach(function (id) {
    const b = $(id);
    if (!b) return;
    if (on) {
      if (b.dataset.stopOn === '1') return;      // 已经表态过，别把原文案覆盖掉
      b.dataset.stopOn = '1';
      b.dataset.stopOld = b.textContent;
      b.disabled = true;
      b.textContent = '⏳ 停止中…';
      b.classList.add('is-stopping');
    } else {
      if (b.dataset.stopOn !== '1') return;
      b.dataset.stopOn = '';
      b.disabled = false;
      b.textContent = b.dataset.stopOld || '⏹ 停止';
      b.classList.remove('is-stopping');
    }
  });
}

/** 两个「⏹ 停止」按钮共用：点了立刻有反馈，而且是真的掐断在途请求。 */
function ocrRequestStop() {
  // 既没有在算的请求、也没有正在跑的批量任务 → 别假装「正在停止…」
  // （_ocrRunning 只管「某个请求在飞」，批量在页与页之间会短暂为 false，所以还要看 _ocrJob）
  if (!R._ocrRunning && !R._ocrJob) {
    toast('现在没有在识别，不用停');
    return;
  }
  R._ocrCancel = true;
  if (R._ocrAbort) { try { R._ocrAbort.abort(); } catch (e) { } }
  ocrStopVisual(true);
  const s = $('ocrStatus');
  if (s) s.textContent = '已请求停止…（当前这页的识别请求已经中断）';
}

/** 批量任务（整本 / 所选 / 本页）收尾：把「正在跑」和按钮态一起复位。 */
function ocrJobEnd() {
  R._ocrJob = false;
  R._ocrRunning = false;
  ocrStopVisual(false);
}

/* ============================================================
   图片书（comic）OCR —— 识别文字 → 透明文字层 → 划词 / 查词 / 翻译 / 高亮
   ------------------------------------------------------------
   和 PDF 扫描页共用同一套底层（Tesseract 出词框 → 百分比 span →
   .pdf-text-layer 上划词、paintPdfHighlights 画标记带、data-off 做锚点），
   差别只有两处：
     ① 底图是 <img> 不是 canvas：object-fit 会留白，文字层必须贴「图片内容盒」，
        不能直接铺满 <img> 元素（否则 contain 模式下整层上下错位）；
     ② 图片可以缩放（comicZoom）和切换 fit，所以层要能按新尺寸重建。
   识别结果按页存进 kv（ocr:<bookId>:<页>），另存一条索引 ocrIdx:<bookId>
   （页号 → 该页文字）—— 索引让「书内搜索 / 翻译本页」不必加载全部词框。
   ============================================================ */
let _imgOcrBound = false;
const IMG_OCR_MAX = 2800;        // 送进 Tesseract 的长边上限（2400 时漫画小字会糊成一团）
const IMG_OCR_MIN_LONG = 1600;   // 长边小于它就放大——Tesseract 对 72dpi 级的小图几乎认不出字
const IMG_OCR_PAGE = 1e7;       // 与 PDF 一致的「每页 1000 万字」偏移空间

function imgOcrState() {
  if (!R._imgOcrConf) R._imgOcrConf = {};
  if (!R._imgOcrBad) R._imgOcrBad = new Set();
  if (!R._imgOcr) R._imgOcr = {};                       // 页号 → { cw, ch, words:[{text,bbox}] }
  if (!R._imgOcrPages) R._imgOcrPages = new Set();      // 已识别过的页
  if (!R._imgOcrText) R._imgOcrText = {};               // 页号 → 识别出的纯文本
  if (!R._imgTextLayers) R._imgTextLayers = new Map();  // 页号 → 页面上的文字层元素
  if (!R._imgOcrBusy) R._imgOcrBusy = new Set();
  return R;
}
function imgOcrKey(i) { return 'ocr:' + (R.book && R.book.id) + ':' + i; }
function imgOcrIdxKey() { return 'ocrIdx:' + (R.book && R.book.id); }
function imgPageCount() { return (R.imgUrls && R.imgUrls.length) || 0; }
function imgEl(i) { return document.querySelector('#imgLayer .comic-img[data-idx="' + i + '"]'); }

/** 图片在 <img> 元素里的**实际显示盒**。
 *  contain / width / height 都可能留白（图片比例 ≠ 元素比例），文字层贴在留白上就会整体错位。
 *  cover 是「按 max(k) 放大后居中裁切」：内容盒比元素盒大、四周各溢出一块，
 *  这个映射其实是确定的（k = max），所以以前「cover 不画文字层」是偷懒 —— 用户设成
 *  「填满裁切」时识别成功了却永远看不见，看起来就像「识别了但没识别」。现在照算，
 *  由外层 .img-ocr-wrap（与 <img> 同大小 + overflow:hidden）把溢出部分裁掉。 */
function imgContentRect(img) {
  const ew = img.clientWidth || 0, eh = img.clientHeight || 0;
  const nw = img.naturalWidth || ew, nh = img.naturalHeight || eh;
  const layer = img.closest ? img.closest('#imgLayer') : null;
  const fit = (layer && layer.dataset.fit) || 'contain';
  if (!ew || !eh || !nw || !nh) return null;
  const cover = (fit === 'cover');
  const k = cover ? Math.max(ew / nw, eh / nh) : Math.min(ew / nw, eh / nh);
  const w = nw * k, h = nh * k;
  return {
    left: (ew - w) / 2, top: (eh - h) / 2, width: w, height: h,
    nw: nw, nh: nh, ew: ew, eh: eh, cover: cover
  };
}

/** 页内文字（优先内存文本，其次层里的文本，最后退回整本检索数组） */
function imgPageText(i) {
  imgOcrState();
  if (R._imgOcrText && R._imgOcrText[i]) return R._imgOcrText[i];
  const layer = R._imgTextLayers && R._imgTextLayers.get(i);
  if (layer && layer._text) return layer._text;
  if (R._pdfText && R._pdfText[i]) return R._pdfText[i];
  return '';
}

/** 当前屏幕上真正看到的页（R122）。
 *  ⚠️ 双页模式下 R.pageIndex 只表示**左边那页**（偶数），用户盯着右边那页点「识别本页」时
 *  旧代码只识别了左页 → 右页永远没有文字层，看起来就是「说识别好了但根本没识别」。
 *  所以这里返回**这一屏上的全部页**：单页 = 1 页，双页 = 2 页，卷轴 = 当前那张。 */
function comicNowPages() {
  const n = imgPageCount();
  if (!n) return [];
  const cur = comicVisibleIndex();
  if (!comicScrollOn() && comicStep() === 2) {
    const i = Math.max(0, Math.min(n - 1, cur - (cur % 2)));
    return [i, i + 1].filter(function (x) { return x < n; });
  }
  return [Math.max(0, Math.min(n - 1, cur))];
}

/** 当前眼前是第几页（卷轴模式按可视区反查；分页模式就是 R.pageIndex） */
function comicVisibleIndex() {
  const cont = $('imgLayer');
  const cur = (R.pageIndex || 0);
  if (!cont || !comicScrollOn()) return cur;
  const cr = cont.getBoundingClientRect();
  const imgs = Array.from(cont.querySelectorAll('.comic-img'));
  for (const img of imgs) {
    const r = img.getBoundingClientRect();
    if (r.bottom > cr.top + 4 && r.top < cr.bottom - 4) {
      const i = parseInt(img.dataset.idx, 10);
      return isFinite(i) ? i : cur;
    }
  }
  return cur;
}

/* ---------- 文字层的建 / 摆 / 收 ---------- */
function scheduleImgLayerSync() {
  if (window._imgLayerRaf) return;
  window._imgLayerRaf = requestAnimationFrame(function () {
    window._imgLayerRaf = 0;
    try { syncImgTextLayers(); } catch (e) { console.warn('图片文字层同步失败', e); }
  });
}

function positionImgTextLayers() {
  const cont = $('imgLayer');
  if (!cont || !R._imgTextLayers) return;
  const cr = cont.getBoundingClientRect();
  R._imgTextLayers.forEach(function (layer, i) {
    const img = imgEl(i);
    const wrap = layer._wrap;
    if (!img || !wrap || wrap.parentNode !== cont) return;
    const c = imgContentRect(img);
    if (!c) return;
    const ir = img.getBoundingClientRect();
    // #imgLayer 自己会滚（分页可以拖、卷轴整天在滚）：减掉容器原点再加上滚动量 = 内容坐标
    wrap.style.left = (ir.left - cr.left + cont.scrollLeft).toFixed(2) + 'px';
    wrap.style.top = (ir.top - cr.top + cont.scrollTop).toFixed(2) + 'px';
    wrap.style.width = c.ew.toFixed(2) + 'px';
    wrap.style.height = c.eh.toFixed(2) + 'px';
    // 层相对 wrap 的偏移 = 内容盒相对元素盒的偏移（contain 是居中留白、cover 是负值溢出一圈）
    layer.style.left = c.left.toFixed(2) + 'px';
    layer.style.top = c.top.toFixed(2) + 'px';
    layer.style.width = c.width.toFixed(2) + 'px';
    layer.style.height = c.height.toFixed(2) + 'px';
    layer._dispW = c.width;
    layer._dispH = c.height;
  });
}

/** 把一段词（同一行 / 同一列里的）拼成文字：中文词之间不塞空格，和 PDF 的 buildOcrLayer 一个口径。 */
function ocrJoinRun(list, getText) {
  let out = '', prevCJK = false;
  list.forEach(function (it) {
    const t = String(getText(it) || '').trim();
    if (!t) return;
    const cjk = ocrNoSpace(t);
    if (out && !(cjk && prevCJK)) out += ' ';
    out += t;
    prevCJK = cjk;
  });
  return out;
}

/** 把词框切成「自然段」（R126）：翻译是按段走的，整页拼成一坨送进去，出来就是一大段连读的文字。
 *  漫画应该「一个气泡一段」，正文应该「一个自然段一段」。
 *  做法纯几何（不依赖语言）：先把词框归成行（竖排归成列），再按行距 / 列距把相邻行并成段。
 *  只用于**文本**，不改文字层的 span/data-off（那是划词锚点，一动高亮就错位）。
 *  rec = { words:[{text,bbox}], vert, norm }；返回已按阅读顺序排好的字符串数组。 */
function ocrParasOf(rec) {
  const words = ((rec && rec.words) || []).filter(function (w) {
    return w && w.bbox && String(w.text || '').trim();
  });
  if (!words.length) return [];
  const vert = !!rec.vert;
  const fix = rec.norm ? null : normalizeOcrBoxes(words);   // 同一行的异常词框先拉回行框
  const items = words.map(function (w, i) {
    const b = w.bbox, fx = fix ? fix.get(i) : null;
    return {
      t: String(w.text).trim(),
      x0: b.x0, x1: b.x1,
      y0: fx ? fx.y0 : b.y0, y1: fx ? fx.y1 : b.y1
    };
  });
  // ---- ① 归行：横排看 y 重叠，竖排看 x 重叠（重叠过半就算同一行 / 同一列）----
  const lines = [];
  items.sort(function (a, b) { return vert ? (b.x1 - a.x1) : (a.y0 - b.y0); });
  items.forEach(function (it) {
    let hit = null;
    for (let k = 0; k < lines.length; k++) {
      const L = lines[k];
      const ov = vert ? Math.min(L.x1, it.x1) - Math.max(L.x0, it.x0)
                      : Math.min(L.y1, it.y1) - Math.max(L.y0, it.y0);
      const thin = Math.min(vert ? (L.x1 - L.x0) : (L.y1 - L.y0),
                            vert ? (it.x1 - it.x0) : (it.y1 - it.y0));
      if (ov > 0 && ov >= thin * 0.5) { hit = L; break; }
    }
    if (!hit) {
      lines.push({ w: [it], x0: it.x0, x1: it.x1, y0: it.y0, y1: it.y1 });
      return;
    }
    hit.w.push(it);
    hit.x0 = Math.min(hit.x0, it.x0); hit.x1 = Math.max(hit.x1, it.x1);
    hit.y0 = Math.min(hit.y0, it.y0); hit.y1 = Math.max(hit.y1, it.y1);
  });
  // 行内按阅读方向排序 → 拼字；行高 / 列宽留着算段间距
  lines.forEach(function (L) {
    L.w.sort(function (a, b) { return vert ? (a.y0 - b.y0) : (a.x0 - b.x0); });
    L.text = ocrJoinRun(L.w, function (x) { return x.t; });
    L.thick = Math.max(1, vert ? (L.x1 - L.x0) : (L.y1 - L.y0));
  });
  // 行间排序：横排从上到下，竖排从右到左（日漫的列序）
  lines.sort(function (a, b) {
    return vert ? ((b.x1 - a.x1) || (a.y0 - b.y0)) : ((a.y0 - b.y0) || (a.x0 - b.x0));
  });
  // ---- ② 并段 ----
  //  横排：行距 ≤ 0.95 个字高 → 同一段（正常行距约 0.4~0.6 个字高，空一行才会断）。
  //  竖排：左邻列与本段最右列高度重叠 ≥ 45% 且横向空隙 ≤ 0.9 个列宽 → 同一段（气泡里的几列）。
  const paras = [];
  let cur = null;
  lines.forEach(function (L) {
    if (!cur) { cur = [L]; return; }
    const P = cur[cur.length - 1];
    let same;
    if (vert) {
      const ov = Math.min(P.y1, L.y1) - Math.max(P.y0, L.y0);
      const gap = P.x0 - L.x1;
      same = ov >= Math.min(P.y1 - P.y0, L.y1 - L.y0) * 0.45 && gap <= L.thick * 0.9;
    } else {
      same = (L.y0 - P.y1) <= P.thick * 0.95;
    }
    if (same) cur.push(L);
    else { paras.push(cur); cur = [L]; }
  });
  if (cur) paras.push(cur);
  return paras
    .map(function (ps) {
      return ocrJoinRun(ps, function (L) { return L.text; }).replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean);
}

/** 把词框拼成整页纯文本（段与段之间用换行分隔）。
 *  ⚠️ 必须独立于「建层」：识别「识别全部」时，大部分页并不在 DOM 里（分页模式只渲染当前一页），
 *  层建不出来，但文本还是要存 —— 否则书内搜索 / 翻译本页对没翻到的页永远是空的。
 *  ⚠️ 换行是给翻译用的：splitForTranslation() 按换行切块，一段一个请求、一段一个 <p>。
 *     R126 之前这里拼成一整行，整页只能当一段翻 —— 漫画十个气泡翻出来是一大坨。 */
function imgTextFromRec(rec) {
  const paras = ocrParasOf(rec);
  if (paras.length) return paras.join('\n');
  return ocrJoinRun((rec.words || []), function (w) { return w.text; });   // 几何异常时兜底成一行
}

/** 用识别出的词框，给某一页图片建透明文字层。
 *  词框是「识别时的 canvas 像素」，这里换算到**当前显示尺寸**再交给 fitOcrSpan ——
 *  它的字号是 px（不是百分比），所以缩放后必须重建，不然字会比图大一圈。 */
function buildImgTextLayer(i, rec) {
  const cont = $('imgLayer');
  const img = imgEl(i);
  if (!cont || !img || !rec || !(rec.words || []).length) return null;
  const c = imgContentRect(img);
  if (!c) return null;
  const dw = Math.max(1, c.width), dh = Math.max(1, c.height);
  const kx = dw / (rec.cw || 1), ky = dh / (rec.ch || 1);
  const old = R._imgTextLayers.get(i);
  if (old && old._wrap && old._wrap.parentNode) old._wrap.parentNode.removeChild(old._wrap);
  else if (old && old.parentNode) old.parentNode.removeChild(old);
  // wrap = 与 <img> 元素盒一样大 + overflow:hidden：cover 模式下内容盒比元素盒大一圈，
  // 不裁掉的话文字层会溢出到图片外面（分页模式还会把容器撑出滚动条）。
  const wrap = document.createElement('div');
  wrap.className = 'img-ocr-wrap';
  wrap.dataset.idx = String(i);
  const layer = document.createElement('div');
  layer.className = 'pdf-text-layer ocr-layer img-ocr-layer' + (R._showTextLayer ? ' show-text' : '');
  layer.dataset.idx = String(i);
  layer._wrap = wrap;
  layer.style.left = '0px';
  layer.style.top = '0px';
  layer.style.width = dw + 'px';
  layer.style.height = dh + 'px';
  wrap.appendChild(layer);
  // 竖排（R121）：词框来自转 90° 识别再转回来的结果，顺序已是「列从右往左」。
  const vert = !!rec.vert;
  const boxFix = rec.norm ? null : normalizeOcrBoxes(rec.words);   // 同一行的异常词框先拉回行框
  let cumOff = i * IMG_OCR_PAGE, text = '', prevCJK = false;
  rec.words.forEach(function (w, wi) {
    const t = String(w.text || '').trim();
    const b = w.bbox;
    if (!t || !b) return;
    const cjk = ocrNoSpace(t);
    if (text && !(cjk && prevCJK)) text += ' ';      // 中文词之间不塞空格，免得查词被拆成单字
    text += t;
    prevCJK = cjk;
    const fx = boxFix ? boxFix.get(wi) : null;
    const bb = fx ? { x0: b.x0, x1: b.x1, y0: fx.y0, y1: fx.y1 } : b;
    const sb = { x0: bb.x0 * kx, y0: bb.y0 * ky, x1: bb.x1 * kx, y1: bb.y1 * ky };
    const span = document.createElement('span');
    span.textContent = t;
    if (vert) fitOcrSpanV(span, t, sb, dw, dh); else fitOcrSpan(span, t, sb, dw, dh);
    span.dataset.off = cumOff;
    cumOff += t.length + 1;                          // 伪偏移只用于锚定，与拼文本口径无关
    layer.appendChild(span);
  });
  layer._text = text;
  cont.appendChild(wrap);
  R._imgTextLayers.set(i, layer);
  if (!R._pdfText) R._pdfText = [];
  R._pdfText[i] = text;                              // 书内搜索 / 引用 / 翻译共用这一份
  paintPdfHighlights(layer, i);                      // 已有高亮 / 下划线立刻画回来
  positionImgTextLayers();
  return layer;
}

/** 收掉某一页的文字层（连 wrap 一起） */
function imgRemoveLayer(i) {
  const el = R._imgTextLayers && R._imgTextLayers.get(i);
  if (!el) return;
  const box = el._wrap || el;
  if (box && box.parentNode) box.parentNode.removeChild(box);
  R._imgTextLayers.delete(i);
}

/** 只给「看得见（+上下各一屏）」的页建层：卷轴模式下整本几百张，
 *  全建一遍既卡又没必要；滚到哪建到哪，离开就收掉（数据还在内存/库里）。 */
function syncImgTextLayers() {
  imgOcrState();
  const cont = $('imgLayer');
  if (R.format !== 'comic' || !cont) return;
  const cr = cont.getBoundingClientRect();
  const buf = Math.max(200, cr.height);
  const keep = new Set();
  const imgs = Array.from(cont.querySelectorAll('.comic-img'));
  imgs.forEach(function (img) {
    const i = parseInt(img.dataset.idx, 10);
    if (!isFinite(i) || !R._imgOcrPages.has(i)) return;
    const r = img.getBoundingClientRect();
    if (r.bottom < cr.top - buf || r.top > cr.bottom + buf) return;
    keep.add(i);
    const rec = R._imgOcr[i];
    if (!rec) {                                       // 库里存过、本次还没读进内存
      const tag = 'load:' + i;
      if (!R._imgOcrBusy.has(tag)) {
        R._imgOcrBusy.add(tag);
        loadImgOcrPage(i).then(function () {
          R._imgOcrBusy.delete(tag);
          scheduleImgLayerSync();
        }, function () { R._imgOcrBusy.delete(tag); });
      }
      return;
    }
    const c = imgContentRect(img);
    const cur = R._imgTextLayers.get(i);
    if (!c) {                                         // 图片还没解码出来（naturalWidth=0）：下一帧再说
      if (cur) { imgRemoveLayer(i); }
      return;
    }
    // ⚠️ `!cur.isConnected` 不能省：renderComicPage() 是整层 innerHTML 重建，旧层节点还挂在
    //    R._imgTextLayers 里但已经从 DOM 上脱落；尺寸又没变 → 只比尺寸就会「以为已建好」而不重建，
    //    表现是「翻一页再翻回来高亮还在，原地 renderPage() 后文字层和高亮全没了」。
    if (!cur || !cur.isConnected || Math.abs((cur._dispW || 0) - c.width) > 0.5 || Math.abs((cur._dispH || 0) - c.height) > 0.5) {
      buildImgTextLayer(i, rec);                      // 缩放 / 换 fit / 旋转 / 重建 DOM 后重来，字号才跟得上
    }
  });
  Array.from(R._imgTextLayers.keys()).forEach(function (i) {
    if (keep.has(i)) return;
    imgRemoveLayer(i);
  });
  cont.classList.toggle('has-ocr', R._imgTextLayers.size > 0);
  applyTextLayerVisibility();
  positionImgTextLayers();
}

/** 点图片上的标记（高光带 / 下划线 / 笔记点）→ 打开同一套区域标记浮层。
 *  图片书的标记带和 PDF 一样是 pointer-events:none（不挡划词），所以按坐标反查。 */
function imgAnnotClick(e) {
  if (R.format !== 'comic' || R.penMode) return;
  const sel = window.getSelection && window.getSelection();
  if (sel && !sel.isCollapsed) return;
  const id = pdfHlHitTest(e.clientX, e.clientY);
  if (!id) return;
  const ann = (R.annots || []).find(function (x) { return x.id === id; });
  if (!ann) return;
  e.stopPropagation();          // 别顺带触发「点区域翻页」
  if (!openMarkEditor(ann.start, ann.end, e.clientX, e.clientY)) openNoteComposer(ann);
}

/** 阅读区滚动 / 图片解码完 / 缩放后都只需要重新摆一下位置（层按内容坐标存，不重建） */
function bindImgOcrEvents() {
  if (_imgOcrBound) return;
  _imgOcrBound = true;
  const layer = $('imgLayer');
  if (layer) {
    layer.addEventListener('click', imgAnnotClick);
    layer.addEventListener('scroll', function () {
      if (R.format !== 'comic') return;
      scheduleImgLayerSync();
    }, { passive: true });
    // 图片是异步解码的：解码完尺寸才定，层得跟着重摆
    layer.addEventListener('load', function () {
      if (R.format === 'comic') scheduleImgLayerSync();
    }, true);
  }
  window.addEventListener('resize', function () {
    if (R.format === 'comic') scheduleImgLayerSync();
  });
  window.addEventListener('orientationchange', function () {
    setTimeout(function () { if (R.format === 'comic') scheduleImgLayerSync(); }, 320);
  });
}

/* ---------- 存储 ---------- */
async function loadImgOcrPage(i) {
  imgOcrState();
  if (R._imgOcr[i]) return R._imgOcr[i];
  if (!R.book || !R.book.id) return null;
  let packed = null;
  try { packed = await DB.kvGet(imgOcrKey(i), null); } catch (e) { packed = null; }
  if (!packed || !packed.w) return null;
  const rec = {
    cw: packed.cw,
    ch: packed.ch,
    vert: !!packed.vert,          // 竖排页：建层要竖着写、列从右往左
    norm: !!packed.norm,          // 词框已在识别阶段归一/排好序
    words: packed.w.map(function (a) {
      return { text: a[0], bbox: { x0: a[1], y0: a[2], x1: a[3], y1: a[4] } };
    })
  };
  R._imgOcr[i] = rec;
  // R126：老库里的整页文本是「一行到底」的（分段功能之前的版本存的）。词框还在，
  //  这里顺手补算一次分段 —— 老书不用重新识别，翻译照样能一段一段出来。
  //  只在「存着的那份一个字换行都没有」时才覆盖，避免把用户已有的分段冲掉。
  try {
    if (!R._imgOcrText || String(R._imgOcrText[i] || '').indexOf('\n') < 0) {
      const t = imgTextFromRec(rec);
      if (t) {
        if (!R._imgOcrText) R._imgOcrText = {};
        R._imgOcrText[i] = t;
        if (!R._pdfText) R._pdfText = [];
        R._pdfText[i] = t;
      }
    }
  } catch (e) { console.warn('补算分段失败', e); }
  return rec;
}

/** 打开图片书时读一次索引：哪些页识别过、每页文字是什么（搜索/翻译直接用，不必解词框） */
async function loadImgOcrIndex() {
  imgOcrState();
  if (!R.book || !R.book.id) return;
  let rec = null;
  try { rec = await DB.kvGet(imgOcrIdxKey(), null); } catch (e) { rec = null; }
  if (!rec || !rec.pages) return;
  Object.keys(rec.pages).forEach(function (k) {
    const i = parseInt(k, 10);
    if (!isFinite(i)) return;
    R._imgOcrPages.add(i);
    R._imgOcrText[i] = String(rec.pages[k] || '');
    if (rec.confs && rec.confs[k]) R._imgOcrConf[i] = rec.confs[k];
    if (rec.bads && rec.bads[k]) R._imgOcrBad.add(i);
    if (!R._pdfText) R._pdfText = [];
    if (!R._pdfText[i]) R._pdfText[i] = R._imgOcrText[i];
  });
  scheduleImgLayerSync();
}

async function saveImgOcrIndex() {
  if (!R.book || !R.book.id) return;
  const pages = {}, confs = {}, bads = {};
  Array.from(R._imgOcrPages).forEach(function (i) {
    pages[i] = R._imgOcrText[i] || '';
    const rec = R._imgOcr && R._imgOcr[i];
    if (rec && rec.conf) confs[i] = rec.conf;
    if (rec && rec.looksBad) bads[i] = 1;
  });
  try { await DB.kvSet(imgOcrIdxKey(), { v: 1, pages: pages, confs: confs, bads: bads }); }
  catch (e) { console.warn('保存 OCR 索引失败', e); }
}

/* ---------- 识别 ---------- */
/** 把某一页的图片画到 canvas 上。
 *  forLocal=true → 给本地视觉模型：大图缩到 OCR_REMOTE_MAX_SIDE（长了只是慢），
 *    但**小图要放大**到 LOCAL_MIN_LONG（R125 实测出来的）。
 *    实测（同一张竖排日文漫画页，22px 假名字）：
 *      287×402 → 「もかしもかし / あがみりもかし」全错
 *      放大 2 倍到 574 宽 → 三句全对，28 秒
 *      放大 3 倍到 861 宽 → 第一句又错，72 秒
 *    原因：视觉编码器按 patch 切图，图太小一个假名摊不到一个 patch，特征就糊成一团。
 *    所以「小图放大 ≤2.5 倍、长边拉到 800」既救回小图又不至于把耗时翻好几倍。
 *    坐标不用管：rec.cw/ch 记的就是这张 canvas 的尺寸，建层按百分比还原。
 *  forLocal=false → 给 Tesseract：大图压到 IMG_OCR_MAX，小图放大到 IMG_OCR_MIN_LONG。
 *  不直接用页面上的 <img>：那一张可能还没渲染（分页模式别的页不在 DOM）、
 *  也可能被 comicZoom 缩过，识别尺寸不可控。 */
const LOCAL_MIN_LONG = 800;      // 本地模型：长边小于它先放大（一个假名至少要摊到一个 patch）
const LOCAL_MAX_LONG = 1600;     // 本地模型：长边上限（再大只是更慢，精度不再涨）
const LOCAL_MAX_UP = 2.5;        // 放大倍数上限（3 倍反而更糊更慢，实测）
async function imgPageCanvas(i, forLocal) {
  const items = (R.book && R.book.content && R.book.content.items) || [];
  const it = items[i];
  if (!it || !it.blob) throw new Error('这一页的图片不在了');
  const url = URL.createObjectURL(it.blob);
  try {
    const im = await new Promise(function (res, rej) {
      const m = new Image();
      m.onload = function () { res(m); };
      m.onerror = function () { rej(new Error('图片解码失败')); };
      m.src = url;
    });
    const nw = im.naturalWidth || im.width, nh = im.naturalHeight || im.height;
    const long = Math.max(nw, nh);
    let k;
    if (forLocal) {
      k = long < LOCAL_MIN_LONG ? Math.min(LOCAL_MAX_UP, LOCAL_MIN_LONG / Math.max(1, long))
        : Math.min(1, LOCAL_MAX_LONG / Math.max(1, long));
    } else {
      k = (long > IMG_OCR_MAX ? (IMG_OCR_MAX / long)
        : Math.min(3, Math.max(1, IMG_OCR_MIN_LONG / long)));
    }
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(nw * k));
    cv.height = Math.max(1, Math.round(nh * k));
    cv._natW = nw; cv._natH = nh;          // 原图尺寸：判断「图本身太小」要用
    const g = cv.getContext('2d');
    g.fillStyle = '#fff';                 // 透明 PNG 先垫白底：Tesseract 对透明背景的字识别率明显更差
    g.fillRect(0, 0, cv.width, cv.height);
    if (k > 1) { g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; }
    g.drawImage(im, 0, 0, cv.width, cv.height);
    return cv;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 识别一页图片：存库 + 建文字层，返回识别出的纯文本 */
async function ocrImgPage(i) {
  imgOcrState();
  const tag = 'ocr:' + i;
  if (R._imgOcrBusy.has(tag)) return null;
  // 重认前留一份旧文本：认完变了就作废按旧文翻的译文（R148）
  const oldText = (R._imgOcrText && R._imgOcrText[i]) || '';
  R._imgOcrBusy.add(tag);
  R._ocrRunning = true;       // 「⏹ 停止」要据此判断「现在有没有在认」
  try {
    // ⚠️ 必须先把后端状态问回来再决定要不要放大：ocrUseLocal() 在没有探测结果时返回 false，
    //    直接拿它去建 canvas 就会「按 Tesseract 的方式放大」，然后交给本地模型 →
    //    900×1200 被撑到 1600 长边，token 翻倍、时间从 95 秒变 200 秒（R123 实测）。
    if (ocrEngine() !== 'tesseract' && !_ocrStatus) { try { await ocrStatus(); } catch (e) { } }
    const cv = await imgPageCanvas(i, ocrUseLocal());
    // PSM 用默认的 3（整页自动）：实测 11（稀疏文本）在单气泡页偶尔更好、多气泡页会把顺序打乱，
    // 四次抽样各有胜负，收益在噪声级别，不拿它当默认。ocrRecognizeCanvas 仍留着 opts.psm。
    const got = await ocrRecognizeCanvas(cv);
    const words = (got && got.words) || [];
    if (!words.length) {
      // 把「送进去的尺寸 / 原图尺寸」一起报出来：用户才知道是「图本来就小」还是「这页没字」
      const nat = (cv._natW || 0) + '×' + (cv._natH || 0);
      const tiny = Math.max(cv._natW || 0, cv._natH || 0) < 700;
      throw new Error('没认出文字（原图 ' + nat + '，送进模型 ' + cv.width + '×' + cv.height + '）'
        + (tiny ? '：原图分辨率太低，放大也补不出细节' : '：可能这页真没字，或文字太花/太小'));
    }
    const rec = {
      cw: cv.width, ch: cv.height,
      srcW: cv._natW || cv.width, srcH: cv._natH || cv.height,
      vert: !!got.vert,
      norm: true,
      conf: Math.round(got.conf || 0),
      words: words.map(function (w) { return { text: w.text, bbox: w.bbox }; })
    };
    R._imgOcr[i] = rec;
    try {
      await DB.kvSet(imgOcrKey(i), {
        v: 1, cw: rec.cw, ch: rec.ch, vert: rec.vert ? 1 : 0, norm: 1,
        w: rec.words.map(function (w) { return [w.text, w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1]; })
      });
    } catch (e) { console.warn('保存 OCR 结果失败', e); }
    const text = imgTextFromRec(rec);
    if (ocrLooksGarbage(rec, text)) rec.looksBad = true;   // 只作提示用，见 ocrLooksGarbage 注释
    buildImgTextLayer(i, rec);                        // 这一页在 DOM 里就顺手把层建出来
    R._imgOcrPages.add(i);
    R._imgOcrText[i] = text;
    // 置信度 / 乱码标记也进内存：抽屉重绘（showImgOcrPreview）时直接用，不会「识别完标签就没了」
    R._imgOcrConf[i] = rec.conf || 0;
    if (rec.looksBad) R._imgOcrBad.add(i); else R._imgOcrBad.delete(i);
    await saveImgOcrIndex();
    appendOcrPreview(i, text, rec.words.length, rec.conf, !!rec.looksBad);
    // 第二次识别结果变了 → 旧的页下译文 / 面板那一节都是按旧文翻的，标成要重译
    if (oldText && oldText !== text) dropPageTrAfterOcrChange('c', i, imgEl(i), oldText);
    return { text: text, conf: rec.conf, words: rec.words, looksBad: !!rec.looksBad,
      srcW: rec.srcW, srcH: rec.srcH };
  } finally {
    R._imgOcrBusy.delete(tag);
    R._ocrRunning = false;
    ocrStopVisual(false);       // 这一页结束了，「⏹ 停止」按钮恢复原样
  }
}

async function clearImgOcrPage(i) {
  imgOcrState();
  const had = R._imgOcrPages.has(i) || !!R._imgOcr[i];
  const oldText = (R._imgOcrText && R._imgOcrText[i]) || '';
  imgRemoveLayer(i);
  delete R._imgOcr[i];
  delete R._imgOcrText[i];
  if (R._pdfText) delete R._pdfText[i];
  R._imgOcrPages.delete(i);
  if (!had) return false;
  try { await DB.del('kv', imgOcrKey(i)); } catch (e) { }
  const row = document.querySelector('.ocr-preview-row[data-page="' + i + '"]');
  if (row) row.remove();
  // 识别清掉了，按它翻的译文也不能留着（页下图 + 面板那一节）
  dropPageTrAfterOcrChange('c', i, imgEl(i), oldText);
  return true;
}

async function clearAllImgOcr() {
  imgOcrState();
  const list = Array.from(R._imgOcrPages);
  let n = 0;
  for (const i of list) { if (await clearImgOcrPage(i)) n++; }
  await saveImgOcrIndex();
  return n;
}

function showImgOcrPreview() {
  const box = $('ocrPreview');
  if (!box || !R._imgOcrPages) return;
  box.innerHTML = '';
  box.hidden = true;
  Array.from(R._imgOcrPages).sort(function (a, b) { return a - b; }).forEach(function (i) {
    const t = R._imgOcrText[i] || '';
    appendOcrPreview(i, t, (t.match(/\S+/g) || []).length, R._imgOcrConf[i], R._imgOcrBad.has(i));
  });
}

/** 批量识别。list 为空 = 全书；force=false 时跳过已识别过的页 */
async function runImgBulkOcr(list, opts) {
  imgOcrState();
  R._ocrCancel = false;
  R._ocrAbort = null;
  R._ocrJob = true;
  const total = imgPageCount();
  let todo = (list && list.length ? list.slice() : Array.from({ length: total }, function (_, i) { return i; }))
    .filter(function (i) { return i >= 0 && i < total; });
  todo = Array.from(new Set(todo)).sort(function (a, b) { return a - b; });
  if (!(opts && opts.force)) todo = todo.filter(function (i) { return !R._imgOcrPages.has(i); });
  const st = $('ocrStatus');
  if (!todo.length) {
    const msg = total ? '这本书的图片都已经识别过了' : '这本书没有图片页';
    if (st) st.textContent = msg;
    toast(msg);
    ocrJobEnd();
    return;
  }
  updateOcrProgress(0, todo.length);
  let ok = 0, fail = 0, lowQ = [], bad = [], chars = 0;   // chars：认出多少字，用来说明「是成功还是空跑」
  for (let k = 0; k < todo.length; k++) {
    if (R._ocrCancel) break;
    const i = todo[k];
    if (st) st.textContent = '正在识别第 ' + (i + 1) + ' 页（' + (k + 1) + '/' + todo.length + '）…' +
      (ocrUseLocal() ? '本地模型，一页约 2–3 分钟，可点停止' : '首次要联网下载语言包');
    try {
      const r = await ocrImgPage(i);
      ok++;
      // R169：顺便数一下认出了多少字。用户「点了识别，到底成了没有」看不出来，
      // 字数是最直观的证据：0 字 = 等于没认出来，得说清楚而不是报「识别完成」。
      if (r && r.words && r.words.length) {
        for (let wi = 0; wi < r.words.length; wi++) {
          chars += String((r.words[wi] && r.words[wi].text) || '').length;
        }
      }
      // 认出来了但置信度很低 / 文本形状像乱码 = 这页基本不能看。别只说「识别完成」，要指出是哪页
      if (r && r.words && r.words.length && ((r.conf || 0) < 62 || r.looksBad)) {
        lowQ.push({ p: i + 1, conf: r.conf || 0, w: r.srcW || 0, h: r.srcH || 0 });
      }
    } catch (e) {
      // 用户自己按的「⏹ 停止」：不算失败页，直接收尾
      if (R._ocrCancel) break;
      const msg = String((e && e.message) || e);
      console.warn('图片 OCR 失败', i, msg);
      if (/fetch|network|Failed to load|traineddata|importScripts/i.test(msg)) {
        if (st) st.textContent = '语言包 / 识别引擎下载失败，请确认联网后重试';
        break;
      }
      fail++;
      bad.push({ p: i + 1, msg: msg });
    }
    updateOcrProgress(k + 1, todo.length);
  }
  await saveImgOcrIndex();
  const head = R._ocrCancel ? '已停止 · 本次完成 ' : '识别完成 ';
  const extra = fail ? '，' + fail + ' 页没认出文字' : '';
  /* R169：以前只说「识别完成 N 页」，一页里一个字都没认出来也是这句话，
     用户完全分不清成功还是白跑。现在带上总字数，0 字直接点明原因。 */
  const empty = ok > 0 && chars === 0;
  const charBit = ok ? ('，共 ' + chars + ' 字') : '';
  const zeroHint = empty ? '；但一个字都没认出来 —— 检查识别语言对不对、图是不是太糊' : '';
  if (st) st.textContent = head + ok + ' 页' + charBit + extra
    + (lowQ.length ? '；第 ' + lowQ.map(function (x) { return x.p; }).join('、') + ' 页认得很差' : '')
    + zeroHint
    + (ok && !empty ? '（点缩放条 A 可以看见文字块）' : '');
  toast(head + ok + ' 页' + charBit + extra + zeroHint
    + (lowQ.length ? '，第 ' + lowQ.map(function (x) { return x.p; }).join('、') + ' 页质量差' : ''));
  // 失败要说清楚「为什么」：以前只有一句「X 页失败」，用户完全不知道该改什么
  if (bad.length) {
    toast(bad.slice(0, 2).map(function (x) { return '第 ' + x.p + ' 页：' + x.msg; }).join('；')
      + (bad.length > 2 ? '（还有 ' + (bad.length - 2) + ' 页同理）' : ''));
  }
  if (lowQ.length) {
    // 分开说：图本身小 vs 认出来的东西像乱码，这两种该做的事完全不同
    const tiny = lowQ.filter(function (x) { return Math.max(x.w, x.h) > 0 && Math.max(x.w, x.h) < 700; });
    const msgs = [];
    if (tiny.length) {
      msgs.push('第 ' + tiny.map(function (x) { return x.p; }).join('、') + ' 页的原图只有 '
        + tiny[0].w + '×' + tiny[0].h + '，放大也补不出细节，最好换清晰的图');
    }
    const rest = lowQ.filter(function (x) { return tiny.indexOf(x) < 0; });
    if (rest.length) {
      msgs.push('第 ' + rest.map(function (x) { return x.p; }).join('、') + ' 页置信度低（'
        + rest.map(function (x) { return x.conf + '%'; }).join(' / ') + '），可换识别语言或排版方向再认一次');
    }
    toast(msgs.join('；'));
  }
  if (ok && R.format === 'comic' && !R._showTextLayer) {
    // 识别完文字层是透明的：不提醒一句，用户会以为「说识别完了却什么都没出来」
    setTimeout(function () { try { toast('文字层已识别好，点缩放条上的 A 能看见认出来的文字块'); } catch (e) { } }, 900);
  }
  syncImgTextLayers();          // 立刻贴回文字层，别等下一帧（用户想马上划词）
  ocrJobEnd();
}

/** 图片书的 OCR 抽屉（和 PDF 那个长得一样，但页 = 图片页，没有「扫描页」概念） */
function openImgOcrDrawer(pageIdx) {
  const body = $('ocrDrawerBody');
  if (!body) return;
  const titleEl = $('ocrDrawerTitle');
  if (titleEl) titleEl.textContent = '图片 OCR';
  imgOcrState();
  const total = imgPageCount();
  const doneN = R._imgOcrPages.size;
  const left = Math.max(0, total - doneN);
  // 页号取「打开抽屉那一刻看到的页」只为显示；**点击时一定重新算**（见下面 pageBtn），
  // 否则抽屉开着的时候翻页，点「识别本页」还在识别旧的页。
  const curList = (Number(pageIdx) >= 0 ? [Math.floor(Number(pageIdx))] : comicNowPages());
  const cur = curList.length ? curList[0] : 0;
  const curName = curList.map(function (i) { return i + 1; }).join('、');
  body.innerHTML =
    '<div class="ocr-panel">' +
      '<div class="ocr-status" id="ocrStatus">本书共 ' + total + ' 页图片，已识别 ' + doneN + ' 页' + (left ? '，还有 ' + left + ' 页没识别' : '') + '</div>' +
      ocrCfgHtml() +
      '<div class="ocr-row">' +
        '<button class="btn-primary" id="imgOcrPageBtn" title="识别屏幕上这一页（第 ' + curName + ' 页）">🔍 识别本页</button>' +
        '<button class="btn-plain" id="imgOcrAllBtn" title="把还没识别的 ' + left + ' 页全部识别">识别全部</button>' +
      '</div>' +
      '<div class="ocr-row">' +
        '<input id="imgOcrPages" class="ocr-pages-input" placeholder="页数，如 1-5,8（空=未识别的全部）" title="填页码或范围，留空则识别所有还没识别的页">' +
        '<button class="btn-plain" id="imgOcrSelBtn">识别所选</button>' +
        '<button class="btn-plain" id="imgOcrStopBtn">⏹ 停止</button>' +
      '</div>' +
      '<div class="ocr-progress"><div class="ocr-progress-bar" id="ocrBar"></div></div>' +
      '<div class="ocr-row">' +
        '<label class="ocr-keep"><input type="checkbox" id="ocrShowText"' + (R._ocrShowList ? ' checked' : '') + '> 显示下方每页识别出的文字（核对是否认对了）</label>' +
      '</div>' +
      '<div class="ocr-row">' +
        '<button class="btn-plain" id="imgOcrClearBtn" title="删掉本页（或所填页）的识别结果，恢复成纯图片">🧹 清除本页识别</button>' +
        '<button class="btn-plain" id="imgOcrClearAllBtn" title="删掉整本已识别的文字层">清除全部</button>' +
      '</div>' +
      '<div class="ocr-hint">点行 = 展开 / 收起那页文字；点行首 👁 = 跳到那页并显示文字层（同缩放条 A）。</div>' +
      '<div class="ocr-preview" id="ocrPreview" hidden></div>' +
      '<div class="ocr-tip">识别后可划词、查词、翻译、高亮。结果按页存在本机，不用重认。浏览器内识别首次要联网下语言包。</div>' +
    '</div>';
  bindOcrCfgUi(body);

  const inp0 = $('imgOcrPages');
  if (inp0) {
    inp0.value = R._ocrPages || '';
    inp0.oninput = function () { R._ocrPages = inp0.value; };
  }
  const showBox = $('ocrShowText');
  if (showBox) showBox.onchange = function () { setOcrShowList(!!showBox.checked); };

  const rerender = function () { openImgOcrDrawer(curList.length === 1 ? curList[0] : undefined); };   // 识别完刷新一下计数
  const pageBtn = $('imgOcrPageBtn');
  if (pageBtn) pageBtn.onclick = async function () {
    // 点下去的这一刻再取页：抽屉打开着也能翻页 / 翻到别的图再点，永远识别眼前这张
    const now = comicNowPages();
    if (!now.length) { toast('这本书没有图片页'); return; }
    const label = '第 ' + now.map(function (i) { return i + 1; }).join('、') + ' 页';
    const st1 = $('ocrStatus');
    if (st1) st1.textContent = '准备识别' + label + '…';
    pageBtn.disabled = true;
    pageBtn.textContent = '🔍 识别中…';
    try {
      await runImgBulkOcr(now, { force: true });
    } finally {
      pageBtn.disabled = false;
      pageBtn.textContent = '🔍 识别本页';
    }
    rerender();
    // 识别完立刻把层贴回来（不要等下一帧滚动）：用户点了就想看到能不能划词
    syncImgTextLayers();
    // 顺手把这页识别出的文字展开：能当场核对是不是乱码，不用再去勾那个复选框
    setOcrShowList(true);
    const pv = $('ocrPreview');
    if (pv) { pv.hidden = false; pv.scrollTop = pv.scrollHeight; }
  };
  const allBtn = $('imgOcrAllBtn');
  if (allBtn) allBtn.onclick = async function () {
    allBtn.disabled = true;
    allBtn.textContent = '🔍 识别中…';
    await runImgBulkOcr(null);
    rerender();
  };
  const stopBtn = $('imgOcrStopBtn');
  if (stopBtn) stopBtn.onclick = function () { ocrRequestStop(); };
  const selBtn = $('imgOcrSelBtn');
  if (selBtn) selBtn.onclick = async function () {
    const v = inp0 ? inp0.value.trim() : '';
    if (!v) { toast('先填页码，比如 1,5 或 1-3'); return; }
    const raw = parsePageList(v, Math.max(total, 1e9));
    const over = raw.filter(function (i) { return i >= total; });
    const list = Array.from(new Set(raw.filter(function (i) { return i < total; }))).sort(function (a, b) { return a - b; });
    if (!list.length) { toast('页码超出范围：本书共 ' + total + ' 页图片'); return; }
    if (over.length) toast('第 ' + over.map(function (i) { return i + 1; }).join('、') + ' 页超出范围（共 ' + total + ' 页），已跳过');
    const st0 = $('ocrStatus');
    if (st0) st0.textContent = '准备识别第 ' + list.map(function (i) { return i + 1; }).join('、') + ' 页（共 ' + list.length + ' 页）…';
    selBtn.disabled = true;
    await runImgBulkOcr(list);
    rerender();
  };
  const clearBtn = $('imgOcrClearBtn');
  if (clearBtn) clearBtn.onclick = async function () {
    const v = inp0 ? inp0.value.trim() : '';
    let list = v ? parsePageList(v, total) : [];
    if (!list.length) list = [cur];
    let n = 0;
    for (const i of list) { if (await clearImgOcrPage(i)) n++; }
    await saveImgOcrIndex();
    updateOcrProgress(0, Math.max(0, total - R._imgOcrPages.size));
    const st0 = $('ocrStatus');
    if (st0) st0.textContent = n ? ('已清除 ' + n + ' 页识别结果') : '这些页本来就没有识别结果';
    toast(n ? ('已清除 ' + n + ' 页识别结果') : '没有可清除的识别结果');
    scheduleImgLayerSync();
    rerender();
  };
  const clearAllBtn = $('imgOcrClearAllBtn');
  if (clearAllBtn) clearAllBtn.onclick = async function () {
    const n = await clearAllImgOcr();
    toast(n ? ('已清除全部 ' + n + ' 页识别结果') : '本来就没有识别结果');
    updateOcrProgress(0, 0);
    scheduleImgLayerSync();
    rerender();
  };
  showImgOcrPreview();
  // 抽屉本体要显式打开（PDF 那条路径是在函数末尾调 openDrawer，图片书在这里补一次，
  // 否则点 🔍 OCR 只是把内容填进看不见的抽屉里）
  applyTextLayerVisibility();
  openDrawer('ocrDrawer');
}

/** 高亮 / 下划线加了之后重画当前可见页的文字层标记带（图片书版 repaintPdfHighlights） */
function repaintImgHighlights() {
  if (!R._imgTextLayers) return;
  R._imgTextLayers.forEach(function (layer, i) {
    try { paintPdfHighlights(layer, i); } catch (e) { }
  });
}

/** PDF 选区伪偏移：用 span 上的 data-off（已含页基址） + 段内偏移 */
function pdfPseudoOffset(node, off) {
  let el = node.nodeType === 3 ? node.parentElement : node;
  while (el && el.dataset && el.dataset.off == null && el.id !== 'pdfStack') el = el.parentElement;
  if (!el || !el.dataset || el.dataset.off == null) return null;
  return parseFloat(el.dataset.off) + off;
}

/** PDF 缩放控件：− / 适应 / +；点「适应」回到适应宽度（整本一条长卷，不再单页翻） */
function updatePdfZoomLabel() {
  const el = $('pdfZoomVal');
  if (el) el.textContent = Math.round((R.pdfZoom || 1) * 100) + '%';
}
async function pdfZoomBy(delta) {
  if (R.format !== 'pdf' || !R.pdfDoc) return;
  const layer = $('pdfLayer'), stack = $('pdfStack');
  if (!layer || !stack) return;
  // 记下「当前顶页 + 在该页内的偏移比例」，缩放后把阅读位置锚定回同一页，
  // 否则点「适应」一按页面就会跳动 / 自动下滑。
  let anchor = R.pageIndex, frac = 0;
  const tp = [...stack.querySelectorAll('.pdf-page')].filter(cv => cv.offsetTop <= layer.scrollTop + 8).pop();
  if (tp) {
    anchor = parseInt(tp.dataset.idx, 10);
    frac = (layer.scrollTop - tp.offsetTop) / Math.max(1, tp.offsetHeight);
  }
  // R89：缩放下限从 100% 放到 30%（用户要「能缩到 30% 看全局版式」）；
  // 100% = 适应宽度，往下缩页面只会变窄居中，不影响翻页/笔迹锚定。
  R.pdfZoom = Math.min(4, Math.max(0.3, (R.pdfZoom || 1) + delta));
  if (R._pdfRendered) R._pdfRendered.clear();
  await pdfLazyRender();
  const tp2 = stack.querySelector('.pdf-page[data-idx="' + anchor + '"]');
  if (tp2) layer.scrollTop = Math.max(0, tp2.offsetTop + frac * tp2.offsetHeight);
  updatePdfZoomLabel();
  if (typeof ink !== 'undefined' && ink && ink.strokes.length) ink.redraw();   // 缩放后笔迹跟随（#195）
}
async function pdfZoomFit() {
  if (R.format !== 'pdf') return;
  R.pdfZoom = 1;
  await pdfZoomBy(0);   // 复用上面的「保持阅读位置」逻辑
}

/* ============================================================
   翻页
   ============================================================ */
function goToPage(i, silent) {
  // 翻页/跳页前把划词浮层收掉：它锚在上一页的选区上，悬在新页面上会挡住正文
  //（实测：页码跳走后浮层还在，接着在正文上拖动选不中，mousedown 全落在浮层上）
  if (typeof hideSelPopover === 'function') hideSelPopover();
  // 富文本翻页模式：按「屏幕页」跳转（#12）；滚动模式页码无意义，仍走自由滚动
  if (R.format === 'html') {
    if (!Settings.htmlPaged) return;
    i = Math.max(0, Math.min(R.totalPages - 1, i));
    if (i === R.pageIndex) { return; }
    R.pageIndex = i;
    const layer = $('scrollLayer');
    const pg = layer && layer.querySelector('.html-page[data-idx="' + i + '"]');
    if (pg && layer) layer.scrollTop = htmlPageScrollTop(layer, pg);
    refreshInk();
    updateChrome();
    scheduleSave();
    return;
  }
  i = Math.max(0, Math.min(R.totalPages - 1, i));
  const dir = i >= R.pageIndex ? 1 : -1;
  R.pageIndex = i;
  if (R.format === 'txt') {
    // 文字书一律按"字符偏移"记进度；上下滚动模式下还要真的滚过去
    const p = R.pages[i];
    if (p) R.book.locator = p.start;
    if (Settings.direction === 'vertical') scrollToOffset(p ? p.start : 0);
  } else {
    R.book.locator = i;
  }
  renderPage();
  // 卷轴 / PDF 连续卷轴：「跳页」= 滚到那一页；渲染刚重建，要等占位后才能滚准
  if (comicScrollOn()) {
    requestAnimationFrame(() => comicScrollTo(i));
  } else if (R.format === 'pdf') {
    const stack = $('pdfStack');
    const cv = stack && stack.querySelector('.pdf-page[data-idx="' + i + '"]');
    if (cv) requestAnimationFrame(() => { $('pdfLayer').scrollTop = Math.max(0, cv.offsetTop - 8); });
  }
  refreshInk();
  updateChrome();
  scheduleSave();
  if (!silent && R.autoTimer) { /* 自动翻页中，不重复提示 */ }
}

function nextPage() {
  // 连续卷轴：滚一屏，滚到底自然就是下一页
  if (comicScrollOn()) {
    const el = $('imgLayer');
    el.scrollBy({ top: el.clientHeight * 0.9, behavior: 'smooth' });
    // 已经到底了要停下来，否则自动翻页的定时器会一直空转
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) { stopAuto(); toast('已到末尾'); }
    return;
  }
  if ((R.format === 'txt' && Settings.direction === 'vertical') || R.format === 'html') {
    // 富文本翻页模式：整屏翻一页（#12），到头判断用页码
    if (R.format === 'html' && Settings.htmlPaged) {
      if (R.pageIndex >= R.totalPages - 1) { stopAuto(); toast('已经到最后一页'); return; }
      goToPage(R.pageIndex + 1);
      return;
    }
    const el = $('scrollLayer');
    el.scrollBy({ top: el.clientHeight * 0.88, behavior: 'smooth' });
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) { stopAuto(); toast('已到末尾'); }
    return;
  }
  // 漫画双页时一屏算两页，到头判断要用"本屏最后一页"
  if (R.format === 'comic') {
    const step = comicStep();
    const lastOnScreen = R.pageIndex + step - 1;
    if (lastOnScreen >= R.totalPages - 1) { stopAuto(); toast('已经到最后一页'); return; }
    goToPage(R.pageIndex + step);
    return;
  }
  if (R.pageIndex >= R.totalPages - 1) { stopAuto(); toast('已经到最后一页'); return; }
  goToPage(R.pageIndex + 1);
}
function prevPage() {
  // 连续卷轴：回退一屏；已经在最顶就退到上一张图
  if (comicScrollOn()) {
    const el = $('imgLayer');
    if (el.scrollTop <= 2) {
      if (R.pageIndex <= 0) { toast('已经是第一页'); return; }
      comicScrollTo(R.pageIndex - 1);
      return;
    }
    el.scrollBy({ top: -el.clientHeight * 0.9, behavior: 'smooth' });
    return;
  }
  if (R.format === 'html' && Settings.htmlPaged) {
    if (R.pageIndex <= 0) { stopAuto(); toast('已经是第一页'); return; }
    goToPage(R.pageIndex - 1);
    return;
  }
  if ((R.format === 'txt' && Settings.direction === 'vertical') || R.format === 'html') {
    $('scrollLayer').scrollBy({ top: -$('scrollLayer').clientHeight * 0.88, behavior: 'smooth' });
    return;
  }
  if (R.format === 'comic') {
    const step = comicStep();
    if (R.pageIndex <= 0) { toast('已经是第一页'); return; }
    goToPage(Math.max(0, R.pageIndex - step));
    return;
  }
  if (R.pageIndex <= 0) { toast('已经是第一页'); return; }
  goToPage(R.pageIndex - 1);
}

/* ============================================================
   滚动模式（上下）
   ============================================================ */
function renderScrollContent() {
  const inner = $('scrollInner');
  const box = contentBox();
  let html = '';
  // 按分页结果把每一页包成一个 .txt-page 盒（高度=内容区高度），
  // 这样竖向卷轴也像漫画一样有「按页归一化」的笔迹锚点，与横向分页互通。
  for (let i = 0; i < R.pages.length; i++) {
    const pg = R.pages[i];
    const chunk = R.text.slice(pg.start, pg.end);
    html += `<div class="txt-page" data-idx="${i}" style="min-height:${box.h}px">${buildHTML(chunk, pg.start)}</div>`;
  }
  inner.innerHTML = html;
  if (typeof InkMath !== 'undefined' && inner.textContent.indexOf('$') >= 0) {
    try { InkMath.renderIn(inner); } catch (e) { }
  }
  R._paraTops = null;
  bumpInkToken();                       // 竖排整本重渲染，锚点索引重建
}

function paraTops() {
  if (R._paraTops && R._paraTops.length) return R._paraTops;
  const ps = $('scrollInner').querySelectorAll('p[data-off]');
  const arr = [];
  ps.forEach(p => arr.push({ top: p.offsetTop, off: parseInt(p.dataset.off) }));
  R._paraTops = arr;
  return arr;
}

function scrollToOffset(off) {
  const el = $('scrollLayer');
  const inner = $('scrollInner');
  if (!el || !inner) return;
  // R130（第 6 条）：不再用 paraTops() 里缓存的 offsetTop —— 那个值的参照系是 offsetParent，
  // 卷轴容器有 68px 上内边距 + 顶栏浮在正文上，offsetTop 与 scrollTop 差一截，
  // 结果「定位过去」时整段被顶进 padding 里（贴着 / 压到顶栏下面，用户看着就是位置不对）。
  // 改成和 htmlScrollToOffset 一样的算法：用 getBoundingClientRect 相减求真实像素距离，
  // 再把目标段落在视口**正中间**（R131 第 6 条）。
  const ps = inner.querySelectorAll('p[data-off]');
  if (!ps.length) return;
  let target = ps[0], tIdx = 0;
  for (let i = 0; i < ps.length; i++) {
    const o = parseInt(ps[i].dataset.off, 10) || 0;
    if (o <= off) { target = ps[i]; tIdx = i; } else break;
  }
  const lr = el.getBoundingClientRect();
  const tr = target.getBoundingClientRect();
  const docY = (tr.top - lr.top) + el.scrollTop;        // 目标段顶部的真实纵向位置
  const next = ps[tIdx + 1];
  const spanH = next ? (next.getBoundingClientRect().top - tr.top) : (tr.height + 12);
  const to = parseInt(target.dataset.off, 10) || 0;
  const no = next ? (parseInt(next.dataset.off, 10) || 0) : (to + 40);
  const ratio = no > to ? Math.min(1, Math.max(0, (off - to) / (no - to))) : 0;
  // R131（第 6 条）：落点改到**屏幕中间**。R130 把目标段放在视口 18% 处（怕被顶栏压住），
  // 用户实测「定位还是偏上」—— 眼睛在屏幕中间，落点就该在中间。
  // 用「视口高的一半 - 半个行高」把这一段的顶推到正中，再夹一下别越界。
  const inset = Math.round(Math.max(0, lr.height * 0.5 - spanH * 0.5));
  el.scrollTop = Math.max(0, docY + spanH * ratio - inset);
}

/** 定位到某条标注后让那几个字闪一下：分页模式只能跳到「含这段的那一页」，
 *  标记可能落在页面中下部，不闪一下就不知道到底跳到哪儿了（R130 第 6 条）。 */
function flashAnnotMark(a) {
  if (!a || !a.id) return;
  const root = (R.format === 'txt')
    ? (Settings.direction === 'vertical' ? $('scrollInner') : $('pageText'))
    : null;
  if (!root) return;
  setTimeout(() => {
    let hits = root.querySelectorAll('.mk[data-id="' + a.id + '"]');
    if (!hits.length) hits = root.querySelectorAll('.mk');
    if (!hits.length) return;
    hits.forEach((n) => n.classList.add('mk-flash'));
    setTimeout(() => hits.forEach((n) => n.classList.remove('mk-flash')), 1250);
  }, 280);
}

function reportScroll() {
  const el = $('scrollLayer');
  const arr = paraTops();
  if (!arr.length) return;
  const st = el.scrollTop;
  let cur = arr[0];
  for (let i = 0; i < arr.length; i++) { if (arr[i].top <= st + 8) cur = arr[i]; else break; }
  R.book.locator = cur.off;
  R._scrollProgress = el.scrollHeight > el.clientHeight
    ? st / (el.scrollHeight - el.clientHeight) : 0;
  ink.setScrollTop(st);
  updateChrome();
  scheduleSave();
}

/** 富文本滚动上报：翻页模式跟踪当前屏页码；滚动模式进度存滚动百分比 */
function reportHtmlScroll() {
  const el = $('scrollLayer');
  if (!el) return;
  if (Settings.htmlPaged) {
    // 翻页模式：滚到哪一屏算哪一页，切页时重载笔迹
    const cTop = el.scrollTop + el.clientHeight * 0.4;
    let cur = 0;
    el.querySelectorAll('.html-page').forEach(pg => {
      if (pg.offsetTop <= cTop) cur = parseInt(pg.dataset.idx, 10) || 0;
    });
    if (cur !== R.pageIndex) { R.pageIndex = cur; refreshInk(); }
    R.book.locator = R.totalPages > 1 ? cur / (R.totalPages - 1) : 0;
    R._scrollProgress = R.book.locator;
  } else {
    const max = Math.max(1, el.scrollHeight - el.clientHeight);
    const prog = Math.min(1, Math.max(0, el.scrollTop / max));
    R.book.locator = prog;
    R._scrollProgress = prog;
  }
  // 与形态无关的锚点：切翻页/滚动、重开书、书签定位都靠它（见 initHtml 的说明）
  R.book.htmlOff = htmlCurrentOffset();
  updateChrome();
  scheduleSave();
}

/* ============================================================
   进度 / 界面同步
   ============================================================ */
/** R131（第 9 条）：日漫「右→左」时下方控件要不要镜像。
 *  以前只给滑块加了 CSS `direction:rtl` —— 自定义外观的 range（appearance:none +
 *  渐变轨道）在部分内核上根本不翻转，用户看到的就是「滑条没变化」。
 *  现在改成「自己算反向数值」，不依赖样式与内核差异。 */
function chromeRtlMirror() {
  return !!(R.book && R.format === 'comic' && Settings.comicRTL === true && !comicScrollOn());
}

function updateChrome() {
  if (!R.book) return;
  const vert = R.format === 'txt' && Settings.direction === 'vertical';
  const scroll = comicScrollOn();
  let sval = 0;                                   // 滑块真实进度 0–100（镜像在最后一步统一做）
  if (vert) {
    const prog = R._scrollProgress || 0;
    sval = prog * 100;
    $('pageLabel').textContent = Math.round(prog * 100) + '%';
    R.book.progress = prog;             // 不写回的话，书架上的"已读 x%"永远是 0
  } else if (scroll) {
    const el = $('imgLayer');
    const max = Math.max(1, el.scrollHeight - el.clientHeight);
    const prog = Math.min(1, Math.max(0, el.scrollTop / max));
    sval = prog * 100;
    $('pageLabel').textContent = `${R.pageIndex + 1} / ${R.totalPages}`;
    R.book.progress = prog;
  } else if (R.format === 'html') {
    const el = $('scrollLayer');
    if (Settings.htmlPaged) {
      // 富文本翻页模式：按屏序号显示页码
      sval = R.totalPages > 1 ? (R.pageIndex / (R.totalPages - 1) * 100) : 0;
      $('pageLabel').textContent = `${R.pageIndex + 1} / ${R.totalPages}`;
      R.book.progress = R.totalPages > 1 ? R.pageIndex / (R.totalPages - 1) : 0;
    } else {
      // 富文本滚动模式：进度按滚动百分比
      const max = Math.max(1, el.scrollHeight - el.clientHeight);
      const prog = Math.min(1, Math.max(0, el.scrollTop / max));
      sval = prog * 100;
      $('pageLabel').textContent = Math.round(prog * 100) + '%';
      R.book.progress = prog;
    }
  } else {
    sval = R.totalPages > 1 ? (R.pageIndex / (R.totalPages - 1) * 100) : 0;
    $('pageLabel').textContent = (R.format === 'comic' && comicSpreadOn())
      ? `${R.pageIndex + 1}-${Math.min(R.totalPages, R.pageIndex + 2)} / ${R.totalPages}`
      : `${R.pageIndex + 1} / ${R.totalPages}`;
    R.book.progress = R.totalPages > 1 ? R.pageIndex / (R.totalPages - 1) : 0;
  }
  // R131（第 9 条）：右→左时滑块**数值**反过来 —— 第 1 页在滑条最右端，往左拖才是往后翻，
  // 与翻页手势 / 目录方向一致。取值换算在 main.js 的 oninput 里成对做，改一处不会有一半错位。
  const psEl = $('progressSlider');
  if (psEl) {
    const rtlNow = chromeRtlMirror();
    const v = rtlNow ? (100 - sval) : sval;
    psEl.value = Number(v).toFixed(1);
    if (psEl.style.direction) psEl.style.direction = '';   // 清掉 R130 留下的 CSS 镜像，免得翻两次
  }
  // 翻页按钮：R132（第 4 条）用户要的是「图标不动，只有行为反」——
  // 右→左时 `›`（右边那颗）是往前翻、`‹`（左边那颗）是往后翻，与滑条镜像一致。
  // 以前连图标也一起换，看着就像把两个键调了个位置，反而更迷惑。
  const pb = $('prevBtn'), nb = $('nextBtn');
  if (pb && nb) {
    const rtlNow = chromeRtlMirror();
    pb.title = rtlNow ? '下一页（往左翻）' : '上一页';
    nb.title = rtlNow ? '上一页（往右翻）' : '下一页';
  }
  // 漫画时这个键是"左→右 / 右→左 / 上→下"三选循环，文字书才是左右分页 ⇄ 上下滚动
  const db = $('dirBtn');
  const nb0 = narrowBar();
  if (R.format === 'html') {
    db.hidden = true;                 // 富文本无分页/横竖概念
  } else if (R.format === 'comic') {
    db.hidden = false;
    db.textContent = nb0 ? (COMIC_DIR_ICON_MIN[comicDir()] || '⇄')
      : (COMIC_DIR_ICON[comicDir()] || '⇄ 左右');
    db.title = '漫画翻页方向（左→右 / 右→左 / 上→下）';
  } else {
    db.hidden = false;
    const txt = Settings.direction === 'horizontal' ? '⇄ 左右' : '⇅ 上下';
    db.textContent = nb0 ? txt.slice(0, 1) : txt;   // 窄屏只留箭头，title 里有全称
    db.title = '切换翻页方向（' + (Settings.direction === 'horizontal' ? '左右' : '上下') + '）';
  }
  const cmb = $('comicModeBtn');
  if (cmb) {
    cmb.hidden = (R.format !== 'comic');
    cmb.textContent = nb0 ? (Settings.comicMode === 'scroll' ? '📜' : '📄')
      : (Settings.comicMode === 'scroll' ? '📜 卷轴' : '📄 分页');
    cmb.classList.toggle('on', Settings.comicMode === 'scroll');
  }
  // 富文本翻页 / 滚动切换按钮：仅富文本（html/epub）可见（#12）
  const hmb = $('htmlModeBtn');
  if (hmb) {
    hmb.hidden = (R.format !== 'html');
    if (R.format === 'html') {
      hmb.textContent = Settings.htmlPaged ? '📄 翻页' : '📜 滚动';
      hmb.classList.toggle('on', Settings.htmlPaged);
    }
  }
  $('speedWrap').hidden = !R.autoTimer;
  // 富文本：手写笔迹按「页面盒」归一化已支持（#4），不再隐藏手写按钮
  const penBtn = $('penBtn');
  if (penBtn) { penBtn.hidden = false; penBtn.classList.toggle('on', R.penMode); }
  // PDF OCR 入口：仅 PDF 可见（扫描页文字识别面板，修 #5：控制移出阅读页进抽屉）
  const ocrBtn = $('ocrBtn');
  if (ocrBtn) {
    // 图片书也能识别文字（R118）：按钮不再只给 PDF
    ocrBtn.hidden = (R.format !== 'pdf' && R.format !== 'comic');
    ocrBtn.title = R.format === 'comic' ? '识别图片里的文字（OCR）：识别后可划词 / 查词 / 翻译 / 高亮'
      : 'PDF 扫描页文字识别（OCR）';
  }
  updateAutoBtn();
  const bm = R.annots.filter(a => a.type === 'bookmark').length;
  $('markBtn').textContent = bm ? `🔖 书签 ${bm}` : '🔖 书签';
  updateFavBtn();
}

function scheduleSave() {
  clearTimeout(R._saveTimer);
  R._saveTimer = setTimeout(() => saveProgress(), 700);
}
function saveProgress(now) {
  if (!R.book) return;
  R.book.lastReadAt = Date.now();
  R.book.totalPages = R.totalPages;
  DB.put('books', R.book);
}
function currentPageKey() {
  // 漫画两种形态都按图片下标存 :p<idx>（分页/卷轴笔迹互通，排序可重映射）
  if (R.format === 'comic') return 'p' + R.pageIndex;
  // 文字书（txt / pdf）一律按页 :p<页码> 存，坐标归一化到该页正文盒——
  // 竖向卷轴与横向分页共用同一套 key 与归一化坐标，笔迹互通（不再有 :v 隔离）。
  return 'p' + R.pageIndex;
}
function inkKey() { return R.book.id + ':' + currentPageKey(); }

/* ============================================================
   文字书的笔迹锚点：把「字符偏移」当锚，字号/版心变化后仍落在同一段文字上
   ------------------------------------------------------------
   以前笔迹是「相对页盒归一化」的，改字号会把文字重排（同一页的字变了），
   笔迹却还糊在原来的相对位置 —— 看着就是「字迹和字体不同步」。
   现在按字符偏移锚定：落笔时记录锚点字符 + 落笔字号，渲染时按
   当前字号/落笔字号等比缩放，于是字变大了笔迹也跟着变大、且贴着同一行。
   ============================================================ */
function bumpInkToken() { R._inkToken = (R._inkToken || 0) + 1; }

/** 当前真正显示着文字的那一层：#scrollInner（竖向卷轴 / 富文本）还是 #pageText（横向分页）。
 *  两层的内容不会互相清理：竖向卷轴把整本书塞进 #scrollInner，切回横向时只重渲染 #pageText，
 *  #scrollInner 里的旧块全留着（隐藏、rect 全 0）。所以索引只能认一层 —— 两层一起查的话，
 *  同一个偏移会命中隐藏块，笔迹被画到画布左上角 (0,0)、橡皮擦不到、还会把别的页算成「本页」。 */
function inkRootId() {
  if (R.format === 'html') return 'scrollInner';
  if (R.format === 'txt' && Settings.direction === 'vertical') return 'scrollInner';
  return 'pageText';
}

/** 当前渲染出来的文本块（带 data-off），按偏移升序。带 token 缓存，别在每笔重绘时都查一遍 DOM。 */
function inkBlockIndex() {
  if (R._inkIdx && R._inkIdx.token === R._inkToken) return R._inkIdx.blocks;
  const blocks = [];
  const root = $(inkRootId());
  if (root) {
    root.querySelectorAll('[data-off]').forEach(el => {
      const off = parseInt(el.dataset.off, 10);
      if (Number.isNaN(off)) return;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;    // 隐藏页 / 还没布局的块：不算「这一页的文字」
      blocks.push({ el, off, len: (el.textContent || '').length });
    });
  }
  blocks.sort((a, b) => a.off - b.off);
  // 空结果不缓存：切模式的那一帧目标层可能还没布局，缓存住会让笔迹整页不画，直到下次重排
  if (blocks.length) R._inkIdx = { token: R._inkToken, blocks };
  return blocks;
}

/** 在块内按局部偏移找到那个文本节点相对位置，包成 collapsed Range */
function _rangeInBlock(blk, local) {
  const w = document.createTreeWalker(blk.el, NodeFilter.SHOW_TEXT);
  let acc = 0, n, node = null;
  while ((n = w.nextNode())) {
    const L = n.nodeValue.length;
    if (local <= acc + L) { node = n; break; }
    acc += L;
  }
  if (!node) return null;
  const rg = document.createRange();
  rg.setStart(node, Math.max(0, Math.min(node.nodeValue.length, local - acc)));
  rg.collapse(true);
  return { rg, node };
}

/** 字符偏移 → 它现在在屏幕上的矩形 + 当前字号（笔迹缩放靠它） */
function inkRectForOffset(off) {
  const blocks = inkBlockIndex();
  if (!blocks.length) return null;
  // 只认「当前渲染出来的这段文字」的偏移区间：笔迹属于第 2 页而现在是第 1 页时，
  // 这个偏移在本页根本不存在 —— 必须返回 null。否则会拿最后一块的矩形糊上去，
  // 笔迹跑到别页、还会被「清空本页」误删（按几何位置判断属于哪一页，就会误伤）。
  const lastBlk = blocks[blocks.length - 1];
  const spanEnd = lastBlk.off + Math.max(1, lastBlk.len);
  if (off < blocks[0].off || off >= spanEnd) return null;
  let lo = 0, hi = blocks.length - 1, k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].off <= off) { k = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (k < 0) k = 0;
  const b = blocks[k];
  const local = Math.max(0, Math.min(off - b.off, b.len));
  const got = _rangeInBlock(b, local);
  if (!got) {
    const r = b.el.getBoundingClientRect();
    return { rect: r, fs: parseFloat(getComputedStyle(b.el).fontSize) || 16 };
  }
  let rect = (got.rg.getClientRects && got.rg.getClientRects()[0]) || got.rg.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) rect = b.el.getBoundingClientRect();   // 行尾/空行的光标没有盒子
  const fsEl = got.node.parentElement || b.el;
  return { rect, fs: parseFloat(getComputedStyle(fsEl).fontSize) || 16 };
}

/** 屏幕点 → 该点下（或最近的）字符偏移 + 该字符矩形与字号。
 *  ⚠️ 不能只靠 `caretRangeFromPoint`：阅读区上面盖着 #tapZones 和笔迹画布，
 *     浏览器的光标命中会落在这些浮层上（返回 element，拿不到文本节点），于是永远 null。
 *     所以主路径是**纯几何**：先选出落点所在的文本块，再在块内找离落点最近的字符。 */
function inkAnchorAt(x, y) {
  const blocks = inkBlockIndex();
  if (!blocks.length) return null;

  // 1) 落点落在哪个块（同一行/最近的一行）
  let best = null, bestD = Infinity;
  for (const b of blocks) {
    const r = b.el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (y >= r.top - 2 && y <= r.bottom + 2 && x >= r.left - 6 && x <= r.right + 6) { best = b; bestD = 0; break; }
    const dy = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
    const dx = x < r.left ? r.left - x : (x > r.right ? x - r.right : 0);
    const d = dy * 3 + dx;               // 纵向更看重：优先同一行，其次上下相邻行
    if (d < bestD) { bestD = d; best = b; }
  }
  if (!best || bestD > 200) return null;  // 点在大片留白/图上，不锚定（老逻辑兜底）

  // 2) 块内找最近的字符（先粗扫再细化：块再长也不会卡在几十毫秒）
  const memo = new Map();
  const rectAt = (local) => {
    if (memo.has(local)) return memo.get(local);
    const g = _rangeInBlock(best, local);
    let r = null;
    if (g) {
      r = (g.rg.getClientRects && g.rg.getClientRects()[0]) || g.rg.getBoundingClientRect();
      if (r && !r.width && !r.height) r = null;
    }
    memo.set(local, r);
    return r;
  };
  let pick = -1, pickD = Infinity;
  const consider = (local) => {
    const r = rectAt(local);
    if (!r) return;
    const dx = x - (r.left + r.right) / 2;
    const dy = y - (r.top + r.bottom) / 2;
    const d = dx * dx + dy * dy;
    if (d < pickD) { pickD = d; pick = local; }
  };
  const len = Math.max(0, best.len - 1);
  const step = Math.max(1, Math.ceil((len + 1) / 200));
  for (let l = 0; l <= len; l += step) consider(l);
  if (pick < 0) {                          // 块里没有文本节点（纯图片/空块）
    const r = best.el.getBoundingClientRect();
    return { off: best.off, rect: r, fs: parseFloat(getComputedStyle(best.el).fontSize) || 16 };
  }
  const lo = Math.max(0, pick - step * 2), hi = Math.min(len, pick + step * 2);
  for (let l = lo; l <= hi; l++) consider(l);

  const rect = rectAt(pick) || best.el.getBoundingClientRect();
  const fs = parseFloat(getComputedStyle(best.el).fontSize) || 16;
  return { off: best.off + pick, rect, fs };
}

/** 重新挂载/刷新当前页或当前文档的手写笔迹 */
function refreshInk() {
  if (!R.book) return;
  bumpInkToken();
  // 文字书竖向卷轴 / 富文本滚动：scrollLayer 滚动时让笔迹跟随重绘。
  // 笔迹画布是覆盖在视口上的 overlay（不随内容滚动），坐标靠当前 scrollTop 反算，
  // 因此必须在这里（一次性）监听 scrollLayer 的滚动并触发 ink.setScrollTop，
  // 否则滚动时笔迹停在屏幕上、与文字错位（修 #3：epub 卷轴字迹停留在屏幕）。
  const sl = $('scrollLayer');
  if (sl && !sl._inkScrollBound) {
    sl._inkScrollBound = true;
    sl.addEventListener('scroll', () => {
      if (!R.book) return;
      const inkScroll = (R.format === 'html') || (R.format === 'txt' && Settings.direction === 'vertical');
      if (inkScroll) ink.setScrollTop(sl.scrollTop);
    }, { passive: true });
  }
  // 富文本翻页模式：一页里塞不下（超长段落/代码块）的那张 .html-page 会自带 overflow-y:auto，
  // 滚的是它自己，不冒泡到 scrollLayer → 笔迹不重绘，看起来就是「字在滚、笔迹钉在屏幕上」。
  // 捕获阶段能收到任何后代元素的 scroll，统一让笔迹重画一次（锚点矩形本来就是现取的）。
  const sInner = $('scrollInner');
  if (sInner && !sInner._inkScrollBound) {
    sInner._inkScrollBound = true;
    sInner.addEventListener('scroll', () => {
      if (R.book && typeof ink !== 'undefined' && ink) ink.scheduleRedraw();
    }, { capture: true, passive: true });
  }
  const comic = R.format === 'comic';
  const vert = R.format === 'txt' && Settings.direction === 'vertical';
  ink.setContext({ comic, bookId: R.book.id, pageIndex: R.pageIndex, scroll: comicScrollOn() });
  if (comic) {
    // 漫画统一走「按图归一化」逻辑（ink 内部根据 comic 上下文判断分页/卷轴）
    ink.setMode('page');
    ink.loadFor(inkKey());
  } else if (R.format === 'pdf') {
    // PDF 连续卷轴：笔迹按页 :p<idx> 存（与漫画同一套），坐标归一化到该页，
    // 滚到哪页画哪页；不误删、分页/卷轴互通。
    ink.setContext({ comic: true, bookId: R.book.id, pageIndex: R.pageIndex, scroll: true, layer: 'pdfLayer', pageSel: '.pdf-page' });
    ink.setMode('page');
    ink.loadFor(inkKey());
  } else {
    // 文本书（txt 分页 / txt 竖排 / html·epub·docx）：**整本一套笔迹，按字符偏移锚定**。
    // 这样改字号导致重排、页数变化后，笔迹仍贴在原来那段文字上，粗细也随字号等比变化
    //（以前按页盒归一化：字号一变，同一页的字换了一批，笔迹就糊在原地 —— 用户说的「字迹和字体不同步」）。
    // layer/pageSel 仍按形态给出，只为把旧版按页存的笔迹迁移过来时算页面盒位置。
    const paged = R.format === 'html' ? !!Settings.htmlPaged : !vert;
    ink.setContext({
      comic: false, textBook: true, bookId: R.book.id, pageIndex: R.pageIndex,
      scroll: !paged,
      layer: R.format === 'html' ? 'scrollLayer' : (vert ? 'scrollLayer' : 'txtLayer'),
      pageSel: R.format === 'html' ? '.html-book' : (vert ? '.txt-page' : '#pageText'),
      anchorAt: inkAnchorAt, rectOf: inkRectForOffset
    });
    ink.setMode('page');
    ink.loadFor(inkKey());
  }
  ink.resize();   // 确保手写画布尺寸与当前阅读区匹配（PDF/卷轴笔迹才不会错位）
}

/* ============================================================
   自动翻页
   ============================================================ */
function toggleAuto() { R.autoTimer ? stopAuto() : startAuto(); }
function startAuto() {
  if (!R.book) return;
  stopAuto();
  R.autoNextAt = Date.now() + Settings.autoSpeed * 1000;
  R.autoTimer = setInterval(() => {
    R.autoNextAt = Date.now() + Settings.autoSpeed * 1000;
    nextPage();
    updateAutoBtn();
  }, Settings.autoSpeed * 1000);
  clearInterval(R._cdTimer);
  R._cdTimer = setInterval(updateAutoBtn, 200);
  updateAutoBtn();
  updateChrome();
  showBars(true);
  toast(`自动播放已开始 · 每 ${Settings.autoSpeed} 秒翻一页`);
  requestWakeLock();
}
function stopAuto() {
  if (R.autoTimer) { clearInterval(R.autoTimer); R.autoTimer = null; }
  clearInterval(R._cdTimer); R._cdTimer = null;
  updateAutoBtn();
  updateChrome();
  releaseWakeLock();
}
function updateFavBtn() {
  const b = $('favBtn');
  if (!b || !R.book) return;
  b.textContent = R.book.fav ? '★ 已收藏' : '☆ 收藏';
  b.classList.toggle('on', !!R.book.fav);
}

function updateAutoBtn() {
  const btn = $('autoBtn');
  if (!btn) return;
  const nb = narrowBar();
  if (R.autoTimer) {
    const left = Math.max(0, Math.ceil((R.autoNextAt - Date.now()) / 1000));
    btn.innerHTML = nb ? ('⏸ ' + left + 's') : `⏸ 暂停 · ${left}s`;
    btn.classList.add('playing');
  } else {
    btn.innerHTML = nb ? '▶' : '▶ 自动播放';
    btn.classList.remove('playing');
  }
}

let wakeLock = null;
async function requestWakeLock() {
  if (!Settings.keepAwake) return;
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { }
}
function releaseWakeLock() { try { wakeLock && wakeLock.release(); } catch (e) { } wakeLock = null; }

/* 窄屏（手机）判定：和 main.js 里 applyDevice 给 .ipad 加的 phone 类是同一套口径。
   小屏上底栏塞不下「⇄ 左右 / 📄 分页 / ▶ 自动播放」这些长文案，
   一长就把页码和 › 挤到屏幕外（用户看到的是「页数和左右键重叠」）。 */
function narrowBar() {
  const ip = $('ipad');
  return !!(ip && ip.classList.contains('phone'));
}

/* ============================================================
   工具栏显隐
   ============================================================ */
function showBars(v) {
  R.barsVisible = v;
  $('topBar').classList.toggle('hidden-up', !v);
  $('bottomBar').classList.toggle('hidden-down', !v);
  const dark = currentTheme().bar;
  $('topBar').classList.toggle('dark', dark);
  $('bottomBar').classList.toggle('dark', dark);
  document.getElementById('statusBar').classList.toggle('on-dark', dark && !v);
}
function toggleBars() { showBars(!R.barsVisible); if (R.barsVisible) resetBarTimer(); }

let _barTimer = null;
function resetBarTimer() {
  clearTimeout(_barTimer);
  _barTimer = setTimeout(() => {
    const drawerOpen = !!document.querySelector('.drawer.show');
    const sheetOpen = !$('noteSheet').hidden;
    if (!R.penMode && !drawerOpen && !R.autoTimer && !sheetOpen) showBars(false);
  }, 3200);
}

/* ============================================================
   主题与设置
   ============================================================ */
function currentTheme() {
  return THEMES.find(t => t.id === Settings.themeId) || THEMES[0];
}
/** 把选中的图片缩到最长边 maxSide 并转成 dataURL（存设置里，别让一张 8MB 原图拖垮同步）。 */
function shrinkImageFile(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('没有选中图片'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
        if (!w0 || !h0) throw new Error('图片尺寸读不出来');
        const k = Math.min(1, (maxSide || 1600) / Math.max(w0, h0));
        const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const cx = cv.getContext('2d');
        cx.imageSmoothingQuality = 'high';
        cx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(cv.toDataURL('image/jpeg', quality || 0.82));
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('不是浏览器认识的图片格式')); };
    img.src = url;
  });
}

/** 应用「界面背景」：底色 + 侧边栏色 + 背景图（透明度）。只碰书架页，阅读正文照旧。 */
/* ===========================================================
   R112 配色引擎：从一块「底色」派生整套界面颜色
   -----------------------------------------------------------
   底色是用户随手挑的（米色、护眼绿、夜蓝、灰…）。R111 只做到了「按明暗切两套
   常量」，色相始终是 iOS 蓝 —— 所以米色底上侧栏那三个按钮还是亮蓝（用户原话
   「导入文件夹和备份共享没变」），设置抽屉永远是一块白板，译文永远是 #0060DF
   的蓝字（夜间页上直接看不见）。这一版改成真·派生：
     · 强调色 = 底色的色相 + 提饱和度 + 亮度调到对该底对比 ≥ 4.6；
     · 面板 / 卡片 / 输入框 / 分割线 / 选中态 = 底色的同色系明暗位移，
       不再用黑白半透明往里掺（掺了会发灰，跟有彩底色对不上）；
     · 灰 / 白 / 黑这类无彩色底（饱和度 < 10%）不硬造色相，仍旧经典 iOS 蓝。
   全部返回 #RRGGBB，测试里可以直接比字符串。
   =========================================================== */
function uiHexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function uiRgbToHex(c) {
  return '#' + c.map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function uiRgbToHsl(c) {
  let r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}
function uiHslToRgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
/** WCAG 相对亮度（0=黑 1=白） */
function uiLum(hex) {
  const c = uiHexToRgb(hex);
  if (!c) return 1;
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
/** 两色对比度（1~21），与 R111 测试里的算法一致 */
function uiContrast(a, b) {
  const l1 = uiLum(a), l2 = uiLum(b);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
/** 以 bg 为底、按 a（0~1）混入 fg，得到不透明的合成色 */
function uiMixOn(bgHex, fgHex, a) {
  const b = uiHexToRgb(bgHex) || [255, 255, 255];
  const f = uiHexToRgb(fgHex) || [28, 28, 30];
  return uiRgbToHex([
    Math.round(b[0] + (f[0] - b[0]) * a),
    Math.round(b[1] + (f[1] - b[1]) * a),
    Math.round(b[2] + (f[2] - b[2]) * a)
  ]);
}
/** R131（第 2 条）：次级文字（灰字）按「底色 + 目标对比度」反算，而不是死写一个透明度。
 *  以前 fgDim 恒等于 rgba(fg,.62/.72)，落在彩色底、中等亮度底上就糊成一片
 *  （用户实测：共享面板里那行灰字在某些背景色下看不清）。
 *  这里从「最轻」开始逐档加重，取第一个达到 4.5:1 的实色；一档都不够就直接用前景色。
 *  bg 只传「最难读的那块」（深色主题传更亮的卡片底，浅色主题传更暗的面板底）。 */
function uiDimOn(bgHex, fgHex, dark) {
  const start = dark ? 0.72 : 0.62;
  for (let a = start; a <= 1.0001; a += 0.04) {
    const c = uiMixOn(bgHex, fgHex, Math.min(1, a));
    if (uiContrast(c, bgHex) >= 4.5) return c;
  }
  return fgHex;
}
/* ── 标注配色：跟着「阅读底」的明暗走 ────────────────────────────────
   同一句高亮，浅底和深底的正确做法是相反的：
   · 浅底：半透明彩色叠上去只是「淡黄」，正文仍是深色 → 0.42 刚好；
   · 深底：正文是浅色的。若还按 0.42 叠，调出来的是一块栗色 / 橄榄色（又暗又脏）；
     若干脆用不透明色（html 那条路之前写的就是纯 #FFE066），浅字直接看不见。
   所以深底改成「低不透明度 + 抬亮度」：像深色纸上一抹柔光，正文照样清楚。 */
let _readerDarkCache = null;
function readerIsDark() {
  if (_readerDarkCache == null) {
    let bg = '';
    try { bg = getComputedStyle(document.documentElement).getPropertyValue('--reader-bg').trim(); } catch (e) {}
    if (!bg) {
      const t = (typeof THEMES !== 'undefined' ? THEMES : []).find(x => x.id === Settings.themeId);
      bg = (t && t.bg) || (Settings.themeId === 'custom' ? Settings.customBg : '') || '#FFFFFF';
    }
    _readerDarkCache = uiLum(bg) < 0.35;
  }
  return _readerDarkCache;
}
function resetReaderDark() { _readerDarkCache = null; }

/** 高亮底色：浅底半透明；深底「抬亮度 + 低不透明度」，保证块上文字对比度够 */
function hlFill(hex) {
  const c = hex || '#FFE066';
  if (!readerIsDark()) return hexA(c, 0.42);
  const rgb = uiHexToRgb(c);
  if (!rgb) return hexA(c, 0.22);
  const [h, s] = uiRgbToHsl(rgb);
  // 亮度抬到 0.62（保住色相、压一点饱和）→ 叠深底后是一层柔和的色，不刺眼也不脏
  const lifted = uiRgbToHex(uiHslToRgb(h, Math.min(s, 0.85), 0.62));
  // 0.24 是「看得见」和「不压字」的平衡点：夜间合成到 #4A4329 左右，
  // 浅色正文的对比约 4.7；再浓一点就压不住字，再淡就看不见了。
  return hexA(lifted, 0.24);
}

/** 线类标记（下划线 / 删除线 / 波浪线）：深底上深蓝深红几乎融进背景，抬亮度 */
function hlLine(hex) {
  const c = hex || '#1C7ED6';
  if (!readerIsDark()) return c;
  const rgb = uiHexToRgb(c);
  if (!rgb) return c;
  const [h, s] = uiRgbToHsl(rgb);
  return uiRgbToHex(uiHslToRgb(h, Math.min(s, 0.9), 0.66));
}

/** 同色系明暗位移：只动 HSL 的 L（可选动 S），色相永远不变 */
function uiShade(hex, dl, ds) {
  const rgb = uiHexToRgb(hex);
  if (!rgb) return null;
  const [h, s, l] = uiRgbToHsl(rgb);
  const s2 = ds == null ? s : Math.max(0, Math.min(1, s + ds));
  const l2 = Math.max(0, Math.min(1, l + dl));
  return uiRgbToHex(uiHslToRgb(h, s2, l2));
}
/** 强调色：保住底色色相，提饱和度，再把亮度调到对底色对比 ≥ 4.6 */
function uiAccentOf(base, dark, mode) {
  const fallback = dark ? '#5AA9FF' : '#007AFF';
  if (mode === 'blue' || !base) return fallback;
  const rgb = uiHexToRgb(base);
  if (!rgb) return fallback;
  const hsl = uiRgbToHsl(rgb);
  // 灰 / 白 / 黑这类「看着是中性」的底不硬造色相：它们的 HSL 饱和度其实不低
  // （#F2F2F7 的 S≈0.24），按饱和度判断会派生出紫蓝，按钮一下变味。
  // 直接看 RGB 的彩度（max-min）更准：9/255 以内算中性（纯灰、iOS 灰底都在这条线内）；
  // 米黄 #F7F4EC 是 11 —— 刚好越过，所以阅读主题「米黄 / 羊皮」都是暖色强调色，
  // 不会一个蓝一个棕。
  const chroma = (Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2])) / 255;
  if (chroma < 0.035) return fallback;
  const h = hsl[0];
  const sat = dark
    ? Math.min(0.82, Math.max(0.56, hsl[1] * 1.5 + 0.32))
    : Math.min(0.74, Math.max(0.40, hsl[1] * 1.25 + 0.18));
  const step = dark ? 0.012 : -0.012;
  let l = dark ? 0.68 : 0.46;
  let best = fallback;
  // 目标定 5.0（WCAG AA 是 4.5）：强调色还要直接当文字压在 12% 的同一色淡底上
  // （正文译文块就是这么用的），淡底会把对比压掉 0.4 左右，留点余量才稳。
  for (let i = 0; i < 50; i++) {
    best = uiRgbToHex(uiHslToRgb(h, sat, l));
    if (uiContrast(best, base) >= 5.3) break;
    const next = l + step;
    if (next <= 0.06 || next >= 0.96) { l = Math.max(0.06, Math.min(0.96, next)); continue; }
    l = next;
  }
  return best;
}
/**
 * 一块底色 → 一整套界面色（书库、侧栏、设置抽屉、翻译面板共用同一套规则）。
 * 注意：hover / hover2 是「比底色深一点 / 浅一点」，而不是纯黑纯白的半透叠加 ——
 * 后者压在有彩底色上会发灰（用户问的「选择点开那一栏」就是它）。
 */
/* 同样的底色会被连问好几次（applyUiBg 里主区 / 侧栏 / 抽屉各问一遍，
   拖动滑块时每帧都问），按「底色+模式」缓存一下，省掉 HSL 往返。 */
const _palCache = new Map();
function uiPalette(base, mode) {
  const b = String(base || '#FFFFFF');
  const key = b + '|' + (mode || 'auto');
  if (_palCache.has(key)) return _palCache.get(key);
  const out = _uiPaletteCalc(b, mode);
  if (_palCache.size > 60) _palCache.clear();
  _palCache.set(key, out);
  return out;
}
function _uiPaletteCalc(b, mode) {
  const dark = uiLum(b) < 0.55;
  const baseRgb = uiHexToRgb(b) || [255, 255, 255];
  /* 提亮分两种算法（R113）：
     · 深色底：HSL 直接抬 L，余量充足，明暗层次最准；
     · 浅色底：改成「按比例掺白」。HSL 抬 L 在贴近白的底色上会一路抬成纯白 ——
       米黄页 #F7F4EC 只抬 3.5% 就变 #FFFEFE，色相 43.6° 直接归零，
       抽屉看着就是一块白板（R112 遗留的观感问题）。掺白能保住色相。
     压暗两种都是 HSL 减 L，不会撞天花板，不用分。 */
  const p = (dl) => {
    if (dl > 0 && !dark) {
      const r = Math.min(0.42, dl * 2.8);
      const mix = (i) => Math.round(baseRgb[i] + (255 - baseRgb[i]) * r);
      return uiRgbToHex([mix(0), mix(1), mix(2)]);
    }
    return uiShade(b, dl) || b;
  };
  const accent = uiAccentOf(b, dark, mode);
  const ar = uiHexToRgb(accent) || [0, 122, 255];
  const panelC = p(dark ? 0.035 : 0.05);    // 面板/抽屉底：比底色抬一层
  const cardC = p(dark ? 0.08 : 0.10);      // 卡片/输入框：再抬一层
  const fgC = dark ? '#EDEDED' : '#1C1C1E';
  return {
    base: b,
    dark: dark,
    accent: accent,
    accentFg: uiContrast('#FFFFFF', accent) >= 3 ? '#FFFFFF' : '#101014',
    accentSoft: 'rgba(' + ar.join(',') + ',.12)',
    accentSoft2: 'rgba(' + ar.join(',') + ',.20)',
    panel: panelC,
    card: cardC,
    field: p(dark ? 0.06 : -0.05),    // 控件底（凹一层）
    field2: p(dark ? 0.16 : 0.07),    // 控件里选中的那一块（凸一层）
    line: p(dark ? 0.16 : -0.14),     // 分割线
    hover: p(dark ? 0.06 : -0.045),   // 悬停
    hover2: p(dark ? 0.13 : -0.085),  // 选中/点开的那一栏
    scroll: p(dark ? 0.26 : -0.26),
    red: dark ? '#FF6B60' : '#FF3B30',   // 深底上 iOS 红（#FF3B30）偏暗，提亮一档
    fg: fgC,
    // R131（第 2 条）：灰字按对比度算出来。
    // R132：算的是「最难读的那块底」—— 深色主题下灰字会落在输入框 / 选中块上（比卡片还亮一层），
    // 浅色主题下会落在凹下去的控件底上（比面板还暗一层）。拿面板/卡片去算，
    // 这两处就刚好差一点点不达标（用户截图里共享密码那行灰字就是这么糊的）。
    fgDim: uiDimOn(dark ? p(0.16) : p(-0.05), fgC, dark)
  };
}
const _setVar = (el, k, v) => {
  if (v == null || v === '') el.style.removeProperty(k);
  else el.style.setProperty(k, v);
};
/** 把一套派生色写进某个元素（书库主区 / 侧栏）；pal 为 null 时全部清掉，回落主题原色 */
function applySurface(el, prefix, pal) {
  const put = (k, v) => _setVar(el, prefix + k, v);
  put('accent', pal && pal.accent);
  put('accent-fg', pal && pal.accentFg);
  put('accent-soft', pal && pal.accentSoft);
  put('accent-soft-2', pal && pal.accentSoft2);
  put('field', pal && pal.field);
  put('field-2', pal && pal.field2);
  put('line', pal && pal.line);
  put('hover', pal && pal.hover);
  put('hover-2', pal && pal.hover2);
  put('scroll', pal && pal.scroll);
  put('card-bg', pal && pal.card);
  put('border', pal && pal.line);
}
/**
 * 抽屉 / 浮层该跟哪块底色：
 *  · 在书里 → 阅读页底色（抽屉浮在书页上，跟书页统一才不刺眼，夜间主题也不会突然一块白）；
 *  · 在书库 → 界面背景色（没设过就返回空，一切回落到主题原色，外观零变化）。
 */
function uiPanelBase() {
  const rv = $('readerView');
  if (rv && rv.classList.contains('active')) {
    const rb = getComputedStyle(document.documentElement).getPropertyValue('--reader-bg').trim();
    if (rb) return rb;
  }
  return Settings.uiBg || '';
}
/**
 * 抽屉 / sheet（--ov-*）、设置抽屉（--set-*）、翻译面板 / 译文块（--tr-*）：
 * 同一块底，写三套前缀。
 * R113：目录 / 书签 / 笔记 / 查词 / OCR 这几个抽屉和笔记编辑、书籍菜单这些 sheet
 * 以前整套写死 --ios-*，夜间主题下打开就是一块白板；现在跟抽屉一样吃 --ov-*。
 */
function applySurfaceTheme(base) {
  const root = document.documentElement;
  const set = (k, v) => _setVar(root, '--set-' + k, v);
  const tr = (k, v) => _setVar(root, '--tr-' + k, v);
  const ov = (k, v) => _setVar(root, '--ov-' + k, v);
  if (!base) {
    ['bg', 'card', 'fg', 'fg-dim', 'line', 'field', 'field-2', 'accent', 'accent-fg', 'accent-soft', 'scroll']
      .forEach(k => set(k, null));
    ['panel', 'card', 'fg', 'fg-dim', 'line', 'field', 'accent', 'accent-fg', 'accent-soft']
      .forEach(k => tr(k, null));
    // 漏一个都会在「退回书架」后残留上次阅读算出的深色（--ov-* 挂在 :root 上）
    ['bg', 'card', 'fg', 'fg-dim', 'line', 'field', 'field-2', 'accent', 'accent-fg',
      'accent-soft', 'hover', 'hover-2', 'scroll', 'red']
      .forEach(k => ov(k, null));
    return;
  }
  const pal = uiPalette(base, Settings.uiAccentMode);
  set('bg', pal.panel);
  set('card', pal.card);
  set('fg', pal.fg);
  set('fg-dim', pal.fgDim);
  set('line', pal.line);
  set('field', pal.field);
  set('field-2', pal.field2);
  set('accent', pal.accent);
  set('accent-fg', pal.accentFg);
  set('accent-soft', pal.accentSoft);
  set('scroll', pal.scroll);
  tr('panel', pal.panel);
  tr('card', pal.card);
  tr('fg', pal.fg);
  tr('fg-dim', pal.fgDim);
  tr('line', pal.line);
  tr('field', pal.field);
  tr('accent', pal.accent);
  tr('accent-fg', pal.accentFg);
  tr('accent-soft', pal.accentSoft);

  /* 抽屉 / sheet：浮在书页上的那一层，比书页抬一档；
     控件底（输入框 / 标签芯片）比面板凹一层，选中 / 悬停走同色系明暗位移。 */
  ov('bg', pal.panel);
  ov('card', pal.card);
  ov('fg', pal.fg);
  ov('fg-dim', pal.fgDim);
  ov('line', pal.line);
  ov('field', pal.field);
  ov('field-2', pal.field2);
  ov('accent', pal.accent);
  ov('accent-fg', pal.accentFg);
  ov('accent-soft', pal.accentSoft);
  ov('hover', pal.hover);
  ov('hover-2', pal.hover2);
  ov('scroll', pal.scroll);
  ov('red', pal.red);
}

function applyUiBg() {
  const root = document.documentElement.style;
  // 没设过就不写变量：CSS 里 `var(--lib-bg, 原来的颜色)` 会回落到主题默认色，
  // 不然默认的浅灰会把白底阅读区一起染灰（用户没动设置却被改了外观）。
  if (Settings.uiBg) root.setProperty('--lib-bg', Settings.uiBg);
  else root.removeProperty('--lib-bg');
  if (Settings.uiSideBg) root.setProperty('--lib-sidebar-bg', Settings.uiSideBg);
  else root.removeProperty('--lib-sidebar-bg');

  const view = $('libraryView');
  const bg = $('libBg');
  if (!view || !bg) return;
  const rgba = (hex, a) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return 'rgba(255,255,255,' + a + ')';
    const v = parseInt(m[1], 16);
    return 'rgba(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ',' + a + ')';
  };
  const lumOf = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return 1;
    const v = parseInt(m[1], 16);
    return (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255;
  };
  const dark = Settings.uiBg ? lumOf(Settings.uiBg) < 0.55 : false;
  // 文字颜色：用户没单独选就按背景明暗自动取黑/白（否则深色背景下字会看不见）。
  // 只作用于书架主体与侧栏，不碰设置面板、抽屉和阅读正文。
  const fg = Settings.uiFg || (Settings.uiBg ? (dark ? '#EDEDED' : '#1C1C1E') : '');
  if (fg) {
    view.style.setProperty('--lib-fg', fg);
    view.style.setProperty('--lib-fg-dim', rgba(Settings.uiFg || (dark ? '#EDEDED' : '#5A5A5E'), dark ? 0.72 : 0.62));
  } else {
    view.style.removeProperty('--lib-fg');
    view.style.removeProperty('--lib-fg-dim');
  }

  /* ---- 侧边栏单独一套配色 ----
     侧栏可以单独选颜色，深浅可能和主区完全相反（浅色主页 + 深色侧栏）。
     这时如果沿用主区的文字色，侧栏上就是黑字压深底 —— 看不见。
     所以侧栏自己算一遍明暗：
       · 用户给了「侧边栏文字颜色」→ 就用他的；
       · 没给 → 看侧栏自己的深浅自动取黑/白；
       · 侧栏和主区深浅一致时沿用主区的字色（免得两边字体色微妙地不一样）。 */
  const sideBase = Settings.uiSideBg || Settings.uiBg;
  const sideDark = sideBase ? lumOf(sideBase) < 0.55 : false;
  const autoSideFg = sideBase ? (sideDark ? '#EDEDED' : '#1C1C1E') : '';
  let sideFg = Settings.uiSideFg || '';
  if (!sideFg) sideFg = (Settings.uiFg && sideBase && sideDark === dark) ? Settings.uiFg : autoSideFg;
  if (sideFg) {
    view.style.setProperty('--lib-side-fg', sideFg);
    view.style.setProperty('--lib-side-fg-dim',
      rgba(sideFg, sideDark ? 0.72 : 0.62));
  } else {
    view.style.removeProperty('--lib-side-fg');
    view.style.removeProperty('--lib-side-fg-dim');
  }
  // 有底图时两块面板要半透明才看得见图；半透明的「底」用用户选的背景色，
  // 而不是写死白色 —— 否则深色背景 + 图片会变成两块白板。
  const base = Settings.uiBg || '#FFFFFF';
  view.style.setProperty('--lib-main-bg', rgba(base, 0.55));
  view.style.setProperty('--lib-side-bg', rgba(base, 0.78));
  if (Settings.uiBgImg) {
    bg.style.backgroundImage = 'url("' + Settings.uiBgImg + '")';
    const a = Settings.uiBgAlpha == null ? 0.35 : Settings.uiBgAlpha;
    bg.style.opacity = String(Math.min(1, Math.max(0, a)));
    bg.hidden = false;
    view.classList.add('has-bg');
  } else {
    bg.hidden = true;
    bg.style.backgroundImage = '';
    bg.style.opacity = '0';
    view.classList.remove('has-bg');
  }
  view.classList.toggle('keep-side', !!Settings.uiSideBg);

  /* ---- 控件层：搜索框 / 排序 / 选择按钮 / 标签 / 批量条 / 侧栏那三个按钮 ----
     R112 起不再按「明暗两套常量」切，而是从各自底色现算（uiPalette）：
     米色底上强调色是深一点的赭色、护眼绿上是墨绿；控件底与选中态则是同色系的
     明暗位移，不再拿黑白半透明往里掺（掺了会发灰，跟有彩底色对不上）。
     没设底色时一套都不写，CSS 的 var(--lib-xxx, 原值) 会回落到主题原色 —— 外观零变化。 */
  applySurface(view, '--lib-',
    Settings.uiBg ? uiPalette(Settings.uiBg, Settings.uiAccentMode) : null);
  // 侧栏：按侧栏自己的底色单独算 —— 浅主页 + 深侧栏时，两边的强调色深浅必须各算一遍
  applySurface(view, '--lib-side-',
    sideBase ? uiPalette(sideBase, Settings.uiAccentMode) : null);

  /* ---- 抽屉 / 翻译面板：跟「当前压着的那块底」走 ----
     书库里跟界面背景，书里跟阅读页底色（夜间 / 纯黑主题下不再是刺眼的白板）。 */
  applySurfaceTheme(uiPanelBase());

  /* ---- 封面浓度 ----
     封面默认是「实心板」：底色渐变/分类色/扫描图会把背后的背景图整个挡住。
     调低 --lib-cover-a 只淡「板」本身（CSS 里 color-mix 掺透明 + img 的 opacity），
     书名、角标、星级按钮仍然是实心的，不影响点。
     cover-dim 类用于把封面白字的阴影加重 —— 半透明浅底上白字会糊。 */
  const covA = Settings.uiCoverAlpha == null ? 1 : Math.min(1, Math.max(0.05, Settings.uiCoverAlpha));
  if (covA >= 1) view.style.removeProperty('--lib-cover-a');
  else view.style.setProperty('--lib-cover-a', String(covA));
  view.classList.toggle('cover-dim', covA < 1);
}

/* R170：左右边距按**阅读区实际宽度**夹紧，最多 18%。
   以前直接写用户设的值：手机上拉到 140 时，390 宽的屏只剩 110px 正文，
   一行五个字（用户截图）。这里和 contentBox() 用同一个上限。
   单独抽成函数，是因为旋屏 / 拖窗后容器宽度变了要重算 ——
   否则横屏算出的 150px 带到竖屏，正文就只剩一条缝。 */
function applyReaderMetrics() {
  const st = document.documentElement.style;
  const c = $('readerContent');
  const mw = (c && c.clientWidth) || window.innerWidth || 360;
  st.setProperty('--reader-margin', Math.min(Settings.margin, Math.round(mw * 0.18)) + 'px');
}

function applySettings(full) {
  const t = currentTheme();
  const bg = t.id === 'custom' ? Settings.customBg : t.bg;
  const fg = t.id === 'custom' ? Settings.customFg : t.fg;
  const root = document.documentElement.style;
  root.setProperty('--reader-bg', bg);
  root.setProperty('--reader-fg', fg);
  // 换了底色，标注配色的「深浅」判断要重算；markdown 的 ==高亮== 也吃同一套规则
  resetReaderDark();
  root.setProperty('--md-mark', hlFill('#FFD60A'));
  root.setProperty('--reader-font', Settings.fontSize + 'px');
  root.setProperty('--reader-line', Settings.lineHeight);
  root.setProperty('--reader-letter', Settings.letterSpacing + 'px');
  root.setProperty('--reader-para', Settings.paraSpacing + 'em');
  /* R170：左右边距按阅读区宽度的 18% 夹紧（CSS 只认这个变量） */
  applyReaderMetrics();
  root.setProperty('--reader-align', Settings.align);
  // 两端对齐时让末行也两端对齐（否则末行默认左对齐，单段/短文看起来和左对齐没区别，修 #9）
  root.setProperty('--reader-align-last', Settings.align === 'justify' ? 'justify' : 'auto');
  root.setProperty('--reader-weight', Settings.bold ? '600' : '400');
  const f = FONTS.find(x => x.id === Settings.fontFamily) || FONTS[0];
  root.setProperty('--reader-family', f.css);

  applyUiBg();                 // 界面背景（书架 + 侧边栏）
  showBars(R.barsVisible);
  if (!R.book) return;
  // 富文本翻页模式：字号 / 行距 / 页边距等几何变化后必须重新分页，否则分页边界与
  // 页码映射陈旧、长段溢出错位（修 F4：缩放后锚定 / 分页错乱）。按当前滚动比例还原阅读位置。
  if (R.format === 'html' && Settings.htmlPaged && $('scrollInner') && $('scrollInner').querySelector('.html-book')) {
    // 重排前后都按「字符偏移」守恒：改字号/行距会让分页边界全变，用滚动百分比还原
    // 会偏出好几页（用户反馈的「调完字号位置就跑了」）。
    const keepOff = htmlCurrentOffset();
    layoutHtmlPages();
    assignHtmlOffsets();
    if (keepOff > 0) htmlScrollToOffset(keepOff);
    R.book && (R.book.htmlOff = keepOff);
  }
  if (R.format === 'txt') {
    if (Settings.direction === 'vertical') { renderScrollContent(); }
    else {
      /* 改字号/行距会让分页边界全变：页码不变等于「换了一页的字」。
         以前只把 pageIndex 夹在页数内 —— 用户正看着的那段文字跑到别的页去了，而手写笔迹
         按字符偏移锚定，也跟着跑到那页 → 看起来就是「一改字号字迹就没了」。
         所以按「当前页页首字符偏移」重新定位，读到哪里、写到哪里都留在眼前。 */
      const keepOff = (R.pages[R.pageIndex] && R.pages[R.pageIndex].start) || 0;
      R._layoutSig = ''; relayout();
      goToPage(pageIndexForOffset(keepOff), true);
    }
  } else if (R.format === 'pdf') {
    if ($('pdfStack')) pdfLazyRender();
  } else if (R.format === 'html') {
    // 富文本不重渲染（只改 CSS 变量），但高亮的颜色是**算出来写进 inline style** 的：
    // 切换主题后不重画，白天加的高亮到夜里还是那块亮黄板（用户实测「深色底下太亮」）。
    // paintHtmlHighlights() 是幂等的（先拆 mark 再按新底色重画），这里直接补一刀。
    try { paintHtmlHighlights(); } catch (e) {}
  }
  // 几何变化（字号/适应/布局/主题）后，笔迹画布要按当前页面盒重新匹配尺寸与位置，
  // 否则未开手写时笔迹仍画在旧尺寸上、与正文错位（修 #5/#6：缩放后字迹不对位）。
  bumpInkToken();   // 字号/行距/页边距变了 → 同一偏移的屏幕矩形变了，锚点索引重算
  if (R.penMode || R.format === 'txt' || R.format === 'html' || R.format === 'pdf') ink.resize();
}

/* ============================================================
   划词：高亮 / 笔记
   ============================================================ */
function globalOffsetOf(node, offset) {
  let el = node.nodeType === 3 ? node.parentElement : node;
  // 富文本（html/epub）内容渲染在 #scrollInner 内（非 #pageText），且块已带 data-off（修 #4）
  const root = (R.format === 'html' || Settings.direction === 'vertical') ? $('scrollInner') : $('pageText');
  while (el && el !== root && el.dataset.off === undefined) el = el.parentElement;
  if (!el || el.dataset.off === undefined) return null;
  const base = parseInt(el.dataset.off);
  const range = document.createRange();
  range.selectNodeContents(el);
  try { range.setEnd(node, offset); } catch (e) { return null; }
  return base + range.toString().length;
}

function handleSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideSelPopover(); return; }
  const range = sel.getRangeAt(0);
  let s, e;
  // 图片书（comic）识别出的透明文字层也是 .pdf-text-layer，锚点口径和 PDF 完全一致：
  // 只要选区落在任一文字层里就走 pdfPseudoOffset，别再按 txt 的 data-off 去 #pageText 里找
  // （图片书没有 #pageText，找不到就静默不出浮层 —— 用户会以为「图片不能划词」）。
  const selEl = range.commonAncestorContainer.nodeType === 1
    ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  const inTextLayer = !!(selEl && selEl.closest && selEl.closest('.pdf-text-layer'));
  if (R.format === 'pdf' || inTextLayer) {
    if (R.format === 'pdf') {
      const stack = $('pdfStack');
      if (!stack || !stack.contains(range.commonAncestorContainer)) { hideSelPopover(); return; }
    }
    s = pdfPseudoOffset(range.startContainer, range.startOffset);
    e = pdfPseudoOffset(range.endContainer, range.endOffset);
  } else {
    const startEl = (R.format === 'html' || Settings.direction === 'vertical') ? $('scrollInner') : $('pageText');
    if (!startEl.contains(range.commonAncestorContainer)) { hideSelPopover(); return; }
    s = globalOffsetOf(range.startContainer, range.startOffset);
    e = globalOffsetOf(range.endContainer, range.endOffset);
  }
  if (s === null || e === null || e <= s) { hideSelPopover(); return; }

  const rect = range.getBoundingClientRect();
  const host = $('readerContent').getBoundingClientRect();
  const pop = $('selPopover');
  pop.hidden = false;
  pop._range = { s, e, text: sel.toString() };
  pop._markId = null;          // 新划词 = 新建标记，不是编辑某条已有标记
  renderSelColors();
  // 浮层尺寸改为实测，避免样式变化后定位错位
  const pw = pop.offsetWidth || 240, ph = pop.offsetHeight || 96;
  let x = rect.left - host.left + rect.width / 2 - pw / 2;
  let y = rect.top - host.top - ph - 8;
  if (y < 8) y = rect.bottom - host.top + 8;
  x = Math.max(8, Math.min(Math.max(8, host.width - pw - 8), x));
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
  updateSelPopoverState();
  // 原文修订只对文本书开放
  syncEditRow();
}

/* 浮层内的颜色行 */
function renderSelColors() {
  const box = $('selColors');
  if (!box) return;
  const cur = window._hlColor || HL_COLORS[0];
  box.innerHTML = HL_COLORS.map(c =>
    `<button class="sel-color${c === cur ? ' sel' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`
  ).join('');
  box.querySelectorAll('[data-color]').forEach(n => n.onclick = (e) => {
    e.stopPropagation();
    window._hlColor = n.dataset.color;
    renderSelColors();
  });
}
function hideSelPopover() {
  // 刚套用样式后正文会重排、选区随之消失，此时不要关掉浮层，
  // 否则想叠加第二个样式就得重新选一次词
  if (R._keepPop) return;
  $('selPopover').hidden = true;
  // ⚠️ 不清 _range：换颜色 / 叠加样式时正文重排会把选区弄丢，
  // 若这里顺手把锚点也清了，用户下一次点样式按钮就会「没反应」（要先重新划词）。
  // _range 只在 handleSelection() 成功时被覆盖，切书时由 openBook → clearLayers 之后重设，
  // 保留它不会指向别的书（标注都按 bookId 过滤）。
}

/* 切换某个样式：已存在同范围同样式 → 移除；否则新增。
   浮层保持打开，可直接叠加多个样式，无需重新选词 */
async function toggleMarkStyle(style) {
  const r = $('selPopover')._range;
  if (!r) return;
  const color = window._hlColor || HL_COLORS[0];
  const ofStyle = R.annots.filter(a =>
    a.type === 'highlight' && (a.style || 'highlight') === style);
  // 判据顺序：① 完全同区间 → 就是这条；② 覆盖整段的已有标记 → 也算这条。
  // ② 很关键：点开一片已有标记（或划词范围刚好落在旧标记里）时，按钮要作用在
  // 那条**已有**标记上，而不是又新建一条几乎重叠的 —— 否则越点越叠（用户实测「重叠」）。
  const exact = ofStyle.filter(a => a.start === r.s && a.end === r.e);
  const cover = ofStyle.filter(a => a.start <= r.s && a.end >= r.e);
  // 「覆盖整段」只在**从已有标记点进来**（pop._markId 有值）时才当成同一条：
  // 普通划词时即使选区落在一段已有高光里，也应当**再加一条**（用户可能只想标更短的一段），
  // 否则一按高亮反而把原来的整段高光删掉。
  const editingExisting = !!$('selPopover')._markId;
  const same = exact.length ? exact : (editingExisting && cover.length ? [cover[0]] : []);
  // 同范围 + 同样式已存在时：
  //   · 颜色相同 → 再点一次 = 取消（旧行为）
  //   · 颜色不同 → **改色**（用户诉求：选另一种颜色应该生效，而不是把标记取消掉）
  const sameColor = same.length && same.every(a => (a.color || '') === color);
  let keptNote = 0;
  if (same.length && sameColor) {
    // ⚠️ R59：以前这里直接 Annot.remove —— 带笔记的标记一「取消样式」，
    //   写在上面的笔记也跟着没了（用户第 4 条：一条条点掉面板上的标记，笔记也消失）。
    //   现在带笔记的一条**保留**（笔记只能依附标记存在，去样式=去笔记），只清纯标记。
    const plain = same.filter(a => !(a.note && String(a.note).trim()));
    keptNote = same.length - plain.length;
    for (const a of plain) await Annot.remove(a.id);
    if (!plain.length) {
      // 一条都没删，别刷新成「已取消」误导用户
      toast('这 ' + keptNote + ' 条都写着笔记，已保留（要删请到「笔记」里逐条删）');
      R._keepPop = true;
      updateSelPopoverState();
      clearTimeout(R._keepPopT);
      R._keepPopT = setTimeout(() => { R._keepPop = false; }, 1200);
      return;
    }
  } else if (same.length) {
    // 改色：**原地改**（保留笔记/时间戳），删了重建会把笔记弄丢
    for (const a of same) { a.color = color; await Annot.add(a); }
  } else {
    await Annot.add({
      bookId: R.book.id, type: 'highlight',
      start: r.s, end: r.e, text: (r.text || '').slice(0, 200),
      color, style, createdAt: Date.now()
    });
  }
  R.annots = await Annot.list(R.book.id);
  R._keepPop = true;
  refreshPageContent();
  updateSelPopoverState();
  clearTimeout(R._keepPopT);
  R._keepPopT = setTimeout(() => { R._keepPop = false; }, 1200);
  const nm = (MARK_STYLES.find(s => s.id === style) || {}).name || '标记';
  toast(same.length && sameColor
    ? ('已取消' + nm + (keptNote ? '（' + keptNote + ' 条带笔记，已保留）' : ''))
    : (same.length ? '已改色·' + nm : '已' + nm + '（可继续叠加）'));
}

/** 按偏移取原文。
 *  ⚠️ R58 修：富文本（md/html/epub）以前用 `R.text` 切片，但标注偏移是**渲染后 DOM 的
 *  累积偏移**（`data-off`），两者口径根本不同（R.text 是 markdown 源，含 `![[Pasted image…]]`
 *  这类占位串，长度完全不一样）→ 取出来是隔壁的字。用户实测：编辑标记框里本该是「正例」
 *  「得化」，显示成「is」和一个私用区怪字符。现在统一从**渲染后的 DOM** 里按 data-off 取。 */
function domTextOfRange(s, e) {
  const roots = [document.querySelector('#scrollInner .html-book'), document.getElementById('pdfStack'),
    document.getElementById('imgLayer')];
  const blocks = [];
  for (const root of roots) {
    if (!root) continue;
    root.querySelectorAll('[data-off]').forEach(el => {
      if (el.querySelector('[data-off]')) return;      // 只取最内层叶子块，避免整段重复计
      const off = parseFloat(el.dataset.off);
      if (!isFinite(off)) return;
      const t = el.textContent || '';
      if (off + t.length > s && off < e) blocks.push({ off, t });
    });
    if (blocks.length) break;                          // 一本书只会有一种渲染结构
  }
  blocks.sort((a, b) => a.off - b.off);
  let out = '';
  for (const b of blocks) {
    const a0 = Math.max(0, s - b.off), a1 = Math.min(b.t.length, e - b.off);
    if (a1 > a0) out += b.t.slice(a0, a1);
  }
  return out;
}

function textOfRange(s, e) {
  try {
    if (R.format === 'txt') return String(R.text || '').slice(s, e).slice(0, 300);
    if (R.format === 'pdf' || R.format === 'comic') {
      // 优先用已缓存的整本文字（搜索时建好、口径与 data-off 一致）；
      // 没缓存时退回 DOM 提取 —— 以前这里直接返回空串，于是「再写一条」的引文全空。
      const i = Math.floor(s / 1e7);
      const t = (R._pdfText && R._pdfText[i]) || '';
      const sub = t.slice(s - i * 1e7, e - i * 1e7);
      if (sub) return sub.slice(0, 300);
      return domTextOfRange(s, e).slice(0, 300);
    }
    return domTextOfRange(s, e).slice(0, 300);
  } catch (err) { return ''; }
}

/** 把「点到的这片文字」上所有互相重叠的标记合并成一个区域 */
function markRegionAt(start, end) {
  const list = (R.annots || []).filter(a =>
    a.type === 'highlight' && !a.broken && a.end > start && a.start < end);
  if (!list.length) return null;
  let s = start, e = end;
  for (const a of list) { s = Math.min(s, a.start); e = Math.max(e, a.end); }
  return { s, e, list };
}

/**
 * 打开「区域标记编辑器」—— 和 TXT 版划词浮层完全一样的那一套。
 * 用户诉求（2026-10-21）：PDF/HTML 点已有标记时，只能改「点到的那一层」，
 * 没法像 txt 一样把整片区域的标记一起摆出来叠加（高光+下划线+波浪+粗体…）。
 * 做法：把这片区域所有重叠标记的区间并起来，当成一次「划词选区」喂给同一个浮层，
 * 于是样式按钮的回显（本段已有：…）、颜色、笔记、删除全都直接可用。
 */
function openMarkEditor(start, end, clientX, clientY) {
  const reg = markRegionAt(start, end);
  if (!reg) return false;
  const pop = $('selPopover');
  if (!pop) return false;
  pop._range = { s: reg.s, e: reg.e, text: textOfRange(reg.s, reg.e) };
  // 记下「这片区域的主标注」：浮层里点「笔记」时改这条，而不是又新建一条盖在旧标记上
  // 主标注：优先「已经带笔记」的那条（点笔记按钮就是继续编辑它），否则取最新的一条
  const primary = reg.list.slice().sort((x, y) =>
    ((y.note ? 1 : 0) - (x.note ? 1 : 0)) || ((y.createdAt || 0) - (x.createdAt || 0)))[0];
  pop._markId = primary ? primary.id : null;
  pop.hidden = false;
  renderSelColors();
  updateSelPopoverState();
  const host = $('readerContent').getBoundingClientRect();
  const pw = pop.offsetWidth || 240, ph = pop.offsetHeight || 96;
  let x = (clientX - host.left) - pw / 2;
  let y = (clientY - host.top) - ph - 14;
  if (y < 8) y = (clientY - host.top) + 20;
  x = Math.max(8, Math.min(Math.max(8, host.width - pw - 8), x));
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
  syncEditRow();
  // 这一次点击的 mouseup 别把它顺手关掉
  R._keepPop = true;
  clearTimeout(R._keepPopT);
  R._keepPopT = setTimeout(() => { R._keepPop = false; }, 600);
  return true;
}

/** 清除这一片上的所有标记（浮层里的「清除标记」按钮）
 *  ⚠️ R58：以前把这一片上的标注**全删**，连同写在标注上的笔记一起没了（用户问：
 *  「标记为下划线然后取消标记，笔记也跟着没了？」—— 是的，会丢）。现在带笔记的**保留**，
 *  只清纯标记；要连笔记一起删，去「笔记」面板里逐条删（那里有明确提示）。 */
async function clearMarkRegion() {
  const r = $('selPopover')._range;
  if (!r) return;
  const list = (R.annots || []).filter(a =>
    a.type === 'highlight' && a.end > r.s && a.start < r.e);
  if (!list.length) { toast('这一段没有标记'); return; }
  const hasNote = a => !!(a.note && String(a.note).trim());
  const plain = list.filter(a => !hasNote(a));
  const kept = list.filter(hasNote);
  for (const a of plain) await Annot.remove(a.id);
  R.annots = await Annot.list(R.book.id);
  R._keepPop = true;
  refreshPageContent();
  updateSelPopoverState();
  clearTimeout(R._keepPopT);
  R._keepPopT = setTimeout(() => { R._keepPop = false; }, 1200);
  renderNoteList();
  if (!plain.length) toast('这 ' + kept.length + ' 条都带笔记，已保留（要删请到「笔记」里逐条删）');
  else toast('已清除 ' + plain.length + ' 条标记' + (kept.length ? '；保留 ' + kept.length + ' 条带笔记的' : ''));
}

/* 保留旧接口名，内部走切换逻辑 */
async function addHighlight(color, style) {
  window._hlColor = color || window._hlColor || HL_COLORS[0];
  await toggleMarkStyle(style || 'highlight');
}

/* 浮层里回显：当前选区已有哪些样式 */
function updateSelPopoverState() {
  const r = $('selPopover')._range;
  if (!r) return;
  const mine = R.annots.filter(a =>
    a.type === 'highlight' && a.start < r.e && a.end > r.s);
  const has = new Set(mine.map(a => a.style || 'highlight'));
  document.querySelectorAll('#selMarks .sel-mark').forEach(b => {
    b.classList.toggle('has', has.has(b.dataset.style));
  });
  const tip = $('selTip');
  if (tip) {
    if (!mine.length) tip.textContent = '本段暂无标记';
    else {
      const withNote = mine.filter(a => a.note && String(a.note).trim()).length;
      tip.textContent = '本段已有：' + mine
        .map(a => (MARK_STYLES.find(s => s.id === (a.style || 'highlight')) || {}).name)
        .filter(Boolean).join('、')
        + (mine.length > 1 ? '（' + mine.length + ' 条标记' + (withNote ? '，' + withNote + ' 条带笔记' : '') + ' · 点「笔记」可逐条切换）' : '');
    }
  }
}

/* ============================================================
   Markdown 原文编辑（R59）
   ------------------------------------------------------------
   以前 .md 导入后只能看和标，改不了原文（浮层里的「修订原文」只对 TXT 开）。
   现在导入时把 Markdown 源码一起存进 content.md，阅读器里可以整篇编辑：
     保存 → 重新渲染正文 → 目录重建 → 已有的标记/笔记按**文字**重新落位。
   老版本导入的书没有源码，先用 Importer.htmlToMd() 从渲染结果反推一份当起点。
   ============================================================ */
function mdSourceOf(book) {
  const c = book && book.content;
  if (!c) return '';
  if (typeof c.md === 'string' && c.md.trim()) return c.md;
  return (typeof Importer !== 'undefined' && Importer.htmlToMd) ? Importer.htmlToMd(c.html || '') : '';
}

/** 把当前渲染出来的富文本按 data-off 口径拼成一条「全局文本」。
 *  必须和 assignHtmlOffsets() 用同一套规则（叶子块、按 off 排序、块间无分隔符），
 *  否则重定位会整体偏移 —— 这正是 R58「引文错位」踩过的坑。 */
function htmlGlobalText() {
  const root = document.querySelector('#scrollInner .html-book');
  if (!root) return '';
  const blocks = [];
  root.querySelectorAll('[data-off]').forEach(el => {
    if (el.querySelector('[data-off]')) return;
    const off = parseFloat(el.dataset.off);
    if (isFinite(off)) blocks.push({ off, t: el.textContent || '' });
  });
  if (!blocks.length) return '';
  blocks.sort((a, b) => a.off - b.off);
  let s = '';
  for (const b of blocks) {
    if (s.length < b.off) s += ' '.repeat(b.off - s.length);
    s = s.slice(0, b.off) + b.t + s.slice(b.off + b.t.length);
  }
  return s;
}

function updateMdCount() {
  const t = $('mdEditText'); if (!t) return;
  const box = $('mdEditCount');
  if (box) box.textContent = t.value.length + ' 字 · ' + t.value.split('\n').length + ' 行';
}

/* R60-2 / R61：Markdown 编辑器要能**一步一步**撤销，而且撤销后不能把画面甩到最后。
   做法：栈里存「状态快照」{ v, caret, top }（全文 + 光标 + 滚动位置），
   输入停 300ms 提交一步；回车 / 粘贴 / 删除选区这类结构性改动先断一步。
   撤销就弹一层：值和**当时的光标与滚动位置**一起恢复 —— 用户看到的是刚改的那一行，
   而不是编辑器末尾（R61 反馈「撤销后就默认跳到最后一页」就是这么来的）。 */
const MD_HIST_MAX = 80;
function mdSnap() {
  const ta = $('mdEditText');
  if (!ta) return { v: '', caret: 0, top: 0 };
  return { v: ta.value, caret: ta.selectionStart || 0, top: ta.scrollTop || 0 };
}
function mdHist(sheet) {
  if (!sheet._hist) sheet._hist = [{ v: sheet._orig || '', caret: 0, top: 0 }];
  return sheet._hist;
}
function pushMdHist() {
  const sheet = $('mdEditSheet'), ta = $('mdEditText');
  if (!sheet || !ta) return;
  const h = mdHist(sheet);
  const pre = sheet._pre;                      // 这一轮编辑开始前记下的光标/滚动
  sheet._pre = null;
  const s = mdSnap();
  if (pre) { s.caret = pre.caret; s.top = pre.top; }
  // 第一次提交时，顺手把「栈底（打开时的原文）」的位置也挪到编辑处 ——
  // 否则一路撤到原文会被送回顶部（用户刚在中间改，撤销后应该还在那一带）
  if (h.length === 1 && pre) { h[0].top = pre.top; h[0].caret = pre.caret; }
  const top = h[h.length - 1];
  if (top && top.v === s.v) { updateMdUndo(); return; }
  h.push(s);
  if (h.length > MD_HIST_MAX) h.shift();
  updateMdUndo();
}
function updateMdUndo() {
  const sheet = $('mdEditSheet'), btn = $('mdEditUndo'), ta = $('mdEditText');
  if (!sheet || !btn) return;
  const h = mdHist(sheet);
  const last = h[h.length - 1];
  // 当前输入还没入栈时也算「可撤销一步」
  const dirty = ta && last && ta.value !== last.v;
  const steps = Math.max(0, h.length - 1 + (dirty ? 1 : 0));
  btn.disabled = steps === 0;
  btn.textContent = steps ? ('↶ 撤销' + (steps > 1 ? ' ' + steps : '')) : '↶ 撤销';
  btn.title = steps ? ('每点一次退一步，共 ' + steps + ' 步可退（最后回到打开时的内容）')
    : '已经回到打开时的内容了';
}
function mdUndo() {
  const sheet = $('mdEditSheet'), ta = $('mdEditText');
  if (!sheet || !ta) return;
  const h = mdHist(sheet);
  // 先把「还没入栈的当前输入」压进去，保证撤销一次是回到上一个稳定状态
  if (h[h.length - 1].v !== ta.value) h.push(mdSnap());
  if (h.length < 2) { toast('已经回到打开时的内容了'); updateMdUndo(); return; }
  h.pop();                                     // 丢掉当前状态
  const prev = h[h.length - 1];
  ta.value = prev.v;
  sheet._pre = null;                           // 撤销本身不算一次编辑，别污染下一轮的位置
  const c = Math.max(0, Math.min(prev.caret || 0, prev.v.length));
  ta.selectionStart = ta.selectionEnd = c;
  // 先设一次，再在下一帧补一次：赋值后浏览器常把 caret 滚进视野（底部/顶部），会盖掉这里
  ta.scrollTop = prev.top || 0;
  requestAnimationFrame(() => {
    if (!sheet.hidden) ta.scrollTop = prev.top || 0;
  });
  updateMdCount(); updateMdUndo();
  const left = h.length - 1;
  toast(left ? ('已撤销一步，还能退 ' + left + ' 步') : '已撤销一步（回到打开时的内容）');
}

function openMdEditor() {
  const sheet = $('mdEditSheet'), ta = $('mdEditText');
  if (!sheet || !ta || !R.book) return;
  const src = mdSourceOf(R.book);
  ta.value = src;
  // R60-2：每次打开都从「这份原文」重新起一套撤销栈（栈底 = 打开时的原文 + 顶部）
  sheet._orig = src;
  sheet._hist = [{ v: src, caret: 0, top: 0 }];
  updateMdCount();
  updateMdUndo();
  $('mdEditTitle').textContent = '编辑 Markdown 原文 · ' + (R.book.title || '');
  const tip = $('mdEditTip');
  if (tip) {
    tip.textContent = (R.book.content && typeof R.book.content.md === 'string' && R.book.content.md.trim())
      ? '保存会重排正文和目录，已有的标记 / 笔记按文字自动重定位。'
      : '旧版导入的书没存源码，下面是从正文反推的：结构能还原，个别格式会简化。';
  }
  sheet.hidden = false;
  if (!sheet._bound) {
    sheet._bound = true;
    // 输入停 300ms 提交一步（连续打字算一步、一停一顿算一步，这样能「一次一次」退）
    let hTimer = 0;
    const commitSoon = (ms) => {
      clearTimeout(hTimer);
      hTimer = setTimeout(() => pushMdHist(), ms);
    };
    // R61：这一轮编辑**开始前**的光标/滚动位置，撤销时用它把画面停回原处
    ta.addEventListener('beforeinput', () => {
      if (!sheet._pre) sheet._pre = { caret: ta.selectionStart || 0, top: ta.scrollTop || 0, at: Date.now() };
    });
    ta.addEventListener('input', (e) => {
      updateMdCount();
      // 一口气打太久（>1.5s 不停）也强制断一步，否则长段输入只能整段一起撤
      if (sheet._pre && Date.now() - sheet._pre.at > 1500) pushMdHist();
      // 结构性改动（回车/粘贴/剪切/拖入）单独成一步，别和前面打的字合成一步
      const t = e.inputType || '';
      if (/insertParagraph|insertLineBreak|insertFromPaste|insertFromDrop|deleteByCut|deleteByDrag/.test(t)) {
        pushMdHist();
        commitSoon(300);
      } else {
        commitSoon(300);
      }
      updateMdUndo();
    });
    // 粘贴/剪切在 input 之前先断一步，撤销才能精确回到「粘之前」
    ta.addEventListener('paste', () => { clearTimeout(hTimer); pushMdHist(); });
    ta.addEventListener('cut', () => { clearTimeout(hTimer); pushMdHist(); });
    const undoBtn = $('mdEditUndo');
    if (undoBtn) undoBtn.onclick = () => { clearTimeout(hTimer); mdUndo(); };
    const close = () => { sheet.hidden = true; };
    $('mdEditClose').onclick = close;
    $('mdEditCancel').onclick = close;
    $('mdEditSave').onclick = async () => {
      const btn = $('mdEditSave');
      btn.disabled = true;
      try { await applyMdEdit(ta.value); sheet.hidden = true; }
      catch (e) { toast('保存失败：' + ((e && e.message) || e)); }
      finally { btn.disabled = false; }
    };
    // Tab 插入两个空格（纯文本编辑器的基本手感；iPad 外接键盘也用得上）
    ta.addEventListener('keydown', (e) => {
      // R60-2：Ctrl/⌘+Z 也走我们这套撤销栈，否则浏览器原生的撤销会和按钮不同步
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault(); clearTimeout(hTimer); mdUndo(); return;
      }
      // R61：回车前后各算一步，「撤销一次」才能把刚敲的那一行单独退掉
      if (e.key === 'Enter' && !e.isComposing) { clearTimeout(hTimer); pushMdHist(); return; }
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const s = ta.selectionStart, t = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(t);
      ta.selectionStart = ta.selectionEnd = s + 2;
      updateMdCount();
      clearTimeout(hTimer);
      pushMdHist();
    });
  }
  hideSelPopover();
  setTimeout(() => { ta.focus(); ta.setSelectionRange(0, 0); ta.scrollTop = 0; }, 60);
}

/** 保存 md 原文：重渲染 → 重建目录 → 标记/笔记按文字重新定位 */
async function applyMdEdit(nv) {
  const book = R.book;
  if (!book) return;
  const old = mdSourceOf(book);
  if (String(nv) === old) { toast('没有改动'); return; }
  // ① 改之前先把每条标注的引文按当前 DOM 校正一遍 —— 老数据可能存着错位的字，
  //    拿错的引文去重定位等于全丢。
  for (const a of (R.annots || [])) {
    if (a.type !== 'highlight') continue;
    const t = textOfRange(a.start, a.end);
    if (t) a.text = t;
  }
  // ② 重新解析 + 落库
  const md = Importer.mdToBook(nv, book.title || '');
  book.content = { kind: 'html', html: md.html, images: {}, md: String(nv) };
  book.length = md.html.length;
  book.chapters = md.chapters;
  book.tocDetected = true;
  book.tocCleared = false;
  book.totalPages = 1;
  book.srcExt = 'md';
  R.chapters = md.chapters;
  R._layoutSig = '';
  // ③ 重新渲染（走和打开书时同一条路径，目录/偏移才会一起更新）
  //    富文本有自己的一套（renderHtmlPage 重建 .html-book），relayout 只对 txt 有效 ——
  //    早先只调 relayout，于是保存成功、目录也换了，但正文还是旧的。
  if (R.format === 'html') renderHtmlPage();
  await new Promise(r => setTimeout(r, 40));
  // ④ 按文字重新定位：找离原位置最近的一次出现，整段找不到就逐段缩短（findAnchor）
  const plain = htmlGlobalText();
  let moved = 0, lost = 0;
  for (const a of (R.annots || [])) {
    if (a.type === 'highlight') {
      const t = a.text || '';
      const hit = t ? findAnchor(plain, t, a.start || 0) : null;
      if (hit) { a.start = hit.start; a.end = hit.start + t.length; a.broken = false; moved++; }
      else { a.broken = true; lost++; }
      await DB.put('annots', a);
    } else if (a.type === 'bookmark') {
      const loc = parseInt(a.locator, 10);
      if (isFinite(loc) && loc > plain.length) a.locator = String(Math.max(0, plain.length - 1));
      await DB.put('annots', a);
    }
  }
  await DB.put('books', book);
  R.annots = await Annot.list(book.id);
  refreshPageContent();
  renderNoteList();
  try { renderTocList(); } catch (e) { }
  updateChrome();
  toast('已保存' + (moved ? '，' + moved + ' 条标记已重新定位' : '')
    + (lost ? '；' + lost + ' 条找不到原位置（内容保留，可在笔记里「重新定位」）' : ''));
}

/* ============================================================
   原文修订（TXT 文本书 + Markdown）
   ------------------------------------------------------------
   标注、书签、目录全靠「字符偏移」定位，改动原文长度会让它们整体错位。
   因此这里做三件事：
     1) 偏移平移 —— 编辑点之后的所有偏移统一 +/- delta
     2) 冲突标记 —— 与编辑区有交集的标注标为 broken，保留内容不丢
     3) 可撤销  —— 每次修订前快照，可逐步回退（最多 20 步）
   TXT 走「选区改字」；Markdown 走整篇源码编辑（openMdEditor）。
   EPUB/Word 是固定排版文件（需重写源文件再重导入），PDF/漫画版面固定，暂不支持。
   ============================================================ */
const editStack = [];

/* 选区翻译：把选中的文字交给已配置的翻译引擎，结果在弹层展示。
   不限于文本书 —— PDF / 富文本划词、整段选中都能翻译（修 #12：和浏览器打开 PDF 一样）。 */
async function selTranslate() {
  const r = $('selPopover')._range;
  if (!r || !r.text) { toast('没有可翻译的选区'); return; }
  const sheet = $('translateSheet');
  const orig = $('transOriginal'), res = $('transResult');
  if (!sheet || !orig || !res) return;
  orig.textContent = r.text;
  res.textContent = '翻译中…';
  sheet.hidden = false;
  hideSelPopover();
  // 显示本次选区翻译使用的引擎，提醒用户：引擎在「翻译」面板里切换（默认 MyMemory 免密钥）
  const engTag = $('transEngineTag');
  if (engTag) {
    const p = (typeof InkTranslate !== 'undefined' && InkTranslate.activeProvider) ? InkTranslate.activeProvider() : null;
    engTag.textContent = p ? ('引擎：' + p.name) : '';
  }
  try {
    if (typeof InkTranslate === 'undefined' || !InkTranslate.translateParagraph)
      throw new Error('翻译模块未加载');
    const out = await InkTranslate.translateParagraph(r.text);
    res.textContent = (out && String(out).trim()) ? out : '（未返回译文，可能该引擎不支持此内容）';
  } catch (e) {
    res.textContent = '翻译失败：' + ((e && e.message) || e);
    toast('翻译失败：请先在「翻译」面板选择 / 配置翻译引擎');
  }
}

/* 「编辑原文 / 撤销修订」这一排：TXT 两个都给；Markdown 只给「编辑 Markdown 原文」
   （md 是整篇源码编辑，不走偏移平移那套，也就没有「撤销修订」）。 */
function syncEditRow() {
  const er = $('selEditRow');
  if (!er) return;
  const isMd = !!(R.book && R.book.srcExt === 'md');
  er.hidden = !(R.format === 'txt' || isMd);
  const undo = er.querySelector('[data-act="undo"]');
  if (undo) undo.hidden = isMd;
  const ed = er.querySelector('[data-act="edit"]');
  if (ed) ed.textContent = isMd ? '✎ 编辑 Markdown 原文' : '✎ 编辑原文';
}

function beginEditText() {
  // Markdown 走整篇源码编辑（选区改字会破坏 ** / # 等结构）
  if (R.book && R.book.srcExt === 'md') { openMdEditor(); return; }
  const r = $('selPopover')._range;
  if (!r) return;
  if (R.format !== 'txt') { toast('只有 TXT 文本书支持修订原文（EPUB/Word/PDF/漫画暂不支持）'); return; }
  showInput('编辑原文（可改字、删字、加字）', r.text, (v) => {
    if (v == null) return;
    applyTextEdit(r.s, r.e, v);
  });
}

async function applyTextEdit(s, e, replacement) {
  if (R.format !== 'txt') return;
  const old = R.text;
  if (s < 0 || e > old.length || e <= s) return;
  if (replacement === old.slice(s, e)) return;

  const delta = replacement.length - (e - s);
  // 快照里除了原文/标注，还要记下「改动点 + 长度差 + 时间」：
  // 撤销时要把**修订之后新加的**标注保留下来并按长度差回移（用户 R59 第 9 条：
  // 修订 A→AB，再标一段高光 C，一撤销连 C 也没了）。
  editStack.push({
    text: old,
    annots: JSON.parse(JSON.stringify(R.annots)),
    chapters: JSON.parse(JSON.stringify(R.chapters || [])),
    at: Date.now(), s, e, delta
  });
  if (editStack.length > 20) editStack.shift();

  R.text = old.slice(0, s) + replacement + old.slice(e);
  R.book.content.text = R.text;
  R.book.length = R.text.length;

  for (const a of R.annots) {
    if (a.type === 'bookmark') {
      const loc = parseInt(a.locator, 10);
      if (!isNaN(loc)) {
        if (loc >= e) a.locator = String(loc + delta);
        else if (loc > s) a.broken = true;
      }
      continue;
    }
    if (a.type !== 'highlight') continue;
    if (a.start >= e) { a.start += delta; a.end += delta; }
    else if (a.end <= s) { /* 在编辑区之前，不受影响 */ }
    else { a.broken = true; }        // 与编辑区有交集，无法可靠平移
  }
  for (const c of (R.chapters || [])) {
    if (c.offset >= e) c.offset += delta;
  }
  for (const a of R.annots) await DB.put('annots', a);
  R.book.chapters = R.chapters;
  await DB.put('books', R.book);

  R.book.locator = Math.max(0, s);
  R._layoutSig = '';
  relayout();
  if (Settings.direction === 'vertical') { renderScrollContent(); scrollToOffset(s); }
  else goToPage(pageIndexForOffset(s), true);
  hideSelPopover();
  updateChrome();
  const nBroken = R.annots.filter(a => a.broken).length;
  const base = delta === 0 ? '已修订原文' : `已修订原文（长度 ${delta > 0 ? '+' : ''}${delta}）`;
  if (nBroken) toast(`${base}；${nBroken} 个标记位置失效（内容已保留，可在笔记里「重新定位」）`);
  else toast(base);
}

/* ------------------------------------------------------------
   「失效」标记的处理
   ------------------------------------------------------------
   失效 = 原文在这个标记所在的位置被改动过，字符偏移已经对不上了。
   它的内容（原文片段 / 笔记）一条都没丢，只是不再画在正确的位置。
   处理办法：在改后的原文里重新找这段文字，取离原位置最近的一次出现。
   ------------------------------------------------------------ */
/* 在改后的原文里找回锚点：
   1) 先找完整原文片段，取离原位置最近的一次出现
   2) 若整段已被改写，就逐段缩短，找仍存在的最长连续片段做近似定位 */
function findAnchor(text, target, near) {
  if (!target) return null;
  const nearest = (sub) => {
    let bi = -1, bd = Infinity, j = text.indexOf(sub);
    while (j >= 0) { const d = Math.abs(j - near); if (d < bd) { bd = d; bi = j; } j = text.indexOf(sub, j + 1); }
    return bi;
  };
  let i = nearest(target);
  if (i >= 0) return { start: i, len: target.length, exact: true };

  const maxLen = Math.min(target.length - 1, 120);
  for (let len = maxLen; len >= 3; len--) {
    const step = Math.max(1, Math.floor((target.length - len) / 12));
    for (let s = 0; s + len <= target.length; s += step) {
      const k = nearest(target.substr(s, len));
      if (k >= 0) return { start: k, len, exact: false };
    }
  }
  return null;
}

async function relocateAnnot(id) {
  const a = R.annots.find(x => x.id === id);
  if (!a) return;
  if (!a.text) { toast('这条标记没存原文片段，只能手动删除或重新标记'); return; }
  const hit = findAnchor(R.text, a.text, a.start || 0);
  if (!hit) { toast('改后的原文里已经找不到这段文字了，只能手动重新标记或删除'); return; }
  a.start = hit.start;
  a.end = Math.min(hit.start + a.text.length, R.text.length);
  a.broken = false;
  await DB.put('annots', a);
  R.annots = await Annot.list(R.book.id);
  renderNoteList(); refreshPageContent();
  gotoAnnotOffset(a);
  toast(hit.exact ? '已重新定位到最近的一次出现' : '原文已被改写，按残留片段做了近似定位');
}

async function relocateBookmark(id) {
  const a = R.annots.find(x => x.id === id);
  if (!a) return;
  a.locator = String(R.book.locator || 0);
  // 富文本的书签靠 htmlOff（字符偏移）定位，改位置时这个字段必须一起改，
  // 否则「改到当前页」之后点它还是飞到老地方去。
  if (R.format === 'html') a.htmlOff = htmlCurrentOffset();
  a.pageIndex = R.pageIndex;
  a.excerpt = R.format === 'html'
    ? (htmlReadContext() || a.excerpt)
    : ((R.text || '').substr(parseInt(a.locator, 10) || 0, 40) || a.excerpt);
  a.broken = false;
  await DB.put('annots', a);
  R.annots = await Annot.list(R.book.id);
  renderMarkList(); updateChrome();
  toast('书签已改到当前页');
}

async function undoTextEdit() {
  const snap = editStack.pop();
  if (!snap) { toast('没有可撤销的修订'); return; }
  /* ⚠️ R59：以前直接「清空本书全部标注 → 重放快照」，于是**修订之后**新加的标记/笔记
   * （包括刚划的高光 C）全被一起抹掉 —— 用户第 9 条。现在把快照里没有的标注视为
   * 「修订后新增」，先按长度差把偏移反向平移，再和快照一起重放。 */
  const snapIds = new Set(snap.annots.map(a => a.id));
  const after = (R.annots || []).filter(a => !snapIds.has(a.id));
  for (const a of after) {
    if (a.type === 'highlight') {
      if (a.start >= snap.e) { a.start -= snap.delta; a.end -= snap.delta; }
      else if (a.end > snap.s) a.broken = true;           // 落在被改写的区间里，只能标失效
    } else if (a.type === 'bookmark') {
      const loc = parseInt(a.locator, 10);
      if (!isNaN(loc)) {
        if (loc >= snap.e) a.locator = String(loc - snap.delta);
        else if (loc > snap.s) a.broken = true;
      }
    }
  }
  R.text = snap.text;
  R.book.content.text = snap.text;
  R.book.length = snap.text.length;
  await Annot.removeBook(R.book.id);
  for (const a of snap.annots) await DB.put('annots', a);
  for (const a of after) await DB.put('annots', a);
  R.annots = await Annot.list(R.book.id);
  R.chapters = snap.chapters;
  R.book.chapters = R.chapters;
  await DB.put('books', R.book);
  R._layoutSig = '';
  relayout();
  if (Settings.direction === 'vertical') renderScrollContent();
  else goToPage(Math.min(R.pageIndex, R.totalPages - 1), true);
  updateChrome();
  toast('已撤销上一次修订' + (after.length ? '（保留 ' + after.length + ' 条后来的标记/笔记）' : ''));
}

/* ---------- 标记检视器：一次列出某个位置的所有标记 ---------- */
function openMarkInspector(off) {
  if (off == null) return;
  const all = R.annots.filter(a =>
    a.type === 'highlight' && a.start <= off && a.end > off)
    .sort((a, b) => a.start - b.start);
  const el = $('markSheetList');
  const box = $('markSheet');
  if (!el || !box) return;
  box._offset = off;

  if (!all.length) {
    el.innerHTML = '<div class="drawer-empty">这个位置没有标记</div>';
  } else {
    el.innerHTML = all.map(a => {
      const st = a.style || 'highlight';
      const nm = (MARK_STYLES.find(s => s.id === st) || {}).name || '标记';
      const sw = `<span class="mk-swatch" style="${markInlineStyle(st, a.color || HL_COLORS[0])}">A</span>`;
      return `
      <div class="mk-item" data-id="${a.id}">
        <div class="mk-item-head">
          ${sw}<b>${esc(nm)}</b>
          <span class="mk-item-range">${esc((a.text || '').slice(0, 24))}${a.text && a.text.length > 24 ? '…' : ''}</span>
        </div>
        ${a.note ? `<div class="mk-item-note">${esc(a.note)}</div>` : '<div class="mk-item-note empty">（无笔记）</div>'}
        <div class="mk-item-actions">
          <button data-edit="${a.id}">编辑笔记</button>
          <button data-goto="${a.start}">定位</button>
          <button class="danger" data-del="${a.id}">删除</button>
        </div>
      </div>`;
    }).join('');
  }

  el.querySelectorAll('[data-edit]').forEach(n => n.onclick = () => {
    const a = R.annots.find(x => x.id === n.dataset.edit);
    box.hidden = true;
    openNoteComposer(a);
  });
  el.querySelectorAll('[data-goto]').forEach(n => n.onclick = () => {
    box.hidden = true;
    const a = R.annots.find(x => String(x.start) === String(n.dataset.goto));
    gotoAnnotOffset(a);
  });
  el.querySelectorAll('[data-del]').forEach(n => n.onclick = async () => {
    await Annot.remove(n.dataset.del);
    R.annots = await Annot.list(R.book.id);
    refreshPageContent();
    renderNoteList();
    openMarkInspector(box._offset);
    toast('已删除标记');
  });

  box.hidden = false;
}

/* 同一片文字上可能叠着好几条笔记：「你好」做了一条、「好」又做了一条，
   甚至同一段再划一次又写一条。以前点文字只打开「最新那条」，其余完全看不到——
   用户的原话是「像栈一样，只能看到最上面的」。现在面板顶部把这片区域的标记全列出来，
   点哪条就编辑哪条，还能「在这一段再写一条」。 */
function notesInRegion(s, e) {
  return (R.annots || []).filter(a =>
    a.type === 'highlight' && !a.broken && a.end > s && a.start < e);
}

/** 列出「这一段的所有笔记」：≥1 条就显示 —— 新建笔记时也要能看见并就地管理这段已有的标记
 *  （用户 R58：不想为了删一条就退出面板再重进）。每行右侧带「✕」直接删，删完面板不关。 */
function renderNoteSheetList(payload) {
  const box = $('noteSheetList');
  if (!box) return;
  const list = notesInRegion(payload.start, payload.end);
  if (!list.length) { box.hidden = true; box.innerHTML = ''; return; }
  list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const stName = id => (MARK_STYLES.find(s => s.id === id) || MARK_STYLES[0]).name;
  box.hidden = false;
  box.innerHTML = '<div class="nl-title">这一段共有 ' + list.length + ' 条标记，点一条查看 / 编辑：</div>' +
    list.map((a, k) => {
      // 引文实时按偏移重算（老版本存错的口径能自动纠正），算不出来才用快照
      const pv = (textOfRange(a.start, a.end) || a.text || '').replace(/\s+/g, ' ').trim();
      return `
      <div class="nl-row${a.id === payload.id ? ' on' : ''}" data-ann="${a.id}">
        <span class="nl-i">${k + 1}</span>
        <span class="mk-swatch" style="${markInlineStyle(a.style || 'highlight', a.color || HL_COLORS[0])}">A</span>
        <span class="nl-text">${a.note ? esc(String(a.note).slice(0, 40)) : '<i>（无笔记）</i>'}</span>
        <span class="nl-sub">${esc(stName(a.style || 'highlight'))}${pv ? ' · ' + esc(pv.slice(0, 12)) : ''}</span>
        <button class="nl-del" data-del-ann="${a.id}" title="删掉这一条标记${a.note ? '（含笔记）' : ''}">✕</button>
      </div>`;
    }).join('') +
    '<div class="nl-add" id="noteAddAnother">＋ 在这一段再写一条（不会覆盖上面的）</div>';
  box.querySelectorAll('.nl-row[data-ann]').forEach(n => n.onclick = () => {
    const a = (R.annots || []).find(x => x.id === n.dataset.ann);
    if (a) bindNoteSheet(a);
  });
  box.querySelectorAll('[data-del-ann]').forEach(n => n.onclick = async (ev) => {
    ev.stopPropagation();                       // 别顺手把整行的「切换编辑」也触发了
    const id = n.dataset.delAnn;
    const cur = $('noteSheet')._payload || {};
    await Annot.remove(id);
    R.annots = await Annot.list(R.book.id);
    refreshPageContent();
    renderNoteList();
    if (cur.id === id) {
      // 正在编辑的就是被删那条 → 回到「新建」态，面板留在原地
      bindNoteSheet({ start: payload.start, end: payload.end, text: payload.text,
        note: '', style: 'highlight', color: HL_COLORS[0] });
    } else {
      renderNoteSheetList($('noteSheet')._payload || payload);
    }
    toast('已删除这一条');
  });
  const add = $('noteAddAnother');
  if (add) add.onclick = () => {
    // 新区间 = 这一段的合并区间；保存时是新建一条，不动已有的
    const s = Math.min(...list.map(a => a.start));
    const e = Math.max(...list.map(a => a.end));
    bindNoteSheet({ start: s, end: e, text: textOfRange(s, e), note: '', style: 'highlight', color: HL_COLORS[0], fromList: true });
    $('noteText').value = '';
    $('noteText').focus();
  };
}

/** R131（第 3 条）：笔记面板「取消 / 完成」那个按钮要**实时**反映有没有未保存的改动。
 *  —— 以前文案是打开面板那一刻按 id 定死的，用户改了字、换了颜色它也不变，
 *  于是「明明还没存，却显示完成」，点下去还以为存上了。 */
function noteSheetSnapshot(p) {
  return {
    note: String((p && p.note) || ''),
    style: (p && p.style) || 'highlight',
    color: (p && p.color) || HL_COLORS[0]
  };
}
function noteSheetDirty(p) {
  const sheet = $('noteSheet');
  p = p || (sheet && sheet._payload);
  if (!p) return false;
  if (!p.id && !p.saved) return true;                 // 新标记：一次都还没存
  const s = p._snap || noteSheetSnapshot(p);
  const ta = $('noteText');
  const txt = ((ta && ta.value) || '').trim();
  if (txt !== String(s.note || '')) return true;      // 写了 / 删了字没存
  if ((p.style || 'highlight') !== s.style) return true;   // 换了样式没存
  if ((p.color || '') !== (s.color || '')) return true;    // 换了颜色没存
  return false;
}
function refreshNoteBtnLabel(p) {
  const b = $('noteCancel');
  if (!b) return;
  b.textContent = noteSheetDirty(p) ? '取消' : '完成';
}

/** 把「要编辑的那条」绑定到笔记面板：引文、正文、样式回显、删除按钮、笔记列表 */
function bindNoteSheet(payload) {
  const sheet = $('noteSheet');
  if (!sheet || !payload) return;
  sheet._payload = payload;
  // 引文按偏移**实时重算**：老版本有的书把 text 存成了错位的字（R58 用户反馈
  // 「该是正例/得化，显示成 is 和怪字符」），重算能自动纠正；算不出来才退回快照。
  const live = (payload.start != null && payload.end != null) ? textOfRange(payload.start, payload.end) : '';
  $('noteQuote').textContent = String(live || payload.text || '').slice(0, 300);
  $('noteText').value = payload.note || '';
  // R59：不管是新写还是编辑，都走同一个完整面板（样式/颜色/只加标记/删除/这段已有列表）。
  // R60：标题也统一成「编辑标记 · 笔记」—— 用户明确要求：前面这段没有标记或笔记时，
  // 也该直接是「编辑标记 · 笔记」框，而不是另起一个叫「标记与笔记」的面板。
  $('noteSheetTitle').textContent = '编辑标记 · 笔记';
  // 「取消 / 完成」是同一个按钮，文案随「有没有未保存的改动」实时变（R131 第 3 条）：
  // 有新改动（新标记还没存、或文字/样式改过没存）→「取消」（点掉 = 放弃这些改动）；
  // 已经存过 →「完成」（点掉 = 关面板）。
  payload._snap = noteSheetSnapshot(payload);
  refreshNoteBtnLabel(payload);
  const ta0 = $('noteText');
  if (ta0 && !ta0._r131Bound) {
    ta0._r131Bound = true;
    ta0.addEventListener('input', () => refreshNoteBtnLabel());
  }
  const del = $('noteDelete');
  if (del) {
    del.hidden = !payload.id;
    del.onclick = async () => {
      const p = $('noteSheet')._payload;
      if (!p || !p.id) return;
      await Annot.remove(p.id);
      R.annots = await Annot.list(R.book.id);
      $('noteSheet').hidden = true;
      refreshPageContent(); renderNoteList();
      toast('已删除');
    };
  }
  // R130（第 3 条）：原来的「只加标记」和「存储」合并成一个动作 ——
  // 写了笔记就是存笔记，没写就是「只加个标记」。面板上这个按钮已经撤掉（index.html 里 hidden），
  // 这里只留一个等价绑定，旧缓存页面点到它也不会再冒出「这一段已经有同样的标记了」。
  const only = $('noteMarkOnly');
  if (only) only.onclick = () => { saveNote(); };
  renderNoteStylePicker(payload.style || 'highlight', payload.color || HL_COLORS[0]);
  previewNoteMark();
  renderNoteSheetList(payload);
}

function openNoteComposer(hl) {
  const pop = $('selPopover');
  let payload = hl || null;
  if (!payload) {
    const r = pop._range;
    if (!r) return;
    payload = { start: r.s, end: r.e, text: String(r.text || '').slice(0, 200) };
  }
  bindNoteSheet(payload);
  $('noteSheet').hidden = false;
  hideSelPopover();
  window.getSelection().removeAllRanges();
  setTimeout(() => $('noteText').focus(), 60);
}

/* 笔记面板里的「样式 + 颜色」选择器 */
function renderNoteStylePicker(style, color) {
  const sBox = $('noteStyles'), cBox = $('noteColors');
  if (!sBox || !cBox) return;
  sBox.innerHTML = MARK_STYLES.map(s =>
    `<button class="mk-pick${s.id === style ? ' sel' : ''}" data-style="${s.id}">
       <i class="mk-ico mk-ico-${s.ico}"></i>${s.name}</button>`).join('');
  cBox.innerHTML = HL_COLORS.map(c =>
    `<button class="sel-color${c === color ? ' sel' : ''}" data-color="${c}" style="background:${c}"></button>`).join('');

  sBox.querySelectorAll('[data-style]').forEach(n => n.onclick = () => {
    const p = $('noteSheet')._payload;
    if (p) p.style = n.dataset.style;
    renderNoteStylePicker(n.dataset.style, $('noteSheet')._payload.color || HL_COLORS[0]);
    previewNoteMark();
    refreshNoteBtnLabel();                 // 换了样式也算「未保存的改动」
  });
  cBox.querySelectorAll('[data-color]').forEach(n => n.onclick = () => {
    const p = $('noteSheet')._payload;
    if (p) p.color = n.dataset.color;
    renderNoteStylePicker($('noteSheet')._payload.style || 'highlight', n.dataset.color);
    previewNoteMark();
    refreshNoteBtnLabel();
  });
}

/* 实时把当前样式套到引文上 */
function previewNoteMark() {
  const p = $('noteSheet')._payload;
  const q = $('noteQuote');
  if (!p || !q) return;
  q.setAttribute('style', markInlineStyle(p.style || 'highlight', p.color || HL_COLORS[0]));
}

async function saveNote() {
  const p = $('noteSheet')._payload;
  if (!p) return;
  const txt = $('noteText').value.trim();
  const wasNew = !p.id;
  const st = p.style || 'highlight';
  const cl = p.color || HL_COLORS[0];
  // R130（第 3 条）：不再要求「先写点什么」—— 空笔记就是「只加个标记」，一次「存储」搞定。
  // 同时按「同区间 + 同样式 + 同颜色」判重：命中就更新那一条（有笔记才写笔记），
  // 不再弹「这一段已经有同样的标记了」，也不会堆出两条一模一样的标记。
  // 用户遇到的怪流程是：先给某段加了笔记 → 编辑时把文字删了 → 点标记再点只加标记 → 报已有，
  // 根子就是这里把「同一条标记」当成了重复的新增。
  if (p.id) {
    p.note = txt;
    p.style = st;
    p.color = cl;
    await DB.put('annots', p);
  } else {
    // 判重一定要查一遍最新库存：R.annots 是「进书那会儿」的快照，
    // 服务端同步（sync.js）晚一步补下来的标注不在里面，只认快照就会判不出重复、
    // 每次存储都多一条一模一样的标记（R130 实测）。
    let pool = null;
    try { pool = await Annot.list(R.book.id); } catch (e) { pool = null; }
    if (!Array.isArray(pool)) pool = R.annots || [];
    const same = pool.find(a => a.type === 'highlight' && !a.broken &&
      a.start === p.start && a.end === p.end &&
      (a.style || 'highlight') === st && (a.color || '') === cl);
    if (same) {
      // 命中已有标记：只更新笔记（空输入不清掉原来写好的笔记）
      if (txt || !same.note) same.note = txt || same.note || '';
      same.text = p.text || same.text || '';
      same.start = p.start; same.end = p.end;
      await DB.put('annots', same);
    } else {
      await Annot.add({
        bookId: R.book.id, type: 'highlight',
        start: p.start, end: p.end, text: p.text,
        color: cl, style: st,
        note: txt, createdAt: Date.now()
      });
    }
  }
  R.annots = await Annot.list(R.book.id);
  refreshPageContent();
  renderNoteList();
  if (wasNew) {
    // R59：新建的笔记保存后**一律不关面板**（用户第 6 条：正常保存也会关，很不方便）。
    // 面板留在原地、输入框清空、标题回到「可继续写」，想退出点「完成」。
    // （R58 只在「＋ 在这一段再写一条」时这样，普通入口仍然保存即关。）
    bindNoteSheet({
      start: p.start, end: p.end,
      text: textOfRange(p.start, p.end) || p.text,
      note: '', style: st, color: cl,
      fromList: true, saved: true          // saved → 关闭按钮显示「完成」
    });
    $('noteSheet').hidden = false;
    $('noteText').value = '';
    $('noteText').focus();
    toast(txt ? '已保存，可继续写；点「完成」退出' : '已加标记（没写笔记）；点「完成」退出');
    return;
  }
  $('noteSheet').hidden = true;
  toast(txt ? '笔记已保存' : '标记已更新');
}

/** 笔记面板右下那个按钮：有新改动 = 「取消」（点掉 = 放弃这些改动，什么都不写）；
 *  已经存过且没再改 = 「完成」（点掉 = 关面板）。文案由 noteSheetDirty() 实时算。 */
async function finishNoteSheet() {
  const sheet = $('noteSheet');
  if (!sheet) return;
  const dirty = noteSheetDirty();
  sheet.hidden = true;
  if (!dirty) return;
  // 「取消」语义：库里一个字都不动，把界面恢复成真实状态（预览 / 列表可能已经被新样式改过）
  try { R.annots = await Annot.list(R.book.id); } catch (e) { }
  try { refreshPageContent(); } catch (e) { }
  try { renderNoteList(); } catch (e) { }
  toast('已取消，没保存这次改动');
}

/** R131（第 7/8 条）：把「正在读的这本」从库里重新读一遍（目录 / 标注 / 收藏位）。
 *  共享补齐、备份恢复这类「在别处改过这本书」的操作之后必须调一次 ——
 *  阅读器手里是进书那一刻的快照，不重读的话，补进去的笔记和章节一个都不会显示，
 *  用户看到的就是「勾了也共享不过来 / 补齐像没补」。 */
async function reloadOpenedBook() {
  if (!R || !R.book || !R.book.id) return;
  let b = null;
  try { b = await DB.get('books', R.book.id); } catch (e) { b = null; }
  if (b) {
    R.book.chapters = Array.isArray(b.chapters) ? b.chapters : [];
    R.chapters = R.book.chapters.slice();
    R.book.fav = !!b.fav;
  }
  R.annots = await Annot.list(R.book.id);
  try { refreshPageContent(); } catch (e) { }
  try { renderNoteList(); } catch (e) { }
  try { if (typeof renderTocList === 'function') renderTocList(); } catch (e) { }
  try { updateChrome(); } catch (e) { }
}

function refreshPageContent() {
  if (R.format === 'txt') {
    if (Settings.direction === 'vertical') renderScrollContent();
    else renderPage();
    return;
  }
  if (R.format === 'pdf') {
    // PDF 加高光 / 标记后需重绘当前页，文字层重新构建才会把高光 / 下划线渲染出来
    // （修 #8：之前非 txt 直接 return，导致 PDF 划完高光页面上看不到）。
    if (typeof renderPage === 'function') renderPage();
    // 已渲染过的页 pdfLazyRender 会跳过，不会重建文字层 → 新加的高亮画不出来，
    // 这里对可见页单独重新上色（修 #12 残余：会话内现加高亮不显示）。
    repaintPdfHighlights();
    return;
  }
  // html：重画高光即可，不重排、不动滚动位置
  if (R.format === 'comic') {
    // 图片书加高光 / 下划线后：文字层不重建（词框没变），只把标记带重画一遍
    repaintImgHighlights();
    scheduleImgLayerSync();
    return;
  }
  if (typeof paintHtmlHighlights === 'function') paintHtmlHighlights();
}

/* ============================================================
   书签 / 笔记 / 目录 列表
   ============================================================ */
async function toggleBookmark() {
  const key = R.book.locator;
  // 富文本的 locator 是「滚动百分比 / 页码比例」，一换阅读形态就不是同一个数了，
  // 拿它判重会出现「明明这页有书签，却提示可以再添加」。改用字符偏移（±80 字符内算同一处）。
  const curOff = R.format === 'html' ? htmlCurrentOffset() : null;
  const exist = R.annots.find(a => a.type === 'bookmark' && (
    (curOff != null && a.htmlOff != null && Math.abs(parseInt(a.htmlOff, 10) - curOff) < 80)
    || String(a.locator) === String(key)
  ));
  if (exist) {
    await Annot.remove(exist.id);
    R.annots = await Annot.list(R.book.id);
    toast('已移除书签');
  } else {
    let excerpt = '';
    if (R.format === 'txt') {
      const off = parseInt(key) || 0;
      excerpt = R.text.substr(off, 46).replace(/\s+/g, ' ').trim();
    } else if (R.format === 'html') {
      excerpt = htmlReadContext();
    } else {
      excerpt = `第 ${R.pageIndex + 1} 页`;
    }
    await Annot.add({
      bookId: R.book.id, type: 'bookmark', locator: key,
      htmlOff: curOff, pageIndex: R.pageIndex, excerpt, createdAt: Date.now()
    });
    R.annots = await Annot.list(R.book.id);
    toast('已添加书签');
  }
  renderMarkList();
}

/** 书签定位：按书的格式挑正确的偏移口径。
    以前一律走 gotoLocator(locator) —— html 下把「滚动百分比」当百分比还好，
    但 html 的 locator 在翻页模式是「页码比例」，两种形态互相换算必然错位，
    于是「书签在 A 页，切模式后点它跳到别处」。现在优先用字符偏移。 */
function gotoBookmark(b) {
  if (!b) return;
  if (R.format === 'html') {
    const off = parseInt(b.htmlOff, 10);
    if (!isNaN(off) && off >= 0 && b.htmlOff != null) htmlScrollToOffset(off);
    else gotoLocator(b.locator);
  } else if (R.format === 'txt') {
    const off = parseInt(b.locator, 10) || 0;
    if (Settings.direction === 'vertical') scrollToOffset(off);
    else goToPage(pageIndexForOffset(off));
  } else {
    goToPage(parseInt(b.locator, 10) || 0);
  }
  closeDrawers();
}

function renderMarkList() {
  const list = R.annots.filter(a => a.type === 'bookmark')
    .sort((a, b) => (a.pageIndex || 0) - (b.pageIndex || 0));
  const el = $('markList');
  const curOff = R.format === 'html' ? htmlCurrentOffset() : null;
  const has = R.annots.some(a => a.type === 'bookmark' && (
    (curOff != null && a.htmlOff != null && Math.abs(parseInt(a.htmlOff, 10) - curOff) < 80)
    || String(a.locator) === String(R.book.locator)
  ));
  const addBtn = `<div class="drawer-add${has ? ' remove' : ''}" id="addMarkBtn">${has ? '✕ 移除当前页书签' : '＋ 添加当前页书签'}</div>`;

  if (!list.length) {
    el.innerHTML = addBtn + '<div class="drawer-empty">还没有书签<br>点上方按钮把当前页加入书签</div>';
  } else {
    el.innerHTML = addBtn + list.map(b => `
    <div class="list-item${b.broken ? ' is-broken' : ''}" data-bm="${b.id}">
      <div class="li-main">
        <div>${esc(b.excerpt || '(无摘要)')}</div>
        <div class="li-sub">${b.pageIndex != null ? '第 ' + (b.pageIndex + 1) + ' 页 · ' : ''}${new Date(b.createdAt).toLocaleString('zh-CN')}${
          b.broken ? '<span class="li-badge" title="原文在这条书签的位置被改动过">⚠ 失效</span>' : ''}</div>
      </div>
      <div class="li-acts">${b.broken ? '<button class="li-fix" data-fixbm="' + b.id + '">改到当前页</button>' : ''}<button class="li-del" data-del="${b.id}">删除</button></div>
    </div>`).join('');
  }

  el.querySelectorAll('[data-fixbm]').forEach(n => n.onclick = async (e) => {
    e.stopPropagation();
    await relocateBookmark(n.dataset.fixbm);
  });

  const add = document.getElementById('addMarkBtn');
  if (add) add.onclick = async () => { await toggleBookmark(); renderMarkList(); updateChrome(); };

  el.querySelectorAll('[data-bm]').forEach(n => n.onclick = (e) => {
    if (e.target.dataset.del) return;
    gotoBookmark(list.find(x => String(x.id) === n.dataset.bm));
  });
  el.querySelectorAll('[data-del]').forEach(n => n.onclick = async (e) => {
    e.stopPropagation();
    await Annot.remove(n.dataset.del);
    R.annots = await Annot.list(R.book.id);
    renderMarkList(); updateChrome();
  });
}

function renderNoteList() {
  const list = R.annots.filter(a => a.type === 'highlight')
    .sort((a, b) => a.start - b.start);
  const el = $('noteList');
  if (!list.length) { el.innerHTML = '<div class="drawer-empty">还没有标记<br>拖选文字后选择「高亮 / 下划线 / 删除线 / 波浪线 / 粗体」</div>'; return; }

  const stName = id => (MARK_STYLES.find(s => s.id === id) || MARK_STYLES[0]).name;
  el.innerHTML = list.map(h => {
    const st = h.style || 'highlight';
    const sw = `<span class="mk-swatch" style="${markInlineStyle(st, h.color || HL_COLORS[0])}">A</span>`;
    const badge = h.broken
      ? '<span class="li-badge" title="原文在这条标记的位置被改动过，位置已不可靠（内容仍保留）">⚠ 失效</span>' : '';
    const reloc = h.broken ? '<button class="li-fix" data-fix="' + h.id + '">重新定位</button>' : '';
    return `
    <div class="list-item${h.broken ? ' is-broken' : ''}" data-goto="${h.start}" data-id="${h.id}">
      <div class="li-main">
        <div class="li-note">${h.note ? esc(h.note) : '<span style="color:var(--ios-gray);font-weight:400">（无笔记）</span>'}</div>
        <div class="li-quote">${sw}${esc((h.text || '').slice(0, 80))}</div>
        <div class="li-sub">${stName(st)}${badge} · ${new Date(h.createdAt).toLocaleString('zh-CN')}</div>
      </div>
      <div class="li-acts">${reloc}<button class="li-del" data-del="${h.id}">删除</button></div>
    </div>`;
  }).join('');
  el.querySelectorAll('[data-fix]').forEach(n => n.onclick = async (e) => {
    e.stopPropagation();
    await relocateAnnot(n.dataset.fix);
  });
  el.querySelectorAll('[data-goto]').forEach(n => n.onclick = (e) => {
    if (e.target.dataset.del) return;
    const h = list.find(x => String(x.id) === n.dataset.id);
    // ⚠️ 这里原先是 gotoLocator(h.start)：html 书的 start 是**字符偏移**（动辄上万），
    // 而 gotoLocator 的 html 分支把它当**滚动百分比**（clamp 到 1）→ 一点笔记就跳到书末页。
    // 走 gotoAnnotOffset 才会按格式选对口径（html=data-off 块、txt=字符偏移、pdf=伪偏移）。
    if (h) gotoAnnotOffset(h); else gotoLocator(n.dataset.goto);
    closeDrawers();
    if (h) setTimeout(() => openNoteComposer(h), 120);
  });
  el.querySelectorAll('[data-del]').forEach(n => n.onclick = async (e) => {
    e.stopPropagation();
    await Annot.remove(n.dataset.del);
    R.annots = await Annot.list(R.book.id);
    renderNoteList(); refreshPageContent();
  });
}

let tocCollapsed = new Set();   // 已折叠的父章节索引（lv1 项）
let tocSelectMode = false;      // 目录多选（删除）模式
let tocChecked = new Set();     // 多选选中的章节索引
let tocRoot = -1;               // 目录「当前根」章节索引；-1 = 显示全书（修 #23：drill-down 层级导航）

/** 计算每个章节索引的祖先链（不含自身），用祖先栈法，支持任意层级嵌套与跳级。 */
function tocAncestry() {
  const anc = {};
  const stack = [];
  for (let i = 0; i < (R.chapters || []).length; i++) {
    const lv = (R.chapters[i].level || 1);
    while (stack.length && stack[stack.length - 1].lv >= lv) stack.pop();
    anc[i] = stack.map(s => s.i);
    stack.push({ i, lv });
  }
  return anc;
}

/** 返回 rootIdx 及其全部后代的索引数组（按原顺序），用于 drill-down 只显示子树。 */
function tocSubtree(rootIdx) {
  const root = R.chapters[rootIdx];
  const rootLv = root.level || 1;
  const out = [rootIdx];
  for (let i = rootIdx + 1; i < R.chapters.length; i++) {
    if ((R.chapters[i].level || 1) <= rootLv) break;
    out.push(i);
  }
  return out;
}

function renderTocList() {
  // 自愈：内存里的目录被误清空（换书/识别失败/异步竞态）但书库里还存着 → 回填。
  // 否则会出现用户实测的「刚提示识别到 22 章，目录抽屉却是空白」。
  if ((!R.chapters || !R.chapters.length) && R.book && Array.isArray(R.book.chapters) && R.book.chapters.length) {
    R.chapters = R.book.chapters.slice();
  }
  try {
    renderTocListFull();
  } catch (e) {
    console.error('目录渲染出错', e);
    renderTocListPlain('目录渲染出错：' + (e && e.message ? e.message : e));
  }
  // 自检兜底：明明有章节，却一个 .chapter-item 都没渲染出来
  // → 用最简列表再画一遍，保证条目一定看得见、点得到。
  const el = $('tocList');
  if (el && R.chapters && R.chapters.length && !el.querySelector('.chapter-item')) {
    renderTocListPlain('已识别 ' + R.chapters.length + ' 章，但列表渲染异常，已用简表显示');
  }
}

/** 最简目录列表（兜底）：只有标题 + 跳转 + 删除，不带折叠/多选/层级按钮。
 *  目的是「就算高级渲染挂了，也绝不能出现『说有 22 章、列表却空白』」。 */
function renderTocListPlain(reason) {
  const el = $('tocList');
  if (!el) return;
  const chaps = (R.chapters || []);
  let html = '<div class="toc-toolbar">' +
    '<button class="btn-plain toc-add" id="tocAdd">＋ 插入目录项</button>' +
    '<button class="btn-plain toc-redetect" id="tocRedetect">↻ 重新识别</button>' +
    '<button class="btn-plain toc-clear" id="tocClear">清空</button>' +
    '</div>';
  if (reason) html += '<div class="toc-tip">' + esc(reason) + '</div>';
  if (!chaps.length) {
    html += '<div class="drawer-empty">本书没有识别到目录<br>可点上方「重新识别」按原书再提取一次，或用「＋ 插入目录项」手动加</div>';
  } else {
    html += chaps.map((c, i) =>
      '<div class="chapter-item lv1" data-idx="' + i + '">' +
        '<span class="toc-caret-spacer"></span>' +
        '<span class="ci-title">' + esc(String(c && c.title != null ? c.title : '（未命名）')) + '</span>' +
        '<span class="ci-acts"><button class="ci-btn" data-act="del" data-i="' + i + '" title="删除">🗑</button></span>' +
      '</div>').join('');
  }
  el.innerHTML = html;
  el.querySelectorAll('.chapter-item').forEach(n => n.onclick = (e) => {
    if (e.target.closest('.ci-acts')) return;
    const c = R.chapters[parseInt(n.dataset.idx, 10)];
    if (!c) return;
    if (R.format === 'pdf' && c.dest) gotoPdfDest(c.dest);
    else gotoLocator(c.offset);
    closeDrawers();
  });
  el.querySelectorAll('[data-act="del"]').forEach(b => b.onclick = (e) => {
    e.stopPropagation(); delChapter(parseInt(b.dataset.i, 10));
  });
  bindTocDrag(el);
  bindTocRedetect();
  bindTocToolbar();
}

function renderTocListFull() {
  const el = $('tocList');
  // 计算折叠：支持任意层级嵌套（多重父子），用祖先栈判定某条目录是否被「任一祖先」折叠。
  // 一条目录项在以下情况隐藏：它的某个祖先（层级更小、且出现在它之前、中间没有层级 <= 它的项）被折叠。
  const hiddenSet = new Set();
  if (R.chapters && R.chapters.length) {
    const stack = [];   // 祖先链：{ idx, level, hidden }
    for (let i = 0; i < R.chapters.length; i++) {
      const lv = R.chapters[i].level || 1;
      while (stack.length && stack[stack.length - 1].level >= lv) stack.pop();
      const parent = stack.length ? stack[stack.length - 1] : null;
      // ⚠️ 必须沿祖先链**逐级传播**：只看「直接父级是否被折叠」会漏掉孙子辈
      //    （用户实测：A → A1 → AA1，折叠 A 时 A1 藏起来了，AA1 还露在外面）。
      const hidden = !!(parent && (parent.hidden || tocCollapsed.has(parent.idx)));
      if (hidden) hiddenSet.add(i);
      stack.push({ idx: i, level: lv, hidden });
    }
  }
  let html = '<div class="toc-toolbar">' +
    '<button class="btn-plain toc-add" id="tocAdd">＋ 插入目录项</button>' +
    '<button class="btn-plain toc-redetect" id="tocRedetect">↻ 重新识别</button>';
  if (tocSelectMode) {
    // 全选 / 全不选 合并为一个切换按钮：已全选时显示「全不选」，否则显示「全选」（修 #9）
    const allChecked = R.chapters && R.chapters.length && tocChecked.size >= R.chapters.length;
    html += '<button class="btn-plain toc-sel-toggle" id="tocSelToggle">' + (allChecked ? '全不选' : '全选') + '</button>' +
      '<button class="btn-plain toc-sel-exit" id="tocSelExit">✕ 退出多选</button>' +
      '<button class="btn-plain toc-sel-del" id="tocSelDel">🗑 删除选中(' + tocChecked.size + ')</button>';
  } else {
    html += '<button class="btn-plain toc-sel" id="tocSel">☑ 多选</button>';
  }
  html += '<button class="btn-plain toc-clear" id="tocClear">清空</button>' +
    '<button class="btn-plain toc-first" id="tocFirst" title="跳到第一章（目录根）">⤒ 首章</button>' +
    '<button class="btn-plain toc-foldall" id="tocFoldAll" title="展开 / 折叠全部父级（露出全部叶子）">▤ 展开/折叠</button>' +
    '</div>' +
    '<div class="toc-custom-row">' +
      '<input id="tocCustomInput" class="toc-custom-input" type="text" title="%x = 编号占位符；%r = 任意文字；高级：re: 开头写原始正则（如 re:第[0-9]+节）；留空用内置规则" placeholder="自定义格式：%x 编号 · %r 任意文字，如 第%x章 / 【%r】" value="' + esc(Settings.tocCustom || '') + '">' +
      '<button class="btn-plain toc-custom-btn" id="tocCustomBtn">用此格式识别</button>' +
      '<label class="toc-keep" title="勾选：内置规则识别到的目录全部保留，自定义格式只做补充（不会把已有目录清空）"><input type="checkbox" id="tocKeepMarker" ' + (Settings.tocKeepMarker !== false ? 'checked' : '') + '> 保留原符号</label>' +
    '</div>' +
    // R70：边写边看「这条规则在本书里能命中几行」——用户反馈「填 第【%x】段 识别 25 章，
    // 填 【%x】段 只识别 1 章」，光看规则猜不出问题，给个即时预览就一目了然。
    '<div class="toc-custom-preview" id="tocCustomPreview"></div>' +
    // R72：说明只留必要规则（原来说明铺了 5 句长文，用户反馈「自定义前言写太多了」）
    '<div class="toc-custom-help">' +
      '<code>%x</code> = 编号（<code>第%x章</code>、<code>【%x】段</code>）；' +
      '<code>%r</code> = 任意文字（编号位是字就用它，如 <code>第%r章</code> 认「第【上】章」）' +
      '<br>空格可有可无，多条用 <code>||</code> 隔开' +
      '<br><b>保留原符号</b>：勾着 = 内置结果保留、自定义只补充；不勾 = 只用自定义' +
      '<br>楔子 / 序章 / 前言 / 尾声 / 番外 / 附录 已内置识别，不用写规则' +
    '</div>';
  html += tocSelectMode
    ? '<div class="toc-tip">多选模式：点条目勾选，再「删除选中」；或「清空」一键删全部</div>'
    : '<div class="toc-tip">点跳转 · <b>双击父级只看这一支</b> · <b>拖标题 = 挂成子节点</b> · ✎ 改名 · ⤴⤵ 升降 · 🗑 删除</div>';
  if (!R.chapters || !R.chapters.length) {
    const hasCustom = !!(Settings && Settings.tocCustom && String(Settings.tocCustom).trim());
    html += '<div class="drawer-empty">' + (hasCustom
      ? '自定义格式「' + esc(String(Settings.tocCustom).trim()) + '」没有匹配到任何标题<br>'
        + '检查一下写法：<code>第%x章</code> 匹配「第十二章」、<code>【第%x章】</code> 匹配「【第十二章】」；<br>'
        + '也可以把上面输入框清空，改用内置规则自动识别'
      : '本书没有识别到目录<br>可点上方「重新识别」按原书再提取一次，或用「＋ 插入目录项」手动加') + '</div>';
    el.innerHTML = html;
    bindTocRedetect();
    bindTocToolbar();   // 空目录时也要绑定「插入目录项」等按钮（图片/PDF 多半走这里）
    return;
  }
  // —— #23 drill-down 层级导航：tocRoot !== -1 时只显示该章节子树，层级重新基准化 ——
  let visibleIdx, baseLevel = 1, showLevelBtns = (tocRoot === -1);
  if (tocRoot !== -1 && R.chapters[tocRoot]) {
    visibleIdx = tocSubtree(tocRoot);
    baseLevel = R.chapters[tocRoot].level || 1;
    const anc = tocAncestry();
    const chain = [...(anc[tocRoot] || []), tocRoot];
    let crumb = '<button class="toc-crumb" data-root="-1">📖 全书</button>';
    chain.forEach((idx, k) => {
      const isLast = (k === chain.length - 1);
      crumb += '<span class="toc-crumb-sep">›</span>' +
        `<button class="toc-crumb${isLast ? ' cur' : ''}" data-root="${idx}">${esc(R.chapters[idx].title)}</button>`;
    });
    html += '<div class="toc-breadcrumb">' + crumb +
      '<button class="btn-plain toc-up" id="tocUp" title="上一层：以当前根的父节点为新根">⬆ 上一层</button></div>';
  } else {
    visibleIdx = R.chapters.map((_, i) => i);
  }
  html += visibleIdx.map((i) => {
    const c = R.chapters[i];
    const lv = Math.max(1, (c.level || 1) - baseLevel + 1);
    const pos = visibleIdx.indexOf(i);
    const nextVisible = visibleIdx[pos + 1];
    const isParent = !!nextVisible && ((R.chapters[nextVisible].level || 1) > (c.level || 1));
    const collapsed = tocCollapsed.has(i);
    const hidden = hiddenSet.has(i);
    const checked = tocChecked.has(i);
    const caret = isParent
      ? `<button class="toc-caret" data-act="fold" data-i="${i}" title="${collapsed ? '展开' : '折叠'}">${collapsed ? '▸' : '▾'}</button>`
      : '<span class="toc-caret-spacer"></span>';
    const check = tocSelectMode
      ? `<input type="checkbox" class="toc-check" data-i="${i}" ${checked ? 'checked' : ''}>` : '';
    const up = (showLevelBtns && c.level > 1) ? `<button class="ci-btn" data-act="up" data-i="${i}" title="⤴ 升一级：往外挪，成为上一层目录的兄弟（可一直升到根）">⤴</button>` : '';
    const down = (showLevelBtns && c.level < TOC_MAX_LEVEL) ? `<button class="ci-btn" data-act="down" data-i="${i}" title="⤵ 降一级：挂到上一条目录下面，成为它的子级">⤵</button>` : '';
    return `<div class="chapter-item lv${lv}${hidden ? ' toc-hidden' : ''}" data-idx="${i}" style="--d:${lv}">` +
      caret + check +
      `<span class="ci-title">${esc(c.title)}</span>` +
      `<span class="ci-acts">${up}${down}` +
        `<button class="ci-btn" data-act="rename" data-i="${i}" title="改名">✎</button>` +
        `<button class="ci-btn" data-act="del" data-i="${i}" title="删除">🗑</button>` +
      `</span>` +
    `</div>`;
  }).join('');
  el.innerHTML = html;
  el.querySelectorAll('.chapter-item').forEach(n => n.onclick = (e) => {
    if (n._noClick) { n._noClick = false; return; }
    if (e.target.closest('.ci-acts')) return;
    if (e.target.closest('.toc-caret') || e.target.closest('.toc-check')) return;
    if (tocSelectMode) { toggleTocCheck(parseInt(n.dataset.idx)); return; }
    const c = R.chapters[parseInt(n.dataset.idx)];
    if (R.format === 'pdf' && c.dest) gotoPdfDest(c.dest);
    else gotoLocator(c.offset);
    closeDrawers();
  });
  el.querySelectorAll('.toc-check').forEach(cb => cb.onchange = () => toggleTocCheck(parseInt(cb.dataset.i)));
  el.querySelectorAll('[data-act="fold"]').forEach(b => b.onclick = (e) => {
    e.stopPropagation(); const i = parseInt(b.dataset.i);
    if (tocCollapsed.has(i)) tocCollapsed.delete(i); else tocCollapsed.add(i);
    renderTocList();
  });
  el.querySelectorAll('[data-act="up"]').forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    const i = parseInt(b.dataset.i); const c = R.chapters[i]; if (!c) return;
    setChapterLevel(i, Math.max(1, (c.level || 1) - 1));   // 升级：朝根节点方向，直到成为第 1 级（新根）
  });
  el.querySelectorAll('[data-act="down"]').forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    const i = parseInt(b.dataset.i); const c = R.chapters[i]; if (!c) return;
    // 降级 = 变成「上一条目录」的子节点；**第一条**没有上一条时，改成挂到「下一条」
    // 下面（用户实测：想把这个顶级项挂到紧跟它的那项下面，旧逻辑直接拒绝）。
    // 想指定任意父节点 → 直接拖动标题行（拖到谁上面就是谁的子节点）。
    const prev = R.chapters[i - 1] || R.chapters[i + 1];
    if (!prev) { toast('只有一条目录项，没地方可挂'); return; }
    const di = R.chapters[i - 1] ? i - 1 : i + 1;
    const pTitle = prev.title || '目标目录';
    const sEnd = tocSubtreeEnd(R.chapters, i);
    const targetInside = di > i && di < sEnd;
    const ok = targetInside ? tocMakeParent(di, i) : tocReparent(i, di);
    if (!ok) { toast('挂不过去（层级已到最深）'); return; }
    saveChapters();
    renderTocList();
    toast(targetInside ? ('已把「' + pTitle + '」提升为父级') : ('已挂到「' + pTitle + '」下面'));
  });
  el.querySelectorAll('[data-act="rename"]').forEach(b => b.onclick = (e) => {
    e.stopPropagation(); renameChapter(parseInt(b.dataset.i));
  });
  el.querySelectorAll('[data-act="del"]').forEach(b => b.onclick = (e) => {
    e.stopPropagation(); delChapter(parseInt(b.dataset.i));
  });
  // —— #23 drill-down 导航处理器 ——
  el.querySelectorAll('.toc-crumb').forEach(b => b.onclick = (e) => {
    e.stopPropagation(); tocRoot = parseInt(b.dataset.root); renderTocList();
  });
  const upBtn = $('tocUp');
  if (upBtn) upBtn.onclick = () => {
    const anc = tocAncestry();
    const chain = anc[tocRoot] || [];
    tocRoot = chain.length ? chain[chain.length - 1] : -1;   // 上一层：以父节点为新根（可一直上溯到全书）
    renderTocList();
  };
  el.querySelectorAll('[data-act="drill"]').forEach(b => b.onclick = (e) => {
    e.stopPropagation(); tocRoot = parseInt(b.dataset.i); renderTocList();   // 进入子树（下一层，直到新的叶）
  });
  bindTocDrag(el);
  bindTocRedetect();
  bindTocToolbar();
}

/** 绑定目录工具栏按钮（插入 / 多选 / 退出 / 删除选中 / 清空）。空目录与非空目录都要绑。 */
function bindTocToolbar() {
  const add = $('tocAdd');
  if (add) add.onclick = () => addChapterAtCurrent();
  const sel = $('tocSel');
  if (sel) sel.onclick = () => { tocSelectMode = true; tocChecked.clear(); renderTocList(); };
  const selExit = $('tocSelExit');
  if (selExit) selExit.onclick = () => { tocSelectMode = false; tocChecked.clear(); renderTocList(); };
  const selToggle = $('tocSelToggle');
  if (selToggle) selToggle.onclick = () => {
    // 已全选 → 全部取消；否则 → 全选（修 #9：全选/全不选合并为一个切换）
    if (R.chapters && tocChecked.size >= R.chapters.length) tocChecked.clear();
    else { tocChecked.clear(); if (R.chapters) R.chapters.forEach((_, i) => tocChecked.add(i)); }
    renderTocList();
  };
  const selDel = $('tocSelDel');
  if (selDel) selDel.onclick = () => tocDeleteChecked();
  const clear = $('tocClear');
  if (clear) clear.onclick = () => tocClearAll();
  const first = $('tocFirst');
  if (first) first.onclick = () => {
    if (R.chapters && R.chapters.length) {
      const c = R.chapters[0];
      if (R.format === 'pdf' && c.dest) gotoPdfDest(c.dest);
      else gotoLocator(c.offset);
      closeDrawers();
    }
  };
  const foldAll = $('tocFoldAll');
  if (foldAll) foldAll.onclick = toggleFoldAll;
  // 自定义目录格式：填自己的正则 → 存进 Settings.tocCustom → 重新识别
  const cbtn = $('tocCustomBtn');
  if (cbtn) cbtn.onclick = applyCustomToc;
  const cinp = $('tocCustomInput');
  if (cinp) {
    cinp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); applyCustomToc(); } };
    // R70：边打字边预览「这条规则在本书里命中几行」，不用先点「用此格式识别」试错
    let _pToc = null;
    cinp.oninput = () => {
      if (_pToc) clearTimeout(_pToc);
      _pToc = setTimeout(previewTocRule, 250);
    };
    if (String(cinp.value || '').trim()) previewTocRule();
  }
  const keepBox = $('tocKeepMarker');
  if (keepBox) keepBox.onchange = async () => {
    // 「保留原符号」是**显示口径**开关，改了要立刻看到效果。
    // 之前这里走 applyCustomToc → reDetectChapters()（非 silent），会先弹一个
    // 「重新识别会覆盖手动改过的目录」确认框：在抽屉里这个框被压在遮罩下/被当成没反应，
    // 用户实测「勾选框完全不起作用」。改成：存设置 → 静默重识别 → toast 报告命中章数。
    Settings.tocKeepMarker = keepBox.checked;
    await saveSettings();
    await reDetectChapters(true);
    toast((keepBox.checked ? '已保留原符号' : '已去掉章号/括号前缀') + '（' + (R.chapters || []).length + ' 章）');
  };
}

/** 展开 / 折叠全部父级章节（修 #23：目录之前只能逐层折叠，露出/收起全部叶子不便）。
 *  若当前全部父级都已折叠 → 展开全部；否则 → 折叠全部。 */
function toggleFoldAll() {
  if (!R.chapters || !R.chapters.length) return;
  const parents = [];
  for (let i = 0; i < R.chapters.length; i++) {
    const lv = R.chapters[i].level || 1;
    if ((i + 1 < R.chapters.length) && ((R.chapters[i + 1].level || 1) > lv)) parents.push(i);
  }
  if (!parents.length) { toast('本书目录没有可折叠的父级'); return; }
  const allCollapsed = parents.every(i => tocCollapsed.has(i));
  parents.forEach(i => { if (allCollapsed) tocCollapsed.delete(i); else tocCollapsed.add(i); });
  renderTocList();
  toast(allCollapsed ? '已展开全部' : '已折叠全部父级');
}

/** 自定义目录规则的即时预览：只数「能命中几行」，不动目录。
 *  R70 用户反馈：「填 第【%x】段 就识别 25 章，填 【%x】段 只识别 1 章」——
 *  实际是规则漏了行首的「第」，一条没命中的时候目录只剩兜底的「全文」。
 *  写了规则就能立刻看到命中数/样例，不用先点「用此格式识别」再猜。 */
function previewTocRule() {
  const out = $('tocCustomPreview');
  const inp = $('tocCustomInput');
  if (!out) return;
  const val = inp ? String(inp.value || '').trim() : '';
  if (!val) { out.innerHTML = ''; return; }
  const text = String(R.text || '');
  if (!text.trim()) {
    out.innerHTML = '<span style="opacity:.7">这本书没有可提取的正文（PDF / 漫画按页定位），目录只能用内置规则或手动加</span>';
    return;
  }
  const rules = val.split('||').map(r => compileTocRule(String(r).trim())).filter(Boolean);
  if (!rules.length) {
    out.innerHTML = '<span style="color:#FF3B30">规则写法无效</span>' +
      '<span style="opacity:.75">（看下面语法说明；要写原始正则请加 <code>re:</code> 前缀）</span>';
    return;
  }
  const lines = text.split('\n');
  const hits = [];
  let bare = 0;
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) continue;
    if (rules.some(re => { try { return re.test(t); } catch (e) { return false; } })) {
      hits.push(t);
      if (hits.length >= 5000) break;
    }
  }
  // R71：无编号标题（楔子 / 序章 / 前言 / 尾声 / 番外 / 附录…）是内置识别的，
  // 不写规则的也能进目录 —— 预览时把这部分数出来，用户才不会以为「怎么还多了几章」。
  if (typeof matchBareHeading === 'function') {
    for (const ln of lines) {
      const t = ln.trim();
      if (t && matchBareHeading(t)) bare++;
    }
  }
  const bareNote = bare
    ? '<span style="opacity:.8">；另有 <b>' + bare + ' 个无编号标题</b>（楔子 / 序章 / 前言 / 番外…）'
      + '会由内置规则一起收进目录</span>'
    : '';
  if (!hits.length) {
    // R85：规则写了 %x，但书里「编号位」放的是字（第【上】章 / 【楔子】）→ 直接告诉他换成 %r 能中几行。
    // 以前只能干看着「一行都命中不了」，猜不到是占位符类型不对。
    let altNote = '';
    if (/%[xX]/.test(val)) {
      const altRes = val.split('||')
        .map(r => compileTocRule(String(r).trim().replace(/%[xX]/g, '%r'))).filter(Boolean);
      let altHits = 0;
      for (const ln of lines) {
        const t = ln.trim();
        if (!t) continue;
        if (altRes.some(re => { try { return re.test(t); } catch (e) { return false; } })) {
          if (++altHits >= 5000) break;
        }
      }
      if (altHits) {
        altNote = '<br><b style="color:#34C759">把 %x 换成 %r 能命中 ' + altHits + ' 行</b>' +
          '<span style="opacity:.75"> —— 这本书的编号位放的是字（第【上】章 / 【楔子】），不是数字。</span>';
      }
    }
    // R86：规则用了全角【】但书里是半角 [ ]（或反过来）→ 一条都不中，用户只会觉得「规则没用」。
    if (!altNote && /[【】]/.test(val)) {
      const swap = (s) => s.replace(/【/g, '[').replace(/】/g, ']');
      const brRes = val.split('||').map(r => compileTocRule(swap(String(r).trim()))).filter(Boolean);
      let brHits = 0;
      for (const ln of lines) {
        const t = ln.trim();
        if (!t) continue;
        if (brRes.some(re => { try { return re.test(t); } catch (e) { return false; } })) {
          if (++brHits >= 5000) break;
        }
      }
      if (brHits) {
        altNote = '<br><b style="color:#34C759">把 【】换成半角 [ ] 能命中 ' + brHits + ' 行</b>' +
          '<span style="opacity:.75"> —— 这本书的标题用的是 <code>[必看]…</code> 这种半角方括号。</span>';
      }
    }
    out.innerHTML = '<span style="color:#FF3B30">本书里一行都命中不了</span>' +
      '<span style="opacity:.75"> —— 照书里标题的<b>原样</b>写：标题是「第3章 风起」就写 <code>第%x章</code>；' +
      '是「第3段」「第【3】段」就写 <code>%x段</code>、<code>【%x】段</code>（行首的「第」可写可不写，会自动兼容）。' +
      '编号位是字就用 <code>%r</code>（任意文字），如 <code>第%r章</code>、<code>【%r】</code>。</span>'
      + altNote
      + (bare ? '<br><span style="opacity:.8">楔子 / 序章 / 前言 / 尾声 / 番外 / 附录 这类没有编号的标题不用写规则，'
        + '内置已认（本次识别到 ' + bare + ' 个）。</span>' : '');
    return;
  }
  const sample = hits.slice(0, 3).map(t => '「' + esc(t.slice(0, 26)) + '」').join(' ');
  out.innerHTML = '<b style="color:#34C759">命中 ' + hits.length + ' 行</b>' +
    '<span style="opacity:.8"> · 前 3 行：' + sample + '</span>' + bareNote;
}

async function applyCustomToc() {
  const inp = $('tocCustomInput');
  const val = inp ? inp.value.trim() : '';
  if (val) {
    // 与 paginator.js 的 compileTocRule 完全一致：re: 前缀=原始正则；%x 模板（%x=编号占位符，
    // 其余字面）；旧式 x 简写（向后兼容）；%x / x 命中整行作标题。逐条编译，任一条有效即保存。
    const rules = val.split('||');
    let okCount = 0, bad = [];
    rules.forEach(r => {
      if (compileTocRule(r.trim())) okCount++; else bad.push(r.trim());
    });
    if (okCount === 0) { toast('自定义格式无效：' + (bad[0] || val)); return; }
    if (bad.length) toast('已忽略 ' + bad.length + ' 条无效规则，其余 ' + okCount + ' 条生效');
  }
  Settings.tocCustom = val;
  const keepBox = $('tocKeepMarker');
  Settings.tocKeepMarker = keepBox ? keepBox.checked : (Settings.tocKeepMarker !== false);
  await saveSettings();
  // 「用此格式识别」是明确的操作意图，不该再弹「会覆盖手动目录」的确认框（抽屉里容易被遮罩挡住，
  // 用户点了没反应）。直接静默重识别，并用 toast 报告结果。
  await reDetectChapters(true);
  toast('已按' + (val ? '自定义格式' : '内置规则') + '识别：' + (R.chapters || []).length + ' 章');
}

function toggleTocCheck(i) {
  if (tocChecked.has(i)) tocChecked.delete(i); else tocChecked.add(i);
  const cb = document.querySelector('.toc-check[data-i="' + i + '"]');
  if (cb) cb.checked = tocChecked.has(i);
  const btn = $('tocSelDel');
  if (btn) btn.textContent = '🗑 删除选中(' + tocChecked.size + ')';
}

/** 目录是「扁平数组 + level」，i 的子树 = 紧跟其后、level 更深的那一段（不含 i 本身起点） */
function tocSubtreeEnd(list, i) {
  const lv = list[i].level || 1;
  let j = i + 1;
  while (j < list.length && (list[j].level || 1) > lv) j++;
  return j;
}

/**
 * 把目录项 src **挂到** dst 下面（成为 dst 的子节点）。
 * 用户诉求（2026-10-21）：
 *   · 「为什么 Preface 不能成为 Accessible EPUB 3 的父节点 / Note 的子节点」
 *   · 「为什么 Accessible EPUB 3 不能成为 Preface 的子节点」
 * 根因：原来的 ⤵ 只会「挂到上一个目录项下面」，第一项没有 prev 就直接拒绝，
 * 也不能指定挂到谁下面。这里改成显式指定父节点，并把整棵子树一起搬过去
 * （否则子节点会留在原地变成孤儿）。
 */
/** 层级归一化：目录是「扁平数组 + level」模型，level 只能从 1 逐级 +1，
 *  不能出现 1 → 3 这种跳级（会让缩进/折叠的父子关系看着错乱）。
 *  改完层级后统一过一遍：每项最多比前一项深一级，且限制在 1~4。 */
function tocNormalizeLevels(list) {
  if (!Array.isArray(list) || !list.length) return;
  let prev = null;
  for (const it of list) {
    let lv = it.level || 1;
    lv = Math.max(1, Math.min(TOC_MAX_LEVEL, lv));
    if (prev !== null) lv = Math.min(lv, prev + 1);
    it.level = lv;
    prev = lv;
  }
}

function tocReparent(src, dst) {
  const list = R.chapters;
  if (!Array.isArray(list) || src === dst) return false;
  if (src < 0 || src >= list.length || dst < 0 || dst >= list.length) return false;
  const sEnd = tocSubtreeEnd(list, src);
  if (dst >= src && dst < sEnd) return false;          // 不能挂到自己 / 自己的子孙下（会成环）
  if ((list[dst].level || 1) >= TOC_MAX_LEVEL) return false;   // 已经是最深层，挂不了子级
  const block = list.splice(src, sEnd - src);          // 整棵子树一起搬
  const d = dst > src ? dst - block.length : dst;      // 前面删掉 block 后 dst 左移
  const dEnd = tocSubtreeEnd(list, d);                 // 插到 dst 子树末尾（排在它现有子级之后）
  const newLevel = (list[d].level || 1) + 1;
  const delta = newLevel - (block[0].level || 1);
  block.forEach(c => { c.level = Math.max(1, Math.min(TOC_MAX_LEVEL, (c.level || 1) + delta)); });
  list.splice(dEnd, 0, ...block);
  tocNormalizeLevels(list);
  return true;
}

/**
 * 让 parent 成为 child 的**父级**（即使 parent 现在是 child 的子节点）。
 * 这是「Preface 想当 Accessible EPUB 3 的父节点」「Accessible 想当 Preface 的子节点」
 * 两种说法的同一个操作：把 parent 单项上移到 child 之前、层级对齐，
 * child 及其子树自动降一级。child 原有的其它子级仍然挂在 child 下（level 差不变）。
 */
function tocMakeParent(parentIdx, childIdx) {
  const list = R.chapters;
  if (!Array.isArray(list) || parentIdx === childIdx) return false;
  const p = list[parentIdx], c = list[childIdx];
  if (!p || !c) return false;
  const pLevel = p.level || 1;
  if (pLevel >= TOC_MAX_LEVEL) return false;        // 已在最深层，做不了父级
  // 摘出 parent 单项（不动它的子树：子树留在原位，之后自然成为 child 的子级）
  list.splice(parentIdx, 1);
  let ci = list.indexOf(c);
  if (ci < 0) return false;
  list.splice(ci, 0, p);                            // 插到 child 前面
  const oldCLevel = c.level || 1;
  const newCLevel = Math.min(TOC_MAX_LEVEL, oldCLevel + 1);   // child 降一级，成为 parent 的子级
  p.level = newCLevel - 1;                          // parent 正好比 child 高一级
  c.level = newCLevel;
  // ⚠️ child 原来的子树必须跟着一起降级，否则会出现「Preface 变成 Note 的子级了，
  //    但它原来的子级 Accessible 还停在 level 2 → 变成 Preface 的兄弟」这种串层级。
  const delta = newCLevel - oldCLevel;
  if (delta) {
    const ci2 = list.indexOf(c);
    let j = ci2 + 1;
    while (j < list.length && (list[j].level || 1) > oldCLevel) {
      list[j].level = Math.min(TOC_MAX_LEVEL, (list[j].level || 1) + delta);
      j++;
    }
  }
  tocNormalizeLevels(list);
  return true;
}

/* ---------------- 目录拖拽：拖到哪一项上，就成为它的子节点 ---------------- */
let _tocDrag = null;
function bindTocDrag(el) {
  el.querySelectorAll('.chapter-item').forEach(item => {
    const handle = item.querySelector('.ci-title');
    if (!handle) return;
    const idx = parseInt(item.dataset.idx, 10);
    handle.addEventListener('pointerdown', (ev) => {
      // 多选模式也允许拖（用户要「多选里也能拖选」）：短按仍是勾选，长按才拿起
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const y0 = ev.clientY, x0 = ev.clientX;
      // 鼠标按住 140ms / 手指按住 320ms 才算「拿起」；期间一移动就当滚动，取消
      const timer = setTimeout(() => {
        _tocDrag = { idx, item, target: -1 };
        item.classList.add('toc-dragging');
        document.body.classList.add('toc-dragging-body');
      }, ev.pointerType === 'mouse' ? 140 : 320);
      const move = (e2) => {
        if (Math.abs(e2.clientY - y0) > 8 || Math.abs(e2.clientX - x0) > 8) clearTimeout(timer);
        if (!_tocDrag) return;
        e2.preventDefault();
        const t = document.elementFromPoint(e2.clientX, e2.clientY);
        const row = t && t.closest ? t.closest('.chapter-item') : null;
        el.querySelectorAll('.chapter-item.toc-drop').forEach(n => n.classList.remove('toc-drop'));
        const di = row ? parseInt(row.dataset.idx, 10) : -1;
        // 不能拖到自己 / 自己的子孙上（会成环），这类目标不亮高亮
        // 目标在子树内也允许（松手时它会被提升为父级）；只要不是自己、且目标不是最深层
        const bad = di < 0 || di === idx || (R.chapters[di].level || 1) >= TOC_MAX_LEVEL;
        if (!bad) {
          row.classList.add('toc-drop');
          _tocDrag.target = di;
          _tocDrag.targetTitle = (R.chapters[di] || {}).title || '';
        } else {
          _tocDrag.target = -1;
        }
      };
      const up = async () => {
        clearTimeout(timer);
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        const d = _tocDrag;
        _tocDrag = null;
        item.classList.remove('toc-dragging');
        document.body.classList.remove('toc-dragging-body');
        el.querySelectorAll('.chapter-item.toc-drop').forEach(n => n.classList.remove('toc-drop'));
        if (!d || d.target < 0) return;
        const parentTitle = d.targetTitle || '目标目录';
        // 拖到「自己的子节点」上 = 想让它当父级（用户：「为什么 Preface 不能成为
        // Accessible EPUB 3 的父节点」）→ 走 tocMakeParent，而不是拒绝。
        const sEnd = tocSubtreeEnd(R.chapters, d.idx);
        const targetInside = d.target > d.idx && d.target < sEnd;
        const ok = targetInside ? tocMakeParent(d.target, d.idx) : tocReparent(d.idx, d.target);
        if (ok) {
          // 拖拽结束浏览器还会补一个 click：屏蔽掉，避免多选模式下顺手切换勾选
          item._noClick = true;
          await saveChapters();
          renderTocList();
          toast(targetInside ? ('已把「' + parentTitle + '」提升为父级') : ('已挂到「' + parentTitle + '」下面'));
        } else {
          toast('这两个目录项不能再嵌套（层级已到最深）');
        }
      };
      document.addEventListener('pointermove', move, { passive: false });
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    });
  });
}

async function setChapterLevel(i, lvl) {
  const c = R.chapters[i];
  if (!c) return;
  lvl = Math.max(1, Math.min(TOC_MAX_LEVEL, lvl | 0 || 1));
  c.level = lvl;
  await saveChapters();
  renderTocList();
  toast('已设为第 ' + lvl + ' 级' + (lvl === 1 ? '（根节点 / 父级，可折叠子项）' : (lvl >= 3 ? '（更深子级，可作为正文的子节点）' : '（子级）')));
}

async function tocDeleteChecked() {
  if (!tocChecked.size) { toast('还没勾选要删除的目录项'); return; }
  const n = tocChecked.size;
  const ok = await new Promise(res => showChoice('删除选中的 ' + n + ' 条目录项？', ['删除', '取消'], 1, x => res(x === 0)));
  if (!ok) return;
  Array.from(tocChecked).sort((a, b) => b - a).forEach(i => R.chapters.splice(i, 1));
  tocChecked.clear(); tocSelectMode = false;
  await saveChapters();
  renderTocList();
  toast('已删除 ' + n + ' 条');
}

async function tocClearAll() {
  if (!R.chapters || !R.chapters.length) { toast('目录本来就是空的'); return; }
  const ok = await new Promise(res => showChoice('清空全部目录（' + R.chapters.length + ' 条）？此操作不可撤销。', ['清空', '取消'], 1, x => res(x === 0)));
  if (!ok) return;
  R.chapters = [];
  tocCollapsed.clear(); tocChecked.clear(); tocSelectMode = false;
  if (R.book) { R.book.tocDetected = true; R.book.tocCleared = true; }  // 用户主动清空：尊重空目录，不再自动补识别
  await saveChapters();
  renderTocList();
  toast('已清空目录');
}

/** 判断当前章节数据是否需要重新提取：空数组，或存在结构损坏的条目（旧版导入器留下的非对象 / 缺 offset）。 */
function tocChaptersBroken() {
  const cs = R.chapters || [];
  if (!cs.length) return true;
  return cs.some(c => !c || typeof c !== 'object' || c.offset == null);
}

function bindTocRedetect() {
  const b = $('tocRedetect');
  if (b) b.onclick = () => reDetectChapters();
}

/** 当前阅读位置对应的目录锚点（字符偏移 / 页码 / 滚动百分比） */
function currentReadOffset() {
  if (R.format === 'html') {
    const el = $('scrollLayer');
    const max = Math.max(1, el.scrollHeight - el.clientHeight);
    return Math.min(1, Math.max(0, el.scrollTop / max));   // 富文本存滚动百分比
  }
  if (R.format === 'txt' && R.pages && R.pages[R.pageIndex]) return R.pages[R.pageIndex].start;
  return R.pageIndex;
}

/** 在「当前阅读位置」插入一条目录项（手动加章节），插入后立刻让用户改名 */
async function addChapterAtCurrent() {
  if (!R.chapters) R.chapters = [];
  if (!R.book) { toast('还没打开书，无法插入目录项'); return; }
  const off = currentReadOffset();
  // 只用「同类型锚点」比较：PDF 的大纲章节只有 dest、没有 offset，
  // 用 (c.offset||0) 混着比重排会把新项塞进错误位置。
  const numeric = (c) => (c && typeof c.offset === 'number') ? c.offset : null;
  let i = R.chapters.findIndex(c => { const v = numeric(c); return v != null && v > off; });
  if (i < 0) i = R.chapters.length;
  const item = { title: '新目录项 ' + (R.chapters.length + 1), offset: off, level: 1 };
  // PDF：顺手记住当前页，这样点这条目录一定能跳过去（没有 dest 时走 gotoLocator → goToPage）
  if (R.format === 'pdf') item.offset = R.pageIndex;
  R.chapters.splice(i, 0, item);
  await saveChapters();
  renderTocList();
  toast('已插入目录项（第 ' + (i + 1) + ' 条），点 ✎ 可改名');
  // 不再自动弹改名框（之前那个弹窗在抽屉里容易点不到 / 关不掉）；
  // 插入后由用户自己决定：点 ✎ 改名，或点 🗑 删除。
}

/** 把当前（可能手动改过的）目录写回书库 */
async function saveChapters() {
  R.book.chapters = R.chapters;
  R.book.tocDetected = true;   // 标记「已识别过」：此后打开不再自动识别（尊重用户清空/手动编辑）
  try {
    await DB.put('books', R.book);
  } catch (e) {
    // 写入失败（iPad 上常见于存储配额满 / PDF 大纲 dest 无法结构化克隆）不能再抛出去：
    // 之前一抛，后面的 renderTocList 就永远不执行 → 表现为「提示识别到 N 章，目录却一直空白」。
    console.warn('目录保存失败', e);
    toast('目录已更新，但保存失败（' + (e && e.message ? e.message : e) + '），刷新后可能丢失');
  }
}

async function renameChapter(i) {
  const c = R.chapters[i];
  if (!c) return;
  // 用原生 prompt：最顶层、iPad/桌面都稳定可用，不会再出现「弹窗点不到 / 关不掉」的情况。
  const v = window.prompt('重命名章节', c.title || '');
  if (v == null) return;                       // 取消
  const t = v.trim().slice(0, 40);
  if (!t) return;
  R.chapters[i].title = t;
  await saveChapters();
  renderTocList();
  toast('已改名');
}

async function delChapter(i) {
  const c = R.chapters[i];
  if (!c) return;
  const ok = await new Promise(res => showChoice('删除章节「' + c.title + '」？', ['删除', '取消'], 1, x => res(x === 0)));
  if (!ok) return;
  R.chapters.splice(i, 1);
  await saveChapters();
  renderTocList();
  toast('已删除');
}

/** 按原书重新提取目录（覆盖手动编辑，相当于「恢复」自动识别结果）。
    silent=true 时不弹确认框、不弹 toast，供「打开目录抽屉时自动补识别」静默调用。 */
async function reDetectChapters(silent) {
  if (!silent) {
    const ok = await new Promise(res => showChoice('重新识别会覆盖你手动改过的目录，按原书自动重新提取？',
      ['重新识别', '取消'], 1, x => res(x === 0)));
    if (!ok) return;
  }
  if (R.format === 'pdf') {
    try {
      const outline = await R.pdfDoc.getOutline();
      if (outline && outline.length) {
        // PDF 自带书签大纲（最准，跳转精确）：直接用它。
        // 标题同样尊重「保留原符号」：取消勾选时剥掉「第一章 / 1. / Chapter 3」这类前缀
        //（之前 PDF 分支完全没读这个开关 → 用户取消勾选后目录毫无变化，以为开关坏了）。
        const keepMk = !(typeof Settings !== 'undefined' && Settings && Settings.tocKeepMarker === false);
        R.chapters = flattenPdfOutline(outline).map(o => {
          const raw = String((o && o.title) || '（未命名）').replace(/\s+/g, ' ').trim();
          const t = keepMk ? raw : stripTocMarker(raw);
          return { title: t.slice(0, 60) || raw.slice(0, 60), dest: o && o.dest, level: (o && o.level) || 1 };
        });
      } else {
        // PDF 没嵌入大纲时退回纯文本正则识别（抽全本文字再跑 parseChapters），
        // 这样即使是「扫描版/无书签」的 PDF 也能尽量抽出章节，不再一片空白。
        const pages = (await pdfTextAll()) || [];
        R.chapters = parseChapters(pages.join('\n'));
      }
    } catch (e) {
      // 读大纲失败不能顺手把已有目录清空（之前 catch 里直接 =[]，
      // 一旦 R.pdfDoc 被销毁 / 文档加密，目录就永久变空 → 用户看到「说有 N 章、列表空的」）
      if (R.chapters && R.chapters.length) {
        toast('读取 PDF 目录失败：' + ((e && e.message) || e) + '（已保留原目录）');
      } else {
        R.chapters = [];
        toast('读取 PDF 目录失败：' + ((e && e.message) || e));
      }
    }
  } else if (R.format === 'html') {
    // 富文本：从已渲染的标题元素重建目录；并叠加自定义目录格式（tocCustom，支持 || 多规则 + x 占位符）
    const root = document.querySelector('#scrollInner .html-book') || document.querySelector('#scrollInner');
    const chaps = [];
    let auto = 0;
    const ensureId = (el) => { if (el.id) return el.id; el.id = 'ink-h-auto-' + (auto++); return el.id; };
    const custom = (typeof Settings !== 'undefined' && Settings.tocCustom && Settings.tocCustom.trim())
      ? Settings.tocCustom.split('||').map(compileTocRule).filter(Boolean)
      : [];
    const keepMarker = (typeof Settings !== 'undefined' && Settings.tocKeepMarker !== false);
    const matchCustom = (t) => {
      for (const rx of custom) { const cm = rx.exec(t); if (cm) return cm; }
      return null;
    };
    const titleFrom = (t, cm) => keepMarker ? t
      : (cm && cm[1] && cm[1].length <= 60 ? cm[1].trim() : stripTocMarker(t));
    if (root) {
      // 一趟按文档顺序扫，保证「内置标题」与「自定义补充块」交错时顺序正确。
      // 语义（用户 2026-10-20 明确）：
      //   勾「保留原符号」= 内置规则（h1/h2/h3）识别结果全保留，自定义格式只做**补充**；
      //   不勾 = 自定义格式是唯一判据（旧行为）。
      // 层级：优先按标题编号推断（第X章→1、1.1→2、A1（挂在 A 下）→2），推不出来才用标签层级。
      root.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, section, div').forEach(el => {
        const isH = /^H[1-6]$/.test(el.tagName);
        if (!isH) {
          if (!custom.length) return;                                  // 非标题块只在有自定义规则时才可能进目录
          if (el.querySelector('h1, h2, h3, h4, h5, h6, p, li, section, div')) return;  // 只取叶子块，避免整章容器重复收
        }
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t) return;
        if (!isH && t.length > 60) return;
        const cm = custom.length ? matchCustom(t) : null;
        if (custom.length && !cm) {
          // 自定义格式没命中：勾着「保留原符号」时，内置标题仍保留；否则丢弃
          if (!(isH && keepMarker)) return;
        }
        const id = ensureId(el);
        let lvl = isH ? (parseInt(el.tagName[1], 10) || 1) : 2;
        const nl = tocNumberLevel(t);
        if (nl) lvl = nl;                                            // 编号推断优先于标签层级
        chaps.push({ title: titleFrom(t, cm).slice(0, 40), offset: '#' + id, level: lvl });
      });
    }
    R.chapters = chaps;
  } else {
    // 文本类（txt / docx / epub 抽取后的纯文本）用同一套正则重新识别
    const text = (R.book.content && R.book.content.text) || R.text || '';
    R.chapters = parseChapters(text);
  }
  if (R.book) R.book.tocCleared = false;   // 重新识别成功：取消「用户清空」标记，避免后续打开又自愈重识别
  await saveChapters();
  renderTocList();
  if (!silent) toast(R.chapters.length ? ('已重新识别，共 ' + R.chapters.length + ' 章') : '重新识别后无目录');
}

async function gotoPdfDest(dest) {
  try {
    let d = dest;
    if (typeof d === 'string') d = await R.pdfDoc.getDestination(d);
    const ref = d[0];
    const idx = await R.pdfDoc.getPageIndex(ref);
    goToPage(idx);
  } catch (e) { toast('无法跳转到该章节'); }
}

function gotoLocator(loc) {
  // 富文本锚点：目录/书签存的是 '#h-N'（字符串），直接滚到对应标题元素
  if (typeof loc === 'string' && loc.charAt(0) === '#') {
    if (R.format === 'html') { htmlScrollToAnchor(loc.slice(1)); closeDrawers(); return; }
  }
  if (R.format === 'txt') {
    const off = parseInt(loc) || 0;
    if (Settings.direction === 'vertical') scrollToOffset(off);
    else goToPage(pageIndexForOffset(off));
  } else if (R.format === 'html') {
    // 数值 = 滚动百分比（书签/手动插入的目录项）
    htmlScrollToFraction(parseFloat(loc) || 0);
  } else {
    goToPage(parseInt(loc) || 0);
  }
  closeDrawers();
}

function pageIndexForOffset(off) {
  if (!R.pages.length) return 0;
  let lo = 0, hi = R.pages.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (R.pages[mid].start <= off) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** 富文本（html/epub/docx）按字符偏移滚动定位：遍历 .html-book 的 [data-off] 叶子块，
 *  找到含该偏移的块并滚到其顶部（含段内插值）。翻页模式则按字符比例估算目标屏。
 *  修 #12：之前 html 标注定位被 gotoLocator 当百分比 htmlScrollToFraction 处理，
 *  字符偏移巨大 → 永远跳到末页（"点击笔记/高光默认跳最后页"）。 */
/** 当前视口顶部（往下四分之一屏）所在的字符偏移。
    与「滚动百分比 / 页码」不同，这个值在翻页和滚动两种形态下含义完全一样，
    所以拿它当书签与阅读进度的锚点，切模式不会跑位。 */
/** 探测点离视口顶部多远（像素）。存位置和恢复位置必须用同一个值，
 *  否则「记下 → 滚回去 → 再记一次」每次都往后挪一个自然段（模式来回切会一段段飘走）。
 *  取视口高度的 28%（上限 240px）：以前写死 120px，在 800–1000 高的屏上只有 12–15%，
 *  跳过去的那段正好贴在顶栏下沿，用户读着像「偏到屏幕上方去了」（R105 反馈）。 */
function htmlProbeInset() {
  const layer = $('scrollLayer');
  if (!layer) return 0;
  // 落点定在屏幕高度 40% 处：28% 时目标段落贴着顶栏、上面只剩窄窄一条，
  // 读起来像是「跳到了屏幕最上方」（R106 用户两次反馈「还是偏上」）。
  // 存位置与恢复位置用的是同一个值，所以改这个比例不会带来模式切换的漂移。
  return Math.round(Math.min(380, Math.max(96, layer.clientHeight * 0.40)));
}

function htmlCurrentOffset() {
  const layer = $('scrollLayer');
  const root = document.querySelector('#scrollInner .html-book');
  if (!layer || !root) return 0;
  const blocks = root.querySelectorAll('[data-off]');
  if (!blocks.length) return 0;
  const lr = layer.getBoundingClientRect();
  const probe = lr.top + htmlProbeInset();
  let best = 0;
  for (const b of blocks) {
    const r = b.getBoundingClientRect();
    if (r.top <= probe) best = parseInt(b.dataset.off, 10) || 0;
    else break;                       // 块按文档顺序排列，后面的只会更靠下
  }
  return best;
}

/** 块内第 delta 个字符的**真实像素矩形**（相对视口）。
 *  以前用「块内字符比例 × 块高」插值，中文段落一行 30 个字、块高好几百像素，
 *  比例和实际换行位置对不上，跳过去总会偏几十像素（R105「偏了一点」）。
 *  直接让浏览器用 Range 标到那个字符，拿到的是排版后的真实位置。 */
function charRectInBlock(block, delta) {
  if (!block || delta <= 0) return null;
  let left = delta;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) {
    const len = (n.nodeValue || '').length;
    if (left > len) { left -= len; continue; }
    const at = Math.max(0, Math.min(len, left));
    const end = Math.min(len, at + 1);
    if (end <= at) return null;                 // 段落末尾之后
    try {
      const r = document.createRange();
      r.setStart(n, at);
      r.setEnd(n, end);
      const rect = r.getBoundingClientRect();
      if (rect && (rect.height > 0 || rect.width > 0)) return rect;
    } catch (e) { return null; }
    return null;
  }
  return null;
}

function htmlScrollToOffset(off) {
  const layer = $('scrollLayer');
  const root = document.querySelector('#scrollInner .html-book');
  if (!layer || !root) return;
  const blocks = Array.from(root.querySelectorAll('[data-off]'));
  if (!blocks.length) return;
  let target = blocks[0], tIdx = 0;
  for (let i = 0; i < blocks.length; i++) {
    const bo = parseInt(blocks[i].dataset.off, 10) || 0;
    if (bo <= off) { target = blocks[i]; tIdx = i; } else break;
  }
  if (Settings.htmlPaged) {
    // 翻页模式：用「含该偏移的块所在 .html-page」定位，避免把 data-off（DOM 累积偏移）
    // 错误除以 R.text.length（strip 后的纯文本长度，两套偏移量不可比）→ 永远跳末页（#13）。
    const pages = root.querySelectorAll('.html-page');
    const pg = target.closest('.html-page');
    if (pg && pages.length) {
      const idx = Array.prototype.indexOf.call(pages, pg);
      goToPage(Math.min(pages.length - 1, Math.max(0, idx)));
    }
    return;
  }
  // 滚动模式：用元素到滚动容器的**实际像素距离**算目标位置。
  // 不能用 offsetTop —— 它的参照系随 offsetParent 变化（翻页模式下块被塞进 .html-page），
  // 这是「笔记/书签定位错位、甚至跳到末页」的老根子。
  const to = parseInt(target.dataset.off, 10) || 0;
  const next = blocks[tIdx + 1];
  const no = next ? (parseInt(next.dataset.off, 10) || 0) : (to + 40);
  const lr = layer.getBoundingClientRect();
  const tr = target.getBoundingClientRect();
  const ratio = no > to ? (off - to) / (no - to) : 0;
  // 优先用 Range 量出这个字符的真实纵坐标；量不到（块里全是公式/图片）再退回比例插值。
  const cr = charRectInBlock(target, Math.max(0, off - to));
  const docY = cr
    ? (cr.top - lr.top) + layer.scrollTop
    : (tr.top - lr.top) + layer.scrollTop + (next ? (next.getBoundingClientRect().top - tr.top) : (tr.height + 12)) * Math.min(1, Math.max(0, ratio));
  // 减掉探测点高度：让「这个字符偏移」正好落在 htmlCurrentOffset() 会读到的位置，
  // 这样存一次、滚回去、再存一次得到的是同一个数（模式来回切不会累积漂移）。
  // +1px 是为了让块顶真正越过探测线：差 0.3px 时 htmlCurrentOffset 会判成上一个块，
  // 表现为「跳过去再记一次，位置退了一段」（R105）。
  layer.scrollTop = Math.max(0, docY - htmlProbeInset() + 1);
}

/** 标注（高亮/笔记）定位：按格式把字符偏移 / PDF 伪偏移正确映射到位置。
 *  txt → scrollToOffset / goToPage；html → htmlScrollToOffset；pdf → 伪偏移求页码。
 *  修 #12：替代标注抽屉「定位」按钮原 gotoLocator(a.start)（html 下把字符偏移当百分比跳末页）。 */
function gotoAnnotOffset(a) {
  if (!a) return;
  const start = parseInt(a.start, 10);
  if (isNaN(start)) return;
  if (R.format === 'txt') {
    if (Settings.direction === 'vertical') scrollToOffset(start);
    else goToPage(pageIndexForOffset(start));
  } else if (R.format === 'html') {
    htmlScrollToOffset(start);
  } else if (R.format === 'pdf') {
    goToPage(Math.min((R.totalPages || 1) - 1, Math.max(0, Math.floor(start / 1e7))));
  } else {
    goToPage(Math.min((R.totalPages || 1) - 1, Math.max(0, start)));
  }
  // 跳完让目标那几个字闪一下：分页模式只能跳到页，标记在页内哪儿全看排版
  flashAnnotMark(a);
  closeDrawers();
}

/* ============================================================
   书内搜索
   ============================================================ */
/** 把整本 PDF 的文字抽出来，按页缓存（只在第一次搜索 / 全本找扫描页时做）
 *  ⚠️ R70：不能用 `if (R._pdfText) return` 做「已提取」判断 —— OCR 完一页会往
 *  `R._pdfText[i]` 塞该页识别出的文字，数组就非空了，于是「整本提取」被误判成已完成，
 *  全本扫描页检测只看到识别过的那几页。改用独立的 R._pdfTextFull 标记。 */
async function pdfTextAll() {
  if (R._pdfTextFull && R._pdfText) return R._pdfText;
  if (!R.pdfDoc) return null;
  const out = [];
  for (let p = 1; p <= R.pdfDoc.numPages; p++) {
    const page = await R.pdfDoc.getPage(p);
    const tc = await page.getTextContent();
    out.push((tc.items || []).map(i => i.str || '').join(''));
    if (page.cleanup) page.cleanup();
  }
  // 与已有缓存合并：OCR 出来的那一页往往比文字层更全，别被空文本盖掉
  const prev = Array.isArray(R._pdfText) ? R._pdfText : [];
  for (let i = 0; i < out.length; i++) {
    const a = String(prev[i] || '').trim();
    if (a && a.length > String(out[i] || '').trim().length) out[i] = prev[i];
  }
  R._pdfText = out;
  R._pdfTextFull = true;
  return out;
}

/** 整本判断哪些页是「扫描页」（几乎没有文字层）——不依赖「这一页有没有翻到过」。
 *  R70 用户反馈：没翻到过的那一页，「一键识别全部扫描页」根本不认识它
 *  （因为 _scanPages 只在页面渲染后才登记），所以一键识别完还是没文字。
 *  这里直接读每页的文字层统计字数，薄的那几页就是扫描页。 */
async function detectAllScanPages() {
  if (!R.pdfDoc) return [];
  let texts = null;
  try { texts = await pdfTextAll(); } catch (e) { texts = null; }
  if (!texts) return Array.from(R._scanPages || []).sort((a, b) => a - b);
  const out = new Set();
  for (let i = 0; i < texts.length; i++) {
    const t = String(texts[i] == null ? '' : texts[i]).replace(/\s+/g, '');
    if (t.length < 30) out.add(i);        // 30 字以下：页眉/页码/水印级别，按扫描页处理
  }
  // 已经识别过的页不算「待识别」（识别结果缓存在 _ocrWords，或画布上已有 _ocrText）
  const stack = $('pdfStack');
  for (const i of Array.from(out)) {
    const cv = stack && stack.querySelector('.pdf-page[data-idx="' + i + '"]');
    if (cv && cv._ocrText) { out.delete(i); continue; }
    if (R._ocrWords && R._ocrWords[i]) out.delete(i);
  }
  return Array.from(out).sort((a, b) => a - b);
}

/* 命中的是什么：offset = 文字书里的字符位置；page = PDF 的页码 */
let _searchSeq = 0;

async function doSearch(q) {
  const seq = ++_searchSeq;
  R.searchHits = [];
  R._searchLen = q.length;
  R.searchIdx = -1;
  if (!q) {
    $('searchCount').textContent = '0 结果';
    if (R.format === 'html') renderHtmlPage();   // 清掉旧搜索高亮
    refreshPageContent();
    return;
  }

  if (R.format === 'comic') {
    // 图片书：识别过文字才有得搜。命中项是「页码」，和 PDF 的检索路径完全一样（_searchKind='page'），
    // 跳转走 goToPage —— 这里不要再直接 return「无文字」（旧行为：识别了也搜不到）。
    imgOcrState();
    if (!R._imgOcrPages.size) {
      R._searchKind = 'none';
      $('searchCount').textContent = '无文字';
      toast('这本图片书还没识别文字：点顶栏「🔍 OCR」识别后就能搜索');
      return;
    }
    R._searchKind = 'page';
    const ql0 = q.toLowerCase();
    Array.from(R._imgOcrPages).sort(function (a, b) { return a - b; }).forEach(function (i) {
      if (String(R._imgOcrText[i] || '').toLowerCase().includes(ql0)) R.searchHits.push(i);
    });
  } else if (R.format === 'txt') {
    R._searchKind = 'offset';
    let i = 0, cnt = 0;
    const lower = R.text.toLowerCase(), ql = q.toLowerCase();
    while ((i = lower.indexOf(ql, i)) !== -1 && cnt < 3000) {
      R.searchHits.push(i); i += q.length; cnt++;
    }
  } else if (R.format === 'pdf') {
    R._searchKind = 'page';
    $('searchCount').textContent = '正在提取全文…';
    const texts = await pdfTextAll();
    if (seq !== _searchSeq) return;                  // 又输入了新词，丢弃这次结果
    if (texts) {
      const ql = q.toLowerCase();
      texts.forEach((t, i) => { if (t.toLowerCase().includes(ql)) R.searchHits.push(i); });
    }
  } else if (R.format === 'html') {
    // 富文本：在已渲染 DOM 里做文本节点搜索，命中处包 .sr[data-hit]，跳转用 scrollIntoView
    R._searchKind = 'html';
    renderHtmlPage();                                // 重置内容，清掉旧高亮
    const n = htmlSearch(q);
    R.searchHits = Array.from({ length: n }, (_, i) => i);
    $('searchCount').textContent = n + ' 结果';
    if (n) gotoSearchHit(0);
    return;
  }
  $('searchCount').textContent = R.searchHits.length + ' 结果';
  refreshPageContent();
  if (R.searchHits.length) gotoSearchHit(0);
}

/**
 * 富文本搜索：遍历 .html-book 的文本节点，把每个命中片段包成
 * <span class="sr" data-hit="N">。返回命中总数（N）。
 * 跨文本节点的匹配会被忽略（基础搜索，够用）；script/style 已在导入时剥离。
 */
function htmlSearch(q) {
  const root = document.querySelector('.html-book');
  if (!root || !q) return 0;
  const ql = q.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      // 跳过已高亮 span 内的文本节点，避免重复包裹
      const p = n.parentNode;
      if (p && p.nodeType === 1 && p.classList && p.classList.contains('sr')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  let tn;
  while ((tn = walker.nextNode())) nodes.push(tn);
  let idx = 0;
  for (const node of nodes) {
    const val = node.nodeValue;
    const lower = val.toLowerCase();
    let from = 0, pos, last = 0, changed = false;
    const frag = document.createDocumentFragment();
    while ((pos = lower.indexOf(ql, from)) !== -1) {
      if (pos > last) frag.appendChild(document.createTextNode(val.slice(last, pos)));
      const span = document.createElement('span');
      span.className = 'sr';
      span.setAttribute('data-hit', String(idx++));
      span.textContent = val.slice(pos, pos + q.length);
      frag.appendChild(span);
      last = pos + q.length;
      from = pos + q.length;
      changed = true;
    }
    if (changed) {
      if (last < val.length) frag.appendChild(document.createTextNode(val.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }
  return idx;
}
function gotoSearchHit(delta) {
  if (!R.searchHits.length) return;
  R.searchIdx = (R.searchIdx + delta + R.searchHits.length) % R.searchHits.length;
  const hit = R.searchHits[R.searchIdx];

  // PDF：命中项是页码，跳过去并告诉用户是哪一页（画布上没法给文字加高亮）
  if (R._searchKind === 'page') {
    goToPage(hit);
    $('searchCount').textContent = `${R.searchIdx + 1} / ${R.searchHits.length} · 第 ${hit + 1} 页`;
    return;
  }

  // 富文本：命中项是 DOM 里的 .sr[data-hit]，直接滚到它
  if (R._searchKind === 'html') {
    const el = document.querySelector('.sr[data-hit="' + hit + '"]');
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.style.boxShadow = '0 0 0 2px #FF9500';
    }
    $('searchCount').textContent = `${R.searchIdx + 1} / ${R.searchHits.length}`;
    return;
  }

  const off = hit;
  gotoLocator(off);
  $('searchCount').textContent = `${R.searchIdx + 1} / ${R.searchHits.length}`;
  // 高亮当前命中：用 data-hit 精确定位，别用 spans[序号]
  // （一页只渲染当页内容，序号和全局结果序号对不上，会高亮错位置）
  setTimeout(() => {
    document.querySelectorAll('.sr').forEach(s => s.style.boxShadow = '');
    const el = document.querySelector('.sr[data-hit="' + R.searchIdx + '"]');
    if (el) {
      el.style.boxShadow = '0 0 0 2px #FF9500';
      el.scrollIntoView({ block: 'center' });
    }
  }, 80);
}

/* ============================================================
   抽屉
   ============================================================ */
function closeDrawers() {
  document.querySelectorAll('.drawer').forEach(d => d.classList.remove('show'));
  $('scrim').classList.remove('show');
}
function openDrawer(id) {
  closeDrawers();
  document.getElementById(id).classList.add('show');
  $('scrim').classList.add('show');
}
