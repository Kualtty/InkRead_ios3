/* ============================================================
   share.js —— 局域网加密共享
   ------------------------------------------------------------
   书籍数据存在浏览器 IndexedDB 里，各设备之间无法直接互通，
   所以由本地服务器（tools/serve.py）做一个「加密信封中转站」：

       主机浏览器 --(密文)--> 服务器(只存密文) --(密文)--> 客户端浏览器

   服务器永远看不到明文，密码只在两端浏览器里用于派生密钥。
   没有密码的人即使拿到密文也解不开（HMAC 校验会直接失败）。

   加密与 Python 端 share_encrypt / share_decrypt 必须逐字节一致：
     key  = PBKDF2-HMAC-SHA256(password, salt, 100000, 32B)
     密文 = nonce(12B) || HMAC-SHA256(key, nonce||ct)(32B) || ct
     ct   = 明文 XOR SHA256(key||nonce||counter) 密钥流
   ============================================================ */

const PBKDF2_ROUNDS = 100000;
const ShareCrypto = {
  async deriveKey(password, saltBytes) {
    const km = await crypto.subtle.importKey('raw',
      new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ROUNDS, hash: 'SHA-256' },
      km, 256);
    return new Uint8Array(bits);
  },

  async keystream(key, nonce, n) {
    const out = new Uint8Array(n);
    let off = 0, i = 0;
    while (off < n) {
      const buf = new Uint8Array(key.length + nonce.length + 4);
      buf.set(key, 0);
      buf.set(nonce, key.length);
      buf[key.length + nonce.length] = (i >>> 24) & 255;
      buf[key.length + nonce.length + 1] = (i >>> 16) & 255;
      buf[key.length + nonce.length + 2] = (i >>> 8) & 255;
      buf[key.length + nonce.length + 3] = i & 255;
      const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
      const take = Math.min(h.length, n - off);
      out.set(h.subarray(0, take), off);
      off += take; i++;
    }
    return out;
  },

  async hmacKey(key) {
    return crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' },
      false, ['sign', 'verify']);
  },

  async encrypt(password, saltBytes, plainBytes) {
    const key = await this.deriveKey(password, saltBytes);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ks = await this.keystream(key, nonce, plainBytes.length);
    const ct = new Uint8Array(plainBytes.length);
    for (let i = 0; i < plainBytes.length; i++) ct[i] = plainBytes[i] ^ ks[i];
    const hk = await this.hmacKey(key);
    const both = new Uint8Array(nonce.length + ct.length);
    both.set(nonce, 0); both.set(ct, nonce.length);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hk, both));
    return this.b64(this.concat(nonce, mac, ct));
  },

  async decrypt(password, saltBytes, blobB64) {
    const raw = this.unb64(blobB64);
    if (raw.length < 44) throw new Error('密文长度不足');
    const key = await this.deriveKey(password, saltBytes);
    const nonce = raw.subarray(0, 12);
    const mac = raw.subarray(12, 44);
    const ct = raw.subarray(44);
    const hk = await this.hmacKey(key);
    const both = new Uint8Array(nonce.length + ct.length);
    both.set(nonce, 0); both.set(ct, nonce.length);
    const okMac = await crypto.subtle.verify('HMAC', hk, mac, both);
    if (!okMac) throw new Error('密码错误，或数据被篡改');
    const ks = await this.keystream(key, nonce, ct.length);
    const pt = new Uint8Array(ct.length);
    for (let i = 0; i < ct.length; i++) pt[i] = ct[i] ^ ks[i];
    return pt;
  },

  /* ---- 工具 ---- */
  concat(...arrs) {
    const n = arrs.reduce((a, b) => a + b.length, 0);
    const o = new Uint8Array(n);
    let p = 0;
    for (const a of arrs) { o.set(a, p); p += a.length; }
    return o;
  },
  b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(s);
  },
  unb64(b) {
    const s = atob(b);
    const o = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i);
    return o;
  },
  newSalt() { return crypto.getRandomValues(new Uint8Array(16)); },
  saltB64(s) { return this.b64(s); },
  fromB64(b) { return this.unb64(b); }
};

/* ============================================================
   共享客户端/主机逻辑
   ============================================================ */
const Share = {
  salt: null,          // Uint8Array（主机）或 base64 字符串（客户端）
  id: null,            // 主机：共享 ID
  pwd: '',             // 主机/客户端密码
  polling: null,
  allowedIds: null,    // 主机：只允许共享这些书（null = 全部）
  /** R66：共享内容选项（主机决定发什么，接收端按包里的标记决定收不收）。
   *  notes = 笔记 / 高光 / 书签；ink = 手迹涂鸦（文字书按字符偏移锚定，跨设备准；
   *  PDF/漫画按页坐标，版式不同会偏，所以默认不带）；toc = 书的目录（章节层级）。 */
  opts: { notes: true, ink: false, toc: true },

  /** R69：统一收口「共享内容」选项。
   *  之前只在 hostStart 时从面板读一次，开着共享再去勾/取消勾，只改了 Settings 和书单上的
   *  小标签，真正打包用的 Share.opts 还是旧值 —— 用户看到的就是「勾选换了，实际没变」。
   *  现在面板一改就调这里，正在跑的这次共享立刻按新选项打包。 */
  setOpts(o) {
    if (!o || typeof o !== 'object') return this.opts;
    this.opts = {
      notes: o.notes !== false,
      ink: !!o.ink,
      toc: o.toc !== false
    };
    return this.opts;
  },

  /** 这个浏览器的固定标识：同一浏览器重开共享时，服务端据此清掉上次残留的旧共享 */
  ownerId() {
    try {
      let v = localStorage.getItem('ink-share-owner');
      if (!v) {
        v = 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        localStorage.setItem('ink-share-owner', v);
      }
      return v;
    } catch (e) { return ''; }
  },

  api(path, opts) {
    return fetch(path, Object.assign({ cache: 'no-store' }, opts)).then(r => r.json());
  },
  /** 规整主机地址：允许「127.0.0.1」「192.168.1.5:8123」「http://x:8123」等形式，
   *  缺端口自动补 8123，缺协议补 http://，方便同机两标签自测（直接填 127.0.0.1 即可）。 */
  normHost(host) {
    if (!host) return host;
    host = String(host).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(host)) host = 'http://' + host;
    if (!/:\d+(?=$|\/)/.test(host)) host += ':8123';
    return host;
  },
  post(path, body) {
    return this.api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  },

  /* ---------------- 主机：开启共享 ---------------- */
  /**
   * @param {string} name      共享名称
   * @param {string} password  共享密码
   * @param {string[]} [bookIds] 只共享这些书；不传 = 共享全部
   */
  async hostStart(name, password, bookIds, opts) {
    if (!password) throw new Error('请设置共享密码');
    this.setOpts(opts);
    this.name = String(name || '').trim().slice(0, 40) || '墨阅书库';
    this.salt = ShareCrypto.newSalt();
    this.pwd = password;
    this.allowedIds = (Array.isArray(bookIds) && bookIds.length)
      ? new Set(bookIds) : null;
    const r = await this.post('/api/share/register', {
      name: name || '墨阅书库',
      salt: ShareCrypto.saltB64(this.salt),
      owner: this.ownerId()
    });
    if (!r.ok) throw new Error(r.err || '注册失败');
    this.id = r.id;
    await this.hostPublish(bookIds);
    this.hostPoll();
    return r.id;
  },

  /**
   * 发布书单。只发布 allowedIds 里的书（未设置则全部）。
   * @param {string[]} [bookIds] 重新指定共享范围
   * @param {object} [opts] 重新指定共享内容（笔记/手迹/目录），不传就沿用当前 this.opts
   * @returns {number} 实际发布的数量
   */
  async hostPublish(bookIds, opts, name) {
    if (opts) this.setOpts(opts);
    /* R134：改共享名称也走这条 —— 服务端 publish 会一并更新，对方刷新列表就能看到新名字，
       不用「停止共享 → 重新开启」（那样会换 ID，等于要让对方重新输一遍） */
    if (name != null) this.name = String(name || '').trim().slice(0, 40) || '墨阅书库';
    if (Array.isArray(bookIds) && bookIds.length) {
      this.allowedIds = new Set(bookIds);
    }
    let books = await DB.getAll('books');
    if (this.allowedIds) books = books.filter(b => this.allowedIds.has(b.id));
    const opt = this.opts || { notes: true, ink: false, toc: true };
    // R132（第 5 条）：两本书重名时，对方在列表里根本分不出哪本是哪本。
    // 书单里补上「能区分身份」的字段：章节数 / 标注条数 / 导入时间 / 最后阅读时间，
    // 再把 id 尾号一起给出去（id 不是秘密，密码才是），列表里拼成一行小字。
    let annCount = {};
    try {
      const allAnn = await DB.getAll('annots');
      allAnn.forEach((a) => { if (a && a.bookId) annCount[a.bookId] = (annCount[a.bookId] || 0) + 1; });
    } catch (e) { annCount = {}; }
    const meta = books.map(b => ({
      id: b.id, title: b.title, format: b.format,
      length: b.length, progress: b.progress || 0,
      chCount: Array.isArray(b.chapters) ? b.chapters.length : 0,
      annCount: annCount[b.id] || 0,
      addedAt: b.addedAt || 0,
      lastReadAt: b.lastReadAt || 0,
      // 让接收方一眼看出这本书会带什么（列表里显示小标签）
      notes: !!opt.notes, ink: !!opt.ink, toc: !!opt.toc,
      size: b.format === 'pdf'
        ? ((b.content && b.content.data) ? b.content.data.byteLength || 0 : 0)
        : (b.format === 'comic'
          ? (b.content.items || []).reduce((a, i) => a + (i.blob ? i.blob.size : 0), 0)
          : ((b.content && (b.content.text || b.content.html)) ? (b.content.text || b.content.html).length : 0))
    }));
    const plain = new TextEncoder().encode(JSON.stringify(meta));
    const payload = await ShareCrypto.encrypt(this.pwd, this.salt, plain);
    const r = await this.post('/api/share/publish',
      { id: this.id, payload, count: meta.length, name: this.name || '' });
    if (!r.ok) throw new Error(r.err || '发布失败');
    return meta.length;
  },

  /* 主机轮询：客户端要哪本书，就加密上传哪本 */
  hostPoll() {
    if (this.polling) clearInterval(this.polling);
    this.polling = setInterval(async () => {
      if (!this.id) return;
      try {
        const r = await this.api('/api/share/pending?id=' + this.id);
        if (!r.ok || !r.items) return;
        for (const it of r.items) {
          // 没在共享清单里的书，主机一律不响应（防止通过改请求拿到别的书）
          if (this.allowedIds && !this.allowedIds.has(it.bookId)) continue;
          const b = await DB.get('books', it.bookId);
          if (!b) continue;
          const payload = await this._packBook(b);
          await this.post('/api/share/fulfill',
            { id: this.id, rid: it.rid, payload });
        }
      } catch (e) { /* 主机离线等下次 */ }
    }, 2000);
  },

  async _packBook(b) {
    const opt = this.opts || { notes: true, ink: false, toc: true };
    const obj = {
      id: b.id, title: b.title, format: b.format,
      length: b.length, progress: b.progress || 0,
      // 目录（章节层级）默认一起带走：接收端靠它复原目录树，不带走就只剩一整本没章节
      chapters: opt.toc ? (b.chapters || []) : [],
      fav: !!b.fav,
      locator: b.locator, addedAt: b.addedAt, lastReadAt: b.lastReadAt
    };
    if (b.format === 'pdf') {
      const ab = b.content && b.content.data;
      obj.data = ab ? ShareCrypto.b64(new Uint8Array(ab)) : '';
    } else if (b.format === 'comic') {
      obj.items = [];
      for (const it of (b.content.items || [])) {
        const u8 = new Uint8Array(await it.blob.arrayBuffer());
        obj.items.push({ name: it.name, data: ShareCrypto.b64(u8) });
      }
    } else {
      // R69：md / epub / docx 导入的书 format 是 'html'，但正文在 content.html 里，
      // 以前这里只取 content.text → 共享出去的是一本空白书。现在两种都认，
      // 并带上 md（对方拿到后还能「编辑原文」）。
      const c = b.content || {};
      const body = c.text || (c.kind === 'html' ? c.html : '') || '';
      obj.text = body;
      if (c.kind === 'html') {
        obj.kind = 'html';
        if (typeof c.md === 'string' && c.md) obj.md = c.md;
      }
    }
    // 书签与笔记：按主机选的「共享内容」过滤。手迹（type='ink'）单独开关。
    // 老版本没有 opts 时退化成「带笔记、不带手迹」，与旧行为一致。
    let ann = await Annot.list(b.id) || [];
    if (!opt.notes) ann = ann.filter(a => a && a.type === 'ink');
    if (!opt.ink) ann = ann.filter(a => !a || a.type !== 'ink');
    obj.annots = ann;
    obj.withNotes = !!opt.notes;
    obj.withInk = !!opt.ink;
    obj.withToc = !!opt.toc;
    const plain = new TextEncoder().encode(JSON.stringify(obj));
    return ShareCrypto.encrypt(this.pwd, this.salt, plain);
  },

  async hostStop() {
    if (this.polling) { clearInterval(this.polling); this.polling = null; }
    if (this.id) { try { await this.post('/api/share/unregister', { id: this.id }); } catch (e) { } }
    this.id = null; this.pwd = ''; this.salt = null;
    this.allowedIds = null;
  },

  /* ---------------- 客户端：自动发现 ----------------
     R69：一台机器往往有好几个地址（127.0.0.1 / WLAN / 虚拟网卡 / 169.254…），
     每个地址都会应答同一个服务器。以前按 IP 收，于是同一个书库被列成 4 条，
     用户看不出「这四个其实是一个」。现在按服务端给的稳定 uid 归并成「一台设备」，
     再把该设备上开着的共享逐个展开（一个共享 = 一个库）。 */
  async discover() {
    const hits = [];
    const seen = new Set();
    const PROBE_MS = 700;        // 网段扫描：被防火墙静默丢包(SYN 无回)的地址快速失败，
                                 // 否则 254 个里只要有一个卡住，Promise.all 就一直挂着 → 「共享不了」
    const PROBE_MS_LOCAL = 2500; // 本机 / 已知地址：给足时间（见下面顺序说明）
    const probe = (ip, port, ms) => {
      const key = ip + ':' + port;
      if (seen.has(key)) return Promise.resolve();
      seen.add(key);
      const ctrl = ('AbortController' in window) ? new AbortController() : null;
      const to = ctrl ? setTimeout(() => ctrl.abort(), ms || PROBE_MS) : null;
      return fetch(`http://${ip}:${port}/api/share/discover-info`, { cache: 'no-store',
        signal: ctrl ? ctrl.signal : undefined })
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          if (!j || !j.on) return;
          hits.push({
            ip, port,
            uid: j.uid || ('ip:' + ip),      // 老版本服务端没有 uid，退化成按 IP
            name: j.name || '墨阅书库',
            shares: Array.isArray(j.shares) ? j.shares : []
          });
        })
        .catch(() => { })
        .finally(() => { if (to) clearTimeout(to); });
    };

    // 本机局域网前缀（WebRTC 取不到就让后端告诉我们）
    let prefix = await this.myLanPrefix();
    let myAddrs = [];
    let myPort = Number(location.port) || 8123;
    try {
      const r = await fetch('/api/share/myaddr', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        myAddrs = j.ips || [];
        if (j.port) myPort = j.port;
      }
    } catch (e) { /* 离线就放弃 */ }
    /* R158：安卓壳里 serve.py 经常只报 127.0.0.1（Chaquopy 拿不到网卡列表），
       于是 prefix 为空 → 254 个地址一个都不扫 → 「不填 IP 就永远发现不了」。
       原生 lanIps() 能拿到真实 WLAN 地址，这里并进来。 */
    if (window.InkAndroid && window.InkAndroid.lanIps) {
      try {
        String(window.InkAndroid.lanIps() || '').split(',')
          .map(s => s.trim()).filter(Boolean)
          .forEach(ip => { if (myAddrs.indexOf(ip) < 0) myAddrs.push(ip); });
      } catch (e) { }
    }
    const lanAddrs = myAddrs.filter(ip => !/^127\./.test(ip) && !/^169\.254\./.test(ip));
    if (!prefix && lanAddrs[0]) prefix = lanAddrs[0].replace(/(\d+\.\d+\.\d+)\.\d+/, '$1.');
    const prefixes = [];
    [prefix, ...lanAddrs.map(ip => ip.replace(/(\d+\.\d+\.\d+)\.\d+/, '$1.'))]
      .forEach(p => { if (p && prefixes.indexOf(p) < 0) prefixes.push(p); });

    /* R80：顺序很关键 —— 先探本机，再扫网段。
       以前把「127.0.0.1 + 本机各网卡」排在 254 个网段探测之后，等轮到它们时
       本机 socket 已被几百个连不通的地址拖慢，那条 700ms 超时会把自探掐断
       （实测 AbortError @701ms）→ 共享明明开着，自动发现却返回 0 条。
       现在本机这一批给 2500ms 并排在最前；扫网段失败也只是少了别的设备。 */
    // 1) 本机自检：一个 serve.py 当主机、另一个标签当客户，地址就是 127.0.0.1；
    //    再加上后端实际监听的所有地址（0.0.0.0 绑出来的真实网卡 IP）。
    const localJobs = [{ ip: '127.0.0.1', port: myPort }];
    myAddrs.forEach(ip => localJobs.push({ ip, port: myPort }));
    // 同一台机器上另开的实例（开发 8133 / 回归 8130 / 安装版 8123）也算一台，
    // 所以顺手探一下本机 8123 —— 否则「手机上就是连不到电脑」时常被误判成网络问题
    localJobs.push({ ip: location.hostname || '127.0.0.1', port: 8123 });
    await Promise.all(localJobs.map(x => probe(x.ip, x.port, PROBE_MS_LOCAL)));

    // 2) 再扫同网段（别人的机器都用默认端口 8123）
    if (prefixes.length) {
      for (const p of prefixes.slice(0, 4)) {
        const jobs = [];
        for (let i = 1; i <= 254; i++) jobs.push({ ip: p + i, port: 8123 });
        // 分块探测，避免一次性发起过多连接把浏览器/系统 socket 打爆
        for (let k = 0; k < jobs.length; k += 32) {
          await Promise.all(jobs.slice(k, k + 32).map(x => probe(x.ip, x.port)));
        }
      }
    }

    /* 按 uid 归并 */
    const devs = new Map();
    for (const h of hits) {
      let g = devs.get(h.uid);
      if (!g) { g = { uid: h.uid, name: h.name, port: h.port, ips: [], shares: [] }; devs.set(h.uid, g); }
      if (g.ips.indexOf(h.ip) < 0) g.ips.push(h.ip);
      for (const s of h.shares) {
        if (s && s.id && !g.shares.some(x => x.id === s.id)) g.shares.push(s);
      }
    }
    // 对外优先给局域网地址（对方能连），127.0.1 只作兜底
    const niceIp = ips => {
      const good = ips.filter(ip => !/^127\./.test(ip) && !/^169\.254\./.test(ip));
      return good[0] || ips[0] || '127.0.0.1';
    };
    const found = [];
    for (const g of devs.values()) {
      const base = { uid: g.uid, ip: niceIp(g.ips), port: g.port, ips: g.ips.slice() };
      if (g.shares.length) {
        for (const s of g.shares) {
          found.push(Object.assign({}, base, {
            name: s.name || g.name, id: s.id,
            count: s.count || 0, age: s.age || 0
          }));
        }
      } else {
        // 老服务端（没有 shares 字段）：只知道这台机器开着共享，还得手动问 ID
        found.push(Object.assign({}, base, { name: g.name, id: '', count: 0, age: 0 }));
      }
    }
    return found;
  },

  async myLanPrefix() {
    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel('');
      await pc.setLocalDescription();
      const cand = await new Promise(res => {
        pc.onicecandidate = e => res(e.candidate || null);
        setTimeout(() => res(null), 1200);
      });
      pc.close();
      const m = cand && /(\d+\.\d+\.\d+)\.\d+/.exec(cand.candidate || '');
      return m ? m[1] + '.' : null;
    } catch (e) { return null; }
  },

  async clientList(host, id, password) {
    host = this.normHost(host);
    const r = await this.api(`${host}/api/share/list?id=${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error(r.err || '取不到书单');
    const salt = ShareCrypto.fromB64(r.salt);
    const pt = await ShareCrypto.decrypt(password, salt, r.payload);
    return { name: r.name, books: JSON.parse(new TextDecoder().decode(pt)) };
  },

  /** 客户端下载一本书：登记请求 → 等主机上传 → 解密 → 存进本地 */
  async clientDownload(host, id, password, bookId, onWait) {
    host = this.normHost(host);
    const r = await this.post(`${host}/api/share/request`, { id, bookId });
    if (!r.ok) throw new Error(r.err || '请求失败');
    const info = await this.api(`${host}/api/share/info?id=${encodeURIComponent(id)}`);
    const salt = ShareCrypto.fromB64(info.salt);
    for (let i = 0; i < 60; i++) {
      // 注意：host 已被 normHost 补全为 http://x:8123，这里不要再拼 http://，否则变 http://http://… 导致 fail to fetch
      const d = await this.api(`${host}/api/share/book?id=${encodeURIComponent(id)}&rid=${r.rid}`);
      if (d.ok && d.payload) {
        const pt = await ShareCrypto.decrypt(password, salt, d.payload);
        return JSON.parse(new TextDecoder().decode(pt));
      }
      if (onWait) onWait(i);
      await new Promise(s => setTimeout(s, 1000));
    }
    throw new Error('主机没有响应，请确认主机页面还开着');
  },

  /* ---------------- 收书：判重 ----------------
     R69：以前每收一次就新建一本书，同一本点两次「下载」就变两本《X（共享）》。
     这里给一个「这本书是不是已经在书库里」的判定：
       格式相同 + 标题相同（忽略末尾的「（共享）」）+ 正文长度基本相同（≤8 字节误差，
       PDF/漫画按 base64 反推字节数）。
     命中就不新建，只把缺的标注并进去 —— 重复下载变成「补齐」，不会翻倍。 */
  _normTitle(t) {
    return String(t || '')
      .replace(/[（(]共享[)）]\s*$/, '')
      /* R133：自动加的序号（「前提（1）」）不算书名的一部分 ——
         否则本地被去过重的书永远认不出对端发来的《前提》，
         每次补齐都变成「又下载一本新的」，然后再被改名成《前提（2）》。 */
      .replace(/[（(]\s*[0-9]{1,3}\s*[)）]\s*$/, '')
      .replace(/\s+/g, '');
  },
  _localLen(b) {
    const c = (b && b.content) || {};
    if (b.format === 'pdf') return (c.data && (c.data.byteLength || c.data.length)) || 0;
    if (b.format === 'comic') {
      return (c.items || []).reduce((n, it) => n + ((it.blob && it.blob.size) || 0), 0);
    }
    return String(c.text || c.html || '').length;
  },
  _payloadLen(o) {
    // base64 4 字符 = 3 字节；这里只用来比大小，误差几字节没事
    if (o.format === 'pdf') return Math.floor(String(o.data || '').length * 3 / 4);
    if (o.format === 'comic') {
      return (o.items || []).reduce((n, it) => n + Math.floor(String(it.data || '').length * 3 / 4), 0);
    }
    return String(o.text || '').length;
  },
  /** R131（第 7/8 条）：目录也要「补齐」，不是「本地有目录就整份丢掉」。
   *  用户实测：主机整理好目录再共享，接收端补齐后目录纹丝不动 —— 以前的规则是
   *  「本地已经有目录 → 保留本地的」（见 importReceived 旧注释），可实际上接收端
   *  的目录往往只是自动识别出来的几章，缺的正是主机补的那几章。
   *  现在的规则（只加不删）：
   *    · 本地没目录   → 整份拿过来；
   *    · 本地有目录   → 把共享包里**本地没有的**章节按偏移插到对应位置；
   *                    同名 / 同偏移的一律不动，绝不重排、绝不清空用户整理过的目录。
   *  @returns {{list:Array, added:number, kept:number}}
   */
  _mergeChapters(local, incoming) {
    const cur = Array.isArray(local) ? local.slice() : [];
    const inc = Array.isArray(incoming) ? incoming : [];
    if (!inc.length) return { list: cur, added: 0, kept: cur.length };
    if (!cur.length) return { list: inc.slice(), added: inc.length, kept: 0 };
    const keyOf = c => String((c && c.title) || '').replace(/\s+/g, '');
    const have = new Set(cur.map(keyOf));
    const add = [];
    for (const c of inc) {
      const k = keyOf(c);
      if (!k || have.has(k)) continue;                       // 同名章节：你本地这条说了算
      have.add(k);
      // 改过名但偏移相同的也算同一章：别再插一条重复的
      if (cur.concat(add).some(x => String(x.offset) === String(c.offset))) continue;
      add.push(c);
    }
    if (!add.length) return { list: cur, added: 0, kept: cur.length };
    const out = cur.slice();
    for (const c of add) {
      const n = Number(c.offset);
      if (!isFinite(n)) { out.push(c); continue; }            // 富文本锚点（#id）：接在末尾
      let at = -1;
      for (let i = 0; i < out.length; i++) {
        const m = Number(out[i].offset);
        if (isFinite(m) && m > n) { at = i; break; }
      }
      if (at < 0) out.push(c); else out.splice(at, 0, c);
    }
    return { list: out, added: add.length, kept: cur.length };
  },

  async findExisting(o) {
    const t = this._normTitle(o.title);
    const n = this._payloadLen(o);
    const all = await DB.getAll('books');
    let loose = null;
    const flat = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
    for (const b of all) {
      if (b.format !== o.format) continue;
      if (this._normTitle(b.title) !== t) continue;
      if (Math.abs(this._localLen(b) - n) > 8) continue;
      // R133：名字一字不差的那本优先 —— 本地可能同时躺着《前提》和《前提（1）》，
      // 对端发来的是《前提》，别补到带序号的那本上。
      if (flat(b.title) === flat(o.title)) return b;
      if (!loose) loose = b;
    }
    return loose;
  },

  /** R130（第 11 条）：把「所有可能是同一本」的候选列出来，交给界面让用户挑。
   *  以前 findExisting 只返回第一条命中的，同一个书名在库里有 A1 / A2 / B 三份时，
   *  「补齐」永远补到数据库里排最前的那本，用户没法指定。 */
  async findCandidates(o) {
    const t = this._normTitle(o.title);
    const n = this._payloadLen(o);
    const out = [];
    for (const b of await DB.getAll('books')) {
      if (b.format !== o.format) continue;
      if (this._normTitle(b.title) !== t) continue;
      if (n && Math.abs(this._localLen(b) - n) > 8) continue;
      out.push(b);
    }
    // 最近在读的排前面：用户多半想补到手上正在看的那本
    out.sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0));
    return out;
  },

  /** 用「书单里的元信息」预判（还没下载，只想知道哪些已在库里）。
   *  书单 meta 带 size：PDF=字节数、漫画=各图字节和、文本=正文字符数，
   *  口径与 _localLen() 一致，所以能直接比。 */
  async findExistingMeta(m) {
    const t = this._normTitle(m && m.title);
    const n = Number((m && m.size) || 0);
    if (!t) return null;
    for (const b of await DB.getAll('books')) {
      if (b.format !== m.format) continue;
      if (this._normTitle(b.title) !== t) continue;
      if (n && Math.abs(this._localLen(b) - n) > 8) continue;
      return b;
    }
    return null;
  },

  /** 新书的标题避重：「X（共享）」已存在 → 「X（共享 2）」「X（共享 3）」…
   *  用户场景：同一本书想要两份、各自带不同书签/笔记，两本得能分清。 */
  async _uniqTitle(t) {
    // R133：数据源换成本地内存书单。以前每次 DB.getAll('books') 会把每本书的
    // 正文 / 图片 / PDF 整份读出来，只为看一眼标题；书一多就是白白卡一下。
    const books = (typeof Library !== 'undefined' && Library.all) || [];
    const has = (name) => books.some(b => b && titleKey(b.title) === titleKey(name));
    if (!has(t)) return t;
    const m = /^(.*)（共享(?: ([0-9]+))?）$/.exec(t);
    const base = m ? m[1] : t;
    let n = (m && m[2]) ? Number(m[2]) + 1 : 2;
    while (has(base + '（共享 ' + n + '）')) n++;
    return base + '（共享 ' + n + '）';
  },

  /** 把收到的书存进本地书库
   *  @param {object} o 主机打包的书
   *  @param {{mode?:'merge'|'new', targetId?:string}} [opts]
   *    merge（默认）：库里已有同一本就只补标注，不新建；
   *    new：不管有没有都另存一本（用户要「同一本书两份、各带各的书签」时用）。
   *    targetId：补齐到**指定的那一本**（书库里有 A1/A2/B 多份同名书时由用户选，R130 第 11 条）。
   *    判重命中时界面会先问一句，由用户决定走哪条。 */
  async importReceived(o, opts) {
    const mode = (opts && opts.mode) === 'new' ? 'new' : 'merge';
    // 手迹只有主机明确开了「带上手迹」才收（withInk）。文字书按字符偏移锚定，跨设备准；
    // PDF/漫画按页坐标，版式一变就偏，所以默认不带。
    const allInk = (o.annots || []).filter(a => a && a.type === 'ink').length;
    const ann = (!o.withInk
      ? (o.annots || []).filter(a => !a || a.type !== 'ink')
      : (o.annots || []));
    const got = {
      notes: ann.filter(a => a && a.type !== 'ink').length,
      inkRecords: ann.filter(a => a && a.type === 'ink').length,
      inkStrokes: 0,
      inkSkipped: allInk - ann.filter(a => a && a.type === 'ink').length,
      // 主机这次到底有没有开「手迹」：没开时包里就没有手迹，接收端得说「手迹未共享」
      inkShared: !!o.withInk,
      chapters: (o.chapters || []).length,
      existed: false,
      savedAsNew: (mode === 'new')     // 用户选择「另存一份」，界面据此换一句提示
    };

    const dup = (mode === 'new') ? null
      : ((opts && opts.targetId) ? (await DB.get('books', opts.targetId)) : await this.findExisting(o));
    if (dup) {
      // R131（第 7/8 条）：明确「补齐 = 只加不减」，并把「新增几条 / 已有几条跳过」算出来告诉用户。
      // 以前只报「合并进已有」一个总数，用户看不出到底补了什么，容易以为「直接被覆盖了」。
      const s = await Backup.mergeAnnots(dup.id, ann, { from: o.id });
      got.inkStrokes = s.inkStrokes;
      got.annots = s.annots + s.mergedAnnots;
      const plainAnn = ann.filter(a => a && a.type !== 'ink').length;
      got.skipped = Math.max(0, plainAnn - got.annots);   // 本地已有（一字不差）而跳过的条数
      got.existed = true;
      got.targetTitle = dup.title;
      // R131（第 7/8 条）：目录改成**增量合并** —— 以前「本地有目录」就整份丢弃共享目录，
      // 于是主机补的章节永远进不来（用户实测：「目录不能共享」）。
      // 现在是「本地一条不删，只把共享包里本地没有的章节按偏移插进去」。
      const incCh = Array.isArray(o.chapters) ? o.chapters : [];
      const myCh = Array.isArray(dup.chapters) ? dup.chapters : [];
      const mg = this._mergeChapters(myCh, incCh);
      if (mg.added) dup.chapters = mg.list;
      got.chapters = mg.list.length;
      got.chaptersAdded = mg.added;
      got.chaptersKept = mg.kept;
      dup.gotStats = got;
      await DB.put('books', dup);
      return dup;
    }

    const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const book = {
      id, title: await this._uniqTitle((o.title || '未命名') + '（共享）'), format: o.format,
      length: o.length || 0, totalPages: 0, locator: o.locator || 0,
      progress: o.progress || 0, addedAt: Date.now(), lastReadAt: Date.now(),
      fav: false, chapters: o.chapters || [], content: {}
    };
    if (o.format === 'pdf') {
      const u8 = ShareCrypto.fromB64(o.data || '');
      book.content = { kind: 'pdf', data: u8.buffer.slice(0) };
    } else if (o.format === 'comic') {
      book.content = {
        kind: 'comic', items: (o.items || []).map((it, i) => ({
          name: it.name || (i + '.jpg'),
          blob: new Blob([ShareCrypto.fromB64(it.data)], { type: 'image/*' })
        }))
      };
    } else {
      // R69：按来源的 kind 还原（html 书必须是 kind:'html'，否则「编辑原文」和章节定位都不对）
      book.content = (o.kind === 'html')
        ? { kind: 'html', html: o.text || '', images: {} }
        : { kind: 'text', text: o.text || '' };
      if (o.md) book.content.md = o.md;
    }
    await DB.put('books', book);

    // 手迹 key/id 一并换成本书号（R67 的坑），去重逻辑与备份恢复共用 mergeAnnots
    const s = await Backup.mergeAnnots(id, ann, { from: o.id });
    got.inkStrokes = s.inkStrokes;
    got.annots = s.annots;
    // 让调用方（界面）能如实告诉用户「这次到底带过来多少东西」
    book.gotStats = got;
    return book;
  }
};
