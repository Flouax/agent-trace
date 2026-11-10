/**
 * lib/discover.cjs — 把 Cindy 的任务 id 映射到转录文件（SPEC 第 7 节），以及三引擎合并列表。
 *
 * 四层降级，返回 via：db（精确）→ dirname（精确）→ firstmsg（精确）→ latest（不精确）。
 * Cindy 数据库的 sessions 表是内部结构、随时可能变：任何失败都安静降级，只读指定的六列。
 * 数据目录可用 AGENT_TRACE_CINDY_DATA_DIR 覆盖（测试用）；CLAUDE_CONFIG_DIR / CODEX_HOME / AGENT_TRACE_PI_ROOTS 由各适配器自己读取。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const registry = require('../adapters/index.cjs');

const TEXT = {
  noSessionId: '没有提供任务 id',
  noAdapters: '本机没有找到任何可读取的引擎转录',
  noMatch: '没有找到与该任务对应的转录',
};

const MIN_ID_LEN = 8; // 太短的 id 在路径里会误匹配
const FIRSTMSG_BYTES = 64 * 1024;
const FIRSTMSG_SCAN = 300; // 逐个读头部，只看最新的这些
const PATH_SCAN = 5000;
const DB_COLUMNS_SQL = 'SELECT id, agent_kind, sdk_session_id, working_dir, title, updated_at FROM sessions WHERE id = ?';

// ---------- Cindy 数据库 ----------

function cindyDataDir() {
  const env = process.env.AGENT_TRACE_CINDY_DATA_DIR;
  if (env && env.trim()) return env.trim();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Cindy');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Cindy');
  return path.join(os.homedir(), '.config', 'Cindy');
}

/** cindy-<owner>.db：排除 .bak / -wal / -shm / .json / .lock.db 等，多个取最新。 */
function findDbFile(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  let best = null;
  for (const n of names) {
    if (!/^cindy-[A-Za-z0-9_-]+\.db$/.test(n)) continue;
    const p = path.join(dir, n);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && (!best || st.mtimeMs > best.m)) best = { p, m: st.mtimeMs };
    } catch { /* 刚被删 */ }
  }
  return best ? best.p : null;
}

const stats = { directReads: 0, copyReads: 0 }; // 仅供测试观察走了哪条读取路径
let sqlite;
function loadSqlite() {
  if (sqlite !== undefined) return sqlite;
  try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
  return sqlite;
}

function selectRow(dbPath, id) {
  const sq = loadSqlite();
  if (!sq) throw new Error('node:sqlite 不可用');
  const db = new sq.DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(DB_COLUMNS_SQL).get(id) || null;
  } finally {
    try { db.close(); } catch { /* 忽略 */ }
  }
}

// 副本缓存：库在被写入时直接只读打开可能失败，复制 db / -wal / -shm 到临时目录再读
const COPY_PREFIX = 'agent-trace-db-';
let copyCache = null; // { key, dir, file }
let sweptStale = false;

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

function sweepStaleCopies() {
  if (sweptStale) return;
  sweptStale = true;
  try {
    const tmp = os.tmpdir();
    for (const n of fs.readdirSync(tmp)) {
      if (!n.startsWith(COPY_PREFIX)) continue;
      const p = path.join(tmp, n);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > 60 * 60 * 1000) rmDir(p); // 崩溃遗留（超过 1 小时）
      } catch { /* 忽略 */ }
    }
  } catch { /* 忽略 */ }
}

function mtimeKey(p) {
  try { const st = fs.statSync(p); return `${st.mtimeMs}:${st.size}`; } catch { return '-'; }
}

function ensureCopy(dbPath) {
  const key = [dbPath, mtimeKey(dbPath), mtimeKey(dbPath + '-wal'), mtimeKey(dbPath + '-shm')].join('|');
  if (copyCache && copyCache.key === key && fs.existsSync(copyCache.file)) return copyCache.file;
  cleanupCopies();
  sweepStaleCopies();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), COPY_PREFIX));
  const file = path.join(dir, path.basename(dbPath));
  try {
    fs.copyFileSync(dbPath, file);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, file + suffix);
    }
  } catch (err) {
    rmDir(dir);
    throw err;
  }
  copyCache = { key, dir, file };
  return file;
}

function cleanupCopies() {
  if (copyCache) rmDir(copyCache.dir);
  copyCache = null;
}
process.on('exit', cleanupCopies);

/** 返回 sessions 行或 null；任何失败都返回 null。 */
function lookupRow(sessionId) {
  try {
    const dbPath = findDbFile(cindyDataDir());
    if (!dbPath) return null;
    try {
      const r = selectRow(dbPath, sessionId);
      stats.directReads += 1;
      return r;
    } catch {
      const r = selectRow(ensureCopy(dbPath), sessionId);
      stats.copyReads += 1;
      return r;
    }
  } catch {
    return null;
  }
}

// ---------- 候选文件 ----------

function mergeLists(opts) {
  const rows = [];
  for (const ad of registry.all()) {
    let part = [];
    try { part = ad.list(opts) || []; } catch (err) { process.stderr.write(`[agent-trace] ${ad.engine}.list 失败: ${err && err.message}\n`); }
    for (const r of part) rows.push({ engine: ad.engine, path: r.path, id: r.id, cwd: r.cwd == null ? null : r.cwd, title: r.title == null ? null : r.title, mtime: r.mtime, size: r.size });
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows;
}

function readHead(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* 忽略 */ }
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function pick(matches) {
  return { best: matches[0], candidates: matches.length }; // 已按 mtime 倒序
}

function resolveSession({ sessionId } = {}) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return { path: null, engine: null, via: 'none', exact: false, reason: TEXT.noSessionId };

  // 1. db
  let row = null;
  const dbRow = lookupRow(id);
  if (dbRow) {
    row = { title: dbRow.title == null ? null : String(dbRow.title), workingDir: dbRow.working_dir == null ? null : String(dbRow.working_dir), updatedAt: dbRow.updated_at == null ? null : dbRow.updated_at };
    const ad = registry.get(String(dbRow.agent_kind || ''));
    const sdkId = dbRow.sdk_session_id;
    if (ad && typeof ad.findByEngineSessionId === 'function' && typeof sdkId === 'string' && sdkId) {
      let file = null;
      try { file = ad.findByEngineSessionId(sdkId); } catch { file = null; }
      if (file) return { path: file, engine: ad.engine, via: 'db', exact: true, row };
    }
  }
  const withRow = (res) => (row ? { ...res, row } : res);

  if (registry.all().length === 0) return withRow({ path: null, engine: null, via: 'none', exact: false, reason: TEXT.noAdapters });

  // 2. dirname：路径（cc 的编码目录名）含任务 id；其他引擎看文件内 cwd
  if (id.length >= MIN_ID_LEN) {
    const encoded = id.replace(/[^A-Za-z0-9]/g, '-');
    const light = mergeLists({ limit: PATH_SCAN, light: true });
    let hits = light.filter((r) => r.path.includes(id) || r.path.includes(encoded));
    if (!hits.length) {
      hits = mergeLists({ limit: 200 }).filter((r) => r.cwd && (r.cwd.includes(id) || r.cwd.includes(encoded)));
    }
    if (hits.length) {
      const { best, candidates } = pick(hits);
      const res = { path: best.path, engine: best.engine, via: 'dirname', exact: true };
      if (candidates > 1) res.candidates = candidates;
      return withRow(res);
    }

    // 3. firstmsg：前 64KB 里有「任务 ID： <id>」
    const re = new RegExp(`任务\\s*ID\\s*[：:]\\s*${escapeRe(id)}(?![A-Za-z0-9-])`);
    const hits3 = [];
    for (const r of mergeLists({ limit: FIRSTMSG_SCAN, light: true }).slice(0, FIRSTMSG_SCAN)) {
      if (re.test(readHead(r.path, FIRSTMSG_BYTES))) hits3.push(r);
    }
    if (hits3.length) {
      const { best, candidates } = pick(hits3);
      const res = { path: best.path, engine: best.engine, via: 'firstmsg', exact: true };
      if (candidates > 1) res.candidates = candidates;
      return withRow(res);
    }
  }

  // 4. latest
  const latest = mergeLists({ limit: 1, light: true })[0];
  if (latest) return withRow({ path: latest.path, engine: latest.engine, via: 'latest', exact: false, reason: TEXT.noMatch });
  return withRow({ path: null, engine: null, via: 'none', exact: false, reason: TEXT.noMatch });
}

function listAllSessions({ limit, query } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 60, 500));
  const q = typeof query === 'string' ? query.trim() : '';
  const rows = mergeLists({ limit: Math.max(lim, 500), query: q });
  return { sessions: rows.slice(0, lim), total: rows.length };
}

module.exports = { resolveSession, listAllSessions, cindyDataDir, findDbFile, cleanupCopies, _test: { ensureCopy, selectRow, stats, copyDir: () => (copyCache ? copyCache.dir : null) } };
