/* ============================================================
   sync.js —— 书库与「安装目录 / data」双向对账
   ------------------------------------------------------------
   背景：书籍原本只存在浏览器 IndexedDB 里，而 IndexedDB 是按 origin
   隔离的 —— 127.0.0.1:8123、localhost:8123、局域网 IP:8123 是三份
   互不相通的库，iPad 从局域网打开更是空书库。

   现在由本地服务（tools/serve.py）把书库镜像到安装目录的 data/ 下：
     data/index.json        轻量索引（书名/进度/时间戳，不含正文）
     data/books/<id>.json   整本书（格式与备份 zip 里的 books/<id>.json 一致）
     data/annots/<id>.json  该书的高亮/笔记/书签/笔迹
     data/kv/<key>.json     设置、收藏夹

   本模块负责双向对账：
     · 启动时拉索引，本地缺的补下来、本地多的推上去、两边都有的按时间戳取新
     · 阅读中改进度只推「轻量 meta」，不会为翻一页重传整本 PDF
     · 删书走「墓碑」，别的设备下次对账时跟着删

   没有后端（GitHub Pages / file:// 直接打开）时整体自动停用，一切照旧。
   ============================================================ */

const Sync = (() => {
  const API = '/api/store';
  const KV_MAP = '__sync';           // 本地同步账本（存在 IndexedDB 的 kv 仓）
  const KV_SYNC_KEYS = ['settings', 'collections'];

  const state = {
    ok: false,          // 后端存储可用
    probed: false,      // 是否已经探过一次后端（探过且不可用才彻底停用）
    busy: false,        // 正在对账
    lastErr: '',
    pulled: 0,          // 本次启动从 data/ 拉下来的书数
    pushed: 0,          // 本次启动推上去的书数
    merged: 0,          // 本次启动合并了别人进度的书数
    deleted: 0,         // 本次启动因墓碑跟着删掉的书数
    root: '',           // 落盘目录（服务端 data/ 或 data-dev/ 的绝对路径）
    app: '',            // 服务端所在目录（安装目录 / 源码目录）
    dev: false          // true = 当前服务跑在源码树里（落 data-dev，不是用户书库）
  };

  let _map = null;      // { books:{id:{ts,sig}}, annots:{id:ts}, kv:{k:ts} }
  let _silent = 0;      // >0 表示当前写入来自对账本身，不要再触发回推
  let _rawPut = null, _rawDel = null, _rawDelByIndex = null;
  const _timers = Object.create(null);

  /* 只有「探过、且确认没有后端」才真正停用。
     页面刚加载、对账还没跑完时 state.ok 仍是 false，这时用户删书/导入不能被静默吞掉。 */
  function backendOff() { return state.probed && !state.ok; }

  /* ---------------- 基础请求 ---------------- */
  function _url(path, q) {
    let u = API + path;
    if (q) {
      const s = Object.keys(q).filter(k => q[k] != null)
        .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(q[k])).join('&');
      if (s) u += '?' + s;
    }
    return u;
  }

  async function _req(method, path, body, ms) {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), ms || 12000);
    try {
      const opt = { method, signal: ac.signal, cache: 'no-store' };
      if (body !== undefined) {
        opt.headers = { 'Content-Type': 'application/json' };
        opt.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const r = await fetch(_url(path), opt);
      const txt = await r.text();
      let j = null;
      try { j = JSON.parse(txt); } catch (e) { j = null; }
      if (!r.ok || !j) throw new Error((j && j.msg) || ('HTTP ' + r.status));
      return j;
    } finally {
      clearTimeout(tid);
    }
  }

  /* ---------------- 书的「内容指纹」 ----------------
     只用来判断正文有没有变（变了才整本重传）。用长度而非哈希：
     几百 MB 的 PDF 做哈希会明显卡顿，而正文变化几乎必然改变长度。 */
  function signature(b) {
    const c = (b && b.content) || {};
    let n = 0;
    if (c.kind === 'pdf') n = (c.data && (c.data.byteLength || c.data.length)) || 0;
    else if (c.kind === 'images') n = (c.items || []).reduce((s, it) => s + ((it.blob && it.blob.size) || 0), 0) + (c.items || []).length;
    else if (c.kind === 'html') n = (c.html || '').length;
    else n = (c.text || '').length;
    return (c.kind || 'text') + ':' + n + ':' + (b && b.cover ? 1 : 0);
  }

  /* 轻量元数据：不含正文/封面，几百字节，翻页时只推这一份 */
  function metaOf(b) {
    return {
      id: b.id, title: b.title, format: b.format,
      length: b.length || 0, totalPages: b.totalPages || 0,
      locator: b.locator || 0, progress: b.progress || 0,
      addedAt: b.addedAt || 0, lastReadAt: b.lastReadAt || 0,
      fav: !!b.fav, pinned: !!b.pinned, collection: b.collection || null,
      color: b.color || null, chapters: b.chapters || [],
      tags: Array.isArray(b.tags) ? b.tags : []
    };
  }

  const META_KEYS = ['title', 'format', 'length', 'totalPages', 'locator', 'progress',
    'addedAt', 'lastReadAt', 'fav', 'pinned', 'collection', 'color', 'chapters', 'tags'];

  /* ---------------- 账本 ---------------- */
  function _blank() { return { books: {}, annots: {}, kv: {} }; }

  async function _loadMap() {
    if (_map) return _map;
    const m = await DB.kvGet(KV_MAP, null);
    _map = (m && m.books) ? m : _blank();
    _map.annots = _map.annots || {};
    _map.kv = _map.kv || {};
    return _map;
  }

  function _saveMap() {
    if (!_map) return;
    clearTimeout(_timers.__map);
    _timers.__map = setTimeout(() => {
      DB.put('kv', { k: KV_MAP, v: _map }).catch(() => {});
    }, 400);
  }

  /* ---------------- 推送 ---------------- */
  async function pushMeta(b) {
    if (backendOff()) return;
    try {
      const r = await _req('POST', '/meta', { id: b.id, meta: metaOf(b) }, 15000);
      const mp = await _loadMap();
      const ent = mp.books[b.id] || { sig: signature(b) };
      ent.ts = r.ts || Date.now();
      mp.books[b.id] = ent;
      _saveMap();
    } catch (e) { state.lastErr = String(e.message || e); }
  }

  async function pushFull(b) {
    if (backendOff()) return;
    try {
      const packed = await Backup.packBook(b);
      // 先写轻量 meta（索引里先有条目），再整本落盘
      await _req('POST', '/meta', { id: b.id, meta: metaOf(b) }, 15000);
      const r = await _req('POST', '/book?id=' + encodeURIComponent(b.id),
        JSON.stringify(packed), 180000);
      const mp = await _loadMap();
      mp.books[b.id] = { ts: r.ts || Date.now(), sig: signature(b) };
      _saveMap();
      state.pushed++;
    } catch (e) { state.lastErr = String(e.message || e); }
  }

  async function pushAnnots(bookId) {
    if (backendOff() || !bookId) return;
    try {
      const list = await Annot.list(bookId);
      const r = await _req('POST', '/annots', { bookId, list }, 20000);
      const mp = await _loadMap();
      mp.annots[bookId] = r.ts || Date.now();
      _saveMap();
    } catch (e) { state.lastErr = String(e.message || e); }
  }

  async function pushKv(k) {
    if (backendOff()) return;
    try {
      const v = await DB.kvGet(k, null);
      const r = await _req('POST', '/kv', { k, v }, 20000);
      const mp = await _loadMap();
      mp.kv[k] = r.ts || Date.now();
      _saveMap();
    } catch (e) { state.lastErr = String(e.message || e); }
  }

  async function delRemote(kind, key) {
    if (backendOff()) return;
    try {
      await _req('POST', '/delete', { kind, key }, 15000);
    } catch (e) { state.lastErr = String(e.message || e); }
  }

  /* ---------------- 写入钩子（由 _hook 挂到 DB 上） ---------------- */
  async function onWrite(store, obj) {
    if (backendOff() || _silent || !obj) return;
    if (store === 'books') {
      const id = obj.id;
      const mp = await _loadMap();
      const ent = mp.books[id];
      const sig = signature(obj);
      clearTimeout(_timers['b:' + id]);
      // 正文变了立刻整本推；只是进度/标签变了，推轻量 meta 即可
      if (!ent || ent.sig !== sig) {
        _timers['b:' + id] = setTimeout(() => pushFull(obj), 1200);
      } else {
        _timers['b:' + id] = setTimeout(() => pushMeta(obj), 900);
      }
    } else if (store === 'annots') {
      const bid = obj.bookId;
      clearTimeout(_timers['a:' + bid]);
      _timers['a:' + bid] = setTimeout(() => pushAnnots(bid), 900);
    } else if (store === 'kv' && KV_SYNC_KEYS.indexOf(obj.k) >= 0) {
      clearTimeout(_timers['k:' + obj.k]);
      _timers['k:' + obj.k] = setTimeout(() => pushKv(obj.k), 900);
    }
  }

  async function onDelete(store, id) {
    if (backendOff() || _silent) return;
    if (store === 'books') {
      delRemote('books', id);
      const mp = await _loadMap();
      delete mp.books[id];
      delete mp.annots[id];
      _saveMap();
    } else if (store === 'annots') {
      // 单条笔记删除：重推该书的整份列表（bookId 由调用方保证已写回，这里靠 300ms 后取最新）
      clearTimeout(_timers.__ann);
      _timers.__ann = setTimeout(async () => {
        try {
          const all = await DB.getAll('annots');
          const touched = new Set(all.map(a => a.bookId));
          const mp = await _loadMap();
          const ids = new Set([...Object.keys(mp.annots), ...touched]);
          for (const bid of ids) pushAnnots(bid);
        } catch (e) { }
      }, 600);
    }
  }

  /* ---------------- 对账 ---------------- */
  async function _pullBook(id, meta) {
    const r = await _req('GET', '/book?id=' + encodeURIComponent(id), undefined, 180000);
    if (r.missing) return false;
    const b = await Backup.unpackBook(r);
    _silent++;
    try {
      await _rawPut('books', b);
    } finally { _silent--; }
    return true;
  }

  async function _mergeMeta(id, meta) {
    const local = await DB.get('books', id);
    if (!local) return _pullBook(id, meta);
    for (const k of META_KEYS) {
      if (meta && Object.prototype.hasOwnProperty.call(meta, k)) local[k] = meta[k];
    }
    _silent++;
    try { await _rawPut('books', local); } finally { _silent--; }
    return true;
  }

  async function _pullAnnots(bookId) {
    const r = await _req('GET', '/annots?id=' + encodeURIComponent(bookId));
    if (r.missing) return;
    const list = Array.isArray(r.list) ? r.list : [];
    _silent++;
    try {
      await DB.delByIndex('annots', 'bookId', bookId);
      for (const a of list) await _rawPut('annots', a);
    } finally { _silent--; }
  }

  /**
   * 启动对账。返回 {ok, pulled, pushed}。
   * 没有后端（静态托管）时直接返回 ok:false，不影响任何功能。
   */
  async function init(force) {
    if (state.ok && !force) return state;   // 已对过账（force=强制重跑）
    let idx = null;
    try {
      idx = await _req('GET', '/index', undefined, 8000);
      state.ok = true;
      state.probed = true;
      state.root = idx.root || '';
      /* R74：服务端会告诉本页「我是源码树还是安装版」。源码树落到 data-dev，
         不是用户书库 —— 界面要能一眼看出来（否则又变成「感觉还是浏览器」）。 */
      state.app = idx.app || '';
      state.dev = !!idx.dev;
    } catch (e) {
      state.ok = false;
      state.probed = true;
      state.lastErr = String(e.message || e);
      return state;
    }

    state.busy = true;
    let pulled = 0, pushed = 0, merged = 0, deleted = 0;
    try {
    const mp = await _loadMap();

    const srvBooks = idx.books || {};
    const srvAnnots = idx.annots || {};
    const srvKv = idx.kv || {};
    const tomb = idx.tomb || {};

    try {
      /* 1) 服务器已删（墓碑）→ 本地跟着删 */
      for (const id of Object.keys(tomb)) {
        const t = tomb[id] || 0;
        const ent = mp.books[id];
        if (ent && ent.ts >= t) continue;      // 本地删后又重新导入的同 id 不删
        const local = await DB.get('books', id);
        if (local) {
          _silent++;
          try {
            await _rawDel('books', id);
            await DB.delByIndex('annots', 'bookId', id);
          } finally { _silent--; }
        }
        delete mp.books[id];
        delete mp.annots[id];
        if (local) deleted++;      // 别人删的书，本机也删了 → 书架要重画
      }

      /* 2) 服务器有 → 本地没有就下载，本地更旧就合并 meta */
      const ids = Object.keys(srvBooks);
      let done = 0;
      for (const id of ids) {
        const ts = (srvBooks[id] && srvBooks[id].ts) || 0;
        const meta = (srvBooks[id] && srvBooks[id].meta) || null;
        const ent = mp.books[id];
        const local = await DB.get('books', id);
        try {
          if (!local) {
            if (await _pullBook(id, meta)) { pulled++; mp.books[id] = { ts, sig: '' }; }
          } else if (!ent || ent.ts < ts) {
            await _mergeMeta(id, meta);
            merged++;
            mp.books[id] = { ts, sig: (mp.books[id] && mp.books[id].sig) || signature(await DB.get('books', id)) };
          }
        } catch (e) {
          state.lastErr = String(e.message || e);
        }
        done++;
        if (pulled && done % 3 === 0 && typeof toast === 'function') {
          toast('正在同步书库 ' + done + '/' + ids.length, 1200);
        }
      }

      /* 3) 本地有、服务器没有 → 推上去 */
      const localAll = await DB.getAll('books');
      for (const b of localAll) {
        if (srvBooks[b.id]) continue;
        await pushFull(b);
        pushed++;
      }

      /* 4) 笔记对账 */
      const annotIds = new Set([...Object.keys(srvAnnots),
        ...(await DB.getAll('annots')).map(a => a.bookId)]);
      for (const bid of annotIds) {
        if (!srvBooks[bid] && !(await DB.get('books', bid))) continue;
        const ts = srvAnnots[bid] || 0;
        const mine = mp.annots[bid] || 0;
        try {
          if (ts > mine) {
            await _pullAnnots(bid);
            mp.annots[bid] = ts;
          } else if (mine >= ts) {
            await pushAnnots(bid);
          }
        } catch (e) { state.lastErr = String(e.message || e); }
      }

      /* 5) 设置 / 收藏夹 */
      for (const k of KV_SYNC_KEYS) {
        const ts = srvKv[k] || 0;
        const mine = mp.kv[k] || 0;
        try {
          if (ts > mine) {
            const r = await _req('GET', '/kv?k=' + encodeURIComponent(k));
            if (!r.missing && r.v !== null && r.v !== undefined) {
              _silent++;
              try { await _rawPut('kv', { k, v: r.v }); } finally { _silent--; }
              mp.kv[k] = ts;
            } else { await pushKv(k); }
          } else if (mine >= ts) {
            await pushKv(k);
          }
        } catch (e) { state.lastErr = String(e.message || e); }
      }

      _saveMap();
      state.pulled = pulled;
      state.pushed = pushed;
      state.merged = merged;
      state.deleted = deleted;
    } catch (e) {
      state.lastErr = String((e && e.message) || e);
    }

    // 只要有书被拉下来 / 推上去 / 进度被别的设备更新过，书架都要重画一次，
    // 否则「另一台设备读到第几页」在本机界面上看不到（Library.all 里是旧快照）。
    if ((pulled || pushed || merged || deleted) && typeof Library !== 'undefined' && Library.refresh) {
      try {
        await loadSettings();
        await Library.refresh();
      } catch (e) { }
    }
    } catch (e) {
      // 对账整体失败（比如索引结构异常）：不能把 busy 卡在 true，否则再也不同步
      state.lastErr = String((e && e.message) || e);
    } finally {
      state.busy = false;
    }
    return state;
  }

  /* 清除全部数据时，服务器上的镜像也要清，否则下次启动又被拉回来 */
  async function clearAll() {
    try {
      await _req('POST', '/wipe', {}, 20000);
    } catch (e) { }
    _map = _blank();
    _saveMap();
  }

  /* ---------------- 挂到 DB 上 ---------------- */
  function _hook() {
    if (typeof DB === 'undefined' || DB.__syncHooked) return;
    _rawPut = DB.put.bind(DB);
    _rawDel = DB.del.bind(DB);
    _rawDelByIndex = DB.delByIndex.bind(DB);
    const _wipe = DB.wipe.bind(DB);
    DB.put = function (store, obj) {
      const p = _rawPut(store, obj);
      try { onWrite(store, obj); } catch (e) { }
      return p;
    };
    DB.del = function (store, id) {
      const p = _rawDel(store, id);
      try { onDelete(store, id); } catch (e) { }
      return p;
    };
    DB.wipe = async function () {
      const r = await _wipe();
      // ⚠️ 自动化（Playwright / headless，navigator.webdriver=true）清库时**不许**连带清
      // 安装目录里的 data/ 镜像：跑一次冒烟就把用户真实书库镜像清空过一次（2026-10-24，
      // 21MB / 23 本书），只能靠浏览器里的 IndexedDB 再推回来。真机上照旧要清，
      // 否则「清空全部」之后下次启动又被拉回来。
      const automated = (typeof navigator !== 'undefined' && navigator.webdriver)
        && !(typeof window !== 'undefined' && window.__inkForceStoreWipe);
      if (automated) {
        _map = _blank();
        _saveMap();
      } else {
        clearAll();
      }
      return r;
    };
    DB.__syncHooked = true;
  }

  _hook();

  return {
    state, init, clearAll,
    pushAnnots, pushKv,
    signature, metaOf,
    /** 强制整本重推（正文被外部改写后调用） */
    async pushBook(id) {
      const b = await DB.get('books', id);
      if (b) await pushFull(b);
    }
  };
})();
