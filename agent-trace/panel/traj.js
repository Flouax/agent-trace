/* traj.js — 轨迹页签：一次对话的「账本」。定位会话 → 取 traj/meta 与 traj/turns → 顶部总览 + 逐轮倒序列表。
 * 只面对统一结构（SPEC 第 3 节与附录 C），不关心引擎。页签隐藏时（onHide）停掉所有定时器与轮询。 */
(function () {
  'use strict';
  const P = window.AgentTraceTrajParts;
  const { T, h, icon, refreshIcon, fmtTok, fmtPct, fmtCost, fmtInt, fmtRate, turnNumbers, relTime, lastSeg, sessionName, modelLabel, humanError, copyText, store } = P;

  const AUTO_MS = 7000;           // 进行中时的自动刷新间隔
  const POLL_MS = 2500;           // 台前任务轮询间隔（SPEC：≥2 秒）
  const LIVE_MS = 2 * 60 * 1000;  // 判断「进行中」的窗口
  const IDLE_CHECK_EVERY = 5;     // 已结束的会话每 5 个周期（≈35 秒）才探一次，防止漏掉「用户回来继续对话」
  const CLOCK_MS = 30000;         // 「x 分钟前更新」的重算间隔
  const WATCH_MS = 10 * 60 * 1000; // 复制后等压缩发生的最长时间；没等到就安静收起
  const DONE_MS = 15000;          // 「已压缩」提示停留多久
  const COMPACT_ENGINES = ['cc', 'pi']; // Codex 自己管上下文，没有手动压缩
  const MANUAL_MAX = 50;
  const FORGET_CODES = ['NOT_FOUND', 'OUTSIDE_ROOTS', 'INVALID_PATH'];
  const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
  const COMPACT_TEXT = '/compact';

  /** 任务页（taskView）由宿主在地址里带上所在任务：?session=<任务 id>；全局右侧栏面板没有这个参数。 */
  function urlSessionId() {
    try { const v = new URLSearchParams(location.search).get('session'); return v && SESSION_ID_RE.test(v) ? v : null; } catch (err) { return null; }
  }
  const baseName = (p) => (p ? String(p).split(/[\\/]/).pop() : '');

  function mount(host, ctx) {
    const root = h('div', { class: 'tj' }); // 自己的容器：外壳的 section 带绝对定位，不和它抢布局
    host.appendChild(root);
    const call = (op, payload) => ctx.bridge.call(op, payload);
    const S = {
      gen: 0, locateSeq: 0, shown: false, booted: false,
      cindyId: null, resolved: null, path: null, manual: store.get('manual', {}),
      urlId: urlSessionId(), idSource: 'none', peekReason: null,
      status: 'loading', error: null, meta: null, turns: [], sig: '', growUntil: 0,
      refreshing: false, refreshError: null, tick: 0,
      timers: { poll: 0, auto: 0, clock: 0, note: 0 }, polling: false, sessions: null, pickerOpen: false,
      // compact：idle | watch（已复制，等转录里出现新的压缩）| done；watch = { count, before, until }
      compact: 'idle', watch: null, note: null, // note: { kind:'watch'|'fail'|'done', text, hint? }
    };
    const keyOf = (id) => id || '-';

    // —— 骨架：标题行、总览、匹配提示、列表 ——
    const el = {};
    el.title = h('h2', { class: 'tj-title', tabindex: '0' });
    el.engine = h('span', { class: 'tj-engine' });
    el.refresh = h('button', { class: 'tj-icon-btn', type: 'button', title: T.refresh, 'aria-label': T.refresh, onclick: () => refreshNow() }, refreshIcon());
    el.updated = h('p', { class: 'tj-updated' });
    el.head = h('header', { class: 'tj-head' }, h('div', { class: 'tj-head-row' }, el.title, el.engine, el.refresh), el.updated);
    el.match = h('section', { class: 'tj-match', hidden: true });
    el.overview = h('section', { class: 'tj-overview', hidden: true });
    el.list = h('section', { class: 'tj-ledger', hidden: true });
    el.state = h('section', { class: 'tj-state', hidden: true });
    root.append(el.head, el.match, el.overview, el.list, el.state);

    function setStatus(status, error) { S.status = status; S.error = error || null; root.dataset.status = status; paint(); }
    /** 进行中：转录最后一个事件在 2 分钟内，或最近一次刷新发现还在增长（模型长时间思考时文件可能一阵子没新行）。 */
    function isLive() {
      const m = S.meta;
      return !!m && ((m.endedAt != null && Date.now() - m.endedAt < LIVE_MS) || Date.now() < S.growUntil);
    }
    function canCompact() {
      const r = S.resolved; const eng = (S.meta && S.meta.engine) || (r && r.engine);
      return COMPACT_ENGINES.includes(eng) && !!S.cindyId && !!r && r.exact === true && r.via !== 'manual' && r.via !== 'latest' && !!S.meta;
    }
    function matchFailed() { const r = S.resolved; return !r || !r.path || r.exact === false || !S.cindyId || r.via === 'manual'; }
    function peekText(reason) { return reason ? `${T.peek[reason.code] || reason.message || reason.code}（${reason.code}）` : ''; }

    // —— 绘制 ——
    function paint() { paintHead(); paintMatch(); paintOverview(); paintList(); paintState(); }

    function paintHead() {
      const m = S.meta; const r = S.resolved;
      const info = m || (r && r.row ? { title: r.row.title, cwd: r.row.workingDir } : null);
      el.title.textContent = info ? sessionName(info) : '';
      el.title.title = matchTip();
      const eng = (m && m.engine) || (r && r.engine);
      el.engine.textContent = eng ? T.engineShort[eng] || eng : '';
      el.engine.title = eng ? T.engineName[eng] || eng : '';
      el.refresh.classList.toggle('is-busy', S.refreshing || S.status === 'loading');
      el.refresh.disabled = S.refreshing;
      el.updated.textContent = '';
      el.updated.hidden = !m || m.endedAt == null;
      if (m && m.endedAt != null) {
        if (isLive()) el.updated.append(h('span', { class: 'tj-live', 'aria-hidden': 'true' }));
        el.updated.append(T.updated(relTime(m.endedAt)));
      }
    }
    /** 匹配信息只放在标题的悬停提示里；匹配失败时才在页面上展开说明（paintMatch）。 */
    function matchTip() {
      const K = T.match.tip; const r = S.resolved;
      const lines = [
        `${K.source}：${T.match.sources[r && r.via === 'manual' ? 'manual' : S.idSource] || S.idSource}`,
        `${K.via}：${(r && r.via) || T.dash}`,
        `${K.exact}：${r ? (r.exact ? K.yes : K.no) : T.dash}`,
        `${K.engine}：${(S.meta && S.meta.engine) || (r && r.engine) || T.dash}`,
        `${K.file}：${baseName(S.path) || T.dash}`,
      ];
      if (S.peekReason) lines.push(`${K.peek}：${S.peekReason.code}`);
      if (S.meta && S.meta.warnings && S.meta.warnings.length) lines.push(`${K.warnings}：${S.meta.warnings.length}`);
      return lines.join('\n');
    }

    function paintMatch() {
      el.match.textContent = '';
      const r = S.resolved;
      const ready = S.status === 'ready' || S.status === 'empty';
      const show = ready && matchFailed();
      el.match.hidden = !show;
      if (!show) return;
      let head = null; let why = ''; let btn = null;
      if (r && r.via === 'manual') { head = T.match.manual; btn = h('button', { class: 'tj-text-btn', type: 'button', onclick: () => resetManual() }, T.match.reset); }
      else if (!S.cindyId) { head = T.match.noTaskId; why = `${peekText(S.peekReason)} ${T.match.inexactHint}`.trim(); }
      else { head = T.match.inexact; why = T.match.inexactHint; }
      el.match.append(h('p', { class: 'tj-match-head' }, head), why ? h('p', { class: 'tj-match-why' }, why) : null, h('p', { class: 'tj-match-why tj-pre' }, matchTip()));
      el.match.append(h('div', { class: 'tj-actions' }, btn, pickToggle()));
      if (S.pickerOpen) el.match.append(picker());
    }
    /** 匹配失败时「选择会话」是页面上的主要出路，用描边按钮；展开后变成安静的「收起」。 */
    function pickToggle() {
      return h('button', { class: S.pickerOpen ? 'tj-text-btn' : 'tj-btn', type: 'button', 'aria-expanded': String(S.pickerOpen), onclick: () => togglePicker() }, S.pickerOpen ? T.match.closePick : T.match.pick);
    }

    function paintOverview() {
      const m = S.meta;
      el.overview.hidden = !(m && (S.status === 'ready' || S.status === 'empty'));
      if (el.overview.hidden) return;
      el.overview.textContent = '';
      const tk = m.stats.tokens || {};
      const fed = (tk.input || 0) + (tk.cacheRead || 0) + (tk.cacheWrite || 0);
      const hit = h('div', { class: 'tj-hit' }, h('p', { class: 'tj-hero' }, fmtPct(m.cacheHitRate)), h('p', { class: 'tj-label' }, T.hit));
      const ctxBox = h('div', { class: 'tj-ctx' },
        h('p', { class: 'tj-ctx-line' }, h('span', { class: 'tj-label' }, T.context), ' ', h('span', { class: 'tj-ctx-v', title: m.contextModel || null }, fmtTok(m.contextTokens))));
      if (canCompact()) ctxBox.append(compactButton());
      el.overview.append(h('div', { class: 'tj-hero-row' }, hit, ctxBox));
      el.overview.append(compactPanel());
      const total = (label, value, title) => h('p', { class: 'tj-total', title: title || null }, h('span', { class: 'tj-label' }, label), ' ', h('span', { class: 'tj-total-v' }, value));
      el.overview.append(h('div', { class: 'tj-totals' },
        total(T.totals.input, fmtTok(fed), fmtInt(fed)), total(T.totals.output, fmtTok(tk.output), fmtInt(tk.output)), total(T.totals.cost, fmtCost(m.stats.costUsd))));
      if (S.refreshError) el.overview.append(h('p', { class: 'tj-foot' }, T.state.refreshFail(humanError(S.refreshError).code)));
      if (m.truncated) el.overview.append(h('p', { class: 'tj-foot' }, T.state.truncated));
    }

    // —— 压缩：点一下复制 /compact → 盯转录等新的压缩事件 → 显示结果 ——
    // Cindy 会给插件投递的消息加上来源说明，/compact 就不再是命令；插件也没有压缩接口。复制没有副作用，所以不再二次确认。
    const compactCount = (turns) => turns.filter((t) => t.compacted).length;
    function compactButton() {
      return h('button', { class: 'tj-btn', type: 'button', title: T.compact.btnTip, onclick: () => copyCompact() }, icon('compact'), T.compact.btn);
    }
    function compactPanel() {
      const inner = h('div', { class: 'tj-reveal-in' });
      if (S.note) {
        inner.append(h('div', { class: `tj-note is-${S.note.kind}`, role: 'status' },
          h('div', { class: 'tj-note-t' }, h('p', null, S.note.text), S.note.hint ? h('p', { class: 'tj-note-hint' }, S.note.hint) : null),
          h('div', { class: 'tj-actions' }, h('button', { class: 'tj-text-btn', type: 'button', onclick: () => closeNote() }, T.compact.close))));
      }
      return h('div', { class: `tj-reveal${S.note ? ' is-open' : ''}` }, inner);
    }
    function focusIn(sel) { const n = el.overview.querySelector(sel); if (n) n.focus(); }
    function closeNote() {
      clearTimeout(S.timers.note); S.timers.note = 0;
      S.compact = 'idle'; S.watch = null; S.note = null; paintOverview(); focusIn('.tj-ctx .tj-btn');
    }
    async function copyCompact() {
      const ok = await copyText(COMPACT_TEXT);
      clearTimeout(S.timers.note); S.timers.note = 0;
      // 复制失败也照样等：用户可能手动输入或点了上下文圆环
      S.compact = 'watch';
      S.watch = { count: compactCount(S.turns), before: S.meta ? S.meta.contextTokens : null, until: Date.now() + WATCH_MS };
      S.note = { kind: ok ? 'watch' : 'fail', text: ok ? T.compact.copied : T.compact.copyFail, hint: T.compact.ring };
      paintOverview();
      focusIn('.tj-note .tj-text-btn');
    }
    /** 每次拿到新数据都看一眼：压缩事件变多了就是压缩生效了；超时就收起。 */
    function checkWatch() {
      if (S.compact !== 'watch' || !S.watch) return;
      if (compactCount(S.turns) > S.watch.count) {
        const before = typeof S.watch.before === 'number' ? fmtTok(S.watch.before) : '';
        S.compact = 'done'; S.watch = null; S.note = { kind: 'done', text: T.compact.done(before) };
        clearTimeout(S.timers.note);
        S.timers.note = setTimeout(() => { if (S.compact === 'done') { S.compact = 'idle'; S.note = null; paintOverview(); } }, DONE_MS);
      } else if (Date.now() > S.watch.until) {
        S.compact = 'idle'; S.watch = null; S.note = null;
      }
    }

    // —— 逐轮列表：最新在上；系统注入的轮灰显、不编号 ——
    function paintList() {
      el.list.hidden = S.status !== 'ready';
      if (el.list.hidden) return;
      el.list.textContent = '';
      const counted = S.turns.filter((t) => !t.injected);
      const ordinal = new Map(counted.map((t, i) => [t.turn, i + 1]));
      // 没花 token 的注入轮（例如只有环境快照的开场）只是噪音，不列
      const rows = S.turns.filter((t) => { const v = turnNumbers(t); return !t.injected || v.input + v.output > 0; }).reverse();
      el.list.append(h('div', { class: 'tj-list-head' },
        h('p', { class: 'tj-count' }, T.turns(counted.length)),
        h('div', { class: 'tj-nums tj-nums-head', 'aria-hidden': 'true' },
          h('span', null, T.cols.input), h('span', null, T.cols.output), h('span', null, T.cols.hit), h('span', null, T.cols.rate))));
      const ol = h('ol', { class: 'tj-rows' });
      for (const t of rows) ol.append(row(t, ordinal.get(t.turn)));
      el.list.append(ol);
    }
    /** 注入轮的标题是宿主的整段说明，只留方括号里的名字（如 Session context rebuild）。 */
    function summaryOf(t) {
      const m = t.injected && /^\[([^\]\n]+?)\s*·\s*internal context\]/.exec(t.title || '');
      return m ? m[1] : t.title || T.noTitle;
    }
    function row(t, n) {
      const v = turnNumbers(t);
      const marks = [];
      if (t.modelChange) marks.push(T.modelChange(modelLabel(t.modelChange.from), modelLabel(t.modelChange.to)));
      if (t.compacted) marks.push(T.compacted);
      const bar = h('span', { class: 'tj-bar', 'aria-hidden': 'true' }, h('span', { class: 'tj-bar-fill' }));
      bar.style.setProperty('--hit', String(v.hit == null ? 0 : v.hit)); // CSSOM 写变量，不是内联 style 属性（CSP 允许）
      const label = `${t.injected ? T.injected : T.turn(n)}：${T.cols.input} ${fmtTok(v.input)}，${T.cols.output} ${fmtTok(v.output)}，${T.cols.hit} ${fmtPct(v.hit)}，${T.cols.rate} ${v.rate == null ? T.dash : fmtRate(v.rate) + ' ' + T.rateUnit}`;
      return h('li', { class: `tj-row${t.injected ? ' is-injected' : ''}`, 'aria-label': label, title: T.rowTip(fmtInt(v.input), fmtInt(v.cacheRead), fmtInt(v.cacheWrite), fmtInt(v.output), fmtRate(v.modelMs / 1000)) },
        h('div', { class: 'tj-row-main' },
          h('p', { class: 'tj-ord' }, t.injected ? T.injected : T.turn(n)),
          h('p', { class: 'tj-sum' }, summaryOf(t)),
          marks.map((m) => h('p', { class: 'tj-mark' }, m))),
        h('div', { class: 'tj-nums' },
          h('span', { class: 'tj-n-in' }, fmtTok(v.input)), h('span', { class: 'tj-n-out' }, fmtTok(v.output)),
          h('span', { class: 'tj-n-hit' }, fmtPct(v.hit)),
          h('span', { class: 'tj-n-rate' }, v.rate == null ? T.dash : [fmtRate(v.rate), h('small', null, ' ' + T.rateUnit)])),
        bar);
    }

    function paintState() {
      const st = S.status;
      el.state.textContent = '';
      el.state.hidden = st === 'ready';
      if (st === 'ready') return;
      if (st === 'loading') el.state.append(h('p', { class: 'tj-label' }, T.state.loading));
      else if (st === 'empty') el.state.append(h('p', { class: 'tj-state-h' }, T.state.empty), h('p', { class: 'tj-label' }, T.state.emptyHint));
      else if (st === 'none') {
        const why = !S.cindyId && S.peekReason ? peekText(S.peekReason) : ((S.resolved && S.resolved.reason) || T.match.noneHint);
        el.state.append(h('p', { class: 'tj-state-h' }, S.cindyId ? T.match.none : T.match.noTaskId), h('p', { class: 'tj-label' }, why), h('p', { class: 'tj-label tj-pre' }, matchTip()), h('div', { class: 'tj-actions' }, pickToggle()));
        if (S.pickerOpen) el.state.append(picker());
      } else if (st === 'error') {
        const he = humanError(S.error);
        el.state.append(h('p', { class: 'tj-state-h' }, T.state.error), h('p', null, he.text), h('p', { class: 'tj-label' }, he.code),
          h('div', { class: 'tj-actions' }, h('button', { class: 'tj-btn', type: 'button', onclick: () => locate() }, T.state.retry), pickToggle()));
        if (S.pickerOpen) el.state.append(picker());
      }
    }

    // —— 手动选择会话（只在匹配失败时出现） ——
    let pickerEl = null;
    function picker() {
      if (!pickerEl) {
        const input = h('input', { class: 'tj-input', type: 'text', placeholder: T.match.filter, 'aria-label': T.match.filter, autocomplete: 'off', spellcheck: 'false' });
        const listEl = h('div', { class: 'tj-picks', role: 'list' });
        input.addEventListener('input', () => fillPicker(listEl, input.value));
        pickerEl = h('div', { class: 'tj-picker' }, input, listEl);
      }
      fillPicker(pickerEl.lastChild, pickerEl.firstChild.value);
      return pickerEl;
    }
    function fillPicker(listEl, filter) {
      listEl.textContent = '';
      if (S.sessions === null) { listEl.append(h('p', { class: 'tj-label' }, T.match.listLoading)); return; }
      if (S.sessions instanceof Error) { listEl.append(h('p', { class: 'tj-label' }, `${T.match.listFail}：${humanError(S.sessions).text}`), h('button', { class: 'tj-text-btn', type: 'button', onclick: () => loadSessions() }, T.state.retry)); return; }
      const needle = String(filter || '').trim().toLowerCase();
      const rows = S.sessions.filter((x) => !needle || `${x.title || ''} ${x.cwd || ''} ${x.engine}`.toLowerCase().includes(needle));
      if (!rows.length) listEl.append(h('p', { class: 'tj-label' }, T.match.listEmpty));
      for (const x of rows) {
        const cur = x.path === S.path;
        listEl.append(h('button', { class: `tj-pick${cur ? ' is-current' : ''}`, type: 'button', role: 'listitem', title: x.path, onclick: () => pickSession(x) },
          h('span', { class: 'tj-pick-t' }, x.title || T.untitled),
          h('span', { class: 'tj-pick-s' }, `${lastSeg(x.cwd) || T.dash}，${relTime(x.mtime)}`),
          h('span', { class: 'tj-pick-e' }, cur ? T.match.current : T.engineShort[x.engine] || x.engine)));
      }
    }
    function togglePicker(force) {
      S.pickerOpen = force != null ? force : !S.pickerOpen;
      if (S.pickerOpen && !Array.isArray(S.sessions)) loadSessions();
      paintMatch(); paintState();
      if (S.pickerOpen && pickerEl) pickerEl.firstChild.focus();
    }
    async function loadSessions() {
      S.sessions = null; repaintPicker();
      try { S.sessions = (await call('sessions/list', { limit: 60 })).sessions || []; } catch (e) { S.sessions = e instanceof Error ? e : Object.assign(new Error(''), e); }
      repaintPicker();
    }
    function repaintPicker() { if (pickerEl) fillPicker(pickerEl.lastChild, pickerEl.firstChild.value); }
    function pickSession(x) {
      S.manual[keyOf(S.cindyId)] = { path: x.path, engine: x.engine };
      const keys = Object.keys(S.manual);
      while (keys.length > MANUAL_MAX) delete S.manual[keys.shift()];
      store.set('manual', S.manual);
      S.pickerOpen = false;
      locate();
    }
    function resetManual() { delete S.manual[keyOf(S.cindyId)]; store.set('manual', S.manual); locate(); }

    // —— 定位会话 ——
    async function locate() {
      const mine = ++S.locateSeq;
      if (S.urlId) {
        S.cindyId = S.urlId; S.idSource = 'url'; S.peekReason = null; // 任务页：任务 id 固定，不问 peek
      } else {
        let cur = null;
        try { cur = await call('current', {}); } catch (e) {
          if (!S.cindyId) S.peekReason = { code: (e && e.code) || 'FAILED', message: (e && e.message) || '' };
        }
        if (mine !== S.locateSeq) return;
        if (cur) { S.cindyId = cur.sessionId || null; S.peekReason = cur.sessionId ? null : (cur.reason || { code: 'NO_SESSION', message: '' }); }
        S.idSource = S.cindyId ? 'peek' : 'none';
      }
      const manual = S.manual[keyOf(S.cindyId)];
      let resolved;
      if (manual && manual.path) resolved = { path: manual.path, engine: manual.engine, via: 'manual', exact: true };
      else {
        try { resolved = await call('sessions/resolve', S.cindyId ? { sessionId: S.cindyId } : {}); } catch (e) {
          if (mine !== S.locateSeq) return;
          if (!S.meta) { S.resolved = null; setStatus('error', e); } else { S.refreshError = e; paint(); }
          return;
        }
        if (mine !== S.locateSeq) return;
      }
      S.resolved = resolved;
      if (!S.cindyId && resolved.peek) S.peekReason = resolved.peek;
      if (!resolved.path) { S.gen += 1; S.path = null; S.meta = null; S.turns = []; setStatus('none'); return; }
      if (resolved.path === S.path && S.status === 'loading') return;
      if (resolved.path === S.path && (S.status === 'ready' || S.status === 'empty')) { paint(); refreshNow(); return; }
      S.path = resolved.path;
      hardLoad();
    }

    const sigOf = (m) => `${m.stats.steps}|${m.endedAt}|${m.stats.tokens ? m.stats.tokens.total : ''}`;
    function apply(meta, turns) {
      S.meta = meta; S.sig = sigOf(meta); S.turns = turns || [];
      S.refreshError = null;
      checkWatch();
      setStatus(S.turns.some((t) => !t.injected) || S.turns.some((t) => turnNumbers(t).input > 0) ? 'ready' : 'empty');
    }
    async function hardLoad() {
      const gen = ++S.gen; const path = S.path;
      S.meta = null; S.turns = []; S.sig = ''; S.growUntil = 0; S.refreshError = null; S.compact = 'idle'; S.watch = null; S.note = null;
      clearTimeout(S.timers.note); S.timers.note = 0;
      setStatus('loading');
      try {
        const [meta, turns] = await Promise.all([call('traj/meta', { path }), call('traj/turns', { path })]);
        if (gen !== S.gen) return;
        apply(meta, turns.turns);
      } catch (e) {
        if (gen !== S.gen) return;
        if (S.resolved && S.resolved.via === 'manual' && FORGET_CODES.includes(e.code)) { delete S.manual[keyOf(S.cindyId)]; store.set('manual', S.manual); S.path = null; locate(); return; }
        setStatus('error', e);
      }
    }
    /** 刷新：先只问 meta，没变化就不重拉；有变化再取 traj/turns。 */
    async function refreshNow() {
      if (S.refreshing || S.status === 'loading') return;
      if (!S.path || S.status === 'error' || S.status === 'none') { locate(); return; }
      const gen = S.gen; const path = S.path;
      S.refreshing = true; paintHead();
      try {
        const meta = await call('traj/meta', { path });
        if (gen !== S.gen) return;
        if (sigOf(meta) !== S.sig) {
          if (S.meta && meta.stats.steps > S.meta.stats.steps) S.growUntil = Date.now() + LIVE_MS;
          const turns = await call('traj/turns', { path });
          if (gen !== S.gen) return;
          apply(meta, turns.turns);
        } else { S.meta = meta; S.refreshError = null; checkWatch(); }
      } catch (e) {
        if (gen === S.gen) S.refreshError = e;
      } finally {
        S.refreshing = false;
        if (gen === S.gen) { paintHead(); paintOverview(); }
      }
    }

    // —— 定时器 ——
    function pollCurrent() {
      if (S.polling || !S.shown || document.hidden || S.urlId) return; // 任务页绑定在自己的任务上，不跟随台前任务
      S.polling = true;
      call('current', {}).then((cur) => {
        if (!S.shown) return;
        const id = (cur && cur.sessionId) || null;
        if (S.booted && id !== S.cindyId) locate();
      }, () => { /* 读不到就等下一轮 */ }).finally(() => { S.polling = false; });
    }
    function autoTick() {
      if (!S.shown || document.hidden || (S.status !== 'ready' && S.status !== 'empty')) return;
      S.tick += 1;
      // 等压缩时按进行中的节奏刷新，结果才能及时出现
      if (!isLive() && S.compact !== 'watch' && S.tick % IDLE_CHECK_EVERY !== 0) return;
      refreshNow();
    }
    function startTimers() {
      stopTimers();
      S.timers.poll = setInterval(pollCurrent, POLL_MS);
      S.timers.auto = setInterval(autoTick, AUTO_MS);
      S.timers.clock = setInterval(() => { if (!document.hidden) paintHead(); }, CLOCK_MS);
    }
    function stopTimers() {
      clearInterval(S.timers.poll); clearInterval(S.timers.auto); clearInterval(S.timers.clock);
      S.timers.poll = S.timers.auto = S.timers.clock = 0;
    }
    function onVisibility() { if (S.shown && !document.hidden) { pollCurrent(); if (S.booted) refreshNow(); } }
    function onKey(ev) {
      if (ev.key !== 'Escape' || !S.shown) return;
      if (S.note) { closeNote(); ev.preventDefault(); }
      else if (S.pickerOpen) { togglePicker(false); ev.preventDefault(); }
    }

    paint();

    return {
      show() {
        S.shown = true;
        document.addEventListener('visibilitychange', onVisibility);
        document.addEventListener('keydown', onKey);
        startTimers();
        S.booted = true; locate();
      },
      hide() {
        S.shown = false; stopTimers();
        document.removeEventListener('visibilitychange', onVisibility);
        document.removeEventListener('keydown', onKey);
      },
      debug: () => ({ status: S.status, path: S.path, cindyId: S.cindyId, idSource: S.idSource, peekCode: S.peekReason ? S.peekReason.code : null, turns: S.turns.length, compact: S.compact, timers: { ...S.timers }, live: isLive(), canCompact: canCompact() }),
    };
  }

  let inst = null;
  window.AgentTraceTraj = {
    mount(root, ctx) { inst = mount(root, ctx); },
    onShow() { if (inst) inst.show(); },
    onHide() { if (inst) inst.hide(); },
    _debug() { return inst ? inst.debug() : null; },
  };
})();
