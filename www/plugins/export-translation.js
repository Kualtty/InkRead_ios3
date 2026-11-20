/*
 * 插件：导出 / 复制译文（feature）
 * ------------------------------------------------------------
 * 这一类插件不是翻译源，而是「对译文做点什么」——导出、复制、发到别处…
 * 注册方式：
 *   window.InkPlugins.registerFeature({
 *     id, name, description,
 *     run(ctx) { ... }   // ctx = { R, InkTranslate, result }
 *   })
 * 翻译面板底部「已安装插件」区会自动列出它，点一下就执行 run()。
 *
 * ⚠ R157：以前这里用 <a download> + alert()。
 *   - 安卓 WebView 对 <a download> 是空操作（点了什么都不会发生、也不报错），
 *     所以「导出译文」在 APK 里永远没反应；现在统一走 downloadBlob()，
 *     有原生壳时交给 InkAndroid.saveBlob 写到「下载/墨阅」。
 *   - WebView 默认不实现 alert/confirm（返回 false），提示也一起消失。
 *     统一换成页面里的 toast()，三端表现一致。
 */
(function () {
  if (!window.InkPlugins) {
    console.warn('[export-translation] 请先加载 js/translate.js');
    return;
  }

  function pairsOf(node) {
    return Array.from(node.querySelectorAll('.tr-item')).map((it) => ({
      src: (it.querySelector('.tr-src') || {}).textContent || '',
      dst: (it.querySelector('.tr-dst') || {}).textContent || ''
    })).filter(p => p.dst);
  }

  /* 面板按页分节（R148）：一节 = 一页 / 全书。整份导出要把每节都带上，
     只抓 .tr-item 会把别的页丢掉（以前只导当前看到的那一页）。 */
  function collect() {
    const root = document.getElementById('tpResult');
    if (!root) return [];
    const secs = Array.from(root.querySelectorAll('.tr-sec'));
    if (secs.length) {
      return secs.map((s) => {
        const t = s.querySelector('.tr-sec-title');
        return { title: (t ? t.textContent : '').trim(), pairs: pairsOf(s) };
      }).filter(s => s.pairs.length);
    }
    return [{ title: '', pairs: pairsOf(root) }].filter(s => s.pairs.length);
  }

  function toText(secs) {
    return secs.map((s) => (s.title ? '## ' + s.title + '\n' : '')
      + s.pairs.map(p => p.src + '\n' + p.dst).join('\n\n')).join('\n\n');
  }

  function bookName() {
    try { return (typeof R !== 'undefined' && R.book && R.book.title) || '译文'; }
    catch (e) { return '译文'; }
  }

  function tip(msg) {
    if (typeof toast === 'function') toast(msg);
    else console.log('[export-translation]', msg);
  }

  // 导出为 .txt
  window.InkPlugins.registerFeature({
    id: 'export-txt',
    name: '导出译文 (.txt)',
    description: '把面板里所有页的原文+译文对照导出成文本文件（安卓保存到「下载/墨阅」）',
    run() {
      const secs = collect();
      if (!secs.length) { tip('先在面板里点「翻译本页 / 全书」生成译文'); return; }
      const text = toText(secs);
      const blob = new Blob(['\uFEFF' + text], { type: 'text/plain;charset=utf-8' });
      const name = '墨阅-译文-' + String(bookName()).replace(/[\\/:*?"<>|\n\r\t]/g, '_').slice(0, 40)
        + '-' + Date.now() + '.txt';
      if (typeof downloadBlob === 'function') downloadBlob(blob, name);
      else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }
      const n = secs.reduce((k, s) => k + s.pairs.length, 0);
      tip('已导出 ' + n + ' 段译文（共 ' + secs.length + ' 节）');
    }
  });

  // 复制到剪贴板
  window.InkPlugins.registerFeature({
    id: 'copy-txt',
    name: '复制译文',
    description: '把原文+译文对照复制到剪贴板',
    async run() {
      const secs = collect();
      if (!secs.length) { tip('先在面板里点「翻译本页 / 全书」生成译文'); return; }
      const text = toText(secs);
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch (e) {
        // WebView / 非安全上下文里 clipboard API 常常没有权限，退回老办法
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;left:-9999px;top:0';
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand('copy');
          ta.remove();
        } catch (e2) { ok = false; }
      }
      const n = secs.reduce((k, s) => k + s.pairs.length, 0);
      tip(ok ? ('已复制 ' + n + ' 段译文') : '复制失败：系统没给剪贴板权限，可以改用「导出译文 (.txt)」');
    }
  });
})();
