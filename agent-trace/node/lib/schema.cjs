/**
 * node/lib/schema.cjs — 统一步骤结构的唯一权威定义（SPEC.md 第 3 节的代码版）。
 *
 * 三个引擎适配器（cc / pi / codex）都必须产出能通过 validateSession() 的记录；
 * 界面只认这一种结构。改结构先改 SPEC.md 并通知协调者，不要各自悄悄加字段。
 */

'use strict';

const SCHEMA_VERSION = 1;
const ENGINES = ['cc', 'pi', 'codex'];
const STEP_KINDS = ['user', 'context', 'assistant', 'tool', 'meta'];
const META_KINDS = ['compaction', 'model-change', 'effort-change', 'session-start', 'session-info', 'error', 'interrupt', 'system', 'other'];
const TOOL_STATUS = ['ok', 'error', 'pending', 'interrupted'];

/** 单个文本字段的硬上限（字符）。超出的由适配器截断并把 truncated 置真。 */
const LIMITS = { text: 200000, preview: 400, args: 200000 };

function clip(text, max) {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text);
  return s.length > max ? s.slice(0, max) : s;
}

/** 单行预览：折叠空白并截断，供列表行使用。 */
function preview(text, max = LIMITS.preview) {
  const s = clip(text, max * 4).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function emptySession(engine, path) {
  return {
    schemaVersion: SCHEMA_VERSION,
    engine,
    engineSessionId: '',
    path,
    cwd: null,
    title: null,
    startedAt: null,
    endedAt: null,
    steps: [],
    stats: {
      turns: 0,
      steps: 0,
      toolCalls: 0,
      toolErrors: 0,
      assistantMessages: 0,
      durationMs: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      costUsd: null,
      models: [],
    },
    warnings: [],
    truncated: false,
  };
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isNumOrNull = (v) => v === null || isNum(v);
const isStr = (v) => typeof v === 'string';

/**
 * 校验一条会话记录，返回问题列表（空数组 = 通过）。
 * 只查结构与类型，不查语义；适配器自己的测试还要核对内容是否正确。
 */
function validateSession(rec) {
  const problems = [];
  const bad = (msg) => problems.push(msg);
  if (!rec || typeof rec !== 'object') return ['记录不是对象'];
  if (rec.schemaVersion !== SCHEMA_VERSION) bad(`schemaVersion 应为 ${SCHEMA_VERSION}`);
  if (!ENGINES.includes(rec.engine)) bad(`engine 非法: ${rec.engine}`);
  if (!isStr(rec.engineSessionId)) bad('engineSessionId 必须是字符串');
  if (!isStr(rec.path)) bad('path 必须是字符串');
  for (const k of ['startedAt', 'endedAt']) if (!isNumOrNull(rec[k])) bad(`${k} 必须是毫秒时间戳或 null`);
  for (const k of ['cwd', 'title']) if (!(rec[k] === null || isStr(rec[k]))) bad(`${k} 必须是字符串或 null`);
  if (!Array.isArray(rec.steps)) return problems.concat('steps 必须是数组');
  if (!Array.isArray(rec.warnings)) bad('warnings 必须是数组');
  if (typeof rec.truncated !== 'boolean') bad('truncated 必须是布尔');

  let turn = -1;
  let lastTurn = -1;
  rec.steps.forEach((s, i) => {
    const at = `steps[${i}]`;
    if (!s || typeof s !== 'object') return bad(`${at} 不是对象`);
    if (s.index !== i) bad(`${at}.index 应为 ${i}`);
    if (!STEP_KINDS.includes(s.kind)) return bad(`${at}.kind 非法: ${s.kind}`);
    if (!isNumOrNull(s.ts)) bad(`${at}.ts 必须是毫秒时间戳或 null`);
    if (!Number.isInteger(s.turn) || s.turn < 0) bad(`${at}.turn 必须是非负整数`);
    else {
      if (s.turn < lastTurn) bad(`${at}.turn 不得倒退`);
      lastTurn = s.turn;
    }
    if (s.kind === 'user') {
      turn += 1;
      if (!isStr(s.text)) bad(`${at}.text 必须是字符串`);
    } else if (s.kind === 'context') {
      if (!isStr(s.label) || !isStr(s.text)) bad(`${at} 需要 label 与 text 字符串`);
      if (!Number.isInteger(s.chars)) bad(`${at}.chars 必须是整数`);
    } else if (s.kind === 'assistant') {
      if (!isStr(s.model)) bad(`${at}.model 必须是字符串（未知用空串）`);
      if (!isStr(s.text)) bad(`${at}.text 必须是字符串`);
      for (const k of ['startTs', 'endTs', 'durationMs']) if (!isNumOrNull(s[k])) bad(`${at}.${k} 必须是数字或 null`);
      if (!s.usage || typeof s.usage !== 'object') bad(`${at}.usage 缺失`);
      else for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) if (!isNum(s.usage[k])) bad(`${at}.usage.${k} 必须是数字`);
      if (!(s.costUsd === undefined || isNumOrNull(s.costUsd))) bad(`${at}.costUsd 必须是数字或 null`);
      if (!Array.isArray(s.toolCallIds)) bad(`${at}.toolCallIds 必须是数组`);
    } else if (s.kind === 'tool') {
      if (!isStr(s.callId) || !isStr(s.name)) bad(`${at} 需要 callId 与 name`);
      if (!TOOL_STATUS.includes(s.status)) bad(`${at}.status 非法: ${s.status}`);
      if (!isStr(s.argsPreview)) bad(`${at}.argsPreview 必须是字符串`);
      if (!s.result || typeof s.result !== 'object' || !isStr(s.result.text) || typeof s.result.isError !== 'boolean') bad(`${at}.result 需要 { text, isError, truncated, chars }`);
      for (const k of ['startTs', 'endTs', 'durationMs']) if (!isNumOrNull(s[k])) bad(`${at}.${k} 必须是数字或 null`);
    } else if (s.kind === 'meta') {
      if (!META_KINDS.includes(s.metaKind)) bad(`${at}.metaKind 非法: ${s.metaKind}`);
      if (!isStr(s.text)) bad(`${at}.text 必须是字符串`);
    }
  });
  if (rec.steps.length && rec.stats && rec.stats.steps !== rec.steps.length) bad('stats.steps 与 steps.length 不一致');
  if (!rec.stats || typeof rec.stats !== 'object') bad('stats 缺失');
  return problems;
}

module.exports = { SCHEMA_VERSION, ENGINES, STEP_KINDS, META_KINDS, TOOL_STATUS, LIMITS, clip, preview, emptyUsage, emptySession, validateSession };
