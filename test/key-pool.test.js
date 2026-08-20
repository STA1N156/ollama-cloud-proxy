import assert from 'node:assert/strict';
import test from 'node:test';
import { KeyPool } from '../src/key-pool.js';
import { Store } from '../src/store.js';
import { tempConfig } from '../test-support/helpers.js';

test('同一模型在健康密钥间公平轮询', async (t) => {
  const config = tempConfig();
  const store = new Store(config);
  store.addUpstreamKey('A', 'key-a');
  store.addUpstreamKey('B', 'key-b');
  const pool = new KeyPool(store, 1);
  t.after(() => { store.close(); config.cleanup(); });

  const ids = [];
  for (let index = 0; index < 4; index += 1) {
    const lease = await pool.acquire('model-a');
    ids.push(lease.id);
    lease.release();
  }
  assert.deepEqual(ids, [1, 2, 1, 2]);
});

test('MAX 与 PRO 按5比1分配且每个模型独立计算', async (t) => {
  const config = tempConfig();
  const store = new Store(config);
  const maxId = store.addUpstreamKey('MAX', 'key-max');
  const proId = store.addUpstreamKey('PRO', 'key-pro');
  store.setUpstreamTier(proId, 'pro');
  const pool = new KeyPool(store, 32);
  t.after(() => { store.close(); config.cleanup(); });

  const assigned = new Map([[maxId, 0], [proId, 0]]);
  for (let index = 0; index < 120; index += 1) {
    const lease = await pool.acquire('model-a');
    assigned.set(lease.id, assigned.get(lease.id) + 1);
    lease.release();
  }
  assert.deepEqual([...assigned.values()], [100, 20]);

  const modelA = [];
  const modelB = [];
  pool.reload();
  for (let index = 0; index < 4; index += 1) {
    const lease = await pool.acquire('model-a');
    modelA.push(lease.id);
    lease.release();
  }
  const lease = await pool.acquire('model-b');
  modelB.push(lease.id);
  lease.release();
  assert.deepEqual(modelA, [maxId, maxId, maxId, proId]);
  assert.deepEqual(modelB, [maxId]);
});

test('失效密钥自动退出轮询', async (t) => {
  const config = tempConfig();
  const store = new Store(config);
  store.addUpstreamKey('A', 'key-a');
  store.addUpstreamKey('B', 'key-b');
  const pool = new KeyPool(store, 1);
  t.after(() => { store.close(); config.cleanup(); });
  pool.report(1, 'invalid', 'HTTP 401');
  const lease = await pool.acquire('model-a');
  assert.equal(lease.id, 2);
  lease.release();
});

test('高并发时遵守单密钥上限并保持均匀分配', async (t) => {
  const config = tempConfig();
  const store = new Store(config);
  store.addUpstreamKey('A', 'key-a');
  store.addUpstreamKey('B', 'key-b');
  const pool = new KeyPool(store, 3);
  t.after(() => { store.close(); config.cleanup(); });

  const active = new Map([[1, 0], [2, 0]]);
  const peak = new Map([[1, 0], [2, 0]]);
  const assigned = new Map([[1, 0], [2, 0]]);
  await Promise.all(Array.from({ length: 60 }, async () => {
    const lease = await pool.acquire('model-a');
    const now = active.get(lease.id) + 1;
    active.set(lease.id, now);
    peak.set(lease.id, Math.max(peak.get(lease.id), now));
    assigned.set(lease.id, assigned.get(lease.id) + 1);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active.set(lease.id, active.get(lease.id) - 1);
    lease.release();
  }));

  assert.deepEqual([...assigned.values()], [30, 30]);
  assert.ok([...peak.values()].every((value) => value <= 3));
});

test('外部 API 密钥不受单密钥并发上限限制', (t) => {
  const config = tempConfig();
  const store = new Store(config);
  store.addUpstreamKey('External', 'key-a', 'https://external.example/v1');
  const pool = new KeyPool(store, 1);
  t.after(() => { store.close(); config.cleanup(); });

  const first = pool.tryAcquire('model-a');
  const second = pool.tryAcquire('model-a');
  assert.ok(first);
  assert.ok(second);
  first.release();
  second.release();
});

test('只把模型请求分配给提供该模型的 API 通道', async (t) => {
  const config = tempConfig();
  const store = new Store(config);
  store.addUpstreamKey('Ollama', 'key-a', config.upstreamBaseUrl);
  store.addUpstreamKey('External', 'key-b', 'https://external.example/v1');
  store.replaceModels(config.upstreamBaseUrl, [{ name: 'model-a' }, { name: 'shared' }]);
  store.replaceModels('https://external.example/v1', [{ name: 'model-b' }, { name: 'shared' }]);
  const pool = new KeyPool(store, 2);
  t.after(() => { store.close(); config.cleanup(); });

  const modelB = await pool.acquire('model-b');
  assert.equal(modelB.label, 'External');
  modelB.release();
  const shared = [];
  for (let index = 0; index < 2; index += 1) {
    const lease = await pool.acquire('shared');
    shared.push(lease.label);
    lease.release();
  }
  assert.deepEqual(shared, ['Ollama', 'External']);
});
