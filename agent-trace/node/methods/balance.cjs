/**
 * methods/balance.cjs — 余额脚本分析与提取 RPC（契约见 SPEC.md 第 8 节）。
 *
 * 脚本是 CC Switch 的用量查询格式：({ request:{url,method,headers,body?}, extractor(response){...} })。
 * analyze 只回答「这段脚本要请求什么、密钥放在哪」；密钥永远不经过这里——哨兵字符串占位，
 * 真正的密钥由宿主按连接槽在代发请求时注入。
 */
'use strict';

const { SENTINEL, analyzeCode, extractCode, run } = require('../lib/script-sandbox.cjs');

const SCRIPT_MAX_BYTES = 6 * 1024;
const BODY_MAX_BYTES = 8 * 1024;
const MAX_ITEMS = 20;

const TEXT = {
  scriptEmpty: '请先粘贴或选择一段查询脚本',
  scriptTooLarge: '脚本太长了（上限 6KB），请精简后再试',
  baseUrlRequired: '这段脚本需要 Base URL，请填写供应商的接口地址',
  baseUrlInvalid: 'Base URL 无法识别，请填写形如 https://api.example.com 的地址',
  baseUrlNotHttps: '只支持 https 地址，Base URL 需要以 https:// 开头',
  userIdRequired: '这段脚本需要 User ID，请填写',
  userIdInvalid: 'User ID 只能包含字母、数字和 _ . @ : -，且不超过 64 个字符',
  syntax: (msg, line) => `脚本语法有问题${line ? `（第 ${line} 行）` : ''}：${msg}`,
  timeout: '脚本执行超时（超过 1 秒），请检查是否有死循环',
  scriptError: (msg) => `脚本运行出错：${msg}`,
  extractorError: (msg) => `extractor 运行出错：${msg}`,
  noRequest: '脚本里没有找到 request 对象，应形如 ({ request: {...}, extractor: function(response){...} })',
  noExtractor: '脚本里没有找到 extractor 函数，应形如 ({ request: {...}, extractor: function(response){...} })',
  urlNotString: 'request.url 不是文本，请检查脚本',
  urlInvalid: (url) => `request.url 不是完整的网址：${url}`,
  urlNotHttps: '当前版本只支持 https 地址，脚本里的请求地址不是 https',
  urlPort: '当前版本只支持 https 默认端口（443），脚本里的请求地址带了自定义端口',
  urlUserinfo: '请求地址里不能带用户名或密码',
  urlHost: '请求地址需要是域名（不支持 IP 地址或没有点号的主机名）',
  methodUnsupported: (m) => `当前版本只支持 GET 和 POST 请求，脚本用的是 ${m}`,
  headersInvalid: '脚本里 request.headers 的格式不对，应是 { "名称": "值" }',
  headerCrlf: '请求头里不能包含换行',
  bodyTooLarge: '请求体太大（上限 8KB）',
  noSecret: '这段脚本没有使用 {{apiKey}} 或 {{accessToken}}。当前版本只支持需要密钥的查询接口，密钥要放在 Authorization: Bearer 或 x-api-key 头里',
  placement: '当前版本只支持密钥放在 Authorization: Bearer 或 x-api-key 头里（且只出现一次），不支持放在地址、请求体或其他位置',
  badJson: '供应商返回的内容不是 JSON，无法解析',
  badResult: 'extractor 应该返回一个对象或对象数组，但它返回了别的类型',
  noResult: 'extractor 没有返回任何内容',
  warnUnknownPlaceholder: (name) => `脚本里有不认识的占位符 ${name}，不会被替换`,
  warnHeaderIgnored: (name) => `请求头 ${name} 由系统管理，脚本里写的值会被忽略`,
  warnHeaderBad: (name) => `请求头名称不合法，已忽略：${name}`,
  warnBodyDropped: 'GET 请求不能带请求体，已忽略脚本里的 body',
  warnNoFields: 'extractor 没有返回余额相关字段（remaining / total / used），界面只能显示有效状态',
};

function fail(code, message, extra) {
  return Object.assign({ ok: false, code, message }, extra || {});
}

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;
const KNOWN = new Set(['apikey', 'accesstoken', 'baseurl', 'userid']);

function scanPlaceholders(script) {
  const found = { secret: false, baseUrl: false, userId: false, unknown: [] };
  for (const m of script.matchAll(PLACEHOLDER)) {
    const key = m[1].toLowerCase();
    if (key === 'apikey' || key === 'accesstoken') found.secret = true;
    else if (key === 'baseurl') found.baseUrl = true;
    else if (key === 'userid') found.userId = true;
    else if (!KNOWN.has(key)) found.unknown.push(m[0]);
  }
  return found;
}

/** 校验并整理入参；失败返回 { error }。baseUrl 会被拼进脚本文本，所以字符要收紧，避免跳出字符串。 */
function prepare(params) {
  const script = typeof params.script === 'string' ? params.script : '';
  if (!script.trim()) return { error: fail('SCRIPT_EMPTY', TEXT.scriptEmpty) };
  if (Buffer.byteLength(script, 'utf8') > SCRIPT_MAX_BYTES) return { error: fail('SCRIPT_TOO_LARGE', TEXT.scriptTooLarge) };

  const need = scanPlaceholders(script);
  const flags = { needsBaseUrl: need.baseUrl, needsUserId: need.userId };
  let baseUrl = typeof params.baseUrl === 'string' ? params.baseUrl.trim() : '';
  let userId = params.userId === undefined || params.userId === null ? '' : String(params.userId).trim();

  if (need.baseUrl) {
    if (!baseUrl) return { error: fail('BASE_URL_REQUIRED', TEXT.baseUrlRequired, flags) };
    if (baseUrl.length > 300 || /[\s"'`\\<>{}$]/.test(baseUrl)) return { error: fail('INVALID_BASE_URL', TEXT.baseUrlInvalid, flags) };
    let u;
    try { u = new URL(baseUrl); } catch { return { error: fail('INVALID_BASE_URL', TEXT.baseUrlInvalid, flags) }; }
    if (u.protocol !== 'https:') return { error: fail('UNSUPPORTED_URL', TEXT.baseUrlNotHttps, flags) };
  } else baseUrl = '';

  if (need.userId) {
    if (!userId) return { error: fail('USER_ID_REQUIRED', TEXT.userIdRequired, flags) };
    if (!/^[A-Za-z0-9_.@:-]{1,64}$/.test(userId)) return { error: fail('INVALID_USER_ID', TEXT.userIdInvalid, flags) };
  } else userId = '';

  const text = script.replace(PLACEHOLDER, (whole, name) => {
    switch (name.toLowerCase()) {
      case 'apikey':
      case 'accesstoken': return SENTINEL;
      case 'baseurl': return baseUrl;
      case 'userid': return userId;
      default: return whole;
    }
  });
  return { text, flags, unknown: need.unknown };
}

function outcomeError(outcome, flags) {
  if (outcome.kind === 'syntax') return fail('SCRIPT_SYNTAX', TEXT.syntax(outcome.message, outcome.line), flags);
  if (outcome.kind === 'timeout') return fail('SCRIPT_TIMEOUT', TEXT.timeout, flags);
  return fail('SCRIPT_ERROR', TEXT.scriptError(outcome.message), flags);
}

function parseJson(json) {
  try { return JSON.parse(json); } catch { return null; }
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
/** 这些头由宿主或网络层管理：密钥头由宿主注入，其余写了也不生效，统一剔除。 */
const MANAGED_HEADERS = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'cookie', 'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'keep-alive']);

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function analyzeRequest(raw, flags, unknown) {
  const warnings = unknown.map(TEXT.warnUnknownPlaceholder);
  if (!raw.request) return fail('SCRIPT_INVALID', TEXT.noRequest, flags);
  if (!raw.hasExtractor) return fail('SCRIPT_INVALID', TEXT.noExtractor, flags);
  const rq = raw.request;
  if (typeof rq.url !== 'string') return fail('SCRIPT_INVALID', TEXT.urlNotString, flags);

  const method = String(rq.method === undefined || rq.method === null ? 'GET' : rq.method).toUpperCase();
  if (method !== 'GET' && method !== 'POST') return fail('UNSUPPORTED_METHOD', TEXT.methodUnsupported(method.slice(0, 16)), flags);

  let url;
  try { url = new URL(rq.url); } catch { return fail('INVALID_URL', TEXT.urlInvalid(rq.url.slice(0, 120)), flags); }
  if (url.protocol !== 'https:') return fail('UNSUPPORTED_URL', TEXT.urlNotHttps, flags);
  if (url.port) return fail('UNSUPPORTED_URL', TEXT.urlPort, flags);
  if (url.username || url.password) return fail('UNSUPPORTED_URL', TEXT.urlUserinfo, flags);
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || !/^[a-z0-9.-]+$/.test(host) || /^\d+(\.\d+){3}$/.test(host)) return fail('UNSUPPORTED_URL', TEXT.urlHost, flags);
  if (rq.url.length > 2048) return fail('INVALID_URL', TEXT.urlInvalid(rq.url.slice(0, 120)), flags);

  let headersIn = rq.headers;
  if (headersIn === undefined || headersIn === null) headersIn = {};
  if (typeof headersIn !== 'object' || Array.isArray(headersIn)) return fail('SCRIPT_INVALID', TEXT.headersInvalid, flags);
  const headers = [];
  for (const [name, value] of Object.entries(headersIn)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') return fail('SCRIPT_INVALID', TEXT.headersInvalid, flags);
    headers.push([String(name), String(value)]);
  }
  if (headers.length > 24) return fail('SCRIPT_INVALID', TEXT.headersInvalid, flags);

  let body;
  if (rq.body !== undefined && rq.body !== null) {
    body = typeof rq.body === 'string' ? rq.body : JSON.stringify(rq.body);
    if (typeof body === 'string' && typeof rq.body !== 'string' && !headers.some(([n]) => n.toLowerCase() === 'content-type')) headers.push(['Content-Type', 'application/json']);
    if (Buffer.byteLength(body, 'utf8') > BODY_MAX_BYTES) return fail('SCRIPT_INVALID', TEXT.bodyTooLarge, flags);
    if (method === 'GET') { body = undefined; warnings.push(TEXT.warnBodyDropped); }
  }

  // 密钥位置：哨兵出现的每个地方都要数清楚
  const urlHits = count(rq.url, SENTINEL);
  const bodyHits = body === undefined ? 0 : count(body, SENTINEL);
  const sentinelHeaders = headers.filter(([n, v]) => n.includes(SENTINEL) || v.includes(SENTINEL));
  const headerHits = sentinelHeaders.reduce((sum, [n, v]) => sum + count(n, SENTINEL) + count(v, SENTINEL), 0);
  const total = urlHits + bodyHits + headerHits;
  if (total === 0) return fail('NO_SECRET', TEXT.noSecret, flags);

  let slot = null;
  if (urlHits === 0 && bodyHits === 0 && sentinelHeaders.length === 1 && headerHits === 1) {
    const [name, value] = sentinelHeaders[0];
    const lower = name.toLowerCase();
    if (lower === 'authorization' && value.replace(/^bearer\s+/i, '') === SENTINEL && /^bearer\s+/i.test(value)) slot = 'bearer';
    else if (lower === 'x-api-key' && value === SENTINEL) slot = 'apikey';
  }
  if (!slot) return fail('UNSUPPORTED_SECRET_PLACEMENT', TEXT.placement, flags);

  const kept = [];
  for (const [name, value] of headers) {
    if (name.includes(SENTINEL) || value.includes(SENTINEL)) continue;
    if (!HEADER_NAME.test(name)) { warnings.push(TEXT.warnHeaderBad(name.slice(0, 40))); continue; }
    if (/[\r\n]/.test(value)) return fail('SCRIPT_INVALID', TEXT.headerCrlf, flags);
    if (MANAGED_HEADERS.has(name.toLowerCase())) { warnings.push(TEXT.warnHeaderIgnored(name)); continue; }
    kept.push([name, value]);
  }

  const request = { url: url.href, method, headers: Object.fromEntries(kept) };
  if (body !== undefined) request.body = body;
  return { ok: true, request, host, slot, ...flags, warnings };
}

async function analyze(params) {
  const prep = prepare(params || {});
  if (prep.error) return prep.error;
  const outcome = await run({ code: analyzeCode(prep.text) });
  if (outcome.kind !== 'ok') return outcomeError(outcome, prep.flags);
  const raw = parseJson(outcome.json);
  if (!raw) return fail('SCRIPT_ERROR', TEXT.scriptError('unknown'), prep.flags);
  if (raw.ok === false) return fail('SCRIPT_ERROR', TEXT.scriptError(String(raw.message || 'unknown')), prep.flags);
  return analyzeRequest(raw, prep.flags, prep.unknown);
}

// ---- extract ----

function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().replace(/^([-+]?)\s*[$¥￥€£]\s*/, '$1');
  if (!/^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(s) || !/\d/.test(s)) return undefined;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function toText(v, max) {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const s = String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
}

function tidy(n) {
  // 去掉 0.1+0.2 这类浮点尾巴，但保留小额度的有效位数
  return Math.abs(n) < 1e15 ? Number(n.toPrecision(12)) : n;
}

function normalizeItem(src) {
  const item = {};
  const v = src.isValid;
  item.isValid = typeof v === 'boolean' ? v : !(v === 0 || v === 'false' || v === '0');
  const invalidMessage = toText(src.invalidMessage, 200);
  if (invalidMessage) item.invalidMessage = invalidMessage;
  const planName = toText(src.planName, 80);
  if (planName) item.planName = planName;
  for (const key of ['remaining', 'total', 'used']) {
    const n = toNumber(src[key]);
    if (n !== undefined) item[key] = tidy(n);
  }
  const unit = toText(src.unit, 24);
  if (unit) item.unit = unit;
  const extra = toText(src.extra, 300);
  if (extra) item.extra = extra;
  return item;
}

async function extract(params) {
  const p = params || {};
  const prep = prepare(p);
  if (prep.error) return prep.error;
  const responseText = typeof p.responseText === 'string' ? p.responseText : '';
  try { JSON.parse(responseText); } catch {
    // kind 让调用方能区分「返回了网页」与普通文本，提示更具体
    const kind = !responseText.trim() ? 'empty' : /^\s*(<!doctype|<html|<head|<body)/i.test(responseText) ? 'html' : 'text';
    return fail('RESPONSE_NOT_JSON', TEXT.badJson, { kind });
  }

  const outcome = await run({ code: extractCode(prep.text), respText: responseText });
  if (outcome.kind !== 'ok') return outcomeError(outcome, prep.flags);
  const raw = parseJson(outcome.json);
  if (!raw) return fail('SCRIPT_ERROR', TEXT.scriptError('unknown'));
  if (raw.ok === false) {
    const msg = String(raw.message || 'unknown');
    return raw.phase === 1 ? fail('EXTRACTOR_ERROR', TEXT.extractorError(msg)) : fail('SCRIPT_ERROR', TEXT.scriptError(msg));
  }

  const value = raw.value;
  if (value === null || value === undefined) return fail('EXTRACT_EMPTY', TEXT.noResult);
  const list = Array.isArray(value) ? value : [value];
  const items = [];
  for (const entry of list.slice(0, MAX_ITEMS)) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) items.push(normalizeItem(entry));
  }
  if (!items.length) return fail('EXTRACT_BAD_RESULT', TEXT.badResult);

  const warnings = [];
  if (!items.some((it) => it.remaining !== undefined || it.total !== undefined || it.used !== undefined || it.extra !== undefined)) warnings.push(TEXT.warnNoFields);
  return { ok: true, items, warnings };
}

module.exports = { 'balance/analyze': analyze, 'balance/extract': extract };
