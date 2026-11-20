/* ============================================================
   tts.js —— 播读（Web Speech API）
   从当前阅读位置开始，按句朗读，句间自动翻页 / 滚动定位，
   并用浮层标出正在朗读的句子。
   ============================================================ */
const TTS = {
  supported: 'speechSynthesis' in window,
  active: false,
  paused: false,
  seq: [],          // [{ text, off }]
  idx: 0,
  rate: 1,
  voiceURI: '',
  _utter: null,
  _voices: [],
  _stopFlag: false,

  /* ---------- 声音列表 ---------- */
  loadVoices() {
    if (!this.supported) return [];
    this._voices = speechSynthesis.getVoices() || [];
    return this._voices;
  },

  zhVoices() {
    this.loadVoices();
    const all = this._voices;
    const zh = all.filter(v => /zh|cmn|Chinese|中文/i.test(v.lang + ' ' + v.name));
    return (zh.length ? zh : all).slice(0, 40);
  },

  fillVoiceSelect() {
    const sel = $('ttsVoice');
    if (!sel) return;
    const vs = this.zhVoices();
    if (!vs.length) { sel.innerHTML = '<option value="">（无可用声音）</option>'; return; }
    sel.innerHTML = vs.map(v =>
      `<option value="${esc(v.voiceURI)}">${esc(v.name)} · ${esc(v.lang)}</option>`).join('');
    // 优先选中已保存的，其次中文优先
    const want = this.voiceURI || '';
    if (want && vs.some(v => v.voiceURI === want)) sel.value = want;
    else {
      const pref = vs.find(v => /zh[-_]CN/i.test(v.lang)) || vs[0];
      sel.value = pref.voiceURI;
      this.voiceURI = pref.voiceURI;
    }
  },

  /* ---------- 文本切句 ---------- */
  buildSeq(startOff) {
    const text = R.text || '';
    const from = Math.max(0, Math.min(text.length - 1, startOff | 0));
    const src = text.slice(from);
    const out = [];
    const re = /[^。！？；!?;\n]+[。！？；!?;\n]?/g;
    let m, pos = 0;
    while ((m = re.exec(src))) {
      let s = m[0];
      if (!s.trim()) continue;
      // 过长时按逗号再切，避免单次朗读被浏览器截断
      while (s.length > 120) {
        let cut = -1;
        for (let i = 60; i < s.length - 20; i++) {
          if ('，,、：:'.includes(s[i])) { cut = i + 1; break; }
        }
        if (cut < 0) cut = 100;
        out.push({ text: s.slice(0, cut), off: from + pos });
        pos += cut;
        s = s.slice(cut);
      }
      if (s.trim()) { out.push({ text: s, off: from + pos }); }
      pos += m[0].length;
    }
    if (!out.length && src.trim()) out.push({ text: src.slice(0, 120), off: from });
    return out;
  },

  /* ---------- 控制 ---------- */
  currentStartOffset() {
    if (R.format !== 'txt') return 0;
    if (Settings.direction === 'vertical') {
      return parseInt(R.book.locator || 0) || 0;
    }
    const p = R.pages[R.pageIndex];
    return p ? p.start : 0;
  },

  start() {
    if (!this.supported) { toast('当前浏览器不支持播读'); return; }
    if (R.format !== 'txt') { toast('播读目前支持 TXT / EPUB / Word，PDF 与漫画暂不支持'); return; }
    this.stop(true);
    this._stopFlag = false;
    this.seq = this.buildSeq(this.currentStartOffset());
    if (!this.seq.length) { toast('没有可朗读的内容'); return; }
    this.idx = 0;
    this.active = true;
    this.paused = false;
    $('ttsBar').hidden = false;
    $('ttsBtn').classList.add('on');
    $('ttsPlayBtn').textContent = '⏸ 暂停';
    requestWakeLock();
    this.speakNext();
  },

  speakNext() {
    if (this._stopFlag) return;
    if (this.idx >= this.seq.length) { this.finish('朗读结束'); return; }
    const item = this.seq[this.idx];
    const u = new SpeechSynthesisUtterance(item.text);
    const v = this._voices.find(x => x.voiceURI === this.voiceURI);
    if (v) { u.voice = v; u.lang = v.lang; }
    else u.lang = 'zh-CN';
    u.rate = this.rate;
    u.pitch = 1;
    u.volume = 1;

    u.onstart = () => {
      this.reveal(item.off);
      this.highlight(item.off, item.text.length);
      $('ttsStatus').textContent = `朗读中 ${this.idx + 1}/${this.seq.length}`;
    };
    u.onend = () => {
      if (this._stopFlag) return;
      this.idx++;
      // 浏览器在某些平台会静默暂停，这里做一次兜底恢复
      setTimeout(() => this.speakNext(), 30);
    };
    u.onerror = (e) => {
      if (this._stopFlag) return;
      if (e && e.error === 'interrupted') return;
      if (e && e.error === 'canceled') return;
      this.finish('播读中断：' + ((e && e.error) || '未知错误'));
    };

    this._utter = u;
    try {
      speechSynthesis.speak(u);
    } catch (e) {
      this.finish('播读启动失败：' + (e && e.message ? e.message : e));
    }
  },

  toggle() { this.paused ? this.resume() : this.pause(); },

  pause() {
    if (!this.active || this.paused) return;
    speechSynthesis.pause();
    this.paused = true;
    $('ttsPlayBtn').textContent = '▶ 继续';
    $('ttsStatus').textContent = '已暂停';
  },

  resume() {
    if (!this.active) return;
    speechSynthesis.resume();
    this.paused = false;
    $('ttsPlayBtn').textContent = '⏸ 暂停';
    $('ttsStatus').textContent = `朗读中 ${this.idx + 1}/${this.seq.length}`;
  },

  /** 停止；silent=true 用于 start() 前的清理，不弹提示 */
  stop(silent) {
    this._stopFlag = true;
    this.active = false;
    this.paused = false;
    try { speechSynthesis.cancel(); } catch (e) { }
    this._utter = null;
    this.clearHighlight();
    const bar = $('ttsBar'); if (bar) bar.hidden = true;
    const btn = $('ttsBtn'); if (btn) btn.classList.remove('on');
    releaseWakeLock();
    if (!silent && this.seq.length) toast('已停止播读');
  },

  finish(msg) {
    const wasActive = this.active;
    this.stop(true);
    if (wasActive) toast(msg || '朗读结束');
  },

  setRate(v) {
    this.rate = parseFloat(v) || 1;
    $('ttsRateVal').textContent = this.rate.toFixed(1) + '×';
    Settings.ttsRate = this.rate;
    saveSettings();
    // 语速改变后立刻用新速度重读当前句
    if (this.active && !this.paused) {
      speechSynthesis.cancel();
      setTimeout(() => this.speakNext(), 60);
    }
  },

  setVoice(uri) {
    this.voiceURI = uri;
    Settings.ttsVoice = uri;
    saveSettings();
    if (this.active && !this.paused) {
      speechSynthesis.cancel();
      setTimeout(() => this.speakNext(), 60);
    }
  },

  /* ---------- 定位与高亮 ---------- */
  reveal(off) {
    if (R.format !== 'txt') return;
    if (Settings.direction === 'vertical') {
      const el = $('scrollLayer');
      const top = this.offsetToScrollTop(off);
      if (top != null && (top < el.scrollTop || top > el.scrollTop + el.clientHeight * 0.7)) {
        el.scrollTop = Math.max(0, top - el.clientHeight * 0.3);
        R.book.locator = off;
        reportScroll();
      }
      return;
    }
    // 分页模式：句子不在当前页则翻页
    const pi = R.pages.findIndex(p => off >= p.start && off < p.end);
    if (pi >= 0 && pi !== R.pageIndex) goToPage(pi, true);
  },

  offsetToScrollTop(off) {
    const inner = $('scrollInner');
    if (!inner) return null;
    const ps = inner.querySelectorAll('p[data-off]');
    let target = ps[0], prev = null;
    for (const p of ps) {
      const o = parseInt(p.dataset.off);
      if (o > off) break;
      prev = p; target = p;
    }
    if (!prev) return null;
    return prev.offsetTop;
  },

  /** 把 [off, off+len) 这段文本用浮层框出来（不改动 DOM） */
  highlight(off, len) {
    const box = $('ttsHl');
    if (!box) return;
    const host = (Settings.direction === 'vertical' ? $('scrollInner') : $('pageText'));
    if (!host) return;
    const range = this.rangeOf(host, off, off + len);
    if (!range) { box.hidden = true; return; }
    const hr = host.getBoundingClientRect();
    const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
    if (!rects.length) { box.hidden = true; return; }
    // 多行为：取首行与末行合成一个外框（简化为覆盖首行，滚动跟随更稳定）
    const r0 = rects[0], rn = rects[rects.length - 1];
    const left = Math.min(r0.left, rn.left) - hr.left;
    const right = Math.max(r0.right, rn.right) - hr.left;
    const top = r0.top - hr.top;
    const bottom = rn.bottom - hr.top;
    box.hidden = false;
    box.style.left = (left - 2) + 'px';
    box.style.top = (top - 2) + 'px';
    box.style.width = (right - left + 4) + 'px';
    box.style.height = (Math.min(bottom, r0.bottom) - top + 4) + 'px';
  },

  clearHighlight() { const b = $('ttsHl'); if (b) b.hidden = true; },

  /** 全局字符偏移 → DOM Range */
  rangeOf(root, start, end) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let acc = 0, sNode = null, sOff = 0, eNode = null, eOff = 0, n;
    while ((n = walker.nextNode())) {
      const len = n.nodeValue.length;
      if (!sNode && start < acc + len) { sNode = n; sOff = Math.max(0, start - acc); }
      if (end <= acc + len) { eNode = n; eOff = Math.max(0, end - acc); break; }
      acc += len;
    }
    if (!sNode || !eNode) return null;
    const range = document.createRange();
    try { range.setStart(sNode, sOff); range.setEnd(eNode, eOff); } catch (e) { return null; }
    return range;
  }
};

/* 朗读时把当前句浮层跟随滚动一起移动 */
window.addEventListener('load', () => {
  if ('speechSynthesis' in window) {
    speechSynthesis.onvoiceschanged = () => { TTS.loadVoices(); TTS.fillVoiceSelect(); };
    TTS.loadVoices();
  }
});
