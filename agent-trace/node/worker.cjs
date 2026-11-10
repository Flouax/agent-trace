/**
 * node/worker.cjs — 轨迹与余额的本机服务（逐行 JSON-RPC 2.0）。
 *
 * 只做分发：node/methods/*.cjs 每个文件导出 { '方法名': (params, ctx) => result }，启动时自动合并。
 * stdout 只能写协议消息，日志一律写 stderr。单行响应不得超过 MAX_LINE 字节（宿主上限 1MB）。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const MAX_LINE = 900000;
const methods = Object.create(null);

methods.ping = () => ({ ok: true, pid: process.pid, node: process.version, methods: Object.keys(methods).sort() });

function loadMethodModules() {
  const dir = path.join(__dirname, 'methods');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.cjs')).sort();
  } catch {
    return;
  }
  for (const file of files) {
    try {
      const mod = require(path.join(dir, file));
      for (const [name, fn] of Object.entries(mod)) {
        if (typeof fn === 'function') methods[name] = fn;
      }
    } catch (err) {
      process.stderr.write(`[agent-trace] 加载 methods/${file} 失败: ${err && err.stack ? err.stack : err}\n`);
    }
  }
}

function send(message) {
  let line = JSON.stringify(message);
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE) {
    line = JSON.stringify({
      jsonrpc: '2.0',
      id: message.id === undefined ? null : message.id,
      error: { code: -32000, message: '响应过大，请缩小范围后重试', data: { code: 'RESPONSE_TOO_LARGE' } },
    });
  }
  process.stdout.write(line + '\n');
}

async function handle(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const id = request.id === undefined ? null : request.id;
  const fn = methods[request.method];
  if (!fn) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  try {
    const result = await fn(request.params || {}, { locale: (request.params && request.params._locale) || 'zh-CN' });
    send({ jsonrpc: '2.0', id, result: result === undefined ? null : result });
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: (err && err.message) || '内部错误',
        data: { code: (err && err.code) || 'INTERNAL' },
      },
    });
  }
}

loadMethodModules();
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim()) handle(line);
});
process.on('uncaughtException', (err) => process.stderr.write(`[agent-trace] uncaught: ${err && err.stack}\n`));
process.on('unhandledRejection', (err) => process.stderr.write(`[agent-trace] unhandled: ${err && err.stack ? err.stack : err}\n`));
