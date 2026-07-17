import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { decrypt, encrypt, loadOrCreateMasterKey, sha256 } from './crypto.js';

const now = () => Date.now();

export class Store {
  constructor(config) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.masterKey = loadOrCreateMasterKey(config.masterKeyPath);
    this.db = new DatabaseSync(config.databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS upstream_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        secret TEXT NOT NULL,
        secret_hash TEXT NOT NULL UNIQUE,
        last4 TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'new',
        last_error TEXT NOT NULL DEFAULT '',
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS client_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        last4 TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS prompt_cache (
        hash TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        weight INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS prompt_cache_tokens (
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        PRIMARY KEY (hash, model),
        FOREIGN KEY (hash) REFERENCES prompt_cache(hash) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        upstream_key_id INTEGER,
        client_key_id INTEGER,
        model TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        status INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        stream INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS models (
        name TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        modified_at TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        digest TEXT NOT NULL DEFAULT '',
        details TEXT NOT NULL DEFAULT '{}',
        synced_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_key_model ON usage_events(upstream_key_id, model);
      CREATE INDEX IF NOT EXISTS idx_cache_expiry ON prompt_cache(expires_at);
    `);
    this.usageQueue = [];
    this.usageTimer = setInterval(() => this.flushUsage(), 200);
    this.usageTimer.unref();
  }

  close() {
    clearInterval(this.usageTimer);
    this.flushUsage();
    this.db.close();
  }

  addUpstreamKey(label, secret) {
    const value = secret.trim();
    if (!value) throw new Error('密钥不能为空');
    const stamp = now();
    const result = this.db.prepare(`
      INSERT INTO upstream_keys(label, secret, secret_hash, last4, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(secret_hash) DO UPDATE SET label=excluded.label, enabled=1, updated_at=excluded.updated_at
      RETURNING id
    `).get(label.trim() || `Key ${value.slice(-4)}`, encrypt(value, this.masterKey), sha256(value), value.slice(-4), stamp, stamp);
    return Number(result.id);
  }

  listUpstreamKeys({ reveal = false } = {}) {
    return this.db.prepare('SELECT * FROM upstream_keys ORDER BY id').all().map((row) => ({
      ...row,
      id: Number(row.id),
      enabled: Boolean(row.enabled),
      secret: reveal ? decrypt(row.secret, this.masterKey) : undefined,
      secret_hash: undefined,
    }));
  }

  getUpstreamKey(id) {
    const row = this.db.prepare('SELECT * FROM upstream_keys WHERE id=?').get(id);
    return row ? { ...row, id: Number(row.id), enabled: Boolean(row.enabled), secret: decrypt(row.secret, this.masterKey), secret_hash: undefined } : null;
  }

  setUpstreamEnabled(id, enabled) {
    this.db.prepare("UPDATE upstream_keys SET enabled=?, status=CASE WHEN ? THEN status ELSE 'paused' END, updated_at=? WHERE id=?")
      .run(enabled ? 1 : 0, enabled ? 1 : 0, now(), id);
  }

  updateUpstreamHealth(id, status, error = '', cooldownUntil = 0) {
    this.db.prepare('UPDATE upstream_keys SET status=?, last_error=?, cooldown_until=?, updated_at=? WHERE id=?')
      .run(status, error.slice(0, 500), cooldownUntil, now(), id);
  }

  deleteUpstreamKey(id) {
    this.db.prepare('DELETE FROM upstream_keys WHERE id=?').run(id);
  }

  addClientKey(label, token) {
    const value = token.trim();
    const result = this.db.prepare(`
      INSERT INTO client_keys(label, token_hash, last4, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(token_hash) DO UPDATE SET label=excluded.label, enabled=1
      RETURNING id
    `).get(label.trim() || `Client ${value.slice(-4)}`, sha256(value), value.slice(-4), now());
    return Number(result.id);
  }

  listClientKeys() {
    return this.db.prepare('SELECT id, label, last4, enabled, created_at FROM client_keys ORDER BY id').all()
      .map((row) => ({ ...row, id: Number(row.id), enabled: Boolean(row.enabled) }));
  }

  validateClientKey(token) {
    const row = this.db.prepare('SELECT id FROM client_keys WHERE token_hash=? AND enabled=1').get(sha256(token));
    return row ? Number(row.id) : null;
  }

  clientKeyCount() {
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM client_keys WHERE enabled=1').get().count);
  }

  setClientEnabled(id, enabled) {
    this.db.prepare('UPDATE client_keys SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id);
  }

  deleteClientKey(id) {
    this.db.prepare('DELETE FROM client_keys WHERE id=?').run(id);
  }

  queueUsage(event) {
    this.usageQueue.push({ createdAt: now(), ...event });
    if (this.usageQueue.length >= 256) this.flushUsage();
  }

  flushUsage() {
    if (!this.usageQueue.length) return;
    const batch = this.usageQueue.splice(0, 512);
    const insert = this.db.prepare(`
      INSERT INTO usage_events(created_at, upstream_key_id, client_key_id, model, endpoint,
        prompt_tokens, completion_tokens, cached_tokens, total_tokens, status, latency_ms, stream, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of batch) insert.run(
        item.createdAt, item.upstreamKeyId ?? null, item.clientKeyId ?? null, item.model || '', item.endpoint,
        item.promptTokens || 0, item.completionTokens || 0, item.cachedTokens || 0, item.totalTokens || 0,
        item.status || 0, item.latencyMs || 0, item.stream ? 1 : 0, (item.error || '').slice(0, 500),
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.usageQueue.unshift(...batch);
      console.error('usage write failed:', error.message);
    }
  }

  summary(hours = 24) {
    this.flushUsage();
    const since = now() - Math.max(1, hours) * 3_600_000;
    const totals = this.db.prepare(`
      SELECT COUNT(*) requests,
        SUM(CASE WHEN status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) successes,
        COALESCE(SUM(prompt_tokens), 0) prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) completion_tokens,
        COALESCE(SUM(cached_tokens), 0) cached_tokens,
        COALESCE(AVG(latency_ms), 0) avg_latency_ms
      FROM usage_events WHERE created_at >= ?
    `).get(since);
    const byKeyModel = this.db.prepare(`
      SELECT COALESCE(k.label, '未分配') key_label, u.model,
        COUNT(*) requests, SUM(u.prompt_tokens) prompt_tokens,
        SUM(u.completion_tokens) completion_tokens, SUM(u.cached_tokens) cached_tokens
      FROM usage_events u LEFT JOIN upstream_keys k ON k.id=u.upstream_key_id
      WHERE u.created_at >= ? GROUP BY u.upstream_key_id, u.model
      ORDER BY prompt_tokens + completion_tokens DESC LIMIT 200
    `).all(since);
    const recent = this.db.prepare(`
      SELECT u.created_at, COALESCE(k.label, '—') key_label, u.model, u.endpoint,
        u.prompt_tokens, u.completion_tokens, u.cached_tokens, u.status, u.latency_ms, u.stream
      FROM usage_events u LEFT JOIN upstream_keys k ON k.id=u.upstream_key_id
      ORDER BY u.id DESC LIMIT 80
    `).all();
    return { totals, byKeyModel, recent };
  }

  replaceModels(models) {
    const stamp = now();
    const upsert = this.db.prepare(`
      INSERT INTO models(name, model, modified_at, size, digest, details, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET model=excluded.model, modified_at=excluded.modified_at,
        size=excluded.size, digest=excluded.digest, details=excluded.details, synced_at=excluded.synced_at
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM models').run();
      for (const item of models) upsert.run(
        item.name || item.model, item.model || item.name, item.modified_at || '', Number(item.size) || 0,
        item.digest || '', JSON.stringify(item.details || {}), stamp,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listModels() {
    return this.db.prepare('SELECT * FROM models ORDER BY name').all().map((row) => ({
      ...row,
      size: Number(row.size),
      synced_at: Number(row.synced_at),
      details: JSON.parse(row.details || '{}'),
    }));
  }
}
