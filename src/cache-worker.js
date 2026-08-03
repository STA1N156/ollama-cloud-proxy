import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { buildFingerprint } from './cache.js';

const db = new DatabaseSync(workerData.databasePath);
const ttlMs = Number(workerData.ttlMs);
const masterKey = Buffer.from(workerData.masterKey);
const queue = [];
const pending = new Map();
let version = 0;

db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');

const lookupStatement = db.prepare(`
  SELECT c.hash, c.weight, COALESCE(t.tokens, 0) observed_tokens
  FROM prompt_cache c
  LEFT JOIN prompt_cache_tokens t ON t.hash=c.hash AND t.model=?
  WHERE c.endpoint=? AND c.expires_at>? AND c.hash IN (SELECT value FROM json_each(?))
`);
const cacheStatement = db.prepare(`
  INSERT INTO prompt_cache(hash, endpoint, weight, expires_at, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(hash) DO UPDATE SET weight=excluded.weight, expires_at=excluded.expires_at, updated_at=excluded.updated_at
`);
const tokenStatement = db.prepare(`
  INSERT INTO prompt_cache_tokens(hash, model, tokens) VALUES (?, ?, ?)
  ON CONFLICT(hash, model) DO UPDATE SET tokens=excluded.tokens
`);
const deleteExpiredStatement = db.prepare('DELETE FROM prompt_cache WHERE expires_at<=?');

const miss = () => ({ matched: false, exact: false, weight: 0, observedTokens: 0 });
const cacheKey = (endpoint, hash) => `${endpoint}\u001f${hash}`;

function lookup(fingerprint, model) {
  if (!fingerprint.entries.length) return miss();
  const stamp = Date.now();
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
    return {
      matched: true,
      exact: index === fingerprint.entries.length - 1,
      weight: Number(memory?.weight ?? row.weight),
      observedTokens: Number(memory?.tokens.get(model || '') ?? row?.observed_tokens ?? 0),
    };
  }
  return miss();
}

function register(fingerprint, model, promptTokens = 0) {
  if (!fingerprint.entries.length) return;
  const itemVersion = ++version;
  const modelName = model || '';
  const tokens = Number(promptTokens) || 0;
  const expiresAt = Date.now() + ttlMs;
  for (const entry of fingerprint.entries) {
    const key = cacheKey(fingerprint.endpoint, entry.hash);
    pending.set(key, {
      version: itemVersion,
      weight: entry.weight,
      expiresAt,
      tokens: new Map(pending.get(key)?.tokens),
    });
  }
  if (tokens > 0) pending.get(cacheKey(fingerprint.endpoint, fingerprint.entries.at(-1).hash)).tokens.set(modelName, tokens);
  queue.push({ fingerprint, model: modelName, promptTokens: tokens, version: itemVersion });
  if (queue.length >= 128) flush();
}

function flush() {
  if (!queue.length) return;
  const batch = queue.splice(0, 256);
  const stamp = Date.now();
  const expires = stamp + ttlMs;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of batch) {
      for (const entry of item.fingerprint.entries) {
        cacheStatement.run(entry.hash, item.fingerprint.endpoint, entry.weight, expires, stamp);
      }
      if (item.promptTokens > 0) tokenStatement.run(item.fingerprint.entries.at(-1).hash, item.model, item.promptTokens);
    }
    deleteExpiredStatement.run(stamp);
    db.exec('COMMIT');
    for (const item of batch) {
      for (const entry of item.fingerprint.entries) {
        const key = cacheKey(item.fingerprint.endpoint, entry.hash);
        if (pending.get(key)?.version <= item.version) pending.delete(key);
      }
    }
  } catch (error) {
    db.exec('ROLLBACK');
    queue.unshift(...batch);
    throw error;
  }
}

function stats() {
  while (queue.length) flush();
  const stamp = Date.now();
  deleteExpiredStatement.run(stamp);
  const row = db.prepare(`
    SELECT COUNT(*) entries, COALESCE(MIN(expires_at), 0) next_expiry
    FROM prompt_cache WHERE expires_at>?
  `).get(stamp);
  const storage = db.prepare(`
    SELECT COALESCE(SUM(pgsize), 0) indexed_bytes FROM dbstat
    WHERE name IN ('prompt_cache', 'prompt_cache_tokens', 'idx_cache_expiry',
      'sqlite_autoindex_prompt_cache_1', 'sqlite_autoindex_prompt_cache_tokens_1')
  `).get();
  return { entries: Number(row.entries), indexedBytes: Number(storage.indexed_bytes), nextExpiry: Number(row.next_expiry) };
}

const timer = setInterval(() => {
  try { flush(); } catch (error) { console.error('cache write failed:', error.message); }
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
    else if (message.type === 'clear') {
      queue.length = 0;
      pending.clear();
      db.prepare('DELETE FROM prompt_cache').run();
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
