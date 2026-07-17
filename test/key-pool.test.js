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
