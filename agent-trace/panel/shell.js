/* shell.js — 页签切换与模块挂载。两个功能模块各自导出 { mount(root, ctx), onShow?(), onHide?() }。 */
(function () {
  'use strict';

  const modules = { traj: window.AgentTraceTraj, balance: window.AgentTraceBalance };
  const mounted = new Set();
  let current = null;
  let toastTimer = 0;

  function toast(message) {
    const el = document.getElementById('shellToast');
    el.textContent = String(message || '');
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  const ctx = { bridge: window.AgentTrace.bridge, toast, locale: 'zh-CN' };

  function show(tab) {
    if (!modules[tab] || tab === current) return;
    if (current && modules[current] && modules[current].onHide) modules[current].onHide();
    current = tab;
    for (const btn of document.querySelectorAll('.shell-tab')) btn.setAttribute('aria-selected', String(btn.dataset.tab === tab));
    for (const name of Object.keys(modules)) document.getElementById('view-' + name).hidden = name !== tab;
    if (!mounted.has(tab)) {
      mounted.add(tab);
      modules[tab].mount(document.getElementById('view-' + tab), ctx);
    }
    if (modules[tab].onShow) modules[tab].onShow();
    try { localStorage.setItem('agent-trace.tab', tab); } catch (err) { /* 存储不可用就不记住 */ }
  }

  /* ---------- 页签栏右侧的余额芯片 ----------
   * 数据来自余额模块的 summary()（读 /kv 里上次查询的缓存），不要求「余额」页签已经 mount。
   * 只显示用户在余额页签里勾选了「显示在页签栏」的；一个都没勾就整块不显示（连刷新图标也不显示）。
   * 只勾了一个时芯片只放金额，名称进悬停提示。同页用 window 事件、别的页面（设置页）用 BroadcastChannel 同步。 */
  const TEXT = { refresh: '刷新全部余额', refreshing: '正在刷新余额…', failedMark: '!', more: (n) => `+${n}`, groupLabel: '余额' };
  const MAX_CHIPS = 2;
  const NARROW_PX = 360; // 比这更窄时只放得下 1 个芯片，其余并进 +N
  const maxChips = () => (window.innerWidth < NARROW_PX ? 1 : MAX_CHIPS);
  const balance = modules.balance;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** 与余额页签里的刷新同一个像素图标（icons.js）。 */
  const icon = (name) => (window.AgentTraceIcons ? window.AgentTraceIcons.make(name) : document.createTextNode(''));
  function refreshIcon() { return icon('refresh'); }

  function initChips() {
    if (!balance || typeof balance.summary !== 'function') return;
    const nav = document.querySelector('.shell-tabs');
    const box = el('div', 'shell-chips');
    box.hidden = true;
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', TEXT.groupLabel);
    const list = el('div', 'shell-chips-list');
    const refresh = el('button', 'shell-chip-refresh');
    refresh.append(refreshIcon());
    refresh.type = 'button';
    refresh.title = TEXT.refresh;
    refresh.setAttribute('aria-label', TEXT.refresh);
    box.append(list, refresh);
    nav.append(box);

    let token = 0;
    function setRefreshing(on) {
      refresh.disabled = on;
      refresh.classList.toggle('spinning', on);
      refresh.title = on ? TEXT.refreshing : TEXT.refresh;
    }

    function chipButton(chip, single) {
      const btn = el('button', 'shell-chip');
      btn.type = 'button';
      if (chip.stale || chip.failed) btn.classList.add('is-dim');
      if (chip.failed) btn.classList.add('is-failed');
      if (chip.invalid) btn.classList.add('is-invalid');
      if (!single) btn.append(el('span', 'shell-chip-name', chip.name));
      btn.append(el('span', 'shell-chip-amount', chip.text));
      if (chip.failed) btn.append(el('span', 'shell-chip-warn', TEXT.failedMark));
      btn.title = balance.chipTitle(chip);
      // 悬停时再算一次：「更新于 x 分钟前」不会因为页面开得久而过期
      btn.addEventListener('mouseenter', () => { btn.title = balance.chipTitle(chip); });
      btn.addEventListener('click', () => show('balance'));
      return btn;
    }

    async function update() {
      const mine = ++token;
      const data = await balance.summary();
      if (mine !== token) return;
      list.textContent = '';
      box.hidden = !data.chips.length;
      if (!data.chips.length) return;
      const shown = maxChips();
      const single = data.chips.length === 1;
      for (const chip of data.chips.slice(0, shown)) list.append(chipButton(chip, single));
      if (data.chips.length > shown) {
        const more = el('button', 'shell-chip shell-chip-more', TEXT.more(data.chips.length - shown));
        more.type = 'button';
        more.title = data.chips.map((c) => `${c.name}  ${c.text}`).join('\n');
        more.addEventListener('click', () => show('balance'));
        list.append(more);
      }
      setRefreshing(Boolean(data.refreshing));
    }

    refresh.addEventListener('click', () => { setRefreshing(true); balance.refreshAll().catch(() => {}).then(() => setRefreshing(false)); });
    const events = balance.events;
    window.addEventListener(events.updated, update);
    window.addEventListener(events.refreshing, (event) => setRefreshing(Boolean(event.detail && event.detail.refreshing)));
    if (typeof BroadcastChannel === 'function') {
      const channel = new BroadcastChannel(events.channel);
      channel.onmessage = (event) => {
        const m = event && event.data;
        if (m && m.type === 'balance-updated' && m.source !== balance.pageId) update();
      };
    }
    // 面板变得可见：告诉电子脑一声，满 10 分钟没刷就补刷（定时器在电子脑里，见 SPEC 附录 H）
    const reportSeen = () => { if (balance.seen) balance.seen(); };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { update(); reportSeen(); } });
    let resizeTimer = 0;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(update, 150); });
    // 先画出缓存，再报告可见（只在主面板页；设置页不报告）
    update().then(() => { if (document.visibilityState === 'visible') reportSeen(); }).catch(() => {});
  }

  const TAB_ICONS = { traj: 'trace', balance: 'wallet' };
  for (const btn of document.querySelectorAll('.shell-tab')) {
    if (TAB_ICONS[btn.dataset.tab]) btn.prepend(icon(TAB_ICONS[btn.dataset.tab]));
    btn.addEventListener('click', () => show(btn.dataset.tab));
  }
  let initial = 'traj';
  try { initial = localStorage.getItem('agent-trace.tab') || 'traj'; } catch (err) { /* 忽略 */ }
  show(modules[initial] ? initial : 'traj');
  initChips();
})();
