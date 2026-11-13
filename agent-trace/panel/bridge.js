/* bridge.js — 页面 ↔ main.js 的 BroadcastChannel 客户端（协议见 SPEC.md 第 5 节）。 */
(function () {
  'use strict';

  const GHOST_ID = 'agent-trace';
  const CH = 'cindy-agent-trace-v1';
  const RETRY_MS = 450;
  const MAX_TRIES = 100; // ≈ 45 秒：首次解析大文件可能较慢

  const bus = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CH) : null;
  const waiting = new Map();
  let seq = 0;

  if (bus) {
    bus.onmessage = (event) => {
      const msg = event && event.data;
      if (!msg || msg.ch !== CH || msg.from !== 'brain' || !msg.reqId) return;
      const pending = waiting.get(msg.reqId);
      if (!pending) return;
      waiting.delete(msg.reqId);
      if (msg.ok) pending.resolve(msg.data);
      else pending.reject(Object.assign(new Error((msg.error && msg.error.message) || '操作失败'), { code: (msg.error && msg.error.code) || 'FAILED' }));
    };
  }

  async function wake() {
    try { await fetch(`cindy-ghost://${GHOST_ID}/wake`); } catch (err) { /* 已在运行或宿主不支持时忽略 */ }
  }

  /**
   * 调用 main.js 的一个操作。电子脑按需拉起，所以先唤醒，再按 reqId 每 450ms 重发直到收到回执
   * （main.js 按 reqId 去重）。开发时可设置 window.__AGENT_TRACE_MOCK__ = (op, payload) => data 绕过真实通道。
   * opts.timeoutMs 放宽等待上限（如刷新全部余额最多 120 秒），缺省约 45 秒。
   */
  function call(op, payload, opts) {
    const mock = window.__AGENT_TRACE_MOCK__;
    if (typeof mock === 'function') return Promise.resolve().then(() => mock(op, payload || {}));
    if (!bus) return Promise.reject(Object.assign(new Error('当前环境不支持 BroadcastChannel'), { code: 'NO_BUS' }));
    const reqId = `${Date.now().toString(36)}-${(seq++).toString(36)}`;
    const maxTries = opts && Number(opts.timeoutMs) > 0 ? Math.ceil(Number(opts.timeoutMs) / RETRY_MS) : MAX_TRIES;
    return new Promise((resolve, reject) => {
      let tries = 0;
      const timer = setInterval(() => {
        if (!waiting.has(reqId)) return;
        tries += 1;
        if (tries > maxTries) {
          clearInterval(timer);
          waiting.delete(reqId);
          reject(Object.assign(new Error('电子脑没有响应，请重试'), { code: 'TIMEOUT' }));
          return;
        }
        bus.postMessage({ ch: CH, reqId, op, payload: payload || {}, from: 'page' });
      }, RETRY_MS);
      const done = (fn) => (v) => { clearInterval(timer); fn(v); };
      waiting.set(reqId, { resolve: done(resolve), reject: done(reject) });
      wake().then(() => bus.postMessage({ ch: CH, reqId, op, payload: payload || {}, from: 'page' }));
    });
  }

  window.AgentTrace = Object.assign(window.AgentTrace || {}, { bridge: { call } });
})();
