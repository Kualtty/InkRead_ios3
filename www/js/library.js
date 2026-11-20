/* ============================================================
   library.js —— 书架
   ============================================================ */
/* 「文本小说」分类：这些格式的书会**自动归到这里**，不用用户手动建收藏夹。
   导入时按格式落库，这里只负责归类展示。 */
const TEXT_FORMATS = ['txt', 'docx', 'epub', 'html'];
const FORMAT_LABEL = { txt: 'TXT', docx: 'Word', epub: 'EPUB', pdf: 'PDF', comic: '漫画' };

/** 文件夹 scope 与书 format 的匹配。
 *  scope 为 'text' 时代表「文本小说类」——txt/docx/epub 都算（和「文本小说」分类一致）；
 *  其余 scope 是具体格式名（'comic' / 'pdf' / 'txt' …），直接相等即可。
 *  没有 scope 的普通文件夹不限制。 */
function fmtInScope(fmt, scope) {
  if (!scope) return true;
  if (scope === 'text') return TEXT_FORMATS.includes(fmt);
  return scope === fmt;
}

const Library = {
  all: [],
  filter: 'all',
  sort: 'recent',
  /* 排序方向：1 = 按这一档的默认方向，-1 = 反过来。
     每档自己的「自然方向」不一样（最近/加入/进度 = 新的在前，书名 = A→Z），
     所以这里存的是「相对默认翻不翻」，按钮只切 ±1，换档时不会被带偏。
     值持久化在 Settings.libSort / libSortDir，重开还是你上次选的。 */
  sortDir: 1,
  q: '',
  collections: [],
  selectMode: false,     // 批量选择模式
  selected: new Set(),   // 已选中的书 id
  visibleIds: [],        // 当前筛选后可见的书（全选 / 反选用它）
  folderManage: false,   // 收藏夹批量整理模式
  folderSel: new Set(),  // 已勾选的收藏夹 id
  tagFilter: new Set(),  // 标签筛选集合（所选标签）
  tagMode: 'or',         // 标签筛选模式：'or'=命中任一即显示；'and'=必须同时含全部所选标签
  _navHist: [],          // 「← 返回」用的浏览历史（进去过哪些视图），最多 20 条

  /** 返回全部书的去重标签，按中文排序，用于筛选条与编辑器提示 */
  allTags() {
    const s = new Set();
    for (const b of this.all) (b.tags || []).forEach(t => s.add(t));
    return Array.from(s).sort((a, b) => a.localeCompare(b, 'zh'));
  },

  /** 排序条的 UI 跟着当前视图 / 档位走：
      只有在收藏 / 收藏夹里才露出「手动」（别处没有拖动排出来的次序），
      方向按钮用 ↑/↓ 表示现在是从旧到新还是从新到旧。 */
  syncSortUi() {
    const fav = this.filter === 'fav' || String(this.filter).startsWith('coll:');
    const seg = document.getElementById('sortSeg');
    if (seg) {
      seg.querySelectorAll('.seg-btn').forEach(n => {
        const isManual = n.dataset.sort === 'manual';
        if (isManual) n.hidden = !fav;
        n.classList.toggle('active', n.dataset.sort === this.sort && (fav || !isManual));
      });
    }
    const d = document.getElementById('sortDirBtn');
    if (!d) return;
    // 每档的「默认方向」不一样：最近/加入/进度是新的在前，书名和手动是正序
    const baseDown = ['recent', 'added', 'progress'].indexOf(this.sort) >= 0;
    const down = baseDown ? this.sortDir !== -1 : this.sortDir === -1;
    d.textContent = down ? '↓' : '↑';
    const name = { recent: '最近阅读', added: '加入时间', title: '书名', progress: '进度', manual: '手动' }[this.sort] || '排序';
    d.title = name + (down ? '：新的 / 大的在前' : '：旧的 / 小的在前') + '（点一下换方向）';
  },

  /** 点击标签筛选：再次点同一个则取消；空集合表示不过滤 */
  toggleTagFilter(tag) {
    if (this.tagFilter.has(tag)) this.tagFilter.delete(tag);
    else this.tagFilter.add(tag);
    this.render();
  },
  clearTagFilter() { this.tagFilter.clear(); },

  /** 老版本把 .md 当纯文本存进来的书，一次性转成富文本（标题/列表/表格按 Markdown 排版）。
   *  以前只在「打开这本书」时才迁移，于是书架上明明都是 .md 导入的，
   *  有的显示「文本」有的显示「富文本」，用户会以为导入方式不一样。
   *  这里在书库加载后扫一遍，等于「都打开过」，标签也就统一了。 */
  async migrateMarkdownOnce() {
    if (this._mdMigrated) return 0;
    this._mdMigrated = true;
    let n = 0;
    // ① 老 .md 被存成纯文本（format:'txt'）→ 转富文本
    if (typeof Importer !== 'undefined' && Importer.convertLegacyMarkdown) {
      for (const b of this.all) {
        if (!b || b.format !== 'txt') continue;
        if (!Importer.convertLegacyMarkdown(b)) continue;
        try { await DB.put('books', b); n++; } catch (e) { console.warn('Markdown 迁移失败', b.title, e); }
      }
    }
    // ② 已经是富文本、但正文里 $$ 还是「原样文字」的老书 —— 用存着的 markdown 源码重解析一遍。
    //    改 importer 只对「以后新导入」生效，书库里已经生成的 content.html 不会自己变，
    //    所以修好公式后用户打开旧书还是看不到公式（「矩阵的还是不行」就是这么来的）。
    //    判据只看「html 里还有 $$ 字面」：重解析过的 html 里公式已经变成 <span class="ink-math">，
    //    不含 $$，所以这段是幂等的，不会每次启动都重写全书。
    if (typeof Importer !== 'undefined' && Importer.mdToBook) {
      let m = 0;
      for (const b of this.all) {
        const c = b && b.content;
        if (!b || b.format !== 'html' || !c || !c.md || !c.html) continue;
        if (String(c.html).indexOf('$$') < 0) continue;
        try {
          const r = Importer.mdToBook(c.md, b.title);
          if (!r || !r.html) continue;
          // 只换正文与目录，标题保留书库里原来的（用户可能改过名）。
          // 第一次重解析时把旧 html 留在 htmlBak 里 —— 万一排版不如原来，还能拿回来。
          b.content = Object.assign({}, c, { html: r.html, htmlBak: c.htmlBak || c.html });
          if (r.chapters && r.chapters.length) b.chapters = r.chapters;
          await DB.put('books', b); m++;
        } catch (e) { console.warn('公式重解析失败', b.title, e); }
      }
      if (m) {
        n += m;
        if (typeof toast === 'function') toast(`已把 ${m} 本 Markdown 的公式重新排版（含矩阵）`, 6000);
      }
    }
    if (n) await this.refresh();
    return n;
  },

  async refresh() {
    this.all = await DB.getAll('books');
    // 书单现在就是磁盘真相 → 之前「先占个号」的临时记录作废，
    // 免得删掉一本书之后那个序号还被占着（下次导入会莫名从（2）开始）
    titleTakenReset();
    // 兜底：collections 可能被同步/旧数据写成 null，渲染处会读 .length 直接崩
    this.collections = (await DB.kvGet('collections', [])) || [];
    this.render();
  },

  /** 把库里已经存在的同名书补上序号（先入库的保留原名），返回改了哪些。
      R133：导入 / 改名 / 共享 / 恢复四条路都已在 uniqueBookTitle 里拦住，
      这里专门清历史遗留 —— 老书库里那些重复导入留下的重名。 */
  async dedupeTitles() {
    const list = this.all.slice().sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    const seen = new Set();
    const changed = [];
    for (const b of list) {
      if (!b) continue;
      const cur = String(b.title == null ? '' : b.title).trim() || '未命名';
      const k = titleKey(cur);
      if (!seen.has(k)) { seen.add(k); continue; }        // 第一个用这个名字的保留原样
      const base = titleBase(cur);
      let n = 1;
      while (n < 1000 && seen.has(titleKey(base + '（' + n + '）'))) n++;
      const to = base + '（' + n + '）';
      seen.add(titleKey(to));
      changed.push({ id: b.id, from: cur, to });
      b.title = to;
      await DB.put('books', b);
    }
    return changed;
  },

  /* ---------------- 文件夹导航：返回上一级 / 面包屑 ---------------- */
  /* 用户反馈（R56）：在大屏里点进「文本小说 / A / A1」这种嵌套文件夹后，想回上一层
     只能从侧栏顶重新找，深了根本找不到路。这里给标题栏加「←」+ 面包屑：
       - 「←」退一层（父文件夹 → 所属分类大屏 → 书库）
       - 面包屑每一段都可点，直接跳回那一层
     不再依赖侧栏折叠状态，也不用记住自己是第几层。 */

  /** 当前所在文件夹链（由根到当前）；不在文件夹里返回 []。
   *  带环保护：最多 30 层，且遇到重复 id 就停（parent 被误设成环时不至于卡死页面）。 */
  collChain() {
    if (!this.filter.startsWith('coll:')) return [];
    return this._chainOf(this.filter.slice(5));
  },

  /** 某个文件夹的祖先链（由根到自身）；带环保护：最多 30 层，遇重复 id 就停 */
  _chainOf(id) {
    const byId = new Map(this.collections.map(c => [c.id, c]));
    const out = [];
    let cur = byId.get(id);
    let guard = 0;
    while (cur && guard++ < 30 && !out.some(x => x.id === cur.id)) {
      out.unshift({ id: cur.id, name: cur.name || '未命名', scope: cur.scope || null });
      cur = cur.parent ? byId.get(cur.parent) : null;
    }
    return out;
  },

  /** 最顶层文件夹属于哪个分类大屏（决定退到底时回到「文本小说」还是「书库」） */
  rootViewFor(c) {
    const sc = c && c.scope;
    if (!sc) return 'all';
    if (sc === 'comic' || sc === 'pdf') return sc;
    if (sc === 'text' || TEXT_FORMATS.includes(sc)) return 'text';
    return 'all';
  },

  /** 上一级视图：父文件夹 → 所属分类 / 书库 */
  navUpView() {
    const chain = this.collChain();
    if (!chain.length) return null;
    if (chain.length > 1) return 'coll:' + chain[chain.length - 2].id;
    return this.rootViewFor(this.collections.find(x => x.id === chain[0].id));
  },

  viewLabel(v) {
    if (!v) return '书库';
    if (v.startsWith('coll:')) {
      const c = this.collections.find(x => x.id === v.slice(5));
      return (c && c.name) || '收藏夹';
    }
    return { all: '书库', reading: '在读', fav: '收藏', text: '文本小说', comic: '漫画', pdf: 'PDF' }[v] || '书库';
  },

  /** 这个文件夹在某个视图里「看得见」吗（PDF 视图只认 pdf 夹，文本小说认 text / 无 scope） */
  _inView(c, view) {
    if (!c) return false;
    if (view === 'pdf') return c.scope === 'pdf';
    if (view === 'comic') return c.scope === 'comic';
    if (view === 'text') return !c.scope || c.scope === 'text' || TEXT_FORMATS.includes(c.scope);
    return true;                                      // all：全都看得见
  },

  /** 进入某个视图的唯一入口：切 filter → 等数据齐 → 把侧栏里折叠的祖先展开 → 重绘
   *  opts.hist === false 时不记历史（侧栏一级分类切换、删除文件夹后的归位等，
   *  这些属于「换了个地方」，不该出现在返回链里）。 */
  async enterView(v, opts) {
    if (!v || v === this.filter) {
      this.filter = v || this.filter;
      await this.refresh();
      return;
    }
    if (!opts || opts.hist !== false) {
      const prev = this.filter;
      this._navHist.push(prev);
      if (this._navHist.length > 20) this._navHist.shift();
      /* 从「分类大屏」直接点进一个深层文件夹（例如在书库里点 A/A1）：把路径上的祖先
         也压进历史，这样「←」是逐级往上走，而不是一步跳回分类。
         但只压**在这个视图里看得见**的祖先：从 PDF 点进 A（A 的 parent 是文本类 B），
         B 不在 PDF 视图里，就不该出现，退一步直接回到 PDF（R57 用户实测）。 */
      if (v.startsWith('coll:') && prev && !prev.startsWith('coll:')) {
        const chain = this._chainOf(v.slice(5));
        const anc = chain.slice(0, -1).filter(c => this._inView(c, prev));
        const top = this.collections.find(c => c.id === (chain[0] && chain[0].id));
        // 「全部/书库」进来的：退到底回到文件夹自己的分类（文本小说 / 漫画 / PDF）
        const base = prev === 'all' ? this.rootViewFor(top) : prev;
        this._navHist.pop();                          // 换成带中间层的那一串
        this._navHist.push(base);
        anc.forEach(c => this._navHist.push('coll:' + c.id));
        while (this._navHist.length > 20) this._navHist.shift();
      }
    }
    this.filter = v;
    await this.refresh();
    if (v && v.startsWith('coll:') && this.expandAncestors(v.slice(5))) {
      await DB.kvSet('collections', this.collections);
      this.renderCollections();
    }
  },

  /** 侧栏一级分类 / 标签等「根视图」切换：不进入返回链，并清空历史
   *  （用户从「PDF」点进文件夹 A，A 的 parent 可能是个毫不相干的 B；
   *   在那里按「←」应该回到 PDF，而不是被父子关系带去 B。R57 用户实测。） */
  async setRootView(v) {
    this._navHist = [];
    this.filter = v;
    await this.refresh();
  },

  /** 展开某个文件夹的所有祖先（不然从面包屑跳回来时，侧栏里那一条是隐藏的） */
  expandAncestors(id) {
    const byId = new Map(this.collections.map(c => [c.id, c]));
    let cur = byId.get(id), guard = 0, changed = false;
    while (cur && guard++ < 30) {
      if (cur.id !== id && cur.collapsed) { cur.collapsed = false; changed = true; }
      cur = cur.parent ? byId.get(cur.parent) : null;
    }
    return changed;
  },

  /** 「← 返回」：优先回到**刚才那一处**（浏览历史），没有历史才按父子关系退一级。
   *  这样「从 PDF 点进 A（A 的父文件夹是 B）」返回的是 PDF，不是 B。 */
  goUp() {
    const prev = this._navHist.pop();
    if (prev && prev !== this.filter) {
      this.enterView(prev, { hist: false });
      return;
    }
    const up = this.navUpView();
    if (!up || up === this.filter) return;
    this.enterView(up, { hist: false });
  },

  /** 面包屑的起点：历史里离当前最近的那个「分类大屏」（它不是当前路径上的文件夹），
   *  没有历史才按文件夹真实归属 */
  navOrigin() {
    const chain = this.collChain();
    if (!chain.length) return null;
    const ids = new Set(chain.map(c => 'coll:' + c.id));
    for (let i = this._navHist.length - 1; i >= 0; i--) {
      const v = this._navHist[i];
      if (v && !ids.has(v)) return v;               // 最近的非路径视图 = 你从哪进来的
    }
    if (this._navHist.length && this._navHist[this._navHist.length - 1]) {
      return this._navHist[this._navHist.length - 1];
    }
    return this.rootViewFor(this.collections.find(x => x.id === chain[0].id));
  },

  /** 标题区：返回按钮 + 面包屑（只在文件夹里出现；一级分类/书库时完全隐藏） */
  renderLibNav() {
    const back = $('libBack'), crumb = $('libCrumb');
    const chain = this.collChain();
    const origin = this.navOrigin();
    if (back) {
      back.hidden = !chain.length;
      if (chain.length) {
        const target = this._navHist.length ? this._navHist[this._navHist.length - 1] : this.navUpView();
        back.title = '返回「' + this.viewLabel(target) + '」';
        back.onclick = () => this.goUp();
      }
    }
    if (!crumb) return;
    if (!chain.length) { crumb.hidden = true; crumb.innerHTML = ''; return; }
    // 面包屑只显示「和当前视图同类」的那一段路：从 PDF 点进 A（A 物理上在文本类 B 里）时
    // 显示「PDF / A」，不显示「PDF / B / A」——B 只是磁盘上的父目录、不在 pdf 视图里，
    // 摆进路径会让用户以为自己在文本分类下（R57 用户实测）。
    let show = chain;
    const k = chain.findIndex(c => this._inView(c, origin));
    if (k > 0) show = chain.slice(k);
    const parts = ['<span class="lc-item" data-view="' + origin + '">' + esc(this.viewLabel(origin)) + '</span>'];
    show.forEach((c, i) => {
      const last = i === show.length - 1;
      parts.push('<span class="lc-sep">/</span>');
      parts.push('<span class="lc-item' + (last ? ' lc-here' : '') + '" data-view="coll:' + c.id + '">'
        + esc(c.name) + '</span>');
    });
    crumb.innerHTML = parts.join('');
    crumb.hidden = false;
    crumb.querySelectorAll('[data-view]').forEach(el => {
      el.onclick = () => {
        const v = el.dataset.view;
        if (v && v !== this.filter) this.enterView(v);
      };
    });
  },

  /* ---------------- 批量选择 ---------------- */
  setSelectMode(on) {
    this.selectMode = !!on;
    if (!this.selectMode) this.selected.clear();
    const bar = $('bulkBar');
    if (bar) bar.hidden = !this.selectMode;
    const btn = $('selectBtn');
    if (btn) {
      btn.textContent = this.selectMode ? '✕ 退出选择' : '☑︎ 选择';
      btn.classList.toggle('on', this.selectMode);
    }
    const grid = $('bookGrid');
    if (grid) grid.classList.toggle('selecting', this.selectMode);
    this.render();
  },

  /** 只保留当前可见的书，避免删除/移动到看不见的书 */
  _prune() {
    for (const id of Array.from(this.selected)) {
      if (!this.visibleIds.includes(id)) this.selected.delete(id);
    }
  },

  _pick(mode) {
    const vis = this.visibleIds;
    if (mode === 'all') vis.forEach(id => this.selected.add(id));
    else if (mode === 'none') this.selected.clear();
    else vis.forEach(id => this.selected.has(id) ? this.selected.delete(id) : this.selected.add(id));
    this.render();
  },

  selectAll() { this._pick('all'); },
  selectNone() { this._pick('none'); },
  selectInvert() { this._pick('invert'); },

  toggleSelect(id) {
    this.selected.has(id) ? this.selected.delete(id) : this.selected.add(id);
    this.render();
  },

  /** 当前选中的书对象（按书架上看到的顺序，合并时要用到） */
  selectedBooks() {
    const set = this.selected;
    const byVis = this.visibleIds
      .filter(id => set.has(id))
      .map(id => this.all.find(b => b.id === id))
      .filter(Boolean);
    const rest = this.all.filter(b => set.has(b.id) && this.visibleIds.indexOf(b.id) < 0);
    return byVis.concat(rest);
  },

  updateBulkCount() {
    const el = $('bulkCount');
    if (!el) return;
    const n = this.selected.size;
    el.textContent = n ? `已选 ${n} 本` : '未选择（点书封勾选）';
    const inScope = (this.filter === 'fav' || this.filter.startsWith('coll:'));
    ['bulkMove', 'bulkMerge', 'bulkFav', 'bulkShare', 'bulkDel'].forEach(id => {
      const b = $(id);
      if (b) b.disabled = !n;
    });
    // 次序调整只在收藏夹 / 收藏视图有意义（其余视图按最近/书名等排序，手动次序不生效）
    ['bulkTop', 'bulkUp', 'bulkDown'].forEach(id => {
      const b = $(id);
      if (b) { b.hidden = !(inScope && n); b.disabled = !n || !inScope; }
    });
  },

  /* ============================================================
     漫画页面管理：调顺序 / 拆分 / 删页
     ============================================================ */
  /**
   * 漫画的笔记/书签/笔迹都是按**页号**定位的，页面一重排就必须跟着搬家，
   * 否则合并或拆分之后它们会全部错位甚至被当成垃圾删掉。
   *
   * @param {string} fromId  原书
   * @param {Object} map     页号映射 { 原下标: 新下标 }；不在 map 里的页视为"这一页没了"
   * @param {Object} opt     { toId } 迁移到另一本书；{ move } 同时从原书删掉
   * @returns {number} 迁移的条数
   */
  async _remapComicAnnots(fromId, map, opt) {
    const toId = opt && opt.toId;
    const move = !!(opt && opt.move);
    const list = await Annot.list(fromId);
    let moved = 0;
    const fix = (o, bid, ni) => {
      if (o.type === 'ink') { o.key = bid + ':p' + ni; return; }
      o.pageIndex = ni;
      o.locator = String(ni);
      if (/^第 \d+ 页$/.test(o.excerpt || '')) o.excerpt = `第 ${ni + 1} 页`;
    };
    for (const a of list) {
      let idx;
      if (a.type === 'ink') {
        const tail = String(a.key || '').split(':')[1] || '';
        idx = parseInt(tail.replace(/^p/, ''), 10);
      } else if (a.pageIndex != null) {
        idx = a.pageIndex;
      } else {
        idx = parseInt(a.locator, 10);
      }
      if (idx == null || Number.isNaN(idx)) continue;

      if (!(idx in map)) {
        // 这一页没了：原地整理时删掉，迁移到别的书时保持不动
        if (move && !toId) await Annot.remove(a.id);
        continue;
      }
      const ni = map[idx];
      if (toId) {
        const c = Object.assign({}, a);
        delete c.id;
        c.bookId = toId;
        fix(c, toId, ni);
        await Annot.add(c);
        moved++;
        if (move) await Annot.remove(a.id);
      } else {
        fix(a, fromId, ni);
        await Annot.add(a);
        moved++;
      }
    }
    return moved;
  },

  /** 按"留下的页"算出页号映射表 */
  _pageMap(items, keepIdx) {
    const map = {};
    let k = 0;
    items.forEach((it, i) => { if (keepIdx.indexOf(i) >= 0) map[i] = k++; });
    return map;
  },
  _pm: { book: null, sel: new Set() },

  /** 打开《书名》的页面管理面板 */
  pageManager(bookId) {
    const b = this.all.find(x => x.id === bookId);
    if (!b || b.format !== 'comic') { toast('只有漫画 / 图片书能管页面'); return; }
    this._pm = { book: b, sel: new Set() };
    $('pageSheetTitle').textContent = b.title;
    $('pageSheet').hidden = false;
    this.renderPages();
  },

  renderPages() {
    const { book, sel } = this._pm;
    if (!book) return;
    const items = (book.content && book.content.items) || [];
    $('pageSheetCount').textContent = items.length + ' 页';
    $('pgCount').textContent = sel.size ? `已选 ${sel.size} 页` : '未选择';
    const grid = $('pageGrid');
    grid.innerHTML = items.map((it, i) => `
      <div class="pg-item${sel.has(i) ? ' sel' : ''}" data-i="${i}">
        <img src="${blobUrl(it.blob)}" alt="">
        <div class="pg-no">${i + 1}</div>
        <div class="pg-name" title="${esc(it.name || '')}">${esc(it.name || '')}</div>
        <div class="pg-acts">
          <button class="pg-btn" data-mv="-1" title="上移">↑</button>
          <button class="pg-btn" data-mv="1" title="下移">↓</button>
          <button class="pg-btn danger" data-del="1" title="删除这一页">✕</button>
        </div>
      </div>`).join('');

    grid.querySelectorAll('.pg-item').forEach(el => {
      const i = parseInt(el.dataset.i, 10);
      el.onclick = (e) => {
        const mv = e.target.closest('[data-mv]');
        const del = e.target.closest('[data-del]');
        if (mv) { this.pageMove(i, parseInt(mv.dataset.mv, 10)); return; }
        if (del) { this.pageDelete([i]); return; }
        sel.has(i) ? sel.delete(i) : sel.add(i);
        this.renderPages();
      };
    });
  },

  _savePages(msg) {
    const b = this._pm.book;
    if (!b) return;
    b.length = b.content.items.length;
    b.totalPages = b.content.items.length;
    b.locator = Math.min(b.locator || 0, Math.max(0, b.content.items.length - 1));
    DB.put('books', b).then(() => {
      if (msg) toast(msg);
      this.renderPages();
      this.refresh();
    });
  },

  /**
   * 页面重排（↑↓ / 按名排序 / 反转）时，笔记书签要跟着页面一起换位置。
   * 做法：重排前给每页记下旧下标，重排后拿它算出新下标。
   */
  async _reorderPages(mutate) {
    const b = this._pm.book;
    const items = b.content.items;
    items.forEach((it, i) => { it._oi = i; });
    mutate(items);
    const map = {};
    items.forEach((it, j) => { map[it._oi] = j; delete it._oi; });
    await this._remapComicAnnots(b.id, map, {});
  },

  /** 单页挪动（↑↓） */
  async pageMove(i, d) {
    const items = this._pm.book.content.items;
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    await this._reorderPages(arr => { const t = arr[i]; arr[i] = arr[j]; arr[j] = t; });
    this._pm.sel.clear();
    this._savePages();
  },

  async pageSortByName() {
    await this._reorderPages(arr =>
      arr.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh', { numeric: true })));
    this._pm.sel.clear();
    this._savePages('已按文件名重排');
  },

  async pageReverse() {
    await this._reorderPages(arr => arr.reverse());
    this._pm.sel.clear();
    this._savePages('已反转顺序');
  },

  pageAll() {
    const n = this._pm.book.content.items.length;
    for (let i = 0; i < n; i++) this._pm.sel.add(i);
    this.renderPages();
  },

  pageNone() { this._pm.sel.clear(); this.renderPages(); },

  /** 删掉指定页（下标数组） */
  async pageDelete(idxs) {
    const b = this._pm.book;
    const items = b.content.items;
    const uniq = Array.from(new Set(idxs)).sort((a, x) => x - a);
    if (!uniq.length) return;
    if (items.length - uniq.length <= 0) {
      if (!confirm('删完这本就一页都不剩了，整本书会被删除。继续吗？')) return;
    }
    if (!confirm(`删除 ${uniq.length} 页？此操作不可撤销。`)) return;
    // 先算好留下的页怎么重编号，把笔记书签跟着挪，再真正删页
    const mapOld = this._pageMap(items, items.map((_, i) => i).filter(i => uniq.indexOf(i) < 0));
    await this._remapComicAnnots(b.id, mapOld, { move: true });
    for (const i of uniq) items.splice(i, 1);
    this._pm.sel.clear();
    if (!items.length) {
      await Annot.removeBook(b.id);
      await DB.del('books', b.id);
      $('pageSheet').hidden = true;
      toast('这本书已经空了，已删除');
      this.refresh();
      return;
    }
    this._savePages(`已删除 ${uniq.length} 页`);
  },

  /** 把勾选的页拆成一本新书（从原书里移走） */
  async pageSplit() {
    const b = this._pm.book;
    const items = b.content.items;
    const idxs = Array.from(this._pm.sel).sort((a, x) => a - x);
    if (!idxs.length) { toast('先勾选要拆出去的页'); return; }
    if (idxs.length === items.length) { toast('全选等于没拆，至少留一页在原书里'); return; }
    const defName = b.title + '（拆分）';
    showInput('新书的名字', defName, async (name) => {
      if (name == null) return;
      const picked = idxs.map(i => items[i]);
      const nb = {
        id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        title: (name || '').trim() || defName,
        format: 'comic',
        content: { kind: 'images', items: picked },
        length: picked.length, totalPages: picked.length,
        locator: 0, progress: 0,
        addedAt: Date.now(), lastReadAt: Date.now(),
        fav: !!b.fav, collection: b.collection || null,
        color: b.color || null, chapters: []
      };
      await DB.put('books', nb);

      // 笔记书签跟着页面走：拆走的页搬到新书，留下的页在原书里重新编号
      const mapNew = {};
      idxs.forEach((oi, k) => { mapNew[oi] = k; });
      const mapOld = this._pageMap(items, items.map((_, i) => i).filter(i => idxs.indexOf(i) < 0));
      let moved = await this._remapComicAnnots(b.id, mapNew, { toId: nb.id, move: true });
      await this._remapComicAnnots(b.id, mapOld, { move: true });

      for (const i of idxs.slice().sort((a, x) => x - a)) items.splice(i, 1);
      this._pm.sel.clear();
      $('pageSheet').hidden = true;
      toast(`已拆出《${nb.title}》（${picked.length} 页），原书剩 ${items.length} 页` +
        (moved ? `，笔记书签已跟着搬过去 ${moved} 条` : ''));
      this._savePages();
    });
  },

  async bulkMove() {
    const list = this.selectedBooks();
    if (!list.length) { toast('还没选书'); return; }
    const opts = ['📚 书库（移出收藏夹）'].concat(this.collections.map(c => c.name));
    showChoice(`把 ${list.length} 本书移到哪里？`, opts, 0, async (i) => {
      const cid = i === 0 ? null : this.collections[i - 1].id;
      for (const b of list) { b.collection = cid; await DB.put('books', b); }
      toast(`已移动 ${list.length} 本`);
      this.refresh();
    });
  },

  /**
   * 把分开导入的几本漫画 / 图片书合并成一本。
   * 典型场景：先导入 01.jpg，又导入 02.jpg，成了两本书 —— 这里把它们拼回一本。
   */
  async bulkMerge() {
    const list = this.selectedBooks();
    const comics = list.filter(b => b.format === 'comic');
    if (comics.length < 2) {
      toast(list.length ? '合并只支持漫画 / 图片书，请勾选 2 本以上' : '请先勾选要合并的书');
      return;
    }
    const skipped = list.length - comics.length;
    const pages = comics.reduce((a, b) =>
      a + ((b.content && b.content.items) ? b.content.items.length : 0), 0);
    if (!pages) { toast('这几本里没有图片页'); return; }

    const def = comics[0].title;
    showInput('合并后的书名', def + `（合辑 ${pages} 页）`, (title) => {
      if (title == null) return;
      showChoice('页面怎么排序？', [
        '按书架上的顺序依次拼接（各本内部顺序不变）',
        '全部页面按文件名重新排序（推荐：01、02、03…）'
      ], 1, async (orderMode) => {
        // 带上来源，页面重排后才知道每页的笔记该搬到哪一页
        let items = [];
        for (const b of comics) {
          ((b.content && b.content.items) || []).forEach((it, idx) => {
            items.push({ name: it.name, blob: it.blob, _bid: b.id, _idx: idx });
          });
        }
        if (orderMode === 1) {
          items.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh', { numeric: true }));
        }
        // 原书页号 → 合辑页号
        const maps = {};
        items.forEach((it, j) => { (maps[it._bid] = maps[it._bid] || {})[it._idx] = j; });
        const clean = items.map(it => ({ name: it.name, blob: it.blob }));
        const name = (title || '').trim() || def;
        const base = comics[0];
        const merged = {
          id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          title: name,
          format: 'comic',
          content: { kind: 'images', items: clean },
          length: clean.length,
          totalPages: clean.length,
          locator: 0,
          progress: 0,
          addedAt: Date.now(),
          lastReadAt: Date.now(),
          fav: !!base.fav,
          pinned: !!base.pinned,
          collection: base.collection || null,
          color: base.color || null,
          cover: base.cover || null,
          chapters: []
        };
        await DB.put('books', merged);

        const delOld = confirm(
          `已合并为《${name}》，共 ${items.length} 页。\n\n` +
          `【确定】= 同时删除原来的 ${comics.length} 本\n` +
          `【取消】= 保留原书，只新增合并本`);
        let moved = 0;
        if (delOld) {
          if (!confirm(
            `再次确认：原来的 ${comics.length} 本将被删除。\n\n` +
            `它们的笔记 / 书签 / 笔迹会按新页号一起搬进《${name}》，不会丢失。\n\n` +
            `确定继续吗？`)) {
            toast('已合并，原书保留');
            this.selected.clear();
            this.refresh();
            return;
          }
          for (const b of comics) {
            // 先按"原书页号 → 合辑页号"把标注搬进合辑，再删原书
            moved += await this._remapComicAnnots(b.id, maps[b.id] || {}, { toId: merged.id, move: true });
            await Annot.removeBook(b.id);   // 兜底：清掉个别没法定位的残留
            await DB.del('books', b.id);
          }
        }
        toast(delOld
          ? `已合并 ${comics.length} 本 → ${items.length} 页` + (moved ? `，笔记书签迁移 ${moved} 条` : '')
          : `已生成合辑《${name}》${items.length} 页` + (skipped ? `（跳过 ${skipped} 本非漫画）` : ''));
        this.selected.clear();
        this.refresh();
      });
    });
  },

  async bulkFav(on) {
    const list = this.selectedBooks();
    if (!list.length) { toast('还没选书'); return; }
    const want = on == null ? !list.every(b => b.fav) : on;
    for (const b of list) { b.fav = want; await DB.put('books', b); }
    toast(want ? `已收藏 ${list.length} 本` : `已取消收藏 ${list.length} 本`);
    this.refresh();
  },

  /** 批量打标签：把输入的标签加到所选每本书（并集，不删原有标签） */
  bulkTag() {
    const list = this.selectedBooks();
    if (!list.length) { toast('还没选书'); return; }
    this.openTagEditor(list, true);
  },

  /**
   * 标签编辑器（单书全量编辑 / 批量加标共用）。
   * @param {Object[]} books  目标书
   * @param {boolean} bulk    true=批量加标（保留原标签，并集）；false=单书全量编辑
   */
  openTagEditor(books, bulk) {
    const list = books.filter(Boolean);
    if (!list.length) { toast('还没选书'); return; }
    // 工作集：单书=该书当前标签；批量=空（只增不删，录入即「要加的标签」）
    const set = new Set(bulk ? [] : (list[0].tags || []));
    this._tagEdit = { books: list, bulk, set };
    $('tagSheetTitle').textContent = bulk
      ? `加标签到 ${list.length} 本书`
      : `编辑《${list[0].title}》的标签`;
    $('tagSheetHint').textContent = bulk
      ? '输入标签后回车/逗号添加，将并入所选各书（不改动原有标签）'
      : '输入标签后回车/逗号添加；点芯片上的 × 可删除';
    this.renderTagChips();
    $('tagInput').value = '';
    $('tagSheet').hidden = false;
    // 打开即显示「已有标签」建议（点选即加），避免要输入才刷出来的情况（#14）
    this.renderTagSuggestions('');
    setTimeout(() => { try { $('tagInput').focus(); } catch (e) {} }, 60);
  },

  renderTagChips() {
    const box = $('tagChips');
    if (!box || !this._tagEdit) return;
    const set = this._tagEdit.set;
    if (!set.size) {
      box.innerHTML = '<span class="tag-empty">（暂无标签）</span>';
      return;
    }
    const arr = Array.from(set).sort((a, b) => a.localeCompare(b, 'zh'));
    box.innerHTML = arr.map(t =>
      `<span class="tag-chip tag-edit" data-tag="${esc(t)}">${esc(t)}<button class="tag-x" data-tag="${esc(t)}" title="移除">×</button></span>`
    ).join('');
    this.renderTagSuggestions();
  },

  /** 列出已有标签（在全部标签里、但还没加进当前工作集的），供用户直接点选添加。
   * 输入框有内容时按输入做前缀/包含过滤；已选中的标签用删除线样式提示。 */
  renderTagSuggestions(q) {
    const box = $('tagSuggest');
    if (!box || !this._tagEdit) return;
    const set = this._tagEdit.set;
    const all = this.allTags();
    const kw = (q || '').trim().toLowerCase();
    const sug = all.filter(t => !set.has(t) && (!kw || t.toLowerCase().includes(kw)));
    if (!sug.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = `<span class="tag-suggest-label">已有标签（点选添加）：</span>` + sug.map(t =>
      `<button class="chip tag-sug" data-tag="${esc(t)}" title="添加到当前书">${esc(t)}</button>`
    ).join('');
  },

  /** 应用：单书=写入精确集合；批量=并集到每本书 */
  async applyTagEdit() {
    const ed = this._tagEdit;
    if (!ed) return;
    // R62：输入框里「还没回车」的那一段也要算上。
    // 用户常态是打完标签直接点「完成」，以前会静默丢掉这个标签（全流程测试发现）。
    const inp = $('tagInput');
    if (inp && inp.value.trim()) {
      String(inp.value).split(/[,，、]/).map(s => s.trim()).filter(Boolean)
        .forEach(t => ed.set.add(t));
      inp.value = '';
      this.renderTagChips();
    }
    const arr = Array.from(ed.set);
    for (const b of ed.books) {
      if (ed.bulk) {
        const cur = new Set(b.tags || []);
        arr.forEach(t => cur.add(t));
        b.tags = Array.from(cur);
      } else {
        b.tags = arr.slice();
      }
      await DB.put('books', b);
    }
    toast(ed.bulk ? `已为 ${ed.books.length} 本加标签` : '标签已保存');
    $('tagSheet').hidden = true;
    this._tagEdit = null;
    this.refresh();
  },

  async bulkDelete() {
    const list = this.selectedBooks();
    if (!list.length) { toast('还没选书'); return; }
    if (!confirm(`删除选中的 ${list.length} 本书？\n（含它们的笔记、书签、笔迹，无法恢复）`)) return;
    if (!confirm(`再次确认：${list.length} 本书将被永久删除。\n\n确定要继续吗？`)) return;
    for (const b of list) {
      await Annot.removeBook(b.id);
      await DB.del('books', b.id);
    }
    toast(`已删除 ${list.length} 本`);
    this.selected.clear();
    this.refresh();
  },

  /* ---------------- 批量调整收藏夹 / 收藏内的次序 ---------------- */
  async _applyOrder(order) {
    // 把 order（书 id 数组）写回每本书的 sortOrder，并落库
    for (let i = 0; i < order.length; i++) {
      const b = this.all.find(x => x.id === order[i]);
      if (b) { b.sortOrder = i; await DB.put('books', b); }
    }
    // 手动排过 = 用户要的就是这个次序。此时如果还停在「最近」，
    // 下一次渲染就会把刚拖的顺序冲掉（看起来像「拖了没反应」），所以顺手切到「手动」。
    if (this.sort !== 'manual' && (this.filter === 'fav' || String(this.filter).startsWith('coll:'))) {
      this.sort = 'manual';
      try { Settings.libSort = 'manual'; saveSettings(); } catch (e) {}
    }
  },

  /** 在收藏夹 / 收藏视图里批量调整已选书的次序
   *  @param {'top'|'up'|'down'} dir  top=全部置顶；up=整体上移一格；down=整体下移一格 */
  async _reorderSelected(dir) {
    const order = this.visibleIds.slice();
    const sel = this.selected;
    if (!order.length || !sel.size) return;
    if (dir === 'top') {
      const moved = order.filter(id => sel.has(id));
      const rest = order.filter(id => !sel.has(id));
      await this._applyOrder(moved.concat(rest));
    } else {
      const delta = dir === 'up' ? -1 : 1;
      if (delta < 0) {
        for (let i = 1; i < order.length; i++) {
          if (sel.has(order[i]) && !sel.has(order[i - 1])) {
            const t = order[i - 1]; order[i - 1] = order[i]; order[i] = t;
          }
        }
      } else {
        for (let i = order.length - 2; i >= 0; i--) {
          if (sel.has(order[i]) && !sel.has(order[i + 1])) {
            const t = order[i + 1]; order[i + 1] = order[i]; order[i] = t;
          }
        }
      }
      await this._applyOrder(order);
    }
    toast('已调整次序');
    this.refresh();
  },

  bulkTop() { this._reorderSelected('top'); },
  bulkUp() { this._reorderSelected('up'); },
  bulkDown() { this._reorderSelected('down'); },

  /**
   * 选择性共享：只把勾选的书放进共享清单。
   * 一本都没勾时退化为共享全部（并明确提示，避免"到底共享了啥"的困惑）。
   */
  shareSelected() {
    let ids = this.selectedBooks().map(b => b.id);
    let all = false;
    if (!ids.length) {
      ids = this.all.map(b => b.id);
      all = true;
    }
    if (!ids.length) { toast('书库还是空的'); return; }
    openShareSheet(ids, all);
  },

  render() {
    this.renderCollections();
    const grid = $('bookGrid');
    const empty = $('libEmpty');
    let list = this.all.slice();

    if (this.q) {
      const q = this.q.toLowerCase();
      list = list.filter(b => (b.title || '').toLowerCase().includes(q));
    }
    if (this.filter.startsWith('coll:')) {
      const cid = this.filter.slice(5);
      const c = this.collections.find(x => x.id === cid);
      list = list.filter(b => (b.collection || null) === cid);
      if (c && c.scope) list = list.filter(b => fmtInScope(b.format, c.scope));   // 分类文件夹只看本分类的书
    } else {
      if (this.filter === 'reading') list = list.filter(b => b.progress > 0.005 && b.progress < 0.995);
      if (this.filter === 'fav') list = list.filter(b => b.fav);
      if (this.filter === 'text') list = list.filter(b => TEXT_FORMATS.includes(b.format));
      if (this.filter === 'comic') list = list.filter(b => b.format === 'comic');
      if (this.filter === 'pdf') list = list.filter(b => b.format === 'pdf');
      // 分类主视图里，若某本书已收进「本分类显示的文件夹」，则主网格不再重复显示
      // （它只出现在那个文件夹里）。隐藏条件必须和下面「文件夹卡片显示条件」保持一致，
      // 否则 scope 为 'text' 时 ['txt','docx','epub'].includes('text') 为 false，书会重复出现在外面。
      if (this.filter === 'text' || this.filter === 'comic' || this.filter === 'pdf') {
        const folderShown = (col) => col && col.scope && (
          this.filter === 'text'
            ? (col.scope === 'text' || TEXT_FORMATS.includes(col.scope))
            : col.scope === this.filter);
        list = list.filter(b => {
          if (!b.collection) return true;
          const col = this.collections.find(c => c.id === b.collection);
          return !folderShown(col);
        });
      }
    }

    // 标签筛选：OR=命中任一即显示；AND=必须同时含全部所选标签。与上面搜索/分类是「与」的关系
    if (this.tagFilter.size) {
      if (this.tagMode === 'and') {
        list = list.filter(b => {
          const ts = b.tags || [];
          return Array.from(this.tagFilter).every(t => ts.includes(t));
        });
      } else {
        list = list.filter(b => (b.tags || []).some(t => this.tagFilter.has(t)));
      }
    }

    /* 排序
       ---- 收藏夹以前是「特殊待遇」：一律按手动 sortOrder，于是最近读的书
       永远排不到前面（用户实测「顺序一直不变」）。现在收藏夹也走同一套排序，
       只多出一档「手动」—— 那是真的靠拖动排出来的次序（sortOrder）。
       置顶永远压在所有排序之上。 */
    const isFavScope = (this.filter === 'fav' || String(this.filter).startsWith('coll:'));
    let mode = this.sort;
    if (mode === 'manual' && !isFavScope) mode = 'recent';   // 切到别的视图时手动排序没有意义
    const dir = this.sortDir === -1 ? -1 : 1;
    const byNum = (get, dflt) => (a, b) => dflt * dir * (((get(a) != null ? get(a) : 0) - (get(b) != null ? get(b) : 0)));
    if (mode === 'manual') {
      // 用户拖出来的次序：sortOrder 小的在前；没排过的按加入时间垫底
      list.sort((a, b) => {
        const oa = (a.sortOrder != null) ? a.sortOrder : (a.addedAt || 0) + 1e12;
        const ob = (b.sortOrder != null) ? b.sortOrder : (b.addedAt || 0) + 1e12;
        return dir * (oa - ob);
      });
    } else if (mode === 'title') {
      list.sort((a, b) => dir * String(a.title || '').localeCompare(String(b.title || ''), 'zh'));
    } else if (mode === 'progress') {
      list.sort(byNum(x => x.progress, -1));
    } else if (mode === 'added') {
      list.sort(byNum(x => x.addedAt, -1));
    } else {
      // 最近阅读：读过的按 lastReadAt 倒序；从没打开过的排在后面，按加入时间补位
      list.sort((a, b) => {
        const ra = a.lastReadAt || 0, rb = b.lastReadAt || 0;
        if (ra && rb) return dir * (rb - ra);
        if (ra) return -1;
        if (rb) return 1;
        return dir * ((b.addedAt || 0) - (a.addedAt || 0));
      });
    }
    // 置顶永远在最前
    list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

    this.visibleIds = list.map(b => b.id);
    this.syncSortUi();
    if (this.selectMode) this._prune();
    let folderHTML = '';

    $('libStats').textContent = `${this.all.length} 本 · 本地存储`;
    const titles = { all: '书库', reading: '在读', fav: '收藏',
      text: '文本小说', comic: '漫画', pdf: 'PDF' };
    const scopeName = this.filter.startsWith('coll:')
      ? ((this.collections.find(c => c.id === this.filter.slice(5)) || {}).name || '收藏夹')
      : (titles[this.filter] || '书库');
    $('libTitle').textContent = scopeName;
    this.renderLibNav();          // 返回按钮 + 面包屑（在嵌套文件夹里才出现）

    // 空状态要分清两种「空」，否则搜索无结果时只剩一片空白，用户会以为书架坏了：
    //   书库本身是空的         -> 引导去导入（index.html 里的原始空状态）
    //   有书但被搜索/筛选筛没了 -> 说明没搜到，并给一个「清除」按钮
    const noMatch = $('libNoMatch');
    const noMatchSub = $('libNoMatchSub');
    const reallyEmpty = this.all.length === 0;
    empty.hidden = !(list.length === 0 && reallyEmpty);
    if (noMatch) noMatch.hidden = !(list.length === 0 && !reallyEmpty);
    if (noMatchSub && list.length === 0 && !reallyEmpty) {
      noMatchSub.innerHTML = this.q
        ? `「${esc(this.q)}」在「${esc(scopeName)}」里没有结果`
        : `「${esc(scopeName)}」里还没有书`;
    }
    // 分类主视图里直接显示本分类的文件夹卡片（点一下即进入该文件夹），不只出现在侧栏
    if (this.filter === 'text' || this.filter === 'comic' || this.filter === 'pdf') {
      folderHTML = this.collections
        .filter(c => c.scope && (
          this.filter === 'text'
            ? (c.scope === 'text' || TEXT_FORMATS.includes(c.scope))   // 文本小说分类：scope 为 'text' 或具体文本格式都算
            : c.scope === this.filter))
        .map(c => this.folderCard(c)).join('');
    } else if (this.filter.startsWith('coll:')) {
      // 进入某个收藏夹后，也把它的「直接子夹」作为卡片列出来，
      // 这样在分类大屏 / 收藏夹里也能点父夹进入子夹，而不只靠侧栏树。
      const pid = this.filter.slice(5);
      folderHTML = this.collections
        .filter(c => c.parent === pid)
        .map(c => this.folderCard(c)).join('');
    } else {
      folderHTML = '';
    }

    grid.hidden = list.length === 0 && !folderHTML;   // 有文件夹卡片也要显示网格

    grid.innerHTML = folderHTML + list.map(b => this.card(b)).join('');

    grid.querySelectorAll('.book-card').forEach(el => {
      const id = el.dataset.id;
      el.onclick = (e) => {
        if (e.target.classList.contains('book-del')) return;
        if (e.target.classList.contains('book-more')) return;
        if (e.target.classList.contains('book-star')) return;
        // 点标签芯片 → 按该标签筛选（非选择模式下才生效）
        const tc = e.target.closest('.tag-chip');
        if (tc && !Library.selectMode) { Library.toggleTagFilter(tc.dataset.tag); return; }
        // 选择模式下：整张卡片就是勾选框，不再打开书
        if (Library.selectMode) { Library.toggleSelect(id); return; }
        const book = this.all.find(x => x.id === id);
        if (book) openBook(book);
      };
      const del = el.querySelector('.book-del');
      const star = el.querySelector('.book-star');
      const more = el.querySelector('.book-more');
      if (star) star.onclick = async (e) => {
        e.stopPropagation();
        await Library.toggleFav(id);
        this.refresh();
      };
      if (more) more.onclick = (e) => { e.stopPropagation(); Library.openMenu(id); };
      if (del) del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`删除《${this.all.find(x => x.id === id).title}》？此操作不可撤销。`)) return;
        await DB.del('books', id);
        await Annot.removeBook(id);
        toast('已删除');
        this.refresh();
      };
    });

    this.updateBulkCount();
    this.renderContinue();
    this.renderTagBar();

    // 分类主视图里的文件夹卡片：点一下进入该文件夹（coll: 过滤）
    grid.querySelectorAll('.folder-card').forEach(el => {
      // 用 enterView 统一入口：顺手展开侧栏里的祖先，不然深层的当前项在侧栏是隐藏的
      el.onclick = () => this.enterView('coll:' + el.dataset.coll);
    });
  },

  /** 分类主视图里显示的文件夹卡片（点一下进入） */
  folderCard(c) {
    const n = this.all.filter(b => (b.collection || null) === c.id && (!c.scope || fmtInScope(b.format, c.scope))).length;
    const cc = c.color ? collColor(c.color) : '';
    // 分类色写进 CSS 变量（而不是直接写 background）——透明封面靠 color-mix 把这两个色
    // 按 --lib-cover-a 掺进透明里，写成 background 会把 CSS 那套透明度盖掉。
    const coverStyle = cc ? ` style="--cv-c1:${cc};--cv-c2:${cc}CC"` : '';
    return `<div class="book-card folder-card" data-coll="${c.id}" title="进入文件夹「${esc(c.name)}」">
      <div class="book-cover"${coverStyle}>
        <div class="cover-txt"><div class="cover-title">📁 ${esc(c.name)}</div></div>
        <span class="cover-badge">${FORMAT_LABEL[c.scope] || c.scope}</span>
      </div>
      <div class="bc-title">${esc(c.name)}</div>
      <div class="bc-sub">📁 文件夹 · ${n} 本</div>
    </div>`;
  },

  /** 书架顶部的标签筛选条：列出全部标签，点选即筛选；无标签时隐藏 */
  renderTagBar() {
    const bar = $('tagBar');
    if (!bar) return;
    const tags = this.allTags();
    if (!tags.length) { bar.hidden = true; bar.innerHTML = ''; return; }
    bar.hidden = false;
    const chips = tags.map(t => {
      const on = this.tagFilter.has(t);
      return `<button class="chip tag-chip${on ? ' sel' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`;
    }).join('');
    const clear = this.tagFilter.size
      ? `<button class="chip tag-clear" id="tagClear" title="清除标签筛选">✕ 清除</button>` : '';
    // 标签匹配模式切换：或（命中任一）/ 且（必须全含）
    const modeBtn = `<button class="chip tag-mode${this.tagFilter.size ? ' sel' : ''}" id="tagModeBtn"
        data-tagmode="${this.tagMode === 'and' ? 'or' : 'and'}"
        title="当前：${this.tagMode === 'and' ? '且（必须同时含全部所选标签）' : '或（命中任一标签即显示）'}；点击切换">
        ${this.tagMode === 'and' ? '且 AND' : '或 OR'}</button>`;
    bar.innerHTML = `<span class="tag-bar-label">🏷️ 标签</span>${modeBtn}${chips}${clear}`;
  },

  /** 单本书卡上的标签芯片（点击即按该标签筛选） */
  tagsHTML(b) {
    const tags = b.tags || [];
    if (!tags.length) return '';
    const chips = tags.map(t =>
      `<span class="tag-chip" data-tag="${esc(t)}">${esc(t)}</span>`).join('');
    return `<div class="tag-row">${chips}</div>`;
  },

  starHTML(b) {    return `<div class="book-star${b.fav ? ' on' : ''}" data-star="${b.id}"
      title="${b.fav ? '取消收藏' : '加入收藏'}">${b.fav ? '★' : '☆'}</div>`;
  },

  /** 切换收藏（书架卡片与阅读器顶栏共用） */
  async toggleFav(id) {
    const b = this.all.find(x => x.id === id) || await DB.get('books', id);
    if (!b) return null;
    b.fav = !b.fav;
    await DB.put('books', b);
    toast(b.fav ? '已加入收藏' : '已取消收藏');
    return b;
  },

  /** 书架上的格式标签：按**导入时的原始格式**显示。
   *  内部一律存成 format:'html'（epub/docx/md/html 都走富文本管线），
   *  直接显示 format 会让「.md 笔记」和「.epub 书」都变成 HTML，看着像导入错了。 */
  fmtLabel(b) {
    const e = String((b && b.srcExt) || '').toLowerCase();
    if (e === 'md' || e === 'markdown') return 'Markdown';
    if (e === 'epub') return 'EPUB';
    if (e === 'docx' || e === 'doc') return 'Word';
    if (e === 'html' || e === 'htm' || e === 'xhtml') return 'HTML';
    return FORMAT_LABEL[(b && b.format) || ''] || String((b && b.format) || '').toUpperCase();
  },

  card(b) {
    const prog = Math.round((b.progress || 0) * 100);
    const badge = this.fmtLabel(b);
    let coverInner = `
      <div class="cover-txt">
        <div class="cover-title">${esc(b.title)}</div>
      </div>
      <span class="cover-badge">${badge}</span>`;
    const cmode = coverModeOf(b);
    if (cmode === 'image' && b.cover) {
      // 自定义封面优先
      coverInner = `<img src="${blobUrl(b.cover)}" alt=""><span class="cover-badge">${badge}</span>`;
    } else if (cmode === 'thumb' && b.content.items && b.content.items[0]) {
      const url = blobUrl(b.content.items[0].blob);
      coverInner = `<img src="${url}" alt=""><span class="cover-badge">${b.content.items.length} 页</span>`;
    }
    const cc = b.color ? collColor(b.color) : '';
    // 同上：分类色走 CSS 变量，别直接写 background（会盖掉透明封面）
    const coverStyle = cc ? ` style="--cv-c1:${cc};--cv-c2:${cc}CC"` : '';
    const on = this.selectMode && this.selected.has(b.id);
    return `
      <div class="book-card${on ? ' sel' : ''}" data-id="${b.id}">
        <div class="book-cover"${coverStyle}>
          ${coverInner}
          <div class="book-check"${this.selectMode ? '' : ' hidden'}>${on ? '✓' : ''}</div>
          ${this.starHTML(b)}
          ${b.pinned ? '<div class="book-pin" title="已置顶">📌</div>' : ''}
          <div class="book-more" data-more="${b.id}" title="更多">⋯</div>
          <div class="book-del">×</div>
        </div>
        <div class="bc-title">${esc(b.title)}</div>
        <div class="bc-sub">${prog > 0 ? '已读 ' + prog + '%' : '未开始'}</div>
        <div class="pbar"><i style="width:${prog}%"></i></div>
        ${this.tagsHTML(b)}
      </div>`;
  },

  /** 返回某个收藏夹的全部后代 id（含间接子夹），用于防止把父夹塞进自己的子夹形成环 */
  descendantsOf(id) {
    const out = new Set();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      for (const x of this.collections) {
        if (x.parent === cur && !out.has(x.id)) { out.add(x.id); stack.push(x.id); }
      }
    }
    return out;
  },

  /** 按 parent 嵌套 + order 排序，返回带深度的列表。带 visited 防环：
   *  若数据里出现了 A→B→A 这种非法环（理论上 manageCollection 已拦，但旧数据可能有），
   *  这里只渲染一次、不无限递归，避免整个侧栏崩溃消失。 */
  collTree() {
    const all = this.collections.slice();
    all.forEach((c, i) => { if (c.order == null) c.order = i; });
    const roots = all.filter(c => !c.parent).sort((a, b) => a.order - b.order);
    const out = [];
    const seen = new Set();
    const walk = (list, depth) => {
      for (const c of list) {
        if (seen.has(c.id)) continue;          // 防环：已经渲染过就不再递归
        seen.add(c.id);
        out.push({ c, depth });
        walk(all.filter(x => x.parent === c.id).sort((a, b) => a.order - b.order), depth + 1);
      }
    };
    walk(roots, 0);
    return out;
  },

  renderCollections() {
    const nav = $('collNav');
    if (!nav) return;

    // ===== 批量整理模式：勾选 + 上下移 + 底部批量删除 =====
    if (this.folderManage) {
      if (!this.collections.length) {
        nav.innerHTML = '<div class="coll-empty">还没有收藏夹<br>点上方「＋」新建</div>';
        return;
      }
      const tree = this.collTree();
      const hidden = new Set();
      for (const { c, depth } of tree) {
        if (depth > 0) {
          const p = this.collections.find(x => x.id === c.parent);
          if (p && (p.collapsed || hidden.has(p.id))) hidden.add(c.id);
        }
      }
      const hasKids = id => this.collections.some(x => x.parent === id);
      const rows = tree.filter(({ c }) => !hidden.has(c.id)).map(({ c, depth }) => {
        const n = this.all.filter(b => (b.collection || null) === c.id &&
          (!c.scope || fmtInScope(b.format, c.scope))).length;
        const color = c.color ? collColor(c.color) : '#B9B9BE';
        const kids = hasKids(c.id);
        const siblings = tree.filter(t => (t.c.parent || null) === (c.parent || null)).map(t => t.c);
        const i = siblings.findIndex(x => x.id === c.id);
        const canUp = i > 0, canDown = i < siblings.length - 1;
        /* 整理模式只留「勾选 / 折叠 / 名字 / ↑↓」：颜色点和 📁 图标在这个宽度里
           纯属占位，去掉它们名字才有地方显示（以前手机上一行只剩 0 宽）。 */
        return `<div class="coll-row coll-manage-row">
          <button class="coll-check${this.folderSel.has(c.id) ? ' on' : ''}" data-check="${c.id}" title="选择 / 取消">${this.folderSel.has(c.id) ? '☑' : '☐'}</button>
          <button class="coll-chev${kids ? '' : ' coll-chev-leaf'}" data-coll="${c.id}" title="展开/折叠">${kids ? (c.collapsed ? '▸' : '▾') : '·'}</button>
          <span class="coll-name" style="padding-left:${depth * 10}px">${esc(c.name)}<span class="nav-count">${n}</span></span>
          <button class="coll-mv" data-up="${c.id}" ${canUp ? '' : 'disabled'} title="上移">↑</button>
          <button class="coll-mv" data-down="${c.id}" ${canDown ? '' : 'disabled'} title="下移">↓</button>
        </div>`;
      }).join('');
      const selN = this.folderSel.size;
      nav.innerHTML =
        `<div class="coll-manage-bar">
           <button class="btn-plain" id="collSelToggle">全选 / 全不选</button>
           <span class="coll-manage-info">已选 ${selN} 个</span>
         </div>` + rows +
        `<div class="coll-manage-foot">
           <button class="btn-plain" id="collManageDone">完成</button>
           <button class="btn-danger" id="collDelSel" ${selN ? '' : 'disabled'}>删除选中（${selN}）</button>
         </div>`;
      nav.querySelectorAll('[data-check]').forEach(b => b.onclick = () => {
        const id = b.dataset.check;
        this.folderSel.has(id) ? this.folderSel.delete(id) : this.folderSel.add(id);
        this.renderCollections();
      });
      nav.querySelectorAll('[data-up]').forEach(b => b.onclick = () => this._moveFolder(b.dataset.up, -1));
      nav.querySelectorAll('[data-down]').forEach(b => b.onclick = () => this._moveFolder(b.dataset.down, 1));
      nav.querySelectorAll('.coll-chev:not(.coll-chev-leaf)').forEach(b => b.onclick = (e) => {
        e.stopPropagation();
        const c = this.collections.find(x => x.id === b.dataset.coll);
        if (c) { c.collapsed = !c.collapsed; DB.kvSet('collections', this.collections); this.renderCollections(); }
      });
      const selToggle = nav.querySelector('#collSelToggle'); if (selToggle) selToggle.onclick = () => {
        if (this.collections.length && this.folderSel.size === this.collections.length) this.folderSel.clear();
        else this.collections.forEach(c => this.folderSel.add(c.id));
        this.renderCollections();
      };
      const done = nav.querySelector('#collManageDone'); if (done) done.onclick = () => { this.folderManage = false; this.folderSel.clear(); this.renderCollections(); };
      const delSel = nav.querySelector('#collDelSel'); if (delSel) delSel.onclick = () => this._batchDeleteFolders();
      return;
    }

    if (!this.collections.length) {
      nav.innerHTML = '<div class="coll-empty">还没有收藏夹<br>点上方「＋」新建</div>';
      return;
    }
    /* 注意：每条收藏夹必须包一层 .coll-row（position:relative）。
       之前 .coll-more 是 .nav-item 的兄弟节点且 position:absolute，
       定位基准变成了侧栏，导致所有 ⋯ 叠在同一个位置 —— 点 A 夹实际点到 B 夹。 */
    const tree = this.collTree();
    // 折叠：某节点 collapsed，或其祖先被折叠 → 整棵子树隐藏
    const hidden = new Set();
    for (const { c, depth } of tree) {
      if (depth > 0) {
        const p = this.collections.find(x => x.id === c.parent);
        if (p && (p.collapsed || hidden.has(p.id))) hidden.add(c.id);
      }
    }
    const hasKids = id => this.collections.some(x => x.parent === id);
    nav.innerHTML = tree.filter(({ c }) => !hidden.has(c.id)).map(({ c, depth }) => {
      const n = this.all.filter(b => (b.collection || null) === c.id &&
        (!c.scope || fmtInScope(b.format, c.scope))).length;
      const color = c.color ? collColor(c.color) : '#B9B9BE';
      const kids = hasKids(c.id);
      const chev = `<button class="coll-chev${kids ? '' : ' coll-chev-leaf'}" `
        + `data-coll="${c.id}" title="展开/折叠">${kids ? (c.collapsed ? '▸' : '▾') : '·'}</button>`;
      const scopeTag = c.scope ? `<span class="coll-scope">${FORMAT_LABEL[c.scope] || c.scope}</span>` : '';
      return `<div class="coll-row">
        ${chev}
        <button class="nav-item${this.filter === 'coll:' + c.id ? ' active' : ''}"
          data-filter="coll:${c.id}" style="padding-left:${10 + depth * 14}px">
          <span class="coll-dot" style="background:${color}"></span>
          <span class="nav-ico">${c.parent ? '📁' : '🗂️'}</span>${esc(c.name)}${scopeTag}<span class="nav-count">${n}</span></button>
        <button class="coll-more" data-coll="${c.id}" title="管理这个收藏夹（重命名 / 配色 / 排序 / 嵌套 / 删除）">⋯</button>
      </div>`;
    }).join('');
    nav.querySelectorAll('.coll-chev:not(.coll-chev-leaf)').forEach(b => b.onclick = (e) => {
      e.stopPropagation();
      const c = this.collections.find(x => x.id === b.dataset.coll);
      if (c) { c.collapsed = !c.collapsed; DB.kvSet('collections', this.collections); this.renderCollections(); }
    });
  },

  /** 在整理模式里把某个收藏夹在同层兄弟间上移 / 下移 */
  _moveFolder(id, dir) {
    const tree = this.collTree();
    const c = this.collections.find(x => x.id === id);
    if (!c) return;
    const siblings = tree.filter(t => (t.c.parent || null) === (c.parent || null)).map(t => t.c);
    const i = siblings.findIndex(x => x.id === id);
    const j = i + dir;
    if (j < 0 || j >= siblings.length) return;
    const oi = siblings[i].order, oj = siblings[j].order;
    siblings[i].order = oj; siblings[j].order = oi;
    DB.kvSet('collections', this.collections).then(() => this.renderCollections());
  },

  /** 批量删除收藏夹：连同后代一起删，并询问夹内书是否也删 */
  async _batchDeleteFolders() {
    if (!this.folderSel.size) return;
    const ids = new Set(this.folderSel);
    for (const id of Array.from(ids)) {
      for (const d of this.descendantsOf(id)) ids.add(d);
    }
    const affected = this.all.filter(b => ids.has(b.collection || null));
    const nBooks = affected.length;
    const pick = await new Promise((resolve) => {
      showChoice(`删除 ${ids.size} 个收藏夹？`, [
        '只删收藏夹，书保留在书库（推荐）',
        nBooks ? `连书一起删（${nBooks} 本，不可恢复）` : '（这些夹里没有书）',
        '取消'
      ], 2, (i) => resolve(i));
    });
    if (pick === 2) { toast('已取消'); return; }
    const delBooks = (pick === 1);
    if (delBooks) {
      for (const b of affected) { await DB.del('books', b.id); await Annot.removeBook(b.id); }
    } else {
      for (const b of affected) { b.collection = null; await DB.put('books', b); }
    }
    // 指向已删夹的 parent 提升为顶层，避免孤儿
    for (const c of this.collections) if (c.parent && ids.has(c.parent)) c.parent = null;
    this.collections = this.collections.filter(c => !ids.has(c.id));
    await DB.kvSet('collections', this.collections);
    this.folderSel.clear();
    if (this.filter.startsWith('coll:') && ids.has(this.filter.slice(5))) this.filter = 'all';
    this.folderManage = false;
    toast(`已删除 ${ids.size} 个收藏夹`);
    this.refresh();
  },

  /** 收藏夹管理：重命名 / 改颜色 / 排序 / 移入其它夹 / 清空 / 删除 */
  manageCollection(cid) {
    const c = this.collections.find(x => x.id === cid);
    if (!c) return;
    const n = this.all.filter(b => (b.collection || null) === cid).length;
    const tree = this.collTree();
    const idx = tree.findIndex(t => t.c.id === cid);
    // 排除自己、当前父夹、以及自己的全部后代 —— 否则把父夹塞进子夹会形成 A→B→A 环，
    // 渲染时整棵子树找不到 root，侧栏里直接消失。
    const banned = this.descendantsOf(cid);
    banned.add(cid); if (c.parent) banned.add(c.parent);
    const others = this.collections.filter(x => !banned.has(x.id));
    const items = [
      { k: 'rename', t: '✏️ 重命名收藏夹' },
      { k: 'color', t: '🎨 更换封面颜色' },
      { k: 'up', t: '↑ 上移' },
      { k: 'down', t: '↓ 下移' },
      { k: 'nest', t: c.parent ? '↩️ 移出到顶层' : '📥 移入其它收藏夹（成为子夹）' },
      { k: 'clear', t: `🗑️ 移出全部书籍（${n} 本）` },
      { k: 'del', t: '❌ 删除收藏夹', danger: true }
    ];
    $('bookMenuTitle').textContent = c.name;
    $('bookMenuList').innerHTML = items.map(i =>
      `<button class="menu-item${i.danger ? ' danger' : ''}" data-k="${i.k}">${esc(i.t)}</button>`).join('');
    $('bookMenu').hidden = false;
    $('bookMenu')._bookId = null;
    $('bookMenuList').querySelectorAll('[data-k]').forEach(btn => {
      btn.onclick = async () => {
        $('bookMenu').hidden = true;
        const k = btn.dataset.k;
        const save = async () => { await DB.kvSet('collections', this.collections); this.refresh(); };
        if (k === 'rename') {
          showInput('重命名收藏夹', c.name, async (v) => {
            if (v == null || !v.trim()) return;
            c.name = v.trim();
            if (this.filter === 'coll:' + cid) $('libTitle').textContent = c.name;
            toast('已重命名'); await save();
          });
        } else if (k === 'color') {
          showChoice('收藏夹颜色', [COLL_NONE].concat(COLL_COLORS.map(x => x.name)),
            collColorIndex(c.color), async (i) => {
              c.color = i === 0 ? null : COLL_COLORS[i - 1].id;
              toast(i === 0 ? '已恢复默认颜色' : '已更换颜色'); await save();
            });
        } else if (k === 'up' || k === 'down') {
          const siblings = tree
            .filter(t => (t.c.parent || null) === (c.parent || null))
            .map(t => t.c);
          const i = siblings.findIndex(x => x.id === cid);
          const j = k === 'up' ? i - 1 : i + 1;
          if (j < 0 || j >= siblings.length) { toast(k === 'up' ? '已经在最上面' : '已经在最下面'); return; }
          siblings.forEach((x, n) => { x.order = n; });
          siblings[i] = siblings[j]; siblings[j] = c;
          siblings.forEach((x, n) => { x.order = n; });
          await save();
        } else if (k === 'nest') {
          if (c.parent) { c.parent = null; toast('已移出到顶层'); await save(); return; }
          if (!others.length) { toast('还没有其它收藏夹'); return; }
          showChoice('移入哪个收藏夹？', others.map(x => x.name), 0, async (i) => {
            c.parent = others[i].id;
            toast(`已移入「${others[i].name}」`); await save();
          });
        } else if (k === 'clear') {
          if (!confirm(`把 ${n} 本书移出「${c.name}」？\n（书不会被删除，只是回到书库）`)) return;
          for (const b of this.all.filter(x => (x.collection || null) === cid)) {
            b.collection = null; await DB.put('books', b);
          }
          toast('已移出全部书籍'); this.refresh();
        } else if (k === 'del') {
          this.confirmDeleteCollection(c, n);
        }
      };
    });
  },

  /**
   * 删除收藏夹：两步确认
   * 第一步：确认删除文件夹本身
   * 第二步：询问夹内书籍怎么处理（保留 / 一并删除）
   */
  async confirmDeleteCollection(c, n) {
    if (!confirm(`删除收藏夹「${c.name}」？`)) return;
    if (!confirm(`再次确认：收藏夹「${c.name}」将被永久删除。\n\n确定要继续吗？`)) return;
    if (n > 0) {
      const delBooks = confirm(
        `该收藏夹里有 ${n} 本书。\n\n【确定】= 连同这 ${n} 本书一起删除（不可恢复）\n【取消】= 只删除收藏夹，书保留在书库`);
      if (delBooks) {
        if (!confirm(`最后确认：将删除收藏夹和其中的 ${n} 本书。\n此操作不可撤销，确定吗？`)) return;
        for (const b of this.all.filter(x => (x.collection || null) === c.id)) {
          await DB.del('books', b.id);
          await Annot.removeBook(b.id);
        }
      } else {
        for (const b of this.all.filter(x => (x.collection || null) === c.id)) {
          b.collection = null; await DB.put('books', b);
        }
      }
    }
    // 子收藏夹提升为顶层，避免变成孤儿
    for (const sub of this.collections.filter(x => x.parent === c.id)) sub.parent = c.parent || null;
    this.collections = this.collections.filter(x => x.id !== c.id);
    await DB.kvSet('collections', this.collections);
    if (this.filter === 'coll:' + c.id) this.filter = 'all';
    toast('收藏夹已删除');
    this.refresh();
  },

  async addCollection(name, scope, parent) {
    const c = { id: 'c' + Date.now().toString(36), name, scope: scope || null, parent: parent || null };
    this.collections.push(c);
    await DB.kvSet('collections', this.collections);
    return c;
  },

  async moveTo(bookId, collId) {
    const b = this.all.find(x => x.id === bookId) || await DB.get('books', bookId);
    if (!b) return;
    if (collId) {
      const c = this.collections.find(x => x.id === collId);
      // 该文件夹有分类范围，而这本书不属于这个范围：加入后会被按分类过滤掉、在文件夹里看不到，
      // 所以先提示一下，避免用户以为"加进去了却找不到"。
      if (c && c.scope && !fmtInScope(b.format, c.scope)) {
        const ok = confirm(
          `《${b.title}》是「${FORMAT_LABEL[b.format] || b.format}」，\n` +
          `但文件夹「${c.name}」只收纳「${FORMAT_LABEL[c.scope] || c.scope}」的书。\n\n` +
          `加入后它会在该文件夹里被隐藏（按分类过滤）。仍要加入吗？`);
        if (!ok) return;
      }
    }
    b.collection = collId || null;
    await DB.put('books', b);
    const nm = collId ? (this.collections.find(c => c.id === collId) || {}).name : '书库';
    toast(`已移动到「${nm}」`);
  },

  /* ============================================================
     书籍操作菜单
     ============================================================ */
  async openMenu(id) {
    const b = this.all.find(x => x.id === id) || await DB.get('books', id);
    if (!b) return;
    $('bookMenuTitle').textContent = b.title;
    const collName = b.collection
      ? (this.collections.find(c => c.id === b.collection) || {}).name || '（已删除）'
      : '未归类';
    const items = [
      { k: 'rename', t: '✏️ 重命名' },
      { k: 'color', t: '🎨 封面配色' + (b.color ? '（已设色，可还原）' : '（无图也能区分）' ) },
      { k: 'cover', t: '🖼️ 更换封面' + (b.cover ? '（已自定义）' : '') },
      ...(b.cover ? [{ k: 'uncover', t: '↩︎ 移除封面（还原成文字封面）' }] : []),
      ...(b.format === 'comic' && (b.content && b.content.items || []).length
        ? [{
            k: 'thumb',
            t: coverModeOf(b) === 'thumb'
              ? '🖼️ 封面：用第一张图（当前）'
              : '🖼️ 封面改用第一张图'
          }] : []),
      { k: 'pin', t: b.pinned ? '📌 取消置顶' : '📌 置顶到书架顶部' },
      { k: 'fav', t: b.fav ? '★ 取消收藏' : '☆ 加入收藏' },
      { k: 'tags', t: '🏷️ 标签（' + ((b.tags && b.tags.length) ? b.tags.join('、') : '无') + '）' },
      { k: 'move', t: '🗂️ 移动到收藏夹（当前：' + collName + '）' },
      ...(b.format === 'comic' ? [{
        k: 'pages',
        t: `🧩 页面管理（${((b.content && b.content.items) || []).length} 页 · 排序 / 拆分 / 删页）`
      }] : []),
      ...(b.format === 'comic' ? [{ k: 'merge', t: '🔗 与其他漫画合并（这本分开导入了？）' }] : []),
      ...(b.srcExt === 'md' ? [{ k: 'editmd', t: '✏️ 编辑 Markdown 原文' }] : []),
      { k: 'export', t: '⬆️ 导出 / 分享' },
      { k: 'exportAnn', t: '📝 导出笔记与标注' },
      { k: 'del', t: '🗑 删除本书', danger: true }
    ];
    $('bookMenuList').innerHTML = items.map(i =>
      `<button class="menu-item${i.danger ? ' danger' : ''}" data-k="${i.k}">${esc(i.t)}</button>`).join('');
    $('bookMenu').hidden = false;
    $('bookMenu')._bookId = id;

    $('bookMenuList').querySelectorAll('[data-k]').forEach(btn => {
      btn.onclick = () => this.menuAction(btn.dataset.k, id);
    });
  },

  async menuAction(k, id) {
    const close = () => { $('bookMenu').hidden = true; };
    const b = this.all.find(x => x.id === id) || await DB.get('books', id);
    if (!b) return close();

    if (k === 'editmd') {
      // 打开这本书 → 再拉起 Markdown 编辑器（openBook 是异步的，等它把 R.book 设好）
      close();
      await openBook(b);
      setTimeout(() => { try { openMdEditor(); } catch (e) { toast('打不开编辑器：' + e.message); } }, 450);
      return;
    }
    if (k === 'rename') {
      close();
      showInput('重命名', b.title, async (v) => {
        if (!v || !v.trim()) return;
        // R133：改成跟别的书一样的名字也会自动加（1），不再让书库出现两本同名
        const u = uniqueBookTitle(v.trim(), b.id);
        b.title = u.title;
        await DB.put('books', b);
        toast(u.changed ? '已有同名，已改叫「' + u.title + '」' : '已重命名');
        this.refresh();
      });
      return;
    }
    if (k === 'color') {
      close();
      showChoice('封面配色', [COLL_NONE].concat(COLL_COLORS.map(x => x.name)),
        collColorIndex(b.color), async (i) => {
          b.color = i === 0 ? null : COLL_COLORS[i - 1].id;
          // 漫画默认拿首图当封面，配色会被图盖住 —— 选了配色就切成色块封面
          if (b.format === 'comic') b.coverMode = i === 0 ? 'thumb' : 'color';
          await DB.put('books', b);
          toast(i === 0 ? '已恢复默认封面' : '已更换封面配色');
          this.refresh();
        });
      return;
    }
    if (k === 'thumb') {
      close();
      b.coverMode = 'thumb';
      b.cover = null;
      await DB.put('books', b);
      toast('封面已改用第一张图');
      this.refresh();
      return;
    }
    if (k === 'cover') { close(); pickCover(b); return; }
    if (k === 'uncover') {
      close();
      dropBlobUrl(b.cover);
      b.cover = null;
      b.coverMode = null;                  // 回到默认：漫画用首图，其它用文字封面
      await DB.put('books', b);
      toast('已移除封面，还原为默认封面');
      this.refresh();
      return;
    }
    if (k === 'pin') {
      b.pinned = !b.pinned;
      await DB.put('books', b);
      toast(b.pinned ? '已置顶' : '已取消置顶');
      close(); this.refresh(); return;
    }
    if (k === 'fav') {
      await this.toggleFav(id);
      close(); this.refresh(); return;
    }
    if (k === 'tags') { close(); this.openTagEditor([b], false); return; }
    if (k === 'move') { close(); this.showMoveSheet(b); return; }
    if (k === 'pages') { close(); this.pageManager(id); return; }
    if (k === 'merge') {
      close();
      this.setSelectMode(true);
      this.selected.add(id);
      this.render();
      toast('已勾选《' + b.title + '》，再点其它漫画的封面即可一起合并');
      return;
    }
    if (k === 'export') { close(); exportBook(b); return; }
    if (k === 'exportAnn') { close(); exportAnnotations(b); return; }
    if (k === 'del') {
      close();
      if (!confirm(`删除《${b.title}》？此操作不可撤销。`)) return;
      dropBlobUrl(b.cover);
      await DB.del('books', id);
      await Annot.removeBook(id);
      toast('已删除');
      this.refresh();
      return;
    }
  },

  showMoveSheet(b) {
    // 只列「无 scope」或「scope 匹配本书分类」的文件夹：把 txt 书塞进漫画文件夹这类
    // 没意义的选项直接过滤掉（详见 moveTo 的二次确认），避免误操作。
    const fmtCat = b.format === 'pdf' ? 'pdf' : b.format === 'comic' ? 'comic' : 'text';
    const colls = this.collections.filter(c => !c.scope || c.scope === fmtCat);
    const opts = [
      { id: null, name: '未归类（仅书库）' },
      ...colls.map(c => ({ id: c.id, name: c.name, scope: c.scope }))
    ];
    $('bookMenuTitle').textContent = '移动到';
    $('bookMenuList').innerHTML = opts.map(o =>
      `<button class="menu-item${(b.collection || null) === o.id ? ' sel' : ''}" data-cid="${o.id || ''}">
         ${esc(o.name)}${o.scope ? `<span class="coll-scope">${FORMAT_LABEL[o.scope] || o.scope}</span>` : ''}</button>`).join('') +
      `<button class="menu-item" data-new="1">＋ 新建收藏夹…</button>`;
    $('bookMenu').hidden = false;
    $('bookMenuList').querySelectorAll('[data-cid]').forEach(btn => {
      btn.onclick = async () => {
        $('bookMenu').hidden = true;
        await this.moveTo(b.id, btn.dataset.cid || null);
        this.refresh();
      };
    });
    const nb = $('bookMenuList').querySelector('[data-new]');
    if (nb) nb.onclick = () => {
      $('bookMenu').hidden = true;
      showInput('新建收藏夹', '', async (v) => {
        if (!v || !v.trim()) return;
        // 从某本书的「移动」里新建：自动归到该书分类，得到「本分类文件夹」
        const c = await this.addCollection(v.trim(), b.format);
        await this.moveTo(b.id, c.id);
        this.refresh();
      });
    };
  },

  renderContinue() {
    const row = $('continueRow');
    const reading = this.all.filter(b => b.progress > 0.005 && b.progress < 0.995)
      .sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0));
    if (!reading.length) { row.hidden = true; return; }
    const b = reading[0];
    row.hidden = false;
    let cover = '<div class="cc-cover" style="display:grid;place-items:center;font-size:22px">📖</div>';
    if (b.format === 'comic' && b.content.items && b.content.items[0]) {
      cover = `<img class="cc-cover" src="${blobUrl(b.content.items[0].blob)}">`;
    }
    row.innerHTML = `
      <div class="continue-title">继续阅读</div>
      <div class="continue-card" data-id="${b.id}">
        ${cover}
        <div class="cc-info">
          <div class="cc-t">${esc(b.title)}</div>
          <div class="cc-p">已读 ${Math.round(b.progress * 100)}% · ${relTime(b.lastReadAt)}</div>
          <div class="pbar"><i style="width:${Math.round(b.progress * 100)}%"></i></div>
        </div>
      </div>`;
    row.querySelector('.continue-card').onclick = () => openBook(b);
  }
};

/* 收藏夹/书封的预设配色（不依赖图片，任何书都能一眼区分） */
/* 封面 / 收藏夹配色
   ------------------------------------------------------------
   刻意避开 iOS 那种高饱和度原色（#007AFF / #34C759 …），它们在整屏书封上
   非常刺眼。这里给「偏暗（低饱和、沉稳）」与「偏亮（稍饱和、清爽）」两组，
   灰色保持中性。 */
/**
 * 封面到底画什么：
 *   image = 自定义封面图 / color = 色块 + 书名 / thumb = 漫画首图 / text = 文字封面
 * 漫画默认是 thumb，但那样"封面配色"会被首图盖住看不见，所以显式存一个 coverMode。
 */
function coverModeOf(b) {
  const m = b.coverMode;
  if (m === 'image' && b.cover) return 'image';
  if (m === 'color' || m === 'thumb') return m;
  if (b.cover) return 'image';
  if (b.format === 'comic' && b.content && b.content.items && b.content.items[0]) return 'thumb';
  return 'text';
}

/* 封面 / 缩略图的 blob URL 缓存。
   书架每次 render 都会重画全部卡片，如果每画一次就 createObjectURL，
   旧 URL 没人 revoke，内存会一直涨（iPad 上尤其明显）。
   这里按 blob 本身缓存同一个 URL，只在「封面被换掉 / 书被删掉」时才回收。 */
const _blobUrls = new Map();
function blobUrl(blob) {
  if (!blob) return '';
  const hit = _blobUrls.get(blob);
  if (hit) return hit;
  const u = URL.createObjectURL(blob);
  // 兜底：防止长期运行后无限增长
  if (_blobUrls.size > 300) {
    const oldest = _blobUrls.keys().next().value;
    if (oldest !== undefined) { URL.revokeObjectURL(_blobUrls.get(oldest)); _blobUrls.delete(oldest); }
  }
  _blobUrls.set(blob, u);
  return u;
}
function dropBlobUrl(blob) {
  if (!blob) return;
  const u = _blobUrls.get(blob);
  if (u) { URL.revokeObjectURL(u); _blobUrls.delete(blob); }
}

const COLL_COLORS = [
  { id: 'ink', name: '墨蓝（暗）', hex: '#2E5A88' },
  { id: 'sky', name: '天蓝（亮）', hex: '#5B9BD5' },
  { id: 'pine', name: '松绿（暗）', hex: '#3D6B54' },
  { id: 'jade', name: '青竹（亮）', hex: '#6BAF8D' },
  { id: 'ochre', name: '赭石（暗）', hex: '#8A5A3B' },
  { id: 'amber', name: '琥珀（亮）', hex: '#C9973F' },
  { id: 'plum', name: '黛紫（暗）', hex: '#6A4C82' },
  { id: 'lilac', name: '藕荷（亮）', hex: '#A98CC4' },
  { id: 'wine', name: '绛红（暗）', hex: '#96444A' },
  { id: 'coral', name: '珊瑚（亮）', hex: '#CE7B76' },
  { id: 'slate', name: '石板（暗）', hex: '#4F6272' },
  { id: 'gray', name: '石墨灰', hex: '#79797F' }
];
/* 旧版本存过的颜色 id（高饱和）映射到新调色板，避免升级后变成别的颜色 */
const LEGACY_COLL_COLOR = {
  blue: 'ink', green: 'pine', orange: 'amber', red: 'wine',
  purple: 'plum', teal: 'slate', pink: 'coral', gray: 'gray'
};
function collColorId(id) { return LEGACY_COLL_COLOR[id] || id || 'ink'; }
function collColor(id) {
  const k = collColorId(id);
  return (COLL_COLORS.find(c => c.id === k) || COLL_COLORS[0]).hex;
}
/* 在配色选择器里的下标（0 = 恢复默认，后面才是各颜色） */
function collColorIndex(id) {
  if (!id) return 0;
  const i = COLL_COLORS.findIndex(c => c.id === collColorId(id));
  return i < 0 ? 0 : i + 1;
}
const COLL_NONE = '↩︎ 恢复默认（不配色）';

/* ============================================================
   通用：输入弹窗 / 选择弹窗 / 选封面 / 导出
   ============================================================ */
function showInput(title, value, cb, opt) {
  $('inputTitle').textContent = title;
  const f = $('inputField');
  f.value = value || '';
  // R169：占位符也要能换。示例地址一律写 xxx，别拿一个像真的内网 IP 当例子 ——
  // 用户会照着截图/提示去找那个 IP，找不到还以为自己网络有问题。
  if (opt && opt.placeholder) f.setAttribute('placeholder', opt.placeholder);
  else f.removeAttribute('placeholder');
  // 输页码时弹数字键盘，输书名时得还原成普通键盘（否则 iPad 上打不出字）
  if (opt && opt.numeric) f.setAttribute('inputmode', 'numeric');
  else f.removeAttribute('inputmode');
  $('inputSheet').hidden = false;
  $('inputSheet')._cb = cb;
  setTimeout(() => { f.focus(); f.select(); }, 60);
}
function closeInput(ok) {
  const box = $('inputSheet');
  const cb = box._cb;
  const v = $('inputField').value;
  box.hidden = true;
  box._cb = null;
  if (ok && cb) cb(v);
}

/** 从一组选项里选一个（用于换颜色、选收藏夹等） */
function showChoice(title, options, selected, cb) {
  const box = $('choiceSheet');
  $('choiceTitle').textContent = title;
  $('choiceList').innerHTML = options.map((o, i) =>
    `<button class="choice-item${i === selected ? ' sel' : ''}" data-i="${i}">${esc(o)}</button>`).join('');
  box.hidden = false;
  box._cb = cb;
  $('choiceList').querySelectorAll('[data-i]').forEach(b => {
    b.onclick = () => {
      box.hidden = true;
      const cb2 = box._cb; box._cb = null;
      if (cb2) cb2(parseInt(b.dataset.i, 10));
    };
  });
}

/**
 * 多选弹窗（复选，用于「选择性共享」挑书）
 * @param {{id:string,name:string}[]} items
 * @param {Set<string>} selected  会就地修改
 */
function showMultiPick(title, items, selected, cb, opts) {
  const box = $('choiceSheet');
  if (!box) return;
  opts = opts || {};
  $('choiceTitle').textContent = title;

  /* R134：书一多，勾选就得在滚动条里翻半天。给一条即时筛选（空格分词，全部命中才留）。
     只有当调用方没关掉（searchable !== false）并且条目 ≥5 时才出现，两三条没必要多一行。 */
  const wrap = $('choiceSearchWrap');
  const inp = $('choiceSearch');
  const canSearch = opts.searchable !== false && items.length >= 5 && !!wrap && !!inp;
  let q = '';
  if (inp) inp.value = '';
  if (wrap) wrap.hidden = !canSearch;
  if (canSearch) inp.placeholder = opts.placeholder || '搜索书名';

  const finish = () => {
    box.hidden = true;
    if (wrap) wrap.hidden = true;
    if (inp) inp.value = '';
    q = '';
    const f = box._cb; box._cb = null;
    if (f) f(Array.from(selected));
  };

  /** 空格分词 + 全命中（「三体 刘」能同时筛书名和作者） */
  const toks = () => q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filter = (ts) => (ts.length
    ? items.filter(o => { const n = String(o.name || '').toLowerCase(); return ts.every(t => n.indexOf(t) >= 0); })
    : items);

  const draw = () => {
    const ts = toks();
    const view = filter(ts);
    const allOn = view.length > 0 && view.every(o => selected.has(o.id));
    const rows = view.map((o) => {
      const i = items.indexOf(o);
      return `<button class="choice-item${selected.has(o.id) ? ' sel' : ''}" data-i="${i}">` +
        `${selected.has(o.id) ? '☑︎ ' : '☐ '}${esc(o.name)}</button>`;
    }).join('');
    $('choiceList').innerHTML =
      `<button class="choice-item ok" data-done="1">✓ 完成（已选 ${selected.size} 本）</button>` +
      `<button class="choice-item" data-all="1">${allOn ? '取消全选' : '全选'}` +
        `${ts.length ? '（搜索结果 ' + view.length + ' 本）' : ''}</button>` +
      (rows || `<div class="choice-empty">没有书名含「${esc(q.trim())}」的书</div>`);
    const list = $('choiceList');
    const d = list.querySelector('[data-done]'); if (d) d.onclick = finish;
    const a = list.querySelector('[data-all]');
    /* 搜索状态下「全选」只作用于当前结果 —— 否则一按全选就把没看到的书也勾上了 */
    if (a) a.onclick = () => {
      if (allOn) view.forEach(o => selected.delete(o.id));
      else view.forEach(o => selected.add(o.id));
      draw();
    };
    list.querySelectorAll('[data-i]').forEach(b => {
      b.onclick = () => {
        const o = items[parseInt(b.dataset.i, 10)];
        selected.has(o.id) ? selected.delete(o.id) : selected.add(o.id);
        draw();
      };
    });
  };

  if (canSearch) {
    inp.oninput = () => { q = inp.value; draw(); };
    inp.onkeydown = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); q = ''; inp.value = ''; draw(); }
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
    };
  }
  draw();
  box.hidden = false;
  box._cb = cb;
}

/* 更换封面 */
function pickCover(book) {
  const inp = $('coverInput');
  inp.value = '';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    dropBlobUrl(book.cover);      // 旧封面的 URL 可以回收了
    book.cover = f;
    book.coverMode = 'image';
    await DB.put('books', book);
    toast('封面已更新');
    Library.refresh();
  };
  inp.click();
}

/* 下载工具 */
function downloadBlob(blob, filename) {
  // 安卓 WebView 不支持 <a download>（点了什么都不发生、也不报错）。
  // 有原生壳时把字节交给它写到「下载/墨阅」，写完由原生弹一句「已保存到 …」。
  const A = window.InkAndroid;
  if (A && typeof A.saveBlob === 'function' && typeof FileReader !== 'undefined') {
    try {
      const fr = new FileReader();
      fr.onload = () => {
        const s = String(fr.result || '');
        const b64 = s.slice(s.indexOf(',') + 1);
        try { A.saveBlob(b64, filename, blob.type || 'application/octet-stream'); }
        catch (e) { toast('保存失败：' + (e && e.message ? e.message : e)); }
      };
      fr.onerror = () => toast('保存失败：读不出数据');
      fr.readAsDataURL(blob);
      return;
    } catch (e) { /* 退回浏览器方式 */ }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 800);
}

function safeName(s) { return (s || 'book').replace(/[\\/:*?"<>|\n\r\t]/g, '_').slice(0, 60); }

/* 导出整本书（原文件） */
async function exportBook(b) {
  try {
    if (b.format === 'comic') await Backup.ensureJSZip();
    if (b.format === 'pdf' && b.content.data) {
      downloadBlob(new Blob([b.content.data], { type: 'application/pdf' }), safeName(b.title) + '.pdf');
    } else if (b.format === 'txt') {
      downloadBlob(new Blob([b.content.text], { type: 'text/plain;charset=utf-8' }), safeName(b.title) + '.txt');
    } else if (b.format === 'comic') {
      if (typeof JSZip === 'undefined') { toast('打包组件未加载'); return; }
      const zip = new JSZip();
      const items = b.content.items || [];
      items.forEach((it, i) => {
        const ext = (it.name.split('.').pop() || 'jpg').toLowerCase();
        zip.file(String(i + 1).padStart(4, '0') + '.' + ext, it.blob);
      });
      const blob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(blob, safeName(b.title) + '.cbz');
    }
    toast('已导出');
  } catch (e) {
    toast('导出失败：' + (e.message || e));
  }
}

/* 导出该书的笔记 / 高亮 / 书签（Markdown） */
async function exportAnnotations(b) {
  const list = await Annot.list(b.id);
  const hl = list.filter(a => a.type === 'highlight').sort((a, x) => a.start - x.start);
  const bm = list.filter(a => a.type === 'bookmark');
  if (!hl.length && !bm.length) { toast('这本书还没有笔记或书签'); return; }
  let md = `# ${b.title} —— 笔记导出\n\n导出时间：${new Date().toLocaleString('zh-CN')}\n\n`;
  if (hl.length) {
    md += `## 标记与笔记（${hl.length}）\n\n`;
    for (const h of hl) {
      const st = (MARK_STYLES.find(s => s.id === (h.style || 'highlight')) || {}).name || '高亮';
      md += `> ${(h.text || '').replace(/\n/g, ' ')}\n\n`;
      md += `**样式**：${st}\n\n`;
      if (h.note) md += `**笔记**：${h.note}\n\n`;
      md += '---\n\n';
    }
  }
  if (bm.length) {
    md += `## 书签（${bm.length}）\n\n`;
    for (const k of bm) md += `- ${k.excerpt || '(无摘要)'}\n`;
  }
  downloadBlob(new Blob([md], { type: 'text/markdown;charset=utf-8' }), safeName(b.title) + '-笔记.md');
  toast('笔记已导出');
}

function relTime(ts) {  // eslint-disable-line
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  return Math.floor(d / 86400000) + ' 天前';
}
