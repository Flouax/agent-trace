/**
 * balance.js — 余额页签：粘贴 CC Switch 用量查询脚本，点刷新查各供应商余额（契约见 SPEC.md 第 8 节）。
 *
 * 数据流：条目存 /kv（只存脚本与结果，不含密钥）；密钥一次性 POST 给宿主保险库（/connections），读不回；
 * 查询 = 管子操作 balance/refresh，由 main.js 的 refreshBalances 执行 analyze → fetch（宿主代发并注入密钥）→ extract → 写 /kv（SPEC 附录 F）。
 * 触发：点击刷新、状态栏的余额按钮（不经过页面），或电子脑的 10 分钟自动刷新（SPEC 附录 H；页面只报告「我可见」）。页面里没有任何地方保存密钥：输入框一取值就清空。
 * 每家另存两个可选字段：pinned（是否显示在页签栏）与 history（近期消耗用的余额点），口径见 SPEC 附录 D。
 */
(function () {
  'use strict';

  const CHIP_STALE_MS = 60 * 60 * 1000; // 页签栏芯片：错过两个周期仍没更新才变暗
  const SYNC_CHANNEL = 'agent-trace-balance-v1';
  const EVENT_UPDATED = 'agent-trace:balance-updated';
  const EVENT_REFRESHING = 'agent-trace:balance-refreshing';
  const PAGE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  /* ---------- 文案（集中放这里，以后好做本地化） ---------- */
  const T = {
    title: '余额',
    count: (n, pinned) => `共 ${n} 家，${pinned ? `页签栏显示 ${pinned === n ? '全部' : `${pinned} 家`}` : '页签栏不显示'}`,
    refreshAll: '刷新全部',
    refreshing: '刷新中…',
    add: '添加供应商',
    refresh: '刷新',
    refreshBusy: '正在查询',
    edit: '编辑',
    remove: '删除',
    removeAsk: '删除这个供应商？',
    removeConfirm: '确认删除',
    cancel: '取消',
    more: '更多操作',
    pin: '显示在页签栏',
    pinOn: '已显示在页签栏，点一下取消',
    pinOff: '没有显示在页签栏，点一下显示',
    pinFailed: '保存页签栏设置失败：',
    emptyTitle: '还没有添加供应商',
    emptyBody: '点「添加供应商」，粘贴 CC Switch 的用量查询脚本，或直接选一个内置预设。',
    loadFailed: '读取已保存的供应商失败：',
    retry: '重试',
    connUnavailable: '当前环境无法在面板里保存密钥，添加和编辑请到「插件详情 → 设置」里操作。已添加的供应商仍可查询。',
    badgeBad: '失效',
    used: '已用',
    total: '总额',
    dash: '—',
    chipValid: '有效',
    chipInvalid: '失效',
    chipNever: '尚未查询',
    chipUpdated: (when) => `更新于 ${when}`,
    chipFailed: (reason) => `上次查询失败：${reason}`,
    chipAmount: (amount) => `余额 ${amount}`,
    spend: (win, amount) => `近 ${win}消耗 ${amount}`,
    spanMinutes: (n) => `${n} 分钟`,
    spanHours: (n) => `${n} 小时`,
    plans: (n) => `${n} 个套餐`,
    keyTail: (tail) => (tail ? `密钥尾号 ${tail}` : '密钥已保存'),
    keyMissing: '密钥不存在，请在「更多」里编辑后重新输入',
    updated: (when) => `更新于 ${when}`,
    neverUpdated: '尚未查询',
    lastGood: '金额是上次成功查询的结果',
    justNow: '刚刚',
    minutesAgo: (n) => `${n} 分钟前`,
    hoursAgo: (n) => `${n} 小时前`,
    daysAgo: (n) => `${n} 天前`,
    removeFailed: '删除失败：',
    removed: '已删除',
    // 表单
    formAddTitle: '添加供应商',
    formEditTitle: '编辑供应商',
    presets: '预设',
    presetList: [['generic', '通用', '/user/balance'], ['newapi', 'New API', '/api/user/self'], ['sub2api', 'Sub2API', '/v1/usage']],
    presetHelp: '如果你已有 CC Switch 的脚本，直接粘贴到文本框即可，不用点预设。',
    scriptLabel: '查询脚本',
    scriptPlaceholder: '粘贴 CC Switch 的用量查询脚本，形如 ({ request: {...}, extractor: function(response) {...} })',
    scriptCounter: (n, max) => `${n} / ${max} 字节`,
    baseUrlLabel: 'Base URL',
    baseUrlPlaceholder: 'https://api.example.com',
    userIdLabel: 'User ID',
    userIdPlaceholder: '脚本需要的用户 ID',
    keyLabel: '密钥（API Key 或访问令牌）',
    keyPlaceholder: '粘贴后点「添加」，不会回显',
    keyPlaceholderKeep: (tail) => `留空则沿用已保存的密钥${tail ? `（尾号 ${tail}）` : ''}`,
    keyHelp: '只保存在 Cindy 的系统保险库里，插件和这个界面都读不回；界面只显示尾 4 位。',
    nameLabel: '名称（可空）',
    namePlaceholder: '默认用域名',
    parse: '解析',
    parsing: '解析中…',
    save: '添加',
    saveEdit: '保存',
    saving: '处理中…',
    parseFirst: '先点「解析」确认脚本要请求什么，再添加。',
    risk: '这是一段会被执行的 JavaScript，请确认来源可信。',
    previewRequest: '请求',
    previewKey: '密钥',
    previewKeyBearer: '▸ Authorization: Bearer ●●●●',
    previewKeyApi: '▸ x-api-key: ●●●●',
    previewHeaders: '其他请求头',
    previewSlot: (host) => `密钥将存入系统保险库，只在访问 ${host} 时由 Cindy 自动带上。`,
    connExisting: (tail) => `这个域名已保存过密钥${tail ? `（尾号 ${tail}）` : ''}，密钥框留空即沿用。`,
    needKey: '请填写密钥。',
    sharedHint: (names) => `同一域名下的「${names}」共用这个密钥。`,
    // 校验与错误
    errScriptRequired: '请先粘贴或选择一段查询脚本。',
    errScriptTooLarge: (max) => `脚本太长了（上限 ${max} 字节），请精简后再试。`,
    errProvidersFull: (n) => `最多只能添加 ${n} 家供应商，请先删除不用的。`,
    errKvFull: '已保存的数据快到存储上限（64KB）了，请先删除不用的供应商，或精简脚本。',
    errSlotFull: (n) => `这种密钥位置最多保存 ${n} 个域名，已满。请先删除不用的供应商。`,
    errTokenConflict: '同一个域名下不同密钥的供应商无法并存。如果是同一个密钥，请把密钥框留空，直接共用；要换密钥，请先删除另一家。',
    errCrossSlot: (names) => `这个域名已经在「${names}」里用另一种密钥位置保存了，同一域名只能用一种位置。`,
    errConfirmDenied: '你在确认框里拒绝了新增这个连接域名，所以没有添加。',
    errVault: '系统保险库写入失败，请稍后重试。',
    errConnGeneric: (code) => `保存密钥失败（${code}）。`,
    errKvWrite: '保存供应商信息失败：',
    errKeyRetype: '密钥已清空，请重新输入后再试。',
    errTargetChanged: '脚本现在指向的域名或密钥位置和已保存的不一致，请点「编辑」确认后重新输入密钥。',
    added: '已添加',
    saved: '已保存',
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
    net: {
      NETWORK_TIMEOUT: '请求超时了，供应商那边响应太慢或网络不通。稍后重试。',
      TLS_ERROR: '和供应商建立安全连接失败（证书问题），多半是对方服务器的问题。',
      DNS_FAILED: '域名解析失败，请检查 Base URL 是否写对，或网络是否正常。',
      CONNECTION_REFUSED: '供应商拒绝了连接，请检查地址是否写对。',
      CONNECTION_RESET: '连接中途断开了，稍后重试。',
      NETWORK_UNREACHABLE: '网络不可达，请检查网络。',
      NETWORK_ERROR: '网络出错了，请稍后重试。',
    },
  };

  const LIMITS = { providers: 16, scriptBytes: 6144, kvBytes: 64 * 1024, concurrency: 3, perSlot: 8 };

  /* ---------- 预设脚本（按 CC Switch 的格式与语义自己写的等价实现） ---------- */
  const PRESETS = {
    generic: [
      '({',
      '  request: {',
      '    url: "{{baseUrl}}".replace(/\\/+$/, "") + "/user/balance",',
      '    method: "GET",',
      '    headers: { "Authorization": "Bearer {{apiKey}}", "Accept": "application/json" }',
      '  },',
      '  extractor: function (response) {',
      '    var data = (response && response.data) || response || {};',
      '    var remaining = data.balance;',
      '    if (remaining === undefined) remaining = data.remaining;',
      '    return {',
      '      isValid: data.is_active !== false && data.isValid !== false,',
      '      remaining: remaining,',
      '      unit: data.unit || data.currency || "USD"',
      '    };',
      '  }',
      '})',
    ].join('\n'),
    newapi: [
      '({',
      '  request: {',
      '    url: "{{baseUrl}}".replace(/\\/+$/, "") + "/api/user/self",',
      '    method: "GET",',
      '    headers: {',
      '      "Authorization": "Bearer {{accessToken}}",',
      '      "New-Api-User": "{{userId}}",',
      '      "Content-Type": "application/json"',
      '    }',
      '  },',
      '  extractor: function (response) {',
      '    var d = response && response.data;',
      '    if (!response || response.success === false || !d) {',
      '      return { isValid: false, invalidMessage: (response && response.message) || "查询失败" };',
      '    }',
      '    var perUnit = 500000; // New API 默认 50 万额度折合 1 美元',
      '    var quota = Number(d.quota) || 0;',
      '    var used = Number(d.used_quota) || 0;',
      '    return {',
      '      planName: d.group || "默认分组",',
      '      remaining: quota / perUnit,',
      '      used: used / perUnit,',
      '      total: (quota + used) / perUnit,',
      '      unit: "USD"',
      '    };',
      '  }',
      '})',
    ].join('\n'),
    sub2api: [
      '({',
      '  request: {',
      '    url: "{{baseUrl}}".replace(/\\/+$/, "").replace(/\\/v1$/, "") + "/v1/usage",',
      '    method: "GET",',
      '    headers: { "Authorization": "Bearer {{apiKey}}", "Accept": "application/json" }',
      '  },',
      '  extractor: function (response) {',
      '    var r = response || {};',
      '    var quota = r.quota || {};',
      '    var out = { isValid: r.isValid !== false, unit: r.unit || quota.unit || "USD" };',
      '    if (typeof r.planName === "string") out.planName = r.planName;',
      '    if (typeof r.remaining === "number" && r.remaining >= 0) out.remaining = r.remaining;',
      '    if (quota.limit > 0) { out.used = quota.used; out.total = quota.limit; }',
      '    if (!out.isValid) out.invalidMessage = r.status ? String(r.status) : "查询失败";',
      '    return out;',
      '  }',
      '})',
    ].join('\n'),
  };

  /* ---------- 小工具 ---------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const byteLen = (s) => new TextEncoder().encode(s).length;
  const coded = (message, code) => Object.assign(new Error(message), { code });
  const PH = /\{\{\s*(\w+)\s*\}\}/g;

  /** 脚本里用了哪些占位符，用来决定显示哪些输入框（真正的校验仍在 balance/analyze）。 */
  function scan(script) {
    const out = { baseUrl: false, userId: false };
    for (const m of String(script).matchAll(PH)) {
      const k = m[1].toLowerCase();
      if (k === 'baseurl') out.baseUrl = true;
      else if (k === 'userid') out.userId = true;
    }
    return out;
  }

  const CURRENCY_SYMBOL = { USD: '$', CNY: '¥' };

  /** 四舍五入到两位小数（半数进位）。先用 15 位有效数字抹掉 0.1+0.2 这类浮点尾巴，再按十进制移位取整，所以 1.005 得 1.01。 */
  function roundTo2(abs) {
    if (abs < 1e-6) return 0;
    if (abs >= 1e15) return abs;
    const clean = Number(abs.toPrecision(15));
    return Number(`${Math.round(Number(`${clean}e2`))}e-2`);
  }

  /**
   * 金额统一格式（卡片与页签栏芯片共用）：三位大写字母的货币码固定两位小数（USD → $、CNY → ¥，其余「77.88 EUR」），
   * 其他单位最多两位小数并去掉多余的 0；都带千分位。
   */
  function formatAmount(value, unit) {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(n)) return T.dash;
    const u = typeof unit === 'string' ? unit.trim() : '';
    const currency = /^[A-Z]{3}$/.test(u);
    const abs = roundTo2(Math.abs(n));
    const body = new Intl.NumberFormat(state.locale, currency ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 2 }).format(abs);
    const sign = n < 0 && abs !== 0 ? '-' : '';
    if (currency) return CURRENCY_SYMBOL[u] ? `${sign}${CURRENCY_SYMBOL[u]}${body}` : `${sign}${body} ${u}`;
    return `${sign}${body}${u ? ` ${u}` : ''}`;
  }

  function ago(at) {
    const diff = Math.max(0, Date.now() - at);
    const min = Math.floor(diff / 60000);
    if (min < 1) return T.justNow;
    if (min < 60) return T.minutesAgo(min);
    if (min < 1440) return T.hoursAgo(Math.floor(min / 60));
    return T.daysAgo(Math.floor(min / 1440));
  }

  /** 一项结果的剩余额度：优先 remaining，没有就用 total − used（与页签栏芯片同一口径）。 */
  function amountOf(it) {
    if (!it) return undefined;
    if (it.remaining !== undefined) return it.remaining;
    if (it.total !== undefined && it.used !== undefined) return it.total - it.used;
    return undefined;
  }
  const firstItem = (last) => (last && Array.isArray(last.items) ? last.items[0] : undefined);
  const unitOf = (it) => (it && typeof it.unit === 'string' ? it.unit.trim() : '');

  /* ---------- 页签栏自选（pinned） ----------
   * 旧数据里没有任何一家带 pinned：视为全部显示。第一次切换任一开关时把所有家的生效值写成显式布尔，
   * 之后只认显式值（显式状态下缺字段的按 false）。新加的一家：已有显式值时默认 false；否则不写字段（＝显示）。 */
  const hasExplicitPins = (list) => list.some((p) => typeof p.pinned === 'boolean');
  function pinnedIds(list) {
    const explicit = hasExplicitPins(list);
    return new Set(list.filter((p) => (explicit ? p.pinned === true : true)).map((p) => p.id));
  }
  function applyPin(list, id, value) {
    const on = pinnedIds(list);
    for (const p of list) p.pinned = on.has(p.id);
    const target = list.find((p) => p.id === id);
    if (target) target.pinned = Boolean(value);
    return list;
  }
  const defaultPin = (list) => (hasExplicitPins(list) ? false : undefined);

  /* ---------- 近期消耗（history） ----------
   * 每家只记第一项的剩余额度与时间。「现在」取最近一次成功查询的时间（金额就是那一刻的），
   * 基准点取比它早至少 15 分钟、且不早于 6 小时的最新一点。历史点由电子脑在每次成功查询后追加（main.js 的 recordPoint，单位变了清空）。 */
  const SPEND = { minGapMs: 5 * 60000, minAgeMs: 15 * 60000, maxAgeMs: 6 * 3600000, maxPoints: 24 };
  const validPoint = (x) => x && Number.isFinite(x.at) && typeof x.remaining === 'number' && Number.isFinite(x.remaining);

  /** 近期消耗；不该显示时返回 null（没有基准点、上次失败、充值导致余额增加、没有数值）。 */
  function recentSpend(p) {
    const last = p && p.last;
    if (!last || !last.ok || !Number.isFinite(last.at)) return null;
    const it = firstItem(last);
    const cur = amountOf(it);
    if (typeof cur !== 'number' || !Number.isFinite(cur)) return null;
    let base = null;
    for (const x of Array.isArray(p.history) ? p.history : []) {
      if (!validPoint(x)) continue;
      const age = last.at - x.at;
      if (age >= SPEND.minAgeMs && age <= SPEND.maxAgeMs && (!base || x.at > base.at)) base = x;
    }
    if (!base) return null;
    const amount = base.remaining - cur;
    if (!(amount >= 0)) return null;
    return { amount, unit: it.unit, ms: last.at - base.at };
  }

  function spanText(ms) {
    const min = Math.round(ms / 60000);
    if (min < 60) return T.spanMinutes(min);
    return T.spanHours(Math.round(min / 6) / 10);
  }
  const spendText = (s) => (s ? T.spend(spanText(s.ms), formatAmount(s.amount, s.unit)) : '');

  /**
   * /kv 体积超限时先丢历史点（全局最旧的先丢），丢完仍超限返回 null。
   * 粗算：一点约 45 字节，16 家 × 24 点 ≈ 17KB；真正撑满 64KB 的通常是脚本（每家 ≤6KB）。
   */
  function fitKv(cfg) {
    let text = JSON.stringify(cfg);
    let over = byteLen(text) - LIMITS.kvBytes;
    const list = Array.isArray(cfg.providers) ? cfg.providers : [];
    while (over > 0) {
      let victim = null;
      for (const p of list) if (Array.isArray(p.history) && p.history.length && (!victim || p.history[0].at < victim.history[0].at)) victim = p;
      if (!victim) return null;
      const dropped = victim.history.shift();
      if (!victim.history.length) delete victim.history;
      over -= byteLen(JSON.stringify(dropped)) + 1;
      if (over <= 0) { text = JSON.stringify(cfg); over = byteLen(text) - LIMITS.kvBytes; }
    }
    return text;
  }

  /* ---------- 状态 ---------- */
  const state = {
    locale: 'zh-CN',
    providers: [],
    conns: [],
    connOk: null,
    loaded: false,
    loadError: '',
    busy: new Set(),
    batch: false,
    expanded: new Set(),
    confirmDelete: null,
    moreOpen: null,
    form: null,
  };
  let ctx = null;
  let els = {};
  // 没有界面（还没 mount）时也要能查询：桥与提示都做成可缺省
  const bridge = () => (ctx && ctx.bridge) || window.AgentTrace.bridge;
  const toast = (message) => { if (ctx && ctx.toast) ctx.toast(message); };
  let tick = 0;
  let kvChain = Promise.resolve();

  /* ---------- 存取：/kv 与 /connections ---------- */
  async function req(path, init) {
    const res = await window.fetch(path, init);
    let data = null;
    if (res.status !== 204) {
      const text = await res.text();
      if (text) { try { data = JSON.parse(text); } catch (err) { /* 非 JSON 当没有内容 */ } }
    }
    return { status: res.status, ok: res.ok, data };
  }

  async function kvRead() {
    const res = await req('/kv');
    if (!res.ok || !res.data || typeof res.data !== 'object') throw coded(`HTTP ${res.status}`, 'KV_READ');
    return res.data;
  }

  const readProviders = (cfg) => (Array.isArray(cfg.providers) ? cfg.providers.filter((p) => p && typeof p.id === 'string' && typeof p.script === 'string') : []);

  /** 用 /kv 里读到的列表更新内存：同 id 的对象原地更新（在途查询手里还拿着它），在途的那条保持不动。 */
  function adopt(list) {
    const byId = new Map(state.providers.map((p) => [p.id, p]));
    state.providers = list.map((fresh) => {
      const cur = byId.get(fresh.id);
      if (!cur) return fresh;
      if (state.busy.has(cur.id)) return cur;
      for (const key of Object.keys(cur)) delete cur[key];
      return Object.assign(cur, fresh);
    });
  }

  /**
   * /kv 是整体覆盖写，且与轨迹页签、别的页面共用：串行地「读 → 对最新的 providers 应用改动 → 整体写回」，
   * 只动 providers 这一个键。apply 收到的是刚读到的列表（不是内存里可能已过期的那份）。
   */
  function persist(apply) {
    const task = async () => {
      const cfg = await kvRead();
      const fresh = readProviders(cfg);
      const next = apply ? apply(fresh) : fresh;
      cfg.providers = next.map(stripProvider);
      const text = fitKv(cfg);
      if (text === null) throw coded(T.errKvFull, 'KV_FULL');
      const res = await req('/kv', { method: 'PUT', body: text });
      if (!res.ok) throw coded(`HTTP ${res.status}`, 'KV_WRITE');
      adopt(cfg.providers); // 写进去的那份（历史点可能为体积被裁过）
      state.loaded = true;
    };
    const run = kvChain.then(task);
    kvChain = run.catch(() => {});
    return run;
  }

  function stripProvider(p) {
    const out = { id: p.id, name: p.name, baseUrl: p.baseUrl, script: p.script, slot: p.slot, host: p.host, connectionId: p.connectionId, createdAt: p.createdAt };
    if (p.userId) out.userId = p.userId;
    if (typeof p.pinned === 'boolean') out.pinned = p.pinned;
    if (p.last) out.last = p.last;
    if (Array.isArray(p.history) && p.history.length) out.history = p.history.filter(validPoint).map((x) => ({ at: x.at, remaining: x.remaining }));
    return out;
  }

  async function loadConns() {
    try {
      const res = await req('/connections');
      if (res.ok && Array.isArray(res.data)) { state.conns = res.data; state.connOk = true; }
      else state.connOk = false;
    } catch (err) {
      state.connOk = false;
    }
  }

  function findConn(slot, host) {
    const decl = state.conns.find((c) => c.key === slot);
    return decl ? (decl.connections || []).find((c) => c.host === host) || null : null;
  }
  const connById = (slot, id) => {
    const decl = state.conns.find((c) => c.key === slot);
    return decl ? (decl.connections || []).find((c) => c.id === id) || null : null;
  };

  async function loadProviders() {
    adopt(readProviders(await kvRead()));
    state.loaded = true;
  }

  async function loadAll() {
    state.loadError = '';
    try {
      await loadProviders();
    } catch (err) {
      state.loadError = (err && err.message) || '';
    }
    await loadConns();
    renderAll();
  }

  /* ---------- 查询 ---------- */
  function explain(err) {
    const code = err && err.code;
    const msg = err && err.message;
    if (T.net[code]) return T.net[code];
    if (code === 'TIMEOUT' || code === 'NO_BUS') return T.bridgeTimeout;
    if (code === 'FETCH_FAILED') return `${msg || T.unknown} ${T.hintReenter}`;
    return msg || T.unknown;
  }

  function analysisError(a) {
    return coded(a.message || T.unknown, a.code || 'ANALYZE');
  }

  /* ---------- 查询：全部交给电子脑的 refreshBalances（SPEC 附录 F）----------
   * 页面不再自己 analyze/fetch/extract：只发 balance/refresh，等回执期间把这几家标成「查询中」，回执后重读 /kv。
   * 状态栏点击或别的页面发起的刷新，由电子脑在同步通道上广播 balance-refreshing，这里同样显示转圈。 */
  const REFRESH_TIMEOUT_MS = 120000;
  const remote = new Set();

  async function requestRefresh(ids) {
    try {
      const r = await bridge().call('balance/refresh', ids ? { ids } : {}, { timeoutMs: REFRESH_TIMEOUT_MS });
      if (r && r.ok === false && r.error) toast(T.errKvWrite + (r.error.message || ''));
      return r;
    } catch (err) {
      toast(explain(err));
      return null;
    }
  }

  async function refreshOne(p) {
    // 同一时刻只允许一批刷新：整批进行中时，单卡刷新不另起请求（电子脑那边也会合并）
    if (state.busy.has(p.id) || batchPromise) return;
    state.busy.add(p.id);
    renderList();
    try {
      await requestRefresh([p.id]);
    } finally {
      state.busy.delete(p.id);
    }
    await loadProviders().catch(() => {});
    renderList();
    notifyUpdated();
  }

  /* ---------- 通知：同页用 window 事件，别的页面（设置页等）用 BroadcastChannel ---------- */
  let syncChannel = null;

  function notifyUpdated() {
    try { window.dispatchEvent(new CustomEvent(EVENT_UPDATED, { detail: { source: PAGE_ID } })); } catch (err) { /* 没有 CustomEvent 就算了 */ }
    try { if (syncChannel) syncChannel.postMessage({ type: 'balance-updated', source: PAGE_ID, at: Date.now() }); } catch (err) { /* 通道已关闭 */ }
  }

  function emitRefreshing(on) {
    try { window.dispatchEvent(new CustomEvent(EVENT_REFRESHING, { detail: { refreshing: on, source: PAGE_ID } })); } catch (err) { /* 同上 */ }
  }

  function startSync() {
    if (syncChannel || typeof BroadcastChannel !== 'function') return;
    syncChannel = new BroadcastChannel(SYNC_CHANNEL);
    syncChannel.onmessage = (event) => {
      const m = event && event.data;
      if (!m || m.source === PAGE_ID) return;
      if (m.type === 'balance-refreshing' && m.source === 'brain') {
        // 别处发起的刷新（状态栏点击、别的页面）：本页自己已标为查询中的不重复记
        if (m.on) for (const id of Array.isArray(m.ids) ? m.ids : []) { if (!state.busy.has(id)) { state.busy.add(id); remote.add(id); } }
        else { for (const id of remote) state.busy.delete(id); remote.clear(); }
        emitRefreshing(Boolean(batchPromise) || remote.size > 0);
        if (ctx) { renderHeader(); renderList(); }
        return;
      }
      if (m.type !== 'balance-updated') return;
      // 别的页面改了数据：没有在途操作时重读；有的话等下一次显示时再读
      if (state.loaded && !state.batch && !state.busy.size && !state.form) loadAll();
    };
  }

  /* ---------- 刷新全部（不依赖界面；同一时刻只跑一批，由电子脑执行，并发上限 3） ---------- */
  let batchPromise = null;

  function refreshAll() {
    if (batchPromise) return batchPromise;
    batchPromise = (async () => {
      state.batch = true;
      emitRefreshing(true);
      renderHeader();
      renderList();
      const mine = [];
      try {
        await loadProviders().catch(() => {});
        for (const p of state.providers) if (!state.busy.has(p.id)) { state.busy.add(p.id); mine.push(p.id); }
        renderHeader();
        renderList();
        await requestRefresh(null);
      } finally {
        for (const id of mine) state.busy.delete(id);
        await loadProviders().catch(() => {});
        state.batch = false;
        batchPromise = null;
        renderHeader();
        renderList();
        emitRefreshing(false);
        notifyUpdated();
      }
    })();
    return batchPromise;
  }

  /** 页签栏芯片需要的数据：直接读 /kv 里上次查询的缓存，不依赖界面是否已 mount。 */
  function chipFor(p, now) {
    const last = p.last;
    const first = firstItem(last);
    const remaining = amountOf(first);
    const invalid = Boolean(first && first.isValid === false);
    const amount = remaining !== undefined ? formatAmount(remaining, first.unit) : '';
    let text = T.dash;
    if (first) text = invalid ? T.chipInvalid : amount || T.chipValid;
    return {
      id: p.id,
      name: p.name || p.host,
      text,
      amount,
      invalid,
      failed: Boolean(last && last.ok === false),
      stale: Boolean(last && now - last.at > CHIP_STALE_MS),
      never: !last,
      at: last ? last.at : null,
      error: last && last.ok === false ? last.error || '' : '',
      spend: spendText(recentSpend(p)),
    };
  }

  /** 悬停提示：名称、金额与单位、近期消耗、更新于多久前、失败原因。每次悬停时现算，「多久前」才不会过期。 */
  function chipTitle(chip) {
    const lines = [chip.name];
    if (chip.amount) lines.push(T.chipAmount(chip.amount));
    else if (chip.text !== T.dash) lines.push(chip.text);
    if (chip.spend) lines.push(chip.spend);
    lines.push(chip.at ? T.chipUpdated(ago(chip.at)) : T.chipNever);
    if (chip.invalid) lines.push(T.badgeBad);
    if (chip.failed) lines.push(T.chipFailed(chip.error || T.unknown));
    return lines.join('\n');
  }

  /** chips 只含勾选了「显示在页签栏」的；total 是全部家数。 */
  async function summary() {
    try {
      const list = readProviders(await kvRead());
      const now = Date.now();
      const on = pinnedIds(list);
      return { total: list.length, refreshing: state.batch || remote.size > 0, chips: list.filter((p) => on.has(p.id)).map((p) => chipFor(p, now)) };
    } catch (err) {
      return { total: 0, refreshing: state.batch, chips: [], error: (err && err.message) || '' };
    }
  }

  /**
   * 自动刷新不在页面里（0.3.1 起）：电子脑里只有一个定时器，每 10 分钟、有人在看时刷新（SPEC 附录 H）。
   * 页面只在自己变得可见时报告一声，电子脑据此判断要不要补刷（满 10 分钟才刷，不会因为切页签多查）。
   */
  async function seen() {
    try {
      const r = await bridge().call('balance/seen', {}, { timeoutMs: REFRESH_TIMEOUT_MS });
      if (r && r.verdict === 'refresh') {
        await loadProviders().catch(() => {});
        if (ctx) renderAll();
        notifyUpdated();
      }
      return r;
    } catch (err) {
      return null; // 只是一次提醒，失败了等下一次可见或电子脑自己的定时
    }
  }

  /* ---------- 删除 ---------- */
  async function removeProvider(p) {
    state.confirmDelete = null;
    const stillUsed = state.providers.some((x) => x.id !== p.id && x.slot === p.slot && x.host === p.host);
    try {
      if (!stillUsed && p.connectionId) {
        const res = await req(`/connections/${encodeURIComponent(p.slot)}/${encodeURIComponent(p.connectionId)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 404) throw coded(`HTTP ${res.status}`, 'CONN_DELETE');
      }
      await persist((list) => list.filter((x) => x.id !== p.id));
      await loadConns();
      toast(T.removed);
    } catch (err) {
      toast(T.removeFailed + ((err && err.message) || ''));
    }
    renderAll();
  }

  /* ---------- 页签栏开关 ---------- */
  async function setPinned(p, value) {
    // 先改内存里的再写 /kv：界面立刻跟手；写失败就重读回真实状态
    applyPin(state.providers, p.id, value);
    renderAll();
    try {
      await persist((list) => applyPin(list, p.id, value));
    } catch (err) {
      toast(T.pinFailed + ((err && err.message) || ''));
      await loadProviders().catch(() => {});
    }
    renderAll();
    notifyUpdated();
  }

  /* ---------- 渲染：头部 / 列表 ---------- */
  /** 像素图标来自共用的 icons.js；单独加载本文件（没有 icons.js）时不画图标，按钮仍有文字或无障碍标签。 */
  function icon(name) {
    const lib = window.AgentTraceIcons;
    return lib ? lib.make(name, 'bal-ico') : null;
  }

  function renderHeader() {
    if (!els.refreshAll) return;
    els.refreshAllLabel.textContent = state.batch ? T.refreshing : T.refreshAll;
    const n = state.providers.length;
    els.count.textContent = n ? T.count(n, pinnedIds(state.providers).size) : '';
    els.refreshAll.disabled = state.batch || !state.providers.length;
    els.addBtn.disabled = Boolean(state.form) || state.connOk === false;
    els.notice.hidden = state.connOk !== false;
  }

  /** 行的状态：idle 未查询 / loading / ok / invalid（对方说失效）/ error（这次查询失败）。 */
  function stateOf(p) {
    if (state.busy.has(p.id)) return 'loading';
    const last = p.last;
    if (!last) return 'idle';
    if (!last.ok) return 'error';
    return last.items && last.items.some((it) => it.isValid === false) ? 'invalid' : 'ok';
  }

  /** 已用 / 总额的细线；没有 total 就不画。 */
  function usage(it) {
    const used = it.used !== undefined ? it.used : it.total !== undefined && it.remaining !== undefined ? it.total - it.remaining : undefined;
    if (!(it.total > 0) || used === undefined) return [];
    const pct = Math.max(0, Math.min(100, (used / it.total) * 100));
    return [
      h('div', { class: 'bal-bar', role: 'progressbar', 'aria-label': T.used, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)) }, h('div', { class: 'bal-bar-fill', style: `width:${pct}%` })),
      h('div', { class: 'bal-bar-text', text: `${T.used} ${formatAmount(used, it.unit)} / ${T.total} ${formatAmount(it.total, it.unit)}` }),
    ];
  }

  /** 一项的补充说明：套餐名、extra、失效原因（金额本身在行右侧或套餐行里）。 */
  function itemNotes(it, withPlan) {
    const out = [];
    if (withPlan && it.planName) out.push(h('div', { class: 'bal-plan', text: it.planName }));
    if (it.extra) out.push(h('div', { class: 'bal-extra', text: it.extra }));
    if (it.isValid === false) out.push(h('div', { class: 'bal-invalid', text: it.invalidMessage || T.badgeBad }));
    return out;
  }

  function renderPlans(p, items, dim) {
    const open = state.expanded.has(p.id);
    const toggle = h('button', {
      class: 'bal-plans-toggle', type: 'button', 'aria-expanded': String(open), 'data-focus': `plans:${p.id}`,
      onclick: () => {
        if (open) state.expanded.delete(p.id);
        else { state.expanded.add(p.id); justOpened = p.id; }
        renderList();
      },
    }, icon('chevron'), T.plans(items.length));
    const out = [toggle];
    if (open) {
      const list = h('div', { class: `bal-plans${justOpened === p.id ? ' entering' : ''}${dim ? ' dim' : ''}` });
      for (const it of items) {
        const remaining = amountOf(it);
        list.append(h('div', { class: 'bal-plan-row' },
          h('div', { class: 'bal-plan-head' },
            h('span', { class: 'bal-plan-name', text: it.planName || T.dash }),
            h('span', { class: 'bal-plan-amount', text: formatAmount(remaining, it.unit) })),
          ...usage(it), ...itemNotes(it, false)));
      }
      out.push(list);
    }
    return out;
  }

  function renderTools(p, conn) {
    const id = p.id;
    if (state.confirmDelete === id) {
      return h('div', { class: 'bal-tools', role: 'group', 'aria-label': T.removeAsk },
        h('span', { class: 'bal-tools-ask', text: T.removeAsk }),
        h('button', { class: 'bal-btn danger', type: 'button', 'data-focus': `confirm:${id}`, onclick: () => removeProvider(p) }, T.removeConfirm),
        h('button', { class: 'bal-btn', type: 'button', onclick: () => { state.confirmDelete = null; renderList(); } }, T.cancel));
    }
    return h('div', { class: 'bal-tools' },
      conn ? h('span', { class: 'bal-tools-key', text: T.keyTail(conn.tail) }) : null,
      h('button', { class: 'bal-btn', type: 'button', disabled: Boolean(state.form) || state.connOk === false, onclick: () => openForm(p) }, icon('edit'), T.edit),
      h('button', { class: 'bal-btn', type: 'button', 'data-focus': `remove:${id}`, onclick: () => { state.confirmDelete = id; renderList(); } }, icon('remove'), T.remove));
  }

  function renderRow(p, pinned) {
    const st = stateOf(p);
    const busy = st === 'loading';
    const conn = state.connOk ? connById(p.slot, p.connectionId) : undefined;
    const last = p.last;
    const items = last && Array.isArray(last.items) ? last.items : [];
    const first = items[0];
    const failed = Boolean(last && !last.ok);
    const moreOpen = state.moreOpen === p.id;

    const pin = h('button', {
      class: 'bal-pin', type: 'button', 'aria-pressed': String(pinned), 'aria-label': T.pin, title: pinned ? T.pinOn : T.pinOff,
      'data-focus': `pin:${p.id}`, onclick: () => setPinned(p, !pinned),
    }, icon(pinned ? 'pinOn' : 'pin'));

    const when = last
      ? h('span', { class: 'bal-time', title: new Date(last.at).toLocaleString(state.locale), text: T.updated(ago(last.at)) })
      : h('span', { class: 'bal-time', text: T.neverUpdated });
    const refresh = h('button', {
      class: `bal-icon-btn bal-refresh${busy ? ' spinning' : ''}`, type: 'button', 'aria-label': busy ? T.refreshBusy : T.refresh, title: busy ? T.refreshBusy : T.refresh,
      disabled: busy || state.batch, 'data-focus': `refresh:${p.id}`, onclick: () => refreshOne(p),
    }, icon('refresh'));
    const more = h('button', {
      class: 'bal-icon-btn bal-more', type: 'button', 'aria-label': T.more, title: T.more, 'aria-expanded': String(moreOpen), 'data-focus': `more:${p.id}`,
      onclick: () => { state.moreOpen = moreOpen ? null : p.id; if (state.confirmDelete === p.id) state.confirmDelete = null; renderList(); },
    }, icon('more'));

    const remaining = amountOf(first);
    const spend = spendText(recentSpend(p));
    const amountCls = remaining !== undefined ? 'bal-amount-value' : 'bal-amount-none';
    const amount = h('div', { class: `${amountCls}${failed && items.length ? ' dim' : ''}`, title: failed && items.length ? T.lastGood : null, text: remaining !== undefined ? formatAmount(remaining, first.unit) : T.dash });

    const notes = [];
    if (state.connOk && !conn) notes.push(h('div', { class: 'bal-warn', text: T.keyMissing }));
    if (failed) {
      notes.push(h('div', { class: 'bal-error', role: 'alert', text: last.error }));
      if (items.length) notes.push(h('div', { class: 'bal-note', text: T.lastGood }));
    }
    if (items.length > 1) notes.push(...renderPlans(p, items, failed));
    else if (first) notes.push(...usage(first), ...itemNotes(first, true));
    if (moreOpen) notes.push(renderTools(p, conn));

    return h('div', { class: 'bal-row', role: 'listitem', 'data-id': p.id, 'data-state': st },
      pin,
      h('div', { class: 'bal-name', text: p.name || p.host }),
      amount,
      h('div', { class: 'bal-acts' }, refresh, more),
      h('div', { class: 'bal-meta' }, h('span', { class: 'bal-host', text: p.host }), when),
      spend ? h('div', { class: 'bal-spend', text: spend }) : null,
      notes.length ? h('div', { class: 'bal-detail' }, notes) : null);
  }

  let justOpened = null;

  function renderList() {
    const list = els.list;
    if (!list) return;
    // 列表整块重画（相对时间每 30 秒也会重画）：记住焦点所在的控件，画完放回去
    const focusKey = document.activeElement && list.contains(document.activeElement) ? document.activeElement.getAttribute('data-focus') : null;
    list.textContent = '';
    if (state.loadError) {
      list.append(h('div', { class: 'bal-error' }, T.loadFailed + state.loadError, ' ', h('button', { class: 'bal-btn', type: 'button', onclick: loadAll }, T.retry)));
      return;
    }
    if (state.loaded && !state.providers.length && !state.form) {
      list.append(h('div', { class: 'bal-empty' }, h('div', { class: 'bal-empty-title', text: T.emptyTitle }), h('div', { class: 'bal-empty-body', text: T.emptyBody })));
      return;
    }
    const on = pinnedIds(state.providers);
    for (const p of state.providers) list.append(renderRow(p, on.has(p.id)));
    justOpened = null;
    if (focusKey) {
      const el = Array.from(list.querySelectorAll('[data-focus]')).find((x) => x.getAttribute('data-focus') === focusKey);
      if (el && !el.disabled) el.focus();
    }
  }

  function renderAll() {
    renderHeader();
    renderList();
  }

  /* ---------- 添加 / 编辑表单 ---------- */
  function openForm(p) {
    if (state.form) return;
    const f = { mode: p ? 'edit' : 'add', provider: p || null, analysis: null, busy: false, ui: {} };
    state.form = f;
    els.formHost.textContent = '';
    els.formHost.append(buildForm(f));
    renderHeader();
    renderList();
    updateForm(f);
    f.ui.script.focus();
  }

  function closeForm() {
    state.form = null;
    els.formHost.textContent = '';
    renderAll();
  }

  function buildForm(f) {
    const ui = f.ui;
    const p = f.provider;
    ui.script = h('textarea', { class: 'bal-input mono', rows: '8', spellcheck: 'false', autocomplete: 'off', placeholder: T.scriptPlaceholder, 'aria-label': T.scriptLabel });
    ui.script.value = p ? p.script : '';
    ui.counter = h('div', { class: 'bal-counter' });
    ui.baseUrl = h('input', { class: 'bal-input', type: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: T.baseUrlPlaceholder });
    ui.baseUrl.value = p ? p.baseUrl || '' : '';
    ui.userId = h('input', { class: 'bal-input', type: 'text', autocomplete: 'off', placeholder: T.userIdPlaceholder });
    ui.userId.value = p ? p.userId || '' : '';
    // 密钥框：password + autocomplete=off；值只在点「添加/保存」的瞬间读出并立刻清空
    ui.key = h('input', { class: 'bal-input', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: T.keyPlaceholder });
    ui.name = h('input', { class: 'bal-input', type: 'text', autocomplete: 'off', placeholder: T.namePlaceholder, maxlength: '64' });
    ui.name.value = p ? p.name || '' : '';
    ui.baseUrlRow = field(T.baseUrlLabel, ui.baseUrl);
    ui.userIdRow = field(T.userIdLabel, ui.userId);
    ui.keyHelp = h('div', { class: 'bal-help', text: T.keyHelp });
    ui.preview = h('div', { class: 'bal-preview', hidden: true });
    ui.error = h('div', { class: 'bal-error', role: 'alert', hidden: true });
    ui.hint = h('div', { class: 'bal-help' });
    ui.parse = h('button', { class: 'bal-btn', type: 'button', onclick: () => doParse(f) }, T.parse);
    ui.submit = h('button', { class: 'bal-btn primary', type: 'button', onclick: () => doSubmit(f) }, p ? T.saveEdit : T.save);
    ui.cancel = h('button', { class: 'bal-btn', type: 'button', onclick: closeForm }, T.cancel);

    const presets = h('div', { class: 'bal-presets' },
      h('span', { class: 'bal-presets-label', text: T.presets }),
      ...T.presetList.map(([key, name, route]) =>
        h('button', { class: 'bal-preset', type: 'button', 'data-preset': key, onclick: () => { ui.script.value = PRESETS[key]; invalidate(f); } },
          h('span', { class: 'bal-preset-name', text: name }), ' ', h('span', { class: 'bal-preset-path', text: route }))));

    for (const el of [ui.script, ui.baseUrl, ui.userId]) el.addEventListener('input', () => invalidate(f));
    ui.key.addEventListener('input', () => updateForm(f));

    return h('section', { class: 'bal-form', 'aria-label': p ? T.formEditTitle : T.formAddTitle },
      h('h3', { class: 'bal-form-title', text: p ? T.formEditTitle : T.formAddTitle }),
      presets,
      h('div', { class: 'bal-help bal-preset-help', text: T.presetHelp }),
      h('label', { class: 'bal-field' }, h('span', { class: 'bal-label', text: T.scriptLabel }), ui.script, ui.counter),
      ui.baseUrlRow,
      ui.userIdRow,
      field(T.keyLabel, ui.key, ui.keyHelp),
      field(T.nameLabel, ui.name),
      ui.preview,
      h('div', { class: 'bal-risk', text: T.risk }),
      ui.error,
      ui.hint,
      h('div', { class: 'bal-form-actions' }, ui.parse, ui.submit, ui.cancel));
  }

  function field(label, input, extra) {
    return h('label', { class: 'bal-field' }, h('span', { class: 'bal-label', text: label }), input, extra);
  }

  function invalidate(f) {
    f.analysis = null;
    showError(f, '');
    updateForm(f);
  }

  function showError(f, text) {
    f.ui.error.hidden = !text;
    f.ui.error.textContent = text || '';
  }

  /** 连接情况：能否沿用已有连接、是否必须填密钥、有没有冲突。 */
  function connectionPlan(f, a, tokenTyped) {
    const editId = f.provider ? f.provider.id : null;
    const others = state.providers.filter((x) => x.id !== editId);
    const sameSlot = others.filter((x) => x.slot === a.slot && x.host === a.host);
    const otherSlot = a.slot === 'bearer' ? 'apikey' : 'bearer';
    const cross = others.filter((x) => x.slot === otherSlot && x.host === a.host);
    const existing = findConn(a.slot, a.host);
    const plan = { existing, sameSlot, conflict: '', needsKey: !existing };
    if (cross.length) plan.conflict = T.errCrossSlot(cross.map((x) => x.name || x.host).join('、'));
    else if (existing && sameSlot.length && tokenTyped) plan.conflict = T.errTokenConflict;
    else if (!existing) {
      const decl = state.conns.find((c) => c.key === a.slot);
      const max = (decl && decl.maxConnections) || LIMITS.perSlot;
      if (decl && (decl.connections || []).length >= max) plan.conflict = T.errSlotFull(max);
    }
    return plan;
  }

  function updateForm(f) {
    const ui = f.ui;
    const script = ui.script.value;
    const bytes = byteLen(script);
    const over = bytes > LIMITS.scriptBytes;
    ui.counter.textContent = T.scriptCounter(bytes, LIMITS.scriptBytes);
    ui.counter.classList.toggle('over', over);
    const need = scan(script);
    ui.baseUrlRow.hidden = !need.baseUrl;
    ui.userIdRow.hidden = !need.userId;
    ui.parse.disabled = f.busy || !script.trim() || over;
    ui.parse.textContent = f.busy === 'parse' ? T.parsing : T.parse;
    ui.submit.textContent = f.busy === 'save' ? T.saving : f.provider ? T.saveEdit : T.save;
    ui.cancel.disabled = Boolean(f.busy);

    const a = f.analysis;
    let canSubmit = Boolean(a) && !f.busy;
    let hint = a ? '' : T.parseFirst;
    if (a) {
      const tokenTyped = ui.key.value.length > 0;
      const plan = connectionPlan(f, a, tokenTyped);
      const lines = [];
      if (plan.conflict) { canSubmit = false; lines.push(plan.conflict); }
      else if (plan.needsKey && !tokenTyped) { canSubmit = false; lines.push(T.needKey); }
      if (plan.existing) lines.push(T.connExisting(plan.existing.tail));
      if (plan.existing && plan.sameSlot.length) lines.push(T.sharedHint(plan.sameSlot.map((x) => x.name || x.host).join('、')));
      hint = lines.join(' ');
      ui.key.placeholder = plan.existing ? T.keyPlaceholderKeep(plan.existing.tail) : T.keyPlaceholder;
    } else {
      ui.key.placeholder = f.provider ? T.keyPlaceholderKeep((connById(f.provider.slot, f.provider.connectionId) || {}).tail) : T.keyPlaceholder;
    }
    ui.submit.disabled = !canSubmit;
    ui.hint.textContent = hint;
    ui.hint.hidden = !hint;
    renderPreview(f);
  }

  function renderPreview(f) {
    const box = f.ui.preview;
    const a = f.analysis;
    box.textContent = '';
    box.hidden = !a;
    if (!a) return;
    box.append(
      h('div', { class: 'bal-pv-row' }, h('span', { class: 'bal-pv-k', text: T.previewRequest }), h('code', { class: 'bal-pv-v', text: `${a.request.method} ${a.request.url}` })),
      h('div', { class: 'bal-pv-row' }, h('span', { class: 'bal-pv-k', text: T.previewKey }), h('code', { class: 'bal-pv-v', text: a.slot === 'bearer' ? T.previewKeyBearer : T.previewKeyApi })),
      h('div', { class: 'bal-pv-note', text: T.previewSlot(a.host) }));
    const others = Object.entries(a.request.headers || {});
    if (others.length) box.append(h('div', { class: 'bal-pv-row' }, h('span', { class: 'bal-pv-k', text: T.previewHeaders }), h('code', { class: 'bal-pv-v', text: others.slice(0, 6).map(([k, v]) => `${k}: ${v}`).join('\n') })));
    for (const w of a.warnings || []) box.append(h('div', { class: 'bal-pv-warn', text: w }));
  }

  async function doParse(f) {
    const ui = f.ui;
    if (f.busy) return;
    showError(f, '');
    const script = ui.script.value;
    if (!script.trim()) return showError(f, T.errScriptRequired);
    if (byteLen(script) > LIMITS.scriptBytes) return showError(f, T.errScriptTooLarge(LIMITS.scriptBytes));
    f.busy = 'parse';
    updateForm(f);
    try {
      await loadConns();
      const a = await bridge().call('balance/analyze', { script, baseUrl: ui.baseUrl.value.trim(), userId: ui.userId.value.trim() });
      if (!a || !a.ok) throw analysisError(a || {});
      f.analysis = { ...a, input: { script, baseUrl: ui.baseUrl.value.trim(), userId: ui.userId.value.trim() } };
    } catch (err) {
      f.analysis = null;
      showError(f, explain(err));
    } finally {
      f.busy = false;
      updateForm(f);
    }
  }

  async function doSubmit(f) {
    const ui = f.ui;
    const a = f.analysis;
    if (f.busy || !a) return;
    showError(f, '');
    const editing = f.provider;
    const old = editing ? { slot: editing.slot, host: editing.host, connectionId: editing.connectionId } : null;

    // 密钥：点击的同一刻就取走并清空输入框；它只存在于这个函数的局部变量里，只经 POST 交给宿主保险库
    let token = ui.key.value;
    ui.key.value = '';
    f.busy = 'save';
    updateForm(f);
    // 还没碰保险库就失败的检查：把密钥放回输入框，用户不用重新输入
    const refuse = (text) => {
      ui.key.value = token;
      token = '';
      f.busy = false;
      updateForm(f);
      showError(f, text);
    };

    // 先做不会留下副作用的检查，再碰宿主保险库
    if (!editing && state.providers.length >= LIMITS.providers) return refuse(T.errProvidersFull(LIMITS.providers));
    await loadConns();
    const plan = connectionPlan(f, a, token.length > 0);
    if (plan.conflict) return refuse(plan.conflict);

    const input = a.input;
    const entry = {
      id: editing ? editing.id : (crypto.randomUUID ? crypto.randomUUID() : `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`),
      name: ui.name.value.trim().slice(0, 64),
      baseUrl: input.baseUrl,
      script: input.script,
      slot: a.slot,
      host: a.host,
      connectionId: plan.existing ? plan.existing.id : '',
      createdAt: editing ? editing.createdAt : Date.now(),
    };
    if (input.userId) entry.userId = input.userId;
    const sameTarget = Boolean(editing && editing.slot === a.slot && editing.host === a.host);
    if (sameTarget && editing.last) entry.last = editing.last;
    if (sameTarget && editing.history) entry.history = editing.history;
    if (editing && typeof editing.pinned === 'boolean') entry.pinned = editing.pinned;

    const nextList = editing ? state.providers.map((x) => (x.id === editing.id ? entry : x)) : [...state.providers, entry];
    try {
      const cfg = await kvRead();
      cfg.providers = nextList.map(stripProvider);
      if (fitKv(cfg) === null) return refuse(T.errKvFull);
    } catch (err) {
      return refuse(T.errKvWrite + ((err && err.message) || ''));
    }
    if (!token && !entry.connectionId) return refuse(T.needKey);

    try {
      if (token) {
        const body = { host: a.host, token, label: (entry.name || a.host).slice(0, 64) };
        let res;
        try {
          res = await req(`/connections/${encodeURIComponent(a.slot)}`, { method: 'POST', body: JSON.stringify(body) });
        } finally {
          body.token = '';
          token = '';
        }
        const r = res.data;
        if (!res.ok || !r || !r.ok) throw coded(connError(r && r.error, res.status) + (r && r.error === 'CONFIRM_DENIED' ? '' : ` ${T.errKeyRetype}`), 'CONN');
        entry.connectionId = r.connection.id;
      }

      // 对 /kv 里最新的列表做改动（别的页面可能刚改过）；编辑的那条若已被别处删掉就当新增
      // 页签栏开关：编辑沿用 /kv 里最新的值；新增按 defaultPin（已有显式值时默认不显示）
      await persist((list) => {
        const cur = editing ? list.find((x) => x.id === editing.id) : null;
        if (cur) return list.map((x) => (x.id === editing.id ? { ...entry, ...(typeof x.pinned === 'boolean' ? { pinned: x.pinned } : {}) } : x));
        const rest = list.filter((x) => x.id !== entry.id);
        const pin = defaultPin(rest);
        const added = { ...entry };
        if (pin === undefined) delete added.pinned; else added.pinned = pin;
        return [...rest, added];
      });
      // 编辑时换了域名或密钥位置：旧连接若没人用了就清掉
      if (old && (old.slot !== entry.slot || old.host !== entry.host) && old.connectionId &&
          !state.providers.some((x) => x.slot === old.slot && x.host === old.host)) {
        await req(`/connections/${encodeURIComponent(old.slot)}/${encodeURIComponent(old.connectionId)}`, { method: 'DELETE' }).catch(() => {});
      }
    } catch (err) {
      f.busy = false;
      updateForm(f);
      return showError(f, err && err.code === 'KV_WRITE' ? T.errKvWrite + err.message : (err && err.message) || T.unknown);
    }
    f.busy = false;
    toast(editing ? T.saved : T.added);
    closeForm();
    await loadConns();
    renderAll();
    const live = state.providers.find((x) => x.id === entry.id);
    if (live) refreshOne(live);
  }

  function connError(code, status) {
    switch (code) {
      case 'CONFIRM_DENIED': return T.errConfirmDenied;
      case 'INVALID_TOKEN': return T.needKey;
      case 'LIMIT': return T.errSlotFull(LIMITS.perSlot);
      case 'VAULT_WRITE_FAILED': return T.errVault;
      default: return T.errConnGeneric(code || `HTTP ${status}`);
    }
  }

  /* ---------- 模块契约 ---------- */
  function startTick() {
    stopTick();
    // 只刷新「x 分钟前」这类相对时间，不发任何请求；页签隐藏时必须停掉
    tick = setInterval(renderList, 30000);
  }
  function stopTick() {
    if (tick) clearInterval(tick);
    tick = 0;
  }

  function mount(root, context) {
    ctx = context;
    state.locale = (context && context.locale) || 'zh-CN';
    els.refreshAllLabel = h('span', { text: T.refreshAll });
    els.refreshAll = h('button', { class: 'bal-btn', type: 'button', onclick: refreshAll }, icon('refresh'), els.refreshAllLabel);
    els.addBtn = h('button', { class: 'bal-btn strong', type: 'button', onclick: () => openForm(null) }, icon('add'), T.add);
    els.count = h('span', { class: 'bal-count' });
    els.notice = h('div', { class: 'bal-notice', hidden: true, text: T.connUnavailable });
    els.formHost = h('div', { class: 'bal-form-host' });
    els.list = h('div', { class: 'bal-list', role: 'list', 'aria-label': T.title });
    root.textContent = '';
    root.append(h('div', { class: 'bal-root' },
      h('div', { class: 'bal-toolbar' },
        h('h2', { class: 'bal-title' }, h('span', { class: 'bal-sr', text: T.title }), els.count),
        h('div', { class: 'bal-toolbar-actions' }, els.refreshAll, els.addBtn)),
      els.notice, els.formHost, els.list));
    renderAll();
    return loadAll();
  }

  function onShow() {
    startTick();
    // 设置页或别处可能改过数据；有查询在途时不重读，避免覆盖进行中的结果
    if (ctx && state.loaded && !state.busy.size && !state.form) loadAll();
  }

  // presets 只为测试暴露，外壳只用 mount/onShow/onHide
  startSync();
  window.AgentTraceBalance = {
    mount, onShow, onHide: stopTick,
    // 以下不依赖界面，页签栏芯片与自动刷新用
    summary, refreshAll, seen, chipTitle, formatAmount, pageId: PAGE_ID,
    // 只为测试暴露：页签栏自选与近期消耗的纯函数
    pins: { pinnedIds, applyPin, defaultPin },
    spend: { recentSpend, spendText, fitKv, limits: SPEND, kvBytes: LIMITS.kvBytes },
    stripProvider,
    events: { updated: EVENT_UPDATED, refreshing: EVENT_REFRESHING, channel: SYNC_CHANNEL },
    presets: PRESETS,
  };
})();
