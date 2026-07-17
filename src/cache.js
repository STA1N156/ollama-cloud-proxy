import { hmac256 } from './crypto.js';

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
};

const stable = (value) => JSON.stringify(canonicalize(value));

export function buildFingerprint(endpoint, request, key) {
  const base = {};
  for (const field of ['instructions', 'tools', 'tool_choice', 'response_format']) {
    if (request[field] != null) base[field] = request[field];
  }
  if (request.text?.format != null) base.text_format = request.text.format;

  let blocks = [];
  if (Array.isArray(request.messages)) blocks = request.messages;
  else if (Array.isArray(request.input)) blocks = request.input;
  else if (request.input != null) blocks = [request.input];
  else if (request.prompt != null) blocks = [request.prompt];

  let prefix = Object.keys(base).length ? stable(base) : '';
  const entries = [];
  if (prefix) {
    entries.push({
      hash: hmac256(key, `${endpoint}\u001f${prefix}`),
      weight: Buffer.byteLength(prefix),
    });
  }
  for (const block of blocks) {
    prefix += `\u001e${stable(block)}`;
    entries.push({
      hash: hmac256(key, `${endpoint}\u001f${prefix}`),
      weight: Buffer.byteLength(prefix),
    });
  }
  return {
    endpoint,
    entries,
    totalWeight: entries.at(-1)?.weight || 0,
  };
}

export function cachedTokenCount(hit, promptTokens, totalWeight) {
  const total = Math.max(0, Number(promptTokens) || 0);
  if (!hit?.matched || !total || !totalWeight) return 0;
  if (hit.exact) return total;
  if (hit.observedTokens > 0) return Math.min(total, hit.observedTokens);
  return Math.min(total, Math.floor(total * hit.weight / totalWeight));
}

export class CacheLedger {
  constructor(store, ttlMs) {
    this.store = store;
    this.ttlMs = ttlMs;
    this.queue = [];
    this.pending = new Map();
    this.version = 0;
    this.timer = setInterval(() => this.flush(), 100);
    this.timer.unref();
    this.lookupStmt = store.db.prepare(`
      SELECT c.weight, COALESCE(t.tokens, 0) observed_tokens
      FROM prompt_cache c
      LEFT JOIN prompt_cache_tokens t ON t.hash=c.hash AND t.model=?
      WHERE c.hash=? AND c.endpoint=? AND c.expires_at>?
    `);
  }

  lookup(fingerprint, model) {
    const stamp = Date.now();
    for (let index = fingerprint.entries.length - 1; index >= 0; index -= 1) {
      const entry = fingerprint.entries[index];
      const pending = this.pending.get(`${fingerprint.endpoint}\u001f${entry.hash}`);
      if (pending?.expiresAt > stamp) {
        const persisted = this.lookupStmt.get(model || '', entry.hash, fingerprint.endpoint, stamp);
        return {
          matched: true,
          exact: index === fingerprint.entries.length - 1,
          weight: pending.weight,
          observedTokens: pending.tokens.get(model || '') ?? Number(persisted?.observed_tokens || 0),
        };
      }
      const row = this.lookupStmt.get(model || '', entry.hash, fingerprint.endpoint, stamp);
      if (row) return {
        matched: true,
        exact: index === fingerprint.entries.length - 1,
        weight: Number(row.weight),
        observedTokens: Number(row.observed_tokens),
      };
    }
    return { matched: false, exact: false, weight: 0, observedTokens: 0 };
  }

  register(fingerprint, model, promptTokens = 0) {
    if (!fingerprint.entries.length) return;
    const version = ++this.version;
    const modelName = model || '';
    const tokens = Number(promptTokens) || 0;
    const expiresAt = Date.now() + this.ttlMs;
    for (const entry of fingerprint.entries) {
      const key = `${fingerprint.endpoint}\u001f${entry.hash}`;
      const previous = this.pending.get(key);
      this.pending.set(key, {
        version,
        weight: entry.weight,
        expiresAt,
        tokens: new Map(previous?.tokens),
      });
    }
    if (tokens > 0) {
      const final = this.pending.get(`${fingerprint.endpoint}\u001f${fingerprint.entries.at(-1).hash}`);
      final.tokens.set(modelName, tokens);
    }
    this.queue.push({ fingerprint, model: modelName, promptTokens: tokens, version });
    if (this.queue.length >= 128) this.flush();
  }

  flush() {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, 256);
    const stamp = Date.now();
    const expires = stamp + this.ttlMs;
    const cache = this.store.db.prepare(`
      INSERT INTO prompt_cache(hash, endpoint, weight, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET weight=excluded.weight, expires_at=excluded.expires_at, updated_at=excluded.updated_at
    `);
    const tokens = this.store.db.prepare(`
      INSERT INTO prompt_cache_tokens(hash, model, tokens) VALUES (?, ?, ?)
      ON CONFLICT(hash, model) DO UPDATE SET tokens=excluded.tokens
    `);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of batch) {
        for (const entry of item.fingerprint.entries) cache.run(
          entry.hash, item.fingerprint.endpoint, entry.weight, expires, stamp,
        );
        const finalHash = item.fingerprint.entries.at(-1).hash;
        if (item.promptTokens > 0) tokens.run(finalHash, item.model, item.promptTokens);
      }
      this.store.db.prepare('DELETE FROM prompt_cache WHERE expires_at<=?').run(stamp);
      this.store.db.exec('COMMIT');
      for (const item of batch) {
        for (const entry of item.fingerprint.entries) {
          const key = `${item.fingerprint.endpoint}\u001f${entry.hash}`;
          if (this.pending.get(key)?.version <= item.version) this.pending.delete(key);
        }
      }
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      this.queue.unshift(...batch);
      console.error('cache write failed:', error.message);
    }
  }

  stats() {
    this.flush();
    const stamp = Date.now();
    this.store.db.prepare('DELETE FROM prompt_cache WHERE expires_at<=?').run(stamp);
    const row = this.store.db.prepare(`
      SELECT COUNT(*) entries, COALESCE(MIN(expires_at), 0) next_expiry
      FROM prompt_cache WHERE expires_at>?
    `).get(stamp);
    const storage = this.store.db.prepare(`
      SELECT COALESCE(SUM(pgsize), 0) indexed_bytes FROM dbstat
      WHERE name IN ('prompt_cache', 'prompt_cache_tokens', 'idx_cache_expiry',
        'sqlite_autoindex_prompt_cache_1', 'sqlite_autoindex_prompt_cache_tokens_1')
    `).get();
    return { entries: Number(row.entries), indexedBytes: Number(storage.indexed_bytes), nextExpiry: Number(row.next_expiry) };
  }

  clear() {
    this.queue.length = 0;
    this.pending.clear();
    this.store.db.prepare('DELETE FROM prompt_cache').run();
  }

  close() {
    clearInterval(this.timer);
    this.flush();
  }
}
