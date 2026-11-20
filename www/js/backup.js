/* ============================================================
   backup.js —— 备份与恢复（整库 / 只备份选中的书）
   ------------------------------------------------------------
   书籍都存在浏览器 IndexedDB 里，清缓存 / 换浏览器 / 点「卸载」就没了。
   这里把书打成 zip：

     inkreader-backup-YYYYMMDD-HHMM.zip   （整库）
     inkreader-select-YYYYMMDD-HHMM.zip   （只备份勾选的几本）
       ├── manifest.json   书单元数据、收藏夹、设置
       ├── books/<id>.json 每本书的内容（文本 / PDF / 图片 都转 base64）
       └── annots/<id>.json 每本书的笔记、标记、书签

   恢复时可以选择「合并」（保留现有书，跳过同 id）或「覆盖」（先清空再导入）。
   选书备份（partial）只支持合并 —— 否则会把没备份的书一起删掉。
   ============================================================ */

const Backup = {
  VERSION: 1,

  /** JSZip 兜底加载：万一 index.html 的 <script> 没加载到（旧缓存 / 部署缺文件），
      动态补一个 <script> 再继续，避免「打包组件未加载」直接报错。 */
  async ensureJSZip() {
    if (typeof JSZip !== 'undefined') return JSZip;
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/jszip.min.js';
      s.onload = () => (typeof JSZip !== 'undefined'
        ? resolve(JSZip)
        : reject(new Error('打包组件加载失败')));
      s.onerror = () => reject(new Error('打包组件加载失败（vendor/jszip.min.js 缺失）'));
      document.head.appendChild(s);
    });
  },

  async _b64(blob) {
    const u8 = new Uint8Array(await blob.arrayBuffer());
    return ShareCrypto.b64(u8);
  },
  _blob(b64, type) {
    return new Blob([ShareCrypto.fromB64(b64)], { type: type || 'application/octet-stream' });
  },

  /** 把书的内容序列化成可 JSON 化的对象 */
  async packBook(b) {
    const o = {
      id: b.id, title: b.title, format: b.format,
      length: b.length || 0, totalPages: b.totalPages || 0,
      locator: b.locator || 0, progress: b.progress || 0,
      addedAt: b.addedAt || 0, lastReadAt: b.lastReadAt || 0,
      fav: !!b.fav, pinned: !!b.pinned, collection: b.collection || null,
      color: b.color || null, chapters: b.chapters || [],
      tags: Array.isArray(b.tags) ? b.tags.slice() : [],
      content: {}
    };
    if (b.cover) o.cover = await this._b64(b.cover);
    if (b.format === 'pdf') {
      const d = b.content && b.content.data;
      o.content = { kind: 'pdf', data: d ? ShareCrypto.b64(new Uint8Array(d)) : '' };
    } else if (b.format === 'comic') {
      o.content = { kind: 'images', items: [] };
      for (const it of ((b.content && b.content.items) || [])) {
        o.content.items.push({ name: it.name, data: await this._b64(it.blob) });
      }
    } else if (b.format === 'html') {
      // html / epub：内容就是一段 html 字符串（图片已内联为 data: URL），整段存即可，
      // 不再落入 else 只存空 text 导致恢复后空白（修 #6）。
      // R68：md 导入的书正文是 html，但「编辑原文」用的是 content.md ——
      // 之前没备份 md，恢复后那本书就编辑不了原文，正文也可能因为 html 为空而变白。
      o.content = {
        kind: 'html',
        html: (b.content && (b.content.html || b.content.text)) || '',
        md: (b.content && typeof b.content.md === 'string') ? b.content.md : ''
      };
    } else {
      o.content = {
        kind: 'text',
        text: (b.content && (b.content.text || b.content.html)) || ''
      };
    }
    return o;
  },

  async unpackBook(o) {
    const b = {
      id: o.id, title: o.title, format: o.format,
      length: o.length || 0, totalPages: o.totalPages || 0,
      locator: o.locator || 0, progress: o.progress || 0,
      addedAt: o.addedAt || Date.now(), lastReadAt: o.lastReadAt || Date.now(),
      fav: !!o.fav, pinned: !!o.pinned, collection: o.collection || null,
      color: o.color || null, chapters: o.chapters || [],
      tags: Array.isArray(o.tags) ? o.tags.slice() : [],
      content: {}
    };
    if (o.cover) b.cover = this._blob(o.cover, 'image/*');
    if (o.format === 'pdf') {
      const u8 = ShareCrypto.fromB64(o.content.data || '');
      b.content = { kind: 'pdf', data: u8.buffer.slice(0) };
    } else if (o.format === 'comic') {
      b.content = {
        kind: 'images',
        items: (o.content.items || []).map((it, i) => ({
          name: it.name || (i + 1 + '.jpg'),
          blob: this._blob(it.data, 'image/*')
        }))
      };
    } else if (o.format === 'html') {
      b.content = { kind: 'html', html: (o.content && (o.content.html || o.content.text)) || '' };
      // 老备份没有 md 字段 —— 没有就不设，阅读器会按「只有 html」处理
      if (o.content && typeof o.content.md === 'string' && o.content.md) b.content.md = o.content.md;
    } else {
      b.content = { kind: 'text', text: o.content.text || '' };
    }
    return b;
  },

  /* ---------------- 导出 ---------------- */
  /** @param {Array} books 要打包的书（已经筛好的） */
  async exportBooks(books, onProgress) {
    await this.ensureJSZip();
    if (!books || !books.length) throw new Error('没有选中任何书');
    const zip = new JSZip();
    const bk = zip.folder('books');
    const an = zip.folder('annots');
    const errs = [];   // 单本失败不中断整库导出，最后汇总

    for (let i = 0; i < books.length; i++) {
      const b = books[i];
      if (onProgress) onProgress(i / books.length, `正在打包 ${i + 1}/${books.length}《${b.title}》`);
      try {
        bk.file(b.id + '.json', JSON.stringify(await this.packBook(b)));
        const list = await Annot.list(b.id);
        if (list && list.length) an.file(b.id + '.json', JSON.stringify(list));
      } catch (e) {
        console.error('备份单本失败：', b.title, e);
        errs.push({ title: b.title, err: String((e && e.message) || e) });
      }
      await new Promise(r => setTimeout(r, 0));   // 让出主线程，界面不卡死
    }

    /* R84：收藏夹 / 设置必须「内存兜底」，否则备份会静默丢它们。
       起因是用户反馈「收藏夹恢复备份时恢复不成功」：他手上那份整库备份的 manifest 里
       `collections: []`、`settings: null` —— 书 21 本都在，收藏夹一个都没有。产生这种包
       的路径很好复现：kv 被清过（一键清空 / 覆盖恢复一份没有 kv 的备份），书架却是从别处
       恢复回来的；此时 DB 的 kv 是空的，而书在 IndexedDB 里，导出来就是「有书没夹」。
       这份备份再拿去恢复，收藏夹永远回不来 —— 而界面只会报「✅ 合并完成」，用户无从察觉。
       所以：DB 读空时退回内存里的当前值（Library.collections / Settings），一个都不许丢。 */
    let colls = await DB.kvGet('collections', null);
    if (!Array.isArray(colls) || !colls.length) {
      const mem = (typeof Library !== 'undefined' && Array.isArray(Library.collections))
        ? Library.collections : null;
      if (mem && mem.length) colls = mem.map(c => Object.assign({}, c));
    }
    if (!Array.isArray(colls)) colls = [];

    let settings = await DB.kvGet('settings', null);
    if (!settings && typeof Settings !== 'undefined' && Settings) {
      settings = Object.assign({}, Settings);   // 内存里就是当前生效的设置
    }

    const all = await DB.getAll('books');
    zip.file('manifest.json', JSON.stringify({
      app: 'InkReader', version: this.VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: (typeof APP_VERSION !== 'undefined' ? APP_VERSION : ''),
      partial: books.length < all.length,   // true = 只备份了部分书
      books: books.map(b => ({ id: b.id, title: b.title, format: b.format })),
      collections: colls, settings,
      // R84：把「这个包里到底有没有收藏夹/设置」写成明面字段，恢复时可以如实告知用户，
      // 排查旧备份时也不用再解包看 JSON。
      collectionsCount: colls.length,
      hasSettings: !!settings
    }));

    if (onProgress) onProgress(1, '正在生成压缩包…');
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `-${p(d.getHours())}${p(d.getMinutes())}`;
    const partial = books.length < all.length;
    const name = (partial ? 'inkreader-select-' : 'inkreader-backup-') + stamp + '.zip';
    downloadBlob(blob, name);
    return { name, count: books.length, size: blob.size, partial, errors: errs,
             collections: colls.length, hasSettings: !!settings };
  },

  /** 整库导出 */
  async exportAll(onProgress) {
    const books = await DB.getAll('books');
    if (!books.length) throw new Error('书库是空的，没什么可备份');
    return this.exportBooks(books, onProgress);
  },

  /** 只导出指定 id 的几本书 */
  async exportIds(ids, onProgress) {
    const set = new Set(ids || []);
    const books = (await DB.getAll('books')).filter(b => set.has(b.id));
    if (!books.length) throw new Error('没有选中任何书');
    return this.exportBooks(books, onProgress);
  },

  /* ---------------- 标注合并（备份 / 共享共用） ----------------
     R69：这段原来内联在 importAll 里，共享收书也要用（重复下载不能变两本、标注不能翻倍），
     抽出来一处维护。

     · 笔记 / 高光 / 书签：按「类型 + 起止 + 样式 + 颜色 + 页/位置 + 笔记」做指纹，已有的跳过。
     · 手迹：记录主键是「书号:页」（文字书 :text，PDF/漫画 :p<页>）。
       来源包里的 key 带着**对方的书号**，必须换成本书号，否则画的时候查不到（R67 的坑）；
       同一 key 的记录只合并笔画，绝不新建第二条（会画两遍、粗细翻倍）。 */
  _sigOf(a) {
    return [a.type || '', a.start, a.end, a.style || '', a.color || '',
      a.pageIndex == null ? '' : a.pageIndex, a.locator == null ? '' : a.locator,
      a.note || ''].join('\u0001');
  },
  _strokeSig(s) {
    return [s.aoff == null ? '' : s.aoff, s.w || '', s.color || '',
      (s.pts || []).join(',')].join('\u0001');
  },

  /**
   * @param {string} targetId 并进哪本书
   * @param {Array} annotList 来源标注
   * @param {{from?:string}} [opts] from = 来源书号（手迹 key 前缀要换成 targetId）
   * @returns {{annots:number, mergedAnnots:number, inkStrokes:number}}
   */
  async mergeAnnots(targetId, annotList, opts) {
    const from = (opts && opts.from) || '';
    const cur = await Annot.list(targetId);
    const have = new Set(cur.map(a => this._sigOf(a)));
    let annots = 0, mergedAnnots = 0, inkStrokes = 0;

    for (const a of (annotList || [])) {
      if (a.type === 'ink') {
        const tail = String(a.key || '').split(':')[1] || 'text';
        const key = targetId + ':' + tail;
        const rec = cur.find(x => x.type === 'ink' && x.key === key);
        const strokes = Array.isArray(a.strokes) ? a.strokes : [];
        if (!rec) {
          const copy = Object.assign({}, a, {
            bookId: targetId,
            key,
            id: 'ink-' + targetId + '-' + tail
          });
          const added = await Annot.add(copy);
          cur.push(added);
          annots++; inkStrokes += strokes.length;
        } else {
          const had = new Set((rec.strokes || []).map(s => this._strokeSig(s)));
          const add = strokes.filter(s => !had.has(this._strokeSig(s)));
          if (add.length) {
            rec.strokes = (rec.strokes || []).concat(add);
            await DB.put('annots', rec);
            mergedAnnots++; inkStrokes += add.length;
          }
        }
        continue;
      }
      if (have.has(this._sigOf(a))) continue;
      // R131：同一段、同样式同颜色，只是这条本地没写笔记 —— 以前会因为「笔记字段不同」
      // 判成两条，往正文里再叠一层标记（用户看着就像「补齐把原来的覆盖了」）。
      // 现在把笔记补到已有那条上，只加不删；本地已经写过笔记的一律不动。
      const twin = (!a.note) ? null : cur.find(x => x && x.type !== 'ink' && x.type === a.type
        && x.start === a.start && x.end === a.end
        && (x.style || '') === (a.style || '') && (x.color || '') === (a.color || '')
        && !(x.note || ''));
      if (twin) {
        twin.note = a.note;
        await DB.put('annots', twin);
        have.add(this._sigOf(a));
        have.add(this._sigOf(twin));
        mergedAnnots++;
        continue;
      }
      const copy = Object.assign({}, a);
      delete copy.id;
      copy.bookId = targetId;
      await Annot.add(copy);
      have.add(this._sigOf(a));
      annots++;
    }
    return { annots, mergedAnnots, inkStrokes, from };
  },

  /**
   * R71：备份里哪些书本地已经有（按「书籍 ID」认）。
   * 给恢复向导那一步「已存在的怎么办？合并 / 每本另存一份」用 —— 先算出来才能把
   * 数量与书名如实告诉用户（而不是笼统问一句「要不要合并」）。
   * @param {object} manifest 备份里的 manifest.json
   * @returns {Promise<string[]>} 已在库书的标题
   */
  async dupTitles(manifest) {
    const list = (manifest && manifest.books) || [];
    if (!list.length) return [];
    const have = new Map((await DB.getAll('books')).map(b => [b.id, b]));
    const out = [];
    for (const m of list) {
      const b = have.get(m && m.id);
      if (b) out.push(b.title || (m && m.title) || '未命名');
    }
    return out;
  },

  /* ---------------- 导入 ---------------- */
  /**
   * @param {File} file 备份 zip
   * @param {'merge'|'replace'} mode 合并=保留现有书（同 id 跳过）；覆盖=先清空整库
   * @param {(p:number,m:string)=>void} [onProgress]
   * @param {{dupMode?:'merge'|'new'}} [opts]  merge（默认）=已在库的那本只补标注；
   *   new = 每本都另存一份（用户想「同一本书两本、各带各的书签」时用）
   * @returns {Promise<{added:number,skipped:number,annots:number,mergedAnnots:number,
   *   inkStrokes:number,savedAsNew:number,replaced:boolean,partial:boolean,exportedAt:number,
   *   collsInBackup:number,collAdded:number,collUpdated:number,settingsRestored:boolean}>}
   *   collsInBackup = 备份 zip 里一共有几个收藏夹（0 = 这份备份本来就没有，恢复不出来）
   */
  async importAll(file, mode, onProgress, opts) {
    const dupMode = (opts && opts.dupMode) === 'new' ? 'new' : 'merge';
    await this.ensureJSZip();
    const zip = await JSZip.loadAsync(file);
    const mf = zip.file('manifest.json');
    if (!mf) throw new Error('这不是墨阅的备份文件（缺少 manifest.json）');
    const manifest = JSON.parse(await mf.async('string'));

    // 选书备份现在也允许「清空并只还原这几本」（mode=replace）：此时整库清空，
    // 只还原备份里这几本，没备份的书会被删掉 —— 调用方（main.js）会用二次确认明确告知。
    // 不再强制合并，把选择权交还给用户。

    // 先把所有要恢复的书和笔记都读进内存（不碰现有数据），
    // 这样即使某个文件损坏 / JSON 解析失败，也不会「先清空再导入一半失败」导致数据全丢。
    const bookFiles = Object.keys(zip.files)
      .filter(n => /^books\/[^/]+\.json$/.test(n));
    const loaded = [];
    for (let i = 0; i < bookFiles.length; i++) {
      const n = bookFiles[i];
      if (onProgress) onProgress(i / bookFiles.length, `正在读取 ${i + 1}/${bookFiles.length}`);
      const o = JSON.parse(await zip.file(n).async('string'));
      const b = await this.unpackBook(o);
      const af = zip.file('annots/' + o.id + '.json');
      const annotList = af ? JSON.parse(await af.async('string')) : [];
      loaded.push({ b, annotList });
      await new Promise(r => setTimeout(r, 0));
    }

    if (mode === 'replace') {
      // 二次确认已在调用方（main.js 的导入向导）用页面内弹窗完成，这里不再用
      // 不可靠的 confirm()（嵌入式 WebView / iPad 上 confirm 常被吞掉，导致
      // 「两种模式都没反应、无法恢复备份」）。上面已把整包读进内存，这里才清空，
      // 避免「清了却没恢复回来」。
      await DB.wipe();
    }

    const curBooks = await DB.getAll('books');
    const existing = new Set(curBooks.map(b => b.id));
    const titleSet = new Set(curBooks.map(b => b.title || ''));
    let added = 0, skipped = 0, annots = 0, mergedAnnots = 0, inkStrokes = 0, savedAsNew = 0;
    // 去重指纹与手迹合并都在 mergeAnnots() 里（共享收书共用同一套）

    // 撞名时补序号：X → X（1）→ X（2）…（R133 与导入/改名同一套规则）
    const uniqTitle = (t) => {
      const raw = String(t || '').trim() || '未命名';
      if (!titleSet.has(raw)) return raw;
      const base = titleBase(raw);
      let n = 1;
      while (titleSet.has(base + '（' + n + '）')) n++;
      return base + '（' + n + '）';
    };

    for (const { b, annotList } of loaded) {
      // R67：之前「书已存在」就整本 skip，连标注也不导 —— 于是「合并恢复」时
      // 那些书的高光/笔记/手迹一条都进不来，用户看到的就是「备份里没有字迹」。
      // 现在改成：书已存在也照样把标注并进来（逐条去重，不会变两份）。
      // R71：用户可能「就是想要两份同一本书，各自的书签/笔记不一样」——那时
      // 恢复向导会问「合并还是每本另存」，dupMode='new' 就走下面这条另存分支。
      let targetId = b.id;
      if (!existing.has(b.id)) {
        // R133：恢复到一台「已有同名、但 id 不同」的书的机器上时，别造出两本一模一样的
        b.title = uniqTitle(b.title);
        await DB.put('books', b);
        existing.add(b.id);
        titleSet.add(b.title || '');
        added++;
      } else if (dupMode === 'new') {
        targetId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const copy = Object.assign({}, b, {
          id: targetId,
          title: uniqTitle(b.title),
          addedAt: Date.now(),
          lastReadAt: Date.now()
        });
        await DB.put('books', copy);
        existing.add(targetId);
        titleSet.add(copy.title);
        added++; savedAsNew++;
      } else {
        skipped++;
      }

      const s = await this.mergeAnnots(targetId, annotList, { from: b.id });
      annots += s.annots; mergedAnnots += s.mergedAnnots; inkStrokes += s.inkStrokes;
      await new Promise(r => setTimeout(r, 0));
    }

    /* 收藏夹（R84）
       老逻辑有两个坑，正好凑成用户看到的「收藏夹恢复不成功」：
       ① 只按 id 新增，已存在的 id 整条跳过 —— 备份里的名字 / 父子层级 / 排序 / 颜色
          一个字都不写回去。用户改名或挪过收藏夹后恢复备份，夹子还是旧样子，看起来像没恢复。
          现在改成「以备份为准覆盖」：同 id 保留本地对象，但把备份里的这几个字段同步过来。
       ② 全程不报告。备份里 `collections: []`（见 exportBooks 的注释）时，恢复完照样打印
          「✅ 合并完成」，用户以为收藏夹回来了，其实一个都没有。
          现在把「备份里几个 / 新增几个 / 更新几个」都算出来交给 UI 明说。 */
    const mColls = Array.isArray(manifest.collections) ? manifest.collections : [];
    let collAdded = 0, collUpdated = 0;
    if (mColls.length) {
      const cur = (await DB.kvGet('collections', [])) || [];
      const byId = new Map(cur.map(c => [c.id, c]));
      for (const c of mColls) {
        if (!c || !c.id) continue;
        const old = byId.get(c.id);
        if (!old) {
          cur.push(Object.assign({}, c));
          byId.set(c.id, c);
          collAdded++;
          continue;
        }
        let dirty = false;
        for (const k of ['name', 'parent', 'order', 'color', 'scope', 'collapsed']) {
          if (k in c && old[k] !== c[k]) { old[k] = c[k]; dirty = true; }
        }
        if (dirty) collUpdated++;
      }
      // 父夹没跟着来（选书备份 / 旧备份里父夹被删过）→ 提升为顶层，
      // 否则这个夹子在侧栏树上永远渲染不出来，等于「恢复了但看不见」。
      for (const c of cur) {
        if (c && c.parent && !byId.has(c.parent)) { c.parent = null; collUpdated++; }
      }
      if (collAdded || collUpdated) await DB.kvSet('collections', cur);
    }

    /* 设置：覆盖模式一律跟着备份走；合并模式只在本地压根没有设置时才补
       （本地已有偏好就别被旧备份改回去）。 */
    let settingsRestored = false;
    if (manifest.settings && typeof manifest.settings === 'object') {
      const local = await DB.kvGet('settings', null);
      if (mode === 'replace' || !local) {
        await DB.kvSet('settings', manifest.settings);
        settingsRestored = true;
      }
    }

    return { added, skipped, annots, mergedAnnots, inkStrokes, savedAsNew,
             replaced: (mode === 'replace'),
             partial: !!manifest.partial, exportedAt: manifest.exportedAt, dupMode,
             collsInBackup: mColls.length, collAdded, collUpdated, settingsRestored };
  }
};
