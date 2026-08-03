import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { buildFingerprint } from './cache.js';

const RP_TTL_MS = 60 * 60_000;
const CACHE_LIMIT_BYTES = 512 * 1024 * 1024;
const db = new DatabaseSync(workerData.databasePath);
const ttlMs = Number(workerData.ttlMs);
const masterKey = Buffer.from(workerData.masterKey);
const queue = [];
const pending = new Map();
const pendingRp = new Map();
let version = 0;
let lastMaintenance = 0;

db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
let rpEnabled = db.prepare("SELECT value FROM cache_settings WHERE key='rp_enabled'").get()?.value === '1';

const lookupStatement = db.prepare(`
  SELECT c.hash, c.weight, COALESCE(t.tokens, 0) observed_tokens
  FROM prompt_cache c
  LEFT JOIN prompt_cache_tokens t ON t.hash=c.hash AND t.model=?
  WHERE c.endpoint=? AND c.expires_at>? AND c.hash IN (SELECT value FROM json_each(?))
`);
const rpLookupStatement = db.prepare(`
  SELECT hash, weight, copies FROM prompt_cache_rp
  WHERE endpoint=? AND expires_at>? AND hash IN (SELECT value FROM json_each(?))
`);
const cacheStatement = db.prepare(`
  INSERT INTO prompt_cache(hash, endpoint, weight, expires_at, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(hash) DO UPDATE SET weight=excluded.weight, expires_at=excluded.expires_at, updated_at=excluded.updated_at
`);
const rpCacheStatement = db.prepare(`
  INSERT INTO prompt_cache_rp(hash, endpoint, weight, copies, expires_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(hash) DO UPDATE SET weight=excluded.weight, copies=MAX(prompt_cache_rp.copies, excluded.copies),
    expires_at=excluded.expires_at, updated_at=excluded.updated_at
`);
const tokenStatement = db.prepare(`
  INSERT INTO prompt_cache_tokens(hash, model, tokens) VALUES (?, ?, ?)
  ON CONFLICT(hash, model) DO UPDATE SET tokens=excluded.tokens
`);
const deleteExpiredStatement = db.prepare('DELETE FROM prompt_cache WHERE expires_at<=?');
const deleteExpiredRpStatement = db.prepare('DELETE FROM prompt_cache_rp WHERE expires_at<=?');
const deletePrefixStatement = db.prepare('DELETE FROM prompt_cache WHERE hash=?');
const deleteRpStatement = db.prepare('DELETE FROM prompt_cache_rp WHERE hash=?');
const storageStatement = db.prepare(`
  SELECT COALESCE(SUM(pgsize), 0) indexed_bytes FROM dbstat
  WHERE name GLOB 'prompt_cache*' OR name GLOB 'idx_cache*' OR name GLOB 'sqlite_autoindex_prompt_cache*'
`);
const oldestStatement = db.prepare(`
  SELECT kind, hash FROM (
    SELECT 'prefix' kind, hash, updated_at FROM prompt_cache
    UNION ALL
    SELECT 'rp' kind, hash, updated_at FROM prompt_cache_rp
  ) ORDER BY updated_at LIMIT 5000
`);

const miss = () => ({ matched: false, exact: false, type: '', weight: 0, observedTokens: 0 });
const cacheKey = (endpoint, hash) => `${endpoint}\u001f${hash}`;
const chunkCounts = (chunks = []) => {
  const counts = new Map();
  for (const chunk of chunks) {
    const current = counts.get(chunk.hash);
    if (current) current.copies += 1;
    else counts.set(chunk.hash, { ...chunk, copies: 1 });
  }
  return counts;
};

function prefixLookup(fingerprint, model, stamp) {
  if (!fingerprint.entries.length) return miss();
  const rows = lookupStatement.all(
    model || '', fingerprint.endpoint, stamp, JSON.stringify(fingerprint.entries.map((entry) => entry.hash)),
  );
  const persisted = new Map(rows.map((row) => [row.hash, row]));
  for (let index = fingerprint.entries.length - 1; index >= 0; index -= 1) {
    const entry = fingerprint.entries[index];
    const memory = pending.get(cacheKey(fingerprint.endpoint, entry.hash));
    const row = persisted.get(entry.hash);
    if (memory?.expiresAt <= stamp && !row) continue;
    if (!memory && !row) continue;
    const exact = index === fingerprint.entries.length - 1;
    return {
      matched: true,
      exact,
      type: exact ? 'exact' : 'prefix',
      weight: Number(memory?.weight ?? row.weight),
      observedTokens: Number(memory?.tokens.get(model || '') ?? row?.observed_tokens ?? 0),
    };
  }
  return miss();
}

function rpLookup(fingerprint, stamp) {
  if (!rpEnabled || !fingerprint.rpChunks?.length || !fingerprint.rpTotalWeight) return miss();
  const current = chunkCounts(fingerprint.rpChunks);
  const rows = rpLookupStatement.all(fingerprint.endpoint, stamp, JSON.stringify([...current.keys()]));
  const persisted = new Map(rows.map((row) => [row.hash, row]));
  let matchedWeight = 0;
  for (const [hash, chunk] of current) {
    const memory = pendingRp.get(cacheKey(fingerprint.endpoint, hash));
    const row = persisted.get(hash);
    if (memory?.expiresAt <= stamp && !row) continue;
    if (!memory && !row) continue;
    matchedWeight += chunk.weight * Math.min(chunk.copies, Number(memory?.copies ?? row.copies));
  }
  if (matchedWeight < 1024) return miss();
  return {
    matched: true,
    exact: false,
    type: 'rp',
    weight: Math.floor(fingerprint.totalWeight * matchedWeight / fingerprint.rpTotalWeight),
    observedTokens: 0,
  };
}

function lookup(fingerprint, model) {
  const stamp = Date.now();
  const prefix = prefixLookup(fingerprint, model, stamp);
  if (prefix.exact) return prefix;
  const rp = rpLookup(fingerprint, stamp);
  return rp.weight > prefix.weight ? rp : prefix;
}

function register(fingerprint, model, promptTokens = 0) {
  if (!fingerprint.entries.length && !fingerprint.rpChunks?.length) return;
  const itemVersion = ++version;
  const modelName = model || '';
  const tokens = Number(promptTokens) || 0;
  const stamp = Date.now();
  const expiresAt = stamp + ttlMs;
  const rpExpiresAt = stamp + RP_TTL_MS;
  for (const entry of fingerprint.entries) {
    const key = cacheKey(fingerprint.endpoint, entry.hash);
    pending.set(key, {
      version: itemVersion,
      weight: entry.weight,
      expiresAt,
      tokens: new Map(pending.get(key)?.tokens),
    });
  }
  if (tokens > 0 && fingerprint.entries.length) {
    pending.get(cacheKey(fingerprint.endpoint, fingerprint.entries.at(-1).hash)).tokens.set(modelName, tokens);
  }
  for (const chunk of chunkCounts(fingerprint.rpChunks).values()) {
    const key = cacheKey(fingerprint.endpoint, chunk.hash);
    pendingRp.set(key, {
      version: itemVersion,
      weight: chunk.weight,
      copies: Math.max(chunk.copies, pendingRp.get(key)?.copies || 0),
      expiresAt: rpExpiresAt,
    });
  }
  queue.push({ fingerprint, model: modelName, promptTokens: tokens, version: itemVersion });
  if (queue.length >= 128) flush();
}

function removeExpired(stamp = Date.now()) {
  deleteExpiredStatement.run(stamp);
  deleteExpiredRpStatement.run(stamp);
}

const cacheBytes = () => Number(storageStatement.get().indexed_bytes);

function enforceLimit() {
  let size = cacheBytes();
  while (size > CACHE_LIMIT_BYTES) {
    const oldest = oldestStatement.all();
    if (!oldest.length) break;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of oldest) (row.kind === 'rp' ? deleteRpStatement : deletePrefixStatement).run(row.hash);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    size = cacheBytes();
  }
  return size;
}

function maintain(force = false) {
  const stamp = Date.now();
  if (!force && stamp - lastMaintenance < 60_000) return;
  removeExpired(stamp);
  enforceLimit();
  lastMaintenance = stamp;
}

function flush() {
  if (!queue.length) return;
  const batch = queue.splice(0, 256);
  const stamp = Date.now();
  const expires = stamp + ttlMs;
  const rpExpires = stamp + RP_TTL_MS;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of batch) {
      for (const entry of item.fingerprint.entries) {
        cacheStatement.run(entry.hash, item.fingerprint.endpoint, entry.weight, expires, stamp);
      }
      if (item.promptTokens > 0 && item.fingerprint.entries.length) {
        tokenStatement.run(item.fingerprint.entries.at(-1).hash, item.model, item.promptTokens);
      }
      for (const chunk of chunkCounts(item.fingerprint.rpChunks).values()) {
        rpCacheStatement.run(chunk.hash, item.fingerprint.endpoint, chunk.weight, chunk.copies, rpExpires, stamp);
      }
    }
    removeExpired(stamp);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    queue.unshift(...batch);
    throw error;
  }
  for (const item of batch) {
    for (const entry of item.fingerprint.entries) {
      const key = cacheKey(item.fingerprint.endpoint, entry.hash);
      if (pending.get(key)?.version <= item.version) pending.delete(key);
    }
    for (const chunk of chunkCounts(item.fingerprint.rpChunks).values()) {
      const key = cacheKey(item.fingerprint.endpoint, chunk.hash);
      if (pendingRp.get(key)?.version <= item.version) pendingRp.delete(key);
    }
  }
  maintain();
}

function stats() {
  while (queue.length) flush();
  maintain(true);
  const stamp = Date.now();
  const prefix = db.prepare('SELECT COUNT(*) entries, COALESCE(MIN(expires_at), 0) next_expiry FROM prompt_cache WHERE expires_at>?').get(stamp);
  const rp = db.prepare('SELECT COUNT(*) entries FROM prompt_cache_rp WHERE expires_at>?').get(stamp);
  return {
    entries: Number(prefix.entries),
    rpEntries: Number(rp.entries),
    indexedBytes: cacheBytes(),
    nextExpiry: Number(prefix.next_expiry),
    rpEnabled,
    limitBytes: CACHE_LIMIT_BYTES,
  };
}

const timer = setInterval(() => {
  try {
    flush();
    maintain();
  } catch (error) { console.error('cache write failed:', error.message); }
}, 100);

parentPort.on('message', (message) => {
  const respond = (result) => message.id && parentPort.postMessage({ id: message.id, result });
  try {
    if (message.type === 'resolve') {
      const fingerprint = buildFingerprint(message.endpoint, message.request, masterKey);
      respond({ fingerprint, hit: lookup(fingerprint, message.model) });
    } else if (message.type === 'lookup') respond(lookup(message.fingerprint, message.model));
    else if (message.type === 'register') register(message.fingerprint, message.model, message.promptTokens);
    else if (message.type === 'flush') { while (queue.length) flush(); respond(true); }
    else if (message.type === 'stats') respond(stats());
    else if (message.type === 'set-rp') {
      rpEnabled = Boolean(message.enabled);
      db.prepare("INSERT INTO cache_settings(key, value) VALUES ('rp_enabled', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(rpEnabled ? '1' : '0');
      respond({ enabled: rpEnabled });
    } else if (message.type === 'clear') {
      queue.length = 0;
      pending.clear();
      pendingRp.clear();
      db.exec('BEGIN IMMEDIATE; DELETE FROM prompt_cache; DELETE FROM prompt_cache_rp; COMMIT;');
      respond(true);
    } else if (message.type === 'close') {
      clearInterval(timer);
      while (queue.length) flush();
      db.close();
      respond(true);
      parentPort.close();
    }
  } catch (error) {
    if (message.id) parentPort.postMessage({ id: message.id, error: error.message });
    else console.error('cache worker failed:', error.message);
  }
});
