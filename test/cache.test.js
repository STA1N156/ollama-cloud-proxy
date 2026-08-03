import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFingerprint, CacheLedger, cachedTokenCount } from '../src/cache.js';
import { hmac256 } from '../src/crypto.js';
import { Store } from '../src/store.js';
import { tempConfig } from '../test-support/helpers.js';

const rpSection = (name, length) => Array.from({ length }, (_, index) => (
  `${name}第${index}条：角色在${index % 17}号地点遇见${(index * 7) % 31}号人物，携带${(index * index) % 97}枚银币；情绪值为${index % 9}。`
)).join('\n');

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

test('连续哈希只把上一段摘要带入下一段', () => {
  const key = Buffer.alloc(32, 6);
  const endpoint = '/v1/chat/completions';
  const fingerprint = buildFingerprint(endpoint, {
    messages: [{ role: 'user', content: '一' }, { role: 'assistant', content: '二' }],
  }, key);
  const seed = hmac256(key, `${endpoint}\u001f`);
  const first = hmac256(key, `${seed}\u001e{"content":"一","role":"user"}`);
  const second = hmac256(key, `${first}\u001e{"content":"二","role":"assistant"}`);
  assert.deepEqual(fingerprint.entries.map((entry) => entry.hash), [first, second]);
});

test('支持完整命中、同模型前缀 token 和跨模型估算', async (t) => {
  const config = tempConfig();
  const store = new Store(config);
  const ledger = new CacheLedger(store, config.cacheTtlMs);
  t.after(async () => { await ledger.close(); store.close(); config.cleanup(); });

  const first = buildFingerprint('/v1/chat/completions', {
    messages: [{ role: 'system', content: '规则' }, { role: 'user', content: '问题' }],
  }, store.masterKey);
  assert.equal((await ledger.lookup(first, 'model-a')).matched, false);
  ledger.register(first, 'model-a', 50);

  const immediate = await ledger.lookup(first, 'model-a');
  assert.equal(immediate.exact, true);
  assert.equal(immediate.observedTokens, 50);

  const exact = await ledger.lookup(first, 'model-b');
  assert.equal(exact.exact, true);
  assert.equal(cachedTokenCount(exact, 80, first.totalWeight), 80);

  const extended = buildFingerprint('/v1/chat/completions', {
    messages: [
      { role: 'system', content: '规则' },
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '回答' },
    ],
  }, store.masterKey);
  const sameModel = await ledger.lookup(extended, 'model-a');
  assert.equal(sameModel.exact, false);
  assert.equal(cachedTokenCount(sameModel, 90, extended.totalWeight), 50);
  const crossModel = await ledger.lookup(extended, 'model-b');
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
  assert.equal((await ledger.lookup(continued, 'model-a')).observedTokens, 90);
});

test('缓存大小统计实际哈希索引空间，不累计原始上下文长度', async (t) => {
  const config = tempConfig();
  const store = new Store(config);
  const ledger = new CacheLedger(store, config.cacheTtlMs);
  t.after(async () => { await ledger.close(); store.close(); config.cleanup(); });

  const fingerprint = buildFingerprint('/v1/chat/completions', {
    messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }],
  }, store.masterKey);
  ledger.register(fingerprint, 'model-a', 1000);
  const stats = await ledger.stats();
  assert.equal(stats.entries, 1);
  assert.ok(stats.indexedBytes < fingerprint.totalWeight / 4);
  await ledger.clear();
  assert.equal((await ledger.stats()).entries, 0);
});

test('RP 分块不受世界书插入位置变化影响', () => {
  const key = Buffer.alloc(32, 5);
  const role = rpSection('角色', 120);
  const world = rpSection('世界', 120);
  const history = rpSection('历史', 120);
  const inserted = rpSection('临时世界书', 20);
  const fingerprint = (content) => buildFingerprint('/v1/chat/completions', {
    messages: [{ role: 'system', content }, { role: 'user', content: '继续剧情' }],
  }, key);
  const before = fingerprint(role + world + history + inserted);
  const moved = fingerprint(role + inserted + world + history);
  const known = new Set(before.rpChunks.map((chunk) => chunk.hash));
  const sharedWeight = moved.rpChunks.filter((chunk) => known.has(chunk.hash)).reduce((sum, chunk) => sum + chunk.weight, 0);

  assert.notEqual(before.entries.at(-1).hash, moved.entries.at(-1).hash);
  assert.ok(sharedWeight > moved.rpTotalWeight * 0.7);
});

test('RP 缓存默认关闭但持续储存，开启后立即命中并在一小时过期', async (t) => {
  const config = tempConfig();
  const store = new Store(config);
  let ledger = new CacheLedger(store, config.cacheTtlMs);
  t.after(async () => { await ledger?.close(); store.close(); config.cleanup(); });

  const role = rpSection('角色', 120);
  const world = rpSection('世界', 120);
  const history = rpSection('历史', 120);
  const inserted = rpSection('临时世界书', 20);
  const fingerprint = (content) => buildFingerprint('/v1/chat/completions', {
    messages: [{ role: 'system', content }, { role: 'user', content: '继续剧情' }],
  }, store.masterKey);
  const before = fingerprint(role + world + history + inserted);
  const moved = fingerprint(role + inserted + world + history);

  ledger.register(before, 'model-a', 2000);
  await ledger.flush();
  const disabled = await ledger.stats();
  assert.equal(disabled.rpEnabled, false);
  assert.ok(disabled.rpEntries > 0);
  assert.equal(disabled.limitBytes, 512 * 1024 * 1024);
  assert.equal((await ledger.lookup(moved, 'model-a')).matched, false);
  assert.equal(Number(store.db.prepare('SELECT expires_at - updated_at ttl FROM prompt_cache_rp LIMIT 1').get().ttl), 60 * 60_000);

  await ledger.setRpEnabled(true);
  const hit = await ledger.lookup(moved, 'model-b');
  assert.equal(hit.type, 'rp');
  assert.ok(cachedTokenCount(hit, 2000, moved.totalWeight) > 1000);

  await ledger.close();
  ledger = new CacheLedger(store, config.cacheTtlMs);
  assert.equal((await ledger.stats()).rpEnabled, true);
  store.db.prepare('UPDATE prompt_cache_rp SET expires_at=?').run(Date.now() - 1);
  assert.equal((await ledger.stats()).rpEntries, 0);
  await ledger.clear();
  assert.equal((await ledger.stats()).rpEntries, 0);
});
