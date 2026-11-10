/**
 * adapters/index.cjs — 引擎适配器注册表。
 *
 * 按需加载 cc / pi / codex：模块不存在或加载失败就安静跳过（pi、codex 由别的任务加入，文件名固定）。
 * 不在模块顶层缓存「加载失败」，以免适配器稍后才出现时进程里一直看不到；成功的才缓存。
 */

'use strict';

const ENGINE_FILES = ['cc', 'pi', 'codex'];
const loaded = new Map();

function load(engine) {
  if (loaded.has(engine)) return loaded.get(engine);
  let mod = null;
  try {
    mod = require(`./${engine}.cjs`);
    if (!mod || typeof mod.parse !== 'function' || typeof mod.roots !== 'function') mod = null;
  } catch (err) {
    // 文件不存在是正常情况（适配器还没接入）；其他加载错误只写 stderr
    if (!err || err.code !== 'MODULE_NOT_FOUND') process.stderr.write(`[agent-trace] 适配器 ${engine} 加载失败: ${err && err.message}\n`);
    mod = null;
  }
  if (mod) loaded.set(engine, mod);
  return mod;
}

/** 已注册的适配器，按 cc → pi → codex 顺序。 */
function all() {
  return ENGINE_FILES.map(load).filter(Boolean);
}

function get(engine) {
  return ENGINE_FILES.includes(engine) ? load(engine) : null;
}

module.exports = { all, get, ENGINE_FILES };
