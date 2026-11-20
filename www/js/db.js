/* ============================================================
   db.js —— 基于 IndexedDB 的本地存储
   库：books（含内容）、annots（高亮/笔记/书签/涂鸦）、kv（设置）
   ============================================================ */
/* 应用版本号：每次改动 js/css 后递增，界面左下角可见，用于确认浏览器加载的是最新代码 */
const APP_VERSION = 'r177';

const DB = (() => {
  const NAME = 'inkreader-web';
  const VER = 1;
  let _db = null;

  function open() {
    return new Promise((resolve, reject) => {
      if (_db) return resolve(_db);
      const req = indexedDB.open(NAME, VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('annots')) {
          const s = db.createObjectStore('annots', { keyPath: 'id' });
          s.createIndex('bookId', 'bookId');
        }
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv', { keyPath: 'k' });
        }
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode = 'readonly') {
    return open().then(db => db.transaction(store, mode).objectStore(store));
  }

  function wrap(req) {
    return new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  const api = {
    async put(store, obj) { const s = await tx(store, 'readwrite'); return wrap(s.put(obj)); },
    async get(store, id) { const s = await tx(store); return wrap(s.get(id)); },
    async getAll(store) { const s = await tx(store); return wrap(s.getAll()); },
    async del(store, id) { const s = await tx(store, 'readwrite'); return wrap(s.delete(id)); },
    async clear(store) { const s = await tx(store, 'readwrite'); return wrap(s.clear()); },
    async byIndex(store, index, key) {
      const s = await tx(store);
      return wrap(s.index(index).getAll(key));
    },
    async delByIndex(store, index, key) {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction(store, 'readwrite');
        const os = t.objectStore(store);
        const req = os.index(index).getAllKeys(key);
        req.onsuccess = () => {
          req.result.forEach(k => os.delete(k));
          res();
        };
        req.onerror = () => rej(req.error);
      });
    },
    async kvGet(k, def) {
      const r = await api.get('kv', k);
      return r ? r.v : def;
    },
    async kvSet(k, v) { return api.put('kv', { k, v }); },
    async wipe() {
      await api.clear('books'); await api.clear('annots'); await api.clear('kv');
    }
  };
  return api;
})();

/* ---------- 设置 ---------- */
const DEFAULT_SETTINGS = {
  themeId: 'paper',
  customBg: '#F7F4EC',
  customFg: '#2B2B2B',
  /* 界面背景（书架页 + 侧边栏，不是阅读正文）：
     uiBg = 底色（空 = 用主题原本的白色，改动设置才生效）；
     uiSideBg = 侧边栏单独颜色（空 = 跟 uiBg）；
     uiBgImg = 背景图 dataURL（空 = 不设）；uiBgAlpha = 图片不透明度 0~1；
     uiFg = 书架文字颜色（空 = 跟着 uiBg 自动选黑/白）；
     uiSideFg = 侧边栏文字颜色（空 = 按侧栏自己的底色自动选黑/白 —— 侧栏和主区
                深浅相反时，沿用主区字色就是黑字压深底，看不见）；
     uiCoverAlpha = 书架封面不透明度 0.1~1（1 = 原来的不透明封面）；
                只淡封面这块「板」（图片/底色），书名与角标保持清楚。
     uiAccentMode = 强调色来源：auto = 跟着背景色系（默认）| blue = 固定 iOS 蓝。
                米色/护眼绿/夜蓝这些底色上，写死的蓝按钮、蓝字都是「外来物」，
                所以默认按背景色相派生；只想要原来那抹蓝的人可以切回 blue。 */
  uiBg: '',
  uiSideBg: '',
  uiBgImg: '',
  uiBgAlpha: 0.35,
  uiFg: '',
  uiSideFg: '',
  uiCoverAlpha: 1,
  uiAccentMode: 'auto',
  /* 选中文字后「高亮」按钮用哪个颜色（下标对应 HL_COLORS，-1/空 = 第一个） */
  hlColorIdx: 0,
  /* 书架排序：档位 recent/added/title/progress/manual，方向 1 或 -1（-1 = 反过来）。
     收藏夹以前强制按手动 sortOrder，最近读的书永远排不上去 —— 现在统一走这套。 */
  libSort: 'recent',
  libSortDir: 1,
  fontSize: 20,
  lineHeight: 1.8,
  letterSpacing: 0.5,
  paraSpacing: 0.9,
  margin: 56,
  fontFamily: 'serif',
  bold: false,
  align: 'left',
  direction: 'horizontal',   // horizontal=左右翻页 | vertical=上下滚动
  autoSpeed: 6,              // 秒/页
  keepAwake: true,
  tapTurn: true,
  ttsRate: 1,                // 播读语速
  ttsVoice: '',              // 播读音色
  /* 漫画阅读：contain=整页 | width=适应宽度 | height=适应高度 | cover=填满裁切 */
  comicFit: 'contain',
  comicSpread: false,        // 双页（只在横屏生效）
  comicRTL: false,           // 右→左（日漫）
  /* 阅读形态：paged=一屏一页 | scroll=连续卷轴（条漫，所有页拼成一条长卷往下滚） */
  comicMode: 'paged',
  /* 富文本（html/epub）阅读形态：false=整篇滚动 | true=翻页模式（按屏幕高切成 .html-page） */
  htmlPaged: false,
  /* 漫画图片缩放：1 = 100%（按上面的 fit 适配）；范围 0.3~3（30%~300%）。
     低于 100% 可把整页缩小看全局，高于 100% 放大后可在框内拖动看细节。 */
  comicZoom: 1,
  /* OCR（PDF 扫描页 / 图片书）：识别语言（Tesseract 语言码，可多个）+ 排版方向。
     ocrDir：auto = 先横排、认不出东西再转 90° 试竖排 | h = 只横排 | v = 只竖排。
     书里可以单独存（kv `ocrCfg:<书号>`），这里只是「上次选的」默认值。 */
  ocrLangs: ['chi_sim', 'eng'],
  ocrDir: 'auto',
  /* 识别引擎（R123）：auto = 有本地视觉模型就用它、没有退回浏览器内 Tesseract；
     local = 强制本地模型；tesseract = 强制浏览器内。本地模型要另外下载（约 1.1 GB），
     装在安装目录 localocr\ 下，不碰 C 盘。 */
  ocrEngine: 'auto',
  /* R159：把识别交给另一台设备（通常是同一局域网里装了视觉模型的电脑），
     形如 http://电脑的局域网地址:8123（留空＝只用本机）。手机自己跑不动视觉模型，
     但借用电脑的能强一个代差；连不上就自动退回手机内 Tesseract。 */
  ocrRemoteBase: '',
  swipeTurn: true,           // 手指/鼠标划动翻页（关掉后只能用底栏按钮，划词选字更稳）
  /* 目录「自定义格式识别」正则：空 = 仅用内置 CHAPTER_RE（第X章/卷部篇/Markdown/【】等）。
     用户在前端目录抽屉里填自己的正则后，parseChapters 会额外用它对每行再匹配一次。 */
  tocCustom: '',
  /* 自定义目录识别是否保留原符号（如「第xx章」）。true=保留(默认，满足 #5)；
     false=不保留：优先用规则里的捕获组 ( ) 内容，否则去掉行首序号符号，仅留标题正文。 */
  tocKeepMarker: true,
  /* PDF 扫描页（图片型，几乎无文本层）是否自动跑 OCR 识别文字。
     false=默认不自动跑；遇到扫描页时显示「🔍 点此识别」覆盖层，由用户逐页选择（满足 #20）。
     true=导入/打开时自动对扫描页 OCR（需联网下载语言包，较慢）。 */
  pdfAutoOcr: false
};

const THEMES = [
  { id: 'paper',  name: '米黄', bg: '#F7F4EC', fg: '#2B2B2B', bar: false },
  { id: 'green',  name: '护眼', bg: '#DCE8D5', fg: '#243021', bar: false },
  { id: 'white',  name: '纯白', bg: '#FFFFFF', fg: '#1A1A1A', bar: false },
  { id: 'sepia',  name: '羊皮', bg: '#EFE0C4', fg: '#3A2E1F', bar: false },
  { id: 'night',  name: '夜间', bg: '#1C1C1E', fg: '#B8B8BE', bar: true },
  { id: 'black',  name: '纯黑', bg: '#000000', fg: '#8E8E93', bar: true },
  { id: 'custom', name: '自定义', bg: '#F7F4EC', fg: '#2B2B2B', bar: false }
];

const FONTS = [
  { id: 'serif', name: '宋体', css: '"Songti SC","SimSun",Georgia,serif' },
  { id: 'sans',  name: '黑体', css: '"PingFang SC","Helvetica Neue",sans-serif' },
  { id: 'kai',   name: '楷体', css: '"Kaiti SC","STKaiti","KaiTi",serif' },
  { id: 'hei2',  name: '圆体', css: '"Yuanti SC","Hiragino Sans GB",sans-serif' }
];

const INK_COLORS = ['#000000', '#E03131', '#1971C2', '#2F9E44', '#F08C00', '#9C36B5', '#FFFFFF'];
const HL_COLORS = ['#FFE066', '#FFC9C9', '#B2F2BB', '#A5D8FF', '#D0BFFF', '#FFD8A8'];

/* 标记样式：高亮 / 下划线 / 删除线 / 波浪线 / 粗体 */
const MARK_STYLES = [
  { id: 'highlight', name: '高亮', ico: 'hl' },
  { id: 'underline', name: '下划线', ico: 'ul' },
  { id: 'strike',    name: '删除线', ico: 'st' },
  { id: 'wavy',      name: '波浪线', ico: 'wv' },
  { id: 'bold',      name: '粗体',   ico: 'bd' }
];
/* 生成标记的内联样式（color 为空时用默认色） */
function markInlineStyle(style, color) {
  const c = color || HL_COLORS[0];
  switch (style) {
    case 'underline': return `border-bottom:2px solid ${c};padding-bottom:1px`;
    case 'strike':    return `text-decoration:line-through;text-decoration-color:${c};text-decoration-thickness:2px`;
    case 'wavy':      return `text-decoration:underline;text-decoration-style:wavy;text-decoration-color:${c};text-underline-offset:3px;text-decoration-thickness:1.5px`;
    // 粗体不改变颜色，保持与正文一致（改色会在浅色主题下发灰、反而看不清）
    case 'bold':      return `font-weight:800`;
    default:          return `background:${hexA(c, 0.45)}`;
  }
}

let Settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  const s = await DB.kvGet('settings', null);
  Settings = Object.assign({}, DEFAULT_SETTINGS, s || {});
  return Settings;
}
function saveSettings() { return DB.kvSet('settings', Settings); }

/* ---------- 书名唯一化（R133） ----------
   同一本书导入两次，书库里就躺着两个一模一样的「三体」；共享时谁也说不清
   被共享的是哪一本（用户原话）。所以入库和改名统一过这一道：
   重名自动补「（1）」「（2）」……先入库的保留原名。
   · 已经带尾号的书再撞（「三体（2）」导入第二次）会剥回基名往后数，
     不会叠成「三体（1）（1）」这种鬼东西；
   · 判重只抹平首尾空白、全/半角括号和大小写 ——「三体」和「三体 」算同名，
     `Deep Work` 和 `deep work` 也算同名（宁可多给一个序号，也别让两本书在
     共享列表里长得一模一样）。
   ------------------------------------------------------ */
const TITLE_TAIL_RE = /^(.*?)[ \t]*[（(][ \t]*([0-9]{1,3})[ \t]*[)）][ \t]*$/;

function titleBase(t) {
  const s = String(t == null ? '' : t).trim();
  const m = TITLE_TAIL_RE.exec(s);
  return (m && m[1].trim()) ? m[1].trim() : s;
}

function titleKey(t) {
  return String(t == null ? '' : t)
    .replace(/（/g, '(').replace(/）/g, ')')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .toLowerCase();
}

/* 一次拖进五本同名 txt 时，前几本已经 put 进库、但 Library.all 还没刷新，
   光看内存书单会以为「没占号」→ 五本全拿到「（1）」。
   这里记一笔本次运行分配出去的名字。Library.refresh() 重新读盘后清空。 */
const _titleReserved = new Set();
function titleTakenReset() { _titleReserved.clear(); }

/** 取一个不撞名的书名；exceptId 用于改名（自己不该跟自己撞）。 */
function uniqueBookTitle(title, exceptId) {
  const raw = String(title == null ? '' : title).trim() || '未命名';
  const taken = new Set(_titleReserved);
  const list = (typeof Library !== 'undefined' && Library.all) || [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b && b.title != null && b.id !== exceptId) taken.add(titleKey(b.title));
  }
  let out = raw;
  if (taken.has(titleKey(raw))) {
    const base = titleBase(raw);
    let n = 1;
    while (n < 1000 && taken.has(titleKey(base + '（' + n + '）'))) n++;
    out = base + '（' + n + '）';
  }
  _titleReserved.add(titleKey(out));
  return { title: out, changed: out !== raw };
}

/* ---------- 标注（高亮/笔记/书签/涂鸦） ---------- */
const Annot = {
  async list(bookId) { return DB.byIndex('annots', 'bookId', bookId); },
  async add(a) {
    a.id = a.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
    await DB.put('annots', a);
    return a;
  },
  async remove(id) { return DB.del('annots', id); },
  async removeBook(bookId) { return DB.delByIndex('annots', 'bookId', bookId); }
};
