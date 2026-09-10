import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFingerprint, CacheLedger, cachedTokenCount } from '../src/cache.js';
import { hmac256 } from '../src/crypto.js';
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

test('工具控制方式和随机调用 ID 不会破坏缓存', () => {
  const key = Buffer.alloc(32, 4);
  const request = (id, toolChoice, reversed = false) => ({
    tool_choice: toolChoice,
    tools: [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object' } } }],
    messages: [
      { role: 'user', content: '搜索 Ollama 新闻' },
      { role: 'assistant', content: '', tool_calls: [reversed
        ? { function: { arguments: '{"query":"Ollama"}', name: 'web_search' }, type: 'function', id }
        : { id, type: 'function', function: { name: 'web_search', arguments: '{"query":"Ollama"}' } }] },
      { role: 'tool', tool_call_id: id, content: '搜索结果' },
    ],
  });
  const required = buildFingerprint('/v1/chat/completions', request('call_random_a', 'required'), key);
  const automatic = buildFingerprint('/v1/chat/completions', request('call_random_b', 'auto', true), key);
  assert.deepEqual(required.entries, automatic.entries);
});

test('不同工具参数和返回内容仍然不会误判为命中', () => {
  const key = Buffer.alloc(32, 3);
  const request = (query, result) => ({
    tools: [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object' } } }],
    messages: [
      { role: 'user', content: '搜索新闻' },
      { role: 'assistant', tool_calls: [{ id: 'call_random', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query }) } }] },
      { role: 'tool', tool_call_id: 'call_random', content: result },
    ],
  });
  const ollama = buildFingerprint('/v1/chat/completions', request('Ollama', '结果 A'), key);
  const changedArguments = buildFingerprint('/v1/chat/completions', request('DeepSeek', '结果 A'), key);
  const changedResult = buildFingerprint('/v1/chat/completions', request('Ollama', '结果 B'), key);
  assert.notEqual(ollama.entries.at(-1).hash, changedArguments.entries.at(-1).hash);
  assert.notEqual(ollama.entries.at(-1).hash, changedResult.entries.at(-1).hash);
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

test('第三方基础缓存支持完整命中、同模型前缀 token 和跨模型估算', async (t) => {
  const config = tempConfig();
  const store = new Store(config);
  const ledger = new CacheLedger(store, config.cacheTtlMs);
  t.after(async () => { await ledger.close(); store.close(); config.cleanup(); });

  const endpoint = '/v1/chat/completions';
  const request = { messages: [{ role: 'system', content: '规则' }, { role: 'user', content: '问题' }] };
  const { fingerprint: first, hit: miss } = await ledger.resolve(endpoint, request, 'model-a');
  assert.deepEqual(first, buildFingerprint(endpoint, request, store.masterKey));
  assert.equal(miss.matched, false);
  ledger.register(first, 'model-a', 50);

  const { hit: immediate } = await ledger.resolve(endpoint, request, 'model-a');
  assert.equal(immediate.exact, true);
  assert.equal(immediate.observedTokens, 50);

  const { hit: exact } = await ledger.resolve(endpoint, request, 'model-b');
  assert.equal(exact.exact, true);
  assert.equal(cachedTokenCount(exact, 80, first.totalWeight), 80);

  request.messages.push({ role: 'assistant', content: '回答' });
  const { fingerprint: extended, hit: sameModel } = await ledger.resolve(endpoint, request, 'model-a');
  assert.equal(sameModel.exact, false);
  assert.equal(cachedTokenCount(sameModel, 90, extended.totalWeight), 50);
  const { hit: crossModel } = await ledger.resolve(endpoint, request, 'model-b');
  const estimated = cachedTokenCount(crossModel, 90, extended.totalWeight);
  assert.ok(estimated > 0 && estimated < 90);

  ledger.register(extended, 'model-a', 90);
  request.messages.push({ role: 'user', content: '继续' });
  assert.equal((await ledger.resolve(endpoint, request, 'model-a')).hit.observedTokens, 90);

  await ledger.flush();
  const lifetime = store.db.prepare('SELECT expires_at - updated_at ttl FROM prompt_cache LIMIT 1').get();
  assert.equal(Number(lifetime.ttl), 3_600_000);
  store.db.prepare('UPDATE prompt_cache SET expires_at=?').run(Date.now() - 1);
  assert.equal((await ledger.resolve(endpoint, request, 'model-a')).hit.matched, false);
});

test('基础缓存仅存储哈希索引，不保存原文或内容分块', async (t) => {
  const config = tempConfig();
  const store = new Store(config);
  const ledger = new CacheLedger(store, config.cacheTtlMs);
  t.after(async () => { await ledger.close(); store.close(); config.cleanup(); });

  const { fingerprint } = await ledger.resolve('/v1/chat/completions', {
    messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }],
  }, 'model-a');
  assert.deepEqual(Object.keys(fingerprint), ['endpoint', 'entries', 'totalWeight']);
  ledger.register(fingerprint, 'model-a', 1000);
  await ledger.flush();
  assert.equal(store.db.prepare('SELECT COUNT(*) count FROM prompt_cache').get().count, 1);
  const { size } = store.db.prepare("SELECT SUM(pgsize) size FROM dbstat WHERE name GLOB '*cache*'").get();
  assert.ok(size < fingerprint.totalWeight / 4);
});
