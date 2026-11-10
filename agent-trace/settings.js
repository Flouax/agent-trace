/* settings.js — 设置页：复用余额页签的同一个模块来管理供应商（只在这里补一个最小的 toast）。 */
(function () {
  'use strict';

  const TEXT = { toastFailed: '余额模块没有加载成功' };

  let timer = 0;
  function toast(message) {
    let el = document.getElementById('settingsToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'settingsToast';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);max-width:90%;padding:6px 12px;border-radius:8px;' +
        'font-size:12px;background:var(--at-ink,var(--text-primary,#1a1a1a));color:var(--at-bg,var(--panel-bg,#f7f7f5))';
      document.body.append(el);
    }
    el.textContent = String(message || '');
    el.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  const mod = window.AgentTraceBalance;
  const root = document.getElementById('balance-root');
  if (!mod || !root) {
    toast(TEXT.toastFailed);
    return;
  }
  mod.mount(root, { bridge: window.AgentTrace.bridge, toast, locale: 'zh-CN' });
  if (mod.onShow) mod.onShow();
  // 设置页被隐藏或关闭时停掉相对时间的刷新定时器
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (mod.onHide) mod.onHide(); } else if (mod.onShow) mod.onShow();
  });
})();
