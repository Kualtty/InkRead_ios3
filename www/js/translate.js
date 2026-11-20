/*
 * 墨阅 InkReader · 全文翻译 + 轻量插件框架
 * ------------------------------------------------------------
 * 设计目标：
 *   1. 全文翻译：把一本书的正文（R.text）逐段翻译，支持
 *        - 自定义术语表（原词 → 译词，长词优先）
 *        - 自定义「不翻译名单」（这些词原样保留）
 *        - 可选翻译引擎（本地离线 / DeepL / OpenAI / 自定义插件）
 *   2. 可插拔：翻译引擎本身就是一个「provider 插件」，任何人写个 JS
 *      调 registerProvider() 就能挂进来的新翻译源；此外还有「阅读器功能插件」
 *      （registerFeature），做导出 / 复制译文等扩展。
 *
 * 本文件对 DOM 的依赖都在 initTranslateUI() 里，纯逻辑（applyLocal / 控制器）
 * 不碰 DOM，可以直接被 node 单测 require。
 */
(function (global) {
  'use strict';

  // =====================================================================
  // 1. 插件注册表 InkPlugins
  //    三类扩展点：
  //      - provider：翻译源（必须有 translate(text, ctx)）
  //      - feature ：阅读器功能插件（必须有 run(ctx)）
  //      - hooks   ：事件（on / emit），供后续扩展
  // =====================================================================
  const InkPlugins = {
    _providers: {},
    _features: {},
    _hooks: {},

    registerProvider(p) {
      if (!p || !p.id || typeof p.translate !== 'function') {
        console.warn('[InkPlugins] 跳过无效 provider（需要 id 和 translate 函数）', p);
        return;
      }
      this._providers[p.id] = p;
      this.emit('provider:registered', p);
    },

    registerFeature(f) {
      if (!f || !f.id || typeof f.run !== 'function') {
        console.warn('[InkPlugins] 跳过无效 feature（需要 id 和 run 函数）', f);
        return;
      }
      this._features[f.id] = f;
      this.emit('feature:registered', f);
    },

    getProvider(id) { return this._providers[id]; },
    listProviders() { return Object.values(this._providers); },
    listFeatures() { return Object.values(this._features); },

    on(event, fn) { (this._hooks[event] = this._hooks[event] || []).push(fn); },
    emit(event, payload) {
      (this._hooks[event] || []).forEach((fn) => {
        try { fn(payload); } catch (e) { console.warn('[InkPlugins] hook 出错', event, e); }
      });
    }
  };

  // =====================================================================
  // 2. 内置翻译 provider
  // =====================================================================

  // 一个极小的离线 EN→ZH 词典，只覆盖最常见的词，用来让「本地词典」模式
  // 在没有联网时也能翻译出可读的句子。未收录的词用「」包住，提示「没译出来」。
  const MINI_ENZH = {
    a: '一个', an: '一个', the: '这', and: '并且', or: '或者', but: '但是',
    of: '的', to: '去', in: '在', on: '在', at: '在', for: '为了', with: '和',
    without: '没有', is: '是', are: '是', was: '曾是', were: '曾是', be: '是',
    been: '已经', being: '正', am: '是',
    have: '有', has: '有', had: '有过', having: '拥有',
    do: '做', does: '做', did: '做了', done: '完成',
    this: '这', that: '那', these: '这些', those: '那些',
    he: '他', she: '她', it: '它', they: '他们', we: '我们', you: '你', i: '我',
    my: '我的', your: '你的', his: '他的', her: '她的', their: '他们的', our: '我们的',
    not: '不', no: '否', yes: '是',
    hello: '你好', hi: '嗨', world: '世界', book: '书', read: '读', reading: '阅读',
    page: '页', chapter: '章', go: '去', went: '去了', gone: '走了', come: '来',
    came: '来了', see: '看见', saw: '看见了', look: '看', find: '找到', found: '找到了',
    love: '爱', like: '喜欢', hate: '讨厌', know: '知道', knew: '知道', think: '想',
    thought: '想过', say: '说', said: '说', make: '做', made: '做了', take: '拿',
    took: '拿了', get: '得到', got: '得到了', give: '给', gave: '给了',
    man: '男人', woman: '女人', people: '人们', time: '时间', day: '天', year: '年',
    house: '房子', home: '家', water: '水', food: '食物', hand: '手', eye: '眼睛',
    heart: '心', mind: '心智', life: '生命', death: '死亡',
    good: '好', bad: '坏', big: '大', small: '小', little: '小', new: '新', old: '旧',
    long: '长', short: '短', first: '第一', last: '最后',
    one: '一', two: '二', three: '三', many: '许多', much: '很多', more: '更多',
    most: '最多', very: '非常', now: '现在', then: '那时', here: '这里', there: '那里',
    up: '上', down: '下', out: '出', off: '关', over: '过', under: '下',
    about: '关于', into: '进入', before: '之前', after: '之后', between: '之间',
    through: '穿过', from: '从', by: '被',
    can: '能', could: '能', will: '将', would: '会', shall: '应', should: '应该',
    may: '可能', might: '也许', must: '必须',
    what: '什么', who: '谁', whom: '谁', which: '哪个', where: '哪里', when: '何时',
    why: '为什么', how: '怎么', all: '全部', each: '每个', every: '每个', some: '一些',
    any: '任何', both: '两者', few: '少数', less: '更少'
  };

  function escReg(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 术语表「兜底替换」——只替换**原文里真的出现过**的词。
   *
   * 为什么必须加这道护栏：译文里出现某个字符串有两种可能
   *   ① 原文就有这个词、模型没译，留了下来 → 应该替（这正是术语表的用途）
   *   ② 原文没有、是模型按目标语语法**自己生成**的 → 绝不能替
   * 不加判断盲目全局替换会误伤 ②。真实案例：
   *   原文中文「AI回复」→ 译文日语「AIの回复」，术语表写了「の=0」，
   *   盲目替换会把模型生成的「の」全换成 0，输出「AI0回复」。
   */
  function applyGlossaryFallback(output, sourceText, glossary) {
    let out = String(output == null ? '' : output);
    const src = String(sourceText == null ? '' : sourceText);
    (glossary || []).slice()
      .sort((a, b) => (b.src || '').length - (a.src || '').length)
      .forEach((t) => {
        if (!t || !t.src || !t.dst) return;
        try {
          if (!new RegExp(escReg(t.src), 'i').test(src)) return;  // 原文没有 → 译文里的是模型生成的，不动
          out = out.replace(new RegExp(escReg(t.src), 'gi'), t.dst);
        } catch (e) { /* 正则异常就跳过这个词 */ }
      });
    return out;
  }

  // 常见西方人名 → 中文译名（音译）。离线时也能把检测到的人名翻成「汤姆（人名）」，
  // 而不是把它们原样保留。覆盖不到的名字（如小说原创角色）仍原样保留，靠术语表手动覆盖。
  const NAME_TRANS = {
    tom: '汤姆', jerry: '杰瑞', harry: '哈利', lily: '莉莉', mary: '玛丽', john: '约翰',
    james: '詹姆斯', david: '大卫', mike: '迈克', lucy: '露西', alice: '爱丽丝', bob: '鲍勃',
    jack: '杰克', rose: '罗丝', peter: '彼得', paul: '保罗', anna: '安娜', emma: '艾玛',
    olivia: '奥利维亚', william: '威廉', charlie: '查理', george: '乔治', henry: '亨利',
    edward: '爱德华', catherine: '凯瑟琳', elizabeth: '伊丽莎白', daniel: '丹尼尔',
    robert: '罗伯特', michael: '迈克尔', sarah: '萨拉', jessica: '杰西卡', jane: '简',
    mark: '马克', steven: '史蒂文', andrew: '安德鲁', thomas: '托马斯', joseph: '约瑟夫',
    kevin: '凯文', brian: '布莱恩', jennifer: '詹妮弗', susan: '苏珊', karen: '卡伦',
    linda: '琳达', patricia: '帕特丽夏', barbara: '芭芭拉', margaret: '玛格丽特',
    charles: '查尔斯', christopher: '克里斯托弗', matthew: '马修', anthony: '安东尼',
    donald: '唐纳德', richard: '理查德', samuel: '塞缪尔', benjamin: '本杰明',
    alexander: '亚历山大', nicholas: '尼古拉斯', patrick: '帕特里克', ryan: '瑞安',
    jonathan: '乔纳森', justin: '贾斯汀', brandon: '布兰登', tyler: '泰勒',
    joshua: '约书亚', ethan: '伊森', noah: '诺亚', liam: '利亚姆', sophia: '索菲娅',
    isabella: '伊莎贝拉', mia: '米娅', amelia: '阿米莉亚', harper: '哈珀',
    victor: '维克托', claire: '克莱尔', helen: '海伦', frank: '弗兰克', eric: '埃里克',
    carol: '卡罗尔', bruce: '布鲁斯', diana: '戴安娜', arthur: '亚瑟', grace: '格蕾丝',
    // --- 常见外国名 / 历史名人：离线（不查词典）时也能认出来 ---
    leonardo: '莱昂纳多', michelangelo: '米开朗基罗', raphael: '拉斐尔', donatello: '多纳泰罗',
    shakespeare: '莎士比亚', newton: '牛顿', einstein: '爱因斯坦', darwin: '达尔文',
    napoleon: '拿破仑', caesar: '凯撒', cleopatra: '克利奥帕特拉', mozart: '莫扎特',
    beethoven: '贝多芬', bach: '巴赫', chopin: '肖邦', picasso: '毕加索', vangogh: '梵高',
    tesla: '特斯拉', edison: '爱迪生', lincoln: '林肯', washington: '华盛顿',
    churchill: '丘吉尔', gandhi: '甘地', curie: '居里', galileo: '伽利略',
    victoria: '维多利亚', louis: '路易', pierre: '皮埃尔', marie: '玛丽',
    antonio: '安东尼奥', carlos: '卡洛斯', diego: '迭戈', pablo: '巴勃罗',
    emil: '埃米尔', klaus: '克劳斯', hans: '汉斯', lars: '拉尔斯',
    oliver: '奥利弗', hermione: '赫敏', ronald: '罗纳德',
    gandalf: '甘道夫', frodo: '弗罗多', aragorn: '阿拉贡', sherlock: '夏洛克',
    watson: '华生', poirot: '波洛', marple: '马普尔'
  };

  // 注：人名检测不再用「停用词排除 + 首字母大写猜测」那套（误判太高，
  // 段首任何词、Chinese、Then 都会被当成名字）。
  // 离线 / DeepL 只认内置常见名表 NAME_TRANS（见下方 detectKnownNames）；
  // AI 引擎则让模型自己标（汤姆（人名）式，见 NAME_DETECT_INSTR）。

  // 占位符用 PUA 私有区字符（源码里写成 \uF8FF / \uF8FE 转义，保证文件里只有 ASCII，
  // 不会混进 NUL 之类的控制符；这些字符正常书里不会出现，迷你词典也不会匹配到）。
  const PH_OPEN = String.fromCharCode(0xF8FF);
  const PH_CLOSE = String.fromCharCode(0xF8FE);

  // 本地翻译核心：保护不翻译名单 → 替换术语表 → 替换译名表（人名）→ 剩余英文走 mini 词典。
  // 纯函数，便于单测。nameTrans 形如 { "Tom": "汤姆（人名）" }，由控制器从检测到的
  // 人名里挑出「有现成译名」的那部分，离线也能把 Tom 翻成「汤姆（人名）」。
  function applyLocal(text, glossary, noTranslate, nameTrans) {
    glossary = glossary || [];
    noTranslate = noTranslate || [];
    nameTrans = nameTrans || {};
    let s = text == null ? '' : String(text);

    // 1) 用占位符保护「不翻译名单」（之后恢复）。大小写不敏感，但原串大小写保留。
    const protect = [];
    if (noTranslate.length) {
      const re = new RegExp('(' + noTranslate.map(escReg).join('|') + ')', 'gi');
      s = s.replace(re, (m) => PH_OPEN + (protect.push(m) - 1) + PH_CLOSE);
    }

    // 2) 术语表替换（长词优先；大小写不敏感，避免 "UPPER HOUSE" 配不上 "upper house"）
    glossary.slice().sort((a, b) => b.src.length - a.src.length).forEach((t) => {
      if (!t.src) return;
      s = s.replace(new RegExp(escReg(t.src), 'gi'), t.dst);
    });

    // 3) 译名表：把检测到的、有现成中文译名的人名换成「译名（人名）」。
    //    放在 mini 词典之前，避免被逐词拆开误译。
    Object.keys(nameTrans).forEach((nm) => {
      if (!nm) return;
      s = s.replace(new RegExp(escReg(nm), 'g'), nameTrans[nm]);
    });

    // 4) 剩余英文逐词过 mini 词典。没收录的词**原样保留**（不再用「」包住，
    //    那样会让离线译文满屏括号、看着像坏了）。离线词典只有 ~150 个常用词，
    //    想整句通顺请接 DeepL / OpenAI / 本地模型 引擎。
    if (/[A-Za-z]/.test(s)) {
      s = s.replace(/[A-Za-z][A-Za-z'’.\-]*/g, (w) => {
        const low = w.toLowerCase().replace(/['’]$/, '');
        return MINI_ENZH[low] != null ? MINI_ENZH[low] : w;
      });
    }

    // 5) 还原「不翻译名单」占位符
    s = s.replace(new RegExp(PH_OPEN + '(\\d+)' + PH_CLOSE, 'g'), (_, i) => protect[+i]);
    return s;
  }

  // ------------------------------------------------------------------
  // 占位符保护（给「不听指令」的模型用，见 hyMTProvider）
  // 专用翻译模型（如 Hy-MT2）只服从翻译指令，你在 prompt 里写「保留 XX 原文」
  // 它大概率不听。所以不翻译名单 / 人名只能物理替换成占位符，翻完再还原。
  // ------------------------------------------------------------------
  function protectPhrases(text, words) {
    const store = [];
    let s = String(text == null ? '' : text);
    (words || []).forEach((w) => {
      if (!w) return;
      s = s.replace(new RegExp(escReg(w), 'gi'), (m) => PH_OPEN + (store.push(m) - 1) + PH_CLOSE);
    });
    return { text: s, store: store };
  }

  function restorePhrases(text, store) {
    let s = String(text == null ? '' : text);
    s = s.replace(new RegExp(PH_OPEN + '(\\d+)' + PH_CLOSE, 'g'),
      (whole, i) => (store[+i] != null ? store[+i] : whole));
    // 模型有时会把占位符吞掉一半（只剩开或闭字符），残留的直接清掉，别漏给用户
    s = s.replace(new RegExp('[' + PH_OPEN + PH_CLOSE + ']', 'g'), '');
    return s;
  }

  // 清掉模型吐出的特殊 token 残留（Hy-MT2 / 部分本地模型常见：<|im_start|>、<｜end▁of▁thinking｜> 等）
  function stripModelNoise(text) {
    return String(text == null ? '' : text)
      .replace(/<[|｜][^>]{0,60}[|｜]>/g, '')
      .replace(/<\|?(?:im_start|im_end|endoftext|end▁of▁thinking)\|?>/gi, '')
      .trim();
  }

  /** 从文本本身猜源语言（R121）：OCR 出来的日文漫画、韩文小说，
   *  引擎 auto 经常猜成中文，翻出来一塌糊涂。按字符集判断最可靠：
   *  有假名就是日文（日文里必有假名，纯汉字的日文极少），有谚文就是韩文…… */
  function guessSrcLang(t) {
    const s = String(t || '');
    if (!s) return 'auto';
    if (/[\u3040-\u309f\u30a0-\u30ff]/.test(s)) return 'JA';   // 平假名 / 片假名
    if (/[\uac00-\ud7af]/.test(s)) return 'KO';                 // 谚文
    if (/[\u0e00-\u0e7f]/.test(s)) return 'TH';
    if (/[\u0400-\u04ff]/.test(s)) return 'RU';
    if (/[\u4e00-\u9fff]/.test(s)) return 'ZH';
    if (/[A-Za-z]{2,}/.test(s)) return 'EN';
    return 'auto';
  }

  // 目标语言的「完整中文名」——Hy-MT2 官方模板要求写完整语言名，不能写 ZH / ZH-HANT
  function langFullName(code, fallback) {
    const l = TARGET_LANGS.find((x) => x.code === code);
    return (l && l.name) || fallback || '简体中文';
  }

  // 源语言 / 目标语言选项。DeepL 直接用其语言代码；OpenAI 在 prompt 里说明。
  // 代码遵循 DeepL 的语言代码（ZH-HANT=繁体，PT-PT/PT-BR 区分欧洲/巴西葡萄牙语等）。
  const SOURCE_LANGS = [
    { code: 'auto', name: '自动检测' },
    { code: 'EN', name: '英语' },
    { code: 'JA', name: '日语' },
    { code: 'KO', name: '韩语' },
    { code: 'FR', name: '法语' },
    { code: 'DE', name: '德语' },
    { code: 'RU', name: '俄语' },
    { code: 'ES', name: '西班牙语' },
    { code: 'PT', name: '葡萄牙语' },
    { code: 'IT', name: '意大利语' },
    { code: 'NL', name: '荷兰语' },
    { code: 'ZH', name: '中文' }
  ];
  const TARGET_LANGS = [
    { code: 'ZH', name: '简体中文' },
    { code: 'ZH-HANT', name: '繁體中文' },
    { code: 'EN', name: '英语' },
    { code: 'JA', name: '日语' },
    { code: 'KO', name: '韩语' },
    { code: 'FR', name: '法语' },
    { code: 'DE', name: '德语' },
    { code: 'RU', name: '俄语' },
    { code: 'ES', name: '西班牙语' },
    { code: 'PT-PT', name: '葡萄牙语（欧洲）' },
    { code: 'PT-BR', name: '葡萄牙语（巴西）' },
    { code: 'IT', name: '意大利语' },
    { code: 'NL', name: '荷兰语' },
    { code: 'PL', name: '波兰语' },
    { code: 'AR', name: '阿拉伯语' },
    { code: 'TH', name: '泰语' },
    { code: 'VI', name: '越南语' },
    { code: 'ID', name: '印尼语' },
    { code: 'TR', name: '土耳其语' },
    { code: 'UK', name: '乌克兰语' },
    { code: 'SV', name: '瑞典语' },
    { code: 'HI', name: '印地语' },
    { code: 'EL', name: '希腊语' },
    { code: 'HE', name: '希伯来语' },
    { code: 'HU', name: '匈牙利语' },
    { code: 'CS', name: '捷克语' },
    { code: 'RO', name: '罗马尼亚语' },
    { code: 'FI', name: '芬兰语' },
    { code: 'DA', name: '丹麦语' },
    { code: 'NB', name: '挪威语' }
  ];

  /*
   * 人名 / 专有名词检测。两套机制，按引擎区分：
   *
   *  A) 离线词典 / DeepL（拿不到翻译软件的标注）—— 只认内置常见西方名表 NAME_TRANS。
   *     不靠「首字母大写」猜：那样误判太高（段首任何词、Chinese、Then 都会被当名字）。
   *     好处是几乎零误判；代价是只覆盖表里那 ~80 个常见名，认不到的小说原创角色
   *     要靠「术语表 / 不翻译名单」手动补。
   *
   *  B) AI 引擎（OpenAI / 本地模型）—— 让翻译软件自己标。prompt 里要求模型在译文里
   *     给每个人名加「（人名）」记号（汤姆（人名）式），并额外把原文人名单列成
   *     names 数组返回（见 NAME_DETECT_INSTR）。这是用户要的「通过翻译软件的（人名）
   *     记号自动检测」，比离线按大小写猜准得多。
   *
   * 两条都保留「全大写 → 不翻译」规则（protectAllCaps）：US / CEO / THBT / NASA 这类
   * 缩写/机构名既不翻译、也不算人名。
   */
  function detectKnownNames(text) {
    if (!text) return [];
    const found = new Set();
    const re = /[A-Za-z][A-Za-z'’.\-]*/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      // 词尾的句点/连字符/所有格要先削掉：否则 "Jerry." 会带个点变成 "jerry."，
      // "Tom's" 变成 "tom's"，都匹配不上名表（这是 Jerry 被漏掉的原因）。
      let w = m[0].replace(/[.\-]+$/, '').replace(/['’]s$/i, '');
      w = w.replace(/[.\-]+$/, '');
      if (!w) continue;
      // ⚠️ 首字母小写 → 不是人名（rose ≠ Rose）：排除像 "rose"（花 / 动词）这类普通词，
      //     它们不该被名表误当成 "Rose"。人名正常书写是首字母大写的专有名词。
      //     全大写缩写（NASA / ROSE）也不是人名 —— 那条由 protectAllCaps 处理（原样保留），
      //     别在这里当人名捡回来。
      if (!/^[A-Z]/.test(w)) continue;
      if (/^[A-Z]+$/.test(w)) continue;
      if (NAME_TRANS[w.toLowerCase()] != null) found.add(w);
    }
    return Array.from(found);
  }

  // 全大写缩写 / 机构名（US / CEO / THBT / NASA …）→ 不翻译，原样保留。
  // 这条规则保留（用户明确要求）：它们不是人名，也不该被迷你词典误译。
  function protectAllCaps(text) {
    if (!text) return [];
    return (text.match(/\b[A-Z]{2,}\b/g) || []).filter((w) => w !== 'I');
  }

  // ---- 在线词典核对人名（有道）----
  // 思路（用户指定的机制）：有道这类词典查人名时会标「n. 汤姆（男子名）」，
  // 我们直接**借用词典的（男子名 / 女子名 / 人名）标注来判定这是不是人名**，
  // 而不是靠首字母大写去猜。顺带还能把词典给的译名（汤姆）拿来用。
  // 注意：这是「查词典」，跟 AI 翻译无关 —— 离线词典引擎 / DeepL 都能用。
  // 无代理（GitHub Pages 静态站）或断网时静默降级，不影响翻译本身。
  // 只在「括号里的标注」才算人名，避免 "n. 名字"、"v. 不断烦扰" 这类被误判：
  //   汤姆（男子名）✓   哈里（人名）✓   伏地魔（《哈利波特》里的人物）✓
  //   n. 名字 ✗         n. 房子 ✗
  //
  // ⚠️ 有道 suggest 接口返回的 explain 是**截断的短摘要**（约 45 字），
  //    右括号经常被切掉 —— 实测：
  //      Leonardo → "n. 列奥纳多（意大利画家、雕刻家、建筑家、工程师列奥纳多·达·芬奇 Leonardo di ser..."
  //      DiCaprio → "迪卡普里奥（姓氏）"        ← 有完整括号，所以只有后者能被认出来
  //    因此：① 不再要求右括号；② 补两条判据（中文间隔号译名 / 括号内身份词），
  //    否则像 Leonardo 这种"括号里塞了一长串头衔"的条目会全部漏掉。
  const PERSON_MARK = /[（(][^（(]*?(?:男子名|女子名|人名|姓氏|人物)/;   // 右括号可缺
  // 括号内（或截断的括号内）出现身份词：列奥纳多（意大利画家、雕刻家…）
  const PERSON_ROLE = /[（(][^（(]*?(?:画家|雕塑家|雕刻家|建筑家|建筑师|工程师|科学家|作家|小说家|诗人|音乐家|作曲家|钢琴家|小提琴家|指挥家|歌唱家|男演员|女演员|演员|影星|明星|艺人|歌手|导演|编剧|制片人|将军|元帅|国王|王后|女王|皇帝|沙皇|教皇|首相|总统|总理|大臣|哲学家|物理学家|化学家|数学家|天文学家|生物学家|医学家|发明家|设计师|探险家|航海家|军事家|政治家|企业家|银行家|运动员|球星|球员|棋手|学者|大师|名厨)/;
  // 中文音译名里的间隔号：列奥纳多·达·芬奇 / 莱昂纳多·迪卡普里奥 —— 中文里间隔号
  // 基本只出现在外国人名（少数地名）译名中，是很强的信号。
  const PERSON_DOTNAME = /[一-鿿]{2,}(?:·[一-鿿]{2,}){1,3}/;

  // 「虚构作品里出现的名字」不算真人：霍格沃茨的释义是"…魔法小说《哈利·波特》里的学校"，
  // 里面的「哈利·波特」会命中间隔号判据。所以间隔号 / 身份词这两条要排除带书名号、
  // 或明写小说/电影/游戏等的条目；只有明确的（男子名 / 人名 / 人物）标注不受此限。
  const FICTION_HINT = /《|小说|电影|电视剧|动画|漫画|游戏|作品|角色| Series|series/;
  // 「XX：美国著名男演员，代表作品包括《泰坦尼克号》…」这种条目里虽然有"作品"字样，
  // 但冒号后的身份描述说明它是真人，要认；反过来霍格沃茨那种"…魔法学校"没有身份描述，不认。
  const REAL_PERSON_DESC = /[：:][^；;]{0,40}?(?:演员|歌手|作家|导演|画家|雕塑家|音乐家|科学家|球星|球员|运动员|总统|国王|女王|将军|设计师|企业家|学者|工程师|建筑家|航海家|探险家)/;
  function isPersonExplain(explain) {
    if (PERSON_MARK.test(explain)) return true;                       // 词典明写是人名
    if (FICTION_HINT.test(explain)) return REAL_PERSON_DESC.test(explain);
    return PERSON_ROLE.test(explain) || PERSON_DOTNAME.test(explain);
  }

  // 从有道 explain 里取中文译名。优先取【名】段（专有名词条目），
  // 例如 "v. 不断烦扰...; 【名】 （Harry）（英、瑞）哈里（人名）" → 哈里
  function extractZhName(explain) {
    const parts = String(explain).split(/;\s*/).map((s) => s.trim()).filter(Boolean);
    // 【名】段才是姓名条目；第一段往往是普通词义（如 harry 的动词义"不断烦扰"）
    let sec = parts.filter((s) => s.indexOf('【名】') === 0)[0] || parts[0];
    sec = sec.replace(/^【[^】]*】\s*/, '').replace(/^[a-z]{1,6}\.\s*/i, '');
    sec = sec.replace(/^[（(][^）)]*[）)]\s*/, '');   // 去掉开头的（Harry）（英、瑞）
    // 先取「带间隔号的全名」：莱昂纳多·迪卡普里奥：美国著名男演员… → 莱昂纳多·迪卡普里奥
    let m = PERSON_DOTNAME.exec(sec);
    if (m) return m[0];
    m = /([一-鿿A-Za-z·]+)\s*[（(](?:男子名|女子名|人名|姓氏)[）)]/.exec(sec);
    if (m) return m[1];
    m = /^[^;，,、]*?([一-鿿]+)/.exec(sec);
    return m ? m[1] : '';
  }
  const CAND_STOP = new Set([
    'the', 'this', 'that', 'these', 'those', 'then', 'there', 'here', 'however', 'therefore',
    'moreover', 'furthermore', 'although', 'because', 'since', 'while', 'after', 'before',
    'during', 'also', 'thus', 'hence', 'today', 'yesterday', 'tomorrow', 'chapter', 'section',
    'mr', 'mrs', 'ms', 'dr', 'st', 'prof', 'sir', 'madam',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
    'september', 'october', 'november', 'december',
    'chinese', 'english', 'american', 'british', 'french', 'german', 'japanese', 'korean',
    'russian', 'spanish', 'italian', 'european', 'asian', 'african'
  ]);
  const MAX_DICT_LOOKUPS = 12;   // 每段最多查多少个候选词（避免刷请求）
  const _nameCache = {};         // word -> { isPerson, zh }，内存缓存

  function youdaoSuggestURL(w) {
    // num=3：短摘要只有 45 字，多拿几条才看得到「莱昂纳多·迪卡普里奥：美国著名男演员…」
    // 这种藏在后面的姓名条目（只取 1 条时会漏判 Leonardo 这类名字）。
    return 'https://dict.youdao.com/suggest?q=' + encodeURIComponent(w) +
      '&num=3&doctype=json&le=en';
  }

  // 查一次有道，判断是否人名 + 取回词典给的中文译名
  async function dictLookupName(word) {
    if (Object.prototype.hasOwnProperty.call(_nameCache, word)) return _nameCache[word];
    const res = { isPerson: false, zh: '' };
    try {
      // 走本地 serve.py 的 /proxy 绕开跨域；没有代理时 r.ok=false，静默降级
      const r = await fetch('/proxy?url=' + encodeURIComponent(youdaoSuggestURL(word)),
        { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        // 短摘要里第一条未必是人名条目：num=3 时 Leonardo 的第 1 条是"意大利画家…"，
        // 第 2/3 条才是"莱昂纳多·迪卡普里奥：美国著名男演员…"。所以**逐条看，命中即算**。
        const entries = (j && j.data && j.data.entries) || [];
        let hit = '';
        for (const it of entries) {
          const ex = (it && it.explain) || '';
          if (ex && isPersonExplain(ex)) { hit = ex; break; }
        }
        if (hit) {
          res.isPerson = true;
          const zh = extractZhName(hit);
          if (/[一-鿿]/.test(zh)) res.zh = zh;
        }
      }
    } catch (e) { /* 离线 / 无代理：降级为「不是人名」，不打断翻译 */ }
    _nameCache[word] = res;
    return res;
  }

  // 需要拿去词典核对的候选词：首字母大写、非全大写、不是常见词
  // 单词是否值得拿去查词典（大写、非缩写、非常见词）
  function isCandWord(w) {
    if (!w) return false;
    if (!/^[A-Z]/.test(w)) return false;         // 必须首字母大写
    if (/^[A-Z]+$/.test(w)) return false;        // 全大写缩写不查（保留原样，不是人名）
    const low = w.toLowerCase();
    if (MINI_ENZH[low] != null) return false;    // 常见词
    if (CAND_STOP.has(low)) return false;
    return true;
  }

  // 需要拿去词典核对的候选词：首字母大写、非全大写、不是常见词。
  // 除了单词，还要带上「相邻的两个大写词」——英语里 Firstname Lastname 是最强的人名信号，
  // 而且词典对全名往往有专门的姓名条目（"Leonardo DiCaprio" → "莱昂纳多·迪卡普里奥：美国著名男演员…"），
  // 单查 "Leonardo" 拿到的却只是一串头衔摘要，容易判不出来。
  function candidateNames(text) {
    if (!text) return [];
    const out = new Set();
    const re = /[A-Za-z][A-Za-z'’.\-]*/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      let w = m[0].replace(/[.\-]+$/, '').replace(/['’]s$/i, '').replace(/[.\-]+$/, '');
      if (isCandWord(w)) out.add(w);
    }
    // 名 + 姓（两个相邻且都大写的词，中间只有空格）
    const pair = /[A-Z][A-Za-z'’\-]*\s+[A-Z][A-Za-z'’\-]*/g;
    while ((m = pair.exec(text)) !== null) {
      const two = m[0].split(/\s+/);
      if (isCandWord(two[0]) && isCandWord(two[1])) out.add(two[0] + ' ' + two[1]);
    }
    return Array.from(out);
  }

  // 从模型输出里解析「{ translation, names }」。模型可能包 ```json 围栏、或前后带说明
  // 文字，这里都做兜底：先去围栏，再截取第一个 { 到最后一个 }，最后 JSON.parse。
  function parseModelJSON(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') {
        const tr = (typeof o.translation === 'string') ? o.translation
          : (typeof o.text === 'string') ? o.text : '';
        const names = Array.isArray(o.names) ? o.names.map(String)
          : (Array.isArray(o.persons) ? o.persons.map(String) : []);
        return { translation: tr, names: names };
      }
    } catch (e) { /* 解析失败返回 null，由调用方降级为纯译文 */ }
    return null;
  }

  // 人名检测指令（仅 AI 引擎、且开启「自动检测人名」时追加到 system prompt）。
  // 让翻译软件自己标出人名（汤姆（人名）式），比离线按大小写猜准确得多。
  const NAME_DETECT_INSTR = `
【人名检测】翻译完成后，请额外找出原文中的「人名」（仅人物姓名；不要列地名、机构名、作品名、民族、国家）。
- 只输出 JSON，不要任何解释或多余文字，格式严格为：
{"translation":"这里放完整译文","names":["原文里出现的人名1","人名2"]}
- 译文里遇到人名时，**保留英文原文、不要音译**（例如 Tom 仍写 Tom、不要写成「汤姆」）。
- 若本段没有人名，names 为空数组 []。`;

  const localGlossary = {
    id: 'local',
    name: '本地词典',
    online: false,
    async translate(text, ctx) {
      return applyLocal(
        text,
        (ctx && ctx.glossary) || [],
        (ctx && ctx.noTranslate) || [],
        (ctx && ctx.nameTrans) || {}
      );
    }
  };

  // MyMemory：免费、无需任何 Key 的在线翻译（走 /proxy 避免跨域）。
  // 适合「开箱即用」的划词 / 段落翻译；全书翻译有每日额度（约 5000 词），超了会提示。
  // 中文代码用 ZH-CN；源语言选 auto 时按正文是否含中文反推。
  const myMemoryProvider = {
    id: 'mymemory',
    name: 'MyMemory 在线翻译',
    online: true,
    needsKey: false,
    async translate(text, ctx) {
      const tgt = (ctx && ctx.targetLang) || 'ZH';
      const src = (ctx && ctx.sourceLang) || 'auto';
      const mmTgt = tgt === 'ZH' ? 'ZH-CN' : tgt;
      let mmSrc;
      if (!src || src === 'auto') {
        mmSrc = /[一-鿿]/.test(text || '') ? 'ZH-CN' : 'EN';
      } else {
        mmSrc = src === 'ZH' ? 'ZH-CN' : src;
      }
      // 源语言与目标语言相同时 MyMemory 会返回 "PLEASE SELECT TWO DISTINCT LANGUAGES"，
      // 常见于中文书默认目标也是中文。自动把目标切为对侧语言，保证有返回。
      let mmFinalTgt = mmTgt;
      if (mmSrc === mmTgt) {
        mmFinalTgt = (mmSrc === 'ZH-CN') ? 'EN' : 'ZH-CN';
      }
      const q = encodeURIComponent(text);
      const url = 'https://api.mymemory.translated.net/get?q=' + q +
        '&langpair=' + encodeURIComponent(mmSrc + '|' + mmFinalTgt);
      const r = await fetch('/proxy?url=' + encodeURIComponent(url));
      if (!r.ok) throw new Error('MyMemory 返回 ' + r.status);
      const j = await r.json().catch(() => null);
      const tr = j && j.responseData && j.responseData.translatedText;
      if (!tr || typeof tr !== 'string') throw new Error('MyMemory 未返回译文');
      // 去掉 MyMemory 偶尔夹带的 HTML 实体
      return tr.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    }
  };

  // DeepL：原生支持 glossary，质量最好。需要 API Key（免费版填 deeplFree）。
  const deeplProvider = {
    id: 'deepl',
    name: 'DeepL API',
    online: true,
    needsKey: true,
    async translate(text, ctx) {
      // Key 按引擎存（byEngine），旧存档才退回顶层那一份
      const cfg = (ctx && ctx.byEngine && ctx.byEngine[this.id]) || {};
      const isActive = !ctx || !ctx.provider || ctx.provider === this.id;
      const apiKey = cfg.apiKey || (isActive && ctx.apiKey) || '';
      if (!apiKey) throw new Error('DeepL 需要 API Key（在面板里填）');
      const base = ctx.deeplFree
        ? 'https://api-free.deepl.com/v2/translate'
        : 'https://api.deepl.com/v2/translate';
      const body = new URLSearchParams();
      body.set('text', text);
      body.set('target_lang', (ctx.targetLang || 'ZH').toUpperCase());
      // 指定了源语言才传（'auto' 时 DeepL 自己探测）
      if (ctx.sourceLang && ctx.sourceLang !== 'auto') body.set('source_lang', ctx.sourceLang.toUpperCase());
      if (ctx.glossaryId) body.set('glossary_id', ctx.glossaryId);
      const r = await fetch(base, {
        method: 'POST',
        headers: {
          'Authorization': 'DeepL-Auth-Key ' + apiKey,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body.toString()
      });
      if (!r.ok) throw new Error('DeepL 返回 ' + r.status);
      const j = await r.json();
      return j.translations && j.translations[0] && j.translations[0].text;
    }
  };

  const OPENAI_DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

  function buildGlossaryPrompt(ctx) {
    const srcName = (ctx.sourceLang && ctx.sourceLang !== 'auto')
      ? (SOURCE_LANGS.find((l) => l.code === ctx.sourceLang) || {}).name || ctx.sourceLang
      : '自动检测';
    const tgtName = (TARGET_LANGS.find((l) => l.code === ctx.targetLang) || {}).name || ctx.targetLang;
    let p = '你是一个严谨的翻译助手。源语言：' + srcName + '。请把下面的文本翻译成' +
      tgtName + '。';
    if (ctx.glossary && ctx.glossary.length) {
      p += '\n必须严格使用以下术语对照（原词 → 译词）：\n' +
        ctx.glossary.map((t) => '- ' + t.src + ' → ' + t.dst).join('\n');
    }
    if (ctx.noTranslate && ctx.noTranslate.length) {
      p += '\n以下词/短语保持原文、不要翻译：' + ctx.noTranslate.join('、');
    }
    if (ctx.extraPrompt && String(ctx.extraPrompt).trim()) {
      p += '\n额外要求（务必遵守）：' + String(ctx.extraPrompt).trim();
    }
    // 词典核对出的人名：明确告诉模型这些是人名，保留原文不翻译
    if (ctx.keepNames && ctx.keepNames.length) {
      p += '\n原文里这些词是人名，请在译文中**保持英文原文、不要音译也不要翻译**：' +
        ctx.keepNames.join('、') + '。';
    }
    // 用户从名单里删掉的词：说明它不是人名（或用户不想保留），按普通词正常翻译
    if (ctx.dropNames && ctx.dropNames.length) {
      p += '\n这些词**不是人名**，请按普通词正常翻译（可音译）：' +
        ctx.dropNames.join('、') + '。';
    }
    if (ctx.askNames) {
      p += NAME_DETECT_INSTR;
    } else {
      p += '\n只输出译文，不要解释，不要加引号。';
    }
    return p;
  }

  // ------------------------------------------------------------------
  // Hy-MT2（腾讯混元翻译模型）专用 prompt —— 走**官方模板**，全部塞进 user message。
  // 官方模板三件套（语言名必须写完整中文名）：
  //   默认：将以下文本翻译为{目标语言}，注意只需要输出翻译后的结果，不要额外解释：\n{原文}
  //   术语：参考下面的翻译：\nX 翻译成 Y\n…\n将以下文本翻译为{目标语言}，…：\n{原文}
  //   风格：请将以下文本翻译为{目标语言}。\n注意翻译的风格要严格符合【{风格}】\n{原文}
  //   上下文：{上文}\n参考上面的信息，把下面的文本翻译成{目标语言}，注意不需要翻译上文，也不要额外解释：\n{原文}
  // ⚠️ 它是**纯翻译模型**，翻译之外的指令不可靠：不要让它返回 JSON、不要指望它
  //    「保留 XX 原文」（人名/不翻译名单一律走占位符物理保护）。
  // ------------------------------------------------------------------
  function buildHyMTPrompt(ctx) {
    const tgt = langFullName(ctx && ctx.targetLang, '简体中文');
    let p = '';
    // 1) 术语干预（原生指令，比译后字符串替换可靠得多）
    const gl = ((ctx && ctx.glossary) || []).filter((t) => t && t.src && t.dst);
    const pairs = gl.map((t) => t.src + ' 翻译成 ' + t.dst);
    const inGl = new Set(gl.map((t) => t.src));
    // 「不翻译名单 / 保留原文的人名」也走术语干预 —— 官方支持 X 翻译成 X。
    // ⚠️ 实测：Hy-MT2 上**占位符保护是有害的**。把 Voldemort 换成私有区字符后，
    //    模型会把主语翻成「他」（占位符变成了它不认识的东西）；
    //    而写成「Voldemort 翻译成 Voldemort」则原样保留，且不影响术语表。
    //    所以这个引擎不做占位符替换（见 placeholderProtect: false）。
    ((ctx && ctx.noTranslate) || []).forEach((w) => {
      if (!w || inGl.has(w)) return;          // 用户已指定译名 → 以用户为准
      const line = w + ' 翻译成 ' + w;
      if (pairs.indexOf(line) < 0) pairs.push(line);
    });
    if (pairs.length) p += '参考下面的翻译：\n' + pairs.join('\n') + '\n';
    // 2) 上下文感知（前一段译文）：优先级高于风格，因为官方模板里它是独立形态
    // 3) 风格 / 额外要求（对上「翻译要求」框）
    //    ⚠️ 实测：风格必须**并进官方那句指令里**，不能单独写成
    //    「请将以下文本翻译为X。\n注意翻译的风格要严格符合【…】」——
    //    那样 Hy-MT2 会丢掉不翻译名单的占位符（Tom 被译成「他」）。
    //    用官方句 + "，且风格要符合【…】" 则占位符和术语表都正常。
    const extra = ctx && ctx.extraPrompt ? String(ctx.extraPrompt).trim() : '';
    const style = extra ? '，且风格要符合【' + extra + '】' : '';
    if (ctx && ctx.context) {
      return p + ctx.context + '\n参考上面的信息，把下面的文本翻译成' + tgt +
        '，注意不需要翻译上文，也不要额外解释' + style + '：\n';
    }
    return p + '将以下文本翻译为' + tgt + '，注意只需要输出翻译后的结果，不要额外解释' + style + '：\n';
  }

  // OpenAI / 兼容接口 工厂：任何暴露 OpenAI 兼容 /v1/chat/completions 的服务都能接——
  // 云端 OpenAI，以及本机模型（Ollama / LM Studio / vLLM 等）。needsKey=false 时不强制填 Key。
  // fetch 失败时浏览器的报错（"Failed to fetch" / "NetworkError when attempting to
  // fetch resource"）不含任何可用信息，这里按端点类型翻成人能照做的提示。
  // 本地服务最常见的三种原因：① 引擎没启动 ② 端口被改过 ③ 页面是 file:// 打开的
  // （file:// 的 origin 是 null，浏览器对跨源请求更严格，本地服务也可能被拦）。
  // 本地引擎端点的「同源化」：页面不是从本机 127.0.0.1 打开时（iPad / 局域网 IP），
  // 浏览器会把 127.0.0.1 解析成设备自身，直连电脑上的 llama.cpp / Ollama 必然失败；
  // 且跨源还会被 CORS 拦。这里改走 serve.py 的 /api/mt-proxy（同源，服务端转发到 127.0.0.1）。
  // 端口沿用原 endpoint 的端口（8080 / 11434 / 1234），serve.py 侧有白名单。
  function effectiveEndpoint(ep) {
    try {
      const u = new URL(String(ep || ''), typeof location !== 'undefined' ? location.href : undefined);
      const loop = /^(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)$/i.test(u.hostname);
      const pageHost = (typeof location !== 'undefined' && location.hostname) || '';
      const pageLoop = !pageHost || /^(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)$/i.test(pageHost);
      if (loop && !pageLoop) {
        const q = (u.port && u.port !== '80' && u.port !== '443') ? ('?port=' + encodeURIComponent(u.port)) : '';
        return '/api/mt-proxy' + (u.pathname || '/') + q;
      }
    } catch (e) { /* 解析失败保持原样 */ }
    return ep;
  }

  function describeFetchFailure(err, endpoint, name, engineId) {
    const raw = (err && err.message) || String(err);
    const isLocal = /127\.0\.0\.1|localhost|\[::1\]/i.test(String(endpoint || ''));
    let msg;
    /* R158：安卓壳里没有本地翻译引擎（那是电脑版的 llama.cpp / Ollama）。
       手机上「127.0.0.1」指的是手机自己，所以以前那段「先跑 start-llama.ps1、
       保持 127.0.0.1 即可」在手机上全是废话（用户截图问「啥意思」）。
       这里直接判 App，给一条能做的事：填电脑那台的局域网地址。 */
    const inApp = (typeof window !== 'undefined' && !!window.InkAndroid);
    if (inApp && isLocal) {
      /* R170：连端口都不从对账列表里猜了 —— 默认 8080 就是引擎端口，
         读 localStorage 只会把「另一台」的地址带进提示。 */
      msg = '手机上连的是它自己（' + endpoint + '），可手机里没有翻译引擎。\n\n'
        + '两个办法：\n'
        + '① 用电脑上的引擎：在电脑上打开墨阅，确认翻译引擎在跑（设置里能看到 8080），'
        + '然后把接口地址改成那台电脑的局域网地址 —— '
        /* R169：这里原来把「对账列表里第一台」的地址直接拼进提示，既不一定是对的机器，
           也等于把内网 IP 写进界面上让人截图带走。改成只讲「去哪抄」。 */
        + '形如 http://电脑的局域网地址:8080/v1/chat/completions'
        + '（电脑上「设置 → 连到别的设备」第一条「我的地址」就是它）'
        + '；\n'
        + '② 用在线接口：在翻译设置里选一个在线引擎并填 API Key。';
      return new Error(msg + '（原始错误：' + raw + '）');
    }
    if (isLocal) {
      const port = (String(endpoint || '').match(/:(\d+)/) || [])[1] || '';
      // 按所选引擎给对应启动指引，别再把 Ollama 用户指去跑 llama.cpp 脚本（曾误导用户）
      const howToStart = {
        llamaCpp: '请先运行 localmt\\start-llama.ps1（Linux/Mac 用 start-llama.sh）',
        hyMT: '请先启动 Ollama：终端跑 ollama serve，并 ollama pull kaelri/hy-mt2:1.8b-q4_K_M',
        localLLM: '请先启动 Ollama（ollama serve）或 LM Studio，并开启其 OpenAI 兼容服务',
      }[engineId] || '请先启动对应的本地翻译引擎';
      msg = '连不上本地翻译服务（' + endpoint + '）' +
        '：引擎没启动，或端口不对。' + howToStart + '，' +
        '等服务打印出监听 ' + (port ? ':' + port : '端口') + ' 再翻译；' +
        '若改过端口，在面板里把接口地址改成同一个端口。';
      if (typeof location !== 'undefined' && /^file:/i.test(location.href || '')) {
        msg += '（另外：当前页面是双击文件用 file:// 打开的，浏览器会限制访问本地服务，' +
          '建议双击桌面图标打开，它会用本地服务（127.0.0.1:8123）托管本页）';
      } else if (typeof location !== 'undefined' &&
                 !/^(127\.|localhost|\[::1\])$/i.test(location.hostname || '')) {
        // 页面不是通过 127.0.0.1/localhost 打开的（比如用了局域网 IP 或机器名）。
        // 同一台电脑上这么开，127.0.0.1 照样能用；真正连不上的只有「另一台设备」的场景。
        msg += '（注意：当前页面不是通过 127.0.0.1/localhost 打开的。'
          + '如果这个浏览器就跑在装引擎的那台电脑上，保持接口地址用 127.0.0.1 即可；'
          + '如果是在 iPad/手机等另一台设备上打开的，请把接口地址改成引擎电脑的局域网 IP，'
          + '例如 http://电脑的局域网地址:8080/v1/chat/completions）';
      }
    } else {
      msg = '网络请求失败（' + name + ' ' + endpoint + '）：检查网络连接 / 代理 / 接口地址是否可达。';
    }
    const e = new Error(msg + '（原始错误：' + raw + '）');
    e.cause = err;
    return e;
  }

  // ---- 长文本切块 ----
  // 一页正文动辄上千字，整页一次丢给本地 1.8B 模型要 15~60 秒（实测 317 字就要 14.9s），
  // 而且容易撞上 max_tokens 被截断 —— 表现就是「勾了双语但半天没反应」。
  // 切成小块后：① 每块都快，能即时看到进度；② 多块并发，实测 4 段 6.4s → 3.3s。
  const CHUNK_MAX = 320;   // 单块字符上限（中英混排都适用）

  // 兜底硬切：在空格 / 标点处断开，避免把英文单词（如 products）从中间切断 → 否则会被拆成两段分别翻译
  function hardSplit(str, maxLen) {
    const out = [];
    let i = 0;
    while (i < str.length) {
      if (i + maxLen >= str.length) { out.push(str.slice(i)); break; }
      let j = Math.min(i + maxLen, str.length);
      // 从 maxLen 处向左回退到最近的「词边界」（空格 / 中英文标点），保住完整单词。
      // 回退下限设成 60% maxLen：窗口里实在没有边界（无空格长串）时按 maxLen 硬切，
      // 避免退到 i+1 产出「1 个字符」的碎块（会让译文逐字排、也更容易切断单词）。
      const limit = i + Math.max(1, Math.floor(maxLen * 0.6));
      while (j > limit && !/[\s，。！？!?；：,;:、）)】」』—\-]/.test(str[j - 1])) j--;
      if (j <= i) j = i + maxLen;
      out.push(str.slice(i, j));
      i = j;
    }
    return out;
  }

  /** 句子切分：中英文句末标点都算（修「一句话被拆成两段」）。
   *  之前只认 。！？!?… —— **英文句号 . 不在其中**，所以整段英文被当成「一个超长句」，
   *  超过阈值后走 hardSplit 按长度硬切 → 从句子中间断开（用户截图：…they are at / for referencing.）。
   *  这里英文句点要求「点后是空白，且下一个非空白字符是大写/引号/数字/中文」才断，
   *  避免把 3.14、U.S.、Mr. Smith、e.g. 之类切开。 */
  function splitSentences(p) {
    const out = [];
    let start = 0;
    const boundaryAt = (i) => {
      const ch = p[i];
      if ('。！？!?…'.indexOf(ch) >= 0) return true;
      if (ch !== '.') return false;
      let j = i + 1;
      if (j < p.length && !/\s/.test(p[j])) return false;   // 3.14 / U.S. / e.g 内部
      while (j < p.length && /\s/.test(p[j])) j++;
      if (j >= p.length) return true;                       // 段末
      return /[A-Z"'“”‘’(\[0-9\u4e00-\u9fff]/.test(p[j]);
    };
    let i = 0;
    while (i < p.length) {
      if (boundaryAt(i)) {
        let j = i + 1;
        // 吃掉紧跟的闭引号/右括号与空白，句子边界落在它们之后
        while (j < p.length && /["'”’）)\]]/.test(p[j])) j++;
        while (j < p.length && /[ \t]/.test(p[j])) j++;
        out.push(p.slice(start, j));
        start = j;
        i = j;
        continue;
      }
      i++;
    }
    if (start < p.length) out.push(p.slice(start));
    return out.filter(s => s && s.trim());
  }

  function splitForTranslation(text, maxLen) {
    maxLen = maxLen || CHUNK_MAX;
    const chunks = [];
    const push = (s) => { if (s && String(s).trim()) chunks.push(String(s).trim()); };
    String(text == null ? '' : text)
      .split(/\n+/).map((s) => s.trim()).filter(Boolean)
      .forEach((p) => {
        if (p.length <= maxLen) { push(p); return; }
        // 长段按句切开再累积成块（整句进块，绝不从句子中间断）
        let buf = '';
        splitSentences(p).forEach((s) => {
          if (!s) return;
          if (buf && buf.length + s.length > maxLen) { push(buf); buf = ''; }
          buf += s;
        });
        push(buf);
      });
    // 兜底：整段没有句末标点（超长单句 / 无标点古文）→ 按长度切，但尽量在词边界断开
    const out = [];
    chunks.forEach((c) => {
      if (c.length <= maxLen * 1.5) { out.push(c); return; }
      out.push(...hardSplit(c, maxLen));
    });
    // 收尾纠偏：上一块以字母结尾、下一块以小写字母开头 → 同一个英文单词被切断
    // （如 products → "…prod" + "ucts…"），并入上一块，避免把单词拆成两段分别翻译。
    // R80：并回必须有长度上限。以前这条没有任何限制，遇到无空格长串（'a'*1000、
    // 长 URL、base64）会一块接一块地级联并回，1000 字最后变回 1 块，
    // hardSplit 白切了 —— 单块超长送模型会被截断/漏译。
    const MERGE_CAP = Math.floor(maxLen * 1.5);
    const merged = [];
    for (const c of out) {
      const prev = merged.length ? merged[merged.length - 1] : null;
      if (prev && /[A-Za-z]$/.test(prev) && /^[a-z]/.test(c)
          && prev.length + c.length <= MERGE_CAP) merged[merged.length - 1] = prev + c;
      else merged.push(c);
    }
    return merged;
  }

  // 并发跑任务但保持结果顺序（不像 Promise.all 那样一次全放开，limit 控制同时在飞的数量）
  async function mapLimit(items, limit, fn) {
    const n = items.length;
    if (!n) return [];
    const res = new Array(n);
    let idx = 0;
    let failed = null;
    const workers = [];
    for (let w = 0; w < Math.min(limit, n); w++) {
      workers.push((async () => {
        for (;;) {
          const i = idx++;
          if (i >= n) return;
          try { res[i] = await fn(items[i], i); }
          catch (e) { if (!failed) failed = e; return; }
        }
      })());
    }
    await Promise.all(workers);
    if (failed) throw failed;
    return res;
  }

  function makeOpenAICompatProvider(opts) {
    return {
      id: opts.id,
      name: opts.name,
      // online 决定「是否计 AI 额度」和下拉里的「（需联网+Key）」后缀。
      // 本地模型虽然走 HTTP，但是本机/局域网、免费，既不该计额度也不该标成需联网。
      online: opts.online !== false,
      // 这些云端 / OpenAI 兼容引擎都需要用户填 API Key（本地模型不需要）。
      needsKey: opts.online !== false,
      // returnsNames：模型能不能同时吐「译文 + 人名 JSON」。纯翻译模型（Hy-MT2）做不到 → false
      returnsNames: opts.returnsNames !== false,
      // obeyInstructions=false：只听翻译指令、不听「保留原文/输出 JSON」这类附加指令的模型。
      // 这类引擎改走：官方模板全塞 user message + 不翻译名单做占位符物理保护 + 不要求 JSON。
      obeyInstructions: opts.obeyInstructions !== false,
      // placeholderProtect=false：该引擎有原生术语干预能力，不需要（也不应该）把
      // 不翻译名单换成占位符字符 —— 实测会让 Hy-MT2 把主语翻成「他」。
      placeholderProtect: opts.placeholderProtect !== false,
      buildPrompt: opts.buildPrompt || null,   // 自定义 prompt 构造器（Hy-MT2 用）
      userPrompt: opts.userPrompt === true,    // 指令放 user message 而不是 system
      defaultEndpoint: opts.defaultEndpoint,
      defaultModel: opts.defaultModel,
      needsKey: opts.needsKey !== false,
      async translate(text, ctx) {
        if (this.needsKey && (!ctx || !ctx.apiKey)) {
          throw new Error(opts.name + ' 需要 API Key（在面板里填）');
        }
        // Key / 地址 / 模型按引擎各存一份（byEngine），否则填了 OpenAI 的 Key 再切
        // DeepSeek 会拿错凭据。旧存档没有 byEngine 时，才退回顶层那一套。
        const cfg = (ctx && ctx.byEngine && ctx.byEngine[this.id]) || {};
        const isActive = !ctx || !ctx.provider || ctx.provider === this.id;
        const endpoint = cfg.endpoint || (isActive && ctx.endpoint) || opts.defaultEndpoint;
        const model = cfg.model || (isActive && ctx.model) || opts.defaultModel;
        const apiKey = cfg.apiKey || (isActive && ctx.apiKey) || '';
        // 纯翻译模型（obeyInstructions=false）听不懂「保留 XX 原文」，
        // 只能把不翻译名单 / 人名物理换成占位符，翻完再还原。
        const canObey = this.obeyInstructions;
        const askNames = !!(ctx && ctx.askNames) && canObey;
        let srcText = String(text == null ? '' : text);
        let store = [];
        // 只有「不听指令」**且**没有原生术语干预能力的引擎才做占位符保护。
        // Hy-MT2 有原生术语干预（X 翻译成 X）→ 关闭占位符，实测更可靠（见 buildHyMTPrompt）。
        const usePh = !canObey && this.placeholderProtect !== false;
        if (usePh) {
          const pr = protectPhrases(srcText, (ctx && ctx.noTranslate) || []);
          srcText = pr.text;
          store = pr.store;
        }
        const sysPrompt = this.buildPrompt ? this.buildPrompt(ctx) : buildGlossaryPrompt(ctx);
        const body = {
          model: model,
          // 纯翻译模型（obeyInstructions=false，如 Hy-MT2）必须贪心解码：
          // 实测 temperature 0.2 会让它先续写一段英文再翻译，甚至陷入重复循环；
          // 设 0 之后译文干净、且更快。通用大模型仍保留 0.2 的那点灵活性。
          temperature: this.obeyInstructions ? 0.2 : 0,
          messages: this.userPrompt
            ? [{ role: 'user', content: sysPrompt + srcText }]
            : [
              { role: 'system', content: sysPrompt },
              { role: 'user', content: srcText }
            ]
        };
        const send = async (withJsonMode) => {
          const b = Object.assign({}, body);
          // 部分兼容服务支持 JSON 模式（更稳）；不支持的会直接 400，
          // 所以失败时去掉该字段重试一次 —— 反正 prompt 里已经要求返回 JSON 了。
          if (withJsonMode) b.response_format = { type: 'json_object' };
          let resp;
          try {
            resp = await fetch(effectiveEndpoint(endpoint), {
              method: 'POST',
              headers: Object.assign(
                { 'Content-Type': 'application/json' },
                this.needsKey ? { 'Authorization': 'Bearer ' + apiKey } : {}
              ),
              body: JSON.stringify(b)
            });
          } catch (e) {
            // fetch 只有在「根本没连上」时才抛（DNS / 服务没起 / 被拦 / file:// 跨源）。
            // 浏览器给的一律是干巴巴的 "Failed to fetch"，用户完全没法自查，
            // 这里按「本地端点 / 在线端点」分别翻译成能照做的提示。
            throw describeFetchFailure(e, endpoint, opts.name, opts.id);
          }
          if (!resp.ok) {
            const err = new Error(opts.name + ' 返回 ' + resp.status);
            err.status = resp.status;
            try { err.body = (await resp.text()).slice(0, 300); } catch (e) { /* 忽略 */ }
            throw err;
          }
          return resp.json();
        };
        let j;
        try {
          j = await send(askNames);
        } catch (e) {
          // 400/422 常见于「该服务不认 response_format」（DeepSeek 早期、部分本地模型）
          if (askNames && e.status >= 400 && e.status < 500) {
            j = await send(false);
          } else {
            throw e;
          }
        }
        let raw = (j.choices && j.choices[0] && j.choices[0].message.content || '').trim();
        if (!canObey) {
          // 还原占位符（人名 / 不翻译名单）+ 清掉特殊 token 残留
          raw = stripModelNoise(restorePhrases(raw, store));
          // 术语表兜底：模板指令不保证生效，译文里若还留着原词就再替一次。
          // 只替「原文里真的出现过」的词，避免把模型生成的目标语字符误伤。
          raw = applyGlossaryFallback(raw, text, ctx && ctx.glossary);
          return raw;
        }
        if (askNames) {
          const parsed = parseModelJSON(raw);
          if (parsed) return { text: parsed.translation || raw, names: parsed.names || [] };
          // 模型没吐出合规 JSON：降级为纯译文（人名检测这次失败，但不耽误翻译）
          return { text: raw, names: [] };
        }
        return stripModelNoise(raw);
      }
    };
  }

  const openaiProvider = makeOpenAICompatProvider({
    id: 'openai',
    name: 'OpenAI / 兼容接口',
    defaultEndpoint: OPENAI_DEFAULT_ENDPOINT,
    defaultModel: 'gpt-4o-mini',
    needsKey: true
  });

  // 本地模型：Ollama（默认 11434）或 LM Studio（默认 1234）都暴露 OpenAI 兼容接口，
  // 本机跑、免费、数据不出本机。启用后把接口地址填成 localhost 那个即可，模型名按你装的填
  // （Ollama 装：ollama pull qwen2.5；LM Studio 里 Load 一个模型并开 OpenAI 服务）。
  const localLLMProvider = makeOpenAICompatProvider({
    id: 'localLLM',
    name: '本地模型',
    defaultEndpoint: 'http://localhost:11434/v1/chat/completions',
    defaultModel: 'qwen2.5',
    needsKey: false,
    online: false         // 本机/局域网、免费：不计 AI 额度
  });

  // ------------------------------------------------------------------
  // 2c. Hy-MT2（腾讯混元翻译专用模型）—— 目前本地离线的最佳性价比
  //   1.8B / Q4_K_M 约 1.1GB，专为翻译训练，速度远超同尺寸通用模型，
  //   原生支持术语干预与上下文。Ollama 官方库没收录，用社区打包的官方 GGUF：
  //     ollama pull kaelri/hy-mt2:1.8b            (Q6_K, 1.5GB)
  //     ollama pull kaelri/hy-mt2:1.8b-q4_K_M     (1.1GB，推荐)
  //   模型目录固定到安装目录：安装器会设 OLLAMA_MODELS=<安装目录>\models\ollama
  //   ⚠️ 纯翻译模型：翻译之外的指令不可靠 → obeyInstructions=false，
  //      人名 / 不翻译名单走占位符物理保护，人名检测回退到内置名表 + 有道核对。
  // ------------------------------------------------------------------
  const hyMTProvider = makeOpenAICompatProvider({
    id: 'hyMT',
    name: 'Hy-MT2 混元翻译',
    defaultEndpoint: 'http://localhost:11434/v1/chat/completions',
    defaultModel: 'kaelri/hy-mt2:1.8b-q4_K_M',
    needsKey: false,
    online: false,              // 本机跑，免费，不计 AI 额度
    returnsNames: false,        // 吐不出 JSON，人名靠内置名表 + 有道
    obeyInstructions: false,    // 不听附加指令 → 占位符保护 + 官方模板
    userPrompt: true,           // 指令全放 user message（官方建议不用 system）
    buildPrompt: buildHyMTPrompt,
    placeholderProtect: false   // 原生术语干预（X 翻译成 X）比占位符可靠，实测
  });

  // ------------------------------------------------------------------
  // 2c-2. 同一个模型，但用 llama.cpp 便携版跑（**完全不碰 C 盘**）
  //   Ollama 的安装器默认往 C 盘写程序本体 + 日志 + 拉模型时的临时文件；
  //   llama.cpp 官方提供的是免安装的 zip，解压到安装目录直接用，
  //   OpenAI 兼容接口一模一样（llama-server），所以这里只是换个默认端口。
  //   用 tools/setup_local_mt.py 一键装到 localmt/ 下，模型走官方 GGUF。
  //   ⚠️ 同理：纯翻译模型，人名 / 不翻译名单走占位符物理保护。
  // ------------------------------------------------------------------
  const llamaCppProvider = makeOpenAICompatProvider({
    id: 'llamaCpp',
    name: 'Hy-MT2（llama.cpp 便携版）',
    defaultEndpoint: 'http://127.0.0.1:8080/v1/chat/completions',
    defaultModel: 'hy-mt2',        // llama-server 只加载一个模型，这里填什么都行
    needsKey: false,
    online: false,
    returnsNames: false,
    obeyInstructions: false,
    userPrompt: true,
    buildPrompt: buildHyMTPrompt,
    placeholderProtect: false   // 原生术语干预（X 翻译成 X）比占位符可靠，实测
  });

  // OpenAI 兼容服务（Ollama / llama.cpp / LM Studio）的健康检查：GET /health。
  // 本地引擎独有的痛点是「服务没起」，面板里能一眼看出来比等翻译失败再报错友好得多。
  function openAICompatHealth(defaultEndpoint) {
    return async function (endpoint) {
      const base = String(endpoint || defaultEndpoint || '').replace(/\/v1\/.*$/, '');
      try {
        // 局域网打开时同样走 serve.py 同源代理，否则健康检查也会误报「未启动」
        const r = await fetch(effectiveEndpoint(base + '/health'), { cache: 'no-store' });
        if (!r.ok) return null;
        const j = await r.json();
        return { ok: j.status === 'ok' || j.default_generation_settings != null, model: j.model_path || 'llama.cpp' };
      } catch (e) { return { ok: false, model: '', error: e.message }; }
    };
  }

  // 顺手给它一个健康检查（面板里能一眼看出服务起没起）
  llamaCppProvider._health = openAICompatHealth(llamaCppProvider.defaultEndpoint);
  hyMTProvider._health = openAICompatHealth(hyMTProvider.defaultEndpoint);

  // DeepSeek：官方接口就是 OpenAI 兼容的，填 Key 即用，不用手动写地址。
  const deepseekProvider = makeOpenAICompatProvider({
    id: 'deepseek',
    name: 'DeepSeek',
    defaultEndpoint: 'https://api.deepseek.com/chat/completions',
    defaultModel: 'deepseek-chat',
    needsKey: true
  });

  // =====================================================================
  // 2b. 浏览器 / 设备「自带翻译」——先说清楚哪些能借、哪些不能
  //   - 浏览器「翻译扩展」：网页里的 JS **调不到**。扩展跑在更高权限层，页面没有任何
  //     API 能触发它们（除非专门装一个配好 externally_connectable 的扩展并写配套通信）。
  //   - 浏览器「整页翻译」横幅（Chrome / Safari 那个）：同样不可控，JS 最多靠 <html lang>
  //     触发整页，做不到「按段翻译 + 术语表 + 人名保护」。
  //   - 唯一 JS 可调用、且完全本机 + 免费 + 离线的，是 Chrome「内置 AI」的
  //     Translator API（小专家模型跑在本地，Chrome 138+ 已进 stable）。
  //     硬性门槛（Chrome 官方要求，达不到 availability() 就返回 unavailable）：
  //       · 仅桌面：Windows 10+/macOS 13+/Linux/ChromeOS；**手机和 iPad 一律没有**
  //       · 硬件：GPU 显存 >4GB，或 16GB 内存 + 4 核 CPU；磁盘需约 22GB 可用
  //       · 首次使用要下载语言包（几百 MB），downloadable 状态时必须等它下完
  //     所以：**iPad Safari 没有这个 API** —— iPad 要免费用设备自带翻译，得走原生端的
  //     Apple Translation 框架（SwiftUI TranslationSession，iOS 17.4+，本机离线）。
  // =====================================================================
  function chromeLang(code) {
    const c = String(code || '').toLowerCase();
    if (c === 'zh-hant') return 'zh-Hant';
    if (c.indexOf('pt') === 0) return 'pt';
    return c.split('-')[0] || 'en';
  }

  /*
   * Chrome「内置 AI」Translator API 有**两代**形态，而且新旧方法名完全不同：
   *   新（W3C 现行规范，Chrome 138+ 已稳定）：静态类 Translator
   *       Translator.availability({sourceLanguage, targetLanguage})
   *       Translator.create({sourceLanguage, targetLanguage, monitor})
   *   旧（早期 origin trial）：self.translation / self.translator 实例
   *       xxx.canTranslate({...})  /  xxx.createTranslator({...})
   * 之前只按 `self.translator || Translator` 取对象，新浏览器拿到的是 Translator 这个类，
   * 它没有 createTranslator → 直接抛 "T.createTranslator is not a function"。
   * 现在先判形状再调对应的方法。
   */
  function chromeTranslatorAPI() {
    if (typeof self === 'undefined') return null;
    if (typeof Translator !== 'undefined' && Translator) {
      return { shape: 'new', api: Translator, has: (m) => typeof Translator[m] === 'function' };
    }
    const legacy = self.translation || self.translator;
    if (legacy) {
      return { shape: 'legacy', api: legacy, has: (m) => typeof legacy[m] === 'function' };
    }
    return null;
  }

  // 把新旧两版 API 的可用状态归一成 available / downloadable / downloading / unavailable
  // 新规范只有这四个值；旧版 canTranslate 返回 readily / after-download / no。
  function normChromeAvail(v) {
    if (v === 'available' || v === 'readily' || v === true) return 'available';
    if (v === 'downloadable' || v === 'after-download') return 'downloadable';
    if (v === 'downloading') return 'downloading';
    return 'unavailable';
  }

  const chromeTranslatorProvider = {
    id: 'chromeAI',
    name: '浏览器内置翻译',
    online: false,        // 本机跑：不联网、不计 AI 额度
    returnsNames: false,  // 没有 prompt 接口，拿不到「（人名）」标注

    async _avail(ctx) {
      const T = chromeTranslatorAPI();
      if (!T) return 'unsupported';
      const src = (ctx && ctx.sourceLang && ctx.sourceLang !== 'auto') ? chromeLang(ctx.sourceLang) : 'en';
      const tgt = chromeLang((ctx && ctx.targetLang) || 'ZH');
      try {
        if (T.shape === 'new' && T.has('availability')) {
          return normChromeAvail(await T.api.availability({ sourceLanguage: src, targetLanguage: tgt }));
        }
        if (T.has('canTranslate')) {
          return normChromeAvail(await T.api.canTranslate({ sourceLanguage: src, targetLanguage: tgt }));
        }
        if (T.has('availability')) {
          return normChromeAvail(await T.api.availability({ sourceLanguage: src, targetLanguage: tgt }));
        }
      } catch (e) { /* 落到下面 */ }
      return 'unavailable';
    },

    async translate(text, ctx) {
      const T = chromeTranslatorAPI();
      if (!T) {
        throw new Error('当前浏览器没有内置翻译 API：需要 Chrome 138+ 桌面版（Windows/macOS/Linux/ChromeOS），' +
          '且不支持手机与 iPad Safari');
      }
      const src = (ctx && ctx.sourceLang && ctx.sourceLang !== 'auto') ? chromeLang(ctx.sourceLang) : 'en';
      const tgt = chromeLang((ctx && ctx.targetLang) || 'ZH');
      const st = await this._avail(ctx);
      if (st === 'unsupported') {
        throw new Error('当前浏览器不支持内置翻译 API（需要 Chrome 138+ 桌面版；iPad Safari 没有此 API）');
      }
      if (st === 'unavailable') {
        throw new Error('内置翻译不支持 ' + src + ' → ' + tgt +
          '（该语言对不可用，或本机不满足硬件要求：>4GB 显存 / 16GB 内存 + 4 核，且需约 22GB 可用空间）');
      }
      const opts = { sourceLanguage: src, targetLanguage: tgt };
      // 首次调用要下载语言包，给个进度回调（downloadable/downloading 时不给进度，
      // 界面会静默卡住，用户以为挂了）
      if (T.shape === 'new') {
        opts.monitor = (m) => {
          m.addEventListener('downloadprogress', (e) => {
            if (typeof console !== 'undefined') {
              console.log('[内置翻译] 语言包下载 ' + Math.round((e.loaded || 0) * 100) + '%');
            }
          });
        };
      }
      let tr;
      if (T.shape === 'new' && T.has('create')) {
        tr = await T.api.create(opts);
      } else if (T.has('createTranslator')) {
        tr = await T.api.createTranslator(opts);
      } else {
        throw new Error('浏览器有翻译对象但缺少可调用的创建方法（' + T.shape + ' 形态，' +
          'API 可能又变了）——请改用其他引擎');
      }
      if (tr && tr.ready) await tr.ready;   // 首次要等语言包下载完
      let out = await tr.translate(text);
      // 术语表兜底：内置翻译没有 prompt 接口，原文侧的词已被译掉，这里只能在译文侧
      // 做一次替换（保证度不如 DeepL / 本地模型，要用术语表优先选那两个）。
      // 同样只替「原文里真的出现过」的词，避免误伤模型生成的字符。
      return applyGlossaryFallback(out, text, ctx && ctx.glossary);
    }
  };

  // =====================================================================
  // 3. 控制器 InkTranslate（术语表 / 不翻译 / 引擎选择 / 持久化）
  // =====================================================================
  const InkTranslate = {
    LS_KEY: 'ink.translate.v1',
    state: {
      provider: 'mymemory',  // provider id：默认免密钥在线翻译，开箱即用
      apiKey: '',
      deeplFree: true,
      glossaryId: '',        // DeepL glossary id
      endpoint: '',          // （旧存档）OpenAI 兼容接口地址，现已按引擎存进 byEngine
      model: 'gpt-4o-mini',
      // 按引擎分开存 Key / 接口地址 / 模型名：OpenAI 和 DeepSeek、本地模型互不串味。
      // 形如 { openai: { apiKey, endpoint, model }, deepseek: {…} }
      byEngine: {},
      sourceLang: 'auto',    // 源语言：auto / EN / JA / …
      targetLang: 'ZH',      // 目标语言：ZH(简体) / ZH-HANT(繁体) —— 这是「全局默认」
      // 每本书单独的目标语言：{ [bookId]: 'JA' }。某本设了就用这本的，没设回退上面的全局默认。
      // 这样「选日语」只作用于当前这本书，绝不污染全局，也不串到别的书。
      perBookTarget: {},
      autoDetectNames: true, // 自动检测人名并不翻译（自定义术语表优先级更高）
      dictNameCheck: true,   // 用在线词典（有道）的「男子名/人名」标注核对人名
      extraPrompt: '',       // 附加要求（翻译风格/语气/格式等），仅 AI 引擎生效
      inlineBilingual: false,// 原大屏双语：在正文每句下方插入译文
      inlineFollowPanel: false, // 正文只显示「小窗译过的段落」，滚到没译过的地方不自动翻
      quotaEnabled: false,   // 是否启用 AI 额度上限（仅在线引擎计）
      quotaLimit: 50000,     // 每日字符上限（源文本字符数）
      quotaUsed: 0,          // 今日已用
      quotaDate: '',         // 额度所属日期（跨天自动清零）
      glossary: [],          // [{ src, dst }]
      noTranslate: [],       // [string]
      autoNamesEdit: null    // 用户在「自动检测人名框」里手动改过的名单；null=未改，跟随 lastAutoNames
    },

    lastAutoNames: [],       // 最近一次翻译自动检测到的人名（UI 展示用）

    load() {
      try {
        const raw = (typeof localStorage !== 'undefined') && localStorage.getItem(this.LS_KEY);
        if (raw) Object.assign(this.state, JSON.parse(raw));
      } catch (e) { /* 忽略损坏的本地配置 */ }
      if (!this.state.byEngine || typeof this.state.byEngine !== 'object') this.state.byEngine = {};
      // 旧存档迁移：顶层那一份 apiKey / endpoint / model 归到当前引擎名下，
      // 这样升级上来的人不用重新填一遍（之后新填的都写进 byEngine）。
      const cur = this.state.provider;
      if (cur && !this.state.byEngine[cur]) {
        const old = {};
        if (this.state.apiKey) old.apiKey = this.state.apiKey;
        if (this.state.endpoint) old.endpoint = this.state.endpoint;
        if (this.state.model) old.model = this.state.model;
        if (Object.keys(old).length) this.state.byEngine[cur] = old;
      }
    },

    save() {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(this.LS_KEY, JSON.stringify(this.state));
        }
      } catch (e) { /* 隐私模式等场景忽略 */ }
    },

    // 只在「真的变了」时才清缓存：面板每次点翻译都会 syncGlossaryFromUI()，
    // 每次都清的话，第二次点同一页又得重翻一遍（等于缓存白做）。
    setProvider(id) { const old = this.state.provider; this.state.provider = id; this.save(); if (old !== id) this.dropMemo(); },

    // 某个引擎自己的配置（Key / 接口地址 / 模型名），没有就建一个空壳
    engineCfg(id) {
      if (!this.state.byEngine || typeof this.state.byEngine !== 'object') this.state.byEngine = {};
      if (!this.state.byEngine[id]) this.state.byEngine[id] = {};
      return this.state.byEngine[id];
    },
    setEngineField(id, key, val) {
      this.engineCfg(id)[key] = String(val || '').trim();
      this.save();
    },
    setGlossary(list) {
      const a = JSON.stringify(this.state.glossary || []), b = JSON.stringify(list || []);
      this.state.glossary = list; this.save(); if (a !== b) this.dropMemo();
    },
    setNoTranslate(list) {
      const a = JSON.stringify(this.state.noTranslate || []), b = JSON.stringify(list || []);
      this.state.noTranslate = list; this.save(); if (a !== b) this.dropMemo();
    },
    setSourceLang(c) { this.state.sourceLang = c; this.save(); },
    // 每本书单独的**源**语言：OCR 认的是日文，就把这本的源语言写成 JA，
    // 不靠引擎 auto 猜（小语种 / 竖排漫画 auto 经常猜成中文，翻出来一塌糊涂）。
    // 与 perBookTarget 一个套路：只影响这本书，不动全局默认。
    getBookSourceLang() {
      const id = this.bookKey();
      if (id && this.state.perBookSource && this.state.perBookSource[id]) return this.state.perBookSource[id];
      return this.state.sourceLang || 'auto';
    },
    setBookSourceLang(c) {
      const id = this.bookKey();
      if (!id) { this.setSourceLang(c); return; }
      if (!this.state.perBookSource) this.state.perBookSource = {};
      const old = this.state.perBookSource[id];
      this.state.perBookSource[id] = c;
      this.save();
      if (old !== c) this.dropMemo();
    },
    setTargetLang(c) { const old = this.state.targetLang; this.state.targetLang = c; this.save(); if (old !== c) this.dropMemo(); },
    // 每本书单独的目标语言：只作用于当前这本书，不改全局默认。
    // 切书 / 关书后这本的设定仍保留（下次开同一本还是它），但全局 targetLang 永远不被污染。
    bookKey() {
      try {
        const R = (typeof getBook === 'function') ? getBook() : null;
        return (R && R.book && R.book.id) ? R.book.id : null;
      } catch (e) { return null; }
    },
    // 当前生效的目标语言：有这本书的单独设定就用它，否则用全局默认。
    getBookTargetLang() {
      const id = this.bookKey();
      if (id && this.state.perBookTarget && this.state.perBookTarget[id]) return this.state.perBookTarget[id];
      return this.state.targetLang || 'ZH';
    },
    setBookTargetLang(c) {
      const id = this.bookKey();
      if (!id) { this.setTargetLang(c); return; }   // 没开书时降级为改全局默认
      if (!this.state.perBookTarget) this.state.perBookTarget = {};
      const old = this.state.perBookTarget[id];
      this.state.perBookTarget[id] = c;
      this.save();
      if (old !== c) this.dropMemo();
    },
    resetBookTargetLang() {
      const id = this.bookKey();
      if (id && this.state.perBookTarget) { delete this.state.perBookTarget[id]; this.save(); }
    },
    setAutoDetectNames(b) { this.state.autoDetectNames = !!b; this.save(); },
    setDictNameCheck(b) { this.state.dictNameCheck = !!b; this.save(); },
    setExtraPrompt(s) {
      const v = String(s || ''); const old = this.state.extraPrompt || '';
      this.state.extraPrompt = v; this.save(); if (old !== v) this.dropMemo();
    },
    setInlineBilingual(b) {
      this.state.inlineBilingual = !!b;
      this.save();
      // R132（第 3 条）：关掉正文译文 = 正文那批在途请求已经没人要了，
      // 账要一起划掉，「翻译中」立刻灭（否则得等它们全部返回）。
      if (!this.state.inlineBilingual) this.dropInlineBusy();
    },
    setInlineFollowPanel(b) {
      const was = !!this.state.inlineFollowPanel;
      this.state.inlineFollowPanel = !!b;
      this.save();
      // 勾上「只显示小窗已译的段落」同理：正文不再自动补译，在途那一批作废
      if (!was && this.state.inlineFollowPanel) this.dropInlineBusy();
    },
    /** 只划掉「正文补译」那一类在途账；面板自己的「翻译本页 / 全书」照旧亮着 */
    dropInlineBusy() {
      if (typeof global !== 'undefined' && typeof global.__inkTrBusyDrop === 'function') {
        global.__inkTrBusyDrop('inline');
      }
    },
    // 换引擎 / 语言 / 术语表后，旧的「已译缓存」不能再复用（否则改了词表也不生效）
    dropMemo() { if (typeof global !== 'undefined' && typeof global.__inkDropMemo === 'function') global.__inkDropMemo(); },

    // 自动检测人名框：用户在里面改过的名单（改名 / 删除）。
    // 关键区分：null = 没改过（跟随自动检测）；[] = 用户把名字全删了（要真的生效、保持为空）。
    // 早期版本把空数组当「放弃编辑」存成 null，导致「删掉最后一个名字就自动恢复」——已修。
    setAutoNamesEdit(list) {
      this.state.autoNamesEdit = Array.isArray(list) ? list.slice() : null;
      this.save();
    },
    // 恢复：清掉手动编辑，下次翻译用自动检测结果重新填充
    restoreAutoNames() { this.state.autoNamesEdit = null; this.save(); },
    setQuotaEnabled(b) { this.state.quotaEnabled = !!b; this.save(); },
    setQuotaLimit(n) { this.state.quotaLimit = n > 0 ? n : this.state.quotaLimit; this.save(); },

    activeProvider() {
      return InkPlugins.getProvider(this.state.provider) || localGlossary;
    },

    // 跨天自动把额度清零
    _rolloverQuota() {
      const today = new Date().toISOString().slice(0, 10);
      if (this.state.quotaDate !== today) {
        this.state.quotaUsed = 0;
        this.state.quotaDate = today;
        this.save();
      }
    },

    // 额度信息（未启用返回 null）；仅在线引擎计额度，本地离线免费
    quotaInfo() {
      if (!this.state.quotaEnabled) return null;
      this._rolloverQuota();
      return { used: this.state.quotaUsed, limit: this.state.quotaLimit };
    },

    // 组装翻译上下文（术语表 / 不翻译 / 译名表 / 人名检测开关）。
    // 人名来源分两条路（见 detectKnownNames 的注释）：
    //   - AI 引擎：ctx.askNames=true，由模型标（人名）并返回 names，翻译后再回填
    //     lastAutoNames（之所以不能在这里预填，是因为 AI 的人名要翻译完才知道）；
    //   - 离线 / DeepL：拿不到标注，只认内置常见名表，翻译后由 detectKnownNames 回填。
    // 另外把「全大写缩写」并入不翻译名单（US / CEO / THBT 这类保留原文）。
    _mergeContext(text, rawKnown) {
      const ctx = Object.assign({}, this.state);
      // 每本书可单独设目标语言：当前书的设定优先，否则用全局默认。
      // 这样「选日语」只影响当前这本书，不污染全局、不串到别的书。
      ctx.targetLang = this.getBookTargetLang();
      ctx.sourceLang = this.getBookSourceLang();
      // 没手动指定源语言时，按这段文字本身判断（OCR 日文漫画 → JA，别再让引擎 auto 猜成中文）
      if (!ctx.sourceLang || ctx.sourceLang === 'auto') {
        const g = guessSrcLang(text);
        // 中文原文翻成中文没意义（多半是没识别对），这种情况还是交给引擎自己看
        if (!(g === 'ZH' && (ctx.targetLang === 'ZH' || ctx.targetLang === 'ZH-HANT'))) ctx.sourceLang = g;
      }
      ctx.nameTrans = {};
      ctx.askNames = false;
      ctx.knownNames = [];
      if (this.state.autoDetectNames && /[A-Za-z]/.test(text || '')) {
        ctx.askNames = true;
        const glossarySrc = new Set((this.state.glossary || []).map((g) => g.src));
        const noTr = (this.state.noTranslate || []).slice();

        // 1) 全大写缩写 / 机构名 → 原样保留（用户明确要求保留这条规则）
        protectAllCaps(text).forEach((w) => {
          if (!noTr.includes(w)) noTr.push(w);
        });

        // 2) 人名名单：**名单里的名字 = 保留原文、不翻译**（这才是「自动检测人名（不翻译）」
        //    的本意；之前写成「翻成译名」是反的 —— 留着反而被翻译、删掉反而保留原文）。
        //    用户改过就用改过的，否则用自动检测的；这里是「覆盖」不是「叠加」，
        //    否则删掉的名字会被自动检测又捡回来（正是「删掉最后一个又变回来」的根因）。
        const edited = this.state.autoNamesEdit;
        const isEdited = Array.isArray(edited);
        // rawKnown = 内置名表认出的 + 在线词典（有道）核对出来的
        const known = (rawKnown || detectKnownNames(text)).filter((n) => !glossarySrc.has(n));
        const eff = isEdited ? edited : known;
        eff.forEach((nm) => {
          if (!noTr.includes(nm)) noTr.push(nm); // 名单内 → 原样保留，不翻译
        });

        // 3) 名单外、但系统识别过的人名（= 用户从名单里删掉的）→ 说明他不想保留原文，
        //    那就正常翻译。离线引擎没有音译能力，用内置名表 / 有道给的中译名兜底，
        //    否则「删掉」在离线模式下看不出任何效果（词仍以英文原样出现）。
        const dropped = known.filter((nm) => eff.indexOf(nm) < 0 && !noTr.includes(nm));
        dropped.forEach((nm) => {
          const low = nm.toLowerCase();
          const zh = NAME_TRANS[low] || (_nameCache[nm] && _nameCache[nm].zh) || '';
          if (zh) ctx.nameTrans[nm] = zh; // 正常翻译（音译），不加「（人名）」标记
        });

        // 关键：算好的名单要写回 ctx，否则 provider（含 AI 的 prompt）根本收不到
        ctx.noTranslate = noTr;
        // 给 AI 的两个名单同样用生效的那份，保证删除/改名对模型也生效
        ctx.keepNames = eff.slice();    // 保留原文
        ctx.dropNames = dropped.slice(); // 不是人名，正常翻译
        ctx.knownNames = eff.slice();    // 兼容旧字段（插件可能读它）
      }
      return ctx;
    },

    // 拿候选词去在线词典（有道）核对是不是人名。命中结果缓存在 _nameCache，
    // 同一个名字全书只查一次。无代理 / 断网时每次都返回 false，自动降级。
    async _resolveDictNames(text) {
      // 「名+姓」组合是更强的人名信号，且词典对全名常有专门条目 → 优先查，
      // 别让 12 次的预算被一堆单个词占满（实测这正是 Leonardo 漏掉的原因之一）。
      const all = candidateNames(text);
      const pairs = all.filter((w) => /\s/.test(w));
      const singles = all.filter((w) => !/\s/.test(w));
      const cands = pairs.concat(singles).slice(0, MAX_DICT_LOOKUPS);
      const confirmed = [];
      for (const w of cands) {
        if (Object.prototype.hasOwnProperty.call(_nameCache, w)) {
          if (_nameCache[w].isPerson) confirmed.push(w);
          continue;
        }
        const r = await dictLookupName(w);
        if (r.isPerson) confirmed.push(w);
      }
      return confirmed;
    },

    // 单段翻译。opts.accumulate=true 时不清空 lastAutoNames（全书翻译要跨段累积人名）。
    /** R131（第 5 条）：最底层的「单段翻译」入口 —— 面板的「翻译本页 / 全书」直接调它，
     *  不经过 _requestChunk，所以「翻译中…」指示灯得在这里也记一笔。
     *  面板模块加载后会把 __inkTrBusyBegin/End 挂到 global 上（见 _busyBegin）。 */
    async translateParagraph(text, opts) {
      const bb = (typeof global !== 'undefined' && global.__inkTrBusyBegin) || null;
      const be = (typeof global !== 'undefined' && global.__inkTrBusyEnd) || null;
      if (!bb) return this._tpInner(text, opts);
      // R132（第 3 条）：带 tag 记账 —— 正文实时补译的那一批在用户取消勾选/翻页后作废，
      // 面板自己的「翻译本页 / 全书」不受影响（见 _busyDrop）。
      const id = bb((opts && opts.busyTag) || 'panel');
      try { return await this._tpInner(text, opts); }
      finally { if (be) be(id); }
    },
    async _tpInner(text, opts) {
      opts = opts || {};
      if (!opts.accumulate) this.lastAutoNames = [];
      const provider = this.activeProvider();
      // 在线词典核对人名（在组装 ctx 之前做，因为名单要写进 noTranslate / nameTrans）
      let dictConfirmed = [];
      if (this.state.autoDetectNames && this.state.dictNameCheck && /[A-Za-z]/.test(text || '')) {
        dictConfirmed = await this._resolveDictNames(text);
      }
      const glossarySrc = new Set((this.state.glossary || []).map((g) => g.src));
      const rawKnown = [];
      detectKnownNames(text).concat(dictConfirmed).forEach((n) => {
        if (n && !glossarySrc.has(n) && rawKnown.indexOf(n) < 0) rawKnown.push(n);
      });
      const ctx = this._mergeContext(text, rawKnown);
      // 上下文感知（Hy-MT2 官方模板）：把上一段译文传进去，代词/术语翻得更连贯。
      // 只取末尾一段长度，避免 prompt 越来越长。
      if (opts.context) ctx.context = String(opts.context).slice(-200);
      // AI 额度上限：只对在线引擎计（本地离线免费，不限）
      if (provider.online && this.state.quotaEnabled) {
        this._rolloverQuota();
        if (this.state.quotaUsed >= this.state.quotaLimit) {
          throw new Error('已达 AI 翻译额度上限（今日 ' + this.state.quotaUsed + '/' +
            this.state.quotaLimit + ' 字符，明日自动重置，或到面板调高上限）');
        }
      }
      const res = await provider.translate(text, ctx);
      let out;
      let names = null;
      // AI 引擎（returnsNames）开启人名检测时返回 { text, names }；其余返回纯字符串
      if (provider.returnsNames && ctx.askNames && res && typeof res === 'object') {
        out = res.text;
        names = Array.isArray(res.names) ? res.names : [];
      } else {
        out = res;
        // 离线 / DeepL：内置名表 + 在线词典核对的结果（AI 的人名由模型自己给）
        if (ctx.askNames) names = rawKnown;
      }
      if (names && this.state.autoDetectNames) {
        names.forEach((n) => {
          if (n && this.lastAutoNames.indexOf(n) < 0) this.lastAutoNames.push(n);
        });
      }
      if (provider.online && this.state.quotaEnabled) {
        this.state.quotaUsed += (text ? String(text).length : 0);
        this.save();
      }
      return out;
    },

    // 把整段正文拆成「段」逐段翻译（去空行）。返回 [{src, dst}]
    // ⚠️ 必须经 splitForTranslation 再切一次：实测 Hy-MT2 遇到大段（>300 字）会
    //   只译第一句就自己吐 EOS（2693 字 → 输出 68 字，finish_reason=stop，不是被截断），
    //   表现就是「翻译本页只出一段」。切开后每块都能完整译出。
    //   这里保持串行 + 上下文传递（上一段译文喂给下一段），连贯性优先；
    //   要速度的场景（双语对照）走 translateChunked 的并发版。
    // opts.shouldStop()：返回 true 就立刻停（面板「停止」按钮），已译完的部分照常返回。
    async translateBook(text, onProgress, opts) {
      const paras = splitForTranslation(text);
      const out = [];
      this.lastAutoNames = [];   // 全书翻译：人名跨段累积
      let prevDst = '';
      for (let i = 0; i < paras.length; i++) {
        if (opts && typeof opts.shouldStop === 'function' && opts.shouldStop()) break;
        const dst = await this.translateParagraph(paras[i], {
          accumulate: true,
          context: prevDst,           // 上一段译文 → 上下文感知（纯翻译模型尤其吃这个）
          busyTag: opts && opts.busyTag   // R132：PDF/漫画页下译文是 inline 活，跟着正文一起作废
        });
        prevDst = dst;
        out.push({ src: paras[i], dst: dst });
        // 每译完一段就回调一次（调用方据此把译文一段段显示出来，不用等全部翻完）
        if (onProgress) onProgress(i + 1, paras.length, out);
      }
      return out;
    },

    // 分块并发翻译整页 / 整章文本，返回拼好的译文（块之间空一行）。
    // 比 translateBook 快一倍左右（实测 4 块 6.4s→3.3s），代价是块之间没有上下文传递
    // —— 双语对照这种「看得见就行」的场景划算；全书翻译仍走 translateBook（要连贯）。
    chunkConcurrency() {
      const p = this.activeProvider();
      return p && p.online ? 3 : 4;   // 在线引擎保守些，避免触发限流
    },

    async translateChunked(text, onProgress, opts) {
      opts = opts || {};
      const chunks = splitForTranslation(text, opts.maxLen || CHUNK_MAX);
      if (!chunks.length) return '';
      const limit = opts.concurrency || this.chunkConcurrency();
      this.lastAutoNames = [];        // 与 translateBook 一致：跨块累积人名
      let done = 0;
      const run = async (n) => (
        await mapLimit(chunks, n, async (c) => {
          const dst = await this.translateParagraph(c, { accumulate: true });
          done++;
          if (onProgress) onProgress(done, chunks.length);
          return dst;
        })
      ).join('\n\n');
      try {
        return await run(limit);
      } catch (e) {
        // 并发时个别服务端（Ollama 单槽、限流的在线接口）会拒绝后来的请求，
        // 遇到就退成串行重跑一次 —— 慢但能出结果，好过直接报错。
        if (limit > 1) {
          done = 0;
          return await run(1);
        }
        throw e;
      }
    }
  };

  /* ------------------------------------------------------------------
   * R171：本机离线翻译（手机自己翻，不需要电脑）
   *   —— 这是「电脑不打开就翻译不了」的正解。
   *   模型是 OPUS-MT（Marian 77M，8bit 量化，一个方向约 110 MB），
   *   推理用 onnxruntime-web（和 PaddleOCR 共用同一份 wasm 运行时）。
   *   质量：比在线大模型差一截（新闻语料训的），但比「翻不了」强，
   *   而且完全离线、免费、不用 API Key。
   *
   *   appOnly：只在 APK 里露面（用户明确说 Web 端先不动；
   *   桌面自测用 ?ort=1 打开能看到）。
   * ------------------------------------------------------------------ */
  const offlineMTProvider = {
    id: 'offlineMT',
    name: '本机离线翻译（手机自己翻）',
    appOnly: true,
    online: false,          // 本机跑，免费，不计 AI 额度
    needsKey: false,
    returnsNames: false,
    obeyInstructions: false,
    async translate(text, ctx) {
      if (typeof MtLocal === 'undefined') throw new Error('本机离线翻译模块没加载（js/mt-local.js）');
      const src = (ctx && ctx.sourceLang) || 'auto';
      const tgt = (ctx && ctx.targetLang) || 'ZH';
      /* R172：`pairOf('auto','ZH')` 以前拼出 `au-zh`（取前两个字母），
         请求 /api/mt-local/file?pair=au-zh → 400，用户看到「部分段落失败」。
         现在 pairOf 只认真能翻的方向，认不出的回空串，这里再按正文补一次判断。
         R173：判断范围从「中/英」扩到「中/英/日/韩/俄」—— 加了模型就得认全，
         否则日文原文会被当成「既不是中文也不是英文」。 */
      const NAME = { zh: '中文', en: '英文', ja: '日文', ko: '韩文', ru: '俄文' };
      const T = MtLocal.langOf(tgt) || 'zh';
      let S = MtLocal.langOf(src);
      let guessed = false;
      if (!S) {
        const s = String(text || '');
        if (/[\u3040-\u309f\u30a0-\u30ff]/.test(s)) S = 'ja';      // 平假名 / 片假名
        else if (/[\uac00-\ud7af]/.test(s)) S = 'ko';              // 谚文
        else if (/[\u0400-\u04ff]/.test(s)) S = 'ru';              // 西里尔
        else if (/[\u4e00-\u9fff]/.test(s)) S = 'zh';
        else if (/[A-Za-z]{2,}/.test(s)) S = 'en';
        guessed = true;
      }
      const pair = MtLocal.pairOf(S, T);
      if (!pair) {
        if (S && S === T) throw new Error('本机离线翻译：源语言和目标语言一样，不用翻');
        /* 说人话：既说清「检测到的是什么」，也说清「到底能翻哪些」。
           以前这里写死「只做了中文 ↔ 英文」，加了日/韩/俄之后这句话本身就成了谎。 */
        const can = '中文↔英文、日/韩/俄→英文、日/韩/俄→中文（经英文转一次）';
        const who = (guessed ? '这段文字看起来是' : '当前选的是')
          + (NAME[S] || src || '这种语言') + ' → ' + (NAME[T] || tgt);
        throw new Error('本机离线翻译做不了「' + who + '」。现在能翻：' + can
          + '；这一对得换「连电脑」那几档');
      }
      const base = '/api/mt-local/file?pair=' + encodeURIComponent(pair) + '&name=';
      MtLocal.configure(base, pair);
      try {
        return await MtLocal.translate(text, { pair });
      } catch (e) {
        const m = String((e && e.message) || e);
        if (/404|还没下载/.test(m)) {
          const plan = (MtLocal.PLANS && MtLocal.PLANS[pair]) || [pair];
          const need = plan.length > 1
            ? '（要 ' + plan.join(' + ') + ' 两套，约 220 MB）'
            : '（约 110 MB）';
          throw new Error('本机还没下载「' + pair + '」的离线模型' + need
            + '。在翻译面板下面点「下载离线模型」，下完就能离线翻，不用开电脑。');
        }
        throw new Error('本机离线翻译失败：' + m);
      }
    }
  };

  // 注册内置 provider
  /* 顺序 = 下拉框顺序。R171 按用户要求调过：
     「本机离线」排最前（手机上的默认选择），
     「连电脑」那三个（llamaCpp / hyMT / localLLM）挪到**最下面**当兜底。 */
  InkPlugins.registerProvider(offlineMTProvider);
  InkPlugins.registerProvider(localGlossary);
  InkPlugins.registerProvider(myMemoryProvider);
  InkPlugins.registerProvider(deeplProvider);
  InkPlugins.registerProvider(openaiProvider);
  InkPlugins.registerProvider(deepseekProvider);
  InkPlugins.registerProvider(chromeTranslatorProvider);
  // ↓ 这三条在电脑上指本机引擎，在手机上等于「连电脑」——放最后
  InkPlugins.registerProvider(localLLMProvider);
  InkPlugins.registerProvider(hyMTProvider);
  InkPlugins.registerProvider(llamaCppProvider);

  // 暴露到全局，方便控制台调试 / 原生端 / 插件复用
  global.InkPlugins = InkPlugins;
  global.InkTranslate = InkTranslate;
  // 切块器单独暴露，供自动测试断言「不切断句子/单词」（不参与 UI 逻辑）
  InkTranslate.__splitForTranslation = splitForTranslation;
  InkTranslate.__splitSentences = splitSentences;

  // 本地可安装引擎的「安装计划」——选了但没装时，确认弹窗按这里展示：
  // 模型名 / 安装位置 / 预计占用（GB）。
  // 落点一律**跟着当前在服务的那棵树**：安装版 → <安装目录>；源码树 → 同一棵树（开发用）。
  // 真实绝对路径由接口回报（见 inkInstallWhere），这里只是没拿到时的兜底文案。
  const ENGINE_INSTALL = {
    llamaCpp: {
      which: 'portable',
      engineName: 'Hy-MT2（llama.cpp 便携版）',
      model: 'Hy-MT2-1.8B-Q4_K_M.gguf',
      where: '安装目录 localmt\\（引擎）+ localmt\\models\\（模型）',
      modelGB: 1.13,
      programGB: 0,
      note: '全部在安装目录内，不碰 C 盘；纯标准库下载，支持断点续传。'
    },
    hyMT: {
      which: 'ollama',
      engineName: 'Hy-MT2 混元（Ollama 本地版）',
      model: 'kaelri/hy-mt2:1.8b-q4_K_M',
      where: '安装目录 models\\ollama（模型）',
      // Ollama 官方安装器决定程序本体的落点，寻常在用户目录（C 盘）。
      // 真实路径由 /api/engine-path 回报，这里只是没拿到时的兜底文案。
      programWhere: 'C:\\Users\\<用户名>\\AppData\\Local\\Programs\\Ollama',
      modelGB: 1.1,
      programGB: 1.6,
      note: '模型写在安装目录；Ollama 官方安装器把程序本体装到 C 盘（约 1.6 GB）。'
        + '装完可以只卸载模型、不必卸载墨阅；想连 C 盘的程序本体一起卸，在卸载框里勾上那一项即可。'
    }
  };
  function engineInstallPlan(id) { return ENGINE_INSTALL[id] || null; }

  // 后端回报的真实安装目录（从引擎状态里的绝对路径反推，拿不到就问 /api/root）。
  // 用途：确认安装框 / 手动模式提示显示「到底下到哪儿」，别让用户猜是安装目录还是开发目录。
  let _inkRoot = '';
  function _rememberRoot(p) {
    if (!p) return;
    const m = String(p).match(/^(.*?)[\\\/](?:localmt|models|data(?:-dev)?|tools)[\\\/]/i);
    if (m && m[1]) _inkRoot = m[1];
  }
  function _probeRoot(cb) {
    if (_inkRoot) { if (cb) cb(_inkRoot); return; }
    fetch('/api/root', { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : ''))
      // /api/root 回的就是安装目录本身（不是文件路径），直接采用
      .then((t) => { const s = (t || '').trim(); if (s) _inkRoot = s; if (cb) cb(_inkRoot); })
      .catch(() => { if (cb) cb(''); });
  }
  // 当前服务是否跑在系统临时目录（%TEMP%）里。
  // 踩过的坑：便携包被解压到 %TEMP%\InkReader_stage_* 就地运行，桌面快捷方式和
  // inkreader:// 协议都指到那儿，服务 ROOT 也就成了临时目录 —— 这时装 1.1GB 模型
  // 等于往垃圾桶里倒（重启或磁盘清理就没了）。所以这里必须能识别并警告。
  function isTempRoot(p) {
    if (!p) return false;
    const s = String(p).replace(/\//g, '\\');
    return /\\AppData\\Local\\Temp(\\|$)/i.test(s) || /^\\\\?tmp(\\|$)/i.test(s);
  }
  function renderTempWarn(root) {
    const box = document.getElementById('tpTempWarn');
    if (!box) return;
    if (isTempRoot(root === undefined ? _inkRoot : root)) {
      box.style.cssText = 'color:var(--ios-red,#ff3b30);margin-top:6px;line-height:1.55';
      box.textContent = '⚠️ 当前服务跑在系统临时目录（%TEMP%），重启或磁盘清理后这里的东西会消失，'
        + '1.1 GB 模型会白下。请先关掉本页，双击桌面的「InkReader」图标（安装目录版）打开，再回来安装。';
    } else {
      box.style.cssText = '';
      box.textContent = '';
    }
  }
  function inkInstallWhere(plan) {
    if (!plan) return '';
    const tail = (plan.which === 'ollama')
      ? '\\models\\ollama（模型）'
      : '\\localmt\\（引擎 + models\\ 模型）';
    if (!_inkRoot) return plan.where;
    // 末尾缀一句，让「装到临时目录」这件事在地址行本身就看得见
    return _inkRoot + tail + (isTempRoot(_inkRoot) ? '（⚠ 临时目录，不建议在此安装）' : '');
  }
  function inkRootText() { return _inkRoot ? '「' + _inkRoot + '」' : '安装目录'; }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      InkPlugins, InkTranslate, applyLocal, MINI_ENZH,
      detectKnownNames, protectAllCaps, parseModelJSON,
      dictLookupName, candidateNames,
      openaiProvider, localLLMProvider, deepseekProvider, hyMTProvider,
      llamaCppProvider, chromeTranslatorProvider,
      protectPhrases, restorePhrases, stripModelNoise, applyGlossaryFallback,
      buildGlossaryPrompt, buildHyMTPrompt,
      splitForTranslation, mapLimit, describeFetchFailure, CHUNK_MAX,
      SOURCE_LANGS, TARGET_LANGS,
      ENGINE_INSTALL, engineInstallPlan
    };
  }

  // 只有浏览器才绑定 UI
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initTranslateUI);
    } else {
      initTranslateUI();
    }
  }

  // =====================================================================
  // 4. UI：阅读器里插「翻译」按钮 + 右侧对照面板（全部用 JS 建，不动 reader.js）
  // =====================================================================
  function initTranslateUI() {
    InkTranslate.load();

    // 本地引擎「后台安装」状态机变量：必须在任何可能访问它们的函数
    // （如 updateEngineStatus，initTranslateUI 内较早处就会调用）之前声明，
    // 否则 let 的暂时性死区（TDZ）会在页面加载时报
    // "Cannot access '_bgInstallActive before initialization"。
    let _installAbort = null;
    let _installRunning = false;
    let _bgInstallActive = false;
    let _bgInstallPct = 0;
    let _bgInstallPlan = null;
    let _statusToken = 0;   // 并发防护：只认最新一次检测的结果，避免旧响应覆盖新状态
    let _installWatchdog = null;
    let _lastInstallActivity = 0;
    let _installReattaching = false;   // 重接管 SSE 的并发守卫
    let _installOwned = false;         // 本页是否自己发起了这次安装（决定关页是否回滚）
    let _installAborted = false;       // 关页回滚只发一次
    let _unloadGuardAttached = false;  // beforeunload 回滚守卫只挂一次

    // ---- 1) 顶栏插按钮 ----
    const actions = document.querySelector('#topBar .bar-actions');
    const btn = document.createElement('button');
    btn.className = 'bar-btn';
    btn.id = 'translateBtn';
    btn.textContent = '🌐 翻译';
    btn.title = '全文翻译 / 术语表 / 插件';
    if (actions) actions.insertBefore(btn, actions.lastElementChild);
    // 面板默认用 .open 类控制滑入/滑出（position:fixed，关掉时移出屏幕），
    // 不要用 hidden 属性——它的 [hidden]{display:none!important} 会把面板彻底藏死。
    btn.addEventListener('click', () => {
      panel.classList.toggle('open');
      const opened = panel.classList.contains('open');
      if (opened) {
        // R130（第 4 条）：每次打开面板都**重新检测一次引擎**。
        // 以前只在页面加载时检测过一次，「上次遗留的 hy-mt2」再打开面板时状态是旧的，
        // 既不显示「检测中…」也不更新，用户必须点别的引擎再点回来才触发一次检测。
        try { syncKeyRow(); } catch (e) { }
        try { updateEngineStatus(true); } catch (e) { }
        try { mtRefresh(); } catch (e) { }        // R171：离线模型装没装，每次打开都刷一遍
      }
      // 打开面板时如果已经开着「原文下方显示译文」，补一次正文嵌入：
      // 勾选状态是持久化的，但页面加载后没人触发过 renderInlineForPage
      // → 用户看到「对照结果有译文、正文里却没有」，以为功能没生效（实测反馈）。
      if (opened && InkTranslate.state.inlineBilingual) {
        setTimeout(() => { try { renderInlineForPage(); } catch (e) {} }, 80);
      }
    });

    // ---- 2) 右侧面板 ----
    const panel = document.createElement('aside');
    panel.className = 'translate-panel';
    panel.innerHTML = `
      <div class="tp-head">
        <span>🌐 全文翻译</span>
        <button class="tp-close" id="tpClose" title="关闭">✕</button>
      </div>
      <div class="tp-body">
        <div class="tp-row">
          <label>翻译引擎</label>
          <select id="tpEngine"></select>
          <div class="tp-engine-status" id="tpEngineStatus" hidden></div>
        </div>
        <div class="tp-row">
          <label>源语言</label>
          <select id="tpSource"></select>
        </div>
        <div class="tp-row">
          <label>目标语言</label>
          <select id="tpTarget"></select>
        </div>
        <div class="tp-row tp-check">
          <label><input type="checkbox" id="tpAutoName"> 自动检测人名（不翻译）</label>
        </div>
        <div class="tp-row tp-check">
          <label><input type="checkbox" id="tpDictName"> 用在线词典（有道）核对人名</label>
        </div>
        <div class="tp-row tp-check">
          <label><input type="checkbox" id="tpInline"> 原文下方显示译文（原大屏双语对照）</label>
        </div>
        <div class="tp-row tp-check">
          <label><input type="checkbox" id="tpFollow"> 只显示小窗已译的段落（不自动补译）</label>
        </div>
        <div class="tp-row" id="tpKeyRow" hidden>
          <label id="tpKeyLabel">API Key</label>
          <input type="password" id="tpKey" placeholder="填入对应服务的 Key">
        </div>
        <div class="tp-row" id="tpExtraRow" hidden></div>

        <div class="tp-sep" id="tpExtraPromptSep" hidden>翻译要求（仅 AI 引擎）</div>
        <textarea id="tpExtraPrompt" class="tp-ta" hidden rows="3"
          placeholder="例：用口语化中文，句子短一点；保留原文幽默感；遇到人名保留英文；不要加解释"></textarea>

        <div class="tp-sep">AI 额度（仅在线引擎）</div>
        <div class="tp-row tp-check">
          <label><input type="checkbox" id="tpQuotaOn"> 启用每日字符上限</label>
        </div>
        <div class="tp-row" id="tpQuotaRow">
          <label>每日上限</label>
          <input type="number" id="tpQuota" min="1000" step="1000" value="50000">
          <span class="tp-quota-info" id="tpQuotaInfo"></span>
        </div>

        <div class="tp-sep">术语表（每行 原词=译词）</div>
        <textarea id="tpGlossary" class="tp-ta" placeholder="Voldemort=伏地魔&#10;Hogwarts=霍格沃茨"></textarea>

        <div class="tp-sep">不翻译名单（每行一个）</div>
        <textarea id="tpNoTr" class="tp-ta" placeholder="Harry&#10;iPhone"></textarea>

        <div class="tp-sep">人名名单（在名单里 = 保留原文）</div>
        <div class="tp-names" id="tpNames">
          <div class="tp-names-hint" id="tpNamesHint">翻译后列出检测到的人名（名单里的保留原文）。误判的点 × 删掉，漏的写进「不翻译名单」。</div>
        </div>
        <div class="tp-names-actions">
          <button class="btn-plain" id="tpRestoreNames">↺ 恢复为自动检测</button>
        </div>

        <div class="tp-actions">
          <button class="btn-primary" id="tpPage">翻译本页</button>
          <button class="btn-primary" id="tpBook">翻译全书</button>
          <button class="btn-plain" id="tpStop" hidden>■ 停止</button>
          <button class="btn-plain" id="tpClear">清除译文</button>
        </div>
        <div class="tp-status" id="tpStatus"></div>

        <div class="tp-sep">对照结果</div>
        <div class="tp-note tp-note-sub">每页一节、按页码排；点标题折叠，译别的页不会清掉已译的页。</div>
        <div class="tp-result" id="tpResult"></div>

        <div class="tp-plugins">
          <div class="tp-sep">已安装插件（阅读器功能）</div>
          <div id="tpFeatures" class="tp-features"></div>
        </div>

        <div class="tp-sep" id="tpMtSep">本机离线翻译（不用开电脑）</div>
        <div class="tp-note tp-note-sub" id="tpMtNote">一次装一个方向，约 110 MB（→ 中文要两套，约 220 MB）。装完断网也能翻。</div>
        <div class="tp-row">
          <label for="tpMtPick">方向</label>
          <select id="tpMtPick" title="本机离线模型支持的方向"></select>
        </div>
        <div class="tp-actions">
          <button class="btn-plain" id="tpMtDl">下载</button>
          <button class="btn-plain" id="tpMtCancel" hidden>取消下载</button>
          <button class="btn-plain" id="tpMtDel" hidden>删除模型</button>
        </div>
        <div class="tp-status" id="tpMtStat"></div>

        <div class="tp-sep">本地翻译引擎管理</div>
        <div class="tp-actions">
          <button class="btn-plain" id="tpUninstall" title="删除 llama.cpp 便携版与 Ollama 模型文件（不删系统程序），释放约 1.1GB">卸载模型 / 引擎</button>
        </div>
      </div>`;
    document.body.appendChild(panel);

    const $ = (id) => panel.querySelector('#' + id);
    const elEngine = $('tpEngine');
    const elSource = $('tpSource');
    const elTarget = $('tpTarget');
    const elAutoName = $('tpAutoName');
    const elDictName = $('tpDictName');
    const elInline = $('tpInline');
    const elFollow = $('tpFollow');
    const elExtraPrompt = $('tpExtraPrompt');
    const elExtraPromptSep = $('tpExtraPromptSep');
    const elKeyRow = $('tpKeyRow');
    const elKey = $('tpKey');
    const elKeyLabel = $('tpKeyLabel');
    const elExtra = $('tpExtraRow');
    const elGlossary = $('tpGlossary');
    const elNoTr = $('tpNoTr');
    const elStatus = $('tpStatus');
    const elResult = $('tpResult');
    const elFeatures = $('tpFeatures');
    const elQuotaOn = $('tpQuotaOn');
    const elQuota = $('tpQuota');
    const elQuotaInfo = $('tpQuotaInfo');
    const elNames = $('tpNames');
    const elNamesHint = $('tpNamesHint');
    const elRestoreNames = $('tpRestoreNames');
    const escHtml = (s) => String(s).replace(/"/g, '&quot;');

    // 自动检测人名框：把 InkTranslate.lastAutoNames 渲染成可编辑列表。
    // 显示用「手动编辑过的名单」覆盖在「自动检测」之上：autoNamesEdit 不为空就用它，
    // 否则用 lastAutoNames。每个输入框可改名，每行可删除；「恢复」撤销编辑。
    function renderAutoNames() {
      // 用 Array.isArray 判定「是否手工编辑过」，不能看 length：
      // 空数组表示用户把名字全删了，要照空显示并允许「恢复」，不能回退成自动检测。
      const edited = InkTranslate.state.autoNamesEdit;
      const isEdited = Array.isArray(edited);
      const source = isEdited ? edited : InkTranslate.lastAutoNames;
      elNames.innerHTML = '';
      if (!source || !source.length) {
        elNamesHint.hidden = false;
        elNamesHint.textContent = isEdited
          ? '名单已清空（你删掉了全部名字）→ 这些名字下次都会被正常翻译。可点「恢复」回到自动检测。'
          : (InkTranslate.state.autoDetectNames
            ? '本次没检测到人名（正文无英文，或该引擎只认内置常见名表）。想认更多：换 AI 引擎，或写进术语表。'
            : '未开启「自动检测人名」，开一下再翻译本页 / 全书即可列出。');
        elNames.appendChild(elNamesHint);
        // 只有手工编辑过（含清空）才允许「恢复」
        elRestoreNames.disabled = !isEdited;
        return;
      }
      elNamesHint.hidden = true;
      elRestoreNames.disabled = false;
      source.forEach((name, idx) => {
        const row = document.createElement('div');
        row.className = 'tp-name-row';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'tp-name-input';
        input.value = name;
        input.spellcheck = false;
        input.addEventListener('input', () => {
          // 用户一改，就把当前显示集合固化为「手动编辑名单」（复制 lastAutoNames 起步）。
          // 同样用 Array.isArray 起步，避免空数组被当「未编辑」。
          const cur = Array.isArray(InkTranslate.state.autoNamesEdit)
            ? InkTranslate.state.autoNamesEdit.slice()
            : (InkTranslate.lastAutoNames || []).slice();
          cur[idx] = input.value;
          InkTranslate.setAutoNamesEdit(cur);
        });
        const del = document.createElement('button');
        del.className = 'tp-name-del';
        del.textContent = '×';
        del.title = '从名单移除（下次翻译时该词不再保留原文，会被正常翻译）';
        del.addEventListener('click', () => {
          const cur = Array.isArray(InkTranslate.state.autoNamesEdit)
            ? InkTranslate.state.autoNamesEdit.slice()
            : (InkTranslate.lastAutoNames || []).slice();
          cur.splice(idx, 1);
          // 删到空也要存成 []，这样「删掉最后一个」不会又变回自动检测
          InkTranslate.setAutoNamesEdit(cur);
          renderAutoNames();
        });
        row.appendChild(input);
        row.appendChild(del);
        elNames.appendChild(row);
      });
    }
    elRestoreNames.addEventListener('click', () => {
      InkTranslate.restoreAutoNames();
      renderAutoNames();
      setStatus('已恢复为自动检测结果，下次翻译将重新检测');
    });

    // 引擎下拉
    /* R171：
       · appOnly 的引擎（本机离线）只给 APK 用 —— Web 端保持原样；
         桌面自测加 ?ort=1 也能看到。
       · 在手机上，「本地模型 / Hy-MT2 / 便携版」实质上都是**连电脑**
         （手机里没有那个 x86 引擎），名字后面缀一句，别让人以为能在手机上跑。 */
    const inAppNow = (typeof window !== 'undefined' && !!window.InkAndroid)
      || /[?&]ort=1(?:&|$)/.test(String((typeof location !== 'undefined' && location.search) || ''));
    function provName(p) {
      if (!p.appOnly || inAppNow) {
        if (inAppNow && /^(llamaCpp|hyMT|localLLM)$/.test(p.id)) return p.name + ' · 连电脑';
        return p.name;
      }
      return null;      // null = 这条不在当前环境露出
    }
    function refreshEngines() {
      elEngine.innerHTML = '';
      /* 「连电脑」那三个必须钉在最下面：注册顺序管不住这件事 ——
         plugins/*.js 是在 translate.js 之后加载的，它们的 provider 会追加到列表末尾，
         一插就把 llamaCpp 顶到中间去了（R171 实测：demo-upper 跑到最后）。
         所以这里显式把这三个摘出来挪到末尾，剩下的保持注册顺序。 */
      const tail = ['localLLM', 'hyMT', 'llamaCpp'];
      const all = InkPlugins.listProviders().slice();
      const head = all.filter(function (p) { return tail.indexOf(p.id) < 0; });
      const foot = tail.map(function (id) {
        return all.filter(function (p) { return p.id === id; })[0];
      }).filter(Boolean);
      head.concat(foot).forEach((p) => {
        const nm = provName(p);
        if (nm == null) return;
        const o = document.createElement('option');
        o.value = p.id;
        // 下拉只写引擎名，不缀「（离线）」「（免费 · 联网）」这类状态标签——
        // 状态在下面的状态行和 key 行里已经说清楚了，塞进选项里既长又乱。
        o.textContent = nm;
        elEngine.appendChild(o);
      });
      elEngine.value = InkTranslate.state.provider;
    }
    refreshEngines();
    updateEngineStatus();

    /* ---- R171：本机离线翻译模型的下载 / 状态（手机端） ----
       为什么要单独一块：模型 110 MB 一套，不能塞进 APK，
       但用户点「翻译」时如果不装就只会看到一句报错 —— 得有个地方能装。
       R173：日/韩/俄 也能翻了，方向多到「按当前语言自动猜」不够用
       （源语言选「自动」时面板根本不知道正文是什么语），所以多给一个方向下拉。 */
    const elMtDl = $('tpMtDl'), elMtCancel = $('tpMtCancel'), elMtStat = $('tpMtStat');
    const elMtSep = $('tpMtSep'), elMtNote = $('tpMtNote'), elMtPick = $('tpMtPick');
    const elMtDel = $('tpMtDel');
    let _mtTimer = 0;
    let _pickSig = '';          // 下拉的选项内容签名：没变就绝不重建 DOM
    let _mtAll = {};            // 最近一次 status 的全量结果（删除前算「会连带影响谁」）

    const MT_NAME = { zh: '中文', en: '英文', ja: '日文', ko: '韩文', ru: '俄文' };
    function mtLabel(pair) {
      const p = String(pair || '').split('-');
      const pivot = ((typeof MtLocal !== 'undefined' && MtLocal.PLANS
        && MtLocal.PLANS[pair]) || []).length > 1;
      return (MT_NAME[p[0]] || p[0]) + ' → ' + (MT_NAME[p[1]] || p[1]) + (pivot ? '（经英文）' : '');
    }
    function mtRouteList() {
      const all = (typeof MtLocal !== 'undefined' && MtLocal.PLANS) ? Object.keys(MtLocal.PLANS) : [];
      const order = ['zh-en', 'en-zh', 'ja-en', 'ja-zh', 'ko-en', 'ko-zh', 'ru-en', 'ru-zh'];
      return order.filter((k) => all.indexOf(k) >= 0)
        .concat(all.filter((k) => order.indexOf(k) < 0));
    }
    /** 按语言下拉反推一个方向。 */
    function mtDerivePair() {
      if (typeof MtLocal === 'undefined') return '';
      let src = elSource.value || 'auto';
      const tgt = elTarget.value || 'ZH';
      /* 「自动」在这里没有正文可看，只能按目标反推：目标中文 ⇒ 源当英文，反之当中文。
         真正翻译时是按正文判的（见 offlineMTProvider），这里只管「下载哪一套」。 */
      if (src === 'auto') src = (MtLocal.langOf(tgt) === 'zh') ? 'en' : 'zh';
      return MtLocal.pairOf(src, tgt);
    }
    function mtFillPick() {
      if (!elMtPick || typeof MtLocal === 'undefined') return;
      /* ⚠️ R174：这里以前每次刷新都 innerHTML = '' 重建一遍 ——
         而 mtRefresh() 在「下载中」每 2 秒、以及每次 change 都会跑，
         于是用户点开原生下拉选方向时，选项正好被清空重建，选择被吞掉，
         表现就是「有时要点好几下才选中」。选项内容没变就一个字都别碰。 */
      const list0 = mtRouteList();
      const sig = list0.join(',');
      if (sig === _pickSig && elMtPick.options.length) return;
      const keep = elMtPick.value;
      elMtPick.innerHTML = '';
      _pickSig = sig;
      mtRouteList().forEach((k) => {
        const o = document.createElement('option');
        o.value = k;
        o.textContent = mtLabel(k);
        elMtPick.appendChild(o);
      });
      if (keep && mtRouteList().indexOf(keep) >= 0) elMtPick.value = keep;
      else elMtPick.value = mtDerivePair() || 'zh-en';
    }
    /** 把「已装」标在选项前面，代替状态行里那一长串「另装：…」。
        只改 textContent，不重建节点 —— 所以不会像以前那样吞掉用户的选择。 */
    function mtMarkInstalled(all) {
      if (!elMtPick || !all) return;
      Array.prototype.forEach.call(elMtPick.options, function (o) {
        const ins = !!(all[o.value] && all[o.value].installed);
        const t = (ins ? '✓ ' : '') + mtLabel(o.value);
        if (o.textContent !== t) o.textContent = t;
      });
    }
    function mtPairNow() {
      if (elMtPick && elMtPick.value) return elMtPick.value;
      return mtDerivePair();
    }
    async function mtRefresh() {
      if (!inAppNow) {                       // Web 端不露这一块
        if (elMtSep) elMtSep.style.display = 'none';
        if (elMtNote) elMtNote.style.display = 'none';
        if (elMtStat) elMtStat.textContent = '';
        if (elMtDl) elMtDl.style.display = 'none';
        if (elMtCancel) elMtCancel.style.display = 'none';
        if (elMtPick) elMtPick.parentNode.style.display = 'none';
        if (elMtDel) elMtDel.style.display = 'none';
        return;
      }
      if (typeof MtLocal === 'undefined' || !elMtSep) return;
      mtFillPick();
      const pair = mtPairNow();
      if (!pair) {
        elMtStat.textContent = '本机没有这一对（中文 → 日/韩/俄 上游没模型）。换「连电脑」那几档。';
        elMtDl.disabled = true;
        elMtDl.textContent = '下载';
        elMtDl.style.display = '';
        if (elMtDel) elMtDel.hidden = true;
        return;
      }
      let j = null;
      try {
        // 不带 pair：一次拿全部方向，顺便知道「已经装了哪些」，省得用户重复下 110 MB
        const r = await fetch('/api/mt-local/status', { cache: 'no-store' });
        j = await r.json();
      } catch (e) { }
      const all = (j && j.pairs) || {};
      _mtAll = all;
      const s = all[pair];
      if (!s) { elMtStat.textContent = '问不到离线模型状态（服务没响应）'; return; }
      const mb = (n) => (Math.round((n || 0) / 1048576)) + ' MB';
      /* R174：状态行只说「当前这个方向」，别再把已装列表念一遍 ——
         已装的方向在下拉里带 ✓，一眼就看见，比一长串文字清楚。 */
      mtMarkInstalled(all);
      if (s.installed) {
        /* R175：已装好就不再给「下载」按钮。
           以前这里写「重新下载」，可 install 接口见到文件在就跳过 ——
           点了什么都不发生，难怪用户问「重新下载有啥用」。
           要重下就先删（旁边就是删除），两步都比一个假按钮清楚。 */
        elMtStat.textContent = '✅ 已装好 · ' + mb(s.bytes);
        elMtDl.style.display = 'none';
        elMtDl.disabled = false;
        elMtCancel.hidden = true;
        if (elMtDel) elMtDel.hidden = false;
        clearInterval(_mtTimer); _mtTimer = 0;
        return;
      }
      if (s.installing) {
        const pct = s.expect ? Math.min(99, Math.round(s.got / s.expect * 100)) : 0;
        elMtStat.textContent = '⏳ 下载中 ' + pct + '% · ' + mb(s.got) + ' / ' + mb(s.expect)
          + (s.pivot ? '（两套）' : '');
        /* R176：下载中别再摆一个灰掉的「下载」。它点不动、也不表示任何状态，
           和 R175 那个「重新下载」是一类东西 —— 看着像还有一件事没做。
           这时候该有的按钮只有一个：取消下载。 */
        elMtDl.style.display = 'none';
        elMtCancel.hidden = false;
        if (elMtDel) elMtDel.hidden = true;
        if (!_mtTimer) _mtTimer = setInterval(mtRefresh, 2000);
        return;
      }
      clearInterval(_mtTimer); _mtTimer = 0;
      const cancelled = /已取消/.test(s.err || '');
      elMtStat.textContent = (s.err && !cancelled ? ('❌ 上次失败：' + s.err + '。') : '')
        + (cancelled ? '（已取消）' : '')
        + '未下载 · 约 ' + mb(s.expect || 0);
      elMtDl.style.display = '';
      elMtDl.disabled = false;
      elMtDl.textContent = '下载';
      elMtCancel.hidden = true;
      if (elMtDel) elMtDel.hidden = true;
    }
    if (elMtDl) elMtDl.addEventListener('click', async () => {
      const pair = mtPairNow();
      if (!pair) return;
      elMtDl.disabled = true;
      try {
        const r = await fetch('/api/mt-local/install?pair=' + encodeURIComponent(pair), { method: 'POST' });
        const j = await r.json();
        if (!j.ok) setStatus('下载没起来：' + (j.error || '未知原因'));
      } catch (e) { setStatus('下载没起来：' + e.message); }
      setTimeout(mtRefresh, 600);
    });
    if (elMtCancel) elMtCancel.addEventListener('click', async () => {
      const pair = mtPairNow();
      try { await fetch('/api/mt-local/cancel?pair=' + encodeURIComponent(pair), { method: 'POST' }); } catch (e) { }
      setTimeout(mtRefresh, 400);
    });
    /** 删这个方向会连带让哪些「已装」方向变成未下载 —— 它们用的是同一批模型文件。
        模型是 ja-en / en-zh 这种「模型」粒度，方向是「日→中 = ja-en + en-zh」这种链，
        两者会重叠，所以删之前必须先跟用户说清代价。 */
    function mtAffectedOf(pair) {
      const cur = (((_mtAll[pair] || {}).models) || []).map((x) => x.pair);
      const out = [];
      Object.keys(_mtAll).forEach((k) => {
        if (k === pair) return;
        const p = _mtAll[k];
        if (!p || !p.installed) return;
        const ms = (p.models || []).map((x) => x.pair);
        if (ms.some((m) => cur.indexOf(m) >= 0)) out.push(k);
      });
      return out;
    }
    if (elMtDel) elMtDel.addEventListener('click', async () => {
      const pair = mtPairNow();
      if (!pair) return;
      const lab = mtLabel(pair);
      const sz = Math.round((((_mtAll[pair] || {}).bytes) || 0) / 1048576);
      const aff = mtAffectedOf(pair);
      let msg = '删除「' + lab + '」的离线模型' + (sz ? '（' + sz + ' MB）' : '') + '？\n';
      if (aff.length) {
        msg += '\n「' + aff.map(mtLabel).join('」「') + '」用的是同一批文件，删完也会变成未下载。\n';
      }
      msg += '删了随时可以再下。';
      if (!window.confirm(msg)) return;
      elMtDel.disabled = true;
      /* R175：删 200 MB 要一两秒（Windows 还要过一遍杀毒），这段时间界面要是
         一点动静都没有，用户就会当成「点了没反应 / 删不了」。先把话说出去。 */
      elMtDel.textContent = '删除中…';
      setStatus('正在删除「' + lab + '」…');
      try {
        const r = await fetch('/api/mt-local/remove?pair=' + encodeURIComponent(pair), { method: 'POST' });
        const j = await r.json();
        if (!j.ok) {
          setStatus('删除失败：' + (j.error || '未知原因'));
        } else if (!j.removed || !j.removed.length) {
          setStatus('「' + lab + '」没有可删的文件（可能已经删过了）');
        } else {
          /* 磁盘删了，内存里的会话也得丢掉，否则「删了还能翻」，看着像没删掉。
             affected 的方向同样要丢 —— 它们用的是被删掉的那批文件。 */
          const aff2 = j.affected || [];
          if (typeof MtLocal !== 'undefined' && MtLocal.forget) {
            [pair].concat(aff2).forEach((k) => MtLocal.forget(k));
          }
          const freed = Math.round((j.freed || 0) / 1048576);
          setStatus('已删除「' + lab + '」' + (freed ? '，释放 ' + freed + ' MB' : '')
            + (aff2.length ? '；' + aff2.map(mtLabel).join('、') + ' 也变成未下载' : ''));
        }
      } catch (e) { setStatus('删除失败：' + e.message); }
      elMtDel.disabled = false;
      elMtDel.textContent = '删除模型';
      setTimeout(mtRefresh, 300);
    });
    if (elMtPick) elMtPick.addEventListener('change', mtRefresh);
    // 语言一改，需要的方向就变了（中→英 / 日→中 …），下拉和状态跟着重算
    function mtOnLangChange() {
      const d = mtDerivePair();
      if (d && elMtPick && mtRouteList().indexOf(d) >= 0) elMtPick.value = d;
      mtRefresh();
    }
    elSource.addEventListener('change', mtOnLangChange);
    elTarget.addEventListener('change', mtOnLangChange);
    mtRefresh();

    // 源/目标语言下拉
    function refreshLangs() {
      elSource.innerHTML = '';
      SOURCE_LANGS.forEach((l) => {
        const o = document.createElement('option');
        o.value = l.code; o.textContent = l.name;
        elSource.appendChild(o);
      });
      elSource.value = InkTranslate.getBookSourceLang();

      elTarget.innerHTML = '';
      TARGET_LANGS.forEach((l) => {
        const o = document.createElement('option');
        o.value = l.code; o.textContent = l.name;
        elTarget.appendChild(o);
      });
      // 下拉显示「当前书自己的目标语言」（没有就显示全局默认），与翻译实际用的保持一致
      elTarget.value = InkTranslate.getBookTargetLang();
      elAutoName.checked = InkTranslate.state.autoDetectNames !== false;
      elDictName.checked = InkTranslate.state.dictNameCheck !== false;
      elExtraPrompt.value = InkTranslate.state.extraPrompt || '';
      elInline.checked = InkTranslate.state.inlineBilingual === true;
      elFollow.checked = InkTranslate.state.inlineFollowPanel === true;
      elQuotaOn.checked = InkTranslate.state.quotaEnabled === true;
      elQuota.value = InkTranslate.state.quotaLimit || 50000;
    }
    refreshLangs();
    // 语言下拉这时才有真实的书级语言，方向下拉要跟着再对一次（R173）
    mtRefresh();
    // 源语言同样按书存（OCR 认日文的书，重开时还显示「日语」）
    elSource.addEventListener('change', () => {
      if (InkTranslate.bookKey()) InkTranslate.setBookSourceLang(elSource.value);
      else InkTranslate.setSourceLang(elSource.value);
    });
    // 选目标语言：开着书时只作用于「当前这本书」（不污染全局默认）；没开书时改全局默认。
    elTarget.addEventListener('change', () => {
      if (InkTranslate.bookKey()) InkTranslate.setBookTargetLang(elTarget.value);
      else InkTranslate.setTargetLang(elTarget.value);
      localTargetWarn();
    });
    elAutoName.addEventListener('change', () => { InkTranslate.setAutoDetectNames(elAutoName.checked); renderAutoNames(); });
    elDictName.addEventListener('change', () => InkTranslate.setDictNameCheck(elDictName.checked));
    // 翻译要求：AI 引擎才有 prompt 接口可以附加指令
    elExtraPrompt.addEventListener('change', () => InkTranslate.setExtraPrompt(elExtraPrompt.value));
    elInline.addEventListener('change', () => {
      InkTranslate.setInlineBilingual(elInline.checked);
      clearInline();          // 取消勾选要真的清干净（竖排的增量路径不会自己清）
      if (!elInline.checked) _inlineToken++;   // 作废在途请求：本地引擎慢，不这样会在取消后还陆续贴回来
      renderInlineForPage();
    });

    // 「只显示小窗已译的段落」：勾上后正文一个字都不再自己翻，只贴面板译过的段落。
    elFollow.addEventListener('change', () => {
      InkTranslate.setInlineFollowPanel(elFollow.checked);
      clearInline();
      _inlineToken++;                          // 作废在途的滚动补译，别让它再贴回来
      renderInlineForPage();
      // R130（第 7 条）：以前 PDF / 漫画一律被强制取消勾选 —— 现在已经支持了
      // （renderPdfInline / renderImgInline 会先查面板译过没有，没译过就不发请求），
      // 所以这里不再往回拨，只是把适用范围说清楚。
      const Rb = getBook();
      const paged = Rb && (Rb.format === 'pdf' || Rb.format === 'comic') && !(Rb.format === 'comic' ? comicScrollOn() : false);
      if (paged) {
        setStatus(elFollow.checked
          ? '已开启：只显示小窗译过的页；没译过的页保持原样，不会再自动翻'
          : '已关闭：翻到 / 滚到新的一页会自动补译');
        return;
      }
      setStatus(elFollow.checked
        ? '已开启：正文只显示小窗译过的段落；滚到没译过的地方保持原文，不会再自动翻'
        : '已关闭：正文恢复跟着滚动自动补译');
    });

    function syncKeyRow() {
      const p = InkPlugins.getProvider(elEngine.value);
      // DeepSeek / OpenAI / 本地模型都可以改接口地址（前两个有默认值，留空即用官方）
      const needEndpoint = p && (p.id === 'openai' || p.id === 'localLLM'
        || p.id === 'deepseek' || p.id === 'hyMT' || p.id === 'llamaCpp');
      const needKey = p && p.needsKey;
      // 「翻译要求」对有 prompt 接口的引擎生效：AI 大模型靠 system prompt，
      // Hy-MT2 靠官方 Style 模板；DeepL、浏览器内置翻译没有 prompt 接口，隐藏掉。
      const canPrompt = !!(p && (p.returnsNames || p.buildPrompt));
      elExtraPromptSep.hidden = !canPrompt;
      elExtraPrompt.hidden = !canPrompt;
      // Key 只给需要鉴权的引擎（OpenAI / DeepL）；本地模型不需要
      elKeyRow.hidden = !needKey;
      elKeyLabel.textContent = p && p.id === 'deepl' ? 'DeepL API Key'
        : (p && p.id === 'deepseek' ? 'DeepSeek API Key' : 'API Key');
      // Key 按引擎各存一份（byEngine），切引擎不会串；
      // 旧存档没有该引擎的记录时退回顶层那一套，迁移后自动归位。
      const cfg = p ? InkTranslate.engineCfg(p.id) : {};
      const isActive = p && InkTranslate.state.provider === p.id;
      elKey.value = cfg.apiKey || (isActive ? (InkTranslate.state.apiKey || '') : '');
      elKey.oninput = () => { if (p) InkTranslate.setEngineField(p.id, 'apiKey', elKey.value); };
      if (needEndpoint) {
        elExtra.hidden = false;
        const epPh = p.id === 'localLLM'
          ? 'Ollama: http://localhost:11434/v1/chat/completions｜LM Studio: http://localhost:1234/v1/chat/completions'
          : (p.id === 'deepseek' ? 'https://api.deepseek.com/chat/completions'
            : (p.id === 'hyMT' ? 'http://localhost:11434/v1/chat/completions'
            : (p.id === 'llamaCpp' ? 'http://127.0.0.1:8080/v1/chat/completions' : OPENAI_DEFAULT_ENDPOINT)));
        const mdlPh = p.id === 'localLLM'
          ? '本地模型名，如 qwen2.5 / llama3'
          : (p.id === 'deepseek' ? 'deepseek-chat'
            : (p.id === 'hyMT' ? 'kaelri/hy-mt2:1.8b-q4_K_M'
              : (p.id === 'llamaCpp' ? 'hy-mt2（llama-server 只用加载的那个模型，填什么都行）' : 'gpt-4o-mini')));
        elExtra.innerHTML =
          '<label>接口地址</label><input id="tpEp" placeholder="' + escHtml(epPh) + '">' +
          '<label>模型名</label><input id="tpMdl" placeholder="' + escHtml(mdlPh) + '">' +
          '<div class="tp-note tp-note-sub">「模型名」填该接口的模型标识：云端如 gpt-4o-mini / deepseek-chat，' +
          'Ollama 如 kaelri/hy-mt2:1.8b-q4_K_M，llama.cpp 填什么都行。不知道就留空用默认。</div>' +
          (p.id === 'hyMT'
            ? '<div class="tp-note">纯翻译模型：术语表走原生「术语干预」，人名 / 不翻译名单走占位符保护。' +
              '模型目录固定落在安装目录的 models\\ollama（安装时自动设 OLLAMA_MODELS），不占 C 盘。</div>' +
              // R130：以前这里没有探测结果那一行，下面 p._health() 的回调找不到节点会直接抛
              // 「Cannot set properties of null」——面板一打开（现在每次打开都会重新 syncKeyRow）就报错。
              '<div class="tp-note" id="tpLlamaNote">检测本地 Ollama 服务…</div>'
            : (p.id === 'llamaCpp'
              ? '<div class="tp-note" id="tpLlamaNote">检测本地 llama.cpp 服务…</div>'
              : ''));
        const e = elExtra.querySelector('#tpEp');
        e.value = cfg.endpoint || (isActive ? (InkTranslate.state.endpoint || '') : '');
        e.addEventListener('input', () => { InkTranslate.setEngineField(p.id, 'endpoint', e.value); });
        const m = elExtra.querySelector('#tpMdl');
        m.value = cfg.model || (isActive ? (InkTranslate.state.model || '') : '');
        m.addEventListener('input', () => { InkTranslate.setEngineField(p.id, 'model', m.value); });
        // 两个本地引擎（llama.cpp 便携版 / Ollama 版 Hy-MT2）都探一次，
        // 没起服务就明说怎么起，别让用户点翻译后只拿到一句 Failed to fetch。
        const localNoteId = p.id === 'llamaCpp' ? 'tpLlamaNote' : null;
        if ((p.id === 'llamaCpp' || p.id === 'hyMT') && typeof p._health === 'function') {
          const note = elExtra.querySelector('#' + (localNoteId || 'tpLlamaNote'));
          const how = p.id === 'llamaCpp'
            ? '在安装目录 localmt\\start-llama.ps1 启动（首次请回本面板点「安装」自动装引擎和模型）'
            : '先启动 Ollama（ollama serve）并 ollama pull kaelri/hy-mt2:1.8b-q4_K_M';
          p._health(e.value || p.defaultEndpoint).then((h) => {
            if (!note) return;                     // 节点被重建掉了：只是没处显示，不要抛错
            note.textContent = (h && h.ok)
              ? '✅ 本地服务已就绪（' + (h.model || 'llama.cpp') + '，完全离线免费，不计 AI 额度）'
              : '❌ 连不上本地服务（' + (e.value || p.defaultEndpoint) + '）。' + how;
          }).catch(() => { });
        }
      } else if (p && p.id === 'mymemory') {
        // 免费引擎，什么都不用填。但用户有权知道「它是谁、能翻多少」，
        // 免得把「公共翻译记忆库」当成正经大模型（长句 / 术语会差一截）。
        elExtra.hidden = false;
        elExtra.innerHTML = '<div class="tp-note"><b>MyMemory 是什么</b>：欧盟 Translated 的公共翻译记忆库 ——' +
          '把别人译过的句子存起来复用，所以不用注册、不用 Key 就能用。' +
          '单次约 500 字、每天约 5000 词，超了会返回「MYMEMORY WARNING」。' +
          '短句和常见说法够用，长句 / 专业术语不如 DeepL 或本地 Hy-MT2。</div>';
      } else if (p && p.id === 'deepl') {
        elExtra.hidden = false;
        elExtra.innerHTML = '<label>DeepL 术语表 ID</label><input id="tpGlId" placeholder="可选，DeepL 后台创建">';
        const g = elExtra.querySelector('#tpGlId');
        g.value = InkTranslate.state.glossaryId || '';
        g.addEventListener('input', () => { InkTranslate.state.glossaryId = g.value.trim(); InkTranslate.save(); });
      } else if (p && p.id === 'chromeAI') {
        elExtra.hidden = false;
        elExtra.innerHTML = '<div class="tp-note" id="tpChromeNote">检测浏览器内置翻译是否可用…</div>';
        const note = elExtra.querySelector('#tpChromeNote');
        const st = {
          unavailable: '❌ 该语言对不可用，或本机不满足硬件要求（需 >4GB 显存 或 16GB 内存+4 核，且约 22GB 可用空间）',
          downloadable: '⬇️ 需要下载语言包（首次翻译时自动下载，可能几分钟）',
          downloading: '⬇️ 语言包下载中…', available: '✅ 可用（本机运行，免费离线）',
          unsupported: '❌ 当前浏览器不支持内置翻译：需 Chrome 138+ 桌面版（Windows/macOS/Linux/ChromeOS），' +
            '且满足上述硬件；手机 / iPad Safari 没有此 API。若只是想要「自由选目标语言 + 术语表」，' +
            '请改用「本地模型（llama.cpp 便携版）」或 DeepL / OpenAI，不受此限制。' };
        if (typeof p._avail === 'function') {
          p._avail(InkTranslate.state).then((a) => {
            note.innerHTML = (st[a] || ('状态：' + a)) +
              '<br><span class="tp-note-sub">注意：浏览器内置翻译没有 prompt 接口，' +
              '术语表 / 人名保护不保证生效（要用术语表请选 DeepL 或本地模型）。</span>';
          });
        } else {
          note.textContent = '❌ 当前浏览器不支持（既没有 Translator 类，也没有 self.translation）。' +
            '请升级到 Chrome 138+ 桌面版；或改用「本地模型」等不依赖浏览器 AI 的引擎。';
        }
      } else {
        elExtra.hidden = true;
        elExtra.innerHTML = '';
      }
    }

    // 术语表 / 不翻译 文本 ↔ 状态
    function syncGlossaryFromUI() {
      const list = elGlossary.value.split('\n').map((l) => l.trim()).filter(Boolean)
        .map((l) => {
          const i = l.indexOf('=');
          return i > 0 ? { src: l.slice(0, i).trim(), dst: l.slice(i + 1).trim() } : { src: l, dst: l };
        }).filter((t) => t.src);
      InkTranslate.setGlossary(list);
      const no = elNoTr.value.split('\n').map((l) => l.trim()).filter(Boolean);
      InkTranslate.setNoTranslate(no);
    }
    function syncGlossaryToUI() {
      elGlossary.value = InkTranslate.state.glossary.map((t) => t.src + '=' + t.dst).join('\n');
      elNoTr.value = InkTranslate.state.noTranslate.join('\n');
    }
    syncGlossaryToUI();
    elGlossary.addEventListener('change', syncGlossaryFromUI);
    elNoTr.addEventListener('change', syncGlossaryFromUI);
    // 注意：Key / 接口地址 / 模型名都在 syncKeyRow() 里按引擎写进 byEngine，
    // 这里不能再往 state.apiKey 顶层写一份 —— 否则切到别的引擎会串用上一个引擎的 Key。

    elEngine.addEventListener('change', () => { InkTranslate.setProvider(elEngine.value); syncKeyRow(); updateEngineStatus(true); refreshUninstallBtn(); });

    $('tpClose').addEventListener('click', () => { panel.classList.remove('open'); });

    function setStatus(t) { elStatus.textContent = t || ''; }

    // R130（第 4 条）：点「翻译本页 / 全书」之前先确认「本地引擎」真的在跑。
    // 以前引擎没启动时点翻译，只会拿到一句 Failed to fetch / 一直等，看着像卡死。
    // 现在的策略（用户提的方案，已按此实现）：
    //   · 引擎没启动 → 这次自动改用「本地词典」（离线、免费、立刻能用），并明确告知；
    //   · 引擎在跑   → 一个字都不改，用用户选的引擎。
    // 用的是 provider 自己的 _health（和面板上的「检测中…」同一套探测），最多等 2.5 秒。
    const LOCAL_SERVER_PROVIDERS = ['hyMT', 'llamaCpp', 'localLLM'];
    async function ensureLocalEngineReady() {
      const id = InkTranslate.state.provider;
      if (LOCAL_SERVER_PROVIDERS.indexOf(id) < 0) return;
      const p = InkPlugins.getProvider(id);
      if (!p || typeof p._health !== 'function') return;
      const cfg = InkTranslate.engineCfg(id) || {};
      let ok = false;
      try {
        const h = await Promise.race([
          p._health(cfg.endpoint || p.defaultEndpoint),
          new Promise((res) => setTimeout(() => res(null), 2500))
        ]);
        ok = !!(h && h.ok);
      } catch (e) { ok = false; }
      if (ok) return;
      InkTranslate.setProvider('local');
      elEngine.value = 'local';
      try { syncKeyRow(); } catch (e) { }
      setStatus('本地引擎（' + p.name + '）没在运行，这次先用「本地词典」翻译；启动引擎后在上方切回即可。');
      // 状态行会被随后的「翻译完成」盖掉，所以另弹一句，确保用户看到引擎被换了
      if (typeof toast === 'function') toast('本地引擎没启动，这次用「本地词典」翻译');
    }

    // 目标语言提示：本地离线词典只支持中文（简体）。若用户选了其他目标语言却仍用本地引擎，
    // 给一句明确的提醒（而不是「点了没反应」），并说明要翻译成该语言需切到在线引擎。
    // 目标语言提示：只有「本地离线迷你词典」只支持中文（简体）。
    // 浏览器内置翻译 / 本地模型本身支持多语言，不该跟着报错。
    function localTargetWarn() {
      const p = InkPlugins.getProvider(InkTranslate.state.provider);
      const tgt = InkTranslate.getBookTargetLang();
      if (p && p.id === 'local' && tgt && tgt !== 'ZH') {
        const tgtName = (TARGET_LANGS.find((l) => l.code === tgt) || {}).name || tgt;
        setStatus('⚠️ 本地离线词典仅支持中文（简体）。要译成「' + tgtName +
          '」请改选 DeepL / OpenAI / 本地模型 引擎；现已按中文翻译。');
      }
    }

    // ---- 原大屏双语：把译文插到正文下方 ----
    // 之前这功能只有调用、没有实现（勾选会直接报错），现在补全：
    //   - 取当前可见正文容器 #pageText（阅读器 renderPage 把每页正文写进这里）；
    //   - 整页作为一段翻译，在容器末尾追加一个 .tr-page-tr 块（「原文下方」）；
    //   - 按页缓存译文，翻页不重复请求；翻页后由包了一层的 renderPage 自动重画。
    // 用「计数」而不是布尔：横排靠它串行化（上一页没译完别叠两层）。
    // 以前是布尔 + 「token 没变才复位」，一旦翻译途中翻页/清空（token 变了），
    // 就再也没人把它置回 false → 之后横排一律静默跳过，表现为「清空后重新勾选，
    // 正文再也不出译文，只能刷新页面」（R99 实测）。
    let _inlineBusy = 0;
    const _inlineCache = {}; // 键：R.pageIndex → 译文
    let _inlineToken = 0;    // 翻页代号：翻页后旧请求的结果作废，避免译文贴到新页上
    // 「这一轮补译」的编号。段落上的 data-tr-doing 现在记的是编号而不是 1，
    // 收尾时只摘自己这一轮贴的标记 —— 以前一律 delete，旧任务收尾会把新一轮刚贴的
    // 占位标记清掉，于是同一段被两轮各译一次、各贴一条一模一样的译文（R101 实测）。
    let _inlineSeq = 0;

    /* 「译文第几代」。改术语表 / 换引擎 / 换语言 = 要求变了，之前贴在正文里的译文就算旧的。
       每个译文块记下自己出生时的代数，重译时只认「同一代」的块 ——
       否则正文里那条旧译文会一直被当成「这段已经译过」，改了要求再点「翻译本页」
       大屏纹丝不动（用户实测的疑问：C 段 abc 改成 bcd，大屏会不会跟着换）。
       旧块先留着不动（看清再换），等新译文回来由 insertTranslated 摘掉。 */
    let _genStamp = 1;
    function _GEN() { return String(_genStamp); }
    // 这段下面贴着的译文块，是不是「当前这一代」的
    function _freshBlock(node) {
      if (!node) return null;
      const nx = node.nextElementSibling;
      if (nx && nx.classList && nx.classList.contains('tr-page-tr') && nx.dataset.gen === _GEN()) return nx;
      return null;
    }

    /* ── 两本译文本账 ───────────────────────────────────────────────
       _trMemo   ：所有渠道译过的「原文块 → 译文」，同一段只请求一次
                   （小窗点过一次，正文滚回来就直接用，不再花钱/花时间）
       _panelMemo：只记「小窗（翻译本页 / 全书）译过的段落」，供
                   「只显示小窗已译的段落」这个模式当数据源。
       两份都按 provider|目标语言 分键 —— 换引擎/换语言后旧译文不可复用；
       InkTranslate.dropMemo() 会在改术语表、换引擎、换语言时把它们清空。 */
    const _trMemo = new Map();
    const _panelMemo = new Map();
    /* 正在路上的请求：同一块文本并发被问两次（滚动补译 + 面板翻译同时起跑，
       或同一段在两次 gatherJobs 里都还是「没译过」）时，只发一次请求，两次都等它。
       以前只查 _trMemo，而 _trMemo 是「回来才写」的，两个并发任务都会 miss →
       同一段被翻译两遍（多花钱、还可能两条译文各贴一次）。 */
    const _inflight = new Map();
    const _MEMO_CAP = 4000;
    function _memoKey(text) {
      const st = InkTranslate.state || {};
      const lang = (InkTranslate.getBookTargetLang && InkTranslate.getBookTargetLang()) || st.targetLang || '';
      return (st.provider || '') + '|' + lang + '|' + String(text == null ? '' : text).trim();
    }
    function _memoPut(map, text, dst) {
      if (dst == null || dst === '' || /^⚠️/.test(String(dst))) return;   // 失败标记不进缓存
      const k = _memoKey(text);
      if (!k) return;
      if (map.has(k)) map.delete(k);
      map.set(k, dst);
      if (map.size > _MEMO_CAP) map.delete(map.keys().next().value);       // 超量就丢最早的
    }
    function _memoGet(map, text) {
      const k = _memoKey(text);
      return k && map.has(k) ? map.get(k) : null;
    }
    global.__inkDropMemo = () => {
      _trMemo.clear();
      _panelMemo.clear();
      _genStamp++;                                  // 旧译文作废：正文里那些块不再被当成「已译」
      for (const k in _inlineCache) delete _inlineCache[k];   // 横排整页缓存同理
    };
    /** reader.js 用：这一页重新 OCR / 清除了识别结果 → 按「旧原文」删掉它的译文缓存。
     *  译文账本是按原文文本存的，旧识别出来的那串字不删掉的话，万一新识别又撞出同样
     *  的文本（很常见：只差一两个字时切出来的段落可能一样），会把旧译文当成「已译」直接贴回来。 */
    global.__inkDropTextTr = (text) => {
      const s = String(text == null ? '' : text);
      if (!s.trim()) return 0;
      let n = 0;
      const keys = [s].concat(splitForTranslation(s) || []);
      [_trMemo, _panelMemo].forEach((m) => {
        keys.forEach((t) => {
          const k = _memoKey(t);
          if (k && m.has(k)) { m.delete(k); n++; }
        });
      });
      return n;
    };
    // 小窗译过的段落：整段命中最好；「全书」是按块存的，长段就得把各块都命中才拼得出来。
    function _panelDstFor(text) {
      const whole = _memoGet(_panelMemo, text);
      if (whole != null) return whole;
      const chunks = splitForTranslation(text);
      if (chunks.length < 2) return null;
      const parts = chunks.map((c) => _memoGet(_panelMemo, c));
      if (parts.some((x) => x == null)) return null;
      return parts.join('\n\n');
    }

    function clearInline() {
      document.querySelectorAll('.tr-page-tr').forEach((n) => n.remove());
      // R132（第 3 条）：正文这一批在途请求已经被作废了，账要一起划掉，
      // 否则「翻译中」还得等它们全部返回才灭（用户：都勾了不跟随怎么还显示翻译中）。
      if (typeof global !== 'undefined' && typeof global.__inkTrBusyDrop === 'function') {
        global.__inkTrBusyDrop('inline');
      }
      // R131（第 7 条）：PDF / 图片书的「页下译文」块类名是 .pdf-tr-block，不在上面那一类里。
      // 以前只清 .tr-page-tr，于是取消「双语对照」/ 取消「只显示小窗已译」之后，
      // 那些译文块还老老实实留在页面下方 —— 用户看到的就是「取消勾选也不消失」。
      document.querySelectorAll('.pdf-tr-block').forEach((n) => n.remove());
      // 竖排模式下「这段译过了」是记在段落节点上的，取消勾选时要一并清掉，
      // 否则重新勾选会因为「都译过了」而什么都不显示。
      // （PDF 画布 / 漫画图上的 data-tr-done 也在这个选择器里，一并清掉才能重译）
      document.querySelectorAll('[data-tr-done],[data-tr-doing]').forEach((n) => {
        delete n.dataset.trDone;
        delete n.dataset.trDoing;
      });
    }

    // 正文容器：横排（左右翻页）是每页重建的 #pageText；
    // 竖排（上下滚动）整本摊在 #scrollInner 里，两个都得支持。
    // 富文本（html/epub/docx）永远渲染在 #scrollInner 的 .html-book 里，
    // 之前一律取 #pageText → 富文本书「原文下方显示译文」永远是空的（用户实测：翻译没嵌入译文）。
    function inlineHost() {
      const R = getBook();
      if (R && R.format === 'html') {
        return document.querySelector('#scrollInner .html-book') || document.querySelector('#scrollInner');
      }
      const vert = (typeof Settings !== 'undefined' && Settings && Settings.direction === 'vertical');
      const el = vert ? document.querySelector('#scrollInner') : document.querySelector('#pageText');
      return el || document.querySelector('#pageText');
    }

    // 把译文插在「对应原文」的下方（名副其实的双语对照），而不是整页末尾一大坨。
    // 每段单独成块 → 翻完一段就显示一段，长页也不会干等。
    // visibleOnly（竖排用）：只取当前屏 + 后面一屏的段落，滚动时再增量补，
    // 否则一进来就要把整本书译完（几千段），既不现实也不需要。
    // viewport（竖排用）：给可视区元素（#scrollLayer）而不是正文容器 ——
    // 正文容器 #scrollInner 是整本书那么高，拿它当视口等于一次把全书译完。
    // 「可翻译块」候选：txt 是 #pageText 的直接子元素（一段一个）；
    // 富文本 .html-book 的直接子元素是整章 <section>（一章几千字，一次丢给引擎会超长），
    // 所以富文本下沉到叶子段落。返回的数组顺序稳定，双语缓存按下标回贴。
    function inlineCandidates(cont) {
      const R0 = getBook();
      if (R0 && R0.format === 'html') {
        const nodes = Array.prototype.slice.call(
          cont.querySelectorAll('p, h1, h2, h3, h4, h5, li, blockquote, dt, dd')
        ).filter(n => !n.querySelector('p, h1, h2, h3, h4, h5, li, blockquote, dt, dd'));
        if (nodes.length) return nodes;
      }
      // 竖排 txt：正文是 .txt-page > p[data-off]，.txt-page 是「一整页」——
      // 把整页当成一个翻译单元会有两个后果（用户实测）：
      //   ① 一屏上只有一两条超长译文，全堆在页尾，不像双语对照；
      //   ② 从这个「页」的开头开始译，所以看起来「不是从当前屏幕开始」。
      // 所以统一下沉到段落 p[data-off]（横排 #pageText 里也是这个结构，一套通用）。
      const paras = Array.prototype.slice.call(cont.querySelectorAll('p[data-off]'));
      if (paras.length) return paras;
      return Array.prototype.slice.call(cont.children)
        .filter(n => !n.classList.contains('tr-page-tr'));
    }

    /* 「这一页 / 这一屏」的取景框。
       翻页模式（htmlPaged）取**当前那张 .html-page**，其它情况取可视区 #scrollLayer。
       以前这里只有 txt 竖排给了 viewport，富文本靠 closest('#scrollInner') 顺带拿到
       #scrollLayer，于是翻页模式下点「翻译本页」取的是「当前屏 + 后面 700px」——
       一屏一页的书正好多出一整页（用户实测：「范围不是屏幕显示的页，而是远超过」）。 */
    function transViewport(cont) {
      const Rb = getBook();
      if (Rb && Rb.format === 'html' && typeof Settings !== 'undefined' && Settings && Settings.htmlPaged) {
        const pg = document.querySelector('#scrollInner .html-page[data-idx="' + (Rb.pageIndex || 0) + '"]');
        if (pg) return pg;
      }
      const scrollish = cont && (cont.id === 'scrollInner' || (cont.closest && cont.closest('#scrollInner')));
      return scrollish ? document.querySelector('#scrollLayer') : null;
    }

    // 收集「本页可翻译的段落单元」。**段落是唯一的翻译单元**（R99）：
    // 面板「对照结果」与正文下方译文都从这一份数据出，条数与内容才对得上。
    // 以前面板走 translateBook(整页文本) 切成 320 字块、正文走「每个 DOM 段落」各自切块，
    // 两套切法边界不同 → 面板 8 条、正文 13 条（用户实测），而且面板前几条是「多段合并译文」。
    // strict=true：「本页」= 真的只在屏幕上的段落（点「翻译本页」用）；
    // strict=false：当前屏 + 后面一段（滚动补译 / 双语预取用，翻到下一页时译文已经就绪）。
    // takeover=true：无视别的轮次留下的 data-tr-doing，直接接管这些段落（面板「翻译本页」用）。
    //   正文的滚动补译一开跑就把整屏标成「正在译」，面板若照旧跳过 → 一段都收不到，
    //   于是误报「这一页没有可翻译的正文」（用户实测：取消勾选「只显示小窗已译的段落」后必现）。
    //   接管不会重复请求：块级缓存 _trMemo + 在途表 _inflight 会让两边共用同一个请求。
    function gatherJobs(cont, viewport, runId, strict, takeover) {
      const jobs = [];
      const box = viewport ? viewport.getBoundingClientRect() : null;
      const rid = String(runId || 1);
      // 留 2px 容差：块底边正好压在屏幕底边（或块顶边压在顶边）也算可见，
      // 否则「半行露在屏底」的那一段会被判成不可见，用户会觉得漏了一段。
      const topEdge = box ? box.top - (strict ? -2 : 200) : 0;
      const botEdge = box ? box.bottom + (strict ? -2 : 700) : 0;
      inlineCandidates(cont).forEach((node, idx) => {
        if (!node || node.classList.contains('tr-page-tr')) return;
        if (box) {
          if (node.dataset.trDoing && !takeover) return;                   // 别的轮次正在译这段
          const r = node.getBoundingClientRect();
          if (r.bottom <= topEdge || r.top >= botEdge) return;
        }
        const text = (node.textContent || '').trim();
        if (!text) return;
        if (!splitForTranslation(text).length) return;
        const job = { node: node, idx: idx, text: text };
        if (box) {
          // 已经贴着「这一代」的译文块 = 这段译过了（哪怕标记被清过）：把现成译文带上，
          // 不再请求、也不再插一条。这是「同一段出现两条相同译文」的最后一道闸门。
          // 注意只认同代的块：改了术语表/换了引擎之后，旧块必须让位重新翻（否则永远不更新）。
          const blk = _freshBlock(node);
          if (blk) {
            job.dst = blk.textContent || '';
            node.dataset.trDone = '1';
            delete node.dataset.trDoing;
          } else {
            node.dataset.trDoing = rid;   // 立刻占位，滚动补译不会重复
            job.marked = rid;             // 记下「是我占的」，收尾只摘自己的
          }
        }
        jobs.push(job);
      });
      return jobs;
    }

    /* R131（第 5 条）：「翻译中…」要**只要还在翻就一直挂着**，包括滚动到新一屏触发的
       实时补译（那一路不经过「翻译本页 / 全书」按钮，以前顶栏一个字都不显示，
       用户以为没反应，其实是本地引擎在慢慢跑）。
       做法是在唯一的请求出口 _requestChunk 上记在途计数，>0 就点亮灯。
       最短显示 260ms：命中缓存 / 本地词典时请求只有几毫秒，灯一闪反而像卡了一下。

       R132（第 3 条）：原来只有一个计数器，于是「翻译进行中勾上『只显示小窗已译的段落』」
       时，正文那几发在途请求已经没人要了，灯还得等它们全部返回才灭 —— 用户看到的就是
       「都勾了不跟随，怎么还显示翻译中」。现在每个在途请求带一个 tag（inline / panel），
       取消勾选 / 翻页作废正文那一批时，直接把 inline 的账划掉，灯立刻灭；
       面板自己的「翻译本页 / 全书」还在跑的话，那一笔照旧亮着。 */
    let _busySince = 0;
    let _busyOffT = null;
    let _busySeq = 0;
    const _busyLive = new Map();          // id -> 'inline' | 'panel'
    function _busyCount() { return _busyLive.size; }
    function _busyPaint() {
      const on = _busyCount() > 0;
      // R132（第 2 条）：阅读区那条胶囊 + 顶栏那一颗，一起亮一起灭
      const els = [document.getElementById('trBusy'), document.getElementById('barTrBusy')]
        .filter(Boolean);
      if (!els.length) return;
      if (on) {
        if (_busyOffT) { clearTimeout(_busyOffT); _busyOffT = null; }
        els.forEach((el) => { if (el.hidden) el.hidden = false; });
      } else if (els.some((el) => !el.hidden)) {
        const left = 260 - (Date.now() - _busySince);
        if (_busyOffT) clearTimeout(_busyOffT);
        _busyOffT = setTimeout(() => {
          _busyOffT = null;
          if (_busyCount() <= 0) els.forEach((el) => { el.hidden = true; });
        }, Math.max(0, left));
      }
    }
    /** 开一笔账，返回它的 id（translateParagraph 的 finally 要把这个 id 交回来） */
    function _busyBegin(tag) {
      if (!_busyCount()) _busySince = Date.now();
      const id = ++_busySeq;
      _busyLive.set(id, tag || 'panel');
      _busyPaint();
      return id;
    }
    function _busyEnd(id) {
      if (id == null) return;
      _busyLive.delete(id);
      _busyPaint();
    }
    /** 作废某一类在途账（tag 省略 = 全清）：立刻灭灯，不等那些已经没人要的请求返回。
     *  R132：这里是用户主动取消，不走「最短显示 260ms」—— 那道延时是防闪的，
     *  用在这儿会变成「点了不跟随，灯还赖着 0.26 秒」。 */
    function _busyDrop(tag) {
      if (tag) { for (const [id, t] of _busyLive) if (t === tag) _busyLive.delete(id); }
      else _busyLive.clear();
      if (_busyCount() > 0) { _busyPaint(); return; }
      if (_busyOffT) { clearTimeout(_busyOffT); _busyOffT = null; }
      [document.getElementById('trBusy'), document.getElementById('barTrBusy')]
        .forEach((el) => { if (el) el.hidden = true; });
    }
    // 挂到 global 上给最底层的 translateParagraph 用（它不在这个闭包里）
    global.__inkTrBusyBegin = _busyBegin;
    global.__inkTrBusyEnd = _busyEnd;
    global.__inkTrBusyDrop = _busyDrop;

    // 真正发请求的入口：同一块文本并发只发一次（见 _inflight 的注释）
    function _requestChunk(text, tag) {
      const key = _memoKey(text);
      if (!key) return InkTranslate.translateParagraph(text, { accumulate: true, busyTag: tag });
      const hit = _inflight.get(key);
      if (hit) return hit;
      const pr = Promise.resolve()
        .then(() => InkTranslate.translateParagraph(text, { accumulate: true, busyTag: tag }));
      _inflight.set(key, pr);
      // 无论成败都要摘掉，否则一次失败会让这段永远卡在「正在译」
      pr.then(() => {}, () => {}).then(() => { if (_inflight.get(key) === pr) _inflight.delete(key); });
      return pr;
    }

    // 把段落单元逐段翻译：段内仍按 splitForTranslation 切块并发（长段也快），
    // 块齐了拼回整段。opt.onUnit(u) 在每段译完时回调 → 面板边译边显示、正文边译边插。
    // 返回 { units, firstError }。units 里每项带 dst（失败的是「⚠️ 原因」）。
    async function translateUnits(units, opt) {
      opt = opt || {};
      const shouldStop = () => !!(opt.shouldStop && opt.shouldStop());
      const tasks = [];
      units.forEach((u) => {
        if (u.dst != null) return;            // 已有译文的段落（正文里复用来的）：不再请求
        u.chunks = splitForTranslation(u.text);
        u.parts = new Array(u.chunks.length);
        u.done = 0;
        u.chunks.forEach((c, i) => tasks.push({ u: u, i: i, text: c }));
      });
      if (!tasks.length) return { units: units, firstError: null };
      let finished = 0;
      let firstError = null;
      const limit = InkTranslate.chunkConcurrency();
      await mapLimit(tasks, limit, async (t) => {
        if (shouldStop()) return;                       // 停止后不再发起新请求
        let dst = _memoGet(_trMemo, t.text);            // 这段以前译过：直接用，不再请求
        if (dst == null) {
          try {
            dst = await _requestChunk(t.text, opt.busyTag);
            _memoPut(_trMemo, t.text, dst);
          } catch (e) {
            dst = '⚠️ ' + ((e && e.message) || e);
            if (!firstError) firstError = e;
          }
        }
        if (shouldStop()) return;                       // 在途请求回来时可能已被取消：不写结果
        t.u.parts[t.i] = dst;
        t.u.done++;
        finished++;
        if (t.u.done === t.u.parts.length) {
          t.u.dst = t.u.parts.filter((x) => x != null && x !== '').join('\n\n');
          if (opt.onUnit) { try { opt.onUnit(t.u); } catch (e) { /* 渲染异常不影响翻译 */ } }
        }
        if (opt.onProgress) { try { opt.onProgress(finished, tasks.length); } catch (e) {} }
      });
      return { units: units, firstError: firstError };
    }

    /* 每个原文节点最多只挂一条译文块。
       只靠「摘掉紧邻的 .tr-page-tr」是不够的：一旦某次插入的锚点不是那个节点
       （缓存里的段落序号在新 DOM 里对不上、章节重新渲染过），旧代码会走
       `cont.appendChild()` 直接堆到正文末尾 —— 反复触发就变成末尾一坨
       一模一样的译文（用户实测 4 条）。这里用 WeakMap 记账，插之前先把它清掉；
       真正找不到锚点时宁可不显示，也绝不往末尾堆。 */
    const _trBlockOf = new WeakMap();
    function _dropTrBlock(node) {
      if (!node) return;
      const b = _trBlockOf.get(node);
      if (b && b.parentNode) b.remove();
      _trBlockOf.delete(node);
      let nx = node.nextElementSibling;
      while (nx && nx.classList && nx.classList.contains('tr-page-tr')) {
        const next = nx.nextElementSibling;
        nx.remove();
        nx = next;
      }
    }

    function insertTranslated(cont, node, text) {
      // 没有锚点 = 不知道这条该贴哪。宁可少一条，也不要叠到正文末尾。
      if (!node || !node.parentNode) return null;
      _dropTrBlock(node);
      const d = document.createElement('div');
      d.className = 'tr-page-tr';
      d.textContent = text;
      d.dataset.gen = _GEN();          // 记下是第几代译文（改术语表后靠它判断新旧）
      node.insertAdjacentElement('afterend', d);
      _trBlockOf.set(node, d);
      node.dataset.trDone = '1';
      delete node.dataset.trDoing;
      return d;
    }

    /* PDF 页下译文：译当前可见页，插在该页画布正下方。
       不去碰 PDF 的绝对定位文字层，只往 #pdfStack（flex column）里插 block，布局天然不动。 */
    const _pdfTrBusy = new Set();
    let _pdfTrScrollT = null;
    async function renderPdfInline() {
      const stack = document.querySelector('#pdfStack');
      const layer = document.querySelector('#pdfLayer');
      if (!stack || !layer) return;
      if (!InkTranslate.state.inlineBilingual) {
        stack.querySelectorAll('.pdf-tr-block').forEach(n => n.remove());
        stack.querySelectorAll('.pdf-page').forEach(cv => { delete cv.dataset.trDone; });
        return;
      }
      const box = layer.getBoundingClientRect();
      const cvs = Array.prototype.slice.call(stack.querySelectorAll('.pdf-page[data-idx]'));
      for (const cv of cvs) {
        const r = cv.getBoundingClientRect();
        if (r.bottom < box.top - 80 || r.top > box.bottom + 200) continue;   // 只处理当前屏 + 下半屏
        const idx = parseInt(cv.dataset.idx, 10);
        if (!isFinite(idx) || _pdfTrBusy.has(idx)) continue;
        // 上一代译文（改过术语表 / 换过引擎）不算「已译」：重译并替换，否则永远不更新
        const oldBlk = (cv.nextElementSibling && cv.nextElementSibling.classList
          && cv.nextElementSibling.classList.contains('pdf-tr-block')) ? cv.nextElementSibling : null;
        if (cv.dataset.trDone === '1' && oldBlk && oldBlk.dataset.gen === _GEN()) continue;
        const text = pdfPageText(idx);
        if (!text) continue;                                                 // 无文字层（扫描页）：跳过
        // R130（第 7 条）：「只显示小窗已译的段落」对 PDF 也生效 ——
        // 面板没译过这一页就什么都不做（不发请求），滚到下一屏也不会自己补译。
        if (InkTranslate.state.inlineFollowPanel) {
          const dst = _panelDstFor(text);
          if (dst == null) continue;
          const d0 = document.createElement('div');
          d0.className = 'pdf-tr-block';
          d0.dataset.idx = String(idx);
          d0.dataset.gen = _GEN();
          String(dst).split('\n').forEach((line) => {
            const p0 = document.createElement('p');
            p0.textContent = line;
            d0.appendChild(p0);
          });
          if (oldBlk && oldBlk.parentNode) oldBlk.remove();
          cv.insertAdjacentElement('afterend', d0);
          cv.dataset.trDone = '1';
          continue;
        }
        _pdfTrBusy.add(idx);
        try {
          const out = await InkTranslate.translateBook(text, null, { busyTag: 'inline' });
          if (!InkTranslate.state.inlineBilingual) return;
          const d = document.createElement('div');
          d.className = 'pdf-tr-block';
          d.dataset.idx = String(idx);
          d.dataset.gen = _GEN();
          out.forEach(o => { const p = document.createElement('p'); p.textContent = o.dst; d.appendChild(p); });
          if (!d.childNodes.length) continue;
          if (oldBlk && oldBlk.parentNode) oldBlk.remove();      // 摘掉旧的那块再贴新的
          cv.insertAdjacentElement('afterend', d);
          cv.dataset.trDone = '1';
          setStatus('第 ' + (idx + 1) + ' 页译文已显示在页面下方');
        } catch (e) {
          setStatus('PDF 页下译文失败：' + ((e && e.message) || e));
        } finally { _pdfTrBusy.delete(idx); }
      }
    }

    /* 图片书页下译文：识别过文字的页，把译文接在那张图下方（和 PDF 页下译文同一套样式）。
       ⚠️ 只在卷轴模式插：分页模式下 #imgLayer 是 flex 行、图片按高度撑满一屏，
          插一个 block 会把图挤小半屏（用户要的是「像 PDF」，不是「把图压扁」）。
          分页模式看小窗的对照结果即可 —— 状态条会说明一句。 */
    const _imgTrBusy = new Set();
    async function renderImgInline() {
      const cont = document.querySelector('#imgLayer');
      if (!cont) return;
      if (!InkTranslate.state.inlineBilingual) {
        cont.querySelectorAll('.pdf-tr-block').forEach((n) => n.remove());
        cont.querySelectorAll('.comic-img').forEach((im) => { delete im.dataset.trDone; });
        return;
      }
      if (!(typeof comicScrollOn === 'function' && comicScrollOn())) return;
      const box = cont.getBoundingClientRect();
      const imgs = Array.prototype.slice.call(cont.querySelectorAll('.comic-img'));
      for (const im of imgs) {
        const r = im.getBoundingClientRect();
        if (r.bottom < box.top - 80 || r.top > box.bottom + 200) continue;   // 只处理当前屏 + 下半屏
        const idx = parseInt(im.dataset.idx, 10);
        if (!isFinite(idx) || _imgTrBusy.has(idx)) continue;
        const text = (typeof imgPageText === 'function') ? imgPageText(idx) : '';
        if (!text) continue;                                                  // 还没识别文字：跳过
        const oldBlk = (im.nextElementSibling && im.nextElementSibling.classList
          && im.nextElementSibling.classList.contains('pdf-tr-block')) ? im.nextElementSibling : null;
        if (im.dataset.trDone === '1' && oldBlk && oldBlk.dataset.gen === _GEN()) continue;
        // R130（第 7 条）：图片书同样支持「只显示小窗已译的段落」—— 面板没译文就不请求。
        if (InkTranslate.state.inlineFollowPanel) {
          const dst0 = _panelDstFor(text);
          if (dst0 == null) continue;
          const b0 = document.createElement('div');
          b0.className = 'pdf-tr-block';
          b0.dataset.idx = String(idx);
          b0.dataset.gen = _GEN();
          String(dst0).split('\n').forEach((line) => {
            const p0 = document.createElement('p');
            p0.textContent = line;
            b0.appendChild(p0);
          });
          if (oldBlk && oldBlk.parentNode) oldBlk.remove();
          im.insertAdjacentElement('afterend', b0);
          im.dataset.trDone = '1';
          if (typeof scheduleImgLayerSync === 'function') scheduleImgLayerSync();
          continue;
        }
        _imgTrBusy.add(idx);
        try {
          const out = await InkTranslate.translateBook(text, null, { busyTag: 'inline' });
          if (!InkTranslate.state.inlineBilingual) return;
          const d = document.createElement('div');
          d.className = 'pdf-tr-block';
          d.dataset.idx = String(idx);
          d.dataset.gen = _GEN();
          out.forEach((o) => { const p = document.createElement('p'); p.textContent = o.dst; d.appendChild(p); });
          if (!d.childNodes.length) continue;
          if (oldBlk && oldBlk.parentNode) oldBlk.remove();
          im.insertAdjacentElement('afterend', d);
          im.dataset.trDone = '1';
          // 插了块会把下面所有图往下推 → 文字层要重新摆位置
          if (typeof scheduleImgLayerSync === 'function') scheduleImgLayerSync();
          setStatus('第 ' + (idx + 1) + ' 页译文已显示在图片下方');
        } catch (e) {
          setStatus('图片页下译文失败：' + ((e && e.message) || e));
        } finally { _imgTrBusy.delete(idx); }
      }
    }

    // 竖排模式：滚到哪儿译到哪儿（节流，避免每帧都触发）
    let _scrollTimer = null;
    let _vertBound = null;
    function onVertScroll() {
      if (_scrollTimer) return;
      _scrollTimer = setTimeout(() => {
        _scrollTimer = null;
        if (InkTranslate.state.inlineBilingual) renderInlineForPage();
      }, 600);
    }

    /* 「只显示小窗已译的段落」模式专用：只贴 _panelMemo 里有的段落，绝不发请求。
       滚到没译过的地方（C）就保持原文 —— 这是用户明确要的「跟随小窗范围」。 */
    function renderInlineFollow(cont, isVert) {
      if (!cont) return;
      const viewport = isVert ? document.querySelector('#scrollLayer') : null;
      const box = viewport ? viewport.getBoundingClientRect() : null;
      inlineCandidates(cont).forEach((node) => {
        if (!node || !node.classList || node.classList.contains('tr-page-tr')) return;
        if (box) {
          const r = node.getBoundingClientRect();
          if (r.bottom < box.top - 200 || r.top > box.bottom + 700) return;   // 同 gatherJobs 的取景范围
        }
        const text = (node.textContent || '').trim();
        if (!text) return;
        const dst = _panelDstFor(text);
        if (dst == null) return;                                              // 小窗没译过 → 不显示、也不请求
        const nx = node.nextElementSibling;
        if (nx && nx.classList && nx.classList.contains('tr-page-tr') && nx.textContent === dst) return;
        insertTranslated(cont, node, dst);
      });
    }

    // pre：可选的「已译好的段落单元」数组（点「翻译本页」时把同一批结果直接喂过来，
    //      每项带 node/dst —— 同一批 DOM 节点，所以不会再译一遍、也不会贴错段）。
    // 注意 pre 的语义在 R99 改过：以前是「整页文本按 320 字切出的块译文」，
    // 与正文「每段各自切块」的顺序对不上，贴出来张冠李戴、条数也不一样。
    async function renderInlineForPage(pre) {
      // PDF / 图片书先分流：它们没有「按段落排版的正文节点」，得走「页下整块译文」那条路。
      // R131：这一步放到取 cont 之前 —— 万一 #pageText 不在（PDF 视图下有可能），
      // 以前会直接 return，于是 follow 勾选 / 翻页都推不动 PDF 的译文。
      const Rb0 = getBook();
      if (Rb0 && Rb0.format === 'pdf') { renderPdfInline(); return; }
      if (Rb0 && Rb0.format === 'comic') { renderImgInline(); return; }
      const cont = inlineHost();
      if (!cont) return;
      const Rb = getBook();
      if (Rb && Rb.format === 'pdf') { renderPdfInline(); return; }
      if (Rb && Rb.format === 'comic') { renderImgInline(); return; }
      // 富文本容器（.html-book）也在 #scrollInner 里 → 同样按「滚动增量补译」处理，
      // 否则会一次性把整本书（几千段）全丢给引擎。
      const isVert = cont.id === 'scrollInner' || !!(cont.closest && cont.closest('#scrollInner'));
      // 横排：翻页要让上一页的在途请求作废；竖排：滚动补译是同一批的延续，不能互相作废
      const myToken = isVert ? _inlineToken : ++_inlineToken;
      // 竖排不能每次都清：滚动补译时旧译文要留着（靠节点标记去重），
      // 只有取消勾选 / 翻页（横排）才真正清场 —— 见 tpInline 的 change 与 clearInline 调用处。
      if (!isVert) clearInline();
      if (!InkTranslate.state.inlineBilingual) return;
      const R = getBook();
      if (!R || !R.text) return;
      if (!String(currentPageText() || '').trim()) return;
      const key = (R.id || R.title || '') + '#' + R.pageIndex;

      // 「翻译本页」刚译好的那一批：直接贴，不再进翻译（同源 = 面板与正文必然一致）
      if (Array.isArray(pre) && pre.length) {
        pre.forEach((u) => {
          if (!u || u.dst == null || !u.node) return;
          if (!InkTranslate.state.inlineBilingual) return;
          // 竖排复用项本来就已经贴在正文里了，别再插一条；
          // 但只认「这一代」的块 —— 改过术语表之后旧块要换成新译文。
          if (_freshBlock(u.node)) return;
          insertTranslated(cont, u.node, u.dst);
        });
        if (!isVert) {
          _inlineCache[key] = pre.filter((u) => u && u.dst != null)
            .map((u) => ({ idx: u.idx, src: u.text, dst: u.dst }));
        }
        return;
      }

      // 「只显示小窗已译的段落」：一个字都不发请求，只把面板译过的段落贴到原文下方。
      if (InkTranslate.state.inlineFollowPanel) { renderInlineFollow(cont, isVert); return; }

      // 缓存命中（仅横排：竖排靠节点标记）：按原文节点序号贴回去，翻页回来是瞬时的
      const cached = isVert ? null : _inlineCache[key];
      if (cached) {
        // 老格式（整页一条字符串）已经没有锚点了：直接丢掉，交给下面重新按段翻。
        // 以前这里 insertTranslated(cont, null, cached) 会 append 到正文末尾，
        // 每翻回来一次多一条，很快就是一坨重复译文。
        if (typeof cached === 'string') { delete _inlineCache[key]; }
        else {
          // 用「可翻译块」数组定位（与 gatherJobs 同一套候选，剔除译文块后的第 idx 段），
          // 而非 cont.children[idx] —— 缓存写入时译文块已插入 DOM，children[idx] 会指向错节点（修 #11）。
          // 序号对不上（章节重渲染、分页变了）就跳过这一段，绝不兜底往末尾插。
          const paras = inlineCandidates(cont);
          cached.forEach((it) => {
            const node = paras[it.idx];
            if (node) insertTranslated(cont, node, it.dst);
          });
          return;
        }
      }
      if (_inlineBusy > 0 && !isVert) return;  // 横排：上一页还在译，别叠两层
      const runId = ++_inlineSeq;
      const jobs = gatherJobs(cont, transViewport(cont), runId);
      if (!jobs.length) return;
      _inlineBusy++;
      let firstError = null;
      try {
        const res = await translateUnits(jobs, {
          busyTag: 'inline',                     // R132：正文补译算 inline 活，作废时账一起划掉
          // 关键：本地引擎慢，用户可能在翻译途中取消勾选 / 翻页。
          // 停止条件里带上开关状态，否则 clearInline 清掉的块会被在途请求又贴回来。
          shouldStop: () => myToken !== _inlineToken || !InkTranslate.state.inlineBilingual,
          onUnit: (u) => {
            if (myToken !== _inlineToken) return;      // 已翻页，别往新页上贴
            if (!InkTranslate.state.inlineBilingual) return;
            insertTranslated(cont, u.node, u.dst);
          }
        });
        firstError = res.firstError;
      } finally {
        // 无条件归零：任务被翻页 / 清空作废时，闸门也得放开，
        // 否则下一轮的横排翻译会被自己的旧闸门挡死。
        _inlineBusy = Math.max(0, _inlineBusy - 1);
      }
      // 没译完的段落把占位标记摘掉，否则滚动补译会永远跳过它。
      // 只摘「自己这一轮贴的」：新一轮可能已经接管了这些段落，摘了它的标记就会
      // 让同一段被两轮各译一次、各贴一条（R101 的「重复译文」）。
      jobs.forEach((u) => {
        if (u.dst == null && u.marked && u.node && u.node.dataset.trDoing === u.marked) delete u.node.dataset.trDoing;
      });
      if (myToken !== _inlineToken) return;
      // 存缓存（按原文节点序号），翻回来直接贴。竖排靠节点标记，不进缓存。
      // 取消勾选时（inlineBilingual 已 false）不要写缓存，否则翻回来又冒出来。
      if (!isVert && InkTranslate.state.inlineBilingual) {
        _inlineCache[key] = jobs
          .filter((u) => u.dst != null)
          .map((u) => ({ idx: u.idx, src: u.text, dst: u.dst }));
      }
      if (firstError) setStatus('双语对照部分段落失败：' + (firstError.message || firstError));
    }

    // 包一层 window.renderPage：阅读器翻页后若开着双语，自动把新页译文补上。
    // 用标志位避免重复包装（init 有可能跑多次）。
    if (!global.__inkRenderPageWrapped && typeof window !== 'undefined' &&
        typeof window.renderPage === 'function') {
      const _orig = window.renderPage;
      window.renderPage = function () {
        const r = _orig.apply(this, arguments);
        if (InkTranslate.state && InkTranslate.state.inlineBilingual) {
          setTimeout(renderInlineForPage, 0);
        }
        return r;
      };
      global.__inkRenderPageWrapped = true;
    }

    // 包一层 window.openBook：打开 / 切换书时，把目标语言下拉刷新成「这本书自己的」设定
    // （或全局默认），让 UI 显示与翻译实际用的目标语言一致。用标志位避免重复包装。
    if (!global.__inkOpenBookWrapped && typeof window !== 'undefined' &&
        typeof window.openBook === 'function') {
      const _origOpen = window.openBook;
      window.openBook = function (book) {
        const r = _origOpen.apply(this, arguments);
        // openBook 是 async，等它把 R.book 设好后再刷新下拉
        Promise.resolve(r).finally(() => {
          if (elTarget) elTarget.value = InkTranslate.getBookTargetLang();
          // R130（第 5 条）：第一次进一本书时，默认勾上「只显示小窗已译的段落（不自动补译）」，
          // 免得还没点翻译、正文就自己开跑（本地引擎慢、在线引擎花钱）。
          // 按「书记一次来过」：同一本书第二次打开就按用户上次的选择来，不再强行勾上。
          try { followDefaultForNewBook(book); } catch (e) { }
          // 换书后正文容器是新的：开着双语就补译新书当前页，否则要等翻页才出现译文
          if (InkTranslate.state.inlineBilingual) setTimeout(() => { try { renderInlineForPage(); } catch (e) {} }, 300);
        });
        return r;
      };
      global.__inkOpenBookWrapped = true;
    }

    /** 新书默认「只显示小窗已译的段落」：用 localStorage 记一份「来过哪些书」，
     *  第一次打开的书自动把开关打开；之后按用户自己的选择，不再动它。 */
    const _FOLLOW_SEEN_KEY = 'ink.tr.openedBooks';
    function followDefaultForNewBook(book) {
      const id = book && book.id;
      if (!id) return;
      let seen = null;
      try { seen = JSON.parse(localStorage.getItem(_FOLLOW_SEEN_KEY) || 'null'); } catch (e) { seen = null; }
      if (!seen || typeof seen !== 'object' || Array.isArray(seen)) seen = {};
      if (seen[id]) return;                       // 来过：尊重用户当前设置
      seen[id] = 1;
      // 只留最近 400 本，避免 localStorage 无限长胖（字典本身很小）
      const ids = Object.keys(seen);
      if (ids.length > 400) ids.slice(0, ids.length - 400).forEach((k) => { delete seen[k]; });
      try { localStorage.setItem(_FOLLOW_SEEN_KEY, JSON.stringify(seen)); } catch (e) { }
      InkTranslate.setInlineFollowPanel(true);
      if (elFollow) elFollow.checked = true;
    }

    // 竖排（上下滚动）不走 renderPage，是 switchMode 重建 #scrollInner 的，
    // 所以「切换翻页方向」和「滚动」这两个入口得单独挂上，否则竖排下双语完全不动。
    const dirBtn = document.querySelector('#dirBtn');
    if (dirBtn) {
      dirBtn.addEventListener('click', () => {
        if (!InkTranslate.state.inlineBilingual) return;
        clearInline();                                  // 换容器了，旧译文先清掉
        setTimeout(renderInlineForPage, 400);           // 等 switchMode 把正文重建完
      });
    }
    const scrollLayer = document.querySelector('#scrollLayer');
    if (scrollLayer) scrollLayer.addEventListener('scroll', onVertScroll, { passive: true });
    const pdfLayerEl = document.querySelector('#pdfLayer');
    if (pdfLayerEl) pdfLayerEl.addEventListener('scroll', () => {
      if (!InkTranslate.state.inlineBilingual) return;
      if (_pdfTrScrollT) return;
      _pdfTrScrollT = setTimeout(() => { _pdfTrScrollT = null; renderPdfInline(); }, 700);
    }, { passive: true });

    /* ── 对照结果：按「页」分节 + 可折叠（R148） ─────────────────────────
       用户实测：译完 A 页再翻到 B 页点「翻译本页」，A 页那批结果被
       `elResult.innerHTML = ''` 一次清光，想对照上一页只能翻回去重译。
       现在每页一个「折叠节」：译新页只写自己那一节，别的页留着（自动折起来，
       点标题就能展开）；「清除译文」才真的全清。
       全书翻译单独一节（key='book'），它本来就要求整本一起看，会把各页节替换掉。 */
    let _panelBookId = '';                 // 换书就把分节清空，别把上一本的「第 3 页」带过来
    const _panelSecs = new Map();          // key → { el, body, title, meta, collapsed, count }
    let _activeSec = null;                 // 当前正在往哪一节里追加

    function panelReset() {
      _panelSecs.clear();
      _activeSec = null;
      elResult.innerHTML = '';
    }

    /** 当前这一屏是第几页（0 基）。口径必须和 currentPageText() 一致，
     *  否则会出现「译的是第 5 页、标成第 4 页」。R149 从 panelPageMeta 里抽出来，
     *  「先识别再翻译」也要用同一个页码。 */
    function currentPageIndex() {
      const R = getBook();
      if (!R) return 0;
      if (R.format === 'comic') {
        return (typeof comicVisibleIndex === 'function') ? comicVisibleIndex() : (R.pageIndex || 0);
      }
      if (R.format === 'pdf') {
        // 卷轴滚动时 R.pageIndex 延迟上报 → 取屏幕上方第一页（和 currentPageText 同一套）
        const vis = Array.prototype.filter.call(
          document.querySelectorAll('#pdfStack .pdf-page[data-idx]'),
          cv => { const r = cv.getBoundingClientRect(); return r.bottom > 8 && r.top < window.innerHeight - 8; });
        const i = vis.length ? parseInt(vis[0].dataset.idx, 10) : (R.pageIndex || 0);
        return isFinite(i) ? i : 0;
      }
      return R.pageIndex || 0;
    }

    function panelPageMeta() {
      const R = getBook();
      if (!R) return { key: 'p0', label: '本页' };
      if (R.format === 'comic') {
        const ci = currentPageIndex();
        return { key: 'c' + ci, label: '第 ' + (ci + 1) + ' 页' };
      }
      if (R.format === 'pdf') {
        const i = currentPageIndex();
        return { key: 'p' + i, label: '第 ' + (i + 1) + ' 页' };
      }
      if (R.format === 'html') {
        const paged = !!(typeof Settings !== 'undefined' && Settings && Settings.htmlPaged);
        const i = R.pageIndex || 0;
        return { key: 'p' + i, label: paged ? ('第 ' + (i + 1) + ' 页') : '当前屏' };
      }
      // txt：竖排滚动时 R.pageIndex 不跟着滚，按 locator 反查（否则每节都叫「第 1 页」）
      let i = R.pageIndex || 0;
      if (typeof Settings !== 'undefined' && Settings && Settings.direction === 'vertical' &&
          typeof pageIndexForOffset === 'function') {
        const off = (R.book && typeof R.book.locator === 'number') ? R.book.locator : 0;
        const pi = pageIndexForOffset(off);
        if (isFinite(pi)) i = pi;
      }
      return { key: 'p' + i, label: '第 ' + (i + 1) + ' 页' };
    }

    /** 节的排序值：p12 / c3 → 12 / 3；'book'（全书）排最前当总览。
     *  取不到页码的排最后，不要因为一个怪 key 把整列表顺序搞乱。 */
    function panelSecOrder(key) {
      const s = String(key || '');
      if (s === 'book') return -1;
      const m = /^[a-z]*(\d+)$/.exec(s);
      return m ? parseInt(m[1], 10) : 1e9;
    }

    /** 按页码插到正确位置（R151）：先翻第 10 页、再回第 3 页，面板也得是 3 在前。
     *  以前一律 appendChild，顺序就是「你翻页的顺序」，回头补译就乱了。 */
    function insertSectionSorted(el) {
      const mine = panelSecOrder(el.dataset.key);
      const kids = Array.prototype.slice.call(elResult.children);
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        if (!k.classList || !k.classList.contains('tr-sec')) continue;
        if (panelSecOrder(k.dataset.key) > mine) {
          elResult.insertBefore(el, k);
          return;
        }
      }
      elResult.appendChild(el);
    }

    /** 取（或新建）某一节，并把「其它页」折起来 —— 只折不清，内容还在。 */
    function panelSection(meta, opts) {
      const R = getBook();
      const bid = (R && (R.id || R.title)) || '';
      if (bid !== _panelBookId) { _panelBookId = bid; panelReset(); }
      let sec = _panelSecs.get(meta.key);
      if (!sec) {
        const el = document.createElement('div');
        el.className = 'tr-sec';
        el.dataset.key = meta.key;
        el.innerHTML = '<button class="tr-sec-head" type="button">' +
          '<span class="tr-sec-caret">▾</span>' +
          '<span class="tr-sec-title"></span>' +
          '<span class="tr-sec-meta"></span>' +
          '</button><div class="tr-sec-body"></div>';
        const body = el.querySelector('.tr-sec-body');
        const made = {
          el: el, body: body,
          title: el.querySelector('.tr-sec-title'),
          meta: el.querySelector('.tr-sec-meta'),
          collapsed: false, count: 0
        };
        el.querySelector('.tr-sec-head').addEventListener('click', () => {
          made.collapsed = !made.collapsed;
          el.classList.toggle('collapsed', made.collapsed);
        });
        insertSectionSorted(el);
        sec = made;
        _panelSecs.set(meta.key, sec);
        // 新节插到哪就滚到哪：按页码排序后新节不一定在末尾，盲滚到底会看不到它
        try {
          const top = el.offsetTop - elResult.offsetTop;
          elResult.scrollTop = Math.max(0, top - 8);
        } catch (e) {
          elResult.scrollTop = elResult.scrollHeight;
        }
      }
      sec.title.textContent = meta.label;
      if (!opts || !opts.keepOthers) {
        _panelSecs.forEach((s, k) => {
          if (k === meta.key) return;
          s.collapsed = true;
          s.el.classList.add('collapsed');
        });
      }
      sec.collapsed = false;
      sec.el.classList.remove('collapsed');
      sec.el.classList.remove('tr-sec-stale');
      _activeSec = sec;
      return sec;
    }

    function panelStatus(sec, text) {
      if (sec && sec.meta) sec.meta.textContent = text || '';
    }

    /** 某一页的识别结果变了（重新 OCR / 清除），面板里那一节就标成「要重译」。
     *  reader.js 在 OCR 前后调用；没有这一节就什么都不做。 */
    function markPageStale(pageKey, reason) {
      const sec = _panelSecs.get(String(pageKey));
      if (!sec) return false;
      sec.el.classList.add('tr-sec-stale');
      sec.meta.textContent = reason || '识别已更新';
      return true;
    }
    // reader.js 清了 / 重做了某一页 OCR 之后调它（key 与 panelPageMeta 同一套：c3 / p12）
    global.__inkMarkPageStale = markPageStale;

    function resultItem(it, sec) {
      const s = sec || _activeSec;
      const d = document.createElement('div');
      d.className = 'tr-item';
      d.innerHTML = '<div class="tr-src"></div><div class="tr-dst"></div>';
      d.querySelector('.tr-src').textContent = it.src;
      d.querySelector('.tr-dst').textContent = it.dst;
      (s ? s.body : elResult).appendChild(d);
      if (s) s.count++;
    }

    function renderResult(items) {
      if (_activeSec) _activeSec.body.innerHTML = '';
      else elResult.innerHTML = '';
      items.forEach(resultItem);
    }

    // 边译边显示：从 from 开始把新译出的段追加进去（全书几百段时不至于干等半小时）
    // sec：显式指定往哪一节写 —— 长任务跑着的时候用户可能又点了别的页，
    // 靠 _activeSec 会串到别的节里去（虽然有 runToken 兜着，显式传更稳）。
    function appendResultFrom(items, from, sec) {
      for (let i = from; i < items.length; i++) resultItem(items[i], sec);
    }

    // 「停止」按钮：翻译中把 shouldStop 置真，translateBook 会在下一段开始前退出
    let _stopFlag = false;
    // 运行令牌：每次「翻译本页 / 全书」自增一个；旧任务在发现令牌已被新任务顶掉时，
    // 它的增量回调与收尾都直接舍弃，避免「翻译还在跑又点一次」把结果重复写进面板。
    let _runToken = 0;
    const elStop = $('tpStop');
    elStop.addEventListener('click', () => {
      _stopFlag = true;
      elStop.disabled = true;
      elStop.textContent = '停止中…';
    });
    function beginRun() {
      _stopFlag = false;
      elStop.hidden = false;
      elStop.disabled = false;
      elStop.textContent = '■ 停止';
      setRunBadge('翻译中');
    }
    function endRun() {
      elStop.hidden = true;
      elStop.disabled = false;
      setRunBadge('');
    }

    /* 叉掉小窗 ≠ 取消翻译（用户确认这个语义：关掉小窗就该能在正文里接着看它翻完）。
       但「看不见也停不了」不行 —— 后台还在跑的时候，顶栏那个「🌐 翻译」按钮上直接显示进度，
       点一下回到面板就能按「停止」。只有「翻译本页 / 全书」这种点按钮发起的长任务才挂标记，
       滚动补译是常驻行为，不打扰。 */
    function setRunBadge(t) {
      if (!btn) return;
      const on = !!t;
      btn.classList.toggle('busy', on);
      btn.title = on
        ? '翻译还在后台跑（点开可以按「停止」）'
        : '全文翻译 / 术语表 / 插件';
      const txt = on ? ('🌐 翻译 · ' + t) : '🌐 翻译';
      if (btn.textContent !== txt) btn.textContent = txt;
    }

    // reader.js 里 R 是「顶层 const」，进的是全局词法环境，不会挂到 window 上，
    // 所以这里必须用裸标识符 R（经典脚本之间共享同一套全局词法绑定），
    // 不能用 window.R / global.R（那个是 undefined）。
    function getBook() {
      try {
        if (typeof R !== 'undefined' && R && typeof R.text !== 'undefined') return R;
      } catch (e) { /* R 未定义时 typeof 不抛，这里再兜底一次 */ }
      return null;
    }

    /** PDF 单页文字：优先用已缓存的整本文字（书内搜索时建好的），
     *  否则从该页的文字层 span 现拼（数字版 / OCR 页都适用）。 */
    function pdfPageText(idx) {
      const R = getBook();
      if (!R) return '';
      // R126：扫描页（OCR 出来的词框）按几何切成自然段再翻 —— 整页一坨翻出来没法读。
      // 只在「本页有 OCR 词框」时生效；数字版 PDF 有真文字层，走下面的原路。
      const wrec = R._ocrWords && R._ocrWords[idx];
      if (wrec && wrec.words && wrec.words.length && typeof ocrParasOf === 'function') {
        const ps = ocrParasOf(wrec);
        if (ps.length) return ps.join('\n');
      }
      if (R._pdfText && R._pdfText[idx]) return R._pdfText[idx];
      const cv = document.querySelector('#pdfStack .pdf-page[data-idx="' + idx + '"]');
      const spans = cv && cv._textLayer ? cv._textLayer.querySelectorAll('span') : [];
      return Array.prototype.map.call(spans, s => s.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
    }

    function currentPageText() {
      const R = getBook();
      if (!R) return '';
      // 图片书：识别过文字的页就是「这一页的正文」，取眼前这一张（卷轴模式按可视区反查）
      if (R.format === 'comic') {
        const idx = (typeof comicVisibleIndex === 'function') ? comicVisibleIndex() : (R.pageIndex || 0);
        return (typeof imgPageText === 'function') ? imgPageText(idx) : '';
      }
      // PDF：文字层是透明叠层（用户看不出「到底认出来没有」），但文本是可取的。
      // 这里让「翻译本页」对 PDF 也能用（之前直接落到 R.text 分支 → 永远提示「没有可翻译的正文」）。
      if (R.format === 'pdf') {
        // 取「当前屏幕上第一页」而不是 R.pageIndex：PDF 卷轴滚动时 pageIndex 是延迟上报的，
        // 直接用会译到上一页（用户实测：译文不是从眼前这页开始）。
        const vis = Array.prototype.filter.call(
          document.querySelectorAll('#pdfStack .pdf-page[data-idx]'),
          cv => { const r = cv.getBoundingClientRect(); return r.bottom > 8 && r.top < window.innerHeight - 8; });
        const idx = vis.length ? parseInt(vis[0].dataset.idx, 10) : (R.pageIndex || 0);
        return pdfPageText(isFinite(idx) ? idx : 0);
      }
      // 富文本（html/epub/docx）：没有按页分页，按当前视口可见正文翻译（#9）
      if (R.format === 'html') return (typeof htmlVisibleText === 'function') ? htmlVisibleText() : (R.text || '');
      // 竖排滚动模式：R.pageIndex 不随滚动更新（reportScroll 只改 R.book.locator），
      // 若直接读 R.pages[R.pageIndex] 会永远落在第 1 页 —— 这就是「小屏翻译总从第 1 页开始」的根因。
      // 这里按当前滚动偏移反查「当前屏 + 下一屏」，与双语对照（renderInlineForPage）范围一致。
      const vert = (typeof Settings !== 'undefined' && Settings && Settings.direction === 'vertical');
      // 卷轴模式：从「当前屏幕第一段」开始，而不是所在页的开头。
      // （用户实测：卷轴翻译不是从眼前这屏开始；一屏译出几十条、跟翻页模式对不上。）
      if (R.format === 'txt' && vert) {
        const layer = document.querySelector('#scrollLayer');
        const ps = Array.prototype.slice.call(document.querySelectorAll('#scrollInner p[data-off]'));
        if (layer && ps.length) {
          const box = layer.getBoundingClientRect();
          let startOff = null, endOff = null;
          for (const p of ps) {
            const r = p.getBoundingClientRect();
            if (r.bottom < box.top) continue;                     // 屏上方
            if (r.top > box.bottom + box.height * 0.8) break;     // 当前屏 + 大半屏
            const off = parseInt(p.dataset.off, 10);
            if (!isFinite(off)) continue;
            if (startOff === null) startOff = off;
            endOff = off + (p.textContent || '').length;
          }
          if (startOff !== null && endOff > startOff) return R.text.slice(startOff, endOff);
        }
      }
      if (R.format === 'txt' && vert && typeof pageIndexForOffset === 'function') {
        let off = 0;
        if (R.book && typeof R.book.locator === 'number') off = R.book.locator;
        const pi = pageIndexForOffset(off);
        const p = R.pages && R.pages[pi];
        const q = R.pages && R.pages[pi + 1];
        if (p) return R.text.slice(p.start, q ? q.end : p.end);
        return R.text;
      }
      const p = R.pages && R.pages[R.pageIndex];
      return p ? R.text.slice(p.start, p.end) : R.text;
    }

    /** 扫描页没有文字层时的兜底面板：一个按钮，识别完自动接着翻。
     *
     *  为什么不直接自动跑：本地模型一页要 2~3 分钟，静悄悄跑用户会以为程序卡死；
     *  点一下明确知道在干什么（按钮自己会变成「正在识别…」）。
     *  format：'pdf' | 'comic'，决定调 reader.js 的哪条识别通道。 */
    function panelNeedOcr(sec, format) {
      sec.body.innerHTML = '';
      sec.count = 0;
      panelStatus(sec, '这一页还没识别文字');
      const d = document.createElement('div');
      d.className = 'tr-need-ocr';
      d.innerHTML = '<p>这一页没有文字（扫描页或识别已清除），先识别再翻。</p>' +
        '<button type="button" class="tr-need-ocr-btn">🔍 先识别这一页，再翻译</button>';
      const btn = d.querySelector('button');
      btn.addEventListener('click', async () => {
        const b = getBook();
        if (b && b._ocrRunning) {
          setStatus('正在识别别的页，等它完成再翻这一页');
          return;
        }
        btn.disabled = true;
        btn.textContent = '识别中…（约 2–3 分钟/页）';
        panelStatus(sec, '识别中…');
        try {
          const text = await runPageOcr(format);
          if (!text) throw new Error('这一页没认出文字（可能是空白页，或图片太模糊）');
          panelStatus(sec, '识别完成，开始翻译…');
          setStatus('识别完成，开始翻译…');
          // 走一遍正常流程：它会重建本节、清掉这个提示块，再发起翻译。
          $('tpPage').click();
        } catch (e) {
          btn.disabled = false;
          btn.textContent = '🔍 重试识别';
          panelStatus(sec, '识别失败');
          setStatus('识别失败：' + ((e && e.message) || e));
        }
      });
      sec.body.appendChild(d);
    }

    /** 就地识别当前这一页，返回识别出的纯文本（失败/没字时返回空串）。 */
    async function runPageOcr(format) {
      const R = getBook();
      if (!R) return '';
      const idx = currentPageIndex();
      if (format === 'comic') {
        if (typeof ocrImgPage !== 'function') throw new Error('识别模块没加载完，刷新页面再试');
        // 同一页已经在认（顶栏点过）：别重复起，等它自己出结果
        if (R._imgOcrBusy && R._imgOcrBusy.has('ocr:' + idx)) throw new Error('这一页正在识别中，稍等');
        await ocrImgPage(idx);
        return (typeof imgPageText === 'function') ? imgPageText(idx) : '';
      }
      const cv = document.querySelector('#pdfStack .pdf-page[data-idx="' + idx + '"]');
      if (!cv) throw new Error('这一页还没渲染出来，先翻到该页再点');
      // 画布可能还是空白的（懒渲染）：先显式渲染，否则喂给识别引擎的是一张白图，
      // 结果报「没认出任何文字」——和真的空白页分不开（renderPdfStack 的坑，见 reader.js）。
      if (typeof renderPdfPage === 'function' && (!R._pdfRendered || !R._pdfRendered.has(idx))) {
        try { await renderPdfPage(idx); } catch (e) { /* 下面识别失败会报出来 */ }
      }
      if (typeof ocrPdfPage !== 'function') throw new Error('识别模块没加载完，刷新页面再试');
      await ocrPdfPage(idx, cv, cv._viewport);
      return pdfPageText(idx);
    }

    $('tpPage').addEventListener('click', async () => {
      syncGlossaryFromUI();
      const R = getBook();
      if (!R || (!R.text && R.format !== 'pdf' && R.format !== 'comic')) { setStatus('还没打开书，或当前书没有可翻译的正文'); return; }
      // 扫描页（PDF 扫描件 / 图片书）唯一的原文就是 OCR 出来的文字：
      // 没识别过、或者用户把识别结果清掉了，就没有任何东西可翻。
      // 以前这里只甩一句「请先用 🔍 OCR 识别本页」就 return —— 用户清掉识别再点翻译，
      // 看到的就是「翻译不了」，还得自己翻回顶栏找按钮（R149）。
      // 现在面板里直接给一个按钮：识别 → 有字就自动接着翻，一步到底。
      if ((R.format === 'pdf' || R.format === 'comic') && !currentPageText()) {
        const sec = panelSection(panelPageMeta());
        panelNeedOcr(sec, R.format);
        return;
      }
      await ensureLocalEngineReady();   // R130：本地引擎没起就这次改用本地词典（不让你干等）
      localTargetWarn();
      // R148：只清「当前这一页」那一节，别的页的节留着 —— 以前 elResult 整块清空，
      // 译完 A 页再译 B 页，A 页的结果就没了（用户实测的抱怨）。
      const sec = panelSection(panelPageMeta());
      sec.body.innerHTML = '';
      sec.count = 0;
      panelStatus(sec, '翻译中…');
      const myToken = ++_runToken;
      beginRun();
      setStatus('翻译本页中…');
      try {
        // PDF 没有「按段落排版的正文节点」，只能整块译在该页画布下方（原逻辑）
        // 图片书（comic）同理：正文来自 OCR 识别，也没有段落节点
        if (R.format === 'pdf' || R.format === 'comic') {
          const out = await InkTranslate.translateBook(currentPageText(), (done, total, items) => {
            if (myToken !== _runToken) return;
            // R131（第 7 条）：PDF / 图片书也必须记进「小窗账本」。
            // 以前只有文字书那条路会 _memoPut，这里没有 → 「只显示小窗已译」在 PDF 上
            // 永远查不到译文，勾了也没反应（用户实测：必须重勾一次才显示）。
            const lastIt = items[items.length - 1];
            if (lastIt && lastIt.dst != null) _memoPut(_panelMemo, lastIt.src, lastIt.dst);
            appendResultFrom(items, items.length - 1, sec);
            panelStatus(sec, '翻译中 ' + done + '/' + total);
            setStatus('本页翻译中… ' + done + '/' + total);
            setRunBadge(done + '/' + total);
          }, { shouldStop: () => _stopFlag || myToken !== _runToken });
          if (myToken !== _runToken) return;
          (out || []).forEach((it) => { if (it && it.dst != null) _memoPut(_panelMemo, it.src, it.dst); });
          renderAutoNames();
          if (InkTranslate.state.inlineBilingual) renderInlineForPage();
          panelStatus(sec, (_stopFlag ? '已停止 · ' : '完成 · ') + (out || []).length + ' 段');
          const names0 = InkTranslate.lastAutoNames.length ? '，自动保留 ' + InkTranslate.lastAutoNames.length + ' 个人名（可在下方框里改 / 删）' : '';
          setStatus((_stopFlag ? '已停止（本页完成 ' : '本页翻译完成，共 ') + out.length + ' 段' + (_stopFlag ? '）' : '') + names0);
          return;
        }

        // 文字书（txt / html / epub / docx）：**按段落**翻，面板与正文下方共用同一批结果。
        // 这是 R99 的核心修正 —— 以前面板按整页文本切 320 字块翻译、正文按每个段落各自翻译，
        // 两套切法边界不同，于是「条数不同、内容也不同」（用户实测）。
        const cont = inlineHost();
        if (!cont) { setStatus('没找到正文容器：先打开一本书再翻译'); return; }
        const vert = cont.id === 'scrollInner' || !!(cont.closest && cont.closest('#scrollInner'));
        const runId = ++_inlineSeq;
        // 面板「翻译本页」的优先级高于正文的滚动补译：
        // ① 先作废在途的补译（它会把屏幕上每一段都标成 data-tr-doing，还不肯收手）；
        // ② 带 takeover 接管这一屏（占位标记由本轮的 runId 覆盖）—— 否则 gatherJobs 会
        //    一段都收不到，于是误报「这一页没有可翻译的正文」（用户实测：取消勾选
        //    「只显示小窗已译的段落」后必现，因为取消的瞬间后台补译就开跑了）。
        //    接管不重复花钱：_inflight 里同一段的请求两边共用，_trMemo 命中也不再请求。
        if (InkTranslate.state.inlineBilingual) _inlineToken++;
        // strict：点「翻译本页」= 只翻此刻屏幕上这几段（翻页模式就是这一张 .html-page）。
        // 不带 strict 会往后多看 700px，一屏一页的书正好多出整页（用户实测「远超过」）。
        const units = gatherJobs(cont, transViewport(cont), runId, true, true);
        if (!units.length) { setStatus('这一页没有可翻译的正文'); return; }
        // 已译过的段落直接复用，不重复请求：竖排读页面上那条译文，横排读本页缓存
        units.forEach((u) => {
          if (u.dst != null) return;
          // 只认同代的译文块：改过术语表/换过引擎之后旧块要让位重译（否则改了要求也不换）
          const blk = _freshBlock(u.node);
          if (blk) u.dst = blk.textContent || '';
        });
        if (!vert) {
          const cc = _inlineCache[(R.id || R.title || '') + '#' + R.pageIndex];
          if (Array.isArray(cc) && cc.length) {
            const byIdx = {};
            cc.forEach((it) => { if (it && it.idx != null) byIdx[it.idx] = it.dst; });
            units.forEach((u) => { if (u.dst == null && byIdx[u.idx] != null) u.dst = byIdx[u.idx]; });
          }
        }
        if (InkTranslate.state.inlineBilingual && !vert) clearInline();
        // 按原文顺序出条目：只有「前面的段落都已译好」才往后显示，
        // 否则并发乱序 + 复用项混在一起，面板里句子是跳的。
        let cursor = 0;
        let shown = 0;
        const flushPanel = (force) => {
          while (cursor < units.length && (units[cursor].dst != null || force)) {
            const u = units[cursor++];
            if (u.dst == null) continue;
            resultItem({ src: u.text, dst: u.dst }, sec);
            shown++;
            panelStatus(sec, '翻译中 ' + shown + '/' + units.length);
            setStatus('本页翻译中… ' + shown + '/' + units.length + ' 段');
            setRunBadge(shown + '/' + units.length);
          }
        };
        flushPanel(false);
        const res = await translateUnits(units, {
          shouldStop: () => _stopFlag || myToken !== _runToken,
          onUnit: (u) => {
            // 一段译完就显示一段，不用等整页结束（本地引擎一页可能十几秒）
            // 若期间又点了一次（新令牌），旧任务的增量不再写进面板，避免重复
            if (myToken !== _runToken) return;
            if (u.dst != null) _memoPut(_panelMemo, u.text, u.dst);
            flushPanel(false);
            // 跟随模式下正文不会自己翻，所以面板每出一段，就把这一段贴到原文下方
            if (InkTranslate.state.inlineBilingual && InkTranslate.state.inlineFollowPanel) {
              try { renderInlineFollow(cont, vert); } catch (e) {}
            }
          }
        });
        // 本轮占位标记自己摘：没开双语时面板翻完不会往正文贴块，留着 trDoing
        // 会让「以后再勾双语」把这些段落当成「正在译」永久跳过（R101 顺手修）。
        units.forEach((u) => {
          if (!u.marked || !u.node) return;
          if (u.node.dataset.trDoing === u.marked) delete u.node.dataset.trDoing;
        });
        // 记进「小窗账本」：「只显示小窗已译的段落」模式只认这本账
        units.forEach((u) => { if (u.dst != null) _memoPut(_panelMemo, u.text, u.dst); });
        if (myToken !== _runToken) return;   // 已被新一次翻译接管，结果不写面板
        flushPanel(true);                    // 中途停止时，把剩余的已完成段落补上
        renderAutoNames();
        if (InkTranslate.state.inlineBilingual) {
          // 同一批结果直接喂给双语层，别让正文再译一遍（省一倍时间，且保证两处一致）
          renderInlineForPage(units);
        }
        const names = InkTranslate.lastAutoNames.length ? '，自动保留 ' + InkTranslate.lastAutoNames.length + ' 个人名（可在下方框里改 / 删）' : '';
        const okCount = units.filter((u) => u.dst != null).length;
        panelStatus(sec, (_stopFlag ? '已停止 · ' : '完成 · ') + okCount + ' 段');
        setStatus((_stopFlag ? '已停止（本页完成 ' : '本页翻译完成，共 ') + okCount + ' 段' + (_stopFlag ? '）' : '') + names +
          (res.firstError ? '；部分段落失败：' + (res.firstError.message || res.firstError) : ''));
      } catch (e) {
        if (myToken === _runToken) {
          panelStatus(sec, '失败');
          setStatus('出错：' + e.message);
        }
      } finally { if (myToken === _runToken) endRun(); }
    });

    $('tpBook').addEventListener('click', async () => {
      syncGlossaryFromUI();
      const R = getBook();
      if (!R) { setStatus('还没打开书，先选一本打开再翻译'); return; }
      if (!R.text) { setStatus('当前书没有可翻译的正文（PDF / 扫描版不支持全文翻译）'); return; }
      await ensureLocalEngineReady();   // R130：本地引擎没起就这次改用本地词典（不让你干等）
      localTargetWarn();
      // R148：「翻译全书」要求整本连着看，把各页分节收成单独一节「全书」
      panelReset();
      const sec = panelSection({ key: 'book', label: '全书' }, { keepOthers: true });
      panelStatus(sec, '翻译中…');
      const myToken = ++_runToken;
      beginRun();
      setStatus('翻译全书中…（可能较慢，译好一段显示一段，可随时停止）');
      try {
        const out = await InkTranslate.translateBook(R.text, (done, total, items) => {
          if (myToken !== _runToken) return;   // 已有新一次翻译，旧增量舍弃
          const lastIt = items[items.length - 1];
          if (lastIt && lastIt.dst != null) _memoPut(_panelMemo, lastIt.src, lastIt.dst);
          if (InkTranslate.state.inlineBilingual && InkTranslate.state.inlineFollowPanel && items.length % 8 === 0) {
            try { renderInlineFollow(inlineHost(), true); } catch (e) {}
          }
          appendResultFrom(items, items.length - 1, sec);
          panelStatus(sec, '翻译中 ' + done + '/' + total);
          setStatus('全书翻译中… ' + done + '/' + total + '（可点「停止」中断，已译部分保留）');
          setRunBadge(done + '/' + total);
        }, { shouldStop: () => _stopFlag || myToken !== _runToken });
        if (myToken !== _runToken) return;   // 被新翻译接管，结果不写面板
        // R131（第 7 条）：全书译完后把每段都记进「小窗账本」，PDF / 图片书的
        // 「只显示小窗已译」才不会因为查不到译文而永远不显示。
        (out || []).forEach((it) => { if (it && it.dst != null) _memoPut(_panelMemo, it.src, it.dst); });
        renderAutoNames();
        if (InkTranslate.state.inlineBilingual) renderInlineForPage();
        panelStatus(sec, (_stopFlag ? '已停止 · ' : '完成 · ') + (out || []).length + ' 段');
        const names = InkTranslate.lastAutoNames.length ? '，自动保留 ' + InkTranslate.lastAutoNames.length + ' 个人名（可在下方框里改 / 删）' : '';
        setStatus((_stopFlag ? '已停止，完成 ' : '全书翻译完成，共 ') + out.length + ' 段' + names);
      } catch (e) { if (myToken === _runToken) setStatus('出错：' + e.message); } finally { if (myToken === _runToken) endRun(); }
    });

    $('tpClear').addEventListener('click', () => {
      _stopFlag = true;                 // 若有 翻译本页/全书 正在后台跑，立刻终止（解决“清了还在自动翻译”）
      panelReset();                     // R148：分节一起清（这是唯一会「整块清空」的入口）
      clearInline();
      if (typeof global.__inkDropMemo === 'function') global.__inkDropMemo();   // 清译文也清「已译账本」
      _inlineBusy = 0;                  // 清场时把「横排串行闸门」归零，避免旧任务把新勾选挡死
      Object.keys(_inlineCache).forEach((k) => delete _inlineCache[k]);  // 缓存一起清，否则翻回来还是旧译文
      // 关掉「双语对照」自动开关：否则翻页/滚动会再次触发翻译，清了又冒出来。
      // 程序改 .checked 不会触发 change 事件，这里直接调 setInlineBilingual。
      if (InkTranslate.state.inlineBilingual) {
        elInline.checked = false;
        InkTranslate.setInlineBilingual(false);
        _inlineToken++;   // 同上：让正在跑的双语请求作废，避免清完又贴回原文下方
      }
      endRun();                         // 顺手把「停止」按钮藏起来
      setStatus('已清除译文并暂停自动翻译（想再翻译点「翻译本页 / 全书」）');
    });

    // 卸载本地翻译引擎：走本地后端真正删文件（纯前端 JS 删不了磁盘文件）。
    // 没后端（纯静态打开）时降级为提示用户自己跑脚本。底部「卸载」按钮
    //（按当前选中的引擎动态改名）与引擎状态区的「卸载模型」链接共用此函数。
    // which: 'portable' 只卸 llama.cpp；'ollama' 走两项勾选（模型 / C 盘程序本体）；缺省两者都卸（兜底）。
    async function doUninstall(which, label) {
      const name = label || '本地离线翻译引擎';
      if (which === 'ollama') { doUninstallOllama(name); return; }
      // llama.cpp 便携版：引擎和模型全在安装目录里，一句确认就够
      const scope = '（llama.cpp 便携版，含引擎与模型，全部在安装目录）';
      if (!confirm('将卸载 ' + name + scope + '，并停止引擎进程。确认？')) return;
      await runEngineUninstall(which, name, {});
    }

    // Ollama 版专用：模型在 E 盘、程序本体在 C 盘，两件事可以分开做。
    // 「不用卸载墨阅也能卸模型」就是这条 —— 只勾第一项，墨阅和书库都不动。
    function doUninstallOllama(name) {
      setStatus('正在读取引擎位置…');
      fetchEnginePath('ollama').then((info) => {
        const plan = engineInstallPlan('hyMT') || {};
        const modelDir = (info && info.modelDir) || inkInstallWhere(plan);
        const modelSize = fmtSize(info && info.modelBytes) || (plan.modelGB + ' GB');
        const progDir = (info && info.programDir) || plan.programWhere || '';
        const progKnown = !!(info && info.programExists);
        const progSize = fmtSize(info && info.programBytes) || (plan.programGB + ' GB');
        const row = 'display:flex;gap:8px;align-items:flex-start;margin:8px 0;line-height:1.5';
        const body =
          '<b>' + name + '</b>' +
          '<div style="' + row + '">' +
            '<input type="checkbox" id="tpUnModel" checked style="margin-top:4px;flex:0 0 auto">' +
            '<label for="tpUnModel" style="flex:1">模型文件 <b>' + modelDir + '</b>（' + modelSize + '）</label>' +
          '</div>' +
          (progDir
            ? '<div style="' + row + '">' +
                '<input type="checkbox" id="tpUnProg"' + (progKnown ? '' : ' disabled') +
                ' style="margin-top:4px;flex:0 0 auto">' +
                '<label for="tpUnProg" style="flex:1;opacity:' + (progKnown ? '1' : '.55') + '">' +
                'Ollama 程序本体 <b>' + progDir + '</b>（' + progSize +
                (progKnown ? '，在 C 盘' : '，当前未安装') + '）</label>' +
              '</div>'
            : '') +
          '<div class="tp-note-sub" style="margin-top:10px">只卸载本地翻译引擎，<b>墨阅本身照常使用</b>' +
          '（书、笔记、标注都不受影响）。以后想用，回面板点「安装」就能从零装回。</div>' +
          '<div id="tpUnHint" style="color:var(--ios-red,#ff3b30);margin-top:6px;line-height:1.5"></div>';
        openModal({
          title: '卸载本地翻译模型',
          bodyHtml: body,
          confirmText: '卸载',
          cancelText: '取消',
          onConfirm(close) {
            const cbM = document.getElementById('tpUnModel');
            const cbP = document.getElementById('tpUnProg');
            const wantModel = !!(cbM && cbM.checked);
            const wantProg = !!(cbP && cbP.checked);
            const hint = document.getElementById('tpUnHint');
            if (!wantModel && !wantProg) {
              if (hint) hint.textContent = '两项都没勾，没什么可卸的。';
              return;
            }
            close();
            runEngineUninstall('ollama', name, { model: wantModel, program: wantProg });
          }
        });
      });
    }

    // 真正发卸载请求：一个入口，三种组合（只模型 / 只程序 / 两个都卸）
    async function runEngineUninstall(which, name, opts) {
      const o = opts || {};
      const parts = [];
      if (which !== 'ollama' || o.model !== false) parts.push('模型文件');
      if (which === 'ollama' && o.program) parts.push('C 盘 Ollama 程序本体');
      if (!parts.length) return;
      setStatus('正在卸载 ' + name + '（' + parts.join(' + ') + '）…');
      try {
        let url = '/api/uninstall-engine?which=' + encodeURIComponent(which);
        if (which === 'ollama' && o.program) url += '&program=1';
        const resp = await fetch(url, { method: 'POST' });
        if (!resp.ok) throw new Error('后端返回 ' + resp.status);
        const j = await resp.json().catch(() => ({}));
        if (j.ok === false) {
          // 后端实测校验发现文件没删掉（多半被占用）→ 明确报失败，别假报成功
          throw new Error(j.detail || '卸载未彻底：文件仍存在');
        }
        setStatus('✓ 已卸载 ' + name + '（' + parts.join(' + ') + '）' +
          (j.detail ? '：' + j.detail : '') + '。想再用时回面板点「安装」即可。');
      } catch (e) {
        // 后端调不通：多半是 8123 还跑着旧进程（没有 /api 路由）。
        // 这时 JS 删不了磁盘文件，只能请你重开服务，或手动删目录。
        const is404 = /404/.test(e.message);
        setStatus('卸载未成功（' + e.message + '）。'
          + (is404
            ? ' 原因：8123 跑的是旧进程、没有卸载接口。请关掉 InkReader-Web 黑窗、'
              + '重新双击 start-inkreader.bat，F5 后再点卸载即可。'
            : ' 可稍后重试；仍不行就手动删掉上面显示的目录。'));
      }
      // 兜底：卸完再把引擎进程也停掉（删了文件、进程还留在内存里会让人误以为没卸干净）
      try {
        await fetch('/api/engine-stop' + (which ? '?which=' + encodeURIComponent(which) : ''), { method: 'POST' });
      } catch (e2) { /* 后端没连上就跳过，重启 bat 后再卸一次即可 */ }
      updateEngineStatus();   // 卸完刷新状态（已装 → 未装），按钮/链接状态一致
    }
    // 启动本地引擎：装好 ≠ 能用，必须把 llama-server 跑起来（8080）才能翻译。
    // R125：后端改成「立刻返回 + 后台线程等待」，所以这里不能等 fetch 回来就当启动完了，
    // 必须自己盯着 /api/engine-status 的 starting，直到 running。两次点击之间用
    // _engineStarting 挡住 —— 以前 4 秒轮询会把「启动中」冲成「未启动」，用户反复点，
    // 结果起了好几个 llama-server 抢同一个端口。
    let _engineStarting = false;
    let _engineStartSec = 0;
    async function doEngineStart(which) {
      if (_engineStarting) { setStatus('引擎正在启动中（已 ' + _engineStartSec + ' 秒），请稍候…'); return; }
      _engineStarting = true;
      _engineStartSec = 0;
      // 作废「已经发出去、还没回来」的那次状态查询：4 秒轮询的请求如果正好在点按钮前发出，
      // 它回来时 _engineStarting 已经是 true，但它的 my === _statusToken 不会被丢弃，
      // 于是把「启动中」又画回「未启动」—— 用户看到的就是「第一下先闪一下未启动」。
      _statusToken++;
      setStatus('正在启动引擎（首次加载模型约 10-30 秒，请稍候）…');
      renderEngineStarting(0);
      let j = {};
      try {
        const resp = await fetch('/api/engine-start?which=' + encodeURIComponent(which), { method: 'POST' });
        j = await resp.json().catch(() => ({}));
      } catch (e) {
        _engineStarting = false;
        setStatus('启动引擎失败（' + e.message + '）。可手动双击 localmt\\start-llama.ps1，'
          + '等它打印监听 :8080 后再翻译。');
        updateEngineStatus();
        return;
      }
      if (j && j.running) {                 // 已经在跑（后端短路返回）
        _engineStarting = false;
        setStatus('✓ 引擎已经在运行，直接翻译即可。');
        updateEngineStatus(); refreshLocalHealthNote();
        return;
      }
      if (!j || j.ok === false) {
        _engineStarting = false;
        setStatus('✗ ' + ((j && j.detail) || '启动失败。'));
        updateEngineStatus(); refreshLocalHealthNote();
        return;
      }
      // 后台线程在等首次加载：每 1.5 秒问一次真实状态，直到 running / 失败 / 超时
      const t0 = Date.now();
      for (;;) {
        await new Promise(r => setTimeout(r, 1500));
        _engineStartSec = Math.round((Date.now() - t0) / 1000);
        let st = null;
        try {
          const r = await fetch('/api/engine-status?which=' + encodeURIComponent(which), { cache: 'no-store' });
          st = await r.json().catch(() => null);
        } catch (e) { st = null; }
        if (st && st.running) {
          _engineStarting = false;
          setStatus('✓ 引擎已启动（' + _engineStartSec + ' 秒），现在可以翻译了。');
          updateEngineStatus(); refreshLocalHealthNote();
          return;
        }
        if (st && st.starting === false && !st.running) {
          // 后端已经有结论但没起来：给真实原因，不要停在「启动中」骗人
          _engineStarting = false;
          setStatus('✗ ' + (st.startDetail || '引擎没能启动（看 localmt\\server.log）'));
          updateEngineStatus(); refreshLocalHealthNote();
          return;
        }
        renderEngineStarting(_engineStartSec);
        if (_engineStartSec > 200) {        // 兜底：别无限转圈
          _engineStarting = false;
          setStatus('启动超时（' + _engineStartSec + ' 秒）：看 localmt\\server.log 有没有报错。');
          updateEngineStatus();
          return;
        }
      }
    }
    /** 「启动中」这一帧：状态框里写清已等了几秒 + 不能再点 */
    function renderEngineStarting(sec) {
      const box = $('tpEngineStatus');
      if (!box) return;
      box.hidden = false;
      box.className = 'tp-engine-status warn';
      box.innerHTML = '⏳ <b>引擎启动中…</b>已等 <b>' + sec + '</b> 秒'
        + '<br><span class="tp-note-sub">首次要加载 1.8B 模型（约 10–30 秒，CPU 上更久）。'
        + '这期间不用再点，点多了会起好几个引擎互相抢端口。</span>';
    }
    // 停止本地引擎：释放占用的内存（模型 1~4GB）。与「卸载」不同——只杀进程、不拔文件，想用再启动即可。
    async function doEngineStop(which) {
      setStatus('正在停止翻译引擎（释放内存）…');
      try {
        await fetch('/api/engine-stop' + (which ? '?which=' + encodeURIComponent(which) : ''), { method: 'POST' });
        setStatus('✓ 翻译引擎已停止，内存已释放。');
      } catch (e) {
        setStatus('停止引擎失败（' + e.message + '）。可在任务管理器结束 llama-server 进程。');
      }
      updateEngineStatus();        // 停止后立刻刷新状态（运行中 → 未启动）
      refreshLocalHealthNote();    // 同步刷新设置里「本地服务」那行
    }

    // 引擎启动 / 停止后，重新探活并刷新翻译设置里「本地服务」那行提示
    //（tpLlamaNote 只在打开设置 / 切换引擎时探一次，否则会一直停在旧的 ❌/✅）。
    function refreshLocalHealthNote() {
      const note = $('tpLlamaNote');
      if (!note) return;
      const p = InkPlugins.getProvider(elEngine.value);
      if (!p || (p.id !== 'llamaCpp' && p.id !== 'hyMT') || typeof p._health !== 'function') return;
      const cfg = InkTranslate.engineCfg(p.id) || {};
      const ep = cfg.endpoint || p.defaultEndpoint;
      const how = p.id === 'llamaCpp'
        ? '在安装目录 localmt\\start-llama.ps1 启动（首次请回本面板点「安装」自动装引擎和模型）'
        : '先启动 Ollama（ollama serve）并 ollama pull kaelri/hy-mt2:1.8b-q4_K_M';
      p._health(ep).then((h) => {
        note.textContent = (h && h.ok)
          ? '✅ 本地服务已就绪（' + (h.model || 'llama.cpp') + '，完全离线免费，不计 AI 额度）'
          : '❌ 连不上本地服务（' + ep + '）。' + how;
      });
    }

    // 底部按钮：仅当选中的是「可本地安装」引擎时才显示，且只卸那一个
    function refreshUninstallBtn() {
      const plan = engineInstallPlan(elEngine.value);
      const btn = $('tpUninstall');
      if (!btn) return;
      if (plan) {
        btn.hidden = false;
        btn.textContent = '卸载 ' + plan.engineName;
      } else {
        btn.hidden = true;   // 选了 DeepL/OpenAI 等云端引擎时没有本地引擎可卸
      }
    }
    $('tpUninstall').addEventListener('click', () => {
      const plan = engineInstallPlan(elEngine.value);
      if (plan) doUninstall(plan.which, plan.engineName);
    });

    // ---- 本地可安装引擎：选了但没装时，弹「确认安装」框 ----
    // 安装进行中状态：供「取消」按钮真正中断（abort fetch + 通知后端杀子进程）
    // 注：_installAbort / _installRunning / _bgInstallActive 等状态机变量已提升到
    // initTranslateUI 顶部声明（见 1479 附近），避免 TDZ；这里不再重复声明。
    function startInstallWatchdog() {
      _lastInstallActivity = Date.now();
      if (_installWatchdog) clearInterval(_installWatchdog);
      _installWatchdog = setInterval(() => {
        if (!_installRunning) { clearInterval(_installWatchdog); _installWatchdog = null; return; }
        if (Date.now() - _lastInstallActivity > 45000) {     // 45s 无任何进度 / 数据 → 判定卡死
          clearInterval(_installWatchdog); _installWatchdog = null;
          if (_installAbort) { try { _installAbort.abort(); } catch (e) { } }
          _installRunning = false;
          _installAbort = null;
          _bgInstallActive = false;
          _bgInstallPct = 0;
          const box = $('tpEngineStatus');
          if (box) { box.dataset.installing = ''; box.className = 'tp-engine-status'; }
          setStatus('安装无响应（后端可能已退出），已自动取消并复位，可重试。');
          try { updateEngineStatus(false); } catch (e) { }
        }
      }, 5000);
    }
    function stopInstallWatchdog() {
      if (_installWatchdog) { clearInterval(_installWatchdog); _installWatchdog = null; }
    }

    // 切走再回来 / 重开页面 / 后台 SSE 被浏览器掐断后：只要后端安装还在跑，就重新接上
    // 进度流，把进度画回状态区。只接流、不弹窗；本页正在装则不动（避免双流）。
    async function reattachInstall() {
      if (_installReattaching) return;
      if (_installRunning) return;            // 本页还活着在装，无需接管
      _installReattaching = true;
      try {
        const st = await fetch('/api/install-status', { cache: 'no-store' })
          .then(r => r.json()).catch(() => null);
        if (!st || !st.running) return;
        const plan = _bgInstallPlan || { which: st.which || 'portable', engineName: '本地翻译引擎' };
        _bgInstallActive = true;
        _bgInstallPct = (typeof st.pct === 'number') ? st.pct : 0;
        renderInstallBadge(plan);
        const resp = await fetch('/api/install-engine?which=' + encodeURIComponent(plan.which), { method: 'POST' })
          .catch(() => null);
        if (!resp || !resp.ok || !resp.body) return;
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const p = chunk.startsWith('data:') ? chunk.slice(5).trim() : '';
            if (!p || p === '[DONE]') continue;
            try {
              const o = JSON.parse(p);
              if (o.type === 'progress') { _bgInstallPct = o.pct; renderInstallBadge(plan); }
              else if (o.type === 'done') { _bgInstallActive = false; _bgInstallPct = 0; _installOwned = false; updateEngineStatus(false); }
            } catch (e) { /* 忽略非 JSON 行 */ }
          }
        }
      } catch (e) {
        /* 重接失败：下次轮询 / 切回再试 */
      } finally {
        _installReattaching = false;
      }
    }

    // 在引擎状态区画一个紧凑的安装进度条（后台安装时调用，替代「未安装·点此安装」）
    // 结构只建一次，之后只更新百分比与进度条宽度，避免每次进度事件都重建 DOM（闪烁/重影）。
    function renderInstallBadge(plan) {
      const box = $('tpEngineStatus');
      if (!box) return;
      box.hidden = false;
      if (!box.dataset.installing) {
        box.className = 'tp-engine-status installing';
        box.innerHTML =
          '⏳ 正在安装 ' + (plan ? plan.engineName : '本地翻译引擎') + '：<b id="tpBadgePct">0%</b>' +
          '<div class="tp-progress-wrap tp-progress-inline">' +
            '<div class="tp-progress-bar"><div class="tp-progress-fill" id="tpBadgeFill" style="width:0%"></div></div>' +
          '</div>' +
          '<button class="btn-plain tp-bg-cancel" id="tpBgCancelBtn">取消安装</button>' +
          '<br><span class="tp-note-sub">后台下载中，可关掉此页；装好会自动变「已安装」。点「取消安装」会中断并清理已下载部分。</span>';
        const cb = $('tpBgCancelBtn');
        if (cb) cb.addEventListener('click', () => cancelInstall());
        box.dataset.installing = '1';
      }
      const pctEl = $('tpBadgePct'), fill = $('tpBadgeFill');
      if (pctEl) pctEl.textContent = Math.round(_bgInstallPct) + '%';
      if (fill) fill.style.width = _bgInstallPct + '%';
    }

    // 取消正在进行的安装：前台弹窗「取消」与后台状态区「取消安装」按钮共用。
    // 返回 true 表示已真正发起取消（abort fetch + 通知后端杀子进程回滚），false 表示未发起
    //（当前没在装，或用户在二次确认里选了「否」）。
    function cancelInstall() {
      if (!_installRunning) return false;
      if (!confirm('安装正在进行中，取消会中断下载并清理已下载的部分（回到未安装状态）。确定取消？')) return false;
      if (_installAbort) _installAbort.abort();
      stopInstallWatchdog();                    // 取消后停看门狗，避免它误判并重复复位
      _bgInstallActive = false;                 // 取消后不再在状态区画进度条
      _bgInstallPct = 0;
      // 立即清掉「正在安装」徽标，避免取消后还卡在假进度条（连带让切换引擎/重装进不来）
      const box = $('tpEngineStatus');
      if (box) { box.dataset.installing = ''; box.className = 'tp-engine-status'; }
      const mask = document.querySelector('.tp-modal-mask');   // 若前台弹窗还开着，一并关掉
      if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
      setStatus('正在取消安装并清理已下载的部分…');
      fetch('/api/install-abort', { method: 'POST' })
        .then((r) => r.json().catch(() => ({})))
        .then((j) => {
          const rolled = j && j.rolledBack;
          setStatus(rolled ? '已取消安装，并已清理已下载的部分（回到未安装状态）。'
                           : '已取消安装（下载已停止）。');
        })
        .catch(() => { setStatus('已取消安装。'); })
        .finally(() => {
          _installRunning = false;          // 关键：取消后必须复位，否则状态机一直以为"在装"，
          _installAbort = null;             //       轮询被拦、重装也被拦，且状态卡在"检测中…"
          _bgInstallActive = false;         // 双重保险：无论如何都复位 badge 标记
          _installOwned = false;            // 已取消：关页不再触发回滚
          _installAborted = false;
          updateEngineStatus(false);        // 取消后刷新真实状态（回到「未安装」）
        });
      return true;
    }

    // 通用模态框，返回控制器：setBusy / setLog / appendLog / setProgress / finish / close
    function openModal(opts) {
      const mask = document.createElement('div');
      mask.className = 'tp-modal-mask';
      mask.innerHTML =
        '<div class="tp-modal" role="dialog" aria-modal="true">' +
          '<button class="tp-modal-close" id="tpModalX" aria-label="关闭" title="关闭">×</button>' +
          '<h3>' + (opts.title || '') + '</h3>' +
          '<div class="tp-modal-body">' + (opts.bodyHtml || '') + '</div>' +
          (opts.progress ?
            '<div class="tp-progress-wrap">' +
              '<div class="tp-progress-bar"><div class="tp-progress-fill" id="tpProgFill"></div></div>' +
              '<div class="tp-progress-meta"><span id="tpProgPct">0%</span>' +
              '<span id="tpProgEta"></span></div>' +
            '</div>' : '') +
          (opts.progress ? '<pre class="tp-modal-log" id="tpModalLog"></pre>' : '') +
          '<div class="tp-modal-actions">' +
            (opts.onBackground ? '<button class="btn-plain" id="tpModalBg">' + (opts.backgroundText || '后台安装') + '</button>' : '') +
            '<button class="btn-plain" id="tpModalCancel">' + (opts.cancelText || '取消') + '</button>' +
            (opts.onConfirm ? '<button class="btn-primary" id="tpModalOk">' + (opts.confirmText || '确认') + '</button>' : '') +
          '</div>' +
        '</div>';
      document.body.appendChild(mask);
      // toast（z-index 9999、pointer-events:none）会把弹窗底部按钮「盖住但点得着」，
      // 看起来就像按钮坏了。遮罩已提到 10000，这里再把正在显示的 toast 收掉。
      try {
        const _t = document.getElementById('toast');
        if (_t) _t.classList.remove('show');
      } catch (e) { }
      const log = mask.querySelector('#tpModalLog');
      const cancelBtn = mask.querySelector('#tpModalCancel');
      const okBtn = mask.querySelector('#tpModalOk');
      const bgBtn = mask.querySelector('#tpModalBg');
      const xBtn = mask.querySelector('#tpModalX');
      if (xBtn) xBtn.addEventListener('click', () => { close(); });
      const fill = mask.querySelector('#tpProgFill');
      const pctEl = mask.querySelector('#tpProgPct');
      const etaEl = mask.querySelector('#tpProgEta');
      let _finished = false;
      let _progStart = 0;
      const close = () => { if (mask.parentNode) mask.parentNode.removeChild(mask); };
      cancelBtn.addEventListener('click', () => {
        if (_finished) { close(); return; }              // 完成后「取消」即关闭
        if (typeof opts.onCancel === 'function') opts.onCancel(close);
        else close();
      });
      if (okBtn && opts.onConfirm) okBtn.addEventListener('click', () => {
        if (_finished) { close(); return; }              // 完成后「确认/关闭」按钮即关闭，不再重跑
        opts.onConfirm(close);
      });
      if (bgBtn && opts.onBackground) bgBtn.addEventListener('click', () => opts.onBackground(close));
      const fmtEta = (sec) => {
        if (!isFinite(sec) || sec <= 0) return '';
        return sec < 60 ? ('预计剩余约 ' + Math.ceil(sec) + ' 秒')
                        : ('预计剩余约 ' + Math.ceil(sec / 60) + ' 分钟');
      };
      return {
        close,
        setBusy(b) { if (okBtn) okBtn.disabled = b; },
        setLog(t) { if (log) log.textContent = t; },
        appendLog(t) { if (log) { log.textContent += t + '\n'; log.scrollTop = log.scrollHeight; } },
        setProgress(pct) {
          pct = Math.max(0, Math.min(100, Number(pct) || 0));
          if (!_progStart) _progStart = Date.now();
          if (fill) fill.style.width = pct + '%';
          if (pctEl) pctEl.textContent = Math.round(pct) + '%';
          if (etaEl) {
            if (pct < 3) etaEl.textContent = '正在准备…';
            else {
              const elapsed = (Date.now() - _progStart) / 1000;
              etaEl.textContent = fmtEta(elapsed * (100 - pct) / pct);
            }
          }
        },
        finish(text) {
          if (log) log.textContent += '\n' + text;
          _finished = true;
          if (fill) fill.style.width = '100%';
          if (pctEl) pctEl.textContent = '100%';
          if (etaEl) etaEl.textContent = '完成';
          if (okBtn) { okBtn.textContent = '关闭'; okBtn.disabled = false; }
          if (bgBtn) bgBtn.hidden = true;
          if (cancelBtn) cancelBtn.textContent = '关闭';
          updateEngineStatus();
        }
      };
    }

    // 选了可安装引擎时回显是否已安装；未安装则给「点此安装」入口
    // autoPopup=true 表示「用户刚在引擎下拉里选了它」→ 未装就直接弹确认安装框
  async function updateEngineStatus(autoPopup) {
    // 后台安装进行中：无论怎么切下拉，状态区都死守「正在安装」徽标，
    // 不能让换引擎把进度条冲掉——尤其切到不可本地安装的在线引擎时 plan 为 null 会直接隐藏整个框。
    if (_bgInstallActive && _installRunning) {
      renderInstallBadge(_bgInstallPlan);
      return;
    }
    const plan = engineInstallPlan(elEngine.value);
    const box = $('tpEngineStatus');
    const btn = $('tpUninstall');
    if (!plan) { box.hidden = true; box.innerHTML = ''; if (btn) btn.hidden = true; return; }
    // 启动中：绝不能按「/api/engine-status 说 running=false」就画成「引擎未启动」。
    // 模型还在加载时 running 本来就是 false，以前正是这句把按钮又放出来，用户反复点。
    if (typeof _engineStarting !== 'undefined' && _engineStarting) { renderEngineStarting(_engineStartSec); return; }
    box.hidden = false;
    box.className = 'tp-engine-status';
    // 并发防护：丢弃过期的检测结果，只认最近一次（避免旧响应把新状态覆盖回「检测中…」）
    const my = ++_statusToken;
    // 安装状态一致性兜底：badge（_bgInstallActive）只有在 SSE 仍然在跑（_installRunning）时才该亮。
    // 一旦 _installRunning 变 false（装完 / 取消 / 断线），badge 就是过期的「假正在安装」，
    // 会卡住切换引擎的"检测中"、并让重装被误判为"进行中"。这里强制复位，交给下面的真实状态。
    if (_bgInstallActive && !_installRunning) {
      _bgInstallActive = false;
      box.dataset.installing = '';
    }
    if (_bgInstallActive) { renderInstallBadge(plan); return; }   // 后台安装中：显示进度条，不要覆盖成「未安装」
    // 只在「第一次检测」或「用户刚切换引擎」时显示「检测中…」；之后的 4 秒轮询
    // 保留上一次的真实状态（已安装 / 未安装 / 无法确认），避免一直闪「检测中…」。
    if (!box._chkStarted || autoPopup) box.textContent = '检测中…';
    let st = null;
    try {
      // 加超时：后端卡住 / 旧进程不回 / 网络异常时，最多等 5 秒就落到「无法确认」分支，
      // 而不是永远停在「检测中…」。用请求令牌，超时/慢响应回来时若已有更新的检测则丢弃。
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch('/api/engine-status?which=' + encodeURIComponent(plan.which),
        { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(to);
      if (my !== _statusToken) return;   // 已有更新的检测在进行，本条作废
      if (r.ok) st = await r.json().catch(() => null);
      // 顺手记住真实安装目录：引擎状态里的 exe / model / modelDir 都是绝对路径
      if (st) _rememberRoot(st.model || st.modelDir || st.exe);
    } catch (e) { st = null; }
    if (my !== _statusToken) return;   // 同上：作废过期响应，绝不把状态回写成「检测中…」
    // 双保险：这条 fetch 在飞行途中用户可能刚点了「启动」，
    // 这时真实状态（running:false）已经过期，绝不能拿它把「启动中」冲掉。
    if (_engineStarting) { renderEngineStarting(_engineStartSec); return; }
      if (!st) {
        box._chkStarted = true;   // 已拿到（无后端）结论，后续轮询不要再闪「检测中…」
        // 后端没起，或 8123 跑的是旧进程（不含这些 /api 路由）。
        // 关键：这时**不能盲弹「安装」** —— 用户很可能早就装好了
        //（Hy-MT2 已装却还弹安装框，就是这个分支造成的）。
        // 退一步：直接探引擎自身的健康检查端口（8080 / 11434），服务在跑就说明已安装。
        let healthy = false;
        const p = InkPlugins.getProvider(elEngine.value);
        if (p && typeof p._health === 'function') {
          try {
            const cfg = InkTranslate.engineCfg(p.id) || {};
            // 探活也加 3 秒超时：取消安装后引擎端口可能已死/未起，_health 不能无限等，
            // 否则状态框会一直停在"检测中…"。超时即视为不可达，落到"无法确认"分支。
            const hp = p._health(cfg.endpoint || p.defaultEndpoint);
            const to = new Promise(res => setTimeout(() => res(null), 3000));
            const h = await Promise.race([hp, to]);
            healthy = !!(h && h.ok);
          } catch (e) { healthy = false; }
        }
        if (healthy) {
          // 后端没连上、但引擎端口还在响应：能直接翻译，但「是否已安装」无法由本面板确认
          // （文件删了、进程还留在内存里也会回 200）。所以**绝不谎报「已安装」**，只告知可翻译。
          box.className = 'tp-engine-status warn';
          box.innerHTML = '⚠ 本地后端未连接，但翻译引擎端口在响应，可直接翻译 · '
            + '<a href="#" id="tpInstallLink">查看安装方式</a>'
            + '<br><span class="tp-note-sub">「是否已安装」需在后端连上时才能准确判定；'
            + '若已卸载却仍看到这条，说明引擎进程还活着，请重启 start-inkreader.bat 后 F5。</span>';
          const link2 = $('tpInstallLink');
          if (link2) link2.addEventListener('click', (e) => { e.preventDefault(); openInstallConfirm(plan); });
          if (btn) btn.hidden = true;   // 后端都没连上，点卸载必然 404，藏掉避免误导
          return;
        }
        // 探不到也不代表没装：只给可见提示，**不自动弹安装框**（避免误判打扰用户）
        box.className = 'tp-engine-status warn';
        box.innerHTML = '⚠ 本地后端未连接，无法确认是否已安装 · ' +
          '<a href="#" id="tpInstallLink">查看安装方式</a>' +
          '<br><span class="tp-note-sub">请重启 start-inkreader.bat（当前 8123 进程不含 /api 路由）。' +
          '若引擎已在运行，忽略本提示、直接翻译即可。</span>';
        const link2 = $('tpInstallLink');
        if (link2) link2.addEventListener('click', (e) => { e.preventDefault(); openInstallConfirm(plan); });
        if (btn) btn.hidden = true;   // 后端没连上，点卸载必然 404，藏掉避免误导
        return;   // 状态未知 → 不弹安装框（只有确认「未安装」才弹）
      }   // 无后端：不再隐藏，改为可见降级提示
      box._chkStarted = true;   // 已拿到（后端在线）结论，后续轮询保留状态不闪
      if (st.installed) {
        // 后端正在后台启动（本页刷新过 / 另一个标签页点了启动）：按「启动中」画，
        // 这样轮询不会把按钮重新放出来诱使用户再点一次。
        if (st.starting && !st.running) { renderEngineStarting(st.startSec || 0); return; }
        box.className = 'tp-engine-status ok';
        if (st.running) {
          box.innerHTML = '✓ 已安装，引擎运行中，可直接翻译 · '
            + '<a href="#" id="tpStopEngineLink">停止引擎</a> · '
            + '<a href="#" id="tpUninstallLink">卸载模型</a>';
        } else {
          // 之前文案指向「面板下方启动引擎」但按钮根本不存在——这里直接给按钮
          box.innerHTML = '✓ 已安装，<b>引擎未启动</b> · '
            + '<button class="btn-primary" id="tpEngineStartBtn" style="padding:3px 12px;font-size:13px;border-radius:8px;margin:0 4px">▶ 启动引擎</button>'
            + ' · <a href="#" id="tpUninstallLink">卸载模型</a>';
        }
        const ul = $('tpUninstallLink');
        if (ul) ul.addEventListener('click', (e) => { e.preventDefault(); doUninstall(plan.which, plan.engineName); });
        const sl = $('tpStopEngineLink');
        if (sl) sl.addEventListener('click', (e) => { e.preventDefault(); doEngineStop(plan.which); });
        const sb = $('tpEngineStartBtn');
        if (sb) sb.addEventListener('click', () => doEngineStart(plan.which));
        if (btn) { btn.hidden = false; btn.textContent = '卸载 ' + plan.engineName; }   // 已装 → 显示底部按钮
      } else {
        if (_bgInstallActive) { renderInstallBadge(plan); return; }   // 后台安装中：显示进度条，不要覆盖成「未安装」
        box.className = 'tp-engine-status warn';
        // 模型卸了、C 盘的 Ollama 程序本体还留着：给一条「只清程序」的路，
        // 否则那 1.6 GB 就只能在 Windows 设置里找，用户会以为「卸了还在」。
        if (plan.which === 'ollama' && st.ollamaProgram) {
          box.innerHTML = '未安装模型 · <a href="#" id="tpInstallLink">点此安装</a> · '
            + '<a href="#" id="tpCleanProgLink">卸载 C 盘的 Ollama 程序</a>'
            + '<br><span class="tp-note-sub">Ollama 程序本体还在 C 盘（约 1.6 GB）；'
            + '只装模型不想要它，可以单独清掉。</span>';
          const cl = $('tpCleanProgLink');
          if (cl) cl.addEventListener('click', (e) => { e.preventDefault(); doUninstallOllama(plan.engineName); });
          if (btn) { btn.hidden = false; btn.textContent = '卸载 C 盘的 Ollama 程序'; }
        } else {
          box.innerHTML = '未安装 · <a href="#" id="tpInstallLink">点此安装</a>';
          if (btn) btn.hidden = true;   // 没装就不要在底部显示「卸载」（安装入口在状态框里）
        }
        const link = $('tpInstallLink');
        if (link) link.addEventListener('click', (e) => { e.preventDefault(); openInstallConfirm(plan); });
        // 用户刚选了未装的引擎 → 直接弹「确认安装」框（满足「选了就提示安装」）
        if (autoPopup) openInstallConfirm(plan);
      }
    }

    function installPlanHtml(plan) {
      const total = (plan.modelGB + plan.programGB).toFixed(2);
      // 装到哪：优先用后端回报的真实安装目录（_inkRoot），拿不到才用兜底文案
      let loc = '模型：<b>' + plan.model + '</b><br>' +
        (plan.which === 'ollama' ? '模型位置：' : '安装位置：') +
        '<b id="tpInstallWhere">' + inkInstallWhere(plan) + '</b>';
      // Ollama 的程序本体在 C 盘（官方安装器决定落点）。只写「另占 C 盘 1.6GB」等于没说：
      // 用户既不知道在 C 盘哪一格，也不知道能不能单独删。这里把真实目录也摊出来。
      if (plan.programGB > 0) {
        loc += '<br>程序位置：<b id="tpInstallProgram">' + (plan.programWhere || '') +
          '（约 ' + plan.programGB + ' GB，可单独卸载）</b>';
      }
      loc += '<div id="tpTempWarn"></div><br>' +
        '预计占用：模型约 <b>' + plan.modelGB + ' GB</b>';
      if (plan.programGB > 0) loc += '；程序本体另占 C 盘约 <b>' + plan.programGB + ' GB</b>（共约 ' + total + ' GB）';
      loc += '<br><span style="color:var(--ios-gray,#8e8e93)">' + plan.note + '</span>';
      const devWarn = (typeof Sync !== 'undefined' && Sync.state && Sync.state.dev)
        ? '<div class="tp-note" style="color:var(--ios-red,#ff3b30)">⚠️ 当前页面连的是<b>源码目录</b>（开发用），'
          + '在这里安装只会装进这棵树，<b>不算你的安装版</b>。要装到安装目录，请双击桌面图标打开后再装。</div>'
        : '';
      return devWarn + '将安装本地翻译引擎：<b>' + plan.engineName + '</b><br>' + loc + '<br><br>确认安装？';
    }

    // 后端报的真实落点（模型目录 / C 盘程序目录）。拿不到就静默保持兜底文案。
    function fetchEnginePath(which) {
      return fetch('/api/engine-path?which=' + encodeURIComponent(which), { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => ((j && j.ok) ? j : null))
        .catch(() => null);
    }
    function fmtSize(bytes) {
      if (!bytes) return '';
      const gb = bytes / 1073741824;
      return gb >= 1 ? gb.toFixed(2) + ' GB' : Math.max(1, Math.round(bytes / 1048576)) + ' MB';
    }
    // 把弹窗里两行地址补成真实路径（装过 Ollama = 真实目录；没装 = 预计默认位置）
    function fillEnginePath(plan) {
      if (!plan) return;
      fetchEnginePath(plan.which).then((info) => {
        if (!info) return;
        const w = document.getElementById('tpInstallWhere');
        if (w && info.modelDir) {
          w.textContent = info.modelDir +
            (plan.which === 'ollama' ? '（模型）' : '（引擎 + models\\ 模型）') +
            (isTempRoot(info.modelDir) ? '（⚠ 临时目录，不建议在此安装）' : '');
        }
        const pr = document.getElementById('tpInstallProgram');
        if (pr && info.programDir) {
          const sz = fmtSize(info.programBytes);
          pr.textContent = info.programDir +
            (info.programExists
              ? '（已装' + (sz ? '，' + sz : '') + '，可单独卸载）'
              : '（安装时创建，约 ' + plan.programGB + ' GB，可单独卸载）');
        }
      });
    }

    function openInstallConfirm(plan) {
      /* R158：安卓壳里装不了。引擎是电脑版可执行文件（x86），手机既跑不起来，
         也没权限动 dalvik-cache —— 以前点下去只会看到
         「Error changing dalvik-cache ownership : Permission denied」，完全没法理解。
         直接拦住并给手机真能做的两条路。 */
      if (typeof window !== 'undefined' && window.InkAndroid) {
        /* R170：这里原来从 localStorage 取「对账列表第一台」的地址拼进提示 ——
           ① 那不一定是要用的机器；② 等于把真实内网 IP 直接印在界面上，
           用户截图问问题时只能自己拿马赛克涂（他涂了两次）。改成纯指路。 */
        openModal({
          title: '手机上装不了本地翻译引擎',
          bodyHtml: '手机里没有可用的翻译引擎 —— 本地引擎是<b>电脑版程序</b>（约 1 GB 的 x86 可执行文件），'
            + '安卓上跑不起来，跟权限无关，所以这次不再让你下载（以前那个报错就是它）。'
            + '<br><br>手机能用的两种办法：'
            + '<br>① <b>用电脑上的引擎</b>：电脑上开着墨阅并启动翻译引擎，手机把接口地址改成'
            + '<b>http://电脑的局域网地址:8080/v1/chat/completions</b>'
            + '（地址去电脑上「设置 → 连到别的设备」，抄最上面「我的地址」那一行）；'
            + '<br>② <b>用在线接口</b>：翻译设置里选在线引擎，填 API Key。',
          confirmText: '知道了',
          cancelText: '关闭'
        });
        return;
      }
      // 防重复安装：已有一个安装（前台或后台）在跑时，不再开新弹窗 / 不再发起第二次下载，
      // 直接把进度显示出来，并提示「勿重复点击」。
      if (_installRunning) {
        if (_bgInstallActive) renderInstallBadge(_bgInstallPlan || plan);
        setStatus('安装已在进行中，请勿重复点击；进度见上方状态区。');
        return;
      }
      // 真正装到哪：先问一次后端（安装版和源码树给的是各自的路径），拿到后补进弹窗那一行
      _probeRoot((root) => {
        const el = document.getElementById('tpInstallWhere');
        if (el && root) el.textContent = inkInstallWhere(plan);
        renderTempWarn(root || _inkRoot);   // 服务 ROOT 落在 %TEMP% → 红字警告
      });
      fillEnginePath(plan);   // C 盘程序位置也补成真实路径（Ollama 装在用户目录）
      const m = openModal({
        title: '安装本地翻译引擎',
        bodyHtml: installPlanHtml(plan) +
          '<br><span class="tp-note-sub">安装将在后台下载（约 1.1 GB，视网速 1–10 分钟）。' +
          '可点「后台安装」关掉此框，下载在服务器上继续，面板里会实时更新状态。</span>',
        confirmText: '确认安装',
        cancelText: '取消',
        progress: true,
        backgroundText: '后台安装',
        onConfirm() {
          if (_installRunning) return;   // 已在装（如先点了后台安装），避免重复发起
          startInstall(plan, m);
        },
        onBackground(close) {
          // 关掉弹窗但保留后台安装：真正发起下载（startInstall 里会连接后端、轮询进度），
          // 只是不阻塞在弹窗里。进度改画到状态区（renderInstallBadge）。
          // 已经在装（用户先点了「确认安装」）：直接转后台显示，不要再发起第二次下载——
          // 否则两个 SSE 抢同一个后端 → 一个 409、状态机紊乱，最终显示「未安装」。
          if (_installRunning) {
            _bgInstallActive = true;
            renderInstallBadge(_bgInstallPlan || plan);
            close();
            return;
          }
          _bgInstallActive = true;
          renderInstallBadge(plan);
          startInstall(plan, m);
          close();
        },
        onCancel(close) {
          // 安装进行中点「取消」：真正中断下载（abort fetch + 通知后端杀子进程并回滚半成品）
          const did = cancelInstall();               // 未在装 / 用户拒绝 → 返回 false
          if (_installRunning && !did) return;       // 用户在二次确认选了「否」→ 保留弹窗继续看进度
          close();
        }
      });
    }

    async function startInstall(plan, m) {
      _installRunning = true;
      _bgInstallPlan = plan;
      _installOwned = true;            // 本页发起安装 → 关掉整页时回滚（切走不会触发）
      _installAborted = false;
      _installAbort = ('AbortController' in window) ? new AbortController() : null;
      m.setBusy(true);
      m.setLog('准备安装（连接本地后端）…');
      // 预检：本地后端是否可达。装模型必须连本地服务；若服务没起 / 已退出，先给一句
      // 清楚可操作的提示，避免静默卡在进度条（而不是拖半天才发现连不上）。
      try {
        const ping = await fetch('/api/ping', { method: 'GET', cache: 'no-store' });
        if (!ping.ok) throw new Error('ping not ok');
      } catch (e) {
        m.setBusy(false);
        m.finish('本地服务未运行或已退出。\n\n请先启动服务：双击桌面「InkReader」'
          + '或运行 start-inkreader.bat，等浏览器打开、本页刷新后，再点「确认安装」即可。');
        _installRunning = false;
        _installAbort = null;
        return;
      }
      startInstallWatchdog();            // 看门狗：安装无响应时自动复位，避免按钮卡死

      // SSE 读取循环：抽成函数，409 重试时可复用
      const pump = async (resp) => {
        if (!resp.ok || !resp.body) return false;
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let gotDone = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const p = chunk.startsWith('data:') ? chunk.slice(5).trim() : '';
            if (!p || p === '[DONE]') continue;
            _lastInstallActivity = Date.now();          // 收到任何数据都算活跃，喂看门狗
            try {
              const o = JSON.parse(p);
              if (o.type === 'progress') {
                m.setProgress(o.pct);                 // 弹窗里的进度条 + 预计时间
                _bgInstallPct = o.pct;                // 同步给状态区（后台安装时显示）
                if (_bgInstallActive) renderInstallBadge(plan);
              }
              else if (o.type === 'log') m.appendLog(o.text);
              else if (o.type === 'done') {
                gotDone = true;
                _bgInstallActive = false;             // 装完，状态区交给真实「已安装」
                _installOwned = false;                // 装完：关页不再触发回滚
                _bgInstallPct = 0;
                m.finish(o.ok ? '✓ 安装完成，回到面板启动引擎即可翻译。' : '✗ 安装未完成，看上面的日志。');
              }
              else if (o.type === 'error') m.appendLog('错误：' + o.text);
            } catch (e) { /* 忽略非 JSON 行 */ }
          }
        }
        // 连接异常断开（没收到 done 事件）：恢复轮询，让状态区按真实文件状态刷新，
        // 避免进度条卡在最后一次百分比。正常完成时 gotDone=true、bg 已关，这里不动。
        if (!gotDone && _bgInstallActive) _bgInstallActive = false;
        return gotDone;
      };

      try {
        const url = '/api/install-engine?which=' + encodeURIComponent(plan.which);
        const opt = () => ({ method: 'POST', signal: _installAbort ? _installAbort.signal : undefined });
        let resp = await fetch(url, opt());
        // 后端报 409：多为上一次取消没把子进程杀干净。先把残留进程中止，等一会再重试一次，
        // 否则就会"点安装没反应 / 再点也装不了"。
        if (resp.status === 409) {
          setStatus('检测到上一次安装未完全清理，正在中止残留进程…');
          try { await fetch('/api/install-abort', { method: 'POST' }); } catch (e) { }
          await new Promise(r => setTimeout(r, 1000));
          if (_installAbort) _installAbort.abort();
          _installAbort = ('AbortController' in window) ? new AbortController() : null;
          resp = await fetch(url, opt());
          if (resp.status === 409) {
            _bgInstallActive = true; renderInstallBadge(plan);
            setStatus('仍有安装任务在进行中，请稍候在状态区查看进度，或重启 start-inkreader.bat 后重试。');
            m.close();
            return;
          }
        }
        const connected = resp.ok && !!resp.body;
        if (connected) {
          const ok = await pump(resp);
          if (ok) return;
          // 连接断开但后端仍在下载：前台（弹窗开着）给提示；后台（弹窗已关，切走再回来）
          // 靠 reattachInstall 自动续接进度显示，不弹中断警告（安装其实还在继续）。
          if (document.querySelector('.tp-modal-mask')) {
            m.finish('安装连接中断（未收到完成信号）。可点「后台安装」关弹窗，或稍后在状态区查看真实进度。');
          } else {
            setStatus('安装连接短暂中断，正在自动恢复进度…');
          }
          return;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') {
          _bgInstallActive = false;
          m.finish('已取消安装（下载已停止）。');
          return;
        }
        /* 落到手动模式 */
      } finally {
        stopInstallWatchdog();            // 收尾时务必停掉看门狗，避免误杀下一次安装
        _installRunning = false;
        _installAbort = null;
      }
      m.setLog('');
      const cmd = plan.which === 'ollama' ? 'python tools/setup_ollama.py' : 'python tools/setup_local_mt.py';
      m.finish('当前页面没有本地后端，无法一键安装。请到安装目录' + inkRootText() + '打开终端运行：\n\n  ' + cmd + '\n\n安装完刷新页面即可。');
    }

    // ---- 3) 阅读器功能插件列表 ----
    function refreshFeatures() {
      elFeatures.innerHTML = '';
      InkPlugins.listFeatures().forEach((f) => {
        const b = document.createElement('button');
        b.className = 'btn-plain tp-feature';
        b.textContent = f.name || f.id;
        b.title = f.description || '';
        b.addEventListener('click', () => {
          try { f.run({ R: (typeof R !== 'undefined' ? R : null), InkTranslate, result: elResult }); }
          catch (e) { setStatus('插件执行失败：' + e.message); }
        });
        elFeatures.appendChild(b);
      });
    }
    // 插件可能在 DOMContentLoaded 之后才注册，监听事件刷新
    InkPlugins.on('feature:registered', refreshFeatures);
    InkPlugins.on('provider:registered', refreshEngines);
    refreshFeatures();
    syncKeyRow();
    renderAutoNames();

    // 实时刷新引擎状态：仅当「翻译面板开着 + 选中可本地安装的引擎（HyMT/Ollama）」时
    // 才每 4 秒探一次，其余情况（云端引擎 / 面板关着）零开销、一个请求都不发。
    // 弹窗开着时也暂停，避免打断安装/确认流程；_statusBusy 防重入。
    let _statusBusy = false;
    async function pollEngineStatus() {
      if (_statusBusy) return;
      if (document.querySelector('.tp-modal-mask')) return;   // 弹窗开着时不轮询
      if (_installRunning) return;                             // 安装进行中：进度由 SSE 实时推送，无需 4 秒轮询
      if (!engineInstallPlan(elEngine.value)) return;          // 云端引擎：无需轮询
      const box = $('tpEngineStatus');
      if (!box || box.offsetParent === null) return;           // 翻译面板没开着：不轮询
      _statusBusy = true;
      try { await updateEngineStatus(false); }   // false = 绝不自动弹安装框
      catch (e) { /* 瞬断忽略 */ }
      finally { _statusBusy = false; }
    }
    setInterval(pollEngineStatus, 4000);   // 之后每 4 秒自动刷新

    // 切走再回来：页面重新可见时，若后端安装还在跑，自动重接管进度显示
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reattachInstall();
      // 切走（hidden）不做事：后端照常下载，回来再续——这就是「切走不中断」
    });
    setInterval(() => { if (document.visibilityState === 'visible') reattachInstall(); }, 5000);

    // 关掉整个页面才回滚：beforeunload 只在「页面真的卸载」时触发（关页 / 刷新 / 跳转），
    // 切走（仅 visibilitychange→hidden）不会触发，因此「切走不中断、关页才回滚」。
    // 仅当本页自己发起了安装、且安装仍在进行时才回滚；这不是本页发起的、或已结束的都不回滚。
    function attachInstallUnloadGuard() {
      if (_unloadGuardAttached) return;
      _unloadGuardAttached = true;
      const maybeRollback = () => {
        if (_installAborted) return;
        if (!_installOwned) return;                        // 不是本页发起的安装不回滚
        if (!(_installRunning || _bgInstallActive)) return;
        _installAborted = true;                           // 只发一次
        try {
          if (navigator.sendBeacon) {
            navigator.sendBeacon('/api/install-abort', new Blob([], { type: 'application/json' }));
          } else {
            fetch('/api/install-abort', { method: 'POST', keepalive: true });
          }
        } catch (e) { /* 忽略：卸载阶段无法保证送达 */ }
      };
      window.addEventListener('beforeunload', maybeRollback);
    }
    attachInstallUnloadGuard();
  }

})(typeof window !== 'undefined' ? window : globalThis);
