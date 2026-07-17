import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { decrypt, encrypt, loadOrCreateMasterKey, sha256 } from './crypto.js';

const now = () => Date.now();
const outputTps = (value) => Math.min(1000, Math.max(0, Math.floor(Number(value) || 0)));
const clientOrigin = (value) => {
  const origin = String(value || '').trim();
  if (!origin) return '';
  if (origin !== 'https://sta1n156.github.io') throw new Error('不支持的来源地址');
  return origin;
};
export const normalizeBaseUrl = (value, fallback = 'https://ollama.com/v1') => {
  const url = new URL(String(value || fallback).trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API 地址必须使用 http 或 https');
  if (url.search || url.hash || url.username || url.password) throw new Error('API 地址不能包含账号、查询参数或锚点');
  return url.toString().replace(/\/+$/, '');
};

export class Store {
  constructor(config) {
    this.defaultUpstreamBaseUrl = normalizeBaseUrl(config.upstreamBaseUrl);
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
        base_url TEXT NOT NULL,
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
        token_secret TEXT NOT NULL DEFAULT '',
        last4 TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        output_tps INTEGER NOT NULL DEFAULT 0,
        allowed_origin TEXT NOT NULL DEFAULT '',
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
        source_url TEXT NOT NULL,
        name TEXT NOT NULL,
        model TEXT NOT NULL,
        modified_at TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        digest TEXT NOT NULL DEFAULT '',
        details TEXT NOT NULL DEFAULT '{}',
        synced_at INTEGER NOT NULL,
        PRIMARY KEY (source_url, name)
      );

      CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_key_model ON usage_events(upstream_key_id, model);
      CREATE INDEX IF NOT EXISTS idx_cache_expiry ON prompt_cache(expires_at);
    `);
    const clientColumns = this.db.prepare('PRAGMA table_info(client_keys)').all();
    if (!clientColumns.some((column) => column.name === 'token_secret')) {
      this.db.exec("ALTER TABLE client_keys ADD COLUMN token_secret TEXT NOT NULL DEFAULT ''");
    }
    if (!clientColumns.some((column) => column.name === 'output_tps')) {
      this.db.exec('ALTER TABLE client_keys ADD COLUMN output_tps INTEGER NOT NULL DEFAULT 0');
    }
    if (!clientColumns.some((column) => column.name === 'allowed_origin')) {
      this.db.exec("ALTER TABLE client_keys ADD COLUMN allowed_origin TEXT NOT NULL DEFAULT ''");
    }
    const upstreamColumns = this.db.prepare('PRAGMA table_info(upstream_keys)').all();
    if (!upstreamColumns.some((column) => column.name === 'base_url')) {
      this.db.exec("ALTER TABLE upstream_keys ADD COLUMN base_url TEXT NOT NULL DEFAULT ''");
    }
    this.db.prepare("UPDATE upstream_keys SET base_url=? WHERE base_url='' OR base_url IS NULL").run(this.defaultUpstreamBaseUrl);
    const modelColumns = this.db.prepare('PRAGMA table_info(models)').all();
    if (!modelColumns.some((column) => column.name === 'source_url')) {
      this.db.exec(`
        ALTER TABLE models RENAME TO models_legacy;
        CREATE TABLE models (
          source_url TEXT NOT NULL,
          name TEXT NOT NULL,
          model TEXT NOT NULL,
          modified_at TEXT NOT NULL DEFAULT '',
          size INTEGER NOT NULL DEFAULT 0,
          digest TEXT NOT NULL DEFAULT '',
          details TEXT NOT NULL DEFAULT '{}',
          synced_at INTEGER NOT NULL,
          PRIMARY KEY (source_url, name)
        );
      `);
      this.db.prepare(`
        INSERT INTO models(source_url, name, model, modified_at, size, digest, details, synced_at)
        SELECT ?, name, model, modified_at, size, digest, details, synced_at FROM models_legacy
      `).run(this.defaultUpstreamBaseUrl);
      this.db.exec('DROP TABLE models_legacy');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_models_source ON models(source_url)');
    this.usageQueue = [];
    this.usageTimer = setInterval(() => this.flushUsage(), 200);
    this.usageTimer.unref();
  }

  close() {
    clearInterval(this.usageTimer);
    this.flushUsage();
    this.db.close();
  }

  addUpstreamKey(label, secret, baseUrl = this.defaultUpstreamBaseUrl) {
    const value = secret.trim();
    if (!value) throw new Error('密钥不能为空');
    const source = normalizeBaseUrl(baseUrl, this.defaultUpstreamBaseUrl);
    const hash = sha256(value);
    const previous = this.db.prepare('SELECT base_url FROM upstream_keys WHERE secret_hash=?').get(hash);
    const stamp = now();
    const result = this.db.prepare(`
      INSERT INTO upstream_keys(label, base_url, secret, secret_hash, last4, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(secret_hash) DO UPDATE SET label=excluded.label, base_url=excluded.base_url,
        enabled=1, status='new', last_error='', cooldown_until=0, updated_at=excluded.updated_at
      RETURNING id
    `).get(label.trim() || `Key ${value.slice(-4)}`, source, encrypt(value, this.masterKey), hash, value.slice(-4), stamp, stamp);
    if (previous && previous.base_url !== source && !this.db.prepare('SELECT 1 FROM upstream_keys WHERE base_url=? LIMIT 1').get(previous.base_url)) {
      this.db.prepare('DELETE FROM models WHERE source_url=?').run(previous.base_url);
    }
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
    this.db.prepare("UPDATE upstream_keys SET enabled=?, status=CASE WHEN ? THEN 'new' ELSE 'paused' END, updated_at=? WHERE id=?")
      .run(enabled ? 1 : 0, enabled ? 1 : 0, now(), id);
  }

  updateUpstreamHealth(id, status, error = '', cooldownUntil = 0) {
    this.db.prepare('UPDATE upstream_keys SET status=?, last_error=?, cooldown_until=?, updated_at=? WHERE id=?')
      .run(status, error.slice(0, 500), cooldownUntil, now(), id);
  }

  deleteUpstreamKey(id) {
    const row = this.db.prepare('SELECT base_url FROM upstream_keys WHERE id=?').get(id);
    this.db.prepare('DELETE FROM upstream_keys WHERE id=?').run(id);
    if (row && !this.db.prepare('SELECT 1 FROM upstream_keys WHERE base_url=? LIMIT 1').get(row.base_url)) {
      this.db.prepare('DELETE FROM models WHERE source_url=?').run(row.base_url);
    }
  }

  addClientKey(label, token, rate = null, origin = null) {
    const value = token.trim();
    const normalizedRate = outputTps(rate);
    const normalizedOrigin = origin == null ? null : clientOrigin(origin);
    const result = this.db.prepare(`
      INSERT INTO client_keys(label, token_hash, token_secret, last4, output_tps, allowed_origin, created_at)
      VALUES (?, ?, ?, ?, ?, COALESCE(?, ''), ?)
      ON CONFLICT(token_hash) DO UPDATE SET label=excluded.label, token_secret=excluded.token_secret,
        output_tps=COALESCE(?, client_keys.output_tps), allowed_origin=COALESCE(?, client_keys.allowed_origin), enabled=1
      RETURNING id
    `).get(label.trim() || `Client ${value.slice(-4)}`, sha256(value), encrypt(value, this.masterKey), value.slice(-4), normalizedRate, normalizedOrigin, now(), rate == null ? null : normalizedRate, normalizedOrigin);
    return Number(result.id);
  }

  listClientKeys() {
    return this.db.prepare(`
      SELECT c.id, c.label, c.last4, c.enabled, c.output_tps, c.allowed_origin, c.created_at, c.token_secret!='' copyable,
        COALESCE(SUM(u.prompt_tokens), 0) prompt_tokens,
        COALESCE(SUM(u.completion_tokens), 0) completion_tokens,
        COALESCE(SUM(u.cached_tokens), 0) cached_tokens,
        COALESCE(SUM(u.total_tokens), 0) total_tokens
      FROM client_keys c LEFT JOIN usage_events u ON u.client_key_id=c.id
      GROUP BY c.id ORDER BY c.id
    `).all().map((row) => ({
      ...row,
      id: Number(row.id),
      enabled: Boolean(row.enabled),
      copyable: Boolean(row.copyable),
    }));
  }

  getClientKeyToken(id) {
    const row = this.db.prepare('SELECT token_secret FROM client_keys WHERE id=?').get(id);
    if (!row) throw Object.assign(new Error('下游密钥不存在'), { status: 404 });
    if (!row.token_secret) throw Object.assign(new Error('旧版密钥无法恢复完整值，请重新生成'), { status: 409 });
    return decrypt(row.token_secret, this.masterKey);
  }

  getClientAccess(token) {
    const row = this.db.prepare('SELECT id, output_tps, allowed_origin FROM client_keys WHERE token_hash=? AND enabled=1').get(sha256(token));
    return row ? { id: Number(row.id), outputTps: Number(row.output_tps), allowedOrigin: row.allowed_origin } : null;
  }

  clientKeyCount() {
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM client_keys WHERE enabled=1').get().count);
  }

  setClientEnabled(id, enabled) {
    this.db.prepare('UPDATE client_keys SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id);
  }

  setClientOutputTps(id, rate) {
    this.db.prepare('UPDATE client_keys SET output_tps=? WHERE id=?').run(outputTps(rate), id);
  }

  setClientAllowedOrigin(id, origin) {
    this.db.prepare('UPDATE client_keys SET allowed_origin=? WHERE id=?').run(clientOrigin(origin), id);
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

  clearUsage() {
    this.usageQueue.length = 0;
    this.db.prepare('DELETE FROM usage_events').run();
  }

  summary(hours = 24) {
    this.flushUsage();
    const since = now() - Math.max(1, hours) * 3_600_000;
    const totals = this.db.prepare(`
      SELECT COUNT(*) requests,
        SUM(CASE WHEN status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) successes,
        COALESCE(SUM(prompt_tokens), 0) prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) completion_tokens,
        COALESCE(SUM(cached_tokens), 0) cached_tokens
      FROM usage_events WHERE created_at >= ?
    `).get(since);
    const p95Index = Math.max(0, Math.ceil(Number(totals.requests) * 0.95) - 1);
    const p95 = this.db.prepare(`
      SELECT latency_ms FROM usage_events WHERE created_at >= ?
      ORDER BY latency_ms LIMIT 1 OFFSET ?
    `).get(since, p95Index);
    totals.p95_latency_ms = Number(p95?.latency_ms || 0);
    const byKeyModel = this.db.prepare(`
      SELECT u.upstream_key_id key_id, COALESCE(k.label, '未分配') key_label, u.model,
        COUNT(*) requests, SUM(u.prompt_tokens) prompt_tokens,
        SUM(u.completion_tokens) completion_tokens, SUM(u.cached_tokens) cached_tokens
      FROM usage_events u LEFT JOIN upstream_keys k ON k.id=u.upstream_key_id
      WHERE u.created_at >= ? GROUP BY u.upstream_key_id, u.model
      ORDER BY u.upstream_key_id, SUM(u.prompt_tokens + u.completion_tokens) DESC
    `).all(since);
    const recent = this.db.prepare(`
      SELECT u.created_at, COALESCE(k.label, '—') key_label, u.model, u.endpoint,
        u.prompt_tokens, u.completion_tokens, u.cached_tokens, u.status, u.latency_ms, u.stream
      FROM usage_events u LEFT JOIN upstream_keys k ON k.id=u.upstream_key_id
      ORDER BY u.id DESC LIMIT 80
    `).all();
    return { totals, byKeyModel, recent };
  }

  replaceModels(sourceUrl, models) {
    const source = normalizeBaseUrl(sourceUrl, this.defaultUpstreamBaseUrl);
    const stamp = now();
    const upsert = this.db.prepare(`
      INSERT INTO models(source_url, name, model, modified_at, size, digest, details, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_url, name) DO UPDATE SET model=excluded.model, modified_at=excluded.modified_at,
        size=excluded.size, digest=excluded.digest, details=excluded.details, synced_at=excluded.synced_at
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM models WHERE source_url=?').run(source);
      for (const item of models) upsert.run(
        source, item.name || item.model, item.model || item.name, item.modified_at || '', Number(item.size) || 0,
        item.digest || '', JSON.stringify(item.details || {}), stamp,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listModels() {
    return this.db.prepare(`
      SELECT m.*,
        COALESCE((SELECT k.label FROM upstream_keys k WHERE k.base_url=m.source_url ORDER BY k.id LIMIT 1), m.source_url) source_label,
        (SELECT COUNT(*) FROM upstream_keys k WHERE k.base_url=m.source_url AND k.enabled=1) key_count
      FROM models m ORDER BY m.source_url, m.name
    `).all().map((row) => ({
      ...row,
      size: Number(row.size),
      synced_at: Number(row.synced_at),
      key_count: Number(row.key_count),
      details: JSON.parse(row.details || '{}'),
    }));
  }

  listModelRoutes() {
    return this.db.prepare('SELECT source_url, name FROM models').all();
  }
}
