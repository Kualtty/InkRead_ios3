/* ============================================================
   device.js —— 「连到别的设备」：把整个界面切到另一台墨阅
   ------------------------------------------------------------
   为什么需要：
     安卓 APK 里的 WebView 永远加载 http://127.0.0.1:8123，
     只认手机自己那份书库。想看电脑那台的书，以前只能用手机浏览器
     手输 IP —— 而手机上的人根本不会去输。

     现在给一个入口：填地址 / 自动发现 → 整页切过去。
     切过去以后翻页、笔记、进度都写回对方那台（不是副本），
     因为页面本身就是对方服务器发出来的。

     电脑浏览器里同样成立（就是一次普通跳转），只是没有原生壳可调。

   和「📡 共享」的区别：
     共享 = 把书拷一份到自己库里，之后各看各的；
     连设备 = 直接用对方的库，自己这本什么都不变（也不占空间）。
   ============================================================ */

const Device = (() => {
  const LS_KEY = 'ink.devicePeer';     // 只在浏览器里记地址，APK 里由原生 SharedPreferences 记

  /* ---------------- 基本判断 ---------------- */

  function isLocal() {
    const h = String(location.hostname || '');
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '';
  }

  function nativeBridge() {
    return (typeof window !== 'undefined' && window.InkAndroid) ? window.InkAndroid : null;
  }

  function port() {
    return String(location.port || '8123');
  }

  function localUrl() {
    return 'http://127.0.0.1:' + port() + '/index.html';
  }

  /** 当前界面上到底是哪台（给人看的一句话） */
  function currentLabel() {
    if (isLocal()) return '本机书库';
    return location.host + ' 的书库';
  }

  /* ---------------- 地址规整 ---------------- */

  /** 允许「192.168.1.5」「192.168.1.5:8123」「http://x:8123/」等写法 */
  function norm(addr) {
    let s = String(addr || '').trim();
    if (!s) return '';
    if (typeof Share !== 'undefined' && Share.normHost) return Share.normHost(s);
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    s = s.replace(/\/+$/, '');
    if (!/:\d+(?=$|\/)/.test(s)) s += ':8123';
    return s;
  }

  function urlOf(addr) {
    const b = norm(addr);
    return b ? b + '/index.html' : '';
  }

  /* ---------------- 切换 ---------------- */

  /** 切到另一台。APK 里交给原生（会记住，下次启动直接进），浏览器里直接跳。 */
  function go(addr) {
    const url = urlOf(addr);
    if (!url) return false;
    const br = nativeBridge();
    if (br && br.openUrl) { br.openUrl(url); return true; }
    try { localStorage.setItem(LS_KEY, url); } catch (e) { }
    location.href = url;
    return true;
  }

  /** 回到本机书库 */
  function goLocal() {
    const br = nativeBridge();
    if (br && br.goLocal) { br.goLocal(); return; }
    try { localStorage.removeItem(LS_KEY); } catch (e) { }
    location.href = localUrl();
  }

  /** APK 里「上次连的是谁」——原生那边有记录；浏览器返回空 */
  function savedRemote() {
    const br = nativeBridge();
    if (br && br.remoteUrl) {
      try { return String(br.remoteUrl() || ''); } catch (e) { return ''; }
    }
    try { return String(localStorage.getItem(LS_KEY) || ''); } catch (e) { return ''; }
  }

  /* ---------------- 自动发现 ---------------- */

  async function myInfo() {
    // 安卓壳里先问原生要网卡地址：Python 那边的 myaddr 经常只报 127.0.0.1，
    // 于是「算不出网段 → 254 个地址一个都不扫 → 没扫到别的设备」。
    const br = nativeBridge();
    let native = [];
    if (br && br.lanIps) {
      try {
        native = String(br.lanIps() || '').split(',').map(s => s.trim()).filter(Boolean);
      } catch (e) { }
    }
    let ips = [];
    let port0 = Number(port());
    try {
      const r = await fetch('/api/share/myaddr', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        ips = Array.isArray(j.ips) ? j.ips : [];
        port0 = Number(j.port) || port0;
      }
    } catch (e) { }
    native.forEach(ip => { if (ips.indexOf(ip) < 0) ips.push(ip); });
    return { ips, port: port0 };
  }

  async function lanPrefix() {
    if (typeof Share !== 'undefined' && Share.myLanPrefix) return Share.myLanPrefix();
    return null;
  }

  /**
   * 扫同网段里所有墨阅（不要求对方开着共享）。
   * @param {(done:number,total:number)=>void} [onStep]
   * @returns {Promise<Array<{uid:string,name:string,ip:string,port:number,sharing:boolean}>>}
   */
  async function discover(onStep) {
    const me = await myInfo();
    const hits = new Map();
    const seen = new Set();
    let done = 0, total = 0;
    const step = () => { if (onStep) { try { onStep(done, total); } catch (e) { } } };

    const probe = (ip, p, ms) => {
      const key = ip + ':' + p;
      if (seen.has(key)) { done++; return Promise.resolve(); }
      seen.add(key);
      total++; done++;
      const ctrl = ('AbortController' in window) ? new AbortController() : null;
      const to = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
      return fetch('http://' + ip + ':' + p + '/api/share/discover-info', {
        cache: 'no-store', signal: ctrl ? ctrl.signal : undefined
      }).then(r => r.ok ? r.json() : null).then(j => {
        if (!j || !j.ok) return;
        const uid = j.uid || ('ip:' + ip);
        const good = !/^127\./.test(ip) && !/^169\.254\./.test(ip);
        const old = hits.get(uid);
        if (!old) {
          hits.set(uid, { uid, name: j.name || '墨阅书库', ip, port: p, sharing: !!j.on, good });
        } else {
          if (good && !old.good) { old.ip = ip; old.port = p; old.good = true; }
          if (j.on) old.sharing = true;
        }
      }).catch(() => { }).finally(() => { if (to) clearTimeout(to); });
    };

    // 1) 我是谁：直接问自己的服务（同一个安装目录 = 同一个 uid，用它把自己筛掉）
    let myUid = '';
    try {
      const r = await fetch('/api/share/discover-info', { cache: 'no-store' });
      if (r.ok) myUid = (await r.json()).uid || '';
    } catch (e) { }

    // 2) 再扫同网段（别人都用默认 8123）
    //    一台机器可能挂着好几个网卡（WiFi / 有线 / VMware / WSL），
    //    光看「第一个 IP」经常扫的是虚拟网段 —— 所以把所有网段都扫，
    //    WebRTC 那一路只当补充。最多 4 个 /24，再多就太慢。
    const prefixes = [];
    const addPrefix = ip => {
      const m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(String(ip || ''));
      if (!m) return;
      const p = m[1] + '.';
      if (prefixes.indexOf(p) < 0) prefixes.push(p);
    };
    const rtc = await lanPrefix();          // 形如 '192.168.1.'，末尾带点
    if (rtc) addPrefix(rtc + '1');
    (me.ips || []).forEach(addPrefix);

    if (prefixes.length) {
      const jobs = [];
      // 同一台机器上的另一个实例（开发 8131 / 回归 8130 / 安装版 8123）也算一台设备，
      // uid 不同就不算「我」，所以这里顺手探一下本机 8123
      jobs.push({ ip: location.hostname || '127.0.0.1', port: 8123 });
      prefixes.slice(0, 4).forEach(p => {
        for (let i = 1; i <= 254; i++) jobs.push({ ip: p + i, port: 8123 });
      });
      // 64 并发 / 每批 600ms：一个 /24 大约 3 秒
      for (let k = 0; k < jobs.length; k += 64) {
        await Promise.all(jobs.slice(k, k + 64).map(x => probe(x.ip, x.port, 600)));
        step();
      }
    }

    const out = [];
    for (const h of hits.values()) {
      // 只按 uid 排除自己：同一台机器上另起一个实例（开发/回归）也该能扫到，
      // 那种情况下 IP 也是 127.0.0.1，用 IP 判「是不是我」会把它一起筛掉。
      if (myUid && h.uid === myUid) continue;
      out.push({ uid: h.uid, name: h.name, ip: h.ip, port: h.port, sharing: h.sharing });
    }
    out.sort((a, b) => (b.sharing - a.sharing) || a.name.localeCompare(b.name, 'zh'));
    return out;
  }

  return { isLocal, localUrl, currentLabel, norm, urlOf, go, goLocal, savedRemote, discover, myInfo };
})();
