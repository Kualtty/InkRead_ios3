/*
 * 示例插件：自定义翻译源（provider）
 * ------------------------------------------------------------
 * 这是「怎么接一个新翻译引擎」的最小模板。复制这个文件、改个 id、
 * 在 translate() 里换成你自己的翻译服务，再到 index.html 加一行
 *   <script src="plugins/你的文件.js"></script>
 * 刷新页面，翻译面板里下拉框就会多出这一项。
 *
 * 约定（必须）：
 *   window.InkPlugins.registerProvider({
 *     id:     '唯一字符串',
 *     name:   '面板里显示的名字',
 *     online: true/false,           // 是否要联网 + API Key
 *     translate(text, ctx) { ...return 译文字符串（可 async） }
 *   })
 * ctx 里带 InkTranslate.state：{ glossary, noTranslate, apiKey, targetLang, ... }
 * 你可以直接复用 ctx.glossary / ctx.noTranslate，交给你的后端处理。
 */
(function () {
  if (!window.InkPlugins) {
    console.warn('[example-provider] 请先加载 js/translate.js');
    return;
  }

  // 下面是一个「演示」provider：把英文逐词大写，纯粹为了一眼看出它生效了。
  // 真实场景里把 translate() 换成你的 fetch 调用即可（见下方注释模板）。
  window.InkPlugins.registerProvider({
    id: 'demo-upper',
    name: '演示：逐词大写（示例）',
    online: false,
    async translate(text, ctx) {
      // —— 演示逻辑 ——
      let out = String(text).replace(/[A-Za-z]+/g, (w) => w.toUpperCase());
      // 术语表也顺手应用一下，证明能复用配置
      (ctx.glossary || []).forEach((t) => { out = out.split(t.src).join(t.dst); });
      return out;
    }

    /* —— 真实 provider 模板（取消注释改成你的服务）——
    id: 'my-engine',
    name: '我的翻译引擎',
    online: true,
    async translate(text, ctx) {
      const r = await fetch('https://你的翻译接口', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ctx.apiKey },
        body: JSON.stringify({
          text,
          target: ctx.targetLang || 'ZH',
          glossary: ctx.glossary,        // 把术语表交给后端强制替换
          no_translate: ctx.noTranslate  // 不翻译名单
        })
      });
      if (!r.ok) throw new Error('翻译接口返回 ' + r.status);
      const j = await r.json();
      return j.translation;
    }
    */
  });
})();
