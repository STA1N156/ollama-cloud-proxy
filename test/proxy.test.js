import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { CacheLedger } from '../src/cache.js';
import { KeyPool } from '../src/key-pool.js';
import { ModelSync } from '../src/model-sync.js';
import { injectUsage, ProxyHandler, routingSessionKey } from '../src/proxy.js';
import { Store } from '../src/store.js';
import { UsageLedger } from '../src/usage.js';
import { tempConfig } from '../test-support/helpers.js';

const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
};
const cache = (hit, totalWeight = 1) => async () => ({ hit, fingerprint: { totalWeight } });

test('粘性会话标识优先读取请求头并隔离下游密钥和模型', () => {
  const fromUser = routingSessionKey({}, { user: 'roleplay-1' }, 1, 'model-a');
  assert.equal(fromUser, routingSessionKey({}, { user: 'roleplay-1' }, 1, 'model-a'));
  assert.notEqual(fromUser, routingSessionKey({}, { user: 'roleplay-1' }, 2, 'model-a'));
  assert.notEqual(fromUser, routingSessionKey({}, { user: 'roleplay-1' }, 1, 'model-b'));
  assert.notEqual(fromUser, routingSessionKey({ 'x-proxy-session': 'header-session' }, { user: 'roleplay-1' }, 1, 'model-a'));
  assert.equal(routingSessionKey({}, {}, 1, 'model-a'), '');
});

test('按 New API 标准回报缓存 token 和思考过程', () => {
  const hit = { matched: true, exact: true, weight: 10, observedTokens: 0 };
  const chat = injectUsage(JSON.stringify({
    usage: { prompt_tokens: 80, completion_tokens: 5, total_tokens: 85 },
  }), hit, 10);
  assert.equal(JSON.parse(chat.data).usage.prompt_tokens_details.cached_tokens, 80);

  const responses = injectUsage(JSON.stringify({
    response: { usage: { input_tokens: 90, output_tokens: 6, total_tokens: 96 } },
  }), hit, 10);
  assert.equal(JSON.parse(responses.data).response.usage.input_tokens_details.cached_tokens, 90);

  const reasoning = JSON.parse(injectUsage(JSON.stringify({
    choices: [{ message: { content: '答案', reasoning: '思考过程' } }],
  }), hit, 10).data).choices[0].message;
  assert.equal(reasoning.reasoning, '思考过程');
  assert.equal(reasoning.reasoning_content, '思考过程');
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
      cache({ matched: true, exact: true, weight: 10, observedTokens: 0 }, 10),
      true, true, new AbortController().signal,
      (value) => { progress = value; },
    ),
    /下游已关闭/,
  );
  assert.deepEqual(progress, {
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 100 },
    complete: true,
  });
});

test('Token 减速器与上游同步流式输出并按字数减速', async () => {
  const encoder = new TextEncoder();
  const upstream = {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning":"思考"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    }),
  };
  const writes = [];
  const started = Date.now();
  const proxy = new ProxyHandler({}, null, null, null);
  const result = await proxy.pipeStream(
    upstream, { write(chunk) { writes.push({ chunk, at: Date.now() }); return true; } },
    cache({ matched: false, exact: false, weight: 0, observedTokens: 0 }),
    true, true, new AbortController().signal, null, 20,
  );
  const finishedAt = Date.now();
  assert.equal(result.usage.completionTokens, 2);
  const output = writes.map((item) => item.chunk).join('');
  assert.match(output, /"reasoning":"思考"/);
  assert.match(output, /"reasoning_content":"思考"/);
  assert.match(output, /\[DONE\]/);
  assert.ok(writes[0].at - started < 50);
  assert.ok(finishedAt - started >= 80);
});

test('Token 减速器为 0 时直接透传流式输出', async () => {
  const encoder = new TextEncoder();
  const upstream = {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"${'字'.repeat(200)}"}}]}\n\ndata: [DONE]\n\n`));
        controller.close();
      },
    }),
  };
  const writes = [];
  const started = Date.now();
  const proxy = new ProxyHandler({}, null, null, null);
  await proxy.pipeStream(
    upstream, { write(chunk) { writes.push(chunk); return true; } },
    cache({ matched: false, exact: false, weight: 0, observedTokens: 0 }),
    true, true, new AbortController().signal, null, 0,
  );
  assert.match(writes.join(''), /\[DONE\]/);
  assert.ok(Date.now() - started < 100);
});

test('零限速正文不等待缓存线程，最终 usage 仍注入命中 token', async () => {
  const encoder = new TextEncoder();
  let upstreamController;
  const upstream = {
    body: new ReadableStream({
      start(controller) {
        upstreamController = controller;
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"先显示"}}]}\n\n'));
      },
    }),
  };
  let contentWritten;
  const firstWrite = new Promise((resolve) => { contentWritten = resolve; });
  let releaseCache;
  const cacheReady = new Promise((resolve) => { releaseCache = resolve; });
  let cacheRequested = false;
  const writes = [];
  const proxy = new ProxyHandler({}, null, null, null);
  const streaming = proxy.pipeStream(
    upstream,
    { write(chunk) { writes.push(chunk); contentWritten(); return true; } },
    async () => {
      cacheRequested = true;
      await cacheReady;
      return { hit: { matched: true, exact: true, weight: 10, observedTokens: 0 }, fingerprint: { totalWeight: 10 } };
    },
    true, true, new AbortController().signal, null, 0,
  );

  await firstWrite;
  assert.equal(cacheRequested, false);
  assert.equal(writes.join(''), 'data: {"choices":[{"delta":{"content":"先显示"}}]}\n\n');
  upstreamController.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":2,"total_tokens":52}}\n\ndata: [DONE]\n\n'));
  upstreamController.close();
  while (!cacheRequested) await new Promise((resolve) => setImmediate(resolve));
  releaseCache();
  const result = await streaming;
  assert.equal(result.usage.cachedTokens, 50);
  assert.match(writes.join(''), /"cached_tokens":50/);
});

test('白名单并发模式超额时立即返回指定503，完成后释放名额', async (t) => {
  let received = 0;
  const upstreamServer = http.createServer(async (req, res) => {
    for await (const _ of req) { /* 读取请求体 */ }
    received += 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const body = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  const upstreamUrl = await listen(upstreamServer);
  const config = tempConfig({ upstreamBaseUrl: `${upstreamUrl}/v1` });
  const store = new Store(config);
  store.addUpstreamKey('upstream', 'upstream-key');
  const clientId = store.addClientKey('limited', 'limited-key', 0, 'limit:5');
  const usage = new UsageLedger(store);
  const pool = new KeyPool(store, (event) => usage.reportHealth(event));
  const ledger = new CacheLedger(store, config.cacheTtlMs);
  const proxy = new ProxyHandler(config, store, pool, ledger, usage);
  const proxyServer = http.createServer((req, res) => proxy.handle(req, res));
  const proxyUrl = await listen(proxyServer);
  t.after(async () => {
    await Promise.all([new Promise((resolve) => proxyServer.close(resolve)), new Promise((resolve) => upstreamServer.close(resolve))]);
    await Promise.all([ledger.close(), usage.close()]); store.close(); config.cleanup();
  });

  const call = (origin = 'https://sta1n156.github.io') => fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer limited-key', origin, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const active = Array.from({ length: 5 }, () => call());
  while (received < 5) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(proxy.clientConcurrency(clientId), 5);

  const rejected = await call();
  assert.equal(rejected.status, 503);
  assert.equal((await rejected.json()).error.message, '当前公益模型负载较高，暂时超出配额，请切换模型或稍后重试');
  assert.equal((await call('https://example.com')).status, 403);
  assert.ok((await Promise.all(active)).every((response) => response.status === 200));
  assert.equal(proxy.clientConcurrency(clientId), 0);
  assert.equal((await call()).status, 200);
});

test('未限制并发的下游密钥仍统计实时并发', () => {
  const proxy = new ProxyHandler({}, null, null, null);
  const release = proxy.acquireClientSlot({ id: 7, concurrencyLimit: 0 });
  assert.equal(proxy.clientConcurrency(7), 1);
  assert.deepEqual(proxy.clientConcurrencySnapshot(), { 7: 1 });
  release();
  assert.equal(proxy.clientConcurrency(7), 0);
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
  store.addClientKey('slow', 'slow-key', 20);
  store.addClientKey('site', 'site-key', 0, 'https://sta1n156.github.io');
  store.addClientKey('router', 'router-key', 0, 'codex-router');
  const usage = new UsageLedger(store);
  const pool = new KeyPool(store, (event) => usage.reportHealth(event));
  const ledger = new CacheLedger(store, config.cacheTtlMs);
  const proxy = new ProxyHandler(config, store, pool, ledger, usage);
  const proxyServer = http.createServer((req, res) => proxy.handle(req, res));
  const proxyUrl = await listen(proxyServer);
  t.after(async () => {
    await Promise.all([new Promise((resolve) => proxyServer.close(resolve)), new Promise((resolve) => upstreamServer.close(resolve))]);
    await Promise.all([ledger.close(), usage.close()]); store.close(); config.cleanup();
  });

  const preflight = await fetch(`${proxyUrl}/v1/models`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://sta1n156.github.io',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://sta1n156.github.io');

  const siteHeaders = { authorization: 'Bearer site-key' };
  for (const origin of ['https://sta1n156.github.io', 'https://api.sta1n.site', 'https://cdn.sta1n.cn']) {
    const response = await fetch(`${proxyUrl}/v1/models`, { headers: { ...siteHeaders, origin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
  }
  const blockedSite = await fetch(`${proxyUrl}/v1/models`, { headers: siteHeaders });
  assert.equal(blockedSite.status, 403);
  assert.equal((await blockedSite.json()).error.message, '公益模型仅限在RP-Hub官方源站使用，如您再次尝试不合规请求，账号将遭到封禁，请切换付费分组或转至官方源站使用');
  assert.equal((await fetch(`${proxyUrl}/v1/models`, { headers: { ...siteHeaders, origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(`${proxyUrl}/v1/models`, { headers: { ...siteHeaders, 'user-agent': 'codex-router/1.0.0' } })).status, 200);

  const routerHeaders = { authorization: 'Bearer router-key' };
  for (const agent of ['codex-router/1.0.0', 'codex-router/xxxxx']) {
    const response = await fetch(`${proxyUrl}/v1/models`, { headers: { ...routerHeaders, 'user-agent': agent } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  }
  assert.equal((await fetch(`${proxyUrl}/v1/models`, { headers: { ...routerHeaders, origin: 'https://sta1n156.github.io' } })).status, 200);
  const blockedRouter = await fetch(`${proxyUrl}/v1/models`, { headers: routerHeaders });
  assert.equal(blockedRouter.status, 403);
  assert.equal((await blockedRouter.json()).error.message, '公益模型仅限在RP-Hub官方源站使用，如您再次尝试不合规请求，账号将遭到封禁，请切换付费分组或转至官方源站使用');
  assert.equal((await fetch(`${proxyUrl}/v1/models`, { headers: { ...routerHeaders, 'user-agent': 'codex-router/' } })).status, 403);

  const base = {
    messages: [{ role: 'system', content: '保持简洁' }, { role: 'user', content: '你好' }],
    tools: [{ type: 'function', function: { name: 'ping', parameters: { type: 'object', properties: {} } } }],
  };
  const call = (body, token = 'client-key') => fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  const firstResponse = await call({ ...base, model: 'model-a', stream: false });
  const first = await firstResponse.json();
  assert.equal(firstResponse.headers.get('x-proxy-cache'), 'MISS');
  assert.equal(first.usage.prompt_tokens_details.cached_tokens, 0);
  assert.equal(received[0].auth, 'Bearer bad-key');
  assert.equal(received[1].auth, 'Bearer good-key');
  assert.deepEqual(received[1].body.tools, base.tools);
  await ledger.flush();

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

  let groups;
  for (let index = 0; index < 20; index += 1) {
    groups = await usage.groups(1);
    if (groups.byKeyModel.reduce((sum, row) => sum + Number(row.requests), 0) === 4) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(groups.byKeyModel.reduce((sum, row) => sum + Number(row.requests), 0), 4);
  assert.equal(groups.byKeyModel.reduce((sum, row) => sum + Number(row.cached_tokens), 0), 390);
  assert.ok(groups.byKeyModel.every((row) => row.key_label === 'good'));
  assert.equal(Number(store.listClientKeys().find((key) => key.label === 'client').cached_tokens), 390);

  const slowStarted = Date.now();
  const slowResponse = await call({ ...base, model: 'model-b', stream: false }, 'slow-key');
  await slowResponse.json();
  assert.ok(Date.now() - slowStarted >= 80);
});

test('外部 OpenAI API 可选择透传或使用代理缓存，错误透明并支持减速', async (t) => {
  const ollamaServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ models: [{ name: 'ollama-model' }] }));
  });
  const ollamaOrigin = await listen(ollamaServer);
  const calls = [];
  const externalServer = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'external-model', object: 'model', owned_by: 'external' }] }));
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    calls.push(body);
    if (body.messages[0].content === 'fail') {
      res.writeHead(500, { 'content-type': 'application/json', 'x-upstream-error': 'kept' });
      return res.end('{"error":{"message":"external failure"}}');
    }
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"choices":[{"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":3}}}');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":3}}}\n\ndata: [DONE]\n\n');
  });
  const externalOrigin = await listen(externalServer);
  const config = tempConfig({
    upstreamBaseUrl: `${ollamaOrigin}/v1`,
    modelSyncUrl: `${ollamaOrigin}/api/tags`,
  });
  const store = new Store(config);
  store.addUpstreamKey('Ollama', 'ollama-key', config.upstreamBaseUrl);
  const externalKeyId = store.addUpstreamKey('External', 'external-key', `${externalOrigin}/v1`);
  store.addClientKey('Slow client', 'slow-client', 20);
  const usage = new UsageLedger(store);
  const pool = new KeyPool(store, (event) => usage.reportHealth(event));
  const modelSync = new ModelSync(config, store, pool);
  assert.equal(await modelSync.sync(), 2);
  assert.deepEqual(store.listModels().map((item) => [item.source_label, item.name]).sort(), [
    ['External', 'external-model'], ['Ollama', 'ollama-model'],
  ]);
  const ledger = new CacheLedger(store, config.cacheTtlMs);
  const proxy = new ProxyHandler(config, store, pool, ledger, usage);
  const proxyServer = http.createServer((req, res) => proxy.handle(req, res));
  const proxyUrl = await listen(proxyServer);
  t.after(async () => {
    proxyServer.close(); externalServer.close(); ollamaServer.close();
    modelSync.stop(); await Promise.all([ledger.close(), usage.close()]); store.close(); config.cleanup();
  });

  const modelsResponse = await fetch(`${proxyUrl}/v1/models`, { headers: { authorization: 'Bearer slow-client' } });
  assert.deepEqual((await modelsResponse.json()).data.map((item) => item.id).sort(), ['external-model', 'ollama-model']);

  const request = (content, stream = content !== 'fail') => fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer slow-client', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'external-model', messages: [{ role: 'user', content }], stream, stream_options: { include_usage: true } }),
  });
  const failed = await request('fail');
  assert.equal(failed.status, 500);
  assert.equal(failed.headers.get('x-upstream-error'), 'kept');
  assert.equal(failed.headers.get('x-proxy-cache'), 'BYPASS');
  assert.deepEqual(await failed.json(), { error: { message: 'external failure' } });
  assert.equal(calls.filter((item) => item.messages[0].content === 'fail').length, 1);

  const started = Date.now();
  const streamed = await request('ok');
  const output = await streamed.text();
  assert.ok(Date.now() - started >= 80);
  assert.match(output, /"cached_tokens":3/);
  assert.equal(streamed.headers.get('x-proxy-cache-source'), 'upstream');
  assert.equal((await ledger.stats()).entries, 0);

  store.setUpstreamProxyCache(externalKeyId, true);
  pool.reload();
  const missResponse = await request('proxy-cache', false);
  const miss = await missResponse.json();
  assert.equal(miss.usage.prompt_tokens_details.cached_tokens, 0);
  assert.equal(missResponse.headers.get('x-proxy-cache-source'), 'proxy-simulated');
  for (let index = 0; index < 20 && (await ledger.stats()).entries === 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const hitResponse = await request('proxy-cache', true);
  const hit = await hitResponse.text();
  assert.match(hit, /"cached_tokens":10/);
  assert.doesNotMatch(hit, /"cached_tokens":3/);
  assert.equal(hitResponse.headers.get('x-proxy-cache-source'), 'proxy-simulated');
});

test('Ollama 429 最多轮换10个不同密钥并进入冷却', async (t) => {
  const calls = [];
  const upstreamServer = http.createServer((req, res) => {
    calls.push(req.headers.authorization);
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
    res.end('{"error":{"message":"rate limited"}}');
  });
  const upstreamUrl = await listen(upstreamServer);
  const config = tempConfig({ upstreamBaseUrl: `${upstreamUrl}/v1`, retryCount: 10 });
  const store = new Store(config);
  store.setErrorMessages({ api_unavailable: '自定义暂时不可用' });
  for (let index = 1; index <= 11; index += 1) store.addUpstreamKey(`Key ${index}`, `key-${index}`);
  store.addClientKey('client', 'client-key');
  const usage = new UsageLedger(store);
  const pool = new KeyPool(store, (event) => usage.reportHealth(event));
  const ledger = new CacheLedger(store, config.cacheTtlMs);
  const proxy = new ProxyHandler(config, store, pool, ledger, usage);
  const proxyServer = http.createServer((req, res) => proxy.handle(req, res));
  const proxyUrl = await listen(proxyServer);
  t.after(async () => {
    await Promise.all([new Promise((resolve) => proxyServer.close(resolve)), new Promise((resolve) => upstreamServer.close(resolve))]);
    await Promise.all([ledger.close(), usage.close()]); store.close(); config.cleanup();
  });

  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'x' }] }),
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.message, '自定义暂时不可用');
  assert.equal(calls.length, 10);
  assert.equal(new Set(calls).size, 10);
  assert.equal(pool.snapshot().filter((key) => key.status === 'cooldown').length, 10);
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
  const usage = new UsageLedger(store);
  const pool = new KeyPool(store, (event) => usage.reportHealth(event));
  const ledger = new CacheLedger(store, config.cacheTtlMs);
  const proxy = new ProxyHandler(config, store, pool, ledger, usage);
  const proxyServer = http.createServer((req, res) => proxy.handle(req, res));
  const proxyUrl = await listen(proxyServer);
  t.after(async () => {
    await Promise.all([new Promise((resolve) => proxyServer.close(resolve)), new Promise((resolve) => upstreamServer.close(resolve))]);
    await Promise.all([ledger.close(), usage.close()]); store.close(); config.cleanup();
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
