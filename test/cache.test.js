import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFingerprint, CacheLedger, cachedTokenCount } from '../src/cache.js';
import { Store } from '../src/store.js';
import { tempConfig } from '../test-support/helpers.js';

test('缓存指纹忽略模型、采样参数和 JSON 对象字段顺序', () => {
  const key = Buffer.alloc(32, 7);
  const left = buildFingerprint('/v1/chat/completions', {
    model: 'model-a', temperature: 0.2,
    tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    messages: [{ role: 'user', content: '上海天气' }],
  }, key);
  const right = buildFingerprint('/v1/chat/completions', {
    model: 'model-b', temperature: 1,
    tools: [{ function: { parameters: { properties: { city: { type: 'string' } }, type: 'object' }, name: 'weather' }, type: 'function' }],
    messages: [{ content: '上海天气', role: 'user' }],
  }, key);
  assert.deepEqual(left.entries, right.entries);
});

test('工具数组顺序变化不会误判为命中', () => {
  const key = Buffer.alloc(32, 8);
  const request = { tools: [{ name: 'a' }, { name: 'b' }], messages: [{ role: 'user', content: 'x' }] };
  const reversed = { tools: [{ name: 'b' }, { name: 'a' }], messages: [{ role: 'user', content: 'x' }] };
  assert.notEqual(
    buildFingerprint('/v1/chat/completions', request, key).entries.at(-1).hash,
    buildFingerprint('/v1/chat/completions', reversed, key).entries.at(-1).hash,
  );
});

test('Responses 输出 Schema 变化不会误判为命中', () => {
  const key = Buffer.alloc(32, 9);
  const request = { input: 'x', text: { format: { type: 'json_schema', name: 'a' } } };
  const changed = { input: 'x', text: { format: { type: 'json_schema', name: 'b' } } };
  assert.notEqual(
    buildFingerprint('/v1/responses', request, key).entries.at(-1).hash,
    buildFingerprint('/v1/responses', changed, key).entries.at(-1).hash,
  );
});

test('支持完整命中、同模型前缀 token 和跨模型估算', (t) => {
  const config = tempConfig();
  const store = new Store(config);
  const ledger = new CacheLedger(store, config.cacheTtlMs);
  t.after(() => { ledger.close(); store.close(); config.cleanup(); });

  const first = buildFingerprint('/v1/chat/completions', {
    messages: [{ role: 'system', content: '规则' }, { role: 'user', content: '问题' }],
  }, store.masterKey);
  assert.equal(ledger.lookup(first, 'model-a').matched, false);
  ledger.register(first, 'model-a', 50);

  const immediate = ledger.lookup(first, 'model-a');
  assert.equal(immediate.exact, true);
  assert.equal(immediate.observedTokens, 50);

  const exact = ledger.lookup(first, 'model-b');
  assert.equal(exact.exact, true);
  assert.equal(cachedTokenCount(exact, 80, first.totalWeight), 80);

  const extended = buildFingerprint('/v1/chat/completions', {
    messages: [
      { role: 'system', content: '规则' },
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '回答' },
    ],
  }, store.masterKey);
  const sameModel = ledger.lookup(extended, 'model-a');
  assert.equal(sameModel.exact, false);
  assert.equal(cachedTokenCount(sameModel, 90, extended.totalWeight), 50);
  const crossModel = ledger.lookup(extended, 'model-b');
  const estimated = cachedTokenCount(crossModel, 90, extended.totalWeight);
  assert.ok(estimated > 0 && estimated < 90);

  ledger.register(extended, 'model-a', 90);
  const continued = buildFingerprint('/v1/chat/completions', {
    messages: [
      { role: 'system', content: '规则' },
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '回答' },
      { role: 'user', content: '继续' },
    ],
  }, store.masterKey);
  assert.equal(ledger.lookup(continued, 'model-a').observedTokens, 90);
});

test('缓存大小统计实际哈希索引空间，不累计原始上下文长度', (t) => {
  const config = tempConfig();
  const store = new Store(config);
  const ledger = new CacheLedger(store, config.cacheTtlMs);
  t.after(() => { ledger.close(); store.close(); config.cleanup(); });

  const fingerprint = buildFingerprint('/v1/chat/completions', {
    messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }],
  }, store.masterKey);
  ledger.register(fingerprint, 'model-a', 1000);
  const stats = ledger.stats();
  assert.equal(stats.entries, 1);
  assert.ok(stats.indexedBytes < fingerprint.totalWeight / 4);
});
