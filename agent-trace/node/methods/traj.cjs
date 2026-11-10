/**
 * methods/traj.cjs — 轨迹相关 RPC（SPEC 第 4 节）。导出 { '方法名': (params, ctx) => result }。
 *
 * 安全：传入的 path 必须（解析符号链接后）位于某个已注册适配器的 roots() 之内，否则抛 OUTSIDE_ROOTS，
 * 不会读取任意 .jsonl。解析结果走 lib/cache.cjs。
 * 体积：worker 单行响应上限 900,000 字节，所以 traj/step、traj/timeline 自己做收缩，并把收缩如实标出来。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const registry = require('../adapters/index.cjs');
const cache = require('../lib/cache.cjs');
const discover = require('../lib/discover.cjs');
const { preview } = require('../lib/schema.cjs');

const TEXT = {
  needPath: '需要提供转录文件路径',
  badPath: '路径必须是 .jsonl 转录文件的绝对路径',
  missing: '找不到转录文件',
  notFile: '该路径不是文件',
  outside: '该路径不在任何已知引擎的转录目录内',
  unsupported: '该引擎的适配器尚未接入',
  parseFailed: '解析转录失败',
  badIndex: '步骤序号无效',
  outOfRange: '步骤序号超出范围',
  needQuery: '需要提供搜索关键词',
  preTurn: '（开场与注入内容）',
  cutNote: '\n…（响应过大，已截断；完整内容请直接查看转录文件）',
};

const RESPONSE_BUDGET = 800000; // 字节；worker 上限 900,000，留出信封与转义的余量
const MAX_LOAD = 120;
const MAX_QUERY = 200;

const coded = (code, message) => Object.assign(new Error(message), { code });

// ---------- 路径校验与解析 ----------

function realpathOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

function underRoot(real, root) {
  const r = realpathOrNull(root);
  if (!r) return false;
  const base = r.endsWith(path.sep) ? r : r + path.sep;
  return real.startsWith(base);
}

function locate(file) {
  if (typeof file !== 'string' || !file) throw coded('INVALID_PATH', TEXT.needPath);
  if (file.length > 4096 || file.includes('\0') || !path.isAbsolute(file) || !file.endsWith('.jsonl')) throw coded('INVALID_PATH', TEXT.badPath);
  const real = realpathOrNull(file);
  if (!real) {
    // 路径不存在：先判断它在不在允许范围内，避免通过 NOT_FOUND / OUTSIDE_ROOTS 的差异探测目录结构
    const dirReal = realpathOrNull(path.dirname(file));
    const inside = dirReal && registry.all().some((ad) => ad.roots().some((r) => underRoot(path.join(dirReal, path.basename(file)), r)));
    throw coded(inside ? 'NOT_FOUND' : 'OUTSIDE_ROOTS', inside ? TEXT.missing : TEXT.outside);
  }
  const matches = registry.all().filter((ad) => ad.roots().some((r) => underRoot(real, r)));
  if (!matches.length) {
    if (/[\\/]\.(pi|codex)[\\/]/.test(real)) throw coded('UNSUPPORTED_ENGINE', TEXT.unsupported);
    throw coded('OUTSIDE_ROOTS', TEXT.outside);
  }
  let st;
  try { st = fs.statSync(real); } catch { throw coded('NOT_FOUND', TEXT.missing); }
  if (!st.isFile()) throw coded('INVALID_PATH', TEXT.notFile);
  const adapter = matches.length === 1 ? matches[0] : matches.find((a) => { try { return a.sniff(real); } catch { return false; } }) || matches[0];
  return { adapter, real };
}

function load(file) {
  const { adapter, real } = locate(file);
  try {
    return cache.getParsed(real, (p) => adapter.parse(p));
  } catch (err) {
    if (err && err.code) throw err;
    throw coded('PARSE_FAILED', `${TEXT.parseFailed}：${err && err.message}`);
  }
}

// ---------- 摘要与裁剪 ----------

function summarize(step) {
  const s = { ...step };
  switch (step.kind) {
    case 'user':
      s.preview = preview(step.text);
      s.textChars = step.text.length;
      delete s.text;
      break;
    case 'context':
      s.preview = preview(step.text);
      delete s.text;
      break;
    case 'assistant': {
      s.preview = preview(step.text || (step.thinking && step.thinking.text) || '');
      s.textChars = step.text.length;
      delete s.text;
      if (step.thinking) s.thinking = { durationMs: step.thinking.durationMs, chars: step.thinking.text.length };
      break;
    }
    case 'tool':
      s.preview = step.argsPreview;
      s.resultPreview = preview(step.result.text);
      s.result = { isError: step.result.isError, truncated: step.result.truncated, chars: step.result.chars };
      delete s.args;
      break;
    default: // meta
      s.preview = preview(step.text);
      s.textChars = step.text.length;
      delete s.text;
  }
  return s;
}

const byteLen = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/** 把一个完整步骤收缩到能装进一条响应；收缩的字段用 truncated 标出。 */
function fitStep(step) {
  const s = JSON.parse(JSON.stringify(step));
  for (let guard = 0; guard < 30 && byteLen({ step: s }) > RESPONSE_BUDGET; guard += 1) {
    const fields = [];
    if (typeof s.text === 'string') fields.push([s.text.length, () => { s.text = cut(s.text); }]);
    if (s.thinking && typeof s.thinking.text === 'string') fields.push([s.thinking.text.length, () => { s.thinking.text = cut(s.thinking.text); }]);
    if (s.result && typeof s.result.text === 'string') fields.push([s.result.text.length, () => { s.result.text = cut(s.result.text); s.result.truncated = true; }]);
    if (s.args !== undefined) {
      const ser = JSON.stringify(s.args);
      fields.push([ser.length, () => { s.args = { _truncated: cut(ser) }; }]);
    }
    if (!fields.length) break;
    fields.sort((a, b) => b[0] - a[0]);
    fields[0][1]();
    s.transportTruncated = true;
  }
  return s;
}

function cut(text) {
  const keep = Math.max(1000, Math.floor(text.length * 0.6));
  return text.length <= keep ? text : text.slice(0, keep) + TEXT.cutNote;
}

// ---------- 轮次与时间线 ----------

/**
 * 宿主整段塞进来的「用户」输入（会话上下文重建、工作记忆刷新等），首行形如 `[Session context rebuild · internal context]`。
 * 这类轮次不是用户亲手输入的：界面灰显、不编号、不计入轮次数。[Session fork · internal context] 已由适配器剥成 context，不会走到这里。
 */
const INJECTED_RE = /^\[[^\]\n]{1,80}· internal context\]/;

const stepStart = (s) => (s.kind === 'assistant' || s.kind === 'tool' ? (s.startTs != null ? s.startTs : s.ts) : s.ts);
const stepEnd = (s) => {
  if ((s.kind === 'assistant' || s.kind === 'tool') && s.endTs != null) return s.endTs;
  return s.ts;
};

/** 把一个步骤的用量与费用记到轮次上。非 assistant 步骤也可能带 usage（pi 的压缩摘要、额外用量记录等，见 SPEC 附录 E）。 */
function addUsage(t, s) {
  t.tokens.input += s.usage.input;
  t.tokens.output += s.usage.output;
  t.tokens.cacheRead += s.usage.cacheRead;
  t.tokens.cacheWrite += s.usage.cacheWrite;
  if (s.costUsd != null) t.costUsd = (t.costUsd || 0) + s.costUsd;
}

function buildTurns(session) {
  const map = new Map();
  for (const s of session.steps) {
    let t = map.get(s.turn);
    if (!t) {
      t = {
        turn: s.turn, title: '', startedAt: null, endedAt: null, durationMs: 0, steps: 0, toolCalls: 0, toolErrors: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, costUsd: null, models: [],
        toolStats: [], firstStep: s.index, lastStep: s.index, _tools: new Map(),
        modelMs: 0, injected: s.turn === 0, compacted: false, modelChange: null, _firstModel: '', _lastModel: '', _metaChange: null,
      };
      map.set(s.turn, t);
    }
    t.steps += 1;
    t.lastStep = s.index;
    const a = stepStart(s);
    const b = stepEnd(s);
    if (a != null && (t.startedAt === null || a < t.startedAt)) t.startedAt = a;
    for (const v of [a, b]) if (v != null && (t.endedAt === null || v > t.endedAt)) t.endedAt = v;
    if (s.kind === 'user') {
      t.title = preview(s.text, 80);
      if (INJECTED_RE.test(s.text.trimStart())) t.injected = true;
    } else if (s.kind === 'assistant') {
      if (s.durationMs != null) t.modelMs += s.durationMs;
      if (s.model) { if (!t._firstModel) t._firstModel = s.model; t._lastModel = s.model; }
      addUsage(t, s);
      if (s.model && !t.models.includes(s.model)) t.models.push(s.model);
    } else if (s.kind === 'tool') {
      t.toolCalls += 1;
      const isErr = s.status === 'error';
      if (isErr) t.toolErrors += 1;
      let ts = t._tools.get(s.name);
      if (!ts) { ts = { name: s.name, calls: 0, errors: 0, totalMs: 0 }; t._tools.set(s.name, ts); }
      ts.calls += 1;
      if (isErr) ts.errors += 1;
      ts.totalMs += s.durationMs || 0;
    } else if (s.kind === 'meta') {
      if (s.metaKind === 'compaction') t.compacted = true;
      else if (s.metaKind === 'model-change' && !t._metaChange && s.data && s.data.from && s.data.to) t._metaChange = { from: s.data.from, to: s.data.to };
    }
    if (s.kind !== 'assistant' && s.usage && typeof s.usage === 'object') addUsage(t, s);
  }
  // 换模型：本轮有 model-change 事件就用它（取第一个）；否则比较本轮首个与上一轮最后一个有模型名的响应。模型名为空不算变化。
  let prevModel = '';
  for (const t of map.values()) {
    if (t._metaChange) t.modelChange = t._metaChange;
    else if (prevModel && t._firstModel && t._firstModel !== prevModel) t.modelChange = { from: prevModel, to: t._firstModel };
    if (t._lastModel) prevModel = t._lastModel;
  }
  return [...map.values()].map((t) => {
    t.tokens.total = t.tokens.input + t.tokens.output + t.tokens.cacheRead + t.tokens.cacheWrite;
    t.durationMs = t.startedAt !== null && t.endedAt !== null ? Math.max(0, t.endedAt - t.startedAt) : 0;
    t.toolStats = [...t._tools.values()].sort((a, b) => b.calls - a.calls);
    delete t._tools; delete t._firstModel; delete t._lastModel; delete t._metaChange;
    if (!t.title) t.title = t.turn === 0 ? TEXT.preTurn : '';
    return t;
  });
}

function rowLabel(s, max) {
  let label;
  switch (s.kind) {
    case 'user': label = s.text; break;
    case 'context': label = s.label; break;
    case 'assistant': label = s.model || 'assistant'; break;
    case 'tool': label = s.argsPreview ? `${s.name}: ${s.argsPreview}` : s.name; break;
    default: label = s.text;
  }
  return preview(label, max);
}

function buildTimeline(session) {
  const rows = [];
  const turnSpan = new Map();
  let lastTs = null;
  let rStart = null;
  let rEnd = null;
  for (const s of session.steps) {
    let a = stepStart(s);
    let b = stepEnd(s);
    if (a == null) a = lastTs;
    if (b == null) b = a;
    if (a != null && b != null && b < a) b = a;
    if (b != null) lastTs = b;
    if (a != null) {
      if (rStart === null || a < rStart) rStart = a;
      if (rEnd === null || b > rEnd) rEnd = b;
      const sp = turnSpan.get(s.turn);
      if (!sp) turnSpan.set(s.turn, { turn: s.turn, start: a, end: b });
      else { if (a < sp.start) sp.start = a; if (b > sp.end) sp.end = b; }
    }
    rows.push({
      i: s.index, lane: s.kind === 'assistant' ? 1 : s.kind === 'tool' ? 2 : 0, start: a, end: b, kind: s.kind, label: rowLabel(s, 60),
      error: (s.kind === 'tool' && s.status === 'error') || (s.kind === 'meta' && s.metaKind === 'error'), turn: s.turn,
    });
  }
  let out = rows;
  let omitted = 0;
  const fits = (r) => byteLen(r) <= RESPONSE_BUDGET - 20000;
  if (!fits(out)) out = out.filter((r) => r.kind !== 'context');
  if (!fits(out)) out = out.filter((r) => r.kind !== 'meta' || r.error || r.lane !== 0);
  if (!fits(out)) out = out.map((r) => ({ ...r, label: r.label.slice(0, 20) }));
  if (!fits(out)) {
    // 仍然太大：按步长抽样，保留错误行与用户输入
    let stride = 2;
    while (!fits(out) && stride < 64) {
      const keep = rows.filter((r, n) => r.error || r.kind === 'user' || n % stride === 0).map((r) => ({ ...r, label: r.label.slice(0, 20) }));
      out = keep;
      stride *= 2;
    }
  }
  omitted = rows.length - out.length;
  const res = { rows: out, range: { start: rStart, end: rEnd }, turns: [...turnSpan.values()] };
  if (omitted) res.omitted = omitted;
  return res;
}

/**
 * 账本总览（SPEC 附录 C）：
 * - cacheHitRate = 全会话 cacheRead ÷ (input + cacheRead + cacheWrite)，分母为 0 时 null；
 * - contextTokens = 最近一次主线模型调用送进去的总量 (input + cacheRead + cacheWrite)，即当前上下文大小；
 *   子代理（sidechain）记录适配器不放进主时间线，所以这里天然不计；usage 全为 0 的响应（没写完）跳过；
 *   最近一次压缩之后还没有新的响应时为 null（压缩后的上下文大小要等下一次调用才知道）。
 */
function ledgerOf(session) {
  const tk = session.stats.tokens;
  const fed = tk.input + tk.cacheRead + tk.cacheWrite;
  let contextTokens = null;
  let contextModel = '';
  for (let i = session.steps.length - 1; i >= 0; i -= 1) {
    const st = session.steps[i];
    if (st.kind === 'meta' && st.metaKind === 'compaction') break;
    if (st.kind !== 'assistant') continue;
    const n = st.usage.input + st.usage.cacheRead + st.usage.cacheWrite;
    if (n > 0) { contextTokens = n; contextModel = st.model; break; }
  }
  return { cacheHitRate: fed > 0 ? tk.cacheRead / fed : null, contextTokens, contextModel };
}

// ---------- 搜索 ----------

function snippetAt(text, idx, qlen) {
  const from = Math.max(0, idx - 40);
  const to = Math.min(text.length, idx + qlen + 60);
  return (from > 0 ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ').trim() + (to < text.length ? '…' : '');
}

function search(session, q, limit) {
  const needle = q.toLowerCase();
  const hits = [];
  const probe = (s, where, text) => {
    if (hits.length >= limit || typeof text !== 'string' || !text) return;
    const idx = text.toLowerCase().indexOf(needle);
    if (idx >= 0) hits.push({ index: s.index, kind: s.kind, where, snippet: snippetAt(text, idx, q.length) });
  };
  for (const s of session.steps) {
    if (hits.length >= limit) break;
    if (s.kind === 'user') probe(s, 'text', s.text);
    else if (s.kind === 'assistant') {
      probe(s, 'text', s.text);
      if (s.thinking) probe(s, 'thinking', s.thinking.text);
    } else if (s.kind === 'tool') {
      let args = '';
      try { args = JSON.stringify(s.args) || ''; } catch { args = ''; }
      probe(s, 'args', args);
      probe(s, 'result', s.result.text);
    }
  }
  return hits;
}

// ---------- RPC ----------

const int = (v, d) => (Number.isInteger(v) ? v : Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.trunc(Number(v)) : d);

module.exports = {
  'sessions/resolve': (p) => discover.resolveSession({ sessionId: p && p.sessionId }),

  'sessions/list': (p) => discover.listAllSessions({ limit: p && p.limit, query: p && p.query }),

  'traj/meta': (p) => {
    const s = load(p && p.path);
    return { engine: s.engine, engineSessionId: s.engineSessionId, cwd: s.cwd, title: s.title, startedAt: s.startedAt, endedAt: s.endedAt, stats: s.stats, warnings: s.warnings, truncated: s.truncated, ...ledgerOf(s) };
  },

  'traj/turns': (p) => ({ turns: buildTurns(load(p && p.path)) }),

  'traj/timeline': (p) => buildTimeline(load(p && p.path)),

  'traj/load': (p) => {
    const s = load(p && p.path);
    const offset = Math.max(0, int(p.offset, 0));
    const limit = Math.min(MAX_LOAD, Math.max(1, int(p.limit, 60)));
    return { total: s.steps.length, offset, steps: s.steps.slice(offset, offset + limit).map(summarize) };
  },

  'traj/step': (p) => {
    const s = load(p && p.path);
    const index = p && p.index;
    if (!Number.isInteger(index) || index < 0) throw coded('INVALID_PARAMS', TEXT.badIndex);
    if (index >= s.steps.length) throw coded('NOT_FOUND', TEXT.outOfRange);
    return { step: fitStep(s.steps[index]) };
  },

  'traj/search': (p) => {
    const q = p && typeof p.q === 'string' ? p.q.trim() : '';
    if (!q) throw coded('INVALID_PARAMS', TEXT.needQuery);
    const limit = Math.min(1000, Math.max(1, int(p.limit, 200)));
    return { hits: search(load(p.path), q.slice(0, MAX_QUERY), limit) };
  },
};

// 给测试与合成样本生成器用的纯函数（不可枚举：worker 会把可枚举的函数导出都注册成 RPC 方法）
Object.defineProperty(module.exports, '_internals', { value: { buildTurns, ledgerOf }, enumerable: false });
