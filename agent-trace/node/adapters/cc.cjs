/**
 * adapters/cc.cjs — Claude Code 转录（<配置目录>/projects/<编码后的工作目录>/<会话id>.jsonl）适配器。
 *
 * 取舍（均已用本机真实转录核对过格式，见 DEV/tests/core 的汇报）：
 * - 以文件顺序为准，不依赖 parentUuid 树。
 * - 一次模型响应会被拆成多条 assistant 记录（每个内容块一条，message.id 相同、requestRef 相同）。
 *   按 message.id 合并成一个 assistant 步骤；usage 取该 id 最后一条记录（首条常是 message_start 的半成品）。
 * - 工具调用与结果合并：tool_use.id ↔ tool_result.tool_use_id。每个 tool_result 单独一条 user 记录。
 * - 时间：记录的 timestamp 并非全局单调（attachment 常被回填到几分钟前），所以
 *     assistant.startTs = 触发它的最近一条 user 记录（提示或 tool_result）的时间（取不到或晚于首条响应记录则用首条响应记录的时间），
 *     assistant.endTs   = 该 message.id 最后一条记录的时间，也就是「发出请求到响应写完」；
 *     tool.startTs      = 含该 tool_use 块的 assistant 记录时间，tool.endTs = tool_result 记录时间；差值取 ≥0。
 *   attachment 聚合成的 context 步骤时间不早于上一个步骤。
 * - 费用：assistant 记录里没有单价与金额。只有 cost-state（累计 totalCostUSD，无时间戳，只有文件位置）。
 *   做法：会话总费用 = 最后一条 cost-state；相邻两条 cost-state 的差值记到它们之间最后一个 assistant 步骤的 costUsd
 *   （其余步骤为 null），所以按轮次或会话求和是准的，单步费用只是「快照增量」而非逐次计费。不编造单价。
 * - tokens：input=input_tokens，output=output_tokens，cacheRead=cache_read_input_tokens，cacheWrite=cache_creation_input_tokens，
 *   reasoning=output_tokens_details.thinking_tokens（已含在 output 里，不重复计入 total）。
 * - 压缩：system/compact_boundary → meta compaction，随后的 isCompactSummary 用户记录只用来填 summaryChars，不算用户输入、不新开一轮。
 * - isSidechain（子代理）记录：本机转录里没有出现过，真实格式未核实；保守处理为不进主时间线，只在 warnings 里计数。
 * - 宿主注入：[Task delivery] / [UI language] / [消息来源] / [Session fork 开头的文本块、<system-reminder>（规则在 lib/host-text.cjs，与 pi 共用）、
 *   isMeta 记录、渲染过的 attachment 都归入 context（连续的 attachment 合并为一个步骤，否则一轮能有上百条）；其余用户文本才是 user。
 * - 不读也不解析：api-request*、file-history-*、queue-operation、last-prompt、mode、tools-used 等（体积大且与轨迹无关）。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LIMITS, clip, preview, emptySession } = require('../lib/schema.cjs');
const { splitHost, mergeSegments } = require('../lib/host-text.cjs');

const TEXT = {
  sessionStart: '会话开始',
  compaction: '上下文压缩',
  compactionTokens: (n) => `上下文压缩（压缩前约 ${n} tokens）`,
  modelChange: (a, b) => `模型切换：${a || '未知'} → ${b || '未知'}`,
  effortChange: (a, b) => `推理强度切换：${a || '未设置'} → ${b || '未设置'}`,
  apiError: '接口错误',
  retryInfo: (n, max) => `（第 ${n}/${max} 次重试）`,
  interrupt: '用户中断',
  image: '[图片]',
  attachmentGroup: (n) => `注入上下文 ×${n}`,
  slashCommand: '斜杠命令',
  localOutput: '本地命令输出',
  taskNotification: '任务通知',
  metaMessage: '元消息',
  commandOutput: '命令输出',
  warnBadLines: (n) => `${n} 行 JSON 损坏，已跳过`,
  warnTailCut: '末行未写完（会话可能仍在进行），已忽略',
  warnSidechain: (n) => `${n} 条子代理（sidechain）记录未展开`,
  warnOrphan: (n) => `${n} 个工具结果找不到对应的调用，已忽略`,
  warnUnknownCost: '部分模型的费用未知，累计费用可能偏低',
  warnCostReset: 'cost-state 累计费用出现回退，已重置基线',
  tooLarge: '转录文件过大，暂不支持解析',
  notFound: '找不到转录文件',
};

const MAX_FILE_BYTES = 400 * 1024 * 1024;
/** 这些记录类型体积大或与轨迹无关，整行解析前就跳过（只在行首就是 {"type":"…"} 时可判断）。 */
const SKIP_TYPES = new Set([
  'api-request', 'api-request-blob', 'api-request-shape', 'file-history-snapshot', 'file-history-delta',
  'queue-operation', 'last-prompt', 'atis-latch', 'tools-used', 'mode', 'permission-mode', 'agent-setting', 'agent-name',
]);
const PREVIEW_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill', 'name', 'text'];

const coded = (code, message) => Object.assign(new Error(message), { code });

// ---------- 路径 ----------

function configDirs() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env && env.trim()) return [env.trim()];
  const home = os.homedir();
  const dirs = [path.join(home, '.claude')];
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  dirs.push(path.join(xdg, 'claude'));
  return dirs;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function roots() {
  return configDirs().map((d) => path.join(d, 'projects')).filter(isDir);
}

function projectDirs() {
  const out = [];
  for (const root of roots()) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) {
      const p = path.join(root, n);
      if (isDir(p)) out.push(p);
    }
  }
  return out;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;

function findByEngineSessionId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) return null;
  let best = null;
  for (const dir of projectDirs()) {
    const p = path.join(dir, id + '.jsonl');
    try {
      const st = fs.statSync(p);
      if (st.isFile() && (!best || st.mtimeMs > best.m)) best = { p, m: st.mtimeMs };
    } catch { /* 不在这个目录 */ }
  }
  return best ? best.p : null;
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

function jsonString(raw) {
  try { return JSON.parse('"' + raw + '"'); } catch { return null; }
}

function lastMatch(text, re) {
  let m;
  let last = null;
  re.lastIndex = 0;
  while ((m = re.exec(text))) last = m[1];
  return last;
}

function lightMeta(file) {
  const head = readChunk(file, 32 * 1024, false);
  const cwdM = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
  const tail = readChunk(file, 128 * 1024, true);
  const custom = lastMatch(tail, /"customTitle":"((?:[^"\\]|\\.)*)"/g);
  const ai = lastMatch(tail, /"aiTitle":"((?:[^"\\]|\\.)*)"/g);
  const t = custom != null ? custom : ai;
  return { cwd: cwdM ? jsonString(cwdM[1]) : null, title: t != null ? jsonString(t) : null };
}

/**
 * 轻量列出：只 stat，再对最新的 limit 条读头尾取 cwd/标题。
 * opts.light 只 stat 不读文件（cwd/title 为 null），给「按路径匹配」用。
 * 带 query 时要对更多文件读头尾（最多 MAX_QUERY_SCAN 个最新文件），否则会漏掉老会话。
 */
const MAX_QUERY_SCAN = 600;
function list(opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 60, 2000));
  const query = typeof opts.query === 'string' ? opts.query.trim().toLowerCase() : '';
  const entries = [];
  for (const dir of projectDirs()) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const p = path.join(dir, n);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) entries.push({ path: p, id: n.slice(0, -6), mtime: st.mtimeMs, size: st.size });
      } catch { /* 文件刚被删 */ }
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  const scan = query ? entries.slice(0, MAX_QUERY_SCAN) : entries.slice(0, limit);
  for (const e of scan) {
    const meta = opts.light ? { cwd: null, title: null } : lightMeta(e.path);
    const row = { path: e.path, id: e.id, cwd: meta.cwd, title: meta.title, mtime: e.mtime, size: e.size };
    if (query && !`${row.id}\n${row.cwd || ''}\n${row.title || ''}\n${row.path}`.toLowerCase().includes(query)) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

function sniff(file) {
  const head = readChunk(file, 16 * 1024, false);
  if (!head) return false;
  const lines = head.split('\n', 20);
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o && typeof o.sessionId === 'string' && typeof o.type === 'string' && !('payload' in o)) return true;
  }
  return false;
}

// ---------- 解析 ----------

const tsOf = (o) => {
  if (!o || typeof o.timestamp !== 'string') return null;
  const t = Date.parse(o.timestamp);
  return Number.isFinite(t) ? t : null;
};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

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

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content
    .map((b) => {
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text') return typeof b.text === 'string' ? b.text : '';
      if (b.type === 'image') return TEXT.image;
      if (b.type === 'tool_reference') return `[tool_reference ${b.tool_name || ''}]`.trim();
      return `[${b.type}]`;
    })
    .filter(Boolean)
    .join('\n');
}

function tagText(text, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? m[1].trim() : '';
}

/** 一个文本块 → 归类，返回段数组：kind 为 user / context / system / interrupt。 */
function classifyText(text, rec) {
  const t = text.trimStart();
  const one = (seg) => [seg];
  if (t.startsWith('[Request interrupted')) return one({ kind: 'interrupt', text: text.trim() });
  if (t.startsWith('<local-command-stdout>') || t.startsWith('<local-command-stderr>')) {
    return one({ kind: 'system', label: TEXT.localOutput, text: tagText(t, 'local-command-stdout') || tagText(t, 'local-command-stderr') || text });
  }
  if (t.startsWith('<command-name>') || t.startsWith('<command-message>')) {
    const name = tagText(t, 'command-name') || tagText(t, 'command-message');
    const args = tagText(t, 'command-args');
    return one({ kind: 'user', text: [name, args].filter(Boolean).join(' ') });
  }
  if (t.startsWith('<bash-input>')) return one({ kind: 'user', text: '! ' + tagText(t, 'bash-input') });
  if (t.startsWith('<bash-stdout>') || t.startsWith('<bash-stderr>')) return one({ kind: 'context', label: TEXT.commandOutput, text });
  if (t.startsWith('<task-notification>') || (rec && rec.turnOrigin === 'task_notification')) {
    return one({ kind: 'context', label: TEXT.taskNotification, text });
  }
  if (rec && rec.isMeta) return one({ kind: 'context', label: TEXT.metaMessage, text });
  return splitHost(text);
}

function parseText(raw, file) {
  const S = emptySession('cc', file);
  S.engineSessionId = path.basename(file).replace(/\.jsonl$/, '');
  const steps = S.steps;
  const warnings = S.warnings;

  let turn = 0;
  let badLines = 0;
  let tailCut = false;
  let sidechain = 0;
  let orphans = 0;
  let sawStart = false;
  let minTs = null;
  let maxTs = null;
  let triggerTs = null;
  let lastModel = '';
  let lastEffort = '';
  let customTitle = null;
  let aiTitle = null;
  let lastCostTotal = null;
  let costAccum = 0;
  let costTracked = false;
  let lastAssistant = null;
  let unknownCost = false;
  let costReset = false;
  let lastCompaction = null;
  let lastStepTs = null;
  let group = null; // 连续 attachment 的聚合

  const msgs = new Map(); // message.id → assistant step
  const tools = new Map(); // tool_use.id → tool step
  const done = new WeakSet(); // 已收到结果的工具（被中断标记后结果仍可能随后到达）
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
    if (typeof step.ts === 'number') lastStepTs = step.ts;
    return step;
  };
  const monotone = (t) => (t === null ? lastStepTs : lastStepTs !== null && t < lastStepTs ? lastStepTs : t);

  const flushGroup = () => {
    if (!group) return;
    const g = group;
    group = null;
    const types = [...new Set(g.parts.map((p) => p.type))];
    const label = g.parts.length === 1 ? types[0] : TEXT.attachmentGroup(g.parts.length) + `（${types.slice(0, 4).join('、')}${types.length > 4 ? '…' : ''}）`;
    const text = g.parts.map((p) => (g.parts.length === 1 ? p.text : `## ${p.type}\n${p.text}`)).join('\n\n');
    push({ index: 0, kind: 'context', ts: monotone(g.ts), turn, label, text: clipText(text), chars: text.length });
  };

  const ensureStart = (o) => {
    if (sawStart) return;
    sawStart = true;
    flushGroup();
    const data = {};
    for (const k of ['version', 'gitBranch', 'entrypoint']) if (typeof o[k] === 'string') data[k] = o[k];
    push({ index: 0, kind: 'meta', ts: tsOf(o), turn, metaKind: 'session-start', text: TEXT.sessionStart, data });
  };

  const pushMeta = (metaKind, text, ts, data) => {
    flushGroup();
    const step = { index: 0, kind: 'meta', ts: monotone(ts), turn, metaKind, text: clipText(text) };
    if (data) step.data = data;
    return push(step);
  };

  const markPendingInterrupted = () => {
    for (const t of tools.values()) if (t.status === 'pending') t.status = 'interrupted';
  };

  function handleUser(o, ts) {
    if (o.isCompactSummary) {
      const c = o.message && o.message.content;
      const len = typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((n, b) => n + (b && typeof b.text === 'string' ? b.text.length : 0), 0) : 0;
      if (lastCompaction) lastCompaction.data.summaryChars = len;
      return;
    }
    const content = o.message ? o.message.content : null;
    const segments = [];
    const handleBlocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
    let sawResult = false;
    for (const b of handleBlocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_result') {
        sawResult = true;
        const tool = tools.get(b.tool_use_id);
        if (!tool || done.has(tool)) {
          if (!tool) orphans += 1;
          continue;
        }
        done.add(tool);
        const text = resultText(b.content);
        tool.result = { text: clipText(text), isError: b.is_error === true, truncated: text.length > LIMITS.text, chars: text.length };
        tool.endTs = ts;
        tool.durationMs = ts !== null && tool.startTs !== null ? Math.max(0, ts - tool.startTs) : null;
        const tur = o.toolUseResult;
        tool.status = b.is_error === true ? 'error' : isObj(tur) && tur.interrupted === true ? 'interrupted' : 'ok';
        if (isObj(tur) && typeof tur.agentId === 'string') tool.subagent = { sessionId: tur.agentId };
      } else if (b.type === 'text' && typeof b.text === 'string') {
        if (b.text.trim()) segments.push(...classifyText(b.text, o));
      } else if (b.type === 'image') {
        segments.push({ kind: 'image', media: b.source && b.source.media_type });
      }
    }
    if (sawResult) {
      triggerTs = ts !== null ? ts : triggerTs;
    }
    if (!segments.length) return;

    // 同一条记录里伴随用户输入的宿主说明属于新的一轮：先开新轮，user 步骤沿用它
    ensureStart(o);
    const merged = mergeSegments(segments);
    let bumped = false;
    if (merged.some((sg) => sg.kind === 'user')) {
      flushGroup();
      turn += 1;
      bumped = true;
    }
    for (const seg of merged) {
      if (seg.kind === 'user') {
        flushGroup();
        if (bumped) bumped = false;
        else turn += 1;
        const step = { index: 0, kind: 'user', ts, turn, text: clipText(seg.text) };
        if (seg.attachments) step.attachments = seg.attachments;
        push(step);
        triggerTs = ts !== null ? ts : triggerTs;
      } else if (seg.kind === 'interrupt') {
        markPendingInterrupted();
        pushMeta('interrupt', TEXT.interrupt, ts);
      } else if (seg.kind === 'system') {
        pushMeta('system', seg.text, ts);
      } else {
        flushGroup();
        push({ index: 0, kind: 'context', ts: monotone(ts), turn, label: seg.label, text: clipText(seg.text), chars: seg.text.length });
      }
    }
  }

  function handleAssistant(o, ts) {
    const m = o.message;
    if (!m || typeof m !== 'object') return;
    const blocks = Array.isArray(m.content) ? m.content : [];
    ensureStart(o);
    if (o.isApiErrorMessage || m.model === '<synthetic>') {
      const text = blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n') || TEXT.apiError;
      pushMeta('error', text, ts);
      return;
    }
    const id = typeof m.id === 'string' && m.id ? m.id : `__noid_${steps.length}`;
    let a = msgs.get(id);
    if (!a) {
      flushGroup();
      const model = typeof m.model === 'string' ? m.model : '';
      const effort = typeof o.effort === 'string' ? o.effort : '';
      if (model && lastModel && model !== lastModel) pushMeta('model-change', TEXT.modelChange(lastModel, model), ts, { from: lastModel, to: model });
      if (effort && lastEffort && effort !== lastEffort) pushMeta('effort-change', TEXT.effortChange(lastEffort, effort), ts, { from: lastEffort, to: effort });
      if (model) lastModel = model;
      if (effort) lastEffort = effort;
      if (model && !seenModels.includes(model)) seenModels.push(model);
      const start = triggerTs !== null && ts !== null && triggerTs <= ts ? triggerTs : ts;
      a = push({
        index: 0, kind: 'assistant', ts: start, turn, model, text: '', startTs: start, endTs: ts, durationMs: null,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, costUsd: null, toolCallIds: [],
      });
      if (effort) a.effort = effort;
      msgs.set(id, a);
      lastAssistant = a;
    }
    if (ts !== null && (a.endTs === null || ts > a.endTs)) a.endTs = ts;
    a.durationMs = a.startTs !== null && a.endTs !== null ? Math.max(0, a.endTs - a.startTs) : null;
    if (m.stop_reason) a.stopReason = m.stop_reason;
    const reqId = o.requestId || o.requestRef;
    if (typeof reqId === 'string') a.requestId = reqId;
    const u = m.usage;
    if (isObj(u)) {
      a.usage = {
        input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens),
        cacheWrite: num(u.cache_creation_input_tokens),
        reasoning: isObj(u.output_tokens_details) ? num(u.output_tokens_details.thinking_tokens) : 0,
      };
    }
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string') {
        a.text = a.text ? a.text + '\n\n' + b.text : b.text;
      } else if (b.type === 'thinking') {
        const th = a.thinking || (a.thinking = { text: '', durationMs: 0 });
        if (typeof b.thinking === 'string' && b.thinking) th.text = th.text ? th.text + '\n\n' + b.thinking : b.thinking;
        if (typeof o.thinkingDurationMs === 'number') th.durationMs = Math.max(th.durationMs, o.thinkingDurationMs);
      } else if (b.type === 'tool_use' && typeof b.id === 'string') {
        if (tools.has(b.id)) continue;
        a.toolCallIds.push(b.id);
        let args = b.input === undefined ? {} : b.input;
        let ser = '';
        try { ser = JSON.stringify(args) || ''; } catch { ser = ''; }
        if (ser.length > LIMITS.args) { S.truncated = true; args = { _truncated: ser.slice(0, LIMITS.args) }; }
        tools.set(b.id, push({
          index: 0, kind: 'tool', ts, turn, callId: b.id, name: typeof b.name === 'string' ? b.name : '', argsPreview: argsPreviewOf(b.input), args,
          result: { text: '', isError: false, truncated: false, chars: 0 }, startTs: ts, endTs: null, durationMs: null, status: 'pending',
        }));
      }
    }
    if (a.text.length > LIMITS.text) { S.truncated = true; a.text = a.text.slice(0, LIMITS.text); }
    if (a.thinking && a.thinking.text.length > LIMITS.text) { S.truncated = true; a.thinking.text = a.thinking.text.slice(0, LIMITS.text); }
  }

  function handleSystem(o, ts) {
    const sub = o.subtype;
    if (sub === 'compact_boundary') {
      ensureStart(o);
      const cm = isObj(o.compactMetadata) ? o.compactMetadata : {};
      const pre = typeof cm.preTokens === 'number' ? cm.preTokens : null;
      const data = { preTokens: pre, trigger: typeof cm.trigger === 'string' ? cm.trigger : '', summaryChars: 0 };
      if (typeof cm.postTokens === 'number') data.postTokens = cm.postTokens;
      if (typeof cm.durationMs === 'number') data.durationMs = cm.durationMs;
      lastCompaction = pushMeta('compaction', pre === null ? TEXT.compaction : TEXT.compactionTokens(pre), ts, data);
    } else if (sub === 'api_error') {
      const e = isObj(o.error) ? o.error : {};
      let text = (typeof e.formatted === 'string' && e.formatted) || (typeof e.message === 'string' && e.message) || TEXT.apiError;
      if (typeof o.retryAttempt === 'number' && typeof o.maxRetries === 'number') text += TEXT.retryInfo(o.retryAttempt, o.maxRetries);
      const data = {};
      if (typeof e.status === 'number') data.status = e.status;
      pushMeta('error', text, ts, Object.keys(data).length ? data : undefined);
    } else if (sub === 'stop_hook_summary') {
      if (Array.isArray(o.hookErrors) && o.hookErrors.length) pushMeta('error', o.hookErrors.map(String).join('\n'), ts);
    } else if (typeof o.content === 'string' && o.content.trim()) {
      pushMeta('system', o.content, ts);
    }
  }

  function handleAttachment(o, ts) {
    const att = isObj(o.attachment) ? o.attachment : null;
    if (!att || !Array.isArray(o.rendered)) return; // hook_success 等没有 rendered 的只是噪音
    const text = o.rendered.map((r) => (r && typeof r.content === 'string' ? r.content : '')).filter(Boolean).join('\n');
    if (!text) return;
    ensureStart(o);
    if (!group) group = { parts: [], ts };
    else if (ts !== null && (group.ts === null || ts > group.ts)) group.ts = ts;
    group.parts.push({ type: String(att.type || 'attachment'), text });
  }

  function handleCost(o) {
    const total = o.totalCostUSD;
    if (typeof total !== 'number' || !Number.isFinite(total)) return;
    if (o.hasUnknownModelCost === true) unknownCost = true;
    if (lastCostTotal === null) {
      // 文件开头、还没有任何响应时就带着累计值 = 续接/分叉继承来的历史花费，只当基线，不算在本转录头上
      lastCostTotal = lastAssistant ? 0 : total;
      if (!lastAssistant) return;
    }
    if (total < lastCostTotal) {
      costReset = true;
      lastCostTotal = total;
      return;
    }
    const delta = total - lastCostTotal;
    lastCostTotal = total;
    costTracked = true;
    costAccum += delta;
    if (delta > 0 && lastAssistant) lastAssistant.costUsd = (lastAssistant.costUsd || 0) + delta;
  }

  // 逐行处理。用 indexOf 切行避免再复制一份大数组。
  let pos = 0;
  const len = raw.length;
  while (pos < len) {
    let nl = raw.indexOf('\n', pos);
    const atEof = nl === -1;
    if (atEof) nl = len;
    const line = raw.slice(pos, nl);
    pos = nl + 1;
    if (!line.trim()) continue;
    if (line.charCodeAt(0) === 123 && line.startsWith('{"type":"')) {
      const e = line.indexOf('"', 9);
      if (e > 0 && SKIP_TYPES.has(line.slice(9, e))) continue;
    }
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      if (atEof) tailCut = true;
      else badLines += 1;
      continue;
    }
    if (!isObj(o) || typeof o.type !== 'string') continue;
    const t = o.type;
    if (o.isSidechain === true && (t === 'user' || t === 'assistant' || t === 'attachment' || t === 'system')) {
      sidechain += 1;
      continue;
    }
    const ts = tsOf(o);
    if (t === 'user' || t === 'assistant' || t === 'system') touch(ts);
    if (t === 'user') handleUser(o, ts);
    else if (t === 'assistant') handleAssistant(o, ts);
    else if (t === 'system') handleSystem(o, ts);
    else if (t === 'attachment') handleAttachment(o, ts);
    else if (t === 'cost-state') handleCost(o);
    else if (t === 'ai-title' && typeof o.aiTitle === 'string') aiTitle = o.aiTitle;
    else if (t === 'custom-title' && typeof o.customTitle === 'string') customTitle = o.customTitle;
    if (S.cwd === null && typeof o.cwd === 'string' && o.cwd) S.cwd = o.cwd;
  }
  flushGroup();

  // 没有结果的工具：之后还有用户输入或模型响应 = 被跳过/中断，否则仍在进行
  const lastTurnIdx = (() => {
    for (let i = steps.length - 1; i >= 0; i -= 1) if (steps[i].kind === 'user' || steps[i].kind === 'assistant') return i;
    return -1;
  })();
  for (const tl of tools.values()) {
    if (tl.status === 'pending' && lastTurnIdx > tl.index) tl.status = 'interrupted';
    if (tl.endTs !== null) touch(tl.endTs);
  }

  S.title = customTitle != null ? customTitle : aiTitle;
  S.startedAt = minTs;
  S.endedAt = maxTs;
  const st = S.stats;
  st.turns = turn;
  st.steps = steps.length;
  st.durationMs = minTs !== null && maxTs !== null ? maxTs - minTs : 0;
  st.models = seenModels;
  st.costUsd = costTracked ? costAccum : null;
  for (const s of steps) {
    if (s.kind === 'tool') {
      st.toolCalls += 1;
      if (s.status === 'error') st.toolErrors += 1;
    } else if (s.kind === 'assistant') {
      st.assistantMessages += 1;
      st.tokens.input += s.usage.input;
      st.tokens.output += s.usage.output;
      st.tokens.cacheRead += s.usage.cacheRead;
      st.tokens.cacheWrite += s.usage.cacheWrite;
    }
  }
  st.tokens.total = st.tokens.input + st.tokens.output + st.tokens.cacheRead + st.tokens.cacheWrite;

  if (badLines) warnings.push(TEXT.warnBadLines(badLines));
  if (tailCut) warnings.push(TEXT.warnTailCut);
  if (sidechain) warnings.push(TEXT.warnSidechain(sidechain));
  if (orphans) warnings.push(TEXT.warnOrphan(orphans));
  if (unknownCost) warnings.push(TEXT.warnUnknownCost);
  if (costReset) warnings.push(TEXT.warnCostReset);
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

module.exports = { engine: 'cc', roots, list, findByEngineSessionId, sniff, parse, parseText, _splitHost: splitHost };
