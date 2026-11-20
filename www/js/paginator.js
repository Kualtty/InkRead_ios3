/* ============================================================
   paginator.js —— TXT 章节识别 + 精确分页
   ============================================================ */

/* ---------- 章节识别 ----------
   参考开源实现：移动端阅读 app「阅读」(gedoor, GPLv3) 的章节正则思路，以及 epub.js
   的导航/标题抽取启发——以「第X章/回/卷…」为主，辅以英文 Chapter/Book/Part、纯序号、
   序/番外等；并加「标题段不得含句末标点」的误报过滤，拦掉正文里偶然出现的"第X章"。 */
const CHAPTER_RE = [
  // 第X章/回/卷/节/部/篇/集/幕（数字支持中文与阿拉伯，允许前后括号/装饰符）
  /^\s*[（(［\[]?\s*第\s*[0-9零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾千仟]+\s*[章节回卷节部篇集幕]\s*[）)］\]]?\s*(.*)$/,
  // 卷/部/篇 直接开头（无"第"字）
  /^\s*[（(［\[]?\s*[卷部篇]\s*[0-9零一二两三四五六七八九十百千万]+\s*[）)］\]]?\s*(.*)$/,
  // 英文：Chapter / Book / Part / Volume / Section / Prologue / Epilogue
  /^\s*(Chapter|Book|Part|Volume|Section|Prologue|Epilogue|序章|终章)\s+([0-9IVXLCDMivxlcdm]+)\s*[:.)]?\s*(.*)$/i,
  // 纯序号：1. 标题 / 1、标题 / 1．标题（阿拉伯或中文数字）
  /^\s*[0-9]{1,4}[.、．]\s*\S{1,30}$/,
  /^\s*[一二三四五六七八九十百千零]+[.、．]?\s*\S{1,30}$/,
  // 序/前言/后记/番外/楔子/引子/尾声/终章/附录/内容简介 等独立标题
  /^\s*[（(［\[]?\s*(序|序言|前言|自序|后序|后记|尾声|终章|番外|外传|楔子|引子|内容简介|附录)\s*[）)］\]]?\s*(.*)$/
];

/* ---------- 无编号标题（R71） ----------
   用户 2026-10-25 反馈：「太机械了吧，如果我是楔子，序章呢？」
   「第X章」和 %x 规则都要求有编号，可中文书里这些标题天然没编号：
   楔子 / 序 / 序章 / 前言 / 引言 / 尾声 / 后记 / 番外 / 附录 / 致谢 …
   旧 CHAPTER_RE 最后一条只收了其中一部分（没有「序章」），而且「楔子：雪夜」
   这种带副标题的还会被「标题段不得含句末标点」误报过滤（冒号在禁用表里）拦掉。 */
const BARE_TOC_WORDS = [
  '写在前面', '写在后面', '内容简介', '内容提要', '完本感言', '上架感言', '作者感言',
  '作者的话', '译者的话', '编者按', '译后记', '编后记', '出版说明', '版本说明',
  '开场白', '卷首语', '结束语', '大结局', '序章', '序言', '序文', '自序', '代序',
  '原序', '后序', '序曲', '序幕', '前言', '引言', '引子', '导言', '导语', '开篇',
  '楔子', '尾声', '终章', '终曲', '结局', '后记', '结语', '尾记', '番外', '外传',
  '别传', '附录', '附记', '致谢', '序', '跋'
].sort((a, b) => b.length - a.length);   // 长的先试：别让「序」抢在「序章」前面
// ⚠️ 词表里别放「正文」：很多书的正文段落自己就写着「正文」两个字（测试语料里也有），
//    一旦入表就会被整段认成章节标题（R71 实测踩到）。标题里出现「正文」这个词本身也没意义。

/** 这一行是不是「无编号标题」（楔子 / 序章：雪夜 / 番外二 这类）。
 *  命中返回原行（勾「保留原符号」时用它当标题），否则 null。
 *  宁可漏判也不误判：副标题限 20 字、不许带句读，整行超 34 字直接不看。 */
function matchBareHeading(line) {
  const s = String(line == null ? '' : line).trim();
  if (!s || s.length > 34) return null;
  // 去掉 Markdown 前缀（## ）与行首装饰括号 / 引号
  const t = s.replace(/^[#>*_\s\u3000]+/, '').replace(/^[【\[（(「『]+/, '').trim();
  let hit = '';
  for (const w of BARE_TOC_WORDS) { if (t.slice(0, w.length) === w) { hit = w; break; } }
  if (!hit) return null;
  let rest = t.slice(hit.length);
  const afterWord = rest;
  // 词后紧跟编号也认：附录一 / 番外二 / 序章 3
  const num = /^[0-9０-９零一二三四五六七八九十百]+/.exec(rest.trim());
  let numMatched = false;
  if (num) { numMatched = true; rest = rest.trim().slice(num[0].length); }
  rest = rest.replace(/[】\]）)」』*_\s\u3000]+$/, '').trim();
  if (!rest) return s;                              // 整行就是这个标题
  // 有副标题：要么有分隔符（：: 、 · — - | /），要么原本就是空格分开的
  const sep = /^[:：、·—–\-|｜/／]+\s*/.exec(rest);
  if (sep) rest = rest.slice(sep[0].length).trim();
  else if (!numMatched && !/^[\s\u3000]/.test(afterWord)) return null;   // 「序幕」「序言集」这类词尾粘连
  if (!rest || rest.length > 20) return null;
  if (/[。！？；，、,;!?]/.test(rest)) return null;   // 副标题里带句读 → 大概率是正文
  return s;
}

/* 自定义目录规则里用的「数字」字符类（阿拉伯 + 全角数字 + 中文数字，含 廿/卅/〇 等） */
const TOC_DIGIT = '[0-9０-９零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾千仟廿卅〇]+';
// %x 占位符字符类：数字 / 中文数字 / 字母（ABC/abc），见 compileTocRule 模板模式
// R66：补上全角数字 ０-９ 与罗马数字 Ⅰ-Ⅻ / ⅰ-ⅻ——中文排版里「第１２章」「Ⅳ. 结论」都算编号
const TOC_TOKEN = '[0-9０-９A-Za-z零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾千仟廿卅〇' +
  '\u2160-\u216b\u2170-\u217b]+';

/* R87：括号 / 书名号里的内容不再剥离（R86 曾按 isTocNumberLabel 把【卷一】【第3章】剥掉，
 * 用户 2026-10-30 反馈「我觉得不用去标号」→ 括号是书里自带的写法，整段保留）。
 * 现在只为「不勾保留原符号」剥**不带括号的行首编号**（第一章 / 1. / Chapter 3）。 */

/* 去掉行首常见的目录序号符号（「第xx章」「1.」「【卷名】」「Chapter 3」等），
 * 用于用户取消「保留原符号」时。若去除后为空则回退到原行，避免标题变空。
 * ⚠️ 之前只认中文「第X章」和数字序号，英文/罗马数字标题（Chapter 3 / Part II）
 * 一点都剥不掉，用户勾掉「保留原符号」看不到任何变化 → 以为开关坏了（用户实测）。
 * ⚠️ R87：括号里的内容一律不剥（【卷一】开端 原样保留）。 */
function stripTocMarker(s) {
  const RE = [
    // Markdown 标题前缀：## 楔子 → 楔子（R86：以前不勾保留原符号时会把 ## 留在目录里）
    /^\s*#{1,6}\s+/,
    // 中文序号：第一章 / 第三卷 / 第 12 节
    /^\s*第\s*[0-9零一二两三四五六七八九十百千仟萬]+\s*[章卷节回部篇集话話]\s*/,
    // 英文序号：Chapter 3 / PART II / Book 1 / Episode 5 / Act 2 / Section 4
    /^\s*(?:chapter|chap\.?|part|volume|vol\.?|book|section|sec\.?|episode|ep\.?|act|prologue|epilogue)\s+[0-9]+(?:\.[0-9]+)?\s*[:.\-–—]?\s*/i,
    /^\s*(?:chapter|part|volume|book|section|episode|act)\s+[ivxlcdm]+(?:\s*[:.\-–—])?\s+/i,
    // 纯数字/罗马序号：1. / 12、 / 3) / IV.
    /^\s*[0-9]+\s*[\.、)]\s*/,
    /^\s*[IVXLCDM]{1,6}\s*[\.、)]\s+/,
    // 全角空格 / 破折号开头
    /^[\s\u3000]+/,
  ];
  let t = s;
  for (const re of RE) {
    const n = t.replace(re, '');
    if (n && n.trim()) t = n;
  }
  // R87：括号 / 书名号包起来的整段一律不动（用户 2026-10-30：「【卷一】开端→开端、
  //   【第3章】风起→风起，我觉得不用去标号」）。括号里的内容是书名自带的写法，
  //   剥掉后目录里就分不清哪句是卷次、哪句是标签了 → 现在只有**不带括号的行首编号**
  //   （第一章 / 1. / Chapter 3）才按「保留原符号」开关决定剥不剥。
  t = t.trim();
  return t || s.trim();
}

/* 编译单条自定义目录规则（被 parseChapters 与 reader.js 的 applyCustomToc 共用，务必同步）。
 *  mini-language（用户只写「想要匹配的字面样子」即可，无需懂正则）：
 *   - 以 re: 开头 → 原样当作正则（new RegExp(剩下部分)）。老用户写过完整正则的，加 re: 前缀即可。
 *   - 含明显正则元字符（+ * ? ( ) [ ] { } | ^ $ \，但【不含句号 .】）→ 仍当原始正则处理，
 *       兼容旧版写的「第.+回」「^\s*第\d+节」等（句号 . 不在此列，见下）。
 *   - 否则「简写模式」：
 *        x   = 数字占位符（阿拉伯 / 中文数字，如 第x章 → 第1章/第廿三回/三. ）
 *        .   = 字面句号（不再被当成正则「任意字符」）
 *        其余字符一律按字面匹配
 *  例：%x.         → 命中「1. 三. A. 」等带句号编号（%x = 编号占位符：数字 / 中文数字 / 字母）
 *      第%x章       → 第1章 / 第廿三章 / 第A卷
 *      %r          → R85：任意文字填充（1~12 字，不含句末标点）。编号位不是数字时用它：
 *                    第%r章 → 第【上】章 / 第甲章；【%r】 → 【卷一】/【楔子】
 *      x. / 第x章    → 旧式简写仍可用（x 即占位符，向后兼容已保存规则）
 *      re:^\s*第\d+节 → 原始正则（高级用户） */
function compileTocRule(src) {
  let s = (src || '').trim();
  if (!s) return null;
  if (/^re:/.test(s)) {                         // 原始正则模式
    try { return new RegExp(s.slice(3).trim()); } catch (e) { return null; }
  }
  // R70：规则里没写「第」时，行首允许有一个可选的「第」。
  //   用户实测：书里标题是「第1段 / 第【1】段」，规则写「%x段 / 【%x】段」，
  //   因为行首多了个「第」→ 一条都不命中 → 目录只剩兜底的「全文」1 章，
  //   用户看到的就是「填 第【%x】段 识别 25 章，填 【%x】段 只识别 1 章」。
  //   「第%x章」这种自己写了「第」的不加前缀，避免出现「第第1章」这类怪异正则。
  const diPref = /^第/.test(s) ? '' : '(?:第\\s*)?';
  // 把「字面片段」编成不区分空格的写法：用户写的空格 → \s*（0 个或多个空白）。
  // R66：中文排版里「第3章 / 第 3 章 / 第  3 章」是同一件事，用户按其中一种写规则、
  // 书里却是另一种，就一条都识别不出来（用户反馈「%x 有问题」多半是这个）。
  const litPart = (chunk) => chunk
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')      // 正则特殊字符一律按字面
    .replace(/[ \t\u3000]+/g, '\\s*');          // 空格 / 制表 / 全角空格 → \s*
  // 模板模式（推荐）：%x = 编号占位符（数字 / 中文数字 / 字母 / 罗马数字），
  //                   %r = 任意文字填充（R85），其余字符按字面匹配
  if (/%[xXrR]/.test(s)) {
    const chunks = s.split(/(%[xXrR])/);
    let body = '';
    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];
      if (!ch) continue;
      const mm = /^%([xXrR])$/.exec(ch);
      if (!mm) { body += litPart(ch); continue; }
      const any = (mm[1] === 'r' || mm[1] === 'R');
      // 后面还有字面内容 → 懒惰（先试最短，让紧随其后的「】」「章」去收口）；
      // 占位符在规则末尾 → 贪婪（把这一行剩下的都吃掉）。
      // 另：%r 不能跨越句末标点，也不吃超过 12 个字 —— 否则「%r段」会把整句正文当标题。
      const tail = chunks.slice(i + 1).some(x => x);
      body += '\\s*' + (any ? ('[^\\n。！？；!?;]{1,12}' + (tail ? '?' : '')) : TOC_TOKEN) + '\\s*';
    }
    // 锚定到行首（^\s*）：目录标题都独占一行，避免正文里偶提"第X章"被误当目录（修 #7 自定义目录过匹配）
    try { return new RegExp('^\\s*' + diPref + body); } catch (e) { return null; }
  }
  // 含明显正则元字符 → 仍当原始正则（向后兼容旧版正则写法；句号 . 不在此集合，确保「1.」字面可写）
  if (/[+*?()[\]{}|^$\\]/.test(s)) {
    try { return new RegExp(s); } catch (e) { return null; }
  }
  // 简写模式：先把 x 换成哨兵（避免被后面的转义处理掉）
  const SENT = '@@D@@';
  s = s.replace(/(^|[^A-Za-z0-9_])x([^A-Za-z0-9_]|$)/g,
    (m, a, b) => a + SENT + b);
  // 转义所有正则特殊字符，使 . ( ) [ ] { } ^ $ | ? * + \ 等按字面匹配（句号即字面句号）
  const parts2 = s.split(SENT).map(litPart);
  const body2 = parts2.join('\\s*' + TOC_DIGIT + '\\s*');
  // 锚定到行首（同 %x 模板）：简写模式写的也是「标题行」模式，避免正文误匹配（修 #7）
  // R70：同样允许行首可选「第」（规则本身没写「第」时）
  try { return new RegExp('^\\s*' + diPref + body2); } catch (e) { return null; }
}

/** 目录最大层级。⚠️ R55：原来各处写死 4，但 CSS 只给 lv1~lv3 写了缩进 →
 *  第 4 级往下全部退化成「无缩进 + 正常字号」，看着跟顶级一样（用户实测
 *  「只能对 3 级，再后面就不对了」）。现在层级上限统一用这个常量，
 *  CSS 用 `--d` 变量算缩进，任意深度都能正确表现。 */
const TOC_MAX_LEVEL = 6;

/** 字母编号目录行：A 标题 / A1 标题 / AA1 标题 / B1.2 标题。
 *  两种形态：①「≤6 个连写字母 + 数字」（AA1、AB2 — 必须有数字，否则
 *  "This is..." 这类英文正文行会被当章节）；②老的「单字母 + 可选数字」（A、B1）。
 *  ⚠️ R54：原来只认单字母，AA1 整条识别不到 / 或者被兜底成 1 级（加粗顶格），
 *  用户看到的就是「AA1 反而比 A1、A2、A3 更靠前、颜色更深」。 */
const ALPHA_TOC_RE = /^((?:[A-Za-z]{1,6}\d{1,4}(?:[.．]\d{1,4})*)|(?:[A-Za-z]\d{0,3}(?:[.．]\d{1,3})*))[.、)．]?\s+(\S.{0,30})$/;

/** 从标题的编号样式推断层级（0 = 看不出来）。
 *  用户诉求：「原本 A / B / B1 / C 要变成 A-B-B1-C」——即字母编号里 A、B、C 同级，
 *  「B1」（字母+数字）是 B 的子级。同理支持 1 / 1.1 / 1.1.2 多级数字、一、/（一）、
 *  第X卷-第X章-第X节。只在「已命中章节规则的行」上调用，不会去扫正文。 */
function tocNumberLevel(line) {
  const s = String(line || '').trim();
  if (!s) return 0;
  const CN = '零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾千仟廿卅〇';
  // 多级数字：1.2 / 1.2.3 / 1.2.3.4（必须带分隔，避免把 3.14 当章节）
  let m = /^(\d{1,4}(?:[.．]\d{1,4})+)[.、)．]?(?:\s|$)/.exec(s);
  if (m) return Math.min(TOC_MAX_LEVEL, m[1].split(/[.．]/).length);
  // 单级数字：1. / 12、/ 3)
  m = new RegExp('^(\\d{1,4})[.、)．](?:\\s|$|[^0-9])').exec(s);
  if (m) return 1;
  // 字母+数字：A1 / B12 / B1.2 / AA1 → 层级 = **字母个数** + **数字段数**
  //   A=1、A1=2、AA1=3（挂在 A1 下面）、B1.2=3。
  //   用户实测（R54）：目录是 A / A1 / AA1 / A2 / A3，AA1 本该是 A1 的子级，
  //   旧规则只认「单个字母 + 数字」，AA1 推不出层级 → 退回 1 级 → 加粗顶格，
  //   看着反而比 A1/A2/A3「更靠前、颜色更深」。连写字母必须一起算进去。
  m = /^([A-Za-z]{1,6})(\d{1,4}(?:[.．]\d{1,4})*)(?:[.、)．]|\s|$|[^\x00-\x7F])/.exec(s);
  if (m && m[2]) return Math.min(TOC_MAX_LEVEL, m[1].length + m[2].split(/[.．]/).length);
  // 单字母：A. / B、 / C)（后面必须还有标题内容）
  m = /^([A-Za-z])[.、)．]\s*\S/.exec(s);
  if (m) return 1;
  // 中文序号：卷/部/篇 → 1；章/回 → 1；节/幕 → 2
  if (new RegExp('^第\\s*[0-9' + CN + ']+\\s*[卷部篇]').test(s)) return 1;
  if (new RegExp('^第\\s*[0-9' + CN + ']+\\s*[章回]').test(s)) return 1;
  if (new RegExp('^第\\s*[0-9' + CN + ']+\\s*[节幕话話]').test(s)) return 2;
  // （一）/（1）→ 2 级；一、/ 二、→ 1 级
  if (new RegExp('^[（(]\\s*[0-9' + CN + ']+\\s*[）)]').test(s)) return 2;
  if (new RegExp('^[' + CN + ']+[、.．]').test(s)) return 1;
  if (s.charAt(0) === '【') return 1;
  if (/^chapter\b/i.test(s)) return 1;
  if (/^(part|volume|book)\b/i.test(s)) return 1;
  if (/^section\b/i.test(s)) return 2;
  return 0;
}

function parseChapters(text, opts) {
  opts = opts || {};
  // 自定义正则：参数 opts.custom 优先，其次 Settings.tocCustom（用户在前端「自定义格式识别」里填的）
  // 支持：① 用 || 写多条规则（如 第.+回||【.+】||^\s*第\d+节），命中任一条即识别为目录；
  //       ② 简写「x」作为数字占位符（如 第x章），自动展开成「1/12/三/十二」等数字或中文数字，无需写正则。
  const customSrc = (typeof opts.custom === 'string') ? opts.custom
    : (typeof Settings !== 'undefined' ? (Settings.tocCustom || '') : '');
  // 自定义规则走统一的 compileTocRule（re: 原始正则 / 简写模式：x=数字、. =字面句号）
  const customRes = (customSrc && customSrc.trim())
    ? customSrc.split('||').map(compileTocRule).filter(Boolean)
    : [];
  // 「保留原符号」的语义（用户 2026-10-20 明确）：
  //   = **保留原来默认（内置）规则的识别结果**，自定义格式只在它之上做补充。
  //   例：内置识别 60 章、自定义规则命中 0 章 → 目录仍是 60 章（60+0），而不是被清成 0 章。
  //   不勾 = 只用自定义格式（旧行为：自定义是唯一判据）。
  //   同时保留副语义：标题显示完整原文（含「第一章」等符号），不勾时剥掉行首序号。
  // ⚠️ 没有 Settings 时（Node 纯逻辑单测 / 早期调用）默认也按「保留」处理：
  //    之前写成 `typeof Settings !== 'undefined' && ...`，导致缺省时 keepMarker=false，
  //    与浏览器里的默认值（勾选=保留）不一致，单测里标题会被剥掉序号。
  const keepMarker = (typeof Settings === 'undefined') ? true : (Settings.tocKeepMarker !== false);
  const lines = text.split('\n');
  const chapters = [];
  // 字母编号目录（A. / B、/ B1 / C2.2）只在「整本书里确实成组出现」时才认：
  // 正文里偶尔出现 "A." 开头的句子很常见，单独一条不足以当章节（用户实测 A/B-B1/C 型目录识别不出来）。
  const alphaHits = lines.filter(l => ALPHA_TOC_RE.test(l.trim())).length;
  const allowAlpha = alphaHits >= 2;
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) { pos += raw.length + 1; continue; }
    const isMd = /^#{1,6}\s/.test(line);
    // 超长行一般不是标题；但用户自定义正则可匹配长行，且 Markdown 标题（#/##…）本身就是
    // 整行标题不应被长度过滤掉（修 #21：长 Markdown 标题曾被 >50 字符守卫误杀，导致 .md 目录空白）
    if (line.length > 50 && !customRes.length && !isMd) { pos += raw.length + 1; continue; }

    /* ---------- ① 内置规则（始终计算：勾「保留原符号」时要用它兜底） ---------- */
    let bLevel = 0, bTitle = line, bMatched = false;
    // Markdown 标题 # / ## / ###  →  lv1 / lv2 / lv3
    if (isMd) {
      const mm = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (mm) { bMatched = true; bLevel = Math.min(TOC_MAX_LEVEL, mm[1].length); bTitle = mm[2].trim(); }
    }
    // 方头/书名号/方括号标题：【xxx】 「xxx」 『xxx』 [xxx]（网文分卷名、轻小说、读书笔记标签）
    if (!bMatched) {
      let bm = /^\s*【([^】]{1,40})】\s*(.*)$/.exec(line)
        || /^\s*[「『]([^」』]{1,40})[」』]\s*(.*)$/.exec(line);
      if (!bm) {
        // R86：ASCII 方括号也认（用户书里「[必看]非物质文化遗产…」这种标签标题）。
        //   三道闸门挡误判：括号里必须含中文（挡 [1] 脚注 / [A] 索引）、
        //   后面不能紧跟 ( : （挡 Markdown 链接 [文字](url) 与引用定义 [x]: …）。
        const am = /^\s*\[([^\]\n]{1,40})\]\s*(.*)$/.exec(line);
        if (am && /[^\x00-\x7F]/.test(am[1]) && !/^[（(:：]/.test((am[2] || '').trim())) bm = am;
      }
      if (bm) {
        bMatched = true; bLevel = 1;
        const inner = bm[1], rest = (bm[2] || '').trim();
        bTitle = keepMarker ? (rest ? line.trim() : bm[0].trim()) : (rest ? rest : inner);
      }
    }
    // 无编号标题（R71）：楔子 / 序章 / 序章：雪夜 / 番外二 / 附录一 …
    // 放在方头括号之后、编号规则之前：不影响「【楔子】」原有处理，
    // 又能在「第X章」规则之前把这类没编号的标题认下来。
    if (!bMatched) {
      const bh = matchBareHeading(line);
      if (bh) { bMatched = true; bLevel = 1; bTitle = bh; }
    }
    // 字母编号：A. 甲 / B、乙 / B1 丙 / C2.2 丁（仅在成组出现时启用；层级由 tocNumberLevel 推断）
    if (!bMatched && allowAlpha) {
      const am = ALPHA_TOC_RE.exec(line);
      if (am) { bMatched = true; bLevel = tocNumberLevel(line) || 1; bTitle = line; }
    }
    // 内建 CHAPTER_RE（第X章/卷部篇/英文 Chapter/纯序号/序跋番外…）
    if (!bMatched) {
      let m = null;
      for (const re of CHAPTER_RE) { if ((m = re.exec(line))) break; }
      if (m) {
        // 误报过滤：标题段混入了句末标点（。！？；：），多半是正文夹带"第X章"
        const titlePart = (m[m.length - 1] || '').toString();
        if (!/[。！？；：…—!?;:]/.test(titlePart)) bMatched = true;
      }
    }
    if (bMatched) {
      // 层级：先按编号推断（第一章→1、第一节→2、B1→2…），推不出来再用 2 级
      const nl = tocNumberLevel(line);
      if (nl) bLevel = nl;
      else if (!bLevel) bLevel = 2;
      // R86：这里原来一律 `keepMarker ? line : strip(...)`，把上面各分支算好的 bTitle
      // （尤其是 Markdown 去掉 `##` 的结果）全盖掉了 → .md 书的目录里会显示「## 楔子」。
      // 现在只在不保留原符号时重算；Markdown 保留 `mm[2]`（已去掉 # 前缀）。
      if (!keepMarker) bTitle = stripTocMarker(line);
      else if (!isMd) bTitle = line;
    }

    /* ---------- ② 自定义规则 ---------- */
    let cLevel = 0, cTitle = '';
    for (const re of customRes) {
      const cm = re.exec(line);
      if (!cm) continue;
      cLevel = tocNumberLevel(line) || 2;
      cTitle = keepMarker ? line
        : ((cm[1] && cm[1].length <= 60) ? cm[1].trim() : stripTocMarker(line));
      break;
    }

    /* ---------- ③ 采用哪条 ---------- */
    let useLevel = 0, useTitle = '';
    if (customRes.length && !keepMarker) {
      // 不勾「保留原符号」= 自定义格式是唯一判据（旧行为）
      if (cLevel) { useLevel = cLevel; useTitle = cTitle; }
    } else if (cLevel) {
      // 勾了（或没填自定义）：自定义命中即可收；层级取编号推断的更具体值
      useLevel = cLevel; useTitle = cTitle || line;
      if (bLevel && !tocNumberLevel(line)) useLevel = bLevel;
    } else if (bLevel) {
      useLevel = bLevel; useTitle = bTitle;
    }
    if (!useLevel) { pos += raw.length + 1; continue; }

    chapters.push({ title: useTitle.slice(0, 40), offset: pos, line: i, level: useLevel });
    pos += raw.length + 1;
  }
  if (chapters.length === 0 && text && text.trim().length) {
    // 仅在确有正文、却无任何标题命中时才补一个「全文」入口；漫画/扫描版 PDF 等无文本的书不补（修 #9）
    chapters.push({ title: '全文', offset: 0, line: 0, level: 1 });
  }
  return chapters;
}

/* ---------- 分页器 ----------
   思路：隐藏测量容器，按段落累积；段落超出时对段落内字符二分。
   返回 [{start,end}]（字符偏移，end 不含）
------------------------------------------------ */
class Paginator {
  constructor() {
    this.measure = document.createElement('div');
    this.measure.className = 'page-text';
    this.measure.style.cssText =
      'position:absolute;left:-99999px;top:0;visibility:hidden;height:auto;overflow:visible;';
    this.measure.style.width = '600px';
    document.body.appendChild(this.measure);
  }

  /** 同步测量容器样式与当前阅读设置、内容宽度 */
  syncStyle(width) {
    const m = this.measure;
    m.style.fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--reader-family');
    m.style.fontSize = Settings.fontSize + 'px';
    m.style.lineHeight = Settings.lineHeight;
    m.style.letterSpacing = Settings.letterSpacing + 'px';
    m.style.fontWeight = Settings.bold ? '600' : '400';
    m.style.width = width + 'px';
  }

  /**
   * @param {string} text 全文
   * @param {number} pageHeight 可用正文高度（px）
   * @param {number} width 可用正文宽度（px）
   * @returns {Array<{start:number,end:number}>}
   */
  paginate(text, pageHeight, width) {
    this.syncStyle(width);
    const m = this.measure;
    const total = text.length;
    if (total === 0) return [{ start: 0, end: 0 }];

    // 段落切分，保留全局偏移
    const paras = [];
    let idx = 0;
    const rawParas = text.split('\n');
    for (const p of rawParas) {
      const t = p.replace(/\r$/, '');
      paras.push({ text: t, start: idx });
      idx += t.length + 1;
    }

    const paraSpace = Settings.fontSize * Settings.paraSpacing;
    const pages = [];
    let i = 0;
    let guard = 0;

    while (i < paras.length && guard++ < 200000) {
      m.innerHTML = '';
      const firstStart = paras[i].start;
      let j = i;
      let overflow = false;

      while (j < paras.length) {
        const el = document.createElement('p');
        el.textContent = paras[j].text;
        el.style.paddingBottom = paraSpace + 'px';
        if (j === i) el.style.paddingBottom = '0px';
        m.appendChild(el);
        if (m.scrollHeight > pageHeight && m.children.length > 1) {
          m.removeChild(el);
          overflow = true;
          break;
        }
        j++;
      }

      if (!overflow) {
        // 剩余全部放得下
        pages.push({ start: firstStart, end: total });
        break;
      }

      if (j === i) {
        // 单个段落就超出一页 → 段内二分
        const seg = paras[i];
        const el = document.createElement('p');
        el.style.paddingBottom = '0px';
        m.innerHTML = '';
        m.appendChild(el);
        let lo = 1, hi = seg.text.length, best = 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          el.textContent = seg.text.slice(0, mid);
          if (m.scrollHeight <= pageHeight) { best = mid; lo = mid + 1; }
          else { hi = mid - 1; }
        }
        // 避免死循环
        if (best < 1) best = 1;
        pages.push({ start: seg.start, end: seg.start + best });
        paras[i] = { text: seg.text.slice(best), start: seg.start + best };
        if (paras[i].text.length === 0) i++;
        continue;
      }

      // 第 i..j-1 段构成一页
      pages.push({ start: firstStart, end: paras[j].start });
      i = j;
    }

    if (pages.length === 0) pages.push({ start: 0, end: total });
    return pages;
  }
}
