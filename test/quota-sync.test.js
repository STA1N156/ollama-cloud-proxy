import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { KeyPool } from '../src/key-pool.js';
import { QuotaSync } from '../src/quota-sync.js';
import { Store } from '../src/store.js';
import { tempConfig } from '../test-support/helpers.js';

test('按 Ollama 密钥读取官方额度并按模型调用次数排序', async (t) => {
  const upstream = http.createServer((req, res) => {
    const pro = req.headers.authorization === 'Bearer key-pro';
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization === 'Bearer key-monthly') return res.end(JSON.stringify({
      activity: { cost: '0.00000', period: { type: 'last_4_weeks' } },
      limits: { monthly: { usage: 0.4, models: [{ name: 'monthly-small', request_count: 2 }, { name: 'monthly-large', request_count: 12 }] } },
    }));
    res.end(JSON.stringify({
      activity: { cost: pro ? '1.25000' : '0.00000', period: { starting_at: '2026-08-01T00:00:00Z', ending_at: '2026-08-20T00:00:00Z' } },
      limits: {
        session: { usage: pro ? 0.2 : 0.1, models: [{ name: 'small', request_count: 2 }, { name: 'large', request_count: 10 }] },
        weekly: { usage: pro ? 0.6 : 0.3, models: [{ name: 'weekly', request_count: 30 }] },
      },
    }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const config = tempConfig({ upstreamBaseUrl: `${origin}/v1`, quotaSyncUrl: `${origin}/api/usage` });
  const store = new Store(config);
  store.addUpstreamKey('MAX', 'key-max');
  store.addUpstreamKey('PRO', 'key-pro');
  store.addUpstreamKey('Monthly', 'key-monthly');
  store.addUpstreamKey('External', 'external-key', `${origin}/external/v1`);
  const pool = new KeyPool(store);
  const sync = new QuotaSync(config, store, pool);
  t.after(() => { upstream.close(); store.close(); config.cleanup(); });

  await sync.refresh(true);
  const keys = pool.snapshot();
  assert.equal(keys[0].quota.weekly.usage, 0.3);
  assert.deepEqual(keys[0].quota.session.models.map((item) => item.name), ['large', 'small']);
  assert.equal(keys[1].quota.weekly.usage, 0.6);
  assert.equal(keys[2].quota.monthly.usage, 0.4);
  assert.deepEqual(keys[2].quota.monthly.models.map((item) => item.name), ['monthly-large', 'monthly-small']);
  assert.equal(keys[2].quota.weekly, undefined);
  assert.equal(keys[3].quota, undefined);
});
