import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempConfig(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-proxy-test-'));
  return {
    dataDir,
    databasePath: path.join(dataDir, 'proxy.db'),
    masterKeyPath: path.join(dataDir, 'master.key'),
    allowAnonymous: false,
    upstreamBaseUrl: 'http://127.0.0.1/v1',
    modelSyncUrl: 'http://127.0.0.1/api/tags',
    modelSyncIntervalMs: 600_000,
    cacheTtlMs: 3_600_000,
    maxInflightPerKey: 4,
    maxRequestBytes: 1024 * 1024,
    responseHeaderTimeoutMs: 5000,
    retryCount: 10,
    ...overrides,
    cleanup() { fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}
