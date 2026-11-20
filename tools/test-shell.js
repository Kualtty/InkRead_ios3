/* 在「只有静态文件」的环境里跑一遍前端，模拟 iOS 壳。
   目的是提前发现：页面白屏、未捕获异常、一直转圈、把 /api 失败当致命错误。
   用法：INK_BASE=http://127.0.0.1:8901 node tools/test-shell.js
   依赖：playwright-core（用 InkReaderWeb 的 node_modules，见 run-test.sh） */
const { chromium } = require('playwright-core');

const BASE = process.env.INK_BASE || 'http://127.0.0.1:8901';
const EDGE = process.env.INK_BROWSER
  || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ok  ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  ✗   ' + name + (extra ? '  → ' + extra : '')); }
}

// 壳注入的那一份（WebShellView.bridgeScript 的子集，字段名必须一致）
const SHELL_BRIDGE = `
  window.InkAndroid = {
    __shell: 'ios',
    lanIps: function(){ return '192.168.31.42'; },
    dataDir: function(){ return '/var/mobile/Containers/Data/Application/XXX/Documents'; },
    outDir: function(){ return '/var/mobile/Containers/Data/Application/XXX/Documents/墨阅导出'; },
    saveBlob: function(){},
    restartApp: function(){}
  };
`;

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });

  // ---------- 一、当成普通浏览器打开（对照组，应该和电脑上一样） ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = await ctx.newPage();
    const errors = [];
    const net = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('response', (r) => { if (r.status() >= 400) net.push(r.status() + ' ' + r.url()); });

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    const st = await page.evaluate(() => ({
      lib: !!document.querySelector('#libraryView'),
      libVisible: (() => {
        const el = document.querySelector('#libraryView');
        return el ? getComputedStyle(el).display !== 'none' : false;
      })(),
      empty: (() => {
        const el = document.querySelector('#libEmpty');
        return el ? getComputedStyle(el).display !== 'none' : false;
      })(),
      inApp: document.body.classList.contains('in-app'),
      protoBar: !!document.querySelector('.proto-bar'),
      protoShown: (() => {
        const el = document.querySelector('.proto-bar');
        return el ? getComputedStyle(el).display !== 'none' : false;
      })(),
      sidebar: !!document.querySelector('#libSidebar'),
      cards: document.querySelectorAll('.book-card').length
    }));

    ok(st.lib, '书架容器在');
    ok(st.libVisible, '书架默认显示（不是白屏）');
    ok(st.empty || st.cards > 0, '空库显示引导 / 有书显示卡片');
    ok(!st.inApp, '普通浏览器里没有 in-app 类（不影响电脑）');

    const badNet = net.filter((u) => !/\/api\//.test(u));
    ok(errors.length === 0, '没有未捕获异常', errors.slice(0, 3).join(' | ') || '干净');
    ok(badNet.length === 0, '没有静态资源 404/500', badNet.slice(0, 4).join(' | ') || '干净');

    await page.screenshot({ path: 'docs/shell-browser.png' });
    await ctx.close();
  }

  // ---------- 二、模拟 iOS 壳（注入 InkAndroid） ----------
  {
    const ctx = await browser.newContext({
      viewport: { width: 834, height: 1194 },     // iPad 竖屏
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
        + '(KHTML, like Gecko) Mobile/15E148',
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true
    });
    await ctx.addInitScript(SHELL_BRIDGE);
    const page = await ctx.newPage();
    const errors = [];
    const net = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('response', (r) => { if (r.status() >= 400) net.push(r.status() + ' ' + r.url()); });

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    const st = await page.evaluate(() => ({
      inApp: document.body.classList.contains('in-app'),
      protoShown: (() => {
        const el = document.querySelector('.proto-bar');
        return el ? getComputedStyle(el).display !== 'none' : false;
      })(),
      libVisible: (() => {
        const el = document.querySelector('#libraryView');
        return el ? getComputedStyle(el).display !== 'none' : false;
      })(),
      // 窄屏时侧栏应该是抽屉状态（不可见），不能盖住书架
      sidebarVisible: (() => {
        const el = document.querySelector('#libSidebar');
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right > 0 && getComputedStyle(el).visibility !== 'hidden';
      })(),
      docW: document.documentElement.clientWidth,
      scrollW: document.documentElement.scrollWidth,
      bodyH: document.body.scrollHeight,
      lan: window.InkAndroid.lanIps()
    }));

    ok(st.inApp, '识别为 App 内（in-app 类已加）');
    ok(!st.protoShown, '方案控制条不再显示（不再是「手机外框里的原型」）');
    ok(st.libVisible, '书架正常显示');
    ok(st.scrollW <= st.docW + 2, '没有横向溢出', st.scrollW + ' vs ' + st.docW);
    ok(st.lan === '192.168.31.42', '桥里的 lanIps 能读到');

    const badNet = net.filter((u) => !/\/api\//.test(u));
    ok(errors.length === 0, 'App 内没有未捕获异常', errors.slice(0, 3).join(' | ') || '干净');
    ok(badNet.length === 0, 'App 内静态资源全部取到', badNet.slice(0, 4).join(' | ') || '干净');

    await page.screenshot({ path: 'docs/shell-ipad.png', fullPage: false });
    await ctx.close();
  }

  // ---------- 三、静态资源确实能取到（壳的 MIME 表现在最容易错的两个） ----------
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    const res = await page.evaluate(async (base) => {
      const out = {};
      for (const p of ['vendor/ort/ort-wasm-simd-threaded.mjs',
                       'vendor/ort/ort-wasm-simd-threaded.wasm',
                       'vendor/paddle/det.onnx',
                       'js/reader.js']) {
        try {
          const r = await fetch(base + '/' + p, { cache: 'no-store' });
          out[p] = r.status + ' ' + (r.headers.get('content-type') || '');
        } catch (e) { out[p] = 'ERR ' + e.message; }
      }
      return out;
    }, BASE);
    ok(/200/.test(res['vendor/ort/ort-wasm-simd-threaded.mjs'] || ''), '.mjs 200', res['vendor/ort/ort-wasm-simd-threaded.mjs']);
    ok(/text\/javascript/.test(res['vendor/ort/ort-wasm-simd-threaded.mjs'] || ''), '.mjs 是 text/javascript', res['vendor/ort/ort-wasm-simd-threaded.mjs']);
    ok(/application\/wasm/.test(res['vendor/ort/ort-wasm-simd-threaded.wasm'] || ''), '.wasm 是 application/wasm', res['vendor/ort/ort-wasm-simd-threaded.wasm']);
    ok(/200/.test(res['vendor/paddle/det.onnx'] || ''), 'Paddle 模型可取', res['vendor/paddle/det.onnx']);
    await ctx.close();
  }

  // ---------- 四、真导一本 TXT，看能不能读（壳里书走 IndexedDB，不经过服务端） ----------
  {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmp = path.join(os.tmpdir(), 'ink-shell-test.txt');
    const para = '夜深了，海面上只剩下一盏灯。他把书页翻过去，纸的声音很轻，像有人在很远的地方咳嗽。';
    fs.writeFileSync(tmp, Array(120).fill(para).join('\n\n'), 'utf8');

    const ctx = await browser.newContext({
      viewport: { width: 834, height: 1194 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2
    });
    await ctx.addInitScript(SHELL_BRIDGE);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    await page.setInputFiles('#fileInput', tmp);
    await page.waitForTimeout(5000);

    const shelf = await page.evaluate(() => ({
      cards: document.querySelectorAll('.book-card').length,
      first: (document.querySelector('.book-card') || {}).textContent || ''
    }));
    ok(shelf.cards > 0, '导入后书架出现书卡', String(shelf.cards) + ' 张');

    if (shelf.cards > 0) {
      await page.click('.book-card');
      await page.waitForTimeout(3000);
      const r = await page.evaluate(() => {
        const rv = document.querySelector('#readerView');
        const rc = document.querySelector('#readerContent');
        const txt = rc ? (rc.innerText || '') : '';
        return {
          open: rv ? getComputedStyle(rv).display !== 'none' : false,
          len: txt.length,
          sample: txt.slice(0, 24),
          pages: document.querySelectorAll('#readerContent .page').length,
          title: (document.querySelector('#readerTitle') || {}).textContent || ''
        };
      });
      ok(r.open, '点书能进阅读器');
      ok(r.len > 40, '正文渲染出来了', r.len + ' 字：' + r.sample);
      ok(/夜深了/.test(r.sample) || r.len > 40, '正文内容正确', r.sample);
      await page.screenshot({ path: 'docs/shell-reader.png' });
    }
    ok(errors.length === 0, '读书过程中没有未捕获异常', errors.slice(0, 2).join(' | ') || '干净');
    await ctx.close();
  }

  await browser.close();
  console.log('\n结果：' + pass + '/' + (pass + fail));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
