/*
 * 墨阅 InkReader · 本机离线翻译（Marian / OPUS-MT + onnxruntime）—— R171
 * ---------------------------------------------------------------------
 * 为什么要有它：手机上翻译以前只有两条路 —— 在线接口（要 Key、要联网）
 * 或者「连电脑」（电脑得开着）。用户的原话：「有时候电脑不打开，翻译不了」。
 * 这个模块让手机**自己**翻：模型和推理都在手机里，飞行模式也能用。
 *
 * 用的是 OPUS-MT（Helsinki-NLP 的 Marian 小模型，~77M 参数）：
 *   · 体积：一个方向（中→英 或 英→中）encoder 52 MB + decoder 58 MB，
 *     8bit 量化版，合计约 110 MB —— 放不进 APK，第一次用要下载。
 *   · 质量：新闻/议会语料训的，**比在线大模型差一截**，但比「翻不了」强。
 *     所以界面上它排前面、但说明里写清它是什么水平，别让人以为跟 DeepL 一样。
 *
 * ⚠️ 关键实现细节（都是踩过的）：
 *   1. 分词不能用 split(' ')。OPUS-MT 用 SentencePiece 的 Unigram 模型，
 *      中文没有空格，整句是一个「词」，必须自己做 Viterbi 切分（见 tokenize）。
 *   2. 解码不能用 beam search：手机 WASM 上 6 束 = 6 倍耗时却只换来一点点质量，
 *      这里用贪心。质量靠「短句 + 上下文喂上一句译文」补。
 *   3. pad_token_id = 65000 必须从候选里排除，否则模型会吐一堆 <pad>。
 *   4. 输出张量名不要写死：不同导出工具留的名字不一样，按形状找 3 维那个。
 */
const MtLocal = (() => {
  'use strict';

  const EOS = 0;                   // 兜底：词表里找不到 </s> 时才用
  /* ⚠️ 别把 <pad> 写死成 65000。R173 加日/韩/俄时才发现各家词表不一样：
        zh-en / ko-en 是 65000，ja-en 是 60715，ru-en 是 62517。
        写死的后果不是报错，是模型一上来就吐一串 <pad>、译文全是空的。
        现在统一进模型时从 tokenizer.json 里查（见 buildTok）。
     <pad> 同时是 encoder 的 padding id 和 decoder 的起始 token（Marian joiner 的老规矩）。 */
  const MAX_NEW = 160;             // 单个分块最多吐这么多 token（约 100 个英文词）
  const MAX_IN = 400;              // 输入上限（模型 max_position_embeddings=512，留点余量）
  /* 贪心解码的两个保险。实测（中→英、量化模型）不加这两个的话，
     一句话会变成「This is the text that you use for the import test.」无限循环：
       · no_repeat_ngram_size：已经出现过的 3-gram 不许再出现（HF 生成默认也是 3）
       · repetition_penalty：出现过的 token 稍微压一点分（CTRL 那套），治「同一个词反复吐」 */
  const NO_REPEAT_NGRAM = 3;
  const REP_PENALTY = 1.15;

  // 装在哪：{pair: 'zh-en', base: 'http://…/mtmodels/zh-en/'}
  const state = { pair: '', base: '', bases: {}, ready: false, err: '' };
  const cache = {};                // 模型方向 → {enc, dec, tok, meta}

  /* R173：方向 → 依次跑哪几套模型（必须和服务端 MT_ROUTES 一致：
     那边决定「下载时装哪几套」，这边决定「翻译时串哪几套」）。
     OPUS-MT 没有日→中这种直达模型，所以日/韩/俄→中都是「先译成英文再译中文」，
     两跳的代价：慢约一倍，而且英文那一步的错会带进中文。 */
  const PLANS = {
    'zh-en': ['zh-en'],
    'en-zh': ['en-zh'],
    'ja-en': ['ja-en'],
    'ko-en': ['ko-en'],
    'ru-en': ['ru-en'],
    'ja-zh': ['ja-en', 'en-zh'],
    'ko-zh': ['ko-en', 'en-zh'],
    'ru-zh': ['ru-en', 'en-zh']
  };

  /** 这套模型该从哪读文件。base 里带的是「当前方向」，两跳时换成要用的模型名
      （目录式和接口式都只是字符串替换，见 abs()）。 */
  function baseFor(model) {
    if (state.bases[model]) return state.bases[model];
    let b = String(state.base || '');
    if (state.pair && model && model !== state.pair) b = b.split(state.pair).join(model);
    return b;
  }

  /* ---------------- 读取模型 ---------------- */

  function abs(base, name) {
    /* 两种 base 都要吃：
       · 目录式  '…/mtmodels/zh-en/'      → 拼成 '…/zh-en/encoder.onnx'
       · 接口式  '/api/mt-local/file?pair=zh-en&name=' → 直接接文件名，**不能再补斜杠**
         （补了就变成 name=/tokenizer.json，服务端白名单判不过，报 400 —— 踩过） */
    const b = String(base);
    return b.indexOf('?') >= 0 ? b + name : b.replace(/\/+$/, '') + '/' + name;
  }

  async function fetchJson(url) {
    const r = await fetch(url, { cache: 'force-cache' });
    if (!r.ok) throw new Error('读取 ' + url + ' 失败（HTTP ' + r.status + '）');
    return r.json();
  }

  async function fetchBytes(url) {
    const r = await fetch(url, { cache: 'force-cache' });
    if (!r.ok) throw new Error('读取模型 ' + url + ' 失败（HTTP ' + r.status + '）');
    return new Uint8Array(await r.arrayBuffer());
  }

  /** 建 Unigram 分词器：vocab 是 [[piece, logProb], …]，用 Map 查。 */
  function buildTok(json) {
    const v = (json.model && json.model.vocab) || [];
    const map = new Map();
    let maxLen = 1;
    let minScore = 0;
    let padId = -1, eosId = -1;
    for (let i = 0; i < v.length; i++) {
      const piece = v[i][0], score = v[i][1];
      map.set(piece, [i, score]);
      if (piece === '<pad>') padId = i;
      else if (piece === '</s>') eosId = i;
      if (piece.length > maxLen) maxLen = piece.length;
      if (score < minScore) minScore = score;
    }
    return {
      map,
      /* R173：<pad> 的位置每个模型都不一样（见文件头注释），必须查不能写死。
         查不到时退回「词表最后一个」—— Marian 的 pad 一直在末尾。 */
      padId: padId >= 0 ? padId : Math.max(0, v.length - 1),
      eosId: eosId >= 0 ? eosId : EOS,
      maxLen: Math.min(maxLen, 16),
      unkId: (json.model && json.model.unk_id != null) ? Number(json.model.unk_id) : 2,
      unkScore: minScore - 10
    };
  }

  /** SentencePiece 的 Metaspace：' ' → '▁'，并在开头补一个。
   *  R173：先过一遍 NFKC —— 上游 tokenizer 的 normalizer 是 Precompiled charsmap
   *  （tokenizer.json 里是 null，拿不到原表），拿 NFKC 近似。日文的全角英数、
   *  韩文的兼容字母都靠这一步归一，不然会碎成 <unk>。 */
  function metaspace(text) {
    let s = String(text);
    try { s = s.normalize('NFKC'); } catch (e) { }
    return '▁' + s.replace(/[ \t\n\r]+/g, '▁');
  }

  /** Unigram Viterbi。返回 token id 数组（不含 </s>，调用方自己补）。 */
  function tokenize(tok, text) {
    const s = metaspace(text);
    const chars = Array.from(s);
    const n = chars.length;
    const best = new Float64Array(n + 1).fill(-Infinity);
    const from = new Int32Array(n + 1).fill(-1);
    const tid = new Int32Array(n + 1).fill(-1);
    best[0] = 0;
    for (let i = 0; i < n; i++) {
      if (best[i] === -Infinity) continue;
      // 先放一个「未登录字」兜底，保证任何位置都走得到
      if (best[i] + tok.unkScore > best[i + 1]) {
        best[i + 1] = best[i] + tok.unkScore;
        from[i + 1] = i;
        tid[i + 1] = tok.unkId;
      }
      let piece = '';
      const lim = Math.min(tok.maxLen, n - i);
      for (let L = 1; L <= lim; L++) {
        piece += chars[i + L - 1];
        const hit = tok.map.get(piece);
        if (!hit) continue;
        const sc = best[i] + hit[1];
        if (sc > best[i + L]) { best[i + L] = sc; from[i + L] = i; tid[i + L] = hit[0]; }
      }
    }
    const ids = [];
    let p = n;
    while (p > 0 && from[p] >= 0) { ids.push(tid[p]); p = from[p]; }
    ids.reverse();
    return ids;
  }

  function decodeIds(tok, id2piece, ids) {
    let out = '';
    for (const id of ids) {
      if (id === tok.eosId) break;
      const p = id2piece[id];
      if (p == null) continue;
      out += p;
    }
    return out.replace(/▁/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /* ---------------- 会话 ---------------- */

  async function ensure(model) {
    if (cache[model]) return cache[model];
    const base = baseFor(model);
    if (!base) throw new Error('本机离线翻译还没设置模型目录');
    const ort = await OcrPaddle.ensureOrt();       // 和 OCR 共用同一个 wasm 运行时
    const meta = await fetchJson(abs(base, 'meta.json')).catch(() => ({}));
    const tokJson = await fetchJson(abs(base, 'tokenizer.json'));
    const tok = buildTok(tokJson);
    // piece 反查表（解码用）
    const id2piece = new Array(tok.map.size + 1);
    tok.map.forEach((v, k) => { id2piece[v[0]] = k; });

    const encBytes = await fetchBytes(abs(base, 'encoder.onnx'));
    const decBytes = await fetchBytes(abs(base, 'decoder.onnx'));
    const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const enc = await ort.InferenceSession.create(encBytes, opt);
    const dec = await ort.InferenceSession.create(decBytes, opt);
    cache[model] = { enc, dec, tok, id2piece, meta };
    return cache[model];
  }

  /** 按名字找输入口：不同导出留下的小写/大写不一致，别硬编码。 */
  function pick(names, want) {
    for (const n of names) if (n.toLowerCase().indexOf(want) >= 0) return n;
    return names[0];
  }

  /* ---------------- 翻译 ---------------- */

  async function translatePair(model, text) {
    const M = await ensure(model);
    const ort = await OcrPaddle.ensureOrt();
    const src = String(text || '').trim();
    if (!src) return '';
    const ids = tokenize(M.tok, src.slice(0, MAX_IN));
    if (!ids.length) return '';
    if (ids.length > 500) ids.length = 500;
    /* ⚠️ 源句结尾必须补 </s>（id 0）。这是 tokenizer.json 里 post_processor
       TemplateProcessing 干的事，手写分词时最容易被漏掉 ——
       漏了的表现不是报错，而是模型把句子当「没写完」继续往下接，
       于是译文变成「I never thought I ever thought that...」这种绕圈。
       （实测：补上这一颗 token，绕圈基本消失。） */
    ids.push(M.tok.eosId);

    const S = ids.length;
    const feed = {};
    feed[pick(M.enc.inputNames, 'input_ids')] = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, S]);
    feed[pick(M.enc.inputNames, 'attention_mask')] = new ort.Tensor('int64', BigInt64Array.from(new Array(S).fill(1n)), [1, S]);
    const eo = await M.enc.run(feed);
    const hidden = eo[M.enc.outputNames[0]];          // [1, S, 512]

    const decIds = [M.tok.padId];
    const decInIds = pick(M.dec.inputNames, 'input_ids');
    const decInEnc = pick(M.dec.inputNames, 'encoder_hidden_states');
    const decInMask = M.dec.inputNames.find(n => /encoder_attention_mask/i.test(n));
    const out = [];
    const seen = new Set();                        // 已生成过的 token（重复惩罚用）
    const ngram = new Map();                       // "a,b" → Set(c)：这个前缀后面跟过哪些
    /* 长度上限按输入长度算，别用固定 160：贪心模型「收不住」时，
       一句 14 字的中文能吐出三段英文（实测 9.9 秒还没停）。
       英文译文的 token 数大约是中文的 1.5~2 倍，3 倍已经足够宽松。 */
    const maxNew = Math.min(MAX_NEW, Math.max(12, ids.length * 3 + 8));
    let prev = -1, same = 0;
    for (let step = 0; step < maxNew; step++) {
      const T = decIds.length;
      const f2 = {};
      f2[decInIds] = new ort.Tensor('int64', BigInt64Array.from(decIds.map(BigInt)), [1, T]);
      f2[decInEnc] = hidden;
      if (decInMask) f2[decInMask] = feed[pick(M.enc.inputNames, 'attention_mask')];
      const ro = await M.dec.run(f2);
      // 取最后一个 3 维输出（logits [1,T,V]）
      let logits = null, V = 0;
      M.dec.outputNames.forEach(n => {
        const t = ro[n];
        if (t && t.dims && t.dims.length === 3) { logits = t.data; V = t.dims[2]; }
      });
      if (!logits) break;
      const off = (T - 1) * V;
      // 这两条前缀 = 本轮禁止出现的 token
      const banned = (out.length >= NO_REPEAT_NGRAM - 1)
        ? ngram.get(out.slice(out.length - (NO_REPEAT_NGRAM - 1)).join(','))
        : null;
      let best = -Infinity, bi = 0;
      for (let c = 0; c < V; c++) {
        if (c === M.tok.padId) continue;
        if (banned && banned.has(c)) continue;
        let v = logits[off + c];
        if (seen.has(c)) v = v > 0 ? v / REP_PENALTY : v * REP_PENALTY;
        if (v > best) { best = v; bi = c; }
      }
      if (bi === M.tok.eosId || best === -Infinity) break;
      // 记 3-gram
      if (out.length >= NO_REPEAT_NGRAM - 1) {
        const key = out.slice(out.length - (NO_REPEAT_NGRAM - 1)).join(',');
        let s = ngram.get(key);
        if (!s) { s = new Set(); ngram.set(key, s); }
        s.add(bi);
      }
      out.push(bi);
      seen.add(bi);
      // 同一 token 连出 4 次基本就是卡住了（贪心的典型病），直接停
      same = (bi === prev) ? same + 1 : 0;
      prev = bi;
      if (same >= 4) break;
      decIds.push(bi);
    }
    return decodeIds(M.tok, M.id2piece, out);
  }

  /** 语言码归一：只认本机模型真做过的几种（中/英/日/韩/俄）。
   *  R172：以前是「取前两个字母」—— `auto` 就变成 `au`，`MtLocal.pairOf('auto','ZH')`
   *  于是拼出 `au-zh`，服务端没这个方向 → 400 / 面板「问不到状态」。
   *  现在不认识的（auto、th、fr…）一律回空串，交给调用方按正文猜或给出明确说法。 */
  function langOf(x) {
    const s = String(x || '').toLowerCase().trim();
    if (!s || s === 'auto') return '';
    if (s.indexOf('zh') === 0) return 'zh';
    if (s.indexOf('en') === 0) return 'en';
    if (s.indexOf('ja') === 0) return 'ja';
    if (s.indexOf('ko') === 0) return 'ko';
    if (s.indexOf('ru') === 0) return 'ru';
    return '';
  }
  /** 语言码 → 方向名。只返回**真能翻**的方向（PLANS 里有才算）。 */
  function pairOf(src, tgt) {
    const A = langOf(src), B = langOf(tgt);
    if (!A || !B || A === B) return '';
    const k = A + '-' + B;
    return PLANS[k] ? k : '';
  }

  return {
    state,
    PLANS,
    pairOf,
    langOf,
    /** 设置模型目录（形如 http://127.0.0.1:8123/api/mt-local/file?pair=zh-en&name=） */
    configure(base, pair) {
      state.base = base;
      state.pair = pair || state.pair;
      state.bases = {};            // 换了目录就别再读旧的映射
    },
    async warmed(pair) {
      try {
        const plan = PLANS[pair] || [pair];
        for (const m of plan) await ensure(m);
        state.ready = true; state.err = ''; return true;
      }
      catch (e) { state.ready = false; state.err = String((e && e.message) || e); return false; }
    },
    /** 删掉磁盘上的模型之后，把内存里的会话一并丢掉。
        不丢的话「删了还能翻」—— 文件没了，可当前这一页还跑着旧会话，
        用户会以为删除没生效，直到刷新页面才「突然不能用」。 */
    forget(route) {
      const plan = PLANS[route] || [route];
      plan.forEach((m) => { delete cache[m]; });
      if (!route || route === state.pair || PLANS[route]) state.ready = false;
    },
    async translate(text, opts) {
      const pair = (opts && opts.pair) || state.pair;
      if (!pair) throw new Error('本机离线翻译：不知道要翻哪个方向');
      const plan = PLANS[pair] || [pair];
      let cur = String(text == null ? '' : text);
      for (let i = 0; i < plan.length; i++) {
        cur = await translatePair(plan[i], cur);
        if (!cur) break;
      }
      return cur;
    },
    _tokenize: tokenize,        // 给单测用
    _buildTok: buildTok
  };
})();

if (typeof window !== 'undefined') window.MtLocal = MtLocal;
