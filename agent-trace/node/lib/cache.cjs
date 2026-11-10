/**
 * lib/cache.cjs — 解析结果缓存：键 = path + size + mtimeMs，最多 8 条，LRU。
 *
 * 会话进行中文件会增长，键一变就整份重新解析（没有做增量解析：全量解析 5MB 在百毫秒级，
 * 增量要处理「末行写到一半」「压缩改写历史」等边界，收益小风险大）。
 * 另限制缓存里文件体积之和，避免 8 份几十 MB 的转录同时驻留。
 */

'use strict';

const fs = require('node:fs');

const MAX_ENTRIES = 8;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const entries = new Map(); // key → { value, size }

function keyOf(file, st) {
  return `${file}\u0000${st.size}\u0000${st.mtimeMs}`;
}

/** 取得 file 的解析结果；parseFn(file) 只在未命中时调用。 */
function getParsed(file, parseFn) {
  const st = fs.statSync(file);
  const key = keyOf(file, st);
  const hit = entries.get(key);
  if (hit) {
    entries.delete(key);
    entries.set(key, hit); // 刷新为最近使用
    return hit.value;
  }
  // 同一路径的旧版本没用了，先清掉
  for (const k of [...entries.keys()]) if (k.startsWith(file + '\u0000')) entries.delete(k);
  const value = parseFn(file);
  entries.set(key, { value, size: st.size });
  let total = 0;
  for (const e of entries.values()) total += e.size;
  while (entries.size > MAX_ENTRIES || (total > MAX_TOTAL_BYTES && entries.size > 1)) {
    const oldest = entries.keys().next().value;
    total -= entries.get(oldest).size;
    entries.delete(oldest);
  }
  return value;
}

function clear() {
  entries.clear();
}

function size() {
  return entries.size;
}

module.exports = { getParsed, clear, size, MAX_ENTRIES };
