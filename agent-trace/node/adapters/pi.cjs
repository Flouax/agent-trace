/**
 * adapters/pi.cjs — Pi 转录适配器。
 *
 * 位置（本机核对过）：
 * - Cindy 自带的 Pi：<Cindy 数据目录>/pi-agent-home/sessions/<ISO 时间戳>_<会话 id>.jsonl（平铺）；
 * - 独立安装的 Pi：~/.pi/agent/sessions/--<编码后的工作目录>--/<时间戳>_<会话 id>.jsonl（多一层目录）；
 * - 环境变量 AGENT_TRACE_PI_ROOTS（path.delimiter 分隔）追加根目录。
 * 子代理转录（pi-agent-home/runtime/pi-subagent-runs/）首版不并入主账本，所以不在 roots 里；只在 warnings 里数 subagent 工具调用。
 *
 * 取舍（格式见 Pi 文档 session-format.md / message-types.md，并用本机真实转录核对过结构与计数）：
 * - 记录是树（id / parentId），可能有分支。只取「当前分支」：从文件里最后一条带 id 的记录沿 parentId 回溯到根。
 *   Pi 自己的 active leaf 不落盘，而新记录总是挂在当前叶子下追加，所以最后追加的记录是合理近似。
 *   usage 记录（Pi 不让它进对话树）只要父节点在当前分支上就计入。不在当前分支上的记录只在 warnings 里计数。
 * - 时间：assistant 的 message.timestamp 是请求开始，记录自带 durationMs（本机核对：记录时间 ≈ 开始 + durationMs）；
 *   startTs = message.timestamp，endTs = startTs + durationMs；没有 durationMs 时用记录时间 − 开始时间。
 *   工具：endTs = toolResult 记录时间，durationMs 用 toolResult 自带的，startTs 据此倒推；没有就从发起调用的响应结束算起。
 * - 费用：usage.cost.total 是 Pi 记下的金额，逐次就有，直接用；不编造单价。会话总费用 = 当前分支上所有带金额记录之和。
 * - tokens：input / output / cacheRead / cacheWrite 原样；reasoning 已含在 output 里，不重复计入 total。
 *   compaction、branch_summary 的 usage（生成摘要的开销）、usage 记录、toolResult 的嵌套 usage 也计入总量：
 *   挂在对应的 meta / context / tool 步骤的 usage、costUsd 上（traj.cjs 的轮次汇总会一并累加），但不算「当前上下文」。
 * - context_edit 只改以后送给模型的上下文，不改原始历史与计费，账本里忽略；custom、label 忽略；session_info 的 name 作标题。
 * - 用户消息同样带 Cindy 宿主注入块，剥离规则与 cc 共用（lib/host-text.cjs）。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LIMITS, preview, emptySession } = require('../lib/schema.cjs');
const { splitHost, mergeSegments } = require('../lib/host-text.cjs');

const TEXT = {
  sessionStart: '会话开始',
  compaction: '上下文压缩',
  compactionTokens: (n) => `上下文压缩（压缩前约 ${n} tokens）`,
  modelChange: (a, b) => `模型切换：${a || '未知'} → ${b || '未知'}`,
  effortChange: (a, b) => `推理强度切换：${a || '未设置'} → ${b || '未设置'}`,
  apiError: '接口错误',
  interrupt: '用户中断',
  image: '[图片]',
  systemPrompt: '系统提示',
  systemPromptPatch: '系统提示变更',
  sectionRemoved: (k) => `## ${k}（移除）`,
  toolsAdded: (n, names) => `工具新增（${n}）：${names}`,
  toolsRemoved: (n, names) => `工具移除（${n}）：${names}`,
  extensionMessage: '扩展消息',
  branchSummary: '分支摘要',
  compactionSummary: '压缩摘要',
  commandOutput: '命令输出',
  otherMessage: (role) => `消息（${role}）`,
  extraUsage: (kind) => `额外用量（${kind || '未注明'}）`,
  warnBadLines: (n) => `${n} 行 JSON 损坏，已跳过`,
  warnTailCut: '末行未写完（会话可能仍在进行），已忽略',
  warnOffBranch: (n) => `${n} 条记录不在当前分支上（其他分支），未计入`,
  warnOrphan: (n) => `${n} 个工具结果找不到对应的调用，已忽略`,
  warnSubagent: (n) => `${n} 次子代理调用的内部过程未展开`,
  tooLarge: '转录文件过大，暂不支持解析',
  notFound: '找不到转录文件',
};

const MAX_FILE_BYTES = 400 * 1024 * 1024;
const PREVIEW_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill', 'name', 'text'];
const SUBAGENT_TOOLS = new Set(['subagent']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;

const coded = (code, message) => Object.assign(new Error(message), { code });

// ---------- 路径 ----------

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function roots() {
  // 延迟加载：discover.cjs 顶层会加载适配器注册表
  const { cindyDataDir } = require('../lib/discover.cjs');
  const out = [path.join(cindyDataDir(), 'pi-agent-home', 'sessions'), path.join(os.homedir(), '.pi', 'agent', 'sessions')];
  const env = process.env.AGENT_TRACE_PI_ROOTS;
  if (env && env.trim()) for (const p of env.split(path.delimiter)) if (p.trim()) out.push(p.trim());
  return [...new Set(out)].filter(isDir);
}

/** 根目录下的 .jsonl，以及下一层子目录里的（独立安装的 Pi 按工作目录分目录）。 */
function sessionFiles() {
  const out = [];
  const take = (dir, n) => {
    const p = path.join(dir, n);
    try {
      const st = fs.statSync(p);
      if (st.isFile()) out.push({ path: p, name: n, mtime: st.mtimeMs, size: st.size });
      else if (st.isDirectory()) return p;
    } catch { /* 文件刚被删 */ }
    return null;
  };
  for (const root of roots()) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) {
      if (n.endsWith('.jsonl')) { take(root, n); continue; }
      const sub = take(root, n);
      if (!sub) continue;
      let inner = [];
      try { inner = fs.readdirSync(sub); } catch { continue; }
      for (const m of inner) if (m.endsWith('.jsonl')) take(sub, m);
    }
  }
  return out;
}

/** <时间戳>_<id>.jsonl → id（时间戳里没有下划线）；不合规则就用去掉扩展名的文件名。 */
function idFromName(name) {
  const base = name.replace(/\.jsonl$/, '');
  const i = base.indexOf('_');
  return i >= 0 && i < base.length - 1 ? base.slice(i + 1) : base;
}

function realpathOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

function insideRoots(real) {
  return roots().some((r) => {
    const rr = realpathOrNull(r);
    return rr && real.startsWith(rr.endsWith(path.sep) ? rr : rr + path.sep);
  });
}

/**
 * Cindy 数据库的 sdk_session_id 对 Pi 存的是转录文件绝对路径；独立用法给的是会话 id。两种都接受。
 * 绝对路径必须（解析符号链接后）落在 roots() 之内、以 .jsonl 结尾、是文件，否则视为找不到。
 */
function findByEngineSessionId(id) {
  if (typeof id !== 'string' || !id || id.length > 4096 || id.includes('\0')) return null;
  if (path.isAbsolute(id)) {
    if (!id.endsWith('.jsonl')) return null;
    const real = realpathOrNull(id);
    if (!real || !real.endsWith('.jsonl') || !insideRoots(real)) return null;
    try { return fs.statSync(real).isFile() ? real : null; } catch { return null; }
  }
  if (!SAFE_ID.test(id)) return null;
  const want = `_${id}.jsonl`;
  let best = null;
  for (const f of sessionFiles()) {
    if ((f.name.endsWith(want) || f.name === `${id}.jsonl`) && (!best || f.mtime > best.mtime)) best = f;
  }
  return best ? best.path : null;
}

// ---------- 轻量列出 ----------

function readChunk(file, size, fromEnd) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const total = fs.fstatSync(fd).size;
    const len = Math.min(size, total);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, fromEnd ? total - len : 0);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* 忽略 */ }
  }
}

function headerOf(file) {
  const head = readChunk(file, 16 * 1024, false);
  const line = head.split('\n', 1)[0];
  try {
    const o = JSON.parse(line);
    return o && o.type === 'session' && typeof o.id === 'string' ? o : null;
  } catch {
    return null;
  }
}

function lightMeta(file) {
  const h = headerOf(file);
  const tail = readChunk(file, 128 * 1024, true);
  let title = null;
  const re = /"type":"session_info"[^\n]*?"name":"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(tail))) {
    try { title = JSON.parse('"' + m[1] + '"'); } catch { /* 忽略 */ }
  }
  return { id: h ? h.id : null, cwd: h && typeof h.cwd === 'string' ? h.cwd : null, title };
}

/** 与 cc.list 同口径：opts.limit；opts.light 只 stat 不读文件；带 query 时最多读 MAX_QUERY_SCAN 个最新文件的头尾。 */
const MAX_QUERY_SCAN = 600;
function list(opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 60, 2000));
  const query = typeof opts.query === 'string' ? opts.query.trim().toLowerCase() : '';
  const entries = sessionFiles().sort((a, b) => b.mtime - a.mtime);
  const out = [];
  const scan = query ? entries.slice(0, MAX_QUERY_SCAN) : entries.slice(0, limit);
  for (const e of scan) {
    const meta = opts.light ? { id: null, cwd: null, title: null } : lightMeta(e.path);
    const row = { path: e.path, id: meta.id || idFromName(e.name), cwd: meta.cwd, title: meta.title, mtime: e.mtime, size: e.size };
    if (query && !`${row.id}\n${row.cwd || ''}\n${row.title || ''}\n${row.path}`.toLowerCase().includes(query)) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

function sniff(file) {
  return headerOf(file) !== null;
}

// ---------- 解析 ----------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const tsOf = (o) => {
  if (!o || typeof o.timestamp !== 'string') return null;
  const t = Date.parse(o.timestamp);
  return Number.isFinite(t) ? t : null;
};

function usageOf(u) {
  if (!isObj(u)) return null;
  return { input: num(u.input), output: num(u.output), cacheRead: num(u.cacheRead), cacheWrite: num(u.cacheWrite), reasoning: num(u.reasoning) };
}
const costOf = (u) => (isObj(u) && isObj(u.cost) ? numOrNull(u.cost.total) : null);

/** 给非 assistant 步骤挂上额外用量（生成摘要、嵌套调用等），没有就不加字段。 */
function attachUsage(step, u) {
  const usage = usageOf(u);
  if (!usage) return;
  step.usage = usage;
  step.costUsd = costOf(u);
}

function argsPreviewOf(input) {
  if (isObj(input)) {
    for (const k of PREVIEW_KEYS) {
      if (typeof input[k] === 'string' && input[k].trim()) return preview(input[k]);
    }
  }
  let s = '';
  try { s = JSON.stringify(input) || ''; } catch { s = ''; }
  return preview(s);
}

/** content 是字符串或 (text | image)[]。 */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text') return typeof b.text === 'string' ? b.text : '';
      if (b.type === 'image') return TEXT.image;
      return `[${b.type}]`;
    })
    .filter(Boolean)
    .join('\n');
}

function systemText(m) {
  const parts = [];
  const c = contentText(m.content);
  if (c.trim()) parts.push(c);
  if (isObj(m.sections)) {
    for (const [k, v] of Object.entries(m.sections)) parts.push(v === null ? TEXT.sectionRemoved(k) : `## ${k}\n${typeof v === 'string' ? v : ''}`);
  }
  const names = (arr) => arr.map((t) => (t && typeof t.name === 'string' ? t.name : '?')).join(', ');
  if (Array.isArray(m.toolsAdded) && m.toolsAdded.length) parts.push(TEXT.toolsAdded(m.toolsAdded.length, names(m.toolsAdded)));
  if (Array.isArray(m.toolsRemoved) && m.toolsRemoved.length) parts.push(TEXT.toolsRemoved(m.toolsRemoved.length, names(m.toolsRemoved)));
  return parts.join('\n\n');
}

/** 逐行解析；坏行计数，最后一行写到一半单独标出。 */
function readRecords(raw) {
  const recs = [];
  let badLines = 0;
  let tailCut = false;
  let pos = 0;
  const len = raw.length;
  while (pos < len) {
    let nl = raw.indexOf('\n', pos);
    const atEof = nl === -1;
    if (atEof) nl = len;
    const line = raw.slice(pos, nl);
    pos = nl + 1;
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      if (atEof) tailCut = true;
      else badLines += 1;
      continue;
    }
    if (isObj(o) && typeof o.type === 'string') recs.push(o);
  }
  return { recs, badLines, tailCut };
}

/** 当前分支上的记录集合；没有任何 id（v1 线性格式）时返回 null，表示全部都在。 */
function activeBranch(recs) {
  const byId = new Map();
  let leaf = null;
  for (const o of recs) {
    if (o.type === 'session' || typeof o.id !== 'string') continue;
    byId.set(o.id, o);
    if (o.type !== 'usage') leaf = o;
  }
  if (!leaf) return null;
  const on = new Set();
  for (let cur = leaf; cur && !on.has(cur.id); cur = typeof cur.parentId === 'string' ? byId.get(cur.parentId) : null) on.add(cur.id);
  return on;
}

function parseText(raw, file) {
  const S = emptySession('pi', file);
  S.engineSessionId = idFromName(path.basename(file));
  const steps = S.steps;
  const warnings = S.warnings;
  const { recs, badLines, tailCut } = readRecords(raw);
  const branch = activeBranch(recs);
  const onBranch = (o) => {
    if (!branch) return true;
    if (typeof o.id !== 'string') return false;
    if (branch.has(o.id)) return true;
    return o.type === 'usage' && typeof o.parentId === 'string' && branch.has(o.parentId);
  };

  let turn = 0;
  let offBranch = 0;
  let orphans = 0;
  let subagents = 0;
  let minTs = null;
  let maxTs = null;
  let lastModel = '';
  let lastEffort = '';
  let sawSystem = false;
  let title = null;
  const tools = new Map(); // toolCall.id → tool step
  const seenModels = [];

  const touch = (t) => {
    if (t === null) return;
    if (minTs === null || t < minTs) minTs = t;
    if (maxTs === null || t > maxTs) maxTs = t;
  };
  const clipText = (s) => {
    if (s.length > LIMITS.text) { S.truncated = true; return s.slice(0, LIMITS.text); }
    return s;
  };
  const push = (step) => {
    step.index = steps.length;
    step.turn = turn;
    steps.push(step);
    return step;
  };
  const pushMeta = (metaKind, text, ts, data) => {
    const step = { index: 0, kind: 'meta', ts, turn, metaKind, text: clipText(text) };
    if (data) step.data = data;
    return push(step);
  };
  const pushContext = (label, text, ts) => push({ index: 0, kind: 'context', ts, turn, label, text: clipText(text), chars: text.length });
  const markPendingInterrupted = () => {
    for (const t of tools.values()) if (t.status === 'pending') t.status = 'interrupted';
  };

  function handleUser(m, ts) {
    const segments = [];
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') {
        if (b.text.trim()) segments.push(...splitHost(b.text));
      } else if (b.type === 'image') {
        segments.push({ kind: 'image', media: typeof b.mimeType === 'string' ? b.mimeType : '' });
      }
    }
    if (!segments.length) return;
    const merged = mergeSegments(segments);
    // 同一条消息里伴随用户输入的宿主说明属于新的一轮：先开新轮，user 步骤沿用它
    let bumped = false;
    if (merged.some((sg) => sg.kind === 'user')) { turn += 1; bumped = true; }
    for (const seg of merged) {
      if (seg.kind === 'user') {
        if (bumped) bumped = false;
        else turn += 1;
        const step = { index: 0, kind: 'user', ts, turn, text: clipText(seg.text) };
        if (seg.attachments) step.attachments = seg.attachments;
        push(step);
      } else {
        pushContext(seg.label, seg.text, ts);
      }
    }
  }

  function handleAssistant(m, ts) {
    const model = typeof m.model === 'string' ? m.model : '';
    const effort = typeof m.thinkingLevel === 'string' ? m.thinkingLevel : '';
    if (model) lastModel = model;
    if (effort) lastEffort = effort;
    if (model && !seenModels.includes(model)) seenModels.push(model);
    const begin = numOrNull(m.timestamp);
    let dur = numOrNull(m.durationMs);
    if (dur !== null && dur < 0) dur = null;
    if (dur === null && begin !== null && ts !== null && ts >= begin) dur = ts - begin;
    const startTs = begin !== null ? begin : ts !== null && dur !== null ? ts - dur : ts;
    const endTs = startTs !== null && dur !== null ? startTs + dur : ts;
    touch(startTs);
    touch(endTs);
    const u = usageOf(m.usage) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    const a = push({
      index: 0, kind: 'assistant', ts: startTs, turn, model, text: '', startTs, endTs, durationMs: dur,
      usage: u, costUsd: costOf(m.usage), toolCallIds: [],
    });
    if (effort) a.effort = effort;
    if (typeof m.stopReason === 'string') a.stopReason = m.stopReason;
    if (typeof m.responseId === 'string') a.requestId = m.responseId;
    const texts = [];
    const thinks = [];
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) thinks.push(b.thinking);
      else if (b.type === 'toolCall' && typeof b.id === 'string' && !tools.has(b.id)) {
        a.toolCallIds.push(b.id);
        let args = b.arguments === undefined ? {} : b.arguments;
        let ser = '';
        try { ser = JSON.stringify(args) || ''; } catch { ser = ''; }
        if (ser.length > LIMITS.args) { S.truncated = true; args = { _truncated: ser.slice(0, LIMITS.args) }; }
        const name = typeof b.name === 'string' ? b.name : '';
        if (SUBAGENT_TOOLS.has(name)) subagents += 1;
        tools.set(b.id, push({
          index: 0, kind: 'tool', ts: endTs, turn, callId: b.id, name, argsPreview: argsPreviewOf(b.arguments), args,
          result: { text: '', isError: false, truncated: false, chars: 0 }, startTs: endTs, endTs: null, durationMs: null, status: 'pending',
        }));
      }
    }
    a.text = clipText(texts.join('\n\n'));
    if (thinks.length) a.thinking = { text: clipText(thinks.join('\n\n')), durationMs: 0 };
    if (m.stopReason === 'aborted') {
      markPendingInterrupted();
      pushMeta('interrupt', TEXT.interrupt, endTs);
    } else if (m.stopReason === 'error') {
      pushMeta('error', typeof m.errorMessage === 'string' && m.errorMessage ? m.errorMessage : TEXT.apiError, endTs);
    }
  }

  function handleToolResult(m, ts) {
    const tool = tools.get(m.toolCallId);
    if (!tool || tool.endTs !== null) { orphans += 1; return; }
    const text = contentText(m.content);
    const isError = m.isError === true;
    tool.result = { text: clipText(text), isError, truncated: text.length > LIMITS.text, chars: text.length };
    const end = ts !== null ? ts : numOrNull(m.timestamp);
    const dur = numOrNull(m.durationMs);
    tool.endTs = end;
    if (dur !== null && dur >= 0) {
      tool.durationMs = dur;
      if (end !== null) tool.startTs = end - dur;
    } else {
      tool.durationMs = end !== null && tool.startTs !== null ? Math.max(0, end - tool.startTs) : null;
    }
    if (tool.status === 'pending') tool.status = isError ? 'error' : 'ok';
    else if (isError) tool.status = 'error';
    attachUsage(tool, m.usage);
    touch(end);
  }

  function handleMessage(o, ts) {
    const m = o.message;
    if (!isObj(m)) return;
    const role = m.role;
    if (role === 'user') handleUser(m, ts);
    else if (role === 'assistant') handleAssistant(m, ts);
    else if (role === 'toolResult') handleToolResult(m, ts);
    else if (role === 'system') {
      pushContext(sawSystem ? TEXT.systemPromptPatch : TEXT.systemPrompt, systemText(m), ts);
      sawSystem = true;
    } else if (role === 'custom') pushContext(typeof m.customType === 'string' && m.customType ? m.customType : TEXT.extensionMessage, contentText(m.content), ts);
    else if (role === 'bashExecution') pushContext(TEXT.commandOutput, `! ${m.command || ''}\n${typeof m.output === 'string' ? m.output : ''}`, ts);
    else if (role === 'branchSummary') pushContext(TEXT.branchSummary, typeof m.summary === 'string' ? m.summary : '', ts);
    else if (role === 'compactionSummary') pushContext(TEXT.compactionSummary, typeof m.summary === 'string' ? m.summary : '', ts);
    else if (typeof role === 'string') {
      const text = contentText(m.content);
      if (text) pushContext(TEXT.otherMessage(role), text, ts);
    }
  }

  for (const o of recs) {
    const t = o.type;
    if (t === 'session') {
      if (typeof o.id === 'string' && o.id) S.engineSessionId = o.id;
      if (S.cwd === null && typeof o.cwd === 'string' && o.cwd) S.cwd = o.cwd;
      if (!steps.length) {
        const ts = tsOf(o);
        touch(ts);
        pushMeta('session-start', TEXT.sessionStart, ts, typeof o.version === 'number' ? { version: o.version } : undefined);
      }
      continue;
    }
    if (!onBranch(o)) { offBranch += 1; continue; }
    const ts = tsOf(o);
    if (t === 'message') { touch(ts); handleMessage(o, ts); }
    else if (t === 'model_change') {
      const to = typeof o.modelId === 'string' ? o.modelId : '';
      if (to && lastModel && to !== lastModel) {
        const data = { from: lastModel, to };
        if (typeof o.provider === 'string') data.provider = o.provider;
        pushMeta('model-change', TEXT.modelChange(lastModel, to), ts, data);
      }
      if (to) lastModel = to;
    } else if (t === 'thinking_level_change') {
      const to = typeof o.thinkingLevel === 'string' ? o.thinkingLevel : '';
      if (to && lastEffort && to !== lastEffort) pushMeta('effort-change', TEXT.effortChange(lastEffort, to), ts, { from: lastEffort, to });
      if (to) lastEffort = to;
    } else if (t === 'compaction') {
      touch(ts);
      const pre = numOrNull(o.tokensBefore);
      const summary = typeof o.summary === 'string' ? o.summary : '';
      const step = pushMeta('compaction', pre === null ? TEXT.compaction : TEXT.compactionTokens(pre), ts, { preTokens: pre, trigger: o.fromHook === true ? 'hook' : '', summaryChars: summary.length });
      attachUsage(step, o.usage);
    } else if (t === 'branch_summary') {
      attachUsage(pushContext(TEXT.branchSummary, typeof o.summary === 'string' ? o.summary : '', ts), o.usage);
    } else if (t === 'custom_message') {
      pushContext(typeof o.customType === 'string' && o.customType ? o.customType : TEXT.extensionMessage, contentText(o.content), ts);
    } else if (t === 'usage') {
      const kind = typeof o.kind === 'string' ? o.kind : '';
      const data = { kind };
      if (typeof o.model === 'string') data.model = o.model;
      attachUsage(pushMeta('other', TEXT.extraUsage(kind), ts, data), o.usage);
    } else if (t === 'session_info') {
      if (typeof o.name === 'string' && o.name.trim()) title = o.name;
    }
    // context_edit / custom / label：不影响历史与计费，忽略
  }

  // 没有结果的工具：之后还有用户输入或模型响应 = 被跳过/中断，否则仍在进行
  let lastActive = -1;
  for (let i = steps.length - 1; i >= 0; i -= 1) if (steps[i].kind === 'user' || steps[i].kind === 'assistant') { lastActive = i; break; }
  for (const tl of tools.values()) if (tl.status === 'pending' && lastActive > tl.index) tl.status = 'interrupted';

  S.title = title;
  S.startedAt = minTs;
  S.endedAt = maxTs;
  const st = S.stats;
  st.turns = turn;
  st.steps = steps.length;
  st.durationMs = minTs !== null && maxTs !== null ? maxTs - minTs : 0;
  st.models = seenModels;
  let cost = null;
  for (const s of steps) {
    if (s.kind === 'tool') {
      st.toolCalls += 1;
      if (s.status === 'error') st.toolErrors += 1;
    } else if (s.kind === 'assistant') st.assistantMessages += 1;
    if (s.usage) {
      st.tokens.input += s.usage.input;
      st.tokens.output += s.usage.output;
      st.tokens.cacheRead += s.usage.cacheRead;
      st.tokens.cacheWrite += s.usage.cacheWrite;
    }
    if (typeof s.costUsd === 'number') cost = (cost || 0) + s.costUsd;
  }
  st.tokens.total = st.tokens.input + st.tokens.output + st.tokens.cacheRead + st.tokens.cacheWrite;
  st.costUsd = cost;

  if (badLines) warnings.push(TEXT.warnBadLines(badLines));
  if (tailCut) warnings.push(TEXT.warnTailCut);
  if (offBranch) warnings.push(TEXT.warnOffBranch(offBranch));
  if (orphans) warnings.push(TEXT.warnOrphan(orphans));
  if (subagents) warnings.push(TEXT.warnSubagent(subagents));
  return S;
}

function parse(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw coded('NOT_FOUND', TEXT.notFound);
  }
  if (st.size > MAX_FILE_BYTES) throw coded('PARSE_FAILED', TEXT.tooLarge);
  return parseText(fs.readFileSync(file, 'utf8'), file);
}

module.exports = { engine: 'pi', roots, list, findByEngineSessionId, sniff, parse, parseText };
