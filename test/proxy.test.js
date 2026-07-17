import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { CacheLedger } from '../src/cache.js';
import { KeyPool } from '../src/key-pool.js';
import { injectUsage, ProxyHandler } from '../src/proxy.js';
import { Store } from '../src/store.js';
import { tempConfig } from '../test-support/helpers.js';

const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
};

test('按 New API 可识别的标准字段回报 Chat 和 Responses 缓存 token', () => {
  const hit = { matched: true, exact: true, weight: 10, observedTokens: 0 };
  const chat = injectUsage(JSON.stringify({
    usage: { prompt_tokens: 80, completion_tokens: 5, total_tokens: 85 },
  }), hit, 10);
  assert.equal(JSON.parse(chat.data).usage.prompt_tokens_details.cached_tokens, 80);

  const responses = injectUsage(JSON.stringify({
    response: { usage: { input_tokens: 90, output_tokens: 6, total_tokens: 96 } },
  }), hit, 10);
  assert.equal(JSON.parse(responses.data).response.usage.input_tokens_details.cached_tokens, 90);
});

test('401 自动换钥，并把跨模型缓存 token 注入非流式和流式 usage', async (t) => {
  const received = [];
  const upstreamServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    received.push({ auth: req.headers.authorization, body });
    if (req.headers.authorization === 'Bearer bad-key') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"error":"bad key"}');
    }
    const prompt = body.model === 'model-a' ? 100 : body.stream ? 130 : 120;
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"}}],"usage":null}\n\n');
      res.write(`data: {"id":"x","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":${prompt},"completion_tokens":2,"total_tokens":${prompt + 2}}}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    const response = JSON.stringify({
      id: 'x', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: prompt, completion_tokens: 2, total_tokens: prompt + 2 },
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(response);
  });
  const upstreamUrl = await listen(upstreamServer);

  const config = tempConfig({ upstreamBaseUrl: `${upstreamUrl}/v1` });
  const store = new Store(config);
  store.addUpstreamKey('bad', 'bad-key');
  store.addUpstreamKey('good', 'good-key');
  store.addClientKey('client', 'client-key');
  const pool = new KeyPool(store, 8);
  const ledger = new CacheLedger(store, config.cacheTtlMs);
  const proxy = new ProxyHandler(config, store, pool, ledger);
  const proxyServer = http.createServer((req, res) => proxy.handle(req, res));
  const proxyUrl = await listen(proxyServer);
  t.after(async () => {
    await Promise.all([new Promise((resolve) => proxyServer.close(resolve)), new Promise((resolve) => upstreamServer.close(resolve))]);
    ledger.close(); store.close(); config.cleanup();
  });

  const base = {
    messages: [{ role: 'system', content: '保持简洁' }, { role: 'user', content: '你好' }],
    tools: [{ type: 'function', function: { name: 'ping', parameters: { type: 'object', properties: {} } } }],
  };
  const call = (body) => fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer client-key', 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  const firstResponse = await call({ ...base, model: 'model-a', stream: false });
  const first = await firstResponse.json();
  assert.equal(firstResponse.headers.get('x-proxy-cache'), 'MISS');
  assert.equal(first.usage.prompt_tokens_details.cached_tokens, 0);
  assert.equal(received[0].auth, 'Bearer bad-key');
  assert.equal(received[1].auth, 'Bearer good-key');
  assert.deepEqual(received[1].body.tools, base.tools);
  ledger.flush();

  const secondResponse = await call({ ...base, model: 'model-b', temperature: 1, stream: false });
  const second = await secondResponse.json();
  assert.equal(secondResponse.headers.get('x-proxy-cache'), 'HIT');
  assert.equal(secondResponse.headers.get('x-proxy-cache-type'), 'exact');
  assert.equal(second.usage.prompt_tokens_details.cached_tokens, 120);

  const streamResponse = await call({ ...base, model: 'model-b', stream: true, stream_options: { include_usage: true } });
  const streamText = await streamResponse.text();
  assert.match(streamText, /"cached_tokens":130/);
  assert.match(streamText, /data: \[DONE\]/);
  assert.equal(received.at(-1).body.stream_options.include_usage, true);

  const summary = store.summary(1);
  assert.equal(Number(summary.totals.requests), 3);
  assert.equal(Number(summary.totals.cached_tokens), 250);
  assert.ok(summary.byKeyModel.every((row) => row.key_label === 'good'));
});
