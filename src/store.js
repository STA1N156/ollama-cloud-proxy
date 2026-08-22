import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { decrypt, encrypt, loadOrCreateMasterKey, sha256 } from './crypto.js';

const now = () => Date.now();
const outputTps = (value) => Math.min(1000, Math.max(0, Math.floor(Number(value) || 0)));
const upstreamTier = (value) => {
  const tier = String(value || 'max').trim().toLowerCase();
  if (!['max', 'pro'].includes(tier)) throw new Error('Ollama 密钥等级只能是 MAX 或 PRO');
  return tier;
};
const clientAccessMode = (value) => {
  const mode = String(value || '').trim();
  if (!mode) return { allowedOrigin: '', concurrencyLimit: 0 };
  if (['https://sta1n156.github.io', 'codex-router'].includes(mode)) {
    return { allowedOrigin: 'https://sta1n156.github.io', concurrencyLimit: 0 };
  }
  const limit = Number(mode.match(/^limit:(5|10|15|20|25|30|35|40)$/)?.[1]);
  if (!limit) throw new Error('不支持的访问控制模式');
  return { allowedOrigin: 'https://sta1n156.github.io', concurrencyLimit: limit };
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
    this.databasePath = config.databasePath;
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
        use_proxy_cache INTEGER NOT NULL DEFAULT 0,
        tier TEXT NOT NULL DEFAULT 'max',
        status TEXT NOT NULL DEFAULT 'new',
        last_error TEXT NOT NULL DEFAULT '',
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        session_quota_blocked INTEGER NOT NULL DEFAULT 0,
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
        concurrency_limit INTEGER NOT NULL DEFAULT 0,
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

      CREATE TABLE IF NOT EXISTS prompt_cache_rp (
        hash TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        weight INTEGER NOT NULL,
        copies INTEGER NOT NULL DEFAULT 1,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cache_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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

      CREATE TABLE IF NOT EXISTS client_usage_totals (
        client_key_id INTEGER PRIMARY KEY,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS usage_hourly (
        hour INTEGER NOT NULL,
        upstream_key_id INTEGER NOT NULL,
        model TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0,
        successes INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hour, upstream_key_id, model)
      );

      CREATE TABLE IF NOT EXISTS usage_latency_hourly (
        hour INTEGER NOT NULL,
        latency_bucket_ms INTEGER NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hour, latency_bucket_ms)
      );

      CREATE TABLE IF NOT EXISTS usage_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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
      DROP INDEX IF EXISTS idx_usage_key_model;
      CREATE INDEX IF NOT EXISTS idx_cache_expiry ON prompt_cache(expires_at);
      CREATE INDEX IF NOT EXISTS idx_cache_updated ON prompt_cache(updated_at);
      CREATE INDEX IF NOT EXISTS idx_cache_rp_expiry ON prompt_cache_rp(expires_at);
      CREATE INDEX IF NOT EXISTS idx_cache_rp_updated ON prompt_cache_rp(updated_at);
    `);
    this.db.prepare("INSERT OR IGNORE INTO cache_settings(key, value) VALUES ('rp_enabled', '0')").run();
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
    if (!clientColumns.some((column) => column.name === 'concurrency_limit')) {
      this.db.exec('ALTER TABLE client_keys ADD COLUMN concurrency_limit INTEGER NOT NULL DEFAULT 0');
    }
    this.db.exec("UPDATE client_keys SET allowed_origin='https://sta1n156.github.io' WHERE allowed_origin='codex-router'");
    this.db.exec('UPDATE client_keys SET concurrency_limit=40 WHERE concurrency_limit IN (50, 60)');
    const upstreamColumns = this.db.prepare('PRAGMA table_info(upstream_keys)').all();
    if (!upstreamColumns.some((column) => column.name === 'base_url')) {
      this.db.exec("ALTER TABLE upstream_keys ADD COLUMN base_url TEXT NOT NULL DEFAULT ''");
    }
    if (!upstreamColumns.some((column) => column.name === 'use_proxy_cache')) {
      this.db.exec('ALTER TABLE upstream_keys ADD COLUMN use_proxy_cache INTEGER NOT NULL DEFAULT 0');
    }
    if (!upstreamColumns.some((column) => column.name === 'tier')) {
      this.db.exec("ALTER TABLE upstream_keys ADD COLUMN tier TEXT NOT NULL DEFAULT 'max'");
    }
    if (!upstreamColumns.some((column) => column.name === 'session_quota_blocked')) {
      this.db.exec('ALTER TABLE upstream_keys ADD COLUMN session_quota_blocked INTEGER NOT NULL DEFAULT 0');
    }
    this.db.exec("UPDATE upstream_keys SET tier='max' WHERE tier NOT IN ('max', 'pro') OR tier IS NULL");
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
    this.clientAccess = new Map();
    this.reloadClientAccess();
  }

  close() {
    this.db.close();
  }

  addUpstreamKey(label, secret, baseUrl = this.defaultUpstreamBaseUrl, useProxyCache = false, tier = null) {
    const value = secret.trim();
    if (!value) throw new Error('密钥不能为空');
    const source = normalizeBaseUrl(baseUrl, this.defaultUpstreamBaseUrl);
    const level = source === this.defaultUpstreamBaseUrl && tier != null ? upstreamTier(tier) : 'max';
    const replaceTier = tier != null || source !== this.defaultUpstreamBaseUrl;
    const hash = sha256(value);
    const previous = this.db.prepare('SELECT base_url FROM upstream_keys WHERE secret_hash=?').get(hash);
    const stamp = now();
    const result = this.db.prepare(`
      INSERT INTO upstream_keys(label, base_url, secret, secret_hash, last4, use_proxy_cache, tier, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(secret_hash) DO UPDATE SET label=excluded.label, base_url=excluded.base_url,
        use_proxy_cache=excluded.use_proxy_cache, tier=CASE WHEN ? THEN excluded.tier ELSE upstream_keys.tier END,
        enabled=1, status='new', last_error='', cooldown_until=0, updated_at=excluded.updated_at
      RETURNING id
    `).get(label.trim() || `Key ${value.slice(-4)}`, source, encrypt(value, this.masterKey), hash, value.slice(-4), useProxyCache ? 1 : 0, level, stamp, stamp, replaceTier ? 1 : 0);
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
      use_proxy_cache: Boolean(row.use_proxy_cache),
      session_quota_blocked: Boolean(row.session_quota_blocked),
      secret: reveal ? decrypt(row.secret, this.masterKey) : undefined,
      secret_hash: undefined,
    }));
  }

  getUpstreamKey(id) {
    const row = this.db.prepare('SELECT * FROM upstream_keys WHERE id=?').get(id);
    return row ? { ...row, id: Number(row.id), enabled: Boolean(row.enabled), use_proxy_cache: Boolean(row.use_proxy_cache), session_quota_blocked: Boolean(row.session_quota_blocked), secret: decrypt(row.secret, this.masterKey), secret_hash: undefined } : null;
  }

  setUpstreamEnabled(id, enabled) {
    this.db.prepare("UPDATE upstream_keys SET enabled=?, status=CASE WHEN ? THEN 'new' ELSE 'paused' END, updated_at=? WHERE id=?")
      .run(enabled ? 1 : 0, enabled ? 1 : 0, now(), id);
  }

  setUpstreamProxyCache(id, enabled) {
    this.db.prepare('UPDATE upstream_keys SET use_proxy_cache=?, updated_at=? WHERE id=?')
      .run(enabled ? 1 : 0, now(), id);
  }

  setUpstreamTier(id, tier) {
    const row = this.db.prepare('SELECT base_url FROM upstream_keys WHERE id=?').get(id);
    if (!row) throw new Error('上游密钥不存在');
    if (row.base_url !== this.defaultUpstreamBaseUrl) throw new Error('外部 API 不使用 Ollama 密钥等级');
    this.db.prepare('UPDATE upstream_keys SET tier=?, updated_at=? WHERE id=?')
      .run(upstreamTier(tier), now(), id);
  }

  setUpstreamSessionQuotaBlocked(id, blocked) {
    this.db.prepare('UPDATE upstream_keys SET session_quota_blocked=? WHERE id=?').run(blocked ? 1 : 0, id);
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
    const access = origin == null ? null : clientAccessMode(origin);
    const result = this.db.prepare(`
      INSERT INTO client_keys(label, token_hash, token_secret, last4, output_tps, allowed_origin, concurrency_limit, created_at)
      VALUES (?, ?, ?, ?, ?, COALESCE(?, ''), COALESCE(?, 0), ?)
      ON CONFLICT(token_hash) DO UPDATE SET label=excluded.label, token_secret=excluded.token_secret,
        output_tps=COALESCE(?, client_keys.output_tps), allowed_origin=COALESCE(?, client_keys.allowed_origin),
        concurrency_limit=COALESCE(?, client_keys.concurrency_limit), enabled=1
      RETURNING id
    `).get(label.trim() || `Client ${value.slice(-4)}`, sha256(value), encrypt(value, this.masterKey), value.slice(-4), normalizedRate,
      access ? access.allowedOrigin : null, access ? access.concurrencyLimit : null, now(), rate == null ? null : normalizedRate,
      access ? access.allowedOrigin : null, access ? access.concurrencyLimit : null);
    const id = Number(result.id);
    this.reloadClientAccess(id);
    return id;
  }

  listClientKeys() {
    return this.db.prepare(`
      SELECT c.id, c.label, c.last4, c.enabled, c.output_tps, c.allowed_origin, c.concurrency_limit, c.created_at, c.token_secret!='' copyable,
        COALESCE(u.prompt_tokens, 0) prompt_tokens,
        COALESCE(u.completion_tokens, 0) completion_tokens,
        COALESCE(u.cached_tokens, 0) cached_tokens,
        COALESCE(u.total_tokens, 0) total_tokens
      FROM client_keys c LEFT JOIN client_usage_totals u ON u.client_key_id=c.id
      ORDER BY c.id
    `).all().map((row) => ({
      ...row,
      id: Number(row.id),
      enabled: Boolean(row.enabled),
      concurrency_limit: Number(row.concurrency_limit),
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
    return this.clientAccess.get(sha256(token)) || null;
  }

  clientKeyCount() {
    return this.clientAccess.size;
  }

  reloadClientAccess(id = null) {
    if (id == null) this.clientAccess.clear();
    else for (const [hash, access] of this.clientAccess) {
      if (access.id === id) this.clientAccess.delete(hash);
    }
    const rows = id == null
      ? this.db.prepare('SELECT id, token_hash, output_tps, allowed_origin, concurrency_limit FROM client_keys WHERE enabled=1').all()
      : this.db.prepare('SELECT id, token_hash, output_tps, allowed_origin, concurrency_limit FROM client_keys WHERE id=? AND enabled=1').all(id);
    for (const row of rows) this.clientAccess.set(row.token_hash, {
      id: Number(row.id),
      outputTps: Number(row.output_tps),
      allowedOrigin: row.allowed_origin,
      concurrencyLimit: Number(row.concurrency_limit),
    });
  }

  setClientEnabled(id, enabled) {
    this.db.prepare('UPDATE client_keys SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id);
    this.reloadClientAccess(id);
  }

  setClientOutputTps(id, rate) {
    this.db.prepare('UPDATE client_keys SET output_tps=? WHERE id=?').run(outputTps(rate), id);
    this.reloadClientAccess(id);
  }

  setClientAllowedOrigin(id, origin) {
    const access = clientAccessMode(origin);
    this.db.prepare('UPDATE client_keys SET allowed_origin=?, concurrency_limit=? WHERE id=?')
      .run(access.allowedOrigin, access.concurrencyLimit, id);
    this.reloadClientAccess(id);
  }

  deleteClientKey(id) {
    this.db.prepare('DELETE FROM client_keys WHERE id=?').run(id);
    this.reloadClientAccess(id);
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
      WITH sources AS (
        SELECT base_url,
          (SELECT label FROM upstream_keys first WHERE first.base_url=keys.base_url ORDER BY id LIMIT 1) source_label,
          SUM(enabled=1) key_count
        FROM upstream_keys keys GROUP BY base_url
      )
      SELECT m.*, COALESCE(s.source_label, m.source_url) source_label, COALESCE(s.key_count, 0) key_count
      FROM models m LEFT JOIN sources s ON s.base_url=m.source_url
      ORDER BY m.source_url, m.name
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
