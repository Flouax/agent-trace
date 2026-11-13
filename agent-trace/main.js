/**
 * main.js — 轨迹与余额的电子脑（浏览器沙箱后台逻辑，没有 Node、没有直连网络）。
 *
 * 面板页零桥，只能走 BroadcastChannel；这里负责三件事：
 * 1) 回答「现在台前是哪个任务」（cindy.taskView peek，只查询），失败时把原因带回页面；
 * 2) 把读盘与脚本分析请求转给随包 Node 工作进程（node/worker.cjs）；
 * 3) 余额：refreshBalances 是唯一的查询实现（状态栏点击、面板刷新、本文件里的 10 分钟自动刷新都调它），
 *    用 cindy.fetch 代发请求（密钥由宿主按连接注入，这里永远拿不到明文）；并更新状态栏原生按钮的文字；
 * 4) 伙伴聊天状态栏的「上下文 N%」：按任务查对话记录（Node 的 context/status），只在伙伴会话显示。
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

/* BEGIN balance-fetch — 余额代发（原 balance/fetch 处理函数；refreshBalances 内部调用，管子操作 balance/fetch 仍保留） */
async function balanceFetch(payload) {
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
}
/* END balance-fetch */

/* BEGIN balance-refresh — 余额刷新（唯一的查询实现）与状态栏文字，契约见 SPEC 附录 F */
const BAL = {
  syncChannel: 'agent-trace-balance-v1',
  contribution: 'balance',
  tool: 'refresh_balance',
  concurrency: 3,
  kvBytes: 64 * 1024,
  staleMs: 60 * 60 * 1000,
  tickMs: 60 * 1000,
  autoMs: 10 * 60 * 1000, // 自动刷新周期：距上次整批刷新完成满 10 分钟、且有人在看才刷（SPEC 附录 H）
  locale: 'zh-CN',
};

/** 错误文案（从 panel/balance.js 搬来，页面不再自己查询）。 */
const BT = {
  httpAuth: (status) => `认证失败（HTTP ${status}），请检查密钥是否正确、脚本里的认证头写法是否和供应商要求一致。`,
  httpNotFound: (path) => `接口路径不存在（HTTP 404），请检查 Base URL 和脚本里的路径。请求的路径是 ${path}。`,
  httpRate: '请求太频繁了（HTTP 429），稍等一会儿再试。',
  httpServer: (status) => `供应商服务出错（HTTP ${status}），请稍后重试。`,
  httpOther: (status, snippet) => `供应商返回了 HTTP ${status}${snippet ? `：${snippet}` : '。'}`,
  notJsonHtml: (status, path) => `返回的是网页而不是数据（HTTP ${status}）。多半是请求路径不对，这类站点对不存在的路径会返回首页。请求的路径是 ${path}。`,
  notJson: (status, snippet) => `返回的内容不是 JSON（HTTP ${status}）${snippet ? `：${snippet}` : '。'}`,
  providerSaid: (msg) => `对方的说明：${msg}`,
  truncated: '供应商返回的内容过大，已被截断，无法解析。',
  hintReenter: '如果提示和密钥有关，可点「编辑」重新输入密钥。',
  bridgeTimeout: '后台服务没有响应，请稍后重试。',
  unknown: '出了点问题，请稍后重试。',
  errTargetChanged: '脚本现在指向的域名或密钥位置和已保存的不一致，请点「编辑」确认后重新输入密钥。',
  errKvFull: '已保存的数据快到存储上限（64KB）了，请先删除不用的供应商，或精简脚本。',
  net: {
    NETWORK_TIMEOUT: '请求超时了，供应商那边响应太慢或网络不通。稍后重试。',
    TLS_ERROR: '和供应商建立安全连接失败（证书问题），多半是对方服务器的问题。',
    DNS_FAILED: '域名解析失败，请检查 Base URL 是否写对，或网络是否正常。',
    CONNECTION_REFUSED: '供应商拒绝了连接，请检查地址是否写对。',
    CONNECTION_RESET: '连接中途断开了，稍后重试。',
    NETWORK_UNREACHABLE: '网络不可达，请检查网络。',
    NETWORK_ERROR: '网络出错了，请稍后重试。',
  },
  // 状态栏
  barTitle: '余额',
  barNone: '余额 未添加',
  barUnpinned: '余额 未选择',
  barNever: '余额 —',
  barStale: '↺', // U+21BA 逆时针开口圆箭头，纯文字符号（不是 emoji，不带 U+FE0F）
};

const coded = (message, code) => Object.assign(new Error(message), { code });
const byteLen = (s) => new TextEncoder().encode(s).length;

/* ---------- 金额（与 panel/balance.js 的 formatAmount 同一口径，测试对照两份实现） ---------- */
const CURRENCY_SYMBOL = { USD: '$', CNY: '¥' };
function roundTo2(abs) {
  if (abs < 1e-6) return 0;
  if (abs >= 1e15) return abs;
  const clean = Number(abs.toPrecision(15));
  return Number(`${Math.round(Number(`${clean}e2`))}e-2`);
}
function formatAmount(value, unit) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return '—';
  const u = typeof unit === 'string' ? unit.trim() : '';
  const currency = /^[A-Z]{3}$/.test(u);
  const abs = roundTo2(Math.abs(n));
  const body = new Intl.NumberFormat(BAL.locale, currency ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 2 }).format(abs);
  const sign = n < 0 && abs !== 0 ? '-' : '';
  if (currency) return CURRENCY_SYMBOL[u] ? `${sign}${CURRENCY_SYMBOL[u]}${body}` : `${sign}${body} ${u}`;
  return `${sign}${body}${u ? ` ${u}` : ''}`;
}

/* ---------- 数据口径（附录 D：剩余额度、页签栏自选、近期消耗历史点） ---------- */
function amountOf(it) {
  if (!it) return undefined;
  if (it.remaining !== undefined) return it.remaining;
  if (it.total !== undefined && it.used !== undefined) return it.total - it.used;
  return undefined;
}
const firstItem = (last) => (last && Array.isArray(last.items) ? last.items[0] : undefined);
const unitOf = (it) => (it && typeof it.unit === 'string' ? it.unit.trim() : '');
const readProviders = (cfg) => (cfg && Array.isArray(cfg.providers) ? cfg.providers.filter((p) => p && typeof p.id === 'string' && typeof p.script === 'string') : []);
function pinnedIds(list) {
  const explicit = list.some((p) => typeof p.pinned === 'boolean');
  return new Set(list.filter((p) => (explicit ? p.pinned === true : true)).map((p) => p.id));
}
const SPEND = { minGapMs: 5 * 60000, maxAgeMs: 6 * 3600000, maxPoints: 24 };
const validPoint = (x) => x && Number.isFinite(x.at) && typeof x.remaining === 'number' && Number.isFinite(x.remaining);
function recordPoint(entry, next) {
  const it = firstItem(next);
  const value = amountOf(it);
  if (!next || !next.ok || !Number.isFinite(next.at) || typeof value !== 'number' || !Number.isFinite(value)) return;
  const prev = firstItem(entry.last);
  let hist = Array.isArray(entry.history) ? entry.history.filter(validPoint) : [];
  if (prev && unitOf(prev) !== unitOf(it)) hist = [];
  const tail = hist[hist.length - 1];
  if (!tail || next.at - tail.at >= SPEND.minGapMs) hist.push({ at: next.at, remaining: value });
  entry.history = hist.filter((x) => next.at - x.at <= SPEND.maxAgeMs).slice(-SPEND.maxPoints);
  if (!entry.history.length) delete entry.history;
}
/** /kv 超限时先丢最旧的历史点（与 panel/balance.js 的 fitKv 同一算法）；丢完仍超限返回 null。 */
function fitKv(cfg) {
  let text = JSON.stringify(cfg);
  let over = byteLen(text) - BAL.kvBytes;
  const list = Array.isArray(cfg.providers) ? cfg.providers : [];
  while (over > 0) {
    let victim = null;
    for (const p of list) if (Array.isArray(p.history) && p.history.length && (!victim || p.history[0].at < victim.history[0].at)) victim = p;
    if (!victim) return null;
    const dropped = victim.history.shift();
    if (!victim.history.length) delete victim.history;
    over -= byteLen(JSON.stringify(dropped)) + 1;
    if (over <= 0) { text = JSON.stringify(cfg); over = byteLen(text) - BAL.kvBytes; }
  }
  return text;
}

/* ---------- /kv：电子脑与页面同源共用，整体覆盖写，本处串行 ---------- */
async function kvRead() {
  const res = await fetch('/kv');
  if (!res.ok) throw coded(`HTTP ${res.status}`, 'KV_READ');
  const text = res.status === 204 ? '' : await res.text();
  let data = {};
  if (text) { try { data = JSON.parse(text); } catch (err) { throw coded('读取 /kv 失败', 'KV_READ'); } }
  return data && typeof data === 'object' ? data : {};
}
let balKvChain = Promise.resolve();
/** 读 → 只改目标家的 last / history → 整体写回；其他字段与其他键原样保留。 */
function writeResults(results) {
  const task = async () => {
    const cfg = await kvRead();
    const list = readProviders(cfg);
    for (const [id, next] of results) {
      const target = list.find((x) => x.id === id);
      if (!target) continue; // 刷新途中被删掉了
      if (next.ok) {
        if (!(target.last && target.last.at >= next.at)) recordPoint(target, next);
        target.last = next;
      } else {
        const prev = target.last;
        const failed = { at: next.at, ok: false, error: next.error };
        if (prev && Array.isArray(prev.items)) failed.items = prev.items;
        const okAt = prev ? (prev.ok ? prev.at : prev.okAt) : undefined;
        if (Number.isFinite(okAt)) failed.okAt = okAt;
        target.last = failed;
      }
    }
    const text = fitKv(cfg);
    if (text === null) throw coded(BT.errKvFull, 'KV_FULL');
    const res = await fetch('/kv', { method: 'PUT', body: text });
    if (!res.ok) throw coded(`HTTP ${res.status}`, 'KV_WRITE');
    return cfg;
  };
  const run = balKvChain.then(task);
  balKvChain = run.catch(() => {});
  return run;
}

/* ---------- 单家查询 ---------- */
function summarize(text, max) {
  const flat = String(text || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
function pathOf(url) {
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    return path.length > 80 ? `${path.slice(0, 80)}…` : path;
  } catch (err) {
    return '';
  }
}
function isJson(text) {
  try { JSON.parse(text); return true; } catch (err) { return false; }
}
function peekMessage(text) {
  try {
    const obj = JSON.parse(text);
    const m = obj && (obj.message || (obj.error && (obj.error.message || obj.error)) || obj.msg);
    return typeof m === 'string' ? summarize(m, 120) : '';
  } catch (err) {
    return '';
  }
}
const looksHtml = (res) => /html/i.test(res.contentType || '') || /^\s*(<!doctype|<html|<head|<body)/i.test(res.text || '');
/** 把代发结果翻译成人话；一切正常（2xx 且是 JSON）返回 null。 */
function responseProblem(res, request) {
  const s = res.status;
  const path = pathOf(request.url);
  const said = peekMessage(res.text || '');
  if (res.ok) {
    if (res.truncated) return coded(BT.truncated, 'TRUNCATED');
    if (isJson(res.text || '')) return null;
    if (looksHtml(res)) return coded(BT.notJsonHtml(s, path), 'NOT_JSON');
    return coded(BT.notJson(s, summarize(res.text, 80)), 'NOT_JSON');
  }
  let text;
  if (s === 401 || s === 403) text = BT.httpAuth(s) + (said ? ` ${BT.providerSaid(said)}` : '');
  else if (s === 404) text = BT.httpNotFound(path);
  else if (s === 429) text = BT.httpRate;
  else if (s >= 500) text = BT.httpServer(s);
  else text = BT.httpOther(s, said || summarize(res.text, 120));
  return coded(text, 'HTTP');
}
function explain(err) {
  const code = err && err.code;
  const msg = err && err.message;
  if (BT.net[code]) return BT.net[code];
  if (code === 'TIMEOUT' || code === 'NO_BUS') return BT.bridgeTimeout;
  if (code === 'FETCH_FAILED') return `${msg || BT.unknown} ${BT.hintReenter}`;
  return msg || BT.unknown;
}
/** analyze/extract 的失败回执（{ ok:false, code, message }）与 Node 调用失败都变成带 code 的错误。 */
async function workerStep(method, params) {
  const r = await callWorker(method, params);
  if (!r || !r.ok) throw coded((r && r.message) || BT.unknown, (r && r.code) || 'ANALYZE');
  return r;
}
async function queryProvider(p) {
  const base = { script: p.script, baseUrl: p.baseUrl || '', userId: p.userId || '' };
  const a = await workerStep('balance/analyze', base);
  if (a.host !== p.host || a.slot !== p.slot) throw coded(BT.errTargetChanged, 'TARGET_CHANGED');
  const f = await balanceFetch({ request: a.request });
  const problem = responseProblem(f, a.request);
  if (problem) throw problem;
  const x = await workerStep('balance/extract', { ...base, responseText: f.text });
  return x.items;
}

/* ---------- 刷新（防重入） ---------- */
const balState = { cache: [], running: null, runningIds: null, pending: null, cacheLoaded: false };
let balSync = null;
function syncPost(msg) {
  try {
    if (!balSync && typeof BroadcastChannel === 'function') balSync = new BroadcastChannel(BAL.syncChannel);
    if (balSync) balSync.postMessage({ ...msg, source: 'brain', at: Date.now() });
  } catch (err) { /* 通道不可用时页面靠管子回执更新 */ }
}

async function runBatch(ids) {
  const cfg = await kvRead();
  const all = readProviders(cfg);
  balState.cache = all;
  balState.cacheLoaded = true;
  const targets = ids ? all.filter((p) => ids.includes(p.id)) : all;
  syncPost({ type: 'balance-refreshing', on: true, ids: targets.map((p) => p.id) });
  publishStatus();
  const results = new Map();
  let next = 0;
  const runner = async () => {
    while (next < targets.length) {
      const p = targets[next]; next += 1;
      try {
        results.set(p.id, { at: Date.now(), ok: true, items: await queryProvider(p) });
      } catch (err) {
        results.set(p.id, { at: Date.now(), ok: false, error: explain(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BAL.concurrency, targets.length) }, runner));
  let failed = 0;
  for (const r of results.values()) if (!r.ok) failed += 1;
  let writeError = null;
  if (results.size) {
    try {
      const saved = await writeResults(results);
      balState.cache = readProviders(saved);
    } catch (err) {
      writeError = { code: (err && err.code) || 'KV_WRITE', message: (err && err.message) || '保存失败' };
    }
  }
  return { ok: !writeError, ids: targets.map((p) => p.id), failed, at: Date.now(), ...(writeError ? { error: writeError } : {}) };
}

/**
 * 刷新全部（ids 为 null）或指定几家。同一时刻只有一批：在跑时，被当前批次覆盖的请求直接等它（joined），
 * 没覆盖的记进待补，当前批次结束后合并再跑一次。
 */
function refreshBalances(opts) {
  const ids = opts && Array.isArray(opts.ids) && opts.ids.length ? opts.ids : null;
  if (balState.running) {
    const covered = !balState.runningAll && ids && ids.every((id) => (balState.runningIds || []).includes(id));
    if (balState.runningAll || covered) return balState.running.then((r) => ({ ...r, joined: true }));
    if (!ids) balState.pending = 'all';
    else if (balState.pending !== 'all') balState.pending = Array.from(new Set([...(balState.pending || []), ...ids]));
    const waitFor = balState.running;
    return waitFor.then(() => (balState.running || refreshBalances({ ids: ids }))).then((r) => ({ ...r, joined: false }));
  }
  balState.runningAll = !ids;
  balState.runningIds = ids ? ids.slice() : null; // 同步记下：紧接着的重复请求要能看出已被覆盖
  balState.running = (async () => {
    try {
      return await runBatch(ids);
    } finally {
      balState.running = null;
      balState.runningIds = null;
      balState.runningAll = false;
      syncPost({ type: 'balance-refreshing', on: false, ids: [] });
      syncPost({ type: 'balance-updated' });
      const pending = balState.pending;
      balState.pending = null;
      if (pending) refreshBalances({ ids: pending === 'all' ? null : pending });
      publishStatus();
    }
  })();
  return balState.running.then((r) => ({ ...r, joined: false }));
}

/* ---------- 状态栏文字 ---------- */
/** 只看缓存，不发请求。口径见 SPEC 附录 F.4 与 H.1：只显示金额，异常时加「 ↺」（过期标记）；刷新中只靠 disabled 灰显。 */
function statusText(list, now) {
  let text;
  let stale = false;
  if (!list.length) text = BT.barNone;
  else {
    const on = pinnedIds(list);
    const shown = list.filter((p) => on.has(p.id));
    if (!shown.length) text = BT.barUnpinned;
    else {
      const amounts = [];
      for (const p of shown) {
        const last = p.last;
        const it = firstItem(last);
        if (!last || !it) continue; // 从未查询过：不计金额，也不算过期
        const okAt = last.ok ? last.at : last.okAt;
        if (last.ok === false || !Number.isFinite(okAt) || now - okAt > BAL.staleMs) stale = true;
        const value = amountOf(it);
        // 与页签栏芯片同一口径：失效 → 「失效」；有金额 → 金额；否则「有效」
        amounts.push(it.isValid === false ? '失效' : value !== undefined ? formatAmount(value, it.unit) : '有效');
      }
      if (!amounts.length) text = BT.barNever;
      else {
        text = amounts.slice(0, 2).join(' / ') + (amounts.length > 2 ? ` +${amounts.length - 2}` : '');
      }
    }
  }
  if (stale) text += ` ${BT.barStale}`;
  return text;
}

/**
 * 发布状态栏文字。文字不再随时间走字，只在内容或刷新状态变了才发（force：消费者刚出现，宿主那边没有旧值）。
 * 没人看时宿主的 updateContribution 不执行 build、不通信。
 */
let lastPublished = '';
function publishStatus(force) {
  const ui = typeof cindy !== 'undefined' && cindy.ui;
  if (!ui || typeof ui.updateContribution !== 'function') return null;
  const state = { title: statusText(balState.cache, Date.now()), disabled: Boolean(balState.running), visible: true };
  const key = JSON.stringify(state);
  if (!force && key === lastPublished) return null;
  if (typeof ui.hasConsumers === 'function' && !ui.hasConsumers(BAL.contribution)) { lastPublished = ''; return null; }
  lastPublished = key;
  try {
    return ui.updateContribution(BAL.contribution, () => state);
  } catch (err) {
    return null;
  }
}

/* ---------- 自动刷新（唯一的定时器，在电子脑里；面板不再自己定时） ----------
 * 计时起点＝各家 last.at 里最旧的那个（每家查完就写 last.at，所以整批刷新完成后它就是「这批完成的时刻」；
 * 只刷一家不动起点，免得别家一直不刷）。从 /kv 推出来，电子脑重启也不丢。
 * 条件：满 10 分钟（从未查过的家视为已到期）＋ 有人在看（状态栏有消费者，或面板刚报告可见）＋ 没有刷新在跑。 */
function refreshBase(list) {
  if (!list.length) return null;
  let oldest = Infinity;
  for (const p of list) {
    if (!p.last || !Number.isFinite(p.last.at)) return 0;
    oldest = Math.min(oldest, p.last.at);
  }
  return oldest;
}
const autoState = { checks: 0, runs: 0, last: null };
function watching() {
  const ui = typeof cindy !== 'undefined' && cindy.ui;
  return Boolean(ui && typeof ui.hasConsumers === 'function' && ui.hasConsumers(BAL.contribution));
}
/** seen=true：面板刚报告「我可见」，此刻算有人看。返回这次的判断，供测试与诊断。 */
function maybeAutoRefresh(seen) {
  autoState.checks += 1;
  let verdict;
  if (balState.running) verdict = 'busy';
  else if (!seen && !watching()) verdict = 'unwatched';
  else {
    const base = refreshBase(balState.cache);
    if (base === null) verdict = 'empty';
    else if (Date.now() - base < BAL.autoMs) verdict = 'fresh';
    else verdict = 'refresh';
  }
  autoState.last = verdict;
  if (verdict === 'refresh') {
    autoState.runs += 1;
    refreshBalances({}).catch(() => {});
  }
  return verdict;
}

/** 有人看状态栏时才读 /kv 再发布；consumers=true（状态栏刚出现）时顺带判断要不要补刷。 */
async function reloadStatus(opts) {
  const ui = typeof cindy !== 'undefined' && cindy.ui;
  if (ui && typeof ui.hasConsumers === 'function' && !ui.hasConsumers(BAL.contribution)) return null;
  try { balState.cache = readProviders(await kvRead()); balState.cacheLoaded = true; } catch (err) { /* 读不到就沿用上次 */ }
  publishStatus(true);
  return opts && opts.catchUp ? maybeAutoRefresh(false) : null;
}

/** 面板报告「我可见」（打开、切到前台）：读一次缓存，到期就补刷。 */
async function onPageSeen() {
  try { balState.cache = readProviders(await kvRead()); balState.cacheLoaded = true; } catch (err) { /* 沿用上次 */ }
  const verdict = maybeAutoRefresh(true);
  // 补刷了就等它做完再回执：页面据此重读 /kv（另有 balance-updated 广播，两者都到也无妨）
  if (verdict === 'refresh' && balState.running) await balState.running.catch(() => {});
  return { verdict };
}

/** 状态栏点击 → 工具 refresh_balance。 */
async function onRefreshTool() {
  const r = await refreshBalances({});
  return { ok: r.ok, joined: r.joined, failed: r.failed, text: statusText(balState.cache, Date.now()) };
}

const BRAIN_TEST = { get context() { return CONTEXT_TEST; }, refreshBase, maybeAutoRefresh, onPageSeen, autoState, BAL, refreshBalances, statusText, formatAmount, fitKv, recordPoint, writeResults, publishStatus, reloadStatus, onRefreshTool, state: balState };
/* END balance-refresh */

/* BEGIN context-status — 伙伴聊天状态栏的上下文占用（SPEC 附录 G） */
const CTX = {
  contribution: 'context',
  tool: 'refresh_context',
  settingKey: 'context_window',
  windowDefault: 1000000,
  windowMin: 1000,
  windowMax: 10000000,
};
const ctxState = { consumers: [], inflight: new Map() };

/** 统一设置里的窗口大小（/kv 同名键）；缺失或越界用默认值。 */
async function contextWindow() {
  try {
    const v = (await kvRead())[CTX.settingKey];
    return typeof v === 'number' && Number.isFinite(v) && v >= CTX.windowMin && v <= CTX.windowMax ? v : CTX.windowDefault;
  } catch (err) {
    return CTX.windowDefault;
  }
}

function contextText(tokens, windowSize) {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return '上下文 —';
  const pct = (tokens / windowSize) * 100;
  if (pct > 0 && pct < 1) return '上下文 <1%';
  return `上下文 ${Math.round(pct)}%`;
}

/** 宿主给的消费者里属于本按钮、带任务 id 的那些（同一任务多个窗口各算一个目标）。 */
function contextTargets(consumers) {
  const out = [];
  for (const c of Array.isArray(consumers) ? consumers : []) {
    if (!c || c.id !== CTX.contribution || typeof c.sessionId !== 'string' || !c.sessionId) continue;
    out.push(c.clientId ? { sessionId: c.sessionId, clientId: c.clientId } : { sessionId: c.sessionId });
  }
  return out;
}

/** 查一个任务并发布到它的按钮；同一任务在途时复用。不可见/查不到时 visible:false。 */
function refreshContextFor(target, windowSize) {
  const key = JSON.stringify([target.sessionId, target.clientId || null]);
  if (ctxState.inflight.has(key)) return ctxState.inflight.get(key);
  const run = (async () => {
    let state;
    try {
      const r = await callWorker('context/status', { sessionId: target.sessionId });
      state = r && r.visible ? { title: contextText(r.contextTokens, windowSize), disabled: false, visible: true } : { visible: false };
    } catch (err) {
      state = { visible: false }; // 查不到就不显示，不挂一个错误数字
    }
    const ui = typeof cindy !== 'undefined' && cindy.ui;
    if (ui && typeof ui.updateContribution === 'function') {
      try { await ui.updateContribution(CTX.contribution, () => state, target); } catch (err) { /* 控件已离开 */ }
    }
    return state;
  })().finally(() => ctxState.inflight.delete(key));
  ctxState.inflight.set(key, run);
  return run;
}

/** 刷新当前所有上下文按钮（挂载/切换任务时宿主给新列表；点击时宿主不告诉是哪个任务，所以全刷）。 */
async function refreshContexts(consumers) {
  if (consumers) ctxState.consumers = consumers;
  const targets = contextTargets(ctxState.consumers);
  if (!targets.length) return [];
  const windowSize = await contextWindow();
  const out = [];
  for (const t of targets) out.push({ sessionId: t.sessionId, ...(await refreshContextFor(t, windowSize)) }); // 逐个查，Node 工作进程一次一个
  return out;
}

const CONTEXT_TEST = { contextText, contextTargets, contextWindow, refreshContexts, state: ctxState };
/* END context-status */

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
    return balanceFetch(payload);
  },

  /** 面板可见了：到期（满 10 分钟）就补刷一次（SPEC 附录 H）。 */
  async 'balance/seen'() {
    return onPageSeen();
  },

  /** 刷新余额（全部或指定几家）：唯一的查询实现，见 refreshBalances 与 SPEC 附录 F。 */
  async 'balance/refresh'(payload) {
    const ids = Array.isArray(payload && payload.ids) ? payload.ids.filter((x) => typeof x === 'string').slice(0, 32) : null;
    return refreshBalances({ ids: ids && ids.length ? ids : null });
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

/* ---------- 宿主消息：状态栏工具、原生控件需求；启动时发布一次；有人看时每分钟检查自动刷新 ---------- */
if (typeof cindy.onHostMessage === 'function') {
  cindy.onHostMessage((msg) => {
    if (!msg) return;
    if (msg.type === 'ui-consumers') { reloadStatus({ catchUp: true }); refreshContexts(msg.consumers).catch(() => {}); return; }
    if (msg.type !== 'tool-call') return;
    if (msg.tool === CTX.tool) {
      refreshContexts().then(
        (items) => cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: { ok: true, items: items.map((x) => ({ visible: x.visible !== false, text: x.title || '' })) } }),
        (err) => cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, message: `刷新上下文占用失败：${(err && err.message) || '未知原因'}。请稍后再点一次。` }),
      );
      return;
    }
    if (msg.tool !== BAL.tool) return;
    onRefreshTool().then(
      (result) => cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result }),
      (err) => cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, message: `刷新余额失败：${(err && err.message) || '未知原因'}。请稍后再点一次，或打开「轨迹与余额」面板查看。` }),
    );
  });
}
try {
  const sync = typeof BroadcastChannel === 'function' ? new BroadcastChannel(BAL.syncChannel) : null;
  if (sync) {
    balSync = sync;
    // 页面改了数据（勾选页签栏、增删改、页面发起的刷新结束）：有人看状态栏时重读缓存再发布
    sync.onmessage = (event) => { const m = event && event.data; if (m && m.type === 'balance-updated' && m.source !== 'brain') reloadStatus(); };
  }
} catch (err) { /* 没有通道就只在刷新后发布 */ }
// 握手：宿主在 ping 回执里带回已存在的原生控件消费者（电子脑晚于控件启动时靠它补上）
Promise.resolve(typeof cindy.ping === 'function' ? cindy.ping() : null).catch(() => null).then((res) => {
  reloadStatus({ catchUp: true });
  if (res && Array.isArray(res.nativeUiConsumers)) refreshContexts(res.nativeUiConsumers).catch(() => {});
});
// 每分钟一次：有人看状态栏时，到期就自动刷新；文字有变化（如超过 60 分钟加上「↺」）才重新发布。没人看什么也不做。
(function balanceTick() {
  if (watching()) {
    if (!balState.running) publishStatus();
    maybeAutoRefresh(false);
  }
  setTimeout(balanceTick, BAL.tickMs);
})();
