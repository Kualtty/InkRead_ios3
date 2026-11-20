/* ============================================================
   dict.js —— 查词 + 小窗浏览器

   三层兜底，任何一层不可用都不影响其它层：
     1) 内置简明词典：离线、即时，覆盖常用词
     2) 在线释义：英文走 dictionaryapi.dev（跨域开放）
     3) 小窗浏览器：经本地 /proxy 代理内嵌汉典 / 有道 / 维基
        没用 serve.py 启动（或站点仍拒绝内嵌）时，降级为「用系统浏览器打开」
   ============================================================ */

/* 内置简明词典（离线可用）—— 作为即时结果，完整释义请看小窗 */
const BUILTIN_DICT = {
  'book': 'n. 书；著作  v. 预订；登记',
  'read': 'v. 阅读；读懂  adj. 博学的',
  'reader': 'n. 读者；读本；阅读器',
  'page': 'n. 页；页面  v. 翻页；呼叫',
  'note': 'n. 笔记；注释；便条  v. 注意；记录',
  'mark': 'n. 标记；痕迹；分数  v. 做标记；打分',
  'ink': 'n. 墨水；墨迹  v. 涂墨水于',
  'pen': 'n. 笔；钢笔；围栏  v. 写；关押',
  'write': 'v. 写；书写；写作',
  'word': 'n. 词；单词；话语',
  'text': 'n. 文本；正文；课文',
  'chapter': 'n. 章；章节；篇',
  'library': 'n. 图书馆；书库；库',
  'light': 'n. 光；光线  adj. 轻的；明亮的',
  'night': 'n. 夜；夜晚',
  'paper': 'n. 纸；论文；报纸  adj. 纸质的',
  'cover': 'n. 封面；盖子  v. 覆盖；涉及',
  'search': 'v./n. 搜索；搜寻',
  'speed': 'n. 速度；速率  v. 加速',
  'voice': 'n. 声音；嗓音；语态',
  'speed up': '加速',
  'the': 'art. 这；那（定冠词）',
  'of': 'prep. ……的；关于',
  'and': 'conj. 和；并且',
  '山': '地面上由土石构成的隆起部分',
  '雨': '从云层降落到地面的水滴',
  '风': '空气流动的现象',
  '火': '物质燃烧时发出的光和热',
  '水': '无色无味的液体，H₂O',
  '石': '构成地壳的矿物质硬块',
  '墨': '写字绘画用的黑色颜料；泛指学问',
  '书': '成本的著作；书写；书信',
  '笔': '写字画图的工具',
  '命': '生命；命运；命令',
  '雪': '空气中降落的白色冰晶',
  '梦': '睡眠时的幻象；比喻幻想',
  '一鸣惊人': '比喻平时默默无闻，一下子做出惊人的事',
  '守株待兔': '比喻死守经验不知变通，或妄想不劳而获',
  '画蛇添足': '比喻做了多余的事，反而把事情弄糟',
  '亡羊补牢': '比喻出了问题后及时补救，还不算晚',
  '刻舟求剑': '比喻办事不知变通，拘泥成法'
};

/* 小窗可用站点（查词）。isZh 表示更适合中文，用于按语种挑默认站点 */
const DICT_SITES = [
  { id: 'zdic', name: '汉典', isZh: true, url: w => `https://www.zdic.net/hans/${encodeURIComponent(w)}`, good: '中文字/成语' },
  { id: 'youdao', name: '有道', isZh: false, url: w => `https://dict.youdao.com/result?word=${encodeURIComponent(w)}&lang=en`, good: '英文单词与词组' },
  { id: 'wiki', name: '维基百科', isZh: true, url: w => `https://zh.m.wikipedia.org/wiki/${encodeURIComponent(w)}`, good: '百科（需国际网络）' },
  { id: 'bing', name: 'Bing', isZh: false, url: w => `https://www.bing.com/search?q=${encodeURIComponent(w)}`,
    // Bing 网页版是 JS 空壳：经 /proxy 内嵌后结果区永远是空的（实测 body 只有 133 字页脚）。
    // 改成走服务端渲染的 /search（360 直出 + Bing RSS 兜底），小窗里才有真正的结果。
    srv: w => `/search?q=${encodeURIComponent(w)}&engine=bing`, good: '全网（服务端渲染，避免 JS 空壳）' }
];

/* 小窗搜索引擎（划词 → 直接搜）。
   默认走服务端 /search：它先在服务端取结果再渲染成干净页面，所以不像
   「直接内嵌搜索引擎网页」那样遇到空壳页 / 反爬 / 需要 JS 的问题。
   实测（本机网络）：360 可用且结果相关；Bing 网页版是 JS 空壳，Bing 的 RSS
   对中文冷门词会返回无关热门内容；百度网页版 403 反爬；Google / DuckDuckGo 不可达。
   因此把 百度 换成 360，其余保留为备用（不可达时会给出明确提示）。 */
const SEARCH_SITES = [
  // 三个选项语义**互相独立**（用户 2026-10-21 明确）：
  //   · 搜索结果 = 聚合，必应优先、不相关/抓不到才换 360（智能兜底）
  //   · 必应     = 只用必应，抓不到就报失败，绝不偷偷换成 360（否则和上面重复）
  //   · 360     = 只用 360
  { id: 'srv', name: '搜索结果', srv: true, good: '聚合：必应优先，抓不到才换 360' },
  // ⚠️ Bing 网页版是 JS 空壳，绝不能直接内嵌（小窗里永远空白）。
  //   必须走服务端 /search?engine=bing（必应 RSS 结构化抓取后渲染）。
  { id: 'bing', name: '必应', srv: q => `/search?q=${encodeURIComponent(q)}&engine=bing`, good: '只用必应（RSS 抓取）' },
  { id: 'so360', name: '360 搜索', srv: q => `/search?q=${encodeURIComponent(q)}&engine=360`, good: '只用 360（服务端抓取）' },
  { id: 'ddg', name: 'DuckDuckGo', url: q => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, good: '国际网络' },
  { id: 'google', name: '谷歌', url: q => `https://www.google.com/search?q=${encodeURIComponent(q)}`, good: '国际网络' }
];

/** 判断查询词是否以中文为主 */
function isChineseQuery(w) { return /[\u4e00-\u9fa5]/.test(w || ''); }

const Dict = {
  word: '',
  mode: 'dict',    // dict=查词 | search=搜索
  proxyOK: null,   // null=未检测 true=可用 false=不可用
  serverUp: null,  // 服务本身是否在答（true 但 proxyOK=false = 代理端点坏了，提示要重启服务）

  /** 从划词浮层进入查词 */
  async open(word) {
    const w = (word || '').trim();
    if (!w) return;
    this.mode = 'dict';
    this.word = w.slice(0, 60);
    this.show();
  },

  /** 从划词浮层进入搜索：小窗直接出搜索结果 */
  async openSearch(q) {
    const s = (q || '').trim();
    if (!s) return;
    this.mode = 'search';
    this.word = s.slice(0, 120);
    this.show();
  },

  async show() {
    hideSelPopover();
    window.getSelection()?.removeAllRanges();
    const isSearch = this.mode === 'search';
    document.querySelector('#dictDrawer .drawer-head h3').textContent = isSearch ? '搜索' : '查词';
    $('dictDictSec').hidden = isSearch;
    $('dictOnlineSec').hidden = isSearch;
    openDrawer('dictDrawer');
    this.render();
    this.checkProxy();
  },

  render() {
    const w = this.word;
    const isSearch = this.mode === 'search';
    $('dictWord').textContent = isSearch ? `“${w}”` : w;
    $('dictWord').classList.toggle('as-query', isSearch);
    const q = $('dictQuery');
    if (q) { q.value = w; q.onkeydown = e => { if (e.key === 'Enter') this.setWord(q.value); }; }
    const go = $('dictGo');
    if (go) go.onclick = () => this.setWord(q ? q.value : w);
    const hint = $('dictHint');
    if (hint) {
      hint.textContent = isSearch
        ? '默认用整段选区作关键词；也可以改成任意词组再点「查询」。'
        : '可查单词，也可查词组（如 look forward to、人工智能）。选中太长时会自动挑一个词。';
    }
    if (!isSearch) {
      const local = BUILTIN_DICT[w.toLowerCase()] || BUILTIN_DICT[w];
      $('dictLocal').innerHTML = local
        ? `<div class="dict-def">${esc(local)}</div>`
        : '<div class="dict-empty">内置简明词典没有收录这个词<br>可用下方小窗在线查询</div>';
    }

    // 快捷站点：查词用词典站，搜索用搜索引擎
    const sites = isSearch ? SEARCH_SITES : DICT_SITES;
    // 按语种挑默认站点：中文 → 汉典，英文/其它 → 有道
    let defIdx = 0;
    if (!isSearch) {
      const zh = isChineseQuery(w);
      const i = sites.findIndex(s => s.isZh === zh);
      if (i >= 0) defIdx = i;
    }
    $('dictSites').innerHTML = sites.map((s, i) =>
      `<button class="dict-site${i === defIdx ? ' sel' : ''}" data-site="${s.id}"
        ${s.good ? `title="${s.good}"` : ''}>${esc(s.name)}</button>`).join('');
    $('dictSites').querySelectorAll('[data-site]').forEach(b => {
      b.onclick = () => {
        $('dictSites').querySelectorAll('.dict-site').forEach(x => x.classList.remove('sel'));
        b.classList.add('sel');
        const st = this.currentSite();
        this.browse(this.siteUrl(st, this.word), b.dataset.site);
      };
    });

    $('dictOpenExt').onclick = () => {
      const st = this.currentSite();
      openExternal(st && st.url ? st.url(this.word) : 'https://www.bing.com/search?q=' + encodeURIComponent(this.word));
    };

    if (!isSearch) this.fetchOnline(w);
    const first = sites[defIdx] || sites[0];
    this.browse(this.siteUrl(first, w), first.id);
  },

  /** 站点的打开地址：有的站（如 Bing）网页版是 JS 空壳，要走服务端渲染的 /search */
  siteUrl(st, word) {
    if (!st) return '';
    if (typeof st.srv === 'function') return st.srv(word);
    if (st.srv) return `/search?q=${encodeURIComponent(word)}`;
    return st.url ? st.url(word) : '';
  },

  /** 用户在面板里改了查询词 */
  setWord(v) {
    const w = (v || '').trim();
    if (!w) { toast('请输入要查的词'); return; }
    this.word = w.slice(0, 120);
    this.render();
  },

  currentSite() {
    const sel = $('dictSites').querySelector('.dict-site.sel');
    const id = sel ? sel.dataset.site : (this.mode === 'search' ? SEARCH_SITES[0].id : DICT_SITES[0].id);
    return siteById(id, this.mode === 'search');
  },

  /* ---------- 在线英文释义 ---------- */
  async fetchOnline(w) {
    const box = $('dictOnline');
    if (!/^[a-zA-Z][a-zA-Z\s'-]{0,30}$/.test(w)) {
      box.innerHTML = '<div class="dict-empty">英文单词可获取在线音标与释义</div>';
      return;
    }
    box.innerHTML = '<div class="dict-empty">查询中…</div>';
    try {
      const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const e = j[0];
      const ph = e.phonetic || (e.phonetics || []).find(p => p.text)?.text || '';
      const parts = (e.meanings || []).slice(0, 3).map(m =>
        `<div class="dict-mean"><b>${esc(m.partOfSpeech)}</b> ${esc((m.definitions[0] || {}).definition || '')}</div>`
      ).join('');
      box.innerHTML = (ph ? `<div class="dict-ph">/${esc(ph)}/</div>` : '') + parts;
    } catch (e) {
      box.innerHTML = '<div class="dict-empty">在线词典不可用（无网络或被拦截）<br>可用下方小窗查询</div>';
    }
  },

  /* ---------- 小窗浏览器 ---------- */
  async checkProxy() {
    if (this.proxyOK !== null) return this.proxyOK;
    // 重试：页面刚加载、serve.py 尚未完全就绪时 /proxy-ping 可能瞬时失败，
    // 若直接缓存为 false，横幅会一直误报「未检测到本地代理」。最多试 3 次再下结论。
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch('/proxy-ping', { cache: 'no-store' });
        if (r.ok) {
          this.proxyOK = true;
          this.serverUp = true;
          if ($('dictBrowser') && $('dictBrowser').querySelector('.dict-fallback')) {
            const fallback = this.mode === 'search'
              ? `/search?q=${encodeURIComponent(this.word)}`
              : DICT_SITES[0].url(this.word);
            this.browse(this._curUrl || fallback, (this.currentSite() || {}).id);
          }
          return true;
        }
        this.serverUp = true;      // 服答了，只是这个端点不正常
      } catch (e) {
        // 连不上 /proxy-ping：再探 /api/ping 区分「服务没起」与「只有代理端点崩了」
        try {
          const r2 = await fetch('/api/ping', { cache: 'no-store' });
          if (r2.ok) this.serverUp = true;
        } catch (e2) { /* 服务真的没起 */ }
      }
      if (attempt < 2) await new Promise(res => setTimeout(res, 400));
    }
    this.proxyOK = false;
    if ($('dictProxyWarn')) $('dictProxyWarn').hidden = false;
    return false;
  },

  browse(url, siteId) {
    const wrap = $('dictBrowser');
    const status = $('dictFrameStatus');
    this._curUrl = url;
    // 服务端渲染的搜索结果页是本站地址，直接用，不必再走代理
    const isLocal = /^\//.test(url);
    // null 表示「还没检测」，此时先按可用处理，检测结果回来后再纠正
    if (this.proxyOK === false) {
      // 没有代理端点：直接内嵌极可能被拒，改为提示 + 外链
      // 两种原因要分开说，否则用户只会以为「站点不让内嵌」，其实多半是服务端没响应
      const title = this.serverUp ? '本地服务的代理没有响应' : '无法在应用内直接打开';
      const sub = this.serverUp
        ? '<code>/proxy</code> 端点没有正常返回（常见于本机服务还在跑旧代码）。'
          + '请关掉墨阅窗口后重新打开，或运行 <code>start-inkreader.bat</code>；'
          + '也可以在服务重启后点「重试」。'
        : '该站点禁止被内嵌；另外，当前不是通过 <code>tools/serve.py</code> 启动的服务器，'
          + '本地代理不可用。';
      wrap.innerHTML = `<div class="dict-fallback">
        <div class="df-title">${title}</div>
        <div class="df-sub">${sub}</div>
        <div class="df-btns">
          <button class="btn-primary" id="dfRetry">重试</button>
          <button class="btn-plain" id="dfOpen">用系统浏览器打开</button>
        </div></div>`;
      wrap.querySelector('#dfOpen').onclick = () => openExternal(url);
      wrap.querySelector('#dfRetry').onclick = async () => {
        this.proxyOK = null;                     // 重新探一次，别把「旧结论」永久缓存
        await this.checkProxy();
        this.browse(this._curUrl || url, siteId);
      };
      return;
    }
    if (wrap.querySelector('.dict-fallback') || !$('dictFrame')) {
      wrap.innerHTML = '<iframe class="dict-frame" id="dictFrame"></iframe>';
    }
    const f = $('dictFrame');
    status.textContent = '加载中…';
    this._clearWatchdog();
    const done = (ok) => {
      this._clearWatchdog();
      status.textContent = ok ? (isLocal ? '' : '已加载（页面交互受站点限制）') : '加载失败';
      if (ok) this._hideOverlay();
    };
    f.onload = () => done(true);
    f.onerror = () => done(false);
    // 看门狗：/proxy 如果把连接空关闭（服务端崩了），iframe 里只会显示浏览器的
    // 「127.0.0.1 未发送任何数据」，用户完全没法处理。8 秒没 load 就盖一层可操作的提示。
    this._wdT = setTimeout(() => {
      if (!f.isConnected) return;
      this._showOverlay('页面没有返回内容（加载超时）',
        '常见原因：本机服务异常 / 该站点很慢 / 网络不通。可以点「重试」，或用系统浏览器打开。', url);
    }, 8000);
    // frame=1：告诉本地代理「这是小窗里当页面看的」，让它把地址换到原站同一个路径
    // （/result?...）再返回。有道这类 SPA 首屏按 location.pathname 对路由，路径不对
    // 就渲染自己的「很抱歉，网页无法访问 / 系统繁忙」错误页（R57 用户实测）。
    f.src = isLocal ? url : ('/proxy?url=' + encodeURIComponent(url) + '&frame=1');
  },

  _clearWatchdog() {
    if (this._wdT) { clearTimeout(this._wdT); this._wdT = null; }
  },

  _showOverlay(title, sub, url) {
    const wrap = $('dictBrowser');
    if (!wrap) return;
    this._hideOverlay();
    const d = document.createElement('div');
    d.className = 'dict-overlay';
    d.innerHTML = `<div class="do-card">
        <div class="df-title">${esc(title)}</div>
        <div class="df-sub">${esc(sub)}</div>
        <div class="df-btns">
          <button class="btn-primary" data-act="retry">重试</button>
          <button class="btn-plain" data-act="out">用系统浏览器打开</button>
        </div>
      </div>`;
    d.querySelector('[data-act="retry"]').onclick = () => {
      this.proxyOK = null;
      this._hideOverlay();
      this.checkProxy().then(() => this.browse(this._curUrl || url, null));
    };
    d.querySelector('[data-act="out"]').onclick = () => openExternal(url);
    wrap.appendChild(d);
    const st = $('dictFrameStatus');
    if (st) st.textContent = '加载超时';
  },

  _hideOverlay() {
    const wrap = $('dictBrowser');
    const o = wrap && wrap.querySelector('.dict-overlay');
    if (o) o.remove();
  }
};

function siteById(id, isSearch) {
  const pool = isSearch ? SEARCH_SITES : DICT_SITES;
  return pool.find(s => s.id === id) || pool[0];
}

/* 英文停用词：查词时跳过，避免取到 "The" / "of" 这类没有释义的词 */
const EN_STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'at', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'it', 'its', 'that', 'this', 'these', 'those', 'for',
  'with', 'as', 'by', 'from', 'he', 'she', 'they', 'we', 'you', 'i', 'his', 'her', 'their',
  'our', 'but', 'not', 'so', 'if', 'then', 'than', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'can', 'could', 'shall', 'should', 'may', 'might', 'must', 'there', 'here',
  'what', 'which', 'who', 'when', 'where', 'how', 'all', 'any', 'one', 'two', 'no', 'nor']);

/**
 * 从选中的文本里取出「要查的那个词」。
 * - 短选区（≤24 字符）原样返回 —— 支持词组，如 "look forward to"、"人工智能"
 * - 长选区：中文取前 4 字（成语/词上限）；英文跳过停用词取最长实词
 */
function pickQueryWord(t) {
  let s = (t || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  // 去掉首尾标点与引号
  s = s.replace(/^[^\w\u4e00-\u9fa5]+/, '').replace(/[^\w\u4e00-\u9fa5]+$/, '');
  if (!s) return '';
  if (s.length <= 24) return s;

  const zh = s.replace(/[^\u4e00-\u9fa5]/g, '');
  if (zh.length >= 2) return zh.slice(0, 4);

  const words = (s.toLowerCase().match(/[a-zA-Z][a-zA-Z'-]*/g) || []);
  if (!words.length) return s.slice(0, 30);
  const cand = words.filter(w => !EN_STOP.has(w) && w.length > 2);
  const pool = cand.length ? cand : words;
  pool.sort((a, b) => b.length - a.length);
  return (pool[0] || words[0]).slice(0, 30);
}

/**
 * 用系统浏览器打开外链。
 * 在受限制的预览容器里 window.open 可能被拦（返回 null 或直接报错），
 * 因此捕获失败并降级为「显示可复制的链接」。
 */
function openExternal(url) {
  try {
    const w = window.open(url, '_blank', 'noopener,noreferrer');
    if (w) return;
  } catch (e) { /* 落到下面的降级 */ }
  const safe = esc(url);
  toast('已阻止自动跳转，请手动复制地址', 3000);
  const box = document.createElement('div');
  box.className = 'ext-link-box';
  box.setAttribute('role', 'dialog');
  box.innerHTML = `<button class="el-close" aria-label="关闭" title="关闭">×</button>
    <div class="el-t">当前环境无法自动打开新窗口，请复制下面的地址：</div>
    <input class="el-input" readonly value="${safe}">
    <div class="el-acts">
      <a class="btn-primary el-a" href="${safe}" target="_blank" rel="noopener noreferrer">直接前往 ↗</a>
      <button class="btn-plain" id="elCopy">复制地址</button>
    </div>`;
  document.body.appendChild(box);
  const inp = box.querySelector('.el-input');
  const closeBox = () => {
    box.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') closeBox(); };
  box.querySelector('#elCopy').onclick = () => {
    inp.select();
    navigator.clipboard?.writeText(url);
    toast('已复制');
  };
  box.querySelector('.el-close').onclick = closeBox;
  box.querySelector('.el-a').onclick = () => setTimeout(() => box.remove(), 500);
  document.addEventListener('keydown', onKey);
  setTimeout(() => { inp.select(); }, 50);
}

/* 供划词浮层调用 */
function lookupWord() {
  const r = $('selPopover')._range;
  if (!r) return;
  Dict.open(pickQueryWord(r.text));
}

/* 供划词浮层调用：搜索（原样作为关键词，小窗直接出结果） */
function searchWeb() {
  const r = $('selPopover')._range;
  if (!r) return;
  Dict.openSearch(r.text);
}
