/* fx.js — 点击按钮时从指针处迸出 4 个像素小方块（样式见 fx.css 的 .at-px）。
 * 只用 Web Animations API 与 CSSOM，不写内联 style 属性（CSP）；系统开了「减少动态效果」时什么也不做。
 * 每次最多 4 个节点，动画结束即删除，不常驻、不跟随鼠标移动。 */
(function () {
  'use strict';
  const DIST = 6;       // 飞出的距离（px），正好 3 格
  const STEPS = 3;      // 分 3 帧跳过去
  const MS = 160;       // 与 --at-fx-ms 一致
  const DIRS = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  const reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  function burst(x, y, color) {
    for (const [dx, dy] of DIRS) {
      const px = document.createElement('div');
      px.className = 'at-px';
      px.setAttribute('aria-hidden', 'true');
      px.style.setProperty('left', `${x}px`);
      px.style.setProperty('top', `${y}px`);
      px.style.setProperty('color', color);
      document.body.appendChild(px);
      const anim = px.animate(
        [{ transform: 'translate(0, 0)', opacity: 1 }, { transform: `translate(${dx * DIST}px, ${dy * DIST}px)`, opacity: 0 }],
        { duration: MS, easing: `steps(${STEPS}, end)`, fill: 'forwards' },
      );
      anim.onfinish = () => px.remove();
      anim.oncancel = () => px.remove();
    }
  }

  document.addEventListener('pointerdown', (ev) => {
    if (reduced.matches || ev.button !== 0 || typeof Element.prototype.animate !== 'function') return;
    const btn = ev.target && ev.target.closest ? ev.target.closest('button:not(:disabled)') : null;
    if (!btn) return;
    burst(ev.clientX, ev.clientY, getComputedStyle(btn).color);
  }, { passive: true });
})();
