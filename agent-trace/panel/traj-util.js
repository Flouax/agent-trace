/* traj-util.js — 轨迹页签的公共部分：全部用户可见文案（T）、DOM 小工具、数字格式、本地存储。
 * 轨迹界面只有 traj-util / traj 两个文件，共用 window.AgentTraceTrajParts。 */
(function () {
  'use strict';

  /** 所有用户可见文案集中在这里，以后做本地化只改这一个对象。 */
  const T = {
    untitled: '未命名会话',
    engineName: { cc: 'Claude Code', pi: 'Pi', codex: 'Codex' },
    engineShort: { cc: 'CC', pi: 'Pi', codex: 'Codex' },
    refresh: '刷新',
    updated: (rel) => `${rel}更新`,
    hit: '缓存命中',
    context: '当前上下文',
    totals: { input: '输入', output: '输出', cost: '费用' },
    turns: (n) => `${n} 轮`,
    cols: { input: '输入', output: '输出', hit: '命中', rate: '速率' },
    turn: (n) => `第 ${n} 轮`,
    injected: '系统注入',
    rateUnit: 'tok/s',
    modelChange: (a, b) => `换模型 ${a} → ${b}`,
    compacted: '已压缩',
    noTitle: '（没有文字）',
    rowTip: (input, cacheRead, cacheWrite, output, modelS) => `送入 ${input}（其中缓存读取 ${cacheRead}、缓存写入 ${cacheWrite}）\n输出 ${output}\n模型生成 ${modelS} 秒`,
    // 压缩：Cindy 不让插件触发压缩（插件投递的消息会被加上来源说明，/compact 不再是命令），所以点一下就复制，再盯转录等压缩发生
    compact: {
      btn: '压缩', btnTip: '复制 /compact，粘贴到对话里发送即可压缩',
      copied: '已复制 /compact。到对话输入框粘贴并发送，压缩完成后这里会显示结果。',
      copyFail: '没能复制。请在对话输入框输入 /compact 并发送。',
      ring: '也可以直接点输入框旁的上下文圆环压缩。',
      done: (before) => (before ? `已压缩，压缩前上下文 ${before}。` : '已压缩。'),
      close: '关闭',
    },
    match: {
      inexact: '没有精确匹配到当前任务', inexactHint: '下面是最近修改的一份转录，可能不是这个任务的。',
      noTaskId: '没有取得当前任务', none: '没有找到当前任务的转录', noneHint: '可以从列表里选一个会话来看。',
      manual: '正在看手动选择的会话', reset: '恢复自动匹配', pick: '选择会话', closePick: '收起',
      filter: '按标题或目录筛选', listEmpty: '没有找到任何转录', listLoading: '正在列出会话…', listFail: '读取会话列表失败', current: '当前',
      tip: { source: '任务 id 来源', via: '定位方式', exact: '精确匹配', engine: '引擎', file: '转录文件', peek: '台前任务查询', warnings: '解析提示', yes: '是', no: '否' },
      sources: { peek: '台前任务', url: '任务页地址', manual: '手动选择', none: '无' },
    },
    // 台前任务查询（cindy.taskView peek）拿不到任务时的原因；未列出的错误码直接显示宿主的说明
    peek: {
      PERMISSION_DENIED: '插件没有取得任务页权限，无法得知当前是哪个任务。请更新插件。',
      HOST_NOT_READY: '当前没有打开任何任务。',
      TASKVIEW_UNAVAILABLE: '当前 Cindy 版本不支持查询台前任务。',
      INVALID_REQUEST: '查询台前任务的请求被拒绝。',
    },
    state: {
      loading: '正在读取…', empty: '这个会话还没有对话', emptyHint: '发出第一条消息后，这里会按轮记下用量。',
      error: '读取失败', retry: '重试', refreshFail: (code) => `刷新失败（${code}），显示的是上次的数据`,
      truncated: '转录里有内容过长被截断，数字不受影响。',
    },
    err: {
      NOT_FOUND: '找不到转录文件，可能已被移动或删除。', INVALID_PATH: '转录路径无效。', OUTSIDE_ROOTS: '这个路径不在允许读取的转录目录里。',
      PARSE_FAILED: '转录文件解析失败，可能已损坏或格式不受支持。', UNSUPPORTED_ENGINE: '暂不支持这种引擎的转录。', INVALID_PARAMS: '请求参数不合法。',
      DB_UNAVAILABLE: '无法读取 Cindy 的任务数据库，没法精确匹配当前任务。', TIMEOUT: '电子脑没有响应，请稍后重试。', NO_BUS: '当前环境不支持与电子脑通信。',
      FAILED: '操作失败。', UNKNOWN: '出了点问题。',
    },
    time: { justNow: '刚刚', minAgo: (n) => `${n} 分钟前`, hourAgo: (n) => `${n} 小时前`, dayAgo: (n) => `${n} 天前` },
    dash: '—',
  };

  // —— DOM 小工具 ——
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    for (const kid of kids) {
      if (kid == null || kid === false) continue;
      if (Array.isArray(kid)) append(el, kid);
      else el.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
    }
  }

  /** 像素图标来自共用的 icons.js；没有就不画（按钮仍有文字或无障碍标签）。 */
  const icon = (name) => (window.AgentTraceIcons ? window.AgentTraceIcons.make(name) : null);
  const refreshIcon = () => icon('refresh');

  // —— 数字格式：≥1000 用 K/M，最多 1 位小数；命中率整数百分比；费用两位小数 ——
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const one = (x) => String(Math.round(x * 10) / 10);
  function fmtTok(n) {
    if (!isNum(n)) return T.dash;
    const a = Math.abs(n);
    if (a < 1000) return String(Math.round(n));
    if (Math.round(a / 100) < 10000) return one(n / 1e3) + 'K'; // 999,950 进位成 1000K 时改用 M
    return one(n / 1e6) + 'M';
  }
  const fmtPct = (r) => (isNum(r) ? `${Math.round(r * 100)}%` : T.dash);
  const fmtCost = (c) => (isNum(c) ? `$${c.toFixed(2)}` : T.dash);
  const fmtInt = (n) => (isNum(n) ? Math.round(n).toLocaleString('en-US') : T.dash);
  const fmtRate = (r) => (isNum(r) ? (r < 10 ? one(r) : String(Math.round(r))) : T.dash);

  /** 每轮的四个数（SPEC 附录 C 的口径）。输入 = 送进模型的全部 token；速率只看模型生成耗时，<1 秒或输出 <20 token 不算。 */
  function turnNumbers(t) {
    const tk = t.tokens || {};
    const input = (tk.input || 0) + (tk.cacheRead || 0) + (tk.cacheWrite || 0);
    const output = tk.output || 0;
    const ms = isNum(t.modelMs) ? t.modelMs : 0;
    return {
      input, output, cacheRead: tk.cacheRead || 0, cacheWrite: tk.cacheWrite || 0, modelMs: ms,
      hit: input > 0 ? (tk.cacheRead || 0) / input : null,
      rate: ms >= 1000 && output >= 20 ? output / (ms / 1000) : null,
    };
  }

  function relTime(ts) {
    if (!isNum(ts)) return '';
    const sec = Math.max(0, (Date.now() - ts) / 1000);
    if (sec < 60) return T.time.justNow;
    if (sec < 3600) return T.time.minAgo(Math.floor(sec / 60));
    if (sec < 86400) return T.time.hourAgo(Math.floor(sec / 3600));
    return T.time.dayAgo(Math.floor(sec / 86400));
  }
  const lastSeg = (p) => String(p || '').split(/[\\/]+/).filter(Boolean).pop() || '';
  const sessionName = (info) => (info && (info.title || lastSeg(info.cwd))) || T.untitled;
  /** 模型名在标记里只留可读部分：claude-sonnet-5-5 → Sonnet 5.5；认不出就原样。 */
  function modelLabel(id) {
    const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/.exec(String(id || ''));
    if (!m) return String(id || T.dash);
    return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
  }

  function humanError(e) {
    const code = (e && e.code) || 'UNKNOWN';
    return { code, text: T.err[code] || (e && e.message) || T.err.UNKNOWN };
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (err) { /* 面板里可能没有剪贴板权限，退回旧办法 */ }
    try {
      const ta = h('textarea', { 'aria-hidden': 'true', class: 'tj-offscreen' });
      ta.value = text; document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (err) { return false; }
  }
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem('agent-trace.traj.' + key); return v == null ? fallback : JSON.parse(v); } catch (err) { return fallback; } },
    set(key, value) { try { localStorage.setItem('agent-trace.traj.' + key, JSON.stringify(value)); } catch (err) { /* 存储不可用就不记住 */ } },
  };

  window.AgentTraceTrajParts = { T, h, icon, refreshIcon, isNum, fmtTok, fmtPct, fmtCost, fmtInt, fmtRate, turnNumbers, relTime, lastSeg, sessionName, modelLabel, humanError, copyText, store };
})();
