/**
 * script-sandbox.cjs — 执行用户粘贴的用量查询脚本（CC Switch 格式）。
 *
 * node:vm 不是安全边界，所以分三层加固，且这里根本没有供应商密钥（密钥只在宿主保险库）：
 * 1) 上下文：每次新建，禁用 eval/new Function/wasm，带超时与 microtaskMode；
 * 2) 跨界只传字符串：脚本文本、响应 JSON 文本进去，结果 JSON 字符串出来。外部对象和函数绝不进入上下文
 *    （否则 x.constructor.constructor 可以拿到外部 Function）；上下文里抛出的错误也只在上下文内读取 message；
 * 3) 默认放进一个资源受限的 worker_threads 线程里跑：死循环以外的内存炸弹只会弄死线程，不会拖垮工作进程。
 *    线程起不来时退回当前线程执行（vm 加固仍在）。
 */
'use strict';

const vm = require('node:vm');
const util = require('node:util');

let wt = null;
try { wt = require('node:worker_threads'); } catch { /* 极简运行时没有线程就退回当前线程 */ }

const SENTINEL = '__CINDY_SECRET_SLOT__';
const VM_TIMEOUT_MS = 800;
const HARD_KILL_MS = 3000;
const MAX_RESULT_CHARS = 64 * 1024;

const TEXT = {
  badOutput: '脚本没有返回可用的结果',
  tooLarge: '脚本的返回内容过大（超过 64KB）',
  memory: '脚本占用的内存过多，已被终止',
  crashed: '脚本执行线程异常退出',
};

/** 用户脚本放在第 2 行起，所以行号要整体上移 1 才和用户看到的对得上。 */
const LINE_OFFSET = 1;
const PRELUDE =
  'var __out,__ph=0;' +
  'function __em(e){try{return String(e&&e.message!==undefined?e.message:e).slice(0,300)}catch(_){return"unknown"}}' +
  'var console={log:function(){},info:function(){},warn:function(){},error:function(){},debug:function(){}};';

/** 脚本是「一个表达式」：去掉末尾分号与空白，前后补行，行尾注释也不会吃掉右括号。 */
function embed(text) {
  const body = String(text).replace(/^﻿/, '').replace(/[;\s]+$/, '');
  return `${PRELUDE}try{var __cfg=(\n${body}\n);`;
}

function analyzeCode(text) {
  return (
    embed(text) +
    'var __rq=__cfg&&__cfg.request;' +
    '__out=JSON.stringify({ok:true,request:(__rq&&typeof __rq==="object")?__rq:null,hasExtractor:!!__cfg&&typeof __cfg.extractor==="function"});' +
    '}catch(e){__out=JSON.stringify({ok:false,phase:__ph,message:__em(e)})}\n__out'
  );
}

function extractCode(text) {
  return (
    embed(text) +
    'if(!__cfg||typeof __cfg.extractor!=="function")throw new Error("缺少 extractor 函数");' +
    '__ph=1;var __r=__cfg.extractor(JSON.parse(__respText));' +
    'if(__r&&typeof __r.then==="function"){__out=JSON.stringify({ok:false,phase:1,message:"extractor 不能是异步函数（不要用 async / Promise）"})}' +
    'else{var __s=JSON.stringify(__r===undefined?null:__r);__out="{\\"ok\\":true,\\"value\\":"+(__s===undefined?"null":__s)+"}"}' +
    '}catch(e){__out=JSON.stringify({ok:false,phase:__ph,message:__em(e)})}\n__out'
  );
}

/** 只读 message 的数据属性，不触发任何 getter（上下文里抛出的对象可能带恶意 getter）。 */
function safeMessage(err) {
  try {
    if (util.types.isNativeError(err)) {
      const d = Object.getOwnPropertyDescriptor(err, 'message');
      if (d && typeof d.value === 'string') return d.value.slice(0, 300);
    }
  } catch { /* 忽略 */ }
  return 'unknown';
}

function syntaxOutcome(err) {
  const line = /usage-script\.js:(\d+)/.exec(String((err && err.stack) || ''));
  return { kind: 'syntax', message: safeMessage(err), line: line ? Number(line[1]) : null };
}

/** 同步执行（工作线程与退路共用）。返回值只含基本类型。 */
function execute(job) {
  let script;
  try {
    script = new vm.Script(job.code, { filename: 'usage-script.js', lineOffset: -LINE_OFFSET });
  } catch (err) {
    return syntaxOutcome(err);
  }
  const sandbox = Object.create(null);
  if (typeof job.respText === 'string') sandbox.__respText = job.respText;
  const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  try {
    const out = script.runInContext(ctx, { timeout: VM_TIMEOUT_MS });
    if (typeof out !== 'string') return { kind: 'error', message: TEXT.badOutput };
    if (out.length > MAX_RESULT_CHARS) return { kind: 'error', message: TEXT.tooLarge };
    return { kind: 'ok', json: out };
  } catch (err) {
    if (err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return { kind: 'timeout' };
    return { kind: 'error', message: safeMessage(err) };
  }
}

function runInThread(job) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new wt.Worker(__filename, {
        workerData: { __sandboxJob: true, code: job.code, respText: job.respText },
        env: {},
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, codeRangeSizeMb: 16, stackSizeMb: 4 },
      });
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }), HARD_KILL_MS);
    worker.once('message', finish);
    worker.once('error', (err) => {
      // 线程根本没能启动（而不是脚本把它弄死）：交给调用方退回当前线程
      if (err && /^ERR_WORKER_(INIT_FAILED|PATH|UNSUPPORTED)/.test(err.code || '') && !settled) { settled = true; clearTimeout(timer); reject(err); return; }
      finish({ kind: 'error', message: err && err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? TEXT.memory : TEXT.crashed });
    });
    worker.once('exit', () => finish({ kind: 'error', message: TEXT.crashed }));
  });
}

/** job: { code, respText? } → { kind:'ok', json } | { kind:'syntax', message, line } | { kind:'timeout' } | { kind:'error', message } */
async function run(job, opts) {
  if (!wt || (opts && opts.inline)) return execute(job);
  try {
    return await runInThread(job);
  } catch {
    return execute(job);
  }
}

module.exports = { SENTINEL, analyzeCode, extractCode, run, execute };

// 作为线程入口被 new Worker(__filename) 拉起时：干完活回一条消息就结束。
if (wt && !wt.isMainThread && wt.workerData && wt.workerData.__sandboxJob) {
  wt.parentPort.postMessage(execute(wt.workerData));
}
