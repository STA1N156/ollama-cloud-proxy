import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { tempConfig } from '../test-support/helpers.js';

test('旧数据库自动迁移，新下游密钥可复制并统计累计用量', (t) => {
  const config = tempConfig();
  const legacy = new DatabaseSync(config.databasePath);
  legacy.exec(`
    CREATE TABLE client_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      last4 TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    INSERT INTO client_keys(label, token_hash, last4, created_at)
    VALUES ('旧密钥', 'legacy-hash', '0000', 1);
  `);
  legacy.close();

  const store = new Store(config);
  t.after(() => { store.close(); config.cleanup(); });
  const upstreamId = store.addUpstreamKey('上游一', 'upstream-one');
  assert.equal(store.listClientKeys()[0].copyable, false);
  assert.throws(() => store.getClientKeyToken(1), /旧版密钥无法恢复/);

  const id = store.addClientKey('新密钥', 'ocp_copy_me', 10);
  assert.equal(store.getClientKeyToken(id), 'ocp_copy_me');
  assert.deepEqual(store.getClientAccess('ocp_copy_me'), { id, outputTps: 10, allowedOrigin: '' });
  store.setClientOutputTps(id, 12);
  store.setClientAllowedOrigin(id, 'https://sta1n156.github.io');
  store.addClientKey('环境变量密钥', 'ocp_copy_me');
  assert.equal(store.getClientAccess('ocp_copy_me').outputTps, 12);
  assert.equal(store.getClientAccess('ocp_copy_me').allowedOrigin, 'https://sta1n156.github.io');
  assert.throws(() => store.setClientAllowedOrigin(id, 'https://example.com'), /不支持的来源地址/);
  store.queueUsage({
    upstreamKeyId: upstreamId,
    clientKeyId: id,
    model: 'model-a',
    endpoint: '/v1/chat/completions',
    promptTokens: 10,
    completionTokens: 2,
    cachedTokens: 5,
    totalTokens: 12,
    status: 200,
    latencyMs: 20,
  });
  store.flushUsage();
  assert.equal(Number(store.listClientKeys().find((key) => key.id === id).total_tokens), 12);
  const firstSummary = store.summary(1);
  assert.equal(firstSummary.totals.p95_latency_ms, 20);
  assert.equal(Number(firstSummary.byKeyModel[0].key_id), upstreamId);
  for (let index = 1; index < 20; index += 1) {
    store.queueUsage({
      clientKeyId: id,
      model: 'model-a',
      endpoint: '/v1/chat/completions',
      status: 200,
      latencyMs: index * 1000,
    });
  }
  store.flushUsage();
  assert.equal(store.summary(1).totals.p95_latency_ms, 18_000);

  store.clearUsage();
  assert.equal(Number(store.listClientKeys().find((key) => key.id === id).total_tokens), 0);
});

test('旧上游和模型数据自动迁移到默认 API 地址', (t) => {
  const config = tempConfig({ upstreamBaseUrl: 'https://default.example/v1' });
  const legacy = new DatabaseSync(config.databasePath);
  legacy.exec(`
    CREATE TABLE upstream_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, secret TEXT NOT NULL,
      secret_hash TEXT NOT NULL UNIQUE, last4 TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'new', last_error TEXT NOT NULL DEFAULT '', cooldown_until INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE models (
      name TEXT PRIMARY KEY, model TEXT NOT NULL, modified_at TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
      digest TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '{}', synced_at INTEGER NOT NULL
    );
    INSERT INTO models(name, model, synced_at) VALUES ('legacy-model', 'legacy-model', 1);
  `);
  legacy.close();
  const store = new Store(config);
  t.after(() => { store.close(); config.cleanup(); });
  assert.equal(store.listModels()[0].source_url, 'https://default.example/v1');
  const id = store.addUpstreamKey('External', 'external-secret', 'https://external.example/v1/');
  const key = store.getUpstreamKey(id);
  assert.equal(key.base_url, 'https://external.example/v1');
  assert.equal(key.secret, 'external-secret');
});
