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

test('下游收到最终 usage 后立刻断开仍保留统计和完成状态', async () => {
  const encoder = new TextEncoder();
  const upstream = {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}\n\n'));
        controller.close();
      },
    }),
  };
  const proxy = new ProxyHandler({}, null, null, null);
  let progress;
  await assert.rejects(
    proxy.pipeStream(
      upstream,
      { write() { throw new Error('下游已关闭'); } },
      { matched: true, exact: true, weight: 10, observedTokens: 0 },
      10, true, true, new AbortController().signal,
      (value) => { progress = value; },
    ),
    /下游已关闭/,
  );
  assert.deepEqual(progress, {
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 100 },
    complete: true,
  });
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
    const prompt = body.metadata?.disconnect_after_usage ? 140 : body.model === 'model-a' ? 100 : body.stream ? 130 : 120;
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"}}],"usage":null}\n\n');
      res.write(`data: {"id":"x","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":${prompt},"completion_tokens":2,"total_tokens":${prompt + 2}}}\n\n`);
      if (body.metadata?.disconnect_after_usage) {
        setTimeout(() => res.end('data: [DONE]\n\n'), 100);
        return;
      }
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

  await new Promise((resolve, reject) => {
    const request = http.request(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer client-key', 'content-type': 'application/json' },
    }, (response) => {
      response.on('data', (chunk) => {
        if (chunk.includes('"usage"')) {
          response.destroy();
          resolve();
        }
      });
    });
    request.on('error', reject);
    request.end(JSON.stringify({
      ...base, model: 'model-b', stream: true,
      stream_options: { include_usage: true },
      metadata: { disconnect_after_usage: true },
    }));
  });

  let summary;
  for (let index = 0; index < 20; index += 1) {
    summary = store.summary(1);
    if (Number(summary.totals.requests) === 4) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(Number(summary.totals.requests), 4);
  assert.equal(Number(summary.totals.cached_tokens), 390);
  assert.equal(Number(summary.recent[0].prompt_tokens), 140);
  assert.equal(Number(summary.recent[0].cached_tokens), 140);
  assert.ok(summary.byKeyModel.every((row) => row.key_label === 'good'));
});

test('只对 Internal Server Error 的 HTTP 400 重试两次', async (t) => {
  const counts = new Map();
  const upstreamServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const count = (counts.get(body.model) || 0) + 1;
    counts.set(body.model, count);
    res.setHeader('content-type', 'application/json');
    if (body.model === 'internal-then-ok' && count <= 2) {
      res.statusCode = 400;
      return res.end('{"error":{"message":"Internal Server Error"}}');
    }
    if (body.model === 'internal-always') {
      res.statusCode = 400;
      return res.end(`{"error":{"message":"Internal Server Error","attempt":${count}}}`);
    }
    if (body.model === 'bad-request') {
      res.statusCode = 400;
      return res.end('{"error":{"message":"messages 参数格式错误"}}');
    }
    res.end('{"choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}');
  });
  const upstreamUrl = await listen(upstreamServer);
  const config = tempConfig({ upstreamBaseUrl: `${upstreamUrl}/v1` });
  const store = new Store(config);
  store.addUpstreamKey('A', 'key-a');
  store.addUpstreamKey('B', 'key-b');
  store.addUpstreamKey('C', 'key-c');
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

  const call = (model) => fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'x' }] }),
  });

  const recovered = await call('internal-then-ok');
  assert.equal(recovered.status, 200);
  assert.equal(counts.get('internal-then-ok'), 3);

  const badRequest = await call('bad-request');
  assert.equal(badRequest.status, 400);
  assert.equal(counts.get('bad-request'), 1);
  assert.match(await badRequest.text(), /messages 参数格式错误/);

  const exhausted = await call('internal-always');
  assert.equal(exhausted.status, 400);
  assert.equal(counts.get('internal-always'), 3);
  assert.match(await exhausted.text(), /"attempt":3/);
});
