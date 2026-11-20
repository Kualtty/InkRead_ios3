/* ============================================================
   main.js —— 启动、事件绑定、设置面板
   ============================================================ */
let ink = null;
let _toastTimer = null;
function toast(msg, ms) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), ms || 1900);
}

/* ---------- 加载遮罩 ---------- */
function loading(show, text) {
  $('loading').hidden = !show;
  if (text) $('loadingText').textContent = text;
}

/* 导入结果汇总提示：按格式分类计数 + 失败数。
   形如「2 本漫画导入成功，1 本文本导入成功，1 本 PDF 导入成功，3 本格式不符合，无法导入（如：foo.xyz）」 */
/** 选择弹窗的 Promise 版（R70：共享判重时问「合并 / 另存一份」）。
 *  取消 / 点「取消」→ 返回 -1。showChoice 是回调式，这里是它的 await 封装。 */
function askPick(title, options) {
  return new Promise(resolve => {
    const box = $('choiceSheet');
    if (!box) return resolve(-1);
    $('choiceTitle').textContent = title;
    $('choiceList').innerHTML = options.map((o, i) =>
      '<button class="choice-item" data-i="' + i + '">' + esc(String(o)) + '</button>').join('');
    const done = v => {
      box.hidden = true;
      box._cb = null;
      box._cancel = null;
      resolve(v);
    };
    box._cancel = () => done(-1);
    $('choiceList').querySelectorAll('[data-i]').forEach(b => {
      b.onclick = () => done(parseInt(b.dataset.i, 10));
    });
    box.hidden = false;
  });
}

function summarizeImport(books, failed) {
  const cat = { comic: 0, text: 0, pdf: 0, other: 0 };
  for (const b of (books || [])) {
    if (b.format === 'comic') cat.comic++;
    else if (b.format === 'pdf') cat.pdf++;
    else if (b.format === 'txt' || b.format === 'html') cat.text++;
    else cat.other++;
  }
  const segs = [];
  if (cat.comic) segs.push(`${cat.comic} 本漫画导入成功`);
  if (cat.text) segs.push(`${cat.text} 本文本导入成功`);
  if (cat.pdf) segs.push(`${cat.pdf} 本 PDF 导入成功`);
  if (cat.other) segs.push(`${cat.other} 本其他格式导入成功`);
  let msg = segs.length ? segs.join('，') : '没有导入成功';
  if (failed && failed.length) {
    // 把每本失败的真实原因（文件名后的「：原因」）展示出来，
    // 否则用户只看到"格式不符合"却不知道到底是缺 LibreOffice 还是文件损坏（修 #2）。
    const reasons = failed.map(f => {
      const i = f.indexOf('：');
      return (i >= 0 ? f.slice(i + 1) : f) || f;
    });
    msg += `，${failed.length} 本导入失败：${reasons.join('；')}`;
  }
  return msg;
}

/* ============================================================
   启动
   ============================================================ */
window.addEventListener('DOMContentLoaded', async () => {
  /* 装进安卓壳里（APK）时：这不是网页演示，别摆「原型控制条 + 假状态栏」，
     而且必须铺满真实屏幕 —— 以前默认会套一个 390×844 的手机外框，
     比它小的手机被缩放到 300 出头（什么都很挤），平板则在中间留一大圈黑边。 */
  /* iOS「添加到主屏幕」跑起来也是 App，不是网页演示：控制条、假状态栏、390×844 手机外框
     同样不该出现。`navigator.standalone` 只有 iOS 认；display-mode 给别的浏览器兜底
     （Safari 里普通标签页两者都为假，照旧显示原型外框，不影响电脑上调试）。 */
  const iosHome = (navigator.standalone === true)
    || (window.matchMedia && (window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: fullscreen)').matches));
  if (iosHome && !window.InkAndroid) {
    document.body.classList.add('in-app');
    document.body.classList.add('ios-home');
    // iOS 上没有「桌面图标 / start-inkreader.bat」可点，横幅只能给人话
    const bt0 = document.querySelector('#backendBanner .bb-text');
    if (bt0) bt0.textContent = '⚠️ 没连上电脑上的墨阅：翻译 / 查词 / 共享不可用。请确认电脑开着墨阅，手机和电脑在同一个 WiFi。';
    const rv0 = $('backendBannerRevive');
    if (rv0) { rv0.hidden = true; rv0.style.display = 'none'; }
    const rs0 = $('backendBannerRestart');
    if (rs0) { rs0.hidden = true; rs0.style.display = 'none'; }
  }
  if (window.InkAndroid) {
    document.body.classList.add('in-app');
    // 安卓里没有「桌面图标 / start-inkreader.bat」这些东西，横幅文案要换成真话
    const bt = document.querySelector('#backendBanner .bb-text');
    if (bt) bt.textContent = '⚠️ 本地服务没在跑：翻译 / 查词 / 共享不可用。点「🔄 重启服务」会重启整个墨阅（约 1 秒）。';
    const rv = $('backendBannerRevive');
    if (rv) { rv.hidden = true; rv.style.display = 'none'; }
  }
  await loadSettings();
  // 书架是首屏，设置里的界面背景要在开书之前就生效（applySettings 开头遇到「没开书」会提前 return）
  if (typeof applyUiBg === 'function') applyUiBg();
  window._hlColor = HL_COLORS[Settings.hlColorIdx || 0] || HL_COLORS[0];
  ink = new InkCanvas($('inkCanvas'));
  bindProtoBar();
  bindLibrary();
  bindReader();
  bindTTS();
  bindPen();
  bindSettingsPanel();
  buildSettingsPanel();
  const verEl = $('libVer');
  if (verEl) verEl.textContent = '墨阅 ' + APP_VERSION;
  await Library.refresh();
  /* R133：老书库里可能已经躺着同名书（同一本导入过两次）。启动时补一次序号，
     先入库的留原名；之后再导入 / 改名都会被 uniqueBookTitle 拦住。 */
  try {
    const dup = await Library.dedupeTitles();
    if (dup.length) {
      Library.render();
      /* 别跟启动时的「书库已同步」抢同一个位置 —— 那条通常 2.6 秒后自己消失。
         书名被悄悄改了却一句提示都没有，用户会以为书丢了，所以宁可晚两秒说。 */
      setTimeout(() => toast('已给 ' + dup.length + ' 本同名书加上序号，方便区分', 4200), 2800);
    }
  } catch (e) { console.warn('整理同名书失败', e); }
  Library.migrateMarkdownOnce();      // 老 .md（存成 txt 的）统一转富文本，别只靠「打开过」
  /* 书库镜像对账（安装目录 data/）：本机多个地址、iPad 通过局域网打开都是同一批书。
     没有后端（静态托管 / file://）时它自己静默停用，不等待、不阻塞首屏。 */
  if (typeof Sync !== 'undefined') {
    Sync.init().then(async st => {
      /* R74：源码树（开发用）跑起来的服务落盘到 data-dev，不是用户书库。
         这种时候必须当面说清楚，否则又会变成「我的书到底存哪了」。 */
      if (st && st.ok && st.dev && typeof toast === 'function') {
        toast('⚠️ 当前连的是开发目录，书只写 data-dev，不进安装目录 —— 请用桌面图标打开', 6000);
      }
      if (st && st.ok && (st.pulled || st.pushed) && typeof toast === 'function') {
        const seg = [];
        if (st.pulled) seg.push(`取回 ${st.pulled} 本`);
        if (st.pushed) seg.push(`存入 ${st.pushed} 本`);
        toast('书库已同步：' + seg.join('，'), 2600);
      }
      /* R133：镜像里也可能带回同名书（另一台设备导入过同一本）。
         等 Sync 自己的 refresh 落定再扫一遍，免得拿旧书单判重。 */
      if (st && st.ok && st.pulled) {
        try {
          await Library.refresh();
          const d2 = await Library.dedupeTitles();
          if (d2.length) {
            Library.render();
            setTimeout(() => toast('已给 ' + d2.length + ' 本同名书加上序号，方便区分', 4200), 2800);
          }
        } catch (e) { console.warn('同步后整理同名书失败', e); }
      }
    }).catch(() => { });
  }
  updateSbTime();
  setInterval(updateSbTime, 20000);
  // 后端探活：页面是否由 serve.py 托管？没有后端则翻译 / 安装 / 局域网共享全部失效。
  // 用极轻量的 /api/ping，失败时显示顶部红色提示条（比一次性 toast 更不容易漏看）。
  const bb = $('backendBanner'), bbClose = $('backendBannerClose'), bbRecover = $('backendBannerRecover');
  const bbRevive = $('backendBannerRevive');
  const showBanner = () => { if (bb) bb.hidden = false; };
  // R90：服务进程没了的时候，「重启 / 重连」都是死按钮 —— 页面只能发 HTTP 请求，
  // 而能接请求的进程已经不在了，等 20 秒也等不到什么。真正能把它拉起来的是
  // 系统协议 inkreader://（install 时登记，指向安装目录的 inkreader.exe）。
  // 所以失败一次就把这个链接亮出来，而不是让用户对着一个不动的横幅猜。
  const showRevive = (on) => { if (bbRevive) bbRevive.hidden = !on; };
  if (bbClose) bbClose.onclick = () => { if (bb) bb.hidden = true; };
  // 用户是否主动点了「停止后台服务」：主动停止时不再提示「崩溃」文案，也不提供恢复按钮
  // （因为监督进程已随之退出，需重新运行启动器）。
  window.__inkUserStopped = false;
  // file:// 或无后端代理时（直接双击 index.html / WorkBuddy 内嵌预览）：没有 serve.py + supervise.py
  // 可重启，重启/恢复/停止三个按钮都是「死按钮」点了没反应。此时直接给指引并隐藏它们，
  // 避免「点了都没用」的困惑（修本轮会话按钮反馈）。
  if (location.protocol === 'file:') {
    if (bb) {
      const t = bb.querySelector('.bb-text');
      if (t) t.textContent = '⚠️ 你是直接双击 index.html（file://）打开的，没有本地服务，翻译 / 查词 / 共享 / 词典内嵌都不可用。请改用桌面「墨阅 InkReader」图标，或安装目录里的 start-inkreader.bat 打开。';
      ['backendBannerRestart', 'backendBannerStop', 'backendBannerRecover'].forEach(id => {
        const b = $(id); if (b) b.hidden = true;
      });
      bb.hidden = false;
    }
  }
  const SID = (Date.now().toString(36) + Math.random().toString(36).slice(2));
  // 本地代理提示条（独立于后端横幅）：仅当后端在线但本地代理（/proxy）确实不可用时才提示。
  // 关键：能收到 /api/ping 即说明本页由 InkReader 的 serve.py 托管——它必然同时提供 /proxy，
  // 二者同源同进程、随同一份 serve.py 上线，不存在「后端在线却缺代理」的情况。
  // 因此 /api/ping 成功就直接判定代理可用并收起横幅，不再依赖脆弱的 /proxy-ping 探测，
  // 彻底消除「代理其实在、横幅却反复弹」的误报（修 #1 反复弹横幅）。
  const pb = $('proxyBanner'), pbClose = $('proxyBannerClose');
  if (pbClose) pbClose.onclick = () => { if (pb) pb.hidden = true; };
  fetch('/api/ping', { cache: 'no-store' })
    .then(r => {
      if (r.ok) {
        // 由我们的 serve.py 托管 → 代理必然可用，直接收起横幅并标记可用。
        if (typeof Dict !== 'undefined') { Dict.proxyOK = true; if ($('dictProxyWarn')) $('dictProxyWarn').hidden = true; }
        if (pb) pb.hidden = true;
        // 软校验（兜底）：若将来代理可被单独禁用，这里再补判；默认不弹。
        if (typeof Dict !== 'undefined' && Dict.checkProxy) {
          Dict.checkProxy().then(ok => { if (ok === false && pb) pb.hidden = false; }).catch(() => {});
        }
      } else {
        // 收不到 /api/ping = 没有后端（直接双击 index.html / 服务没起）= 走后端横幅。
        showBanner();
      }
    })
    .catch(() => showBanner());
  // 会话心跳：通知 serve.py「本阅读页已打开」，全部页关闭后服务端才释放端口
  fetch('/api/beat?act=open&sid=' + encodeURIComponent(SID), { method: 'POST', keepalive: true }).catch(() => {});
  // 空闲心跳：每 15s 告诉 serve.py「浏览器还开着」。若页面还开着但服务已被杀
  // （崩溃 / 被杀 / 空闲看门狗误杀），连续 2 次(≈30s)心跳失败就弹提示。
  // 注意：生产环境由 supervise.py 监督进程在 ~1.5s 内自动把 serve.py 拉起，
  // 所以绝大多数「误杀」在下一次心跳前就已自愈，这里只是兜底提示 + 手动恢复入口。
  let beatFail = 0;
  const onServerGone = () => {
    const t = bb && bb.querySelector('.bb-text');
    if (window.__inkUserStopped) {
      if (t) t.textContent = '您已手动停止本地服务。要继续用，点「🖥 用桌面程序拉起」（或双击桌面 InkReader 图标）。刷新本页没用——页面也是这个服务发出来的。';
      if (bbRecover) bbRecover.hidden = true;
      showRevive(true);
    } else {
      if (t) t.textContent = '⚠️ 本地服务未运行：翻译 / 查词 / 共享不可用。点「🔄 重启服务」会重启（约 1.5 秒自动拉起）；已拉起时点「🔄 重连服务」。';
      if (bbRecover) bbRecover.hidden = false;
      showRevive(true);
    }
    showBanner();
  };
  // 「🔄 恢复本地服务」：先立即探活（监督进程通常已把服务拉起），通则隐藏横幅；
  // 仍不通则整页刷新（依赖监督进程 / 用户重新运行启动器），刷新后由 /api/ping 判定。
  if (bbRecover) bbRecover.onclick = async () => {
    // R66：多等一会儿（监督进程通常 1~2 秒拉起，冷启动可能要十几秒），别 8 秒就放弃。
    // 起来之后不刷新页面（连接已经恢复，正文/进度都在），只把横幅收掉。
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch('/api/ping', { cache: 'no-store' });
        if (r.ok) { beatFail = 0; if (bb) bb.hidden = true; showRevive(false); toast('已重新连上本地服务'); return; }
      } catch (e) { /* 仍不通，继续等 */ }
      await new Promise(res => setTimeout(res, 500));
    }
    // 20 秒还没起来：说明没有任何进程在把服务拉起来（监督进程也没了）。
    // 不再盲目刷新（刷新只会得到「无法访问此网站」），让用户用系统协议把它叫起来。
    const t = bb && bb.querySelector('.bb-text');
    if (t) {
      t.innerHTML = '⚠️ 等了 20 秒，本地服务还是没起来 —— 现在没有任何进程在守着它。' +
        '点 <b>「🖥 用桌面程序拉起」</b>：系统会启动 InkReader 并自动把服务带回来，本页会自动接上。<br>' +
        '也可以双击桌面 <b>InkReader</b> 图标，或运行安装目录里的 <code>start-inkreader.bat</code>。';
    }
    showRevive(true);
    showBanner();
  };
  setInterval(() => {
    fetch('/api/beat?act=keep&sid=' + encodeURIComponent(SID), { method: 'POST', keepalive: true })
      .then(r => { if (r.ok) { beatFail = 0; if (bb) bb.hidden = true; } else if (++beatFail >= 2) onServerGone(); })
      .catch(() => { if (++beatFail >= 2) onServerGone(); });
  }, 15000);
  // 关闭页面：通知 serve.py 移除本会话（sendBeacon 在页面卸载时仍尽力发出）
  const _closeBeat = () => { try { navigator.sendBeacon('/api/beat?act=close&sid=' + encodeURIComponent(SID)); } catch (e) {} };
  window.addEventListener('pagehide', _closeBeat);
  window.addEventListener('beforeunload', _closeBeat);
  // 「🔄 重启服务」：进程内原地重启（serve.py 不退出，由 main 重启循环重建 Server，约 1 秒，
  // 不依赖 supervise、不吃 Python 冷启动），彻底解决「重启总失败 / 要等十几秒」。
  const bbRestart = $('backendBannerRestart');
  if (bbRestart) bbRestart.onclick = async () => {
    /* 安卓壳里没有「桌面程序」可拉起：/api/server-restart 只是原地重建 HTTP Server，
       服务线程真死了它也没辙。这里直接交给原生整进程重启（约 1 秒），
       比页面上点什么「重连」都管用。 */
    if (window.InkAndroid && window.InkAndroid.restartApp) {
      toast('正在重启墨阅…');
      try { window.InkAndroid.restartApp(); return; } catch (e) { }
    }
    window.__inkUserStopped = false;   // 重启后不再是「用户主动停止」状态（修 #2：之前残留状态导致恢复按钮错乱）
    let posted = false;
    try {
      // 4 秒还没响应就当作「发不出去」——服务已经死了的时候 fetch 会立刻失败，
      // 这个 abort 只是防「连上了但卡住」的极端情况。
      const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const tid = ctl ? setTimeout(() => ctl.abort(), 4000) : 0;
      const r = await fetch('/api/server-restart', {
        method: 'POST', keepalive: true, signal: ctl ? ctl.signal : undefined
      });
      if (tid) clearTimeout(tid);
      posted = r.ok;
      // 404 = 服务是很老的版本，根本没有这个接口（用户反馈「点重启没反应」多半是这种：
      // 旧安装目录里的 serve.py 一直在跑，页面也是它喂的旧文件）。
      if (r.status === 404) {
        toast('本地服务版本太旧，重启不了：请双击桌面 InkReader 重新打开（或覆盖安装新版）');
        return;
      }
    } catch (e) { posted = false; }
    if (!posted) {
      // R90：请求根本没送到 = 服务进程已经不在了。页面再等 30 秒也等不到东西，
      // 直接把「怎么把它叫起来」摆出来（以前这里只弹一句「连不上」，等于没说）。
      const t = bb && bb.querySelector('.bb-text');
      if (t) {
        t.innerHTML = '⚠️ 本地服务进程已经不在了，重启请求发不出去（页面自己能发的只有 HTTP 请求）。' +
          '点 <b>「🖥 用桌面程序拉起」</b>：系统会启动 InkReader，约 1~3 秒服务回来，本页自动接上。<br>' +
          '也可以双击桌面 <b>InkReader</b> 图标。';
      }
      showRevive(true);
      showBanner();
      toast('服务进程已停止：点横幅里的「🖥 用桌面程序拉起」');
      return;
    }
    for (let i = 0; i < 75; i++) {      // 最多等 30 秒（冷启动慢的机器也别急着报错）
      await new Promise(r => setTimeout(r, 400));
      try { const r = await fetch('/api/ping', { cache: 'no-store' }); if (r.ok) { beatFail = 0; if (bb) bb.hidden = true; showRevive(false); toast('后台服务已重启'); return; } } catch (e) {}
    }
    toast('重启后连不上：点横幅里的「🖥 用桌面程序拉起」，或双击桌面 InkReader');
    showRevive(true);
  };
  // 「⏹ 停止后台服务」：标记主动停止后请求服务退出（与设置面板按钮同逻辑）
  const bbStop = $('backendBannerStop');
  if (bbStop) bbStop.onclick = async () => {
    window.__inkUserStopped = true;
    try { await fetch('/api/engine-stop?which=both', { method: 'POST' }); } catch (e) {}
    try { await fetch('/api/server-stop', { method: 'POST' }); } catch (e) {}
  };
  // 首页也能进设置：书架页的「Aa 设置」直接打开同一个阅读设置抽屉
  const libSet = $('libSettingsBtn');
  if (libSet) libSet.onclick = () => { buildSettingsPanel(); openDrawer('settingsDrawer'); };
});

function updateSbTime() {
  const d = new Date();
  $('sbTime').textContent = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
}

/* ============================================================
   原型外壳控制（窗口尺寸选择）
   ------------------------------------------------------------
   六档：手机 6.1" / iPad 横 10.9" / iPad 竖 11" / iPad Pro 12.9" /
        自适应窗口 / 自适应全屏。
   - 手机：390×844，窗口装不下时**等比缩小**（手机 APK 上就是满屏手机版）
   - 自适应窗口：撑满浏览器窗口，保留外壳圆角与 18px 留白
   - 自适应全屏：贴边铺满（.stage 内边距也归零）
   - iPad 三档是固定尺寸，和以前完全一样；窗口不够大就让舞台滚动（不改原尺寸）
   选择记到 localStorage，重开还是上次那档；第一次打开按屏幕宽度给默认值。
   ============================================================ */
const DEVICE_KEY = 'ink.deviceMode';
const DEVICE_FRAME = 22;      // .ipad 左右各 11px 边框，算进总宽高

function deviceKeyOf(b) {
  const kind = b.dataset.kind || 'fixed';
  if (kind === 'phone' || kind === 'auto' || kind === 'full') return kind;
  return 'pad' + b.dataset.w + 'x' + b.dataset.h;
}

function deviceBtnByKey(key) {
  const list = document.querySelectorAll('#deviceSeg .seg-btn');
  for (let i = 0; i < list.length; i++) if (deviceKeyOf(list[i]) === key) return list[i];
  return null;
}

/** 换完窗口尺寸后，让正文按新宽度重新分页（原来写在点击里，现在缩放也要用） */
function deviceRelayout() {
  setTimeout(() => {
    try {
      if (typeof R !== 'undefined' && R.book) {
        if (R.format === 'txt') {
          R._layoutSig = ''; relayout();
          if (Settings.direction === 'vertical') { renderScrollContent(); scrollToOffset(parseInt(R.book.locator || 0)); }
          else goToPage(R.pageIndex, true);
        }
        if (R.format === 'pdf') renderPdfPage(R.pageIndex + 1);
        ink.resize(); refreshInk();
      } else ink.resize();
    } catch (e) { /* 首屏还没进阅读器，忽略 */ }
  }, 340);
}

function applyDevice(b) {
  const ipad = $('ipad'), stage = $('stage');
  if (!ipad || !stage || !b) return;
  const kind = b.dataset.kind || 'fixed';
  const w0 = parseInt(b.dataset.w) || 0, h0 = parseInt(b.dataset.h) || 0;

  document.querySelectorAll('#deviceSeg .seg-btn').forEach(x => x.classList.toggle('active', x === b));
  ipad.classList.remove('fullscreen', 'portrait');
  stage.classList.toggle('stage-full', kind === 'full');

  // cw/ch = 屏幕（外壳内容盒）实际宽高。**不能等布局完再量**：.ipad 有 .3s 宽高过渡，
  // 量到的是动画中间值（曾经把「手机 390×844」显示成 1024×768），所以这里自己算。
  let cw = w0, ch = h0;
  if (kind === 'full') {
    ipad.classList.add('fullscreen');
    ipad.style.width = '100%'; ipad.style.height = '100%';
    cw = stage.clientWidth - DEVICE_FRAME;
    ch = stage.clientHeight - DEVICE_FRAME;
  } else if (kind === 'auto') {
    // 100% 是 .stage 的内容盒（已扣掉 18px 内边距），外壳圆角留着
    ipad.style.width = '100%'; ipad.style.height = '100%';
    ipad.classList.toggle('portrait', stage.clientWidth < stage.clientHeight);
    cw = stage.clientWidth - 36 - DEVICE_FRAME;
    ch = stage.clientHeight - 36 - DEVICE_FRAME;
  } else if (kind === 'phone') {
    // 手机横屏（窗口本身就矮：高 < 500）：直接铺满窗口。
    // 这时候再套 844×390 的手机框，缩放后只剩 300 高，反而更挤。
    const phoneLand = stage.clientHeight < 500 && stage.clientWidth > stage.clientHeight;
    if (phoneLand) {
      ipad.style.width = '100%'; ipad.style.height = '100%';
      cw = stage.clientWidth - 36 - DEVICE_FRAME;
      ch = stage.clientHeight - 36 - DEVICE_FRAME;
    } else {
      // 装不下就等比缩小；缩到 300 宽以下就不缩了（再小就成邮票），让舞台滚动
      const availW = stage.clientWidth - 36, availH = stage.clientHeight - 36;
      const k = Math.min(1, availW / (w0 + DEVICE_FRAME), availH / (h0 + DEVICE_FRAME));
      cw = (k < 1 && w0 * k >= 300) ? Math.floor(w0 * k) : w0;
      ch = cw === w0 ? h0 : Math.floor(h0 * (cw / w0));
      ipad.style.width = (cw + DEVICE_FRAME) + 'px';
      ipad.style.height = (ch + DEVICE_FRAME) + 'px';
    }
  } else {
    ipad.style.width = (w0 + DEVICE_FRAME) + 'px';
    ipad.style.height = (h0 + DEVICE_FRAME) + 'px';
    ipad.classList.toggle('portrait', h0 > w0);
  }

  // 窄到放不下双栏（<430）就切手机版排版：侧栏收成图标栏。
  // 跟选的是哪一档无关 —— 手机上选「自适应窗口」也是 390 宽，同样需要手机版。
  ipad.classList.toggle('phone', cw < 430);

  deviceRelayout();
  try { localStorage.setItem(DEVICE_KEY, deviceKeyOf(b)); } catch (e) {}
  protoHintFor(b, cw, ch);
}

/** 控制条右侧那句小字：告诉用户这档是什么（截图/反馈时能对上） */
function protoHintFor(b, cw, ch) {
  const el = $('protoHint');
  if (!el) return;
  const kind = b.dataset.kind || 'fixed';
  const size = cw + '×' + ch;
  el.textContent = kind === 'phone' ? ('手机窗口 ' + size + (cw > ch ? ' · 横屏铺满' : ' · 竖屏'))
    : kind === 'auto' ? ('自适应窗口 ' + size + ' · 跟着窗口走')
      : kind === 'full' ? ('全屏 ' + size + ' · 贴边')
        : ('固定 ' + size + (ch > cw ? ' · 竖屏' : ' · 横屏'));
}

function bindProtoBar() {
  const btns = [...document.querySelectorAll('#deviceSeg .seg-btn')];
  btns.forEach(b => { b.onclick = () => applyDevice(b); });

  // 上次选的那档优先。没选过才猜默认：
  //   触屏设备（手机/平板/APK）→ 按窗口宽度给「手机」或「自适应窗口」，
  //   桌面（鼠标）→ 还是原来的 iPad 横 1024×768 —— 别动桌面和回归测试的默认布局。
  let saved = null;
  try { saved = localStorage.getItem(DEVICE_KEY); } catch (e) {}
  let cur = saved ? deviceBtnByKey(saved) : null;
  if (window.InkAndroid) {
    /* APK 里只有一个正确答案：铺满真实屏幕（「自适应全屏」）。
       以前这里会沿用上次在原型条里点的那档 —— 手机上选了「手机 6.1"」，
       比 6.1 小的机器就被等比缩到 300 多宽；平板上则是一个居中的小框。 */
    cur = btns.find(x => (x.dataset.kind || '') === 'full') || cur;
  }
  if (!cur) {
    // 只认手机/平板自己的 UA（Android 和 iPad）—— Windows 触屏本不该被当成平板，
    // 桌面和回归测试（Edge + 鼠标）必须还是原来的 iPad 横 1024×768。
    const ua = navigator.userAgent || '';
    const isPad = /Android/i.test(ua) || (/iPad|Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
    const def = !isPad ? 'pad1024x768'
      : (Math.min(window.innerWidth, window.innerHeight) < 700 ? 'phone'
        : (window.innerWidth < 1100 ? 'auto' : 'pad1024x768'));
    cur = deviceBtnByKey(def) || btns[1];
  }
  applyDevice(cur);

  // 浏览器窗口变化时，自适应/手机档要重算尺寸（固定档不动，免得 iPad 尺寸被悄悄改掉）
  let tid = 0;
  window.addEventListener('resize', () => {
    clearTimeout(tid);
    tid = setTimeout(() => {
      const cur2 = document.querySelector('#deviceSeg .seg-btn.active');
      if (!cur2) return;
      const k = cur2.dataset.kind || 'fixed';
      if (k === 'fixed') return;
      applyDevice(cur2);
    }, 260);
  });

  $('showStatusBar').onchange = e => { $('statusBar').style.display = e.target.checked ? '' : 'none'; };
  $('resetDataBtn').onclick = async () => {
    if (!confirm('将清空本地所有书籍、笔记和设置，确定？')) return;
    await DB.wipe();
    location.reload();
  };
}

/* ============================================================
   书架事件
   ============================================================ */
/* ============================================================
   侧栏抽屉（小屏）
   ------------------------------------------------------------
   手机上侧栏以前是 86px 的图标栏：收藏夹名一个都看不见，
   整理模式里「全选 / 完成」被挤成竖排，还会横向溢出。
   现在窄屏把它当抽屉：默认收起，左上角 ☰ 滑出，选完自动收回。
   ============================================================ */
function setLibSide(open) {
  const bar = $('libSidebar'), sc = $('libSideScrim');
  if (!bar) return;
  bar.classList.toggle('open', !!open);
  if (sc) sc.hidden = !open;
}
function libSideClose() { setLibSide(false); }

function bindSideDrawer() {
  const btn = $('libMenuBtn'), sc = $('libSideScrim'), bar = $('libSidebar');
  if (btn) btn.onclick = () => setLibSide(!(bar && bar.classList.contains('open')));
  if (sc) sc.onclick = libSideClose;
  if (!bar) return;
  // 选了分类 / 收藏夹就收起抽屉（大屏上 .open 不起作用，无副作用）
  bar.addEventListener('click', (e) => {
    if (e.target.closest('.nav-item') || e.target.closest('#importBtn')
      || e.target.closest('#importFolderBtn') || e.target.closest('#shareBtn')
      || e.target.closest('#backupBtn')) setTimeout(libSideClose, 0);
  });
  // 点书进阅读器也收起
  const lv = $('libraryView');
  if (lv) lv.addEventListener('click', (e) => { if (e.target.closest('.book-card')) libSideClose(); });
}

function bindLibrary() {
  $('importBtn').onclick = () => $('fileInput').click();
  bindSideDrawer();
  $('importFolderBtn').onclick = () => {
    // 安卓 WebView 不支持 webkitdirectory（选来的 File 没有 webkitRelativePath，
    // 甚至根本不弹选择器）。所以先告诉原生壳「这次要选目录」，由它走 SAF 目录选择器，
    // 把整棵树拷进书库根的 .import-inbox，再回调 window.__inkInbox 去读（见下面）。
    // 桌面浏览器没有这个桥，照旧用 <input webkitdirectory>。
    const A = window.InkAndroid;
    if (A && typeof A.setPickMode === 'function') {
      try { A.setPickMode('dir'); } catch (e) {}
    }
    $('folderInput').click();
  };
  $('folderInput').onchange = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    const entries = files.map(f => ({
      path: (f.webkitRelativePath || f.name).split('\\').join('/'),
      file: f
    }));
    await runFolderImport(entries);
  };
  installAndroidBridges();

  // 书籍操作菜单 / 输入弹窗 / 收藏夹
  $('bookMenuClose').onclick = () => { $('bookMenu').hidden = true; };
  $('inputCancel').onclick = () => closeInput(false);
  $('inputOk').onclick = () => closeInput(true);
  const choiceBox = $('choiceSheet');
  if (choiceBox) {
    $('choiceCancel').onclick = () => {
      choiceBox.hidden = true;
      const cw = $('choiceSearchWrap');          // R134：搜索条跟着收起来
      if (cw) { cw.hidden = true; const ci = $('choiceSearch'); if (ci) ci.value = ''; }
      const cc = choiceBox._cancel;               // R70：Promise 化的弹窗（askPick）靠它收尾
      choiceBox._cancel = null;
      choiceBox._cb = null;
      if (typeof cc === 'function') cc();
    };
  }
  $('inputField').onkeydown = e => {
    if (e.key === 'Enter') closeInput(true);
    if (e.key === 'Escape') closeInput(false);
  };
  $('collManageBtn').onclick = () => {
    Library.folderManage = !Library.folderManage;
    Library.folderSel.clear();
    Library.renderCollections();
    toast(Library.folderManage ? '整理模式：勾选后批量删除，或用 ↑/↓ 调整顺序' : '已退出整理');
  };
  $('addCollBtn').onclick = () => {
    // 在「文本小说 / 漫画 / PDF」分类里点 ＋，则建一个「本分类文件夹」，
    // 只收纳该分类的书，且带分类标签出现在收藏夹区（即「在各个分类直接新建文件夹」）。
    const scope = ['text', 'comic', 'pdf'].includes(Library.filter) ? Library.filter : null;
    const title = scope ? '新建文件夹（' + (FORMAT_LABEL[scope] || scope) + '）' : '新建收藏夹';
    showInput(title, '', async (v) => {
      if (!v || !v.trim()) return;
      await Library.addCollection(v.trim(), scope);
      toast(scope ? '已在本分类下创建文件夹' : '收藏夹已创建');
      Library.refresh();
    });
  };
  /* 卸载 App 与清除数据是两件不同的事，分开给入口：
     - 卸载应用：把墨阅本身从设备上移除（iPad 上是长按图标删除，Web 原型则是删掉站点/文件夹）
     - 清除数据：App 还在，只把书、笔记、设置这些本机数据清空 */
  /* ⚠ APK 里这两个入口点下去是 404：它们跳的是静态页 uninstall.html，
     而 APK 的 assets 只打 www 里被引用的文件，这页没打进去；即便打进去，
     「卸载应用」对安卓壳也没意义（卸载请长按桌面图标）。所以 App 内直接不显示，
     清除数据在 App 里有「设置 → 书库位置」和备份面板里的入口。Web 版保持原样。 */
  if (window.InkAndroid) {
    const ub = $('uninstallBtn');
    if (ub) { ub.hidden = true; ub.style.display = 'none'; }
  } else $('uninstallBtn').onclick = () => {
    showChoice('要卸载哪一个？', [
      '🗑 卸载应用（把墨阅从这台设备上移除）',
      '🧹 只清除数据（应用还在，删掉书与笔记）'
    ], -1, (i) => {
      // 走静态页 uninstall.html 而不是服务端路由 /uninstall ——
      // 托管到 GitHub Pages 这类纯静态空间时后者会 404，而清除 IndexedDB
      // 本来就全在浏览器里做得到，静态页一样能卸载干净
      if (i === 0) location.href = 'uninstall.html?mode=app';
      else if (i === 1) location.href = 'uninstall.html?mode=data';
    });
  };
  try { bindShare(); } catch (e) { console.error('bindShare 失败', e); }
  try { bindBackup(); } catch (e) { console.error('bindBackup 失败', e); }
  // 收藏夹：除了右侧 ⋯，还支持「右键」和「长按」打开管理菜单（iPad 上更自然）
  const sidebar = document.querySelector('.lib-sidebar');
  sidebar.addEventListener('contextmenu', e => {
    const btn = e.target.closest('.nav-item[data-filter^="coll:"]');
    if (!btn) return;
    e.preventDefault();
    Library.manageCollection(btn.dataset.filter.slice(5));
  });
  let pressTimer = null, pressMoved = false, pressX = 0, pressY = 0;
  sidebar.addEventListener('pointerdown', e => {
    const btn = e.target.closest('.nav-item[data-filter^="coll:"]');
    if (!btn || e.button === 2) return;
    pressMoved = false; pressX = e.clientX; pressY = e.clientY;
    pressTimer = setTimeout(() => {
      if (!pressMoved) Library.manageCollection(btn.dataset.filter.slice(5));
    }, 600);
  });
  // 手指按住时几乎不可能纹丝不动，1px 的抖动就取消长按会让人「怎么按都按不出来」。
  // 这里给 10px 的容差（苹果 HIG 的点击容差也是这个量级）。
  ['pointerup', 'pointercancel', 'pointermove'].forEach(ev =>
    sidebar.addEventListener(ev, (e) => {
      if (ev === 'pointermove') {
        const dx = Math.abs((e.clientX || 0) - pressX);
        const dy = Math.abs((e.clientY || 0) - pressY);
        if (dx > 10 || dy > 10) pressMoved = true;
        else return;      // 还在容差内，别取消
      }
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    }));

  // 侧栏筛选（含收藏夹，用事件委托以支持动态节点）
  sidebar.addEventListener('click', e => {
    const collMore = e.target.closest('.coll-more');
    if (collMore) { e.stopPropagation(); Library.manageCollection(collMore.dataset.coll); return; }
    const btn = e.target.closest('.nav-item');
    if (!btn) return;
    document.querySelectorAll('.lib-sidebar .nav-item').forEach(x => x.classList.remove('active'));
    btn.classList.add('active');
    // 侧栏一级分类/收藏夹 = 换个地方浏览，不算「进去一层」：清空返回历史
    Library.setRootView(btn.dataset.filter);
  });

  // 书库大屏：Esc = 返回上一级文件夹（与标题栏的「←」完全一致，不用去点）
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const lv = $('libraryView');
    if (!lv || !lv.classList.contains('active')) return;
    const ae = document.activeElement;
    if (ae && ['INPUT', 'TEXTAREA', 'SELECT'].includes(ae.tagName)) return;
    if (Library.filter && Library.filter.startsWith('coll:')) {
      Library.goUp();
      e.preventDefault();
    }
  });

  // 「没有匹配的书」里的清除按钮
  {
    const cf = $('libClearFilter');
    if (cf) cf.onclick = () => {
      Library.q = '';
      Library.clearTagFilter();
      const s = $('libSearch'); if (s) s.value = '';
      document.querySelectorAll('.lib-sidebar .nav-item').forEach(x =>
        x.classList.toggle('active', x.dataset.filter === 'all'));
      Library.setRootView('all');
    };
  }

  $('demoBtn').onclick = async () => {
    loading(true, '正在添加示例…');
    await addDemoBooks();
    await Library.refresh();
    loading(false);
    toast('已添加 2 本示例书');
  };
  $('fileInput').onchange = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    loading(true, '导入中…');
    Importer.lastRenamed = [];
    let backups = [];
    try {
      const books = await Importer.import(files, (p, m) => loading(true, m));
      backups = Importer.lastBackupZips || [];
      await Library.refresh();
      const failed = Importer.lastFailed || [];
      const nImg = (Importer.lastImageCount || 0);
      // 选的是「墨阅备份包」时 books/failed 都是空的，别报「没有导入成功」吓人，
      // 下面会直接转去恢复备份（R68）
      if (books.length || failed.length) {
        let msg = summarizeImport(books, failed);
        if (nImg) msg += `（${nImg} 张图片已按文件名顺序合成一本漫画）`;
        /* R133：重名的书入库时被自动加了序号，得当面说一句，
           不然用户只看到「我导入的叫《三体》怎么变成《三体（1）》了」。 */
        const renamed = Importer.lastRenamed || [];
        if (renamed.length) {
          const samp = renamed.slice(0, 2).map(r => `《${r.to}》`).join('、');
          msg += `；${renamed.length} 本与已有书重名，已改叫 ${samp}${renamed.length > 2 ? '…' : ''}`;
        }
        toast(msg, failed.length ? 9000 : 6000);
      }
      if (failed.length) console.warn('导入失败明细：', failed);
    } catch (err) {
      console.error(err);
      toast('导入失败：' + err.message);
    }
    loading(false);
    // R68：备份包被拖进了「导入书籍」——自动转成「恢复备份」，不再报
    // 「压缩包内没有可用内容」让用户以为备份坏了。一次只处理一份，避免连弹几个窗。
    // R72：恢复向导已改成一次问清「合并 / 每本另存 / 覆盖 / 取消」，两个入口（这里和
    // 设置里的「恢复备份」）看到的是同一套选项。
    if (backups.length > 1) {
      toast('一次只恢复一份备份：先处理《' + backups[0].name + '》，剩下的再单独拖一次', 9000);
    }
    for (const f of backups) {
      if (typeof bindBackup.restoreFile !== 'function') {
        toast('这是墨阅的备份文件，请到「设置 → 备份与恢复 → 恢复备份」里导入', 9000);
        break;
      }
      const r = await bindBackup.restoreFile(f);
      if (r) { await Library.refresh(); break; }
      break;
    }
  };

  /* 排序：档位 + 方向。两者都存进 Settings，重开还是上次那套。
     「收藏夹顺序一直不变」是因为以前收藏一律按手动 sortOrder 排（见 Library.render），
     现在收藏也认这些档，只多一档「手动」。 */
  if (Settings.libSort) Library.sort = Settings.libSort;
  Library.sortDir = Settings.libSortDir === -1 ? -1 : 1;
  const saveSort = () => {
    Settings.libSort = Library.sort;
    Settings.libSortDir = Library.sortDir;
    saveSettings();
  };
  document.querySelectorAll('#sortSeg .seg-btn').forEach(n => {
    n.onclick = () => {
      // 换档时把方向归位：每档的「自然方向」不一样（最近=新的在前、书名=A→Z），
      // 沿用上一档的翻转会变成「切到最近却是最旧的在前」，看着像坏了。
      if (Library.sort !== n.dataset.sort) Library.sortDir = 1;
      Library.sort = n.dataset.sort;
      saveSort();
      Library.render();
    };
  });
  const dirBtn = $('sortDirBtn');
  if (dirBtn) dirBtn.onclick = () => {
    Library.sortDir = Library.sortDir === -1 ? 1 : -1;
    saveSort();
    Library.render();
    toast(Library.sortDir === -1 ? '倒过来了：后面的排前面' : '回到默认方向');
  };
  $('searchInput').oninput = e => { Library.q = e.target.value.trim(); Library.render(); };

  /* ---------------- 标签编辑弹窗 + 标签筛选条 ---------------- */
  bindTagSheet();

  /* ---------------- 批量选择（全选 / 反选 / 移动 / 收藏 / 删除 / 共享） ---------------- */
  bindBulk();
}



/* 安卓原生壳的回调入口（Saf 目录 / 导出保存）。
   没有原生壳时这些函数不存在，等于没装，桌面端行为完全不变。 */
function installAndroidBridges() {
  // 目录已经拷到 .import-inbox/<dir>/ 下了 → 逐个小文件取回来当 File 用
  window.__inkInbox = async (dir) => {
    if (!dir) return;
    const enc = s => String(s).split('/').map(encodeURIComponent).join('/');
    const base = '/.import-inbox/' + enc(dir);
    try {
      loading(true, '读取文件夹…');
      const r = await fetch('/api/inbox/list?dir=' + encodeURIComponent(dir), { cache: 'no-store' });
      const j = await r.json().catch(() => null);
      if (!j || !j.ok) throw new Error((j && j.err) || '列目录失败');
      const entries = [];
      const miss = [];
      for (let i = 0; i < j.files.length; i++) {
        const p = j.files[i].p;
        const name = p.split('/').pop();
        if (i % 12 === 0) loading(true, '读取文件夹… ' + (i + 1) + '/' + j.files.length);
        const rr = await fetch(base + '/' + enc(p), { cache: 'no-store' });
        if (!rr.ok) { miss.push(name); continue; }
        const blob = await rr.blob();
        entries.push({ path: p, file: new File([blob], name, { type: blob.type || '' }) });
      }
      if (!entries.length) {
        toast('文件夹里的文件读不出来' + (miss.length ? '（' + miss.slice(0, 2).join('、') + '）' : ''), 9000);
        return;
      }
      await runFolderImport(entries, miss);
    } catch (err) {
      console.error(err);
      toast('读取文件夹失败：' + (err && err.message ? err.message : err), 9000);
    } finally {
      loading(false);
      fetch('/api/inbox/drop?dir=' + encodeURIComponent(dir)).catch(() => {});
    }
  };
  window.__inkInboxFail = (msg) => {
    loading(false);
    toast('导入文件夹失败：' + (msg || '未知原因'), 10000);
  };
  window.__inkInboxCancel = () => { loading(false); };
}

/* entries: [{ path, file }]，path 形如「我的漫画/ch1/01.jpg」 */
async function runFolderImport(entries, extraMiss) {
  if (!entries || !entries.length) return;
  loading(true, '导入文件夹中…');
  try {
    const { books, failed, groups } = await Importer.importEntries(entries, (p, m) => loading(true, m));
    if (extraMiss && extraMiss.length) {
      failed.push('有 ' + extraMiss.length + ' 个文件没读回来：' + extraMiss.slice(0, 2).join('、'));
    }
    // 按子文件夹自动建收藏夹并归类。group 键形如「MyBooks」或「MyBooks/folderA/folderB」（嵌套），
    // 按层级逐级建嵌套收藏夹：选 MyBooks/ 导入时，根目录书 →「MyBooks」，MyBooks/sub/ 里的书 →「MyBooks ▸ sub」，
    // 父文件夹本身也会成为一个收藏夹（修 #16：无法导入父文件夹；#10 嵌套分组延续）。
    const made = [];
    const seenName = new Set();
    if (groups && Object.keys(groups).length) {
      for (const name of Object.keys(groups)) {
        const ids = groups[name];
        if (!ids || !ids.length) continue;
        // 逐级建嵌套收藏夹，返回最里层
        const parts = name.split('/').filter(Boolean);
        let parentId = null, leaf = null;
        for (const p of parts) {
          let c = (Library.collections || []).find(x => x.name === p && (x.parent || null) === (parentId || null));
          if (!c) c = await Library.addCollection(p, null, parentId);
          leaf = c; parentId = c.id;
        }
        made.push(leaf.name); seenName.add(name);
        for (const id of ids) await Library.moveTo(id, leaf.id);
      }
    }
    await Library.refresh();
    if (!books.length) {
      // 以前只弹「请看看失败原因」，而原因只打在控制台 —— 用户根本看不到。
      // 现在把前几条原因直接写进提示；完整清单仍在控制台。
      const why = (failed || []).map(f => {
        const i = f.indexOf('：');
        return i >= 0 ? f.slice(i + 1) : f;
      }).filter(Boolean);
      if (why.length) {
        const head = why.slice(0, 2).join('；');
        toast('没有导入成功：' + head + (why.length > 2 ? `　（共 ${why.length} 个文件不认）` : ''), 10000);
      } else {
        toast('这个文件夹里没找到能读的书。支持：TXT / MD / EPUB / DOCX / PDF / HTML / 图片 / ZIP', 9000);
      }
    } else {
      let msg = summarizeImport(books, failed);
      if (seenName.size) msg += `；已按子文件夹建 ${seenName.size} 个（嵌套）收藏夹（${made.join('、')}）`;
      toast(msg, failed.length ? 9000 : 6000);
    }
    if (failed.length) console.warn('导入失败明细：', failed);
  } catch (err) {
    console.error(err);
    toast('导入失败：' + err.message);
  }
  loading(false);
}


function bindTagSheet() {
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };

  // 标签输入框：回车 / 逗号添加
  const inp = $('tagInput');
  if (inp) inp.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = inp.value.trim().replace(/,+$/, '').trim();
      if (!v) return;
      if (Library._tagEdit) { Library._tagEdit.set.add(v); Library.renderTagChips(); }
      inp.value = '';
    } else if (e.key === 'Escape') {
      $('tagSheet').hidden = true; Library._tagEdit = null;
    }
  };
  // 输入时实时过滤「已有标签」建议（空输入则显示全部已有标签）
  if (inp) inp.oninput = (e) => { if (Library._tagEdit) Library.renderTagSuggestions(e.target.value); };

  // 「已有标签」建议：点选即加入当前工作集
  const suggest = $('tagSuggest');
  if (suggest) suggest.onclick = (e) => {
    const s = e.target.closest('.tag-sug');
    if (s && Library._tagEdit) {
      Library._tagEdit.set.add(s.dataset.tag);
      Library.renderTagChips();
      if (inp) { inp.value = ''; inp.focus(); }
    }
  };

  // 编辑器里的标签芯片：点 × 移除
  const chips = $('tagChips');
  if (chips) chips.onclick = (e) => {
    const x = e.target.closest('.tag-x');
    if (x && Library._tagEdit) {
      Library._tagEdit.set.delete(x.dataset.tag);
      Library.renderTagChips();
    }
  };

  on('tagDone', () => Library.applyTagEdit());
  on('tagCancel', () => { $('tagSheet').hidden = true; Library._tagEdit = null; });
  on('tagSheetClose', () => { $('tagSheet').hidden = true; Library._tagEdit = null; });

  // 书架顶部标签筛选条：点标签切换筛选，点「清除」取消全部
  const bar = $('tagBar');
  if (bar) bar.onclick = (e) => {
    const clr = e.target.closest('#tagClear');
    if (clr) { Library.clearTagFilter(); Library.render(); return; }
    const mode = e.target.closest('#tagModeBtn');
    if (mode) {
      Library.tagMode = mode.dataset.tagmode;
      Library.render();
      toast(Library.tagMode === 'and' ? '标签筛选：且（AND，必须同时含全部所选标签）'
                                       : '标签筛选：或（OR，命中任一标签即显示）');
      return;
    }
    const c = e.target.closest('.tag-chip');
    if (c) Library.toggleTagFilter(c.dataset.tag);
  };
}

function bindBulk() {
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on('selectBtn', () => Library.setSelectMode(!Library.selectMode));
  on('bulkAllToggle', () => {
    const L = Library;
    if (L.visibleIds.length && L.selected.size === L.visibleIds.length) L.selectNone();
    else L.selectAll();
  });
  on('bulkInvert', () => Library.selectInvert());
  on('bulkMove', () => Library.bulkMove());
  on('bulkMerge', () => Library.bulkMerge());
  on('bulkFav', () => Library.bulkFav());
  on('bulkTag', () => Library.bulkTag());
  on('bulkTop', () => Library.bulkTop());
  on('bulkUp', () => Library.bulkUp());
  on('bulkDown', () => Library.bulkDown());
  on('bulkShare', () => Library.shareSelected());
  on('bulkBackup', () => {
    const ids = Library.selectedBooks().map(b => b.id);
    if (!ids.length) { toast('还没选书'); return; }
    if (typeof bindBackup === 'function' && bindBackup.open) bindBackup.open(ids);
    else toast('备份面板没加载起来');
  });
  on('bulkDel', () => Library.bulkDelete());
  on('bulkExit', () => Library.setSelectMode(false));

  /* 漫画页面管理（排序 / 拆分 / 删页） */
  const pg = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  const pm = () => Library._pm.book;
  pg('pageSheetClose', () => { $('pageSheet').hidden = true; });
  pg('pgSortName', () => { if (pm()) Library.pageSortByName(); });
  pg('pgReverse', () => { if (pm()) Library.pageReverse(); });
  pg('pgAll', () => { if (pm()) Library.pageAll(); });
  pg('pgNone', () => { if (pm()) Library.pageNone(); });
  pg('pgSplit', () => { if (pm()) Library.pageSplit(); });
  pg('pgDelete', () => {
    if (!pm()) return;
    const idxs = Array.from(Library._pm.sel);
    if (!idxs.length) { toast('先勾选要删的页'); return; }
    Library.pageDelete(idxs);
  });
}

/* ============================================================
   阅读器事件
   ============================================================ */
/* 中间区的「单击 / 双击」判定计时器（见 bindReader 里的点击区逻辑） */
let _centerTapTimer = null;

function bindReader() {
  initSwipe();          // 手指左右/上下划动翻页
  $('closeBtn').onclick = closeBook;
  // R131（第 9 条）：右→左模式下图标的语义和动作一起换 —— 左边那个变成「往后一页」，
  // 右边那个才是「往前一页」，跟手势 / 目录 / 滑条的镜像保持一致。
  $('prevBtn').onclick = () => {
    if (typeof chromeRtlMirror === 'function' && chromeRtlMirror()) nextPage();
    else prevPage();
  };
  $('nextBtn').onclick = () => {
    if (typeof chromeRtlMirror === 'function' && chromeRtlMirror()) prevPage();
    else nextPage();
  };

  // PDF 缩放 / 适应屏幕
  const zOut = $('pdfZoomOut'), zIn = $('pdfZoomIn'), zFit = $('pdfZoomFit');
  if (zOut) zOut.onclick = () => pdfZoomBy(-0.25);
  if (zIn) zIn.onclick = () => pdfZoomBy(0.25);
  if (zFit) zFit.onclick = pdfZoomFit;
  // 显示 / 隐藏 PDF 文字层：文字层平时是透明的（不挡画布），用户「看不出到底认出来没有」，
  // 这个开关把 span 显示成半透明白底+深色字，一眼能核对。
  // ⚠️ R53 起它和 OCR 抽屉里的「显示识别出的文字」是**同一个开关**：
  //    之前 A 只管数字版层，扫描版整页都是 OCR 层 → 用户点 A 毫无反应，
  //    反馈「这个 A 的功能没有了」；现在两边一起管、状态同步。
  const zText = $('pdfTextToggle');
  if (zText) zText.onclick = () => setTextLayer(!R._showTextLayer);
  // 图片书（漫画）也补一个 A：识别完文字层默认是透明的，用户「看不到任何结果」，
  // 以为没认出来。R125 加这颗按钮，和 PDF 那颗共用一个开关状态。
  const cText = $('comicTextToggle');
  if (cText) cText.onclick = () => setTextLayer(!R._showTextLayer);

  // 漫画缩放 / 适应（与 PDF 控件一一对应；step 0.1，边界 0.3~3 在 setComicZoom 内强制）
  // txt 模式复用同一组控件，但「缩放」= 调整字号（字体随缩放同步变化）
  const cOut = $('comicZoomOut'), cIn = $('comicZoomIn'), cFit = $('comicZoomFit');
  // txt / 富文本：缩放控件=调字号；漫画：=图片缩放
  if (cOut) cOut.onclick = () => { if (R.format === 'txt' || R.format === 'html') txtZoomBy(-1); else comicZoomBy(-0.1); };
  if (cIn) cIn.onclick = () => { if (R.format === 'txt' || R.format === 'html') txtZoomBy(1); else comicZoomBy(0.1); };
  if (cFit) cFit.onclick = () => { if (R.format === 'txt' || R.format === 'html') txtZoomFit(); else comicZoomFit(); };

  // 点击区域翻页（不再用遮挡层，避免挡住文本选择）
  $('readerContent').addEventListener('click', e => {
    if (R.penMode) return;
    // 点到浮层控件（缩放按钮等）不要翻页：否则右下角的「适应 ±」正好落在右侧 22% 触发区，
    // 一点 ± 就顺带 nextPage()，表现为"调缩放自动跳下一页"。
    if (e.target.closest && e.target.closest('button, input, textarea, a, .pdf-zoom-ctl, .comicZoomCtl, .bar, .drawer, .sheet, .ink-canvas, #selPopover, .pdf-text-layer')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;                 // 正在选词，不翻页

    // 点已有标记 → 一次列出该位置的所有标记（不再逐层点）；
    // 拿不到 id 时退化为「整段」，避免误判成翻页
    const span = e.target.closest ? e.target.closest('.mk') : null;
    if (span) {
      const ref = span.dataset.id ? R.annots.find(a => a.id === span.dataset.id) : null;
      const p = span.closest('p[data-off]');
      const off = ref ? ref.start : (p ? parseInt(p.dataset.off, 10) : 0);
      openMarkInspector(off);
      return;
    }
    if (e.target.closest && e.target.closest('#inkCanvas')) return;

    const rect = $('readerContent').getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    // 漫画右→左（日漫）模式：点击区左右反过来——右点=上一页（页数减少）、
    // 左点=下一页（页数增加），与「物理书从右往左翻」的手感一致；左→右模式保持原样。
    // （滑动方向的反转在 initSwipe 里处理，这里只管点击区。）
    const rtlTap = (R.format === 'comic' && Settings.comicRTL && !comicScrollOn());
    if (ratio < 0.22) (rtlTap ? nextPage() : prevPage());
    else if (ratio > 0.78) (rtlTap ? prevPage() : nextPage());
    else {
      /* 中间区：单击 = 切换，双击 = 一定唤出。
         小屏上「单击切换」很容易被当成「点了没反应」——刚唤出来又点一下就收回去，
         用户不知道自己在切换。所以第二次点击（260ms 内）改成强制显示。 */
      if (_centerTapTimer) {
        clearTimeout(_centerTapTimer); _centerTapTimer = null;
        showBars(true); resetBarTimer();
      } else {
        _centerTapTimer = setTimeout(() => { _centerTapTimer = null; toggleBars(); }, 260);
      }
    }
  });

  // HTML 书内链接：拦截点击，避免跳到相对 URL 触发 404（#194）
  const _scrollInner = document.getElementById('scrollInner');
  if (_scrollInner) _scrollInner.addEventListener('click', (e) => {
    if (R.penMode) return;
    const a = e.target.closest && e.target.closest('a');
    if (!a) return;
    const href = (a.getAttribute('href') || '').trim();
    if (!href || href === '#') { e.preventDefault(); return; }
    // 书内锚点：相对路径 + #fragment（如 ../Text/ch2.xhtml#sec1）或纯 #sec1。
    // html 书整本已拼进 #scrollInner，所有锚点都在同一 DOM，提取 #fragment 即可定位（修 #194/#2）。
    const hashIdx = href.indexOf('#');
    if (hashIdx >= 0) {
      e.preventDefault();
      htmlScrollToAnchor(href.slice(hashIdx + 1));
      return;
    }
    if (/^(https?:|mailto:|tel:)/i.test(href)) {
      e.preventDefault();
      try { window.open(href, '_blank', 'noopener'); } catch (err) { location.href = href; }
      return;
    }
    e.preventDefault();
    toast('本书内的「' + href + '」当前无法跳转（跨章节相对链接暂未支持）');
  });

  // 收藏（阅读器顶栏）
  $('favBtn').onclick = async () => {
    if (!R.book) return;
    const b = await Library.toggleFav(R.book.id);
    if (b) { R.book.fav = b.fav; updateFavBtn(); }
  };

  // 进度条
  $('progressSlider').oninput = e => {
    let v = parseFloat(e.target.value) / 100;
    // R131（第 9 条）：右→左模式下滑条是镜像的（100 = 第 1 页），这里要反算回真实进度
    if (typeof chromeRtlMirror === 'function' && chromeRtlMirror()) v = 1 - v;
    v = Math.min(1, Math.max(0, v));
    // 富文本滚动模式（整篇连续滚动）与文字书竖向卷轴：按滚动百分比定位
    if ((R.format === 'txt' && Settings.direction === 'vertical') || (R.format === 'html' && !Settings.htmlPaged)) {
      const el = $('scrollLayer');
      el.scrollTop = v * (el.scrollHeight - el.clientHeight);
    } else {
      goToPage(Math.round(v * (R.totalPages - 1)), true);
    }
  };

  $('dirBtn').onclick = () => {
    // 漫画：左→右 → 右→左 → 上→下 循环；文字书：左右分页 ⇄ 上下滚动
    if (R.format === 'comic') {
      const order = ['ltr', 'rtl', 'ttb'];
      const next = order[(order.indexOf(comicDir()) + 1) % order.length];
      setComicDir(next);
      return;
    }
    switchMode(Settings.direction === 'horizontal' ? 'vertical' : 'horizontal');
    toast(Settings.direction === 'horizontal' ? '已切换为左右翻页' : '已切换为上下滚动');
  };

  // 点页码直接跳页（滑块拖动太粗，找某一页时还是输数字快）
  const pl = $('pageLabel');
  pl.title = '点一下可输入页码跳转';
  pl.onclick = () => {
    if (!R.book || !R.totalPages) return;
    showInput(`跳到第几页（1 – ${R.totalPages}）`, String(R.pageIndex + 1), (v) => {
      const n = parseInt((v || '').trim(), 10);
      if (!n || n < 1 || n > R.totalPages) {
        toast(`页码要在 1 到 ${R.totalPages} 之间`);
        return;
      }
      goToPage(n - 1);
      toast('已跳到第 ' + n + ' 页');
    }, { numeric: true });
  };

  // 分页 ⇄ 连续卷轴（条漫）。长图看不完时切一下就能一页接一页往下滚
  const cmb = $('comicModeBtn');
  if (cmb) cmb.onclick = () => {
    if (R.format !== 'comic') { toast('这个开关只对漫画 / 图片书有效'); return; }
    Settings.comicMode = (Settings.comicMode === 'scroll') ? 'paged' : 'scroll';
    saveSettings(); buildSettingsPanel();
    renderPage(); updateChrome(); refreshInk();
    toast(Settings.comicMode === 'scroll'
      ? '连续卷轴：手指往上划，一页接一页'
      : '分页：一屏一页，左右划翻页');
  };

  // 富文本：翻页 / 滚动 切换（#12）
  const hmb = $('htmlModeBtn');
  if (hmb) hmb.onclick = () => {
    if (R.format !== 'html') { toast('这个开关只对富文本（html/epub）书有效'); return; }
    // 切换前记下「当前视口顶部的字符偏移」。以前记的是滚动百分比 / 页码比例，
    // 但一屏一页是按固定屏高切的，页码与内容长度不成正比 —— 拿百分比互相换算
    // 就是用户遇到的「切换翻页/卷轴后跑到别的地方」。
    const keepOff = htmlCurrentOffset();
    Settings.htmlPaged = !Settings.htmlPaged;
    saveSettings();
    // 重新分页 / 恢复整篇滚动，并按字符偏移回到原处（修 #6：之前总是跳到最开头）
    renderHtmlPage();
    requestAnimationFrame(() => {
      if (keepOff > 0) htmlScrollToOffset(keepOff);
      else {
        const el = $('scrollLayer');
        if (el) el.scrollTop = 0;
      }
      R.book.htmlOff = keepOff;
      scheduleSave();
    });
    updateChrome(); refreshInk();
    toast(Settings.htmlPaged ? '翻页模式：一屏一页，左右划翻页' : '滚动模式：整篇连续滚动');
  };

  $('autoBtn').onclick = toggleAuto;
  $('speedSlider').oninput = e => {
    Settings.autoSpeed = parseInt(e.target.value);
    $('speedVal').textContent = Settings.autoSpeed + 's';
    saveSettings();
    if (R.autoTimer) startAuto();
  };
  $('speedVal').textContent = Settings.autoSpeed + 's';
  $('speedSlider').value = Settings.autoSpeed;

  // 抽屉
  $('tocBtn').onclick = async () => {
    // 打开目录抽屉时若目录为空（或结构损坏），静默补识别一次，根治「目录空白」。
    // 覆盖所有内容类格式（html/txt/epub/docx）与 PDF；用户主动清空（tocCleared）则尊重、不强行重识别。
    if (R.book && !R.book.tocCleared && (!R.chapters || !R.chapters.length)) {
      await reDetectChapters(true);
    }
    renderTocList(); openDrawer('tocDrawer');
  };
  $('markBtn').onclick = () => { renderMarkList(); openDrawer('markDrawer'); };
  $('noteListBtn').onclick = () => { renderNoteList(); openDrawer('noteDrawer'); };
  $('settingsBtn').onclick = () => { buildSettingsPanel(); openDrawer('settingsDrawer'); };
  $('scrim').onclick = closeDrawers;
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = closeDrawers);

  // 搜索
  $('searchBookBtn').onclick = () => {
    $('searchBar').hidden = false;
    $('bookSearchInput').placeholder = R.format === 'pdf'
      ? '在全文中搜索（按页定位）'
      : (R.format === 'comic' ? '漫画没有文字，请用页码跳转' : '在本书中搜索');
    $('bookSearchInput').focus();
  };
  $('searchDone').onclick = () => {
    $('searchBar').hidden = true;
    R.searchHits = []; R._searchLen = 0; R._searchKind = 'offset';
    refreshPageContent();
  };
  $('bookSearchInput').oninput = e => doSearch(e.target.value.trim());
  $('searchPrev').onclick = () => gotoSearchHit(-1);
  $('searchNext').onclick = () => gotoSearchHit(1);

  // 划词
  // ⚠️ 浮层自身的点击（换颜色 / 点样式按钮）不能当作「重新划词」：
  //   之前这里无差别跑 handleSelection，而点浮层按钮会让正文选区折叠（isCollapsed）→
  //   handleSelection 直接 hideSelPopover()，用户实测「再划词时后点颜色就把高光窗口关了」。
  //   现在：目标在浮层内 → 完全跳过；mousedown 也 preventDefault，尽量把选区保住。
  document.addEventListener('mouseup', (e) => {
    if (e.target && e.target.closest && e.target.closest('#selPopover')) return;
    setTimeout(handleSelection, 10);
  });
  document.addEventListener('touchend', (e) => {
    if (e.target && e.target.closest && e.target.closest('#selPopover')) return;
    setTimeout(handleSelection, 260);
  });
  // 浮层内按下鼠标不让浏览器折叠选区（Chrome 在 button 上 mousedown 会把 selection 收掉）
  $('selPopover').addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  document.addEventListener('selectionchange', () => {
    const s = window.getSelection();
    if (!s || s.isCollapsed) { hideSelPopover(); return; }
    // iPad / 触屏：长按选词后系统还要拉选择手柄，touchend 的 260ms 常常早于「选区定型」，
    // 浮层就再也不出现（用户实测「划不了」）。这里补一个防抖兜底：选区稳定 450ms 后再弹一次。
    if (window._selPopTimer) clearTimeout(window._selPopTimer);
    window._selPopTimer = setTimeout(() => {
      window._selPopTimer = null;
      const cur = window.getSelection();
      if (!cur || cur.isCollapsed) return;
      const pop = $('selPopover');
      // ⚠️ 只有「选区没变」才能直接 return。之前只要浮层开着就 return，
      // 于是「刚高亮完一处、马上再划另一处」时 _range 一直是第一处的偏移，
      // 第二次及以后的标记全部叠到同一段文字上（用户实测：多个标记不能共存）。
      if (pop && !pop.hidden && pop._range) {
        try {
          const rg = cur.getRangeAt(0);
          const s0 = globalOffsetOf(rg.startContainer, rg.startOffset);
          const e0 = globalOffsetOf(rg.endContainer, rg.endOffset);
          if (s0 === pop._range.s && e0 === pop._range.e) return;   // 同一选区：已弹着，别重复
        } catch (err) { /* 跨容器等异常 → 照样刷新 */ }
      }
      handleSelection();
    }, 450);
  });
  $('selPopover').onclick = e => {
    const btn = e.target.closest('[data-act]');
    const act = btn ? btn.dataset.act : e.target.dataset.act;
    if (!act) return;
    if (act === 'highlight' || act === 'mark') {
      // PDF 高光由 paintPdfHighlights 在文字层上着色；富文本/HTML 由 buildHTML 的 decorate 着色；
      // 均按选区偏移锚定，不再拦截（修 #12：PDF/富文本也能划词高光）。
      addHighlight(window._hlColor || HL_COLORS[0], btn ? btn.dataset.style : 'highlight');
    }
    else if (act === 'note') {
      // 从「区域标记编辑器」打开的浮层：笔记写到这片区域已有的那条标记上，
      // 不再新建一条（否则同一片文字上会叠出多条几乎一样的标注）。
      const pop = $('selPopover');
      const id = pop && pop._markId;
      const ann = id ? (R.annots || []).find(a => a.id === id) : null;
      openNoteComposer(ann || null);
    }
    else if (act === 'clearmark') clearMarkRegion();
    else if (act === 'dict') lookupWord();
    else if (act === 'translate') selTranslate();
    else if (act === 'system') systemTextAction();
    else if (act === 'search') searchWeb();
    else if (act === 'edit') beginEditText();
    else if (act === 'undo') undoTextEdit();
    else if (act === 'copy') {
      const r = $('selPopover')._range;
      navigator.clipboard?.writeText(r ? r.text : '');
      hideSelPopover();
      toast('已复制');
    }
  };

  /* R159：系统翻译 —— 手机上别绕开系统自带的翻译 / 词典。
     APK：走 Android 的 ACTION_PROCESS_TEXT（就是长按文字时系统菜单里的「翻译 / 词典」），
          没有再退到「分享」，百度翻译、微信、浏览器都在分享列表里。
     iPad / 手机浏览器：走系统分享面板（iOS 17 的「翻译」在里面）。
     桌面浏览器没有这套入口，按钮不显示。 */
  function systemTextAction() {
    const pop = $('selPopover');
    const r = pop && pop._range;
    const text = r && r.text ? String(r.text).trim() : '';
    if (!text) { toast('没有选中文字'); return; }
    const A = window.InkAndroid;
    if (A && typeof A.systemTextAction === 'function') {
      hideSelPopover();
      try { A.systemTextAction(text); } catch (e) { toast('打不开系统翻译：' + e); }
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.share) {
      hideSelPopover();
      try { navigator.share({ text: text }).catch(() => { }); } catch (e) { }
      return;
    }
    toast('这台设备没有系统翻译入口');
  }
  // 有系统入口才长这个按钮（桌面浏览器上它不该出现：
  // 桌面 Chrome 其实也有 navigator.share，但分享面板里没有「翻译」这一项）
  (function showSystemBtn() {
    const b = $('selSystemBtn');
    if (!b) return;
    const A = window.InkAndroid;
    const canNative = !!(A && typeof A.systemTextAction === 'function');
    const ua = String((typeof navigator !== 'undefined' && navigator.userAgent) || '');
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua)
      || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));  // iPadOS 伪装成 Mac
    const canShare = mobile && typeof navigator !== 'undefined' && !!navigator.share;
    b.hidden = !(canNative || canShare);
    if (!canNative && canShare) b.textContent = '系统分享';
    b.title = canNative
      ? '交给手机/平板的系统翻译、词典或分享（不用墨阅的引擎）'
      : '用系统分享面板发给翻译类 App';
  })();

  // 选区弹层「点别处即取消」（修 #17：PDF/文本选区弹层之前只能靠折叠选区间接收起，
  // 点空白区往往收不掉）。点弹层外、且不在当前选区上的位置 → 关弹层并清空选区。
  const dismissSel = (e) => {
    const pop = $('selPopover');
    if (!pop || pop.hidden) return;
    if (pop.contains(e.target)) return;                 // 点在弹层按钮上不关
    const s = window.getSelection && window.getSelection();
    if (s && !s.isCollapsed && s.rangeCount) {           // 点在当前选区上 → 允许调整选区，不关
      let n = e.target; if (n && n.nodeType === 3) n = n.parentElement;
      try { if (n && s.getRangeAt(0).intersectsNode(n)) return; } catch (_) {}
    }
    R._keepPop = false;
    hideSelPopover();
    if (s && !s.isCollapsed) s.removeAllRanges();
  };
  ['pdfLayer', 'scrollLayer', 'htmlPage', 'pageText', 'scrollInner'].forEach(id => {
    const el = $(id); if (el) el.addEventListener('click', dismissSel);
  });
  // 滚动时弹层位置会错位，顺手收起
  ['pdfLayer', 'scrollLayer', 'htmlPage'].forEach(id => {
    const el = $(id); if (el) el.addEventListener('scroll', () => { if ($('selPopover') && !$('selPopover').hidden) hideSelPopover(); }, { passive: true });
  });

  // 笔记 sheet
  // 「取消 / 完成」是同一个按钮，文案随状态变（见 bindNoteSheet）；
  // 完成时若输入框还有没存的改动，finishNoteSheet 会先补存一次。
  $('noteCancel').onclick = () => {
    if (typeof finishNoteSheet === 'function') finishNoteSheet();
    else $('noteSheet').hidden = true;
  };
  $('noteSave').onclick = saveNote;
  $('markSheetClose').onclick = () => { $('markSheet').hidden = true; };
  $('transClose').onclick = () => { $('translateSheet').hidden = true; };

  // 鼠标移动唤出工具栏（桌面/iPad 触控板）
  $('readerContent').addEventListener('mousemove', () => {
    if (!R.barsVisible) showBars(true);
    resetBarTimer();
  });

  // 滚动上报
  $('scrollLayer').addEventListener('scroll', () => {
    clearTimeout(R._scrollT);
    R._scrollT = setTimeout(() => {
      if (R.format === 'html') reportHtmlScroll();
      else reportScroll();
    }, 90);
    // 富文本手写笔迹随滚动重绘（按页面盒归一化，live scrollTop 定位）；txt 竖向卷轴同理
    if (R.format === 'html') ink.setScrollTop($('scrollLayer').scrollTop);
    else if (R.format === 'txt' && Settings.direction === 'vertical') ink.setScrollTop($('scrollLayer').scrollTop);
  });
  // PDF 单页可能超出一屏：滚动时让笔迹同步跟随（按文档坐标重绘）
  const pdfLayer = $('pdfLayer');
  if (pdfLayer) pdfLayer.addEventListener('scroll', () => {
    clearTimeout(R._pdfScrollT);
    R._pdfScrollT = setTimeout(() => { if (R.format === 'pdf') ink.setScrollTop(pdfLayer.scrollTop); }, 60);
  });

  // 键盘（iPad 外接键盘）
  document.addEventListener('keydown', e => {
    if ($('readerView').classList.contains('active') === false) return;
    if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
      if (e.key === 'Escape') { document.activeElement.blur(); }
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { nextPage(); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { prevPage(); e.preventDefault(); }
    else if (e.key === ' ') { toggleAuto(); e.preventDefault(); }
    else if (e.key === 'Escape') {
      // #17：手写/勾画进行中按 Esc 取消当前这一笔（不落库），先于此关抽屉等
      if (R.penMode && typeof ink !== 'undefined' && ink && ink.current) {
        ink.cancelStroke(); e.preventDefault(); return;
      }
      if (!$('noteSheet').hidden) $('noteSheet').hidden = true;
      else if (document.querySelector('.drawer.show')) closeDrawers();
      else closeBook();
    }
    else if (e.key.toLowerCase() === 'b') toggleBookmark();
    else if (e.key.toLowerCase() === 'p') togglePen();
  });

  window.addEventListener('resize', () => {
    clearTimeout(window._rz);
    window._rz = setTimeout(() => {
      if (!R.book) return;
      /* R170：旋屏 / 拖窗后阅读区宽度变了，边距上限要跟着重算
         （否则横屏算出的 150px 带到竖屏，正文只剩一条缝）。 */
      if (typeof applyReaderMetrics === 'function') applyReaderMetrics();
      if (R.format === 'txt') {
        R._layoutSig = ''; relayout();
        if (Settings.direction === 'vertical') { renderScrollContent(); scrollToOffset(parseInt(R.book.locator || 0)); }
        else goToPage(R.pageIndex, true);
      }
      if (R.format === 'pdf') renderPdfPage(R.pageIndex + 1);
      ink.resize(); refreshInk();
    }, 260);
  });
}

/* ============================================================
   播读（TTS）
   ============================================================ */
function bindTTS() {
  $('ttsBtn').onclick = () => {
    if (!TTS.supported) { toast('当前浏览器不支持播读（需 Edge / Chrome / Safari）'); return; }
    TTS.active ? TTS.stop() : TTS.start();
  };
  $('ttsPlayBtn').onclick = () => TTS.toggle();
  $('ttsStopBtn').onclick = () => TTS.stop();
  $('ttsRate').oninput = e => TTS.setRate(e.target.value);
  $('ttsVoice').onchange = e => TTS.setVoice(e.target.value);

  // 恢复上次的语速与音色
  TTS.rate = Settings.ttsRate || 1;
  TTS.voiceURI = Settings.ttsVoice || '';
  const setUI = () => {
    $('ttsRate').value = TTS.rate;
    $('ttsRateVal').textContent = TTS.rate.toFixed(1) + '×';
    TTS.fillVoiceSelect();
  };
  setUI();
  // 声音列表在部分浏览器是异步加载的
  if ('speechSynthesis' in window) {
    speechSynthesis.onvoiceschanged = () => { TTS.loadVoices(); TTS.fillVoiceSelect(); };
    setTimeout(() => { TTS.loadVoices(); TTS.fillVoiceSelect(); }, 300);
  }
}

/* ============================================================
   手写
   ============================================================ */
function bindPen() {
  $('penBtn').onclick = togglePen;
  $('ocrBtn').onclick = () => { if (typeof openOcrDrawer === 'function') openOcrDrawer(); };
  document.querySelectorAll('#penTools .pen-tool').forEach(b => {
    if (!b.dataset.tool) return;                 // 「删除选中」等按钮没有 data-tool，别当工具切
    b.onclick = () => {
      document.querySelectorAll('#penTools .pen-tool').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      ink.tool = b.dataset.tool;
      // R88：离开框选工具就把选择取消掉，免得涂画时还挂着一圈虚线框
      if (ink.tool !== 'select') ink.clearSelection();
      else toast('框选：拖一个框圈住字迹，然后框内拖动移动 / 拖四角缩放 / 点颜色换色 / 按 Delete 删除');
      syncInkDelBtn();
    };
  });
  const colors = $('penColors');
  colors.innerHTML = INK_COLORS.map((c, i) =>
    `<div class="color-dot-sm${i === 0 ? ' sel' : ''}" style="background:${c};${c === '#FFFFFF' ? 'border:1px solid #CCC' : ''}" data-c="${c}"></div>`
  ).join('');
  colors.querySelectorAll('.color-dot-sm').forEach(d => {
    d.onclick = () => {
      colors.querySelectorAll('.color-dot-sm').forEach(x => x.classList.remove('sel'));
      d.classList.add('sel');
      ink.color = d.dataset.c;
      // R88：框选状态下点颜色 = 给选中的笔迹换色
      if (ink.tool === 'select' && ink.sel && ink.sel.size) ink.setSelectionColor(d.dataset.c);
    };
  });
  $('penWidth').oninput = e => { ink.width = parseInt(e.target.value); };
  // R88：框选状态下拖完粗细滑杆（松手才写库，别在拖动中反复落盘）= 改选中笔迹的粗细
  $('penWidth').onchange = () => {
    if (ink.tool === 'select' && ink.sel && ink.sel.size) ink.setSelectionWidth(ink.width);
  };
  $('undoBtn').onclick = () => ink.undo();
  $('clearInkBtn').onclick = () => { if (confirm('清空本页手写字迹？')) ink.clear(); };
  // R89：框选后「删除选中」。选中状态没有回调，就在指针抬起 / 工具切换时同步按钮显隐。
  const delBtn = $('inkDelBtn');
  if (delBtn) delBtn.onclick = () => { const n = ink.deleteSelection(); syncInkDelBtn(); if (n) toast('已删除 ' + n + ' 笔字迹'); };
  ink.canvas.addEventListener('pointerup', () => setTimeout(syncInkDelBtn, 0));
  document.addEventListener('keydown', e => {
    if (!R.penMode || ink.tool !== 'select') return;
    if (!ink.sel || !ink.sel.size) return;
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '') || t.isContentEditable)) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const n = ink.deleteSelection();
      syncInkDelBtn();
      if (n) toast('已删除 ' + n + ' 笔字迹');
    }
  });
  $('penDoneBtn').onclick = () => togglePen(false);
}

function togglePen(force) {
  R.penMode = force !== undefined ? force : !R.penMode;
  ink.setEnabled(R.penMode);
  $('penBar').hidden = !R.penMode;
  document.getElementById('tapZones').classList.toggle('disabled', R.penMode);
  $('penBtn').classList.toggle('on', R.penMode);
  if (R.penMode) { showBars(true); ink.resize(); ink.loadFor(inkKey()); toast('手写模式：可直接涂画，完成后点「完成」'); }
  else { ink.loadFor(inkKey()); }
  syncInkDelBtn();
}

/** 「删除选中」只在「框选工具 + 真有选中」时出现（平时别占工具条位置） */
function syncInkDelBtn() {
  const b = document.getElementById('inkDelBtn');
  if (!b) return;
  const on = !!(R.penMode && typeof ink !== 'undefined' && ink && ink.tool === 'select' && ink.sel && ink.sel.size);
  b.hidden = !on;
}

/* ============================================================
   设置面板
   ============================================================ */
function bindSettingsPanel() { }

/** 背景色够不够暗（决定默认文字用白还是黑、卡片是抬亮还是压灰） */
function uiBgIsDark(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return false;
  const v = parseInt(m[1], 16);
  const lum = (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255;
  return lum < 0.55;
}

/** 设置面板里「ⓘ 说明」的展开状态：重建面板（换主题/字体）时别把已展开的收回去 */
const _setNoteOpen = Object.create(null);

function buildSettingsPanel() {
  const body = $('settingsBody');
  /* 装进安卓壳里才有「改文件夹」这两项：浏览器里数据由服务端 serve.py 决定，
     页面自己改不了（改了也没权限）。 */
  const inApp = !!window.InkAndroid;
  // 重建前记下滚动位置：下面整段 innerHTML 替换会让滚动归零，
  // 切换主题/字体 chip 时调用本会触发「点一下就滑走」（#7）。重建后恢复。
  const _keepScroll = body ? body.scrollTop : 0;
  const t = currentTheme();
  // 说明折叠状态：buildSettingsPanel 会被反复重建（换主题/换字体都会），
  // 存在模块级对象里，重建后展开的那几条还保持展开。
  const head = (title, key) => '<div class="set-head"><span class="set-title">' + title + '</span>'
    + (key ? '<button class="set-info' + (_setNoteOpen[key] ? ' on' : '') + '" data-note="' + key + '" aria-label="说明">ⓘ</button>' : '')
    + '</div>';
  const note = (key, html) => '<div class="set-note' + (_setNoteOpen[key] ? ' show' : '') + '" data-note="' + key + '">' + html + '</div>';

  body.innerHTML = `
    <div class="set-group">
      ${head('主题背景')}
      <div class="set-card">
        <div class="set-row col">
          <div class="theme-grid">
            ${THEMES.map(th => `
              <div class="theme-swatch${th.id === Settings.themeId ? ' sel' : ''}"
                   data-theme="${th.id}" style="background:${th.id === 'custom' ? Settings.customBg : th.bg};color:${th.id === 'custom' ? Settings.customFg : th.fg}">
                ${th.name}
              </div>`).join('')}
          </div>
        </div>
        ${Settings.themeId === 'custom' ? `
        <div class="set-row">
          <span class="sr-label">自定义</span>
          <div class="sr-ctl">
            <input type="color" class="sw" id="bgPicker" value="${Settings.customBg}" title="底色">
            <span class="sr-val">底色</span>
            <input type="color" class="sw" id="fgPicker" value="${Settings.customFg}" title="字色">
            <span class="sr-val">字色</span>
          </div>
        </div>` : ''}
      </div>
    </div>

    <div class="set-group">
      ${head('界面背景', 'ui')}
      <div class="set-card">
        <div class="set-row">
          <span class="sr-label">背景色</span>
          <div class="sr-ctl">
            <input type="color" class="sw" id="uiBgPicker" value="${Settings.uiBg || '#E9EAEE'}">
            <div style="flex:1"></div>
            <button class="chip sm" id="uiBgReset">恢复默认</button>
          </div>
        </div>
        <div class="set-row">
          <span class="sr-label">侧边栏</span>
          <div class="sr-ctl">
            <input type="color" class="sw" id="uiSidePicker" value="${Settings.uiSideBg || Settings.uiBg || '#F2F2F7'}">
            <div style="flex:1"></div>
            <button class="chip sm${Settings.uiSideBg ? '' : ' sel'}" id="uiSideFollow">跟随背景</button>
          </div>
        </div>
        <div class="set-row">
          <span class="sr-label">文字颜色</span>
          <div class="sr-ctl">
            <input type="color" class="sw" id="uiFgPicker" value="${Settings.uiFg || (uiBgIsDark(Settings.uiBg) ? '#EDEDED' : '#1C1C1E')}">
            <div style="flex:1"></div>
            <button class="chip sm${Settings.uiFg ? '' : ' sel'}" id="uiFgFollow">跟随背景</button>
          </div>
        </div>
        <div class="set-row">
          <span class="sr-label">侧栏文字</span>
          <div class="sr-ctl">
            <input type="color" class="sw" id="uiSideFgPicker" value="${Settings.uiSideFg || (uiBgIsDark(Settings.uiSideBg || Settings.uiBg) ? '#EDEDED' : '#1C1C1E')}">
            <div style="flex:1"></div>
            <button class="chip sm${Settings.uiSideFg ? '' : ' sel'}" id="uiSideFgFollow">跟随侧栏</button>
          </div>
        </div>
        <div class="set-row">
          <span class="sr-label">强调色</span>
          <div class="sr-ctl">
            <div class="seg-full" id="setAccentMode">
              <button class="seg-btn${(Settings.uiAccentMode || 'auto') === 'auto' ? ' active' : ''}" data-am="auto">跟背景</button>
              <button class="seg-btn${Settings.uiAccentMode === 'blue' ? ' active' : ''}" data-am="blue">经典蓝</button>
            </div>
          </div>
        </div>
        <div class="set-row btn-row">
          <button class="btn-primary sm" id="uiBgPick">🖼 选一张图</button>
          ${Settings.uiBgImg ? '<button class="btn-danger sm" id="uiBgClear">✕ 去掉图</button>' : ''}
          <input type="file" id="uiBgFile" accept="image/*" hidden>
        </div>
        <div class="set-row">
          <span class="sr-label">图片浓度</span>
          <div class="sr-ctl">
            <input type="range" id="uiBgAlpha" min="5" max="100" step="5" value="${Math.round((Settings.uiBgAlpha == null ? 0.35 : Settings.uiBgAlpha) * 100)}">
            <span class="sr-val" id="vUiBgAlpha">${Math.round((Settings.uiBgAlpha == null ? 0.35 : Settings.uiBgAlpha) * 100)}%</span>
          </div>
        </div>
        <div class="set-row">
          <span class="sr-label">封面浓度</span>
          <div class="sr-ctl">
            <input type="range" id="uiCoverAlpha" min="10" max="100" step="5" value="${Math.round((Settings.uiCoverAlpha == null ? 1 : Settings.uiCoverAlpha) * 100)}">
            <span class="sr-val" id="vUiCoverAlpha">${Math.round((Settings.uiCoverAlpha == null ? 1 : Settings.uiCoverAlpha) * 100)}%</span>
          </div>
        </div>
      </div>
      ${note('ui', '只影响「书架 + 侧栏 + 继续阅读」，正文不动。<br>'
        + '文字颜色默认按各自底色自动配（深底配浅字）；侧栏单独选色时，<b>侧栏文字</b>按侧栏自己的底色再配一遍。<br>'
        + '<b>强调色</b>默认取背景的色系（按钮、蓝字、选中态一起变），想留原来那抹蓝就切「经典蓝」。<br>'
        + '设了图片后两块面板变半透明（否则纯色会把图盖住），图片会缩到 1600px 存进设置。<br>'
        + '<b>封面浓度</b>只让书封的底板和封面图变透，书名、角标不跟着淡。')}
    </div>

    <div class="set-group">
      ${head('字体')}
      <div class="set-card">
        <div class="set-row col">
          <div class="font-chips">
            ${FONTS.map(f => `<span class="chip${f.id === Settings.fontFamily ? ' sel' : ''}" data-font="${f.id}">${f.name}</span>`).join('')}
          </div>
        </div>
        <div class="set-row">
          <span class="sr-label">字号</span>
          <div class="sr-ctl">
            <input type="range" id="setFontSize" min="12" max="40" value="${Settings.fontSize}">
            <span class="sr-val" id="vFontSize">${Settings.fontSize}</span>
          </div>
        </div>
        <div class="set-row">
          <span class="sr-label">行距</span>
          <div class="sr-ctl">
            <input type="range" id="setLine" min="1.2" max="2.6" step="0.05" value="${Settings.lineHeight}">
            <span class="sr-val" id="vLine">${Settings.lineHeight.toFixed(2)}</span>
          </div>
        </div>
        <div class="set-row">
          <span class="sr-label">字距</span>
          <div class="sr-ctl">
            <input type="range" id="setLetter" min="0" max="4" step="0.5" value="${Settings.letterSpacing}">
            <span class="sr-val" id="vLetter">${Settings.letterSpacing}</span>
          </div>
        </div>
        <div class="set-row">
          <span class="sr-label">段距</span>
          <div class="sr-ctl">
            <input type="range" id="setPara" min="0" max="2.5" step="0.1" value="${Settings.paraSpacing}">
            <span class="sr-val" id="vPara">${Settings.paraSpacing.toFixed(1)}</span>
          </div>
        </div>
        <div class="set-row">
          <span class="sr-label">页边距</span>
          <div class="sr-ctl">
            <input type="range" id="setMargin" min="12" max="140" value="${Settings.margin}">
            <span class="sr-val" id="vMargin">${Settings.margin}</span>
          </div>
        </div>
        <div class="set-row">
          <span class="sr-label">粗体</span>
          <div class="sr-ctl"><div class="switch${Settings.bold ? ' on' : ''}" id="setBold"></div></div>
        </div>
        <div class="set-row col">
          <span class="sr-label">对齐</span>
          <div class="seg-full" id="setAlign">
            <button class="seg-btn${Settings.align === 'left' ? ' active' : ''}" data-a="left">左</button>
            <button class="seg-btn${Settings.align === 'center' ? ' active' : ''}" data-a="center">中</button>
            <button class="seg-btn${Settings.align === 'right' ? ' active' : ''}" data-a="right">右</button>
            <button class="seg-btn${Settings.align === 'justify' ? ' active' : ''}" data-a="justify">两端</button>
          </div>
        </div>
      </div>
    </div>

    <div class="set-group">
      ${head('预览')}
      <div class="preview-box" style="background:${t.id === 'custom' ? Settings.customBg : t.bg};color:${t.id === 'custom' ? Settings.customFg : t.fg};
           font-family:${(FONTS.find(f => f.id === Settings.fontFamily) || FONTS[0]).css};
           font-size:${Settings.fontSize}px;line-height:${Settings.lineHeight};letter-spacing:${Settings.letterSpacing}px;
           font-weight:${Settings.bold ? 600 : 400};text-align:${Settings.align}">
        山不走，人自走。
      </div>
    </div>

    <div class="set-group">
      ${head('翻页')}
      <div class="set-card">
        <div class="set-row col">
          <span class="sr-label">方向</span>
          <div class="seg-full" id="setDir">
            <button class="seg-btn${Settings.direction === 'horizontal' ? ' active' : ''}" data-d="horizontal">⇄ 左右翻页</button>
            <button class="seg-btn${Settings.direction === 'vertical' ? ' active' : ''}" data-d="vertical">⇅ 上下滚动</button>
          </div>
        </div>
        <div class="set-row">
          <span class="sr-label">自动翻页</span>
          <div class="sr-ctl">
            <input type="range" id="setSpeed" min="1" max="30" value="${Settings.autoSpeed}">
            <span class="sr-val" id="vSpeed">${Settings.autoSpeed}s</span>
          </div>
        </div>
        <div class="set-row">
          <span class="sr-label">常亮</span>
          <div class="sr-ctl"><div class="switch${Settings.keepAwake ? ' on' : ''}" id="setAwake"></div></div>
        </div>
        <div class="set-row">
          <span class="sr-label">划动翻页</span>
          <div class="sr-ctl">
            <div class="seg-full" id="setSwipe">
              <button class="seg-btn${Settings.swipeTurn === false ? '' : ' active'}" data-sw="1">开</button>
              <button class="seg-btn${Settings.swipeTurn === false ? ' active' : ''}" data-sw="0">关</button>
            </div>
          </div>
        </div>
        <div class="set-hint">关掉后，用鼠标慢慢划词不会误翻页。</div>
      </div>
    </div>

    <div class="set-group">
      ${head('漫画', 'comic')}
      <div class="set-card">
        <div class="set-row col">
          <span class="sr-label">页面适配</span>
          <div class="seg-full" id="setComicFit">
            <button class="seg-btn${(Settings.comicFit || 'contain') === 'contain' ? ' active' : ''}" data-fit="contain">整页</button>
            <button class="seg-btn${Settings.comicFit === 'width' ? ' active' : ''}" data-fit="width">适应宽度</button>
            <button class="seg-btn${Settings.comicFit === 'height' ? ' active' : ''}" data-fit="height">适应高度</button>
            <button class="seg-btn${Settings.comicFit === 'cover' ? ' active' : ''}" data-fit="cover">填满裁切</button>
          </div>
        </div>
        <div class="set-row">
          <span class="sr-label">图片缩放</span>
          <div class="sr-ctl">
            <input type="range" id="setComicZoom" min="30" max="300" step="5" value="${Math.round((Settings.comicZoom || 1) * 100)}">
            <span class="sr-val" id="vComicZoom">${Math.round((Settings.comicZoom || 1) * 100)}%</span>
          </div>
        </div>
        <div class="set-row">
          <span class="sr-label">阅读形态</span>
          <div class="sr-ctl">
            <div class="seg-full" id="setComicMode">
              <button class="seg-btn${Settings.comicMode === 'scroll' ? '' : ' active'}" data-mode="paged">分页</button>
              <button class="seg-btn${Settings.comicMode === 'scroll' ? ' active' : ''}" data-mode="scroll">卷轴</button>
            </div>
          </div>
        </div>
        <div class="set-row">
          <span class="sr-label">双页显示</span>
          <div class="sr-ctl">
            <div class="seg-full" id="setComicSpread">
              <button class="seg-btn${Settings.comicSpread ? ' active' : ''}" data-spread="1">双页</button>
              <button class="seg-btn${!Settings.comicSpread ? ' active' : ''}" data-spread="0">单页</button>
            </div>
          </div>
        </div>
        <div class="set-row col">
          <span class="sr-label">阅读方向</span>
          <div class="seg-full" id="setComicRTL">
            <button class="seg-btn${!comicScrollOn() && !Settings.comicRTL ? ' active' : ''}" data-rtl="0">左→右</button>
            <button class="seg-btn${!comicScrollOn() && Settings.comicRTL ? ' active' : ''}" data-rtl="1">右→左</button>
            <button class="seg-btn${comicScrollOn() ? ' active' : ''}" data-dir="ttb">上→下</button>
          </div>
        </div>
        <div class="set-hint">整页＝全部装下；宽度／高度＝铺满一侧、另一侧滚；填满裁切＝可能被裁边。文字书不受这里影响。</div>
      </div>
      ${note('comic', '双页、右→左只在「分页」且横屏时生效；连续卷轴（条漫）把整本拼成一条长卷，图片固定按宽度排。'
        + '文字书（TXT / HTML）改字号请去「字体 → 字号」。')}
    </div>

    <div class="set-group">
      ${head('PDF', 'ocr')}
      <div class="set-card">
        <div class="set-row">
          <span class="sr-label">扫描页识别</span>
          <div class="sr-ctl"><div class="switch${Settings.pdfAutoOcr ? ' on' : ''}" id="setPdfOcr"></div></div>
        </div>
        <div class="set-hint">关闭时每页显示「🔍 点此识别」；开启则开书即识别全部，较慢。</div>
      </div>
      ${note('ocr', '扫描版 PDF 没有文字层，只能靠 OCR 认字。<br>'
        + '手机 / 平板里引擎和常用语言包（中 / 繁 / 英 / 日）已经随安装包带上，离线也能认；'
        + '选其它语言才需要联网取包。<br>'
        + '只在扫描页生效，带文字层的 PDF 不会重复识别。')}
    </div>

    <div class="set-group">
      ${head('高亮颜色', 'hl')}
      <div class="set-card">
        <div class="set-row col">
          <span class="sr-label">默认颜色</span>
          <div class="color-row">
            ${HL_COLORS.map((c, i) => `<div class="color-dot${i === (Settings.hlColorIdx || 0) ? ' sel' : ''}" style="background:${c}" data-hl="${c}" data-idx="${i}"></div>`).join('')}
          </div>
        </div>
      </div>
      ${note('hl', '选中文字后点「高亮」，<b>新画的</b>用这个颜色；已经画好的不跟着变。选中的点会被记住。')}
    </div>

    <div class="set-group">
      ${head('后台服务', 'svc')}
      <div class="set-card">
        <div class="set-row col">
          <div id="svcStatus" class="svc-status">正在检测服务状态…</div>
        </div>
        <div class="set-row btn-row">
          <button class="btn-danger sm" id="svcStopAll">⏹ 停止服务</button>
          <button class="btn-primary sm" id="svcRestart">🔄 重启服务</button>
        </div>
      </div>
      ${note('svc', '本地服务常驻 8123。停止会连带关闭翻译引擎、释放内存，之后本页不可用，需手动关闭标签页。')}
    </div>

    <div class="set-group">
      ${head('书库位置', 'store')}
      <div class="set-card">
        <div class="set-row col">
          <div id="storeInfo" class="svc-status">正在读取…</div>
        </div>
        <div class="set-hint">书 / 笔记 / 设置都写这里；清浏览器缓存不丢。</div>
        ${inApp ? `
        <div class="set-row col">
          <div id="appDirText" class="set-hint" style="word-break:break-all">…</div>
        </div>
        <div class="set-row btn-row">
          <button class="btn-plain sm" id="pickDataDir">📂 改书籍文件夹</button>
          <button class="btn-plain sm" id="pickOutDir">💾 改备份文件夹</button>
        </div>
        <div class="set-hint">改书籍文件夹会把原来的书 / 笔记 / 模型一起搬过去，然后应用自动重启一次。<br>
          选的时候可以一层层往里点，「⬆ 上一级」随时能退回去；懒得找就点「🗂 用系统文件管理器选」。</div>` : ''}
      </div>
      ${note('store', '卸载安装目录会把这里一起删掉，重要笔记请先导出备份。')}
    </div>

    <div class="set-group">
      ${head('访问密码 · 多端对账', 'peer')}
      <div class="set-card">
        <div class="set-row col">
          <div id="peerStat" class="svc-status">正在读取…</div>
          <div id="peerList" class="set-hint" style="margin-top:6px"></div>
        </div>
        <div class="set-row col">
          <input id="peerPwd" type="password" autocomplete="new-password"
                 placeholder="新密码（可以给每台设备各设一个）"
                 style="width:100%;padding:9px 10px;border-radius:9px;border:.5px solid var(--ios-gray4,#c7c7cc);background:var(--ios-gray6,#f2f2f7);color:var(--ios-label,#000)">
        </div>
        <div class="set-row col">
          <input id="peerNote" type="text" autocomplete="off" maxlength="20"
                 placeholder="给它起个名（可留空，例如「我的手机」）"
                 style="width:100%;padding:9px 10px;border-radius:9px;border:.5px solid var(--ios-gray4,#c7c7cc);background:var(--ios-gray6,#f2f2f7);color:var(--ios-label,#000)">
        </div>
        <div class="set-row btn-row">
          <button class="btn-primary sm" id="peerSave">添加密码</button>
          <button class="btn-plain sm" id="peerClear">全部清除</button>
        </div>
        <div class="set-hint">可以存<b>多个</b>密码，别的设备用其中任意一个都能对账；新加一个不会顶掉旧的。<br>
          它同时是<b>访问密码</b>：同一 WiFi 里的人打开你的书库（<code>http://你的IP:8123</code>）要先输它，
          输一次那个浏览器记 30 天；本机打开不用输。<br>
          <b>看和改是两道门</b>：输过访问密码只能翻书架；要「⇄ 对账」往你这台写数据，得再输一次
          （记住后不再问）。改密码只能在这台机器上改。<br>
          密码只在本机存哈希（<code>data/peer.json</code>），不跟着对账同步。</div>
      </div>
      ${note('peer', '这不是账号系统：知道任意一个密码就能看/对账这台书库。别用你常用的密码。')}
    </div>
    <div style="height:20px"></div>
  `;

  /* R170：ⓘ 说明原来排在 .set-card **后面** —— 点标题旁边的 ⓘ，内容却展开在整块最底部，
     看着像"注释掉到下面去了"（用户原话：「访问密码那里的 i 注释，咋在最下面？」）。
     这里统一把它挪到卡片前面，展开时就贴在标题正下方。 */
  body.querySelectorAll('.set-group').forEach(g => {
    const n = g.querySelector('.set-note');
    const c = g.querySelector('.set-card');
    if (n && c && c.parentElement === g) g.insertBefore(n, c);
  });

  // 事件
  // ⓘ 说明：点开才展开该组的详细说明（默认收起，面板才不至于一屏全是小字）
  body.querySelectorAll('.set-info').forEach(btn => btn.onclick = () => {
    const k = btn.dataset.note;
    _setNoteOpen[k] = !_setNoteOpen[k];
    const n = body.querySelector('.set-note[data-note="' + k + '"]');
    if (n) n.classList.toggle('show', !!_setNoteOpen[k]);
    btn.classList.toggle('on', !!_setNoteOpen[k]);
  });
  body.querySelectorAll('[data-theme]').forEach(n => n.onclick = () => {
    Settings.themeId = n.dataset.theme; saveSettings(); buildSettingsPanel(); applySettings();
  });
  const bg = body.querySelector('#bgPicker');
  if (bg) bg.oninput = e => { Settings.customBg = e.target.value; saveSettings(); applySettings(); };
  const fg = body.querySelector('#fgPicker');
  if (fg) fg.oninput = e => { Settings.customFg = e.target.value; saveSettings(); applySettings(); };

  body.querySelectorAll('[data-font]').forEach(n => n.onclick = () => {
    Settings.fontFamily = n.dataset.font; saveSettings(); buildSettingsPanel(); applySettings();
  });

  const bind = (id, vid, key, fmt) => {
    const el = body.querySelector(id); if (!el) return;
    el.oninput = e => {
      Settings[key] = parseFloat(e.target.value);
      body.querySelector(vid).textContent = fmt ? fmt(Settings[key]) : Settings[key];
      saveSettings(); applySettings();
    };
  };
  bind('#setFontSize', '#vFontSize', 'fontSize', v => v);
  bind('#setLine', '#vLine', 'lineHeight', v => v.toFixed(2));
  bind('#setLetter', '#vLetter', 'letterSpacing', v => v);
  bind('#setPara', '#vPara', 'paraSpacing', v => v.toFixed(1));
  bind('#setMargin', '#vMargin', 'margin', v => v);
  bind('#setSpeed', '#vSpeed', 'autoSpeed', v => v + 's');

  // 漫画图片缩放（百分比滑块，30%~300%；setComicZoom 内部再夹一次边界，并重绘当前页不跳页）
  const zEl = body.querySelector('#setComicZoom');
  if (zEl) zEl.oninput = e => {
    const v = parseFloat(e.target.value) / 100;
    Settings.comicZoom = v;
    body.querySelector('#vComicZoom').textContent = Math.round(v * 100) + '%';
    updateComicZoomLabel();
    saveSettings();
    if (R.format === 'comic') {
      const keep = R.pageIndex;
      layerApplyZoom();                 // 直接改 --z，避免整页 rebuild 导致卷轴跳动
      if (comicScrollOn()) requestAnimationFrame(() => comicScrollTo(keep));
      updateChrome();
      if (typeof ink !== 'undefined' && ink && ink.strokes.length) ink.redraw();   // 缩放后笔迹跟随（#195）
    }
  };

  // ---- 后台服务：设置面板里的手动彻底停止按钮（引擎启停留在翻译面板） ----
  const svcStatus = body.querySelector('#svcStatus');
  const svcStopAll = body.querySelector('#svcStopAll');

  async function refreshSvcStatus() {
    if (!svcStatus) return;
    let eng = '未知';
    try {
      const r = await fetch('/api/engine-status?which=portable', { method: 'GET' });
      const j = await r.json().catch(() => ({}));
      eng = j.running ? '运行中' : '未运行';
    } catch (e) { eng = '检测失败'; }
    svcStatus.innerHTML = '网页 8123 · <b>运行中</b>　｜　翻译引擎 8080 · <b>' + eng + '</b>';
  }

  /* 书库落盘位置（R74）：让「现在这条线路写的是哪个目录」一眼看得见。
     源码树（开发用）落到 data-dev，安装版落到安装目录的 data。
     以前两棵树混着跑，用户在设置里根本分不出自己用的是哪条线。 */
  const storeInfo = body.querySelector('#storeInfo');
  async function refreshStoreInfo() {
    if (!storeInfo) return;
    try {
      const r = await fetch('/api/store/index', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      let bytes = 0;
      try {
        const s = await fetch('/api/store/stats', { cache: 'no-store' }).then(x => x.json());
        bytes = s.bytes || 0;
      } catch (e) { }
      const n = Object.keys(j.books || {}).length;
      const mb = bytes / 1048576;
      const size = bytes < 1024 ? '空' : (mb >= 1 ? mb.toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB');
      storeInfo.innerHTML =
        '<div style="margin-bottom:2px">' + (j.dev ? '⚠️ 源码目录（开发用，不是你的书库）' : '✅ 安装目录')
        + '　<b>' + n + ' 本</b> · ' + size + '</div>'
        + '<div style="font-size:11px;opacity:.7;word-break:break-all" title="' + (j.root || '') + '">' + (j.root || '—') + '</div>';
    } catch (e) {
      storeInfo.innerHTML = '书只在浏览器里（本地服务未运行，未落盘）';
    }
  }
  refreshStoreInfo();

  /* ---- 多端对账密码（R158/R160）：本机设的锁，别的设备连过来要对账得先填 ----
     R160：原来只能存一个，给第二台设备设密码就把第一台顶掉了。
     现在可以存多个（每台一个更好管理），任一个对得上就放行。 */
  const peerStat = body.querySelector('#peerStat');
  const peerPwdEl = body.querySelector('#peerPwd');
  const peerNoteEl = body.querySelector('#peerNote');
  const peerListEl = body.querySelector('#peerList');

  function fmtPwdAt(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const p = n => (n < 10 ? '0' : '') + n;
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  async function paintPeerStat() {
    if (!peerStat) return;
    try {
      const r = await fetch('/api/peer/state', { cache: 'no-store' });
      const j = await r.json();
      const n = j.count || 0;
      peerStat.innerHTML = n
        ? ('🔒 <b>已设 ' + n + ' 个对账密码</b>：别的设备用其中任意一个都能和这台对账')
        : '🔓 <b>未设密码</b>：同一 WiFi 的墨阅都能直接和这台对账';
      if (peerListEl) {
        const ks = j.keys || [];
        peerListEl.innerHTML = ks.length
          ? ks.map((k, i) => '<div style="display:flex;justify-content:space-between;gap:8px;padding:2px 0">'
            + '<span>' + (i + 1) + '. ' + esc(k.note || '（没起名）')
            + (k.at ? ' · ' + esc(fmtPwdAt(k.at)) : '') + '</span>'
            + '<a href="javascript:void 0" data-pwd-del="' + i + '" style="color:#c0392b">删除</a></div>').join('')
          : '';
        peerListEl.querySelectorAll('[data-pwd-del]').forEach(a => {
          a.onclick = () => delPeerPwd(parseInt(a.dataset.pwdDel, 10));
        });
      }
    } catch (e) {
      peerStat.innerHTML = '读不到对账密码状态（本地服务没起？）';
    }
  }
  paintPeerStat();

  async function postPeer(bodyObj) {
    const r = await fetch('/api/peer/set', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj)
    });
    return r.json().catch(() => ({}));
  }

  async function savePeerPwd(pwd, note) {
    try {
      const j = await postPeer({ pwd: pwd, note: note || '' });
      if (!j.ok) { toast('保存失败：' + (j.msg || '未知原因')); return; }
      if (peerPwdEl) peerPwdEl.value = '';
      if (peerNoteEl) peerNoteEl.value = '';
      toast(pwd ? ('已加一个对账密码' + (j.msg && j.msg !== 'ok' ? '（' + j.msg + '）' : '') + '，旧的还在')
        : '已清除全部对账密码');
      paintPeerStat();
    } catch (e) {
      toast('保存失败：' + (e && e.message || e));
    }
  }

  async function delPeerPwd(idx) {
    if (!confirm('删掉第 ' + (idx + 1) + ' 个密码？\n\n用它的那台设备下次对账要重新填密码。')) return;
    try {
      const j = await postPeer({ del: idx });
      if (!j.ok) { toast('删除失败：' + (j.msg || '未知原因')); return; }
      toast('已删掉这个密码');
      paintPeerStat();
    } catch (e) {
      toast('删除失败：' + (e && e.message || e));
    }
  }

  const peerSave = body.querySelector('#peerSave');
  if (peerSave) peerSave.onclick = () => {
    const v = (peerPwdEl && peerPwdEl.value || '').trim();
    if (!v) { toast('先在上面填一个密码'); return; }
    if (v.length < 4) { toast('太短了，至少 4 位'); return; }
    savePeerPwd(v, (peerNoteEl && peerNoteEl.value || '').trim());
  };
  const peerClear = body.querySelector('#peerClear');
  if (peerClear) peerClear.onclick = () => {
    if (!confirm('清除全部对账密码？\n\n之后同一 WiFi 里任何墨阅都能直接和这台对账（书、笔记都能读）。')) return;
    savePeerPwd('');
  };

  /* 安卓壳：显示 / 更改「书籍文件夹」「备份文件夹」（浏览器里没有这两项） */
  if (inApp) {
    const A = window.InkAndroid;
    const dirText = body.querySelector('#appDirText');
    const paintDirs = () => {
      if (!dirText || !A) return;
      let d1 = '', d2 = '', st = null;
      try { d1 = A.dataDir ? A.dataDir() : ''; } catch (e) { }
      try { d2 = A.outDir ? A.outDir() : ''; } catch (e) { }
      // R160：把「到底授权没有」直接写出来。以前只有「去授权」按钮，用户开了权限
      // 也看不出有没有生效，只能反复点、反复被劝去授权。
      try { st = A.storageState ? JSON.parse(A.storageState()) : null; } catch (e) { st = null; }
      const perm = st ? (st.allFiles
        ? '权限：<b style="color:#2e7d32">✓ 已允许管理所有文件</b>'
        : '权限：<b style="color:#c0392b">未授权</b>　书库只能放在 App 私有目录（别的软件看不见）')
        : '';
      dirText.innerHTML = '书籍：<b>' + esc(String(d1 || '—')) + '</b><br>'
        + '备份：<b>' + esc(String(d2 || '—')) + '</b>'
        + (perm ? '<br>' + perm : '');
    };
    window.__inkDirsChanged = paintDirs;
    paintDirs();
    const pd = body.querySelector('#pickDataDir');
    if (pd) pd.onclick = () => { try { A.pickDataDir(); } catch (e) { toast('打不开目录选择：' + e); } };
    const po = body.querySelector('#pickOutDir');
    if (po) po.onclick = () => { try { A.pickOutDir(); } catch (e) { toast('打不开目录选择：' + e); } };
  }

  if (svcStopAll) svcStopAll.onclick = async () => {
    if (!confirm('将停止本地服务与翻译引擎，并释放占用的内存与目录锁。\n'
        + '停止后本页将不可用，需手动关闭此标签页。\n\n确定停止后台服务？')) return;
    // 标记「用户主动停止」：心跳检测到服务消失时显示对应文案，且不提供恢复按钮
    window.__inkUserStopped = true;
    // 先停引擎（彻底释放内存），再停服务自身（释放端口与目录锁）
    try { await fetch('/api/engine-stop?which=both', { method: 'POST' }); } catch (e) {}
    try { await fetch('/api/server-stop', { method: 'POST' }); } catch (e) {}
    setTimeout(showStoppedOverlay, 700);   // 服务约 0.5s 后退出，遮罩随后弹出
  };

  // 设置面板里的「🔄 重启后台服务」：与顶部横幅同逻辑（进程内原地重启，约 1 秒，
  // 不依赖 supervise、不吃冷启动），用于在不关闭阅读页的前提下让新 serve.py 立即生效。
  const svcRestart = body.querySelector('#svcRestart');
  if (svcRestart) svcRestart.onclick = async () => {
    window.__inkUserStopped = false;   // 重启后不再是「用户主动停止」状态
    svcRestart.disabled = true;
    svcRestart.textContent = '🔄 重启中…';
    try { await fetch('/api/server-restart', { method: 'POST', keepalive: true }); } catch (e) {}
    let ok = false;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 400));
      try { const r = await fetch('/api/ping', { cache: 'no-store' }); if (r.ok) { ok = true; break; } } catch (e) {}
    }
    svcRestart.disabled = false;
    svcRestart.textContent = '🔄 重启后台服务';
    if (ok) { toast('后台服务已重启'); refreshSvcStatus(); refreshStoreInfo(); }
    else toast('重启失败：请双击桌面 InkReader 图标重新打开');
  };

  function showStoppedOverlay() {
    let o = document.getElementById('stoppedOverlay');
    if (!o) {
      o = document.createElement('div');
      o.id = 'stoppedOverlay';
      o.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(18,18,20,.97);'
        + 'color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;'
        + 'text-align:center;padding:28px;font-size:16px;line-height:1.7';
      o.innerHTML = '<div style="font-size:52px;margin-bottom:10px">✅</div>'
        + '<div style="font-size:20px;font-weight:700">后台服务已停止</div>'
        + '<div style="margin-top:12px;color:#cfcfcf">翻译引擎已关闭，内存与目录锁已释放。<br>'
        + '现在可以安全地重命名 / 删除安装目录了。</div>'
        + '<div style="margin-top:18px;color:#ffd479;max-width:340px">'
        + '请手动关闭此标签页（浏览器出于安全限制，网页无法自动关闭你手动打开的页面）。</div>';
      document.body.appendChild(o);
    }
    o.style.display = 'flex';
    try { window.close(); } catch (e) {}   // 仅在脚本打开的窗口有效，手动打开的被拦也无妨
  }

  refreshSvcStatus();

  const bold = body.querySelector('#setBold');
  bold.onclick = () => { Settings.bold = !Settings.bold; bold.classList.toggle('on', Settings.bold); saveSettings(); applySettings(); };
  const awake = body.querySelector('#setAwake');
  awake.onclick = () => {
    Settings.keepAwake = !Settings.keepAwake;
    awake.classList.toggle('on', Settings.keepAwake);
    saveSettings();
    if (!Settings.keepAwake) releaseWakeLock();
  };

  const pdfOcr = body.querySelector('#setPdfOcr');
  if (pdfOcr) pdfOcr.onclick = () => {
    Settings.pdfAutoOcr = !Settings.pdfAutoOcr;
    pdfOcr.classList.toggle('on', Settings.pdfAutoOcr);
    saveSettings();
  };

  body.querySelectorAll('#setAlign .seg-btn').forEach(n => n.onclick = () => {
    Settings.align = n.dataset.a; saveSettings(); buildSettingsPanel(); applySettings();
  });
  body.querySelectorAll('#setDir .seg-btn').forEach(n => n.onclick = () => {
    const d = n.dataset.d;
    saveSettings();
    if (R && R.book && d !== Settings.direction) { switchMode(d); }
    buildSettingsPanel();
  });
  // 漫画：页面适配 / 双页 / 阅读方向
  const comicRedraw = () => {
    saveSettings(); buildSettingsPanel();
    if (R.format === 'comic') { renderPage(); updateChrome(); }
  };
  body.querySelectorAll('#setComicFit .seg-btn').forEach(n => n.onclick = () => {
    Settings.comicFit = n.dataset.fit;
    // 卷轴模式（条漫）下图片固定「按宽度堆叠」，四选项根本无从体现 ——
    // 用户点了没反应就是因为这个。直接切回分页，让选择立刻看得见。
    if (R && R.format === 'comic' && Settings.comicMode === 'scroll') {
      Settings.comicMode = 'paged';
      toast('卷轴模式只按宽度排，已切回「分页」，适配方式马上能看出来');
    } else if (!R || R.format !== 'comic') {
      toast('已记下：打开图片 / 漫画后按这个方式适配');
    }
    comicRedraw();
  });
  body.querySelectorAll('#setComicMode .seg-btn').forEach(n => n.onclick = () => {
    Settings.comicMode = n.dataset.mode === 'scroll' ? 'scroll' : 'paged';
    saveSettings(); buildSettingsPanel();
    if (R && R.format === 'comic') { renderPage(); updateChrome(); refreshInk(); }
    toast(Settings.comicMode === 'scroll'
      ? '连续卷轴：整本一气往下滚'
      : '分页：一屏一页');
  });
  body.querySelectorAll('#setComicSpread .seg-btn').forEach(n => n.onclick = () => {
    Settings.comicSpread = n.dataset.spread === '1'; comicRedraw();
  });
  body.querySelectorAll('#setSwipe .seg-btn').forEach(n => n.onclick = () => {
    Settings.swipeTurn = n.dataset.sw === '1';
    saveSettings(); buildSettingsPanel();
    toast(Settings.swipeTurn ? '划动翻页：开' : '划动翻页：关（请用底栏按钮翻页）');
  });
  body.querySelectorAll('#setComicRTL .seg-btn').forEach(n => n.onclick = () => {
    // 第三个键是"上→下"（= 连续卷轴），前两个还是老的左→右 / 右→左
    if (n.dataset.dir === 'ttb') setComicDir('ttb');
    else setComicDir(n.dataset.rtl === '1' ? 'rtl' : 'ltr');
  });
  /* ---------- 界面背景（书架 + 侧边栏） ---------- */
  const uiBg = body.querySelector('#uiBgPicker');
  if (uiBg) uiBg.oninput = e => { Settings.uiBg = e.target.value; saveSettings(); applyUiBg(); };
  const uiSide = body.querySelector('#uiSidePicker');
  if (uiSide) uiSide.oninput = e => { Settings.uiSideBg = e.target.value; saveSettings(); applyUiBg(); };
  const uiFg = body.querySelector('#uiFgPicker');
  if (uiFg) uiFg.oninput = e => { Settings.uiFg = e.target.value; saveSettings(); applyUiBg(); };
  const uiFgFollow = body.querySelector('#uiFgFollow');
  if (uiFgFollow) uiFgFollow.onclick = () => {
    Settings.uiFg = ''; saveSettings(); buildSettingsPanel(); applyUiBg();
    toast(uiBgIsDark(Settings.uiBg) ? '文字改用浅色（跟背景自动配）' : '文字用深色（跟背景自动配）');
  };
  /* 侧栏文字：侧栏和主区深浅不一样时单独配一套，不然黑字压深底等于看不见 */
  const uiSideFg = body.querySelector('#uiSideFgPicker');
  if (uiSideFg) uiSideFg.oninput = e => { Settings.uiSideFg = e.target.value; saveSettings(); applyUiBg(); };
  const uiSideFgFollow = body.querySelector('#uiSideFgFollow');
  if (uiSideFgFollow) uiSideFgFollow.onclick = () => {
    Settings.uiSideFg = ''; saveSettings(); buildSettingsPanel(); applyUiBg();
    toast(uiBgIsDark(Settings.uiSideBg || Settings.uiBg)
      ? '侧栏文字改用浅色（跟侧栏底色自动配）'
      : '侧栏文字用深色（跟侧栏底色自动配）');
  };
  const uiFollow = body.querySelector('#uiSideFollow');
  if (uiFollow) uiFollow.onclick = () => {
    Settings.uiSideBg = ''; saveSettings(); buildSettingsPanel(); applyUiBg();
    toast('侧边栏跟背景色一致');
  };
  /* 强调色来源（R112）：auto = 取背景的色相现算（米色→赭、护眼绿→墨绿、夜蓝→浅蓝）；
     blue = 保留老版那抹 iOS 蓝。切换只重写变量，不重建书架。 */
  const uiAccentSeg = body.querySelector('#setAccentMode');
  if (uiAccentSeg) {
    uiAccentSeg.querySelectorAll('.seg-btn').forEach(btn => btn.onclick = () => {
      Settings.uiAccentMode = btn.dataset.am === 'blue' ? 'blue' : 'auto';
      saveSettings();
      uiAccentSeg.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
      applyUiBg();
      toast(Settings.uiAccentMode === 'blue' ? '强调色固定为 iOS 蓝' : '强调色跟着背景色系走');
    });
  }
  const uiReset = body.querySelector('#uiBgReset');
  if (uiReset) uiReset.onclick = () => {
    // 重置 = 交回主题默认色（不是硬塞某个灰，否则用户会觉得「我没设它却变灰了」）
    // 封面浓度一起回 100%（同属「界面背景」这一组的东西，不清就得挨个再调回来）
    Settings.uiBg = ''; Settings.uiSideBg = ''; Settings.uiFg = ''; Settings.uiSideFg = '';
    Settings.uiCoverAlpha = 1; saveSettings(); buildSettingsPanel(); applyUiBg();
    toast('背景色已恢复默认');
  };
  const uiPick = body.querySelector('#uiBgPick');
  const uiFile = body.querySelector('#uiBgFile');
  if (uiPick && uiFile) {
    uiPick.onclick = () => uiFile.click();
    uiFile.onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        Settings.uiBgImg = await shrinkImageFile(f, 1600, 0.82);
        saveSettings(); buildSettingsPanel(); applyUiBg();
        toast('背景图已换好（浓度可调）');
      } catch (err) {
        toast('这张图片读不出来：' + ((err && err.message) || err));
      }
    };
  }
  const uiClear = body.querySelector('#uiBgClear');
  if (uiClear) uiClear.onclick = () => {
    Settings.uiBgImg = ''; saveSettings(); buildSettingsPanel(); applyUiBg();
    toast('已去掉背景图');
  };
  const uiAlpha = body.querySelector('#uiBgAlpha');
  if (uiAlpha) uiAlpha.oninput = e => {
    Settings.uiBgAlpha = parseFloat(e.target.value) / 100;
    const v = body.querySelector('#vUiBgAlpha');
    if (v) v.textContent = Math.round(Settings.uiBgAlpha * 100) + '%';
    saveSettings(); applyUiBg();
  };
  // 封面浓度：只改 CSS 变量，不重建书架（拖动时才不会一顿一顿地重绘全部书卡）
  const uiCov = body.querySelector('#uiCoverAlpha');
  if (uiCov) uiCov.oninput = e => {
    Settings.uiCoverAlpha = Math.max(0.1, parseFloat(e.target.value) / 100);
    const v = body.querySelector('#vUiCoverAlpha');
    if (v) v.textContent = Math.round(Settings.uiCoverAlpha * 100) + '%';
    saveSettings(); applyUiBg();
  };

  body.querySelectorAll('[data-hl]').forEach(n => n.onclick = () => {
    body.querySelectorAll('[data-hl]').forEach(x => x.classList.remove('sel'));
    n.classList.add('sel');
    // 以前只写进内存变量（window._hlColor），重开就回到第一个 —— 用户以为「选了没用」。
    // 现在存进设置，并立刻同步给划词工具条。
    Settings.hlColorIdx = parseInt(n.dataset.idx, 10) || 0;
    window._hlColor = n.dataset.hl;
    saveSettings();
    toast('默认高亮色：' + n.dataset.hl);
  });

  // 恢复滚动位置（#10：避免重建面板时整面板下滑/跳顶）。
  // 配合 CSS 的 overflow-anchor:none：换主题/字体后内容高度变化时有发生「滚动锚定」把视觉位置
  // 钉到边缘导致 scrollTop 漂移；关掉锚定 + 这里显式还原，二者合力保证守恒。
  if (body) body.scrollTop = _keepScroll;
}

/** 当前要共享的书 id；null = 全部。由 openShareSheet / sharePick 维护 */
let _shareIds = null;
/** 本机地址：{ ips:[], port, lan } */
let _myAddr = null;

/* 复制文本：局域网 http 不是安全上下文，navigator.clipboard 不可用，需要 execCommand 兜底 */
async function copyText(t) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch (e) { /* 落到下面 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

/** 读出本机在局域网里的地址，显示在共享页面上方便复制 */
async function loadMyAddr() {
  const box = $('shareAddrList');
  if (!box) return null;
  box.textContent = '读取中…';
  try {
    const r = await fetch('/api/share/myaddr', { cache: 'no-store' }).then(x => x.json());
    if (!r.ok) throw new Error(r.err || '取不到地址');
    _myAddr = { ips: r.ips || [], port: r.port, lan: !!r.lan };
    const hint = $('shareAddrHint');
    if (hint) {
      hint.innerHTML = r.lan
        ? '对方在「地址」里填上面任意一个即可（标「推荐」的最稳）。'
          + '<br>这行是内网地址，发截图 / 录屏前可以抹掉，不影响使用。'
        : '<span style="color:var(--ios-red)">当前只监听本机，对方连不上。请用 <code>python tools/serve.py 8123 --lan</code> 重新启动。</span>';
    }
    box.innerHTML = (_myAddr.ips.length ? _myAddr.ips : ['127.0.0.1'])
      .map((ip, i) => `<div class="addr-row"><code>${esc(ip)}:${_myAddr.port}` +
        (i === 0 ? ' <span class="addr-tag">推荐</span>' : '') + `</code>` +
        `<button class="btn-plain" data-addr="${esc(ip)}:${_myAddr.port}" style="padding:2px 8px;font-size:12px">复制</button></div>`)
      .join('');
    box.querySelectorAll('[data-addr]').forEach(b => {
      b.onclick = async () => {
        toast(await copyText(b.dataset.addr) ? '已复制 ' + b.dataset.addr : '复制失败，请手动选中');
      };
    });
    return _myAddr;
  } catch (e) {
    // 纯静态部署（GitHub Pages 之类）没有 /api/share 这套中继，
    // 服务器会返回 404 的 HTML，JSON 解析就炸了 —— 这时要给"为什么"而不是抛一句解析错误
    const m = e.message || '';
    const isStatic = /DOCTYPE|Unexpected token|Unexpected end of JSON/i.test(m);
    box.innerHTML = isStatic
      ? '<span style="color:var(--ios-gray)">当前是纯静态部署（没有共享中继服务），' +
        '局域网共享不可用。<br>需要这个功能请用本地服务器打开：' +
        '<code>python tools/serve.py 8123 --lan</code></span>'
      : esc('取不到本机地址：' + m);
    return null;
  }
}

/**
 * 打开共享面板。
 * @param {string[]|null} ids 要共享的书；null 或空 = 全部
 */
function openShareSheet(ids) {
  const sheet = $('shareSheet');
  if (!sheet) return;
  _shareIds = (Array.isArray(ids) && ids.length) ? ids.slice() : null;
  document.querySelectorAll('#shareSeg .seg-btn')
    .forEach(x => x.classList.toggle('active', x.dataset.role === 'host'));
  $('shareHostPane').hidden = false;
  $('shareClientPane').hidden = true;
  if ($('shareDevicePane')) $('shareDevicePane').hidden = true;
  if (!$('shareName').value) $('shareName').value = '墨阅书库';
  sheet.hidden = false;
  if (Library.selectMode) Library.setSelectMode(false);
  renderShareScope();
  loadMyAddr();
}

/** 把「到底共享了哪几本」写回面板，避免黑箱 */
function renderShareScope() {
  const el = $('shareScopeList');
  if (!el) return;
  if (!_shareIds) { el.textContent = '全部书籍（新导入的书也会自动加入）'; return; }
  const bs = _shareIds.map(id => Library.all.find(x => x.id === id));
  /* R132（第 5 条）：选中的几本里如果有同名的，光写书名等于没写 —— 补上书号尾号和格式。 */
  const key = b => String((b && b.title) || '').trim().toLowerCase();
  const cnt = new Map();
  bs.forEach(b => { if (b) cnt.set(key(b), (cnt.get(key(b)) || 0) + 1); });
  const names = bs.map(b => {
    if (!b) return '（已删除）';
    if ((cnt.get(key(b)) || 0) < 2) return b.title;
    const tail = String(b.id || '').replace(/[^0-9a-zA-Z]/g, '').slice(-6);
    return b.title + '（#' + tail + (b.format ? '·' + String(b.format).toUpperCase() : '') + '）';
  });
  el.textContent = names.length ? names.join('、') : '（一本都没选）';
}

/* ============================================================
   整库备份 / 恢复
   ============================================================ */
function bindBackup() {
  const sheet = $('backupSheet');
  if (!sheet) { console.warn('bindBackup: 未找到 #backupSheet，跳过'); return; }

  // 备份范围：null = 整库；Set = 只备份这几本
  let scope = null;

  const renderScope = async () => {
    const bs = await DB.getAll('books');
    const txt = $('backupScopeTxt'), list = $('backupScopeList'),
      hint = $('backupScopeHint'), btn = $('backupExport');
    if (scope && scope.size) {
      const sel = bs.filter(b => scope.has(b.id));
      txt.innerHTML = `备份范围：<b>只备份勾选的 ${sel.length} 本</b>`;
      list.textContent = sel.map(b => b.title).join('、');
      hint.textContent = '这些书的内容 + 它们的笔记书签会打进 zip；收藏夹和设置也会附上。';
      btn.textContent = `⬆️ 导出这 ${sel.length} 本`;
    } else {
      txt.innerHTML = `备份范围：<b>整库（${bs.length} 本）</b>`;
      list.textContent = '';
      hint.innerHTML = '点右边的「选择书籍…」可以只备份某几本。' +
        '书架上先勾选几本再点备份，也会自动带过来。';
      btn.textContent = '⬆️ 导出整库备份';
    }
  };

  const stat = async () => {
    const bs = await DB.getAll('books');
    const el = $('backupStat');
    if (el) {
      if (!bs.length) { el.textContent = '当前书库是空的。'; }
      else {
        const nComic = bs.filter(b => b.format === 'comic').length;
        const pages = bs.reduce((a, b) =>
          a + (b.format === 'comic' ? ((b.content && b.content.items) || []).length : 0), 0);
        el.innerHTML = `当前：<b>${bs.length}</b> 本书` +
          (nComic ? `（其中漫画 ${nComic} 本 / ${pages} 页）` : '') +
          ` · 收藏夹 ${Library.collections.length} 个`;
      }
    }
    await renderScope();
  };

  /** 打开备份面板；ids 为空则默认整库 */
  const openSheet = async (ids) => {
    scope = (ids && ids.length) ? new Set(ids) : null;
    sheet.hidden = false;
    $('backupTip').textContent = '';
    await stat();
  };
  bindBackup.open = openSheet;

  $('backupBtn').onclick = async () => {
    // 书架上正在多选 → 直接把这些书带进备份范围
    const picked = (Library.selectMode && Library.selected.size)
      ? Library.selectedBooks().map(b => b.id) : null;
    await openSheet(picked);
  };
  $('backupClose').onclick = () => { sheet.hidden = true; };
  // 阅读器（含自适应全屏）顶栏的 💾 按钮：与书库侧栏的备份入口同一套
  const rbB = $('readerBackupBtn');
  if (rbB) rbB.onclick = () => bindBackup.open(null);

  $('backupPick').onclick = async () => {
    const bs = await DB.getAll('books');
    if (!bs.length) { toast('书库是空的'); return; }
    bs.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastReadAt || 0) - (a.lastReadAt || 0));
    const cur = scope ? new Set(scope) : new Set(bs.map(b => b.id));
    showMultiPick('勾选要备份的书', bs.map(b => ({
      id: b.id,
      name: (b.format === 'comic' ? '🖼 ' : b.format === 'pdf' ? '📕 ' : '📖 ') + b.title
    })), cur, (ids) => {
      const pick = (ids && ids.length) ? ids : Array.from(cur);
      scope = (pick.length === bs.length) ? null : new Set(pick);
      renderScope();
    });
  };

  $('backupExport').onclick = async () => {
    try {
      loading(true, '正在打包…');
      const r = (scope && scope.size)
        ? await Backup.exportIds(Array.from(scope), (p, m) => loading(true, m))
        : await Backup.exportAll((p, m) => loading(true, m));
      loading(false);
      const mb = (r.size / 1048576).toFixed(1);
      let extra = '';
      if (r.errors && r.errors.length) {
        extra = `<br><span style="color:#FF9F0A">⚠ ${r.errors.length} 本打包失败：` +
          esc(r.errors.map(e => e.title).join('、')) + '</span>';
      }
      $('backupTip').innerHTML =
        `<b style="color:#34C759">已导出 ${r.count} 本</b>（${mb} MB）` +
        ` · 收藏夹 ${r.collections} 个` + (r.hasSettings ? ' · 含阅读设置' : '') + `<br>` +
        `文件名：<code>${esc(r.name)}</code><br>` +
        (r.partial ? '这是「选书备份」，恢复时可「合并导入」也可「清空并只还原这几本」。<br>' : '') +
        // R84：收藏夹为空时提前提醒 —— 否则这份备份以后永远恢复不出收藏夹
        (!r.collections
          ? `<span style="color:#FF9F0A">⚠ 当前没有任何收藏夹，这份备份里也不会包含收藏夹。</span><br>`
          : '') +
        '建议存到网盘或另一台设备，别只留在下载目录里。' + extra;
      toast(`已导出 ${r.count} 本` + (r.errors && r.errors.length ? `（${r.errors.length} 本失败）` : ''));
    } catch (e) {
      loading(false);
      $('backupTip').textContent = '导出失败：' + e.message;
      toast('导出失败：' + e.message);
    }
  };

  /**
   * 恢复一份备份 zip（R68）
   * 两个入口共用：设置里「恢复备份」，以及用户在「导入书籍」里误选备份包时自动转过来。
   * 返回值：成功时是 Backup.importAll 的结果，取消 / 不是备份时是 null。
   */
  const restoreFile = async (f) => {
    if (!f) return null;
    try {
      // 先只读 manifest，决定后续文案（避免 confirm 在 WebView 里被吞掉导致两种模式都没反应）
      loading(true, '正在读取备份…');
      const JSZip = await Backup.ensureJSZip();
      const zip = await JSZip.loadAsync(f);
      const mf = zip.file('manifest.json');
      loading(false);
      if (!mf) {
        const tip = '这不是墨阅的备份（缺 manifest.json）。只是要添加书籍的话，用「导入」而不是「恢复备份」。';
        $('backupTip').textContent = '恢复失败：' + tip;
        toast(tip, 8000);
        return null;
      }
      const manifest = JSON.parse(await mf.async('string'));
      const partial = !!manifest.partial;
      const nBooks = (manifest.books || []).length;
      /* R84：备份里到底有没有收藏夹，必须在「选模式」这一步就摆到明面上。
         用户报的「收藏夹恢复备份时恢复不成功」，真相是他那份备份的 manifest 里
         collections 就是空的（导出时 kv 被清过，见 backup.js exportBooks 注释），
         恢复自然一个都回不来；而界面一路报「✅ 合并完成」，谁也不知道发生了什么。 */
      const mColls = Array.isArray(manifest.collections) ? manifest.collections : [];
      const nColls = mColls.length;
      const collNote = nColls
        ? ` · 收藏夹 ${nColls} 个`
        : ' · 这份备份里没有收藏夹';

      // R71：「想留两份同一本书，各带各的书签笔记」也得有得选。
      // R72：这个选择原来藏在第二层（先问合并/覆盖，选了合并再问合并/另存），
      // 从「导入书籍」拖备份 zip 进来的人根本不知道还有第二步 —— 用户原话
      // 「导入图书那里如果导入 zip 也可以有是否合并的选择」。现在一次问清：
      // 有重复书时第一层就摆出「另存一份」，没重复就不摆这个多余选项。
      let dups = [];
      try { dups = await Backup.dupTitles(manifest); } catch (e) { dups = []; }
      const hasDup = dups.length > 0;

      const items = [{
        label: partial
          ? '合并（推荐）：只补进当时勾选的几本，书库其它书都保留'
          : '合并（推荐）：只补进库里没有的（按「书籍 ID」认书），不删任何东西',
        mode: 'merge', dupMode: 'merge'
      }];
      if (hasDup) {
        items.push({
          label: '每本都另存一份：已有的 ' + dups.length + ' 本（如《' + dups[0] + '》）再存一份，'
            + '各带各的书签笔记（标题加「（恢复 2）」）',
          mode: 'merge', dupMode: 'new'
        });
      }
      items.push({
        label: partial
          ? '清空并只还原这几本：先清空整库，没备份的书会永久删除'
          : '覆盖：先清空书库（书 / 笔记 / 收藏夹全删），再整库还原',
        mode: 'replace'
      });
      items.push({ label: '取消，什么都不做', mode: null });

      const head = partial ? '怎么恢复备份？（选书备份 · 共 ' + nBooks + ' 本' : '怎么恢复备份？（共 ' + nBooks + ' 本';
      const title = head + collNote + (hasDup ? '，其中 ' + dups.length + ' 本已在书库里' : '') + '）';

      // 用页面内弹窗选模式（替代 confirm，iPad / WebView 上才可靠）
      const pick = await new Promise((resolve) => {
        showChoice(title, items.map(x => x.label), 0, (i) => resolve(items[i] || null));
      });
      if (!pick || !pick.mode) { toast('已取消恢复'); return null; }
      const mode = pick.mode;
      const dupMode = pick.dupMode || 'merge';

      if (mode === 'replace') {
        const ok = await new Promise((resolve) => {
          showChoice('⚠ 此操作不可撤销', [
            '我确定：清空当前书库，再' + (partial ? '只还原备份里的这几本' : '整库还原') +
              '（没备份的书会永久丢失）',
            '再想想：什么都不做，返回'
          ], 1, (i) => resolve(i === 0));
        });
        if (!ok) { toast('已取消覆盖'); return null; }
      }

      loading(true, '正在导入…');
      const r = await Backup.importAll(f, mode, (p, m) => loading(true, m), { dupMode });
      loading(false);
      await loadSettings();
      await Library.refresh();
      $('backupTip').innerHTML = buildImportResult(r);
      try { if (typeof stat === 'function') await stat(); } catch (e) { }
      toast(`已恢复 ${r.added} 本` +
        (r.savedAsNew ? `（其中 ${r.savedAsNew} 本另存为新书）` : '') +
        (r.skipped ? `，${r.skipped} 本已在库里` : '') +
        (r.annots ? `、标记 ${r.annots} 条` : '') +
        (r.inkStrokes ? `、手迹 ${r.inkStrokes} 笔` : '') +
        (r.mergedAnnots ? `（并入 ${r.mergedAnnots} 条）` : '') +
        // R84：收藏夹结果也要蹦出来，不能只写在面板里
        (r.collAdded || r.collUpdated ? `、收藏夹 ${r.collAdded + r.collUpdated} 个` : '') +
        (!r.collsInBackup ? '｜这份备份里没有收藏夹' : ''), 8000);
      return r;
    } catch (e) {
      loading(false);
      $('backupTip').textContent = '恢复失败：' + e.message;
      toast('恢复失败：' + e.message, 8000);
      return null;
    }
  };
  // 给「导入书籍」那条路径用（它在别的函数里，运行时才调）
  bindBackup.restoreFile = restoreFile;

  $('backupImport').onclick = () => {
    const inp = $('backupInput');
    inp.value = '';
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if (f) restoreFile(f);
    };
    inp.click();
  };

  /** 一键清空全部：永久删除当前书库（书 / 笔记 / 收藏夹 / 设置），二次确认防误触 */
  $('backupClearAll').onclick = async () => {
    const bs = await DB.getAll('books');
    if (!bs.length) { toast('书库本来就是空的'); return; }
    const n = bs.length;
    const ok = await new Promise((resolve) => {
      showChoice('⚠ 一键清空全部', [
        `我确定：永久删除当前 ${n} 本书及其全部笔记、书签、收藏夹和设置（不可恢复）`,
        '再想想：什么都不做，返回'
      ], 1, (i) => resolve(i === 0));   // 默认高亮「再想想」
    });
    if (!ok) { toast('已取消清空'); return; }
    loading(true, '正在清空…');
    try {
      await DB.wipe();            // 清 books + annots + kv（收藏夹/设置都在 kv）
      await loadSettings();
      await Library.refresh();    // 重新载入书架 + 收藏夹
      await stat();               // 刷新面板统计
      $('backupTip').innerHTML =
        `<b style="color:#FF3B30">已清空全部 ${n} 本</b>` +
        `（书 / 笔记 / 收藏夹 / 设置已删除，无法恢复）。`;
      toast('已清空书库');
    } catch (e) {
      $('backupTip').textContent = '清空失败：' + e.message;
      toast('清空失败：' + e.message);
    }
    loading(false);
  };
}

/** 把导入结果翻译成大白话，避免「这是选书备份，已按合并导入…」让人看不懂 */
function buildImportResult(r) {
  const ink = r.inkStrokes ? `、手迹 ${r.inkStrokes} 笔` : '';
  /* R84：收藏夹必须单独交代。备份里压根没有收藏夹时（旧包 / 导出时 kv 被清过），
     恢复只会还原书，收藏夹一个都不会动 —— 这时如果还只报「✅ 完成」，
     用户就会像这次一样以为「收藏夹恢复不成功」而不知道原因。 */
  const nBag = r.collsInBackup || 0;
  const collLine = nBag
    ? `<br>收藏夹：备份里 ${nBag} 个` +
      (r.collAdded || r.collUpdated
        ? `，${[r.collAdded ? '新增 ' + r.collAdded + ' 个' : '',
             r.collUpdated ? '更新 ' + r.collUpdated + ' 个' : '']
            .filter(Boolean).join('，')}`
        : '，和现在一致（不重复添加）')
    : `<br><span style="color:#FF9F0A">⚠ 这份备份里没有收藏夹</span>` +
      `<span style="opacity:.85">（导出它的时候收藏夹是空的），所以收藏夹不会有任何变化。` +
      `要找回收藏夹，请用更早的、当时还有收藏夹的备份再恢复一次：合并模式只补缺少的东西，书不会重复。</span>`;
  const setLine = r.settingsRestored ? '<br>阅读设置：已按备份恢复' : '';

  if (r.replaced) {
    return `<b style="color:#34C759">✅ 已清空并重新导入</b><br>` +
      (r.partial ? `这是「选书备份」，已清空整库、只还原了备份里的这几本（新增 ${r.added} 本）。` : `已整库还原（新增 ${r.added} 本）。`) +
      ` 笔记 / 书签 ${r.annots} 条${ink}。` + collLine + setLine;
  }
  // 合并
  return `<b style="color:#34C759">✅ 合并完成</b><br>` +
    `新增 ${r.added} 本` +
    (r.savedAsNew ? `（其中 ${r.savedAsNew} 本另存为一份，各带各的书签）` : '') +
    (r.skipped ? `，跳过已存在的 ${r.skipped} 本` : '') +
    `，笔记 / 书签 ${r.annots} 条${ink}。` +
    (r.mergedAnnots ? `<br><span style="opacity:.75">其中 ${r.mergedAnnots} 条标注并进了已存在的书（不会重复画）。</span>` : '') +
    (r.partial ? `<br><span style="color:#FF9F0A">你原来没备份的书都还在，没有被删除。</span>` : '') +
    collLine + setLine;
}

/* ============================================================
   局域网加密共享
   ============================================================ */
function bindShare() {
  const sheet = $('shareSheet');
  if (!sheet) { console.warn('bindShare: 未找到 #shareSheet，跳过'); return; }
  $('shareBtn').onclick = () => openShareSheet(null);
  // 阅读器（含自适应全屏）顶栏的 📡 按钮：与书库侧栏的共享入口同一套
  const rsB = $('readerShareBtn');
  if (rsB) rsB.onclick = () => openShareSheet(null);
  if ($('shareClose')) $('shareClose').onclick = () => { sheet.hidden = true; };

  // 点「刷新」重新读本机地址
  if ($('shareAddrRefresh')) $('shareAddrRefresh').onclick = () => loadMyAddr();

  /* 共享内容三开关（R66）：笔记 / 手迹 / 目录。勾选即存 Settings；
     已经开着共享时改，立刻重发书单，让对方的列表标签跟着变。 */
  function shareOptsFromUI() {
    return {
      notes: $('shOptNotes') ? $('shOptNotes').checked : true,
      ink: $('shOptInk') ? $('shOptInk').checked : false,
      toc: $('shOptToc') ? $('shOptToc').checked : true
    };
  }
  function applyShareOptsUI() {
    const o = Settings.shareOpts || { notes: true, ink: false, toc: true };
    if ($('shOptNotes')) $('shOptNotes').checked = o.notes !== false;
    if ($('shOptInk')) $('shOptInk').checked = !!o.ink;
    if ($('shOptToc')) $('shOptToc').checked = o.toc !== false;
  }
  let _shareHostCtx = null;   // 开启共享后要反复重画的提示：{id, n, addrs, scopeNote}

  /** 「内容：书本身 + 目录 + 笔记…」这行文字 */
  function shareOptsText(o) {
    o = o || Share.opts || shareOptsFromUI();
    const parts = ['书本身'];
    if (o.toc !== false) parts.push('目录');
    if (o.notes) parts.push('笔记/高光/书签');
    if (o.ink) parts.push('手迹');
    return parts.join(' + ');
  }

  /** 用当前状态重画「共享已开启」那段（改共享内容后要跟着变，别再显示旧口径） */
  function paintShareHostTip() {
    const box = $('shareHostTip');
    if (!box || !_shareHostCtx) return;
    const c = _shareHostCtx;
    box.innerHTML =
      '<b style="color:#34C759">共享已开启</b><br>' +
      '本机地址：<code id="myAddrText">' + esc(c.addrs) + '</code> ' +
      '<button class="btn-plain" data-copy="addr" style="padding:2px 8px;font-size:12px">复制</button><br>' +
      '共享 ID：<code id="sidText">' + esc(c.id) + '</code> ' +
      '<button class="btn-plain" data-copy="sid" style="padding:2px 8px;font-size:12px">复制</button><br>' +
      '<button class="btn-plain" id="copyInvite" data-copy="invite" style="padding:4px 10px;font-size:12px;margin-top:4px">📋 复制邀请信息（地址 + ID）</button><br>' +
      '本次共享 <b>' + c.n + '</b> 本' + esc(c.scopeNote) + '。<br>' +
      '内容：<b id="shareOptsNow">' + esc(shareOptsText()) + '</b>' +
      '<span style="opacity:.75">（在上面「共享内容」里勾选，立刻生效）</span><br>' +
      '把 <b>地址 + 共享 ID + 密码</b> 告诉对方即可（密码请另外单独告知）。<br>' +
      '<span style="opacity:.75">保持本页面打开，对方下载时才能响应。</span>';
  }

  // 复制按钮用事件委托：重画后不用重新绑
  if ($('shareHostTip')) {
    $('shareHostTip').onclick = async (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-copy]') : null;
      if (!btn || !_shareHostCtx) return;
      const c = _shareHostCtx;
      const t = btn.dataset.copy === 'addr' ? c.addrs
        : btn.dataset.copy === 'sid' ? c.id
          : `墨阅共享\n地址：${c.addrs}\n共享 ID：${c.id}\n密码：（单独告诉你）`;
      toast(await copyText(t) ? '已复制' : '复制失败，请手动选中');
    };
  }

  /* R134：共享名称改了也不用重新开共享 —— 失焦或回车就把新名字发上去。
     重新开启会换共享 ID，等于要让对方重新输一遍，代价太大。 */
  if ($('shareName')) {
    const commitName = async () => {
      const nm = $('shareName').value.trim() || '墨阅书库';
      if (!Share.id || (Share.name || '') === nm) return;
      try {
        await Share.hostPublish(_shareIds, shareOptsFromUI(), nm);
        toast('共享名称已改为「' + nm + '」');
      } catch (e) { toast('改名失败：' + e.message); }
    };
    $('shareName').onchange = commitName;
    $('shareName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('shareName').blur(); }
    });
  }

  applyShareOptsUI();
  ['shOptNotes', 'shOptInk', 'shOptToc'].forEach(oid => {
    const el = $(oid);
    if (!el) return;
    el.onchange = async () => {
      const o = shareOptsFromUI();
      Settings.shareOpts = o;
      // R69：同步到「正在跑的这次共享」。以前只存了 Settings，Share.opts 还是开共享时的旧值，
      // 于是勾选换了、实际发出去的还是老口径 —— 这里必须改 Share.opts 本身。
      Share.setOpts(o);
      await saveSettings();
      paintShareHostTip();
      if (Share.id) {
        try {
          await Share.hostPublish(_shareIds, o);
          toast('共享内容已更新：' + shareOptsText(o));
        } catch (e) { toast('更新失败：' + e.message); }
      }
    };
  });

  // 「更改…」：挑出要共享的几本
  if ($('sharePick')) $('sharePick').onclick = async () => {
    const books = await DB.getAll('books');
    if (!books.length) { toast('书库还是空的'); return; }
    const cur = new Set(_shareIds || books.map(b => b.id));
    // R132（第 5 条）：选择框里也一样 —— 同名书补上书号尾号 + 格式，否则勾谁都一样
    const k2 = b => String(b.title || '').trim().toLowerCase();
    const c2 = new Map();
    books.forEach(b => c2.set(k2(b), (c2.get(k2(b)) || 0) + 1));
    showMultiPick('选择要共享的书', books.map(b => ({
      id: b.id,
      name: (c2.get(k2(b)) || 0) < 2 ? b.title
        : b.title + '（#' + String(b.id || '').replace(/[^0-9a-zA-Z]/g, '').slice(-6)
          + (b.format ? '·' + String(b.format).toUpperCase() : '') + '）'
    })), cur, async (ids) => {
      const next = (ids || []).slice();
      if (!next.length) { toast('至少勾一本；一本都不想共享就点「停止共享」'); return; }
      _shareIds = next;
      renderShareScope();
      /* R134：范围改了不用重新开共享。以前只换了内存里的 _shareIds，服务端那份书单还是旧的，
         对方得等你「停止 → 再开启」（还会换 ID）才看得到。现在直接把新书单重发一遍。 */
      if (!Share.id) return;
      try {
        await Share.hostPublish(_shareIds, shareOptsFromUI());
        if (_shareHostCtx) {
          _shareHostCtx.n = next.length;
          _shareHostCtx.scopeNote = '（仅勾选的，不是全部书库）';
          paintShareHostTip();
        }
        toast('共享范围已更新：' + next.length + ' 本（对方刷新列表即可看到）');
      } catch (e) {
        toast('范围更新失败：' + e.message);
      }
    }, { searchable: true, placeholder: '搜索书名 / 格式，空格可分隔' });
  };

  document.querySelectorAll('#shareSeg .seg-btn').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('#shareSeg .seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const role = b.dataset.role || 'host';
      $('shareHostPane').hidden = role !== 'host';
      $('shareClientPane').hidden = role !== 'client';
      const dp = $('shareDevicePane');
      if (dp) dp.hidden = role !== 'device';
      if (role === 'device') paintDevCur();
    };
  });

  /* -------------------- 连到别的设备（R155） --------------------
     APK 里整页切到另一台的服务器；浏览器里就是一次普通跳转。
     切过去以后看到、改动的都是对方那本书库（不是副本）。 */
  const devList = $('devList');
  let _devItems = [];          // 当前列表（扫到的 + 上次配对过的）

  /** 把「上次配对过的设备」并进列表，省得每次都要重扫 */
  function mergeSavedPeers(items) {
    /* R168：合并 + 纠正地址交给 Peers.reconcile —— 它按 uid 认「同一台机器」，
       换了 IP 就改地址而不是再加一条（用户截图里「两个 windy」就是这么来的：
       路由器把 192.168.1.5 换成 10.0.0.7，旧的没删、新的又记了一条）。 */
    if (typeof Peers !== 'undefined' && Peers.reconcile) return Peers.reconcile(items);
    return (items || []).slice();
  }

  function agoText(ts) {
    if (!ts) return '还没对过账';
    const d = Date.now() - ts;
    if (d < 60000) return '刚刚对过账';
    if (d < 3600000) return Math.round(d / 60000) + ' 分钟前对过账';
    if (d < 86400000) return Math.round(d / 3600000) + ' 小时前对过账';
    return Math.round(d / 86400000) + ' 天前对过账';
  }

  /** 本机在局域网里的地址：以前这里写死 127.0.0.1:8123，手机和电脑显示一模一样，
   *  用户以为「检测到了」其实什么都没读。现在真的问一遍：
   *    · serve.py /api/share/myaddr（后端实际监听的端口 + 各网卡 IP）
   *    · APK 再补一份原生 lanIps()（Python 常只报 127.0.0.1）
   *  拿不到就直说「没检测到」，不再假装有一个地址。 */
  async function myLanAddr() {
    let ips = [], port = Number(location.port) || 8123;
    try {
      const r = await fetch('/api/share/myaddr', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        ips = Array.isArray(j.ips) ? j.ips.slice() : [];
        port = Number(j.port) || port;
      }
    } catch (e) { }
    if (window.InkAndroid && window.InkAndroid.lanIps) {
      try {
        String(window.InkAndroid.lanIps() || '').split(',')
          .map(s => s.trim()).filter(Boolean)
          .forEach(ip => { if (ips.indexOf(ip) < 0) ips.push(ip); });
      } catch (e) { }
    }
    const good = ips.filter(ip => !/^127\./.test(ip) && !/^169\.254\./.test(ip));
    return { ip: good[0] || '', ips, port };
  }

  let _devMyAddr = null;

  async function paintDevCur() {
    const el = $('devCurList');
    if (!el) return;
    const local = Device.isLocal();
    if (!local) {
      el.innerHTML = '现在连的是 <b>' + esc(String(location.host)) + '</b> 的书库 · 本机那份没动';
    } else {
      el.innerHTML = '本机书库 · 正在读本机地址…';
      const a = _devMyAddr || await myLanAddr();
      _devMyAddr = a;
      const tail = a.ip
        ? (a.ip + ':' + a.port)
        : ('127.0.0.1:' + (location.port || 8123));
      el.innerHTML = '本机书库 · <b data-copy="' + esc(tail) + '" title="点一下复制，填到另一台那台">'
        + esc(tail) + '</b>'
        + (a.ip ? ' <span class="share-tip" style="padding:0">（同一 WiFi 的另一台填这个）</span>'
          : ' <span class="share-tip" style="padding:0">（没读到局域网地址：没连 WiFi？）</span>');
      el.querySelectorAll('[data-copy]').forEach(n => {
        n.style.cursor = 'pointer';
        n.onclick = async () => {
          const t = n.dataset.copy;
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(t);
            else throw new Error('no clipboard');
            toast('已复制：' + t);
          } catch (e) {
            toast('复制不了，长按自己选：' + t);
          }
        };
      });
    }
    const back = $('devBackBtn');
    if (back) back.hidden = local;
    /* 以前这里会把 location.host 填进「对方地址」—— 用户截图/录屏发人就等于
       把自己的内网 IP 一起发出去了。地址栏留空，占位符用 xxx 示意格式。 */
    if (!_devItems.length) {
      const saved = mergeSavedPeers([]);
      if (saved.length) {
        paintDevList(saved);
        probeSaved(saved);      // R168：悄悄探一遍，换过 IP 的记录自己改过来
      }
    }
  }

  /** 打开「连到别的设备」时，对存过的地址各发一次轻探活（1.8 秒超时，不挡界面）。
      R168：路由器重新分配 IP 后，旧记录只有靠这一步才会自动更新成新地址 ——
      以前必须点「自动发现」扫 254 个地址，很多人根本不会点。 */
  let _probeAt = 0;
  async function probeSaved(items) {
    if (typeof Peers === 'undefined' || !items || !items.length) return;
    if (Date.now() - _probeAt < 60000) return;    // 一分钟内不重复探（这个面板会被反复重绘）
    _probeAt = Date.now();
    const live = [];
    await Promise.all(items.map(async d => {
      try {
        const info = await probePeer(d.ip + ':' + d.port, 1800);
        if (info && info.uid) {
          live.push({
            uid: info.uid, name: info.name || d.name || '',
            ip: d.ip, port: d.port, sharing: !!info.on,
            saved: true, at: d.at || 0
          });
        }
      } catch (e) { }
    }));
    if (!live.length) return;
    const merged = mergeSavedPeers(live);
    const key = a => a.map(x => x.ip + ':' + x.port).join(',');
    if (key(merged) !== key(_devItems)) paintDevList(merged);   // 没变化就别重绘，免得闪
  }

  function paintDevList(items) {
    if (!devList) return;
    /* R167：把「这台自己」剔出去。用户看到 127.0.0.1 也列在「别的设备」里，
       点了对账不用输密码（本来就是本机），观感就是「怎么不要密码了」。
       列表只该有别的人。 */
    const selfBase = (typeof location !== 'undefined') ? (location.protocol + '//' + location.host) : '';
    const onlyOthers = (items || []).filter(d => {
      if (!selfBase) return true;
      const k = (typeof Peers !== 'undefined') ? Peers.base(d.ip + ':' + d.port) : ('http://' + d.ip + ':' + d.port);
      return k !== selfBase;
    }).filter((d, i, arr) => {
      /* R168：同一台机器（同 uid）只显示一行。reconcile 已经合并过，
         这里再兜一层 —— 有些条目是从别处拼进来的，uid 可能重复。 */
      if (!d.uid) return true;
      return arr.findIndex(x => x.uid === d.uid) === i;
    });
    _devItems = onlyOthers;
    if (!_devItems.length) {
      devList.innerHTML = '<div class="share-tip" style="padding:0">没扫到别的设备。'
        + '确认两台在同一个 WiFi、对方那台开着墨阅；也可以在上面直接填地址。'
        + '<br>（这台自己的地址不会列在这里，本来也不用连。）</div>';
      return;
    }
    devList.innerHTML = _devItems.map((d, i) =>
      '<div class="share-item" data-i="' + i + '">'
      + '<div class="si-main"><b>' + esc(String(d.name || ('墨阅 · ' + d.ip))) + '</b>'
      + '<span>' + esc(String(d.ip)) + ':' + d.port
      + (d.sharing ? ' · 开着共享' : '')
      + (d.saved ? ' · ' + agoText(d.at) : '')
      + '</span></div>'
      + '<button class="btn-plain share-dl" data-sync="' + i + '" title="和这台互相对账（互补书、合并进度）">⇄ 对账</button>'
      + '<button class="btn-primary share-dl" data-conn="' + i + '">连接</button>'
      + '</div>').join('');
    devList.querySelectorAll('button[data-conn]').forEach(btn => {
      btn.onclick = () => connectDev(_devItems[+btn.dataset.conn]);
    });
    devList.querySelectorAll('button[data-sync]').forEach(btn => {
      btn.onclick = () => syncWithDev(_devItems[+btn.dataset.sync]);
    });
  }

  /** 设备面板上的一行状态（"正在连接…" / "连不上：…"），不遮挡列表 */
  function devStat(msg) {
    const el = $('devStat');
    if (!el) return;
    if (!msg) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = msg;
  }

  /** 敲一下对方的门。用 /api/share/discover-info：唯一放 CORS 的轻接口，
   *  谁都能问（不要求对方开着共享），几十毫秒就回。 */
  async function probePeer(addr, ms) {
    const base = (typeof Peers !== 'undefined') ? Peers.base(addr) : ('http://' + addr);
    const ctrl = ('AbortController' in window) ? new AbortController() : null;
    const to = ctrl ? setTimeout(() => ctrl.abort(), ms || 6000) : null;
    try {
      const r = await fetch(base + '/api/share/discover-info', {
        cache: 'no-store', signal: ctrl ? ctrl.signal : undefined
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json().catch(() => ({}));
      if (!j || !j.ok) throw new Error('对方回的看不懂');
      return j;
    } finally { if (to) clearTimeout(to); }
  }

  function connectDev(d) {
    if (!d) return;
    doConnect(d.ip + ':' + d.port, d.name || '');
  }

  /** 连接：先探活再跳转。
   *  以前点「连接」立刻整页跳走，网络不通时只剩浏览器自己的「无法访问」——
   *  用户根本分不清是地址写错、对方没开墨阅、还是两台不在同一个 WiFi。
   *  现在有「正在连接…」，连不上会当场说清并给「重试 / 重新扫」。 */
  async function doConnect(addr, name) {
    if (!addr) { toast('先填对方地址'); return; }
    const nm = name || addr;
    if (!confirm('切到「' + nm + '」（' + addr + '）的书库？\n\n'
      + '切过去以后看到和改动的都是对方那台的；随时能点「↩ 回到本机」回来。')) return;
    /* 先排除「这就是本页自己」：不用发请求（刚扫完 254 个地址时，
       浏览器的连接池可能还没缓过来，探自己反而要等好几秒）。 */
    const selfBase = (typeof Peers !== 'undefined') ? Peers.base(addr) : ('http://' + addr);
    if (selfBase === (location.protocol + '//' + location.host)) {
      devStat('⚠️ <b>' + esc(addr) + '</b> 就是这台自己，不用连。');
      toast('这是本机自己的地址');
      return;
    }
    let tries = 0;
    while (tries < 4) {
      tries++;
      devStat('⏳ 正在连接 <b>' + esc(addr) + '</b> …（最多等 6 秒）');
      loading(true, '正在连接 ' + addr + ' …');
      try {
        const info = await probePeer(addr, 6000);
        if (info && info.uid) {
          const me = await (async () => {
            try { const r = await fetch('/api/share/discover-info', { cache: 'no-store' }); return r.ok ? await r.json() : {}; }
            catch (e) { return {}; }
          })();
          if (me && me.uid && info.uid === me.uid) {
            loading(false);
            devStat('⚠️ <b>' + esc(addr) + '</b> 就是这台自己，不用连。');
            toast('这是本机自己的地址');
            return;
          }
        }
        loading(false);
        /* R170：连接也要密码。对方设了就当场说清 —— 否则跳过去被它的解锁页挡住，
           用户分不清是"要密码"还是"打不开"。 */
        let pwdNeeded = false;
        try {
          const st = (typeof Peers !== 'undefined' && Peers.needsPwd) ? await Peers.needsPwd(addr) : null;
          pwdNeeded = !!(st && st.set);
        } catch (e) { }
        devStat('✅ 已连上 ' + esc(info && info.name ? info.name : addr)
          + (pwdNeeded ? '，对方设了访问密码 —— 跳过去后先输一次（这台浏览器记 30 天）'
                       : '，正在打开…'));
        if (pwdNeeded) toast('「' + nm + '」设了访问密码，跳转后先输密码');
        // R168：连上了才记，并且带上对方自报的 uid —— 以后它换 IP 也是同一台
        if (typeof Peers !== 'undefined') Peers.remember(addr, (info && info.name) || name || '', (info && info.uid) || '');
        Device.go(addr);
        return;
      } catch (e) {
        loading(false);
        const why = (e && e.name === 'AbortError')
          ? '6 秒没回应。三种常见原因：① 两台不在同一个 WiFi；② 对方没开墨阅；'
            + '③ 这个 WiFi 禁止设备互访（校园网、宿舍网、公司网、酒店网最常见，'
            + '同一个 WiFi 也互相看不见）。可以改成用一台开热点，另一台连热点再试。'
          : (e && e.message ? e.message : String(e));
        devStat('❌ 连不上 <b>' + esc(addr) + '</b>：' + esc(why));
        /* R168：地址失效最常见的原因不是网络，而是「路由器给它换了个 IP」。
           以前只能取消，那条死地址永远留在列表里；现在给两条出路：
           重新扫一遍（扫到同 uid 会自动把地址改成新的）/ 直接删掉这一条。 */
        const pick = await askPick('连不上 ' + addr,
          ['重试一次', '🔍 自动发现（顺便更新地址）', '从列表删掉这条地址（不删书）', '取消']);
        if (pick === 1) {
          devStat('');
          const btn = $('devScanBtn');
          if (btn) btn.click();
          return;
        }
        if (pick === 2) {
          if (typeof Peers !== 'undefined') Peers.forget(addr);
          _devItems = _devItems.filter(x => (Peers.base(x.ip + ':' + x.port) !== Peers.base(addr)));
          paintDevList(_devItems);
          /* R170：原来看不出「移除」到底删了什么 —— 用户以为是删设备或删书。
             说清：只删这条连接记录，书/笔记一点没动；下次自动发现扫到它还会回来。 */
          devStat('已从列表删掉 <b>' + esc(addr) + '</b>：只去掉这条连接记录，'
            + '书和笔记一点没动，对方那台也不受影响。<br>下次点「自动发现」它还在线的话会重新出现。');
          toast('已删掉这条地址（书没动）');
          return;
        }
        if (pick !== 0) { devStat(''); return; }
      }
    }
    devStat('');
    toast('放弃连接 ' + addr);
  }

  /* R170：本页会话里已经验过密码的地址。刷新页面就清空 —— 用户要的是
     「每次打开墨阅，第一次连接/对账都得输」，而不是填一次后永远免密。 */
  const _pwdOkay = new Set();

  /** 对方设了访问密码：问一次、记在本机（按地址记，不影响本机自己的密码） */
  async function askPeerPwd(addr, hint) {
    let pwd = '';
    try {
      pwd = prompt('「' + addr + '」设了访问密码，填一下：\n'
        + (hint || '（这是「对方那台」设的密码，不是你本机的；只记在这台设备上）'), '') || '';
    } catch (e) { pwd = ''; }
    if (!pwd) return '';
    if (typeof Peers !== 'undefined') Peers.setPwd(addr, pwd);
    return pwd;
  }

  /** 和一台设备对账：两边的 data/ 互补，进度/笔记按「后改的赢」 */
  async function syncWithDev(d) {
    if (!d || typeof Peers === 'undefined') return;
    const addr = d.ip + ':' + d.port;
    const nm = d.name || addr;
    if (!confirm('和「' + nm + '」对账？\n\n'
      + '· 只有一边有的书会补到另一边\n'
      + '· 两边都有的书只比进度/书名/标签，不重传正文\n'
      + '· 笔记、收藏夹、设置按「后改的赢」整份覆盖\n\n'
      + '不会因为对账删书；删除按「谁先删的」跟着删（对方删过的会同步过来）。')) return;
    /* R170：对账前先确认「对方到底要不要密码」，本次会话必问一次。
       以前完全被动 —— 只有服务端回 401 才弹框，于是：
         · 对方没设密码 → 一路无声通过，用户问「怎么不要密码」；
         · 这台浏览器之前输过 → cookie 还在，同样无声通过。
       现在改成主动问：探测到对方设了密码就当场要一次；本页会话里记住，不重复烦。 */
    const pk = (typeof Peers !== 'undefined') ? Peers.base(addr) : addr;
    if (_pwdOkay === undefined || !_pwdOkay.has(pk)) {
      let st = null;
      try { st = (typeof Peers !== 'undefined' && Peers.needsPwd) ? await Peers.needsPwd(addr) : null; }
      catch (e) { st = null; }
      if (st && st.set) {
        devStat('🔒 「' + esc(nm) + '」设了访问密码（' + st.count + ' 个），先填一下');
        const pwd = await askPeerPwd(addr, '（对账要往对方写数据，必须单独验一次；这是对方那台的密码）');
        if (!pwd) { devStat(''); toast('没填密码，取消对账'); return; }
      } else if (st && !st.set) {
        devStat('ℹ️ 「' + esc(nm) + '」没设访问密码，所以这边不用填；建议在对方也设一个。');
      }
      if (_pwdOkay) _pwdOkay.add(pk);
    }
    let tried = 0;
    while (true) {
      devStat('⇄ 正在和 <b>' + esc(nm) + '</b> 对账…');
      loading(true, '正在对账…');
      try {
        const r = await Peers.syncOne(addr, m => {
          loading(true, m);
          devStat('⇄ 正在和 <b>' + esc(nm) + '</b> 对账 · ' + esc(m));
        });
        Peers.remember(addr, d.name || '', d.uid || '');
        await Peers.refreshLocal();
        loading(false);
        devStat('');
        const bits = [];
        if (r.pull) bits.push('收到 ' + r.pull + ' 本');
        if (r.push) bits.push('送出 ' + r.push + ' 本');
        if (r.meta) bits.push('更新 ' + r.meta + ' 本进度/书名');
        if (r.ann) bits.push('笔记 ' + r.ann + ' 份');
        if (r.kv) bits.push('设置/收藏夹 ' + r.kv + ' 项');
        if (r.del) bits.push('删除 ' + r.del + ' 项');
        if (r.fail) bits.push('失败 ' + r.fail);
        toast(bits.length ? ('对账完成：' + bits.join('，')) : '对账完成：两边已经一样了',
          r.fail ? 9000 : 5000);
        if (r.fail && r.err) console.warn('对账失败明细：', r.err);
        // R167：只刷「这一台」的时间。以前是整个列表一起刷，
        // 于是对账一次，旁边几台没参与的也显示「刚刚对过账」，看着像都成功过。
        const doneKey = (typeof Peers !== 'undefined') ? Peers.base(addr) : '';
        paintDevList(_devItems.map(x => {
          const k = (typeof Peers !== 'undefined') ? Peers.base(x.ip + ':' + x.port) : '';
          return (k && k === doneKey) ? Object.assign({}, x, { at: Date.now() }) : x;
        }));
        return;
      } catch (e) {
        loading(false);
        // 401：对方设了密码。问一次、记下来、原样重来（最多问两次，别死循环）
        if (e && e.needPwd && tried < 2) {
          tried++;
          devStat('🔒 「' + esc(nm) + '」需要对账密码');
          const pwd = await askPeerPwd(addr);
          if (pwd) continue;
          devStat('');
          toast('没填密码，取消对账');
          return;
        }
        devStat('❌ 对账失败：' + esc(e && e.message || e));
        // 密码错了两次：把记下的这个密码删掉，下次重新问，否则会一直拿错的去撞
        if (e && e.needPwd && typeof Peers !== 'undefined') Peers.setPwd(addr, '');
        toast('对账失败：' + e.message + '（对方那台开着墨阅吗？同一 WiFi 吗？密码对吗？）', 9000);
        return;
      }
    }
  }

  if ($('devScanBtn')) {
    $('devScanBtn').onclick = async () => {
      const btn = $('devScanBtn');
      const old = btn.textContent;
      btn.disabled = true;
      btn.textContent = '扫描中…';
      if (devList) devList.innerHTML = '<div class="share-tip" style="padding:0">正在扫同网段，最多十几秒…</div>';
      try {
        const items = await Device.discover((done, total) => {
          if (total) btn.textContent = '扫描中 ' + Math.min(99, Math.round(done * 100 / total)) + '%';
        });
        paintDevList(mergeSavedPeers(items));
      } catch (e) {
        if (devList) {
          devList.innerHTML = '<div class="share-tip" style="padding:0">扫描失败：'
            + esc(String(e && e.message || e)) + '</div>';
        }
      }
      btn.disabled = false;
      btn.textContent = old;
    };
  }

  if ($('devConnectBtn')) {
    $('devConnectBtn').onclick = () => {
      const v = ($('devAddr') && $('devAddr').value || '').trim();
      if (!v) { toast('先填对方地址：点上面的「🔍 自动发现」，或抄对方设备上「我的地址」那一行（xxx.xxx.xxx.xxx:8123）'); return; }
      const url = Device.urlOf(v);
      if (!url) { toast('地址看不懂：' + v); return; }
      const m = /^https?:\/\/([^/:]+)(?::(\d+))?/.exec(url);
      const clean = m ? (m[1] + ':' + (m[2] || 8123)) : v;
      /* R168：以前这里是「先记下、再连」—— 地址打不通也会被永久记进列表，
         所以换过 IP 的旧地址一直留着（用户看到的那条 192.168.1.5）。
         现在改成连成功后再记（doConnect 里带 uid），打不通的就别占地方。 */
      doConnect(clean, '');
    };
  }

  if ($('devBackBtn')) $('devBackBtn').onclick = () => Device.goLocal();
  paintDevCur();

  $('shareStart').onclick = async () => {
    const pwd = $('sharePwd').value;
    if (!pwd) { toast('请先设置共享密码'); return; }
    if (_shareIds && !_shareIds.length) { toast('还没选要共享的书'); return; }
    try {
      loading(true, '正在开启共享…');
      const id = await Share.hostStart(
        $('shareName').value.trim() || '墨阅书库', pwd, _shareIds, shareOptsFromUI());
      loading(false);
      const n = Share.allowedIds ? Share.allowedIds.size : (await DB.getAll('books')).length;
      const addr = _myAddr || await loadMyAddr();
      const addrs = (addr && addr.ips && addr.ips.length ? addr.ips : ['127.0.0.1'])
        .map(ip => `${ip}:${addr ? addr.port : location.port || 8123}`).join(' 或 ');
      _shareHostCtx = {
        id, n, addrs,
        scopeNote: Share.allowedIds ? '（仅勾选的，不是全部书库）' : '（全部书库）'
      };
      paintShareHostTip();
      $('shareStart').hidden = true;
      $('shareStopBtn').hidden = false;
    } catch (e) {
      loading(false);
      toast('开启失败：' + e.message);
    }
  };

  $('shareStopBtn').onclick = async () => {
    await Share.hostStop();
    _shareHostCtx = null;
    $('shareStart').hidden = false;
    $('shareStopBtn').hidden = true;
    $('shareHostTip').innerHTML = '共享已停止。';
    toast('已停止共享');
  };

  $('shareScan').onclick = async () => {
    const found = await scanShareDevices();
    if (!found.length) return;
    // R66：扫到设备就把地址填上；如果 ID + 密码本来就填好了，就「顺手连上」——
    // 不该逼用户先点自动发现、再点连接并列出这两步。
    const addr = (() => {
      const hosts = [];
      found.forEach(f => {
        const h = f.ip + ':' + (f.port || 8123);
        if (hosts.indexOf(h) < 0) hosts.push(h);
      });
      // 所有结果都在同一台机器上（常见：本机扫到自己）→ 直接把地址填好
      return hosts.length === 1 ? hosts[0] : '';
    })();
    if (addr) $('shareAddr').value = addr;
    const id = ($('shareIdIn').value || '').trim();
    const pwd = $('sharePwdIn').value;
    if (id && pwd) {
      const host = addr || (found[0].ip + ':' + (found[0].port || 8123));
      $('shareAddr').value = host;
      await runShareConnect(host, id, pwd);
    }
  };

  $('shareConnect').onclick = async () => {
    let host = ($('shareAddr').value || '').trim();
    if (!host) {
      // 地址留空 → 自己先扫一遍，扫到就用第一个（不用手动点两次）
      const found = await scanShareDevices();
      if (!found.length) return;
      host = found[0].ip + ':' + (found[0].port || 8123);
      $('shareAddr').value = host;
    }
    await runShareConnect(host, ($('shareIdIn').value || '').trim(), $('sharePwdIn').value);
  };

  /** 扫同网段 + 把结果画到列表。返回找到的共享（每项 = 一个可连的库）。 */
  async function scanShareDevices() {
    $('shareList').innerHTML = '<div class="share-tip">正在扫描同网段…（约 3~8 秒）</div>';
    const found = await Share.discover();
    if (!found.length) {
      $('shareList').innerHTML =
        '<div class="share-tip">没有自动发现设备。<br>' +
        '① 对方要开着「局域网共享」并保持页面打开；<br>' +
        '② 两台机器必须在同一个 Wi-Fi / 网段，防火墙别拦 8123；<br>' +
        '③ 扫不到就直接问对方要地址（形如 <code>xxx.xxx.xxx.xxx:xxxx</code>）填到上面。</div>';
      return found;
    }
    // R69：结果已按「同一台服务器」去重（一台机器好几个地址只算一条），
    // 每项显示这是哪个共享（ID）+ 几本书，点一下就填地址和 ID，只剩密码要手输。
    // R70：名字不再用 ellipsis 截断（改成可换行），也不再提「这台机器有 N 个地址」——
    //      同一台机器只当一条，用户不需要知道它有几张网卡。
    $('shareList').innerHTML =
      '<div class="share-tip">发现 ' + found.length + ' 个共享。' +
      '点一下就填好地址和共享 ID。</div>' +
      found.map((f, i) =>
        '<div class="share-item" data-idx="' + i + '">' +
          '<div class="si-main">' +
            '<b>' + esc(f.name) + '</b>' +
            '<span>' + esc(f.ip + ':' + f.port) + (f.count ? ' · ' + f.count + ' 本' : '') + '</span>' +
            '<span>' + (f.id ? 'ID ' + esc(f.id) : '需要手动输入 ID') + '</span>' +
          '</div>' +
        '</div>').join('');
    $('shareList').querySelectorAll('[data-idx]').forEach(n => {
      n.onclick = async () => {
        const f = found[Number(n.dataset.idx)];
        if (!f) return;
        $('shareAddr').value = f.ip + ':' + (f.port || 8123);
        if (f.id) $('shareIdIn').value = f.id;
        // 地址和 ID 都有了、密码也填了 → 直接连上（别让用户再点一次）
        const pwd = $('sharePwdIn').value;
        if (f.id && pwd) { await runShareConnect($('shareAddr').value, f.id, pwd); return; }
        toast(f.id ? '已填入地址和共享 ID，输入密码就能连' : '已填入地址：' + $('shareAddr').value);
      };
    });
    return found;
  }

  /** 连上主机并把书单列出来 */
  /** 连上主机并把书单列出来（R70：书单支持多选 + 全选 + 下载选中） */
  async function runShareConnect(host, id, pwd) {
    if (!id || !pwd) { toast('地址、共享 ID、密码都要填'); return; }
    try {
      loading(true, '正在连接…');
      const r = await Share.clientList(host, id, pwd);
      loading(false);
      renderShareBooks({ host, id, pwd }, r);
    } catch (e) {
      loading(false);
      toast('连接失败：' + e.message +
        '（确认地址能打开、ID 与密码没写错、对方共享页面还开着）');
    }
  }

  /** 字节数 → 好读的大小（书单里显示「12.3 MB」，比原始数字直观） */
  function shareSizeStr(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  /** 画书单：多选下载 + 单本下载 + 已存在标记 */
  async function renderShareBooks(cfg, r) {
    const books = Array.isArray(r.books) ? r.books : [];
    const tag = b => {
      const t = [];
      if (b.toc) t.push('目录');
      if (b.notes) t.push('笔记');
      if (b.ink) t.push('手迹');
      return t.length ? ' <i style="font-style:normal;opacity:.7">含' + t.join('/') + '</i>' : '';
    };
    // 先用书单元信息判一遍「哪些已经在书库里」——列表上直接标出来，下载前就有数
    const dupMap = new Map();
    for (const m of books) {
      try {
        const d = await Share.findExistingMeta(m);
        if (d) dupMap.set(m.id, d.title);
      } catch (e) { /* 判不了就当新书 */ }
    }
    /* R132（第 5 条）：两本同名书在列表里长得一模一样，用户没法知道点的是哪一本。
       这里做两件事：① 同名的那几本打上「同名 1/2」；② 第二行给出章数 / 标注数 / 导入日期 / 书号尾号。 */
    const titleKey = b => String(b.title || '').trim().toLowerCase();
    const titleCount = new Map();
    books.forEach(b => titleCount.set(titleKey(b), (titleCount.get(titleKey(b)) || 0) + 1));
    const titleSeen = new Map();
    const dayStr = (ts) => {
      const d = new Date(Number(ts) || 0);
      if (!ts || isNaN(d.getTime()) || d.getTime() < 86400000) return '';
      return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    };
    const idTail = (id) => String(id || '').replace(/[^0-9a-zA-Z]/g, '').slice(-6);
    const picked = new Set();

    const paint = () => {
      $('shareList').querySelectorAll('.share-item[data-i]').forEach(n => {
        const b = books[Number(n.dataset.i)];
        if (!b) return;
        const on = picked.has(b.id);
        n.classList.toggle('on', on);
        const ck = n.querySelector('.share-ck');
        if (ck) ck.checked = on;
      });
      const all = books.length > 0 && picked.size === books.length;
      const a = $('shareAll');
      if (a) a.checked = all;
      const cnt = $('shareCount');
      if (cnt) cnt.textContent = '已选 ' + picked.size + ' 本';
      const sel = $('shareDlSel');
      if (sel) {
        sel.disabled = !picked.size;
        sel.textContent = '下载选中' + (picked.size ? '（' + picked.size + '）' : '');
      }
    };

    $('shareList').innerHTML =
      '<div class="share-tip">已连上「' + esc(r.name) + '」，共 ' + books.length + ' 本。' +
      '勾选多本可以一次下载，也可以只点某一本的按钮。</div>' +
      (books.length
        ? '<div class="share-bulk">' +
          '<label class="share-allck"><input type="checkbox" id="shareAll"> 全选</label>' +
          '<span id="shareCount" style="opacity:.7;font-size:12px">已选 0 本</span>' +
          '<button class="btn-primary" id="shareDlSel" disabled>下载选中</button>' +
        '</div>'
        : '') +
      books.map((b, i) => {
        const dup = dupMap.get(b.id);
        const k = titleKey(b);
        let sameTag = '';
        if ((titleCount.get(k) || 0) > 1) {
          const nth = (titleSeen.get(k) || 0) + 1;
          titleSeen.set(k, nth);
          sameTag = '<i class="si-same">同名 ' + nth + '/' + titleCount.get(k) + '</i>';
        }
        // 第二行：能区分身份的几个数（章节 / 标注 / 导入日期 / 书号尾号）
        const bits = [];
        if (b.chCount) bits.push(b.chCount + ' 章');
        if (b.annCount) bits.push(b.annCount + ' 条标注');
        const d0 = dayStr(b.addedAt);
        if (d0) bits.push('导入 ' + d0);
        if (idTail(b.id)) bits.push('#' + idTail(b.id));
        return '<div class="share-item" data-i="' + i + '">' +
          '<input type="checkbox" class="share-ck" data-i="' + i + '">' +
          '<div class="si-main">' +
            '<b>' + esc(b.title) + sameTag + '</b>' +
            '<span>' + esc(String(b.format || '').toUpperCase()) + tag(b) +
              (b.size ? ' · ' + shareSizeStr(b.size) : '') +
              (dup ? ' · <i class="si-dup">书库里已有</i>' : '') + '</span>' +
            (bits.length ? '<span class="si-id">' + esc(bits.join(' · ')) + '</span>' : '') +
          '</div>' +
          '<button class="btn-plain share-dl" data-i="' + i + '">' + (dup ? '补齐' : '下载') + '</button>' +
        '</div>';
      }).join('');

    // 行点击 = 勾选（点在按钮/复选框上时交给它们自己处理）
    $('shareList').querySelectorAll('.share-item[data-i]').forEach(n => {
      n.onclick = (e) => {
        if (e.target.closest('button') || e.target.closest('input')) return;
        const b = books[Number(n.dataset.i)];
        if (!b) return;
        if (picked.has(b.id)) picked.delete(b.id); else picked.add(b.id);
        paint();
      };
    });
    // R71：复选框以前没绑 change —— 点它时行点击里 `closest('input')` 直接 return，
    // 于是「视觉上勾了，picked 没变」，「下载选中」一直是灰的（用户反馈「下载选中没用」）。
    $('shareList').querySelectorAll('.share-ck').forEach(ck => {
      ck.onchange = () => {
        const b = books[Number(ck.dataset.i)];
        if (!b) return;
        if (ck.checked) picked.add(b.id); else picked.delete(b.id);
        paint();
      };
    });
    const allBox = $('shareAll');
    if (allBox) allBox.onchange = () => {
      if (allBox.checked) books.forEach(b => picked.add(b.id));
      else picked.clear();
      paint();
    };
    const selBtn = $('shareDlSel');
    if (selBtn) selBtn.onclick = async () => {
      const metas = books.filter(b => picked.has(b.id));
      if (!metas.length) return;
      await downloadShareBatch(cfg, metas, paint);
    };
    $('shareList').querySelectorAll('.share-dl').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const b = books[Number(btn.dataset.i)];
        if (!b) return;
        try {
          const bk = await downloadShareOne(cfg, b, { dupMode: 'ask' });
          if (bk) shareResultToast(bk);
        } catch (err) {
          toast('下载失败：' + err.message);
        }
      };
    });
  }

  /** 下一本：判重命中时问「合并 / 另存一份」（dupMode='ask'）。
   *  返回 book；用户取消 → null。
   *  R71：loading 遮罩由这里自己管（own），并且**弹窗前先撤掉遮罩**——
   *  loading 的 z-index 是 500，比选择弹层高，以前弹窗被完全盖住，
   *  用户看到的就是「补齐一直在转」，点哪儿都没反应。 */
  async function downloadShareOne(cfg, meta, opts) {
    const own = !(opts && opts.quiet);      // 批量下载由批次统一管遮罩
    const step = (msg) => { if (own) loading(true, msg); };
    try {
      step('等待主机发送…');
      const o = await Share.clientDownload(cfg.host, cfg.id, cfg.pwd, meta.id, (i) => {
        if (own && i && i % 5 === 4) loading(true, '等待主机发送…（已等 ' + (i + 1) + ' 秒，主机页面要开着）');
      });
      let mode = (opts && opts.dupMode) || 'merge';
      let targetId = null;
      const dups = await Share.findCandidates(o);
      const dup = dups[0] || null;
      if (dup && mode === 'ask') {
        if (own) loading(false);            // 先撤遮罩，否则弹窗被盖住 → 永远等下去
        if (dups.length > 1) {
          // R130（第 11 条）：库里有好几本同名书（A1 / A2 / 另存的 B…）时，让用户**自己挑补到哪本**。
          // 以前 findExisting 只认数据库里第一条命中的，补到哪本全看运气。
          // 「补齐」的语义写清楚：只把笔记 / 书签 / 手迹**加进去**，不会清空或覆盖你原来的。
          // R158：光写《A》两条一模一样，用户根本分不出 A1 还是 A2 ——
          // 每行补上「页数 · 进度 · 什么时候加进来的」，才有得选。
          const day = ts => {
            if (!ts) return '';
            const d = new Date(ts), n = new Date();
            const sameDay = d.toDateString() === n.toDateString();
            const hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
            if (sameDay) return '今天 ' + hm;
            const y = new Date(n.getTime() - 86400000);
            if (d.toDateString() === y.toDateString()) return '昨天 ' + hm;
            return (d.getMonth() + 1) + '月' + d.getDate() + '日';
          };
          const list = dups.map((b, i) => {
            const bits = [];
            if (b.totalPages) bits.push(b.totalPages + ' 页');
            bits.push(b.progress ? '已读 ' + Math.round((b.progress || 0) * 100) + '%' : '还没读');
            if (b.addedAt) bits.push(day(b.addedAt) + '加入');
            return (i + 1) + '. 补齐到《' + b.title + '》'
              + (bits.length ? '（' + bits.join(' · ') + '）' : '')
              + (i === 0 ? ' · 最近在读' : '');
          });
          list.push((dups.length + 1) + '. 另存为新的一本（两本各留各的书签与笔记）');
          const pick2 = await askPick(
            '书库里有 ' + dups.length + ' 本同名书，这次补齐到哪一本？\n'
            + '（括号里是页数 / 读到哪 / 什么时候加进来的，只往里加，不清空你原来的）',
            list);
          if (pick2 < 0) return null;                        // 取消
          if (pick2 === dups.length) mode = 'new';           // 最后一项 = 另存
          else { mode = 'merge'; targetId = dups[pick2].id; }
        } else {
          const pick = await askPick(
            '书库里已经有《' + dup.title + '》了，要怎么处理？',
            ['合并进已有那本（推荐：把这次带来的笔记 / 手迹补进去，不清空原来的）',
              '另存为新的一本（两本各留各的书签与笔记）']);
          if (pick === 1) mode = 'new';
          else if (pick === 0) mode = 'merge';
          else return null;                       // 取消
        }
      }
      step('正在保存…');
      const bk = await Share.importReceived(o, { mode: mode === 'new' ? 'new' : 'merge', targetId: targetId });
      // R131（第 7/8 条）：补齐的正是「此刻开着读的这本」时，阅读器手里还是进书那一刻的
      // 标注 / 目录快照 —— 补进去的东西不重绘，用户看到的就是「什么都没共享过来」。
      if (bk && typeof R !== 'undefined' && R && R.book && R.book.id === bk.id) {
        try { await reloadOpenedBook(); } catch (e) { console.warn('补齐后刷新阅读器失败', e); }
      }
      await Library.refresh();
      return bk;
    } finally {
      if (own) loading(false);
    }
  }

  /** 批量下载：先按书单预判哪些已在库，一次问清「合并 / 每本都另存」，再逐本下 */
  async function downloadShareBatch(cfg, metas, repaint) {
    let okN = 0, failN = 0, mergedN = 0, newN = 0;
    try {
      const dupTitles = [];
      for (const m of metas) {
        const d = await Share.findExistingMeta(m);
        if (d) dupTitles.push(d.title);
      }
      let dupMode = 'merge';
      if (dupTitles.length) {
        const pick = await askPick(
          '选中的 ' + metas.length + ' 本里，有 ' + dupTitles.length + ' 本已经在书库了（如《' +
          dupTitles[0] + '》）。要怎么处理？',
          ['合并进已有那几本（推荐：只补笔记 / 手迹，不会变成两本）',
            '每本都另存一份（会出现重复的书，但书签各自独立）']);
        if (pick === 0) dupMode = 'merge';
        else if (pick === 1) dupMode = 'new';
        else return;
      }
      for (let k = 0; k < metas.length; k++) {
        const m = metas[k];
        loading(true, '正在下载 ' + (k + 1) + '/' + metas.length + '：' + (m.title || ''));
        try {
          // 批量里不再逐本弹窗（预判已问过一次），命中就按统一口径处理
          const bk = await downloadShareOne(cfg, m, { dupMode, quiet: true });
          if (!bk) continue;
          okN++;
          const g = bk.gotStats || {};
          if (g.existed) mergedN++;
          else if (g.savedAsNew) newN++;
        } catch (e) {
          failN++;
          console.warn('共享下载失败', m && m.title, e);
        }
        if (repaint) repaint();
      }
    } catch (e) {
      console.warn('批量下载出错', e);
      toast('批量下载出错：' + e.message);
      return;
    } finally {
      loading(false);
    }
    if (okN) await Library.refresh();
    toast('下载完成：成功 ' + okN + ' 本' +
      (mergedN ? '（' + mergedN + ' 本合并进已有）' : '') +
      (newN ? '（' + newN + ' 本另存为新书）' : '') +
      (failN ? '，失败 ' + failN + ' 本' : '') + '。到「书库」里查看');
  }

  /** 单本下载后的提示：如实说清带过来什么 */
  function shareResultToast(bk) {
    const g = bk.gotStats || {};
    if (g.existed) {
      const add = [];
      if (g.annots) add.push(g.annots + ' 条标注');
      if (g.inkStrokes) add.push('手迹 ' + g.inkStrokes + ' 笔');
      if (g.chaptersAdded) add.push('目录 ' + g.chaptersAdded + ' 章');
      // R131：把「哪些没带过来 / 为什么」说清楚，否则用户会以为共享坏了
      const skip = [];
      if (g.skipped) skip.push('另有 ' + g.skipped + ' 条本地已有，跳过（不会重复、也不会覆盖）');
      if (g.inkShared === false) skip.push('主机没勾「手迹涂鸦」，所以这次没有手迹');
      toast('《' + bk.title + '》已经在书库里了，这次只补齐' +
        (add.length ? '：' + add.join('、') : '（没有新内容）') +
        (skip.length ? '；' + skip.join('；') : ''));
      return;
    }
    const bits = [];
    bits.push('目录 ' + (g.chapters || 0) + ' 章');
    bits.push('标记/笔记 ' + (g.notes || 0) + ' 条');
    if (g.inkStrokes) bits.push('手迹 ' + g.inkStrokes + ' 笔');
    else if (g.inkShared === false) bits.push('手迹未共享');
    toast('已收到《' + bk.title + '》：' + bits.join('、') + '。到「书库」里查看');
  }
}
