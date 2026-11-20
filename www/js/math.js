/* ===========================================================
   数学公式渲染（KaTeX，本地离线）
   -----------------------------------------------------------
   支持三种写法：
     $$ 行间公式 $$      \[ 行间公式 \]
     $ 行内公式 $        \( 行内公式 \)
   KaTeX 全部文件放在 vendor/katex/（只留 woff2 字体，约 600KB），
   iPad 断网也能渲染，不依赖任何 CDN。

   设计取舍：
   - 只处理「看起来像公式」的 $...$，往货币符号误判。判定标准是内容里含
     \ ^ _ { } = 或形如 `a+b` 的算式；纯数字/单词一律不碰。
   - 渲染失败（语法错）就把原文原样留着，绝不吞掉用户文字。
   =========================================================== */
const InkMath = (() => {
  const hasLib = () => typeof katex !== 'undefined';

  function opts(display) {
    return {
      displayMode: !!display,
      throwOnError: false,
      strict: false,
      trust: false,
      output: 'html'
    };
  }

  /** 这段文字像不像公式（避免把价格 $5、$100 之类渲染成公式） */
  function looksMath(s) {
    const t = String(s || '').trim();
    if (!t) return false;
    if (t.length > 1200) return false;
    if (/[\\^_{}]/.test(t)) return true;                       // 命令、上下标、分组
    if (/=/.test(t) && /[a-zA-Z0-9]/.test(t)) return true;      // 等式
    if (/[a-zA-Z0-9]\s*[+\-*/×÷]\s*[a-zA-Z0-9]/.test(t)) return true;  // 算式
    return false;
  }

  /** 公式里混了中文（笔记里很常见，例如 $$计算X^TX,X^Ty$$得到θ）：
   *  KaTeX 数学模式不认汉字，会整段刷成红色报错。把连续汉字包进 \text{}，
   *  就变成「汉字照排、符号照算」，正是用户想表达的意思。 */
  function wrapCJK(tex) {
    if (!/[\u3400-\u9fff]/.test(tex)) return tex;
    if (/\\text\{/.test(tex)) return tex;                    // 自己已经包过就不动
    return tex.replace(/[\u3400-\u9fff\u3000-\u303f]+/g, (m) => '\\text{' + m + '}');
  }

  /** 修一个单元格里不配对的 { }（拆列之后必然出现，例如 `{1` / `x_{12} \dots }`）。 */
  function balanceBraces(s) {
    let depth = 0, out = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\') { out += ch + (s[i + 1] || ''); i++; continue; }   // 跳过 \{ \}
      if (ch === '{') depth++;
      else if (ch === '}') { if (depth === 0) continue; depth--; }
      out += ch;
    }
    return out + '}'.repeat(Math.max(0, depth));
  }

  /** 矩阵「按空格摆的」→ 按列对齐。
   *  很多人（含用户那份建模笔记）在 \begin{matrix} 里不写 &，而是用一串 \space 把列推开：
   *      {1\space\space x_{11}\space\space x_{12}\dots}{x_{1n}}
   *  这样 KaTeX 只会把整行当一个单元格，六行各自居中 —— 看着像一坨，不像矩阵。
   *  这里把「连续多个 \space」当作列分隔，转成 & 分列，KaTeX 就会自动对齐列宽。
   *  只在「每行拆出来的列数完全一致（≥2）」时才转，别的情况下原样返回，绝不改坏用户公式。 */
  function alignMatrix(tex) {
    if (tex.indexOf('matrix') < 0 || tex.indexOf('\\space') < 0) return tex;
    // 纯省略号行（`…` / `\cdots` / `\vdots`）：矩阵中间的「以下同理」行，
    // 拆列时它只有一个格子，按列数补齐成 `\cdots & \cdots`，否则整段会被判成「列数不齐」而不动。
    const isEll = (c) => c.length === 1
      && /^(…|\.{3}|\\dots|\\ldots|\\cdots|\\vdots|\\ddots)$/.test(String(c[0]).trim());
    return tex.replace(/\\begin\{([pbvBV]?matrix)\}([\s\S]*?)\\end\{\1\}/g, (m, env, body) => {
      if (body.indexOf('&') >= 0) return m;                        // 已经自己分好列了
      const rows = body.split(/\\\\/).map(r => r.trim()).filter(r => r !== '');
      if (rows.length < 2) return m;
      const cells = rows.map(r => r
        .split(/\s*\\space(?:\s*\\space)*\s*/)
        .map(x => balanceBraces(x.trim()))
        .filter(x => x !== ''));
      const cols = Math.max.apply(null, cells.map(c => c.length));
      if (cols < 2) return m;
      // 列数不齐：只有「省略号行」允许补齐，其它情况宁可不动（别把用户公式改坏）
      if (cells.some(c => c.length !== cols && !isEll(c))) return m;
      const out = cells.map(c => {
        if (c.length === cols) return c.join(' & ');
        if (isEll(c)) return new Array(cols).fill('\\cdots').join(' & ');
        return c.concat(new Array(cols - c.length).fill('')).join(' & ');
      }).join(' \\\\ ');
      return '\\begin{' + env + '}' + out + '\\end{' + env + '}';
    });
  }

  /** 裸 `\begin{matrix}` 是**没有边框**的：KaTeX 只画格子，不画括号，
   *  一片数字左对齐堆在等号右边，完全不像课本里的矩阵。
   *  这里自动补成圆括号（`pmatrix`），也就是教材里最常见的矩阵写法。
   *  已经被包住的（`\left(` / `\left[` / `\left\{` …）和本来就写了
   *  `pmatrix` / `bmatrix` 的一律不动，否则会变成双层括号。 */
  const MAT_BARE_RE = /\\begin\{matrix\}([\s\S]*?)\\end\{matrix\}/g;
  function addMatrixDelims(tex) {
    if (tex.indexOf('\\begin{matrix}') < 0) return tex;
    return tex.replace(MAT_BARE_RE, (m, body, offset, whole) => {
      // 往回看紧邻的字符，判断外面是不是已经有 \left( / \Big[ 之类的伸缩括号
      const before = whole.slice(Math.max(0, offset - 24), offset);
      if (/\\(?:left|[bB]igg?)\s*(\(|\[|\\\{|\\\||\.|\|)\s*$/.test(before)) return m;
      return '\\begin{pmatrix}' + body + '\\end{pmatrix}';
    });
  }

  function renderOne(host) {
    const tex = host.getAttribute('data-tex') || host.textContent || '';
    const display = host.getAttribute('data-display') === '1'
      || host.classList.contains('math-display');
    // 记下「这段公式在源码里占多少字符」（$xx$ = 2 个标记 + 内容）。
    // 正文的 data-off（标注/书签/进度都靠它）按源码长度累计，
    // 而 KaTeX 排版后的可见文字短得多，不算这个的话后面的段落会全体前移。
    if (!host.dataset.srclen) host.dataset.srclen = String(tex.length + (display ? 4 : 2));
    try {
      host.innerHTML = katex.renderToString(wrapCJK(addMatrixDelims(alignMatrix(tex))), opts(display));
      host.classList.add('katex-done');
      if (display) host.classList.add('math-display');
    } catch (e) {
      host.textContent = tex;                                  // 渲染不了就保留原文
    }
    host.removeAttribute('data-tex');
  }

  /* 文本节点里的 $...$ / $$...$$ / \(...\) / \[...\] */
  const SCAN_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$([^$\n]+?)\$/g;

  function splitTextNode(node, out) {
    const s = node.nodeValue || '';
    if (!s || !/[$]|\\[\(\[]/.test(s)) return false;
    SCAN_RE.lastIndex = 0;
    let m, last = 0, changed = false;
    while ((m = SCAN_RE.exec(s))) {
      const display = m[1] != null || m[2] != null;
      const tex = m[1] != null ? m[1] : (m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]));
      if (!display && !looksMath(tex)) continue;               // $5.99 之类不碰
      if (m.index > last) out.push(document.createTextNode(s.slice(last, m.index)));
      const span = document.createElement('span');
      span.className = 'ink-math';
      span.setAttribute('data-tex', tex);
      span.setAttribute('data-srclen', String(tex.length + (display ? 4 : 2)));
      if (display) span.setAttribute('data-display', '1');
      out.push(span);
      last = m.index + m[0].length;
      changed = true;
    }
    if (!changed) return false;
    if (last < s.length) out.push(document.createTextNode(s.slice(last)));
    return true;
  }

  const SKIP = /^(SCRIPT|STYLE|TEXTAREA|CODE|PRE|svg)$/;
  const SKIP_CLASS = /(\bkatex\b|\bink-math\b|\bmd-code\b|\bmd-pre\b)/;

  /** 渲染 root 内所有公式。可反复调用（已渲染的会跳过）。 */
  function renderIn(root) {
    if (!root || !hasLib()) return 0;
    let n = 0;

    // 1) Markdown 阶段就标好的占位（已被保护，不会被 Markdown 语法吃掉）
    root.querySelectorAll('.ink-math[data-tex]').forEach((el) => {
      renderOne(el); n++;
    });

    // 2) 普通文本里的 $...$ / \(...\)
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const todo = [];
    let node;
    while ((node = walker.nextNode())) {
      const p = node.parentElement;
      if (!p) continue;
      if (SKIP.test(p.tagName)) continue;
      if (SKIP_CLASS.test(p.className || '')) continue;
      if (p.closest && p.closest('.katex')) continue;
      if (node.nodeValue.indexOf('$') < 0 && node.nodeValue.indexOf('\\(') < 0
        && node.nodeValue.indexOf('\\[') < 0) continue;
      todo.push(node);
    }
    todo.forEach((t) => {
      const frag = [];
      if (!splitTextNode(t, frag)) return;
      const host = document.createDocumentFragment();
      frag.forEach((x) => host.appendChild(x));
      t.parentNode.replaceChild(host, t);
      n++;
    });
    // 新建出来的占位再渲染一遍
    root.querySelectorAll('.ink-math[data-tex]').forEach((el) => renderOne(el));
    return n;
  }

  return { renderIn: renderIn, looksMath: looksMath, _alignMatrix: alignMatrix, _matrixDelims: addMatrixDelims };
})();

if (typeof window !== 'undefined') window.InkMath = InkMath;
