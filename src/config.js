import path from 'node:path';

const bool = (name, fallback) => {
  const value = process.env[name];
  return value == null ? fallback : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const integer = (name, fallback, min = 1) => {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= min ? value : fallback;
};

const duration = (name, fallback) => {
  const value = process.env[name];
  if (!value) return fallback;
  const match = value.trim().match(/^(\d+)(ms|s|m|h)$/i);
  if (!match) return fallback;
  return Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2].toLowerCase()];
};

const list = (name) => (process.env[name] ?? '')
  .split(/[\n,]+/)
  .map((value) => value.trim())
  .filter(Boolean);

const dataDir = path.resolve(process.env.DATA_DIR || './data');
const upstreamBaseUrl = (process.env.UPSTREAM_BASE_URL || 'https://ollama.com/v1').replace(/\/$/, '');

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: integer('PORT', 8080),
  dataDir,
  databasePath: path.join(dataDir, 'proxy.db'),
  masterKeyPath: path.join(dataDir, 'master.key'),
  adminPassword: process.env.ADMIN_PASSWORD || '123456',
  allowAnonymous: bool('ALLOW_ANONYMOUS', false),
  upstreamBaseUrl,
  modelSyncUrl: process.env.MODEL_SYNC_URL || (new URL(upstreamBaseUrl).hostname === 'ollama.com' ? 'https://ollama.com/api/tags' : `${upstreamBaseUrl}/models`),
  modelSyncIntervalMs: duration('MODEL_SYNC_INTERVAL', 10 * 60_000),
  cacheTtlMs: duration('CACHE_TTL', 60 * 60_000),
  maxInflightPerKey: integer('MAX_INFLIGHT_PER_KEY', 32),
  maxRequestBytes: integer('MAX_REQUEST_BYTES', 32 * 1024 * 1024),
  responseHeaderTimeoutMs: duration('RESPONSE_HEADER_TIMEOUT', 600_000),
  retryCount: Math.min(10, integer('UPSTREAM_RETRIES', 10)),
  upstreamKeys: list('OLLAMA_API_KEYS'),
  clientKeys: list('PROXY_API_KEYS'),
};
