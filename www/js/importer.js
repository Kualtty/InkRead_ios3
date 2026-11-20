/* ============================================================
   importer.js —— 文件导入：TXT（编码探测）/ PDF / 图片 / ZIP·CBZ / EPUB
   ============================================================ */

/* XML/HTML 实体解码 */
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* 扩展名 → MIME（EPUB/DOCX 内嵌图片转 dataURL 用） */
function mimeOf(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp', tiff: 'image/tiff',
    avif: 'image/avif' })[ext] || 'image/png';
}

/* 从 zip 资源读成 dataURL（EPUB/DOCX 内嵌图片内联，离线可读） */
async function loadEpubAsset(zip, path) {
  if (!path) return '';
  const f = zip.file(path) || zip.file(decodeURIComponent(path));
  if (!f) return '';
  try { const b64 = await f.async('base64'); return `data:${mimeOf(path)};base64,${b64}`; }
  catch (e) { return ''; }
}

/* 从 docx 的 document.xml 抽出纯文本 + 标题层级（目录）。
   额外处理两件原版丢掉的：
   1) 表格：抽单元格文字，行内用「 │ 」分隔，保留数据（视觉网格需富文本管线 FA-022）；
   2) 图片：在所在段落末尾标「〔图片〕」，避免被静默吞掉而用户毫无察觉。 */
function parseDocxText(xml) {
  // 文档块：表格优先匹配整块，避免表格内 <w:p> 被当成正文打乱顺序
  const blocks = xml.match(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/gi) || [];
  const cellRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:br\s*\/?>|<w:tab\s*\/?>/gi;
  let out = '';
  const chapters = [];

  for (const p of blocks) {
    // —— 表格：逐行抽单元格文本 ——
    if (/^<w:tbl/i.test(p)) {
      const rows = p.match(/<w:tr\b[\s\S]*?<\/w:tr>/gi) || [];
      if (rows.length) {
        const grid = rows.map(r => {
          const cells = r.match(/<w:tc\b[\s\S]*?<\/w:tc>/gi) || [];
          return cells.map(c => {
            let t = '', m; cellRe.lastIndex = 0;
            while ((m = cellRe.exec(c))) {
              if (/^<w:br/i.test(m[0])) t += ' ';
              else if (/^<w:tab/i.test(m[0])) t += ' ';
              else t += m[1];
            }
            return decodeEntities(t).replace(/\s+/g, ' ').trim();
          });
        });
        out += '\n' + grid.map(r => r.join(' │ ')).join('\n') + '\n\n';
      }
      continue;
    }

    // —— 普通段落 ——
    let t = '', m; cellRe.lastIndex = 0;
    while ((m = cellRe.exec(p))) {
      if (/^<w:br/i.test(m[0])) t += '\n';
      else if (/^<w:tab/i.test(m[0])) t += '\t';
      else t += m[1];
    }
    const hasImg = /<w:drawing\b|<pic:pic\b|<w:object\b/i.test(p);
    const line = decodeEntities(t).replace(/[ \t]+$/gm, '').trim();

    // 标题级别：Heading1/标题 1/outlineLvl
    let level = 0;
    const st = /<w:pStyle\s+w:val="([^"]+)"/i.exec(p);
    if (st) {
      const s = st[1];
      const mm = /heading\s*(\d)/i.exec(s) || /标题\s*(\d)/.exec(s) || /^(\d)$/.exec(s);
      if (mm) level = Math.min(6, parseInt(mm[1], 10));
      else if (/title|标题/i.test(s) && !/正文|normal|body|list/i.test(s)) level = 1;
    }
    const ol = /<w:outlineLvl\s+w:val="(\d+)"/i.exec(p);
    if (!level && ol) level = Math.min(6, parseInt(ol[1], 10) + 1);

    if (level) {
      chapters.push({ title: line.slice(0, 40), offset: out.length, level });
      out += '\n' + line + (hasImg ? ' 〔图片〕' : '') + '\n';
    } else {
      out += line + (hasImg ? ' 〔图片〕' : '') + '\n';
    }
  }

  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, chapters };
}

/* DOCX → 富文本 HTML：保留标题层级、表格、内嵌图片（转 dataURL）。
   返回 { html, images, chapters }。图片需要 zip（读 word/media + document.xml.rels）。 */
async function docxToHtml(xml, zip) {
  // rId → 媒体路径
  let rels = {};
  const relsXml = zip.file('word/_rels/document.xml.rels');
  if (relsXml) {
    const r = await relsXml.async('string');
    const re = /<Relationship\b[^>]*?\bid="([^"]+)"[^>]*?\bTarget="([^"]+)"[^>]*?\/?>/gi;
    let m;
    while ((m = re.exec(r))) {
      let t = m[2];
      if (t.startsWith('/')) t = t.slice(1);
      else if (!/^https?:/i.test(t) && !t.includes(':')) t = 'word/' + t;
      rels[m[1]] = t;
    }
  }
  const images = {};
  const dataUrlFor = async (rid) => {
    const target = rels[rid];
    if (!target) return '';
    const url = await loadEpubAsset(zip, target);
    if (url) images[rid] = url;
    return url;
  };
  const blocks = xml.match(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/gi) || [];
  const cellRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:br\s*\/?>|<w:tab\s*\/?>/gi;
  const textOf = (node) => {
    let t = '', m; cellRe.lastIndex = 0;
    while ((m = cellRe.exec(node))) {
      if (/^<w:br/i.test(m[0])) t += ' ';
      else if (/^<w:tab/i.test(m[0])) t += ' ';
      else t += m[1];
    }
    return decodeEntities(t);
  };
  // 解析段落中的 run / hyperlink 混合序列，保留超链接（修：DOCX 内外链丢失）
  const paraHtml = async (p) => {
    // 先抽出段落主体（去掉开头的 pPr 等属性段）
    const body = p.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, '');
    // DOCX 内部链接靠书签定位：<w:hyperlink w:anchor="X"> 已转成 <a href="#X">，
    // 但 <w:bookmarkStart w:name="X"/> 目标若没拿到 id，getElementById 永远找不到 → 内链跳不动。
    // 这里把书签名注入成带 id 的零尺寸锚点，使内部链接可定位（修 T6：真实 docx 内链失效）。
    const bms = [...p.matchAll(/<w:bookmarkStart\b[^>]*?\bw:name="([^"]+)"/gi)].map(m => m[1]);
    const bmAnchor = bms.length ? bms.map(n => `<span id="${escHtml(n)}"></span>`).join('') : '';
    // 拆分顶层 inline 元素：w:r / w:hyperlink（不支持嵌套）
    const inlines = body.match(/<w:hyperlink\b[\s\S]*?<\/w:hyperlink>|<w:r\b[\s\S]*?<\/w:r>|<w:r\b[^>]*\/>/gi) || [];
    let out = '';
    for (const node of inlines) {
      if (/^<w:hyperlink/i.test(node)) {
        let href = '';
        const rid = /\br:id="([^"]+)"/i.exec(node);
        const anchor = /\bw:anchor="([^"]+)"/i.exec(node);
        if (anchor) {
          href = '#' + anchor[1];
        } else if (rid && rels[rid[1]]) {
          const t = rels[rid[1]];
          if (/^https?:/i.test(t) || /^#/.test(t)) href = t;
          else href = '#' + t;                 // relationship 指向 bookmark name
        }
        const txt = textOf(node).trim();
        if (href && txt) out += `<a href="${escHtml(href)}">${escHtml(txt)}</a>`;
        else out += escHtml(txt);
      } else {
        out += escHtml(textOf(node));
      }
    }
    out = bmAnchor + out;
    // 处理段落内图片（嵌入在任意 run 中）
    let imgHtml = '';
    const blips = p.match(/<a:blip\b[^>]*?\br:embed="([^"]+)"/gi) || [];
    for (const b of blips) {
      const rid = /r:embed="([^"]+)"/i.exec(b)[1];
      const url = await dataUrlFor(rid);
      if (url) imgHtml += `<img src="${url}" alt="">`;
    }
    if (imgHtml && !out.trim()) return imgHtml;
    if (!out.trim() && !imgHtml) return '';
    return `${imgHtml}${out}`;
  };
  let html = '', hi = 0; const chapters = [];
  for (const p of blocks) {
    if (/^<w:tbl/i.test(p)) {                       // 表格
      const rows = p.match(/<w:tr\b[\s\S]*?<\/w:tr>/gi) || [];
      if (rows.length) {
        let tbl = '<table>';
        for (const r of rows) {
          const cells = r.match(/<w:tc\b[\s\S]*?<\/w:tc>/gi) || [];
          tbl += '<tr>';
          for (const c of cells) {
            const txt = textOf(c).replace(/[ \t]+$/gm, '').trim();
            tbl += `<td>${escHtml(txt)}</td>`;
          }
          tbl += '</tr>';
        }
        tbl += '</table>';
        html += tbl;
      }
      continue;
    }
    const inner = await paraHtml(p);
    const line = textOf(p).replace(/[ \t]+$/gm, '').trim();
    let level = 0;
    const st = /<w:pStyle\s+w:val="([^"]+)"/i.exec(p);
    if (st) {
      const s = st[1];
      const mm = /heading\s*(\d)/i.exec(s) || /标题\s*(\d)/.exec(s) || /^(\d)$/.exec(s);
      if (mm) level = Math.min(6, parseInt(mm[1], 10));
      else if (/title|标题/i.test(s) && !/正文|normal|body|list/i.test(s)) level = 1;
    }
    if (level) {
      const id = 'h-' + (++hi);
      chapters.push({ title: line.slice(0, 40), offset: '#' + id, level });
      html += `<h${level} id="${id}">${inner}</h${level}>`;
    } else if (inner) {
      html += `<p>${inner}</p>`;
    }
  }
  return { html, images, chapters };
}

const Importer = {
  /* 图片格式：优先看 MIME，其次看扩展名。
     iPad 相册导出的照片常常是 .heic / .heif，只认扩展名会漏，
     漏掉的图片会被当成文本处理，然后报「这似乎不是纯文本文件」——很误导。 */
  IMAGE_EXT: ['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'webp', 'bmp', 'avif',
    'heic', 'heif', 'tif', 'tiff', 'ico'],
  /** R133：入库前统一去重（重名自动加「（1）」「（2）」），顺便记下这次改了哪几本 ——
      导入完成时的提示要说清楚「为什么书名和文件名不一样」，否则用户以为导错了。 */
  _titleOf(book) {
    const before = String(book.title == null ? '' : book.title);
    const u = uniqueBookTitle(before, book.id);
    book.title = u.title;
    if (u.changed) {
      if (!Array.isArray(Importer.lastRenamed)) Importer.lastRenamed = [];
      Importer.lastRenamed.push({ id: book.id, from: before, to: u.title });
    }
    return u.title;
  },

  isImage(f) {
    if (f.type && f.type.indexOf('image/') === 0) return true;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    return Importer.IMAGE_EXT.indexOf(ext) >= 0;
  },
  /** @param {File[]} files
   *  @param {(pct:number,msg:string)=>void} onProgress
   *  @returns {Promise<Array>} 已保存的 book 对象数组 */
  async import(files, onProgress) {
    const images = [];
    const books = [];
    const failed = [];
    Importer.lastBackupZips = [];   // 这次被认出来的「墨阅备份包」（上层转「恢复备份」）

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      onProgress(i / files.length, `处理 ${f.name}`);
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      try {
        if (Importer.isImage(f)) {
          images.push(f);
          continue;
        }
        if (ext === 'zip' || ext === 'cbz') {
          books.push(...await Importer._zip(f, onProgress, failed));
          continue;
        }
        if (ext === 'pdf') {
          books.push(await Importer._pdf(f));
          continue;
        }
        if (ext === 'epub') {
          books.push(await Importer._epub(f));
          continue;
        }
        if (['html', 'htm', 'xhtml'].includes(ext)) {
          books.push(await Importer._html(f));
          continue;
        }
        if (ext === 'docx') {
          books.push(await Importer._docx(f));
          continue;
        }
        // 旧版 .doc / .wps / .rtf / .odt 是私有二进制格式，浏览器无法解析；
        // 交给后端 LibreOffice 转成 HTML 再导入（需目标机装有 soffice）。
        if (['doc', 'wps', 'pages', 'rtf', 'odt'].includes(ext)) {
          books.push(await Importer._docViaServer(f));
          continue;
        }
        if (['md', 'markdown'].includes(ext)) {
          books.push(await Importer._markdown(f));
          continue;
        }
        if (['txt', 'text', 'json', 'log', 'srt', 'lrc', 'csv'].includes(ext)
          || (f.type && f.type.indexOf('text/') === 0)) {
          books.push(await Importer._txt(f));
          continue;
        }
        throw new Error(`暂不支持 .${ext} 格式。目前支持：TXT / Word(.docx) / PDF / EPUB / HTML / 漫画(ZIP·CBZ) / 图片(JPG·PNG·HEIC·WebP 等，多图合成一本漫画)`);
      } catch (err) {
        // 墨阅备份包不算「导入失败」——收起来交给上层走「恢复备份」，否则用户
        // 只会看到一句「压缩包内没有可用内容」，以为备份坏了（R68）。
        if (err && err.code === 'INK_BACKUP') {
          Importer.lastBackupZips.push(err.file || f);
          continue;
        }
        // 单本失败不影响其余文件
        console.error('导入失败', f.name, err);
        failed.push(`${f.name}：${err && err.message ? err.message : err}`);
      }
    }

    if (images.length) {
      images.sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));
      try {
        books.push(await Importer._images(images));
        Importer.lastImageCount = images.length;
      } catch (err) { failed.push('图片：' + err.message); }
    } else {
      Importer.lastImageCount = 0;
    }

    Importer.lastFailed = failed;
    return books;
  },

  /* ---------- TXT ---------- */
  async _txt(file) {
    const buf = await file.arrayBuffer();
    const text = Importer.decode(buf);
    if (Importer.looksBinary(text)) {
      throw new Error('这似乎不是纯文本文件（Word 请另存为 .docx，或导出为 .txt）');
    }
    const book = {
      id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: file.name.replace(/\.(txt|text)$/i, ''),
      format: 'txt',
      content: { kind: 'text', text },
      length: text.length,
      totalPages: 0,
      locator: 0,
      progress: 0,
      addedAt: Date.now(),
      lastReadAt: Date.now(),
      fav: false
    };
    book.chapters = parseChapters(text);
    book.tocDetected = true;
    Importer._titleOf(book);
    await DB.put('books', book);
    return book;
  },

  /* ---------- Markdown（.md / .markdown） ----------
     旧行为：和 txt 一样直接丢纯文本 → 用户看到的是 `### 相关性`、`[[双链]]`、`![[图片]]`
     这些原始符号，目录也只能靠 parseChapters 猜（`#` 开头的行它不认，几乎抽不出章节）。
     现在：解析成 HTML 再入库（和 EPUB/DOCX 走同一条富文本管线），
       · 标题按 `#` 的个数定层级（层级上限沿用 TOC_MAX_LEVEL，不跳级）
       · 列表/引用/代码块/表格/分隔线/加粗斜体/删除线/==高亮== 都会渲染
       · Obsidian 的 [[双链]] 渲染成可读文本；![[图片]] 因单文件导入拿不到附件，
         渲染成占位小标签（而不是显示一堆 `![[...]]` 符号）
     注意：`#` 与正文之间必须有空格（CommonMark 的硬规则），否则 `#话题` 不算标题。 */
  async _markdown(file) {
    const buf = await file.arrayBuffer();
    const text = Importer.decode(buf);
    if (Importer.looksBinary(text)) throw new Error('这似乎不是文本文件');
    const md = Importer.mdToBook(text, file.name.replace(/\.(md|markdown)$/i, ''));
    const book = {
      id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: md.title,
      format: 'html',
      content: { kind: 'html', html: md.html, images: {}, md: text },
      length: md.html.length,
      totalPages: 1,
      locator: 0,
      progress: 0,
      addedAt: Date.now(),
      lastReadAt: Date.now(),
      fav: false,
      chapters: md.chapters,
      tocDetected: true,
      srcExt: 'md'
    };
    Importer._titleOf(book);
    await DB.put('books', book);
    return book;
  },

  /** 文本像不像 Markdown（老版本把 .md 当 txt 存进来的书，打开时用它判断要不要现场转换）。
   *  条件刻意保守：至少 2 个行首标题 + 至少 1 个 Markdown 专有写法，
   *  避免把「正文里恰好有 # 号」的普通 txt 误判。 */
  looksMarkdown(text) {
    const s = String(text || '').slice(0, 30000);
    if (!s) return false;
    const heads = (s.match(/^[ \t]{0,3}#{1,6}[ \t]+\S/gm) || []).length;
    if (heads < 2) return false;
    const signals = [
      /^[ \t]{0,3}[-*+][ \t]+\S/m,          // 无序列表
      /^[ \t]{0,3}\d+[.)][ \t]+\S/m,        // 有序列表
      /\*\*[^*\n]+\*\*/,                     // 加粗
      /!?\[\[[^\]\n]+\]\]/,                  // Obsidian 双链 / 嵌入
      /^[ \t]{0,3}```/m,                     // 代码块
      /^[ \t]{0,3}>[ \t]?\S/m,               // 引用
      /^[ \t]*\|[^\n]*\|[ \t]*\n[ \t]*\|[\s:|-]+\|/m  // 表格
    ];
    return signals.some(re => re.test(s));
  },

  /** 旧书迁移：把当成 txt 存进来的 Markdown 就地转成富文本（返回是否转换过） */
  convertLegacyMarkdown(book) {
    try {
      if (!book || book.format !== 'txt') return false;
      const text = book.content && book.content.text;
      if (!Importer.looksMarkdown(text)) return false;
      const md = Importer.mdToBook(text, book.title || '');
      book.format = 'html';
      book.content = { kind: 'html', html: md.html, images: {}, md: text };
      book.length = md.html.length;
      book.totalPages = 1;
      book.chapters = md.chapters;
      book.tocDetected = true;
      book.tocCleared = false;
      book.srcExt = 'md';
      return true;
    } catch (e) {
      console.warn('Markdown 迁移失败', e);
      return false;
    }
  },

  /** Markdown 源码 → { title, html, chapters } */
  mdToBook(src, fallbackTitle) {
    const text = String(src || '').replace(/\r\n?/g, '\n');
    const { html, headings } = Importer.mdToHtml(text);
    const firstH1 = headings.find(h => h.level === 1);
    // 书名优先用文件名（Obsidian 的笔记名就是文件名）；首个 H1 常是「1指标」这种章节名，
    // 拿来当书名反而莫名其妙（R57 用户实测：一本《分类模型》显示成「1指标」）。
    const title = fallbackTitle || (firstH1 && firstH1.text) || '未命名';
    // 目录：层级按 `#` 的个数「归一化」成连续层，父→子只升 1 级。
    // 用户在 md 里常跳着写（`# 3模型` 下面直接 `### 方法比较`），照抄个数会让目录
    // 突然缩进两格、看着像「### 识别不准」；归一后 `###` 就是 `#` 的直接子级。
    // 上限跟 paginator.js 的 TOC_MAX_LEVEL 对齐，避免这里先截断、那边再截断两次。
    const MAX = (typeof TOC_MAX_LEVEL === 'number' ? TOC_MAX_LEVEL : 6);
    const stack = [];                       // [{ d: 原始 # 个数, level: 归一层级 }]
    const chapters = headings.map(h => {
      const d = Math.max(1, Math.min(6, h.level || 1));
      while (stack.length && stack[stack.length - 1].d >= d) stack.pop();
      const level = Math.min(MAX, stack.length ? stack[stack.length - 1].level + 1 : 1);
      stack.push({ d, level });
      return {
        title: String(h.text).slice(0, 60),
        offset: '#' + h.id,
        level
      };
    });
    return { title, html, chapters };
  },

  /** Markdown → HTML（够用的块级 + 行内语法，不追求完整 CommonMark） */
  mdToHtml(src) {
    // ---- 块级公式先整段挖走 ----
    // 下面按行遍历、每行单独走 mdInline（段落内用 <br> 拼接）。跨行的
    //   $$X=\begin{matrix} … \end{matrix}$$
    // 一旦被拆成多行，`$$` 在两行里各出现一次却都不配对，正则匹配不上 →
    // 整段矩阵按普通文字输出（用户反馈「这个没有转换」就是这个）。
    // 所以先在整篇源码上做一次多行匹配，换成单行占位符，让它独立成块。
    const mathBlocks = [];
    // 做法：把源码按「围栏代码块」切成若干段，只在**非代码段**里挖 $$…$$。
    //  - 允许 $$ 出现在行中间（`建立模型$$y=…$$` 这种写法），也允许跨多行（矩阵）；
    //  - 代码块里原样保留（笔记里贴 LaTeX 源码不能变成公式）。
    // 挖掉后补两个换行 → 公式独立成段，不跟前后文字挤在同一个 <p> 里。
    const rawLines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const rebuilt = [];
    let inFence = false;
    let chunk = [];
    const flushChunk = () => {
      if (!chunk.length) return;
      const t = chunk.join('\n').replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => {
        mathBlocks.push(tex.trim());
        return '\n\n\u0002M' + (mathBlocks.length - 1) + '\u0002\n\n';
      });
      t.split('\n').forEach(l => rebuilt.push(l));
      chunk = [];
    };
    for (const ln of rawLines) {
      const fence = /^[ \t]{0,3}(```+|~~~+)/.test(ln);
      if (inFence) { rebuilt.push(ln); if (fence) inFence = false; continue; }
      if (fence) { flushChunk(); rebuilt.push(ln); inFence = true; continue; }
      chunk.push(ln);
    }
    flushChunk();

    const lines = rebuilt;
    const out = [];
    const headings = [];
    let i = 0, hn = 0;

    const inline = (s) => Importer.mdInline(s);
    const flushPara = (para) => { if (para.length) out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para.length = 0; };

    /** 块级公式 → 一个独立的 .ink-math 块。渲染由 InkMath.renderIn 负责；
     *  这里就把 data-srclen 写死（源码长度），否则 assignHtmlOffsets 会把这段
     *  公式当成 0 字符，后面所有笔记 / 书签的偏移全部前移一整段公式的长度。 */
    const emitMathBlock = (tex) => {
      const flat = String(tex || '').replace(/\s*\n\s*/g, ' ').trim();
      if (!flat) return;
      out.push('<div class="ink-math math-display" data-tex="' + escHtml(flat) + '"'
        + ' data-display="1" data-srclen="' + (flat.length + 4) + '"></div>');
    };

    const parseListTree = (blockLines) => {
      const items = [];
      blockLines.forEach(l => {
        const m = /^([ \t]*)([-*+]|\d{1,3}[.)])[ \t]+(.*)$/.exec(l);
        if (m) {
          items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), text: m[3] });
        } else if (items.length && l.trim()) {
          items[items.length - 1].text += '<br>' + escHtml(l.trim());
        }
      });
      const root = { children: [], indent: -1 };
      const stack = [root];
      items.forEach(it => {
        while (stack.length > 1 && it.indent <= stack[stack.length - 1].indent) stack.pop();
        const node = { ordered: it.ordered, text: it.text, indent: it.indent, children: [] };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
      });
      const render = (nodes, ordered) => {
        const tag = ordered ? 'ol' : 'ul';
        return '<' + tag + '>' + nodes.map(n =>
          '<li>' + inline(n.text) + (n.children.length ? render(n.children, n.children[0].ordered) : '') + '</li>'
        ).join('') + '</' + tag + '>';
      };
      return root.children.length ? render(root.children, root.children[0].ordered) : '';
    };

    const para = [];
    while (i < lines.length) {
      const line = lines[i];

      // 代码块（围栏）
      const fence = /^[ \t]{0,3}(```+|~~~+)[ \t]*([\w+-]*)[ \t]*$/.exec(line);
      if (fence) {
        flushPara(para);
        const mark = fence[1][0];
        const buf = [];
        i++;
        while (i < lines.length && !new RegExp('^[ \\t]{0,3}' + mark + '{3,}[ \\t]*$').test(lines[i])) buf.push(lines[i++]);
        i++;                                        // 跳过结束围栏
        const cls = fence[2] ? ' class="language-' + escHtml(fence[2]) + '"' : '';
        out.push('<pre class="md-pre"><code' + cls + '>' + escHtml(buf.join('\n')) + '</code></pre>');
        continue;
      }

      if (!line.trim()) { flushPara(para); i++; continue; }

      // 块级公式占位符（上面预替换进来的）：独立成块，不参与段落拼接
      const mb = /^\u0002M(\d+)\u0002$/.exec(line.trim());
      if (mb) {
        flushPara(para);
        emitMathBlock(mathBlocks[+mb[1]]);
        i++;
        continue;
      }

      // 标题
      const h = /^[ \t]{0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(line);
      if (h) {
        flushPara(para);
        const level = h[1].length;
        const raw = h[2].trim();
        const plain = Importer.mdPlain(raw);
        if (plain) {
          const id = 'h-' + (++hn);
          headings.push({ level, text: plain, id, html: raw });
          out.push('<h' + level + ' id="' + id + '">' + inline(raw) + '</h' + level + '>');
        }
        i++;
        continue;
      }

      // 分隔线
      if (/^[ \t]{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/.test(line)) {
        flushPara(para); out.push('<hr class="md-hr">'); i++; continue;
      }

      // 表格：本行有 | 且下一行是 |---|---|
      if (line.includes('|') && /^[ \t]{0,3}\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/.test(lines[i + 1] || '')) {
        flushPara(para);
        const cells = (l) => l.replace(/^[ \t]*\|/, '').replace(/\|[ \t]*$/, '').split('|').map(x => x.trim());
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push('<table class="md-table"><thead><tr>'
          + head.map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>'
          + rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('')
          + '</tbody></table>');
        continue;
      }

      // 引用
      if (/^[ \t]{0,3}>/.test(line)) {
        flushPara(para);
        const buf = [];
        while (i < lines.length && /^[ \t]{0,3}>/.test(lines[i])) buf.push(lines[i++].replace(/^[ \t]{0,3}>[ \t]?/, ''));
        out.push('<blockquote class="md-quote">' + buf.map(x => inline(x)).join('<br>') + '</blockquote>');
        continue;
      }

      // 列表（连续的列表行 + 缩进续行）
      if (/^[ \t]{0,3}([-*+]|\d{1,3}[.)])[ \t]+\S/.test(line)) {
        flushPara(para);
        const buf = [];
        while (i < lines.length) {
          const l = lines[i];
          if (/^[ \t]{0,3}([-*+]|\d{1,3}[.)])[ \t]+\S/.test(l)) { buf.push(l); i++; continue; }
          if (!l.trim()) {
            // 空行后如果还是列表（且缩进 ≥ 2）→ 继续；否则列表结束
            const nx = lines[i + 1] || '';
            if (/^[ \t]{2,}([-*+]|\d{1,3}[.)])[ \t]+\S/.test(nx) || /^[ \t]{2,}\S/.test(nx)) { i++; continue; }
            break;
          }
          if (/^[ \t]{2,}\S/.test(l)) { buf.push(l); i++; continue; }   // 续行 / 嵌套项
          break;
        }
        out.push(parseListTree(buf));
        continue;
      }

      para.push(line.trim());
      i++;
    }
    flushPara(para);
    return { html: out.join('\n'), headings };
  },

  /** 行内标记 → HTML（先转义，再按顺序替换，避免把生成的标签又转义一遍） */
  mdInline(src) {
    // 先把数学公式（$...$ / $$...$$）整段挖出来换成占位符。
    // 不挖的话 \theta_{0} 里的下划线会被下面「_斜体_」的规则吃掉，
    // 表现为「公式变成斜体、花括号不见了」，用户只能看到一堆怪符号。
    const math = [];
    let rawsrc = String(src == null ? '' : src);
    rawsrc = rawsrc.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => {
      math.push({ tex: tex, disp: true }); return '\u0001' + (math.length - 1) + '\u0001';
    });
    rawsrc = rawsrc.replace(/\$([^$\n]+?)\$/g, (m, tex) => {
      const okMath = (typeof InkMath !== 'undefined') ? InkMath.looksMath(tex) : /[\^_{}=]/.test(tex);
      if (!okMath) return m;                     // $5.99 这类别当成公式
      math.push({ tex: tex, disp: false }); return '\u0001' + (math.length - 1) + '\u0001';
    });
    let t = escHtml(rawsrc);
    const hold = [];                              // 先把行内代码挖出来，避免 `**` 之类被误处理
    t = t.replace(/`([^`\n]+)`/g, (m, code) => {
      hold.push('<code class="md-code">' + code + '</code>');
      return '\u0000' + (hold.length - 1) + '\u0000';
    });
    // 图片：Obsidian 嵌入 / Markdown 图片
    t = t.replace(/!\[\[([^\]\n]+)\]\]/g, (m, n) => '<span class="md-img">🖼 ' + n + '</span>');
    t = t.replace(/!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
      (m, alt, url) => /^data:/.test(url) ? '<img src="' + url + '" alt="' + alt + '">'
        : '<span class="md-img">🖼 ' + (alt || url) + '</span>');
    // Obsidian 双链：[[文件#小标题|显示文字]]
    t = t.replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g, (m, tgt, label) => {
      const shown = label || String(tgt).replace(/#/g, ' › ');
      return '<span class="md-link">' + shown + '</span>';
    });
    // 普通链接
    t = t.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // 加粗 / 斜体 / 删除线 / ==高亮==
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    t = t.replace(/==([^=\n]+)==/g, '<mark class="md-mark">$1</mark>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    // 还原公式：这里只放占位标签，真正的排版交给 InkMath.renderIn（DOM 阶段）
    t = t.replace(/\u0001(\d+)\u0001/g, (m, k) => {
      const x = math[+k];
      if (!x) return '';
      return '<span class="ink-math" data-tex="' + escHtml(x.tex) + '"'
        + (x.disp ? ' data-display="1"' : '') + '></span>';
    });
    // 还原行内代码
    t = t.replace(/\u0000(\d+)\u0000/g, (m, k) => hold[+k] || '');
    return t;
  },

  /** 去掉行内标记，取纯文本（目录标题用） */
  mdPlain(s) {
    return String(s || '')
      .replace(/!\[\[([^\]\n]+)\]\]/g, '$1')
      .replace(/!\[([^\]\n]*)\]\([^)]*\)/g, '$1')
      .replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g, (m, a, b) => b || a.replace(/#/g, ' › '))
      .replace(/\[([^\]\n]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_~=`]/g, '')
      .trim();
  },

  /** HTML → Markdown（反向还原，给「老版本导入、没存 md 源码」的书当编辑起点用）。
   *  只覆盖 mdToHtml 会产出的那些标签，保证「打开 → 不动 → 保存」不会把内容改坏太多。 */
  htmlToMd(html) {
    let doc;
    try { doc = new DOMParser().parseFromString('<div id="__r">' + String(html || '') + '</div>', 'text/html'); }
    catch (e) { return ''; }
    const root = doc.getElementById('__r');
    if (!root) return '';
    const inline = (node) => {
      let s = '';
      node.childNodes.forEach(n => {
        if (n.nodeType === 3) { s += n.nodeValue; return; }
        if (n.nodeType !== 1) return;
        const t = n.tagName.toLowerCase();
        const cls = n.className || '';
        if (t === 'br') s += '  \n';
        else if (t === 'strong' || t === 'b') s += '**' + inline(n) + '**';
        else if (t === 'em' || t === 'i') s += '*' + inline(n) + '*';
        else if (t === 'del' || t === 's') s += '~~' + inline(n) + '~~';
        else if (t === 'mark') s += '==' + inline(n) + '==';
        else if (t === 'code') s += '`' + n.textContent + '`';
        else if (t === 'a') s += '[' + inline(n) + '](' + (n.getAttribute('href') || '') + ')';
        else if (t === 'img') s += '![' + (n.getAttribute('alt') || '') + '](' + (n.getAttribute('src') || '') + ')';
        else if (t === 'span' && /(^|\s)md-img(\s|$)/.test(cls)) {
          s += '![[' + (n.textContent || '').replace(/^\s*🖼\s*/, '').trim() + ']]';
        } else if (t === 'span' && /(^|\s)md-link(\s|$)/.test(cls)) s += '[[' + (n.textContent || '').trim() + ']]';
        else s += inline(n);
      });
      return s;
    };
    const out = [];
    const walk = (el, depth) => {
      Array.from(el.children).forEach(n => {
        const t = n.tagName.toLowerCase();
        if (/^h[1-6]$/.test(t)) out.push('#'.repeat(+t[1]) + ' ' + inline(n).trim());
        else if (t === 'p') { const s = inline(n).trim(); if (s) out.push(s); }
        else if (t === 'pre') out.push('```\n' + String(n.textContent || '').replace(/\n+$/, '') + '\n```');
        else if (t === 'blockquote') {
          const s = inline(n).trim().split('\n').map(l => '> ' + l).join('\n');
          if (s) out.push(s);
        } else if (t === 'ul' || t === 'ol') {
          Array.from(n.children).forEach((li, k) => {
            if (li.tagName.toLowerCase() !== 'li') return;
            out.push('  '.repeat(depth) + (t === 'ol' ? (k + 1) + '. ' : '- ') + inline(li).trim());
          });
        } else if (t === 'table') {
          const rows = Array.from(n.querySelectorAll('tr')).map(tr =>
            Array.from(tr.children).map(td => inline(td).trim().replace(/\|/g, '\\|')));
          if (rows.length) {
            out.push('| ' + rows[0].join(' | ') + ' |');
            out.push('| ' + rows[0].map(() => '---').join(' | ') + ' |');
            rows.slice(1).forEach(r => out.push('| ' + r.join(' | ') + ' |'));
          }
        } else if (t === 'hr') out.push('---');
        else if (t === 'figure' || t === 'div' || t === 'section') {
          const hasBlock = Array.from(n.children).some(c => /^(p|h[1-6]|ul|ol|table|pre|blockquote|figure|div|section)$/.test(c.tagName.toLowerCase()));
          if (hasBlock) walk(n, depth);
          else { const s = inline(n).trim(); if (s) out.push(s); }
        } else { const s = inline(n).trim(); if (s) out.push(s); }
      });
    };
    walk(root, 0);
    return out.join('\n\n').replace(/\n{3,}/g, '\n\n') + '\n';
  },

  /* ---------- Word .docx ---------- */
  async _docx(file) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip 未加载');
    const zip = await JSZip.loadAsync(file);
    const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
    const docPath = names.find(n => /^word\/document\.xml$/i.test(n)) || names.find(n => /document\.xml$/i.test(n));
    if (!docPath) throw new Error('不是有效的 Word 文档（.docx 内缺少 document.xml）');
    const xml = await zip.file(docPath).async('string');
    let html = '', images = {}, docChapters = null;
    try {
      const r = await docxToHtml(xml, zip);
      if (r && r.html && r.html.trim()) { html = r.html; images = r.images || {}; docChapters = r.chapters; }
    } catch (e) { html = ''; }
    let format, content, chaps;
    if (html && html.trim()) {
      format = 'html';
      content = { kind: 'html', html, images };
      chaps = (docChapters && docChapters.length) ? docChapters : [];
    } else {
      const { text: out, chapters: c2 } = parseDocxText(xml);
      if (!out) throw new Error('文档内没有可提取的文字（扫描件/纯图片 Word 暂不支持）');
      format = 'txt';
      content = { kind: 'text', text: out };
      chaps = c2.length ? c2 : parseChapters(out);
    }
    const book = {
      id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: file.name.replace(/\.docx$/i, ''),
      format,
      content,
      length: format === 'html' ? html.length : content.text.length,
      totalPages: 1,
      locator: 0,
      progress: 0,
      addedAt: Date.now(),
      lastReadAt: Date.now(),
      fav: false,
      chapters: chaps
    };
    Importer._titleOf(book);
    await DB.put('books', book);
    return book;
  },

  /* ---------- 二进制兜底：防止任何非文本文件被当 txt 解成乱码 ---------- */
  looksBinary(s) {
    if (!s) return false;
    const sample = s.slice(0, 4000);
    let bad = 0;
    for (let i = 0; i < sample.length; i++) {
      const c = sample.charCodeAt(i);
      if (c === 9 || c === 10 || c === 13) continue;
      if (c < 32 || c === 0xFFFD) bad++;
    }
    return bad / sample.length > 0.05;
  },

  /** 编码探测：UTF-8（含 BOM）→ GBK → Big5 → UTF-16 → Latin1 */
  decode(buf) {
    const u8 = new Uint8Array(buf);
    if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(u8.subarray(3));
    }
    if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder('utf-16be').decode(u8);
    if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder('utf-16le').decode(u8);

    // 严格 UTF-8 校验
    let ok = true;
    for (let i = 0; i < u8.length && i < 200000; i++) {
      const b = u8[i];
      if (b < 0x80) continue;
      let need = 0;
      if (b >= 0xC2 && b <= 0xDF) need = 1;
      else if (b >= 0xE0 && b <= 0xEF) need = 2;
      else if (b >= 0xF0 && b <= 0xF4) need = 3;
      else { ok = false; break; }
      for (let k = 1; k <= need; k++) {
        if ((u8[i + k] & 0xC0) !== 0x80) { ok = false; break; }
      }
      if (!ok) break;
      i += need;
    }
    if (ok) return new TextDecoder('utf-8').decode(u8);

    // GBK / Big5：用常见字频粗判
    try {
      const gbk = new TextDecoder('gbk').decode(u8);
      const big5 = new TextDecoder('big5').decode(u8);
      const score = s => (s.match(/[的一是在不了有和人这中大为上个国我以要他时来用们]/g) || []).length;
      return score(gbk) >= score(big5) ? gbk : big5;
    } catch (e) {
      return new TextDecoder('utf-8').decode(u8);
    }
  },

  /* ---------- PDF ---------- */
  async _pdf(file) {
    if (location.protocol === 'file:') {
      throw new Error('请用本地服务器打开（python -m http.server），file:// 下 PDF 引擎无法加载');
    }
    if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js 未加载，请确认 vendor/pdf.min.js 存在');

    const raw = await file.arrayBuffer();
    // pdf.js 会接管（detach）交给它的 ArrayBuffer，必须另外复制一份用于持久化
    const forEngine = raw.slice(0);
    const forStore = raw.slice(0);

    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    let doc;
    try {
      doc = await pdfjsLib.getDocument({ data: forEngine }).promise;
    } catch (e) {
      throw new Error('PDF 解析失败：' + ((e && e.message) || e));
    }
    const buf = forStore;
    const book = {
      id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: file.name.replace(/\.pdf$/i, ''),
      format: 'pdf',
      content: { kind: 'pdf', data: buf },
      length: doc.numPages,
      totalPages: doc.numPages,
      locator: 0,
      progress: 0,
      addedAt: Date.now(),
      lastReadAt: Date.now(),
      fav: false,
      chapters: []
    };
    // 目录在打开时从 pdf.js 的 outline 动态读取（PDFRef 对象无法安全存入 IndexedDB）
    book.chapters = [];

    Importer._titleOf(book);
    await DB.put('books', book);
    return book;
  },

  /* ---------- 图片 / 漫画 ---------- */
  /** @param {File[]} files
   *  @param {string} [title] 显式书名（压缩包 / 文件夹里的分组名）。不传才用文件名/日期兜底。 */
  async _images(files, title) {
    const items = [];
    for (const f of files) {
      items.push({ name: f.name, blob: f });
    }
    const name = (title && String(title).trim())
      || (files.length === 1
        ? files[0].name.replace(/\.[^.]+$/, '')
        : `图片合辑 ${new Date().toLocaleDateString('zh-CN')}`);
    const book = {
      id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: name,
      format: 'comic',
      content: { kind: 'images', items },
      length: items.length,
      totalPages: items.length,
      locator: 0,
      progress: 0,
      addedAt: Date.now(),
      lastReadAt: Date.now(),
      fav: false,
      chapters: []
    };
    Importer._titleOf(book);
    await DB.put('books', book);
    return book;
  },

  /* ---------- ZIP / CBZ ---------- */
  async _zip(file, onProgress, failed) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip 未加载');
    const zip = await JSZip.loadAsync(file);

    // R68：墨阅自己的备份包（manifest.json + books/ + annots/）也会被拖进
    // 「导入书籍」这个入口 —— 它里面没有图片/PDF/EPUB，于是报「压缩包内没有可用内容」，
    // 用户会以为备份坏了。这里先认出来，抛一个带标记的错误，交给上层转成「恢复备份」。
    const mf = zip.file('manifest.json');
    if (mf) {
      let man = null;
      try { man = JSON.parse(await mf.async('string')); } catch (e) { /* 坏 json 当普通 zip 处理 */ }
      if (man && (man.app === 'InkReader' || Array.isArray(man.books))) {
        const err = new Error('这是墨阅的备份文件，不是书');
        err.code = 'INK_BACKUP';
        err.file = file;
        err.manifest = man;
        throw err;
      }
    }

    const entries = [];
    await Importer._expandZip(zip, '', entries, 0);
    const r = await Importer._treeToBooks(entries, onProgress, failed);
    if (!r.books.length) throw new Error('压缩包内没有可用内容（支持：图片 / TXT / EPUB / Word(.docx) / PDF / HTML；也可以把好几本书、好几本漫画一起打包成 zip）');
    return r.books;
  },

  /** 把 zip 摊平成「路径 + File」。
      ⚠ 里面还能再套 .zip / .cbz（最多 3 层）：常见的「一个包几本漫画」就是
      cbz 各打一份再塞进同一个 zip。展开时用压缩包自己的文件名做路径前缀，
      于是每本 cbz 各成一个分组、各成一本漫画，而不会全被当成一本。
      顺手跳过 macOS 打的 __MACOSX / .DS_Store。 */
  async _expandZip(zip, prefix, out, depth) {
    const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
    for (const n of names) {
      const base = n.split('/').pop() || n;
      if (/^__MACOSX\//.test(n) || /^\._/.test(base) || base === '.DS_Store') continue;
      const isArc = /\.(zip|cbz)$/i.test(base);
      if (isArc && depth < 3) {
        try {
          const buf = await zip.files[n].async('arraybuffer');
          const inner = await JSZip.loadAsync(buf);
          const gk = prefix + base.replace(/\.[^.]+$/, '');
          await Importer._expandZip(inner, gk + '/', out, depth + 1);
          continue;
        } catch (e) { /* 坏包/加密包：当普通文件走下面的「不支持」提示，别整批失败 */ }
      }
      const blob = await zip.files[n].async('blob');
      out.push({ path: prefix + n, file: new File([blob], base, { type: blob.type }) });
    }
  },

  /* 把一棵「文件树」（来自 zip 或文件夹）拆成多本书：
     - 每个书本文件（epub/docx/pdf/html/txt…）各自独立成一本；
     - 图片按顶层目录分组成漫画（跳过 images/media 等明显是「素材目录」的，避免把书的插图当漫画）；
     - 图文混杂（图+文本同目录）：文本单独成一本，图也单独成一本漫画，两本都保留、不丢内容。
     返回 book 数组；单个失败计入 failed，不影响其余。 */
  async _treeToBooks(entries, onProgress, failed, opts) {
    opts = opts || {};
    // groupBy:
    //   'top'（默认，zip/cbz 内） —— 用「压缩包内顶层目录」作分组键；
    //   'sub'（文件夹导入）         —— 用「所选根目录下的第一级子目录」作分组键，
    //                                  让 folderA/ 里的书归到收藏夹「folderA」，folderB/ 归到「folderB」，
    //                                  直接放在根目录下的书不参与子文件夹归类。
    const groupBy = opts.groupBy || 'top';
    const groupKeyOf = (path) => {
      const parts = path.split('/');
      if (groupBy === 'sub') {
        // parts[0] = 所选根文件夹名（如 MyBooks）；中间段 = 各级子目录。
        // 始终把根文件夹作为顶层收藏夹，形成「MyBooks/子/孙」嵌套，
        // 这样选择父文件夹导入时，父文件夹本身也会成为一个收藏夹（修 #16：无法导入父文件夹）。
        //   MyBooks/a.txt        → "MyBooks"          （根目录下的书也归入父收藏夹）
        //   MyBooks/a/b.txt      → "MyBooks/a"
        //   MyBooks/a/b/c.txt    → "MyBooks/a/b"
        return [parts[0], ...parts.slice(1, -1)].join('/');
      }
      return path.includes('/') ? parts[0] : '';
    };
    const BOOK_EXT = new Set(['epub', 'docx', 'pdf', 'html', 'htm', 'xhtml',
      'txt', 'text', 'md', 'markdown', 'rtf', 'odt', 'wps', 'pages']);
    const DOC_VIA_SERVER = new Set(['doc', 'wps', 'pages', 'rtf', 'odt']);
    // 明显是某本书「素材目录」的名字：里面的图片只是插图，不该被当成一本漫画
    const ASSET_DIR = /^(images?|img|media|assets?|figures?|pictures?|图片|插图|图|resource|resources|oebps|meta-inf|mimetype|styles?|fonts?)$/i;
    // 书内/工程类素材扩展名：导入时静默忽略，不计入「格式不支持」失败
    const ASSET_EXT = new Set(['css','ncx','opf','ttf','woff','woff2','otf','xml','xpgt','smil','plist','ds_store','xmp','json','js','ini','cfg','log','bat','sh','exe','dll','so','db','sqlite','bak','tmp']);
    const books = [];
    const groups = {};                  // 子文件夹名 → 该书 id 列表（仅 groupBy='sub' 且非空时才有意义）
    const byTop = Object.create(null);  // 图片分组键 → 图片 File[]
    const bookFiles = [], serverFiles = [];
    let i = 0; const total = entries.length || 1;
    for (const e of entries) {
      const ext = (e.path.split('.').pop() || '').toLowerCase();
      const gk = groupKeyOf(e.path);
      if (BOOK_EXT.has(ext)) { bookFiles.push({ file: e.file, gk }); continue; }
      if (DOC_VIA_SERVER.has(ext)) { serverFiles.push({ file: e.file, gk }); continue; }
      if (Importer.isImage(e.file)) { (byTop[gk] = byTop[gk] || []).push(e.file); continue; }
      // 其余：明显是书内素材/工程文件则忽略；看起来像书但不支持 → 计入失败，让汇总提示用户有几本因格式导入失败
      if (failed && !ASSET_EXT.has(ext)) failed.push(e.file.name + '：暂不支持 .' + ext + ' 格式');
    }
    // 把书归入分组（folderA/sub 各自成收藏夹）
    const tag = (book, gk) => {
      if (gk) { (groups[gk] = groups[gk] || []).push(book.id); }
      books.push(book);
    };
    // 书本文件各自独立导入
    for (const { file, gk } of bookFiles) {
      if (onProgress) onProgress(i++ / total, '导入 ' + file.name);
      try { tag(await Importer._importOneBookFile(file), gk); }
      catch (err) { failed.push(file.name + '：' + (err && err.message ? err.message : err)); }
    }
    for (const { file, gk } of serverFiles) {
      try { tag(await Importer._docViaServer(file), gk); }
      catch (err) { failed.push(file.name + '：' + (err && err.message ? err.message : err)); }
    }
    // 图片按分组键分组成漫画（跳过素材目录）
    for (const gk of Object.keys(byTop)) {
      if (ASSET_DIR.test(gk)) continue;
      const imgs = byTop[gk];
      if (!imgs.length) continue;
      // 分组名就是这本书的名字：以前一律叫「图片合辑 2026/11/18」，
      // 一个包里放几本漫画时根本分不出谁是谁（顺序还被数字后缀改掉）。
      try { tag(await Importer._images(imgs, gk ? gk.split('/').pop() : ''), gk); }
      catch (err) { failed.push('图片(' + (gk || '根目录') + ')：' + err.message); }
    }
    return { books, groups };
  },

  // 单个书本文件 → 对应导入器（被 _treeToBooks 与 importFolder 复用）
  async _importOneBookFile(f) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (ext === 'epub') return Importer._epub(f);
    if (ext === 'docx') return Importer._docx(f);
    if (['html', 'htm', 'xhtml'].includes(ext)) return Importer._html(f);
    if (['md', 'markdown'].includes(ext)) return Importer._markdown(f);
    if (['txt', 'text'].includes(ext)) return Importer._txt(f);
    if (ext === 'pdf') return Importer._pdf(f);
    if (['doc', 'wps', 'pages', 'rtf', 'odt'].includes(ext)) return Importer._docViaServer(f);
    throw new Error('暂不支持 .' + ext + ' 格式');
  },

  /* 文件夹导入：webkitdirectory 选来的 File 带 webkitRelativePath，复用 _treeToBooks 的拆本逻辑
     （书本文件各自成书、图片按顶层目录成漫画）。返回 { books, failed }。 */
  async importFolder(files, onProgress) {
    const entries = [];
    for (const f of files) {
      const rel = (f.webkitRelativePath || f.name).split('\\').join('/');
      entries.push({ path: rel, file: f });
    }
    return Importer.importEntries(entries, onProgress);
  },

  /* 同上，但路径由调用方给（安卓没有 webkitRelativePath：
     目录是原生 SAF 选择器拷到书库根的 .import-inbox 里，前端按相对路径逐个取回）。
     entries: [{ path: '我的漫画/ch1/01.jpg', file: File }] */
  async importEntries(entries, onProgress) {
    const failed = [];
    // groupBy:'sub' → 根目录下的「第一级子目录」各自成一个收藏夹，把里面的书归进去
    const r = await Importer._treeToBooks(entries, onProgress, failed, { groupBy: 'sub' });
    return { books: r.books, failed, groups: r.groups };
  },

  /* ---------- EPUB（基础：抽文本 + 图片） ---------- */
  async _epub(file) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip 未加载');
    const zip = await JSZip.loadAsync(file);
    const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);

    const findFile = (target) => {
      const low = target.toLowerCase();
      return names.find(n => n.toLowerCase() === low)
        || names.find(n => n.toLowerCase().endsWith('/' + low))
        || names.find(n => n.toLowerCase().endsWith(low));
    };
    const readText = async (p) => {
      if (!p) return null;
      const zf = zip.file(p) || zip.file(decodeURIComponent(p));
      return zf ? await zf.async('string') : null;
    };
    const decodePath = (p) => { try { return decodeURIComponent(p); } catch (e) { return p; } };

    // 1) 定位 OPF
    let opfPath = null;
    const container = await readText(findFile('META-INF/container.xml'));
    if (container) {
      const m = /full-path\s*=\s*["']([^"']+)["']/i.exec(container);
      if (m) opfPath = decodePath(m[1]);
    }
    if (!opfPath || !findFile(opfPath)) {
      opfPath = names.find(n => /\.opf$/i.test(n)) || null;
    }
    const opf = await readText(opfPath);
    if (!opf) throw new Error('不是有效的 EPUB（找不到 content.opf）');

    const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const resolve = (href) => {
      let p = decodePath((href || '').split('#')[0]);
      if (!p) return null;
      if (p.startsWith('/')) return p.slice(1);
      return base + p;
    };

    // 2) manifest：属性顺序与是否自闭合都不敏感
    const manifest = {};
    const mf = opf.match(/<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i);
    if (mf) {
      const itemRe = /<item\b([^>]*?)\/?>/gi;
      let m;
      while ((m = itemRe.exec(mf[1]))) {
        const attrs = m[1];
        const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs);
        const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs);
        const type = /\bmedia-type\s*=\s*["']([^"']+)["']/i.exec(attrs);
        const props = /\bproperties\s*=\s*["']([^"']+)["']/i.exec(attrs);
        if (id && href) manifest[id[1]] = { href: href[1], type: (type ? type[1] : ''), properties: (props ? props[1].toLowerCase() : '') };
      }
    }

    // 3) spine
    const spine = [];
    const sp = opf.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i);
    if (sp) {
      const re = /\bidref\s*=\s*["']([^"']+)["']/gi;
      let m;
      while ((m = re.exec(sp[1]))) spine.push(m[1]);
    }
    // 没有 spine 就按顺序取所有文本项
    const order = spine.length ? spine : Object.keys(manifest);

    const stripHTML = (s) => s
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n');

    // 收集每个 spine 文件的「解压路径 + 原文」，用于：① 拼纯文本 ② 抽目录（NAV/NCX/h1-h6）
    const spineFiles = [];
    for (const id of order) {
      const it = manifest[id];
      if (!it) continue;
      // EPUB 规范目录文档（EPUB3 nav / 文件名 nav.xhtml、toc.xhtml）只用于抽目录，
      // 绝不能当正文渲染——否则整张目录表会嵌进书的正文（「翻页目录嵌进 html 正文」真 bug）。
      // _epubToc 直接从 zip 里读 nav/ncx，跳过这里不影响目录抽取。
      if (/\bnav\b/.test(it.properties || '') || /(^|\/)(nav|toc)\.x?html?$/i.test(it.href || '')) continue;
      const mt = (it.type || '').toLowerCase();
      if (mt && !/xhtml|xml|html|text/.test(mt)) continue;
      const p = resolve(it.href);
      if (!p) continue;
      const html = await readText(p);
      if (!html) continue;
      // 兜底：spine 里若仍混入正文即目录的 nav 文档（manifest 没标 properties 的罕见情况），按内容识别跳过
      if (/<nav\b[^>]*epub:type\s*=\s*["']toc/i.test(html) && !/<h1/i.test(html.slice(0, 4000))) continue;
      spineFiles.push({ file: p, html });
    }

    // 拼装富文本（HTML）：保留图片/表格/链接，标题加 id 锚点，图片内联为 dataURL。
    // （与 WPS 一样读规范目录的 nav/ncx 仍可用，但锚点映射脆弱；
    //   这里改为「按 h1/h2/h3 建目录 + 锚点」更稳定，且图片/表格/链接都保留。）
    const images = {};                       // 原 src → dataURL
    const sanitizeBody = async (html, fileDir) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('script,style,head,meta,link').forEach(n => n.remove());
      // 图片内联
      const imgs = doc.querySelectorAll('img');
      for (const img of imgs) {
        const src = img.getAttribute('src') || '';
        if (!src || src.startsWith('data:') || /^https?:/i.test(src)) continue;
        const target = fileDir + src;          // 相对 spine 文件所在目录
        const url = await loadEpubAsset(zip, target);
        if (url) { images[src] = url; img.setAttribute('src', url); }
      }
      // SVG <image> 资源
      for (const im of doc.querySelectorAll('image')) {
        let href = im.getAttribute('href') || im.getAttribute('xlink:href') || '';
        if (!href || href.startsWith('data:') || /^https?:/i.test(href)) continue;
        const url = await loadEpubAsset(zip, fileDir + href);
        if (url) { images[href] = url; im.setAttribute('href', url); im.setAttribute('xlink:href', url); }
      }
      return doc.body ? doc.body.innerHTML : doc.documentElement.innerHTML;
    };

    // 先逐个 spine 文件：sanitize → 给 h1/h2/h3 补 id → 收集目录
    const sections = [];
    let hi = 0;
    const chapters = [];
    // 每个 spine 文件在合并后的 DOM 里给一个稳定锚点。合并成单文档后原 .xhtml 文件已不存在，
    // 跨文件内链（href="ch01.xhtml" / "ch01.xhtml#id"）若原样保留，点击会被浏览器导航到
    // 不存在的文件 → 表现为「内链点不动/404」（WPS 能跳是因为它按文件渲染）。这里把链接
    // 改指到目标文件 section 的锚点，再用 reader.js 的内链跳转处理（修：EPUB 内链失效）。
    const fileAnchor = {};
    const anchorFor = (p) => 'epubfile-' + String(p || '').replace(/[^0-9A-Za-z]+/g, '_');
    spineFiles.forEach(sf => { fileAnchor[sf.file] = anchorFor(sf.file); });
    const resolveRel = (dir, rel) => {
      const st = [];
      (dir + rel).split('/').forEach((seg) => {
        if (!seg || seg === '.') return;
        if (seg === '..') st.pop(); else st.push(seg);
      });
      return st.join('/');
    };
    for (const sf of spineFiles) {
      const dir = sf.file.includes('/') ? sf.file.slice(0, sf.file.lastIndexOf('/') + 1) : '';
      let body = await sanitizeBody(sf.html, dir);
      const tmp = document.createElement('div');
      tmp.innerHTML = body;
      // 跨文件内链重写：纯文件链接 → 指向该文件 section 锚点；带 #id 的 → 保留 id 跳转，
      // 同时记 data-epub-file 作为「id 找不到时回退到目标文件开头」的兜底。
      tmp.querySelectorAll('a[href]').forEach(a => {
        const h = a.getAttribute('href') || '';
        if (!h || /^(https?:|mailto:|data:|tel:|javascript:|#)/i.test(h)) return;
        const hashIdx = h.indexOf('#');
        const fp = hashIdx >= 0 ? h.slice(0, hashIdx) : h;
        const hash = hashIdx >= 0 ? h.slice(hashIdx + 1) : '';
        const target = fileAnchor[resolveRel(dir, fp)];
        if (!target) return;
        if (hash) {
          a.setAttribute('href', '#' + hash);
          a.setAttribute('data-epub-file', target);
        } else {
          a.setAttribute('href', '#' + target);
        }
      });
      tmp.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
        // 仅当标题本来没有 id 时才补 h-N，保留书籍自带锚点 id（修：EPUB 正文内链被破坏）
        let id = h.getAttribute('id');
        if (!id) { id = 'h-' + (++hi); h.setAttribute('id', id); }
        const t = (h.textContent || '').replace(/\s+/g, ' ').trim();
        const lvl = parseInt(h.tagName[1], 10) || 1;
        if (t) chapters.push({ title: t.slice(0, 40), offset: '#' + id, level: lvl });
      });
      sections.push({ file: sf.file, body: tmp.innerHTML, anchor: fileAnchor[sf.file] });
    }

    // 正文里没有 h1~h6 时，退回 EPUB 规范目录（nav.xhtml / toc.ncx）
    if (!chapters.length) {
      // 构造纯文本与 spine 文件起始偏移，喂给 _epubToc
      let plainText = '';
      const fileStartText = [];
      for (const sec of sections) {
        fileStartText.push({ file: sec.file, start: plainText.length });
        plainText += stripHTML(sec.body) + '\n';
      }
      const navToc = await Importer._epubToc(zip, names, spineFiles, fileStartText, plainText);
      if (navToc && navToc.length) {
        navToc.forEach((item, idx) => {
          // 把 toc 项映射到目标 spine 文件（按字符偏移落在哪个文件区间）
          const offset = typeof item.offset === 'number' ? item.offset : 0;
          let fileIdx = 0;
          for (let i = 0; i < fileStartText.length; i++) {
            const cur = fileStartText[i].start;
            const next = (i + 1 < fileStartText.length) ? fileStartText[i + 1].start : plainText.length;
            if (offset >= cur && offset < next) { fileIdx = i; break; }
          }
          const anchorId = 'nav-' + (idx + 1);
          // 在该文件 section 开头插入锚点，目录项指向它
          sections[fileIdx].body = '<a id="' + anchorId + '"></a>' + sections[fileIdx].body;
          chapters.push({ title: item.title, offset: '#' + anchorId, level: item.level || 1 });
        });
      }
    }

    const html = sections.map(s => '<section class="epub-section" id="' + escHtml(s.anchor || '') + '">' + s.body + '</section>\n').join('');
    if (!html.trim()) {
      throw new Error('EPUB 内没有可提取的内容（纯图片版 EPUB 暂不支持，可改用 CBZ/ZIP 导入）');
    }

    // 书名
    const dm = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf);
    const title = (dm ? stripHTML(dm[1]).trim() : '') || file.name.replace(/\.epub$/i, '');

    const book = {
      id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title,
      format: 'html',
      srcExt: 'epub',                    // 书架上显示成 EPUB 而不是「HTML」
      content: { kind: 'html', html, images },
      length: html.length,
      totalPages: 1,
      locator: 0,
      progress: 0,
      addedAt: Date.now(),
      lastReadAt: Date.now(),
      fav: false,
      chapters
    };
    Importer._titleOf(book);
    await DB.put('books', book);
    return book;
  },

  /* EPUB 规范目录：EPUB3 nav.xhtml / EPUB2 toc.ncx。返回 [{title,href,level}] 或 null */
  async _epubToc(zip, names, spineFiles, fileStart, out) {
    const findFile = (target) => {
      const low = target.toLowerCase();
      return names.find(n => n.toLowerCase() === low)
        || names.find(n => n.toLowerCase().endsWith('/' + low))
        || names.find(n => n.toLowerCase().endsWith(low));
    };
    const readText = async (p) => { if (!p) return null; const zf = zip.file(p) || zip.file(decodeURIComponent(p)); return zf ? await zf.async('string') : null; };
    const norm = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/&[a-zA-Z]+;/g, ' ').replace(/&#[0-9]+;/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const fileStartOf = (file) => { const f = fileStart.find(x => x.file === file); return f ? f.start : null; };
    const idxOfFile = (file) => fileStart.findIndex(x => x.file === file);
    const nextStart = (idx) => (idx + 1 < fileStart.length ? fileStart[idx + 1].start : out.length);
    const mapOffset = (file, t) => {
      const off = fileStartOf(file);
      if (off == null) { const i = out.toLowerCase().indexOf(norm(t)); return i >= 0 ? i : 0; }
      const i = out.toLowerCase().indexOf(norm(t), off);
      if (i >= off && i < nextStart(idxOfFile(file))) return i;
      return off;
    };

    // 1) EPUB3 nav：优先文件名 nav/toc，其次含 <nav epub:type="toc">
    let navPath = null;
    for (const n of names) { if (/x?html?$/i.test(n) && /(^|\/)(nav|toc)\.x?html?$/i.test(n.toLowerCase())) { navPath = n; break; } }
    if (!navPath) {
      for (const n of names) {
        if (!/x?html?$/i.test(n)) continue;
        const h = await readText(n);
        if (h && /<nav\b[^>]*epub:type\s*=\s*["']toc/i.test(h)) { navPath = n; break; }
      }
    }
    let tocItems = null;
    if (navPath) {
      const nav = await readText(navPath);
      if (nav) {
        const block = /<nav\b[^>]*epub:type\s*=\s*["']toc[\s\S]*?<\/nav>/i.exec(nav) || /<nav\b[\s\S]*?<\/nav>/i.exec(nav);
        if (block) tocItems = Importer._parseNavDom(block[0]);
      }
    }
    // 2) EPUB2 ncx
    if (!tocItems) {
      const ncxPath = findFile('toc.ncx');
      if (ncxPath) {
        const ncx = await readText(ncxPath);
        if (ncx) {
          const navMap = /<navMap\b[\s\S]*?<\/navMap>/i.exec(ncx);
          if (navMap) tocItems = Importer._parseNcxDom(navMap[0]);
        }
      }
    }
    if (!tocItems || !tocItems.length) return null;

    const base = navPath ? (navPath.includes('/') ? navPath.slice(0, navPath.lastIndexOf('/') + 1) : '') : '';
    const resolveNav = (href) => {
      let p = decodeURIComponent((href || '').split('#')[0]);
      if (!p) return null;
      if (p.startsWith('/')) return p.slice(1);
      return base + p;
    };
    return tocItems.map(e => {
      const file = resolveNav(e.href);
      return { title: (e.title || '').slice(0, 40), offset: mapOffset(file, e.title), level: Math.min(6, e.level || 1) };
    });
  },

  /* 各 spine 文件内 h1~h6 作目录（无规范目录时退回；R55 起不再只认前 3 级） */
  _epubHeadings(spineFiles, fileStart, out) {
    const norm = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const fileStartOf = (file) => { const f = fileStart.find(x => x.file === file); return f ? f.start : null; };
    const idxOfFile = (file) => fileStart.findIndex(x => x.file === file);
    const nextStart = (idx) => (idx + 1 < fileStart.length ? fileStart[idx + 1].start : out.length);
    const chapters = [];
    for (const sf of spineFiles) {
      const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
      let m;
      while ((m = re.exec(sf.html))) {
        const lvl = parseInt(m[1], 10);
        const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (!title) continue;
        let off = fileStartOf(sf.file);
        const idx = idxOfFile(sf.file);
        const i = out.toLowerCase().indexOf(norm(title), off);
        if (i >= off && i < nextStart(idx)) off = i;
        chapters.push({ title: title.slice(0, 40), offset: off, level: lvl });
      }
    }
    return chapters;
  },

  /* nav.xhtml → DOM 解析（浏览器环境，准确处理嵌套列表） */
  _parseNavDom(htmlStr) {
    const doc = new DOMParser().parseFromString(htmlStr, 'text/html');
    const nav = doc.querySelector('nav') || doc;
    const items = [];
    const walk = (ul, level) => {
      ul.querySelectorAll(':scope > li').forEach(li => {
        const a = li.querySelector(':scope > a');
        if (a) items.push({ title: a.textContent.trim(), href: a.getAttribute('href') || '', level });
        const sub = li.querySelector(':scope > ol, :scope > ul');
        if (sub) walk(sub, level + 1);
      });
    };
    nav.querySelectorAll(':scope > ol, :scope > ul').forEach(ul => walk(ul, 1));
    if (!items.length) walk(nav, 1);
    return items;
  },

  /* EPUB2 toc.ncx → DOM 解析 */
  _parseNcxDom(navMapStr) {
    const doc = new DOMParser().parseFromString(navMapStr, 'application/xml');
    const nm = doc.getElementsByTagName('navMap')[0];
    const items = [];
    if (!nm) return items;
    const walk = (np, level) => {
      Array.from(np.children).forEach(child => {
        if (child.tagName.toLowerCase() === 'navpoint') {
          const txt = child.getElementsByTagName('text')[0];
          const content = child.getElementsByTagName('content')[0];
          if (txt && content) items.push({ title: txt.textContent.trim(), href: content.getAttribute('src') || '', level });
          walk(child, level + 1);
        }
      });
    };
    walk(nm, 1);
    return items;
  },

  /* ---------- HTML / XHTML ---------- */
  async _html(file) {
    const raw = await file.text();
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    // 先取标题（再下面会移除 head，必须在移除前提取，否则 <title> 丢失→退回文件名）
    const _dm = doc.querySelector('title');
    const _title = (_dm ? _dm.textContent.trim() : '') || file.name.replace(/\.x?html?$/i, '');
    doc.querySelectorAll('script,style,head,meta,link').forEach(n => n.remove());
    // 给 h1~h6 加 id 锚点（目录跳转用）
    const images = {};                       // 已内联的 dataURL 不需要映射；保留字段以便统一
    let hi = 0;
    const chapters = [];
    doc.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
      // 仅当标题本来没有 id 时才补 h-N：保留书籍自带的锚点 id（否则会破坏正文里的
      // <a href="#xxx"> 内链，导致「未找到锚点」）。目录 offset 用最终生效的 id（原有或新补）。
      let id = h.getAttribute('id');
      if (!id) { id = 'h-' + (++hi); h.setAttribute('id', id); }
      const t = (h.textContent || '').replace(/\s+/g, ' ').trim();
      const lvl = parseInt(h.tagName[1], 10) || 1;
      if (t) chapters.push({ title: t.slice(0, 40), offset: '#' + id, level: lvl });
    });
    // 图片：data: 内联的保留；相对/绝对 src 保持原样（单文件 HTML 无法携带外部图，离线可能不显，属预期）
    doc.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') || '';
      if (src.startsWith('data:')) images[src] = src;
    });
    const html = doc.body ? doc.body.innerHTML : doc.documentElement.innerHTML;
    if (!html.trim()) throw new Error('HTML 内没有可提取的内容');
    const dm = doc.querySelector('title');
    const title = _title || (dm ? dm.textContent.trim() : '') || file.name.replace(/\.x?html?$/i, '');
    const book = {
      id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title,
      format: 'html',
      srcExt: (file.name.split('.').pop() || 'html').toLowerCase(),
      content: { kind: 'html', html, images },
      length: html.length,
      totalPages: 1,
      locator: 0,
      progress: 0,
      addedAt: Date.now(),
      lastReadAt: Date.now(),
      fav: false,
      chapters
    };
    Importer._titleOf(book);
    await DB.put('books', book);
    return book;
  },

  /* 旧版二进制格式（.doc/.wps/.rtf/.odt）交给后端 LibreOffice 转 HTML 再入库。
     后端无 soffice 时返回明确错误，前端提示「另存为 .docx」。 */
  async _docViaServer(file) {
    const buf = await file.arrayBuffer();
    const b64 = Importer._bufToB64(buf);
    let resp;
    try {
      resp = await fetch('/api/convert-doc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, data: b64 })
      });
    } catch (e) {
      throw new Error('转换服务不可用，请在 Word/WPS 里另存为 .docx 再导入');
    }
    let j = {};
    try { j = await resp.json(); } catch (e) { }
    if (!resp.ok || !j.ok) {
      throw new Error((j && j.msg) || '该格式需要 LibreOffice 才能转换，请在 Word/WPS 里另存为 .docx');
    }
    const isHtml = j.kind === 'html';
    const content = isHtml
      ? { kind: 'html', html: j.html || '', images: j.images || {} }
      : { kind: 'text', text: j.text || '' };
    const book = {
      id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: (j.title || '').trim() || file.name.replace(/\.[^.]+$/, ''),
      format: isHtml ? 'html' : 'txt',
      content,
      length: isHtml ? (content.html || '').length : (content.text || '').length,
      totalPages: 1,
      locator: 0,
      progress: 0,
      addedAt: Date.now(),
      lastReadAt: Date.now(),
      fav: false,
      chapters: j.chapters || []
    };
    Importer._titleOf(book);
    await DB.put('books', book);
    return book;
  },
  _bufToB64(buf) {
    let bin = '';
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  },
};

/* ---------- 示例书籍 ---------- */
async function addDemoBooks() {
  const demo1 = `第一章 山雨欲来

碎云压在雁鸣山的脊背上，风从谷底翻上来，带着松脂与湿土的气味。

沈砚把背篓往上提了提，脚步在青石阶上敲出沉闷的回响。他今年十七，跟着师父采药已经九年，却仍记不清这条山道究竟有多少级台阶。

"师父，还要走多久？"

走在前面的老人没有回头，只把手中竹杖往地上一顿："急什么，山不走，人自走。"

沈砚不再说话。他知道师父的脾气——话只说一遍，说完了便只剩下风声。

雨是在午后落下来的。起初只是零星几点，打在阔叶上沙沙作响，转瞬便连成了线。师徒二人躲进一处岩穴，老人从怀中摸出火折子，抖了抖，竟也点着了。

火光映着岩壁，壁上有些模糊的刻痕，像字，又像画。沈砚凑近去看，指尖刚触到石面，整座山忽然轻轻颤了一下。

第二章 石中书

那一颤极轻，轻到沈砚以为是自己的错觉。

可火苗确实歪了，师父的脸色也变了。老人站起身，把竹杖横在身前，声音低沉："退后。"

岩壁上的刻痕开始发亮。不是火光那种暖黄，而是一种近乎月色的冷白，从石纹深处一丝丝渗出来，如同冰下流动的水。字迹在光里浮现，一个接一个，缓慢而固执。

"……以血为墨，以骨为笔，书人间未竟之事……"

沈砚认得那几个字，却不懂意思。他想问，回头却发现师父已经跪了下去。

那是他第一次看见师父下跪。

"师、师父？"

老人的声音很轻，像是怕惊动了什么："沈砚，你听着。这本书叫《人间录》，记的不是史，是命。"

"命？"

"谁生，谁死，谁在什么时候该遇见什么人。"老人的手按在石壁上，指节发白，"三百年了，它一直在等人。"

沈砚忽然觉得冷。雨声在洞外哗哗地响，火苗却纹丝不动。

"等谁？"

老人转过头。那张总是淡漠的脸上，此刻竟有一丝近乎悲悯的神色。

"等一个愿意把字写下去的人。"

第三章 墨与血

后来沈砚才知道，所谓"写下去"，代价是什么。

那一夜他没有睡。岩穴外的雨一直下到天明，师父坐在火堆边，把三十年前的事一件件讲给他听：讲雁鸣山曾经有过一座书院，讲书院里的人如何在战火中散尽，讲最后一个握笔者如何用自己的血写完最后一页。

"血写完，人就没了。"老人说，"所以这本书断在这里。"

沈砚看着自己的手。十七岁的手，指腹有常年握锄磨出的薄茧，掌心有一道旧疤——是九岁那年摔下山坡留下的。

"如果我不愿意呢？"

"那它继续等。"老人往火里添了根柴，"三百年都等了，不差这一百年。"

天亮时雨停了。沈砚走出岩穴，看见山谷里升起一层薄雾，雾中隐约有飞鸟掠过。他忽然想起师父说过的一句话：山不走，人自走。

他回过头。

"师父，我想先学会认全那些字。"

老人笑了。那是沈砚记忆里，师父笑得最舒展的一次。

"好。"老人说，"那就从今天开始。"`;

  const demo2 = `卷一 · 长夜

一

永和十七年的冬天格外冷。

顾清河记得那天雪下得很大，大到整座金陵城都像是被捂在了一只白瓷碗里。他站在秦淮河边，看着河面上一层薄冰，冰下有暗流无声地走。

身后传来脚步声。很轻，但很稳。

"顾大人。"来人披着蓑衣，斗笠压得很低，"陛下召见。"

顾清河没有回头。他知道这一去意味着什么——三个月前，御史台的周大人也是这样被召去的，回来时是一口棺材。

"知道了。"

二

宫里的雪扫得很干净，青砖上没有一片白。

皇帝坐在暖阁里，手里捧着一只青花盏，盏里的茶已经凉了。

"清河，你跟朕多少年了？"

"回陛下，二十二年。"

"二十二年……"皇帝把盏放下，"那朕问你，你认为朕是个怎样的皇帝？"

顾清河跪了下去。这个问题没有答案，或者说过往的二十二年里，所有给出答案的人都死了。

"臣愚钝。"

暖阁里安静了很久。窗外有雪落下，又被风吹散。

"朕昨夜做了一个梦。"皇帝忽然说，"梦见先帝。他站在那里，一句话也不说，就那么看着朕。"

顾清河跪着，不敢抬头。

"你说，他是不是也觉得朕做得不够好？"

"先帝仁慈。"

"仁慈……"皇帝笑了一声，笑声里有些别的东西，"清河，朕要你办一件事。查一个人。"

"何人？"

皇帝没有回答，只从袖中取出一封信，放在案上。

"他。"

三

那封信顾清河看了三遍。

信封上没有落款，只有一个朱砂画的小印——那是一朵梅花，五瓣，缺了一角。

他认得这个印。二十年前，秦淮河畔有位女子，画梅必缺一角，人问其故，她只笑不答。后来那女子死了，死在一场大火里，连同她所有的画。

顾清河把信收进袖中。

"臣，领旨。"

他退出暖阁时，雪已经停了。天边露出一角微光，照在青砖上，像一层薄薄的霜。

四

查一个人，其实不难。难的是查出来了，该怎么办。

七天之后，顾清河站在了一座荒废的别院前。院门上的漆早已剥落，只剩两块残破的门当。

他推门进去。

院子里有一株梅树。树很老，老得几乎不开花了，可就在那个冬天，它开了满树。

树下的石桌旁坐着一个人。

那人抬起头。

顾清河愣在原地。

那是他自己。`;

  const books = [];
  const b1 = {
    id: 'demo1', title: '人间录（示例）', format: 'txt',
    content: { kind: 'text', text: demo1 },
    length: demo1.length, totalPages: 0, locator: 0, progress: 0,
    addedAt: Date.now() - 86400000, lastReadAt: Date.now() - 3600000,
    fav: true
  };
  b1.chapters = parseChapters(demo1);
  const b2 = {
    id: 'demo2', title: '长夜行（示例）', format: 'txt',
    content: { kind: 'text', text: demo2 },
    length: demo2.length, totalPages: 0, locator: 0, progress: 0,
    addedAt: Date.now() - 172800000, lastReadAt: Date.now() - 86400000,
    fav: false
  };
  b2.chapters = parseChapters(demo2);
  Importer._titleOf(b1);
  Importer._titleOf(b2);
  await DB.put('books', b1);
  await DB.put('books', b2);
  books.push(b1, b2);
  return books;
}
