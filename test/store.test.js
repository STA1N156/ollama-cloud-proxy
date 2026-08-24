import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { UsageLedger } from '../src/usage.js';
import { tempConfig } from '../test-support/helpers.js';

test('错误提示可修改、持久化并一键恢复默认', (t) => {
  const config = tempConfig();
  let store = new Store(config);
  t.after(() => { store.close(); config.cleanup(); });
  assert.equal(store.errorMessage('api_unavailable'), 'API 暂时不可用');
  store.setErrorMessages({ api_unavailable: '请稍后再试', model_not_found: '找不到 {model}' });
  assert.equal(store.errorMessage('model_not_found', { model: 'demo' }), '找不到 demo');
  store.close();
  store = new Store(config);
  assert.equal(store.errorMessage('api_unavailable'), '请稍后再试');
  assert.throws(() => store.setErrorMessages({ unknown: '错误' }), /未知错误提示/);
  assert.throws(() => store.setErrorMessages({ api_unavailable: '' }), /不能为空/);
  store.resetErrorMessages();
  assert.equal(store.errorMessage('api_unavailable'), 'API 暂时不可用');
});

test('粘性路由开关默认关闭并持久化', (t) => {
  const config = tempConfig();
  let store = new Store(config);
  t.after(() => { store.close(); config.cleanup(); });
  assert.equal(store.stickyRoutingEnabled(), false);
  store.setStickyRoutingEnabled(true);
  store.close();
  store = new Store(config);
  assert.equal(store.stickyRoutingEnabled(), true);
});

test('旧白名单2自动合并到统一白名单', (t) => {
  const config = tempConfig();
  const legacy = new DatabaseSync(config.databasePath);
  legacy.exec(`
    CREATE TABLE client_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      token_secret TEXT NOT NULL DEFAULT '', last4 TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      output_tps INTEGER NOT NULL DEFAULT 0, allowed_origin TEXT NOT NULL DEFAULT '',
      concurrency_limit INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    INSERT INTO client_keys(label, token_hash, last4, allowed_origin, concurrency_limit, created_at)
    VALUES ('旧白名单2', 'legacy-router', '0000', 'codex-router', 60, 1);
  `);
  legacy.close();

  const store = new Store(config);
  t.after(() => { store.close(); config.cleanup(); });
  assert.equal(store.listClientKeys()[0].allowed_origin, 'https://sta1n156.github.io');
  assert.equal(store.listClientKeys()[0].concurrency_limit, 40);
});

test('旧数据库自动迁移，新下游密钥可复制并统计累计用量', async (t) => {
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
  const usage = new UsageLedger(store);
  t.after(async () => { await usage.close(); store.close(); config.cleanup(); });
  store.addUpstreamKey('上游一', 'upstream-one');
  assert.equal(store.listClientKeys()[0].copyable, false);
  assert.throws(() => store.getClientKeyToken(1), /旧版密钥无法恢复/);

  const id = store.addClientKey('新密钥', 'ocp_copy_me', 10);
  assert.equal(store.getClientKeyToken(id), 'ocp_copy_me');
  assert.deepEqual(store.getClientAccess('ocp_copy_me'), { id, outputTps: 10, allowedOrigin: '', concurrencyLimit: 0 });
  store.setClientOutputTps(id, 12);
  store.setClientAllowedOrigin(id, 'https://sta1n156.github.io');
  store.addClientKey('环境变量密钥', 'ocp_copy_me');
  assert.equal(store.getClientAccess('ocp_copy_me').outputTps, 12);
  assert.equal(store.getClientAccess('ocp_copy_me').allowedOrigin, 'https://sta1n156.github.io');
  store.setClientAllowedOrigin(id, 'codex-router');
  assert.equal(store.getClientAccess('ocp_copy_me').allowedOrigin, 'https://sta1n156.github.io');
  store.setClientAllowedOrigin(id, 'limit:3');
  assert.equal(store.getClientAccess('ocp_copy_me').concurrencyLimit, 3);
  store.setClientAllowedOrigin(id, 'limit:35');
  assert.deepEqual(store.getClientAccess('ocp_copy_me'), { id, outputTps: 12, allowedOrigin: 'https://sta1n156.github.io', concurrencyLimit: 35 });
  assert.throws(() => store.setClientAllowedOrigin(id, 'limit:50'), /不支持的访问控制模式/);
  usage.record({
    clientKeyId: id,
    promptTokens: 10,
    completionTokens: 2,
    cachedTokens: 5,
    totalTokens: 12,
  });
  await usage.flush();
  assert.equal(Number(store.listClientKeys().find((key) => key.id === id).total_tokens), 12);
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_events'").get(), undefined);
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_hourly'").get(), undefined);

  await usage.clear();
  assert.equal(Number(store.listClientKeys().find((key) => key.id === id).total_tokens), 0);
  store.setClientEnabled(id, false);
  assert.equal(store.getClientAccess('ocp_copy_me'), null);
  store.setClientEnabled(id, true);
  assert.equal(store.getClientAccess('ocp_copy_me').outputTps, 12);
  store.deleteClientKey(id);
  assert.equal(store.getClientAccess('ocp_copy_me'), null);
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
  assert.ok(store.db.prepare('PRAGMA table_info(upstream_keys)').all().some((column) => column.name === 'tier'));
  const officialId = store.addUpstreamKey('Ollama PRO', 'official-secret', config.upstreamBaseUrl, false, 'pro');
  assert.equal(store.getUpstreamKey(officialId).tier, 'pro');
  store.addUpstreamKey('环境变量重新导入', 'official-secret', config.upstreamBaseUrl);
  assert.equal(store.getUpstreamKey(officialId).tier, 'pro');
  const sameSecretExternalId = store.addUpstreamKey('同密钥外部渠道', 'official-secret', 'https://second.example/v1');
  assert.notEqual(sameSecretExternalId, officialId);
  assert.equal(store.addUpstreamKey('重复导入同一渠道', 'official-secret', 'https://second.example/v1'), sameSecretExternalId);
  assert.equal(store.listUpstreamKeys().filter((key) => key.last4 === 'cret').length, 2);
  store.setUpstreamTier(officialId, 'max');
  assert.equal(store.getUpstreamKey(officialId).tier, 'max');
  const id = store.addUpstreamKey('External', 'external-secret', 'https://external.example/v1/');
  const key = store.getUpstreamKey(id);
  assert.equal(key.base_url, 'https://external.example/v1');
  assert.equal(key.secret, 'external-secret');
  assert.equal(key.use_proxy_cache, false);
  store.setUpstreamProxyCache(id, true);
  assert.equal(store.getUpstreamKey(id).use_proxy_cache, true);
  assert.equal(store.getUpstreamKey(id).tier, 'max');
  assert.throws(() => store.setUpstreamTier(id, 'pro'), /外部 API/);
  assert.throws(() => store.setUpstreamTier(officialId, 'vip'), /MAX 或 PRO/);
});

test('下游鉴权关闭数据库后仍从内存读取', () => {
  const config = tempConfig();
  const store = new Store(config);
  const id = store.addClientKey('内存密钥', 'memory-client', 15, 'https://sta1n156.github.io');
  store.close();
  assert.deepEqual(store.getClientAccess('memory-client'), {
    id, outputTps: 15, allowedOrigin: 'https://sta1n156.github.io', concurrencyLimit: 0,
  });
  assert.equal(store.clientKeyCount(), 1);
  config.cleanup();
});
