import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateQuotaExhaustion, KeyPool } from '../src/key-pool.js';
import { Store } from '../src/store.js';
import { tempConfig } from '../test-support/helpers.js';

test('根据最近多次额度走势估算耗尽时间', () => {
  assert.equal(estimateQuotaExhaustion([
    { at: 0, usage: 0.5 }, { at: 60_000, usage: 0.55 }, { at: 120_000, usage: 0.6 },
  ]), 480_000);
  assert.equal(estimateQuotaExhaustion([{ at: 0, usage: 0.5 }, { at: 60_000, usage: 0.5 }, { at: 120_000, usage: 0.5 }]), null);
  assert.equal(estimateQuotaExhaustion([
    { at: 0, usage: 0.9 }, { at: 60_000, usage: 0.1 }, { at: 120_000, usage: 0.2 },
  ]), null);
});

test('同一模型在健康密钥间公平轮询', async (t) => {
  const config = tempConfig();
  const store = new Store(config);
  store.addUpstreamKey('A', 'key-a');
  store.addUpstreamKey('B', 'key-b');
  const pool = new KeyPool(store);
  t.after(() => { store.close(); config.cleanup(); });

  const ids = [];
  for (let index = 0; index < 4; index += 1) {
    const lease = await pool.acquire('model-a');
    ids.push(lease.id);
    lease.release();
  }
  assert.deepEqual(ids, [1, 2, 1, 2]);
});

test('粘性路由固定已有会话，新会话补偿额度差且并发溢出不改归属', async (t) => {
  const config = tempConfig();
  const store = new Store(config);
  const firstId = store.addUpstreamKey('A', 'key-a');
  const secondId = store.addUpstreamKey('B', 'key-b');
  store.setStickyRoutingEnabled(true);
  const pool = new KeyPool(store);
  t.after(() => { store.close(); config.cleanup(); });

  let lease = await pool.acquire('model-a', new Set(), undefined, undefined, 'session-a');
  assert.equal(lease.id, firstId);
  lease.release();
  lease = await pool.acquire('model-a', new Set(), undefined, undefined, 'session-a');
  assert.equal(lease.id, firstId);
  lease.release();
  lease = await pool.acquire('model-a', new Set(), undefined, undefined, 'session-b');
  assert.equal(lease.id, secondId);
  lease.release();

  pool.updateQuota(firstId, { session: { usage: 0.1 }, weekly: { usage: 0.8 } });
  pool.updateQuota(secondId, { session: { usage: 0.1 }, weekly: { usage: 0.2 } });
  lease = await pool.acquire('model-a', new Set(), undefined, undefined, 'session-a');
  assert.equal(lease.id, firstId);
  lease.release();
  lease = await pool.acquire('model-a', new Set(), undefined, undefined, 'session-c');
  assert.equal(lease.id, secondId);
  lease.release();

  const occupied = [];
  for (let index = 0; index < 10; index += 1) occupied.push(await pool.acquire('model-a', new Set(), undefined, undefined, 'session-a'));
  lease = await pool.acquire('model-a', new Set(), undefined, undefined, 'session-a');
  assert.equal(lease.id, secondId);
  lease.release();
  occupied[0].release();
  lease = await pool.acquire('model-a', new Set(), undefined, undefined, 'session-a');
  assert.equal(lease.id, firstId);
  lease.release();
  occupied.slice(1).forEach((item) => item.release());

  pool.updateQuota(firstId, { session: { usage: 0.95 }, weekly: { usage: 0.8 } });
  lease = await pool.acquire('model-a', new Set(), undefined, undefined, 'session-a');
  assert.equal(lease.id, secondId);
  lease.release();

  assert.deepEqual(pool.stickyStats(), { stickyEnabled: true, stickyEntries: 3, stickyTtlMs: 3_600_000 });
  assert.deepEqual(pool.setStickyEnabled(false), { stickyEnabled: false, stickyEntries: 0, stickyTtlMs: 3_600_000 });
});

test('MAX 与 PRO 按5比1分配且每个模型独立计算', async (t) => {
  const config = tempConfig();
  const store = new Store(config);
  const maxId = store.addUpstreamKey('MAX', 'key-max');
  const proId = store.addUpstreamKey('PRO', 'key-pro');
  store.setUpstreamTier(proId, 'pro');
  const pool = new KeyPool(store);
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

test('优先使用周额度较低的 Ollama 密钥，额度接近后恢复等级权重', async (t) => {
  const config = tempConfig();
  const store = new Store(config);
  const maxId = store.addUpstreamKey('MAX', 'key-max');
  const proId = store.addUpstreamKey('PRO', 'key-pro');
  store.setUpstreamTier(proId, 'pro');
  const pool = new KeyPool(store);
  t.after(() => { store.close(); config.cleanup(); });

  pool.updateQuota(maxId, { weekly: { usage: 0.8 } });
  pool.updateQuota(proId, { weekly: { usage: 0.2 } });
  for (let index = 0; index < 12; index += 1) {
    const lease = await pool.acquire('model-a');
    assert.equal(lease.id, proId);
    lease.release();
  }

  pool.updateQuota(maxId, { weekly: { usage: 0.4 } });
  pool.updateQuota(proId, { weekly: { usage: 0.4 } });
  const assigned = new Map([[maxId, 0], [proId, 0]]);
  for (let index = 0; index < 6; index += 1) {
    const lease = await pool.acquire('model-a');
    assigned.set(lease.id, assigned.get(lease.id) + 1);
    lease.release();
  }
  assert.deepEqual([...assigned.values()], [5, 1]);
});

test('5小时已用额度达到95%后停用，成功刷新至95%以下才恢复', async (t) => {
  const config = tempConfig();
  const store = new Store(config);
  const firstId = store.addUpstreamKey('A', 'key-a');
  const secondId = store.addUpstreamKey('B', 'key-b');
  const pool = new KeyPool(store);
  t.after(() => { store.close(); config.cleanup(); });

  pool.updateQuota(firstId, { session: { usage: 0.949 }, weekly: { usage: 0.1 } });
  pool.updateQuota(secondId, { session: { usage: 0.1 }, weekly: { usage: 0.8 } });
  let lease = await pool.acquire('model-a');
  assert.equal(lease.id, firstId);
  lease.release();

  pool.updateQuota(firstId, { session: { usage: 0.95 }, weekly: { usage: 0.1 } });
  assert.equal(store.getUpstreamKey(firstId).session_quota_blocked, true);
  lease = await pool.acquire('model-a');
  assert.equal(lease.id, secondId);
  lease.release();

  pool.updateQuota(firstId, { session: { usage: 0.95 }, weekly: { usage: 0.1 } });
  lease = await pool.acquire('model-a');
  assert.equal(lease.id, secondId);
  lease.release();

  pool.updateQuota(firstId, { session: { usage: 0.949 }, weekly: { usage: 0.1 } });
  assert.equal(store.getUpstreamKey(firstId).session_quota_blocked, false);
  lease = await pool.acquire('model-a');
  assert.equal(lease.id, firstId);
  lease.release();

  pool.updateQuota(firstId, { session: { usage: 0.95 }, weekly: { usage: 0.1 } });
  const active = [];
  for (let index = 0; index < 10; index += 1) active.push(await pool.acquire('model-a'));
  assert.ok(active.every((item) => item.id === secondId));
  const waiting = pool.acquire('model-a');
  await new Promise((resolve) => setImmediate(resolve));
  pool.updateQuota(firstId, { session: { usage: 0.949 }, weekly: { usage: 0.1 } });
  lease = await waiting;
  assert.equal(lease.id, firstId);
  lease.release();
  active.forEach((item) => item.release());
});

test('失效密钥自动退出轮询', async (t) => {
  const config = tempConfig();
  const store = new Store(config);
  store.addUpstreamKey('A', 'key-a');
  store.addUpstreamKey('B', 'key-b');
  const pool = new KeyPool(store);
  t.after(() => { store.close(); config.cleanup(); });
  pool.report(1, 'invalid', 'HTTP 401');
  const lease = await pool.acquire('model-a');
  assert.equal(lease.id, 2);
  lease.release();
});

test('高并发时 MAX 固定10并发、PRO 固定3并发', async (t) => {
  const config = tempConfig();
  const store = new Store(config);
  store.addUpstreamKey('A', 'key-a');
  const proId = store.addUpstreamKey('B', 'key-b');
  store.setUpstreamTier(proId, 'pro');
  const pool = new KeyPool(store);
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

  assert.ok(assigned.get(1) > assigned.get(2));
  assert.ok(peak.get(1) <= 10);
  assert.ok(peak.get(2) <= 3);
});

test('外部 API 密钥不受单密钥并发上限限制', (t) => {
  const config = tempConfig();
  const store = new Store(config);
  store.addUpstreamKey('External', 'key-a', 'https://external.example/v1');
  const pool = new KeyPool(store);
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
  const pool = new KeyPool(store);
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
  await assert.rejects(pool.acquire('missing-model'), /API 暂时不可用/);
  assert.deepEqual(shared, ['Ollama', 'External']);
});
