/**
 * main.js — 轨迹与余额的电子脑（浏览器沙箱后台逻辑，没有 Node、没有直连网络）。
 *
 * 面板页零桥，只能走 BroadcastChannel；这里负责三件事：
 * 1) 回答「现在台前是哪个任务」（cindy.taskView peek，只查询），失败时把原因带回页面；
 * 2) 把读盘与脚本分析请求转给随包 Node 工作进程（node/worker.cjs）；
 * 3) 余额：用 cindy.fetch 代发请求（密钥由宿主按连接注入，这里永远拿不到明文）。
 *
 * 协议见 plugins/agent-trace-dev/SPEC.md 第 5 节。本文件归协调者；
 * 余额任务只允许修改 BEGIN balance / END balance 之间的部分。
 */

const CH = 'cindy-agent-trace-v1';
const WORKER_TIMEOUT_MS = 25000;

/** 允许从页面转给 Node 工作进程的方法（白名单，页面不能随意调用任意方法）。 */
const WORKER_METHODS = new Set([
  'sessions/resolve',
  'sessions/list',
  'traj/meta',
  'traj/turns',
  'traj/timeline',
  'traj/load',
  'traj/step',
  'traj/search',
  'balance/analyze',
  'balance/extract',
]);

const channel = new BroadcastChannel(CH);
const inflight = new Set();

function reply(reqId, ok, payload) {
  channel.postMessage({ ch: CH, reqId, from: 'brain', ok, data: ok ? payload : undefined, error: ok ? undefined : payload });
}

async function callWorker(method, params, timeoutMs) {
  const res = await cindy.node.request({ method, params: params || {}, timeoutMs: timeoutMs || WORKER_TIMEOUT_MS });
  if (!res || res.ok !== true) {
    const message = (res && res.message) || '本机 Node 工作进程没有响应';
    throw Object.assign(new Error(message), { code: (res && res.errorCode) || 'WORKER_FAILED' });
  }
  return res.result;
}

/**
 * 台前任务（cindy.taskView peek，只查询、不开页签）。返回 { sessionId, reason }：
 * 拿到时 reason 为 null；拿不到时 sessionId 为 null，reason 带宿主的错误码与说明，界面据此告诉用户原因。
 * 宿主在插件没声明 taskView 时回 PERMISSION_DENIED，没有台前任务时回 HOST_NOT_READY（都是回执，不抛异常）。
 */
async function peekFront() {
  if (typeof cindy.taskView !== 'function') return { sessionId: null, reason: { code: 'TASKVIEW_UNAVAILABLE', message: '宿主没有提供 cindy.taskView' } };
  try {
    const res = await cindy.taskView({ peek: true });
    if (res && res.ok && res.sessionId) return { sessionId: String(res.sessionId), reason: null };
    return { sessionId: null, reason: { code: (res && res.errorCode) || 'NO_SESSION', message: (res && res.message) || '宿主没有返回台前任务' } };
  } catch (err) {
    return { sessionId: null, reason: { code: (err && err.code) || 'TASKVIEW_FAILED', message: (err && err.message) || '查询台前任务失败' } };
  }
}

/** 任务页里由页面经 URL 参数 session 传来任务 id；宿主对形状另有校验，这里只挡明显不合法的值。 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const handlers = {
  async current() {
    const { sessionId, reason } = await peekFront();
    return { sessionId, source: sessionId ? 'peek' : null, reason };
  },

  /** 台前任务 → 转录。payload.sessionId 可显式指定（URL 参数或页面记住的任务）；没给就问 peek。 */
  async 'sessions/resolve'(payload) {
    const given = String((payload && payload.sessionId) || '');
    const front = given ? null : await peekFront();
    const sessionId = given || (front && front.sessionId) || '';
    const resolved = await callWorker('sessions/resolve', { ...(payload || {}), sessionId });
    return { ...resolved, cindySessionId: sessionId || null, peek: front ? front.reason : null };
  },

  /** 在指定任务（缺省台前任务）的右侧栏打开本插件的任务页签；不传 focus，不切换任务。 */
  async openTaskView(payload) {
    if (typeof cindy.taskView !== 'function') throw Object.assign(new Error('宿主没有提供 cindy.taskView'), { code: 'TASKVIEW_UNAVAILABLE' });
    const sessionId = payload && typeof payload.sessionId === 'string' && SESSION_ID_RE.test(payload.sessionId) ? payload.sessionId : undefined;
    const res = await cindy.taskView(sessionId ? { sessionId } : {});
    if (!res || !res.ok) throw Object.assign(new Error((res && res.message) || '打开任务页签失败'), { code: (res && res.errorCode) || 'TASKVIEW_FAILED' });
    return { sessionId: res.sessionId || sessionId || null };
  },

  /*
   * 没有「压缩」操作（0.2.0 起）：插件经 cindy.targets.send 投递的消息会被宿主加上「[消息来源] 本条由插件…」说明，
   * /compact 就不再是命令，反而在对话里多出一条没用的消息；宿主的手动压缩通道也不对插件开放。
   * 所以页面只复制 /compact，并盯转录等压缩发生（见 traj.js）。Cindy 将来开放压缩接口时再接回来。
   */

  /* BEGIN balance — 余额任务（T3）负责本段；不要改段外的代码 */
  /**
   * 余额查询代发。request 来自 balance/analyze（已去掉密钥头）；Authorization / x-api-key 由宿主按连接注入，
   * 所以这里既不写也不读密钥。失败时把宿主给的 errorCode 与 message 原样带回页面。
   */
  async 'balance/fetch'(payload) {
    // 常量与校验函数放在处理函数内部：本段之外的代码归协调者，不往外扩散
    const TIMEOUT_MS = 10000;
    const TEXT_MAX = 128 * 1024;
    const RETRY_CODES = new Set(['NETWORK_TIMEOUT', 'CONNECTION_RESET', 'NETWORK_ERROR', 'DNS_FAILED']);
    const RETRY_STATUS = new Set([502, 503, 504]);
    // 这些头由宿主或网络层管理，页面传来也不转发（尤其是密钥头：只能由宿主按连接注入）
    const MANAGED = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'cookie', 'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'keep-alive']);
    const bad = (message) => Object.assign(new Error(message), { code: 'INVALID_REQUEST' });

    const src = payload && payload.request;
    if (!src || typeof src !== 'object' || typeof src.url !== 'string') throw bad('缺少请求信息，请先解析脚本');
    const method = String(src.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') throw bad('只支持 GET 和 POST 请求');
    let parsed;
    try { parsed = new URL(src.url); } catch (err) { throw bad('请求地址无效'); }
    if (parsed.protocol !== 'https:' || parsed.port) throw bad('只支持 https 默认端口的地址');
    const headers = {};
    for (const [name, value] of Object.entries(src.headers && typeof src.headers === 'object' ? src.headers : {})) {
      if (typeof value !== 'string' || MANAGED.has(name.toLowerCase())) continue;
      headers[name] = value;
    }
    const body = method === 'POST' && typeof src.body === 'string' ? src.body : undefined;
    if (body !== undefined && body.length > 16 * 1024) throw bad('请求体太大');

    const timeoutMs = Math.min(Math.max(Number(payload && payload.timeoutMs) || TIMEOUT_MS, 1000), 30000);
    // 只有 GET 才可能重试：POST 在超时或断线时对方可能已执行，不能重放。重试总共最多一次。
    const attempts = method === 'GET' ? 2 : 1;
    let last = null;
    for (let i = 0; i < attempts; i += 1) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 600));
      const res = await cindy.fetch({ url: parsed.href, method, headers, body, timeoutMs, as: 'text' });
      if (res && res.ok) {
        last = res;
        if (!RETRY_STATUS.has(res.status)) break;
        continue;
      }
      const code = (res && res.errorCode) || 'FETCH_FAILED';
      last = { failed: true, code, message: (res && res.message) || '网络请求失败' };
      if (!RETRY_CODES.has(code)) break;
    }
    if (last.failed) throw Object.assign(new Error(last.message), { code: last.code });
    const text = typeof last.body === 'string' ? last.body : last.body == null ? '' : String(last.body);
    const truncated = Boolean(last.truncated) || text.length > TEXT_MAX;
    // content-type 随结果带回：页面靠它区分「返回了网页」与「返回了数据」，好给用户说人话的提示
    let contentType = '';
    for (const [name, value] of Object.entries(last.headers && typeof last.headers === 'object' ? last.headers : {})) {
      if (name.toLowerCase() === 'content-type') contentType = String(value).slice(0, 120);
    }
    return { status: last.status, ok: last.status >= 200 && last.status < 300, contentType, text: text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) : text, truncated };
  },
  /* END balance */
};

channel.onmessage = async (event) => {
  const msg = event && event.data;
  if (!msg || msg.ch !== CH || !msg.reqId || !msg.op || msg.from === 'brain') return;
  const { reqId, op } = msg;
  if (inflight.has(reqId)) return;
  inflight.add(reqId);
  try {
    let data;
    if (handlers[op]) data = await handlers[op](msg.payload || {});
    else if (WORKER_METHODS.has(op)) data = await callWorker(op, msg.payload || {});
    else throw Object.assign(new Error(`未知操作: ${op}`), { code: 'UNKNOWN_OP' });
    reply(reqId, true, data);
  } catch (err) {
    reply(reqId, false, { code: (err && err.code) || 'INTERNAL', message: (err && err.message) || '操作失败' });
  } finally {
    // 页面会按 reqId 重发直到收到回执；保留一会儿避免晚到的重发被重复执行
    setTimeout(() => inflight.delete(reqId), 30000);
  }
};
