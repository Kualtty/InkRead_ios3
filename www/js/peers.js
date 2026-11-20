/* ============================================================
   peers.js —— 两台墨阅直连对账（LAN 版「多端同步」）
   ------------------------------------------------------------
   和「📡 共享」不一样：
     共享   = 对方先把书加密发过来，收下后各看各的（拷贝）；
     对账   = 两边的 data/ 直接比一遍，谁新听谁的，缺的书补过去/拉回来。

   为什么浏览器来当裁判：
     书库本来就镜像在各自服务器的 data/ 下（js/sync.js 那一套），
     所以只要让本页同时读两边的 /api/store/* 索引、按时间戳取新，
     就等于把「本机 ↔ 本机服务器」那套对账逻辑复制成「本机 ↔ 对方」。

   规则（和 sync.js 一致，避免出现两套口径）：
     · 只有对方有 → 整本拉过来（书 + 笔记 + 目录都在 book JSON 里）
     · 只有本机有 → 整本推过去
     · 两边都有   → 只比「轻量 meta」（进度/书名/标签），不重传正文
     · 笔记、设置、收藏夹 → 按 ts 取新，整份覆盖（不合并）
     · 墓碑（删除）→ 谁删的，另一边跟着删
   冲突就是「后改的赢」，没有三方合并 —— 同一本书两边同时改正文会丢一边。
   ============================================================ */

const Peers = (() => {
  const LS = 'ink.peers';        // 只存在本机（每台设备的「对方地址」都不一样，不该跟着 kv 同步）
  const API = '/api/store';
  const KV_KEYS = ['settings', 'collections'];

  /* ---------------- 配对列表 ---------------- */

  function list() {
    try {
      const a = JSON.parse(localStorage.getItem(LS) || '[]');
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  }

  function save(a) {
    try { localStorage.setItem(LS, JSON.stringify(a.slice(0, 20))); } catch (e) { }
  }

  /** 记一台设备（addr 形如 192.168.1.5:8123）；name 只在第一次给。
      ⚠ R168：光按地址记会把同一台机器记成好几条 —— 路由器重新分配 IP、
      换了 WiFi、同一台电脑有 Wi-Fi 和热点两个地址，都会多出「同名不同地址」的一条。
      所以现在能带上对方自报的 uid（`/api/share/discover-info` 里那个），
      uid 相同就是同一台机器：**换地址而不是新增**。 */
  function remember(addr, name, uid) {
    const a = list();
    const key = base(addr);
    let old = a.find(x => base(x.addr) === key);
    /* 只认「已经探通过」的 uid：手动敲地址点连接时还没有 uid，
       不能拿它去覆盖别的记录（那个地址可能压根打不通）。 */
    if (!old && uid) old = a.find(x => x.uid && x.uid === uid);
    if (old) {
      if (name && !old.name) old.name = name;
      if (uid && !old.uid) old.uid = uid;
      if (base(old.addr) !== key) old.addr = key;      // 换了 IP：迁移，不新增
    } else {
      a.push({ addr: key, name: name || '', uid: uid || '', at: 0, note: '' });
    }
    save(a);
    return a;
  }

  function forget(addr) {
    const key = base(addr);
    save(list().filter(x => base(x.addr) !== key));
  }

  function touch(addr, note, uid) {
    const a = list();
    const key = base(addr);
    let e = a.find(x => base(x.addr) === key);
    if (!e && uid) e = a.find(x => x.uid && x.uid === uid);
    if (e) {
      e.at = Date.now(); e.note = note || '';
      if (uid) e.uid = uid;
      if (base(e.addr) !== key) e.addr = key;
    } else {
      a.push({ addr: key, at: Date.now(), note: note || '', uid: uid || '' });
    }
    save(a);
  }

  /** 把「刚扫到的设备」和「以前存的设备」合成一个展示列表，顺手把过期的地址改掉。
      items: [{uid,name,ip,port,sharing}]（Device.discover 的返回值，已按 uid 去过重）
      返回：和 main.js 里设备行需要的字段一致。 */
  function reconcile(items) {
    const scan = (items || []).slice();
    const a = list();
    let changed = false;

    const byUid = new Map(), byAddr = new Map();
    scan.forEach(it => {
      if (!it) return;
      if (it.uid) byUid.set(it.uid, it);
      if (it.ip) byAddr.set(base(it.ip + ':' + it.port), it);
    });

    // 1) 老记录补身份；同 uid 的地址以「刚扫到、刚探通」的为准
    a.forEach(s => {
      const hit = s.uid ? byUid.get(s.uid) : byAddr.get(base(s.addr));
      if (!hit) return;
      if (!s.uid && hit.uid) { s.uid = hit.uid; changed = true; }
      const nb = base(hit.ip + ':' + hit.port);
      if (base(s.addr) !== nb) { s.addr = nb; changed = true; }
      if (!s.name && hit.name) { s.name = hit.name; changed = true; }
    });

    /* 1.5) 老版本存的记录里没有 uid，而它那个地址早就被路由器换掉了 ——
       这种情况光按地址永远对不上，于是「旧的一条 + 新扫到的一条」同时显示。
       判据：名字一样 + 这次没扫到它 + 扫描结果里同名的只剩一台。不敢猜就别动，
       用户还能在「连不上」的对话框里选「从列表里移除」。 */
    const claimed = new Set();
    a.forEach(s => { if (s.uid) claimed.add(s.uid); });
    a.filter(s => !s.uid).forEach(s => {
      const nm = String(s.name || '').trim();
      if (!nm) return;
      const same = scan.filter(it => it && it.uid && !claimed.has(it.uid)
        && String(it.name || '').trim() === nm);
      if (same.length === 1) {
        s.uid = same[0].uid;
        s.addr = base(same[0].ip + ':' + same[0].port);
        claimed.add(same[0].uid);
        changed = true;
        return;
      }
      /* 一条都没剩，但扫描里**确实有同名的**设备，说明那台已经被
         「地址命中的那条记录」认领了 —— 这条就是它的旧地址，直接丢掉。
         两台同名机器一台在线一台离线时会被并成一条，但它们本来就分不清；
         离线那台等它上线再点自动发现就会重新出现。 */
      if (!same.length) {
        const anySame = scan.some(it => it && it.uid
          && String(it.name || '').trim() === nm);
        if (anySame) { s._drop = true; changed = true; }
      }
      // same.length > 1：同名的不止一台，不敢猜，留着让人自己删
    });
    for (let i = a.length - 1; i >= 0; i--) if (a[i]._drop) a.splice(i, 1);

    // 2) 同一台机器只留一条（留最近对过账的，名字/备注取并集）
    const groups = new Map();
    a.forEach(s => {
      const k = s.uid ? ('u:' + s.uid) : ('a:' + base(s.addr));
      const g = groups.get(k);
      if (!g) { groups.set(k, s); return; }
      const win = (s.at || 0) > (g.at || 0) ? s : g;
      const lose = win === s ? g : s;
      const merged = {
        addr: win.addr,
        name: win.name || lose.name || '',
        uid: win.uid || lose.uid || '',
        at: Math.max(win.at || 0, lose.at || 0),
        note: win.note || lose.note || ''
      };
      groups.set(k, merged);
      changed = true;
    });
    const keep = Array.from(groups.values());
    if (changed) save(keep);

    const out = scan.slice();
    keep.forEach(s => {
      const b = base(s.addr);
      if (out.some(x => base(x.ip + ':' + x.port) === b)) return;
      if (s.uid && out.some(x => x.uid === s.uid)) return;   // 同一台，扫描那条已在列表里
      const m = /^https?:\/\/([^/:]+)(?::(\d+))?/.exec(b);
      out.push({
        uid: s.uid || b, name: s.name || '', ip: m ? m[1] : b,
        port: (m && m[2]) ? +m[2] : 8123, sharing: false, saved: true,
        at: s.at || 0, note: s.note || ''
      });
    });
    return out;
  }

  /** 相对地址补成绝对（同源请求用）。R165：
      页面本身就在对方那台机器上时（手机整页切到电脑、或浏览器直接打开对方地址），
      对账请求是 `/api/store/meta` 这种相对路径 —— 没有 host，拼不出 key，
      于是「密码存了、但发请求时取不到」，表现为「对账不要密码 / 填了也没用」。

      ⚠ R166：别把 `192.168.1.5:8123` 当成「协议名 + 相对路径」。之前只判断
      「有没有冒号」，把 `192.168.1.5:8123` 拼成 `http://当前页/192.168.1.5:8123`，
      归一后又等于当前页 → 前端报「这就是本机自己的地址」，手机根本连不上电脑。
      判据改成看**第一段**：带端口 / 是 IPv4 / 是 localhost / 是 [IPv6] 才当主机。 */
  function absUrl(u) {
    const s = String(u || '').trim();
    if (!s) return '';
    if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(s)) return s;    // http:// https:// 等（必须有 //）
    if (/^\/\//.test(s)) return 'http:' + s;              // //host:port
    const origin = (typeof location !== 'undefined' && location.origin) ? location.origin : '';
    if (s.charAt(0) === '/') return origin + s;           // 站内绝对路径
    if (s.charAt(0) === '?' || s.charAt(0) === '#') return origin + '/' + s;
    const first = s.split('/')[0];
    if (/:\d+$/.test(first)                              // host:port（含 192.168.1.5:8123、mypc:8123）
      || /^(\d{1,3}\.){3}\d{1,3}$/.test(first)           // 纯 IPv4
      || first === 'localhost'
      || /^\[[0-9a-fA-F:]+\]/.test(first)) {             // [IPv6]
      return 'http://' + s;
    }
    // 其余当成站内相对路径（如 api/store/meta）
    return origin ? (origin + '/' + s) : s;
  }

  /** 归整成「协议 + 主机 + 端口」，**必须剥掉路径和查询**。
      ⚠ R163：记密码用的是主机（192.168.1.5:8123），但发请求时 hdrs() 传进来的是
      `.../api/store/xxx` 这样的完整 URL。old normHost 只剥结尾斜杠、不剥路径，
      于是 pwdFor() 用「完整地址」当 key 去查，永远查不到 → 请求不带密码头 →
      401 → 弹框 → 存进去的还是主机 key → 下一轮照样 401，用户看到的就是
      「密码填完确认，又弹一次框」。 */
  function base(addr) {
    let s;
    const abs = absUrl(addr);
    if (typeof Device !== 'undefined' && Device.norm) {
      s = Device.norm(abs);
    } else {
      s = String(abs || '').trim();
      if (s) {
        if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
        if (!/:\d+(?=$|\/)/.test(s)) s += ':8123';
        s = s.replace(/\/+$/, '');
      }
    }
    const m = String(s || '').match(/^(https?:\/\/[^\/?#]+)/i);
    return m ? m[1] : String(s || '').replace(/\/+$/, '');
  }

  /* ---------------- 对账密码（R158） ----------------
     同一 WiFi 里谁都能读写别人的 /api/store/*，这在宿舍/公司里等于没锁。
     现在可以给「本机」设一个密码（服务端存哈希，见 serve.py /api/peer/*）：
     跨机来的请求必须带对这个头，本站自己的页面不受影响（同源）。
     密码按「对方的地址」记在本机，不跟着 kv 同步（每台设定不一样）。 */
  const PWD_KEY = 'ink.peerPwd';

  function pwdMap() {
    try { const o = JSON.parse(localStorage.getItem(PWD_KEY) || '{}'); return (o && typeof o === 'object') ? o : {}; }
    catch (e) { return {}; }
  }

  function pwdFor(addr) {
    const m = pwdMap();
    return m[base(addr)] || '';
  }

  function setPwd(addr, pwd) {
    const m = pwdMap();
    const k = base(addr);
    if (pwd) m[k] = pwd; else delete m[k];
    try { localStorage.setItem(PWD_KEY, JSON.stringify(m)); } catch (e) { }
  }

  function isPeerUrl(url) { return /^https?:\/\//i.test(String(url || '')); }

  /** 对方那台设了访问密码吗？
      R170：用户连着两次问「连接和对账怎么不要密码」—— 前端以前是**哑的**：
      它不知道对方有没有设密码，只能等 401 才被动弹框；对方一旦有你之前输过的
      cookie，或者压根没设，界面上就完全看不出"门"在哪。
      现在连接/对账之前先问一句。走 /api/peer/state（免密 + 已放开 CORS），
      只回 {set, count}，拿不到备注/哈希。读不到（没开、超时）返回 null，
      由调用方决定照常往下走 —— 不能因为探测失败就把人挡在门外。 */
  async function needsPwd(addr) {
    const url = base(addr) + '/api/peer/state';
    const ctrl = ('AbortController' in window) ? new AbortController() : null;
    const to = ctrl ? setTimeout(() => ctrl.abort(), 2500) : null;
    try {
      const r = await fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      if (!j || !j.ok) return null;
      return { set: !!j.set, count: +j.count || 0 };
    } catch (e) {
      return null;
    } finally { if (to) clearTimeout(to); }
  }

  /** 要不要给这个请求带对账密码头。R165：除了绝对地址，**同源的 /api/store 也要带**——
      页面本身在对方机器上时（整页切过去 / 浏览器直接打开对方 IP），
      对账请求是相对路径，以前一律不加头，于是远程「能看就能改」。
      R166：不要只认 `http://` 开头，`192.168.1.5:8123/api/...` 这种也得算。
      带之前一定按 host 查密码（`pwdFor`），查不到就不带，所以不会串到第三方。 */
  function wantKey(url) {
    return /^https?:\/\//i.test(absUrl(url));
  }

  /* ---------------- HTTP 小工具 ---------------- */

  /* 「两边都有这本书」时只比这几项：内容一致就什么都别写。
     不这么比的话，推一本新书会把对方的 ts 刷成「现在」，
     下一轮就变成「对方更新 → 把 meta 推回去 → ts 又变新」，来回刷永不收敛。 */
  const META_FIELDS = ['title', 'format', 'locator', 'progress', 'progressText',
    'lastReadAt', 'addedAt', 'totalPages', 'fav', 'tags', 'length', 'chapter'];

  function metaKey(m) {
    if (!m) return '';
    return META_FIELDS.map(k => JSON.stringify(m[k] === undefined ? null : m[k])).join('|');
  }

  /** 发请求前统一处理：给对方的请求带上密码头；401 翻译成「需要密码」，
   *  别让界面报一句「HTTP 401」让用户去猜。 */
  function hdrs(url, extra) {
    const h = Object.assign({}, extra || {});
    if (wantKey(url)) {
      const p = pwdFor(url);
      if (p) h['X-Ink-Peer-Key'] = p;
    }
    return h;
  }

  function chk(r, url) {
    if (r.status === 401) {
      const e = new Error('需要对账密码');
      e.needPwd = true;
      e.addr = base(url);
      throw e;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r;
  }

  async function jget(url, ms) {
    const ctrl = ('AbortController' in window) ? new AbortController() : null;
    const to = ctrl && ms ? setTimeout(() => ctrl.abort(), ms) : null;
    try {
      const r = await fetch(url, { cache: 'no-store', headers: hdrs(url),
        signal: ctrl ? ctrl.signal : undefined });
      chk(r, url);
      return await r.json();
    } finally { if (to) clearTimeout(to); }
  }

  /** 原样搬运（书 JSON 不解析，几十 MB 的 PDF 也不至于在 JS 里再过一遍） */
  async function rawGet(url) {
    const r = await fetch(url, { cache: 'no-store', headers: hdrs(url) });
    chk(r, url);
    return await r.text();
  }

  async function jpost(url, body) {
    const r = await fetch(url, {
      method: 'POST', headers: hdrs(url, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body || {})
    });
    chk(r, url);
    return await r.json().catch(() => ({ ok: true }));
  }

  async function rawPost(url, text) {
    const r = await fetch(url, {
      method: 'POST', headers: hdrs(url, { 'Content-Type': 'application/json' }), body: text
    });
    chk(r, url);
    return await r.json().catch(() => ({ ok: true }));
  }

  /* ---------------- 对账 ---------------- */

  /**
   * 和一台设备对账。
   * @param {string} addr 形如 192.168.1.5:8123
   * @param {(msg:string)=>void} [onStep]
   * @returns {Promise<{pull:number,push:number,meta:number,ann:number,kv:number,del:number,fail:number,err:string}>}
   */
  async function syncOne(addr, onStep) {
    const P = base(addr);
    const step = m => { if (onStep) { try { onStep(m); } catch (e) { } } };
    const out = { pull: 0, push: 0, meta: 0, ann: 0, kv: 0, del: 0, fail: 0, err: '' };

    step('读取两边索引…');
    const A = await jget(API + '/index', 15000);
    const B = await jget(P + API + '/index', 15000);
    if (!A || !B) throw new Error('索引读不到');

    /* 1) 删除：谁有更新的墓碑，另一边跟着删 */
    const tombA = A.tomb || {}, tombP = B.tomb || {};
    const tombIds = new Set([].concat(Object.keys(tombA), Object.keys(tombP)));
    const gone = new Set();
    let k = 0;
    for (const id of tombIds) {
      const ta = tombA[id] || 0, tp = tombP[id] || 0;
      const hasA = !!(A.books || {})[id], hasP = !!(B.books || {})[id];
      k++;
      if (k % 8 === 0) step('处理删除 ' + k + '/' + tombIds.size);
      try {
        if (ta > tp && hasP) {
          await jpost(P + API + '/delete', { kind: 'books', key: id, ts: ta });
          out.del++;
        } else if (tp > ta && hasA) {
          await jpost(API + '/delete', { kind: 'books', key: id, ts: tp });
          out.del++;
        }
      } catch (e) { out.fail++; }
      if (ta || tp) gone.add(id);
    }

    /* 2) 书：缺的补，两边都有只同步 meta */
    const ab = A.books || {}, pb = B.books || {};
    const ids = [].filter.call([...new Set([].concat(Object.keys(ab), Object.keys(pb)))], id => !gone.has(id));
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const q = '?id=' + encodeURIComponent(id);
      step('书 ' + (i + 1) + '/' + ids.length);
      const a = ab[id], p = pb[id];
      try {
        if (!a && p) {
          const txt = await rawGet(P + API + '/book' + q);
          await rawPost(API + '/book' + q, txt);
          if (p.meta) await jpost(API + '/meta', { id, meta: p.meta });
          out.pull++;
        } else if (a && !p) {
          const txt = await rawGet(API + '/book' + q);
          await rawPost(P + API + '/book' + q, txt);
          if (a.meta) await jpost(P + API + '/meta', { id, meta: a.meta });
          out.push++;
        } else if (a && p && (p.ts || 0) > (a.ts || 0)) {
          if (p.meta && metaKey(p.meta) !== metaKey(a.meta)) {
            await jpost(API + '/meta', { id, meta: p.meta }); out.meta++;
          }
        } else if (a && p && (a.ts || 0) > (p.ts || 0)) {
          if (a.meta && metaKey(a.meta) !== metaKey(p.meta)) {
            await jpost(P + API + '/meta', { id, meta: a.meta }); out.meta++;
          }
        }
      } catch (e) {
        out.fail++;
        out.err = out.err || (id + '：' + e.message);
      }
    }

    /* 3) 笔记（整份覆盖，按 ts 取新） */
    const aa = A.annots || {}, pa = B.annots || {};
    const aid = [...new Set([].concat(Object.keys(aa), Object.keys(pa)))].filter(id => !gone.has(id));
    for (let i = 0; i < aid.length; i++) {
      const id = aid[i];
      const ta = aa[id] || 0, tp = pa[id] || 0;
      if (ta === tp) continue;
      step('笔记 ' + (i + 1) + '/' + aid.length);
      try {
        if (tp > ta) {
          const d = await jget(P + API + '/annots?id=' + encodeURIComponent(id), 20000);
          if (d && d.ok) { await jpost(API + '/annots', { bookId: id, list: d.list || [], ts: tp }); out.ann++; }
        } else {
          const d = await jget(API + '/annots?id=' + encodeURIComponent(id), 20000);
          if (d && d.ok) { await jpost(P + API + '/annots', { bookId: id, list: d.list || [], ts: ta }); out.ann++; }
        }
      } catch (e) { out.fail++; }
    }

    /* 4) 设置 / 收藏夹 */
    const ak = A.kv || {}, pk = B.kv || {};
    for (const key of KV_KEYS) {
      const ta = ak[key] || 0, tp = pk[key] || 0;
      if (ta === tp) continue;
      step('设置 / 收藏夹 ' + key);
      try {
        if (tp > ta) {
          const d = await jget(P + API + '/kv?k=' + key, 15000);
          if (d && d.ok && d.v !== undefined) { await jpost(API + '/kv', { k: key, v: d.v, ts: tp }); out.kv++; }
        } else {
          const d = await jget(API + '/kv?k=' + key, 15000);
          if (d && d.ok && d.v !== undefined) { await jpost(P + API + '/kv', { k: key, v: d.v, ts: ta }); out.kv++; }
        }
      } catch (e) { out.fail++; }
    }

    const bits = [];
    if (out.pull) bits.push('收到 ' + out.pull + ' 本');
    if (out.push) bits.push('送出 ' + out.push + ' 本');
    if (out.meta) bits.push(diffMeta(out.meta));
    if (out.ann) bits.push('笔记 ' + out.ann + ' 份');
    if (out.kv) bits.push('设置/收藏夹 ' + out.kv);
    if (out.del) bits.push('删除 ' + out.del);
    if (out.fail) bits.push('失败 ' + out.fail);
    touch(addr, bits.length ? bits.join(' · ') : '已是最新');
    return out;
  }

  function diffMeta(n) { return '进度/书名 ' + n + ' 本'; }

  /** 记下来之后：把本机服务器上的新东西拉进浏览器（否则页面还是旧书单） */
  async function refreshLocal() {
    if (typeof Sync !== 'undefined' && Sync.init) {
      try { await Sync.init(true); } catch (e) { }
    }
    if (typeof Library !== 'undefined' && Library.refresh) {
      try { await Library.refresh(); } catch (e) { }
    }
    if (typeof Library !== 'undefined' && Library.render) {
      try { Library.render(); } catch (e) { }
    }
  }

  return { list, remember, forget, touch, reconcile, base, syncOne, refreshLocal,
           pwdFor, setPwd, hdrs, wantKey, needsPwd };
})();
